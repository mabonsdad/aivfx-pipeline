from __future__ import annotations

import math
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageFilter, ImageOps

from src.quality_match.sam_assist import request_sam2_proposals

TRACKING_MAX_DIMENSION = 768
TRACKING_SAM_WAIT_SECONDS = 180.0
TRACKING_SAM_CALL_CAPS: dict[str, int | None] = {
    "standard": 24,
    "high_motion": 72,
    "frame_by_frame": None,
}


def normalize_mask_bytes(mask_bytes: bytes, size: tuple[int, int]) -> bytes:
    mask = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
    if mask.size != size:
        mask = ImageOps.contain(mask, size, Image.Resampling.BILINEAR)
        canvas = Image.new("L", size, 0)
        canvas.paste(mask, ((size[0] - mask.size[0]) // 2, (size[1] - mask.size[1]) // 2))
        mask = canvas
    mask = mask.point(lambda value: 255 if value >= 127 else 0)
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    output = BytesIO()
    mask.save(output, format="PNG")
    return output.getvalue()


def load_mask(mask_bytes: bytes, size: tuple[int, int]) -> Image.Image:
    return Image.open(BytesIO(normalize_mask_bytes(mask_bytes, size))).convert("L")


def mask_bounds(mask_image: Image.Image) -> dict[str, float] | None:
    bbox = mask_image.getbbox()
    if not bbox:
        return None
    left, top, right, bottom = bbox
    return {
        "x": float(left),
        "y": float(top),
        "w": float(max(1, right - left)),
        "h": float(max(1, bottom - top)),
    }


def mask_points(mask_image: Image.Image) -> list[dict[str, float]]:
    bbox = mask_bounds(mask_image)
    if bbox is None:
        return []
    cx = bbox["x"] + (bbox["w"] / 2.0)
    cy = bbox["y"] + (bbox["h"] / 2.0)
    points = [{"x": cx, "y": cy}]
    points.extend(
        [
            {"x": bbox["x"] + (bbox["w"] * 0.25), "y": cy},
            {"x": bbox["x"] + (bbox["w"] * 0.75), "y": cy},
            {"x": cx, "y": bbox["y"] + (bbox["h"] * 0.25)},
            {"x": cx, "y": bbox["y"] + (bbox["h"] * 0.75)},
        ]
    )
    return points


def expanded_box(mask_image: Image.Image, padding_px: int = 10) -> dict[str, float] | None:
    bounds = mask_bounds(mask_image)
    if bounds is None:
        return None
    width, height = mask_image.size
    return {
        "x": max(0.0, bounds["x"] - padding_px),
        "y": max(0.0, bounds["y"] - padding_px),
        "w": min(float(width), bounds["w"] + (padding_px * 2.0)),
        "h": min(float(height), bounds["h"] + (padding_px * 2.0)),
    }


def _encode_png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _resize_for_tracking(
    target_image_bytes: bytes,
    reference_mask_bytes: bytes,
    positive_points: list[dict[str, float]],
    negative_points: list[dict[str, float]],
    box: dict[str, float] | None,
) -> tuple[bytes, bytes, list[dict[str, float]], list[dict[str, float]], dict[str, float] | None, tuple[int, int]]:
    target = ImageOps.exif_transpose(Image.open(BytesIO(target_image_bytes))).convert("RGB")
    original_size = target.size
    max_dim = max(target.size)
    if max_dim <= TRACKING_MAX_DIMENSION:
        return (
            target_image_bytes,
            normalize_mask_bytes(reference_mask_bytes, original_size),
            positive_points,
            negative_points,
            box,
            original_size,
        )

    scale = TRACKING_MAX_DIMENSION / float(max_dim)
    resized_size = (
        max(1, int(round(target.width * scale))),
        max(1, int(round(target.height * scale))),
    )
    resized_target = target.resize(resized_size, Image.Resampling.LANCZOS)
    resized_mask = load_mask(reference_mask_bytes, original_size).resize(resized_size, Image.Resampling.BILINEAR)

    def _scale_points(points: list[dict[str, float]]) -> list[dict[str, float]]:
        return [{"x": float(point["x"]) * scale, "y": float(point["y"]) * scale} for point in points]

    resized_box = None
    if box is not None:
        resized_box = {
            "x": float(box["x"]) * scale,
            "y": float(box["y"]) * scale,
            "w": float(box["w"]) * scale,
            "h": float(box["h"]) * scale,
        }
    return (
        _encode_png(resized_target),
        _encode_png(resized_mask.convert("L")),
        _scale_points(positive_points),
        _scale_points(negative_points),
        resized_box,
        original_size,
    )


def _tracking_anchor_indices(
    start_frame_index: int,
    end_frame_index: int,
    seed_frame_index: int,
    tracking_density: str,
) -> list[int]:
    start = max(0, int(start_frame_index))
    end = max(start, int(end_frame_index))
    seed = max(start, min(int(seed_frame_index), end))
    total = end - start + 1
    sam_call_cap = TRACKING_SAM_CALL_CAPS.get(tracking_density, TRACKING_SAM_CALL_CAPS["standard"])
    if total <= 1:
        return [seed]
    if sam_call_cap is None or total <= sam_call_cap:
        return sorted(set(range(start, end + 1)))
    stride = max(1, math.ceil((total - 1) / max(1, sam_call_cap - 1)))
    anchors = list(range(start, end + 1, stride))
    if anchors[-1] != end:
        anchors.append(end)
    anchors.append(seed)
    return sorted(set(anchors))


def _interpolate_mask_bytes(start_mask_bytes: bytes, end_mask_bytes: bytes, alpha: float, size: tuple[int, int]) -> bytes:
    start_mask = Image.open(BytesIO(normalize_mask_bytes(start_mask_bytes, size))).convert("L")
    end_mask = Image.open(BytesIO(normalize_mask_bytes(end_mask_bytes, size))).convert("L")
    blended = Image.blend(start_mask, end_mask, max(0.0, min(1.0, float(alpha))))
    output = BytesIO()
    blended.point(lambda value: 255 if value >= 127 else 0).save(output, format="PNG")
    return output.getvalue()


def propagate_mask_to_frame(
    *,
    fal_api_key: str,
    target_image_bytes: bytes,
    reference_mask_bytes: bytes,
    edge_bias: str = "balanced",
    restrict_to_mask_bounds: bool = False,
    positive_points: list[dict[str, float]] | None = None,
    negative_points: list[dict[str, float]] | None = None,
    box: dict[str, float] | None = None,
) -> tuple[bytes, list[str]]:
    target = ImageOps.exif_transpose(Image.open(BytesIO(target_image_bytes))).convert("RGB")
    reference_mask = load_mask(reference_mask_bytes, target.size)
    points = positive_points if positive_points is not None else mask_points(reference_mask)
    prompt_box = box if box is not None else expanded_box(reference_mask, padding_px=max(8, min(target.size) // 40))
    tracking_image_bytes, tracking_mask_bytes, tracking_points, tracking_negatives, tracking_box, original_size = _resize_for_tracking(
        target_image_bytes,
        reference_mask_bytes,
        points,
        list(negative_points or []),
        prompt_box,
    )
    result = request_sam2_proposals(
        fal_api_key=fal_api_key,
        image_bytes=tracking_image_bytes,
        positive_points=tracking_points,
        negative_points=tracking_negatives,
        box=tracking_box,
        existing_mask_bytes=tracking_mask_bytes,
        restrict_to_mask_bounds=restrict_to_mask_bounds,
        edge_bias=edge_bias,
        max_wait_seconds=TRACKING_SAM_WAIT_SECONDS,
    )
    proposal = next(iter(result.get("proposals") or []), None)
    if not isinstance(proposal, dict) or not isinstance(proposal.get("maskBytes"), (bytes, bytearray)):
        return normalize_mask_bytes(reference_mask_bytes, target.size), list(result.get("warnings") or []) + ["SAM returned no proposal; reused previous mask."]
    return normalize_mask_bytes(bytes(proposal["maskBytes"]), original_size), list(result.get("warnings") or [])


def propagate_window(
    *,
    fal_api_key: str,
    generated_frame_paths: list[Path],
    seed_frame_index: int,
    seed_mask_bytes: bytes,
    start_frame_index: int,
    end_frame_index: int,
    direction: str,
    edge_bias: str = "balanced",
    tracking_density: str = "standard",
) -> tuple[dict[int, bytes], list[str]]:
    if not generated_frame_paths:
        return {}, ["No generated frames available for propagation."]
    clamped_start = max(0, min(start_frame_index, len(generated_frame_paths) - 1))
    clamped_end = max(0, min(end_frame_index, len(generated_frame_paths) - 1))
    seed_index = max(clamped_start, min(seed_frame_index, clamped_end))
    warnings: list[str] = []
    masks: dict[int, bytes] = {
        seed_index: normalize_mask_bytes(seed_mask_bytes, Image.open(generated_frame_paths[seed_index]).size)
    }
    anchor_indices = _tracking_anchor_indices(clamped_start, clamped_end, seed_index, tracking_density)
    if len(anchor_indices) < (clamped_end - clamped_start + 1):
        warnings.append(
            f"Tracking sampled {len(anchor_indices)} anchor frames across {clamped_end - clamped_start + 1} total frames; intermediate masks were interpolated."
        )

    def _propagate_anchor_sequence(indices: list[int]) -> None:
        previous_idx = seed_index
        for idx in indices:
            if idx == seed_index:
                continue
            reference = masks.get(previous_idx)
            if reference is None:
                continue
            next_mask, step_warnings = propagate_mask_to_frame(
                fal_api_key=fal_api_key,
                target_image_bytes=generated_frame_paths[idx].read_bytes(),
                reference_mask_bytes=reference,
                edge_bias=edge_bias,
                restrict_to_mask_bounds=False,
            )
            masks[idx] = next_mask
            warnings.extend(step_warnings)
            previous_idx = idx

    if direction in {"forward", "bidirectional", "windowed"}:
        _propagate_anchor_sequence([idx for idx in anchor_indices if idx > seed_index])
    if direction in {"backward", "bidirectional", "windowed"}:
        backward_indices = [idx for idx in anchor_indices if idx < seed_index]
        backward_indices.reverse()
        _propagate_anchor_sequence(backward_indices)

    filled_masks = dict(masks)
    ordered_anchors = sorted(masks.keys())
    for anchor_pos, anchor_idx in enumerate(ordered_anchors[:-1]):
        next_anchor_idx = ordered_anchors[anchor_pos + 1]
        if next_anchor_idx <= anchor_idx + 1:
            continue
        frame_size = Image.open(generated_frame_paths[anchor_idx]).size
        span = next_anchor_idx - anchor_idx
        for idx in range(anchor_idx + 1, next_anchor_idx):
            alpha = (idx - anchor_idx) / float(span)
            filled_masks[idx] = _interpolate_mask_bytes(masks[anchor_idx], masks[next_anchor_idx], alpha, frame_size)
    return filled_masks, warnings


def stitch_seeded_masks(
    *,
    generated_frame_paths: list[Path],
    seed_masks: dict[int, bytes],
    fal_api_key: str,
    edge_bias: str = "balanced",
    tracking_density: str = "standard",
) -> tuple[dict[int, bytes], list[str]]:
    if not seed_masks:
        return {}, ["No seed masks available."]
    ordered = sorted(seed_masks.items())
    full_masks: dict[int, bytes] = {}
    warnings: list[str] = []
    frame_count = len(generated_frame_paths)
    for index, (frame_idx, mask_bytes) in enumerate(ordered):
        prev_idx = ordered[index - 1][0] if index > 0 else None
        next_idx = ordered[index + 1][0] if index + 1 < len(ordered) else None
        start = 0 if prev_idx is None else max(prev_idx, (prev_idx + frame_idx) // 2)
        end = frame_count - 1 if next_idx is None else min(next_idx, (frame_idx + next_idx) // 2)
        window_masks, window_warnings = propagate_window(
            fal_api_key=fal_api_key,
            generated_frame_paths=generated_frame_paths,
            seed_frame_index=frame_idx,
            seed_mask_bytes=mask_bytes,
            start_frame_index=start,
            end_frame_index=end,
            direction="windowed",
            edge_bias=edge_bias,
            tracking_density=tracking_density,
        )
        full_masks.update(window_masks)
        warnings.extend(window_warnings)
    return full_masks, warnings
