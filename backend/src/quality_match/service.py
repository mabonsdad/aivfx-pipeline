from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any

from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat


DEFAULT_SETTINGS: dict[str, Any] = {
    "diffThreshold": 0.12,
    "minRegionAreaPct": 0.0005,
    "featherWidthPx": 6,
    "boundaryProtectionWidthPx": 8,
    "edgeSuppression": "medium",
    "useSeamlessCloneFallback": True,
    "autoDetectEditRegion": True,
}


@dataclass
class QualityMatchSettings:
    diff_threshold: float = 0.12
    min_region_area_pct: float = 0.0005
    feather_width_px: int = 6
    boundary_protection_width_px: int = 8
    edge_suppression: str = "medium"
    use_seamless_clone_fallback: bool = True
    auto_detect_edit_region: bool = True

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "QualityMatchSettings":
        raw = {**DEFAULT_SETTINGS, **(payload or {})}
        edge = str(raw.get("edgeSuppression", "medium")).lower().strip()
        if edge not in {"off", "low", "medium", "high"}:
            edge = "medium"
        return cls(
            diff_threshold=max(0.01, min(0.99, float(raw.get("diffThreshold", 0.12)))),
            min_region_area_pct=max(0.0, min(0.1, float(raw.get("minRegionAreaPct", 0.0005)))),
            feather_width_px=max(0, min(64, int(raw.get("featherWidthPx", 6)))),
            boundary_protection_width_px=max(0, min(128, int(raw.get("boundaryProtectionWidthPx", 8)))),
            edge_suppression=edge,
            use_seamless_clone_fallback=bool(raw.get("useSeamlessCloneFallback", True)),
            auto_detect_edit_region=bool(raw.get("autoDetectEditRegion", True)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "diffThreshold": self.diff_threshold,
            "minRegionAreaPct": self.min_region_area_pct,
            "featherWidthPx": self.feather_width_px,
            "boundaryProtectionWidthPx": self.boundary_protection_width_px,
            "edgeSuppression": self.edge_suppression,
            "useSeamlessCloneFallback": self.use_seamless_clone_fallback,
            "autoDetectEditRegion": self.auto_detect_edit_region,
        }


def _load_rgb(image_bytes: bytes) -> Image.Image:
    return ImageOps.exif_transpose(Image.open(BytesIO(image_bytes))).convert("RGB")


def _load_mask(mask_bytes: bytes | None, size: tuple[int, int]) -> Image.Image | None:
    if not mask_bytes:
        return None
    mask = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
    if mask.size != size:
        mask = ImageOps.contain(mask, size, Image.Resampling.BILINEAR)
        fitted = Image.new("L", size, 0)
        fitted.paste(mask, ((size[0] - mask.size[0]) // 2, (size[1] - mask.size[1]) // 2))
        mask = fitted
    return mask.point(lambda px: 255 if px >= 127 else 0)


def _fit_generated(generated: Image.Image, size: tuple[int, int]) -> Image.Image:
    if generated.size == size:
        return generated
    fitted = ImageOps.contain(generated, size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (0, 0, 0))
    canvas.paste(fitted, ((size[0] - fitted.size[0]) // 2, (size[1] - fitted.size[1]) // 2))
    return canvas


def _maybe_align_with_ecc(
    original: Image.Image,
    generated: Image.Image,
    original_mask: Image.Image | None,
) -> tuple[Image.Image, dict[str, Any]]:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        return generated, {"method": "none", "reason": "opencv_unavailable"}

    try:
        orig_np = np.array(original.convert("RGB"))
        gen_np = np.array(generated.convert("RGB"))
        orig_gray = cv2.cvtColor(orig_np, cv2.COLOR_RGB2GRAY).astype("float32") / 255.0
        gen_gray = cv2.cvtColor(gen_np, cv2.COLOR_RGB2GRAY).astype("float32") / 255.0

        warp_matrix = np.eye(2, 3, dtype="float32")
        criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-6)
        ecc_mask = None
        if original_mask is not None:
            mask_np = np.array(original_mask.convert("L"))
            # Prioritize stable background for registration.
            ecc_mask = cv2.bitwise_not((mask_np >= 127).astype("uint8") * 255)
        cc, warp_matrix = cv2.findTransformECC(
            orig_gray,
            gen_gray,
            warp_matrix,
            cv2.MOTION_AFFINE,
            criteria,
            inputMask=ecc_mask,
            gaussFiltSize=5,
        )
        aligned_np = cv2.warpAffine(
            gen_np,
            warp_matrix,
            (orig_np.shape[1], orig_np.shape[0]),
            flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REPLICATE,
        )
        return Image.fromarray(aligned_np, mode="RGB"), {
            "method": "opencv_ecc_affine",
            "ecc": float(cc),
            "warpMatrix": [[float(value) for value in row] for row in warp_matrix.tolist()],
        }
    except Exception as exc:  # pragma: no cover - safety fallback
        return generated, {"method": "none", "reason": f"opencv_ecc_failed:{exc}"}


def _threshold_change_mask(diff_gray: Image.Image, threshold_norm: float) -> Image.Image:
    threshold_u8 = max(0, min(255, int(round(threshold_norm * 255.0))))
    binary = diff_gray.point(lambda value: 255 if value >= threshold_u8 else 0)
    # Basic speckle cleanup and hole fill.
    binary = binary.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    binary = binary.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    return binary.point(lambda value: 255 if value >= 127 else 0)


def _connected_components_filter(
    binary_mask: Image.Image,
    diff_gray: Image.Image,
    *,
    min_area: int,
    boundary_width: int,
    edge_suppression: str,
) -> Image.Image:
    width, height = binary_mask.size
    values = [1 if px >= 127 else 0 for px in binary_mask.getdata()]
    diff_values = list(diff_gray.getdata())
    visited = bytearray(width * height)
    keep = bytearray(width * height)

    edge_penalty = {
        "off": 0.0,
        "low": 0.02,
        "medium": 0.06,
        "high": 0.1,
    }.get(edge_suppression, 0.06)

    def neighbors(index: int) -> list[int]:
        x = index % width
        y = index // width
        out: list[int] = []
        if x > 0:
            out.append(index - 1)
        if x < width - 1:
            out.append(index + 1)
        if y > 0:
            out.append(index - width)
        if y < height - 1:
            out.append(index + width)
        return out

    for index, value in enumerate(values):
        if not value or visited[index]:
            continue
        stack = [index]
        component: list[int] = []
        visited[index] = 1
        touches_edge = False
        diff_sum = 0
        while stack:
            current = stack.pop()
            component.append(current)
            x = current % width
            y = current // width
            if x < boundary_width or x >= width - boundary_width or y < boundary_width or y >= height - boundary_width:
                touches_edge = True
            diff_sum += diff_values[current]
            for nxt in neighbors(current):
                if values[nxt] and not visited[nxt]:
                    visited[nxt] = 1
                    stack.append(nxt)

        area = len(component)
        if area < min_area:
            continue
        mean_diff = diff_sum / max(1, area) / 255.0
        threshold = 0.12 + edge_penalty
        if touches_edge and mean_diff < threshold:
            continue
        for pixel_idx in component:
            keep[pixel_idx] = 255

    return Image.frombytes("L", (width, height), bytes(keep)).point(lambda value: 255 if value >= 127 else 0)


def _count_pixels(mask: Image.Image) -> int:
    return int(mask.point(lambda value: 255 if value >= 127 else 0).histogram()[255])


def _edge_band(mask: Image.Image, width_px: int) -> Image.Image:
    if width_px <= 0:
        return Image.new("L", mask.size, 0)
    kernel = max(3, (width_px * 2) + 1)
    dilated = mask.filter(ImageFilter.MaxFilter(kernel))
    eroded = mask.filter(ImageFilter.MinFilter(kernel))
    return ImageChops.subtract(dilated, eroded).point(lambda value: 255 if value >= 127 else 0)


def _compute_metrics(
    original: Image.Image,
    candidate: Image.Image,
    *,
    region_mask: Image.Image | None,
    threshold_norm: float,
    boundary_ring_px: int,
) -> dict[str, Any]:
    diff_gray = ImageChops.difference(original.convert("RGB"), candidate.convert("RGB")).convert("L")
    binary = _threshold_change_mask(diff_gray, threshold_norm)
    total_pixels = max(1, diff_gray.width * diff_gray.height)
    changed_pixels = _count_pixels(binary)
    metrics: dict[str, Any] = {
        "changedPctTotal": round((changed_pixels * 100.0) / total_pixels, 4),
        "meanDiffTotal": round(float(ImageStat.Stat(diff_gray).mean[0]) / 255.0, 6),
    }
    if region_mask is None:
        return metrics

    mask_bin = region_mask.point(lambda value: 255 if value >= 127 else 0)
    outside = ImageChops.invert(mask_bin)
    inside_pixels = max(1, _count_pixels(mask_bin))
    outside_pixels = max(1, _count_pixels(outside))
    inside_change = _count_pixels(ImageChops.multiply(binary, mask_bin))
    outside_change = _count_pixels(ImageChops.multiply(binary, outside))
    ring_kernel = max(3, (boundary_ring_px * 2) + 1)
    dilated = mask_bin.filter(ImageFilter.MaxFilter(ring_kernel))
    ring = ImageChops.subtract(dilated, mask_bin).point(lambda value: 255 if value >= 127 else 0)
    ring_pixels = max(1, _count_pixels(ring))
    ring_change = _count_pixels(ImageChops.multiply(binary, ring))

    metrics.update(
        {
            "changedPctInsideMask": round((inside_change * 100.0) / inside_pixels, 4),
            "changedPctOutsideMask": round((outside_change * 100.0) / outside_pixels, 4),
            "outsideLeakagePct": round((outside_change * 100.0) / outside_pixels, 4),
            "boundarySpillPct": round((ring_change * 100.0) / ring_pixels, 4),
        }
    )
    return metrics


def _colorize_heatmap(diff_gray: Image.Image) -> Image.Image:
    return ImageOps.colorize(diff_gray.convert("L"), black="#1e4fba", mid="#ffd84d", white="#e22626")


def _encode_png(image: Image.Image) -> bytes:
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _build_restoration_map(
    *,
    keep_mask: Image.Image,
    uncertain_band: Image.Image,
    leakage_mask: Image.Image | None,
) -> Image.Image:
    base = Image.new("RGBA", keep_mask.size, (32, 136, 255, 185))  # Restore original (blue)
    keep = Image.new("RGBA", keep_mask.size, (44, 190, 99, 185))  # Keep generated (green)
    base.paste(keep, (0, 0), keep_mask)
    if uncertain_band:
        amber = Image.new("RGBA", keep_mask.size, (255, 180, 45, 210))
        base.paste(amber, (0, 0), uncertain_band)
    if leakage_mask is not None:
        leakage = leakage_mask.point(lambda value: 255 if value >= 127 else 0)
        red = Image.new("RGBA", keep_mask.size, (230, 54, 46, 220))
        base.paste(red, (0, 0), leakage)
    return base


def _seam_score(original: Image.Image, merged: Image.Image, keep_mask: Image.Image, width_px: int) -> float:
    band = _edge_band(keep_mask, max(1, width_px))
    band_pixels = max(1, _count_pixels(band))
    diff = ImageChops.difference(original.convert("RGB"), merged.convert("RGB")).convert("L")
    band_diff = ImageChops.multiply(diff, band)
    return float(ImageStat.Stat(band_diff).sum[0]) / (band_pixels * 255.0)


def _try_seamless_clone(
    *,
    original: Image.Image,
    generated_aligned: Image.Image,
    keep_mask: Image.Image,
) -> Image.Image:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        return generated_aligned

    try:
        mask_np = (np.array(keep_mask.convert("L")) >= 127).astype("uint8") * 255
        if int(mask_np.sum()) <= 0:
            return generated_aligned
        ys, xs = np.where(mask_np > 0)
        center = (int((xs.min() + xs.max()) / 2), int((ys.min() + ys.max()) / 2))
        src = cv2.cvtColor(np.array(generated_aligned.convert("RGB")), cv2.COLOR_RGB2BGR)
        dst = cv2.cvtColor(np.array(original.convert("RGB")), cv2.COLOR_RGB2BGR)
        blended = cv2.seamlessClone(src, dst, mask_np, center, cv2.NORMAL_CLONE)
        return Image.fromarray(cv2.cvtColor(blended, cv2.COLOR_BGR2RGB), mode="RGB")
    except Exception:
        return generated_aligned


def analyse_quality_match(
    *,
    original_bytes: bytes,
    generated_bytes: bytes,
    settings: QualityMatchSettings,
    original_mask_bytes: bytes | None = None,
    override_mask_bytes: bytes | None = None,
) -> dict[str, Any]:
    original = _load_rgb(original_bytes)
    generated = _fit_generated(_load_rgb(generated_bytes), original.size)
    original_mask = _load_mask(original_mask_bytes, original.size)
    override_mask = _load_mask(override_mask_bytes, original.size)

    aligned_generated, alignment_info = _maybe_align_with_ecc(original, generated, original_mask)
    diff_gray = ImageChops.difference(original.convert("RGB"), aligned_generated.convert("RGB")).convert("L")
    raw_binary = _threshold_change_mask(diff_gray, settings.diff_threshold)

    min_area = max(8, int(round(original.width * original.height * settings.min_region_area_pct)))
    meaningful_change = _connected_components_filter(
        raw_binary,
        diff_gray,
        min_area=min_area,
        boundary_width=settings.boundary_protection_width_px,
        edge_suppression=settings.edge_suppression,
    )

    warnings: list[str] = []
    effective_mask = override_mask if override_mask is not None else original_mask
    if effective_mask is not None:
        proposed_merge_mask = ImageChops.multiply(meaningful_change, effective_mask)
        leakage_mask = ImageChops.multiply(meaningful_change, ImageChops.invert(effective_mask))
    else:
        proposed_merge_mask = meaningful_change
        leakage_mask = None
        warnings.append("No source mask provided; proposed region derived from diff analysis.")

    if settings.auto_detect_edit_region and effective_mask is None:
        edge = settings.boundary_protection_width_px
        if edge > 0:
            safe = Image.new("L", original.size, 255)
            draw = Image.new("L", original.size, 0)
            draw.paste(255, (edge, edge, max(edge + 1, original.width - edge), max(edge + 1, original.height - edge)))
            safe = ImageChops.multiply(safe, draw)
            proposed_merge_mask = ImageChops.multiply(proposed_merge_mask, safe)

    proposed_merge_mask = proposed_merge_mask.point(lambda value: 255 if value >= 127 else 0)
    uncertain_band = _edge_band(proposed_merge_mask, max(1, settings.feather_width_px))

    alpha_mask = proposed_merge_mask
    if settings.feather_width_px > 0:
        alpha_mask = alpha_mask.filter(ImageFilter.GaussianBlur(radius=max(0.5, settings.feather_width_px / 2.0)))
    preview = Image.composite(aligned_generated, original, alpha_mask.convert("L"))

    seam_score_value = _seam_score(original, preview, proposed_merge_mask, max(2, settings.feather_width_px or 2))
    used_seamless = False
    if settings.use_seamless_clone_fallback and seam_score_value > 0.12:
        candidate = _try_seamless_clone(original=original, generated_aligned=aligned_generated, keep_mask=proposed_merge_mask)
        if candidate is not aligned_generated:
            preview = Image.composite(candidate, original, alpha_mask.convert("L"))
            used_seamless = True
            warnings.append("Seamless blend fallback was used due to boundary seam risk.")

    if leakage_mask is not None and _count_pixels(leakage_mask) > 0:
        warnings.append("Outside-mask leakage detected and suppressed in restoration map.")

    metrics_before = _compute_metrics(
        original,
        aligned_generated,
        region_mask=effective_mask or proposed_merge_mask,
        threshold_norm=settings.diff_threshold,
        boundary_ring_px=settings.boundary_protection_width_px,
    )
    metrics_preview = _compute_metrics(
        original,
        preview,
        region_mask=effective_mask or proposed_merge_mask,
        threshold_norm=settings.diff_threshold,
        boundary_ring_px=settings.boundary_protection_width_px,
    )

    coverage = (_count_pixels(proposed_merge_mask) * 100.0) / max(1, original.width * original.height)
    restoration_map = _build_restoration_map(
        keep_mask=proposed_merge_mask,
        uncertain_band=uncertain_band,
        leakage_mask=leakage_mask,
    )

    heatmap = _colorize_heatmap(diff_gray)
    quality_report = {
        "settings": settings.to_dict(),
        "alignment": alignment_info,
        "warnings": warnings,
        "metricsBefore": metrics_before,
        "metricsPreview": metrics_preview,
        "proposedGeneratedCoveragePct": round(coverage, 4),
        "proposedOriginalRestorePct": round(100.0 - coverage, 4),
        "usedSeamlessFallback": used_seamless,
    }

    return {
        "settings": settings.to_dict(),
        "warnings": warnings,
        "originalMaskProvided": original_mask is not None,
        "userMaskProvided": override_mask is not None,
        "metrics": {
            "changedPctBefore": metrics_before.get("changedPctTotal"),
            "changedPctPreview": metrics_preview.get("changedPctTotal"),
            "outsideLeakageBefore": metrics_before.get("outsideLeakagePct"),
            "outsideLeakagePreview": metrics_preview.get("outsideLeakagePct"),
            "boundarySpillBefore": metrics_before.get("boundarySpillPct"),
            "boundarySpillPreview": metrics_preview.get("boundarySpillPct"),
            "proposedGeneratedCoveragePct": round(coverage, 4),
            "proposedOriginalRestorePct": round(100.0 - coverage, 4),
        },
        "report": quality_report,
        "artifacts": {
            "alignedGenerated": _encode_png(aligned_generated),
            "diffHeatmap": _encode_png(heatmap),
            "binaryChangeMask": _encode_png(raw_binary.convert("L")),
            "proposedMergeMask": _encode_png(proposed_merge_mask.convert("L")),
            "restorationMap": _encode_png(restoration_map.convert("RGBA")),
            "preview": _encode_png(preview),
        },
    }


def apply_quality_match(
    *,
    original_bytes: bytes,
    generated_bytes: bytes,
    final_mask_bytes: bytes,
    settings: QualityMatchSettings,
    original_mask_bytes: bytes | None = None,
) -> dict[str, Any]:
    analysis = analyse_quality_match(
        original_bytes=original_bytes,
        generated_bytes=generated_bytes,
        settings=settings,
        original_mask_bytes=original_mask_bytes,
        override_mask_bytes=final_mask_bytes,
    )
    original = _load_rgb(original_bytes)
    aligned_generated = _load_rgb(analysis["artifacts"]["alignedGenerated"])
    final_mask = _load_mask(final_mask_bytes, original.size)
    if final_mask is None:
        raise ValueError("Final mask is required")

    alpha_mask = final_mask
    if settings.feather_width_px > 0:
        alpha_mask = alpha_mask.filter(ImageFilter.GaussianBlur(radius=max(0.5, settings.feather_width_px / 2.0)))
    merged = Image.composite(aligned_generated, original, alpha_mask.convert("L"))

    seam_score_value = _seam_score(original, merged, final_mask, max(2, settings.feather_width_px or 2))
    used_seamless = False
    if settings.use_seamless_clone_fallback and seam_score_value > 0.12:
        candidate = _try_seamless_clone(original=original, generated_aligned=aligned_generated, keep_mask=final_mask)
        if candidate is not aligned_generated:
            merged = Image.composite(candidate, original, alpha_mask.convert("L"))
            used_seamless = True

    metrics_before = analysis["metrics"]
    metrics_after = _compute_metrics(
        original,
        merged,
        region_mask=_load_mask(original_mask_bytes, original.size) or final_mask,
        threshold_norm=settings.diff_threshold,
        boundary_ring_px=settings.boundary_protection_width_px,
    )
    report = {
        "settings": settings.to_dict(),
        "metricsBefore": metrics_before,
        "metricsAfter": metrics_after,
        "usedSeamlessFallback": used_seamless,
    }
    return {
        "settings": settings.to_dict(),
        "metricsBefore": metrics_before,
        "metricsAfter": {
            "changedPctAfter": metrics_after.get("changedPctTotal"),
            "outsideLeakageAfter": metrics_after.get("outsideLeakagePct"),
            "boundarySpillAfter": metrics_after.get("boundarySpillPct"),
            "raw": metrics_after,
        },
        "artifacts": {
            "final": _encode_png(merged),
            "finalMask": _encode_png(final_mask.convert("L")),
            "reportJson": report,
        },
    }

