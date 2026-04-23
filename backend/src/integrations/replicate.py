from __future__ import annotations

from typing import Any

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


class ReplicateError(RuntimeError):
    pass


REPLICATE_API_ENDPOINT = "https://api.replicate.com/v1"
REPLICATE_KLING_O1_VERSION = "6d5f2d4becc7f734d190d17f13f776229c359cafc1c1898d78945e8d87c57538"
REPLICATE_KLING_V3_OMNI_VIDEO_VERSION = "1d449e255319a7c07feca688cf0596cb82cc8a96ceddff6c44fd0d090b4e830c"
REPLICATE_WAN27_VIDEOEDIT_VERSION = "0ad0f1fc407db22e7aa41062543caa2e9d58c6f3734c165ab0b27a9f685817ea"
REPLICATE_WAN27_VIDEOEDIT_MODEL = "wan-video/wan-2.7-videoedit"


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((requests.RequestException,)),
    reraise=True,
)
def _request_json(method: str, path: str, *, api_key: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    response = requests.request(
        method,
        f"{REPLICATE_API_ENDPOINT}{path}",
        headers=_headers(api_key),
        json=payload,
        timeout=90,
    )
    if response.status_code >= 400:
        try:
            error_payload = response.json()
        except Exception:
            error_payload = {"raw": response.text[:2000]}
        raise ReplicateError(f"Replicate API error ({response.status_code}): {error_payload}")
    return response.json()


def create_prediction(*, api_key: str, version: str, input: dict[str, Any]) -> dict[str, Any]:
    return _request_json(
        "POST",
        "/predictions",
        api_key=api_key,
        payload={
            "version": version,
            "input": input,
        },
    )


def create_official_model_prediction(*, api_key: str, owner: str, name: str, input: dict[str, Any]) -> dict[str, Any]:
    return _request_json(
        "POST",
        f"/models/{owner}/{name}/predictions",
        api_key=api_key,
        payload={
            "input": input,
        },
    )


def get_prediction(*, api_key: str, prediction_id: str) -> dict[str, Any]:
    return _request_json("GET", f"/predictions/{prediction_id}", api_key=api_key)
