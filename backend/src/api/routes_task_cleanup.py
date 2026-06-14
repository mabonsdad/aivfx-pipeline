from __future__ import annotations

from typing import Any, Callable

from botocore.exceptions import ClientError

from src.video_cleanup.models import VideoCleanupSettings
from src.video_cleanup.schemas import (
    VideoCleanupApplyRequest,
    VideoCleanupCreateRequest,
    VideoCleanupKeyframeUploadCompleteRequest,
    VideoCleanupKeyframeUploadInitRequest,
    VideoCleanupPreviewRequest,
    VideoCleanupSamAssistRequest,
)
from src.video_cleanup.service import add_or_replace_keyframe, create_track_record


def _resolve_track(
    *,
    task: dict[str, Any],
    track_id: str,
    get_cleanup_track_fn: Callable[[dict[str, Any], str], dict[str, Any] | None],
) -> dict[str, Any] | None:
    track = get_cleanup_track_fn(task, track_id)
    return track if isinstance(track, dict) else None


def _track_frame_count(track: dict[str, Any]) -> int:
    return int(track.get("source", {}).get("frameCount") or 0)


def _mark_track_tracking(track: dict[str, Any], *, now_iso_fn: Callable[[], str]) -> None:
    track["status"] = "tracking"
    track.pop("error", None)
    track["updatedAt"] = now_iso_fn()


