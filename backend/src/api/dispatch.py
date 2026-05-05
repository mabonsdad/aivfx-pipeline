from __future__ import annotations

from typing import Any


def parse_method_path(event: dict[str, Any]) -> tuple[str, str]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")
    return method.upper(), path


def parse_task_path(path: str) -> tuple[str, list[str]] | None:
    if not path.startswith("/tasks/"):
        return None
    parts = path.strip("/").split("/")
    if len(parts) < 2:
        return None
    return parts[1], parts
