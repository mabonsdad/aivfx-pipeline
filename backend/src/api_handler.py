from __future__ import annotations

import base64
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
import requests
from botocore.exceptions import ClientError
from pydantic import ValidationError

from PIL import Image, ImageOps

from src.api.dispatch import parse_method_path, parse_task_path
from src.api.routes_admin import handle_admin_routes
from src.api.routes_external_api import handle_external_api_routes
from src.api.routes_jobs import handle_job_status
from src.api.routes_public import handle_health, handle_options
from src.api.routes_task_assets import handle_task_asset_routes
from src.api.routes_task_character_generate import handle_task_character_generate_routes
from src.api.routes_task_chunked_controls import handle_task_chunked_control_routes
from src.api.routes_task_cleanup import handle_task_cleanup_routes
from src.api.routes_task_detail import handle_task_detail_route
from src.api.routes_task_generation_extend import handle_task_generation_extend_route
from src.api.routes_task_generation_lengthen import handle_task_generation_lengthen_route
from src.api.routes_task_generation_post import handle_task_generation_post_routes
from src.api.routes_task_generation_topaz import handle_task_generation_topaz_route
from src.api.routes_task_previz import handle_task_previz_route
from src.api.routes_task_previz_generate import handle_task_previz_generate_routes
from src.api.routes_task_reports import handle_task_report_routes
from src.api.routes_task_segments import handle_task_segment_routes
from src.api.routes_tasks_root import handle_tasks_root_routes
from src.api.routes_user import handle_me
from src.core.asset_origin import build_asset_origin
from src.core.assets import ApiAssetPaths, AssetPaths, AssetStore
from src.core.auth import UnauthorizedError, get_user_claims, get_user_groups, get_user_id, is_admin_claims
from src.core.config import load_settings
from src.core.cost_tracking import (
    load_pricing_admin_config,
    resolve_openai_prompt_wizard_pricing_entry,
    resolve_openai_prompt_wizard_rates,
)
from src.core.ffmpeg import (
    extract_frame_png,
    ffprobe_audio,
    ffprobe_video,
    generate_waveform_png,
    transcode_audio_edit_source,
    transcode_audio_preview,
    transcode_to_cfr,
)
from src.core.http import error_response, parse_json_body, response
from src.core.ids import deterministic_frame_id, new_id, prompt_hash
from src.core.logger import Logger
from src.core.secrets import load_secret
from src.core.store import S3JsonStore, now_iso
from src.core.prompt_wizard_admin import (
    ADMIN_PROMPT_WIZARD_CONFIG_KEY,
    normalize_prompt_wizard_admin_config_for_read,
)
from src.core.projects import can_access_project, project_summary
from src.core.task_workflows import is_source_video_workflow_id
from src.generation import (
    LUMA_API_ALLOWED_MODES,
    get_video_model_capability,
    get_video_model_label,
    get_video_model_provider,
    resolve_video_model_limit_error,
    supports_chunked_generation,
    validate_video_model_mode,
    validate_video_model_prompt,
)
from src.generation.maintenance import (
    backfill_segment_generation_preview_refs,
    maintain_segment_generations,
    prune_stale_segment_generations,
    reconcile_edit_video_reference_job_states,
    reconcile_segment_generation_job_states,
)
from src.jobs.queue import JobQueue
from src.integrations.gemini import (
    generate_image_edit as generate_gemini_image_edit,
    generate_image_from_references as generate_gemini_image_from_references,
)
from src.integrations.luma import (
    create_uni_image_generation,
    parse_uni_output_url,
    wait_for_uni_generation_complete,
)
from src.integrations.openai_images import (
    generate_image_edit as generate_openai_image_edit,
    generate_image_from_references as generate_openai_image_from_references,
)
from src.integrations.openai_prompt_wizard import improve_video_prompt as improve_openai_video_prompt
from src.integrations.openai_lookdev_wizard import improve_lookdev_prompt as improve_openai_lookdev_prompt
from src.integrations.openai_canvas_chat import run_canvas_chat as run_canvas_chat_engine
from src.api.routes_canvas import handle_canvas_routes
from src.core.canvas_prompt_admin import (
    ADMIN_CANVAS_PROMPT_PROFILES_KEY,
    normalize_canvas_prompt_profiles_for_read,
    resolve_canvas_system_prompt,
)
from src.models.schemas import (
    ChunkedSegmentGenerateRequest,
    EditVideoReferenceGenerateRequest,
    EditVideoReferenceImportRequest,
    EditVideoReferenceUploadCompleteRequest,
    EditVideoReferenceUploadRequest,
    FrameCaptureRequest,
    GenerationAudioReferenceUploadCompleteRequest,
    GenerationAudioReferenceUploadRequest,
    FullEditRequest,
    ManualFrameUploadCompleteRequest,
    ManualFrameImportRequest,
    ManualFrameUploadInitRequest,
    ManualRefineExportRequest,
    ManualRefineUploadCompleteRequest,
    ManualRefineUploadInitRequest,
    MergeRequest,
    MotionSyncQcRunRequest,
    ExportTopazUpscaleRequest,
    QualityMatchAnalyseRequest,
    QualityMatchApplyRequest,
    QualityMatchMaskUploadRequest,
    QualityMatchPreviewRequest,
    QualityMatchSamRequest,
    PatchInitRequest,
    PatchSubmitRequest,
    ReferenceUploadRequest,
)
from src.quality_match.apply_flow import _allocate_refined_variant_storage, create_refined_variant_from_upload
from src.quality_match.service import QualityMatchSettings, analyse_quality_match, preview_quality_match_from_mask
from src.video_cleanup.service import get_cleanup_track, resolve_first_mask_key_from_analysis
logger = Logger()
settings = load_settings()
DEFAULT_TASK_WORKFLOW_ID = "source_video_flow"
CHUNKED_CONSERVATIVE_DURATION_SECONDS = 6
CHUNKED_MIN_OVERLAP_SECONDS = 0.5
PRESIGNED_GET_TTL_SECONDS = 3600
STALE_GENERATION_MAX_AGE_SECONDS = 30 * 60
STALE_RUNNING_JOB_MAX_AGE_SECONDS = 16 * 60
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
PREVIZ_REPORT_TESTS = {
    "storyboard_overview",
    "frame_continuity",
}

def _chunk_overlap_frames(fps: Fraction) -> int:
    return max(12, int(round(float(fps) * CHUNKED_MIN_OVERLAP_SECONDS)))


def _plan_chunk_windows(*, total_frames: int, fps: Fraction) -> tuple[int, list[dict[str, int | float]]]:
    chunk_duration_sec = CHUNKED_CONSERVATIVE_DURATION_SECONDS
    chunk_frames = max(1, int(round(float(fps) * chunk_duration_sec)))
    overlap_frames = min(max(2, _chunk_overlap_frames(fps)), max(2, chunk_frames - 2))
    context_frames = min(overlap_frames, max(1, chunk_frames - 1))
    if total_frames <= chunk_frames:
        return overlap_frames, [
            {
                "chunkIndex": 0,
                "startFrame": 0,
                "endFrameExclusive": total_frames,
                "durationFrames": total_frames,
                "durationSec": round(total_frames / float(fps), 4),
                "coverageStartFrame": 0,
                "coverageEndFrameExclusive": total_frames,
                "coverageDurationFrames": total_frames,
                "coverageTrimStartFrames": 0,
                "coverageTrimEndFrames": 0,
                "anchorFramesFromPrevious": 0,
                "overlapFrames": 0,
            }
        ]
    coverage_frames = max(1, chunk_frames - context_frames)
    chunks: list[dict[str, int | float]] = []
    coverage_start = 0
    previous_source_end = 0
    chunk_index = 0
    while coverage_start < total_frames:
        if chunk_index == 0:
            source_start = 0
        else:
            source_start = max(0, coverage_start - context_frames)
        remaining_coverage = total_frames - coverage_start
        if remaining_coverage <= coverage_frames:
            coverage_end = total_frames
            source_end = total_frames
            if chunk_index > 0:
                source_start = max(0, total_frames - chunk_frames)
        else:
            coverage_end = min(total_frames, coverage_start + coverage_frames)
            source_end = min(total_frames, source_start + chunk_frames)
            if source_end < coverage_end:
                source_end = coverage_end
        overlap_with_previous = max(0, previous_source_end - source_start) if chunk_index > 0 else 0
        coverage_trim_start = max(0, coverage_start - source_start)
        coverage_trim_end = max(0, source_end - coverage_end)
        chunks.append(
            {
                "chunkIndex": chunk_index,
                "startFrame": source_start,
                "endFrameExclusive": source_end,
                "durationFrames": max(0, source_end - source_start),
                "durationSec": round(max(0, source_end - source_start) / float(fps), 4),
                "coverageStartFrame": coverage_start,
                "coverageEndFrameExclusive": coverage_end,
                "coverageDurationFrames": max(0, coverage_end - coverage_start),
                "coverageTrimStartFrames": coverage_trim_start,
                "coverageTrimEndFrames": coverage_trim_end,
                "anchorFramesFromPrevious": max(0, overlap_with_previous - 1),
                "overlapFrames": overlap_with_previous,
            }
        )
        previous_source_end = source_end
        coverage_start = coverage_end
        chunk_index += 1
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


