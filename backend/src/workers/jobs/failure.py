from __future__ import annotations

from typing import Any, Callable


def handle_job_failure(
    *,
    job_type: str,
    job_id: str,
    task_id: str | None,
    user_id: str,
    job: dict[str, Any],
    store,
    task: dict[str, Any] | None,
    error: Exception,
    now_iso_fn: Callable[[], str],
    get_cleanup_track_fn: Callable[[dict[str, Any], str], dict[str, Any] | None],
    find_chunked_generation_run_fn: Callable[[dict[str, Any], str], dict[str, Any] | None],
    mark_chunked_generation_run_failed_fn: Callable[..., None],
) -> bool:
    if job_type.startswith("api_"):
        request_id = str((job.get("payload") or {}).get("requestId") or "")
        request_record = store.load_api_request(user_id, request_id) if request_id else None
        if isinstance(request_record, dict):
            request_record["status"] = "failed"
            request_record["finishedAt"] = now_iso_fn()
            request_record["error"] = {"code": "job_failed", "message": str(error)}
            request_logs = request_record.setdefault("logs", [])
            if isinstance(request_logs, list):
                request_logs.append({"at": now_iso_fn(), "message": f"Failed: {error}"})
            store.save_api_request(request_record)
        return True

    latest_task = store.load_task(user_id, str(task_id or "")) or task
    if not isinstance(latest_task, dict):
        return False

    if job_type == "segment_generate":
        gen_id = str((job.get("payload") or {}).get("genId") or "")
        generation = latest_task.setdefault("segmentGenerations", {}).get(gen_id)
        if isinstance(generation, dict):
            generation["status"] = "failed"
            generation["error"] = str(error)
            generation["updatedAt"] = now_iso_fn()
            generation["finishedAt"] = now_iso_fn()
            generation["jobId"] = job_id
            latest_task.setdefault("history", []).append(
                {
                    "at": now_iso_fn(),
                    "event": "segment_generation.failed",
                    "jobId": job_id,
                    "genId": gen_id,
                }
            )
            store.save_task(latest_task, merge_on_conflict=True)
            refreshed_task = store.load_task(user_id, str(task_id or ""))
            if isinstance(refreshed_task, dict):
                mark_chunked_generation_run_failed_fn(
                    store=store,
                    task=refreshed_task,
                    gen_id=gen_id,
                    error=str(error),
                )
            return True

    if job_type == "qc_report_build":
        report_id = str((job.get("payload") or {}).get("reportId") or "")
        reports = latest_task.get("customReports", [])
        report_record = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
        if isinstance(report_record, dict):
            report_record["status"] = "failed"
            report_record["updatedAt"] = now_iso_fn()
            report_record["error"] = str(error)
            store.save_task(latest_task, merge_on_conflict=True)
        return True

    if job_type == "edit_video_reference_generate":
        reference_id = str((job.get("payload") or {}).get("referenceId") or "")
        references = latest_task.get("editVideoReferences", [])
        reference_record = next(
            (item for item in references if isinstance(item, dict) and item.get("referenceId") == reference_id),
            None,
        )
        if isinstance(reference_record, dict):
            reference_record["status"] = "failed"
            reference_record["updatedAt"] = now_iso_fn()
            reference_record["error"] = str(error)
            reference_record["jobId"] = job_id
            latest_task.setdefault("history", []).append(
                {
                    "at": now_iso_fn(),
                    "event": "edit_video_reference.failed",
                    "jobId": job_id,
                    "referenceId": reference_id,
                }
            )
            store.save_task(latest_task, merge_on_conflict=True)
        return True

    if job_type.startswith("video_cleanup_"):
        track_id = str((job.get("payload") or {}).get("trackId") or "")
        track = get_cleanup_track_fn(latest_task, track_id) if track_id else None
        if isinstance(track, dict):
            track["status"] = "failed"
            track["updatedAt"] = now_iso_fn()
            track["error"] = str(error)
        latest_task.setdefault("history", []).append(
            {
                "at": now_iso_fn(),
                "event": "video_cleanup.failed",
                "jobId": job_id,
                "trackId": track_id,
            }
        )
        store.save_task(latest_task, merge_on_conflict=True)
        return True

    if job_type == "chunked_generation_finalize":
        run_id = str((job.get("payload") or {}).get("runId") or "")
        run = find_chunked_generation_run_fn(latest_task, run_id) if run_id else None
        if isinstance(run, dict):
            run["saveStatus"] = "failed"
            run["saveError"] = str(error)
            run["updatedAt"] = now_iso_fn()
            store.save_task(latest_task, merge_on_conflict=True)
        return True

    if job_type == "merge_alignment_suggestion":
        gen_id = str((job.get("payload") or {}).get("genId") or "")
        generation = latest_task.setdefault("segmentGenerations", {}).get(gen_id)
        if isinstance(generation, dict):
            generation["mergeAlignmentSuggestion"] = {
                "status": "failed",
                "jobId": job_id,
                "updatedAt": now_iso_fn(),
                "error": str(error),
            }
            store.save_task(latest_task, merge_on_conflict=True)
        return True

    if job_type == "generation_reconcile_timing":
        payload = job.get("payload") or {}
        gen_id = str(payload.get("genId") or "")
        source_gen_id = str(payload.get("sourceGenId") or "")
        generation = latest_task.setdefault("segmentGenerations", {}).get(gen_id)
        if isinstance(generation, dict):
            generation["status"] = "failed"
            generation["error"] = str(error)
            generation["updatedAt"] = now_iso_fn()
            generation["finishedAt"] = now_iso_fn()
        source_generation = latest_task.setdefault("segmentGenerations", {}).get(source_gen_id)
        if isinstance(source_generation, dict):
            source_generation["timingReconcile"] = {
                "status": "failed",
                "jobId": job_id,
                "resultGenId": gen_id,
                "updatedAt": now_iso_fn(),
                "error": str(error),
            }
        store.save_task(latest_task, merge_on_conflict=True)
        return True

    if job_type == "export_topaz_upscale":
        payload = job.get("payload") or {}
        source_export_id = str(payload.get("sourceExportId") or "")
        result_export_id = str(payload.get("resultExportId") or "")
        exports = latest_task.get("exports")
        if isinstance(exports, list):
            source_export = next((item for item in exports if isinstance(item, dict) and item.get("exportId") == source_export_id), None)
            if isinstance(source_export, dict):
                source_export["topazUpscale"] = {
                    "status": "failed",
                    "jobId": job_id,
                    "updatedAt": now_iso_fn(),
                    "resultExportId": result_export_id or None,
                    "error": str(error),
                }
        store.save_task(latest_task, merge_on_conflict=True)
        return True

    return False
