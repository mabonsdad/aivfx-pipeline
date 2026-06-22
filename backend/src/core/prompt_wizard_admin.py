from __future__ import annotations

from copy import deepcopy
from typing import Any

from src.core.auth import is_admin_claims
from src.integrations.openai_prompt_wizard import VIDEO_PROMPT_WIZARD_SYSTEM_PROMPT

ADMIN_PROMPT_WIZARD_CONFIG_KEY = "admin/prompt_wizard_config.json"
ADMIN_PIN = "246810"

_ALLOWED_PROVIDERS = {"Luma", "fal.ai", "Runway", "Replicate", "Runware"}
_ALLOWED_MODES = {"start_video", "start_end", "edit_video"}
_ALLOWED_STRATEGIES = {
    "luma_descriptive_change",
    "happy_horse_video_image_markers",
    "runway_aleph_start_with_input_image",
    "kling_angle_marker_video_image",
    "seedance_reference_tags",
    "wan_videoedit_focused_change",
    "kling_start_end_motion_camera",
    "wan_start_end_motion_transform",
    "veo_start_end_visual_transition",
    "ltx_start_end_motion_transition",
}

_DEFAULT_MODEL_CONFIGS: list[dict[str, Any]] = [
    {
        "selected_model": "ray-3.2-720p",
        "dropdown_name": "Luma Ray 3.2 720p",
        "mode": "start_video",
        "provider": "Luma",
        "provider_model": "ray-3.2",
        "endpoint_used": "POST https://agents.lumalabs.ai/v1/generations (type=video_edit)",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "luma_descriptive_change",
    },
    {
        "selected_model": "ray-3.2-1080p",
        "dropdown_name": "Luma Ray 3.2 1080p",
        "mode": "start_video",
        "provider": "Luma",
        "provider_model": "ray-3.2",
        "endpoint_used": "POST https://agents.lumalabs.ai/v1/generations (type=video_edit)",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "luma_descriptive_change",
    },
    {
        "selected_model": "happy-horse-video-edit",
        "dropdown_name": "Happy Horse 1.0 Video Edit",
        "mode": "start_video",
        "provider": "fal.ai",
        "provider_model": "alibaba/happy-horse/video-edit",
        "endpoint_used": "POST https://queue.fal.run/alibaba/happy-horse/video-edit",
        "required_markers": ["@Video1", "@Image1"],
        "supports_negative_prompt": False,
        "prompt_strategy": "happy_horse_video_image_markers",
    },
    {
        "selected_model": "runway-gen4-aleph",
        "dropdown_name": "Runway Aleph 2.0",
        "mode": "start_video",
        "provider": "Runway",
        "provider_model": "aleph2",
        "endpoint_used": "POST https://api.dev.runwayml.com/v1/video_to_video",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "runway_aleph_start_with_input_image",
    },
    {
        "selected_model": "kling-o1",
        "dropdown_name": "Kling O1 Edit",
        "mode": "start_video",
        "provider": "Replicate",
        "provider_model": "kwaivgi/kling-o1",
        "endpoint_used": "POST https://api.replicate.com/v1/predictions",
        "required_markers": ["<<<video_1>>>", "<<<image_1>>>"],
        "supports_negative_prompt": False,
        "prompt_strategy": "kling_angle_marker_video_image",
    },
    {
        "selected_model": "kling-v3-omni-video",
        "dropdown_name": "Kling v3 Omni Video",
        "mode": "start_video",
        "provider": "Replicate",
        "provider_model": "kwaivgi/kling-v3-omni-video",
        "endpoint_used": "POST https://api.replicate.com/v1/predictions",
        "required_markers": ["<<<video_1>>>", "<<<image_1>>>"],
        "supports_negative_prompt": False,
        "prompt_strategy": "kling_angle_marker_video_image",
    },
    {
        "selected_model": "seedance-2.0-reference-to-video",
        "dropdown_name": "Seedance 2.0 Reference to Video",
        "mode": "start_video",
        "provider": "fal.ai",
        "provider_model": "bytedance/seedance-2.0/reference-to-video",
        "endpoint_used": "POST https://queue.fal.run/bytedance/seedance-2.0/reference-to-video",
        "required_markers": ["@Video1", "@Image1"],
        "supports_negative_prompt": False,
        "prompt_strategy": "seedance_reference_tags",
    },
    {
        "selected_model": "wan2.7-videoedit",
        "dropdown_name": "Wan 2.7 VideoEdit",
        "mode": "start_video",
        "provider": "Replicate",
        "provider_model": "wan-video/wan-2.7-videoedit",
        "endpoint_used": "POST https://api.replicate.com/v1/models/wan-video/wan-2.7-videoedit/predictions",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "wan_videoedit_focused_change",
    },
    {
        "selected_model": "happy-horse-video-edit",
        "dropdown_name": "Happy Horse 1.0 Video Edit",
        "mode": "edit_video",
        "provider": "fal.ai",
        "provider_model": "alibaba/happy-horse/video-edit",
        "endpoint_used": "POST https://queue.fal.run/alibaba/happy-horse/video-edit",
        "required_markers": ["@Video1", "@Image1"],
        "supports_negative_prompt": False,
        "prompt_strategy": "happy_horse_video_image_markers",
    },
    {
        "selected_model": "runway-gen4-aleph",
        "dropdown_name": "Runway Aleph 2.0",
        "mode": "edit_video",
        "provider": "Runway",
        "provider_model": "aleph2",
        "endpoint_used": "POST https://api.dev.runwayml.com/v1/video_to_video",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "runway_aleph_start_with_input_image",
    },
    {
        "selected_model": "kling-v3-omni-video",
        "dropdown_name": "Kling v3 Omni Video",
        "mode": "edit_video",
        "provider": "Replicate",
        "provider_model": "kwaivgi/kling-v3-omni-video",
        "endpoint_used": "POST https://api.replicate.com/v1/predictions",
        "required_markers": ["<<<video_1>>>", "<<<image_1>>>"],
        "supports_negative_prompt": False,
        "prompt_strategy": "kling_angle_marker_video_image",
    },
    {
        "selected_model": "seedance-2.0-reference-to-video",
        "dropdown_name": "Seedance 2.0 Reference to Video",
        "mode": "edit_video",
        "provider": "fal.ai",
        "provider_model": "bytedance/seedance-2.0/reference-to-video",
        "endpoint_used": "POST https://queue.fal.run/bytedance/seedance-2.0/reference-to-video",
        "required_markers": ["@Video1", "@Image1"],
        "supports_negative_prompt": False,
        "prompt_strategy": "seedance_reference_tags",
    },
    {
        "selected_model": "wan2.7-videoedit",
        "dropdown_name": "Wan 2.7 VideoEdit",
        "mode": "edit_video",
        "provider": "Replicate",
        "provider_model": "wan-video/wan-2.7-videoedit",
        "endpoint_used": "POST https://api.replicate.com/v1/models/wan-video/wan-2.7-videoedit/predictions",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "wan_videoedit_focused_change",
    },
    {
        "selected_model": "kling-2.6",
        "dropdown_name": "Kling 2.6",
        "mode": "start_end",
        "provider": "Runware",
        "provider_model": "klingai:kling-video@2.6-pro",
        "endpoint_used": "POST https://api.runware.ai/v1",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "kling_start_end_motion_camera",
    },
    {
        "selected_model": "wan2.7-i2v",
        "dropdown_name": "Wan 2.7 Image to Video",
        "mode": "start_end",
        "provider": "Replicate",
        "provider_model": "wan-video/wan-2.7-i2v",
        "endpoint_used": "POST https://api.replicate.com/v1/models/wan-video/wan-2.7-i2v/predictions",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "wan_start_end_motion_transform",
    },
    {
        "selected_model": "ltx-2.3-pro",
        "dropdown_name": "LTX 2.3 Pro",
        "mode": "start_end",
        "provider": "Replicate",
        "provider_model": "lightricks/ltx-2.3-pro",
        "endpoint_used": "POST https://api.replicate.com/v1/models/lightricks/ltx-2.3-pro/predictions",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "ltx_start_end_motion_transition",
    },
    {
        "selected_model": "veo-3.1",
        "dropdown_name": "Veo 3.1",
        "mode": "start_end",
        "provider": "Runware",
        "provider_model": "google:3@2",
        "endpoint_used": "POST https://api.runware.ai/v1",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "veo_start_end_visual_transition",
    },
    {
        "selected_model": "veo-3.1-fast",
        "dropdown_name": "Veo 3.1 Fast",
        "mode": "start_end",
        "provider": "Runware",
        "provider_model": "google:3@3",
        "endpoint_used": "POST https://api.runware.ai/v1",
        "required_markers": [],
        "supports_negative_prompt": False,
        "prompt_strategy": "veo_start_end_visual_transition",
    },
]


