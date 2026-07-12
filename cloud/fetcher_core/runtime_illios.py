import json
import os
import re
import shutil
import subprocess
import sys
import logging
import importlib.util
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:
    boto3 = None
from cloud.common.config_loader import load_site_config


BUCKET = os.environ.get("BUCKET", "")
PLANT_ID_BASE = os.environ.get("PLANT_ID", "vedanjay")
SITE_NAME = os.environ.get("SITE_NAME", "ANJANGOAN")
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
WORK_ROOT_BASE = Path("/tmp")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IST = ZoneInfo("Asia/Kolkata")
SCHEDULER_FUNCTION = os.getenv("SCHEDULER_FUNCTION", "illios-power-scheduler").strip()
ENABLE_DA_SCHEDULER_TRIGGER = os.getenv("ENABLE_DA_SCHEDULER_TRIGGER", "0").strip() != "0"
ENABLE_INTRADAY_SCHEDULER_TRIGGER = os.getenv("ENABLE_INTRADAY_SCHEDULER_TRIGGER", "1").strip() != "0"

s3 = boto3.client("s3") if boto3 else None
lambda_client = boto3.client("lambda") if boto3 else None


WORK_ROOT = WORK_ROOT_BASE / "work"
RAW_BASE_PREFIX = f"raw/{PLANT_ID_BASE}/{SITE_NAME}"
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_FETCHDATA_MODULE = None
def _env_site_list(name: str, default: str = "") -> tuple[str, ...]:
    raw = os.getenv(name, default).strip()
    sites: list[str] = []
    if not raw:
        return tuple(sites)
    for token in raw.split(","):
        site = token.strip().upper()
        if site and site not in sites:
            sites.append(site)
    return tuple(sites)


# Keep the shared session path configurable, but do not couple ANJANGOAN to
# the Global1 fetcher anymore. ANJANGOAN now runs from the separate
# illios_power bundle.
_SHARED_SESSION_SITES = _env_site_list("FETCHER_SHARED_SESSION_SITES", "")


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
    # The packaged Lambda image already contains the fetch code.
    # The workdir only needs the writable `data/` area.
    (WORK_ROOT / "data").mkdir(parents=True, exist_ok=True)


