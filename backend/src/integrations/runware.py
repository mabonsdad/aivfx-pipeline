from __future__ import annotations

import base64
from typing import Any
from uuid import uuid4

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


class RunwareError(RuntimeError):
    pass


RUNWARE_API_URL = "https://api.runware.ai/v1"
FLUX_FILL_MODEL = "runware:102@1"


def _to_data_uri(image_bytes: bytes, mime_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def _extract_result_image(response_payload: dict[str, Any]) -> bytes:
    data = response_payload.get("data")
    if not isinstance(data, list) or not data:
        raise RunwareError(f"Runware response missing data: {response_payload}")
    first = data[0] if isinstance(data[0], dict) else {}
    base64_data = first.get("imageBase64Data")
    if isinstance(base64_data, str) and base64_data:
        return base64.b64decode(base64_data)
    data_uri = first.get("imageDataURI")
    if isinstance(data_uri, str) and data_uri.startswith("data:"):
        _, _, payload = data_uri.partition(",")
        if payload:
            return base64.b64decode(payload)
    image_url = first.get("imageURL")
    if isinstance(image_url, str) and image_url.startswith("http"):
        response = requests.get(image_url, timeout=120)
        response.raise_for_status()
        return response.content
    raise RunwareError(f"Runware response missing image result: {response_payload}")


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _post_task(api_key: str, task: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    response = requests.post(RUNWARE_API_URL, headers=headers, json=[task], timeout=120)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and payload.get("errors"):
        raise RunwareError(str(payload["errors"]))
    return payload


def patch_edit_flux_fill(
    *,
    api_key: str,
    prompt: str,
    seed_image_bytes: bytes,
    mask_image_bytes: bytes,
    width: int,
    height: int,
    steps: int = 30,
    cfg_scale: float = 6.0,
) -> bytes:
    task: dict[str, Any] = {
        "taskType": "imageInference",
        "taskUUID": str(uuid4()),
        "model": FLUX_FILL_MODEL,
        "positivePrompt": prompt,
        "seedImage": _to_data_uri(seed_image_bytes),
        "maskImage": _to_data_uri(mask_image_bytes),
        "width": width,
        "height": height,
        "steps": steps,
        "CFGScale": cfg_scale,
        "numberResults": 1,
        "outputType": "base64Data",
        "outputFormat": "PNG",
    }
    payload = _post_task(api_key, task)
    return _extract_result_image(payload)


def patch_edit_aceplusplus(
    *,
    api_key: str,
    prompt: str,
    seed_image_bytes: bytes,
    mask_image_bytes: bytes,
    reference_image_bytes: bytes,
    width: int,
    height: int,
    repainting_scale: float = 0.7,
    steps: int = 30,
    cfg_scale: float = 6.0,
) -> bytes:
    seed_uri = _to_data_uri(seed_image_bytes)
    mask_uri = _to_data_uri(mask_image_bytes)
    reference_uri = _to_data_uri(reference_image_bytes)
    task: dict[str, Any] = {
        "taskType": "imageInference",
        "taskUUID": str(uuid4()),
        "model": FLUX_FILL_MODEL,
        "positivePrompt": prompt,
        "seedImage": seed_uri,
        "maskImage": mask_uri,
        "width": width,
        "height": height,
        "steps": steps,
        "CFGScale": cfg_scale,
        "numberResults": 1,
        "outputType": "base64Data",
        "outputFormat": "PNG",
        "referenceImages": [reference_uri],
        "acePlusPlus": {
            "type": "local_editing",
            "inputImages": [seed_uri],
            "inputMasks": [mask_uri],
            "repaintingScale": max(0.0, min(1.0, repainting_scale)),
        },
    }
    payload = _post_task(api_key, task)
    return _extract_result_image(payload)
