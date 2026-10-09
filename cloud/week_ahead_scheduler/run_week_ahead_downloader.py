from __future__ import annotations

import csv
import json
import logging
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:  # pragma: no cover - Lambda image has boto3
    boto3 = None

from cloud.common.config_loader import load_site_config, normalize_site_id
from cloud.common.multiple_generator_formula import write_scaled_schedule
from cloud.fetcher_core.fetch_worker import _build_remote_client
from cloud.scheduler_core import control_capacity

IST = ZoneInfo("Asia/Kolkata")
DEFAULT_SITES = ("KOTHAGUDEM", "KASIPET", "BHUPALPALLY", "OSEPL", "CME", "ZTRIC", "JEWLI", "JGBPL", "ENRICH", "SHAHA")
BUCKET = os.getenv("BUCKET", "").strip()
PLANT_ID = os.getenv("PLANT_ID", "vedanjay").strip() or "vedanjay"
WORK_ROOT = Path(os.getenv("WEEK_AHEAD_WORK_ROOT", "/tmp/week_ahead"))

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")


def _s3_client():
    if not BUCKET:
        raise RuntimeError("BUCKET env var is required for week-ahead downloads")
    if boto3 is None:
        raise RuntimeError("boto3 is required for week-ahead downloads")
    return boto3.client("s3")


def _run_date(event: dict[str, Any]) -> str:
    raw = str(event.get("run_date") or os.getenv("RUN_DATE", "")).strip()
    if raw:
        datetime.strptime(raw, "%Y-%m-%d")
        return raw
    return datetime.now(IST).strftime("%Y-%m-%d")


def _sites(event: dict[str, Any]) -> list[str]:
    raw = event.get("sites") or os.getenv("WEEK_AHEAD_SITES", "")
    if isinstance(raw, str) and raw.strip():
        tokens = [item.strip() for item in raw.split(",")]
    elif isinstance(raw, list):
        tokens = [str(item).strip() for item in raw]
    else:
        tokens = list(DEFAULT_SITES)
    out: list[str] = []
    for token in tokens:
        if not token:
            continue
        site_id = normalize_site_id(token)
        if site_id not in DEFAULT_SITES:
            logger.warning("Ignoring unsupported week-ahead site: %s", site_id)
            continue
        if site_id not in out:
            out.append(site_id)
    return out


