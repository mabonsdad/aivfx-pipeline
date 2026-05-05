from __future__ import annotations

from typing import Any, Callable

from botocore.exceptions import ClientError

from src.models.schemas import AssetDeleteRequest, ExternalQcPairUploadRequest, UploadVideoRequest


def handle_task_asset_routes(
    method: str,
    *,
    task_id: str,
    parts: list[str],
    event: dict[str, Any],
    origin: str | None,
    task: dict[str, Any],
    store,
    asset_store,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    max_upload_bytes: int,
    presigned_get_ttl_seconds: int,
    logger,
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    cleanup_custom_reports_fn: Callable[[dict[str, Any]], bool],
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 4 and parts[2] == "uploads" and parts[3] == "video":
        req = json_model(UploadVideoRequest, event)
        if req.sizeBytes > max_upload_bytes:
            return error_response_fn(400, f"Upload too large (max={max_upload_bytes})", origin=origin)
        if not req.contentType.startswith("video/"):
            return error_response_fn(400, "Invalid content type", origin=origin)

        key = asset_paths_for_task_fn(task).original_video(req.filename)
        upload_url = asset_store.presign_put(key, expires=900, content_type=req.contentType)
        task["video"]["original"] = {
            "s3Key": key,
            "filename": req.filename,
            "sizeBytes": req.sizeBytes,
            "sha256": None,
        }
        task["status"] = "created"
        store.save_task(task)
        return response_fn(200, {"uploadUrl": upload_url, "s3Key": key}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "external-qc" and parts[3] == "pairs" and parts[4] == "uploads":
        req = json_model(ExternalQcPairUploadRequest, event)
        original_is_image = req.originalContentType.startswith("image/")
        edited_is_image = req.editedContentType.startswith("image/")
        original_is_video = req.originalContentType.startswith("video/")
        edited_is_video = req.editedContentType.startswith("video/")
        if original_is_image and edited_is_image:
            media_type = "image"
        elif original_is_video and edited_is_video:
            media_type = "video"
        else:
            return error_response_fn(400, "External QC inputs must both be images or both be videos", origin=origin)
        paths = asset_paths_for_task_fn(task)
        pair_id = new_id_fn("extqc")
        original_key = paths.external_qc_original(pair_id, req.originalFilename)
        edited_key = paths.external_qc_edited(pair_id, req.editedFilename)
        now = now_iso_fn()
        pair = {
            "pairId": pair_id,
            "originalFilename": req.originalFilename,
            "editedFilename": req.editedFilename,
            "originalContentType": req.originalContentType,
            "editedContentType": req.editedContentType,
            "mediaType": media_type,
            "originalKey": original_key,
            "editedKey": edited_key,
            "createdAt": now,
            "updatedAt": now,
        }
        task.setdefault("externalQcPairs", []).append(pair)
        store.save_task(task)
        return response_fn(
            201,
            {
                "pairId": pair_id,
                "originalUploadUrl": asset_store.presign_put(original_key, expires=900, content_type=req.originalContentType),
                "editedUploadUrl": asset_store.presign_put(edited_key, expires=900, content_type=req.editedContentType),
                "pair": {
                    **pair,
                    "originalUrl": asset_store.presign_get(original_key, expires=presigned_get_ttl_seconds),
                    "editedUrl": asset_store.presign_get(edited_key, expires=presigned_get_ttl_seconds),
                },
            },
            origin=origin,
        )

    if method != "DELETE" or len(parts) != 3 or parts[2] != "assets":
        return None
    req = json_model(AssetDeleteRequest, event)

    def _delete_key_if_present(key: str | None) -> None:
        if not key:
            return
        try:
            asset_store.delete_object(key)
        except ClientError:
            logger.warning("Asset delete failed", extra={"taskId": task_id, "key": key})

    if req.assetType == "upload":
        original = task.get("video", {}).get("original", {})
        key = original.get("s3Key")
        if not key:
            return error_response_fn(404, "Upload not found", origin=origin)
        _delete_key_if_present(key)
        task.setdefault("video", {}).pop("original", None)
        if not task.get("video", {}).get("editSource"):
            task["status"] = "created"
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if req.assetType == "frame_capture":
        frame_id = req.frameId
        frame = task.get("frames", {}).get(frame_id or "")
        if not frame:
            return error_response_fn(404, "Frame not found", origin=origin)
        is_referenced = any(
            seg.get("startFrameId") == frame_id or seg.get("endFrameId") == frame_id
            for seg in task.get("segments", [])
        )
        if is_referenced:
            return error_response_fn(400, "Frame is used by segment boundaries", origin=origin)
        _delete_key_if_present(frame.get("captureKey"))
        for variant in frame.get("variants", []):
            _delete_key_if_present(variant.get("outputKey"))
            patch_meta = variant.get("patchMeta", {})
            _delete_key_if_present(patch_meta.get("patchOnlyKey"))
            _delete_key_if_present(patch_meta.get("maskKey"))
        analyses = task.get("qualityMatchAnalyses", {})
        if isinstance(analyses, dict):
            remove_analysis_ids = [
                analysis_id
                for analysis_id, analysis in analyses.items()
                if isinstance(analysis, dict) and analysis.get("frameId") == frame_id
            ]
            for analysis_id in remove_analysis_ids:
                analyses.pop(analysis_id, None)
        task.get("frames", {}).pop(frame_id, None)
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if req.assetType == "frame_variant":
        frame_id = req.frameId
        variant_id = req.variantId
        frame = task.get("frames", {}).get(frame_id or "")
        if not frame:
            return error_response_fn(404, "Frame not found", origin=origin)
        variants = frame.get("variants", [])
        variant = next((v for v in variants if v.get("variantId") == variant_id), None)
        if not variant:
            return error_response_fn(404, "Variant not found", origin=origin)
        _delete_key_if_present(variant.get("outputKey"))
        patch_meta = variant.get("patchMeta", {})
        _delete_key_if_present(patch_meta.get("patchOnlyKey"))
        _delete_key_if_present(patch_meta.get("maskKey"))
        frame["variants"] = [v for v in variants if v.get("variantId") != variant_id]
        if frame.get("selectedVariantId") == variant_id:
            frame["selectedVariantId"] = frame["variants"][0]["variantId"] if frame["variants"] else None
        analyses = task.get("qualityMatchAnalyses", {})
        if isinstance(analyses, dict):
            remove_analysis_ids = [
                analysis_id
                for analysis_id, analysis in analyses.items()
                if isinstance(analysis, dict)
                and analysis.get("frameId") == frame_id
                and analysis.get("variantId") == variant_id
            ]
            for analysis_id in remove_analysis_ids:
                analyses.pop(analysis_id, None)
            status = frame.get("qualityMatchStatus")
            if isinstance(status, dict):
                source_analysis = status.get("qualityMatchSourceAnalysisId")
                if source_analysis in remove_analysis_ids:
                    frame["qualityMatchStatus"] = None
                    frame["qualityMatched"] = False
        cleanup_custom_reports_fn(task)
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if req.assetType == "segment_generation":
        gen_id = req.genId
        generation = task.get("segmentGenerations", {}).get(gen_id or "")
        if not generation:
            return error_response_fn(404, "Generation not found", origin=origin)
        _delete_key_if_present(generation.get("outputKey"))
        task.get("segmentGenerations", {}).pop(gen_id, None)
        for segment in task.get("segments", []):
            if segment.get("selectedGenerationId") == gen_id:
                segment["selectedGenerationId"] = None
        cleanup_custom_reports_fn(task)
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if req.assetType == "export":
        export_id = req.exportId
        exports = task.get("exports", [])
        export_item = next((e for e in exports if e.get("exportId") == export_id), None)
        if not export_item:
            return error_response_fn(404, "Export not found", origin=origin)
        _delete_key_if_present(export_item.get("outputKey"))
        task["exports"] = [e for e in exports if e.get("exportId") != export_id]
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    return error_response_fn(400, "Unsupported asset type", origin=origin)
