from __future__ import annotations

from typing import Any

CORE_ASSET_ORIGIN_KEYS = ("workflowId", "stepOrigin", "toolOrigin", "creationMode", "appSurface")
DEFAULT_APP_SURFACE = "main_app"


def _normalized_origin_value(value: Any) -> Any:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return value


def build_asset_origin(
    *,
    workflow_id: str,
    step_origin: str,
    tool_origin: str,
    creation_mode: str | None = None,
    app_surface: str | None = DEFAULT_APP_SURFACE,
    extension: dict[str, Any] | None = None,
) -> dict[str, Any]:
    origin: dict[str, Any] = {
        "workflowId": workflow_id,
        "stepOrigin": step_origin,
        "toolOrigin": tool_origin,
    }
    if creation_mode:
        origin["creationMode"] = creation_mode
    if app_surface:
        origin["appSurface"] = app_surface
    if isinstance(extension, dict):
        for key, value in extension.items():
            normalized_value = _normalized_origin_value(value)
            if key in CORE_ASSET_ORIGIN_KEYS or normalized_value is None:
                continue
            origin[key] = normalized_value
    return origin


def merge_asset_origin(existing_origin: dict[str, Any] | None, inferred_origin: dict[str, Any] | None) -> dict[str, Any]:
    existing = existing_origin if isinstance(existing_origin, dict) else {}
    inferred = inferred_origin if isinstance(inferred_origin, dict) else {}
    merged: dict[str, Any] = {}

    for key in CORE_ASSET_ORIGIN_KEYS:
        normalized_existing = _normalized_origin_value(existing.get(key))
        normalized_inferred = _normalized_origin_value(inferred.get(key))
        selected = normalized_existing if normalized_existing is not None else normalized_inferred
        if selected is not None:
            merged[key] = selected

    for source in (inferred, existing):
        for key, value in source.items():
            normalized_value = _normalized_origin_value(value)
            if key in CORE_ASSET_ORIGIN_KEYS or normalized_value is None:
                continue
            merged[key] = normalized_value

    return merged
