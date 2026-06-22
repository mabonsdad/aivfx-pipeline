from __future__ import annotations

import math
from copy import deepcopy
from typing import Any

from src.core.pricing_admin import (
    ADMIN_PRICING_CONFIG_KEY,
    find_pricing_entry,
    normalize_pricing_admin_config_for_read,
)


def load_pricing_admin_config(store) -> dict[str, Any]:
    return normalize_pricing_admin_config_for_read(store.get_json(ADMIN_PRICING_CONFIG_KEY))


def resolve_pricing_entry(
    config: dict[str, Any],
    *,
    pricing_id: str | None = None,
    app_model_id: str | None = None,
    provider_model: str | None = None,
) -> dict[str, Any] | None:
    entry = find_pricing_entry(
        config,
        pricing_id=pricing_id,
        app_model_id=app_model_id,
        provider_model=provider_model,
    )
    return deepcopy(entry) if isinstance(entry, dict) else None


def resolve_openai_prompt_wizard_pricing_entry(config: dict[str, Any], model: str) -> dict[str, Any] | None:
    return resolve_pricing_entry(
        config,
        pricing_id=f"openai.{model}.responses",
        app_model_id=model,
        provider_model=model,
    )


def resolve_openai_prompt_wizard_rates(config: dict[str, Any], model: str) -> dict[str, float] | None:
    entry = resolve_openai_prompt_wizard_pricing_entry(config, model)
    if not isinstance(entry, dict):
        return None
    rates = entry.get("rates")
    if not isinstance(rates, dict):
        return None
    try:
        input_price = rates.get("input_per_1m_tokens_usd")
        output_price = rates.get("output_per_1m_tokens_usd")
        if input_price is None or output_price is None:
            return None
        return {"input": float(input_price), "output": float(output_price)}
    except (TypeError, ValueError):
        return None


def _clean_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _normalize_tokens_usage(usage: dict[str, Any] | None) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    if not isinstance(usage, dict):
        return normalized
    input_tokens = int(usage.get("input_tokens") or usage.get("inputTokens") or usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or usage.get("outputTokens") or usage.get("completion_tokens") or 0)
    if input_tokens > 0:
        normalized["inputTokens"] = input_tokens
    if output_tokens > 0:
        normalized["outputTokens"] = output_tokens
    cached_input_tokens = int(usage.get("cached_input_tokens") or usage.get("cachedInputTokens") or 0)
    if cached_input_tokens > 0:
        normalized["cachedInputTokens"] = cached_input_tokens
    return normalized


def _token_cost_from_rates(rates: dict[str, Any], usage: dict[str, Any]) -> float | None:
    input_tokens = int(usage.get("inputTokens") or 0)
    output_tokens = int(usage.get("outputTokens") or 0)
    cached_input_tokens = int(usage.get("cachedInputTokens") or 0)

    direct_input_rate = _clean_number(rates.get("input_per_1m_tokens_usd"))
    direct_output_rate = _clean_number(rates.get("output_per_1m_tokens_usd"))
    direct_cached_rate = _clean_number(rates.get("cached_input_per_1m_tokens_usd"))
    if direct_input_rate is not None or direct_output_rate is not None or direct_cached_rate is not None:
        total = 0.0
        if direct_input_rate is not None and input_tokens > 0:
            total += (input_tokens / 1_000_000.0) * direct_input_rate
        if direct_output_rate is not None and output_tokens > 0:
            total += (output_tokens / 1_000_000.0) * direct_output_rate
        if direct_cached_rate is not None and cached_input_tokens > 0:
            total += (cached_input_tokens / 1_000_000.0) * direct_cached_rate
        return total if total > 0 else None

    text_input_rate = _clean_number(rates.get("text_input_per_1m_tokens_usd"))
    text_output_rate = _clean_number(rates.get("text_output_per_1m_tokens_usd"))
    text_cached_rate = _clean_number(rates.get("text_cached_input_per_1m_tokens_usd"))
    if text_input_rate is not None or text_output_rate is not None or text_cached_rate is not None:
        total = 0.0
        if text_input_rate is not None and input_tokens > 0:
            total += (input_tokens / 1_000_000.0) * text_input_rate
        if text_output_rate is not None and output_tokens > 0:
            total += (output_tokens / 1_000_000.0) * text_output_rate
        if text_cached_rate is not None and cached_input_tokens > 0:
            total += (cached_input_tokens / 1_000_000.0) * text_cached_rate
        return total if total > 0 else None
    return None


