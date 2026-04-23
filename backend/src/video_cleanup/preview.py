from __future__ import annotations

from pathlib import Path
from typing import Any

from src.video_cleanup.apply_flow import (
    checker_outside_mask,
    compose_clean_frame,
    encode_png_sequence_to_mp4,
    outline_mask,
    prepare_mask_images,
)
from src.video_cleanup.models import VideoCleanupSettings
from PIL import Image


def build_preview_assets(
    *,
    source_frame_paths: list[Path],
    generated_frame_paths: list[Path],
    mask_frame_paths: list[Path],
    settings: VideoCleanupSettings,
    diagnostics_by_frame: dict[int, dict[str, Any]],
    suggested_frames: set[int],
    workdir: Path,
    fps_num: int,
    fps_den: int,
) -> dict[str, Any]:
    generated_dir = workdir / "generated_frames"
    overlay_dir = workdir / "overlay_frames"
    checker_dir = workdir / "checker_frames"
    cleaned_dir = workdir / "cleaned_frames"
    generated_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir.mkdir(parents=True, exist_ok=True)
    checker_dir.mkdir(parents=True, exist_ok=True)
    cleaned_dir.mkdir(parents=True, exist_ok=True)

    final_masks = prepare_mask_images(mask_frame_paths, generated_frame_paths, settings)
    frames_manifest: list[dict[str, Any]] = []
    for index, (source_path, generated_path, final_mask, mask_path) in enumerate(zip(source_frame_paths, generated_frame_paths, final_masks, mask_frame_paths)):
        source_rgb = Image.open(source_path).convert("RGB")
        generated_rgb = Image.open(generated_path).convert("RGB")
        generated_rgb.save(generated_dir / f"frame_{index:04d}.png", format="PNG")
        cleaned_rgb, keep_mask = compose_clean_frame(
            source_rgb=source_rgb,
            generated_rgb=generated_rgb,
            final_mask=final_mask,
            restore_strength=settings.restore_strength,
        )
        overlay_rgb = outline_mask(generated_rgb, keep_mask)
        checker_rgb = checker_outside_mask(generated_rgb, keep_mask)
        overlay_rgb.save(overlay_dir / f"frame_{index:04d}.png", format="PNG")
        checker_rgb.save(checker_dir / f"frame_{index:04d}.png", format="PNG")
        cleaned_rgb.save(cleaned_dir / f"frame_{index:04d}.png", format="PNG")
        frame_metrics = diagnostics_by_frame.get(index) or {}
        frames_manifest.append(
            {
                "frameIndexLocal": index,
                "maskKey": str(mask_path),
                "coveragePct": frame_metrics.get("coveragePct"),
                "suspicionScore": frame_metrics.get("suspicionScore"),
                "suggestedCorrection": index in suggested_frames,
            }
        )

    generated_video_path = workdir / "preview_generated.mp4"
    overlay_video_path = workdir / "preview_overlay.mp4"
    checker_video_path = workdir / "preview_checker.mp4"
    cleaned_video_path = workdir / "preview_cleaned.mp4"
    encode_png_sequence_to_mp4(generated_dir, generated_video_path, fps_num, fps_den)
    encode_png_sequence_to_mp4(overlay_dir, overlay_video_path, fps_num, fps_den)
    encode_png_sequence_to_mp4(checker_dir, checker_video_path, fps_num, fps_den)
    encode_png_sequence_to_mp4(cleaned_dir, cleaned_video_path, fps_num, fps_den)
    return {
        "frames": frames_manifest,
        "generatedDir": generated_dir,
        "overlayDir": overlay_dir,
        "checkerDir": checker_dir,
        "cleanedDir": cleaned_dir,
        "generatedVideoPath": generated_video_path,
        "overlayVideoPath": overlay_video_path,
        "checkerVideoPath": checker_video_path,
        "cleanedVideoPath": cleaned_video_path,
    }
