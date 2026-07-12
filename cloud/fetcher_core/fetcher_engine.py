from __future__ import annotations

import json
import os
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:
    boto3 = None

from cloud.common.lambda_invoke import is_local_invocation
from cloud.common.payload_models import SchedulerPayload
from cloud.common.site_registry import get_site_entry
from cloud.common.trigger_types import CUSTOM, NONE
from cloud.fetcher_core.control_state_reader import load_pending_planned_windows
from cloud.fetcher_core.intraday_source_reader import discover_latest_intraday_source
from cloud.fetcher_core.metered_pipeline import SiteFetchResult, run_site_fetch
from cloud.fetcher_core.scheduler_invoker import invoke_scheduler
from cloud.fetcher_core.scheduler_payload_builder import build_payload
from cloud.fetcher_core.intraday_trigger_reader import assess_intraday_trigger
from cloud.fetcher_core.trigger_resolver import load_decision_state, resolve_trigger, save_decision_state
from cloud.fetcher_core.whatsapp_fallback_reader import assess_whatsapp_out_of_band

IST = ZoneInfo("Asia/Kolkata")
REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUD_ROOT = REPO_ROOT / "cloud"
FETCH_WORKER = CLOUD_ROOT / "fetcher_core" / "fetch_worker.py"
BUCKET = str(os.getenv("BUCKET", "")).strip()
PLANT_ID = str(os.getenv("PLANT_ID", "vedanjay")).strip() or "vedanjay"


@contextmanager
def temporary_env(**updates: str):
    previous = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _parse_run_ts(event_payload: dict[str, Any]) -> datetime:
    raw = str(event_payload.get("run_ts_ist") or "").strip()
    if raw:
        try:
            parsed = datetime.fromisoformat(raw)
            return parsed.replace(tzinfo=IST) if parsed.tzinfo is None else parsed.astimezone(IST)
        except Exception:
            pass
    return datetime.now(IST)


