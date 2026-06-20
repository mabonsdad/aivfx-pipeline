from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from src.core.asset_origin import build_asset_origin, merge_asset_origin
from src.core.task_workflows import (
    infer_source_generation_input_mode,
    is_character_animate_workflow_id,
    is_previz_workflow_id,
    workflow_for_character_mode,
    workflow_for_source_video_mode,
)


def _generation_context(task: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any], dict[str, dict[str, Any]]]:
    generations = task.get("segmentGenerations")
    frames = task.get("frames", {})
    segments = {str(segment.get("segmentId")): segment for segment in task.get("segments", []) if isinstance(segment, dict)}
    if not isinstance(generations, dict) or not generations:
        return None, frames, segments
    return generations, frames, segments

def _infer_generation_origin(task: dict[str, Any], generation: dict[str, Any]) -> dict[str, Any]:
    generation_settings = generation.get("generationSettings") if isinstance(generation.get("generationSettings"), dict) else {}
    character_animation = generation.get("characterAnimation") if isinstance(generation.get("characterAnimation"), dict) else {}
    task_workflow_id = str(task.get("workflowId") or "source_video_flow").strip() or "source_video_flow"
    raw_workflow_id = str(
        generation_settings.get("workflowId")
        or character_animation.get("workflowId")
        or task_workflow_id
    ).strip() or task_workflow_id

    tool_origin = "segment_generate"
    step_origin = "generate"
    creation_mode: str | None = None

    workflow_marker = str(generation_settings.get("workflow") or "").strip()
    if workflow_marker == "clip_lengthen":
        tool_origin = "clip_lengthen"
        step_origin = "post_process"
    elif workflow_marker == "timing_reconcile":
        tool_origin = "timing_reconcile"
        step_origin = "post_process"
    elif workflow_marker == "manual_upload_normalize" or generation.get("manualUpload"):
        tool_origin = "manual_upload"
    elif workflow_marker == "chunked_generation" or generation.get("chunkRole") == "draft_stitched":
        tool_origin = "chunked_generate"
    elif workflow_marker == "extension_chain_stitch":
        tool_origin = "extension_chain_stitch"

    if is_character_animate_workflow_id(raw_workflow_id):
        creation_mode = str(character_animation.get("mode") or generation_settings.get("characterMode") or "").strip() or None
        workflow_id = workflow_for_character_mode(creation_mode)
        if tool_origin == "segment_generate":
            tool_origin = "character_generate"
    elif is_previz_workflow_id(raw_workflow_id):
        workflow_id = "simple_generation_workflow"
        creation_mode = "previz"
        if tool_origin == "segment_generate":
            tool_origin = "previz_generate"
    else:
        creation_mode = infer_source_generation_input_mode(task, generation)
        workflow_id = workflow_for_source_video_mode(creation_mode)

    return build_asset_origin(
        workflow_id=workflow_id,
        step_origin=step_origin,
        tool_origin=tool_origin,
        creation_mode=creation_mode,
    )


def backfill_segment_generation_origin(task: dict[str, Any]) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    changed = False
    for generation in generations.values():
        if not isinstance(generation, dict):
            continue
        existing_origin = generation.get("origin") if isinstance(generation.get("origin"), dict) else {}
        inferred_origin = _infer_generation_origin(task, generation)
        normalized_origin = merge_asset_origin(existing_origin, inferred_origin)
        if normalized_origin != existing_origin:
            generation["origin"] = normalized_origin
            changed = True
    return changed


