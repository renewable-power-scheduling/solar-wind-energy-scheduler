from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from cloud.common.config_loader import load_site_config
from cloud.common.intraday_revision import resolve_intraday_revision
from cloud.common.paths import OUTPUTS_ROOT

IST = ZoneInfo("Asia/Kolkata")


def _start_block_from_hhmm(value: str) -> int:
    hours, minutes = [int(part) for part in str(value).split(":", 1)]
    total_minutes = (hours * 60) + minutes
    return max(1, min(96, 1 + (total_minutes // 15)))


def _end_block_from_hhmm(value: str) -> int:
    hours, minutes = [int(part) for part in str(value).split(":", 1)]
    total_minutes = (hours * 60) + minutes
    return max(1, min(96, (total_minutes + 14) // 15))


def _slot_info_for_block(site_id: str, block: int) -> dict[str, Any] | None:
    cfg = load_site_config(site_id)
    slots = (((cfg.get("schedule_submission") or {}).get("slots")) or []) if isinstance(cfg, dict) else []
    for index, slot in enumerate(slots, start=1):
        start = str(slot.get("start") or "").strip()
        end = str(slot.get("end") or "").strip()
        if not start or not end:
            continue
        start_block = _start_block_from_hhmm(start)
        end_block = _end_block_from_hhmm(end)
        if int(start_block) <= int(block) <= int(end_block):
            return {
                "slot_id": int(index),
                "start_block": int(start_block),
                "end_block": int(end_block),
                "start": start,
                "end": end,
            }
    return None


def _output_day(site_id: str, run_date: str, local_env: dict[str, Any] | None) -> Path:
    custom_base = str((local_env or {}).get("CUSTOM_OUTPUT_BASE") or "").strip()
    if custom_base:
        return Path(custom_base) / str(run_date)
    return OUTPUTS_ROOT / str(site_id).strip().upper() / str(run_date)


def _load_engine_state(site_id: str, run_date: str, local_env: dict[str, Any] | None) -> dict[str, Any]:
    state_path = _output_day(site_id, run_date, local_env) / "engine_state.json"
    if not state_path.exists():
        return {}
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def assess_intraday_trigger(
    *,
    site_id: str,
    run_date: str,
    current_block: int,
    latest_intraday_name: str | None,
    latest_intraday_key: str | None = None,
    decision_state: dict[str, Any] | None = None,
    local_env: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "triggered": False,
        "latest_intraday_name": latest_intraday_name,
    }
    if not latest_intraday_name:
        result["reason"] = "NO_INTRADAY_SOURCE"
        return result

    cfg = load_site_config(site_id)
    intraday_policy = cfg.get("intraday_schedule_policy", {}) if isinstance(cfg, dict) else {}
    slot_info = _slot_info_for_block(site_id, int(current_block))
    revision_info = resolve_intraday_revision(site_id, latest_intraday_name)
    current_revision = int(revision_info["revision"]) if revision_info else None
    revision_block = (
        int(revision_info["block"])
        if revision_info and revision_info.get("block") is not None
        else None
    )
    engine_state = _load_engine_state(site_id, run_date, local_env)
    state = dict(decision_state or {})
    schedule_exists = bool(
        engine_state.get("schedule_exists")
        or state.get("last_applied_intraday_name")
        or state.get("last_dispatched_intraday_name")
    )

    result.update(
        {
            "schedule_exists": bool(schedule_exists),
            "current_revision": int(current_revision) if current_revision is not None else None,
            "revision_block": revision_block,
            "latest_intraday_key": latest_intraday_key,
            "slot_id": int(slot_info["slot_id"]) if slot_info else None,
            "slot_start_block": int(slot_info["start_block"]) if slot_info else None,
            "slot_end_block": int(slot_info["end_block"]) if slot_info else None,
        }
    )

    if current_revision is None or int(current_revision) <= 0:
        result["reason"] = "INTRADAY_REVISION_UNAVAILABLE"
        return result
    if revision_block is None:
        result["reason"] = "INTRADAY_REVISION_BLOCK_UNAVAILABLE"
        return result
    if slot_info is None:
        result["reason"] = "INTRADAY_OUTSIDE_SUBMISSION_SLOT"
        return result

    first_mandatory_revision = int(intraday_policy.get("first_mandatory_revision", 1) or 1)
    mandatory_generation_block = intraday_policy.get("mandatory_generation_block")
    first_generation_block = intraday_policy.get("first_generation_block")
    trigger_block = int(revision_block)
    if bool(intraday_policy.get("slot_end_only", True)):
        revision_slot_info = _slot_info_for_block(site_id, int(revision_block))
        if revision_slot_info is None:
            result["reason"] = "INTRADAY_REVISION_OUTSIDE_SUBMISSION_SLOT"
            return result
        trigger_block = int(revision_slot_info["end_block"])
        result["revision_slot_id"] = int(revision_slot_info["slot_id"])
        result["revision_slot_end_block"] = int(revision_slot_info["end_block"])
    if int(current_revision) < int(first_mandatory_revision):
        result["reason"] = "INTRADAY_WAIT_MANDATORY_REVISION"
        return result
    if not schedule_exists:
        generation_block = mandatory_generation_block if mandatory_generation_block is not None else first_generation_block
        if generation_block is not None:
            trigger_block = max(trigger_block, int(generation_block))
    result["trigger_block"] = int(trigger_block)
    if int(current_block) < int(trigger_block):
        result["reason"] = "INTRADAY_WAIT_TRIGGER_BLOCK"
        return result
    if int(current_block) > int(trigger_block):
        result["reason"] = "INTRADAY_TRIGGER_BLOCK_PASSED"
        return result

    last_applied_name = str(
        state.get("last_applied_intraday_name")
        or state.get("last_dispatched_intraday_name")
        or state.get("last_intraday_name")
        or ""
    ).strip() or None
    if last_applied_name and str(latest_intraday_name).strip() == last_applied_name:
        result["reason"] = "INTRADAY_TRIGGER_DUPLICATE"
        return result
    last_key = str(
        state.get("last_applied_intraday_key")
        or state.get("last_dispatched_intraday_key")
        or ""
    ).strip() or None
    if latest_intraday_key and last_key and latest_intraday_key == last_key:
        result["reason"] = "INTRADAY_TRIGGER_DUPLICATE"
        return result

    result["triggered"] = True
    result["reason"] = (
        f"intraday revision {int(current_revision)} trigger"
        if current_revision is not None
        else "intraday revision trigger"
    )
    result["source_event_id"] = str(latest_intraday_name).strip()
    return result

