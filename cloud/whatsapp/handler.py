import base64
import difflib
import hashlib
import hmac
import json
import os
import re
from urllib.parse import parse_qs
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import boto3


DDB_TABLE = os.environ.get("DDB_TABLE")
CONTROL_WINDOWS_TABLE = os.environ.get("CONTROL_WINDOWS_TABLE")
WHATSAPP_TABLE_NAME = os.environ.get("WHATSAPP_TABLE_NAME", "")
SITE_TELEMETRY_TABLE_NAME = os.environ.get("SITE_TELEMETRY_TABLE_NAME", "")
PLANT_ID = os.environ.get("PLANT_ID", "vedanjay")
SITE_ID = os.environ.get("SITE_ID", "").strip().upper()
VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN")
APP_SECRET = os.environ.get("WHATSAPP_APP_SECRET")
TASKER_WEBHOOK_TOKEN = os.environ.get("TASKER_WEBHOOK_TOKEN", "")
CONTROL_TIMEZONE = os.environ.get("CONTROL_TIMEZONE", "Asia/Kolkata")


ddb = boto3.client("dynamodb")


try:
    LOCAL_TZ = ZoneInfo(CONTROL_TIMEZONE)
except Exception:
    LOCAL_TZ = timezone.utc


OPEN_ENDED_STATUSES = {"SHUTDOWN", "CURTAILMENT"}
APPROVED_TELEMETRY_SITES = {
    "KOTHAGUDEM",
    "KASIPET",
    "BHUPALPALLY",
    "SIRMOUR",
    "OSEPL",
    "ANJANGOAN",
    "NANDGAON",
    "BAMKHAL",
    "SAWDA",
}
SINGLE_SITE_GROUP_ALIASES = {
    "ANJANGOAN(7.5 MW)QCA(F&S)": "ANJANGOAN",
    "SIRMOUR QCA (F&S)": "SIRMOUR",
    "REAL TIME DATA_OSEL": "OSEPL",
}
SITE_ALIASES = {
    "OSEL": "OSEPL",
    "20 MW OSMANABAD SOLAR ENERGY LTD, HORTI": "OSEPL",
    "KAISPET": "KASIPET",
    "KSPT": "KASIPET",
    "BHPL": "BHUPALPALLY",
    "BHP": "BHUPALPALLY",
    "KTGDM": "KOTHAGUDEM",
    "SIRM": "SIRMOUR",
    "ANJANGAON": "ANJANGOAN",
    "ANJANGAON SITE": "ANJANGOAN",
    "ANJANGOAN SITE": "ANJANGOAN",
    "BHAMKAL": "BAMKHAL",
    "SAWADA": "SAWDA",
    "SAWDA": "SAWDA",
}
SITE_PREFIX_RULES = {
    "KOTHA": "KOTHAGUDEM",
    "KASI": "KASIPET",
    "SIRM": "SIRMOUR",
    "BHPL": "BHUPALPALLY",
    "BHUPA": "BHUPALPALLY",
    "ANJAN": "ANJANGOAN",
    "NANDA": "NANDGAON",
    "BAMK": "BAMKHAL",
    "SAWD": "SAWDA",
}
SITE_SIMILARITY_CUTOFF = 0.90
ONE_LINE_ACTION_PATTERN = re.compile(
    r"^(?P<site>.+?)\s+(?P<action>restoration delayed|restore delayed|restore now|restored|extended|extend|shutdown|curtailment|curtail|down|normal)\b(?P<rest>.*)$",
    re.IGNORECASE,
)
MW_DOWN_PATTERN = re.compile(
    r"^(?P<site>.+?)\s+(?P<cap>\d+(?:\.\d+)?)\s*mw\s+(?P<mode>ac|dc)\s+down\b(?P<rest>.*)$",
    re.IGNORECASE,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_local() -> datetime:
    return datetime.now(LOCAL_TZ)


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
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, str) and parsed.strip():
            return {"body": parsed}
        return {}
    except Exception:
        if isinstance(body, str) and ("=" in body or "&" in body):
            form_parsed = parse_qs(body, keep_blank_values=True)
            if form_parsed:
                flattened: dict[str, str] = {}
                for key, values in form_parsed.items():
                    if not values:
                        continue
                    flattened[key] = values[-1]
                if flattened:
                    return flattened
        if isinstance(body, str) and body.strip():
            # Preserve plain-text posts from Tasker or other HTTP clients.
            return {"body": body}
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


def _event_debug_snapshot(event) -> dict:
    if not isinstance(event, dict):
        return {"event_type": type(event).__name__}
    headers = event.get("headers") or {}
    raw_body = _extract_raw_body(event)
    return {
        "event_keys": sorted(list(event.keys())),
        "header_keys": sorted(list(headers.keys())) if isinstance(headers, dict) else type(headers).__name__,
        "has_tasker_header": bool(
            isinstance(headers, dict)
            and (
                headers.get("x-tasker-token")
                or headers.get("X-Tasker-Token")
            )
        ),
        "body_preview": (raw_body[:200] if isinstance(raw_body, str) else None),
        "is_base64_encoded": bool(event.get("isBase64Encoded")),
    }


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


def _has_valid_tasker_token(event) -> bool:
    """
    Allow trusted internal Tasker posts on the same webhook without requiring
    a Meta signature.
    Expected header: x-tasker-token: <shared secret>
    """
    if not TASKER_WEBHOOK_TOKEN:
        return False
    if not isinstance(event, dict):
        return False
    headers = event.get("headers") or {}
    token = headers.get("x-tasker-token") or headers.get("X-Tasker-Token")
    if not isinstance(token, str) or not token.strip():
        return False
    return hmac.compare_digest(token.strip(), TASKER_WEBHOOK_TOKEN)


