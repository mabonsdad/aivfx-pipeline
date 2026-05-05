from __future__ import annotations

from typing import Any, Callable

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
        generation = task.get("segmentGenerations", {}).get(parts[3])
        if not isinstance(generation, dict):
            return error_response_fn(404, "Generation not found", origin=origin)
        if generation.get("status") != "complete" or not generation.get("outputKey"):
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
    generation = task.get("segmentGenerations", {}).get(source_generation_id)
    if not isinstance(generation, dict):
        return error_response_fn(404, "Generation not found", origin=origin)
    if generation.get("status") != "complete" or not generation.get("outputKey"):
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
    queued_generation = {
        **generation,
        "genId": reconciled_gen_id,
        "segmentId": segment_id,
        "status": "queued",
        "outputKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now,
        "createdAt": now,
        "updatedAt": now,
        "startedAt": None,
        "finishedAt": None,
        "processingDurationSec": None,
        "downloadUrl": None,
        "inputMediaUrl": None,
        "mergeAlignmentSuggestion": None,
        "timingReconcile": None,
        "alignment": None,
        "sourceFrameOffset": None,
        "cleanupTrackId": None,
        "derivedFromGenerationId": source_generation_id,
        "generationSettings": {
            **(generation.get("generationSettings") if isinstance(generation.get("generationSettings"), dict) else {}),
            "workflow": "timing_reconcile",
            "derivedFromGenerationId": source_generation_id,
            "reconcileTiming": {
                "sourceGenerationId": source_generation_id,
                "trimStartFrames": int(req.trimStartFrames),
                "trimEndFrames": int(req.trimEndFrames),
                "playbackRate": req.playbackRate,
            },
        },
    }
    task.setdefault("segmentGenerations", {})[reconciled_gen_id] = queued_generation
    generation["timingReconcile"] = {
        "status": "queued",
        "jobId": job_id,
        "resultGenId": reconciled_gen_id,
        "updatedAt": now,
        "adjustments": {
            "trimStartFrames": int(req.trimStartFrames),
            "trimEndFrames": int(req.trimEndFrames),
            "playbackRate": req.playbackRate,
        },
    }
    store.save_task(task)
    return response_fn(202, {"jobId": job_id, "genId": reconciled_gen_id}, origin=origin)
