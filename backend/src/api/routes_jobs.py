from __future__ import annotations

import json
from typing import Any

from src.core.store import now_iso
from src.video_cleanup.service import get_cleanup_track
from src.workers.jobs.failure import handle_job_failure


def _find_chunked_generation_run(task: dict[str, Any], run_id: str) -> dict[str, Any] | None:
    return next(
        (
            run
            for run in task.get("chunkedGenerationRuns", [])
            if isinstance(run, dict) and str(run.get("runId") or "") == str(run_id)
        ),
        None,
    )


def _find_chunked_generation_run_for_generation(task: dict[str, Any], gen_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    for run in task.get("chunkedGenerationRuns", []):
        if not isinstance(run, dict):
            continue
        for chunk in run.get("chunks", []):
            if isinstance(chunk, dict) and chunk.get("generationId") == gen_id:
                return run, chunk
    return None, None


def _mark_chunked_generation_run_failed(
    *,
    store,
    task: dict[str, Any],
    gen_id: str,
    error: str,
) -> None:
    run, chunk = _find_chunked_generation_run_for_generation(task, gen_id)
    if not isinstance(run, dict) or not isinstance(chunk, dict):
        return
    now = now_iso()
    chunk["status"] = "failed"
    chunk["reviewStatus"] = "needs_retry"
    chunk["error"] = error
    chunk["updatedAt"] = now
    run["status"] = "failed"
    run["failureChunkIndex"] = int(chunk.get("chunkIndex") or 0)
    run["updatedAt"] = now
    history = task.setdefault("history", [])
    if isinstance(history, list):
        history.append(
            {
                "at": now,
                "event": "chunked_generation.chunk_failed",
                "runId": run.get("runId"),
                "chunkIndex": chunk.get("chunkIndex"),
                "genId": gen_id,
                "error": error,
            }
        )
    store.save_task(task, merge_on_conflict=True)


def _cancel_error_message(reason: str | None) -> str:
    cleaned = (reason or "").strip()
    return f"Cancelled by user: {cleaned}" if cleaned else "Cancelled by user"


def handle_job_status(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    user_id: str,
    store,
    origin: str | None,
    response_fn,
    error_response_fn,
):
    if not path.startswith("/jobs/"):
        return None

    parts = path.split("/")
    if len(parts) < 3 or not parts[2]:
        return error_response_fn(404, "Job not found", origin=origin)
    job_id = parts[2]
    job = store.load_job(user_id, job_id)
    if not job:
        return error_response_fn(404, "Job not found", origin=origin)

    if method == "GET":
        return response_fn(200, job, origin=origin)

    if method == "POST" and len(parts) >= 4 and parts[3] == "cancel":
        request_reason: str | None = None
        body = event.get("body")
        if isinstance(body, str) and body.strip():
            try:
                parsed = json.loads(body)
                if isinstance(parsed, dict):
                    reason_value = parsed.get("reason")
                    if isinstance(reason_value, str):
                        request_reason = reason_value.strip()[:300] or None
            except json.JSONDecodeError:
                return error_response_fn(400, "Invalid JSON body", origin=origin)

        cancel_requested_at = str(job.get("cancelRequestedAt") or "")
        if cancel_requested_at:
            return response_fn(
                200,
                {
                    "ok": True,
                    "jobId": job_id,
                    "status": job.get("status"),
                    "alreadyRequested": True,
                    "cancelRequestedAt": cancel_requested_at,
                },
                origin=origin,
            )

        current_status = str(job.get("status") or "").lower()
        if current_status in {"complete", "failed"}:
            return response_fn(
                200,
                {
                    "ok": True,
                    "jobId": job_id,
                    "status": job.get("status"),
                    "alreadyTerminal": True,
                },
                origin=origin,
            )
        now = now_iso()
        job["cancelRequestedAt"] = now
        if request_reason:
            job["cancelReason"] = request_reason
        logs = job.setdefault("logs", [])
        if isinstance(logs, list):
            logs.append({"at": now, "message": _cancel_error_message(request_reason)})

        if current_status == "queued":
            job["status"] = "failed"
            job["finishedAt"] = now
            job["error"] = _cancel_error_message(request_reason)
            store.save_job(job)

            task_id = str(job.get("taskId") or "")
            task = store.load_task(user_id, task_id) if task_id else None
            if isinstance(task, dict):
                handled = handle_job_failure(
                    job_type=str(job.get("type") or ""),
                    job_id=job_id,
                    task_id=task_id,
                    user_id=user_id,
                    job=job,
                    store=store,
                    task=task,
                    error=RuntimeError(_cancel_error_message(request_reason)),
                    now_iso_fn=now_iso,
                    get_cleanup_track_fn=get_cleanup_track,
                    find_chunked_generation_run_fn=_find_chunked_generation_run,
                    mark_chunked_generation_run_failed_fn=_mark_chunked_generation_run_failed,
                )
                if not handled:
                    history = task.setdefault("history", [])
                    if isinstance(history, list):
                        history.append(
                            {
                                "at": now,
                                "event": "job.cancelled",
                                "jobId": job_id,
                                "jobType": str(job.get("type") or ""),
                            }
                        )
                    store.save_task(task, merge_on_conflict=True)
        else:
            store.save_job(job)

        return response_fn(
            202,
            {
                "ok": True,
                "jobId": job_id,
                "status": job.get("status"),
                "cancelRequestedAt": now,
            },
            origin=origin,
        )

    return None
