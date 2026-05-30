import json
import logging
import os
import re
import shutil
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3


BUCKET = os.environ["BUCKET"]
PLANT_ID_BASE = os.environ.get("PLANT_ID", "vedanjay")
SITE_NAME = os.environ.get("SITE_NAME", "GSNP")
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
CONTROL_WINDOWS_TABLE = os.getenv("CONTROL_WINDOWS_TABLE", "").strip()
WORK_ROOT_BASE = Path("/tmp")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IST = ZoneInfo("Asia/Kolkata")
PLANNED_CONTROL_PRESTART_MINUTES = 60

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
ddb = boto3.client("dynamodb")
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# These globals are re-bound per site by _configure_for_site()
WORK_ROOT = WORK_ROOT_BASE / "work"
RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
GEN_BASE_PREFIX = f"generated/{PLANT_ID_BASE}/{SITE_NAME}"


def _resolve_site_ids() -> list[str]:
    if SITE_IDS_ENV:
        out: list[str] = []
        for token in SITE_IDS_ENV.split(","):
            s = token.strip()
            if s and s not in out:
                out.append(s)
        if out:
            return out
    return [SITE_NAME]


def _configure_for_site(site_name: str) -> None:
    global SITE_NAME, WORK_ROOT, RAW_BASE_PREFIX, GEN_BASE_PREFIX
    SITE_NAME = site_name
    WORK_ROOT = WORK_ROOT_BASE / f"work_{site_name.lower()}"
    RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
    GEN_BASE_PREFIX = f"generated/{PLANT_ID_BASE}/{SITE_NAME}"


def _reset_workdir() -> None:
    if WORK_ROOT.exists():
        shutil.rmtree(WORK_ROOT)
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    for d in ("data", "outputs", "logs"):
        (WORK_ROOT / d).mkdir(parents=True, exist_ok=True)


def _prefix_has_any_object(prefix: str) -> bool:
    resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix, MaxKeys=1)
    return "Contents" in resp


def _list_date_prefixes() -> list[str]:
    """
    Return available raw dates under raw/<plant>/<site>/YYYY-MM-DD/
    Supports legacy layout: raw/<plant>/<site>/_shared/<site>/YYYY-MM-DD/
    by scanning actual object keys (more robust than CommonPrefixes).
    """
    prefixes = [
        f"{RAW_BASE_PREFIX}/",
        f"{RAW_BASE_PREFIX}/_shared/{SITE_NAME}/",
    ]

    paginator = s3.get_paginator("list_objects_v2")
    dates = set()

    for prefix in prefixes:
        date_pattern = re.compile(rf"^{re.escape(prefix)}(\d{{4}}-\d{{2}}-\d{{2}})/")
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                m = date_pattern.match(key)
                if m:
                    dates.add(m.group(1))

    return sorted(dates)




def _download_prefix_to_local(prefix: str, local_root: Path) -> int:
    """
    Download all objects under prefix into local_root preserving relative structure.
    """
    count = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            rel = key[len(prefix):].lstrip("/")
            dst = local_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(BUCKET, key, str(dst))
            count += 1
    return count


def _upload_local_tree(local_root: Path, prefix: str) -> int:
    if not local_root.exists():
        return 0
    count = 0
    for f in local_root.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(local_root).as_posix()
        key = f"{prefix}/{rel}" if rel else prefix
        s3.upload_file(str(f), BUCKET, key)
        count += 1
    return count


