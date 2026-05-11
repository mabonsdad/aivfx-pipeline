from __future__ import annotations

import math
from typing import Any, Callable

from src.generation.lifecycle import generation_ready_for_post, get_generation, get_segment
from src.models.schemas import SegmentGenerationExtendRequest


def handle_task_generation_extend_route(
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
    now_iso_fn: Callable[[], str],
    supports_generation_extension_fn: Callable[[str], bool],
    get_video_model_capability_fn: Callable[[str], Any],
    fps_fn: Callable[[dict[str, Any]], Any],
    resolve_segment_frames_fn: Callable[..., tuple[int, int, int]],
    create_segment_record_fn: Callable[..., dict[str, Any]],
    segment_model_limit_error_fn: Callable[[dict[str, Any], dict[str, Any], str], str | None],
    video_model_label_fn: Callable[[str], str],
    sanitize_prompt_fn: Callable[[str], str],
    copy_generated_anchor_to_frame_variant_fn: Callable[..., dict[str, Any]],
    queue_segment_generation_record_fn: Callable[..., tuple[str, str]],
) -> dict[str, Any] | None:
    if method != "POST" or len(parts) != 5 or parts[2] != "segment-generations" or parts[4] != "extend":
        return None

    previous_gen_id = parts[3]
    previous_generation = get_generation(task, previous_gen_id)
    if previous_generation is None:
        return error_response_fn(404, "Previous generation not found", origin=origin)
    if not generation_ready_for_post(previous_generation):
        return error_response_fn(400, "Previous generation must be complete before it can be extended", origin=origin)
    req = json_model(SegmentGenerationExtendRequest, event)
    model = str(previous_generation.get("luma", {}).get("model") or "")
    if not supports_generation_extension_fn(model):
        return error_response_fn(400, "Only first-frame + video generation models can be extended in this flow", origin=origin)

    previous_segment = get_segment(task, str(previous_generation.get("segmentId") or ""))
    if not previous_segment:
        return error_response_fn(404, "Previous generation segment not found", origin=origin)
    total_frames = int(task.get("video", {}).get("editSource", {}).get("frameCount") or 0)
    if req.alignmentFrameIndex >= total_frames:
        return error_response_fn(400, "Alignment frame is outside the source video", origin=origin)

    model_capability = get_video_model_capability_fn(model)
    model_max_seconds = int(model_capability.max_seconds or 10)
    requested_duration_seconds = req.durationSeconds or int(math.ceil(float(previous_segment.get("durationSec") or model_max_seconds)))
    requested_duration_seconds = max(1, min(model_max_seconds, int(requested_duration_seconds)))
    fps = fps_fn(task)
    alignment_frame_index = req.alignmentFrameIndex
    requested_alignment_frame_index = alignment_frame_index
    min_seconds = model_capability.min_seconds
    if min_seconds is not None:
        min_frames = max(1, int(math.ceil(float(min_seconds) * float(fps))))
        remaining_after_requested = max(0, total_frames - alignment_frame_index)
        if remaining_after_requested < min_frames:
            latest_valid_alignment = max(0, total_frames - min_frames)
            if latest_valid_alignment < alignment_frame_index:
                alignment_frame_index = latest_valid_alignment

    desired_frames = max(1, int(round(float(fps) * requested_duration_seconds)))
    remaining_frames = max(0, total_frames - alignment_frame_index)
    if remaining_frames <= 0:
        return error_response_fn(400, "No source frames remain after the selected alignment frame", origin=origin)
    dur_frames = min(desired_frames, remaining_frames)
    if min_seconds is not None and (dur_frames / float(fps)) + 1e-6 < float(min_seconds):
        return error_response_fn(
            400,
            f"{video_model_label_fn(model)} requires at least {min_seconds}s. Choose an earlier alignment frame or a shorter prior overlap.",
            origin=origin,
        )

    start, end_excl, dur_frames = resolve_segment_frames_fn(
        task,
        alignment_frame_index,
        end_frame_exclusive=alignment_frame_index + dur_frames,
    )
    segment = create_segment_record_fn(task=task, start=start, end_excl=end_excl, dur_frames=dur_frames, asset_store=asset_store)
    limit_error = segment_model_limit_error_fn(task, segment, model)
    if limit_error:
        task["segments"] = [item for item in task.get("segments", []) if item.get("segmentId") != segment.get("segmentId")]
        return error_response_fn(400, limit_error, origin=origin)

    try:
        prompt = sanitize_prompt_fn(req.prompt) if req.prompt else previous_generation.get("luma", {}).get("prompt")
        anchor_variant = copy_generated_anchor_to_frame_variant_fn(
            task=task,
            generation=previous_generation,
            target_frame_id=segment["startFrameId"],
            target_frame_index=start,
            anchor_frames_from_end=req.anchorFramesFromEnd,
            asset_store=asset_store,
        )
    except ValueError as exc:
        task["segments"] = [item for item in task.get("segments", []) if item.get("segmentId") != segment.get("segmentId")]
        return error_response_fn(400, str(exc), origin=origin)

    settings_payload = previous_generation.get("generationSettings") if isinstance(previous_generation.get("generationSettings"), dict) else {}
    extension_metadata = {
        "parentGenerationId": previous_gen_id,
        "alignmentFrameIndex": start,
        "requestedAlignmentFrameIndex": requested_alignment_frame_index,
        "anchorFramesFromEnd": req.anchorFramesFromEnd,
        "anchorVariantId": anchor_variant.get("variantId"),
        "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
        "previousSegmentId": previous_generation.get("segmentId"),
        "createdAt": now_iso_fn(),
    }
    gen_id, job_id = queue_segment_generation_record_fn(
        task=task,
        store=store,
        user_id=user_id,
        task_id=task_id,
        segment_id=segment["segmentId"],
        model=model,
        mode=str(previous_generation.get("luma", {}).get("mode") or ""),
        prompt=str(prompt) if prompt else None,
        negative_prompt=str(previous_generation.get("luma", {}).get("negativePrompt") or "") or None,
        first_frame_variant_id=str(anchor_variant.get("variantId")),
        last_frame_variant_id=None,
        replicate_kling_mode=settings_payload.get("replicateKlingMode"),
        replicate_kling_v3_mode=settings_payload.get("replicateKlingV3Mode"),
        wan27_resolution=settings_payload.get("wan27Resolution"),
        happy_horse_resolution=settings_payload.get("happyHorseResolution"),
        parent_generation_id=previous_gen_id,
        extension_metadata=extension_metadata,
    )
    store.save_task(task, merge_on_conflict=True)
    return response_fn(
        202,
        {
            "jobId": job_id,
            "genId": gen_id,
            "segmentId": segment["segmentId"],
            "anchorVariantId": anchor_variant.get("variantId"),
            "alignmentFrameIndex": start,
            "requestedAlignmentFrameIndex": requested_alignment_frame_index,
            "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
        },
        origin=origin,
    )
