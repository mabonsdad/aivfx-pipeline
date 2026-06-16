from __future__ import annotations

from typing import Any, Callable

from src.core.http import parse_json_body
from src.core.prompt_wizard_admin import (
    ADMIN_PROMPT_WIZARD_CONFIG_KEY,
    is_prompt_wizard_admin,
    is_valid_prompt_wizard_admin_pin,
    normalize_prompt_wizard_admin_config_for_read,
    normalize_prompt_wizard_admin_config_for_write,
)


def _header_value(event: dict[str, Any], name: str) -> str | None:
    headers = event.get("headers")
    if not isinstance(headers, dict):
        return None
    for key, value in headers.items():
        if str(key).lower() != name.lower():
            continue
        if isinstance(value, str):
            return value
    return None


def handle_admin_routes(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    claims: dict[str, Any],
    store,
    origin: str | None,
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    now_iso_fn: Callable[[], str],
) -> dict[str, Any] | None:
    if path != "/admin/prompt-wizard-config":
        return None

    admin_access = is_prompt_wizard_admin(claims)
    pin = _header_value(event, "x-admin-pin")
    pin_access = is_valid_prompt_wizard_admin_pin(pin)
    has_access = admin_access or pin_access

    if not has_access:
        return error_response_fn(403, "Admin access required", origin=origin)

    raw = store.get_json(ADMIN_PROMPT_WIZARD_CONFIG_KEY)
    config = normalize_prompt_wizard_admin_config_for_read(raw)

    if method == "GET":
        return response_fn(
            200,
            {
                "config": config,
                "access": {
                    "isAdmin": admin_access,
                    "viaPin": pin_access and not admin_access,
                },
            },
            origin=origin,
        )

    if method == "PUT":
        try:
            body = parse_json_body(event)
        except ValueError:
            return error_response_fn(400, "Invalid JSON body", origin=origin)
        try:
            normalized = normalize_prompt_wizard_admin_config_for_write(body)
        except ValueError as exc:
            return error_response_fn(400, str(exc), origin=origin)

        normalized["updatedAt"] = now_iso_fn()
        normalized["updatedBy"] = str(claims.get("email") or claims.get("cognito:username") or claims.get("sub") or "unknown")
        store.put_json(ADMIN_PROMPT_WIZARD_CONFIG_KEY, normalized)
        return response_fn(
            200,
            {
                "config": normalized,
                "access": {
                    "isAdmin": admin_access,
                    "viaPin": pin_access and not admin_access,
                },
            },
            origin=origin,
        )

    return error_response_fn(405, "Method not allowed", origin=origin)
