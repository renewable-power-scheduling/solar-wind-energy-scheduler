from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:
    boto3 = None

from cloud.common.config_loader import load_site_config
from cloud.common.paths import OUTPUTS_ROOT

IST = ZoneInfo("Asia/Kolkata")
BUCKET = str(os.getenv("BUCKET", "")).strip()
PLANT_ID = str(os.getenv("PLANT_ID", "vedanjay")).strip() or "vedanjay"
SITE_TELEMETRY_TABLE_NAME = str(os.getenv("SITE_TELEMETRY_TABLE_NAME", "")).strip()
TELEMETRY_MAX_AGE_MINUTES = 120
DEFAULT_REGEN_MIN_DEVIATION_MW = 0.2
DEFAULT_REGEN_COOLDOWN_BLOCKS = 1


def _parse_iso_dt(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    try:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=IST)
        return parsed.astimezone(IST)
    except Exception:
        return None


def _timestamp_to_block_ist(run_ts_ist: datetime) -> int:
    mins = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, 1 + (mins // 15)))


def _item_to_python(item: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (item or {}).items():
        if "S" in value:
            out[key] = value["S"]
        elif "N" in value:
            try:
                out[key] = float(value["N"])
            except Exception:
                out[key] = value["N"]
        elif "BOOL" in value:
            out[key] = bool(value["BOOL"])
        else:
            out[key] = value
    return out


def _fetch_latest_whatsapp_actual(site_id: str, now_ist: datetime) -> dict[str, Any] | None:
    if not SITE_TELEMETRY_TABLE_NAME or boto3 is None:
        return None
    site_token = str(site_id).strip().upper()
    try:
        resp = boto3.client("dynamodb").query(
            TableName=SITE_TELEMETRY_TABLE_NAME,
            KeyConditionExpression="site_id = :site_id",
            ExpressionAttributeValues={":site_id": {"S": site_token}},
            ScanIndexForward=False,
            Limit=25,
        )
    except Exception:
        return None

    best: dict[str, Any] | None = None
    best_ts: datetime | None = None
    for raw in (resp.get("Items", []) or []):
        row = _item_to_python(raw)
        row_site = str(row.get("site_id") or "").strip().upper()
        if row_site != site_token:
            continue
        ts = _parse_iso_dt(row.get("event_ts"))
        if ts is None:
            continue
        age_min = (now_ist - ts).total_seconds() / 60.0
        if age_min > TELEMETRY_MAX_AGE_MINUTES or age_min < -2:
            continue
        try:
            actual_mw = float(row.get("active_power_mw"))
        except Exception:
            continue
        if best is None or (best_ts is not None and ts > best_ts):
            best = {
                "message_id": str(row.get("message_id") or row.get("event_ts") or "").strip(),
                "timestamp": ts,
                "actual_mw": actual_mw,
            }
            best_ts = ts
    return best


def _output_day(site_id: str, run_date: str, local_env: dict[str, Any] | None) -> Path:
    custom_base = str((local_env or {}).get("CUSTOM_OUTPUT_BASE") or "").strip()
    if custom_base:
        return Path(custom_base) / str(run_date)
    return OUTPUTS_ROOT / str(site_id).strip().upper() / str(run_date)


def _generated_output_prefix(site_id: str, run_date: str) -> str:
    return f"generated/{PLANT_ID}/{str(site_id).strip().upper()}/outputs/{run_date}/"


def _load_engine_state(site_id: str, run_date: str, local_env: dict[str, Any] | None) -> dict[str, Any]:
    state_path = _output_day(site_id, run_date, local_env) / "engine_state.json"
    if state_path.exists():
        try:
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                return payload
        except Exception:
            pass
    if not BUCKET or boto3 is None:
        return {}
    key = f"{_generated_output_prefix(site_id, run_date)}engine_state.json"
    try:
        body = boto3.client("s3").get_object(Bucket=BUCKET, Key=key)["Body"].read()
        payload = json.loads(body.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _latest_schedule_file(site_id: str, run_date: str, local_env: dict[str, Any] | None) -> Path | None:
    output_day = _output_day(site_id, run_date, local_env)
    candidates = sorted(
        [path for path in output_day.glob("schedule_from_*.csv") if path.is_file()],
        key=lambda path: path.stat().st_mtime,
    )
    return candidates[-1] if candidates else None


def _schedule_value_for_block(schedule_file: Path | None, block: int) -> float | None:
    if schedule_file is None or not schedule_file.exists():
        return None
    try:
        with schedule_file.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                try:
                    if int(row.get("block") or 0) != int(block):
                        continue
                    return float(row.get("algo_schedule_mw"))
                except Exception:
                    continue
    except Exception:
        return None
    return None


def _latest_schedule_s3_key(site_id: str, run_date: str) -> str | None:
    if not BUCKET or boto3 is None:
        return None
    prefix = _generated_output_prefix(site_id, run_date)
    latest_key = None
    latest_modified = None
    try:
        paginator = boto3.client("s3").get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            for item in page.get("Contents", []) or []:
                key = str(item.get("Key") or "")
                name = Path(key).name
                if "/Day-ahead/" in key or not (name.startswith("schedule_from_") and name.endswith(".csv")):
                    continue
                modified = item.get("LastModified")
                if latest_key is None or (
                    latest_modified is not None
                    and modified is not None
                    and modified > latest_modified
                ):
                    latest_key = key
                    latest_modified = modified
    except Exception:
        return None
    return latest_key


def _schedule_value_for_block_s3(site_id: str, run_date: str, block: int) -> float | None:
    key = _latest_schedule_s3_key(site_id, run_date)
    if not key or not BUCKET or boto3 is None:
        return None
    try:
        body = boto3.client("s3").get_object(Bucket=BUCKET, Key=key)["Body"].read()
        text = body.decode("utf-8-sig")
        for row in csv.DictReader(io.StringIO(text)):
            try:
                if int(row.get("block") or 0) != int(block):
                    continue
                return float(row.get("algo_schedule_mw"))
            except Exception:
                continue
    except Exception:
        return None
    return None


def _penalty_band_mw(site_id: str) -> float:
    cfg = load_site_config(site_id)
    plant_capacity_mw = float(cfg.get("plant_capacity_mw") or 0.0)
    penalty_band_pct = float(cfg.get("penalty_band_pct") or 0.0)
    band_frac = penalty_band_pct / 100.0 if penalty_band_pct > 1.0 else penalty_band_pct
    return float(plant_capacity_mw) * float(band_frac)


def _regen_thresholds(site_id: str) -> tuple[float, int]:
    cfg = load_site_config(site_id)
    sched = cfg.get("scheduling_parameters") if isinstance(cfg, dict) else {}
    min_dev = float((sched or {}).get("regen_min_deviation_mw", DEFAULT_REGEN_MIN_DEVIATION_MW))
    cooldown = int((sched or {}).get("regen_cooldown_blocks", DEFAULT_REGEN_COOLDOWN_BLOCKS))
    return min_dev, cooldown


def assess_whatsapp_out_of_band(
    *,
    site_id: str,
    run_ts_ist: datetime,
    run_date: str,
    current_block: int,
    decision_state: dict[str, Any] | None = None,
    local_env: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    latest = _fetch_latest_whatsapp_actual(site_id, run_ts_ist)
    if latest is None:
        return None

    engine_state = _load_engine_state(site_id, run_date, local_env)
    if str(engine_state.get("engine_state") or "") != "STATE_ACTIVE_SCHEDULE_RUNNING":
        return {
            "triggered": False,
            "message_id": latest["message_id"],
            "reason": "engine_not_active",
        }
    if not bool(engine_state.get("schedule_exists")):
        return {
            "triggered": False,
            "message_id": latest["message_id"],
            "reason": "schedule_missing",
        }
    if str(engine_state.get("meter_mode") or "") != "NO_METER_FALLBACK":
        return {
            "triggered": False,
            "message_id": latest["message_id"],
            "reason": "metered_data_available",
        }

    state_ref = dict(engine_state)
    state_ref.update(dict(decision_state or {}))
    msg_id = str(latest.get("message_id") or "").strip()
    if not msg_id:
        return None
    if msg_id == str(state_ref.get("last_whatsapp_msg_id") or "").strip():
        return {
            "triggered": False,
            "message_id": msg_id,
            "reason": "duplicate_message",
        }

    msg_block = _timestamp_to_block_ist(latest["timestamp"])
    sched_ref = _schedule_value_for_block(_latest_schedule_file(site_id, run_date, local_env), msg_block)
    if sched_ref is None:
        sched_ref = _schedule_value_for_block_s3(site_id, run_date, msg_block)
    if sched_ref is None:
        return {
            "triggered": False,
            "message_id": msg_id,
            "reason": "schedule_block_missing",
        }

    band_mw = _penalty_band_mw(site_id)
    min_allowed = float(latest["actual_mw"]) - band_mw
    max_allowed = float(latest["actual_mw"]) + band_mw
    out_of_band = float(sched_ref) < min_allowed or float(sched_ref) > max_allowed
    min_dev_mw, cooldown_blocks = _regen_thresholds(site_id)
    deviation_ok = abs(float(sched_ref) - float(latest["actual_mw"])) >= float(min_dev_mw)
    last_regen_block = int(state_ref.get("last_whatsapp_regen_block", -999))
    cooldown_ok = (int(current_block) - last_regen_block) > int(cooldown_blocks)

    return {
        "triggered": bool(out_of_band and deviation_ok and cooldown_ok),
        "message_id": msg_id,
        "timestamp_ist": latest["timestamp"].isoformat(),
        "generation_mw": float(latest["actual_mw"]),
        "msg_block": int(msg_block),
        "schedule_mw": float(sched_ref),
        "band_mw": float(band_mw),
        "min_allowed_mw": float(min_allowed),
        "max_allowed_mw": float(max_allowed),
        "deviation_ok": bool(deviation_ok),
        "cooldown_ok": bool(cooldown_ok),
        "out_of_band": bool(out_of_band),
        "reason": "whatsapp_out_of_band_adjustment" if (out_of_band and deviation_ok and cooldown_ok) else "within_band",
    }
