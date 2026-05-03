import pandas as pd
import logging
import os
import json
import subprocess
import sys
import warnings
import re
import tempfile
import hashlib
from pathlib import Path
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
try:
    import boto3
except ImportError:
    boto3 = None

try:
    from boto3.dynamodb.conditions import Key
except Exception:
    Key = None

from utils.csv_utils import load_enercast_forecast_csv
from utils.time_utils import block_to_timestamp, timestamp_to_block
from utils.block_schedule_logger import BlockScheduleLogger
from weather.condition3_weather import (
    build_weather_by_block,
    classify_block_weather_state,
    EPS_SMALL_WM2
)
from scheduler.condition3_phase6 import (
    apply_condition3,
    compute_irradiance_state,
    compute_irradiance_multiplier,
    compute_temp_multiplier,
    compute_wind_multiplier
)
from utils.graph_utils import generate_schedule_graph
from utils.site_config_loader import load_site_config

# =============================================================================
# GLOBAL CONSTANTS / THRESHOLDS
# =============================================================================
SITE_ID = os.getenv("SITE_ID", "SIRMOUR").strip().upper()
PLANT_CAPACITY_MW = 5.10
PENALTY_BAND_PCT = 0.10
PENALTY_BAND_MW: float | None = None

START_BLOCK = 1
GEN_END_BLOCK = 96

# Abrupt weather handling
ABRUPT_WINDOW_BLOCKS = 2  # T..T+1 (inclusive)
ABRUPT_FORECAST_OFFSET = 3  # apply adjustments starting T+3
MAX_ABRUPT_ADJ = 0.10

# Forecast weighting

WEIGHT_METER = 0.02
WEIGHT_INTRADAY = 0.98
# Irradiance thresholds / dampening
IRR_FULL_TRUST = 0.40
IRR_ZERO_TRUST = 0.10
LOW_GTI_IRR_RATIO_THRESHOLD = 0.15
LOW_GTI_DAMP_FACTOR = 0.85

# Trend + smoothing
TREND_EPS = 1.5
SMOOTH_ALPHA = 0.30

# Start / acceptance thresholds
START_THRESHOLD = 0.12
ACCEPTANCE_MW = 0.30
METER_START_THRESHOLD_MW = float(os.getenv("METER_START_THRESHOLD_MW", START_THRESHOLD))

# Ramp control (sunrise)
RAMP_CAP_FACTOR = 1.30
RAMP_RAMP_MULT = 1.20
RAMP_ENABLE_IRR_RATIO = 0.20

# Paths / timezone
DATA_ROOT = Path(os.getenv("DATA_ROOT", f"data/{SITE_ID}"))
OUTPUT_ROOT = Path(os.getenv("OUTPUT_ROOT", f"outputs/{SITE_ID}"))
LOG_ROOT = Path(os.getenv("LOG_ROOT", f"logs/{SITE_ID}"))
COMBINED_ROOT = Path(os.getenv("COMBINED_ROOT", f"Combined/{SITE_ID}"))
IST = ZoneInfo("Asia/Kolkata")


# Slot-based submission policy
WINDOW_SIZE_BLOCKS = 6  # 1.5-hour slots
IMPORTANCE_PCT_THRESHOLD = 0.05
LOCK_DURATION = 3
CATEGORY_PRIORITY = {
    "plant_status_change": 3,
    "abrupt_weather": 2,
    "dynamic_start": 1,
    "curtailment": 3,
    "shutdown": 3,
    "normal": 1,
}
DA_SUBMISSION_BLOCK = 23
HIGH_PRIORITY_TRIGGERS = {
    "plant_status_initial",
    "plant_status_change",
    "whatsapp_out_of_band_adjustment",
    "curtailment",
    "shutdown",
}

# Engine states
STATE_WAITING_FOR_DYNAMIC_START = "STATE_WAITING_FOR_DYNAMIC_START"
STATE_ACTIVE_SCHEDULE_RUNNING = "STATE_ACTIVE_SCHEDULE_RUNNING"

# Logging paths
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", Path.cwd()))
ENGINE_LOG_PATH = LOG_ROOT / "engine.log"

# Runtime overrides
CUSTOM_START_BLOCK = os.getenv("CUSTOM_START_BLOCK")
CUSTOM_START_BLOCK = int(CUSTOM_START_BLOCK) if CUSTOM_START_BLOCK else None
ENGINE_BLOCK_OVERRIDE = os.getenv("ENGINE_BLOCK_OVERRIDE")
ENGINE_BLOCK_OVERRIDE = int(ENGINE_BLOCK_OVERRIDE) if ENGINE_BLOCK_OVERRIDE else None
ENGINE_NOW_IST = os.getenv("ENGINE_NOW_IST")
CUSTOM_DATA_DATE = os.getenv("DATA_DATE")  # YYYY-MM-DD to force data root
CUSTOM_OUTPUT_BASE = os.getenv("CUSTOM_OUTPUT_BASE")
CUSTOM_OUTPUT_BASE = Path(CUSTOM_OUTPUT_BASE) if CUSTOM_OUTPUT_BASE else None

# DynamoDB control state
DDB_TABLE = os.getenv("DDB_TABLE")
CONTROL_STATE_TABLE = os.getenv("CONTROL_STATE_TABLE", DDB_TABLE)
CONTROL_WINDOWS_TABLE = os.getenv("CONTROL_WINDOWS_TABLE")
PLANT_ID = os.getenv("PLANT_ID", "vedanjay")


def _apply_site_overrides() -> None:
    global START_BLOCK, GEN_END_BLOCK, ABRUPT_WINDOW_BLOCKS, MAX_ABRUPT_ADJ
    global WEIGHT_METER, WEIGHT_INTRADAY, IRR_FULL_TRUST, IRR_ZERO_TRUST
    global LOW_GTI_IRR_RATIO_THRESHOLD, LOW_GTI_DAMP_FACTOR, TREND_EPS, SMOOTH_ALPHA
    global START_THRESHOLD, ACCEPTANCE_MW, RAMP_CAP_FACTOR, RAMP_RAMP_MULT
    global RAMP_ENABLE_IRR_RATIO, PLANT_CAPACITY_MW, PENALTY_BAND_PCT, PENALTY_BAND_MW

    try:
        site_cfg = load_site_config(SITE_ID)
    except Exception as exc:
        logging.getLogger(__name__).warning(
            "Site config load failed for SITE_ID=%s; using in-code defaults (%s)",
            SITE_ID,
            exc,
        )
        return

    sched = site_cfg.get("scheduling_parameters", {})
    START_BLOCK = int(sched.get("start_block", START_BLOCK))
    GEN_END_BLOCK = int(sched.get("gen_end_block", GEN_END_BLOCK))
    ABRUPT_WINDOW_BLOCKS = int(sched.get("abrupt_window_blocks", ABRUPT_WINDOW_BLOCKS))
    MAX_ABRUPT_ADJ = float(sched.get("max_abrupt_adj", MAX_ABRUPT_ADJ))
    WEIGHT_METER = float(sched.get("weight_meter", WEIGHT_METER))
    WEIGHT_INTRADAY = float(sched.get("weight_intraday", WEIGHT_INTRADAY))
    IRR_FULL_TRUST = float(sched.get("irr_full_trust", IRR_FULL_TRUST))
    IRR_ZERO_TRUST = float(sched.get("irr_zero_trust", IRR_ZERO_TRUST))
    LOW_GTI_IRR_RATIO_THRESHOLD = float(sched.get("low_gti_irr_ratio_threshold", LOW_GTI_IRR_RATIO_THRESHOLD))
    LOW_GTI_DAMP_FACTOR = float(sched.get("low_gti_damp_factor", LOW_GTI_DAMP_FACTOR))
    TREND_EPS = float(sched.get("trend_eps", TREND_EPS))
    SMOOTH_ALPHA = float(sched.get("smooth_alpha", SMOOTH_ALPHA))
    START_THRESHOLD = float(sched.get("start_threshold", START_THRESHOLD))
    ACCEPTANCE_MW = float(sched.get("acceptance_mw", ACCEPTANCE_MW))
    RAMP_CAP_FACTOR = float(sched.get("ramp_cap_factor", RAMP_CAP_FACTOR))
    RAMP_RAMP_MULT = float(sched.get("ramp_ramp_mult", RAMP_RAMP_MULT))
    RAMP_ENABLE_IRR_RATIO = float(sched.get("ramp_enable_irr_ratio", RAMP_ENABLE_IRR_RATIO))
    PLANT_CAPACITY_MW = float(site_cfg.get("plant_capacity_mw", PLANT_CAPACITY_MW))
    PENALTY_BAND_PCT = float(site_cfg.get("penalty_band_pct", PENALTY_BAND_PCT))
    PENALTY_BAND_MW = (
        float(site_cfg["penalty_band_mw"])
        if site_cfg.get("penalty_band_mw") is not None
        else None
    )


_apply_site_overrides()


def _penalty_band_mw() -> float:
    if PENALTY_BAND_MW is not None:
        return float(PENALTY_BAND_MW)
    band_frac = PENALTY_BAND_PCT / 100.0 if PENALTY_BAND_PCT > 1.0 else PENALTY_BAND_PCT
    return float(PLANT_CAPACITY_MW) * float(band_frac)


def _compute_importance(new_sched_df: pd.DataFrame, prev_df: pd.DataFrame | None) -> str:
    if prev_df is None or prev_df.empty:
        return "HIGH"
    if "block" not in prev_df.columns or "algo_schedule_mw" not in prev_df.columns:
        return "HIGH"
    if "block" not in new_sched_df.columns or "algo_schedule_mw" not in new_sched_df.columns:
        return "HIGH"
    merged = new_sched_df[["block", "algo_schedule_mw"]].merge(
        prev_df[["block", "algo_schedule_mw"]],
        on="block",
        how="left",
        suffixes=("_new", "_prev"),
    )
    diffs = (merged["algo_schedule_mw_new"] - merged["algo_schedule_mw_prev"]).abs()
    denom = merged["algo_schedule_mw_prev"].abs().replace(0, 1.0)
    pct_change = diffs / denom
    max_pct = float(pct_change.max()) if not pct_change.empty else 0.0
    return "HIGH" if max_pct >= IMPORTANCE_PCT_THRESHOLD else "LOW"

# =============================================================================
# DATE PARSER
# =============================================================================
def _normalize_enercast_date(date_str: str) -> date:
    cleaned = date_str.strip()
    if len(cleaned) == 8 and cleaned.isdigit():
        return datetime.strptime(cleaned, "%Y%m%d").date()
    return datetime.strptime(cleaned, "%Y-%m-%d").date()


def _date_from_enercast_csv(path: str) -> date:
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        for _ in range(8):
            line = f.readline().strip()
            if not line:
                continue
            upper = line.upper()
            if upper.startswith("DATE") or upper.startswith("FOR DATE"):
                parts = line.split(",")
                if len(parts) > 1:
                    return _normalize_enercast_date(parts[1])

    # Fallback 1: parse date from filename
    name = p.name
    m = re.search(r"(\d{4}-\d{2}-\d{2})", name)
    if m:
        return datetime.strptime(m.group(1), "%Y-%m-%d").date()
    m = re.search(r"(\d{8})", name)
    if m:
        return datetime.strptime(m.group(1), "%Y%m%d").date()

    # Fallback 2: DATA_DATE env (custom mode sets this)
    env_date = os.getenv("DATA_DATE")
    if env_date:
        try:
            return datetime.strptime(env_date.strip(), "%Y-%m-%d").date()
        except Exception:
            pass

    raise ValueError(f"DATE metadata not found and no date in filename: {name}")


def _latest_file_in_dir(dir_path: Path) -> Path | None:
    if not dir_path.exists():
        return None
    files = [p for p in dir_path.glob("*.csv") if p.is_file()]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _pick_latest_intraday_source(intraday_dir: Path, site_id: str, run_date_str: str) -> tuple[Path, str]:
    latest = _latest_file_in_dir(intraday_dir)
    if latest is None:
        raise FileNotFoundError(f"No intraday Enercast file found in {intraday_dir}")
    return latest, "latest_mtime"


def _pick_latest_day_ahead_source(day_ahead_dir: Path) -> Path:
    latest = _latest_file_in_dir(day_ahead_dir)
    if latest is None:
        raise FileNotFoundError(f"No day-ahead Enercast file found in {day_ahead_dir}")
    return latest


def _resolve_day_ahead_source_file(
    site_id: str,
    day_ahead_dir: Path,
    current_run_date: str,
    next_date: date,
) -> Path:
    """
    Resolve a day-ahead source file for next_date.
    Prefer DA1 over DA0 when multiple revisions exist; otherwise pick latest mtime.
    """
    if not day_ahead_dir.exists():
        raise FileNotFoundError(f"Day-ahead directory not found: {day_ahead_dir}")
    candidates = [p for p in day_ahead_dir.glob("*.csv") if p.is_file()]
    if not candidates:
        raise FileNotFoundError(f"No day-ahead CSV files in {day_ahead_dir}")

    next_date_str = next_date.strftime("%Y-%m-%d")
    matching = []
    for p in candidates:
        name = p.name
        if next_date_str in name:
            matching.append(p)
            continue
        try:
            if _date_from_enercast_csv(p) == next_date:
                matching.append(p)
        except Exception:
            continue

    pool = matching if matching else candidates

    def _revision_rank(p: Path) -> int:
        upper = p.name.upper()
        if "DA1" in upper:
            return 2
        if "DA0" in upper:
            return 1
        return 0

    # Prefer highest DA revision, then newest mtime.
    return max(pool, key=lambda p: (_revision_rank(p), p.stat().st_mtime))


