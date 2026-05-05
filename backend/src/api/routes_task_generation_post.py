from __future__ import annotations

from typing import Any, Callable

from src.generation.lifecycle import (
    build_reconcile_generation_record,
    build_reconcile_state,
    generation_ready_for_post,
    get_generation,
)
from src.models.schemas import ReconcileTimingRequest


def handle_task_generation_post_routes(
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
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 5 and parts[2] == "segment-generations" and parts[4] == "merge-alignment-suggestion":
        generation = get_generation(task, parts[3])
        if generation is None:
            return error_response_fn(404, "Generation not found", origin=origin)
        if not generation_ready_for_post(generation):
            return error_response_fn(409, "Generation must be complete before alignment can be analysed", origin=origin)
        suggestion_state = generation.get("mergeAlignmentSuggestion") if isinstance(generation.get("mergeAlignmentSuggestion"), dict) else {}
        existing_job_id = suggestion_state.get("jobId")
        if (
            isinstance(existing_job_id, str)
            and existing_job_id
            and suggestion_state.get("status") in {"queued", "running"}
        ):
            existing_job = store.load_job(user_id, existing_job_id)
            if isinstance(existing_job, dict) and existing_job.get("status") in {"queued", "running"}:
                return response_fn(202, {"jobId": existing_job_id, "alreadyRunning": True}, origin=origin)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="merge_alignment_suggestion",
            payload={"genId": parts[3]},
        )
        generation["mergeAlignmentSuggestion"] = {
            "status": "queued",
            "jobId": job_id,
            "updatedAt": now_iso_fn(),
        }
        store.save_task(task)
        return response_fn(202, {"jobId": job_id}, origin=origin)

    if method != "POST" or len(parts) != 5 or parts[2] != "segment-generations" or parts[4] != "reconcile-timing":
        return None

    source_generation_id = parts[3]
    generation = get_generation(task, source_generation_id)
    if generation is None:
        return error_response_fn(404, "Generation not found", origin=origin)
    if not generation_ready_for_post(generation):
        return error_response_fn(409, "Generation must be complete before timing can be reconciled", origin=origin)
    req = json_model(ReconcileTimingRequest, event)
    reconcile_state = generation.get("timingReconcile") if isinstance(generation.get("timingReconcile"), dict) else {}
    existing_job_id = reconcile_state.get("jobId")
    if (
        isinstance(existing_job_id, str)
        and existing_job_id
        and reconcile_state.get("status") in {"queued", "running"}
    ):
        existing_job = store.load_job(user_id, existing_job_id)
        if isinstance(existing_job, dict) and existing_job.get("status") in {"queued", "running"}:
            return response_fn(
                202,
                {"jobId": existing_job_id, "genId": reconcile_state.get("resultGenId"), "alreadyRunning": True},
                origin=origin,
            )

    reconciled_gen_id = new_id_fn("gen")
    job_id = queue_job_fn(
        store=store,
        user_id=user_id,
        task_id=task_id,
        job_type="generation_reconcile_timing",
        payload={
            "sourceGenId": source_generation_id,
            "genId": reconciled_gen_id,
            "trimStartFrames": int(req.trimStartFrames),
            "trimEndFrames": int(req.trimEndFrames),
            "playbackRate": req.playbackRate,
        },
    )
    now = now_iso_fn()
    segment_id = str(generation.get("segmentId") or "")
    queued_generation = build_reconcile_generation_record(
        generation,
        result_generation_id=reconciled_gen_id,
        segment_id=segment_id,
        source_generation_id=source_generation_id,
        job_id=job_id,
        now_iso=now,
        trim_start_frames=int(req.trimStartFrames),
        trim_end_frames=int(req.trimEndFrames),
        playback_rate=req.playbackRate,
    )
    task.setdefault("segmentGenerations", {})[reconciled_gen_id] = queued_generation
    generation["timingReconcile"] = build_reconcile_state(
        job_id=job_id,
        result_generation_id=reconciled_gen_id,
        now_iso=now,
        trim_start_frames=int(req.trimStartFrames),
        trim_end_frames=int(req.trimEndFrames),
        playback_rate=req.playbackRate,
    )
    store.save_task(task)
    return response_fn(202, {"jobId": job_id, "genId": reconciled_gen_id}, origin=origin)
