from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections import defaultdict
from copy import deepcopy
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from src.core.cost_tracking import attach_usage_summary, build_usage_record, estimate_cost_from_pricing_entry, load_pricing_admin_config, resolve_pricing_entry  # noqa: E402
from src.core.store import S3JsonStore, now_iso  # noqa: E402


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def load_outputs(path: Path, stack_name: str | None = None) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if stack_name and stack_name in payload:
        return payload[stack_name]
    if len(payload) == 1:
        return next(iter(payload.values()))
    raise KeyError(f"Could not resolve stack outputs from {path}")


def safe_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def infer_provider(model: str | None) -> str:
    normalized = str(model or "").strip()
    if normalized.startswith("runware_"):
        return "runware"
    if normalized in {"chatgpt", "chatgpt_latest"}:
        return "openai"
    if normalized.startswith("luma_") or normalized.startswith("ray-") or normalized.startswith("luma"):
        return "luma"
    if normalized.startswith("nano_banana") or normalized.startswith("gemini") or normalized == "imagen":
        return "google"
    if normalized.startswith("runway") or normalized.startswith("gen4"):
        return "runway"
    if normalized.startswith("kling") or normalized.startswith("wan2.7") or normalized.startswith("ltx-"):
        return "replicate"
    if normalized.startswith("happy-horse") or normalized.startswith("seedance") or normalized.startswith("omnihuman") or normalized.startswith("sora-2"):
        return "fal"
    return "unknown"


def map_provider_model(record_model: str, metadata: dict[str, Any] | None = None) -> str:
    meta = metadata if isinstance(metadata, dict) else {}
    if record_model == "luma_uni_1":
        return str(meta.get("lumaUniModel") or "uni-1")
    if record_model in {"luma_uni_1_max", "luma_uni_1_1"}:
        return str(meta.get("lumaUniModel") or "uni-1-max")
    return record_model


def usage_signature(
    *,
    source: str,
    asset_kind: str | None,
    asset_id: str | None,
    task_id: str | None,
    segment_id: str | None,
    request_id: str | None,
) -> str:
    return "|".join(
        [
            source.strip(),
            str(asset_kind or "").strip(),
            str(asset_id or "").strip(),
            str(task_id or "").strip(),
            str(segment_id or "").strip(),
            str(request_id or "").strip(),
        ]
    )


