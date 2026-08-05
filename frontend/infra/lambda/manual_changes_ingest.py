import csv
import io
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

try:
    import boto3  # type: ignore
except Exception:  # pragma: no cover
    boto3 = None  # type: ignore


TARGET_BUCKET = os.getenv("TARGET_BUCKET", "").strip()
MANUAL_PREFIX = os.getenv("MANUAL_PREFIX", "manual/changes").strip().strip("/")
VALID_SCHEDULE_TYPES = {"DAY_AHEAD", "INTRADAY"}

s3 = boto3.client("s3") if boto3 is not None else None


def _response(status_code: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(payload),
    }


def _parse_event_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")
    if not body:
        raise ValueError("Request body is required")
    if isinstance(body, dict):
        return body
    return json.loads(body)


def _to_csv(changes: List[Dict[str, Any]]) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["block", "mw"])
    for item in changes:
        writer.writerow([item["block"], item["mw"]])
    return output.getvalue()


def _sanitize(value: Any) -> str:
    text = str(value or "").strip()
    return "".join(ch for ch in text if ch.isalnum() or ch in {"-", "_", "."})


def _normalize_changes(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen_by_block: Dict[int, float] = {}
    for change in changes:
        block = int(change["block"])
        mw = float(change["mw"])
        seen_by_block[block] = mw
    normalized = [{"block": block, "mw": seen_by_block[block]} for block in sorted(seen_by_block.keys())]
    return normalized


def _validate(payload: Dict[str, Any]) -> None:
    schedule_type = str(payload.get("schedule_type", "")).strip().upper()
    if schedule_type not in VALID_SCHEDULE_TYPES:
        raise ValueError("schedule_type must be DAY_AHEAD or INTRADAY")

    changes = payload.get("changes")
    if not isinstance(changes, list) or len(changes) == 0:
        raise ValueError("changes must be a non-empty array")

    for item in changes:
        block = int(item.get("block", 0))
        mw = float(item.get("mw", -1))
        if block < 1 or block > 96:
            raise ValueError("Every change.block must be between 1 and 96")
        if mw < 0:
            raise ValueError("Every change.mw must be >= 0")


def handler(event, context):
    try:
        payload = _parse_event_body(event)
        _validate(payload)

        payload["schedule_type"] = str(payload["schedule_type"]).strip().upper()
        payload["changes"] = _normalize_changes(payload["changes"])
        payload["received_at_utc"] = datetime.now(timezone.utc).isoformat()

        org_id = _sanitize(payload.get("org_id", "unknown-org"))
        site_id = _sanitize(payload.get("site_id", "unknown-site"))
        schedule_date = _sanitize(payload.get("schedule_date", "unknown-date"))
        schedule_type = _sanitize(payload.get("schedule_type", "INTRADAY"))
        request_id = _sanitize(payload.get("request_id", "no-request-id"))
        submitted_at_ist = _sanitize(payload.get("submitted_at_ist", datetime.now(timezone.utc).isoformat()))

        base = f"{MANUAL_PREFIX}/{org_id}/{site_id}/{schedule_date}/{schedule_type}/{submitted_at_ist}_{request_id}"
        json_key = f"{base}.json"
        csv_key = f"{base}.csv"

        csv_text = _to_csv(payload["changes"])

        if TARGET_BUCKET and s3 is not None:
            s3.put_object(
                Bucket=TARGET_BUCKET,
                Key=json_key,
                Body=json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),
                ContentType="application/json",
            )
            s3.put_object(
                Bucket=TARGET_BUCKET,
                Key=csv_key,
                Body=csv_text.encode("utf-8"),
                ContentType="text/csv",
            )
        elif TARGET_BUCKET and s3 is None:
            raise RuntimeError("boto3 is not available in this environment (required to write to S3)")

        return _response(
            200,
            {
                "ok": True,
                "message": "Manual schedule changes accepted",
                "request_id": payload.get("request_id"),
                "schedule_date": payload.get("schedule_date"),
                "site_id": payload.get("site_id"),
                "json_s3_key": json_key if TARGET_BUCKET else None,
                "csv_s3_key": csv_key if TARGET_BUCKET else None,
                "bucket": TARGET_BUCKET if TARGET_BUCKET else None,
                "normalized_change_count": len(payload["changes"]),
            },
        )
    except ValueError as exc:
        return _response(400, {"ok": False, "error": str(exc)})
    except Exception as exc:
        return _response(500, {"ok": False, "error": f"Internal error: {str(exc)}"})
