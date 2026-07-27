from __future__ import annotations

from typing import Any, Callable

from botocore.exceptions import ClientError

from src.core.projects import can_access_project
from src.core.task_workflows import is_character_animate_workflow_id
from src.models.schemas import AssetDeleteRequest, ExternalQcPairUploadRequest, SourceMediaBindRequest, UploadVideoRequest


def _required_source_media_kind(task: dict[str, Any]) -> str:
    workflow_id = str(task.get("workflowId") or "").strip()
    if workflow_id == "character_animate_audio_workflow":
        return "audio"
    return "video"


def _task_has_derived_source_work(task: dict[str, Any]) -> bool:
    if task.get("segments"):
        return True
    if task.get("frames"):
        return True
    if task.get("segmentGenerations"):
        return True
    return False


def _clear_task_source_media(task: dict[str, Any]) -> None:
    task.setdefault("video", {})
    task.setdefault("sourceMedia", {})
    task["video"].pop("original", None)
    task["video"].pop("editSource", None)
    task["video"].pop("previewSource", None)
    task["sourceMedia"].pop("original", None)
    task["sourceMedia"].pop("editSource", None)
    task["sourceMedia"].pop("previewSource", None)
    task["sourceMedia"].pop("waveform", None)
    task["sourceMedia"].pop("linkedSourceTaskId", None)
    task["sourceMedia"].pop("linkedSourceUserId", None)


def _key_belongs_to_task_prefix(key: str | None, task_prefix: str) -> bool:
    return bool(key and key.startswith(f"{task_prefix}/"))


