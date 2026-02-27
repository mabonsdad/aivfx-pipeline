from __future__ import annotations

from typing import Any


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
