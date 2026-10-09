from __future__ import annotations

import csv
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from cloud.common.csv_utils import load_enercast_forecast_csv
from cloud.common.multi_generator_config_loader import apply_frontend_multi_generator_config
from cloud.common.multi_generator_controls import apply_multi_generator_controls


def safe_id(value: str) -> str:
    return str(value or "").strip().upper().replace(" ", "_").replace("/", "_").replace("-", "_")


def buyer_column_ids(buyers: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for buyer in buyers:
        base = safe_id(str(buyer.get("buyer_id") or buyer.get("buyer_name") or "BUYER")) or "BUYER"
        buyer_id = base
        if buyer_id in seen:
            for key in ("contract_id", "approval_number"):
                suffix = safe_id(str(buyer.get(key) or ""))
                if not suffix:
                    continue
                candidate = f"{base}_{suffix}"
                if candidate not in seen:
                    buyer_id = candidate
                    break
            else:
                index = 2
                while f"{base}_{index}" in seen:
                    index += 1
                buyer_id = f"{base}_{index}"
        seen.add(buyer_id)
        ids.append(buyer_id)
    return ids


def block_times(block: int) -> tuple[str, str]:
    start_min = (block - 1) * 15
    end_min = block * 15
    return f"{start_min // 60:02d}:{start_min % 60:02d}", f"{(end_min // 60) % 24:02d}:{end_min % 60:02d}"


def scaling_config(config: dict[str, Any], schedule_type: str | None = None) -> dict[str, Any]:
    cfg = config.get("multiple_generator_formula") or config.get("forecast_scaling") or {}
    if not isinstance(cfg, dict):
        cfg = {}
    else:
        cfg = dict(cfg)
    if schedule_type:
        overrides = cfg.get("schedule_type_overrides") or config.get("schedule_type_overrides") or {}
        override = overrides.get(str(schedule_type).strip().lower()) if isinstance(overrides, dict) else None
        if isinstance(override, dict):
            merged_cfg = dict(cfg)
            merged_cfg.update(override)
            cfg = merged_cfg
    reference = float(cfg.get("reference_capacity_mw") or config.get("reference_capacity_mw") or 0.0)
    if reference <= 0:
        raise ValueError("multiple_generator_formula.reference_capacity_mw must be configured and > 0")
    round_decimals = int(cfg.get("round_decimals", 2))
    forecast_column = str(
        cfg.get("source_forecast_column")
        or (config.get("enercast") or {}).get("forecast_column")
        or ""
    ).strip()
    if not forecast_column:
        raise ValueError("source forecast column is required for multiple-generator formula")
    availability_column = str(cfg.get("availability_column") or "Availability Capacity").strip()
    buyers = [b for b in (cfg.get("buyers") or config.get("buyer_contracts") or []) if isinstance(b, dict) and b.get("enabled", True)]
    if not buyers:
        raise ValueError("at least one multiple-generator buyer must be configured")
    return {
        "reference_capacity_mw": reference,
        "round_decimals": round_decimals,
        "source_forecast_column": forecast_column,
        "availability_column": availability_column,
        "buyers": buyers,
    }


def latest_csv(folder: Path) -> Path | None:
    if not folder.exists():
        return None
    files = [p for p in folder.glob("*.csv") if p.is_file()]
    if not files:
        return None

    def _sort_key(path: Path) -> tuple[int, datetime | int, float, str]:
        match = re.search(r"(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\+0530", path.name)
        if match:
            return (
                2,
                datetime.strptime(f"{match.group(1)} {match.group(2)}:{match.group(3)}", "%Y-%m-%d %H:%M"),
                path.stat().st_mtime,
                path.name,
            )
        rev_match = re.search(r"(?:remc_r|_r|r|_)(\d+)(?:\.csv)?$", path.name.lower())
        if rev_match:
            return (1, int(rev_match.group(1)), path.stat().st_mtime, path.name)
        return (0, 0, path.stat().st_mtime, path.name)

    return max(files, key=_sort_key)


def load_source_forecast(path: Path, config: dict[str, Any]) -> dict[int, float]:
    # csv_utils uses SITE_ID config for strict forecast column when available;
    # the ZTRIC config points it at the combined source column.
    frame = load_enercast_forecast_csv(path)
    return {
        int(row["block"]): float(row["forecast_mw"])
        for _, row in frame.iterrows()
        if row.get("block") is not None and row.get("forecast_mw") is not None
    }


def scaled_rows(
    source_values: dict[int, float],
    config: dict[str, Any],
    schedule_type: str | None = None,
    control_windows: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    scale = scaling_config(config, schedule_type)
    reference = float(scale["reference_capacity_mw"])
    decimals = int(scale["round_decimals"])
    buyers = scale["buyers"]
    buyer_ids = buyer_column_ids(buyers)
    rows: list[dict[str, Any]] = []
    applied_windows: list[dict[str, Any]] = []
    site_id = str(config.get("site_id") or "")
    run_date = str(config.get("_schedule_run_date") or "")
    for block in range(1, 97):
        source = round(float(source_values.get(block, 0.0)), decimals)
        start, end = block_times(block)
        row: dict[str, Any] = {
            "block": block,
            "start_time": start,
            "end_time": end,
            "source_forecast_mw": source,
        }
        values: dict[str, float] = {}
        for buyer, buyer_id in zip(buyers, buyer_ids):
            capacity = float(buyer.get("capacity_mw") or buyer.get("buyer_capacity_mw") or 0.0)
            raw_value = float(source_values.get(block, 0.0)) * capacity / reference
            values[buyer_id] = min(round(max(raw_value, 0.0), decimals), capacity)

        if run_date:
            applied_windows.extend(
                apply_multi_generator_controls(
                    values=values,
                    run_date=run_date,
                    block=block,
                    site_id=site_id,
                    config=config,
                    buyers=buyers,
                    buyer_ids=buyer_ids,
                    reference_capacity_mw=reference,
                    control_windows=control_windows,
                )
            )

        for buyer_id in buyer_ids:
            row[buyer_id] = round(max(values.get(buyer_id, 0.0), 0.0), decimals)
        rows.append(row)
    return rows, scale, applied_windows

def write_scaled_schedule(
    *,
    output_csv: Path,
    output_meta: Path,
    source_file: Path,
    run_date: str,
    schedule_type: str,
    trigger_block: int | None,
    config: dict[str, Any],
    control_windows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    config = apply_frontend_multi_generator_config(config)
    config = dict(config)
    config["_schedule_run_date"] = run_date
    source_values = load_source_forecast(source_file, config)
    rows, scale, applied_windows = scaled_rows(source_values, config, schedule_type, control_windows)
    buyers = scale["buyers"]
    buyer_ids = buyer_column_ids(buyers)
    fieldnames = ["block", "start_time", "end_time", "source_forecast_mw"] + buyer_ids
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    policy = config.get("intraday_schedule_policy") if isinstance(config.get("intraday_schedule_policy"), dict) else {}
    effective_lag_blocks = int(policy.get("effective_lag_blocks") or policy.get("freeze_horizon_blocks") or 3)
    effective_start_block = None
    if schedule_type == "intraday" and trigger_block is not None:
        effective_start_block = min(96, int(trigger_block) + effective_lag_blocks)

    meta = {
        "site_id": config.get("site_id"),
        "site_type": "multiple_generator",
        "schedule_type": schedule_type,
        "run_date": run_date,
        "trigger_block": trigger_block,
        "effective_lag_blocks": effective_lag_blocks if schedule_type == "intraday" else None,
        "effective_lag_minutes": effective_lag_blocks * 15 if schedule_type == "intraday" else None,
        "effective_start_block": effective_start_block,
        "source_file": str(source_file),
        "source_forecast_column": scale["source_forecast_column"],
        "reference_capacity_mw": scale["reference_capacity_mw"],
        "round_decimals": scale["round_decimals"],
        "buyers": [
            {
                "buyer_id": buyer_id,
                "buyer_name": b.get("buyer_name") or b.get("buyer_id"),
                "capacity_mw": float(b.get("capacity_mw") or b.get("buyer_capacity_mw") or 0.0),
                "contract_id": b.get("contract_id"),
                "approval_number": b.get("approval_number"),
            }
            for b, buyer_id in zip(buyers, buyer_ids)
        ],
        "control_windows_loaded": len(control_windows or []),
        "control_windows_applied": len(applied_windows),
        "applied_control_windows": applied_windows[:500],
        "dynamic_multi_generator_config": config.get("dynamic_multi_generator_config"),
        "generated_at": datetime.now().astimezone().isoformat(),
    }
    output_meta.parent.mkdir(parents=True, exist_ok=True)
    output_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta

