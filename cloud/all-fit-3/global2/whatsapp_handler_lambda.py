import base64
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone

import boto3


DDB_TABLE = os.environ.get("DDB_TABLE")
WHATSAPP_TABLE_NAME = os.environ.get("WHATSAPP_TABLE_NAME", "")
PLANT_ID = os.environ.get("PLANT_ID", "vedanjay")
SITE_ID = os.environ.get("SITE_ID", "").strip().upper()
VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN")
APP_SECRET = os.environ.get("WHATSAPP_APP_SECRET")

ddb = boto3.client("dynamodb")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _extract_message_id(payload: dict) -> str | None:
    # Twilio style
    sid = payload.get("SmsMessageSid") or payload.get("MessageSid")
    if isinstance(sid, str) and sid.strip():
        return sid.strip()

    # Meta style
    try:
        entry = payload.get("entry", [])[0]
        changes = entry.get("changes", [])[0]
        value = changes.get("value", {})
        messages = value.get("messages", [])
        if messages:
            mid = messages[0].get("id")
            if isinstance(mid, str) and mid.strip():
                return mid.strip()
    except Exception:
        return None
    return None


def _extract_event_time(payload: dict) -> str | None:
    # Meta message timestamp is epoch seconds string
    try:
        entry = payload.get("entry", [])[0]
        changes = entry.get("changes", [])[0]
        value = changes.get("value", {})
        messages = value.get("messages", [])
        if messages:
            ts_raw = messages[0].get("timestamp")
            if ts_raw is not None:
                ts = datetime.fromtimestamp(int(ts_raw), tz=timezone.utc)
                return ts.isoformat()
    except Exception:
        return None
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


def _parse_actual_mw(message: str) -> float | None:
    if not message:
        return None
    text = message.strip().lower()
    if not any(k in text for k in ("mw", "meter", "generation", "actual", "gen")):
        return None
    match = re.search(r"(-?\d+(\.\d+)?)", text)
    if not match:
        return None
    try:
        return float(match.group(1))
    except Exception:
        return None


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


def _put_whatsapp_message(
    msg_id: str,
    raw_message: str | None,
    event_time_iso: str | None,
    actual_mw: float | None,
    confidence: float | None = None,
) -> None:
    if not WHATSAPP_TABLE_NAME:
        return
    now_iso = _now_iso()
    event_iso = event_time_iso or now_iso
    try:
        event_epoch = int(datetime.fromisoformat(event_iso.replace("Z", "+00:00")).timestamp())
    except Exception:
        event_epoch = int(datetime.now(timezone.utc).timestamp())
    item = {
        "site_id": {"S": SITE_ID or PLANT_ID.upper()},
        "timestamp": {"S": datetime.fromtimestamp(event_epoch, tz=timezone.utc).isoformat()},
        "source": {"S": "whatsapp"},
    }
    if actual_mw is not None:
        item["actual_mw"] = {"N": f"{float(actual_mw):.3f}"}
    # Keep a deterministic id for traceability (non-schema field, optional).
    item["message_id"] = {"S": msg_id}
    if confidence is not None:
        item["confidence"] = {"N": f"{float(confidence):.3f}"}
    if raw_message:
        item["raw_message"] = {"S": raw_message[:512]}
    ddb.put_item(TableName=WHATSAPP_TABLE_NAME, Item=item)


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
    msg_id = _extract_message_id(payload) or hashlib.sha256((message or _now_iso()).encode("utf-8")).hexdigest()[:32]
    event_time_iso = _extract_event_time(payload)
    actual_mw = _parse_actual_mw(message or "")
    status, cap = _parse_command(message or "")

    # Always persist raw WhatsApp meter context if enabled.
    try:
        _put_whatsapp_message(
            msg_id=msg_id,
            raw_message=message,
            event_time_iso=event_time_iso,
            actual_mw=actual_mw,
            confidence=1.0,
        )
    except Exception:
        # Do not fail command handling on optional message-table write.
        pass

    if status is None:
        # Non-command messages are accepted as telemetry-only.
        if actual_mw is not None:
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {
                        "ok": True,
                        "plant_id": PLANT_ID,
                        "site_id": SITE_ID,
                        "message_type": "metered_data",
                        "actual_mw": actual_mw,
                    }
                ),
            }
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
                "plant_id": PLANT_ID,
                "plant_status": status,
                "curtailment_capacity": cap,
            }
        ),
    }
