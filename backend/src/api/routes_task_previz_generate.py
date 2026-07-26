from __future__ import annotations

from typing import Any, Callable

from src.core.asset_origin import build_asset_origin
from src.models.schemas import PrevizGenerateRequest


def _find_segment(task: dict[str, Any], segment_id: str) -> dict[str, Any] | None:
    return next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)


def _provider_for_previz_model(model: str) -> str:
    if model == "veo_3_1":
        return "runware"
    if model == "happy_horse_1_0":
        return "fal"
    if model == "seedance_2_0":
        return "fal"
    return "unknown"


def handle_task_previz_generate_routes(
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
    sanitize_prompt_fn: Callable[[str], str],
) -> dict[str, Any] | None:
    if method != "POST" or len(parts) != 5 or parts[2] != "segments" or parts[4] != "previz-generate":
        return None

    if str(task.get("workflowId") or "") != "simple_generation_workflow":
        return error_response_fn(409, "Previz generation is only available on Previz workflow tasks", origin=origin)

    segment_id = parts[3]
    segment = _find_segment(task, segment_id)
    if not isinstance(segment, dict):
        return error_response_fn(404, "Segment not found", origin=origin)
    if str(segment.get("kind") or "") != "scene":
        return error_response_fn(400, "Previz generation requires the scene segment", origin=origin)

    req = json_model(PrevizGenerateRequest, event)
    if req.model not in {"veo_3_1", "happy_horse_1_0", "seedance_2_0"}:
        return error_response_fn(400, "Unsupported Previz generation model", origin=origin)

    try:
        prompt = sanitize_prompt_fn(req.prompt)
    except ValueError as exc:
        return error_response_fn(400, str(exc), origin=origin)

    previz = task.get("previz") if isinstance(task.get("previz"), dict) else {}
    if str(previz.get("syntheticSegmentId") or "").strip() and str(previz.get("syntheticSegmentId") or "").strip() != segment_id:
        return error_response_fn(400, "Previz generation must target the task scene segment", origin=origin)

    available_reference_ids = {
        str(reference.get("referenceId") or "").strip()
        for reference in task.get("editVideoReferences", [])
        if isinstance(reference, dict) and str(reference.get("referenceId") or "").strip()
    }
    selected_frame_ids = [frame_id for frame_id in req.selectedFrameIds if frame_id in available_reference_ids]
    if not selected_frame_ids:
        return error_response_fn(400, "Select at least one generated frame before creating a Previz video", origin=origin)

    gen_id = new_id_fn("gen")
    provider_name = _provider_for_previz_model(req.model)
    scene_aspect_ratio = str(req.sceneAspectRatio or previz.get("sceneAspectRatio") or "16:9").strip() or "16:9"
    duration_sec = int(req.durationSec)
    job_id = queue_job_fn(
        store=store,
        user_id=user_id,
        task_id=task_id,
        job_type="previz_generate",
        payload={
            "segmentId": segment_id,
            "genId": gen_id,
            "previzGenerateMetadata": {
                "workflowId": "simple_generation_workflow",
                "model": req.model,
                "prompt": prompt,
                "sceneAspectRatio": scene_aspect_ratio,
                "selectedFrameIds": selected_frame_ids,
                "durationSec": duration_sec,
                "scenePrompt": str(task.get("description") or previz.get("scenePrompt") or "").strip() or None,
            },
        },
    )
    now = now_iso_fn()
    task.setdefault("segmentGenerations", {})[gen_id] = {
        "genId": gen_id,
        "segmentId": segment_id,
        "luma": {
            "provider": provider_name,
            "model": req.model,
            "mode": "previz_frames",
            "prompt": prompt,
            "negativePrompt": None,
            "lumaGenerationId": None,
        },
        "generationSettings": {
            "workflowId": "simple_generation_workflow",
            "provider": provider_name,
            "requestedModel": req.model,
            "model": req.model,
            "sceneAspectRatio": scene_aspect_ratio,
            "selectedFrameIds": selected_frame_ids,
            "selectedFrameCount": len(selected_frame_ids),
            "requestedDurationSec": duration_sec,
            "scenePrompt": str(task.get("description") or previz.get("scenePrompt") or "").strip() or None,
        },
        "origin": build_asset_origin(
            workflow_id="simple_generation_workflow",
            step_origin="generate",
            tool_origin="previz_generate",
            creation_mode="previz",
        ),
        "status": "queued",
        "outputKey": None,
        "posterKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now,
        "createdAt": now,
        "updatedAt": now,
    }
    task.setdefault("history", []).append(
        {
            "at": now,
            "event": "previz_generation.queued",
            "jobId": job_id,
            "genId": gen_id,
            "segmentId": segment_id,
            "model": req.model,
        }
    )
    store.save_task(task, merge_on_conflict=True)
    return response_fn(202, {"jobId": job_id, "genId": gen_id}, origin=origin)
