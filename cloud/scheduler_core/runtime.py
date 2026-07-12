import json
import csv
import logging
import os
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from cloud.scheduler_core.engine_adapter import EngineRunRequest, run_engine
from cloud.scheduler_core import upload_writer

try:
    import boto3
except ImportError:
    boto3 = None


BUCKET = os.environ.get("BUCKET", "")
PLANT_ID_BASE = os.environ.get("PLANT_ID", "vedanjay")
SITE_NAME = os.environ.get("SITE_NAME", "GSNP")
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
CONTROL_WINDOWS_TABLE = os.getenv("CONTROL_WINDOWS_TABLE", "").strip()
CONTROL_STATE_TABLE = os.getenv("CONTROL_STATE_TABLE", os.getenv("DDB_TABLE", "")).strip()
WORK_ROOT_BASE = Path("/tmp")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IST = ZoneInfo("Asia/Kolkata")
PLANNED_CONTROL_PRESTART_MINUTES = 60
INTRADAY_REFRESH_DEDUPE_SECONDS = int(os.getenv("INTRADAY_REFRESH_DEDUPE_SECONDS", "1800"))

s3 = boto3.client("s3") if boto3 else None
ddb = boto3.client("dynamodb") if boto3 else None
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# These globals are re-bound per site by _configure_for_site()
WORK_ROOT = WORK_ROOT_BASE / "work"
RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
GEN_BASE_PREFIX = f"generated/{PLANT_ID_BASE}/{SITE_NAME}"


def _current_function_name() -> str:
    return str(os.environ.get("AWS_LAMBDA_FUNCTION_NAME") or "").strip()


def _is_da_scheduler_function() -> bool:
    return "da-scheduler" in _current_function_name().lower()


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


def _upload_recent_files(local_root: Path, s3_prefix: str, since_ts: float) -> int:
    return upload_writer.upload_recent_files(
        s3_client=s3,
        bucket=BUCKET,
        local_root=local_root,
        s3_prefix=s3_prefix,
        since_ts=since_ts,
    )


def _upload_outputs_for_run(
    run_ts_ist: datetime,
    trigger_block: int,
    include_next_day_da: bool = False,
    since_ts: float | None = None,
) -> int:
    return upload_writer.upload_outputs_for_run(
        s3_client=s3,
        bucket=BUCKET,
        work_root=WORK_ROOT,
        generated_base_prefix=GEN_BASE_PREFIX,
        run_ts_ist=run_ts_ist,
        include_next_day_da=include_next_day_da,
        since_ts=since_ts,
    )


def _upload_logs_for_run(since_ts: float) -> int:
    return upload_writer.upload_logs_for_run(
        s3_client=s3,
        bucket=BUCKET,
        work_root=WORK_ROOT,
        generated_base_prefix=GEN_BASE_PREFIX,
        since_ts=since_ts,
    )


def _log_scheduler_process_output(label: str, proc: subprocess.CompletedProcess) -> None:
    logger.info("%s | returncode=%s", label, proc.returncode)
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    if stdout:
        logger.info("%s stdout:\n%s", label, stdout[-4000:])
    if stderr:
        logger.info("%s stderr:\n%s", label, stderr[-4000:])


def _filter_metered_file_to_block(path: Path, max_block: int | None) -> None:
    if max_block is None or max_block <= 0 or not path.exists():
        return

    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or [])
        if not fieldnames:
            return

        block_col = None
        normalized = {name.strip().lower(): name for name in fieldnames}
        for candidate in ("block_no", "block"):
            if candidate in normalized:
                block_col = normalized[candidate]
                break
        if block_col is None:
            return

        kept_rows = []
        dropped_rows = 0
        for row in reader:
            raw_block = str(row.get(block_col) or "").strip()
            try:
                block_no = int(float(raw_block))
            except ValueError:
                kept_rows.append(row)
                continue
            if block_no <= max_block:
                kept_rows.append(row)
            else:
                dropped_rows += 1

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(kept_rows)

    if dropped_rows:
        logger.info(
            "Applied metered run snapshot cutoff | path=%s | max_block=%s | kept_rows=%s | dropped_rows=%s",
            path,
            max_block,
            len(kept_rows),
            dropped_rows,
        )


