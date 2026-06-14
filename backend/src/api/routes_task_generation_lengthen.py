from __future__ import annotations

from typing import Any, Callable

from src.generation.lifecycle import generation_ready_for_post, get_generation
from src.models.schemas import SegmentGenerationLengthenRequest

_ALLOWED_MODELS_BY_INPUT_MODE_AND_DIRECTION = {
    "start_end": {
        "start": frozenset({"ltx-2.3-pro", "seedance-2.0-reference-to-video"}),
        "end": frozenset({"ltx-2.3-pro", "wan2.7-i2v", "veo-3.1", "veo-3.1-fast"}),
    },
    "edit_video": {
        "start": frozenset({"ltx-2.3-pro", "seedance-2.0-reference-to-video"}),
        "end": frozenset({"ltx-2.3-pro", "seedance-2.0-reference-to-video", "veo-3.1", "veo-3.1-fast"}),
    },
}


def _allowed_models_for_request(*, input_mode: str, direction: str) -> frozenset[str]:
    return _ALLOWED_MODELS_BY_INPUT_MODE_AND_DIRECTION.get(input_mode, {}).get(direction, frozenset())


def handle_task_generation_lengthen_route(
    method: str,
    *,
    task_id: str,
    parts: list[str],
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    task: dict[str, Any],
    store,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    now_iso_fn: Callable[[], str],
    queue_segment_generation_record_fn: Callable[..., tuple[str, str]],
) -> dict[str, Any] | None:
    if method != "POST" or len(parts) != 5 or parts[2] != "segment-generations" or parts[4] != "lengthen":
        return None

    previous_gen_id = parts[3]
    previous_generation = get_generation(task, previous_gen_id)
    if previous_generation is None:
        return error_response_fn(404, "Previous generation not found", origin=origin)
    if not generation_ready_for_post(previous_generation):
        return error_response_fn(409, "Previous generation must be complete before it can be lengthened", origin=origin)
    if not previous_generation.get("outputKey"):
        return error_response_fn(400, "Previous generation does not have a stored video output", origin=origin)

    req = json_model(SegmentGenerationLengthenRequest, event)
    allowed_models = _allowed_models_for_request(input_mode=req.inputMode, direction=req.direction)
    if req.model not in allowed_models:
        return error_response_fn(
            400,
            "Selected model is not available for this lengthen direction and creation mode",
            origin=origin,
        )

    segment_id = str(previous_generation.get("segmentId") or "")
    if not segment_id:
        return error_response_fn(400, "Previous generation segment could not be resolved", origin=origin)

    extension_metadata = {
        "type": "clip_lengthen",
        "parentGenerationId": previous_gen_id,
        "direction": req.direction,
        "durationSeconds": int(req.durationSeconds),
        "inputMode": req.inputMode,
        "createdAt": now_iso_fn(),
    }
    gen_id, job_id = queue_segment_generation_record_fn(
        task=task,
        store=store,
        user_id=user_id,
        task_id=task_id,
        segment_id=segment_id,
        model=req.model,
        mode=str(previous_generation.get("luma", {}).get("mode") or ""),
        prompt=req.prompt,
        negative_prompt=None,
        first_frame_variant_id=None,
        last_frame_variant_id=None,
        replicate_kling_mode=previous_generation.get("generationSettings", {}).get("replicateKlingMode"),
        replicate_kling_v3_mode=previous_generation.get("generationSettings", {}).get("replicateKlingV3Mode"),
        wan27_resolution=previous_generation.get("generationSettings", {}).get("wan27Resolution"),
        happy_horse_resolution=previous_generation.get("generationSettings", {}).get("happyHorseResolution"),
        preserve_frames=bool(previous_generation.get("generationSettings", {}).get("preserveFrames", True)),
        parent_generation_id=previous_gen_id,
        extension_metadata=extension_metadata,
        extra_payload={
            "inputMode": req.inputMode,
            "selectedReferenceIds": req.selectedReferenceIds,
            "clipLengthenMetadata": extension_metadata,
        },
    )
    store.save_task(task, merge_on_conflict=True)
    return response_fn(
        202,
        {
            "jobId": job_id,
            "genId": gen_id,
            "segmentId": segment_id,
            "model": req.model,
            "direction": req.direction,
        },
        origin=origin,
    )
