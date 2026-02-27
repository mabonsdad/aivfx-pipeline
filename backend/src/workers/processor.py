from __future__ import annotations

import json
import hashlib
import math
import shutil
import tempfile
import time
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from typing import Any

import boto3
from PIL import Image, ImageFilter
from aws_lambda_powertools import Logger

from src.core.assets import AssetPaths, AssetStore
from src.core.ffmpeg import (
    extract_segment_by_frames,
    ffprobe_video,
    generate_thumbnail_strip,
    merge_with_segment_replacement,
    transcode_to_cfr,
)
from src.core.ids import new_id, prompt_hash
from src.core.secrets import load_secret
from src.core.store import S3JsonStore, now_iso
from src.integrations.gemini import generate_image_edit
from src.integrations.luma import create_modify_generation, get_generation

logger = Logger()


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
    asset_paths = AssetPaths(user_id=task["userId"], task_id=task["taskId"])

    original_key = task["video"]["original"]["s3Key"]
    _job_progress(job, store, 5, "running", "Downloading source video")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        original_path = td_path / "original.mp4"
        edit_path = td_path / "edit.mp4"

        _download_s3(s3, settings.assets_bucket, original_key, original_path)
        with open(original_path, "rb") as src_file:
            sha = hashlib.sha256()
            for chunk in iter(lambda: src_file.read(8 * 1024 * 1024), b""):
                sha.update(chunk)
            task["video"]["original"]["sha256"] = sha.hexdigest()

        probe = ffprobe_video(str(original_path))
        fps = Fraction(probe["fps_num"], probe["fps_den"])
        if probe["is_vfr_input"]:
            _job_progress(job, store, 15, "running", "Converting VFR to CFR mezzanine")
            transcode_to_cfr(str(original_path), str(edit_path), fps if fps.numerator else Fraction(30, 1))
            edit_probe = ffprobe_video(str(edit_path))
        else:
            shutil.copy2(original_path, edit_path)
            edit_probe = probe

        edit_key = asset_paths.edit_source()
        _upload_s3(s3, settings.assets_bucket, edit_key, edit_path, "video/mp4")
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
    capture_key = frame["captureKey"]
    secrets = load_secret(settings.secrets_arn)
    gemini_key = secrets["GEMINI_API_KEY"]

    _job_progress(job, store, 10, "running", "Loading source frame")
    src_bytes = asset_store.read_bytes(capture_key)
    _job_progress(job, store, 30, "running", "Calling Gemini edit")
    out_bytes = generate_image_edit(
        api_key=gemini_key,
        model=payload["model"],
        prompt=payload["prompt"],
        input_image_bytes=src_bytes,
    )

    variant_id = new_id("var")
    paths = AssetPaths(task["userId"], task["taskId"])
    output_key = paths.frame_variant(frame_id, variant_id)
    asset_store.put_bytes(output_key, out_bytes, content_type="image/png")

    variant = {
        "variantId": variant_id,
        "type": "full",
        "model": payload["model"],
        "promptHash": prompt_hash(payload["prompt"]),
        "createdAt": now_iso(),
        "outputKey": output_key,
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

    capture_bytes = asset_store.read_bytes(frame["captureKey"])
    patch_bytes = asset_store.read_bytes(payload["patchKey"])
    mask_bytes = asset_store.read_bytes(payload["maskKey"]) if payload.get("maskKey") else None

    _job_progress(job, store, 30, "running", "Calling Gemini patch edit")
    edited_patch = generate_image_edit(
        api_key=gemini_key,
        model=payload["model"],
        prompt=payload["prompt"],
        input_image_bytes=patch_bytes,
    )

    variant_id = new_id("var")
    paths = AssetPaths(task["userId"], task["taskId"])
    patch_only_key = paths.frame_patch(frame_id, variant_id)
    asset_store.put_bytes(patch_only_key, edited_patch, content_type="image/png")

    _job_progress(job, store, 70, "running", "Compositing patch output")
    composited = _composite_patch(
        base_bytes=capture_bytes,
        patch_bytes=edited_patch,
        rect=payload["patchRect"],
        bleed_px=payload["bleedPx"],
        feather_px=payload["featherPx"],
        mask_bytes=mask_bytes,
    )

    output_key = paths.frame_variant(frame_id, variant_id)
    asset_store.put_bytes(output_key, composited, content_type="image/png")

    variant = {
        "variantId": variant_id,
        "type": "patch",
        "model": payload["model"],
        "promptHash": prompt_hash(payload["prompt"]),
        "createdAt": now_iso(),
        "outputKey": output_key,
        "patchMeta": {
            "patchRect": payload["patchRect"],
            "featherPx": payload["featherPx"],
            "bleedPx": payload["bleedPx"],
            "maskKey": payload.get("maskKey"),
            "patchOnlyKey": patch_only_key,
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

    paths = AssetPaths(task["userId"], task["taskId"])
    s3 = boto3.client("s3")
    segment_key = _ensure_segment_clip(
        s3=s3,
        asset_store=asset_store,
        asset_paths=paths,
        task=task,
        segment=segment,
        assets_bucket=settings.assets_bucket,
    )

    frame_id = segment["startFrameId"]
    frame = task["frames"][frame_id]
    first_frame_key = frame["captureKey"]
    variant_id = payload.get("firstFrameVariantId") or frame.get("selectedVariantId")
    if variant_id:
        variant = next((v for v in frame.get("variants", []) if v["variantId"] == variant_id), None)
        if variant:
            first_frame_key = variant["outputKey"]

    media_url = asset_store.presign_get(segment_key, expires=3600)
    first_frame_url = asset_store.presign_get(first_frame_key, expires=3600)

    secrets = load_secret(settings.secrets_arn)
    luma_key = secrets["LUMA_API_KEY"]

    _job_progress(job, store, 20, "running", "Creating Luma modify generation")
    created = create_modify_generation(
        api_key=luma_key,
        media_url=media_url,
        first_frame_url=first_frame_url,
        mode=payload["mode"],
        model=payload["lumaModel"],
        prompt=payload.get("prompt"),
    )
    generation_id = created.get("id") or created.get("generation_id")
    if not generation_id:
        raise RuntimeError(f"Unexpected Luma create response: {created}")

    _job_progress(job, store, 45, "running", "Polling Luma generation")
    result = _wait_luma_complete(luma_key, generation_id)
    out_url = _parse_luma_output_url(result)

    out_key = paths.segment_generated(segment_id, gen_id)
    _job_progress(job, store, 75, "running", "Downloading Luma output to S3")
    asset_store.download_url_to_s3(out_url, out_key)

    gen_meta = task.setdefault("segmentGenerations", {}).setdefault(gen_id, {})
    gen_meta.update(
        {
            "genId": gen_id,
            "segmentId": segment_id,
            "luma": {
                "model": payload["lumaModel"],
                "mode": payload["mode"],
                "prompt": payload.get("prompt"),
                "lumaGenerationId": generation_id,
            },
            "status": "complete",
            "outputKey": out_key,
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
    paths = AssetPaths(task["userId"], task["taskId"])

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
    asset_store = AssetStore(settings.assets_bucket)

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
