from __future__ import annotations

import re


def safe_file_token(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return "r1"
    cleaned = re.sub(r"[^a-z0-9_-]+", "_", raw).strip("_")
    return cleaned or "r1"


def parse_revision_number(revision_label: str | None) -> int:
    match = re.search(r"(\d+)", str(revision_label or ""))
    return int(match.group(1)) if match else 0


def hhmm_to_block_end(hhmm: str) -> int:
    hour, minute = [int(part) for part in str(hhmm).split(":", 1)]
    return ((hour * 60) + minute) // 15


def build_submission_slots(site_cfg: dict) -> list[dict]:
    slots = []
    raw_slots = ((site_cfg or {}).get("schedule_submission", {}) or {}).get("slots", [])
    for idx, slot in enumerate(raw_slots, start=1):
        start = str(slot.get("start") or "").strip()
        end = str(slot.get("end") or "").strip()
        if not start or not end:
            continue
        start_block = hhmm_to_block_end(start) + 1
        end_block = hhmm_to_block_end(end)
        slots.append(
            {
                "slot_id": idx,
                "start": start,
                "end": end,
                "start_block": start_block,
                "end_block": end_block,
            }
        )
    return slots


def slot_info_for_block(block: int, submission_slots: list[dict]) -> dict | None:
    for slot in submission_slots:
        if int(slot["start_block"]) <= int(block) <= int(slot["end_block"]):
            return slot
    return None


def evaluate_intraday_schedule_gate(
    *,
    engine_block: int,
    current_revision_num: int,
    schedule_exists: bool,
    submission_slots: list[dict],
    slot_end_only: bool,
    first_mandatory_revision: int,
    first_arrival_block: int | None,
    mandatory_generation_block: int | None,
    first_generation_block: int | None,
) -> tuple[bool, str | None, dict]:
    slot_info = slot_info_for_block(engine_block, submission_slots)
    detail = {
        "slot_id": int(slot_info["slot_id"]) if slot_info else None,
        "slot_start_block": int(slot_info["start_block"]) if slot_info else None,
        "slot_end_block": int(slot_info["end_block"]) if slot_info else None,
        "current_revision": int(current_revision_num),
        "first_mandatory_revision": int(first_mandatory_revision),
        "first_arrival_block": int(first_arrival_block) if first_arrival_block is not None else None,
        "mandatory_generation_block": int(mandatory_generation_block) if mandatory_generation_block is not None else None,
        "first_generation_block": int(first_generation_block) if first_generation_block is not None else None,
    }
    if slot_info is None:
        return False, "INTRADAY_OUTSIDE_SUBMISSION_SLOT", detail
    if slot_end_only and int(engine_block) != int(slot_info["end_block"]):
        return False, "INTRADAY_WAIT_SLOT_END", detail
    if not schedule_exists:
        generation_block = mandatory_generation_block if mandatory_generation_block is not None else first_generation_block
        if generation_block is not None and int(engine_block) < int(generation_block):
            return False, "INTRADAY_WAIT_FIRST_GENERATION_BLOCK", detail
        if int(current_revision_num) < int(first_mandatory_revision):
            return False, "INTRADAY_WAIT_MANDATORY_REVISION", detail
    elif int(current_revision_num) <= 0:
        return False, "INTRADAY_REVISION_UNAVAILABLE", detail
    return True, None, detail


def parse_intraday_reason_revision(source: str | None) -> int | None:
    src = str(source or "").strip().lower()
    if not src.startswith("intraday schedule"):
        return None
    match = re.search(r"\br(\d+)\b", src)
    return int(match.group(1)) if match else None


def derive_schedule_reason_fields(source: str | None, plant_status: str) -> dict:
    status = str(plant_status or "").strip().upper()
    if status not in {"NORMAL", "SHUTDOWN", "CURTAILMENT"}:
        status = "NORMAL"
    src = (source or "").strip().lower()

    intraday_revision_no = parse_intraday_reason_revision(source)
    if intraday_revision_no is not None:
        return {
            "label": f"intraday_revision_r{intraday_revision_no}",
            "category": "intraday_revision",
            "code": str(source or ""),
            "intraday_revision_no": int(intraday_revision_no),
        }

    if src == "plant_status_change":
        return {
            "label": f"plant_status_change_{status.lower()}",
            "category": "plant_status_change",
            "code": "plant_status_change",
            "intraday_revision_no": None,
        }

    if src == "whatsapp_out_of_band_adjustment":
        return {
            "label": f"whatsapp_out_of_band_adjustment_{status.lower()}",
            "category": "whatsapp_out_of_band_adjustment",
            "code": "whatsapp_out_of_band_adjustment",
            "intraday_revision_no": None,
        }

    if src == "custom_start":
        return {
            "label": "custom_start",
            "category": "custom_start",
            "code": "custom_start",
            "intraday_revision_no": None,
        }

    raw = str(source or "unknown").strip() or "unknown"
    normalized = re.sub(r"[^a-z0-9]+", "_", raw.lower()).strip("_") or "unknown"
    return {
        "label": normalized,
        "category": normalized,
        "code": raw,
        "intraday_revision_no": None,
    }
