from __future__ import annotations

from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


class LumaError(RuntimeError):
    pass


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _request(method: str, url: str, *, token: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    response = requests.request(method, url, headers=headers, json=payload, timeout=90)
    response.raise_for_status()
    return response.json()


def create_modify_generation(
    *,
    api_key: str,
    media_url: str,
    first_frame_url: str,
    mode: str,
    model: str,
    prompt: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "media": {"url": media_url},
        "first_frame": {"url": first_frame_url},
        "mode": mode,
        "model": model,
    }
    if prompt:
        payload["prompt"] = prompt

    return _request(
        "POST",
        "https://api.lumalabs.ai/dream-machine/v1/generations/video/modify",
        token=api_key,
        payload=payload,
    )


def get_generation(*, api_key: str, generation_id: str) -> dict[str, Any]:
    return _request(
        "GET",
        f"https://api.lumalabs.ai/dream-machine/v1/generations/{generation_id}",
        token=api_key,
    )
