from __future__ import annotations

import json
import hashlib
import math
import re
import subprocess
import tempfile
import time
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from typing import Any

import boto3
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

from src.core.assets import AssetPaths, AssetStore
from src.core.ffmpeg import (
    FFMPEG_BIN,
    compose_cropped_generated_segment,
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
from src.integrations.kling import (
    create_start_end_generation as create_kling_start_end_generation,
    get_generation_response as get_kling_generation_response,
)
from src.integrations.luma import create_modify_generation, get_generation
from src.integrations.openai_images import generate_image_edit as generate_openai_image_edit
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

logger = Logger()

FULL_VIDEO_MAX_BYTES = 100 * 1024 * 1024
MAX_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024
KLING_SUPPORTED_DURATIONS = (5, 10)
QC_SAMPLE_FPS = 3
QC_ANALYSIS_MAX_FRAMES = 90
QC_DIFF_THRESHOLD = 32
QC_OUTSIDE_LEAK_BUDGET_PCT = 0.50
QC_BOUNDARY_RING_PX = 8
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


def _asset_paths(task: dict[str, Any]) -> AssetPaths:
    return AssetPaths(user_id=task["userId"], task_id=task["taskId"], file_prefix=task.get("filePrefix", ""))


def _download_s3(s3, bucket: str, key: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(bucket, key, str(path))


def _upload_s3(s3, bucket: str, key: str, path: Path, content_type: str | None = None) -> None:
    extra = {"ServerSideEncryption": "AES256"}
    if content_type:
        extra["ContentType"] = content_type
    s3.upload_file(str(path), bucket, key, ExtraArgs=extra)


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
    alpha = ImageOps.invert(mask_l)
    rgba = Image.new("RGBA", mask_l.size, (0, 0, 0, 255))
    rgba.putalpha(alpha)
    out = BytesIO()
    rgba.save(out, format="PNG")
    return out.getvalue()


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
    if model_name == "chatgpt":
        openai_key = secrets.get("OPENAI_API_KEY")
        if not openai_key:
            raise RuntimeError("OPENAI_API_KEY is required for ChatGPT image edits")
        provider_name = "openai"
        _job_progress(job, store, 30, "running", "Calling OpenAI edit")
        out_bytes = generate_openai_image_edit(
            api_key=openai_key,
            model="chatgpt",
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

    variant_id = new_id("var")
    paths = _asset_paths(task)
    output_key = paths.frame_variant(frame_id, variant_id)
    asset_store.put_bytes(output_key, normalized_bytes, content_type="image/png")

    variant = {
        "variantId": variant_id,
        "type": "full",
        "model": payload["model"],
        "promptHash": prompt_hash(payload["prompt"]),
        "createdAt": now_iso(),
        "outputKey": output_key,
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
                prompt=payload["prompt"],
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
                prompt=payload["prompt"],
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
        if model_name == "chatgpt":
            openai_key = secrets.get("OPENAI_API_KEY")
            if not openai_key:
                raise RuntimeError("OPENAI_API_KEY is required for ChatGPT patch edits")
            provider_name = "openai"
            openai_mask_bytes = _to_openai_alpha_mask(refined_mask_bytes)
            _job_progress(job, store, 30, "running", "Calling OpenAI patch edit")
            edited_patch = generate_openai_image_edit(
                api_key=openai_key,
                model="chatgpt",
                prompt=payload["prompt"],
                input_image_bytes=patch_bytes,
                mask_image_bytes=openai_mask_bytes,
            )
        else:
            gemini_key = secrets["GEMINI_API_KEY"]
            _job_progress(job, store, 30, "running", "Calling Gemini patch edit")
            edited_patch = generate_gemini_image_edit(
                api_key=gemini_key,
                model="nano_banana_pro",
                prompt=payload["prompt"],
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

    variant_id = new_id("var")
    paths = _asset_paths(task)
    output_key = paths.frame_variant(frame_id, variant_id)
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
        "outputKey": output_key,
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

    paths = _asset_paths(task)
    s3 = boto3.client("s3")
    model_name = payload["lumaModel"]
    requested_mode = payload["mode"]
    uses_end_keyframe = requested_mode in {"kling_start_end", "veo_start_end"}
    segment_key: str | None = None
    if model_name in {"ray-2", "ray-flash-2", "wan2.2-animate"}:
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
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        if segment_key:
            local_segment_source = td_path / "segment_full.mp4"
            _download_s3(s3, settings.assets_bucket, segment_key, local_segment_source)
            segment_source_probe = ffprobe_video(str(local_segment_source))
            segment_src_width = int(segment_source_probe.get("width") or src_width)
            segment_src_height = int(segment_source_probe.get("height") or src_height)
            source_size = local_segment_source.stat().st_size
            if source_size > FULL_VIDEO_MAX_BYTES:
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
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "luma")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            else:
                media_key_for_provider = segment_key
                provider_media_width = segment_src_width
                provider_media_height = segment_src_height

        frame_bytes = asset_store.read_bytes(first_frame_key)
        with Image.open(BytesIO(frame_bytes)) as first_image_probe:
            first_source_width, first_source_height = first_image_probe.size
        if model_name in {"wan2.2-a14b", "wan2.2-animate"}:
            first_target_w, first_target_h = _nearest_runware_wan22_resolution(first_source_width, first_source_height)
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
        first_frame_input_key = paths.segment_provider_first_frame(
            segment_id,
            gen_id,
            "runway"
            if model_name == "runway-gen4.5"
            else (
                "kling"
                if model_name == "kling-2.6"
                else ("runware" if model_name in {"veo-3.1", "veo-3.1-fast", "wan2.2-a14b", "wan2.2-animate"} else "luma")
            ),
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
    else:
        luma_key = secrets["LUMA_API_KEY"]
        if not media_url:
            raise RuntimeError("Luma generation requires a prepared segment media URL")
        _job_progress(job, store, 35, "running", "Creating Luma modify generation")
        created = create_modify_generation(
            api_key=luma_key,
            media_url=media_url,
            first_frame_url=first_frame_url,
            mode=payload["mode"],
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
    asset_store.download_url_to_s3(out_url, out_key)

    gen_meta = task.setdefault("segmentGenerations", {}).setdefault(gen_id, {})
    gen_meta.update(
        {
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
            "segmentCrop": segment.get("crop"),
            "generationSettings": {
                "provider": provider_name,
                "requestedModel": model_name,
                "model": used_provider_model or model_name,
                "mode": requested_mode,
                "firstFrameResolution": {"width": first_target_w, "height": first_target_h},
                "firstFrameContentType": first_frame_content_type,
                "lastFrameContentType": last_frame_content_type,
                "mediaResolution": (
                    {"width": provider_media_width, "height": provider_media_height}
                    if provider_media_width and provider_media_height
                    else None
                ),
                "segmentCrop": segment.get("crop"),
                "requestedDurationSec": round(segment_duration_sec, 3),
                "providerDurationSec": provider_duration_sec,
            },
            "createdAt": gen_meta.get("createdAt") or now_iso(),
        }
    )

    store.save_task(task)
    _job_progress(job, store, 100, "complete", "Segment generation complete")
    job["resultRefs"] = {"genId": gen_id, "segmentId": segment_id}
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
            trim_start_frames = max(0, int(raw_adjustment.get("trimStartFrames") or 0))
            trim_end_frames = max(0, int(raw_adjustment.get("trimEndFrames") or 0))
            start_frame_override = raw_adjustment.get("startFrameOverride")
            if start_frame_override is not None:
                start_frame_override = max(0, int(start_frame_override))
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
                    "startFrameOverride": start_frame_override,
                    "trimStartFrames": trim_start_frames,
                    "trimEndFrames": trim_end_frames,
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


def _extract_sampled_frames(video_path: Path, output_dir: Path, *, sample_fps: int, duration_sec: float) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_pattern = output_dir / "frame_%05d.png"
    command = [
        FFMPEG_BIN,
        "-y",
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


def _handle_qc_analysis(
    *,
    job: dict[str, Any],
    store: S3JsonStore,
    asset_store: AssetStore,
    task: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    generation_ids = list(dict.fromkeys(job.get("payload", {}).get("generationIds") or []))
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
                    return {
                        "metrics": frame_metrics,
                        "artifacts": {
                            "heatmapKey": frame_heatmap_key,
                            "overlayKey": frame_overlay_key,
                            "binaryChangeKey": frame_binary_key,
                            "boundaryOverlayKey": frame_boundary_overlay_key,
                        },
                    }

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
                    )
                    frame_by_variant[variant_id] = variant_qc
                    if variant_id == source_first_variant_id:
                        first_frame_qc = variant_qc

                if first_frame_qc is None:
                    first_frame_qc = _analyze_frame_variant(
                        frame_record=start_frame,
                        variant_record=source_first_variant,
                        artifact_prefix="frame",
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
                        )
                        frame_by_variant[source_last_variant_id] = last_frame_qc

                frame_metrics = first_frame_qc["metrics"]
                frame_heatmap_key = first_frame_qc["artifacts"]["heatmapKey"]
                frame_overlay_key = first_frame_qc["artifacts"]["overlayKey"]
                frame_binary_key = first_frame_qc["artifacts"]["binaryChangeKey"]
                frame_boundary_overlay_key = first_frame_qc["artifacts"]["boundaryOverlayKey"]

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
            "analyzed": analyzed_ids,
            "failed": failed_ids,
        }
    )
    store.save_task(task)
    _job_progress(job, store, 100, "complete", "QC analysis complete")
    job["resultRefs"] = {"analyzedGenerationIds": analyzed_ids, "failedGenerationIds": failed_ids}
    store.save_job(job)
    return job


def process_job_record(record: dict[str, Any], *, settings: Any) -> None:
    body = json.loads(record["body"])
    user_id = body["userId"]
    task_id = body["taskId"]
    job_id = body["jobId"]

    store = S3JsonStore(settings.metadata_bucket)
    asset_store = AssetStore(settings.assets_bucket, settings.aws_region)

    job = store.load_job(user_id, job_id)
    task = store.load_task(user_id, task_id)
    if not job:
        raise RuntimeError(f"Job not found: {job_id}")
    if not task:
        raise RuntimeError(f"Task not found: {task_id}")

    job["status"] = "running"
    job["progress"] = 0
    job.pop("error", None)
    job.pop("resultRefs", None)
    job.setdefault("startedAt", now_iso())
    store.save_job(job)

    try:
        if job["type"] == "ingest_video":
            _handle_ingest(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job["type"] == "edit_full":
            _handle_full_edit(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job["type"] == "edit_patch":
            _handle_patch_edit(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job["type"] == "segment_generate":
            _handle_segment_generate(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job["type"] == "merge_export":
            _handle_merge(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        elif job["type"] == "qc_analysis":
            _handle_qc_analysis(job=job, store=store, asset_store=asset_store, task=task, settings=settings)
        else:
            raise RuntimeError(f"Unsupported job type: {job['type']}")
    except Exception as exc:
        logger.exception("Job failed", extra={"jobId": job_id, "taskId": task_id, "userId": user_id})
        job["status"] = "failed"
        job["error"] = str(exc)
        job["finishedAt"] = now_iso()
        store.save_job(job)
        latest_task = store.load_task(user_id, task_id) or task
        if job.get("type") == "segment_generate":
            gen_id = (job.get("payload") or {}).get("genId")
            segment_generations = latest_task.setdefault("segmentGenerations", {})
            if gen_id in segment_generations:
                segment_generations.pop(gen_id, None)
                for segment in latest_task.get("segments", []):
                    if segment.get("selectedGenerationId") == gen_id:
                        segment["selectedGenerationId"] = None
                latest_task.setdefault("history", []).append(
                    {
                        "at": now_iso(),
                        "event": "segment_generation.failed_removed",
                        "jobId": job_id,
                        "genId": gen_id,
                    }
                )
        latest_task["status"] = "error"
        latest_task.setdefault("history", []).append({"at": now_iso(), "event": "job.failed", "jobId": job_id})
        store.save_task(latest_task)
        raise
    else:
        job["finishedAt"] = now_iso()
        store.save_job(job)
        if task.get("status") == "error":
            task["status"] = "ready" if task.get("video", {}).get("editSource", {}).get("s3Key") else "created"
            task.setdefault("history", []).append({"at": now_iso(), "event": "task.recovered", "jobId": job_id})
            store.save_task(task)
