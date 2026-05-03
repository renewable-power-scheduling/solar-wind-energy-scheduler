import json
import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3


BUCKET = os.environ["BUCKET"]
PLANT_ID_BASE = os.environ.get("PLANT_ID", "vedanjay")
SITE_NAME = os.environ.get("SITE_NAME", "SIRMOUR")
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
WORK_ROOT_BASE = Path("/tmp")
IST = ZoneInfo("Asia/Kolkata")

s3 = boto3.client("s3")
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

WORK_ROOT = WORK_ROOT_BASE / "work"
RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
GEN_BASE_PREFIX = f"generated/{PLANT_ID_BASE}/{SITE_NAME}"

REVISION_TO_LABEL = {
    "DA1": "Day-ahead 1st rev",
    "DA2": "Day-ahead 2nd rev",
}
REVISION_TO_BLOCK = {
    "DA1": 22,
    "DA2": 88,
}


def _resolve_site_ids() -> list[str]:
    if SITE_IDS_ENV:
        out: list[str] = []
        for token in SITE_IDS_ENV.split(","):
            s = token.strip().upper()
            if s and s not in out:
                out.append(s)
        if out:
            return out
    return [SITE_NAME.upper()]


def _configure_for_site(site_name: str) -> None:
    global SITE_NAME, WORK_ROOT, RAW_BASE_PREFIX, GEN_BASE_PREFIX
    SITE_NAME = site_name
    WORK_ROOT = WORK_ROOT_BASE / f"work_da_{site_name.lower()}"
    RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
    GEN_BASE_PREFIX = f"generated/{PLANT_ID_BASE}/{SITE_NAME}"


def _reset_workdir() -> None:
    if WORK_ROOT.exists():
        shutil.rmtree(WORK_ROOT)
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    for d in ("data", "outputs", "logs", "Combined"):
        (WORK_ROOT / d).mkdir(parents=True, exist_ok=True)


def _prefix_has_any_object(prefix: str) -> bool:
    resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix, MaxKeys=1)
    return "Contents" in resp


def _list_date_prefixes() -> list[str]:
    prefixes = [
        f"{RAW_BASE_PREFIX}/",
        f"{RAW_BASE_PREFIX}/_shared/{SITE_NAME}/",
    ]
    dates = set()
    for prefix in prefixes:
        date_pattern = re.compile(rf"^{re.escape(prefix)}(\d{{4}}-\d{{2}}-\d{{2}})/")
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                m = date_pattern.match(key)
                if m:
                    dates.add(m.group(1))
    return sorted(dates)


def _download_prefix_to_local(prefix: str, local_root: Path) -> int:
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


def _download_raw_inputs(run_ts_ist: datetime) -> str:
    expected_date = run_ts_ist.strftime("%Y-%m-%d")
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

    shared_prefix = f"{RAW_BASE_PREFIX}/_shared/"
    if _prefix_has_any_object(shared_prefix):
        _download_prefix_to_local(shared_prefix, WORK_ROOT / "data")

    expected_local = WORK_ROOT / "data" / expected_date
    if not expected_local.exists():
        shutil.copytree(local_date_root, expected_local)
    return selected_date


def _download_previous_generated_state() -> int:
    total = 0
    total += _download_prefix_to_local(f"{GEN_BASE_PREFIX}/outputs/", WORK_ROOT / "outputs")
    total += _download_prefix_to_local(f"{GEN_BASE_PREFIX}/logs/", WORK_ROOT / "logs")
    total += _download_prefix_to_local(f"{GEN_BASE_PREFIX}/Combined/", WORK_ROOT / "Combined")
    return total


def _run_da_for_site(site_name: str, run_ts_ist: datetime, revision: str) -> dict:
    _configure_for_site(site_name)
    _reset_workdir()

    selected_raw_date = _download_raw_inputs(run_ts_ist=run_ts_ist)
    downloaded_prev = _download_previous_generated_state()

    reason = REVISION_TO_LABEL[revision]
    block = REVISION_TO_BLOCK[revision]
    run_ts_ist_iso = run_ts_ist.isoformat()

    env = dict(os.environ)
    env["SKIP_FETCHER"] = "1"
    env["PYTHONPATH"] = "/var/task"
    env["SITE_ID"] = site_name
    env["SITE_NAME"] = site_name
    env["ENGINE_BLOCK_OVERRIDE"] = str(block)
    env["ENGINE_NOW_IST"] = run_ts_ist_iso
    env["DA_SCHEDULE_REASON_LABEL"] = reason
    env["DATA_ROOT"] = str(WORK_ROOT / "data")
    env["OUTPUT_ROOT"] = str(WORK_ROOT / "outputs")
    env["LOG_ROOT"] = str(WORK_ROOT / "logs")
    env["COMBINED_ROOT"] = str(WORK_ROOT / "Combined")

    engine_script = Path("/var/task") / "run_da_engine.py"
    proc = subprocess.run(
        [sys.executable, str(engine_script)],
        cwd=str(WORK_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )

    uploaded = 0
    uploaded_logs = _upload_local_tree(WORK_ROOT / "logs", f"{GEN_BASE_PREFIX}/logs")
    uploaded += uploaded_logs
    if proc.returncode == 0:
        uploaded += _upload_local_tree(WORK_ROOT / "outputs", f"{GEN_BASE_PREFIX}/outputs")
        uploaded += _upload_local_tree(WORK_ROOT / "Combined", f"{GEN_BASE_PREFIX}/Combined")

    return {
        "site": site_name,
        "ok": proc.returncode == 0,
        "revision": revision,
        "schedule_reason": reason,
        "engine_block_ref": block,
        "run_ts_ist": run_ts_ist_iso,
        "selected_raw_date": selected_raw_date,
        "downloaded_previous_files": downloaded_prev,
        "uploaded_generated_files": uploaded,
        "uploaded_log_files": uploaded_logs,
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
    }


def lambda_handler(event, context):
    try:
        revision = str((event or {}).get("revision") or "").strip().upper()
        if revision not in REVISION_TO_LABEL:
            now_ist = datetime.now(IST)
            revision = "DA1" if now_ist.hour < 12 else "DA2"

        run_ts_ist = datetime.now(IST)
        sites = _resolve_site_ids()

        results: list[dict] = []
        failed_sites: list[str] = []
        for site in sites:
            result = _run_da_for_site(site_name=site, run_ts_ist=run_ts_ist, revision=revision)
            results.append(result)
            if not result.get("ok"):
                failed_sites.append(site)

        logger.info(
            "DA schedule generated run completed | revision=%s | ok=%s | sites=%s | failed=%s",
            revision,
            not failed_sites,
            ",".join(sites),
            ",".join(failed_sites) if failed_sites else "-",
        )

        body = {
            "ok": not failed_sites,
            "mode": "global1_da_scheduler",
            "revision": revision,
            "schedule_reason_label": REVISION_TO_LABEL[revision],
            "run_ts_ist": run_ts_ist.isoformat(),
            "sites": sites,
            "failed_sites": failed_sites,
            "results": results,
        }
        return {
            "statusCode": 200 if not failed_sites else 500,
            "body": json.dumps(body),
        }
    except Exception as exc:
        return {
            "statusCode": 500,
            "body": json.dumps({"ok": False, "error": str(exc)}),
        }
