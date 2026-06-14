from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import ExportTopazUpscaleRequest


def handle_task_generation_topaz_route(
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
    if method != "POST" or len(parts) != 5 or parts[2] != "segment-generations" or parts[4] != "topaz-upscale":
        return None

    gen_id = parts[3]
    generation = task.get("segmentGenerations", {}).get(gen_id)
    if not isinstance(generation, dict):
        return error_response_fn(404, "Generation not found", origin=origin)
    if generation.get("status") != "complete" or not generation.get("outputKey"):
        return error_response_fn(400, "Generation output unavailable", origin=origin)

    req = json_model(ExportTopazUpscaleRequest, event)
    exports = task.setdefault("exports", [])
    source_export = next(
        (
            entry
            for entry in exports
            if isinstance(entry, dict)
            and entry.get("internalOnlySource") is True
            and entry.get("sourceGenerationId") == gen_id
            and entry.get("outputKey") == generation.get("outputKey")
        ),
        None,
    )
    if not isinstance(source_export, dict):
        source_export = {
            "exportId": new_id_fn("exp"),
            "outputKey": generation.get("outputKey"),
            "createdAt": generation.get("finishedAt") or generation.get("createdAt") or now_iso_fn(),
            "selectedSegmentGenerationIds": [gen_id],
            "sourceGenerationId": gen_id,
            "workflowId": generation.get("generationSettings", {}).get("workflowId") or task.get("workflowId"),
            "internalOnlySource": True,
        }
        exports.append(source_export)

    upscale_state = source_export.get("topazUpscale") if isinstance(source_export.get("topazUpscale"), dict) else {}
    existing_job_id = upscale_state.get("jobId")
    existing_result_export_id = upscale_state.get("resultExportId")
    if (
        not req.force
        and isinstance(existing_job_id, str)
        and upscale_state.get("status") in {"queued", "running"}
    ):
        return response_fn(
            202,
            {
                "jobId": existing_job_id,
                "exportId": existing_result_export_id,
                "sourceExportId": source_export.get("exportId"),
                "generationId": gen_id,
                "alreadyRunning": True,
            },
            origin=origin,
        )

    result_export_id = new_id_fn("exp")
    job_id = queue_job_fn(
        store=store,
        user_id=user_id,
        task_id=task_id,
        job_type="export_topaz_upscale",
        payload={
            "sourceExportId": source_export["exportId"],
            "resultExportId": result_export_id,
            "request": {
                "preset": req.preset,
                "model": req.model,
                "upscaleFactor": req.upscaleFactor,
                "targetFps": req.targetFps,
                "h264Output": req.h264Output,
            },
        },
    )
    source_export["topazUpscale"] = {
        "status": "queued",
        "updatedAt": now_iso_fn(),
        "jobId": job_id,
        "resultExportId": result_export_id,
        "preset": req.preset,
        "model": req.model,
        "upscaleFactor": req.upscaleFactor,
        "targetFps": req.targetFps,
        "h264Output": req.h264Output,
    }
    store.save_task(task, merge_on_conflict=True)
    return response_fn(
        202,
        {
            "jobId": job_id,
            "exportId": result_export_id,
            "sourceExportId": source_export.get("exportId"),
            "generationId": gen_id,
        },
        origin=origin,
    )
