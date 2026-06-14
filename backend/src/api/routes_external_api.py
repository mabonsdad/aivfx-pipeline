from __future__ import annotations

from typing import Any, Callable

from src.models.schemas import ApiAssetUploadInitRequest, ApiImageEditFullRequest, ApiImageEditPatchRequest, ApiReferenceVideoGenerateRequest


API_MULTI_REFERENCE_IMAGE_EDIT_LIMITS: dict[str, int] = {
    "nano_banana": 3,
    "nano_banana_pro": 9,
    "chatgpt": 9,
    "chatgpt_latest": 9,
}

API_PATCH_REFERENCE_LIMITS: dict[str, int] = {
    "nano_banana_pro": 9,
    "chatgpt": 9,
    "chatgpt_latest": 9,
    "runware_ace_pp": 1,
}

API_VIDEO_REFERENCE_LIMITS: dict[str, int] = {
    "happy-horse-video-edit": 3,
    "kling-o1": 3,
    "kling-v3-omni-video": 3,
    "seedance-2.0-reference-to-video": 3,
}


def _normalized_asset_keys(group: list[str] | tuple[str, ...] | None) -> list[str]:
    if not group:
        return []
    return [candidate for candidate in (str(item or "").strip() for item in group) if candidate]


def _normalized_patch_reference_asset_keys(*, plural: list[str] | tuple[str, ...] | None, singular: str | None) -> list[str]:
    normalized_plural = _normalized_asset_keys(plural)
    if normalized_plural:
        return normalized_plural
    if singular is None:
        return []
    candidate = str(singular).strip()
    return [candidate] if candidate else []


def _validate_reference_asset_limit(*, model: str, reference_asset_keys: list[str], limits: dict[str, int], context_label: str) -> None:
    supported_limit = limits.get(model)
    if supported_limit is None:
        if reference_asset_keys:
            raise ValueError(f"{context_label} does not support referenceAssetKeys for model {model}")
        return
    if len(reference_asset_keys) > supported_limit:
        raise ValueError(f"{context_label} supports up to {supported_limit} ordered reference images for model {model}")


