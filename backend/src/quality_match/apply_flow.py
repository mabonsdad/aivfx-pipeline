from __future__ import annotations

import json
from typing import Any

from src.core.assets import AssetPaths, AssetStore
from src.core.ids import new_id
from src.core.store import now_iso
from src.quality_match.service import QualityMatchSettings, apply_quality_match


def _allocate_refined_variant_storage(frame: dict[str, Any], paths: AssetPaths, frame_id: str) -> tuple[str, str]:
    existing_output_keys = {
        str(item.get("outputKey"))
        for item in frame.get("variants", [])
        if isinstance(item, dict) and item.get("outputKey")
    }
    for _ in range(16):
        variant_id = new_id("var")
        output_key = paths.frame_variant(frame_id, variant_id)
        if output_key not in existing_output_keys:
            return variant_id, output_key
    raise RuntimeError("Unable to allocate unique refined variant storage key")


def create_refined_variant_from_upload(
    *,
    task: dict[str, Any],
    frame_id: str,
    source_variant_id: str,
    variant_id: str,
    output_key: str,
    uploaded_filename: str,
) -> dict[str, Any]:
    frame = task.get("frames", {}).get(frame_id)
    if not isinstance(frame, dict):
        raise RuntimeError("Frame not found")
    source_variant = next((item for item in frame.get("variants", []) if item.get("variantId") == source_variant_id), None)
    if not isinstance(source_variant, dict):
        raise RuntimeError("Source variant not found")

    refined_variant = {
        "variantId": variant_id,
        "type": source_variant.get("type", "full"),
        "variantKind": "refined",
        "sourceVariantId": source_variant_id,
        "model": source_variant.get("model"),
        "promptHash": source_variant.get("promptHash"),
        "createdAt": now_iso(),
        "outputKey": output_key,
        "generationSettings": {
            **(source_variant.get("generationSettings") if isinstance(source_variant.get("generationSettings"), dict) else {}),
            "sourceVariantId": source_variant_id,
            "refinedFromVariantId": source_variant_id,
            "workflow": "manual_refine_upload",
            "refineMethod": "manual",
            "uploadedFilename": uploaded_filename,
        },
    }
    frame.setdefault("variants", []).append(refined_variant)
    source_variant.setdefault("refinedVariantIds", [])
    if variant_id not in source_variant["refinedVariantIds"]:
        source_variant["refinedVariantIds"].append(variant_id)
    return refined_variant