def _materialize_workspace_manifest(manifest: dict | None) -> int:
    items = list((manifest or {}).get("items") or [])
    staged = 0
    for item in items:
        local_relpath = str(item.get("local_relpath") or "").strip()
        if not local_relpath:
            continue
        dst = WORK_ROOT / Path(local_relpath)
        dst.parent.mkdir(parents=True, exist_ok=True)
        source_type = str(item.get("source_type") or "").strip().lower()
        if source_type == "local":
            src = Path(str(item.get("path") or ""))
            if not src.exists():
                continue
            shutil.copy2(src, dst)
            staged += 1
        elif source_type == "s3":
            bucket = str(item.get("bucket") or BUCKET).strip()
            key = str(item.get("key") or "").strip()
            if not bucket or not key or s3 is None:
                continue
            s3.download_file(bucket, key, str(dst))
            staged += 1
        if str(item.get("kind") or "").strip().lower() == "metered":
            raw_max_block = item.get("metered_max_block")
            try:
                max_block = int(raw_max_block) if raw_max_block is not None else None
            except (TypeError, ValueError):
                max_block = None
            _filter_metered_file_to_block(dst, max_block)
    return staged


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
    raise NotImplementedError("Use _download_required_generated_state() with a date context")


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
    """
    Download only the output dates the engine can actually reuse.
    This avoids pulling the full historical outputs/logs tree into /tmp.
    """
    total = 0
    for date_str in _candidate_generated_dates(run_ts_ist, selected_raw_date):
        total += _download_prefix_to_local(
            f"{GEN_BASE_PREFIX}/outputs/{date_str}/",
            WORK_ROOT / "outputs" / date_str,
        )
    return total


def _fixed_da_revision_label(block: int) -> str | None:
    if _is_da_scheduler_function():
        return f"day ahead schedule block {int(block)}"
    return None


def _da_recovery_target(block: int) -> tuple[int, str] | None:
    return None


