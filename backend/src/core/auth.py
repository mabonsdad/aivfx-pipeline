from __future__ import annotations

import json
from typing import Any

ADMIN_GROUP_NAMES = {"admin", "aivfx-admin"}
ADMIN_OWNER_USERNAME = "robin.moore@shwsh.co.uk"
ADMIN_OWNER_EMAIL = "robin.moore@shwsh.co.uk"


class UnauthorizedError(Exception):
    pass


def get_user_claims(event: dict[str, Any]) -> dict[str, Any]:
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    if not claims:
        raise UnauthorizedError("Missing JWT claims")
    return claims


def get_user_id(event: dict[str, Any]) -> str:
    claims = get_user_claims(event)
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise UnauthorizedError("Missing user sub claim")
    return user_id


def get_user_groups(claims: dict[str, Any]) -> list[str]:
    raw_groups = claims.get("cognito:groups")
    if isinstance(raw_groups, list):
        return [str(item).strip() for item in raw_groups if str(item).strip()]
    if isinstance(raw_groups, str):
        trimmed = raw_groups.strip()
        if trimmed.startswith("[") and trimmed.endswith("]"):
            try:
                decoded = json.loads(trimmed)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, list):
                return [str(item).strip() for item in decoded if str(item).strip()]
            inner = trimmed[1:-1].strip()
            if not inner:
                return []
            return [item.strip().strip("\"'") for item in inner.split(",") if item.strip().strip("\"'")]
        return [item.strip() for item in trimmed.split(",") if item.strip()]
    return []


def is_admin_owner_claims(claims: dict[str, Any]) -> bool:
    email = str(claims.get("email") or "").strip().lower()
    username = str(claims.get("cognito:username") or "").strip().lower()
    return email == ADMIN_OWNER_EMAIL or username == ADMIN_OWNER_USERNAME


def is_admin_claims(claims: dict[str, Any]) -> bool:
    groups = {group.lower() for group in get_user_groups(claims)}
    if groups & ADMIN_GROUP_NAMES:
        return True
    return is_admin_owner_claims(claims)
