from __future__ import annotations

import json
import hashlib
import math
import tempfile
import time
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from typing import Any

import boto3
from PIL import Image, ImageChops, ImageFilter, ImageOps
from aws_lambda_powertools import Logger

from src.core.assets import AssetPaths, AssetStore
from src.core.ffmpeg import (
    extract_segment_by_frames,
    ffprobe_video,
    generate_thumbnail_strip,
    merge_with_segment_replacement,
    transcode_for_preview,
    transcode_for_provider,
    transcode_to_cfr,
)
from src.core.ids import new_id, prompt_hash
from src.core.secrets import load_secret
from src.core.store import S3JsonStore, now_iso
from src.integrations.gemini import generate_image_edit
from src.integrations.kling import (
    create_start_end_generation as create_kling_start_end_generation,
    get_generation_response as get_kling_generation_response,
)
from src.integrations.luma import create_modify_generation, get_generation
from src.integrations.runware import patch_edit_aceplusplus, patch_edit_flux_fill
from src.integrations.runway import (
    create_ephemeral_upload,
    create_image_to_video,
    create_video_to_video,
    get_task as get_runway_task,
    upload_to_ephemeral,
)

logger = Logger()

FULL_VIDEO_MAX_BYTES = 100 * 1024 * 1024
RUNWAY_VIDEO_MAX_BYTES = 64 * 1024 * 1024
MAX_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024
KLING_SUPPORTED_DURATIONS = (5, 10)


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


def _prepare_first_frame_image_bytes(
    frame_bytes: bytes,
    *,
    target_width: int,
    target_height: int,
    max_bytes: int,
) -> bytes:
    image = ImageOps.exif_transpose(Image.open(BytesIO(frame_bytes))).convert("RGB")
    canvas = _fit_image_to_canvas(image, target_width, target_height)
    payload = _encode_jpeg_with_limit(canvas, max_bytes)
    if len(payload) > max_bytes:
        raise RuntimeError(f"Unable to compress frame under {max_bytes} bytes")
    return payload


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
    try:
        asset_store.head_object(segment_key)
        return segment_key
    except Exception:
        pass

    with tempfile.TemporaryDirectory() as td:
        edit_source_key = task["video"]["editSource"]["s3Key"]
        input_path = Path(td) / "edit.mp4"
        output_path = Path(td) / "segment.mp4"
        _download_s3(s3, assets_bucket, edit_source_key, input_path)
        extract_segment_by_frames(
            str(input_path),
            str(output_path),
            start_frame=segment["startFrame"],
            end_frame_exclusive=segment["endFrameExclusive"],
            fps_num=task["video"]["editSource"]["fps"]["num"],
            fps_den=task["video"]["editSource"]["fps"]["den"],
        )
        _upload_s3(s3, assets_bucket, segment_key, output_path, "video/mp4")
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
        target_width, target_height = _target_by_orientation(
            probe["width"],
            probe["height"],
            landscape=(1920, 1080),
            portrait=(1080, 1920),
        )
        _job_progress(job, store, 15, "running", "Normalizing edit source to CFR 1080 canvas")
        transcode_to_cfr(
            str(original_path),
            str(edit_path),
            fps,
            target_width=target_width,
            target_height=target_height,
            crf=18,
            preset="fast",
            audio_bitrate="192k",
        )
        edit_probe = ffprobe_video(str(edit_path))

        _job_progress(job, store, 32, "running", "Building lightweight preview proxy")
        preview_w, preview_h = transcode_for_preview(
            str(edit_path),
            str(preview_path),
            fps=Fraction(edit_probe["fps_num"], edit_probe["fps_den"]) if edit_probe["fps_den"] else Fraction(30, 1),
            source_width=edit_probe["width"],
            source_height=edit_probe["height"],
        )

        edit_key = asset_paths.edit_source()
        _upload_s3(s3, settings.assets_bucket, edit_key, edit_path, "video/mp4")
        preview_key = asset_paths.preview_source()
        _upload_s3(s3, settings.assets_bucket, preview_key, preview_path, "video/mp4")
        _job_progress(job, store, 45, "running", "Generating timeline thumbnails")

        thumbs_dir = td_path / "thumbs"
        thumbs = generate_thumbnail_strip(str(edit_path), str(thumbs_dir), fps=1, width=320)
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


def _parse_kling_output_url(payload: dict[str, Any]) -> str:
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
    raise RuntimeError(f"Kling completion payload missing output URL: {payload}")


def _wait_kling_complete(
    api_key: str,
    *,
    task_uuid: str,
    timeout_sec: int = 1800,
) -> dict[str, Any]:
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