def _timestamp_to_block_ist(run_ts_ist: datetime) -> int:
    mins = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, 1 + (mins // 15)))


def _current_slot_label(site_id: str, run_ts_ist: datetime) -> str | None:
    from cloud.common.config_loader import load_site_config

    cfg = load_site_config(site_id)
    slots = (((cfg.get("schedule_submission") or {}).get("slots")) or []) if isinstance(cfg, dict) else []
    current_hhmm = run_ts_ist.strftime("%H:%M")
    for slot in slots:
        start = str(slot.get("start") or "").strip()
        end = str(slot.get("end") or "").strip()
        if start and end and start <= current_hhmm < end:
            return f"{start}-{end}"
    return None


def _scan_local_inputs(site_id: str, run_date: str, base_dir: Path) -> dict[str, Any]:
    root = base_dir / site_id.upper() / run_date
    intraday_dir = root / "enercast_data" / "intraday"
    dayahead_dir = root / "enercast_data" / "day_ahead"
    metered_dir = root / "metered_data"
    intraday_files = sorted([p for p in intraday_dir.glob("*.csv") if p.is_file()], key=lambda p: p.stat().st_mtime)
    dayahead_files = sorted([p for p in dayahead_dir.glob("*.csv") if p.is_file()], key=lambda p: p.stat().st_mtime)
    metered_files = sorted([p for p in metered_dir.glob("*.csv") if p.is_file()], key=lambda p: p.stat().st_mtime)
    return {
        "root": root,
        "latest_intraday": intraday_files[-1] if intraday_files else None,
        "latest_dayahead": dayahead_files[-1] if dayahead_files else None,
        "latest_metered": metered_files[-1] if metered_files else None,
        "manifest": root / "fetch_manifest.json",
    }


def _run_local_fetch_worker(site_id: str, run_date: str, base_dir: Path) -> SiteFetchResult:
    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    env["SITE_ID"] = site_id
    env["SITE_NAME"] = site_id
    env["FETCH_DATE"] = run_date
    env["FETCH_BASE_DIR"] = str(base_dir)
    env["PYTHONPATH"] = str(REPO_ROOT)
    proc = subprocess.run(
        [sys.executable, str(FETCH_WORKER), "--site", site_id, "--date", run_date],
        env=env,
        capture_output=True,
        text=True,
    )
    scanned = _scan_local_inputs(site_id, run_date, base_dir)
    uploaded_da_keys = [str(scanned["latest_dayahead"])] if scanned["latest_dayahead"] is not None else []
    uploaded_intraday_keys = [str(scanned["latest_intraday"])] if scanned["latest_intraday"] is not None else []
    return SiteFetchResult(
        site=site_id,
        ok=proc.returncode == 0,
        returncode=int(proc.returncode),
        uploaded_files=len(uploaded_da_keys) + len(uploaded_intraday_keys),
        uploaded_da_files=len(uploaded_da_keys),
        uploaded_intraday_files=len(uploaded_intraday_keys),
        intraday_reason_label=None,
        stdout_tail=str(proc.stdout or "")[-4000:],
        stderr_tail=str(proc.stderr or "")[-4000:],
        uploaded_da_keys=uploaded_da_keys,
        uploaded_intraday_keys=uploaded_intraday_keys,
    )


def _effective_local_base_dir(event_payload: dict[str, Any], site_id: str) -> Path:
    local_env = event_payload.get("local_env") if isinstance(event_payload.get("local_env"), dict) else {}
    data_root = str(local_env.get("DATA_ROOT") or "").strip()
    if data_root:
        data_path = Path(data_root)
        return data_path.parent if data_path.name.upper() == site_id.upper() else data_path
    fetch_base = str(event_payload.get("fetch_base_dir") or "").strip()
    if fetch_base:
        return Path(fetch_base)
    return CLOUD_ROOT / "data"


def _workspace_item_local(path: Path, local_relpath: str, kind: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "source_type": "local",
        "path": str(path),
        "local_relpath": local_relpath.replace("\\", "/"),
    }


def _workspace_item_s3(key: str, local_relpath: str, kind: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "source_type": "s3",
        "bucket": BUCKET,
        "key": key,
        "local_relpath": local_relpath.replace("\\", "/"),
    }


def _load_local_manifest(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _raw_fetch_manifest_key(site_id: str, run_date: str) -> str:
    return f"raw/{PLANT_ID}/{site_id.upper()}/{run_date}/fetch_manifest.json"


def _load_raw_fetch_manifest_s3(site_id: str, run_date: str) -> dict[str, Any]:
    if not BUCKET or boto3 is None:
        return {}
    try:
        resp = boto3.client("s3").get_object(Bucket=BUCKET, Key=_raw_fetch_manifest_key(site_id, run_date))
        payload = json.loads(resp["Body"].read().decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _load_current_fetch_manifest(
    *,
    site_id: str,
    run_date: str,
    local_mode: bool,
    local_scan: dict[str, Any] | None,
) -> dict[str, Any]:
    if local_scan and local_scan.get("manifest") is not None:
        manifest = _load_local_manifest(Path(local_scan["manifest"]))
        if manifest:
            return manifest
    if not local_mode:
        return _load_raw_fetch_manifest_s3(site_id, run_date)
    return {}


def _valid_metered_entries(fetch_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    metered_entries = (((fetch_manifest.get("raw_inputs") or {}).get("metered")) or [])
    if not isinstance(metered_entries, list):
        return []
    valid: list[dict[str, Any]] = []
    for entry in metered_entries:
        if not isinstance(entry, dict):
            continue
        status = str(entry.get("status") or "").strip().lower()
        if status in {"failed", "error", "missing", "unavailable"} or entry.get("error"):
            continue
        key = str(entry.get("s3_key") or "").strip()
        local_path = str(entry.get("local_path") or entry.get("requested_local_path") or "").strip()
        if key or local_path:
            valid.append(entry)
    return valid


def _current_metered_available(
    *,
    local_mode: bool,
    local_scan: dict[str, Any] | None,
    fetch_manifest: dict[str, Any],
) -> bool:
    if local_mode and local_scan and local_scan.get("latest_metered") is not None:
        return True
    return bool(_valid_metered_entries(fetch_manifest))


def _generated_prefix(site_id: str, run_date: str) -> str:
    return f"generated/{PLANT_ID}/{site_id.upper()}/outputs/{run_date}/"


def _find_previous_generated_s3(site_id: str, run_date: str) -> dict[str, str]:
    if not BUCKET or boto3 is None:
        return {}
    prefix = _generated_prefix(site_id, run_date)
    try:
        resp = boto3.client("s3").list_objects_v2(Bucket=BUCKET, Prefix=prefix)
    except Exception:
        return {}
    latest_schedule_key = None
    latest_schedule_sort = None
    engine_state_key = None
    for item in resp.get("Contents", []) or []:
        key = str(item.get("Key") or "")
        if key.endswith("engine_state.json"):
            engine_state_key = key
        elif key.endswith(".csv") and "schedule_from_" in Path(key).name and "/Day-ahead/" not in key:
            sort_value = item.get("LastModified")
            if latest_schedule_key is None or (latest_schedule_sort is not None and sort_value is not None and sort_value > latest_schedule_sort):
                latest_schedule_key = key
                latest_schedule_sort = sort_value
    result: dict[str, str] = {}
    if engine_state_key:
        result["engine_state"] = engine_state_key
    if latest_schedule_key:
        result["schedule_csv"] = latest_schedule_key
        result["schedule_meta"] = latest_schedule_key[:-4] + ".meta.json"
    return result


def _find_previous_generated_local(site_id: str, run_date: str, local_env: dict[str, Any]) -> dict[str, Path]:
    custom_base = str(local_env.get("CUSTOM_OUTPUT_BASE") or "").strip()
    output_day = (Path(custom_base) / run_date) if custom_base else (CLOUD_ROOT / "outputs" / site_id.upper() / run_date)
    result: dict[str, Path] = {}
    state_path = output_day / "engine_state.json"
    if state_path.exists():
        result["engine_state"] = state_path
    schedules = sorted([path for path in output_day.glob("schedule_from_*.csv") if path.is_file()], key=lambda path: path.stat().st_mtime)
    if schedules:
        result["schedule_csv"] = schedules[-1]
        meta_path = schedules[-1].with_suffix(".meta.json")
        if meta_path.exists():
            result["schedule_meta"] = meta_path
    return result


def _build_workspace_manifest(
    *,
    site_id: str,
    run_date: str,
    local_mode: bool,
    local_env: dict[str, Any],
    local_scan: dict[str, Any] | None,
    fetch_result: SiteFetchResult,
    selected_intraday_key: str | None,
    current_block: int | None = None,
) -> dict[str, Any]:
    manifest = {
        "version": "v1",
        "site_id": site_id.upper(),
        "run_date": run_date,
        "items": [],
    }
    items: list[dict[str, Any]] = manifest["items"]

    if local_mode:
        if local_scan:
            if local_scan.get("manifest") is not None and Path(local_scan["manifest"]).exists():
                items.append(_workspace_item_local(Path(local_scan["manifest"]), f"data/{run_date}/fetch_manifest.json", "fetch_manifest"))
            if local_scan.get("latest_intraday") is not None:
                path = Path(local_scan["latest_intraday"])
                items.append(_workspace_item_local(path, f"data/{run_date}/enercast_data/intraday/{path.name}", "intraday_forecast"))
            if local_scan.get("latest_dayahead") is not None:
                path = Path(local_scan["latest_dayahead"])
                items.append(_workspace_item_local(path, f"data/{run_date}/enercast_data/day_ahead/{path.name}", "day_ahead_forecast"))
            if local_scan.get("latest_metered") is not None:
                path = Path(local_scan["latest_metered"])
                item = _workspace_item_local(path, f"data/{run_date}/metered_data/{path.name}", "metered")
                if current_block is not None:
                    item["metered_max_block"] = int(current_block)
                items.append(item)
        for kind, path in _find_previous_generated_local(site_id, run_date, local_env).items():
            if kind == "engine_state":
                items.append(_workspace_item_local(path, f"outputs/{run_date}/engine_state.json", "previous_engine_state"))
            else:
                items.append(_workspace_item_local(path, f"outputs/{run_date}/{path.name}", f"previous_{kind}"))
        return manifest

    raw_manifest = _load_current_fetch_manifest(
        site_id=site_id,
        run_date=run_date,
        local_mode=local_mode,
        local_scan=local_scan,
    )
    if BUCKET:
        items.append(_workspace_item_s3(f"raw/{PLANT_ID}/{site_id.upper()}/{run_date}/fetch_manifest.json", f"data/{run_date}/fetch_manifest.json", "fetch_manifest"))
    key = str(selected_intraday_key or "").strip()
    if not key and fetch_result.uploaded_intraday_keys:
        key = str(fetch_result.uploaded_intraday_keys[-1])
    if key:
        items.append(_workspace_item_s3(key, f"data/{run_date}/enercast_data/intraday/{Path(key).name}", "intraday_forecast"))
    if fetch_result.uploaded_da_keys:
        key = str(fetch_result.uploaded_da_keys[-1])
        items.append(_workspace_item_s3(key, f"data/{run_date}/enercast_data/day_ahead/{Path(key).name}", "day_ahead_forecast"))
    for entry in reversed(_valid_metered_entries(raw_manifest)):
        key = str(entry.get("s3_key") or "").strip()
        if not key:
            local_name = Path(str(entry.get("local_path") or entry.get("requested_local_path") or "")).name
            if local_name:
                key = f"raw/{PLANT_ID}/{site_id.upper()}/{run_date}/metered_data/{local_name}"
        if key:
            item = _workspace_item_s3(key, f"data/{run_date}/metered_data/{Path(key).name}", "metered")
            if current_block is not None:
                item["metered_max_block"] = int(current_block)
            items.append(item)
            break
    for kind, key in _find_previous_generated_s3(site_id, run_date).items():
        if key:
            if kind == "engine_state":
                items.append(_workspace_item_s3(key, f"outputs/{run_date}/engine_state.json", "previous_engine_state"))
            else:
                items.append(_workspace_item_s3(key, f"outputs/{run_date}/{Path(key).name}", f"previous_{kind}"))
    return manifest


def _build_scheduler_payload(
    *,
    site_id: str,
    entry: dict[str, Any],
    event_payload: dict[str, Any],
    decision,
    run_ts_ist: datetime,
    run_date: str,
    current_block: int,
    local_scan: dict[str, Any] | None,
    fetch_result: SiteFetchResult,
    selected_intraday_key: str | None,
) -> SchedulerPayload:
    local_env = dict(event_payload.get("local_env") or {})
    latest_intraday_path = str(local_scan["latest_intraday"]) if local_scan and local_scan.get("latest_intraday") is not None else None
    latest_dayahead_path = str(local_scan["latest_dayahead"]) if local_scan and local_scan.get("latest_dayahead") is not None else None
    latest_metered_path = str(local_scan["latest_metered"]) if local_scan and local_scan.get("latest_metered") is not None else None
    fetch_manifest = _load_current_fetch_manifest(
        site_id=site_id,
        run_date=run_date,
        local_mode=is_local_invocation(event_payload),
        local_scan=local_scan,
    )
    valid_metered_entries = _valid_metered_entries(fetch_manifest)
    metered_s3_path = None
    if valid_metered_entries:
        entry_metered = valid_metered_entries[-1]
        metered_s3_path = str(entry_metered.get("s3_key") or "").strip() or None
        if metered_s3_path is None:
            local_name = Path(str(entry_metered.get("local_path") or entry_metered.get("requested_local_path") or "")).name
            if local_name:
                metered_s3_path = f"raw/{PLANT_ID}/{site_id.upper()}/{run_date}/metered_data/{local_name}"
    metered_available = bool(latest_metered_path or valid_metered_entries)
    payload = build_payload(
        payload_version="v1",
        site_id=site_id,
        run_date=run_date,
        run_ts_ist=run_ts_ist.isoformat(),
        current_block=current_block,
        current_slot=_current_slot_label(site_id, run_ts_ist),
        trigger_type=decision.trigger_type,
        schedule_reason=decision.schedule_reason,
        source_event_id=decision.source_event_id,
        fetch_manifest_s3_path=(str(local_scan["manifest"]) if local_scan and local_scan.get("manifest") is not None else None),
        selected_forecast_type=decision.selected_forecast_type,
        intraday_revision=decision.intraday_revision,
        intraday_forecast_s3_path=latest_intraday_path or selected_intraday_key,
        day_ahead_forecast_s3_path=latest_dayahead_path,
        metered_status=("AVAILABLE" if metered_available else "UNAVAILABLE"),
        normalized_metered_s3_path=latest_metered_path or metered_s3_path,
        scheduler_workspace_manifest=_build_workspace_manifest(
            site_id=site_id,
            run_date=run_date,
            local_mode=is_local_invocation(event_payload),
            local_env=local_env,
            local_scan=local_scan,
            fetch_result=fetch_result,
            selected_intraday_key=selected_intraday_key,
            current_block=current_block,
        ),
        control_state={
            "planned_window_ids": list(decision.planned_window_ids or []),
        },
        whatsapp_fallback=dict(decision.whatsapp_fallback or {}),
        local_env=local_env,
        custom_start_block=int(event_payload["custom_start_block"]) if event_payload.get("custom_start_block") is not None else None,
        intraday_file_name=str(event_payload.get("intraday_file_name") or "").strip() or None,
    )
    return payload


def run(site_id: str, event: dict[str, Any] | None, context: Any) -> dict[str, Any]:
    entry = get_site_entry(site_id)
    event_payload = dict(event or {})
    run_ts_ist = _parse_run_ts(event_payload)
    run_date = str(event_payload.get("run_date") or "").strip() or run_ts_ist.strftime("%Y-%m-%d")
    current_block = int(event_payload.get("current_block") or event_payload.get("engine_block_ref") or _timestamp_to_block_ist(run_ts_ist))
    local_mode = is_local_invocation(event_payload)

    current_function = str(os.getenv("AWS_LAMBDA_FUNCTION_NAME", "")).strip().lower()
    if "scheduler" in current_function:
        raise RuntimeError(
            f"Fetch handler invoked inside scheduler Lambda ({current_function}). "
            "Deploy the scheduler using the scheduler image/handler."
        )

    with temporary_env(
        SITE_NAME=entry["site_id"],
        SITE_IDS=entry["site_id"],
        SITE_ID=entry["site_id"],
    ):
        if bool(event_payload.get("skip_fetch")):
            fetch_result = SiteFetchResult(
                site=entry["site_id"],
                ok=True,
                returncode=0,
                uploaded_files=0,
                uploaded_da_files=0,
                uploaded_intraday_files=0,
                intraday_reason_label=None,
                stdout_tail="",
                stderr_tail="",
                uploaded_da_keys=[],
                uploaded_intraday_keys=[],
            )
        elif local_mode:
            fetch_result = _run_local_fetch_worker(entry["site_id"], run_date, _effective_local_base_dir(event_payload, entry["site_id"]))
        else:
            fetch_result = run_site_fetch(entry, run_date)

    local_scan = _scan_local_inputs(entry["site_id"], run_date, _effective_local_base_dir(event_payload, entry["site_id"])) if local_mode else None
    decision_state = load_decision_state(entry["site_id"])
    latest_intraday_name = None
    latest_intraday_key = None
    if str(event_payload.get("intraday_file_name") or "").strip():
        latest_intraday_name = str(event_payload.get("intraday_file_name")).strip()
    elif local_scan and local_scan.get("latest_intraday") is not None:
        latest_intraday_name = local_scan["latest_intraday"].name
        latest_intraday_key = str(local_scan["latest_intraday"])
    elif not local_mode:
        discovered_source = discover_latest_intraday_source(
            entry["site_id"],
            run_date,
            current_block,
        )
        if discovered_source:
            latest_intraday_name = str(discovered_source["name"])
            latest_intraday_key = str(discovered_source["s3_key"])
    elif fetch_result.uploaded_intraday_keys:
        latest_intraday_key = str(fetch_result.uploaded_intraday_keys[-1])
        latest_intraday_name = Path(latest_intraday_key).name
    current_fetch_manifest = _load_current_fetch_manifest(
        site_id=entry["site_id"],
        run_date=run_date,
        local_mode=local_mode,
        local_scan=local_scan,
    )
    if _current_metered_available(local_mode=local_mode, local_scan=local_scan, fetch_manifest=current_fetch_manifest):
        whatsapp_assessment = {
            "triggered": False,
            "reason": "metered_data_available_current_run",
        }
    else:
        whatsapp_assessment = assess_whatsapp_out_of_band(
            site_id=entry["site_id"],
            run_ts_ist=run_ts_ist,
            run_date=run_date,
            current_block=current_block,
            decision_state=decision_state,
            local_env=(event_payload.get("local_env") if isinstance(event_payload.get("local_env"), dict) else {}),
        )
    intraday_assessment = assess_intraday_trigger(
        site_id=entry["site_id"],
        run_date=run_date,
        current_block=current_block,
        latest_intraday_name=latest_intraday_name,
        latest_intraday_key=latest_intraday_key,
        decision_state=decision_state,
        local_env=(event_payload.get("local_env") if isinstance(event_payload.get("local_env"), dict) else {}),
    )

    decision = resolve_trigger(
        site_id=entry["site_id"],
        event=event_payload,
        latest_intraday_name=latest_intraday_name,
        pending_planned_windows=load_pending_planned_windows(entry["site_id"], run_ts_ist),
        whatsapp_assessment=whatsapp_assessment,
        decision_state=decision_state,
        intraday_assessment=intraday_assessment,
    )

    decision_state.update(
        {
            "last_run_date": run_date,
            "last_run_ts_ist": run_ts_ist.isoformat(),
            "last_current_block": current_block,
            "last_trigger_type": decision.trigger_type,
            "last_schedule_reason": decision.schedule_reason,
        }
    )
    if latest_intraday_name:
        decision_state["last_seen_intraday_name"] = latest_intraday_name
    if latest_intraday_key:
        decision_state["last_seen_intraday_key"] = latest_intraday_key
    if decision.trigger_type == "INTRADAY_REVISION":
        if decision.intraday_detail:
            slot_id = decision.intraday_detail.get("slot_id")
            if slot_id is not None:
                decision_state["last_intraday_slot_id"] = int(slot_id)
        source_event_id = str(decision.source_event_id or "").strip()
        if source_event_id:
            decision_state["last_intraday_trigger_key"] = source_event_id
    if whatsapp_assessment and str(whatsapp_assessment.get("message_id") or "").strip():
        decision_state["last_whatsapp_msg_id"] = str(whatsapp_assessment["message_id"]).strip()
    if decision.trigger_type == "WHATSAPP_METER_FALLBACK":
        decision_state["last_whatsapp_regen_block"] = int(current_block)

    response_body: dict[str, Any] = {
        "ok": bool(fetch_result.ok),
        "site_id": entry["site_id"],
        "run_date": run_date,
        "current_block": current_block,
        "fetch_result": fetch_result.as_response_dict(),
        "trigger_decision": decision.as_dict(),
        "intraday_assessment": intraday_assessment,
        "whatsapp_assessment": whatsapp_assessment,
    }

    if not fetch_result.ok:
        save_decision_state(entry["site_id"], decision_state)
        return {
            "statusCode": 500,
            "body": json.dumps(response_body),
        }

    if decision.trigger_type == NONE:
        save_decision_state(entry["site_id"], decision_state)
        return {
            "statusCode": 200,
            "body": json.dumps(response_body),
        }

    payload = _build_scheduler_payload(
        site_id=entry["site_id"],
        entry=entry,
        event_payload=event_payload,
        decision=decision,
        run_ts_ist=run_ts_ist,
        run_date=run_date,
        current_block=current_block,
        local_scan=local_scan,
        fetch_result=fetch_result,
        selected_intraday_key=latest_intraday_key,
    )
    invoke_result = invoke_scheduler(entry, asdict(payload), local_mode=local_mode)
    response_body["scheduler_invocation"] = invoke_result
    if decision.trigger_type == "INTRADAY_REVISION":
        decision_state["last_dispatched_intraday_name"] = latest_intraday_name
        if latest_intraday_key:
            decision_state["last_dispatched_intraday_key"] = latest_intraday_key
    save_decision_state(entry["site_id"], decision_state)

    if local_mode:
        nested_response = invoke_result.get("response") if isinstance(invoke_result, dict) else None
        nested_status = int((nested_response or {}).get("statusCode", 500) or 500) if isinstance(nested_response, dict) else 500
        if nested_status >= 400:
            response_body["ok"] = False
            return {
                "statusCode": 500,
                "body": json.dumps(response_body),
            }

    return {
        "statusCode": 200,
        "body": json.dumps(response_body),
    }
