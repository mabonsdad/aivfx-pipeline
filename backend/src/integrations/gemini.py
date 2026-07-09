from __future__ import annotations

import base64
import re
import time
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

GEMINI_MODEL_MAP = {
    "nano_banana": "gemini-2.5-flash-image",
    "nano_banana_pro": "gemini-3-pro-image-preview",
}

GEMINI_OMNI_FLASH_MODEL = "gemini-omni-flash-preview"
GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
GEMINI_FILES_URL = "https://generativelanguage.googleapis.com/v1beta/files"


class GeminiError(RuntimeError):
    pass


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(url, headers=headers, json=payload, timeout=90)
    if response.status_code >= 400:
        body = ""
        try:
            body = response.text.strip()
        except Exception:
            body = ""
        raise GeminiError(f"{response.status_code} Client Error: {response.reason} for url: {url}{f' | {body}' if body else ''}")
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


def _extract_video_uri(payload: dict[str, Any]) -> str | None:
    output_video = payload.get("output_video")
    if isinstance(output_video, dict):
        uri = str(output_video.get("uri") or "").strip()
        if uri:
            return uri
    steps = payload.get("steps")
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            content = step.get("content")
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict):
                    continue
                if str(item.get("type") or "").strip().lower() != "video":
                    continue
                uri = str(item.get("uri") or "").strip()
                if uri:
                    return uri
    return None


def _extract_video_bytes(payload: dict[str, Any]) -> bytes | None:
    output_video = payload.get("output_video")
    if isinstance(output_video, dict):
        data = str(output_video.get("data") or "").strip()
        if data:
            return base64.b64decode(data)
    steps = payload.get("steps")
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            content = step.get("content")
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict):
                    continue
                if str(item.get("type") or "").strip().lower() != "video":
                    continue
                data = str(item.get("data") or "").strip()
                if data:
                    return base64.b64decode(data)
    return None


def _extract_file_id(file_uri: str) -> str:
    match = re.search(r"/files/([^/?#:]+)", file_uri)
    if match:
        return match.group(1)
    match = re.search(r"files/([^/?#:]+)", file_uri)
    if match:
        return match.group(1)
    raise GeminiError(f"Could not determine Gemini file id from URI: {file_uri}")


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _get_json(url: str, headers: dict[str, str]) -> dict[str, Any]:
    response = requests.get(url, headers=headers, timeout=90)
    if response.status_code >= 400:
        body = ""
        try:
            body = response.text.strip()
        except Exception:
            body = ""
        raise GeminiError(f"{response.status_code} Client Error: {response.reason} for url: {url}{f' | {body}' if body else ''}")
    return response.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _get_bytes(url: str, headers: dict[str, str]) -> bytes:
    response = requests.get(url, headers=headers, timeout=180)
    if response.status_code >= 400:
        body = ""
        try:
            body = response.text.strip()
        except Exception:
            body = ""
        raise GeminiError(f"{response.status_code} Client Error: {response.reason} for url: {url}{f' | {body}' if body else ''}")
    return response.content


def create_omni_video_interaction(
    *,
    api_key: str,
    input_payload: str | list[dict[str, Any]],
    task: str,
    aspect_ratio: str = "16:9",
    model: str = GEMINI_OMNI_FLASH_MODEL,
) -> dict[str, Any]:
    headers = {
        "x-goog-api-key": api_key,
        "content-type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model,
        "input": input_payload,
        "response_format": {
            "type": "video",
            "delivery": "uri",
            "aspect_ratio": aspect_ratio if aspect_ratio in {"16:9", "9:16"} else "16:9",
        },
        "generation_config": {
            "video_config": {
                "task": task,
            }
        },
    }
    return _post(f"{GEMINI_INTERACTIONS_URL}?key={api_key}", headers, payload)


def wait_for_gemini_video_result(
    *,
    api_key: str,
    interaction: dict[str, Any],
    timeout_sec: int = 900,
) -> tuple[bytes, str]:
    inline_video = _extract_video_bytes(interaction)
    if inline_video is not None:
        return inline_video, ""
    file_uri = _extract_video_uri(interaction)
    if not file_uri:
        raise GeminiError(f"Gemini Omni Flash did not return a downloadable video URI: {interaction}")
    file_id = _extract_file_id(file_uri)
    headers = {"x-goog-api-key": api_key}
    deadline = time.time() + timeout_sec
    while True:
        status_payload = _get_json(f"{GEMINI_FILES_URL}/{file_id}?key={api_key}", headers)
        state = str(status_payload.get("state") or "").strip().upper()
        if state == "ACTIVE":
            video_bytes = _get_bytes(f"{GEMINI_FILES_URL}/{file_id}:download?alt=media&key={api_key}", headers)
            return video_bytes, file_id
        if state == "FAILED":
            raise GeminiError(f"Gemini Omni Flash video generation failed: {status_payload}")
        if time.time() >= deadline:
            raise GeminiError(f"Timed out waiting for Gemini Omni Flash video file {file_id} to become ACTIVE")
        time.sleep(5)


def generate_image_edit(
    *,
    api_key: str,
    model: str,
    prompt: str,
    input_image_bytes: bytes,
    mask_image_bytes: bytes | None = None,
    reference_images: list[tuple[bytes, str]] | None = None,
    input_mime_type: str = "image/png",
    aspect_ratio: str | None = None,
    seed: int | None = None,
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
    for image_bytes, mime_type in reference_images or []:
        parts.append(
            {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": base64.b64encode(image_bytes).decode("utf-8"),
                }
            }
        )
    parts.append({"text": prompt})

    generation_config: dict[str, Any] = {
        "responseModalities": ["TEXT", "IMAGE"],
    }
    if aspect_ratio:
        generation_config["imageConfig"] = {
            "aspectRatio": aspect_ratio,
        }
    # Optional seed for repeatable look-dev. Gemini accepts it in generationConfig;
    # determinism is best-effort on Google's side, not guaranteed identical output.
    if seed is not None:
        generation_config["seed"] = int(seed)

    payload: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": parts,
            }
        ],
        "generationConfig": generation_config,
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


def generate_image_from_references(
    *,
    api_key: str,
    model: str,
    prompt: str,
    reference_images: list[tuple[bytes, str]],
    aspect_ratio: str | None = None,
    seed: int | None = None,
) -> bytes:
    """Generate an image from a prompt plus zero or more reference images.

    With an empty ``reference_images`` list this is a pure text-to-image generation
    (the prompt is the only part), which is how the canvas does prompt-only gen.
    """
    model_id = GEMINI_MODEL_MAP[model]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
    headers = {
        "x-goog-api-key": api_key,
        "content-type": "application/json",
    }
    parts: list[dict[str, Any]] = [{"text": prompt}]
    for image_bytes, mime_type in reference_images:
        parts.append(
            {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": base64.b64encode(image_bytes).decode("utf-8"),
                }
            }
        )

    generation_config: dict[str, Any] = {
        "responseModalities": ["TEXT", "IMAGE"],
    }
    if aspect_ratio:
        generation_config["imageConfig"] = {
            "aspectRatio": aspect_ratio,
        }
    if seed is not None:
        generation_config["seed"] = int(seed)

    payload: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": parts,
            }
        ],
        "generationConfig": generation_config,
    }
    data = _post(url, headers, payload)
    return _extract_image_bytes(data)