def handle_external_api_routes(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    store,
    asset_store,
    queue,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
    sanitize_prompt_fn: Callable[[str], str],
    validate_api_asset_key_fn: Callable[..., dict[str, Any]],
    api_request_error_payload_fn: Callable[..., dict[str, Any]],
    api_asset_paths_for_user_fn: Callable[[str], Any],
    extract_query_fn: Callable[[dict[str, Any]], dict[str, str]],
    api_request_response_fn: Callable[..., dict[str, Any]],
    validate_api_video_mode_fn: Callable[[str, str], None],
    validate_video_model_prompt_fn: Callable[[str, str | None], None],
    get_video_model_capability_fn: Callable[[str], Any],
    segment_generation_provider_name_fn: Callable[[str], str],
) -> dict[str, Any] | None:
    if method == "POST" and path == "/api/v1/assets/uploads/init":
        req = json_model(ApiAssetUploadInitRequest, event)
        normalized_content_type = req.contentType.lower()
        if req.assetType == "image" and not normalized_content_type.startswith("image/"):
            return response_fn(
                400,
                {"error": api_request_error_payload_fn("validation_error", "Image uploads must use an image content type.")},
                origin=origin,
            )
        if req.assetType == "video" and not normalized_content_type.startswith("video/"):
            return response_fn(
                400,
                {"error": api_request_error_payload_fn("validation_error", "Video uploads must use a video content type.")},
                origin=origin,
            )
        asset_id = new_id_fn("apiasset")
        asset_key = api_asset_paths_for_user_fn(user_id).upload_asset(asset_id, req.filename)
        return response_fn(
            200,
            {
                "assetId": asset_id,
                "assetKey": asset_key,
                "uploadUrl": asset_store.presign_put(asset_key, expires=900, content_type=req.contentType),
            },
            origin=origin,
        )

    if method == "GET" and path == "/api/v1/requests":
        requests = store.list_api_requests(user_id)
        query = extract_query_fn(event)
        status_filter = str(query.get("status") or "").strip().lower()
        workflow_filter = str(query.get("workflow") or "").strip().lower()
        model_filter = str(query.get("model") or "").strip()
        limit_raw = str(query.get("limit") or "").strip()
        limit = max(1, min(200, int(limit_raw))) if limit_raw.isdigit() else 100
        filtered: list[dict[str, Any]] = []
        for item in requests:
            if status_filter and str(item.get("status") or "").lower() != status_filter:
                continue
            if workflow_filter and str(item.get("workflow") or "").lower() != workflow_filter:
                continue
            if model_filter and str(item.get("model") or "") != model_filter:
                continue
            filtered.append(api_request_response_fn(item, asset_store))
            if len(filtered) >= limit:
                break
        return response_fn(200, {"requests": filtered}, origin=origin)

    if method == "GET" and path.startswith("/api/v1/requests/"):
        request_id_value = path.split("/")[4]
        request_record = store.load_api_request(user_id, request_id_value)
        if not request_record:
            return error_response_fn(404, "API request not found", origin=origin)
        job = None
        job_id = request_record.get("jobId")
        if isinstance(job_id, str) and job_id:
            job = store.load_job(user_id, job_id)
        return response_fn(200, api_request_response_fn(request_record, asset_store, job=job), origin=origin)

    if method == "POST" and path == "/api/v1/image-edits/full":
        req = json_model(ApiImageEditFullRequest, event)
        reference_asset_keys = _normalized_asset_keys(req.referenceAssetKeys)
        try:
            prompt = sanitize_prompt_fn(req.prompt)
            input_asset = validate_api_asset_key_fn(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.inputAssetKey,
                expected_type="image",
            )
            _validate_reference_asset_limit(
                model=req.model,
                reference_asset_keys=reference_asset_keys,
                limits=API_MULTI_REFERENCE_IMAGE_EDIT_LIMITS,
                context_label="This full image edit route",
            )
            reference_assets = [
                validate_api_asset_key_fn(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=asset_key,
                    expected_type="image",
                )
                for asset_key in reference_asset_keys
            ]
        except ValueError as exc:
            return response_fn(400, {"error": api_request_error_payload_fn("validation_error", str(exc))}, origin=origin)
        request_id_value = new_id_fn("apireq")
        job_id = queue_job_fn(
            store=store,
            queue=queue,
            user_id=user_id,
            task_id="__api__",
            job_type="api_image_edit_full",
            payload={
                "requestId": request_id_value,
                "model": req.model,
                "prompt": prompt,
                "inputAssetKey": req.inputAssetKey,
                "referenceAssetKeys": reference_asset_keys,
                "lumaUniModel": req.lumaUniModel,
                "lumaUniStyle": req.lumaUniStyle,
                "lumaUniOutputFormat": req.lumaUniOutputFormat,
            },
            enqueue=False,
        )
        request_record = {
            "requestId": request_id_value,
            "userId": user_id,
            "workflow": "image_edit_full",
            "model": req.model,
            "provider": "luma"
            if req.model in {"luma_uni_1", "luma_uni_1_max", "luma_uni_1_1"}
            else ("openai" if req.model in {"chatgpt", "chatgpt_latest"} else "gemini"),
            "status": "queued",
            "jobId": job_id,
            "createdAt": now_iso_fn(),
            "updatedAt": now_iso_fn(),
            "request": {
                "prompt": prompt,
                "referenceAssetKeys": reference_asset_keys,
                "lumaUniModel": req.lumaUniModel,
                "lumaUniStyle": req.lumaUniStyle,
                "lumaUniOutputFormat": req.lumaUniOutputFormat,
            },
            "inputAssets": {
                "input": input_asset,
                "referenceImages": reference_assets,
            },
            "preparedAssets": {},
            "outputAssets": {},
            "warnings": [],
            "error": None,
        }
        store.save_api_request(request_record)
        queue.enqueue({"jobId": job_id, "taskId": "__api__", "userId": user_id})
        return response_fn(202, {"requestId": request_id_value, "jobId": job_id}, origin=origin)

    if method == "POST" and path == "/api/v1/image-edits/patch":
        req = json_model(ApiImageEditPatchRequest, event)
        reference_asset_keys = _normalized_patch_reference_asset_keys(plural=req.referenceAssetKeys, singular=req.referenceAssetKey)
        try:
            prompt = sanitize_prompt_fn(req.prompt)
            input_asset = validate_api_asset_key_fn(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.inputAssetKey,
                expected_type="image",
            )
            patch_asset = validate_api_asset_key_fn(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.patchAssetKey,
                expected_type="image",
            )
            mask_asset = (
                validate_api_asset_key_fn(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=req.maskAssetKey,
                    expected_type="image",
                )
                if req.maskAssetKey
                else None
            )
            _validate_reference_asset_limit(
                model=req.model,
                reference_asset_keys=reference_asset_keys,
                limits=API_PATCH_REFERENCE_LIMITS,
                context_label="This patch image edit route",
            )
            reference_assets = [
                validate_api_asset_key_fn(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=asset_key,
                    expected_type="image",
                )
                for asset_key in reference_asset_keys
            ]
            if req.model == "runware_ace_pp" and not reference_assets:
                raise ValueError("Runware ACE++ requires a reference image")
        except ValueError as exc:
            return response_fn(400, {"error": api_request_error_payload_fn("validation_error", str(exc))}, origin=origin)
        request_id_value = new_id_fn("apireq")
        job_id = queue_job_fn(
            store=store,
            queue=queue,
            user_id=user_id,
            task_id="__api__",
            job_type="api_image_edit_patch",
            payload={
                "requestId": request_id_value,
                "model": req.model,
                "prompt": prompt,
                "inputAssetKey": req.inputAssetKey,
                "patchAssetKey": req.patchAssetKey,
                "maskAssetKey": req.maskAssetKey,
                "referenceAssetKey": req.referenceAssetKey,
                "referenceAssetKeys": reference_asset_keys,
                "patchRect": req.patchRect.model_dump(),
                "featherPx": req.featherPx,
                "bleedPx": req.bleedPx,
                "runwareRepaintingScale": req.runwareRepaintingScale,
                "edgeAwareRefine": req.edgeAwareRefine,
                "edgeAwareStrength": req.edgeAwareStrength,
                "edgeAwareRadiusPx": req.edgeAwareRadiusPx,
                "maskGrowPx": req.maskGrowPx,
            },
            enqueue=False,
        )
        request_record = {
            "requestId": request_id_value,
            "userId": user_id,
            "workflow": "image_edit_patch",
            "model": req.model,
            "provider": "runware" if req.model.startswith("runware_") else ("openai" if req.model in {"chatgpt", "chatgpt_latest"} else "gemini"),
            "status": "queued",
            "jobId": job_id,
            "createdAt": now_iso_fn(),
            "updatedAt": now_iso_fn(),
            "request": {
                "prompt": prompt,
                "patchRect": req.patchRect.model_dump(),
                "featherPx": req.featherPx,
                "bleedPx": req.bleedPx,
                "edgeAwareRefine": req.edgeAwareRefine,
                "edgeAwareStrength": req.edgeAwareStrength,
                "edgeAwareRadiusPx": req.edgeAwareRadiusPx,
                "maskGrowPx": req.maskGrowPx,
                "runwareRepaintingScale": req.runwareRepaintingScale,
                "referenceAssetKeys": reference_asset_keys,
            },
            "inputAssets": {
                "input": input_asset,
                "patch": patch_asset,
                "mask": mask_asset,
                "reference": reference_assets[0] if reference_assets else None,
                "referenceImages": reference_assets,
            },
            "preparedAssets": {},
            "outputAssets": {},
            "warnings": [],
            "error": None,
        }
        store.save_api_request(request_record)
        queue.enqueue({"jobId": job_id, "taskId": "__api__", "userId": user_id})
        return response_fn(202, {"requestId": request_id_value, "jobId": job_id}, origin=origin)

    if method == "POST" and path == "/api/v1/video-generations/reference-video":
        req = json_model(ApiReferenceVideoGenerateRequest, event)
        reference_asset_keys = _normalized_asset_keys(req.referenceAssetKeys)
        try:
            prompt = sanitize_prompt_fn(req.prompt) if req.prompt else None
            negative_prompt = sanitize_prompt_fn(req.negativePrompt) if req.negativePrompt else None
            validate_api_video_mode_fn(req.model, req.mode)
            validate_video_model_prompt_fn(req.model, prompt)
            capability = get_video_model_capability_fn(req.model)
            _validate_reference_asset_limit(
                model=req.model,
                reference_asset_keys=reference_asset_keys,
                limits=API_VIDEO_REFERENCE_LIMITS,
                context_label=f"{capability.label} in this route",
            )
            video_asset = (
                validate_api_asset_key_fn(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=req.videoAssetKey,
                    expected_type="video",
                )
                if capability.uses_source_video
                else None
            )
            if capability.uses_source_video and not req.videoAssetKey:
                raise ValueError(f"{capability.label} requires videoAssetKey")
            first_frame_asset = validate_api_asset_key_fn(
                asset_store=asset_store,
                user_id=user_id,
                asset_key=req.firstFrameAssetKey,
                expected_type="image",
            )
            last_frame_asset = (
                validate_api_asset_key_fn(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=req.lastFrameAssetKey,
                    expected_type="image",
                )
                if req.lastFrameAssetKey
                else None
            )
            reference_assets = [
                validate_api_asset_key_fn(
                    asset_store=asset_store,
                    user_id=user_id,
                    asset_key=asset_key,
                    expected_type="image",
                )
                for asset_key in reference_asset_keys
            ]
        except ValueError as exc:
            return response_fn(400, {"error": api_request_error_payload_fn("validation_error", str(exc))}, origin=origin)
        request_id_value = new_id_fn("apireq")
        job_id = queue_job_fn(
            store=store,
            queue=queue,
            user_id=user_id,
            task_id="__api__",
            job_type="api_video_generate_reference",
            payload={
                "requestId": request_id_value,
                "model": req.model,
                "mode": req.mode,
                "prompt": prompt,
                "negativePrompt": negative_prompt,
                "videoAssetKey": req.videoAssetKey,
                "firstFrameAssetKey": req.firstFrameAssetKey,
                "lastFrameAssetKey": req.lastFrameAssetKey,
                "referenceAssetKeys": reference_asset_keys,
                "durationSeconds": req.durationSeconds,
                "replicateKlingMode": req.replicateKlingMode,
                "replicateKlingV3Mode": req.replicateKlingV3Mode,
                "wan27Resolution": req.wan27Resolution,
                "happyHorseResolution": req.happyHorseResolution,
                "sora2Resolution": req.sora2Resolution,
                "preserveFrames": bool(req.preserveFrames),
            },
            enqueue=False,
        )
        request_record = {
            "requestId": request_id_value,
            "userId": user_id,
            "workflow": "video_generation_reference",
            "model": req.model,
            "provider": segment_generation_provider_name_fn(req.model),
            "status": "queued",
            "jobId": job_id,
            "createdAt": now_iso_fn(),
            "updatedAt": now_iso_fn(),
            "request": {
                "mode": req.mode,
                "prompt": prompt,
                "negativePrompt": negative_prompt,
                "referenceAssetKeys": reference_asset_keys,
                "durationSeconds": req.durationSeconds,
                "replicateKlingMode": req.replicateKlingMode,
                "replicateKlingV3Mode": req.replicateKlingV3Mode,
                "wan27Resolution": req.wan27Resolution,
                "happyHorseResolution": req.happyHorseResolution,
                "sora2Resolution": req.sora2Resolution,
                "preserveFrames": bool(req.preserveFrames),
            },
            "inputAssets": {
                "video": video_asset,
                "firstFrame": first_frame_asset,
                "lastFrame": last_frame_asset,
                "referenceImages": reference_assets,
            },
            "preparedAssets": {},
            "outputAssets": {},
            "warnings": [],
            "error": None,
        }
        store.save_api_request(request_record)
        queue.enqueue({"jobId": job_id, "taskId": "__api__", "userId": user_id})
        return response_fn(202, {"requestId": request_id_value, "jobId": job_id}, origin=origin)

    return None
