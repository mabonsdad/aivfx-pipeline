from __future__ import annotations

import json
from http import HTTPStatus
from typing import Any


_JSON_HEADERS = {
    "content-type": "application/json",
}


def parse_json_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    if event.get("isBase64Encoded"):
        raise ValueError("Base64 encoded payload is not supported for JSON endpoints")
    return json.loads(body)


def response(
    status: int | HTTPStatus,
    body: dict[str, Any],
    *,
    origin: str | None = None,
) -> dict[str, Any]:
    headers = dict(_JSON_HEADERS)
    if origin:
        headers["access-control-allow-origin"] = origin
        headers["access-control-allow-credentials"] = "true"
    return {
        "statusCode": int(status),
        "headers": headers,
        "body": json.dumps(body, default=str),
    }


def error_response(status: int, message: str, *, origin: str | None = None) -> dict[str, Any]:
    return response(status, {"error": message}, origin=origin)
