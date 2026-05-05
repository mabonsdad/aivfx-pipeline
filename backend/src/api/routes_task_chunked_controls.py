from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import (
    ChunkedGenerationCancelRequest,
    ChunkedGenerationPauseRequest,
    ChunkedGenerationRestartRequest,
    ChunkedGenerationSaveDraftRequest,
)


def _find_run(task: dict[str, Any], run_id: str) -> dict[str, Any] | None:
    return next((item for item in task.get("chunkedGenerationRuns", []) if isinstance(item, dict) and item.get("runId") == run_id), None)


def _chunks_for_run(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [chunk for chunk in run.get("chunks", []) if isinstance(chunk, dict)]


def handle_task_chunked_control_routes(
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
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
    sanitize_prompt_fn: Callable[[str], str],
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    copy_generated_anchor_to_frame_variant_fn: Callable[..., dict[str, Any]],
    queue_chunk_generation_for_run_fn: Callable[..., tuple[str, str]],
    logger,
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "pause":
        run = _find_run(task, parts[3])
        if not isinstance(run, dict):
            return error_response_fn(404, "Chunked generation run not found", origin=origin)
        req = json_model(ChunkedGenerationPauseRequest, event)
        now = now_iso_fn()
        run["status"] = "paused"
        run["pauseRequestedAt"] = now
        run["pauseReason"] = req.reason or "Paused by user"
        run["updatedAt"] = now
        store.save_task(task, merge_on_conflict=True)
        return response_fn(200, {"ok": True}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "resume":
        run = _find_run(task, parts[3])
        if not isinstance(run, dict):
            return error_response_fn(404, "Chunked generation run not found", origin=origin)
        chunks = _chunks_for_run(run)
        active_chunk = next((chunk for chunk in chunks if chunk.get("status") in {"queued", "running"}), None)
        pending_chunk = None if isinstance(active_chunk, dict) else next((chunk for chunk in chunks if chunk.get("status") in {"planned", "failed"}), None)
        run["status"] = "running"
        run["updatedAt"] = now_iso_fn()
        if isinstance(pending_chunk, dict):
            chunk_index = int(pending_chunk.get("chunkIndex") or 0)
            prompt = pending_chunk.get("prompt")
            parent_generation_id: str | None = None
            if chunk_index == 0:
                first_frame_variant_id = str(run.get("firstFrameVariantId") or "")
            else:
                previous_chunk = chunks[chunk_index - 1]
                previous_generation = task.get("segmentGenerations", {}).get(previous_chunk.get("generationId") or "")
                if not isinstance(previous_generation, dict) or previous_generation.get("status") != "complete":
                    return error_response_fn(400, "Cannot resume until the previous chunk is complete", origin=origin)
                anchor_variant = copy_generated_anchor_to_frame_variant_fn(
                    task=task,
                    generation=previous_generation,
                    target_frame_id=str(pending_chunk.get("anchorFrameId") or ""),
                    target_frame_index=int(pending_chunk.get("segmentStartFrame") or 0),
                    anchor_frames_from_end=int(pending_chunk.get("anchorFramesFromPrevious") or 0),
                    asset_store=asset_store,
                )
                first_frame_variant_id = str(anchor_variant.get("variantId") or "")
                pending_chunk["anchorVariantId"] = first_frame_variant_id
                pending_chunk["sourceGeneratedFrameIndex"] = anchor_variant.get("sourceGeneratedFrameIndex")
                parent_generation_id = str(previous_chunk.get("generationId") or "")
            queue_chunk_generation_for_run_fn(
                task=task,
                store=store,
                user_id=user_id,
                task_id=task_id,
                run=run,
                chunk=pending_chunk,
                model=str(run.get("model") or ""),
                mode=str(run.get("mode") or ""),
                prompt=str(prompt) if prompt else None,
                negative_prompt=None,
                first_frame_variant_id=first_frame_variant_id or None,
                replicate_kling_mode=run.get("replicateKlingMode"),
                replicate_kling_v3_mode=run.get("replicateKlingV3Mode"),
                wan27_resolution=run.get("wan27Resolution"),
                happy_horse_resolution=run.get("happyHorseResolution"),
                preserve_frames=bool(run.get("preserveFrames", True)),
                parent_generation_id=parent_generation_id or None,
                extension_metadata={
                    "chunkedRunId": run.get("runId"),
                    "chunkIndex": pending_chunk.get("chunkIndex"),
                    "sourceSegmentId": run.get("sourceSegmentId"),
                    "alignmentFrameIndex": pending_chunk.get("segmentStartFrame"),
                    "anchorFramesFromEnd": pending_chunk.get("anchorFramesFromPrevious", 0),
                    "anchorVariantId": pending_chunk.get("anchorVariantId"),
                    "createdAt": now_iso_fn(),
                },
            )
        store.save_task(task, merge_on_conflict=True)
        return response_fn(200, {"ok": True, "jobId": pending_chunk.get("jobId") if isinstance(pending_chunk, dict) else None}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "restart":
        run = _find_run(task, parts[3])
        if not isinstance(run, dict):
            return error_response_fn(404, "Chunked generation run not found", origin=origin)
        req = json_model(ChunkedGenerationRestartRequest, event)
        chunks = _chunks_for_run(run)
        if req.fromChunkIndex >= len(chunks):
            return error_response_fn(400, "Chunk index is outside the run", origin=origin)
        if req.fromChunkIndex > 0:
            previous_chunk = chunks[req.fromChunkIndex - 1]
            previous_generation = task.get("segmentGenerations", {}).get(previous_chunk.get("generationId") or "")
            if not isinstance(previous_generation, dict) or previous_generation.get("status") != "complete":
                return error_response_fn(400, "Restart requires the previous chunk generation to be complete", origin=origin)

        chunk = chunks[req.fromChunkIndex]
        prompt = sanitize_prompt_fn(req.prompt) if req.prompt is not None else chunk.get("prompt")
        if req.fromChunkIndex <= 0:
            run["openingPrompt"] = prompt
            run["continuationPrompt"] = run.get("continuationPrompt") or prompt
        else:
            run["continuationPrompt"] = prompt
        run["status"] = "running"
        run["activeChunkIndex"] = req.fromChunkIndex
        run["updatedAt"] = now_iso_fn()
        run.pop("failureChunkIndex", None)
        run.pop("pauseRequestedAt", None)
        run.pop("pauseReason", None)

        for restart_chunk in chunks[req.fromChunkIndex:]:
            restart_chunk["status"] = "planned"
            restart_chunk["reviewStatus"] = "pending"
            restart_chunk["prompt"] = prompt
            restart_chunk.pop("generationId", None)
            restart_chunk.pop("jobId", None)
            restart_chunk.pop("error", None)
            restart_chunk["updatedAt"] = now_iso_fn()

        first_frame_variant_id: str | None
        parent_generation_id: str | None = None
        if req.fromChunkIndex == 0:
            first_frame_variant_id = str(run.get("firstFrameVariantId") or "")
        else:
            previous_chunk = chunks[req.fromChunkIndex - 1]
            previous_generation = task.get("segmentGenerations", {}).get(previous_chunk.get("generationId") or "")
            anchor_variant = copy_generated_anchor_to_frame_variant_fn(
                task=task,
                generation=previous_generation,
                target_frame_id=str(chunk.get("anchorFrameId") or ""),
                target_frame_index=int(chunk.get("segmentStartFrame") or 0),
                anchor_frames_from_end=int(chunk.get("anchorFramesFromPrevious") or 0),
                asset_store=asset_store,
            )
            first_frame_variant_id = str(anchor_variant.get("variantId") or "")
            chunk["anchorVariantId"] = first_frame_variant_id
            chunk["sourceGeneratedFrameIndex"] = anchor_variant.get("sourceGeneratedFrameIndex")
            parent_generation_id = str(previous_chunk.get("generationId") or "")

        queue_chunk_generation_for_run_fn(
            task=task,
            store=store,
            user_id=user_id,
            task_id=task_id,
            run=run,
            chunk=chunk,
            model=str(run.get("model") or ""),
            mode=str(run.get("mode") or ""),
            prompt=str(prompt) if prompt else None,
            negative_prompt=None,
            first_frame_variant_id=first_frame_variant_id or None,
            replicate_kling_mode=run.get("replicateKlingMode"),
            replicate_kling_v3_mode=run.get("replicateKlingV3Mode"),
            wan27_resolution=run.get("wan27Resolution"),
            happy_horse_resolution=run.get("happyHorseResolution"),
            preserve_frames=bool(run.get("preserveFrames", True)),
            parent_generation_id=parent_generation_id or None,
            extension_metadata={
                "chunkedRunId": run.get("runId"),
                "chunkIndex": req.fromChunkIndex,
                "sourceSegmentId": run.get("sourceSegmentId"),
                "alignmentFrameIndex": chunk.get("segmentStartFrame"),
                "anchorFramesFromEnd": chunk.get("anchorFramesFromPrevious", 0),
                "anchorVariantId": chunk.get("anchorVariantId"),
                "createdAt": now_iso_fn(),
            },
        )
        store.save_task(task, merge_on_conflict=True)
        return response_fn(202, {"ok": True, "jobId": chunk.get("jobId"), "genId": chunk.get("generationId")}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "save-draft":
        run = _find_run(task, parts[3])
        if not isinstance(run, dict):
            return error_response_fn(404, "Chunked generation run not found", origin=origin)
        json_model(ChunkedGenerationSaveDraftRequest, event)
        if run.get("status") != "complete":
            return error_response_fn(400, "Chunked generation must complete before it can be saved", origin=origin)
        if run.get("saveStatus") in {"queued", "running"}:
            return error_response_fn(409, "Chunked generation draft save is already in progress", origin=origin)
        save_job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="chunked_generation_finalize",
            payload={"runId": run.get("runId")},
        )
        run["saveStatus"] = "queued"
        run["saveJobId"] = save_job_id
        run["saveError"] = None
        run["updatedAt"] = now_iso_fn()
        store.save_task(task, merge_on_conflict=True)
        return response_fn(202, {"ok": True, "jobId": save_job_id}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "chunked-generations" and parts[4] == "cancel":
        run = _find_run(task, parts[3])
        if not isinstance(run, dict):
            return error_response_fn(404, "Chunked generation run not found", origin=origin)
        req = json_model(ChunkedGenerationCancelRequest, event)
        if run.get("saveStatus") in {"queued", "running"}:
            return error_response_fn(409, "Cannot cancel while the stitched draft is being saved", origin=origin)
        now = now_iso_fn()
        run["status"] = "canceled"
        run["canceledAt"] = now
        run["updatedAt"] = now
        run["pauseReason"] = req.reason or "Canceled by user"
        internal_generation_ids = {
            str(chunk.get("generationId"))
            for chunk in run.get("chunks", [])
            if isinstance(chunk, dict) and chunk.get("generationId")
        }
        for generation_id in internal_generation_ids:
            generation = task.get("segmentGenerations", {}).get(generation_id)
            if not isinstance(generation, dict):
                continue
            for key_name in ("outputKey", "inputMediaKey", "inputFirstFrameKey", "inputLastFrameKey"):
                key_value = generation.get(key_name)
                if isinstance(key_value, str) and key_value:
                    try:
                        asset_store.delete_object(key_value)
                    except Exception:
                        logger.exception("Failed to delete canceled chunk asset", extra={"taskId": task_id, "genId": generation_id, "key": key_value})
            generation["status"] = "failed"
            generation["error"] = "Canceled by user"
            generation["updatedAt"] = now
            generation["finishedAt"] = now
        append_history_event_fn(
            task,
            {
                "at": now,
                "event": "chunked_generation.canceled",
                "runId": run.get("runId"),
            },
        )
        store.save_task(task, merge_on_conflict=True)
        return response_fn(200, {"ok": True}, origin=origin)

    return None
