from __future__ import annotations

import json

from cloud.week_ahead_scheduler import run_week_ahead_downloader as downloader


def lambda_handler(event, context):
    result = downloader.run(event if isinstance(event, dict) else {})
    ok = bool(result.get("ok"))
    return {
        "statusCode": 200 if ok else 500,
        "body": json.dumps(result, default=str),
    }
