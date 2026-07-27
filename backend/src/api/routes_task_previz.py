from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import PrevizUpdateRequest


def _normalized_unique_ids(values: list[str] | None) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for raw in values or []:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def handle_task_previz_route(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    user_id: str,
    store,
    origin: str | None,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    load_task_or_404_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
) -> dict[str, Any] | None:
    if method != "PATCH" or not path.startswith("/tasks/") or not path.endswith("/previz"):
        return None

    parts = path.strip("/").split("/")
    if len(parts) != 3 or parts[0] != "tasks" or parts[2] != "previz":
        return None

    task_id = parts[1]
    try:
        task = load_task_or_404_fn(store, user_id, task_id)
    except KeyError:
        return error_response_fn(404, "Task not found", origin=origin)

    if str(task.get("workflowId") or "") != "simple_generation_workflow":
        return error_response_fn(400, "Previz settings are only available for Previz tasks", origin=origin)

    req = json_model(PrevizUpdateRequest, event)
    previz = task.get("previz")
    if not isinstance(previz, dict):
        previz = {}
        task["previz"] = previz

    changed = False
    if req.scenePrompt is not None:
        next_prompt = req.scenePrompt.strip()
        if str(task.get("description") or "").strip() != next_prompt:
            task["description"] = next_prompt
            changed = True
        if previz.get("scenePrompt") != next_prompt:
            previz["scenePrompt"] = next_prompt
            changed = True
    if req.sceneAspectRatio is not None:
        next_aspect_ratio = req.sceneAspectRatio.strip() or None
        if previz.get("sceneAspectRatio") != next_aspect_ratio:
            previz["sceneAspectRatio"] = next_aspect_ratio
            changed = True

    reference_ids = None if req.selectedReferenceIds is None else _normalized_unique_ids(req.selectedReferenceIds)
    if reference_ids is not None:
        available_reference_ids = {
            str(reference.get("referenceId") or "").strip()
            for reference in task.get("editVideoReferences", [])
            if isinstance(reference, dict) and str(reference.get("referenceId") or "").strip()
        }
        filtered_reference_ids = [reference_id for reference_id in reference_ids if reference_id in available_reference_ids]
        if previz.get("selectedReferenceIds") != filtered_reference_ids:
            previz["selectedReferenceIds"] = filtered_reference_ids
            changed = True

    frame_reference_ids = None if req.frameReferenceIds is None else _normalized_unique_ids(req.frameReferenceIds)
    if frame_reference_ids is not None:
        available_reference_ids = {
            str(reference.get("referenceId") or "").strip()
            for reference in task.get("editVideoReferences", [])
            if isinstance(reference, dict) and str(reference.get("referenceId") or "").strip()
        }
        filtered_frame_reference_ids = [reference_id for reference_id in frame_reference_ids if reference_id in available_reference_ids]
        if previz.get("frameReferenceIds") != filtered_frame_reference_ids:
            previz["frameReferenceIds"] = filtered_frame_reference_ids
            changed = True

    frame_ids = None if req.selectedFrameIds is None else _normalized_unique_ids(req.selectedFrameIds)
    if frame_ids is not None:
        available_frame_ids = {
            str(frame_id or "").strip()
            for frame_id in (
                frame_reference_ids
                if frame_reference_ids is not None
                else previz.get("frameReferenceIds")
                if isinstance(previz.get("frameReferenceIds"), list)
                else []
            )
            if str(frame_id or "").strip()
        }
        filtered_frame_ids = [frame_id for frame_id in frame_ids if frame_id in available_frame_ids]
        if previz.get("selectedFrameIds") != filtered_frame_ids:
            previz["selectedFrameIds"] = filtered_frame_ids
            changed = True

    synthetic_segment_id = str(previz.get("syntheticSegmentId") or "").strip()
    segments = task.setdefault("segments", [])
    has_scene_segment = any(
        isinstance(segment, dict)
        and (
            segment.get("kind") == "scene"
            or (synthetic_segment_id and str(segment.get("segmentId") or "").strip() == synthetic_segment_id)
        )
        for segment in segments
    )
    if not has_scene_segment:
        segment_id = synthetic_segment_id or new_id_fn("seg")
        segments.append(
            {
                "segmentId": segment_id,
                "kind": "scene",
                "label": "Scene",
                "startFrame": 0,
                "endFrameExclusive": 0,
                "durationFrames": 0,
                "durationSec": 0,
                "startTimecode": "00:00:00:00",
                "endTimecode": "00:00:00:00",
                "startFrameId": "",
                "endFrameId": "",
                "selectedGenerationId": None,
                "segmentClipKey": None,
                "segmentClipUpdatedAt": None,
                "crop": None,
            }
        )
        previz["syntheticSegmentId"] = segment_id
        changed = True

    if changed:
        task["updatedAt"] = now_iso_fn()
        store.save_task(task)

    return response_fn(200, {"previz": previz}, origin=origin)
