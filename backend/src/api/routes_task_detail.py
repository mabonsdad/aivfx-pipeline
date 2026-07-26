from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any, Callable

import boto3

from src.core.assets import AssetPaths
from src.core.ffmpeg import extract_frame_png, ffprobe_video
from src.core.projects import can_access_project, project_summary
def _backfill_generation_posters(task: dict[str, Any], asset_store, *, assets_bucket: str, max_per_request: int = 6) -> bool:
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict) or not generations:
        return False
    paths = AssetPaths(str(task.get("userId") or ""), str(task.get("taskId") or ""))
    s3 = boto3.client("s3")
    created = 0
    changed = False
    for gen_id, generation in generations.items():
        if created >= max_per_request:
            break
        if not isinstance(generation, dict):
            continue
        if generation.get("status") != "complete" or generation.get("posterKey"):
            continue
        output_key = str(generation.get("outputKey") or "").strip()
        segment_id = str(generation.get("segmentId") or "").strip()
        if not output_key or not segment_id:
            continue
        try:
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                local_video = td_path / "generation.mp4"
                local_poster = td_path / "poster.png"
                s3.download_file(assets_bucket, output_key, str(local_video))
                probe = ffprobe_video(str(local_video))
                frame_count = max(0, int(probe.get("frame_count") or 0))
                poster_frame_index = 1 if frame_count > 1 else 0
                extract_frame_png(str(local_video), poster_frame_index, str(local_poster))
                poster_key = paths.segment_generated_poster(segment_id, str(gen_id))
                asset_store.put_bytes(poster_key, local_poster.read_bytes(), content_type="image/png")
                generation["posterKey"] = poster_key
                created += 1
                changed = True
        except Exception:
            continue
    return changed


def _ensure_previz_bootstrap(task: dict[str, Any], *, new_id_fn: Callable[[str], str]) -> bool:
    if str(task.get("workflowId") or "") != "simple_generation_workflow":
        return False

    changed = False
    previz = task.get("previz")
    if not isinstance(previz, dict):
        previz = {}
        task["previz"] = previz
        changed = True

    if "scenePrompt" not in previz:
        previz["scenePrompt"] = ""
        changed = True
    if "description" not in task:
        task["description"] = str(previz.get("scenePrompt") or "").strip()
        changed = True
    if "sceneAspectRatio" not in previz:
        previz["sceneAspectRatio"] = None
        changed = True
    if not isinstance(previz.get("selectedReferenceIds"), list):
        previz["selectedReferenceIds"] = []
        changed = True
    if not isinstance(previz.get("frameReferenceIds"), list):
        previz["frameReferenceIds"] = []
        changed = True
    if not isinstance(previz.get("selectedFrameIds"), list):
        previz["selectedFrameIds"] = []
        changed = True

    segments = task.setdefault("segments", [])
    synthetic_segment_id = str(previz.get("syntheticSegmentId") or "").strip()
    existing_synthetic = next(
        (
            item
            for item in segments
            if isinstance(item, dict)
            and (
                (synthetic_segment_id and item.get("segmentId") == synthetic_segment_id)
                or item.get("kind") == "scene"
            )
        ),
        None,
    )
    if not isinstance(existing_synthetic, dict):
        segment_id = new_id_fn("seg")
        existing_synthetic = {
            "segmentId": segment_id,
            "kind": "scene",
            "label": "Scene",
            "startFrame": 0,
            "endFrameExclusive": 0,
            "durationFrames": 0,
            "durationSec": 0,
            "startTimecode": "00:00:00:00",
            "endTimecode": "00:00:00:00",
            "startFrameId": "",
            "endFrameId": "",
            "selectedGenerationId": None,
            "segmentClipKey": None,
            "segmentClipUpdatedAt": None,
            "crop": None,
        }
        segments.append(existing_synthetic)
        previz["syntheticSegmentId"] = segment_id
        changed = True

    if existing_synthetic.get("kind") != "scene":
        existing_synthetic["kind"] = "scene"
        changed = True
    if existing_synthetic.get("label") != "Scene":
        existing_synthetic["label"] = "Scene"
        changed = True
    resolved_segment_id = str(existing_synthetic.get("segmentId") or "").strip()
    if resolved_segment_id and previz.get("syntheticSegmentId") != resolved_segment_id:
        previz["syntheticSegmentId"] = resolved_segment_id
        changed = True

    return changed


