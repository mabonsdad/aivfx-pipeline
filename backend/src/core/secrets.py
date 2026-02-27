from __future__ import annotations

import json
from functools import lru_cache

import boto3


@lru_cache(maxsize=1)
def load_secret(secret_arn: str) -> dict[str, str]:
    sm = boto3.client("secretsmanager")
    value = sm.get_secret_value(SecretId=secret_arn)
    secret_text = value.get("SecretString") or "{}"
    parsed = json.loads(secret_text)
    if not isinstance(parsed, dict):
        raise ValueError("Secret payload must be JSON object")
    return {str(k): str(v) for k, v in parsed.items()}
