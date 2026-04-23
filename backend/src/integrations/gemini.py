from __future__ import annotations

import base64
import time
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

GEMINI_MODEL_MAP = {
    "nano_banana": "gemini-2.5-flash-image",
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

    prompt_feedback = payload.get("promptFeedback") or payload.get("prompt_feedback") or {}
    block_reason = prompt_feedback.get("blockReason") or prompt_feedback.get("block_reason")
    block_reason_message = prompt_feedback.get("blockReasonMessage") or prompt_feedback.get("block_reason_message")

    details: list[str] = []
    if block_reason:
        details.append(f"prompt blocked ({block_reason})")
    if block_reason_message:
        details.append(block_reason_message)

    for candidate in candidates:
        finish_reason = candidate.get("finishReason") or candidate.get("finish_reason")
        finish_message = candidate.get("finishMessage") or candidate.get("finish_message")
        if finish_reason:
            details.append(f"finishReason={finish_reason}")
        if finish_message:
            details.append(finish_message)
        content = candidate.get("content", {})
        text_parts = [str(part.get("text", "")).strip() for part in content.get("parts", []) if part.get("text")]
        if text_parts:
            details.append(" ".join(text_parts))

    if details:
        raise GeminiError(f"Gemini did not return an image: {' | '.join(details)}")
    raise GeminiError("Gemini did not return an image")


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
    parts: list[dict[str, Any]] = []
    if mask_image_bytes:
        parts.append(
            {
                "text": (
                    "You are editing the FIRST image using the SECOND image as a mask.\n"
                    "White mask areas: editable.\n"
                    "Black mask areas: locked, must remain pixel-identical.\n"
                    "Do not crop, pan, zoom, or shift framing.\n"
                    "Keep dimensions unchanged and preserve all unmasked geometry, color, and texture."
                )
            }
        )
    parts.append(
        {
            "inline_data": {
                "mime_type": input_mime_type,
                "data": base64.b64encode(input_image_bytes).decode("utf-8"),
            }
        }
    )
    if mask_image_bytes:
        parts.append(
            {
                "inline_data": {
                    "mime_type": "image/png",
                    "data": base64.b64encode(mask_image_bytes).decode("utf-8"),
                }
            }
        )
    parts.append({"text": prompt})

    payload: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": parts,
            }
        ],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
        },
    }
    last_error: GeminiError | None = None
    for attempt in range(2):
        data = _post(url, headers, payload)
        try:
            return _extract_image_bytes(data)
        except GeminiError as exc:
            last_error = exc
            if attempt == 0 and "finishReason=IMAGE_OTHER" in str(exc):
                time.sleep(1.5)
                continue
            raise
    if last_error is not None:
        raise last_error
    raise GeminiError("Gemini did not return an image")
