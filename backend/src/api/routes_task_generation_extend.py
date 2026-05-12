from __future__ import annotations

import math
from typing import Any, Callable

from src.generation.lifecycle import generation_ready_for_post, get_generation, get_segment
from src.models.schemas import SegmentGenerationExtendRequest

_START_END_MODES = {"kling_start_end", "veo_start_end", "wan27_i2v_start_end", "ltx23_i2v_start_end"}
_START_ONLY_MODE_FALLBACKS = {
    "kling_start_end": "kling_start_only",
    "veo_start_end": "veo_start_only",
    "wan27_i2v_start_end": "wan27_i2v_start_only",
}


def _remove_segments(task: dict[str, Any], segment_ids: list[str]) -> None:
    if not segment_ids:
        return
    ids = set(segment_ids)
    task["segments"] = [segment for segment in task.get("segments", []) if segment.get("segmentId") not in ids]


def _resolve_input_mode(requested_mode: str, capability: Any, requested_input_mode: str | None) -> str:
    if requested_input_mode in {"start_video", "start_end", "start_only", "edit_video"}:
        return requested_input_mode
    if requested_mode in _START_END_MODES:
        return "start_end"
    if bool(getattr(capability, "uses_source_video", False)):
        return "start_video"
    return "start_only"


def _resolve_extension_mode(requested_mode: str, *, input_mode: str, use_source_last_frame: bool) -> str:
    if input_mode != "start_end":
        return requested_mode
    if use_source_last_frame:
        return requested_mode
    return _START_ONLY_MODE_FALLBACKS.get(requested_mode, requested_mode)