class UsageBackfill:
    def __init__(self, store: S3JsonStore, *, dry_run: bool = False):
        self.store = store
        self.dry_run = dry_run
        self.pricing_config = load_pricing_admin_config(store)
        self.stats: dict[str, int] = defaultdict(int)
        self.usage_by_id: dict[str, dict[str, Any]] = {}
        self.usage_by_signature: dict[str, dict[str, Any]] = {}
        for record in store.list_all_usage_records():
            if not isinstance(record, dict):
                continue
            usage_record_id = str(record.get("usageRecordId") or "").strip()
            if usage_record_id:
                self.usage_by_id[usage_record_id] = record
            signature = usage_signature(
                source=str(record.get("source") or ""),
                asset_kind=str(record.get("assetKind") or ""),
                asset_id=str(record.get("assetId") or ""),
                task_id=str(record.get("taskId") or ""),
                segment_id=str(record.get("segmentId") or ""),
                request_id=str(record.get("requestId") or ""),
            )
            if signature.replace("|", "").strip():
                self.usage_by_signature[signature] = record

    def _log(self, message: str) -> None:
        print(message, file=sys.stderr, flush=True)

    def _attach_existing(
        self,
        target_record: dict[str, Any],
        *,
        source: str,
        asset_kind: str | None,
        asset_id: str | None,
        task_id: str | None,
        segment_id: str | None,
        request_id: str | None,
    ) -> bool:
        usage_record_id = str(target_record.get("usageRecordId") or "").strip()
        existing = self.usage_by_id.get(usage_record_id) if usage_record_id else None
        if existing is None:
            existing = self.usage_by_signature.get(
                usage_signature(
                    source=source,
                    asset_kind=asset_kind,
                    asset_id=asset_id,
                    task_id=task_id,
                    segment_id=segment_id,
                    request_id=request_id,
                )
            )
        if not isinstance(existing, dict):
            return False
        attach_usage_summary(target_record, existing)
        self.stats["attachedExisting"] += 1
        return True

    def ensure_usage(
        self,
        *,
        target_record: dict[str, Any],
        user_id: str,
        source: str,
        tool_origin: str,
        request_type: str,
        provider: str | None,
        provider_model: str | None,
        app_model_id: str | None,
        workflow_id: str | None = None,
        task_id: str | None = None,
        segment_id: str | None = None,
        project_id: str | None = None,
        request_id: str | None = None,
        asset_id: str | None = None,
        asset_kind: str | None = None,
        created_at: str | None = None,
        usage: dict[str, Any] | None = None,
        duration_sec: float | None = None,
        width: int | None = None,
        height: int | None = None,
        fps: float | None = None,
        resolution_label: str | None = None,
        image_count: int = 1,
        operation: str | None = None,
        reference_count: int = 0,
        notes: str | None = None,
    ) -> bool:
        if self._attach_existing(
            target_record,
            source=source,
            asset_kind=asset_kind,
            asset_id=asset_id,
            task_id=task_id,
            segment_id=segment_id,
            request_id=request_id,
        ):
            return True

        pricing_entry = resolve_pricing_entry(
            self.pricing_config,
            app_model_id=app_model_id,
            provider_model=provider_model,
        )
        resolved_provider = str(provider or "").strip() or str((pricing_entry or {}).get("provider") or "").strip() or infer_provider(app_model_id)
        estimate = estimate_cost_from_pricing_entry(
            pricing_entry,
            usage=usage,
            duration_sec=duration_sec,
            width=width,
            height=height,
            fps=fps,
            resolution_label=resolution_label,
            image_count=image_count,
            operation=operation,
            reference_count=reference_count,
        )
        created_stamp = str(created_at or target_record.get("createdAt") or target_record.get("updatedAt") or now_iso())
        usage_record = build_usage_record(
            usage_record_id=new_id("usage"),
            now_iso=created_stamp,
            user_id=user_id,
            provider=resolved_provider,
            provider_model=provider_model,
            app_model_id=app_model_id,
            request_type=request_type,
            source=source,
            tool_origin=tool_origin,
            workflow_id=workflow_id,
            task_id=task_id,
            segment_id=segment_id,
            project_id=project_id,
            request_id=request_id,
            asset_id=asset_id,
            asset_kind=asset_kind,
            pricing_entry=pricing_entry,
            estimate=estimate,
            notes=notes,
        )
        attach_usage_summary(target_record, usage_record)
        signature = usage_signature(
            source=source,
            asset_kind=asset_kind,
            asset_id=asset_id,
            task_id=task_id,
            segment_id=segment_id,
            request_id=request_id,
        )
        self.usage_by_id[str(usage_record["usageRecordId"])] = usage_record
        self.usage_by_signature[signature] = usage_record
        self.stats["created"] += 1
        if not self.dry_run:
            self.store.save_usage_record(usage_record)
        return True

    def backfill_tasks(self) -> tuple[int, int]:
        updated_tasks = 0
        updated_assets = 0
        tasks = self.store.list_all_tasks()
        self._log(f"Scanning {len(tasks)} tasks")
        for index, task in enumerate(tasks, start=1):
            if not isinstance(task, dict):
                continue
            if index == 1 or index % 25 == 0:
                self._log(f"Processed {index}/{len(tasks)} tasks")
            task_changed = False
            user_id = str(task.get("userId") or "").strip()
            task_id = str(task.get("taskId") or "").strip()
            workflow_id = str(task.get("workflowId") or "").strip() or None
            project_id = str(task.get("projectId") or "").strip() or None

            frames = task.get("frames") if isinstance(task.get("frames"), dict) else {}
            for frame in frames.values():
                if not isinstance(frame, dict):
                    continue
                for variant in frame.get("variants") or []:
                    if not isinstance(variant, dict):
                        continue
                    model = str(variant.get("model") or "").strip()
                    variant_type = str(variant.get("type") or "").strip()
                    if variant_type not in {"full", "patch"}:
                        continue
                    if model in {"generated_extension_anchor", "manual_upload", "extension_anchor"}:
                        continue
                    generation_settings = variant.get("generationSettings") if isinstance(variant.get("generationSettings"), dict) else {}
                    provider = str(generation_settings.get("provider") or "").strip() or infer_provider(model)
                    provider_model = map_provider_model(model, generation_settings.get("lumaUni") if isinstance(generation_settings.get("lumaUni"), dict) else generation_settings)
                    output_resolution = generation_settings.get("outputResolution") if isinstance(generation_settings.get("outputResolution"), dict) else {}
                    composited_resolution = generation_settings.get("compositedResolution") if isinstance(generation_settings.get("compositedResolution"), dict) else {}
                    width = safe_int(output_resolution.get("width")) or safe_int(composited_resolution.get("width")) or safe_int(frame.get("width"))
                    height = safe_int(output_resolution.get("height")) or safe_int(composited_resolution.get("height")) or safe_int(frame.get("height"))
                    reference_count = 1 if isinstance(variant.get("patchMeta"), dict) and variant["patchMeta"].get("referenceImageKey") else 0
                    changed = self.ensure_usage(
                        target_record=variant,
                        user_id=user_id,
                        source="task_patch_edit" if variant_type == "patch" else "task_full_edit",
                        tool_origin="patch_edit" if variant_type == "patch" else "full_edit",
                        request_type="image_generation",
                        provider=provider,
                        provider_model=provider_model,
                        app_model_id=model,
                        workflow_id=workflow_id,
                        task_id=task_id,
                        project_id=project_id,
                        asset_id=str(variant.get("variantId") or "").strip() or None,
                        asset_kind="frame_variant",
                        created_at=str(variant.get("createdAt") or ""),
                        width=width,
                        height=height,
                        operation="patch_edit" if variant_type == "patch" else "full_edit",
                        reference_count=reference_count,
                    )
                    if changed:
                        task_changed = True
                        updated_assets += 1

            for reference in task.get("editVideoReferences") or []:
                if not isinstance(reference, dict):
                    continue
                if str(reference.get("type") or "").strip() != "generated":
                    continue
                if str(reference.get("status") or "").strip() != "complete":
                    continue
                model = str(reference.get("model") or "").strip()
                if not model:
                    continue
                changed = self.ensure_usage(
                    target_record=reference,
                    user_id=user_id,
                    source="edit_video_reference_generate",
                    tool_origin="edit_video_reference_generate",
                    request_type="image_generation",
                    provider=str(reference.get("provider") or "").strip() or infer_provider(model),
                    provider_model=map_provider_model(model),
                    app_model_id=model,
                    workflow_id=workflow_id,
                    task_id=task_id,
                    project_id=project_id,
                    asset_id=str(reference.get("referenceId") or "").strip() or None,
                    asset_kind="edit_video_reference",
                    created_at=str(reference.get("createdAt") or reference.get("updatedAt") or ""),
                    operation="reference_generation",
                )
                if changed:
                    task_changed = True
                    updated_assets += 1

            segment_generations = task.get("segmentGenerations") if isinstance(task.get("segmentGenerations"), dict) else {}
            for generation in segment_generations.values():
                if not isinstance(generation, dict):
                    continue
                if generation.get("isChunkInternal"):
                    continue
                if str(generation.get("status") or "").strip() != "complete":
                    continue
                model = str(((generation.get("luma") or {}) if isinstance(generation.get("luma"), dict) else {}).get("model") or "").strip()
                provider = str(((generation.get("luma") or {}) if isinstance(generation.get("luma"), dict) else {}).get("provider") or "").strip()
                generation_settings = generation.get("generationSettings") if isinstance(generation.get("generationSettings"), dict) else {}
                provider_model = str(generation_settings.get("model") or model).strip() or model
                stored_output = generation_settings.get("storedOutput") if isinstance(generation_settings.get("storedOutput"), dict) else {}
                fps_info = stored_output.get("fps") if isinstance(stored_output.get("fps"), dict) else {}
                fps = None
                if safe_int(fps_info.get("num")) and safe_int(fps_info.get("den")):
                    fps = safe_int(fps_info.get("num")) / safe_int(fps_info.get("den"))
                if generation.get("characterAnimation"):
                    source = "character_animation_generate"
                    tool_origin = "segment_generate_character_animate"
                elif generation_settings.get("workflow") == "clip_lengthen":
                    source = "segment_generate_clip_lengthen"
                    tool_origin = "segment_generate_clip_lengthen"
                elif str(((generation.get("luma") or {}) if isinstance(generation.get("luma"), dict) else {}).get("mode") or "") == "previz_frames":
                    source = "previz_generate"
                    tool_origin = "previz_generate"
                else:
                    source = "segment_generate"
                    tool_origin = "segment_generate"
                changed = self.ensure_usage(
                    target_record=generation,
                    user_id=user_id,
                    source=source,
                    tool_origin=tool_origin,
                    request_type="video_generation",
                    provider=provider or str(generation_settings.get("provider") or "").strip() or infer_provider(model),
                    provider_model=provider_model,
                    app_model_id=model or provider_model,
                    workflow_id=workflow_id,
                    task_id=task_id,
                    segment_id=str(generation.get("segmentId") or "").strip() or None,
                    project_id=project_id,
                    asset_id=str(generation.get("genId") or "").strip() or None,
                    asset_kind="segment_generation",
                    created_at=str(generation.get("createdAt") or generation.get("updatedAt") or ""),
                    duration_sec=safe_float(generation.get("providerDurationSec")) or safe_float(generation_settings.get("providerDurationSec")) or safe_float(generation.get("requestedDurationSec")),
                    width=safe_int(stored_output.get("width")),
                    height=safe_int(stored_output.get("height")),
                    fps=fps,
                    resolution_label=str(generation_settings.get("seedanceResolution") or generation_settings.get("wan27Resolution") or generation_settings.get("happyHorseResolution") or generation_settings.get("sora2Resolution") or generation_settings.get("omnihumanResolution") or "").strip() or None,
                )
                if changed:
                    task_changed = True
                    updated_assets += 1

            for export_record in task.get("exports") or []:
                if not isinstance(export_record, dict):
                    continue
                topaz = export_record.get("topazUpscale") if isinstance(export_record.get("topazUpscale"), dict) else None
                if not isinstance(topaz, dict) or str(topaz.get("status") or "").strip() != "complete":
                    continue
                output = topaz.get("output") if isinstance(topaz.get("output"), dict) else {}
                fps_info = output.get("fps") if isinstance(output.get("fps"), dict) else {}
                fps = None
                if safe_int(fps_info.get("num")) and safe_int(fps_info.get("den")):
                    fps = safe_int(fps_info.get("num")) / safe_int(fps_info.get("den"))
                changed = self.ensure_usage(
                    target_record=export_record,
                    user_id=user_id,
                    source="topaz_upscale",
                    tool_origin="topaz_upscale",
                    request_type="video_upscale",
                    provider="fal",
                    provider_model="fal-ai/topaz/upscale/video",
                    app_model_id="fal-ai/topaz/upscale/video",
                    workflow_id=workflow_id,
                    task_id=task_id,
                    project_id=project_id,
                    asset_id=str(export_record.get("exportId") or "").strip() or None,
                    asset_kind="export",
                    created_at=str(export_record.get("createdAt") or topaz.get("updatedAt") or ""),
                    duration_sec=safe_float(output.get("durationSec")),
                    width=safe_int(output.get("width")),
                    height=safe_int(output.get("height")),
                    fps=fps,
                    notes=f"preset={topaz.get('preset')};model={topaz.get('model')}",
                )
                if changed:
                    task_changed = True
                    updated_assets += 1

            if task_changed:
                updated_tasks += 1
                self.stats["updatedTasks"] += 1
                if not self.dry_run:
                    self.store.save_task(task, merge_on_conflict=True)
        return updated_tasks, updated_assets

    def backfill_api_requests(self) -> tuple[int, int]:
        updated_requests = 0
        updated_assets = 0
        requests = self.store.list_all_api_requests()
        self._log(f"Scanning {len(requests)} API requests")
        for index, request_record in enumerate(requests, start=1):
            if not isinstance(request_record, dict):
                continue
            if index == 1 or index % 100 == 0:
                self._log(f"Processed {index}/{len(requests)} API requests")
            if str(request_record.get("status") or "").strip() != "complete":
                continue
            workflow = str(request_record.get("workflow") or "").strip()
            model = str(request_record.get("model") or "").strip()
            request_id = str(request_record.get("requestId") or "").strip()
            user_id = str(request_record.get("userId") or "").strip()
            changed = False

            if workflow == "image_edit_full":
                request_data = request_record.get("request") if isinstance(request_record.get("request"), dict) else {}
                normalization = request_record.get("normalization") if isinstance(request_record.get("normalization"), dict) else {}
                output_asset = request_record.get("outputAssets", {}).get("output") if isinstance(request_record.get("outputAssets"), dict) else {}
                changed = self.ensure_usage(
                    target_record=request_record,
                    user_id=user_id,
                    source="external_api_image_edit_full",
                    tool_origin="external_api_image_edit_full",
                    request_type="image_generation",
                    provider=str(request_record.get("provider") or "").strip() or infer_provider(model),
                    provider_model=map_provider_model(model, request_data),
                    app_model_id=model,
                    request_id=request_id,
                    asset_id=request_id,
                    asset_kind="api_request",
                    created_at=str(request_record.get("createdAt") or request_record.get("updatedAt") or ""),
                    width=safe_int(output_asset.get("width")) or safe_int((normalization.get("outputResolution") or {}).get("width")),
                    height=safe_int(output_asset.get("height")) or safe_int((normalization.get("outputResolution") or {}).get("height")),
                    operation="full_edit",
                    reference_count=len((request_record.get("inputAssets", {}).get("referenceImages") or [])) if isinstance(request_record.get("inputAssets"), dict) else 0,
                )
            elif workflow == "image_edit_patch":
                output_asset = request_record.get("outputAssets", {}).get("output") if isinstance(request_record.get("outputAssets"), dict) else {}
                normalization = request_record.get("normalization") if isinstance(request_record.get("normalization"), dict) else {}
                changed = self.ensure_usage(
                    target_record=request_record,
                    user_id=user_id,
                    source="external_api_image_edit_patch",
                    tool_origin="external_api_image_edit_patch",
                    request_type="image_generation",
                    provider=str(request_record.get("provider") or "").strip() or infer_provider(model),
                    provider_model=map_provider_model(model),
                    app_model_id=model,
                    request_id=request_id,
                    asset_id=request_id,
                    asset_kind="api_request",
                    created_at=str(request_record.get("createdAt") or request_record.get("updatedAt") or ""),
                    width=safe_int(output_asset.get("width")) or safe_int((normalization.get("outputResolution") or {}).get("width")),
                    height=safe_int(output_asset.get("height")) or safe_int((normalization.get("outputResolution") or {}).get("height")),
                    operation="patch_edit",
                    reference_count=len((request_record.get("inputAssets", {}).get("referenceImages") or [])) if isinstance(request_record.get("inputAssets"), dict) else 0,
                )
            elif workflow == "video_generation_reference":
                normalization = request_record.get("normalization") if isinstance(request_record.get("normalization"), dict) else {}
                output_asset = request_record.get("outputAssets", {}).get("output") if isinstance(request_record.get("outputAssets"), dict) else {}
                fps_info = output_asset.get("fps") if isinstance(output_asset.get("fps"), dict) else {}
                fps = None
                if safe_int(fps_info.get("num")) and safe_int(fps_info.get("den")):
                    fps = safe_int(fps_info.get("num")) / safe_int(fps_info.get("den"))
                changed = self.ensure_usage(
                    target_record=request_record,
                    user_id=user_id,
                    source="external_api_reference_video_generate",
                    tool_origin="external_api_reference_video_generate",
                    request_type="video_generation",
                    provider=str(request_record.get("provider") or "").strip() or infer_provider(model),
                    provider_model=str(normalization.get("providerModel") or model).strip() or model,
                    app_model_id=model,
                    request_id=request_id,
                    asset_id=request_id,
                    asset_kind="api_request",
                    created_at=str(request_record.get("createdAt") or request_record.get("updatedAt") or ""),
                    duration_sec=safe_float((output_asset or {}).get("durationSec")) or safe_float(normalization.get("outputDurationSec")),
                    width=safe_int(output_asset.get("width")),
                    height=safe_int(output_asset.get("height")),
                    fps=fps,
                    resolution_label=str((request_record.get("request") or {}).get("happyHorseResolution") or (request_record.get("request") or {}).get("wan27Resolution") or (request_record.get("request") or {}).get("sora2Resolution") or "").strip() or None,
                )

            if changed:
                updated_requests += 1
                updated_assets += 1
                self.stats["updatedRequests"] += 1
                if not self.dry_run:
                    self.store.save_api_request(request_record)
        return updated_requests, updated_assets


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill usage/cost records for historical AIVFX tasks and API requests.")
    parser.add_argument("--outputs", default="infra/cdk-outputs.dev.json", help="Path to CDK outputs JSON")
    parser.add_argument("--stack-name", default=None, help="Optional stack name inside the outputs file")
    parser.add_argument("--dry-run", action="store_true", help="Do not write any usage records or metadata updates")
    args = parser.parse_args()

    outputs = load_outputs((REPO_ROOT / args.outputs).resolve(), args.stack_name)
    metadata_bucket = str(outputs.get("MetadataBucketName") or "").strip()
    if not metadata_bucket:
        raise SystemExit("MetadataBucketName not found in outputs")

    store = S3JsonStore(metadata_bucket)
    backfill = UsageBackfill(store, dry_run=args.dry_run)
    updated_tasks, updated_task_assets = backfill.backfill_tasks()
    updated_requests, updated_request_assets = backfill.backfill_api_requests()

    summary = {
        "metadataBucket": metadata_bucket,
        "dryRun": args.dry_run,
        "updatedTasks": updated_tasks,
        "updatedTaskAssets": updated_task_assets,
        "updatedRequests": updated_requests,
        "updatedRequestAssets": updated_request_assets,
        "usageRecordsCreated": backfill.stats.get("created", 0),
        "existingUsageRecordsAttached": backfill.stats.get("attachedExisting", 0),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
