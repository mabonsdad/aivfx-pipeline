from __future__ import annotations

from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


class KlingError(RuntimeError):
    pass


KLING_MODEL_ENDPOINT = "https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video"


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
    }


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _request_json(
    method: str,
    url: str,
    *,
    api_key: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = requests.request(method, url, headers=_headers(api_key), json=payload, timeout=90)
    response.raise_for_status()
    return response.json()


def create_start_end_generation(
    *,
    api_key: str,
    start_image_url: str,
    end_image_url: str,
    duration_seconds: int,
    prompt: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "image_url": start_image_url,
        "end_image_url": end_image_url,
        "duration": str(duration_seconds),
        "prompt": prompt or "Generate a coherent motion sequence between the start and end frames.",
    }
    return _request_json("POST", KLING_MODEL_ENDPOINT, api_key=api_key, payload=payload)


def get_queue_status(*, api_key: str, status_url: str) -> dict[str, Any]:
    return _request_json("GET", status_url, api_key=api_key)


def get_queue_response(*, api_key: str, response_url: str) -> dict[str, Any]:
    return _request_json("GET", response_url, api_key=api_key)