TELEMETRY_FIELD_HINTS = (
    "site",
    "available ac",
    "radiation",
    "irradiance",
    "active power",
    "weather status",
    "weather condition",
)


def _looks_like_telemetry_text(value: str | None) -> bool:
    if not value:
        return False
    text = str(value).lower()
    matches = sum(1 for hint in TELEMETRY_FIELD_HINTS if hint in text)
    return matches >= 2


def _payload_string_candidates(payload: dict) -> list[str]:
    candidates: list[str] = []
    preferred_keys = (
        "Body",
        "body",
        "WA_MSG",
        "wa_msg",
        "message",
        "text",
        "content",
        "message_body",
        "raw_message",
        "evtprm3",
        "evtprm1",
        "evtprm2",
        "evtprm4",
        "evtprm5",
        "evtprm6",
        "evtprm7",
        "evtprm8",
    )
    for key in preferred_keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            candidates.append(value)
    for value in payload.values():
        if isinstance(value, str) and value.strip() and value not in candidates:
            candidates.append(value)
    return candidates


def _is_useful_message_candidate(value: str | None) -> bool:
    if not value:
        return False
    text = str(value).strip()
    if not text:
        return False
    lowered = text.lower()
    if lowered in {"com.whatsapp", "whatsapp"}:
        return False
    if re.fullmatch(r"\d+\s+messages?\s+from\s+\d+\s+chats?", lowered):
        return False
    if lowered in {"sending", "sending…", "checking for new messages"}:
        return False
    return True


def _extract_embedded_telemetry_text(value: str | None) -> str | None:
    if not _looks_like_telemetry_text(value):
        return None
    lines: list[str] = []
    for raw_line in str(value).splitlines():
        line = raw_line.strip().strip('",')
        line = re.sub(r'^\s*"?[^"]+"?\s*:\s*"?', "", line).strip().strip('",')
        if any(hint in line.lower() for hint in TELEMETRY_FIELD_HINTS):
            lines.append(line)
    return "\n".join(lines) if len(lines) >= 2 else str(value).strip()


def _extract_message(payload: dict) -> str | None:
    # Common providers:
    # - Meta WhatsApp Cloud API: entry[0].changes[0].value.messages[0].text.body
    # - Twilio: Body
    # - Generic: message / text / content
    candidates = _payload_string_candidates(payload)
    for value in candidates:
        if not _is_useful_message_candidate(value):
            continue
        if _looks_like_telemetry_text(value):
            embedded = _extract_embedded_telemetry_text(value)
            return embedded or value

    if candidates:
        for value in candidates:
            if _is_useful_message_candidate(value):
                return value
        return candidates[0]

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
    sid = payload.get("SmsMessageSid") or payload.get("MessageSid")
    if isinstance(sid, str) and sid.strip():
        return sid.strip()
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


def _extract_chat_group_name(payload: dict) -> str | None:
    candidate_keys = (
        "evtprm2",
        "chat_name",
        "group_name",
        "conversation",
        "source_chat",
    )
    for key in candidate_keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _extract_event_time(payload: dict) -> str | None:
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


def _normalize_group_key(value: str | None) -> str:
    if not value:
        return ""
    text = str(value).strip().upper()
    # Tasker/WhatsApp can append counters and sender labels to the chat title.
    text = re.sub(r"\s*\(\d+\s+MESSAGES?\)\s*", " ", text)
    text = re.sub(r"\s*:\s*~.*$", "", text)
    text = re.sub(r"\s*:\s*[^:]+$", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _resolve_single_site_group(value: str | None) -> str | None:
    if not value:
        return None
    return SINGLE_SITE_GROUP_ALIASES.get(_normalize_group_key(value))


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
    site = re.sub(r"\s+", " ", site)
    if not site:
        return None
    if site in APPROVED_TELEMETRY_SITES:
        return site

    alias = SITE_ALIASES.get(site)
    if alias:
        return alias

    compact_site = re.sub(r"[^A-Z0-9]+", "", site)
    for prefix, canonical in SITE_PREFIX_RULES.items():
        normalized_prefix = re.sub(r"[^A-Z0-9]+", "", prefix.upper())
        if compact_site.startswith(normalized_prefix):
            return canonical

    compact_to_site = {
        re.sub(r"[^A-Z0-9]+", "", candidate): candidate
        for candidate in APPROVED_TELEMETRY_SITES
    }
    close_matches = difflib.get_close_matches(
        compact_site,
        list(compact_to_site.keys()),
        n=2,
        cutoff=SITE_SIMILARITY_CUTOFF,
    )
    if len(close_matches) == 1:
        return compact_to_site.get(close_matches[0])

    return site


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


def _parse_iso_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=LOCAL_TZ)
        return parsed.astimezone(LOCAL_TZ)
    except Exception:
        return None


