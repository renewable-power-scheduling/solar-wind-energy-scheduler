import pandas as pd
import logging
import os
import json
import subprocess
import sys
import warnings
import re
from pathlib import Path
from datetime import datetime, date
from zoneinfo import ZoneInfo
try:
    import boto3
except ImportError:
    boto3 = None

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
MAX_ABRUPT_ADJ = 0.10

# Forecast weighting`r`n
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

# Engine states
STATE_WAITING_FOR_DYNAMIC_START = "STATE_WAITING_FOR_DYNAMIC_START"
STATE_ACTIVE_SCHEDULE_RUNNING = "STATE_ACTIVE_SCHEDULE_RUNNING"

# Logging paths
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", Path.cwd()))
ENGINE_LOG_PATH = LOG_ROOT / "engine.log"

# Runtime overrides
CUSTOM_START_BLOCK = os.getenv("CUSTOM_START_BLOCK")
CUSTOM_START_BLOCK = int(CUSTOM_START_BLOCK) if CUSTOM_START_BLOCK else None
CUSTOM_DATA_DATE = os.getenv("DATA_DATE")  # YYYY-MM-DD to force data root
CUSTOM_OUTPUT_BASE = os.getenv("CUSTOM_OUTPUT_BASE")
CUSTOM_OUTPUT_BASE = Path(CUSTOM_OUTPUT_BASE) if CUSTOM_OUTPUT_BASE else None

# DynamoDB control state
DDB_TABLE = os.getenv("DDB_TABLE")
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
    state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")


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
def _configure_engine_logger() -> logging.Logger:
    logger = logging.getLogger("phase7_engine")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(formatter)

    ENGINE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
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


def _load_control_state() -> dict:
    """
    Load plant control state from DynamoDB.
    Returns: {plant_status, curtailment_capacity, source}
    """
    if not DDB_TABLE:
        return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "env_missing"}
    if boto3 is None:
        logger.warning("boto3 is not installed; skipping DynamoDB control state load")
        return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "boto3_missing"}

    try:
        ddb = boto3.client("dynamodb")
        resp = ddb.get_item(
            TableName=DDB_TABLE,
            Key={"plant_id": {"S": PLANT_ID}},
            ConsistentRead=True,
        )
        item = resp.get("Item")
        if not item:
            return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "ddb_empty"}

        status = _normalize_status(item.get("plant_status", {}).get("S"))
        cap_raw = item.get("curtailment_capacity", {}).get("N")
        cap = float(cap_raw) if cap_raw is not None else None
        return {"plant_status": status, "curtailment_capacity": cap, "source": "ddb"}
    except Exception:
        logger.exception("Failed to load control state from DynamoDB")
        return {"plant_status": "NORMAL", "curtailment_capacity": None, "source": "ddb_error"}


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
    state_path = OUTPUT_DAY / "engine_state.json"
    logs_root_for_blocks = output_day_base / "logs"
    use_date_subdir_logs = False
    combined_dir = output_day_base / "combined"
else:
    OUTPUT_DAY = OUTPUT_ROOT / TEST_DATE.strftime("%Y-%m-%d")
    graph_output_dir = OUTPUT_DAY
    state_path = OUTPUT_DAY / "engine_state.json"
    logs_root_for_blocks = LOG_ROOT
    use_date_subdir_logs = True
    combined_dir = COMBINED_ROOT

OUTPUT_DAY.mkdir(parents=True, exist_ok=True)

# -----------------------------------------------------------------------------
# ENGINE STATE (persisted per day)
# -----------------------------------------------------------------------------
metered_by_block = metered_df.groupby("block")["metered_mw"].mean()
state = _load_state(state_path)
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

# -------------------------------------------------------------------------
# DYNAMODB CONTROL STATE (WhatsApp integration)
# -------------------------------------------------------------------------
control_state = _load_control_state()
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

if previous_schedule_file is not None and not schedule_exists:
    schedule_exists = True
    engine_state = STATE_ACTIVE_SCHEDULE_RUNNING
    state["schedule_exists"] = True
    state["engine_state"] = STATE_ACTIVE_SCHEDULE_RUNNING
    _save_state(state_path, state)

now_ist = datetime.now(IST)
now_block = timestamp_to_block(now_ist)
if CUSTOM_START_BLOCK is not None:
    if CUSTOM_START_BLOCK < 1 or CUSTOM_START_BLOCK > 96:
        raise ValueError(f"CUSTOM_START_BLOCK must be 1-96, got {CUSTOM_START_BLOCK}")
    engine_block = max(START_BLOCK, min(CUSTOM_START_BLOCK, GEN_END_BLOCK))
    logger.info("CUSTOM_START_BLOCK enabled: %s (engine_block=%s)", CUSTOM_START_BLOCK, engine_block)
