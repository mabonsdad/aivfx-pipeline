from __future__ import annotations

import json
import math
import re
import tempfile
from io import BytesIO
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import boto3
from aws_lambda_powertools import Logger, Tracer
from botocore.exceptions import ClientError
from pydantic import ValidationError

from PIL import Image

from src.core.assets import AssetPaths, AssetStore
from src.core.auth import UnauthorizedError, get_user_claims, get_user_id
from src.core.config import load_settings
from src.core.ffmpeg import extract_frame_png
from src.core.http import error_response, parse_json_body, response
from src.core.ids import deterministic_frame_id, new_id, prompt_hash
from src.core.store import S3JsonStore, now_iso
from src.jobs.queue import JobQueue
from src.models.schemas import (
    AssetDeleteRequest,
    CustomReportCreateRequest,
    FrameCaptureRequest,
    FullEditRequest,
    MergeRequest,
    QualityMatchAnalyseRequest,
    QualityMatchApplyRequest,
    QualityMatchMaskUploadRequest,
    QcRunRequest,
    PatchInitRequest,
    PatchSubmitRequest,
    ReferenceUploadRequest,
    SegmentCreateRequest,
    SegmentGenerateRequest,
    SegmentPatchRequest,
    TaskCreateRequest,
    UploadVideoRequest,
)
from src.quality_match.service import QualityMatchSettings, apply_quality_match, analyse_quality_match

logger = Logger()
tracer = Tracer()
settings = load_settings()
VIDEO_MODEL_MAX_SECONDS: dict[str, int] = {
    "ray-2": 10,
    "ray-flash-2": 15,
    "runway-gen4.5": 10,
    "kling-2.6": 10,
    "veo-3.1": 8,
    "veo-3.1-fast": 8,
    "wan2.2-a14b": 5,
    "wan2.2-animate": 10,
}
PRESIGNED_GET_TTL_SECONDS = 3600
STALE_GENERATION_MAX_AGE_SECONDS = 30 * 60


