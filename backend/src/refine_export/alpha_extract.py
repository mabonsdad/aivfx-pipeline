from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps


@dataclass
class ExactOverlayResult:
    edited_fitted: Image.Image
    overlay_rgba: Image.Image
    alpha_mask: Image.Image
    changed_pixel_pct: float


def load_rgb_image(image_bytes: bytes) -> Image.Image:
    return ImageOps.exif_transpose(Image.open(BytesIO(image_bytes))).convert("RGB")


def fit_image_to_size(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    if image.size == size:
        return image.copy()
    fitted = ImageOps.contain(image, size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (0, 0, 0))
    canvas.paste(fitted, ((size[0] - fitted.size[0]) // 2, (size[1] - fitted.size[1]) // 2))
    return canvas


def extract_exact_overlay(
    *,
    original_bytes: bytes,
    edited_bytes: bytes,
    diff_floor_u8: int = 1,
) -> ExactOverlayResult:
    import numpy as np  # type: ignore

    original = load_rgb_image(original_bytes)
    edited = fit_image_to_size(load_rgb_image(edited_bytes), original.size)

    original_np = np.asarray(original, dtype=np.float32) / 255.0
    edited_np = np.asarray(edited, dtype=np.float32) / 255.0
    delta = edited_np - original_np
    abs_delta = np.abs(delta)
    max_abs_delta = np.max(abs_delta, axis=2)
    epsilon = max(0.0, float(diff_floor_u8) / 255.0)

    alpha_bounds = np.zeros_like(original_np, dtype=np.float32)

    brighter = delta > epsilon
    darker = delta < -epsilon

    one_minus_original = np.maximum(1e-6, 1.0 - original_np)
    original_safe = np.maximum(1e-6, original_np)

    alpha_bounds[brighter] = delta[brighter] / one_minus_original[brighter]
    alpha_bounds[darker] = (-delta[darker]) / original_safe[darker]

    alpha = np.clip(np.max(alpha_bounds, axis=2), 0.0, 1.0)
    alpha[max_abs_delta <= epsilon] = 0.0

    alpha_u8 = np.ceil(alpha * 255.0).astype("uint8")
    alpha_q = alpha_u8.astype(np.float32) / 255.0

    foreground = np.zeros_like(edited_np, dtype=np.float32)
    nonzero = alpha_q > 0.0
    foreground[nonzero] = (
        edited_np[nonzero] - ((1.0 - alpha_q[nonzero])[:, None] * original_np[nonzero])
    ) / alpha_q[nonzero][:, None]
    foreground = np.clip(foreground, 0.0, 1.0)
    foreground_u8 = np.rint(foreground * 255.0).astype("uint8")

    rgba = np.dstack((foreground_u8, alpha_u8))
    changed_pixel_pct = round(float((alpha_u8 > 0).sum() * 100.0) / max(1, alpha_u8.size), 4)
    return ExactOverlayResult(
        edited_fitted=edited,
        overlay_rgba=Image.fromarray(rgba, mode="RGBA"),
        alpha_mask=Image.fromarray(alpha_u8, mode="L"),
        changed_pixel_pct=changed_pixel_pct,
    )