def _download_raw_inputs(run_ts_ist: datetime | None = None) -> str:
    """
    1) Prefer today's IST raw date if present
    2) else latest available raw date
    3) also download shared raw assets from _shared
    Supports legacy layout: raw/<plant>/<site>/_shared/<site>/YYYY-MM-DD/
    """
    ts_ref = run_ts_ist or datetime.now(IST)
    expected_date = ts_ref.strftime("%Y-%m-%d")
    primary_prefix = f"{RAW_BASE_PREFIX}/{expected_date}/"
    legacy_prefix = f"{RAW_BASE_PREFIX}/_shared/{SITE_NAME}/{expected_date}/"

    if _prefix_has_any_object(primary_prefix):
        selected_date = expected_date
        selected_root = f"{RAW_BASE_PREFIX}"
    elif _prefix_has_any_object(legacy_prefix):
        selected_date = expected_date
        selected_root = f"{RAW_BASE_PREFIX}/_shared/{SITE_NAME}"
    else:
        all_dates = _list_date_prefixes()
        if not all_dates:
            raise RuntimeError(f"No raw date folders found under s3://{BUCKET}/{RAW_BASE_PREFIX}/")
        selected_date = all_dates[-1]
        if _prefix_has_any_object(f"{RAW_BASE_PREFIX}/{selected_date}/"):
            selected_root = f"{RAW_BASE_PREFIX}"
        else:
            selected_root = f"{RAW_BASE_PREFIX}/_shared/{SITE_NAME}"

    raw_date_prefix = f"{selected_root}/{selected_date}/"
    local_date_root = WORK_ROOT / "data" / selected_date
    _download_prefix_to_local(raw_date_prefix, local_date_root)

    # Shared assets (e.g. data/active/...)
    shared_prefix = f"{RAW_BASE_PREFIX}/_shared/"
    if _prefix_has_any_object(shared_prefix):
        _download_prefix_to_local(shared_prefix, WORK_ROOT / "data")

    # Engine uses run_date = datetime.now().date() (system date). If mismatch, alias folder.
    expected_local = WORK_ROOT / "data" / expected_date
    if not expected_local.exists():
        shutil.copytree(local_date_root, expected_local)

    return selected_date



def _download_previous_generated_state() -> int:
    total = 0
    total += _download_prefix_to_local(f"{GEN_BASE_PREFIX}/outputs/", WORK_ROOT / "outputs")
    total += _download_prefix_to_local(f"{GEN_BASE_PREFIX}/logs/", WORK_ROOT / "logs")
    return total


def _candidate_generated_dates(run_ts_ist: datetime, selected_raw_date: str | None = None) -> list[str]:
    dates: list[str] = []

    def _add(date_str: str | None) -> None:
        if date_str and date_str not in dates:
            dates.append(date_str)

    run_date = run_ts_ist.date()
    _add((run_date - timedelta(days=1)).strftime("%Y-%m-%d"))
    _add(run_date.strftime("%Y-%m-%d"))
    _add((run_date + timedelta(days=1)).strftime("%Y-%m-%d"))
    if selected_raw_date:
        _add(selected_raw_date)
        try:
            selected_date = datetime.strptime(selected_raw_date, "%Y-%m-%d").date()
            _add((selected_date + timedelta(days=1)).strftime("%Y-%m-%d"))
        except ValueError:
            pass
    return dates


def _download_required_generated_state(run_ts_ist: datetime, selected_raw_date: str | None = None) -> int:
    total = 0
    for date_str in _candidate_generated_dates(run_ts_ist, selected_raw_date):
        total += _download_prefix_to_local(
            f"{GEN_BASE_PREFIX}/outputs/{date_str}/",
            WORK_ROOT / "outputs" / date_str,
        )
    return total


def _fixed_da_revision_label(block: int) -> str | None:
    return None


def _da_recovery_target(block: int) -> tuple[int, str] | None:
    return None


