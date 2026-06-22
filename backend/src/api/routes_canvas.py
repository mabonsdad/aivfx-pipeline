"""Canvas-workflow standalone routes.

Not tied to a video task/segment. The caller is already Cognito-authenticated by the
time the handler runs. Reuses shared helpers rather than inventing new shapes.

POST /canvas/prompt-wizard rewrites a lookdev / image draft prompt via the shared
OpenAI engine. Its system prompt (the "brain") is loaded from the editable
`admin/canvas_prompt_profiles.json` config, so it can be improved without a redeploy.
"""

from __future__ import annotations

import json
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Annotated, Any, Callable

from pydantic import BaseModel, Field

from src.core.asset_origin import build_asset_origin
from src.core.cost_tracking import build_usage_record, estimate_cost_from_pricing_entry
from src.core.ffmpeg import extract_audio_segment, extract_frame_png, ffprobe_audio, ffprobe_video, trim_video_segment

# A reference image may be a remote URL or an inline base64 data URL (data:image/...).
# Base64 data URLs are large, so the cap is generous; the frontend is expected to
# downscale before encoding to keep the request payload within Lambda's limit.
ReferenceImage = Annotated[str, Field(min_length=1, max_length=2_000_000)]


class CanvasPromptWizardRequest(BaseModel):
    user_draft_prompt: str = Field(min_length=1, max_length=4000)
    profile: str = Field(default="lookdev", min_length=1, max_length=80)
    user_visible_model_name: str = Field(default="Lookdev", min_length=1, max_length=120)
    aspect_ratio: str | None = Field(default=None, max_length=16)
    # Single reference (kept for backward compatibility) and a multi-image list.
    # Both accept a remote URL or an inline base64 data URL. They are merged, the
    # single one first, before being handed to the wizard.
    reference_image_url: ReferenceImage | None = Field(default=None)
    reference_image_urls: list[ReferenceImage] = Field(default_factory=list, max_length=4)


class CanvasMediaProbeRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=1024)


class CanvasMediaExtractFrameRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=1024)
    frameIndex: int | None = Field(default=None, ge=0)
    timeSec: float | None = Field(default=None, ge=0.0)
    outputWidth: int | None = Field(default=None, ge=1, le=8192)
    outputHeight: int | None = Field(default=None, ge=1, le=8192)


class CanvasMediaTrimRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=1024)
    startSec: float = Field(ge=0.0)
    durationSec: float = Field(gt=0.0, le=600.0)
    targetFps: float | None = Field(default=None, gt=0.0, le=120.0)
    targetWidth: int | None = Field(default=None, ge=1, le=8192)
    targetHeight: int | None = Field(default=None, ge=1, le=8192)
    resizeMode: str = Field(default="pad", max_length=16)


def _canvas_path_parts(path: str) -> list[str]:
    return [part for part in str(path or "").split("/") if part]


def _load_canvas_task_or_404(store, user_id: str, task_id: str) -> dict[str, Any] | None:
    task = store.load_task(user_id, task_id)
    if isinstance(task, dict) and not task.get("deletedAt"):
        return task
    return None


def _canvas_validate_task_asset(
    *,
    task: dict[str, Any],
    asset_key: str,
    asset_store,
    error_response_fn: Callable[..., dict[str, Any]],
    origin: str | None,
) -> tuple[dict[str, Any], str] | tuple[dict[str, Any], None]:
    task_prefix = f"users/{task['userId']}/tasks/{task['taskId']}/"
    normalized_key = str(asset_key or "").strip()
    if not normalized_key.startswith(task_prefix):
        return error_response_fn(400, "Asset key is outside this task", origin=origin), None
    try:
        head = asset_store.head_object(normalized_key)
    except Exception:
        return error_response_fn(404, "Asset not found", origin=origin), None
    return head, normalized_key