def _normalize_task_name(raw: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw.strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_-")
    if not cleaned:
        cleaned = "task"
    return cleaned[:15]


def _unique_task_name(base: str, existing_names: set[str]) -> str:
    candidate = base[:15]
    if candidate not in existing_names:
        return candidate
    i = 2
    while True:
        suffix = str(i)
        prefix = candidate[: max(1, 15 - len(suffix))]
        next_candidate = f"{prefix}{suffix}"
        if next_candidate not in existing_names:
            return next_candidate
        i += 1


def _build_file_prefix(task_name: str, task_id: str, existing_prefixes: set[str]) -> str:
    date_part = datetime.now(timezone.utc).strftime("%y%m%d")
    name_alnum = re.sub(r"[^a-zA-Z0-9]+", "", task_name.lower())
    seed = f"{name_alnum}{re.sub(r'[^a-zA-Z0-9]+', '', task_id.lower())}zzzzz"
    base_root = (seed[:5]).ljust(5, "x")
    candidate = f"{base_root}-{date_part}-"
    if candidate not in existing_prefixes:
        return candidate
    for idx in range(5, len(seed)):
        root = (seed[idx - 4 : idx + 1]).ljust(5, "x")
        candidate = f"{root}-{date_part}-"
        if candidate not in existing_prefixes:
            return candidate
    fallback = re.sub(r"[^a-zA-Z0-9]+", "", task_id.lower())[:5].ljust(5, "x")
    return f"{fallback}-{date_part}-"


def _asset_paths_for_task(task: dict[str, Any]) -> AssetPaths:
    return AssetPaths(user_id=task["userId"], task_id=task["taskId"], file_prefix=task.get("filePrefix", ""))


def _origin(event: dict[str, Any]) -> str | None:
    header_origin = (
        event.get("headers", {}).get("origin")
        or event.get("headers", {}).get("Origin")
    )
    if header_origin and header_origin in settings.cors_allowed_origins:
        return header_origin
    return settings.cors_allowed_origins[0] if settings.cors_allowed_origins else None


def _method_path(event: dict[str, Any]) -> tuple[str, str]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")
    return method.upper(), path


def _json_model(model_cls, event: dict[str, Any]):
    return model_cls.model_validate(parse_json_body(event))


def _task_summary(task: dict[str, Any]) -> dict[str, Any]:
    status = task["status"]
    if status == "error" and task.get("video", {}).get("editSource", {}).get("s3Key"):
        status = "ready"
    return {
        "taskId": task["taskId"],
        "name": task["name"],
        "status": status,
        "createdAt": task["createdAt"],
        "updatedAt": task["updatedAt"],
        "video": task.get("video", {}),
    }


def _fps(task: dict[str, Any]) -> Fraction:
    fps_info = task["video"]["editSource"]["fps"]
    return Fraction(int(fps_info["num"]), int(fps_info["den"]))


def _timecode(frame_idx: int, fps: Fraction) -> str:
    whole = int(frame_idx / float(fps))
    hh = whole // 3600
    mm = (whole % 3600) // 60
    ss = whole % 60
    ff = int(frame_idx % max(1, int(round(float(fps)))))
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def _queue_job(
    *,
    store: S3JsonStore,
    queue: JobQueue,
    user_id: str,
    task_id: str,
    job_type: str,
    payload: dict[str, Any],
) -> str:
    job_id = new_id("job")
    job = {
        "jobId": job_id,
        "userId": user_id,
        "taskId": task_id,
        "type": job_type,
        "status": "queued",
        "progress": 0,
        "payload": payload,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    store.save_job(job)
    queue.enqueue({"jobId": job_id, "taskId": task_id, "userId": user_id})
    return job_id


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _prune_stale_segment_generations(task: dict[str, Any], store: S3JsonStore) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    now_dt = datetime.now(timezone.utc)
    remove_ids: set[str] = set()
    user_id = str(task.get("userId") or "")
    for gen_id, generation in generations.items():
        if not isinstance(generation, dict):
            remove_ids.add(gen_id)
            continue
        status = str(generation.get("status") or "").lower()
        output_key = generation.get("outputKey")
        if status == "failed":
            remove_ids.add(gen_id)
            continue
        if status not in {"queued", "running"}:
            continue
        if output_key:
            continue
        job_id = generation.get("jobId")
        if isinstance(job_id, str) and job_id:
            job = store.load_job(user_id, job_id)
            if not job:
                remove_ids.add(gen_id)
                continue
            job_status = str(job.get("status") or "").lower()
            if job_status in {"failed", "complete"}:
                remove_ids.add(gen_id)
                continue
        created_at = _parse_iso_datetime(generation.get("createdAt"))
        if created_at and (now_dt - created_at).total_seconds() > STALE_GENERATION_MAX_AGE_SECONDS:
            remove_ids.add(gen_id)

    if not remove_ids:
        return False
    for gen_id in remove_ids:
        generations.pop(gen_id, None)
    for segment in task.get("segments", []):
        if segment.get("selectedGenerationId") in remove_ids:
            segment["selectedGenerationId"] = None
    task.setdefault("history", []).append(
        {
            "at": now_iso(),
            "event": "task.segment_generations.pruned",
            "removedGenerationIds": sorted(remove_ids),
        }
    )
    return True


def _normalize_custom_report_refs(task: dict[str, Any], raw_refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    frames = task.get("frames", {})
    generations = task.get("segmentGenerations", {})
    for ref in raw_refs:
        if not isinstance(ref, dict):
            continue
        asset_type = str(ref.get("assetType") or "")
        normalized_ref: dict[str, Any] | None = None
        if asset_type == "frame_variant":
            frame_id = str(ref.get("frameId") or "")
            variant_id = str(ref.get("variantId") or "")
            frame = frames.get(frame_id) if isinstance(frames, dict) else None
            variant = (
                next((item for item in frame.get("variants", []) if item.get("variantId") == variant_id), None)
                if isinstance(frame, dict)
                else None
            )
            if variant:
                normalized_ref = {"assetType": "frame_variant", "frameId": frame_id, "variantId": variant_id}
        elif asset_type == "segment_generation":
            gen_id = str(ref.get("genId") or "")
            generation = generations.get(gen_id) if isinstance(generations, dict) else None
            if isinstance(generation, dict):
                normalized_ref = {"assetType": "segment_generation", "genId": gen_id}
        if not normalized_ref:
            continue
        ref_key = json.dumps(normalized_ref, sort_keys=True)
        if ref_key in seen:
            continue
        seen.add(ref_key)
        normalized.append(normalized_ref)
    return normalized


def _cleanup_custom_reports(task: dict[str, Any]) -> bool:
    reports = task.get("customReports")
    if not isinstance(reports, list):
        task["customReports"] = []
        return True
    changed = False
    cleaned_reports: list[dict[str, Any]] = []
    for report in reports:
        if not isinstance(report, dict):
            changed = True
            continue
        report_id = str(report.get("reportId") or "").strip()
        report_type = str(report.get("reportType") or "").strip()
        if not report_id or report_type not in {"qc_frame", "qc_video"}:
            changed = True
            continue
        output_refs = _normalize_custom_report_refs(task, list(report.get("outputRefs") or []))
        if not output_refs:
            changed = True
            continue
        created_at = str(report.get("createdAt") or now_iso())
        updated_at = str(report.get("updatedAt") or created_at)
        name = str(report.get("name") or "").strip() or f"{'QC Frame' if report_type == 'qc_frame' else 'QC Video'} Report"
        cleaned = {
            "reportId": report_id,
            "reportType": report_type,
            "name": name[:80],
            "outputRefs": output_refs,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }
        if cleaned != report:
            changed = True
        cleaned_reports.append(cleaned)
    if cleaned_reports != reports:
        task["customReports"] = cleaned_reports
        changed = True
    return changed


def _load_task_or_404(store: S3JsonStore, user_id: str, task_id: str) -> dict[str, Any]:
    task = store.load_task(user_id, task_id)
    if not task or task.get("deletedAt"):
        raise KeyError("Task not found")
    return task


def _capture_frame_sync(
    *,
    task: dict[str, Any],
    frame_index: int,
    asset_store: AssetStore,
) -> dict[str, Any]:
    edit_source_key = task["video"].get("editSource", {}).get("s3Key")
    if not edit_source_key:
        raise ValueError("Edit source not ready")

    frame_id = deterministic_frame_id(task["taskId"], edit_source_key, frame_index)
    frames = task.setdefault("frames", {})
    if frame_id in frames:
        frame = frames[frame_id]
        return {
            "frameId": frame_id,
            "imageUrl": asset_store.presign_get(frame["captureKey"], expires=PRESIGNED_GET_TTL_SECONDS),
            "timecode": frame["timecode"],
            "frameIndex": frame["frameIndex"],
        }

    s3 = boto3.client("s3")
    paths = _asset_paths_for_task(task)

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        local_video = td_path / "edit.mp4"
        local_frame = td_path / "frame.png"
        s3.download_file(settings.assets_bucket, edit_source_key, str(local_video))
        extract_frame_png(str(local_video), frame_index, str(local_frame))
        key = paths.frame_capture(frame_id)
        s3.upload_file(
            str(local_frame),
            settings.assets_bucket,
            key,
            ExtraArgs={"ContentType": "image/png", "ServerSideEncryption": "AES256"},
        )

    fps = _fps(task)
    timecode = _timecode(frame_index, fps)
    frames[frame_id] = {
        "frameId": frame_id,
        "frameIndex": frame_index,
        "timecode": timecode,
        "createdAt": now_iso(),
        "captureKey": key,
        "variants": [],
        "selectedVariantId": None,
    }

    return {
        "frameId": frame_id,
        "imageUrl": asset_store.presign_get(key, expires=PRESIGNED_GET_TTL_SECONDS),
        "timecode": timecode,
        "frameIndex": frame_index,
    }


def _resolve_segment_frames(task: dict[str, Any], start_frame_index: int, duration_seconds: int) -> tuple[int, int, int]:
    fps = _fps(task)
    duration_frames = int(round(float(fps) * duration_seconds))
    end_exclusive = start_frame_index + duration_frames
    frame_count = int(task["video"]["editSource"].get("frameCount", 0))
    if end_exclusive > frame_count:
        raise ValueError("Segment exceeds video length")
    return start_frame_index, end_exclusive, duration_frames


def _extract_query(event: dict[str, Any]) -> dict[str, str]:
    raw = event.get("rawQueryString") or ""
    parsed = parse_qs(raw)
    return {k: v[-1] for k, v in parsed.items() if v}


def _sanitize_prompt(prompt: str) -> str:
    if len(prompt) > settings.max_prompt_chars:
        raise ValueError(f"Prompt exceeds max length ({settings.max_prompt_chars})")
    return prompt


def _audit_prompt(prompt: str) -> dict[str, Any]:
    return {
        "promptHash": prompt_hash(prompt),
        "promptLength": len(prompt),
    }


def _decorate_embedded_s3_keys(obj: Any, asset_store: AssetStore) -> None:
    if isinstance(obj, dict):
        for key, value in list(obj.items()):
            if isinstance(value, (dict, list)):
                _decorate_embedded_s3_keys(value, asset_store)
            if key.endswith("Key") and isinstance(value, str) and value:
                try:
                    obj[f"{key[:-3]}Url"] = asset_store.presign_get(value, expires=PRESIGNED_GET_TTL_SECONDS)
                except Exception:
                    logger.warning("Failed to presign embedded key", extra={"key": value})
    elif isinstance(obj, list):
        for item in obj:
            _decorate_embedded_s3_keys(item, asset_store)


def _segment_duration_seconds(task: dict[str, Any], segment: dict[str, Any]) -> float:
    fps = _fps(task)
    return (segment["endFrameExclusive"] - segment["startFrame"]) / float(fps)


def _validated_reference_key(task: dict[str, Any], reference_key: str | None) -> str | None:
    if not reference_key:
        return None
    if not isinstance(reference_key, str):
        raise ValueError("Invalid reference image key")
    allowed_prefix = f"{_asset_paths_for_task(task).task_prefix()}/frames/"
    if not reference_key.startswith(allowed_prefix) or "/references/" not in reference_key:
        raise ValueError("Reference image key is outside task frame references")
    return reference_key


def _resolve_frame_source(frame: dict[str, Any], preferred_variant_id: str | None) -> tuple[str, str | None]:
    if preferred_variant_id and preferred_variant_id != "original":
        variant = next((item for item in frame.get("variants", []) if item.get("variantId") == preferred_variant_id), None)
        if not variant or not variant.get("outputKey"):
            raise ValueError("Source variant not found")
        return str(variant["outputKey"]), str(preferred_variant_id)
    return str(frame["captureKey"]), None


def _route(event: dict[str, Any]) -> dict[str, Any]:
    method, path = _method_path(event)
    origin = _origin(event)

    if method == "OPTIONS":
        return {
            "statusCode": 204,
            "headers": {
                "access-control-allow-origin": origin or "*",
                "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
                "access-control-allow-headers": "authorization,content-type",
                "access-control-allow-credentials": "true",
            },
            "body": "",
        }

    if method == "GET" and path == "/health":
        return response(200, {"ok": True, "service": "aivfx-backend"}, origin=origin)

    try:
        user_id = get_user_id(event)
        claims = get_user_claims(event)
    except UnauthorizedError as exc:
        return error_response(401, str(exc), origin=origin)

    store = S3JsonStore(settings.metadata_bucket)
    asset_store = AssetStore(settings.assets_bucket, settings.aws_region)
    queue = JobQueue(settings.jobs_queue_url)

    request_id = event.get("requestContext", {}).get("requestId")
    logger.append_keys(requestId=request_id, userId=user_id)

    if method == "GET" and path == "/me":
        return response(
            200,
            {
                "userId": user_id,
                "email": claims.get("email"),
                "username": claims.get("cognito:username"),
            },
            origin=origin,
        )

    if method == "POST" and path == "/tasks":
        req = _json_model(TaskCreateRequest, event)
        existing_tasks = store.list_tasks(user_id)
        existing_names = {str(item.get("name", "")).lower() for item in existing_tasks}
        task_id = new_id("task")
        normalized_name = _normalize_task_name(req.name)
        unique_name = _unique_task_name(normalized_name, existing_names)
        existing_prefixes = {str(item.get("filePrefix", "")) for item in existing_tasks if item.get("filePrefix")}
        file_prefix = _build_file_prefix(unique_name, task_id, existing_prefixes)
        now = now_iso()
        task = {
            "taskId": task_id,
            "userId": user_id,
            "name": unique_name,
            "filePrefix": file_prefix,
            "createdAt": now,
            "updatedAt": now,
            "status": "created",
            "video": {},
            "segments": [],
            "frames": {},
            "segmentGenerations": {},
            "qualityMatchAnalyses": {},
            "exports": [],
            "customReports": [],
            "history": [],
            "metaVersion": 0,
        }
        store.save_task(task)
        return response(201, {"taskId": task_id}, origin=origin)

    if method == "GET" and path == "/tasks":
        task_items = store.list_tasks(user_id)
        for item in task_items:
            changed = _prune_stale_segment_generations(item, store)
            changed = _cleanup_custom_reports(item) or changed
            if changed:
                store.save_task(item)
        tasks = [_task_summary(item) for item in task_items]
        return response(200, {"tasks": tasks}, origin=origin)

    if method == "DELETE" and path.startswith("/tasks/") and path.count("/") == 2:
        task_id = path.split("/")[2]
        try:
            task = _load_task_or_404(store, user_id, task_id)
        except KeyError:
            return error_response(404, "Task not found", origin=origin)
        task["deletedAt"] = now_iso()
        task["status"] = "error"
        store.save_task(task)
        return response(200, {"ok": True}, origin=origin)

    if method == "GET" and path.startswith("/tasks/") and path.count("/") == 2:
        task_id = path.split("/")[2]
        try:
            task = _load_task_or_404(store, user_id, task_id)
        except KeyError:
            return error_response(404, "Task not found", origin=origin)
        changed = _prune_stale_segment_generations(task, store)
        changed = _cleanup_custom_reports(task) or changed
        if changed:
            store.save_task(task)

        decorated = json.loads(json.dumps(task))
        if decorated.get("status") == "error" and decorated.get("video", {}).get("editSource", {}).get("s3Key"):
            decorated["status"] = "ready"
        if decorated.get("video", {}).get("original", {}).get("s3Key"):
            decorated["video"]["original"]["downloadUrl"] = asset_store.presign_get(
                decorated["video"]["original"]["s3Key"], expires=PRESIGNED_GET_TTL_SECONDS
            )
        if decorated.get("video", {}).get("editSource", {}).get("s3Key"):
            decorated["video"]["editSource"]["downloadUrl"] = asset_store.presign_get(
                decorated["video"]["editSource"]["s3Key"], expires=PRESIGNED_GET_TTL_SECONDS
            )
        if decorated.get("video", {}).get("previewSource", {}).get("s3Key"):
            decorated["video"]["previewSource"]["downloadUrl"] = asset_store.presign_get(
                decorated["video"]["previewSource"]["s3Key"], expires=PRESIGNED_GET_TTL_SECONDS
            )
        for _, frame in decorated.get("frames", {}).items():
            frame["imageUrl"] = asset_store.presign_get(frame["captureKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            for variant in frame.get("variants", []):
                variant["imageUrl"] = asset_store.presign_get(variant["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS)
                patch_meta = variant.get("patchMeta")
                if isinstance(patch_meta, dict):
                    patch_only_key = patch_meta.get("patchOnlyKey")
                    if patch_only_key:
                        patch_meta["patchOnlyUrl"] = asset_store.presign_get(patch_only_key, expires=PRESIGNED_GET_TTL_SECONDS)
                    mask_key = patch_meta.get("maskKey")
                    if mask_key:
                        patch_meta["maskUrl"] = asset_store.presign_get(mask_key, expires=PRESIGNED_GET_TTL_SECONDS)
                    ref_key = patch_meta.get("referenceImageKey")
                    if ref_key:
                        patch_meta["referenceImageUrl"] = asset_store.presign_get(ref_key, expires=PRESIGNED_GET_TTL_SECONDS)
            if frame.get("qualityMatchStatus"):
                _decorate_embedded_s3_keys(frame["qualityMatchStatus"], asset_store)
        if decorated.get("qualityMatchAnalyses"):
            _decorate_embedded_s3_keys(decorated["qualityMatchAnalyses"], asset_store)
        for _, generation in decorated.get("segmentGenerations", {}).items():
            if generation.get("outputKey"):
                generation["downloadUrl"] = asset_store.presign_get(generation["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            if generation.get("inputMediaKey"):
                generation["inputMediaUrl"] = asset_store.presign_get(generation["inputMediaKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            if generation.get("inputFirstFrameKey"):
                generation["inputFirstFrameUrl"] = asset_store.presign_get(generation["inputFirstFrameKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            if generation.get("inputLastFrameKey"):
                generation["inputLastFrameUrl"] = asset_store.presign_get(generation["inputLastFrameKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            if generation.get("sourceFirstFrameCaptureKey"):
                generation["sourceFirstFrameCaptureUrl"] = asset_store.presign_get(
                    generation["sourceFirstFrameCaptureKey"], expires=PRESIGNED_GET_TTL_SECONDS
                )
            if generation.get("sourceLastFrameCaptureKey"):
                generation["sourceLastFrameCaptureUrl"] = asset_store.presign_get(
                    generation["sourceLastFrameCaptureKey"], expires=PRESIGNED_GET_TTL_SECONDS
                )
            if generation.get("qc"):
                _decorate_embedded_s3_keys(generation["qc"], asset_store)
        for export in decorated.get("exports", []):
            export["downloadUrl"] = asset_store.presign_get(export["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS)
        return response(200, decorated, origin=origin)

    if path.startswith("/tasks/"):
        parts = path.strip("/").split("/")
        if len(parts) < 2:
            return error_response(404, "Not found", origin=origin)
        task_id = parts[1]
        try:
            task = _load_task_or_404(store, user_id, task_id)
        except KeyError:
            return error_response(404, "Task not found", origin=origin)

        logger.append_keys(taskId=task_id)

        if method == "POST" and len(parts) == 4 and parts[2] == "uploads" and parts[3] == "video":
            req = _json_model(UploadVideoRequest, event)
            if req.sizeBytes > settings.max_upload_bytes:
                return error_response(400, f"Upload too large (max={settings.max_upload_bytes})", origin=origin)
            if not req.contentType.startswith("video/"):
                return error_response(400, "Invalid content type", origin=origin)

            key = _asset_paths_for_task(task).original_video(req.filename)
            upload_url = asset_store.presign_put(key, expires=900, content_type=req.contentType)
            task["video"]["original"] = {
                "s3Key": key,
                "filename": req.filename,
                "sizeBytes": req.sizeBytes,
                "sha256": None,
            }
            task["status"] = "created"
            store.save_task(task)
            return response(200, {"uploadUrl": upload_url, "s3Key": key}, origin=origin)

        if method == "DELETE" and len(parts) == 3 and parts[2] == "assets":
            req = _json_model(AssetDeleteRequest, event)

            def _delete_key_if_present(key: str | None) -> None:
                if not key:
                    return
                try:
                    asset_store.delete_object(key)
                except ClientError:
                    logger.warning("Asset delete failed", extra={"taskId": task_id, "key": key})

            if req.assetType == "upload":
                original = task.get("video", {}).get("original", {})
                key = original.get("s3Key")
                if not key:
                    return error_response(404, "Upload not found", origin=origin)
                _delete_key_if_present(key)
                task.setdefault("video", {}).pop("original", None)
                if not task.get("video", {}).get("editSource"):
                    task["status"] = "created"
                store.save_task(task)
                return response(200, {"ok": True}, origin=origin)

            if req.assetType == "frame_capture":
                frame_id = req.frameId
                frame = task.get("frames", {}).get(frame_id or "")
                if not frame:
                    return error_response(404, "Frame not found", origin=origin)
                is_referenced = any(
                    seg.get("startFrameId") == frame_id or seg.get("endFrameId") == frame_id
                    for seg in task.get("segments", [])
                )
                if is_referenced:
                    return error_response(400, "Frame is used by segment boundaries", origin=origin)
                _delete_key_if_present(frame.get("captureKey"))
                for variant in frame.get("variants", []):
                    _delete_key_if_present(variant.get("outputKey"))
                    patch_meta = variant.get("patchMeta", {})
                    _delete_key_if_present(patch_meta.get("patchOnlyKey"))
                    _delete_key_if_present(patch_meta.get("maskKey"))
                analyses = task.get("qualityMatchAnalyses", {})
                if isinstance(analyses, dict):
                    remove_analysis_ids = [
                        analysis_id
                        for analysis_id, analysis in analyses.items()
                        if isinstance(analysis, dict) and analysis.get("frameId") == frame_id
                    ]
                    for analysis_id in remove_analysis_ids:
                        analyses.pop(analysis_id, None)
                task.get("frames", {}).pop(frame_id, None)
                store.save_task(task)
                return response(200, {"ok": True}, origin=origin)

            if req.assetType == "frame_variant":
                frame_id = req.frameId
                variant_id = req.variantId
                frame = task.get("frames", {}).get(frame_id or "")
                if not frame:
                    return error_response(404, "Frame not found", origin=origin)
                variants = frame.get("variants", [])
                variant = next((v for v in variants if v.get("variantId") == variant_id), None)
                if not variant:
                    return error_response(404, "Variant not found", origin=origin)
                _delete_key_if_present(variant.get("outputKey"))
                patch_meta = variant.get("patchMeta", {})
                _delete_key_if_present(patch_meta.get("patchOnlyKey"))
                _delete_key_if_present(patch_meta.get("maskKey"))
                frame["variants"] = [v for v in variants if v.get("variantId") != variant_id]
                if frame.get("selectedVariantId") == variant_id:
                    frame["selectedVariantId"] = frame["variants"][0]["variantId"] if frame["variants"] else None
                analyses = task.get("qualityMatchAnalyses", {})
                if isinstance(analyses, dict):
                    remove_analysis_ids = [
                        analysis_id
                        for analysis_id, analysis in analyses.items()
                        if isinstance(analysis, dict)
                        and analysis.get("frameId") == frame_id
                        and analysis.get("variantId") == variant_id
                    ]
                    for analysis_id in remove_analysis_ids:
                        analyses.pop(analysis_id, None)
                    status = frame.get("qualityMatchStatus")
                    if isinstance(status, dict):
                        source_analysis = status.get("qualityMatchSourceAnalysisId")
                        if source_analysis in remove_analysis_ids:
                            frame["qualityMatchStatus"] = None
                            frame["qualityMatched"] = False
                _cleanup_custom_reports(task)
                store.save_task(task)
                return response(200, {"ok": True}, origin=origin)

            if req.assetType == "segment_generation":
                gen_id = req.genId
                generation = task.get("segmentGenerations", {}).get(gen_id or "")
                if not generation:
                    return error_response(404, "Generation not found", origin=origin)
                _delete_key_if_present(generation.get("outputKey"))
                task.get("segmentGenerations", {}).pop(gen_id, None)
                for segment in task.get("segments", []):
                    if segment.get("selectedGenerationId") == gen_id:
                        segment["selectedGenerationId"] = None
                _cleanup_custom_reports(task)
                store.save_task(task)
                return response(200, {"ok": True}, origin=origin)

            if req.assetType == "export":
                export_id = req.exportId
                exports = task.get("exports", [])
                export_item = next((e for e in exports if e.get("exportId") == export_id), None)
                if not export_item:
                    return error_response(404, "Export not found", origin=origin)
                _delete_key_if_present(export_item.get("outputKey"))
                task["exports"] = [e for e in exports if e.get("exportId") != export_id]
                store.save_task(task)
                return response(200, {"ok": True}, origin=origin)

            return error_response(400, "Unsupported asset type", origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "reports":
            req = _json_model(CustomReportCreateRequest, event)
            raw_refs = [item.model_dump(exclude_none=True) for item in req.outputRefs]
            output_refs = _normalize_custom_report_refs(task, raw_refs)
            if not output_refs:
                return error_response(400, "No valid report outputs selected", origin=origin)
            custom_reports = task.setdefault("customReports", [])
            report_type_label = "QC Frame" if req.reportType == "qc_frame" else "QC Video"
            report_name = (req.name or "").strip()
            if not report_name:
                report_name = f"{report_type_label} Report {len(custom_reports) + 1}"
            now = now_iso()
            report = {
                "reportId": new_id("report"),
                "reportType": req.reportType,
                "name": report_name[:80],
                "outputRefs": output_refs,
                "createdAt": now,
                "updatedAt": now,
            }
            custom_reports.append(report)
            _cleanup_custom_reports(task)
            store.save_task(task)
            return response(201, {"reportId": report["reportId"], "report": report}, origin=origin)

        if method == "DELETE" and len(parts) == 4 and parts[2] == "reports":
            report_id = parts[3]
            reports = task.get("customReports", [])
            if not isinstance(reports, list):
                return error_response(404, "Report not found", origin=origin)
            before = len(reports)
            task["customReports"] = [
                report
                for report in reports
                if not (isinstance(report, dict) and report.get("reportId") == report_id)
            ]
            if len(task["customReports"]) == before:
                return error_response(404, "Report not found", origin=origin)
            store.save_task(task)
            return response(200, {"ok": True}, origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "ingest":
            original = task.get("video", {}).get("original")
            if not original:
                return error_response(400, "Upload a video first", origin=origin)
            try:
                asset_store.head_object(original["s3Key"])
            except ClientError:
                return error_response(400, "Uploaded video not found in S3", origin=origin)
            task["status"] = "ingesting"
            store.save_task(task)
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="ingest_video",
                payload={},
            )
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "GET" and len(parts) == 3 and parts[2] == "thumbnails":
            manifest_key = f"users/{user_id}/tasks/{task_id}/thumbs/manifest.json"
            try:
                asset_store.head_object(manifest_key)
            except ClientError:
                return error_response(404, "Thumbnail manifest not ready", origin=origin)
            manifest_url = asset_store.presign_get(manifest_key, expires=900)
            return response(200, {"manifestUrl": manifest_url}, origin=origin)

        if method == "GET" and len(parts) == 4 and parts[2] == "frames" and parts[3] == "strip":
            query = _extract_query(event)
            start_sec = float(query.get("startSec", "0"))
            end_sec = float(query.get("endSec", str(start_sec + 2)))
            if end_sec <= start_sec:
                return error_response(400, "endSec must be greater than startSec", origin=origin)
            if end_sec - start_sec > 6:
                return error_response(400, "strip range must be <= 6 seconds", origin=origin)

            edit_source_key = task.get("video", {}).get("editSource", {}).get("s3Key")
            if not edit_source_key:
                return error_response(400, "Task not ingested", origin=origin)

            fps = _fps(task)
            start_idx = max(0, int(math.floor(start_sec * float(fps))))
            end_idx = int(math.ceil(end_sec * float(fps)))

            frames: list[dict[str, Any]] = []
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                local_video = td_path / "edit.mp4"
                boto3.client("s3").download_file(settings.assets_bucket, edit_source_key, str(local_video))
                for frame_idx in range(start_idx, end_idx):
                    frame_file = td_path / f"f_{frame_idx}.jpg"
                    extract_frame_png(str(local_video), frame_idx, str(frame_file))
                    thumb_key = f"users/{user_id}/tasks/{task_id}/thumbs/strip/{start_idx}_{end_idx}/f_{frame_idx}.jpg"
                    boto3.client("s3").upload_file(
                        str(frame_file),
                        settings.assets_bucket,
                        thumb_key,
                        ExtraArgs={"ContentType": "image/jpeg", "ServerSideEncryption": "AES256"},
                    )
                    frames.append(
                        {
                            "frameIndex": frame_idx,
                            "timecode": _timecode(frame_idx, fps),
                            "thumbUrl": asset_store.presign_get(thumb_key, expires=900),
                        }
                    )
            return response(200, {"frames": frames}, origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "segments":
            req = _json_model(SegmentCreateRequest, event)
            try:
                start, end_excl, dur_frames = _resolve_segment_frames(task, req.startFrameIndex, req.durationSeconds)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)

            segment_id = new_id("seg")
            start_capture = _capture_frame_sync(task=task, frame_index=start, asset_store=asset_store)
            end_capture = _capture_frame_sync(task=task, frame_index=max(start, end_excl - 1), asset_store=asset_store)
            fps = _fps(task)
            segment = {
                "segmentId": segment_id,
                "startFrame": start,
                "endFrameExclusive": end_excl,
                "durationFrames": dur_frames,
                "durationSec": req.durationSeconds,
                "startTimecode": _timecode(start, fps),
                "endTimecode": _timecode(end_excl, fps),
                "startFrameId": start_capture["frameId"],
                "endFrameId": end_capture["frameId"],
                "selectedGenerationId": None,
            }
            task.setdefault("segments", []).append(segment)
            store.save_task(task)
            return response(
                201,
                {
                    "segmentId": segment_id,
                    "resolvedStartFrameIndex": start,
                    "resolvedEndFrameIndex": end_excl,
                },
                origin=origin,
            )

        if method == "PATCH" and len(parts) == 4 and parts[2] == "segments":
            segment_id = parts[3]
            req = _json_model(SegmentPatchRequest, event)
            segment = next((s for s in task["segments"] if s["segmentId"] == segment_id), None)
            if not segment:
                return error_response(404, "Segment not found", origin=origin)

            start_frame = req.startFrameIndex if req.startFrameIndex is not None else segment["startFrame"]
            end_exclusive = req.endFrameExclusive if req.endFrameExclusive is not None else segment["endFrameExclusive"]
            if end_exclusive <= start_frame:
                return error_response(400, "Invalid in/out range", origin=origin)

            fps = _fps(task)
            duration_frames = end_exclusive - start_frame
            duration_seconds = duration_frames / float(fps)

            segment["startFrame"] = start_frame
            segment["endFrameExclusive"] = end_exclusive
            segment["durationFrames"] = duration_frames
            segment["durationSec"] = round(duration_seconds, 3)
            segment["startTimecode"] = _timecode(start_frame, fps)
            segment["endTimecode"] = _timecode(end_exclusive, fps)

            start_capture = _capture_frame_sync(task=task, frame_index=start_frame, asset_store=asset_store)
            end_capture = _capture_frame_sync(task=task, frame_index=max(start_frame, end_exclusive - 1), asset_store=asset_store)
            segment["startFrameId"] = start_capture["frameId"]
            segment["endFrameId"] = end_capture["frameId"]

            store.save_task(task)
            return response(200, {"ok": True, "segment": segment}, origin=origin)

        if method == "DELETE" and len(parts) == 4 and parts[2] == "segments":
            segment_id = parts[3]
            before = len(task["segments"])
            task["segments"] = [s for s in task["segments"] if s["segmentId"] != segment_id]
            if len(task["segments"]) == before:
                return error_response(404, "Segment not found", origin=origin)
            store.save_task(task)
            return response(200, {"ok": True}, origin=origin)

        if method == "POST" and len(parts) == 4 and parts[2] == "frames" and parts[3] == "capture":
            req = _json_model(FrameCaptureRequest, event)
            try:
                out = _capture_frame_sync(task=task, frame_index=req.frameIndex, asset_store=asset_store)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            store.save_task(task)
            return response(200, out, origin=origin)

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "quality-match" and parts[5] == "mask-upload":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(QualityMatchMaskUploadRequest, event)
            analysis_id = req.analysisId or new_id("qm")
            paths = _asset_paths_for_task(task)
            mask_key = paths.quality_match_mask_upload(frame_id, analysis_id, "user_mask")
            upload_url = asset_store.presign_put(mask_key, expires=900, content_type="image/png")
            return response(200, {"analysisId": analysis_id, "maskKey": mask_key, "maskUploadUrl": upload_url}, origin=origin)

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "quality-match" and parts[5] == "analyse":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(QualityMatchAnalyseRequest, event)
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == req.variantId), None)
            if not variant:
                return error_response(404, "Variant not found", origin=origin)

            analysis_id = req.existingAnalysisId or new_id("qm")
            paths = _asset_paths_for_task(task)
            task_prefix = f"{paths.task_prefix()}/frames/{frame_id}/quality_match/"
            if req.maskKey and not str(req.maskKey).startswith(task_prefix):
                return error_response(400, "Mask key is outside this frame quality-match path", origin=origin)

            settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else None
            qm_settings = QualityMatchSettings.from_payload(settings_payload)

            original_bytes = asset_store.read_bytes(frame["captureKey"])
            generated_bytes = asset_store.read_bytes(variant["outputKey"])
            patch_meta = variant.get("patchMeta") if isinstance(variant.get("patchMeta"), dict) else {}
            original_mask_key = patch_meta.get("maskKey") if isinstance(patch_meta, dict) else None
            original_mask_bytes = asset_store.read_bytes(original_mask_key) if isinstance(original_mask_key, str) and original_mask_key else None
            override_mask_bytes = asset_store.read_bytes(req.maskKey) if req.maskKey else None

            analysis = analyse_quality_match(
                original_bytes=original_bytes,
                generated_bytes=generated_bytes,
                settings=qm_settings,
                original_mask_bytes=original_mask_bytes,
                override_mask_bytes=override_mask_bytes,
            )

            aligned_key = paths.quality_match_artifact(frame_id, analysis_id, "aligned_generated", ".png")
            heatmap_key = paths.quality_match_artifact(frame_id, analysis_id, "diff_heatmap", ".png")
            binary_key = paths.quality_match_artifact(frame_id, analysis_id, "binary_change_mask", ".png")
            proposed_mask_key = paths.quality_match_artifact(frame_id, analysis_id, "proposed_merge_mask", ".png")
            restoration_key = paths.quality_match_artifact(frame_id, analysis_id, "restoration_map", ".png")
            preview_key = paths.quality_match_artifact(frame_id, analysis_id, "quality_match_preview", ".png")
            report_key = paths.quality_match_artifact(frame_id, analysis_id, "quality_match_report", ".json")

            artifacts = analysis["artifacts"]
            asset_store.put_bytes(aligned_key, artifacts["alignedGenerated"], content_type="image/png")
            asset_store.put_bytes(heatmap_key, artifacts["diffHeatmap"], content_type="image/png")
            asset_store.put_bytes(binary_key, artifacts["binaryChangeMask"], content_type="image/png")
            asset_store.put_bytes(proposed_mask_key, artifacts["proposedMergeMask"], content_type="image/png")
            asset_store.put_bytes(restoration_key, artifacts["restorationMap"], content_type="image/png")
            asset_store.put_bytes(preview_key, artifacts["preview"], content_type="image/png")
            report_payload = {
                "analysisId": analysis_id,
                "taskId": task_id,
                "frameId": frame_id,
                "variantId": req.variantId,
                "createdAt": now_iso(),
                "settings": analysis["settings"],
                "metrics": analysis["metrics"],
                "warnings": analysis["warnings"],
                "report": analysis["report"],
            }
            asset_store.put_bytes(report_key, json.dumps(report_payload).encode("utf-8"), content_type="application/json")

            analysis_record = {
                "analysisId": analysis_id,
                "frameId": frame_id,
                "variantId": req.variantId,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
                "originalMaskProvided": analysis["originalMaskProvided"],
                "userMaskProvided": analysis["userMaskProvided"],
                "settings": analysis["settings"],
                "metrics": analysis["metrics"],
                "warnings": analysis["warnings"],
                "artifacts": {
                    "alignedGeneratedKey": aligned_key,
                    "diffHeatmapKey": heatmap_key,
                    "binaryChangeMaskKey": binary_key,
                    "proposedMergeMaskKey": proposed_mask_key,
                    "restorationMapKey": restoration_key,
                    "previewKey": preview_key,
                    "reportJsonKey": report_key,
                },
                "source": {
                    "originalFrameKey": frame["captureKey"],
                    "generatedFrameKey": variant["outputKey"],
                    "originalMaskKey": original_mask_key,
                    "userMaskKey": req.maskKey,
                },
            }
            task.setdefault("qualityMatchAnalyses", {})[analysis_id] = analysis_record
            store.save_task(task)
            return response(
                200,
                {
                    "analysisId": analysis_id,
                    "originalMaskProvided": analysis["originalMaskProvided"],
                    "artifacts": {
                        "alignedGeneratedUri": asset_store.presign_get(aligned_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "diffHeatmapUri": asset_store.presign_get(heatmap_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "binaryChangeMaskUri": asset_store.presign_get(binary_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "proposedMergeMaskUri": asset_store.presign_get(proposed_mask_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "restorationMapUri": asset_store.presign_get(restoration_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "previewUri": asset_store.presign_get(preview_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "reportJsonUri": asset_store.presign_get(report_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    },
                    "metrics": analysis["metrics"],
                    "warnings": analysis["warnings"],
                    "settings": analysis["settings"],
                    "alreadyQualityMatched": bool(frame.get("qualityMatched") or (frame.get("qualityMatchStatus") or {}).get("qualityMatched")),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "quality-match" and parts[5] == "apply":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(QualityMatchApplyRequest, event)
            analysis = (task.get("qualityMatchAnalyses") or {}).get(req.analysisId)
            if not isinstance(analysis, dict):
                return error_response(404, "Quality Match analysis not found", origin=origin)
            if analysis.get("frameId") != frame_id:
                return error_response(400, "Analysis frame mismatch", origin=origin)
            variant_id = analysis.get("variantId")
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == variant_id), None)
            if not variant:
                return error_response(404, "Variant not found for analysis", origin=origin)

            analysis_artifacts = analysis.get("artifacts") if isinstance(analysis.get("artifacts"), dict) else {}
            default_mask_key = analysis_artifacts.get("proposedMergeMaskKey") if isinstance(analysis_artifacts, dict) else None
            final_mask_key = req.finalMaskKey or default_mask_key
            if not final_mask_key or not isinstance(final_mask_key, str):
                return error_response(400, "Final merge mask is required", origin=origin)
            paths = _asset_paths_for_task(task)
            if not final_mask_key.startswith(f"{paths.task_prefix()}/frames/{frame_id}/quality_match/"):
                return error_response(400, "Final merge mask must be in frame quality_match path", origin=origin)

            settings_payload = analysis.get("settings") if isinstance(analysis.get("settings"), dict) else {}
            if req.settings:
                settings_payload = {**settings_payload, **req.settings.model_dump(exclude_none=True)}
            qm_settings = QualityMatchSettings.from_payload(settings_payload)

            original_bytes = asset_store.read_bytes(frame["captureKey"])
            generated_bytes = asset_store.read_bytes(variant["outputKey"])
            final_mask_bytes = asset_store.read_bytes(final_mask_key)
            patch_meta = variant.get("patchMeta") if isinstance(variant.get("patchMeta"), dict) else {}
            original_mask_key = patch_meta.get("maskKey") if isinstance(patch_meta, dict) else None
            original_mask_bytes = asset_store.read_bytes(original_mask_key) if isinstance(original_mask_key, str) and original_mask_key else None

            applied = apply_quality_match(
                original_bytes=original_bytes,
                generated_bytes=generated_bytes,
                final_mask_bytes=final_mask_bytes,
                settings=qm_settings,
                original_mask_bytes=original_mask_bytes,
            )

            if req.overwriteGeneratedFrame:
                asset_store.put_bytes(variant["outputKey"], applied["artifacts"]["final"], content_type="image/png")
            final_key = paths.quality_match_artifact(frame_id, req.analysisId, "quality_match_final", ".png")
            final_preview_key = paths.quality_match_artifact(frame_id, req.analysisId, "quality_match_preview", ".png")
            report_key = paths.quality_match_artifact(frame_id, req.analysisId, "quality_match_report", ".json")
            asset_store.put_bytes(final_key, applied["artifacts"]["final"], content_type="image/png")
            asset_store.put_bytes(final_preview_key, applied["artifacts"]["final"], content_type="image/png")
            asset_store.put_bytes(report_key, json.dumps(applied["artifacts"]["reportJson"]).encode("utf-8"), content_type="application/json")

            before = analysis.get("metrics") if isinstance(analysis.get("metrics"), dict) else {}
            after = applied.get("metricsAfter") if isinstance(applied.get("metricsAfter"), dict) else {}
            frame_status = {
                "qcReviewed": True,
                "qualityMatched": True,
                "qualityMatchVersion": "quality-match-v1",
                "qualityMatchAppliedAt": now_iso(),
                "qualityMatchAppliedBy": user_id,
                "qualityMatchSourceAnalysisId": req.analysisId,
                "qualityMatchOriginalMaskProvided": bool(analysis.get("originalMaskProvided")),
                "qualityMatchUserEditedMask": bool(req.finalMaskKey),
                "qualityMatchMetrics": {
                    "changedPctBefore": before.get("changedPctBefore"),
                    "changedPctAfter": after.get("changedPctAfter"),
                    "outsideLeakageBefore": before.get("outsideLeakageBefore"),
                    "outsideLeakageAfter": after.get("outsideLeakageAfter"),
                    "boundarySpillBefore": before.get("boundarySpillBefore"),
                    "boundarySpillAfter": after.get("boundarySpillAfter"),
                },
                "qualityMatchArtifacts": {
                    "alignedGeneratedKey": analysis_artifacts.get("alignedGeneratedKey"),
                    "diffHeatmapKey": analysis_artifacts.get("diffHeatmapKey"),
                    "binaryChangeMaskKey": analysis_artifacts.get("binaryChangeMaskKey"),
                    "proposedMergeMaskKey": analysis_artifacts.get("proposedMergeMaskKey"),
                    "restorationMapKey": analysis_artifacts.get("restorationMapKey"),
                    "previewKey": analysis_artifacts.get("previewKey"),
                    "finalKey": final_key,
                    "reportJsonKey": report_key,
                },
            }
            frame["qcReviewed"] = True
            frame["qualityMatched"] = True
            frame["qualityMatchStatus"] = frame_status
            variant["qualityMatch"] = {
                "appliedAt": now_iso(),
                "analysisId": req.analysisId,
                "finalMaskKey": final_mask_key,
                "finalKey": final_key,
                "reportJsonKey": report_key,
            }

            analysis["updatedAt"] = now_iso()
            analysis["applied"] = {
                "at": now_iso(),
                "userId": user_id,
                "finalMaskKey": final_mask_key,
                "finalKey": final_key,
                "reportJsonKey": report_key,
                "overwriteGeneratedFrame": bool(req.overwriteGeneratedFrame),
            }
            analysis.setdefault("artifacts", {})["finalKey"] = final_key
            analysis.setdefault("artifacts", {})["reportJsonKey"] = report_key

            shot_id = next(
                (
                    str(segment.get("segmentId"))
                    for segment in task.get("segments", [])
                    if segment.get("startFrameId") == frame_id or segment.get("endFrameId") == frame_id
                ),
                frame_id,
            )
            task.setdefault("history", []).append(
                {
                    "type": "QUALITY_MATCH_APPLIED",
                    "frameId": frame_id,
                    "shotId": shot_id,
                    "userId": user_id,
                    "timestamp": now_iso(),
                    "details": {
                        "originalMaskProvided": bool(analysis.get("originalMaskProvided")),
                        "userEditedMask": bool(req.finalMaskKey),
                        "changedPctBefore": before.get("changedPctBefore"),
                        "changedPctAfter": after.get("changedPctAfter"),
                        "outsideLeakageBefore": before.get("outsideLeakageBefore"),
                        "outsideLeakageAfter": after.get("outsideLeakageAfter"),
                    },
                }
            )
            store.save_task(task)
            return response(
                200,
                {
                    "frameId": frame_id,
                    "replacedFrameUri": asset_store.presign_get(variant["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS),
                    "qcReviewed": True,
                    "qualityMatched": True,
                    "reportJsonUri": asset_store.presign_get(report_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    "metrics": {
                        "changedPctBefore": before.get("changedPctBefore"),
                        "changedPctAfter": after.get("changedPctAfter"),
                        "outsideLeakageBefore": before.get("outsideLeakageBefore"),
                        "outsideLeakageAfter": after.get("outsideLeakageAfter"),
                        "boundarySpillBefore": before.get("boundarySpillBefore"),
                        "boundarySpillAfter": after.get("boundarySpillAfter"),
                    },
                    "artifacts": {
                        "finalUri": asset_store.presign_get(final_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "previewUri": asset_store.presign_get(final_preview_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "maskUri": asset_store.presign_get(final_mask_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    },
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "references" and parts[5] == "uploads":
            frame_id = parts[3]
            if frame_id not in task.get("frames", {}):
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ReferenceUploadRequest, event)
            uploads: list[dict[str, str]] = []
            paths = _asset_paths_for_task(task)
            for file_req in req.files:
                if not file_req.contentType.lower().startswith("image/"):
                    return error_response(400, "Reference files must be images", origin=origin)
                reference_id = new_id("ref")
                key = paths.frame_reference(frame_id, reference_id, file_req.filename)
                uploads.append(
                    {
                        "referenceId": reference_id,
                        "key": key,
                        "uploadUrl": asset_store.presign_put(key, expires=900, content_type=file_req.contentType),
                    }
                )
            return response(200, {"uploads": uploads}, origin=origin)

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "edits" and parts[5] == "full":
            frame_id = parts[3]
            if frame_id not in task.get("frames", {}):
                return error_response(404, "Frame not found", origin=origin)

            req = _json_model(FullEditRequest, event)
            frame = task["frames"][frame_id]
            try:
                source_key, source_variant_id = _resolve_frame_source(frame, req.sourceVariantId)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            try:
                prompt = _sanitize_prompt(req.prompt)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            logger.info("Queueing full edit", extra={**_audit_prompt(prompt), "taskId": task_id, "frameId": frame_id})

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="edit_full",
                payload={
                    "frameId": frame_id,
                    "model": req.model,
                    "prompt": prompt,
                    "sourceKey": source_key,
                    "sourceVariantId": source_variant_id,
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "edits" and parts[5] == "patch" and parts[6] == "init":
            frame_id = parts[3]
            if frame_id not in task.get("frames", {}):
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(PatchInitRequest, event)

            variant_id = new_id("patch")
            paths = _asset_paths_for_task(task)
            patch_key = paths.frame_patch(frame_id, variant_id)
            frame = task["frames"][frame_id]
            try:
                source_key, _ = _resolve_frame_source(frame, req.sourceVariantId)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            source_bytes = asset_store.read_bytes(source_key)

            source = Image.open(BytesIO(source_bytes)).convert("RGBA")
            bleed = req.bleedPx
            x0 = max(0, req.patchRect.x - bleed)
            y0 = max(0, req.patchRect.y - bleed)
            x1 = min(source.width, req.patchRect.x + req.patchRect.width + bleed)
            y1 = min(source.height, req.patchRect.y + req.patchRect.height + bleed)
            patch = source.crop((x0, y0, x1, y1))
            out = BytesIO()
            patch.save(out, format="PNG")
            asset_store.put_bytes(patch_key, out.getvalue(), content_type="image/png")

            patch_upload = asset_store.presign_put(patch_key, expires=900, content_type="image/png")

            resp: dict[str, Any] = {
                "patchUploadUrl": patch_upload,
                "patchKey": patch_key,
                "previewUrl": asset_store.presign_get(patch_key, expires=900),
            }
            if req.hasMask:
                mask_key = paths.frame_mask(frame_id, variant_id)
                resp["maskUploadUrl"] = asset_store.presign_put(mask_key, expires=900, content_type="image/png")
                resp["maskKey"] = mask_key
            return response(200, resp, origin=origin)

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "edits" and parts[5] == "patch" and parts[6] == "submit":
            frame_id = parts[3]
            if frame_id not in task.get("frames", {}):
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(PatchSubmitRequest, event)
            frame = task["frames"][frame_id]
            try:
                source_key, source_variant_id = _resolve_frame_source(frame, req.sourceVariantId)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            try:
                prompt = _sanitize_prompt(req.prompt)
                reference_key = _validated_reference_key(task, req.referenceImageKey)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            if req.model == "runware_ace_pp" and not reference_key:
                return error_response(400, "Runware ACE++ requires one reference image", origin=origin)
            logger.info("Queueing patch edit", extra={**_audit_prompt(prompt), "taskId": task_id, "frameId": frame_id})

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="edit_patch",
                payload={
                    "frameId": frame_id,
                    "model": req.model,
                    "prompt": prompt,
                    "patchKey": req.patchKey,
                    "maskKey": req.maskKey,
                    "patchRect": req.patchRect.model_dump(),
                    "featherPx": req.featherPx,
                    "bleedPx": req.bleedPx,
                    "referenceImageKey": reference_key,
                    "runwareRepaintingScale": req.runwareRepaintingScale,
                    "edgeAwareRefine": req.edgeAwareRefine,
                    "edgeAwareStrength": req.edgeAwareStrength,
                    "edgeAwareRadiusPx": req.edgeAwareRadiusPx,
                    "maskGrowPx": req.maskGrowPx,
                    "sourceKey": source_key,
                    "sourceVariantId": source_variant_id,
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "variants" and parts[6] == "select":
            frame_id = parts[3]
            variant_id = parts[5]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            if variant_id == "original":
                frame["selectedVariantId"] = None
                store.save_task(task)
                return response(200, {"ok": True}, origin=origin)
            variant_exists = any(v["variantId"] == variant_id for v in frame.get("variants", []))
            if not variant_exists:
                return error_response(404, "Variant not found", origin=origin)
            frame["selectedVariantId"] = variant_id
            store.save_task(task)
            return response(200, {"ok": True}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "segments" and parts[4] == "generate":
            segment_id = parts[3]
            segment = next((s for s in task.get("segments", []) if s["segmentId"] == segment_id), None)
            if not segment:
                return error_response(404, "Segment not found", origin=origin)

            req = _json_model(SegmentGenerateRequest, event)
            max_seconds = VIDEO_MODEL_MAX_SECONDS.get(req.lumaModel)
            segment_seconds = _segment_duration_seconds(task, segment)
            if max_seconds is not None and segment_seconds > float(max_seconds) + 1e-6:
                return error_response(
                    400,
                    f"Segment duration {segment_seconds:.2f}s exceeds max {max_seconds}s for model {req.lumaModel}",
                    origin=origin,
                )
            try:
                prompt = _sanitize_prompt(req.prompt) if req.prompt else None
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            if prompt:
                logger.info("Queueing segment generation", extra={**_audit_prompt(prompt), "taskId": task_id, "segmentId": segment_id})

            gen_id = new_id("gen")
            task.setdefault("segmentGenerations", {})[gen_id] = {
                "genId": gen_id,
                "segmentId": segment_id,
                "luma": {
                    "provider": (
                        "runway"
                        if req.lumaModel == "runway-gen4.5"
                        else (
                            "kling"
                            if req.lumaModel == "kling-2.6"
                            else ("runware" if req.lumaModel in {"veo-3.1", "veo-3.1-fast", "wan2.2-a14b", "wan2.2-animate"} else "luma")
                        )
                    ),
                    "model": req.lumaModel,
                    "mode": req.mode,
                    "prompt": prompt,
                    "lumaGenerationId": None,
                },
                "status": "queued",
                "outputKey": None,
                "jobId": None,
                "createdAt": now_iso(),
            }
            store.save_task(task)

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="segment_generate",
                payload={
                    "segmentId": segment_id,
                    "genId": gen_id,
                    "lumaModel": req.lumaModel,
                    "mode": req.mode,
                    "prompt": prompt,
                    "firstFrameVariantId": req.firstFrameVariantId,
                    "lastFrameVariantId": req.lastFrameVariantId,
                },
            )
            queued_generation = task.setdefault("segmentGenerations", {}).get(gen_id)
            if isinstance(queued_generation, dict):
                queued_generation["jobId"] = job_id
                store.save_task(task)
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 4 and parts[2] == "qc" and parts[3] == "run":
            req = _json_model(QcRunRequest, event)
            requested_ids = req.generationIds or []
            existing_generations = task.get("segmentGenerations", {})
            if requested_ids:
                generation_ids = [gen_id for gen_id in requested_ids if gen_id in existing_generations]
                if not generation_ids:
                    return error_response(400, "No valid generation IDs provided", origin=origin)
            else:
                generation_ids = [
                    gen_id
                    for gen_id, generation in existing_generations.items()
                    if generation.get("status") == "complete"
                    and generation.get("outputKey")
                ]
            if not generation_ids:
                return error_response(400, "No completed generations available for QC", origin=origin)

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="qc_analysis",
                payload={"generationIds": generation_ids},
            )
            return response(202, {"jobId": job_id, "generationCount": len(generation_ids)}, origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "merge":
            req = _json_model(MergeRequest, event)
            if not req.selectedSegmentGenerationIds:
                return error_response(400, "Select at least one generation for merge", origin=origin)

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="merge_export",
                payload={
                    "selectedSegmentGenerationIds": req.selectedSegmentGenerationIds,
                    "temporalFeatherFrames": req.temporalFeatherFrames,
                    "generationAdjustments": req.generationAdjustments or {},
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

    if method == "GET" and path.startswith("/jobs/"):
        job_id = path.split("/")[2]
        job = store.load_job(user_id, job_id)
        if not job:
            return error_response(404, "Job not found", origin=origin)
        return response(200, job, origin=origin)

    return error_response(404, "Not found", origin=origin)


@logger.inject_lambda_context(log_event=False)
@tracer.capture_lambda_handler
def handler(event, context):
    try:
        return _route(event)
    except ValidationError as exc:
        return error_response(400, f"Validation failed: {exc.errors()}", origin=_origin(event))
    except Exception as exc:
        logger.exception("Unhandled error", extra={"error": str(exc)})
        return error_response(500, "Internal server error", origin=_origin(event))