def _normalize_resolution_label(label: str | None) -> str | None:
    value = str(label or "").strip().lower()
    return value or None


def _infer_resolution_label(width: int | None, height: int | None) -> str | None:
    if not width or not height:
        return None
    short_edge = min(int(width), int(height))
    if short_edge >= 1080:
        return "1080p"
    if short_edge >= 720:
        return "720p"
    if short_edge >= 480:
        return "480p"
    return None


def estimate_cost_from_pricing_entry(
    pricing_entry: dict[str, Any] | None,
    *,
    usage: dict[str, Any] | None = None,
    duration_sec: float | None = None,
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    resolution_label: str | None = None,
    image_count: int = 1,
    operation: str | None = None,
    reference_count: int = 0,
) -> dict[str, Any]:
    normalized_usage = _normalize_tokens_usage(usage)
    if duration_sec is not None:
        normalized_usage["durationSec"] = round(float(duration_sec), 4)
    if width and height:
        normalized_usage["width"] = int(width)
        normalized_usage["height"] = int(height)
    if fps is not None:
        normalized_usage["fps"] = round(float(fps), 4)
    normalized_resolution_label = _normalize_resolution_label(resolution_label) or _infer_resolution_label(width, height)
    if normalized_resolution_label:
        normalized_usage["resolutionLabel"] = normalized_resolution_label
    if reference_count > 0:
        normalized_usage["referenceCount"] = int(reference_count)
    if image_count > 1:
        normalized_usage["imageCount"] = int(image_count)
    if operation:
        normalized_usage["operation"] = str(operation)

    if not isinstance(pricing_entry, dict):
        return {
            "estimatedCostUsd": _clean_number((usage or {}).get("estimated_cost_usd") or (usage or {}).get("estimatedCostUsd")),
            "estimateQuality": "fallback_usage" if usage else "unpriced",
            "usage": normalized_usage,
        }

    rates = pricing_entry.get("rates")
    if not isinstance(rates, dict):
        return {
            "estimatedCostUsd": None,
            "estimateQuality": "unpriced",
            "usage": normalized_usage,
        }

    billing_unit = str(pricing_entry.get("billingUnit") or "").strip()

    token_cost = _token_cost_from_rates(rates, normalized_usage)
    if token_cost is not None:
        return {
            "estimatedCostUsd": round(token_cost, 6),
            "estimateQuality": "measured_tokens",
            "usage": normalized_usage,
        }

    if billing_unit == "mixed":
        flat_image_rate = _clean_number(rates.get("image_output_per_image_1024_usd"))
        if flat_image_rate is not None:
            return {
                "estimatedCostUsd": round(flat_image_rate * max(1, image_count), 6),
                "estimateQuality": "heuristic_image_flat",
                "usage": normalized_usage,
            }

    if billing_unit == "per_image":
        reference_key = f"image_reference_{max(1, min(reference_count, 2))}_per_image_usd" if reference_count else None
        candidates = [
            reference_key,
            "image_edit_per_image_usd" if operation in {"full_edit", "patch_edit", "reference_generation"} else None,
            "text_to_image_per_image_usd" if operation in {"text_to_image", "reference_generation"} else None,
            "per_image_usd_1024_square",
            "per_image_usd_512_square",
            "per_image_usd",
        ]
        for candidate in candidates:
            if not candidate:
                continue
            rate = _clean_number(rates.get(candidate))
            if rate is None:
                continue
            return {
                "estimatedCostUsd": round(rate * max(1, image_count), 6),
                "estimateQuality": "heuristic_image_flat",
                "usage": normalized_usage,
            }

    if billing_unit == "per_second":
        duration = _clean_number(duration_sec)
        if duration is not None:
            per_second_rate = None
            if normalized_resolution_label:
                per_second_rate = _clean_number(rates.get(f"output_per_second_usd_{normalized_resolution_label}"))
            if per_second_rate is None:
                for key in ("output_per_second_usd_1080p", "output_per_second_usd_720p", "output_per_second_usd_480p", "output_per_second_usd"):
                    per_second_rate = _clean_number(rates.get(key))
                    if per_second_rate is not None:
                        break
            if per_second_rate is not None:
                return {
                    "estimatedCostUsd": round(duration * per_second_rate, 6),
                    "estimateQuality": "heuristic_seconds",
                    "usage": normalized_usage,
                }

    if billing_unit == "per_million_pixels":
        duration = _clean_number(duration_sec)
        output_fps = _clean_number(fps) or 24.0
        rate = _clean_number(rates.get("output_per_million_pixels_usd"))
        if duration is not None and width and height and rate is not None:
            total_output_pixels = float(width) * float(height) * output_fps * duration
            return {
                "estimatedCostUsd": round((total_output_pixels / 1_000_000.0) * rate, 6),
                "estimateQuality": "heuristic_total_pixels",
                "usage": normalized_usage,
            }

    fallback_usage_cost = _clean_number((usage or {}).get("estimated_cost_usd") or (usage or {}).get("estimatedCostUsd"))
    return {
        "estimatedCostUsd": fallback_usage_cost,
        "estimateQuality": "fallback_usage" if fallback_usage_cost is not None else "unavailable",
        "usage": normalized_usage,
    }