def default_prompt_wizard_admin_config() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "systemPrompt": VIDEO_PROMPT_WIZARD_SYSTEM_PROMPT,
        "models": deepcopy(_DEFAULT_MODEL_CONFIGS),
        "updatedAt": None,
        "updatedBy": None,
    }


def _normalize_markers(value: Any, *, strict: bool) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise ValueError("required_markers must be a list of strings")
        return []
    markers: list[str] = []
    for item in value:
        marker = str(item).strip()
        if marker:
            markers.append(marker)
    return markers


def _normalize_model(item: Any, *, strict: bool) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        if strict:
            raise ValueError("Each model config must be an object")
        return None

    selected_model = str(item.get("selected_model") or "").strip()
    dropdown_name = str(item.get("dropdown_name") or "").strip()
    mode = str(item.get("mode") or "").strip()
    provider = str(item.get("provider") or "").strip()
    provider_model = str(item.get("provider_model") or "").strip()
    endpoint_used = str(item.get("endpoint_used") or "").strip()
    prompt_strategy = str(item.get("prompt_strategy") or "").strip()
    required_markers = _normalize_markers(item.get("required_markers"), strict=strict)

    supports_negative_prompt = bool(item.get("supports_negative_prompt"))
    if supports_negative_prompt and strict:
        raise ValueError("supports_negative_prompt must be false")

    if strict:
        if not selected_model:
            raise ValueError("selected_model is required")
        if not dropdown_name:
            raise ValueError(f"dropdown_name is required for {selected_model}")
        if mode not in _ALLOWED_MODES:
            raise ValueError(f"mode must be one of {sorted(_ALLOWED_MODES)}")
        if provider not in _ALLOWED_PROVIDERS:
            raise ValueError(f"provider must be one of {sorted(_ALLOWED_PROVIDERS)}")
        if not provider_model:
            raise ValueError(f"provider_model is required for {selected_model}")
        if not endpoint_used:
            raise ValueError(f"endpoint_used is required for {selected_model}")
        if prompt_strategy not in _ALLOWED_STRATEGIES:
            raise ValueError(f"prompt_strategy must be one of {sorted(_ALLOWED_STRATEGIES)}")

    if not selected_model:
        return None

    if mode not in _ALLOWED_MODES:
        mode = "start_video"
    if provider not in _ALLOWED_PROVIDERS:
        provider = "Replicate"
    if prompt_strategy not in _ALLOWED_STRATEGIES:
        prompt_strategy = "wan_videoedit_focused_change"

    return {
        "selected_model": selected_model,
        "dropdown_name": dropdown_name or selected_model,
        "mode": mode,
        "provider": provider,
        "provider_model": provider_model or selected_model,
        "endpoint_used": endpoint_used,
        "required_markers": required_markers,
        "supports_negative_prompt": False,
        "prompt_strategy": prompt_strategy,
    }