def apply_quality_match_to_task(
    *,
    task: dict[str, Any],
    asset_store: AssetStore,
    user_id: str,
    frame_id: str,
    analysis_id: str,
    final_mask_key: str,
    settings: QualityMatchSettings,
    overwrite_generated_frame: bool,
) -> dict[str, Any]:
    frame = task.get("frames", {}).get(frame_id)
    if not isinstance(frame, dict):
        raise RuntimeError("Frame not found")
    analysis = (task.get("qualityMatchAnalyses") or {}).get(analysis_id)
    if not isinstance(analysis, dict):
        raise RuntimeError("Quality Match analysis not found")
    if analysis.get("frameId") != frame_id:
        raise RuntimeError("Analysis frame mismatch")

    variant_id = analysis.get("variantId")
    variant = next((item for item in frame.get("variants", []) if item.get("variantId") == variant_id), None)
    if not isinstance(variant, dict):
        raise RuntimeError("Variant not found for analysis")

    paths = AssetPaths(user_id=task["userId"], task_id=task["taskId"], file_prefix=task.get("filePrefix", ""))
    if not final_mask_key.startswith(f"{paths.task_prefix()}/frames/{frame_id}/quality_match/"):
        raise RuntimeError("Final merge mask must be in frame quality_match path")

    analysis_artifacts = analysis.get("artifacts") if isinstance(analysis.get("artifacts"), dict) else {}
    original_bytes = asset_store.read_bytes(frame["captureKey"])
    generated_bytes = asset_store.read_bytes(variant["outputKey"])
    final_mask_bytes = asset_store.read_bytes(final_mask_key)
    patch_meta = variant.get("patchMeta") if isinstance(variant.get("patchMeta"), dict) else {}
    original_mask_key = patch_meta.get("maskKey") if isinstance(patch_meta, dict) else None
    original_mask_bytes = asset_store.read_bytes(original_mask_key) if isinstance(original_mask_key, str) and original_mask_key else None

    applied = apply_quality_match(
        original_bytes=original_bytes,
        generated_bytes=generated_bytes,
        final_mask_bytes=final_mask_bytes,
        settings=settings,
        original_mask_bytes=original_mask_bytes,
    )

    refined_variant_id, refined_output_key = _allocate_refined_variant_storage(frame, paths, frame_id)
    asset_store.put_bytes(refined_output_key, applied["artifacts"]["final"], content_type="image/png")
    apply_run_id = new_id("qmap")[-8:]
    final_key = paths.quality_match_artifact(frame_id, analysis_id, f"quality_match_final_{apply_run_id}", ".png")
    final_preview_key = paths.quality_match_artifact(frame_id, analysis_id, f"quality_match_preview_{apply_run_id}", ".png")
    report_key = paths.quality_match_artifact(frame_id, analysis_id, f"quality_match_report_{apply_run_id}", ".json")
    asset_store.put_bytes(final_key, applied["artifacts"]["final"], content_type="image/png")
    asset_store.put_bytes(final_preview_key, applied["artifacts"]["final"], content_type="image/png")
    asset_store.put_bytes(report_key, json.dumps(applied["artifacts"]["reportJson"]).encode("utf-8"), content_type="application/json")

    before = analysis.get("metrics") if isinstance(analysis.get("metrics"), dict) else {}
    after = applied.get("metricsAfter") if isinstance(applied.get("metricsAfter"), dict) else {}
    frame_status = {
        "qcReviewed": True,
        "qualityMatched": True,
        "qualityMatchVersion": "quality-match-v1",
        "qualityMatchAppliedAt": now_iso(),
        "qualityMatchAppliedBy": user_id,
        "qualityMatchSourceAnalysisId": analysis_id,
        "qualityMatchOriginalMaskProvided": bool(analysis.get("originalMaskProvided")),
        "qualityMatchUserEditedMask": bool(final_mask_key),
        "qualityMatchMetrics": {
            "changedPctBefore": before.get("changedPctBefore"),
            "changedPctAfter": after.get("changedPctAfter"),
            "outsideLeakageBefore": before.get("outsideLeakageBefore"),
            "outsideLeakageAfter": after.get("outsideLeakageAfter"),
            "boundarySpillBefore": before.get("boundarySpillBefore"),
            "boundarySpillAfter": after.get("boundarySpillAfter"),
        },
        "qualityMatchArtifacts": {
            "alignedGeneratedKey": analysis_artifacts.get("alignedGeneratedKey"),
            "diffHeatmapKey": analysis_artifacts.get("diffHeatmapKey"),
            "binaryChangeMaskKey": analysis_artifacts.get("binaryChangeMaskKey"),
            "proposedMergeMaskKey": analysis_artifacts.get("proposedMergeMaskKey"),
            "restorationMapKey": analysis_artifacts.get("restorationMapKey"),
            "previewKey": analysis_artifacts.get("previewKey"),
            "finalKey": final_key,
            "reportJsonKey": report_key,
        },
    }
    refined_variant = {
        "variantId": refined_variant_id,
        "type": variant.get("type", "full"),
        "variantKind": "refined",
        "sourceVariantId": variant_id,
        "model": variant.get("model"),
        "promptHash": variant.get("promptHash"),
        "createdAt": now_iso(),
        "outputKey": refined_output_key,
        "generationSettings": {
            **(variant.get("generationSettings") if isinstance(variant.get("generationSettings"), dict) else {}),
            "sourceVariantId": variant_id,
            "refinedFromVariantId": variant_id,
            "workflow": "quality_match_refine",
        },
        "qualityMatch": {
            "appliedAt": now_iso(),
            "analysisId": analysis_id,
            "finalMaskKey": final_mask_key,
            "finalKey": final_key,
            "reportJsonKey": report_key,
            "sourceVariantId": variant_id,
        },
    }
    frame.setdefault("variants", []).append(refined_variant)
    frame["selectedVariantId"] = refined_variant_id
    frame["qcReviewed"] = True
    frame["qualityMatched"] = True
    frame["qualityMatchStatus"] = frame_status
    variant.setdefault("refinedVariantIds", [])
    if refined_variant_id not in variant["refinedVariantIds"]:
        variant["refinedVariantIds"].append(refined_variant_id)
    variant["qualityMatch"] = {
        "appliedAt": now_iso(),
        "analysisId": analysis_id,
        "finalMaskKey": final_mask_key,
        "finalKey": final_key,
        "reportJsonKey": report_key,
        "latestRefinedVariantId": refined_variant_id,
    }

    analysis["updatedAt"] = now_iso()
    analysis["applied"] = {
        "at": now_iso(),
        "userId": user_id,
        "finalMaskKey": final_mask_key,
        "finalKey": final_key,
        "reportJsonKey": report_key,
        "overwriteGeneratedFrame": bool(overwrite_generated_frame),
    }
    analysis.setdefault("artifacts", {})["finalKey"] = final_key
    analysis.setdefault("artifacts", {})["reportJsonKey"] = report_key

    shot_id = next(
        (
            str(segment.get("segmentId"))
            for segment in task.get("segments", [])
            if segment.get("startFrameId") == frame_id or segment.get("endFrameId") == frame_id
        ),
        frame_id,
    )
    task.setdefault("history", []).append(
        {
            "type": "QUALITY_MATCH_APPLIED",
            "frameId": frame_id,
            "shotId": shot_id,
            "userId": user_id,
            "timestamp": now_iso(),
            "details": {
                "originalMaskProvided": bool(analysis.get("originalMaskProvided")),
                "userEditedMask": bool(final_mask_key),
                "changedPctBefore": before.get("changedPctBefore"),
                "changedPctAfter": after.get("changedPctAfter"),
                "outsideLeakageBefore": before.get("outsideLeakageBefore"),
                "outsideLeakageAfter": after.get("outsideLeakageAfter"),
            },
        }
    )

    return {
        "frameId": frame_id,
        "variantId": refined_variant_id,
        "sourceVariantId": variant_id,
        "analysisId": analysis_id,
        "outputKey": refined_output_key,
        "finalKey": final_key,
        "reportJsonKey": report_key,
        "metricsAfter": after,
    }
