from __future__ import annotations

from typing import Any, Callable

JobHandler = Callable[..., Any]


def dispatch_job(*, job_type: str, handlers: dict[str, JobHandler], handler_kwargs: dict[str, Any]) -> Any:
    handler = handlers.get(job_type)
    if handler is None:
        raise RuntimeError(f"Unsupported job type: {job_type}")
    return handler(**handler_kwargs)
