from __future__ import annotations

import base64
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

OPENAI_IMAGE_MODEL_MAP = {
    "chatgpt": "gpt-image-1",
}


class OpenAIImageError(RuntimeError):
    pass


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _post(
    *,
    api_key: str,
    model: str,
    prompt: str,
    input_image_bytes: bytes,
    mask_image_bytes: bytes | None = None,
    input_mime_type: str = "image/png",
) -> dict[str, Any]:
    model_id = OPENAI_IMAGE_MODEL_MAP[model]
    headers = {
        "Authorization": f"Bearer {api_key}",
    }
    data: dict[str, str] = {
        "model": model_id,
        "prompt": prompt,
        "response_format": "b64_json",
        "size": "auto",
        "quality": "auto",
    }
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image", ("source.png", input_image_bytes, input_mime_type)),
    ]
    if mask_image_bytes:
        files.append(("mask", ("mask.png", mask_image_bytes, "image/png")))

    response = requests.post(
        "https://api.openai.com/v1/images/edits",
        headers=headers,
        data=data,
        files=files,
        timeout=120,
    )
    response.raise_for_status()
    return response.json()


def _extract_image_bytes(payload: dict[str, Any]) -> bytes:
    items = payload.get("data")
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            b64 = item.get("b64_json")
            if isinstance(b64, str) and b64:
                return base64.b64decode(b64)
    raise OpenAIImageError("OpenAI image edit response did not include b64 image output")


def generate_image_edit(
    *,
    api_key: str,
    model: str,
    prompt: str,
    input_image_bytes: bytes,
    mask_image_bytes: bytes | None = None,
    input_mime_type: str = "image/png",
) -> bytes:
    payload = _post(
        api_key=api_key,
        model=model,
        prompt=prompt,
        input_image_bytes=input_image_bytes,
        mask_image_bytes=mask_image_bytes,
        input_mime_type=input_mime_type,
    )
    return _extract_image_bytes(payload)
