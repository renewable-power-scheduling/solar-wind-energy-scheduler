from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:
    boto3 = None


IST = ZoneInfo("Asia/Kolkata")
CONTROL_WINDOWS_TABLE = str(os.getenv("CONTROL_WINDOWS_TABLE", "")).strip()
PLANT_ID = str(os.getenv("PLANT_ID", "vedanjay")).strip() or "vedanjay"
ddb = boto3.client("dynamodb") if boto3 is not None else None
PLANNED_CONTROL_PRESTART_MINUTES = int(str(os.getenv("PLANNED_CONTROL_PRESTART_MINUTES", "60")).strip() or "60")
SITE_ALIASES = {
    "OSEL": "OSEPL",
    "20 MW OSMANABAD SOLAR ENERGY LTD, HORTI": "OSEPL",
    "ANJANGAON": "ANJANGOAN",
    "ANJANGAON SITE": "ANJANGOAN",
    "BHAMKAL": "BAMKHAL",
    "SAWADA": "SAWDA",
    "SAWDA": "SAWDA",
    "BHPL": "BHUPALPALLY",
    "KSPT": "KASIPET",
    "KASI": "KASIPET",
    "KOTHA": "KOTHAGUDEM",
    "KTGDM": "KOTHAGUDEM",
    "SIRM": "SIRMOUR",
    "NANDA": "NANDGAON",
    "BAMK": "BAMKHAL",
    "SAWD": "SAWDA",
}


def _canonical_site_id(value: str | None) -> str:
    raw = str(value or "").strip().upper()
    if not raw:
        return ""
    compact = " ".join(raw.split())
    return SITE_ALIASES.get(compact) or compact


def _parse_ddb_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=IST)
        return parsed.astimezone(IST)
    except Exception:
        return None


def _planned_window_due_for_schedule(start_dt: datetime, end_dt: datetime | None, run_ts_ist: datetime) -> bool:
    if end_dt is not None and run_ts_ist >= end_dt:
        return False
    if start_dt.date() > run_ts_ist.date():
        return False
    due_at = start_dt - timedelta(minutes=PLANNED_CONTROL_PRESTART_MINUTES)
    return run_ts_ist >= due_at


def load_pending_planned_windows(site_id: str, run_ts_ist: datetime) -> list[dict[str, Any]]:
    if not CONTROL_WINDOWS_TABLE or ddb is None:
        return []

    site_token = _canonical_site_id(site_id)
    if not site_token:
        return []

    try:
        resp = ddb.query(
            TableName=CONTROL_WINDOWS_TABLE,
            KeyConditionExpression="#pk = :pk",
            ExpressionAttributeNames={"#pk": "plant_id"},
            ExpressionAttributeValues={":pk": {"S": PLANT_ID}},
            ConsistentRead=True,
        )
    except Exception:
        return []

    pending: list[dict[str, Any]] = []
    for item in resp.get("Items", []) or []:
        item_site = _canonical_site_id((item.get("site") or {}).get("S"))
        if item_site not in {site_token, "ALL"}:
            continue

        is_active = True if "active" not in item else bool((item.get("active") or {}).get("BOOL"))
        pending_normal_restore = bool((item.get("pending_normal_restore") or {}).get("BOOL"))

        plant_status = str((item.get("plant_status") or {}).get("S") or "").strip().upper()
        if pending_normal_restore and not is_active:
            plant_status = "NORMAL"
        elif plant_status not in {"SHUTDOWN", "CURTAILMENT"}:
            continue
        elif not is_active:
            continue

        start_dt = _parse_ddb_datetime((item.get("start_time") or {}).get("S"))
        if start_dt is None:
            continue

        end_dt = _parse_ddb_datetime((item.get("end_time") or {}).get("S"))
        if plant_status == "NORMAL":
            cleared_dt = _parse_ddb_datetime((item.get("pending_normal_restore_at") or {}).get("S"))
            if cleared_dt is not None and run_ts_ist < cleared_dt:
                continue
        elif not _planned_window_due_for_schedule(start_dt, end_dt, run_ts_ist):
            continue

        window_id = str((item.get("window_id") or {}).get("S") or "").strip()
        if not window_id:
            continue

        if str((item.get("schedule_triggered_at") or {}).get("S") or "").strip():
            continue

        pending.append(
            {
                "window_id": window_id,
                "site": item_site,
                "plant_status": plant_status,
                "start_time": start_dt.isoformat(),
                "end_time": end_dt.isoformat() if end_dt is not None else None,
            }
        )

    pending.sort(key=lambda row: (str(row.get("start_time") or ""), str(row.get("window_id") or "")))
    return pending
