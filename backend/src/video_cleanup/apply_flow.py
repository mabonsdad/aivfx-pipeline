from __future__ import annotations

import subprocess
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from src.core.ffmpeg import FFMPEG_BIN
from src.video_cleanup.models import VideoCleanupSettings


def _load_rgb(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def _match_rgb_size(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    if image.size == size:
        return image
    return image.resize(size, Image.Resampling.LANCZOS)


def _load_mask(path: Path, size: tuple[int, int]) -> Image.Image:
    mask = Image.open(path).convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.Resampling.BILINEAR)
    return mask


def _grow_or_shrink(mask: Image.Image, grow_px: int, erode_px: int) -> Image.Image:
    out = mask.convert("L")
    if grow_px > 0:
        out = out.filter(ImageFilter.MaxFilter(max(3, (grow_px * 2) + 1)))
    if erode_px > 0:
        out = out.filter(ImageFilter.MinFilter(max(3, (erode_px * 2) + 1)))
    return out


def _smoothstep_mask(mask: Image.Image, epsilon: float) -> Image.Image:
    lo = max(0.0, 0.5 - epsilon)
    hi = min(1.0, 0.5 + epsilon)
    if hi <= lo:
        hi = min(1.0, lo + 1e-3)

    def _point(value: int) -> int:
        norm = value / 255.0
        if norm <= lo:
            return 0
        if norm >= hi:
            return 255
        t = (norm - lo) / (hi - lo)
        smoothed = t * t * (3.0 - (2.0 * t))
        return int(max(0, min(255, round(smoothed * 255.0))))

    return mask.point(_point)


def _apply_temporal_smoothing(mask_images: list[Image.Image], radius: int) -> list[Image.Image]:
    if radius <= 0 or len(mask_images) <= 1:
        return [image.copy() for image in mask_images]
    smoothed: list[Image.Image] = []
    for index in range(len(mask_images)):
        start = max(0, index - radius)
        end = min(len(mask_images), index + radius + 1)
        blended = mask_images[start].copy().convert("L")
        weight = 1.0
        for neighbor in range(start + 1, end):
            weight += 1.0
            alpha = 1.0 / weight
            blended = Image.blend(blended, mask_images[neighbor].convert("L"), alpha)
        smoothed.append(blended)
    return smoothed


def prepare_mask_images(mask_paths: list[Path], generated_frame_paths: list[Path], settings: VideoCleanupSettings) -> list[Image.Image]:
    masks = [_grow_or_shrink(_load_mask(mask_path, _load_rgb(frame_path).size), settings.mask_dilate_px, settings.mask_erode_px) for mask_path, frame_path in zip(mask_paths, generated_frame_paths)]
    masks = _apply_temporal_smoothing(masks, settings.temporal_smoothing_radius)
    final_masks: list[Image.Image] = []
    epsilon = max(0.04, 0.25 - (settings.mask_hardness * 0.22))
    for mask in masks:
        soft = mask
        if settings.mask_feather_px > 0:
            soft = mask.filter(ImageFilter.GaussianBlur(radius=max(0.5, settings.mask_feather_px / 2.0)))
        hard = _smoothstep_mask(mask, epsilon)
        final_masks.append(Image.blend(soft, hard, settings.mask_hardness).convert("L"))
    return final_masks


def compose_clean_frame(
    *,
    source_rgb: Image.Image,
    generated_rgb: Image.Image,
    final_mask: Image.Image,
    restore_strength: float,
) -> tuple[Image.Image, Image.Image]:
    target_size = generated_rgb.size
    source_rgb = _match_rgb_size(source_rgb, target_size)
    keep_mask = final_mask.convert("L")
    if keep_mask.size != target_size:
        keep_mask = keep_mask.resize(target_size, Image.Resampling.BILINEAR)
    restore_mask = ImageChops.invert(keep_mask).point(
        lambda value: max(0, min(255, int(round((value / 255.0) * restore_strength * 255.0))))
    )
    cleaned = Image.composite(source_rgb, generated_rgb, restore_mask)
    return cleaned, keep_mask


def outline_mask(base_rgb: Image.Image, keep_mask: Image.Image) -> Image.Image:
    dilated = keep_mask.filter(ImageFilter.MaxFilter(5))
    eroded = keep_mask.filter(ImageFilter.MinFilter(5))
    edge = ImageChops.subtract(dilated, eroded).point(lambda value: 255 if value >= 64 else 0)
    overlay = base_rgb.convert("RGBA")
    edge_layer = Image.new("RGBA", overlay.size, (36, 196, 255, 0))
    edge_layer.putalpha(edge.point(lambda value: 220 if value >= 127 else 0))
    fill_layer = Image.new("RGBA", overlay.size, (46, 214, 126, 0))
    fill_layer.putalpha(keep_mask.point(lambda value: min(96, int(value * 0.35))))
    return Image.alpha_composite(Image.alpha_composite(overlay, fill_layer), edge_layer).convert("RGB")


def checker_outside_mask(base_rgb: Image.Image, keep_mask: Image.Image, block_size: int = 24) -> Image.Image:
    width, height = base_rgb.size
    checker = Image.new("RGB", (width, height), (234, 234, 234))
    draw = ImageDraw.Draw(checker)
    for y in range(0, height, block_size):
        for x in range(0, width, block_size):
            if ((x // block_size) + (y // block_size)) % 2 == 0:
                draw.rectangle((x, y, x + block_size - 1, y + block_size - 1), fill=(199, 199, 199))
    return Image.composite(base_rgb, checker, keep_mask.convert("L"))


def encode_png_sequence_to_mp4(frames_dir: Path, output_path: Path, fps_num: int, fps_den: int) -> None:
    fps = f"{max(1, int(fps_num))}/{max(1, int(fps_den))}"
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-framerate",
        fps,
        "-i",
        str(frames_dir / "frame_%04d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-preset",
        "medium",
        str(output_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to encode cleanup preview: {proc.stderr}")


def render_cleaned_video(
    *,
    source_frame_paths: list[Path],
    generated_frame_paths: list[Path],
    mask_frame_paths: list[Path],
    settings: VideoCleanupSettings,
    output_frames_dir: Path,
    fps_num: int,
    fps_den: int,
    output_video_path: Path,
    burn_in_mask: bool = False,
) -> dict[str, Any]:
    output_frames_dir.mkdir(parents=True, exist_ok=True)
    final_masks = prepare_mask_images(mask_frame_paths, generated_frame_paths, settings)
    generated_coverages: list[float] = []
    original_restores: list[float] = []
    for index, (source_path, generated_path, final_mask) in enumerate(zip(source_frame_paths, generated_frame_paths, final_masks)):
        source_rgb = _load_rgb(source_path)
        generated_rgb = _load_rgb(generated_path)
        cleaned, keep_mask = compose_clean_frame(
            source_rgb=source_rgb,
            generated_rgb=generated_rgb,
            final_mask=final_mask,
            restore_strength=settings.restore_strength,
        )
        if burn_in_mask:
            cleaned = outline_mask(cleaned, keep_mask)
        cleaned.save(output_frames_dir / f"frame_{index:04d}.png", format="PNG")
        generated_coverages.append(sum(keep_mask.getdata()) / (255.0 * max(1, keep_mask.width * keep_mask.height)) * 100.0)
        original_restores.append((100.0 - generated_coverages[-1]) * settings.restore_strength)
    encode_png_sequence_to_mp4(output_frames_dir, output_video_path, fps_num, fps_den)
    return {
        "meanGeneratedCoveragePct": round(sum(generated_coverages) / max(1, len(generated_coverages)), 4),
        "meanOriginalRestorePct": round(sum(original_restores) / max(1, len(original_restores)), 4),
        "meanBoundaryWidthPx": round(float(settings.mask_feather_px), 4),
        "outputDurationSec": round(len(final_masks) * (float(fps_den) / max(1.0, float(fps_num))), 4),
    }