def _list_data_date_dirs(data_root: Path) -> list[Path]:
    if not data_root.exists():
        return []
    out = []
    for p in data_root.iterdir():
        if not p.is_dir():
            continue
        try:
            datetime.strptime(p.name, "%Y-%m-%d")
        except ValueError:
            continue
        out.append(p)
    return sorted(out, key=lambda p: p.name)


def _pick_data_root_for_run_date(run_date: date) -> Path:
    preferred = DATA_ROOT / run_date.strftime("%Y-%m-%d")
    preferred_intraday = _latest_file_in_dir(preferred / "enercast_data" / "intraday")
    preferred_dayahead = _latest_file_in_dir(preferred / "enercast_data" / "day_ahead")
    if preferred_intraday is not None and preferred_dayahead is not None:
        return preferred

    candidates = _list_data_date_dirs(DATA_ROOT)
    for cand in reversed(candidates):
        intraday = _latest_file_in_dir(cand / "enercast_data" / "intraday")
        dayahead = _latest_file_in_dir(cand / "enercast_data" / "day_ahead")
        if intraday is not None and dayahead is not None:
            logger.warning(
                "No complete local data for run date %s; falling back to latest available date %s",
                run_date.strftime("%Y-%m-%d"),
                cand.name,
            )
            return cand

    raise FileNotFoundError(
        f"No local data with both intraday/day-ahead found under {DATA_ROOT}"
    )


def _load_openmeteo_current(path: Path):
    if not path.exists():
        logger.warning("Current weather file not found: %s (continuing without current snapshot)", path)
        return None, None
    try:
        df = pd.read_csv(path)
    except pd.errors.ParserError:
        df = pd.read_csv(path, on_bad_lines="skip")
    if df.empty:
        raise ValueError(f"Current weather file empty: {path}")
    latest = df.iloc[-1].to_dict()
    prev = df.iloc[-2].to_dict() if len(df) >= 2 else None

    for key in ("temperature_2m", "wind_speed_10m", "cloud_cover"):
        if key in latest and pd.notna(latest[key]):
            latest[key] = float(latest[key])
        if prev is not None and key in prev and pd.notna(prev[key]):
            prev[key] = float(prev[key])
    return latest, prev


def _latest_schedule_file(output_day: Path) -> Path | None:
    if not output_day.exists():
        return None
    files = list(output_day.glob("schedule_from_*.csv"))
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _latest_weather_file(weather_dir: Path, prefix: str) -> Path | None:
    if not weather_dir.exists():
        return None
    files = [p for p in weather_dir.glob(f"{prefix}_*.csv") if p.is_file()]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _extract_date_from_weather_filename(path: Path, prefix: str) -> str | None:
    name = path.name
    if not name.startswith(f"{prefix}_") or not name.endswith(".csv"):
        return None
    return name[len(prefix) + 1 : -4]


def _load_state(state_path: Path) -> dict:
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(state_path: Path, state: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, indent=2)
    fd, tmp_path = tempfile.mkstemp(
        prefix=f".{state_path.name}.",
        suffix=".tmp",
        dir=str(state_path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, state_path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


def _remove_legacy_schedule_json(output_dir: Path) -> None:
    if not output_dir.exists():
        return
    for stale_json in output_dir.glob("schedule_from_*.json"):
        try:
            stale_json.unlink()
            logger.info("Removed legacy schedule JSON: %s", _rel_path(stale_json))
        except Exception:
            logger.warning("Failed to remove legacy schedule JSON: %s", _rel_path(stale_json))


def _run_fetcher_once() -> None:
    fetcher = Path("Data loader") / "Fetchdata.py"
    if not fetcher.exists():
        raise FileNotFoundError(f"Fetcher not found: {fetcher}")
    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    try:
        subprocess.run([sys.executable, str(fetcher)], check=True, env=env)
    except subprocess.CalledProcessError as exc:
        logger.warning(f"Fetcher failed ({exc}); proceeding with existing local data.")

# =============================================================================
# LOGGING
# =============================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)


def _append_engine_log_day_separator(log_path: Path) -> None:
    if not log_path.exists():
        return
    try:
        size = log_path.stat().st_size
        if size <= 0:
            return
        read_size = min(size, 8192)
        with log_path.open("rb") as f:
            f.seek(-read_size, os.SEEK_END)
            tail = f.read().decode("utf-8", errors="ignore")
        lines = [ln for ln in tail.splitlines() if ln.strip()]
        if not lines:
            return
        last_line = lines[-1]
        m = re.match(r"^(\d{4}-\d{2}-\d{2})\s", last_line)
        if not m:
            return
        last_date = m.group(1)
        today_ist = datetime.now(IST).strftime("%Y-%m-%d")
        if last_date != today_ist:
            with log_path.open("a", encoding="utf-8") as f:
                if not tail.endswith("\n"):
                    f.write("\n")
                f.write("\n")
    except Exception:
        pass


def _configure_engine_logger() -> logging.Logger:
    logger = logging.getLogger("phase7_engine")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(formatter)

    ENGINE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _append_engine_log_day_separator(ENGINE_LOG_PATH)
    file_handler = logging.FileHandler(ENGINE_LOG_PATH, encoding="utf-8")
    file_handler.setFormatter(formatter)

    logger.addHandler(console)
    logger.addHandler(file_handler)
    logger.propagate = False
    return logger


logger = _configure_engine_logger()
logger.info("===== CONDITION-3 PHASE-6 ENGINE STARTED =====")


def _rel_path(path: str | Path) -> str:
    try:
        return os.path.relpath(str(path), ROOT_DIR)
    except Exception:
        return str(path)


def _showwarning(message, category, filename, lineno, file=None, line=None):
    logger.warning("Warning %s at %s:%s: %s", category.__name__, _rel_path(filename), lineno, message)


warnings.showwarning = _showwarning
def _exit(reason: str) -> None:
    discard_reason_map = {
        "invalid_block": "Out-of-range block input; scheduling safely skipped",
        "lock_window": "Submission skipped because lock window is active",
        "low_priority_exit": "Low importance path only flagged slot_low_flag; no submission",
        "slot_already_used_no_submit": "Submission skipped because slot already consumed",
        "defer_high_to_next_slot": "High event deferred to next slot start because slot already consumed",
        "no_trigger": "No trigger fired; no scheduling action taken",
        "state_mismatch_reset": "State mismatch reset; submission skipped for safety",
    }
    if reason in discard_reason_map:
        logger.info("DISCARD_REASON=%s", discard_reason_map[reason])
    logger.info("EXIT_REASON=%s", reason)
    raise SystemExit(0)


class _BufferedScheduleLog:
    """Collect schedule log lines and persist only when a submission is accepted."""

    def __init__(self) -> None:
        self._lines: list[str] = []

    def info(self, msg: str, *args) -> None:
        try:
            rendered = msg % args if args else msg
        except Exception:
            rendered = f"{msg} {' '.join(str(a) for a in args)}"
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._lines.append(f"{ts} | INFO | {rendered}")

    def dump_to_file(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = ("\n".join(self._lines) + "\n") if self._lines else ""
        path.write_text(text, encoding="utf-8")

# =============================================================================
# HELPERS
# =============================================================================
def clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(val, hi))


def _normalize_status(status: str | None) -> str:
    if not status:
        return "NORMAL"
    status = str(status).strip().upper()
    if status in {"NORMAL", "SHUTDOWN", "CURTAILMENT"}:
        return status
    return "NORMAL"


def _category_priority(trigger: str | None) -> int:
    key = (trigger or "").strip().lower()
    return int(CATEGORY_PRIORITY.get(key, 0))


def _update_high_flag(state: dict, trigger: str | None, engine_block: int) -> None:
    if not trigger:
        return
    new_pri = _category_priority(trigger)
    prev = state.get("high_event") or {}
    prev_pri = _category_priority(prev.get("category"))
    if not state.get("high_flag") or new_pri >= prev_pri:
        state["high_flag"] = True
        state["high_event"] = {
            "category": (trigger or "").strip().lower(),
            "sub_type": (trigger or "").strip().lower(),
            "timestamp": int(engine_block),
        }


def _importance_for_trigger(trigger: str, abrupt_info: dict, plant_status: str) -> str:
    context = {
        "current_block": int(abrupt_info.get("current_block", 0) or 0),
        "abrupt_metrics": abrupt_info.get("abrupt_metrics", {}) if isinstance(abrupt_info, dict) else {},
    }
    return _determine_importance(trigger, context, plant_status)


def _normalize_trigger_for_importance(trigger: str, plant_status: str) -> str:
    t = (trigger or "").strip().lower()
    if t in {"curtailment", "shutdown", "normal", "dynamic_start", "custom_start", "abrupt_weather"}:
        return t
    if t in {"plant_status_change", "plant_status_initial"}:
        return _normalize_status(plant_status).lower()
    return t


def _determine_importance(trigger: str, context: dict, plant_status: str) -> str:
    t = _normalize_trigger_for_importance(trigger, plant_status)
    if t in {"curtailment", "shutdown", "normal", "dynamic_start", "custom_start"}:
        return "HIGH"
    if t == "abrupt_weather":
        try:
            abrupt_metrics = (context or {}).get("abrupt_metrics", {}) or {}
            start_block = int(abrupt_metrics.get("start_block"))
            horizon_blocks = int(abrupt_metrics.get("horizon_blocks"))
            cloud_by_block = abrupt_metrics.get("cloud_dev_by_block", {}) or {}
            shift_by_block = abrupt_metrics.get("shift_ratio_by_block", {}) or {}
            if horizon_blocks <= 0:
                return "LOW"
            combined_scores: list[float] = []
            for b in range(start_block, start_block + horizon_blocks):
                if b not in cloud_by_block or b not in shift_by_block:
                    continue
                cloud_dev = float(cloud_by_block.get(b, 0.0) or 0.0)
                shift_ratio = float(shift_by_block.get(b, 0.0) or 0.0)
                combined_scores.append(0.6 * abs(cloud_dev) + 0.4 * abs(shift_ratio))
            if not combined_scores:
                return "LOW"
            return "HIGH" if max(combined_scores) >= 0.12 else "LOW"
        except Exception:
            return "LOW"
    return "LOW"


def _abrupt_max_combined_from_context(context: dict) -> float | None:
    try:
        abrupt_metrics = (context or {}).get("abrupt_metrics", {}) or {}
        start_block = int(abrupt_metrics.get("start_block"))
        horizon_blocks = int(abrupt_metrics.get("horizon_blocks"))
        cloud_by_block = abrupt_metrics.get("cloud_dev_by_block", {}) or {}
        shift_by_block = abrupt_metrics.get("shift_ratio_by_block", {}) or {}
        combined_scores: list[float] = []
        for b in range(start_block, start_block + max(0, horizon_blocks)):
            if b not in cloud_by_block or b not in shift_by_block:
                continue
            cloud_dev = float(cloud_by_block.get(b, 0.0) or 0.0)
            shift_ratio = float(shift_by_block.get(b, 0.0) or 0.0)
            combined_scores.append(0.6 * abs(cloud_dev) + 0.4 * abs(shift_ratio))
        if not combined_scores:
            return None
        return float(max(combined_scores))
    except Exception:
        return None


def _importance_detail(trigger: str, context: dict, plant_status: str, importance: str) -> str:
    t = _normalize_trigger_for_importance(trigger, plant_status)
    if t == "abrupt_weather":
        max_combined = _abrupt_max_combined_from_context(context)
        if max_combined is None:
            return "abrupt metrics unavailable/failure; forced LOW"
        return f"abrupt combined_intensity={max_combined:.6f} threshold=0.12 -> {importance}"
    if t in {"curtailment", "shutdown", "normal"}:
        return f"{t} follows always-HIGH business rule"
    if t == "dynamic_start":
        return "dynamic_start follows always-HIGH business rule"
    if t == "custom_start":
        return "custom_start follows always-HIGH custom-run rule"
    return f"{t} falls through default LOW rule"


def _build_engine_context(
    engine_block: int,
    weather_by_block: dict,
    current_weather_now: dict | None,
    current_weather_prev: dict | None,
    max_gti_today: float,
) -> dict:
    start_block = int(engine_block + ABRUPT_FORECAST_OFFSET)
    horizon_blocks = 4
    cloud_dev_by_block: dict[int, float] = {}
    shift_ratio_by_block: dict[int, float] = {}
    end_block = min(GEN_END_BLOCK, start_block + horizon_blocks - 1)
    for b in range(start_block, end_block + 1):
        try:
            info = classify_block_weather_state(
                b,
                weather_by_block,
                current_now=current_weather_now,
                current_prev=current_weather_prev,
                max_block=GEN_END_BLOCK,
                eps_small=EPS_SMALL_WM2,
                max_gti_today=max_gti_today,
                return_details=True,
            )
        except Exception:
            continue
        cloud_dev_by_block[b] = float(info.get("cloud_dev", 0.0) or 0.0)
        shift_ratio_by_block[b] = float(info.get("shift_ratio", 0.0) or 0.0)
    return {
        "current_block": int(engine_block),
        "abrupt_metrics": {
            "start_block": start_block,
            "horizon_blocks": horizon_blocks,
            "cloud_dev_by_block": cloud_dev_by_block,
            "shift_ratio_by_block": shift_ratio_by_block,
        },
    }


def _submit_to_sldc(schedule_payload: dict) -> bool:
    try:
        from utils.sldc_submit import submit_to_sldc as adapter  # type: ignore

        return bool(adapter(schedule_payload))
    except Exception as exc:
        logger.warning("submit_to_sldc adapter not available; skipping submit (%s)", exc)
        return True


def _submit_to_sldc_day_ahead(da_csv_path: Path, next_date: date) -> bool:
    try:
        df = pd.read_csv(da_csv_path)
        for col in ("timestamp", "start_time", "end_time"):
            if col in df.columns:
                df[col] = df[col].astype(str)
        payload = {
            "date": next_date.strftime("%Y-%m-%d"),
            "schedule": df.to_dict(orient="records"),
        }
        return _submit_to_sldc(payload)
    except Exception as exc:
        logger.warning("submit_to_sldc_day_ahead failed; skipping submit (%s)", exc)
        return True


def _normalize_control_site(site: str | None) -> str:
    cleaned = str(site or "").strip().upper()
    return cleaned or "ALL"


def _control_state_get_item(ddb, site_id: str) -> dict | None:
    desc = ddb.describe_table(TableName=CONTROL_STATE_TABLE)
    key_schema = desc.get("Table", {}).get("KeySchema", []) or []
    key_names = {str(k.get("AttributeName")) for k in key_schema if k.get("AttributeName")}

    if "site" in key_names:
        site_token = _normalize_control_site(site_id)
        keys_to_try = [
            {"plant_id": {"S": PLANT_ID}, "site": {"S": site_token}},
            {"plant_id": {"S": PLANT_ID}, "site": {"S": "ALL"}},
        ]
        for key in keys_to_try:
            resp = ddb.get_item(TableName=CONTROL_STATE_TABLE, Key=key, ConsistentRead=True)
            item = resp.get("Item")
            if item:
                return item
        return None

    resp = ddb.get_item(
        TableName=CONTROL_STATE_TABLE,
        Key={"plant_id": {"S": PLANT_ID}},
        ConsistentRead=True,
    )
    return resp.get("Item")

def _load_control_state(site_id: str) -> dict:
    """
    Load plant control state from DynamoDB.
    Supports both key schemas:
      1) plant_id (legacy, plant-level)
      2) plant_id + site (site-level)
    Returns: {plant_status, curtailment_capacity, source}
    """
    if not CONTROL_STATE_TABLE:
        return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "env_missing"}
    if boto3 is None:
        logger.warning("boto3 is not installed; skipping DynamoDB control state load")
        return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "boto3_missing"}

    try:
        ddb = boto3.client("dynamodb")
        item = _control_state_get_item(ddb, site_id=site_id)
        if not item:
            return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "ddb_empty"}

        status = _normalize_status(item.get("plant_status", {}).get("S"))
        cap_raw = item.get("curtailment_capacity", {}).get("N")
        cap = float(cap_raw) if cap_raw is not None else None
        return {"plant_status": status, "curtailment_capacity": cap, "source": "ddb"}
    except Exception:
        logger.exception("Failed to load control state from DynamoDB")
        return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "ddb_error"}


