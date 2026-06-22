"""Canvas-workflow standalone routes.

Not tied to a video task/segment. The caller is already Cognito-authenticated by the
time the handler runs. Reuses shared helpers rather than inventing new shapes.

POST /canvas/prompt-wizard rewrites a lookdev / image draft prompt via the shared
OpenAI engine. Its system prompt (the "brain") is loaded from the editable
`admin/canvas_prompt_profiles.json` config, so it can be improved without a redeploy.

New routes (all additive, no existing behaviour changed):

  GET  /canvas/projects/{projectId}/state        -> { projectId, state, updatedAt }
  PUT  /canvas/projects/{projectId}/state        -> { ok, projectId, updatedAt }
  GET  /canvas/models                            -> { image: CanvasModel[], video: CanvasModel[] }
  POST /canvas/probe-media                       -> { ok, duration, width, height }
  POST /canvas/extract-frame                     -> { ok, assetKey, url }
  GET  /canvas/asset-url?assetKey=...            -> { url }

The old user-scoped GET/PUT /canvas/{taskId}/state is preserved for backward
compatibility (it matched on `path.endswith("/state")` which does NOT conflict
with the new project-scoped route because project routes go through the
`/canvas/projects/` prefix and are matched first).
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Annotated, Any, Callable

from pydantic import BaseModel, Field

from src.core.cost_tracking import build_usage_record, estimate_cost_from_pricing_entry
from src.generation.capabilities import VIDEO_MODELS

# A reference image may be a remote URL or an inline base64 data URL (data:image/...).
# Base64 data URLs are large, so the cap is generous; the frontend is expected to
# downscale before encoding to keep the request payload within Lambda's limit.
ReferenceImage = Annotated[str, Field(min_length=1, max_length=2_000_000)]

# Presigned URL TTL reused from api_handler constant (seconds).
_PRESIGNED_TTL = 3600

# S3 key prefix for canvas-extracted frame assets (project-scoped).
# Pattern: canvas/projects/{projectId}/frames/{frameId}.png
_CANVAS_FRAME_PREFIX = "canvas/projects"


class CanvasPromptWizardRequest(BaseModel):
    user_draft_prompt: str = Field(min_length=1, max_length=4000)
    profile: str = Field(default="lookdev", min_length=1, max_length=80)
    user_visible_model_name: str = Field(default="Lookdev", min_length=1, max_length=120)
    aspect_ratio: str | None = Field(default=None, max_length=16)
    # Single reference (kept for backward compatibility) and a multi-image list.
    # Both accept a remote URL or an inline base64 data URL. They are merged, the
    # single one first, before being handed to the wizard.
    reference_image_url: ReferenceImage | None = Field(default=None)
    reference_image_urls: list[ReferenceImage] = Field(default_factory=list, max_length=4)
    # Project context (Layer 4 of the brain): facts about THIS film (world, characters,
    # props, per-shot look). The brain's system prompt treats this as ground truth. The
    # frontend assembles it from the shot's script/shotlist/profile. Kept out of the
    # shared system prompt so general and project knowledge stay separate.
    project_context: str | None = Field(default=None, max_length=20000)


class CanvasStateRequest(BaseModel):
    # Arbitrary canvas state blob (graph, layout, wiring, prompts, manifests). Stored
    # verbatim per project so the canvas graph no longer depends on the Fivefold node.
    state: dict[str, Any] = Field(default_factory=dict)


class CanvasProbeMediaRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=2000)


class CanvasExtractFrameRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=2000)
    timeSeconds: float = Field(ge=0.0)
    projectId: str = Field(min_length=1, max_length=200)


def _safe_id_segment(value: str) -> bool:
    """Return True if value is a non-empty path segment with no slashes."""
    return bool(value) and "/" not in value


def _canvas_frame_asset_key(project_id: str, frame_id: str) -> str:
    """S3 key for a canvas-extracted frame PNG in the assets bucket."""
    safe_proj = re.sub(r"[^a-zA-Z0-9_-]+", "", project_id)[:80] or "proj"
    safe_frame = re.sub(r"[^a-zA-Z0-9_-]+", "", frame_id)[:40] or "frame"
    return f"{_CANVAS_FRAME_PREFIX}/{safe_proj}/frames/{safe_frame}.png"


# ---------------------------------------------------------------------------
# Image model registry
# Since capabilities.py only defines VideoModelCapability, image models are
# defined here as a static registry. These IDs must match what the canvas
# frontend expects (CanvasModel.id). Labels and providers are sourced from
# the existing FULL_EDIT_MODEL_IDS usage in contracts/video.py and api_handler.py.
# TODO(robin): If image model capabilities are promoted to a capabilities.py
# registry (like VideoModelCapability), replace this static dict with that.
# ---------------------------------------------------------------------------

_IMAGE_MODELS_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "nano_banana",
        "label": "Nano Banana",
        "provider": "runware",
        "supportsReferences": True,
        "maxReferenceImages": 3,
    },
    {
        "id": "nano_banana_pro",
        "label": "Nano Banana Pro",
        "provider": "runware",
        "supportsReferences": True,
        "maxReferenceImages": 4,
    },
    {
        "id": "chatgpt",
        "label": "ChatGPT Image",
        "provider": "openai",
        "supportsReferences": True,
        "maxReferenceImages": 4,
    },
    {
        "id": "chatgpt_latest",
        "label": "ChatGPT Image (Latest)",
        "provider": "openai",
        "supportsReferences": True,
        "maxReferenceImages": 4,
    },
    {
        "id": "luma_uni_1",
        "label": "Luma Uni 1",
        "provider": "luma",
        "supportsReferences": True,
        "maxReferenceImages": 4,
    },
    {
        "id": "luma_uni_1_max",
        "label": "Luma Uni 1 Max",
        "provider": "luma",
        "supportsReferences": True,
        "maxReferenceImages": 4,
    },
    {
        "id": "luma_uni_1_1",
        "label": "Luma Uni 1.1",
        "provider": "luma",
        "supportsReferences": True,
        "maxReferenceImages": 4,
    },
]


def _build_models_response() -> dict[str, Any]:
    """Build the GET /canvas/models response body.

    Maps capabilities.py VIDEO_MODELS and the static image registry into the
    CanvasModel shape expected by the canvas frontend:
      { id, label, provider, maxSeconds?, minSeconds?, supportsChunkedGeneration?,
        supportsExtension?, usesSourceVideo?, requiresPrompt?,
        supportsReferences?, maxReferenceImages? }

    The frontend types.ts (ModelsRegistry) was not present in this repo at
    implementation time, so the shape is inferred from VideoModelCapability
    fields and the image registry above.
    # TODO(robin): Once frontend/src/pages/canvas/types.ts exists, verify
    # CanvasModel field names match exactly and adjust this mapping.
    """
    video_models = []
    for model_id, cap in VIDEO_MODELS.items():
        video_models.append(
            {
                "id": model_id,
                "label": cap.label,
                "provider": cap.provider,
                "maxSeconds": cap.max_seconds,
                "minSeconds": cap.min_seconds,
                "requiresPrompt": cap.requires_prompt,
                "supportsChunkedGeneration": cap.supports_chunked_generation,
                "supportsExtension": cap.supports_extension,
                "usesSourceVideo": cap.uses_source_video,
                "firstFrameProfile": cap.first_frame_profile,
                "allowedModes": sorted(cap.allowed_modes),
            }
        )
    return {"image": _IMAGE_MODELS_REGISTRY, "video": video_models}


def handle_canvas_routes(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    claims: dict[str, Any],
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    store,
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    get_openai_api_key_fn: Callable[[], str],
    get_canvas_system_prompt_fn: Callable[[str], str | None],
    get_openai_pricing_entry_fn: Callable[[str], dict[str, Any] | None],
    get_openai_pricing_rates_fn: Callable[[str], dict[str, float] | None],
    improve_lookdev_prompt_fn: Callable[..., dict[str, Any]],
    logger,
    # --- New kwargs (additive, all have defaults so the existing call site keeps working) ---
    can_access_project_fn: Callable[..., bool] | None = None,
    is_admin_claims_fn: Callable[..., bool] | None = None,
    asset_store=None,
    assets_s3_client=None,
    assets_bucket: str | None = None,
) -> dict[str, Any] | None:
    if method == "POST" and path == "/canvas/prompt-wizard":
        req = json_model(CanvasPromptWizardRequest, event)
        draft_prompt = req.user_draft_prompt.strip()
        if not draft_prompt:
            return error_response_fn(400, "Prompt is required", origin=origin)

        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for the lookdev prompt wizard", origin=origin)

        # Load the brain (system prompt) from the editable server-side profile config.
        # Falls back to the built-in default inside improve_lookdev_prompt if absent.
        system_prompt = get_canvas_system_prompt_fn(req.profile)
        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")

        # Merge the single + list reference images into one ordered list (single first).
        reference_images = ([req.reference_image_url] if req.reference_image_url else []) + list(
            req.reference_image_urls
        )

        try:
            result, usage = improve_lookdev_prompt_fn(
                api_key=openai_api_key,
                user_draft_prompt=draft_prompt,
                user_visible_model_name=req.user_visible_model_name,
                aspect_ratio=req.aspect_ratio,
                reference_image_urls=reference_images,
                project_context=req.project_context,
                system_prompt=system_prompt,
                pricing_rates=pricing_rates,
            )
        except Exception as exc:
            logger.warning("Lookdev prompt wizard failed", extra={"userId": user_id, "error": str(exc)})
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
                source="canvas_prompt_wizard",
                tool_origin="canvas_prompt_wizard",
                workflow_id="canvas_workflow",
                pricing_entry=pricing_entry,
                estimate=estimate,
                notes=f"profile={req.profile}",
            )
            store.save_usage_record(usage_record)
        except Exception as exc:
            logger.warning("Canvas prompt wizard usage tracking failed", extra={"userId": user_id, "error": str(exc)})
        return response_fn(200, {"result": result, "usage": usage}, origin=origin)

    # -------------------------------------------------------------------------
    # GET /canvas/models
    # Returns the full image + video model registry for the canvas UI.
    # No project membership required — any authenticated caller may read this.
    # -------------------------------------------------------------------------
    if method == "GET" and path == "/canvas/models":
        return response_fn(200, _build_models_response(), origin=origin)

    # -------------------------------------------------------------------------
    # GET /canvas/asset-url?assetKey=...
    # Returns a short-lived presigned GET URL for an asset in the assets bucket.
    # No project membership check — the caller is already Cognito-authed and is
    # expected to have obtained the assetKey from a prior authorised response.
    # -------------------------------------------------------------------------
    if method == "GET" and path == "/canvas/asset-url":
        if asset_store is None:
            # TODO(robin): asset_store not threaded in — add it to the dispatcher call
            return error_response_fn(500, "asset_store not available for canvas asset-url", origin=origin)
        qs = event.get("queryStringParameters") or {}
        asset_key = str(qs.get("assetKey") or "").strip()
        if not asset_key:
            return error_response_fn(400, "assetKey query parameter is required", origin=origin)
        try:
            url = asset_store.presign_get(asset_key, expires=_PRESIGNED_TTL)
        except Exception as exc:
            logger.warning("Canvas asset-url presign failed", extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)})
            return error_response_fn(502, f"Could not generate presigned URL: {exc}", origin=origin)
        return response_fn(200, {"url": url}, origin=origin)

    # -------------------------------------------------------------------------
    # Project-scoped canvas state
    # GET  /canvas/projects/{projectId}/state  -> { projectId, state, updatedAt }
    # PUT  /canvas/projects/{projectId}/state  -> { ok, projectId, updatedAt }
    #
    # S3 key (metadata bucket): admin/projects/{projectId}/canvas_state.json
    # Access: caller must be a project member or an admin.
    # -------------------------------------------------------------------------
    _PROJECT_STATE_PREFIX = "/canvas/projects/"
    _PROJECT_STATE_SUFFIX = "/state"
    if path.startswith(_PROJECT_STATE_PREFIX) and path.endswith(_PROJECT_STATE_SUFFIX):
        inner = path[len(_PROJECT_STATE_PREFIX) : -len(_PROJECT_STATE_SUFFIX)]
        # inner must be exactly the projectId — no nested slashes allowed.
        if not inner or "/" in inner:
            return error_response_fn(400, "Invalid projectId in canvas state path", origin=origin)
        project_id = inner

        # Access check: must be a project member or admin.
        if can_access_project_fn is None or is_admin_claims_fn is None:
            # TODO(robin): can_access_project_fn / is_admin_claims_fn not threaded in
            return error_response_fn(500, "Project access check not available", origin=origin)
        project = store.load_project(project_id)
        is_admin = is_admin_claims_fn(claims)
        if project is None and not is_admin:
            return error_response_fn(404, "Project not found", origin=origin)
        if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
            return error_response_fn(403, "Access denied to project canvas state", origin=origin)

        state_key = f"admin/projects/{project_id}/canvas_state.json"

        if method == "GET":
            stored = store.get_json(state_key) or {}
            return response_fn(
                200,
                {
                    "projectId": project_id,
                    "state": stored.get("state", {}),
                    "updatedAt": stored.get("updatedAt"),
                },
                origin=origin,
            )
        if method == "PUT":
            req = json_model(CanvasStateRequest, event)
            now = now_iso_fn()
            payload = {
                "state": req.state,
                "updatedAt": now,
                "userId": user_id,
                "projectId": project_id,
            }
            store.put_json(state_key, payload)
            return response_fn(
                200,
                {"ok": True, "projectId": project_id, "updatedAt": now},
                origin=origin,
            )

    # -------------------------------------------------------------------------
    # POST /canvas/probe-media  body { assetKey }
    # Downloads the S3 object to /tmp and runs ffprobe_video.
    # Returns { ok, duration, width, height }.
    # -------------------------------------------------------------------------
    if method == "POST" and path == "/canvas/probe-media":
        if assets_s3_client is None or assets_bucket is None:
            # TODO(robin): assets_s3_client / assets_bucket not threaded in
            return error_response_fn(500, "S3 client not available for canvas probe-media", origin=origin)
        req = json_model(CanvasProbeMediaRequest, event)
        asset_key = req.assetKey.strip()
        if not asset_key:
            return error_response_fn(400, "assetKey is required", origin=origin)

        # Import here to avoid a module-level dependency on ffmpeg (keeps import
        # fast for routes that don't use it).
        from src.core.ffmpeg import FFmpegError, ffprobe_video

        try:
            with tempfile.TemporaryDirectory() as td:
                local_path = Path(td) / "probe_input.mp4"
                assets_s3_client.download_file(assets_bucket, asset_key, str(local_path))
                probe = ffprobe_video(str(local_path))
        except FFmpegError as exc:
            logger.warning("Canvas probe-media ffprobe failed", extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)})
            return error_response_fn(422, f"Media probe failed: {exc}", origin=origin)
        except Exception as exc:
            logger.warning("Canvas probe-media download failed", extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)})
            return error_response_fn(502, f"Could not retrieve asset: {exc}", origin=origin)

        return response_fn(
            200,
            {
                "ok": True,
                "duration": probe.get("duration_sec"),
                "width": probe.get("width"),
                "height": probe.get("height"),
            },
            origin=origin,
        )

    # -------------------------------------------------------------------------
    # POST /canvas/extract-frame  body { assetKey, timeSeconds, projectId }
    # Downloads S3 object, extracts a frame at timeSeconds, uploads the PNG to
    # the assets bucket, and returns a presigned GET URL.
    # Access: caller must be a project member or admin (same as project state).
    # -------------------------------------------------------------------------
    if method == "POST" and path == "/canvas/extract-frame":
        if asset_store is None or assets_s3_client is None or assets_bucket is None:
            # TODO(robin): asset_store / assets_s3_client / assets_bucket not threaded in
            return error_response_fn(500, "Asset store not available for canvas extract-frame", origin=origin)
        if can_access_project_fn is None or is_admin_claims_fn is None:
            # TODO(robin): can_access_project_fn / is_admin_claims_fn not threaded in
            return error_response_fn(500, "Project access check not available", origin=origin)

        req = json_model(CanvasExtractFrameRequest, event)
        asset_key = req.assetKey.strip()
        project_id = req.projectId.strip()

        if not asset_key:
            return error_response_fn(400, "assetKey is required", origin=origin)
        if not _safe_id_segment(project_id):
            return error_response_fn(400, "Invalid projectId", origin=origin)

        # Access check
        project = store.load_project(project_id)
        is_admin = is_admin_claims_fn(claims)
        if project is None and not is_admin:
            return error_response_fn(404, "Project not found", origin=origin)
        if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
            return error_response_fn(403, "Access denied to project canvas", origin=origin)

        from src.core.ffmpeg import FFmpegError, ffprobe_video, extract_frame_png

        try:
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                local_video = td_path / "source.mp4"
                local_frame = td_path / "frame.png"
                assets_s3_client.download_file(assets_bucket, asset_key, str(local_video))

                # Convert timeSeconds to a frame index using ffprobe fps.
                probe = ffprobe_video(str(local_video))
                from fractions import Fraction
                fps = Fraction(probe.get("fps_num", 24), probe.get("fps_den", 1))
                frame_index = max(0, int(round(req.timeSeconds * float(fps))))

                extract_frame_png(str(local_video), frame_index, str(local_frame))

                # Build the output key in the assets bucket.
                frame_id = new_id_fn("cvf")
                output_key = _canvas_frame_asset_key(project_id, frame_id)
                assets_s3_client.upload_file(
                    str(local_frame),
                    assets_bucket,
                    output_key,
                    ExtraArgs={"ContentType": "image/png", "ServerSideEncryption": "AES256"},
                )
        except FFmpegError as exc:
            logger.warning(
                "Canvas extract-frame ffmpeg failed",
                extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)},
            )
            return error_response_fn(422, f"Frame extraction failed: {exc}", origin=origin)
        except Exception as exc:
            logger.warning(
                "Canvas extract-frame failed",
                extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)},
            )
            return error_response_fn(502, f"Could not extract frame: {exc}", origin=origin)

        url = asset_store.presign_get(output_key, expires=_PRESIGNED_TTL)
        return response_fn(
            200,
            {"ok": True, "assetKey": output_key, "url": url},
            origin=origin,
        )

    return None
