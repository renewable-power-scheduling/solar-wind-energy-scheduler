import json
import os
import re
import shutil
import subprocess
import sys
import logging
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3
from utils.site_config_loader import load_site_config


BUCKET = os.environ["BUCKET"]
PLANT_ID_BASE = os.environ.get("PLANT_ID", "vedanjay")
SITE_NAME = os.environ.get("SITE_NAME", "GSNP")
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
WORK_ROOT_BASE = Path("/tmp")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IST = ZoneInfo("Asia/Kolkata")
SCHEDULER_FUNCTION = os.getenv("SCHEDULER_FUNCTION", "global1-scheduler").strip()
ENABLE_DA_SCHEDULER_TRIGGER = os.getenv("ENABLE_DA_SCHEDULER_TRIGGER", "0").strip() != "0"
ENABLE_INTRADAY_SCHEDULER_TRIGGER = os.getenv("ENABLE_INTRADAY_SCHEDULER_TRIGGER", "1").strip() != "0"

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")


WORK_ROOT = WORK_ROOT_BASE / "work"
RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


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
    global SITE_NAME, WORK_ROOT, RAW_BASE_PREFIX
    SITE_NAME = site_name
    WORK_ROOT = WORK_ROOT_BASE / f"work_{site_name.lower()}"
    RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"


def _reset_workdir() -> None:
    if WORK_ROOT.exists():
        shutil.rmtree(WORK_ROOT)
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    (WORK_ROOT / "data").mkdir(parents=True, exist_ok=True)


def _prepare_fetch_assets() -> None:
    src = Path("/var/task") / "Data loader"
    dst = WORK_ROOT / "Data loader"
    if not src.exists():
        raise FileNotFoundError(f"Missing source folder: {src}")
    shutil.copytree(src, dst)