def reconcile_segment_generation_job_states(
    task: dict[str, Any],
    store,
    *,
    now_iso_fn: Callable[[], str],
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    stale_running_job_max_age_seconds: int,
) -> bool:
    generations, frames, segments = _generation_context(task)
    if generations is None:
        return False
    user_id = str(task.get("userId") or "")
    now_dt = datetime.now(timezone.utc)
    changed = False
    for gen_id, generation in generations.items():
        if not isinstance(generation, dict):
            continue
        status = str(generation.get("status") or "").lower()
        if status not in {"queued", "running"}:
            continue
        job_id = generation.get("jobId")
        if not isinstance(job_id, str) or not job_id:
            continue
        job = store.load_job(user_id, job_id)
        if not isinstance(job, dict):
            continue
        job_status = str(job.get("status") or "").lower()
        output_key = generation.get("outputKey")
        job_updated_at = _parse_iso_datetime(job.get("updatedAt"))
        if (
            job_status == "running"
            and not output_key
            and job_updated_at
            and (now_dt - job_updated_at).total_seconds() > stale_running_job_max_age_seconds
        ):
            failure_message = "Worker timed out before provider polling completed."
            job["status"] = "failed"
            job["error"] = failure_message
            job["finishedAt"] = now_iso_fn()
            store.save_job(job)
            generation["status"] = "failed"
            generation["error"] = failure_message
            generation["updatedAt"] = job.get("updatedAt") or now_iso_fn()
            generation["finishedAt"] = job.get("finishedAt") or job.get("updatedAt") or now_iso_fn()
            append_history_event_fn(
                task,
                {
                    "at": now_iso_fn(),
                    "event": "segment_generation.reconciled_timeout",
                    "jobId": job_id,
                    "genId": gen_id,
                },
            )
            changed = True
            continue
        if job_status == "complete":
            result_refs = job.get("resultRefs") or {}
            output_key = result_refs.get("outputKey")
            if not output_key:
                continue
            payload = job.get("payload") or {}
            generation["status"] = "complete"
            generation["outputKey"] = output_key
            if result_refs.get("posterKey"):
                generation["posterKey"] = result_refs.get("posterKey")
            generation["error"] = None
            generation["updatedAt"] = job.get("updatedAt") or now_iso_fn()
            generation["finishedAt"] = result_refs.get("finishedAt") or job.get("finishedAt") or job.get("updatedAt") or now_iso_fn()
            if result_refs.get("processingDurationSec") is not None:
                generation["processingDurationSec"] = result_refs.get("processingDurationSec")
            luma = generation.setdefault("luma", {})
            if result_refs.get("provider"):
                luma["provider"] = result_refs["provider"]
            if result_refs.get("model"):
                luma["model"] = result_refs["model"]
            if result_refs.get("mode"):
                luma["mode"] = result_refs["mode"]
            if result_refs.get("providerGenerationId") is not None:
                luma["lumaGenerationId"] = result_refs.get("providerGenerationId")
            if payload.get("prompt") is not None:
                luma["prompt"] = payload.get("prompt")
            segment = segments.get(str(generation.get("segmentId") or payload.get("segmentId") or ""))
            if isinstance(segment, dict):
                generation["segmentCrop"] = segment.get("crop")
                start_frame = frames.get(segment.get("startFrameId")) if isinstance(frames, dict) else None
                end_frame = frames.get(segment.get("endFrameId")) if isinstance(frames, dict) else None
                if isinstance(start_frame, dict) and start_frame.get("captureKey"):
                    generation.setdefault("sourceFirstFrameCaptureKey", start_frame.get("captureKey"))
                if isinstance(end_frame, dict) and end_frame.get("captureKey"):
                    generation.setdefault("sourceLastFrameCaptureKey", end_frame.get("captureKey"))
            if payload.get("firstFrameVariantId") and not generation.get("sourceFirstFrameVariantId"):
                generation["sourceFirstFrameVariantId"] = payload.get("firstFrameVariantId")
            if payload.get("lastFrameVariantId") and not generation.get("sourceLastFrameVariantId"):
                generation["sourceLastFrameVariantId"] = payload.get("lastFrameVariantId")
            append_history_event_fn(
                task,
                {
                    "at": now_iso_fn(),
                    "event": "segment_generation.reconciled_complete",
                    "jobId": job_id,
                    "genId": gen_id,
                },
            )
            changed = True
        elif job_status == "failed":
            generation["status"] = "failed"
            generation["error"] = job.get("error")
            generation["updatedAt"] = job.get("updatedAt") or now_iso_fn()
            generation["finishedAt"] = job.get("finishedAt") or job.get("updatedAt") or now_iso_fn()
            append_history_event_fn(
                task,
                {
                    "at": now_iso_fn(),
                    "event": "segment_generation.reconciled_failed",
                    "jobId": job_id,
                    "genId": gen_id,
                },
            )
            changed = True
    return changed


def reconcile_edit_video_reference_job_states(
    task: dict[str, Any],
    store,
    *,
    now_iso_fn: Callable[[], str],
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    stale_running_job_max_age_seconds: int,
) -> bool:
    references = task.get("editVideoReferences")
    if not isinstance(references, list) or not references:
        return False
    user_id = str(task.get("userId") or "")
    now_dt = datetime.now(timezone.utc)
    changed = False
    for reference in references:
        if not isinstance(reference, dict):
            continue
        status = str(reference.get("status") or "").lower()
        if status not in {"queued", "running"}:
            continue
        job_id = str(reference.get("jobId") or "").strip()
        if not job_id:
            continue
        job = store.load_job(user_id, job_id)
        if not isinstance(job, dict):
            continue
        job_status = str(job.get("status") or "").lower()
        job_updated_at = _parse_iso_datetime(job.get("updatedAt"))
        if job_status == "complete":
            result_refs = job.get("resultRefs") or {}
            output_key = str(result_refs.get("outputKey") or "").strip()
            if not output_key:
                continue
            reference["status"] = "complete"
            reference["key"] = output_key
            reference["updatedAt"] = job.get("updatedAt") or now_iso_fn()
            reference["jobId"] = job_id
            reference.pop("error", None)
            append_history_event_fn(
                task,
                {
                    "at": now_iso_fn(),
                    "event": "edit_video_reference.reconciled_complete",
                    "jobId": job_id,
                    "referenceId": reference.get("referenceId"),
                },
            )
            changed = True
            continue
        if job_status == "failed":
            reference["status"] = "failed"
            reference["updatedAt"] = job.get("updatedAt") or now_iso_fn()
            reference["jobId"] = job_id
            reference["error"] = job.get("error")
            append_history_event_fn(
                task,
                {
                    "at": now_iso_fn(),
                    "event": "edit_video_reference.reconciled_failed",
                    "jobId": job_id,
                    "referenceId": reference.get("referenceId"),
                },
            )
            changed = True
            continue
        output_key = str(reference.get("key") or "").strip()
        if (
            job_status == "running"
            and not output_key
            and job_updated_at
            and (now_dt - job_updated_at).total_seconds() > stale_running_job_max_age_seconds
        ):
            failure_message = "Worker timed out before reference generation completed."
            job["status"] = "failed"
            job["error"] = failure_message
            job["finishedAt"] = now_iso_fn()
            store.save_job(job)
            reference["status"] = "failed"
            reference["updatedAt"] = job.get("updatedAt") or now_iso_fn()
            reference["jobId"] = job_id
            reference["error"] = failure_message
            append_history_event_fn(
                task,
                {
                    "at": now_iso_fn(),
                    "event": "edit_video_reference.reconciled_timeout",
                    "jobId": job_id,
                    "referenceId": reference.get("referenceId"),
                },
            )
            changed = True
    return changed


