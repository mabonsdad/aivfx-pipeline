from __future__ import annotations

import json
import time
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
    if response.status_code >= 400:
        body = response.text
        try:
            body = json.dumps(response.json())
        except ValueError:
            pass
        raise LumaError(
            f"Luma API {method} {url} failed ({response.status_code}): {body[:1200]}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise LumaError(f"Luma API {method} {url} returned non-JSON response") from exc


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


def create_uni_image_edit_generation(
    *,
    api_key: str,
    source_url: str,
    prompt: str,
    model: str = "uni-1",
    style: str | None = None,
    output_format: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "image_edit",
        "prompt": prompt,
        "source": {"url": source_url},
        "model": model,
    }
    if style:
        payload["style"] = style
    if output_format:
        payload["output_format"] = output_format
    return _request(
        "POST",
        "https://agents.lumalabs.ai/v1/generations",
        token=api_key,
        payload=payload,
    )


def create_uni_image_generation(
    *,
    api_key: str,
    prompt: str,
    model: str = "uni-1",
    style: str | None = None,
    output_format: str | None = None,
    image_refs: list[dict[str, Any]] | None = None,
    aspect_ratio: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "image",
        "prompt": prompt,
        "model": model,
    }
    if style:
        payload["style"] = style
    if output_format:
        payload["output_format"] = output_format
    if image_refs:
        payload["image_ref"] = image_refs
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
    return _request(
        "POST",
        "https://agents.lumalabs.ai/v1/generations",
        token=api_key,
        payload=payload,
    )


def get_uni_generation(*, api_key: str, generation_id: str) -> dict[str, Any]:
    return _request(
        "GET",
        f"https://agents.lumalabs.ai/v1/generations/{generation_id}",
        token=api_key,
    )


def parse_uni_output_url(payload: dict[str, Any]) -> str:
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            maybe = item.get("url")
            if isinstance(maybe, str) and maybe.startswith("http"):
                return maybe
    raise LumaError(f"Luma Uni completion payload missing output URL: {payload}")


def wait_for_uni_generation_complete(*, api_key: str, generation_id: str, timeout_sec: int = 1200) -> dict[str, Any]:
    start = time.time()
    while True:
        payload = get_uni_generation(api_key=api_key, generation_id=generation_id)
        state = str(payload.get("state") or "").lower()
        if state in {"completed", "complete", "succeeded", "success"}:
            return payload
        if state in {"failed", "error", "cancelled"}:
            raise LumaError(f"Luma Uni generation failed: {payload}")
        if time.time() - start > timeout_sec:
            raise TimeoutError("Luma Uni generation poll timeout")
        time.sleep(6)