def _run_fetch_once(site_name: str) -> subprocess.CompletedProcess:
    script = WORK_ROOT / "Data loader" / "Fetchdata.py"
    if not script.exists():
        raise FileNotFoundError(f"Missing fetch script: {script}")

    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    env["PYTHONPATH"] = "/var/task"
    env["SITE_ID"] = site_name
    env["SITE_NAME"] = site_name

    return subprocess.run(
        [sys.executable, str(script)],
        cwd=str(WORK_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )


def _candidate_data_roots() -> list[Path]:
    candidates = [
        WORK_ROOT / "data",
        WORK_ROOT / "Data loader" / "data",
        WORK_ROOT / "Data loader" / "..\\data",
        WORK_ROOT / "Data loader" / "../data",
    ]
    out = []
    for c in candidates:
        try:
            if c.exists() and c.is_dir():
                out.append(c.resolve())
        except Exception:
            pass

    uniq = []
    seen = set()
    for p in out:
        s = str(p)
        if s not in seen:
            uniq.append(p)
            seen.add(s)
    return uniq



def _timestamp_to_block_ist(run_ts_ist: datetime) -> int:
    mins = (run_ts_ist.hour * 60) + run_ts_ist.minute
    return max(1, min(96, 1 + (mins // 15)))


def _intraday_revision_label_from_key(key: str) -> str | None:
    name = Path(key).name
    m = re.search(r"(?:^|[^a-z0-9])r(?P<rev>\d+)(?:[^a-z0-9]|$)", name.lower())
    if m:
        try:
            return f"intraday schedule r{int(m.group('rev'))}"
        except Exception:
            return None
    return None


def _build_intraday_regexes(site_name: str, date_part: str | None) -> list[re.Pattern[str]]:
    site = (site_name or "").strip().upper()
    if not site:
        return []
    try:
        cfg = load_site_config(site)
    except Exception:
        return []
    fp = cfg.get("file_patterns", {}) if isinstance(cfg, dict) else {}
    patterns = fp.get("intraday_filename_regex") or fp.get("intraday_filename_regexes")
    if isinstance(patterns, str) and patterns.strip():
        patterns = [patterns.strip()]
    if not isinstance(patterns, list):
        return []

    compiled: list[re.Pattern[str]] = []
    for raw in patterns:
        if not isinstance(raw, str) or not raw.strip():
            continue
        templated = raw
        if date_part:
            next_date = ""
            try:
                dt = datetime.strptime(date_part, "%Y-%m-%d")
                next_date = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
            except Exception:
                next_date = date_part
            templated = templated.replace("{current_date}", date_part).replace("{next_date}", next_date)
        try:
            compiled.append(re.compile(templated, re.IGNORECASE))
        except Exception:
            continue
    return compiled


def _intraday_reason_label_from_name(name: str, intraday_patterns: list[re.Pattern[str]]) -> str | None:
    for rx in intraday_patterns:
        m = rx.match(name)
        if not m:
            continue
        gd = m.groupdict() if m is not None else {}
        rev = gd.get("rev")
        if rev is not None:
            try:
                return f"intraday schedule r{int(str(rev))}"
            except Exception:
                pass
    # Fallback generic parser for rN tokens.
    m2 = re.search(r"(?:^|[^a-z0-9])r(?P<rev>\d+)(?:[^a-z0-9]|$)", name.lower())
    if m2:
        try:
            return f"intraday schedule r{int(m2.group('rev'))}"
        except Exception:
            return None
    return None


def _upload_raw_data() -> tuple[int, list[str], list[str], str | None]:
    roots = _candidate_data_roots()
    if not roots:
        return 0, [], [], None

    uploaded = 0
    uploaded_da_keys: list[str] = []
    uploaded_intraday_keys: list[str] = []
    intraday_reason_label: str | None = None
    site_token = (SITE_NAME or "").strip().upper()
    for data_root in roots:
        for f in data_root.rglob("*"):
            if not f.is_file():
                continue

            rel = f.relative_to(data_root)
            parts = rel.parts

            date_part = None
            suffix = ""
            if parts and DATE_RE.match(parts[0]):
                # date/... (preferred)
                date_part = parts[0]
                suffix = "/".join(parts[1:]) if len(parts) > 1 else ""
            elif (
                len(parts) >= 2
                and parts[0].strip().upper() == site_token
                and DATE_RE.match(parts[1])
            ):
                # SITE/DATE/...
                date_part = parts[1]
                suffix = "/".join(parts[2:]) if len(parts) > 2 else ""
            elif (
                len(parts) >= 3
                and parts[0] == "_shared"
                and parts[1].strip().upper() == site_token
                and DATE_RE.match(parts[2])
            ):
                # _shared/SITE/DATE/...
                date_part = parts[2]
                suffix = "/".join(parts[3:]) if len(parts) > 3 else ""
            elif (
                len(parts) >= 3
                and parts[0].strip().upper() == site_token
                and parts[1] == "_shared"
                and DATE_RE.match(parts[2])
            ):
                # SITE/_shared/DATE/...
                date_part = parts[2]
                suffix = "/".join(parts[3:]) if len(parts) > 3 else ""

            if date_part:
                # Always normalize into primary layout
                key = f"{RAW_BASE_PREFIX}/{date_part}/{suffix}" if suffix else f"{RAW_BASE_PREFIX}/{date_part}"
            else:
                # Non-date assets go to shared area
                key = f"{RAW_BASE_PREFIX}/_shared/{rel.as_posix()}"

            s3.upload_file(str(f), BUCKET, key)
            uploaded += 1

            # Track DA uploads so we can trigger DA schedule generation immediately.
            if "/enercast_data/day_ahead/" in f"/{key.replace(os.sep, '/')}/":
                if key.lower().endswith(".csv"):
                    uploaded_da_keys.append(key)
            if "/enercast_data/intraday/" in f"/{key.replace(os.sep, '/')}/":
                if key.lower().endswith(".csv"):
                    intraday_patterns = _build_intraday_regexes(SITE_NAME, date_part)
                    name = Path(key).name
                    matched = any(rx.match(name) for rx in intraday_patterns) if intraday_patterns else True
                    if not matched:
                        continue
                    uploaded_intraday_keys.append(key)
                    parsed_reason = _intraday_reason_label_from_name(name, intraday_patterns)
                    if parsed_reason is None:
                        parsed_reason = _intraday_revision_label_from_key(key)
                    if parsed_reason:
                        intraday_reason_label = parsed_reason

    return uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label


def _trigger_scheduler_da_refresh(site: str, uploaded_da_keys: list[str]) -> None:
    if not ENABLE_DA_SCHEDULER_TRIGGER or not uploaded_da_keys:
        return

    now_ist = datetime.now(IST)
    payload = {
        "mode": "da_refresh",
        "site": site,
        "run_ts_ist": now_ist.isoformat(),
        "engine_block_ref": _timestamp_to_block_ist(now_ist),
        "raw_da_keys": uploaded_da_keys[-10:],  # cap payload size
    }

    try:
        lambda_client.invoke(
            FunctionName=SCHEDULER_FUNCTION,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        logger.info(
            "Triggered scheduler DA refresh: function=%s site=%s keys=%s",
            SCHEDULER_FUNCTION,
            site,
            uploaded_da_keys[-3:],
        )
    except Exception:
        logger.exception("Failed to trigger scheduler DA refresh for site=%s", site)


def _trigger_scheduler_intraday_refresh(
    site: str,
    uploaded_intraday_keys: list[str],
    intraday_reason_label: str | None,
) -> None:
    if not ENABLE_INTRADAY_SCHEDULER_TRIGGER or not uploaded_intraday_keys:
        return

    now_ist = datetime.now(IST)
    payload = {
        "mode": "intraday_refresh",
        "site": site,
        "run_ts_ist": now_ist.isoformat(),
        "engine_block_ref": _timestamp_to_block_ist(now_ist),
        "schedule_reason_label": intraday_reason_label,
        "raw_intraday_keys": uploaded_intraday_keys[-10:],
        "intraday_trigger_key": uploaded_intraday_keys[-1],
    }

    try:
        lambda_client.invoke(
            FunctionName=SCHEDULER_FUNCTION,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        logger.info(
            "Triggered scheduler intraday refresh: function=%s site=%s reason=%s key=%s",
            SCHEDULER_FUNCTION,
            site,
            intraday_reason_label,
            uploaded_intraday_keys[-1],
        )
    except Exception:
        logger.exception("Failed to trigger scheduler intraday refresh for site=%s", site)

def lambda_handler(event, context):
    try:
        sites = _resolve_site_ids()
        results = []
        any_failed = False

        for site in sites:
            _configure_for_site(site)
            _reset_workdir()
            _prepare_fetch_assets()
            proc = _run_fetch_once(site)

            uploaded = 0
            if proc.returncode == 0:
                uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label = _upload_raw_data()
                _trigger_scheduler_da_refresh(site, uploaded_da_keys)
                _trigger_scheduler_intraday_refresh(site, uploaded_intraday_keys, intraday_reason_label)
            else:
                any_failed = True
                uploaded_da_keys = []
                uploaded_intraday_keys = []
                intraday_reason_label = None

            results.append(
                {
                    "site": site,
                    "ok": proc.returncode == 0,
                    "returncode": proc.returncode,
                    "uploaded_files": uploaded,
                    "uploaded_da_files": len(uploaded_da_keys),
                    "uploaded_intraday_files": len(uploaded_intraday_keys),
                    "intraday_reason_label": intraday_reason_label,
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