def _has_da_artifacts_for_run(run_ts_ist: datetime, trigger_block: int) -> bool:
    next_date_str = (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d")
    da_dir = WORK_ROOT / "outputs" / next_date_str / "Day-ahead"
    csv_path = da_dir / f"schedule_from_{trigger_block:02d}.csv"
    meta_path = csv_path.with_suffix(".meta.json")
    return csv_path.exists() and meta_path.exists()


def _has_schedule_artifacts_for_run(run_ts_ist: datetime, trigger_block: int) -> bool:
    date_str = run_ts_ist.date().strftime("%Y-%m-%d")
    out_dir = WORK_ROOT / "outputs" / date_str
    candidates = (
        [
            out_dir / f"schedule_from_{trigger_block}.csv",
            out_dir / f"schedule_from_{trigger_block:02d}.csv",
        ]
        + sorted(out_dir.glob(f"schedule_from_{trigger_block:02d}_*.csv"))
        + sorted(out_dir.glob("schedule_from_*.csv"))
    )
    seen: set[Path] = set()
    for csv_path in candidates:
        if csv_path in seen:
            continue
        seen.add(csv_path)
        meta_path = csv_path.with_suffix(".meta.json")
        if csv_path.exists() and meta_path.exists():
            return True
    return False


def _run_engine_once(
    site_name: str,
    forced_block: int,
    run_ts_ist_iso: str,
    schedule_reason_label: str | None = None,
    da_only: bool = False,
    intraday_trigger_key: str | None = None,
    run_context_id: str | None = None,
) -> subprocess.CompletedProcess:
    engine_script = Path("/var/task") / "run_phase9_engine.py"
    if not engine_script.exists():
        raise FileNotFoundError(f"Missing engine script: {engine_script}")

    env = dict(os.environ)
    env["SKIP_FETCHER"] = os.getenv("SKIP_FETCHER", "1")
    env["PYTHONPATH"] = "/var/task"
    env["SITE_ID"] = site_name
    env["SITE_NAME"] = site_name
    env["ENGINE_BLOCK_OVERRIDE"] = str(forced_block)
    env["ENGINE_NOW_IST"] = run_ts_ist_iso
    if run_context_id:
        env["RUN_CONTEXT_ID"] = str(run_context_id)
    if da_only and schedule_reason_label:
        env["RUN_DA_ONLY"] = "1"
        env["DA_SCHEDULE_REASON_LABEL"] = schedule_reason_label
    else:
        env.pop("RUN_DA_ONLY", None)
        env.pop("DA_SCHEDULE_REASON_LABEL", None)

    if schedule_reason_label and not da_only:
        env["INTRADAY_TRIGGER_ENABLED"] = "1"
        env["INTRADAY_TRIGGER_REASON_LABEL"] = schedule_reason_label
    if intraday_trigger_key:
        env["INTRADAY_TRIGGER_KEY"] = intraday_trigger_key

    # Provide fetch manifest (if present) so engine.log can print a raw-input hierarchy.
    expected_date = str(run_ts_ist_iso).split("T", 1)[0]
    manifest_path = WORK_ROOT / "data" / expected_date / "fetch_manifest.json"
    if manifest_path.exists():
        env["RAW_INPUTS_MANIFEST"] = str(manifest_path)

    # Override per-site working roots so engine reads the downloaded data
    env["DATA_ROOT"] = str(WORK_ROOT / "data")
    env["OUTPUT_ROOT"] = str(WORK_ROOT / "outputs")
    env["LOG_ROOT"] = str(WORK_ROOT / "logs")
    env["SKIP_COMBINED_CSV"] = "1"

    return subprocess.run(
        [sys.executable, str(engine_script)],
        cwd=str(WORK_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )


def _run_da_refresh_once(
    site_name: str,
    forced_block: int,
    run_ts_ist_iso: str,
    schedule_reason_label: str | None = None,
    run_context_id: str | None = None,
) -> subprocess.CompletedProcess:
    return _run_engine_once(
        site_name=site_name,
        forced_block=forced_block,
        run_ts_ist_iso=run_ts_ist_iso,
        schedule_reason_label=schedule_reason_label,
        da_only=True,
        run_context_id=run_context_id,
    )


def _upload_generated_outputs() -> int:
    total = 0
    total += _upload_local_tree(WORK_ROOT / "outputs", f"{GEN_BASE_PREFIX}/outputs")
    total += _upload_local_tree(WORK_ROOT / "logs", f"{GEN_BASE_PREFIX}/logs")
    return total


def _upload_logs_only() -> int:
    return _upload_local_tree(WORK_ROOT / "logs", f"{GEN_BASE_PREFIX}/logs")

def _timestamp_to_block_ist(run_ts_ist: datetime) -> int:
    mins = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, 1 + (mins // 15)))


def _parse_ddb_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=IST)
        return parsed.astimezone(IST)
    except Exception:
        return None


def _planned_window_due_for_schedule(
    start_dt: datetime,
    end_dt: datetime | None,
    run_ts_ist: datetime,
) -> bool:
    if end_dt is not None and run_ts_ist >= end_dt:
        return False

    if start_dt.date() > run_ts_ist.date():
        return False

    due_at = start_dt - timedelta(minutes=PLANNED_CONTROL_PRESTART_MINUTES)
    return run_ts_ist >= due_at


def _load_pending_planned_windows(site_name: str, run_ts_ist: datetime) -> list[dict]:
    if not CONTROL_WINDOWS_TABLE:
        return []

    site_token = str(site_name or "").strip().upper()
    if not site_token:
        return []

    try:
        resp = ddb.query(
            TableName=CONTROL_WINDOWS_TABLE,
            KeyConditionExpression="#pk = :pk",
            ExpressionAttributeNames={"#pk": "plant_id"},
            ExpressionAttributeValues={":pk": {"S": PLANT_ID_BASE}},
            ConsistentRead=True,
        )
    except Exception:
        logger.exception("Failed to query planned control windows | site=%s", site_token)
        return []

    pending: list[dict] = []
    for item in resp.get("Items", []) or []:
        item_site = str((item.get("site") or {}).get("S") or "").strip().upper()
        if item_site not in {site_token, "ALL"}:
            continue

        plant_status = str((item.get("plant_status") or {}).get("S") or "").strip().upper()
        if plant_status not in {"SHUTDOWN", "CURTAILMENT"}:
            continue

        is_active = True if "active" not in item else bool((item.get("active") or {}).get("BOOL"))
        if not is_active:
            continue

        start_dt = _parse_ddb_datetime((item.get("start_time") or {}).get("S"))
        if start_dt is None:
            continue

        end_raw = (item.get("end_time") or {}).get("S")
        end_dt = _parse_ddb_datetime(end_raw)
        if not _planned_window_due_for_schedule(start_dt, end_dt, run_ts_ist):
            continue

        window_id = str((item.get("window_id") or {}).get("S") or "").strip()
        if not window_id:
            continue

        if str((item.get("schedule_triggered_at") or {}).get("S") or "").strip():
            continue

        pending.append(
            {
                "window_id": window_id,
                "site": item_site,
                "plant_status": plant_status,
                "start_time": start_dt,
                "end_time": end_dt,
                "is_open_ended": bool((item.get("is_open_ended") or {}).get("BOOL")) if item.get("is_open_ended") is not None else (end_dt is None),
            }
        )

    return pending


def _mark_planned_windows_triggered(window_ids: list[str], run_ts_ist_iso: str, engine_block_ref: int) -> None:
    if not CONTROL_WINDOWS_TABLE or not window_ids:
        return

    updated_at = datetime.now(IST).isoformat()
    for window_id in window_ids:
        try:
            ddb.update_item(
                TableName=CONTROL_WINDOWS_TABLE,
                Key={
                    "plant_id": {"S": PLANT_ID_BASE},
                    "window_id": {"S": window_id},
                },
                UpdateExpression=(
                    "SET schedule_triggered_at = :schedule_triggered_at, "
                    "last_applied_run_ts = :last_applied_run_ts, "
                    "last_applied_reference_block = :last_applied_reference_block, "
                    "updated_at = :updated_at"
                ),
                ExpressionAttributeValues={
                    ":schedule_triggered_at": {"S": updated_at},
                    ":last_applied_run_ts": {"S": run_ts_ist_iso},
                    ":last_applied_reference_block": {"N": str(int(engine_block_ref))},
                    ":updated_at": {"S": updated_at},
                },
            )
        except Exception:
            logger.exception("Failed to mark planned window triggered | window_id=%s", window_id)


def _normalize_intraday_reason_label(label: str | None) -> str | None:
    raw = str(label or "").strip().lower()
    if not raw:
        return None
    if raw in {"plant_status_change", "planned_control_clear"}:
        return raw
    m = re.search(r"\br(?P<rev>\d+)\b", raw)
    if not m:
        return None
    try:
        return f"intraday schedule r{int(m.group('rev'))}"
    except Exception:
        return None

def _cleanup_obsolete_da_graph_keys(next_date_str: str) -> None:
    """
    Older deployments uploaded `schedule_XX.html` under Day-ahead graphs.
    The engine now normalizes to `schedule_from_XX.html`.
    If we generated a `schedule_from_XX.html`, delete the obsolete `schedule_XX.html`
    key in S3 so the Day-ahead folder does not show duplicates.
    """
    da_graph_dir = WORK_ROOT / "outputs" / next_date_str / "Day-ahead" / "graphs"
    if not da_graph_dir.exists():
        return

    for schedule_from in da_graph_dir.glob("schedule_from_*.html"):
        name = schedule_from.name  # schedule_from_23.html
        suffix = name.removeprefix("schedule_from_")  # 23.html
        if suffix == name:
            continue
        obsolete_key = f"{GEN_BASE_PREFIX}/outputs/{next_date_str}/Day-ahead/graphs/schedule_{suffix}"
        try:
            s3.delete_object(Bucket=BUCKET, Key=obsolete_key)
        except Exception:
            # Non-fatal cleanup only.
            pass


def _invoke_worker_request_response(function_name: str, payload: dict) -> dict:
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    payload_bytes = response.get("Payload")
    body_text = ""
    if payload_bytes is not None:
        try:
            body_text = payload_bytes.read().decode("utf-8")
        except Exception:
            body_text = ""
    parsed: dict = {}
    if body_text:
        try:
            parsed = json.loads(body_text)
        except Exception:
            parsed = {"raw_body": body_text}
    parsed["_lambda_status_code"] = int(response.get("StatusCode", 0) or 0)
    return parsed


def _dispatch_request_response_workers(function_name: str, base_payloads: list[dict]) -> list[dict]:
    def _run_site(payload: dict) -> dict:
        site_name = str(payload["site"]).strip().upper()
        attempts: list[dict] = []
        last_result: dict | None = None
        for attempt in range(2):
            result = _invoke_worker_request_response(function_name, payload)
            last_result = result
            ok = bool(result.get("ok")) and int(result.get("_lambda_status_code", 500)) < 300
            attempts.append(
                {
                    "attempt": attempt + 1,
                    "ok": ok,
                    "status_code": int(result.get("_lambda_status_code", 0) or 0),
                    "returncode": result.get("returncode"),
                    "planned_control_forced": bool(result.get("planned_control_forced")),
                    "planned_window_ids_applied": result.get("planned_window_ids_applied") or [],
                }
            )
            if ok:
                break
        return {
            "site": site_name,
            "ok": bool(last_result and last_result.get("ok") and int(last_result.get("_lambda_status_code", 500)) < 300),
            "attempts": attempts,
            "result": last_result,
        }

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(len(base_payloads), 5)) as executor:
        futures = {executor.submit(_run_site, payload): payload["site"] for payload in base_payloads}
        for future in as_completed(futures):
            results.append(future.result())
    return results


def _run_worker(event: dict) -> dict:
    site = str(event.get("site") or SITE_NAME).strip().upper()
    run_context_id = str(event.get("run_context_id") or "").strip() or str(uuid.uuid4())
    run_ts_ist_iso = str(event.get("run_ts_ist") or datetime.now(IST).isoformat())
    try:
        run_ts_ist = datetime.fromisoformat(run_ts_ist_iso)
        if run_ts_ist.tzinfo is None:
            run_ts_ist = run_ts_ist.replace(tzinfo=IST)
        else:
            run_ts_ist = run_ts_ist.astimezone(IST)
    except Exception:
        run_ts_ist = datetime.now(IST)
        run_ts_ist_iso = run_ts_ist.isoformat()

    forced_block = int(event.get("engine_block_ref") or _timestamp_to_block_ist(run_ts_ist))
    fixed_da_reason = _fixed_da_revision_label(forced_block)
    recovery_target = _da_recovery_target(forced_block)
    intraday_reason = _normalize_intraday_reason_label(event.get("schedule_reason_label"))
    intraday_trigger_key = str(event.get("intraday_trigger_key") or "").strip() or None

    pending_planned_windows: list[dict] = []
    planned_control_forced = False
    if fixed_da_reason is None:
        pending_planned_windows = _load_pending_planned_windows(site, run_ts_ist)
        if pending_planned_windows and not intraday_reason:
            planned_control_forced = True
            pending_ids = ",".join(sorted(item["window_id"] for item in pending_planned_windows))
            intraday_reason = "planned control"
            intraday_trigger_key = intraday_trigger_key or f"planned_control|{pending_ids}|{forced_block}"
    logger.info(
        "Worker event received | run_id=%s | site=%s | engine_block_ref=%s | run_ts_ist=%s | intraday_reason=%s | planned_control_forced=%s | pending_windows=%s",
        run_context_id,
        site,
        forced_block,
        run_ts_ist_iso,
        intraday_reason,
        planned_control_forced,
        [item["window_id"] for item in pending_planned_windows],
    )

    _configure_for_site(site)
    _reset_workdir()
    selected_raw_date = _download_raw_inputs(run_ts_ist=run_ts_ist)
    downloaded_prev = _download_required_generated_state(run_ts_ist, selected_raw_date)

    if fixed_da_reason:
        proc = _run_da_refresh_once(
            site,
            forced_block=forced_block,
            run_ts_ist_iso=run_ts_ist_iso,
            schedule_reason_label=fixed_da_reason,
            run_context_id=run_context_id,
        )
    else:
        proc = _run_engine_once(
            site,
            forced_block=forced_block,
            run_ts_ist_iso=run_ts_ist_iso,
            schedule_reason_label=intraday_reason,
            da_only=False,
            intraday_trigger_key=intraday_trigger_key,
            run_context_id=run_context_id,
        )

    recovery_attempted = False
    recovery_returncode = None
    if recovery_target is not None:
        trigger_block, recovery_label = recovery_target
        if not _has_da_artifacts_for_run(run_ts_ist, trigger_block):
            recovery_attempted = True
            logger.warning(
                "DA artifact missing; running recovery | site=%s | engine_block_ref=%s | trigger_block=%s | schedule_for_date=%s",
                site,
                forced_block,
                trigger_block,
                (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d"),
            )
            recovery_proc = _run_da_refresh_once(
                site_name=site,
                forced_block=trigger_block,
                run_ts_ist_iso=run_ts_ist_iso,
                schedule_reason_label=recovery_label,
                run_context_id=run_context_id,
            )
            recovery_returncode = int(recovery_proc.returncode)
            if recovery_proc.returncode != 0:
                proc = recovery_proc
            elif not _has_da_artifacts_for_run(run_ts_ist, trigger_block):
                # Keep a failing status even when subprocess exits 0 but artifacts are absent.
                recovery_returncode = 91
        else:
            logger.info(
                "DA artifact check passed | site=%s | engine_block_ref=%s | trigger_block=%s",
                site,
                forced_block,
                trigger_block,
            )

    da_check_ok = True
    if recovery_target is not None:
        da_check_ok = _has_da_artifacts_for_run(run_ts_ist, recovery_target[0])
    schedule_artifacts_created = _has_schedule_artifacts_for_run(run_ts_ist, forced_block)
    overall_ok = (proc.returncode == 0) and da_check_ok and (
        recovery_returncode in (None, 0)
    )

    applied_planned_window_ids: list[str] = []
    if overall_ok and schedule_artifacts_created and pending_planned_windows:
        applied_planned_window_ids = [item["window_id"] for item in pending_planned_windows]
        _mark_planned_windows_triggered(applied_planned_window_ids, run_ts_ist_iso, forced_block)

    uploaded = 0
    uploaded_logs = _upload_logs_only()
    uploaded += uploaded_logs
    if overall_ok:
        uploaded_non_logs = 0
        uploaded_non_logs += _upload_local_tree(WORK_ROOT / "outputs", f"{GEN_BASE_PREFIX}/outputs")
        uploaded += uploaded_non_logs

        # If DA exists (from previous/other runs), remove obsolete duplicate graph key(s) from S3.
        next_date_str = (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d")
        _cleanup_obsolete_da_graph_keys(next_date_str)

    return {
        "run_context_id": run_context_id,
        "site": site,
        "ok": overall_ok,
        "returncode": proc.returncode,
        "da_check_ok": da_check_ok,
        "da_recovery_attempted": recovery_attempted,
        "da_recovery_returncode": recovery_returncode,
        "selected_raw_date": selected_raw_date,
        "engine_block_ref": forced_block,
        "run_ts_ist": run_ts_ist_iso,
        "intraday_trigger": bool(intraday_reason),
        "intraday_reason_label": intraday_reason,
        "intraday_trigger_key": intraday_trigger_key,
        "planned_control_forced": planned_control_forced,
        "planned_window_ids_applied": applied_planned_window_ids,
        "schedule_artifacts_created": schedule_artifacts_created,
        "downloaded_previous_files": downloaded_prev,
        "uploaded_generated_files": uploaded,
        "uploaded_log_files": uploaded_logs,
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
    }


def _dispatch_workers(context, event: dict | None) -> dict:
    sites = _resolve_site_ids()
    run_ts_ist = datetime.now(IST)
    engine_block_ref = _timestamp_to_block_ist(run_ts_ist)

    # Optional manual override for backfills/testing (EventBridge won't send these).
    if isinstance(event, dict):
        raw_ts = str(event.get("run_ts_ist") or "").strip()
        if raw_ts:
            try:
                parsed = datetime.fromisoformat(raw_ts)
                run_ts_ist = parsed.replace(tzinfo=IST) if parsed.tzinfo is None else parsed.astimezone(IST)
            except Exception:
                run_ts_ist = datetime.now(IST)
        raw_block = event.get("engine_block_ref")
        if raw_block is not None:
            try:
                engine_block_ref = int(raw_block)
            except Exception:
                engine_block_ref = _timestamp_to_block_ist(run_ts_ist)

    run_ts_ist_iso = run_ts_ist.isoformat()
    function_name = context.invoked_function_arn if context is not None else os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
    fixed_da_reason = _fixed_da_revision_label(engine_block_ref)
    logger.info(
        "Dispatcher event received | run_ts_ist=%s | engine_block_ref=%s | fixed_da_reason=%s | sites=%s",
        run_ts_ist_iso,
        engine_block_ref,
        fixed_da_reason,
        sites,
    )

    base_payloads = [
        {
            "mode": "worker",
            "site": site,
            "run_ts_ist": run_ts_ist_iso,
            "engine_block_ref": engine_block_ref,
        }
        for site in sites
    ]

    if fixed_da_reason:
        results = _dispatch_request_response_workers(function_name, base_payloads)
        failed_sites = [r["site"] for r in results if not r.get("ok")]
        return {
            "ok": not failed_sites,
            "mode": "dispatcher_fixed_da",
            "dispatched_count": len(base_payloads),
            "run_ts_ist": run_ts_ist_iso,
            "engine_block_ref": engine_block_ref,
            "schedule_reason_label": fixed_da_reason,
            "results": results,
            "failed_sites": failed_sites,
        }

    results = _dispatch_request_response_workers(function_name, base_payloads)
    failed_sites = [r["site"] for r in results if not r.get("ok")]
    return {
        "ok": not failed_sites,
        "mode": "dispatcher",
        "dispatched_count": len(base_payloads),
        "run_ts_ist": run_ts_ist_iso,
        "engine_block_ref": engine_block_ref,
        "results": results,
        "failed_sites": failed_sites,
    }


def _run_da_refresh(event: dict) -> dict:
    site = str(event.get("site") or SITE_NAME).strip().upper()
    run_context_id = str(event.get("run_context_id") or "").strip() or str(uuid.uuid4())
    run_ts_ist_iso = str(event.get("run_ts_ist") or datetime.now(IST).isoformat())
    try:
        run_ts_ist = datetime.fromisoformat(run_ts_ist_iso)
        if run_ts_ist.tzinfo is None:
            run_ts_ist = run_ts_ist.replace(tzinfo=IST)
        else:
            run_ts_ist = run_ts_ist.astimezone(IST)
    except Exception:
        run_ts_ist = datetime.now(IST)
        run_ts_ist_iso = run_ts_ist.isoformat()

    forced_block = int(event.get("engine_block_ref") or _timestamp_to_block_ist(run_ts_ist))
    fixed_da_reason = str(event.get("schedule_reason_label") or "").strip() or None
    logger.info(
        "DA refresh event received | run_id=%s | site=%s | engine_block_ref=%s | run_ts_ist=%s | raw_da_keys=%s",
        run_context_id,
        site,
        forced_block,
        run_ts_ist_iso,
        event.get("raw_da_keys"),
    )

    _configure_for_site(site)
    _reset_workdir()
    selected_raw_date = _download_raw_inputs(run_ts_ist=run_ts_ist)
    downloaded_prev = _download_required_generated_state(run_ts_ist, selected_raw_date)

    proc = _run_da_refresh_once(
        site,
        forced_block=forced_block,
        run_ts_ist_iso=run_ts_ist_iso,
        schedule_reason_label=fixed_da_reason,
        run_context_id=run_context_id,
    )
    da_check_ok = _has_da_artifacts_for_run(run_ts_ist, forced_block)
    overall_ok = (proc.returncode == 0) and da_check_ok

    uploaded = 0
    uploaded_logs = _upload_logs_only()
    uploaded += uploaded_logs
    if overall_ok:
        uploaded_outputs = _upload_local_tree(WORK_ROOT / "outputs", f"{GEN_BASE_PREFIX}/outputs")
        uploaded += uploaded_outputs
        # Remove any old `schedule_XX.html` keys for the Day-ahead graph(s) we just generated.
        next_date_str = (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d")
        _cleanup_obsolete_da_graph_keys(next_date_str)

    return {
        "run_context_id": run_context_id,
        "site": site,
        "ok": overall_ok,
        "mode": "da_refresh",
        "returncode": proc.returncode,
        "da_check_ok": da_check_ok,
        "selected_raw_date": selected_raw_date,
        "engine_block_ref": forced_block,
        "run_ts_ist": run_ts_ist_iso,
        "downloaded_previous_files": downloaded_prev,
        "uploaded_generated_files": uploaded,
        "uploaded_log_files": uploaded_logs,
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
    }


def _run_intraday_refresh(event: dict) -> dict:
    site = str(event.get("site") or SITE_NAME).strip().upper()
    run_context_id = str(event.get("run_context_id") or "").strip() or str(uuid.uuid4())
    run_ts_ist_iso = str(event.get("run_ts_ist") or datetime.now(IST).isoformat())
    try:
        run_ts_ist = datetime.fromisoformat(run_ts_ist_iso)
        if run_ts_ist.tzinfo is None:
            run_ts_ist = run_ts_ist.replace(tzinfo=IST)
        else:
            run_ts_ist = run_ts_ist.astimezone(IST)
    except Exception:
        run_ts_ist = datetime.now(IST)
        run_ts_ist_iso = run_ts_ist.isoformat()

    forced_block = int(event.get("engine_block_ref") or _timestamp_to_block_ist(run_ts_ist))
    intraday_reason = _normalize_intraday_reason_label(event.get("schedule_reason_label"))
    intraday_trigger_key = str(event.get("intraday_trigger_key") or "").strip() or None
    logger.info(
        "Intraday refresh event received | run_id=%s | site=%s | engine_block_ref=%s | run_ts_ist=%s | reason=%s | raw_intraday_keys=%s",
        run_context_id,
        site,
        forced_block,
        run_ts_ist_iso,
        intraday_reason,
        event.get("raw_intraday_keys"),
    )

    _configure_for_site(site)
    _reset_workdir()
    selected_raw_date = _download_raw_inputs(run_ts_ist=run_ts_ist)
    downloaded_prev = _download_required_generated_state(run_ts_ist, selected_raw_date)
    proc = _run_engine_once(
        site,
        forced_block=forced_block,
        run_ts_ist_iso=run_ts_ist_iso,
        schedule_reason_label=intraday_reason,
        da_only=False,
        intraday_trigger_key=intraday_trigger_key,
        run_context_id=run_context_id,
    )

    overall_ok = proc.returncode == 0
    uploaded = 0
    uploaded_logs = _upload_logs_only()
    uploaded += uploaded_logs
    if overall_ok:
        uploaded_outputs = _upload_local_tree(WORK_ROOT / "outputs", f"{GEN_BASE_PREFIX}/outputs")
        uploaded += uploaded_outputs

    return {
        "run_context_id": run_context_id,
        "site": site,
        "ok": overall_ok,
        "mode": "intraday_refresh",
        "returncode": proc.returncode,
        "selected_raw_date": selected_raw_date,
        "engine_block_ref": forced_block,
        "run_ts_ist": run_ts_ist_iso,
        "intraday_reason_label": intraday_reason,
        "intraday_trigger_key": intraday_trigger_key,
        "downloaded_previous_files": downloaded_prev,
        "uploaded_generated_files": uploaded,
        "uploaded_log_files": uploaded_logs,
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
    }


def lambda_handler(event, context):
    try:
        if isinstance(event, dict) and str(event.get("mode", "")).lower() == "worker":
            worker_result = _run_worker(event)
            return {
                "statusCode": 200 if worker_result.get("ok") else 500,
                "body": json.dumps(worker_result),
            }

        if isinstance(event, dict) and str(event.get("mode", "")).lower() == "da_refresh":
            da_result = _run_da_refresh(event)
            return {
                "statusCode": 200 if da_result.get("ok") else 500,
                "body": json.dumps(da_result),
            }

        if isinstance(event, dict) and str(event.get("mode", "")).lower() == "intraday_refresh":
            intraday_result = _run_intraday_refresh(event)
            return {
                "statusCode": 200 if intraday_result.get("ok") else 500,
                "body": json.dumps(intraday_result),
            }

        dispatch_result = _dispatch_workers(context, event if isinstance(event, dict) else None)
        return {
            "statusCode": 200,
            "body": json.dumps(dispatch_result),
        }
    except Exception as exc:
        return {
            "statusCode": 500,
            "body": json.dumps({"ok": False, "error": str(exc)}),
        }
