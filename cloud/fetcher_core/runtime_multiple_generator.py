from __future__ import annotations

import json
import os
import shutil
import csv
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:
    boto3 = None

from cloud.common.config_loader import load_site_config
from cloud.common.csv_utils import load_enercast_forecast_csv
from cloud.common.multi_generator_config_loader import apply_frontend_multi_generator_config

IST = ZoneInfo("Asia/Kolkata")
BUCKET = os.environ.get("BUCKET", "").strip()
PLANT_ID = os.environ.get("PLANT_ID", "vedanjay").strip() or "vedanjay"
WORK_ROOT_BASE = Path("/tmp")
WORK_ROOT = WORK_ROOT_BASE / "work_multiple_generator"
SITE_NAME = ""
RAW_BASE_PREFIX = ""
_S3 = boto3.client("s3") if (BUCKET and boto3 is not None) else None


@dataclass
class SiteFetchResult:
    site: str
    ok: bool
    returncode: int
    uploaded_files: int
    uploaded_da_files: int
    uploaded_intraday_files: int
    intraday_reason_label: str | None
    stdout_tail: str
    stderr_tail: str
    uploaded_da_keys: list[str]
    uploaded_intraday_keys: list[str]

    def as_response_dict(self) -> dict:
        payload = asdict(self)
        payload.pop("uploaded_da_keys", None)
        payload.pop("uploaded_intraday_keys", None)
        return payload


def _configure_for_site(site_name: str) -> None:
    global SITE_NAME, WORK_ROOT, RAW_BASE_PREFIX
    SITE_NAME = str(site_name or "").strip().upper()
    WORK_ROOT = WORK_ROOT_BASE / f"work_{SITE_NAME.lower()}_multiple_generator"
    RAW_BASE_PREFIX = f"raw/{PLANT_ID}/multiple_generator/{SITE_NAME}"


def _reset_workdir() -> None:
    if WORK_ROOT.exists():
        shutil.rmtree(WORK_ROOT)
    (WORK_ROOT / "data").mkdir(parents=True, exist_ok=True)


def _safe_child_id(child: dict[str, Any]) -> str:
    return str(child.get("s3_folder_name") or child.get("asset_code") or child.get("asset_name") or "").strip().upper().replace(" ", "_")


def _upload_tree(local_root: Path, s3_prefix: str, *, include_metered: bool = True) -> tuple[int, list[str], list[str], list[dict[str, Any]]]:
    uploaded = 0
    da_keys: list[str] = []
    intraday_keys: list[str] = []
    objects: list[dict[str, Any]] = []
    if _S3 is None or not local_root.exists():
        return uploaded, da_keys, intraday_keys, objects
    for path in sorted(p for p in local_root.rglob("*") if p.is_file()):
        rel = path.relative_to(local_root).as_posix()
        key = f"{s3_prefix.rstrip('/')}/{rel}"
        kind = "other"
        normalized = f"/{key.lower()}/"
        if key.lower().endswith(".csv") and "/enercast_data/day_ahead/" in normalized:
            da_keys.append(key)
            kind = "day_ahead"
        elif key.lower().endswith(".csv") and "/enercast_data/intraday/" in normalized:
            intraday_keys.append(key)
            kind = "intraday"
        elif key.lower().endswith(".csv") and "/metered_data/" in normalized:
            kind = "metered"
            if not include_metered:
                objects.append({"kind": kind, "action": "skipped_parent_metered", "local_path": str(path), "s3_key": key})
                continue
        try:
            _S3.head_object(Bucket=BUCKET, Key=key)
            exists = True
        except Exception:
            exists = False
        if exists and kind != "metered":
            objects.append({"kind": kind, "action": "skipped_existing_s3", "local_path": str(path), "s3_key": key})
            continue
        _S3.upload_file(str(path), BUCKET, key)
        uploaded += 1
        action = "overwritten_existing_s3" if exists else "uploaded"
        objects.append({"kind": kind, "action": action, "local_path": str(path), "s3_key": key})
    return uploaded, da_keys, intraday_keys, objects


def _collect_local_forecast_keys(local_root: Path, s3_prefix: str) -> tuple[list[str], list[str]]:
    da_keys: list[str] = []
    intraday_keys: list[str] = []
    if not local_root.exists():
        return da_keys, intraday_keys
    for path in sorted(p for p in local_root.rglob("*") if p.is_file()):
        rel = path.relative_to(local_root).as_posix()
        key = f"{s3_prefix.rstrip('/')}/{rel}"
        normalized = f"/{key.lower()}/"
        if key.lower().endswith(".csv") and "/enercast_data/day_ahead/" in normalized:
            da_keys.append(key)
        elif key.lower().endswith(".csv") and "/enercast_data/intraday/" in normalized:
            intraday_keys.append(key)
    return da_keys, intraday_keys