def _load_control_windows() -> list[dict]:
    """
    Load planned control windows for the current plant.
    Expected schema:
      - partition key: plant_id
      - sort key: window_id
    """
    if not CONTROL_WINDOWS_TABLE:
        return []
    if boto3 is None:
        logger.warning("boto3 is not installed; skipping control windows load")
        return []

    try:
        ddb = boto3.client("dynamodb")
        if Key is None:
            logger.warning("boto3 Key condition helper missing; skipping control windows load")
            return []
        resp = ddb.query(
            TableName=CONTROL_WINDOWS_TABLE,
            KeyConditionExpression="#pk = :pk",
            ExpressionAttributeNames={"#pk": "plant_id"},
            ExpressionAttributeValues={":pk": {"S": PLANT_ID}},
            ConsistentRead=True,
        )
        items = resp.get("Items", []) or []
        windows: list[dict] = []
        for item in items:
            status = _normalize_status(item.get("plant_status", {}).get("S"))
            start_raw = item.get("start_time", {}).get("S")
            end_raw = item.get("end_time", {}).get("S")
            if not start_raw or not end_raw:
                continue
            try:
                start_dt = datetime.fromisoformat(str(start_raw))
                end_dt = datetime.fromisoformat(str(end_raw))
            except Exception:
                logger.warning(
                    "Skipping invalid control window for plant_id=%s start=%s end=%s",
                    PLANT_ID,
                    start_raw,
                    end_raw,
                )
                continue
            cap_raw = item.get("curtailment_capacity", {}).get("N")
            cap = float(cap_raw) if cap_raw is not None else None
            windows.append(
                {
                    "window_id": item.get("window_id", {}).get("S"),
                    "plant_status": status,
                    "curtailment_capacity": cap,
                    "start_time": start_dt,
                    "end_time": end_dt,
                    "site": item.get("site", {}).get("S"),
                    "source": "ddb",
                }
            )
        return windows
    except Exception:
        logger.exception("Failed to load control windows from DynamoDB")
        return []


def _block_timestamp_for_date(day: date, block: int) -> datetime:
    return block_to_timestamp(day, block)


def _planned_window_for_block(
    block_start: datetime,
    block_end: datetime,
    windows: list[dict],
    site_id: str,
) -> tuple[str, float | None]:
    planned_status = "NORMAL"
    planned_cap = None
    site_token = _normalize_control_site(site_id)

    for window in windows:
        start_dt = window.get("start_time")
        end_dt = window.get("end_time")
        if start_dt is None or end_dt is None:
            continue
        if block_start >= end_dt or block_end <= start_dt:
            continue

        window_site = str(window.get("site") or "").strip().upper()
        if window_site and window_site not in {"ALL", site_token}:
            continue

        status = _normalize_status(window.get("plant_status"))
        if status == "SHUTDOWN":
            planned_status = "SHUTDOWN"
            planned_cap = None
        elif status == "CURTAILMENT" and planned_status != "SHUTDOWN":
            cap = window.get("curtailment_capacity")
            if planned_cap is None:
                planned_cap = cap
            elif cap is not None:
                planned_cap = min(float(planned_cap), float(cap))
            planned_status = "CURTAILMENT"

    return planned_status, planned_cap


def _resolve_block_control(
    block_start: datetime,
    live_status: str,
    live_curtailment_capacity: float | None,
    planned_windows: list[dict],
    site_id: str,
) -> tuple[str, float | None]:
    status = _normalize_status(live_status)
    if status == "SHUTDOWN":
        return "SHUTDOWN", None
    if status == "CURTAILMENT":
        return "CURTAILMENT", live_curtailment_capacity

    block_end = block_start + timedelta(minutes=15)
    planned_status, planned_cap = _planned_window_for_block(block_start, block_end, planned_windows, site_id)
    if planned_status == "SHUTDOWN":
        return "SHUTDOWN", None
    if planned_status == "CURTAILMENT":
        return "CURTAILMENT", planned_cap
    return "NORMAL", None


def _apply_control_overrides(value: float, plant_status: str, curtailment_capacity: float | None) -> tuple[float, str | None]:
    if plant_status == "SHUTDOWN":
        return 0.0, "SHUTDOWN"
    if plant_status == "CURTAILMENT" and curtailment_capacity is not None:
        return min(value, curtailment_capacity), "CURTAILMENT"
    return value, None


def _derive_schedule_reason(source: str | None, plant_status: str) -> str:
    status = _normalize_status(plant_status)
    src = (source or "").strip().lower()


    if src == "abrupt_weather":
        if status == "CURTAILMENT":
            return "curtailment_abrupt_weather_change"
        if status == "SHUTDOWN":
            return "shutdown_abrupt_weather_change"
        return "abrupt_weather_change"

    if src == "dynamic_start":
        if status == "CURTAILMENT":
            return "curtailment_dynamic_start"
        if status == "SHUTDOWN":
            return "shutdown_dynamic_start"
        return "dynamic_start"

    if src == "plant_status_change":
        if status == "NORMAL":
            return "plant_status_normal"
        if status == "CURTAILMENT":
            return "plant_status_curtailment"
        if status == "SHUTDOWN":
            return "plant_status_shutdown"
        return "plant_status_change"

    if src == "plant_status_initial":
        if status == "CURTAILMENT":
            return "curtailment"
        if status == "SHUTDOWN":
            return "shutdown"
        return "plant_status_initial"

    return source or "unknown"


def compute_recent_avg_boundary(
    metered_by_block: pd.Series,
    engine_block: int,
) -> float:
    meter_t_minus_1 = metered_by_block.get(engine_block - 1)
    meter_t_minus_2 = metered_by_block.get(engine_block - 2)
    boundary_vals: list[float] = []

    if pd.notna(meter_t_minus_1):
        boundary_vals.append(float(meter_t_minus_1))
    if pd.notna(meter_t_minus_2):
        boundary_vals.append(float(meter_t_minus_2))

    if len(boundary_vals) == 2:
        return sum(boundary_vals) / 2.0
    if len(boundary_vals) == 1:
        return boundary_vals[0]
    return float("nan")


def compute_ramp_cap(
    block: int,
    engine_block: int,
    metered_by_block: pd.Series,
    irr_ratio: float,
) -> tuple[float | None, str | None]:
    """
    Compute max allowed schedule for a block based on recent metered ramp.
    Returns (cap_value, reason) or (None, None) when not applicable.
    """
    if irr_ratio >= RAMP_ENABLE_IRR_RATIO:
        return None, None

    last_block = min(block - 1, engine_block)
    prev_block = min(block - 2, engine_block - 1)
    last_meter = metered_by_block.get(last_block)
    prev_meter = metered_by_block.get(prev_block)

    if pd.isna(last_meter):
        return None, None

    last_meter = float(last_meter)
    cap = None
    reason = None

    if pd.notna(prev_meter):
        prev_meter = float(prev_meter)
        recent_ramp = last_meter - prev_meter
        if recent_ramp > 0:
            cap = last_meter + (recent_ramp * RAMP_RAMP_MULT)
            reason = f"dynamic_ramp last={last_meter:.3f} prev={prev_meter:.3f} ramp={recent_ramp:.3f} mult={RAMP_RAMP_MULT:.2f}"

    if cap is None:
        cap = last_meter * RAMP_CAP_FACTOR
        reason = f"fixed_ramp last={last_meter:.3f} factor={RAMP_CAP_FACTOR:.2f}"

    return cap, reason


def _build_day_ahead_schedule(
    next_date: date,
    df_dayahead: pd.DataFrame,
    plant_status: str,
    curtailment_capacity: float | None,
    planned_windows: list[dict],
) -> pd.DataFrame:
    by_block = (
        df_dayahead.drop_duplicates("block", keep="last")
        .set_index("block")["forecast_mw"]
        .to_dict()
    )
    rows = []
    for b in range(START_BLOCK, GEN_END_BLOCK + 1):
        forecast = float(by_block.get(b, 0.0) or 0.0)
        block_start_ts = block_to_timestamp(next_date, b)
        block_status, block_cap = _resolve_block_control(
            block_start_ts,
            live_status=plant_status,
            live_curtailment_capacity=curtailment_capacity,
            planned_windows=planned_windows,
            site_id=SITE_ID,
        )
        if block_status == "SHUTDOWN":
            algo = 0.0
        elif block_status == "CURTAILMENT" and block_cap is not None:
            scale = float(block_cap) / float(PLANT_CAPACITY_MW) if float(PLANT_CAPACITY_MW) > 0 else 1.0
            algo = min(forecast * scale, float(block_cap))
        else:
            algo, _ = _apply_control_overrides(
                forecast, plant_status=plant_status, curtailment_capacity=curtailment_capacity
            )
        block_end_ts = (
            pd.to_datetime(block_start_ts) + pd.Timedelta(minutes=15)
        ).strftime("%Y-%m-%d %H:%M:%S")

        # --- Control priority enforcement (must be last) ---
        if block_status == "SHUTDOWN":
            algo = 0.0
        elif block_status == "CURTAILMENT" and block_cap is not None:
            algo = min(algo, float(block_cap))
        if algo < 0.0:
            algo = 0.0

        rows.append(
            {
                "block": b,
                "timestamp": block_start_ts,
                "start_time": block_start_ts,
                "end_time": block_end_ts,
                "algo_schedule_mw": round(algo, 3),
                "condition_used": "DAY_AHEAD",
                "BaseForecast": round(forecast, 3),
                "EffectiveBaseForecast": round(algo, 3),
                "IntradayForecast_mw": round(forecast, 3),
            }
        )
    return pd.DataFrame(rows)


