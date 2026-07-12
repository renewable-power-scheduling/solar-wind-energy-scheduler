from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

try:
    import boto3
except ImportError:
    boto3 = None

try:
    from boto3.dynamodb.conditions import Key
except Exception:
    Key = None

from cloud.common.capacity import effective_capacity_ac_mw, resolve_capacity_config


def normalize_status(status: str | None) -> str:
    if not status:
        return "NORMAL"
    s = str(status).strip().upper()
    return s if s in {"NORMAL", "CURTAILMENT", "SHUTDOWN"} else "NORMAL"


CONTROL_SITE_ALIASES = {
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


def normalize_control_site(site_id: str | None) -> str:
    cleaned = " ".join(str(site_id or "").strip().upper().split())
    if not cleaned:
        return "ALL"
    return CONTROL_SITE_ALIASES.get(cleaned, cleaned)


def ddb_number(item: dict, key: str) -> float | None:
    attr = (item or {}).get(key)
    if attr and "N" in attr:
        try:
            return float(attr["N"])
        except Exception:
            return None
    return None


def ddb_string(item: dict, key: str, default: str | None = None) -> str | None:
    attr = (item or {}).get(key)
    value = attr.get("S") if attr and "S" in attr else default
    if value is None:
        return None
    text = str(value).strip()
    return text or default


def default_control_mode(status: str | None) -> str:
    normalized = normalize_status(status)
    if normalized == "CURTAILMENT":
        return "AC"
    if normalized == "SHUTDOWN":
        return "FULL"
    return "NORMAL"


def normalize_control_mode(control_mode: str | None, plant_status: str | None) -> str:
    mode = str(control_mode or "").strip().upper()
    if mode in {"AC", "DC", "FULL", "NORMAL"}:
        return mode
    return default_control_mode(plant_status)


def clamp_ac_capacity(value: float, site_ac_capacity_mw: float) -> float:
    return max(0.0, min(float(value), float(site_ac_capacity_mw)))


def effective_control_capacity_ac(
    *,
    plant_status: str | None,
    control_mode: str | None = None,
    curtailment_capacity: float | None = None,
    shutdown_reduction_mw: float | None = None,
    site_ac_capacity_mw: float,
    site_dc_capacity_mw: float,
    dc_ac_ratio: float,
) -> tuple[float | None, str]:
    status = normalize_status(plant_status)
    mode = normalize_control_mode(control_mode, status)

    if status == "SHUTDOWN" and mode == "DC":
        if shutdown_reduction_mw is None:
            return 0.0, "SHUTDOWN"
        remaining_dc = max(float(site_dc_capacity_mw) - float(shutdown_reduction_mw), 0.0)
        effective_ac = remaining_dc / float(dc_ac_ratio) if float(dc_ac_ratio) > 0.0 else 0.0
        return clamp_ac_capacity(effective_ac, site_ac_capacity_mw), "PARTIAL_SHUTDOWN"

    if status == "SHUTDOWN":
        return 0.0, "SHUTDOWN"

    if status == "CURTAILMENT":
        if curtailment_capacity is None:
            return None, "CURTAILMENT"
        return clamp_ac_capacity(float(curtailment_capacity), site_ac_capacity_mw), "CURTAILMENT"

    return None, "NORMAL"


def control_capacity_metadata(
    *,
    plant_status: str | None,
    control_mode: str | None,
    curtailment_capacity: float | None,
    shutdown_reduction_mw: float | None,
    effective_control_capacity_ac_mw: float | None,
    control_type: str | None,
    site_ac_capacity_mw: float,
    site_dc_capacity_mw: float,
    dc_ac_ratio: float,
) -> dict:
    return {
        "plant_status": normalize_status(plant_status),
        "control_mode": normalize_control_mode(control_mode, plant_status),
        "control_type": str(control_type or normalize_status(plant_status)),
        "curtailment_capacity_mw": (
            float(curtailment_capacity) if curtailment_capacity is not None else None
        ),
        "shutdown_reduction_mw": (
            float(shutdown_reduction_mw) if shutdown_reduction_mw is not None else None
        ),
        "effective_control_capacity_ac_mw": (
            float(effective_control_capacity_ac_mw)
            if effective_control_capacity_ac_mw is not None
            else None
        ),
        "site_ac_capacity_mw": float(site_ac_capacity_mw),
        "site_dc_capacity_mw": float(site_dc_capacity_mw),
        "dc_ac_ratio": float(dc_ac_ratio),
    }


def _control_state_get_item(ddb, table_name: str, plant_id: str, site_id: str) -> dict | None:
    desc = ddb.describe_table(TableName=table_name)
    key_schema = desc.get("Table", {}).get("KeySchema", []) or []
    key_names = {str(k.get("AttributeName")) for k in key_schema if k.get("AttributeName")}

    if "site" in key_names:
        site_token = normalize_control_site(site_id)
        keys_to_try = [
            {"plant_id": {"S": plant_id}, "site": {"S": site_token}},
            {"plant_id": {"S": plant_id}, "site": {"S": "ALL"}},
        ]
        for key in keys_to_try:
            resp = ddb.get_item(TableName=table_name, Key=key, ConsistentRead=True)
            item = resp.get("Item")
            if item:
                return item
        return None

    resp = ddb.get_item(
        TableName=table_name,
        Key={"plant_id": {"S": plant_id}},
        ConsistentRead=True,
    )
    return resp.get("Item")


def load_control_state(
    *,
    site_id: str,
    table_name: str | None,
    logger,
    plant_id: str,
) -> dict:
    if not table_name:
        return {
            "plant_status": "NORMAL",
            "curtailment_capacity": None,
            "control_mode": "NORMAL",
            "shutdown_reduction_mw": None,
            "source": "env_missing",
        }
    if boto3 is None:
        logger.warning("boto3 is not installed; skipping DynamoDB control state load")
        return {
            "plant_status": "NORMAL",
            "curtailment_capacity": None,
            "control_mode": "NORMAL",
            "shutdown_reduction_mw": None,
            "source": "boto3_missing",
        }

    try:
        ddb = boto3.client("dynamodb")
        item = _control_state_get_item(ddb, table_name, plant_id, site_id)
        if not item:
            return {
                "plant_status": "NORMAL",
                "curtailment_capacity": None,
                "control_mode": "NORMAL",
                "shutdown_reduction_mw": None,
                "source": "ddb_empty",
            }

        site_states = (item.get("site_states") or {}).get("M") or {}
        skey = str(site_id or "").strip().upper()
        site_state = (site_states.get(skey) or {}).get("M") or {}
        item_to_read = site_state or item

        status = normalize_status((item_to_read.get("plant_status") or {}).get("S") or "NORMAL")
        cap = ddb_number(item_to_read, "curtailment_capacity")
        control_mode = (ddb_string(item_to_read, "control_mode") or default_control_mode(status)).upper()
        shutdown_reduction_mw = ddb_number(item_to_read, "shutdown_reduction_mw")
        return {
            "plant_status": status,
            "curtailment_capacity": cap,
            "control_mode": control_mode,
            "shutdown_reduction_mw": shutdown_reduction_mw,
            "source": "ddb",
        }
    except Exception:
        logger.exception("Failed to load control state from DynamoDB")
        return {
            "plant_status": "NORMAL",
            "curtailment_capacity": None,
            "control_mode": "NORMAL",
            "shutdown_reduction_mw": None,
            "source": "ddb_error",
        }


def load_control_windows(
    *,
    table_name: str | None,
    plant_id: str,
    logger,
) -> list[dict]:
    if not table_name:
        return []
    if boto3 is None:
        logger.warning("boto3 is not installed; skipping control windows load")
        return []

    try:
        ddb = boto3.client("dynamodb")
        if Key is None:
            logger.warning("boto3 Key condition helper missing; skipping control windows load")
            return []
        resp = ddb.query(
            TableName=table_name,
            KeyConditionExpression="#pk = :pk",
            ExpressionAttributeNames={"#pk": "plant_id"},
            ExpressionAttributeValues={":pk": {"S": plant_id}},
            ConsistentRead=True,
        )
        windows: list[dict] = []
        for item in resp.get("Items", []) or []:
            status = normalize_status(item.get("plant_status", {}).get("S"))
            start_raw = item.get("start_time", {}).get("S")
            end_raw = item.get("end_time", {}).get("S")
            if not start_raw:
                continue
            try:
                start_dt = datetime.fromisoformat(str(start_raw))
                end_dt = datetime.fromisoformat(str(end_raw)) if end_raw else None
            except Exception:
                logger.warning(
                    "Skipping control window with invalid timestamps: start=%s end=%s",
                    start_raw,
                    end_raw,
                )
                continue
            active_attr = item.get("active")
            open_attr = item.get("is_open_ended")
            windows.append(
                {
                    "window_id": item.get("window_id", {}).get("S"),
                    "plant_status": status,
                    "curtailment_capacity": ddb_number(item, "curtailment_capacity"),
                    "control_mode": (ddb_string(item, "control_mode") or default_control_mode(status)).upper(),
                    "shutdown_reduction_mw": ddb_number(item, "shutdown_reduction_mw"),
                    "parsed_format": ddb_string(item, "parsed_format"),
                    "site_alias": ddb_string(item, "site_alias"),
                    "start_time": start_dt,
                    "end_time": end_dt,
                    "site": item.get("site", {}).get("S"),
                    "active": True if active_attr is None else bool(active_attr.get("BOOL")),
                    "is_open_ended": bool(open_attr.get("BOOL")) if open_attr is not None else (end_dt is None),
                    "source": "ddb",
                }
            )
        return windows
    except Exception:
        logger.exception("Failed to load control windows from DynamoDB")
        return []


def _window_overlaps_block(window: dict, block_start: datetime, block_end: datetime, site_id: str) -> bool:
    if window.get("active") is False:
        return False

    site_token = normalize_control_site(site_id)
    window_site = normalize_control_site(window.get("site"))
    if window_site and window_site not in {"ALL", site_token}:
        return False

    start_dt = window.get("start_time")
    end_dt = window.get("end_time")
    is_open_ended = bool(window.get("is_open_ended"))
    if start_dt is None:
        return False

    cmp_block_start = block_start
    cmp_block_end = block_end
    if start_dt.tzinfo is not None:
        cmp_block_start = (
            cmp_block_start.replace(tzinfo=start_dt.tzinfo)
            if cmp_block_start.tzinfo is None
            else cmp_block_start.astimezone(start_dt.tzinfo)
        )
        cmp_block_end = (
            cmp_block_end.replace(tzinfo=start_dt.tzinfo)
            if cmp_block_end.tzinfo is None
            else cmp_block_end.astimezone(start_dt.tzinfo)
        )

    if is_open_ended and end_dt is None:
        return cmp_block_end > start_dt
    if end_dt is None:
        return False
    return not (end_dt <= cmp_block_start or start_dt >= cmp_block_end)


def planned_window_for_block(
    *,
    block_start: datetime,
    block_end: datetime,
    windows: list[dict],
    site_id: str,
    site_ac_capacity_mw: float,
    site_dc_capacity_mw: float,
    dc_ac_ratio: float,
) -> tuple[str, float | None]:
    planned_status = "NORMAL"
    planned_cap = None
    partial_shutdown_seen = False

    for window in windows:
        if not _window_overlaps_block(window, block_start, block_end, site_id):
            continue

        status = normalize_status(window.get("plant_status"))
        if status == "SHUTDOWN":
            effective_cap, control_type = effective_control_capacity_ac(
                plant_status=status,
                control_mode=window.get("control_mode"),
                shutdown_reduction_mw=window.get("shutdown_reduction_mw"),
                site_ac_capacity_mw=site_ac_capacity_mw,
                site_dc_capacity_mw=site_dc_capacity_mw,
                dc_ac_ratio=dc_ac_ratio,
            )
            if control_type == "SHUTDOWN":
                return "SHUTDOWN", None
            if effective_cap is not None:
                planned_cap = effective_cap if planned_cap is None else min(float(planned_cap), float(effective_cap))
                planned_status = "SHUTDOWN"
                partial_shutdown_seen = True
        if status == "CURTAILMENT":
            cap, _control_type = effective_control_capacity_ac(
                plant_status=status,
                control_mode=window.get("control_mode"),
                curtailment_capacity=window.get("curtailment_capacity"),
                site_ac_capacity_mw=site_ac_capacity_mw,
                site_dc_capacity_mw=site_dc_capacity_mw,
                dc_ac_ratio=dc_ac_ratio,
            )
            if cap is not None:
                planned_cap = cap if planned_cap is None else min(float(planned_cap), float(cap))
                if not partial_shutdown_seen:
                    planned_status = "CURTAILMENT"

    return planned_status, planned_cap


def control_detail_for_block(
    *,
    block_start: datetime,
    windows: list[dict],
    site_id: str,
    site_ac_capacity_mw: float,
    site_dc_capacity_mw: float,
    dc_ac_ratio: float,
) -> dict:
    block_end = block_start + timedelta(minutes=15)
    selected_detail = control_capacity_metadata(
        plant_status="NORMAL",
        control_mode="NORMAL",
        curtailment_capacity=None,
        shutdown_reduction_mw=None,
        effective_control_capacity_ac_mw=None,
        control_type="NORMAL",
        site_ac_capacity_mw=site_ac_capacity_mw,
        site_dc_capacity_mw=site_dc_capacity_mw,
        dc_ac_ratio=dc_ac_ratio,
    )

    for window in windows:
        if not _window_overlaps_block(window, block_start, block_end, site_id):
            continue

        status = normalize_status(window.get("plant_status"))
        effective_cap, control_type = effective_control_capacity_ac(
            plant_status=status,
            control_mode=window.get("control_mode"),
            curtailment_capacity=window.get("curtailment_capacity"),
            shutdown_reduction_mw=window.get("shutdown_reduction_mw"),
            site_ac_capacity_mw=site_ac_capacity_mw,
            site_dc_capacity_mw=site_dc_capacity_mw,
            dc_ac_ratio=dc_ac_ratio,
        )
        detail = control_capacity_metadata(
            plant_status=status,
            control_mode=window.get("control_mode"),
            curtailment_capacity=window.get("curtailment_capacity"),
            shutdown_reduction_mw=window.get("shutdown_reduction_mw"),
            effective_control_capacity_ac_mw=effective_cap,
            control_type=control_type,
            site_ac_capacity_mw=site_ac_capacity_mw,
            site_dc_capacity_mw=site_dc_capacity_mw,
            dc_ac_ratio=dc_ac_ratio,
        )
        if control_type == "SHUTDOWN":
            return detail
        current_cap = selected_detail.get("effective_control_capacity_ac_mw")
        if effective_cap is not None and (current_cap is None or float(effective_cap) < float(current_cap)):
            selected_detail = detail

    return selected_detail


def resolve_block_control(
    *,
    block_start: datetime,
    live_status: str,
    live_curtailment_capacity: float | None,
    planned_windows: list[dict],
    site_id: str,
    site_ac_capacity_mw: float,
    site_dc_capacity_mw: float,
    dc_ac_ratio: float,
) -> tuple[str, float | None]:
    status = normalize_status(live_status)
    if status == "SHUTDOWN":
        return "SHUTDOWN", live_curtailment_capacity
    if status == "CURTAILMENT":
        return "CURTAILMENT", live_curtailment_capacity

    block_end = block_start + timedelta(minutes=15)
    planned_status, planned_cap = planned_window_for_block(
        block_start=block_start,
        block_end=block_end,
        windows=planned_windows,
        site_id=site_id,
        site_ac_capacity_mw=site_ac_capacity_mw,
        site_dc_capacity_mw=site_dc_capacity_mw,
        dc_ac_ratio=dc_ac_ratio,
    )
    if planned_status == "SHUTDOWN":
        return "SHUTDOWN", planned_cap
    if planned_status == "CURTAILMENT":
        return "CURTAILMENT", planned_cap
    return "NORMAL", None


def apply_control_overrides(value: float, plant_status: str, curtailment_capacity: float | None) -> tuple[float, str | None]:
    if plant_status == "SHUTDOWN" and curtailment_capacity is not None:
        return min(value, curtailment_capacity), "PARTIAL_SHUTDOWN"
    if plant_status == "SHUTDOWN":
        return 0.0, "SHUTDOWN"
    if plant_status == "CURTAILMENT" and curtailment_capacity is not None:
        return min(value, curtailment_capacity), "CURTAILMENT"
    return value, None


__all__ = [
    "apply_control_overrides",
    "control_detail_for_block",
    "default_control_mode",
    "ddb_number",
    "ddb_string",
    "effective_capacity_ac_mw",
    "effective_control_capacity_ac",
    "load_control_state",
    "load_control_windows",
    "normalize_control_mode",
    "normalize_control_site",
    "normalize_status",
    "planned_window_for_block",
    "resolve_block_control",
    "resolve_capacity_config",
]