def _has_da_artifacts_for_run(run_ts_ist: datetime, trigger_block: int) -> bool:
    next_date_str = (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d")
    da_dir = WORK_ROOT / "outputs" / next_date_str / "Day-ahead"
    csv_path = da_dir / f"schedule_from_{trigger_block:02d}.csv"
    meta_path = csv_path.with_suffix(".meta.json")
    return csv_path.exists() and meta_path.exists()


def _schedule_artifact_candidates(out_dir: Path, trigger_block: int) -> list[Path]:
    block = int(trigger_block)
    patterns = [
        f"schedule_from_{block}.csv",
        f"schedule_from_{block:02d}.csv",
        f"schedule_from_{block}_*.csv",
        f"schedule_from_{block:02d}_*.csv",
    ]
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(path for path in out_dir.glob(pattern) if path.is_file())
    return sorted(set(candidates), key=lambda p: p.stat().st_mtime, reverse=True)


def _has_schedule_artifacts_for_run(run_ts_ist: datetime, trigger_block: int, since_ts: float | None = None) -> bool:
    date_str = run_ts_ist.date().strftime("%Y-%m-%d")
    out_dir = WORK_ROOT / "outputs" / date_str
    since = float(since_ts or 0.0)
    for csv_path in _schedule_artifact_candidates(out_dir, trigger_block):
        if csv_path.stat().st_mtime < since:
            continue
        meta_path = csv_path.with_suffix(".meta.json")
        if meta_path.exists() and meta_path.stat().st_mtime >= since:
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
    trigger_type: str | None = None,
    strict_payload_execution: bool = False,
) -> subprocess.CompletedProcess:
    engine_script = Path(__file__).with_name("engine_runtime.py")
    expected_date = str(run_ts_ist_iso).split("T", 1)[0]
    manifest_path = WORK_ROOT / "data" / expected_date / "fetch_manifest.json"
    return run_engine(
        EngineRunRequest(
            site_id=site_name,
            forced_block=forced_block,
            run_ts_ist_iso=run_ts_ist_iso,
            engine_script=engine_script,
            repo_root=Path(__file__).resolve().parents[2],
            work_root=WORK_ROOT,
            schedule_reason_label=schedule_reason_label,
            da_only=da_only,
            intraday_trigger_key=intraday_trigger_key,
            run_context_id=run_context_id,
            trigger_type=trigger_type,
            strict_payload_execution=strict_payload_execution,
            data_root=WORK_ROOT / "data",
            output_root=WORK_ROOT / "outputs",
            log_root=WORK_ROOT / "logs",
            raw_inputs_manifest=manifest_path,
        )
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


def _control_state_key(site_name: str) -> dict[str, dict[str, str]] | None:
    if not CONTROL_STATE_TABLE:
        return None
    try:
        desc = ddb.describe_table(TableName=CONTROL_STATE_TABLE)
    except Exception:
        logger.exception("Failed to describe control-state table")
        return None

    key_schema = desc.get("Table", {}).get("KeySchema", []) or []
    key_names = {str(k.get("AttributeName")) for k in key_schema if k.get("AttributeName")}
    if "plant_id" not in key_names:
        return None

    key: dict[str, dict[str, str]] = {"plant_id": {"S": PLANT_ID_BASE}}
    if "site" in key_names:
        key["site"] = {"S": str(site_name or "").strip().upper() or "ALL"}
    return key


def _try_claim_intraday_refresh(site_name: str, intraday_trigger_key: str | None, run_ts_ist: datetime) -> tuple[bool, str | None]:
    key = str(intraday_trigger_key or "").strip()
    if not key or not CONTROL_STATE_TABLE:
        return True, None

    item_key = _control_state_key(site_name)
    if item_key is None:
        return True, None

    now_epoch = int(run_ts_ist.timestamp())
    stale_before = now_epoch - INTRADAY_REFRESH_DEDUPE_SECONDS
    try:
        ddb.update_item(
            TableName=CONTROL_STATE_TABLE,
            Key=item_key,
            UpdateExpression=(
                "SET intraday_refresh_inflight_key = :new_key, "
                "intraday_refresh_inflight_started_at = :now_ts"
            ),
            ConditionExpression=(
                "attribute_not_exists(intraday_refresh_inflight_key) "
                "OR intraday_refresh_inflight_key <> :new_key "
                "OR attribute_not_exists(intraday_refresh_inflight_started_at) "
                "OR intraday_refresh_inflight_started_at < :stale_before"
            ),
            ExpressionAttributeValues={
                ":new_key": {"S": key},
                ":now_ts": {"N": str(now_epoch)},
                ":stale_before": {"N": str(stale_before)},
            },
        )
        return True, None
    except ddb.exceptions.ConditionalCheckFailedException:
        return False, key
    except Exception:
        logger.exception("Failed to claim intraday refresh guard | site=%s | key=%s", site_name, key)
        return True, None


def _release_intraday_refresh_claim(site_name: str, intraday_trigger_key: str | None) -> None:
    key = str(intraday_trigger_key or "").strip()
    if not key or not CONTROL_STATE_TABLE:
        return

    item_key = _control_state_key(site_name)
    if item_key is None:
        return

    try:
        ddb.update_item(
            TableName=CONTROL_STATE_TABLE,
            Key=item_key,
            UpdateExpression=(
                "REMOVE intraday_refresh_inflight_key, intraday_refresh_inflight_started_at"
            ),
            ConditionExpression="intraday_refresh_inflight_key = :expected_key",
            ExpressionAttributeValues={
                ":expected_key": {"S": key},
            },
        )
    except ddb.exceptions.ConditionalCheckFailedException:
        pass
    except Exception:
        logger.exception("Failed to release intraday refresh guard | site=%s | key=%s", site_name, key)

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


def _dispatch_local_workers(base_payloads: list[dict]) -> list[dict]:
    results: list[dict] = []
    for payload in base_payloads:
        site_name = str(payload["site"]).strip().upper()
        logger.info("Running site locally inside dispatcher | site=%s", site_name)
        try:
            result = _run_worker(payload)
        except Exception as exc:
            logger.exception("Local worker execution failed | site=%s", site_name)
            result = {
                "site": site_name,
                "ok": False,
                "returncode": 1,
                "stdout_tail": "",
                "stderr_tail": str(exc),
                "planned_control_forced": False,
                "planned_window_ids_applied": [],
            }
        results.append(
            {
                "site": site_name,
                "ok": bool(result.get("ok")),
                "attempts": [
                    {
                        "attempt": 1,
                        "ok": bool(result.get("ok")),
                        "status_code": 200 if result.get("ok") else 500,
                        "returncode": result.get("returncode"),
                        "planned_control_forced": bool(result.get("planned_control_forced")),
                        "planned_window_ids_applied": result.get("planned_window_ids_applied") or [],
                    }
                ],
                "result": result,
            }
        )
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
    strict_payload_execution = bool(event.get("strict_payload_execution")) or bool(event.get("payload_version"))
    if not strict_payload_execution:
        raise ValueError("legacy non-strict scheduler worker mode is disabled; use strict SchedulerPayload execution")
    trigger_type = str(event.get("trigger_type") or "").strip().upper() or None
    intraday_reason = _normalize_intraday_reason_label(event.get("schedule_reason_label"))
    intraday_trigger_key = str(event.get("intraday_trigger_key") or "").strip() or None
    explicit_planned_window_ids = [
        str(item).strip()
        for item in (event.get("planned_window_ids") or [])
        if str(item).strip()
    ]
    logger.info(
        "Worker event received | run_id=%s | site=%s | engine_block_ref=%s | run_ts_ist=%s | intraday_reason=%s | trigger_type=%s | strict_payload_execution=%s | planned_window_ids=%s",
        run_context_id,
        site,
        forced_block,
        run_ts_ist_iso,
        intraday_reason,
        trigger_type,
        strict_payload_execution,
        explicit_planned_window_ids,
    )

    _configure_for_site(site)
    _reset_workdir()
    selected_raw_date = None
    downloaded_prev = 0
    staged_workspace_files = _materialize_workspace_manifest(
        event.get("scheduler_workspace_manifest") if isinstance(event, dict) else None
    )

    run_started_ts = datetime.now().timestamp()
    proc = _run_engine_once(
        site,
        forced_block=forced_block,
        run_ts_ist_iso=run_ts_ist_iso,
        schedule_reason_label=intraday_reason,
        da_only=False,
        intraday_trigger_key=intraday_trigger_key,
        run_context_id=run_context_id,
        trigger_type=trigger_type,
        strict_payload_execution=True,
    )
    _log_scheduler_process_output(f"SCHEDULER RUN | site={site}", proc)

    schedule_artifacts_created = _has_schedule_artifacts_for_run(run_ts_ist, forced_block, since_ts=run_started_ts)
    overall_ok = proc.returncode == 0

    applied_planned_window_ids: list[str] = []
    if overall_ok and schedule_artifacts_created and explicit_planned_window_ids:
        applied_planned_window_ids = list(explicit_planned_window_ids)
        _mark_planned_windows_triggered(applied_planned_window_ids, run_ts_ist_iso, forced_block)

    uploaded = 0
    uploaded_logs = 0
    if overall_ok and schedule_artifacts_created:
        uploaded += _upload_outputs_for_run(run_ts_ist, trigger_block=forced_block, since_ts=run_started_ts)
        uploaded_logs = _upload_logs_for_run(run_started_ts)
        uploaded += uploaded_logs

        # If DA exists (from previous/other runs), remove obsolete duplicate graph key(s) from S3.
        next_date_str = (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d")
        _cleanup_obsolete_da_graph_keys(next_date_str)

    return {
        "run_context_id": run_context_id,
        "site": site,
        "ok": overall_ok,
        "returncode": proc.returncode,
        "selected_raw_date": selected_raw_date,
        "engine_block_ref": forced_block,
        "run_ts_ist": run_ts_ist_iso,
        "intraday_trigger": bool(intraday_reason),
        "intraday_reason_label": intraday_reason,
        "intraday_trigger_key": intraday_trigger_key,
        "planned_window_ids_applied": applied_planned_window_ids,
        "schedule_artifacts_created": schedule_artifacts_created,
        "downloaded_previous_files": downloaded_prev,
        "staged_workspace_files": staged_workspace_files,
        "uploaded_generated_files": uploaded,
        "uploaded_log_files": uploaded_logs,
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
    }


def lambda_handler(event, context):
    try:
        strict_payload_execution = bool(event.get("strict_payload_execution")) or bool(event.get("payload_version")) if isinstance(event, dict) else False
        logger.info(
            "SCHEDULER HANDLER ENTRY | mode=%s | site=%s",
            str(event.get("mode", "")).lower() if isinstance(event, dict) else "",
            event.get("site") if isinstance(event, dict) else None,
        )
        if isinstance(event, dict) and str(event.get("mode", "")).lower() == "worker" and strict_payload_execution:
            worker_result = _run_worker(event)
            return {
                "statusCode": 200 if worker_result.get("ok") else 500,
                "body": json.dumps(worker_result),
            }

        return {
            "statusCode": 400,
            "body": json.dumps(
                {
                    "ok": False,
                    "error": "site scheduler lambda only supports strict worker payload execution",
                }
            ),
        }
    except Exception as exc:
        return {
            "statusCode": 500,
            "body": json.dumps({"ok": False, "error": str(exc)}),
        }
