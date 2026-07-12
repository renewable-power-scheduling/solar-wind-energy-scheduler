from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd


def current_block_key_ist(now_ist: datetime) -> str:
    floored = now_ist.replace(
        minute=(now_ist.minute // 15) * 15,
        second=0,
        microsecond=0,
    )
    return floored.isoformat()


def resolve_engine_now_ist(ist: ZoneInfo, logger) -> datetime:
    raw = os.getenv("ENGINE_NOW_IST", "").strip()
    if raw:
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=ist)
            return parsed.astimezone(ist)
        except Exception:
            logger.warning("Invalid ENGINE_NOW_IST=%r; falling back to current IST time", raw)
    return datetime.now(ist)


def parse_ist_datetime(raw: object, ist: ZoneInfo) -> datetime | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=ist)
    return parsed.astimezone(ist)


def resolve_intraday_arrival_ist(path: Path, ist: ZoneInfo) -> datetime | None:
    meta_candidates = [
        path.with_suffix(".meta.json"),
        path.with_name(f"{path.stem}.meta.json"),
    ]
    for meta_path in meta_candidates:
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for key in ("fetched_at_ist", "arrival_timestamp_ist", "arrival_time_ist", "arrival_time", "fetched_at"):
            parsed = parse_ist_datetime(meta.get(key), ist)
            if parsed is not None:
                return parsed
    name = path.name
    match = None
    import re

    for pattern in (
        r"(\d{4}-\d{2}-\d{2})[-_](\d{2})[-_:](\d{2})",
        r"(\d{8})[-_](\d{2})[-_:](\d{2})",
    ):
        match = re.search(pattern, name)
        if match:
            break
    if not match:
        return None
    date_token = match.group(1)
    hour = int(match.group(2))
    minute = int(match.group(3))
    if len(date_token) == 8:
        parsed_date = datetime.strptime(date_token, "%Y%m%d").date()
    else:
        parsed_date = datetime.strptime(date_token, "%Y-%m-%d").date()
    return datetime(parsed_date.year, parsed_date.month, parsed_date.day, hour, minute, tzinfo=ist)


def resolve_run_context_id() -> str:
    raw = os.getenv("RUN_CONTEXT_ID", "").strip()
    if raw:
        return raw
    generated = str(uuid.uuid4())
    os.environ["RUN_CONTEXT_ID"] = generated
    return generated


def parse_iso_dt(value, ist: ZoneInfo) -> datetime | None:
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=ist)
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=ist)
    return parsed.astimezone(ist)


def item_to_python(item: dict) -> dict:
    out = {}
    for key, value in (item or {}).items():
        if not isinstance(value, dict):
            out[key] = value
            continue
        if "S" in value:
            out[key] = value.get("S")
        elif "N" in value:
            raw = value.get("N")
            try:
                out[key] = float(raw)
            except Exception:
                out[key] = raw
        elif "BOOL" in value:
            out[key] = bool(value.get("BOOL"))
        else:
            out[key] = value
    return out


def fetch_latest_whatsapp_actual(
    *,
    site_id: str,
    now_ist: datetime,
    table_name: str,
    boto3_module,
    ist: ZoneInfo,
) -> dict | None:
    if not table_name or boto3_module is None:
        return None
    try:
        ddb = boto3_module.client("dynamodb")
        response = ddb.scan(TableName=table_name, Limit=200)
    except Exception:
        return None
    best = None
    best_ts = None
    for raw in (response.get("Items", []) or []):
        row = item_to_python(raw)
        row_site = str(row.get("site_id") or row.get("site") or "").strip().upper()
        if row_site and row_site != site_id.strip().upper():
            continue
        ts = parse_iso_dt(row.get("timestamp") or row.get("event_time") or row.get("received_at"), ist)
        if ts is None:
            continue
        age_min = (now_ist - ts).total_seconds() / 60.0
        if age_min > 120 or age_min < -2:
            continue
        try:
            mw_val = float(row.get("actual_mw"))
        except Exception:
            continue
        if best is None or (best_ts is not None and ts > best_ts):
            best = {
                "timestamp": ts,
                "actual_mw": mw_val,
                "msg_id": str(row.get("message_id") or row.get("timestamp") or ""),
            }
            best_ts = ts
    return best


def schedule_value_for_block(schedule_file: Path | None, block: int) -> float | None:
    if schedule_file is None or not schedule_file.exists():
        return None
    try:
        frame = pd.read_csv(schedule_file)
    except Exception:
        return None
    if "block" not in frame.columns or "algo_schedule_mw" not in frame.columns:
        return None
    row = frame[frame["block"] == int(block)]
    if row.empty:
        return None
    try:
        return float(row.iloc[-1]["algo_schedule_mw"])
    except Exception:
        return None
