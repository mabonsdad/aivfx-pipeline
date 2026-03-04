from __future__ import annotations

import base64
import math
from io import BytesIO
from typing import Any
from uuid import uuid4

import requests
from PIL import Image
from tenacity import retry, stop_after_attempt, wait_exponential


class RunwareError(RuntimeError):
    pass


RUNWARE_API_URL = "https://api.runware.ai/v1"
FLUX_FILL_MODEL = "runware:102@1"
RUNWARE_MIN_DIM = 128
RUNWARE_MAX_DIM = 2048
RUNWARE_DIM_STEP = 64


def _to_data_uri(image_bytes: bytes, mime_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def _clamp_runware_dim(value: int) -> int:
    rounded = int(math.ceil(max(1, value) / RUNWARE_DIM_STEP) * RUNWARE_DIM_STEP)
    return max(RUNWARE_MIN_DIM, min(RUNWARE_MAX_DIM, rounded))


def _prepare_runware_canvas(
    *,
    seed_image_bytes: bytes,
    mask_image_bytes: bytes,
) -> tuple[bytes, bytes, int, int, tuple[int, int, int, int]]:
    seed = Image.open(BytesIO(seed_image_bytes)).convert("RGBA")
    mask = Image.open(BytesIO(mask_image_bytes)).convert("L")
    if mask.size != seed.size:
        mask = mask.resize(seed.size, Image.Resampling.BILINEAR)

    source_w, source_h = seed.size
    target_w = _clamp_runware_dim(source_w)
    target_h = _clamp_runware_dim(source_h)

    if target_w == source_w and target_h == source_h:
        left = 0
        top = 0
        right = source_w
        bottom = source_h
        seed_buf = BytesIO()
        seed.save(seed_buf, format="PNG")
        mask_buf = BytesIO()
        mask.save(mask_buf, format="PNG")
        return seed_buf.getvalue(), mask_buf.getvalue(), target_w, target_h, (left, top, right, bottom)

    scale = min(target_w / float(source_w), target_h / float(source_h))
    scaled_w = max(1, int(round(source_w * scale)))
    scaled_h = max(1, int(round(source_h * scale)))

    seed_scaled = seed.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)
    mask_scaled = mask.resize((scaled_w, scaled_h), Image.Resampling.BILINEAR)

    left = (target_w - scaled_w) // 2
    top = (target_h - scaled_h) // 2
    right = left + scaled_w
    bottom = top + scaled_h

    seed_canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 255))
    seed_canvas.paste(seed_scaled, (left, top))

    mask_canvas = Image.new("L", (target_w, target_h), 0)
    mask_canvas.paste(mask_scaled, (left, top))

    seed_buf = BytesIO()
    seed_canvas.save(seed_buf, format="PNG")
    mask_buf = BytesIO()
    mask_canvas.save(mask_buf, format="PNG")
    return seed_buf.getvalue(), mask_buf.getvalue(), target_w, target_h, (left, top, right, bottom)


def _restore_from_runware_canvas(
    *,
    output_bytes: bytes,
    crop_box: tuple[int, int, int, int],
    target_size: tuple[int, int],
) -> bytes:
    image = Image.open(BytesIO(output_bytes)).convert("RGBA")
    left, top, right, bottom = crop_box
    cropped = image.crop((left, top, right, bottom))
    source_w, source_h = target_size
    if cropped.size != (source_w, source_h):
        cropped = cropped.resize((source_w, source_h), Image.Resampling.LANCZOS)
    out = BytesIO()
    cropped.save(out, format="PNG")
    return out.getvalue()


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
    if response.status_code >= 400:
        try:
            error_payload = response.json()
        except Exception:
            error_payload = {"raw": response.text[:2000]}
        raise RunwareError(f"Runware API error ({response.status_code}): {error_payload}")
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
    prepared_seed, prepared_mask, request_w, request_h, crop_box = _prepare_runware_canvas(
        seed_image_bytes=seed_image_bytes,
        mask_image_bytes=mask_image_bytes,
    )
    task: dict[str, Any] = {
        "taskType": "imageInference",
        "taskUUID": str(uuid4()),
        "deliveryMethod": "sync",
        "model": FLUX_FILL_MODEL,
        "positivePrompt": prompt,
        "seedImage": _to_data_uri(prepared_seed),
        "maskImage": _to_data_uri(prepared_mask),
        "width": request_w,
        "height": request_h,
        "steps": steps,
        "CFGScale": cfg_scale,
        "numberResults": 1,
        "outputType": "base64Data",
        "outputFormat": "PNG",
    }
    payload = _post_task(api_key, task)
    output = _extract_result_image(payload)
    return _restore_from_runware_canvas(output_bytes=output, crop_box=crop_box, target_size=(width, height))


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
    prepared_seed, prepared_mask, request_w, request_h, crop_box = _prepare_runware_canvas(
        seed_image_bytes=seed_image_bytes,
        mask_image_bytes=mask_image_bytes,
    )
    seed_uri = _to_data_uri(prepared_seed)
    mask_uri = _to_data_uri(prepared_mask)
    reference_uri = _to_data_uri(reference_image_bytes)
    task: dict[str, Any] = {
        "taskType": "imageInference",
        "taskUUID": str(uuid4()),
        "deliveryMethod": "sync",
        "model": FLUX_FILL_MODEL,
        "positivePrompt": prompt,
        "width": request_w,
        "height": request_h,
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
    output = _extract_result_image(payload)
    return _restore_from_runware_canvas(output_bytes=output, crop_box=crop_box, target_size=(width, height))
