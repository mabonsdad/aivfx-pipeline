from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    aws_region: str
    assets_bucket: str
    metadata_bucket: str
    jobs_queue_url: str
    secrets_arn: str
    cors_allowed_origins: tuple[str, ...]
    max_upload_bytes: int
    max_prompt_chars: int
    job_poll_interval_seconds: int


_DEF_ORIGINS = (
    "https://www.shwsh.co.uk",
    "https://s3.eu-west-2.amazonaws.com",
)


def _split_csv(v: str | None, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if not v:
        return fallback
    return tuple(part.strip() for part in v.split(",") if part.strip())


def load_settings() -> Settings:
    return Settings(
        aws_region=os.getenv("AWS_REGION", "eu-west-2"),
        assets_bucket=os.environ["ASSETS_BUCKET"],
        metadata_bucket=os.environ["METADATA_BUCKET"],
        jobs_queue_url=os.environ["JOBS_QUEUE_URL"],
        secrets_arn=os.environ["SECRETS_ARN"],
        cors_allowed_origins=_split_csv(os.getenv("CORS_ALLOWED_ORIGINS"), _DEF_ORIGINS),
        max_upload_bytes=int(os.getenv("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))),
        max_prompt_chars=int(os.getenv("MAX_PROMPT_CHARS", "2000")),
        job_poll_interval_seconds=int(os.getenv("JOB_POLL_INTERVAL_SECONDS", "3")),
    )
