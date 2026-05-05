"""
Backend auto-upload worker.

Runs on the server (FastAPI startup) so auto-upload continues to work even when the frontend is closed.

This is intentionally conservative:
- Only attempts auto-upload when trigger reason is one of the known auto reasons.
- Enforces one upload per plant/date per slot via DB (AutoUploadSlotUsage).
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from database import SessionLocal
from models import AutoUploadSlotUsage
from services.template_transform_service import list_schedule_files_for_date, fetch_s3_text


AUTO_UPLOAD_SLOT_BLOCKS = int(os.getenv("AUTO_UPLOAD_SLOT_BLOCKS", "6"))
AUTO_UPLOAD_OFFSET_MINUTES = int(os.getenv("AUTO_UPLOAD_OFFSET_MINUTES", "4"))
AUTO_UPLOAD_POLL_SECONDS = int(os.getenv("AUTO_UPLOAD_POLL_SECONDS", "60"))
AUTO_UPLOAD_ENABLED = os.getenv("AUTO_UPLOAD_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
AUTO_UPLOAD_EFFECTIVE_DELAY_BLOCKS = int(os.getenv("AUTO_UPLOAD_EFFECTIVE_DELAY_BLOCKS", "3"))

# Keep aligned with frontend normalization.
AUTO_TRIGGER_REASONS = {"ABRUPT_WEATHER", "DYNAMIC_START", "CURTAILMENT", "PLANT_STATUS_CHANGE", "DAY_AHEAD"}

SCHEDULE_ID_RE = re.compile(r"schedule_from_(\d+)\.csv$", re.IGNORECASE)


def _derive_s3_bucket_name(template_base_url: str) -> str:
    explicit_bucket = os.getenv("READINESS_UPLOAD_BUCKET", "").strip() or os.getenv("TEMPLATE_OUTPUT_BUCKET", "").strip()
    if explicit_bucket:
        return explicit_bucket
    # template_base_url looks like: https://<bucket>.s3.<region>.amazonaws.com
    try:
        host = template_base_url.split("//", 1)[-1].split("/", 1)[0]
        if host:
            return host.split(".")[0]
    except Exception:
        pass
    return ""


def _ist_now() -> datetime:
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(timezone.utc).astimezone(ist)


def _to_utc_aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_iso_assume_utc(value: str) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        normalized = text
        if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", normalized) and not re.search(r"[zZ]|[+-]\d{2}:\d{2}$", normalized):
            normalized = f"{normalized}Z"
        return datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except Exception:
        return None


def _submit_block_from_iso(uploaded_at_iso: str, *, block_minutes: int = 15, total_blocks: int = 96) -> Optional[int]:
    dt = _parse_iso_assume_utc(uploaded_at_iso)
    if not dt:
        return None
    try:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ist = timezone(timedelta(hours=5, minutes=30))
        local_dt = dt.astimezone(ist)
        total_minutes = (local_dt.hour * 60) + local_dt.minute
        block_start = (total_minutes // int(block_minutes)) * int(block_minutes)
        submit_block = int(block_start // int(block_minutes)) + 1
        submit_block = max(1, min(int(total_blocks), submit_block))
        return submit_block
    except Exception:
        return None


def _compute_submit_and_effective_blocks_from_iso(
    uploaded_at_iso: str,
    *,
    block_minutes: int = 15,
    total_blocks: int = 96,
    effective_delay_blocks: int = AUTO_UPLOAD_EFFECTIVE_DELAY_BLOCKS,
) -> Dict[str, Any]:
    submit_block = _submit_block_from_iso(uploaded_at_iso, block_minutes=block_minutes, total_blocks=total_blocks)
    if not isinstance(submit_block, int):
        return {"submit_block": None, "effective_start_block": None}
    effective = int(submit_block) + int(effective_delay_blocks)
    effective_start_block = effective if effective <= int(total_blocks) else None
    return {"submit_block": submit_block, "effective_start_block": effective_start_block}


def _slot_index_from_iso(uploaded_at_iso: str) -> Optional[int]:
    submit_block = _submit_block_from_iso(uploaded_at_iso)
    if not isinstance(submit_block, int):
        return None
    return int((submit_block - 1) // max(1, AUTO_UPLOAD_SLOT_BLOCKS))


def _freeze_time_from_schedule_revision(
    *,
    operating_date: date,
    schedule_revision: int,
    generation_lag_minutes: int = 8,
    submit_offset_minutes: int = AUTO_UPLOAD_OFFSET_MINUTES,
) -> Optional[datetime]:
    """
    Compute autosubmit freeze_time from the schedule revision (block) time.

    Rule (per UI/system convention):
    - Dashboard displays "generated time" as (block start + 8 minutes)
    - Autosubmit uses (generated time + 4 minutes) => (block start + 12 minutes)
    """
    try:
        block = int(schedule_revision)
    except Exception:
        return None
    if block < 1 or block > 96:
        return None

    total_minutes = ((block - 1) * 15) + int(generation_lag_minutes) + int(submit_offset_minutes)
    hh = (total_minutes // 60) % 24
    mm = total_minutes % 60
    ist = timezone(timedelta(hours=5, minutes=30))
    local_dt = datetime(int(operating_date.year), int(operating_date.month), int(operating_date.day), int(hh), int(mm), tzinfo=ist)
    return local_dt.astimezone(timezone.utc)


def _normalize_trigger_reason(text: str) -> str:
    raw = str(text or "").strip().upper().replace("-", "_")
    if not raw or raw == "-":
        return "-"
    if "ABRUPT" in raw and "WEATHER" in raw:
        return "ABRUPT_WEATHER"
    if "DYNAMIC" in raw and "START" in raw:
        return "DYNAMIC_START"
    if "CURTAIL" in raw:
        return "CURTAILMENT"
    if "PLANT" in raw and "STATUS" in raw and "CHANGE" in raw:
        return "PLANT_STATUS_CHANGE"
    if "DAY" in raw and "AHEAD" in raw:
        return "DAY_AHEAD"
    return raw


def _guess_trigger_reason_from_key(key: str) -> str:
    # Fallback heuristic when metadata/log reason is unavailable.
    text = str(key or "").upper()
    for token in AUTO_TRIGGER_REASONS:
        if token in text:
            return token
    return "-"


def _extract_schedule_id_from_key(key: str) -> Optional[int]:
    base = os.path.basename(str(key or "").strip())
    m = SCHEDULE_ID_RE.search(base)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _load_prefixes_from_env() -> List[str]:
    raw = os.getenv("TEMPLATE_PIPELINE_S3_PREFIXES", "")
    prefixes = [p.strip().strip("/") for p in raw.split(",") if p.strip()]
    return prefixes


def _pick_latest_schedule_for_plant(objects: List[Dict[str, str]], plant_code: str) -> Optional[Dict[str, str]]:
    code = str(plant_code or "").strip().upper()
    if not code:
        return None
    needle = f"/{code}/"
    for obj in objects:
        key = str(obj.get("key") or "")
        if needle.lower() in key.lower():
            return obj
    return None


def _upload_to_s3(
    *,
    bucket: str,
    region: str,
    key: str,
    body_text: str,
    metadata: Optional[Dict[str, str]] = None,
) -> None:
    import boto3  # type: ignore

    s3 = boto3.client("s3", region_name=region)
    kwargs: Dict[str, Any] = {
        "Bucket": bucket,
        "Key": key,
        "Body": body_text.encode("utf-8"),
        "ContentType": "text/csv",
    }
    if metadata:
        kwargs["Metadata"] = {k: str(v) for k, v in metadata.items() if v is not None}
    s3.put_object(**kwargs)


def _mark_slot_used(
    db: Session,
    *,
    plant_code: str,
    schedule_date: date,
    slot_index: int,
    schedule_key: str,
    trigger_reason: str,
    decision: str,
    freeze_time: Optional[datetime],
) -> None:
    existing = (
        db.query(AutoUploadSlotUsage)
        .filter(AutoUploadSlotUsage.plant_code == plant_code)
        .filter(AutoUploadSlotUsage.schedule_date == schedule_date)
        .filter(AutoUploadSlotUsage.slot_index == int(slot_index))
        .first()
    )
    if existing:
        return
    rec = AutoUploadSlotUsage(
        plant_code=plant_code,
        schedule_date=schedule_date,
        slot_index=int(slot_index),
        schedule_key=schedule_key,
        trigger_reason=trigger_reason,
        decision=decision,
        freeze_time=freeze_time,
    )
    db.add(rec)
    db.commit()


async def _run_once() -> None:
    # Derive operating date in IST to match UI.
    operating_date = _ist_now().date()

    s3_base_url = os.getenv("TEMPLATE_PIPELINE_S3_BASE_URL", "").strip() or os.getenv(
        "DEFAULT_TEMPLATE_S3_BASE_URL",
        "https://vedanjay-schedules1.s3.ap-south-1.amazonaws.com",
    )
    prefixes = _load_prefixes_from_env()
    if not prefixes:
        return

    objects = list_schedule_files_for_date(operating_date, s3_base_url, prefixes)
    if not objects:
        return

    # Keep plant set aligned with upload-template endpoint allowlist.
    plants = ["BHUPALPALLY", "CME", "GSNP", "KASIPET", "KILAJ", "KOTHAGUDEM", "OSEPL", "SIRMOUR"]

    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
    bucket = _derive_s3_bucket_name(s3_base_url)
    if not bucket:
        return

    # Upload location uses the existing readiness prefix used by manual uploads.
    readiness_prefix = os.getenv("READINESS_UPLOAD_PREFIX", "uploads/vedanjay").strip().strip("/")

    for plant_code in plants:
        latest = _pick_latest_schedule_for_plant(objects, plant_code)
        if not latest:
            continue

        schedule_key = str(latest.get("key") or "").strip()
        last_modified = str(latest.get("last_modified") or "").strip()
        if not schedule_key:
            continue

        trigger_reason = _guess_trigger_reason_from_key(schedule_key)
        trigger_reason = _normalize_trigger_reason(trigger_reason)
        if trigger_reason not in AUTO_TRIGGER_REASONS:
            continue

        schedule_id = _extract_schedule_id_from_key(schedule_key)
        freeze_dt = (
            _freeze_time_from_schedule_revision(operating_date=operating_date, schedule_revision=int(schedule_id))
            if schedule_id is not None
            else None
        )
        if freeze_dt is None:
            # Fallback: derive from S3 last_modified when revision cannot be extracted.
            base_dt = _parse_iso_assume_utc(last_modified) if last_modified else None
            freeze_dt = _to_utc_aware(base_dt) + timedelta(minutes=AUTO_UPLOAD_OFFSET_MINUTES) if base_dt else None
        if freeze_dt is None:
            continue

        slot_index = _slot_index_from_iso(freeze_dt.isoformat())
        if slot_index is None:
            continue

        # Only perform the auto-upload at (or after) the planned autosubmit time.
        # This prevents system_frozen.csv being generated immediately when the worker starts.
        now_utc = datetime.now(timezone.utc)
        if now_utc < freeze_dt:
            continue

        # Enforce one action per slot.
        db = SessionLocal()
        try:
            exists = (
                db.query(AutoUploadSlotUsage)
                .filter(AutoUploadSlotUsage.plant_code == plant_code)
                .filter(AutoUploadSlotUsage.schedule_date == operating_date)
                .filter(AutoUploadSlotUsage.slot_index == int(slot_index))
                .first()
            )
            if exists:
                continue

            # Fetch schedule CSV from S3 and upload it to the readiness uploads prefix.
            try:
                csv_text = fetch_s3_text(schedule_key, s3_base_url)
            except Exception:
                _mark_slot_used(
                    db,
                    plant_code=plant_code,
                    schedule_date=operating_date,
                    slot_index=slot_index,
                    schedule_key=schedule_key,
                    trigger_reason=trigger_reason,
                    decision="SKIPPED",
                    freeze_time=freeze_dt,
                )
                continue

            name_suffix = f"schedule_from_{schedule_id}.csv" if schedule_id is not None else os.path.basename(schedule_key)
            out_name = f"{plant_code}_{operating_date.isoformat()}_{name_suffix.replace('.csv','')}_sldc_template.csv"
            upload_token = datetime.utcnow().strftime("%Y%m%dT%H%M%S%fZ")
            output_key = f"{readiness_prefix}/{plant_code}/{operating_date.isoformat()}/{upload_token}_{out_name}"

            _upload_to_s3(
                bucket=bucket,
                region=region,
                key=output_key,
                body_text=csv_text,
                metadata={
                    "requested_by": "SYSTEM_AUTO",
                    "source_file_key": schedule_key,
                    "trigger_reason": trigger_reason,
                    "slot_index": str(slot_index),
                    "freeze_time": freeze_dt.isoformat() if freeze_dt else "",
                },
            )

            # NOTE: system_frozen.csv generation has been removed from this worker.
            # Auto-upload now only writes the upload confirmation object under uploads/vedanjay/.

            _mark_slot_used(
                db,
                plant_code=plant_code,
                schedule_date=operating_date,
                slot_index=slot_index,
                schedule_key=schedule_key,
                trigger_reason=trigger_reason,
                decision="UPLOADED",
                freeze_time=freeze_dt,
            )
        finally:
            db.close()


async def auto_upload_daemon() -> None:
    """Runs forever; safe to start as an asyncio background task."""
    while True:
        try:
            if AUTO_UPLOAD_ENABLED:
                await _run_once()
        except Exception:
            # Keep daemon alive; logs go to server stdout/stderr.
            pass
        await asyncio.sleep(max(10, int(AUTO_UPLOAD_POLL_SECONDS)))


def start_auto_upload_task() -> Optional[asyncio.Task]:
    if not AUTO_UPLOAD_ENABLED:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return loop.create_task(auto_upload_daemon())