def _solid_png_bytes(*, width: int = 1024, height: int = 1024, rgb: tuple[int, int, int] = (245, 245, 245)) -> bytes:
    image = Image.new("RGB", (max(1, width), max(1, height)), rgb)
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _clean_optional_api_key(value: Any) -> str | None:
    if value is None:
        return None
    key = str(value).strip()
    if not key:
        return None
    if key.upper() in {"SET_ME", "CHANGEME", "CHANGE_ME", "REPLACE_ME"}:
        return None
    return key


def _is_luma_agents_api_key(value: str) -> bool:
    return value.startswith("luma-api-")


def _resolve_luma_uni_api_key(secrets: dict[str, Any]) -> str | None:
    luma_agents_key = _clean_optional_api_key(secrets.get("LUMA_AGENTS_API_KEY"))
    if luma_agents_key and _is_luma_agents_api_key(luma_agents_key):
        return luma_agents_key
    luma_api_key = _clean_optional_api_key(secrets.get("LUMA_API_KEY"))
    if luma_api_key and _is_luma_agents_api_key(luma_api_key):
        return luma_api_key
    return None


def _resolve_luma_uni_model_name(model_name: str) -> str:
    if model_name == "luma_uni_1_max":
        return "uni-1-max"
    return "uni-1"


def _reference_content_type_from_key(key: str) -> str:
    suffix = Path(key).suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


def _normalize_generated_reference_png(image_bytes: bytes) -> bytes:
    image = ImageOps.exif_transpose(Image.open(BytesIO(image_bytes))).convert("RGBA")
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _video_probe_payload(probe: dict[str, Any]) -> dict[str, Any]:
    fps = Fraction(int(probe.get("fps_num") or 0), int(probe.get("fps_den") or 1))
    if fps.numerator <= 0 or fps.denominator <= 0:
        fps = Fraction(30, 1)
    return {
        "width": int(probe.get("width") or 0),
        "height": int(probe.get("height") or 0),
        "fps": {"num": fps.numerator, "den": fps.denominator},
        "durationSec": round(float(probe.get("duration_sec") or 0.0), 4),
        "frameCount": int(probe.get("frame_count") or 0),
        "isVfr": bool(probe.get("is_vfr_input")),
    }