def normalize_prompt_wizard_admin_config_for_read(raw: dict[str, Any] | None) -> dict[str, Any]:
    defaults = default_prompt_wizard_admin_config()
    if not isinstance(raw, dict):
        return defaults

    raw_models = raw.get("models")
    models: list[dict[str, Any]] = []
    if isinstance(raw_models, list):
        for item in raw_models:
            normalized = _normalize_model(item, strict=False)
            if normalized is not None:
                models.append(normalized)
    if not models:
        models = deepcopy(defaults["models"])

    system_prompt = str(raw.get("systemPrompt") or "").strip() or defaults["systemPrompt"]

    return {
        "schemaVersion": 1,
        "systemPrompt": system_prompt,
        "models": models,
        "updatedAt": raw.get("updatedAt"),
        "updatedBy": raw.get("updatedBy"),
    }


def normalize_prompt_wizard_admin_config_for_write(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Invalid config payload")

    system_prompt = str(payload.get("systemPrompt") or "").strip()
    if not system_prompt:
        raise ValueError("systemPrompt is required")

    raw_models = payload.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise ValueError("models must be a non-empty array")

    models: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for item in raw_models:
        normalized = _normalize_model(item, strict=True)
        if normalized is None:
            continue
        map_key = f"{normalized['selected_model']}:{normalized['mode']}"
        if map_key in seen_keys:
            raise ValueError(f"Duplicate model config entry for {map_key}")
        seen_keys.add(map_key)
        models.append(normalized)

    if not models:
        raise ValueError("At least one model config is required")

    return {
        "schemaVersion": 1,
        "systemPrompt": system_prompt,
        "models": models,
    }


def resolve_prompt_wizard_model_config(config: dict[str, Any], selected_model: str, mode: str) -> dict[str, Any] | None:
    selected = str(selected_model or "").strip()
    selected_mode = str(mode or "").strip()
    models = config.get("models") if isinstance(config, dict) else None
    if not isinstance(models, list):
        return None
    for item in models:
        if not isinstance(item, dict):
            continue
        if str(item.get("selected_model") or "") == selected and str(item.get("mode") or "") == selected_mode:
            return item
    return None


def is_prompt_wizard_admin(claims: dict[str, Any]) -> bool:
    return is_admin_claims(claims)


def is_valid_prompt_wizard_admin_pin(pin: str | None) -> bool:
    return isinstance(pin, str) and pin.strip() == ADMIN_PIN
