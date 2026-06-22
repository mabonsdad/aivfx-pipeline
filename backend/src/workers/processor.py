from __future__ import annotations

import json
import hashlib
import math
import re
import subprocess
import tempfile
import time
import base64
from datetime import datetime, timezone
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from statistics import median
from typing import Any

import boto3
import requests
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

from src.core.asset_origin import build_asset_origin
from src.core.assets import ApiAssetPaths, AssetPaths, AssetStore
from src.core.cost_tracking import (
    attach_usage_summary,
    build_usage_record,
    estimate_cost_from_pricing_entry,
    load_pricing_admin_config,
    resolve_pricing_entry,
)
from src.core.ffmpeg import (
    FFMPEG_BIN,
    compose_cropped_generated_segment,
    extract_audio_track,
    extract_audio_segment,
    extract_frame_png,
    extract_segment_by_frames,
    ffprobe_audio,
    ffprobe_video,
    generate_thumbnail_strip,
    generate_waveform_png,
    merge_with_segment_replacement,
    stitch_video_segments,
    transcode_audio_edit_source,
    transcode_audio_preview,
    trim_video_to_duration,
    trim_and_retime_video_uniform,
    transcode_for_preview,
    transcode_for_provider,
    transcode_preserving_frame_count,
    transcode_to_cfr,
)
from src.core.ids import new_id, prompt_hash
from src.core.logger import Logger
from src.core.pdf import extract_pdf_contents
from src.core.secrets import load_secret
from src.core.store import S3JsonStore, now_iso
from src.generation import (
    LUMA_API_ALLOWED_MODES,
    get_video_model_capability,
    get_video_model_provider,
    resolve_video_model_limit_error,
    resolve_video_model_provider_fps,
)
from src.integrations.gemini import (
    generate_image_edit as generate_gemini_image_edit,
    generate_image_from_references as generate_gemini_image_from_references,
)
from src.integrations.fal import (
    get_queue_result as get_fal_queue_result,
    get_queue_status as get_fal_queue_status,
    submit_happy_horse_image_to_video,
    submit_happy_horse_video_edit,
    submit_omnihuman_v15,
    submit_sora_2_image_to_video_pro,
    submit_seedance_reference_to_video,
    submit_topaz_video_upscale,
)
from src.jobs.queue import JobQueue
from src.integrations.kling import (
    create_start_end_generation as create_kling_start_end_generation,
    get_generation_response as get_kling_generation_response,
)
from src.integrations.luma import (
    create_uni_image_generation,
    create_video_edit_generation,
    create_uni_image_edit_generation,
    get_video_generation,
    get_uni_generation,
    parse_uni_output_url,
    wait_for_uni_generation_complete,
)
from src.integrations.openai_images import (
    generate_image_edit as generate_openai_image_edit,
    generate_image_from_references as generate_openai_image_from_references,
)
from src.integrations.replicate import (
    REPLICATE_KLING_O1_VERSION,
    REPLICATE_KLING_V3_OMNI_VIDEO_VERSION,
    create_official_model_prediction as create_replicate_official_model_prediction,
    create_prediction as create_replicate_prediction,
    get_prediction as get_replicate_prediction,
)
from src.integrations.runware import patch_edit_aceplusplus, patch_edit_flux_fill
from src.integrations.runway import (
    create_character_performance,
    create_ephemeral_upload,
    create_video_to_video,
    create_image_to_video,
    get_task as get_runway_task,
    upload_to_ephemeral,
)
from src.integrations.runware_video import (
    RUNWARE_VEO_31_FAST_MODEL,
    RUNWARE_VEO_31_MODEL,
    RUNWARE_WAN22_A14B_MODEL,
    RUNWARE_WAN22_ANIMATE_MODEL,
    create_veo_first_last_generation,
    create_veo_video_extension,
    create_wan22_a14b_generation,
    create_wan22_animate_generation,
    get_generation_response as get_runware_video_generation_response,
)
from src.quality_match.apply_flow import apply_quality_match_to_task
from src.quality_match.sam_assist import request_sam2_proposals
from src.quality_match.service import QualityMatchSettings
from src.video_cleanup.apply_flow import render_cleaned_video
from src.video_cleanup.diagnostics import compute_frame_diagnostic, summarize_diagnostics
from src.video_cleanup.models import VideoCleanupSettings
from src.video_cleanup.preview import build_preview_assets
from src.video_cleanup.service import (
    add_or_replace_keyframe,
    create_cleanup_generation_variant,
    get_cleanup_track,
    get_generation as get_cleanup_generation,
    get_segment as get_cleanup_segment,
    sort_keyframes,
)
from src.video_cleanup.tracking import normalize_mask_bytes, propagate_mask_to_frame, propagate_window, stitch_seeded_masks
from src.workers.dispatch import dispatch_job
from src.workers.jobs import build_job_handlers, handle_job_failure

logger = Logger()
SOURCE_VIDEO_MAX_DURATION_SECONDS = 120


class _WorkerStoreProxy:
    def __init__(self, store: S3JsonStore):
        self._store = store

    def __getattr__(self, name: str) -> Any:
        return getattr(self._store, name)

    def save_task(
        self,
        task: dict[str, Any],
        *,
        snapshot: bool = True,
        merge_on_conflict: bool = True,
    ) -> dict[str, Any]:
        return self._store.save_task(task, snapshot=snapshot, merge_on_conflict=merge_on_conflict)


def _task_project_id(task: dict[str, Any]) -> str | None:
    value = str(task.get("projectId") or "").strip()
    return value or None


def _record_usage(
    *,
    store: S3JsonStore,
    user_id: str,
    source: str,
    tool_origin: str,
    request_type: str,
    provider: str,
    provider_model: str | None,
    app_model_id: str | None,
    target_record: dict[str, Any] | None = None,
    task: dict[str, Any] | None = None,
    workflow_id: str | None = None,
    task_id: str | None = None,
    segment_id: str | None = None,
    project_id: str | None = None,
    request_id: str | None = None,
    asset_id: str | None = None,
    asset_kind: str | None = None,
    usage: dict[str, Any] | None = None,
    duration_sec: float | None = None,
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    resolution_label: str | None = None,
    image_count: int = 1,
    operation: str | None = None,
    reference_count: int = 0,
    notes: str | None = None,
) -> dict[str, Any] | None:
    try:
        pricing_entry = resolve_pricing_entry(
            load_pricing_admin_config(store),
            app_model_id=app_model_id,
            provider_model=provider_model,
        )
        estimate = estimate_cost_from_pricing_entry(
            pricing_entry,
            usage=usage,
            duration_sec=duration_sec,
            width=width,
            height=height,
            fps=fps,
            resolution_label=resolution_label,
            image_count=image_count,
            operation=operation,
            reference_count=reference_count,
        )
        usage_record = build_usage_record(
            usage_record_id=new_id("usage"),
            now_iso=now_iso(),
            user_id=user_id,
            provider=provider,
            provider_model=provider_model,
            app_model_id=app_model_id,
            request_type=request_type,
            source=source,
            tool_origin=tool_origin,
            workflow_id=workflow_id or (str(task.get("workflowId") or "").strip() if isinstance(task, dict) else None),
            task_id=task_id or (str(task.get("taskId") or "").strip() if isinstance(task, dict) else None),
            segment_id=segment_id,
            project_id=project_id or (_task_project_id(task) if isinstance(task, dict) else None),
            request_id=request_id,
            asset_id=asset_id,
            asset_kind=asset_kind,
            pricing_entry=pricing_entry,
            estimate=estimate,
            notes=notes,
        )
        store.save_usage_record(usage_record)
        if isinstance(target_record, dict):
            attach_usage_summary(target_record, usage_record)
        return usage_record
    except Exception:
        logger.exception(
            "usage_tracking_failed",
            extra={
                "userId": user_id,
                "taskId": task_id or (task.get("taskId") if isinstance(task, dict) else None),
                "segmentId": segment_id,
                "requestId": request_id,
                "assetId": asset_id,
                "source": source,
                "provider": provider,
                "providerModel": provider_model,
                "appModelId": app_model_id,
            },
        )
        return None


def _reference_content_type_from_key(key: str) -> str:
    normalized = key.lower()
    if normalized.endswith(".jpg") or normalized.endswith(".jpeg"):
        return "image/jpeg"
    if normalized.endswith(".webp"):
        return "image/webp"
    return "image/png"


def _normalize_generated_reference_png(image_bytes: bytes) -> bytes:
    with Image.open(BytesIO(image_bytes)) as source:
        output = BytesIO()
        ImageOps.exif_transpose(source).convert("RGBA").save(output, format="PNG")
    return output.getvalue()

FULL_VIDEO_MAX_BYTES = 100 * 1024 * 1024
REPLICATE_VIDEO_MAX_BYTES = 200 * 1024 * 1024
MAX_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024
WAN27_DATA_URL_MAX_BYTES = 6_800_000
SEEDANCE_REFERENCE_VIDEO_MAX_BYTES = 49_000_000
KLING_SUPPORTED_DURATIONS = (5, 10)
LTX23_SUPPORTED_DURATIONS = (6, 8, 10)
LTX23_SUPPORTED_FPS = (24, 25, 48, 50)
QC_SAMPLE_FPS = 3
QC_ANALYSIS_MAX_FRAMES = 90
QC_DIFF_THRESHOLD = 32
QC_OUTSIDE_LEAK_BUDGET_PCT = 0.50
QC_BOUNDARY_RING_PX = 8
ADV_QC_PATCH_SIZE = 64
ADV_QC_STRIDE = 24
ADV_QC_OUTER_RING_PX = 24
ADV_QC_TOP_REGION_COUNT = 8
MOTION_SYNC_SAMPLE_FPS = 6
MOTION_SYNC_MAX_LAG_SEC = 3.0
TOPAZ_UPSCALE_TIMEOUT_SEC = 7200
RUNWARE_VIDEO_POLL_TIMEOUT_SEC = 12 * 60
FRAME_REPORT_ADVANCED_TESTS = {
    "frame_composite",
    "frame_perceptual",
    "frame_boundary",
    "frame_sharpness",
    "frame_naturalness",
    "frame_texture",
}


class JobCancelledError(RuntimeError):
    pass


def _cancel_message_for_job(job: dict[str, Any]) -> str:
    reason = str(job.get("cancelReason") or "").strip()
    return f"Cancelled by user: {reason}" if reason else "Cancelled by user"


def _raise_if_cancel_requested(job: dict[str, Any], store: S3JsonStore) -> None:
    user_id = str(job.get("userId") or "")
    job_id = str(job.get("jobId") or "")
    if not user_id or not job_id:
        return
    latest_job = store.load_job(user_id, job_id)
    if not isinstance(latest_job, dict) or not latest_job.get("cancelRequestedAt"):
        return
    job.update(latest_job)
    message = _cancel_message_for_job(latest_job)
    if str(job.get("status") or "").lower() != "failed":
        job["status"] = "failed"
        job["error"] = message
        job["finishedAt"] = now_iso()
        store.save_job(job)
    raise JobCancelledError(message)
def _segment_generation_provider_name(model: str) -> str:
    return get_video_model_provider(model)


RUNWARE_WAN22_ALLOWED_RESOLUTIONS: tuple[tuple[int, int], ...] = (
    (848, 480),
    (1024, 576),
    (1280, 720),
    (640, 640),
    (768, 768),
    (960, 960),
    (480, 848),
    (576, 1024),
    (720, 1280),
    (736, 560),
    (896, 672),
    (1104, 832),
    (560, 736),
    (672, 896),
    (832, 1104),
)


def _target_by_orientation(
    width: int,
    height: int,
    *,
    landscape: tuple[int, int],
    portrait: tuple[int, int],
) -> tuple[int, int]:
    source_ratio = (width / height) if height else 1.0
    landscape_ratio = landscape[0] / landscape[1]
    portrait_ratio = portrait[0] / portrait[1]
    landscape_delta = abs(math.log(source_ratio / landscape_ratio))
    portrait_delta = abs(math.log(source_ratio / portrait_ratio))
    return landscape if landscape_delta <= portrait_delta else portrait


def _nearest_runware_wan22_resolution(width: int, height: int) -> tuple[int, int]:
    source_ratio = (width / height) if height else 1.0
    ranked = sorted(
        RUNWARE_WAN22_ALLOWED_RESOLUTIONS,
        key=lambda candidate: (
            abs(math.log(source_ratio / (candidate[0] / candidate[1]))),
            -(candidate[0] * candidate[1]),
        ),
    )
    return ranked[0]


def _nearest_supported_kling_duration(duration_sec: float) -> int:
    return min(KLING_SUPPORTED_DURATIONS, key=lambda value: abs(duration_sec - float(value)))


def _nearest_supported_ltx23_duration(duration_sec: float) -> int:
    bounded = max(float(LTX23_SUPPORTED_DURATIONS[0]), min(float(LTX23_SUPPORTED_DURATIONS[-1]), float(duration_sec)))
    return min(LTX23_SUPPORTED_DURATIONS, key=lambda value: abs(float(value) - bounded))


def _nearest_supported_ltx23_fps(source_fps: Fraction | float) -> int:
    source_value = float(source_fps)
    return min(LTX23_SUPPORTED_FPS, key=lambda value: abs(float(value) - source_value))


def _sora_supported_duration(duration_sec: float) -> int:
    requested = max(4.0, min(10.0, float(duration_sec)))
    if requested <= 4.0:
        return 4
    if requested <= 8.0:
        return 8
    return 12


def _target_preserving_aspect_long_edge(width: int, height: int, *, long_edge: int) -> tuple[int, int]:
    source_w = max(1, int(width or long_edge))
    source_h = max(1, int(height or long_edge))
    current_long_edge = max(source_w, source_h)
    if current_long_edge <= 0:
        return long_edge, long_edge
    scale = long_edge / float(current_long_edge)
    target_w = max(1, int(round(source_w * scale)))
    target_h = max(1, int(round(source_h * scale)))
    return target_w, target_h


def _nearest_allowed_aspect_ratio(width: int, height: int, *, allowed: tuple[str, ...]) -> str:
    source_ratio = (width / height) if height else 1.0
    ratio_values = {
        "21:9": 21 / 9,
        "16:9": 16 / 9,
        "9:16": 9 / 16,
        "1:1": 1.0,
        "4:3": 4 / 3,
        "3:4": 3 / 4,
        "auto": source_ratio,
    }
    ranked = sorted(
        allowed,
        key=lambda value: abs(math.log(max(1e-6, source_ratio) / max(1e-6, ratio_values[value]))),
    )
    return ranked[0] if ranked else "16:9"


def _dimensions_for_aspect_ratio(aspect_ratio: str, *, long_edge: int, square_edge: int) -> tuple[int, int]:
    if aspect_ratio == "9:16":
        return int(round(long_edge * 9 / 16)), long_edge
    if aspect_ratio == "1:1":
        return square_edge, square_edge
    if aspect_ratio == "4:3":
        return long_edge, int(round(long_edge * 3 / 4))
    if aspect_ratio == "3:4":
        return int(round(long_edge * 3 / 4)), long_edge
    return long_edge, int(round(long_edge * 9 / 16))


def _nearest_runway_aleph_resolution(width: int, height: int) -> tuple[int, int]:
    aspect_ratio = _nearest_allowed_aspect_ratio(
        width,
        height,
        allowed=("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"),
    )
    resolutions = {
        "21:9": (1584, 672),
        "16:9": (1280, 720),
        "4:3": (1104, 832),
        "1:1": (960, 960),
        "3:4": (832, 1104),
        "9:16": (720, 1280),
    }
    return resolutions[aspect_ratio]


def _dimensions_for_aspect_ratio_within_box(
    aspect_ratio: str,
    *,
    landscape_box: tuple[int, int],
    portrait_box: tuple[int, int],
    square_edge: int,
) -> tuple[int, int]:
    ratio_values = {
        "21:9": 21 / 9,
        "16:9": 16 / 9,
        "4:3": 4 / 3,
        "1:1": 1.0,
        "3:4": 3 / 4,
        "9:16": 9 / 16,
    }
    ratio = ratio_values.get(aspect_ratio, 16 / 9)
    if aspect_ratio == "1:1":
        return square_edge, square_edge
    box_width, box_height = landscape_box if ratio >= 1 else portrait_box
    width = box_width
    height = int(round(width / ratio))
    if height > box_height:
        height = box_height
        width = int(round(height * ratio))
    width = max(2, width - (width % 2))
    height = max(2, height - (height % 2))
    return width, height


def _fit_image_to_canvas(image: Image.Image, target_w: int, target_h: int, *, mode: str = "contain") -> Image.Image:
    if mode == "cover":
        return ImageOps.fit(image, (target_w, target_h), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    fitted = ImageOps.contain(image, (target_w, target_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (target_w, target_h), (0, 0, 0))
    offset_x = max(0, (target_w - fitted.width) // 2)
    offset_y = max(0, (target_h - fitted.height) // 2)
    canvas.paste(fitted, (offset_x, offset_y))
    return canvas


def _encode_jpeg_with_limit(image: Image.Image, max_bytes: int) -> bytes:
    candidate = image
    for _ in range(3):
        for quality in (95, 90, 84, 78, 72, 66, 60, 54, 48, 42):
            output = BytesIO()
            candidate.save(output, format="JPEG", quality=quality, optimize=True)
            payload = output.getvalue()
            if len(payload) <= max_bytes:
                return payload
        candidate = ImageOps.contain(
            candidate,
            (max(320, int(candidate.width * 0.9)), max(320, int(candidate.height * 0.9))),
            Image.Resampling.LANCZOS,
        )
    output = BytesIO()
    candidate.save(output, format="JPEG", quality=40, optimize=True)
    return output.getvalue()


def _encode_png_with_limit(image: Image.Image, max_bytes: int) -> bytes | None:
    for optimize in (True, False):
        output = BytesIO()
        image.save(output, format="PNG", optimize=optimize, compress_level=9)
        payload = output.getvalue()
        if len(payload) <= max_bytes:
            return payload
    return None


def _prepare_first_frame_image_payload(
    frame_bytes: bytes,
    *,
    target_width: int,
    target_height: int,
    max_bytes: int,
    fit_mode: str = "contain",
) -> tuple[bytes, str, str]:
    image = ImageOps.exif_transpose(Image.open(BytesIO(frame_bytes))).convert("RGB")
    canvas = _fit_image_to_canvas(image, target_width, target_height, mode=fit_mode)
    png_payload = _encode_png_with_limit(canvas, max_bytes)
    if png_payload is not None:
        return png_payload, "image/png", ".png"

    payload = _encode_jpeg_with_limit(canvas, max_bytes)
    if len(payload) > max_bytes:
        raise RuntimeError(f"Unable to compress frame under {max_bytes} bytes")
    return payload, "image/jpeg", ".jpg"


def _prepare_replicate_image_data_url(
    frame_bytes: bytes,
    *,
    target_width: int,
    target_height: int,
    max_bytes: int = 900_000,
    fit_mode: str = "contain",
) -> str:
    image = ImageOps.exif_transpose(Image.open(BytesIO(frame_bytes))).convert("RGB")
    width = target_width
    height = target_height
    longest_edge = max(width, height)
    if longest_edge > 1024:
        scale = 1024 / float(longest_edge)
        width = max(1, int(round(width * scale)))
        height = max(1, int(round(height * scale)))

    for _ in range(6):
        canvas = _fit_image_to_canvas(image, width, height, mode=fit_mode)
        payload = _encode_jpeg_with_limit(canvas, max_bytes)
        if len(payload) <= max_bytes:
            encoded = base64.b64encode(payload).decode("ascii")
            return f"data:image/jpeg;base64,{encoded}"
        width = max(256, int(round(width * 0.85)))
        height = max(256, int(round(height * 0.85)))

    raise RuntimeError(f"Unable to prepare Replicate image data URL under {max_bytes} bytes")


def _prepare_replicate_video_data_url(
    *,
    input_path: str,
    output_path: str,
    fps: Fraction,
    source_fps: Fraction | None = None,
    preserve_frame_count: bool = False,
    target_width: int,
    target_height: int,
    resize_mode: str = "pad",
    max_bytes: int = WAN27_DATA_URL_MAX_BYTES,
) -> tuple[str, int]:
    last_size = 0
    for audio_bitrate in ("128k", "96k", "64k"):
        for crf in (24, 28, 32, 36, 40):
            if preserve_frame_count and source_fps is not None and source_fps != fps:
                transcode_preserving_frame_count(
                    input_path,
                    output_path,
                    source_fps=source_fps,
                target_fps=fps,
                target_width=target_width,
                target_height=target_height,
                resize_mode=resize_mode,
                crf=crf,
                preset="medium",
                audio_bitrate=audio_bitrate,
                )
            else:
                transcode_to_cfr(
                    input_path,
                    output_path,
                    fps,
                    target_width=target_width,
                    target_height=target_height,
                    resize_mode=resize_mode,
                    crf=crf,
                    preset="medium",
                    audio_bitrate=audio_bitrate,
                )
            payload = Path(output_path).read_bytes()
            last_size = len(payload)
            if last_size <= max_bytes:
                encoded = base64.b64encode(payload).decode("ascii")
                return f"data:video/mp4;base64,{encoded}", last_size
    raise RuntimeError(f"Unable to prepare Replicate video data URL under {max_bytes} bytes (last size={last_size} bytes)")


def _transcode_with_size_limit(
    *,
    input_path: str,
    output_path: str,
    fps: Fraction,
    source_width: int,
    source_height: int,
    landscape_target: tuple[int, int],
    portrait_target: tuple[int, int],
    resize_mode: str = "pad",
    max_bytes: int,
) -> tuple[int, int, int]:
    last_size = 0
    for crf in (20, 24, 28, 32, 36):
        target_w, target_h = transcode_for_provider(
            input_path,
            output_path,
            fps=fps,
            source_width=source_width,
            source_height=source_height,
            landscape_target=landscape_target,
            portrait_target=portrait_target,
            resize_mode=resize_mode,
            crf=crf,
        )
        output_size = Path(output_path).stat().st_size
        last_size = output_size
        if output_size <= max_bytes:
            return target_w, target_h, output_size
    raise RuntimeError(f"Unable to compress provider input under {max_bytes} bytes (last size={last_size} bytes)")


def _transcode_exact_with_size_limit(
    *,
    input_path: str,
    output_path: str,
    fps: Fraction,
    source_fps: Fraction | None = None,
    preserve_frame_count: bool = False,
    target_width: int,
    target_height: int,
    resize_mode: str = "pad",
    max_bytes: int,
) -> tuple[int, int, int]:
    last_size = 0
    for crf in (18, 22, 26, 30, 34):
        if preserve_frame_count and source_fps is not None and source_fps != fps:
            transcode_preserving_frame_count(
                input_path,
                output_path,
                source_fps=source_fps,
                target_fps=fps,
                target_width=target_width,
                target_height=target_height,
                resize_mode=resize_mode,
                crf=crf,
                preset="medium",
                audio_bitrate="192k",
            )
        else:
            transcode_to_cfr(
                input_path,
                output_path,
                fps,
                target_width=target_width,
                target_height=target_height,
                resize_mode=resize_mode,
                crf=crf,
                preset="medium",
                audio_bitrate="192k",
            )
        output_size = Path(output_path).stat().st_size
        last_size = output_size
        if output_size <= max_bytes:
            return target_width, target_height, output_size
    raise RuntimeError(f"Unable to compress provider input under {max_bytes} bytes (last size={last_size} bytes)")


def _resolved_provider_fps(
    *,
    model_name: str,
    source_fps: Fraction,
    preserve_frames: bool,
) -> tuple[Fraction, str]:
    return resolve_video_model_provider_fps(
        model=model_name,
        source_fps=source_fps,
        preserve_frames=preserve_frames,
    )


def _asset_paths(task: dict[str, Any]) -> AssetPaths:
    return AssetPaths(user_id=task["userId"], task_id=task["taskId"], file_prefix=task.get("filePrefix", ""))


def _api_asset_paths(user_id: str) -> ApiAssetPaths:
    return ApiAssetPaths(user_id=user_id)


def _load_api_request(store: S3JsonStore, user_id: str, request_id: str) -> dict[str, Any]:
    request_record = store.load_api_request(user_id, request_id)
    if not isinstance(request_record, dict):
        raise RuntimeError(f"API request not found: {request_id}")
    return request_record


def _save_api_request(store: S3JsonStore, request_record: dict[str, Any], updates: dict[str, Any] | None = None) -> dict[str, Any]:
    if isinstance(updates, dict):
        request_record.update(updates)
    request_record["updatedAt"] = now_iso()
    return store.save_api_request(request_record)


def _api_request_progress(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    request_record: dict[str, Any],
    progress: int,
    status: str,
    logs: str | None = None,
) -> None:
    _job_progress(job, store, progress, status, logs)
    request_record["status"] = status
    if logs:
        request_logs = request_record.setdefault("logs", [])
        if isinstance(request_logs, list):
            request_logs.append({"at": now_iso(), "message": logs})
    _save_api_request(store, request_record)


def _allocate_variant_storage(frame: dict[str, Any], paths: AssetPaths, frame_id: str) -> tuple[str, str]:
    existing_output_keys = {
        str(item.get("outputKey"))
        for item in frame.get("variants", [])
        if isinstance(item, dict) and item.get("outputKey")
    }
    for _ in range(16):
        variant_id = new_id("var")
        output_key = paths.frame_variant(frame_id, variant_id)
        if output_key not in existing_output_keys:
            return variant_id, output_key
    raise RuntimeError("Unable to allocate unique frame variant storage key after multiple attempts")


def _download_s3(s3, bucket: str, key: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(bucket, key, str(path))


def _download_url_to_path(url: str, path: Path, *, timeout: int = 240) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, timeout=timeout, stream=True) as response:
        response.raise_for_status()
        with path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def _upload_s3(s3, bucket: str, key: str, path: Path, content_type: str | None = None) -> None:
    extra = {"ServerSideEncryption": "AES256"}
    if content_type:
        extra["ContentType"] = content_type
    s3.upload_file(str(path), bucket, key, ExtraArgs=extra)


def _fraction_from_probe(probe: dict[str, Any], fallback: Fraction = Fraction(30, 1)) -> Fraction:
    fps = Fraction(int(probe.get("fps_num") or fallback.numerator), int(probe.get("fps_den") or fallback.denominator or 1))
    if fps.numerator <= 0 or fps.denominator <= 0:
        return fallback
    return fps


def _video_timing_payload(probe: dict[str, Any]) -> dict[str, Any]:
    fps = _fraction_from_probe(probe)
    return {
        "width": int(probe.get("width") or 0),
        "height": int(probe.get("height") or 0),
        "fps": {"num": fps.numerator, "den": fps.denominator},
        "durationSec": round(float(probe.get("duration_sec") or 0.0), 4),
        "frameCount": int(probe.get("frame_count") or 0),
        "isVfr": bool(probe.get("is_vfr_input")),
    }


def _needs_timeline_conform(probe: dict[str, Any], *, target_width: int, target_height: int, target_fps: Fraction) -> bool:
    return (
        int(probe.get("width") or 0) != int(target_width)
        or int(probe.get("height") or 0) != int(target_height)
        or _fraction_from_probe(probe, target_fps) != target_fps
        or bool(probe.get("is_vfr_input"))
    )


def _timeline_conform_summary(
    *,
    source_probe: dict[str, Any],
    raw_output_probe: dict[str, Any],
    stored_output_probe: dict[str, Any],
    applied: bool,
    policy: str,
) -> dict[str, Any]:
    source_frames = int(source_probe.get("frame_count") or 0)
    stored_frames = int(stored_output_probe.get("frame_count") or 0)
    source_duration = float(source_probe.get("duration_sec") or 0.0)
    stored_duration = float(stored_output_probe.get("duration_sec") or 0.0)
    return {
        "policy": policy,
        "applied": bool(applied),
        "durationDeltaSec": round(stored_duration - source_duration, 4),
        "frameDelta": stored_frames - source_frames,
        "fpsConformed": _fraction_from_probe(raw_output_probe) != _fraction_from_probe(stored_output_probe),
        "resolutionConformed": (
            int(raw_output_probe.get("width") or 0) != int(stored_output_probe.get("width") or 0)
            or int(raw_output_probe.get("height") or 0) != int(stored_output_probe.get("height") or 0)
        ),
    }


def _ensure_segment_clip(
    *,
    s3,
    asset_store: AssetStore,
    asset_paths: AssetPaths,
    task: dict[str, Any],
    segment: dict[str, Any],
    assets_bucket: str,
) -> str:
    source_media_kind = str(task.get("sourceMedia", {}).get("kind") or task.get("video", {}).get("editSource", {}).get("mediaType") or "video")
    segment_key = asset_paths.segment_original_audio(segment["segmentId"], ".wav") if source_media_kind == "audio" else asset_paths.segment_original(segment["segmentId"])

    with tempfile.TemporaryDirectory() as td:
        edit_source_key = task["video"]["editSource"]["s3Key"]
        input_path = Path(td) / ("edit.wav" if source_media_kind == "audio" else "edit.mp4")
        output_path = Path(td) / ("segment.wav" if source_media_kind == "audio" else "segment.mp4")
        _download_s3(s3, assets_bucket, edit_source_key, input_path)
        if source_media_kind == "audio":
            pseudo_fps = Fraction(
                int(task["video"]["editSource"]["fps"]["num"]),
                max(1, int(task["video"]["editSource"]["fps"]["den"])),
            )
            start_sec = float(Fraction(int(segment["startFrame"]), 1) / pseudo_fps)
            duration_sec = float(Fraction(max(0, int(segment["endFrameExclusive"]) - int(segment["startFrame"])), 1) / pseudo_fps)
            audio_channels = int(task.get("sourceMedia", {}).get("editSource", {}).get("channels") or 2)
            audio_sample_rate = int(task.get("sourceMedia", {}).get("editSource", {}).get("sampleRate") or 48000)
            extract_audio_segment(
                str(input_path),
                str(output_path),
                start_sec=start_sec,
                duration_sec=duration_sec,
                codec="pcm_s16le",
                sample_rate=audio_sample_rate,
                channels=audio_channels,
            )
            _upload_s3(s3, assets_bucket, segment_key, output_path, "audio/wav")
        else:
            crop = segment.get("crop") if isinstance(segment.get("crop"), dict) and segment.get("crop", {}).get("enabled") else None
            extract_segment_by_frames(
                str(input_path),
                str(output_path),
                start_frame=segment["startFrame"],
                end_frame_exclusive=segment["endFrameExclusive"],
                fps_num=task["video"]["editSource"]["fps"]["num"],
                fps_den=task["video"]["editSource"]["fps"]["den"],
                target_width=(int(crop["outputWidth"]) if crop else None),
                target_height=(int(crop["outputHeight"]) if crop else None),
                crop_x=(int(crop["x"]) if crop else None),
                crop_y=(int(crop["y"]) if crop else None),
                crop_width=(int(crop["width"]) if crop else None),
                crop_height=(int(crop["height"]) if crop else None),
            )
            _upload_s3(s3, assets_bucket, segment_key, output_path, "video/mp4")
    segment["segmentClipKey"] = segment_key
    segment["segmentClipUpdatedAt"] = now_iso()
    segment["segmentClipContentType"] = "audio/wav" if source_media_kind == "audio" else "video/mp4"
    return segment_key


def _job_progress(job: dict[str, Any], store: S3JsonStore, progress: int, status: str, logs: str | None = None) -> None:
    _raise_if_cancel_requested(job, store)
    job["progress"] = progress
    job["status"] = status
    if logs:
        entries = job.setdefault("logs", [])
        entries.append({"at": now_iso(), "message": logs})
    store.save_job(job)


def _append_task_history_event(task: dict[str, Any], entry: dict[str, Any]) -> None:
    history = task.setdefault("history", [])
    marker = json.dumps(entry, sort_keys=True, default=str)
    for existing in history:
        if json.dumps(existing, sort_keys=True, default=str) == marker:
            return
    history.append(entry)


def _parse_iso_utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _processing_duration_seconds(started_at: Any, finished_at: Any) -> float | None:
    started_dt = _parse_iso_utc(started_at)
    finished_dt = _parse_iso_utc(finished_at)
    if not started_dt or not finished_dt:
        return None
    seconds = (finished_dt - started_dt).total_seconds()
    if seconds < 0:
        return None
    return round(seconds, 3)


def _create_segment_generation_poster(
    *,
    asset_store: AssetStore,
    paths: AssetPaths,
    segment_id: str,
    gen_id: str,
    video_path: str,
) -> str | None:
    try:
        probe = ffprobe_video(video_path)
        frame_count = max(0, int(probe.get("frame_count") or 0))
        poster_frame_index = 1 if frame_count > 1 else 0
        with tempfile.TemporaryDirectory() as td:
            poster_path = Path(td) / "generation_poster.png"
            extract_frame_png(video_path, poster_frame_index, str(poster_path))
            poster_key = paths.segment_generated_poster(segment_id, gen_id)
            asset_store.put_bytes(poster_key, poster_path.read_bytes(), content_type="image/png")
            return poster_key
    except Exception:
        return None


def _update_segment_generation_record(
    *,
    store: _WorkerStoreProxy,
    user_id: str,
    task_id: str,
    gen_id: str,
    updates: dict[str, Any],
    history_entry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    latest_task = store.load_task(user_id, task_id)
    if not isinstance(latest_task, dict):
        raise RuntimeError(f"Task {task_id} not found while updating generation {gen_id}")
    generation = latest_task.setdefault("segmentGenerations", {}).setdefault(gen_id, {})
    generation.update(updates)
    if history_entry:
        _append_task_history_event(latest_task, history_entry)
    store.save_task(latest_task, merge_on_conflict=True)
    return latest_task.setdefault("segmentGenerations", {}).get(gen_id, {})


def _enqueue_follow_on_job(
    *,
    store: S3JsonStore,
    user_id: str,
    task_id: str,
    queue_url: str,
    job_type: str,
    payload: dict[str, Any],
) -> str:
    job_id = new_id("job")
    next_job = {
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
    store.save_job(next_job)
    JobQueue(queue_url).enqueue({"jobId": job_id, "taskId": task_id, "userId": user_id})
    return job_id


def _find_chunked_generation_run_for_generation(task: dict[str, Any], gen_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    for run in task.get("chunkedGenerationRuns", []):
        if not isinstance(run, dict):
            continue
        for chunk in run.get("chunks", []):
            if isinstance(chunk, dict) and chunk.get("generationId") == gen_id:
                return run, chunk
    return None, None


def _find_chunked_generation_run(task: dict[str, Any], run_id: str) -> dict[str, Any] | None:
    return next(
        (
            run
            for run in task.get("chunkedGenerationRuns", [])
            if isinstance(run, dict) and str(run.get("runId") or "") == str(run_id)
        ),
        None,
    )


def _copy_generated_anchor_to_frame_variant(
    *,
    task: dict[str, Any],
    generation: dict[str, Any],
    target_frame_id: str,
    target_frame_index: int,
    anchor_frames_from_end: int,
    asset_store: AssetStore,
    assets_bucket: str,
) -> dict[str, Any]:
    output_key = generation.get("outputKey")
    if not isinstance(output_key, str) or not output_key:
        raise RuntimeError("Previous generation does not have an output video")
    s3 = boto3.client("s3")
    paths = _asset_paths(task)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        local_video = td_path / "previous_generated.mp4"
        local_anchor = td_path / "extension_anchor.png"
        _download_s3(s3, assets_bucket, output_key, local_video)
        probe = ffprobe_video(str(local_video))
        frame_count = int(probe.get("frame_count") or 0)
        if frame_count <= 0:
            duration = float(probe.get("duration_sec") or generation.get("providerDurationSec") or generation.get("requestedDurationSec") or 0.0)
            fps_num = int(probe.get("fps_num") or 24)
            fps_den = int(probe.get("fps_den") or 1)
            frame_count = max(1, int(round(duration * (fps_num / max(1, fps_den)))))
        anchor_frame_index: int | None = None
        source_segment_timing = generation.get("generationSettings", {}).get("sourceSegmentTiming") if isinstance(generation.get("generationSettings"), dict) else None
        source_segment_start_frame = None
        if isinstance(source_segment_timing, dict):
            source_segment_start_frame = int(source_segment_timing.get("startFrame") or 0)
        if source_segment_start_frame is None:
            segment_lookup = next(
                (
                    segment
                    for segment in task.get("segments", [])
                    if isinstance(segment, dict) and segment.get("segmentId") == generation.get("segmentId")
                ),
                None,
            )
            if isinstance(segment_lookup, dict):
                source_segment_start_frame = int(segment_lookup.get("startFrame") or 0)
        source_frame_offset = int(
            generation.get("sourceFrameOffset")
            or (generation.get("alignment", {}).get("sourceFrameOffset") if isinstance(generation.get("alignment"), dict) else 0)
            or 0
        )
        if source_segment_start_frame is not None:
            aligned_generated_start_frame = int(source_segment_start_frame) + source_frame_offset
            anchor_frame_index = int(target_frame_index) - aligned_generated_start_frame
        if anchor_frame_index is None:
            anchor_frame_index = frame_count - 1 - int(anchor_frames_from_end)
        anchor_frame_index = max(0, min(frame_count - 1, anchor_frame_index))
        extract_frame_png(str(local_video), anchor_frame_index, str(local_anchor))
        variant_id = new_id("var")
        variant_key = paths.frame_variant(target_frame_id, variant_id)
        s3.upload_file(str(local_anchor), assets_bucket, variant_key, ExtraArgs={"ContentType": "image/png"})
    prompt = f"Chunk anchor from {generation.get('genId') or 'previous_generation'}"
    variant = {
        "variantId": variant_id,
        "type": "extension_anchor",
        "variantKind": "edited",
        "model": "generated_extension_anchor",
        "promptHash": prompt_hash(prompt),
        "createdAt": now_iso(),
        "outputKey": variant_key,
        "sourceVariantId": None,
        "generationSettings": {
            "workflow": "chunked_generation_anchor",
            "anchorFramesFromEnd": int(anchor_frames_from_end),
            "sourceGenerationId": generation.get("genId"),
            "sourceGeneratedFrameIndex": anchor_frame_index,
            "alignedSourceFrameIndex": int(target_frame_index),
            "targetFrameIndex": int(target_frame_index),
        },
    }
    target_frame = task.setdefault("frames", {}).setdefault(target_frame_id, {})
    variants = target_frame.setdefault("variants", [])
    variants.append(variant)
    target_frame["selectedVariantId"] = variant_id
    return {
        **variant,
        "sourceGeneratedFrameIndex": anchor_frame_index,
    }


def _queue_chunk_generation_follow_on(
    *,
    store: S3JsonStore,
    task: dict[str, Any],
    run: dict[str, Any],
    chunk: dict[str, Any],
    first_frame_variant_id: str,
    parent_generation_id: str | None,
    extension_metadata: dict[str, Any],
    queue_url: str,
) -> str:
    chunk_prompt = chunk.get("prompt") or run.get("continuationPrompt") or run.get("openingPrompt")
    gen_id = new_id("gen")
    job_id = _enqueue_follow_on_job(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        queue_url=queue_url,
        job_type="segment_generate",
        payload={
            "segmentId": chunk["segmentId"],
            "genId": gen_id,
            "lumaModel": run.get("model"),
            "mode": run.get("mode"),
            "prompt": chunk_prompt,
            "firstFrameVariantId": first_frame_variant_id,
            "replicateKlingMode": run.get("replicateKlingMode"),
            "replicateKlingV3Mode": run.get("replicateKlingV3Mode"),
            "wan27Resolution": run.get("wan27Resolution"),
            "parentGenerationId": parent_generation_id,
            "extensionMetadata": extension_metadata,
        },
    )
    now = now_iso()
    task.setdefault("segmentGenerations", {})[gen_id] = {
        "genId": gen_id,
        "segmentId": chunk["segmentId"],
        "luma": {
            "provider": _segment_generation_provider_name(str(run.get("model") or "")),
            "model": run.get("model"),
            "mode": run.get("mode"),
            "prompt": chunk_prompt,
            "lumaGenerationId": None,
        },
        "status": "queued",
        "isChunkInternal": True,
        "chunkedRunId": run.get("runId"),
        "chunkRole": "internal_chunk",
        "outputKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now,
        "createdAt": now,
        "updatedAt": now,
        "parentGenerationId": parent_generation_id,
        "extension": extension_metadata,
    }
    chunk["generationId"] = gen_id
    chunk["jobId"] = job_id
    chunk["status"] = "queued"
    chunk["reviewStatus"] = "running"
    chunk.pop("error", None)
    chunk["prompt"] = chunk_prompt
    chunk["updatedAt"] = now
    run["status"] = "running"
    run["activeChunkIndex"] = int(chunk.get("chunkIndex") or 0)
    run["updatedAt"] = now
    _append_task_history_event(
        task,
        {
            "at": now,
            "event": "chunked_generation.chunk_queued",
            "runId": run.get("runId"),
            "chunkIndex": chunk.get("chunkIndex"),
            "genId": gen_id,
        },
    )
    return job_id


def _advance_chunked_generation_run_after_success(
    *,
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
    gen_id: str,
) -> None:
    run, chunk = _find_chunked_generation_run_for_generation(task, gen_id)
    if not isinstance(run, dict) or not isinstance(chunk, dict):
        return
    chunks = [item for item in run.get("chunks", []) if isinstance(item, dict)]
    now = now_iso()
    chunk["status"] = "complete"
    chunk["reviewStatus"] = "complete"
    chunk["finishedAt"] = now
    chunk["updatedAt"] = now
    current_index = int(chunk.get("chunkIndex") or 0)
    generation = task.get("segmentGenerations", {}).get(gen_id)
    if isinstance(generation, dict):
        source_frame_offset = int(
            generation.get("sourceFrameOffset")
            or (generation.get("alignment", {}).get("sourceFrameOffset") if isinstance(generation.get("alignment"), dict) else 0)
            or 0
        )
        actual_output_start_frame = int(chunk.get("segmentStartFrame") or 0) + source_frame_offset
        chunk["actualOutputStartFrame"] = actual_output_start_frame
        chunk["actualCoverageTrimStartFrames"] = max(0, int(chunk.get("coverageStartFrame") or chunk.get("segmentStartFrame") or 0) - actual_output_start_frame)
    if run.get("status") == "canceled":
        run["updatedAt"] = now
        store.save_task(task, merge_on_conflict=True)
        return
    if run.get("status") == "paused":
        run["activeChunkIndex"] = current_index
        run["updatedAt"] = now
        store.save_task(task, merge_on_conflict=True)
        return
    if current_index >= len(chunks) - 1:
        run["status"] = "complete"
        run["finishedAt"] = now
        run["updatedAt"] = now
        run["activeChunkIndex"] = current_index
        if run.get("saveStatus") not in {"queued", "running", "complete"}:
            save_job_id = _enqueue_follow_on_job(
                store=store,
                user_id=task["userId"],
                task_id=task["taskId"],
                queue_url=settings.jobs_queue_url,
                job_type="chunked_generation_finalize",
                payload={"runId": run.get("runId")},
            )
            run["saveStatus"] = "queued"
            run["saveJobId"] = save_job_id
            run["saveError"] = None
        store.save_task(task, merge_on_conflict=True)
        return

    next_chunk = chunks[current_index + 1]
    if not isinstance(generation, dict):
        store.save_task(task, merge_on_conflict=True)
        return
    anchor_variant = _copy_generated_anchor_to_frame_variant(
        task=task,
        generation=generation,
        target_frame_id=str(next_chunk.get("anchorFrameId") or ""),
        target_frame_index=int(next_chunk.get("segmentStartFrame") or 0),
        anchor_frames_from_end=int(next_chunk.get("anchorFramesFromPrevious") or 0),
        asset_store=asset_store,
        assets_bucket=settings.assets_bucket,
    )
    next_chunk["anchorVariantId"] = anchor_variant.get("variantId")
    next_chunk["sourceGeneratedFrameIndex"] = anchor_variant.get("sourceGeneratedFrameIndex")
    if run.get("status") != "running":
        run["updatedAt"] = now
        store.save_task(task, merge_on_conflict=True)
        return
    _queue_chunk_generation_follow_on(
        store=store,
        task=task,
        run=run,
        chunk=next_chunk,
        first_frame_variant_id=str(anchor_variant.get("variantId")),
        parent_generation_id=gen_id,
        extension_metadata={
            "chunkedRunId": run.get("runId"),
            "chunkIndex": next_chunk.get("chunkIndex"),
            "sourceSegmentId": run.get("sourceSegmentId"),
            "alignmentFrameIndex": next_chunk.get("segmentStartFrame"),
            "anchorFramesFromEnd": next_chunk.get("anchorFramesFromPrevious", 0),
            "anchorVariantId": anchor_variant.get("variantId"),
            "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
            "createdAt": now,
        },
        queue_url=settings.jobs_queue_url,
    )
    store.save_task(task, merge_on_conflict=True)


def _mark_chunked_generation_run_failed(
    *,
    store: S3JsonStore,
    task: dict[str, Any],
    gen_id: str,
    error: str,
) -> None:
    run, chunk = _find_chunked_generation_run_for_generation(task, gen_id)
    if not isinstance(run, dict) or not isinstance(chunk, dict):
        return
    now = now_iso()
    chunk["status"] = "failed"
    chunk["reviewStatus"] = "needs_retry"
    chunk["error"] = error
    chunk["updatedAt"] = now
    run["status"] = "failed"
    run["failureChunkIndex"] = int(chunk.get("chunkIndex") or 0)
    run["updatedAt"] = now
    _append_task_history_event(
        task,
        {
            "at": now,
            "event": "chunked_generation.chunk_failed",
            "runId": run.get("runId"),
            "chunkIndex": chunk.get("chunkIndex"),
            "genId": gen_id,
            "error": error,
        },
    )
    store.save_task(task, merge_on_conflict=True)


def _handle_chunked_generation_finalize(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job.get("payload") or {}
    run_id = str(payload.get("runId") or "")
    run = _find_chunked_generation_run(task, run_id)
    if not isinstance(run, dict):
        raise RuntimeError("Chunked generation run not found")
    if run.get("status") != "complete":
        raise RuntimeError("Chunked generation run must be complete before saving a draft")
    chunks = [chunk for chunk in run.get("chunks", []) if isinstance(chunk, dict)]
    if not chunks:
        raise RuntimeError("Chunked generation run does not contain any chunks")

    run["saveStatus"] = "running"
    run["saveError"] = None
    run["updatedAt"] = now_iso()
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 10, "running", "Preparing stitched draft")

    source_segment_id = str(run.get("sourceSegmentId") or "")
    source_segment = next((item for item in task.get("segments", []) if isinstance(item, dict) and item.get("segmentId") == source_segment_id), None)
    if not isinstance(source_segment, dict):
        raise RuntimeError("Source segment for chunked generation was not found")

    output_width = int(task.get("video", {}).get("editSource", {}).get("width") or 0)
    output_height = int(task.get("video", {}).get("editSource", {}).get("height") or 0)
    if output_width <= 0 or output_height <= 0:
        raise RuntimeError("Source video dimensions are unavailable for stitched draft")
    source_fps = task.get("video", {}).get("editSource", {}).get("fps", {}) if isinstance(task.get("video"), dict) else {}
    fps_num = int(source_fps.get("num") or 24)
    fps_den = int(source_fps.get("den") or 1)
    fps = Fraction(fps_num, fps_den)
    s3 = boto3.client("s3")
    paths = _asset_paths(task)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        input_paths: list[str] = []
        trim_start_frames: list[int] = []
        trim_end_frames: list[int] = []
        for chunk in sorted(chunks, key=lambda item: int(item.get("chunkIndex") or 0)):
            generation_id = str(chunk.get("generationId") or "")
            generation = task.get("segmentGenerations", {}).get(generation_id)
            if not isinstance(generation, dict) or generation.get("status") != "complete":
                raise RuntimeError(f"Chunk {int(chunk.get('chunkIndex') or 0) + 1} does not have a complete generated output")
            output_key = generation.get("outputKey")
            if not isinstance(output_key, str) or not output_key:
                raise RuntimeError(f"Chunk {int(chunk.get('chunkIndex') or 0) + 1} is missing its output video")
            local_input = td_path / f"chunk_{int(chunk.get('chunkIndex') or 0):03d}.mp4"
            _download_s3(s3, settings.assets_bucket, output_key, local_input)
            input_paths.append(str(local_input))
            output_timing = generation.get("generationSettings", {}).get("storedOutput") if isinstance(generation.get("generationSettings"), dict) else None
            output_frame_count = int((output_timing or {}).get("frameCount") or 0) if isinstance(output_timing, dict) else 0
            if output_frame_count <= 0:
                output_probe = ffprobe_video(str(local_input))
                output_frame_count = int(output_probe.get("frame_count") or 0)
            source_frame_offset = int(
                generation.get("sourceFrameOffset")
                or (generation.get("alignment", {}).get("sourceFrameOffset") if isinstance(generation.get("alignment"), dict) else 0)
                or 0
            )
            actual_output_start_source = int(chunk.get("segmentStartFrame") or 0) + source_frame_offset
            desired_start_index = max(0, int(chunk.get("coverageStartFrame") or chunk.get("segmentStartFrame") or 0) - actual_output_start_source)
            desired_end_index_exclusive = min(
                output_frame_count,
                max(
                    desired_start_index + 1,
                    int(chunk.get("coverageEndFrameExclusive") or chunk.get("segmentEndFrameExclusive") or 0) - actual_output_start_source,
                ),
            )
            trim_start_frames.append(desired_start_index)
            trim_end_frames.append(max(0, output_frame_count - desired_end_index_exclusive))
        stitched_path = td_path / "stitched_draft.mp4"
        stitch_video_segments(
            input_paths,
            str(stitched_path),
            fps_num=fps.numerator,
            fps_den=fps.denominator,
            output_width=output_width,
            output_height=output_height,
            trim_start_frames=trim_start_frames,
            trim_end_frames=trim_end_frames,
        )
        stitched_probe = ffprobe_video(str(stitched_path))
        gen_id = new_id("gen")
        output_key = paths.segment_generated(source_segment_id, gen_id)
        s3.upload_file(
            str(stitched_path),
            settings.assets_bucket,
            output_key,
            ExtraArgs={"ContentType": "video/mp4"},
        )
        poster_key = _create_segment_generation_poster(
            asset_store=asset_store,
            paths=paths,
            segment_id=source_segment_id,
            gen_id=gen_id,
            video_path=str(stitched_path),
        )

    _job_progress(job, store, 85, "running", "Saving stitched draft")
    finished_at = now_iso()
    source_start_frame = task.get("frames", {}).get(source_segment.get("startFrameId") or "")
    generation_record = {
        "genId": gen_id,
        "segmentId": source_segment_id,
        "luma": {
            "provider": _segment_generation_provider_name(str(run.get("model") or "")),
            "model": run.get("model"),
            "mode": run.get("mode"),
            "prompt": run.get("openingPrompt"),
            "lumaGenerationId": None,
        },
        "status": "complete",
        "outputKey": output_key,
        "posterKey": poster_key,
        "sourceFirstFrameCaptureKey": source_start_frame.get("captureKey") if isinstance(source_start_frame, dict) else None,
        "requestedDurationSec": round(float(source_segment.get("durationSec") or 0.0), 3),
        "providerDurationSec": round(float(stitched_probe.get("duration_sec") or 0.0), 3),
        "sourceFrameOffset": 0,
        "alignment": {
            "sourceFrameOffset": 0,
            "matchedSourceFrame": int(source_segment.get("startFrame") or 0),
            "confidence": 1.0,
            "strategy": "chunk_stitch_source_range",
        },
        "generationSettings": {
            "provider": "chunked_generation",
            "requestedModel": run.get("model"),
            "model": run.get("model"),
            "mode": run.get("mode"),
            "chunkedRunId": run_id,
            "chunkCount": len(chunks),
            "openingPrompt": run.get("openingPrompt"),
            "continuationPrompt": run.get("continuationPrompt"),
            "sourceSegmentTiming": {
                "startFrame": int(source_segment.get("startFrame") or 0),
                "endFrameExclusive": int(source_segment.get("endFrameExclusive") or 0),
                "durationFrames": int(source_segment.get("durationFrames") or 0),
                "durationSec": round(float(source_segment.get("durationSec") or 0.0), 4),
                "fps": {"num": fps.numerator, "den": fps.denominator},
                "width": output_width,
                "height": output_height,
            },
            "storedOutput": _video_timing_payload(stitched_probe),
            "timelineAlignment": {
                "sourceFrameOffset": 0,
                "matchedSourceFrame": int(source_segment.get("startFrame") or 0),
                "confidence": 1.0,
                "strategy": "chunk_stitch_source_range",
            },
            "timelineConform": {
                "policy": "source_cfr_resolution",
                "applied": False,
                "durationDeltaSec": round(float(stitched_probe.get("duration_sec") or 0.0) - float(source_segment.get("durationSec") or 0.0), 4),
                "frameDelta": int(stitched_probe.get("frame_count") or 0) - int(source_segment.get("durationFrames") or 0),
            },
        },
        "createdAt": finished_at,
        "updatedAt": finished_at,
        "finishedAt": finished_at,
        "processingDurationSec": _processing_duration_seconds(job.get("startedAt"), finished_at),
        "error": None,
        "chunkedRunId": run_id,
        "chunkRole": "draft_stitched",
        "isChunkInternal": False,
        "parentGenerationId": run.get("parentGenerationId"),
        "extension": {
            "parentGenerationId": run.get("parentGenerationId"),
            "chunkedRunId": run_id,
            "continueToRangeEnd": True,
            "createdAt": finished_at,
        },
    }
    task.setdefault("segmentGenerations", {})[gen_id] = generation_record
    source_segment["selectedGenerationId"] = gen_id
    run["saveStatus"] = "complete"
    run["savedGenerationId"] = gen_id
    run["updatedAt"] = finished_at
    run["saveCompletedAt"] = finished_at
    _append_task_history_event(
        task,
        {
            "at": finished_at,
            "event": "chunked_generation.saved_draft",
            "runId": run_id,
            "genId": gen_id,
        },
    )
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 100, "complete", "Chunked draft saved")
    job["resultRefs"] = {"runId": run_id, "genId": gen_id, "outputKey": output_key}
    if poster_key:
        job["resultRefs"]["posterKey"] = poster_key
    store.save_job(job)
    return job


def _finalize_extension_chain_generation_after_success(
    *,
    store: S3JsonStore,
    task: dict[str, Any],
    settings: Any,
    gen_id: str,
) -> None:
    def _as_dict(value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    generation = task.get("segmentGenerations", {}).get(gen_id)
    if not isinstance(generation, dict):
        return
    if generation.get("status") != "complete":
        return
    if generation.get("isChunkInternal"):
        return
    if generation.get("chunkRole") == "draft_stitched":
        return
    extension = _as_dict(generation.get("extension"))
    if not extension:
        return
    if extension.get("type") == "clip_lengthen":
        return
    parent_generation_id = str(generation.get("parentGenerationId") or extension.get("parentGenerationId") or "")
    if not parent_generation_id or parent_generation_id == gen_id:
        return
    if generation.get("extensionStitchedFromGenerationId"):
        return
    if extension.get("stitchedGenerationId"):
        return

    existing_stitched = next(
        (
            item
            for item in task.get("segmentGenerations", {}).values()
            if isinstance(item, dict)
            and _as_dict(item.get("extension")).get("stitchedFromGenerationId") == gen_id
        ),
        None,
    )
    if isinstance(existing_stitched, dict):
        return

    parent = task.get("segmentGenerations", {}).get(parent_generation_id)
    if not isinstance(parent, dict) or parent.get("status") != "complete":
        return
    parent_output_key = parent.get("outputKey")
    child_output_key = generation.get("outputKey")
    if not isinstance(parent_output_key, str) or not parent_output_key:
        return
    if not isinstance(child_output_key, str) or not child_output_key:
        return

    output_width = int(task.get("video", {}).get("editSource", {}).get("width") or 0)
    output_height = int(task.get("video", {}).get("editSource", {}).get("height") or 0)
    if output_width <= 0 or output_height <= 0:
        return
    source_fps = task.get("video", {}).get("editSource", {}).get("fps", {}) if isinstance(task.get("video"), dict) else {}
    fps_num = int(source_fps.get("num") or 24)
    fps_den = int(source_fps.get("den") or 1)
    fps = Fraction(fps_num, fps_den)
    s3 = boto3.client("s3")
    paths = _asset_paths(task)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        parent_path = td_path / "extension_parent.mp4"
        child_path = td_path / "extension_child.mp4"
        stitched_path = td_path / "extension_stitched.mp4"
        _download_s3(s3, settings.assets_bucket, parent_output_key, parent_path)
        _download_s3(s3, settings.assets_bucket, child_output_key, child_path)
        parent_probe = ffprobe_video(str(parent_path))
        child_probe = ffprobe_video(str(child_path))
        parent_frame_count = int(parent_probe.get("frame_count") or 0)
        child_frame_count = int(child_probe.get("frame_count") or 0)
        if parent_frame_count <= 0 or child_frame_count <= 0:
            return

        source_generated_frame_index = int(
            extension.get("sourceGeneratedFrameIndex")
            if extension.get("sourceGeneratedFrameIndex") is not None
            else parent_frame_count - 1
        )
        source_generated_frame_index = max(0, min(parent_frame_count - 1, source_generated_frame_index))
        parent_keep_frames = max(1, source_generated_frame_index + 1)
        parent_trim_end_frames = max(0, parent_frame_count - parent_keep_frames)
        child_trim_start_frames = 1 if child_frame_count > 1 else 0

        stitch_video_segments(
            [str(parent_path), str(child_path)],
            str(stitched_path),
            fps_num=fps.numerator,
            fps_den=fps.denominator,
            output_width=output_width,
            output_height=output_height,
            trim_start_frames=[0, child_trim_start_frames],
            trim_end_frames=[parent_trim_end_frames, 0],
        )
        stitched_probe = ffprobe_video(str(stitched_path))
        stitched_gen_id = new_id("gen")
        display_segment_id = str(extension.get("previousSegmentId") or parent.get("segmentId") or generation.get("segmentId") or "")
        if not display_segment_id:
            return
        output_key = paths.segment_generated(display_segment_id, stitched_gen_id)
        s3.upload_file(
            str(stitched_path),
            settings.assets_bucket,
            output_key,
            ExtraArgs={"ContentType": "video/mp4"},
        )

    finished_at = now_iso()
    parent_alignment = _as_dict(parent.get("alignment"))
    parent_settings = _as_dict(parent.get("generationSettings"))
    parent_timeline_alignment = _as_dict(parent_settings.get("timelineAlignment"))
    source_frame_offset = int(
        parent.get("sourceFrameOffset")
        or parent_alignment.get("sourceFrameOffset")
        or parent_timeline_alignment.get("sourceFrameOffset")
        or 0
    )
    model_name = str(
        _as_dict(generation.get("luma")).get("model")
        or _as_dict(parent.get("luma")).get("model")
        or _as_dict(generation.get("generationSettings")).get("model")
        or parent_settings.get("model")
        or ""
    )
    mode_name = str(
        _as_dict(generation.get("luma")).get("mode")
        or _as_dict(parent.get("luma")).get("mode")
        or _as_dict(generation.get("generationSettings")).get("mode")
        or parent_settings.get("mode")
        or ""
    )
    prompt_value = (
        _as_dict(generation.get("luma")).get("prompt")
        or _as_dict(generation.get("generationSettings")).get("prompt")
        or _as_dict(parent.get("luma")).get("prompt")
        or parent_settings.get("prompt")
    )
    provider_name = _segment_generation_provider_name(model_name)
    timeline_alignment = {
        "sourceFrameOffset": source_frame_offset,
        "matchedSourceFrame": int(parent_alignment.get("matchedSourceFrame") or 0),
        "confidence": float(parent_alignment.get("confidence") or 1.0),
        "strategy": str(parent_alignment.get("strategy") or "extension_chain_stitch"),
    }
    stitched_duration_sec = round(float(stitched_probe.get("duration_sec") or 0.0), 3)
    stitched_frame_count = int(stitched_probe.get("frame_count") or 0)
    source_segment = next(
        (segment for segment in task.get("segments", []) if isinstance(segment, dict) and segment.get("segmentId") == display_segment_id),
        None,
    )
    source_segment_duration_sec = float(source_segment.get("durationSec") or 0.0) if isinstance(source_segment, dict) else 0.0
    source_segment_duration_frames = int(source_segment.get("durationFrames") or 0) if isinstance(source_segment, dict) else 0
    stitched_generation = {
        "genId": stitched_gen_id,
        "segmentId": display_segment_id,
        "luma": {
            "provider": provider_name,
            "model": model_name,
            "mode": mode_name,
            "prompt": prompt_value,
            "negativePrompt": _as_dict(generation.get("luma")).get("negativePrompt"),
            "lumaGenerationId": None,
        },
        "status": "complete",
        "outputKey": output_key,
        "posterKey": _create_segment_generation_poster(
            asset_store=asset_store,
            paths=paths,
            segment_id=display_segment_id,
            gen_id=stitched_gen_id,
            video_path=str(stitched_path),
        ),
        "sourceFirstFrameCaptureKey": parent.get("sourceFirstFrameCaptureKey") or generation.get("sourceFirstFrameCaptureKey"),
        "requestedDurationSec": round(max(stitched_duration_sec, source_segment_duration_sec), 3),
        "providerDurationSec": stitched_duration_sec,
        "sourceFrameOffset": source_frame_offset,
        "alignment": timeline_alignment,
        "generationSettings": {
            "provider": "extension_chain_stitch",
            "requestedModel": model_name,
            "model": model_name,
            "mode": mode_name,
            "prompt": prompt_value,
            "parentGenerationId": parent_generation_id,
            "stitchedFromGenerationId": gen_id,
            "sourceGeneratedFrameIndex": source_generated_frame_index,
            "trimStartChildFrames": child_trim_start_frames,
            "trimEndParentFrames": parent_trim_end_frames,
            "storedOutput": _video_timing_payload(stitched_probe),
            "timelineAlignment": timeline_alignment,
            "timelineConform": {
                "policy": "source_cfr_resolution",
                "applied": False,
                "durationDeltaSec": round(stitched_duration_sec - source_segment_duration_sec, 4),
                "frameDelta": stitched_frame_count - source_segment_duration_frames,
            },
        },
        "createdAt": finished_at,
        "updatedAt": finished_at,
        "finishedAt": finished_at,
        "processingDurationSec": None,
        "error": None,
        "parentGenerationId": parent_generation_id,
        "extension": {
            "parentGenerationId": parent_generation_id,
            "stitchedFromGenerationId": gen_id,
            "sourceGeneratedFrameIndex": source_generated_frame_index,
            "continueToRangeEnd": bool(extension.get("continueToRangeEnd")),
            "createdAt": finished_at,
        },
        "chunkRole": "extension_stitched",
        "isChunkInternal": False,
    }
    task.setdefault("segmentGenerations", {})[stitched_gen_id] = stitched_generation
    generation["isChunkInternal"] = True
    generation["chunkRole"] = generation.get("chunkRole") or "internal_extension_chunk"
    generation["extensionStitchedFromGenerationId"] = stitched_gen_id
    generation["updatedAt"] = finished_at
    if extension:
        extension["stitchedGenerationId"] = stitched_gen_id
        extension["updatedAt"] = finished_at
        generation["extension"] = extension
    if isinstance(source_segment, dict):
        source_segment["selectedGenerationId"] = stitched_gen_id
    _append_task_history_event(
        task,
        {
            "at": finished_at,
            "event": "extension_generation.stitched",
            "parentGenerationId": parent_generation_id,
            "sourceGenerationId": gen_id,
            "genId": stitched_gen_id,
            "segmentId": display_segment_id,
        },
    )
    store.save_task(task, merge_on_conflict=True)


def _handle_ingest(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    s3 = boto3.client("s3")
    asset_paths = _asset_paths(task)

    source_media = task.setdefault("sourceMedia", {})
    original_meta = source_media.get("original") if isinstance(source_media.get("original"), dict) else task["video"]["original"]
    original_key = original_meta["s3Key"]
    source_content_type = str(original_meta.get("contentType") or "")
    source_kind = str(source_media.get("kind") or ("audio" if source_content_type.startswith("audio/") else "video"))
    _job_progress(job, store, 5, "running", f"Downloading source {source_kind}")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        original_path = td_path / f"original{Path(original_key).suffix or ('.wav' if source_kind == 'audio' else '.mp4')}"
        edit_path = td_path / ("edit.wav" if source_kind == "audio" else "edit.mp4")
        preview_path = td_path / ("preview.m4a" if source_kind == "audio" else "preview.mp4")
        waveform_path = td_path / "waveform.png"

        _download_s3(s3, settings.assets_bucket, original_key, original_path)
        with open(original_path, "rb") as src_file:
            sha = hashlib.sha256()
            for chunk in iter(lambda: src_file.read(8 * 1024 * 1024), b""):
                sha.update(chunk)
            original_meta["sha256"] = sha.hexdigest()

        if source_kind == "audio":
            audio_probe = ffprobe_audio(str(original_path))
            duration_sec = float(audio_probe.get("duration_sec") or 0.0)
            if duration_sec > 600.0 + 1e-3:
                raise RuntimeError("Source audio is too long. Uploaded source audio must be 600.00s or shorter.")
            _job_progress(job, store, 15, "running", "Normalizing source audio for editing")
            transcode_audio_edit_source(
                str(original_path),
                str(edit_path),
                sample_rate=48000,
                channels=max(1, int(audio_probe.get("channels") or 2)),
            )
            edit_audio_probe = ffprobe_audio(str(edit_path))
            _job_progress(job, store, 28, "running", "Building lightweight audio preview")
            transcode_audio_preview(
                str(edit_path),
                str(preview_path),
                audio_bitrate="192k",
                sample_rate=int(edit_audio_probe.get("sample_rate") or 48000) or 48000,
            )
            _job_progress(job, store, 38, "running", "Generating waveform preview")
            generate_waveform_png(str(edit_path), str(waveform_path))
            edit_key = asset_paths.audio_edit_source()
            preview_key = asset_paths.audio_preview_source()
            waveform_key = asset_paths.audio_waveform()
            _upload_s3(s3, settings.assets_bucket, edit_key, edit_path, "audio/wav")
            _upload_s3(s3, settings.assets_bucket, preview_key, preview_path, "audio/mp4")
            _upload_s3(s3, settings.assets_bucket, waveform_key, waveform_path, "image/png")
            pseudo_fps = Fraction(100, 1)
            pseudo_frame_count = max(1, int(round(duration_sec * float(pseudo_fps))))
            waveform_width = 1280
            waveform_height = 240
            task["video"]["editSource"] = {
                "s3Key": edit_key,
                "fps": {"num": pseudo_fps.numerator, "den": pseudo_fps.denominator},
                "isVfrInput": False,
                "width": 0,
                "height": 0,
                "durationSec": round(duration_sec, 4),
                "frameCount": pseudo_frame_count,
                "mediaType": "audio",
                "contentType": "audio/wav",
                "waveformKey": waveform_key,
                "waveformWidth": waveform_width,
                "waveformHeight": waveform_height,
                "sampleRate": int(edit_audio_probe.get("sample_rate") or 48000),
                "channels": int(edit_audio_probe.get("channels") or 2),
            }
            task["video"]["previewSource"] = {
                "s3Key": preview_key,
                "width": 0,
                "height": 0,
                "durationSec": round(duration_sec, 4),
                "frameCount": pseudo_frame_count,
                "mediaType": "audio",
                "contentType": "audio/mp4",
            }
            task["sourceMedia"] = {
                "kind": "audio",
                "original": original_meta,
                "editSource": {
                    "s3Key": edit_key,
                    "contentType": "audio/wav",
                    "durationSec": round(duration_sec, 4),
                    "sampleRate": int(edit_audio_probe.get("sample_rate") or 48000),
                    "channels": int(edit_audio_probe.get("channels") or 2),
                    "codec": str(edit_audio_probe.get("codec") or "pcm_s16le"),
                    "frameCount": pseudo_frame_count,
                    "fps": {"num": pseudo_fps.numerator, "den": pseudo_fps.denominator},
                    "waveformKey": waveform_key,
                    "waveformWidth": waveform_width,
                    "waveformHeight": waveform_height,
                },
                "previewSource": {
                    "s3Key": preview_key,
                    "contentType": "audio/mp4",
                    "durationSec": round(duration_sec, 4),
                    "frameCount": pseudo_frame_count,
                },
                "waveform": {
                    "s3Key": waveform_key,
                    "width": waveform_width,
                    "height": waveform_height,
                },
            }
            manifest_key = None
        else:
            probe = ffprobe_video(str(original_path))
            duration_sec = float(probe.get("duration_sec") or 0.0)
            if duration_sec > SOURCE_VIDEO_MAX_DURATION_SECONDS + 1e-3:
                raise RuntimeError(
                    f"Source video is {duration_sec:.2f}s. Uploaded source videos must be {SOURCE_VIDEO_MAX_DURATION_SECONDS:.2f}s or shorter."
                )
            fps = Fraction(probe["fps_num"], probe["fps_den"]) if probe["fps_den"] else Fraction(30, 1)
            if fps.numerator <= 0 or fps.denominator <= 0:
                fps = Fraction(30, 1)
            if probe.get("is_vfr_input"):
                _job_progress(job, store, 15, "running", "Input is VFR: normalizing edit source to CFR at source resolution")
                transcode_to_cfr(
                    str(original_path),
                    str(edit_path),
                    fps,
                    crf=16,
                    preset="medium",
                    audio_bitrate="192k",
                )
                edit_source_path = edit_path
                edit_probe = ffprobe_video(str(edit_source_path))
            else:
                _job_progress(job, store, 15, "running", "Input already CFR: preserving source as edit source")
                edit_source_path = original_path
                edit_probe = probe

            _job_progress(job, store, 32, "running", "Building lightweight preview proxy")
            preview_w, preview_h = transcode_for_preview(
                str(edit_source_path),
                str(preview_path),
                fps=Fraction(edit_probe["fps_num"], edit_probe["fps_den"]) if edit_probe["fps_den"] else Fraction(30, 1),
                source_width=edit_probe["width"],
                source_height=edit_probe["height"],
            )

            edit_key = asset_paths.edit_source()
            _upload_s3(s3, settings.assets_bucket, edit_key, edit_source_path, "video/mp4")
            preview_key = asset_paths.preview_source()
            _upload_s3(s3, settings.assets_bucket, preview_key, preview_path, "video/mp4")
            _job_progress(job, store, 45, "running", "Generating timeline thumbnails")

            thumbs_dir = td_path / "thumbs"
            thumbs = generate_thumbnail_strip(str(edit_source_path), str(thumbs_dir), fps=1, width=320)
            thumb_manifest: list[dict[str, Any]] = []
            for item in thumbs:
                source = thumbs_dir / item["filename"]
                key = f"{asset_paths.thumbs_prefix()}/{item['filename']}"
                _upload_s3(s3, settings.assets_bucket, key, source, "image/jpeg")
                thumb_manifest.append({
                    "frameIndex": item["index"],
                    "timeSec": item["timeSec"],
                    "key": key,
                })

            manifest_key = f"{asset_paths.thumbs_prefix()}/manifest.json"
            asset_store.put_bytes(manifest_key, json.dumps({"frames": thumb_manifest}).encode("utf-8"), content_type="application/json")

            task["video"]["editSource"] = {
                "s3Key": edit_key,
                "fps": {"num": edit_probe["fps_num"], "den": edit_probe["fps_den"]},
                "isVfrInput": probe["is_vfr_input"],
                "width": edit_probe["width"],
                "height": edit_probe["height"],
                "durationSec": edit_probe["duration_sec"],
                "frameCount": edit_probe["frame_count"],
                "mediaType": "video",
                "contentType": "video/mp4",
            }
            task["video"]["previewSource"] = {
                "s3Key": preview_key,
                "width": preview_w,
                "height": preview_h,
                "durationSec": edit_probe["duration_sec"],
                "frameCount": edit_probe["frame_count"],
                "mediaType": "video",
                "contentType": "video/mp4",
            }
            task["sourceMedia"] = {
                "kind": "video",
                "original": original_meta,
                "editSource": {
                    "s3Key": edit_key,
                    "contentType": "video/mp4",
                    "durationSec": edit_probe["duration_sec"],
                    "frameCount": edit_probe["frame_count"],
                    "width": edit_probe["width"],
                    "height": edit_probe["height"],
                    "fps": {"num": edit_probe["fps_num"], "den": edit_probe["fps_den"]},
                    "isVfrInput": probe["is_vfr_input"],
                },
                "previewSource": {
                    "s3Key": preview_key,
                    "contentType": "video/mp4",
                    "durationSec": edit_probe["duration_sec"],
                    "frameCount": edit_probe["frame_count"],
                    "width": preview_w,
                    "height": preview_h,
                },
            }

    task["status"] = "ready"
    task.setdefault("history", []).append(
        {
            "at": now_iso(),
            "event": "task.ingest.complete",
            "jobId": job["jobId"],
        }
    )
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Ingest completed")
    job["resultRefs"] = {"taskId": task["taskId"], "manifestKey": manifest_key}
    store.save_job(job)
    return job


def _find_task_document(task: dict[str, Any], document_id: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in task.get("documents", [])
            if isinstance(item, dict) and str(item.get("documentId") or "") == str(document_id)
        ),
        None,
    )


def _find_task_document_ingest(task: dict[str, Any], ingest_id: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in task.get("documentIngests", [])
            if isinstance(item, dict) and str(item.get("ingestId") or "") == str(ingest_id)
        ),
        None,
    )


def _handle_pdf_ingest(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job.get("payload") or {}
    document_id = str(payload.get("documentId") or "").strip()
    ingest_id = str(payload.get("ingestId") or "").strip()
    ingest_mode = str(payload.get("mode") or "all").strip() or "all"
    result_key = str(payload.get("resultKey") or "").strip()
    if not document_id or not ingest_id or not result_key:
        raise RuntimeError("PDF ingest payload is incomplete")

    document = _find_task_document(task, document_id)
    if not isinstance(document, dict):
        raise RuntimeError("Document not found")
    ingest_record = _find_task_document_ingest(task, ingest_id)
    if not isinstance(ingest_record, dict):
        raise RuntimeError("Document ingest record not found")

    original_key = str(document.get("originalKey") or "").strip()
    if not original_key:
        raise RuntimeError("Document source file is missing")

    now = now_iso()
    ingest_record["status"] = "running"
    ingest_record["updatedAt"] = now
    ingest_record["startedAt"] = str(ingest_record.get("startedAt") or now)
    ingest_record["jobId"] = job.get("jobId")
    document["updatedAt"] = now
    store.save_task(task, merge_on_conflict=True)
    document = _find_task_document(task, document_id)
    ingest_record = _find_task_document_ingest(task, ingest_id)
    if not isinstance(document, dict) or not isinstance(ingest_record, dict):
        raise RuntimeError("Document ingest state became unavailable")

    _job_progress(job, store, 10, "running", "Downloading PDF document")
    pdf_bytes = asset_store.read_bytes(original_key)

    extract_text_tables = ingest_mode in {"text_tables", "all"}
    extract_images = ingest_mode in {"images", "all"}
    _job_progress(job, store, 40, "running", "Extracting PDF contents")
    result_payload, extracted_images = extract_pdf_contents(
        pdf_bytes,
        extract_text_tables=extract_text_tables,
        extract_images=extract_images,
    )

    image_assets: list[dict[str, Any]] = []
    image_assets_by_digest: dict[str, dict[str, Any]] = {}
    if extract_images and extracted_images:
        _job_progress(job, store, 70, "running", "Saving extracted PDF images")
        paths = _asset_paths(task)
        task_document_image_assets = task.setdefault("documentImageAssets", [])
        existing_assets_by_digest = {
            str(item.get("digest") or ""): item
            for item in task_document_image_assets
            if isinstance(item, dict)
            and str(item.get("sourceDocumentId") or "") == document_id
            and str(item.get("digest") or "")
        }
        workflow_id = str(task.get("workflowId") or "")
        for extracted_image in extracted_images:
            existing_asset = existing_assets_by_digest.get(extracted_image.digest)
            created_at = now_iso()
            if isinstance(existing_asset, dict) and str(existing_asset.get("imageKey") or "").strip():
                ingest_ids = [
                    str(value)
                    for value in (existing_asset.get("ingestIds") or [])
                    if isinstance(value, str) and value.strip()
                ]
                if ingest_id not in ingest_ids:
                    ingest_ids.append(ingest_id)
                existing_asset["ingestIds"] = ingest_ids
                existing_asset["latestIngestId"] = ingest_id
                existing_asset["pageNumbers"] = sorted({*existing_asset.get("pageNumbers", []), *extracted_image.page_numbers})
                existing_asset["occurrenceCount"] = max(
                    int(existing_asset.get("occurrenceCount") or 0),
                    len(extracted_image.occurrences),
                )
                existing_asset["updatedAt"] = created_at
                image_asset_record = existing_asset
            else:
                asset_id = new_id("docimg")
                image_key = paths.document_ingest_image(document_id, ingest_id, asset_id, extracted_image.ext)
                asset_store.put_bytes(image_key, extracted_image.bytes_data, content_type=extracted_image.mime_type)
                image_asset_record = {
                    "assetId": asset_id,
                    "assetKind": "document_image",
                    "documentId": document_id,
                    "sourceDocumentId": document_id,
                    "ingestId": ingest_id,
                    "latestIngestId": ingest_id,
                    "ingestIds": [ingest_id],
                    "filename": f"{document_id}_{asset_id}.{extracted_image.ext}",
                    "imageKey": image_key,
                    "contentType": extracted_image.mime_type,
                    "width": extracted_image.width,
                    "height": extracted_image.height,
                    "digest": extracted_image.digest,
                    "pageNumbers": list(extracted_image.page_numbers),
                    "occurrenceCount": len(extracted_image.occurrences),
                    "createdAt": created_at,
                    "updatedAt": created_at,
                    "origin": build_asset_origin(
                        workflow_id=workflow_id,
                        step_origin="documents",
                        tool_origin="pdf_ingest",
                        extension={
                            "documentId": document_id,
                            "ingestId": ingest_id,
                            "documentKind": "pdf",
                        },
                    ),
                }
                task_document_image_assets.append(image_asset_record)
            image_assets.append(image_asset_record)
            image_assets_by_digest[extracted_image.digest] = image_asset_record

        for page in result_payload.get("pages", []):
            if not isinstance(page, dict):
                continue
            resolved_refs: list[dict[str, Any]] = []
            for image_ref in page.get("imageRefs", []) or []:
                if not isinstance(image_ref, dict):
                    continue
                resolved_ref = dict(image_ref)
                image_asset = image_assets_by_digest.get(str(image_ref.get("digest") or ""))
                if isinstance(image_asset, dict):
                    resolved_ref["assetId"] = image_asset["assetId"]
                    resolved_ref["imageKey"] = image_asset["imageKey"]
                resolved_refs.append(resolved_ref)
            page["imageRefs"] = resolved_refs

    result_payload["documentId"] = document_id
    result_payload["ingestId"] = ingest_id
    result_payload["mode"] = ingest_mode
    result_payload["imageAssets"] = [
        {
            "assetId": item["assetId"],
            "imageKey": item["imageKey"],
            "filename": item["filename"],
            "contentType": item["contentType"],
            "width": item["width"],
            "height": item["height"],
            "digest": item["digest"],
            "pageNumbers": item["pageNumbers"],
            "occurrenceCount": item["occurrenceCount"],
        }
        for item in image_assets
    ]
    asset_store.put_bytes(
        result_key,
        json.dumps(result_payload, separators=(",", ":"), default=str).encode("utf-8"),
        content_type="application/json",
    )

    finished_at = now_iso()
    document = _find_task_document(task, document_id)
    ingest_record = _find_task_document_ingest(task, ingest_id)
    if not isinstance(document, dict) or not isinstance(ingest_record, dict):
        raise RuntimeError("Document ingest state became unavailable before completion")
    ingest_record["status"] = "complete"
    ingest_record["updatedAt"] = finished_at
    ingest_record["finishedAt"] = finished_at
    ingest_record["error"] = None
    ingest_record["resultKey"] = result_key
    ingest_record["summary"] = dict(result_payload.get("summary") or {})
    ingest_record["warnings"] = list(result_payload.get("warnings") or [])
    ingest_record["imageAssets"] = [
        {
            "assetId": item["assetId"],
            "imageKey": item["imageKey"],
            "filename": item["filename"],
            "contentType": item["contentType"],
            "width": item["width"],
            "height": item["height"],
            "pageNumbers": item["pageNumbers"],
            "occurrenceCount": item["occurrenceCount"],
        }
        for item in image_assets
    ]
    document["latestIngestId"] = ingest_id
    document["updatedAt"] = finished_at
    task.setdefault("history", []).append(
        {
            "at": finished_at,
            "event": "document.ingest.complete",
            "jobId": job.get("jobId"),
            "documentId": document_id,
            "ingestId": ingest_id,
            "mode": ingest_mode,
        }
    )
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 100, "complete", "PDF ingest completed")
    job["resultRefs"] = {
        "documentId": document_id,
        "ingestId": ingest_id,
        "resultKey": result_key,
        "imageAssetIds": [item["assetId"] for item in image_assets],
    }
    store.save_job(job)
    return job


def _parse_luma_output_url(payload: dict[str, Any]) -> str:
    candidates: list[str | None] = [
        payload.get("assets", {}).get("video"),
        payload.get("video", {}).get("url"),
        payload.get("result", {}).get("url"),
    ]
    videos = payload.get("assets", {}).get("videos")
    if isinstance(videos, list) and videos:
        maybe = videos[0]
        if isinstance(maybe, dict):
            candidates.append(maybe.get("url"))
        elif isinstance(maybe, str):
            candidates.append(maybe)
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if isinstance(item, dict):
                candidates.append(item.get("url"))
            elif isinstance(item, str):
                candidates.append(item)
    for value in candidates:
        if isinstance(value, str) and value.startswith("http"):
            return value
    raise RuntimeError("Luma completion payload missing output URL")


def _wait_luma_complete(api_key: str, generation_id: str, *, timeout_sec: int = 900) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_video_generation(api_key=api_key, generation_id=generation_id)
        state = str(payload.get("state") or payload.get("status") or "").lower()
        if state in {"completed", "complete", "succeeded", "success"}:
            return payload
        if state in {"failed", "error", "cancelled"}:
            raise RuntimeError(f"Luma generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Luma generation poll timeout")
        time.sleep(6)


def _luma_ray32_resolution_label(model_name: str) -> str:
    if model_name == "ray-3.2-1080p":
        return "1080p"
    return "720p"


def _parse_luma_uni_output_url(payload: dict[str, Any]) -> str:
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            maybe = item.get("url")
            if isinstance(maybe, str) and maybe.startswith("http"):
                return maybe
    raise RuntimeError(f"Luma Uni completion payload missing output URL: {payload}")


def _wait_luma_uni_complete(api_key: str, generation_id: str, *, timeout_sec: int = 1200) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_uni_generation(api_key=api_key, generation_id=generation_id)
        state = str(payload.get("state") or "").lower()
        if state in {"completed", "complete", "succeeded", "success"}:
            return payload
        if state in {"failed", "error", "cancelled"}:
            raise RuntimeError(f"Luma Uni generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Luma Uni generation poll timeout")
        time.sleep(6)


def _is_luma_uni_full_edit_model(model_name: str) -> bool:
    return model_name in {"luma_uni_1", "luma_uni_1_max", "luma_uni_1_1"}


def _resolve_luma_uni_options(model_name: str, payload: dict[str, Any]) -> tuple[str, str, str]:
    if model_name == "luma_uni_1_max":
        resolved_model = "uni-1-max"
    elif model_name == "luma_uni_1":
        resolved_model = "uni-1"
    else:
        resolved_model = str(payload.get("lumaUniModel") or "uni-1")
    resolved_style = str(payload.get("lumaUniStyle") or "auto")
    resolved_output_format = str(payload.get("lumaUniOutputFormat") or "png")
    return resolved_model, resolved_style, resolved_output_format


def _clean_optional_api_key(value: Any) -> str | None:
    if value is None:
        return None
    key = str(value).strip()
    if not key:
        return None
    # Ignore common placeholder values so they don't shadow real configured keys.
    if key.upper() in {"SET_ME", "CHANGEME", "CHANGE_ME", "REPLACE_ME"}:
        return None
    return key


def _is_luma_agents_api_key(value: str) -> bool:
    return value.startswith("luma-api-")


def _resolve_luma_uni_api_key(secrets: dict[str, Any]) -> str | None:
    # Uni (agents.lumalabs.ai) requires an Agents API key (`luma-api-*`).
    # Prefer the dedicated Agents key first, then allow LUMA_API_KEY only
    # when it is also an Agents-style token.
    luma_agents_key = _clean_optional_api_key(secrets.get("LUMA_AGENTS_API_KEY"))
    if luma_agents_key and _is_luma_agents_api_key(luma_agents_key):
        return luma_agents_key
    luma_api_key = _clean_optional_api_key(secrets.get("LUMA_API_KEY"))
    if luma_api_key and _is_luma_agents_api_key(luma_api_key):
        return luma_api_key
    return None


def _parse_runway_output_url(payload: dict[str, Any]) -> str:
    output = payload.get("output") or payload.get("outputUrls") or payload.get("artifactUrls") or payload.get("artifacts")
    if isinstance(output, list):
        for item in output:
            if isinstance(item, str) and item.startswith("http"):
                return item
            if isinstance(item, dict):
                maybe = item.get("url") or item.get("uri")
                if isinstance(maybe, str) and maybe.startswith("http"):
                    return maybe
                for key in ("video", "asset", "artifact"):
                    nested = item.get(key)
                    if isinstance(nested, dict):
                        maybe_nested = nested.get("url") or nested.get("uri")
                        if isinstance(maybe_nested, str) and maybe_nested.startswith("http"):
                            return maybe_nested
    elif isinstance(output, str) and output.startswith("http"):
        return output
    direct_candidates = [
        payload.get("videoUrl"),
        payload.get("videoURL"),
        payload.get("url"),
    ]
    for value in direct_candidates:
        if isinstance(value, str) and value.startswith("http"):
            return value
    raise RuntimeError(f"Runway completion payload missing output URL: {payload}")


def _wait_runway_complete(api_key: str, task_id: str, *, timeout_sec: int = 1800) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_runway_task(api_key=api_key, task_id=task_id)
        status = str(payload.get("status", "")).upper()
        if status == "SUCCEEDED":
            return payload
        if status in {"FAILED", "CANCELLED"}:
            raise RuntimeError(f"Runway generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Runway generation poll timeout")
        time.sleep(6)


def _upload_runway_ephemeral_asset(*, api_key: str, file_path: Path, content_type: str) -> str:
    created = create_ephemeral_upload(api_key=api_key, filename=file_path.name)
    upload_url = created.get("uploadUrl")
    fields = created.get("fields")
    runway_uri = created.get("runwayUri") or created.get("uri")
    if not isinstance(upload_url, str) or not isinstance(fields, dict) or not isinstance(runway_uri, str):
        raise RuntimeError(f"Unexpected Runway upload response: {created}")
    upload_to_ephemeral(upload_url=upload_url, fields=fields, file_path=file_path, content_type=content_type)
    return runway_uri


def _parse_runware_video_output_url(payload: dict[str, Any]) -> str:
    candidates: list[Any] = [
        payload.get("videoURL"),
        payload.get("video", {}).get("url"),
        payload.get("video", {}).get("videoURL"),
        payload.get("video_url"),
        payload.get("url"),
        payload.get("result", {}).get("video", {}).get("url") if isinstance(payload.get("result"), dict) else None,
        payload.get("result", {}).get("video", {}).get("videoURL") if isinstance(payload.get("result"), dict) else None,
        payload.get("result", {}).get("video_url") if isinstance(payload.get("result"), dict) else None,
        payload.get("result", {}).get("videoURL") if isinstance(payload.get("result"), dict) else None,
    ]
    outputs = payload.get("outputs")
    if isinstance(outputs, list):
        candidates.extend(outputs)
    videos = payload.get("videos")
    if isinstance(videos, list):
        candidates.extend(videos)
    for item in candidates:
        if isinstance(item, str) and item.startswith("http"):
            return item
        if isinstance(item, dict):
            maybe = item.get("url") or item.get("video_url") or item.get("videoURL")
            if isinstance(maybe, str) and maybe.startswith("http"):
                return maybe
    raise RuntimeError(f"Runware video completion payload missing output URL: {payload}")


def _wait_kling_complete(api_key: str, *, task_uuid: str, timeout_sec: int = 1800) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_kling_generation_response(api_key=api_key, task_uuid=task_uuid)
        status = str(payload.get("status", "")).upper()
        if status in {"COMPLETED", "SUCCEEDED", "SUCCESS"}:
            return payload
        if status in {"FAILED", "ERROR", "CANCELLED"}:
            raise RuntimeError(f"Kling generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Kling generation poll timeout")
        time.sleep(6)


def _wait_runware_video_complete(api_key: str, *, task_uuid: str, timeout_sec: int = RUNWARE_VIDEO_POLL_TIMEOUT_SEC) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_runware_video_generation_response(api_key=api_key, task_uuid=task_uuid)
        status = str(payload.get("status", "")).upper()
        if status in {"COMPLETED", "SUCCEEDED", "SUCCESS"}:
            return payload
        if status in {"FAILED", "ERROR", "CANCELLED"}:
            raise RuntimeError(f"Runware video generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Runware video generation poll timeout")
        time.sleep(6)


def _parse_replicate_output_url(payload: dict[str, Any]) -> str:
    output = payload.get("output")
    if isinstance(output, str) and output.startswith("http"):
        return output
    if isinstance(output, list):
        for item in output:
            if isinstance(item, str) and item.startswith("http"):
                return item
            if isinstance(item, dict):
                maybe = item.get("url")
                if isinstance(maybe, str) and maybe.startswith("http"):
                    return maybe
    if isinstance(output, dict):
        maybe = output.get("url")
        if isinstance(maybe, str) and maybe.startswith("http"):
            return maybe
    raise RuntimeError(f"Replicate prediction output missing URL: {payload}")


def _wait_replicate_complete(api_key: str, *, prediction_id: str, timeout_sec: int = 3600) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_replicate_prediction(api_key=api_key, prediction_id=prediction_id)
        status = str(payload.get("status", "")).lower()
        if status == "succeeded":
            return payload
        if status in {"failed", "canceled", "cancelled"}:
            raise RuntimeError(f"Replicate prediction failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Replicate prediction poll timeout")
        time.sleep(8)


def _parse_fal_video_output_url(payload: dict[str, Any]) -> str:
    video = payload.get("video")
    if isinstance(video, str) and video.startswith("http"):
        return video
    if isinstance(video, dict):
        maybe = video.get("url")
        if isinstance(maybe, str) and maybe.startswith("http"):
            return maybe
    raise RuntimeError(f"fal.ai output missing video URL: {payload}")


def _wait_fal_queue_complete(api_key: str, *, created: dict[str, Any], timeout_sec: int = 3600) -> dict[str, Any]:
    status_url = created.get("status_url")
    response_url = created.get("response_url")
    request_id = created.get("request_id")
    if not isinstance(status_url, str) or not isinstance(response_url, str):
        raise RuntimeError(f"Unexpected fal.ai queue response: {created}")
    start = time.time()
    while True:
        payload = get_fal_queue_status(api_key=api_key, status_url=status_url)
        status = str(payload.get("status", "")).upper()
        if status == "COMPLETED":
            return get_fal_queue_result(api_key=api_key, response_url=response_url)
        if status in {"FAILED", "ERROR", "CANCELLED"}:
            raise RuntimeError(f"fal.ai request failed: {payload}")
        if payload.get("error"):
            raise RuntimeError(f"fal.ai request failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError(f"fal.ai poll timeout for request {request_id or 'unknown'}")
        time.sleep(8)


def _run_wan27_prediction(
    *,
    api_key: str,
    prompt: str,
    media_url: str,
    reference_image: str,
    resolution: str,
    aspect_ratio: str,
    audio_setting: str,
    job: dict[str, Any],
    store: S3JsonStore,
) -> tuple[str, dict[str, Any]]:
    input_payload: dict[str, Any] = {
        "video": media_url,
        "prompt": prompt,
        "reference_image": reference_image,
        "resolution": resolution,
        "aspect_ratio": aspect_ratio,
        "audio_setting": audio_setting,
    }
    last_exc: BaseException | None = None
    for retry_index in range(3):
        _job_progress(job, store, 35, "running", "Creating Replicate Wan 2.7 VideoEdit generation")
        created = create_replicate_official_model_prediction(
            api_key=api_key,
            owner="wan-video",
            name="wan-2.7-videoedit",
            input=input_payload,
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate Wan 2.7 create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate Wan 2.7 VideoEdit generation")
        try:
            result = _wait_replicate_complete(api_key, prediction_id=generation_id)
            return generation_id, result
        except RuntimeError as exc:
            last_exc = exc
            message = str(exc)
            if ("(E004)" in message or "temporarily unavailable" in message.lower()) and retry_index < 2:
                wait_sec = 15 * (retry_index + 1)
                _job_progress(
                    job,
                    store,
                    55,
                    "running",
                    f"Wan 2.7 provider is temporarily unavailable, retrying in {wait_sec}s",
                )
                time.sleep(wait_sec)
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Wan 2.7 generation did not produce a result")


def _run_wan27_i2v_prediction(
    *,
    api_key: str,
    prompt: str,
    first_frame: str,
    last_frame: str | None,
    negative_prompt: str | None,
    resolution: str,
    duration_seconds: int,
    job: dict[str, Any],
    store: S3JsonStore,
) -> tuple[str, dict[str, Any]]:
    input_payload: dict[str, Any] = {
        "first_frame": first_frame,
        "prompt": prompt,
        "resolution": resolution,
        "duration": int(duration_seconds),
        "enable_prompt_expansion": True,
    }
    if last_frame:
        input_payload["last_frame"] = last_frame
    if negative_prompt:
        input_payload["negative_prompt"] = negative_prompt
    last_exc: BaseException | None = None
    for retry_index in range(3):
        _job_progress(job, store, 35, "running", "Creating Replicate Wan 2.7 image-to-video generation")
        created = create_replicate_official_model_prediction(
            api_key=api_key,
            owner="wan-video",
            name="wan-2.7-i2v",
            input=input_payload,
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate Wan 2.7 I2V create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate Wan 2.7 image-to-video generation")
        try:
            result = _wait_replicate_complete(api_key, prediction_id=generation_id)
            return generation_id, result
        except RuntimeError as exc:
            last_exc = exc
            message = str(exc)
            if ("(E004)" in message or "temporarily unavailable" in message.lower()) and retry_index < 2:
                wait_sec = 15 * (retry_index + 1)
                _job_progress(
                    job,
                    store,
                    55,
                    "running",
                    f"Wan 2.7 provider is temporarily unavailable, retrying in {wait_sec}s",
                )
                time.sleep(wait_sec)
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Wan 2.7 image-to-video generation did not produce a result")


def _run_wan27_continuation_prediction(
    *,
    api_key: str,
    prompt: str,
    first_clip: str,
    negative_prompt: str | None,
    resolution: str,
    duration_seconds: int,
    job: dict[str, Any],
    store: S3JsonStore,
) -> tuple[str, dict[str, Any]]:
    input_payload: dict[str, Any] = {
        "first_clip": first_clip,
        "prompt": prompt,
        "resolution": resolution,
        "duration": int(duration_seconds),
        "enable_prompt_expansion": True,
    }
    if negative_prompt:
        input_payload["negative_prompt"] = negative_prompt
    last_exc: BaseException | None = None
    for retry_index in range(3):
        _job_progress(job, store, 35, "running", "Creating Replicate Wan 2.7 clip continuation")
        created = create_replicate_official_model_prediction(
            api_key=api_key,
            owner="wan-video",
            name="wan-2.7-i2v",
            input=input_payload,
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate Wan 2.7 clip continuation response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate Wan 2.7 clip continuation")
        try:
            result = _wait_replicate_complete(api_key, prediction_id=generation_id)
            return generation_id, result
        except RuntimeError as exc:
            last_exc = exc
            message = str(exc)
            if ("(E004)" in message or "temporarily unavailable" in message.lower()) and retry_index < 2:
                wait_sec = 15 * (retry_index + 1)
                _job_progress(
                    job,
                    store,
                    55,
                    "running",
                    f"Wan 2.7 provider is temporarily unavailable, retrying in {wait_sec}s",
                )
                time.sleep(wait_sec)
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Wan 2.7 clip continuation did not produce a result")


def _run_ltx23_i2v_prediction(
    *,
    api_key: str,
    prompt: str,
    first_frame: str,
    last_frame: str | None,
    duration_seconds: int,
    aspect_ratio: str,
    fps: int,
    generate_audio: bool,
    job: dict[str, Any],
    store: S3JsonStore,
) -> tuple[str, dict[str, Any]]:
    input_payload: dict[str, Any] = {
        "task": "image_to_video",
        "prompt": prompt,
        "image": first_frame,
        "last_frame_image": last_frame,
        "duration": int(duration_seconds),
        "aspect_ratio": aspect_ratio if aspect_ratio in {"16:9", "9:16"} else "16:9",
        "fps": int(fps),
        "resolution": "1080p",
        "generate_audio": bool(generate_audio),
    }
    if not last_frame:
        input_payload.pop("last_frame_image")
    last_exc: BaseException | None = None
    for retry_index in range(3):
        _job_progress(job, store, 35, "running", "Creating Replicate LTX 2.3 Pro generation")
        created = create_replicate_official_model_prediction(
            api_key=api_key,
            owner="lightricks",
            name="ltx-2.3-pro",
            input=input_payload,
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate LTX 2.3 Pro create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate LTX 2.3 Pro generation")
        try:
            result = _wait_replicate_complete(api_key, prediction_id=generation_id)
            return generation_id, result
        except RuntimeError as exc:
            last_exc = exc
            message = str(exc)
            if ("(E004)" in message or "temporarily unavailable" in message.lower()) and retry_index < 2:
                wait_sec = 15 * (retry_index + 1)
                _job_progress(
                    job,
                    store,
                    55,
                    "running",
                    f"LTX 2.3 Pro is temporarily unavailable, retrying in {wait_sec}s",
                )
                time.sleep(wait_sec)
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("LTX 2.3 Pro generation did not produce a result")


def _run_ltx23_extend_prediction(
    *,
    api_key: str,
    prompt: str,
    video: str,
    duration_seconds: int,
    extend_mode: str,
    fps: int,
    generate_audio: bool,
    job: dict[str, Any],
    store: S3JsonStore,
) -> tuple[str, dict[str, Any]]:
    input_payload: dict[str, Any] = {
        "task": "extend",
        "prompt": prompt,
        "video": video,
        "duration": int(duration_seconds),
        "extend_mode": extend_mode if extend_mode in {"start", "end"} else "end",
        "fps": int(fps),
        "resolution": "1080p",
        "generate_audio": bool(generate_audio),
    }
    last_exc: BaseException | None = None
    for retry_index in range(3):
        _job_progress(job, store, 35, "running", "Creating Replicate LTX 2.3 Pro extension")
        created = create_replicate_official_model_prediction(
            api_key=api_key,
            owner="lightricks",
            name="ltx-2.3-pro",
            input=input_payload,
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate LTX 2.3 Pro extension response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate LTX 2.3 Pro extension")
        try:
            result = _wait_replicate_complete(api_key, prediction_id=generation_id)
            return generation_id, result
        except RuntimeError as exc:
            last_exc = exc
            message = str(exc)
            if ("(E004)" in message or "temporarily unavailable" in message.lower()) and retry_index < 2:
                wait_sec = 15 * (retry_index + 1)
                _job_progress(
                    job,
                    store,
                    55,
                    "running",
                    f"LTX 2.3 Pro is temporarily unavailable, retrying in {wait_sec}s",
                )
                time.sleep(wait_sec)
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("LTX 2.3 Pro extension did not produce a result")


def _alpha_mask_for_rect(size: tuple[int, int], rect: dict[str, int], feather_px: int, bleed_px: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    x = max(0, rect["x"] - bleed_px)
    y = max(0, rect["y"] - bleed_px)
    w = rect["width"] + 2 * bleed_px
    h = rect["height"] + 2 * bleed_px
    patch = Image.new("L", (w, h), 255)
    if feather_px > 0:
        patch = patch.filter(ImageFilter.GaussianBlur(radius=feather_px / 2))
    mask.paste(patch, (x, y))
    return mask


def _grow_or_shrink_mask(mask: Image.Image, grow_px: int) -> Image.Image:
    distance = int(grow_px)
    if distance == 0:
        return mask
    kernel_size = max(3, (abs(distance) * 2) + 1)
    if distance > 0:
        return mask.filter(ImageFilter.MaxFilter(kernel_size))
    return mask.filter(ImageFilter.MinFilter(kernel_size))


def _binarize_mask(mask: Image.Image, threshold: int = 24) -> Image.Image:
    gray = mask.convert("L")
    return gray.point(lambda value: 255 if value >= threshold else 0)


def _edge_refine_mask(
    *,
    mask: Image.Image,
    source: Image.Image,
    enabled: bool,
    strength: float,
    radius_px: int,
    grow_px: int,
) -> Image.Image:
    refined = _grow_or_shrink_mask(_binarize_mask(mask), grow_px)
    if not enabled or strength <= 0:
        return refined

    edge_source = source.convert("L").filter(ImageFilter.FIND_EDGES)
    if radius_px > 0:
        edge_source = edge_source.filter(ImageFilter.GaussianBlur(radius=max(0.5, radius_px / 2)))
    edge_source = ImageOps.autocontrast(edge_source)
    clamped_strength = max(0.0, min(1.0, float(strength)))
    attenuation = edge_source.point(lambda value: max(0, min(255, int(255 - (value * clamped_strength)))))
    return ImageChops.multiply(refined, attenuation)


def _composite_patch(
    *,
    base_bytes: bytes,
    patch_bytes: bytes,
    rect: dict[str, int],
    bleed_px: int,
    feather_px: int,
    mask_bytes: bytes | None,
) -> bytes:
    base = Image.open(BytesIO(base_bytes)).convert("RGBA")
    patch = Image.open(BytesIO(patch_bytes)).convert("RGBA")

    target_w = rect["width"] + 2 * bleed_px
    target_h = rect["height"] + 2 * bleed_px
    patch = patch.resize((target_w, target_h), Image.Resampling.LANCZOS)

    comp = base.copy()
    x = max(0, rect["x"] - bleed_px)
    y = max(0, rect["y"] - bleed_px)

    if mask_bytes:
        mask = Image.open(BytesIO(mask_bytes)).convert("L")
        if mask.size == (target_w, target_h):
            full_mask = Image.new("L", base.size, 0)
            full_mask.paste(mask, (x, y))
            mask = full_mask
        elif mask.size != base.size:
            mask = mask.resize(base.size, Image.Resampling.BILINEAR)
        if feather_px > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(radius=feather_px / 2))
        patch_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        patch_layer.paste(patch, (x, y))
        comp = Image.composite(patch_layer, base, mask)
    else:
        mask = _alpha_mask_for_rect(base.size, rect, feather_px, bleed_px)
        patch_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        patch_layer.paste(patch, (x, y))
        comp = Image.composite(patch_layer, base, mask)

    out = BytesIO()
    comp.save(out, format="PNG")
    return out.getvalue()


def _normalize_patch_rect(rect: dict[str, Any], width: int, height: int) -> dict[str, int]:
    safe_w = max(1, int(width))
    safe_h = max(1, int(height))
    x = max(0, min(int(rect.get("x", 0)), safe_w - 1))
    y = max(0, min(int(rect.get("y", 0)), safe_h - 1))
    w = max(1, min(int(rect.get("width", safe_w)), safe_w - x))
    h = max(1, min(int(rect.get("height", safe_h)), safe_h - y))
    return {"x": x, "y": y, "width": w, "height": h}


def _normalize_full_variant(*, source_bytes: bytes, variant_bytes: bytes) -> bytes:
    source = ImageOps.exif_transpose(Image.open(BytesIO(source_bytes))).convert("RGBA")
    variant = ImageOps.exif_transpose(Image.open(BytesIO(variant_bytes))).convert("RGBA")
    if variant.size != source.size:
        source_ratio = source.width / max(1, source.height)
        variant_ratio = variant.width / max(1, variant.height)
        ratio_delta = abs(math.log(max(1e-6, variant_ratio / source_ratio)))
        if ratio_delta < 0.02:
            variant = variant.resize(source.size, Image.Resampling.LANCZOS)
        else:
            # Prefer geometric consistency over padded edges when model output AR drifts.
            variant = ImageOps.fit(variant, source.size, Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    out = BytesIO()
    variant.save(out, format="PNG")
    return out.getvalue()


def _align_variant_to_source(*, source_bytes: bytes, variant_bytes: bytes) -> bytes:
    source = ImageOps.exif_transpose(Image.open(BytesIO(source_bytes))).convert("RGBA")
    variant = ImageOps.exif_transpose(Image.open(BytesIO(variant_bytes))).convert("RGBA")
    if variant.size != source.size:
        variant = variant.resize(source.size, Image.Resampling.LANCZOS)

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        out = BytesIO()
        variant.save(out, format="PNG")
        return out.getvalue()

    source_gray = np.array(source.convert("L"))
    variant_gray = np.array(variant.convert("L"))
    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5)

    try:
        cc, warp = cv2.findTransformECC(
            source_gray,
            variant_gray,
            warp,
            cv2.MOTION_TRANSLATION,
            criteria,
        )
    except Exception:
        cc = 0.0

    if cc < 0.2:
        out = BytesIO()
        variant.save(out, format="PNG")
        return out.getvalue()

    dx = float(warp[0, 2])
    dy = float(warp[1, 2])
    max_dx = max(2.0, source.width * 0.02)
    max_dy = max(2.0, source.height * 0.02)
    if abs(dx) > max_dx or abs(dy) > max_dy:
        out = BytesIO()
        variant.save(out, format="PNG")
        return out.getvalue()

    aligned_np = cv2.warpAffine(
        np.array(variant),
        warp,
        (source.width, source.height),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )
    aligned = Image.fromarray(aligned_np, mode="RGBA")
    merged = source.copy()
    merged.alpha_composite(aligned)
    out = BytesIO()
    merged.save(out, format="PNG")
    return out.getvalue()


def _to_openai_alpha_mask(mask_bytes: bytes | None) -> bytes | None:
    if not mask_bytes:
        return None
    # Our paint mask is white=edit, black=preserve. OpenAI expects transparent=edit.
    mask_l = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
    mask_l = mask_l.point(lambda value: 255 if value >= 127 else 0)
    alpha = ImageOps.invert(mask_l)
    rgba = Image.new("RGBA", mask_l.size, (0, 0, 0, 255))
    rgba.putalpha(alpha)
    out = BytesIO()
    rgba.save(out, format="PNG")
    return out.getvalue()


def _build_mask_guided_prompt(user_prompt: str) -> str:
    return (
        "Edit ONLY the masked region.\n"
        "Treat black/unmasked areas as locked and keep them pixel-identical.\n"
        "Do not crop, pan, zoom, or shift framing.\n"
        "Preserve geometry, perspective, lighting, and texture outside the mask.\n"
        "Keep image dimensions unchanged.\n\n"
        f"User edit request: {user_prompt}"
    )


def _handle_full_edit(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    frame_id = payload["frameId"]
    frame = task["frames"][frame_id]
    source_key = payload.get("sourceKey") or frame["captureKey"]
    secrets = load_secret(settings.secrets_arn)
    model_name = payload["model"]
    provider_name = "gemini"

    _job_progress(job, store, 10, "running", "Loading source frame")
    src_bytes = asset_store.read_bytes(source_key)
    src_image = ImageOps.exif_transpose(Image.open(BytesIO(src_bytes))).convert("RGBA")
    if model_name in {"chatgpt", "chatgpt_latest"}:
        openai_key = secrets.get("OPENAI_API_KEY")
        if not openai_key:
            raise RuntimeError("OPENAI_API_KEY is required for ChatGPT image edits")
        provider_name = "openai"
        _job_progress(job, store, 30, "running", "Calling OpenAI edit")
        out_bytes = generate_openai_image_edit(
            api_key=openai_key,
            model=model_name,
            prompt=payload["prompt"],
            input_image_bytes=src_bytes,
        )
    elif _is_luma_uni_full_edit_model(model_name):
        luma_key = _resolve_luma_uni_api_key(secrets)
        if not luma_key:
            raise RuntimeError(
                "Luma Uni requires a Luma Agents key (`luma-api-*`) in LUMA_AGENTS_API_KEY (or LUMA_API_KEY if it is also a luma-api-* key). "
                "Dream Machine keys (`luma-*`) work for video but are not valid for agents.lumalabs.ai."
            )
        provider_name = "luma"
        luma_uni_model, luma_uni_style, luma_uni_output_format = _resolve_luma_uni_options(model_name, payload)
        _job_progress(job, store, 30, "running", "Submitting Luma Uni 1.1 image edit")
        source_url = asset_store.presign_get(source_key, expires=3600)
        created = create_uni_image_edit_generation(
            api_key=luma_key,
            source_url=source_url,
            prompt=payload["prompt"],
            model=luma_uni_model,
            style=luma_uni_style,
            output_format=luma_uni_output_format,
        )
        generation_id = str(created.get("id") or "")
        if not generation_id:
            raise RuntimeError(f"Luma Uni create response missing id: {created}")
        _job_progress(job, store, 55, "running", "Polling Luma Uni 1.1 image edit")
        result = _wait_luma_uni_complete(luma_key, generation_id)
        output_url = _parse_luma_uni_output_url(result)
        with tempfile.TemporaryDirectory() as td:
            temp_path = Path(td) / "luma_uni_output"
            _download_url_to_path(output_url, temp_path, timeout=240)
            out_bytes = temp_path.read_bytes()
    else:
        gemini_key = secrets["GEMINI_API_KEY"]
        _job_progress(job, store, 30, "running", "Calling Gemini edit")
        out_bytes = generate_gemini_image_edit(
            api_key=gemini_key,
            model=model_name,
            prompt=payload["prompt"],
            input_image_bytes=src_bytes,
        )
    normalized_bytes = _normalize_full_variant(source_bytes=src_bytes, variant_bytes=out_bytes)
    normalized_bytes = _align_variant_to_source(source_bytes=src_bytes, variant_bytes=normalized_bytes)
    normalized_image = ImageOps.exif_transpose(Image.open(BytesIO(normalized_bytes))).convert("RGBA")

    paths = _asset_paths(task)
    variant_id, output_key = _allocate_variant_storage(frame, paths, frame_id)
    asset_store.put_bytes(output_key, normalized_bytes, content_type="image/png")

    variant = {
        "variantId": variant_id,
        "type": "full",
        "model": payload["model"],
        "promptHash": prompt_hash(payload["prompt"]),
        "createdAt": now_iso(),
        "jobId": job.get("jobId"),
        "startedAt": job.get("startedAt"),
        "finishedAt": now_iso(),
        "outputKey": output_key,
        "processingDurationSec": _processing_duration_seconds(job.get("startedAt"), now_iso()),
        "generationSettings": {
            "provider": provider_name,
            "workflow": "full",
            "prompt": payload["prompt"],
            "sourceKey": source_key,
            "sourceVariantId": payload.get("sourceVariantId"),
            "inputResolution": {"width": src_image.width, "height": src_image.height},
            "outputResolution": {"width": normalized_image.width, "height": normalized_image.height},
        },
    }
    if _is_luma_uni_full_edit_model(model_name):
        luma_uni_model, luma_uni_style, luma_uni_output_format = _resolve_luma_uni_options(model_name, payload)
        variant["generationSettings"]["lumaUni"] = {
            "model": luma_uni_model,
            "style": luma_uni_style,
            "outputFormat": luma_uni_output_format,
        }
    _record_usage(
        store=store,
        user_id=task["userId"],
        task=task,
        source="task_full_edit",
        tool_origin="full_edit",
        request_type="image_generation",
        provider=provider_name,
        provider_model=(
            str(variant["generationSettings"].get("lumaUni", {}).get("model") or "")
            if isinstance(variant["generationSettings"].get("lumaUni"), dict)
            else None
        )
        or model_name,
        app_model_id=model_name,
        target_record=variant,
        asset_id=variant_id,
        asset_kind="frame_variant",
        width=normalized_image.width,
        height=normalized_image.height,
        operation="full_edit",
    )
    frame.setdefault("variants", []).append(variant)
    if not frame.get("selectedVariantId"):
        frame["selectedVariantId"] = variant_id

    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Full-frame edit completed")
    job["resultRefs"] = {"frameId": frame_id, "variantId": variant_id}
    store.save_job(job)
    return job


def _handle_patch_edit(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    frame_id = payload["frameId"]
    frame = task["frames"][frame_id]

    secrets = load_secret(settings.secrets_arn)

    source_key = payload.get("sourceKey") or frame["captureKey"]
    source_variant_id = payload.get("sourceVariantId")
    source_bytes = asset_store.read_bytes(source_key)
    patch_bytes = asset_store.read_bytes(payload["patchKey"])
    mask_bytes = asset_store.read_bytes(payload["maskKey"]) if payload.get("maskKey") else None
    source_image = ImageOps.exif_transpose(Image.open(BytesIO(source_bytes))).convert("RGBA")
    patch_source_image = ImageOps.exif_transpose(Image.open(BytesIO(patch_bytes))).convert("RGBA")
    patch_rect = _normalize_patch_rect(payload.get("patchRect", {}), source_image.width, source_image.height)
    edge_refine_enabled = bool(payload.get("edgeAwareRefine", False))
    edge_refine_strength = float(payload.get("edgeAwareStrength", 0.45))
    edge_refine_radius_px = int(payload.get("edgeAwareRadiusPx", 6))
    mask_grow_px = int(payload.get("maskGrowPx", 0))
    provider_name = "gemini"
    refined_mask_bytes: bytes | None = None

    model_name = payload["model"]
    model_prompt = _build_mask_guided_prompt(payload["prompt"])
    if model_name in {"runware_flux_fill", "runware_ace_pp"}:
        provider_name = "runware"
        runware_key = secrets["RUNWARE_API_KEY"]
        patch_image = patch_source_image
        if mask_bytes:
            mask_image = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
            if mask_image.size != patch_image.size:
                mask_image = mask_image.resize(patch_image.size, Image.Resampling.BILINEAR)
        else:
            mask_image = Image.new("L", patch_image.size, 255)
        if mask_image.size != patch_image.size:
            mask_image = mask_image.resize(patch_image.size, Image.Resampling.BILINEAR)
        refined_mask_image = _edge_refine_mask(
            mask=mask_image,
            source=patch_image,
            enabled=edge_refine_enabled,
            strength=edge_refine_strength,
            radius_px=edge_refine_radius_px,
            grow_px=mask_grow_px,
        )

        patch_io = BytesIO()
        patch_image.save(patch_io, format="PNG")
        mask_io = BytesIO()
        refined_mask_image.save(mask_io, format="PNG")
        refined_mask_bytes = mask_io.getvalue()

        _job_progress(job, store, 30, "running", "Calling Runware patch edit")
        if model_name == "runware_ace_pp":
            reference_key = payload.get("referenceImageKey")
            if not reference_key:
                raise RuntimeError("Runware ACE++ reference image is required")
            reference_bytes = asset_store.read_bytes(reference_key)
            edited_patch = patch_edit_aceplusplus(
                api_key=runware_key,
                prompt=model_prompt,
                seed_image_bytes=patch_io.getvalue(),
                mask_image_bytes=refined_mask_bytes,
                reference_image_bytes=reference_bytes,
                width=patch_image.width,
                height=patch_image.height,
                repainting_scale=float(payload.get("runwareRepaintingScale", 0.7)),
            )
        else:
            edited_patch = patch_edit_flux_fill(
                api_key=runware_key,
                prompt=model_prompt,
                seed_image_bytes=patch_io.getvalue(),
                mask_image_bytes=refined_mask_bytes,
                width=patch_image.width,
                height=patch_image.height,
            )
    else:
        if mask_bytes:
            mask_image = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
            if mask_image.size != patch_source_image.size:
                mask_image = mask_image.resize(patch_source_image.size, Image.Resampling.BILINEAR)
            refined_mask_image = _edge_refine_mask(
                mask=mask_image,
                source=patch_source_image,
                enabled=edge_refine_enabled,
                strength=edge_refine_strength,
                radius_px=edge_refine_radius_px,
                grow_px=mask_grow_px,
            )
            refined_mask_io = BytesIO()
            refined_mask_image.save(refined_mask_io, format="PNG")
            refined_mask_bytes = refined_mask_io.getvalue()
        if model_name in {"chatgpt", "chatgpt_latest"}:
            openai_key = secrets.get("OPENAI_API_KEY")
            if not openai_key:
                raise RuntimeError("OPENAI_API_KEY is required for ChatGPT patch edits")
            provider_name = "openai"
            openai_mask_bytes = _to_openai_alpha_mask(refined_mask_bytes)
            _job_progress(job, store, 30, "running", "Calling OpenAI patch edit")
            edited_patch = generate_openai_image_edit(
                api_key=openai_key,
                model=model_name,
                prompt=model_prompt,
                input_image_bytes=patch_bytes,
                mask_image_bytes=openai_mask_bytes,
            )
        else:
            gemini_key = secrets["GEMINI_API_KEY"]
            _job_progress(job, store, 30, "running", "Calling Gemini patch edit")
            edited_patch = generate_gemini_image_edit(
                api_key=gemini_key,
                model="nano_banana_pro",
                prompt=model_prompt,
                input_image_bytes=patch_bytes,
                mask_image_bytes=refined_mask_bytes,
            )

    _job_progress(job, store, 70, "running", "Finalizing patch output")
    final_variant_bytes = edited_patch
    final_variant_image = ImageOps.exif_transpose(Image.open(BytesIO(final_variant_bytes))).convert("RGBA")
    if final_variant_image.size != source_image.size:
        final_variant_image = final_variant_image.resize(source_image.size, Image.Resampling.LANCZOS)
        resized = BytesIO()
        final_variant_image.save(resized, format="PNG")
        final_variant_bytes = resized.getvalue()

    paths = _asset_paths(task)
    variant_id, output_key = _allocate_variant_storage(frame, paths, frame_id)
    asset_store.put_bytes(output_key, final_variant_bytes, content_type="image/png")

    generation_settings: dict[str, Any] = {
        "provider": provider_name,
        "workflow": "patch",
        "prompt": payload["prompt"],
        "sourceKey": source_key,
        "sourceVariantId": source_variant_id,
        "inputResolution": {"width": patch_source_image.width, "height": patch_source_image.height},
        "outputResolution": {"width": final_variant_image.width, "height": final_variant_image.height},
        "compositedResolution": {"width": final_variant_image.width, "height": final_variant_image.height},
        "featherPx": int(payload["featherPx"]),
        "bleedPx": int(payload["bleedPx"]),
        "hasMask": bool(payload.get("maskKey")),
        "edgeAwareRefine": edge_refine_enabled,
        "edgeAwareStrength": edge_refine_strength,
        "edgeAwareRadiusPx": edge_refine_radius_px,
        "maskGrowPx": mask_grow_px,
    }
    if model_name == "runware_ace_pp":
        generation_settings["runwareRepaintingScale"] = float(payload.get("runwareRepaintingScale", 0.7))
    if payload.get("referenceImageKey"):
        generation_settings["referenceImageKey"] = payload["referenceImageKey"]

    variant = {
        "variantId": variant_id,
        "type": "patch",
        "model": payload["model"],
        "promptHash": prompt_hash(payload["prompt"]),
        "createdAt": now_iso(),
        "jobId": job.get("jobId"),
        "startedAt": job.get("startedAt"),
        "finishedAt": now_iso(),
        "outputKey": output_key,
        "processingDurationSec": _processing_duration_seconds(job.get("startedAt"), now_iso()),
        "generationSettings": generation_settings,
        "patchMeta": {
            "patchRect": patch_rect,
            "featherPx": payload["featherPx"],
            "bleedPx": payload["bleedPx"],
            "maskKey": payload.get("maskKey"),
            "patchOnlyKey": output_key,
            "referenceImageKey": payload.get("referenceImageKey"),
            "edgeAwareRefine": edge_refine_enabled,
            "edgeAwareStrength": edge_refine_strength,
            "edgeAwareRadiusPx": edge_refine_radius_px,
            "maskGrowPx": mask_grow_px,
        },
    }
    _record_usage(
        store=store,
        user_id=task["userId"],
        task=task,
        source="task_patch_edit",
        tool_origin="patch_edit",
        request_type="image_generation",
        provider=provider_name,
        provider_model=model_name,
        app_model_id=model_name,
        target_record=variant,
        asset_id=variant_id,
        asset_kind="frame_variant",
        width=source_image.width,
        height=source_image.height,
        operation="patch_edit",
        reference_count=1 if payload.get("referenceImageKey") else 0,
    )
    frame.setdefault("variants", []).append(variant)
    if not frame.get("selectedVariantId"):
        frame["selectedVariantId"] = variant_id

    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Patch edit completed")
    job["resultRefs"] = {"frameId": frame_id, "variantId": variant_id}
    store.save_job(job)
    return job


def _handle_api_image_edit_full(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    request_id = str(payload["requestId"])
    request_record = _load_api_request(store, job["userId"], request_id)
    request_record["startedAt"] = request_record.get("startedAt") or now_iso()
    paths = _api_asset_paths(job["userId"])

    _api_request_progress(job=job, store=store, request_record=request_record, progress=10, status="running", logs="Loading input image")
    src_bytes = asset_store.read_bytes(str(payload["inputAssetKey"]))
    reference_asset_keys = [str(item or "").strip() for item in payload.get("referenceAssetKeys") or [] if str(item or "").strip()]
    reference_images: list[tuple[bytes, str]] = []
    if reference_asset_keys:
        _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Loading ordered reference images")
        for reference_asset_key in reference_asset_keys:
            reference_bytes = asset_store.read_bytes(reference_asset_key)
            with Image.open(BytesIO(reference_bytes)) as reference_probe:
                mime_type = Image.MIME.get(reference_probe.format or "", "image/png")
            reference_images.append((reference_bytes, mime_type))
    src_image = ImageOps.exif_transpose(Image.open(BytesIO(src_bytes))).convert("RGBA")
    secrets = load_secret(settings.secrets_arn)
    model_name = str(payload["model"])
    provider_name = "gemini"

    if model_name in {"chatgpt", "chatgpt_latest"}:
        openai_key = secrets.get("OPENAI_API_KEY")
        if not openai_key:
            raise RuntimeError("OPENAI_API_KEY is required for ChatGPT image edits")
        provider_name = "openai"
        _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling OpenAI image edit")
        out_bytes = generate_openai_image_edit(
            api_key=openai_key,
            model=model_name,
            prompt=str(payload["prompt"]),
            input_image_bytes=src_bytes,
            reference_images=reference_images,
        )
    elif _is_luma_uni_full_edit_model(model_name):
        if reference_images:
            raise RuntimeError("Luma Uni full image edit does not support additional ordered reference images in this API route")
        luma_key = _resolve_luma_uni_api_key(secrets)
        if not luma_key:
            raise RuntimeError(
                "Luma Uni requires a Luma Agents key (`luma-api-*`) in LUMA_AGENTS_API_KEY (or LUMA_API_KEY if it is also a luma-api-* key). "
                "Dream Machine keys (`luma-*`) work for video but are not valid for agents.lumalabs.ai."
            )
        provider_name = "luma"
        luma_uni_model, luma_uni_style, luma_uni_output_format = _resolve_luma_uni_options(model_name, payload)
        _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Submitting Luma Uni 1.1 image edit")
        source_url = asset_store.presign_get(str(payload["inputAssetKey"]), expires=3600)
        created = create_uni_image_edit_generation(
            api_key=luma_key,
            source_url=source_url,
            prompt=str(payload["prompt"]),
            model=luma_uni_model,
            style=luma_uni_style,
            output_format=luma_uni_output_format,
        )
        generation_id = str(created.get("id") or "")
        if not generation_id:
            raise RuntimeError(f"Luma Uni create response missing id: {created}")
        _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Luma Uni 1.1 image edit")
        result = _wait_luma_uni_complete(luma_key, generation_id)
        output_url = _parse_luma_uni_output_url(result)
        with tempfile.TemporaryDirectory() as td:
            temp_path = Path(td) / "luma_uni_output"
            _download_url_to_path(output_url, temp_path, timeout=240)
            out_bytes = temp_path.read_bytes()
    else:
        gemini_key = secrets["GEMINI_API_KEY"]
        _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling Gemini image edit")
        out_bytes = generate_gemini_image_edit(
            api_key=gemini_key,
            model=model_name,
            prompt=str(payload["prompt"]),
            input_image_bytes=src_bytes,
            reference_images=reference_images,
        )

    normalized_bytes = _normalize_full_variant(source_bytes=src_bytes, variant_bytes=out_bytes)
    normalized_bytes = _align_variant_to_source(source_bytes=src_bytes, variant_bytes=normalized_bytes)
    normalized_image = ImageOps.exif_transpose(Image.open(BytesIO(normalized_bytes))).convert("RGBA")
    output_key = paths.request_artifact(request_id, "output", "result", ".png")
    asset_store.put_bytes(output_key, normalized_bytes, content_type="image/png")

    finished_at = now_iso()
    request_record["finishedAt"] = finished_at
    request_record["processingDurationSec"] = _processing_duration_seconds(request_record.get("startedAt"), finished_at)
    request_record["provider"] = provider_name
    request_record["status"] = "complete"
    request_record["outputAssets"] = {
        "output": {
            "key": output_key,
            "contentType": "image/png",
            "width": normalized_image.width,
            "height": normalized_image.height,
        }
    }
    request_record["normalization"] = {
        "inputResolution": {"width": src_image.width, "height": src_image.height},
        "outputResolution": {"width": normalized_image.width, "height": normalized_image.height},
        "outputAlignedToInput": True,
    }
    if _is_luma_uni_full_edit_model(model_name):
        luma_uni_model, luma_uni_style, luma_uni_output_format = _resolve_luma_uni_options(model_name, payload)
        request_record.setdefault("request", {})["lumaUniModel"] = luma_uni_model
        request_record.setdefault("request", {})["lumaUniStyle"] = luma_uni_style
        request_record.setdefault("request", {})["lumaUniOutputFormat"] = luma_uni_output_format
    _record_usage(
        store=store,
        user_id=job["userId"],
        source="external_api_image_edit_full",
        tool_origin="external_api_image_edit_full",
        request_type="image_generation",
        provider=provider_name,
        provider_model=(
            str(request_record.get("request", {}).get("lumaUniModel") or "")
            if isinstance(request_record.get("request"), dict)
            else None
        )
        or model_name,
        app_model_id=model_name,
        target_record=request_record,
        request_id=request_id,
        asset_id=request_id,
        asset_kind="api_request",
        width=normalized_image.width,
        height=normalized_image.height,
        operation="full_edit",
        reference_count=len(reference_asset_keys),
    )
    request_record["error"] = None
    _save_api_request(store, request_record)
    _job_progress(job, store, 100, "complete", "API full image edit completed")
    job["resultRefs"] = {"requestId": request_id, "outputKey": output_key}
    store.save_job(job)
    return job


def _handle_api_image_edit_patch(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    request_id = str(payload["requestId"])
    request_record = _load_api_request(store, job["userId"], request_id)
    request_record["startedAt"] = request_record.get("startedAt") or now_iso()
    paths = _api_asset_paths(job["userId"])
    secrets = load_secret(settings.secrets_arn)

    _api_request_progress(job=job, store=store, request_record=request_record, progress=10, status="running", logs="Loading patch edit assets")
    source_bytes = asset_store.read_bytes(str(payload["inputAssetKey"]))
    patch_bytes = asset_store.read_bytes(str(payload["patchAssetKey"]))
    mask_bytes = asset_store.read_bytes(str(payload["maskAssetKey"])) if payload.get("maskAssetKey") else None
    raw_reference_asset_keys = payload.get("referenceAssetKeys") or []
    reference_asset_keys = [str(item or "").strip() for item in raw_reference_asset_keys if str(item or "").strip()]
    reference_images: list[tuple[bytes, str]] = []
    if reference_asset_keys:
        _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Loading ordered reference images")
        for reference_asset_key in reference_asset_keys:
            reference_bytes = asset_store.read_bytes(reference_asset_key)
            with Image.open(BytesIO(reference_bytes)) as reference_probe:
                mime_type = Image.MIME.get(reference_probe.format or "", "image/png")
            reference_images.append((reference_bytes, mime_type))

    source_image = ImageOps.exif_transpose(Image.open(BytesIO(source_bytes))).convert("RGBA")
    patch_source_image = ImageOps.exif_transpose(Image.open(BytesIO(patch_bytes))).convert("RGBA")
    patch_rect = _normalize_patch_rect(payload.get("patchRect", {}), source_image.width, source_image.height)
    edge_refine_enabled = bool(payload.get("edgeAwareRefine", False))
    edge_refine_strength = float(payload.get("edgeAwareStrength", 0.45))
    edge_refine_radius_px = int(payload.get("edgeAwareRadiusPx", 6))
    mask_grow_px = int(payload.get("maskGrowPx", 0))
    model_name = str(payload["model"])
    provider_name = "gemini"
    model_prompt = _build_mask_guided_prompt(str(payload["prompt"]))
    refined_mask_bytes: bytes | None = None

    if model_name in {"runware_flux_fill", "runware_ace_pp"}:
        provider_name = "runware"
        runware_key = secrets["RUNWARE_API_KEY"]
        if mask_bytes:
            mask_image = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
            if mask_image.size != patch_source_image.size:
                mask_image = mask_image.resize(patch_source_image.size, Image.Resampling.BILINEAR)
        else:
            mask_image = Image.new("L", patch_source_image.size, 255)
        refined_mask_image = _edge_refine_mask(
            mask=mask_image,
            source=patch_source_image,
            enabled=edge_refine_enabled,
            strength=edge_refine_strength,
            radius_px=edge_refine_radius_px,
            grow_px=mask_grow_px,
        )
        mask_io = BytesIO()
        refined_mask_image.save(mask_io, format="PNG")
        refined_mask_bytes = mask_io.getvalue()
        if model_name == "runware_ace_pp":
            if not reference_images:
                raise RuntimeError("Runware ACE++ reference image is required")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling Runware ACE++ patch edit")
            edited_patch = patch_edit_aceplusplus(
                api_key=runware_key,
                prompt=model_prompt,
                seed_image_bytes=patch_bytes,
                mask_image_bytes=refined_mask_bytes,
                reference_image_bytes=reference_images[0][0],
                width=patch_source_image.width,
                height=patch_source_image.height,
                repainting_scale=float(payload.get("runwareRepaintingScale", 0.7)),
            )
        else:
            _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling Runware patch edit")
            edited_patch = patch_edit_flux_fill(
                api_key=runware_key,
                prompt=model_prompt,
                seed_image_bytes=patch_bytes,
                mask_image_bytes=refined_mask_bytes,
                width=patch_source_image.width,
                height=patch_source_image.height,
            )
    else:
        if mask_bytes:
            mask_image = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
            if mask_image.size != patch_source_image.size:
                mask_image = mask_image.resize(patch_source_image.size, Image.Resampling.BILINEAR)
            refined_mask_image = _edge_refine_mask(
                mask=mask_image,
                source=patch_source_image,
                enabled=edge_refine_enabled,
                strength=edge_refine_strength,
                radius_px=edge_refine_radius_px,
                grow_px=mask_grow_px,
            )
            refined_mask_io = BytesIO()
            refined_mask_image.save(refined_mask_io, format="PNG")
            refined_mask_bytes = refined_mask_io.getvalue()
        if model_name in {"chatgpt", "chatgpt_latest"}:
            openai_key = secrets.get("OPENAI_API_KEY")
            if not openai_key:
                raise RuntimeError("OPENAI_API_KEY is required for ChatGPT patch edits")
            provider_name = "openai"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling OpenAI patch edit")
            edited_patch = generate_openai_image_edit(
                api_key=openai_key,
                model=model_name,
                prompt=model_prompt,
                input_image_bytes=patch_bytes,
                mask_image_bytes=_to_openai_alpha_mask(refined_mask_bytes),
                reference_images=reference_images,
            )
        else:
            gemini_key = secrets["GEMINI_API_KEY"]
            _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling Gemini patch edit")
            edited_patch = generate_gemini_image_edit(
                api_key=gemini_key,
                model="nano_banana_pro",
                prompt=model_prompt,
                input_image_bytes=patch_bytes,
                mask_image_bytes=refined_mask_bytes,
                reference_images=reference_images,
            )

    final_variant_bytes = edited_patch
    final_variant_image = ImageOps.exif_transpose(Image.open(BytesIO(final_variant_bytes))).convert("RGBA")
    if final_variant_image.size != source_image.size:
        final_variant_image = final_variant_image.resize(source_image.size, Image.Resampling.LANCZOS)
        resized = BytesIO()
        final_variant_image.save(resized, format="PNG")
        final_variant_bytes = resized.getvalue()

    output_key = paths.request_artifact(request_id, "output", "result", ".png")
    asset_store.put_bytes(output_key, final_variant_bytes, content_type="image/png")
    if refined_mask_bytes:
        refined_mask_key = paths.request_artifact(request_id, "prepared", "refined_mask", ".png")
        asset_store.put_bytes(refined_mask_key, refined_mask_bytes, content_type="image/png")
        request_record["preparedAssets"] = {
            "refinedMask": {
                "key": refined_mask_key,
                "contentType": "image/png",
            }
        }

    finished_at = now_iso()
    request_record["finishedAt"] = finished_at
    request_record["processingDurationSec"] = _processing_duration_seconds(request_record.get("startedAt"), finished_at)
    request_record["provider"] = provider_name
    request_record["status"] = "complete"
    request_record["outputAssets"] = {
        "output": {
            "key": output_key,
            "contentType": "image/png",
            "width": final_variant_image.width,
            "height": final_variant_image.height,
        }
    }
    request_record["normalization"] = {
        "inputResolution": {"width": source_image.width, "height": source_image.height},
        "patchResolution": {"width": patch_source_image.width, "height": patch_source_image.height},
        "outputResolution": {"width": final_variant_image.width, "height": final_variant_image.height},
        "patchRect": patch_rect,
        "edgeAwareRefine": edge_refine_enabled,
        "edgeAwareStrength": edge_refine_strength,
        "edgeAwareRadiusPx": edge_refine_radius_px,
        "maskGrowPx": mask_grow_px,
    }
    _record_usage(
        store=store,
        user_id=job["userId"],
        source="external_api_image_edit_patch",
        tool_origin="external_api_image_edit_patch",
        request_type="image_generation",
        provider=provider_name,
        provider_model=model_name,
        app_model_id=model_name,
        target_record=request_record,
        request_id=request_id,
        asset_id=request_id,
        asset_kind="api_request",
        width=final_variant_image.width,
        height=final_variant_image.height,
        operation="patch_edit",
        reference_count=len(reference_asset_keys),
    )
    request_record["error"] = None
    _save_api_request(store, request_record)
    _job_progress(job, store, 100, "complete", "API patch image edit completed")
    job["resultRefs"] = {"requestId": request_id, "outputKey": output_key}
    store.save_job(job)
    return job


def _handle_api_video_generate_reference(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    request_id = str(payload["requestId"])
    request_record = _load_api_request(store, job["userId"], request_id)
    request_record["startedAt"] = request_record.get("startedAt") or now_iso()
    paths = _api_asset_paths(job["userId"])
    secrets = load_secret(settings.secrets_arn)
    model_name = str(payload["model"])
    capability = get_video_model_capability(model_name)
    requested_mode = str(payload["mode"])
    luma_mode = requested_mode if requested_mode in LUMA_API_ALLOWED_MODES else "flex_1"
    uses_end_keyframe = requested_mode in {"kling_start_end", "veo_start_end", "wan27_i2v_start_end", "ltx23_i2v_start_end"}
    replicate_kling_mode = str(payload.get("replicateKlingMode") or "pro")
    replicate_kling_v3_mode = str(payload.get("replicateKlingV3Mode") or "pro")
    wan27_resolution = str(payload.get("wan27Resolution") or "720p")
    happy_horse_resolution = str(payload.get("happyHorseResolution") or "1080p")
    wan27_negative_prompt = str(payload.get("negativePrompt") or "").strip() or None
    preserve_frames = bool(payload.get("preserveFrames", True))
    provider_name = capability.provider
    reference_asset_keys = [str(item or "").strip() for item in payload.get("referenceAssetKeys") or [] if str(item or "").strip()]

    _api_request_progress(job=job, store=store, request_record=request_record, progress=10, status="running", logs="Loading video generation assets")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        first_frame_bytes = asset_store.read_bytes(str(payload["firstFrameAssetKey"]))
        last_frame_bytes = asset_store.read_bytes(str(payload["lastFrameAssetKey"])) if payload.get("lastFrameAssetKey") else None
        with Image.open(BytesIO(first_frame_bytes)) as first_image_probe:
            first_source_width, first_source_height = first_image_probe.size

        source_video_key = payload.get("videoAssetKey")
        source_video_path: Path | None = None
        source_probe: dict[str, Any] | None = None
        if source_video_key:
            source_video_path = td_path / "source_video.mp4"
            _download_s3(boto3.client("s3"), settings.assets_bucket, str(source_video_key), source_video_path)
            source_probe = ffprobe_video(str(source_video_path))
            segment_duration_sec = float(source_probe.get("duration_sec") or 0.0)
            fps = Fraction(int(source_probe.get("fps_num") or 30), int(source_probe.get("fps_den") or 1))
            if fps.numerator <= 0 or fps.denominator <= 0:
                fps = Fraction(30, 1)
            src_width = int(source_probe.get("width") or first_source_width or 1920)
            src_height = int(source_probe.get("height") or first_source_height or 1080)
            provider_media_has_audio = bool(source_probe.get("has_audio"))
            source_size = source_video_path.stat().st_size
        else:
            requested_duration_sec = float(payload.get("durationSeconds") or capability.min_seconds or capability.max_seconds or 4)
            segment_duration_sec = max(float(capability.min_seconds or 1), min(float(capability.max_seconds or 10), requested_duration_sec))
            fps_value = capability.frame_budget_fps or 24
            fps = Fraction(fps_value, 1)
            src_width = first_source_width or 1920
            src_height = first_source_height or 1080
            provider_media_has_audio = False
            source_size = 0
            source_probe = {
                "width": src_width,
                "height": src_height,
                "fps_num": fps.numerator,
                "fps_den": fps.denominator,
                "duration_sec": segment_duration_sec,
                "frame_count": max(1, int(round(segment_duration_sec * float(fps)))),
                "is_vfr_input": False,
                "has_audio": False,
            }

        duration_frames = max(1, int(round(segment_duration_sec * float(fps))))
        limit_error = resolve_video_model_limit_error(
            model=model_name,
            duration_seconds=segment_duration_sec,
            duration_frames=duration_frames,
            source_fps=fps,
            source_label="source video" if source_video_key else "requested duration",
            selected_label="Input video" if source_video_key else "Requested duration",
        )
        if limit_error:
            raise RuntimeError(limit_error)

        media_key_for_provider: str | None = None
        first_frame_input_key: str | None = None
        last_frame_input_key: str | None = None
        first_frame_content_type: str | None = None
        last_frame_content_type: str | None = None
        provider_media_width: int | None = None
        provider_media_height: int | None = None
        provider_media_fps: Fraction | None = None
        provider_input_timing_policy = "source_fps"
        provider_input_duration_sec = round(segment_duration_sec, 3)
        local_provider_segment: Path | None = None
        wan27_video_transport: str | None = None
        wan27_reference_transport: str | None = None
        ltx23_reference_transport: str | None = None
        wan27_video_data_url: str | None = None
        sora2_resolution = str(payload.get("sora2Resolution") or "auto")
        sora2_requested_duration_sec: float | None = None
        sora2_provider_duration_sec: float | None = None
        replicate_aspect_ratio: str | None = None
        seedance_aspect_ratio: str | None = None
        wan27_aspect_ratio: str | None = None
        ltx23_aspect_ratio: str | None = None
        seedance_requested_duration_sec: float | None = None
        ltx23_requested_duration_sec: float | None = None
        ltx23_requested_fps: int | None = None
        seedance_raw_output_width: int | None = None
        seedance_raw_output_height: int | None = None
        seedance_output_width: int | None = None
        seedance_output_height: int | None = None

        if capability.source_video_profile == "kling_edit":
            replicate_aspect_ratio = _nearest_allowed_aspect_ratio(
                src_width,
                src_height,
                allowed=("16:9", "9:16", "1:1", "4:3", "3:4") if model_name == "kling-v3-omni-video" else ("16:9", "9:16", "1:1"),
            )
            kling_mode = replicate_kling_v3_mode if model_name == "kling-v3-omni-video" else replicate_kling_mode
            kling_long_edge = 1920 if kling_mode == "pro" else 1280
            kling_square_edge = 1080 if kling_mode == "pro" else 720
            target_w, target_h = _dimensions_for_aspect_ratio(
                replicate_aspect_ratio,
                long_edge=kling_long_edge,
                square_edge=kling_square_edge,
            )
            local_provider_segment = td_path / "provider_segment.mp4"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Preparing segment clip for Kling")
            provider_media_width, provider_media_height, _ = _transcode_exact_with_size_limit(
                input_path=str(source_video_path),
                output_path=str(local_provider_segment),
                fps=fps,
                source_fps=fps,
                preserve_frame_count=False,
                target_width=target_w,
                target_height=target_h,
                resize_mode="crop",
                max_bytes=REPLICATE_VIDEO_MAX_BYTES,
            )
            provider_media_fps = fps
            provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or segment_duration_sec), 3)
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        elif capability.source_video_profile == "seedance_reference":
            seedance_aspect_ratio = _nearest_allowed_aspect_ratio(
                src_width,
                src_height,
                allowed=("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"),
            )
            target_w, target_h = _dimensions_for_aspect_ratio_within_box(
                seedance_aspect_ratio,
                landscape_box=(1112, 834),
                portrait_box=(834, 1112),
                square_edge=834,
            )
            local_provider_segment = td_path / "provider_segment_seedance.mp4"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Preparing segment clip for Seedance 2.0")
            provider_media_width, provider_media_height, _ = _transcode_exact_with_size_limit(
                input_path=str(source_video_path),
                output_path=str(local_provider_segment),
                fps=fps,
                source_fps=fps,
                preserve_frame_count=False,
                target_width=target_w,
                target_height=target_h,
                resize_mode="crop",
                max_bytes=SEEDANCE_REFERENCE_VIDEO_MAX_BYTES,
            )
            provider_media_fps = fps
            provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or segment_duration_sec), 3)
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        elif capability.source_video_profile == "wan27_edit":
            wan_edge = 1080 if wan27_resolution == "1080p" else 720
            wan27_aspect_ratio = _nearest_allowed_aspect_ratio(
                src_width,
                src_height,
                allowed=("16:9", "9:16", "1:1", "4:3", "3:4"),
            )
            target_w, target_h = _dimensions_for_aspect_ratio(
                wan27_aspect_ratio,
                long_edge=1920 if wan27_resolution == "1080p" else 1280,
                square_edge=wan_edge,
            )
            wan_provider_fps, provider_input_timing_policy = _resolved_provider_fps(
                model_name=model_name,
                source_fps=fps,
                preserve_frames=preserve_frames,
            )
            local_provider_segment = td_path / "provider_segment_wan27.mp4"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Preparing segment clip for Wan 2.7 VideoEdit")
            wan27_video_data_url, _ = _prepare_replicate_video_data_url(
                input_path=str(source_video_path),
                output_path=str(local_provider_segment),
                fps=wan_provider_fps,
                source_fps=fps,
                preserve_frame_count=preserve_frames,
                target_width=target_w,
                target_height=target_h,
                resize_mode="crop",
                max_bytes=WAN27_DATA_URL_MAX_BYTES,
            )
            provider_media_width = target_w
            provider_media_height = target_h
            provider_media_fps = wan_provider_fps
            provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or segment_duration_sec), 3)
            wan27_video_transport = "data_url"
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        elif source_size > FULL_VIDEO_MAX_BYTES:
            local_provider_segment = td_path / "provider_segment_luma.mp4"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Optimizing source video to provider size limits")
            provider_media_width, provider_media_height, _ = _transcode_with_size_limit(
                input_path=str(source_video_path),
                output_path=str(local_provider_segment),
                fps=fps,
                source_width=src_width,
                source_height=src_height,
                landscape_target=(1920, 1080),
                portrait_target=(1080, 1920),
                resize_mode="scale",
                max_bytes=FULL_VIDEO_MAX_BYTES,
            )
            provider_media_fps = fps
            provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or segment_duration_sec), 3)
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        else:
            if source_video_key:
                media_key_for_provider = str(source_video_key)
                provider_media_width = src_width
                provider_media_height = src_height
                provider_media_fps = fps
                provider_input_duration_sec = round(segment_duration_sec, 3)

        first_frame_fit_mode = "contain"
        if capability.first_frame_profile == "runware_wan22":
            first_target_w, first_target_h = _nearest_runware_wan22_resolution(first_source_width, first_source_height)
        elif capability.first_frame_profile == "sora_i2v":
            sora_edge = 1920 if sora2_resolution == "1080p" else 1280
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(sora_edge, int(round(sora_edge * 9 / 16))),
                portrait=(int(round(sora_edge * 9 / 16)), sora_edge),
            )
        elif capability.first_frame_profile == "happy_horse_reference":
            happy_horse_long_edge = 1920 if happy_horse_resolution == "1080p" else 1280
            first_target_w, first_target_h = _target_preserving_aspect_long_edge(
                first_source_width,
                first_source_height,
                long_edge=happy_horse_long_edge,
            )
        elif capability.first_frame_profile == "kling_edit":
            first_frame_fit_mode = "cover"
            if not replicate_aspect_ratio:
                replicate_aspect_ratio = _nearest_allowed_aspect_ratio(
                    first_source_width,
                    first_source_height,
                    allowed=("16:9", "9:16", "1:1", "4:3", "3:4") if model_name == "kling-v3-omni-video" else ("16:9", "9:16", "1:1"),
                )
            kling_mode = replicate_kling_v3_mode if model_name == "kling-v3-omni-video" else replicate_kling_mode
            kling_long_edge = 1920 if kling_mode == "pro" else 1280
            kling_square_edge = 1080 if kling_mode == "pro" else 720
            first_target_w, first_target_h = _dimensions_for_aspect_ratio(
                replicate_aspect_ratio,
                long_edge=kling_long_edge,
                square_edge=kling_square_edge,
            )
        elif capability.first_frame_profile == "wan27_edit":
            first_frame_fit_mode = "cover"
            wan_edge = 1080 if wan27_resolution == "1080p" else 720
            if not wan27_aspect_ratio:
                wan27_aspect_ratio = _nearest_allowed_aspect_ratio(
                    first_source_width,
                    first_source_height,
                    allowed=("16:9", "9:16", "1:1", "4:3", "3:4"),
                )
            first_target_w, first_target_h = _dimensions_for_aspect_ratio(
                wan27_aspect_ratio,
                long_edge=1920 if wan27_resolution == "1080p" else 1280,
                square_edge=wan_edge,
            )
        elif capability.first_frame_profile == "seedance_reference":
            first_frame_fit_mode = "cover"
            if not seedance_aspect_ratio:
                seedance_aspect_ratio = _nearest_allowed_aspect_ratio(
                    first_source_width,
                    first_source_height,
                    allowed=("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"),
                )
            first_target_w, first_target_h = _dimensions_for_aspect_ratio_within_box(
                seedance_aspect_ratio,
                landscape_box=(1112, 834),
                portrait_box=(834, 1112),
                square_edge=834,
            )
        elif capability.first_frame_profile == "runway_aleph":
            first_target_w, first_target_h = _nearest_runway_aleph_resolution(first_source_width, first_source_height)
        elif capability.first_frame_profile == "runway_standard_720":
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1280, 720),
                portrait=(720, 1280),
            )
        elif capability.first_frame_profile == "ltx23_i2v":
            ltx23_aspect_ratio = _nearest_allowed_aspect_ratio(
                first_source_width,
                first_source_height,
                allowed=("16:9", "9:16"),
            )
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1920, 1080),
                portrait=(1080, 1920),
            )
        else:
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1920, 1080),
                portrait=(1080, 1920),
            )

        prepared_first_frame, first_frame_content_type, first_frame_ext = _prepare_first_frame_image_payload(
            first_frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            max_bytes=MAX_PROVIDER_IMAGE_BYTES,
            fit_mode=first_frame_fit_mode,
        )
        first_frame_input_key = paths.request_artifact(request_id, "prepared", "first_frame", first_frame_ext)
        asset_store.put_bytes(first_frame_input_key, prepared_first_frame, content_type=first_frame_content_type)

        if uses_end_keyframe:
            end_source_bytes = last_frame_bytes or first_frame_bytes
            prepared_last_frame, last_frame_content_type, last_frame_ext = _prepare_first_frame_image_payload(
                end_source_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                max_bytes=MAX_PROVIDER_IMAGE_BYTES,
                fit_mode=first_frame_fit_mode,
            )
            last_frame_input_key = paths.request_artifact(request_id, "prepared", "last_frame", last_frame_ext)
            asset_store.put_bytes(last_frame_input_key, prepared_last_frame, content_type=last_frame_content_type)

        selected_reference_urls: list[str] = []
        prepared_reference_assets: list[dict[str, Any]] = []
        if reference_asset_keys:
            _api_request_progress(job=job, store=store, request_record=request_record, progress=30, status="running", logs="Preparing ordered reference images")
            for index, reference_asset_key in enumerate(reference_asset_keys, start=1):
                reference_bytes = asset_store.read_bytes(reference_asset_key)
                prepared_reference_bytes, reference_content_type, reference_ext = _prepare_first_frame_image_payload(
                    reference_bytes,
                    target_width=first_target_w,
                    target_height=first_target_h,
                    max_bytes=MAX_PROVIDER_IMAGE_BYTES,
                    fit_mode=first_frame_fit_mode,
                )
                prepared_reference_key = paths.request_artifact(request_id, "prepared", f"reference_{index}", reference_ext)
                asset_store.put_bytes(prepared_reference_key, prepared_reference_bytes, content_type=reference_content_type)
                selected_reference_urls.append(asset_store.presign_get(prepared_reference_key, expires=3600))
                prepared_reference_assets.append(
                    {
                        "key": prepared_reference_key,
                        "contentType": reference_content_type,
                    }
                )
        if prepared_reference_assets:
            request_record.setdefault("preparedAssets", {})["referenceImages"] = prepared_reference_assets
            request_record.setdefault("request", {})["referenceAssetKeys"] = reference_asset_keys
            _save_api_request(store, request_record)

        media_url = asset_store.presign_get(media_key_for_provider, expires=3600) if media_key_for_provider else None
        first_frame_url = asset_store.presign_get(first_frame_input_key, expires=3600)
        last_frame_url = asset_store.presign_get(last_frame_input_key, expires=3600) if last_frame_input_key else None

        used_provider_model: str | None = None
        provider_duration_sec: float | None = None
        if model_name == "runway-gen4.5":
            runway_key = secrets["RUNWAY_API_KEY"]
            runway_duration = 5 if segment_duration_sec <= 7.5 else 10
            provider_duration_sec = float(runway_duration)
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Runway Gen-4.5 generation")
            created = create_image_to_video(
                api_key=runway_key,
                prompt_image_uri=first_frame_url,
                prompt_text=str(payload.get("prompt") or "Generate motion that preserves the first frame composition."),
                ratio=f"{first_target_w}:{first_target_h}",
                duration=runway_duration,
                model="gen4.5",
            )
            generation_id = created.get("id")
            if not generation_id:
                raise RuntimeError(f"Unexpected Runway create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Runway generation")
            result = _wait_runway_complete(runway_key, generation_id)
            out_url = _parse_runway_output_url(result)
            used_provider_model = "gen4.5"
        elif model_name == "runway-gen4-aleph":
            runway_key = secrets["RUNWAY_API_KEY"]
            provider_duration_sec = round(provider_input_duration_sec or segment_duration_sec, 3)
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Runway Aleph 2.0 video-to-video generation")
            runway_video_uri = _upload_runway_ephemeral_asset(
                api_key=runway_key,
                file_path=local_provider_segment or source_video_path,
                content_type="video/mp4",
            )
            runway_first_frame_uri = _upload_runway_ephemeral_asset(
                api_key=runway_key,
                file_path=td_path / f"first_frame{first_frame_ext}",
                content_type=first_frame_content_type,
            )
            created = create_video_to_video(
                api_key=runway_key,
                video_uri=runway_video_uri,
                prompt_text=str(payload.get("prompt") or "Modify the source video while preserving timing, camera movement, and overall motion continuity."),
                first_frame_uri=runway_first_frame_uri,
                model="aleph2",
            )
            generation_id = created.get("id")
            if not generation_id:
                raise RuntimeError(f"Unexpected Runway create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Runway Aleph 2.0 generation")
            result = _wait_runway_complete(runway_key, generation_id)
            out_url = _parse_runway_output_url(result)
            used_provider_model = "aleph2"
        elif model_name == "kling-2.6":
            kling_key = secrets.get("RUNWARE_API_KEY") or secrets.get("KLING_API_KEY")
            if not kling_key:
                raise RuntimeError("Kling generation requires RUNWARE_API_KEY (or legacy KLING_API_KEY)")
            kling_duration = _nearest_supported_kling_duration(segment_duration_sec)
            provider_duration_sec = float(kling_duration)
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Kling 2.6 generation")
            created = create_kling_start_end_generation(
                api_key=kling_key,
                start_image_url=first_frame_url,
                end_image_url=(last_frame_url if uses_end_keyframe else None) or first_frame_url,
                duration_seconds=kling_duration,
                prompt=payload.get("prompt"),
            )
            generation_id = created.get("taskUUID")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Kling create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Kling generation")
            result = _wait_kling_complete(kling_key, task_uuid=generation_id)
            out_url = _parse_runware_video_output_url(result)
            used_provider_model = "kling-video@2.6-pro"
        elif model_name in {"veo-3.1", "veo-3.1-fast"}:
            runware_key = secrets.get("RUNWARE_API_KEY")
            if not runware_key:
                raise RuntimeError("Veo 3.1 generation requires RUNWARE_API_KEY")
            provider_duration_sec = 8.0
            runware_model = RUNWARE_VEO_31_MODEL if model_name == "veo-3.1" else RUNWARE_VEO_31_FAST_MODEL
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs=f"Creating {model_name} generation")
            created = create_veo_first_last_generation(
                api_key=runware_key,
                model=runware_model,
                start_image_url=first_frame_url,
                end_image_url=(last_frame_url if uses_end_keyframe else None) or first_frame_url,
                duration_seconds=8,
                prompt=payload.get("prompt"),
                width=first_target_w,
                height=first_target_h,
                generate_audio=False,
            )
            generation_id = created.get("taskUUID")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Runware Veo create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Runware Veo generation")
            result = _wait_runware_video_complete(runware_key, task_uuid=generation_id)
            out_url = _parse_runware_video_output_url(result)
            used_provider_model = runware_model
        elif model_name == "wan2.2-a14b":
            runware_key = secrets.get("RUNWARE_API_KEY")
            if not runware_key:
                raise RuntimeError("Wan2.2 generation requires RUNWARE_API_KEY")
            provider_duration_sec = 5.0
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Wan2.2 A14B generation")
            created = create_wan22_a14b_generation(
                api_key=runware_key,
                start_image_url=first_frame_url,
                duration_seconds=5,
                prompt=payload.get("prompt"),
                width=first_target_w,
                height=first_target_h,
            )
            generation_id = created.get("taskUUID")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Runware Wan2.2 A14B create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Wan2.2 A14B generation")
            result = _wait_runware_video_complete(runware_key, task_uuid=generation_id)
            out_url = _parse_runware_video_output_url(result)
            used_provider_model = RUNWARE_WAN22_A14B_MODEL
        elif model_name == "sora-2-image-to-video":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Sora 2 Image to Video requires FAL_API_KEY")
            sora2_requested_duration_sec = float(max(4, min(10, int(math.ceil(segment_duration_sec or 4.0)))))
            sora2_provider_duration_sec = float(_sora_supported_duration(sora2_requested_duration_sec))
            provider_duration_sec = sora2_requested_duration_sec
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Sora 2 image-to-video generation")
            created = submit_sora_2_image_to_video_pro(
                api_key=fal_api_key,
                input={
                    "prompt": payload.get("prompt"),
                    "image_url": first_frame_url,
                    "resolution": sora2_resolution if sora2_resolution in {"auto", "720p", "1080p"} else "auto",
                    "aspect_ratio": "auto",
                    "duration": int(sora2_provider_duration_sec),
                    "delete_video": True,
                    "detect_and_block_ip": False,
                },
            )
            generation_id = created.get("request_id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected fal.ai Sora 2 create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Sora 2 image-to-video generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "fal-ai/sora-2/image-to-video/pro"
        elif model_name == "happy-horse-video-edit":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Happy Horse 1.0 Video Edit requires FAL_API_KEY")
            if not media_url:
                raise RuntimeError("Happy Horse 1.0 Video Edit requires a source video")
            provider_duration_sec = min(15.0, round(segment_duration_sec, 3))
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Happy Horse video edit generation")
            created = submit_happy_horse_video_edit(
                api_key=fal_api_key,
                input={
                    "video_url": media_url,
                    "prompt": payload.get("prompt"),
                    "reference_image_urls": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                    "resolution": happy_horse_resolution if happy_horse_resolution in {"720p", "1080p"} else "1080p",
                    "audio_setting": "origin" if provider_media_has_audio else "auto",
                    "enable_safety_checker": True,
                },
            )
            generation_id = created.get("request_id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Happy Horse video edit create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Happy Horse video edit generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "alibaba/happy-horse/video-edit"
        elif model_name == "happy-horse-image-to-video":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Happy Horse 1.0 Image to Video requires FAL_API_KEY")
            provider_duration_sec = float(max(3, min(15, int(math.ceil(segment_duration_sec or 5.0)))))
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Happy Horse image-to-video generation")
            created = submit_happy_horse_image_to_video(
                api_key=fal_api_key,
                input={
                    "image_url": first_frame_url,
                    "prompt": payload.get("prompt"),
                    "resolution": happy_horse_resolution if happy_horse_resolution in {"720p", "1080p"} else "1080p",
                    "duration": int(provider_duration_sec),
                    "enable_safety_checker": True,
                },
            )
            generation_id = created.get("request_id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Happy Horse image-to-video create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Happy Horse image-to-video generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "alibaba/happy-horse/image-to-video"
        elif model_name == "wan2.7-i2v":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("Wan 2.7 Image to Video requires REPLICATE_API_KEY")
            provider_duration_sec = float(max(2, min(10, int(math.ceil(segment_duration_sec or 2.0)))))
            wan27_first_frame_data_url = _prepare_replicate_image_data_url(
                first_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                fit_mode=first_frame_fit_mode,
            )
            wan27_reference_transport = "data_url"
            wan27_last_frame_data_url = (
                _prepare_replicate_image_data_url(
                    last_frame_bytes or first_frame_bytes,
                    target_width=first_target_w,
                    target_height=first_target_h,
                    fit_mode=first_frame_fit_mode,
                )
                if uses_end_keyframe
                else None
            )
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Wan 2.7 image-to-video generation")
            generation_id, result = _run_wan27_i2v_prediction(
                api_key=replicate_key,
                prompt=str(payload.get("prompt") or ""),
                first_frame=wan27_first_frame_data_url,
                last_frame=wan27_last_frame_data_url,
                negative_prompt=wan27_negative_prompt,
                resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
                duration_seconds=int(provider_duration_sec),
                job=job,
                store=store,
            )
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "wan-video/wan-2.7-i2v"
        elif model_name == "ltx-2.3-pro":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("LTX 2.3 Pro requires REPLICATE_API_KEY")
            if not uses_end_keyframe:
                raise RuntimeError("LTX 2.3 Pro in this app requires first and last frame mode")
            ltx23_requested_duration_sec = float(_nearest_supported_ltx23_duration(segment_duration_sec or 6.0))
            ltx23_requested_fps = _nearest_supported_ltx23_fps(fps)
            ltx23_aspect_ratio = ltx23_aspect_ratio or _nearest_allowed_aspect_ratio(
                first_source_width,
                first_source_height,
                allowed=("16:9", "9:16"),
            )
            ltx23_first_frame_data_url = _prepare_replicate_image_data_url(
                first_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                fit_mode=first_frame_fit_mode,
            )
            ltx23_last_frame_data_url = _prepare_replicate_image_data_url(
                last_frame_bytes or first_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                fit_mode=first_frame_fit_mode,
            )
            ltx23_reference_transport = "data_url"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating LTX 2.3 Pro image-to-video generation")
            generation_id, result = _run_ltx23_i2v_prediction(
                api_key=replicate_key,
                prompt=str(payload.get("prompt") or ""),
                first_frame=ltx23_first_frame_data_url,
                last_frame=ltx23_last_frame_data_url,
                duration_seconds=int(ltx23_requested_duration_sec),
                aspect_ratio=ltx23_aspect_ratio,
                fps=ltx23_requested_fps,
                generate_audio=False,
                job=job,
                store=store,
            )
            provider_duration_sec = ltx23_requested_duration_sec
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "lightricks/ltx-2.3-pro"
        elif model_name == "wan2.2-animate":
            runware_key = secrets.get("RUNWARE_API_KEY")
            if not runware_key:
                raise RuntimeError("Wan2.2 Animate generation requires RUNWARE_API_KEY")
            if not media_url:
                raise RuntimeError("Wan2.2 Animate generation requires a prepared source video")
            provider_duration_sec = round(segment_duration_sec, 3)
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Wan2.2 Animate generation")
            created = create_wan22_animate_generation(
                api_key=runware_key,
                reference_image_url=first_frame_url,
                reference_video_url=media_url,
                prompt=payload.get("prompt"),
                width=first_target_w,
                height=first_target_h,
            )
            generation_id = created.get("taskUUID")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Runware Wan2.2 Animate create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Wan2.2 Animate generation")
            result = _wait_runware_video_complete(runware_key, task_uuid=generation_id)
            out_url = _parse_runware_video_output_url(result)
            used_provider_model = RUNWARE_WAN22_ANIMATE_MODEL
        elif model_name == "kling-o1":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("Kling O1 Edit requires REPLICATE_API_KEY")
            if not media_url:
                raise RuntimeError("Kling O1 Edit requires a prepared source video")
            provider_duration_sec = float(max(3, min(10, int(round(segment_duration_sec or 5)))))
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Kling O1 Edit generation")
            created = create_replicate_prediction(
                api_key=replicate_key,
                version=REPLICATE_KLING_O1_VERSION,
                input={
                    "prompt": payload.get("prompt"),
                    "reference_video": media_url,
                    "reference_images": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                    "video_reference_type": "base",
                    "keep_original_sound": True,
                    "mode": replicate_kling_mode if replicate_kling_mode in {"std", "pro"} else "pro",
                    "aspect_ratio": replicate_aspect_ratio or "16:9",
                    "duration": int(provider_duration_sec),
                },
            )
            generation_id = created.get("id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Replicate Kling O1 create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Kling O1 Edit generation")
            result = _wait_replicate_complete(replicate_key, prediction_id=generation_id)
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "kwaivgi/kling-o1"
        elif model_name == "kling-v3-omni-video":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("Kling v3 Omni Video requires REPLICATE_API_KEY")
            if not media_url:
                raise RuntimeError("Kling v3 Omni Video requires a prepared source video")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Kling v3 Omni Video generation")
            created = create_replicate_prediction(
                api_key=replicate_key,
                version=REPLICATE_KLING_V3_OMNI_VIDEO_VERSION,
                input={
                    "prompt": payload.get("prompt"),
                    "reference_video": media_url,
                    "reference_images": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                    "video_reference_type": "base",
                    "keep_original_sound": True,
                    "mode": replicate_kling_v3_mode if replicate_kling_v3_mode in {"standard", "pro"} else "pro",
                    "aspect_ratio": replicate_aspect_ratio or "16:9",
                },
            )
            generation_id = created.get("id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Replicate Kling v3 Omni create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Kling v3 Omni Video generation")
            result = _wait_replicate_complete(replicate_key, prediction_id=generation_id)
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "kwaivgi/kling-v3-omni-video"
        elif model_name == "seedance-2.0-reference-to-video":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Seedance 2.0 Reference to Video requires FAL_API_KEY")
            if not media_url:
                raise RuntimeError("Seedance 2.0 Reference to Video requires a prepared source video")
            seedance_duration = int(math.ceil(segment_duration_sec or 4.0))
            provider_duration_sec = float(max(4, min(15, seedance_duration)))
            seedance_requested_duration_sec = provider_duration_sec
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Seedance 2.0 generation")
            created = submit_seedance_reference_to_video(
                api_key=fal_api_key,
                input={
                    "prompt": payload.get("prompt"),
                    "image_urls": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                    "video_urls": [media_url],
                    "resolution": "720p",
                    "duration": str(int(provider_duration_sec)),
                    "aspect_ratio": seedance_aspect_ratio or "auto",
                    "generate_audio": False,
                    "end_user_id": job["userId"],
                },
            )
            generation_id = created.get("request_id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected fal.ai Seedance create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Seedance 2.0 generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "bytedance/seedance-2.0/reference-to-video"
        elif model_name == "wan2.7-videoedit":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("Wan 2.7 VideoEdit requires REPLICATE_API_KEY")
            if not wan27_video_data_url:
                raise RuntimeError("Wan 2.7 VideoEdit requires a prepared source video payload")
            provider_duration_sec = provider_input_duration_sec
            wan27_reference_data_url = _prepare_replicate_image_data_url(
                first_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                fit_mode=first_frame_fit_mode,
            )
            wan27_reference_transport = "data_url"
            generation_id, result = _run_wan27_prediction(
                api_key=replicate_key,
                prompt=str(payload.get("prompt") or ""),
                media_url=wan27_video_data_url,
                reference_image=wan27_reference_data_url,
                resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
                aspect_ratio=wan27_aspect_ratio or "auto",
                audio_setting="origin" if provider_media_has_audio else "auto",
                job=job,
                store=store,
            )
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "wan-video/wan-2.7-videoedit"
        else:
            luma_key = _resolve_luma_uni_api_key(secrets)
            if not luma_key:
                raise RuntimeError(
                    "Luma Ray 3.2 video edit requires a Luma Agents key (`luma-api-*`) in "
                    "LUMA_AGENTS_API_KEY, or in LUMA_API_KEY if that value is also an Agents key."
                )
            if not media_url:
                raise RuntimeError("Luma generation requires a prepared source video")
            ray32_resolution = _luma_ray32_resolution_label(model_name)
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Luma Ray 3.2 video edit generation")
            created = create_video_edit_generation(
                api_key=luma_key,
                media_url=media_url,
                resolution=ray32_resolution,
                strength=luma_mode,
                prompt=payload.get("prompt"),
                start_frame_url=first_frame_url,
            )
            generation_id = created.get("id") or created.get("generation_id")
            if not generation_id:
                raise RuntimeError(f"Unexpected Luma create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Luma Ray 3.2 generation")
            result = _wait_luma_complete(luma_key, generation_id)
            out_url = _parse_luma_output_url(result)
            used_provider_model = "ray-3.2"

        out_key = paths.request_artifact(request_id, "output", "result", ".mp4")
        _api_request_progress(job=job, store=store, request_record=request_record, progress=75, status="running", logs="Downloading provider output")
        downloaded_path = td_path / "provider_output_raw.mp4"
        _download_url_to_path(out_url, downloaded_path)
        if (
            model_name == "sora-2-image-to-video"
            and sora2_requested_duration_sec
            and sora2_provider_duration_sec
            and sora2_provider_duration_sec - sora2_requested_duration_sec > 1e-3
        ):
            _api_request_progress(job=job, store=store, request_record=request_record, progress=79, status="running", logs="Trimming Sora output to requested duration")
            trimmed_path = td_path / "provider_output_trimmed.mp4"
            trim_video_to_duration(
                str(downloaded_path),
                str(trimmed_path),
                duration_sec=sora2_requested_duration_sec,
                crf=16,
                preset="medium",
                audio_bitrate="192k",
            )
            downloaded_path = trimmed_path
        raw_output_probe = ffprobe_video(str(downloaded_path))
        if model_name == "seedance-2.0-reference-to-video":
            seedance_raw_output_width = int(raw_output_probe.get("width") or 0) or None
            seedance_raw_output_height = int(raw_output_probe.get("height") or 0) or None
        needs_timeline_conform = _needs_timeline_conform(
            raw_output_probe,
            target_width=src_width,
            target_height=src_height,
            target_fps=fps,
        )
        if needs_timeline_conform:
            _api_request_progress(
                job=job,
                store=store,
                request_record=request_record,
                progress=82,
                status="running",
                logs="Conforming provider output to source resolution and frame rate",
            )
            conformed_path = td_path / "provider_output_timeline.mp4"
            transcode_to_cfr(
                str(downloaded_path),
                str(conformed_path),
                fps,
                target_width=src_width,
                target_height=src_height,
                crf=16,
                preset="medium",
            )
            asset_store.put_bytes(out_key, conformed_path.read_bytes(), content_type="video/mp4")
            output_probe = ffprobe_video(str(conformed_path))
        else:
            asset_store.put_bytes(out_key, downloaded_path.read_bytes(), content_type="video/mp4")
            output_probe = raw_output_probe
        output_duration_value = float(output_probe.get("duration_sec") or 0.0)
        if output_duration_value > 0:
            provider_duration_sec = round(output_duration_value, 3)
        if model_name == "seedance-2.0-reference-to-video":
            seedance_output_width = int(output_probe.get("width") or src_width)
            seedance_output_height = int(output_probe.get("height") or src_height)
        timeline_conform = _timeline_conform_summary(
            source_probe=source_probe,
            raw_output_probe=raw_output_probe,
            stored_output_probe=output_probe,
            applied=needs_timeline_conform,
            policy="source_cfr_resolution",
        )

    finished_at = now_iso()
    request_record["finishedAt"] = finished_at
    request_record["processingDurationSec"] = _processing_duration_seconds(request_record.get("startedAt"), finished_at)
    request_record["provider"] = provider_name
    request_record["status"] = "complete"
    request_record["preparedAssets"] = {
        "video": {"key": media_key_for_provider, "contentType": "video/mp4"} if media_key_for_provider else None,
        "firstFrame": {"key": first_frame_input_key, "contentType": first_frame_content_type} if first_frame_input_key else None,
        "lastFrame": {"key": last_frame_input_key, "contentType": last_frame_content_type} if last_frame_input_key else None,
    }
    request_record["outputAssets"] = {
        "output": {
            "key": out_key,
            "contentType": "video/mp4",
            "width": int(output_probe.get("width") or 0),
            "height": int(output_probe.get("height") or 0),
            "durationSec": float(output_probe.get("duration_sec") or 0.0),
            "fps": {
                "num": int(output_probe.get("fps_num") or 0),
                "den": int(output_probe.get("fps_den") or 1),
            },
        }
    }
    request_record["normalization"] = {
        "inputVideo": {
            "width": src_width,
            "height": src_height,
            "durationSec": round(segment_duration_sec, 3),
            "fps": {"num": fps.numerator, "den": fps.denominator},
        },
        "preparedMediaResolution": (
            {"width": provider_media_width, "height": provider_media_height}
            if provider_media_width and provider_media_height
            else None
        ),
        "preparedMediaFps": (
            {"num": provider_media_fps.numerator, "den": provider_media_fps.denominator}
            if provider_media_fps
            else None
        ),
        "preserveFrames": preserve_frames,
        "providerInputTimingPolicy": provider_input_timing_policy,
        "preparedFirstFrameResolution": {"width": first_target_w, "height": first_target_h},
        "requestedDurationSec": round(segment_duration_sec, 3),
        "providerDurationSec": provider_duration_sec,
        "providerOutputRaw": _video_timing_payload(raw_output_probe),
        "storedOutput": _video_timing_payload(output_probe),
        "timelineConform": timeline_conform,
        "aspectRatio": (
            ltx23_aspect_ratio
            if model_name == "ltx-2.3-pro"
            else (replicate_aspect_ratio or seedance_aspect_ratio or (wan27_aspect_ratio if model_name == "wan2.7-videoedit" else None))
        ),
        "sora2Resolution": sora2_resolution if model_name == "sora-2-image-to-video" else None,
        "happyHorseResolution": happy_horse_resolution if model_name in {"happy-horse-video-edit", "happy-horse-image-to-video"} else None,
        "sora2RequestedDurationSec": sora2_requested_duration_sec if model_name == "sora-2-image-to-video" else None,
        "sora2ProviderDurationSec": sora2_provider_duration_sec if model_name == "sora-2-image-to-video" else None,
        "ltx23RequestedDurationSec": ltx23_requested_duration_sec if model_name == "ltx-2.3-pro" else None,
        "ltx23RequestedFps": ltx23_requested_fps if model_name == "ltx-2.3-pro" else None,
        "seedanceRequestedDurationSec": seedance_requested_duration_sec,
        "seedanceRawOutputResolution": (
            {"width": seedance_raw_output_width, "height": seedance_raw_output_height}
            if seedance_raw_output_width and seedance_raw_output_height
            else None
        ),
        "seedanceOutputResolution": (
            {"width": seedance_output_width, "height": seedance_output_height}
            if seedance_output_width and seedance_output_height
            else None
        ),
        "wan27Resolution": wan27_resolution if model_name in {"wan2.7-videoedit", "wan2.7-i2v"} else None,
        "wan27VideoTransport": wan27_video_transport,
        "wan27ReferenceTransport": wan27_reference_transport,
        "wan27NegativePrompt": wan27_negative_prompt if model_name == "wan2.7-i2v" else None,
        "ltx23ReferenceTransport": ltx23_reference_transport if model_name == "ltx-2.3-pro" else None,
        "mediaHasAudio": provider_media_has_audio,
        "providerModel": used_provider_model or model_name,
    }
    _record_usage(
        store=store,
        user_id=job["userId"],
        source="external_api_reference_video_generate",
        tool_origin="external_api_reference_video_generate",
        request_type="video_generation",
        provider=provider_name,
        provider_model=used_provider_model or model_name,
        app_model_id=model_name,
        target_record=request_record,
        request_id=request_id,
        asset_id=request_id,
        asset_kind="api_request",
        duration_sec=provider_duration_sec,
        width=output_width,
        height=output_height,
        fps=float(output_fps.numerator) / float(output_fps.denominator) if isinstance(output_fps, Fraction) else None,
        resolution_label=(
            _luma_ray32_resolution_label(model_name)
            if model_name in {"ray-3.2-720p", "ray-3.2-1080p"}
            else (
                "1080p"
                if min(int(output_width or 0), int(output_height or 0)) >= 1080
                else "720p" if min(int(output_width or 0), int(output_height or 0)) >= 720 else None
            )
        ),
    )
    request_record["error"] = None
    _save_api_request(store, request_record)
    _job_progress(job, store, 100, "complete", "API reference video generation completed")
    job["resultRefs"] = {"requestId": request_id, "outputKey": out_key}
    store.save_job(job)
    return job


def _handle_edit_video_reference_generate(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    reference_id = str(payload["referenceId"])
    model = str(payload["model"])
    prompt = str(payload["prompt"])
    aspect_ratio = str(payload.get("aspectRatio") or "").strip() or None
    selected_reference_ids = [str(item or "").strip() for item in payload.get("selectedReferenceIds") or [] if str(item or "").strip()]
    references = task.setdefault("editVideoReferences", [])
    reference_record = next(
        (item for item in references if isinstance(item, dict) and str(item.get("referenceId") or "") == reference_id),
        None,
    )
    if not isinstance(reference_record, dict):
        raise RuntimeError(f"Edit video reference not found: {reference_id}")

    now = now_iso()
    reference_record["status"] = "running"
    reference_record["jobId"] = job.get("jobId")
    reference_record["updatedAt"] = now
    reference_record.pop("error", None)
    store.save_task(task, merge_on_conflict=True)

    secrets = load_secret(settings.secrets_arn)
    selected_reference_images: list[tuple[bytes, str]] = []
    selected_reference_luma_inputs: list[dict[str, str]] = []
    reference_prefix = f"users/{task['userId']}/tasks/{task['taskId']}/"
    reference_lookup = {
        str(item.get("referenceId") or ""): item
        for item in references
        if isinstance(item, dict) and item.get("referenceId")
    }
    for selected_reference_id in selected_reference_ids:
        source_reference = reference_lookup.get(selected_reference_id)
        key = str((source_reference or {}).get("key") or "").strip()
        if not key or not key.startswith(reference_prefix):
            continue
        image_bytes = asset_store.read_bytes(key)
        mime_type = _reference_content_type_from_key(key)
        selected_reference_images.append((image_bytes, mime_type))
        selected_reference_luma_inputs.append(
            {
                "data": base64.b64encode(image_bytes).decode("utf-8"),
                "media_type": mime_type,
            }
        )

    provider_name = "google"
    provider_model_name = model
    if model in {"chatgpt", "chatgpt_latest"}:
        provider_name = "openai"
        openai_key = str(secrets.get("OPENAI_API_KEY") or "")
        if not openai_key:
            raise RuntimeError("OPENAI_API_KEY is required for ChatGPT image generation")
        if selected_reference_images:
            out_bytes = generate_openai_image_from_references(
                api_key=openai_key,
                model=model,
                prompt=prompt,
                reference_images=selected_reference_images,
                aspect_ratio=aspect_ratio,
            )
        else:
            blank_image = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
            blank_output = BytesIO()
            blank_image.save(blank_output, format="PNG")
            out_bytes = generate_openai_image_edit(
                api_key=openai_key,
                model=model,
                prompt=prompt,
                input_image_bytes=blank_output.getvalue(),
                aspect_ratio=aspect_ratio,
            )
    elif model in {"luma_uni_1", "luma_uni_1_max"}:
        provider_name = "luma"
        luma_key = str(secrets.get("LUMA_AGENTS_API_KEY") or secrets.get("LUMA_API_KEY") or "").strip()
        if not luma_key or not luma_key.startswith("luma-api-"):
            raise RuntimeError("Luma Uni requires a Luma Agents key (`luma-api-*`).")
        provider_model_name = "uni-1-max" if model == "luma_uni_1_max" else "uni-1"
        created = create_uni_image_generation(
            api_key=luma_key,
            prompt=prompt,
            model=provider_model_name,
            style="auto",
            output_format="png",
            image_refs=selected_reference_luma_inputs or None,
            aspect_ratio=aspect_ratio,
        )
        generation_id = str(created.get("id") or "")
        if not generation_id:
            raise RuntimeError(f"Luma Uni create response missing id: {created}")
        result = wait_for_uni_generation_complete(api_key=luma_key, generation_id=generation_id)
        output_url = parse_uni_output_url(result)
        download = requests.get(output_url, timeout=240)
        download.raise_for_status()
        out_bytes = download.content
    else:
        gemini_key = str(secrets.get("GEMINI_API_KEY") or "")
        if not gemini_key:
            raise RuntimeError("GEMINI_API_KEY is required for Gemini image generation")
        if selected_reference_images:
            out_bytes = generate_gemini_image_from_references(
                api_key=gemini_key,
                model=model,
                prompt=prompt,
                reference_images=selected_reference_images,
                aspect_ratio=aspect_ratio,
            )
        else:
            blank_image = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
            blank_output = BytesIO()
            blank_image.save(blank_output, format="PNG")
            out_bytes = generate_gemini_image_edit(
                api_key=gemini_key,
                model=model,
                prompt=prompt,
                input_image_bytes=blank_output.getvalue(),
                aspect_ratio=aspect_ratio,
            )

    normalized_bytes = _normalize_generated_reference_png(out_bytes)
    with Image.open(BytesIO(normalized_bytes)) as generated_image:
        generated_width, generated_height = generated_image.size
    key = _asset_paths(task).edit_video_reference(reference_id, f"{reference_id}.png")
    asset_store.put_bytes(key, normalized_bytes, content_type="image/png")
    finished_at = now_iso()
    reference_record["key"] = key
    reference_record["filename"] = f"{reference_id}.png"
    reference_record["aspectRatio"] = aspect_ratio
    reference_record["status"] = "complete"
    reference_record["updatedAt"] = finished_at
    reference_record["jobId"] = job.get("jobId")
    reference_record["error"] = None
    _record_usage(
        store=store,
        user_id=task["userId"],
        task=task,
        source="edit_video_reference_generate",
        tool_origin="edit_video_reference_generate",
        request_type="image_generation",
        provider=provider_name,
        provider_model=provider_model_name,
        app_model_id=model,
        target_record=reference_record,
        asset_id=reference_id,
        asset_kind="edit_video_reference",
        width=generated_width,
        height=generated_height,
        operation="reference_generation",
        reference_count=len(selected_reference_ids),
    )
    task.setdefault("history", []).append(
        {
            "at": finished_at,
            "event": "edit_video_reference.complete",
            "jobId": job.get("jobId"),
            "referenceId": reference_id,
            "model": model,
        }
    )
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 100, "complete", "Edit video reference generation completed")
    job["resultRefs"] = {"referenceId": reference_id, "outputKey": key}
    store.save_job(job)
    return job


def _handle_quality_match_apply(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    frame_id = str(payload["frameId"])
    analysis_id = str(payload["analysisId"])
    final_mask_key = str(payload["finalMaskKey"])
    qm_settings = QualityMatchSettings.from_payload(payload.get("settings") or {})
    overwrite_generated_frame = bool(payload.get("overwriteGeneratedFrame", True))

    _job_progress(job, store, 10, "running", "Loading Quality Match assets")
    result = apply_quality_match_to_task(
        task=task,
        asset_store=asset_store,
        user_id=job["userId"],
        frame_id=frame_id,
        analysis_id=analysis_id,
        final_mask_key=final_mask_key,
        settings=qm_settings,
        overwrite_generated_frame=overwrite_generated_frame,
    )
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Quality Match refined frame saved")
    job["resultRefs"] = {
        "frameId": result["frameId"],
        "variantId": result["variantId"],
        "analysisId": result["analysisId"],
        "finalKey": result["finalKey"],
        "reportJsonKey": result["reportJsonKey"],
    }
    store.save_job(job)
    return job


def _handle_quality_match_sam(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    frame_id = str(payload["frameId"])
    variant_id = str(payload["variantId"])
    analysis_id = str(payload["analysisId"])
    frame = task.get("frames", {}).get(frame_id)
    if not isinstance(frame, dict):
        raise RuntimeError("Frame not found")
    variant = next((item for item in frame.get("variants", []) if item.get("variantId") == variant_id), None)
    if not isinstance(variant, dict):
        raise RuntimeError("Variant not found")

    _job_progress(job, store, 10, "running", "Loading SAM source frame")
    secrets = load_secret(settings.secrets_arn)
    fal_api_key = secrets.get("FAL_API_KEY")
    if not fal_api_key:
        raise RuntimeError("FAL_API_KEY is not configured in Secrets Manager")

    existing_mask_key = payload.get("existingMaskKey")
    existing_mask_bytes = asset_store.read_bytes(existing_mask_key) if isinstance(existing_mask_key, str) and existing_mask_key else None
    sam_image_bytes = asset_store.read_bytes(variant["outputKey"])
    if analysis_id:
        analysis = (task.get("qualityMatchAnalyses") or {}).get(analysis_id)
        if isinstance(analysis, dict):
            analysis_artifacts = analysis.get("artifacts") if isinstance(analysis.get("artifacts"), dict) else {}
            aligned_generated_key = analysis_artifacts.get("alignedGeneratedKey")
            if isinstance(aligned_generated_key, str) and aligned_generated_key:
                try:
                    sam_image_bytes = asset_store.read_bytes(aligned_generated_key)
                except Exception:
                    logger.exception("quality_match.sam_aligned_read_failed")

    _job_progress(job, store, 35, "running", "Submitting SAM segmentation request")
    result = request_sam2_proposals(
        fal_api_key=fal_api_key,
        image_bytes=sam_image_bytes,
        positive_points=list(payload.get("positivePoints") or []),
        negative_points=list(payload.get("negativePoints") or []),
        box=payload.get("box"),
        existing_mask_bytes=existing_mask_bytes,
        restrict_to_mask_bounds=bool(payload.get("restrictToMaskBounds")),
        edge_bias=str(payload.get("edgeBias") or "balanced"),
    )

    _job_progress(job, store, 80, "running", "Storing SAM proposal")
    paths = _asset_paths(task)
    proposal_items: list[dict[str, Any]] = []
    for item in result["proposals"]:
        proposal_id = new_id("samp")
        proposal_key = paths.quality_match_artifact(frame_id, analysis_id, f"sam_proposal_{proposal_id}", ".png")
        asset_store.put_bytes(proposal_key, item["maskBytes"], content_type="image/png")
        proposal_items.append(
            {
                "id": proposal_id,
                "maskUrl": asset_store.presign_get(proposal_key, expires=3600),
                "score": item.get("score"),
                "bounds": item.get("bounds"),
            }
        )

    usage_payload = {
        "imageCount": 1,
        "proposalCount": len(proposal_items),
        "positivePointCount": len(list(payload.get("positivePoints") or [])),
        "negativePointCount": len(list(payload.get("negativePoints") or [])),
        "usedExistingMask": bool(existing_mask_bytes),
        "restrictToMaskBounds": bool(payload.get("restrictToMaskBounds")),
    }
    if payload.get("box"):
        usage_payload["usedBoxPrompt"] = True

    _job_progress(job, store, 100, "complete", "SAM proposal ready")
    job["resultRefs"] = {
        "frameId": frame_id,
        "variantId": variant_id,
        "analysisId": analysis_id,
        "proposals": proposal_items,
        "warnings": result.get("warnings", []),
    }
    _record_usage(
        store=store,
        user_id=str(task.get("userId") or ""),
        source="quality_match_sam",
        tool_origin="quality_match_sam",
        request_type="image_segmentation",
        provider="fal.ai",
        provider_model="fal-ai/sam2/image",
        app_model_id="fal-ai/sam2/image",
        target_record=job["resultRefs"],
        task=task,
        request_id=str(job.get("jobId") or ""),
        asset_id=analysis_id,
        asset_kind="quality_match_analysis",
        usage=usage_payload,
        image_count=1,
        operation="segmentation",
        notes="SAM-assisted quality-match mask proposal generation.",
    )
    store.save_job(job)
    return job


def _handle_segment_generate_clip_lengthen(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    segment_id = str(payload["segmentId"])
    gen_id = str(payload["genId"])
    model_name = str(payload["lumaModel"])
    requested_mode = str(payload.get("mode") or "")
    clip_lengthen = payload.get("clipLengthenMetadata") if isinstance(payload.get("clipLengthenMetadata"), dict) else {}
    parent_generation_id = str(payload.get("parentGenerationId") or clip_lengthen.get("parentGenerationId") or "")
    direction = str(clip_lengthen.get("direction") or "end")
    input_mode = str(payload.get("inputMode") or clip_lengthen.get("inputMode") or "")
    requested_added_duration_sec = max(1, int(clip_lengthen.get("durationSeconds") or 6))
    prompt = str(payload.get("prompt") or "").strip()
    if not parent_generation_id:
        raise RuntimeError("Clip lengthen requires a parent generation")
    parent_generation = task.get("segmentGenerations", {}).get(parent_generation_id)
    if not isinstance(parent_generation, dict):
        raise RuntimeError("Parent generation not found for clip lengthen")
    if parent_generation.get("status") != "complete" or not parent_generation.get("outputKey"):
        raise RuntimeError("Parent generation must be complete before it can be lengthened")

    segment = next((item for item in task.get("segments", []) if isinstance(item, dict) and item.get("segmentId") == segment_id), None)
    if not isinstance(segment, dict):
        raise RuntimeError("Source segment not found")

    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates={
            "genId": gen_id,
            "segmentId": segment_id,
            "status": "running",
            "jobId": job.get("jobId"),
            "error": None,
            "startedAt": now_iso(),
            "updatedAt": now_iso(),
        },
        history_entry={
            "at": now_iso(),
            "event": "segment_generation.running",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "segmentId": segment_id,
            "model": model_name,
        },
    )

    paths = _asset_paths(task)
    s3 = boto3.client("s3")
    parent_settings = parent_generation.get("generationSettings") if isinstance(parent_generation.get("generationSettings"), dict) else {}
    parent_stored_output = parent_settings.get("storedOutput") if isinstance(parent_settings.get("storedOutput"), dict) else {}
    preserve_frames = bool(payload.get("preserveFrames", parent_settings.get("preserveFrames", True)))
    wan27_resolution = str(payload.get("wan27Resolution") or parent_settings.get("wan27Resolution") or "720p")
    source_fps = Fraction(
        int(parent_stored_output.get("fps", {}).get("num") or task.get("video", {}).get("editSource", {}).get("fps", {}).get("num") or 24),
        int(parent_stored_output.get("fps", {}).get("den") or task.get("video", {}).get("editSource", {}).get("fps", {}).get("den") or 1),
    )

    reference_prefix = f"users/{task['userId']}/tasks/{task['taskId']}/"
    reference_lookup: dict[str, dict[str, Any]] = {
        str(item.get("referenceId")): item
        for item in task.get("editVideoReferences", [])
        if isinstance(item, dict) and item.get("referenceId")
    }
    raw_selected_reference_ids = payload.get("selectedReferenceIds")
    selected_reference_ids: list[str] = []
    if isinstance(raw_selected_reference_ids, list):
        for item in raw_selected_reference_ids:
            ref_id = str(item or "").strip()
            if ref_id and ref_id not in selected_reference_ids:
                selected_reference_ids.append(ref_id)
    selected_reference_keys: list[str] = []
    for ref_id in selected_reference_ids:
        reference = reference_lookup.get(ref_id)
        key = str((reference or {}).get("key") or "").strip()
        if key and key.startswith(reference_prefix):
            selected_reference_keys.append(key)

    provider_name = _segment_generation_provider_name(model_name)
    used_provider_model = model_name
    generation_id: str | None = None
    provider_duration_sec = 0.0
    provider_input_duration_sec = 0.0
    provider_input_timing_policy = "clip_lengthen"
    provider_media_width: int | None = None
    provider_media_height: int | None = None
    provider_media_fps: Fraction | None = None
    provider_media_has_audio: bool | None = None
    media_key_for_provider: str | None = None
    out_url: str | None = None
    raw_output_probe: dict[str, Any] | None = None
    stored_output_probe: dict[str, Any] | None = None
    timeline_resize_mode = "pad"

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        base_video_path = td_path / "base_generation.mp4"
        _download_s3(s3, settings.assets_bucket, str(parent_generation["outputKey"]), base_video_path)
        base_probe = ffprobe_video(str(base_video_path))
        base_width = int(base_probe.get("width") or parent_stored_output.get("width") or task.get("video", {}).get("editSource", {}).get("width") or 0)
        base_height = int(base_probe.get("height") or parent_stored_output.get("height") or task.get("video", {}).get("editSource", {}).get("height") or 0)
        base_duration_sec = float(base_probe.get("duration_sec") or 0.0)
        provider_media_has_audio = bool(base_probe.get("has_audio"))
        provider_media_width = base_width
        provider_media_height = base_height
        provider_media_fps = source_fps
        provider_input_duration_sec = round(base_duration_sec, 3)
        selected_reference_urls = [asset_store.presign_get(key, expires=3600) for key in selected_reference_keys]
        secrets = load_secret(settings.secrets_arn)

        if model_name == "ltx-2.3-pro":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("LTX 2.3 Pro extension requires REPLICATE_API_KEY")
            prepared_video_path = td_path / "ltx_extension_input.mp4"
            provider_media_width, provider_media_height = transcode_for_provider(
                str(base_video_path),
                str(prepared_video_path),
                fps=source_fps,
                source_width=base_width,
                source_height=base_height,
                landscape_target=(1920, 1080),
                portrait_target=(1080, 1920),
                resize_mode="crop",
                crf=18,
            )
            timeline_resize_mode = "crop"
            media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "replicate")
            _upload_s3(s3, settings.assets_bucket, media_key_for_provider, prepared_video_path, "video/mp4")
            media_url = asset_store.presign_get(media_key_for_provider, expires=3600)
            provider_duration_sec = float(requested_added_duration_sec)
            ltx23_requested_fps = _nearest_supported_ltx23_fps(source_fps)
            generation_id, result = _run_ltx23_extend_prediction(
                api_key=replicate_key,
                prompt=prompt,
                video=media_url,
                duration_seconds=requested_added_duration_sec,
                extend_mode=direction,
                fps=ltx23_requested_fps,
                generate_audio=False,
                job=job,
                store=store,
            )
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "lightricks/ltx-2.3-pro"
        elif model_name == "wan2.7-i2v":
            if direction != "end":
                raise RuntimeError("Wan 2.7 clip continuation only supports extending from the end")
            if base_duration_sec < 2.0 or base_duration_sec > 10.0:
                raise RuntimeError("Wan 2.7 clip continuation requires a base clip between 2 and 10 seconds")
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("Wan 2.7 clip continuation requires REPLICATE_API_KEY")
            target_total_duration = min(15, max(int(math.ceil(base_duration_sec + requested_added_duration_sec)), int(math.ceil(base_duration_sec))))
            if target_total_duration <= int(math.ceil(base_duration_sec)):
                raise RuntimeError("Wan 2.7 clip continuation needs at least one additional second")
            prepared_video_path = td_path / "wan27_continuation_input.mp4"
            provider_media_width, provider_media_height = transcode_for_provider(
                str(base_video_path),
                str(prepared_video_path),
                fps=source_fps,
                source_width=base_width,
                source_height=base_height,
                landscape_target=(1920 if wan27_resolution == "1080p" else 1280, 1080 if wan27_resolution == "1080p" else 720),
                portrait_target=(1080 if wan27_resolution == "1080p" else 720, 1920 if wan27_resolution == "1080p" else 1280),
                resize_mode="pad",
                crf=18,
            )
            media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "replicate")
            _upload_s3(s3, settings.assets_bucket, media_key_for_provider, prepared_video_path, "video/mp4")
            media_url = asset_store.presign_get(media_key_for_provider, expires=3600)
            provider_duration_sec = float(target_total_duration)
            generation_id, result = _run_wan27_continuation_prediction(
                api_key=replicate_key,
                prompt=prompt,
                first_clip=media_url,
                negative_prompt=str(payload.get("negativePrompt") or "").strip() or None,
                resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
                duration_seconds=target_total_duration,
                job=job,
                store=store,
            )
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "wan-video/wan-2.7-i2v"
        elif model_name in {"veo-3.1", "veo-3.1-fast"}:
            if direction != "end":
                raise RuntimeError("Veo clip extension only supports extending from the end")
            runware_key = secrets.get("RUNWARE_API_KEY")
            if not runware_key:
                raise RuntimeError("Veo clip extension requires RUNWARE_API_KEY")
            prepared_video_path = td_path / "veo_extension_input.mp4"
            provider_media_width, provider_media_height = transcode_for_provider(
                str(base_video_path),
                str(prepared_video_path),
                fps=Fraction(24, 1),
                source_width=base_width,
                source_height=base_height,
                landscape_target=(1280, 720),
                portrait_target=(720, 1280),
                resize_mode="pad",
                crf=18,
            )
            provider_media_fps = Fraction(24, 1)
            provider_input_timing_policy = "fixed_24fps"
            media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "runware")
            _upload_s3(s3, settings.assets_bucket, media_key_for_provider, prepared_video_path, "video/mp4")
            media_url = asset_store.presign_get(media_key_for_provider, expires=3600)
            provider_duration_sec = 7.0
            runware_model = RUNWARE_VEO_31_MODEL if model_name == "veo-3.1" else RUNWARE_VEO_31_FAST_MODEL
            _job_progress(job, store, 35, "running", f"Creating Runware {model_name} clip extension")
            created = create_veo_video_extension(
                api_key=runware_key,
                model=runware_model,
                video_url=media_url,
                prompt=prompt,
                duration_seconds=7,
            )
            generation_id = created.get("taskUUID")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected Runware Veo extension response: {created}")
            _job_progress(job, store, 55, "running", "Polling Runware Veo clip extension")
            result = _wait_runware_video_complete(runware_key, task_uuid=generation_id)
            out_url = _parse_runware_video_output_url(result)
            provider_name = "runware"
            used_provider_model = runware_model
        elif model_name == "seedance-2.0-reference-to-video":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Seedance continuation requires FAL_API_KEY")
            target_total_duration = min(15, max(int(math.ceil(base_duration_sec + requested_added_duration_sec)), int(math.ceil(base_duration_sec))))
            if target_total_duration <= int(math.ceil(base_duration_sec)):
                raise RuntimeError("Seedance continuation needs at least one additional second")
            media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "fal")
            _upload_s3(s3, settings.assets_bucket, media_key_for_provider, base_video_path, "video/mp4")
            media_url = asset_store.presign_get(media_key_for_provider, expires=3600)
            provider_duration_sec = float(target_total_duration)
            provider_name = "fal"
            aspect_ratio = _nearest_allowed_aspect_ratio(base_width, base_height, allowed=("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"))
            reference_tokens = ", ".join(f"@Image{idx + 1}" for idx in range(len(selected_reference_urls)))
            if direction == "start":
                prompt_prefix = (
                    f"Create a shot that happens immediately before @Video1 and transitions seamlessly into it without restarting the scene. Use {reference_tokens} as ordered visual references. "
                    if selected_reference_urls
                    else "Create a shot that happens immediately before @Video1 and transitions seamlessly into it without restarting the scene. "
                )
            else:
                prompt_prefix = (
                    f"Continue naturally from @Video1 without restarting the shot. Use {reference_tokens} as ordered visual references. "
                    if selected_reference_urls
                    else "Continue naturally from @Video1 without restarting the shot. "
                )
            _job_progress(job, store, 35, "running", "Creating fal.ai Seedance continuation")
            created = submit_seedance_reference_to_video(
                api_key=fal_api_key,
                input={
                    "prompt": f"{prompt_prefix}{prompt}".strip(),
                    "image_urls": selected_reference_urls[:9],
                    "video_urls": [media_url],
                    "resolution": "720p",
                    "duration": str(target_total_duration),
                    "aspect_ratio": aspect_ratio or "auto",
                    "generate_audio": False,
                    "end_user_id": task.get("userId"),
                },
            )
            generation_id = created.get("request_id")
            if not isinstance(generation_id, str):
                raise RuntimeError(f"Unexpected fal.ai Seedance continuation response: {created}")
            _job_progress(job, store, 55, "running", "Polling fal.ai Seedance continuation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "bytedance/seedance-2.0/reference-to-video"
        else:
            raise RuntimeError(f"Unsupported clip lengthen model: {model_name}")

        if not out_url:
            raise RuntimeError("Provider did not return a clip output URL")

        output_key = paths.segment_generated(segment_id, gen_id)
        _job_progress(job, store, 75, "running", "Downloading generation output to S3")
        downloaded_path = td_path / "provider_output_raw.mp4"
        _download_url_to_path(out_url, downloaded_path)
        raw_output_probe = ffprobe_video(str(downloaded_path))
        needs_timeline_conform = _needs_timeline_conform(
            raw_output_probe,
            target_width=base_width,
            target_height=base_height,
            target_fps=source_fps,
        )
        if needs_timeline_conform:
            _job_progress(job, store, 82, "running", "Conforming provider output to working clip resolution and frame rate")
            conformed_path = td_path / "provider_output_timeline.mp4"
            transcode_to_cfr(
                str(downloaded_path),
                str(conformed_path),
                source_fps,
                target_width=base_width,
                target_height=base_height,
                resize_mode=timeline_resize_mode,
                crf=16,
                preset="medium",
            )
            _upload_s3(s3, settings.assets_bucket, output_key, conformed_path, "video/mp4")
            stored_output_probe = ffprobe_video(str(conformed_path))
        else:
            _upload_s3(s3, settings.assets_bucket, output_key, downloaded_path, "video/mp4")
            stored_output_probe = raw_output_probe

        output_duration_value = float(stored_output_probe.get("duration_sec") or 0.0)
        if output_duration_value > 0:
            provider_duration_sec = round(output_duration_value, 3)
        timeline_conform = _timeline_conform_summary(
            source_probe=base_probe,
            raw_output_probe=raw_output_probe,
            stored_output_probe=stored_output_probe,
            applied=needs_timeline_conform,
            policy="clip_lengthen_cfr_resolution",
        )

    finished_at = now_iso()
    processing_duration_sec = _processing_duration_seconds(gen_meta.get("startedAt"), finished_at)
    poster_key = _create_segment_generation_poster(
        asset_store=asset_store,
        paths=paths,
        segment_id=segment_id,
        gen_id=gen_id,
        video_path=str(conformed_path if needs_timeline_conform else downloaded_path),
    )
    inherited_alignment = parent_generation.get("alignment") if isinstance(parent_generation.get("alignment"), dict) and direction == "end" else None
    inherited_source_frame_offset = None
    if direction == "end":
        parent_timeline_alignment = parent_settings.get("timelineAlignment") if isinstance(parent_settings.get("timelineAlignment"), dict) else {}
        inherited_source_frame_offset = int(
            parent_generation.get("sourceFrameOffset")
            or (inherited_alignment or {}).get("sourceFrameOffset")
            or parent_timeline_alignment.get("sourceFrameOffset")
            or 0
        )
    generation_settings = {
        **parent_settings,
        "workflow": "clip_lengthen",
        "provider": provider_name,
        "requestedModel": model_name,
        "model": used_provider_model or model_name,
        "mode": requested_mode,
        "inputMode": input_mode,
        "preserveFrames": preserve_frames,
        "selectedReferenceIds": selected_reference_ids,
        "selectedReferenceCount": len(selected_reference_ids),
        "requestedDurationSec": round(provider_duration_sec, 3),
        "providerDurationSec": provider_duration_sec,
        "providerInputTimingPolicy": provider_input_timing_policy,
        "mediaHasAudio": provider_media_has_audio,
        "providerInputTiming": (
            {
                "durationSec": round(float(provider_input_duration_sec or 0.0), 4),
                "fps": {"num": provider_media_fps.numerator, "den": provider_media_fps.denominator},
                "width": provider_media_width,
                "height": provider_media_height,
                "timingPolicy": provider_input_timing_policy,
            }
            if provider_media_fps and provider_media_width and provider_media_height
            else None
        ),
        "storedOutput": _video_timing_payload(stored_output_probe or {}),
        "providerOutputRaw": _video_timing_payload(raw_output_probe or {}),
        "timelineAlignment": inherited_alignment if direction == "end" else None,
        "timelineConform": timeline_conform,
        "clipLengthen": {
            "parentGenerationId": parent_generation_id,
            "direction": direction,
            "addedDurationSec": requested_added_duration_sec,
            "inputMode": input_mode,
            "providerModel": used_provider_model or model_name,
            "requestedPrompt": prompt,
        },
    }
    generation_updates = {
        "genId": gen_id,
        "segmentId": segment_id,
        "luma": {
            "provider": provider_name,
            "model": model_name,
            "mode": requested_mode,
            "prompt": prompt,
            "negativePrompt": payload.get("negativePrompt"),
            "lumaGenerationId": generation_id,
        },
        "status": "complete",
        "outputKey": paths.segment_generated(segment_id, gen_id),
        "posterKey": poster_key,
        "inputMediaKey": media_key_for_provider,
        "inputFirstFrameKey": None,
        "inputLastFrameKey": None,
        "sourceFirstFrameCaptureKey": parent_generation.get("sourceFirstFrameCaptureKey"),
        "sourceFirstFrameVariantId": parent_generation.get("sourceFirstFrameVariantId"),
        "sourceFirstFrameResolvedKey": parent_generation.get("sourceFirstFrameResolvedKey"),
        "sourceLastFrameCaptureKey": parent_generation.get("sourceLastFrameCaptureKey"),
        "sourceLastFrameVariantId": parent_generation.get("sourceLastFrameVariantId"),
        "sourceLastFrameResolvedKey": parent_generation.get("sourceLastFrameResolvedKey"),
        "requestedDurationSec": round(provider_duration_sec, 3),
        "providerDurationSec": provider_duration_sec,
        "sourceFrameOffset": inherited_source_frame_offset,
        "alignment": inherited_alignment if direction == "end" else None,
        "segmentCrop": parent_generation.get("segmentCrop") or segment.get("crop"),
        "generationSettings": generation_settings,
        "createdAt": gen_meta.get("createdAt") or now_iso(),
        "updatedAt": finished_at,
        "finishedAt": finished_at,
        "processingDurationSec": processing_duration_sec,
        "error": None,
        "parentGenerationId": parent_generation_id,
        "extension": clip_lengthen,
    }
    _record_usage(
        store=store,
        user_id=task["userId"],
        task=task,
        source="segment_generate_clip_lengthen",
        tool_origin="segment_generate_clip_lengthen",
        request_type="video_generation",
        provider=provider_name,
        provider_model=used_provider_model or model_name,
        app_model_id=model_name,
        target_record=generation_updates,
        segment_id=segment_id,
        asset_id=gen_id,
        asset_kind="segment_generation",
        duration_sec=provider_duration_sec,
        width=int(stored_output_probe.get("width") or 0) or None,
        height=int(stored_output_probe.get("height") or 0) or None,
        fps=(
            float(stored_output_probe.get("fps_num") or 0) / float(stored_output_probe.get("fps_den") or 1)
            if stored_output_probe.get("fps_num")
            else None
        ),
    )
    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates=generation_updates,
        history_entry={
            "at": finished_at,
            "event": "segment_generation.complete",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "segmentId": segment_id,
            "model": model_name,
            "outputKey": paths.segment_generated(segment_id, gen_id),
        },
    )
    job["resultRefs"] = {
        "genId": gen_id,
        "segmentId": segment_id,
        "outputKey": paths.segment_generated(segment_id, gen_id),
        "posterKey": poster_key,
        "provider": provider_name,
        "model": model_name,
        "mode": requested_mode,
        "providerGenerationId": generation_id,
        "finishedAt": gen_meta.get("finishedAt"),
        "processingDurationSec": processing_duration_sec,
    }
    _job_progress(job, store, 100, "complete", "Clip lengthen generation complete")
    store.save_job(job)
    return job


def _character_animate_model_label(model: str) -> str:
    if model == "runway_act_two":
        return "Runway Act-Two"
    if model == "kling_v3_motion_control":
        return "Kling 3.0 Motion Control"
    if model == "seedance_2_0_reference_to_video":
        return "ByteDance Seedance 2.0"
    if model == "omnihuman_v1_5":
        return "Bytedance OmniHuman v1.5"
    return model


def _previz_model_label(model: str) -> str:
    if model == "veo_3_1":
        return "Veo 3.1"
    if model == "happy_horse_1_0":
        return "Happy Horse 1.0"
    if model == "seedance_2_0":
        return "ByteDance Seedance 2.0"
    return model


def _previz_scene_dimensions(scene_aspect_ratio: str) -> tuple[int, int]:
    mapping = {
        "21:9": (1680, 720),
        "16:9": (1280, 720),
        "4:3": (1152, 864),
        "1:1": (1024, 1024),
        "3:4": (864, 1152),
        "9:16": (720, 1280),
    }
    return mapping.get(scene_aspect_ratio, mapping["16:9"])


def _build_previz_prompt_prefix(model_name: str, selected_frame_ids: list[str]) -> str:
    if model_name == "seedance_2_0":
        if len(selected_frame_ids) <= 1:
            return "@Image1 is the storyboard frame for the scene."
        if len(selected_frame_ids) == 2:
            return "@Image1 is the start frame and @Image2 is the end frame for the scene."
        key_count = len(selected_frame_ids) - 2
        key_label = "key frame" if key_count == 1 else "key frames"
        key_tokens = ", ".join(f"@Image{index}" for index in range(2, len(selected_frame_ids)))
        return f"@Image1 is the start frame. {key_tokens} are the {key_label}. @Image{len(selected_frame_ids)} is the end frame."
    if len(selected_frame_ids) <= 1:
        return "Animate the supplied storyboard frame into a coherent previz shot."
    if len(selected_frame_ids) == 2:
        return "Use the supplied storyboard frames as the start and end beats of the shot."
    return "Use the supplied storyboard frames as the ordered start, key, and end beats of the shot."


def _handle_previz_generate(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    metadata = payload.get("previzGenerateMetadata")
    if not isinstance(metadata, dict):
        raise RuntimeError("Previz generation metadata is missing")

    segment_id = str(payload.get("segmentId") or "")
    gen_id = str(payload.get("genId") or "")
    if not segment_id or not gen_id:
        raise RuntimeError("Previz generation job is missing segment or generation identifiers")

    segment = next((s for s in task.get("segments", []) if s.get("segmentId") == segment_id), None)
    if not isinstance(segment, dict):
        raise RuntimeError("Scene segment not found")

    model_name = str(metadata.get("model") or "")
    prompt = str(metadata.get("prompt") or "").strip()
    if not prompt:
        raise RuntimeError("Previz generation prompt is required")
    scene_aspect_ratio = str(metadata.get("sceneAspectRatio") or "16:9").strip() or "16:9"
    selected_frame_ids = [
        str(item or "").strip()
        for item in metadata.get("selectedFrameIds") or []
        if str(item or "").strip()
    ]
    if not selected_frame_ids:
        raise RuntimeError("Select at least one generated frame before generating previz video")
    duration_sec = int(metadata.get("durationSec") or 8)
    duration_sec = max(4, min(15, duration_sec))

    provider_name = "runware" if model_name == "veo_3_1" else "fal"
    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates={
            "genId": gen_id,
            "segmentId": segment_id,
            "status": "running",
            "jobId": job.get("jobId"),
            "error": None,
            "startedAt": now_iso(),
            "updatedAt": now_iso(),
        },
        history_entry={
            "at": now_iso(),
            "event": "previz_generation.running",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "segmentId": segment_id,
            "model": model_name,
        },
    )

    reference_lookup: dict[str, dict[str, Any]] = {
        str(item.get("referenceId")): item
        for item in task.get("editVideoReferences", [])
        if isinstance(item, dict) and item.get("referenceId")
    }
    selected_reference_records = [reference_lookup.get(reference_id) for reference_id in selected_frame_ids]
    selected_reference_records = [record for record in selected_reference_records if isinstance(record, dict)]
    if not selected_reference_records:
        raise RuntimeError("Selected Previz frames were not found")

    frame_keys = [str(record.get("key") or "").strip() for record in selected_reference_records if str(record.get("key") or "").strip()]
    if not frame_keys:
        raise RuntimeError("Selected Previz frames are missing image assets")

    first_frame_key = frame_keys[0]
    last_frame_key = frame_keys[-1]
    first_frame_url = asset_store.presign_get(first_frame_key, expires=3600)
    last_frame_url = asset_store.presign_get(last_frame_key, expires=3600)
    selected_frame_urls = [asset_store.presign_get(key, expires=3600) for key in frame_keys]

    output_width, output_height = _previz_scene_dimensions(scene_aspect_ratio)
    input_prompt_prefix = _build_previz_prompt_prefix(model_name, selected_frame_ids)
    provider_prompt = f"{input_prompt_prefix} {prompt}".strip()

    secrets = load_secret(settings.secrets_arn)
    out_url: str
    generation_id: str
    used_provider_model: str | None = None
    provider_duration_sec: float | None = float(duration_sec)
    out_key = _asset_paths(task).segment_generated(segment_id, gen_id)
    paths = _asset_paths(task)
    s3 = boto3.client("s3")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        if model_name == "veo_3_1":
            runware_key = secrets.get("RUNWARE_API_KEY")
            if not runware_key:
                raise RuntimeError("Veo 3.1 requires RUNWARE_API_KEY")
            _job_progress(job, store, 35, "running", "Creating Veo 3.1 previz generation")
            created = create_veo_first_last_generation(
                api_key=runware_key,
                model=RUNWARE_VEO_31_MODEL,
                start_image_url=first_frame_url,
                end_image_url=last_frame_url,
                duration_seconds=duration_sec,
                prompt=provider_prompt,
                width=output_width,
                height=output_height,
                generate_audio=False,
            )
            generation_id = str(created.get("taskUUID") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected Runware Veo create response: {created}")
            _job_progress(job, store, 55, "running", "Polling Veo 3.1 generation")
            result = _wait_runware_video_complete(runware_key, task_uuid=generation_id)
            out_url = _parse_runware_video_output_url(result)
            used_provider_model = RUNWARE_VEO_31_MODEL
        elif model_name == "happy_horse_1_0":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Happy Horse 1.0 requires FAL_API_KEY")
            _job_progress(job, store, 35, "running", "Creating Happy Horse 1.0 previz generation")
            created = submit_happy_horse_image_to_video(
                api_key=fal_api_key,
                input={
                    "image_url": first_frame_url,
                    "prompt": provider_prompt,
                    "resolution": "1080p",
                    "duration": duration_sec,
                    "enable_safety_checker": True,
                },
            )
            generation_id = str(created.get("request_id") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected Happy Horse image-to-video create response: {created}")
            _job_progress(job, store, 55, "running", "Polling Happy Horse 1.0 generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "alibaba/happy-horse/image-to-video"
        elif model_name == "seedance_2_0":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Seedance 2.0 requires FAL_API_KEY")
            _job_progress(job, store, 35, "running", "Creating Seedance 2.0 previz generation")
            created = submit_seedance_reference_to_video(
                api_key=fal_api_key,
                input={
                    "prompt": provider_prompt,
                    "image_urls": selected_frame_urls[:9],
                    "resolution": "720p",
                    "duration": str(duration_sec),
                    "aspect_ratio": scene_aspect_ratio if scene_aspect_ratio in {"auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"} else "16:9",
                    "generate_audio": False,
                    "end_user_id": task.get("userId"),
                },
            )
            generation_id = str(created.get("request_id") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected Seedance 2.0 create response: {created}")
            _job_progress(job, store, 55, "running", "Polling Seedance 2.0 generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "bytedance/seedance-2.0/reference-to-video"
        else:
            raise RuntimeError(f"Unsupported Previz model: {model_name}")

        _job_progress(job, store, 75, "running", "Downloading previz output to S3")
        downloaded_path = td_path / "provider_output.mp4"
        _download_url_to_path(out_url, downloaded_path)
        raw_output_probe = ffprobe_video(str(downloaded_path))

        needs_timeline_conform = _needs_timeline_conform(
            raw_output_probe,
            target_width=output_width,
            target_height=output_height,
            target_fps=Fraction(24, 1),
        )
        if needs_timeline_conform:
            _job_progress(job, store, 82, "running", "Conforming output to scene aspect ratio and frame rate")
            conformed_path = td_path / "provider_output_conformed.mp4"
            transcode_to_cfr(
                str(downloaded_path),
                str(conformed_path),
                Fraction(24, 1),
                target_width=output_width,
                target_height=output_height,
                crf=16,
                preset="medium",
            )
            _upload_s3(s3, settings.assets_bucket, out_key, conformed_path, "video/mp4")
            stored_output_probe = ffprobe_video(str(conformed_path))
            poster_source_path = conformed_path
        else:
            _upload_s3(s3, settings.assets_bucket, out_key, downloaded_path, "video/mp4")
            stored_output_probe = raw_output_probe
            poster_source_path = downloaded_path

        output_duration_value = float(stored_output_probe.get("duration_sec") or 0.0)
        if output_duration_value > 0:
            provider_duration_sec = round(output_duration_value, 3)
        finished_at = now_iso()
        processing_duration_sec = _processing_duration_seconds(gen_meta.get("startedAt"), finished_at)
        poster_key = _create_segment_generation_poster(
            asset_store=asset_store,
            paths=paths,
            segment_id=segment_id,
            gen_id=gen_id,
            video_path=str(poster_source_path),
        )
        generation_updates = {
            "genId": gen_id,
            "segmentId": segment_id,
            "luma": {
                "provider": provider_name,
                "model": model_name,
                "mode": "previz_frames",
                "prompt": prompt,
                "negativePrompt": None,
                "lumaGenerationId": generation_id,
            },
            "status": "complete",
            "outputKey": out_key,
            "posterKey": poster_key,
            "inputFirstFrameKey": first_frame_key,
            "inputLastFrameKey": last_frame_key if len(frame_keys) > 1 else None,
            "requestedDurationSec": round(float(duration_sec), 3),
            "providerDurationSec": provider_duration_sec,
            "generationSettings": {
                "workflowId": "simple_generation_workflow",
                "provider": provider_name,
                "requestedModel": model_name,
                "model": used_provider_model or model_name,
                "sceneAspectRatio": scene_aspect_ratio,
                "selectedFrameIds": selected_frame_ids,
                "selectedFrameCount": len(selected_frame_ids),
                "selectedReferenceIds": selected_frame_ids,
                "selectedReferenceCount": len(selected_frame_ids),
                "requestedDurationSec": round(float(duration_sec), 3),
                "scenePrompt": metadata.get("scenePrompt"),
                "storedOutput": _video_timing_payload(stored_output_probe or {}),
                "timelineConform": {
                    "policy": "scene_cfr_resolution",
                    "applied": needs_timeline_conform,
                    "durationDeltaSec": round(float(stored_output_probe.get("duration_sec") or 0.0) - float(duration_sec), 4),
                    "frameDelta": int(stored_output_probe.get("frame_count") or 0) - int(round(duration_sec * 24)),
                    "fpsConformed": True,
                    "resolutionConformed": needs_timeline_conform,
                },
            },
            "createdAt": gen_meta.get("createdAt") or now_iso(),
            "updatedAt": finished_at,
            "finishedAt": finished_at,
            "processingDurationSec": processing_duration_sec,
            "error": None,
        }
        _record_usage(
            store=store,
            user_id=task["userId"],
            task=task,
            source="previz_generate",
            tool_origin="previz_generate",
            request_type="video_generation",
            provider=provider_name,
            provider_model=used_provider_model or model_name,
            app_model_id=model_name,
            target_record=generation_updates,
            segment_id=segment_id,
            asset_id=gen_id,
            asset_kind="segment_generation",
            duration_sec=provider_duration_sec,
            width=int(stored_output_probe.get("width") or output_width or 0) or None,
            height=int(stored_output_probe.get("height") or output_height or 0) or None,
            fps=(
                float(stored_output_probe.get("fps_num") or 0) / float(stored_output_probe.get("fps_den") or 1)
                if stored_output_probe.get("fps_num")
                else 24.0
            ),
        )
        gen_meta = _update_segment_generation_record(
            store=store,
            user_id=task["userId"],
            task_id=task["taskId"],
            gen_id=gen_id,
            updates=generation_updates,
            history_entry={
                "at": finished_at,
                "event": "previz_generation.complete",
                "jobId": job.get("jobId"),
                "genId": gen_id,
                "segmentId": segment_id,
                "model": model_name,
                "outputKey": out_key,
            },
        )
        latest_task = store.load_task(task["userId"], task["taskId"])
        if isinstance(latest_task, dict):
            latest_segment = next(
                (
                    item
                    for item in latest_task.get("segments", [])
                    if isinstance(item, dict) and str(item.get("segmentId") or "") == segment_id
                ),
                None,
            )
            if isinstance(latest_segment, dict):
                latest_segment["selectedGenerationId"] = gen_id
                store.save_task(latest_task, merge_on_conflict=True)
        job["resultRefs"] = {
            "genId": gen_id,
            "segmentId": segment_id,
            "outputKey": out_key,
            "posterKey": poster_key,
            "provider": provider_name,
            "model": model_name,
            "mode": "previz_frames",
            "providerGenerationId": generation_id,
            "finishedAt": gen_meta.get("finishedAt"),
            "processingDurationSec": processing_duration_sec,
        }
        _job_progress(job, store, 100, "complete", "Previz generation complete")
        store.save_job(job)
        return job


def _handle_segment_generate_character_animate(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    metadata = payload.get("characterAnimateMetadata")
    if not isinstance(metadata, dict):
        raise RuntimeError("Character animation metadata is missing")
    segment_id = str(payload.get("segmentId") or "")
    gen_id = str(payload.get("genId") or "")
    if not segment_id or not gen_id:
        raise RuntimeError("Character animation job is missing segment or generation identifiers")
    segment = next((s for s in task.get("segments", []) if s.get("segmentId") == segment_id), None)
    if not isinstance(segment, dict):
        raise RuntimeError("Segment not found")

    model_name = str(metadata.get("model") or payload.get("lumaModel") or "")
    mode = str(metadata.get("mode") or payload.get("mode") or "")
    character_reference_id = str(metadata.get("characterReferenceId") or "").strip()
    prompt = str(metadata.get("prompt") or payload.get("prompt") or "").strip() or None
    output_aspect_ratio = str(metadata.get("outputAspectRatio") or "1280:720")
    omnihuman_resolution = str(metadata.get("omnihumanResolution") or "720p")
    kling_mode = str(metadata.get("klingMode") or "pro")
    kling_character_orientation = str(metadata.get("klingCharacterOrientation") or "image")
    seedance_resolution = str(metadata.get("seedanceResolution") or "720p")
    seedance_aspect_ratio = str(metadata.get("seedanceAspectRatio") or "auto")
    body_control = bool(metadata.get("bodyControl", True))
    expression_intensity = int(metadata.get("expressionIntensity") or 3)

    if model_name == "runway_act_two":
        provider_name = "runway"
    elif model_name == "kling_v3_motion_control":
        provider_name = "replicate"
    else:
        provider_name = "fal"
    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates={
            "genId": gen_id,
            "segmentId": segment_id,
            "status": "running",
            "jobId": job.get("jobId"),
            "error": None,
            "startedAt": now_iso(),
            "updatedAt": now_iso(),
        },
        history_entry={
            "at": now_iso(),
            "event": "character_animation.running",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "segmentId": segment_id,
            "model": model_name,
            "mode": mode,
        },
    )

    reference_lookup: dict[str, dict[str, Any]] = {
        str(item.get("referenceId")): item
        for item in task.get("editVideoReferences", [])
        if isinstance(item, dict) and item.get("referenceId")
    }
    reference_record = reference_lookup.get(character_reference_id)
    character_key = str((reference_record or {}).get("key") or "").strip()
    if not character_key:
        raise RuntimeError("Character image not found")

    paths = _asset_paths(task)
    s3 = boto3.client("s3")
    source_segment_key = _ensure_segment_clip(
        s3=s3,
        asset_store=asset_store,
        asset_paths=paths,
        task=task,
        segment=segment,
        assets_bucket=settings.assets_bucket,
    )
    source_segment_url = asset_store.presign_get(source_segment_key, expires=3600)
    character_image_url = asset_store.presign_get(character_key, expires=3600)
    input_audio_key: str | None = None
    used_provider_model: str | None = None
    provider_duration_sec: float | None = None
    out_url: str
    generation_id: str
    source_probe: dict[str, Any] | None = None
    source_media_kind = str(task.get("sourceMedia", {}).get("kind") or task.get("video", {}).get("editSource", {}).get("mediaType") or "video")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        local_segment = td_path / ("segment.wav" if source_media_kind == "audio" else "segment.mp4")
        _download_s3(s3, settings.assets_bucket, source_segment_key, local_segment)
        if source_media_kind == "audio":
            audio_probe = ffprobe_audio(str(local_segment))
            provider_duration_sec = round(float(audio_probe.get("duration_sec") or segment.get("durationSec") or 0.0), 3)
            source_probe = {
                "duration_sec": provider_duration_sec,
                "has_audio": True,
                "frame_count": int(segment.get("durationFrames") or 0),
                "fps_num": int(task.get("video", {}).get("editSource", {}).get("fps", {}).get("num") or 100),
                "fps_den": int(task.get("video", {}).get("editSource", {}).get("fps", {}).get("den") or 1),
            }
        else:
            source_probe = ffprobe_video(str(local_segment))
            provider_duration_sec = round(float(source_probe.get("duration_sec") or segment.get("durationSec") or 0.0), 3)

        secrets = load_secret(settings.secrets_arn)
        if model_name == "runway_act_two":
            runway_key = secrets["RUNWAY_API_KEY"]
            _job_progress(job, store, 35, "running", "Creating Runway Act-Two character animation")
            created = create_character_performance(
                api_key=runway_key,
                character_uri=character_image_url,
                character_type="image",
                reference_video_uri=source_segment_url,
                ratio=output_aspect_ratio,
                body_control=body_control,
                expression_intensity=expression_intensity,
            )
            generation_id = str(created.get("id") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected Runway Act-Two create response: {created}")
            _job_progress(job, store, 55, "running", "Polling Runway Act-Two generation")
            result = _wait_runway_complete(runway_key, generation_id)
            out_url = _parse_runway_output_url(result)
            used_provider_model = "act_two"
        elif model_name == "kling_v3_motion_control":
            replicate_key = secrets.get("REPLICATE_API_KEY")
            if not replicate_key:
                raise RuntimeError("Kling 3.0 Motion Control requires REPLICATE_API_KEY")
            if not source_segment_url:
                raise RuntimeError("Kling 3.0 Motion Control requires a prepared source video")
            _job_progress(job, store, 35, "running", "Creating Kling 3.0 Motion Control animation")
            created = create_replicate_official_model_prediction(
                api_key=replicate_key,
                owner="kwaivgi",
                name="kling-v3-motion-control",
                input={
                    "prompt": prompt or "",
                    "image": character_image_url,
                    "video": source_segment_url,
                    "keep_original_sound": True,
                    "character_orientation": kling_character_orientation if kling_character_orientation in {"image", "video"} else "image",
                    "mode": kling_mode if kling_mode in {"std", "pro"} else "pro",
                },
            )
            generation_id = str(created.get("id") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected Kling 3.0 Motion Control create response: {created}")
            _job_progress(job, store, 55, "running", "Polling Kling 3.0 Motion Control generation")
            result = _wait_replicate_complete(replicate_key, prediction_id=generation_id)
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "kwaivgi/kling-v3-motion-control"
        elif model_name == "seedance_2_0_reference_to_video":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("Seedance 2.0 Reference to Video requires FAL_API_KEY")
            seedance_prompt_prefix = (
                "@Image1 is the character reference. @Video1 provides the motion reference."
                if mode == "pose_video"
                else "@Image1 is the character reference. @Audio1 drives the character performance."
            )
            input_payload: dict[str, Any] = {
                "prompt": f"{seedance_prompt_prefix} {prompt}".strip() if prompt else seedance_prompt_prefix,
                "image_urls": [character_image_url],
                "resolution": seedance_resolution if seedance_resolution in {"480p", "720p", "1080p"} else "720p",
                "duration": "auto",
                "aspect_ratio": seedance_aspect_ratio if seedance_aspect_ratio in {"auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"} else "auto",
                "generate_audio": mode == "audio_driven",
                "end_user_id": task.get("userId"),
            }
            if mode == "pose_video":
                if not source_segment_url:
                    raise RuntimeError("Seedance 2.0 pose-video mode requires a prepared source video")
                input_payload["video_urls"] = [source_segment_url]
            else:
                if source_media_kind == "audio":
                    local_audio = td_path / "segment_audio.mp3"
                    extract_audio_track(str(local_segment), str(local_audio))
                else:
                    if not bool(source_probe.get("has_audio")):
                        raise RuntimeError("Seedance 2.0 audio-driven mode requires the selected source range to contain audio")
                    local_audio = td_path / "segment_audio.mp3"
                    extract_audio_track(str(local_segment), str(local_audio))
                input_audio_key = paths.segment_provider_audio(segment_id, gen_id, "fal", ".mp3")
                _upload_s3(s3, settings.assets_bucket, input_audio_key, local_audio, "audio/mpeg")
                audio_url = asset_store.presign_get(input_audio_key, expires=3600)
                input_payload["audio_urls"] = [audio_url]
            _job_progress(job, store, 35, "running", "Creating Seedance 2.0 character animation")
            created = submit_seedance_reference_to_video(api_key=fal_api_key, input=input_payload)
            generation_id = str(created.get("request_id") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected Seedance 2.0 create response: {created}")
            _job_progress(job, store, 55, "running", "Polling Seedance 2.0 character animation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "bytedance/seedance-2.0/reference-to-video"
        elif model_name == "omnihuman_v1_5":
            fal_api_key = secrets.get("FAL_API_KEY")
            if not fal_api_key:
                raise RuntimeError("OmniHuman v1.5 requires FAL_API_KEY")
            if source_media_kind == "audio":
                local_audio = td_path / "segment_audio.mp3"
                extract_audio_track(str(local_segment), str(local_audio))
            else:
                if not bool(source_probe.get("has_audio")):
                    raise RuntimeError("OmniHuman v1.5 requires the selected source range to contain audio")
                local_audio = td_path / "segment_audio.mp3"
                extract_audio_track(str(local_segment), str(local_audio))
            input_audio_key = paths.segment_provider_audio(segment_id, gen_id, "fal", ".mp3")
            _upload_s3(s3, settings.assets_bucket, input_audio_key, local_audio, "audio/mpeg")
            audio_url = asset_store.presign_get(input_audio_key, expires=3600)
            _job_progress(job, store, 35, "running", "Creating OmniHuman v1.5 character animation")
            created = submit_omnihuman_v15(
                api_key=fal_api_key,
                input={
                    "image_url": character_image_url,
                    "audio_url": audio_url,
                    "prompt": prompt,
                    "resolution": omnihuman_resolution if omnihuman_resolution in {"720p", "1080p"} else "720p",
                },
            )
            generation_id = str(created.get("request_id") or "")
            if not generation_id:
                raise RuntimeError(f"Unexpected OmniHuman v1.5 create response: {created}")
            _job_progress(job, store, 55, "running", "Polling OmniHuman v1.5 generation")
            result = _wait_fal_queue_complete(fal_api_key, created=created)
            out_url = _parse_fal_video_output_url(result)
            used_provider_model = "fal-ai/bytedance/omnihuman/v1.5"
        else:
            raise RuntimeError(f"Unsupported character animation model: {model_name}")

        out_key = paths.segment_generated(segment_id, gen_id)
        _job_progress(job, store, 75, "running", "Downloading character animation output to S3")
        downloaded_path = td_path / "provider_output.mp4"
        _download_url_to_path(out_url, downloaded_path)
        raw_output_probe = ffprobe_video(str(downloaded_path))
        _upload_s3(s3, settings.assets_bucket, out_key, downloaded_path, "video/mp4")
        stored_output_probe = raw_output_probe
        output_duration_value = float(stored_output_probe.get("duration_sec") or 0.0)
        if output_duration_value > 0:
            provider_duration_sec = round(output_duration_value, 3)
        finished_at = now_iso()
        processing_duration_sec = _processing_duration_seconds(gen_meta.get("startedAt"), finished_at)
        poster_key = _create_segment_generation_poster(
            asset_store=asset_store,
            paths=paths,
            segment_id=segment_id,
            gen_id=gen_id,
            video_path=str(downloaded_path),
        )
        generation_updates = {
            "genId": gen_id,
            "segmentId": segment_id,
            "luma": {
                "provider": provider_name,
                "model": model_name,
                "mode": mode,
                "prompt": prompt,
                "negativePrompt": None,
                "lumaGenerationId": generation_id,
            },
            "characterAnimation": {
                "workflowId": str(task.get("workflowId") or "character_animate_workflow"),
                "mode": mode,
                "model": model_name,
                "modelLabel": _character_animate_model_label(model_name),
                "characterReferenceId": character_reference_id,
                "outputAspectRatio": output_aspect_ratio if mode == "pose_video" else None,
                "omnihumanResolution": omnihuman_resolution if mode == "audio_driven" else None,
                "klingMode": kling_mode if model_name == "kling_v3_motion_control" else None,
                "klingCharacterOrientation": kling_character_orientation if model_name == "kling_v3_motion_control" else None,
                "seedanceResolution": seedance_resolution if model_name == "seedance_2_0_reference_to_video" else None,
                "seedanceAspectRatio": seedance_aspect_ratio if model_name == "seedance_2_0_reference_to_video" else None,
                "bodyControl": body_control if mode == "pose_video" else None,
                "expressionIntensity": expression_intensity if mode == "pose_video" else None,
                "prompt": prompt,
            },
            "status": "complete",
            "outputKey": out_key,
            "posterKey": poster_key,
            "inputMediaKey": source_segment_key,
            "inputFirstFrameKey": character_key,
            "inputAudioKey": input_audio_key,
            "requestedDurationSec": round(float(segment.get("durationSec") or 0.0), 3),
            "providerDurationSec": provider_duration_sec,
            "generationSettings": {
                "workflowId": str(task.get("workflowId") or "character_animate_workflow"),
                "provider": provider_name,
                "requestedModel": model_name,
                "model": used_provider_model or model_name,
                "characterMode": mode,
                "characterReferenceId": character_reference_id,
                "outputAspectRatio": output_aspect_ratio if mode == "pose_video" else None,
                "omnihumanResolution": omnihuman_resolution if mode == "audio_driven" else None,
                "klingMode": kling_mode if model_name == "kling_v3_motion_control" else None,
                "klingCharacterOrientation": kling_character_orientation if model_name == "kling_v3_motion_control" else None,
                "seedanceResolution": seedance_resolution if model_name == "seedance_2_0_reference_to_video" else None,
                "seedanceAspectRatio": seedance_aspect_ratio if model_name == "seedance_2_0_reference_to_video" else None,
                "bodyControl": body_control if mode == "pose_video" else None,
                "expressionIntensity": expression_intensity if mode == "pose_video" else None,
                "requestedDurationSec": round(float(segment.get("durationSec") or 0.0), 3),
                "providerDurationSec": provider_duration_sec,
                "sourceSegmentTiming": {
                    "startFrame": int(segment.get("startFrame") or 0),
                    "endFrameExclusive": int(segment.get("endFrameExclusive") or 0),
                    "durationFrames": int(segment.get("durationFrames") or 0),
                    "durationSec": round(float(segment.get("durationSec") or 0.0), 4),
                },
                "providerOutputRaw": _video_timing_payload(raw_output_probe or {}),
                "storedOutput": _video_timing_payload(stored_output_probe or {}),
            },
            "createdAt": gen_meta.get("createdAt") or now_iso(),
            "updatedAt": finished_at,
            "finishedAt": finished_at,
            "processingDurationSec": processing_duration_sec,
            "error": None,
        }
        _record_usage(
            store=store,
            user_id=task["userId"],
            task=task,
            source="character_animation_generate",
            tool_origin="segment_generate_character_animate",
            request_type="video_generation",
            provider=provider_name,
            provider_model=used_provider_model or model_name,
            app_model_id=model_name,
            target_record=generation_updates,
            segment_id=segment_id,
            asset_id=gen_id,
            asset_kind="segment_generation",
            duration_sec=provider_duration_sec,
            width=int(stored_output_probe.get("width") or 0) or None,
            height=int(stored_output_probe.get("height") or 0) or None,
            fps=(
                float(stored_output_probe.get("fps_num") or 0) / float(stored_output_probe.get("fps_den") or 1)
                if stored_output_probe.get("fps_num")
                else None
            ),
            resolution_label=(
                seedance_resolution if model_name == "seedance_2_0_reference_to_video" else omnihuman_resolution if model_name == "omnihuman_v1_5" else "1080p"
            ),
        )
        gen_meta = _update_segment_generation_record(
            store=store,
            user_id=task["userId"],
            task_id=task["taskId"],
            gen_id=gen_id,
            updates=generation_updates,
            history_entry={
                "at": finished_at,
                "event": "character_animation.complete",
                "jobId": job.get("jobId"),
                "genId": gen_id,
                "segmentId": segment_id,
                "model": model_name,
                "outputKey": out_key,
            },
        )
        job["resultRefs"] = {
            "genId": gen_id,
            "segmentId": segment_id,
            "outputKey": out_key,
            "posterKey": poster_key,
            "provider": provider_name,
            "model": model_name,
            "mode": mode,
            "providerGenerationId": generation_id,
            "finishedAt": gen_meta.get("finishedAt"),
            "processingDurationSec": processing_duration_sec,
        }
    _job_progress(job, store, 100, "complete", "Character animation complete")
    return job


def _handle_segment_generate(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    character_animate_metadata = payload.get("characterAnimateMetadata")
    if isinstance(character_animate_metadata, dict):
        return _handle_segment_generate_character_animate(
            job=job,
            store=store,
            asset_store=asset_store,
            task=task,
            settings=settings,
        )
    clip_lengthen_metadata = payload.get("clipLengthenMetadata")
    if isinstance(clip_lengthen_metadata, dict):
        return _handle_segment_generate_clip_lengthen(
            job=job,
            store=store,
            asset_store=asset_store,
            task=task,
            settings=settings,
        )
    payload = job["payload"]
    segment_id = payload["segmentId"]
    gen_id = payload["genId"]
    segment = next(s for s in task["segments"] if s["segmentId"] == segment_id)
    segment_duration_sec = float(segment.get("durationSec") or 0)

    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates={
            "genId": gen_id,
            "segmentId": segment_id,
            "status": "running",
            "jobId": job.get("jobId"),
            "error": None,
            "startedAt": now_iso(),
            "updatedAt": now_iso(),
        },
        history_entry={
            "at": now_iso(),
            "event": "segment_generation.running",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "segmentId": segment_id,
            "model": payload.get("lumaModel"),
        },
    )

    paths = _asset_paths(task)
    s3 = boto3.client("s3")
    model_name = payload["lumaModel"]
    capability = get_video_model_capability(model_name)
    requested_mode = payload["mode"]
    luma_mode = requested_mode if requested_mode in LUMA_API_ALLOWED_MODES else "flex_1"
    uses_end_keyframe = requested_mode in {"kling_start_end", "veo_start_end", "wan27_i2v_start_end", "ltx23_i2v_start_end"}
    replicate_kling_mode = str(payload.get("replicateKlingMode") or "pro")
    replicate_kling_v3_mode = str(payload.get("replicateKlingV3Mode") or "pro")
    wan27_resolution = str(payload.get("wan27Resolution") or "720p")
    happy_horse_resolution = str(payload.get("happyHorseResolution") or "1080p")
    wan27_negative_prompt = str(payload.get("negativePrompt") or "").strip() or None
    preserve_frames = bool(payload.get("preserveFrames", True))
    reference_prefix = f"users/{task['userId']}/tasks/{task['taskId']}/"
    reference_lookup: dict[str, dict[str, Any]] = {
        str(item.get("referenceId")): item
        for item in task.get("editVideoReferences", [])
        if isinstance(item, dict) and item.get("referenceId")
    }
    raw_selected_reference_ids = payload.get("selectedReferenceIds")
    selected_reference_ids: list[str] = []
    if isinstance(raw_selected_reference_ids, list):
        for item in raw_selected_reference_ids:
            ref_id = str(item or "").strip()
            if ref_id and ref_id not in selected_reference_ids:
                selected_reference_ids.append(ref_id)
    selected_reference_keys: list[str] = []
    for ref_id in selected_reference_ids:
        reference = reference_lookup.get(ref_id)
        key = str((reference or {}).get("key") or "").strip()
        if key and key.startswith(reference_prefix):
            selected_reference_keys.append(key)
    generation_audio_reference = task.get("generationAudioReference") if isinstance(task.get("generationAudioReference"), dict) else None
    selected_audio_reference_id = str(payload.get("audioReferenceId") or "").strip()
    selected_audio_reference = (
        generation_audio_reference
        if generation_audio_reference and str(generation_audio_reference.get("referenceId") or "").strip() == selected_audio_reference_id
        else None
    )
    selected_audio_reference_key = (
        str(selected_audio_reference.get("editSourceKey") or selected_audio_reference.get("originalKey") or "").strip()
        if selected_audio_reference
        else ""
    )
    segment_key: str | None = None
    if capability.uses_source_video:
        segment_key = _ensure_segment_clip(
            s3=s3,
            asset_store=asset_store,
            asset_paths=paths,
            task=task,
            segment=segment,
            assets_bucket=settings.assets_bucket,
        )

    start_frame_id = segment["startFrameId"]
    start_frame = task["frames"][start_frame_id]
    first_frame_key = start_frame["captureKey"]
    variant_id = payload.get("firstFrameVariantId") or start_frame.get("selectedVariantId")
    source_first_variant_id: str | None = None
    if variant_id:
        variant = next((v for v in start_frame.get("variants", []) if v["variantId"] == variant_id), None)
        if variant:
            first_frame_key = variant["outputKey"]
            source_first_variant_id = variant_id

    end_frame_id = segment["endFrameId"]
    end_frame = task["frames"][end_frame_id]
    last_frame_key = end_frame["captureKey"]
    end_variant_id = payload.get("lastFrameVariantId") or end_frame.get("selectedVariantId")
    source_last_variant_id: str | None = None
    if end_variant_id:
        end_variant = next((v for v in end_frame.get("variants", []) if v["variantId"] == end_variant_id), None)
        if end_variant:
            last_frame_key = end_variant["outputKey"]
            source_last_variant_id = end_variant_id
    if model_name in {"kling-2.6", "veo-3.1", "veo-3.1-fast", "wan2.7-i2v", "ltx-2.3-pro"} and not uses_end_keyframe:
        last_frame_key = first_frame_key
        source_last_variant_id = None

    fps_info = task["video"]["editSource"]["fps"]
    fps = Fraction(int(fps_info["num"]), int(fps_info["den"]))
    src_width = int(task["video"]["editSource"]["width"])
    src_height = int(task["video"]["editSource"]["height"])

    media_key_for_provider: str | None = None
    first_frame_input_key: str | None = None
    last_frame_input_key: str | None = None
    first_frame_content_type: str | None = None
    last_frame_content_type: str | None = None
    provider_media_width: int | None = None
    provider_media_height: int | None = None
    provider_media_has_audio: bool | None = None
    provider_media_fps: Fraction | None = None
    provider_input_timing_policy = "source_fps"
    provider_input_duration_sec = round(float(segment.get("durationSec") or 0.0), 3)
    local_provider_segment: Path | None = None
    runway_video_uri: str | None = None
    runway_first_frame_uri: str | None = None
    wan27_reference_transport: str | None = None
    wan27_video_transport: str | None = None
    ltx23_reference_transport: str | None = None
    wan27_video_data_url: str | None = None
    sora2_resolution = str(payload.get("sora2Resolution") or "auto")
    sora2_requested_duration_sec: float | None = None
    sora2_provider_duration_sec: float | None = None
    replicate_aspect_ratio: str | None = None
    seedance_aspect_ratio: str | None = None
    wan27_aspect_ratio: str | None = None
    ltx23_aspect_ratio: str | None = None
    seedance_requested_duration_sec: float | None = None
    ltx23_requested_duration_sec: float | None = None
    ltx23_requested_fps: int | None = None
    source_segment_width: int | None = None
    source_segment_height: int | None = None
    seedance_raw_output_width: int | None = None
    seedance_raw_output_height: int | None = None
    seedance_output_width: int | None = None
    seedance_output_height: int | None = None
    input_audio_key: str | None = selected_audio_reference_key or None
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        if segment_key:
            local_segment_source = td_path / "segment_full.mp4"
            _download_s3(s3, settings.assets_bucket, segment_key, local_segment_source)
            segment_source_probe = ffprobe_video(str(local_segment_source))
            segment_src_width = int(segment_source_probe.get("width") or src_width)
            segment_src_height = int(segment_source_probe.get("height") or src_height)
            source_segment_width = segment_src_width
            source_segment_height = segment_src_height
            provider_media_has_audio = bool(segment_source_probe.get("has_audio"))
            source_size = local_segment_source.stat().st_size
            if capability.source_video_profile == "kling_edit":
                replicate_aspect_ratio = _nearest_allowed_aspect_ratio(
                    segment_src_width,
                    segment_src_height,
                    allowed=("16:9", "9:16", "1:1", "4:3", "3:4") if model_name == "kling-v3-omni-video" else ("16:9", "9:16", "1:1"),
                )
                kling_mode = replicate_kling_v3_mode if model_name == "kling-v3-omni-video" else replicate_kling_mode
                kling_long_edge = 1920 if kling_mode == "pro" else 1280
                kling_square_edge = 1080 if kling_mode == "pro" else 720
                target_w, target_h = _dimensions_for_aspect_ratio(
                    replicate_aspect_ratio,
                    long_edge=kling_long_edge,
                    square_edge=kling_square_edge,
                )
                kling_label = "Kling v3 Omni Video" if model_name == "kling-v3-omni-video" else "Kling O1 Edit"
                _job_progress(job, store, 20, "running", f"Preparing segment clip for {kling_label}")
                local_provider_segment = td_path / ("segment_kling_v3_omni.mp4" if model_name == "kling-v3-omni-video" else "segment_kling_o1.mp4")
                provider_media_width, provider_media_height, _ = _transcode_exact_with_size_limit(
                    input_path=str(local_segment_source),
                    output_path=str(local_provider_segment),
                    fps=fps,
                    source_fps=fps,
                    preserve_frame_count=False,
                    target_width=target_w,
                    target_height=target_h,
                    resize_mode="crop",
                    max_bytes=REPLICATE_VIDEO_MAX_BYTES,
                )
                provider_media_fps = fps
                provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or float(segment.get("durationSec") or 0.0)), 3)
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "replicate")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            elif capability.source_video_profile == "seedance_reference":
                seedance_aspect_ratio = _nearest_allowed_aspect_ratio(
                    segment_src_width,
                    segment_src_height,
                    allowed=("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"),
                )
                target_w, target_h = _dimensions_for_aspect_ratio_within_box(
                    seedance_aspect_ratio,
                    landscape_box=(1112, 834),
                    portrait_box=(834, 1112),
                    square_edge=834,
                )
                _job_progress(job, store, 20, "running", "Preparing segment clip for Seedance 2.0")
                local_provider_segment = td_path / "segment_seedance.mp4"
                provider_media_width, provider_media_height, _ = _transcode_exact_with_size_limit(
                    input_path=str(local_segment_source),
                    output_path=str(local_provider_segment),
                    fps=fps,
                    source_fps=fps,
                    preserve_frame_count=False,
                    target_width=target_w,
                    target_height=target_h,
                    resize_mode="crop",
                    max_bytes=SEEDANCE_REFERENCE_VIDEO_MAX_BYTES,
                )
                provider_media_fps = fps
                provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or float(segment.get("durationSec") or 0.0)), 3)
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "fal")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            elif capability.source_video_profile == "wan27_edit":
                wan_edge = 1080 if wan27_resolution == "1080p" else 720
                wan27_aspect_ratio = _nearest_allowed_aspect_ratio(
                    segment_src_width,
                    segment_src_height,
                    allowed=("16:9", "9:16", "1:1", "4:3", "3:4"),
                )
                target_w, target_h = _dimensions_for_aspect_ratio(
                    wan27_aspect_ratio,
                    long_edge=1920 if wan27_resolution == "1080p" else 1280,
                    square_edge=wan_edge,
                )
                wan_provider_fps, provider_input_timing_policy = _resolved_provider_fps(
                    model_name=model_name,
                    source_fps=fps,
                    preserve_frames=preserve_frames,
                )
                _job_progress(job, store, 20, "running", "Preparing segment clip for Wan 2.7 VideoEdit")
                local_provider_segment = td_path / "segment_wan27_data_url.mp4"
                wan27_video_data_url, _ = _prepare_replicate_video_data_url(
                    input_path=str(local_segment_source),
                    output_path=str(local_provider_segment),
                    fps=wan_provider_fps,
                    source_fps=fps,
                    preserve_frame_count=preserve_frames,
                    target_width=target_w,
                    target_height=target_h,
                    resize_mode="crop",
                    max_bytes=WAN27_DATA_URL_MAX_BYTES,
                )
                provider_media_width = target_w
                provider_media_height = target_h
                provider_media_fps = wan_provider_fps
                provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or float(segment.get("durationSec") or 0.0)), 3)
                wan27_video_transport = "data_url"
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "replicate")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            elif source_size > FULL_VIDEO_MAX_BYTES:
                _job_progress(job, store, 20, "running", "Optimizing segment clip to provider size limits")
                local_provider_segment = td_path / "segment_luma.mp4"
                luma_w, luma_h, _ = _transcode_with_size_limit(
                    input_path=str(local_segment_source),
                    output_path=str(local_provider_segment),
                    fps=fps,
                    source_width=segment_src_width,
                    source_height=segment_src_height,
                    landscape_target=(1920, 1080),
                    portrait_target=(1080, 1920),
                    resize_mode="scale",
                    max_bytes=FULL_VIDEO_MAX_BYTES,
                )
                provider_media_width = luma_w
                provider_media_height = luma_h
                provider_media_fps = fps
                provider_input_duration_sec = round(float(ffprobe_video(str(local_provider_segment)).get("duration_sec") or float(segment.get("durationSec") or 0.0)), 3)
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "luma")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            else:
                media_key_for_provider = segment_key
                provider_media_width = segment_src_width
                provider_media_height = segment_src_height
                provider_media_fps = fps
                provider_input_duration_sec = round(float(segment.get("durationSec") or 0.0), 3)

        frame_bytes = asset_store.read_bytes(first_frame_key)
        with Image.open(BytesIO(frame_bytes)) as first_image_probe:
            first_source_width, first_source_height = first_image_probe.size
        first_frame_fit_mode = "contain"
        if capability.first_frame_profile == "runware_wan22":
            first_target_w, first_target_h = _nearest_runware_wan22_resolution(first_source_width, first_source_height)
        elif capability.first_frame_profile == "sora_i2v":
            sora_edge = 1920 if sora2_resolution == "1080p" else 1280
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(sora_edge, int(round(sora_edge * 9 / 16))),
                portrait=(int(round(sora_edge * 9 / 16)), sora_edge),
            )
        elif capability.first_frame_profile == "happy_horse_reference":
            happy_horse_long_edge = 1920 if happy_horse_resolution == "1080p" else 1280
            first_target_w, first_target_h = _target_preserving_aspect_long_edge(
                first_source_width,
                first_source_height,
                long_edge=happy_horse_long_edge,
            )
        elif capability.first_frame_profile == "kling_edit":
            first_frame_fit_mode = "cover"
            if not replicate_aspect_ratio:
                replicate_aspect_ratio = _nearest_allowed_aspect_ratio(
                    first_source_width,
                    first_source_height,
                    allowed=("16:9", "9:16", "1:1", "4:3", "3:4") if model_name == "kling-v3-omni-video" else ("16:9", "9:16", "1:1"),
                )
            kling_mode = replicate_kling_v3_mode if model_name == "kling-v3-omni-video" else replicate_kling_mode
            kling_long_edge = 1920 if kling_mode == "pro" else 1280
            kling_square_edge = 1080 if kling_mode == "pro" else 720
            first_target_w, first_target_h = _dimensions_for_aspect_ratio(
                replicate_aspect_ratio,
                long_edge=kling_long_edge,
                square_edge=kling_square_edge,
            )
        elif capability.first_frame_profile == "wan27_edit":
            first_frame_fit_mode = "cover"
            wan_edge = 1080 if wan27_resolution == "1080p" else 720
            if not wan27_aspect_ratio:
                wan27_aspect_ratio = _nearest_allowed_aspect_ratio(
                    first_source_width,
                    first_source_height,
                    allowed=("16:9", "9:16", "1:1", "4:3", "3:4"),
                )
            first_target_w, first_target_h = _dimensions_for_aspect_ratio(
                wan27_aspect_ratio,
                long_edge=1920 if wan27_resolution == "1080p" else 1280,
                square_edge=wan_edge,
            )
        elif capability.first_frame_profile == "seedance_reference":
            first_frame_fit_mode = "cover"
            if not seedance_aspect_ratio:
                seedance_aspect_ratio = _nearest_allowed_aspect_ratio(
                    first_source_width,
                    first_source_height,
                    allowed=("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"),
                )
            first_target_w, first_target_h = _dimensions_for_aspect_ratio_within_box(
                seedance_aspect_ratio,
                landscape_box=(1112, 834),
                portrait_box=(834, 1112),
                square_edge=834,
            )
        elif capability.first_frame_profile == "runway_aleph":
            first_target_w, first_target_h = _nearest_runway_aleph_resolution(first_source_width, first_source_height)
        elif capability.first_frame_profile == "runway_standard_720":
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1280, 720),
                portrait=(720, 1280),
            )
        elif capability.first_frame_profile == "ltx23_i2v":
            ltx23_aspect_ratio = _nearest_allowed_aspect_ratio(
                first_source_width,
                first_source_height,
                allowed=("16:9", "9:16"),
            )
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1920, 1080),
                portrait=(1080, 1920),
            )
        else:
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1920, 1080),
                portrait=(1080, 1920),
            )
        prepared_first_frame, first_frame_content_type, first_frame_ext = _prepare_first_frame_image_payload(
            frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            max_bytes=MAX_PROVIDER_IMAGE_BYTES,
            fit_mode=first_frame_fit_mode,
        )
        local_first_frame = td_path / f"first_frame{first_frame_ext}"
        local_first_frame.write_bytes(prepared_first_frame)
        provider_input_namespace = capability.provider_input_namespace or capability.provider
        first_frame_input_key = paths.segment_provider_first_frame(
            segment_id,
            gen_id,
            provider_input_namespace,
            ext=first_frame_ext,
        )
        _upload_s3(s3, settings.assets_bucket, first_frame_input_key, local_first_frame, first_frame_content_type)

        if model_name in {"kling-2.6", "veo-3.1", "veo-3.1-fast", "wan2.7-i2v", "ltx-2.3-pro"} and uses_end_keyframe:
            last_frame_bytes = asset_store.read_bytes(last_frame_key)
            prepared_last_frame, last_frame_content_type, last_frame_ext = _prepare_first_frame_image_payload(
                last_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                max_bytes=MAX_PROVIDER_IMAGE_BYTES,
                fit_mode=first_frame_fit_mode,
            )
            local_last_frame = td_path / f"last_frame{last_frame_ext}"
            local_last_frame.write_bytes(prepared_last_frame)
            last_frame_input_key = paths.segment_provider_last_frame(
                segment_id,
                gen_id,
                "kling" if model_name == "kling-2.6" else ("replicate" if model_name in {"wan2.7-i2v", "ltx-2.3-pro"} else "runware"),
                ext=last_frame_ext,
            )
            _upload_s3(s3, settings.assets_bucket, last_frame_input_key, local_last_frame, last_frame_content_type)

        if model_name == "runway-gen4-aleph":
            runway_key = load_secret(settings.secrets_arn)["RUNWAY_API_KEY"]
            runway_video_uri = _upload_runway_ephemeral_asset(
                api_key=runway_key,
                file_path=local_provider_segment or local_segment_source,
                content_type="video/mp4",
            )
            runway_frame_path = local_first_frame
            runway_frame_content_type = first_frame_content_type
            if selected_reference_keys:
                selected_bytes = asset_store.read_bytes(selected_reference_keys[0])
                selected_reference_image = ImageOps.exif_transpose(Image.open(BytesIO(selected_bytes))).convert("RGB")
                runway_reference_file = td_path / "runway_reference.png"
                selected_reference_image.save(runway_reference_file, format="PNG")
                runway_frame_path = runway_reference_file
                runway_frame_content_type = "image/png"
            runway_first_frame_uri = _upload_runway_ephemeral_asset(
                api_key=runway_key,
                file_path=runway_frame_path,
                content_type=runway_frame_content_type,
            )

    media_url = asset_store.presign_get(media_key_for_provider, expires=3600) if media_key_for_provider else None
    first_frame_url = asset_store.presign_get(first_frame_input_key, expires=3600)
    last_frame_url = asset_store.presign_get(last_frame_input_key, expires=3600) if last_frame_input_key else None
    selected_reference_urls = [asset_store.presign_get(key, expires=3600) for key in selected_reference_keys]
    selected_audio_reference_url = asset_store.presign_get(selected_audio_reference_key, expires=3600) if selected_audio_reference_key else None
    primary_reference_bytes = asset_store.read_bytes(selected_reference_keys[0]) if selected_reference_keys else frame_bytes

    secrets = load_secret(settings.secrets_arn)

    used_provider_model: str | None = None
    provider_duration_sec: float | None = None
    if model_name == "runway-gen4.5":
        runway_key = secrets["RUNWAY_API_KEY"]
        runway_duration = 5 if segment_duration_sec <= 7.5 else 10
        provider_duration_sec = float(runway_duration)
        _job_progress(job, store, 35, "running", "Creating Runway Gen-4.5 image-to-video generation")
        created = create_image_to_video(
            api_key=runway_key,
            prompt_image_uri=first_frame_url,
            prompt_text=payload.get("prompt") or "Generate motion that preserves the first frame composition.",
            ratio=f"{first_target_w}:{first_target_h}",
            duration=runway_duration,
            model="gen4.5",
        )
        generation_id = created.get("id")
        if not generation_id:
            raise RuntimeError(f"Unexpected Runway create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Runway generation")
        result = _wait_runway_complete(runway_key, generation_id)
        out_url = _parse_runway_output_url(result)
        provider_name = "runway"
        used_provider_model = "gen4.5"
    elif model_name == "runway-gen4-aleph":
        runway_key = secrets["RUNWAY_API_KEY"]
        provider_duration_sec = round(provider_input_duration_sec or segment_duration_sec, 3)
        _job_progress(job, store, 35, "running", "Creating Runway Aleph 2.0 video-to-video generation")
        created = create_video_to_video(
            api_key=runway_key,
            video_uri=str(runway_video_uri),
            prompt_text=payload.get("prompt") or "Modify the source video while preserving timing, camera movement, and overall motion continuity.",
            first_frame_uri=str(runway_first_frame_uri),
            model="aleph2",
        )
        generation_id = created.get("id")
        if not generation_id:
            raise RuntimeError(f"Unexpected Runway create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Runway Aleph 2.0 generation")
        result = _wait_runway_complete(runway_key, generation_id)
        out_url = _parse_runway_output_url(result)
        provider_name = "runway"
        used_provider_model = "aleph2"
    elif model_name == "kling-2.6":
        kling_key = secrets.get("RUNWARE_API_KEY") or secrets.get("KLING_API_KEY")
        if not kling_key:
            raise RuntimeError("Kling generation requires RUNWARE_API_KEY (or legacy KLING_API_KEY)")
        kling_duration = _nearest_supported_kling_duration(segment_duration_sec)
        provider_duration_sec = float(kling_duration)
        _job_progress(job, store, 35, "running", "Creating Kling 2.6 start/end-frame generation")
        created = create_kling_start_end_generation(
            api_key=kling_key,
            start_image_url=first_frame_url,
            end_image_url=(last_frame_url if uses_end_keyframe else None) or first_frame_url,
            duration_seconds=kling_duration,
            prompt=payload.get("prompt"),
        )
        generation_id = created.get("taskUUID")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Kling create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Kling generation")
        result = _wait_kling_complete(
            kling_key,
            task_uuid=generation_id,
        )
        out_url = _parse_runware_video_output_url(result)
        provider_name = "kling"
        used_provider_model = "kling-video@2.6-pro"
    elif model_name in {"veo-3.1", "veo-3.1-fast"}:
        runware_key = secrets.get("RUNWARE_API_KEY")
        if not runware_key:
            raise RuntimeError("Veo 3.1 generation requires RUNWARE_API_KEY")
        provider_duration_sec = 8.0
        runware_model = RUNWARE_VEO_31_MODEL if model_name == "veo-3.1" else RUNWARE_VEO_31_FAST_MODEL
        _job_progress(job, store, 35, "running", f"Creating Runware {model_name} start/end-frame generation")
        created = create_veo_first_last_generation(
            api_key=runware_key,
            model=runware_model,
            start_image_url=first_frame_url,
            end_image_url=(last_frame_url if uses_end_keyframe else None) or first_frame_url,
            duration_seconds=8,
            prompt=payload.get("prompt"),
            width=first_target_w,
            height=first_target_h,
            generate_audio=False,
        )
        generation_id = created.get("taskUUID")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Runware Veo create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Runware Veo generation")
        result = _wait_runware_video_complete(
            runware_key,
            task_uuid=generation_id,
        )
        out_url = _parse_runware_video_output_url(result)
        provider_name = "runware"
        used_provider_model = runware_model
    elif model_name == "wan2.2-a14b":
        runware_key = secrets.get("RUNWARE_API_KEY")
        if not runware_key:
            raise RuntimeError("Wan2.2 generation requires RUNWARE_API_KEY")
        provider_duration_sec = 5.0
        _job_progress(job, store, 35, "running", "Creating Runware Wan2.2 A14B image-to-video generation")
        created = create_wan22_a14b_generation(
            api_key=runware_key,
            start_image_url=first_frame_url,
            duration_seconds=5,
            prompt=payload.get("prompt"),
            width=first_target_w,
            height=first_target_h,
        )
        generation_id = created.get("taskUUID")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Runware Wan2.2 A14B create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Runware Wan2.2 A14B generation")
        result = _wait_runware_video_complete(
            runware_key,
            task_uuid=generation_id,
        )
        out_url = _parse_runware_video_output_url(result)
        provider_name = "runware"
        used_provider_model = RUNWARE_WAN22_A14B_MODEL
    elif model_name == "sora-2-image-to-video":
        fal_api_key = secrets.get("FAL_API_KEY")
        if not fal_api_key:
            raise RuntimeError("Sora 2 Image to Video requires FAL_API_KEY")
        if not first_frame_url:
            raise RuntimeError("Sora 2 Image to Video requires a prepared reference image URL")
        sora2_requested_duration_sec = float(max(4, min(10, int(math.ceil(segment_duration_sec or 4.0)))))
        sora2_provider_duration_sec = float(_sora_supported_duration(sora2_requested_duration_sec))
        provider_duration_sec = sora2_requested_duration_sec
        _job_progress(job, store, 35, "running", "Creating fal.ai Sora 2 image-to-video generation")
        created = submit_sora_2_image_to_video_pro(
            api_key=fal_api_key,
            input={
                "prompt": payload.get("prompt"),
                "image_url": first_frame_url,
                "resolution": sora2_resolution if sora2_resolution in {"auto", "720p", "1080p"} else "auto",
                "aspect_ratio": "auto",
                "duration": int(sora2_provider_duration_sec),
                "delete_video": True,
                "detect_and_block_ip": False,
            },
        )
        generation_id = created.get("request_id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected fal.ai Sora 2 create response: {created}")
        _job_progress(job, store, 55, "running", "Polling fal.ai Sora 2 image-to-video generation")
        result = _wait_fal_queue_complete(fal_api_key, created=created)
        out_url = _parse_fal_video_output_url(result)
        provider_name = "fal"
        used_provider_model = "fal-ai/sora-2/image-to-video/pro"
    elif model_name == "happy-horse-video-edit":
        fal_api_key = secrets.get("FAL_API_KEY")
        if not fal_api_key:
            raise RuntimeError("Happy Horse 1.0 Video Edit requires FAL_API_KEY")
        if not media_url:
            raise RuntimeError("Happy Horse 1.0 Video Edit requires a prepared segment media URL")
        provider_duration_sec = min(15.0, round(segment_duration_sec, 3))
        _job_progress(job, store, 35, "running", "Creating fal.ai Happy Horse video edit generation")
        created = submit_happy_horse_video_edit(
            api_key=fal_api_key,
            input={
                "video_url": media_url,
                "prompt": payload.get("prompt"),
                "reference_image_urls": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                "resolution": happy_horse_resolution if happy_horse_resolution in {"720p", "1080p"} else "1080p",
                "audio_setting": "origin" if provider_media_has_audio else "auto",
                "enable_safety_checker": True,
            },
        )
        generation_id = created.get("request_id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Happy Horse video edit create response: {created}")
        _job_progress(job, store, 55, "running", "Polling fal.ai Happy Horse video edit generation")
        result = _wait_fal_queue_complete(fal_api_key, created=created)
        out_url = _parse_fal_video_output_url(result)
        provider_name = "fal"
        used_provider_model = "alibaba/happy-horse/video-edit"
    elif model_name == "happy-horse-image-to-video":
        fal_api_key = secrets.get("FAL_API_KEY")
        if not fal_api_key:
            raise RuntimeError("Happy Horse 1.0 Image to Video requires FAL_API_KEY")
        if not first_frame_url:
            raise RuntimeError("Happy Horse 1.0 Image to Video requires a prepared reference image URL")
        provider_duration_sec = float(max(3, min(15, int(math.ceil(segment_duration_sec or 5.0)))))
        _job_progress(job, store, 35, "running", "Creating fal.ai Happy Horse image-to-video generation")
        created = submit_happy_horse_image_to_video(
            api_key=fal_api_key,
            input={
                "image_url": first_frame_url,
                "prompt": payload.get("prompt"),
                "resolution": happy_horse_resolution if happy_horse_resolution in {"720p", "1080p"} else "1080p",
                "duration": int(provider_duration_sec),
                "enable_safety_checker": True,
            },
        )
        generation_id = created.get("request_id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Happy Horse image-to-video create response: {created}")
        _job_progress(job, store, 55, "running", "Polling fal.ai Happy Horse image-to-video generation")
        result = _wait_fal_queue_complete(fal_api_key, created=created)
        out_url = _parse_fal_video_output_url(result)
        provider_name = "fal"
        used_provider_model = "alibaba/happy-horse/image-to-video"
    elif model_name == "wan2.7-i2v":
        replicate_key = secrets.get("REPLICATE_API_KEY")
        if not replicate_key:
            raise RuntimeError("Wan 2.7 Image to Video requires REPLICATE_API_KEY")
        provider_duration_sec = float(max(2, min(10, int(math.ceil(segment_duration_sec or 2.0)))))
        wan27_first_frame_data_url = _prepare_replicate_image_data_url(
            frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            fit_mode=first_frame_fit_mode,
        )
        wan27_reference_transport = "data_url"
        wan27_last_frame_data_url: str | None = None
        if uses_end_keyframe:
            last_frame_bytes = asset_store.read_bytes(last_frame_key)
            wan27_last_frame_data_url = _prepare_replicate_image_data_url(
                last_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                fit_mode=first_frame_fit_mode,
            )
        generation_id, result = _run_wan27_i2v_prediction(
            api_key=replicate_key,
            prompt=str(payload.get("prompt") or ""),
            first_frame=wan27_first_frame_data_url,
            last_frame=wan27_last_frame_data_url,
            negative_prompt=wan27_negative_prompt,
            resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
            duration_seconds=int(provider_duration_sec),
            job=job,
            store=store,
        )
        out_url = _parse_replicate_output_url(result)
        provider_name = "replicate"
        used_provider_model = "wan-video/wan-2.7-i2v"
    elif model_name == "ltx-2.3-pro":
        replicate_key = secrets.get("REPLICATE_API_KEY")
        if not replicate_key:
            raise RuntimeError("LTX 2.3 Pro requires REPLICATE_API_KEY")
        if not uses_end_keyframe:
            raise RuntimeError("LTX 2.3 Pro in this app requires first and last frame mode")
        ltx23_requested_duration_sec = float(_nearest_supported_ltx23_duration(segment_duration_sec or 6.0))
        ltx23_requested_fps = _nearest_supported_ltx23_fps(fps)
        ltx23_aspect_ratio = ltx23_aspect_ratio or _nearest_allowed_aspect_ratio(
            first_target_w,
            first_target_h,
            allowed=("16:9", "9:16"),
        )
        ltx23_first_frame_data_url = _prepare_replicate_image_data_url(
            frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            fit_mode=first_frame_fit_mode,
        )
        if not last_frame_key:
            raise RuntimeError("LTX 2.3 Pro requires a last frame")
        ltx23_last_frame_bytes = asset_store.read_bytes(last_frame_key)
        ltx23_last_frame_data_url = _prepare_replicate_image_data_url(
            ltx23_last_frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            fit_mode=first_frame_fit_mode,
        )
        ltx23_reference_transport = "data_url"
        _job_progress(job, store, 35, "running", "Creating Replicate LTX 2.3 Pro generation")
        generation_id, result = _run_ltx23_i2v_prediction(
            api_key=replicate_key,
            prompt=str(payload.get("prompt") or ""),
            first_frame=ltx23_first_frame_data_url,
            last_frame=ltx23_last_frame_data_url,
            duration_seconds=int(ltx23_requested_duration_sec),
            aspect_ratio=ltx23_aspect_ratio,
            fps=ltx23_requested_fps,
            generate_audio=False,
            job=job,
            store=store,
        )
        provider_duration_sec = ltx23_requested_duration_sec
        out_url = _parse_replicate_output_url(result)
        provider_name = "replicate"
        used_provider_model = "lightricks/ltx-2.3-pro"
    elif model_name == "wan2.2-animate":
        runware_key = secrets.get("RUNWARE_API_KEY")
        if not runware_key:
            raise RuntimeError("Wan2.2 generation requires RUNWARE_API_KEY")
        if not media_url:
            raise RuntimeError("Wan2.2 Animate generation requires a prepared segment media URL")
        provider_duration_sec = round(segment_duration_sec, 3)
        _job_progress(job, store, 35, "running", "Creating Runware Wan2.2 Animate generation")
        created = create_wan22_animate_generation(
            api_key=runware_key,
            reference_image_url=first_frame_url,
            reference_video_url=media_url,
            prompt=payload.get("prompt"),
            width=first_target_w,
            height=first_target_h,
        )
        generation_id = created.get("taskUUID")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Runware Wan2.2 Animate create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Runware Wan2.2 Animate generation")
        result = _wait_runware_video_complete(
            runware_key,
            task_uuid=generation_id,
        )
        out_url = _parse_runware_video_output_url(result)
        provider_name = "runware"
        used_provider_model = RUNWARE_WAN22_ANIMATE_MODEL
    elif model_name == "kling-o1":
        replicate_key = secrets.get("REPLICATE_API_KEY")
        if not replicate_key:
            raise RuntimeError("Kling O1 Edit requires REPLICATE_API_KEY")
        if not media_url:
            raise RuntimeError("Kling O1 Edit requires a prepared segment media URL")
        if not first_frame_url:
            raise RuntimeError("Kling O1 Edit requires a prepared reference image URL")
        provider_duration_sec = float(max(3, min(10, int(round(segment_duration_sec or 5)))))
        _job_progress(job, store, 35, "running", "Creating Replicate Kling O1 Edit generation")
        created = create_replicate_prediction(
            api_key=replicate_key,
            version=REPLICATE_KLING_O1_VERSION,
            input={
                "prompt": payload.get("prompt"),
                "reference_video": media_url,
                "reference_images": [first_frame_url],
                "video_reference_type": "base",
                "keep_original_sound": True,
                "mode": replicate_kling_mode if replicate_kling_mode in {"std", "pro"} else "pro",
                "aspect_ratio": replicate_aspect_ratio or "16:9",
                "duration": int(provider_duration_sec),
            },
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate Kling O1 create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate Kling O1 Edit generation")
        result = _wait_replicate_complete(replicate_key, prediction_id=generation_id)
        out_url = _parse_replicate_output_url(result)
        provider_name = "replicate"
        used_provider_model = "kwaivgi/kling-o1"
    elif model_name == "kling-v3-omni-video":
        replicate_key = secrets.get("REPLICATE_API_KEY")
        if not replicate_key:
            raise RuntimeError("Kling v3 Omni Video requires REPLICATE_API_KEY")
        if not media_url:
            raise RuntimeError("Kling v3 Omni Video requires a prepared segment media URL")
        if not first_frame_url:
            raise RuntimeError("Kling v3 Omni Video requires a prepared reference image URL")
        _job_progress(job, store, 35, "running", "Creating Replicate Kling v3 Omni Video generation")
        created = create_replicate_prediction(
            api_key=replicate_key,
            version=REPLICATE_KLING_V3_OMNI_VIDEO_VERSION,
            input={
                "prompt": payload.get("prompt"),
                "reference_video": media_url,
                "reference_images": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                "video_reference_type": "base",
                "keep_original_sound": True,
                "mode": replicate_kling_v3_mode if replicate_kling_v3_mode in {"standard", "pro"} else "pro",
                "aspect_ratio": replicate_aspect_ratio or "16:9",
            },
        )
        generation_id = created.get("id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Replicate Kling v3 Omni create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Replicate Kling v3 Omni Video generation")
        result = _wait_replicate_complete(replicate_key, prediction_id=generation_id)
        out_url = _parse_replicate_output_url(result)
        provider_name = "replicate"
        used_provider_model = "kwaivgi/kling-v3-omni-video"
    elif model_name == "seedance-2.0-reference-to-video":
        fal_api_key = secrets.get("FAL_API_KEY")
        if not fal_api_key:
            raise RuntimeError("Seedance 2.0 Reference to Video requires FAL_API_KEY")
        if not media_url:
            raise RuntimeError("Seedance 2.0 Reference to Video requires a prepared segment media URL")
        if not first_frame_url:
            raise RuntimeError("Seedance 2.0 Reference to Video requires a prepared reference image URL")
        seedance_duration = int(math.ceil(segment_duration_sec or 4.0))
        provider_duration_sec = float(max(4, min(15, seedance_duration)))
        seedance_requested_duration_sec = provider_duration_sec
        _job_progress(job, store, 35, "running", "Creating fal.ai Seedance 2.0 generation")
        created = submit_seedance_reference_to_video(
            api_key=fal_api_key,
            input={
                "prompt": payload.get("prompt"),
                "image_urls": selected_reference_urls[:3] if selected_reference_urls else [first_frame_url],
                "video_urls": [media_url],
                **({"audio_urls": [selected_audio_reference_url]} if selected_audio_reference_url else {}),
                "resolution": "720p",
                "duration": str(int(provider_duration_sec)),
                "aspect_ratio": seedance_aspect_ratio or "auto",
                "generate_audio": False,
                "end_user_id": task.get("userId"),
            },
        )
        generation_id = created.get("request_id")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected fal.ai Seedance create response: {created}")
        _job_progress(job, store, 55, "running", "Polling fal.ai Seedance 2.0 generation")
        result = _wait_fal_queue_complete(fal_api_key, created=created)
        out_url = _parse_fal_video_output_url(result)
        provider_name = "fal"
        used_provider_model = "bytedance/seedance-2.0/reference-to-video"
    elif model_name == "wan2.7-videoedit":
        replicate_key = secrets.get("REPLICATE_API_KEY")
        if not replicate_key:
            raise RuntimeError("Wan 2.7 VideoEdit requires REPLICATE_API_KEY")
        if not wan27_video_data_url:
            raise RuntimeError("Wan 2.7 VideoEdit requires a prepared segment video payload")
        if not frame_bytes:
            raise RuntimeError("Wan 2.7 VideoEdit requires a prepared reference image")
        provider_duration_sec = provider_input_duration_sec
        wan27_reference_data_url = _prepare_replicate_image_data_url(
            primary_reference_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            fit_mode=first_frame_fit_mode,
        )
        wan27_reference_transport = "data_url"
        generation_id, result = _run_wan27_prediction(
            api_key=replicate_key,
            prompt=str(payload.get("prompt") or ""),
            media_url=wan27_video_data_url,
            reference_image=wan27_reference_data_url,
            resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
            aspect_ratio=wan27_aspect_ratio or "auto",
            audio_setting="origin" if provider_media_has_audio else "auto",
            job=job,
            store=store,
        )
        out_url = _parse_replicate_output_url(result)
        provider_name = "replicate"
        used_provider_model = "wan-video/wan-2.7-videoedit"
    else:
        luma_key = _resolve_luma_uni_api_key(secrets)
        if not luma_key:
            raise RuntimeError(
                "Luma Ray 3.2 video edit requires a Luma Agents key (`luma-api-*`) in "
                "LUMA_AGENTS_API_KEY, or in LUMA_API_KEY if that value is also an Agents key."
            )
        if not media_url:
            raise RuntimeError("Luma generation requires a prepared segment media URL")
        ray32_resolution = _luma_ray32_resolution_label(model_name)
        _job_progress(job, store, 35, "running", "Creating Luma Ray 3.2 video edit generation")
        created = create_video_edit_generation(
            api_key=luma_key,
            media_url=media_url,
            resolution=ray32_resolution,
            strength=luma_mode,
            prompt=payload.get("prompt"),
            start_frame_url=first_frame_url,
        )
        generation_id = created.get("id") or created.get("generation_id")
        if not generation_id:
            raise RuntimeError(f"Unexpected Luma create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Luma Ray 3.2 generation")
        result = _wait_luma_complete(luma_key, generation_id)
        out_url = _parse_luma_output_url(result)
        provider_name = "luma"
        used_provider_model = "ray-3.2"

    out_key = paths.segment_generated(segment_id, gen_id)
    _job_progress(job, store, 75, "running", "Downloading generation output to S3")
    raw_output_probe: dict[str, Any] | None = None
    stored_output_probe: dict[str, Any] | None = None
    timeline_alignment: dict[str, Any] | None = None
    timeline_conform: dict[str, Any] | None = None
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        downloaded_path = td_path / "provider_output_raw.mp4"
        _download_url_to_path(out_url, downloaded_path)
        if (
            model_name == "sora-2-image-to-video"
            and sora2_requested_duration_sec
            and sora2_provider_duration_sec
            and sora2_provider_duration_sec - sora2_requested_duration_sec > 1e-3
        ):
            _job_progress(job, store, 79, "running", "Trimming Sora output to requested duration")
            trimmed_path = td_path / "provider_output_trimmed.mp4"
            trim_video_to_duration(
                str(downloaded_path),
                str(trimmed_path),
                duration_sec=sora2_requested_duration_sec,
                crf=16,
                preset="medium",
                audio_bitrate="192k",
            )
            downloaded_path = trimmed_path
        raw_output_probe = ffprobe_video(str(downloaded_path))
        if model_name == "seedance-2.0-reference-to-video":
            seedance_raw_output_width = int(raw_output_probe.get("width") or 0) or None
            seedance_raw_output_height = int(raw_output_probe.get("height") or 0) or None
        target_output_width = int(source_segment_width or src_width)
        target_output_height = int(source_segment_height or src_height)
        needs_timeline_conform = _needs_timeline_conform(
            raw_output_probe,
            target_width=target_output_width,
            target_height=target_output_height,
            target_fps=fps,
        )
        if needs_timeline_conform:
            _job_progress(job, store, 82, "running", "Conforming provider output to segment resolution and frame rate")
            conformed_path = td_path / "provider_output_timeline.mp4"
            transcode_to_cfr(
                str(downloaded_path),
                str(conformed_path),
                fps,
                target_width=target_output_width,
                target_height=target_output_height,
                crf=16,
                preset="medium",
            )
            _upload_s3(s3, settings.assets_bucket, out_key, conformed_path, "video/mp4")
            stored_output_probe = ffprobe_video(str(conformed_path))
        else:
            _upload_s3(s3, settings.assets_bucket, out_key, downloaded_path, "video/mp4")
            stored_output_probe = raw_output_probe
        output_duration_value = float(stored_output_probe.get("duration_sec") or 0.0)
        if output_duration_value > 0:
            provider_duration_sec = round(output_duration_value, 3)
        if model_name == "seedance-2.0-reference-to-video":
            seedance_output_width = int(stored_output_probe.get("width") or target_output_width)
            seedance_output_height = int(stored_output_probe.get("height") or target_output_height)

        source_segment_key = segment_key or _ensure_segment_clip(
            s3=s3,
            asset_store=asset_store,
            asset_paths=paths,
            task=task,
            segment=segment,
            assets_bucket=settings.assets_bucket,
        )
        source_segment_path = td_path / "source_segment.mp4"
        _download_s3(s3, settings.assets_bucket, source_segment_key, source_segment_path)
        source_segment_probe = ffprobe_video(str(source_segment_path))
        source_frames = _load_video_alignment_source_frames(
            source_segment_path,
            td_path / "segment_alignment",
            max_frames=VIDEO_COMPARE_ALIGNMENT_SCAN_FRAMES,
        )
        stored_output_path = td_path / "stored_output.mp4"
        _download_s3(s3, settings.assets_bucket, out_key, stored_output_path)
        timeline_alignment = _estimate_generated_source_offset(
            source_frames=source_frames,
            generated_path=stored_output_path,
            generated_probe=stored_output_probe,
            source_fps=fps,
            work_dir=td_path / "segment_alignment",
            prefix=f"segment_{gen_id}",
        )
        timeline_conform = _timeline_conform_summary(
            source_probe=source_segment_probe,
            raw_output_probe=raw_output_probe,
            stored_output_probe=stored_output_probe,
            applied=needs_timeline_conform,
            policy="source_cfr_resolution",
        )

    finished_at = now_iso()
    processing_duration_sec = _processing_duration_seconds(gen_meta.get("startedAt"), finished_at)
    poster_key = _create_segment_generation_poster(
        asset_store=asset_store,
        paths=paths,
        segment_id=segment_id,
        gen_id=gen_id,
        video_path=str(conformed_path if needs_timeline_conform else downloaded_path),
    )
    generation_updates = {
        "genId": gen_id,
        "segmentId": segment_id,
        "luma": {
            "provider": provider_name,
            "model": model_name,
            "mode": requested_mode,
            "prompt": payload.get("prompt"),
            "negativePrompt": payload.get("negativePrompt"),
            "lumaGenerationId": generation_id,
        },
        "status": "complete",
        "outputKey": out_key,
        "posterKey": poster_key,
        "inputMediaKey": media_key_for_provider,
        "inputFirstFrameKey": first_frame_input_key,
        "inputLastFrameKey": last_frame_input_key,
        "inputAudioKey": input_audio_key,
        "sourceFirstFrameCaptureKey": start_frame.get("captureKey"),
        "sourceFirstFrameVariantId": source_first_variant_id,
        "sourceFirstFrameResolvedKey": first_frame_key,
        "sourceLastFrameCaptureKey": end_frame.get("captureKey") if uses_end_keyframe else None,
        "sourceLastFrameVariantId": source_last_variant_id,
        "sourceLastFrameResolvedKey": last_frame_key,
        "requestedDurationSec": round(segment_duration_sec, 3),
        "providerDurationSec": provider_duration_sec,
        "sourceFrameOffset": int((timeline_alignment or {}).get("sourceFrameOffset") or 0),
        "alignment": timeline_alignment,
        "segmentCrop": segment.get("crop"),
        "generationSettings": {
            "provider": provider_name,
            "requestedModel": model_name,
            "model": used_provider_model or model_name,
            "mode": requested_mode,
            "providerMode": luma_mode if provider_name == "luma" else requested_mode,
            "firstFrameResolution": {"width": first_target_w, "height": first_target_h},
            "firstFrameContentType": first_frame_content_type,
            "lastFrameContentType": last_frame_content_type,
            "mediaResolution": (
                {"width": provider_media_width, "height": provider_media_height}
                if provider_media_width and provider_media_height
                else None
            ),
            "mediaFps": (
                {"num": provider_media_fps.numerator, "den": provider_media_fps.denominator}
                if provider_media_fps
                else None
            ),
            "aspectRatio": (
                ltx23_aspect_ratio
                if model_name == "ltx-2.3-pro"
                else (
                    replicate_aspect_ratio
                    if model_name in {"kling-o1", "kling-v3-omni-video"}
                    else (seedance_aspect_ratio if model_name == "seedance-2.0-reference-to-video" else (wan27_aspect_ratio if model_name == "wan2.7-videoedit" else None))
                )
            ),
            "replicateKlingMode": replicate_kling_mode if model_name == "kling-o1" else None,
            "replicateKlingV3Mode": replicate_kling_v3_mode if model_name == "kling-v3-omni-video" else None,
            "seedanceResolution": "720p" if model_name == "seedance-2.0-reference-to-video" else None,
            "seedanceRequestedDurationSec": seedance_requested_duration_sec if model_name == "seedance-2.0-reference-to-video" else None,
            "seedanceRawOutputResolution": (
                {"width": seedance_raw_output_width, "height": seedance_raw_output_height}
                if model_name == "seedance-2.0-reference-to-video" and seedance_raw_output_width and seedance_raw_output_height
                else None
            ),
            "seedanceOutputResolution": (
                {"width": seedance_output_width, "height": seedance_output_height}
                if model_name == "seedance-2.0-reference-to-video" and seedance_output_width and seedance_output_height
                else None
            ),
            "wan27Resolution": wan27_resolution if model_name in {"wan2.7-videoedit", "wan2.7-i2v"} else None,
            "wan27VideoTransport": wan27_video_transport if model_name == "wan2.7-videoedit" else None,
            "wan27ReferenceTransport": wan27_reference_transport if model_name in {"wan2.7-videoedit", "wan2.7-i2v"} else None,
            "wan27NegativePrompt": wan27_negative_prompt if model_name == "wan2.7-i2v" else None,
            "ltx23ReferenceTransport": ltx23_reference_transport if model_name == "ltx-2.3-pro" else None,
            "ltx23RequestedDurationSec": ltx23_requested_duration_sec if model_name == "ltx-2.3-pro" else None,
            "ltx23RequestedFps": ltx23_requested_fps if model_name == "ltx-2.3-pro" else None,
            "sora2Resolution": sora2_resolution if model_name == "sora-2-image-to-video" else None,
            "happyHorseResolution": happy_horse_resolution if model_name in {"happy-horse-video-edit", "happy-horse-image-to-video"} else None,
            "selectedReferenceIds": selected_reference_ids,
            "selectedReferenceCount": len(selected_reference_ids),
            "audioReferenceId": selected_audio_reference_id or None,
            "sora2RequestedDurationSec": sora2_requested_duration_sec if model_name == "sora-2-image-to-video" else None,
            "sora2ProviderDurationSec": sora2_provider_duration_sec if model_name == "sora-2-image-to-video" else None,
            "preserveFrames": preserve_frames,
            "providerInputTimingPolicy": provider_input_timing_policy,
            "mediaHasAudio": provider_media_has_audio,
            "segmentCrop": segment.get("crop"),
            "requestedDurationSec": round(segment_duration_sec, 3),
            "providerDurationSec": provider_duration_sec,
            "sourceSegmentTiming": {
                "startFrame": int(segment.get("startFrame") or 0),
                "endFrameExclusive": int(segment.get("endFrameExclusive") or 0),
                "durationFrames": int(segment.get("durationFrames") or max(0, int(segment.get("endFrameExclusive") or 0) - int(segment.get("startFrame") or 0))),
                "durationSec": round(float(segment.get("durationSec") or 0.0), 4),
                "fps": {"num": fps.numerator, "den": fps.denominator},
                "width": target_output_width,
                "height": target_output_height,
            },
            "providerInputTiming": (
                {
                    "durationSec": round(float(provider_input_duration_sec or provider_duration_sec or segment_duration_sec), 4),
                    "fps": {"num": provider_media_fps.numerator, "den": provider_media_fps.denominator},
                    "width": provider_media_width,
                    "height": provider_media_height,
                    "timingPolicy": provider_input_timing_policy,
                }
                if provider_media_fps and provider_media_width and provider_media_height
                else None
            ),
            "providerOutputRaw": _video_timing_payload(raw_output_probe or {}),
            "storedOutput": _video_timing_payload(stored_output_probe or {}),
            "timelineAlignment": timeline_alignment,
            "timelineConform": timeline_conform,
        },
        "createdAt": gen_meta.get("createdAt") or now_iso(),
        "updatedAt": finished_at,
        "finishedAt": finished_at,
        "processingDurationSec": processing_duration_sec,
        "error": None,
        "parentGenerationId": payload.get("parentGenerationId"),
        "extension": payload.get("extensionMetadata") if isinstance(payload.get("extensionMetadata"), dict) else gen_meta.get("extension"),
    }
    _record_usage(
        store=store,
        user_id=task["userId"],
        task=task,
        source="segment_generate",
        tool_origin="segment_generate",
        request_type="video_generation",
        provider=provider_name,
        provider_model=used_provider_model or model_name,
        app_model_id=model_name,
        target_record=generation_updates,
        segment_id=segment_id,
        asset_id=gen_id,
        asset_kind="segment_generation",
        duration_sec=provider_duration_sec,
        width=int(stored_output_probe.get("width") or target_output_width or 0) or None,
        height=int(stored_output_probe.get("height") or target_output_height or 0) or None,
        fps=(
            float(stored_output_probe.get("fps_num") or 0) / float(stored_output_probe.get("fps_den") or 1)
            if stored_output_probe.get("fps_num")
            else None
        ),
        resolution_label=_luma_ray32_resolution_label(model_name) if model_name in {"ray-3.2-720p", "ray-3.2-1080p"} else None,
    )
    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates=generation_updates,
        history_entry={
            "at": finished_at,
            "event": "segment_generation.complete",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "segmentId": segment_id,
            "model": model_name,
            "outputKey": out_key,
        },
    )
    job["resultRefs"] = {
        "genId": gen_id,
        "segmentId": segment_id,
        "outputKey": out_key,
        "posterKey": poster_key,
        "provider": provider_name,
        "model": model_name,
        "mode": requested_mode,
        "providerGenerationId": generation_id,
        "finishedAt": gen_meta.get("finishedAt"),
        "processingDurationSec": processing_duration_sec,
    }
    final_generation_id = gen_id
    final_output_key = out_key
    final_segment_id = segment_id
    final_provider = provider_name
    final_model = model_name
    final_mode = requested_mode

    _job_progress(job, store, 96, "running", "Finalizing generated output")
    latest_task = store.load_task(task["userId"], task["taskId"])
    if isinstance(latest_task, dict):
        _advance_chunked_generation_run_after_success(
            store=store,
            asset_store=asset_store,
            task=latest_task,
            settings=settings,
            gen_id=gen_id,
        )
        try:
            _finalize_extension_chain_generation_after_success(
                store=store,
                task=latest_task,
                settings=settings,
                gen_id=gen_id,
            )
        except Exception:
            logger.exception("extension_chain_finalize_failed", extra={"taskId": task.get("taskId"), "genId": gen_id})
        latest_generation = latest_task.get("segmentGenerations", {}).get(gen_id)
        if isinstance(latest_generation, dict):
            stitched_generation_id = str(latest_generation.get("extensionStitchedFromGenerationId") or "")
            if stitched_generation_id:
                stitched_generation = latest_task.get("segmentGenerations", {}).get(stitched_generation_id)
                if isinstance(stitched_generation, dict):
                    final_generation_id = stitched_generation_id
                    final_segment_id = str(stitched_generation.get("segmentId") or final_segment_id)
                    final_output_key = str(stitched_generation.get("outputKey") or final_output_key)
                    stitched_luma = stitched_generation.get("luma") if isinstance(stitched_generation.get("luma"), dict) else {}
                    final_provider = str(stitched_luma.get("provider") or final_provider)
                    final_model = str(stitched_luma.get("model") or final_model)
                    final_mode = str(stitched_luma.get("mode") or final_mode)
                    job["resultRefs"]["sourceGenId"] = gen_id
                    job["resultRefs"]["stitchedGenId"] = stitched_generation_id
                    job["resultRefs"]["stitchedOutputKey"] = final_output_key

    job["resultRefs"].update(
        {
            "genId": final_generation_id,
            "segmentId": final_segment_id,
            "outputKey": final_output_key,
            "provider": final_provider,
            "model": final_model,
            "mode": final_mode,
        }
    )
    _job_progress(job, store, 100, "complete", "Segment generation complete")
    store.save_job(job)
    return job


def _handle_merge(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    selected_raw = payload.get("selectedSegmentGenerationIds")
    if isinstance(selected_raw, str):
        selected = [selected_raw]
    elif isinstance(selected_raw, (list, tuple)):
        selected = [str(item) for item in selected_raw if isinstance(item, str) and item]
    else:
        selected = []
    if not selected:
        raise RuntimeError("No valid selectedSegmentGenerationIds provided for merge")
    feather_frames_shared = int(payload.get("temporalFeatherFrames", 0) or 0)
    feather_start_frames = int(payload.get("temporalFeatherStartFrames", feather_frames_shared) or 0)
    feather_end_frames = int(payload.get("temporalFeatherEndFrames", feather_frames_shared) or 0)
    feather_start_frames = max(0, min(30, feather_start_frames))
    feather_end_frames = max(0, min(30, feather_end_frames))
    raw_adjustments = payload.get("generationAdjustments") or {}
    adjustments: dict[str, dict[str, Any]] = {}
    if isinstance(raw_adjustments, dict):
        for gen_id, raw_adjustment in raw_adjustments.items():
            if not isinstance(gen_id, str):
                continue
            if hasattr(raw_adjustment, "model_dump"):
                parsed_adjustment = raw_adjustment.model_dump(exclude_none=True)
            elif isinstance(raw_adjustment, str):
                parsed_adjustment: dict[str, Any] = {}
                # Backward compatibility for old persisted payloads:
                # "startFrameOverride=252 trimStartFrames=1 trimEndFrames=0"
                for key, value in re.findall(r"(startFrameOverride|trimStartFrames|trimEndFrames)\s*=\s*(-?\d+)", raw_adjustment):
                    parsed_adjustment[key] = int(value)
                if not parsed_adjustment:
                    try:
                        decoded = json.loads(raw_adjustment)
                        parsed_adjustment = decoded if isinstance(decoded, dict) else {}
                    except Exception:
                        parsed_adjustment = {}
            elif isinstance(raw_adjustment, dict):
                parsed_adjustment = raw_adjustment
            else:
                parsed_adjustment = {}
            adjustments[gen_id] = parsed_adjustment
    paths = _asset_paths(task)
    total_frames = int(task.get("video", {}).get("editSource", {}).get("frameCount") or 0)
    segments_by_id = {
        str(segment.get("segmentId")): segment
        for segment in task.get("segments", [])
        if isinstance(segment, dict) and segment.get("segmentId")
    }

    def selected_generation_sort_key(gen_id: str) -> tuple[int, str]:
        generation = task.get("segmentGenerations", {}).get(gen_id)
        segment = segments_by_id.get(str(generation.get("segmentId") if isinstance(generation, dict) else ""))
        start_frame = int(segment.get("startFrame", 0)) if isinstance(segment, dict) else 0
        return start_frame, gen_id

    selected = sorted(selected, key=selected_generation_sort_key)

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        s3 = boto3.client("s3")
        current_path = td_path / "current.mp4"
        _download_s3(s3, settings.assets_bucket, task["video"]["editSource"]["s3Key"], current_path)

        applied: list[dict[str, Any]] = []
        for idx, gen_id in enumerate(selected):
            gen = task["segmentGenerations"].get(gen_id)
            if not gen or gen.get("status") != "complete":
                raise RuntimeError(f"Generation {gen_id} is not complete")

            segment = next(seg for seg in task["segments"] if seg["segmentId"] == gen["segmentId"])
            seg_path = td_path / f"segment_{idx}.mp4"
            out_path = td_path / f"merged_{idx}.mp4"
            _download_s3(s3, settings.assets_bucket, gen["outputKey"], seg_path)
            raw_adjustment = adjustments.get(gen_id) or {}
            if not isinstance(raw_adjustment, dict):
                raw_adjustment = {}
            generation_settings = gen.get("generationSettings") if isinstance(gen.get("generationSettings"), dict) else {}
            alignment = gen.get("alignment") if isinstance(gen.get("alignment"), dict) else {}
            timeline_alignment_settings = generation_settings.get("timelineAlignment") if isinstance(generation_settings.get("timelineAlignment"), dict) else {}
            source_frame_offset = int(
                raw_adjustment.get("sourceFrameOffset")
                or gen.get("sourceFrameOffset")
                or alignment.get("sourceFrameOffset")
                or timeline_alignment_settings.get("sourceFrameOffset")
                or 0
            )
            stored_output = generation_settings.get("storedOutput") if isinstance(generation_settings.get("storedOutput"), dict) else {}
            stored_output_frame_count = int(stored_output.get("frameCount") or 0)
            source_segment_duration_frames = int(segment.get("durationFrames") or max(0, int(segment.get("endFrameExclusive") or 0) - int(segment.get("startFrame") or 0)))
            default_start_frame_override = int(segment["startFrame"]) + max(0, source_frame_offset)
            available_target_frames = max(1, source_segment_duration_frames - max(0, source_frame_offset))
            default_trim_end_frames = max(0, stored_output_frame_count - available_target_frames) if stored_output_frame_count > 0 else 0
            trim_start_frames = max(0, int(raw_adjustment.get("trimStartFrames") if raw_adjustment.get("trimStartFrames") is not None else 0))
            trim_end_frames = max(0, int(raw_adjustment.get("trimEndFrames") if raw_adjustment.get("trimEndFrames") is not None else default_trim_end_frames))
            playback_rate = raw_adjustment.get("playbackRate")
            if playback_rate is not None:
                try:
                    playback_rate = max(0.05, min(20.0, float(playback_rate)))
                except Exception:
                    playback_rate = None
            start_frame_override = raw_adjustment.get("startFrameOverride")
            if start_frame_override is not None:
                start_frame_override = max(0, int(start_frame_override))
                if total_frames > 0:
                    start_frame_override = min(start_frame_override, total_frames - 1)
            else:
                start_frame_override = default_start_frame_override
                if total_frames > 0:
                    start_frame_override = min(start_frame_override, total_frames - 1)
            merge_start_frame = int(start_frame_override)
            source_restart_frame = raw_adjustment.get("sourceRestartFrame")
            if source_restart_frame is not None:
                source_restart_frame = max(0, int(source_restart_frame))
                if total_frames > 0:
                    source_restart_frame = min(source_restart_frame, total_frames)
            effective_trim_start = trim_start_frames
            effective_trim_end = trim_end_frames
            merge_segment_path = seg_path
            retime_cmd: list[str] | None = None
            if playback_rate is not None and abs(playback_rate - 1.0) > 1e-4:
                retimed_path = td_path / f"segment_retimed_{idx}.mp4"
                retime_cmd = trim_and_retime_video_uniform(
                    str(seg_path),
                    str(retimed_path),
                    fps=Fraction(task["video"]["editSource"]["fps"]["num"], task["video"]["editSource"]["fps"]["den"]),
                    playback_rate=playback_rate,
                    trim_start_frames=effective_trim_start,
                    trim_end_frames=trim_end_frames,
                    target_width=int(task["video"]["editSource"]["width"]),
                    target_height=int(task["video"]["editSource"]["height"]),
                    crf=16,
                    preset="slow",
                    audio_bitrate="192k",
                )
                merge_segment_path = retimed_path
                effective_trim_start = 0
                effective_trim_end = 0
            crop_settings = gen.get("segmentCrop") if isinstance(gen.get("segmentCrop"), dict) else segment.get("crop")
            crop_compose_cmd: list[str] | None = None
            crop_edge_feather: dict[str, int] | None = None
            raw_crop_edge_feather = raw_adjustment.get("cropEdgeFeather")
            if isinstance(raw_crop_edge_feather, dict):
                max_h = max(0, int(crop_settings.get("width", 0)) - 1) if isinstance(crop_settings, dict) else 0
                max_v = max(0, int(crop_settings.get("height", 0)) - 1) if isinstance(crop_settings, dict) else 0
                crop_edge_feather = {
                    "top": max(0, min(int(raw_crop_edge_feather.get("top", 0) or 0), max_v)),
                    "right": max(0, min(int(raw_crop_edge_feather.get("right", 0) or 0), max_h)),
                    "bottom": max(0, min(int(raw_crop_edge_feather.get("bottom", 0) or 0), max_v)),
                    "left": max(0, min(int(raw_crop_edge_feather.get("left", 0) or 0), max_h)),
                }
            if (
                isinstance(crop_settings, dict)
                and crop_settings.get("enabled")
                and int(crop_settings.get("width", 0)) > 0
                and int(crop_settings.get("height", 0)) > 0
            ):
                composed_path = td_path / f"segment_composed_{idx}.mp4"
                crop_compose_cmd = compose_cropped_generated_segment(
                    str(current_path),
                    str(merge_segment_path),
                    str(composed_path),
                    start_frame=merge_start_frame,
                    fps_num=task["video"]["editSource"]["fps"]["num"],
                    fps_den=task["video"]["editSource"]["fps"]["den"],
                    output_width=int(task["video"]["editSource"]["width"]),
                    output_height=int(task["video"]["editSource"]["height"]),
                    crop_x=int(crop_settings.get("x", 0)),
                    crop_y=int(crop_settings.get("y", 0)),
                    crop_width=int(crop_settings.get("width", 0)),
                    crop_height=int(crop_settings.get("height", 0)),
                    crop_feather_px=int(crop_settings.get("featherPx", 0)),
                    crop_feather_top_px=(crop_edge_feather or {}).get("top"),
                    crop_feather_right_px=(crop_edge_feather or {}).get("right"),
                    crop_feather_bottom_px=(crop_edge_feather or {}).get("bottom"),
                    crop_feather_left_px=(crop_edge_feather or {}).get("left"),
                    generated_trim_start_frames=effective_trim_start,
                    generated_trim_end_frames=effective_trim_end,
                )
                merge_segment_path = composed_path
                effective_trim_start = 0
                effective_trim_end = 0

            cmd = merge_with_segment_replacement(
                str(current_path),
                str(merge_segment_path),
                str(out_path),
                start_frame=segment["startFrame"],
                end_frame_exclusive=segment["endFrameExclusive"],
                fps_num=task["video"]["editSource"]["fps"]["num"],
                fps_den=task["video"]["editSource"]["fps"]["den"],
                output_width=int(task["video"]["editSource"]["width"]),
                output_height=int(task["video"]["editSource"]["height"]),
                temporal_feather_start_frames=feather_start_frames,
                temporal_feather_end_frames=feather_end_frames,
                insert_start_frame=start_frame_override,
                source_restart_frame=source_restart_frame,
                generated_trim_start_frames=effective_trim_start,
                generated_trim_end_frames=effective_trim_end,
            )
            applied.append(
                {
                    "segmentId": segment["segmentId"],
                    "generationId": gen_id,
                    "sourceFrameOffset": source_frame_offset,
                    "startFrameOverride": start_frame_override,
                    "effectiveInsertStartFrame": merge_start_frame,
                    "sourceRestartFrame": source_restart_frame,
                    "trimStartFrames": trim_start_frames,
                    "trimEndFrames": trim_end_frames,
                    "effectiveTrimStartFrames": effective_trim_start,
                    "effectiveTrimEndFrames": effective_trim_end,
                    "playbackRate": playback_rate,
                    "autoTimingApplied": {
                        "startFrameOverride": raw_adjustment.get("startFrameOverride") is None,
                        "trimEndFrames": raw_adjustment.get("trimEndFrames") is None,
                    },
                    "cropEdgeFeather": crop_edge_feather,
                    "segmentCrop": crop_settings if isinstance(crop_settings, dict) else None,
                    "retimeFfmpeg": (" ".join(retime_cmd).replace(str(td_path), "/tmp") if retime_cmd else None),
                    "cropComposeFfmpeg": (" ".join(crop_compose_cmd).replace(str(td_path), "/tmp") if crop_compose_cmd else None),
                    "ffmpeg": " ".join(cmd).replace(str(td_path), "/tmp"),
                }
            )
            current_path = out_path
            _job_progress(job, store, 20 + math.floor(70 * (idx + 1) / max(1, len(selected))), "running", f"Merged {idx + 1}/{len(selected)} segments")

        export_id = new_id("exp")
        export_key = paths.export_output(export_id)
        _upload_s3(s3, settings.assets_bucket, export_key, current_path, "video/mp4")

    task.setdefault("exports", []).append(
        {
            "exportId": export_id,
            "outputKey": export_key,
            "selectedSegmentGenerationIds": selected,
            "temporalFeatherFrames": max(feather_start_frames, feather_end_frames),
            "temporalFeatherStartFrames": feather_start_frames,
            "temporalFeatherEndFrames": feather_end_frames,
            "createdAt": now_iso(),
            "ffmpegCommands": applied,
        }
    )
    store.save_task(task)

    _job_progress(job, store, 100, "complete", "Merge complete")
    job["resultRefs"] = {"exportId": export_id, "outputKey": export_key}
    store.save_job(job)
    return job


def _run_command(command: list[str]) -> str:
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{proc.stderr}")
    return proc.stdout + proc.stderr


def _count_binary_pixels(mask_image: Image.Image) -> int:
    binary = mask_image.convert("L").point(lambda value: 255 if value >= 128 else 0)
    histogram = binary.histogram()
    return int(histogram[255]) if len(histogram) >= 256 else 0


def _threshold_change_mask(diff_gray: Image.Image, threshold: int) -> Image.Image:
    binary = diff_gray.convert("L").point(lambda value: 255 if value >= threshold else 0)
    binary = binary.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    binary = binary.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    return binary.point(lambda value: 255 if value >= 128 else 0)


def _load_optional_mask(mask_bytes: bytes | None, size: tuple[int, int]) -> Image.Image | None:
    if not mask_bytes:
        return None
    mask = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.Resampling.BILINEAR)
    return mask.point(lambda value: 255 if value >= 127 else 0)


def _alignment_region_mask_from_edit_mask(mask_bytes: bytes | None, size: tuple[int, int], *, expand_px: int = 6) -> Image.Image | None:
    edit_mask = _load_optional_mask(mask_bytes, size)
    if edit_mask is None:
        return None
    if expand_px > 0:
        edit_mask = _grow_or_shrink_mask(edit_mask, expand_px).point(lambda value: 255 if value >= 127 else 0)
    preserve_mask = ImageChops.invert(edit_mask.convert("L")).point(lambda value: 255 if value >= 127 else 0)
    selected_pixels = _count_binary_pixels(preserve_mask)
    total_pixels = max(1, preserve_mask.width * preserve_mask.height)
    if selected_pixels < max(128, int(total_pixels * 0.12)):
        return None
    return preserve_mask


def _analyze_image_pair(
    original_image: Image.Image,
    edited_image: Image.Image,
    *,
    mask_image: Image.Image | None,
    threshold: int,
    boundary_ring_px: int,
) -> tuple[dict[str, Any], Image.Image, Image.Image, Image.Image | None]:
    original_rgb = original_image.convert("RGB")
    edited_rgb = edited_image.convert("RGB")
    if edited_rgb.size != original_rgb.size:
        edited_rgb = ImageOps.contain(edited_rgb, original_rgb.size, Image.Resampling.LANCZOS)
        aligned = Image.new("RGB", original_rgb.size, (0, 0, 0))
        offset_x = (original_rgb.width - edited_rgb.width) // 2
        offset_y = (original_rgb.height - edited_rgb.height) // 2
        aligned.paste(edited_rgb, (offset_x, offset_y))
        edited_rgb = aligned

    diff_gray = ImageChops.difference(original_rgb, edited_rgb).convert("L")
    binary_change = _threshold_change_mask(diff_gray, threshold)
    total_pixels = max(1, diff_gray.width * diff_gray.height)
    changed_total = _count_binary_pixels(binary_change)
    mean_diff_total = float(ImageStat.Stat(diff_gray).mean[0]) / 255.0

    diff_histogram = diff_gray.histogram()
    mse_sum = 0.0
    for value, count in enumerate(diff_histogram[:256]):
        mse_sum += (float(value) ** 2) * float(count)
    mse = mse_sum / (total_pixels * (255.0 ** 2))
    psnr = 99.0 if mse <= 1e-12 else 20.0 * math.log10(1.0 / math.sqrt(mse))

    metrics: dict[str, Any] = {
        "changedPctTotal": round((changed_total * 100.0) / total_pixels, 4),
        "meanDiffTotal": round(mean_diff_total, 6),
        "mse": round(mse, 8),
        "psnr": round(psnr, 4),
        "pixelCount": total_pixels,
        "changedPixelCount": changed_total,
        "threshold": threshold,
    }

    mask_bin = mask_image.point(lambda value: 255 if value >= 127 else 0) if mask_image else None
    if mask_bin is not None:
        inverse_mask = ImageChops.invert(mask_bin)
        inside_pixels = max(1, _count_binary_pixels(mask_bin))
        outside_pixels = max(1, _count_binary_pixels(inverse_mask))

        inside_change = _count_binary_pixels(ImageChops.multiply(binary_change, mask_bin))
        outside_change = _count_binary_pixels(ImageChops.multiply(binary_change, inverse_mask))

        inside_sum = float(ImageStat.Stat(ImageChops.multiply(diff_gray, mask_bin)).sum[0])
        outside_sum = float(ImageStat.Stat(ImageChops.multiply(diff_gray, inverse_mask)).sum[0])
        inside_mean = inside_sum / (inside_pixels * 255.0)
        outside_mean = outside_sum / (outside_pixels * 255.0)

        ring_kernel = max(3, (boundary_ring_px * 2) + 1)
        dilated_mask = mask_bin.filter(ImageFilter.MaxFilter(ring_kernel))
        boundary_ring = ImageChops.subtract(dilated_mask, mask_bin).point(lambda value: 255 if value >= 128 else 0)
        boundary_pixels = max(1, _count_binary_pixels(boundary_ring))
        boundary_changed = _count_binary_pixels(ImageChops.multiply(binary_change, boundary_ring))

        metrics.update(
            {
                "changedPctInsideMask": round((inside_change * 100.0) / inside_pixels, 4),
                "changedPctOutsideMask": round((outside_change * 100.0) / outside_pixels, 4),
                "meanDiffInsideMask": round(inside_mean, 6),
                "meanDiffOutsideMask": round(outside_mean, 6),
                "insideMaskPixelCount": inside_pixels,
                "outsideMaskPixelCount": outside_pixels,
                "outsideLeakagePixelCount": outside_change,
                "outsideLeakagePct": round((outside_change * 100.0) / outside_pixels, 4),
                "boundaryRingPx": boundary_ring_px,
                "boundaryRingPixelCount": boundary_pixels,
                "boundarySpillPct": round((boundary_changed * 100.0) / boundary_pixels, 4),
            }
        )

    return metrics, diff_gray, binary_change, mask_bin


def _create_overlay_artifacts(
    *,
    edited_image: Image.Image,
    diff_gray: Image.Image,
    binary_change: Image.Image,
    mask_bin: Image.Image | None,
) -> tuple[bytes, bytes, bytes]:
    heatmap = ImageOps.colorize(diff_gray.convert("L"), black="#1e4fba", mid="#ffd84d", white="#e22626")
    overlay_base = edited_image.convert("RGBA")
    heat_rgba = heatmap.convert("RGBA")
    heat_alpha = diff_gray.convert("L").point(lambda value: min(190, int(value * 1.7)))
    heat_rgba.putalpha(heat_alpha)
    overlay_base.alpha_composite(heat_rgba)

    if mask_bin is not None:
        edge = ImageChops.subtract(
            mask_bin.filter(ImageFilter.MaxFilter(5)),
            mask_bin.filter(ImageFilter.MinFilter(5)),
        ).point(lambda value: 255 if value >= 128 else 0)
        edge_tint = Image.new("RGBA", overlay_base.size, (0, 255, 190, 170))
        edge_layer = Image.new("RGBA", overlay_base.size, (0, 0, 0, 0))
        edge_layer.paste(edge_tint, (0, 0), edge)
        overlay_base = Image.alpha_composite(overlay_base, edge_layer)

    heat_bytes = BytesIO()
    heatmap.save(heat_bytes, format="PNG")
    overlay_bytes = BytesIO()
    overlay_base.save(overlay_bytes, format="PNG")
    binary_bytes = BytesIO()
    binary_change.convert("L").save(binary_bytes, format="PNG")
    return heat_bytes.getvalue(), overlay_bytes.getvalue(), binary_bytes.getvalue()


def _create_mask_boundary_overlay(
    *,
    original_image: Image.Image,
    binary_change: Image.Image,
    mask_bin: Image.Image | None,
) -> bytes:
    base = original_image.convert("RGBA")
    change_mask = binary_change.convert("L").point(lambda value: 255 if value >= 128 else 0)
    change_layer = Image.new("RGBA", base.size, (255, 72, 40, 168))
    change_overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    change_overlay.paste(change_layer, (0, 0), change_mask)
    base = Image.alpha_composite(base, change_overlay)

    if mask_bin is not None:
        boundary = ImageChops.subtract(
            mask_bin.filter(ImageFilter.MaxFilter(5)),
            mask_bin.filter(ImageFilter.MinFilter(5)),
        ).point(lambda value: 255 if value >= 128 else 0)
        boundary_layer = Image.new("RGBA", base.size, (26, 188, 156, 210))
        overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
        overlay.paste(boundary_layer, (0, 0), boundary)
        base = Image.alpha_composite(base, overlay)

    output = BytesIO()
    base.save(output, format="PNG")
    return output.getvalue()


def _create_boundary_spill_overlay(
    *,
    base_image: Image.Image,
    lpips_map: Image.Image,
    inside_band_mask: Image.Image,
    outer_ring_mask: Image.Image,
) -> bytes:
    base = base_image.convert("RGBA")
    heatmap = ImageOps.colorize(lpips_map.convert("L"), black="#1e4fba", mid="#ffd84d", white="#e22626").convert("RGBA")
    alpha = lpips_map.convert("L").point(lambda value: min(180, int(value * 1.35)))
    heatmap.putalpha(alpha)
    base.alpha_composite(heatmap)

    inside_fill = Image.new("RGBA", base.size, (26, 188, 156, 80))
    inside_overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    inside_overlay.paste(inside_fill, (0, 0), inside_band_mask.convert("L"))
    base = Image.alpha_composite(base, inside_overlay)

    outer_fill = Image.new("RGBA", base.size, (214, 76, 196, 80))
    outer_overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    outer_overlay.paste(outer_fill, (0, 0), outer_ring_mask.convert("L"))
    base = Image.alpha_composite(base, outer_overlay)

    inner_edge = ImageChops.subtract(
        inside_band_mask.filter(ImageFilter.MaxFilter(5)),
        inside_band_mask.filter(ImageFilter.MinFilter(5)),
    ).point(lambda value: 255 if value >= 128 else 0)
    outer_edge = ImageChops.subtract(
        outer_ring_mask.filter(ImageFilter.MaxFilter(5)),
        outer_ring_mask.filter(ImageFilter.MinFilter(5)),
    ).point(lambda value: 255 if value >= 128 else 0)

    inner_edge_layer = Image.new("RGBA", base.size, (26, 188, 156, 210))
    inner_overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    inner_overlay.paste(inner_edge_layer, (0, 0), inner_edge)
    base = Image.alpha_composite(base, inner_overlay)

    outer_edge_layer = Image.new("RGBA", base.size, (214, 76, 196, 210))
    outer_edge_overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    outer_edge_overlay.paste(outer_edge_layer, (0, 0), outer_edge)
    base = Image.alpha_composite(base, outer_edge_overlay)

    output = BytesIO()
    base.save(output, format="PNG")
    return output.getvalue()


def _median_abs_deviation(values: list[float], center: float | None = None) -> float:
    if not values:
        return 0.0
    pivot = center if center is not None else float(median(values))
    return float(median([abs(value - pivot) for value in values]))


def _robust_score(value: float, center: float, spread: float) -> float:
    safe_spread = max(1e-6, spread)
    return abs(value - center) / safe_spread


def _normalize_scores(values: list[float]) -> list[float]:
    if not values:
        return []
    low = min(values)
    high = max(values)
    span = high - low
    if span <= 1e-9:
        return [0.0 for _ in values]
    return [max(0.0, min(1.0, (value - low) / span)) for value in values]


def _build_patch_boxes(width: int, height: int, patch_size: int, stride: int) -> tuple[list[tuple[int, int, int, int]], int, int]:
    patch = max(8, min(patch_size, width, height))
    step = max(4, stride)
    xs = list(range(0, max(1, width - patch + 1), step))
    ys = list(range(0, max(1, height - patch + 1), step))
    if not xs:
        xs = [0]
    if not ys:
        ys = [0]
    if xs[-1] != width - patch:
        xs.append(max(0, width - patch))
    if ys[-1] != height - patch:
        ys.append(max(0, height - patch))
    boxes = [(x, y, min(width, x + patch), min(height, y + patch)) for y in ys for x in xs]
    return boxes, len(xs), len(ys)


def _scores_to_map(scores: list[float], *, cols: int, rows: int, target_size: tuple[int, int]) -> tuple[Image.Image, list[float]]:
    normalized = _normalize_scores(scores)
    map_image = Image.new("L", (max(1, cols), max(1, rows)))
    map_image.putdata([int(round(value * 255.0)) for value in normalized])
    return map_image.resize(target_size, Image.Resampling.BICUBIC), normalized


def _score_map_mean(map_image: Image.Image, region_mask: Image.Image | None) -> float:
    score_l = map_image.convert("L")
    if region_mask is None:
        return float(ImageStat.Stat(score_l).mean[0]) / 255.0
    mask = region_mask.convert("L").point(lambda value: 255 if value >= 128 else 0)
    pixels = max(1, _count_binary_pixels(mask))
    masked_sum = float(ImageStat.Stat(ImageChops.multiply(score_l, mask)).sum[0])
    return masked_sum / (pixels * 255.0)


def _patch_entropy(gray_patch: Image.Image) -> float:
    hist = gray_patch.histogram()
    total = float(sum(hist))
    if total <= 0:
        return 0.0
    entropy = 0.0
    for count in hist:
        if count <= 0:
            continue
        p = count / total
        entropy -= p * math.log2(p)
    return entropy


def _heatmap_png(map_image: Image.Image) -> bytes:
    heatmap = ImageOps.colorize(map_image.convert("L"), black="#1e4fba", mid="#ffd84d", white="#e22626")
    output = BytesIO()
    heatmap.save(output, format="PNG")
    return output.getvalue()


def _heatmap_overlay_png(base_image: Image.Image, map_image: Image.Image) -> bytes:
    base = base_image.convert("RGBA")
    heatmap = ImageOps.colorize(map_image.convert("L"), black="#1e4fba", mid="#ffd84d", white="#e22626").convert("RGBA")
    alpha = map_image.convert("L").point(lambda value: min(190, int(value * 1.5)))
    heatmap.putalpha(alpha)
    base.alpha_composite(heatmap)
    output = BytesIO()
    base.save(output, format="PNG")
    return output.getvalue()


def _build_boundary_regions(mask_bin: Image.Image) -> tuple[Image.Image, Image.Image, Image.Image]:
    clean_mask = mask_bin.convert("L").point(lambda value: 255 if value >= 128 else 0)
    inner_kernel = max(3, (QC_BOUNDARY_RING_PX * 2) + 1)
    outer_kernel = max(3, (ADV_QC_OUTER_RING_PX * 2) + 1)
    inner_core = clean_mask.filter(ImageFilter.MinFilter(inner_kernel)).point(lambda value: 255 if value >= 128 else 0)
    inside_band = ImageChops.subtract(clean_mask, inner_core).point(lambda value: 255 if value >= 128 else 0)
    outside_ring = ImageChops.subtract(clean_mask.filter(ImageFilter.MaxFilter(outer_kernel)), clean_mask).point(
        lambda value: 255 if value >= 128 else 0
    )
    return inner_core, inside_band, outside_ring


def _derive_provisional_mask(original_image: Image.Image, edited_image: Image.Image) -> Image.Image:
    diff_gray = ImageChops.difference(original_image.convert("RGB"), edited_image.convert("RGB")).convert("L")
    return _threshold_change_mask(diff_gray, QC_DIFF_THRESHOLD)


def _box_iou(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    inter_x1, inter_y1 = max(ax1, bx1), max(ay1, by1)
    inter_x2, inter_y2 = min(ax2, bx2), min(ay2, by2)
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    inter_area = float((inter_x2 - inter_x1) * (inter_y2 - inter_y1))
    area_a = float(max(1, (ax2 - ax1) * (ay2 - ay1)))
    area_b = float(max(1, (bx2 - bx1) * (by2 - by1)))
    return inter_area / max(1e-6, area_a + area_b - inter_area)


def _select_top_regions(
    boxes: list[tuple[int, int, int, int]],
    normalized_scores: list[float],
    *,
    image_width: int,
    image_height: int,
    limit: int,
) -> list[dict[str, Any]]:
    ranked = sorted(range(len(normalized_scores)), key=lambda idx: normalized_scores[idx], reverse=True)
    output: list[dict[str, Any]] = []
    for idx in ranked:
        score = float(normalized_scores[idx])
        if score < 0.55:
            break
        box = boxes[idx]
        if any(_box_iou(box, (item["x"], item["y"], item["x"] + item["width"], item["y"] + item["height"])) > 0.45 for item in output):
            continue
        x1, y1, x2, y2 = box
        width = max(1, x2 - x1)
        height = max(1, y2 - y1)
        output.append(
            {
                "x": int(x1),
                "y": int(y1),
                "width": int(width),
                "height": int(height),
                "score": round(score, 4),
                "coveragePct": round((width * height * 100.0) / max(1, image_width * image_height), 3),
            }
        )
        if len(output) >= limit:
            break
    return output


def _advanced_qc_classification(mask_mean: float, outer_ring_mean: float, boundary_score: float) -> dict[str, Any]:
    fail_outer_threshold = max(0.30, mask_mean * 0.7)
    warn_outer_threshold = max(0.18, mask_mean * 0.45)
    fail_boundary_threshold = 0.60
    warn_boundary_threshold = 0.35

    outer_fail = outer_ring_mean > fail_outer_threshold
    boundary_fail = boundary_score > fail_boundary_threshold
    outer_warn = outer_ring_mean > warn_outer_threshold
    boundary_warn = boundary_score > warn_boundary_threshold

    if outer_fail or boundary_fail:
        status = "fail"
    elif outer_warn or boundary_warn:
        status = "warn"
    else:
        status = "pass"

    reasons: list[str] = []
    if outer_fail:
        reasons.append("outer-ring spill is above fail threshold")
    elif outer_warn:
        reasons.append("outer-ring spill is above warning threshold")
    if boundary_fail:
        reasons.append("boundary spill is above fail threshold")
    elif boundary_warn:
        reasons.append("boundary spill is above warning threshold")
    if not reasons:
        reasons.append("spill metrics are within thresholds")

    dominant_driver = max(
        [
            ("outer_ring", outer_ring_mean / max(fail_outer_threshold, 1e-6)),
            ("boundary_spill", boundary_score / max(fail_boundary_threshold, 1e-6)),
        ],
        key=lambda item: item[1],
    )[0]

    return {
        "status": status,
        "reasons": reasons,
        "dominantDriver": dominant_driver,
        "thresholds": {
            "outerRingWarn": round(warn_outer_threshold, 6),
            "outerRingFail": round(fail_outer_threshold, 6),
            "boundaryWarn": round(warn_boundary_threshold, 6),
            "boundaryFail": round(fail_boundary_threshold, 6),
        },
        "observed": {
            "maskMean": round(mask_mean, 6),
            "outerRingMean": round(outer_ring_mean, 6),
            "boundarySpill": round(boundary_score, 6),
        },
    }


def _run_advanced_frame_qc(
    *,
    original_image: Image.Image,
    edited_image: Image.Image,
    mask_bin: Image.Image | None,
) -> dict[str, Any]:
    source_rgb = original_image.convert("RGB")
    edited_rgb = edited_image.convert("RGB")
    if source_rgb.size != edited_rgb.size:
        edited_rgb = ImageOps.contain(edited_rgb, source_rgb.size, Image.Resampling.LANCZOS)
        fitted = Image.new("RGB", source_rgb.size, (0, 0, 0))
        fitted.paste(edited_rgb, ((source_rgb.width - edited_rgb.width) // 2, (source_rgb.height - edited_rgb.height) // 2))
        edited_rgb = fitted

    mask = mask_bin.convert("L").point(lambda value: 255 if value >= 128 else 0) if mask_bin is not None else _derive_provisional_mask(source_rgb, edited_rgb)
    inner_core_mask, inside_band_mask, outer_ring_mask = _build_boundary_regions(mask)

    source_gray = source_rgb.convert("L")
    edited_gray = edited_rgb.convert("L")
    source_edges = source_gray.filter(ImageFilter.FIND_EDGES)
    edited_edges = edited_gray.filter(ImageFilter.FIND_EDGES)
    source_residual = ImageChops.difference(source_gray, source_gray.filter(ImageFilter.GaussianBlur(radius=1.2)))
    edited_residual = ImageChops.difference(edited_gray, edited_gray.filter(ImageFilter.GaussianBlur(radius=1.2)))

    boxes, cols, rows = _build_patch_boxes(source_rgb.width, source_rgb.height, ADV_QC_PATCH_SIZE, ADV_QC_STRIDE)
    lpips_scores: list[float] = []
    sharp_raw_scores: list[float] = []
    entropy_values: list[float] = []
    noise_values: list[float] = []
    texture_raw_scores: list[float] = []
    sharp_edit_values: list[float] = []

    for box in boxes:
        source_patch_rgb = source_rgb.crop(box)
        edited_patch_rgb = edited_rgb.crop(box)
        source_patch_gray = source_gray.crop(box)
        edited_patch_gray = edited_gray.crop(box)
        diff_patch = ImageChops.difference(source_patch_rgb, edited_patch_rgb)
        diff_mean = sum(ImageStat.Stat(diff_patch).mean) / (3.0 * 255.0)

        edge_diff_patch = ImageChops.difference(source_edges.crop(box), edited_edges.crop(box))
        edge_diff_mean = float(ImageStat.Stat(edge_diff_patch).mean[0]) / 255.0
        lpips_scores.append(min(1.0, (0.65 * diff_mean) + (0.35 * edge_diff_mean)))

        sharp_source = float(ImageStat.Stat(source_edges.crop(box)).mean[0]) / 255.0
        sharp_edit = float(ImageStat.Stat(edited_edges.crop(box)).mean[0]) / 255.0
        sharp_edit_values.append(sharp_edit)
        sharp_raw_scores.append(abs(sharp_edit - sharp_source))

        entropy_values.append(_patch_entropy(edited_patch_gray))
        noise_patch = ImageChops.difference(edited_patch_gray, edited_patch_gray.filter(ImageFilter.MedianFilter(size=3)))
        noise_values.append(float(ImageStat.Stat(noise_patch).mean[0]) / 255.0)

        source_texture = float(ImageStat.Stat(source_residual.crop(box)).mean[0]) / 255.0
        edited_texture = float(ImageStat.Stat(edited_residual.crop(box)).mean[0]) / 255.0
        texture_raw_scores.append(abs(edited_texture - source_texture))

    sharp_center = float(median(sharp_edit_values)) if sharp_edit_values else 0.0
    sharp_spread = _median_abs_deviation(sharp_edit_values, sharp_center)
    sharp_scores = [
        min(1.0, score + (_robust_score(sharp_edit_values[idx], sharp_center, sharp_spread) / 3.0))
        for idx, score in enumerate(sharp_raw_scores)
    ]

    entropy_center = float(median(entropy_values)) if entropy_values else 0.0
    entropy_spread = _median_abs_deviation(entropy_values, entropy_center)
    noise_center = float(median(noise_values)) if noise_values else 0.0
    noise_spread = _median_abs_deviation(noise_values, noise_center)
    naturalness_scores = [
        min(
            1.0,
            (_robust_score(entropy_values[idx], entropy_center, entropy_spread) * 0.6)
            + (_robust_score(noise_values[idx], noise_center, noise_spread) * 0.4),
        )
        for idx in range(len(entropy_values))
    ]

    texture_center = float(median(texture_raw_scores)) if texture_raw_scores else 0.0
    texture_spread = _median_abs_deviation(texture_raw_scores, texture_center)
    texture_scores = [
        min(1.0, score + (_robust_score(score, texture_center, texture_spread) / 4.0)) for score in texture_raw_scores
    ]

    lpips_map, lpips_norm = _scores_to_map(lpips_scores, cols=cols, rows=rows, target_size=source_rgb.size)
    sharp_map, sharp_norm = _scores_to_map(sharp_scores, cols=cols, rows=rows, target_size=source_rgb.size)
    natural_map, natural_norm = _scores_to_map(naturalness_scores, cols=cols, rows=rows, target_size=source_rgb.size)
    texture_map, texture_norm = _scores_to_map(texture_scores, cols=cols, rows=rows, target_size=source_rgb.size)

    composite_scores = [
        (lpips_norm[idx] * 0.35)
        + (sharp_norm[idx] * 0.25)
        + (natural_norm[idx] * 0.20)
        + (texture_norm[idx] * 0.20)
        for idx in range(len(lpips_norm))
    ]
    composite_map, composite_norm = _scores_to_map(composite_scores, cols=cols, rows=rows, target_size=source_rgb.size)
    composite_binary = composite_map.point(lambda value: 255 if value >= 153 else 0)
    boundary_map_bytes = _create_mask_boundary_overlay(
        original_image=edited_rgb,
        binary_change=composite_binary,
        mask_bin=mask,
    )
    boundary_spill_map_bytes = _create_boundary_spill_overlay(
        base_image=edited_rgb,
        lpips_map=lpips_map,
        inside_band_mask=inside_band_mask,
        outer_ring_mask=outer_ring_mask,
    )

    lpips_global_mean = _score_map_mean(lpips_map, None)
    lpips_mask_mean = _score_map_mean(lpips_map, mask)
    lpips_outer_ring_mean = _score_map_mean(lpips_map, outer_ring_mask)
    sharp_mask_mean = _score_map_mean(sharp_map, mask)
    sharp_outer_ring_mean = _score_map_mean(sharp_map, outer_ring_mask)
    natural_mask_mean = _score_map_mean(natural_map, mask)
    natural_outer_ring_mean = _score_map_mean(natural_map, outer_ring_mask)
    texture_mask_mean = _score_map_mean(texture_map, mask)
    texture_outer_ring_mean = _score_map_mean(texture_map, outer_ring_mask)
    composite_mask_mean = _score_map_mean(composite_map, mask)
    composite_outer_ring_mean = _score_map_mean(composite_map, outer_ring_mask)

    outside_anomaly_pixels = _count_binary_pixels(ImageChops.multiply(composite_binary, outer_ring_mask))
    outside_ring_pixels = max(1, _count_binary_pixels(outer_ring_mask))
    outer_ring_anomaly_ratio = outside_anomaly_pixels / outside_ring_pixels
    boundary_spill_score = lpips_outer_ring_mean / max(1e-6, _score_map_mean(lpips_map, inside_band_mask))

    top_regions = _select_top_regions(
        boxes,
        composite_norm,
        image_width=source_rgb.width,
        image_height=source_rgb.height,
        limit=ADV_QC_TOP_REGION_COUNT,
    )
    classification = _advanced_qc_classification(composite_mask_mean, composite_outer_ring_mean, boundary_spill_score)

    return {
        "status": classification["status"],
        "classification": classification,
        "metrics": {
            "compositeImpactGlobal": round(_score_map_mean(composite_map, None), 6),
            "compositeImpactMask": round(composite_mask_mean, 6),
            "compositeImpactOuterRing": round(composite_outer_ring_mean, 6),
            "lpips_global_mean": round(lpips_global_mean, 6),
            "lpips_mask_mean": round(lpips_mask_mean, 6),
            "lpips_outer_ring_mean": round(lpips_outer_ring_mean, 6),
            "sharpness_mask_mean": round(sharp_mask_mean, 6),
            "sharpness_outer_ring_mean": round(sharp_outer_ring_mean, 6),
            "naturalness_mask_mean": round(natural_mask_mean, 6),
            "naturalness_outer_ring_mean": round(natural_outer_ring_mean, 6),
            "texture_mask_mean": round(texture_mask_mean, 6),
            "texture_outer_ring_mean": round(texture_outer_ring_mean, 6),
            "boundary_spill_score": round(boundary_spill_score, 6),
            "outer_ring_anomaly_ratio": round(outer_ring_anomaly_ratio, 6),
            "inside_boundary_mean": round(_score_map_mean(composite_map, inside_band_mask), 6),
            "outside_boundary_mean": round(_score_map_mean(composite_map, outer_ring_mask), 6),
        },
        "topRegions": top_regions,
        "tooltips": {
            "composite": "Weighted summary of perceptual change, sharpness mismatch, naturalness, and microtexture consistency.",
            "lpips": "Perceptual change proxy map highlighting visually significant differences from the source frame.",
            "sharpness": "Detects local focus or edge sharpness mismatch between edited and source frame content.",
            "boundary": "Compares anomaly intensity immediately inside and outside the intended edit boundary.",
            "naturalness": "No-reference naturalness proxy highlighting statistically unusual local patches.",
            "texture": "Microtexture / noise consistency proxy to flag over-smoothed or over-sharpened regions.",
        },
        "artifacts": {
            "compositeMap": _heatmap_png(composite_map),
            "compositeOverlay": _heatmap_overlay_png(edited_rgb, composite_map),
            "lpipsMap": _heatmap_png(lpips_map),
            "lpipsOverlay": _heatmap_overlay_png(edited_rgb, lpips_map),
            "sharpnessMap": _heatmap_png(sharp_map),
            "naturalnessMap": _heatmap_png(natural_map),
            "textureMap": _heatmap_png(texture_map),
            "boundaryMap": boundary_map_bytes,
            "boundarySpillMap": boundary_spill_map_bytes,
            "maskUsed": _create_mask_boundary_overlay(
                original_image=source_rgb,
                binary_change=mask,
                mask_bin=mask,
            ),
        },
    }


def _report_safe_stem(*parts: str) -> str:
    joined = "_".join(part for part in parts if part)
    return re.sub(r"[^a-zA-Z0-9_-]+", "", joined)[:80] or "artifact"


def _frame_role(task: dict[str, Any], frame_id: str) -> str:
    for segment in task.get("segments", []):
        if segment.get("startFrameId") == frame_id:
            return "start"
        if segment.get("endFrameId") == frame_id:
            return "end"
    return "unlinked"


def _frame_variant_prompt(variant: dict[str, Any]) -> str:
    prompt_value = variant.get("generationSettings", {}).get("prompt") if isinstance(variant.get("generationSettings"), dict) else None
    if isinstance(prompt_value, str) and prompt_value.strip():
        return prompt_value.strip()
    return f"Prompt hash {variant.get('promptHash') or 'unknown'}"


def _asset_processing_duration_sec(asset: dict[str, Any]) -> float | None:
    direct_value = asset.get("processingDurationSec")
    if isinstance(direct_value, (int, float)):
        return float(direct_value)
    return _processing_duration_seconds(asset.get("startedAt"), asset.get("finishedAt"))


def _build_frame_report_row(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    paths: AssetPaths,
    report_id: str,
    frame_id: str,
    variant_id: str,
    tests: set[str],
) -> dict[str, Any]:
    frames = task.get("frames", {})
    frame = frames.get(frame_id)
    if not isinstance(frame, dict):
        raise RuntimeError(f"Frame {frame_id} not found")
    variant = next((item for item in frame.get("variants", []) if item.get("variantId") == variant_id), None)
    if not isinstance(variant, dict) or not variant.get("outputKey"):
        raise RuntimeError(f"Variant {variant_id} not found for frame {frame_id}")

    original_frame_bytes = asset_store.read_bytes(frame["captureKey"])
    edited_frame_bytes = asset_store.read_bytes(variant["outputKey"])
    mask_key = variant.get("patchMeta", {}).get("maskKey") if isinstance(variant.get("patchMeta"), dict) else None
    mask_bytes = asset_store.read_bytes(mask_key) if isinstance(mask_key, str) else None

    original_frame_image = ImageOps.exif_transpose(Image.open(BytesIO(original_frame_bytes))).convert("RGB")
    edited_frame_image = ImageOps.exif_transpose(Image.open(BytesIO(edited_frame_bytes))).convert("RGB")
    original_size = original_frame_image.size
    edited_size = edited_frame_image.size
    comparison_preprocess = (
        {
            "sizeAdjusted": True,
            "mode": "contain_and_pad",
            "originalSize": {"width": original_size[0], "height": original_size[1]},
            "editedSize": {"width": edited_size[0], "height": edited_size[1]},
        }
        if edited_size != original_size
        else None
    )
    frame_mask = _load_optional_mask(mask_bytes, original_frame_image.size)

    standard_payload: dict[str, Any] | None = None
    if "frame_diff" in tests:
        frame_metrics, frame_diff, frame_binary, frame_mask_bin = _analyze_image_pair(
            original_frame_image,
            edited_frame_image,
            mask_image=frame_mask,
            threshold=QC_DIFF_THRESHOLD,
            boundary_ring_px=QC_BOUNDARY_RING_PX,
        )
        frame_heatmap_bytes, frame_overlay_bytes, frame_binary_bytes = _create_overlay_artifacts(
            edited_image=edited_frame_image,
            diff_gray=frame_diff,
            binary_change=frame_binary,
            mask_bin=frame_mask_bin,
        )
        frame_boundary_overlay_bytes = _create_mask_boundary_overlay(
            original_image=original_frame_image,
            binary_change=frame_binary,
            mask_bin=frame_mask_bin,
        )
        stem_base = _report_safe_stem("frame", frame_id[-8:], variant_id[-8:])
        frame_heatmap_key = paths.report_artifact(report_id, f"{stem_base}_heatmap", ".png")
        frame_overlay_key = paths.report_artifact(report_id, f"{stem_base}_overlay", ".png")
        frame_binary_key = paths.report_artifact(report_id, f"{stem_base}_binary", ".png")
        frame_boundary_overlay_key = paths.report_artifact(report_id, f"{stem_base}_boundary", ".png")
        asset_store.put_bytes(frame_heatmap_key, frame_heatmap_bytes, content_type="image/png")
        asset_store.put_bytes(frame_overlay_key, frame_overlay_bytes, content_type="image/png")
        asset_store.put_bytes(frame_binary_key, frame_binary_bytes, content_type="image/png")
        asset_store.put_bytes(frame_boundary_overlay_key, frame_boundary_overlay_bytes, content_type="image/png")
        standard_payload = {
            "metrics": frame_metrics,
            "artifacts": {
                "heatmapKey": frame_heatmap_key,
                "overlayKey": frame_overlay_key,
                "binaryChangeKey": frame_binary_key,
                "boundaryOverlayKey": frame_boundary_overlay_key,
            },
        }
    else:
        frame_mask_bin = frame_mask.convert("L").point(lambda value: 255 if value >= 128 else 0) if frame_mask else None

    advanced_payload: dict[str, Any] | None = None
    selected_advanced_tests = sorted(test_name for test_name in tests if test_name in FRAME_REPORT_ADVANCED_TESTS)
    if selected_advanced_tests:
        advanced_result = _run_advanced_frame_qc(
            original_image=original_frame_image,
            edited_image=edited_frame_image,
            mask_bin=frame_mask_bin,
        )
        advanced_artifact_keys: dict[str, str] = {}
        stem_base = _report_safe_stem("frame", frame_id[-8:], variant_id[-8:], "advanced")
        for artifact_name, artifact_bytes in (advanced_result.get("artifacts") or {}).items():
            artifact_key = paths.report_artifact(report_id, f"{stem_base}_{artifact_name}", ".png")
            asset_store.put_bytes(artifact_key, artifact_bytes, content_type="image/png")
            advanced_artifact_keys[f"{artifact_name}Key"] = artifact_key
        advanced_payload = {
            "status": advanced_result.get("status") or "pass",
            "classification": advanced_result.get("classification") or {},
            "selectedTests": selected_advanced_tests,
            "metrics": advanced_result.get("metrics") or {},
            "topRegions": advanced_result.get("topRegions") or [],
            "tooltips": advanced_result.get("tooltips") or {},
            "artifacts": advanced_artifact_keys,
        }

    return {
        "assetType": "frame_variant",
        "frameId": frame_id,
        "variantId": variant_id,
        "role": _frame_role(task, frame_id),
        "frameIndex": frame.get("frameIndex"),
        "timecode": frame.get("timecode"),
        "createdAt": variant.get("createdAt"),
        "model": variant.get("model"),
        "variantType": variant.get("type"),
        "processingDurationSec": _asset_processing_duration_sec(variant),
        "prompt": _frame_variant_prompt(variant),
        "originalFrameKey": frame.get("captureKey"),
        "editedFrameKey": variant.get("outputKey"),
        "maskKey": mask_key if isinstance(mask_key, str) else None,
        "comparisonPreprocess": comparison_preprocess,
        "standard": standard_payload,
        "advanced": advanced_payload,
    }


def _build_external_frame_report_row(
    *,
    asset_store: AssetStore,
    paths: AssetPaths,
    report_id: str,
    pair_id: str,
    original_frame_bytes: bytes,
    edited_frame_bytes: bytes,
    original_filename: str | None,
    edited_filename: str | None,
    label: str,
    created_at: str | None,
    original_frame_key: str | None,
    edited_frame_key: str | None,
    tests: set[str],
) -> dict[str, Any]:
    original_frame_image = ImageOps.exif_transpose(Image.open(BytesIO(original_frame_bytes))).convert("RGB")
    edited_frame_image = ImageOps.exif_transpose(Image.open(BytesIO(edited_frame_bytes))).convert("RGB")
    original_size = original_frame_image.size
    edited_size = edited_frame_image.size
    comparison_preprocess = (
        {
            "sizeAdjusted": True,
            "mode": "contain_and_pad",
            "originalSize": {"width": original_size[0], "height": original_size[1]},
            "editedSize": {"width": edited_size[0], "height": edited_size[1]},
        }
        if edited_size != original_size
        else None
    )

    standard_payload: dict[str, Any] | None = None
    frame_mask_bin: Image.Image | None = None
    if "frame_diff" in tests:
        frame_metrics, frame_diff, frame_binary, frame_mask_bin = _analyze_image_pair(
            original_frame_image,
            edited_frame_image,
            mask_image=None,
            threshold=QC_DIFF_THRESHOLD,
            boundary_ring_px=QC_BOUNDARY_RING_PX,
        )
        frame_heatmap_bytes, frame_overlay_bytes, frame_binary_bytes = _create_overlay_artifacts(
            edited_image=edited_frame_image,
            diff_gray=frame_diff,
            binary_change=frame_binary,
            mask_bin=frame_mask_bin,
        )
        frame_boundary_overlay_bytes = _create_mask_boundary_overlay(
            original_image=original_frame_image,
            binary_change=frame_binary,
            mask_bin=frame_mask_bin,
        )
        stem_base = _report_safe_stem("external", pair_id[-8:])
        frame_heatmap_key = paths.report_artifact(report_id, f"{stem_base}_heatmap", ".png")
        frame_overlay_key = paths.report_artifact(report_id, f"{stem_base}_overlay", ".png")
        frame_binary_key = paths.report_artifact(report_id, f"{stem_base}_binary", ".png")
        frame_boundary_overlay_key = paths.report_artifact(report_id, f"{stem_base}_boundary", ".png")
        asset_store.put_bytes(frame_heatmap_key, frame_heatmap_bytes, content_type="image/png")
        asset_store.put_bytes(frame_overlay_key, frame_overlay_bytes, content_type="image/png")
        asset_store.put_bytes(frame_binary_key, frame_binary_bytes, content_type="image/png")
        asset_store.put_bytes(frame_boundary_overlay_key, frame_boundary_overlay_bytes, content_type="image/png")
        standard_payload = {
            "metrics": frame_metrics,
            "artifacts": {
                "heatmapKey": frame_heatmap_key,
                "overlayKey": frame_overlay_key,
                "binaryChangeKey": frame_binary_key,
                "boundaryOverlayKey": frame_boundary_overlay_key,
            },
        }

    advanced_payload: dict[str, Any] | None = None
    selected_advanced_tests = sorted(test_name for test_name in tests if test_name in FRAME_REPORT_ADVANCED_TESTS)
    if selected_advanced_tests:
        advanced_result = _run_advanced_frame_qc(
            original_image=original_frame_image,
            edited_image=edited_frame_image,
            mask_bin=frame_mask_bin,
        )
        advanced_artifact_keys: dict[str, str] = {}
        stem_base = _report_safe_stem("external", pair_id[-8:], "advanced")
        for artifact_name, artifact_bytes in (advanced_result.get("artifacts") or {}).items():
            artifact_key = paths.report_artifact(report_id, f"{stem_base}_{artifact_name}", ".png")
            asset_store.put_bytes(artifact_key, artifact_bytes, content_type="image/png")
            advanced_artifact_keys[f"{artifact_name}Key"] = artifact_key
        advanced_payload = {
            "status": advanced_result.get("status") or "pass",
            "classification": advanced_result.get("classification") or {},
            "selectedTests": selected_advanced_tests,
            "metrics": advanced_result.get("metrics") or {},
            "topRegions": advanced_result.get("topRegions") or [],
            "tooltips": advanced_result.get("tooltips") or {},
            "artifacts": advanced_artifact_keys,
        }

    persisted_original_key = original_frame_key
    if not persisted_original_key:
        original_output = BytesIO()
        original_frame_image.save(original_output, format="PNG")
        persisted_original_key = paths.report_artifact(
            report_id,
            _report_safe_stem("external", pair_id[-8:], hashlib.sha1(original_frame_bytes).hexdigest()[:8], "original"),
            ".png",
        )
        asset_store.put_bytes(persisted_original_key, original_output.getvalue(), content_type="image/png")
    persisted_edited_key = edited_frame_key
    if not persisted_edited_key:
        edited_output = BytesIO()
        edited_frame_image.save(edited_output, format="PNG")
        persisted_edited_key = paths.report_artifact(
            report_id,
            _report_safe_stem("external", pair_id[-8:], hashlib.sha1(edited_frame_bytes).hexdigest()[:8], "edited"),
            ".png",
        )
        asset_store.put_bytes(persisted_edited_key, edited_output.getvalue(), content_type="image/png")

    return {
        "assetType": "external_frame_pair",
        "pairId": pair_id,
        "role": "external",
        "label": label,
        "createdAt": created_at,
        "prompt": "External upload",
        "originalFilename": original_filename,
        "editedFilename": edited_filename,
        "originalFrameKey": persisted_original_key,
        "editedFrameKey": persisted_edited_key,
        "comparisonPreprocess": comparison_preprocess,
        "standard": standard_payload,
        "advanced": advanced_payload,
    }


def _build_external_image_pair_report_row(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    paths: AssetPaths,
    report_id: str,
    pair_id: str,
    tests: set[str],
) -> dict[str, Any]:
    pair = next(
        (
            item
            for item in task.get("externalQcPairs", [])
            if isinstance(item, dict) and str(item.get("pairId") or "") == pair_id
        ),
        None,
    )
    if not isinstance(pair, dict):
        raise RuntimeError(f"External QC pair {pair_id} not found")
    original_key = str(pair.get("originalKey") or "")
    edited_key = str(pair.get("editedKey") or "")
    if not original_key or not edited_key:
        raise RuntimeError(f"External QC pair {pair_id} is incomplete")

    return _build_external_frame_report_row(
        asset_store=asset_store,
        paths=paths,
        report_id=report_id,
        pair_id=pair_id,
        original_frame_bytes=asset_store.read_bytes(original_key),
        edited_frame_bytes=asset_store.read_bytes(edited_key),
        original_filename=pair.get("originalFilename"),
        edited_filename=pair.get("editedFilename"),
        label=pair.get("name") or "External frame comparison",
        created_at=pair.get("createdAt"),
        original_frame_key=original_key,
        edited_frame_key=edited_key,
        tests=tests,
    )


def _build_video_report_row(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    store: S3JsonStore,
    paths: AssetPaths,
    report_id: str,
    gen_id: str,
    tests: set[str],
    settings: Any,
) -> dict[str, Any]:
    generation = task.get("segmentGenerations", {}).get(gen_id)
    if not isinstance(generation, dict):
        raise RuntimeError(f"Generation {gen_id} not found")
    if generation.get("status") != "complete" or not generation.get("outputKey"):
        raise RuntimeError(f"Generation {gen_id} is not complete")
    segment_id = generation.get("segmentId")
    segment = next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)
    if not isinstance(segment, dict):
        raise RuntimeError(f"Segment missing for generation {gen_id}")

    start_frame = task.get("frames", {}).get(segment["startFrameId"])
    end_frame = task.get("frames", {}).get(segment.get("endFrameId")) if segment.get("endFrameId") else None
    if not isinstance(start_frame, dict):
        raise RuntimeError("Start frame metadata missing for report build")

    def _resolve_variant(frame_record: dict[str, Any], preferred_variant_id: Any, preferred_output_keys: list[Any] | None = None) -> tuple[str | None, dict[str, Any]]:
        resolved_variant_id = preferred_variant_id if isinstance(preferred_variant_id, str) and preferred_variant_id else None
        variants = frame_record.get("variants", [])
        resolved_variant = (
            next((item for item in variants if item.get("variantId") == resolved_variant_id), None)
            if resolved_variant_id
            else None
        )
        if resolved_variant and resolved_variant.get("outputKey"):
            return resolved_variant_id, resolved_variant
        if preferred_output_keys:
            for key in preferred_output_keys:
                if not isinstance(key, str) or not key:
                    continue
                by_output = next((item for item in variants if item.get("outputKey") == key), None)
                if by_output and by_output.get("outputKey"):
                    return str(by_output.get("variantId")), by_output
        selected_variant_id = frame_record.get("selectedVariantId")
        if isinstance(selected_variant_id, str) and selected_variant_id:
            selected_variant = next((item for item in variants if item.get("variantId") == selected_variant_id), None)
            if selected_variant and selected_variant.get("outputKey"):
                return selected_variant_id, selected_variant
        return None, {"outputKey": frame_record["captureKey"], "patchMeta": {}}

    source_first_variant_id, source_first_variant = _resolve_variant(
        start_frame,
        generation.get("sourceFirstFrameVariantId"),
        [generation.get("sourceFirstFrameResolvedKey"), generation.get("inputFirstFrameKey")],
    )
    source_last_variant_id = None
    source_last_variant = None
    if isinstance(end_frame, dict) and end_frame.get("captureKey"):
        source_last_variant_id, source_last_variant = _resolve_variant(
            end_frame,
            generation.get("sourceLastFrameVariantId"),
            [generation.get("sourceLastFrameResolvedKey"), generation.get("inputLastFrameKey")],
        )

    run_standard_video = bool({"video_diff", "video_frame_evidence"} & tests)
    standard_payload: dict[str, Any] | None = None
    if run_standard_video:
        fps_info = task["video"]["editSource"]["fps"]
        target_fps = Fraction(int(fps_info["num"]), int(fps_info["den"]))
        source_width = int(task["video"]["editSource"]["width"])
        source_height = int(task["video"]["editSource"]["height"])
        analysis_width, analysis_height = _target_by_orientation(
            source_width,
            source_height,
            landscape=(960, 540),
            portrait=(540, 960),
        )

        s3 = boto3.client("s3")
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            original_segment_key = _ensure_segment_clip(
                s3=s3,
                asset_store=asset_store,
                asset_paths=paths,
                task=task,
                segment=segment,
                assets_bucket=settings.assets_bucket,
            )
            original_segment_path = td_path / "segment_original.mp4"
            generated_segment_path = td_path / "segment_generated.mp4"
            original_standard_path = td_path / "segment_original_qc.mp4"
            generated_standard_path = td_path / "segment_generated_qc.mp4"
            _download_s3(s3, settings.assets_bucket, original_segment_key, original_segment_path)
            _download_s3(s3, settings.assets_bucket, generation["outputKey"], generated_segment_path)

            transcode_to_cfr(
                str(original_segment_path),
                str(original_standard_path),
                target_fps,
                target_width=analysis_width,
                target_height=analysis_height,
                crf=20,
                preset="veryfast",
                audio_bitrate="96k",
            )
            transcode_to_cfr(
                str(generated_segment_path),
                str(generated_standard_path),
                target_fps,
                target_width=analysis_width,
                target_height=analysis_height,
                crf=20,
                preset="veryfast",
                audio_bitrate="96k",
            )
            original_probe = ffprobe_video(str(original_standard_path))
            generated_probe = ffprobe_video(str(generated_standard_path))
            alignment_source_frames = _load_video_alignment_source_frames(
                original_standard_path,
                td_path / "standard_alignment",
                max_frames=VIDEO_COMPARE_ALIGNMENT_SCAN_FRAMES,
            )
            video_alignment = _estimate_generated_source_offset(
                source_frames=alignment_source_frames,
                generated_path=generated_standard_path,
                generated_probe=generated_probe,
                source_fps=target_fps,
                work_dir=td_path / "standard_alignment",
                prefix="standard",
            )
            source_frame_offset = max(0, int(video_alignment.get("sourceFrameOffset") or 0))
            source_frame_count = int(original_probe.get("frame_count") or 0)
            generated_frame_count = int(generated_probe.get("frame_count") or 0)
            source_offset_sec = source_frame_offset / float(target_fps)
            common_duration_sec = max(
                0.1,
                min(
                    max(0.0, float(original_probe.get("duration_sec") or 0.0) - source_offset_sec),
                    float(generated_probe.get("duration_sec") or 0.0),
                ),
            )
            sample_rows = _frame_aligned_sample_rows(
                source_frame_offset=source_frame_offset,
                source_frame_count=source_frame_count,
                generated_frame_count=generated_frame_count,
                fps=target_fps,
                sample_fps=QC_SAMPLE_FPS,
            )
            if not sample_rows:
                raise RuntimeError("No sampled frames available for QC analysis")

            video_mask_key = (
                source_first_variant.get("patchMeta", {}).get("maskKey")
                if isinstance(source_first_variant.get("patchMeta"), dict)
                else None
            )
            video_mask_bytes = asset_store.read_bytes(video_mask_key) if isinstance(video_mask_key, str) else None
            video_mask = _load_optional_mask(video_mask_bytes, (analysis_width, analysis_height))
            per_frame_rows: list[dict[str, Any]] = []
            for sample_row in sample_rows:
                frame_idx = int(sample_row["index"])
                source_frame_index = int(sample_row["sourceFrameIndex"])
                generated_frame_index = int(sample_row["generatedFrameIndex"])
                orig_frame_path = td_path / "orig_frames" / f"frame_{frame_idx:05d}.png"
                gen_frame_path = td_path / "gen_frames" / f"frame_{frame_idx:05d}.png"
                extract_frame_png(str(original_standard_path), source_frame_index, str(orig_frame_path))
                extract_frame_png(str(generated_standard_path), generated_frame_index, str(gen_frame_path))
                orig_image = Image.open(orig_frame_path).convert("RGB")
                gen_image = Image.open(gen_frame_path).convert("RGB")
                row_metrics, row_diff, row_binary, _ = _analyze_image_pair(
                    orig_image,
                    gen_image,
                    mask_image=video_mask,
                    threshold=QC_DIFF_THRESHOLD,
                    boundary_ring_px=QC_BOUNDARY_RING_PX,
                )
                per_frame_rows.append(
                    {
                        "index": frame_idx,
                        "timeSec": float(sample_row["timeSec"]),
                        "generatedTimeSec": float(sample_row["generatedTimeSec"]),
                        "sourceFrameIndex": source_frame_index,
                        "generatedFrameIndex": generated_frame_index,
                        "sourceFrameOffset": source_frame_offset,
                        **row_metrics,
                        "_original": orig_image,
                        "_diff": row_diff,
                        "_binary": row_binary,
                        "_edited": gen_image,
                    }
                )

            changed_total_values = [float(item.get("changedPctTotal") or 0.0) for item in per_frame_rows]
            outside_values = [float(item.get("outsideLeakagePct") or 0.0) for item in per_frame_rows if item.get("outsideLeakagePct") is not None]
            mean_diff_values = [float(item.get("meanDiffTotal") or 0.0) for item in per_frame_rows]
            first_frame_metrics = (
                {key: value for key, value in per_frame_rows[0].items() if not key.startswith("_")}
                if per_frame_rows
                else None
            )
            last_frame_metrics = (
                {key: value for key, value in per_frame_rows[-1].items() if not key.startswith("_")}
                if per_frame_rows
                else None
            )

            ssim_log = td_path / "ssim.log"
            psnr_log = td_path / "psnr.log"
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-ss",
                    f"{source_offset_sec:.6f}",
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(original_standard_path),
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(generated_standard_path),
                    "-lavfi",
                    f"ssim=stats_file={ssim_log}",
                    "-shortest",
                    "-f",
                    "null",
                    "-",
                ]
            )
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-ss",
                    f"{source_offset_sec:.6f}",
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(original_standard_path),
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(generated_standard_path),
                    "-lavfi",
                    f"psnr=stats_file={psnr_log}",
                    "-shortest",
                    "-f",
                    "null",
                    "-",
                ]
            )
            ssim_values = _parse_metric_log(ssim_log, re.compile(r"All:(?P<value>[0-9.]+)"), "value")
            psnr_values = _parse_metric_log(psnr_log, re.compile(r"psnr_avg:(?P<value>[0-9.]+)"), "value")
            vmaf_metrics = _run_optional_vmaf(original_standard_path, generated_standard_path, td_path / "vmaf.json")

            rank_key = (
                (lambda row: float(row.get("outsideLeakagePct") or 0.0))
                if video_mask is not None
                else (lambda row: float(row.get("changedPctTotal") or 0.0))
            )
            ranked_rows = sorted(per_frame_rows, key=rank_key, reverse=True)
            selected_rows = ranked_rows[:5]
            if per_frame_rows:
                selected_rows.append(per_frame_rows[len(per_frame_rows) // 2])
            dedup_selected = {int(row["index"]): row for row in selected_rows}

            drift_rows: list[dict[str, Any]] = []
            drift_frame_count = int(generated_probe.get("frame_count") or 0)
            for row in per_frame_rows:
                expected_generated_frame_index = max(0, min(drift_frame_count - 1, int(row.get("generatedFrameIndex") or 0)))
                matched_generated_frame_index, matched_generated_image, match_similarity = _best_aligned_generated_frame_index(
                    generated_path=generated_standard_path,
                    source_image=row["_original"],
                    expected_frame_index=expected_generated_frame_index,
                    frame_count=drift_frame_count,
                    work_dir=td_path / "standard_drift",
                    prefix=f"{gen_id}_{int(row.get('index') or 0):04d}",
                    search_radius=3,
                )
                drift_delta_frames = int(matched_generated_frame_index - expected_generated_frame_index)
                row["expectedGeneratedFrameIndex"] = expected_generated_frame_index
                row["matchedGeneratedFrameIndex"] = matched_generated_frame_index
                row["frameDeltaDrift"] = drift_delta_frames
                row["frameDeltaDriftSec"] = round(drift_delta_frames / float(target_fps), 4)
                row["matchSimilarity"] = match_similarity
                row["_matchedGenerated"] = matched_generated_image
                drift_rows.append(
                    {
                        "index": int(row.get("index") or 0),
                        "sourceFrameIndex": int(row.get("sourceFrameIndex") or 0),
                        "generatedFrameIndex": expected_generated_frame_index,
                        "matchedGeneratedFrameIndex": matched_generated_frame_index,
                        "frameDeltaDrift": drift_delta_frames,
                        "frameDeltaDriftSec": round(drift_delta_frames / float(target_fps), 4),
                        "matchSimilarity": match_similarity,
                    }
                )

            selected_frame_artifacts: list[dict[str, Any]] = []
            for frame_idx in sorted(dedup_selected):
                row = dedup_selected[frame_idx]
                matched_generated_image = row.get("_matchedGenerated") or row["_edited"]
                if isinstance(matched_generated_image, Image.Image) and matched_generated_image.size != row["_original"].size:
                    matched_generated_image = matched_generated_image.resize(row["_original"].size, Image.Resampling.LANCZOS)
                matched_diff_gray, _matched_diff_heatmap = _diff_heatmap_image(row["_original"], matched_generated_image)
                heatmap_bytes, overlay_bytes, binary_bytes = _create_overlay_artifacts(
                    edited_image=matched_generated_image,
                    diff_gray=matched_diff_gray,
                    binary_change=row["_binary"],
                    mask_bin=None,
                )
                stem_base = _report_safe_stem("video", gen_id[-8:], f"frame{frame_idx:03d}")
                original_frame_key = paths.report_artifact(report_id, f"{stem_base}_source", ".png")
                generated_frame_key = paths.report_artifact(report_id, f"{stem_base}_generated", ".png")
                heatmap_key = paths.report_artifact(report_id, f"{stem_base}_heatmap", ".png")
                overlay_key = paths.report_artifact(report_id, f"{stem_base}_overlay", ".png")
                binary_key = paths.report_artifact(report_id, f"{stem_base}_binary", ".png")
                asset_store.put_bytes(original_frame_key, _image_to_png_bytes(row["_original"]), content_type="image/png")
                asset_store.put_bytes(generated_frame_key, _image_to_png_bytes(matched_generated_image), content_type="image/png")
                asset_store.put_bytes(heatmap_key, heatmap_bytes, content_type="image/png")
                asset_store.put_bytes(overlay_key, overlay_bytes, content_type="image/png")
                asset_store.put_bytes(binary_key, binary_bytes, content_type="image/png")
                selected_frame_artifacts.append(
                    {
                        "index": frame_idx,
                        "timeSec": row["timeSec"],
                        "generatedTimeSec": row.get("generatedTimeSec"),
                        "sourceFrameIndex": row.get("sourceFrameIndex"),
                        "generatedFrameIndex": row.get("generatedFrameIndex"),
                        "matchedGeneratedFrameIndex": row.get("matchedGeneratedFrameIndex"),
                        "expectedGeneratedFrameIndex": row.get("expectedGeneratedFrameIndex"),
                        "frameDeltaDrift": row.get("frameDeltaDrift"),
                        "frameDeltaDriftSec": row.get("frameDeltaDriftSec"),
                        "matchSimilarity": row.get("matchSimilarity"),
                        "sourceFrameOffset": row.get("sourceFrameOffset"),
                        "changedPctTotal": row["changedPctTotal"],
                        "outsideLeakagePct": row.get("outsideLeakagePct"),
                        "originalFrameKey": original_frame_key,
                        "generatedFrameKey": generated_frame_key,
                        "heatmapKey": heatmap_key,
                        "overlayKey": overlay_key,
                        "binaryChangeKey": binary_key,
                    }
                )

            diff_video_path = td_path / "diff_map.mp4"
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-ss",
                    f"{source_offset_sec:.6f}",
                    "-i",
                    str(original_standard_path),
                    "-i",
                    str(generated_standard_path),
                    "-filter_complex",
                    "[0:v][1:v]blend=all_mode=difference,eq=contrast=2.0:brightness=0.02:saturation=1.5[v]",
                    "-map",
                    "[v]",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-shortest",
                    str(diff_video_path),
                ]
            )
            diff_video_key = paths.report_artifact(report_id, _report_safe_stem("video", gen_id[-8:], "diff_map"), ".mp4")
            _upload_s3(s3, settings.assets_bucket, diff_video_key, diff_video_path, "video/mp4")
            diff_video_poster_path = td_path / "diff_map_poster.png"
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-i",
                    str(diff_video_path),
                    "-frames:v",
                    "1",
                    str(diff_video_poster_path),
                ]
            )
            diff_video_poster_key = paths.report_artifact(report_id, _report_safe_stem("video", gen_id[-8:], "diff_map_poster"), ".png")
            _upload_s3(s3, settings.assets_bucket, diff_video_poster_key, diff_video_poster_path, "image/png")

            timeline_rows = [{key: value for key, value in row.items() if not key.startswith("_")} for row in per_frame_rows]
            timeline_csv = "index,timeSec,generatedTimeSec,sourceFrameIndex,generatedFrameIndex,matchedGeneratedFrameIndex,frameDeltaDrift,frameDeltaDriftSec,matchSimilarity,sourceFrameOffset,changedPctTotal,outsideLeakagePct,meanDiffTotal,psnr\n" + "\n".join(
                f"{item.get('index')},{item.get('timeSec')},{item.get('generatedTimeSec')},{item.get('sourceFrameIndex')},{item.get('generatedFrameIndex')},{item.get('matchedGeneratedFrameIndex')},{item.get('frameDeltaDrift')},{item.get('frameDeltaDriftSec')},{item.get('matchSimilarity')},{item.get('sourceFrameOffset')},{item.get('changedPctTotal')},{item.get('outsideLeakagePct')},{item.get('meanDiffTotal')},{item.get('psnr')}"
                for item in timeline_rows
            )
            timeline_csv_key = paths.report_artifact(report_id, _report_safe_stem("video", gen_id[-8:], "timeline"), ".csv")
            timeline_graph_key = paths.report_artifact(report_id, _report_safe_stem("video", gen_id[-8:], "timeline_graph"), ".png")
            asset_store.put_bytes(timeline_csv_key, timeline_csv.encode("utf-8"), content_type="text/csv")
            asset_store.put_bytes(timeline_graph_key, _build_timeline_graph_png(timeline_rows), content_type="image/png")

            video_aggregates = {
                "sampledFrameCount": paired_count,
                "sampleFps": QC_SAMPLE_FPS,
                "analysisResolution": {"width": analysis_width, "height": analysis_height},
                "durationSec": round(common_duration_sec, 4),
                "alignment": {
                    **video_alignment,
                    "sourceFrameOffset": source_frame_offset,
                    "sourceOffsetSec": round(source_offset_sec, 4),
                    "scanFrameCount": len(alignment_source_frames),
                },
                "changedPctTotalMean": round(sum(changed_total_values) / max(1, len(changed_total_values)), 4),
                "changedPctTotalP95": round(
                    sorted(changed_total_values)[max(0, math.ceil(len(changed_total_values) * 0.95) - 1)],
                    4,
                ),
                "meanDiffTotalMean": round(sum(mean_diff_values) / max(1, len(mean_diff_values)), 6),
                "outsideLeakagePctMean": round(sum(outside_values) / len(outside_values), 4) if outside_values else None,
                "outsideLeakagePctP95": round(
                    sorted(outside_values)[max(0, math.ceil(len(outside_values) * 0.95) - 1)],
                    4,
                )
                if outside_values
                else None,
                "outsideLeakBudgetPct": QC_OUTSIDE_LEAK_BUDGET_PCT if outside_values else None,
                "outsideLeakPass": (sum(outside_values) / len(outside_values)) <= QC_OUTSIDE_LEAK_BUDGET_PCT if outside_values else None,
                "ssimMean": round(sum(ssim_values) / len(ssim_values), 6) if ssim_values else None,
                "ssimMin": round(min(ssim_values), 6) if ssim_values else None,
                "psnrMean": round(sum(psnr_values) / len(psnr_values), 4) if psnr_values else None,
                "psnrMin": round(min(psnr_values), 4) if psnr_values else None,
                "frameDrift": {
                    "sampleCount": len(drift_rows),
                    "meanDeltaFrames": round(sum(float(item.get("frameDeltaDrift") or 0.0) for item in drift_rows) / max(1, len(drift_rows)), 4) if drift_rows else None,
                    "meanAbsDeltaFrames": round(sum(abs(float(item.get("frameDeltaDrift") or 0.0)) for item in drift_rows) / max(1, len(drift_rows)), 4) if drift_rows else None,
                    "maxAbsDeltaFrames": round(max((abs(float(item.get("frameDeltaDrift") or 0.0)) for item in drift_rows), default=0.0), 4),
                    "p95AbsDeltaFrames": round(
                        sorted(abs(float(item.get("frameDeltaDrift") or 0.0)) for item in drift_rows)[max(0, math.ceil(len(drift_rows) * 0.95) - 1)],
                        4,
                    )
                    if drift_rows
                    else None,
                    "driftedFrameCount": sum(1 for item in drift_rows if int(item.get("frameDeltaDrift") or 0) != 0),
                    "meanSimilarity": round(sum(float(item.get("matchSimilarity") or 0.0) for item in drift_rows) / max(1, len(drift_rows)), 4) if drift_rows else None,
                },
                "firstFrame": first_frame_metrics,
                "lastFrame": last_frame_metrics,
                "vmaf": vmaf_metrics,
            }

            standard_payload = {
                "selectedTests": sorted(test_name for test_name in tests if test_name in {"video_diff", "video_frame_evidence"}),
                "aggregates": video_aggregates,
                "selectedFrames": selected_frame_artifacts,
                "artifacts": {
                    "diffVideoKey": diff_video_key,
                    "diffVideoPosterKey": diff_video_poster_key,
                    "timelineCsvKey": timeline_csv_key,
                    "timelineGraphKey": timeline_graph_key,
                },
            }

    return {
        "assetType": "segment_generation",
        "genId": gen_id,
        "segmentId": segment_id,
        "createdAt": generation.get("createdAt"),
        "model": generation.get("luma", {}).get("model"),
        "mode": generation.get("luma", {}).get("mode"),
        "processingDurationSec": _asset_processing_duration_sec(generation),
        "prompt": generation.get("luma", {}).get("prompt") or "No prompt provided",
        "originalFrameKey": start_frame.get("captureKey"),
        "editedStartFrameKey": source_first_variant.get("outputKey"),
        "maskKey": source_first_variant.get("patchMeta", {}).get("maskKey") if isinstance(source_first_variant.get("patchMeta"), dict) else None,
        "endFrameKey": source_last_variant.get("outputKey") if isinstance(source_last_variant, dict) else (end_frame.get("captureKey") if isinstance(end_frame, dict) else None),
        "generatedVideoKey": generation.get("outputKey"),
        "standard": standard_payload,
    }


def _build_previz_report_row(
    *,
    task: dict[str, Any],
    report_id: str,
    gen_id: str,
) -> dict[str, Any]:
    generation = task.get("segmentGenerations", {}).get(gen_id)
    if not isinstance(generation, dict):
        raise RuntimeError(f"Generation {gen_id} not found")
    if generation.get("status") != "complete" or not generation.get("outputKey"):
        raise RuntimeError(f"Generation {gen_id} is not complete")
    workflow_id = (
        generation.get("generationSettings", {}).get("workflowId")
        if isinstance(generation.get("generationSettings"), dict)
        else None
    )
    if workflow_id != "simple_generation_workflow":
        raise RuntimeError(f"Generation {gen_id} is not a Previz generation")

    reference_lookup = {
        str(item.get("referenceId") or ""): item
        for item in task.get("editVideoReferences", [])
        if isinstance(item, dict) and item.get("referenceId")
    }
    selected_frame_ids = [
        str(item or "").strip()
        for item in (generation.get("generationSettings", {}) or {}).get("selectedFrameIds", [])
        if str(item or "").strip()
    ]
    previz_frames: list[dict[str, Any]] = []
    for index, reference_id in enumerate(selected_frame_ids):
        reference = reference_lookup.get(reference_id)
        if not isinstance(reference, dict):
            continue
        frame_count = len(selected_frame_ids)
        label = f"Frame {index + 1}"
        if frame_count > 1 and index == 0:
            label = "Start"
        elif frame_count > 1 and index == frame_count - 1:
            label = "End"
        elif frame_count > 2:
            label = f"Key {index}"
        previz_frames.append(
            {
                "referenceId": reference_id,
                "label": label,
                "imageKey": reference.get("key"),
                "filename": reference.get("filename"),
                "model": reference.get("model"),
                "referenceType": reference.get("type"),
            }
        )

    return {
        "assetType": "segment_generation",
        "genId": gen_id,
        "segmentId": generation.get("segmentId"),
        "createdAt": generation.get("createdAt"),
        "model": generation.get("luma", {}).get("model"),
        "mode": generation.get("luma", {}).get("mode"),
        "processingDurationSec": _asset_processing_duration_sec(generation),
        "prompt": generation.get("luma", {}).get("prompt") or "No prompt provided",
        "sceneAspectRatio": generation.get("generationSettings", {}).get("sceneAspectRatio"),
        "generatedVideoKey": generation.get("outputKey"),
        "posterKey": generation.get("posterKey"),
        "previzFrames": previz_frames,
        "selectedFrameCount": len(previz_frames),
        "reportKind": "previz_review",
        "reportId": report_id,
    }


def _source_video_asset_key(task: dict[str, Any]) -> str | None:
    preview_source = task.get("video", {}).get("previewSource", {})
    edit_source = task.get("video", {}).get("editSource", {})
    for source in (preview_source, edit_source):
        if isinstance(source, dict):
            key = source.get("s3Key")
            if isinstance(key, str) and key:
                return key
    return None


def _task_first_frame_key(task: dict[str, Any]) -> str | None:
    frames = [item for item in (task.get("frames", {}) or {}).values() if isinstance(item, dict) and item.get("captureKey")]
    if not frames:
        return None
    frames.sort(key=lambda item: int(item.get("frameIndex") or 0))
    first_key = frames[0].get("captureKey")
    return str(first_key) if isinstance(first_key, str) and first_key else None


def _build_export_video_report_row(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    store: S3JsonStore,
    paths: AssetPaths,
    report_id: str,
    export_id: str,
    tests: set[str],
    settings: Any,
) -> dict[str, Any]:
    export_item = next(
        (
            item
            for item in task.get("exports", [])
            if isinstance(item, dict) and str(item.get("exportId") or "") == export_id
        ),
        None,
    )
    if not isinstance(export_item, dict):
        raise RuntimeError(f"Export {export_id} not found")
    output_key = str(export_item.get("outputKey") or "")
    if not output_key:
        raise RuntimeError(f"Export {export_id} is incomplete")
    source_video_key = _source_video_asset_key(task)
    if not source_video_key:
        raise RuntimeError("Original source video missing for export report build")

    run_standard_video = bool({"video_diff", "video_frame_evidence"} & tests)
    standard_payload: dict[str, Any] | None = None
    if run_standard_video:
        fps_info = task["video"]["editSource"]["fps"]
        target_fps = Fraction(int(fps_info["num"]), int(fps_info["den"]))
        source_width = int(task["video"]["editSource"]["width"])
        source_height = int(task["video"]["editSource"]["height"])
        analysis_width, analysis_height = _target_by_orientation(
            source_width,
            source_height,
            landscape=(960, 540),
            portrait=(540, 960),
        )

        s3 = boto3.client("s3")
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            original_video_path = td_path / "source_original.mp4"
            export_video_path = td_path / "merged_export.mp4"
            original_standard_path = td_path / "source_original_qc.mp4"
            export_standard_path = td_path / "merged_export_qc.mp4"
            _download_s3(s3, settings.assets_bucket, source_video_key, original_video_path)
            _download_s3(s3, settings.assets_bucket, output_key, export_video_path)

            transcode_to_cfr(
                str(original_video_path),
                str(original_standard_path),
                target_fps,
                target_width=analysis_width,
                target_height=analysis_height,
                crf=20,
                preset="veryfast",
                audio_bitrate="96k",
            )
            transcode_to_cfr(
                str(export_video_path),
                str(export_standard_path),
                target_fps,
                target_width=analysis_width,
                target_height=analysis_height,
                crf=20,
                preset="veryfast",
                audio_bitrate="96k",
            )
            original_probe = ffprobe_video(str(original_standard_path))
            export_probe = ffprobe_video(str(export_standard_path))
            alignment_source_frames = _load_video_alignment_source_frames(
                original_standard_path,
                td_path / "export_alignment",
                max_frames=VIDEO_COMPARE_ALIGNMENT_SCAN_FRAMES,
            )
            video_alignment = _estimate_generated_source_offset(
                source_frames=alignment_source_frames,
                generated_path=export_standard_path,
                generated_probe=export_probe,
                source_fps=target_fps,
                work_dir=td_path / "export_alignment",
                prefix="export",
            )
            source_frame_offset = max(0, int(video_alignment.get("sourceFrameOffset") or 0))
            source_frame_count = int(original_probe.get("frame_count") or 0)
            export_frame_count = int(export_probe.get("frame_count") or 0)
            source_offset_sec = source_frame_offset / float(target_fps)
            common_duration_sec = max(
                0.1,
                min(
                    max(0.0, float(original_probe.get("duration_sec") or 0.0) - source_offset_sec),
                    float(export_probe.get("duration_sec") or 0.0),
                ),
            )
            sample_rows = _frame_aligned_sample_rows(
                source_frame_offset=source_frame_offset,
                source_frame_count=source_frame_count,
                generated_frame_count=export_frame_count,
                fps=target_fps,
                sample_fps=QC_SAMPLE_FPS,
            )
            if not sample_rows:
                raise RuntimeError("No sampled frames available for export QC analysis")

            per_frame_rows: list[dict[str, Any]] = []
            for sample_row in sample_rows:
                frame_idx = int(sample_row["index"])
                source_frame_index = int(sample_row["sourceFrameIndex"])
                generated_frame_index = int(sample_row["generatedFrameIndex"])
                orig_frame_path = td_path / "orig_frames" / f"frame_{frame_idx:05d}.png"
                export_frame_path = td_path / "export_frames" / f"frame_{frame_idx:05d}.png"
                extract_frame_png(str(original_standard_path), source_frame_index, str(orig_frame_path))
                extract_frame_png(str(export_standard_path), generated_frame_index, str(export_frame_path))
                orig_image = Image.open(orig_frame_path).convert("RGB")
                export_image = Image.open(export_frame_path).convert("RGB")
                row_metrics, row_diff, row_binary, _ = _analyze_image_pair(
                    orig_image,
                    export_image,
                    mask_image=None,
                    threshold=QC_DIFF_THRESHOLD,
                    boundary_ring_px=QC_BOUNDARY_RING_PX,
                )
                per_frame_rows.append(
                    {
                        "index": frame_idx,
                        "timeSec": float(sample_row["timeSec"]),
                        "generatedTimeSec": float(sample_row["generatedTimeSec"]),
                        "sourceFrameIndex": source_frame_index,
                        "generatedFrameIndex": generated_frame_index,
                        "sourceFrameOffset": source_frame_offset,
                        **row_metrics,
                        "_original": orig_image,
                        "_diff": row_diff,
                        "_binary": row_binary,
                        "_edited": export_image,
                    }
                )

            changed_total_values = [float(item.get("changedPctTotal") or 0.0) for item in per_frame_rows]
            outside_values = [float(item.get("outsideLeakagePct") or 0.0) for item in per_frame_rows if item.get("outsideLeakagePct") is not None]
            mean_diff_values = [float(item.get("meanDiffTotal") or 0.0) for item in per_frame_rows]
            first_frame_metrics = (
                {key: value for key, value in per_frame_rows[0].items() if not key.startswith("_")}
                if per_frame_rows
                else None
            )
            last_frame_metrics = (
                {key: value for key, value in per_frame_rows[-1].items() if not key.startswith("_")}
                if per_frame_rows
                else None
            )

            ssim_log = td_path / "ssim.log"
            psnr_log = td_path / "psnr.log"
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-ss",
                    f"{source_offset_sec:.6f}",
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(original_standard_path),
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(export_standard_path),
                    "-lavfi",
                    f"ssim=stats_file={ssim_log}",
                    "-shortest",
                    "-f",
                    "null",
                    "-",
                ]
            )
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-ss",
                    f"{source_offset_sec:.6f}",
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(original_standard_path),
                    "-t",
                    f"{common_duration_sec:.6f}",
                    "-i",
                    str(export_standard_path),
                    "-lavfi",
                    f"psnr=stats_file={psnr_log}",
                    "-shortest",
                    "-f",
                    "null",
                    "-",
                ]
            )
            ssim_values = _parse_metric_log(ssim_log, re.compile(r"All:(?P<value>[0-9.]+)"), "value")
            psnr_values = _parse_metric_log(psnr_log, re.compile(r"psnr_avg:(?P<value>[0-9.]+)"), "value")
            vmaf_metrics = _run_optional_vmaf(original_standard_path, export_standard_path, td_path / "vmaf.json")

            ranked_rows = sorted(per_frame_rows, key=lambda row: float(row.get("changedPctTotal") or 0.0), reverse=True)
            selected_rows = ranked_rows[:5]
            if per_frame_rows:
                selected_rows.append(per_frame_rows[len(per_frame_rows) // 2])
            dedup_selected = {int(row["index"]): row for row in selected_rows}

            drift_rows: list[dict[str, Any]] = []
            drift_frame_count = int(export_probe.get("frame_count") or 0)
            for row in per_frame_rows:
                expected_generated_frame_index = max(0, min(drift_frame_count - 1, int(row.get("generatedFrameIndex") or 0)))
                matched_generated_frame_index, matched_generated_image, match_similarity = _best_aligned_generated_frame_index(
                    generated_path=export_standard_path,
                    source_image=row["_original"],
                    expected_frame_index=expected_generated_frame_index,
                    frame_count=drift_frame_count,
                    work_dir=td_path / "export_drift",
                    prefix=f"{export_id}_{int(row.get('index') or 0):04d}",
                    search_radius=3,
                )
                drift_delta_frames = int(matched_generated_frame_index - expected_generated_frame_index)
                row["expectedGeneratedFrameIndex"] = expected_generated_frame_index
                row["matchedGeneratedFrameIndex"] = matched_generated_frame_index
                row["frameDeltaDrift"] = drift_delta_frames
                row["frameDeltaDriftSec"] = round(drift_delta_frames / float(target_fps), 4)
                row["matchSimilarity"] = match_similarity
                row["_matchedGenerated"] = matched_generated_image
                drift_rows.append(
                    {
                        "index": int(row.get("index") or 0),
                        "sourceFrameIndex": int(row.get("sourceFrameIndex") or 0),
                        "generatedFrameIndex": expected_generated_frame_index,
                        "matchedGeneratedFrameIndex": matched_generated_frame_index,
                        "frameDeltaDrift": drift_delta_frames,
                        "frameDeltaDriftSec": round(drift_delta_frames / float(target_fps), 4),
                        "matchSimilarity": match_similarity,
                    }
                )

            selected_frame_artifacts: list[dict[str, Any]] = []
            for frame_idx in sorted(dedup_selected):
                row = dedup_selected[frame_idx]
                matched_generated_image = row.get("_matchedGenerated") or row["_edited"]
                if isinstance(matched_generated_image, Image.Image) and matched_generated_image.size != row["_original"].size:
                    matched_generated_image = matched_generated_image.resize(row["_original"].size, Image.Resampling.LANCZOS)
                matched_diff_gray, _matched_diff_heatmap = _diff_heatmap_image(row["_original"], matched_generated_image)
                heatmap_bytes, overlay_bytes, binary_bytes = _create_overlay_artifacts(
                    edited_image=matched_generated_image,
                    diff_gray=matched_diff_gray,
                    binary_change=row["_binary"],
                    mask_bin=None,
                )
                stem_base = _report_safe_stem("export", export_id[-8:], f"frame{frame_idx:03d}")
                original_frame_key = paths.report_artifact(report_id, f"{stem_base}_source", ".png")
                generated_frame_key = paths.report_artifact(report_id, f"{stem_base}_generated", ".png")
                heatmap_key = paths.report_artifact(report_id, f"{stem_base}_heatmap", ".png")
                overlay_key = paths.report_artifact(report_id, f"{stem_base}_overlay", ".png")
                binary_key = paths.report_artifact(report_id, f"{stem_base}_binary", ".png")
                asset_store.put_bytes(original_frame_key, _image_to_png_bytes(row["_original"]), content_type="image/png")
                asset_store.put_bytes(generated_frame_key, _image_to_png_bytes(matched_generated_image), content_type="image/png")
                asset_store.put_bytes(heatmap_key, heatmap_bytes, content_type="image/png")
                asset_store.put_bytes(overlay_key, overlay_bytes, content_type="image/png")
                asset_store.put_bytes(binary_key, binary_bytes, content_type="image/png")
                selected_frame_artifacts.append(
                    {
                        "index": frame_idx,
                        "timeSec": row["timeSec"],
                        "generatedTimeSec": row.get("generatedTimeSec"),
                        "sourceFrameIndex": row.get("sourceFrameIndex"),
                        "generatedFrameIndex": row.get("generatedFrameIndex"),
                        "matchedGeneratedFrameIndex": row.get("matchedGeneratedFrameIndex"),
                        "expectedGeneratedFrameIndex": row.get("expectedGeneratedFrameIndex"),
                        "frameDeltaDrift": row.get("frameDeltaDrift"),
                        "frameDeltaDriftSec": row.get("frameDeltaDriftSec"),
                        "matchSimilarity": row.get("matchSimilarity"),
                        "sourceFrameOffset": row.get("sourceFrameOffset"),
                        "changedPctTotal": row["changedPctTotal"],
                        "outsideLeakagePct": row.get("outsideLeakagePct"),
                        "originalFrameKey": original_frame_key,
                        "generatedFrameKey": generated_frame_key,
                        "heatmapKey": heatmap_key,
                        "overlayKey": overlay_key,
                        "binaryChangeKey": binary_key,
                    }
                )

            diff_video_path = td_path / "diff_map.mp4"
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-ss",
                    f"{source_offset_sec:.6f}",
                    "-i",
                    str(original_standard_path),
                    "-i",
                    str(export_standard_path),
                    "-filter_complex",
                    "[0:v][1:v]blend=all_mode=difference,eq=contrast=2.0:brightness=0.02:saturation=1.5[v]",
                    "-map",
                    "[v]",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-shortest",
                    str(diff_video_path),
                ]
            )
            diff_video_key = paths.report_artifact(report_id, _report_safe_stem("export", export_id[-8:], "diff_map"), ".mp4")
            _upload_s3(s3, settings.assets_bucket, diff_video_key, diff_video_path, "video/mp4")
            diff_video_poster_path = td_path / "diff_map_poster.png"
            _run_command([FFMPEG_BIN, "-y", "-i", str(diff_video_path), "-frames:v", "1", str(diff_video_poster_path)])
            diff_video_poster_key = paths.report_artifact(report_id, _report_safe_stem("export", export_id[-8:], "diff_map_poster"), ".png")
            _upload_s3(s3, settings.assets_bucket, diff_video_poster_key, diff_video_poster_path, "image/png")

            timeline_rows = [{key: value for key, value in row.items() if not key.startswith("_")} for row in per_frame_rows]
            timeline_csv = "index,timeSec,generatedTimeSec,sourceFrameIndex,generatedFrameIndex,matchedGeneratedFrameIndex,frameDeltaDrift,frameDeltaDriftSec,matchSimilarity,sourceFrameOffset,changedPctTotal,outsideLeakagePct,meanDiffTotal,psnr\n" + "\n".join(
                f"{item.get('index')},{item.get('timeSec')},{item.get('generatedTimeSec')},{item.get('sourceFrameIndex')},{item.get('generatedFrameIndex')},{item.get('matchedGeneratedFrameIndex')},{item.get('frameDeltaDrift')},{item.get('frameDeltaDriftSec')},{item.get('matchSimilarity')},{item.get('sourceFrameOffset')},{item.get('changedPctTotal')},{item.get('outsideLeakagePct')},{item.get('meanDiffTotal')},{item.get('psnr')}"
                for item in timeline_rows
            )
            timeline_csv_key = paths.report_artifact(report_id, _report_safe_stem("export", export_id[-8:], "timeline"), ".csv")
            timeline_graph_key = paths.report_artifact(report_id, _report_safe_stem("export", export_id[-8:], "timeline_graph"), ".png")
            asset_store.put_bytes(timeline_csv_key, timeline_csv.encode("utf-8"), content_type="text/csv")
            asset_store.put_bytes(timeline_graph_key, _build_timeline_graph_png(timeline_rows), content_type="image/png")

            video_aggregates = {
                "sampledFrameCount": paired_count,
                "sampleFps": QC_SAMPLE_FPS,
                "analysisResolution": {"width": analysis_width, "height": analysis_height},
                "durationSec": round(common_duration_sec, 4),
                "alignment": {
                    **video_alignment,
                    "sourceFrameOffset": source_frame_offset,
                    "sourceOffsetSec": round(source_offset_sec, 4),
                    "scanFrameCount": len(alignment_source_frames),
                },
                "changedPctTotalMean": round(sum(changed_total_values) / max(1, len(changed_total_values)), 4),
                "changedPctTotalP95": round(sorted(changed_total_values)[max(0, math.ceil(len(changed_total_values) * 0.95) - 1)], 4),
                "meanDiffTotalMean": round(sum(mean_diff_values) / max(1, len(mean_diff_values)), 6),
                "outsideLeakagePctMean": round(sum(outside_values) / len(outside_values), 4) if outside_values else None,
                "outsideLeakagePctP95": round(sorted(outside_values)[max(0, math.ceil(len(outside_values) * 0.95) - 1)], 4) if outside_values else None,
                "outsideLeakBudgetPct": QC_OUTSIDE_LEAK_BUDGET_PCT if outside_values else None,
                "outsideLeakPass": (sum(outside_values) / len(outside_values)) <= QC_OUTSIDE_LEAK_BUDGET_PCT if outside_values else None,
                "ssimMean": round(sum(ssim_values) / len(ssim_values), 6) if ssim_values else None,
                "ssimMin": round(min(ssim_values), 6) if ssim_values else None,
                "psnrMean": round(sum(psnr_values) / len(psnr_values), 4) if psnr_values else None,
                "psnrMin": round(min(psnr_values), 4) if psnr_values else None,
                "frameDrift": {
                    "sampleCount": len(drift_rows),
                    "meanDeltaFrames": round(sum(float(item.get("frameDeltaDrift") or 0.0) for item in drift_rows) / max(1, len(drift_rows)), 4) if drift_rows else None,
                    "meanAbsDeltaFrames": round(sum(abs(float(item.get("frameDeltaDrift") or 0.0)) for item in drift_rows) / max(1, len(drift_rows)), 4) if drift_rows else None,
                    "maxAbsDeltaFrames": round(max((abs(float(item.get("frameDeltaDrift") or 0.0)) for item in drift_rows), default=0.0), 4),
                    "p95AbsDeltaFrames": round(sorted(abs(float(item.get("frameDeltaDrift") or 0.0)) for item in drift_rows)[max(0, math.ceil(len(drift_rows) * 0.95) - 1)], 4) if drift_rows else None,
                    "driftedFrameCount": sum(1 for item in drift_rows if int(item.get("frameDeltaDrift") or 0) != 0),
                    "meanSimilarity": round(sum(float(item.get("matchSimilarity") or 0.0) for item in drift_rows) / max(1, len(drift_rows)), 4) if drift_rows else None,
                },
                "firstFrame": first_frame_metrics,
                "lastFrame": last_frame_metrics,
                "vmaf": vmaf_metrics,
            }

            standard_payload = {
                "selectedTests": sorted(test_name for test_name in tests if test_name in {"video_diff", "video_frame_evidence"}),
                "aggregates": video_aggregates,
                "selectedFrames": selected_frame_artifacts,
                "artifacts": {
                    "diffVideoKey": diff_video_key,
                    "diffVideoPosterKey": diff_video_poster_key,
                    "timelineCsvKey": timeline_csv_key,
                    "timelineGraphKey": timeline_graph_key,
                },
            }

    return {
        "assetType": "export",
        "exportId": export_id,
        "createdAt": export_item.get("createdAt"),
        "model": "merged_export",
        "mode": "post_process_export",
        "processingDurationSec": None,
        "prompt": "Merged export from post process",
        "originalFrameKey": _task_first_frame_key(task),
        "editedStartFrameKey": None,
        "maskKey": None,
        "endFrameKey": None,
        "generatedVideoKey": output_key,
        "standard": standard_payload,
    }


VIDEO_COMPARE_FRAME_INDICES = (0, 60, 120, 180)
VIDEO_COMPARE_ZOOM_FACTOR = 3
VIDEO_COMPARE_ALIGNMENT_SCAN_FRAMES = 48
VIDEO_COMPARE_ALIGNMENT_ANCHOR_FRAMES = (4, 8, 12, 16)


def _aspect_ratio_label(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return "unknown"
    divisor = math.gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def _image_to_png_bytes(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _diff_heatmap_image(original_image: Image.Image, generated_image: Image.Image) -> tuple[Image.Image, Image.Image]:
    original = original_image.convert("RGB")
    generated = generated_image.convert("RGB")
    if generated.size != original.size:
        generated = generated.resize(original.size, Image.Resampling.LANCZOS)
    diff_gray = ImageChops.difference(original, generated).convert("L")
    heatmap = ImageOps.colorize(diff_gray, black="#10213f", mid="#ffd84d", white="#ff2e2e")
    return diff_gray, heatmap


def _zoom_region_from_diffs(diff_images: list[Image.Image], size: tuple[int, int]) -> dict[str, int]:
    width, height = size
    crop_width = max(1, width // VIDEO_COMPARE_ZOOM_FACTOR)
    crop_height = max(1, height // VIDEO_COMPARE_ZOOM_FACTOR)
    if not diff_images:
        return {
            "x": max(0, (width - crop_width) // 2),
            "y": max(0, (height - crop_height) // 2),
            "width": crop_width,
            "height": crop_height,
            "scale": VIDEO_COMPARE_ZOOM_FACTOR,
        }
    combined = Image.new("L", size, 0)
    for diff in diff_images:
        aligned = diff.convert("L")
        if aligned.size != size:
            aligned = aligned.resize(size, Image.Resampling.BILINEAR)
        combined = ImageChops.lighter(combined, aligned)
    bbox = combined.point(lambda value: 255 if value >= 24 else 0).getbbox()
    if bbox:
        center_x = (bbox[0] + bbox[2]) // 2
        center_y = (bbox[1] + bbox[3]) // 2
    else:
        center_x = width // 2
        center_y = height // 2
    x = min(max(0, center_x - crop_width // 2), max(0, width - crop_width))
    y = min(max(0, center_y - crop_height // 2), max(0, height - crop_height))
    return {"x": x, "y": y, "width": crop_width, "height": crop_height, "scale": VIDEO_COMPARE_ZOOM_FACTOR}


def _zoom_image(image: Image.Image, region: dict[str, int], output_size: tuple[int, int]) -> Image.Image:
    crop_box = (
        int(region["x"]),
        int(region["y"]),
        int(region["x"]) + int(region["width"]),
        int(region["y"]) + int(region["height"]),
    )
    return image.crop(crop_box).resize(output_size, Image.Resampling.LANCZOS)


def _resolution_payload(width: int | None, height: int | None) -> dict[str, int] | None:
    if not width or not height or width <= 0 or height <= 0:
        return None
    return {"width": int(width), "height": int(height)}


def _resolution_from_probe(probe: dict[str, Any]) -> dict[str, int] | None:
    return _resolution_payload(int(probe.get("width") or 0), int(probe.get("height") or 0))


def _resolution_from_settings(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    try:
        return _resolution_payload(int(value.get("width") or 0), int(value.get("height") or 0))
    except Exception:
        return None


def _pearson_score(first: list[float], second: list[float]) -> float:
    sample_count = min(len(first), len(second))
    if sample_count <= 1:
        return 0.0
    first_values = first[:sample_count]
    second_values = second[:sample_count]
    first_mean = sum(first_values) / sample_count
    second_mean = sum(second_values) / sample_count
    numerator = sum((a - first_mean) * (b - second_mean) for a, b in zip(first_values, second_values))
    first_den = math.sqrt(sum((a - first_mean) ** 2 for a in first_values))
    second_den = math.sqrt(sum((b - second_mean) ** 2 for b in second_values))
    if first_den <= 1e-9 or second_den <= 1e-9:
        return 0.0
    return max(-1.0, min(1.0, numerator / (first_den * second_den)))


def _video_compare_vectors(
    image: Image.Image,
    *,
    size: tuple[int, int] = (96, 54),
    region_mask: Image.Image | None = None,
) -> tuple[list[float], list[float], list[float]]:
    gray = ImageOps.autocontrast(image.convert("L").resize(size, Image.Resampling.BILINEAR))
    edge = ImageOps.autocontrast(gray.filter(ImageFilter.FIND_EDGES))
    gray_values_all = [float(value) for value in gray.getdata()]
    edge_values_all = [float(value) for value in edge.getdata()]
    mask_flags: list[bool] | None = None
    if region_mask is not None:
        aligned_mask = region_mask.convert("L")
        if aligned_mask.size != size:
            aligned_mask = aligned_mask.resize(size, Image.Resampling.NEAREST)
        mask_flags = [value >= 127 for value in aligned_mask.getdata()]
        if sum(1 for value in mask_flags if value) < 64:
            mask_flags = None
    if mask_flags is None:
        gray_values = gray_values_all
        edge_values = edge_values_all
        histogram = gray.histogram()
    else:
        gray_values = [value for value, keep in zip(gray_values_all, mask_flags) if keep]
        edge_values = [value for value, keep in zip(edge_values_all, mask_flags) if keep]
        histogram = [0] * 256
        for value, keep in zip(gray.getdata(), mask_flags):
            if keep:
                histogram[int(value)] += 1
    bucket_count = 16
    bucket_width = max(1, len(histogram) // bucket_count)
    buckets = [
        float(sum(histogram[index * bucket_width : (index + 1) * bucket_width]))
        for index in range(bucket_count)
    ]
    total = sum(buckets) or 1.0
    return gray_values, edge_values, [value / total for value in buckets]


def _histogram_intersection(first: list[float], second: list[float]) -> float:
    return max(0.0, min(1.0, sum(min(a, b) for a, b in zip(first, second))))


def _video_compare_similarity(source_image: Image.Image, generated_image: Image.Image, *, region_mask: Image.Image | None = None) -> float:
    source = source_image.convert("RGB")
    generated = generated_image.convert("RGB")
    if generated.size != source.size:
        generated = generated.resize(source.size, Image.Resampling.LANCZOS)
    source_gray, source_edge, source_hist = _video_compare_vectors(source, region_mask=region_mask)
    generated_gray, generated_edge, generated_hist = _video_compare_vectors(generated, region_mask=region_mask)
    edge_score = (_pearson_score(source_edge, generated_edge) + 1.0) / 2.0
    gray_score = (_pearson_score(source_gray, generated_gray) + 1.0) / 2.0
    histogram_score = _histogram_intersection(source_hist, generated_hist)
    return max(0.0, min(1.0, (0.58 * edge_score) + (0.27 * gray_score) + (0.15 * histogram_score)))


def _estimate_video_compare_alignment_from_frame_zero(
    source_frames: list[Image.Image],
    generated_first_frame: Image.Image,
    *,
    region_mask: Image.Image | None = None,
) -> dict[str, Any]:
    if not source_frames:
        return {"sourceFrameOffset": 0, "confidence": 0.0, "score": 0.0, "runnerUpScore": 0.0, "method": "frame_zero_fallback"}
    scored = [
        (index, _video_compare_similarity(source_frame, generated_first_frame, region_mask=region_mask))
        for index, source_frame in enumerate(source_frames)
    ]
    scored.sort(key=lambda item: item[1], reverse=True)
    best_index, best_score = scored[0]
    runner_up_score = scored[1][1] if len(scored) > 1 else 0.0
    confidence = max(0.0, min(1.0, best_score - runner_up_score))
    return {
        "sourceFrameOffset": int(best_index),
        "confidence": round(confidence, 4),
        "score": round(best_score, 4),
        "runnerUpScore": round(runner_up_score, 4),
        "method": "frame_zero_fallback",
        "anchorFrames": [0],
    }


def _estimate_video_compare_alignment_from_anchors(
    *,
    source_frames: list[Image.Image],
    generated_anchors: list[tuple[int, Image.Image]],
    source_fps: Fraction,
    generated_fps: Fraction,
    region_mask: Image.Image | None = None,
) -> dict[str, Any]:
    if not source_frames or not generated_anchors:
        return {"sourceFrameOffset": 0, "confidence": 0.0, "score": 0.0, "runnerUpScore": 0.0, "method": "anchor_sequence"}

    anchor_steps = [
        (generated_frame_index, max(0, int(round((generated_frame_index / float(generated_fps)) * float(source_fps)))), generated_image)
        for generated_frame_index, generated_image in generated_anchors
    ]
    max_step = max((step for _, step, _ in anchor_steps), default=0)
    max_candidate_offset = max(0, len(source_frames) - max_step - 1)
    candidate_scores: list[tuple[int, float, int]] = []

    for candidate_offset in range(max_candidate_offset + 1):
        scores: list[float] = []
        for _, source_step, generated_image in anchor_steps:
            source_index = candidate_offset + source_step
            if source_index >= len(source_frames):
                continue
            scores.append(_video_compare_similarity(source_frames[source_index], generated_image, region_mask=region_mask))
        if not scores:
            continue
        candidate_scores.append((candidate_offset, sum(scores) / len(scores), len(scores)))

    if not candidate_scores:
        return {"sourceFrameOffset": 0, "confidence": 0.0, "score": 0.0, "runnerUpScore": 0.0, "method": "anchor_sequence"}

    candidate_scores.sort(key=lambda item: (item[1], item[2]), reverse=True)
    best_offset, best_score, anchor_count = candidate_scores[0]
    runner_up_score = candidate_scores[1][1] if len(candidate_scores) > 1 else 0.0
    confidence = max(0.0, min(1.0, best_score - runner_up_score))
    return {
        "sourceFrameOffset": int(best_offset),
        "confidence": round(confidence, 4),
        "score": round(best_score, 4),
        "runnerUpScore": round(runner_up_score, 4),
        "method": "anchor_sequence",
        "anchorFrames": [int(frame_index) for frame_index, _, _ in anchor_steps],
        "anchorCount": int(anchor_count),
        "sourceFrameSteps": [int(source_step) for _, source_step, _ in anchor_steps],
    }


def _load_video_alignment_source_frames(video_path: Path, work_dir: Path, *, max_frames: int) -> list[Image.Image]:
    probe = ffprobe_video(str(video_path))
    frame_count = min(max_frames, int(probe.get("frame_count") or 0))
    frames: list[Image.Image] = []
    for frame_index in range(frame_count):
        frame_path = work_dir / f"align_source_{frame_index:04d}.png"
        extract_frame_png(str(video_path), frame_index, str(frame_path))
        frames.append(Image.open(frame_path).convert("RGB"))
    return frames


def _estimate_generated_source_offset(
    *,
    source_frames: list[Image.Image],
    generated_path: Path,
    generated_probe: dict[str, Any],
    source_fps: Fraction,
    work_dir: Path,
    prefix: str,
    region_mask: Image.Image | None = None,
) -> dict[str, Any]:
    frame_count = int(generated_probe.get("frame_count") or 0)
    alignment: dict[str, Any] = {
        "sourceFrameOffset": 0,
        "confidence": 0.0,
        "score": 0.0,
        "runnerUpScore": 0.0,
        "method": "anchor_sequence",
    }
    if frame_count <= 0 or not source_frames:
        return alignment
    generated_fps = Fraction(int(generated_probe.get("fps_num") or 30), int(generated_probe.get("fps_den") or 1))
    generated_anchors: list[tuple[int, Image.Image]] = []
    for anchor_frame_index in VIDEO_COMPARE_ALIGNMENT_ANCHOR_FRAMES:
        if anchor_frame_index >= frame_count:
            continue
        anchor_path = work_dir / f"{prefix}_align_generated_{anchor_frame_index:04d}.png"
        extract_frame_png(str(generated_path), anchor_frame_index, str(anchor_path))
        generated_anchors.append((anchor_frame_index, Image.open(anchor_path).convert("RGB")))
    if generated_anchors:
        alignment = _estimate_video_compare_alignment_from_anchors(
            source_frames=source_frames,
            generated_anchors=generated_anchors,
            source_fps=source_fps,
            generated_fps=generated_fps,
            region_mask=region_mask,
        )
    else:
        first_generated_path = work_dir / f"{prefix}_align_generated_0000.png"
        extract_frame_png(str(generated_path), 0, str(first_generated_path))
        first_generated_image = Image.open(first_generated_path).convert("RGB")
        alignment = _estimate_video_compare_alignment_from_frame_zero(source_frames, first_generated_image, region_mask=region_mask)
    alignment["scanFrameCount"] = len(source_frames)
    return alignment


def _best_aligned_generated_frame_index(
    *,
    generated_path: Path,
    source_image: Image.Image,
    expected_frame_index: int,
    frame_count: int,
    work_dir: Path,
    prefix: str,
    search_radius: int = 2,
    max_search_radius: int = 24,
    region_mask: Image.Image | None = None,
) -> tuple[int, Image.Image, float]:
    if frame_count <= 0:
        return 0, source_image, 0.0

    def _score_window(center_index: int, radius: int) -> tuple[int | None, Image.Image | None, float, bool, bool]:
        low = max(0, center_index - radius)
        high = min(frame_count - 1, center_index + radius)
        candidates = list(range(low, high + 1))
        local_best_index: int | None = None
        local_best_image: Image.Image | None = None
        local_best_score = -1.0
        for candidate_index in candidates:
            candidate_path = work_dir / f"{prefix}_candidate_{candidate_index:04d}.png"
            extract_frame_png(str(generated_path), candidate_index, str(candidate_path))
            candidate_image = Image.open(candidate_path).convert("RGB")
            score = _video_compare_similarity(source_image, candidate_image, region_mask=region_mask)
            if score > local_best_score:
                local_best_index = candidate_index
                local_best_image = candidate_image
                local_best_score = score
        if local_best_index is None or local_best_image is None:
            return None, None, -1.0, False, False
        return (
            local_best_index,
            local_best_image,
            local_best_score,
            local_best_index == low,
            local_best_index == high,
        )

    clamped_expected = max(0, min(frame_count - 1, expected_frame_index))
    best_index: int | None = None
    best_image: Image.Image | None = None
    best_score = -1.0
    center_index = clamped_expected
    radius = max(1, int(search_radius))
    visited_windows: set[tuple[int, int]] = set()
    for _ in range(6):
        low = max(0, center_index - radius)
        high = min(frame_count - 1, center_index + radius)
        window_key = (low, high)
        if window_key in visited_windows:
            break
        visited_windows.add(window_key)
        local_best_index, local_best_image, local_best_score, hit_low, hit_high = _score_window(center_index, radius)
        if local_best_index is None or local_best_image is None:
            break
        if local_best_score > best_score:
            best_index = local_best_index
            best_image = local_best_image
            best_score = local_best_score
        if radius >= max_search_radius:
            break
        if hit_low:
            center_index = max(0, local_best_index - max(1, radius // 2))
            radius = min(max_search_radius, radius * 2)
            continue
        if hit_high:
            center_index = min(frame_count - 1, local_best_index + max(1, radius // 2))
            radius = min(max_search_radius, radius * 2)
            continue
        break

    if best_index is None or best_image is None:
        fallback_path = work_dir / f"{prefix}_fallback_{max(0, expected_frame_index):04d}.png"
        fallback_index = clamped_expected
        extract_frame_png(str(generated_path), fallback_index, str(fallback_path))
        return fallback_index, Image.open(fallback_path).convert("RGB"), 0.0
    return best_index, best_image, round(best_score, 4)


def compute_merge_alignment_suggestion(
    *,
    task: dict[str, Any],
    segment: dict[str, Any],
    generation: dict[str, Any],
    asset_store: AssetStore,
    paths: AssetPaths,
    settings: Any,
) -> dict[str, Any]:
    def _window_bounds(count: int, start_fraction: float, end_fraction: float) -> tuple[int, int]:
        if count <= 0:
            return 0, 0
        start_index = max(0, min(count - 1, int(math.floor(count * start_fraction))))
        end_index = max(start_index + 1, int(math.ceil(count * end_fraction)))
        end_index = min(count, end_index)
        return start_index, end_index

    def _window_median(values: list[int], start_fraction: float, end_fraction: float) -> int:
        start_index, end_index = _window_bounds(len(values), start_fraction, end_fraction)
        window = values[start_index:end_index]
        if not window:
            return 0
        return int(round(median(window)))

    crop_settings = segment.get("crop") if isinstance(segment.get("crop"), dict) and segment.get("crop", {}).get("enabled") else None
    fps_info = task["video"]["editSource"]["fps"]
    target_fps = Fraction(int(fps_info["num"]), int(fps_info["den"]))
    source_width = int(task["video"]["editSource"]["width"])
    source_height = int(task["video"]["editSource"]["height"])
    analysis_width, analysis_height = _target_by_orientation(
        source_width,
        source_height,
        landscape=(960, 540),
        portrait=(540, 960),
    )

    s3 = boto3.client("s3")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        frames = task.get("frames", {}) if isinstance(task.get("frames"), dict) else {}
        start_frame = frames.get(segment.get("startFrameId")) if isinstance(segment.get("startFrameId"), str) else None
        source_first_variant: dict[str, Any] | None = None
        source_first_variant_id = generation.get("sourceFirstFrameVariantId")
        if isinstance(start_frame, dict):
            variants = start_frame.get("variants", [])
            if isinstance(source_first_variant_id, str) and source_first_variant_id:
                source_first_variant = next((item for item in variants if item.get("variantId") == source_first_variant_id), None)
            if not isinstance(source_first_variant, dict):
                selected_variant_id = start_frame.get("selectedVariantId")
                if isinstance(selected_variant_id, str) and selected_variant_id:
                    source_first_variant = next((item for item in variants if item.get("variantId") == selected_variant_id), None)
        original_segment_key = _ensure_segment_clip(
            s3=s3,
            asset_store=asset_store,
            asset_paths=paths,
            task=task,
            segment=segment,
            assets_bucket=settings.assets_bucket,
        )
        original_segment_path = td_path / "segment_original.mp4"
        generated_segment_path = td_path / "segment_generated.mp4"
        original_standard_path = td_path / "segment_original_merge_alignment.mp4"
        generated_standard_path = td_path / "segment_generated_merge_alignment.mp4"
        _download_s3(s3, settings.assets_bucket, original_segment_key, original_segment_path)
        _download_s3(s3, settings.assets_bucket, generation["outputKey"], generated_segment_path)

        transcode_to_cfr(
            str(original_segment_path),
            str(original_standard_path),
            target_fps,
            target_width=analysis_width,
            target_height=analysis_height,
            crf=20,
            preset="veryfast",
            audio_bitrate="96k",
        )
        transcode_to_cfr(
            str(generated_segment_path),
            str(generated_standard_path),
            target_fps,
            target_width=analysis_width,
            target_height=analysis_height,
            crf=20,
            preset="veryfast",
            audio_bitrate="96k",
        )
        original_probe = ffprobe_video(str(original_standard_path))
        generated_probe = ffprobe_video(str(generated_standard_path))
        alignment_region_mask: Image.Image | None = None
        alignment_mask_mode = "full_frame"
        edit_mask_key = None
        if isinstance(source_first_variant, dict):
            if isinstance(source_first_variant.get("patchMeta"), dict):
                edit_mask_key = source_first_variant.get("patchMeta", {}).get("maskKey")
            if not edit_mask_key and isinstance(source_first_variant.get("qualityMatch"), dict):
                edit_mask_key = source_first_variant.get("qualityMatch", {}).get("finalMaskKey")
        edit_mask_bytes = asset_store.read_bytes(edit_mask_key) if isinstance(edit_mask_key, str) and edit_mask_key else None
        if edit_mask_bytes:
            candidate_mask = _alignment_region_mask_from_edit_mask(edit_mask_bytes, (analysis_width, analysis_height), expand_px=6)
            if candidate_mask is not None:
                alignment_region_mask = candidate_mask
                alignment_mask_mode = "outside_edit_mask"
        alignment_source_frames = _load_video_alignment_source_frames(
            original_standard_path,
            td_path / "merge_alignment",
            max_frames=VIDEO_COMPARE_ALIGNMENT_SCAN_FRAMES,
        )
        video_alignment = _estimate_generated_source_offset(
            source_frames=alignment_source_frames,
            generated_path=generated_standard_path,
            generated_probe=generated_probe,
            source_fps=target_fps,
            work_dir=td_path / "merge_alignment",
            prefix="merge",
            region_mask=alignment_region_mask,
        )
        anchor_offset_frames = max(0, int(video_alignment.get("sourceFrameOffset") or 0))
        source_offset_sec = anchor_offset_frames / float(target_fps)
        source_frame_count = int(original_probe.get("frame_count") or 0)
        generated_frame_count = int(generated_probe.get("frame_count") or 0)
        common_frame_count = min(max(0, source_frame_count - anchor_offset_frames), generated_frame_count)
        drift_rows: list[dict[str, Any]] = []
        fps_value = float(target_fps)
        sample_interval_sec = 1.0 / float(QC_SAMPLE_FPS)
        sample_time_sec = 0.0
        previous_relative_index = -1
        sample_index = 0
        while (
            sample_index < QC_ANALYSIS_MAX_FRAMES
            and common_frame_count > 0
            and sample_time_sec <= ((common_frame_count - 1) / max(1e-9, fps_value)) + 1e-9
        ):
            relative_frame_index = int(round(sample_time_sec * fps_value))
            if relative_frame_index <= previous_relative_index:
                relative_frame_index = previous_relative_index + 1
            if relative_frame_index >= common_frame_count:
                break
            source_frame_index = anchor_offset_frames + relative_frame_index
            expected_generated_frame_index = relative_frame_index
            original_frame_path = td_path / "merge_orig_frames" / f"frame_{sample_index:05d}.png"
            extract_frame_png(str(original_standard_path), source_frame_index, str(original_frame_path))
            source_image = Image.open(original_frame_path).convert("RGB")
            matched_generated_frame_index, _matched_generated_image, match_similarity = _best_aligned_generated_frame_index(
                generated_path=generated_standard_path,
                source_image=source_image,
                expected_frame_index=expected_generated_frame_index,
                frame_count=generated_frame_count,
                work_dir=td_path / "merge_drift",
                prefix=f"merge_{generation.get('genId', 'gen')}_{sample_index:04d}",
                search_radius=3,
                region_mask=alignment_region_mask,
            )
            drift_delta_frames = int(matched_generated_frame_index - expected_generated_frame_index)
            drift_rows.append(
                {
                    "index": sample_index,
                    "timeSec": round(source_frame_index / fps_value, 4),
                    "sourceFrameIndex": source_frame_index,
                    "expectedGeneratedFrameIndex": expected_generated_frame_index,
                    "matchedGeneratedFrameIndex": matched_generated_frame_index,
                    "frameDeltaDrift": drift_delta_frames,
                    "matchSimilarity": match_similarity,
                }
            )
            previous_relative_index = relative_frame_index
            sample_index += 1
            sample_time_sec += sample_interval_sec
        paired_count = len(drift_rows)

    early_window = drift_rows[: min(3, len(drift_rows))]
    late_window = drift_rows[max(0, len(drift_rows) - 3) :]
    early_deltas = [int(item.get("frameDeltaDrift") or 0) for item in early_window]
    late_deltas = [int(item.get("frameDeltaDrift") or 0) for item in late_window]
    early_median = int(round(median(early_deltas))) if early_deltas else 0
    late_median = int(round(median(late_deltas))) if late_deltas else 0
    drift_values = [int(item.get("frameDeltaDrift") or 0) for item in drift_rows]
    quarter_median = _window_median(drift_values, 0.2, 0.4)
    middle_median = _window_median(drift_values, 0.4, 0.6)
    three_quarter_median = _window_median(drift_values, 0.6, 0.8)
    stable_candidates = [quarter_median, middle_median, three_quarter_median] if drift_values else [0]
    stable_baseline_drift = int(round(median(stable_candidates))) if stable_candidates else 0
    startup_trim_frames = max(0, early_median - stable_baseline_drift)
    mean_abs_drift = (
        round(sum(abs(value) for value in drift_values) / max(1, len(drift_values)), 4)
        if drift_values
        else 0.0
    )

    suggested_insert_offset_frames = anchor_offset_frames - stable_baseline_drift
    suggested_insert_start = int(segment.get("startFrame") or 0) + suggested_insert_offset_frames
    suggested_insert_start = max(0, suggested_insert_start)
    trim_start_frames = startup_trim_frames
    source_duration_frames = int(segment.get("durationFrames") or max(1, int(segment.get("endFrameExclusive") or 0) - suggested_insert_start))
    generated_duration_frames = max(1, int(generated_probe.get("frame_count") or 0))
    effective_generated_frames = max(1, generated_duration_frames - trim_start_frames)

    stable_start_index, _stable_end_index = _window_bounds(len(drift_rows), 0.2, 1.0)
    stable_rows = drift_rows[stable_start_index:] if len(drift_rows) >= 4 else drift_rows
    stable_positions = [float(item.get("sourceFrameIndex") or 0.0) for item in stable_rows]
    stable_drifts = [float(item.get("frameDeltaDrift") or 0.0) for item in stable_rows]
    drift_slope_frames_per_source_frame = 0.0
    fitted_residuals: list[float] = []
    predicted_late_drift = float(late_median)
    if len(stable_positions) >= 3:
        x_mean = sum(stable_positions) / len(stable_positions)
        y_mean = sum(stable_drifts) / len(stable_drifts)
        denominator = sum((x - x_mean) ** 2 for x in stable_positions)
        if denominator > 1e-9:
            drift_slope_frames_per_source_frame = sum((x - x_mean) * (y - y_mean) for x, y in zip(stable_positions, stable_drifts)) / denominator
        intercept = y_mean - (drift_slope_frames_per_source_frame * x_mean)
        fitted_residuals = [y - (intercept + (drift_slope_frames_per_source_frame * x)) for x, y in zip(stable_positions, stable_drifts)]
        late_position = float(late_window[-1].get("sourceFrameIndex") or stable_positions[-1]) if late_window else stable_positions[-1]
        predicted_late_drift = intercept + (drift_slope_frames_per_source_frame * late_position)
    stable_rate_delta = drift_slope_frames_per_source_frame
    suggested_playback_rate = round(max(0.05, min(20.0, 1.0 + stable_rate_delta)), 6)
    residual_end_frames = int(round(float(late_median) - predicted_late_drift))
    trim_end_frames = max(0, residual_end_frames)
    residual_drift_values = fitted_residuals if fitted_residuals else [float(value - stable_baseline_drift) for value in drift_values]
    residual_mean_abs_drift = (
        round(sum(abs(value) for value in residual_drift_values) / max(1, len(residual_drift_values)), 4)
        if residual_drift_values
        else 0.0
    )
    linear_fit_mae = 0.0
    if residual_drift_values:
        linear_fit_mae = round(sum(abs(value) for value in residual_drift_values) / len(residual_drift_values), 4)
    stable_span_drift = late_median - quarter_median if drift_values else 0

    recommendation = "trim_only"
    notes: list[str] = []
    notes.append("Drift samples use direct frame-index extraction on both source and generated clips for frame-accurate matching.")
    if crop_settings:
        notes.append("Alignment was analysed against the same cropped source region, not the full original frame.")
    if alignment_mask_mode == "outside_edit_mask":
        notes.append("Alignment and drift were measured against preserved pixels outside the edited region, not the changed subject area.")
    else:
        notes.append("No usable edit mask was available for alignment, so timing was analysed across the full frame.")
    if suggested_insert_offset_frames != 0:
        direction = "later" if suggested_insert_offset_frames > 0 else "earlier"
        notes.append(f"Persistent drift suggests moving the source insert start {direction} by about {abs(suggested_insert_offset_frames)} frame(s).")
    if trim_start_frames > 0:
        notes.append(f"Opening frames differ from the settled timing by about {trim_start_frames} frame(s); trim generation start first.")
    if abs(suggested_playback_rate - 1.0) > 0.005 and abs(stable_span_drift) >= 2:
        recommendation = "retime_recommended"
        notes.append(f"Drift changes through the clip. Estimated retime is about {suggested_playback_rate:.4f}x.")
    if trim_end_frames > 0:
        notes.append(f"Generated end still overruns the fitted timing by about {trim_end_frames} frame(s); trim generation end if needed.")
    if residual_mean_abs_drift > 2.0 and linear_fit_mae <= 1.25:
        recommendation = "piecewise_reconcile_recommended"
        notes.append("Drift is not constant across the clip but still looks structurally matchable. A piecewise time map is more appropriate than one uniform retime.")
    elif residual_mean_abs_drift > 2.0:
        recommendation = "rerender_recommended"
        notes.append("Residual drift still varies after alignment and retime analysis, suggesting non-linear timing differences.")
    elif trim_end_frames > 0:
        recommendation = "trim_start_and_end"
    elif trim_start_frames <= 1 and abs(suggested_insert_offset_frames) <= 1 and abs(suggested_playback_rate - 1.0) <= 0.005 and residual_mean_abs_drift <= 1.0:
        recommendation = "merge_ready"

    confidence = round(
        max(
            float(video_alignment.get("confidence") or 0.0),
            min(1.0, 0.45 + (0.08 * len(drift_rows)) - (0.08 * residual_mean_abs_drift)),
        ),
        4,
    )

    return {
        "suggested": {
            "startFrameOverride": suggested_insert_start,
            "trimStartFrames": trim_start_frames,
            "trimEndFrames": trim_end_frames,
        },
        "analysis": {
            "cropApplied": bool(crop_settings),
            "sourceFrameOffset": anchor_offset_frames,
            "sourceOffsetSec": round(source_offset_sec, 4),
            "anchorAlignment": video_alignment,
            "sampleCount": paired_count,
            "earlyMedianDriftFrames": early_median,
            "quarterMedianDriftFrames": quarter_median,
            "middleMedianDriftFrames": middle_median,
            "threeQuarterMedianDriftFrames": three_quarter_median,
            "lateMedianDriftFrames": late_median,
            "stableBaselineDriftFrames": stable_baseline_drift,
            "suggestedInsertOffsetFrames": int(suggested_insert_offset_frames),
            "startupTrimFrames": int(trim_start_frames),
            "residualEndFrames": residual_end_frames,
            "meanAbsDriftFrames": mean_abs_drift,
            "residualMeanAbsDriftFrames": residual_mean_abs_drift,
            "linearFitMaeFrames": linear_fit_mae,
            "driftSlopeFramesPerSourceFrame": round(drift_slope_frames_per_source_frame, 6),
            "alignmentMaskMode": alignment_mask_mode,
            "suggestedPlaybackRate": suggested_playback_rate,
            "recommendation": recommendation,
            "confidence": confidence,
            "notes": notes,
            "driftSamples": drift_rows,
        },
    }


def _handle_merge_alignment_suggestion(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job.get("payload") or {}
    gen_id = str(payload.get("genId") or "")
    if not gen_id:
        raise RuntimeError("Missing generation id for merge alignment suggestion")
    generation = task.get("segmentGenerations", {}).get(gen_id)
    if not isinstance(generation, dict):
        raise RuntimeError("Generation not found for merge alignment suggestion")
    if generation.get("status") != "complete" or not generation.get("outputKey"):
        raise RuntimeError("Generation must be complete before alignment can be analysed")
    segment_id = str(generation.get("segmentId") or "")
    segment = next(
        (item for item in task.get("segments", []) if isinstance(item, dict) and str(item.get("segmentId") or "") == segment_id),
        None,
    )
    if not isinstance(segment, dict):
        raise RuntimeError("Segment not found for generation")

    suggestion_state = generation.get("mergeAlignmentSuggestion") if isinstance(generation.get("mergeAlignmentSuggestion"), dict) else {}
    suggestion_state.update(
        {
            "status": "running",
            "jobId": job.get("jobId"),
            "updatedAt": now_iso(),
        }
    )
    generation["mergeAlignmentSuggestion"] = suggestion_state
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 10, "running", "Preparing alignment analysis")

    suggestion = compute_merge_alignment_suggestion(
        task=task,
        segment=segment,
        generation=generation,
        asset_store=asset_store,
        paths=_asset_paths(task),
        settings=settings,
    )

    latest_task = store.load_task(task["userId"], task["taskId"]) or task
    latest_generation = latest_task.get("segmentGenerations", {}).get(gen_id) if isinstance(latest_task, dict) else None
    if not isinstance(latest_generation, dict):
        raise RuntimeError("Generation disappeared before alignment suggestion could be saved")

    latest_generation["mergeAlignmentSuggestion"] = {
        "status": "complete",
        "jobId": job.get("jobId"),
        "updatedAt": now_iso(),
        "analyzedAt": now_iso(),
        "suggestion": suggestion,
    }
    store.save_task(latest_task, merge_on_conflict=True)
    _job_progress(job, store, 100, "complete", "Alignment suggestion ready")
    job["resultRefs"] = {"genId": gen_id, "suggestion": suggestion}
    store.save_job(job)
    return job


def _build_video_comparison_report(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    paths: AssetPaths,
    report_id: str,
    asset_refs: list[dict[str, Any]],
    settings: Any,
) -> dict[str, Any]:
    generation_ids = [str(item.get("genId") or "") for item in asset_refs if item.get("assetType") == "segment_generation" and item.get("genId")]
    generations = [task.get("segmentGenerations", {}).get(gen_id) for gen_id in generation_ids]
    generations = [item for item in generations if isinstance(item, dict)]
    if len(generations) < 2:
        raise RuntimeError("Video comparison requires at least two generated videos")

    segments_by_id = {str(item.get("segmentId")): item for item in task.get("segments", []) if isinstance(item, dict)}
    first_segment = segments_by_id.get(str(generations[0].get("segmentId") or ""))
    if not isinstance(first_segment, dict):
        raise RuntimeError("Comparison segment missing")
    segment_id = str(first_segment["segmentId"])
    start_frame = int(first_segment.get("startFrame") or 0)
    for generation in generations:
        segment = segments_by_id.get(str(generation.get("segmentId") or ""))
        if not isinstance(segment, dict):
            raise RuntimeError(f"Segment missing for generation {generation.get('genId')}")
        if str(segment.get("segmentId")) != segment_id or int(segment.get("startFrame") or 0) != start_frame:
            raise RuntimeError("All selected generated videos must come from the same segment and starting frame")
        if generation.get("status") != "complete" or not generation.get("outputKey"):
            raise RuntimeError(f"Generation {generation.get('genId')} is not complete")

    fps_info = task.get("video", {}).get("editSource", {}).get("fps", {})
    source_fps = Fraction(int(fps_info.get("num") or 30), int(fps_info.get("den") or 1))
    s3 = boto3.client("s3")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        original_segment_key = _ensure_segment_clip(
            s3=s3,
            asset_store=asset_store,
            asset_paths=paths,
            task=task,
            segment=first_segment,
            assets_bucket=settings.assets_bucket,
        )
        original_path = td_path / "original_segment.mp4"
        _download_s3(s3, settings.assets_bucket, original_segment_key, original_path)
        original_probe = ffprobe_video(str(original_path))
        original_frame_count = int(original_probe.get("frame_count") or 0)
        original_resolution = _resolution_from_probe(original_probe)
        alignment_source_frames = _load_video_alignment_source_frames(
            original_path,
            td_path / "compare_alignment",
            max_frames=VIDEO_COMPARE_ALIGNMENT_SCAN_FRAMES,
        )
        alignment_scan_count = len(alignment_source_frames)

        downloaded_generations: list[dict[str, Any]] = []
        input_probe_cache: dict[str, dict[str, Any]] = {}
        for index, generation in enumerate(generations):
            local_video = td_path / f"generated_{index:03d}.mp4"
            _download_s3(s3, settings.assets_bucket, str(generation["outputKey"]), local_video)
            probe = ffprobe_video(str(local_video))
            width = int(probe.get("width") or 0)
            height = int(probe.get("height") or 0)
            fps_num = int(probe.get("fps_num") or 0)
            fps_den = int(probe.get("fps_den") or 1)
            frame_count = int(probe.get("frame_count") or 0)
            duration_sec = float(probe.get("duration_sec") or 0.0)
            model = str(generation.get("luma", {}).get("model") or "")
            mode = str(generation.get("luma", {}).get("mode") or "")
            generation_settings = generation.get("generationSettings") if isinstance(generation.get("generationSettings"), dict) else {}
            stored_output_resolution = {"width": width, "height": height}
            output_resolution = (
                _resolution_from_settings(generation_settings.get("seedanceRawOutputResolution"))
                or _resolution_from_settings(generation_settings.get("providerOutputResolution"))
                or stored_output_resolution
            )
            input_resolution = _resolution_from_settings(generation_settings.get("mediaResolution"))
            input_media_key = str(generation.get("inputMediaKey") or "")
            if input_resolution is None and input_media_key:
                if input_media_key == original_segment_key:
                    input_resolution = original_resolution
                else:
                    try:
                        input_probe = input_probe_cache.get(input_media_key)
                        if input_probe is None:
                            input_path = td_path / f"input_{index:03d}.mp4"
                            _download_s3(s3, settings.assets_bucket, input_media_key, input_path)
                            input_probe = ffprobe_video(str(input_path))
                            input_probe_cache[input_media_key] = input_probe
                        input_resolution = _resolution_from_probe(input_probe)
                    except Exception:
                        input_resolution = None
            alignment = _estimate_generated_source_offset(
                source_frames=alignment_source_frames,
                generated_path=local_video,
                generated_probe=probe,
                source_fps=source_fps,
                work_dir=td_path / "compare_alignment",
                prefix=f"gen_{index:03d}",
            )
            subsetting_parts = [mode]
            for setting_key in ("replicateKlingMode", "replicateKlingV3Mode", "wan27Resolution", "happyHorseResolution", "seedanceResolution"):
                value = generation_settings.get(setting_key)
                if value:
                    subsetting_parts.append(f"{setting_key}={value}")
            downloaded_generations.append(
                {
                    "generation": generation,
                    "path": local_video,
                    "probe": probe,
                    "table": {
                        "genId": generation.get("genId"),
                        "model": model,
                        "modelSubsetting": " / ".join(part for part in subsetting_parts if part) or mode or "default",
                        "prompt": generation.get("luma", {}).get("prompt") or "No prompt provided",
                        "inputResolution": input_resolution,
                        "outputResolution": output_resolution,
                        "storedOutputResolution": stored_output_resolution,
                        "aspectRatio": _aspect_ratio_label(width, height),
                        "frameCount": frame_count,
                        "fps": round(fps_num / max(1, fps_den), 4),
                        "fpsNum": fps_num,
                        "fpsDen": fps_den,
                        "durationSec": round(duration_sec, 4),
                        "processingDurationSec": _asset_processing_duration_sec(generation),
                        "alignment": alignment,
                        "sourceFrameOffset": int(alignment.get("sourceFrameOffset") or 0),
                        "alignmentConfidence": alignment.get("confidence"),
                    },
                    "sourceFrameOffset": int(alignment.get("sourceFrameOffset") or 0),
                }
            )

        aligned_start_frame = max((int(item.get("sourceFrameOffset") or 0) for item in downloaded_generations), default=0)
        available_source_frame_indices = [
            aligned_start_frame + frame_index
            for frame_index in VIDEO_COMPARE_FRAME_INDICES
            if aligned_start_frame + frame_index < original_frame_count
            and all(
                0
                <= round(
                    ((aligned_start_frame + frame_index - int(item.get("sourceFrameOffset") or 0)) / float(source_fps))
                    * (int(item["probe"].get("fps_num") or 30) / max(1, int(item["probe"].get("fps_den") or 1)))
                )
                < int(item["probe"].get("frame_count") or 0)
                for item in downloaded_generations
            )
        ]
        if not available_source_frame_indices:
            raise RuntimeError("None of the requested comparison frame indices are available")

        samples: list[dict[str, Any]] = []
        for source_frame_index in available_source_frame_indices:
            comparison_frame_index = source_frame_index - aligned_start_frame
            original_frame_path = td_path / f"original_{source_frame_index:04d}.png"
            extract_frame_png(str(original_path), source_frame_index, str(original_frame_path))
            original_image = Image.open(original_frame_path).convert("RGB")
            original_key = paths.report_artifact(report_id, _report_safe_stem("compare", "original", f"f{source_frame_index:04d}"), ".png")
            asset_store.put_bytes(original_key, _image_to_png_bytes(original_image), content_type="image/png")

            pending_items: list[dict[str, Any]] = []
            diff_images: list[Image.Image] = []
            for item in downloaded_generations:
                generation = item["generation"]
                frame_count = int(item["probe"].get("frame_count") or 0)
                gen_fps = int(item["probe"].get("fps_num") or 30) / max(1, int(item["probe"].get("fps_den") or 1))
                source_offset = int(item.get("sourceFrameOffset") or 0)
                expected_generated_frame_index = round(((source_frame_index - source_offset) / float(source_fps)) * gen_fps)
                if expected_generated_frame_index < 0 or expected_generated_frame_index >= frame_count:
                    continue
                gen_id = str(generation.get("genId") or "")
                generated_frame_index, generated_image, similarity_score = _best_aligned_generated_frame_index(
                    generated_path=item["path"],
                    source_image=original_image,
                    expected_frame_index=expected_generated_frame_index,
                    frame_count=frame_count,
                    work_dir=td_path / "compare_alignment",
                    prefix=f"{gen_id}_{source_frame_index:04d}",
                    search_radius=2,
                )
                if generated_image.size != original_image.size:
                    display_generated_image = generated_image.resize(original_image.size, Image.Resampling.LANCZOS)
                else:
                    display_generated_image = generated_image
                diff_gray, diff_heatmap = _diff_heatmap_image(original_image, display_generated_image)
                diff_images.append(diff_gray)
                pending_items.append(
                    {
                        "genId": gen_id,
                        "model": generation.get("luma", {}).get("model"),
                        "mode": generation.get("luma", {}).get("mode"),
                        "generatedFrameIndex": generated_frame_index,
                        "expectedGeneratedFrameIndex": expected_generated_frame_index,
                        "matchSimilarity": similarity_score,
                        "sourceFrameOffset": source_offset,
                        "generatedImage": display_generated_image,
                        "diffImage": diff_heatmap,
                    }
                )

            zoom_region = _zoom_region_from_diffs(diff_images, original_image.size)
            original_zoom = _zoom_image(original_image, zoom_region, original_image.size)
            original_zoom_key = paths.report_artifact(report_id, _report_safe_stem("compare", "original", f"f{source_frame_index:04d}", "zoom"), ".png")
            asset_store.put_bytes(original_zoom_key, _image_to_png_bytes(original_zoom), content_type="image/png")

            sample_items: list[dict[str, Any]] = []
            for pending in pending_items:
                gen_id = str(pending["genId"])
                stem = _report_safe_stem("compare", gen_id[-8:], f"f{source_frame_index:04d}", f"g{int(pending['generatedFrameIndex']):04d}")
                frame_key = paths.report_artifact(report_id, f"{stem}_frame", ".png")
                diff_key = paths.report_artifact(report_id, f"{stem}_diff", ".png")
                zoom_frame_key = paths.report_artifact(report_id, f"{stem}_zoom_frame", ".png")
                zoom_diff_key = paths.report_artifact(report_id, f"{stem}_zoom_diff", ".png")
                generated_image = pending["generatedImage"]
                diff_image = pending["diffImage"]
                asset_store.put_bytes(frame_key, _image_to_png_bytes(generated_image), content_type="image/png")
                asset_store.put_bytes(diff_key, _image_to_png_bytes(diff_image), content_type="image/png")
                asset_store.put_bytes(zoom_frame_key, _image_to_png_bytes(_zoom_image(generated_image, zoom_region, original_image.size)), content_type="image/png")
                asset_store.put_bytes(zoom_diff_key, _image_to_png_bytes(_zoom_image(diff_image, zoom_region, original_image.size)), content_type="image/png")
                sample_items.append(
                    {
                        "genId": gen_id,
                        "model": pending.get("model"),
                        "mode": pending.get("mode"),
                        "generatedFrameIndex": pending.get("generatedFrameIndex"),
                        "expectedGeneratedFrameIndex": pending.get("expectedGeneratedFrameIndex"),
                        "matchSimilarity": pending.get("matchSimilarity"),
                        "sourceFrameOffset": pending.get("sourceFrameOffset"),
                        "frameKey": frame_key,
                        "diffKey": diff_key,
                        "zoomFrameKey": zoom_frame_key,
                        "zoomDiffKey": zoom_diff_key,
                    }
                )

            samples.append(
                {
                    "frameIndex": source_frame_index,
                    "comparisonFrameIndex": comparison_frame_index,
                    "sourceFrameIndex": source_frame_index,
                    "timeSec": round(source_frame_index / float(source_fps), 4),
                    "alignedTimeSec": round(comparison_frame_index / float(source_fps), 4),
                    "originalKey": original_key,
                    "originalZoomKey": original_zoom_key,
                    "zoomRegion": zoom_region,
                    "items": sample_items,
                }
            )

    return {
        "segmentId": segment_id,
        "segmentStartFrame": start_frame,
        "segmentEndFrameExclusive": first_segment.get("endFrameExclusive"),
        "sampleFrameIndices": available_source_frame_indices,
        "comparisonFrameOffsets": [frame_index - aligned_start_frame for frame_index in available_source_frame_indices],
        "sourceFps": round(float(source_fps), 4),
        "alignment": {
            "method": "anchor_sequence_visual_signature",
            "scanFrameCount": alignment_scan_count,
            "anchorFrames": list(VIDEO_COMPARE_ALIGNMENT_ANCHOR_FRAMES),
            "alignedStartFrame": aligned_start_frame,
            "note": "Each generated video is offset independently by matching several early generated anchor frames against source-frame sequences; report frame 0 starts at the latest matched source frame available across selected models.",
        },
        "generations": [item["table"] for item in downloaded_generations],
        "samples": samples,
    }


def _build_timeline_graph_png(rows: list[dict[str, Any]]) -> bytes:
    width, height = 1280, 720
    chart = Image.new("RGB", (width, height), (244, 247, 249))
    draw = ImageDraw.Draw(chart)
    left, top, right, bottom = 84, 36, width - 88, height - 72
    draw.rectangle((left, top, right, bottom), fill=(255, 255, 255), outline=(206, 214, 222), width=2)

    if not rows:
        draw.text((left + 24, top + 20), "No QC timeline data", fill=(90, 105, 120))
        output = BytesIO()
        chart.save(output, format="PNG")
        return output.getvalue()

    time_values = [float(item.get("timeSec") or 0.0) for item in rows]
    changed_values = [max(0.0, float(item.get("changedPctTotal") or 0.0)) for item in rows]
    outside_values = [
        max(0.0, float(item.get("outsideLeakagePct") or 0.0))
        for item in rows
        if item.get("outsideLeakagePct") is not None
    ]
    drift_values = [float(item.get("frameDeltaDrift") or 0.0) for item in rows if item.get("frameDeltaDrift") is not None]
    max_time = max(0.1, max(time_values))
    y_max = max(1.0, max(changed_values), max(outside_values) if outside_values else 0.0, QC_OUTSIDE_LEAK_BUDGET_PCT)
    drift_max_abs = max(1.0, max((abs(value) for value in drift_values), default=0.0))

    def _point(time_sec: float, value: float) -> tuple[float, float]:
        x = left + ((time_sec / max_time) * (right - left))
        y = bottom - ((value / y_max) * (bottom - top))
        return x, y

    def _drift_point(time_sec: float, drift_frames: float) -> tuple[float, float]:
        x = left + ((time_sec / max_time) * (right - left))
        normalized = max(-1.0, min(1.0, drift_frames / drift_max_abs))
        y = top + ((1.0 - ((normalized + 1.0) / 2.0)) * (bottom - top))
        return x, y

    for tick in range(6):
        y = top + ((bottom - top) * tick / 5.0)
        value = y_max * (1.0 - tick / 5.0)
        draw.line((left, y, right, y), fill=(232, 236, 241), width=1)
        draw.text((18, y - 8), f"{value:.1f}%", fill=(96, 110, 124))

    for tick in range(5):
        y = top + ((bottom - top) * tick / 4.0)
        value = drift_max_abs * (1.0 - (tick / 2.0))
        label = "0.0f" if abs(value) < 1e-6 else f"{value:+.1f}f"
        draw.text((right + 12, y - 8), label, fill=(121, 81, 255))

    for tick in range(6):
        x = left + ((right - left) * tick / 5.0)
        value = max_time * tick / 5.0
        draw.line((x, top, x, bottom), fill=(236, 240, 244), width=1)
        draw.text((x - 12, bottom + 10), f"{value:.1f}s", fill=(96, 110, 124))

    budget_y = _point(0.0, QC_OUTSIDE_LEAK_BUDGET_PCT)[1]
    step = 16
    for start_x in range(left, right, step):
        draw.line((start_x, budget_y, min(right, start_x + (step // 2)), budget_y), fill=(210, 74, 74), width=2)

    changed_points = [_point(float(item.get("timeSec") or 0.0), max(0.0, float(item.get("changedPctTotal") or 0.0))) for item in rows]
    if len(changed_points) >= 2:
        draw.line(changed_points, fill=(239, 133, 49), width=4, joint="curve")

    outside_points = [
        _point(float(item.get("timeSec") or 0.0), max(0.0, float(item.get("outsideLeakagePct") or 0.0)))
        for item in rows
        if item.get("outsideLeakagePct") is not None
    ]
    if len(outside_points) >= 2:
        draw.line(outside_points, fill=(40, 122, 214), width=3, joint="curve")

    zero_drift_y = _drift_point(0.0, 0.0)[1]
    draw.line((left, zero_drift_y, right, zero_drift_y), fill=(202, 190, 236), width=1)
    drift_points = [
        _drift_point(float(item.get("timeSec") or 0.0), float(item.get("frameDeltaDrift") or 0.0))
        for item in rows
        if item.get("frameDeltaDrift") is not None
    ]
    if len(drift_points) >= 2:
        draw.line(drift_points, fill=(121, 81, 255), width=3, joint="curve")
    elif len(drift_points) == 1:
        x, y = drift_points[0]
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(121, 81, 255))

    draw.text((left + 14, top + 10), "Changed %", fill=(239, 133, 49))
    draw.text((left + 130, top + 10), "Outside leak %", fill=(40, 122, 214))
    draw.text((left + 300, top + 10), "Leak budget", fill=(210, 74, 74))
    draw.text((left + 430, top + 10), "Frame drift", fill=(121, 81, 255))

    output = BytesIO()
    chart.save(output, format="PNG")
    return output.getvalue()


def _motion_energy_series(frame_paths: list[Path]) -> list[float]:
    energies: list[float] = []
    previous_gray: Image.Image | None = None
    for frame_path in frame_paths:
        with Image.open(frame_path) as frame_image:
            current_gray = ImageOps.exif_transpose(frame_image).convert("L")
            if previous_gray is None:
                energies.append(0.0)
            else:
                diff = ImageChops.difference(previous_gray, current_gray)
                mean_diff = float(ImageStat.Stat(diff).mean[0]) / 255.0
                energies.append(round(mean_diff, 6))
            previous_gray = current_gray.copy()
    return energies


def _normalized_correlation(first: list[float], second: list[float]) -> float:
    sample_count = min(len(first), len(second))
    if sample_count < 8:
        return 0.0
    first_values = first[:sample_count]
    second_values = second[:sample_count]
    mean_first = sum(first_values) / sample_count
    mean_second = sum(second_values) / sample_count
    centered_first = [value - mean_first for value in first_values]
    centered_second = [value - mean_second for value in second_values]
    var_first = sum(value * value for value in centered_first)
    var_second = sum(value * value for value in centered_second)
    if var_first <= 1e-12 or var_second <= 1e-12:
        return 0.0
    covariance = sum(a * b for a, b in zip(centered_first, centered_second))
    return float(covariance / math.sqrt(var_first * var_second))


def _best_motion_lag(
    original: list[float],
    merged: list[float],
    *,
    max_lag_samples: int,
) -> dict[str, Any]:
    baseline = _normalized_correlation(original, merged)
    max_lag = max(0, min(max_lag_samples, max(0, min(len(original), len(merged)) - 8)))
    best_lag = 0
    best_corr = baseline
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            original_slice = original[lag:]
            merged_slice = merged[: len(original_slice)]
        else:
            original_slice = original[: len(original) + lag]
            merged_slice = merged[-lag:]
        overlap = min(len(original_slice), len(merged_slice))
        if overlap < 8:
            continue
        corr = _normalized_correlation(original_slice[:overlap], merged_slice[:overlap])
        if corr > best_corr:
            best_corr = corr
            best_lag = lag

    improvement = best_corr - baseline
    confidence = max(0.0, min(1.0, (improvement + 0.04) / 0.2))
    return {
        "baselineCorrelation": round(baseline, 6),
        "bestCorrelation": round(best_corr, 6),
        "bestLagSamples": int(best_lag),
        "improvement": round(improvement, 6),
        "confidence": round(confidence, 4),
    }


def _build_motion_sync_graph_png(rows: list[dict[str, Any]], *, max_time: float) -> bytes:
    width, height = 1280, 720
    chart = Image.new("RGB", (width, height), (244, 247, 249))
    draw = ImageDraw.Draw(chart)
    left, top, right, bottom = 84, 36, width - 40, height - 72
    draw.rectangle((left, top, right, bottom), fill=(255, 255, 255), outline=(206, 214, 222), width=2)

    if not rows:
        draw.text((left + 24, top + 20), "No motion sync timeline data", fill=(90, 105, 120))
        output = BytesIO()
        chart.save(output, format="PNG")
        return output.getvalue()

    energy_values: list[float] = []
    for item in rows:
        for key in ("originalEnergy", "mergedEnergy", "shiftedMergedEnergy"):
            value = item.get(key)
            if isinstance(value, (float, int)):
                energy_values.append(max(0.0, float(value)))
    y_max = max(0.05, max(energy_values) if energy_values else 0.05)
    max_time = max(0.1, max_time)

    def _point(time_sec: float, value: float) -> tuple[float, float]:
        x = left + ((time_sec / max_time) * (right - left))
        y = bottom - ((max(0.0, value) / y_max) * (bottom - top))
        return x, y

    for tick in range(6):
        y = top + ((bottom - top) * tick / 5.0)
        value = y_max * (1.0 - tick / 5.0)
        draw.line((left, y, right, y), fill=(232, 236, 241), width=1)
        draw.text((18, y - 8), f"{value:.3f}", fill=(96, 110, 124))

    for tick in range(6):
        x = left + ((right - left) * tick / 5.0)
        value = max_time * tick / 5.0
        draw.line((x, top, x, bottom), fill=(236, 240, 244), width=1)
        draw.text((x - 12, bottom + 10), f"{value:.1f}s", fill=(96, 110, 124))

    original_points = [_point(float(item.get("timeSec") or 0.0), float(item.get("originalEnergy") or 0.0)) for item in rows]
    merged_points = [_point(float(item.get("timeSec") or 0.0), float(item.get("mergedEnergy") or 0.0)) for item in rows]
    shifted_points = [
        _point(float(item.get("timeSec") or 0.0), float(item.get("shiftedMergedEnergy") or 0.0))
        for item in rows
        if item.get("shiftedMergedEnergy") is not None
    ]
    shifted_distinct = any(
        item.get("shiftedMergedEnergy") is not None
        and abs(float(item.get("shiftedMergedEnergy") or 0.0) - float(item.get("mergedEnergy") or 0.0)) > 1e-6
        for item in rows
    )

    if len(original_points) >= 2:
        draw.line(original_points, fill=(46, 113, 204), width=3, joint="curve")
    if shifted_distinct and len(shifted_points) >= 2:
        # Draw shifted first (thinner) so merged remains visible where paths overlap.
        draw.line(shifted_points, fill=(37, 173, 127), width=2, joint="curve")
    if len(merged_points) >= 2:
        draw.line(merged_points, fill=(235, 139, 51), width=3, joint="curve")

    draw.text((left + 14, top + 10), "Original motion", fill=(46, 113, 204))
    draw.text((left + 160, top + 10), "Merged motion", fill=(235, 139, 51))
    if shifted_distinct:
        draw.text((left + 300, top + 10), "Merged motion (shifted)", fill=(37, 173, 127))
    else:
        draw.text((left + 300, top + 10), "Shifted trace not shown (best lag 0)", fill=(120, 130, 140))

    output = BytesIO()
    chart.save(output, format="PNG")
    return output.getvalue()


def _parse_metric_log(log_path: Path, pattern: re.Pattern[str], group_name: str) -> list[float]:
    values: list[float] = []
    if not log_path.exists():
        return values
    for line in log_path.read_text().splitlines():
        match = pattern.search(line)
        if not match:
            continue
        try:
            values.append(float(match.group(group_name)))
        except ValueError:
            continue
    return values


def _run_optional_vmaf(orig_path: Path, edited_path: Path, output_json: Path) -> dict[str, Any] | None:
    command = [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(orig_path),
        "-i",
        str(edited_path),
        "-lavfi",
        f"libvmaf=log_fmt=json:log_path={output_json}",
        "-shortest",
        "-f",
        "null",
        "-",
    ]
    try:
        _run_command(command)
    except Exception as exc:
        logger.warning("VMAF unavailable or failed", extra={"error": str(exc)})
        return None

    if not output_json.exists():
        return None
    try:
        payload = json.loads(output_json.read_text())
    except Exception:
        return None
    frames = payload.get("frames", [])
    frame_values = [
        float(frame.get("metrics", {}).get("vmaf"))
        for frame in frames
        if isinstance(frame, dict) and frame.get("metrics", {}).get("vmaf") is not None
    ]
    pooled = payload.get("pooled_metrics", {}).get("vmaf", {})
    mean_value = pooled.get("mean")
    if mean_value is None and frame_values:
        mean_value = sum(frame_values) / len(frame_values)
    return {
        "mean": round(float(mean_value), 4) if mean_value is not None else None,
        "min": round(min(frame_values), 4) if frame_values else None,
        "max": round(max(frame_values), 4) if frame_values else None,
        "frameCount": len(frame_values),
    }


def _extract_sampled_frames(video_path: Path, output_dir: Path, *, sample_fps: int, duration_sec: float, start_sec: float = 0.0) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_pattern = output_dir / "frame_%05d.png"
    command = [
        FFMPEG_BIN,
        "-y",
        "-ss",
        f"{max(0.0, start_sec):.6f}",
        "-i",
        str(video_path),
        "-t",
        f"{max(0.1, duration_sec):.6f}",
        "-vf",
        f"fps={sample_fps}",
        "-frames:v",
        str(QC_ANALYSIS_MAX_FRAMES),
        str(frame_pattern),
    ]
    _run_command(command)
    return sorted(output_dir.glob("frame_*.png"))


def _extract_interval_frames(
    video_path: Path,
    output_dir: Path,
    *,
    fps: Fraction,
    duration_sec: float,
    interval_sec: float,
) -> list[dict[str, Any]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    if duration_sec <= 0:
        return rows
    time_sec = 0.0
    index = 0
    max_frame_index = max(0, int(math.floor(duration_sec * float(fps))) - 1)
    epsilon = 1e-4
    while time_sec < duration_sec - epsilon and len(rows) < QC_ANALYSIS_MAX_FRAMES:
        frame_index = min(max_frame_index, max(0, int(round(time_sec * float(fps)))))
        output_path = output_dir / f"frame_{index:05d}.png"
        extract_frame_png(str(video_path), frame_index, str(output_path))
        rows.append(
            {
                "index": index,
                "frameIndex": frame_index,
                "timeSec": round(time_sec, 4),
                "path": output_path,
            }
        )
        index += 1
        time_sec += interval_sec
    return rows


def _frame_aligned_sample_rows(
    *,
    source_frame_offset: int,
    source_frame_count: int,
    generated_frame_count: int,
    fps: Fraction,
    sample_fps: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    common_frame_count = min(max(0, source_frame_count - max(0, source_frame_offset)), max(0, generated_frame_count))
    if common_frame_count <= 0:
        return rows
    fps_value = float(fps)
    sample_interval_sec = 1.0 / float(max(1, sample_fps))
    sample_time_sec = 0.0
    previous_relative_index = -1
    sample_index = 0
    while (
        sample_index < QC_ANALYSIS_MAX_FRAMES
        and sample_time_sec <= ((common_frame_count - 1) / max(1e-9, fps_value)) + 1e-9
    ):
        relative_frame_index = int(round(sample_time_sec * fps_value))
        if relative_frame_index <= previous_relative_index:
            relative_frame_index = previous_relative_index + 1
        if relative_frame_index >= common_frame_count:
            break
        source_frame_index = source_frame_offset + relative_frame_index
        generated_frame_index = relative_frame_index
        rows.append(
            {
                "index": sample_index,
                "sourceFrameIndex": source_frame_index,
                "generatedFrameIndex": generated_frame_index,
                "timeSec": round(source_frame_index / fps_value, 4),
                "generatedTimeSec": round(generated_frame_index / fps_value, 4),
            }
        )
        previous_relative_index = relative_frame_index
        sample_index += 1
        sample_time_sec += sample_interval_sec
    return rows


def _build_external_video_report_rows(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    paths: AssetPaths,
    report_id: str,
    pair_id: str,
    tests: set[str],
) -> dict[str, Any]:
    pair = next(
        (
            item
            for item in task.get("externalQcPairs", [])
            if isinstance(item, dict) and str(item.get("pairId") or "") == pair_id
        ),
        None,
    )
    if not isinstance(pair, dict):
        raise RuntimeError(f"External QC pair {pair_id} not found")
    original_key = str(pair.get("originalKey") or "")
    edited_key = str(pair.get("editedKey") or "")
    if not original_key or not edited_key:
        raise RuntimeError(f"External QC pair {pair_id} is incomplete")

    rows: list[dict[str, Any]] = []
    video_comparison: dict[str, Any] | None = None
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        original_video_path = td_path / "original_input.mp4"
        edited_video_path = td_path / "edited_input.mp4"
        original_standard_path = td_path / "original_standard.mp4"
        edited_standard_path = td_path / "edited_standard.mp4"
        original_video_path.write_bytes(asset_store.read_bytes(original_key))
        edited_video_path.write_bytes(asset_store.read_bytes(edited_key))

        original_probe = ffprobe_video(str(original_video_path))
        edited_probe = ffprobe_video(str(edited_video_path))
        original_fps = Fraction(int(original_probe.get("fps_num") or 30), int(original_probe.get("fps_den") or 1))
        edited_fps = Fraction(int(edited_probe.get("fps_num") or 30), int(edited_probe.get("fps_den") or 1))
        target_fps = Fraction(min(24, max(1, int(round(min(float(original_fps), float(edited_fps)) or 24)))) , 1)
        analysis_width, analysis_height = _target_by_orientation(
            int(original_probe.get("width") or edited_probe.get("width") or 1920),
            int(original_probe.get("height") or edited_probe.get("height") or 1080),
            landscape=(960, 540),
            portrait=(540, 960),
        )
        transcode_to_cfr(
            str(original_video_path),
            str(original_standard_path),
            target_fps,
            target_width=analysis_width,
            target_height=analysis_height,
            crf=20,
            preset="veryfast",
            audio_bitrate="96k",
        )
        transcode_to_cfr(
            str(edited_video_path),
            str(edited_standard_path),
            target_fps,
            target_width=analysis_width,
            target_height=analysis_height,
            crf=20,
            preset="veryfast",
            audio_bitrate="96k",
        )
        standard_original_probe = ffprobe_video(str(original_standard_path))
        standard_edited_probe = ffprobe_video(str(edited_standard_path))
        common_duration_sec = max(
            0.1,
            min(
                float(standard_original_probe.get("duration_sec") or 0.0),
                float(standard_edited_probe.get("duration_sec") or 0.0),
            ),
        )
        sampled_original = _extract_interval_frames(
            original_standard_path,
            td_path / "orig_frames",
            fps=target_fps,
            duration_sec=common_duration_sec,
            interval_sec=2.0,
        )
        sampled_edited = _extract_interval_frames(
            edited_standard_path,
            td_path / "edited_frames",
            fps=target_fps,
            duration_sec=common_duration_sec,
            interval_sec=2.0,
        )
        paired_count = min(len(sampled_original), len(sampled_edited))
        if paired_count == 0:
            raise RuntimeError("No sampled frames available for uploaded video comparison")

        for sample_index in range(paired_count):
            original_sample = sampled_original[sample_index]
            edited_sample = sampled_edited[sample_index]
            rows.append(
                _build_external_frame_report_row(
                    asset_store=asset_store,
                    paths=paths,
                    report_id=report_id,
                    pair_id=pair_id,
                    original_frame_bytes=original_sample["path"].read_bytes(),
                    edited_frame_bytes=edited_sample["path"].read_bytes(),
                    original_filename=pair.get("originalFilename"),
                    edited_filename=pair.get("editedFilename"),
                    label=f"{pair.get('name') or 'External video comparison'} - {original_sample['timeSec']:.1f}s",
                    created_at=pair.get("createdAt"),
                    original_frame_key=None,
                    edited_frame_key=None,
                    tests=tests,
                )
                | {
                    "sourceMediaType": "video",
                    "sampleIndex": sample_index,
                    "sampleTimeSec": original_sample["timeSec"],
                }
            )

        if "video_diff" in tests:
            diff_video_path = td_path / "diff_map.mp4"
            diff_video_poster_path = td_path / "diff_map_poster.png"
            _run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-i",
                    str(original_standard_path),
                    "-i",
                    str(edited_standard_path),
                    "-filter_complex",
                    "[0:v][1:v]blend=all_mode=difference,eq=contrast=2.0:brightness=0.02:saturation=1.5[v]",
                    "-map",
                    "[v]",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-shortest",
                    str(diff_video_path),
                ]
            )
            _run_command([FFMPEG_BIN, "-y", "-i", str(diff_video_path), "-frames:v", "1", str(diff_video_poster_path)])
            stem_base = _report_safe_stem("external_video", pair_id[-8:], "diff")
            diff_video_key = paths.report_artifact(report_id, f"{stem_base}_video", ".mp4")
            diff_video_poster_key = paths.report_artifact(report_id, f"{stem_base}_poster", ".png")
            asset_store.put_bytes(diff_video_key, diff_video_path.read_bytes(), content_type="video/mp4")
            asset_store.put_bytes(diff_video_poster_key, diff_video_poster_path.read_bytes(), content_type="image/png")
            video_comparison = {
                "pairId": pair_id,
                "label": pair.get("name") or "External video comparison",
                "originalFilename": pair.get("originalFilename"),
                "editedFilename": pair.get("editedFilename"),
                "diffVideoKey": diff_video_key,
                "diffVideoPosterKey": diff_video_poster_key,
                "durationSec": round(common_duration_sec, 4),
                "sampleIntervalSec": 2.0,
                "sampledFrameCount": paired_count,
            }

    return {"rows": rows, "videoComparison": video_comparison}


def _handle_qc_report_build(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    report_id = str((job.get("payload") or {}).get("reportId") or "")
    if not report_id:
        raise RuntimeError("Missing reportId for QC report build")

    reports = task.get("customReports", [])
    report = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
    if not isinstance(report, dict):
        raise RuntimeError(f"Report {report_id} not found")

    report["status"] = "running"
    report["updatedAt"] = now_iso()
    report["jobId"] = job.get("jobId")
    report.pop("error", None)
    store.save_task(task)
    _job_progress(job, store, 10, "running", f"Building report {report_id}")

    report_type = str(report.get("reportType") or "")
    tests = {str(item) for item in list(report.get("tests") or [])}
    asset_refs = list(report.get("assetRefs") or [])
    paths = _asset_paths(task)
    rows: list[dict[str, Any]] = []
    video_comparisons: list[dict[str, Any]] = []
    video_compare: dict[str, Any] | None = None
    failures: list[dict[str, Any]] = []

    if report_type == "video_compare":
        try:
            video_compare = _build_video_comparison_report(
                task=task,
                asset_store=asset_store,
                paths=paths,
                report_id=report_id,
                asset_refs=asset_refs,
                settings=settings,
            )
            _job_progress(job, store, 90, "running", "Built video comparison report")
        except Exception as exc:
            failures.append({"assetRef": {"assetType": "video_compare"}, "error": str(exc)})
    elif report_type == "previz_review":
        for index, asset_ref in enumerate(asset_refs):
            try:
                if not isinstance(asset_ref, dict):
                    raise RuntimeError("Invalid report asset reference")
                if asset_ref.get("assetType") != "segment_generation":
                    raise RuntimeError("Previz review reports only support generated videos")
                row = _build_previz_report_row(
                    task=task,
                    report_id=report_id,
                    gen_id=str(asset_ref.get("genId") or ""),
                )
                rows.append(row)
            except Exception as exc:
                failures.append(
                    {
                        "assetRef": asset_ref,
                        "error": str(exc),
                    }
                )
            progress = 10 + math.floor(80 * (index + 1) / max(1, len(asset_refs)))
            _job_progress(job, store, progress, "running", f"Built {index + 1}/{len(asset_refs)} previz report rows")
    else:
        for index, asset_ref in enumerate(asset_refs):
            try:
                if not isinstance(asset_ref, dict):
                    raise RuntimeError("Invalid report asset reference")
                asset_type = asset_ref.get("assetType")
                if asset_type == "frame_variant":
                    row = _build_frame_report_row(
                        task=task,
                        asset_store=asset_store,
                        paths=paths,
                        report_id=report_id,
                        frame_id=str(asset_ref.get("frameId") or ""),
                        variant_id=str(asset_ref.get("variantId") or ""),
                        tests=tests,
                    )
                elif asset_type == "external_frame_pair":
                    pair_id = str(asset_ref.get("pairId") or "")
                    pair = next(
                        (
                            item
                            for item in task.get("externalQcPairs", [])
                            if isinstance(item, dict) and str(item.get("pairId") or "") == pair_id
                        ),
                        None,
                    )
                    if not isinstance(pair, dict):
                        raise RuntimeError(f"External QC pair {pair_id} not found")
                    if str(pair.get("mediaType") or "image") == "video":
                        bundle = _build_external_video_report_rows(
                            task=task,
                            asset_store=asset_store,
                            paths=paths,
                            report_id=report_id,
                            pair_id=pair_id,
                            tests=tests,
                        )
                        rows.extend([item for item in bundle.get("rows") or [] if isinstance(item, dict)])
                        if isinstance(bundle.get("videoComparison"), dict):
                            video_comparisons.append(bundle["videoComparison"])
                        row = None
                    else:
                        row = _build_external_image_pair_report_row(
                            task=task,
                            asset_store=asset_store,
                            paths=paths,
                            report_id=report_id,
                            pair_id=pair_id,
                            tests=tests,
                        )
                elif asset_type == "segment_generation":
                    row = _build_video_report_row(
                        task=task,
                        asset_store=asset_store,
                        store=store,
                        paths=paths,
                        report_id=report_id,
                        gen_id=str(asset_ref.get("genId") or ""),
                        tests=tests,
                        settings=settings,
                    )
                elif asset_type == "export":
                    row = _build_export_video_report_row(
                        task=task,
                        asset_store=asset_store,
                        store=store,
                        paths=paths,
                        report_id=report_id,
                        export_id=str(asset_ref.get("exportId") or ""),
                        tests=tests,
                        settings=settings,
                    )
                else:
                    raise RuntimeError(f"Unsupported report asset type: {asset_type}")
                if isinstance(row, dict):
                    rows.append(row)
            except Exception as exc:
                failures.append(
                    {
                        "assetRef": asset_ref,
                        "error": str(exc),
                    }
                )
            progress = 10 + math.floor(80 * (index + 1) / max(1, len(asset_refs)))
            _job_progress(job, store, progress, "running", f"Built {index + 1}/{len(asset_refs)} report rows")

    result_key = str(report.get("resultKey") or S3JsonStore.report_result_key(task["userId"], task["taskId"], report_id))
    result_payload = {
        "reportId": report_id,
        "taskId": task["taskId"],
        "reportType": report_type,
        "name": report.get("name"),
        "tests": sorted(tests),
        "createdAt": report.get("createdAt"),
        "builtAt": now_iso(),
        "rowCount": len(rows),
        "failureCount": len(failures),
        "rows": rows,
        "videoComparisons": video_comparisons,
        "videoCompare": video_compare,
        "failures": failures,
    }
    store.put_json(result_key, result_payload)

    report["status"] = "failed" if rows == [] and video_compare is None and failures else "complete"
    report["updatedAt"] = now_iso()
    report["resultKey"] = result_key
    if failures:
        report["error"] = f"{len(failures)} asset(s) failed during report build"
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "QC report build complete")
    job["resultRefs"] = {"reportId": report_id, "resultKey": result_key}
    store.save_job(job)
    return job


def _handle_task_purge(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    _job_progress(job, store, 10, "running", "Purging task assets")
    paths = _asset_paths(task)
    asset_store.delete_prefix(f"{paths.task_prefix()}/", purge_versions=True)

    _job_progress(job, store, 55, "running", "Purging task metadata snapshots")
    user_id = str(task.get("userId") or "")
    task_id = str(task.get("taskId") or "")
    store.delete_prefix(store.task_snapshots_prefix(user_id, task_id), purge_versions=True)
    store.delete_prefix(f"users/{user_id}/tasks/{task_id}/reports/", purge_versions=True)

    _job_progress(job, store, 80, "running", "Shrinking deleted task metadata")
    tombstone = {
        "taskId": task_id,
        "userId": user_id,
        "name": task.get("name"),
        "workflowId": task.get("workflowId"),
        "filePrefix": task.get("filePrefix"),
        "createdAt": task.get("createdAt"),
        "updatedAt": now_iso(),
        "deletedAt": task.get("deletedAt") or now_iso(),
        "purgedAt": now_iso(),
        "status": "deleted",
        "metaVersion": int(task.get("metaVersion", 0)),
        "history": [],
    }
    store.save_task(tombstone, snapshot=False, merge_on_conflict=False)

    _job_progress(job, store, 100, "complete", "Task purge complete")
    job["resultRefs"] = {"taskId": task_id}
    store.save_job(job)
    return job


def _find_export_record(task: dict[str, Any], export_id: str) -> dict[str, Any] | None:
    exports = task.get("exports")
    if not isinstance(exports, list):
        return None
    return next((item for item in exports if isinstance(item, dict) and item.get("exportId") == export_id), None)


def _topaz_preset_defaults(preset: str) -> dict[str, Any]:
    if preset == "recover_detail":
        return {
            "recover_detail": 0.7,
            "noise": 0.12,
            "compression": 0.1,
            "halo": 0.08,
            "grain": 0.0,
        }
    if preset == "fast_sharpen":
        return {
            "recover_detail": 0.3,
            "noise": 0.2,
            "compression": 0.15,
            "halo": 0.15,
            "grain": 0.0,
        }
    return {
        "recover_detail": 0.45,
        "noise": 0.15,
        "compression": 0.1,
        "halo": 0.1,
        "grain": 0.0,
    }


def _handle_export_topaz_upscale(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job.get("payload") or {}
    source_export_id = str(payload.get("sourceExportId") or "")
    result_export_id = str(payload.get("resultExportId") or "")
    if not source_export_id:
        raise RuntimeError("Missing sourceExportId for Topaz upscale")
    if not result_export_id:
        raise RuntimeError("Missing resultExportId for Topaz upscale")

    source_export = _find_export_record(task, source_export_id)
    if not source_export:
        raise RuntimeError(f"Export {source_export_id} not found")
    source_output_key = str(source_export.get("outputKey") or "")
    if not source_output_key:
        raise RuntimeError("Source export output missing")

    request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    preset = str(request.get("preset") or "balanced")
    model = str(request.get("model") or "Proteus")
    upscale_factor = float(request.get("upscaleFactor") or 1.0)
    target_fps = request.get("targetFps")
    h264_output = bool(request.get("h264Output"))

    topaz_state = source_export.setdefault("topazUpscale", {})
    topaz_state.update(
        {
            "status": "running",
            "updatedAt": now_iso(),
            "jobId": job.get("jobId"),
            "resultExportId": result_export_id,
            "preset": preset,
            "model": model,
            "upscaleFactor": upscale_factor,
            "targetFps": target_fps if isinstance(target_fps, int) else None,
            "h264Output": h264_output,
        }
    )
    store.save_task(task)
    _job_progress(job, store, 10, "running", "Preparing Topaz upscale request")

    secrets = load_secret(settings.secrets_arn)
    fal_api_key = secrets.get("FAL_API_KEY")
    if not fal_api_key:
        raise RuntimeError("FAL_API_KEY is required for Topaz upscale")

    request_payload: dict[str, Any] = {
        "video_url": asset_store.presign_get(source_output_key, expires=6 * 3600),
        "model": model,
        "upscale_factor": upscale_factor,
        "H264_output": h264_output,
    }
    if isinstance(target_fps, int) and target_fps > 0:
        request_payload["target_fps"] = target_fps
    request_payload.update(_topaz_preset_defaults(preset))
    request_payload_for_state = {k: v for k, v in request_payload.items() if k != "video_url"}

    _job_progress(job, store, 30, "running", "Submitting Topaz upscale job")
    created = submit_topaz_video_upscale(api_key=fal_api_key, input=request_payload)
    _job_progress(job, store, 55, "running", "Topaz upscale running")
    result = _wait_fal_queue_complete(fal_api_key, created=created, timeout_sec=TOPAZ_UPSCALE_TIMEOUT_SEC)
    output_url = _parse_fal_video_output_url(result)

    s3 = boto3.client("s3")
    paths = _asset_paths(task)
    result_output_key = paths.export_output(result_export_id)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        downloaded_path = td_path / "topaz_upscaled.mp4"
        _download_url_to_path(output_url, downloaded_path, timeout=900)
        output_probe = ffprobe_video(str(downloaded_path))
        _upload_s3(s3, settings.assets_bucket, result_output_key, downloaded_path, "video/mp4")

    existing_result_export = _find_export_record(task, result_export_id)
    result_export_record = {
        "exportId": result_export_id,
        "outputKey": result_output_key,
        "createdAt": now_iso(),
        "sourceExportId": source_export_id,
        "topazUpscale": {
            "status": "complete",
            "updatedAt": now_iso(),
            "jobId": job.get("jobId"),
            "preset": preset,
            "model": model,
            "upscaleFactor": upscale_factor,
            "targetFps": target_fps if isinstance(target_fps, int) else None,
            "h264Output": h264_output,
            "provider": "fal",
            "providerModel": "fal-ai/topaz/upscale/video",
            "output": _video_timing_payload(output_probe),
        },
    }
    if isinstance(existing_result_export, dict):
        existing_result_export.update(result_export_record)
    else:
        task.setdefault("exports", []).append(result_export_record)

    _record_usage(
        store=store,
        user_id=task["userId"],
        task=task,
        source="topaz_upscale",
        tool_origin="topaz_upscale",
        request_type="video_upscale",
        provider="fal",
        provider_model="fal-ai/topaz/upscale/video",
        app_model_id="fal-ai/topaz/upscale/video",
        target_record=existing_result_export if isinstance(existing_result_export, dict) else result_export_record,
        asset_id=result_export_id,
        asset_kind="export",
        duration_sec=float(output_probe.get("duration_sec") or 0.0) or None,
        width=int(output_probe.get("width") or 0) or None,
        height=int(output_probe.get("height") or 0) or None,
        fps=(
            float(output_probe.get("fps_num") or 0) / float(output_probe.get("fps_den") or 1)
            if output_probe.get("fps_num")
            else None
        ),
        notes=f"preset={preset};model={model}",
    )

    topaz_state.update(
        {
            "status": "complete",
            "updatedAt": now_iso(),
            "resultExportId": result_export_id,
            "resultOutputKey": result_output_key,
            "provider": "fal",
            "providerModel": "fal-ai/topaz/upscale/video",
            "submittedInput": request_payload_for_state,
        }
    )
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Topaz upscale complete")
    job["resultRefs"] = {"sourceExportId": source_export_id, "exportId": result_export_id, "outputKey": result_output_key}
    store.save_job(job)
    return job


def _handle_motion_sync_qc(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job.get("payload") or {}
    export_id = payload.get("exportId")
    if not isinstance(export_id, str) or not export_id:
        raise RuntimeError("Missing exportId for motion sync QC")

    export_record = next((item for item in task.get("exports", []) if item.get("exportId") == export_id), None)
    if not export_record:
        raise RuntimeError(f"Export {export_id} not found")
    output_key = export_record.get("outputKey")
    if not isinstance(output_key, str) or not output_key:
        raise RuntimeError("Export output missing")

    motion_qc = export_record.setdefault("motionSyncQc", {})
    motion_qc.update(
        {
            "status": "running",
            "updatedAt": now_iso(),
            "jobId": job.get("jobId"),
        }
    )
    store.save_task(task)

    fps_info = task.get("video", {}).get("editSource", {}).get("fps", {})
    source_fps = Fraction(int(fps_info.get("num") or 30), int(fps_info.get("den") or 1))
    source_width = int(task.get("video", {}).get("editSource", {}).get("width") or 1920)
    source_height = int(task.get("video", {}).get("editSource", {}).get("height") or 1080)
    analysis_width, analysis_height = _target_by_orientation(
        source_width,
        source_height,
        landscape=(640, 360),
        portrait=(360, 640),
    )

    s3 = boto3.client("s3")
    paths = _asset_paths(task)
    _job_progress(job, store, 10, "running", "Preparing videos for motion sync analysis")

    try:
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            original_path = td_path / "original.mp4"
            export_path = td_path / "merged.mp4"
            original_standard_path = td_path / "original_sync.mp4"
            export_standard_path = td_path / "merged_sync.mp4"
            edit_source_key = task.get("video", {}).get("editSource", {}).get("s3Key")
            if not edit_source_key:
                raise RuntimeError("Edit source is missing for motion sync analysis")

            _download_s3(s3, settings.assets_bucket, edit_source_key, original_path)
            _download_s3(s3, settings.assets_bucket, output_key, export_path)

            transcode_to_cfr(
                str(original_path),
                str(original_standard_path),
                source_fps,
                target_width=analysis_width,
                target_height=analysis_height,
                crf=22,
                preset="veryfast",
                audio_bitrate="96k",
            )
            transcode_to_cfr(
                str(export_path),
                str(export_standard_path),
                source_fps,
                target_width=analysis_width,
                target_height=analysis_height,
                crf=22,
                preset="veryfast",
                audio_bitrate="96k",
            )

            original_probe = ffprobe_video(str(original_standard_path))
            export_probe = ffprobe_video(str(export_standard_path))
            common_duration_sec = max(
                0.1,
                min(float(original_probe.get("duration_sec") or 0.0), float(export_probe.get("duration_sec") or 0.0)),
            )
            _job_progress(job, store, 35, "running", "Sampling frames for motion signatures")

            original_frames = _extract_sampled_frames(
                original_standard_path,
                td_path / "orig_motion_frames",
                sample_fps=MOTION_SYNC_SAMPLE_FPS,
                duration_sec=common_duration_sec,
            )
            export_frames = _extract_sampled_frames(
                export_standard_path,
                td_path / "merged_motion_frames",
                sample_fps=MOTION_SYNC_SAMPLE_FPS,
                duration_sec=common_duration_sec,
            )

            original_energy = _motion_energy_series(original_frames)
            merged_energy = _motion_energy_series(export_frames)
            sample_count = min(len(original_energy), len(merged_energy))
            if sample_count < 8:
                raise RuntimeError("Not enough sampled motion data for sync analysis")
            original_energy = original_energy[:sample_count]
            merged_energy = merged_energy[:sample_count]

            max_lag_samples = max(1, min(int(MOTION_SYNC_MAX_LAG_SEC * MOTION_SYNC_SAMPLE_FPS), sample_count // 3))
            lag_result = _best_motion_lag(original_energy, merged_energy, max_lag_samples=max_lag_samples)
            best_lag_samples = int(lag_result["bestLagSamples"])
            shift_seconds = float(best_lag_samples) / float(MOTION_SYNC_SAMPLE_FPS)
            source_fps_float = float(source_fps.numerator) / float(source_fps.denominator)
            recommended_shift_frames = int(round(shift_seconds * source_fps_float))

            def _shifted_value(index: int) -> float | None:
                shifted_index = index - best_lag_samples
                if 0 <= shifted_index < sample_count:
                    return merged_energy[shifted_index]
                return None

            rows: list[dict[str, Any]] = []
            for idx in range(sample_count):
                rows.append(
                    {
                        "index": idx,
                        "timeSec": round(idx / float(MOTION_SYNC_SAMPLE_FPS), 4),
                        "originalEnergy": original_energy[idx],
                        "mergedEnergy": merged_energy[idx],
                        "shiftedMergedEnergy": _shifted_value(idx),
                    }
                )

            timeline_csv = "index,timeSec,originalEnergy,mergedEnergy,shiftedMergedEnergy\n" + "\n".join(
                f"{row['index']},{row['timeSec']},{row['originalEnergy']},{row['mergedEnergy']},{row['shiftedMergedEnergy'] if row['shiftedMergedEnergy'] is not None else ''}"
                for row in rows
            )
            timeline_csv_key = paths.export_motion_qc_artifact(export_id, "motion_timeline", ".csv")
            timeline_graph_key = paths.export_motion_qc_artifact(export_id, "motion_timeline_graph", ".png")
            report_json_key = paths.export_motion_qc_artifact(export_id, "motion_sync_report", ".json")
            asset_store.put_bytes(timeline_csv_key, timeline_csv.encode("utf-8"), content_type="text/csv")
            asset_store.put_bytes(
                timeline_graph_key,
                _build_motion_sync_graph_png(rows, max_time=max(0.1, rows[-1]["timeSec"] if rows else 0.1)),
                content_type="image/png",
            )

            recommendation = (
                "no_shift"
                if recommended_shift_frames == 0
                else ("shift_later" if recommended_shift_frames > 0 else "shift_earlier")
            )
            metrics = {
                "sampleFps": MOTION_SYNC_SAMPLE_FPS,
                "maxLagSec": MOTION_SYNC_MAX_LAG_SEC,
                "analysisResolution": {"width": analysis_width, "height": analysis_height},
                "analyzedDurationSec": round(common_duration_sec, 4),
                "sampleCount": sample_count,
                "baselineCorrelation": lag_result["baselineCorrelation"],
                "bestCorrelation": lag_result["bestCorrelation"],
                "correlationGain": lag_result["improvement"],
                "confidence": lag_result["confidence"],
                "bestOffsetSamples": best_lag_samples,
                "bestOffsetSec": round(shift_seconds, 4),
                "recommendedShiftFrames": recommended_shift_frames,
                "recommendedShiftSec": round(recommended_shift_frames / max(1e-6, source_fps_float), 4),
                "recommendation": recommendation,
            }

            report_payload = {
                "exportId": export_id,
                "analyzedAt": now_iso(),
                "metrics": metrics,
                "rows": rows,
                "artifacts": {
                    "timelineCsvKey": timeline_csv_key,
                    "timelineGraphKey": timeline_graph_key,
                },
            }
            asset_store.put_bytes(report_json_key, json.dumps(report_payload).encode("utf-8"), content_type="application/json")

            motion_qc.update(
                {
                    "status": "complete",
                    "updatedAt": now_iso(),
                    "analyzedAt": now_iso(),
                    "metrics": metrics,
                    "artifacts": {
                        "timelineCsvKey": timeline_csv_key,
                        "timelineGraphKey": timeline_graph_key,
                        "reportJsonKey": report_json_key,
                    },
                }
            )
    except Exception as exc:
        motion_qc.update(
            {
                "status": "failed",
                "updatedAt": now_iso(),
                "error": str(exc),
            }
        )
        store.save_task(task)
        raise

    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Motion sync QC complete")
    job["resultRefs"] = {"exportId": export_id}
    store.save_job(job)
    return job


def _cleanup_track_frame_count(track: dict[str, Any]) -> int:
    source = track.get("source") if isinstance(track.get("source"), dict) else {}
    return max(1, int(source.get("frameCount") or 1))


def _cleanup_track_current_masks(track: dict[str, Any]) -> list[dict[str, Any]]:
    tracking = track.get("tracking") if isinstance(track.get("tracking"), dict) else {}
    current_masks = tracking.get("currentMasks")
    if not isinstance(current_masks, list):
        return []
    return [item for item in current_masks if isinstance(item, dict)]


def _cleanup_track_mask_key(track: dict[str, Any], frame_index_local: int) -> str | None:
    for item in _cleanup_track_current_masks(track):
        if int(item.get("frameIndexLocal", -1)) == frame_index_local and isinstance(item.get("maskKey"), str):
            return str(item["maskKey"])
    return None


def _cleanup_window_bounds(track: dict[str, Any], frame_index_local: int, propagation_mode: str) -> tuple[int, int, str]:
    frame_count = _cleanup_track_frame_count(track)
    if propagation_mode == "forward":
        return frame_index_local, frame_count - 1, "forward"
    if propagation_mode == "backward":
        return 0, frame_index_local, "backward"
    if propagation_mode == "bidirectional":
        return 0, frame_count - 1, "bidirectional"
    ordered = sort_keyframes(track)
    previous = max((int(item.get("frameIndexLocal", -1)) for item in ordered if int(item.get("frameIndexLocal", -1)) < frame_index_local), default=None)
    next_idx = min((int(item.get("frameIndexLocal", frame_count)) for item in ordered if int(item.get("frameIndexLocal", frame_count)) > frame_index_local), default=None)
    start = 0 if previous is None else max(0, (previous + frame_index_local) // 2)
    end = frame_count - 1 if next_idx is None else min(frame_count - 1, (frame_index_local + next_idx) // 2)
    return start, end, "windowed"


def _load_cleanup_local_frame_sets(
    *,
    asset_store: AssetStore,
    paths: AssetPaths,
    track_id: str,
    frame_count: int,
    td_path: Path,
) -> tuple[list[Path], list[Path]]:
    source_paths: list[Path] = []
    generated_paths: list[Path] = []
    for frame_index_local in range(frame_count):
        source_key = paths.cleanup_track_working_frame(track_id, "source", frame_index_local)
        generated_key = paths.cleanup_track_working_frame(track_id, "generated", frame_index_local)
        source_path = td_path / "source_frames" / f"frame_{frame_index_local:04d}.png"
        generated_path = td_path / "generated_frames" / f"frame_{frame_index_local:04d}.png"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        generated_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_bytes(asset_store.read_bytes(source_key))
        generated_path.write_bytes(asset_store.read_bytes(generated_key))
        source_paths.append(source_path)
        generated_paths.append(generated_path)
    return source_paths, generated_paths


def _extract_cleanup_frame_sequence(
    video_path: Path,
    output_dir: Path,
    *,
    fps_num: int,
    fps_den: int,
    duration_sec: float,
    frame_limit: int | None = None,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"fps={max(1, int(fps_num))}/{max(1, int(fps_den))}",
        "-t",
        f"{max(0.1, float(duration_sec)):.6f}",
        "-start_number",
        "0",
    ]
    if frame_limit is not None:
        command.extend(["-frames:v", str(max(1, int(frame_limit)))])
    command.append(str(output_dir / "frame_%04d.png"))
    _run_command(command)
    return sorted(output_dir.glob("frame_*.png"))


def _load_cleanup_local_masks(
    *,
    asset_store: AssetStore,
    track: dict[str, Any],
    td_path: Path,
) -> list[Path]:
    frame_count = _cleanup_track_frame_count(track)
    mask_paths: list[Path] = []
    for frame_index_local in range(frame_count):
        mask_key = _cleanup_track_mask_key(track, frame_index_local)
        if not mask_key:
            raise RuntimeError(f"Cleanup mask missing for frame {frame_index_local}")
        mask_path = td_path / "mask_frames" / f"frame_{frame_index_local:04d}.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        mask_path.write_bytes(asset_store.read_bytes(mask_key))
        mask_paths.append(mask_path)
    return mask_paths


def _store_cleanup_review_assets(
    *,
    task: dict[str, Any],
    track: dict[str, Any],
    asset_store: AssetStore,
    source_paths: list[Path],
    generated_paths: list[Path],
    mask_paths: list[Path],
    diagnostics_rows: list[dict[str, Any]],
    suggested_frames: set[int],
    settings: VideoCleanupSettings,
) -> None:
    paths = _asset_paths(task)
    track_id = str(track["trackId"])
    fps_num = int(track.get("source", {}).get("fpsNum") or 30)
    fps_den = int(track.get("source", {}).get("fpsDen") or 1)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        diagnostics_by_frame = {int(item.get("frameIndexLocal", 0)): item for item in diagnostics_rows if isinstance(item, dict)}
        preview = build_preview_assets(
            source_frame_paths=source_paths,
            generated_frame_paths=generated_paths,
            mask_frame_paths=mask_paths,
            settings=settings,
            diagnostics_by_frame=diagnostics_by_frame,
            suggested_frames=suggested_frames,
            workdir=td_path,
            fps_num=fps_num,
            fps_den=fps_den,
        )
        manifest_frames: list[dict[str, Any]] = []
        frame_count = len(source_paths)
        for frame_index_local in range(frame_count):
            overlay_key = paths.cleanup_track_review_frame(track_id, "overlay", frame_index_local)
            checker_key = paths.cleanup_track_review_frame(track_id, "checker", frame_index_local)
            cleaned_key = paths.cleanup_track_review_frame(track_id, "cleaned", frame_index_local)
            asset_store.put_bytes(overlay_key, (preview["overlayDir"] / f"frame_{frame_index_local:04d}.png").read_bytes(), content_type="image/png")
            asset_store.put_bytes(checker_key, (preview["checkerDir"] / f"frame_{frame_index_local:04d}.png").read_bytes(), content_type="image/png")
            asset_store.put_bytes(cleaned_key, (preview["cleanedDir"] / f"frame_{frame_index_local:04d}.png").read_bytes(), content_type="image/png")
            manifest_frames.append(
                {
                    "frameIndexLocal": frame_index_local,
                    "maskKey": _cleanup_track_mask_key(track, frame_index_local),
                    "overlayKey": overlay_key,
                    "checkerKey": checker_key,
                    "cleanedKey": cleaned_key,
                    "generatedFrameKey": paths.cleanup_track_working_frame(track_id, "generated", frame_index_local),
                    "sourceFrameKey": paths.cleanup_track_working_frame(track_id, "source", frame_index_local),
                    "coveragePct": diagnostics_by_frame.get(frame_index_local, {}).get("coveragePct"),
                    "suspicionScore": diagnostics_by_frame.get(frame_index_local, {}).get("suspicionScore"),
                    "suggestedCorrection": frame_index_local in suggested_frames,
                }
            )
        cleaned_video_key = paths.cleanup_track_review_artifact(track_id, "preview_cleaned", ".mp4")
        generated_video_key = paths.cleanup_track_review_artifact(track_id, "preview_generated", ".mp4")
        overlay_video_key = paths.cleanup_track_review_artifact(track_id, "preview_overlay", ".mp4")
        checker_video_key = paths.cleanup_track_review_artifact(track_id, "preview_checker", ".mp4")
        manifest_key = paths.cleanup_track_review_artifact(track_id, "preview_manifest", ".json")
        asset_store.put_bytes(generated_video_key, preview["generatedVideoPath"].read_bytes(), content_type="video/mp4")
        asset_store.put_bytes(cleaned_video_key, preview["cleanedVideoPath"].read_bytes(), content_type="video/mp4")
        asset_store.put_bytes(overlay_video_key, preview["overlayVideoPath"].read_bytes(), content_type="video/mp4")
        asset_store.put_bytes(checker_video_key, preview["checkerVideoPath"].read_bytes(), content_type="video/mp4")
        asset_store.put_bytes(
            manifest_key,
            json.dumps({"frameCount": frame_count, "frames": manifest_frames}).encode("utf-8"),
            content_type="application/json",
        )
        review = track.setdefault("review", {})
        review.update(
            {
                "previewVideoKey": generated_video_key,
                "generatedPreviewKey": generated_video_key,
                "cleanedPreviewKey": cleaned_video_key,
                "overlayStripKey": overlay_video_key,
                "checkerVideoKey": checker_video_key,
                "previewManifestKey": manifest_key,
                "suggestedCorrectionFrames": sorted(suggested_frames),
            }
        )


def _handle_video_cleanup_init(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    track_id = str(payload["trackId"])
    segment_id = str(payload["segmentId"])
    generation_id = str(payload["generationId"])
    first_mask_source_key = str(payload["firstMaskSourceKey"])
    track = get_cleanup_track(task, track_id)
    if not isinstance(track, dict):
        raise RuntimeError("Cleanup track not found")
    generation = get_cleanup_generation(task, generation_id)
    segment = get_cleanup_segment(task, segment_id)
    if not isinstance(generation, dict) or not isinstance(segment, dict):
        raise RuntimeError("Cleanup track source generation or segment not found")
    if generation.get("status") != "complete" or not generation.get("outputKey"):
        raise RuntimeError("Cleanup track requires a completed generation")

    track["status"] = "preparing"
    track.pop("error", None)
    track["updatedAt"] = now_iso()
    _job_progress(job, store, 10, "running", "Preparing cleanup track inputs")
    paths = _asset_paths(task)
    s3 = boto3.client("s3")
    segment_clip_key = segment.get("segmentClipKey") or _ensure_segment_clip(
        s3=s3,
        asset_store=asset_store,
        asset_paths=paths,
        task=task,
        segment=segment,
        assets_bucket=settings.assets_bucket,
    )
    cleanup_source_key = paths.cleanup_track_working_segment(track_id, "source_segment")
    cleanup_generated_key = paths.cleanup_track_working_segment(track_id, "generated_segment")
    cleanup_first_mask_key = paths.cleanup_track_input(track_id, "first_mask", ".png")
    asset_store.copy_object(str(segment_clip_key), cleanup_source_key, content_type="video/mp4")
    asset_store.copy_object(str(generation["outputKey"]), cleanup_generated_key, content_type="video/mp4")
    mask_bytes = asset_store.read_bytes(first_mask_source_key)
    asset_store.put_bytes(cleanup_first_mask_key, mask_bytes, content_type="image/png")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_path = td_path / "source.mp4"
        generated_path = td_path / "generated.mp4"
        _download_s3(s3, settings.assets_bucket, cleanup_source_key, source_path)
        _download_s3(s3, settings.assets_bucket, cleanup_generated_key, generated_path)
        source_probe = ffprobe_video(str(source_path))
        generated_probe = ffprobe_video(str(generated_path))
    frame_count = max(1, min(int(source_probe.get("frame_count") or 1), int(generated_probe.get("frame_count") or 1)))
    generated_duration_sec = float(generated_probe.get("duration_sec") or 0.0)
    track["source"] = {
        **(track.get("source") if isinstance(track.get("source"), dict) else {}),
        "editSourceKey": cleanup_source_key,
        "generatedSegmentKey": cleanup_generated_key,
        "fpsNum": int(generated_probe.get("fps_num") or source_probe.get("fps_num") or 30),
        "fpsDen": int(generated_probe.get("fps_den") or source_probe.get("fps_den") or 1),
        "width": int(generated_probe.get("width") or source_probe.get("width") or 0),
        "height": int(generated_probe.get("height") or source_probe.get("height") or 0),
        "frameCount": frame_count,
        "durationSec": round(generated_duration_sec, 6) if generated_duration_sec > 0 else None,
    }
    track.setdefault("seed", {})["firstMaskKey"] = cleanup_first_mask_key
    add_or_replace_keyframe(track=track, frame_index_local=0, mask_key=cleanup_first_mask_key, source="seed_first")
    store.save_task(task)
    track_job_id = _enqueue_follow_on_job(
        store=store,
        user_id=job["userId"],
        task_id=job["taskId"],
        queue_url=settings.jobs_queue_url,
        job_type="video_cleanup_track",
        payload={"trackId": track_id},
    )
    track["status"] = "tracking"
    track.pop("error", None)
    track["updatedAt"] = now_iso()
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Cleanup track initialized")
    job["resultRefs"] = {"trackId": track_id, "trackJobId": track_job_id}
    store.save_job(job)
    return job


def _handle_video_cleanup_track(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    track_id = str(payload["trackId"])
    track = get_cleanup_track(task, track_id)
    if not isinstance(track, dict):
        raise RuntimeError("Cleanup track not found")
    track["status"] = "tracking"
    track.pop("error", None)
    track["updatedAt"] = now_iso()
    store.save_task(task)
    _job_progress(job, store, 10, "running", "Extracting cleanup segment frames")
    secrets = load_secret(settings.secrets_arn)
    fal_api_key = secrets.get("FAL_API_KEY")
    if not fal_api_key:
        raise RuntimeError("FAL_API_KEY is required for video cleanup tracking")
    paths = _asset_paths(task)
    s3 = boto3.client("s3")
    frame_count = _cleanup_track_frame_count(track)
    fps_num = int(track.get("source", {}).get("fpsNum") or 30)
    fps_den = int(track.get("source", {}).get("fpsDen") or 1)
    duration_sec = float(track.get("source", {}).get("durationSec") or ((frame_count * fps_den) / max(1, fps_num)))
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_segment_path = td_path / "source_segment.mp4"
        generated_segment_path = td_path / "generated_segment.mp4"
        _download_s3(s3, settings.assets_bucket, str(track.get("source", {}).get("editSourceKey")), source_segment_path)
        _download_s3(s3, settings.assets_bucket, str(track.get("source", {}).get("generatedSegmentKey")), generated_segment_path)
        source_paths = _extract_cleanup_frame_sequence(
            source_segment_path,
            td_path / "source_frames",
            fps_num=fps_num,
            fps_den=fps_den,
            duration_sec=duration_sec,
            frame_limit=frame_count,
        )
        generated_paths = _extract_cleanup_frame_sequence(
            generated_segment_path,
            td_path / "generated_frames",
            fps_num=fps_num,
            fps_den=fps_den,
            duration_sec=duration_sec,
            frame_limit=frame_count,
        )
        frame_count = max(1, min(frame_count, len(source_paths), len(generated_paths)))
        track.setdefault("source", {})["frameCount"] = frame_count
        source_paths = source_paths[:frame_count]
        generated_paths = generated_paths[:frame_count]
        for frame_index_local, (source_path, generated_path) in enumerate(zip(source_paths, generated_paths)):
            asset_store.put_bytes(paths.cleanup_track_working_frame(track_id, "source", frame_index_local), source_path.read_bytes(), content_type="image/png")
            asset_store.put_bytes(paths.cleanup_track_working_frame(track_id, "generated", frame_index_local), generated_path.read_bytes(), content_type="image/png")

        keyframes = sort_keyframes(track)
        seed_masks = {int(item["frameIndexLocal"]): asset_store.read_bytes(str(item["maskKey"])) for item in keyframes if isinstance(item.get("maskKey"), str)}
        run_id = new_id("run")
        _job_progress(job, store, 45, "running", "Propagating keep mask with SAM")
        masks_by_index, run_warnings = stitch_seeded_masks(
            generated_frame_paths=generated_paths,
            seed_masks=seed_masks,
            fal_api_key=fal_api_key,
            tracking_density=str(track.get("settings", {}).get("trackingDensity") or "standard"),
        )
        if not masks_by_index:
            raise RuntimeError("Cleanup tracking produced no masks")
        diagnostics_rows: list[dict[str, Any]] = []
        previous_row: dict[str, Any] | None = None
        current_masks: list[dict[str, Any]] = []
        for frame_index_local in range(frame_count):
            mask_bytes = masks_by_index.get(frame_index_local)
            if mask_bytes is None:
                nearest_index = max((idx for idx in masks_by_index.keys() if idx <= frame_index_local), default=min(masks_by_index.keys()))
                mask_bytes = masks_by_index[nearest_index]
            mask_key = paths.cleanup_track_tracking_mask(track_id, run_id, frame_index_local)
            asset_store.put_bytes(mask_key, mask_bytes, content_type="image/png")
            current_masks.append({"frameIndexLocal": frame_index_local, "maskKey": mask_key})
            row = compute_frame_diagnostic(
                frame_index_local=frame_index_local,
                mask_bytes=mask_bytes,
                source_bytes=source_paths[frame_index_local].read_bytes(),
                generated_bytes=generated_paths[frame_index_local].read_bytes(),
                previous=previous_row,
            )
            diagnostics_rows.append(row)
            previous_row = row

        summary = summarize_diagnostics(diagnostics_rows, float(track.get("settings", {}).get("suspiciousFrameThreshold", 0.12)))
        mean_area = sum(float(item.get("coveragePct", 0.0)) for item in diagnostics_rows) / max(1, len(diagnostics_rows))
        mean_boundary_motion = sum(float(item.get("centroidJumpPx", 0.0)) for item in diagnostics_rows) / max(1, len(diagnostics_rows))
        area_variance = sum((float(item.get("coveragePct", 0.0)) - mean_area) ** 2 for item in diagnostics_rows) / max(1, len(diagnostics_rows))
        track.setdefault("tracking", {})["currentMasks"] = current_masks
        track["tracking"]["frameDiagnostics"] = diagnostics_rows
        track["tracking"]["coverageSummary"] = summary["coverageSummary"]
        track["tracking"].setdefault("propagationRuns", []).append(
            {
                "runId": run_id,
                "startFrameLocal": 0,
                "endFrameLocal": frame_count - 1,
                "seedKeyframeIds": [str(item.get("id")) for item in keyframes if item.get("id")],
                "direction": "bidirectional" if len(seed_masks) > 1 else "forward",
                "outputMasksPrefix": paths.cleanup_track_tracking_run_prefix(track_id, run_id),
                "status": "complete",
                "warnings": run_warnings,
                "metrics": {
                    "frameCount": frame_count,
                    "meanAreaPct": round(mean_area, 4),
                    "areaVariance": round(area_variance, 6),
                    "meanBoundaryMotionPx": round(mean_boundary_motion, 6),
                    "suspiciousFrames": summary["coverageSummary"]["suspiciousFrames"],
                },
            }
        )
        _job_progress(job, store, 82, "running", "Building cleanup review preview")
        mask_paths: list[Path] = []
        for frame_index_local in range(frame_count):
            mask_path = td_path / "masks" / f"frame_{frame_index_local:04d}.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            mask_path.write_bytes(asset_store.read_bytes(current_masks[frame_index_local]["maskKey"]))
            mask_paths.append(mask_path)
        cleanup_settings = VideoCleanupSettings.from_payload(track.get("settings") if isinstance(track.get("settings"), dict) else {})
        _store_cleanup_review_assets(
            task=task,
            track=track,
            asset_store=asset_store,
            source_paths=source_paths,
            generated_paths=generated_paths,
            mask_paths=mask_paths,
            diagnostics_rows=diagnostics_rows,
            suggested_frames=set(summary["suggestedCorrectionFrames"]),
            settings=cleanup_settings,
        )

    track["status"] = "review_ready"
    track.pop("error", None)
    track["updatedAt"] = now_iso()
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Cleanup track ready for review")
    job["resultRefs"] = {"trackId": track_id}
    store.save_job(job)
    return job


def _handle_video_cleanup_retrack_window(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    track_id = str(payload["trackId"])
    track = get_cleanup_track(task, track_id)
    if not isinstance(track, dict):
        raise RuntimeError("Cleanup track not found")
    frame_index_local = int(payload["frameIndexLocal"])
    propagation_mode = str(payload.get("propagationMode") or "windowed")
    paths = _asset_paths(task)
    secrets = load_secret(settings.secrets_arn)
    fal_api_key = secrets.get("FAL_API_KEY")
    if not fal_api_key:
        raise RuntimeError("FAL_API_KEY is required for video cleanup re-tracking")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        frame_count = _cleanup_track_frame_count(track)
        source_paths, generated_paths = _load_cleanup_local_frame_sets(
            asset_store=asset_store,
            paths=paths,
            track_id=track_id,
            frame_count=frame_count,
            td_path=td_path,
        )
        current_mask_paths = _load_cleanup_local_masks(asset_store=asset_store, track=track, td_path=td_path)
        if payload.get("uploadKey"):
            uploaded_mask_bytes = asset_store.read_bytes(str(payload["uploadKey"]))
        else:
            existing_mask_key = str(payload.get("existingMaskKey") or _cleanup_track_mask_key(track, frame_index_local) or "")
            existing_mask_bytes = asset_store.read_bytes(existing_mask_key) if existing_mask_key else current_mask_paths[frame_index_local].read_bytes()
            sam_result, sam_warnings = propagate_mask_to_frame(
                fal_api_key=fal_api_key,
                target_image_bytes=generated_paths[frame_index_local].read_bytes(),
                reference_mask_bytes=existing_mask_bytes,
                edge_bias=str(payload.get("edgeBias") or "balanced"),
                restrict_to_mask_bounds=bool(payload.get("restrictToMaskBounds", True)),
                positive_points=list(payload.get("positivePoints") or []),
                negative_points=list(payload.get("negativePoints") or []),
                box=payload.get("box"),
            )
            uploaded_mask_bytes = sam_result
            payload.setdefault("warnings", []).extend(sam_warnings)
        keyframe_mask_key = paths.cleanup_track_keyframe_mask(track_id, frame_index_local)
        asset_store.put_bytes(keyframe_mask_key, uploaded_mask_bytes, content_type="image/png")
        keyframe = add_or_replace_keyframe(
            track=track,
            frame_index_local=frame_index_local,
            mask_key=keyframe_mask_key,
            source="user_edit",
            keyframe_id=str(payload.get("keyframeId")) if payload.get("keyframeId") else None,
        )
        start_idx, end_idx, direction = _cleanup_window_bounds(track, frame_index_local, propagation_mode)
        _job_progress(job, store, 35, "running", "Re-tracking cleanup mask window")
        masks_by_index, run_warnings = propagate_window(
            fal_api_key=fal_api_key,
            generated_frame_paths=generated_paths,
            seed_frame_index=frame_index_local,
            seed_mask_bytes=uploaded_mask_bytes,
            start_frame_index=start_idx,
            end_frame_index=end_idx,
            direction=direction,
            edge_bias=str(payload.get("edgeBias") or "balanced"),
            tracking_density=str(track.get("settings", {}).get("trackingDensity") or "standard"),
        )
        current_masks = {int(item["frameIndexLocal"]): str(item["maskKey"]) for item in _cleanup_track_current_masks(track)}
        run_id = new_id("run")
        for idx, mask_bytes in masks_by_index.items():
            mask_key = paths.cleanup_track_tracking_mask(track_id, run_id, idx)
            asset_store.put_bytes(mask_key, mask_bytes, content_type="image/png")
            current_masks[idx] = mask_key
        track.setdefault("tracking", {})["currentMasks"] = [
            {"frameIndexLocal": idx, "maskKey": current_masks[idx]}
            for idx in sorted(current_masks.keys())
        ]
        diagnostics_rows: list[dict[str, Any]] = []
        previous_row: dict[str, Any] | None = None
        mask_paths: list[Path] = []
        for idx in range(frame_count):
            mask_path = td_path / "updated_masks" / f"frame_{idx:04d}.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            mask_path.write_bytes(asset_store.read_bytes(current_masks[idx]))
            mask_paths.append(mask_path)
            row = compute_frame_diagnostic(
                frame_index_local=idx,
                mask_bytes=mask_path.read_bytes(),
                source_bytes=source_paths[idx].read_bytes(),
                generated_bytes=generated_paths[idx].read_bytes(),
                previous=previous_row,
            )
            diagnostics_rows.append(row)
            previous_row = row
        threshold = float(track.get("settings", {}).get("suspiciousFrameThreshold", 0.12))
        summary = summarize_diagnostics(diagnostics_rows, threshold)
        track["tracking"]["frameDiagnostics"] = diagnostics_rows
        track["tracking"]["coverageSummary"] = summary["coverageSummary"]
        track["tracking"].setdefault("propagationRuns", []).append(
            {
                "runId": run_id,
                "startFrameLocal": start_idx,
                "endFrameLocal": end_idx,
                "seedKeyframeIds": [str(keyframe.get("id"))],
                "direction": direction,
                "outputMasksPrefix": paths.cleanup_track_tracking_run_prefix(track_id, run_id),
                "status": "complete",
                "warnings": run_warnings + list(payload.get("warnings") or []),
                "metrics": {
                    "frameCount": max(1, end_idx - start_idx + 1),
                    "meanAreaPct": round(sum(float(item.get("coveragePct", 0.0)) for item in diagnostics_rows[start_idx : end_idx + 1]) / max(1, end_idx - start_idx + 1), 4),
                    "areaVariance": 0.0,
                    "meanBoundaryMotionPx": round(sum(float(item.get("centroidJumpPx", 0.0)) for item in diagnostics_rows[start_idx : end_idx + 1]) / max(1, end_idx - start_idx + 1), 4),
                    "suspiciousFrames": summary["coverageSummary"]["suspiciousFrames"],
                },
            }
        )
        cleanup_settings = VideoCleanupSettings.from_payload(track.get("settings") if isinstance(track.get("settings"), dict) else {})
        _job_progress(job, store, 78, "running", "Refreshing cleanup preview")
        _store_cleanup_review_assets(
            task=task,
            track=track,
            asset_store=asset_store,
            source_paths=source_paths,
            generated_paths=generated_paths,
            mask_paths=mask_paths,
            diagnostics_rows=diagnostics_rows,
            suggested_frames=set(summary["suggestedCorrectionFrames"]),
            settings=cleanup_settings,
        )
    track["status"] = "review_ready"
    track.pop("error", None)
    track["updatedAt"] = now_iso()
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Cleanup window re-tracked")
    job["resultRefs"] = {"trackId": track_id, "frameIndexLocal": frame_index_local}
    store.save_job(job)
    return job


def _handle_video_cleanup_preview(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    track_id = str(payload["trackId"])
    track = get_cleanup_track(task, track_id)
    if not isinstance(track, dict):
        raise RuntimeError("Cleanup track not found")
    updated_settings = VideoCleanupSettings.from_payload(payload.get("settings") or track.get("settings"))
    track["settings"] = updated_settings.to_dict()
    frame_count = _cleanup_track_frame_count(track)
    paths = _asset_paths(task)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_paths, generated_paths = _load_cleanup_local_frame_sets(
            asset_store=asset_store,
            paths=paths,
            track_id=track_id,
            frame_count=frame_count,
            td_path=td_path,
        )
        mask_paths = _load_cleanup_local_masks(asset_store=asset_store, track=track, td_path=td_path)
        diagnostics_rows = [item for item in (track.get("tracking", {}).get("frameDiagnostics") or []) if isinstance(item, dict)]
        suggested_frames = set(int(item) for item in (track.get("review", {}).get("suggestedCorrectionFrames") or []) if isinstance(item, int))
        _job_progress(job, store, 45, "running", "Rebuilding cleanup preview")
        _store_cleanup_review_assets(
            task=task,
            track=track,
            asset_store=asset_store,
            source_paths=source_paths,
            generated_paths=generated_paths,
            mask_paths=mask_paths,
            diagnostics_rows=diagnostics_rows,
            suggested_frames=suggested_frames,
            settings=updated_settings,
        )
    track["updatedAt"] = now_iso()
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Cleanup preview updated")
    job["resultRefs"] = {"trackId": track_id}
    store.save_job(job)
    return job


def _handle_video_cleanup_apply(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    track_id = str(payload["trackId"])
    track = get_cleanup_track(task, track_id)
    if not isinstance(track, dict):
        raise RuntimeError("Cleanup track not found")
    cleanup_settings = VideoCleanupSettings.from_payload(payload.get("settings") or track.get("settings"))
    track["status"] = "applying"
    track.pop("error", None)
    track["settings"] = cleanup_settings.to_dict()
    store.save_task(task)
    _job_progress(job, store, 15, "running", "Rendering cleaned cleanup output")
    frame_count = _cleanup_track_frame_count(track)
    paths = _asset_paths(task)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_paths, generated_paths = _load_cleanup_local_frame_sets(
            asset_store=asset_store,
            paths=paths,
            track_id=track_id,
            frame_count=frame_count,
            td_path=td_path,
        )
        mask_paths = _load_cleanup_local_masks(asset_store=asset_store, track=track, td_path=td_path)
        output_video_path = td_path / "output_segment.mp4"
        preview_video_path = td_path / "preview_output.mp4"
        metrics = render_cleaned_video(
            source_frame_paths=source_paths,
            generated_frame_paths=generated_paths,
            mask_frame_paths=mask_paths,
            settings=cleanup_settings,
            output_frames_dir=td_path / "output_frames",
            fps_num=int(track.get("source", {}).get("fpsNum") or 30),
            fps_den=int(track.get("source", {}).get("fpsDen") or 1),
            output_video_path=output_video_path,
            burn_in_mask=False,
        )
        render_cleaned_video(
            source_frame_paths=source_paths,
            generated_frame_paths=generated_paths,
            mask_frame_paths=mask_paths,
            settings=cleanup_settings,
            output_frames_dir=td_path / "preview_frames",
            fps_num=int(track.get("source", {}).get("fpsNum") or 30),
            fps_den=int(track.get("source", {}).get("fpsDen") or 1),
            output_video_path=preview_video_path,
            burn_in_mask=cleanup_settings.preview_burn_in_mask,
        )
        output_key = paths.cleanup_track_apply_artifact(track_id, "output_segment", ".mp4")
        preview_key = paths.cleanup_track_apply_artifact(track_id, "preview_output", ".mp4")
        report_key = paths.cleanup_track_apply_artifact(track_id, "report", ".json")
        asset_store.put_bytes(output_key, output_video_path.read_bytes(), content_type="video/mp4")
        asset_store.put_bytes(preview_key, preview_video_path.read_bytes(), content_type="video/mp4")
        diagnostics_rows = [item for item in (track.get("tracking", {}).get("frameDiagnostics") or []) if isinstance(item, dict)]
        report_payload = {
            "trackId": track_id,
            "generationId": track.get("generationId"),
            "settings": cleanup_settings.to_dict(),
            "tracking": {
                "keyframeCount": len(sort_keyframes(track)),
                "propagationRunCount": len(track.get("tracking", {}).get("propagationRuns") or []),
                "suspiciousFrames": list(track.get("review", {}).get("suggestedCorrectionFrames") or []),
            },
            "apply": {
                **metrics,
                "suspiciousFrameCount": len([item for item in diagnostics_rows if float(item.get("suspicionScore", 0.0)) >= cleanup_settings.suspicious_frame_threshold]),
            },
        }
        asset_store.put_bytes(report_key, json.dumps(report_payload).encode("utf-8"), content_type="application/json")
    apply_state = track.setdefault("apply", {})
    apply_state.update(
        {
            "outputSegmentKey": output_key,
            "previewOutputKey": preview_key,
            "reportJsonKey": report_key,
            "metrics": {
                **metrics,
                "suspiciousFrameCount": len([item for item in (track.get("review", {}).get("suggestedCorrectionFrames") or []) if isinstance(item, int)]),
            },
        }
    )
    if bool(payload.get("createSegmentGenerationVariant", True)):
        source_generation = get_cleanup_generation(task, str(track.get("generationId") or ""))
        if isinstance(source_generation, dict):
            create_cleanup_generation_variant(task=task, source_generation=source_generation, track=track, output_key=output_key)
    track["status"] = "complete"
    track.pop("error", None)
    track["updatedAt"] = now_iso()
    track.setdefault("review", {})["approved"] = True
    track["review"]["approvedAt"] = now_iso()
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Cleanup output rendered")
    job["resultRefs"] = {"trackId": track_id, "outputSegmentKey": output_key}
    store.save_job(job)
    return job


def _handle_generation_reconcile_timing(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    payload = job["payload"]
    source_gen_id = str(payload.get("sourceGenId") or "")
    gen_id = str(payload.get("genId") or "")
    trim_start_frames = max(0, int(payload.get("trimStartFrames") or 0))
    trim_end_frames = max(0, int(payload.get("trimEndFrames") or 0))
    playback_rate_raw = payload.get("playbackRate")
    playback_rate = None if playback_rate_raw in (None, "", 1, 1.0) else max(0.05, min(20.0, float(playback_rate_raw)))

    source_generation = task.setdefault("segmentGenerations", {}).get(source_gen_id)
    queued_generation = task.setdefault("segmentGenerations", {}).get(gen_id)
    if not isinstance(source_generation, dict):
        raise RuntimeError("Source generation not found")
    if not isinstance(queued_generation, dict):
        raise RuntimeError("Queued reconciled generation not found")
    if source_generation.get("status") != "complete" or not source_generation.get("outputKey"):
        raise RuntimeError("Source generation must be complete before timing can be reconciled")

    segment_id = str(source_generation.get("segmentId") or "")
    segment = next((item for item in task.get("segments", []) if isinstance(item, dict) and item.get("segmentId") == segment_id), None)
    if not isinstance(segment, dict):
        raise RuntimeError("Source segment not found")

    queued_generation.update(
        {
            "status": "running",
            "jobId": job.get("jobId"),
            "error": None,
            "startedAt": now_iso(),
            "updatedAt": now_iso(),
        }
    )
    source_generation["timingReconcile"] = {
        "status": "running",
        "jobId": job.get("jobId"),
        "resultGenId": gen_id,
        "updatedAt": now_iso(),
        "adjustments": {
            "trimStartFrames": trim_start_frames,
            "trimEndFrames": trim_end_frames,
            "playbackRate": playback_rate,
        },
    }
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 15, "running", "Preparing timing reconcile output")

    paths = _asset_paths(task)
    output_key = paths.segment_generated(segment_id, gen_id)
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        s3 = boto3.client("s3")
        input_path = td_path / "source_generation.mp4"
        output_path = td_path / "reconciled_generation.mp4"
        _download_s3(s3, settings.assets_bucket, str(source_generation["outputKey"]), input_path)
        input_probe = ffprobe_video(str(input_path))
        fps_num = int(
            (source_generation.get("generationSettings") or {}).get("storedOutput", {}).get("fps", {}).get("num")
            or task.get("video", {}).get("editSource", {}).get("fps", {}).get("num")
            or input_probe.get("fps_num")
            or 30
        )
        fps_den = int(
            (source_generation.get("generationSettings") or {}).get("storedOutput", {}).get("fps", {}).get("den")
            or task.get("video", {}).get("editSource", {}).get("fps", {}).get("den")
            or input_probe.get("fps_den")
            or 1
        )
        target_width = int(
            (source_generation.get("generationSettings") or {}).get("storedOutput", {}).get("width")
            or input_probe.get("width")
            or 0
        )
        target_height = int(
            (source_generation.get("generationSettings") or {}).get("storedOutput", {}).get("height")
            or input_probe.get("height")
            or 0
        )

        trim_and_retime_video_uniform(
            str(input_path),
            str(output_path),
            fps=Fraction(max(1, fps_num), max(1, fps_den)),
            playback_rate=playback_rate or 1.0,
            trim_start_frames=trim_start_frames,
            trim_end_frames=trim_end_frames,
            target_width=target_width if target_width > 0 else None,
            target_height=target_height if target_height > 0 else None,
            crf=16,
            preset="slow",
            audio_bitrate="192k",
        )
        output_probe = ffprobe_video(str(output_path))
        _upload_s3(s3, settings.assets_bucket, output_key, output_path, "video/mp4")

    finished_at = now_iso()
    processing_duration_sec = _processing_duration_seconds(queued_generation.get("startedAt"), finished_at)
    generation_settings = {
        **(source_generation.get("generationSettings") if isinstance(source_generation.get("generationSettings"), dict) else {}),
        "workflow": "timing_reconcile",
        "derivedFromGenerationId": source_gen_id,
        "reconcileTiming": {
            "sourceGenerationId": source_gen_id,
            "trimStartFrames": trim_start_frames,
            "trimEndFrames": trim_end_frames,
            "playbackRate": playback_rate,
        },
        "storedOutput": {
            "width": int(output_probe.get("width") or 0),
            "height": int(output_probe.get("height") or 0),
            "fps": {
                "num": int(output_probe.get("fps_num") or 0),
                "den": int(output_probe.get("fps_den") or 1),
            },
            "durationSec": float(output_probe.get("duration_sec") or 0.0),
            "frameCount": int(output_probe.get("frame_count") or 0),
            "isVfr": bool(output_probe.get("is_vfr_input")),
        },
        "timelineAlignment": None,
        "timelineConform": {
            "policy": "timing_reconcile_variant",
            "applied": True,
            "durationDeltaSec": round(float(output_probe.get("duration_sec") or 0.0) - float(input_probe.get("duration_sec") or 0.0), 6),
            "frameDelta": int(output_probe.get("frame_count") or 0) - int(input_probe.get("frame_count") or 0),
            "fpsConformed": True,
            "resolutionConformed": True,
        },
    }
    queued_generation.update(
        {
            "status": "complete",
            "outputKey": output_key,
            "error": None,
            "updatedAt": finished_at,
            "finishedAt": finished_at,
            "processingDurationSec": processing_duration_sec,
            "sourceFrameOffset": None,
            "alignment": None,
            "mergeAlignmentSuggestion": None,
            "derivedFromGenerationId": source_gen_id,
            "cleanupTrackId": None,
            "generationSettings": generation_settings,
        }
    )
    source_generation["timingReconcile"] = {
        "status": "complete",
        "jobId": job.get("jobId"),
        "resultGenId": gen_id,
        "updatedAt": finished_at,
        "adjustments": {
            "trimStartFrames": trim_start_frames,
            "trimEndFrames": trim_end_frames,
            "playbackRate": playback_rate,
        },
    }
    segment["selectedGenerationId"] = gen_id
    _append_task_history_event(
        task,
        {
            "at": finished_at,
            "event": "segment_generation.timing_reconciled",
            "jobId": job.get("jobId"),
            "genId": gen_id,
            "sourceGenId": source_gen_id,
        },
    )
    store.save_task(task, merge_on_conflict=True)
    _job_progress(job, store, 100, "complete", "Timing reconcile output ready")
    job["resultRefs"] = {
        "genId": gen_id,
        "sourceGenId": source_gen_id,
        "outputKey": output_key,
        "finishedAt": finished_at,
        "processingDurationSec": processing_duration_sec,
    }
    store.save_job(job)
    return job


def process_job_record(record: dict[str, Any], *, settings: Any) -> None:
    body = json.loads(record["body"])
    user_id = body["userId"]
    task_id = body.get("taskId")
    job_id = body["jobId"]

    store = _WorkerStoreProxy(S3JsonStore(settings.metadata_bucket))
    asset_store = AssetStore(settings.assets_bucket, settings.aws_region)

    job = store.load_job(user_id, job_id)
    if not job:
        raise RuntimeError(f"Job not found: {job_id}")
    job_type = str(job.get("type") or "")
    status = str(job.get("status") or "").lower()
    if status == "complete":
        return
    if job.get("cancelRequestedAt"):
        if status != "failed":
            job["status"] = "failed"
            job["error"] = _cancel_message_for_job(job)
            job["finishedAt"] = now_iso()
            store.save_job(job)
        return
    task = None if job_type.startswith("api_") else store.load_task(user_id, str(task_id or ""))
    if not job_type.startswith("api_") and not task:
        raise RuntimeError(f"Task not found: {task_id}")

    job["status"] = "running"
    job["progress"] = 0
    job.pop("error", None)
    job.pop("resultRefs", None)
    job.setdefault("startedAt", now_iso())
    store.save_job(job)

    try:
        _raise_if_cancel_requested(job, store)
        handlers = build_job_handlers(
            handle_ingest_fn=_handle_ingest,
            handle_full_edit_fn=_handle_full_edit,
            handle_patch_edit_fn=_handle_patch_edit,
            handle_api_image_edit_full_fn=_handle_api_image_edit_full,
            handle_api_image_edit_patch_fn=_handle_api_image_edit_patch,
            handle_api_video_generate_reference_fn=_handle_api_video_generate_reference,
            handle_edit_video_reference_generate_fn=_handle_edit_video_reference_generate,
            handle_previz_generate_fn=_handle_previz_generate,
            handle_pdf_ingest_fn=_handle_pdf_ingest,
            handle_quality_match_apply_fn=_handle_quality_match_apply,
            handle_quality_match_sam_fn=_handle_quality_match_sam,
            handle_segment_generate_fn=_handle_segment_generate,
            handle_chunked_generation_finalize_fn=_handle_chunked_generation_finalize,
            handle_merge_alignment_suggestion_fn=_handle_merge_alignment_suggestion,
            handle_generation_reconcile_timing_fn=_handle_generation_reconcile_timing,
            handle_merge_fn=_handle_merge,
            handle_export_topaz_upscale_fn=_handle_export_topaz_upscale,
            handle_qc_report_build_fn=_handle_qc_report_build,
            handle_motion_sync_qc_fn=_handle_motion_sync_qc,
            handle_task_purge_fn=_handle_task_purge,
            handle_video_cleanup_init_fn=_handle_video_cleanup_init,
            handle_video_cleanup_track_fn=_handle_video_cleanup_track,
            handle_video_cleanup_retrack_window_fn=_handle_video_cleanup_retrack_window,
            handle_video_cleanup_preview_fn=_handle_video_cleanup_preview,
            handle_video_cleanup_apply_fn=_handle_video_cleanup_apply,
        )
        dispatch_job(
            job_type=job_type,
            handlers=handlers,
            handler_kwargs={
                "job": job,
                "store": store,
                "asset_store": asset_store,
                "task": task,
                "settings": settings,
            },
        )
    except JobCancelledError as exc:
        logger.info(
            "Job cancelled",
            extra={"jobId": job_id, "taskId": task_id, "userId": user_id, "jobType": job_type},
        )
        job["status"] = "failed"
        job["error"] = str(exc)
        job["finishedAt"] = now_iso()
        store.save_job(job)
        handle_job_failure(
            job_type=job_type,
            job_id=job_id,
            task_id=str(task_id) if task_id is not None else None,
            user_id=user_id,
            job=job,
            store=store,
            task=task if isinstance(task, dict) else None,
            error=exc,
            now_iso_fn=now_iso,
            get_cleanup_track_fn=get_cleanup_track,
            find_chunked_generation_run_fn=_find_chunked_generation_run,
            mark_chunked_generation_run_failed_fn=_mark_chunked_generation_run_failed,
        )
        return
    except Exception as exc:
        logger.exception("Job failed", extra={"jobId": job_id, "taskId": task_id, "userId": user_id})
        job["status"] = "failed"
        job["error"] = str(exc)
        job["finishedAt"] = now_iso()
        store.save_job(job)
        handled = handle_job_failure(
            job_type=job_type,
            job_id=job_id,
            task_id=str(task_id) if task_id is not None else None,
            user_id=user_id,
            job=job,
            store=store,
            task=task if isinstance(task, dict) else None,
            error=exc,
            now_iso_fn=now_iso,
            get_cleanup_track_fn=get_cleanup_track,
            find_chunked_generation_run_fn=_find_chunked_generation_run,
            mark_chunked_generation_run_failed_fn=_mark_chunked_generation_run_failed,
        )
        if handled:
            return
        latest_task = store.load_task(user_id, str(task_id or "")) or task
        if not isinstance(latest_task, dict):
            raise
        latest_task["status"] = "error"
        latest_task.setdefault("history", []).append({"at": now_iso(), "event": "job.failed", "jobId": job_id})
        store.save_task(latest_task, merge_on_conflict=True)
        raise
    else:
        job["finishedAt"] = now_iso()
        store.save_job(job)
        if isinstance(task, dict) and task.get("status") == "error":
            task["status"] = "ready" if task.get("video", {}).get("editSource", {}).get("s3Key") else "created"
            task.setdefault("history", []).append({"at": now_iso(), "event": "task.recovered", "jobId": job_id})
            store.save_task(task, merge_on_conflict=True)
