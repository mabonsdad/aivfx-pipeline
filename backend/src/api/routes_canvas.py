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
from src.integrations.openai_canvas_chat import render_project_context
from src.integrations.canvas_skills import get_canvas_skill, list_canvas_skills, run_canvas_skill

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
    # Optional project id. When given and no explicit project_context is supplied, the
    # route loads the project's stored memory and renders it as the project context, so
    # every generation is automatically project-aware as the memory grows.
    project_id: str | None = Field(default=None, max_length=200)


class CanvasChatMessage(BaseModel):
    role: str = Field(min_length=1, max_length=20)
    content: str = Field(default="", max_length=200_000)


class CanvasChatRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=200)
    messages: list[CanvasChatMessage] = Field(min_length=1, max_length=60)
    profile: str = Field(default="lookdev", min_length=1, max_length=80)
    # Optional images for THIS turn (remote URLs or inline base64 data URLs), attached
    # to the most recent user message so the assistant can see what was referenced.
    attachment_image_urls: list[ReferenceImage] = Field(default_factory=list, max_length=6)


class CanvasMemoryRequest(BaseModel):
    # Full project memory document, replaced verbatim. Shape is free-form but the
    # render/chat code understands: summary (str), facts (str[]), references
    # ({label,url,note}[]), learnings ({rule,scope,...}[]), transcripts ({title,ts,summary}[]).
    memory: dict[str, Any] = Field(default_factory=dict)


class CanvasSkillRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=200)
    # The work data the skill consumes (e.g. for EOD: history, generations, costs, notes).
    # Summarised only; never persisted verbatim. The frontend assembles it from the
    # history tab + canvas state.
    payload: dict[str, Any] = Field(default_factory=dict)


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


class CanvasTrimVideoRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=2000)
    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)
    projectId: str = Field(min_length=1, max_length=200)


def _safe_id_segment(value: str) -> bool:
    """Return True if value is a non-empty path segment with no slashes."""
    return bool(value) and "/" not in value


def _canvas_frame_asset_key(project_id: str, frame_id: str) -> str:
    """S3 key for a canvas-extracted frame PNG in the assets bucket."""
    safe_proj = re.sub(r"[^a-zA-Z0-9_-]+", "", project_id)[:80] or "proj"
    safe_frame = re.sub(r"[^a-zA-Z0-9_-]+", "", frame_id)[:40] or "frame"
    return f"{_CANVAS_FRAME_PREFIX}/{safe_proj}/frames/{safe_frame}.png"


def _canvas_clip_asset_key(project_id: str, clip_id: str) -> str:
    """S3 key for a canvas-trimmed video clip (MP4) in the assets bucket."""
    safe_proj = re.sub(r"[^a-zA-Z0-9_-]+", "", project_id)[:80] or "proj"
    safe_clip = re.sub(r"[^a-zA-Z0-9_-]+", "", clip_id)[:40] or "clip"
    return f"{_CANVAS_FRAME_PREFIX}/{safe_proj}/clips/{safe_clip}.mp4"


def _project_memory_key(project_id: str) -> str:
    """S3 key (metadata bucket) for a project's canvas memory document."""
    return f"admin/projects/{project_id}/canvas_memory.json"