def _normalize_field_key(value: str | None) -> str:
    if not value:
        return ""
    text = str(value).strip().lower()
    text = text.replace("_", " ").replace("-", " ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _compact_field_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalize_field_key(value))


def _split_key_value_line(raw_line: str) -> tuple[str, str] | None:
    if not raw_line:
        return None
    line = str(raw_line).strip()
    if not line:
        return None
    match = re.match(r"^(?P<key>.+?)\s*(?:-+\s*:|:\s*|-)\s*(?P<value>.+)$", line)
    if match:
        key = match.group("key").strip().rstrip("-_ ").strip()
        value = match.group("value").strip().lstrip("-_ ").strip()
        if not key or not value:
            return None
        return key, value

    compact_line = _compact_field_key(line)
    no_separator_fields = {
        "weatherstatus": "weather status",
        "weathercondition": "weather condition",
    }
    for compact_key, field_key in no_separator_fields.items():
        if not compact_line.startswith(compact_key):
            continue
        key_match = re.match(
            r"^\s*[\W_]*(?P<key>weather\s*status|weather\s*condition|weatherstatus|weathercondition)[\W_]*(?P<value>.+)$",
            line,
            flags=re.IGNORECASE,
        )
        if not key_match:
            continue
        value = key_match.group("value").strip().lstrip("-_: ").strip()
        if value:
            return field_key, value

    sentence_style_patterns = (
        (
            r"^\s*current\s*load\s+(?P<value>.+)$",
            "current load",
        ),
        (
            r"^\s*weather\s+is\s+(?P<value>.+)$",
            "weather condition",
        ),
    )
    for pattern, field_key in sentence_style_patterns:
        match = re.match(pattern, line, flags=re.IGNORECASE)
        if not match:
            continue
        value = match.group("value").strip().lstrip("-_: ").strip()
        if value:
            return field_key, value
    return None


def _parse_telemetry_date_time(date_raw: str | None, time_raw: str | None) -> datetime | None:
    if not date_raw and not time_raw:
        return None

    date_text = str(date_raw or "").strip()
    time_text = str(time_raw or "").strip() or "00:00"
    date_formats = [
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%Y-%m-%d",
        "%d/%m/%y",
        "%d-%m-%y",
    ]
    time_formats = ["%H:%M", "%H:%M:%S"]

    for d_fmt in date_formats:
        for t_fmt in time_formats:
            try:
                parsed = datetime.strptime(f"{date_text} {time_text}", f"{d_fmt} {t_fmt}")
                return parsed.replace(tzinfo=LOCAL_TZ)
            except Exception:
                continue

    for d_fmt in date_formats:
        try:
            parsed = datetime.strptime(date_text, d_fmt)
            return parsed.replace(tzinfo=LOCAL_TZ)
        except Exception:
            continue

    return None


def _coerce_site_telemetry_event_ts(
    parsed_dt: datetime | None,
    event_time_iso: str | None,
    msg_id: str,
) -> str:
    if parsed_dt is not None:
        seed = int(hashlib.sha256(msg_id.encode("utf-8")).hexdigest()[:8], 16) % 1000000
        return parsed_dt.replace(microsecond=seed).isoformat()

    fallback = _parse_iso_dt(event_time_iso) if event_time_iso else None
    if fallback is None:
        fallback = _now_local()
    return fallback.isoformat()


def _parse_numeric_value(raw_value: str | None) -> float | None:
    if not raw_value:
        return None
    cleaned = str(raw_value).replace(",", "")
    match = re.search(r"(-?\d+(?:\.\d+)?)", cleaned)
    if not match:
        return None
    try:
        return float(match.group(1))
    except Exception:
        return None


def _resolve_command_base_day(event_time_iso: str | None, relative_day: str | None) -> datetime:
    base_dt = _parse_iso_dt(event_time_iso) if event_time_iso else None
    if base_dt is None:
        base_dt = _now_local()
    day_token = str(relative_day or "").strip().lower()
    if day_token == "tomorrow":
        return base_dt + timedelta(days=1)
    return base_dt


def _parse_time_component(value: str | None) -> tuple[int, int] | None:
    if not value:
        return None
    match = re.match(r"^\s*(\d{1,2})[:.](\d{2})\s*$", str(value))
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return hour, minute


def _build_relative_datetime(event_time_iso: str | None, relative_day: str | None, time_text: str | None) -> datetime | None:
    time_parts = _parse_time_component(time_text)
    if time_parts is None:
        return None
    base_day = _resolve_command_base_day(event_time_iso, relative_day)
    return datetime(
        base_day.year,
        base_day.month,
        base_day.day,
        time_parts[0],
        time_parts[1],
        tzinfo=LOCAL_TZ,
    )


def _parse_duration_minutes(value: str | None) -> int | None:
    if not value:
        return None
    text = str(value).strip().lower()
    match = re.search(r"(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b", text)
    if not match:
        return None
    amount = float(match.group(1))
    unit = match.group(2)
    if unit.startswith("h"):
        return int(round(amount * 60))
    return int(round(amount))


def _parse_one_line_control_command(
    message: str,
    event_time_iso: str | None,
) -> dict | None:
    if not message:
        return None

    single_line = re.sub(r"\s+", " ", str(message)).strip()
    if not single_line:
        return None

    mw_down_match = MW_DOWN_PATTERN.match(single_line)
    if mw_down_match:
        site_alias = str(mw_down_match.group("site") or "").strip()
        site = _normalize_site(site_alias)
        if not site or site not in APPROVED_TELEMETRY_SITES:
            return None

        working = str(mw_down_match.group("rest") or "").strip()
        relative_day = None
        day_match = re.search(r"\b(today|tomorrow)\b", working, flags=re.IGNORECASE)
        if day_match:
            relative_day = day_match.group(1).lower()
            working = re.sub(r"\b(today|tomorrow)\b", "", working, count=1, flags=re.IGNORECASE).strip()

        range_match = re.search(
            r"\bfrom\s+(?P<start>\d{1,2}[:.]\d{2})\s+to\s+(?P<end>\d{1,2}[:.]\d{2})\b|\b(?P<start_plain>\d{1,2}[:.]\d{2})\s+to\s+(?P<end_plain>\d{1,2}[:.]\d{2})\b",
            working,
            flags=re.IGNORECASE,
        )
        from_match = re.search(r"\bfrom\s+(?P<start>\d{1,2}[:.]\d{2})\b", working, flags=re.IGNORECASE)

        start_dt = None
        end_dt = None
        is_open_ended = False
        if range_match:
            start_text = range_match.group("start") or range_match.group("start_plain")
            end_text = range_match.group("end") or range_match.group("end_plain")
            start_dt = _build_relative_datetime(event_time_iso, relative_day, start_text)
            end_dt = _build_relative_datetime(event_time_iso, relative_day, end_text)
        elif from_match:
            start_dt = _build_relative_datetime(event_time_iso, relative_day, from_match.group("start"))
            is_open_ended = True
        else:
            return None

        if start_dt is None:
            return None

        control_mode = str(mw_down_match.group("mode") or "").strip().upper()
        cap = float(mw_down_match.group("cap"))
        plant_status = "CURTAILMENT" if control_mode == "AC" else "SHUTDOWN"
        record = {
            "kind": "window",
            "plant_status": plant_status,
            "site": site,
            "site_alias": site_alias if site_alias and site_alias.upper() != site else None,
            "start_time": start_dt,
            "end_time": end_dt,
            "is_open_ended": is_open_ended,
            "control_mode": control_mode,
            "parsed_format": "one_line_mw_down",
        }
        if plant_status == "CURTAILMENT":
            record["curtailment_capacity"] = cap
        else:
            record["shutdown_reduction_mw"] = cap
        return record

    action_match = ONE_LINE_ACTION_PATTERN.match(single_line)
    if not action_match:
        return None

    site = _normalize_site(action_match.group("site"))
    site_alias = str(action_match.group("site") or "").strip()
    if not site or site not in APPROVED_TELEMETRY_SITES:
        return None

    action = str(action_match.group("action") or "").strip().lower()
    rest = str(action_match.group("rest") or "").strip()

    if action in {"normal", "restore now", "restored"} and not rest:
        return {
            "kind": "clear_open_ended",
            "plant_status": "NORMAL",
            "site": site,
        }

    if action in {"extended", "extend", "restore delayed", "restoration delayed"}:
        delta_minutes = _parse_duration_minutes(rest)
        if delta_minutes is None:
            return None
        return {
            "kind": "window_update",
            "site": site,
            "update_action": "RESTORE_DELAY" if action in {"restore delayed", "restoration delayed"} else "EXTEND",
            "delta_minutes": delta_minutes,
            "parsed_format": "one_line_window_update",
        }

    working = rest
    relative_day = None
    day_match = re.search(r"\b(today|tomorrow)\b", working, flags=re.IGNORECASE)
    if day_match:
        relative_day = day_match.group(1).lower()
        working = re.sub(r"\b(today|tomorrow)\b", "", working, count=1, flags=re.IGNORECASE).strip()

    cap = _parse_float(working)
    control_mode = None
    if re.search(r"\bdc\b", working, flags=re.IGNORECASE):
        control_mode = "DC"
    elif re.search(r"\bac\b", working, flags=re.IGNORECASE):
        control_mode = "AC"

    normalized_action = action
    if action == "down":
        normalized_action = "curtailment" if cap is not None else "shutdown"

    if normalized_action in {"curtailment", "curtail"} and cap is None:
        return None

    range_match = re.search(
        r"\bfrom\s+(?P<start>\d{1,2}[:.]\d{2})\s+to\s+(?P<end>\d{1,2}[:.]\d{2})\b|\b(?P<start_plain>\d{1,2}[:.]\d{2})\s+to\s+(?P<end_plain>\d{1,2}[:.]\d{2})\b",
        working,
        flags=re.IGNORECASE,
    )
    from_match = re.search(r"\bfrom\s+(?P<start>\d{1,2}[:.]\d{2})\b", working, flags=re.IGNORECASE)

    start_dt = None
    end_dt = None
    is_open_ended = False
    if range_match:
        start_text = range_match.group("start") or range_match.group("start_plain")
        end_text = range_match.group("end") or range_match.group("end_plain")
        start_dt = _build_relative_datetime(event_time_iso, relative_day, start_text)
        end_dt = _build_relative_datetime(event_time_iso, relative_day, end_text)
    elif from_match:
        start_dt = _build_relative_datetime(event_time_iso, relative_day, from_match.group("start"))
        is_open_ended = True
    else:
        return None

    if start_dt is None:
        return None

    plant_status = "CURTAILMENT" if normalized_action in {"curtailment", "curtail"} or control_mode == "AC" else "SHUTDOWN"
    record = {
        "kind": "window",
        "plant_status": plant_status,
        "site": site,
        "site_alias": site_alias if site_alias and site_alias.upper() != site else None,
        "start_time": start_dt,
        "end_time": end_dt,
        "is_open_ended": is_open_ended,
        "parsed_format": "one_line_action",
    }
    if plant_status == "CURTAILMENT":
        record["curtailment_capacity"] = cap
        record["control_mode"] = "AC"
    else:
        if control_mode == "DC" and cap is not None:
            record["shutdown_reduction_mw"] = cap
        record["control_mode"] = "DC" if control_mode == "DC" else "FULL"
    return record


def _parse_site_telemetry_message(
    message: str,
    event_time_iso: str | None,
    msg_id: str,
    fallback_site_id: str | None = None,
    site_resolution_source: str | None = None,
    chat_group_name: str | None = None,
) -> dict | None:
    if not message:
        return None

    alias_map = {
        "site": "site_id_raw",
        "sitename": "site_id_raw",
        "site name": "site_id_raw",
        "date": "date_raw",
        "time": "time_raw",
        "availableac": "available_ac_raw",
        "available ac": "available_ac_raw",
        "plantcapacity": "available_ac_raw",
        "plant capacity": "available_ac_raw",
        "irradiance": "irradiance_raw",
        "radiation": "irradiance_raw",
        "activepower": "active_power_raw",
        "active power": "active_power_raw",
        "currentload": "active_power_raw",
        "current load": "active_power_raw",
        "plant active power": "active_power_raw",
        "plantactivepower": "active_power_raw",
        "generationtillnow": "generation_till_now_raw",
        "generation till now": "generation_till_now_raw",
        "maxpeakload": "max_peak_load_raw",
        "max peak load": "max_peak_load_raw",
        "weatherstatus": "weather_status_raw",
        "weather status": "weather_status_raw",
        "weathercondition": "weather_status_raw",
        "weather condition": "weather_status_raw",
    }
    supporting_fields = {
        "irradiance_raw",
        "generation_till_now_raw",
        "max_peak_load_raw",
        "weather_status_raw",
    }

    parsed: dict[str, str] = {}
    matched_keys = 0
    for raw_line in str(message).splitlines():
        kv = _split_key_value_line(raw_line)
        if kv is None:
            continue
        raw_key, raw_value = kv
        normalized_key = _normalize_field_key(raw_key)
        compact_key = _compact_field_key(raw_key)
        target_key = alias_map.get(normalized_key) or alias_map.get(compact_key)
        if not target_key:
            continue
        parsed[target_key] = raw_value
        matched_keys += 1

    if "site_id_raw" not in parsed:
        for raw_line in str(message).splitlines():
            line = str(raw_line).strip()
            if not line:
                continue
            inferred_site = _normalize_site(line)
            if inferred_site and inferred_site in APPROVED_TELEMETRY_SITES:
                parsed["site_id_raw"] = line
                break

    site_id_raw = parsed.get("site_id_raw")
    site_id = _normalize_site(site_id_raw)
    resolved_from_group = False
    if (
        (not site_id or site_id not in APPROVED_TELEMETRY_SITES)
        and fallback_site_id
        and matched_keys > 0
    ):
        site_id = fallback_site_id
        site_id_raw = site_id_raw or chat_group_name or fallback_site_id
        parsed["site_id_raw"] = site_id_raw
        resolved_from_group = True

    if not site_id or site_id not in APPROVED_TELEMETRY_SITES or matched_keys == 0:
        return None

    available_ac = _parse_numeric_value(parsed.get("available_ac_raw"))
    active_power = _parse_numeric_value(parsed.get("active_power_raw"))
    if active_power is None:
        return None

    has_supporting_field = any(parsed.get(field) for field in supporting_fields)
    if not has_supporting_field:
        return None

    if site_id != "OSEPL" and available_ac is None:
        return None

    parsed_dt = _parse_telemetry_date_time(parsed.get("date_raw"), parsed.get("time_raw"))
    event_ts = _coerce_site_telemetry_event_ts(parsed_dt, event_time_iso, msg_id)

    record = {
        "site_id": site_id,
        "site_id_raw": site_id_raw,
        "event_ts": event_ts,
        "record_type": "site_telemetry",
        "message_id": msg_id,
        "raw_message": message[:2000],
        "created_at": _now_iso(),
    }
    if chat_group_name:
        record["chat_group_name"] = chat_group_name[:255]
    if resolved_from_group and site_resolution_source:
        record["site_resolution_source"] = site_resolution_source
    elif not resolved_from_group:
        record["site_resolution_source"] = "message"
    record.update(parsed)

    irradiance = _parse_numeric_value(parsed.get("irradiance_raw"))
    generation_till_now = _parse_numeric_value(parsed.get("generation_till_now_raw"))
    max_peak_load = _parse_numeric_value(parsed.get("max_peak_load_raw"))

    if available_ac is not None:
        record["available_ac_mw"] = available_ac
    if irradiance is not None:
        record["irradiance_w_m2"] = irradiance
    if active_power is not None:
        active_power_raw = str(parsed.get("active_power_raw") or "").lower()
        if "kw" in active_power_raw:
            record["active_power_kw"] = active_power
            record["active_power_mw"] = active_power / 1000.0
        else:
            record["active_power_mw"] = active_power
            record["active_power_kw"] = active_power * 1000.0
    if generation_till_now is not None:
        record["generation_till_now_mwh"] = generation_till_now
    if max_peak_load is not None:
        record["max_peak_load_mw"] = max_peak_load

    return record


def _parse_structured_command(message: str, event_time_iso: str | None = None) -> dict | None:
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
    control_mode = str(fields.get("control mode") or fields.get("controlmode") or "").strip().upper()
    site_alias = str(fields.get("site") or "").strip()
    site = _normalize_site(site_alias)
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

    if site and site not in APPROVED_TELEMETRY_SITES:
        site = None

    if status == "NORMAL" and site and not start_dt and not end_dt:
        return {
            "kind": "clear_open_ended",
            "plant_status": status,
            "site": site,
        }

    if status in OPEN_ENDED_STATUSES and site and start_dt:
        record = {
            "kind": "window",
            "plant_status": status,
            "site": site,
            "site_alias": site_alias if site_alias and site_alias.upper() != site else None,
            "start_time": start_dt,
            "end_time": end_dt,
            "is_open_ended": end_dt is None,
        }
        if status == "CURTAILMENT":
            record["curtailment_capacity"] = cap
        elif status == "SHUTDOWN" and control_mode == "DC" and cap is not None:
            record["shutdown_reduction_mw"] = cap
        if control_mode:
            record["control_mode"] = control_mode
        return record

    return _parse_one_line_control_command(message, event_time_iso)


def _looks_like_planned_control_message(message: str | None) -> bool:
    text = re.sub(r"\s+", " ", str(message or "")).strip().lower()
    if not text or not re.search(r"\b(shutdown|curtailment|curtail|down)\b", text):
        return False
    planning_cues = (
        r"\bplanned\b",
        r"\bdated\b",
        r"\b(today|tomorrow)\b",
        r"\bfrom\b",
        r"\bto\b",
        r"\d{1,2}[:.]\d{2}",
        r"\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b",
        r"\b\d{4}-\d{1,2}-\d{1,2}\b",
    )
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in planning_cues)


