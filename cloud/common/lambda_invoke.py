from __future__ import annotations

import json
import os
from typing import Any

try:
    import boto3
except ImportError:
    boto3 = None


def invoke_lambda_async(function_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if boto3 is None:
        raise RuntimeError("boto3 is required for Lambda invocation")
    client = boto3.client("lambda")
    response = client.invoke(
        FunctionName=function_name,
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    return {
        "status_code": int(response.get("StatusCode", 0) or 0),
        "function_name": function_name,
        "invocation_type": "Event",
    }


def is_local_invocation(event: dict[str, Any] | None = None) -> bool:
    payload = dict(event or {})
    if bool(payload.get("local_invoke")):
        return True
    if str(os.getenv("LOCAL_RUNNER_MODE", "")).strip().lower() in {"1", "true", "yes"}:
        return True
    return not bool(str(os.getenv("AWS_LAMBDA_FUNCTION_NAME", "")).strip())
