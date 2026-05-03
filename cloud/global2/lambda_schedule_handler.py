import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3
from utils.time_utils import timestamp_to_block


BUCKET = os.environ["BUCKET"]
PLANT_ID_BASE = os.environ.get("PLANT_ID", "vedanjay")
SITE_NAME = os.environ.get("SITE_NAME", "GSNP")
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
WORK_ROOT_BASE = Path("/tmp")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IST = ZoneInfo("Asia/Kolkata")

s3 = boto3.client("s3")


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


def _fixed_da_revision_label(block: int) -> str | None:
    if block == 22:
        return "Day-ahead 1st rev"
    if block == 88:
        return "Day-ahead 2nd rev"
    return None


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


def _download_raw_inputs() -> str:
    """
    1) Prefer today's IST raw date if present
    2) else latest available raw date
    3) also download shared raw assets from _shared
    Supports legacy layout: raw/<plant>/<site>/_shared/<site>/YYYY-MM-DD/
    """
    expected_date = datetime.now(IST).strftime("%Y-%m-%d")
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
    total += _download_prefix_to_local(f"{GEN_BASE_PREFIX}/Combined/", WORK_ROOT / "Combined")
    return total


def _run_engine_once(site_name: str, schedule_reason_label: str | None = None) -> subprocess.CompletedProcess:
    engine_script = Path("/var/task") / "run_phase9_engine.py"
    if not engine_script.exists():
        raise FileNotFoundError(f"Missing engine script: {engine_script}")

    env = dict(os.environ)
    env["SKIP_FETCHER"] = os.getenv("SKIP_FETCHER", "1")
    env["PYTHONPATH"] = "/var/task"
    env["SITE_ID"] = site_name
    env["SITE_NAME"] = site_name
    # Override per-site working roots so engine reads the downloaded data
    env["DATA_ROOT"] = str(WORK_ROOT / "data")
    env["OUTPUT_ROOT"] = str(WORK_ROOT / "outputs")
    env["LOG_ROOT"] = str(WORK_ROOT / "logs")
    env["COMBINED_ROOT"] = str(WORK_ROOT / "Combined")
    if schedule_reason_label:
        env["RUN_DA_ONLY"] = "1"
        env["DA_SCHEDULE_REASON_LABEL"] = schedule_reason_label

    return subprocess.run(
        [sys.executable, str(engine_script)],
        cwd=str(WORK_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )


def _upload_generated_outputs() -> int:
    total = 0
    total += _upload_local_tree(WORK_ROOT / "outputs", f"{GEN_BASE_PREFIX}/outputs")
    total += _upload_local_tree(WORK_ROOT / "logs", f"{GEN_BASE_PREFIX}/logs")
    total += _upload_local_tree(WORK_ROOT / "Combined", f"{GEN_BASE_PREFIX}/Combined")
    return total


def lambda_handler(event, context):
    try:
        sites = _resolve_site_ids()
        results = []
        any_failed = False
        current_block = timestamp_to_block(datetime.now(IST))
        fixed_da_reason = _fixed_da_revision_label(current_block)

        for site in sites:
            _configure_for_site(site)
            _reset_workdir()
            selected_raw_date = _download_raw_inputs()
            downloaded_prev = _download_previous_generated_state()

            proc = _run_engine_once(site, schedule_reason_label=fixed_da_reason)

            uploaded = 0
            if proc.returncode == 0:
                uploaded = _upload_generated_outputs()
            else:
                any_failed = True

            results.append(
                {
                    "site": site,
                    "ok": proc.returncode == 0,
                    "returncode": proc.returncode,
                    "selected_raw_date": selected_raw_date,
                    "downloaded_previous_files": downloaded_prev,
                    "uploaded_generated_files": uploaded,
                    "stdout_tail": proc.stdout[-4000:],
                    "stderr_tail": proc.stderr[-4000:],
                }
            )

        return {
            "statusCode": 200 if not any_failed else 500,
            "body": json.dumps({"ok": not any_failed, "results": results}),
        }
    except Exception as exc:
        return {
            "statusCode": 500,
            "body": json.dumps({"ok": False, "error": str(exc)}),
        }