def _explicit_message_dates(message: str | None) -> set:
    dates = set()
    text = str(message or "")
    for match in re.finditer(r"\b(?P<day>\d{1,2})[-/](?P<month>\d{1,2})[-/](?P<year>\d{4})\b", text):
        try:
            dates.add(datetime(int(match.group("year")), int(match.group("month")), int(match.group("day"))).date())
        except ValueError:
            continue
    for match in re.finditer(r"\b(?P<year>\d{4})-(?P<month>\d{1,2})-(?P<day>\d{1,2})\b", text):
        try:
            dates.add(datetime(int(match.group("year")), int(match.group("month")), int(match.group("day"))).date())
        except ValueError:
            continue
    return dates


def _planned_control_validation_error(message: str | None, command: dict | None) -> str | None:
    if not _looks_like_planned_control_message(message):
        return None
    if not command or str(command.get("kind") or "") != "window":
        return "Invalid planned-event format"

    start_time = command.get("start_time")
    end_time = command.get("end_time")
    if not isinstance(start_time, datetime):
        return "Planned events require an explicit start time"
    message_times = re.findall(r"\b\d{1,2}[:.]\d{2}\b", str(message or ""))
    if end_time is None and len(message_times) > 1:
        return "Invalid planned-event time range; use 'from HH:MM to HH:MM'"

    explicit_dates = _explicit_message_dates(message)
    if explicit_dates and (
        start_time.date() not in explicit_dates
        or (
            isinstance(end_time, datetime)
            and end_time.date() not in explicit_dates
        )
    ):
        return "Planned-event date was not applied to the control window"
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


