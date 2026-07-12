from __future__ import annotations

from dataclasses import dataclass, field
import csv
import fnmatch
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


@dataclass
class MeteredAdapterResult:
    normalized_metered_csv_path: str | None
    metered_status: str
    source_details: dict[str, Any] = field(default_factory=dict)
    checkpoint: dict[str, Any] = field(default_factory=dict)


def render_metered_filename(template: str, run_date: str) -> str:
    dt = datetime.strptime(run_date, "%Y-%m-%d")
    return template.format(
        date_iso=run_date,
        date_yyyymmdd=dt.strftime("%Y%m%d"),
        date_yyyy_mm_dd=dt.strftime("%Y_%m_%d"),
        date_ddmmyy=dt.strftime("%d%m%y"),
        time_hhmmss="000000",
    )


def render_metered_pattern(template: str, run_date: str) -> str:
    dt = datetime.strptime(run_date, "%Y-%m-%d")
    return template.format(
        date_iso=run_date,
        date_yyyymmdd=dt.strftime("%Y%m%d"),
        date_yyyy_mm_dd=dt.strftime("%Y_%m_%d"),
        date_ddmmyy=dt.strftime("%d%m%y"),
        time_hhmmss="*",
    )


def metered_template_to_glob(template: str) -> str:
    pattern = template
    for token in ("{date_iso}", "{date_yyyymmdd}", "{date_yyyy_mm_dd}", "{date_ddmmyy}", "{time_hhmmss}"):
        pattern = pattern.replace(token, "*")
    return pattern


def metered_name_matches_run_date(name: str, run_date: str) -> bool:
    dt = datetime.strptime(run_date, "%Y-%m-%d")
    tokens = {
        run_date,
        dt.strftime("%Y%m%d"),
        dt.strftime("%Y_%m_%d"),
        dt.strftime("%d%m%y"),
    }
    name_upper = str(name or "").upper()
    return any(token.upper() in name_upper for token in tokens)


def parse_snapshot_dt_from_name(name: str) -> datetime | None:
    match = re.search(r"_(\d{6})_(\d{6})\.csv$", name, re.IGNORECASE)
    if not match:
        return None
    stamp = f"{match.group(1)}_{match.group(2)}"
    try:
        return datetime.strptime(stamp, "%d%m%y_%H%M%S")
    except ValueError:
        return None


def read_first_snapshot_row(path: Path) -> tuple[list[str], dict[str, str] | None]:
    with path.open("r", newline="", encoding="utf-8", errors="ignore") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            return [], None
        for row in reader:
            if any((str(v).strip() if v is not None else "") for v in row.values()):
                return list(reader.fieldnames), row
        return list(reader.fieldnames), None


def snapshot_block_fields(snapshot_dt: datetime) -> tuple[str, str, int]:
    block_end = snapshot_dt.replace(
        minute=(snapshot_dt.minute // 15) * 15,
        second=0,
        microsecond=0,
    )
    if block_end.hour == 0 and block_end.minute == 0:
        block_no = 96
        block_start = block_end - timedelta(minutes=15)
    else:
        block_no = (block_end.hour * 60 + block_end.minute) // 15
        block_start = block_end - timedelta(minutes=15)
    return (
        block_start.strftime("%Y-%m-%d %H:%M:%S"),
        block_end.strftime("%Y-%m-%d %H:%M:%S"),
        block_no,
    )


def pick_latest_metered_name(names: list[str], template: str) -> str | None:
    pattern = metered_template_to_glob(template)
    candidates = [n for n in names if fnmatch.fnmatch(n, pattern)]
    if not candidates:
        candidates = [n for n in names if n.lower().endswith(".csv")]
    if not candidates:
        return None
    return max(candidates)


def append_new_rows(tmp_file: Path, local_file: Path, *, rel, logger) -> dict:
    if not local_file.exists():
        tmp_file.replace(local_file)
        logger.info("Metered file initialized: %s", rel(local_file))
        return {"action": "initialized", "appended_rows": None}

    with local_file.open("r", newline="", encoding="utf-8", errors="ignore") as lf:
        existing_rows = sum(1 for _ in lf)

    with tmp_file.open("r", newline="", encoding="utf-8", errors="ignore") as tf:
        reader = list(csv.reader(tf))
    new_rows = reader[existing_rows:]

    if new_rows:
        with local_file.open("a", newline="", encoding="utf-8") as lf:
            writer = csv.writer(lf)
            writer.writerows(new_rows)
        logger.info("Appended %s metered rows: %s", len(new_rows), rel(local_file))
    tmp_file.unlink(missing_ok=True)
    return {"action": "appended" if new_rows else "no_change", "appended_rows": len(new_rows)}


def load_metered_progress(progress_path: Path, *, rel, logger) -> dict:
    if not progress_path.exists():
        return {}
    try:
        data = json.loads(progress_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Failed to read metered progress file: %s", rel(progress_path))
        return {}
    return data if isinstance(data, dict) else {}


def write_metered_progress(progress_path: Path, payload: dict) -> None:
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def infer_last_metered_snapshot_from_csv(local_file: Path, *, rel, logger) -> str | None:
    if not local_file.exists():
        return None
    last_source = None
    try:
        with local_file.open("r", newline="", encoding="utf-8", errors="ignore") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                source = str((row or {}).get("source_file") or "").strip()
                if source:
                    last_source = source
    except Exception:
        logger.debug("Could not infer last metered snapshot from %s", rel(local_file), exc_info=True)
        return None
    return last_source