def _find_root_source_segment(task: dict[str, Any], generation: dict[str, Any]) -> dict[str, Any] | None:
    current = generation
    visited: set[str] = set()
    while isinstance(current, dict):
        extension = current.get("extension")
        extension_parent_id = extension.get("parentGenerationId") if isinstance(extension, dict) else None
        parent_id = str(current.get("parentGenerationId") or extension_parent_id or "")
        if not parent_id or parent_id in visited:
            break
        visited.add(parent_id)
        parent = task.get("segmentGenerations", {}).get(parent_id)
        if not isinstance(parent, dict):
            break
        current = parent
    return get_segment(task, str(current.get("segmentId") or "")) if isinstance(current, dict) else None


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
    supports_chunked_generation_fn: Callable[[str], bool],
    get_video_model_capability_fn: Callable[[str], Any],
    fps_fn: Callable[[dict[str, Any]], Any],
    plan_chunk_windows_fn: Callable[..., tuple[int, list[dict[str, int | float]]]],
    resolve_segment_frames_fn: Callable[..., tuple[int, int, int]],
    create_segment_record_fn: Callable[..., dict[str, Any]],
    segment_model_limit_error_fn: Callable[[dict[str, Any], dict[str, Any], str], str | None],
    video_model_label_fn: Callable[[str], str],
    sanitize_prompt_fn: Callable[[str], str],
    copy_generated_anchor_to_frame_variant_fn: Callable[..., dict[str, Any]],
    queue_chunk_generation_for_run_fn: Callable[..., tuple[str, str]],
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    new_id_fn: Callable[[str], str],
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
    previous_segment = get_segment(task, str(previous_generation.get("segmentId") or ""))
    if not previous_segment:
        return error_response_fn(404, "Previous generation segment not found", origin=origin)
    source_segment = _find_root_source_segment(task, previous_generation) or previous_segment
    total_frames = int(task.get("video", {}).get("editSource", {}).get("frameCount") or 0)
    source_start_frame = int(source_segment.get("startFrame") or 0)
    source_end_frame_exclusive = int(source_segment.get("endFrameExclusive") or total_frames)
    if req.alignmentFrameIndex >= total_frames or req.alignmentFrameIndex >= source_end_frame_exclusive:
        return error_response_fn(400, "Alignment frame is outside the source video", origin=origin)
    if req.alignmentFrameIndex < source_start_frame:
        return error_response_fn(400, "Alignment frame is outside the current working range", origin=origin)

    model_capability = get_video_model_capability_fn(model)
    requested_mode = str(previous_generation.get("luma", {}).get("mode") or "")
    input_mode = _resolve_input_mode(requested_mode, model_capability, req.inputMode)
    extension_mode = _resolve_extension_mode(
        requested_mode,
        input_mode=input_mode,
        use_source_last_frame=bool(req.useSourceLastFrame),
    )
    if input_mode == "start_end" and not req.useSourceLastFrame and extension_mode == requested_mode and requested_mode in _START_END_MODES:
        return error_response_fn(
            400,
            f"{video_model_label_fn(model)} requires an end frame for this mode. Keep \"use last frame\" enabled for this model.",
            origin=origin,
        )

    model_max_seconds = int(model_capability.max_seconds or 10)
    requested_duration_seconds = req.durationSeconds or int(math.ceil(float(previous_segment.get("durationSec") or model_max_seconds)))
    requested_duration_seconds = max(1, min(model_max_seconds, int(requested_duration_seconds)))
    fps = fps_fn(task)
    alignment_frame_index = req.alignmentFrameIndex
    requested_alignment_frame_index = alignment_frame_index
    min_seconds = model_capability.min_seconds
    if min_seconds is not None:
        min_frames = max(1, int(math.ceil(float(min_seconds) * float(fps))))
        remaining_after_requested = max(0, source_end_frame_exclusive - alignment_frame_index)
        if remaining_after_requested < min_frames:
            latest_valid_alignment = max(source_start_frame, source_end_frame_exclusive - min_frames)
            if latest_valid_alignment < alignment_frame_index:
                alignment_frame_index = latest_valid_alignment

    desired_frames = max(1, int(round(float(fps) * requested_duration_seconds)))
    remaining_frames = max(0, source_end_frame_exclusive - alignment_frame_index)
    if remaining_frames <= 0:
        return error_response_fn(400, "No source frames remain after the selected alignment frame", origin=origin)
    dur_frames = remaining_frames if req.continueToRangeEnd else min(desired_frames, remaining_frames)
    if min_seconds is not None and (dur_frames / float(fps)) + 1e-6 < float(min_seconds):
        return error_response_fn(
            400,
            f"{video_model_label_fn(model)} requires at least {min_seconds}s. Choose an earlier alignment frame or a shorter prior overlap.",
            origin=origin,
        )

    max_frames_for_model = max(1, int(round(float(model_max_seconds) * float(fps))))
    should_chunk_to_end = bool(req.continueToRangeEnd and dur_frames > max_frames_for_model)

    settings_payload = previous_generation.get("generationSettings") if isinstance(previous_generation.get("generationSettings"), dict) else {}
    prompt = sanitize_prompt_fn(req.prompt) if req.prompt else previous_generation.get("luma", {}).get("prompt")
    negative_prompt = str(previous_generation.get("luma", {}).get("negativePrompt") or "") or None

    if should_chunk_to_end:
        if not supports_chunked_generation_fn(model):
            return error_response_fn(
                400,
                f"{video_model_label_fn(model)} cannot auto-continue to the end of the working range because chunked continuation is not supported for this model.",
                origin=origin,
            )
        created_segment_ids: list[str] = []
        try:
            chunk_source_segment = create_segment_record_fn(
                task=task,
                start=alignment_frame_index,
                end_excl=source_end_frame_exclusive,
                dur_frames=dur_frames,
                asset_store=asset_store,
                internal_only=True,
            )
            created_segment_ids.append(str(chunk_source_segment.get("segmentId") or ""))
            anchor_variant = copy_generated_anchor_to_frame_variant_fn(
                task=task,
                generation=previous_generation,
                target_frame_id=chunk_source_segment["startFrameId"],
                target_frame_index=alignment_frame_index,
                anchor_frames_from_end=req.anchorFramesFromEnd,
                asset_store=asset_store,
            )
            overlap_frames, chunk_windows = plan_chunk_windows_fn(total_frames=dur_frames, fps=fps)
            chunk_segments: list[dict[str, Any]] = []
            absolute_segment_start = int(chunk_source_segment.get("startFrame") or alignment_frame_index)
            for window in chunk_windows:
                start = absolute_segment_start + int(window["startFrame"])
                end_excl = absolute_segment_start + int(window["endFrameExclusive"])
                created = create_segment_record_fn(
                    task=task,
                    start=start,
                    end_excl=end_excl,
                    dur_frames=int(window["durationFrames"]),
                    asset_store=asset_store,
                    internal_only=True,
                )
                created_segment_ids.append(str(created.get("segmentId") or ""))
                chunk_segments.append(created)
            run_id = new_id_fn("cgr")
            now = now_iso_fn()
            run = {
                "runId": run_id,
                "sourceSegmentId": chunk_source_segment.get("segmentId"),
                "parentGenerationId": previous_gen_id,
                "status": "created",
                "model": model,
                "mode": extension_mode,
                "openingPrompt": prompt,
                "continuationPrompt": prompt,
                "firstFrameVariantId": anchor_variant.get("variantId"),
                "replicateKlingMode": settings_payload.get("replicateKlingMode"),
                "replicateKlingV3Mode": settings_payload.get("replicateKlingV3Mode"),
                "wan27Resolution": settings_payload.get("wan27Resolution"),
                "happyHorseResolution": settings_payload.get("happyHorseResolution"),
                "preserveFrames": bool(settings_payload.get("preserveFrames", True)),
                "chunkDurationSec": int(round(max(1.0, max_frames_for_model / float(fps)))),
                "minimumOverlapFrames": overlap_frames,
                "createdAt": now,
                "startedAt": now,
                "updatedAt": now,
                "activeChunkIndex": 0,
                "chunks": [],
            }
            for idx, (window, chunk_segment) in enumerate(zip(chunk_windows, chunk_segments)):
                run["chunks"].append(
                    {
                        "chunkIndex": idx,
                        "segmentId": chunk_segment.get("segmentId"),
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
                        "anchorVariantId": anchor_variant.get("variantId") if idx == 0 else None,
                        "status": "planned",
                        "reviewStatus": "pending" if idx > 0 else "running",
                        "prompt": prompt,
                        "createdAt": now,
                        "updatedAt": now,
                    }
                )

            first_chunk = run["chunks"][0]
            first_gen_id, first_job_id = queue_chunk_generation_for_run_fn(
                task=task,
                store=store,
                run=run,
                chunk=first_chunk,
                model=model,
                mode=extension_mode,
                prompt=prompt,
                negative_prompt=negative_prompt,
                first_frame_variant_id=str(anchor_variant.get("variantId")),
                replicate_kling_mode=settings_payload.get("replicateKlingMode"),
                replicate_kling_v3_mode=settings_payload.get("replicateKlingV3Mode"),
                wan27_resolution=settings_payload.get("wan27Resolution"),
                happy_horse_resolution=settings_payload.get("happyHorseResolution"),
                preserve_frames=bool(settings_payload.get("preserveFrames", True)),
                parent_generation_id=previous_gen_id,
                extension_metadata={
                    "chunkedRunId": run_id,
                    "chunkIndex": 0,
                    "sourceSegmentId": chunk_source_segment.get("segmentId"),
                    "alignmentFrameIndex": alignment_frame_index,
                    "anchorFramesFromEnd": req.anchorFramesFromEnd,
                    "anchorVariantId": anchor_variant.get("variantId"),
                    "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
                    "createdAt": now,
                    "continueToRangeEnd": True,
                },
            )
            task.setdefault("chunkedGenerationRuns", []).append(run)
            append_history_event_fn(
                task,
                {
                    "at": now,
                    "event": "chunked_generation.created",
                    "runId": run_id,
                    "sourceSegmentId": chunk_source_segment.get("segmentId"),
                    "model": model,
                    "chunkCount": len(run["chunks"]),
                    "reason": "postprocess_extend_continue_to_end",
                },
            )
            store.save_task(task, merge_on_conflict=True)
            return response_fn(
                202,
                {
                    "jobId": first_job_id,
                    "genId": first_gen_id,
                    "segmentId": chunk_source_segment.get("segmentId"),
                    "runId": run_id,
                    "chunkCount": len(run["chunks"]),
                    "anchorVariantId": anchor_variant.get("variantId"),
                    "alignmentFrameIndex": alignment_frame_index,
                    "requestedAlignmentFrameIndex": requested_alignment_frame_index,
                    "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
                    "continueToRangeEnd": True,
                },
                origin=origin,
            )
        except ValueError as exc:
            _remove_segments(task, created_segment_ids)
            return error_response_fn(400, str(exc), origin=origin)

    start, end_excl, dur_frames = resolve_segment_frames_fn(
        task,
        alignment_frame_index,
        end_frame_exclusive=alignment_frame_index + dur_frames,
    )
    segment = create_segment_record_fn(
        task=task,
        start=start,
        end_excl=end_excl,
        dur_frames=dur_frames,
        asset_store=asset_store,
        internal_only=True,
    )
    limit_error = segment_model_limit_error_fn(task, segment, model)
    if limit_error:
        task["segments"] = [item for item in task.get("segments", []) if item.get("segmentId") != segment.get("segmentId")]
        return error_response_fn(400, limit_error, origin=origin)

    last_frame_variant_id: str | None = None
    if input_mode == "start_end" and req.useSourceLastFrame:
        last_frame_variant_id = str(req.lastFrameVariantId) if req.lastFrameVariantId else None
    try:
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

    extension_metadata = {
        "parentGenerationId": previous_gen_id,
        "alignmentFrameIndex": start,
        "requestedAlignmentFrameIndex": requested_alignment_frame_index,
        "anchorFramesFromEnd": req.anchorFramesFromEnd,
        "anchorVariantId": anchor_variant.get("variantId"),
        "sourceGeneratedFrameIndex": anchor_variant.get("sourceGeneratedFrameIndex"),
        "previousSegmentId": previous_generation.get("segmentId"),
        "inputMode": input_mode,
        "continueToRangeEnd": bool(req.continueToRangeEnd),
        "useSourceLastFrame": bool(req.useSourceLastFrame),
        "createdAt": now_iso_fn(),
    }
    gen_id, job_id = queue_segment_generation_record_fn(
        task=task,
        store=store,
        user_id=user_id,
        task_id=task_id,
        segment_id=segment["segmentId"],
        model=model,
        mode=extension_mode,
        prompt=str(prompt) if prompt else None,
        negative_prompt=negative_prompt,
        first_frame_variant_id=str(anchor_variant.get("variantId")),
        last_frame_variant_id=last_frame_variant_id,
        replicate_kling_mode=settings_payload.get("replicateKlingMode"),
        replicate_kling_v3_mode=settings_payload.get("replicateKlingV3Mode"),
        wan27_resolution=settings_payload.get("wan27Resolution"),
        happy_horse_resolution=settings_payload.get("happyHorseResolution"),
        preserve_frames=bool(settings_payload.get("preserveFrames", True)),
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
