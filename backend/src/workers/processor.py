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

from src.core.assets import ApiAssetPaths, AssetPaths, AssetStore
from src.core.ffmpeg import (
    FFMPEG_BIN,
    compose_cropped_generated_segment,
    extract_frame_png,
    extract_segment_by_frames,
    ffprobe_video,
    generate_thumbnail_strip,
    merge_with_segment_replacement,
    transcode_for_preview,
    transcode_for_provider,
    transcode_to_cfr,
)
from src.core.ids import new_id, prompt_hash
from src.core.logger import Logger
from src.core.secrets import load_secret
from src.core.store import S3JsonStore, now_iso
from src.integrations.gemini import generate_image_edit as generate_gemini_image_edit
from src.integrations.fal import (
    get_queue_result as get_fal_queue_result,
    get_queue_status as get_fal_queue_status,
    submit_seedance_reference_to_video,
)
from src.jobs.queue import JobQueue
from src.integrations.kling import (
    create_start_end_generation as create_kling_start_end_generation,
    get_generation_response as get_kling_generation_response,
)
from src.integrations.luma import create_modify_generation, get_generation
from src.integrations.openai_images import generate_image_edit as generate_openai_image_edit
from src.integrations.replicate import (
    REPLICATE_KLING_O1_VERSION,
    REPLICATE_KLING_V3_OMNI_VIDEO_VERSION,
    create_official_model_prediction as create_replicate_official_model_prediction,
    create_prediction as create_replicate_prediction,
    get_prediction as get_replicate_prediction,
)
from src.integrations.runware import patch_edit_aceplusplus, patch_edit_flux_fill
from src.integrations.runway import (
    create_image_to_video,
    get_task as get_runway_task,
)
from src.integrations.runware_video import (
    RUNWARE_VEO_31_FAST_MODEL,
    RUNWARE_VEO_31_MODEL,
    RUNWARE_WAN22_A14B_MODEL,
    RUNWARE_WAN22_ANIMATE_MODEL,
    create_veo_first_last_generation,
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

FULL_VIDEO_MAX_BYTES = 100 * 1024 * 1024
REPLICATE_VIDEO_MAX_BYTES = 200 * 1024 * 1024
MAX_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024
WAN27_DATA_URL_MAX_BYTES = 6_800_000
SEEDANCE_REFERENCE_VIDEO_MAX_BYTES = 49_000_000
KLING_SUPPORTED_DURATIONS = (5, 10)
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
FRAME_REPORT_ADVANCED_TESTS = {
    "frame_composite",
    "frame_perceptual",
    "frame_boundary",
    "frame_sharpness",
    "frame_naturalness",
    "frame_texture",
}
LUMA_ALLOWED_MODES = {
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


def _fit_image_to_canvas(image: Image.Image, target_w: int, target_h: int) -> Image.Image:
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
) -> tuple[bytes, str, str]:
    image = ImageOps.exif_transpose(Image.open(BytesIO(frame_bytes))).convert("RGB")
    canvas = _fit_image_to_canvas(image, target_width, target_height)
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
        canvas = _fit_image_to_canvas(image, width, height)
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
    target_width: int,
    target_height: int,
    max_bytes: int = WAN27_DATA_URL_MAX_BYTES,
) -> tuple[str, int]:
    last_size = 0
    for audio_bitrate in ("128k", "96k", "64k"):
        for crf in (24, 28, 32, 36, 40):
            transcode_to_cfr(
                input_path,
                output_path,
                fps,
                target_width=target_width,
                target_height=target_height,
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
    target_width: int,
    target_height: int,
    max_bytes: int,
) -> tuple[int, int, int]:
    last_size = 0
    for crf in (18, 22, 26, 30, 34):
        transcode_to_cfr(
            input_path,
            output_path,
            fps,
            target_width=target_width,
            target_height=target_height,
            crf=crf,
            preset="medium",
            audio_bitrate="192k",
        )
        output_size = Path(output_path).stat().st_size
        last_size = output_size
        if output_size <= max_bytes:
            return target_width, target_height, output_size
    raise RuntimeError(f"Unable to compress provider input under {max_bytes} bytes (last size={last_size} bytes)")


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
    segment_key = asset_paths.segment_original(segment["segmentId"])

    with tempfile.TemporaryDirectory() as td:
        edit_source_key = task["video"]["editSource"]["s3Key"]
        input_path = Path(td) / "edit.mp4"
        output_path = Path(td) / "segment.mp4"
        _download_s3(s3, assets_bucket, edit_source_key, input_path)
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
    return segment_key


