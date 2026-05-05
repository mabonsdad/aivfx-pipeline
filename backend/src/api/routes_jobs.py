from __future__ import annotations


def handle_job_status(
    method: str,
    path: str,
    *,
    user_id: str,
    store,
    origin: str | None,
    response_fn,
    error_response_fn,
):
    if method != "GET" or not path.startswith("/jobs/"):
        return None

    parts = path.split("/")
    if len(parts) < 3 or not parts[2]:
        return error_response_fn(404, "Job not found", origin=origin)
    job_id = parts[2]
    job = store.load_job(user_id, job_id)
    if not job:
        return error_response_fn(404, "Job not found", origin=origin)
    return response_fn(200, job, origin=origin)
