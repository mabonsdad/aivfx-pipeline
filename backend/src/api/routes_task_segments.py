from __future__ import annotations

from fractions import Fraction
from typing import Any, Callable

from botocore.exceptions import ClientError

from src.core.asset_origin import build_asset_origin
from src.core.cost_tracking import build_usage_record, estimate_cost_from_pricing_entry
from src.core.http import parse_json_body
from src.core.prompt_wizard_admin import resolve_prompt_wizard_model_config
from src.models.schemas import (
    ManualSegmentGenerationUploadCompleteRequest,
    ManualSegmentGenerationUploadInitRequest,
    SegmentCreateRequest,
    SegmentGenerateRequest,
    SegmentPromptWizardRequest,
    SegmentPatchRequest,
)


def _find_segment(task: dict[str, Any], segment_id: str) -> dict[str, Any] | None:
    return next((item for item in task.get("segments", []) if item.get("segmentId") == segment_id), None)


def handle_task_segment_routes(
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
    append_history_event_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    fps_fn: Callable[[dict[str, Any]], Fraction],
    timecode_fn: Callable[[int, Fraction], str],
    resolve_segment_frames_fn: Callable[..., tuple[int, int, int]],
    capture_segment_boundary_frames_fn: Callable[..., tuple[dict[str, Any], dict[str, Any]]],
    segment_crop_signature_fn: Callable[[dict[str, Any] | None], str | None],
    normalize_segment_crop_fn: Callable[[dict[str, Any], dict[str, Any] | None], dict[str, Any] | None],
    segment_model_limit_error_fn: Callable[[dict[str, Any], dict[str, Any], str], str | None],
    sanitize_prompt_fn: Callable[[str], str],
    validate_video_model_mode_fn: Callable[[str, str], None],
    validate_video_model_prompt_fn: Callable[..., None],
    video_model_provider_fn: Callable[[str], str],
    audit_prompt_fn: Callable[[str], dict[str, Any]],
    create_manual_uploaded_segment_generation_fn: Callable[..., dict[str, Any]],
    normalize_uploaded_generated_video_fn: Callable[..., dict[str, Any]],
    video_probe_payload_fn: Callable[[dict[str, Any]], dict[str, Any]],
    resolve_frame_source_fn: Callable[[dict[str, Any], str | None], tuple[str, str | None]],
    get_openai_api_key_fn: Callable[[], str],
    get_prompt_wizard_admin_config_fn: Callable[[], dict[str, Any]],
    get_openai_pricing_entry_fn: Callable[[str], dict[str, Any] | None],
    get_openai_pricing_rates_fn: Callable[[str], dict[str, float] | None],
    improve_video_prompt_fn: Callable[..., dict[str, Any]],
    logger,
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 3 and parts[2] == "segments":
        req = json_model(SegmentCreateRequest, event)
        try:
            start, end_excl, dur_frames = resolve_segment_frames_fn(
                task,
                req.startFrameIndex,
                duration_seconds=req.durationSeconds,
                end_frame_exclusive=req.endFrameExclusive,
            )
        except ValueError as exc:
            return error_response_fn(400, str(exc), origin=origin)

        segment_id = new_id_fn("seg")
        fps = fps_fn(task)
        segment = {
            "segmentId": segment_id,
            "startFrame": start,
            "endFrameExclusive": end_excl,
            "durationFrames": dur_frames,
            "durationSec": round(dur_frames / float(fps), 3),
            "startTimecode": timecode_fn(start, fps),
            "endTimecode": timecode_fn(end_excl, fps),
            "startFrameId": "",
            "endFrameId": "",
            "selectedGenerationId": None,
            "crop": None,
            "segmentClipKey": None,
            "segmentClipUpdatedAt": None,
        }
        start_capture, end_capture = capture_segment_boundary_frames_fn(task=task, segment=segment, asset_store=asset_store)
        segment["startFrameId"] = start_capture["frameId"]
        segment["endFrameId"] = end_capture["frameId"]
        task.setdefault("segments", []).append(segment)
        store.save_task(task)
        return response_fn(
            201,
            {
                "segmentId": segment_id,
                "resolvedStartFrameIndex": start,
                "resolvedEndFrameIndex": end_excl,
            },
            origin=origin,
        )

    if method == "PATCH" and len(parts) == 4 and parts[2] == "segments":
        segment_id = parts[3]
        req = json_model(SegmentPatchRequest, event)
        raw_body = parse_json_body(event) or {}
        crop_field_present = isinstance(raw_body, dict) and "crop" in raw_body
        segment = _find_segment(task, segment_id)
        if not isinstance(segment, dict):
            return error_response_fn(404, "Segment not found", origin=origin)

        start_frame = req.startFrameIndex if req.startFrameIndex is not None else segment["startFrame"]
        end_exclusive = req.endFrameExclusive if req.endFrameExclusive is not None else segment["endFrameExclusive"]
        if end_exclusive <= start_frame:
            return error_response_fn(400, "Invalid in/out range", origin=origin)

        fps = fps_fn(task)
        duration_frames = end_exclusive - start_frame
        duration_seconds = duration_frames / float(fps)
        previous_crop_signature = segment_crop_signature_fn(segment.get("crop"))
        crop_changed = False

        segment["startFrame"] = start_frame
        segment["endFrameExclusive"] = end_exclusive
        segment["durationFrames"] = duration_frames
        segment["durationSec"] = round(duration_seconds, 3)
        segment["startTimecode"] = timecode_fn(start_frame, fps)
        segment["endTimecode"] = timecode_fn(end_exclusive, fps)
        if crop_field_present:
            if raw_body.get("crop") is None:
                segment["crop"] = None
            else:
                if req.crop is None:
                    return error_response_fn(400, "Invalid crop payload", origin=origin)
                try:
                    normalized_crop = normalize_segment_crop_fn(task, req.crop.model_dump())
                except ValueError as exc:
                    return error_response_fn(400, str(exc), origin=origin)
                segment["crop"] = normalized_crop if normalized_crop and normalized_crop.get("enabled") else None
            segment["cropUpdatedAt"] = now_iso_fn()
            crop_changed = previous_crop_signature != segment_crop_signature_fn(segment.get("crop"))
        elif "crop" not in segment:
            segment["crop"] = None

        range_changed = (
            req.startFrameIndex is not None
            or req.endFrameExclusive is not None
            or not segment.get("startFrameId")
            or not segment.get("endFrameId")
        )
        if range_changed or crop_changed:
            start_capture, end_capture = capture_segment_boundary_frames_fn(task=task, segment=segment, asset_store=asset_store)
            segment["startFrameId"] = start_capture["frameId"]
            segment["endFrameId"] = end_capture["frameId"]
            segment["segmentClipKey"] = None
            segment["segmentClipUpdatedAt"] = None
            segment["selectedGenerationId"] = None

        store.save_task(task)
        return response_fn(200, {"ok": True, "segment": segment}, origin=origin)

    if method == "DELETE" and len(parts) == 4 and parts[2] == "segments":
        segment_id = parts[3]
        before = len(task["segments"])
        task["segments"] = [item for item in task["segments"] if item["segmentId"] != segment_id]
        if len(task["segments"]) == before:
            return error_response_fn(404, "Segment not found", origin=origin)
        store.save_task(task)
        return response_fn(200, {"ok": True}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "segments" and parts[4] == "generate":
        segment_id = parts[3]
        segment = _find_segment(task, segment_id)
        if not isinstance(segment, dict):
            return error_response_fn(404, "Segment not found", origin=origin)

        req = json_model(SegmentGenerateRequest, event)
        limit_error = segment_model_limit_error_fn(task, segment, req.lumaModel)
        if limit_error:
            return error_response_fn(400, limit_error, origin=origin)
        try:
            prompt = sanitize_prompt_fn(req.prompt) if req.prompt else None
            negative_prompt = sanitize_prompt_fn(req.negativePrompt) if req.negativePrompt else None
            validate_video_model_mode_fn(req.lumaModel, req.mode)
        except ValueError as exc:
            return error_response_fn(400, str(exc), origin=origin)
        try:
            if req.lumaModel == "seedance-2.0-reference-to-video" and req.inputMode == "edit_video":
                if not prompt:
                    raise ValueError("Seedance 2.0 Reference to Video requires a prompt that references @Video1.")
                if "@Video1" not in prompt:
                    raise ValueError("Seedance 2.0 Reference to Video prompt must include @Video1.")
            elif req.lumaModel == "gemini-omni-flash-preview" and req.inputMode in {"start_video", "edit_video"}:
                duration_sec = float(segment.get("durationSec") or 0.0)
                if duration_sec > 3.0 + 1e-6:
                    raise ValueError("Gemini Omni Flash currently supports source-video and edit-video flows only for working ranges up to 3 seconds.")
                validate_video_model_prompt_fn(req.lumaModel, prompt)
            else:
                validate_video_model_prompt_fn(req.lumaModel, prompt)
        except ValueError as exc:
            return error_response_fn(400, str(exc), origin=origin)
        generation_audio_reference = task.get("generationAudioReference") if isinstance(task.get("generationAudioReference"), dict) else None
        if req.audioReferenceId:
            reference_id = str(generation_audio_reference.get("referenceId") or "").strip() if generation_audio_reference else ""
            if not generation_audio_reference or reference_id != req.audioReferenceId:
                return error_response_fn(400, "Generation audio reference not found", origin=origin)
        if prompt:
            logger.info("Queueing segment generation", extra={**audit_prompt_fn(prompt), "taskId": task_id, "segmentId": segment_id})

        gen_id = new_id_fn("gen")
        provider_name = video_model_provider_fn(req.lumaModel)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="segment_generate",
            payload={
                "segmentId": segment_id,
                "genId": gen_id,
                "lumaModel": req.lumaModel,
                "mode": req.mode,
                "prompt": prompt,
                "negativePrompt": negative_prompt,
                "firstFrameVariantId": req.firstFrameVariantId,
                "lastFrameVariantId": req.lastFrameVariantId,
                "replicateKlingMode": req.replicateKlingMode,
                "replicateKlingV3Mode": req.replicateKlingV3Mode,
                "wan27Resolution": req.wan27Resolution,
                "happyHorseResolution": req.happyHorseResolution,
                "sora2Resolution": req.sora2Resolution,
                "inputMode": req.inputMode,
                "selectedReferenceIds": list(req.selectedReferenceIds or []),
                "audioReferenceId": req.audioReferenceId,
                "preserveFrames": bool(req.preserveFrames),
            },
        )
        task.setdefault("segmentGenerations", {})[gen_id] = {
            "genId": gen_id,
            "segmentId": segment_id,
            "luma": {
                "provider": provider_name,
                "model": req.lumaModel,
                "mode": req.mode,
                "prompt": prompt,
                "negativePrompt": negative_prompt,
                "lumaGenerationId": None,
            },
            "generationSettings": {
                "workflowId": str(task.get("workflowId") or "source_video_flow"),
                "inputMode": req.inputMode,
                "preserveFrames": bool(req.preserveFrames),
                "selectedReferenceIds": list(req.selectedReferenceIds or []),
                "audioReferenceId": req.audioReferenceId,
            },
            "origin": build_asset_origin(
                workflow_id=str(task.get("workflowId") or "source_video_flow"),
                step_origin="generate",
                tool_origin="segment_generate",
                creation_mode=req.inputMode,
            ),
            "status": "queued",
            "outputKey": None,
            "jobId": job_id,
            "error": None,
            "segmentCrop": segment.get("crop"),
            "queuedAt": now_iso_fn(),
            "createdAt": now_iso_fn(),
            "updatedAt": now_iso_fn(),
        }
        append_history_event_fn(
            task,
            {
                "at": now_iso_fn(),
                "event": "segment_generation.queued",
                "jobId": job_id,
                "genId": gen_id,
                "segmentId": segment_id,
                "model": req.lumaModel,
            },
        )
        store.save_task(task, merge_on_conflict=True)
        return response_fn(202, {"jobId": job_id, "genId": gen_id}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "segments" and parts[4] == "prompt-wizard":
        segment_id = parts[3]
        segment = _find_segment(task, segment_id)
        if not isinstance(segment, dict):
            return error_response_fn(404, "Segment not found", origin=origin)
        req = json_model(SegmentPromptWizardRequest, event)
        draft_prompt = sanitize_prompt_fn(req.user_draft_prompt)
        if not draft_prompt:
            return error_response_fn(400, "Prompt is required", origin=origin)

        edited_first_frame_url: str | None = None
        first_frame_variant_id = req.first_frame_variant_id
        start_frame_id = str(segment.get("startFrameId") or "")
        start_frame = task.get("frames", {}).get(start_frame_id) if start_frame_id else None
        if req.has_edited_first_frame and isinstance(start_frame, dict):
            try:
                first_frame_key, _ = resolve_frame_source_fn(start_frame, first_frame_variant_id)
                edited_first_frame_url = asset_store.presign_get(first_frame_key, expires=900)
            except ValueError:
                edited_first_frame_url = None
        if req.mode == "edit_video" and req.selected_reference_ids:
            reference_lookup = {
                str(item.get("referenceId")): item
                for item in task.get("editVideoReferences", [])
                if isinstance(item, dict) and item.get("referenceId")
            }
            prefix = f"users/{task['userId']}/tasks/{task_id}/"
            for reference_id in req.selected_reference_ids:
                key = str((reference_lookup.get(str(reference_id)) or {}).get("key") or "").strip()
                if key and key.startswith(prefix):
                    edited_first_frame_url = asset_store.presign_get(key, expires=900)
                    break

        request_payload = {
            "selected_model": req.selected_model,
            "provider": req.provider,
            "provider_model": req.provider_model,
            "endpoint_used": req.endpoint_used,
            "mode": req.mode,
            "user_draft_prompt": draft_prompt,
            "has_source_video": req.has_source_video,
            "has_edited_first_frame": req.has_edited_first_frame,
            "has_last_frame": req.has_last_frame,
            "app_required_markers": req.app_required_markers,
            "supports_negative_prompt": False,
            "duration_seconds": req.duration_seconds,
            "aspect_ratio": req.aspect_ratio,
            "luma_mode": req.luma_mode,
            "user_visible_model_name": req.user_visible_model_name,
            "first_frame_variant_id": req.first_frame_variant_id,
            "selected_reference_ids": req.selected_reference_ids,
        }
        admin_config = get_prompt_wizard_admin_config_fn()
        model_config = resolve_prompt_wizard_model_config(admin_config, req.selected_model, req.mode)
        if isinstance(model_config, dict):
            request_payload["provider"] = str(model_config.get("provider") or request_payload["provider"])
            request_payload["provider_model"] = str(model_config.get("provider_model") or request_payload["provider_model"])
            request_payload["endpoint_used"] = str(model_config.get("endpoint_used") or request_payload.get("endpoint_used") or "")
            request_payload["app_required_markers"] = [
                str(marker)
                for marker in (model_config.get("required_markers") or [])
                if str(marker).strip()
            ]
            request_payload["user_visible_model_name"] = str(
                model_config.get("dropdown_name") or request_payload["user_visible_model_name"]
            )
        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for Prompt Wizard", origin=origin)
        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")
        try:
            result, usage = improve_video_prompt_fn(
                api_key=openai_api_key,
                request_payload=request_payload,
                system_prompt=str(admin_config.get("systemPrompt") or "").strip() or None,
                edited_first_frame_url=edited_first_frame_url,
                pricing_rates=pricing_rates,
                return_usage=True,
            )
        except Exception as exc:
            logger.warning("Prompt Wizard request failed", extra={"taskId": task_id, "segmentId": segment_id, "error": str(exc)})
            return error_response_fn(502, str(exc), origin=origin)
        try:
            timestamp = now_iso_fn()
            estimate = estimate_cost_from_pricing_entry(pricing_entry, usage=usage)
            usage_record = build_usage_record(
                usage_record_id=new_id_fn("usage"),
                now_iso=timestamp,
                user_id=user_id,
                provider="openai",
                provider_model="gpt-5.5",
                app_model_id="gpt-5.5",
                request_type="prompt_rewrite",
                source="task_segment_prompt_wizard",
                tool_origin="prompt_wizard",
                workflow_id=str(task.get("workflowId") or "source_video_flow"),
                task_id=task_id,
                segment_id=segment_id,
                project_id=str(task.get("projectId") or "").strip() or None,
                pricing_entry=pricing_entry,
                estimate=estimate,
                notes=f"model={req.selected_model}",
            )
            store.save_usage_record(usage_record)
        except Exception as exc:
            logger.warning(
                "Prompt Wizard usage tracking failed",
                extra={"taskId": task_id, "segmentId": segment_id, "error": str(exc)},
            )
        return response_fn(200, {"result": result, "usage": usage}, origin=origin)

    if method == "POST" and len(parts) == 7 and parts[2] == "segments" and parts[4] == "manual-generation" and parts[5] == "upload" and parts[6] == "init":
        segment_id = parts[3]
        segment = _find_segment(task, segment_id)
        if not isinstance(segment, dict):
            return error_response_fn(404, "Segment not found", origin=origin)
        req = json_model(ManualSegmentGenerationUploadInitRequest, event)
        upload_id = new_id_fn("msgu")
        paths = asset_paths_for_task_fn(task)
        upload_key = paths.manual_segment_generation_upload(segment_id, upload_id, req.filename)
        return response_fn(
            200,
            {
                "uploadKey": upload_key,
                "uploadUrl": asset_store.presign_put(upload_key, expires=900, content_type=req.contentType),
            },
            origin=origin,
        )

    if method == "POST" and len(parts) == 7 and parts[2] == "segments" and parts[4] == "manual-generation" and parts[5] == "upload" and parts[6] == "complete":
        segment_id = parts[3]
        segment = _find_segment(task, segment_id)
        if not isinstance(segment, dict):
            return error_response_fn(404, "Segment not found", origin=origin)
        req = json_model(ManualSegmentGenerationUploadCompleteRequest, event)
        paths = asset_paths_for_task_fn(task)
        expected_prefix = f"{paths.task_prefix()}/segments/{segment_id}/manual_uploads/"
        if not req.uploadKey.startswith(expected_prefix):
            return error_response_fn(400, "Upload key is outside this segment manual-upload path", origin=origin)
        try:
            asset_store.head_object(req.uploadKey)
        except ClientError:
            return error_response_fn(404, "Uploaded generated video file not found", origin=origin)

        generation = create_manual_uploaded_segment_generation_fn(
            task=task,
            segment=segment,
            filename=req.filename,
            model=req.model,
            mode=req.mode,
            input_mode=req.inputMode,
            prompt=sanitize_prompt_fn(req.prompt) if req.prompt else None,
            negative_prompt=sanitize_prompt_fn(req.negativePrompt) if req.negativePrompt else None,
            first_frame_variant_id=req.firstFrameVariantId,
            last_frame_variant_id=req.lastFrameVariantId,
        )
        crop = segment.get("crop") if isinstance(segment.get("crop"), dict) and segment.get("crop", {}).get("enabled") else None
        target_width = int(crop.get("outputWidth")) if crop and crop.get("outputWidth") else int(task.get("video", {}).get("editSource", {}).get("width") or 0)
        target_height = int(crop.get("outputHeight")) if crop and crop.get("outputHeight") else int(task.get("video", {}).get("editSource", {}).get("height") or 0)
        fps_info = task.get("video", {}).get("editSource", {}).get("fps", {})
        target_fps = Fraction(int(fps_info.get("num") or 30), int(fps_info.get("den") or 1))
        normalized_probe = normalize_uploaded_generated_video_fn(
            asset_store=asset_store,
            upload_key=req.uploadKey,
            output_key=generation["outputKey"],
            target_width=target_width,
            target_height=target_height,
            target_fps=target_fps,
        )
        generation["providerDurationSec"] = round(float(normalized_probe.get("duration_sec") or segment.get("durationSec") or 0.0), 3)
        generation["generationSettings"] = {
            **(generation.get("generationSettings") or {}),
            "mediaHasAudio": bool(normalized_probe.get("has_audio")),
            "sourceSegmentTiming": {
                "startFrame": int(segment.get("startFrame") or 0),
                "endFrameExclusive": int(segment.get("endFrameExclusive") or 0),
                "durationFrames": int(segment.get("durationFrames") or 0),
                "durationSec": round(float(segment.get("durationSec") or 0.0), 4),
                "fps": {"num": target_fps.numerator, "den": target_fps.denominator},
                "width": target_width,
                "height": target_height,
            },
            "storedOutput": video_probe_payload_fn(normalized_probe),
            "timelineConform": {
                "policy": "manual_upload_normalize",
                "applied": True,
                "durationDeltaSec": round(float(normalized_probe.get("duration_sec") or 0.0) - float(segment.get("durationSec") or 0.0), 4),
                "frameDelta": int(normalized_probe.get("frame_count") or 0) - int(segment.get("durationFrames") or 0),
                "fpsConformed": True,
                "resolutionConformed": True,
            },
        }
        try:
            asset_store.delete_object(req.uploadKey)
        except Exception:
            pass
        task.setdefault("segmentGenerations", {})[generation["genId"]] = generation
        segment["selectedGenerationId"] = generation["genId"]
        append_history_event_fn(
            task,
            {
                "at": now_iso_fn(),
                "event": "segment_generation.manual_upload",
                "genId": generation["genId"],
                "segmentId": segment_id,
                "model": req.model,
                "filename": req.filename,
                "userId": user_id,
            },
        )
        store.save_task(task, merge_on_conflict=True)
        return response_fn(200, {"generation": generation}, origin=origin)

    return None
