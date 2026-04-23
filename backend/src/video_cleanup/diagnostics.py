from __future__ import annotations

from io import BytesIO
from typing import Any

from PIL import Image, ImageChops, ImageStat


def _load_mask(mask_bytes: bytes, size: tuple[int, int]) -> Image.Image:
    mask = Image.open(BytesIO(mask_bytes)).convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.Resampling.BILINEAR)
    return mask.point(lambda value: 255 if value >= 127 else 0)


def _mask_pixels(mask: Image.Image) -> int:
    histogram = mask.histogram()
    return int(histogram[255]) if len(histogram) >= 256 else 0


def _mask_centroid(mask: Image.Image) -> tuple[float, float] | None:
    width, height = mask.size
    pixels = mask.load()
    total = 0
    x_sum = 0
    y_sum = 0
    for y in range(height):
        for x in range(width):
            if pixels[x, y] >= 127:
                total += 1
                x_sum += x
                y_sum += y
    if total <= 0:
        return None
    return x_sum / total, y_sum / total


def _mask_perimeter(mask: Image.Image) -> int:
    width, height = mask.size
    pixels = mask.load()
    perimeter = 0
    for y in range(height):
        for x in range(width):
            if pixels[x, y] < 127:
                continue
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or ny < 0 or nx >= width or ny >= height or pixels[nx, ny] < 127:
                    perimeter += 1
                    break
    return perimeter


def diff_outside_mask_score(source_rgb: Image.Image, generated_rgb: Image.Image, mask: Image.Image) -> float:
    inverted = ImageChops.invert(mask.convert("L"))
    diff = ImageChops.difference(source_rgb.convert("RGB"), generated_rgb.convert("RGB")).convert("L")
    outside = ImageChops.multiply(diff, inverted)
    outside_pixels = max(1, _mask_pixels(inverted.point(lambda value: 255 if value >= 127 else 0)))
    return float(ImageStat.Stat(outside).sum[0]) / (outside_pixels * 255.0)


def compute_frame_diagnostic(
    *,
    frame_index_local: int,
    mask_bytes: bytes,
    source_bytes: bytes,
    generated_bytes: bytes,
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    generated = Image.open(BytesIO(generated_bytes)).convert("RGB")
    source = Image.open(BytesIO(source_bytes)).convert("RGB")
    mask = _load_mask(mask_bytes, generated.size)
    width, height = generated.size
    coverage_pct = (_mask_pixels(mask) * 100.0) / max(1, width * height)
    centroid = _mask_centroid(mask)
    perimeter = _mask_perimeter(mask)
    outside_diff = diff_outside_mask_score(source, generated, mask)

    area_delta = 0.0
    centroid_jump = 0.0
    perimeter_delta = 0.0
    if isinstance(previous, dict):
        area_delta = abs(float(previous.get("coveragePct", 0.0)) - coverage_pct) / 100.0
        previous_centroid = previous.get("centroid")
        if isinstance(previous_centroid, dict) and centroid is not None:
            centroid_jump = (
                ((centroid[0] - float(previous_centroid.get("x", centroid[0]))) ** 2)
                + ((centroid[1] - float(previous_centroid.get("y", centroid[1]))) ** 2)
            ) ** 0.5
        perimeter_delta = abs(float(previous.get("boundaryLengthPx", perimeter)) - float(perimeter))

    suspicion = min(
        1.0,
        (area_delta * 1.8)
        + min(1.0, centroid_jump / max(8.0, width * 0.02))
        + min(1.0, perimeter_delta / max(50.0, perimeter or 1))
        + min(1.0, outside_diff * 1.2),
    )
    return {
        "frameIndexLocal": frame_index_local,
        "coveragePct": round(coverage_pct, 4),
        "centroid": {"x": round(centroid[0], 3), "y": round(centroid[1], 3)} if centroid is not None else None,
        "boundaryLengthPx": perimeter,
        "areaDeltaPct": round(area_delta * 100.0, 4),
        "centroidJumpPx": round(centroid_jump, 4),
        "boundaryDeltaPx": round(perimeter_delta, 4),
        "outsideMaskDiff": round(outside_diff, 6),
        "suspicionScore": round(suspicion, 6),
    }


def summarize_diagnostics(frames: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    if not frames:
        return {
            "coverageSummary": {
                "meanCoveragePct": 0.0,
                "minCoveragePct": 0.0,
                "maxCoveragePct": 0.0,
                "suspiciousFrames": [],
            },
            "suggestedCorrectionFrames": [],
        }
    coverages = [float(item.get("coveragePct", 0.0)) for item in frames]
    suspicious = [int(item["frameIndexLocal"]) for item in frames if float(item.get("suspicionScore", 0.0)) >= threshold]
    ranked = sorted(frames, key=lambda item: float(item.get("suspicionScore", 0.0)), reverse=True)
    return {
        "coverageSummary": {
            "meanCoveragePct": round(sum(coverages) / max(1, len(coverages)), 4),
            "minCoveragePct": round(min(coverages), 4),
            "maxCoveragePct": round(max(coverages), 4),
            "suspiciousFrames": suspicious,
        },
        "suggestedCorrectionFrames": [int(item["frameIndexLocal"]) for item in ranked[: min(12, len(ranked))] if float(item.get("suspicionScore", 0.0)) >= threshold * 0.65],
    }
