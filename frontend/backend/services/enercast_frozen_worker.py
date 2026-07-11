from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3  # type: ignore

ENERCAST_FROZEN_ENABLED = os.getenv("ENERCAST_FROZEN_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}
ENERCAST_FROZEN_POLL_SECONDS = int(os.getenv("ENERCAST_FROZEN_POLL_SECONDS", "60"))
ENERCAST_FROZEN_BUCKET = (
    os.getenv("READINESS_UPLOAD_BUCKET", "").strip()
    or os.getenv("TEMPLATE_OUTPUT_BUCKET", "").strip()
)
ENERCAST_FROZEN_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
ENERCAST_FROZEN_PLANTS = [
    item.strip().upper()
    for item in (
        os.getenv(
            "ENERCAST_FROZEN_PLANTS",
            "BHUPALPALLY,BAMKHAL,CME,GSNP,KASIPET,KILAJ,KOTHAGUDEM,OSEPL,SIRMOUR,ANJANGAON",
        ).split(",")
    )
    if item.strip()
]

_TOTAL_BLOCKS = 96
_BLOCK_MINUTES = 15
_REVISION_RE = re.compile(r"_r(\d+)\.csv$", re.IGNORECASE)
_FILENAME_IST_TIMESTAMP_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\+(\d{2})(\d{2})",
    re.IGNORECASE,
)
_PLANT_VALUE_HEADER_TOKENS = {
    "bhupalpally",
    "cme",
    "gsnp",
    "kasipet",
    "kilaj",
    "kothagudem",
    "osel",
    "osepl",
    "sirmour",
    "shrimoour",
    "shromour",
    "anjangaon",
    "anjangoan",
    "sawda",
}


def _derive_s3_bucket_name() -> str:
    if ENERCAST_FROZEN_BUCKET:
        return ENERCAST_FROZEN_BUCKET
    base_url = os.getenv(
        "TEMPLATE_PIPELINE_S3_BASE_URL",
        "https://vedanjay-schedules1.s3.ap-south-1.amazonaws.com",
    ).strip()
    try:
        host = base_url.split("//", 1)[-1].split("/", 1)[0]
        return host.split(".")[0] if host else ""
    except Exception:
        return ""


def _ist_tz() -> timezone:
    return timezone(timedelta(hours=5, minutes=30))


def _ist_now() -> datetime:
    return datetime.now(timezone.utc).astimezone(_ist_tz())


def _normalize_plant_code(value: str) -> str:
    code = str(value or "").strip().upper()
    if code == "OSEL":
        return "OSEPL"
    if code in {"SHRIMOUR", "SHROMOUR"}:
        return "SIRMOUR"
    if code == "ANJANGOAN":
        return "ANJANGAON"
    return code


def _special_s3_plant_folder(value: str) -> str:
    code = _normalize_plant_code(value)
    if code == "ANJANGAON":
        return "ANJANGOAN"
    return code


def _raw_plant_folder_aliases(plant_code: str) -> List[str]:
    code = _normalize_plant_code(plant_code)
    aliases = {code}
    if code == "OSEPL":
        aliases.add("OSEL")
    if code == "ANJANGAON":
        aliases.add("ANJANGOAN")
    if code == "SIRMOUR":
        aliases.update({"SHRIMOUR", "SHROMOUR"})
    return sorted(aliases)


def _derived_raw_folder_variants(plant_code: str) -> List[str]:
    code = _normalize_plant_code(plant_code)
    if not code:
        return []
    folder = code
    if re.fullmatch(r"[A-Z0-9_-]+", folder) and len(folder) > 4:
        lower = folder.lower()
        folder = lower[:1].upper() + lower[1:]
    lower_folder = folder.lower().replace(" ", "")
    return [f"raw/{folder}/{lower_folder}/"]


