from __future__ import annotations

import pytest

from src.api.dispatch import parse_method_path, parse_task_path
from src.workers.dispatch import dispatch_job


def test_parse_method_path_defaults() -> None:
    method, path = parse_method_path({})
    assert method == "GET"
    assert path == "/"


def test_parse_task_path_extracts_task_id() -> None:
    parsed = parse_task_path("/tasks/task_123/segments")
    assert parsed is not None
    task_id, parts = parsed
    assert task_id == "task_123"
    assert parts[:2] == ["tasks", "task_123"]


def test_dispatch_job_calls_registered_handler() -> None:
    called: list[str] = []

    def _handler(**kwargs):
        called.append(str(kwargs["marker"]))

    dispatch_job(job_type="x", handlers={"x": _handler}, handler_kwargs={"marker": "ok"})
    assert called == ["ok"]


def test_dispatch_job_rejects_unknown_type() -> None:
    with pytest.raises(RuntimeError):
        dispatch_job(job_type="missing", handlers={}, handler_kwargs={})
