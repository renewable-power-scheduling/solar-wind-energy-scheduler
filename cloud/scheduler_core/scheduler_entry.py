from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from cloud.common.idempotency import has_processed, record_processed
from cloud.common.lambda_invoke import is_local_invocation
from cloud.common.payload_models import SchedulerPayload
from cloud.common.site_registry import get_site_entry
from cloud.common.trigger_types import CUSTOM, INTRADAY_REVISION, PLANT_STATUS_CHANGE, WHATSAPP_METER_FALLBACK
from cloud.scheduler_core.engine_adapter import EngineRunRequest, run_engine
from cloud.scheduler_core import runtime as scheduler_runtime

IST = ZoneInfo("Asia/Kolkata")
REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUD_ROOT = REPO_ROOT / "cloud"
ENGINE_SCRIPT = CLOUD_ROOT / "scheduler_core" / "engine_runtime.py"


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


def _timestamp_to_block_ist(run_ts_ist: datetime) -> int:
    mins = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, 1 + (mins // 15)))


def _parse_run_ts_ist(raw_value: Any) -> datetime:
    if raw_value:
        try:
            parsed = datetime.fromisoformat(str(raw_value))
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=IST)
            return parsed.astimezone(IST)
        except Exception:
            pass
    return datetime.now(IST)


def _coerce_payload(payload: dict[str, Any]) -> SchedulerPayload:
    normalized = dict(payload)
    if "site_id" not in normalized or normalized.get("site_id") in (None, ""):
        if normalized.get("site") not in (None, ""):
            normalized["site_id"] = normalized.get("site")
    required = (
        "payload_version",
        "site_id",
        "run_date",
        "run_ts_ist",
        "current_block",
        "trigger_type",
        "schedule_reason",
        "source_event_id",
        "idempotency_key",
    )
    missing = [field for field in required if normalized.get(field) in (None, "")]
    if missing:
        raise ValueError(f"Scheduler payload missing fields: {', '.join(missing)}")
    normalized.pop("site", None)
    return SchedulerPayload(**normalized)


def _schedule_reason_label(payload: SchedulerPayload) -> str | None:
    trigger_type = str(payload.trigger_type or "").strip().upper()
    if trigger_type == INTRADAY_REVISION:
        if payload.intraday_revision is not None:
            return f"intraday schedule r{int(payload.intraday_revision)}"
        return str(payload.schedule_reason or "").strip() or None
    if trigger_type == PLANT_STATUS_CHANGE:
        return "plant_status_change"
    if trigger_type == WHATSAPP_METER_FALLBACK:
        return "whatsapp_out_of_band_adjustment"
    return str(payload.schedule_reason or "").strip() or None


def _payload_env_updates(payload: SchedulerPayload) -> dict[str, str]:
    updates: dict[str, str] = {}
    for key, value in (payload.local_env or {}).items():
        if value is None:
            continue
        updates[str(key)] = str(value)
    updates["DATA_DATE"] = str(payload.run_date)
    if payload.custom_start_block is not None or str(payload.trigger_type).strip().upper() == CUSTOM:
        updates["CUSTOM_START_BLOCK"] = str(int(payload.custom_start_block or payload.current_block))
    if payload.intraday_file_name:
        updates["INTRADAY_FILE_NAME"] = str(payload.intraday_file_name)
    return updates


def _force_local_rerun(payload: dict[str, Any]) -> bool:
    local_env = payload.get("local_env") if isinstance(payload.get("local_env"), dict) else {}
    raw_values = (
        payload.get("force_local_rerun"),
        payload.get("disable_local_idempotency"),
        local_env.get("FORCE_LOCAL_RERUN"),
        local_env.get("DISABLE_LOCAL_IDEMPOTENCY"),
    )
    return any(str(value).strip().lower() in {"1", "true", "yes", "on"} for value in raw_values)


