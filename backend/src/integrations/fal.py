from __future__ import annotations

from typing import Any

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


class FalError(RuntimeError):
    pass


FAL_QUEUE_ENDPOINT = "https://queue.fal.run"
FAL_SEEDANCE_REFERENCE_TO_VIDEO_MODEL = "bytedance/seedance-2.0/reference-to-video"
FAL_SORA_2_IMAGE_TO_VIDEO_PRO_MODEL = "fal-ai/sora-2/image-to-video/pro"
FAL_HAPPY_HORSE_VIDEO_EDIT_MODEL = "alibaba/happy-horse/video-edit"
FAL_HAPPY_HORSE_IMAGE_TO_VIDEO_MODEL = "alibaba/happy-horse/image-to-video"
CONTENT_POLICY_MESSAGE = (
    "fal.ai rejected the Seedance request because the reference image or video appears to contain "
    "a real-person likeness or other private information. This endpoint does not expose a setting "
    "to disable that partner moderation check."
)


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _content_policy_violation_message(payload: dict[str, Any]) -> str | None:
    detail = payload.get("detail")
    if not isinstance(detail, list):
        return None
    for item in detail:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "content_policy_violation":
            return CONTENT_POLICY_MESSAGE
    return None


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((requests.RequestException,)),
    reraise=True,
)
def _request_json(method: str, url: str, *, api_key: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    response = requests.request(
        method,
        url,
        headers=_headers(api_key),
        json=payload,
        timeout=90,
    )
    if response.status_code >= 400:
        try:
            error_payload = response.json()
        except Exception:
            error_payload = {"raw": response.text[:2000]}
        content_policy_message = _content_policy_violation_message(error_payload)
        if content_policy_message:
            raise FalError(content_policy_message)
        raise FalError(f"fal.ai API error ({response.status_code}): {error_payload}")
    return response.json()


def submit_seedance_reference_to_video(*, api_key: str, input: dict[str, Any]) -> dict[str, Any]:
    return _request_json(
        "POST",
        f"{FAL_QUEUE_ENDPOINT}/{FAL_SEEDANCE_REFERENCE_TO_VIDEO_MODEL}",
        api_key=api_key,
        payload=input,
    )


def submit_sora_2_image_to_video_pro(*, api_key: str, input: dict[str, Any]) -> dict[str, Any]:
    return _request_json(
        "POST",
        f"{FAL_QUEUE_ENDPOINT}/{FAL_SORA_2_IMAGE_TO_VIDEO_PRO_MODEL}",
        api_key=api_key,
        payload=input,
    )


def submit_happy_horse_video_edit(*, api_key: str, input: dict[str, Any]) -> dict[str, Any]:
    return _request_json(
        "POST",
        f"{FAL_QUEUE_ENDPOINT}/{FAL_HAPPY_HORSE_VIDEO_EDIT_MODEL}",
        api_key=api_key,
        payload=input,
    )


def submit_happy_horse_image_to_video(*, api_key: str, input: dict[str, Any]) -> dict[str, Any]:
    return _request_json(
        "POST",
        f"{FAL_QUEUE_ENDPOINT}/{FAL_HAPPY_HORSE_IMAGE_TO_VIDEO_MODEL}",
        api_key=api_key,
        payload=input,
    )


def get_queue_status(*, api_key: str, status_url: str) -> dict[str, Any]:
    return _request_json("GET", status_url, api_key=api_key)


def get_queue_result(*, api_key: str, response_url: str) -> dict[str, Any]:
    return _request_json("GET", response_url, api_key=api_key)