def _legacy_simple_command_to_control_window(
    status: str,
    cap: float | None,
    event_time_iso: str | None,
) -> dict:
    site = _normalize_site(SITE_ID)
    if not site:
        raise ValueError("SITE_ID env var is required for simple control commands without site name")

    if status == "NORMAL":
        return {
            "kind": "clear_open_ended",
            "plant_status": "NORMAL",
            "site": site,
        }

    start_dt = _parse_datetime(event_time_iso) if event_time_iso else None
    if start_dt is None:
        start_dt = _local_now()

    return {
        "kind": "window",
        "plant_status": status,
        "site": site,
        "start_time": start_dt,
        "end_time": None,
        "is_open_ended": True,
        "curtailment_capacity": cap if status == "CURTAILMENT" else None,
        "control_mode": "AC" if status == "CURTAILMENT" else "FULL",
        "parsed_format": "legacy_simple_command",
    }


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


def _build_window_id(site: str, plant_status: str, start_time: datetime, end_time: datetime | None) -> str:
    safe_site = re.sub(r"[^A-Z0-9_-]", "_", site.upper())
    safe_status = re.sub(r"[^A-Z0-9_-]", "_", plant_status.upper())
    end_token = end_time.isoformat() if end_time is not None else "OPEN"
    return f"{safe_site}#{safe_status}#{start_time.isoformat()}#{end_token}"


