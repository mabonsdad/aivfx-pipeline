"""Canvas-workflow standalone routes.

Not tied to a video task/segment. The caller is already Cognito-authenticated by the
time the handler runs. Reuses shared helpers rather than inventing new shapes.

POST /canvas/prompt-wizard rewrites a lookdev / image draft prompt via the shared
OpenAI engine. Its system prompt (the "brain") is loaded from the editable
`admin/canvas_prompt_profiles.json` config, so it can be improved without a redeploy.

The media routes (`/canvas/{taskId}/media/{probe|extract-frame|trim}`) own all
ffmpeg work and register outputs into the task. The remaining canvas state lives in
two per-task sibling JSON blobs alongside `task.json` (Robin's recommended boundary:
task is the storage namespace, with a single task per project for now):
  - canvas_state.json  : the node graph / layout / prompts / history (the editor state)
  - canvas_memory.json : the project "brain" (summary, facts, references, learnings,
                         handovers) that the chat assistant and EOD skill grow over time
Plus a conversational GPT chat (`POST /canvas/{taskId}/chat`) and a skills framework
(`GET /canvas/skills`, `POST /canvas/{taskId}/skill/{name}`, first skill: EOD report).
"""

from __future__ import annotations

import json
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Annotated, Any, Callable

from pydantic import BaseModel, Field

from src.core.asset_origin import build_asset_origin
from src.core.cost_tracking import build_usage_record, estimate_cost_from_pricing_entry
from src.core.ffmpeg import extract_audio_segment, extract_frame_png, ffprobe_audio, ffprobe_video, trim_video_segment
from src.integrations.openai_canvas_chat import render_project_context
from src.integrations.canvas_skills import get_canvas_skill, list_canvas_skills, run_canvas_skill

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


class CanvasMediaProbeRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=1024)


class CanvasMediaExtractFrameRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=1024)
    frameIndex: int | None = Field(default=None, ge=0)
    timeSec: float | None = Field(default=None, ge=0.0)
    outputWidth: int | None = Field(default=None, ge=1, le=8192)
    outputHeight: int | None = Field(default=None, ge=1, le=8192)


class CanvasMediaTrimRequest(BaseModel):
    assetKey: str = Field(min_length=1, max_length=1024)
    startSec: float = Field(ge=0.0)
    durationSec: float = Field(gt=0.0, le=600.0)
    targetFps: float | None = Field(default=None, gt=0.0, le=120.0)
    targetWidth: int | None = Field(default=None, ge=1, le=8192)
    targetHeight: int | None = Field(default=None, ge=1, le=8192)
    resizeMode: str = Field(default="pad", max_length=16)


# The canvas state blob is free-form (the frontend computes the whole graph and
# persists it). Cap the size so a runaway client cannot write an unbounded object.
class CanvasStatePutRequest(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)


class CanvasMemoryPutRequest(BaseModel):
    memory: dict[str, Any] = Field(default_factory=dict)


class CanvasChatMessage(BaseModel):
    role: str = Field(default="user", max_length=16)
    content: str = Field(default="", max_length=200_000)


class CanvasChatRequest(BaseModel):
    messages: list[CanvasChatMessage] = Field(default_factory=list, max_length=60)
    attachment_image_urls: list[str] = Field(default_factory=list, max_length=8)
    profile: str = Field(default="canvas_chat", min_length=1, max_length=80)


class CanvasSkillRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    profile: str | None = Field(default=None, max_length=80)


class CanvasGenerateImageRequest(BaseModel):
    # One route covers edit (inputAssetKey set), reference-based, and pure
    # text-to-image (none set). Inputs/references are asset keys the user already
    # uploaded (e.g. via /api/v1/assets/uploads/init), so no new upload path is needed.
    prompt: str = Field(default="", max_length=8000)
    model: str = Field(default="nano_banana", min_length=1, max_length=80)
    inputAssetKey: str | None = Field(default=None, max_length=1024)
    referenceAssetKeys: list[str] = Field(default_factory=list, max_length=6)
    seed: int | None = Field(default=None)
    aspectRatio: str | None = Field(default=None, max_length=16)


def _canvas_path_parts(path: str) -> list[str]:
    return [part for part in str(path or "").split("/") if part]


def _load_canvas_task_or_404(store, user_id: str, task_id: str) -> dict[str, Any] | None:
    task = store.load_task(user_id, task_id)
    if isinstance(task, dict) and not task.get("deletedAt"):
        return task
    return None