def _job_progress(job: dict[str, Any], store: S3JsonStore, progress: int, status: str, logs: str | None = None) -> None:
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
        anchor_frame_index = max(0, frame_count - 1 - int(anchor_frames_from_end))
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
            "prompt": run.get("prompt"),
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
            "prompt": run.get("prompt"),
            "lumaGenerationId": None,
        },
        "status": "queued",
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
        store.save_task(task, merge_on_conflict=True)
        return

    next_chunk = chunks[current_index + 1]
    generation = task.get("segmentGenerations", {}).get(gen_id)
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

    original_key = task["video"]["original"]["s3Key"]
    _job_progress(job, store, 5, "running", "Downloading source video")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        original_path = td_path / "original.mp4"
        edit_path = td_path / "edit.mp4"
        preview_path = td_path / "preview.mp4"

        _download_s3(s3, settings.assets_bucket, original_key, original_path)
        with open(original_path, "rb") as src_file:
            sha = hashlib.sha256()
            for chunk in iter(lambda: src_file.read(8 * 1024 * 1024), b""):
                sha.update(chunk)
            task["video"]["original"]["sha256"] = sha.hexdigest()

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
    }
    task["video"]["previewSource"] = {
        "s3Key": preview_key,
        "width": preview_w,
        "height": preview_h,
        "durationSec": edit_probe["duration_sec"],
        "frameCount": edit_probe["frame_count"],
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
    for value in candidates:
        if isinstance(value, str) and value.startswith("http"):
            return value
    raise RuntimeError("Luma completion payload missing output URL")


def _wait_luma_complete(api_key: str, generation_id: str, *, timeout_sec: int = 900) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_generation(api_key=api_key, generation_id=generation_id)
        state = payload.get("state") or payload.get("status")
        if state in {"completed", "complete", "succeeded", "success"}:
            return payload
        if state in {"failed", "error", "cancelled"}:
            raise RuntimeError(f"Luma generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Luma generation poll timeout")
        time.sleep(6)


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


def _wait_runware_video_complete(api_key: str, *, task_uuid: str, timeout_sec: int = 1800) -> dict[str, Any]:
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
    raise RuntimeError(f"fal.ai Seedance output missing video URL: {payload}")


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
            raise RuntimeError(f"fal.ai Seedance request failed: {payload}")
        if payload.get("error"):
            raise RuntimeError(f"fal.ai Seedance request failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError(f"fal.ai Seedance poll timeout for request {request_id or 'unknown'}")
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
            "provider": "gemini",
            "workflow": "full",
            "prompt": payload["prompt"],
            "sourceKey": source_key,
            "sourceVariantId": payload.get("sourceVariantId"),
            "inputResolution": {"width": src_image.width, "height": src_image.height},
            "outputResolution": {"width": normalized_image.width, "height": normalized_image.height},
        },
    }
    variant["generationSettings"]["provider"] = provider_name
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
        )
    else:
        gemini_key = secrets["GEMINI_API_KEY"]
        _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling Gemini image edit")
        out_bytes = generate_gemini_image_edit(
            api_key=gemini_key,
            model=model_name,
            prompt=str(payload["prompt"]),
            input_image_bytes=src_bytes,
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
    reference_bytes = asset_store.read_bytes(str(payload["referenceAssetKey"])) if payload.get("referenceAssetKey") else None

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
            if not reference_bytes:
                raise RuntimeError("Runware ACE++ reference image is required")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=35, status="running", logs="Calling Runware ACE++ patch edit")
            edited_patch = patch_edit_aceplusplus(
                api_key=runware_key,
                prompt=model_prompt,
                seed_image_bytes=patch_bytes,
                mask_image_bytes=refined_mask_bytes,
                reference_image_bytes=reference_bytes,
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
    requested_mode = str(payload["mode"])
    luma_mode = requested_mode if requested_mode in LUMA_ALLOWED_MODES else "flex_1"
    uses_end_keyframe = requested_mode in {"kling_start_end", "veo_start_end"}
    replicate_kling_mode = str(payload.get("replicateKlingMode") or "pro")
    replicate_kling_v3_mode = str(payload.get("replicateKlingV3Mode") or "pro")
    wan27_resolution = str(payload.get("wan27Resolution") or "720p")
    provider_name = _segment_generation_provider_name(model_name)

    _api_request_progress(job=job, store=store, request_record=request_record, progress=10, status="running", logs="Loading video generation assets")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_video_path = td_path / "source_video.mp4"
        _download_s3(boto3.client("s3"), settings.assets_bucket, str(payload["videoAssetKey"]), source_video_path)
        first_frame_bytes = asset_store.read_bytes(str(payload["firstFrameAssetKey"]))
        last_frame_bytes = asset_store.read_bytes(str(payload["lastFrameAssetKey"])) if payload.get("lastFrameAssetKey") else None

        source_probe = ffprobe_video(str(source_video_path))
        segment_duration_sec = float(source_probe.get("duration_sec") or 0.0)
        fps = Fraction(int(source_probe.get("fps_num") or 30), int(source_probe.get("fps_den") or 1))
        if fps.numerator <= 0 or fps.denominator <= 0:
            fps = Fraction(30, 1)
        src_width = int(source_probe.get("width") or 1920)
        src_height = int(source_probe.get("height") or 1080)
        provider_media_has_audio = bool(source_probe.get("has_audio"))
        source_size = source_video_path.stat().st_size

        max_seconds = VIDEO_MODEL_MAX_SECONDS.get(model_name)
        min_seconds = VIDEO_MODEL_MIN_SECONDS.get(model_name)
        frame_budget_fps = VIDEO_MODEL_FRAME_BUDGET_FPS.get(model_name)
        duration_frames = max(1, int(round(segment_duration_sec * float(fps))))
        if max_seconds is not None:
            max_frames = int(round(max_seconds * (frame_budget_fps or float(fps))))
            if segment_duration_sec > float(max_seconds) + 1e-6 or duration_frames > max_frames:
                if frame_budget_fps is not None and duration_frames > max_frames and abs(float(fps) - frame_budget_fps) > 1e-3:
                    raise RuntimeError(
                        f"{model_name} allows up to {max_seconds}s at {frame_budget_fps}fps ({max_frames} frames). "
                        f"Input video is {duration_frames} frames / {segment_duration_sec:.2f}s at {float(fps):.2f}fps."
                    )
                raise RuntimeError(f"{model_name} allows up to {max_seconds}s. Input video is {segment_duration_sec:.2f}s.")
        if min_seconds is not None and segment_duration_sec + 1e-6 < float(min_seconds):
            raise RuntimeError(f"{model_name} requires at least {min_seconds}s of source video. Input video is {segment_duration_sec:.2f}s.")

        media_key_for_provider: str | None = None
        first_frame_input_key: str | None = None
        last_frame_input_key: str | None = None
        first_frame_content_type: str | None = None
        last_frame_content_type: str | None = None
        provider_media_width: int | None = None
        provider_media_height: int | None = None
        provider_media_fps: Fraction | None = None
        wan27_video_transport: str | None = None
        wan27_reference_transport: str | None = None
        wan27_video_data_url: str | None = None
        replicate_aspect_ratio: str | None = None
        seedance_aspect_ratio: str | None = None
        seedance_requested_duration_sec: float | None = None
        seedance_raw_output_width: int | None = None
        seedance_raw_output_height: int | None = None
        seedance_output_width: int | None = None
        seedance_output_height: int | None = None

        if model_name in {"kling-o1", "kling-v3-omni-video"}:
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
                target_width=target_w,
                target_height=target_h,
                max_bytes=REPLICATE_VIDEO_MAX_BYTES,
            )
            provider_media_fps = fps
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        elif model_name == "seedance-2.0-reference-to-video":
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
                target_width=target_w,
                target_height=target_h,
                max_bytes=SEEDANCE_REFERENCE_VIDEO_MAX_BYTES,
            )
            provider_media_fps = fps
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        elif model_name == "wan2.7-videoedit":
            wan_edge = 1080 if wan27_resolution == "1080p" else 720
            target_w, target_h = _target_by_orientation(
                src_width,
                src_height,
                landscape=(int(round(wan_edge * 16 / 9)), wan_edge),
                portrait=(wan_edge, int(round(wan_edge * 16 / 9))),
            )
            wan_provider_fps = fps if float(fps) <= 24.0 else Fraction(24, 1)
            local_provider_segment = td_path / "provider_segment_wan27.mp4"
            _api_request_progress(job=job, store=store, request_record=request_record, progress=20, status="running", logs="Preparing segment clip for Wan 2.7 VideoEdit")
            wan27_video_data_url, _ = _prepare_replicate_video_data_url(
                input_path=str(source_video_path),
                output_path=str(local_provider_segment),
                fps=wan_provider_fps,
                target_width=target_w,
                target_height=target_h,
                max_bytes=WAN27_DATA_URL_MAX_BYTES,
            )
            provider_media_width = target_w
            provider_media_height = target_h
            provider_media_fps = wan_provider_fps
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
                max_bytes=FULL_VIDEO_MAX_BYTES,
            )
            provider_media_fps = fps
            media_key_for_provider = paths.request_artifact(request_id, "prepared", "provider_video", ".mp4")
            asset_store.put_bytes(media_key_for_provider, local_provider_segment.read_bytes(), content_type="video/mp4")
        else:
            media_key_for_provider = str(payload["videoAssetKey"])
            provider_media_width = src_width
            provider_media_height = src_height
            provider_media_fps = fps

        with Image.open(BytesIO(first_frame_bytes)) as first_image_probe:
            first_source_width, first_source_height = first_image_probe.size
        if model_name in {"wan2.2-a14b", "wan2.2-animate"}:
            first_target_w, first_target_h = _nearest_runware_wan22_resolution(first_source_width, first_source_height)
        elif model_name in {"kling-o1", "kling-v3-omni-video"}:
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
        elif model_name == "wan2.7-videoedit":
            wan_edge = 1080 if wan27_resolution == "1080p" else 720
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(int(round(wan_edge * 16 / 9)), wan_edge),
                portrait=(wan_edge, int(round(wan_edge * 16 / 9))),
            )
        elif model_name == "seedance-2.0-reference-to-video":
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
        elif model_name in {"runway-gen4.5", "veo-3.1", "veo-3.1-fast"}:
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1280, 720),
                portrait=(720, 1280),
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
            )
            last_frame_input_key = paths.request_artifact(request_id, "prepared", "last_frame", last_frame_ext)
            asset_store.put_bytes(last_frame_input_key, prepared_last_frame, content_type=last_frame_content_type)

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
                    "reference_images": [first_frame_url],
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
                    "image_urls": [first_frame_url],
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
            provider_duration_sec = round(segment_duration_sec, 3)
            wan27_reference_data_url = _prepare_replicate_image_data_url(
                first_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
            )
            wan27_reference_transport = "data_url"
            generation_id, result = _run_wan27_prediction(
                api_key=replicate_key,
                prompt=str(payload.get("prompt") or ""),
                media_url=wan27_video_data_url,
                reference_image=wan27_reference_data_url,
                resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
                aspect_ratio="auto",
                audio_setting="origin" if provider_media_has_audio else "auto",
                job=job,
                store=store,
            )
            out_url = _parse_replicate_output_url(result)
            used_provider_model = "wan-video/wan-2.7-videoedit"
        else:
            luma_key = secrets["LUMA_API_KEY"]
            if not media_url:
                raise RuntimeError("Luma generation requires a prepared source video")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=40, status="running", logs="Creating Luma modify generation")
            created = create_modify_generation(
                api_key=luma_key,
                media_url=media_url,
                first_frame_url=first_frame_url,
                mode=luma_mode,
                model=model_name,
                prompt=payload.get("prompt"),
            )
            generation_id = created.get("id") or created.get("generation_id")
            if not generation_id:
                raise RuntimeError(f"Unexpected Luma create response: {created}")
            _api_request_progress(job=job, store=store, request_record=request_record, progress=55, status="running", logs="Polling Luma generation")
            result = _wait_luma_complete(luma_key, generation_id)
            out_url = _parse_luma_output_url(result)
            used_provider_model = model_name

        out_key = paths.request_artifact(request_id, "output", "result", ".mp4")
        _api_request_progress(job=job, store=store, request_record=request_record, progress=75, status="running", logs="Downloading provider output")
        downloaded_path = td_path / "provider_output_raw.mp4"
        _download_url_to_path(out_url, downloaded_path)
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
        "preparedFirstFrameResolution": {"width": first_target_w, "height": first_target_h},
        "requestedDurationSec": round(segment_duration_sec, 3),
        "providerDurationSec": provider_duration_sec,
        "providerOutputRaw": _video_timing_payload(raw_output_probe),
        "storedOutput": _video_timing_payload(output_probe),
        "timelineConform": timeline_conform,
        "aspectRatio": replicate_aspect_ratio or seedance_aspect_ratio or ("auto" if model_name == "wan2.7-videoedit" else None),
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
        "wan27Resolution": wan27_resolution if model_name == "wan2.7-videoedit" else None,
        "wan27VideoTransport": wan27_video_transport,
        "wan27ReferenceTransport": wan27_reference_transport,
        "mediaHasAudio": provider_media_has_audio,
        "providerModel": used_provider_model or model_name,
    }
    request_record["error"] = None
    _save_api_request(store, request_record)
    _job_progress(job, store, 100, "complete", "API reference video generation completed")
    job["resultRefs"] = {"requestId": request_id, "outputKey": out_key}
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

    _job_progress(job, store, 100, "complete", "SAM proposal ready")
    job["resultRefs"] = {
        "frameId": frame_id,
        "variantId": variant_id,
        "analysisId": analysis_id,
        "proposals": proposal_items,
        "warnings": result.get("warnings", []),
    }
    store.save_job(job)
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
    requested_mode = payload["mode"]
    luma_mode = requested_mode if requested_mode in LUMA_ALLOWED_MODES else "flex_1"
    uses_end_keyframe = requested_mode in {"kling_start_end", "veo_start_end"}
    replicate_kling_mode = str(payload.get("replicateKlingMode") or "pro")
    replicate_kling_v3_mode = str(payload.get("replicateKlingV3Mode") or "pro")
    wan27_resolution = str(payload.get("wan27Resolution") or "720p")
    segment_key: str | None = None
    if model_name in {
        "ray-2",
        "ray-flash-2",
        "wan2.2-animate",
        "kling-o1",
        "kling-v3-omni-video",
        "seedance-2.0-reference-to-video",
        "wan2.7-videoedit",
    }:
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
    if model_name in {"kling-2.6", "veo-3.1", "veo-3.1-fast"} and not uses_end_keyframe:
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
    wan27_reference_transport: str | None = None
    wan27_video_transport: str | None = None
    wan27_video_data_url: str | None = None
    replicate_aspect_ratio: str | None = None
    seedance_aspect_ratio: str | None = None
    seedance_requested_duration_sec: float | None = None
    source_segment_width: int | None = None
    source_segment_height: int | None = None
    seedance_raw_output_width: int | None = None
    seedance_raw_output_height: int | None = None
    seedance_output_width: int | None = None
    seedance_output_height: int | None = None
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
            if model_name in {"kling-o1", "kling-v3-omni-video"}:
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
                    target_width=target_w,
                    target_height=target_h,
                    max_bytes=REPLICATE_VIDEO_MAX_BYTES,
                )
                provider_media_fps = fps
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "replicate")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            elif model_name == "seedance-2.0-reference-to-video":
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
                    target_width=target_w,
                    target_height=target_h,
                    max_bytes=SEEDANCE_REFERENCE_VIDEO_MAX_BYTES,
                )
                provider_media_fps = fps
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "fal")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            elif model_name == "wan2.7-videoedit":
                wan_edge = 1080 if wan27_resolution == "1080p" else 720
                target_w, target_h = _target_by_orientation(
                    segment_src_width,
                    segment_src_height,
                    landscape=(int(round(wan_edge * 16 / 9)), wan_edge),
                    portrait=(wan_edge, int(round(wan_edge * 16 / 9))),
                )
                wan_provider_fps = fps if float(fps) <= 24.0 else Fraction(24, 1)
                _job_progress(job, store, 20, "running", "Preparing segment clip for Wan 2.7 VideoEdit")
                local_provider_segment = td_path / "segment_wan27_data_url.mp4"
                wan27_video_data_url, _ = _prepare_replicate_video_data_url(
                    input_path=str(local_segment_source),
                    output_path=str(local_provider_segment),
                    fps=wan_provider_fps,
                    target_width=target_w,
                    target_height=target_h,
                    max_bytes=WAN27_DATA_URL_MAX_BYTES,
                )
                provider_media_width = target_w
                provider_media_height = target_h
                provider_media_fps = wan_provider_fps
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
                    max_bytes=FULL_VIDEO_MAX_BYTES,
                )
                provider_media_width = luma_w
                provider_media_height = luma_h
                provider_media_fps = fps
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "luma")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            else:
                media_key_for_provider = segment_key
                provider_media_width = segment_src_width
                provider_media_height = segment_src_height
                provider_media_fps = fps

        frame_bytes = asset_store.read_bytes(first_frame_key)
        with Image.open(BytesIO(frame_bytes)) as first_image_probe:
            first_source_width, first_source_height = first_image_probe.size
        if model_name in {"wan2.2-a14b", "wan2.2-animate"}:
            first_target_w, first_target_h = _nearest_runware_wan22_resolution(first_source_width, first_source_height)
        elif model_name in {"kling-o1", "kling-v3-omni-video"}:
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
        elif model_name == "wan2.7-videoedit":
            wan_edge = 1080 if wan27_resolution == "1080p" else 720
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(int(round(wan_edge * 16 / 9)), wan_edge),
                portrait=(wan_edge, int(round(wan_edge * 16 / 9))),
            )
        elif model_name == "seedance-2.0-reference-to-video":
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
        elif model_name in {"runway-gen4.5", "veo-3.1", "veo-3.1-fast"}:
            first_target_w, first_target_h = _target_by_orientation(
                first_source_width,
                first_source_height,
                landscape=(1280, 720),
                portrait=(720, 1280),
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
        )
        local_first_frame = td_path / f"first_frame{first_frame_ext}"
        local_first_frame.write_bytes(prepared_first_frame)
        provider_input_namespace = (
            "runway"
            if model_name == "runway-gen4.5"
            else (
                "kling"
                if model_name == "kling-2.6"
                else (
                    "runware"
                    if model_name in {"veo-3.1", "veo-3.1-fast", "wan2.2-a14b", "wan2.2-animate"}
                    else ("replicate" if model_name in {"kling-o1", "kling-v3-omni-video", "wan2.7-videoedit"} else ("fal" if model_name == "seedance-2.0-reference-to-video" else "luma"))
                )
            )
        )
        first_frame_input_key = paths.segment_provider_first_frame(
            segment_id,
            gen_id,
            provider_input_namespace,
            ext=first_frame_ext,
        )
        _upload_s3(s3, settings.assets_bucket, first_frame_input_key, local_first_frame, first_frame_content_type)

        if model_name in {"kling-2.6", "veo-3.1", "veo-3.1-fast"} and uses_end_keyframe:
            last_frame_bytes = asset_store.read_bytes(last_frame_key)
            prepared_last_frame, last_frame_content_type, last_frame_ext = _prepare_first_frame_image_payload(
                last_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                max_bytes=MAX_PROVIDER_IMAGE_BYTES,
            )
            local_last_frame = td_path / f"last_frame{last_frame_ext}"
            local_last_frame.write_bytes(prepared_last_frame)
            last_frame_input_key = paths.segment_provider_last_frame(
                segment_id,
                gen_id,
                "kling" if model_name == "kling-2.6" else "runware",
                ext=last_frame_ext,
            )
            _upload_s3(s3, settings.assets_bucket, last_frame_input_key, local_last_frame, last_frame_content_type)

    media_url = asset_store.presign_get(media_key_for_provider, expires=3600) if media_key_for_provider else None
    first_frame_url = asset_store.presign_get(first_frame_input_key, expires=3600)
    last_frame_url = asset_store.presign_get(last_frame_input_key, expires=3600) if last_frame_input_key else None

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
                "reference_images": [first_frame_url],
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
                "image_urls": [first_frame_url],
                "video_urls": [media_url],
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
        provider_duration_sec = round(segment_duration_sec, 3)
        wan27_reference_data_url = _prepare_replicate_image_data_url(
            frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
        )
        wan27_reference_transport = "data_url"
        generation_id, result = _run_wan27_prediction(
            api_key=replicate_key,
            prompt=str(payload.get("prompt") or ""),
            media_url=wan27_video_data_url,
            reference_image=wan27_reference_data_url,
            resolution=wan27_resolution if wan27_resolution in {"720p", "1080p"} else "720p",
            aspect_ratio="auto",
            audio_setting="origin" if provider_media_has_audio else "auto",
            job=job,
            store=store,
        )
        out_url = _parse_replicate_output_url(result)
        provider_name = "replicate"
        used_provider_model = "wan-video/wan-2.7-videoedit"
    else:
        luma_key = secrets["LUMA_API_KEY"]
        if not media_url:
            raise RuntimeError("Luma generation requires a prepared segment media URL")
        _job_progress(job, store, 35, "running", "Creating Luma modify generation")
        created = create_modify_generation(
            api_key=luma_key,
            media_url=media_url,
            first_frame_url=first_frame_url,
            mode=luma_mode,
            model=model_name,
            prompt=payload.get("prompt"),
        )
        generation_id = created.get("id") or created.get("generation_id")
        if not generation_id:
            raise RuntimeError(f"Unexpected Luma create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Luma generation")
        result = _wait_luma_complete(luma_key, generation_id)
        out_url = _parse_luma_output_url(result)
        provider_name = "luma"
        used_provider_model = model_name

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
    gen_meta = _update_segment_generation_record(
        store=store,
        user_id=task["userId"],
        task_id=task["taskId"],
        gen_id=gen_id,
        updates={
            "genId": gen_id,
            "segmentId": segment_id,
            "luma": {
                "provider": provider_name,
                "model": model_name,
                "mode": requested_mode,
                "prompt": payload.get("prompt"),
                "lumaGenerationId": generation_id,
            },
            "status": "complete",
            "outputKey": out_key,
            "inputMediaKey": media_key_for_provider,
            "inputFirstFrameKey": first_frame_input_key,
            "inputLastFrameKey": last_frame_input_key,
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
                    replicate_aspect_ratio
                    if model_name in {"kling-o1", "kling-v3-omni-video"}
                    else (seedance_aspect_ratio if model_name == "seedance-2.0-reference-to-video" else ("auto" if model_name == "wan2.7-videoedit" else None))
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
                "wan27Resolution": wan27_resolution if model_name == "wan2.7-videoedit" else None,
                "wan27VideoTransport": wan27_video_transport if model_name == "wan2.7-videoedit" else None,
                "wan27ReferenceTransport": wan27_reference_transport if model_name == "wan2.7-videoedit" else None,
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
                        "durationSec": round(float(provider_duration_sec or segment_duration_sec), 4),
                        "fps": {"num": provider_media_fps.numerator, "den": provider_media_fps.denominator},
                        "width": provider_media_width,
                        "height": provider_media_height,
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
        },
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
    _job_progress(job, store, 100, "complete", "Segment generation complete")
    job["resultRefs"] = {
        "genId": gen_id,
        "segmentId": segment_id,
        "outputKey": out_key,
        "provider": provider_name,
        "model": model_name,
        "mode": requested_mode,
        "providerGenerationId": generation_id,
        "finishedAt": gen_meta.get("finishedAt"),
        "processingDurationSec": processing_duration_sec,
    }
    latest_task = store.load_task(task["userId"], task["taskId"])
    if isinstance(latest_task, dict):
        _advance_chunked_generation_run_after_success(
            store=store,
            asset_store=asset_store,
            task=latest_task,
            settings=settings,
            gen_id=gen_id,
        )
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
    feather_frames = int(payload.get("temporalFeatherFrames", 0))
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
            start_frame_override = raw_adjustment.get("startFrameOverride")
            if start_frame_override is not None:
                start_frame_override = max(0, int(start_frame_override))
                if total_frames > 0:
                    start_frame_override = min(start_frame_override, total_frames - 1)
            else:
                start_frame_override = default_start_frame_override
                if total_frames > 0:
                    start_frame_override = min(start_frame_override, total_frames - 1)
            merge_start_frame = segment["startFrame"] if start_frame_override is None else start_frame_override
            effective_trim_start = trim_start_frames
            effective_trim_end = trim_end_frames
            merge_segment_path = seg_path
            crop_settings = gen.get("segmentCrop") if isinstance(gen.get("segmentCrop"), dict) else segment.get("crop")
            crop_compose_cmd: list[str] | None = None
            if (
                isinstance(crop_settings, dict)
                and crop_settings.get("enabled")
                and int(crop_settings.get("width", 0)) > 0
                and int(crop_settings.get("height", 0)) > 0
            ):
                composed_path = td_path / f"segment_composed_{idx}.mp4"
                crop_compose_cmd = compose_cropped_generated_segment(
                    str(current_path),
                    str(seg_path),
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
                    generated_trim_start_frames=trim_start_frames,
                    generated_trim_end_frames=trim_end_frames,
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
                temporal_feather_frames=feather_frames,
                insert_start_frame=start_frame_override,
                generated_trim_start_frames=effective_trim_start,
                generated_trim_end_frames=effective_trim_end,
            )
            applied.append(
                {
                    "segmentId": segment["segmentId"],
                    "generationId": gen_id,
                    "sourceFrameOffset": source_frame_offset,
                    "startFrameOverride": start_frame_override,
                    "trimStartFrames": trim_start_frames,
                    "trimEndFrames": trim_end_frames,
                    "autoTimingApplied": {
                        "startFrameOverride": raw_adjustment.get("startFrameOverride") is None,
                        "trimEndFrames": raw_adjustment.get("trimEndFrames") is None,
                    },
                    "segmentCrop": crop_settings if isinstance(crop_settings, dict) else None,
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
            "temporalFeatherFrames": feather_frames,
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
            source_offset_sec = source_frame_offset / float(target_fps)
            common_duration_sec = max(
                0.1,
                min(
                    max(0.0, float(original_probe.get("duration_sec") or 0.0) - source_offset_sec),
                    float(generated_probe.get("duration_sec") or 0.0),
                ),
            )

            original_frames = _extract_sampled_frames(
                original_standard_path,
                td_path / "orig_frames",
                sample_fps=QC_SAMPLE_FPS,
                duration_sec=common_duration_sec,
                start_sec=source_offset_sec,
            )
            generated_frames = _extract_sampled_frames(
                generated_standard_path,
                td_path / "gen_frames",
                sample_fps=QC_SAMPLE_FPS,
                duration_sec=common_duration_sec,
            )
            paired_count = min(len(original_frames), len(generated_frames))
            if paired_count == 0:
                raise RuntimeError("No sampled frames available for QC analysis")

            video_mask_key = (
                source_first_variant.get("patchMeta", {}).get("maskKey")
                if isinstance(source_first_variant.get("patchMeta"), dict)
                else None
            )
            video_mask_bytes = asset_store.read_bytes(video_mask_key) if isinstance(video_mask_key, str) else None
            video_mask = _load_optional_mask(video_mask_bytes, (analysis_width, analysis_height))
            per_frame_rows: list[dict[str, Any]] = []
            for frame_idx in range(paired_count):
                orig_image = Image.open(original_frames[frame_idx]).convert("RGB")
                gen_image = Image.open(generated_frames[frame_idx]).convert("RGB")
                sample_time_sec = frame_idx / float(QC_SAMPLE_FPS)
                source_frame_index = int(round((source_offset_sec + sample_time_sec) * float(target_fps)))
                generated_frame_index = int(round(sample_time_sec * float(target_fps)))
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
                        "timeSec": round(source_offset_sec + sample_time_sec, 4),
                        "generatedTimeSec": round(sample_time_sec, 4),
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

            selected_frame_artifacts: list[dict[str, Any]] = []
            for frame_idx in sorted(dedup_selected):
                row = dedup_selected[frame_idx]
                heatmap_bytes, overlay_bytes, binary_bytes = _create_overlay_artifacts(
                    edited_image=row["_edited"],
                    diff_gray=row["_diff"],
                    binary_change=row["_binary"],
                    mask_bin=None,
                )
                stem_base = _report_safe_stem("video", gen_id[-8:], f"frame{frame_idx:03d}")
                heatmap_key = paths.report_artifact(report_id, f"{stem_base}_heatmap", ".png")
                overlay_key = paths.report_artifact(report_id, f"{stem_base}_overlay", ".png")
                binary_key = paths.report_artifact(report_id, f"{stem_base}_binary", ".png")
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
                        "sourceFrameOffset": row.get("sourceFrameOffset"),
                        "changedPctTotal": row["changedPctTotal"],
                        "outsideLeakagePct": row.get("outsideLeakagePct"),
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
            timeline_csv = "index,timeSec,generatedTimeSec,sourceFrameIndex,generatedFrameIndex,sourceFrameOffset,changedPctTotal,outsideLeakagePct,meanDiffTotal,psnr\n" + "\n".join(
                f"{item.get('index')},{item.get('timeSec')},{item.get('generatedTimeSec')},{item.get('sourceFrameIndex')},{item.get('generatedFrameIndex')},{item.get('sourceFrameOffset')},{item.get('changedPctTotal')},{item.get('outsideLeakagePct')},{item.get('meanDiffTotal')},{item.get('psnr')}"
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


def _video_compare_vectors(image: Image.Image, *, size: tuple[int, int] = (96, 54)) -> tuple[list[float], list[float], list[float]]:
    gray = ImageOps.autocontrast(image.convert("L").resize(size, Image.Resampling.BILINEAR))
    edge = ImageOps.autocontrast(gray.filter(ImageFilter.FIND_EDGES))
    gray_values = [float(value) for value in gray.getdata()]
    edge_values = [float(value) for value in edge.getdata()]
    histogram = gray.histogram()
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


def _video_compare_similarity(source_image: Image.Image, generated_image: Image.Image) -> float:
    source = source_image.convert("RGB")
    generated = generated_image.convert("RGB")
    if generated.size != source.size:
        generated = generated.resize(source.size, Image.Resampling.LANCZOS)
    source_gray, source_edge, source_hist = _video_compare_vectors(source)
    generated_gray, generated_edge, generated_hist = _video_compare_vectors(generated)
    edge_score = (_pearson_score(source_edge, generated_edge) + 1.0) / 2.0
    gray_score = (_pearson_score(source_gray, generated_gray) + 1.0) / 2.0
    histogram_score = _histogram_intersection(source_hist, generated_hist)
    return max(0.0, min(1.0, (0.58 * edge_score) + (0.27 * gray_score) + (0.15 * histogram_score)))


def _estimate_video_compare_alignment_from_frame_zero(source_frames: list[Image.Image], generated_first_frame: Image.Image) -> dict[str, Any]:
    if not source_frames:
        return {"sourceFrameOffset": 0, "confidence": 0.0, "score": 0.0, "runnerUpScore": 0.0, "method": "frame_zero_fallback"}
    scored = [
        (index, _video_compare_similarity(source_frame, generated_first_frame))
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
            scores.append(_video_compare_similarity(source_frames[source_index], generated_image))
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
        )
    else:
        first_generated_path = work_dir / f"{prefix}_align_generated_0000.png"
        extract_frame_png(str(generated_path), 0, str(first_generated_path))
        first_generated_image = Image.open(first_generated_path).convert("RGB")
        alignment = _estimate_video_compare_alignment_from_frame_zero(source_frames, first_generated_image)
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
) -> tuple[int, Image.Image]:
    candidates = sorted(
        {
            max(0, min(frame_count - 1, expected_frame_index + delta))
            for delta in range(-search_radius, search_radius + 1)
        }
    )
    best_index: int | None = None
    best_image: Image.Image | None = None
    best_score = -1.0
    for candidate_index in candidates:
        candidate_path = work_dir / f"{prefix}_candidate_{candidate_index:04d}.png"
        extract_frame_png(str(generated_path), candidate_index, str(candidate_path))
        candidate_image = Image.open(candidate_path).convert("RGB")
        score = _video_compare_similarity(source_image, candidate_image)
        if score > best_score:
            best_index = candidate_index
            best_image = candidate_image
            best_score = score
    if best_index is None or best_image is None:
        fallback_path = work_dir / f"{prefix}_fallback_{max(0, expected_frame_index):04d}.png"
        fallback_index = max(0, min(frame_count - 1, expected_frame_index))
        extract_frame_png(str(generated_path), fallback_index, str(fallback_path))
        return fallback_index, Image.open(fallback_path).convert("RGB")
    return best_index, best_image


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
            for setting_key in ("replicateKlingMode", "replicateKlingV3Mode", "wan27Resolution", "seedanceResolution"):
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
                generated_frame_index, generated_image = _best_aligned_generated_frame_index(
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
    left, top, right, bottom = 84, 36, width - 40, height - 72
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
    max_time = max(0.1, max(time_values))
    y_max = max(1.0, max(changed_values), max(outside_values) if outside_values else 0.0, QC_OUTSIDE_LEAK_BUDGET_PCT)

    def _point(time_sec: float, value: float) -> tuple[float, float]:
        x = left + ((time_sec / max_time) * (right - left))
        y = bottom - ((value / y_max) * (bottom - top))
        return x, y

    for tick in range(6):
        y = top + ((bottom - top) * tick / 5.0)
        value = y_max * (1.0 - tick / 5.0)
        draw.line((left, y, right, y), fill=(232, 236, 241), width=1)
        draw.text((18, y - 8), f"{value:.1f}%", fill=(96, 110, 124))

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

    draw.text((left + 14, top + 10), "Changed %", fill=(239, 133, 49))
    draw.text((left + 130, top + 10), "Outside leak %", fill=(40, 122, 214))
    draw.text((left + 300, top + 10), "Leak budget", fill=(210, 74, 74))

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


def _handle_qc_analysis(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    generation_ids = list(dict.fromkeys(job.get("payload", {}).get("generationIds") or []))
    analysis_mode = str(job.get("payload", {}).get("mode") or "standard")
    advanced_frame_only = analysis_mode == "advanced_frame"
    if not generation_ids:
        generation_ids = [
            gen_id
            for gen_id, generation in task.get("segmentGenerations", {}).items()
            if generation.get("status") == "complete"
            and generation.get("outputKey")
        ]

    if not generation_ids:
        _job_progress(job, store, 100, "complete", "No eligible generations found for QC")
        job["resultRefs"] = {"analyzedGenerationIds": [], "failedGenerationIds": []}
        store.save_job(job)
        return job

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
    paths = _asset_paths(task)
    analyzed_ids: list[str] = []
    failed_ids: list[str] = []

    for index, gen_id in enumerate(generation_ids):
        generation = task.get("segmentGenerations", {}).get(gen_id)
        if not generation:
            failed_ids.append(gen_id)
            continue
        if generation.get("status") != "complete" or not generation.get("outputKey"):
            generation["qc"] = {
                "status": "skipped",
                "reason": "Generation is not complete",
                "updatedAt": now_iso(),
            }
            failed_ids.append(gen_id)
            continue

        segment_id = generation.get("segmentId")
        segment = next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)
        if not segment:
            generation["qc"] = {
                "status": "failed",
                "error": f"Segment missing for generation {gen_id}",
                "updatedAt": now_iso(),
            }
            failed_ids.append(gen_id)
            continue

        start_frame = task.get("frames", {}).get(segment["startFrameId"])
        if not start_frame:
            generation["qc"] = {
                "status": "failed",
                "error": "Start frame metadata missing",
                "updatedAt": now_iso(),
            }
            failed_ids.append(gen_id)
            continue

        def _resolve_variant_for_qc(
            frame_record: dict[str, Any],
            preferred_variant_id: Any,
            preferred_output_keys: list[Any] | None = None,
        ) -> tuple[str | None, dict[str, Any]]:
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
            if not resolved_variant or not resolved_variant.get("outputKey"):
                selected_variant_id = frame_record.get("selectedVariantId")
                if isinstance(selected_variant_id, str) and selected_variant_id:
                    selected_variant = next((item for item in variants if item.get("variantId") == selected_variant_id), None)
                    if selected_variant and selected_variant.get("outputKey"):
                        return selected_variant_id, selected_variant
            # Legacy generations may not carry variant linkage. Fall back to the captured frame.
            return None, {"outputKey": frame_record["captureKey"], "patchMeta": {}}

        source_first_variant_id, source_first_variant = _resolve_variant_for_qc(
            start_frame,
            generation.get("sourceFirstFrameVariantId"),
            [generation.get("sourceFirstFrameResolvedKey"), generation.get("inputFirstFrameKey")],
        )

        end_frame = task.get("frames", {}).get(segment.get("endFrameId")) if segment.get("endFrameId") else None
        source_last_variant_id: str | None = None
        source_last_variant: dict[str, Any] | None = None
        if end_frame and end_frame.get("captureKey"):
            source_last_variant_id, source_last_variant = _resolve_variant_for_qc(
                end_frame,
                generation.get("sourceLastFrameVariantId"),
                [generation.get("sourceLastFrameResolvedKey"), generation.get("inputLastFrameKey")],
            )

        if advanced_frame_only:
            qc_state = generation.setdefault("qc", {})
            if not isinstance(qc_state, dict):
                qc_state = {}
            qc_state["advancedFrame"] = {"status": "running", "updatedAt": now_iso()}
            qc_state["updatedAt"] = now_iso()
            generation["qc"] = qc_state
        else:
            generation["qc"] = {"status": "running", "updatedAt": now_iso()}
        store.save_task(task)

        try:
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                video_mask_key = (
                    source_first_variant.get("patchMeta", {}).get("maskKey")
                    if isinstance(source_first_variant.get("patchMeta"), dict)
                    else None
                )
                video_mask_bytes = asset_store.read_bytes(video_mask_key) if isinstance(video_mask_key, str) else None

                def _analyze_frame_variant(
                    *,
                    frame_record: dict[str, Any],
                    variant_record: dict[str, Any],
                    artifact_prefix: str,
                    include_advanced: bool,
                ) -> dict[str, Any]:
                    original_frame_bytes = asset_store.read_bytes(frame_record["captureKey"])
                    edited_frame_bytes = asset_store.read_bytes(variant_record["outputKey"])
                    mask_key = (
                        variant_record.get("patchMeta", {}).get("maskKey")
                        if isinstance(variant_record.get("patchMeta"), dict)
                        else None
                    )
                    mask_bytes = asset_store.read_bytes(mask_key) if isinstance(mask_key, str) else None

                    original_frame_image = ImageOps.exif_transpose(Image.open(BytesIO(original_frame_bytes))).convert("RGB")
                    edited_frame_image = ImageOps.exif_transpose(Image.open(BytesIO(edited_frame_bytes))).convert("RGB")
                    frame_mask = _load_optional_mask(mask_bytes, original_frame_image.size)
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
                    frame_heatmap_key = paths.qc_artifact(segment["segmentId"], gen_id, f"{artifact_prefix}_heatmap", ".png")
                    frame_overlay_key = paths.qc_artifact(segment["segmentId"], gen_id, f"{artifact_prefix}_overlay", ".png")
                    frame_binary_key = paths.qc_artifact(segment["segmentId"], gen_id, f"{artifact_prefix}_binary", ".png")
                    frame_boundary_overlay_key = paths.qc_artifact(
                        segment["segmentId"], gen_id, f"{artifact_prefix}_boundary_overlay", ".png"
                    )
                    asset_store.put_bytes(frame_heatmap_key, frame_heatmap_bytes, content_type="image/png")
                    asset_store.put_bytes(frame_overlay_key, frame_overlay_bytes, content_type="image/png")
                    asset_store.put_bytes(frame_binary_key, frame_binary_bytes, content_type="image/png")
                    asset_store.put_bytes(frame_boundary_overlay_key, frame_boundary_overlay_bytes, content_type="image/png")
                    result: dict[str, Any] = {
                        "metrics": frame_metrics,
                        "artifacts": {
                            "heatmapKey": frame_heatmap_key,
                            "overlayKey": frame_overlay_key,
                            "binaryChangeKey": frame_binary_key,
                            "boundaryOverlayKey": frame_boundary_overlay_key,
                        },
                    }
                    if include_advanced:
                        advanced_result = _run_advanced_frame_qc(
                            original_image=original_frame_image,
                            edited_image=edited_frame_image,
                            mask_bin=frame_mask_bin,
                        )
                        advanced_artifact_keys: dict[str, str] = {}
                        for artifact_name, artifact_bytes in (advanced_result.get("artifacts") or {}).items():
                            advanced_key_name = str(artifact_name)
                            advanced_key = paths.qc_artifact(
                                segment["segmentId"],
                                gen_id,
                                f"{artifact_prefix}_advanced_{advanced_key_name}",
                                ".png",
                            )
                            asset_store.put_bytes(advanced_key, artifact_bytes, content_type="image/png")
                            advanced_artifact_keys[f"{advanced_key_name}Key"] = advanced_key
                        result["advanced"] = {
                            "status": advanced_result.get("status") or "pass",
                            "metrics": advanced_result.get("metrics") or {},
                            "topRegions": advanced_result.get("topRegions") or [],
                            "tooltips": advanced_result.get("tooltips") or {},
                            "artifacts": advanced_artifact_keys,
                        }
                    return result

                frame_by_variant: dict[str, dict[str, Any]] = {}

                def _variants_with_output(frame_record: dict[str, Any]) -> list[dict[str, Any]]:
                    variants = frame_record.get("variants", [])
                    if not isinstance(variants, list):
                        return []
                    return [item for item in variants if isinstance(item, dict) and item.get("variantId") and item.get("outputKey")]

                start_variants = _variants_with_output(start_frame)
                first_frame_qc: dict[str, Any] | None = None
                for variant_index, variant_record in enumerate(start_variants):
                    variant_id = str(variant_record["variantId"])
                    variant_qc = _analyze_frame_variant(
                        frame_record=start_frame,
                        variant_record=variant_record,
                        artifact_prefix=f"frame_start_{variant_index:03d}",
                        include_advanced=advanced_frame_only,
                    )
                    frame_by_variant[variant_id] = variant_qc
                    if variant_id == source_first_variant_id:
                        first_frame_qc = variant_qc

                if first_frame_qc is None:
                    first_frame_qc = _analyze_frame_variant(
                        frame_record=start_frame,
                        variant_record=source_first_variant,
                        artifact_prefix="frame",
                        include_advanced=advanced_frame_only,
                    )
                    if isinstance(source_first_variant_id, str) and source_first_variant_id:
                        frame_by_variant[source_first_variant_id] = first_frame_qc

                if end_frame and end_frame.get("captureKey"):
                    end_variants = _variants_with_output(end_frame)
                    for variant_index, variant_record in enumerate(end_variants):
                        variant_id = str(variant_record["variantId"])
                        if variant_id in frame_by_variant:
                            continue
                        variant_qc = _analyze_frame_variant(
                            frame_record=end_frame,
                            variant_record=variant_record,
                            artifact_prefix=f"frame_end_{variant_index:03d}",
                            include_advanced=advanced_frame_only,
                        )
                        frame_by_variant[variant_id] = variant_qc

                    if (
                        source_last_variant
                        and source_last_variant.get("outputKey")
                        and isinstance(source_last_variant_id, str)
                        and source_last_variant_id
                        and source_last_variant_id not in frame_by_variant
                    ):
                        last_frame_qc = _analyze_frame_variant(
                            frame_record=end_frame,
                            variant_record=source_last_variant,
                            artifact_prefix="frame_last",
                            include_advanced=advanced_frame_only,
                        )
                        frame_by_variant[source_last_variant_id] = last_frame_qc

                frame_metrics = first_frame_qc["metrics"]
                frame_heatmap_key = first_frame_qc["artifacts"]["heatmapKey"]
                frame_overlay_key = first_frame_qc["artifacts"]["overlayKey"]
                frame_binary_key = first_frame_qc["artifacts"]["binaryChangeKey"]
                frame_boundary_overlay_key = first_frame_qc["artifacts"]["boundaryOverlayKey"]

                if advanced_frame_only:
                    existing_qc = generation.get("qc") if isinstance(generation.get("qc"), dict) else {}
                    existing_frame_by_variant = existing_qc.get("frameByVariant") if isinstance(existing_qc.get("frameByVariant"), dict) else {}
                    merged_frame_by_variant = {**existing_frame_by_variant, **frame_by_variant}
                    advanced_variant_count = sum(
                        1
                        for value in merged_frame_by_variant.values()
                        if isinstance(value, dict) and isinstance(value.get("advanced"), dict)
                    )
                    generation["qc"] = {
                        **existing_qc,
                        "status": "complete",
                        "updatedAt": now_iso(),
                        "analyzedAt": now_iso(),
                        "frame": first_frame_qc,
                        "frameByVariant": merged_frame_by_variant,
                        "advancedFrame": {
                            "status": "complete",
                            "updatedAt": now_iso(),
                            "analyzedAt": now_iso(),
                            "variantCount": advanced_variant_count,
                            "config": {
                                "patchSize": ADV_QC_PATCH_SIZE,
                                "stride": ADV_QC_STRIDE,
                                "outerRingPx": ADV_QC_OUTER_RING_PX,
                            },
                        },
                    }
                    analyzed_ids.append(gen_id)
                    store.save_task(task)
                    progress = 10 + math.floor(85 * (index + 1) / max(1, len(generation_ids)))
                    _job_progress(job, store, progress, "running", f"Advanced frame QC analyzed {index + 1}/{len(generation_ids)} generations")
                    continue

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
                common_duration_sec = max(
                    0.1,
                    min(float(original_probe.get("duration_sec") or 0.0), float(generated_probe.get("duration_sec") or 0.0)),
                )

                original_frames = _extract_sampled_frames(
                    original_standard_path,
                    td_path / "orig_frames",
                    sample_fps=QC_SAMPLE_FPS,
                    duration_sec=common_duration_sec,
                )
                generated_frames = _extract_sampled_frames(
                    generated_standard_path,
                    td_path / "gen_frames",
                    sample_fps=QC_SAMPLE_FPS,
                    duration_sec=common_duration_sec,
                )
                paired_count = min(len(original_frames), len(generated_frames))
                if paired_count == 0:
                    raise RuntimeError("No sampled frames available for QC analysis")

                video_mask = _load_optional_mask(video_mask_bytes, (analysis_width, analysis_height))
                per_frame_rows: list[dict[str, Any]] = []
                for frame_idx in range(paired_count):
                    orig_image = Image.open(original_frames[frame_idx]).convert("RGB")
                    gen_image = Image.open(generated_frames[frame_idx]).convert("RGB")
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
                            "timeSec": round(frame_idx / float(QC_SAMPLE_FPS), 4),
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

                selected_frame_artifacts: list[dict[str, Any]] = []
                for frame_idx in sorted(dedup_selected):
                    row = dedup_selected[frame_idx]
                    heatmap_bytes, overlay_bytes, binary_bytes = _create_overlay_artifacts(
                        edited_image=row["_edited"],
                        diff_gray=row["_diff"],
                        binary_change=row["_binary"],
                        mask_bin=None,
                    )
                    heatmap_key = paths.qc_artifact(segment["segmentId"], gen_id, f"video_frame_{frame_idx:03d}_heatmap", ".png")
                    overlay_key = paths.qc_artifact(segment["segmentId"], gen_id, f"video_frame_{frame_idx:03d}_overlay", ".png")
                    binary_key = paths.qc_artifact(segment["segmentId"], gen_id, f"video_frame_{frame_idx:03d}_binary", ".png")
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
                        "sourceFrameOffset": row.get("sourceFrameOffset"),
                        "changedPctTotal": row["changedPctTotal"],
                            "outsideLeakagePct": row.get("outsideLeakagePct"),
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
                diff_video_key = paths.qc_artifact(segment["segmentId"], gen_id, "video_diff_map", ".mp4")
                _upload_s3(s3, settings.assets_bucket, diff_video_key, diff_video_path, "video/mp4")

                timeline_rows = []
                for row in per_frame_rows:
                    timeline_rows.append(
                        {
                            key: value
                            for key, value in row.items()
                            if not key.startswith("_")
                        }
                    )
                timeline_csv = "index,timeSec,changedPctTotal,outsideLeakagePct,meanDiffTotal,psnr\n" + "\n".join(
                    f"{item.get('index')},{item.get('timeSec')},{item.get('changedPctTotal')},{item.get('outsideLeakagePct')},{item.get('meanDiffTotal')},{item.get('psnr')}"
                    for item in timeline_rows
                )
                timeline_csv_key = paths.qc_artifact(segment["segmentId"], gen_id, "timeline", ".csv")
                timeline_graph_key = paths.qc_artifact(segment["segmentId"], gen_id, "timeline_graph", ".png")
                report_json_key = paths.qc_artifact(segment["segmentId"], gen_id, "report", ".json")
                asset_store.put_bytes(timeline_csv_key, timeline_csv.encode("utf-8"), content_type="text/csv")
                asset_store.put_bytes(timeline_graph_key, _build_timeline_graph_png(timeline_rows), content_type="image/png")

                video_aggregates = {
                    "sampledFrameCount": paired_count,
                    "sampleFps": QC_SAMPLE_FPS,
                    "analysisResolution": {"width": analysis_width, "height": analysis_height},
                    "durationSec": round(common_duration_sec, 4),
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
                    "firstFrame": first_frame_metrics,
                    "lastFrame": last_frame_metrics,
                    "vmaf": vmaf_metrics,
                }

                qc_report_payload = {
                    "generationId": gen_id,
                    "segmentId": segment["segmentId"],
                    "analyzedAt": now_iso(),
                    "config": {
                        "sampleFps": QC_SAMPLE_FPS,
                        "analysisResolution": {"width": analysis_width, "height": analysis_height},
                        "diffThreshold": QC_DIFF_THRESHOLD,
                        "boundaryRingPx": QC_BOUNDARY_RING_PX,
                    },
                    "frame": {
                        "metrics": frame_metrics,
                        "artifacts": {
                            "heatmapKey": frame_heatmap_key,
                            "overlayKey": frame_overlay_key,
                            "binaryChangeKey": frame_binary_key,
                            "boundaryOverlayKey": frame_boundary_overlay_key,
                        },
                    },
                    "frameByVariant": frame_by_variant,
                    "video": {
                        "aggregates": video_aggregates,
                        "selectedFrames": selected_frame_artifacts,
                        "artifacts": {
                            "diffVideoKey": diff_video_key,
                            "timelineCsvKey": timeline_csv_key,
                            "timelineGraphKey": timeline_graph_key,
                        },
                    },
                }
                asset_store.put_bytes(report_json_key, json.dumps(qc_report_payload).encode("utf-8"), content_type="application/json")
                qc_report_payload["video"]["artifacts"]["reportJsonKey"] = report_json_key
                generation["qc"] = {
                    "status": "complete",
                    "updatedAt": now_iso(),
                    **qc_report_payload,
                }
                analyzed_ids.append(gen_id)
        except Exception as exc:
            logger.exception("QC analysis failed for generation", extra={"genId": gen_id, "taskId": task["taskId"]})
            generation["qc"] = {
                "status": "failed",
                "updatedAt": now_iso(),
                "error": str(exc),
            }
            failed_ids.append(gen_id)

        store.save_task(task)
        progress = 10 + math.floor(85 * (index + 1) / max(1, len(generation_ids)))
        _job_progress(job, store, progress, "running", f"QC analyzed {index + 1}/{len(generation_ids)} generations")

    task.setdefault("history", []).append(
        {
            "at": now_iso(),
            "event": "task.qc.complete",
            "jobId": job["jobId"],
            "mode": analysis_mode,
            "analyzed": analyzed_ids,
            "failed": failed_ids,
        }
    )
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "QC analysis complete")
    job["resultRefs"] = {"analyzedGenerationIds": analyzed_ids, "failedGenerationIds": failed_ids}
    store.save_job(job)
    return job


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
    if str(job.get("status") or "").lower() == "complete":
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
        if job_type == "ingest_video":
            _handle_ingest(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "edit_full":
            _handle_full_edit(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "edit_patch":
            _handle_patch_edit(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "api_image_edit_full":
            _handle_api_image_edit_full(job=job, store=store, asset_store=asset_store, settings=settings)
        elif job_type == "api_image_edit_patch":
            _handle_api_image_edit_patch(job=job, store=store, asset_store=asset_store, settings=settings)
        elif job_type == "api_video_generate_reference":
            _handle_api_video_generate_reference(job=job, store=store, asset_store=asset_store, settings=settings)
        elif job_type == "quality_match_apply":
            _handle_quality_match_apply(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "quality_match_sam":
            _handle_quality_match_sam(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "segment_generate":
            _handle_segment_generate(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "merge_export":
            _handle_merge(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "qc_analysis":
            _handle_qc_analysis(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "qc_report_build":
            _handle_qc_report_build(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "motion_sync_qc":
            _handle_motion_sync_qc(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "video_cleanup_init":
            _handle_video_cleanup_init(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "video_cleanup_track":
            _handle_video_cleanup_track(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "video_cleanup_retrack_window":
            _handle_video_cleanup_retrack_window(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "video_cleanup_preview":
            _handle_video_cleanup_preview(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job_type == "video_cleanup_apply":
            _handle_video_cleanup_apply(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        else:
            raise RuntimeError(f"Unsupported job type: {job_type}")
    except Exception as exc:
        logger.exception("Job failed", extra={"jobId": job_id, "taskId": task_id, "userId": user_id})
        job["status"] = "failed"
        job["error"] = str(exc)
        job["finishedAt"] = now_iso()
        store.save_job(job)
        if job_type.startswith("api_"):
            request_id = str((job.get("payload") or {}).get("requestId") or "")
            request_record = store.load_api_request(user_id, request_id) if request_id else None
            if isinstance(request_record, dict):
                request_record["status"] = "failed"
                request_record["finishedAt"] = now_iso()
                request_record["error"] = {"code": "job_failed", "message": str(exc)}
                request_logs = request_record.setdefault("logs", [])
                if isinstance(request_logs, list):
                    request_logs.append({"at": now_iso(), "message": f"Failed: {exc}"})
                store.save_api_request(request_record)
            return
        latest_task = store.load_task(user_id, str(task_id or "")) or task
        if job_type == "segment_generate":
            gen_id = str((job.get("payload") or {}).get("genId") or "")
            generation = latest_task.setdefault("segmentGenerations", {}).get(gen_id)
            if isinstance(generation, dict):
                generation["status"] = "failed"
                generation["error"] = str(exc)
                generation["updatedAt"] = now_iso()
                generation["finishedAt"] = now_iso()
                generation["jobId"] = job_id
                latest_task.setdefault("history", []).append(
                    {
                        "at": now_iso(),
                        "event": "segment_generation.failed",
                        "jobId": job_id,
                        "genId": gen_id,
                    }
                )
                store.save_task(latest_task, merge_on_conflict=True)
                refreshed_task = store.load_task(user_id, str(task_id or ""))
                if isinstance(refreshed_task, dict):
                    _mark_chunked_generation_run_failed(
                        store=store,
                        task=refreshed_task,
                        gen_id=gen_id,
                        error=str(exc),
                    )
                return
        elif job_type == "qc_report_build":
            report_id = str((job.get("payload") or {}).get("reportId") or "")
            reports = latest_task.get("customReports", [])
            report_record = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
            if isinstance(report_record, dict):
                report_record["status"] = "failed"
                report_record["updatedAt"] = now_iso()
                report_record["error"] = str(exc)
                store.save_task(latest_task, merge_on_conflict=True)
        elif job_type.startswith("video_cleanup_"):
            track_id = str((job.get("payload") or {}).get("trackId") or "")
            track = get_cleanup_track(latest_task, track_id) if track_id else None
            if isinstance(track, dict):
                track["status"] = "failed"
                track["updatedAt"] = now_iso()
                track["error"] = str(exc)
            latest_task.setdefault("history", []).append(
                {
                    "at": now_iso(),
                    "event": "video_cleanup.failed",
                    "jobId": job_id,
                    "trackId": track_id,
                }
            )
            store.save_task(latest_task, merge_on_conflict=True)
            return
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