def handle_task_detail_route(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    claims: dict[str, Any],
    user_id: str,
    store,
    asset_store,
    origin: str | None,
    response_fn,
    error_response_fn,
    helpers: dict[str, Any],
) -> dict[str, Any] | None:
    if method != "GET" or not path.startswith("/tasks/") or path.count("/") != 2:
        return None

    task_id = path.split("/")[2]
    query = event.get("queryStringParameters") or {}
    requested_scope = str((query.get("scope") if isinstance(query, dict) else "") or "").strip().lower()
    requested_project_id = str((query.get("projectId") if isinstance(query, dict) else "") or "").strip()
    use_all_scope = requested_scope == "all" and helpers["is_admin_claims"](claims)
    try:
        if requested_scope == "project":
            if not requested_project_id:
                return error_response_fn(400, "projectId is required for project task scope", origin=origin)
            task = helpers["load_task_or_404_any"](store, task_id)
            if str(task.get("projectId") or "").strip() != requested_project_id:
                return error_response_fn(404, "Task not found", origin=origin)
            project = store.load_project(requested_project_id)
            if not can_access_project(project, user_id=user_id, is_admin=helpers["is_admin_claims"](claims)):
                return error_response_fn(403, "Project access denied", origin=origin)
        else:
            task = helpers["load_task_or_404_any"](store, task_id) if use_all_scope else helpers["load_task_or_404"](store, user_id, task_id)
    except KeyError:
        return error_response_fn(404, "Task not found", origin=origin)

    changed = False
    changed = _ensure_previz_bootstrap(task, new_id_fn=helpers["new_id"]) or changed
    if not task.get("sourceMedia") and task.get("video"):
        video = task.get("video", {})
        task["sourceMedia"] = {
            "kind": "video",
            "original": video.get("original"),
            "editSource": video.get("editSource"),
            "previewSource": video.get("previewSource"),
        }
        changed = True
    changed = helpers["maintain_segment_generations"](task, store) or changed
    changed = helpers["cleanup_legacy_generation_qc"](task) or changed
    changed = helpers["cleanup_custom_reports"](task) or changed
    changed = _backfill_generation_posters(
        task,
        asset_store,
        assets_bucket=helpers["settings"].assets_bucket,
    ) or changed
    if changed:
        store.save_task(task)

    decorated = json.loads(json.dumps(task))
    project_id = str(decorated.get("projectId") or "").strip()
    if project_id:
        project = store.load_project(project_id)
        if isinstance(project, dict):
            decorated["projectId"] = project_id
            decorated["projectName"] = project_summary(project).get("name")
    if decorated.get("status") == "error" and decorated.get("video", {}).get("editSource", {}).get("s3Key"):
        decorated["status"] = "ready"
    if decorated.get("video", {}).get("original", {}).get("s3Key"):
        decorated["video"]["original"]["downloadUrl"] = asset_store.presign_get(
            decorated["video"]["original"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("video", {}).get("editSource", {}).get("s3Key"):
        decorated["video"]["editSource"]["downloadUrl"] = asset_store.presign_get(
            decorated["video"]["editSource"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("video", {}).get("previewSource", {}).get("s3Key"):
        decorated["video"]["previewSource"]["downloadUrl"] = asset_store.presign_get(
            decorated["video"]["previewSource"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("video", {}).get("editSource", {}).get("waveformKey"):
        decorated["video"]["editSource"]["waveformUrl"] = asset_store.presign_get(
            decorated["video"]["editSource"]["waveformKey"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("sourceMedia", {}).get("original", {}).get("s3Key"):
        decorated["sourceMedia"]["original"]["downloadUrl"] = asset_store.presign_get(
            decorated["sourceMedia"]["original"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("sourceMedia", {}).get("editSource", {}).get("s3Key"):
        decorated["sourceMedia"]["editSource"]["downloadUrl"] = asset_store.presign_get(
            decorated["sourceMedia"]["editSource"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("sourceMedia", {}).get("previewSource", {}).get("s3Key"):
        decorated["sourceMedia"]["previewSource"]["downloadUrl"] = asset_store.presign_get(
            decorated["sourceMedia"]["previewSource"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("sourceMedia", {}).get("waveform", {}).get("s3Key"):
        decorated["sourceMedia"]["waveform"]["downloadUrl"] = asset_store.presign_get(
            decorated["sourceMedia"]["waveform"]["s3Key"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("generationAudioReference", {}).get("originalKey"):
        decorated["generationAudioReference"]["originalUrl"] = asset_store.presign_get(
            decorated["generationAudioReference"]["originalKey"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("generationAudioReference", {}).get("editSourceKey"):
        decorated["generationAudioReference"]["editSourceUrl"] = asset_store.presign_get(
            decorated["generationAudioReference"]["editSourceKey"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("generationAudioReference", {}).get("previewKey"):
        decorated["generationAudioReference"]["previewUrl"] = asset_store.presign_get(
            decorated["generationAudioReference"]["previewKey"], expires=helpers["presigned_get_ttl_seconds"]
        )
    if decorated.get("generationAudioReference", {}).get("waveformKey"):
        decorated["generationAudioReference"]["waveformUrl"] = asset_store.presign_get(
            decorated["generationAudioReference"]["waveformKey"], expires=helpers["presigned_get_ttl_seconds"]
        )
    helpers["decorate_embedded_s3_keys"](decorated.get("documents", []), asset_store)
    helpers["decorate_embedded_s3_keys"](decorated.get("documentIngests", []), asset_store)
    helpers["decorate_embedded_s3_keys"](decorated.get("documentImageAssets", []), asset_store)
    helpers["decorate_embedded_s3_keys"](decorated.get("canvasMediaAssets", []), asset_store)
    for _, frame in decorated.get("frames", {}).items():
        frame["imageUrl"] = asset_store.presign_get(frame["captureKey"], expires=helpers["presigned_get_ttl_seconds"])
        for variant in frame.get("variants", []):
            variant["imageUrl"] = asset_store.presign_get(variant["outputKey"], expires=helpers["presigned_get_ttl_seconds"])
            patch_meta = variant.get("patchMeta")
            if isinstance(patch_meta, dict):
                patch_only_key = patch_meta.get("patchOnlyKey")
                if patch_only_key:
                    patch_meta["patchOnlyUrl"] = asset_store.presign_get(patch_only_key, expires=helpers["presigned_get_ttl_seconds"])
                mask_key = patch_meta.get("maskKey")
                if mask_key:
                    patch_meta["maskUrl"] = asset_store.presign_get(mask_key, expires=helpers["presigned_get_ttl_seconds"])
                ref_key = patch_meta.get("referenceImageKey")
                if ref_key:
                    patch_meta["referenceImageUrl"] = asset_store.presign_get(ref_key, expires=helpers["presigned_get_ttl_seconds"])
        if frame.get("qualityMatchStatus"):
            helpers["decorate_embedded_s3_keys"](frame["qualityMatchStatus"], asset_store)
    for segment in decorated.get("segments", []):
        clip_key = segment.get("segmentClipKey")
        if clip_key:
            segment["segmentClipUrl"] = asset_store.presign_get(clip_key, expires=helpers["presigned_get_ttl_seconds"])
    if decorated.get("qualityMatchAnalyses"):
        helpers["decorate_embedded_s3_keys"](decorated["qualityMatchAnalyses"], asset_store)
    if decorated.get("videoCleanupTracks"):
        helpers["decorate_embedded_s3_keys"](decorated["videoCleanupTracks"], asset_store)
    for _, generation in decorated.get("segmentGenerations", {}).items():
        if generation.get("outputKey"):
            generation["downloadUrl"] = asset_store.presign_get(generation["outputKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("posterKey"):
            generation["posterUrl"] = asset_store.presign_get(generation["posterKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputMediaKey"):
            generation["inputMediaUrl"] = asset_store.presign_get(generation["inputMediaKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputFirstFrameKey"):
            generation["inputFirstFrameUrl"] = asset_store.presign_get(generation["inputFirstFrameKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputLastFrameKey"):
            generation["inputLastFrameUrl"] = asset_store.presign_get(generation["inputLastFrameKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("inputAudioKey"):
            generation["inputAudioUrl"] = asset_store.presign_get(generation["inputAudioKey"], expires=helpers["presigned_get_ttl_seconds"])
        if generation.get("sourceFirstFrameCaptureKey"):
            generation["sourceFirstFrameCaptureUrl"] = asset_store.presign_get(
                generation["sourceFirstFrameCaptureKey"], expires=helpers["presigned_get_ttl_seconds"]
            )
        if generation.get("sourceLastFrameCaptureKey"):
            generation["sourceLastFrameCaptureUrl"] = asset_store.presign_get(
                generation["sourceLastFrameCaptureKey"], expires=helpers["presigned_get_ttl_seconds"]
            )
        generation.pop("qc", None)
    if decorated.get("chunkedGenerationRuns"):
        helpers["decorate_embedded_s3_keys"](decorated["chunkedGenerationRuns"], asset_store)
    for reference in decorated.get("editVideoReferences", []):
        if isinstance(reference, dict) and reference.get("key"):
            reference["imageUrl"] = asset_store.presign_get(reference["key"], expires=helpers["presigned_get_ttl_seconds"])
    for pair in decorated.get("externalQcPairs", []):
        if pair.get("originalKey"):
            pair["originalUrl"] = asset_store.presign_get(pair["originalKey"], expires=helpers["presigned_get_ttl_seconds"])
        if pair.get("editedKey"):
            pair["editedUrl"] = asset_store.presign_get(pair["editedKey"], expires=helpers["presigned_get_ttl_seconds"])
    for export in decorated.get("exports", []):
        output_key = export.get("outputKey")
        if output_key:
            export["downloadUrl"] = asset_store.presign_get(output_key, expires=helpers["presigned_get_ttl_seconds"])
        motion_qc = export.get("motionSyncQc")
        if isinstance(motion_qc, dict):
            helpers["decorate_embedded_s3_keys"](motion_qc, asset_store)
    return response_fn(200, decorated, origin=origin)
