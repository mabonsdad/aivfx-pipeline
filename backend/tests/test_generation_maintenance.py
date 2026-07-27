from __future__ import annotations

from src.generation.maintenance import (
    backfill_segment_generation_preview_refs,
    maintain_segment_generations,
    prune_stale_segment_generations,
    reconcile_segment_generation_job_states,
)


class _Store:
    def __init__(self, jobs: dict[str, dict]):
        self._jobs = jobs

    def load_job(self, _user_id: str, job_id: str):
        return self._jobs.get(job_id)


def test_reconcile_segment_generation_job_states_updates_completed_generation() -> None:
    events: list[dict] = []
    task = {
        "userId": "user_1",
        "frames": {"frame_a": {"captureKey": "frame-a.png"}, "frame_b": {"captureKey": "frame-b.png"}},
        "segments": [{"segmentId": "seg_1", "startFrameId": "frame_a", "endFrameId": "frame_b", "crop": {"x": 1}}],
        "segmentGenerations": {
            "gen_1": {
                "genId": "gen_1",
                "segmentId": "seg_1",
                "status": "queued",
                "jobId": "job_1",
                "luma": {},
            }
        },
    }
    store = _Store(
        {
            "job_1": {
                "status": "complete",
                "updatedAt": "2026-05-05T10:00:00Z",
                "payload": {"prompt": "hello", "firstFrameVariantId": "var_1"},
                "resultRefs": {
                    "outputKey": "outputs/out.mp4",
                    "provider": "luma",
                    "model": "ray2",
                    "mode": "video",
                    "providerGenerationId": "provider_1",
                },
            }
        }
    )

    changed = reconcile_segment_generation_job_states(
        task,
        store,
        now_iso_fn=lambda: "2026-05-05T10:01:00Z",
        append_history_event_fn=lambda _task, entry: events.append(entry),
        stale_running_job_max_age_seconds=3600,
    )

    assert changed is True
    generation = task["segmentGenerations"]["gen_1"]
    assert generation["status"] == "complete"
    assert generation["outputKey"] == "outputs/out.mp4"
    assert generation["sourceFirstFrameCaptureKey"] == "frame-a.png"
    assert generation["sourceLastFrameCaptureKey"] == "frame-b.png"
    assert generation["sourceFirstFrameVariantId"] == "var_1"
    assert generation["luma"]["prompt"] == "hello"
    assert events and events[0]["event"] == "segment_generation.reconciled_complete"


def test_prune_stale_segment_generations_removes_old_queued_generation() -> None:
    task = {
        "userId": "user_1",
        "segments": [{"segmentId": "seg_1", "selectedGenerationId": "gen_stale"}],
        "segmentGenerations": {
            "gen_stale": {
                "genId": "gen_stale",
                "status": "queued",
                "jobId": "job_missing",
                "createdAt": "2020-01-01T00:00:00Z",
            }
        },
    }
    changed = prune_stale_segment_generations(
        task,
        _Store({}),
        now_iso_fn=lambda: "2026-05-05T11:00:00Z",
        stale_generation_max_age_seconds=60,
    )

    assert changed is True
    assert "gen_stale" not in task["segmentGenerations"]
    assert task["segments"][0]["selectedGenerationId"] is None
    assert task["history"][-1]["event"] == "task.segment_generations.pruned"


def test_maintain_segment_generations_runs_full_pipeline() -> None:
    events: list[dict] = []
    task = {
        "userId": "user_1",
        "frames": {"frame_a": {"captureKey": "frame-a.png"}, "frame_b": {"captureKey": "frame-b.png"}},
        "segments": [{"segmentId": "seg_1", "startFrameId": "frame_a", "endFrameId": "frame_b", "crop": {"x": 1}}],
        "segmentGenerations": {
            "gen_1": {"genId": "gen_1", "segmentId": "seg_1", "status": "queued", "jobId": "job_1", "luma": {}}
        },
    }
    store = _Store({"job_1": {"status": "complete", "resultRefs": {"outputKey": "outputs/out.mp4"}}})

    changed = maintain_segment_generations(
        task,
        store,
        now_iso_fn=lambda: "2026-05-05T12:00:00Z",
        append_history_event_fn=lambda _task, entry: events.append(entry),
        stale_generation_max_age_seconds=60,
        stale_running_job_max_age_seconds=3600,
    )

    assert changed is True
    generation = task["segmentGenerations"]["gen_1"]
    assert generation["status"] == "complete"
    assert generation["sourceFirstFrameCaptureKey"] == "frame-a.png"
    assert generation["sourceLastFrameCaptureKey"] == "frame-b.png"
    assert events and events[0]["event"] == "segment_generation.reconciled_complete"
    assert backfill_segment_generation_preview_refs(task) is False
