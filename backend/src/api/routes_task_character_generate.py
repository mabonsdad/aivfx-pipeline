from __future__ import annotations

from io import BytesIO
from typing import Any, Callable

from PIL import Image, ImageOps

from src.models.schemas import CharacterAnimateGenerateRequest


def _find_segment(task: dict[str, Any], segment_id: str) -> dict[str, Any] | None:
    return next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)


def _provider_for_character_model(model: str) -> str:
    if model == "runway_act_two":
        return "runway"
    if model == "kling_v3_motion_control":
        return "replicate"
    if model == "omnihuman_v1_5":
        return "fal"
    if model == "seedance_2_0_reference_to_video":
        return "fal"
    return "unknown"


def _validate_character_model_mode(req: CharacterAnimateGenerateRequest) -> str | None:
    if req.mode == "pose_video" and req.model not in {"runway_act_two", "kling_v3_motion_control", "seedance_2_0_reference_to_video"}:
        return "The selected model does not support character image + pose video mode"
    if req.mode == "audio_driven" and req.model not in {"omnihuman_v1_5", "seedance_2_0_reference_to_video"}:
        return "The selected model does not support character image + audio mode"
    return None


def _runway_character_image_validation_error(reference: dict[str, Any], asset_store) -> str | None:
    key = str(reference.get("key") or "").strip()
    if not key:
        return "Character image not found"
    image_bytes = asset_store.read_bytes(key)
    with Image.open(BytesIO(image_bytes)) as raw_image:
        image = ImageOps.exif_transpose(raw_image)
        width, height = image.size
    if width <= 0 or height <= 0:
        return "Character image dimensions are invalid"
    reference["width"] = int(width)
    reference["height"] = int(height)
    ratio = width / height
    if ratio < 0.5:
        return (
            "Runway Act-Two requires the selected character image to be at least half as wide as it is tall "
            f"(width / height >= 0.5). The selected image is {width}x{height} ({ratio:.3f})."
        )
    return None