def _current_block_key_ist(now_ist: datetime) -> str:
    floored = now_ist.replace(
        minute=(now_ist.minute // 15) * 15,
        second=0,
        microsecond=0
    )
    return floored.isoformat()



def create_schedule(state: dict, source: str, current_block_key: str, dynamic_start_block: int) -> bool:
    if state.get("last_schedule_block_timestamp") == current_block_key:
        logger.info("Duplicate schedule guard hit for block %s", current_block_key)
        return False

    state["schedule_exists"] = True
    state["engine_state"] = STATE_ACTIVE_SCHEDULE_RUNNING
    state["dynamic_start_block"] = int(dynamic_start_block)
    state["last_schedule_block_timestamp"] = current_block_key

    if source == "dynamic_start":
        logger.info("Dynamic start schedule created")
    else:
        logger.info("Schedule created: %s", source)
    return True


def regenerate_schedule(state: dict, source: str, current_block_key: str) -> bool:
    if state.get("last_schedule_block_timestamp") == current_block_key:
        logger.info("Duplicate schedule guard hit for block %s", current_block_key)
        return False

    state["schedule_exists"] = True
    state["engine_state"] = STATE_ACTIVE_SCHEDULE_RUNNING
    state["last_schedule_block_timestamp"] = current_block_key

    if source == "abrupt_weather":
        logger.info("Abrupt weather schedule regenerated")
    else:
        logger.info("Schedule regenerated: %s", source)
    return True


# =============================================================================
# LOAD STATIC INPUTS
# =============================================================================
if os.getenv("SKIP_FETCHER", "0") != "1":
    _run_fetcher_once()


run_date = datetime.now().date()
if CUSTOM_DATA_DATE:
    try:
        datetime.strptime(CUSTOM_DATA_DATE, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("Invalid DATA_DATE, expected YYYY-MM-DD") from exc
    root_dir = DATA_ROOT / CUSTOM_DATA_DATE
else:
    root_dir = _pick_data_root_for_run_date(run_date)
enercast_dir = root_dir / "enercast_data"
metered_dir = root_dir / "metered_data"
weather_dir = root_dir / "weather_data"
now_ist = datetime.now(IST)
if ENGINE_NOW_IST:
    try:
        parsed = datetime.fromisoformat(str(ENGINE_NOW_IST))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=IST)
        else:
            parsed = parsed.astimezone(IST)
        now_ist = parsed
        logger.info("ENGINE_NOW_IST override applied: %s", now_ist.isoformat())
    except Exception:
        logger.warning("ENGINE_NOW_IST override invalid; using system time (%s)", ENGINE_NOW_IST)

dayahead_file = _latest_file_in_dir(enercast_dir / "day_ahead")
intraday_file = _latest_file_in_dir(enercast_dir / "intraday")

if intraday_file is None:
    raise FileNotFoundError("No intraday Enercast file found")
if dayahead_file is None:
    raise FileNotFoundError("No day-ahead Enercast file found")

df_dayahead = load_enercast_forecast_csv(dayahead_file)
TEST_DATE = _date_from_enercast_csv(intraday_file)

current_weather_path = weather_dir / f"openmeteo_current_{TEST_DATE}.csv"
minutely_weather_path = weather_dir / f"openmeteo_minutely15_{TEST_DATE}.csv"

current_weather_now, current_weather_prev = _load_openmeteo_current(current_weather_path)
if not minutely_weather_path.exists():
    fallback_minutely = _latest_weather_file(weather_dir, "openmeteo_minutely15")
    if fallback_minutely is None:
        raise FileNotFoundError(f"Minutely weather file not found: {minutely_weather_path}")
    fallback_date = _extract_date_from_weather_filename(fallback_minutely, "openmeteo_minutely15")
    logger.warning(
        "Minutely weather file not found for %s; using %s instead",
        TEST_DATE,
        fallback_minutely.name,
    )
    minutely_weather_path = fallback_minutely
    if current_weather_now is None and fallback_date:
        fallback_current = weather_dir / f"openmeteo_current_{fallback_date}.csv"
        current_weather_now, current_weather_prev = _load_openmeteo_current(fallback_current)
weather_df = pd.read_csv(minutely_weather_path)
weather_df["date"] = pd.to_datetime(weather_df["date"])
weather_by_block = build_weather_by_block(weather_df)
gti_today = [
    float(weather_by_block[b]["global_tilted_irradiance"])
    for b in range(START_BLOCK, GEN_END_BLOCK + 1)
    if b in weather_by_block and "global_tilted_irradiance" in weather_by_block[b]
]
max_gti_today = max(gti_today) if gti_today else 1.0

def _resolve_metered_file(metered_dir: Path, test_date: date) -> Path:
    # Site-configured naming (preferred when provided)
    template = None
    try:
        cfg_local = load_site_config(SITE_ID)
        if isinstance(cfg_local, dict):
            template = cfg_local.get("file_patterns", {}).get("metered_template")
    except Exception:
        template = None
    if template:
        rendered = template.format(
            date_iso=test_date.strftime("%Y-%m-%d"),
            date_yyyymmdd=test_date.strftime("%Y%m%d"),
            date_yyyy_mm_dd=test_date.strftime("%Y_%m_%d"),
        )
        cfg_file = metered_dir / rendered
        if cfg_file.exists():
            return cfg_file

    primary = metered_dir / f"Date {test_date.strftime('%Y%m%d')}.csv"
    if primary.exists():
        return primary

    # Newer naming from fetcher: YYYY_MM_DD_SOLAR_INV.csv
    alt = metered_dir / f"{test_date.strftime('%Y_%m_%d')}_SOLAR_INV.csv"
    if alt.exists():
        return alt

    # Fallback: pick latest CSV for the date prefix, if present.
    prefix = test_date.strftime("%Y_%m_%d")
    candidates = list(metered_dir.glob(f"{prefix}*.csv"))
    if candidates:
        return max(candidates, key=lambda p: p.stat().st_mtime)

    # Also support lower-case site prefixed names: <site>_YYYYMMDD.csv
    compact = test_date.strftime("%Y%m%d")
    site_token = SITE_ID.strip().lower()
    candidates = list(metered_dir.glob(f"*{site_token}*{compact}*.csv"))
    if candidates:
        return max(candidates, key=lambda p: p.stat().st_mtime)

    raise FileNotFoundError(f"No metered file found for {test_date} in {metered_dir}")


metered_file = _resolve_metered_file(metered_dir, TEST_DATE)

def _read_metered_csv(path: Path) -> pd.DataFrame:
    cfg_local = None
    try:
        cfg_local = load_site_config(SITE_ID)
    except Exception:
        cfg_local = None
    delimiter = None
    if isinstance(cfg_local, dict):
        delimiter = cfg_local.get("metered", {}).get("delimiter")

    try:
        if delimiter:
            return pd.read_csv(path, sep=delimiter)
        df = pd.read_csv(path)
        if len(df.columns) == 1:
            df2 = pd.read_csv(path, sep=None, engine="python")
            if len(df2.columns) > 1:
                return df2
        return df
    except pd.errors.ParserError:
        return pd.read_csv(path, sep=None, engine="python")


metered_df = _read_metered_csv(metered_file)

def _resolve_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    cols = {c.lower(): c for c in df.columns}
    for name in candidates:
        key = name.lower()
        if key in cols:
            return cols[key]
    return None


cfg_metered = {}
try:
    cfg_local = load_site_config(SITE_ID)
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
timestamp_candidates = [c for c in timestamp_candidates if c]
timestamp_col = _resolve_column(metered_df, timestamp_candidates)
if timestamp_col is None:
    raise KeyError("Timestamp column not found in metered data")
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
power_candidates = [c for c in power_candidates if c]
power_col = _resolve_column(metered_df, power_candidates)
if power_col is None:
    raise KeyError("Active power column not found in metered data")

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
    lambda ts: 1 + (ts.hour * 60 + ts.minute) // 15
)
power_unit = str(cfg_metered.get("power_unit", "KW")).strip().upper()
if power_unit in {"MW", "MEGAWATT", "MEGAWATTS"}:
    scale = 1.0
else:
    scale = 0.001
metered_df["metered_mw"] = metered_df[power_col] * scale

# -----------------------------------------------------------------------------
# OUTPUT LAYOUT (default + custom)
# -----------------------------------------------------------------------------
if CUSTOM_OUTPUT_BASE is not None:
    output_day_base = CUSTOM_OUTPUT_BASE / TEST_DATE.strftime("%Y-%m-%d")
    OUTPUT_DAY = output_day_base / "schedules"
    graph_output_dir = output_day_base
    logs_root_for_blocks = output_day_base / "logs"
    state_path = logs_root_for_blocks / "continuous_scheduler_state.json"
    legacy_state_path = OUTPUT_DAY / "engine_state.json"
    use_date_subdir_logs = False
    combined_dir = output_day_base / "combined"
else:
    OUTPUT_DAY = OUTPUT_ROOT / TEST_DATE.strftime("%Y-%m-%d")
    graph_output_dir = OUTPUT_DAY
    logs_root_for_blocks = LOG_ROOT
    state_path = logs_root_for_blocks / "continuous_scheduler_state.json"
    legacy_state_path = OUTPUT_DAY / "engine_state.json"
    use_date_subdir_logs = True
    combined_dir = COMBINED_ROOT

OUTPUT_DAY.mkdir(parents=True, exist_ok=True)
_remove_legacy_schedule_json(OUTPUT_DAY)

if CUSTOM_OUTPUT_BASE is not None:
    _remove_legacy_schedule_json(output_day_base)

# -----------------------------------------------------------------------------
# ENGINE STATE (persisted per day)
# -----------------------------------------------------------------------------
metered_by_block = metered_df.groupby("block")["metered_mw"].mean()
state = _load_state(state_path)
if not state and legacy_state_path.exists():
    logger.info("Loading legacy state file: %s", _rel_path(legacy_state_path))
    state = _load_state(legacy_state_path)
schedule_exists = bool(state.get("schedule_exists", False))
engine_state = state.get(
    "engine_state",
    STATE_ACTIVE_SCHEDULE_RUNNING if schedule_exists else STATE_WAITING_FOR_DYNAMIC_START
)
dynamic_start_raw = state.get("dynamic_start_block")
dynamic_start_block = int(dynamic_start_raw) if dynamic_start_raw is not None else None
last_schedule_block_timestamp = state.get("last_schedule_block_timestamp")
abrupt_lock_until_raw = state.get("abrupt_lock_until_block")
abrupt_lock_until_block = (
    int(abrupt_lock_until_raw) if abrupt_lock_until_raw is not None else None
)
lock_until_raw = state.get("lock_until_block")
lock_until_block = int(lock_until_raw) if lock_until_raw is not None else -1
high_flag = bool(state.get("high_flag", False))
high_event = state.get("high_event") or {}
curtailment_active = bool(state.get("curtailment_active", False))
curtailment_window_end_raw = state.get("curtailment_window_end")
curtailment_window_end = (
    int(curtailment_window_end_raw) if curtailment_window_end_raw is not None else -1
)
da_submitted_for_next_day = bool(state.get("da_submitted_for_next_day", False))
engine_run_date = TEST_DATE if CUSTOM_DATA_DATE else now_ist.date()
current_run_date = engine_run_date.strftime("%Y-%m-%d")
current_run_date_str = current_run_date
da_submission_date = state.get("da_submission_date")
if isinstance(da_submission_date, str) and da_submission_date == current_run_date:
    da_submitted_for_next_day = True
elif da_submitted_for_next_day:
    logger.info(
        "Resetting stale day-ahead submission flag for run_date=%s (stored=%s)",
        current_run_date,
        da_submission_date,
    )
    da_submitted_for_next_day = False
    state["da_submitted_for_next_day"] = False

# -------------------------------------------------------------------------
# DYNAMODB CONTROL STATE (WhatsApp integration)
# -------------------------------------------------------------------------
control_state = _load_control_state(SITE_ID)
planned_windows = _load_control_windows()
plant_status = control_state.get("plant_status", "NORMAL")
curtailment_capacity = control_state.get("curtailment_capacity")
prev_status = _normalize_status(state.get("plant_status"))
prev_curt = state.get("curtailment_capacity")
control_changed = (plant_status != prev_status) or (curtailment_capacity != prev_curt)
logger.info(
    "CONTROL STATE | ddb_status=%s ddb_cap=%s | prev_status=%s prev_cap=%s | control_changed=%s",
    plant_status,
    curtailment_capacity,
    prev_status,
    prev_curt,
    control_changed,
)
block_logger_manager = BlockScheduleLogger(
    TEST_DATE,
    logs_root=logs_root_for_blocks,
    use_date_subdir=use_date_subdir_logs,
)

# =============================================================================
# ENGINE LOOP
# =============================================================================
previous_schedule_file = _latest_schedule_file(OUTPUT_DAY)

now_block = timestamp_to_block(now_ist)
if ENGINE_BLOCK_OVERRIDE is not None:
    engine_block = int(ENGINE_BLOCK_OVERRIDE)
    logger.info("ENGINE_BLOCK_OVERRIDE enabled: %s (engine_block=%s)", ENGINE_BLOCK_OVERRIDE, engine_block)
elif CUSTOM_START_BLOCK is not None:
    engine_block = int(CUSTOM_START_BLOCK)
    logger.info("CUSTOM_START_BLOCK enabled: %s (engine_block=%s)", CUSTOM_START_BLOCK, engine_block)
else:
    engine_block = int(now_block)

# Invalid block guard
if engine_block < 1 or engine_block > 96:
    logger.warning("INVALID_BLOCK=%s; skipping submission", engine_block)
    _exit("invalid_block")

engine_block = max(START_BLOCK, min(engine_block, GEN_END_BLOCK))
current_block_key = _current_block_key_ist(now_ist)

# Day reset (T == 1 OR date changed)
last_run_date = state.get("last_run_date")
if engine_block == 1 or last_run_date != current_run_date:
    last_reset_date = state.get("last_reset_date")
    logger.info(
        "Day reset (%s -> %s); clearing schedule state",
        last_reset_date,
        current_run_date,
    )
    schedule_exists = False
    engine_state = STATE_WAITING_FOR_DYNAMIC_START
    state["schedule_exists"] = False
    state["engine_state"] = STATE_WAITING_FOR_DYNAMIC_START
    state["slot_submitted"] = {}
    state["slot_low_flag"] = {}
    state["lock_until_block"] = -1
    state["high_flag"] = False
    state["high_event"] = {"category": None, "sub_type": None, "timestamp": -1}
    state["curtailment_active"] = False
    state["curtailment_window_end"] = -1
    state["da_submitted_for_next_day"] = False
    state["da_submission_date"] = None
    state.pop("pending_high", None)
    state.pop("dynamic_start_block", None)
    state.pop("abrupt_lock_until_block", None)
    state["last_reset_date"] = current_run_date
    state["last_run_date"] = current_run_date
    _save_state(state_path, state)
    lock_until_block = -1
    high_flag = False
    high_event = {"category": None, "sub_type": None, "timestamp": -1}
    curtailment_active = False
    curtailment_window_end = -1
    da_submitted_for_next_day = False
else:
    state["last_run_date"] = current_run_date

if previous_schedule_file is not None and not schedule_exists:
    if engine_block != 1:
        schedule_exists = True
        engine_state = STATE_ACTIVE_SCHEDULE_RUNNING
        state["schedule_exists"] = True
        state["engine_state"] = STATE_ACTIVE_SCHEDULE_RUNNING
        _save_state(state_path, state)

# If a schedule exists but we have not locked dynamic start yet, keep the engine
# in WAITING state so dynamic start can override the day-ahead schedule.
if schedule_exists and state.get("dynamic_start_block") is None:
    engine_state = STATE_WAITING_FOR_DYNAMIC_START
    state["engine_state"] = STATE_WAITING_FOR_DYNAMIC_START

logger.info(f"ENGINE START @ BLOCK {engine_block}")
logger.info(f"ENGINE ITERATION @ BLOCK {engine_block}")

# Slot state (per day)
window_id = ((engine_block - 1) // WINDOW_SIZE_BLOCKS) + 1
slot_start = (window_id - 1) * WINDOW_SIZE_BLOCKS + 1
slot_end = slot_start + WINDOW_SIZE_BLOCKS - 1
slot_key = str(window_id)
slot_submitted = state.get("slot_submitted", {}) or {}
slot_low_flag = state.get("slot_low_flag", {}) or {}
slot_submitted_before = bool(slot_submitted.get(slot_key))
context = _build_engine_context(
    engine_block=engine_block,
    weather_by_block=weather_by_block,
    current_weather_now=current_weather_now,
    current_weather_prev=current_weather_prev,
    max_gti_today=max_gti_today,
)

metered_cutoff = metered_df[metered_df.block <= engine_block]
run_da_only = os.getenv("RUN_DA_ONLY", "0").strip() == "1"

if not run_da_only:
    intraday_file_current, intraday_basis = _pick_latest_intraday_source(
        enercast_dir / "intraday",
        SITE_ID,
        current_run_date,
    )
    df_intraday = load_enercast_forecast_csv(intraday_file_current)
    logger.info(
        "INPUT SELECT | intraday_file_current=%s | basis=%s | local_mtime=%s",
        _rel_path(intraday_file_current),
        intraday_basis,
        float(intraday_file_current.stat().st_mtime) if intraday_file_current is not None else None,
    )
else:
    intraday_file_current = dayahead_file
    intraday_basis = "day_ahead_fallback"
    df_intraday = df_dayahead

# -----------------------------------------------------------------------------
# DAY-AHEAD FOR NEXT DAY (DA-only mode; triggered externally by fetcher/scheduler)
# -----------------------------------------------------------------------------
next_date = engine_run_date + timedelta(days=1)
next_date_str = next_date.strftime("%Y-%m-%d")

if run_da_only:
    try:
        day_ahead_dir = enercast_dir / "day_ahead"
        # Use explicit rules when known, otherwise prefer latest revision (DA1 > DA0).
        try:
            da_source_file = _resolve_day_ahead_source_file(
                site_id=SITE_ID,
                day_ahead_dir=day_ahead_dir,
                current_run_date=current_run_date,
                next_date=next_date,
            )
        except Exception:
            da_source_file = _pick_latest_day_ahead_source(day_ahead_dir)

        src_mtime = float(da_source_file.stat().st_mtime)
        src_sha = _sha256_file(da_source_file)
        prev_for = str(state.get("da_last_generated_for_date") or "")
        prev_sha = str(state.get("da_last_source_sha256") or "")

        # Skip only when the revision is exactly identical (content hash match).
        if prev_for == next_date_str and prev_sha and prev_sha == src_sha:
            logger.info(
                "Day-ahead already up-to-date for %s (sha256=%s); skipping regeneration",
                next_date_str,
                src_sha[:12],
            )
            logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
            raise SystemExit(0)

        df_day_ahead_next = load_enercast_forecast_csv(da_source_file)
        da_map = (
            df_day_ahead_next.drop_duplicates("block", keep="last")
            .set_index("block")["forecast_mw"]
            .to_dict()
        )

        if CUSTOM_OUTPUT_BASE is not None:
            da_output_dir = CUSTOM_OUTPUT_BASE / next_date_str / "Day-ahead"
            da_graph_dir = da_output_dir / "graphs"
        else:
            da_output_dir = OUTPUT_ROOT / next_date_str / "Day-ahead"
            da_graph_dir = da_output_dir / "graphs"
        da_output_dir.mkdir(parents=True, exist_ok=True)
        da_graph_dir.mkdir(parents=True, exist_ok=True)

        da_rows: list[dict] = []
        for b in range(1, 97):
            mw = float(da_map.get(b, 0.0) or 0.0)
            start_ts = block_to_timestamp(next_date, b)
            block_status, block_cap = _resolve_block_control(
                start_ts,
                live_status=plant_status,
                live_curtailment_capacity=curtailment_capacity,
                planned_windows=planned_windows,
                site_id=SITE_ID,
            )
            effective_mw = mw
            if block_status == "SHUTDOWN":
                effective_mw = 0.0
            elif block_status == "CURTAILMENT" and block_cap is not None:
                block_scale = float(block_cap) / float(PLANT_CAPACITY_MW) if float(PLANT_CAPACITY_MW) > 0 else 1.0
                effective_mw = min(mw * block_scale, float(block_cap))
            end_ts = (
                pd.to_datetime(start_ts) + pd.Timedelta(minutes=15)
            ).strftime("%Y-%m-%d %H:%M:%S")

            # --- Control priority enforcement (must be last) ---
            if block_status == "SHUTDOWN":
                effective_mw = 0.0
            elif block_status == "CURTAILMENT" and block_cap is not None:
                effective_mw = min(effective_mw, float(block_cap))
            if effective_mw < 0.0:
                effective_mw = 0.0

            da_rows.append(
                {
                    "block": b,
                    "timestamp": start_ts,
                    "start_time": start_ts,
                    "end_time": end_ts,
                    "algo_schedule_mw": round(effective_mw, 3),
                    "condition_used": "DAY_AHEAD_FORWARD",
                    "BaseForecast": round(mw, 3),
                    "EffectiveBaseForecast": round(effective_mw, 3),
                    "IntradayForecast_mw": round(mw, 3),
                }
            )

        da_csv_path = da_output_dir / f"schedule_from_{engine_block:02d}.csv"
        pd.DataFrame(da_rows).to_csv(da_csv_path, index=False)

        da_meta_path = da_csv_path.with_suffix(".meta.json")
        da_meta_payload = {
            "schedule_file": _rel_path(da_csv_path),
            "schedule_type": "day_ahead",
            "engine_block": int(engine_block),
            "created_at_ist": datetime.now(IST).isoformat(),
            "source_forecast_file": da_source_file.name,
            "source_forecast_sha256": src_sha,
            "source_forecast_s3_path": (
                f"raw/{os.getenv('PLANT_ID', 'vedanjay')}/{os.getenv('SITE_NAME', SITE_ID)}/{current_run_date_str}/"
                f"enercast_data/day_ahead/{da_source_file.name}"
            ),
            "schedule_for_date": next_date_str,
            "site_id": SITE_ID,
        }
        da_meta_path.write_text(json.dumps(da_meta_payload, indent=2), encoding="utf-8")

        da_graph_target = da_graph_dir / f"schedule_from_{engine_block:02d}.html"
        try:
            generate_schedule_graph(
                schedule_csv=da_csv_path,
                intraday_df=df_day_ahead_next,
                metered_by_block=pd.Series(dtype=float),
                current_block=engine_block,
                output_dir=da_output_dir,
            )
            generated_default_graph = da_graph_dir / f"schedule_{engine_block:02d}.html"
            if generated_default_graph.exists():
                if generated_default_graph.resolve() != da_graph_target.resolve():
                    generated_default_graph.replace(da_graph_target)
            elif not da_graph_target.exists():
                da_graph_target.write_text(
                    "<html><body><h3>Day-ahead graph generation skipped</h3></body></html>",
                    encoding="utf-8",
                )
        except Exception:
            logger.warning("Day-ahead graph generation failed; writing placeholder", exc_info=True)
            if not da_graph_target.exists():
                da_graph_target.write_text(
                    "<html><body><h3>Day-ahead graph generation failed</h3></body></html>",
                    encoding="utf-8",
                )

        _submit_to_sldc_day_ahead(da_csv_path, next_date)

        state["da_last_generated_for_date"] = next_date_str
        state["da_last_source_file"] = da_source_file.name
        state["da_last_source_mtime"] = src_mtime
        state["da_last_source_sha256"] = src_sha
        _save_state(state_path, state)
        logger.info("Day-ahead schedule generated for %s (block=%s)", next_date_str, engine_block)
    except SystemExit:
        raise
    except Exception:
        logger.exception("DAY_AHEAD_SUBMISSION_FAILED")
    logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
    raise SystemExit(0)

# -----------------------------------------------------------------------------
# STATE MACHINE: schedule creation / regeneration decision
# -----------------------------------------------------------------------------
meter_t = float(metered_by_block.get(engine_block, 0.0) or 0.0)
meter_t_minus_1 = float(metered_by_block.get(engine_block - 1, 0.0) or 0.0)
meter_t_minus_2 = float(metered_by_block.get(engine_block - 2, 0.0) or 0.0)

generate_schedule = False
schedule_source = None
trigger_reason = None
pending_submission_due = False
deferred_high_due = False
abrupt_info = {
    "state": "NORMAL",
    "abrupt_type": None,
    "cloud_dev": 0.0,
    "shift_ratio": 0.0,
    "cloud_threshold": 0.0,
    "shift_threshold": 0.0,
}

if not schedule_exists:
    engine_state = STATE_WAITING_FOR_DYNAMIC_START

# Curtailment extension window
if curtailment_active and engine_block == curtailment_window_end:
    _update_high_flag(state, "curtailment", engine_block)
    curtailment_window_end = engine_block + 4
    state["curtailment_active"] = True
    state["curtailment_window_end"] = int(curtailment_window_end)
    _save_state(state_path, state)
    high_flag = True
    high_event = state.get("high_event") or high_event

# Slot start: execute deferred high if any
if engine_block == slot_start and high_flag:
    deferred_high_due = True
    trigger_reason = (
        str(high_event.get("sub_type") or high_event.get("category") or "deferred_high")
    )
    pending_submission_due = True

control_force_initial = (plant_status != "NORMAL" and not schedule_exists)
checked_triggers: list[str] = []

if trigger_reason is None:
    if CUSTOM_START_BLOCK is not None:
        checked_triggers.append("custom_start")
        trigger_reason = "custom_start"
        # For a custom run, always override dynamic_start_block to avoid PRE_START zeros.
        dynamic_start_block = engine_block
        state["dynamic_start_block"] = int(dynamic_start_block)
    elif control_force_initial:
        checked_triggers.append("plant_status_initial")
        trigger_reason = "plant_status_initial"
    elif control_changed and schedule_exists:
        checked_triggers.append("plant_status_change")
        trigger_reason = "plant_status_change"
    elif engine_state == STATE_WAITING_FOR_DYNAMIC_START:
        checked_triggers.append("dynamic_start")
        current_pair_ready = (
            meter_t > START_THRESHOLD and meter_t_minus_1 > START_THRESHOLD
        )
        lag_pair_ready = (
            meter_t_minus_1 > START_THRESHOLD and meter_t_minus_2 > START_THRESHOLD
        )
        if current_pair_ready or lag_pair_ready:
            dynamic_start_block = engine_block
            trigger_reason = "dynamic_start"
            state["dynamic_start_block"] = int(dynamic_start_block)
            logger.info(
                "Dynamic start threshold passed (%s pair): "
                "meter[T]=%.3f, meter[T-1]=%.3f, meter[T-2]=%.3f, threshold=%.3f",
                "T,T-1" if current_pair_ready else "T-1,T-2",
                meter_t,
                meter_t_minus_1,
                meter_t_minus_2,
                START_THRESHOLD,
            )
        else:
            logger.info(
                "No schedule generated. Waiting for dynamic start threshold "
                "(meter[T]=%.3f, meter[T-1]=%.3f, meter[T-2]=%.3f, threshold=%.3f).",
                meter_t,
                meter_t_minus_1,
                meter_t_minus_2,
                START_THRESHOLD,
            )
    elif engine_state == STATE_ACTIVE_SCHEDULE_RUNNING and schedule_exists:
        checked_triggers.append("abrupt_weather")
        abrupt_info = classify_block_weather_state(
            engine_block,
            weather_by_block,
            current_now=current_weather_now,
            current_prev=current_weather_prev,
            max_block=GEN_END_BLOCK,
            eps_small=EPS_SMALL_WM2,
            max_gti_today=max_gti_today,
            return_details=True,
        )
        if abrupt_lock_until_block is not None and engine_block <= abrupt_lock_until_block:
            if abrupt_info["state"] == "ABRUPT":
                logger.info(
                    "Abrupt regen locked until block %s; suppressing for block %s",
                    abrupt_lock_until_block,
                    engine_block,
                )
            abrupt_info["state"] = "NORMAL"
            abrupt_info["abrupt_type"] = None
        if abrupt_info["state"] == "ABRUPT":
            trigger_reason = "abrupt_weather"
        else:
            logger.info("No abrupt weather event. Continuing existing schedule.")
    else:
        logger.info("State mismatch detected. Resetting to waiting state.")
        state["engine_state"] = STATE_WAITING_FOR_DYNAMIC_START
        state["schedule_exists"] = False
        _save_state(state_path, state)
        logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
        _exit("state_mismatch_reset")

logger.info(
    "TRIGGER_EVAL_SUMMARY | checked=%s | fired=%s",
    ",".join(checked_triggers) if checked_triggers else "none",
    trigger_reason if trigger_reason is not None else "none",
)

# Lock window: capture high triggers only
if engine_block <= lock_until_block and not deferred_high_due:
    if trigger_reason:
        importance_lock = _determine_importance(trigger_reason, context, plant_status)
        logger.info(
            "IMPORTANCE_DETAIL | trigger=%s | importance=%s | %s",
            trigger_reason,
            importance_lock,
            _importance_detail(trigger_reason, context, plant_status, importance_lock),
        )
        if importance_lock == "HIGH":
            _update_high_flag(state, trigger_reason, engine_block)
            state["lock_until_block"] = int(lock_until_block)
            _save_state(state_path, state)
    logger.info("Lock window active until block %s; skipping submission", lock_until_block)
    _exit("lock_window")

# Low-priority refresh at second-last block if flagged and slot unused
if (
    trigger_reason is None
    and engine_block == (slot_end - 1)
    and not bool(slot_submitted.get(slot_key))
    and bool(slot_low_flag.get(slot_key))
):
    trigger_reason = "low_priority_refresh"

# End-of-day forced high
if trigger_reason is None and engine_block == GEN_END_BLOCK and high_flag:
    trigger_reason = str(high_event.get("sub_type") or high_event.get("category") or "eod_high")
    pending_submission_due = True

if trigger_reason is None:
    logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
    _exit("no_trigger")

generate_schedule = True
schedule_source = trigger_reason

# Persist control state with the schedule run
state["plant_status"] = plant_status
state["curtailment_capacity"] = curtailment_capacity
_save_state(state_path, state)

if schedule_source != "abrupt_weather":
    abrupt_info = classify_block_weather_state(
        engine_block,
        weather_by_block,
        current_now=current_weather_now,
        current_prev=current_weather_prev,
        max_block=GEN_END_BLOCK,
        eps_small=EPS_SMALL_WM2,
        max_gti_today=max_gti_today,
        return_details=True,
    )

weather_state_map = {
    b: (
        "ABRUPT"
        if (
            abrupt_info["state"] == "ABRUPT"
            and engine_block + ABRUPT_FORECAST_OFFSET <= b <= min(GEN_END_BLOCK, engine_block + ABRUPT_FORECAST_OFFSET + (ABRUPT_WINDOW_BLOCKS - 1))
        )
        else "NORMAL"
    )
    for b in range(engine_block, GEN_END_BLOCK + 1)
}

if dynamic_start_block is None:
    positive_blocks = [
        int(b)
        for b, v in metered_by_block.items()
        if b < engine_block and pd.notna(v) and float(v) > 0
    ]
    if positive_blocks:
        dynamic_start_block = min(positive_blocks)
    else:
        dynamic_start_block = engine_block
    state["dynamic_start_block"] = int(dynamic_start_block)
    _save_state(state_path, state)

schedule_reason_label = _derive_schedule_reason(schedule_source, plant_status)


if CUSTOM_START_BLOCK is not None:
    run_stamp = now_ist.strftime("%Y%m%d_%H%M%S")
    custom_log_filename = f"schedule from {engine_block} block {run_stamp}.log"
else:
    custom_log_filename = f"schedule from {engine_block} block.log"
schedule_log_filepath = block_logger_manager.date_logs_dir / custom_log_filename
schedule_logger = _BufferedScheduleLog()

# Use engine_block metered pair (engine_block-2, engine_block-1) for this schedule file
metered_pair = []
metered_pair_blocks = []
prev_prev_metered = metered_by_block.get(engine_block - 2)
prev_metered = metered_by_block.get(engine_block - 1)
if pd.notna(prev_prev_metered):
    metered_pair.append(float(prev_prev_metered))
    metered_pair_blocks.append(engine_block - 2)
if pd.notna(prev_metered):
    metered_pair.append(float(prev_metered))
    metered_pair_blocks.append(engine_block - 1)

block_logger_manager.log_schedule_header(
    schedule_logger,
    engine_block,
    TEST_DATE,
    dynamic_start_block=dynamic_start_block,
    metered_pair=metered_pair,
    schedule_reason=schedule_reason_label,
)
# Log block-wise weather state overview at the start
block_logger_manager.log_weather_state_overview(schedule_logger, weather_state_map)

rows = []
block_structured_records = []
prev_df = pd.read_csv(previous_schedule_file) if previous_schedule_file else None
intraday_by_block = (
    df_intraday.drop_duplicates("block", keep="last")
    .set_index("block")["forecast_mw"]
    .to_dict()
)
dayahead_by_block = (
    df_dayahead.drop_duplicates("block", keep="last")
    .set_index("block")["forecast_mw"]
    .to_dict()
)
intraday_t = float(intraday_by_block.get(engine_block, 0.0) or 0.0)
if CUSTOM_START_BLOCK is not None:
    meter_ref = metered_by_block.get(engine_block)
    if pd.isna(meter_ref):
        meter_ref = compute_recent_avg_boundary(
            metered_by_block=metered_by_block,
            engine_block=engine_block,
        )
else:
    meter_ref = compute_recent_avg_boundary(
        metered_by_block=metered_by_block,
        engine_block=engine_block,
    )

if pd.isna(meter_ref):
    meter_ref = intraday_t

meter_avg_last2_mw = float(meter_ref)
if metered_pair:
    meter_avg_last2_mw = float(sum(metered_pair) / float(len(metered_pair)))

schedule_logger.info(
    "ITERATION FORECAST CONTEXT | reason=%s | meter_ref=%.4f | intraday_T=%.4f",
    schedule_reason_label,
    float(meter_ref),
    intraday_t,
)

abrupt_detected = abrupt_info["state"] == "ABRUPT"
abrupt_blocks = {
    engine_block + ABRUPT_FORECAST_OFFSET + i for i in range(ABRUPT_WINDOW_BLOCKS)
    if (engine_block + ABRUPT_FORECAST_OFFSET + i) <= GEN_END_BLOCK
}
prev_map = (
    prev_df.set_index("block")["algo_schedule_mw"].to_dict()
    if prev_df is not None and "block" in prev_df.columns
    else {}
)

for b in range(START_BLOCK, GEN_END_BLOCK + 1):
    block_start_ts = block_to_timestamp(TEST_DATE, b)
    block_end_ts = block_start_ts + timedelta(minutes=15)
    block_control_status, block_control_cap = _resolve_block_control(
        block_start_ts,
        live_status=plant_status,
        live_curtailment_capacity=curtailment_capacity,
        planned_windows=planned_windows,
        site_id=SITE_ID,
    )
    block_curtailment_scale = None
    if block_control_status == "CURTAILMENT" and block_control_cap is not None:
        if float(block_control_cap) > float(PLANT_CAPACITY_MW):
            logger.warning(
                "Curtailment capacity %.3f MW exceeds plant capacity %.3f MW; capping to plant capacity",
                float(block_control_cap),
                float(PLANT_CAPACITY_MW),
            )
            block_control_cap = float(PLANT_CAPACITY_MW)
        if float(PLANT_CAPACITY_MW) > 0:
            block_curtailment_scale = float(block_control_cap) / float(PLANT_CAPACITY_MW)

    intraday = float(intraday_by_block.get(b, 0.0) or 0.0)
    intraday_effective = intraday
    dayahead = float(dayahead_by_block.get(b, 0.0) or 0.0)
    weather_state = weather_state_map.get(b, "NORMAL")
    gti = float(weather_by_block.get(b, {}).get("global_tilted_irradiance", 0.0) or 0.0)
    dhi = float(weather_by_block.get(b, {}).get("diffuse_radiation", 0.0) or 0.0)
    temp_2m = float(weather_by_block.get(b, {}).get("temperature_2m", 0.0) or 0.0)
    wind_10m = float(weather_by_block.get(b, {}).get("wind_speed_10m", 0.0) or 0.0)
    irr_ratio = clamp(gti / max(max_gti_today, 1.0), 0.0, 1.0)
    meter_factor = 1.0
    meter_weight = WEIGHT_METER
    intraday_weight = WEIGHT_INTRADAY
    metered_block_val = metered_by_block.get(b)
    if CUSTOM_START_BLOCK is not None and b > engine_block:
        # Custom mode guard: do not use metered values beyond the schedule start block.
        meter_ref_block = float(meter_ref)
    else:
        meter_ref_block = float(metered_block_val) if pd.notna(metered_block_val) else 0.0
    base_forecast_raw = None
    effective_base_forecast = None

    if prev_df is not None and b < engine_block:
        cond = "FROZEN"
        adj_pct = 0.0
        base_forecast = float(prev_map.get(b, 0.0) or 0.0)
        base_forecast_raw = base_forecast
        effective_base_forecast = base_forecast
        algo_raw = float(prev_map.get(b, 0.0) or 0.0)
        trend_type = "FLAT"
        slope_pct = 0.0
        operation = "NONE"
        base_adj = 0.0
        weather_multiplier = 1.0
        irradiance_state = compute_irradiance_state(gti, max_gti_today=max_gti_today)
        irradiance_multiplier = compute_irradiance_multiplier(irradiance_state)
        temp_multiplier = compute_temp_multiplier(temp_2m)
        wind_multiplier = compute_wind_multiplier(wind_10m)
        last_two_metered = metered_pair
        past_block_values = []
        trend_calc_values = []
        cloud_threshold = float(abrupt_info.get("cloud_threshold", 0.0) or 0.0)
        shift_threshold = float(abrupt_info.get("shift_threshold", 0.0) or 0.0)
        formula_text = "FROZEN: reuse previous schedule"
    elif b < dynamic_start_block :
        cond = "PRE_START"
        adj_pct = 0.0
        algo_raw = 0.0
        trend_type = "FLAT"
        slope_pct = 0.0
        operation = "NONE"
        base_adj = 0.0
        weather_multiplier = 1.0
        base_forecast = 0.0
        base_forecast_raw = 0.0
        effective_base_forecast = 0.0
        irradiance_state = compute_irradiance_state(gti, max_gti_today=max_gti_today)
        irradiance_multiplier = compute_irradiance_multiplier(irradiance_state)
        temp_multiplier = compute_temp_multiplier(temp_2m)
        wind_multiplier = compute_wind_multiplier(wind_10m)
        last_two_metered = metered_pair
        past_block_values = []
        trend_calc_values = []
        cloud_threshold = float(abrupt_info.get("cloud_threshold", 0.0) or 0.0)
        shift_threshold = float(abrupt_info.get("shift_threshold", 0.0) or 0.0)
        formula_text = "PRE_START: raw=0"
    elif gti < (0.02 * max(max_gti_today, 1.0)):
        cond = "SUNSET_CLAMP"
        adj_pct = 0.0
        algo_raw = 0.0
        trend_type = "FLAT"
        slope_pct = 0.0
        operation = "NONE"
        base_adj = 0.0
        weather_multiplier = 1.0
        base_forecast_raw = (
            meter_weight * meter_avg_last2_mw
            + intraday_weight * intraday_effective
        )
        effective_base_forecast = base_forecast_raw
        if block_control_status == "CURTAILMENT" and block_curtailment_scale is not None:
            effective_base_forecast = base_forecast_raw * block_curtailment_scale
        elif block_control_status == "SHUTDOWN":
            effective_base_forecast = 0.0
        base_forecast = effective_base_forecast
        if (
            block_control_status == "CURTAILMENT"
            and block_curtailment_scale is not None
            and block_control_cap is not None
            and PLANT_CAPACITY_MW > 0
            and base_forecast_raw is not None
            and effective_base_forecast is not None
        ):
            schedule_logger.info("--- CURTAILMENT BASE FLOW ---")
            schedule_logger.info("Base Forecast (raw): %.3f MW", base_forecast_raw)
            schedule_logger.info(
                "Curtailment Scale = curtailment_capacity / plant_capacity = "
                "%.3f / %.3f = %.6f",
                block_control_cap,
                PLANT_CAPACITY_MW,
                block_curtailment_scale,
            )
            schedule_logger.info(
                "Effective Base Forecast = Base Forecast (raw) * Curtailment Scale = "
                "%.3f * %.6f = %.3f MW",
                base_forecast_raw,
                block_curtailment_scale,
                effective_base_forecast,
            )
        irradiance_state = compute_irradiance_state(gti, max_gti_today=max_gti_today)
        irradiance_multiplier = compute_irradiance_multiplier(irradiance_state)
        temp_multiplier = compute_temp_multiplier(temp_2m)
        wind_multiplier = compute_wind_multiplier(wind_10m)
        last_two_metered = metered_pair
        past_block_values = []
        trend_calc_values = []
        cloud_threshold = float(abrupt_info.get("cloud_threshold", 0.0) or 0.0)
        shift_threshold = float(abrupt_info.get("shift_threshold", 0.0) or 0.0)
        formula_text = (
            f"SUNSET_CLAMP: GTI={gti:.3f} < 0.02*MAX_GTI={0.02*max_gti_today:.3f} => raw=0"
        )
    else:
        last_two_metered = metered_pair
        base_forecast_raw = (
            meter_weight * meter_avg_last2_mw
            + intraday_weight * intraday_effective
        )
        effective_base_forecast = base_forecast_raw
        if irr_ratio < LOW_GTI_IRR_RATIO_THRESHOLD:
            effective_base_forecast *= LOW_GTI_DAMP_FACTOR
            schedule_logger.info(
                "Low GTI ratio (%.3f) -> base_forecast damped by %.2f",
                irr_ratio,
                LOW_GTI_DAMP_FACTOR,
            )
        if block_control_status == "CURTAILMENT" and block_curtailment_scale is not None:
            effective_base_forecast = effective_base_forecast * block_curtailment_scale
        elif block_control_status == "SHUTDOWN":
            effective_base_forecast = 0.0
        base_forecast = effective_base_forecast
        if (
            block_control_status == "CURTAILMENT"
            and block_curtailment_scale is not None
            and block_control_cap is not None
            and PLANT_CAPACITY_MW > 0
            and base_forecast_raw is not None
            and effective_base_forecast is not None
        ):
            schedule_logger.info("--- CURTAILMENT BASE FLOW ---")
            schedule_logger.info("Base Forecast (raw): %.3f MW", base_forecast_raw)
            schedule_logger.info(
                "Curtailment Scale = curtailment_capacity / plant_capacity = "
                "%.3f / %.3f = %.6f",
                block_control_cap,
                PLANT_CAPACITY_MW,
                block_curtailment_scale,
            )
            schedule_logger.info(
                "Effective Base Forecast = Base Forecast (raw) * Curtailment Scale = "
                "%.3f * %.6f = %.3f MW",
                base_forecast_raw,
                block_curtailment_scale,
                effective_base_forecast,
            )

        past_block_values = []
        trend_pool = []
        for i in range(1, 5):
            pb = b - i
            if pb < START_BLOCK:
                continue
            if pb <= engine_block:
                metered_val = metered_by_block.get(pb)
                if pd.notna(metered_val):
                    trend_pool.append((pb, float(metered_val), "METERED"))
                    continue
            intraday_val = float(intraday_by_block.get(pb, 0.0) or 0.0)
            trend_pool.append((pb, intraday_val, "INTRADAY_FALLBACK"))

        if len(trend_pool) >= 4:
            past_block_values = trend_pool[:4]
        elif len(trend_pool) >= 2:
            past_block_values = trend_pool[:2]
        else:
            past_block_values = []
        trend_calc_values = past_block_values

        if abrupt_detected and b in abrupt_blocks:
            combined_intensity = (
                0.6 * abs(float(abrupt_info.get("cloud_dev", 0.0) or 0.0))
                + 0.4 * abs(float(abrupt_info.get("shift_ratio", 0.0) or 0.0))
            )
            adj_strength = clamp(combined_intensity, 0.0, MAX_ABRUPT_ADJ)
            if abrupt_info.get("abrupt_type") == "DECREASE":
                algo_raw = base_forecast * (1.0 - adj_strength)
                cond = "ABRUPT_DECREASE"
                operation = "SUBTRACT"
                adj_pct = -adj_strength * 100.0
            else:
                algo_raw = base_forecast * (1.0 + adj_strength)
                cond = "ABRUPT_INCREASE"
                operation = "ADD"
                adj_pct = adj_strength * 100.0
            trend_type = "ABRUPT"
            slope_pct = 0.0
            base_adj = 0.0
            weather_multiplier = 1.0
            irradiance_state = compute_irradiance_state(gti, max_gti_today=max_gti_today)
            irradiance_multiplier = compute_irradiance_multiplier(irradiance_state)
            temp_multiplier = compute_temp_multiplier(temp_2m)
            wind_multiplier = compute_wind_multiplier(wind_10m)
            cloud_threshold = float(abrupt_info.get("cloud_threshold", 0.0) or 0.0)
            shift_threshold = float(abrupt_info.get("shift_threshold", 0.0) or 0.0)
            formula_text = (
                f"raw=base*({1.0 - adj_strength:.4f})" if operation == "SUBTRACT"
                else f"raw=base*({1.0 + adj_strength:.4f})"
            )
        else:
            (
                cond,
                adj_pct,
                algo_raw,
                trend_type,
                slope_pct,
                operation,
                base_adj,
                weather_multiplier,
                irradiance_state,
                irradiance_multiplier,
                temp_multiplier,
                wind_multiplier,
            ) = apply_condition3(
                block=b,
                base_forecast=base_forecast,
                intraday_forecast=intraday_effective,
                weather_state=weather_state,
                gti=gti,
                dhi=dhi,
                temp_2m=temp_2m,
                wind_speed_10m=wind_10m,
                past_block_values=past_block_values,
                max_gti_today=max_gti_today,
                dampen_factor=1.0,
                return_details=True,
            )
            cloud_threshold = float(abrupt_info.get("cloud_threshold", 0.0) or 0.0)
            shift_threshold = float(abrupt_info.get("shift_threshold", 0.0) or 0.0)
            formula_text = (
                f"raw={base_forecast:.4f}*(1+{adj_pct:.4f}/100)={algo_raw:.4f}"
            )

    effective_base = (
        effective_base_forecast
        if effective_base_forecast is not None
        else base_forecast
    )

    ramp_cap_value, ramp_cap_reason = None, None
    if b < engine_block:
        algo = algo_raw
    elif prev_df is None:
        algo = algo_raw
    else:
        prev_algo = float(prev_map.get(b, algo_raw) or algo_raw)
        if CUSTOM_START_BLOCK is not None:
            # Custom mode should be deterministic one-shot output (no cross-run smoothing).
            algo = algo_raw
        elif abrupt_detected and b in abrupt_blocks:
            algo = algo_raw
        elif schedule_source in ("plant_status_initial", "plant_status_change"):
            # Skip smoothing on forced schedules due to plant status changes.
            algo = algo_raw
        else:
            algo = ((1.0 - SMOOTH_ALPHA) * prev_algo) + (SMOOTH_ALPHA * algo_raw)

    # --- Control priority enforcement (must be last) ---
    control_reason = None
    if b >= engine_block:
        if block_control_status == "SHUTDOWN":
            algo = 0.0
            control_reason = "SHUTDOWN"
        elif block_control_status == "CURTAILMENT" and block_control_cap is not None:
            # Hard MW ceiling during curtailment, even if abrupt-weather adjustments increase it
            algo = min(algo, float(block_control_cap))
            control_reason = "CURTAILMENT"

    # Safety clamp
    if algo < 0.0:
        algo = 0.0
    if control_reason:
        if formula_text:
            formula_text = f"{formula_text} | control={control_reason}"
        else:
            formula_text = f"control={control_reason}"

    # Log detailed block calculation
    block_logger_manager.log_block_calculation(
        schedule_logger,
        block=b,
        is_frozen=(prev_df is not None and b < engine_block),
        frozen_algo_value=prev_map.get(b) if (prev_df is not None and b < engine_block) else None,
        metered_val=(
            metered_by_block.get(b)
            if (b <= engine_block and not (prev_df is not None and b < engine_block))
            else None
        ),
        last_two_metered=last_two_metered,
        intraday_forecast=intraday,
        dayahead_forecast=dayahead,
        base_forecast=base_forecast,
        base_forecast_raw=base_forecast_raw,
        effective_base_forecast=effective_base,
        meter_ref=meter_ref_block,
        meter_weight=meter_weight,
        meter_factor=meter_factor,
        plant_status=block_control_status,
        curtailment_capacity=block_control_cap,
        curtailment_scale=block_curtailment_scale,
        plant_capacity_mw=PLANT_CAPACITY_MW,
        irr_ratio=irr_ratio,
        gti=gti,
        dhi=dhi,
        dni=weather_by_block.get(b, {}).get("direct_normal_irradiance", 0.0),
        temp_2m=temp_2m,
        wind_speed_10m=wind_10m,
        diffuse_ratio_current=(dhi / max(gti, EPS_SMALL_WM2)) if gti is not None else None,
        irradiance_state=irradiance_state,
        weather_state=weather_state,
        abrupt_weather=weather_state == "ABRUPT",
        abrupt_info=abrupt_info,
        cloud_threshold=cloud_threshold,
        shift_threshold=shift_threshold,
        past_block_values=past_block_values,
        trend_calc_values=trend_calc_values,
        trend_type=trend_type,
        slope_pct=slope_pct,
        trend_eps=TREND_EPS,
        ramp_cap_value=ramp_cap_value,
        ramp_cap_reason=ramp_cap_reason,
        condition_used=cond,
        operation=operation,
        base_adjustment_pct=base_adj,
        weather_multiplier=weather_multiplier,
        irradiance_multiplier=irradiance_multiplier,
        temp_multiplier=temp_multiplier,
        wind_multiplier=wind_multiplier,
        final_adjustment_pct=adj_pct,
        formula_text=formula_text,
        algo_schedule=algo,
        previous_schedule_value=prev_map.get(b) if prev_df is not None else None,
        raw_schedule_value=algo_raw,
    )

    block_start_ts = block_to_timestamp(TEST_DATE, b)
    block_end_ts = (
        pd.to_datetime(block_start_ts) + pd.Timedelta(minutes=15)
    ).strftime("%Y-%m-%d %H:%M:%S")

    rows.append({
        "block": b,
        "timestamp": block_start_ts,
        "start_time": block_start_ts,
        "end_time": block_end_ts,
        "algo_schedule_mw": round(algo, 3),
        "condition_used": cond,
        "BaseForecast": round(base_forecast, 3),
        "EffectiveBaseForecast": round(effective_base, 3),
        "IntradayForecast_mw": round(intraday, 3),
    })

    source_used = "prev_schedule" if (prev_df is not None and b < engine_block) else "new_schedule"
    cloud_dev_val = float(abrupt_info.get("cloud_dev", 0.0) or 0.0)
    cloud_now_norm_val = (dhi / max(gti, EPS_SMALL_WM2)) if gti is not None else None
    forecast_cloud_index_val = (
        (cloud_now_norm_val + cloud_dev_val) if cloud_now_norm_val is not None else None
    )
    trigger_multiplier = 1.0
    raw_adjustment_pct = float(base_adj) * float(weather_multiplier) * float(trigger_multiplier)
    final_adjustment_pct = float(clamp(raw_adjustment_pct, -(MAX_ABRUPT_ADJ * 100.0), (MAX_ABRUPT_ADJ * 100.0)))
    new_schedule_mw_raw = float(base_forecast) * (1.0 + (final_adjustment_pct / 100.0))
    new_schedule_mw = float(clamp(new_schedule_mw_raw, 0.0, float(PLANT_CAPACITY_MW)))
    prev_schedule_mw_val = (
        float(prev_map.get(b))
        if (prev_df is not None and b in prev_map and pd.notna(prev_map.get(b)))
        else None
    )
    error_old = (
        abs(float(prev_schedule_mw_val) - float(base_forecast))
        if prev_schedule_mw_val is not None
        else None
    )
    error_new = abs(float(new_schedule_mw) - float(base_forecast))
    improvement = (float(error_old) - float(error_new)) if error_old is not None else None

    block_structured_records.append(
        {
            "run_date": TEST_DATE.strftime("%Y-%m-%d"),
            "engine_block": int(engine_block),
            "trigger_reason": schedule_source,
            "importance": None,
            "window_id": int(window_id),
            "slot_submitted_before": bool(slot_submitted_before),
            "lock_until_block": int(lock_until_block),
            "decision": {
                "action": None,
                "submission_block": None,
                "reason": None,
            },
            "block_input": {
                "block_no": int(b),
                "prev_schedule_mw": (round(float(prev_schedule_mw_val), 3) if prev_schedule_mw_val is not None else None),
                "base_forecast_mw": round(float(base_forecast), 3),
                "new_schedule_candidate_mw": round(float(algo_raw), 3),
            },
            "weather_features": {
                "abrupt_flag": bool(weather_state == "ABRUPT"),
                "cloud_now_norm": (round(float(cloud_now_norm_val), 6) if cloud_now_norm_val is not None else None),
                "forecast_cloud_index": (round(float(forecast_cloud_index_val), 6) if forecast_cloud_index_val is not None else None),
                "cloud_dev": round(cloud_dev_val, 6),
                "weather_multiplier": round(float(weather_multiplier), 6),
            },
            "adjustment": {
                "base_adjustment_pct": round(float(base_adj), 6),
                "final_adjustment_pct": round(float(adj_pct), 6),
                "capped_by_max_adjustment": bool(abs(float(adj_pct)) >= (MAX_ABRUPT_ADJ * 100.0)),
                "max_adjustment_pct_config": round(float(MAX_ABRUPT_ADJ * 100.0), 6),
            },
            "plant_state": {
                "state": _normalize_status(block_control_status),
                "curtailment_active": bool(curtailment_active),
                "curtailment_limit_mw": (
                    round(float(block_control_cap), 3)
                    if block_control_cap is not None
                    else None
                ),
            },
            "final_block_output": {
                "block_frozen": bool(prev_df is not None and b < engine_block),
                "final_schedule_mw": round(float(algo), 3),
                "source_used": source_used,
            },
            "audit": {
                "generated_at": datetime.now(IST).isoformat(),
                "persisted_to_s3": False,
                "s3_path": (
                    f"generated/{os.getenv('PLANT_ID', 'vedanjay')}/"
                    f"{os.getenv('SITE_NAME', SITE_ID)}/logs/"
                    f"{TEST_DATE.strftime('%Y-%m-%d')}/schedule from {engine_block} block.log"
                ),
            },
            "calc_trace": {
                "block_no": int(b),
                "prev_schedule_mw": (round(float(prev_schedule_mw_val), 6) if prev_schedule_mw_val is not None else None),
                "base_forecast_mw": round(float(base_forecast), 6),
                "intraday_forecast_mw": round(float(intraday), 6),
                "cloud_now_norm": (round(float(cloud_now_norm_val), 6) if cloud_now_norm_val is not None else None),
                "forecast_cloud_index": (round(float(forecast_cloud_index_val), 6) if forecast_cloud_index_val is not None else None),
                "max_adjustment_pct": round(float(MAX_ABRUPT_ADJ * 100.0), 6),
                "cloud_dev": round(float(cloud_dev_val), 6),
                "base_adjustment_pct": round(float(base_adj), 6),
                "weather_multiplier": round(float(weather_multiplier), 6),
                "trigger_multiplier": round(float(trigger_multiplier), 6),
                "raw_adjustment_pct": round(float(raw_adjustment_pct), 6),
                "final_adjustment_pct": round(float(final_adjustment_pct), 6),
                "new_schedule_mw_raw": round(float(new_schedule_mw_raw), 6),
                "new_schedule_mw": round(float(new_schedule_mw), 6),
                "error_old": (round(float(error_old), 6) if error_old is not None else None),
                "error_new": round(float(error_new), 6),
                "improvement": (round(float(improvement), 6) if improvement is not None else None),
                "final_schedule_mw": round(float(algo), 6),
                "trigger": schedule_source,
                "importance": None,
                "action": None,
            },
        }
    )


out_file = OUTPUT_DAY / f"schedule_from_{engine_block:02d}.csv"
new_sched_df = pd.DataFrame(rows)
accepted = True

# Slot-based submission decision
abrupt_metrics = None
if schedule_source == "abrupt_weather":
    combined_intensity = (
        0.6 * abs(float(abrupt_info.get("cloud_dev", 0.0) or 0.0))
        + 0.4 * abs(float(abrupt_info.get("shift_ratio", 0.0) or 0.0))
    )
    abrupt_metrics = {
        "combined_intensity": combined_intensity,
        "cloud_dev": float(abrupt_info.get("cloud_dev", 0.0) or 0.0),
        "shift_ratio": float(abrupt_info.get("shift_ratio", 0.0) or 0.0),
        "abrupt_type": abrupt_info.get("abrupt_type"),
    }

if schedule_source == "low_priority_refresh":
    importance = "LOW"
else:
    if pending_submission_due:
        importance = "HIGH"
        logger.info(
            "IMPORTANCE_DETAIL | trigger=%s | importance=%s | pending submission due path",
            schedule_source,
            importance,
        )
    else:
        importance = _determine_importance(schedule_source, context, plant_status)
        logger.info(
            "IMPORTANCE_DETAIL | trigger=%s | importance=%s | %s",
            schedule_source,
            importance,
            _importance_detail(schedule_source, context, plant_status, importance),
        )

def _emit_structured_block_logs(action: str, reason: str, submission_block: int | None) -> None:
    for rec in block_structured_records:
        rec["importance"] = importance
        rec["decision"] = {
            "action": action,
            "submission_block": submission_block,
            "reason": reason,
        }
        calc_trace = rec.get("calc_trace", {}) or {}
        calc_trace["trigger"] = schedule_source
        calc_trace["importance"] = importance
        calc_trace["action"] = action
        block_logger_manager.log_block_calc_trace(schedule_logger, calc_trace)

slot_used = bool(slot_submitted.get(slot_key))
submit_now = True

if schedule_source == "low_priority_refresh":
    if slot_used:
        submit_now = False
        logger.info("LOW priority refresh skipped: slot already used")
    else:
        slot_submitted[slot_key] = True
        slot_low_flag[slot_key] = False
elif importance == "HIGH":
    if slot_used and not pending_submission_due:
        _update_high_flag(state, schedule_source, engine_block)
        state["slot_submitted"] = slot_submitted
        state["slot_low_flag"] = slot_low_flag
        _save_state(state_path, state)
        logger.info("Deferring HIGH priority schedule to next slot start")
        _emit_structured_block_logs("DEFERRED_HIGH", "slot_already_used_high_deferred", None)
        _exit("defer_high_to_next_slot")
    slot_submitted[slot_key] = True
    slot_low_flag[slot_key] = False
elif importance == "LOW":
    if not slot_used:
        slot_low_flag[slot_key] = True
        logger.info("LOW priority detected; flag set for slot refresh at E-1")
    else:
        logger.info("LOW priority ignored: slot already used")
    state["slot_submitted"] = slot_submitted
    state["slot_low_flag"] = slot_low_flag
    _save_state(state_path, state)
    _emit_structured_block_logs("LOW_FLAG_ONLY", "low_priority_flagged_or_ignored", None)
    _exit("low_priority_exit")

state["slot_submitted"] = slot_submitted
state["slot_low_flag"] = slot_low_flag
_save_state(state_path, state)

if not submit_now:
    logger.info("No submission executed for this block after slot decision.")
    _emit_structured_block_logs("NO_SUBMISSION", "slot_already_used_no_submit", None)
    _exit("slot_already_used_no_submit")

# Update schedule state for an actual submission
if schedule_source == "abrupt_weather":
    regenerate_schedule(
        state=state,
        source="abrupt_weather",
        current_block_key=current_block_key,
    )
    state["abrupt_lock_until_block"] = engine_block + ABRUPT_FORECAST_OFFSET + ABRUPT_WINDOW_BLOCKS
else:
    dyn_block = dynamic_start_block if dynamic_start_block is not None else engine_block
    create_schedule(
        state=state,
        source=schedule_source,
        current_block_key=current_block_key,
        dynamic_start_block=dyn_block,
    )
_save_state(state_path, state)

if prev_df is not None and not prev_df.empty and "block" in prev_df.columns and "algo_schedule_mw" in prev_df.columns:
    merged = new_sched_df[["block", "algo_schedule_mw"]].merge(
        prev_df[["block", "algo_schedule_mw"]],
        on="block",
        how="left",
        suffixes=("_new", "_prev"),
    )
    check_rows = merged[merged["block"] >= engine_block]
    diffs = (check_rows["algo_schedule_mw_new"] - check_rows["algo_schedule_mw_prev"]).abs()
    maxdiff = float(diffs.max()) if not diffs.empty else 0.0
    has_accepting_diff = bool((diffs >= ACCEPTANCE_MW).any()) if not diffs.empty else False
    if not has_accepting_diff:
        accepted = False
        top_diff_rows = check_rows.assign(abs_diff=diffs).sort_values("abs_diff", ascending=False).head(5)
        top_diff_text = ", ".join(
            f"B{int(r.block)}:new={float(r.algo_schedule_mw_new):.3f},prev={float(r.algo_schedule_mw_prev):.3f},diff={float(r.abs_diff):.3f}"
            for r in top_diff_rows.itertuples(index=False)
        )
        logger.info(
            "Update rejected by acceptance filter: maxdiff=%.3f < ACCEPTANCE_MW=%.3f",
            maxdiff,
            ACCEPTANCE_MW,
        )
        if top_diff_text:
            logger.info("Acceptance reject details: %s", top_diff_text)
        schedule_logger.info(
            "UPDATE REJECTED | maxdiff=%.3f < ACCEPTANCE_MW=%.3f",
            maxdiff,
            ACCEPTANCE_MW,
        )
        if top_diff_text:
            schedule_logger.info("UPDATE REJECTED DETAILS | %s", top_diff_text)

if accepted:
    _emit_structured_block_logs("SUBMIT", str(schedule_source), int(engine_block))
    schedule_logger.dump_to_file(schedule_log_filepath)
    new_sched_df.to_csv(out_file, index=False)
    stale_json_path = out_file.with_suffix(".json")
    if stale_json_path.exists():
        try:
            stale_json_path.unlink()
            logger.info("Removed stale schedule JSON: %s", _rel_path(stale_json_path))
        except Exception:
            logger.warning("Unable to remove stale schedule JSON: %s", _rel_path(stale_json_path))
    previous_schedule_file = out_file
    logger.info("Schedule generated: %s", _rel_path(out_file))

    meta_path = out_file.with_suffix(".meta.json")
    meta_payload = {
        "schedule_file": _rel_path(out_file),
        "schedule_reason": schedule_reason_label,
        "engine_block": int(engine_block),
        "submission_block": int(engine_block),
        "slot_id": int(window_id),
        "importance": importance,
        "dynamic_start_block": int(dynamic_start_block) if dynamic_start_block is not None else None,
        "created_at_ist": datetime.now(IST).isoformat(),
        "plant_status": plant_status,
        "curtailment_capacity_mw": (
            float(curtailment_capacity) if curtailment_capacity is not None else None
        ),
        "abrupt_weather": bool(abrupt_detected),
        "acceptance_mw": float(ACCEPTANCE_MW),
        "metered_pair": [float(v) for v in metered_pair],
        "metered_pair_blocks": [int(b) for b in metered_pair_blocks],
    }
    meta_path.write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")
    logger.info("Schedule metadata generated: %s", _rel_path(meta_path))

    try:
        generate_schedule_graph(
            schedule_csv=out_file,
            intraday_df=df_intraday,
            metered_by_block=metered_by_block,
            current_block=engine_block,
            output_dir=graph_output_dir,
        )
        logger.info("Schedule graph generated")
    except Exception:
        logger.exception("Failed to generate schedule graph")

    # Update lock window and high/curtailment flags after a successful submission
    state["lock_until_block"] = int(engine_block + LOCK_DURATION - 1)
    if importance == "HIGH" or pending_submission_due or deferred_high_due:
        state["high_flag"] = False
        state["high_event"] = {"category": None, "sub_type": None, "timestamp": -1}
    if _normalize_status(plant_status) == "CURTAILMENT":
        state["curtailment_active"] = True
        state["curtailment_window_end"] = int(engine_block + 4)
    elif _normalize_status(plant_status) == "NORMAL":
        state["curtailment_active"] = False
    _save_state(state_path, state)
else:
    _emit_structured_block_logs("NO_SUBMISSION", "acceptance_filter_rejected", None)
    if previous_schedule_file is None:
        raise FileNotFoundError("Schedule rejected and no previous schedule available")
    logger.info("Keeping previous schedule: %s", _rel_path(previous_schedule_file))

logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")

# =============================================================================
# COMBINED CSV
# =============================================================================
try:
    final_schedule_path = previous_schedule_file
    if final_schedule_path is None:
        raise FileNotFoundError("No schedule file available for combined CSV")
    final_sched = pd.read_csv(final_schedule_path)
    blocks = list(range(1, 97))
    combined = pd.DataFrame({"block": blocks})

    # Intraday Forecast
    combined["IntradayForecast_mw"] = combined["block"].map(
        df_intraday.set_index("block")["forecast_mw"]
    )
    # BaseForecast
    combined["BaseForecast"] = combined["block"].map(
        final_sched.set_index("block")["BaseForecast"]
    )
    # Effective Base Forecast (after curtailment/shutdown)
    if "EffectiveBaseForecast" in final_sched.columns:
        combined["EffectiveBaseForecast"] = combined["block"].map(
            final_sched.set_index("block")["EffectiveBaseForecast"]
        )
    # Algo Schedule
    combined["algo_schedule_mw"] = combined["block"].map(
        final_sched.set_index("block")["algo_schedule_mw"]
    )
    # Metered MW
    combined["Metered_mw"] = combined["block"].map(
        metered_df.groupby("block")["metered_mw"].mean()
    )

    # Vedanjay_Schedule from submitted.csv (Forecast column)
    submitted_path = root_dir / "submitted.csv"
    if not submitted_path.exists():
        submitted_path = DATA_ROOT / "active" / "submitted.csv"

    if submitted_path.exists():
        submitted_df = pd.read_csv(submitted_path, skiprows=6)
        # Ensure columns are named correctly
        submitted_df.columns = ["Block", "Block Interval", "Availability", "Forecast"]
        combined["Vedanjay_Schedule"] = combined["block"].map(
            submitted_df.set_index("Block")["Forecast"]
        )
    else:
        logger.warning(
            "submitted.csv not found at %s; Vedanjay_Schedule will be empty",
            _rel_path(submitted_path)
        )
        combined["Vedanjay_Schedule"] = pd.NA

    band_mw = _penalty_band_mw()
    combined["Maximum tolerable schedule"] = combined["Metered_mw"] + band_mw
    combined["Minimum tolerable schedule"] = combined["Metered_mw"] - band_mw

    # Reorder columns as requested
    combined_cols = [
        "block",
        "IntradayForecast_mw",
        "BaseForecast",
    ]
    if "EffectiveBaseForecast" in combined.columns:
        combined_cols.append("EffectiveBaseForecast")
    combined_cols += [
        "algo_schedule_mw",
        "Metered_mw",
        "Vedanjay_Schedule",
        "Maximum tolerable schedule",
        "Minimum tolerable schedule",
    ]
    combined = combined[combined_cols]

    combined_dir.mkdir(parents=True, exist_ok=True)
    combined_path = combined_dir / f"{TEST_DATE}.csv"
    combined.to_csv(combined_path, index=False)

    logger.info("Combined CSV generated: %s", _rel_path(combined_path))

except Exception:
    logger.exception("Failed to generate Combined CSV")




