def _count_local_metered_files(local_root: Path) -> int:
    if not local_root.exists():
        return 0
    return sum(1 for p in local_root.rglob("*") if p.is_file() and p.name.lower().endswith(".csv"))


def _latest_closed_meter_block(run_ts_ist: datetime) -> int:
    total_minutes = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, total_minutes // 15))


def _metered_file_has_block_value(local_file: Path, block_no: int) -> bool:
    if not local_file.exists():
        return False
    try:
        with local_file.open("r", newline="", encoding="utf-8-sig", errors="ignore") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                raw_block = str((row or {}).get("block_no") or (row or {}).get("block") or "").strip()
                try:
                    if int(float(raw_block)) != int(block_no):
                        continue
                except Exception:
                    continue
                for candidate in ("metered_mw", "MW", "power", "Power"):
                    raw_value = str((row or {}).get(candidate) or "").strip()
                    if not raw_value or raw_value.upper() in {"#NA", "NA", "N/A", "NULL"}:
                        continue
                    try:
                        parsed = float(raw_value)
                    except Exception:
                        continue
                    if parsed == parsed:
                        return True
    except Exception:
        return False
    return False


def _parent_forecast_config(parent_cfg: dict[str, Any]) -> dict[str, Any]:
    cfg = dict(parent_cfg)
    cfg["paths"] = dict(parent_cfg.get("paths") or {})
    cfg["paths"]["base_dir"] = str((WORK_ROOT / "data").resolve())
    cfg["metered"] = dict(parent_cfg.get("metered") or {})
    filename_mode = str(cfg["metered"].get("filename_mode") or "").strip().lower()
    cfg["metered"]["enabled"] = filename_mode == "daily_timeseries_file"
    return cfg




def _child_forecast_config(parent_cfg: dict[str, Any], child: dict[str, Any]) -> dict[str, Any]:
    child_id = _safe_child_id(child)
    cfg = dict(parent_cfg)
    cfg["site_id"] = child_id
    cfg["parent_site_id"] = str(parent_cfg.get("site_id") or "").strip().upper()
    cfg["paths"] = dict(parent_cfg.get("paths") or {})
    cfg["paths"]["base_dir"] = str((WORK_ROOT / "data").resolve())
    cfg["paths"]["remote_forecasts"] = str(child.get("remote_forecasts") or cfg["paths"].get("remote_forecasts") or "/forecasts")
    cfg["file_patterns"] = dict(child.get("forecast_file_patterns") or {})
    cfg["enercast"] = dict(parent_cfg.get("enercast") or {})
    if child.get("forecast_column"):
        cfg["enercast"]["forecast_column"] = child.get("forecast_column")
    cfg["metered"] = {"enabled": False, "filename_mode": "disabled"}
    cfg["_fetch_manifest"] = {"raw_inputs": {"enercast": {"day_ahead": [], "intraday": []}, "metered": []}}
    return cfg


def _forecast_stamp(path: Path) -> str | None:
    import re

    match = re.search(r"(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\+0530", path.name)
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}+0530"


def _load_child_forecast_values(path: Path, child_id: str) -> dict[int, float]:
    previous_site_id = os.environ.get("SITE_ID")
    os.environ["SITE_ID"] = child_id
    try:
        frame = load_enercast_forecast_csv(path)
    finally:
        if previous_site_id is None:
            os.environ.pop("SITE_ID", None)
        else:
            os.environ["SITE_ID"] = previous_site_id
    return {
        int(row["block"]): float(row["forecast_mw"])
        for _, row in frame.iterrows()
        if row.get("block") is not None and row.get("forecast_mw") is not None
    }