def _load_fetchdata_module():
    global _FETCHDATA_MODULE
    if _FETCHDATA_MODULE is not None:
        return _FETCHDATA_MODULE

    script_candidates = [
        Path(__file__).resolve().parents[1] / "fetcher_core" / "fetch_worker.py",
    ]
    script_path = next((p for p in script_candidates if p.exists()), None)
    if script_path is None:
        raise FileNotFoundError(
            "Unable to locate fetch worker under cloud/fetcher_core/fetch_worker.py"
        )
    spec = importlib.util.spec_from_file_location("illios_power_fetchdata_shared", script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load Fetchdata module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _FETCHDATA_MODULE = module
    return module


def _run_fetch_once(site_name: str) -> subprocess.CompletedProcess:
    script_candidates = [
        Path(__file__).resolve().parents[1] / "fetcher_core" / "fetch_worker.py",
    ]
    script = next((p for p in script_candidates if p.exists()), None)
    if script is None:
        raise FileNotFoundError(
            "Missing fetch script under cloud/fetcher_core/fetch_worker.py"
        )

    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    env["SITE_ID"] = site_name
    env["SITE_NAME"] = site_name
    env["FETCH_BASE_DIR"] = str((WORK_ROOT / "data").resolve())

    return subprocess.run(
        [sys.executable, str(script)],
        cwd=str(WORK_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )


def _log_process_output(prefix: str, proc: subprocess.CompletedProcess) -> None:
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    if stdout:
        logger.info("%s stdout:\n%s", prefix, stdout)
    if stderr:
        logger.info("%s stderr:\n%s", prefix, stderr)


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


def _site_date_data_root(site_name: str, run_date: str) -> Path:
    site_token = str(site_name or "").strip().upper()
    return WORK_ROOT / "data" / site_token / run_date


def _site_date_data_root_candidates(site_name: str, run_date: str) -> list[Path]:
    candidates: list[Path] = []

    def _add(site_token: str) -> None:
        token = str(site_token or "").strip().upper()
        if not token:
            return
        path = WORK_ROOT / "data" / token / run_date
        if path not in candidates:
            candidates.append(path)

    _add(site_name)
    try:
        cfg = load_site_config(site_name)
        _add(str(cfg.get("site_id") or ""))
    except Exception:
        pass
    return candidates


def _resolve_upload_root(site_name: str, run_date: str) -> Path:
    for preferred in _site_date_data_root_candidates(site_name, run_date):
        if preferred.exists() and preferred.is_dir():
            return preferred

    date_only = WORK_ROOT / "data" / run_date
    if date_only.exists() and date_only.is_dir():
        return date_only

    return WORK_ROOT / "data"


def _site_token_aliases(site_name: str) -> set[str]:
    aliases: set[str] = set()

    def _add(value: str) -> None:
        token = str(value or "").strip().upper()
        if token:
            aliases.add(token)

    _add(site_name)
    try:
        cfg = load_site_config(site_name)
        _add(str(cfg.get("site_id") or ""))
    except Exception:
        pass
    return aliases



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


def _intraday_reason_label_from_policy(site: str, uploaded_intraday_keys: list[str]) -> str | None:
    try:
        site_cfg = load_site_config(site)
    except Exception:
        return None

    revisions = site_cfg.get("intraday_revisions", []) or []
    if not revisions:
        return None

    for key in uploaded_intraday_keys:
        filename = Path(str(key)).name
        for item in revisions:
            try:
                revision_no = int(item.get("revision"))
            except Exception:
                continue
            start = str(item.get("start") or "").strip()
            end = str(item.get("end") or "").strip()
            if (start and start in filename) or (end and end in filename):
                return f"intraday schedule r{revision_no}"

    try:
        return f"intraday schedule r{int(revisions[0].get('revision'))}"
    except Exception:
        return None


def _time_text_to_slot_end_block(value: str | None) -> int | None:
    match = re.match(r"^(?P<hour>\d{1,2}):(?P<minute>\d{2})$", str(value or "").strip())
    if not match:
        return None
    hour = int(match.group("hour"))
    minute = int(match.group("minute"))
    total_minutes = (hour * 60) + minute
    if hour < 0 or hour > 24 or minute < 0 or minute > 59:
        return None
    if total_minutes == 0:
        return 96
    if total_minutes > 1440 or total_minutes % 15 != 0:
        return None
    return max(1, min(96, total_minutes // 15))


def _intraday_arrival_block_from_key(key: str) -> int | None:
    match = re.search(
        r"\d{4}-\d{2}-\d{2}-(?P<hour>\d{2})-(?P<minute>\d{2})(?:\+|\-)\d{4}(?=\.csv$)",
        Path(key).name,
        re.IGNORECASE,
    )
    if not match:
        return None
    hour = int(match.group("hour"))
    minute = int(match.group("minute"))
    if hour > 23 or minute > 59:
        return None
    return max(1, min(96, 1 + (((hour * 60) + minute) // 15)))


def _intraday_revision_number_from_key(site: str, key: str) -> int | None:
    label = _intraday_revision_label_from_key(key)
    if label:
        match = re.search(r"\br(?P<revision>\d+)\b", label.lower())
        if match:
            return int(match.group("revision"))

    arrival_block = _intraday_arrival_block_from_key(key)
    if arrival_block is None:
        return None
    try:
        site_cfg = load_site_config(site)
    except Exception:
        return None
    for item in site_cfg.get("intraday_revisions", []) or []:
        try:
            if int(item.get("block")) == arrival_block:
                return int(item.get("revision"))
        except Exception:
            continue
    return None


def _intraday_generation_event(
    site: str,
    uploaded_intraday_keys: list[str],
    run_ts_ist: datetime,
) -> tuple[str, str, int] | None:
    if not uploaded_intraday_keys:
        return None
    try:
        site_cfg = load_site_config(site)
    except Exception:
        return None

    current_block = _timestamp_to_block_ist(run_ts_ist)
    policy = site_cfg.get("intraday_schedule_policy", {}) or {}
    first_generation_block = int(
        policy.get("first_generation_block")
        or policy.get("mandatory_generation_block")
        or 1
    )
    generation_blocks = {
        block
        for block in (
            _time_text_to_slot_end_block(slot.get("end"))
            for slot in (site_cfg.get("schedule_submission", {}) or {}).get("slots", []) or []
            if isinstance(slot, dict)
        )
        if block is not None and block >= first_generation_block
    }
    if bool(policy.get("slot_end_only", False)) and current_block not in generation_blocks:
        return None

    eligible_revisions: list[tuple[int, int]] = []
    for item in site_cfg.get("intraday_revisions", []) or []:
        try:
            revision = int(item.get("revision"))
            arrival_block = int(item.get("block"))
        except Exception:
            continue
        if arrival_block <= current_block:
            eligible_revisions.append((arrival_block, revision))
    if not eligible_revisions:
        return None

    expected_revision = max(eligible_revisions)[1]
    matching_keys = [
        key
        for key in uploaded_intraday_keys
        if _intraday_revision_number_from_key(site, key) == expected_revision
    ]
    if not matching_keys:
        return None
    selected_key = sorted(set(matching_keys))[-1]
    return selected_key, f"intraday schedule r{expected_revision}", current_block


def _arrival_timestamp_ist_from_filename(name: str) -> str | None:
    match = re.search(
        r"(?P<date>\d{4}-\d{2}-\d{2})-(?P<hour>\d{2})-(?P<minute>\d{2})(?:\+|\-)\d{4}(?=\.csv$)",
        Path(name).name,
        re.IGNORECASE,
    )
    if not match:
        return None
    hour = int(match.group("hour"))
    minute = int(match.group("minute"))
    if hour > 23 or minute > 59:
        return None
    return f"{match.group('date')} {hour:02d}:{minute:02d}:00"


def _write_forecast_meta(key: str, arrival_time_ist: str | None) -> None:
    if not key.lower().endswith(".csv"):
        return
    meta_key = f"{key[:-4]}.meta.json"
    payload = {
        "arrival_timestamp_ist": arrival_time_ist,
    }
    s3.put_object(
        Bucket=BUCKET,
        Key=meta_key,
        Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )


def _arrival_timestamp_ist_from_sidecar(csv_path: Path) -> str | None:
    meta_path = csv_path.with_suffix(".meta.json")
    if not meta_path.exists():
        return None
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    ts = data.get("arrival_timestamp_ist")
    if not isinstance(ts, str) or not ts.strip():
        return None
    return ts.strip()


def _resolve_arrival_timestamp_for_csv(csv_path: Path) -> str | None:
    sidecar_ts = _arrival_timestamp_ist_from_sidecar(csv_path)
    if sidecar_ts is not None:
        return sidecar_ts
    return _arrival_timestamp_ist_from_filename(csv_path.name)


def _restore_metered_state_from_s3(site_name: str, run_date: str) -> int:
    prefix = f"raw/{PLANT_ID_BASE}/{site_name}/{run_date}/metered_data/"
    target_dir = _site_date_data_root(site_name, run_date) / "metered_data"
    target_dir.mkdir(parents=True, exist_ok=True)

    restored = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for item in page.get("Contents", []):
            key = str(item.get("Key") or "")
            if not key or key.endswith("/"):
                continue
            rel_name = key[len(prefix):]
            if not rel_name:
                continue
            local_path = target_dir / rel_name
            local_path.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(BUCKET, key, str(local_path))
            restored += 1

    if restored:
        logger.info(
            "Restored prior metered state from S3: site=%s date=%s files=%s prefix=%s",
            site_name,
            run_date,
            restored,
            prefix,
        )
    return restored


def _manifest_roots_for_upload(data_root: Path) -> list[Path]:
    direct_manifest = data_root / "fetch_manifest.json"
    if direct_manifest.exists():
        return [data_root]

    roots: list[Path] = []
    seen: set[str] = set()
    for manifest_path in data_root.rglob("fetch_manifest.json"):
        try:
            parent = manifest_path.parent.resolve()
        except Exception:
            continue
        parent_str = str(parent)
        if parent_str not in seen:
            seen.add(parent_str)
            roots.append(parent)
    return roots


def _manifest_paths_for_upload(data_root: Path) -> list[Path]:
    manifest_path = data_root / "fetch_manifest.json"
    if not manifest_path.exists():
        return []

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to read fetch manifest for upload planning: %s", manifest_path)
        return []

    paths: list[Path] = [manifest_path]
    seen: set[str] = {str(manifest_path.resolve())}

    def _add_local(local_value: str | None, *, add_sidecar_for_forecast: bool = False) -> None:
        if not local_value:
            return
        candidate = data_root / str(local_value)
        if candidate.exists() and candidate.is_file():
            resolved = str(candidate.resolve())
            if resolved not in seen:
                seen.add(resolved)
                paths.append(candidate)
            if add_sidecar_for_forecast:
                meta_path = candidate.with_suffix(".meta.json")
                if meta_path.exists() and meta_path.is_file():
                    meta_resolved = str(meta_path.resolve())
                    if meta_resolved not in seen:
                        seen.add(meta_resolved)
                        paths.append(meta_path)

    raw_inputs = manifest.get("raw_inputs", {}) if isinstance(manifest, dict) else {}
    enercast = raw_inputs.get("enercast", {}) if isinstance(raw_inputs, dict) else {}
    for entries in enercast.values():
        if not isinstance(entries, list):
            continue
        for item in entries:
            if not isinstance(item, dict) or item.get("action") != "downloaded":
                continue
            _add_local(item.get("local_path"), add_sidecar_for_forecast=True)

    metered_entries = raw_inputs.get("metered", []) if isinstance(raw_inputs, dict) else []
    if isinstance(metered_entries, list):
        for item in metered_entries:
            if not isinstance(item, dict):
                continue
            _add_local(item.get("local_path"))
            _add_local(item.get("progress_local_path"))

    return paths


def _upload_raw_data(data_root_override: Path | None = None) -> tuple[int, list[str], list[str], str | None]:
    roots = [data_root_override.resolve()] if data_root_override is not None else _candidate_data_roots()
    if not roots:
        return 0, [], [], None

    uploaded = 0
    uploaded_da_keys: list[str] = []
    uploaded_intraday_keys: list[str] = []
    intraday_reason_label: str | None = None
    site_token = (SITE_NAME or "").strip().upper()
    site_aliases = _site_token_aliases(SITE_NAME)
    for data_root in roots:
        manifest_roots = _manifest_roots_for_upload(data_root)
        if not manifest_roots:
            logger.info("No current-run manifest upload candidates found under %s", data_root)
            continue
        for manifest_root in manifest_roots:
            upload_candidates = _manifest_paths_for_upload(manifest_root)
            if not upload_candidates:
                continue

            root_name = manifest_root.name
            root_parent_name = manifest_root.parent.name if manifest_root.parent else ""
            root_is_date_dir = bool(DATE_RE.match(root_name))
            root_date_part = root_name if root_is_date_dir else None
            root_site_token = root_parent_name.strip().upper() if root_is_date_dir else ""
            for f in upload_candidates:
                rel = f.relative_to(manifest_root)
                parts = rel.parts

                date_part = None
                suffix = ""
                if root_date_part and root_site_token in (site_aliases | {""}):
                    # data root is already SITE/DATE or DATE, so all children belong to this date
                    date_part = root_date_part
                    suffix = rel.as_posix()
                elif parts and DATE_RE.match(parts[0]):
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

                normalized_key = f"/{key.replace(os.sep, '/')}/".lower()
                if key.lower().endswith(".csv") and "/enercast_data/" in normalized_key:
                    try:
                        arrival_ts = _resolve_arrival_timestamp_for_csv(f)
                        _write_forecast_meta(key, arrival_ts)
                    except Exception:
                        logger.exception("Failed to write forecast meta | key=%s", key)

    return uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label


def _shared_session_candidates(sites: list[str]) -> list[str]:
    site_set = {str(site).strip().upper() for site in sites}
    return [site for site in _SHARED_SESSION_SITES if site in site_set]


def _process_shared_sirmour_anjangoan(run_date: str, sites: list[str]) -> list[dict]:
    shared_sites = _shared_session_candidates(sites)
    if len(shared_sites) < 2:
        return []

    fetchdata = _load_fetchdata_module()
    primary_site = shared_sites[0]
    primary_cfg = load_site_config(primary_site)
    client = None
    results: list[dict] = []

    logger.info(
        "REMOTE SESSION OPEN | shared_group=%s | protocol=%s | host=%s | port=%s",
        ",".join(shared_sites),
        str(primary_cfg.get("protocol", "")).strip().lower(),
        primary_cfg.get("connection", {}).get("host"),
        primary_cfg.get("connection", {}).get("port"),
    )

    try:
        client = fetchdata._build_remote_client(primary_cfg)
        for site in shared_sites:
            _configure_for_site(site)
            _reset_workdir()
            _restore_metered_state_from_s3(site, run_date)
            cfg = load_site_config(site)
            cfg.setdefault("paths", {})["base_dir"] = str((WORK_ROOT / "data").resolve())
            logger.info("REMOTE SESSION FETCH | shared_group=%s | site=%s", ",".join(shared_sites), site)
            try:
                fetchdata._sync_once_with_client(cfg, run_date, client=client)
                upload_root = _resolve_upload_root(site, run_date)
                uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label = _upload_raw_data(
                    data_root_override=upload_root
                )
                if uploaded_intraday_keys and intraday_reason_label is None:
                    intraday_reason_label = _intraday_reason_label_from_policy(site, uploaded_intraday_keys)
                logger.info(
                    "REMOTE SESSION UPLOAD | shared_group=%s | site=%s | upload_root=%s | uploaded=%s | intraday=%s | dayahead=%s",
                    ",".join(shared_sites),
                    site,
                    str(upload_root),
                    uploaded,
                    len(uploaded_intraday_keys),
                    len(uploaded_da_keys),
                )
                _trigger_scheduler_da_refresh(site, uploaded_da_keys)
                _trigger_scheduler_intraday_refresh(site, uploaded_intraday_keys, intraday_reason_label)
                results.append(
                    {
                        "site": site,
                        "ok": True,
                        "returncode": 0,
                        "uploaded_files": uploaded,
                        "uploaded_da_files": len(uploaded_da_keys),
                        "uploaded_intraday_files": len(uploaded_intraday_keys),
                        "intraday_reason_label": intraday_reason_label,
                        "stdout_tail": "",
                        "stderr_tail": "",
                    }
                )
            except Exception as exc:
                logger.exception("REMOTE SESSION FETCH FAILED | shared_group=%s | site=%s", ",".join(shared_sites), site)
                results.append(
                    {
                        "site": site,
                        "ok": False,
                        "returncode": 1,
                        "uploaded_files": 0,
                        "uploaded_da_files": 0,
                        "uploaded_intraday_files": 0,
                        "intraday_reason_label": None,
                        "stdout_tail": "",
                        "stderr_tail": str(exc),
                    }
                )
    finally:
        if client is not None:
            try:
                client.close()
            finally:
                logger.info("REMOTE SESSION CLOSE | shared_group=%s", ",".join(shared_sites))

    return results


def _trigger_scheduler_da_refresh(site: str, uploaded_da_keys: list[str]) -> None:
    if not ENABLE_DA_SCHEDULER_TRIGGER or not uploaded_da_keys:
        return

    now_ist = datetime.now(IST)
    latest_da_keys = list(dict.fromkeys(uploaded_da_keys))[-1:]
    payload = {
        "mode": "da_refresh",
        "site": site,
        "run_ts_ist": now_ist.isoformat(),
        "engine_block_ref": _timestamp_to_block_ist(now_ist),
        "raw_da_keys": latest_da_keys,
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
            latest_da_keys,
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
    generation_event = _intraday_generation_event(site, uploaded_intraday_keys, now_ist)
    if generation_event is None:
        logger.info(
            "No configured intraday generation trigger | site=%s block=%s uploaded_intraday=%s",
            site,
            _timestamp_to_block_ist(now_ist),
            len(uploaded_intraday_keys),
        )
        return
    latest_intraday_key, intraday_reason_label, generation_block = generation_event
    latest_intraday_keys = [latest_intraday_key]
    payload = {
        "mode": "intraday_refresh",
        "site": site,
        "run_ts_ist": now_ist.isoformat(),
        "engine_block_ref": generation_block,
        "schedule_reason_label": intraday_reason_label,
        "raw_intraday_keys": latest_intraday_keys,
        "intraday_trigger_key": latest_intraday_key,
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
            latest_intraday_key,
        )
    except Exception:
        logger.exception("Failed to trigger scheduler intraday refresh for site=%s", site)

def lambda_handler(event, context):
    try:
        current_function = str(os.getenv("AWS_LAMBDA_FUNCTION_NAME", "")).strip().lower()
        if "scheduler" in current_function:
            raise RuntimeError(
                f"Fetch handler invoked inside scheduler Lambda ({current_function}). "
                "Deploy the scheduler using the scheduler image/handler."
            )
        sites = _resolve_site_ids()
        results = []
        any_failed = False
        processed_sites: set[str] = set()
        run_date = datetime.now(IST).strftime("%Y-%m-%d")

        _reset_workdir()
        shared_results = _process_shared_sirmour_anjangoan(run_date, sites)
        for item in shared_results:
            processed_sites.add(str(item.get("site", "")).strip().upper())
            if not item.get("ok"):
                any_failed = True
            results.append(item)

        for site in sites:
            if str(site).strip().upper() in processed_sites:
                continue
            _configure_for_site(site)
            _reset_workdir()
            _prepare_fetch_assets()
            _restore_metered_state_from_s3(site, run_date)
            proc = _run_fetch_once(site)
            _log_process_output(f"FETCH RUN | site={site}", proc)

            uploaded = 0
            if proc.returncode == 0:
                uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label = _upload_raw_data()
                if uploaded_intraday_keys and intraday_reason_label is None:
                    intraday_reason_label = _intraday_reason_label_from_policy(site, uploaded_intraday_keys)
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
