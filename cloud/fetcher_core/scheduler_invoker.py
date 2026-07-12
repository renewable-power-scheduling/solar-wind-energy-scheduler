from __future__ import annotations

from typing import Any

from cloud.common.lambda_invoke import invoke_lambda_async, is_local_invocation
from cloud.scheduler_core.scheduler_entry import run as run_scheduler


def invoke_scheduler(entry: dict[str, Any], payload: dict[str, Any], *, local_mode: bool) -> dict[str, Any]:
    if local_mode or is_local_invocation(payload):
        response = run_scheduler(str(entry["site_id"]).strip().upper(), payload, context=None)
        return {
            "mode": "local",
            "function_name": entry["scheduler_lambda_name"],
            "response": response,
        }

    invoke_result = invoke_lambda_async(str(entry["scheduler_lambda_name"]), payload)
    return {
        "mode": "lambda",
        **invoke_result,
    }