def _put_state(plant_status: str, curtailment_capacity: float | None, raw_message: str | None) -> None:
    return


def _put_whatsapp_message(
    msg_id: str,
    raw_message: str | None,
    event_time_iso: str | None,
    actual_mw: float | None,
    chat_group_name: str | None = None,
    resolved_site_id: str | None = None,
    site_resolution_source: str | None = None,
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
    item["message_id"] = {"S": msg_id}
    if confidence is not None:
        item["confidence"] = {"N": f"{float(confidence):.3f}"}
    if raw_message:
        item["raw_message"] = {"S": raw_message[:512]}
    if chat_group_name:
        item["chat_group_name"] = {"S": chat_group_name[:255]}
    if resolved_site_id:
        item["resolved_site_id"] = {"S": resolved_site_id[:64]}
    if site_resolution_source:
        item["site_resolution_source"] = {"S": site_resolution_source[:64]}
    ddb.put_item(TableName=WHATSAPP_TABLE_NAME, Item=item)


def _put_site_telemetry_record(record: dict) -> None:
    if not SITE_TELEMETRY_TABLE_NAME:
        return

    item = {
        "site_id": {"S": str(record["site_id"]).strip().upper()},
        "event_ts": {"S": str(record["event_ts"])},
        "record_type": {"S": "site_telemetry"},
        "message_id": {"S": str(record["message_id"])},
        "created_at": {"S": str(record.get("created_at") or _now_iso())},
        "source": {"S": "whatsapp"},
    }

    for key, value in record.items():
        if key in item or value is None:
            continue
        if isinstance(value, (int, float)):
            item[key] = {"N": f"{float(value):.6f}"}
        else:
            item[key] = {"S": str(value)[:2000]}

    ddb.put_item(
        TableName=SITE_TELEMETRY_TABLE_NAME,
        Item=item,
        ConditionExpression="attribute_not_exists(site_id) AND attribute_not_exists(event_ts)",
    )


def _put_control_window(command: dict, raw_message: str | None) -> str:
    if not CONTROL_WINDOWS_TABLE:
        raise RuntimeError("CONTROL_WINDOWS_TABLE env var not set")

    plant_status = command["plant_status"]
    site = command["site"]
    site_alias = str(command.get("site_alias") or "").strip()
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
    if site_alias and site_alias.upper() != site:
        item["site_alias"] = {"S": site_alias[:128]}
    cap = command.get("curtailment_capacity")
    shutdown_reduction_mw = command.get("shutdown_reduction_mw")
    if plant_status == "CURTAILMENT":
        if cap is None:
            raise ValueError("Curtailment window requires a MW value")
        item["curtailment_capacity"] = {"N": f"{cap:.3f}"}
    elif plant_status == "SHUTDOWN" and str(command.get("control_mode") or "").strip().upper() == "DC":
        if shutdown_reduction_mw is None:
            raise ValueError("DC shutdown window requires a MW reduction value")
        item["shutdown_reduction_mw"] = {"N": f"{float(shutdown_reduction_mw):.3f}"}
    control_mode = command.get("control_mode")
    if control_mode:
        item["control_mode"] = {"S": str(control_mode)}
    parsed_format = command.get("parsed_format")
    if parsed_format:
        item["parsed_format"] = {"S": str(parsed_format)}
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
            UpdateExpression=(
                "SET active = :false, "
                "cleared_at = :cleared_at, "
                "cleared_by = :cleared_by, "
                "pending_normal_restore = :true, "
                "pending_normal_restore_at = :cleared_at, "
                "updated_at = :updated_at "
                "REMOVE schedule_triggered_at, last_applied_run_ts, last_applied_reference_block"
            ),
            ExpressionAttributeValues={
                ":false": {"BOOL": False},
                ":true": {"BOOL": True},
                ":cleared_at": {"S": now_iso},
                ":cleared_by": {"S": (raw_message or "NORMAL")[:512]},
                ":updated_at": {"S": now_iso},
            },
        )
        cleared_ids.append(window_id)

    return cleared_ids


