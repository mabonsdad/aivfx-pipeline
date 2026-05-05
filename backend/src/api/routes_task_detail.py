from __future__ import annotations

import json
from typing import Any


def handle_task_detail_route(
    method: str,
    path: str,
    *,
    user_id: str,
    store,
    asset_store,
    origin: str | None,
    response_fn,
    error_response_fn,
    helpers: dict[str, Any],
) -> dict[str, Any] | None:
    if method != "GET" or not path.startswith("/tasks/") or path.count("/") != 2:
        return None

    task_id = path.split("/")[2]
    try:
        task = helpers["load_task_or_404"](store, user_id, task_id)
    except KeyError:
        return error_response_fn(404, "Task not found", origin=origin)

    changed = helpers["reconcile_segment_generation_job_states"](task, store)
    changed = helpers["prune_stale_segment_generations"](task, store) or changed
    changed = helpers["backfill_segment_generation_preview_refs"](task) or changed
    changed = helpers["cleanup_legacy_generation_qc"](task) or changed
    changed = helpers["cleanup_custom_reports"](task) or changed
    if changed:
        store.save_task(task)

    decorated = json.loads(json.dumps(task))
    if decorated.get("status") == "error" and decorated.get("video", {}).get("editSource", {}).get("s3Key"):
        decorated["status"] = "ready"
    if decorated.get("video", {}).get("original", {}).get("s3Key"):
        decorated["video"]["original"]["downloadUrl"] = asset_store.presign_get(
            decorated["video"]["original"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("video", {}).get("editSource", {}).get("s3Key"):
        decorated["video"]["editSource"]["downloadUrl"] = asset_store.presign_get(
            decorated["video"]["editSource"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("video", {}).get("previewSource", {}).get("s3Key"):
        decorated["video"]["previewSource"]["downloadUrl"] = asset_store.presign_get(
            decorated["video"]["previewSource"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    for _, frame in decorated.get("frames", {}).items():
        frame["imageUrl"] = asset_store.presign_get(frame["captureKey"], expires=helpers["presigned_get_ttl_seconds"])
        for variant in frame.get("variants", []):
            variant["imageUrl"] = asset_store.presign_get(variant["outputKey"], expires=helpers["presigned_get_ttl_seconds"])
            patch_meta = variant.get("patchMeta")
            if isinstance(patch_meta, dict):
                patch_only_key = patch_meta.get("patchOnlyKey")
                if patch_only_key:
                    patch_meta["patchOnlyUrl"] = asset_store.presign_get(patch_only_key, expires=helpers["presigned_get_ttl_seconds"])
                mask_key = patch_meta.get("maskKey")
                if mask_key:
                    patch_meta["maskUrl"] = asset_store.presign_get(mask_key, expires=helpers["presigned_get_ttl_seconds"])
                ref_key = patch_meta.get("referenceImageKey")
                if ref_key:
                    patch_meta["referenceImageUrl"] = asset_store.presign_get(ref_key, expires=helpers["presigned_get_ttl_seconds"])
        if frame.get("qualityMatchStatus"):
            helpers["decorate_embedded_s3_keys"](frame["qualityMatchStatus"], asset_store)
    for segment in decorated.get("segments", []):
        clip_key = segment.get("segmentClipKey")
        if clip_key:
            segment["segmentClipUrl"] = asset_store.presign_get(clip_key, expires=helpers["presigned_get_ttl_seconds"])
    if decorated.get("qualityMatchAnalyses"):
        helpers["decorate_embedded_s3_keys"](decorated["qualityMatchAnalyses"], asset_store)
    if decorated.get("videoCleanupTracks"):
        helpers["decorate_embedded_s3_keys"](decorated["videoCleanupTracks"], asset_store)
    for _, generation in decorated.get("segmentGenerations", {}).items():
        if generation.get("outputKey"):
            generation["downloadUrl"] = asset_store.presign_get(generation["outputKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputMediaKey"):
            generation["inputMediaUrl"] = asset_store.presign_get(generation["inputMediaKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputFirstFrameKey"):
            generation["inputFirstFrameUrl"] = asset_store.presign_get(generation["inputFirstFrameKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputLastFrameKey"):
            generation["inputLastFrameUrl"] = asset_store.presign_get(generation["inputLastFrameKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("sourceFirstFrameCaptureKey"):
            generation["sourceFirstFrameCaptureUrl"] = asset_store.presign_get(
                generation["sourceFirstFrameCaptureKey"], expires=helpers["presigned_get_ttl_seconds"]
            )
        if generation.get("sourceLastFrameCaptureKey"):
            generation["sourceLastFrameCaptureUrl"] = asset_store.presign_get(
                generation["sourceLastFrameCaptureKey"], expires=helpers["presigned_get_ttl_seconds"]
            )
        generation.pop("qc", None)
    if decorated.get("chunkedGenerationRuns"):
        helpers["decorate_embedded_s3_keys"](decorated["chunkedGenerationRuns"], asset_store)
    for pair in decorated.get("externalQcPairs", []):
        if pair.get("originalKey"):
            pair["originalUrl"] = asset_store.presign_get(pair["originalKey"], expires=helpers["presigned_get_ttl_seconds"])
        if pair.get("editedKey"):
            pair["editedUrl"] = asset_store.presign_get(pair["editedKey"], expires=helpers["presigned_get_ttl_seconds"])
    for export in decorated.get("exports", []):
        output_key = export.get("outputKey")
        if output_key:
            export["downloadUrl"] = asset_store.presign_get(output_key, expires=helpers["presigned_get_ttl_seconds"])
        motion_qc = export.get("motionSyncQc")
        if isinstance(motion_qc, dict):
            helpers["decorate_embedded_s3_keys"](motion_qc, asset_store)
    return response_fn(200, decorated, origin=origin)
