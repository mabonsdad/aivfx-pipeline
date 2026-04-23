from __future__ import annotations

from dataclasses import dataclass
from typing import Any


DEFAULT_SETTINGS: dict[str, Any] = {
    "maskFeatherPx": 6,
    "maskHardness": 0.7,
    "restoreStrength": 1.0,
    "maskDilatePx": 0,
    "maskErodePx": 0,
    "temporalSmoothingRadius": 1,
    "autoSuggestCorrections": True,
    "suspiciousFrameThreshold": 0.12,
    "previewBurnInMask": True,
    "previewCheckerOutsideMask": False,
    "clampToSegmentBounds": True,
    "trackingDensity": "standard",
}


@dataclass
class VideoCleanupSettings:
    mask_feather_px: int = 6
    mask_hardness: float = 0.7
    restore_strength: float = 1.0
    mask_dilate_px: int = 0
    mask_erode_px: int = 0
    temporal_smoothing_radius: int = 1
    auto_suggest_corrections: bool = True
    suspicious_frame_threshold: float = 0.12
    preview_burn_in_mask: bool = True
    preview_checker_outside_mask: bool = False
    clamp_to_segment_bounds: bool = True
    tracking_density: str = "standard"

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "VideoCleanupSettings":
        raw = {**DEFAULT_SETTINGS, **(payload or {})}
        return cls(
            mask_feather_px=max(0, min(48, int(raw.get("maskFeatherPx", 6)))),
            mask_hardness=max(0.0, min(1.0, float(raw.get("maskHardness", 0.7)))),
            restore_strength=max(0.0, min(1.0, float(raw.get("restoreStrength", 1.0)))),
            mask_dilate_px=max(0, min(64, int(raw.get("maskDilatePx", 0)))),
            mask_erode_px=max(0, min(64, int(raw.get("maskErodePx", 0)))),
            temporal_smoothing_radius=max(0, min(3, int(raw.get("temporalSmoothingRadius", 1)))),
            auto_suggest_corrections=bool(raw.get("autoSuggestCorrections", True)),
            suspicious_frame_threshold=max(0.01, min(1.0, float(raw.get("suspiciousFrameThreshold", 0.12)))),
            preview_burn_in_mask=bool(raw.get("previewBurnInMask", True)),
            preview_checker_outside_mask=bool(raw.get("previewCheckerOutsideMask", False)),
            clamp_to_segment_bounds=bool(raw.get("clampToSegmentBounds", True)),
            tracking_density=(
                str(raw.get("trackingDensity") or "standard")
                if str(raw.get("trackingDensity") or "standard") in {"standard", "high_motion", "frame_by_frame"}
                else "standard"
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "maskFeatherPx": self.mask_feather_px,
            "maskHardness": self.mask_hardness,
            "restoreStrength": self.restore_strength,
            "maskDilatePx": self.mask_dilate_px,
            "maskErodePx": self.mask_erode_px,
            "temporalSmoothingRadius": self.temporal_smoothing_radius,
            "autoSuggestCorrections": self.auto_suggest_corrections,
            "suspiciousFrameThreshold": self.suspicious_frame_threshold,
            "previewBurnInMask": self.preview_burn_in_mask,
            "previewCheckerOutsideMask": self.preview_checker_outside_mask,
            "clampToSegmentBounds": self.clamp_to_segment_bounds,
            "trackingDensity": self.tracking_density,
        }
