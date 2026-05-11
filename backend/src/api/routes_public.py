from __future__ import annotations

from typing import Any


def handle_options(method: str, *, origin: str | None) -> dict[str, Any] | None:
    if method != "OPTIONS":
        return None
    return {
        "statusCode": 204,
        "headers": {
            "access-control-allow-origin": origin or "*",
            "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            "access-control-allow-headers": "authorization,content-type,x-admin-pin",
            "access-control-allow-credentials": "true",
        },
        "body": "",
    }


def handle_health(method: str, path: str, *, origin: str | None, response_fn) -> dict[str, Any] | None:
    if method == "GET" and path == "/health":
        return response_fn(200, {"ok": True, "service": "aivfx-backend"}, origin=origin)
    return None