def handle_task_asset_routes(
    method: str,
    *,
    task_id: str,
    parts: list[str],
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    claims: dict[str, Any],
    task: dict[str, Any],
    store,
    asset_store,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
    max_upload_bytes: int,
    presigned_get_ttl_seconds: int,
    logger,
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    cleanup_custom_reports_fn: Callable[[dict[str, Any]], bool],
    is_admin_claims_fn: Callable[[dict[str, Any]], bool],
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 4 and parts[2] == "uploads" and parts[3] == "video":
        req = json_model(UploadVideoRequest, event)
        if req.sizeBytes > max_upload_bytes:
            return error_response_fn(400, f"Upload too large (max={max_upload_bytes})", origin=origin)
        is_video = req.contentType.startswith("video/")
        is_audio = req.contentType.startswith("audio/")
        if not is_video and not (is_audio and is_character_animate_workflow_id(str(task.get("workflowId") or ""))):
            return error_response_fn(400, "Invalid content type", origin=origin)
        if task.get("sourceMedia", {}).get("original") and _task_has_derived_source_work(task):
            return error_response_fn(400, "This task already contains derived work tied to its current source media.", origin=origin)

        key = asset_paths_for_task_fn(task).original_video(req.filename)
        upload_url = asset_store.presign_put(key, expires=900, content_type=req.contentType)
        source_media_kind = "video" if is_video else "audio"
        source_original = {
            "s3Key": key,
            "filename": req.filename,
            "contentType": req.contentType,
            "sizeBytes": req.sizeBytes,
            "sha256": None,
        }
        task.setdefault("sourceMedia", {})
        task["sourceMedia"]["kind"] = source_media_kind
        task["sourceMedia"]["original"] = source_original
        if is_video:
            task["video"]["original"] = source_original
        else:
            task.setdefault("video", {}).pop("original", None)
        task["status"] = "created"
        store.save_task(task)
        return response_fn(200, {"uploadUrl": upload_url, "s3Key": key}, origin=origin)

    if method == "POST" and len(parts) == 4 and parts[2] == "source-media" and parts[3] == "bind":
        req = json_model(SourceMediaBindRequest, event)
        if str(task.get("taskId") or "") == req.sourceTaskId:
            return error_response_fn(400, "Choose a different task source to bind", origin=origin)
        if task.get("sourceMedia", {}).get("original") and _task_has_derived_source_work(task):
            return error_response_fn(400, "This task already contains derived work tied to its current source media.", origin=origin)

        source_task = store.load_task_any(req.sourceTaskId)
        if not isinstance(source_task, dict) or source_task.get("deletedAt"):
            return error_response_fn(404, "Source task not found", origin=origin)

        source_owner_id = str(source_task.get("userId") or "").strip()
        source_project_id = str(source_task.get("projectId") or "").strip()
        is_admin = is_admin_claims_fn(claims)
        can_access = source_owner_id == user_id
        if not can_access and source_project_id:
            project = store.load_project(source_project_id)
            can_access = can_access_project(project, user_id=user_id, is_admin=is_admin)
        if not can_access and not is_admin:
            return error_response_fn(403, "Source task access denied", origin=origin)

        source_media = source_task.get("sourceMedia") if isinstance(source_task.get("sourceMedia"), dict) else {}
        if not source_media:
            return error_response_fn(400, "Selected task does not have source media", origin=origin)
        source_kind = str(source_media.get("kind") or source_task.get("video", {}).get("editSource", {}).get("mediaType") or "video")
        if source_kind != _required_source_media_kind(task):
            expected_label = "audio" if _required_source_media_kind(task) == "audio" else "video"
            return error_response_fn(400, f"Selected task must provide a {expected_label} source", origin=origin)
        if not source_media.get("original") or not source_media.get("editSource") or not source_media.get("previewSource"):
            return error_response_fn(400, "Selected task source media is not ready to reuse yet", origin=origin)

        task["status"] = "ingesting"
        store.save_task(task)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="bind_source_media",
            payload={"sourceTaskId": req.sourceTaskId},
        )
        return response_fn(202, {"jobId": job_id}, origin=origin)

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
            asset_store.delete_object(key, purge_versions=True)
        except ClientError:
            logger.warning("Asset delete failed", extra={"taskId": task_id, "key": key})

    def _delete_prefix_if_present(prefix: str | None) -> None:
        if not prefix:
            return
        try:
            asset_store.delete_prefix(prefix, purge_versions=True)
        except ClientError:
            logger.warning("Asset prefix delete failed", extra={"taskId": task_id, "prefix": prefix})

    def _delete_quality_match_artifacts(frame_id: str, analysis_ids: list[str]) -> None:
        paths = asset_paths_for_task_fn(task)
        for analysis_id in analysis_ids:
            _delete_prefix_if_present(paths.quality_match_prefix(frame_id, analysis_id))

    def _delete_generation_attached_keys(generation: dict[str, Any]) -> None:
        explicit_keys = {
            generation.get("outputKey"),
            generation.get("posterKey"),
            generation.get("inputMediaKey"),
            generation.get("inputAudioKey"),
            generation.get("inputFirstFrameKey"),
            generation.get("inputLastFrameKey"),
        }
        generation_settings = generation.get("generationSettings") if isinstance(generation.get("generationSettings"), dict) else {}
        inputs = generation_settings.get("inputs") if isinstance(generation_settings.get("inputs"), dict) else {}
        for item in inputs.values():
            if isinstance(item, dict):
                explicit_keys.add(item.get("key"))
        review = generation.get("review") if isinstance(generation.get("review"), dict) else {}
        if isinstance(review.get("previewManifestKey"), str):
            explicit_keys.add(review.get("previewManifestKey"))
        for key in explicit_keys:
            if isinstance(key, str) and key:
                _delete_key_if_present(key)

    if req.assetType == "upload":
        source_media = task.setdefault("sourceMedia", {})
        video = task.setdefault("video", {})
        task_prefix = asset_paths_for_task_fn(task).task_prefix()
        original = task.get("video", {}).get("original", {})
        if not original:
            original = task.get("sourceMedia", {}).get("original", {})
        key = original.get("s3Key")
        if not key:
            return error_response_fn(404, "Upload not found", origin=origin)
        if _key_belongs_to_task_prefix(key, task_prefix):
            _delete_key_if_present(key)
        edit_source = video.get("editSource") if isinstance(video.get("editSource"), dict) else {}
        preview_source = video.get("previewSource") if isinstance(video.get("previewSource"), dict) else {}
        if _key_belongs_to_task_prefix(edit_source.get("s3Key"), task_prefix):
            _delete_key_if_present(edit_source.get("s3Key"))
        if _key_belongs_to_task_prefix(preview_source.get("s3Key"), task_prefix):
            _delete_key_if_present(preview_source.get("s3Key"))
        waveform_key = source_media.get("waveform", {}).get("s3Key") if isinstance(source_media.get("waveform"), dict) else None
        if _key_belongs_to_task_prefix(waveform_key, task_prefix):
            _delete_key_if_present(waveform_key)
        _delete_prefix_if_present(f"{asset_paths_for_task_fn(task).thumbs_prefix()}/")
        _clear_task_source_media(task)
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
            _delete_quality_match_artifacts(str(frame_id), [str(item) for item in remove_analysis_ids])
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
            _delete_quality_match_artifacts(str(frame_id), [str(item) for item in remove_analysis_ids])
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
        _delete_generation_attached_keys(generation)
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
        motion_qc = export_item.get("motionSyncQc") if isinstance(export_item.get("motionSyncQc"), dict) else {}
        for key_name in ("timelineCsvKey", "timelineGraphKey", "reportJsonKey"):
            _delete_key_if_present(motion_qc.get(key_name))
        topaz_upscale = export_item.get("topazUpscale") if isinstance(export_item.get("topazUpscale"), dict) else {}
        _delete_key_if_present(topaz_upscale.get("resultOutputKey"))
        result_export_id = str(topaz_upscale.get("resultExportId") or "")
        if result_export_id:
            result_export = next((e for e in exports if isinstance(e, dict) and e.get("exportId") == result_export_id), None)
            if isinstance(result_export, dict):
                _delete_key_if_present(result_export.get("outputKey"))
        task["exports"] = [
            e
            for e in exports
            if e.get("exportId") != export_id and (not result_export_id or e.get("exportId") != result_export_id)
        ]
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if req.assetType == "edit_video_reference":
        reference_id = req.referenceId
        references = task.get("editVideoReferences", [])
        reference = next((item for item in references if item.get("referenceId") == reference_id), None)
        if not reference:
            return error_response_fn(404, "Edit-video reference not found", origin=origin)
        _delete_key_if_present(reference.get("key"))
        task["editVideoReferences"] = [item for item in references if item.get("referenceId") != reference_id]
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if req.assetType == "generation_audio_reference":
        generation_audio_reference = task.get("generationAudioReference") if isinstance(task.get("generationAudioReference"), dict) else None
        if not generation_audio_reference:
            return error_response_fn(404, "Generation audio reference not found", origin=origin)
        _delete_key_if_present(generation_audio_reference.get("originalKey"))
        _delete_key_if_present(generation_audio_reference.get("editSourceKey"))
        _delete_key_if_present(generation_audio_reference.get("previewKey"))
        _delete_key_if_present(generation_audio_reference.get("waveformKey"))
        task.pop("generationAudioReference", None)
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    return error_response_fn(400, "Unsupported asset type", origin=origin)