def _edge_refine_mask(
    *,
    mask: Image.Image,
    source: Image.Image,
    enabled: bool,
    strength: float,
    radius_px: int,
    grow_px: int,
) -> Image.Image:
    refined = _grow_or_shrink_mask(mask.convert("L"), grow_px)
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


def _normalize_full_variant(*, source_bytes: bytes, variant_bytes: bytes) -> bytes:
    source = ImageOps.exif_transpose(Image.open(BytesIO(source_bytes))).convert("RGBA")
    variant = ImageOps.exif_transpose(Image.open(BytesIO(variant_bytes))).convert("RGBA")
    if variant.size != source.size:
        variant = ImageOps.fit(
            variant,
            source.size,
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    out = BytesIO()
    variant.save(out, format="PNG")
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
    gemini_key = secrets["GEMINI_API_KEY"]

    _job_progress(job, store, 10, "running", "Loading source frame")
    src_bytes = asset_store.read_bytes(source_key)
    src_image = ImageOps.exif_transpose(Image.open(BytesIO(src_bytes))).convert("RGBA")
    _job_progress(job, store, 30, "running", "Calling Gemini edit")
    out_bytes = generate_image_edit(
        api_key=gemini_key,
        model=payload["model"],
        prompt=payload["prompt"],
        input_image_bytes=src_bytes,
    )
    normalized_bytes = _normalize_full_variant(source_bytes=src_bytes, variant_bytes=out_bytes)
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
            "sourceKey": source_key,
            "sourceVariantId": payload.get("sourceVariantId"),
            "inputResolution": {"width": src_image.width, "height": src_image.height},
            "outputResolution": {"width": normalized_image.width, "height": normalized_image.height},
        },
    }
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
    gemini_key = secrets["GEMINI_API_KEY"]

    source_key = payload.get("sourceKey") or frame["captureKey"]
    source_variant_id = payload.get("sourceVariantId")
    source_bytes = asset_store.read_bytes(source_key)
    patch_bytes = asset_store.read_bytes(payload["patchKey"])
    mask_bytes = asset_store.read_bytes(payload["maskKey"]) if payload.get("maskKey") else None
    source_image = ImageOps.exif_transpose(Image.open(BytesIO(source_bytes))).convert("RGBA")
    patch_source_image = ImageOps.exif_transpose(Image.open(BytesIO(patch_bytes))).convert("RGBA")
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
        _job_progress(job, store, 30, "running", "Calling Gemini patch edit")
        edited_patch = generate_image_edit(
            api_key=gemini_key,
            model="nano_banana_pro",
            prompt=payload["prompt"],
            input_image_bytes=patch_bytes,
            mask_image_bytes=refined_mask_bytes,
        )

    variant_id = new_id("var")
    paths = _asset_paths(task)
    patch_only_key = paths.frame_patch(frame_id, variant_id)
    asset_store.put_bytes(patch_only_key, edited_patch, content_type="image/png")

    _job_progress(job, store, 70, "running", "Compositing patch output")
    composited = _composite_patch(
        base_bytes=source_bytes,
        patch_bytes=edited_patch,
        rect=payload["patchRect"],
        bleed_px=payload["bleedPx"],
        feather_px=payload["featherPx"],
        mask_bytes=refined_mask_bytes,
    )
    composited_image = ImageOps.exif_transpose(Image.open(BytesIO(composited))).convert("RGBA")

    output_key = paths.frame_variant(frame_id, variant_id)
    asset_store.put_bytes(output_key, composited, content_type="image/png")

    generation_settings: dict[str, Any] = {
        "provider": provider_name,
        "workflow": "patch",
        "sourceKey": source_key,
        "sourceVariantId": source_variant_id,
        "inputResolution": {"width": patch_source_image.width, "height": patch_source_image.height},
        "outputResolution": {"width": composited_image.width, "height": composited_image.height},
        "compositedResolution": {"width": source_image.width, "height": source_image.height},
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
            "patchRect": payload["patchRect"],
            "featherPx": payload["featherPx"],
            "bleedPx": payload["bleedPx"],
            "maskKey": payload.get("maskKey"),
            "patchOnlyKey": patch_only_key,
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
    segment_key: str | None = None
    if model_name in {"ray-2", "ray-flash-2", "runway-aleph"}:
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
    end_variant_id = end_frame.get("selectedVariantId")
    source_last_variant_id: str | None = None
    if end_variant_id:
        end_variant = next((v for v in end_frame.get("variants", []) if v["variantId"] == end_variant_id), None)
        if end_variant:
            last_frame_key = end_variant["outputKey"]
            source_last_variant_id = end_variant_id

    fps_info = task["video"]["editSource"]["fps"]
    fps = Fraction(int(fps_info["num"]), int(fps_info["den"]))
    src_width = int(task["video"]["editSource"]["width"])
    src_height = int(task["video"]["editSource"]["height"])

    media_key_for_provider: str | None = None
    first_frame_input_key: str | None = None
    last_frame_input_key: str | None = None
    provider_media_width: int | None = None
    provider_media_height: int | None = None
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        if segment_key:
            local_segment_source = td_path / "segment_full.mp4"
            _download_s3(s3, settings.assets_bucket, segment_key, local_segment_source)

            if model_name == "runway-aleph":
                _job_progress(job, store, 20, "running", "Preparing Runway Aleph input clip")
                local_provider_segment = td_path / "segment_runway.mp4"
                runway_w, runway_h, _ = _transcode_with_size_limit(
                    input_path=str(local_segment_source),
                    output_path=str(local_provider_segment),
                    fps=fps,
                    source_width=src_width,
                    source_height=src_height,
                    landscape_target=(1280, 720),
                    portrait_target=(720, 1280),
                    max_bytes=RUNWAY_VIDEO_MAX_BYTES,
                )
                provider_media_width = runway_w
                provider_media_height = runway_h
                media_key_for_provider = paths.segment_provider_input(segment_id, gen_id, "runway")
                _upload_s3(s3, settings.assets_bucket, media_key_for_provider, local_provider_segment, "video/mp4")
            else:
                source_size = local_segment_source.stat().st_size
                if source_size > FULL_VIDEO_MAX_BYTES:
                    _job_progress(job, store, 20, "running", "Optimizing segment clip to provider size limits")
                    local_provider_segment = td_path / "segment_luma.mp4"
                    luma_w, luma_h, _ = _transcode_with_size_limit(
                        input_path=str(local_segment_source),
                        output_path=str(local_provider_segment),
                        fps=fps,
                        source_width=src_width,
                        source_height=src_height,
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
                    provider_media_width = src_width
                    provider_media_height = src_height

        frame_bytes = asset_store.read_bytes(first_frame_key)
        first_target_w, first_target_h = _target_by_orientation(
            src_width,
            src_height,
            landscape=(1280, 768) if model_name == "runway-gen4.5" else ((1280, 720) if model_name == "runway-aleph" else (1920, 1080)),
            portrait=(768, 1280) if model_name == "runway-gen4.5" else ((720, 1280) if model_name == "runway-aleph" else (1080, 1920)),
        )
        prepared_first_frame = _prepare_first_frame_image_bytes(
            frame_bytes,
            target_width=first_target_w,
            target_height=first_target_h,
            max_bytes=MAX_PROVIDER_IMAGE_BYTES,
        )
        local_first_frame = td_path / "first_frame.jpg"
        local_first_frame.write_bytes(prepared_first_frame)
        first_frame_input_key = paths.segment_provider_first_frame(
            segment_id,
            gen_id,
            "runway" if model_name in {"runway-aleph", "runway-gen4.5"} else ("kling" if model_name == "kling-2.6" else "luma"),
        )
        _upload_s3(s3, settings.assets_bucket, first_frame_input_key, local_first_frame, "image/jpeg")

        if model_name == "kling-2.6":
            last_frame_bytes = asset_store.read_bytes(last_frame_key)
            prepared_last_frame = _prepare_first_frame_image_bytes(
                last_frame_bytes,
                target_width=first_target_w,
                target_height=first_target_h,
                max_bytes=MAX_PROVIDER_IMAGE_BYTES,
            )
            local_last_frame = td_path / "last_frame.jpg"
            local_last_frame.write_bytes(prepared_last_frame)
            last_frame_input_key = paths.segment_provider_last_frame(segment_id, gen_id, "kling")
            _upload_s3(s3, settings.assets_bucket, last_frame_input_key, local_last_frame, "image/jpeg")

    media_url = asset_store.presign_get(media_key_for_provider, expires=3600) if media_key_for_provider else None
    first_frame_url = asset_store.presign_get(first_frame_input_key, expires=3600)
    last_frame_url = asset_store.presign_get(last_frame_input_key, expires=3600) if last_frame_input_key else None

    secrets = load_secret(settings.secrets_arn)

    used_provider_model: str | None = None
    provider_duration_sec: float | None = None
    if model_name == "runway-aleph":
        runway_key = secrets["RUNWAY_API_KEY"]
        with tempfile.TemporaryDirectory() as runway_td:
            runway_input = Path(runway_td) / "runway_input.mp4"
            _download_s3(s3, settings.assets_bucket, media_key_for_provider, runway_input)
            upload_created = create_ephemeral_upload(api_key=runway_key, filename=runway_input.name)
            upload_url = upload_created.get("uploadUrl")
            upload_fields = upload_created.get("fields")
            runway_uri = upload_created.get("url") or upload_created.get("runwayUri")
            if not isinstance(upload_url, str) or not isinstance(upload_fields, dict) or not isinstance(runway_uri, str):
                raise RuntimeError(f"Unexpected Runway upload response: {upload_created}")
            upload_to_ephemeral(
                upload_url=upload_url,
                fields=upload_fields,
                file_path=runway_input,
                content_type="video/mp4",
            )
        _job_progress(job, store, 35, "running", "Creating Runway Aleph generation")
        created = create_video_to_video(
            api_key=runway_key,
            video_uri=runway_uri,
            prompt_text=payload.get("prompt"),
            first_frame_uri=first_frame_url,
        )
        used_provider_model = "gen4_aleph"
        generation_id = created.get("id")
        if not generation_id:
            raise RuntimeError(f"Unexpected Runway create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Runway generation")
        result = _wait_runway_complete(runway_key, generation_id)
        out_url = _parse_runway_output_url(result)
        provider_name = "runway"
    elif model_name == "runway-gen4.5":
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
            end_image_url=last_frame_url or first_frame_url,
            duration_seconds=kling_duration,
            prompt=payload.get("prompt"),
            width=first_target_w,
            height=first_target_h,
        )
        generation_id = created.get("taskUUID")
        if not isinstance(generation_id, str):
            raise RuntimeError(f"Unexpected Kling create response: {created}")
        _job_progress(job, store, 55, "running", "Polling Kling generation")
        result = _wait_kling_complete(
            kling_key,
            task_uuid=generation_id,
        )
        out_url = _parse_kling_output_url(result)
        provider_name = "kling"
        used_provider_model = "kling-video@2.6-pro"
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
                "mode": payload["mode"],
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
            "sourceLastFrameCaptureKey": end_frame.get("captureKey"),
            "sourceLastFrameVariantId": source_last_variant_id,
            "sourceLastFrameResolvedKey": last_frame_key,
            "requestedDurationSec": round(segment_duration_sec, 3),
            "providerDurationSec": provider_duration_sec,
            "generationSettings": {
                "provider": provider_name,
                "requestedModel": model_name,
                "model": used_provider_model or model_name,
                "mode": payload["mode"],
                "firstFrameResolution": {"width": first_target_w, "height": first_target_h},
                "mediaResolution": (
                    {"width": provider_media_width, "height": provider_media_height}
                    if provider_media_width and provider_media_height
                    else None
                ),
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
    selected = payload["selectedSegmentGenerationIds"]
    feather_frames = int(payload.get("temporalFeatherFrames", 0))
    paths = _asset_paths(task)

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

            cmd = merge_with_segment_replacement(
                str(current_path),
                str(seg_path),
                str(out_path),
                start_frame=segment["startFrame"],
                end_frame_exclusive=segment["endFrameExclusive"],
                fps_num=task["video"]["editSource"]["fps"]["num"],
                fps_den=task["video"]["editSource"]["fps"]["den"],
                output_width=int(task["video"]["editSource"]["width"]),
                output_height=int(task["video"]["editSource"]["height"]),
                temporal_feather_frames=feather_frames,
            )
            applied.append(
                {
                    "segmentId": segment["segmentId"],
                    "generationId": gen_id,
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
        else:
            raise RuntimeError(f"Unsupported job type: {job['type']}")
    except Exception as exc:
        logger.exception("Job failed", extra={"jobId": job_id, "taskId": task_id, "userId": user_id})
        job["status"] = "failed"
        job["error"] = str(exc)
        job["finishedAt"] = now_iso()
        store.save_job(job)
        task["status"] = "error"
        task.setdefault("history", []).append({"at": now_iso(), "event": "job.failed", "jobId": job_id})
        store.save_task(task)
        raise
    else:
        job["finishedAt"] = now_iso()
        store.save_job(job)
        if task.get("status") == "error":
            task["status"] = "ready" if task.get("video", {}).get("editSource", {}).get("s3Key") else "created"
            task.setdefault("history", []).append({"at": now_iso(), "event": "task.recovered", "jobId": job_id})
            store.save_task(task)
