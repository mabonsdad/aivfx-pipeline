from __future__ import annotations

import base64
import json
import time
from io import BytesIO
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image, ImageChops, ImageOps


FAL_QUEUE_URL = "https://queue.fal.run/fal-ai/sam2/image"


def _http_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = None
    request_headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"fal.ai API error ({exc.code}): {details}") from exc
    except URLError as exc:
        raise RuntimeError(f"fal.ai API request failed: {exc.reason}") from exc


def _http_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "aivfx-quality-match/1.0"})
    try:
        with urlopen(request, timeout=60) as response:
            return response.read()
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Unable to read SAM artifact ({exc.code}): {details}") from exc
    except URLError as exc:
        raise RuntimeError(f"Unable to read SAM artifact: {exc.reason}") from exc


def _image_to_data_uri(image_bytes: bytes, mime: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _load_binary_mask(mask_bytes: bytes, size: tuple[int, int]) -> Image.Image:
    image = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
    if image.size != size:
        image = ImageOps.contain(image, size, Image.Resampling.BILINEAR)
        canvas = Image.new("L", size, 0)
        canvas.paste(image, ((size[0] - image.size[0]) // 2, (size[1] - image.size[1]) // 2))
        image = canvas
    return image.point(lambda value: 255 if value >= 127 else 0)


def _load_segmented_mask(mask_bytes: bytes, size: tuple[int, int]) -> Image.Image:
    image = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes)))
    if "A" in image.getbands():
        alpha = image.getchannel("A")
        if alpha.getbbox():
            image = alpha
        else:
            image = image.convert("L")
    else:
        image = image.convert("L")
    if image.size != size:
        image = ImageOps.contain(image, size, Image.Resampling.BILINEAR)
        canvas = Image.new("L", size, 0)
        canvas.paste(image, ((size[0] - image.size[0]) // 2, (size[1] - image.size[1]) // 2))
        image = canvas
    return image.point(lambda value: 255 if value >= 24 else 0)


def _mask_bounds(mask: Image.Image) -> dict[str, int] | None:
    bbox = mask.getbbox()
    if not bbox:
        return None
    left, top, right, bottom = bbox
    return {"x": int(left), "y": int(top), "w": int(right - left), "h": int(bottom - top)}


def _point_score(mask: Image.Image, points: list[dict[str, float]], positive: bool) -> float:
    if not points:
        return 0.0
    width, height = mask.size
    pixels = mask.load()
    score = 0.0
    for point in points:
        x = min(width - 1, max(0, int(round(point["x"]))))
        y = min(height - 1, max(0, int(round(point["y"]))))
        inside = pixels[x, y] >= 127
        if positive:
            score += 1.0 if inside else -0.8
        else:
            score += -1.0 if inside else 0.35
    return score


def _box_score(mask: Image.Image, box: dict[str, float] | None) -> float:
    if not box:
        return 0.0
    bounds = _mask_bounds(mask)
    if not bounds:
        return -1.0
    left = float(box["x"])
    top = float(box["y"])
    right = left + float(box["w"])
    bottom = top + float(box["h"])
    inter_left = max(left, bounds["x"])
    inter_top = max(top, bounds["y"])
    inter_right = min(right, bounds["x"] + bounds["w"])
    inter_bottom = min(bottom, bounds["y"] + bounds["h"])
    inter_area = max(0.0, inter_right - inter_left) * max(0.0, inter_bottom - inter_top)
    mask_area = max(1.0, float(bounds["w"] * bounds["h"]))
    box_area = max(1.0, float(box["w"] * box["h"]))
    union_area = mask_area + box_area - inter_area
    return (inter_area / union_area) * 2.5 + (inter_area / box_area) * 0.7


def _mask_overlap_score(mask: Image.Image, existing_mask: Image.Image | None) -> float:
    if existing_mask is None:
        return 0.0
    overlap = ImageChops.multiply(mask, existing_mask)
    overlap_count = sum(1 for value in overlap.getdata() if value >= 127)
    mask_count = max(1, sum(1 for value in mask.getdata() if value >= 127))
    return overlap_count / mask_count


def _edge_bias_adjustment(mask: Image.Image, bias: str) -> float:
    mask_count = sum(1 for value in mask.getdata() if value >= 127)
    area_ratio = mask_count / max(1, mask.size[0] * mask.size[1])
    if bias == "conservative":
        return -area_ratio * 1.5
    if bias == "inclusive":
        return area_ratio * 0.8
    return -abs(area_ratio - 0.18) * 0.2


def _component_count(mask: Image.Image) -> int:
    binary = mask.point(lambda value: 255 if value >= 127 else 0)
    width, height = binary.size
    pixels = binary.load()
    seen: set[tuple[int, int]] = set()
    count = 0
    for y in range(height):
        for x in range(width):
            if pixels[x, y] < 127 or (x, y) in seen:
                continue
            count += 1
            stack = [(x, y)]
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    if pixels[nx, ny] < 127 or (nx, ny) in seen:
                        continue
                    seen.add((nx, ny))
                    stack.append((nx, ny))
    return count


def _quality_adjustment(mask: Image.Image) -> float:
    bounds = _mask_bounds(mask)
    if not bounds:
        return -4.0
    area = max(1, sum(1 for value in mask.getdata() if value >= 127))
    bbox_area = max(1, bounds["w"] * bounds["h"])
    fill_ratio = area / bbox_area
    components = _component_count(mask)
    edge_touch = 0
    pixels = mask.load()
    width, height = mask.size
    for x in range(width):
        if pixels[x, 0] >= 127:
            edge_touch += 1
        if pixels[x, height - 1] >= 127:
            edge_touch += 1
    for y in range(height):
        if pixels[0, y] >= 127:
            edge_touch += 1
        if pixels[width - 1, y] >= 127:
            edge_touch += 1
    edge_ratio = edge_touch / max(1, (width * 2) + (height * 2))
    return (fill_ratio * 0.8) - (max(0, components - 1) * 0.2) - (edge_ratio * 0.6)


def _fal_headers(fal_api_key: str) -> dict[str, str]:
    return {"Authorization": f"Key {fal_api_key}"}


def _fal_submit(fal_api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _http_json(
        FAL_QUEUE_URL,
        method="POST",
        headers=_fal_headers(fal_api_key),
        payload=payload,
    )


def _fal_wait_for_result(fal_api_key: str, submit_response: dict[str, Any]) -> dict[str, Any]:
    return _fal_wait_for_result_with_deadline(fal_api_key, submit_response, max_wait_seconds=90.0)


def _fal_wait_for_result_with_deadline(
    fal_api_key: str,
    submit_response: dict[str, Any],
    *,
    max_wait_seconds: float,
) -> dict[str, Any]:
    status_url = submit_response.get("status_url")
    response_url = submit_response.get("response_url")
    if not status_url and submit_response.get("request_id"):
        request_id = str(submit_response["request_id"])
        status_url = f"{FAL_QUEUE_URL}/requests/{request_id}/status"
        response_url = f"{FAL_QUEUE_URL}/requests/{request_id}"
    if not status_url or not response_url:
        raise RuntimeError("fal.ai SAM request did not return status URLs")

    deadline = time.time() + max(5.0, float(max_wait_seconds))
    status = "IN_PROGRESS"
    while time.time() < deadline:
        status_payload = _http_json(status_url, headers=_fal_headers(fal_api_key))
        status = str(status_payload.get("status") or status_payload.get("state") or status).upper()
        if status in {"COMPLETED", "SUCCEEDED"}:
            return _http_json(response_url, headers=_fal_headers(fal_api_key))
        if status in {"FAILED", "CANCELED"}:
            details = status_payload.get("error") or status_payload.get("detail") or status_payload
            raise RuntimeError(f"fal.ai SAM request failed: {details}")
        time.sleep(1.0)
    raise RuntimeError("fal.ai SAM request is still running; please retry in a moment")


def _extract_fal_image_url(payload: dict[str, Any]) -> str:
    candidates = [
        payload.get("image"),
        payload.get("output"),
        (payload.get("images") or [None])[0] if isinstance(payload.get("images"), list) else None,
        ((payload.get("result") or {}).get("image") if isinstance(payload.get("result"), dict) else None),
    ]
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.startswith("http"):
            return candidate
        if isinstance(candidate, dict):
            url = candidate.get("url") or candidate.get("image_url")
            if isinstance(url, str) and url.startswith("http"):
                return url
    raise RuntimeError("fal.ai SAM response did not include an output image URL")


def request_sam2_proposals(
    *,
    fal_api_key: str,
    image_bytes: bytes,
    positive_points: list[dict[str, float]],
    negative_points: list[dict[str, float]],
    box: dict[str, float] | None,
    existing_mask_bytes: bytes | None,
    restrict_to_mask_bounds: bool,
    edge_bias: str,
    max_wait_seconds: float = 90.0,
) -> dict[str, Any]:
    source = ImageOps.exif_transpose(Image.open(BytesIO(image_bytes))).convert("RGB")
    existing_mask = _load_binary_mask(existing_mask_bytes, source.size) if existing_mask_bytes else None
    prompts = [{"x": int(round(float(point["x"]))), "y": int(round(float(point["y"]))), "label": 1} for point in positive_points]
    prompts.extend({"x": int(round(float(point["x"]))), "y": int(round(float(point["y"]))), "label": 0} for point in negative_points)
    if not prompts and not box:
        raise RuntimeError("Add one or more SAM points or draw a SAM box first.")
    payload: dict[str, Any] = {
        "image_url": _image_to_data_uri(image_bytes),
    }
    if prompts:
        payload["prompts"] = prompts
    if box:
        payload["box_prompts"] = [
            {
                "x_min": int(round(float(box["x"]))),
                "y_min": int(round(float(box["y"]))),
                "x_max": int(round(float(box["x"] + box["w"]))),
                "y_max": int(round(float(box["y"] + box["h"]))),
            }
        ]
    result_payload = _fal_wait_for_result_with_deadline(
        fal_api_key,
        _fal_submit(fal_api_key, payload),
        max_wait_seconds=max_wait_seconds,
    )
    output_url = _extract_fal_image_url(result_payload)

    warnings: list[str] = []
    try:
        mask = _load_segmented_mask(_http_bytes(output_url), source.size)
    except Exception as exc:
        warnings.append(str(exc))
        return {"proposals": [], "warnings": warnings}

    if restrict_to_mask_bounds and existing_mask is not None:
        mask = ImageChops.multiply(mask, existing_mask)

    score = 0.0
    score += _point_score(mask, positive_points, True)
    score += _point_score(mask, negative_points, False)
    score += _box_score(mask, box)
    score += _mask_overlap_score(mask, existing_mask)
    score += _edge_bias_adjustment(mask, edge_bias)
    score += _quality_adjustment(mask)

    buffer = BytesIO()
    mask.save(buffer, format="PNG")
    proposals = [
        {
            "index": 0,
            "score": float(score),
            "maskBytes": buffer.getvalue(),
            "bounds": _mask_bounds(mask),
        }
    ]
    return {"proposals": proposals, "warnings": warnings}