def _update_active_control_window(site: str, delta_minutes: int, raw_message: str | None) -> dict:
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
    candidate_item = None
    candidate_start = None

    for item in resp.get("Items", []) or []:
        item_site = _normalize_site((item.get("site") or {}).get("S"))
        if item_site != site_token:
            continue
        status = _normalize_status((item.get("plant_status") or {}).get("S"))
        if status not in OPEN_ENDED_STATUSES:
            continue
        is_active = True if "active" not in item else bool((item.get("active") or {}).get("BOOL"))
        if not is_active:
            continue
        end_time_text = (item.get("end_time") or {}).get("S")
        if not end_time_text:
            continue
        start_time_text = (item.get("start_time") or {}).get("S")
        start_time = _parse_iso_dt(start_time_text)
        if start_time is None:
            continue
        if candidate_start is None or start_time > candidate_start:
            candidate_item = item
            candidate_start = start_time

    if candidate_item is None:
        raise ValueError("No active planned control window found for the site")

    window_id = (candidate_item.get("window_id") or {}).get("S")
    if not window_id:
        raise ValueError("Active planned control window is missing window_id")

    current_end_text = (candidate_item.get("end_time") or {}).get("S")
    current_end = _parse_iso_dt(current_end_text)
    if current_end is None:
        raise ValueError("Active planned control window does not have a valid end time")

    new_end = current_end + timedelta(minutes=int(delta_minutes))
    now_iso = _now_iso()
    ddb.update_item(
        TableName=CONTROL_WINDOWS_TABLE,
        Key={
            "plant_id": {"S": PLANT_ID},
            "window_id": {"S": window_id},
        },
        UpdateExpression="SET end_time = :end_time, updated_at = :updated_at, last_message = :last_message",
        ExpressionAttributeValues={
            ":end_time": {"S": new_end.isoformat()},
            ":updated_at": {"S": now_iso},
            ":last_message": {"S": (raw_message or "")[:512]},
        },
    )
    return {
        "window_id": window_id,
        "site": site_token,
        "plant_status": _normalize_status((candidate_item.get("plant_status") or {}).get("S")),
        "previous_end_time": current_end.isoformat(),
        "end_time": new_end.isoformat(),
        "delta_minutes": int(delta_minutes),
    }