def handle_task_character_generate_routes(
    method: str,
    *,
    task_id: str,
    parts: list[str],
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    task: dict[str, Any],
    store,
    asset_store,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
    sanitize_prompt_fn: Callable[[str], str],
) -> dict[str, Any] | None:
    if method != "POST" or len(parts) != 5 or parts[2] != "segments" or parts[4] != "character-generate":
        return None

    if str(task.get("workflowId") or "source_video_flow") != "character_animate_workflow":
        return error_response_fn(409, "Character animation generation is only available on character workflow tasks", origin=origin)

    segment_id = parts[3]
    segment = _find_segment(task, segment_id)
    if not isinstance(segment, dict):
        return error_response_fn(404, "Segment not found", origin=origin)

    req = json_model(CharacterAnimateGenerateRequest, event)
    model_mode_error = _validate_character_model_mode(req)
    if model_mode_error:
        return error_response_fn(400, model_mode_error, origin=origin)
    source_media_kind = str(task.get("sourceMedia", {}).get("kind") or task.get("video", {}).get("editSource", {}).get("mediaType") or "video")
    if req.mode == "pose_video" and source_media_kind != "video":
        return error_response_fn(400, "Character image + pose video requires a video source upload", origin=origin)

    duration_sec = float(segment.get("durationSec") or 0.0)
    if req.model == "runway_act_two" and duration_sec > 30.0 + 1e-6:
        return error_response_fn(400, "Runway Act-Two supports a maximum selected range of 30 seconds", origin=origin)
    if req.model == "kling_v3_motion_control":
        kling_orientation = req.klingCharacterOrientation or "image"
        max_duration = 30.0 if kling_orientation == "video" else 10.0
        if duration_sec > max_duration + 1e-6:
            return error_response_fn(
                400,
                f"Kling 3.0 Motion Control supports a maximum selected range of {int(max_duration)} seconds with {kling_orientation} orientation",
                origin=origin,
            )
    if req.model == "omnihuman_v1_5":
        omnihuman_resolution = req.omnihumanResolution or "720p"
        max_duration = 30.0 if omnihuman_resolution == "1080p" else 60.0
        if duration_sec > max_duration + 1e-6:
            return error_response_fn(
                400,
                f"OmniHuman v1.5 supports a maximum selected range of {int(max_duration)} seconds at {omnihuman_resolution}",
                origin=origin,
            )
    if req.model == "seedance_2_0_reference_to_video":
        if req.mode == "pose_video" and (duration_sec < 2.0 - 1e-6 or duration_sec > 15.0 + 1e-6):
            return error_response_fn(400, "Seedance 2.0 requires a selected motion-video range between 2 and 15 seconds", origin=origin)
        if req.mode == "audio_driven" and duration_sec > 15.0 + 1e-6:
            return error_response_fn(400, "Seedance 2.0 supports a maximum selected audio range of 15 seconds", origin=origin)

    reference_lookup: dict[str, dict[str, Any]] = {
        str(item.get("referenceId")): item
        for item in task.get("editVideoReferences", [])
        if isinstance(item, dict) and item.get("referenceId")
    }
    reference = reference_lookup.get(req.characterReferenceId)
    if not isinstance(reference, dict) or not str(reference.get("key") or "").strip():
        return error_response_fn(404, "Character image not found", origin=origin)
    if req.model == "runway_act_two":
        try:
            runway_character_error = _runway_character_image_validation_error(reference, asset_store)
        except Exception:
            return error_response_fn(400, "Unable to inspect the selected character image for Runway Act-Two", origin=origin)
        if runway_character_error:
            return error_response_fn(400, runway_character_error, origin=origin)

    prompt: str | None = None
    if req.prompt:
        try:
            prompt = sanitize_prompt_fn(req.prompt)
        except ValueError as exc:
            return error_response_fn(400, str(exc), origin=origin)

    gen_id = new_id_fn("gen")
    provider_name = _provider_for_character_model(req.model)
    ratio = req.outputAspectRatio or "1280:720"
    omnihuman_resolution = req.omnihumanResolution or "720p"
    kling_mode = req.klingMode or "pro"
    kling_character_orientation = req.klingCharacterOrientation or "image"
    seedance_resolution = req.seedanceResolution or "720p"
    seedance_aspect_ratio = req.seedanceAspectRatio or "auto"
    job_id = queue_job_fn(
        store=store,
        user_id=user_id,
        task_id=task_id,
        job_type="segment_generate",
        payload={
            "segmentId": segment_id,
            "genId": gen_id,
            "lumaModel": req.model,
            "mode": req.mode,
            "prompt": prompt,
            "characterAnimateMetadata": {
                "workflowId": "character_animate_workflow",
                "mode": req.mode,
                "model": req.model,
                "characterReferenceId": req.characterReferenceId,
                "outputAspectRatio": ratio,
                "bodyControl": bool(req.bodyControl),
                "expressionIntensity": int(req.expressionIntensity),
                "omnihumanResolution": omnihuman_resolution,
                "klingMode": kling_mode,
                "klingCharacterOrientation": kling_character_orientation,
                "seedanceResolution": seedance_resolution,
                "seedanceAspectRatio": seedance_aspect_ratio,
                "prompt": prompt,
            },
        },
    )
    now = now_iso_fn()
    task.setdefault("segmentGenerations", {})[gen_id] = {
        "genId": gen_id,
        "segmentId": segment_id,
        "luma": {
            "provider": provider_name,
            "model": req.model,
            "mode": req.mode,
            "prompt": prompt,
            "negativePrompt": None,
            "lumaGenerationId": None,
        },
        "characterAnimation": {
            "workflowId": "character_animate_workflow",
            "mode": req.mode,
            "model": req.model,
            "characterReferenceId": req.characterReferenceId,
            "outputAspectRatio": ratio if req.mode == "pose_video" else None,
            "omnihumanResolution": omnihuman_resolution if req.mode == "audio_driven" else None,
            "klingMode": kling_mode if req.model == "kling_v3_motion_control" else None,
            "klingCharacterOrientation": kling_character_orientation if req.model == "kling_v3_motion_control" else None,
            "seedanceResolution": seedance_resolution if req.model == "seedance_2_0_reference_to_video" else None,
            "seedanceAspectRatio": seedance_aspect_ratio if req.model == "seedance_2_0_reference_to_video" else None,
            "bodyControl": bool(req.bodyControl) if req.mode == "pose_video" else None,
            "expressionIntensity": int(req.expressionIntensity) if req.mode == "pose_video" else None,
            "prompt": prompt,
        },
        "generationSettings": {
            "workflowId": "character_animate_workflow",
            "characterMode": req.mode,
            "characterReferenceId": req.characterReferenceId,
            "outputAspectRatio": ratio if req.mode == "pose_video" else None,
            "omnihumanResolution": omnihuman_resolution if req.mode == "audio_driven" else None,
            "klingMode": kling_mode if req.model == "kling_v3_motion_control" else None,
            "klingCharacterOrientation": kling_character_orientation if req.model == "kling_v3_motion_control" else None,
            "seedanceResolution": seedance_resolution if req.model == "seedance_2_0_reference_to_video" else None,
            "seedanceAspectRatio": seedance_aspect_ratio if req.model == "seedance_2_0_reference_to_video" else None,
            "bodyControl": bool(req.bodyControl) if req.mode == "pose_video" else None,
            "expressionIntensity": int(req.expressionIntensity) if req.mode == "pose_video" else None,
            "requestedDurationSec": round(duration_sec, 3),
        },
        "origin": {
            "workflowId": "character_animate_workflow",
            "stepOrigin": "generate",
            "toolOrigin": "character_generate",
            "creationMode": req.mode,
        },
        "status": "queued",
        "outputKey": None,
        "posterKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now,
        "createdAt": now,
        "updatedAt": now,
    }
    task.setdefault("history", []).append(
        {
            "at": now,
            "event": "character_animation.queued",
            "jobId": job_id,
            "genId": gen_id,
            "segmentId": segment_id,
            "model": req.model,
            "mode": req.mode,
        }
    )
    store.save_task(task, merge_on_conflict=True)
    return response_fn(202, {"jobId": job_id, "genId": gen_id}, origin=origin)
