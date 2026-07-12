from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from cloud.common.config_loader import load_site_config
from cloud.common.csv_utils import load_enercast_forecast_csv
from cloud.scheduler_core.forecast_selector import latest_file_in_dir


def normalize_enercast_date(date_str: str) -> date:
    cleaned = date_str.strip()
    if len(cleaned) == 8 and cleaned.isdigit():
        return datetime.strptime(cleaned, "%Y%m%d").date()
    return datetime.strptime(cleaned, "%Y-%m-%d").date()


def date_from_enercast_csv(path: str) -> date:
    csv_path = Path(path)
    with csv_path.open("r", encoding="utf-8") as handle:
        for _ in range(8):
            line = handle.readline().strip()
            if not line:
                continue
            upper = line.upper()
            if upper.startswith("DATE") or upper.startswith("FOR DATE"):
                parts = line.split(",")
                if len(parts) > 1:
                    return normalize_enercast_date(parts[1])

    name = csv_path.name
    match = re.search(r"(\d{4}-\d{2}-\d{2})", name)
    if match:
        return datetime.strptime(match.group(1), "%Y-%m-%d").date()
    match = re.search(r"(\d{8})", name)
    if match:
        return datetime.strptime(match.group(1), "%Y%m%d").date()

    env_date = os.getenv("DATA_DATE")
    if env_date:
        try:
            return datetime.strptime(env_date.strip(), "%Y-%m-%d").date()
        except Exception:
            pass

    raise ValueError(f"DATE metadata not found and no date in filename: {name}")


def resolve_intraday_override(intraday_dir: Path) -> tuple[Path | None, str | None]:
    override_path_raw = str(os.getenv("INTRADAY_FILE_PATH", "")).strip()
    override_name = str(os.getenv("INTRADAY_FILE_NAME", "")).strip()

    if override_path_raw:
        path = Path(override_path_raw)
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"INTRADAY_FILE_PATH not found: {path}")
        return path, "intraday_file_path_override"

    if override_name:
        path = intraday_dir / override_name
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"INTRADAY_FILE_NAME not found in {intraday_dir}: {override_name}")
        return path, "intraday_file_name_override"

    return None, None


def list_data_date_dirs(data_root: Path) -> list[Path]:
    if not data_root.exists():
        return []
    out = []
    for path in data_root.iterdir():
        if not path.is_dir():
            continue
        try:
            datetime.strptime(path.name, "%Y-%m-%d")
        except ValueError:
            continue
        out.append(path)
    return sorted(out, key=lambda path: path.name)


def pick_data_root_for_run_date(data_root: Path, run_date: date, logger) -> Path:
    preferred = data_root / run_date.strftime("%Y-%m-%d")
    if latest_file_in_dir(preferred / "enercast_data" / "intraday") is not None:
        return preferred

    for candidate in reversed(list_data_date_dirs(data_root)):
        if latest_file_in_dir(candidate / "enercast_data" / "intraday") is not None:
            logger.warning(
                "No intraday local data for run date %s; falling back to latest available date %s",
                run_date.strftime("%Y-%m-%d"),
                candidate.name,
            )
            return candidate

    raise FileNotFoundError(f"No local data with intraday found under {data_root}")


def _score_intraday_name(name: str, match: "re.Match[str] | None", path: Path) -> tuple[int, int, float]:
    revision = 0
    time_score = 0
    if match is not None:
        group_dict = match.groupdict()
        if "rev" in group_dict and group_dict.get("rev") is not None:
            try:
                revision = int(str(group_dict["rev"]))
            except Exception:
                revision = 0
        hh = group_dict.get("hh")
        mm = group_dict.get("mm")
        if hh is not None and mm is not None:
            try:
                time_score = (int(str(hh)) * 60) + int(str(mm))
            except Exception:
                time_score = 0
    if revision == 0:
        fallback = re.search(r"(?:remc_r|_r|r)(\d+)", name.lower())
        if fallback:
            try:
                revision = int(fallback.group(1))
            except Exception:
                revision = 0
    return revision, time_score, path.stat().st_mtime


