from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from cloud.common.multiple_generator_formula import latest_csv, write_scaled_schedule
from cloud.scheduler_core import control_capacity


def _download_prefix(s3_client, bucket: str, prefix: str, local_root: Path) -> int:
    count = 0
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            key = str(obj.get("Key") or "")
            if not key or key.endswith("/"):
                continue
            rel = key[len(prefix):].lstrip("/")
            dst = local_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            s3_client.download_file(bucket, key, str(dst))
            count += 1
    return count


def _pick_source_file(raw_date_root: Path) -> tuple[str, Path]:
    intraday = latest_csv(raw_date_root / "enercast_data" / "intraday")
    if intraday is not None:
        return "intraday", intraday
    dayahead = latest_csv(raw_date_root / "enercast_data" / "day_ahead")
    if dayahead is not None:
        return "day_ahead", dayahead
    raise RuntimeError(f"No combined ZTRIC forecast CSV found under {raw_date_root}")


def _output_name(schedule_type: str, forced_block: int, run_ts_ist: datetime, run_date: str) -> str:
    ts = run_ts_ist.strftime("%Y%m%dt%H%M%S")
    if schedule_type == "day_ahead":
        return f"schedule_dayahead_{run_date.replace('-', '')}_{ts}.csv"
    return f"schedule_from_{forced_block}_{ts}.csv"


def run_multi_generator_worker(
    *,
    event: dict[str, Any],
    site: str,
    config: dict[str, Any],
    bucket: str,
    plant_id: str,
    work_root: Path,
    raw_base_prefix: str,
    generated_base_prefix: str,
    run_ts_ist: datetime,
    run_ts_ist_iso: str,
    forced_block: int,
    schedule_reason_label: str | None,
    intraday_trigger_key: str | None,
    trigger_type: str | None,
    run_context_id: str | None,
    engine_script: Path,
    repo_root: Path,
    s3_client,
    logger,
) -> dict[str, Any]:
    run_date = run_ts_ist.strftime("%Y-%m-%d")
    raw_prefix = f"{raw_base_prefix}/{run_date}/"
    raw_date_root = work_root / "raw" / run_date
    if raw_date_root.exists():
        shutil.rmtree(raw_date_root)
    downloaded_raw = _download_prefix(s3_client, bucket, raw_prefix, raw_date_root)
    if downloaded_raw == 0:
        raise RuntimeError(f"No raw multi-generator files found under s3://{bucket}/{raw_prefix}")

    schedule_type, source_file = _pick_source_file(raw_date_root)
    control_windows = control_capacity.load_control_windows(
        table_name=os.getenv("CONTROL_WINDOWS_TABLE"),
        plant_id=plant_id,
        site_id=site,
        logger=logger,
    )
    output_dir = work_root / "outputs" / run_date
    output_name = _output_name(schedule_type, forced_block, run_ts_ist, run_date)
    output_csv = output_dir / output_name
    output_meta = output_dir / f"{output_name}.meta.json"
    meta = write_scaled_schedule(
        output_csv=output_csv,
        output_meta=output_meta,
        source_file=source_file,
        run_date=run_date,
        schedule_type=schedule_type,
        trigger_block=forced_block,
        config=config,
        control_windows=control_windows,
    )

    summary = {
        "run_context_id": run_context_id,
        "site": site,
        "site_type": "multiple_generator",
        "mode": "combined_forecast_capacity_ratio",
        "ok": True,
        "returncode": 0,
        "engine_block_ref": forced_block,
        "run_ts_ist": run_ts_ist_iso,
        "schedule_reason_label": schedule_reason_label,
        "intraday_trigger_key": intraday_trigger_key,
        "trigger_type": trigger_type,
        "downloaded_raw_files": downloaded_raw,
        "source_file": str(source_file),
        "generated_csv": str(output_csv),
        "control_windows_loaded": len(control_windows),
        "control_windows_applied": meta.get("control_windows_applied"),
        "formula": meta,
    }
    summary_path = output_dir / "multiple_generator_formula_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    uploaded = 0
    for path in sorted(output_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(output_dir).as_posix()
        s3_client.upload_file(str(path), bucket, f"{generated_base_prefix}/{run_date}/{rel}")
        uploaded += 1

    logger.info(
        "MULTI GENERATOR FORMULA RUN | site=%s type=%s source=%s uploaded=%s",
        site,
        schedule_type,
        source_file.name,
        uploaded,
    )
    summary["uploaded_generated_files"] = uploaded
    return summary

