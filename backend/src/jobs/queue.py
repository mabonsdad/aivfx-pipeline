from __future__ import annotations

import json
from typing import Any

import boto3


class JobQueue:
    def __init__(self, queue_url: str):
        self.queue_url = queue_url
        self.sqs = boto3.client("sqs")

    def enqueue(self, message: dict[str, Any]) -> None:
        self.sqs.send_message(QueueUrl=self.queue_url, MessageBody=json.dumps(message))