def pick_latest_intraday_source(intraday_dir: Path, site_id: str, run_date: date) -> tuple[Path, str]:
    if not intraday_dir.exists():
        raise FileNotFoundError(f"Intraday dir not found: {intraday_dir}")

    files = [path for path in intraday_dir.glob("*.csv") if path.is_file()]
    if not files:
        raise FileNotFoundError("No intraday Enercast file found")

    run_date_str = run_date.strftime("%Y-%m-%d")
    next_date_str = (run_date + timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        site_config = load_site_config(site_id.strip().upper()) or {}
    except Exception:
        site_config = {}
    file_patterns = site_config.get("file_patterns", {}) if isinstance(site_config, dict) else {}
    patterns = file_patterns.get("intraday_filename_regex") or file_patterns.get("intraday_filename_regexes")
    if isinstance(patterns, str) and patterns.strip():
        patterns = [patterns.strip()]
    if isinstance(patterns, list):
        patterns = [pattern for pattern in patterns if isinstance(pattern, str) and pattern.strip()]

    if patterns:
        compiled = [
            re.compile(
                raw.replace("{current_date}", run_date_str).replace("{next_date}", next_date_str),
                re.IGNORECASE,
            )
            for raw in patterns
        ]
        candidates: list[tuple[Path, tuple[int, int, float]]] = []
        for path in files:
            best_match = None
            for regex in compiled:
                match = regex.match(path.name)
                if match:
                    best_match = match
                    break
            if best_match is not None:
                candidates.append((path, _score_intraday_name(path.name, best_match, path)))
        if candidates:
            return max(candidates, key=lambda item: item[1])[0], "intraday_filename_regex"

    return max(files, key=lambda path: path.stat().st_mtime), "mtime_latest"


def intraday_time_rank_key(path: Path, run_date: date) -> int | None:
    name = path.name
    date_hyphen = run_date.strftime("%Y-%m-%d")
    date_compact = run_date.strftime("%Y%m%d")
    patterns = [
        rf"{re.escape(date_hyphen)}[-_](\d{{2}})[-_:](\d{{2}})",
        rf"{re.escape(date_compact)}[-_](\d{{2}})[-_:](\d{{2}})",
    ]
    for pattern in patterns:
        match = re.search(pattern, name)
        if not match:
            continue
        try:
            hh = int(match.group(1))
            mm = int(match.group(2))
            if 0 <= hh <= 23 and 0 <= mm <= 59:
                return (hh * 60) + mm
        except Exception:
            continue
    return None


def intraday_revision_from_filename(path: Path, intraday_dir: Path, run_date: date) -> str:
    match = re.search(r"(?:^|[^a-z0-9])r(\d+)(?:[^a-z0-9]|$)", path.name.lower())
    if match:
        return f"r{int(match.group(1))}"

    files = [candidate for candidate in intraday_dir.glob("*.csv") if candidate.is_file()]
    if not files:
        return "r1"

    keyed = [
        (candidate, intraday_time_rank_key(candidate, run_date), float(candidate.stat().st_mtime), candidate.name)
        for candidate in files
    ]
    with_time = [item for item in keyed if item[1] is not None]
    ordered = (
        sorted(with_time, key=lambda item: (int(item[1]), item[2], item[3]))
        if with_time
        else sorted(keyed, key=lambda item: (item[2], item[3]))
    )

    for idx, item in enumerate(ordered, start=1):
        if item[0].name == path.name:
            return f"r{idx}"
    return "r1"


def intraday_source_key(path: Path, intraday_dir: Path, run_date: date) -> str:
    revision = intraday_revision_from_filename(path, intraday_dir, run_date)
    return f"{run_date.isoformat()}|{revision}|{path.name.lower()}"


def forecast_by_block_from_csv(path: Path | None) -> dict[int, float]:
    if path is None or not path.exists():
        return {}
    try:
        frame = load_enercast_forecast_csv(path)
    except Exception:
        return {}
    if "block" not in frame.columns or "forecast_mw" not in frame.columns:
        return {}
    series = frame.drop_duplicates("block", keep="last").set_index("block")["forecast_mw"]
    out: dict[int, float] = {}
    for key, value in series.to_dict().items():
        try:
            out[int(key)] = float(value)
        except Exception:
            continue
    return out


def pick_da2_reference_file(day_ahead_dir: Path, site_id: str, run_date: date) -> Path | None:
    if not day_ahead_dir.exists():
        return None
    files = [path for path in day_ahead_dir.glob("*.csv") if path.is_file()]
    if not files:
        return None

    patterns: list[str] = []
    try:
        site_config = load_site_config(site_id)
        file_patterns = site_config.get("file_patterns", {}) if isinstance(site_config, dict) else {}
        regex = file_patterns.get("day_ahead_filename_regex") or file_patterns.get("dayahead_filename_regex")
        if isinstance(regex, str) and regex.strip():
            patterns.append(regex.strip())
    except Exception:
        patterns = []

    current = run_date.strftime("%Y-%m-%d")
    previous = (run_date - timedelta(days=1)).strftime("%Y-%m-%d")
    next_day = (run_date + timedelta(days=1)).strftime("%Y-%m-%d")
    compiled: list[re.Pattern[str]] = []
    for pattern in patterns:
        for candidate in (
            pattern.replace("{current_date}", current).replace("{next_date}", next_day),
            pattern.replace("{current_date}", previous).replace("{next_date}", current),
        ):
            try:
                compiled.append(re.compile(candidate, re.IGNORECASE))
            except Exception:
                continue

    candidates: list[Path] = []
    if compiled:
        for path in files:
            if any(regex.match(path.name) for regex in compiled):
                candidates.append(path)
    if not candidates:
        candidates = files

    ordered = sorted(candidates, key=lambda path: path.stat().st_mtime)
    return ordered[-2] if len(ordered) >= 2 else ordered[-1]


def resolve_metered_file(metered_dir: Path, test_date: date, site_id: str) -> Path:
    template = None
    try:
        cfg_local = load_site_config(site_id)
        if isinstance(cfg_local, dict):
            template = cfg_local.get("file_patterns", {}).get("metered_template")
    except Exception:
        template = None
    if template:
        rendered = template.format(
            date_iso=test_date.strftime("%Y-%m-%d"),
            date_yyyymmdd=test_date.strftime("%Y%m%d"),
            date_yyyy_mm_dd=test_date.strftime("%Y_%m_%d"),
            date_ddmmyy=test_date.strftime("%d%m%y"),
            time_hhmmss="000000",
        )
        cfg_file = metered_dir / rendered
        if cfg_file.exists():
            return cfg_file

    primary = metered_dir / f"Date {test_date.strftime('%Y%m%d')}.csv"
    if primary.exists():
        return primary

    alt = metered_dir / f"{test_date.strftime('%Y_%m_%d')}_SOLAR_INV.csv"
    if alt.exists():
        return alt

    prefix = test_date.strftime("%Y_%m_%d")
    candidates = list(metered_dir.glob(f"{prefix}*.csv"))
    if candidates:
        return max(candidates, key=lambda path: path.stat().st_mtime)

    compact = test_date.strftime("%Y%m%d")
    site_token = site_id.strip().lower()
    candidates = list(metered_dir.glob(f"*{site_token}*{compact}*.csv"))
    if candidates:
        return max(candidates, key=lambda path: path.stat().st_mtime)

    raise FileNotFoundError(f"No metered file found for {test_date} in {metered_dir}")


def read_metered_csv(path: Path, site_id: str) -> pd.DataFrame:
    cfg_local = None
    try:
        cfg_local = load_site_config(site_id)
    except Exception:
        cfg_local = None
    delimiter = None
    if isinstance(cfg_local, dict):
        delimiter = cfg_local.get("metered", {}).get("delimiter")

    try:
        if delimiter:
            return pd.read_csv(path, sep=delimiter)
        frame = pd.read_csv(path)
        if len(frame.columns) == 1:
            fallback = pd.read_csv(path, sep=None, engine="python")
            if len(fallback.columns) > 1:
                return fallback
        return frame
    except pd.errors.ParserError:
        return pd.read_csv(path, sep=None, engine="python")


def resolve_column(frame: pd.DataFrame, candidates: list[str]) -> str | None:
    cols = {column.lower(): column for column in frame.columns}
    for name in candidates:
        key = name.lower()
        if key in cols:
            return cols[key]
    return None


def load_metered_input(
    metered_dir: Path,
    test_date: date,
    site_id: str,
    logger,
) -> tuple[pd.DataFrame, bool, Path | None, dict, str]:
    metered_df = pd.DataFrame(columns=["Timestamp", "metered_mw", "block"])
    metered_data_available = False
    metered_file = None
    try:
        metered_file = resolve_metered_file(metered_dir, test_date, site_id)
        metered_df = read_metered_csv(metered_file, site_id)
        metered_data_available = True
    except Exception as exc:
        logger.warning("Metered data unavailable for %s: %s | entering fallback mode", test_date, exc)

    cfg_metered = {}
    try:
        cfg_local = load_site_config(site_id)
        if isinstance(cfg_local, dict):
            cfg_metered = cfg_local.get("metered", {}) or {}
    except Exception:
        cfg_metered = {}

    timestamp_candidates = [
        cfg_metered.get("timestamp_col"),
        "Timestamp",
        "TimeStamp",
        "DateTime",
        "Datetime",
        "TIME",
    ]
    timestamp_candidates = [candidate for candidate in timestamp_candidates if candidate]
    filename_mode = str(cfg_metered.get("filename_mode", "")).strip().lower()

    if metered_data_available and filename_mode == "ftp_snapshot_per_block":
        block_col = resolve_column(metered_df, ["block_no", "block"])
        power_col = resolve_column(metered_df, ["metered_mw", "MW"])
        if block_col is None or power_col is None:
            logger.warning("Normalized metered columns missing in snapshot master file | entering fallback mode")
            metered_data_available = False
        else:
            metered_df["block"] = pd.to_numeric(metered_df[block_col], errors="coerce").astype("Int64")
            metered_df["metered_mw"] = pd.to_numeric(metered_df[power_col], errors="coerce")
            ts_col = resolve_column(metered_df, ["block_end", "Timestamp"])
            if ts_col is not None:
                metered_df["Timestamp"] = pd.to_datetime(metered_df[ts_col], errors="coerce")
            else:
                metered_df["Timestamp"] = pd.NaT
    elif metered_data_available:
        timestamp_col = resolve_column(metered_df, timestamp_candidates)
        if timestamp_col is None:
            logger.warning("Timestamp column missing in metered data | entering fallback mode")
            metered_data_available = False
        else:
            metered_df["Timestamp"] = pd.to_datetime(metered_df[timestamp_col], dayfirst=True)

    power_candidates = [
        cfg_metered.get("power_col"),
        "Active Power-avg MFM-OUT(Meter Power) (kW)",
        "Active Power-Avg MFM-OUT (KW)",
        "Active Power (kW)",
        "Active Power-avg (kW)",
        "Active Power (kw)",
        "MW",
    ]
    power_candidates = [candidate for candidate in power_candidates if candidate]
    power_col = (
        resolve_column(metered_df, power_candidates)
        if metered_data_available and filename_mode != "ftp_snapshot_per_block"
        else None
    )
    if metered_data_available and filename_mode != "ftp_snapshot_per_block" and power_col is None:
        logger.warning("Power column missing in metered data | entering fallback mode")
        metered_data_available = False

    if metered_data_available and filename_mode != "ftp_snapshot_per_block":
        ts_for_block = metered_df["Timestamp"]
        shift_minutes = cfg_metered.get("timestamp_shift_minutes")
        shift_seconds = cfg_metered.get("timestamp_shift_seconds")
        if shift_minutes or shift_seconds:
            delta = pd.Timedelta(
                minutes=float(shift_minutes or 0),
                seconds=float(shift_seconds or 0),
            )
            ts_for_block = ts_for_block + delta

        round_to_15 = cfg_metered.get("round_to_15")
        if round_to_15:
            ts_for_block = (ts_for_block + pd.Timedelta(minutes=7, seconds=30)).dt.floor("15min")

        metered_df["block"] = ts_for_block.apply(
            lambda timestamp: 1 + (timestamp.hour * 60 + timestamp.minute) // 15
        )
        metered_df["block"] = pd.to_numeric(metered_df["block"], errors="coerce").astype("Int64")
        power_unit = str(cfg_metered.get("power_unit", "KW")).strip().upper()
        scale = 1.0 if power_unit in {"MW", "MEGAWATT", "MEGAWATTS"} else 0.001
        metered_df["metered_mw"] = metered_df[power_col] * scale
    elif not metered_data_available:
        metered_df = pd.DataFrame(columns=["Timestamp", "metered_mw", "block"])

    return metered_df, metered_data_available, metered_file, cfg_metered, filename_mode
