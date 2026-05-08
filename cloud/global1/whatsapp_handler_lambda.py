import base64
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import boto3


DDB_TABLE = os.environ.get("DDB_TABLE")
CONTROL_WINDOWS_TABLE = os.environ.get("CONTROL_WINDOWS_TABLE")
PLANT_ID = os.environ.get("PLANT_ID", "vedanjay")
VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN")
APP_SECRET = os.environ.get("WHATSAPP_APP_SECRET")
CONTROL_TIMEZONE = os.environ.get("CONTROL_TIMEZONE", "Asia/Kolkata")
SCHEDULER_FUNCTION_NAME = os.environ.get("SCHEDULER_FUNCTION_NAME", "global1-scheduler")


ddb = boto3.client("dynamodb")
lambda_client = boto3.client("lambda")


try:
    LOCAL_TZ = ZoneInfo(CONTROL_TIMEZONE)
except Exception:
    LOCAL_TZ = timezone.utc


OPEN_ENDED_STATUSES = {"SHUTDOWN", "CURTAILMENT"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_local() -> datetime:
    return datetime.now(LOCAL_TZ)


def _timestamp_to_block_ist(run_ts_ist: datetime) -> int:
    mins = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, 1 + (mins // 15)))


def _should_invoke_scheduler_now(command: dict, now_local: datetime | None = None) -> bool:
    if str(command.get("kind") or "") != "window":
        return False
    start_time = command.get("start_time")
    end_time = command.get("end_time")
    if not isinstance(start_time, datetime):
        return False
    now_local = now_local or _now_local()
    if end_time is not None and now_local >= end_time:
        return False
    trigger_time = start_time - timedelta(minutes=60)
    return now_local >= trigger_time


def _invoke_scheduler_for_planned_control(command: dict, window_id: str, now_local: datetime | None = None) -> dict:
    if not SCHEDULER_FUNCTION_NAME:
        return {"invoked": False, "reason": "scheduler_function_not_configured"}

    now_local = now_local or _now_local()
    engine_block_ref = _timestamp_to_block_ist(now_local)
    payload = {
        "mode": "worker",
        "site": command["site"],
        "run_ts_ist": now_local.isoformat(),
        "engine_block_ref": engine_block_ref,
        "planned_window_id": window_id,
        "planned_control_source": "whatsapp",
    }
    lambda_client.invoke(
        FunctionName=SCHEDULER_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    return {
        "invoked": True,
        "function_name": SCHEDULER_FUNCTION_NAME,
        "engine_block_ref": engine_block_ref,
        "run_ts_ist": now_local.isoformat(),
    }


def _parse_body(event) -> dict:
    body = event.get("body") if isinstance(event, dict) else None
    if body is None:
        return {}
    if event.get("isBase64Encoded"):
        try:
            body = base64.b64decode(body).decode("utf-8", errors="ignore")
        except Exception:
            return {}
    if isinstance(body, (dict, list)):
        return body if isinstance(body, dict) else {}
    try:
        return json.loads(body)
    except Exception:
        return {}


def _get_http_method(event) -> str | None:
    if not isinstance(event, dict):
        return None
    if "httpMethod" in event:
        return event.get("httpMethod")
    return (event.get("requestContext", {}).get("http", {}) or {}).get("method")


def _verify_webhook(event) -> dict | None:
    """
    Meta webhook verification uses GET with hub.* query params.
    Return a Lambda response dict if this is a verification request.
    """
    method = _get_http_method(event)
    if not method or method.upper() != "GET":
        return None

    params = event.get("queryStringParameters") or {}
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if mode == "subscribe" and token and challenge:
        if VERIFY_TOKEN and token == VERIFY_TOKEN:
            return {"statusCode": 200, "body": str(challenge)}
        return {"statusCode": 403, "body": "Verification failed"}
    return None


def _extract_raw_body(event) -> str | None:
    if not isinstance(event, dict):
        return None
    body = event.get("body")
    if body is None:
        return None
    if event.get("isBase64Encoded"):
        try:
            return base64.b64decode(body).decode("utf-8", errors="ignore")
        except Exception:
            return None
    return body if isinstance(body, str) else None


def _validate_meta_signature(event) -> bool:
    """
    Validate X-Hub-Signature-256 using app secret.
    Expected header: x-hub-signature-256: sha256=<hex>
    """
    if not APP_SECRET:
        return True
    if not isinstance(event, dict):
        return False
    headers = event.get("headers") or {}
    sig = headers.get("x-hub-signature-256") or headers.get("X-Hub-Signature-256")
    raw_body = _extract_raw_body(event)
    if not sig or raw_body is None:
        return False
    if not sig.startswith("sha256="):
        return False
    expected = hmac.new(APP_SECRET.encode("utf-8"), raw_body.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig.split("=", 1)[1], expected)


def _extract_message(payload: dict) -> str | None:
    # Common providers:
    # - Meta WhatsApp Cloud API: entry[0].changes[0].value.messages[0].text.body
    # - Twilio: Body
    # - Generic: message / text / content
    if "Body" in payload and isinstance(payload["Body"], str):
        return payload["Body"]

    msg = payload.get("message") or payload.get("text") or payload.get("content")
    if isinstance(msg, str):
        return msg

    try:
        entry = payload.get("entry", [])[0]
        changes = entry.get("changes", [])[0]
        value = changes.get("value", {})
        messages = value.get("messages", [])
        if messages and "text" in messages[0]:
            return messages[0]["text"].get("body")
    except Exception:
        return None

    return None


def _normalize_status(value: str | None) -> str | None:
    if not value:
        return None
    text = str(value).strip().upper()
    if text in {"SHUTDOWN", "NORMAL", "CURTAILMENT"}:
        return text
    return None


def _normalize_site(value: str | None) -> str | None:
    if not value:
        return None
    site = str(value).strip().upper()
    return site or None


def _parse_float(text: str | None) -> float | None:
    if not text:
        return None
    match = re.search(r"(\d+(?:\.\d+)?)", str(text))
    return float(match.group(1)) if match else None


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    formats = [
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
    ]
    for fmt in formats:
        try:
            parsed = datetime.strptime(raw, fmt)
            return parsed.replace(tzinfo=LOCAL_TZ)
        except Exception:
            continue
    try:
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=LOCAL_TZ)
        return parsed
    except Exception:
        return None


def _parse_structured_command(message: str) -> dict | None:
    if not message:
        return None

    fields: dict[str, str] = {}
    for raw_line in str(message).splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip().lower()] = value.strip()

    status = _normalize_status(fields.get("plant status") or fields.get("status"))
    site = _normalize_site(fields.get("site"))
    start_dt = _parse_datetime(fields.get("start") or fields.get("start time"))
    end_dt = _parse_datetime(fields.get("end") or fields.get("end time"))
    cap = _parse_float(
        fields.get("curtailment")
        or fields.get("curtailment mw")
        or fields.get("curtailment capacity")
        or fields.get("capacity")
        or fields.get("available ac (mw)")
        or fields.get("mw")
    )

    if status == "NORMAL" and site and not start_dt and not end_dt:
        return {
            "kind": "clear_open_ended",
            "plant_status": status,
            "site": site,
        }

    if status in OPEN_ENDED_STATUSES and site and start_dt:
        return {
            "kind": "window",
            "plant_status": status,
            "site": site,
            "start_time": start_dt,
            "end_time": end_dt,
            "is_open_ended": end_dt is None,
            "curtailment_capacity": cap,
        }

    return None


def _parse_command(message: str) -> tuple[str | None, float | None]:
    if not message:
        return None, None
    text = message.strip().lower()

    if "shutdown" in text:
        return "SHUTDOWN", None
    if "normal" in text:
        return "NORMAL", None

    if "curtail" in text:
        # Accept: "curtailment 2.5", "curtail 3", "curtailment=2"
        match = re.search(r"(\d+(\.\d+)?)", text)
        cap = float(match.group(1)) if match else None
        return "CURTAILMENT", cap

    return None, None


def _build_window_id(site: str, plant_status: str, start_time: datetime, end_time: datetime | None) -> str:
    safe_site = re.sub(r"[^A-Z0-9_-]", "_", site.upper())
    safe_status = re.sub(r"[^A-Z0-9_-]", "_", plant_status.upper())
    end_token = end_time.isoformat() if end_time is not None else "OPEN"
    return f"{safe_site}#{safe_status}#{start_time.isoformat()}#{end_token}"


def _put_state(plant_status: str, curtailment_capacity: float | None, raw_message: str | None) -> None:
    if not DDB_TABLE:
        raise RuntimeError("DDB_TABLE env var not set")

    item = {
        "plant_id": {"S": PLANT_ID},
        "plant_status": {"S": plant_status},
        "updated_at": {"S": _now_iso()},
    }
    if curtailment_capacity is not None:
        item["curtailment_capacity"] = {"N": f"{curtailment_capacity:.3f}"}
    if raw_message:
        item["last_message"] = {"S": raw_message[:256]}

    ddb.put_item(TableName=DDB_TABLE, Item=item)


def _put_control_window(command: dict, raw_message: str | None) -> str:
    if not CONTROL_WINDOWS_TABLE:
        raise RuntimeError("CONTROL_WINDOWS_TABLE env var not set")

    plant_status = command["plant_status"]
    site = command["site"]
    start_time = command["start_time"]
    end_time = command.get("end_time")
    is_open_ended = bool(command.get("is_open_ended"))
    if not is_open_ended and end_time is None:
        raise ValueError("End time is required for bounded planned control")
    if end_time is not None and end_time <= start_time:
        raise ValueError("End time must be after start time")

    window_id = _build_window_id(site, plant_status, start_time, end_time)
    now_iso = _now_iso()
    item = {
        "plant_id": {"S": PLANT_ID},
        "window_id": {"S": window_id},
        "plant_status": {"S": plant_status},
        "site": {"S": site},
        "start_time": {"S": start_time.isoformat()},
        "created_at": {"S": now_iso},
        "updated_at": {"S": now_iso},
        "source": {"S": "whatsapp"},
        "active": {"BOOL": True},
        "is_open_ended": {"BOOL": is_open_ended},
    }
    if end_time is not None:
        item["end_time"] = {"S": end_time.isoformat()}
    cap = command.get("curtailment_capacity")
    if plant_status == "CURTAILMENT":
        if cap is None:
            raise ValueError("Curtailment window requires a MW value")
        item["curtailment_capacity"] = {"N": f"{cap:.3f}"}
    if raw_message:
        item["last_message"] = {"S": raw_message[:512]}

    ddb.put_item(TableName=CONTROL_WINDOWS_TABLE, Item=item)
    return window_id


def _clear_open_ended_controls(site: str, raw_message: str | None) -> list[str]:
    if not CONTROL_WINDOWS_TABLE:
        raise RuntimeError("CONTROL_WINDOWS_TABLE env var not set")

    resp = ddb.query(
        TableName=CONTROL_WINDOWS_TABLE,
        KeyConditionExpression="#pk = :pk",
        ExpressionAttributeNames={"#pk": "plant_id"},
        ExpressionAttributeValues={":pk": {"S": PLANT_ID}},
        ConsistentRead=True,
    )
    site_token = _normalize_site(site)
    cleared_ids: list[str] = []
    now_iso = _now_iso()

    for item in resp.get("Items", []) or []:
        item_site = _normalize_site((item.get("site") or {}).get("S"))
        if item_site != site_token:
            continue
        status = _normalize_status((item.get("plant_status") or {}).get("S"))
        if status not in OPEN_ENDED_STATUSES:
            continue
        is_open_ended = bool((item.get("is_open_ended") or {}).get("BOOL")) or not (item.get("end_time") or {}).get("S")
        is_active = True if "active" not in item else bool((item.get("active") or {}).get("BOOL"))
        if not is_open_ended or not is_active:
            continue
        window_id = (item.get("window_id") or {}).get("S")
        if not window_id:
            continue
        ddb.update_item(
            TableName=CONTROL_WINDOWS_TABLE,
            Key={
                "plant_id": {"S": PLANT_ID},
                "window_id": {"S": window_id},
            },
            UpdateExpression="SET active = :false, cleared_at = :cleared_at, cleared_by = :cleared_by, updated_at = :updated_at",
            ExpressionAttributeValues={
                ":false": {"BOOL": False},
                ":cleared_at": {"S": now_iso},
                ":cleared_by": {"S": (raw_message or "NORMAL")[:512]},
                ":updated_at": {"S": now_iso},
            },
        )
        cleared_ids.append(window_id)

    return cleared_ids


def lambda_handler(event, context):
    verification = _verify_webhook(event)
    if verification is not None:
        return verification

    if not _validate_meta_signature(event):
        return {
            "statusCode": 403,
            "body": json.dumps({"ok": False, "error": "Invalid signature"}),
        }

    payload = _parse_body(event)
    message = _extract_message(payload)
    structured = _parse_structured_command(message or "")

    if structured is not None:
        if structured["kind"] == "clear_open_ended":
            cleared_ids = _clear_open_ended_controls(structured["site"], message)
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {
                        "ok": True,
                        "mode": "control_window_clear",
                        "plant_id": PLANT_ID,
                        "site": structured["site"],
                        "cleared_count": len(cleared_ids),
                        "cleared_window_ids": cleared_ids,
                    }
                ),
            }

        try:
            window_id = _put_control_window(structured, message)
        except ValueError as exc:
            return {
                "statusCode": 400,
                "body": json.dumps({"ok": False, "error": str(exc)}),
            }

        scheduler_info = {"invoked": False, "reason": "outside_immediate_trigger_window"}
        try:
            if _should_invoke_scheduler_now(structured):
                scheduler_info = _invoke_scheduler_for_planned_control(structured, window_id)
        except Exception as exc:
            scheduler_info = {"invoked": False, "reason": str(exc)}

        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "ok": True,
                    "mode": "control_window",
                    "plant_id": PLANT_ID,
                    "window_id": window_id,
                    "site": structured["site"],
                    "plant_status": structured["plant_status"],
                    "start_time": structured["start_time"].isoformat(),
                    "end_time": structured["end_time"].isoformat() if structured.get("end_time") is not None else None,
                    "is_open_ended": bool(structured.get("is_open_ended")),
                    "curtailment_capacity": structured.get("curtailment_capacity"),
                    "scheduler_invoked": bool(scheduler_info.get("invoked")),
                    "scheduler_trigger_reason": scheduler_info.get("reason"),
                    "scheduler_function_name": scheduler_info.get("function_name"),
                    "scheduler_engine_block_ref": scheduler_info.get("engine_block_ref"),
                    "scheduler_run_ts_ist": scheduler_info.get("run_ts_ist"),
                }
            ),
        }

    status, cap = _parse_command(message or "")

    if status is None:
        return {
            "statusCode": 400,
            "body": json.dumps({"ok": False, "error": "Unrecognized command"}),
        }

    if status == "CURTAILMENT" and cap is None:
        return {
            "statusCode": 400,
            "body": json.dumps({"ok": False, "error": "Curtailment requires a MW value"}),
        }

    _put_state(status, cap, message)
    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "ok": True,
                "mode": "live_state",
                "plant_id": PLANT_ID,
                "plant_status": status,
                "curtailment_capacity": cap,
            }
        ),
    }