def _intraday_prefixes(plant_code: str, schedule_date: str) -> List[str]:
    date_key = str(schedule_date or "").strip()
    prefixes = [
        f"raw/vedanjay/{alias}/{date_key}/enercast_data/intraday/"
        for alias in _raw_plant_folder_aliases(plant_code)
    ]
    prefixes.extend(
        f"{base}{date_key}/enercast_data/intraday/"
        for base in _derived_raw_folder_variants(plant_code)
    )
    seen = set()
    ordered: List[str] = []
    for prefix in prefixes:
        if not prefix or prefix in seen:
            continue
        seen.add(prefix)
        ordered.append(prefix)
    return ordered


def _normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _block_to_time(block: int) -> str:
    start_minutes = max(0, (int(block) - 1) * _BLOCK_MINUTES)
    hour = start_minutes // 60
    minute = start_minutes % 60
    return f"{hour:02d}:{minute:02d}"


def _parse_iso_or_display_timestamp(meta: Dict[str, Any]) -> Optional[datetime]:
    candidate_iso_values = [
        meta.get("arrival_timestamp_ist"),
        meta.get("changed_at_ist"),
        meta.get("changed_at"),
        meta.get("timestamp"),
        meta.get("arrival_time_ist"),
        meta.get("download_started_at_ist"),
        meta.get("download_finished_at_ist"),
    ]
    changed_iso = next((str(value).strip() for value in candidate_iso_values if str(value or "").strip()), "")
    if changed_iso:
        try:
            dt = datetime.fromisoformat(changed_iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=_ist_tz())
            return dt.astimezone(_ist_tz())
        except Exception:
            pass

    candidate_display_values = [
        meta.get("changed_at_display"),
        meta.get("changed_at_local"),
        meta.get("arrival_time_display"),
    ]
    for raw_display in candidate_display_values:
        changed_display = str(raw_display or "").strip()
        if not changed_display:
            continue
        for fmt in ("%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(changed_display, fmt).replace(tzinfo=_ist_tz())
            except Exception:
                continue
    return None


def _parse_timestamp_from_filename(filename: str) -> Optional[datetime]:
    match = _FILENAME_IST_TIMESTAMP_RE.search(str(filename or ""))
    if not match:
        return None
    try:
        date_part = match.group(1)
        hour = int(match.group(2))
        minute = int(match.group(3))
        offset_hour = int(match.group(4))
        offset_minute = int(match.group(5))
        tz = timezone(timedelta(hours=offset_hour, minutes=offset_minute))
        return datetime.strptime(f"{date_part} {hour:02d}:{minute:02d}", "%Y-%m-%d %H:%M").replace(tzinfo=tz).astimezone(_ist_tz())
    except Exception:
        return None


def _revision_label(filename: str) -> str:
    match = _REVISION_RE.search(str(filename or ""))
    if match and match.group(1):
        return f"r{int(match.group(1))}"
    base = os.path.basename(str(filename or "").strip()) or "unknown"
    return base


def _effective_block_from_arrival(arrival_ist: datetime) -> Optional[int]:
    effective = arrival_ist + timedelta(minutes=45)
    if effective.date() != arrival_ist.date():
        return None
    total_minutes = (effective.hour * 60) + effective.minute
    block = int(total_minutes // _BLOCK_MINUTES) + 1
    if block < 1:
        return 1
    if block > _TOTAL_BLOCKS:
        return None
    return block


def _parse_schedule_csv(text: str) -> Dict[int, float]:
    rows = list(csv.reader(io.StringIO(str(text or ""))))
    if not rows:
        return {}

    header_row_idx = 0
    for idx, row in enumerate(rows):
        normalized_row = [_normalize_header(cell) for cell in row]
        if any(token in {"blkno", "block", "blockno", "timeblock", "timeperiod"} for token in normalized_row):
            header_row_idx = idx
            break

    headers = rows[header_row_idx] if header_row_idx < len(rows) else rows[0]
    header_tokens = [_normalize_header(h) for h in headers]

    def _pick_header_index(*predicates) -> int:
        for predicate in predicates:
            for idx, token in enumerate(header_tokens):
                if predicate(token):
                    return idx
        return -1

    def _is_meta_column(token: str, idx: int) -> bool:
        return (
            idx == block_idx
            or token in {"date", "time", "from", "to"}
            or "date" in token
            or "from" in token
            or "to" in token
        )

    block_idx = _pick_header_index(
        lambda h: h == "block",
        lambda h: h.startswith("block"),
        lambda h: h in {"timeperiod", "timeblock", "timeslot", "slot", "sno", "serialno"},
    )
    mw_idx = _pick_header_index(
        lambda h: h == "scaledenercastforecastmw",
        lambda h: h == "intradayforecastmw",
        lambda h: h == "forecastmw",
        lambda h: h == "schmw",
        lambda h: "sch" in h and "mw" in h,
        lambda h: "avc" in h and "mw" in h,
        lambda h: h == "scheduledmw",
        lambda h: "forcast" in h and "actual" not in h,
        lambda h: "intraday" in h and "actual" not in h,
        lambda h: "dayahead" in h and "actual" not in h,
        lambda h: h == "pv",
        lambda h: "pv" in h and "availability" not in h and "capacity" not in h,
        lambda h: "forecast" in h and "actual" not in h,
        lambda h: h.endswith("mw") and "actual" not in h and "meter" not in h,
        lambda h: h == "schedule",
    )
    if mw_idx < 0:
        mw_idx = _pick_header_index(
            lambda h: (
                (
                    "sirmour" in h
                    or "gsnp" in h
                    or "osel" in h
                    or "osepl" in h
                    or "anjangaon" in h
                    or "anjangoan" in h
                    or h == "pv"
                    or "plant" in h
                )
                and "availability" not in h
                and "capacity" not in h
            )
        )
    if mw_idx < 0:
        mw_idx = _pick_header_index(
            lambda h: (
                h in _PLANT_VALUE_HEADER_TOKENS
                and "availability" not in h
                and "capacity" not in h
            )
        )
    if mw_idx < 0:
        for idx, token in enumerate(header_tokens):
            if _is_meta_column(token, idx) or "avc" in token:
                continue
            if "mw" in token or "power" in token or "value" in token:
                mw_idx = idx
                break

    result: Dict[int, float] = {}
    for row in rows[header_row_idx + 1:]:
        if not row:
            continue
        try:
            block_raw = row[block_idx if block_idx >= 0 else 0]
        except Exception:
            block_raw = row[0] if row else ""
        try:
            value_raw = row[mw_idx if mw_idx >= 0 else min(1, len(row) - 1)]
        except Exception:
            value_raw = ""

        try:
            block = int(str(block_raw or "").strip())
        except Exception:
            continue
        try:
            value = float(str(value_raw or "").replace(",", "").strip())
        except Exception:
            continue
        if block < 1 or block > _TOTAL_BLOCKS:
            continue
        result[block] = value
    return result


def _list_s3_objects(bucket: str, prefix: str) -> List[Dict[str, Any]]:
    s3 = boto3.client("s3", region_name=ENERCAST_FROZEN_REGION)
    paginator = s3.get_paginator("list_objects_v2")
    items: List[Dict[str, Any]] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            key = str(obj.get("Key") or "").strip()
            if key:
                items.append(obj)
    return items


def _fetch_s3_text(bucket: str, key: str) -> str:
    s3 = boto3.client("s3", region_name=ENERCAST_FROZEN_REGION)
    response = s3.get_object(Bucket=bucket, Key=key)
    body = response.get("Body")
    if body is None:
        return ""
    raw = body.read()
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return str(raw or "")


def _load_intraday_revisions(*, bucket: str, plant_code: str, schedule_date: str) -> List[Dict[str, Any]]:
    revisions: List[Dict[str, Any]] = []
    seen_keys = set()
    for prefix in _intraday_prefixes(plant_code, schedule_date):
        objects = _list_s3_objects(bucket, prefix)
        by_key = {
            str(obj.get("Key") or "").strip(): obj
            for obj in objects
            if str(obj.get("Key") or "").strip()
        }
        meta_keys = [key for key in by_key.keys() if key.lower().endswith(".meta.json")]
        for meta_key in meta_keys:
            try:
                meta_text = _fetch_s3_text(bucket, meta_key)
                meta = json.loads(meta_text)
            except Exception:
                continue
            meta_obj = meta if isinstance(meta, dict) else {}
            csv_key = re.sub(r"\.meta\.json$", ".csv", meta_key, flags=re.IGNORECASE)
            filename = str(meta_obj.get("filename") or os.path.basename(csv_key)).strip()
            arrival_dt = _parse_iso_or_display_timestamp(meta_obj) or _parse_timestamp_from_filename(filename or csv_key)
            if not arrival_dt:
                continue
            if csv_key not in by_key:
                continue
            if csv_key in seen_keys:
                continue
            seen_keys.add(csv_key)
            revisions.append(
                {
                    "csv_key": csv_key,
                    "meta_key": meta_key,
                    "filename": filename or os.path.basename(csv_key),
                    "revision": _revision_label(filename or csv_key),
                    "arrival_dt": arrival_dt,
                    "arrival_ist": arrival_dt.isoformat(),
                    "meta": meta if isinstance(meta, dict) else {},
                }
            )
    revisions.sort(
        key=lambda item: (
            item["arrival_dt"],
            int(re.search(r"\d+", str(item.get("revision") or "")) .group(0)) if re.search(r"\d+", str(item.get("revision") or "")) else 10**9,
            str(item.get("csv_key") or ""),
        )
    )
    return revisions


def _build_enercast_frozen_csv(*, bucket: str, revisions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not revisions:
        return None

    block_state: Dict[int, Dict[str, Any]] = {}
    applied_revisions: List[Dict[str, Any]] = []

    for idx, revision in enumerate(revisions):
        try:
            schedule_text = _fetch_s3_text(bucket, str(revision.get("csv_key") or ""))
        except Exception:
            continue
        schedule_map = _parse_schedule_csv(schedule_text)
        if not schedule_map:
            continue

        arrival_dt = revision["arrival_dt"]
        is_first_applied = len(applied_revisions) == 0
        effective_block = 1 if is_first_applied else _effective_block_from_arrival(arrival_dt)
        effective_time = "" if is_first_applied else (arrival_dt + timedelta(minutes=45)).isoformat()
        if effective_block is None:
            applied_revisions.append(
                {
                    "revision": revision["revision"],
                    "csv_key": revision["csv_key"],
                    "arrival_ist": revision["arrival_ist"],
                    "effective_block": None,
                    "effective_time_ist": effective_time,
                    "applied": False,
                    "reason": "effective_time_outside_day",
                }
            )
            continue

        for block in range(max(1, effective_block), _TOTAL_BLOCKS + 1):
            if not is_first_applied and block not in schedule_map:
                continue
            block_state[block] = {
                "scheduled_mw": schedule_map.get(block, 0.0),
                "source_revision": revision["revision"],
                "source_file": os.path.basename(str(revision["csv_key"] or "")),
                "arrival_time_ist": revision["arrival_ist"],
                "effective_time_ist": effective_time,
                "effective_block": effective_block,
            }

        applied_revisions.append(
            {
                "revision": revision["revision"],
                "csv_key": revision["csv_key"],
                "arrival_ist": revision["arrival_ist"],
                "effective_block": effective_block,
                "effective_time_ist": effective_time,
                "applied": True,
                "reason": "initial_full_day_baseline" if is_first_applied else "arrival_plus_45_minutes",
            }
        )

    if not block_state:
        return None

    headers = [
        "Block",
        "Time",
        "Scheduled MW",
        "Source Revision",
        "Source File",
        "Arrival Time IST",
        "Effective Time IST",
        "Effective Block",
    ]
    rows: List[List[str]] = []
    for block in range(1, _TOTAL_BLOCKS + 1):
        state = block_state.get(block) or {}
        rows.append(
            [
                str(block),
                _block_to_time(block),
                str(state.get("scheduled_mw", "")),
                str(state.get("source_revision", "")),
                str(state.get("source_file", "")),
                str(state.get("arrival_time_ist", "")),
                str(state.get("effective_time_ist", "")),
                str(state.get("effective_block", "")),
            ]
        )

    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return {
        "csv_text": output.getvalue(),
        "applied_revisions": applied_revisions,
    }


def recompute_enercast_frozen_for_site_date(*, plant_code: str, schedule_date: str) -> Dict[str, Any]:
    bucket = _derive_s3_bucket_name()
    if not bucket:
        return {"success": False, "reason": "bucket_not_configured"}

    normalized_code = _normalize_plant_code(plant_code)
    revisions = _load_intraday_revisions(
        bucket=bucket,
        plant_code=normalized_code,
        schedule_date=str(schedule_date or "").strip(),
    )
    built = _build_enercast_frozen_csv(bucket=bucket, revisions=revisions)
    if not built:
        return {
            "success": False,
            "reason": "no_valid_enercast_revisions",
            "plant_code": normalized_code,
            "schedule_date": schedule_date,
        }

    frozen_folder = _special_s3_plant_folder(normalized_code)
    frozen_prefix = f"frozenschedules/vedanjay/{frozen_folder}/{schedule_date}/"
    output_key = f"{frozen_prefix}enercast_edited_frozen.csv"
    log_key = f"{frozen_prefix}{frozen_folder}_enercast_frozen.log"
    s3 = boto3.client("s3", region_name=ENERCAST_FROZEN_REGION)
    try:
        existing_csv = _fetch_s3_text(bucket, output_key)
    except Exception:
        existing_csv = ""
    if str(existing_csv or "") == str(built["csv_text"] or ""):
        return {
            "success": True,
            "skipped": True,
            "reason": "unchanged",
            "bucket": bucket,
            "schedule_key": output_key,
            "log_key": log_key,
            "plant_code": normalized_code,
            "schedule_date": schedule_date,
            "revision_count": len(revisions),
        }
    try:
        s3.put_object(Bucket=bucket, Key=frozen_prefix)
    except Exception:
        pass

    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=str(built["csv_text"]).encode("utf-8"),
        ContentType="text/csv",
    )

    log_payload = {
        "plant_code": normalized_code,
        "schedule_date": schedule_date,
        "status": "uploaded",
        "reason": "AUTO_ENERCAST_EDITED_FROZEN_FROM_INTRADAY_META",
        "source_prefixes": _intraday_prefixes(normalized_code, schedule_date),
        "stored_schedule_key": output_key,
        "stored_log_key": log_key,
        "created_at": datetime.utcnow().isoformat(),
        "revision_count": len(revisions),
        "applied_revisions": built["applied_revisions"],
    }
    s3.put_object(
        Bucket=bucket,
        Key=log_key,
        Body=json.dumps(log_payload, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json",
    )

    return {
        "success": True,
        "bucket": bucket,
        "schedule_key": output_key,
        "log_key": log_key,
        "plant_code": normalized_code,
        "schedule_date": schedule_date,
        "revision_count": len(revisions),
    }


async def _run_once() -> None:
    today_ist = _ist_now().date().isoformat()
    for plant_code in ENERCAST_FROZEN_PLANTS:
        try:
            recompute_enercast_frozen_for_site_date(
                plant_code=plant_code,
                schedule_date=today_ist,
            )
        except Exception:
            continue


async def enercast_frozen_daemon() -> None:
    while True:
        try:
            if ENERCAST_FROZEN_ENABLED:
                await _run_once()
        except Exception:
            pass
        await asyncio.sleep(max(10, int(ENERCAST_FROZEN_POLL_SECONDS)))


def start_enercast_frozen_task() -> Optional[asyncio.Task]:
    if not ENERCAST_FROZEN_ENABLED:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return loop.create_task(enercast_frozen_daemon())
