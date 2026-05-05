from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable


def _generation_context(task: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any], dict[str, dict[str, Any]]]:
    generations = task.get("segmentGenerations")
    frames = task.get("frames", {})
    segments = {str(segment.get("segmentId")): segment for segment in task.get("segments", []) if isinstance(segment, dict)}
    if not isinstance(generations, dict) or not generations:
        return None, frames, segments
    return generations, frames, segments


def reconcile_segment_generation_job_states(
    task: dict[str, Any],
    store,
    *,
    now_iso_fn: Callable[[], str],
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
) -> bool:
    generations, frames, segments = _generation_context(task)
    if generations is None:
        return False
    user_id = str(task.get("userId") or "")
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
        if job_status == "complete":
            result_refs = job.get("resultRefs") or {}
            output_key = result_refs.get("outputKey")
            if not output_key:
                continue
            payload = job.get("payload") or {}
            generation["status"] = "complete"
            generation["outputKey"] = output_key
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
) -> bool:
    changed = reconcile_segment_generation_job_states(
        task,
        store,
        now_iso_fn=now_iso_fn,
        append_history_event_fn=append_history_event_fn,
    )
    changed = prune_stale_segment_generations(
        task,
        store,
        now_iso_fn=now_iso_fn,
        stale_generation_max_age_seconds=stale_generation_max_age_seconds,
    ) or changed
    changed = backfill_segment_generation_preview_refs(task) or changed
    return changed
