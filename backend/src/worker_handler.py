from __future__ import annotations

from aws_lambda_powertools import Logger

from src.core.config import load_settings
from src.workers.processor import process_job_record

logger = Logger()
settings = load_settings()


@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    for record in event.get("Records", []):
        process_job_record(record, settings=settings)
    return {"ok": True, "records": len(event.get('Records', []))}