def build_usage_record(
    *,
    usage_record_id: str,
    now_iso: str,
    user_id: str,
    provider: str,
    provider_model: str | None,
    app_model_id: str | None,
    request_type: str,
    source: str,
    tool_origin: str,
    workflow_id: str | None = None,
    task_id: str | None = None,
    segment_id: str | None = None,
    project_id: str | None = None,
    request_id: str | None = None,
    asset_id: str | None = None,
    asset_kind: str | None = None,
    status: str = "complete",
    pricing_entry: dict[str, Any] | None = None,
    estimate: dict[str, Any] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    estimate = estimate if isinstance(estimate, dict) else {}
    record = {
        "usageRecordId": usage_record_id,
        "schemaVersion": 1,
        "createdAt": now_iso,
        "updatedAt": now_iso,
        "status": status,
        "source": source,
        "requestType": request_type,
        "toolOrigin": tool_origin,
        "userId": user_id,
        "taskId": task_id,
        "segmentId": segment_id,
        "workflowId": workflow_id,
        "projectId": project_id,
        "requestId": request_id,
        "assetId": asset_id,
        "assetKind": asset_kind,
        "provider": provider,
        "providerModel": provider_model,
        "appModelId": app_model_id,
        "pricingId": pricing_entry.get("pricingId") if isinstance(pricing_entry, dict) else None,
        "pricingSnapshot": deepcopy(pricing_entry) if isinstance(pricing_entry, dict) else None,
        "currency": "USD",
        "estimatedCostUsd": estimate.get("estimatedCostUsd"),
        "estimateQuality": estimate.get("estimateQuality"),
        "usage": deepcopy(estimate.get("usage") or {}),
        "notes": notes or None,
    }
    return record


def attach_usage_summary(target: dict[str, Any], usage_record: dict[str, Any]) -> dict[str, Any]:
    target["usageRecordId"] = usage_record.get("usageRecordId")
    target["pricingId"] = usage_record.get("pricingId")
    target["estimatedCostUsd"] = usage_record.get("estimatedCostUsd")
    target["usageSummary"] = {
        "usageRecordId": usage_record.get("usageRecordId"),
        "pricingId": usage_record.get("pricingId"),
        "estimatedCostUsd": usage_record.get("estimatedCostUsd"),
        "estimateQuality": usage_record.get("estimateQuality"),
        "usage": deepcopy(usage_record.get("usage") or {}),
    }
    return target
