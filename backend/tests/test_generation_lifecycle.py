from __future__ import annotations

from src.generation.lifecycle import (
    build_reconcile_generation_record,
    build_reconcile_state,
    generation_ready_for_post,
    get_generation,
    get_segment,
)


def test_generation_lookup_helpers() -> None:
    task = {
        "segmentGenerations": {"gen_1": {"genId": "gen_1"}},
        "segments": [{"segmentId": "seg_1"}],
    }
    assert get_generation(task, "gen_1") == {"genId": "gen_1"}
    assert get_generation(task, "missing") is None
    assert get_segment(task, "seg_1") == {"segmentId": "seg_1"}
    assert get_segment(task, "missing") is None


def test_generation_ready_for_post() -> None:
    assert generation_ready_for_post({"status": "complete", "outputKey": "k"}) is True
    assert generation_ready_for_post({"status": "running", "outputKey": "k"}) is False
    assert generation_ready_for_post({"status": "complete", "outputKey": None}) is False


def test_reconcile_builders() -> None:
    source = {
        "genId": "gen_src",
        "segmentId": "seg_1",
        "status": "complete",
        "outputKey": "out.mp4",
        "generationSettings": {"provider": "x"},
    }
    queued = build_reconcile_generation_record(
        source,
        result_generation_id="gen_new",
        segment_id="seg_1",
        source_generation_id="gen_src",
        job_id="job_1",
        now_iso="2026-05-05T12:00:00Z",
        trim_start_frames=1,
        trim_end_frames=2,
        playback_rate=1.1,
    )
    assert queued["genId"] == "gen_new"
    assert queued["status"] == "queued"
    assert queued["jobId"] == "job_1"
    assert queued["derivedFromGenerationId"] == "gen_src"
    assert queued["generationSettings"]["workflow"] == "timing_reconcile"

    state = build_reconcile_state(
        job_id="job_1",
        result_generation_id="gen_new",
        now_iso="2026-05-05T12:00:00Z",
        trim_start_frames=1,
        trim_end_frames=2,
        playback_rate=1.1,
    )
    assert state["status"] == "queued"
    assert state["resultGenId"] == "gen_new"
    assert state["adjustments"]["trimStartFrames"] == 1
