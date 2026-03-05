from __future__ import annotations

from uuid import uuid4
from typing import Any

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


class KlingError(RuntimeError):
    pass


RUNWARE_API_ENDPOINT = "https://api.runware.ai/v1"
KLING_RUNWARE_MODEL = "klingai:kling-video@2.6-pro"


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((requests.RequestException,)),
    reraise=True,
)
def _request_json(
    payload: list[dict[str, Any]],
    *,
    api_key: str,
) -> dict[str, Any]:
    response = requests.post(RUNWARE_API_ENDPOINT, headers=_headers(api_key), json=payload, timeout=90)
    if response.status_code >= 400:
        try:
            error_payload = response.json()
        except Exception:
            error_payload = {"raw": response.text[:2000]}
        raise KlingError(f"Runware API error ({response.status_code}): {error_payload}")
    response_payload = response.json()
    if isinstance(response_payload, dict):
        errors = response_payload.get("errors")
        if isinstance(errors, list) and errors:
            raise KlingError(str(errors[0]))
    return response_payload


def create_start_end_generation(
    *,
    api_key: str,
    start_image_url: str,
    end_image_url: str,
    duration_seconds: int,
    prompt: str | None,
) -> dict[str, Any]:
    task_uuid = str(uuid4())
    payload: list[dict[str, Any]] = [
        {
            "taskType": "videoInference",
            "taskUUID": task_uuid,
            "deliveryMethod": "async",
            "model": KLING_RUNWARE_MODEL,
            "positivePrompt": prompt or "Generate a coherent motion sequence between the start and end frames.",
            "duration": int(duration_seconds),
            "numberResults": 1,
            "outputFormat": "mp4",
            "inputs": {
                "frameImages": [
                    {"image": start_image_url, "frame": "first"},
                    {"image": end_image_url, "frame": "last"},
                ],
            },
        }
    ]
    created = _request_json(payload, api_key=api_key)
    return {
        "taskUUID": task_uuid,
        "response": created,
    }


def get_generation_response(*, api_key: str, task_uuid: str) -> dict[str, Any]:
    payload: list[dict[str, Any]] = [{"taskType": "getResponse", "taskUUID": task_uuid}]
    polled = _request_json(payload, api_key=api_key)
    data = polled.get("data") if isinstance(polled, dict) else None
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            if item.get("taskType") == "videoInference" and item.get("taskUUID") == task_uuid:
                return item
        for item in data:
            if isinstance(item, dict) and item.get("taskType") == "videoInference":
                return item
    errors = polled.get("errors") if isinstance(polled, dict) else None
    if isinstance(errors, list):
        for item in errors:
            if isinstance(item, dict) and item.get("taskUUID") == task_uuid:
                return {"status": "error", **item}
        if errors and isinstance(errors[0], dict):
            return {"status": "error", **errors[0]}
    return {"status": "processing"}