def lambda_handler(event, context):
    verification = _verify_webhook(event)
    if verification is not None:
        return verification

    is_tasker_request = _has_valid_tasker_token(event)

    if not is_tasker_request and not _validate_meta_signature(event):
        print(
            "[WHATSAPP_DEBUG] rejected_request "
            f"is_tasker_request={is_tasker_request} "
            f"snapshot={_event_debug_snapshot(event)}"
        )
        return {
            "statusCode": 403,
            "body": json.dumps({"ok": False, "error": "Invalid signature"}),
        }

    payload = _parse_body(event)
    message = _extract_message(payload)
    chat_group_name = _extract_chat_group_name(payload)
    msg_id = _extract_message_id(payload) or hashlib.sha256((message or _now_iso()).encode("utf-8")).hexdigest()[:32]
    event_time_iso = _extract_event_time(payload)
    actual_mw = _parse_actual_mw(message or "")
    fallback_site_id = _resolve_single_site_group(chat_group_name)

    print(
        "[WHATSAPP_DEBUG] extracted "
        f"is_tasker_request={is_tasker_request} "
        f"payload_keys={sorted(list(payload.keys())) if isinstance(payload, dict) else type(payload).__name__} "
        f"chat_group_name={repr(chat_group_name)} "
        f"fallback_site_id={repr(fallback_site_id)} "
        f"message_preview={repr((message or '')[:200])} "
        f"actual_mw={repr(actual_mw)} "
        f"event_time_iso={repr(event_time_iso)}"
    )

    telemetry = _parse_site_telemetry_message(
        message or "",
        event_time_iso,
        msg_id,
        fallback_site_id=fallback_site_id,
        site_resolution_source="group_fallback" if fallback_site_id else None,
        chat_group_name=chat_group_name,
    )

    if telemetry is not None:
        print(
            "[WHATSAPP_DEBUG] telemetry_parsed "
            f"site_id={repr(telemetry.get('site_id'))} "
            f"site_resolution_source={repr(telemetry.get('site_resolution_source'))} "
            f"active_power_raw={repr(telemetry.get('active_power_raw'))} "
            f"weather_status_raw={repr(telemetry.get('weather_status_raw'))} "
            f"available_ac_raw={repr(telemetry.get('available_ac_raw'))}"
        )
    else:
        print(
            "[WHATSAPP_DEBUG] telemetry_not_parsed "
            f"chat_group_name={repr(chat_group_name)} "
            f"fallback_site_id={repr(fallback_site_id)} "
            f"message_preview={repr((message or '')[:200])}"
        )

    resolved_site_id = telemetry["site_id"] if telemetry is not None else None
    resolution_source = telemetry.get("site_resolution_source") if telemetry is not None else None

    # Additive telemetry persistence path for fallback metered logic.
    try:
        _put_whatsapp_message(
            msg_id=msg_id,
            raw_message=message,
            event_time_iso=event_time_iso,
            actual_mw=actual_mw,
            chat_group_name=chat_group_name,
            resolved_site_id=resolved_site_id,
            site_resolution_source=resolution_source,
            confidence=1.0,
        )
    except Exception:
        pass

    if telemetry is not None:
        try:
            _put_site_telemetry_record(telemetry)
        except Exception as exc:
            print(f"[WHATSAPP_DEBUG] telemetry_save_failed error={exc!r}")
            return {
                "statusCode": 500,
                "body": json.dumps({"ok": False, "error": f"Failed to save site telemetry: {exc}"}),
            }
        print(
            "[WHATSAPP_DEBUG] telemetry_saved "
            f"site_id={repr(telemetry.get('site_id'))} "
            f"event_ts={repr(telemetry.get('event_ts'))}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "ok": True,
                    "mode": "site_telemetry",
                    "site_id": telemetry["site_id"],
                    "event_ts": telemetry["event_ts"],
                    "table_name": SITE_TELEMETRY_TABLE_NAME,
                }
            ),
        }

    structured = _parse_structured_command(message or "", event_time_iso)
    planned_validation_error = _planned_control_validation_error(message, structured)
    if planned_validation_error:
        return {
            "statusCode": 400,
            "body": json.dumps(
                {
                    "ok": False,
                    "error": planned_validation_error,
                }
            ),
        }

    if structured is not None:
        if structured["kind"] == "clear_open_ended":
            cleared_ids = _clear_open_ended_controls(structured["site"], message)
            scheduler_info = {
                "invoked": False,
                "reason": "fetcher_owns_dispatch" if cleared_ids else "no_open_ended_controls_cleared",
            }
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
                        "scheduler_invoked": bool(scheduler_info.get("invoked")),
                        "scheduler_trigger_reason": scheduler_info.get("reason"),
                        "scheduler_function_name": scheduler_info.get("function_name"),
                        "scheduler_engine_block_ref": scheduler_info.get("engine_block_ref"),
                        "scheduler_run_ts_ist": scheduler_info.get("run_ts_ist"),
                    }
                ),
            }

        if structured["kind"] == "window_update":
            try:
                update_info = _update_active_control_window(
                    structured["site"],
                    int(structured["delta_minutes"]),
                    message,
                )
            except ValueError as exc:
                return {
                    "statusCode": 400,
                    "body": json.dumps({"ok": False, "error": str(exc)}),
                }
            scheduler_info = {"invoked": False, "reason": "fetcher_owns_dispatch"}
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {
                        "ok": True,
                        "mode": "control_window_update",
                        "plant_id": PLANT_ID,
                        "site": update_info["site"],
                        "plant_status": update_info["plant_status"],
                        "window_id": update_info["window_id"],
                        "previous_end_time": update_info["previous_end_time"],
                        "end_time": update_info["end_time"],
                        "delta_minutes": update_info["delta_minutes"],
                        "update_action": structured["update_action"],
                        "scheduler_invoked": bool(scheduler_info.get("invoked")),
                        "scheduler_trigger_reason": scheduler_info.get("reason"),
                        "scheduler_function_name": scheduler_info.get("function_name"),
                        "scheduler_engine_block_ref": scheduler_info.get("engine_block_ref"),
                        "scheduler_run_ts_ist": scheduler_info.get("run_ts_ist"),
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

        scheduler_info = {"invoked": False, "reason": "fetcher_owns_dispatch"}

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

    try:
        legacy_command = _legacy_simple_command_to_control_window(status, cap, event_time_iso)
    except ValueError as exc:
        return {
            "statusCode": 400,
            "body": json.dumps({"ok": False, "error": str(exc)}),
        }

    if legacy_command["kind"] == "clear_open_ended":
        cleared_ids = _clear_open_ended_controls(legacy_command["site"], message)
        scheduler_info = {
            "invoked": False,
            "reason": "fetcher_owns_dispatch" if cleared_ids else "no_open_ended_controls_cleared",
        }
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "ok": True,
                    "mode": "control_window_clear",
                    "plant_id": PLANT_ID,
                    "site": legacy_command["site"],
                    "cleared_count": len(cleared_ids),
                    "cleared_window_ids": cleared_ids,
                    "scheduler_invoked": bool(scheduler_info.get("invoked")),
                    "scheduler_trigger_reason": scheduler_info.get("reason"),
                    "scheduler_function_name": scheduler_info.get("function_name"),
                    "scheduler_engine_block_ref": scheduler_info.get("engine_block_ref"),
                    "scheduler_run_ts_ist": scheduler_info.get("run_ts_ist"),
                }
            ),
        }

    try:
        window_id = _put_control_window(legacy_command, message)
    except ValueError as exc:
        return {
            "statusCode": 400,
            "body": json.dumps({"ok": False, "error": str(exc)}),
        }

    scheduler_info = {"invoked": False, "reason": "fetcher_owns_dispatch"}

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "ok": True,
                "mode": "control_window",
                "plant_id": PLANT_ID,
                "window_id": window_id,
                "site": legacy_command["site"],
                "plant_status": legacy_command["plant_status"],
                "start_time": legacy_command["start_time"].isoformat(),
                "end_time": None,
                "is_open_ended": True,
                "curtailment_capacity": legacy_command.get("curtailment_capacity"),
                "scheduler_invoked": bool(scheduler_info.get("invoked")),
                "scheduler_trigger_reason": scheduler_info.get("reason"),
                "scheduler_function_name": scheduler_info.get("function_name"),
                "scheduler_engine_block_ref": scheduler_info.get("engine_block_ref"),
                "scheduler_run_ts_ist": scheduler_info.get("run_ts_ist"),
            }
        ),
    }