def _canvas_validate_task_asset(
    *,
    task: dict[str, Any],
    asset_key: str,
    asset_store,
    error_response_fn: Callable[..., dict[str, Any]],
    origin: str | None,
) -> tuple[dict[str, Any], str] | tuple[dict[str, Any], None]:
    task_prefix = f"users/{task['userId']}/tasks/{task['taskId']}/"
    normalized_key = str(asset_key or "").strip()
    if not normalized_key.startswith(task_prefix):
        return error_response_fn(400, "Asset key is outside this task", origin=origin), None
    try:
        head = asset_store.head_object(normalized_key)
    except Exception:
        return error_response_fn(404, "Asset not found", origin=origin), None
    return head, normalized_key


def _canvas_register_media_asset(
    *,
    task: dict[str, Any],
    store,
    asset_store,
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    operation: str,
    source_key: str,
    output_filename: str,
    output_bytes: bytes,
    content_type: str,
    media_kind: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    asset_id = new_id_fn("canvasmedia")
    output_key = asset_paths_for_task_fn(task).canvas_media_asset(asset_id, output_filename)
    asset_store.put_bytes(output_key, output_bytes, content_type=content_type)
    now = now_iso_fn()
    record = {
        "assetId": asset_id,
        "operation": operation,
        "mediaKind": media_kind,
        "sourceKey": source_key,
        "outputKey": output_key,
        "filename": output_filename,
        "contentType": content_type,
        "createdAt": now,
        "updatedAt": now,
        "metadata": metadata,
        "origin": build_asset_origin(
            workflow_id=str(task.get("workflowId") or "canvas_workflow"),
            step_origin="canvas_media",
            tool_origin=operation,
            app_surface="canvas_workflow",
        ),
    }
    task.setdefault("canvasMediaAssets", []).append(record)
    task.setdefault("history", []).append(
        {
            "at": now,
            "event": "canvas.media.created",
            "assetId": asset_id,
            "operation": operation,
            "sourceKey": source_key,
            "outputKey": output_key,
        }
    )
    store.save_task(task, merge_on_conflict=True)
    payload = json.loads(json.dumps(record))
    if isinstance(payload.get("outputKey"), str):
        payload["outputUrl"] = asset_store.presign_get(payload["outputKey"])
    return payload


def _canvas_state_key(task: dict[str, Any]) -> str:
    """Per-task canvas state blob, sibling to task.json (NOT folded into it)."""
    return f"users/{task['userId']}/tasks/{task['taskId']}/canvas_state.json"


def _canvas_memory_key(task: dict[str, Any]) -> str:
    """Per-task canvas memory blob (the project brain), sibling to task.json."""
    return f"users/{task['userId']}/tasks/{task['taskId']}/canvas_memory.json"


def _default_canvas_memory() -> dict[str, Any]:
    return {"summary": "", "facts": [], "references": [], "learnings": [], "handovers": []}


def _apply_memory_updates(
    memory: dict[str, Any], updates: dict[str, Any], *, now_iso: str
) -> dict[str, Any]:
    """Fold a chat turn's memory_updates into the stored project memory.

    Summary is replaced when present; facts / references / learnings are appended
    with light de-duplication so the brain grows without accumulating duplicates.
    """
    mem = dict(memory) if isinstance(memory, dict) else _default_canvas_memory()
    mem.setdefault("facts", [])
    mem.setdefault("references", [])
    mem.setdefault("learnings", [])
    mem.setdefault("handovers", [])

    summary = updates.get("summary")
    if isinstance(summary, str) and summary.strip():
        mem["summary"] = summary.strip()

    existing_facts = {str(f).strip().lower() for f in mem["facts"]}
    for fact in updates.get("facts_add") or []:
        text = str(fact).strip()
        if text and text.lower() not in existing_facts:
            mem["facts"].append(text)
            existing_facts.add(text.lower())

    existing_refs = {str(r.get("label", "")).strip().lower() for r in mem["references"] if isinstance(r, dict)}
    for ref in updates.get("references_add") or []:
        if not isinstance(ref, dict):
            continue
        label = str(ref.get("label") or "").strip()
        if label and label.lower() in existing_refs:
            continue
        mem["references"].append(
            {"label": label, "url": ref.get("url"), "note": str(ref.get("note") or "").strip(), "addedAt": now_iso}
        )
        if label:
            existing_refs.add(label.lower())

    existing_rules = {str(l.get("rule", "")).strip().lower() for l in mem["learnings"] if isinstance(l, dict)}
    for item in updates.get("learnings_add") or []:
        if not isinstance(item, dict):
            continue
        rule = str(item.get("rule") or "").strip()
        if rule and rule.lower() not in existing_rules:
            mem["learnings"].append({"rule": rule, "scope": str(item.get("scope") or "project").strip(), "addedAt": now_iso})
            existing_rules.add(rule.lower())

    mem["updatedAt"] = now_iso
    return mem


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
    asset_store,
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    get_openai_api_key_fn: Callable[[], str],
    get_canvas_system_prompt_fn: Callable[[str], str | None],
    get_openai_pricing_entry_fn: Callable[[str], dict[str, Any] | None],
    get_openai_pricing_rates_fn: Callable[[str], dict[str, float] | None],
    improve_lookdev_prompt_fn: Callable[..., dict[str, Any]],
    logger,
    get_canvas_brain_fn: Callable[[str], str | None] | None = None,
    run_canvas_chat_fn: Callable[..., tuple[dict[str, Any], dict[str, Any]]] | None = None,
    queue_job_fn: Callable[..., str] | None = None,
) -> dict[str, Any] | None:
    path_parts = _canvas_path_parts(path)

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

    if len(path_parts) == 4 and path_parts[0] == "canvas" and path_parts[2] == "media" and method == "POST":
        task_id = path_parts[1]
        operation = path_parts[3]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)

        if operation == "probe":
            req = json_model(CanvasMediaProbeRequest, event)
            head_or_response, normalized_key = _canvas_validate_task_asset(
                task=task,
                asset_key=req.assetKey,
                asset_store=asset_store,
                error_response_fn=error_response_fn,
                origin=origin,
            )
            if normalized_key is None:
                return head_or_response
            head = head_or_response
            content_type = str(head.get("ContentType") or "")
            with tempfile.TemporaryDirectory() as td:
                source_path = Path(td) / (Path(normalized_key).name or "media.bin")
                asset_store.s3.download_file(asset_store.assets_bucket, normalized_key, str(source_path))
                if content_type.startswith("audio/"):
                    probe = ffprobe_audio(str(source_path))
                    return response_fn(
                        200,
                        {
                            "mediaKind": "audio",
                            "assetKey": normalized_key,
                            "contentType": content_type,
                            "probe": probe,
                        },
                        origin=origin,
                    )
                probe = ffprobe_video(str(source_path))
                return response_fn(
                    200,
                    {
                        "mediaKind": "video",
                        "assetKey": normalized_key,
                        "contentType": content_type,
                        "probe": probe,
                    },
                    origin=origin,
                )

        if operation == "extract-frame":
            req = json_model(CanvasMediaExtractFrameRequest, event)
            head_or_response, normalized_key = _canvas_validate_task_asset(
                task=task,
                asset_key=req.assetKey,
                asset_store=asset_store,
                error_response_fn=error_response_fn,
                origin=origin,
            )
            if normalized_key is None:
                return head_or_response
            head = head_or_response
            content_type = str(head.get("ContentType") or "")
            if not content_type.startswith("video/"):
                return error_response_fn(400, "Frame extraction requires a video asset", origin=origin)
            with tempfile.TemporaryDirectory() as td:
                source_path = Path(td) / (Path(normalized_key).name or "video.mp4")
                output_path = Path(td) / "frame.png"
                asset_store.s3.download_file(asset_store.assets_bucket, normalized_key, str(source_path))
                probe = ffprobe_video(str(source_path))
                fps_value = (
                    float(probe.get("fps_num") or 0) / float(probe.get("fps_den") or 1)
                    if probe.get("fps_num")
                    else 30.0
                )
                frame_count = max(1, int(probe.get("frame_count") or 1))
                requested_frame_index = (
                    int(req.frameIndex)
                    if req.frameIndex is not None
                    else max(0, min(frame_count - 1, int(round(float(req.timeSec or 0.0) * fps_value))))
                )
                frame_index = max(0, min(frame_count - 1, requested_frame_index))
                extract_frame_png(
                    str(source_path),
                    frame_index,
                    str(output_path),
                    output_width=req.outputWidth,
                    output_height=req.outputHeight,
                )
                output_record = _canvas_register_media_asset(
                    task=task,
                    store=store,
                    asset_store=asset_store,
                    asset_paths_for_task_fn=asset_paths_for_task_fn,
                    new_id_fn=new_id_fn,
                    now_iso_fn=now_iso_fn,
                    operation="canvas_extract_frame",
                    source_key=normalized_key,
                    output_filename=f"{Path(source_path).stem or 'frame'}_{frame_index:04d}.png",
                    output_bytes=output_path.read_bytes(),
                    content_type="image/png",
                    media_kind="image",
                    metadata={
                        "frameIndex": frame_index,
                        "requestedFrameIndex": req.frameIndex,
                        "requestedTimeSec": req.timeSec,
                        "sourceProbe": probe,
                    },
                )
                return response_fn(
                    200,
                    {
                        "asset": output_record,
                        "frameIndex": frame_index,
                        "requestedFrameIndex": req.frameIndex,
                    },
                    origin=origin,
                )

        if operation == "trim":
            req = json_model(CanvasMediaTrimRequest, event)
            head_or_response, normalized_key = _canvas_validate_task_asset(
                task=task,
                asset_key=req.assetKey,
                asset_store=asset_store,
                error_response_fn=error_response_fn,
                origin=origin,
            )
            if normalized_key is None:
                return head_or_response
            head = head_or_response
            content_type = str(head.get("ContentType") or "")
            resize_mode = req.resizeMode if req.resizeMode in {"pad", "crop", "scale"} else "pad"
            with tempfile.TemporaryDirectory() as td:
                source_path = Path(td) / (Path(normalized_key).name or "media.bin")
                asset_store.s3.download_file(asset_store.assets_bucket, normalized_key, str(source_path))
                if content_type.startswith("audio/"):
                    output_path = Path(td) / "trimmed.wav"
                    extract_audio_segment(
                        str(source_path),
                        str(output_path),
                        start_sec=float(req.startSec),
                        duration_sec=float(req.durationSec),
                    )
                    probe = ffprobe_audio(str(output_path))
                    output_record = _canvas_register_media_asset(
                        task=task,
                        store=store,
                        asset_store=asset_store,
                        asset_paths_for_task_fn=asset_paths_for_task_fn,
                        new_id_fn=new_id_fn,
                        now_iso_fn=now_iso_fn,
                        operation="canvas_trim_media",
                        source_key=normalized_key,
                        output_filename=f"{Path(source_path).stem or 'audio'}_trim.wav",
                        output_bytes=output_path.read_bytes(),
                        content_type="audio/wav",
                        media_kind="audio",
                        metadata={
                            "startSec": req.startSec,
                            "durationSec": req.durationSec,
                            "probe": probe,
                        },
                    )
                    return response_fn(200, {"asset": output_record, "probe": probe}, origin=origin)
                source_probe = ffprobe_video(str(source_path))
                output_path = Path(td) / "trimmed.mp4"
                target_fps = Fraction.from_float(float(req.targetFps)).limit_denominator(1000) if req.targetFps else None
                trim_video_segment(
                    str(source_path),
                    str(output_path),
                    start_sec=float(req.startSec),
                    duration_sec=float(req.durationSec),
                    target_fps=target_fps,
                    target_width=req.targetWidth,
                    target_height=req.targetHeight,
                    resize_mode=resize_mode,
                )
                output_probe = ffprobe_video(str(output_path))
                output_record = _canvas_register_media_asset(
                    task=task,
                    store=store,
                    asset_store=asset_store,
                    asset_paths_for_task_fn=asset_paths_for_task_fn,
                    new_id_fn=new_id_fn,
                    now_iso_fn=now_iso_fn,
                    operation="canvas_trim_media",
                    source_key=normalized_key,
                    output_filename=f"{Path(source_path).stem or 'video'}_trim.mp4",
                    output_bytes=output_path.read_bytes(),
                    content_type="video/mp4",
                    media_kind="video",
                    metadata={
                        "startSec": req.startSec,
                        "durationSec": req.durationSec,
                        "targetFps": req.targetFps,
                        "targetWidth": req.targetWidth,
                        "targetHeight": req.targetHeight,
                        "resizeMode": resize_mode,
                        "sourceProbe": source_probe,
                        "outputProbe": output_probe,
                    },
                )
                return response_fn(200, {"asset": output_record, "probe": output_probe}, origin=origin)

        return error_response_fn(404, "Canvas media operation not found", origin=origin)

    # ---- GET /canvas/skills (static registry; no task) ----------------------
    if method == "GET" and path == "/canvas/skills":
        return response_fn(200, {"skills": list_canvas_skills()}, origin=origin)

    # ---- GET/PUT /canvas/{taskId}/state -- per-task editor state blob --------
    if len(path_parts) == 3 and path_parts[0] == "canvas" and path_parts[2] == "state":
        task_id = path_parts[1]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)
        state_key = _canvas_state_key(task)
        if method == "GET":
            stored = store.get_json(state_key) or {}
            return response_fn(200, {"state": stored.get("state", {})}, origin=origin)
        if method == "PUT":
            req = json_model(CanvasStatePutRequest, event)
            store.put_json(state_key, {"state": req.state, "updatedAt": now_iso_fn(), "updatedBy": user_id})
            return response_fn(200, {"ok": True}, origin=origin)
        return error_response_fn(405, "Method not allowed", origin=origin)

    # ---- GET/PUT /canvas/{taskId}/memory -- per-task project brain -----------
    if len(path_parts) == 3 and path_parts[0] == "canvas" and path_parts[2] == "memory":
        task_id = path_parts[1]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)
        memory_key = _canvas_memory_key(task)
        if method == "GET":
            stored = store.get_json(memory_key) or _default_canvas_memory()
            return response_fn(200, {"memory": stored}, origin=origin)
        if method == "PUT":
            req = json_model(CanvasMemoryPutRequest, event)
            memory = dict(req.memory)
            memory["updatedAt"] = now_iso_fn()
            store.put_json(memory_key, memory)
            return response_fn(200, {"memory": memory}, origin=origin)
        return error_response_fn(405, "Method not allowed", origin=origin)

    # ---- POST /canvas/{taskId}/chat -- conversational GPT assistant ----------
    if method == "POST" and len(path_parts) == 3 and path_parts[0] == "canvas" and path_parts[2] == "chat":
        if run_canvas_chat_fn is None:
            return error_response_fn(500, "Canvas chat engine is not configured", origin=origin)
        task_id = path_parts[1]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)
        req = json_model(CanvasChatRequest, event)
        messages = [
            {"role": m.role, "content": m.content}
            for m in req.messages
            if m.content.strip() or m.role == "assistant"
        ]
        if not messages:
            return error_response_fn(400, "At least one message is required", origin=origin)

        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for canvas chat", origin=origin)

        memory_key = _canvas_memory_key(task)
        memory = store.get_json(memory_key) or _default_canvas_memory()
        project_context = render_project_context(memory)
        system_prompt = get_canvas_brain_fn(req.profile) if get_canvas_brain_fn else None
        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")

        try:
            result, usage = run_canvas_chat_fn(
                api_key=openai_api_key,
                messages=messages,
                project_context=project_context,
                attachment_image_urls=[u for u in req.attachment_image_urls if u],
                system_prompt=system_prompt,
                pricing_rates=pricing_rates,
            )
        except Exception as exc:
            logger.warning("Canvas chat failed", extra={"userId": user_id, "taskId": task_id, "error": str(exc)})
            return error_response_fn(502, str(exc), origin=origin)

        # Grow the project brain with whatever this turn captured, then persist.
        updated_memory = _apply_memory_updates(memory, result.get("memory_updates") or {}, now_iso=now_iso_fn())
        store.put_json(memory_key, updated_memory)

        try:
            estimate = estimate_cost_from_pricing_entry(pricing_entry, usage=usage)
            store.save_usage_record(
                build_usage_record(
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
                    task_id=task_id,
                    pricing_entry=pricing_entry,
                    estimate=estimate,
                )
            )
        except Exception as exc:
            logger.warning("Canvas chat usage tracking failed", extra={"userId": user_id, "error": str(exc)})

        return response_fn(
            200,
            {
                "reply": result.get("reply", ""),
                "canvasActions": result.get("canvas_actions", []),
                "memory": updated_memory,
                "usage": usage,
            },
            origin=origin,
        )

    # ---- POST /canvas/{taskId}/skill/{name} -- named capability (EOD, ...) ---
    if method == "POST" and len(path_parts) == 4 and path_parts[0] == "canvas" and path_parts[2] == "skill":
        task_id = path_parts[1]
        skill_name = path_parts[3]
        skill = get_canvas_skill(skill_name)
        if skill is None:
            return error_response_fn(404, f"Unknown skill '{skill_name}'", origin=origin)
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)
        req = json_model(CanvasSkillRequest, event)

        openai_api_key = get_openai_api_key_fn()
        if not openai_api_key:
            return error_response_fn(500, "OPENAI_API_KEY is required for canvas skills", origin=origin)

        memory_key = _canvas_memory_key(task)
        memory = store.get_json(memory_key) or _default_canvas_memory()
        project_context = render_project_context(memory)
        brain_profile = req.profile or f"skill_{skill_name}"
        system_prompt_override = get_canvas_brain_fn(brain_profile) if get_canvas_brain_fn else None
        pricing_entry = get_openai_pricing_entry_fn("gpt-5.5")
        pricing_rates = get_openai_pricing_rates_fn("gpt-5.5")

        try:
            result, usage = run_canvas_skill(
                api_key=openai_api_key,
                skill=skill,
                payload=req.payload,
                project_context=project_context,
                pricing_rates=pricing_rates,
                system_prompt_override=system_prompt_override,
            )
        except Exception as exc:
            logger.warning("Canvas skill failed", extra={"userId": user_id, "skill": skill_name, "error": str(exc)})
            return error_response_fn(502, str(exc), origin=origin)

        # EOD writes a handover card into the project brain (the daily trail).
        if skill_name == "eod":
            now = now_iso_fn()
            memory.setdefault("handovers", []).append(
                {"at": now, "report": result.get("full_report", ""), "tldr": result.get("tldr", [])}
            )
            memory["updatedAt"] = now
            store.put_json(memory_key, memory)

        try:
            estimate = estimate_cost_from_pricing_entry(pricing_entry, usage=usage)
            store.save_usage_record(
                build_usage_record(
                    usage_record_id=new_id_fn("usage"),
                    now_iso=now_iso_fn(),
                    user_id=user_id,
                    provider="openai",
                    provider_model="gpt-5.5",
                    app_model_id="gpt-5.5",
                    request_type="skill",
                    source=f"canvas_skill:{skill_name}",
                    tool_origin=f"canvas_skill_{skill_name}",
                    workflow_id="canvas_workflow",
                    task_id=task_id,
                    pricing_entry=pricing_entry,
                    estimate=estimate,
                )
            )
        except Exception as exc:
            logger.warning("Canvas skill usage tracking failed", extra={"userId": user_id, "error": str(exc)})

        return response_fn(200, {"result": result, "usage": usage}, origin=origin)

    # ---- POST /canvas/{taskId}/generate-image -- async image gen (seed + t2i) ----
    if method == "POST" and len(path_parts) == 3 and path_parts[0] == "canvas" and path_parts[2] == "generate-image":
        if queue_job_fn is None:
            return error_response_fn(500, "Canvas generation is not configured", origin=origin)
        task_id = path_parts[1]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)
        req = json_model(CanvasGenerateImageRequest, event)
        reference_keys = [k.strip() for k in req.referenceAssetKeys if k and k.strip()]
        if not req.prompt.strip() and not req.inputAssetKey and not reference_keys:
            return error_response_fn(400, "Provide a prompt, an input image, or references", origin=origin)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="canvas_image_generate",
            payload={
                "taskId": task_id,
                "prompt": req.prompt,
                "model": req.model,
                "inputAssetKey": (req.inputAssetKey or "").strip() or None,
                "referenceAssetKeys": reference_keys,
                "seed": req.seed,
                "aspectRatio": req.aspectRatio,
            },
            enqueue=True,
        )
        return response_fn(202, {"jobId": job_id, "taskId": task_id, "status": "queued"}, origin=origin)

    # ---- GET /canvas/{taskId}/job/{jobId} -- poll an async canvas job ----
    if method == "GET" and len(path_parts) == 4 and path_parts[0] == "canvas" and path_parts[2] == "job":
        task_id = path_parts[1]
        job_id = path_parts[3]
        task = _load_canvas_task_or_404(store, user_id, task_id)
        if not isinstance(task, dict):
            return error_response_fn(404, "Task not found", origin=origin)
        job = store.load_job(user_id, job_id)
        if not isinstance(job, dict):
            return error_response_fn(404, "Job not found", origin=origin)
        result = dict(job.get("resultRefs") or {})
        output_key = result.get("outputKey")
        if isinstance(output_key, str) and output_key:
            # Refresh the presigned URL on each poll so it never serves a stale link.
            result["outputUrl"] = asset_store.presign_get(output_key)
        return response_fn(
            200,
            {
                "jobId": job_id,
                "status": job.get("status"),
                "progress": job.get("progress"),
                "error": job.get("error"),
                "result": result,
            },
            origin=origin,
        )

    return None