def _canvas_register_media_asset(
    *,
    task: dict[str, Any],
    store,
    asset_store,
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    operation: str,
    source_key: str,
    output_filename: str,
    output_bytes: bytes,
    content_type: str,
    media_kind: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    asset_id = new_id_fn("canvasmedia")
    output_key = asset_paths_for_task_fn(task).canvas_media_asset(asset_id, output_filename)
    asset_store.put_bytes(output_key, output_bytes, content_type=content_type)
    now = now_iso_fn()
    record = {
        "assetId": asset_id,
        "operation": operation,
        "mediaKind": media_kind,
        "sourceKey": source_key,
        "outputKey": output_key,
        "filename": output_filename,
        "contentType": content_type,
        "createdAt": now,
        "updatedAt": now,
        "metadata": metadata,
        "origin": build_asset_origin(
            workflow_id=str(task.get("workflowId") or "canvas_workflow"),
            step_origin="canvas_media",
            tool_origin=operation,
            app_surface="canvas_workflow",
        ),
    }
    task.setdefault("canvasMediaAssets", []).append(record)
    task.setdefault("history", []).append(
        {
            "at": now,
            "event": "canvas.media.created",
            "assetId": asset_id,
            "operation": operation,
            "sourceKey": source_key,
            "outputKey": output_key,
        }
    )
    store.save_task(task, merge_on_conflict=True)
    payload = json.loads(json.dumps(record))
    if isinstance(payload.get("outputKey"), str):
        payload["outputUrl"] = asset_store.presign_get(payload["outputKey"])
    return payload


def handle_canvas_routes(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    claims: dict[str, Any],
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    store,
    asset_store,
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    get_openai_api_key_fn: Callable[[], str],
    get_canvas_system_prompt_fn: Callable[[str], str | None],
    get_openai_pricing_entry_fn: Callable[[str], dict[str, Any] | None],
    get_openai_pricing_rates_fn: Callable[[str], dict[str, float] | None],
    improve_lookdev_prompt_fn: Callable[..., dict[str, Any]],
    logger,
) -> dict[str, Any] | None:
    path_parts = _canvas_path_parts(path)

    if method == "POST" and path == "/canvas/prompt-wizard":
        req = json_model(CanvasPromptWizardRequest, event)
        draft_prompt = req.user_draft_prompt.strip()
        if not draft_prompt:
            return error_response_fn(400, "Prompt is required", origin=origin)

        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for the lookdev prompt wizard", origin=origin)

        # Load the brain (system prompt) from the editable server-side profile config.
        # Falls back to the built-in default inside improve_lookdev_prompt if absent.
        system_prompt = get_canvas_system_prompt_fn(req.profile)
        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")

        # Merge the single + list reference images into one ordered list (single first).
        reference_images = ([req.reference_image_url] if req.reference_image_url else []) + list(
            req.reference_image_urls
        )

        try:
            result, usage = improve_lookdev_prompt_fn(
                api_key=openai_api_key,
                user_draft_prompt=draft_prompt,
                user_visible_model_name=req.user_visible_model_name,
                aspect_ratio=req.aspect_ratio,
                reference_image_urls=reference_images,
                system_prompt=system_prompt,
                pricing_rates=pricing_rates,
            )
        except Exception as exc:
            logger.warning("Lookdev prompt wizard failed", extra={"userId": user_id, "error": str(exc)})
            return error_response_fn(502, str(exc), origin=origin)
        try:
            timestamp = now_iso_fn()
            estimate = estimate_cost_from_pricing_entry(pricing_entry, usage=usage)
            usage_record = build_usage_record(
                usage_record_id=new_id_fn("usage"),
                now_iso=timestamp,
                user_id=user_id,
                provider="openai",
                provider_model="gpt-5.5",
                app_model_id="gpt-5.5",
                request_type="prompt_rewrite",
                source="canvas_prompt_wizard",
                tool_origin="canvas_prompt_wizard",
                workflow_id="canvas_workflow",
                pricing_entry=pricing_entry,
                estimate=estimate,
                notes=f"profile={req.profile}",
            )
            store.save_usage_record(usage_record)
        except Exception as exc:
            logger.warning("Canvas prompt wizard usage tracking failed", extra={"userId": user_id, "error": str(exc)})
        return response_fn(200, {"result": result, "usage": usage}, origin=origin)

    if len(path_parts) == 4 and path_parts[0] == "canvas" and path_parts[2] == "media" and method == "POST":
        task_id = path_parts[1]
        operation = path_parts[3]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)

        if operation == "probe":
            req = json_model(CanvasMediaProbeRequest, event)
            head_or_response, normalized_key = _canvas_validate_task_asset(
                task=task,
                asset_key=req.assetKey,
                asset_store=asset_store,
                error_response_fn=error_response_fn,
                origin=origin,
            )
            if normalized_key is None:
                return head_or_response
            head = head_or_response
            content_type = str(head.get("ContentType") or "")
            with tempfile.TemporaryDirectory() as td:
                source_path = Path(td) / (Path(normalized_key).name or "media.bin")
                asset_store.s3.download_file(asset_store.assets_bucket, normalized_key, str(source_path))
                if content_type.startswith("audio/"):
                    probe = ffprobe_audio(str(source_path))
                    return response_fn(
                        200,
                        {
                            "mediaKind": "audio",
                            "assetKey": normalized_key,
                            "contentType": content_type,
                            "probe": probe,
                        },
                        origin=origin,
                    )
                probe = ffprobe_video(str(source_path))
                return response_fn(
                    200,
                    {
                        "mediaKind": "video",
                        "assetKey": normalized_key,
                        "contentType": content_type,
                        "probe": probe,
                    },
                    origin=origin,
                )

        if operation == "extract-frame":
            req = json_model(CanvasMediaExtractFrameRequest, event)
            head_or_response, normalized_key = _canvas_validate_task_asset(
                task=task,
                asset_key=req.assetKey,
                asset_store=asset_store,
                error_response_fn=error_response_fn,
                origin=origin,
            )
            if normalized_key is None:
                return head_or_response
            head = head_or_response
            content_type = str(head.get("ContentType") or "")
            if not content_type.startswith("video/"):
                return error_response_fn(400, "Frame extraction requires a video asset", origin=origin)
            with tempfile.TemporaryDirectory() as td:
                source_path = Path(td) / (Path(normalized_key).name or "video.mp4")
                output_path = Path(td) / "frame.png"
                asset_store.s3.download_file(asset_store.assets_bucket, normalized_key, str(source_path))
                probe = ffprobe_video(str(source_path))
                fps_value = (
                    float(probe.get("fps_num") or 0) / float(probe.get("fps_den") or 1)
                    if probe.get("fps_num")
                    else 30.0
                )
                frame_count = max(1, int(probe.get("frame_count") or 1))
                requested_frame_index = (
                    int(req.frameIndex)
                    if req.frameIndex is not None
                    else max(0, min(frame_count - 1, int(round(float(req.timeSec or 0.0) * fps_value))))
                )
                frame_index = max(0, min(frame_count - 1, requested_frame_index))
                extract_frame_png(
                    str(source_path),
                    frame_index,
                    str(output_path),
                    output_width=req.outputWidth,
                    output_height=req.outputHeight,
                )
                output_record = _canvas_register_media_asset(
                    task=task,
                    store=store,
                    asset_store=asset_store,
                    asset_paths_for_task_fn=asset_paths_for_task_fn,
                    new_id_fn=new_id_fn,
                    now_iso_fn=now_iso_fn,
                    operation="canvas_extract_frame",
                    source_key=normalized_key,
                    output_filename=f"{Path(source_path).stem or 'frame'}_{frame_index:04d}.png",
                    output_bytes=output_path.read_bytes(),
                    content_type="image/png",
                    media_kind="image",
                    metadata={
                        "frameIndex": frame_index,
                        "requestedFrameIndex": req.frameIndex,
                        "requestedTimeSec": req.timeSec,
                        "sourceProbe": probe,
                    },
                )
                return response_fn(
                    200,
                    {
                        "asset": output_record,
                        "frameIndex": frame_index,
                        "requestedFrameIndex": req.frameIndex,
                    },
                    origin=origin,
                )

        if operation == "trim":
            req = json_model(CanvasMediaTrimRequest, event)
            head_or_response, normalized_key = _canvas_validate_task_asset(
                task=task,
                asset_key=req.assetKey,
                asset_store=asset_store,
                error_response_fn=error_response_fn,
                origin=origin,
            )
            if normalized_key is None:
                return head_or_response
            head = head_or_response
            content_type = str(head.get("ContentType") or "")
            resize_mode = req.resizeMode if req.resizeMode in {"pad", "crop", "scale"} else "pad"
            with tempfile.TemporaryDirectory() as td:
                source_path = Path(td) / (Path(normalized_key).name or "media.bin")
                asset_store.s3.download_file(asset_store.assets_bucket, normalized_key, str(source_path))
                if content_type.startswith("audio/"):
                    output_path = Path(td) / "trimmed.wav"
                    extract_audio_segment(
                        str(source_path),
                        str(output_path),
                        start_sec=float(req.startSec),
                        duration_sec=float(req.durationSec),
                    )
                    probe = ffprobe_audio(str(output_path))
                    output_record = _canvas_register_media_asset(
                        task=task,
                        store=store,
                        asset_store=asset_store,
                        asset_paths_for_task_fn=asset_paths_for_task_fn,
                        new_id_fn=new_id_fn,
                        now_iso_fn=now_iso_fn,
                        operation="canvas_trim_media",
                        source_key=normalized_key,
                        output_filename=f"{Path(source_path).stem or 'audio'}_trim.wav",
                        output_bytes=output_path.read_bytes(),
                        content_type="audio/wav",
                        media_kind="audio",
                        metadata={
                            "startSec": req.startSec,
                            "durationSec": req.durationSec,
                            "probe": probe,
                        },
                    )
                    return response_fn(200, {"asset": output_record, "probe": probe}, origin=origin)
                source_probe = ffprobe_video(str(source_path))
                output_path = Path(td) / "trimmed.mp4"
                target_fps = Fraction.from_float(float(req.targetFps)).limit_denominator(1000) if req.targetFps else None
                trim_video_segment(
                    str(source_path),
                    str(output_path),
                    start_sec=float(req.startSec),
                    duration_sec=float(req.durationSec),
                    target_fps=target_fps,
                    target_width=req.targetWidth,
                    target_height=req.targetHeight,
                    resize_mode=resize_mode,
                )
                output_probe = ffprobe_video(str(output_path))
                output_record = _canvas_register_media_asset(
                    task=task,
                    store=store,
                    asset_store=asset_store,
                    asset_paths_for_task_fn=asset_paths_for_task_fn,
                    new_id_fn=new_id_fn,
                    now_iso_fn=now_iso_fn,
                    operation="canvas_trim_media",
                    source_key=normalized_key,
                    output_filename=f"{Path(source_path).stem or 'video'}_trim.mp4",
                    output_bytes=output_path.read_bytes(),
                    content_type="video/mp4",
                    media_kind="video",
                    metadata={
                        "startSec": req.startSec,
                        "durationSec": req.durationSec,
                        "targetFps": req.targetFps,
                        "targetWidth": req.targetWidth,
                        "targetHeight": req.targetHeight,
                        "resizeMode": resize_mode,
                        "sourceProbe": source_probe,
                        "outputProbe": output_probe,
                    },
                )
                return response_fn(200, {"asset": output_record, "probe": output_probe}, origin=origin)

        return error_response_fn(404, "Canvas media operation not found", origin=origin)

    return None
