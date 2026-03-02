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
    FrameCaptureRequest,
    FullEditRequest,
    MergeRequest,
    PatchInitRequest,
    PatchSubmitRequest,
    SegmentCreateRequest,
    SegmentGenerateRequest,
    SegmentPatchRequest,
    TaskCreateRequest,
    UploadVideoRequest,
)

logger = Logger()
tracer = Tracer()
settings = load_settings()
LUMA_MODEL_MAX_SECONDS: dict[str, int] = {
    "ray-2": 10,
    "ray-flash-2": 15,
}
PRESIGNED_GET_TTL_SECONDS = 3600


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


def _segment_duration_seconds(task: dict[str, Any], segment: dict[str, Any]) -> float:
    fps = _fps(task)
    return (segment["endFrameExclusive"] - segment["startFrame"]) / float(fps)


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
            "exports": [],
            "history": [],
            "metaVersion": 0,
        }
        store.save_task(task)
        return response(201, {"taskId": task_id}, origin=origin)

    if method == "GET" and path == "/tasks":
        tasks = [_task_summary(item) for item in store.list_tasks(user_id)]
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
        for _, frame in decorated.get("frames", {}).items():
            frame["imageUrl"] = asset_store.presign_get(frame["captureKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            for variant in frame.get("variants", []):
                variant["imageUrl"] = asset_store.presign_get(variant["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS)
        for _, generation in decorated.get("segmentGenerations", {}).items():
            if generation.get("outputKey"):
                generation["downloadUrl"] = asset_store.presign_get(generation["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS)
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

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "edits" and parts[5] == "full":
            frame_id = parts[3]
            if frame_id not in task.get("frames", {}):
                return error_response(404, "Frame not found", origin=origin)

            req = _json_model(FullEditRequest, event)
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
            capture_bytes = asset_store.read_bytes(frame["captureKey"])

            source = Image.open(BytesIO(capture_bytes)).convert("RGBA")
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
            try:
                prompt = _sanitize_prompt(req.prompt)
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
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
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "variants" and parts[6] == "select":
            frame_id = parts[3]
            variant_id = parts[5]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
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
            max_seconds = LUMA_MODEL_MAX_SECONDS.get(req.lumaModel)
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
                    "model": req.lumaModel,
                    "mode": req.mode,
                    "prompt": prompt,
                    "lumaGenerationId": None,
                },
                "status": "queued",
                "outputKey": None,
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
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

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