def _apply_memory_updates(
    memory: dict[str, Any],
    updates: dict[str, Any],
    *,
    now_iso: str,
) -> dict[str, Any]:
    """Merge chat-produced memory_updates into the stored memory document.

    Additive: summary is replaced when provided; facts / references / learnings are
    appended (facts de-duplicated). Never deletes existing knowledge.
    """
    memory = dict(memory or {})
    summary = updates.get("summary")
    if isinstance(summary, str) and summary.strip():
        memory["summary"] = summary.strip()

    existing_facts = [str(f) for f in (memory.get("facts") or []) if str(f).strip()]
    seen = {f.lower() for f in existing_facts}
    for fact in updates.get("facts_add") or []:
        f = str(fact).strip()
        if f and f.lower() not in seen:
            existing_facts.append(f)
            seen.add(f.lower())
    memory["facts"] = existing_facts

    references = list(memory.get("references") or [])
    for ref in updates.get("references_add") or []:
        if isinstance(ref, dict) and (ref.get("label") or ref.get("note")):
            references.append(
                {
                    "label": str(ref.get("label") or "").strip(),
                    "url": ref.get("url") if isinstance(ref.get("url"), str) else None,
                    "note": str(ref.get("note") or "").strip(),
                    "addedAt": now_iso,
                }
            )
    memory["references"] = references

    learnings = list(memory.get("learnings") or [])
    for item in updates.get("learnings_add") or []:
        if isinstance(item, dict) and str(item.get("rule") or "").strip():
            learnings.append(
                {
                    "rule": str(item.get("rule")).strip(),
                    "scope": str(item.get("scope") or "project").strip(),
                    "addedAt": now_iso,
                }
            )
    memory["learnings"] = learnings
    return memory


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
    run_canvas_chat_fn: Callable[..., tuple[dict[str, Any], dict[str, Any]]] | None = None,
    get_canvas_brain_fn: Callable[[str], str | None] | None = None,
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

        # Project context: prefer the caller-supplied text; otherwise, if a project id
        # is given, render the project's stored memory so the generation is project-aware.
        # Loading another project's memory is gated by the same access check as state.
        project_context = req.project_context
        if (not project_context or not project_context.strip()) and req.project_id:
            if can_access_project_fn is not None and is_admin_claims_fn is not None:
                project = store.load_project(req.project_id)
                is_admin = is_admin_claims_fn(claims)
                if project is None and not is_admin:
                    return error_response_fn(404, "Project not found", origin=origin)
                if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
                    return error_response_fn(403, "Access denied to project", origin=origin)
                stored_memory = (store.get_json(_project_memory_key(req.project_id)) or {}).get("memory", {})
                rendered = render_project_context(stored_memory)
                project_context = rendered or None

        try:
            result, usage = improve_lookdev_prompt_fn(
                api_key=openai_api_key,
                user_draft_prompt=draft_prompt,
                user_visible_model_name=req.user_visible_model_name,
                aspect_ratio=req.aspect_ratio,
                reference_image_urls=reference_images,
                project_context=project_context,
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

    # -------------------------------------------------------------------------
    # POST /canvas/trim-video  body { assetKey, start, end, projectId }
    # Cuts the source video to keep [start, end] seconds at native rate, uploads the
    # MP4 to the assets bucket, returns a presigned GET URL. Runs ffmpeg synchronously
    # in Lambda (same pattern as extract-frame); fine for short lookdev reference clips.
    # NOTE: very long clips can exceed Lambda's limits -> a worker job would be needed
    # then (worker already has trim_and_retime_video_uniform). Access: member or admin.
    # -------------------------------------------------------------------------
    if method == "POST" and path == "/canvas/trim-video":
        if asset_store is None or assets_s3_client is None or assets_bucket is None:
            return error_response_fn(500, "Asset store not available for canvas trim-video", origin=origin)
        if can_access_project_fn is None or is_admin_claims_fn is None:
            return error_response_fn(500, "Project access check not available", origin=origin)

        req = json_model(CanvasTrimVideoRequest, event)
        asset_key = req.assetKey.strip()
        project_id = req.projectId.strip()
        if not asset_key:
            return error_response_fn(400, "assetKey is required", origin=origin)
        if not _safe_id_segment(project_id):
            return error_response_fn(400, "Invalid projectId", origin=origin)
        if req.end <= req.start:
            return error_response_fn(400, "end must be greater than start", origin=origin)

        project = store.load_project(project_id)
        is_admin = is_admin_claims_fn(claims)
        if project is None and not is_admin:
            return error_response_fn(404, "Project not found", origin=origin)
        if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
            return error_response_fn(403, "Access denied to project canvas", origin=origin)

        from src.core.ffmpeg import FFmpegError, ffprobe_video, trim_and_retime_video_uniform

        try:
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                local_video = td_path / "source.mp4"
                local_out = td_path / "clip.mp4"
                assets_s3_client.download_file(assets_bucket, asset_key, str(local_video))

                from fractions import Fraction
                probe = ffprobe_video(str(local_video))
                fps = Fraction(probe.get("fps_num", 24) or 24, probe.get("fps_den", 1) or 1)
                duration_sec = float(probe.get("duration_sec") or 0.0)
                # Keep [start, end]: trim head before start, trim tail after end.
                start_frames = max(0, int(round(req.start * float(fps))))
                tail_sec = max(0.0, duration_sec - req.end) if duration_sec else 0.0
                end_frames = max(0, int(round(tail_sec * float(fps))))

                trim_and_retime_video_uniform(
                    str(local_video),
                    str(local_out),
                    fps=fps,
                    playback_rate=1.0,
                    trim_start_frames=start_frames,
                    trim_end_frames=end_frames,
                )

                clip_id = new_id_fn("cvc")
                output_key = _canvas_clip_asset_key(project_id, clip_id)
                assets_s3_client.upload_file(
                    str(local_out),
                    assets_bucket,
                    output_key,
                    ExtraArgs={"ContentType": "video/mp4", "ServerSideEncryption": "AES256"},
                )
                out_probe = ffprobe_video(str(local_out))
        except FFmpegError as exc:
            logger.warning("Canvas trim-video ffmpeg failed", extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)})
            return error_response_fn(422, f"Video trim failed: {exc}", origin=origin)
        except Exception as exc:
            logger.warning("Canvas trim-video failed", extra={"userId": user_id, "assetKey": asset_key, "error": str(exc)})
            return error_response_fn(502, f"Could not trim video: {exc}", origin=origin)

        url = asset_store.presign_get(output_key, expires=_PRESIGNED_TTL)
        return response_fn(
            200,
            {"ok": True, "assetKey": output_key, "url": url, "duration": out_probe.get("duration_sec")},
            origin=origin,
        )

    # -------------------------------------------------------------------------
    # Project-scoped canvas MEMORY (the brain's growing project layer)
    # GET  /canvas/projects/{projectId}/memory  -> { projectId, memory, updatedAt }
    # PUT  /canvas/projects/{projectId}/memory  -> { ok, projectId, updatedAt }
    #
    # S3 key (metadata bucket): admin/projects/{projectId}/canvas_memory.json
    # Access: caller must be a project member or an admin (same as state).
    # This is what the chat assistant writes to and what prompt-wizard reads from.
    # -------------------------------------------------------------------------
    _PROJECT_MEMORY_PREFIX = "/canvas/projects/"
    _PROJECT_MEMORY_SUFFIX = "/memory"
    if path.startswith(_PROJECT_MEMORY_PREFIX) and path.endswith(_PROJECT_MEMORY_SUFFIX):
        inner = path[len(_PROJECT_MEMORY_PREFIX) : -len(_PROJECT_MEMORY_SUFFIX)]
        if not inner or "/" in inner:
            return error_response_fn(400, "Invalid projectId in canvas memory path", origin=origin)
        project_id = inner

        if can_access_project_fn is None or is_admin_claims_fn is None:
            return error_response_fn(500, "Project access check not available", origin=origin)
        project = store.load_project(project_id)
        is_admin = is_admin_claims_fn(claims)
        if project is None and not is_admin:
            return error_response_fn(404, "Project not found", origin=origin)
        if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
            return error_response_fn(403, "Access denied to project memory", origin=origin)

        memory_key = _project_memory_key(project_id)
        if method == "GET":
            stored = store.get_json(memory_key) or {}
            return response_fn(
                200,
                {
                    "projectId": project_id,
                    "memory": stored.get("memory", {}),
                    "updatedAt": stored.get("updatedAt"),
                },
                origin=origin,
            )
        if method == "PUT":
            req = json_model(CanvasMemoryRequest, event)
            now = now_iso_fn()
            store.put_json(
                memory_key,
                {"memory": req.memory, "updatedAt": now, "userId": user_id, "projectId": project_id},
            )
            return response_fn(200, {"ok": True, "projectId": project_id, "updatedAt": now}, origin=origin)

    # -------------------------------------------------------------------------
    # POST /canvas/chat  body { projectId, messages[], profile?, attachment_image_urls? }
    # The conversational GPT 5.5 assistant. Loads project memory as ground truth,
    # returns a reply + memory_updates (applied server-side, so the brain grows) +
    # canvas_actions (for the frontend to place nodes). Access: member or admin.
    # -------------------------------------------------------------------------
    if method == "POST" and path == "/canvas/chat":
        if run_canvas_chat_fn is None:
            return error_response_fn(500, "Canvas chat engine not available", origin=origin)
        if can_access_project_fn is None or is_admin_claims_fn is None:
            return error_response_fn(500, "Project access check not available", origin=origin)

        req = json_model(CanvasChatRequest, event)
        project_id = req.projectId.strip()
        if not _safe_id_segment(project_id):
            return error_response_fn(400, "Invalid projectId", origin=origin)

        project = store.load_project(project_id)
        is_admin = is_admin_claims_fn(claims)
        if project is None and not is_admin:
            return error_response_fn(404, "Project not found", origin=origin)
        if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
            return error_response_fn(403, "Access denied to project chat", origin=origin)

        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for the canvas chat", origin=origin)

        # Brain: live-tunable via the admin profile key `canvas_chat` (no fallback to the
        # lookdev wizard brain). When the key is absent, get_canvas_brain_fn returns None and
        # the chat engine uses its built-in conversational default.
        system_prompt = get_canvas_brain_fn("canvas_chat") if get_canvas_brain_fn else None
        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")

        # Load the current project memory and render it as ground-truth context.
        memory_record = store.get_json(_project_memory_key(project_id)) or {}
        memory_doc = memory_record.get("memory", {}) if isinstance(memory_record, dict) else {}
        project_context = render_project_context(memory_doc)

        try:
            result, usage = run_canvas_chat_fn(
                api_key=openai_api_key,
                messages=[{"role": m.role, "content": m.content} for m in req.messages],
                project_context=project_context,
                attachment_image_urls=list(req.attachment_image_urls),
                system_prompt=system_prompt,
                pricing_rates=pricing_rates,
            )
        except Exception as exc:
            logger.warning("Canvas chat failed", extra={"userId": user_id, "error": str(exc)})
            return error_response_fn(502, str(exc), origin=origin)

        # Apply memory_updates to the store so the project understanding grows.
        memory_updated_at = memory_record.get("updatedAt") if isinstance(memory_record, dict) else None
        updates = result.get("memory_updates") or {}
        has_updates = bool(
            updates.get("summary")
            or updates.get("facts_add")
            or updates.get("references_add")
            or updates.get("learnings_add")
        )
        if has_updates:
            try:
                now = now_iso_fn()
                merged = _apply_memory_updates(memory_doc, updates, now_iso=now)
                store.put_json(
                    _project_memory_key(project_id),
                    {"memory": merged, "updatedAt": now, "userId": user_id, "projectId": project_id},
                )
                memory_doc = merged
                memory_updated_at = now
            except Exception as exc:
                logger.warning("Canvas chat memory write failed", extra={"userId": user_id, "error": str(exc)})

        # Cost tracking (mirror the prompt wizard).
        try:
            estimate = estimate_cost_from_pricing_entry(pricing_entry, usage=usage)
            usage_record = build_usage_record(
                usage_record_id=new_id_fn("usage"),
                now_iso=now_iso_fn(),
                user_id=user_id,
                provider="openai",
                provider_model="gpt-5.5",
                app_model_id="gpt-5.5",
                request_type="chat",
                source="canvas_chat",
                tool_origin="canvas_chat",
                workflow_id="canvas_workflow",
                pricing_entry=pricing_entry,
                estimate=estimate,
                notes=f"project={project_id}",
            )
            store.save_usage_record(usage_record)
        except Exception as exc:
            logger.warning("Canvas chat usage tracking failed", extra={"userId": user_id, "error": str(exc)})

        return response_fn(
            200,
            {
                "reply": result.get("reply", ""),
                "canvasActions": result.get("canvas_actions", []),
                "memory": memory_doc,
                "memoryUpdatedAt": memory_updated_at,
                "usage": usage,
            },
            origin=origin,
        )

    # -------------------------------------------------------------------------
    # GET /canvas/skills -> { skills: [{name, description}] }
    # The named capabilities the frontend can trigger (e.g. an EOD button).
    # -------------------------------------------------------------------------
    if method == "GET" and path == "/canvas/skills":
        return response_fn(200, {"skills": list_canvas_skills()}, origin=origin)

    # -------------------------------------------------------------------------
    # POST /canvas/skill/{skillName}  body { projectId, payload }
    # Run a named skill against the project memory. EOD is the first skill: it turns
    # the day's work into an end-of-day report and writes a handover entry into the
    # project memory (a session "handover card", so the project brain accumulates a
    # daily trail for later automated reporting). Project-gated, cost-tracked.
    # -------------------------------------------------------------------------
    _SKILL_PREFIX = "/canvas/skill/"
    if method == "POST" and path.startswith(_SKILL_PREFIX):
        skill_name = path[len(_SKILL_PREFIX) :]
        if not skill_name or "/" in skill_name:
            return error_response_fn(400, "Invalid skill name", origin=origin)
        skill = get_canvas_skill(skill_name)
        if skill is None:
            return error_response_fn(404, f"Unknown canvas skill: {skill_name}", origin=origin)
        if can_access_project_fn is None or is_admin_claims_fn is None:
            return error_response_fn(500, "Project access check not available", origin=origin)

        req = json_model(CanvasSkillRequest, event)
        project_id = req.projectId.strip()
        if not _safe_id_segment(project_id):
            return error_response_fn(400, "Invalid projectId", origin=origin)

        project = store.load_project(project_id)
        is_admin = is_admin_claims_fn(claims)
        if project is None and not is_admin:
            return error_response_fn(404, "Project not found", origin=origin)
        if not can_access_project_fn(project, user_id=user_id, is_admin=is_admin):
            return error_response_fn(403, "Access denied to project", origin=origin)

        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for canvas skills", origin=origin)

        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")

        memory_record = store.get_json(_project_memory_key(project_id)) or {}
        memory_doc = memory_record.get("memory", {}) if isinstance(memory_record, dict) else {}
        project_context = render_project_context(memory_doc)

        # Live-tunable skill brain via admin profile key `skill_{name}` (no wizard fallback).
        skill_brain_override = get_canvas_brain_fn(f"skill_{skill_name}") if get_canvas_brain_fn else None

        try:
            result, usage = run_canvas_skill(
                api_key=openai_api_key,
                skill=skill,
                payload=req.payload,
                project_context=project_context,
                pricing_rates=pricing_rates,
                system_prompt_override=skill_brain_override,
            )
        except Exception as exc:
            logger.warning("Canvas skill failed", extra={"userId": user_id, "skill": skill_name, "error": str(exc)})
            return error_response_fn(502, str(exc), origin=origin)

        # For EOD, append a handover entry to the project memory so the brain keeps a
        # session trail (a "handover card" per run). Additive, best-effort.
        if skill_name == "eod":
            try:
                now = now_iso_fn()
                tldr = [str(t) for t in (result.get("tldr") or []) if str(t).strip()]
                handover = {
                    "date": str(req.payload.get("date") or now),
                    "tldr": tldr,
                    "summary": str(result.get("full_report") or "").strip(),
                    "createdAt": now,
                }
                handovers = list(memory_doc.get("handovers") or [])
                handovers.append(handover)
                memory_doc = dict(memory_doc)
                memory_doc["handovers"] = handovers
                store.put_json(
                    _project_memory_key(project_id),
                    {"memory": memory_doc, "updatedAt": now, "userId": user_id, "projectId": project_id},
                )
            except Exception as exc:
                logger.warning("Canvas EOD handover write failed", extra={"userId": user_id, "error": str(exc)})

        try:
            estimate = estimate_cost_from_pricing_entry(pricing_entry, usage=usage)
            usage_record = build_usage_record(
                usage_record_id=new_id_fn("usage"),
                now_iso=now_iso_fn(),
                user_id=user_id,
                provider="openai",
                provider_model="gpt-5.5",
                app_model_id="gpt-5.5",
                request_type="skill",
                source=f"canvas_skill:{skill_name}",
                tool_origin="canvas_skill",
                workflow_id="canvas_workflow",
                pricing_entry=pricing_entry,
                estimate=estimate,
                notes=f"skill={skill_name} project={project_id}",
            )
            store.save_usage_record(usage_record)
        except Exception as exc:
            logger.warning("Canvas skill usage tracking failed", extra={"userId": user_id, "skill": skill_name, "error": str(exc)})

        return response_fn(200, {"skill": skill_name, "result": result, "usage": usage}, origin=origin)

    return None
