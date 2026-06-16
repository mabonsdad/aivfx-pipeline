from __future__ import annotations

from typing import Any


def handle_me(
    method: str,
    path: str,
    *,
    user_id: str,
    claims: dict[str, Any],
    origin: str | None,
    response_fn,
    get_user_groups_fn,
    is_admin_claims_fn,
) -> dict[str, Any] | None:
    if method != "GET" or path != "/me":
        return None
    return response_fn(
        200,
        {
            "userId": user_id,
            "email": claims.get("email"),
            "username": claims.get("cognito:username"),
            "groups": get_user_groups_fn(claims),
            "isAdmin": is_admin_claims_fn(claims),
        },
        origin=origin,
    )