def _dispatch_local_payload(site_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    parsed_payload = _coerce_payload(payload)
    force_rerun = _force_local_rerun(payload)
    if not force_rerun and has_processed(site_id, parsed_payload.idempotency_key):
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "ok": True,
                    "mode": "local_payload",
                    "site": site_id,
                    "duplicate": True,
                    "idempotency_key": parsed_payload.idempotency_key,
                }
            ),
        }

    env = dict(os.environ)
    env["SITE_ID"] = site_id
    env["SITE_NAME"] = site_id
    env["PYTHONPATH"] = str(REPO_ROOT)

    run_ts_ist = _parse_run_ts_ist(parsed_payload.run_ts_ist)
    current_block = int(parsed_payload.current_block or _timestamp_to_block_ist(run_ts_ist))
    env["ENGINE_NOW_IST"] = run_ts_ist.isoformat()
    env["ENGINE_BLOCK_OVERRIDE"] = str(current_block)
    env["INTRADAY_TRIGGER_KEY"] = str(parsed_payload.idempotency_key).strip()
    env["STRICT_PAYLOAD_EXECUTION"] = "1"
    env["SCHEDULER_TRIGGER_TYPE"] = str(parsed_payload.trigger_type or "").strip().upper()

    trigger_type = str(parsed_payload.trigger_type or "").strip().upper()
    schedule_reason = _schedule_reason_label(parsed_payload)
    if trigger_type == INTRADAY_REVISION and schedule_reason:
        env["INTRADAY_TRIGGER_REASON_LABEL"] = schedule_reason
    elif trigger_type == CUSTOM:
        custom_start_block = parsed_payload.custom_start_block or current_block
        env["CUSTOM_START_BLOCK"] = str(int(custom_start_block))
    elif schedule_reason:
        env["INTRADAY_TRIGGER_REASON_LABEL"] = schedule_reason

    intraday_file_name = str(parsed_payload.intraday_file_name or "").strip()
    if intraday_file_name:
        env["INTRADAY_FILE_NAME"] = intraday_file_name

    for key, value in _payload_env_updates(parsed_payload).items():
        env[str(key)] = str(value)

    proc = run_engine(
        EngineRunRequest(
            site_id=site_id,
            forced_block=current_block,
            run_ts_ist_iso=run_ts_ist.isoformat(),
            engine_script=ENGINE_SCRIPT,
            repo_root=REPO_ROOT,
            extra_env=env,
            skip_combined_csv=False,
        )
    )
    result = {
        "ok": proc.returncode == 0,
        "mode": "local_payload",
        "site": site_id,
        "returncode": int(proc.returncode),
        "stdout_tail": str(proc.stdout or "")[-4000:],
        "stderr_tail": str(proc.stderr or "")[-4000:],
        "engine_block_ref": current_block,
        "run_ts_ist": run_ts_ist.isoformat(),
        "idempotency_key": parsed_payload.idempotency_key,
    }
    if result["ok"]:
        record_processed(site_id, parsed_payload.idempotency_key, payload)
    return {
        "statusCode": 200 if result["ok"] else 500,
        "body": json.dumps(result),
    }


def _dispatch_single_site(handler, site_id: str, event_payload: dict[str, Any], context: Any) -> dict[str, Any]:
    if event_payload.get("payload_version"):
        parsed_payload = _coerce_payload(event_payload)
        if is_local_invocation(event_payload):
            return _dispatch_local_payload(site_id, event_payload)

        if has_processed(site_id, parsed_payload.idempotency_key):
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {
                        "ok": True,
                        "mode": "worker_payload",
                        "site": site_id,
                        "duplicate": True,
                        "idempotency_key": parsed_payload.idempotency_key,
                    }
                ),
            }

        run_ts_ist = _parse_run_ts_ist(parsed_payload.run_ts_ist)
        worker_payload = {
            "mode": "worker",
            "site": site_id,
            "run_ts_ist": run_ts_ist.isoformat(),
            "engine_block_ref": int(parsed_payload.current_block or _timestamp_to_block_ist(run_ts_ist)),
            "schedule_reason_label": _schedule_reason_label(parsed_payload),
            "intraday_trigger_key": str(parsed_payload.idempotency_key).strip() or None,
            "trigger_type": str(parsed_payload.trigger_type or "").strip().upper(),
            "strict_payload_execution": True,
            "planned_window_ids": list(((parsed_payload.control_state or {}).get("planned_window_ids")) or []),
            "payload_version": str(parsed_payload.payload_version),
            "scheduler_workspace_manifest": dict(parsed_payload.scheduler_workspace_manifest or {}),
        }
        with temporary_env(**_payload_env_updates(parsed_payload)):
            result = handler._run_worker(worker_payload)
        if result.get("ok"):
            record_processed(site_id, parsed_payload.idempotency_key, event_payload)
        result["mode"] = "worker_payload"
        result["idempotency_key"] = parsed_payload.idempotency_key
        return {
            "statusCode": 200 if result.get("ok") else 500,
            "body": json.dumps(result),
        }

    return {
        "statusCode": 400,
        "body": json.dumps(
            {
                "ok": False,
                "error": "site scheduler requires SchedulerPayload input; legacy scheduler modes are disabled",
                "site": site_id,
            }
        ),
    }


def run(site_id: str, event: dict[str, Any] | None, context: Any) -> dict[str, Any]:
    entry = get_site_entry(site_id)
    event_payload = dict(event or {})
    event_payload.setdefault("site", entry["site_id"])
    handler = scheduler_runtime
    with temporary_env(
        SITE_NAME=entry["site_id"],
        SITE_IDS=entry["site_id"],
        SITE_ID=entry["site_id"],
    ):
        return _dispatch_single_site(handler, entry["site_id"], event_payload, context)
