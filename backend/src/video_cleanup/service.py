from __future__ import annotations

from typing import Any

from src.core.assets import AssetPaths
from src.core.ids import new_id
from src.core.store import now_iso
from src.video_cleanup.models import VideoCleanupSettings


def cleanup_tracks(task: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = task.setdefault("videoCleanupTracks", [])
    if not isinstance(tracks, list):
        tracks = []
        task["videoCleanupTracks"] = tracks
    return tracks


def get_cleanup_track(task: dict[str, Any], track_id: str) -> dict[str, Any] | None:
    for item in cleanup_tracks(task):
        if isinstance(item, dict) and item.get("trackId") == track_id:
            return item
    return None


def get_generation(task: dict[str, Any], generation_id: str) -> dict[str, Any] | None:
    generation = task.get("segmentGenerations", {}).get(generation_id)
    return generation if isinstance(generation, dict) else None


def get_segment(task: dict[str, Any], segment_id: str) -> dict[str, Any] | None:
    return next((segment for segment in task.get("segments", []) if isinstance(segment, dict) and segment.get("segmentId") == segment_id), None)


def sort_keyframes(track: dict[str, Any]) -> list[dict[str, Any]]:
    keyframes = track.get("tracking", {}).get("keyframes", [])
    if not isinstance(keyframes, list):
        return []
    return sorted(
        [item for item in keyframes if isinstance(item, dict)],
        key=lambda item: (int(item.get("frameIndexLocal", 0)), str(item.get("createdAt") or "")),
    )


def upsert_track(task: dict[str, Any], track: dict[str, Any]) -> dict[str, Any]:
    tracks = cleanup_tracks(task)
    for index, existing in enumerate(tracks):
        if isinstance(existing, dict) and existing.get("trackId") == track.get("trackId"):
            tracks[index] = track
            break
    else:
        tracks.append(track)
    return track


def next_track_id() -> str:
    return new_id("trk")


def next_keyframe_id() -> str:
    return new_id("kf")


def next_run_id() -> str:
    return new_id("run")


def resolve_first_mask_key_from_analysis(analysis: dict[str, Any]) -> str | None:
    applied = analysis.get("applied")
    if isinstance(applied, dict) and isinstance(applied.get("finalMaskKey"), str) and applied.get("finalMaskKey"):
        return str(applied["finalMaskKey"])
    artifacts = analysis.get("artifacts")
    if isinstance(artifacts, dict) and isinstance(artifacts.get("proposedMergeMaskKey"), str) and artifacts.get("proposedMergeMaskKey"):
        return str(artifacts["proposedMergeMaskKey"])
    return None


def create_track_record(
    *,
    task: dict[str, Any],
    segment: dict[str, Any],
    generation: dict[str, Any],
    track_id: str,
    first_mask_key: str,
    first_mask_source_analysis_id: str,
    settings: VideoCleanupSettings,
    source_key: str,
    generated_key: str,
    width: int,
    height: int,
    frame_count: int,
    fps_num: int,
    fps_den: int,
) -> dict[str, Any]:
    now = now_iso()
    source_first_variant_id = generation.get("sourceFirstFrameVariantId")
    return {
        "trackId": track_id,
        "taskId": task["taskId"],
        "segmentId": segment["segmentId"],
        "generationId": generation["genId"],
        "status": "created",
        "source": {
            "editSourceKey": source_key,
            "generatedSegmentKey": generated_key,
            "startFrameIndex": int(segment["startFrame"]),
            "endFrameExclusive": int(segment["endFrameExclusive"]),
            "fpsNum": int(fps_num),
            "fpsDen": int(fps_den),
            "width": int(width),
            "height": int(height),
            "frameCount": int(frame_count),
            "sourceFirstFrameVariantId": source_first_variant_id,
            "sourceFirstFrameId": segment.get("startFrameId"),
        },
        "seed": {
            "firstFrameIndexLocal": 0,
            "firstMaskKey": first_mask_key,
            "sourceFrameVariantId": source_first_variant_id,
            "generatedFirstFrameVariantId": None,
            "firstMaskSource": {
                "type": "quality_match_analysis",
                "analysisId": first_mask_source_analysis_id,
            },
        },
        "settings": settings.to_dict(),
        "tracking": {
            "samProvider": "fal_sam2",
            "propagationRuns": [],
            "keyframes": [],
        },
        "review": {
            "approved": False,
        },
        "apply": {},
        "createdAt": now,
        "updatedAt": now,
    }


def add_or_replace_keyframe(
    *,
    track: dict[str, Any],
    frame_index_local: int,
    mask_key: str,
    source: str,
    note: str | None = None,
    keyframe_id: str | None = None,
) -> dict[str, Any]:
    tracking = track.setdefault("tracking", {})
    keyframes = tracking.setdefault("keyframes", [])
    now = now_iso()
    existing = next(
        (
            item
            for item in keyframes
            if isinstance(item, dict) and int(item.get("frameIndexLocal", -1)) == frame_index_local
        ),
        None,
    )
    if existing is not None:
        existing.update(
            {
                "maskKey": mask_key,
                "source": source,
                "note": note,
                "createdAt": existing.get("createdAt") or now,
            }
        )
        return existing
    keyframe = {
        "id": keyframe_id or next_keyframe_id(),
        "frameIndexLocal": int(frame_index_local),
        "maskKey": mask_key,
        "source": source,
        "note": note,
        "createdAt": now,
    }
    keyframes.append(keyframe)
    return keyframe


def create_cleanup_generation_variant(
    *,
    task: dict[str, Any],
    source_generation: dict[str, Any],
    track: dict[str, Any],
    output_key: str,
) -> dict[str, Any]:
    gen_id = new_id("gen")
    derived = {
        **source_generation,
        "genId": gen_id,
        "status": "complete",
        "outputKey": output_key,
        "createdAt": now_iso(),
        "cleanupTrackId": track["trackId"],
        "derivedFromGenerationId": source_generation["genId"],
        "generationSettings": {
            **(source_generation.get("generationSettings") if isinstance(source_generation.get("generationSettings"), dict) else {}),
            "workflow": "video_cleanup_refine",
            "cleanupTrackId": track["trackId"],
            "derivedFromGenerationId": source_generation["genId"],
        },
    }
    task.setdefault("segmentGenerations", {})[gen_id] = derived
    segment = get_segment(task, str(source_generation.get("segmentId") or ""))
    if isinstance(segment, dict):
        segment["selectedGenerationId"] = gen_id
    return derived


def cleanup_asset_paths(task: dict[str, Any]) -> AssetPaths:
    return AssetPaths(user_id=task["userId"], task_id=task["taskId"], file_prefix=task.get("filePrefix", ""))