else:
    engine_block = max(START_BLOCK, min(now_block, GEN_END_BLOCK))
current_block_key = _current_block_key_ist(now_ist)

logger.info(f"ENGINE START @ BLOCK {engine_block}")
logger.info(f"ENGINE ITERATION @ BLOCK {engine_block}")

metered_cutoff = metered_df[metered_df.block <= engine_block]
intraday_file_current = _latest_file_in_dir(enercast_dir / "intraday")
if intraday_file_current is None:
    raise FileNotFoundError("No intraday Enercast file found")
df_intraday = load_enercast_forecast_csv(intraday_file_current)

# -----------------------------------------------------------------------------
# STATE MACHINE: schedule creation / regeneration decision
# -----------------------------------------------------------------------------
meter_t = float(metered_by_block.get(engine_block, 0.0) or 0.0)
meter_t_minus_1 = float(metered_by_block.get(engine_block - 1, 0.0) or 0.0)
meter_t_minus_2 = float(metered_by_block.get(engine_block - 2, 0.0) or 0.0)

generate_schedule = False
schedule_source = None
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

control_force_initial = (plant_status != "NORMAL" and not schedule_exists)

if CUSTOM_START_BLOCK is not None:
    generate_schedule = True
    schedule_source = "custom_start"
    # For a custom run, always override dynamic_start_block to avoid PRE_START zeros.
    dynamic_start_block = engine_block
    state["dynamic_start_block"] = int(dynamic_start_block)
elif control_force_initial:
    generate_schedule = True
    schedule_source = "plant_status_initial"
elif control_changed and schedule_exists:
    generate_schedule = True
    schedule_source = "plant_status_change"
elif engine_state == STATE_WAITING_FOR_DYNAMIC_START and not schedule_exists:
    current_pair_ready = (
        meter_t > START_THRESHOLD and meter_t_minus_1 > START_THRESHOLD
    )
    lag_pair_ready = (
        meter_t_minus_1 > START_THRESHOLD and meter_t_minus_2 > START_THRESHOLD
    )
    if current_pair_ready or lag_pair_ready:
        dynamic_start_block = engine_block
        generate_schedule = create_schedule(
            state=state,
            source="dynamic_start",
            current_block_key=current_block_key,
            dynamic_start_block=dynamic_start_block
        )
        schedule_source = "dynamic_start"
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
        generate_schedule = regenerate_schedule(
            state=state,
            source="abrupt_weather",
            current_block_key=current_block_key
        )
        schedule_source = "abrupt_weather"
        if generate_schedule:
            state["abrupt_lock_until_block"] = engine_block + ABRUPT_WINDOW_BLOCKS
            abrupt_lock_until_block = state["abrupt_lock_until_block"]
    else:
        logger.info("No abrupt weather event. Continuing existing schedule.")
else:
    logger.info("State mismatch detected. Resetting to waiting state.")
    state["engine_state"] = STATE_WAITING_FOR_DYNAMIC_START
    state["schedule_exists"] = False
    _save_state(state_path, state)
    logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
    raise SystemExit(0)

if generate_schedule:
    # Persist control state with the schedule run
    state["plant_status"] = plant_status
    state["curtailment_capacity"] = curtailment_capacity
    _save_state(state_path, state)
else:
    logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
    raise SystemExit(0)

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
            and engine_block <= b <= min(GEN_END_BLOCK, engine_block + (ABRUPT_WINDOW_BLOCKS - 1))
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
schedule_logger = block_logger_manager.get_logger_for_schedule(engine_block, log_filename=custom_log_filename)

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
is_first_schedule = prev_df is None
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

schedule_logger.info(
    "ITERATION FORECAST CONTEXT | reason=%s | meter_ref=%.4f | intraday_T=%.4f",
    schedule_reason_label,
    float(meter_ref),
    intraday_t,
)

abrupt_detected = abrupt_info["state"] == "ABRUPT"
abrupt_blocks = {
    engine_block + i
    for i in range(ABRUPT_WINDOW_BLOCKS)
    if (engine_block + i) <= GEN_END_BLOCK
}
prev_map = (
    prev_df.set_index("block")["algo_schedule_mw"].to_dict()
    if prev_df is not None and "block" in prev_df.columns
    else {}
)