def _compile_pattern(pattern: str, run_date: str) -> re.Pattern[str]:
    next_date = (datetime.strptime(run_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    templated = pattern.replace("{current_date}", run_date).replace("{next_date}", next_date)
    return re.compile(templated, re.IGNORECASE)


def _sort_value(match: re.Match[str], name: str) -> tuple[int, str]:
    groups = match.groupdict()
    hh = groups.get("hh")
    mm = groups.get("mm")
    if hh is not None and mm is not None:
        try:
            return (int(hh) * 60 + int(mm), name)
        except ValueError:
            pass
    return (0, name)


def _raw_week_ahead_key(site_id: str, run_date: str, filename: str, cfg: dict[str, Any]) -> str:
    if str((cfg or {}).get("site_type") or "").strip().lower() == "multiple_generator":
        return f"raw/{PLANT_ID}/multiple_generator/{site_id}/{run_date}/enercast_data/week_ahead/{filename}"
    return f"raw/{PLANT_ID}/{site_id}/{run_date}/enercast_data/week_ahead/{filename}"


def _generated_week_ahead_prefix(site_id: str, run_date: str, cfg: dict[str, Any]) -> str:
    if str((cfg or {}).get("site_type") or "").strip().lower() == "multiple_generator":
        return f"generated/{PLANT_ID}/multiple_generator/{site_id}/{run_date}/Week-ahead"
    return f"generated/{PLANT_ID}/{site_id}/{run_date}/Week-ahead"


def _metadata_payload(*, site_id: str, run_date: str, filename: str, remote_path: str, action: str) -> dict[str, Any]:
    now_ist = datetime.now(IST).isoformat()
    return {
        "site_id": site_id,
        "run_date": run_date,
        "forecast_type": "week_ahead",
        "filename": filename,
        "remote_path": remote_path,
        "action": action,
        "recorded_at_ist": now_ist,
    }


def _norm_header_token(value: str) -> str:
    return str(value or "").strip().lower().replace(".", "").replace(" ", "").replace("_", "")


def _looks_like_forecast_header(parts: list[str]) -> bool:
    if not parts:
        return False
    first = _norm_header_token(parts[0])
    has_time = any(
        token in {"from", "to", "timestamp", "datetime"} or "timestamp" in token or "datetime" in token
        for token in (_norm_header_token(p) for p in parts)
    )
    has_forecast = any(
        token in {"forecast", "schmw", "schedule", "declaredforecast"}
        or "forecast" in token
        or token.endswith("mw")
        or token.endswith("megawatt")
        for token in (_norm_header_token(p) for p in parts)
    )
    return first in {"block", "blkno", "blk", "sno"} or (has_time and has_forecast)


def _forecast_column_index(header: list[str], cfg: dict[str, Any]) -> int:
    normalized = [_norm_header_token(h) for h in header]
    configured = _norm_header_token(((cfg.get("enercast") or {}).get("forecast_column") or ""))
    if configured:
        for idx, token in enumerate(normalized):
            if token == configured:
                return idx

    preferred = {"forecast", "schmw", "schedule", "declaredforecast"}
    for idx, token in enumerate(normalized):
        if token in preferred or "forecast" in token:
            return idx

    for idx, token in enumerate(normalized):
        if "availability" in token or token in {"avcmw", "availcap", "availabilitycapacity"}:
            return max(0, idx - 1)

    return max(0, len(header) - 1)


def _parse_float(value: Any) -> float | None:
    try:
        return float(str(value).strip())
    except Exception:
        return None


def _rewrite_jewli_week_ahead_raw(
    *,
    local_path: Path,
    cfg: dict[str, Any],
    s3,
    s3_key: str,
) -> dict[str, Any]:
    with local_path.open("r", encoding="utf-8-sig", newline="") as handle:
        raw_rows = [row for row in csv.reader(handle)]

    if not raw_rows:
        raise ValueError(f"JEWLI week-ahead source file is empty: {local_path}")

    header_idx = None
    for idx, row in enumerate(raw_rows):
        if _looks_like_forecast_header([str(cell) for cell in row]):
            header_idx = idx
            break
    if header_idx is None:
        header_idx = 0

    header = [str(cell).strip() for cell in raw_rows[header_idx]]
    forecast_idx = _forecast_column_index(header, cfg)
    data_start_idx = header_idx + 1

    if data_start_idx < len(raw_rows):
        next_header = [_norm_header_token(cell) for cell in raw_rows[data_start_idx]]
        configured = _norm_header_token(((cfg.get("enercast") or {}).get("forecast_column") or ""))
        if configured and configured in next_header:
            forecast_idx = next_header.index(configured)
            data_start_idx += 1
        elif any(token in {"forecast", "schmw", "schedule", "declaredforecast"} or "forecast" in token for token in next_header):
            forecast_idx = _forecast_column_index([str(cell) for cell in raw_rows[data_start_idx]], cfg)
            data_start_idx += 1

    valid_row_count = 0
    flat_applied = 0
    for row in raw_rows[data_start_idx:]:
        if forecast_idx >= len(row):
            continue
        source_mw = _parse_float(row[forecast_idx])
        if source_mw is None:
            continue

        valid_row_count += 1
        raw_block = None
        try:
            raw_block = int(float(str(row[0]).strip()))
        except Exception:
            raw_block = None

        if raw_block is None:
            block_of_day = ((valid_row_count - 1) % 96) + 1
        elif 1 <= raw_block <= 96:
            block_of_day = raw_block
        else:
            block_of_day = ((raw_block - 1) % 96) + 1

        if 26 <= block_of_day <= 74:
            row[forecast_idx] = "7.2"
            flat_applied += 1

    if valid_row_count == 0:
        raise ValueError(f"No valid JEWLI week-ahead rows found in {local_path}")

    with local_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(raw_rows)

    s3.upload_file(str(local_path), BUCKET, s3_key)
    return {
        "raw_corrected": True,
        "s3_key": s3_key,
        "rows": valid_row_count,
        "flat_blocks_applied": flat_applied,
        "rule": "JEWLI raw week-ahead blocks 26-74 set to 7.2 MW for each day",
    }

def _process_multiple_generator_week_ahead(
    *,
    site_id: str,
    run_date: str,
    cfg: dict[str, Any],
    local_path: Path,
    s3,
    s3_key: str,
) -> dict[str, Any]:
    out_dir = WORK_ROOT / site_id / run_date / "generated_week_ahead"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(IST).strftime("%Y%m%dt%H%M%S")
    output_csv = out_dir / f"schedule_weekahead_{run_date.replace('-', '')}_{stamp}.csv"
    output_meta = out_dir / f"schedule_weekahead_{run_date.replace('-', '')}_{stamp}.csv.meta.json"
    control_windows = control_capacity.load_control_windows(
        table_name=os.getenv("CONTROL_WINDOWS_TABLE"),
        plant_id=PLANT_ID,
        site_id=site_id,
        logger=logger,
    )
    meta = write_scaled_schedule(
        output_csv=output_csv,
        output_meta=output_meta,
        source_file=local_path,
        run_date=run_date,
        schedule_type="week_ahead",
        trigger_block=None,
        config=cfg,
        control_windows=control_windows,
    )

    # Multiple-generator Week-Ahead is consumed from raw S3 by the UI.
    # Upload the buyer-split CSV back to the original raw key and avoid a generated copy.
    s3.upload_file(str(output_csv), BUCKET, s3_key)
    return {
        "raw_corrected": True,
        "s3_key": s3_key,
        "control_windows_loaded": len(control_windows),
        "control_windows_applied": meta.get("control_windows_applied"),
        "formula": meta,
        "rule": "multiple-generator week-ahead buyer split written to raw key",
    }


def _download_site(site_id: str, run_date: str, s3) -> dict[str, Any]:
    cfg = load_site_config(site_id)
    patterns = cfg.get("file_patterns", {}) if isinstance(cfg, dict) else {}
    pattern = str(patterns.get("week_ahead_filename_regex") or "").strip()
    if not pattern:
        return {"site_id": site_id, "ok": False, "reason": "missing_week_ahead_filename_regex"}

    remote_dir = str(((cfg.get("paths") or {}).get("remote_forecasts")) or "").strip()
    if not remote_dir:
        return {"site_id": site_id, "ok": False, "reason": "missing_remote_forecasts_path"}

    regex = _compile_pattern(pattern, run_date)
    client = _build_remote_client(cfg)
    try:
        names = client.list_names(remote_dir)
        matches: list[tuple[tuple[int, str], str, re.Match[str]]] = []
        for name in names:
            m = regex.search(str(name))
            if m:
                matches.append((_sort_value(m, str(name)), str(name), m))
        if not matches:
            return {"site_id": site_id, "ok": True, "downloaded": 0, "skipped_existing": 0, "matches": 0}

        matches.sort(key=lambda item: item[0])
        selected_name = matches[-1][1]
        remote_path = f"{remote_dir.rstrip('/')}/{selected_name}"
        s3_key = _raw_week_ahead_key(site_id, run_date, selected_name, cfg)
        meta_key = f"{s3_key}.meta.json"
        local_path = WORK_ROOT / site_id / run_date / selected_name
        local_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            s3.head_object(Bucket=BUCKET, Key=s3_key)
            exists = True
        except Exception:
            exists = False

        action = "downloaded"
        downloaded = 1
        skipped_existing = 0
        if exists:
            action = "skipped_existing_s3"
            downloaded = 0
            skipped_existing = 1
            s3.download_file(BUCKET, s3_key, str(local_path))
        else:
            client.download(remote_path, local_path)
            s3.upload_file(str(local_path), BUCKET, s3_key)

        metadata = _metadata_payload(
            site_id=site_id,
            run_date=run_date,
            filename=selected_name,
            remote_path=remote_path,
            action=action,
        )
        try:
            metadata["size_bytes"] = local_path.stat().st_size
        except Exception:
            pass

        formula_result = None
        if str((cfg or {}).get("site_type") or "").strip().lower() == "multiple_generator":
            formula_result = _process_multiple_generator_week_ahead(
                site_id=site_id,
                run_date=run_date,
                cfg=cfg,
                local_path=local_path,
                s3=s3,
                s3_key=s3_key,
            )
            action = "multiple_generator_raw_corrected"
        elif site_id.upper() == "JEWLI":
            formula_result = _rewrite_jewli_week_ahead_raw(
                local_path=local_path,
                cfg=cfg,
                s3=s3,
                s3_key=s3_key,
            )
            action = "jewli_raw_corrected"

        if formula_result:
            metadata["formula_result"] = formula_result
            metadata["action"] = action
        s3.put_object(Bucket=BUCKET, Key=meta_key, Body=json.dumps(metadata, indent=2).encode("utf-8"))

        return {
            "site_id": site_id,
            "ok": True,
            "downloaded": downloaded,
            "skipped_existing": skipped_existing,
            "matches": len(matches),
            "filename": selected_name,
            "s3_key": s3_key,
            "formula_result": formula_result,
        }
    finally:
        try:
            client.close()
        except Exception:
            logger.exception("Failed to close remote client for site=%s", site_id)


def run(event: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(event or {})
    run_date = _run_date(payload)
    selected_sites = _sites(payload)
    s3 = _s3_client()

    results: list[dict[str, Any]] = []
    for site_id in selected_sites:
        try:
            result = _download_site(site_id, run_date, s3)
        except Exception as exc:
            logger.exception("Week-ahead download failed for site=%s date=%s", site_id, run_date)
            result = {"site_id": site_id, "ok": False, "error": str(exc)}
        results.append(result)

    ok = all(bool(item.get("ok")) for item in results)
    return {
        "ok": ok,
        "run_date": run_date,
        "sites": selected_sites,
        "downloaded": sum(int(item.get("downloaded") or 0) for item in results),
        "skipped_existing": sum(int(item.get("skipped_existing") or 0) for item in results),
        "results": results,
    }


def main() -> int:
    result = run({})
    print(json.dumps(result, indent=2, default=str))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())




