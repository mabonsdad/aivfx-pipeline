from __future__ import annotations

from pathlib import Path
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


class RunwayError(RuntimeError):
    pass


RUNWAY_VERSION_HEADER = "2024-11-06"


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def _request(method: str, url: str, *, token: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Runway-Version": RUNWAY_VERSION_HEADER,
        "Content-Type": "application/json",
    }
    response = requests.request(method, url, headers=headers, json=payload, timeout=90)
    response.raise_for_status()
    return response.json()


def create_video_to_video(
    *,
    api_key: str,
    video_uri: str,
    prompt_text: str | None,
    first_frame_uri: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": "gen4_aleph",
        "videoUri": video_uri,
        "promptText": prompt_text or "Modify the source video while preserving overall composition and motion continuity.",
    }
    if first_frame_uri:
        payload["references"] = [{"type": "image", "uri": first_frame_uri}]
    return _request("POST", "https://api.dev.runwayml.com/v1/video_to_video", token=api_key, payload=payload)


def create_image_to_video(
    *,
    api_key: str,
    prompt_image_uri: str,
    prompt_text: str,
    ratio: str,
    duration: int,
    model: str = "gen4.5",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "promptText": prompt_text,
        "promptImage": prompt_image_uri,
        "ratio": ratio,
        "duration": int(duration),
    }
    return _request("POST", "https://api.dev.runwayml.com/v1/image_to_video", token=api_key, payload=payload)


def get_task(*, api_key: str, task_id: str) -> dict[str, Any]:
    return _request("GET", f"https://api.dev.runwayml.com/v1/tasks/{task_id}", token=api_key)


def create_ephemeral_upload(*, api_key: str, filename: str) -> dict[str, Any]:
    payload = {"filename": filename, "type": "ephemeral"}
    return _request("POST", "https://api.dev.runwayml.com/v1/uploads", token=api_key, payload=payload)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8), reraise=True)
def upload_to_ephemeral(*, upload_url: str, fields: dict[str, Any], file_path: Path, content_type: str) -> None:
    with file_path.open("rb") as fh:
        files = {
            "file": (file_path.name, fh, content_type),
        }
        response = requests.post(upload_url, data=fields, files=files, timeout=300)
    response.raise_for_status()
