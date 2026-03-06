from __future__ import annotations

from typing import Any
from uuid import uuid4

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


class RunwareVideoError(RuntimeError):
    pass


RUNWARE_API_ENDPOINT = "https://api.runware.ai/v1"
RUNWARE_VEO_31_MODEL = "google:3@2"
RUNWARE_VEO_31_FAST_MODEL = "google:3@3"
RUNWARE_WAN22_A14B_MODEL = "runware:200@6"
RUNWARE_WAN22_ANIMATE_MODEL = "runware:200@8"


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
def _request_json(payload: list[dict[str, Any]], *, api_key: str) -> dict[str, Any]:
    response = requests.post(RUNWARE_API_ENDPOINT, headers=_headers(api_key), json=payload, timeout=90)
    if response.status_code >= 400:
        try:
            error_payload = response.json()
        except Exception:
            error_payload = {"raw": response.text[:2000]}
        raise RunwareVideoError(f"Runware API error ({response.status_code}): {error_payload}")
    response_payload = response.json()
    if isinstance(response_payload, dict):
        errors = response_payload.get("errors")
        if isinstance(errors, list) and errors:
            raise RunwareVideoError(str(errors[0]))
    return response_payload


def create_veo_first_last_generation(
    *,
    api_key: str,
    model: str,
    start_image_url: str,
    end_image_url: str,
    duration_seconds: int,
    prompt: str | None,
    width: int,
    height: int,
    generate_audio: bool = False,
) -> dict[str, Any]:
    task_uuid = str(uuid4())
    payload: list[dict[str, Any]] = [
        {
            "taskType": "videoInference",
            "taskUUID": task_uuid,
            "deliveryMethod": "async",
            "model": model,
            "positivePrompt": prompt or "Generate coherent motion between the start and end frames while preserving scene identity.",
            "width": int(width),
            "height": int(height),
            "duration": int(duration_seconds),
            "frameImages": [
                {"inputImage": start_image_url, "frame": "first"},
                {"inputImage": end_image_url, "frame": "last"},
            ],
            "generateAudio": bool(generate_audio),
            "numberResults": 1,
            "outputFormat": "mp4",
        }
    ]
    created = _request_json(payload, api_key=api_key)
    return {
        "taskUUID": task_uuid,
        "response": created,
    }


def create_wan22_a14b_generation(
    *,
    api_key: str,
    start_image_url: str,
    duration_seconds: int,
    prompt: str | None,
    width: int,
    height: int,
) -> dict[str, Any]:
    task_uuid = str(uuid4())
    payload: list[dict[str, Any]] = [
        {
            "taskType": "videoInference",
            "taskUUID": task_uuid,
            "deliveryMethod": "async",
            "model": RUNWARE_WAN22_A14B_MODEL,
            "positivePrompt": prompt or "Generate coherent motion from the provided start frame while preserving scene identity.",
            "width": int(width),
            "height": int(height),
            "duration": int(duration_seconds),
            "frameImages": [
                {"inputImage": start_image_url, "frame": "first"},
            ],
            "numberResults": 1,
            "outputFormat": "mp4",
        }
    ]
    created = _request_json(payload, api_key=api_key)
    return {
        "taskUUID": task_uuid,
        "response": created,
    }


def create_wan22_animate_generation(
    *,
    api_key: str,
    reference_image_url: str,
    reference_video_url: str,
    prompt: str | None,
    width: int,
    height: int,
) -> dict[str, Any]:
    task_uuid = str(uuid4())
    payload: list[dict[str, Any]] = [
        {
            "taskType": "videoInference",
            "taskUUID": task_uuid,
            "deliveryMethod": "async",
            "model": RUNWARE_WAN22_ANIMATE_MODEL,
            "positivePrompt": prompt or "Replace the subject with realistic motion while preserving scene coherence and camera movement.",
            "width": int(width),
            "height": int(height),
            "inputs": {
                "referenceImages": [{"inputImage": reference_image_url}],
                "referenceVideos": [{"inputVideo": reference_video_url}],
            },
            "advancedFeatures": {
                "wanAnimate": {
                    "mode": "replace",
                }
            },
            "numberResults": 1,
            "outputFormat": "mp4",
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