def handle_task_cleanup_routes(
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
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    cleanup_track_response_fn: Callable[[dict[str, Any], Any], dict[str, Any]],
    get_cleanup_track_fn: Callable[[dict[str, Any], str], dict[str, Any] | None],
    resolve_first_mask_key_from_analysis_fn: Callable[[dict[str, Any]], str | None],
    cleanup_custom_reports_fn: Callable[[dict[str, Any]], bool],
) -> dict[str, Any] | None:
    if method == "GET" and len(parts) == 4 and parts[2] == "cleanup-tracks":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        return response_fn(200, {"track": cleanup_track_response_fn(track, asset_store)}, origin=origin)

    if method == "DELETE" and len(parts) == 4 and parts[2] == "cleanup-tracks":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        try:
            asset_store.delete_prefix(f"{asset_paths_for_task_fn(task).cleanup_track_prefix(track_id)}/", purge_versions=True)
        except ClientError:
            return error_response_fn(500, "Failed to delete cleanup track assets", origin=origin)

        derived_generation_ids = [
            str(gen_id)
            for gen_id, generation in (task.get("segmentGenerations") or {}).items()
            if isinstance(generation, dict) and str(generation.get("cleanupTrackId") or "") == track_id
        ]
        for gen_id in derived_generation_ids:
            task.get("segmentGenerations", {}).pop(gen_id, None)
        source_generation_id = str(track.get("generationId") or "")
        for segment in task.get("segments", []):
            if not isinstance(segment, dict):
                continue
            if str(segment.get("selectedGenerationId") or "") in derived_generation_ids:
                segment["selectedGenerationId"] = source_generation_id or None

        task["videoCleanupTracks"] = [
            item
            for item in task.get("videoCleanupTracks", [])
            if not (isinstance(item, dict) and str(item.get("trackId") or "") == track_id)
        ]
        cleanup_custom_reports_fn(task)
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if method == "POST" and len(parts) == 6 and parts[2] == "cleanup-tracks" and parts[4] == "keyframes" and parts[5] == "upload-init":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        req = json_model(VideoCleanupKeyframeUploadInitRequest, event)
        if not req.contentType.lower().startswith("image/"):
            return error_response_fn(400, "Cleanup keyframe masks must be image uploads", origin=origin)
        if req.frameIndexLocal >= _track_frame_count(track):
            return error_response_fn(400, "Frame index is outside cleanup track bounds", origin=origin)
        paths = asset_paths_for_task_fn(task)
        upload_key = paths.cleanup_track_keyframe_mask(track_id, req.frameIndexLocal)
        return response_fn(
            200,
            {
                "uploadKey": upload_key,
                "uploadUrl": asset_store.presign_put(upload_key, expires=900, content_type=req.contentType),
            },
            origin=origin,
        )

    if method == "POST" and len(parts) == 6 and parts[2] == "cleanup-tracks" and parts[4] == "keyframes" and parts[5] == "complete":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        req = json_model(VideoCleanupKeyframeUploadCompleteRequest, event)
        if req.frameIndexLocal >= _track_frame_count(track):
            return error_response_fn(400, "Frame index is outside cleanup track bounds", origin=origin)
        expected_key = asset_paths_for_task_fn(task).cleanup_track_keyframe_mask(track_id, req.frameIndexLocal)
        if req.uploadKey != expected_key:
            return error_response_fn(400, "Upload key does not match the cleanup track keyframe location", origin=origin)
        try:
            asset_store.head_object(req.uploadKey)
        except ClientError:
            return error_response_fn(404, "Uploaded keyframe mask not found", origin=origin)
        keyframe_id = new_id_fn("kf")
        _mark_track_tracking(track, now_iso_fn=now_iso_fn)
        store.save_task(task)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="video_cleanup_retrack_window",
            payload={
                "trackId": track_id,
                "frameIndexLocal": req.frameIndexLocal,
                "uploadKey": req.uploadKey,
                "propagationMode": req.propagationMode,
                "keyframeId": keyframe_id,
            },
        )
        return response_fn(202, {"jobId": job_id, "keyframeId": keyframe_id}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "cleanup-tracks" and parts[4] == "sam-assist":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        req = json_model(VideoCleanupSamAssistRequest, event)
        cleanup_prefix = f"{asset_paths_for_task_fn(task).cleanup_track_prefix(track_id)}/"
        if req.existingMaskKey and not str(req.existingMaskKey).startswith(cleanup_prefix):
            return error_response_fn(400, "existingMaskKey is outside this cleanup track", origin=origin)
        if req.frameIndexLocal >= _track_frame_count(track):
            return error_response_fn(400, "Frame index is outside cleanup track bounds", origin=origin)
        _mark_track_tracking(track, now_iso_fn=now_iso_fn)
        store.save_task(task)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="video_cleanup_retrack_window",
            payload={
                "trackId": track_id,
                "frameIndexLocal": req.frameIndexLocal,
                "positivePoints": [point.model_dump() for point in req.positivePoints],
                "negativePoints": [point.model_dump() for point in req.negativePoints],
                "box": (
                    {
                        "x": req.box.x,
                        "y": req.box.y,
                        "w": req.box.width,
                        "h": req.box.height,
                    }
                    if req.box
                    else None
                ),
                "existingMaskKey": req.existingMaskKey,
                "restrictToMaskBounds": req.restrictToMaskBounds,
                "edgeBias": req.edgeBias,
                "propagationMode": req.propagationMode,
            },
        )
        return response_fn(202, {"jobId": job_id}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "cleanup-tracks" and parts[4] == "preview":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        req = json_model(VideoCleanupPreviewRequest, event)
        settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else track.get("settings")
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="video_cleanup_preview",
            payload={"trackId": track_id, "settings": settings_payload},
        )
        return response_fn(202, {"jobId": job_id}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "cleanup-tracks" and parts[4] == "apply":
        track_id = parts[3]
        track = _resolve_track(task=task, track_id=track_id, get_cleanup_track_fn=get_cleanup_track_fn)
        if track is None:
            return error_response_fn(404, "Cleanup track not found", origin=origin)
        req = json_model(VideoCleanupApplyRequest, event)
        settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else track.get("settings")
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="video_cleanup_apply",
            payload={
                "trackId": track_id,
                "settings": settings_payload,
                "createSegmentGenerationVariant": bool(req.createSegmentGenerationVariant),
            },
        )
        return response_fn(202, {"jobId": job_id}, origin=origin)

    if method == "POST" and len(parts) == 7 and parts[2] == "segments" and parts[4] == "generations" and parts[6] == "cleanup-tracks":
        segment_id = parts[3]
        generation_id = parts[5]
        segment = next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)
        generation = task.get("segmentGenerations", {}).get(generation_id)
        if not isinstance(segment, dict) or not isinstance(generation, dict):
            return error_response_fn(404, "Segment or generation not found", origin=origin)
        if generation.get("segmentId") != segment_id:
            return error_response_fn(400, "Generation does not belong to this segment", origin=origin)
        if generation.get("status") != "complete":
            return error_response_fn(400, "Cleanup tracks require a completed generation", origin=origin)

        req = json_model(VideoCleanupCreateRequest, event)
        analysis = (task.get("qualityMatchAnalyses") or {}).get(req.firstMaskSource.analysisId)
        if not isinstance(analysis, dict):
            return error_response_fn(404, "Quality Match analysis not found", origin=origin)
        if analysis.get("frameId") != segment.get("startFrameId"):
            return error_response_fn(400, "Cleanup seed analysis must belong to the segment start frame", origin=origin)
        first_mask_key = resolve_first_mask_key_from_analysis_fn(analysis)
        if not first_mask_key:
            return error_response_fn(400, "Selected Quality Match analysis does not expose a keep mask", origin=origin)

        settings_payload = req.settings.model_dump(exclude_none=True) if req.settings else None
        cleanup_settings = VideoCleanupSettings.from_payload(settings_payload)
        crop = segment.get("crop") if isinstance(segment.get("crop"), dict) else None
        width = int(crop.get("outputWidth")) if isinstance(crop, dict) and crop.get("outputWidth") else int(task.get("video", {}).get("editSource", {}).get("width") or 0)
        height = int(crop.get("outputHeight")) if isinstance(crop, dict) and crop.get("outputHeight") else int(task.get("video", {}).get("editSource", {}).get("height") or 0)
        frame_count = max(1, int(segment.get("durationFrames") or 1))
        track_id = new_id_fn("trk")
        track_record = create_track_record(
            task=task,
            segment=segment,
            generation=generation,
            track_id=track_id,
            first_mask_key=first_mask_key,
            first_mask_source_analysis_id=req.firstMaskSource.analysisId,
            settings=cleanup_settings,
            source_key=segment.get("segmentClipKey") or task.get("video", {}).get("editSource", {}).get("s3Key"),
            generated_key=generation.get("outputKey"),
            width=width,
            height=height,
            frame_count=frame_count,
            fps_num=int(task.get("video", {}).get("editSource", {}).get("fps", {}).get("num") or 30),
            fps_den=int(task.get("video", {}).get("editSource", {}).get("fps", {}).get("den") or 1),
        )
        add_or_replace_keyframe(track=track_record, frame_index_local=0, mask_key=first_mask_key, source="seed_first")
        task.setdefault("videoCleanupTracks", []).append(track_record)
        store.save_task(task)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="video_cleanup_init",
            payload={
                "trackId": track_id,
                "segmentId": segment_id,
                "generationId": generation_id,
                "firstMaskSourceKey": first_mask_key,
                "firstMaskAnalysisId": req.firstMaskSource.analysisId,
                "settings": cleanup_settings.to_dict(),
            },
        )
        return response_fn(201, {"trackId": track_id, "jobId": job_id}, origin=origin)

    return None