def backfill_segment_generation_preview_refs(task: dict[str, Any]) -> bool:
    generations, frames, segments = _generation_context(task)
    if generations is None:
        return False
    changed = False
    for generation in generations.values():
        if not isinstance(generation, dict):
            continue
        segment = segments.get(str(generation.get("segmentId") or ""))
        if not isinstance(segment, dict):
            continue
        start_frame = frames.get(segment.get("startFrameId")) if isinstance(frames, dict) else None
        end_frame = frames.get(segment.get("endFrameId")) if isinstance(frames, dict) else None
        if not generation.get("sourceFirstFrameCaptureKey") and isinstance(start_frame, dict) and start_frame.get("captureKey"):
            generation["sourceFirstFrameCaptureKey"] = start_frame["captureKey"]
            changed = True
        if not generation.get("sourceLastFrameCaptureKey") and isinstance(end_frame, dict) and end_frame.get("captureKey"):
            generation["sourceLastFrameCaptureKey"] = end_frame["captureKey"]
            changed = True
        if generation.get("segmentCrop") is None:
            generation["segmentCrop"] = segment.get("crop")
    return changed


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def prune_stale_segment_generations(
    task: dict[str, Any],
    store,
    *,
    now_iso_fn: Callable[[], str],
    stale_generation_max_age_seconds: int,
) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    now_dt = datetime.now(timezone.utc)
    remove_ids: set[str] = set()
    user_id = str(task.get("userId") or "")
    for gen_id, generation in generations.items():
        if not isinstance(generation, dict):
            remove_ids.add(gen_id)
            continue
        status = str(generation.get("status") or "").lower()
        output_key = generation.get("outputKey")
        if status not in {"queued", "running"}:
            continue
        if output_key:
            continue
        job_id = generation.get("jobId")
        if isinstance(job_id, str) and job_id:
            job = store.load_job(user_id, job_id)
            if not job:
                created_at = _parse_iso_datetime(generation.get("createdAt"))
                if created_at and (now_dt - created_at).total_seconds() > stale_generation_max_age_seconds:
                    remove_ids.add(gen_id)
                continue
        created_at = _parse_iso_datetime(generation.get("createdAt"))
        if created_at and (now_dt - created_at).total_seconds() > stale_generation_max_age_seconds:
            remove_ids.add(gen_id)

    if not remove_ids:
        return False
    for gen_id in remove_ids:
        generations.pop(gen_id, None)
    for segment in task.get("segments", []):
        if segment.get("selectedGenerationId") in remove_ids:
            segment["selectedGenerationId"] = None
    task.setdefault("history", []).append(
        {
            "at": now_iso_fn(),
            "event": "task.segment_generations.pruned",
            "removedGenerationIds": sorted(remove_ids),
        }
    )
    return True


def maintain_segment_generations(
    task: dict[str, Any],
    store,
    *,
    now_iso_fn: Callable[[], str],
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    stale_generation_max_age_seconds: int,
    stale_running_job_max_age_seconds: int,
) -> bool:
    changed = reconcile_segment_generation_job_states(
        task,
        store,
        now_iso_fn=now_iso_fn,
        append_history_event_fn=append_history_event_fn,
        stale_running_job_max_age_seconds=stale_running_job_max_age_seconds,
    )
    changed = reconcile_edit_video_reference_job_states(
        task,
        store,
        now_iso_fn=now_iso_fn,
        append_history_event_fn=append_history_event_fn,
        stale_running_job_max_age_seconds=stale_running_job_max_age_seconds,
    ) or changed
    changed = prune_stale_segment_generations(
        task,
        store,
        now_iso_fn=now_iso_fn,
        stale_generation_max_age_seconds=stale_generation_max_age_seconds,
    ) or changed
    changed = backfill_segment_generation_preview_refs(task) or changed
    changed = backfill_segment_generation_origin(task) or changed
    return changed
