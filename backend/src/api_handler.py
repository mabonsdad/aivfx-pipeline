from __future__ import annotations

import hashlib
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
from botocore.exceptions import ClientError
from pydantic import ValidationError

from PIL import Image, ImageOps

from src.core.assets import ApiAssetPaths, AssetPaths, AssetStore
from src.core.auth import UnauthorizedError, get_user_claims, get_user_id
from src.core.config import load_settings
from src.core.ffmpeg import extract_frame_png, ffprobe_video
from src.core.http import error_response, parse_json_body, response
from src.core.ids import deterministic_frame_id, new_id, prompt_hash
from src.core.logger import Logger
from src.core.secrets import load_secret
from src.core.store import S3JsonStore, now_iso
from src.jobs.queue import JobQueue
from src.models.schemas import (
    ApiAssetUploadInitRequest,
    ApiImageEditFullRequest,
    ApiImageEditPatchRequest,
    ApiReferenceVideoGenerateRequest,
    AssetDeleteRequest,
    ChunkedGenerationPauseRequest,
    ChunkedGenerationRestartRequest,
    ChunkedSegmentGenerateRequest,
    CustomReportCreateRequest,
    ExternalQcPairUploadRequest,
    FrameCaptureRequest,
    FullEditRequest,
    ManualRefineExportRequest,
    ManualRefineUploadCompleteRequest,
    ManualRefineUploadInitRequest,
    MergeRequest,
    MotionSyncQcRunRequest,
    QualityMatchAnalyseRequest,
    QualityMatchApplyRequest,
    QualityMatchMaskUploadRequest,
    QualityMatchPreviewRequest,
    QualityMatchSamRequest,
    QcRunRequest,
    PatchInitRequest,
    PatchSubmitRequest,
    ReferenceUploadRequest,
    SegmentCreateRequest,
    SegmentGenerationExtendRequest,
    SegmentGenerateRequest,
    SegmentPatchRequest,
    TaskCreateRequest,
    UploadVideoRequest,
)
from src.quality_match.apply_flow import _allocate_refined_variant_storage, create_refined_variant_from_upload
from src.quality_match.service import QualityMatchSettings, analyse_quality_match, preview_quality_match_from_mask
from src.video_cleanup.models import VideoCleanupSettings
from src.video_cleanup.schemas import (
    VideoCleanupApplyRequest,
    VideoCleanupCreateRequest,
    VideoCleanupKeyframeUploadCompleteRequest,
    VideoCleanupKeyframeUploadInitRequest,
    VideoCleanupPreviewRequest,
    VideoCleanupSamAssistRequest,
)
from src.video_cleanup.service import add_or_replace_keyframe, get_cleanup_track, resolve_first_mask_key_from_analysis

logger = Logger()
settings = load_settings()
MODEL_FRAME_BUDGET_FPS = 24
VIDEO_MODEL_MAX_SECONDS: dict[str, int] = {
    "ray-2": 10,
    "ray-flash-2": 15,
    "runway-gen4.5": 10,
    "kling-2.6": 10,
    "kling-o1": 10,
    "kling-v3-omni-video": 10,
    "seedance-2.0-reference-to-video": 15,
    "veo-3.1": 8,
    "veo-3.1-fast": 8,
    "wan2.2-a14b": 5,
    "wan2.2-animate": 10,
    "wan2.7-videoedit": 10,
}
VIDEO_MODEL_MIN_SECONDS: dict[str, int] = {
    "kling-o1": 3,
    "kling-v3-omni-video": 3,
    "seedance-2.0-reference-to-video": 4,
    "wan2.7-videoedit": 2,
}
VIDEO_MODEL_FRAME_BUDGET_FPS: dict[str, int] = {
    "veo-3.1": MODEL_FRAME_BUDGET_FPS,
    "veo-3.1-fast": MODEL_FRAME_BUDGET_FPS,
}
CHUNKED_GENERATION_SUPPORTED_MODELS = {
    "ray-2",
    "ray-flash-2",
    "wan2.2-animate",
    "kling-o1",
    "kling-v3-omni-video",
    "seedance-2.0-reference-to-video",
    "wan2.7-videoedit",
}
CHUNKED_CONSERVATIVE_DURATION_SECONDS = 6
CHUNKED_MIN_OVERLAP_SECONDS = 0.5
PRESIGNED_GET_TTL_SECONDS = 3600
STALE_GENERATION_MAX_AGE_SECONDS = 30 * 60
CROP_LANDSCAPE_TARGET = (1920, 1080)
CROP_PORTRAIT_TARGET = (1080, 1920)
FRAME_REPORT_TESTS = {
    "frame_diff",
    "frame_composite",
    "frame_perceptual",
    "frame_boundary",
    "frame_sharpness",
    "frame_naturalness",
    "frame_texture",
    "video_diff",
}
VIDEO_REPORT_TESTS = {
    "video_diff",
    "video_frame_evidence",
}
VIDEO_COMPARE_REPORT_TESTS = {
    "video_model_compare",
}


def _find_chunked_generation_run(task: dict[str, Any], run_id: str) -> dict[str, Any] | None:
    return next((item for item in task.get("chunkedGenerationRuns", []) if isinstance(item, dict) and item.get("runId") == run_id), None)