def _write_combined_forecast(
    *,
    output_path: Path,
    forecast_column: str,
    availability_capacity_mw: float,
    child_files: dict[str, Path],
) -> None:
    summed: dict[int, float] = {block: 0.0 for block in range(1, 97)}
    for child_id, source_path in child_files.items():
        values = _load_child_forecast_values(source_path, child_id)
        for block in range(1, 97):
            summed[block] += float(values.get(block, 0.0))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Block", forecast_column, "Availability Capacity"])
        for block in range(1, 97):
            writer.writerow([block, round(max(summed.get(block, 0.0), 0.0), 3), availability_capacity_mw])

    latest_source_mtime = max((p.stat().st_mtime for p in child_files.values() if p.exists()), default=None)
    arrival = datetime.fromtimestamp(latest_source_mtime, IST) if latest_source_mtime else datetime.now(IST)
    meta_payload = {
        "arrival_timestamp_ist": arrival.isoformat(),
        "aggregation": "sum_enabled_child_forecasts",
        "source_files": {child_id: str(path) for child_id, path in sorted(child_files.items())},
    }
    output_path.with_suffix(".meta.json").write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")


def _sync_child_forecast_aggregation(parent_cfg: dict[str, Any], run_date: str, client, fetch_worker) -> list[dict[str, Any]]:
    aggregation_cfg = parent_cfg.get("child_forecast_aggregation") or {}
    if not isinstance(aggregation_cfg, dict) or not aggregation_cfg.get("enabled"):
        return []

    site_id = str(parent_cfg.get("site_id") or SITE_NAME).strip().upper()
    forecast_column = str(
        aggregation_cfg.get("forecast_column")
        or (parent_cfg.get("enercast") or {}).get("forecast_column")
        or site_id
    ).strip()
    availability_capacity_mw = float(
        aggregation_cfg.get("availability_capacity_mw")
        or (parent_cfg.get("capacity") or {}).get("ac_capacity_mw")
        or parent_cfg.get("plant_capacity_mw")
        or 0.0
    )
    filename_prefix = str(aggregation_cfg.get("filename_prefix") or forecast_column).strip()
    required_children = [
        child
        for child in (parent_cfg.get("children") or [])
        if isinstance(child, dict)
        and child.get("enabled", True)
        and child.get("forecast_file_patterns")
    ]
    if not required_children:
        return []

    child_intraday_by_stamp: dict[str, dict[str, Path]] = {}
    child_count = len(required_children)
    results: list[dict[str, Any]] = []

    for child in required_children:
        child_id = _safe_child_id(child)
        child_cfg = _child_forecast_config(parent_cfg, child)
        child_dirs = fetch_worker._build_data_dirs(WORK_ROOT / "data", child_id, run_date)
        fetch_worker._sync_forecasts(client, child_cfg, run_date, child_dirs)
        for path in sorted(child_dirs["intraday"].glob("*.csv")):
            stamp = _forecast_stamp(path)
            if not stamp:
                continue
            child_intraday_by_stamp.setdefault(stamp, {})[child_id] = path

    parent_intraday_dir = WORK_ROOT / "data" / site_id / run_date / "enercast_data" / "intraday"
    for stamp, child_files in sorted(child_intraday_by_stamp.items()):
        if len(child_files) < child_count:
            results.append(
                {
                    "stamp": stamp,
                    "status": "skipped_missing_child_forecast",
                    "available_children": sorted(child_files),
                    "required_children": [_safe_child_id(child) for child in required_children],
                }
            )
            continue
        output_name = f"{filename_prefix}_Intraday_{stamp}.csv"
        output_path = parent_intraday_dir / output_name
        _write_combined_forecast(
            output_path=output_path,
            forecast_column=forecast_column,
            availability_capacity_mw=availability_capacity_mw,
            child_files=child_files,
        )
        results.append(
            {
                "stamp": stamp,
                "status": "combined",
                "output_path": str(output_path),
                "children": sorted(child_files),
            }
        )

    return results

def _child_meter_config(parent_cfg: dict[str, Any], child: dict[str, Any]) -> dict[str, Any]:
    child_id = _safe_child_id(child)
    cfg: dict[str, Any] = {
        "site_id": child_id,
        "parent_site_id": str(parent_cfg.get("site_id") or "").strip().upper(),
        "multiple_generator_child": True,
        "site_type": "multiple_generator_child",
        "protocol": parent_cfg.get("protocol"),
        "connection": parent_cfg.get("connection"),
        "paths": {
            "base_dir": str((WORK_ROOT / "data").resolve()),
            "remote_forecasts": str((parent_cfg.get("paths") or {}).get("remote_forecasts") or "/forecasts"),
            "remote_metered": str(child.get("remote_metered") or (parent_cfg.get("paths") or {}).get("remote_metered") or ""),
        },
        "file_patterns": {
            "metered_template": str(child.get("metered_template") or f"{child_id}_{{date_yyyymmdd}}.csv"),
            "metered_snapshot_glob": str(child.get("metered_snapshot_glob") or child.get("meter_code") or ""),
        },
        "metered": dict(parent_cfg.get("metered") or {}),
    }
    cfg["metered"].update(child.get("metered") or {})
    if isinstance(child.get("metered_reconciliation"), dict):
        cfg["metered_reconciliation"] = dict(child.get("metered_reconciliation") or {})
    cfg["metered"]["enabled"] = True
    cfg["metered"]["power_unit"] = str(child.get("power_unit") or child.get("metered_power_unit") or "KW").strip() or "KW"
    cfg["metered"]["filename_mode"] = "ftp_snapshot_per_block"
    return cfg


