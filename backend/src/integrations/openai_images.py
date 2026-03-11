from __future__ import annotations

import base64
import math
from io import BytesIO
from typing import Any

import requests
from PIL import Image, ImageOps
from tenacity import retry, stop_after_attempt, wait_exponential

OPENAI_IMAGE_MODEL_MAP = {
    "chatgpt": "gpt-image-1.5",
}
OPENAI_SUPPORTED_SIZES: tuple[tuple[int, int], ...] = (
    (1536, 1024),
    (1024, 1536),
    (1024, 1024),
)


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
    target_size: tuple[int, int] | None = None,
) -> dict[str, Any]:
    model_id = OPENAI_IMAGE_MODEL_MAP[model]
    headers = {
        "Authorization": f"Bearer {api_key}",
    }
    data: dict[str, str] = {
        "model": model_id,
        "prompt": prompt,
        "size": f"{target_size[0]}x{target_size[1]}" if target_size else "auto",
        "quality": "auto",
    }
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image[]", ("source.png", input_image_bytes, input_mime_type)),
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
    if response.status_code >= 400:
        detail = response.text[:1000]
        raise OpenAIImageError(f"OpenAI image edit failed ({response.status_code}): {detail}")
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


def _select_supported_size(width: int, height: int) -> tuple[int, int]:
    src_ratio = max(1e-6, float(width) / max(1.0, float(height)))
    best_size = OPENAI_SUPPORTED_SIZES[0]
    best_delta = 1e9
    for candidate in OPENAI_SUPPORTED_SIZES:
        candidate_ratio = float(candidate[0]) / float(candidate[1])
        delta = abs(math.log(src_ratio / candidate_ratio))
        if delta < best_delta:
            best_delta = delta
            best_size = candidate
    return best_size


def _prepare_input_image(
    *, input_image_bytes: bytes, mask_image_bytes: bytes | None
) -> tuple[bytes, bytes | None, tuple[int, int], tuple[int, int], tuple[int, int, int, int]]:
    source = ImageOps.exif_transpose(Image.open(BytesIO(input_image_bytes))).convert("RGBA")
    original_size = source.size
    target_size = _select_supported_size(source.width, source.height)
    fit_box = (0, 0, target_size[0], target_size[1])
    if source.size != target_size:
        fitted = ImageOps.contain(source, target_size, Image.Resampling.LANCZOS)
        offset_x = max(0, (target_size[0] - fitted.width) // 2)
        offset_y = max(0, (target_size[1] - fitted.height) // 2)
        canvas = Image.new("RGBA", target_size, (0, 0, 0, 255))
        canvas.paste(fitted, (offset_x, offset_y))
        source = canvas
        fit_box = (offset_x, offset_y, offset_x + fitted.width, offset_y + fitted.height)
    source_out = BytesIO()
    source.save(source_out, format="PNG")

    prepared_mask: bytes | None = None
    if mask_image_bytes:
        mask = ImageOps.exif_transpose(Image.open(BytesIO(mask_image_bytes))).convert("RGBA")
        if mask.size != target_size:
            fitted_mask = ImageOps.contain(mask, target_size, Image.Resampling.BILINEAR)
            mask_canvas = Image.new("RGBA", target_size, (0, 0, 0, 255))
            mask_canvas.paste(fitted_mask, (fit_box[0], fit_box[1]))
            mask = mask_canvas
        mask_out = BytesIO()
        mask.save(mask_out, format="PNG")
        prepared_mask = mask_out.getvalue()

    return source_out.getvalue(), prepared_mask, original_size, target_size, fit_box


def _restore_output_size(output_bytes: bytes, original_size: tuple[int, int], fit_box: tuple[int, int, int, int]) -> bytes:
    image = ImageOps.exif_transpose(Image.open(BytesIO(output_bytes))).convert("RGBA")
    if image.size != original_size:
        if fit_box[2] > fit_box[0] and fit_box[3] > fit_box[1] and image.size[0] >= fit_box[2] and image.size[1] >= fit_box[3]:
            image = image.crop(fit_box)
        image = image.resize(original_size, Image.Resampling.LANCZOS)
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def generate_image_edit(
    *,
    api_key: str,
    model: str,
    prompt: str,
    input_image_bytes: bytes,
    mask_image_bytes: bytes | None = None,
    input_mime_type: str = "image/png",
) -> bytes:
    prepared_image, prepared_mask, original_size, target_size, fit_box = _prepare_input_image(
        input_image_bytes=input_image_bytes,
        mask_image_bytes=mask_image_bytes,
    )
    payload = _post(
        api_key=api_key,
        model=model,
        prompt=prompt,
        input_image_bytes=prepared_image,
        mask_image_bytes=prepared_mask,
        input_mime_type="image/png",
        target_size=target_size,
    )
    output = _extract_image_bytes(payload)
    return _restore_output_size(output, original_size, fit_box)
