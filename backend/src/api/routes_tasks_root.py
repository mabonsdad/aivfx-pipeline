from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import TaskCreateRequest


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
    normalize_task_name_fn: Callable[[str], str],
    unique_task_name_fn: Callable[[str, set[str]], str],
    build_file_prefix_fn: Callable[[str, str, set[str]], str],
    load_task_or_404_fn: Callable[..., dict[str, Any]],
    maintain_segment_generations_fn: Callable[..., bool],
    cleanup_legacy_generation_qc_fn: Callable[..., bool],
    cleanup_custom_reports_fn: Callable[..., bool],
    task_summary_fn: Callable[[dict[str, Any]], dict[str, Any]],
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
        task = {
            "taskId": task_id,
            "userId": user_id,
            "name": unique_name,
            "filePrefix": file_prefix,
            "createdAt": now,
            "updatedAt": now,
            "status": "created",
            "video": {},
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
        }
        store.save_task(task)
        return response_fn(201, {"taskId": task_id}, origin=origin)

    if method == "GET" and path == "/tasks":
        task_items = store.list_tasks(user_id)
        for item in task_items:
            changed = maintain_segment_generations_fn(item, store)
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
        task["status"] = "error"
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    return None
