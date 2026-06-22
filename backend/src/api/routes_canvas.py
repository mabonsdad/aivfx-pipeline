"""Canvas-workflow standalone routes.

Not tied to a video task/segment. The caller is already Cognito-authenticated by the
time the handler runs. Reuses shared helpers rather than inventing new shapes.

POST /canvas/prompt-wizard rewrites a lookdev / image draft prompt via the shared
OpenAI engine. Its system prompt (the "brain") is loaded from the editable
`admin/canvas_prompt_profiles.json` config, so it can be improved without a redeploy.
"""

from __future__ import annotations

from typing import Annotated, Any, Callable

from pydantic import BaseModel, Field

from src.core.cost_tracking import build_usage_record, estimate_cost_from_pricing_entry

# A reference image may be a remote URL or an inline base64 data URL (data:image/...).
# Base64 data URLs are large, so the cap is generous; the frontend is expected to
# downscale before encoding to keep the request payload within Lambda's limit.
ReferenceImage = Annotated[str, Field(min_length=1, max_length=2_000_000)]


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
    # verbatim per task so the canvas can live on Robin's S3 instead of the Fivefold node.
    state: dict[str, Any] = Field(default_factory=dict)


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

    # --- Canvas state storage ---------------------------------------------------------
    # One JSON blob per task on Robin's S3 (via S3JsonStore), so the canvas graph/layout/
    # wiring/prompts/manifests no longer depend on the Fivefold node being reachable.
    # GET  /canvas/{taskId}/state  -> { taskId, state, updatedAt }
    # PUT  /canvas/{taskId}/state  -> stores { state } verbatim
    if path.startswith("/canvas/") and path.endswith("/state"):
        task_id = path[len("/canvas/") : -len("/state")]
        if not task_id or "/" in task_id:
            return error_response_fn(400, "Invalid canvas task id", origin=origin)
        state_key = f"users/{user_id}/tasks/{task_id}/canvas_state.json"
        if method == "GET":
            stored = store.get_json(state_key) or {}
            return response_fn(
                200,
                {"taskId": task_id, "state": stored.get("state", {}), "updatedAt": stored.get("updatedAt")},
                origin=origin,
            )
        if method == "PUT":
            req = json_model(CanvasStateRequest, event)
            payload = {
                "state": req.state,
                "updatedAt": now_iso_fn(),
                "userId": user_id,
                "taskId": task_id,
            }
            store.put_json(state_key, payload)
            return response_fn(200, {"ok": True, "taskId": task_id, "updatedAt": payload["updatedAt"]}, origin=origin)

    return None