def _find_chunked_generation_run_for_generation(task: dict[str, Any], gen_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    for run in task.get("chunkedGenerationRuns", []):
        if not isinstance(run, dict):
            continue
        for chunk in run.get("chunks", []):
            if isinstance(chunk, dict) and chunk.get("generationId") == gen_id:
                return run, chunk
    return None, None


def _chunk_overlap_frames(fps: Fraction) -> int:
    return max(12, int(round(float(fps) * CHUNKED_MIN_OVERLAP_SECONDS)))


def _plan_chunk_windows(*, total_frames: int, fps: Fraction) -> tuple[int, list[dict[str, int | float]]]:
    chunk_duration_sec = CHUNKED_CONSERVATIVE_DURATION_SECONDS
    chunk_frames = max(1, int(round(float(fps) * chunk_duration_sec)))
    overlap_frames = min(max(2, _chunk_overlap_frames(fps)), max(2, chunk_frames - 2))
    if total_frames <= chunk_frames:
        return overlap_frames, [
            {
                "chunkIndex": 0,
                "startFrame": 0,
                "endFrameExclusive": total_frames,
                "durationFrames": total_frames,
                "durationSec": round(total_frames / float(fps), 4),
                "anchorFramesFromPrevious": 0,
                "overlapFrames": 0,
            }
        ]

    chunk_count = max(2, int(math.ceil((total_frames - overlap_frames) / float(chunk_frames - overlap_frames))))
    last_start = max(0, total_frames - chunk_frames)
    starts: list[int] = []
    for idx in range(chunk_count):
        if idx == chunk_count - 1:
            start = last_start
        else:
            start = int(round((last_start * idx) / max(1, chunk_count - 1)))
        if starts and start <= starts[-1]:
            start = min(last_start, starts[-1] + 1)
        starts.append(start)

    chunks: list[dict[str, int | float]] = []
    previous_end = 0
    for idx, start in enumerate(starts):
        end_exclusive = total_frames if idx == len(starts) - 1 else min(total_frames, start + chunk_frames)
        overlap_with_previous = max(0, previous_end - start) if idx > 0 else 0
        chunks.append(
            {
                "chunkIndex": idx,
                "startFrame": start,
                "endFrameExclusive": end_exclusive,
                "durationFrames": max(0, end_exclusive - start),
                "durationSec": round(max(0, end_exclusive - start) / float(fps), 4),
                "anchorFramesFromPrevious": max(0, overlap_with_previous - 1),
                "overlapFrames": overlap_with_previous,
            }
        )
        previous_end = end_exclusive
    return overlap_frames, chunks


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


def _segment_crop_output_size(width: int, height: int, aspect: str) -> tuple[int, int]:
    target_w, target_h = CROP_LANDSCAPE_TARGET if aspect == "16:9" else CROP_PORTRAIT_TARGET
    if width < target_w or height < target_h:
        return target_w, target_h
    return width, height


def _normalize_segment_crop(task: dict[str, Any], raw_crop: dict[str, Any] | None) -> dict[str, Any] | None:
    if not raw_crop:
        return None
    edit_source = task.get("video", {}).get("editSource", {})
    source_w = int(edit_source.get("width") or 0)
    source_h = int(edit_source.get("height") or 0)
    if source_w <= 0 or source_h <= 0:
        raise ValueError("Edit source dimensions unavailable")

    aspect = str(raw_crop.get("aspect") or "16:9")
    if aspect not in {"16:9", "9:16"}:
        raise ValueError("Invalid crop aspect")
    ratio_num, ratio_den = (16, 9) if aspect == "16:9" else (9, 16)

    x = int(raw_crop.get("x", 0))
    y = int(raw_crop.get("y", 0))
    width = int(raw_crop.get("width", source_w))
    height = int(raw_crop.get("height", source_h))
    feather_px = max(0, min(200, int(raw_crop.get("featherPx", 0))))

    if int(raw_crop.get("x", 0)) <= 0 and int(raw_crop.get("y", 0)) <= 0 and width >= source_w and height >= source_h:
        return {
            "enabled": False,
            "aspect": aspect,
            "x": 0,
            "y": 0,
            "width": source_w,
            "height": source_h,
            "featherPx": feather_px,
            "outputWidth": source_w,
            "outputHeight": source_h,
        }

    width = max(2, min(source_w, width))
    height = max(2, min(source_h, height))

    # Enforce the fixed crop ratio while preserving as much area as possible.
    if width * ratio_den != height * ratio_num:
        alt_height = max(2, min(source_h, round(width * ratio_den / ratio_num)))
        alt_width = max(2, min(source_w, round(height * ratio_num / ratio_den)))
        if abs((width * ratio_den) - (alt_height * ratio_num)) <= abs((alt_width * ratio_den) - (height * ratio_num)):
            height = alt_height
        else:
            width = alt_width

    x = max(0, min(source_w - width, x))
    y = max(0, min(source_h - height, y))

    # libx264+yuv420p requires even geometry. Snap crop box to even coords/sizes.
    if width % 2 != 0:
        width = max(2, width - 1)
    if height % 2 != 0:
        height = max(2, height - 1)
    if x % 2 != 0:
        x = max(0, x - 1)
    if y % 2 != 0:
        y = max(0, y - 1)
    if x + width > source_w:
        x = max(0, source_w - width)
    if y + height > source_h:
        y = max(0, source_h - height)
    if x % 2 != 0:
        x = max(0, x - 1)
    if y % 2 != 0:
        y = max(0, y - 1)

    is_full_frame = x == 0 and y == 0 and width == source_w and height == source_h
    output_w, output_h = _segment_crop_output_size(width, height, aspect)
    return {
        "enabled": not is_full_frame,
        "aspect": aspect,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "featherPx": feather_px,
        "outputWidth": output_w,
        "outputHeight": output_h,
    }


def _segment_crop_signature(crop: dict[str, Any] | None) -> str:
    if not crop or not crop.get("enabled"):
        return "full"
    payload = {
        "aspect": crop.get("aspect"),
        "x": int(crop.get("x", 0)),
        "y": int(crop.get("y", 0)),
        "width": int(crop.get("width", 0)),
        "height": int(crop.get("height", 0)),
        "outputWidth": int(crop.get("outputWidth", 0)),
        "outputHeight": int(crop.get("outputHeight", 0)),
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
    return digest[:16]


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


def _normalize_uploaded_refine_image(
    *,
    original_bytes: bytes,
    uploaded_bytes: bytes,
) -> bytes:
    original = ImageOps.exif_transpose(Image.open(BytesIO(original_bytes))).convert("RGB")
    uploaded = ImageOps.exif_transpose(Image.open(BytesIO(uploaded_bytes)))
    if uploaded.mode not in {"RGB", "RGBA", "LA"}:
        uploaded = uploaded.convert("RGBA" if "A" in uploaded.getbands() else "RGB")
    if uploaded.size != original.size:
        resample = Image.Resampling.LANCZOS
        fitted = ImageOps.contain(uploaded, original.size, resample)
        canvas_mode = "RGBA" if "A" in fitted.getbands() else "RGB"
        background = (0, 0, 0, 0) if canvas_mode == "RGBA" else (0, 0, 0)
        canvas = Image.new(canvas_mode, original.size, background)
        canvas.paste(fitted, ((original.size[0] - fitted.size[0]) // 2, (original.size[1] - fitted.size[1]) // 2))
        uploaded = canvas

    if "A" in uploaded.getbands():
        uploaded_rgba = uploaded.convert("RGBA")
        normalized = Image.alpha_composite(original.convert("RGBA"), uploaded_rgba).convert("RGB")
    else:
        normalized = uploaded.convert("RGB")

    out = BytesIO()
    normalized.save(out, format="PNG")
    return out.getvalue()


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


def _format_fps(fps: Fraction) -> str:
    value = float(fps)
    rounded = round(value, 2)
    if abs(rounded - round(rounded)) < 1e-6:
        return f"{int(round(rounded))}"
    return f"{rounded:.2f}".rstrip("0").rstrip(".")


def _video_model_label(model: str) -> str:
    labels = {
        "ray-2": "Luma Ray 2",
        "ray-flash-2": "Luma Ray Flash 2",
        "runway-gen4.5": "Runway Gen-4.5",
        "kling-2.6": "Kling 2.6",
        "kling-o1": "Kling O1 Edit",
        "kling-v3-omni-video": "Kling v3 Omni Video",
        "seedance-2.0-reference-to-video": "Seedance 2.0 Reference to Video",
        "veo-3.1": "Veo 3.1",
        "veo-3.1-fast": "Veo 3.1 Fast",
        "wan2.2-a14b": "Wan 2.2 A14B",
        "wan2.2-animate": "Wan 2.2 Animate",
        "wan2.7-videoedit": "Wan 2.7 VideoEdit",
    }
    return labels.get(model, model)


def _segment_duration_frames(segment: dict[str, Any]) -> int:
    duration_frames = segment.get("durationFrames")
    if duration_frames is not None:
        return int(duration_frames)
    return max(0, int(segment["endFrameExclusive"]) - int(segment["startFrame"]))


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
    enqueue: bool = True,
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
    if enqueue:
        queue.enqueue({"jobId": job_id, "taskId": task_id, "userId": user_id})
    return job_id


def _append_history_event(task: dict[str, Any], entry: dict[str, Any]) -> None:
    history = task.setdefault("history", [])
    marker = json.dumps(entry, sort_keys=True, default=str)
    for existing in history:
        if json.dumps(existing, sort_keys=True, default=str) == marker:
            return
    history.append(entry)


def _reconcile_segment_generation_job_states(task: dict[str, Any], store: S3JsonStore) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    user_id = str(task.get("userId") or "")
    frames = task.get("frames", {})
    segments = {str(segment.get("segmentId")): segment for segment in task.get("segments", []) if isinstance(segment, dict)}
    changed = False
    for gen_id, generation in generations.items():
        if not isinstance(generation, dict):
            continue
        status = str(generation.get("status") or "").lower()
        if status not in {"queued", "running"}:
            continue
        job_id = generation.get("jobId")
        if not isinstance(job_id, str) or not job_id:
            continue
        job = store.load_job(user_id, job_id)
        if not isinstance(job, dict):
            continue
        job_status = str(job.get("status") or "").lower()
        if job_status == "complete":
            result_refs = job.get("resultRefs") or {}
            output_key = result_refs.get("outputKey")
            if not output_key:
                continue
            payload = job.get("payload") or {}
            generation["status"] = "complete"
            generation["outputKey"] = output_key
            generation["error"] = None
            generation["updatedAt"] = job.get("updatedAt") or now_iso()
            generation["finishedAt"] = result_refs.get("finishedAt") or job.get("finishedAt") or job.get("updatedAt") or now_iso()
            if result_refs.get("processingDurationSec") is not None:
                generation["processingDurationSec"] = result_refs.get("processingDurationSec")
            luma = generation.setdefault("luma", {})
            if result_refs.get("provider"):
                luma["provider"] = result_refs["provider"]
            if result_refs.get("model"):
                luma["model"] = result_refs["model"]
            if result_refs.get("mode"):
                luma["mode"] = result_refs["mode"]
            if result_refs.get("providerGenerationId") is not None:
                luma["lumaGenerationId"] = result_refs.get("providerGenerationId")
            if payload.get("prompt") is not None:
                luma["prompt"] = payload.get("prompt")
            segment = segments.get(str(generation.get("segmentId") or payload.get("segmentId") or ""))
            if isinstance(segment, dict):
                generation["segmentCrop"] = segment.get("crop")
                start_frame = frames.get(segment.get("startFrameId")) if isinstance(frames, dict) else None
                end_frame = frames.get(segment.get("endFrameId")) if isinstance(frames, dict) else None
                if isinstance(start_frame, dict) and start_frame.get("captureKey"):
                    generation.setdefault("sourceFirstFrameCaptureKey", start_frame.get("captureKey"))
                if isinstance(end_frame, dict) and end_frame.get("captureKey"):
                    generation.setdefault("sourceLastFrameCaptureKey", end_frame.get("captureKey"))
            if payload.get("firstFrameVariantId") and not generation.get("sourceFirstFrameVariantId"):
                generation["sourceFirstFrameVariantId"] = payload.get("firstFrameVariantId")
            if payload.get("lastFrameVariantId") and not generation.get("sourceLastFrameVariantId"):
                generation["sourceLastFrameVariantId"] = payload.get("lastFrameVariantId")
            _append_history_event(
                task,
                {
                    "at": now_iso(),
                    "event": "segment_generation.reconciled_complete",
                    "jobId": job_id,
                    "genId": gen_id,
                },
            )
            changed = True
        elif job_status == "failed":
            generation["status"] = "failed"
            generation["error"] = job.get("error")
            generation["updatedAt"] = job.get("updatedAt") or now_iso()
            generation["finishedAt"] = job.get("finishedAt") or job.get("updatedAt") or now_iso()
            _append_history_event(
                task,
                {
                    "at": now_iso(),
                    "event": "segment_generation.reconciled_failed",
                    "jobId": job_id,
                    "genId": gen_id,
                },
            )
            changed = True
    return changed


def _backfill_segment_generation_preview_refs(task: dict[str, Any]) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    frames = task.get("frames", {})
    segments = {str(segment.get("segmentId")): segment for segment in task.get("segments", []) if isinstance(segment, dict)}
    changed = False
    for generation in generations.values():
        if not isinstance(generation, dict):
            continue
        segment = segments.get(str(generation.get("segmentId") or ""))
        if not isinstance(segment, dict):
            continue
        start_frame = frames.get(segment.get("startFrameId")) if isinstance(frames, dict) else None
        end_frame = frames.get(segment.get("endFrameId")) if isinstance(frames, dict) else None
        if not generation.get("sourceFirstFrameCaptureKey") and isinstance(start_frame, dict) and start_frame.get("captureKey"):
            generation["sourceFirstFrameCaptureKey"] = start_frame["captureKey"]
            changed = True
        if not generation.get("sourceLastFrameCaptureKey") and isinstance(end_frame, dict) and end_frame.get("captureKey"):
            generation["sourceLastFrameCaptureKey"] = end_frame["captureKey"]
            changed = True
        if generation.get("segmentCrop") is None:
            generation["segmentCrop"] = segment.get("crop")
    return changed


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
        if status not in {"queued", "running"}:
            continue
        if output_key:
            continue
        job_id = generation.get("jobId")
        if isinstance(job_id, str) and job_id:
            job = store.load_job(user_id, job_id)
            if not job:
                created_at = _parse_iso_datetime(generation.get("createdAt"))
                if created_at and (now_dt - created_at).total_seconds() > STALE_GENERATION_MAX_AGE_SECONDS:
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
    external_pairs = {
        str(item.get("pairId")): item
        for item in task.get("externalQcPairs", [])
        if isinstance(item, dict) and item.get("pairId")
    }
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
        elif asset_type == "external_frame_pair":
            pair_id = str(ref.get("pairId") or "")
            pair = external_pairs.get(pair_id)
            if isinstance(pair, dict):
                normalized_ref = {"assetType": "external_frame_pair", "pairId": pair_id}
        if not normalized_ref:
            continue
        ref_key = json.dumps(normalized_ref, sort_keys=True)
        if ref_key in seen:
            continue
        seen.add(ref_key)
        normalized.append(normalized_ref)
    return normalized


def _normalize_custom_report_tests(report_type: str, raw_tests: list[Any]) -> list[str]:
    allowed = (
        FRAME_REPORT_TESTS
        if report_type == "qc_frame"
        else VIDEO_COMPARE_REPORT_TESTS
        if report_type == "video_compare"
        else VIDEO_REPORT_TESTS
    )
    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_tests:
        test_name = str(item or "").strip()
        if test_name not in allowed or test_name in seen:
            continue
        seen.add(test_name)
        normalized.append(test_name)
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
        if not report_id or report_type not in {"qc_frame", "qc_video", "video_compare"}:
            changed = True
            continue
        asset_refs = _normalize_custom_report_refs(task, list(report.get("assetRefs") or report.get("outputRefs") or []))
        tests = _normalize_custom_report_tests(report_type, list(report.get("tests") or []))
        if not asset_refs or not tests:
            changed = True
            continue
        created_at = str(report.get("createdAt") or now_iso())
        updated_at = str(report.get("updatedAt") or created_at)
        report_label = "QC Frame" if report_type == "qc_frame" else "Video Compare" if report_type == "video_compare" else "QC Video"
        name = str(report.get("name") or "").strip() or f"{report_label} Report"
        status = str(report.get("status") or "queued").strip().lower()
        if status not in {"queued", "running", "complete", "failed"}:
            status = "queued"
        result_key = str(report.get("resultKey") or "").strip() or None
        job_id = str(report.get("jobId") or "").strip() or None
        error_value = str(report.get("error") or "").strip() or None
        cleaned = {
            "reportId": report_id,
            "reportType": report_type,
            "name": name[:80],
            "assetRefs": asset_refs,
            "tests": tests,
            "status": status,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }
        if result_key:
            cleaned["resultKey"] = result_key
        if job_id:
            cleaned["jobId"] = job_id
        if error_value:
            cleaned["error"] = error_value[:500]
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
    crop: dict[str, Any] | None = None,
) -> dict[str, Any]:
    edit_source_key = task["video"].get("editSource", {}).get("s3Key")
    if not edit_source_key:
        raise ValueError("Edit source not ready")

    normalized_crop = crop if crop and crop.get("enabled") else None
    if normalized_crop:
        crop_sig = _segment_crop_signature(normalized_crop)
        crop_digest = hashlib.sha256(
            f"{task['taskId']}:{edit_source_key}:{frame_index}:crop:{crop_sig}".encode("utf-8")
        ).hexdigest()
        frame_id = f"frame_{crop_digest[:20]}"
    else:
        frame_id = deterministic_frame_id(task["taskId"], edit_source_key, frame_index)
    frames = task.setdefault("frames", {})
    if frame_id in frames:
        frame = frames[frame_id]
        return {
            "frameId": frame_id,
            "imageUrl": asset_store.presign_get(frame["captureKey"], expires=PRESIGNED_GET_TTL_SECONDS),
            "timecode": frame["timecode"],
            "frameIndex": frame["frameIndex"],
            "width": frame.get("width"),
            "height": frame.get("height"),
        }

    s3 = boto3.client("s3")
    paths = _asset_paths_for_task(task)

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        local_video = td_path / "edit.mp4"
        local_frame = td_path / "frame.png"
        s3.download_file(settings.assets_bucket, edit_source_key, str(local_video))
        extract_frame_png(
            str(local_video),
            frame_index,
            str(local_frame),
            crop_x=(int(normalized_crop["x"]) if normalized_crop else None),
            crop_y=(int(normalized_crop["y"]) if normalized_crop else None),
            crop_width=(int(normalized_crop["width"]) if normalized_crop else None),
            crop_height=(int(normalized_crop["height"]) if normalized_crop else None),
            output_width=(int(normalized_crop["outputWidth"]) if normalized_crop else None),
            output_height=(int(normalized_crop["outputHeight"]) if normalized_crop else None),
        )
        with Image.open(local_frame) as captured:
            captured_w, captured_h = captured.size
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
        "width": captured_w,
        "height": captured_h,
        "variants": [],
        "selectedVariantId": None,
        "sourceCrop": normalized_crop,
    }

    return {
        "frameId": frame_id,
        "imageUrl": asset_store.presign_get(key, expires=PRESIGNED_GET_TTL_SECONDS),
        "timecode": timecode,
        "frameIndex": frame_index,
        "width": captured_w,
        "height": captured_h,
    }


def _resolve_segment_frames(
    task: dict[str, Any],
    start_frame_index: int,
    duration_seconds: int | None = None,
    end_frame_exclusive: int | None = None,
) -> tuple[int, int, int]:
    fps = _fps(task)
    frame_count = int(task["video"]["editSource"].get("frameCount", 0))
    if end_frame_exclusive is not None:
        end_exclusive = int(end_frame_exclusive)
        if end_exclusive <= start_frame_index:
            raise ValueError("Invalid in/out range")
        if end_exclusive > frame_count:
            raise ValueError("Segment exceeds video length")
        duration_frames = end_exclusive - start_frame_index
        return start_frame_index, end_exclusive, duration_frames
    if duration_seconds is None:
        raise ValueError("Provide durationSeconds or endFrameExclusive")
    duration_frames = int(round(float(fps) * duration_seconds))
    end_exclusive = start_frame_index + duration_frames
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


LUMA_API_ALLOWED_MODES = {
    "adhere_1",
    "adhere_2",
    "adhere_3",
    "flex_1",
    "flex_2",
    "flex_3",
    "reimagine_1",
    "reimagine_2",
    "reimagine_3",
}


VIDEO_API_ALLOWED_MODES: dict[str, set[str]] = {
    "ray-2": set(LUMA_API_ALLOWED_MODES),
    "ray-flash-2": set(LUMA_API_ALLOWED_MODES),
    "runway-gen4.5": {"runway_i2v"},
    "kling-2.6": {"kling_start_only", "kling_start_end"},
    "veo-3.1": {"veo_start_only", "veo_start_end"},
    "veo-3.1-fast": {"veo_start_only", "veo_start_end"},
    "wan2.2-a14b": {"wan_a14b_i2v"},
    "wan2.2-animate": {"wan_animate_replace"},
    "kling-o1": {"kling_o1_video_edit"},
    "kling-v3-omni-video": {"kling_v3_omni_video_edit"},
    "seedance-2.0-reference-to-video": {"seedance_reference_to_video"},
    "wan2.7-videoedit": {"wan27_video_edit"},
}


def _validate_api_video_mode(model: str, mode: str) -> None:
    allowed = VIDEO_API_ALLOWED_MODES.get(model)
    if not allowed:
        raise ValueError(f"Unsupported video model: {model}")
    if mode not in allowed:
        allowed_values = ", ".join(sorted(allowed))
        raise ValueError(f"{_video_model_label(model)} requires one of: {allowed_values}.")


def _decorate_embedded_s3_keys(
    obj: Any,
    asset_store: AssetStore,
    *,
    decorate_plain_key: bool = False,
) -> None:
    if isinstance(obj, dict):
        for key, value in list(obj.items()):
            if isinstance(value, (dict, list)):
                _decorate_embedded_s3_keys(value, asset_store, decorate_plain_key=decorate_plain_key)
            if (key.endswith("Key") or (decorate_plain_key and key == "key")) and isinstance(value, str) and value:
                try:
                    url_field = f"{key[:-3]}Url" if key.endswith("Key") else "url"
                    obj[url_field] = asset_store.presign_get(value, expires=PRESIGNED_GET_TTL_SECONDS)
                except Exception:
                    logger.warning("Failed to presign embedded key", extra={"key": value})
    elif isinstance(obj, list):
        for item in obj:
            _decorate_embedded_s3_keys(item, asset_store, decorate_plain_key=decorate_plain_key)


def _api_asset_paths_for_user(user_id: str) -> ApiAssetPaths:
    return ApiAssetPaths(user_id=user_id)


def _api_asset_prefix(user_id: str) -> str:
    return _api_asset_paths_for_user(user_id).uploads_prefix()


def _api_request_asset_prefix(user_id: str, request_id: str) -> str:
    return _api_asset_paths_for_user(user_id).request_prefix(request_id)


def _validate_api_asset_key(
    *,
    asset_store: AssetStore,
    user_id: str,
    asset_key: str,
    expected_type: str,
) -> dict[str, Any]:
    if not isinstance(asset_key, str) or not asset_key:
        raise ValueError("Asset key is required")
    if not asset_key.startswith(f"{_api_asset_prefix(user_id)}/"):
        raise ValueError("Asset key is outside your API upload path")
    try:
        head = asset_store.head_object(asset_key)
    except ClientError:
        raise ValueError("Asset not found") from None
    content_type = str(head.get("ContentType") or "")
    if expected_type == "image" and not content_type.lower().startswith("image/"):
        raise ValueError(f"Expected image asset, got {content_type or 'unknown content type'}")
    if expected_type == "video" and not content_type.lower().startswith("video/"):
        raise ValueError(f"Expected video asset, got {content_type or 'unknown content type'}")
    return {
        "key": asset_key,
        "contentType": content_type,
        "sizeBytes": int(head.get("ContentLength") or 0),
        "etag": str(head.get("ETag") or "").strip('"'),
        "lastModified": head.get("LastModified").isoformat() if head.get("LastModified") else None,
    }


def _api_request_error_payload(code: str, message: str, *, details: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = {
        "code": code,
        "message": message,
    }
    if details:
        payload["details"] = details
    return payload


def _api_request_response(request_record: dict[str, Any], asset_store: AssetStore, job: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = json.loads(json.dumps(request_record))
    _decorate_embedded_s3_keys(payload, asset_store, decorate_plain_key=True)
    if isinstance(job, dict):
        payload["job"] = job
    return payload


def _cleanup_track_response(track: dict[str, Any], asset_store: AssetStore) -> dict[str, Any]:
    payload = json.loads(json.dumps(track))
    _decorate_embedded_s3_keys(payload, asset_store)
    manifest_key = payload.get("review", {}).get("previewManifestKey") if isinstance(payload.get("review"), dict) else None
    if isinstance(manifest_key, str) and manifest_key:
        try:
            manifest_payload = json.loads(asset_store.read_bytes(manifest_key).decode("utf-8"))
            _decorate_embedded_s3_keys(manifest_payload, asset_store)
            payload.setdefault("review", {})["previewManifest"] = manifest_payload
        except Exception:
            logger.warning("Failed to load cleanup preview manifest", extra={"manifestKey": manifest_key})
    return payload


def _segment_duration_seconds(task: dict[str, Any], segment: dict[str, Any]) -> float:
    fps = _fps(task)
    return (segment["endFrameExclusive"] - segment["startFrame"]) / float(fps)


def _segment_model_limit_error(task: dict[str, Any], segment: dict[str, Any], model: str) -> str | None:
    max_seconds = VIDEO_MODEL_MAX_SECONDS.get(model)
    if max_seconds is None:
        return None
    min_seconds = VIDEO_MODEL_MIN_SECONDS.get(model)
    frame_budget_fps = VIDEO_MODEL_FRAME_BUDGET_FPS.get(model)
    duration_frames = _segment_duration_frames(segment)
    duration_seconds = _segment_duration_seconds(task, segment)
    max_frames = int(round(max_seconds * (frame_budget_fps or float(_fps(task)))))
    over_frames = duration_frames > max_frames
    over_seconds = duration_seconds > float(max_seconds) + 1e-6
    under_seconds = min_seconds is not None and duration_seconds + 1e-6 < float(min_seconds)
    label = _video_model_label(model)
    if under_seconds:
        return f"{label} requires a source segment between {min_seconds}s and {max_seconds}s. Selected segment is {duration_seconds:.2f}s."
    if not over_frames and not over_seconds:
        return None
    if frame_budget_fps is not None and over_frames and abs(float(_fps(task)) - frame_budget_fps) > 1e-3:
        return (
            f"{label} allows up to {max_seconds}s at {frame_budget_fps}fps ({max_frames} frames). "
            f"Selected segment is {duration_frames} frames / {duration_seconds:.2f}s at {_format_fps(_fps(task))}fps, "
            "so it exceeds this model's frame budget."
        )
    return (
        f"{label} allows up to {max_seconds}s. Selected segment is {duration_frames} frames / {duration_seconds:.2f}s, which is over the limit."
    )


def _capture_segment_boundary_frames(
    *,
    task: dict[str, Any],
    segment: dict[str, Any],
    asset_store: AssetStore,
) -> tuple[dict[str, Any], dict[str, Any]]:
    crop = segment.get("crop")
    start_capture = _capture_frame_sync(
        task=task,
        frame_index=int(segment["startFrame"]),
        asset_store=asset_store,
        crop=(crop if isinstance(crop, dict) else None),
    )
    end_capture = _capture_frame_sync(
        task=task,
        frame_index=max(int(segment["startFrame"]), int(segment["endFrameExclusive"]) - 1),
        asset_store=asset_store,
        crop=(crop if isinstance(crop, dict) else None),
    )
    return start_capture, end_capture


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


def _segment_generation_provider_name(model: str) -> str:
    if model == "runway-gen4.5":
        return "runway"
    if model == "kling-2.6":
        return "kling"
    if model in {"veo-3.1", "veo-3.1-fast", "wan2.2-a14b", "wan2.2-animate"}:
        return "runware"
    if model in {"kling-o1", "kling-v3-omni-video", "wan2.7-videoedit"}:
        return "replicate"
    if model == "seedance-2.0-reference-to-video":
        return "fal"
    return "luma"


def _create_segment_record(
    *,
    task: dict[str, Any],
    start: int,
    end_excl: int,
    dur_frames: int,
    asset_store: AssetStore,
) -> dict[str, Any]:
    segment_id = new_id("seg")
    fps = _fps(task)
    segment = {
        "segmentId": segment_id,
        "startFrame": start,
        "endFrameExclusive": end_excl,
        "durationFrames": dur_frames,
        "durationSec": round(dur_frames / float(fps), 3),
        "startTimecode": _timecode(start, fps),
        "endTimecode": _timecode(end_excl, fps),
        "startFrameId": "",
        "endFrameId": "",
        "selectedGenerationId": None,
        "crop": None,
        "segmentClipKey": None,
        "segmentClipUpdatedAt": None,
    }
    start_capture, end_capture = _capture_segment_boundary_frames(task=task, segment=segment, asset_store=asset_store)
    segment["startFrameId"] = start_capture["frameId"]
    segment["endFrameId"] = end_capture["frameId"]
    task.setdefault("segments", []).append(segment)
    return segment


def _queue_segment_generation_record(
    *,
    task: dict[str, Any],
    store: S3JsonStore,
    queue: JobQueue,
    user_id: str,
    task_id: str,
    segment_id: str,
    model: str,
    mode: str,
    prompt: str | None,
    first_frame_variant_id: str | None = None,
    last_frame_variant_id: str | None = None,
    replicate_kling_mode: str | None = None,
    replicate_kling_v3_mode: str | None = None,
    wan27_resolution: str | None = None,
    parent_generation_id: str | None = None,
    extension_metadata: dict[str, Any] | None = None,
) -> tuple[str, str]:
    gen_id = new_id("gen")
    job_id = _queue_job(
        store=store,
        queue=queue,
        user_id=user_id,
        task_id=task_id,
        job_type="segment_generate",
        payload={
            "segmentId": segment_id,
            "genId": gen_id,
            "lumaModel": model,
            "mode": mode,
            "prompt": prompt,
            "firstFrameVariantId": first_frame_variant_id,
            "lastFrameVariantId": last_frame_variant_id,
            "replicateKlingMode": replicate_kling_mode,
            "replicateKlingV3Mode": replicate_kling_v3_mode,
            "wan27Resolution": wan27_resolution,
            "parentGenerationId": parent_generation_id,
            "extensionMetadata": extension_metadata,
        },
    )
    now = now_iso()
    generation_record: dict[str, Any] = {
        "genId": gen_id,
        "segmentId": segment_id,
        "luma": {
            "provider": _segment_generation_provider_name(model),
            "model": model,
            "mode": mode,
            "prompt": prompt,
            "lumaGenerationId": None,
        },
        "status": "queued",
        "outputKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now,
        "createdAt": now,
        "updatedAt": now,
    }
    if parent_generation_id:
        generation_record["parentGenerationId"] = parent_generation_id
    if extension_metadata:
        generation_record["extension"] = extension_metadata
    segment = next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)
    if segment:
        generation_record["segmentCrop"] = segment.get("crop")
    task.setdefault("segmentGenerations", {})[gen_id] = generation_record
    _append_history_event(
        task,
        {
            "at": now,
            "event": "segment_generation.queued",
            "jobId": job_id,
            "genId": gen_id,
            "segmentId": segment_id,
            "model": model,
            "parentGenerationId": parent_generation_id,
        },
    )
    return gen_id, job_id


def _queue_chunk_generation_for_run(
    *,
    task: dict[str, Any],
    store: S3JsonStore,
    queue: JobQueue,
    user_id: str,
    task_id: str,
    run: dict[str, Any],
    chunk: dict[str, Any],
    model: str,
    mode: str,
    prompt: str | None,
    first_frame_variant_id: str | None,
    replicate_kling_mode: str | None,
    replicate_kling_v3_mode: str | None,
    wan27_resolution: str | None,
    parent_generation_id: str | None = None,
    extension_metadata: dict[str, Any] | None = None,
) -> tuple[str, str]:
    gen_id, job_id = _queue_segment_generation_record(
        task=task,
        store=store,
        queue=queue,
        user_id=user_id,
        task_id=task_id,
        segment_id=str(chunk["segmentId"]),
        model=model,
        mode=mode,
        prompt=prompt,
        first_frame_variant_id=first_frame_variant_id,
        last_frame_variant_id=None,
        replicate_kling_mode=replicate_kling_mode,
        replicate_kling_v3_mode=replicate_kling_v3_mode,
        wan27_resolution=wan27_resolution,
        parent_generation_id=parent_generation_id,
        extension_metadata=extension_metadata,
    )
    now = now_iso()
    chunk["generationId"] = gen_id
    chunk["jobId"] = job_id
    chunk["status"] = "queued"
    chunk["reviewStatus"] = "running"
    chunk.pop("error", None)
    chunk["prompt"] = prompt
    chunk["queuedAt"] = now
    chunk["updatedAt"] = now
    run["status"] = "running"
    run["activeChunkIndex"] = int(chunk.get("chunkIndex") or 0)
    run["updatedAt"] = now
    run.pop("pauseRequestedAt", None)
    run.pop("failureChunkIndex", None)
    return gen_id, job_id


def _copy_generated_anchor_to_frame_variant(
    *,
    task: dict[str, Any],
    generation: dict[str, Any],
    target_frame_id: str,
    target_frame_index: int,
    anchor_frames_from_end: int,
    asset_store: AssetStore,
) -> dict[str, Any]:
    output_key = generation.get("outputKey")
    if not output_key:
        raise ValueError("Previous generation does not have an output video")
    s3 = boto3.client("s3")
    paths = _asset_paths_for_task(task)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        local_video = td_path / "previous_generated.mp4"
        local_anchor = td_path / "extension_anchor.png"
        s3.download_file(settings.assets_bucket, output_key, str(local_video))
        probe = ffprobe_video(str(local_video))
        frame_count = int(probe.get("frame_count") or 0)
        if frame_count <= 0:
            duration = float(probe.get("duration_sec") or generation.get("providerDurationSec") or generation.get("requestedDurationSec") or 0.0)
            fps_num = int(probe.get("fps_num") or 24)
            fps_den = int(probe.get("fps_den") or 1)
            frame_count = max(1, int(round(duration * (fps_num / max(1, fps_den)))))
        anchor_frame_index = max(0, frame_count - 1 - int(anchor_frames_from_end))
        extract_frame_png(str(local_video), anchor_frame_index, str(local_anchor))
        variant_id = new_id("var")
        variant_key = paths.frame_variant(target_frame_id, variant_id)
        s3.upload_file(
            str(local_anchor),
            settings.assets_bucket,
            variant_key,
            ExtraArgs={"ContentType": "image/png", "ServerSideEncryption": "AES256"},
        )
        with Image.open(local_anchor) as image:
            width, height = image.size

    frame = task.setdefault("frames", {}).get(target_frame_id)
    if not frame:
        raise ValueError("Alignment frame was not captured")
    now = now_iso()
    variant = {
        "variantId": variant_id,
        "type": "extension_anchor",
        "model": "generated_extension_anchor",
        "prompt": f"Frame {anchor_frame_index} extracted from previous generation {generation.get('genId')}",
        "outputKey": variant_key,
        "createdAt": now,
        "sourceGenerationId": generation.get("genId"),
        "sourceGeneratedFrameIndex": anchor_frame_index,
        "alignedSourceFrameIndex": target_frame_index,
        "width": width,
        "height": height,
        "jobId": None,
        "processingDurationSec": None,
    }
    frame.setdefault("variants", []).append(variant)
    frame["selectedVariantId"] = variant_id
    return variant


def _normalize_patch_rect_for_image(rect: dict[str, Any], image_width: int, image_height: int) -> dict[str, int]:
    safe_width = max(1, int(image_width))
    safe_height = max(1, int(image_height))
    x = max(0, min(int(rect.get("x", 0)), safe_width - 1))
    y = max(0, min(int(rect.get("y", 0)), safe_height - 1))
    width = max(1, min(int(rect.get("width", safe_width)), safe_width - x))
    height = max(1, min(int(rect.get("height", safe_height)), safe_height - y))
    return {"x": x, "y": y, "width": width, "height": height}


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

    if method == "POST" and path == "/api/v1/assets/uploads/init":
        req = _json_model(ApiAssetUploadInitRequest, event)
        normalized_content_type = req.contentType.lower()
        if req.assetType == "image" and not normalized_content_type.startswith("image/"):
            return response(
                400,
                {"error": _api_request_error_payload("validation_error", "Image uploads must use an image content type.")},
                origin=origin,
            )
        if req.assetType == "video" and not normalized_content_type.startswith("video/"):
            return response(
                400,
                {"error": _api_request_error_payload("validation_error", "Video uploads must use a video content type.")},
                origin=origin,
            )
        asset_id = new_id("apiasset")
        asset_key = _api_asset_paths_for_user(user_id).upload_asset(asset_id, req.filename)
        return response(
            200,
            {
                "assetId": asset_id,
                "assetKey": asset_key,
                "uploadUrl": asset_store.presign_put(asset_key, expires=900, content_type=req.contentType),
            },
            origin=origin,
        )

    if method == "GET" and path == "/api/v1/requests":
        requests = store.list_api_requests(user_id)
        query = _extract_query(event)
        status_filter = str(query.get("status") or "").strip().lower()
        workflow_filter = str(query.get("workflow") or "").strip().lower()
        model_filter = str(query.get("model") or "").strip()
        limit_raw = str(query.get("limit") or "").strip()
        limit = max(1, min(200, int(limit_raw))) if limit_raw.isdigit() else 100
        filtered: list[dict[str, Any]] = []
        for item in requests:
            if status_filter and str(item.get("status") or "").lower() != status_filter:
                continue
            if workflow_filter and str(item.get("workflow") or "").lower() != workflow_filter:
                continue
            if model_filter and str(item.get("model") or "") != model_filter:
                continue
            filtered.append(_api_request_response(item, asset_store))
            if len(filtered) >= limit:
                break
        return response(200, {"requests": filtered}, origin=origin)

    if method == "GET" and path.startswith("/api/v1/requests/"):
        request_id_value = path.split("/")[4]
        request_record = store.load_api_request(user_id, request_id_value)
        if not request_record:
            return error_response(404, "API request not found", origin=origin)
        job = None
        job_id = request_record.get("jobId")
        if isinstance(job_id, str) and job_id:
            job = store.load_job(user_id, job_id)
        return response(200, _api_request_response(request_record, asset_store, job=job), origin=origin)

    if method == "POST" and path == "/api/v1/image-edits/full":
        req = _json_model(ApiImageEditFullRequest, event)
        try:
            prompt = _sanitize_prompt(req.prompt)
            input_asset = _validate_api_asset_key(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.inputAssetKey,
                expected_type="image",
            )
        except ValueError as exc:
            return response(400, {"error": _api_request_error_payload("validation_error", str(exc))}, origin=origin)
        request_id_value = new_id("apireq")
        job_id = _queue_job(
            store=store,
            queue=queue,
            user_id=user_id,
            task_id="__api__",
            job_type="api_image_edit_full",
            payload={
                "requestId": request_id_value,
                "model": req.model,
                "prompt": prompt,
                "inputAssetKey": req.inputAssetKey,
            },
            enqueue=False,
        )
        request_record = {
            "requestId": request_id_value,
            "userId": user_id,
            "workflow": "image_edit_full",
            "model": req.model,
            "provider": "openai" if req.model in {"chatgpt", "chatgpt_latest"} else "gemini",
            "status": "queued",
            "jobId": job_id,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "request": {
                "prompt": prompt,
            },
            "inputAssets": {
                "input": input_asset,
            },
            "preparedAssets": {},
            "outputAssets": {},
            "warnings": [],
            "error": None,
        }
        store.save_api_request(request_record)
        queue.enqueue({"jobId": job_id, "taskId": "__api__", "userId": user_id})
        return response(202, {"requestId": request_id_value, "jobId": job_id}, origin=origin)

    if method == "POST" and path == "/api/v1/image-edits/patch":
        req = _json_model(ApiImageEditPatchRequest, event)
        try:
            prompt = _sanitize_prompt(req.prompt)
            input_asset = _validate_api_asset_key(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.inputAssetKey,
                expected_type="image",
            )
            patch_asset = _validate_api_asset_key(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.patchAssetKey,
                expected_type="image",
            )
            mask_asset = (
                _validate_api_asset_key(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=req.maskAssetKey,
                    expected_type="image",
                )
                if req.maskAssetKey
                else None
            )
            reference_asset = (
                _validate_api_asset_key(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=req.referenceAssetKey,
                    expected_type="image",
                )
                if req.referenceAssetKey
                else None
            )
            if req.model == "runware_ace_pp" and not reference_asset:
                raise ValueError("Runware ACE++ requires a reference image")
        except ValueError as exc:
            return response(400, {"error": _api_request_error_payload("validation_error", str(exc))}, origin=origin)
        request_id_value = new_id("apireq")
        job_id = _queue_job(
            store=store,
            queue=queue,
            user_id=user_id,
            task_id="__api__",
            job_type="api_image_edit_patch",
            payload={
                "requestId": request_id_value,
                "model": req.model,
                "prompt": prompt,
                "inputAssetKey": req.inputAssetKey,
                "patchAssetKey": req.patchAssetKey,
                "maskAssetKey": req.maskAssetKey,
                "referenceAssetKey": req.referenceAssetKey,
                "patchRect": req.patchRect.model_dump(),
                "featherPx": req.featherPx,
                "bleedPx": req.bleedPx,
                "runwareRepaintingScale": req.runwareRepaintingScale,
                "edgeAwareRefine": req.edgeAwareRefine,
                "edgeAwareStrength": req.edgeAwareStrength,
                "edgeAwareRadiusPx": req.edgeAwareRadiusPx,
                "maskGrowPx": req.maskGrowPx,
            },
            enqueue=False,
        )
        request_record = {
            "requestId": request_id_value,
            "userId": user_id,
            "workflow": "image_edit_patch",
            "model": req.model,
            "provider": "runware" if req.model.startswith("runware_") else ("openai" if req.model in {"chatgpt", "chatgpt_latest"} else "gemini"),
            "status": "queued",
            "jobId": job_id,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "request": {
                "prompt": prompt,
                "patchRect": req.patchRect.model_dump(),
                "featherPx": req.featherPx,
                "bleedPx": req.bleedPx,
                "edgeAwareRefine": req.edgeAwareRefine,
                "edgeAwareStrength": req.edgeAwareStrength,
                "edgeAwareRadiusPx": req.edgeAwareRadiusPx,
                "maskGrowPx": req.maskGrowPx,
                "runwareRepaintingScale": req.runwareRepaintingScale,
            },
            "inputAssets": {
                "input": input_asset,
                "patch": patch_asset,
                "mask": mask_asset,
                "reference": reference_asset,
            },
            "preparedAssets": {},
            "outputAssets": {},
            "warnings": [],
            "error": None,
        }
        store.save_api_request(request_record)
        queue.enqueue({"jobId": job_id, "taskId": "__api__", "userId": user_id})
        return response(202, {"requestId": request_id_value, "jobId": job_id}, origin=origin)

    if method == "POST" and path == "/api/v1/video-generations/reference-video":
        req = _json_model(ApiReferenceVideoGenerateRequest, event)
        try:
            prompt = _sanitize_prompt(req.prompt) if req.prompt else None
            _validate_api_video_mode(req.model, req.mode)
            video_asset = _validate_api_asset_key(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.videoAssetKey,
                expected_type="video",
            )
            first_frame_asset = _validate_api_asset_key(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.firstFrameAssetKey,
                expected_type="image",
            )
            last_frame_asset = (
                _validate_api_asset_key(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=req.lastFrameAssetKey,
                    expected_type="image",
                )
                if req.lastFrameAssetKey
                else None
            )
            if req.model == "seedance-2.0-reference-to-video" and prompt:
                missing_refs: list[str] = []
                if "@Video1" not in prompt:
                    missing_refs.append("@Video1")
                if "@Image1" not in prompt:
                    missing_refs.append("@Image1")
                if missing_refs:
                    raise ValueError(f"{_video_model_label(req.model)} prompt must reference {' and '.join(missing_refs)}.")
        except ValueError as exc:
            return response(400, {"error": _api_request_error_payload("validation_error", str(exc))}, origin=origin)
        request_id_value = new_id("apireq")
        job_id = _queue_job(
            store=store,
            queue=queue,
            user_id=user_id,
            task_id="__api__",
            job_type="api_video_generate_reference",
            payload={
                "requestId": request_id_value,
                "model": req.model,
                "mode": req.mode,
                "prompt": prompt,
                "videoAssetKey": req.videoAssetKey,
                "firstFrameAssetKey": req.firstFrameAssetKey,
                "lastFrameAssetKey": req.lastFrameAssetKey,
                "replicateKlingMode": req.replicateKlingMode,
                "replicateKlingV3Mode": req.replicateKlingV3Mode,
                "wan27Resolution": req.wan27Resolution,
            },
            enqueue=False,
        )
        request_record = {
            "requestId": request_id_value,
            "userId": user_id,
            "workflow": "video_generation_reference",
            "model": req.model,
            "provider": _segment_generation_provider_name(req.model),
            "status": "queued",
            "jobId": job_id,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "request": {
                "mode": req.mode,
                "prompt": prompt,
                "replicateKlingMode": req.replicateKlingMode,
                "replicateKlingV3Mode": req.replicateKlingV3Mode,
                "wan27Resolution": req.wan27Resolution,
            },
            "inputAssets": {
                "video": video_asset,
                "firstFrame": first_frame_asset,
                "lastFrame": last_frame_asset,
            },
            "preparedAssets": {},
            "outputAssets": {},
            "warnings": [],
            "error": None,
        }
        store.save_api_request(request_record)
        queue.enqueue({"jobId": job_id, "taskId": "__api__", "userId": user_id})
        return response(202, {"requestId": request_id_value, "jobId": job_id}, origin=origin)

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
            "chunkedGenerationRuns": [],
            "externalQcPairs": [],
            "qualityMatchAnalyses": {},
            "videoCleanupTracks": [],
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
            changed = _reconcile_segment_generation_job_states(item, store)
            changed = _prune_stale_segment_generations(item, store) or changed
            changed = _backfill_segment_generation_preview_refs(item) or changed
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
        changed = _reconcile_segment_generation_job_states(task, store)
        changed = _prune_stale_segment_generations(task, store) or changed
        changed = _backfill_segment_generation_preview_refs(task) or changed
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
        for segment in decorated.get("segments", []):
            clip_key = segment.get("segmentClipKey")
            if clip_key:
                segment["segmentClipUrl"] = asset_store.presign_get(clip_key, expires=PRESIGNED_GET_TTL_SECONDS)
        if decorated.get("qualityMatchAnalyses"):
            _decorate_embedded_s3_keys(decorated["qualityMatchAnalyses"], asset_store)
        if decorated.get("videoCleanupTracks"):
            _decorate_embedded_s3_keys(decorated["videoCleanupTracks"], asset_store)
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
        if decorated.get("chunkedGenerationRuns"):
            _decorate_embedded_s3_keys(decorated["chunkedGenerationRuns"], asset_store)
        for pair in decorated.get("externalQcPairs", []):
            if pair.get("originalKey"):
                pair["originalUrl"] = asset_store.presign_get(pair["originalKey"], expires=PRESIGNED_GET_TTL_SECONDS)
            if pair.get("editedKey"):
                pair["editedUrl"] = asset_store.presign_get(pair["editedKey"], expires=PRESIGNED_GET_TTL_SECONDS)
        for export in decorated.get("exports", []):
            output_key = export.get("outputKey")
            if output_key:
                export["downloadUrl"] = asset_store.presign_get(output_key, expires=PRESIGNED_GET_TTL_SECONDS)
            motion_qc = export.get("motionSyncQc")
            if isinstance(motion_qc, dict):
                _decorate_embedded_s3_keys(motion_qc, asset_store)
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

        if method == "POST" and len(parts) == 5 and parts[2] == "external-qc" and parts[3] == "pairs" and parts[4] == "uploads":
            req = _json_model(ExternalQcPairUploadRequest, event)
            original_is_image = req.originalContentType.startswith("image/")
            edited_is_image = req.editedContentType.startswith("image/")
            original_is_video = req.originalContentType.startswith("video/")
            edited_is_video = req.editedContentType.startswith("video/")
            if (original_is_image and edited_is_image):
                media_type = "image"
            elif (original_is_video and edited_is_video):
                media_type = "video"
            else:
                return error_response(400, "External QC inputs must both be images or both be videos", origin=origin)
            paths = _asset_paths_for_task(task)
            pair_id = new_id("extqc")
            original_key = paths.external_qc_original(pair_id, req.originalFilename)
            edited_key = paths.external_qc_edited(pair_id, req.editedFilename)
            now = now_iso()
            pair = {
                "pairId": pair_id,
                "originalFilename": req.originalFilename,
                "editedFilename": req.editedFilename,
                "originalContentType": req.originalContentType,
                "editedContentType": req.editedContentType,
                "mediaType": media_type,
                "originalKey": original_key,
                "editedKey": edited_key,
                "createdAt": now,
                "updatedAt": now,
            }
            task.setdefault("externalQcPairs", []).append(pair)
            store.save_task(task)
            return response(
                201,
                {
                    "pairId": pair_id,
                    "originalUploadUrl": asset_store.presign_put(original_key, expires=900, content_type=req.originalContentType),
                    "editedUploadUrl": asset_store.presign_put(edited_key, expires=900, content_type=req.editedContentType),
                    "pair": {
                        **pair,
                        "originalUrl": asset_store.presign_get(original_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "editedUrl": asset_store.presign_get(edited_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    },
                },
                origin=origin,
            )

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

        if method == "GET" and len(parts) == 4 and parts[2] == "cleanup-tracks":
            track_id = parts[3]
            track = get_cleanup_track(task, track_id)
            if not isinstance(track, dict):
                return error_response(404, "Cleanup track not found", origin=origin)
            return response(200, {"track": _cleanup_track_response(track, asset_store)}, origin=origin)

        if method == "POST" and len(parts) == 6 and parts[2] == "cleanup-tracks" and parts[4] == "keyframes" and parts[5] == "upload-init":
            track_id = parts[3]
            track = get_cleanup_track(task, track_id)
            if not isinstance(track, dict):
                return error_response(404, "Cleanup track not found", origin=origin)
            req = _json_model(VideoCleanupKeyframeUploadInitRequest, event)
            if not req.contentType.lower().startswith("image/"):
                return error_response(400, "Cleanup keyframe masks must be image uploads", origin=origin)
            if req.frameIndexLocal >= int(track.get("source", {}).get("frameCount") or 0):
                return error_response(400, "Frame index is outside cleanup track bounds", origin=origin)
            paths = _asset_paths_for_task(task)
            upload_key = paths.cleanup_track_keyframe_mask(track_id, req.frameIndexLocal)
            return response(
                200,
                {
                    "uploadKey": upload_key,
                    "uploadUrl": asset_store.presign_put(upload_key, expires=900, content_type=req.contentType),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "cleanup-tracks" and parts[4] == "keyframes" and parts[5] == "complete":
            track_id = parts[3]
            track = get_cleanup_track(task, track_id)
            if not isinstance(track, dict):
                return error_response(404, "Cleanup track not found", origin=origin)
            req = _json_model(VideoCleanupKeyframeUploadCompleteRequest, event)
            if req.frameIndexLocal >= int(track.get("source", {}).get("frameCount") or 0):
                return error_response(400, "Frame index is outside cleanup track bounds", origin=origin)
            expected_key = _asset_paths_for_task(task).cleanup_track_keyframe_mask(track_id, req.frameIndexLocal)
            if req.uploadKey != expected_key:
                return error_response(400, "Upload key does not match the cleanup track keyframe location", origin=origin)
            try:
                asset_store.head_object(req.uploadKey)
            except ClientError:
                return error_response(404, "Uploaded keyframe mask not found", origin=origin)
            keyframe_id = new_id("kf")
            track["status"] = "tracking"
            track.pop("error", None)
            track["updatedAt"] = now_iso()
            store.save_task(task)
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="video_cleanup_retrack_window",
                payload={
                    "trackId": track_id,
                    "frameIndexLocal": req.frameIndexLocal,
                    "uploadKey": req.uploadKey,
                    "propagationMode": req.propagationMode,
                    "keyframeId": keyframe_id,
                },
            )
            return response(202, {"jobId": job_id, "keyframeId": keyframe_id}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "cleanup-tracks" and parts[4] == "sam-assist":
            track_id = parts[3]
            track = get_cleanup_track(task, track_id)
            if not isinstance(track, dict):
                return error_response(404, "Cleanup track not found", origin=origin)
            req = _json_model(VideoCleanupSamAssistRequest, event)
            cleanup_prefix = f"{_asset_paths_for_task(task).cleanup_track_prefix(track_id)}/"
            if req.existingMaskKey and not str(req.existingMaskKey).startswith(cleanup_prefix):
                return error_response(400, "existingMaskKey is outside this cleanup track", origin=origin)
            if req.frameIndexLocal >= int(track.get("source", {}).get("frameCount") or 0):
                return error_response(400, "Frame index is outside cleanup track bounds", origin=origin)
            track["status"] = "tracking"
            track.pop("error", None)
            track["updatedAt"] = now_iso()
            store.save_task(task)
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="video_cleanup_retrack_window",
                payload={
                    "trackId": track_id,
                    "frameIndexLocal": req.frameIndexLocal,
                    "positivePoints": [point.model_dump() for point in req.positivePoints],
                    "negativePoints": [point.model_dump() for point in req.negativePoints],
                    "box": (
                        {
                            "x": req.box.x,
                            "y": req.box.y,
                            "w": req.box.width,
                            "h": req.box.height,
                        }
                        if req.box
                        else None
                    ),
                    "existingMaskKey": req.existingMaskKey,
                    "restrictToMaskBounds": req.restrictToMaskBounds,
                    "edgeBias": req.edgeBias,
                    "propagationMode": req.propagationMode,
                },
            )
            return response(202, {"jobId": job_id, "genId": gen_id}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "cleanup-tracks" and parts[4] == "preview":
            track_id = parts[3]
            track = get_cleanup_track(task, track_id)
            if not isinstance(track, dict):
                return error_response(404, "Cleanup track not found", origin=origin)
            req = _json_model(VideoCleanupPreviewRequest, event)
            settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else track.get("settings")
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="video_cleanup_preview",
                payload={"trackId": track_id, "settings": settings_payload},
            )
            return response(202, {"jobId": job_id, "genId": gen_id}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "cleanup-tracks" and parts[4] == "apply":
            track_id = parts[3]
            track = get_cleanup_track(task, track_id)
            if not isinstance(track, dict):
                return error_response(404, "Cleanup track not found", origin=origin)
            req = _json_model(VideoCleanupApplyRequest, event)
            settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else track.get("settings")
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="video_cleanup_apply",
                payload={
                    "trackId": track_id,
                    "settings": settings_payload,
                    "createSegmentGenerationVariant": bool(req.createSegmentGenerationVariant),
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 7 and parts[2] == "segments" and parts[4] == "generations" and parts[6] == "cleanup-tracks":
            segment_id = parts[3]
            generation_id = parts[5]
            segment = next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)
            generation = task.get("segmentGenerations", {}).get(generation_id)
            if not isinstance(segment, dict) or not isinstance(generation, dict):
                return error_response(404, "Segment or generation not found", origin=origin)
            if generation.get("segmentId") != segment_id:
                return error_response(400, "Generation does not belong to this segment", origin=origin)
            if generation.get("status") != "complete":
                return error_response(400, "Cleanup tracks require a completed generation", origin=origin)
            provider = generation.get("luma", {}).get("provider") if isinstance(generation.get("luma"), dict) else None
            if provider != "luma":
                return error_response(400, "Cleanup tracks are only supported for Luma generations", origin=origin)
            req = _json_model(VideoCleanupCreateRequest, event)
            analysis = (task.get("qualityMatchAnalyses") or {}).get(req.firstMaskSource.analysisId)
            if not isinstance(analysis, dict):
                return error_response(404, "Quality Match analysis not found", origin=origin)
            if analysis.get("frameId") != segment.get("startFrameId"):
                return error_response(400, "Cleanup seed analysis must belong to the segment start frame", origin=origin)
            first_mask_key = resolve_first_mask_key_from_analysis(analysis)
            if not first_mask_key:
                return error_response(400, "Selected Quality Match analysis does not expose a keep mask", origin=origin)
            settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else None
            cleanup_settings = VideoCleanupSettings.from_payload(settings_payload)
            track_id = new_id("trk")
            crop = segment.get("crop") if isinstance(segment.get("crop"), dict) else None
            width = int(crop.get("outputWidth")) if isinstance(crop, dict) and crop.get("outputWidth") else int(task.get("video", {}).get("editSource", {}).get("width") or 0)
            height = int(crop.get("outputHeight")) if isinstance(crop, dict) and crop.get("outputHeight") else int(task.get("video", {}).get("editSource", {}).get("height") or 0)
            frame_count = max(1, int(segment.get("durationFrames") or 1))
            track_record = {
                "trackId": track_id,
                "taskId": task_id,
                "segmentId": segment_id,
                "generationId": generation_id,
                "status": "created",
                "source": {
                    "editSourceKey": segment.get("segmentClipKey") or task.get("video", {}).get("editSource", {}).get("s3Key"),
                    "generatedSegmentKey": generation.get("outputKey"),
                    "startFrameIndex": int(segment.get("startFrame") or 0),
                    "endFrameExclusive": int(segment.get("endFrameExclusive") or 0),
                    "fpsNum": int(task.get("video", {}).get("editSource", {}).get("fps", {}).get("num") or 30),
                    "fpsDen": int(task.get("video", {}).get("editSource", {}).get("fps", {}).get("den") or 1),
                    "width": width,
                    "height": height,
                    "frameCount": frame_count,
                },
                "seed": {
                    "firstFrameIndexLocal": 0,
                    "firstMaskKey": first_mask_key,
                    "sourceFrameVariantId": generation.get("sourceFirstFrameVariantId"),
                    "generatedFirstFrameVariantId": None,
                    "firstMaskSource": {
                        "type": req.firstMaskSource.type,
                        "analysisId": req.firstMaskSource.analysisId,
                    },
                },
                "settings": cleanup_settings.to_dict(),
                "tracking": {
                    "samProvider": "fal_sam2",
                    "propagationRuns": [],
                    "keyframes": [],
                },
                "review": {
                    "approved": False,
                },
                "apply": {},
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
            add_or_replace_keyframe(track=track_record, frame_index_local=0, mask_key=first_mask_key, source="seed_first")
            task.setdefault("videoCleanupTracks", []).append(track_record)
            store.save_task(task)
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="video_cleanup_init",
                payload={
                    "trackId": track_id,
                    "segmentId": segment_id,
                    "generationId": generation_id,
                    "firstMaskSourceKey": first_mask_key,
                    "firstMaskAnalysisId": req.firstMaskSource.analysisId,
                    "settings": cleanup_settings.to_dict(),
                },
            )
            return response(201, {"trackId": track_id, "jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "reports":
            req = _json_model(CustomReportCreateRequest, event)
            raw_refs = [item.model_dump(exclude_none=True) for item in req.outputRefs]
            asset_refs = _normalize_custom_report_refs(task, raw_refs)
            if not asset_refs:
                return error_response(400, "No valid report outputs selected", origin=origin)
            if req.reportType == "video_compare":
                generation_refs = [item for item in asset_refs if item.get("assetType") == "segment_generation"]
                if len(generation_refs) < 2:
                    return error_response(400, "Select at least two generated videos for a comparison report", origin=origin)
                segment_keys: set[tuple[str, int]] = set()
                for ref in generation_refs:
                    generation = task.get("segmentGenerations", {}).get(ref.get("genId"))
                    segment = (
                        next((item for item in task.get("segments", []) if item.get("segmentId") == generation.get("segmentId")), None)
                        if isinstance(generation, dict)
                        else None
                    )
                    if not isinstance(generation, dict) or generation.get("status") != "complete" or not generation.get("outputKey"):
                        return error_response(400, "Comparison reports can only include completed generated videos", origin=origin)
                    if not isinstance(segment, dict):
                        return error_response(400, "Selected generated videos must be linked to a segment", origin=origin)
                    segment_keys.add((str(segment.get("segmentId")), int(segment.get("startFrame") or 0)))
                if len(segment_keys) != 1:
                    return error_response(400, "Select generated videos from the same segment/start frame for this comparison report", origin=origin)
            tests = _normalize_custom_report_tests(req.reportType, req.tests)
            if not tests:
                return error_response(400, "No valid QC tests selected", origin=origin)
            custom_reports = task.setdefault("customReports", [])
            report_type_label = "QC Frame" if req.reportType == "qc_frame" else "Video Compare" if req.reportType == "video_compare" else "QC Video"
            report_name = (req.name or "").strip()
            if not report_name:
                report_name = f"{report_type_label} Report {len(custom_reports) + 1}"
            now = now_iso()
            report_id = new_id("report")
            result_key = S3JsonStore.report_result_key(user_id, task_id, report_id)
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="qc_report_build",
                payload={"reportId": report_id},
            )
            report = {
                "reportId": report_id,
                "reportType": req.reportType,
                "name": report_name[:80],
                "assetRefs": asset_refs,
                "tests": tests,
                "status": "queued",
                "jobId": job_id,
                "resultKey": result_key,
                "createdAt": now,
                "updatedAt": now,
            }
            custom_reports.append(report)
            _cleanup_custom_reports(task)
            store.save_task(task)
            return response(201, {"reportId": report["reportId"], "report": report, "jobId": job_id}, origin=origin)

        if method == "GET" and len(parts) == 4 and parts[2] == "reports":
            report_id = parts[3]
            reports = task.get("customReports", [])
            report = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
            if not report:
                return error_response(404, "Report not found", origin=origin)
            result_key = report.get("resultKey")
            payload: dict[str, Any] = {"report": report}
            if isinstance(result_key, str) and result_key:
                result_payload = store.get_json(result_key)
                if isinstance(result_payload, dict):
                    _decorate_embedded_s3_keys(result_payload, asset_store)
                    payload["result"] = result_payload
            return response(200, payload, origin=origin)

        if method == "DELETE" and len(parts) == 4 and parts[2] == "reports":
            report_id = parts[3]
            reports = task.get("customReports", [])
            if not isinstance(reports, list):
                return error_response(404, "Report not found", origin=origin)
            report = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
            before = len(reports)
            removed_report = report if isinstance(report, dict) else None
            task["customReports"] = [
                report
                for report in reports
                if not (isinstance(report, dict) and report.get("reportId") == report_id)
            ]
            if len(task["customReports"]) == before:
                return error_response(404, "Report not found", origin=origin)
            result_key = report.get("resultKey") if isinstance(report, dict) else None
            if isinstance(result_key, str) and result_key:
                try:
                    store.delete_json(result_key)
                except Exception:
                    logger.warning("Failed to delete report result", extra={"reportId": report_id, "resultKey": result_key})
            removed_external_pair_ids = {
                str(asset_ref.get("pairId") or "")
                for asset_ref in (removed_report.get("assetRefs") or [])
                if isinstance(asset_ref, dict) and asset_ref.get("assetType") == "external_frame_pair" and asset_ref.get("pairId")
            } if isinstance(removed_report, dict) else set()
            if removed_external_pair_ids:
                remaining_pair_ids = {
                    str(asset_ref.get("pairId") or "")
                    for report_item in task["customReports"]
                    if isinstance(report_item, dict)
                    for asset_ref in (report_item.get("assetRefs") or [])
                    if isinstance(asset_ref, dict) and asset_ref.get("assetType") == "external_frame_pair" and asset_ref.get("pairId")
                }
                keep_ids = remaining_pair_ids & removed_external_pair_ids
                if keep_ids != removed_external_pair_ids:
                    kept_pairs: list[dict[str, Any]] = []
                    for pair in task.get("externalQcPairs", []):
                        if not isinstance(pair, dict):
                            continue
                        pair_id = str(pair.get("pairId") or "")
                        if pair_id not in removed_external_pair_ids or pair_id in keep_ids:
                            kept_pairs.append(pair)
                            continue
                        for key_name in ("originalKey", "editedKey"):
                            key_value = pair.get(key_name)
                            if isinstance(key_value, str) and key_value:
                                try:
                                    asset_store.delete_object(key_value)
                                except Exception:
                                    logger.warning("Failed to delete external QC asset", extra={"taskId": task_id, "pairId": pair_id, "key": key_value})
                    task["externalQcPairs"] = kept_pairs
            store.save_task(task)
            return response(200, {"ok": True}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "exports" and parts[4] == "motion-qc":
            export_id = parts[3]
            exports = task.get("exports", [])
            export_item = next((entry for entry in exports if entry.get("exportId") == export_id), None)
            if not export_item:
                return error_response(404, "Export not found", origin=origin)
            if not export_item.get("outputKey"):
                return error_response(400, "Export output unavailable", origin=origin)
            req = _json_model(MotionSyncQcRunRequest, event)
            motion_qc = export_item.get("motionSyncQc") if isinstance(export_item.get("motionSyncQc"), dict) else {}
            existing_job_id = motion_qc.get("jobId")
            if (
                not req.force
                and isinstance(existing_job_id, str)
                and motion_qc.get("status") in {"queued", "running"}
            ):
                return response(202, {"jobId": existing_job_id, "alreadyRunning": True}, origin=origin)

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="motion_sync_qc",
                payload={"exportId": export_id, "force": req.force},
            )
            export_item["motionSyncQc"] = {
                "status": "queued",
                "updatedAt": now_iso(),
                "jobId": job_id,
            }
            store.save_task(task)
            return response(202, {"jobId": job_id}, origin=origin)

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
                start, end_excl, dur_frames = _resolve_segment_frames(
                    task,
                    req.startFrameIndex,
                    duration_seconds=req.durationSeconds,
                    end_frame_exclusive=req.endFrameExclusive,
                )
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)

            segment_id = new_id("seg")
            fps = _fps(task)
            segment = {
                "segmentId": segment_id,
                "startFrame": start,
                "endFrameExclusive": end_excl,
                "durationFrames": dur_frames,
                "durationSec": round(dur_frames / float(fps), 3),
                "startTimecode": _timecode(start, fps),
                "endTimecode": _timecode(end_excl, fps),
                "startFrameId": "",
                "endFrameId": "",
                "selectedGenerationId": None,
                "crop": None,
                "segmentClipKey": None,
                "segmentClipUpdatedAt": None,
            }
            start_capture, end_capture = _capture_segment_boundary_frames(task=task, segment=segment, asset_store=asset_store)
            segment["startFrameId"] = start_capture["frameId"]
            segment["endFrameId"] = end_capture["frameId"]
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
            raw_body = parse_json_body(event) or {}
            crop_field_present = isinstance(raw_body, dict) and "crop" in raw_body
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
            previous_crop_signature = _segment_crop_signature(segment.get("crop"))
            crop_changed = False

            segment["startFrame"] = start_frame
            segment["endFrameExclusive"] = end_exclusive
            segment["durationFrames"] = duration_frames
            segment["durationSec"] = round(duration_seconds, 3)
            segment["startTimecode"] = _timecode(start_frame, fps)
            segment["endTimecode"] = _timecode(end_exclusive, fps)
            if crop_field_present:
                if raw_body.get("crop") is None:
                    segment["crop"] = None
                else:
                    if req.crop is None:
                        return error_response(400, "Invalid crop payload", origin=origin)
                    try:
                        normalized_crop = _normalize_segment_crop(task, req.crop.model_dump())
                    except ValueError as exc:
                        return error_response(400, str(exc), origin=origin)
                    segment["crop"] = normalized_crop if normalized_crop and normalized_crop.get("enabled") else None
                segment["cropUpdatedAt"] = now_iso()
                crop_changed = previous_crop_signature != _segment_crop_signature(segment.get("crop"))
            elif "crop" not in segment:
                segment["crop"] = None

            range_changed = (
                req.startFrameIndex is not None
                or req.endFrameExclusive is not None
                or not segment.get("startFrameId")
                or not segment.get("endFrameId")
            )
            if range_changed or crop_changed:
                start_capture, end_capture = _capture_segment_boundary_frames(task=task, segment=segment, asset_store=asset_store)
                segment["startFrameId"] = start_capture["frameId"]
                segment["endFrameId"] = end_capture["frameId"]
                segment["segmentClipKey"] = None
                segment["segmentClipUpdatedAt"] = None
                segment["selectedGenerationId"] = None

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

            artifact_run_id = new_id("qma")[-8:]
            aligned_key = paths.quality_match_artifact(frame_id, analysis_id, f"aligned_generated_{artifact_run_id}", ".png")
            heatmap_key = paths.quality_match_artifact(frame_id, analysis_id, f"diff_heatmap_{artifact_run_id}", ".png")
            binary_key = paths.quality_match_artifact(frame_id, analysis_id, f"binary_change_mask_{artifact_run_id}", ".png")
            proposed_mask_key = paths.quality_match_artifact(frame_id, analysis_id, f"proposed_merge_mask_{artifact_run_id}", ".png")
            restoration_key = paths.quality_match_artifact(frame_id, analysis_id, f"restoration_map_{artifact_run_id}", ".png")
            preview_key = paths.quality_match_artifact(frame_id, analysis_id, f"quality_match_preview_{artifact_run_id}", ".png")
            report_key = paths.quality_match_artifact(frame_id, analysis_id, f"quality_match_report_{artifact_run_id}", ".json")

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
                        "originalMaskUri": asset_store.presign_get(original_mask_key, expires=PRESIGNED_GET_TTL_SECONDS)
                        if isinstance(original_mask_key, str) and original_mask_key
                        else None,
                    },
                    "metrics": analysis["metrics"],
                    "warnings": analysis["warnings"],
                    "settings": analysis["settings"],
                    "alreadyQualityMatched": bool(frame.get("qualityMatched") or (frame.get("qualityMatchStatus") or {}).get("qualityMatched")),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "quality-match" and parts[5] == "preview":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(QualityMatchPreviewRequest, event)
            analysis = (task.get("qualityMatchAnalyses") or {}).get(req.analysisId)
            if not isinstance(analysis, dict):
                return error_response(404, "Quality Match analysis not found", origin=origin)
            if analysis.get("frameId") != frame_id:
                return error_response(400, "Quality Match analysis does not belong to this frame", origin=origin)

            paths = _asset_paths_for_task(task)
            task_prefix = f"{paths.task_prefix()}/frames/{frame_id}/quality_match/"
            if not str(req.maskKey).startswith(task_prefix):
                return error_response(400, "Mask key is outside this frame quality-match path", origin=origin)

            settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else analysis.get("settings")
            qm_settings = QualityMatchSettings.from_payload(settings_payload)
            variant_id = analysis.get("variantId")
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == variant_id), None)
            if not isinstance(variant, dict):
                return error_response(404, "Variant not found for analysis", origin=origin)

            original_bytes = asset_store.read_bytes(frame["captureKey"])
            final_mask_bytes = asset_store.read_bytes(req.maskKey)
            patch_meta = variant.get("patchMeta") if isinstance(variant.get("patchMeta"), dict) else {}
            original_mask_key = patch_meta.get("maskKey") if isinstance(patch_meta, dict) else None
            original_mask_bytes = asset_store.read_bytes(original_mask_key) if isinstance(original_mask_key, str) and original_mask_key else None
            artifacts_meta = analysis.get("artifacts") if isinstance(analysis.get("artifacts"), dict) else {}
            aligned_generated_key = artifacts_meta.get("alignedGeneratedKey")
            aligned_generated_bytes = asset_store.read_bytes(aligned_generated_key) if isinstance(aligned_generated_key, str) and aligned_generated_key else None
            generated_bytes = None if aligned_generated_bytes is not None else asset_store.read_bytes(variant["outputKey"])

            preview_result = preview_quality_match_from_mask(
                original_bytes=original_bytes,
                final_mask_bytes=final_mask_bytes,
                settings=qm_settings,
                aligned_generated_bytes=aligned_generated_bytes,
                generated_bytes=generated_bytes,
                original_mask_bytes=original_mask_bytes,
            )

            preview_run_id = new_id("qmp")[-8:]
            preview_key = paths.quality_match_artifact(frame_id, req.analysisId, f"quality_match_preview_{preview_run_id}", ".png")
            asset_store.put_bytes(preview_key, preview_result["artifacts"]["preview"], content_type="image/png")

            analysis["updatedAt"] = now_iso()
            analysis["settings"] = qm_settings.to_dict()
            analysis.setdefault("artifacts", {})["previewKey"] = preview_key
            if isinstance(analysis.get("metrics"), dict):
                analysis["metrics"].update(preview_result["metricsPreview"])
            else:
                analysis["metrics"] = dict(preview_result["metricsPreview"])
            preview_history = analysis.setdefault("previewHistory", [])
            if isinstance(preview_history, list):
                preview_history.append(
                    {
                        "at": now_iso(),
                        "maskKey": req.maskKey,
                        "settings": qm_settings.to_dict(),
                    }
                )
            store.save_task(task)
            return response(
                200,
                {
                    "analysisId": req.analysisId,
                    "artifacts": {
                        "previewUri": asset_store.presign_get(preview_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    },
                    "metrics": preview_result["metricsPreview"],
                    "warnings": preview_result["warnings"],
                    "settings": qm_settings.to_dict(),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "quality-match" and parts[5] == "sam":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(QualityMatchSamRequest, event)
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == req.variantId), None)
            if not variant:
                return error_response(404, "Variant not found", origin=origin)
            analysis_id = req.analysisId or new_id("qmsam")
            paths = _asset_paths_for_task(task)
            task_prefix = f"{paths.task_prefix()}/frames/{frame_id}/quality_match/"
            if req.existingMaskKey and not str(req.existingMaskKey).startswith(task_prefix):
                return error_response(400, "Mask key is outside this frame quality-match path", origin=origin)
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="quality_match_sam",
                payload={
                    "frameId": frame_id,
                    "variantId": req.variantId,
                    "analysisId": analysis_id,
                    "promptType": req.promptType,
                    "positivePoints": [point.model_dump() for point in req.positivePoints],
                    "negativePoints": [point.model_dump() for point in req.negativePoints],
                    "box": req.box.model_dump() if req.box else None,
                    "restrictToMaskBounds": req.restrictToMaskBounds,
                    "existingMaskKey": req.existingMaskKey,
                    "edgeBias": req.edgeBias,
                },
            )
            return response(202, {"jobId": job_id, "analysisId": analysis_id}, origin=origin)

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
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="quality_match_apply",
                payload={
                    "frameId": frame_id,
                    "analysisId": req.analysisId,
                    "finalMaskKey": final_mask_key,
                    "settings": settings_payload,
                    "overwriteGeneratedFrame": bool(req.overwriteGeneratedFrame),
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "manual-refine" and parts[5] == "export":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ManualRefineExportRequest, event)
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == req.sourceVariantId), None)
            if not isinstance(variant, dict):
                return error_response(404, "Source variant not found", origin=origin)

            paths = _asset_paths_for_task(task)
            if req.format == "png_zip":
                from src.refine_export.psd_export import create_manual_refine_png_zip_for_variant

                export_bytes, export_meta = create_manual_refine_png_zip_for_variant(
                    asset_store=asset_store,
                    frame=frame,
                    variant=variant,
                )
                export_key = paths.manual_refine_export(frame_id, req.sourceVariantId, new_id("mrexp"), ".zip")
                content_type = "application/zip"
                filename = f"{task.get('name', 'task')}_{frame.get('frameIndex', 0)}_{req.sourceVariantId[-6:]}_manual_refine_layers.zip"
            else:
                from src.refine_export.psd_export import create_manual_refine_psd_for_variant

                export_bytes, export_meta = create_manual_refine_psd_for_variant(
                    asset_store=asset_store,
                    frame=frame,
                    variant=variant,
                )
                export_key = paths.manual_refine_export(frame_id, req.sourceVariantId, new_id("mrexp"), ".psd")
                content_type = "image/vnd.adobe.photoshop"
                filename = f"{task.get('name', 'task')}_{frame.get('frameIndex', 0)}_{req.sourceVariantId[-6:]}_manual_refine.psd"
            asset_store.put_bytes(export_key, export_bytes, content_type=content_type)
            return response(
                200,
                {
                    "downloadUrl": asset_store.presign_get(export_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    "filename": filename,
                    "exportMeta": export_meta,
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "manual-refine" and parts[5] == "upload" and parts[6] == "init":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ManualRefineUploadInitRequest, event)
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == req.sourceVariantId), None)
            if not isinstance(variant, dict):
                return error_response(404, "Source variant not found", origin=origin)
            upload_id = new_id("mru")
            paths = _asset_paths_for_task(task)
            upload_key = paths.manual_refine_upload(frame_id, upload_id, req.filename)
            return response(
                200,
                {
                    "uploadKey": upload_key,
                    "uploadUrl": asset_store.presign_put(upload_key, expires=900, content_type=req.contentType),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "manual-refine" and parts[5] == "upload" and parts[6] == "complete":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ManualRefineUploadCompleteRequest, event)
            variant = next((item for item in frame.get("variants", []) if item.get("variantId") == req.sourceVariantId), None)
            if not isinstance(variant, dict):
                return error_response(404, "Source variant not found", origin=origin)
            paths = _asset_paths_for_task(task)
            expected_prefix = f"{paths.task_prefix()}/frames/{frame_id}/manual_refine/uploads/"
            if not req.uploadKey.startswith(expected_prefix):
                return error_response(400, "Upload key is outside this frame manual-refine path", origin=origin)
            try:
                asset_store.head_object(req.uploadKey)
            except ClientError:
                return error_response(404, "Uploaded manual refine file not found", origin=origin)

            original_bytes = asset_store.read_bytes(frame["captureKey"])
            uploaded_bytes = asset_store.read_bytes(req.uploadKey)
            normalized_png = _normalize_uploaded_refine_image(original_bytes=original_bytes, uploaded_bytes=uploaded_bytes)
            refined_variant_id, refined_output_key = _allocate_refined_variant_storage(frame, paths, frame_id)
            asset_store.put_bytes(refined_output_key, normalized_png, content_type="image/png")
            try:
                asset_store.delete_object(req.uploadKey)
            except Exception:
                pass

            refined_variant = create_refined_variant_from_upload(
                task=task,
                frame_id=frame_id,
                source_variant_id=req.sourceVariantId,
                variant_id=refined_variant_id,
                output_key=refined_output_key,
                uploaded_filename=req.filename,
            )
            task.setdefault("history", []).append(
                {
                    "type": "MANUAL_REFINE_UPLOADED",
                    "frameId": frame_id,
                    "userId": user_id,
                    "timestamp": now_iso(),
                    "details": {
                        "sourceVariantId": req.sourceVariantId,
                        "refinedVariantId": refined_variant_id,
                        "filename": req.filename,
                    },
                }
            )
            store.save_task(task)
            return response(
                200,
                {
                    "variant": {
                        **refined_variant,
                        "imageUrl": asset_store.presign_get(refined_output_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    }
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
            normalized_rect = _normalize_patch_rect_for_image(req.patchRect.model_dump(), source.width, source.height)
            bleed = req.bleedPx
            x0 = max(0, normalized_rect["x"] - bleed)
            y0 = max(0, normalized_rect["y"] - bleed)
            x1 = min(source.width, normalized_rect["x"] + normalized_rect["width"] + bleed)
            y1 = min(source.height, normalized_rect["y"] + normalized_rect["height"] + bleed)
            patch = source.crop((x0, y0, x1, y1))
            out = BytesIO()
            patch.save(out, format="PNG")
            asset_store.put_bytes(patch_key, out.getvalue(), content_type="image/png")

            patch_upload = asset_store.presign_put(patch_key, expires=900, content_type="image/png")

            resp: dict[str, Any] = {
                "patchUploadUrl": patch_upload,
                "patchKey": patch_key,
                "previewUrl": asset_store.presign_get(patch_key, expires=900),
                "patchRect": normalized_rect,
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
            source_submit = Image.open(BytesIO(asset_store.read_bytes(source_key))).convert("RGBA")
            normalized_rect = _normalize_patch_rect_for_image(req.patchRect.model_dump(), source_submit.width, source_submit.height)
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
                    "patchRect": normalized_rect,
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
            limit_error = _segment_model_limit_error(task, segment, req.lumaModel)
            if limit_error:
                return error_response(400, limit_error, origin=origin)
            try:
                prompt = _sanitize_prompt(req.prompt) if req.prompt else None
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            if req.lumaModel in {"kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"} and not prompt:
                return error_response(400, f"{_video_model_label(req.lumaModel)} requires a prompt.", origin=origin)
            if req.lumaModel in {"kling-o1", "kling-v3-omni-video"} and prompt:
                missing_refs: list[str] = []
                if "<<<video_1>>>" not in prompt:
                    missing_refs.append("<<<video_1>>>")
                if "<<<image_1>>>" not in prompt:
                    missing_refs.append("<<<image_1>>>")
                if missing_refs:
                    return error_response(
                        400,
                        f"{_video_model_label(req.lumaModel)} prompt must reference {' and '.join(missing_refs)}.",
                        origin=origin,
                    )
            if req.lumaModel == "seedance-2.0-reference-to-video" and prompt:
                missing_refs: list[str] = []
                if "@Video1" not in prompt:
                    missing_refs.append("@Video1")
                if "@Image1" not in prompt:
                    missing_refs.append("@Image1")
                if missing_refs:
                    return error_response(
                        400,
                        f"{_video_model_label(req.lumaModel)} prompt must reference {' and '.join(missing_refs)}.",
                        origin=origin,
                    )
            if prompt:
                logger.info("Queueing segment generation", extra={**_audit_prompt(prompt), "taskId": task_id, "segmentId": segment_id})

            gen_id = new_id("gen")
            provider_name = (
                "runway"
                if req.lumaModel == "runway-gen4.5"
                else (
                    "kling"
                    if req.lumaModel == "kling-2.6"
                    else (
                        "runware"
                        if req.lumaModel in {"veo-3.1", "veo-3.1-fast", "wan2.2-a14b", "wan2.2-animate"}
                        else ("replicate" if req.lumaModel in {"kling-o1", "kling-v3-omni-video", "wan2.7-videoedit"} else ("fal" if req.lumaModel == "seedance-2.0-reference-to-video" else "luma"))
                    )
                )
            )

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
                    "replicateKlingMode": req.replicateKlingMode,
                    "replicateKlingV3Mode": req.replicateKlingV3Mode,
                    "wan27Resolution": req.wan27Resolution,
                },
            )

            task.setdefault("segmentGenerations", {})[gen_id] = {
                "genId": gen_id,
                "segmentId": segment_id,
                "luma": {
                    "provider": provider_name,
                    "model": req.lumaModel,
                    "mode": req.mode,
                    "prompt": prompt,
                    "lumaGenerationId": None,
                },
                "status": "queued",
                "outputKey": None,
                "jobId": job_id,
                "error": None,
                "segmentCrop": segment.get("crop"),
                "queuedAt": now_iso(),
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
            _append_history_event(
                task,
                {
                    "at": now_iso(),
                    "event": "segment_generation.queued",
                    "jobId": job_id,
                    "genId": gen_id,
                    "segmentId": segment_id,
                    "model": req.lumaModel,
                },
            )
            store.save_task(task, merge_on_conflict=True)
            return response(202, {"jobId": job_id, "genId": gen_id}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "segments" and parts[4] == "chunked-generate":
            segment_id = parts[3]
            segment = next((s for s in task.get("segments", []) if s["segmentId"] == segment_id), None)
            if not segment:
                return error_response(404, "Segment not found", origin=origin)

            req = _json_model(ChunkedSegmentGenerateRequest, event)
            if req.lumaModel not in CHUNKED_GENERATION_SUPPORTED_MODELS:
                return error_response(400, "This model is not supported for chunked whole-video generation yet", origin=origin)

            total_frames = int(segment.get("durationFrames") or 0)
            fps = _fps(task)
            if total_frames <= 0:
                return error_response(400, "Segment does not contain any frames", origin=origin)
            if float(segment.get("durationSec") or 0.0) <= CHUNKED_CONSERVATIVE_DURATION_SECONDS + 1e-6:
                return error_response(400, "This range already fits inside the conservative chunk duration", origin=origin)

            first_frame = task.get("frames", {}).get(segment.get("startFrameId") or "")
            if not isinstance(first_frame, dict):
                return error_response(404, "Segment start frame not found", origin=origin)
            first_variant_id = req.firstFrameVariantId or first_frame.get("selectedVariantId")
            if not isinstance(first_variant_id, str) or not first_variant_id:
                return error_response(400, "Chunked generation requires a selected edited start frame", origin=origin)
            if not any(isinstance(variant, dict) and variant.get("variantId") == first_variant_id for variant in first_frame.get("variants", [])):
                return error_response(404, "Selected start frame variant not found", origin=origin)

            try:
                prompt = _sanitize_prompt(req.prompt) if req.prompt else None
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            if req.lumaModel in {"kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"} and not prompt:
                return error_response(400, f"{_video_model_label(req.lumaModel)} requires a prompt.", origin=origin)
            if req.lumaModel in {"kling-o1", "kling-v3-omni-video"} and prompt:
                missing_refs: list[str] = []
                if "<<<video_1>>>" not in prompt:
                    missing_refs.append("<<<video_1>>>")
                if "<<<image_1>>>" not in prompt:
                    missing_refs.append("<<<image_1>>>")
                if missing_refs:
                    return error_response(
                        400,
                        f"{_video_model_label(req.lumaModel)} prompt must reference {' and '.join(missing_refs)}.",
                        origin=origin,
                    )
            if req.lumaModel == "seedance-2.0-reference-to-video" and prompt:
                missing_refs: list[str] = []
                if "@Video1" not in prompt:
                    missing_refs.append("@Video1")
                if "@Image1" not in prompt:
                    missing_refs.append("@Image1")
                if missing_refs:
                    return error_response(
                        400,
                        f"{_video_model_label(req.lumaModel)} prompt must reference {' and '.join(missing_refs)}.",
                        origin=origin,
                    )

            overlap_frames, chunk_windows = _plan_chunk_windows(total_frames=total_frames, fps=fps)
            chunk_segments: list[dict[str, Any]] = []
            for window in chunk_windows:
                start = int(segment.get("startFrame") or 0) + int(window["startFrame"])
                end_excl = int(segment.get("startFrame") or 0) + int(window["endFrameExclusive"])
                chunk_segments.append(
                    _create_segment_record(
                        task=task,
                        start=start,
                        end_excl=end_excl,
                        dur_frames=int(window["durationFrames"]),
                        asset_store=asset_store,
                    )
                )

            run_id = new_id("cgr")
            now = now_iso()
            run = {
                "runId": run_id,
                "sourceSegmentId": segment_id,
                "status": "created",
                "model": req.lumaModel,
                "mode": req.mode,
                "prompt": prompt,
                "firstFrameVariantId": first_variant_id,
                "replicateKlingMode": req.replicateKlingMode,
                "replicateKlingV3Mode": req.replicateKlingV3Mode,
                "wan27Resolution": req.wan27Resolution,
                "chunkDurationSec": CHUNKED_CONSERVATIVE_DURATION_SECONDS,
                "minimumOverlapFrames": overlap_frames,
                "createdAt": now,
                "startedAt": now,
                "updatedAt": now,
                "activeChunkIndex": 0,
                "chunks": [],
            }
            absolute_segment_start = int(segment.get("startFrame") or 0)
            for idx, (window, chunk_segment) in enumerate(zip(chunk_windows, chunk_segments)):
                run["chunks"].append(
                    {
                        "chunkIndex": idx,
                        "segmentId": chunk_segment["segmentId"],
                        "segmentStartFrame": int(chunk_segment.get("startFrame") or 0),
                        "segmentEndFrameExclusive": int(chunk_segment.get("endFrameExclusive") or 0),
                        "segmentDurationFrames": int(chunk_segment.get("durationFrames") or 0),
                        "segmentDurationSec": round(float(chunk_segment.get("durationSec") or 0.0), 4),
                        "relativeStartFrame": int(window["startFrame"]),
                        "relativeEndFrameExclusive": int(window["endFrameExclusive"]),
                        "overlapFrames": int(window["overlapFrames"]),
                        "anchorFramesFromPrevious": int(window["anchorFramesFromPrevious"]),
                        "alignmentFrameIndex": absolute_segment_start + int(window["startFrame"]),
                        "anchorSource": "initial_variant" if idx == 0 else "previous_generation",
                        "anchorFrameId": chunk_segment.get("startFrameId"),
                        "anchorVariantId": first_variant_id if idx == 0 else None,
                        "status": "planned",
                        "reviewStatus": "pending" if idx > 0 else "running",
                        "prompt": prompt,
                        "createdAt": now,
                        "updatedAt": now,
                    }
                )
            first_chunk = run["chunks"][0]
            _queue_chunk_generation_for_run(
                task=task,
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                run=run,
                chunk=first_chunk,
                model=req.lumaModel,
                mode=req.mode,
                prompt=prompt,
                first_frame_variant_id=first_variant_id,
                replicate_kling_mode=req.replicateKlingMode,
                replicate_kling_v3_mode=req.replicateKlingV3Mode,
                wan27_resolution=req.wan27Resolution,
                extension_metadata={
                    "chunkedRunId": run_id,
                    "chunkIndex": 0,
                    "sourceSegmentId": segment_id,
                    "alignmentFrameIndex": absolute_segment_start,
                    "anchorFramesFromEnd": 0,
                    "anchorVariantId": first_variant_id,
                    "createdAt": now,
                },
            )
            task.setdefault("chunkedGenerationRuns", []).append(run)
            _append_history_event(
                task,
                {
                    "at": now,
                    "event": "chunked_generation.created",
                    "runId": run_id,
                    "sourceSegmentId": segment_id,
                    "model": req.lumaModel,
                    "chunkCount": len(run["chunks"]),
                },
            )
            store.save_task(task, merge_on_conflict=True)
            return response(
                202,
                {
                    "runId": run_id,
                    "jobId": first_chunk.get("jobId"),
                    "genId": first_chunk.get("generationId"),
                    "chunkCount": len(run["chunks"]),
                    "chunkDurationSec": CHUNKED_CONSERVATIVE_DURATION_SECONDS,
                    "minimumOverlapFrames": overlap_frames,
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 5 and parts[2] == "segment-generations" and parts[4] == "extend":
            previous_gen_id = parts[3]
            previous_generation = task.get("segmentGenerations", {}).get(previous_gen_id)
            if not previous_generation:
                return error_response(404, "Previous generation not found", origin=origin)
            if previous_generation.get("status") != "complete" or not previous_generation.get("outputKey"):
                return error_response(400, "Previous generation must be complete before it can be extended", origin=origin)
            req = _json_model(SegmentGenerationExtendRequest, event)
            model = str(previous_generation.get("luma", {}).get("model") or "")
            if model not in {"ray-2", "ray-flash-2", "wan2.2-animate", "kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"}:
                return error_response(400, "Only first-frame + video generation models can be extended in this flow", origin=origin)

            previous_segment = next((item for item in task.get("segments", []) if item.get("segmentId") == previous_generation.get("segmentId")), None)
            if not previous_segment:
                return error_response(404, "Previous generation segment not found", origin=origin)
            total_frames = int(task.get("video", {}).get("editSource", {}).get("frameCount") or 0)
            if req.alignmentFrameIndex >= total_frames:
                return error_response(400, "Alignment frame is outside the source video", origin=origin)
            model_max_seconds = VIDEO_MODEL_MAX_SECONDS.get(model, 10)
            requested_duration_seconds = req.durationSeconds or int(math.ceil(float(previous_segment.get("durationSec") or model_max_seconds)))
            requested_duration_seconds = max(1, min(model_max_seconds, int(requested_duration_seconds)))
            fps = _fps(task)
            desired_frames = max(1, int(round(float(fps) * requested_duration_seconds)))
            remaining_frames = max(0, total_frames - req.alignmentFrameIndex)
            if remaining_frames <= 0:
                return error_response(400, "No source frames remain after the selected alignment frame", origin=origin)
            dur_frames = min(desired_frames, remaining_frames)
            min_seconds = VIDEO_MODEL_MIN_SECONDS.get(model)
            if min_seconds is not None and (dur_frames / float(fps)) + 1e-6 < float(min_seconds):
                return error_response(
                    400,
                    f"{_video_model_label(model)} requires at least {min_seconds}s. Choose an earlier alignment frame or a shorter prior overlap.",
                    origin=origin,
                )
            start, end_excl, dur_frames = _resolve_segment_frames(
                task,
                req.alignmentFrameIndex,
                end_frame_exclusive=req.alignmentFrameIndex + dur_frames,
            )
            segment = _create_segment_record(task=task, start=start, end_excl=end_excl, dur_frames=dur_frames, asset_store=asset_store)
            limit_error = _segment_model_limit_error(task, segment, model)
            if limit_error:
                task["segments"] = [item for item in task.get("segments", []) if item.get("segmentId") != segment.get("segmentId")]
                return error_response(400, limit_error, origin=origin)

            try:
                prompt = _sanitize_prompt(req.prompt) if req.prompt else previous_generation.get("luma", {}).get("prompt")
                anchor_variant = _copy_generated_anchor_to_frame_variant(
                    task=task,
                    generation=previous_generation,
                    target_frame_id=segment["startFrameId"],
                    target_frame_index=start,
                    anchor_frames_from_end=req.anchorFramesFromEnd,
                    asset_store=asset_store,
                )
            except ValueError as exc:
                task["segments"] = [item for item in task.get("segments", []) if item.get("segmentId") != segment.get("segmentId")]
                return error_response(400, str(exc), origin=origin)

            settings_payload = previous_generation.get("generationSettings") if isinstance(previous_generation.get("generationSettings"), dict) else {}
            extension_metadata = {
                "parentGenerationId": previous_gen_id,
                "alignmentFrameIndex": start,
                "anchorFramesFromEnd": req.anchorFramesFromEnd,
                "anchorVariantId": anchor_variant.get("variantId"),
                "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
                "previousSegmentId": previous_generation.get("segmentId"),
                "createdAt": now_iso(),
            }
            gen_id, job_id = _queue_segment_generation_record(
                task=task,
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                segment_id=segment["segmentId"],
                model=model,
                mode=str(previous_generation.get("luma", {}).get("mode") or ""),
                prompt=str(prompt) if prompt else None,
                first_frame_variant_id=str(anchor_variant.get("variantId")),
                last_frame_variant_id=None,
                replicate_kling_mode=settings_payload.get("replicateKlingMode"),
                replicate_kling_v3_mode=settings_payload.get("replicateKlingV3Mode"),
                wan27_resolution=settings_payload.get("wan27Resolution"),
                parent_generation_id=previous_gen_id,
                extension_metadata=extension_metadata,
            )
            store.save_task(task, merge_on_conflict=True)
            return response(
                202,
                {
                    "jobId": job_id,
                    "genId": gen_id,
                    "segmentId": segment["segmentId"],
                    "anchorVariantId": anchor_variant.get("variantId"),
                    "alignmentFrameIndex": start,
                    "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "pause":
            run = _find_chunked_generation_run(task, parts[3])
            if not isinstance(run, dict):
                return error_response(404, "Chunked generation run not found", origin=origin)
            req = _json_model(ChunkedGenerationPauseRequest, event)
            run["status"] = "paused"
            run["pauseRequestedAt"] = now_iso()
            run["pauseReason"] = req.reason or "Paused by user"
            run["updatedAt"] = now_iso()
            store.save_task(task, merge_on_conflict=True)
            return response(200, {"ok": True}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "resume":
            run = _find_chunked_generation_run(task, parts[3])
            if not isinstance(run, dict):
                return error_response(404, "Chunked generation run not found", origin=origin)
            chunks = [chunk for chunk in run.get("chunks", []) if isinstance(chunk, dict)]
            active_chunk = next((chunk for chunk in chunks if chunk.get("status") in {"queued", "running"}), None)
            pending_chunk = None if isinstance(active_chunk, dict) else next((chunk for chunk in chunks if chunk.get("status") in {"planned", "failed"}), None)
            run["status"] = "running"
            run["updatedAt"] = now_iso()
            if isinstance(pending_chunk, dict):
                chunk_index = int(pending_chunk.get("chunkIndex") or 0)
                prompt = run.get("prompt")
                parent_generation_id: str | None = None
                if chunk_index == 0:
                    first_frame_variant_id = str(run.get("firstFrameVariantId") or "")
                else:
                    previous_chunk = chunks[chunk_index - 1]
                    previous_generation = task.get("segmentGenerations", {}).get(previous_chunk.get("generationId") or "")
                    if not isinstance(previous_generation, dict) or previous_generation.get("status") != "complete":
                        return error_response(400, "Cannot resume until the previous chunk is complete", origin=origin)
                    anchor_variant = _copy_generated_anchor_to_frame_variant(
                        task=task,
                        generation=previous_generation,
                        target_frame_id=str(pending_chunk.get("anchorFrameId") or ""),
                        target_frame_index=int(pending_chunk.get("segmentStartFrame") or 0),
                        anchor_frames_from_end=int(pending_chunk.get("anchorFramesFromPrevious") or 0),
                        asset_store=asset_store,
                    )
                    first_frame_variant_id = str(anchor_variant.get("variantId") or "")
                    pending_chunk["anchorVariantId"] = first_frame_variant_id
                    pending_chunk["sourceGeneratedFrameIndex"] = anchor_variant.get("sourceGeneratedFrameIndex")
                    parent_generation_id = str(previous_chunk.get("generationId") or "")
                _queue_chunk_generation_for_run(
                    task=task,
                    store=store,
                    queue=queue,
                    user_id=user_id,
                    task_id=task_id,
                    run=run,
                    chunk=pending_chunk,
                    model=str(run.get("model") or ""),
                    mode=str(run.get("mode") or ""),
                    prompt=str(prompt) if prompt else None,
                    first_frame_variant_id=first_frame_variant_id or None,
                    replicate_kling_mode=run.get("replicateKlingMode"),
                    replicate_kling_v3_mode=run.get("replicateKlingV3Mode"),
                    wan27_resolution=run.get("wan27Resolution"),
                    parent_generation_id=parent_generation_id or None,
                    extension_metadata={
                        "chunkedRunId": run.get("runId"),
                        "chunkIndex": pending_chunk.get("chunkIndex"),
                        "sourceSegmentId": run.get("sourceSegmentId"),
                        "alignmentFrameIndex": pending_chunk.get("segmentStartFrame"),
                        "anchorFramesFromEnd": pending_chunk.get("anchorFramesFromPrevious", 0),
                        "anchorVariantId": pending_chunk.get("anchorVariantId"),
                        "createdAt": now_iso(),
                    },
                )
            store.save_task(task, merge_on_conflict=True)
            return response(200, {"ok": True, "jobId": pending_chunk.get("jobId") if isinstance(pending_chunk, dict) else None}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "restart":
            run = _find_chunked_generation_run(task, parts[3])
            if not isinstance(run, dict):
                return error_response(404, "Chunked generation run not found", origin=origin)
            req = _json_model(ChunkedGenerationRestartRequest, event)
            chunks = [chunk for chunk in run.get("chunks", []) if isinstance(chunk, dict)]
            if req.fromChunkIndex >= len(chunks):
                return error_response(400, "Chunk index is outside the run", origin=origin)
            if req.fromChunkIndex > 0:
                previous_chunk = chunks[req.fromChunkIndex - 1]
                previous_generation = task.get("segmentGenerations", {}).get(previous_chunk.get("generationId") or "")
                if not isinstance(previous_generation, dict) or previous_generation.get("status") != "complete":
                    return error_response(400, "Restart requires the previous chunk generation to be complete", origin=origin)

            prompt = _sanitize_prompt(req.prompt) if req.prompt is not None else run.get("prompt")
            run["prompt"] = prompt
            run["status"] = "running"
            run["activeChunkIndex"] = req.fromChunkIndex
            run["updatedAt"] = now_iso()
            run.pop("failureChunkIndex", None)

            for chunk in chunks[req.fromChunkIndex + 1 :]:
                chunk["status"] = "planned"
                chunk["reviewStatus"] = "pending"
                chunk["prompt"] = prompt
                chunk.pop("generationId", None)
                chunk.pop("jobId", None)
                chunk.pop("error", None)
                chunk["updatedAt"] = now_iso()

            chunk = chunks[req.fromChunkIndex]
            first_frame_variant_id: str | None
            parent_generation_id: str | None = None
            if req.fromChunkIndex == 0:
                first_frame_variant_id = str(run.get("firstFrameVariantId") or "")
            else:
                previous_chunk = chunks[req.fromChunkIndex - 1]
                previous_generation = task.get("segmentGenerations", {}).get(previous_chunk.get("generationId") or "")
                anchor_variant = _copy_generated_anchor_to_frame_variant(
                    task=task,
                    generation=previous_generation,
                    target_frame_id=str(chunk.get("anchorFrameId") or ""),
                    target_frame_index=int(chunk.get("segmentStartFrame") or 0),
                    anchor_frames_from_end=int(chunk.get("anchorFramesFromPrevious") or 0),
                    asset_store=asset_store,
                )
                first_frame_variant_id = str(anchor_variant.get("variantId") or "")
                chunk["anchorVariantId"] = first_frame_variant_id
                chunk["sourceGeneratedFrameIndex"] = anchor_variant.get("sourceGeneratedFrameIndex")
                parent_generation_id = str(previous_chunk.get("generationId") or "")

            _queue_chunk_generation_for_run(
                task=task,
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                run=run,
                chunk=chunk,
                model=str(run.get("model") or ""),
                mode=str(run.get("mode") or ""),
                prompt=str(prompt) if prompt else None,
                first_frame_variant_id=first_frame_variant_id or None,
                replicate_kling_mode=run.get("replicateKlingMode"),
                replicate_kling_v3_mode=run.get("replicateKlingV3Mode"),
                wan27_resolution=run.get("wan27Resolution"),
                parent_generation_id=parent_generation_id or None,
                extension_metadata={
                    "chunkedRunId": run.get("runId"),
                    "chunkIndex": req.fromChunkIndex,
                    "sourceSegmentId": run.get("sourceSegmentId"),
                    "alignmentFrameIndex": chunk.get("segmentStartFrame"),
                    "anchorFramesFromEnd": chunk.get("anchorFramesFromPrevious", 0),
                    "anchorVariantId": chunk.get("anchorVariantId"),
                    "createdAt": now_iso(),
                },
            )
            store.save_task(task, merge_on_conflict=True)
            return response(202, {"ok": True, "jobId": chunk.get("jobId"), "genId": chunk.get("generationId")}, origin=origin)

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
                payload={"generationIds": generation_ids, "mode": req.mode},
            )
            return response(202, {"jobId": job_id, "generationCount": len(generation_ids)}, origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "merge":
            req = _json_model(MergeRequest, event)
            if not req.selectedSegmentGenerationIds:
                return error_response(400, "Select at least one generation for merge", origin=origin)
            generation_adjustments_payload: dict[str, Any] = {}
            if req.generationAdjustments:
                for gen_id, adjustment in req.generationAdjustments.items():
                    if hasattr(adjustment, "model_dump"):
                        generation_adjustments_payload[gen_id] = adjustment.model_dump(exclude_none=True)
                    elif isinstance(adjustment, dict):
                        generation_adjustments_payload[gen_id] = adjustment

            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="merge_export",
                payload={
                    "selectedSegmentGenerationIds": req.selectedSegmentGenerationIds,
                    "temporalFeatherFrames": req.temporalFeatherFrames,
                    "generationAdjustments": generation_adjustments_payload,
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
def handler(event, context):
    try:
        return _route(event)
    except ValidationError as exc:
        return error_response(400, f"Validation failed: {exc.errors()}", origin=_origin(event))
    except Exception as exc:
        logger.exception("Unhandled error", extra={"error": str(exc)})
        return error_response(500, "Internal server error", origin=_origin(event))