def run_site_fetch(entry: dict[str, Any], run_date: str) -> SiteFetchResult:
    from cloud.fetcher_core import fetch_worker

    site_id = str(entry["site_id"]).strip().upper()
    fetch_mode = str(os.getenv("FETCH_MODE") or "all").strip().lower()
    meter_child = str(os.getenv("METER_CHILD") or "").strip().upper()
    if fetch_mode not in {"all", "forecast", "meter_child"}:
        fetch_mode = "all"
    _configure_for_site(site_id)
    _reset_workdir()
    cfg = apply_frontend_multi_generator_config(load_site_config(site_id))
    manifest: dict[str, Any] = {
        "site_id": site_id,
        "site_type": "multiple_generator",
        "run_date": run_date,
        "manifest_created_at_ist": datetime.now(IST).isoformat(),
        "raw_inputs": {"combined_forecast": [], "metered_children": []},
    }
    uploaded = 0
    uploaded_da_keys: list[str] = []
    uploaded_intraday_keys: list[str] = []
    errors: list[str] = []
    client = None
    current_meter_block = _latest_closed_meter_block(datetime.now(IST))
    try:
        client = fetch_worker._build_remote_client(cfg)

        if fetch_mode in {"all", "forecast"}:
            parent_cfg = _parent_forecast_config(cfg)
            fetch_worker._sync_once_with_client(parent_cfg, run_date, client=client)
            child_forecast_objects = _sync_child_forecast_aggregation(parent_cfg, run_date, client, fetch_worker)
            parent_root = WORK_ROOT / "data" / site_id / run_date
            count, da_keys, intraday_keys, objects = _upload_tree(parent_root, f"{RAW_BASE_PREFIX}/{run_date}", include_metered=False)
            if child_forecast_objects:
                manifest["raw_inputs"]["child_forecast_aggregation"] = child_forecast_objects
            if _S3 is None and not da_keys and not intraday_keys:
                local_da_keys, local_intraday_keys = _collect_local_forecast_keys(parent_root, f"{RAW_BASE_PREFIX}/{run_date}")
                da_keys.extend(local_da_keys)
                intraday_keys.extend(local_intraday_keys)
            uploaded += count
            uploaded_da_keys.extend(da_keys)
            uploaded_intraday_keys.extend(intraday_keys)
            manifest["raw_inputs"]["combined_forecast"] = objects

        # Meter data remains child-wise. Forecasts are not downloaded per child.
        parent_meter_mode = str((cfg.get("metered") or {}).get("filename_mode") or "").strip().lower()
        children = [c for c in (cfg.get("children") or []) if isinstance(c, dict) and c.get("enabled", True)]
        if fetch_mode == "forecast":
            children = []
        elif fetch_mode == "meter_child":
            children = [c for c in children if _safe_child_id(c) == meter_child]
            if not meter_child:
                errors.append("METER_CHILD is required when FETCH_MODE=meter_child")
            elif not children:
                errors.append(f"METER_CHILD {meter_child} not found in enabled children")
        for child in children:
            child_id = _safe_child_id(child)
            if parent_meter_mode == "daily_timeseries_file":
                manifest["raw_inputs"]["metered_children"].append(
                    {
                        "asset_code": child_id,
                        "asset_name": child.get("asset_name"),
                        "status": "skipped_parent_daily_timeseries_meter",
                    }
                )
                continue
            if not child.get("meter_available"):
                manifest["raw_inputs"]["metered_children"].append(
                    {"asset_code": child_id, "asset_name": child.get("asset_name"), "status": "meter_not_available"}
                )
                continue
            try:
                child_cfg = _child_meter_config(cfg, child)
                dirs = fetch_worker._build_data_dirs(WORK_ROOT / "data", child_id, run_date)
                metered_result = fetch_worker._sync_metered(client, child_cfg, run_date, dirs, current_block=current_meter_block)
                metered_file = Path(str(getattr(metered_result, "normalized_metered_csv_path", "") or ""))
                if (
                    getattr(metered_result, "metered_status", "") == "PROVISIONAL_NA"
                    or not metered_file.exists()
                    or not _metered_file_has_block_value(metered_file, current_meter_block)
                ):
                    provisional_file = fetch_worker._ensure_provisional_metered_file(
                        child_cfg,
                        run_date,
                        dirs,
                        current_meter_block,
                    )
                    manifest["raw_inputs"]["metered_children"].append(
                        {
                            "asset_code": child_id,
                            "asset_name": child.get("asset_name"),
                            "meter_code": child.get("meter_code"),
                            "status": "provisional_na",
                            "block_no": current_meter_block,
                            "local_path": str(provisional_file),
                        }
                    )
                    fetch_worker._persist_reconciliation_ledger(
                        cfg=child_cfg,
                        run_date=run_date,
                        block_no=current_meter_block,
                        metered_result=metered_result,
                        status="PROVISIONAL_NA",
                    )
                child_root = WORK_ROOT / "data" / child_id / run_date
                child_prefix = f"{RAW_BASE_PREFIX}/{run_date}/metered_data/{child_id}"
                child_count, _, _, child_objects = _upload_tree(child_root / "metered_data", child_prefix)
                if _S3 is None and child_count == 0:
                    child_count = _count_local_metered_files(child_root / "metered_data")
                uploaded += child_count
                manifest["raw_inputs"]["metered_children"].append(
                    {
                        "asset_code": child_id,
                        "asset_name": child.get("asset_name"),
                        "meter_code": child.get("meter_code"),
                        "uploaded_files": child_count,
                        "objects": child_objects,
                    }
                )
            except Exception as exc:
                child_count = 0
                child_objects = []
                try:
                    child_cfg = _child_meter_config(cfg, child)
                    dirs = fetch_worker._build_data_dirs(WORK_ROOT / "data", child_id, run_date)
                    provisional_file = fetch_worker._ensure_provisional_metered_file(
                        child_cfg,
                        run_date,
                        dirs,
                        current_meter_block,
                    )
                    child_root = WORK_ROOT / "data" / child_id / run_date
                    child_prefix = f"{RAW_BASE_PREFIX}/{run_date}/metered_data/{child_id}"
                    child_count, _, _, child_objects = _upload_tree(child_root / "metered_data", child_prefix)
                    uploaded += child_count
                    fetch_worker._persist_reconciliation_ledger(
                        cfg=child_cfg,
                        run_date=run_date,
                        block_no=current_meter_block,
                        status="PROVISIONAL_NA",
                        note=str(exc),
                        source_details={"remote_path": "", "remote_dir": ""},
                        checkpoint={},
                    )
                except Exception:
                    errors.append(f"{child_id}: {exc}")
                manifest["raw_inputs"]["metered_children"].append(
                    {
                        "asset_code": child_id,
                        "asset_name": child.get("asset_name"),
                        "status": "provisional_na",
                        "block_no": current_meter_block,
                        "error": str(exc),
                        "uploaded_files": child_count,
                        "objects": child_objects,
                    }
                )
    finally:
        if client is not None:
            client.close()

    manifest_path = WORK_ROOT / "data" / site_id / run_date / "fetch_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if _S3 is not None:
        _S3.upload_file(str(manifest_path), BUCKET, f"{RAW_BASE_PREFIX}/{run_date}/fetch_manifest.json")
        uploaded += 1

    if fetch_mode == "meter_child":
        ok = bool(not errors)
    else:
        ok = bool(not errors and (uploaded_da_keys or uploaded_intraday_keys))
    if fetch_mode != "meter_child" and not uploaded_da_keys and not uploaded_intraday_keys:
        errors.append("no combined day-ahead or intraday forecast uploaded")
    return SiteFetchResult(
        site=site_id,
        ok=ok,
        returncode=0 if ok else 1,
        uploaded_files=uploaded,
        uploaded_da_files=len(uploaded_da_keys),
        uploaded_intraday_files=len(uploaded_intraday_keys),
        intraday_reason_label=None,
        stdout_tail="",
        stderr_tail="\n".join(errors)[-4000:],
        uploaded_da_keys=uploaded_da_keys,
        uploaded_intraday_keys=uploaded_intraday_keys,
    )


