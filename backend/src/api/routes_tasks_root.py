from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import TaskCreateRequest


def _ensure_previz_bootstrap(task: dict[str, Any], *, new_id_fn: Callable[[str], str]) -> bool:
    if str(task.get("workflowId") or "") != "simple_generation_workflow":
        return False

    changed = False
    previz = task.get("previz")
    if not isinstance(previz, dict):
        previz = {}
        task["previz"] = previz
        changed = True

    if "scenePrompt" not in previz:
        previz["scenePrompt"] = ""
        changed = True
    if "sceneAspectRatio" not in previz:
        previz["sceneAspectRatio"] = None
        changed = True
    if not isinstance(previz.get("selectedReferenceIds"), list):
        previz["selectedReferenceIds"] = []
        changed = True
    if not isinstance(previz.get("frameReferenceIds"), list):
        previz["frameReferenceIds"] = []
        changed = True
    if not isinstance(previz.get("selectedFrameIds"), list):
        previz["selectedFrameIds"] = []
        changed = True

    segments = task.setdefault("segments", [])
    synthetic_segment_id = str(previz.get("syntheticSegmentId") or "").strip()
    existing_synthetic = next(
        (
            item
            for item in segments
            if isinstance(item, dict)
            and (
                (synthetic_segment_id and item.get("segmentId") == synthetic_segment_id)
                or item.get("kind") == "scene"
            )
        ),
        None,
    )
    if not isinstance(existing_synthetic, dict):
        segment_id = new_id_fn("seg")
        existing_synthetic = {
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
        segments.append(existing_synthetic)
        previz["syntheticSegmentId"] = segment_id
        changed = True
    else:
        if existing_synthetic.get("kind") != "scene":
            existing_synthetic["kind"] = "scene"
            changed = True
        if existing_synthetic.get("label") != "Scene":
            existing_synthetic["label"] = "Scene"
            changed = True
        segment_id = str(existing_synthetic.get("segmentId") or "").strip()
        if segment_id and previz.get("syntheticSegmentId") != segment_id:
            previz["syntheticSegmentId"] = segment_id
            changed = True

    return changed


def handle_tasks_root_routes(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    store,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
    normalize_task_name_fn: Callable[[str], str],
    unique_task_name_fn: Callable[[str, set[str]], str],
    build_file_prefix_fn: Callable[[str, str, set[str]], str],
    load_task_or_404_fn: Callable[..., dict[str, Any]],
    maintain_segment_generations_fn: Callable[..., bool],
    cleanup_legacy_generation_qc_fn: Callable[..., bool],
    cleanup_custom_reports_fn: Callable[..., bool],
    task_summary_fn: Callable[[dict[str, Any]], dict[str, Any]],
    default_task_workflow_id: str,
) -> dict[str, Any] | None:
    if method == "POST" and path == "/tasks":
        req = json_model(TaskCreateRequest, event)
        existing_tasks = store.list_tasks(user_id)
        existing_names = {str(item.get("name", "")).lower() for item in existing_tasks}
        task_id = new_id_fn("task")
        normalized_name = normalize_task_name_fn(req.name)
        unique_name = unique_task_name_fn(normalized_name, existing_names)
        existing_prefixes = {str(item.get("filePrefix", "")) for item in existing_tasks if item.get("filePrefix")}
        file_prefix = build_file_prefix_fn(unique_name, task_id, existing_prefixes)
        now = now_iso_fn()
        previz = {
            "scenePrompt": (req.scenePrompt or "").strip(),
            "sceneAspectRatio": None,
            "selectedReferenceIds": [],
            "frameReferenceIds": [],
            "selectedFrameIds": [],
            "syntheticSegmentId": None,
        }
        task = {
            "taskId": task_id,
            "userId": user_id,
            "name": unique_name,
            "workflowId": req.workflowId,
            "filePrefix": file_prefix,
            "createdAt": now,
            "updatedAt": now,
            "status": "created",
            "video": {},
            "sourceMedia": {},
            "segments": [],
            "frames": {},
            "segmentGenerations": {},
            "chunkedGenerationRuns": [],
            "externalQcPairs": [],
            "qualityMatchAnalyses": {},
            "videoCleanupTracks": [],
            "editVideoReferences": [],
            "exports": [],
            "customReports": [],
            "history": [],
            "metaVersion": 0,
            "previz": previz,
        }
        _ensure_previz_bootstrap(task, new_id_fn=new_id_fn)
        store.save_task(task)
        return response_fn(201, {"taskId": task_id}, origin=origin)

    if method == "GET" and path == "/tasks":
        task_items = store.list_tasks(user_id)
        for item in task_items:
            changed = False
            if not item.get("workflowId"):
                item["workflowId"] = default_task_workflow_id
                changed = True
            changed = _ensure_previz_bootstrap(item, new_id_fn=new_id_fn) or changed
            changed = maintain_segment_generations_fn(item, store) or changed
            changed = cleanup_legacy_generation_qc_fn(item) or changed
            changed = cleanup_custom_reports_fn(item) or changed
            if changed:
                store.save_task(item)
        tasks = [task_summary_fn(item) for item in task_items]
        return response_fn(200, {"tasks": tasks}, origin=origin)

    if method == "DELETE" and path.startswith("/tasks/") and path.count("/") == 2:
        task_id = path.split("/")[2]
        try:
            task = load_task_or_404_fn(store, user_id, task_id)
        except KeyError:
            return error_response_fn(404, "Task not found", origin=origin)
        task["deletedAt"] = now_iso_fn()
        task["status"] = "deleting"
        task["purgeJobId"] = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="task_purge",
            payload={},
        )
        store.save_task(task)
        return response_fn(200, {"ok": True, "purgeJobId": task["purgeJobId"]}, origin=origin)

    return None
