from __future__ import annotations

import base64
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

GEMINI_MODEL_MAP = {
    "nano_banana": "gemini-3.1-flash-image-preview",
    "nano_banana_pro": "gemini-3-pro-image-preview",
}


class GeminiError(RuntimeError):
    pass


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(url, headers=headers, json=payload, timeout=90)
    response.raise_for_status()
    return response.json()


def _extract_image_bytes(payload: dict[str, Any]) -> bytes:
    candidates = payload.get("candidates", [])
    for candidate in candidates:
        content = candidate.get("content", {})
        for part in content.get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    raise GeminiError("Gemini response did not include inline image bytes")


def generate_image_edit(
    *,
    api_key: str,
    model: str,
    prompt: str,
    input_image_bytes: bytes,
    mask_image_bytes: bytes | None = None,
    input_mime_type: str = "image/png",
) -> bytes:
    model_id = GEMINI_MODEL_MAP[model]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
    headers = {
        "x-goog-api-key": api_key,
        "content-type": "application/json",
    }
    parts: list[dict[str, Any]] = [
        {"text": prompt},
        {
            "inline_data": {
                "mime_type": input_mime_type,
                "data": base64.b64encode(input_image_bytes).decode("utf-8"),
            }
        },
    ]
    if mask_image_bytes:
        parts.append(
            {
                "text": (
                    "Use the next image as an edit mask. White areas should be edited, "
                    "black areas should remain unchanged, and gray areas should blend."
                )
            }
        )
        parts.append(
            {
                "inline_data": {
                    "mime_type": "image/png",
                    "data": base64.b64encode(mask_image_bytes).decode("utf-8"),
                }
            }
        )

    payload: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": parts,
            }
        ],
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
        },
    }
    data = _post(url, headers, payload)
    return _extract_image_bytes(data)
