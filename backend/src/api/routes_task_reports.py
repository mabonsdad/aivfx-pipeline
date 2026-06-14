from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import CustomReportCreateRequest


def handle_task_report_routes(
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
    normalize_custom_report_refs_fn: Callable[[dict[str, Any], list[dict[str, Any]]], list[dict[str, Any]]],
    normalize_custom_report_tests_fn: Callable[[str, list[str]], list[str]],
    cleanup_custom_reports_fn: Callable[[dict[str, Any]], bool],
    decorate_embedded_s3_keys_fn: Callable[[Any, Any], None],
    report_result_key_fn: Callable[[str, str, str], str],
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    logger,
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 3 and parts[2] == "reports":
        req = json_model(CustomReportCreateRequest, event)
        raw_refs = [item.model_dump(exclude_none=True) for item in req.outputRefs]
        asset_refs = normalize_custom_report_refs_fn(task, raw_refs)
        if not asset_refs:
            return error_response_fn(400, "No valid report outputs selected", origin=origin)
        if req.reportType == "video_compare":
            generation_refs = [item for item in asset_refs if item.get("assetType") == "segment_generation"]
            if len(generation_refs) < 2:
                return error_response_fn(400, "Select at least two generated videos for a comparison report", origin=origin)
            segment_keys: set[tuple[str, int]] = set()
            for ref in generation_refs:
                generation = task.get("segmentGenerations", {}).get(ref.get("genId"))
                segment = (
                    next((item for item in task.get("segments", []) if item.get("segmentId") == generation.get("segmentId")), None)
                    if isinstance(generation, dict)
                    else None
                )
                if not isinstance(generation, dict) or generation.get("status") != "complete" or not generation.get("outputKey"):
                    return error_response_fn(400, "Comparison reports can only include completed generated videos", origin=origin)
                if not isinstance(segment, dict):
                    return error_response_fn(400, "Selected generated videos must be linked to a segment", origin=origin)
                segment_keys.add((str(segment.get("segmentId")), int(segment.get("startFrame") or 0)))
            if len(segment_keys) != 1:
                return error_response_fn(400, "Select generated videos from the same segment/start frame for this comparison report", origin=origin)
        if req.reportType == "previz_review":
            generation_refs = [item for item in asset_refs if item.get("assetType") == "segment_generation"]
            if len(generation_refs) < 1:
                return error_response_fn(400, "Select at least one generated previz video for this report", origin=origin)
            for ref in generation_refs:
                generation = task.get("segmentGenerations", {}).get(ref.get("genId"))
                workflow_id = (
                    generation.get("generationSettings", {}).get("workflowId")
                    if isinstance(generation, dict) and isinstance(generation.get("generationSettings"), dict)
                    else None
                )
                if not isinstance(generation, dict) or generation.get("status") != "complete" or not generation.get("outputKey"):
                    return error_response_fn(400, "Previz review reports can only include completed generated videos", origin=origin)
                if workflow_id != "simple_generation_workflow":
                    return error_response_fn(400, "Previz review reports only support Previz generated videos", origin=origin)
        tests = normalize_custom_report_tests_fn(req.reportType, req.tests)
        if not tests:
            return error_response_fn(400, "No valid QC tests selected", origin=origin)
        custom_reports = task.setdefault("customReports", [])
        report_type_label = (
            "QC Frame"
            if req.reportType == "qc_frame"
            else "Video Compare"
            if req.reportType == "video_compare"
            else "Previz Review"
            if req.reportType == "previz_review"
            else "QC Video"
        )
        report_name = (req.name or "").strip()
        if not report_name:
            report_name = f"{report_type_label} Report {len(custom_reports) + 1}"
        now = now_iso_fn()
        report_id = new_id_fn("report")
        result_key = report_result_key_fn(user_id, task_id, report_id)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="qc_report_build",
            payload={"reportId": report_id},
        )
        report = {
            "reportId": report_id,
            "reportType": req.reportType,
            "name": report_name[:80],
            "assetRefs": asset_refs,
            "tests": tests,
            "status": "queued",
            "jobId": job_id,
            "resultKey": result_key,
            "createdAt": now,
            "updatedAt": now,
        }
        custom_reports.append(report)
        cleanup_custom_reports_fn(task)
        store.save_task(task)
        return response_fn(201, {"reportId": report["reportId"], "report": report, "jobId": job_id}, origin=origin)

    if method == "GET" and len(parts) == 4 and parts[2] == "reports":
        report_id = parts[3]
        reports = task.get("customReports", [])
        report = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
        if not report:
            return error_response_fn(404, "Report not found", origin=origin)
        result_key = report.get("resultKey")
        payload: dict[str, Any] = {"report": report}
        if isinstance(result_key, str) and result_key:
            result_payload = store.get_json(result_key)
            if isinstance(result_payload, dict):
                decorate_embedded_s3_keys_fn(result_payload, asset_store)
                payload["result"] = result_payload
        return response_fn(200, payload, origin=origin)

    if method != "DELETE" or len(parts) != 4 or parts[2] != "reports":
        return None

    report_id = parts[3]
    reports = task.get("customReports", [])
    if not isinstance(reports, list):
        return error_response_fn(404, "Report not found", origin=origin)
    report = next((item for item in reports if isinstance(item, dict) and item.get("reportId") == report_id), None)
    before = len(reports)
    removed_report = report if isinstance(report, dict) else None
    task["customReports"] = [
        report_item
        for report_item in reports
        if not (isinstance(report_item, dict) and report_item.get("reportId") == report_id)
    ]
    if len(task["customReports"]) == before:
        return error_response_fn(404, "Report not found", origin=origin)
    result_key = report.get("resultKey") if isinstance(report, dict) else None
    if isinstance(result_key, str) and result_key:
        try:
            store.delete_json(result_key, purge_versions=True)
        except Exception:
            logger.warning("Failed to delete report result", extra={"reportId": report_id, "resultKey": result_key})
    try:
        asset_store.delete_prefix(f"{asset_paths_for_task_fn(task).report_prefix(report_id)}/", purge_versions=True)
    except Exception:
        logger.warning("Failed to delete report asset prefix", extra={"taskId": task_id, "reportId": report_id})
    removed_external_pair_ids = {
        str(asset_ref.get("pairId") or "")
        for asset_ref in (removed_report.get("assetRefs") or [])
        if isinstance(asset_ref, dict) and asset_ref.get("assetType") == "external_frame_pair" and asset_ref.get("pairId")
    } if isinstance(removed_report, dict) else set()
    if removed_external_pair_ids:
        remaining_pair_ids = {
            str(asset_ref.get("pairId") or "")
            for report_item in task["customReports"]
            if isinstance(report_item, dict)
            for asset_ref in (report_item.get("assetRefs") or [])
            if isinstance(asset_ref, dict) and asset_ref.get("assetType") == "external_frame_pair" and asset_ref.get("pairId")
        }
        keep_ids = remaining_pair_ids & removed_external_pair_ids
        if keep_ids != removed_external_pair_ids:
            kept_pairs: list[dict[str, Any]] = []
            for pair in task.get("externalQcPairs", []):
                if not isinstance(pair, dict):
                    continue
                pair_id = str(pair.get("pairId") or "")
                if pair_id not in removed_external_pair_ids or pair_id in keep_ids:
                    kept_pairs.append(pair)
                    continue
                for key_name in ("originalKey", "editedKey"):
                    key_value = pair.get(key_name)
                    if isinstance(key_value, str) and key_value:
                        try:
                            asset_store.delete_object(key_value, purge_versions=True)
                        except Exception:
                            logger.warning("Failed to delete external QC asset", extra={"taskId": task_id, "pairId": pair_id, "key": key_value})
            task["externalQcPairs"] = kept_pairs
    store.save_task(task)
    return response_fn(200, {"ok": True}, origin=origin)