curtailment_scale = None
if (
    plant_status == "CURTAILMENT"
    and curtailment_capacity is not None
    and PLANT_CAPACITY_MW > 0
):
    if float(curtailment_capacity) > float(PLANT_CAPACITY_MW):
        logger.warning(
            "Curtailment capacity %.3f MW exceeds plant capacity %.3f MW; capping to plant capacity",
            float(curtailment_capacity),
            float(PLANT_CAPACITY_MW),
        )
        curtailment_capacity = float(PLANT_CAPACITY_MW)
    curtailment_scale = float(curtailment_capacity) / float(PLANT_CAPACITY_MW)

for b in range(START_BLOCK, GEN_END_BLOCK + 1):
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
    elif b < dynamic_start_block:
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
            meter_weight * meter_ref_block
            + intraday_weight * intraday_effective
        )
        effective_base_forecast = base_forecast_raw
        if plant_status == "CURTAILMENT" and curtailment_scale is not None:
            effective_base_forecast = base_forecast_raw * curtailment_scale
        elif plant_status == "SHUTDOWN":
            effective_base_forecast = 0.0
        base_forecast = effective_base_forecast
        if (
            plant_status == "CURTAILMENT"
            and curtailment_scale is not None
            and curtailment_capacity is not None
            and PLANT_CAPACITY_MW > 0
            and base_forecast_raw is not None
            and effective_base_forecast is not None
        ):
            schedule_logger.info("--- CURTAILMENT BASE FLOW ---")
            schedule_logger.info("Base Forecast (raw): %.3f MW", base_forecast_raw)
            schedule_logger.info(
                "Curtailment Scale = curtailment_capacity / plant_capacity = "
                "%.3f / %.3f = %.6f",
                curtailment_capacity,
                PLANT_CAPACITY_MW,
                curtailment_scale,
            )
            schedule_logger.info(
                "Effective Base Forecast = Base Forecast (raw) * Curtailment Scale = "
                "%.3f * %.6f = %.3f MW",
                base_forecast_raw,
                curtailment_scale,
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
            meter_weight * meter_ref_block
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
        if plant_status == "CURTAILMENT" and curtailment_scale is not None:
            effective_base_forecast = effective_base_forecast * curtailment_scale
        elif plant_status == "SHUTDOWN":
            effective_base_forecast = 0.0
        base_forecast = effective_base_forecast
        if (
            plant_status == "CURTAILMENT"
            and curtailment_scale is not None
            and curtailment_capacity is not None
            and PLANT_CAPACITY_MW > 0
            and base_forecast_raw is not None
            and effective_base_forecast is not None
        ):
            schedule_logger.info("--- CURTAILMENT BASE FLOW ---")
            schedule_logger.info("Base Forecast (raw): %.3f MW", base_forecast_raw)
            schedule_logger.info(
                "Curtailment Scale = curtailment_capacity / plant_capacity = "
                "%.3f / %.3f = %.6f",
                curtailment_capacity,
                PLANT_CAPACITY_MW,
                curtailment_scale,
            )
            schedule_logger.info(
                "Effective Base Forecast = Base Forecast (raw) * Curtailment Scale = "
                "%.3f * %.6f = %.3f MW",
                base_forecast_raw,
                curtailment_scale,
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

    control_reason = None
    if b >= engine_block:
        algo, control_reason = _apply_control_overrides(
            algo, plant_status=plant_status, curtailment_capacity=curtailment_capacity
        )
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
        plant_status=plant_status,
        curtailment_capacity=curtailment_capacity,
        curtailment_scale=curtailment_scale,
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


out_file = OUTPUT_DAY / f"schedule_from_{engine_block:02d}.csv"
new_sched_df = pd.DataFrame(rows)
accepted = True

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
        logger.info(
            "Update rejected by acceptance filter: maxdiff=%.3f < ACCEPTANCE_MW=%.3f",
            maxdiff,
            ACCEPTANCE_MW,
        )
        schedule_logger.info(
            "UPDATE REJECTED | maxdiff=%.3f < ACCEPTANCE_MW=%.3f",
            maxdiff,
            ACCEPTANCE_MW,
        )

if accepted:
    new_sched_df.to_csv(out_file, index=False)
    previous_schedule_file = out_file
    logger.info("Schedule generated: %s", _rel_path(out_file))

    meta_path = out_file.with_suffix(".meta.json")
    meta_payload = {
        "schedule_file": _rel_path(out_file),
        "schedule_reason": schedule_reason_label,
        "engine_block": int(engine_block),
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
else:
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