def _normalize_uploaded_generated_video(
    *,
    asset_store: AssetStore,
    upload_key: str,
    output_key: str,
    target_width: int,
    target_height: int,
    target_fps: Fraction,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        uploaded_path = td_path / "uploaded_source"
        normalized_path = td_path / "normalized_output.mp4"
        asset_store.s3.download_file(asset_store.assets_bucket, upload_key, str(uploaded_path))
        transcode_to_cfr(
            str(uploaded_path),
            str(normalized_path),
            target_fps,
            target_width=target_width,
            target_height=target_height,
            resize_mode="pad",
            crf=16,
            preset="medium",
            audio_bitrate="192k",
        )
        probe = ffprobe_video(str(normalized_path))
        asset_store.put_bytes(output_key, normalized_path.read_bytes(), content_type="video/mp4")
        return probe


def _create_manual_uploaded_frame_variant(
    *,
    task: dict[str, Any],
    frame_id: str,
    filename: str,
) -> dict[str, Any]:
    paths = _asset_paths_for_task(task)
    variant_id = new_id("var")
    variant_key = paths.frame_variant(frame_id, variant_id)
    return {
        "variantId": variant_id,
        "type": "full",
        "variantKind": "edited",
        "sourceVariantId": None,
        "model": "manual_upload",
        "promptHash": prompt_hash(f"manual_frame_upload:{filename}"),
        "createdAt": now_iso(),
        "outputKey": variant_key,
        "generationSettings": {
            "provider": "manual",
            "workflow": "manual_frame_upload",
            "uploadedFilename": filename,
        },
    }


def _parse_task_identity_from_asset_key(asset_key: str) -> tuple[str, str] | None:
    match = re.match(r"^users/([^/]+)/tasks/([^/]+)/", str(asset_key or "").strip())
    if not match:
        return None
    return match.group(1), match.group(2)


def _create_manual_uploaded_segment_generation(
    *,
    task: dict[str, Any],
    segment: dict[str, Any],
    filename: str,
    model: str,
    mode: str,
    input_mode: str | None,
    prompt: str | None,
    negative_prompt: str | None,
    first_frame_variant_id: str | None,
    last_frame_variant_id: str | None,
) -> dict[str, Any]:
    gen_id = new_id("gen")
    now = now_iso()
    paths = _asset_paths_for_task(task)
    normalized_filename = f"{Path(filename).stem or 'manual_upload'}.mp4"
    output_key = paths.manual_segment_generation_output(str(segment["segmentId"]), gen_id, normalized_filename)
    start_frame = task.get("frames", {}).get(segment.get("startFrameId") or "")
    end_frame = task.get("frames", {}).get(segment.get("endFrameId") or "")
    source_first_frame_key, resolved_first_variant_id = _resolve_frame_source(start_frame, first_frame_variant_id) if isinstance(start_frame, dict) else (None, None)
    source_last_frame_key, resolved_last_variant_id = _resolve_frame_source(end_frame, last_frame_variant_id) if isinstance(end_frame, dict) else (None, None)
    generation_record: dict[str, Any] = {
        "genId": gen_id,
        "segmentId": segment["segmentId"],
        "luma": {
            "provider": _segment_generation_provider_name(model),
            "model": model,
            "mode": mode,
            "prompt": prompt,
            "negativePrompt": negative_prompt,
            "lumaGenerationId": None,
        },
        "status": "complete",
        "outputKey": output_key,
        "jobId": None,
        "error": None,
        "createdAt": now,
        "updatedAt": now,
        "startedAt": now,
        "finishedAt": now,
        "processingDurationSec": 0,
        "requestedDurationSec": segment.get("durationSec"),
        "providerDurationSec": segment.get("durationSec"),
        "segmentCrop": segment.get("crop"),
        "manualUpload": {
            "filename": filename,
            "uploadedAt": now,
        },
        "generationSettings": {
            "workflowId": str(task.get("workflowId") or DEFAULT_TASK_WORKFLOW_ID),
            "provider": "manual",
            "requestedModel": model,
            "model": "manual_upload",
            "mode": mode,
            "inputMode": input_mode,
            "requestedDurationSec": segment.get("durationSec"),
            "providerDurationSec": segment.get("durationSec"),
        },
        "origin": build_asset_origin(
            workflow_id=str(task.get("workflowId") or DEFAULT_TASK_WORKFLOW_ID),
            step_origin="generate",
            tool_origin="manual_upload",
            creation_mode=input_mode,
        ),
    }
    if isinstance(start_frame, dict):
        generation_record["sourceFirstFrameCaptureKey"] = start_frame.get("captureKey")
        generation_record["sourceFirstFrameVariantId"] = resolved_first_variant_id
        generation_record["sourceFirstFrameResolvedKey"] = source_first_frame_key
        generation_record["inputFirstFrameKey"] = source_first_frame_key
    if isinstance(end_frame, dict):
        generation_record["sourceLastFrameCaptureKey"] = end_frame.get("captureKey")
        generation_record["sourceLastFrameVariantId"] = resolved_last_variant_id
        generation_record["sourceLastFrameResolvedKey"] = source_last_frame_key
        if source_last_frame_key:
            generation_record["inputLastFrameKey"] = source_last_frame_key
    return generation_record


def _task_summary(task: dict[str, Any]) -> dict[str, Any]:
    status = task["status"]
    if status == "error" and task.get("video", {}).get("editSource", {}).get("s3Key"):
        status = "ready"
    return {
        "taskId": task["taskId"],
        "name": task["name"],
        "workflowId": task.get("workflowId", DEFAULT_TASK_WORKFLOW_ID),
        "projectId": task.get("projectId"),
        "projectName": task.get("projectName"),
        "status": status,
        "createdAt": task["createdAt"],
        "updatedAt": task["updatedAt"],
        "video": task.get("video", {}),
    }


def _fps(task: dict[str, Any]) -> Fraction:
    fps_info = (
        task.get("video", {}).get("editSource", {}).get("fps")
        or task.get("sourceMedia", {}).get("editSource", {}).get("fps")
        or {"num": 30, "den": 1}
    )
    return Fraction(int(fps_info["num"]), int(fps_info["den"]))


def _format_fps(fps: Fraction) -> str:
    value = float(fps)
    rounded = round(value, 2)
    if abs(rounded - round(rounded)) < 1e-6:
        return f"{int(round(rounded))}"
    return f"{rounded:.2f}".rstrip("0").rstrip(".")


def _video_model_label(model: str) -> str:
    return get_video_model_label(model)


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
    return reconcile_segment_generation_job_states(
        task,
        store,
        now_iso_fn=now_iso,
        append_history_event_fn=_append_history_event,
    )


def _backfill_segment_generation_preview_refs(task: dict[str, Any]) -> bool:
    return backfill_segment_generation_preview_refs(task)


def _prune_stale_segment_generations(task: dict[str, Any], store: S3JsonStore) -> bool:
    return prune_stale_segment_generations(
        task,
        store,
        now_iso_fn=now_iso,
        stale_generation_max_age_seconds=STALE_GENERATION_MAX_AGE_SECONDS,
    )


def _maintain_segment_generations(task: dict[str, Any], store: S3JsonStore) -> bool:
    return maintain_segment_generations(
        task,
        store,
        now_iso_fn=now_iso,
        append_history_event_fn=_append_history_event,
        stale_generation_max_age_seconds=STALE_GENERATION_MAX_AGE_SECONDS,
        stale_running_job_max_age_seconds=STALE_RUNNING_JOB_MAX_AGE_SECONDS,
    )


def _cleanup_legacy_generation_qc(task: dict[str, Any]) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    changed = False
    for generation in generations.values():
        if not isinstance(generation, dict):
            continue
        if "qc" in generation:
            generation.pop("qc", None)
            changed = True
    if changed:
        task.setdefault("history", []).append(
            {
                "at": now_iso(),
                "event": "task.legacy_generation_qc.removed",
            }
        )
    return changed


def _normalize_custom_report_refs(task: dict[str, Any], raw_refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    frames = task.get("frames", {})
    generations = task.get("segmentGenerations", {})
    exports = {
        str(item.get("exportId")): item
        for item in task.get("exports", [])
        if isinstance(item, dict) and item.get("exportId")
    }
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
        elif asset_type == "export":
            export_id = str(ref.get("exportId") or "")
            export_item = exports.get(export_id)
            if isinstance(export_item, dict):
                normalized_ref = {"assetType": "export", "exportId": export_id}
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
        else PREVIZ_REPORT_TESTS
        if report_type == "previz_review"
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


def _load_task_or_404_any(store: S3JsonStore, task_id: str) -> dict[str, Any]:
    task = store.load_task_any(task_id)
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
    edit_source = task.get("video", {}).get("editSource", {})
    edit_source_key = edit_source.get("s3Key")
    if not edit_source_key:
        raise ValueError("Edit source not ready")
    media_type = str(edit_source.get("mediaType") or task.get("sourceMedia", {}).get("kind") or "video")

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
            "captureKey": frame["captureKey"],
            "imageUrl": asset_store.presign_get(frame["captureKey"], expires=PRESIGNED_GET_TTL_SECONDS),
            "timecode": frame["timecode"],
            "frameIndex": frame["frameIndex"],
            "width": frame.get("width"),
            "height": frame.get("height"),
        }

    s3 = boto3.client("s3")
    paths = _asset_paths_for_task(task)

    if media_type == "audio":
        waveform_key = (
            edit_source.get("waveformKey")
            or task.get("sourceMedia", {}).get("waveform", {}).get("s3Key")
            or task.get("sourceMedia", {}).get("editSource", {}).get("waveformKey")
        )
        if not waveform_key:
            raise ValueError("Audio waveform not ready")
        fps = _fps(task)
        timecode = _timecode(frame_index, fps)
        waveform_width = int(edit_source.get("waveformWidth") or task.get("sourceMedia", {}).get("waveform", {}).get("width") or 1280)
        waveform_height = int(edit_source.get("waveformHeight") or task.get("sourceMedia", {}).get("waveform", {}).get("height") or 240)
        frames[frame_id] = {
            "frameId": frame_id,
            "frameIndex": frame_index,
            "timecode": timecode,
            "createdAt": now_iso(),
            "captureKey": waveform_key,
            "width": waveform_width,
            "height": waveform_height,
            "variants": [],
            "selectedVariantId": None,
            "sourceCrop": None,
        }
        return {
            "frameId": frame_id,
            "captureKey": waveform_key,
            "imageUrl": asset_store.presign_get(waveform_key, expires=PRESIGNED_GET_TTL_SECONDS),
            "timecode": timecode,
            "frameIndex": frame_index,
            "width": waveform_width,
            "height": waveform_height,
        }

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
        "captureKey": key,
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


NANO_BANANA_PRO_SUPPORTED_ASPECT_RATIOS = {"16:9", "3:2", "4:3", "1:1", "5:4", "4:5", "2:3", "3:4", "9:16"}
NANO_BANANA_MAX_REFERENCE_IMAGES = 3


def _audit_prompt(prompt: str) -> dict[str, Any]:
    return {
        "promptHash": prompt_hash(prompt),
        "promptLength": len(prompt),
    }


def _validate_api_video_mode(model: str, mode: str) -> None:
    validate_video_model_mode(model, mode)


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
    payload["userId"] = request_record.get("userId")
    if request_record.get("userEmail"):
        payload["userEmail"] = request_record.get("userEmail")
    if request_record.get("username"):
        payload["username"] = request_record.get("username")
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
    duration_frames = _segment_duration_frames(segment)
    duration_seconds = _segment_duration_seconds(task, segment)
    limit_error = resolve_video_model_limit_error(
        model=model,
        duration_seconds=duration_seconds,
        duration_frames=duration_frames,
        source_fps=_fps(task),
    )
    if not limit_error:
        return None
    return limit_error.replace(f"at {float(_fps(task)):.2f}fps", f"at {_format_fps(_fps(task))}fps")


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
    return get_video_model_provider(model)


def _create_segment_record(
    *,
    task: dict[str, Any],
    start: int,
    end_excl: int,
    dur_frames: int,
    asset_store: AssetStore,
    internal_only: bool = False,
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
        "internalOnly": bool(internal_only),
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
    negative_prompt: str | None = None,
    first_frame_variant_id: str | None = None,
    last_frame_variant_id: str | None = None,
    replicate_kling_mode: str | None = None,
    replicate_kling_v3_mode: str | None = None,
    wan27_resolution: str | None = None,
    happy_horse_resolution: str | None = None,
    preserve_frames: bool = True,
    parent_generation_id: str | None = None,
    extension_metadata: dict[str, Any] | None = None,
    extra_payload: dict[str, Any] | None = None,
) -> tuple[str, str]:
    gen_id = new_id("gen")
    payload = {
        "segmentId": segment_id,
        "genId": gen_id,
        "lumaModel": model,
        "mode": mode,
        "prompt": prompt,
        "negativePrompt": negative_prompt,
        "firstFrameVariantId": first_frame_variant_id,
        "lastFrameVariantId": last_frame_variant_id,
        "replicateKlingMode": replicate_kling_mode,
        "replicateKlingV3Mode": replicate_kling_v3_mode,
        "wan27Resolution": wan27_resolution,
        "happyHorseResolution": happy_horse_resolution,
        "preserveFrames": bool(preserve_frames),
        "parentGenerationId": parent_generation_id,
        "extensionMetadata": extension_metadata,
    }
    if extra_payload:
        payload.update(extra_payload)
    job_id = _queue_job(
        store=store,
        queue=queue,
        user_id=user_id,
        task_id=task_id,
        job_type="segment_generate",
        payload=payload,
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
            "negativePrompt": negative_prompt,
            "lumaGenerationId": None,
        },
        "generationSettings": {
            "workflowId": str(task.get("workflowId") or DEFAULT_TASK_WORKFLOW_ID),
            "preserveFrames": bool(preserve_frames),
        },
        "origin": build_asset_origin(
            workflow_id=str(task.get("workflowId") or DEFAULT_TASK_WORKFLOW_ID),
            step_origin="post_process" if extension_metadata and extension_metadata.get("type") == "clip_lengthen" else "generate",
            tool_origin="clip_lengthen" if extension_metadata and extension_metadata.get("type") == "clip_lengthen" else "segment_generate",
        ),
        "status": "queued",
        "outputKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now,
        "createdAt": now,
        "updatedAt": now,
    }
    if extra_payload:
        input_mode = extra_payload.get("inputMode")
        if isinstance(input_mode, str) and input_mode:
            generation_record["generationSettings"]["inputMode"] = input_mode
            generation_record["origin"]["creationMode"] = input_mode
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
    negative_prompt: str | None,
    first_frame_variant_id: str | None,
    replicate_kling_mode: str | None,
    replicate_kling_v3_mode: str | None,
    wan27_resolution: str | None,
    happy_horse_resolution: str | None,
    preserve_frames: bool,
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
        negative_prompt=negative_prompt,
        first_frame_variant_id=first_frame_variant_id,
        last_frame_variant_id=None,
        replicate_kling_mode=replicate_kling_mode,
        replicate_kling_v3_mode=replicate_kling_v3_mode,
        wan27_resolution=wan27_resolution,
        happy_horse_resolution=happy_horse_resolution,
        preserve_frames=preserve_frames,
        parent_generation_id=parent_generation_id,
        extension_metadata=extension_metadata,
    )
    now = now_iso()
    generation_record = task.setdefault("segmentGenerations", {}).get(gen_id)
    if isinstance(generation_record, dict):
        generation_record["isChunkInternal"] = True
        generation_record["chunkedRunId"] = run.get("runId")
        generation_record["chunkRole"] = "internal_chunk"
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
    method, path = parse_method_path(event)
    origin = _origin(event)

    options_response = handle_options(method, origin=origin)
    if options_response is not None:
        return options_response

    health_response = handle_health(method, path, origin=origin, response_fn=response)
    if health_response is not None:
        return health_response

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

    me_response = handle_me(
        method,
        path,
        user_id=user_id,
        claims=claims,
        store=store,
        origin=origin,
        response_fn=response,
        get_user_groups_fn=get_user_groups,
        is_admin_claims_fn=is_admin_claims,
        project_summary_fn=project_summary,
        can_access_project_fn=can_access_project,
    )
    if me_response is not None:
        return me_response

    canvas_response = handle_canvas_routes(
        method,
        path,
        event=event,
        origin=origin,
        user_id=user_id,
        claims=claims,
        json_model=_json_model,
        response_fn=response,
        error_response_fn=error_response,
        store=store,
        new_id_fn=new_id,
        now_iso_fn=now_iso,
        get_openai_api_key_fn=lambda: str(load_secret(settings.secrets_arn).get("OPENAI_API_KEY") or ""),
        get_canvas_system_prompt_fn=lambda profile: resolve_canvas_system_prompt(
            normalize_canvas_prompt_profiles_for_read(store.get_json(ADMIN_CANVAS_PROMPT_PROFILES_KEY)),
            profile,
        ),
        get_openai_pricing_entry_fn=lambda model: resolve_openai_prompt_wizard_pricing_entry(load_pricing_admin_config(store), model),
        get_openai_pricing_rates_fn=lambda model: resolve_openai_prompt_wizard_rates(load_pricing_admin_config(store), model),
        improve_lookdev_prompt_fn=improve_openai_lookdev_prompt,
        logger=logger,
        # --- New additive kwargs for project-scoped canvas routes ---
        can_access_project_fn=can_access_project,
        is_admin_claims_fn=is_admin_claims,
        asset_store=asset_store,
        assets_s3_client=boto3.client("s3"),
        assets_bucket=settings.assets_bucket,
        run_canvas_chat_fn=run_canvas_chat_engine,
    )
    if canvas_response is not None:
        return canvas_response

    admin_response = handle_admin_routes(
        method,
        path,
        event=event,
        claims=claims,
        store=store,
        origin=origin,
        response_fn=response,
        error_response_fn=error_response,
        now_iso_fn=now_iso,
        json_model=_json_model,
        new_id_fn=new_id,
    )
    if admin_response is not None:
        return admin_response

    external_api_response = handle_external_api_routes(
        method,
        path,
        event=event,
        origin=origin,
        user_id=user_id,
        claims=claims,
        store=store,
        asset_store=asset_store,
        queue=queue,
        json_model=_json_model,
        response_fn=response,
        error_response_fn=error_response,
        new_id_fn=new_id,
        now_iso_fn=now_iso,
        queue_job_fn=_queue_job,
        sanitize_prompt_fn=_sanitize_prompt,
        validate_api_asset_key_fn=_validate_api_asset_key,
        api_request_error_payload_fn=_api_request_error_payload,
        api_asset_paths_for_user_fn=_api_asset_paths_for_user,
        extract_query_fn=_extract_query,
        api_request_response_fn=_api_request_response,
        validate_api_video_mode_fn=_validate_api_video_mode,
        validate_video_model_prompt_fn=validate_video_model_prompt,
        get_video_model_capability_fn=get_video_model_capability,
        segment_generation_provider_name_fn=_segment_generation_provider_name,
        is_admin_claims_fn=is_admin_claims,
    )
    if external_api_response is not None:
        return external_api_response

    tasks_root_response = handle_tasks_root_routes(
        method,
        path,
        event=event,
        origin=origin,
        user_id=user_id,
        claims=claims,
        store=store,
        json_model=_json_model,
        response_fn=response,
        error_response_fn=error_response,
        new_id_fn=new_id,
        now_iso_fn=now_iso,
        queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
        normalize_task_name_fn=_normalize_task_name,
        unique_task_name_fn=_unique_task_name,
        build_file_prefix_fn=_build_file_prefix,
        load_task_or_404_fn=_load_task_or_404,
        maintain_segment_generations_fn=_maintain_segment_generations,
        cleanup_legacy_generation_qc_fn=_cleanup_legacy_generation_qc,
        cleanup_custom_reports_fn=_cleanup_custom_reports,
        task_summary_fn=_task_summary,
        default_task_workflow_id=DEFAULT_TASK_WORKFLOW_ID,
        is_admin_claims_fn=is_admin_claims,
    )
    if tasks_root_response is not None:
        return tasks_root_response

    task_detail_response = handle_task_detail_route(
        method,
        path,
        event=event,
        claims=claims,
        user_id=user_id,
        store=store,
        asset_store=asset_store,
        origin=origin,
        response_fn=response,
        error_response_fn=error_response,
        helpers={
            "load_task_or_404": _load_task_or_404,
            "load_task_or_404_any": _load_task_or_404_any,
            "is_admin_claims": is_admin_claims,
            "maintain_segment_generations": _maintain_segment_generations,
            "cleanup_legacy_generation_qc": _cleanup_legacy_generation_qc,
            "cleanup_custom_reports": _cleanup_custom_reports,
            "decorate_embedded_s3_keys": _decorate_embedded_s3_keys,
            "presigned_get_ttl_seconds": PRESIGNED_GET_TTL_SECONDS,
            "settings": settings,
            "default_task_workflow_id": DEFAULT_TASK_WORKFLOW_ID,
            "new_id": new_id,
        },
    )
    if task_detail_response is not None:
        return task_detail_response

    task_previz_response = handle_task_previz_route(
        method,
        path,
        event=event,
        user_id=user_id,
        store=store,
        origin=origin,
        json_model=_json_model,
        response_fn=response,
        error_response_fn=error_response,
        load_task_or_404_fn=_load_task_or_404,
        new_id_fn=new_id,
        now_iso_fn=now_iso,
    )
    if task_previz_response is not None:
        return task_previz_response

    task_path = parse_task_path(path)
    if task_path is not None:
        task_id, parts = task_path
        if len(parts) < 2:
            return error_response(404, "Not found", origin=origin)
        allow_admin_any_task = method == "DELETE" and len(parts) == 3 and parts[2] == "assets" and is_admin_claims(claims)
        try:
            task = _load_task_or_404_any(store, task_id) if allow_admin_any_task else _load_task_or_404(store, user_id, task_id)
        except KeyError:
            return error_response(404, "Task not found", origin=origin)

        logger.append_keys(taskId=task_id)

        task_asset_response = handle_task_asset_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            max_upload_bytes=settings.max_upload_bytes,
            presigned_get_ttl_seconds=PRESIGNED_GET_TTL_SECONDS,
            logger=logger,
            asset_paths_for_task_fn=_asset_paths_for_task,
            cleanup_custom_reports_fn=_cleanup_custom_reports,
        )
        if task_asset_response is not None:
            return task_asset_response

        task_previz_generate_response = handle_task_previz_generate_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
            sanitize_prompt_fn=_sanitize_prompt,
        )
        if task_previz_generate_response is not None:
            return task_previz_generate_response

        task_cleanup_response = handle_task_cleanup_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
            asset_paths_for_task_fn=_asset_paths_for_task,
            cleanup_track_response_fn=_cleanup_track_response,
            get_cleanup_track_fn=get_cleanup_track,
            resolve_first_mask_key_from_analysis_fn=resolve_first_mask_key_from_analysis,
            cleanup_custom_reports_fn=_cleanup_custom_reports,
        )
        if task_cleanup_response is not None:
            return task_cleanup_response

        task_character_generate_response = handle_task_character_generate_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
            sanitize_prompt_fn=_sanitize_prompt,
        )
        if task_character_generate_response is not None:
            return task_character_generate_response

        task_segment_response = handle_task_segment_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
            append_history_event_fn=_append_history_event,
            asset_paths_for_task_fn=_asset_paths_for_task,
            fps_fn=_fps,
            timecode_fn=_timecode,
            resolve_segment_frames_fn=_resolve_segment_frames,
            capture_segment_boundary_frames_fn=_capture_segment_boundary_frames,
            segment_crop_signature_fn=_segment_crop_signature,
            normalize_segment_crop_fn=_normalize_segment_crop,
            segment_model_limit_error_fn=_segment_model_limit_error,
            sanitize_prompt_fn=_sanitize_prompt,
            validate_video_model_mode_fn=validate_video_model_mode,
            validate_video_model_prompt_fn=validate_video_model_prompt,
            video_model_provider_fn=get_video_model_provider,
            audit_prompt_fn=_audit_prompt,
            create_manual_uploaded_segment_generation_fn=_create_manual_uploaded_segment_generation,
            normalize_uploaded_generated_video_fn=_normalize_uploaded_generated_video,
            video_probe_payload_fn=_video_probe_payload,
            resolve_frame_source_fn=_resolve_frame_source,
            get_openai_api_key_fn=lambda: str(load_secret(settings.secrets_arn).get("OPENAI_API_KEY") or ""),
            get_prompt_wizard_admin_config_fn=lambda: normalize_prompt_wizard_admin_config_for_read(
                store.get_json(ADMIN_PROMPT_WIZARD_CONFIG_KEY)
            ),
            get_openai_pricing_entry_fn=lambda model: resolve_openai_prompt_wizard_pricing_entry(load_pricing_admin_config(store), model),
            get_openai_pricing_rates_fn=lambda model: resolve_openai_prompt_wizard_rates(load_pricing_admin_config(store), model),
            improve_video_prompt_fn=improve_openai_video_prompt,
            logger=logger,
        )
        if task_segment_response is not None:
            return task_segment_response

        task_report_response = handle_task_report_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
            normalize_custom_report_refs_fn=_normalize_custom_report_refs,
            normalize_custom_report_tests_fn=_normalize_custom_report_tests,
            cleanup_custom_reports_fn=_cleanup_custom_reports,
            decorate_embedded_s3_keys_fn=_decorate_embedded_s3_keys,
            report_result_key_fn=lambda owner_id, report_task_id, report_id: S3JsonStore.report_result_key(owner_id, report_task_id, report_id),
            asset_paths_for_task_fn=_asset_paths_for_task,
            logger=logger,
        )
        if task_report_response is not None:
            return task_report_response

        task_generation_topaz_response = handle_task_generation_topaz_route(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
        )
        if task_generation_topaz_response is not None:
            return task_generation_topaz_response

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

        if method == "POST" and len(parts) == 5 and parts[2] == "exports" and parts[4] == "topaz-upscale":
            export_id = parts[3]
            exports = task.get("exports", [])
            export_item = next((entry for entry in exports if entry.get("exportId") == export_id), None)
            if not export_item:
                return error_response(404, "Export not found", origin=origin)
            if not export_item.get("outputKey"):
                return error_response(400, "Export output unavailable", origin=origin)
            req = _json_model(ExportTopazUpscaleRequest, event)
            upscale_state = export_item.get("topazUpscale") if isinstance(export_item.get("topazUpscale"), dict) else {}
            existing_job_id = upscale_state.get("jobId")
            existing_result_export_id = upscale_state.get("resultExportId")
            if (
                not req.force
                and isinstance(existing_job_id, str)
                and upscale_state.get("status") in {"queued", "running"}
            ):
                return response(
                    202,
                    {"jobId": existing_job_id, "exportId": existing_result_export_id, "alreadyRunning": True},
                    origin=origin,
                )

            result_export_id = new_id("exp")
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="export_topaz_upscale",
                payload={
                    "sourceExportId": export_id,
                    "resultExportId": result_export_id,
                    "request": {
                        "preset": req.preset,
                        "model": req.model,
                        "upscaleFactor": req.upscaleFactor,
                        "targetFps": req.targetFps,
                        "h264Output": req.h264Output,
                    },
                },
            )
            export_item["topazUpscale"] = {
                "status": "queued",
                "updatedAt": now_iso(),
                "jobId": job_id,
                "resultExportId": result_export_id,
                "preset": req.preset,
                "model": req.model,
                "upscaleFactor": req.upscaleFactor,
                "targetFps": req.targetFps,
                "h264Output": req.h264Output,
            }
            store.save_task(task)
            return response(202, {"jobId": job_id, "exportId": result_export_id}, origin=origin)

        if method == "POST" and len(parts) == 3 and parts[2] == "ingest":
            original = task.get("sourceMedia", {}).get("original") or task.get("video", {}).get("original")
            if not original:
                return error_response(400, "Upload source media first", origin=origin)
            try:
                asset_store.head_object(original["s3Key"])
            except ClientError:
                return error_response(400, "Uploaded source media not found in S3", origin=origin)
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

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "manual-upload" and parts[5] == "upload" and parts[6] == "init":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ManualFrameUploadInitRequest, event)
            upload_id = new_id("mfu")
            paths = _asset_paths_for_task(task)
            upload_key = paths.manual_frame_upload(frame_id, upload_id, req.filename)
            return response(
                200,
                {
                    "uploadKey": upload_key,
                    "uploadUrl": asset_store.presign_put(upload_key, expires=900, content_type=req.contentType),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 7 and parts[2] == "frames" and parts[4] == "manual-upload" and parts[5] == "upload" and parts[6] == "complete":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ManualFrameUploadCompleteRequest, event)
            paths = _asset_paths_for_task(task)
            expected_prefix = f"{paths.task_prefix()}/frames/{frame_id}/manual_uploads/"
            if not req.uploadKey.startswith(expected_prefix):
                return error_response(400, "Upload key is outside this frame manual-upload path", origin=origin)
            try:
                asset_store.head_object(req.uploadKey)
            except ClientError:
                return error_response(404, "Uploaded edited frame file not found", origin=origin)

            original_bytes = asset_store.read_bytes(frame["captureKey"])
            uploaded_bytes = asset_store.read_bytes(req.uploadKey)
            normalized_png = _normalize_uploaded_refine_image(original_bytes=original_bytes, uploaded_bytes=uploaded_bytes)
            variant = _create_manual_uploaded_frame_variant(
                task=task,
                frame_id=frame_id,
                filename=req.filename,
            )
            asset_store.put_bytes(variant["outputKey"], normalized_png, content_type="image/png")
            try:
                asset_store.delete_object(req.uploadKey)
            except Exception:
                pass
            frame.setdefault("variants", []).append(variant)
            frame["selectedVariantId"] = variant["variantId"]
            task.setdefault("history", []).append(
                {
                    "type": "MANUAL_FRAME_UPLOAD_APPLIED",
                    "frameId": frame_id,
                    "timestamp": now_iso(),
                    "userId": user_id,
                    "details": {
                        "variantId": variant["variantId"],
                        "filename": req.filename,
                    },
                }
            )
            return response(
                200,
                {
                    "variant": {
                        "variantId": variant["variantId"],
                        "imageUrl": asset_store.presign_get(variant["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS),
                    }
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "frames" and parts[4] == "manual-upload" and parts[5] == "import":
            frame_id = parts[3]
            frame = task.get("frames", {}).get(frame_id)
            if not frame:
                return error_response(404, "Frame not found", origin=origin)
            req = _json_model(ManualFrameImportRequest, event)
            source = req.sources[0]
            source_key = str(source.sourceKey or "").strip()
            if not source_key.startswith("users/"):
                return error_response(400, "Imported frame source must come from the asset library", origin=origin)

            source_identity = _parse_task_identity_from_asset_key(source_key)
            if not source_identity:
                return error_response(400, "Imported frame source must belong to a task asset", origin=origin)
            source_user_id, source_task_id = source_identity
            is_same_user_asset = source_user_id == str(task.get("userId") or "").strip()
            if not is_same_user_asset:
                source_task = store.load_task(source_user_id, source_task_id)
                if not isinstance(source_task, dict):
                    return error_response(404, "Imported frame source task not found", origin=origin)
                source_project_id = str(source_task.get("projectId") or "").strip()
                if not source_project_id:
                    return error_response(403, "Imported frame source is not available to this user", origin=origin)
                source_project = store.load_project(source_project_id)
                if not can_access_project(source_project, user_id=user_id, is_admin=is_admin_claims(claims)):
                    return error_response(403, "Imported frame source is outside your accessible asset library", origin=origin)

            try:
                original_bytes = asset_store.read_bytes(frame["captureKey"])
                source_bytes = asset_store.read_bytes(source_key)
            except ClientError:
                return error_response(404, "Imported frame source file not found", origin=origin)

            normalized_png = _normalize_uploaded_refine_image(original_bytes=original_bytes, uploaded_bytes=source_bytes)
            requested_filename = str(source.filename or "").strip()
            source_filename = requested_filename or Path(source_key).name or "imported_frame.png"
            variant = _create_manual_uploaded_frame_variant(
                task=task,
                frame_id=frame_id,
                filename=source_filename,
            )
            variant_generation_settings = dict(variant.get("generationSettings") or {})
            variant_generation_settings.update(
                {
                    "workflow": "manual_frame_import",
                    "importedSourceKey": source_key,
                    "importedSourceType": str(source.sourceType or "uploaded"),
                    "originTaskId": source.originTaskId or source_task_id,
                }
            )
            variant["generationSettings"] = variant_generation_settings
            asset_store.put_bytes(variant["outputKey"], normalized_png, content_type="image/png")
            frame.setdefault("variants", []).append(variant)
            frame["selectedVariantId"] = variant["variantId"]
            task.setdefault("history", []).append(
                {
                    "type": "MANUAL_FRAME_IMPORT_APPLIED",
                    "frameId": frame_id,
                    "timestamp": now_iso(),
                    "userId": user_id,
                    "details": {
                        "variantId": variant["variantId"],
                        "sourceKey": source_key,
                        "sourceType": str(source.sourceType or "uploaded"),
                        "originTaskId": source.originTaskId or source_task_id,
                    },
                }
            )
            store.save_task(task)
            return response(
                201,
                {
                    "variant": {
                        "variantId": variant["variantId"],
                        "imageUrl": asset_store.presign_get(variant["outputKey"], expires=PRESIGNED_GET_TTL_SECONDS),
                    }
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

        if method == "POST" and len(parts) == 6 and parts[2] == "edit-video" and parts[3] == "references" and parts[4] == "upload" and parts[5] == "init":
            req = _json_model(EditVideoReferenceUploadRequest, event)
            if not req.contentType.lower().startswith("image/"):
                return error_response(400, "Reference files must be images", origin=origin)
            reference_id = new_id("evref")
            paths = _asset_paths_for_task(task)
            key = paths.edit_video_reference(reference_id, req.filename)
            return response(
                200,
                {
                    "referenceId": reference_id,
                    "key": key,
                    "uploadUrl": asset_store.presign_put(key, expires=900, content_type=req.contentType),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 6 and parts[2] == "edit-video" and parts[3] == "references" and parts[4] == "upload" and parts[5] == "complete":
            req = _json_model(EditVideoReferenceUploadCompleteRequest, event)
            references = task.setdefault("editVideoReferences", [])
            key = req.uploadKey
            if not key.startswith(f"users/{task['userId']}/tasks/{task_id}/"):
                return error_response(400, "Invalid upload key", origin=origin)
            now = now_iso()
            reference = {
                "referenceId": req.referenceId,
                "type": "uploaded",
                "filename": req.filename,
                "model": None,
                "prompt": None,
                "key": key,
                "createdAt": now,
                "updatedAt": now,
            }
            references.append(reference)
            task.setdefault("history", []).append(
                {
                    "type": "EDIT_VIDEO_REFERENCE_UPLOADED",
                    "timestamp": now,
                    "userId": user_id,
                    "details": {"referenceId": reference["referenceId"], "filename": req.filename},
                }
            )
            store.save_task(task)
            return response(
                201,
                {"reference": {**reference, "imageUrl": asset_store.presign_get(key, expires=PRESIGNED_GET_TTL_SECONDS)}},
                origin=origin,
            )

        if method == "POST" and len(parts) == 5 and parts[2] == "generation-audio-reference" and parts[3] == "upload" and parts[4] == "init":
            if not is_source_video_workflow_id(str(task.get("workflowId") or DEFAULT_TASK_WORKFLOW_ID)):
                return error_response(400, "Generation audio references are only available in the source video workflow", origin=origin)
            req = _json_model(GenerationAudioReferenceUploadRequest, event)
            if not req.contentType.lower().startswith("audio/"):
                return error_response(400, "Generation audio references must be audio files", origin=origin)
            reference_id = new_id("gaud")
            paths = _asset_paths_for_task(task)
            key = paths.generation_audio_reference_original(reference_id, req.filename)
            return response(
                200,
                {
                    "referenceId": reference_id,
                    "key": key,
                    "uploadUrl": asset_store.presign_put(key, expires=900, content_type=req.contentType),
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 5 and parts[2] == "generation-audio-reference" and parts[3] == "upload" and parts[4] == "complete":
            if not is_source_video_workflow_id(str(task.get("workflowId") or DEFAULT_TASK_WORKFLOW_ID)):
                return error_response(400, "Generation audio references are only available in the source video workflow", origin=origin)
            req = _json_model(GenerationAudioReferenceUploadCompleteRequest, event)
            key = req.uploadKey
            if not key.startswith(f"users/{task['userId']}/tasks/{task_id}/"):
                return error_response(400, "Invalid upload key", origin=origin)
            previous_reference = task.get("generationAudioReference") if isinstance(task.get("generationAudioReference"), dict) else None
            previous_keys = [
                str(previous_reference.get(field) or "").strip()
                for field in ("originalKey", "editSourceKey", "previewKey", "waveformKey")
            ] if previous_reference else []
            now = now_iso()
            paths = _asset_paths_for_task(task)
            edit_source_key = paths.generation_audio_reference_edit_source(req.referenceId)
            preview_key = paths.generation_audio_reference_preview(req.referenceId)
            waveform_key = paths.generation_audio_reference_waveform(req.referenceId)
            waveform_width = 1280
            waveform_height = 240
            try:
                original_bytes = asset_store.read_bytes(key)
            except ClientError:
                return error_response(400, "Uploaded audio file not found", origin=origin)
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                original_path = td_path / req.filename
                original_path.write_bytes(original_bytes)
                edit_source_path = td_path / "audio_edit_source.wav"
                preview_path = td_path / "audio_preview.m4a"
                waveform_path = td_path / "audio_waveform.png"
                transcode_audio_edit_source(str(original_path), str(edit_source_path))
                transcode_audio_preview(str(original_path), str(preview_path))
                generate_waveform_png(str(edit_source_path), str(waveform_path), width=waveform_width, height=waveform_height)
                edit_probe = ffprobe_audio(str(edit_source_path))
                asset_store.put_bytes(edit_source_key, edit_source_path.read_bytes(), content_type="audio/wav")
                asset_store.put_bytes(preview_key, preview_path.read_bytes(), content_type="audio/mp4")
                asset_store.put_bytes(waveform_key, waveform_path.read_bytes(), content_type="image/png")
            task["generationAudioReference"] = {
                "referenceId": req.referenceId,
                "filename": req.filename,
                "originalKey": key,
                "editSourceKey": edit_source_key,
                "previewKey": preview_key,
                "waveformKey": waveform_key,
                "waveformWidth": waveform_width,
                "waveformHeight": waveform_height,
                "durationSec": round(float(edit_probe.get("duration_sec") or 0.0), 4),
                "sampleRate": int(edit_probe.get("sample_rate") or 48000),
                "channels": int(edit_probe.get("channels") or 2),
                "codec": str(edit_probe.get("codec") or "pcm_s16le"),
                "bitRate": int(edit_probe.get("bit_rate") or 0),
                "createdAt": str(previous_reference.get("createdAt") or now) if previous_reference else now,
                "updatedAt": now,
            }
            task.setdefault("history", []).append(
                {
                    "type": "GENERATION_AUDIO_REFERENCE_UPLOADED",
                    "timestamp": now,
                    "userId": user_id,
                    "details": {"referenceId": req.referenceId, "filename": req.filename},
                }
            )
            store.save_task(task)
            for previous_key in previous_keys:
                if previous_key and previous_key != key and previous_key not in {edit_source_key, preview_key, waveform_key}:
                    try:
                        asset_store.delete_object(previous_key)
                    except ClientError:
                        logger.warning("Generation audio reference delete failed", extra={"taskId": task_id, "key": previous_key})
            generation_audio_reference = task["generationAudioReference"]
            return response(
                201,
                {
                    "reference": {
                        **generation_audio_reference,
                        "originalUrl": asset_store.presign_get(key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "editSourceUrl": asset_store.presign_get(edit_source_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "previewUrl": asset_store.presign_get(preview_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        "waveformUrl": asset_store.presign_get(waveform_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    }
                },
                origin=origin,
            )

        if method == "POST" and len(parts) == 5 and parts[2] == "edit-video" and parts[3] == "references" and parts[4] == "import":
            req = _json_model(EditVideoReferenceImportRequest, event)
            references = task.setdefault("editVideoReferences", [])
            current_task_prefix = f"users/{task['userId']}/tasks/{task_id}/"
            user_prefix = f"users/{task['userId']}/"
            existing_by_source_key: dict[str, dict[str, Any]] = {}
            for item in references:
                if not isinstance(item, dict):
                    continue
                existing_key = str(item.get("key") or "").strip()
                origin_key = str(item.get("originSourceKey") or "").strip()
                if existing_key:
                    existing_by_source_key.setdefault(existing_key, item)
                if origin_key:
                    existing_by_source_key.setdefault(origin_key, item)

            now = now_iso()
            imported_references: list[dict[str, Any]] = []
            for source in req.sources:
                source_key = str(source.sourceKey or "").strip()
                if not source_key.startswith(user_prefix):
                    return error_response(400, "Reference imports must come from the same user library", origin=origin)

                existing_reference = existing_by_source_key.get(source_key)
                if existing_reference:
                    existing_key = str(existing_reference.get("key") or "").strip()
                    imported_references.append(
                        {
                            **existing_reference,
                            "imageUrl": asset_store.presign_get(existing_key, expires=PRESIGNED_GET_TTL_SECONDS),
                        }
                    )
                    continue

                reference_id = new_id("evref")
                requested_filename = str(source.filename or "").strip()
                source_filename = requested_filename or Path(source_key).name or f"{reference_id}.png"
                target_key = _asset_paths_for_task(task).edit_video_reference(reference_id, source_filename)
                content_type = {
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".webp": "image/webp",
                }.get(Path(source_filename).suffix.lower(), "image/png")
                asset_store.copy_object(source_key, target_key, content_type=content_type)

                source_type = str(source.sourceType or "uploaded")
                reference_type = "uploaded" if source_type == "uploaded" else "generated"
                reference = {
                    "referenceId": reference_id,
                    "type": reference_type,
                    "filename": source_filename,
                    "model": None,
                    "prompt": None,
                    "key": target_key,
                    "originSourceKey": source_key,
                    "originTaskId": source.originTaskId,
                    "originSourceType": source_type,
                    "createdAt": now,
                    "updatedAt": now,
                }
                references.append(reference)
                existing_by_source_key[source_key] = reference
                existing_by_source_key[target_key] = reference
                imported_references.append(
                    {
                        **reference,
                        "imageUrl": asset_store.presign_get(target_key, expires=PRESIGNED_GET_TTL_SECONDS),
                    }
                )

            if imported_references:
                task.setdefault("history", []).append(
                    {
                        "type": "EDIT_VIDEO_REFERENCES_IMPORTED",
                        "timestamp": now,
                        "userId": user_id,
                        "details": {"count": len(imported_references)},
                    }
                )
                store.save_task(task)
            return response(201, {"references": imported_references}, origin=origin)

        if method == "POST" and len(parts) == 5 and parts[2] == "edit-video" and parts[3] == "references" and parts[4] == "generate":
            req = _json_model(EditVideoReferenceGenerateRequest, event)
            prompt = _sanitize_prompt(req.prompt)
            if not prompt:
                return error_response(400, "Prompt is required", origin=origin)
            if req.model == "nano_banana_pro" and req.aspectRatio and req.aspectRatio not in NANO_BANANA_PRO_SUPPORTED_ASPECT_RATIOS:
                allowed = ", ".join(sorted(NANO_BANANA_PRO_SUPPORTED_ASPECT_RATIOS))
                return error_response(
                    400,
                    f"Nano Banana Pro does not support aspect ratio {req.aspectRatio}. Allowed ratios: {allowed}",
                    origin=origin,
                )
            if req.model == "nano_banana" and len(req.selectedReferenceIds or []) > NANO_BANANA_MAX_REFERENCE_IMAGES:
                return error_response(
                    400,
                    f"Nano Banana supports up to {NANO_BANANA_MAX_REFERENCE_IMAGES} reference images in this tool. Remove some references or use Nano Banana Pro.",
                    origin=origin,
                )
            references = task.setdefault("editVideoReferences", [])
            if req.selectedReferenceIds:
                reference_by_id = {
                    str(item.get("referenceId") or ""): item
                    for item in references
                    if isinstance(item, dict) and item.get("referenceId")
                }
                for reference_id in req.selectedReferenceIds:
                    reference = reference_by_id.get(reference_id)
                    if not reference:
                        return error_response(400, f"Reference image not found: {reference_id}", origin=origin)
                    key = str(reference.get("key") or "").strip()
                    status = str(reference.get("status") or "complete").lower()
                    if status in {"queued", "running"} or not key:
                        return error_response(400, f"Reference image is not ready yet: {reference_id}", origin=origin)
                    if not key.startswith(f"users/{task['userId']}/tasks/{task_id}/"):
                        return error_response(400, f"Invalid reference image key: {reference_id}", origin=origin)
            reference_id = new_id("evref")
            now = now_iso()
            job_id = _queue_job(
                store=store,
                queue=queue,
                user_id=user_id,
                task_id=task_id,
                job_type="edit_video_reference_generate",
                payload={
                    "referenceId": reference_id,
                    "model": req.model,
                    "prompt": prompt,
                    "aspectRatio": req.aspectRatio,
                    "selectedReferenceIds": list(req.selectedReferenceIds or []),
                },
            )
            reference = {
                "referenceId": reference_id,
                "type": "generated",
                "filename": f"{reference_id}.png",
                "model": req.model,
                "prompt": prompt,
                "aspectRatio": req.aspectRatio,
                "key": "",
                "status": "queued",
                "jobId": job_id,
                "createdAt": now,
                "updatedAt": now,
            }
            references.append(reference)
            task.setdefault("history", []).append(
                {
                    "type": "EDIT_VIDEO_REFERENCE_GENERATION_QUEUED",
                    "timestamp": now,
                    "userId": user_id,
                    "details": {"referenceId": reference_id, "jobId": job_id, "model": req.model},
                }
            )
            store.save_task(task)
            return response(202, {"reference": reference, "jobId": job_id}, origin=origin)

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
                    "lumaUniModel": req.lumaUniModel,
                    "lumaUniStyle": req.lumaUniStyle,
                    "lumaUniOutputFormat": req.lumaUniOutputFormat,
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

        if method == "POST" and len(parts) == 5 and parts[2] == "segments" and parts[4] == "chunked-generate":
            segment_id = parts[3]
            segment = next((s for s in task.get("segments", []) if s["segmentId"] == segment_id), None)
            if not segment:
                return error_response(404, "Segment not found", origin=origin)

            req = _json_model(ChunkedSegmentGenerateRequest, event)
            if not supports_chunked_generation(req.lumaModel):
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
                opening_prompt = _sanitize_prompt(req.openingPrompt) if req.openingPrompt else None
                continuation_prompt = _sanitize_prompt(req.continuationPrompt) if req.continuationPrompt else None
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            effective_continuation_prompt = continuation_prompt or opening_prompt
            try:
                validate_video_model_prompt(req.lumaModel, opening_prompt)
                validate_video_model_prompt(req.lumaModel, effective_continuation_prompt, prompt_label="continuation prompt")
            except ValueError as exc:
                return error_response(400, str(exc), origin=origin)
            if opening_prompt:
                logger.info(
                    "Queueing chunked generation",
                    extra={**_audit_prompt(opening_prompt), "taskId": task_id, "segmentId": segment_id, "chunked": True},
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
                        internal_only=True,
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
                "openingPrompt": opening_prompt,
                "continuationPrompt": effective_continuation_prompt,
                "firstFrameVariantId": first_variant_id,
                    "replicateKlingMode": req.replicateKlingMode,
                    "replicateKlingV3Mode": req.replicateKlingV3Mode,
                    "wan27Resolution": req.wan27Resolution,
                    "happyHorseResolution": req.happyHorseResolution,
                    "preserveFrames": bool(req.preserveFrames),
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
                        "coverageStartFrame": absolute_segment_start + int(window["coverageStartFrame"]),
                        "coverageEndFrameExclusive": absolute_segment_start + int(window["coverageEndFrameExclusive"]),
                        "coverageDurationFrames": int(window["coverageDurationFrames"]),
                        "coverageTrimStartFrames": int(window["coverageTrimStartFrames"]),
                        "coverageTrimEndFrames": int(window["coverageTrimEndFrames"]),
                        "overlapFrames": int(window["overlapFrames"]),
                        "anchorFramesFromPrevious": int(window["anchorFramesFromPrevious"]),
                        "alignmentFrameIndex": absolute_segment_start + int(window["startFrame"]),
                        "anchorSource": "initial_variant" if idx == 0 else "previous_generation",
                        "anchorFrameId": chunk_segment.get("startFrameId"),
                        "anchorVariantId": first_variant_id if idx == 0 else None,
                        "status": "planned",
                        "reviewStatus": "pending" if idx > 0 else "running",
                        "prompt": opening_prompt if idx == 0 else effective_continuation_prompt,
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
                prompt=first_chunk.get("prompt"),
                negative_prompt=None,
                first_frame_variant_id=first_variant_id,
                replicate_kling_mode=req.replicateKlingMode,
                replicate_kling_v3_mode=req.replicateKlingV3Mode,
                wan27_resolution=req.wan27Resolution,
                happy_horse_resolution=req.happyHorseResolution,
                preserve_frames=bool(req.preserveFrames),
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

        task_generation_extend_response = handle_task_generation_extend_route(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            now_iso_fn=now_iso,
            supports_chunked_generation_fn=supports_chunked_generation,
            get_video_model_capability_fn=get_video_model_capability,
            fps_fn=_fps,
            plan_chunk_windows_fn=_plan_chunk_windows,
            resolve_segment_frames_fn=_resolve_segment_frames,
            create_segment_record_fn=_create_segment_record,
            segment_model_limit_error_fn=_segment_model_limit_error,
            video_model_label_fn=_video_model_label,
            sanitize_prompt_fn=_sanitize_prompt,
            copy_generated_anchor_to_frame_variant_fn=_copy_generated_anchor_to_frame_variant,
            queue_chunk_generation_for_run_fn=lambda **kwargs: _queue_chunk_generation_for_run(queue=queue, **kwargs),
            append_history_event_fn=_append_history_event,
            new_id_fn=new_id,
            queue_segment_generation_record_fn=lambda **kwargs: _queue_segment_generation_record(queue=queue, **kwargs),
        )
        if task_generation_extend_response is not None:
            return task_generation_extend_response

        task_generation_lengthen_response = handle_task_generation_lengthen_route(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            now_iso_fn=now_iso,
            queue_segment_generation_record_fn=lambda **kwargs: _queue_segment_generation_record(queue=queue, **kwargs),
        )
        if task_generation_lengthen_response is not None:
            return task_generation_lengthen_response

        task_chunked_control_response = handle_task_chunked_control_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            asset_store=asset_store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
            sanitize_prompt_fn=_sanitize_prompt,
            append_history_event_fn=_append_history_event,
            copy_generated_anchor_to_frame_variant_fn=_copy_generated_anchor_to_frame_variant,
            queue_chunk_generation_for_run_fn=lambda **kwargs: _queue_chunk_generation_for_run(queue=queue, **kwargs),
            logger=logger,
        )
        if task_chunked_control_response is not None:
            return task_chunked_control_response

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
                    "temporalFeatherStartFrames": req.temporalFeatherStartFrames,
                    "temporalFeatherEndFrames": req.temporalFeatherEndFrames,
                    "generationAdjustments": generation_adjustments_payload,
                },
            )
            return response(202, {"jobId": job_id}, origin=origin)

        task_generation_post_response = handle_task_generation_post_routes(
            method,
            task_id=task_id,
            parts=parts,
            event=event,
            origin=origin,
            user_id=user_id,
            task=task,
            store=store,
            json_model=_json_model,
            response_fn=response,
            error_response_fn=error_response,
            new_id_fn=new_id,
            now_iso_fn=now_iso,
            queue_job_fn=lambda **kwargs: _queue_job(queue=queue, **kwargs),
        )
        if task_generation_post_response is not None:
            return task_generation_post_response

    job_response = handle_job_status(
        method,
        path,
        event=event,
        user_id=user_id,
        store=store,
        origin=origin,
        response_fn=response,
        error_response_fn=error_response,
    )
    if job_response is not None:
        return job_response

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
