#updated
import pandas as pd
import logging
import os
import subprocess
import sys
import warnings
from pathlib import Path
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
try:
    import boto3
except ImportError:
    boto3 = None

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
CLOUD_ROOT = REPO_ROOT / "cloud"

from cloud.common.csv_utils import load_enercast_forecast_csv
from cloud.common.time_utils import block_to_timestamp, timestamp_to_block
from cloud.common.block_schedule_logger import BlockScheduleLogger
from cloud.common.structured_engine_logger import StructuredEngineLogger, BlockDetail
from cloud.common.graph_utils import generate_schedule_graph
from cloud.scheduler_core import control_capacity as control_capacity_core
from cloud.scheduler_core.engine_state_writer import (
    create_schedule_state,
    load_state,
    regenerate_schedule_state,
    save_state,
)
from cloud.scheduler_core.forecast_selector import (
    latest_file_in_dir as select_latest_file_in_dir,
    pick_previous_intraday_file as select_previous_intraday_file,
    select_reference_forecast,
)
from cloud.scheduler_core import input_loader as input_loader_core
from cloud.scheduler_core.output_writer import (
    write_combined_csv,
    write_schedule_artifacts,
    write_schedule_graph,
)
from cloud.scheduler_core.previous_schedule_loader import (
    latest_schedule_file,
    load_previous_schedule,
)
from cloud.scheduler_core import schedule_policy
from cloud.scheduler_core import runtime_helpers
from cloud.scheduler_core import engine_logging
from cloud.scheduler_core import schedule_adjustments
from cloud.scheduler_core import site_overrides

# =============================================================================
# GLOBAL CONSTANTS / THRESHOLDS
# =============================================================================
SITE_ID = os.getenv("SITE_ID", "SIRMOUR").strip().upper()
PLANT_CAPACITY_MW = 5.10
SITE_AC_CAPACITY_MW = PLANT_CAPACITY_MW
SITE_DC_CAPACITY_MW = PLANT_CAPACITY_MW
DC_AC_RATIO = 1.0
PENALTY_BAND_PCT = 0.10
PENALTY_BAND_MW: float | None = None

START_BLOCK = 1
GEN_END_BLOCK = 96
EPS_SMALL_WM2 = 1e-6

# Forecast weighting`r`n
WEIGHT_METER = 0.02
WEIGHT_INTRADAY = 0.98
# Irradiance thresholds / dampening
IRR_FULL_TRUST = 0.40
IRR_ZERO_TRUST = 0.10
LOW_GTI_IRR_RATIO_THRESHOLD = 0.15
LOW_GTI_DAMP_FACTOR = 0.85

# Trend + smoothing
# Start thresholds
WINDOW_SIZE_BLOCKS = 6  # 1.5-hour submission slots
INTRADAY_EFFECTIVE_LAG_BLOCKS = 3  # schedule becomes effective after 45 minutes

# Ramp control (sunrise)
RAMP_CAP_FACTOR = 1.30
RAMP_RAMP_MULT = 1.20
RAMP_ENABLE_IRR_RATIO = 0.20

# OSEPL-only receivable bias (optional via site config)
RECEIVABLE_BIAS_ENABLE = False
RECEIVABLE_OVER_MIN_PCT = 2.0
RECEIVABLE_OVER_TARGET_PCT = 5.0
RECEIVABLE_OVER_MAX_PCT = 9.0
RECEIVABLE_MIN_BASE_MW = 0.0
RECEIVABLE_MIN_IRR_RATIO = 0.0
RECEIVABLE_FORCE_BELOW_METER = False
RECEIVABLE_BELOW_METER_MARGIN_MW = 0.0
SUBMISSION_SLOTS: list[dict] = []
FIRST_INTRADAY_MANDATORY_REVISION = 1
FIRST_INTRADAY_GENERATION_BLOCK: int | None = None
FIRST_INTRADAY_ARRIVAL_BLOCK: int | None = None
INTRADAY_SLOT_END_ONLY = True

# Paths / timezone
DATA_ROOT = Path(os.getenv("DATA_ROOT", str(CLOUD_ROOT / "data" / SITE_ID)))
OUTPUT_ROOT = Path(os.getenv("OUTPUT_ROOT", str(CLOUD_ROOT / "outputs" / SITE_ID)))
LOG_ROOT = Path(os.getenv("LOG_ROOT", str(CLOUD_ROOT / "logs" / SITE_ID)))
COMBINED_ROOT = Path(os.getenv("COMBINED_ROOT", str(CLOUD_ROOT / "Combined" / SITE_ID)))
IST = ZoneInfo("Asia/Kolkata")

# Engine states
STATE_WAITING_FOR_INITIAL_SCHEDULE = "STATE_WAITING_FOR_INITIAL_SCHEDULE"
STATE_ACTIVE_SCHEDULE_RUNNING = "STATE_ACTIVE_SCHEDULE_RUNNING"

# Logging paths
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", str(CLOUD_ROOT)))
ENGINE_LOG_PATH = LOG_ROOT / "engine.log"

# Runtime overrides
CUSTOM_START_BLOCK = os.getenv("CUSTOM_START_BLOCK")
CUSTOM_START_BLOCK = int(CUSTOM_START_BLOCK) if CUSTOM_START_BLOCK else None
CUSTOM_DATA_DATE = os.getenv("DATA_DATE")  # YYYY-MM-DD to force data root
CUSTOM_OUTPUT_BASE = os.getenv("CUSTOM_OUTPUT_BASE")
CUSTOM_OUTPUT_BASE = Path(CUSTOM_OUTPUT_BASE) if CUSTOM_OUTPUT_BASE else None

# DynamoDB control state
DDB_TABLE = os.getenv("DDB_TABLE")
CONTROL_STATE_TABLE = os.getenv("CONTROL_STATE_TABLE", DDB_TABLE)
CONTROL_WINDOWS_TABLE = os.getenv("CONTROL_WINDOWS_TABLE")
PLANT_ID = os.getenv("PLANT_ID", "vedanjay")
WHATSAPP_TABLE_NAME = os.getenv("WHATSAPP_TABLE_NAME", "").strip()
METER_MODE_NORMAL = "NORMAL"
METER_MODE_NO_METER_FALLBACK = "NO_METER_FALLBACK"
REGEN_MIN_DEVIATION_MW = 0.2
REGEN_COOLDOWN_BLOCKS = 1
# Enercast accommodation vs scheduler weather-adjustment residual logic.
ACCOMMODATION_ENABLE = os.getenv("ACCOMMODATION_ENABLE", "1").strip().lower() not in {"0", "false", "no"}
ACCOMMODATION_MIN_WEATHER_DELTA_MW = float(os.getenv("ACCOMMODATION_MIN_WEATHER_DELTA_MW", "0.15"))
ACCOMMODATION_MATCH_ALPHA = float(os.getenv("ACCOMMODATION_MATCH_ALPHA", "0.70"))
ACCOMMODATION_RESIDUAL_GAMMA = float(os.getenv("ACCOMMODATION_RESIDUAL_GAMMA", "1.0"))
ACCOMMODATION_MAX_RESIDUAL_PCT = float(os.getenv("ACCOMMODATION_MAX_RESIDUAL_PCT", "12.0"))


def _apply_site_overrides() -> None:
    global START_BLOCK, GEN_END_BLOCK
    global WEIGHT_METER, WEIGHT_INTRADAY, IRR_FULL_TRUST, IRR_ZERO_TRUST
    global LOW_GTI_IRR_RATIO_THRESHOLD, LOW_GTI_DAMP_FACTOR
    global RAMP_CAP_FACTOR, RAMP_RAMP_MULT
    global RAMP_ENABLE_IRR_RATIO, PLANT_CAPACITY_MW, SITE_AC_CAPACITY_MW, SITE_DC_CAPACITY_MW, DC_AC_RATIO
    global PENALTY_BAND_PCT, PENALTY_BAND_MW
    global RECEIVABLE_BIAS_ENABLE, RECEIVABLE_OVER_MIN_PCT, RECEIVABLE_OVER_TARGET_PCT
    global RECEIVABLE_OVER_MAX_PCT, RECEIVABLE_MIN_BASE_MW, RECEIVABLE_MIN_IRR_RATIO
    global RECEIVABLE_FORCE_BELOW_METER, RECEIVABLE_BELOW_METER_MARGIN_MW
    global REGEN_MIN_DEVIATION_MW, REGEN_COOLDOWN_BLOCKS
    global SUBMISSION_SLOTS, FIRST_INTRADAY_MANDATORY_REVISION, MANDATORY_GENERATION_BLOCK
    global FIRST_INTRADAY_GENERATION_BLOCK, FIRST_INTRADAY_ARRIVAL_BLOCK, INTRADAY_SLOT_END_ONLY
    resolved = site_overrides.resolve_site_overrides(
        SITE_ID,
        {
            "start_block": START_BLOCK,
            "gen_end_block": GEN_END_BLOCK,
            "weight_meter": WEIGHT_METER,
            "weight_intraday": WEIGHT_INTRADAY,
            "irr_full_trust": IRR_FULL_TRUST,
            "irr_zero_trust": IRR_ZERO_TRUST,
            "low_gti_irr_ratio_threshold": LOW_GTI_IRR_RATIO_THRESHOLD,
            "low_gti_damp_factor": LOW_GTI_DAMP_FACTOR,
            "ramp_cap_factor": RAMP_CAP_FACTOR,
            "ramp_ramp_mult": RAMP_RAMP_MULT,
            "ramp_enable_irr_ratio": RAMP_ENABLE_IRR_RATIO,
            "plant_capacity_mw": PLANT_CAPACITY_MW,
            "penalty_band_pct": PENALTY_BAND_PCT,
            "receivable_bias_enable": RECEIVABLE_BIAS_ENABLE,
            "receivable_over_min_pct": RECEIVABLE_OVER_MIN_PCT,
            "receivable_over_target_pct": RECEIVABLE_OVER_TARGET_PCT,
            "receivable_over_max_pct": RECEIVABLE_OVER_MAX_PCT,
            "receivable_min_base_mw": RECEIVABLE_MIN_BASE_MW,
            "receivable_min_irr_ratio": RECEIVABLE_MIN_IRR_RATIO,
            "receivable_force_below_meter": RECEIVABLE_FORCE_BELOW_METER,
            "receivable_below_meter_margin_mw": RECEIVABLE_BELOW_METER_MARGIN_MW,
            "regen_min_deviation_mw": REGEN_MIN_DEVIATION_MW,
            "regen_cooldown_blocks": REGEN_COOLDOWN_BLOCKS,
            "first_intraday_mandatory_revision": FIRST_INTRADAY_MANDATORY_REVISION,
        },
    )
    START_BLOCK = resolved["start_block"]
    GEN_END_BLOCK = resolved["gen_end_block"]
    WEIGHT_METER = resolved["weight_meter"]
    WEIGHT_INTRADAY = resolved["weight_intraday"]
    IRR_FULL_TRUST = resolved["irr_full_trust"]
    IRR_ZERO_TRUST = resolved["irr_zero_trust"]
    LOW_GTI_IRR_RATIO_THRESHOLD = resolved["low_gti_irr_ratio_threshold"]
    LOW_GTI_DAMP_FACTOR = resolved["low_gti_damp_factor"]
    RAMP_CAP_FACTOR = resolved["ramp_cap_factor"]
    RAMP_RAMP_MULT = resolved["ramp_ramp_mult"]
    RAMP_ENABLE_IRR_RATIO = resolved["ramp_enable_irr_ratio"]
    RECEIVABLE_BIAS_ENABLE = resolved["receivable_bias_enable"]
    RECEIVABLE_OVER_MIN_PCT = resolved["receivable_over_min_pct"]
    RECEIVABLE_OVER_TARGET_PCT = resolved["receivable_over_target_pct"]
    RECEIVABLE_OVER_MAX_PCT = resolved["receivable_over_max_pct"]
    RECEIVABLE_MIN_BASE_MW = resolved["receivable_min_base_mw"]
    RECEIVABLE_MIN_IRR_RATIO = resolved["receivable_min_irr_ratio"]
    RECEIVABLE_FORCE_BELOW_METER = resolved["receivable_force_below_meter"]
    RECEIVABLE_BELOW_METER_MARGIN_MW = resolved["receivable_below_meter_margin_mw"]
    REGEN_MIN_DEVIATION_MW = resolved["regen_min_deviation_mw"]
    REGEN_COOLDOWN_BLOCKS = resolved["regen_cooldown_blocks"]
    SITE_AC_CAPACITY_MW = resolved["site_ac_capacity_mw"]
    SITE_DC_CAPACITY_MW = resolved["site_dc_capacity_mw"]
    DC_AC_RATIO = resolved["dc_ac_ratio"]
    PLANT_CAPACITY_MW = resolved["plant_capacity_mw"]
    PENALTY_BAND_PCT = resolved["penalty_band_pct"]
    PENALTY_BAND_MW = resolved["penalty_band_mw"]
    SUBMISSION_SLOTS = resolved["submission_slots"]
    FIRST_INTRADAY_MANDATORY_REVISION = resolved["first_intraday_mandatory_revision"]
    MANDATORY_GENERATION_BLOCK = resolved["mandatory_generation_block"]
    FIRST_INTRADAY_GENERATION_BLOCK = resolved["first_intraday_generation_block"]
    FIRST_INTRADAY_ARRIVAL_BLOCK = resolved["first_intraday_arrival_block"]
    INTRADAY_SLOT_END_ONLY = resolved["intraday_slot_end_only"]

def _penalty_band_mw() -> float:
    return schedule_adjustments.penalty_band_mw(
        penalty_band_mw=PENALTY_BAND_MW,
        penalty_band_pct=PENALTY_BAND_PCT,
        plant_capacity_mw=PLANT_CAPACITY_MW,
    )


def _osepl_receivable_bias_enabled() -> bool:
    # OSEPL-specific bias path is disabled to keep schedule generation
    # identical across all plants.
    return False


def _apply_receivable_bias(
    schedule_mw: float,
    expected_gen_mw: float,
    over_min_pct: float,
    over_target_pct: float,
    over_max_pct: float,
) -> tuple[float, dict]:
    return schedule_adjustments.apply_receivable_bias(
        schedule_mw=schedule_mw,
        expected_gen_mw=expected_gen_mw,
        over_min_pct=over_min_pct,
        over_target_pct=over_target_pct,
        over_max_pct=over_max_pct,
    )


def _clamp_below_meter_within_band(
    schedule_mw: float,
    meter_mw: float,
    margin_mw: float,
    band_mw: float,
) -> tuple[float, dict]:
    return schedule_adjustments.clamp_below_meter_within_band(
        schedule_mw=schedule_mw,
        meter_mw=meter_mw,
        margin_mw=margin_mw,
        band_mw=band_mw,
    )
# =============================================================================
# DATE PARSER
# =============================================================================
def _normalize_enercast_date(date_str: str) -> date:
    return input_loader_core.normalize_enercast_date(date_str)


def _date_from_enercast_csv(path: str) -> date:
    return input_loader_core.date_from_enercast_csv(path)


def _latest_file_in_dir(dir_path: Path) -> Path | None:
    return select_latest_file_in_dir(dir_path)


def _resolve_intraday_override(intraday_dir: Path) -> tuple[Path | None, str | None]:
    return input_loader_core.resolve_intraday_override(intraday_dir)


def _list_data_date_dirs(data_root: Path) -> list[Path]:
    return input_loader_core.list_data_date_dirs(data_root)


def _pick_data_root_for_run_date(run_date: date) -> Path:
    return input_loader_core.pick_data_root_for_run_date(DATA_ROOT, run_date, logger)


def _latest_schedule_file(output_day: Path) -> Path | None:
    return latest_schedule_file(output_day)


def _load_state(state_path: Path) -> dict:
    return load_state(state_path)


def _save_state(state_path: Path, state: dict) -> None:
    save_state(state_path, state)


def _pick_latest_intraday_source(intraday_dir: Path, site_id: str, run_date: date) -> tuple[Path, str]:
    return input_loader_core.pick_latest_intraday_source(intraday_dir, site_id, run_date)



def _intraday_time_rank_key(path: Path, run_date: date) -> int | None:
    return input_loader_core.intraday_time_rank_key(path, run_date)


def _intraday_revision_from_filename(path: Path, intraday_dir: Path, run_date: date) -> str:
    return input_loader_core.intraday_revision_from_filename(path, intraday_dir, run_date)


def _intraday_source_key(path: Path, intraday_dir: Path, run_date: date) -> str:
    return input_loader_core.intraday_source_key(path, intraday_dir, run_date)


def _safe_file_token(value: str | None) -> str:
    return schedule_policy.safe_file_token(value)


def _parse_revision_number(revision_label: str | None) -> int:
    return schedule_policy.parse_revision_number(revision_label)


def _hhmm_to_block_end(hhmm: str) -> int:
    return schedule_policy.hhmm_to_block_end(hhmm)


def _build_submission_slots(site_cfg: dict) -> list[dict]:
    return schedule_policy.build_submission_slots(site_cfg)


def _slot_info_for_block(block: int) -> dict | None:
    return schedule_policy.slot_info_for_block(block, SUBMISSION_SLOTS)


def _evaluate_intraday_schedule_gate(
    engine_block: int,
    current_revision_num: int,
    schedule_exists: bool,
) -> tuple[bool, str | None, dict]:
    return schedule_policy.evaluate_intraday_schedule_gate(
        engine_block=engine_block,
        current_revision_num=current_revision_num,
        schedule_exists=schedule_exists,
        submission_slots=SUBMISSION_SLOTS,
        slot_end_only=INTRADAY_SLOT_END_ONLY,
        first_mandatory_revision=FIRST_INTRADAY_MANDATORY_REVISION,
        first_arrival_block=FIRST_INTRADAY_ARRIVAL_BLOCK,
        mandatory_generation_block=MANDATORY_GENERATION_BLOCK,
        first_generation_block=FIRST_INTRADAY_GENERATION_BLOCK,
    )


_apply_site_overrides()


def _forecast_by_block_from_csv(path: Path | None) -> dict[int, float]:
    return input_loader_core.forecast_by_block_from_csv(path)


def _pick_previous_intraday_file(intraday_dir: Path, current_file: Path) -> Path | None:
    return select_previous_intraday_file(intraday_dir, current_file)


def _pick_da2_reference_file(day_ahead_dir: Path, site_id: str, run_date: date) -> Path | None:
    return input_loader_core.pick_da2_reference_file(day_ahead_dir, site_id, run_date)

def _run_fetcher_once() -> None:
    site_id = str(os.getenv("SITE_ID", "")).strip().upper()
    fetcher = Path(__file__).resolve().parents[1] / "fetcher_core" / "fetch_worker.py"
    if not fetcher.exists():
        raise FileNotFoundError(f"Fetcher not found: {fetcher}")
    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
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


def _configure_engine_logger(log_path: Path | None = None) -> logging.Logger:
    return engine_logging.configure_engine_logger(log_path or ENGINE_LOG_PATH)


logger = _configure_engine_logger()


def _log_raw_inputs_manifest(engine_block: int, now_ist: datetime) -> None:
    engine_logging.log_raw_inputs_manifest(
        logger=logger,
        site_id=SITE_ID,
        repo_root=ROOT_DIR,
        engine_block=engine_block,
        now_ist=now_ist,
    )


def _rel_path(path: str | Path) -> str:
    return engine_logging.rel_path(path, ROOT_DIR)


def _showwarning(message, category, filename, lineno, file=None, line=None):
    engine_logging.showwarning(logger, ROOT_DIR, message, category, filename, lineno, file=file, line=line)


warnings.showwarning = _showwarning

# =============================================================================
# HELPERS
# =============================================================================
def clamp(val: float, lo: float, hi: float) -> float:
    return schedule_adjustments.clamp(val, lo, hi)


def _normalize_status(status: str | None) -> str:
    if not status:
        return "NORMAL"
    status = str(status).strip().upper()
    if status in {"NORMAL", "SHUTDOWN", "CURTAILMENT"}:
        return status
    return "NORMAL"


def _normalize_control_site(site_id: str | None) -> str:
    return control_capacity_core.normalize_control_site(site_id)


def _ddb_number(item: dict, key: str) -> float | None:
    return control_capacity_core.ddb_number(item, key)


def _ddb_string(item: dict, key: str, default: str | None = None) -> str | None:
    return control_capacity_core.ddb_string(item, key, default)


def _default_control_mode(status: str | None) -> str:
    return control_capacity_core.default_control_mode(status)


def _load_control_state(site_id: str) -> dict:
    return control_capacity_core.load_control_state(
        site_id=site_id,
        table_name=CONTROL_STATE_TABLE,
        logger=logger,
        plant_id=PLANT_ID,
    )


def _load_control_windows() -> list[dict]:
    return control_capacity_core.load_control_windows(
        table_name=CONTROL_WINDOWS_TABLE,
        plant_id=PLANT_ID,
        logger=logger,
    )


def _planned_window_for_block(
    block_start: datetime,
    block_end: datetime,
    windows: list[dict],
    site_id: str,
) -> tuple[str, float | None]:
    return control_capacity_core.planned_window_for_block(
        block_start=block_start,
        block_end=block_end,
        windows=windows,
        site_id=site_id,
        site_ac_capacity_mw=SITE_AC_CAPACITY_MW,
        site_dc_capacity_mw=SITE_DC_CAPACITY_MW,
        dc_ac_ratio=DC_AC_RATIO,
    )


def _control_detail_for_block(
    block_start: datetime,
    windows: list[dict],
    site_id: str,
) -> dict:
    return control_capacity_core.control_detail_for_block(
        block_start=block_start,
        windows=windows,
        site_id=site_id,
        site_ac_capacity_mw=SITE_AC_CAPACITY_MW,
        site_dc_capacity_mw=SITE_DC_CAPACITY_MW,
        dc_ac_ratio=DC_AC_RATIO,
    )


def _resolve_block_control(
    block_start: datetime,
    live_status: str,
    live_curtailment_capacity: float | None,
    planned_windows: list[dict],
    site_id: str,
) -> tuple[str, float | None]:
    return control_capacity_core.resolve_block_control(
        block_start=block_start,
        live_status=live_status,
        live_curtailment_capacity=live_curtailment_capacity,
        planned_windows=planned_windows,
        site_id=site_id,
        site_ac_capacity_mw=SITE_AC_CAPACITY_MW,
        site_dc_capacity_mw=SITE_DC_CAPACITY_MW,
        dc_ac_ratio=DC_AC_RATIO,
    )


def _current_control_state_from_windows(
    planned_windows: list[dict],
    site_id: str,
    block_start: datetime,
) -> tuple[str, float | None]:
    block_end = block_start + timedelta(minutes=15)
    return _planned_window_for_block(block_start, block_end, planned_windows, site_id)


def _normalize_control_mode(control_mode: str | None, plant_status: str | None) -> str:
    return control_capacity_core.normalize_control_mode(control_mode, plant_status)


def _effective_control_capacity_ac(
    plant_status: str | None,
    control_mode: str | None = None,
    curtailment_capacity: float | None = None,
    shutdown_reduction_mw: float | None = None,
) -> tuple[float | None, str]:
    return control_capacity_core.effective_control_capacity_ac(
        plant_status=plant_status,
        control_mode=control_mode,
        curtailment_capacity=curtailment_capacity,
        shutdown_reduction_mw=shutdown_reduction_mw,
        site_ac_capacity_mw=SITE_AC_CAPACITY_MW,
        site_dc_capacity_mw=SITE_DC_CAPACITY_MW,
        dc_ac_ratio=DC_AC_RATIO,
    )


def _apply_control_overrides(value: float, plant_status: str, curtailment_capacity: float | None) -> tuple[float, str | None]:
    return control_capacity_core.apply_control_overrides(value, plant_status, curtailment_capacity)


def _parse_intraday_reason_revision(source: str | None) -> int | None:
    return schedule_policy.parse_intraday_reason_revision(source)


def _derive_schedule_reason_fields(source: str | None, plant_status: str) -> dict:
    return schedule_policy.derive_schedule_reason_fields(source, plant_status)


def _current_block_key_ist(now_ist: datetime) -> str:
    return runtime_helpers.current_block_key_ist(now_ist)


def _resolve_engine_now_ist() -> datetime:
    return runtime_helpers.resolve_engine_now_ist(IST, logging.getLogger(__name__))


def _parse_ist_datetime(raw: object) -> datetime | None:
    return runtime_helpers.parse_ist_datetime(raw, IST)


def _resolve_intraday_arrival_ist(path: Path) -> datetime | None:
    return runtime_helpers.resolve_intraday_arrival_ist(path, IST)


def _resolve_run_context_id() -> str:
    return runtime_helpers.resolve_run_context_id()


def _parse_iso_dt(value) -> datetime | None:
    return runtime_helpers.parse_iso_dt(value, IST)


def _item_to_python(item: dict) -> dict:
    return runtime_helpers.item_to_python(item)


def _fetch_latest_whatsapp_actual(site_id: str, now_ist: datetime) -> dict | None:
    return runtime_helpers.fetch_latest_whatsapp_actual(
        site_id=site_id,
        now_ist=now_ist,
        table_name=WHATSAPP_TABLE_NAME,
        boto3_module=boto3,
        ist=IST,
    )


def _schedule_value_for_block(schedule_file: Path | None, block: int) -> float | None:
    return runtime_helpers.schedule_value_for_block(schedule_file, block)


def create_schedule(state: dict, source: str, current_block_key: str, dynamic_start_block: int) -> bool:
    return create_schedule_state(
        state=state,
        source=source,
        current_block_key=current_block_key,
        dynamic_start_block=dynamic_start_block,
        active_state_value=STATE_ACTIVE_SCHEDULE_RUNNING,
        run_context_id=RUN_CONTEXT_ID,
        logger=logger,
    )


def regenerate_schedule(state: dict, source: str, current_block_key: str) -> bool:
    return regenerate_schedule_state(
        state=state,
        source=source,
        current_block_key=current_block_key,
        active_state_value=STATE_ACTIVE_SCHEDULE_RUNNING,
        run_context_id=RUN_CONTEXT_ID,
        logger=logger,
    )


# =============================================================================
# LOAD STATIC INPUTS
# =============================================================================
if os.getenv("SKIP_FETCHER", "0") != "1":
    _run_fetcher_once()


engine_now_ist = _resolve_engine_now_ist()
run_date = engine_now_ist.date()
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

intraday_dir = enercast_dir / "intraday"
intraday_file_override, intraday_override_basis = _resolve_intraday_override(intraday_dir)
if intraday_file_override is not None:
    intraday_file = intraday_file_override
else:
    intraday_file = _latest_file_in_dir(intraday_dir)
if intraday_file is None:
    raise FileNotFoundError("No intraday Enercast file found")

TEST_DATE = _date_from_enercast_csv(intraday_file)
logger.info(
    "INPUT SELECT | test_date_from_intraday=%s | intraday_file_for_test_date=%s | basis=%s",
    TEST_DATE.strftime("%Y-%m-%d") if isinstance(TEST_DATE, date) else str(TEST_DATE),
    _rel_path(intraday_file),
    (intraday_override_basis or "mtime_latest"),
)

metered_df, metered_data_available, metered_file, cfg_metered, filename_mode = input_loader_core.load_metered_input(
    metered_dir=metered_dir,
    test_date=TEST_DATE,
    site_id=SITE_ID,
    logger=logger,
)

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
block_logger_manager = BlockScheduleLogger(
    test_date=TEST_DATE,
    logs_root=logs_root_for_blocks,
    use_date_subdir=use_date_subdir_logs,
)

# Switch engine log to day-specific path for continuous runs.
# This keeps one engine log per date inside logs/<site>/<YYYY-MM-DD>/engine.log
# and makes S3 log browsing/debugging deterministic.
ENGINE_LOG_PATH = block_logger_manager.date_logs_dir / "engine.log"
logger = _configure_engine_logger(ENGINE_LOG_PATH)
logger.info(
    "ENGINE LOG INITIALIZED | site=%s | date=%s | path=%s",
    SITE_ID,
    TEST_DATE.strftime("%Y-%m-%d"),
    _rel_path(ENGINE_LOG_PATH),
)

# -----------------------------------------------------------------------------
# ENGINE STATE (persisted per day)
# -----------------------------------------------------------------------------
state = _load_state(state_path)
schedule_exists = bool(state.get("schedule_exists", False))
meter_mode = METER_MODE_NORMAL if metered_data_available else METER_MODE_NO_METER_FALLBACK
state["meter_mode"] = meter_mode
engine_state = state.get(
    "engine_state",
    STATE_ACTIVE_SCHEDULE_RUNNING if schedule_exists else STATE_WAITING_FOR_INITIAL_SCHEDULE
)
dynamic_start_raw = state.get("dynamic_start_block")
dynamic_start_block = int(dynamic_start_raw) if dynamic_start_raw is not None else None
last_schedule_block_timestamp = state.get("last_schedule_block_timestamp")
abrupt_lock_until_raw = state.get("abrupt_lock_until_block")
abrupt_lock_until_block = (
    int(abrupt_lock_until_raw) if abrupt_lock_until_raw is not None else None
)
high_flag = bool(state.get("high_flag", False))
high_event = state.get("high_event") or {"category": None, "sub_type": None, "timestamp": -1}

# -------------------------------------------------------------------------
# DYNAMODB CONTROL STATE (WhatsApp integration)
# -------------------------------------------------------------------------
planned_windows = _load_control_windows()
plant_status, curtailment_capacity = "NORMAL", None
prev_status = _normalize_status(state.get("plant_status"))
prev_curt = state.get("curtailment_capacity")
control_changed = False

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

now_ist = engine_now_ist
now_block = timestamp_to_block(now_ist)
RUN_CONTEXT_ID = _resolve_run_context_id()
engine_block_override_raw = os.getenv("ENGINE_BLOCK_OVERRIDE")
if CUSTOM_START_BLOCK is not None:
    if CUSTOM_START_BLOCK < 1 or CUSTOM_START_BLOCK > 96:
        raise ValueError(f"CUSTOM_START_BLOCK must be 1-96, got {CUSTOM_START_BLOCK}")
    engine_block = max(START_BLOCK, min(CUSTOM_START_BLOCK, GEN_END_BLOCK))
    logger.info("CUSTOM_START_BLOCK enabled: %s (engine_block=%s)", CUSTOM_START_BLOCK, engine_block)
elif engine_block_override_raw:
    try:
        override_block = int(engine_block_override_raw)
    except ValueError as exc:
        raise ValueError(f"ENGINE_BLOCK_OVERRIDE must be an integer 1-96, got {engine_block_override_raw!r}") from exc
    if override_block < 1 or override_block > 96:
        raise ValueError(f"ENGINE_BLOCK_OVERRIDE must be 1-96, got {override_block}")
    engine_block = max(START_BLOCK, min(override_block, GEN_END_BLOCK))
    logger.info(
        "ENGINE_BLOCK_OVERRIDE enabled: %s (engine_block=%s, run_ts=%s)",
        override_block,
        engine_block,
        now_ist.isoformat(),
    )
else:
    engine_block = max(START_BLOCK, min(now_block, GEN_END_BLOCK))
current_block_key = _current_block_key_ist(now_ist)
block_start_ts = pd.to_datetime(block_to_timestamp(TEST_DATE, engine_block)).to_pydatetime()
plant_status, curtailment_capacity = _current_control_state_from_windows(
    planned_windows,
    SITE_ID,
    block_start_ts,
)
control_detail = _control_detail_for_block(block_start_ts, planned_windows, SITE_ID)
if plant_status not in {"CURTAILMENT", "SHUTDOWN"}:
    curtailment_capacity = None
control_changed = (plant_status != prev_status) or (curtailment_capacity != prev_curt)
logger.info(
    "CONTROL STATE | windows_status=%s windows_cap=%s control_type=%s control_mode=%s effective_ac_cap=%s shutdown_reduction=%s | prev_status=%s prev_cap=%s | control_changed=%s",
    plant_status,
    curtailment_capacity,
    control_detail.get("control_type"),
    control_detail.get("control_mode"),
    control_detail.get("effective_control_capacity_ac_mw"),
    control_detail.get("shutdown_reduction_mw"),
    prev_status,
    prev_curt,
    control_changed,
)
slot_info = _slot_info_for_block(engine_block)
if slot_info is not None:
    window_id = int(slot_info["slot_id"])
    slot_start = int(slot_info["start_block"])
    slot_end = int(slot_info["end_block"])
    slot_key = str(window_id)
else:
    window_id = ((engine_block - 1) // WINDOW_SIZE_BLOCKS) + 1
    slot_start = (window_id - 1) * WINDOW_SIZE_BLOCKS + 1
    slot_end = slot_start + WINDOW_SIZE_BLOCKS - 1
    slot_key = str(window_id)
slot_submitted = state.get("slot_submitted", {}) or {}
slot_submitted_before = bool(slot_submitted.get(slot_key))
pending_state_updates: dict[str, object] = {}

logger.info(
    "ENGINE START | run_id=%s | site=%s | block=%s | now_ist=%s",
    RUN_CONTEXT_ID,
    SITE_ID,
    engine_block,
    now_ist.isoformat(),
)
logger.info(
    "ENGINE ITERATION | run_id=%s | site=%s | block=%s",
    RUN_CONTEXT_ID,
    SITE_ID,
    engine_block,
)
_log_raw_inputs_manifest(engine_block=engine_block, now_ist=now_ist)
intraday_trigger_enabled = os.getenv("INTRADAY_TRIGGER_ENABLED", "0").strip() not in {"", "0", "false", "False", "FALSE"}
intraday_trigger_reason_label = str(os.getenv("INTRADAY_TRIGGER_REASON_LABEL", "")).strip() or None
intraday_trigger_key = str(os.getenv("INTRADAY_TRIGGER_KEY", "")).strip() or None
strict_payload_execution = os.getenv("STRICT_PAYLOAD_EXECUTION", "0").strip().lower() in {"1", "true", "yes", "on"}
explicit_trigger_type = str(os.getenv("SCHEDULER_TRIGGER_TYPE", "")).strip().upper() or None
if not strict_payload_execution:
    raise SystemExit("Legacy non-strict scheduler orchestration is disabled; use strict payload execution")

metered_cutoff = metered_df[metered_df.block <= engine_block]
current_run_date = now_ist.date()
intraday_file_current, intraday_basis = _pick_latest_intraday_source(
    enercast_dir / "intraday", SITE_ID, current_run_date
)
if intraday_file_override is not None:
    intraday_file_current = intraday_file_override
    intraday_basis = intraday_override_basis or "intraday_override"
df_intraday = load_enercast_forecast_csv(intraday_file_current)
simulate_realtime_revision_flow = str(os.getenv("CUSTOM_SIMULATE_REALTIME_REVISION_FLOW", "")).strip().lower() in ("1", "true", "yes", "on")
if CUSTOM_START_BLOCK is not None and simulate_realtime_revision_flow:
    arrival_ist = _resolve_intraday_arrival_ist(intraday_file_current)
    if arrival_ist is None:
        arrival_ist = _resolve_engine_now_ist()
    now_ist = arrival_ist
    now_block = timestamp_to_block(now_ist)
    engine_block = max(START_BLOCK, min(now_block, GEN_END_BLOCK))
    current_block_key = _current_block_key_ist(now_ist)
    window_id = ((engine_block - 1) // WINDOW_SIZE_BLOCKS) + 1
    metered_cutoff = metered_df[metered_df.block <= engine_block]
    logger.info(
        "CUSTOM REALTIME SIMULATION | intraday=%s | arrival_ist=%s | engine_block=%s",
        intraday_file_current.name,
        now_ist.isoformat(),
        engine_block,
    )
current_run_date = now_ist.date()
intraday_by_block_current = (
    df_intraday.drop_duplicates("block", keep="last")
    .set_index("block")["forecast_mw"]
    .to_dict()
)
intraday_file_previous = _pick_previous_intraday_file(enercast_dir / "intraday", intraday_file_current)
intraday_by_block_previous = _forecast_by_block_from_csv(intraday_file_previous)
structured_logger = StructuredEngineLogger(
    log_path=ENGINE_LOG_PATH,
    site_name=SITE_ID,
    log_date=TEST_DATE,
)
intraday_rev_label = _intraday_revision_from_filename(
    intraday_file_current,
    enercast_dir / "intraday",
    current_run_date,
)
day_ahead_present = _latest_file_in_dir(enercast_dir / "day_ahead") is not None
logger.info(
    "INPUT SELECT | intraday_file_current=%s | basis=%s | local_mtime=%s",
    _rel_path(intraday_file_current),
    intraday_basis,
    float(intraday_file_current.stat().st_mtime) if intraday_file_current is not None else None,
)
logger.info(
    "INPUT SELECT | intraday_file_previous=%s | previous_available=%s",
    _rel_path(intraday_file_previous) if intraday_file_previous is not None else None,
    bool(intraday_file_previous is not None),
)

# -----------------------------------------------------------------------------
# STATE MACHINE: schedule creation / regeneration decision
# -----------------------------------------------------------------------------

generate_schedule = False
schedule_source = None
trigger_reason = None
schedule_action_kind = None
schedule_dynamic_start_block = dynamic_start_block
importance = None
iteration_reason_code = "UNSET"
iteration_reason_detail = {}

if not schedule_exists:
    engine_state = STATE_WAITING_FOR_INITIAL_SCHEDULE

normalized_intraday_reason = intraday_trigger_reason_label or f"intraday schedule {intraday_rev_label}"
current_intraday_source_key = intraday_trigger_key or _intraday_source_key(
    intraday_file_current,
    enercast_dir / "intraday",
    current_run_date,
)
effective_intraday_trigger_key = intraday_trigger_key or current_intraday_source_key
current_intraday_revision_num = _parse_revision_number(intraday_rev_label)
intraday_slot_gate_ok, intraday_slot_gate_code, intraday_slot_gate_detail = _evaluate_intraday_schedule_gate(
    engine_block,
    current_intraday_revision_num,
    bool(schedule_exists),
)
current_slot_info = _slot_info_for_block(engine_block)
current_slot_id = int(current_slot_info["slot_id"]) if current_slot_info else None
latest_whatsapp = _fetch_latest_whatsapp_actual(SITE_ID, now_ist)
deferred_high_due = False
slot_used = bool(slot_submitted.get(slot_key))
if explicit_trigger_type == "CUSTOM":
    trigger_reason = "custom_start"
    schedule_action_kind = "create"
    schedule_dynamic_start_block = engine_block
    state["dynamic_start_block"] = int(schedule_dynamic_start_block)
elif explicit_trigger_type == "PLANT_STATUS_CHANGE":
    trigger_reason = "plant_status_change"
    schedule_action_kind = "regenerate" if schedule_exists else "create"
    schedule_dynamic_start_block = engine_block
    iteration_reason_detail = {"plant_status": plant_status, "curtailment_capacity": curtailment_capacity}
elif explicit_trigger_type == "INTRADAY_REVISION":
    if current_intraday_source_key:
        trigger_reason = normalized_intraday_reason
        schedule_action_kind = "regenerate" if schedule_exists else "create"
        schedule_dynamic_start_block = engine_block
        iteration_reason_detail = {
            "reason": normalized_intraday_reason,
            "intraday_trigger_key": effective_intraday_trigger_key,
            "slot_id": int(current_slot_id) if current_slot_id is not None else None,
            "slot_start_block": int(current_slot_info["start_block"]) if current_slot_info else None,
            "slot_end_block": int(current_slot_info["end_block"]) if current_slot_info else None,
            "current_revision": int(current_intraday_revision_num) if current_intraday_revision_num is not None else None,
        }
    else:
        iteration_reason_code = "NO_INTRADAY_SOURCE"
        iteration_reason_detail = {"reason": normalized_intraday_reason}
elif explicit_trigger_type == "WHATSAPP_METER_FALLBACK":
    trigger_reason = "whatsapp_out_of_band_adjustment"
    schedule_action_kind = "regenerate" if schedule_exists else "create"
else:
    iteration_reason_code = "MISSING_TRIGGER_TYPE" if not explicit_trigger_type else "UNSUPPORTED_TRIGGER_TYPE"
    iteration_reason_detail = {"explicit_trigger_type": explicit_trigger_type}

if trigger_reason is not None:
    schedule_source = trigger_reason
    importance = "HIGH"
    if slot_used and not deferred_high_due:
        state["slot_submitted"] = slot_submitted
        _save_state(state_path, state)
        iteration_reason_code = "HIGH_PRIORITY_DEFERRED"
        iteration_reason_detail = {
            **iteration_reason_detail,
            "slot_id": int(window_id),
            "slot_submitted_before": bool(slot_submitted_before),
        }
    else:
        slot_submitted[slot_key] = True
        state["slot_submitted"] = slot_submitted
        generate_schedule = True
    logger.info(
        "IMPORTANCE_DETAIL | trigger=%s | importance=HIGH | scheduler invoked trigger is always accepted",
        trigger_reason,
    )

if generate_schedule:
    pre_submit_schedule_exists = schedule_exists
    if schedule_action_kind == "create":
        dynamic_start_block = int(schedule_dynamic_start_block or engine_block)
        generate_schedule = create_schedule(
            state=state,
            source=schedule_source,
            current_block_key=current_block_key,
            dynamic_start_block=dynamic_start_block,
        )
    else:
        generate_schedule = regenerate_schedule(
            state=state,
            source=schedule_source,
            current_block_key=current_block_key,
        )

    if generate_schedule:
        if schedule_source == normalized_intraday_reason and not pre_submit_schedule_exists:
            pass
        if current_intraday_source_key:
            pending_state_updates["last_applied_intraday_source_key"] = current_intraday_source_key
        if schedule_source == normalized_intraday_reason and intraday_trigger_enabled:
            pending_state_updates["last_intraday_trigger_key"] = effective_intraday_trigger_key
        if schedule_source == "whatsapp_out_of_band_adjustment":
            pending_state_updates["last_whatsapp_regen_block"] = int(engine_block)
    else:
        duplicate_reason_map = {
            "custom_start": "CUSTOM_START_DUPLICATE_GUARD",
            "plant_status_change": "PLANT_STATUS_CHANGE_DUPLICATE_GUARD",
            "whatsapp_out_of_band_adjustment": "WHATSAPP_OUT_OF_BAND_DUPLICATE_GUARD",
        }
        if schedule_source == normalized_intraday_reason:
            iteration_reason_code = (
                "INTRADAY_INITIAL_DUPLICATE_GUARD"
                if not pre_submit_schedule_exists
                else "INTRADAY_REVISION_DUPLICATE_GUARD"
            )
        else:
            iteration_reason_code = duplicate_reason_map.get(schedule_source, "DUPLICATE_GUARD")
elif trigger_reason is None and iteration_reason_code == "UNSET":
    iteration_reason_code = "NO_TRIGGER"

if generate_schedule and iteration_reason_code == "UNSET":
    success_reason_map = {
        "custom_start": "CUSTOM_START",
        "plant_status_change": "PLANT_STATUS_CHANGE",
        "whatsapp_out_of_band_adjustment": "WHATSAPP_OUT_OF_BAND",
    }
    if schedule_source == normalized_intraday_reason:
        iteration_reason_code = (
            "INTRADAY_INITIAL_TRIGGER"
            if not pre_submit_schedule_exists
            else "INTRADAY_REVISION_TRIGGER"
        )
    else:
        iteration_reason_code = success_reason_map.get(schedule_source, "SCHEDULE_TRIGGERED")

logger.info(
    "ITERATION OUTCOME | run_id=%s | generated=%s | reason_code=%s | schedule_source=%s | "
    "schedule_exists=%s | engine_state=%s | "
    "plant_status=%s | curtailment_capacity=%s | control_changed=%s | "
    "abrupt_state=%s | abrupt_lock_until=%s | detail=%s",
    RUN_CONTEXT_ID,
    bool(generate_schedule),
    iteration_reason_code,
    schedule_source,
    bool(schedule_exists),
    state.get("engine_state"),
    plant_status,
    curtailment_capacity,
    bool(control_changed),
    None,
    abrupt_lock_until_block,
    iteration_reason_detail,
)

if not generate_schedule:
    slot_used_before_txt = "YES" if bool(slot_submitted_before) else "NO"
    slot_used_after_txt = "YES" if bool(slot_submitted.get(slot_key)) else "NO"
    importance_txt = str(importance) if importance is not None else "NA"
    rejection_category = "NO_GENERATION_TRIGGER"
    no_schedule_reason = str(iteration_reason_code or "NO_TRIGGER")
    no_schedule_event = (
        "NO_TRIGGER_NO_SCHEDULE_GENERATED"
        if trigger_reason is None
        else "TRIGGER_NO_SCHEDULE_GENERATED"
    )
    hhmm_now = now_ist.strftime("%H:%M")
    logger.info(
        "%s | run_id=%s | site=%s | block=%s | reason_code=%s | detail=%s",
        no_schedule_event,
        RUN_CONTEXT_ID,
        SITE_ID,
        int(engine_block),
        no_schedule_reason,
        iteration_reason_detail,
    )
    detail = BlockDetail(
        block=int(engine_block),
        hhmm=hhmm_now,
        generated=False,
        reason_code=no_schedule_reason,
        trigger_type=str(schedule_source or "-"),
        threshold=None,
        dynamic_start_decision="NA",
        schedule_exists=("YES" if schedule_exists else "NO"),
        schedule_source=str(schedule_source or "-"),
        output_file=None,
        validation_status="NO_SCHEDULE_GENERATED",
        reject_reason=f"no_schedule:{no_schedule_reason}",
        intraday_rev=intraday_rev_label,
        intraday_status=("updated" if intraday_trigger_enabled else "no update"),
        day_ahead_status=("downloaded" if day_ahead_present else "not downloaded"),
        submission_status="NO",
        slot_used_before=slot_used_before_txt,
        slot_used_after=slot_used_after_txt,
        importance=importance_txt,
        rejection_category=rejection_category,
    )
    structured_logger.append_summary_line(
        block=int(engine_block),
        generated=False,
        reason=no_schedule_reason,
        rejected=False,
        submission_status="NO",
        slot_used_before=slot_used_before_txt,
        slot_used_after=slot_used_after_txt,
        rejection_category=rejection_category,
    )
    structured_logger.append_no_generation_detail(detail)
    logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")
    raise SystemExit(0)

if CUSTOM_START_BLOCK is not None:
    run_stamp = now_ist.strftime("%Y%m%d_%H%M%S")
    custom_log_filename = f"schedule from {engine_block} block {intraday_rev_label} {run_stamp}.log"
else:
    custom_log_filename = f"schedule from {engine_block} block {intraday_rev_label}.log"

schedule_log_path = block_logger_manager.date_logs_dir / custom_log_filename
logger.info("DETAIL LOG | schedule_run_log=%s", _rel_path(schedule_log_path))

if generate_schedule:
    # Persist control state with the schedule run
    state["plant_status"] = plant_status
    state["curtailment_capacity"] = curtailment_capacity
    _save_state(state_path, state)

if dynamic_start_block is None:
    dynamic_start_block = int(START_BLOCK)
    state["dynamic_start_block"] = int(dynamic_start_block)
    _save_state(state_path, state)

schedule_reason_fields = _derive_schedule_reason_fields(schedule_source, plant_status)
schedule_reason_label = str(schedule_reason_fields["label"])

schedule_logger = block_logger_manager.get_logger_for_schedule(engine_block, log_filename=custom_log_filename)

block_logger_manager.log_schedule_header(
    schedule_logger,
    engine_block,
    TEST_DATE,
    dynamic_start_block=dynamic_start_block,
    schedule_reason=schedule_reason_label,
)
rows = []
previous_schedule = load_previous_schedule(
    previous_schedule_file=previous_schedule_file,
    custom_start_block=CUSTOM_START_BLOCK,
    simulate_realtime_revision_flow=simulate_realtime_revision_flow,
    day_ahead_dir=enercast_dir / "day_ahead",
    site_id=SITE_ID,
    run_date=current_run_date,
    pick_da2_reference_file=_pick_da2_reference_file,
    logger=logger,
    rel_path=_rel_path,
)
prev_df = previous_schedule.frame
previous_schedule_file = previous_schedule.path
intraday_by_block = (
    df_intraday.drop_duplicates("block", keep="last")
    .set_index("block")["forecast_mw"]
    .to_dict()
)
try:
    reference_forecast = select_reference_forecast(
        intraday_dir=enercast_dir / "intraday",
        current_intraday_file=intraday_file_current,
        day_ahead_dir=enercast_dir / "day_ahead",
        site_id=SITE_ID,
        run_date=current_run_date,
        forecast_by_block_from_csv=_forecast_by_block_from_csv,
        pick_da2_reference_file=_pick_da2_reference_file,
    )
    reference_forecast_by_block = reference_forecast.by_block
    reference_forecast_source = reference_forecast.source
except Exception:
    reference_forecast_by_block = {}
    reference_forecast_source = "none"
logger.info("REFERENCE FORECAST SOURCE | %s", reference_forecast_source)
is_first_schedule = prev_df is None
intraday_t = float(intraday_by_block.get(engine_block, 0.0) or 0.0)

intraday_window_applies = bool(
    intraday_trigger_enabled
    and schedule_source == normalized_intraday_reason
)
prev_map = (
    prev_df.set_index("block")["algo_schedule_mw"].to_dict()
    if prev_df is not None and "block" in prev_df.columns
    else {}
)

for b in range(START_BLOCK, GEN_END_BLOCK + 1):
    block_start_ts = block_to_timestamp(TEST_DATE, b)
    block_control_status, block_control_cap = _resolve_block_control(
        block_start_ts,
        live_status="NORMAL",
        live_curtailment_capacity=None,
        planned_windows=planned_windows,
        site_id=SITE_ID,
    )
    block_curtailment_scale = None
    if (
        block_control_status in {"CURTAILMENT", "SHUTDOWN"}
        and block_control_cap is not None
        and PLANT_CAPACITY_MW > 0
    ):
        if float(block_control_cap) > float(PLANT_CAPACITY_MW):
            logger.warning(
                "Control capacity %.3f MW exceeds plant capacity %.3f MW; capping to plant capacity",
                float(block_control_cap),
                float(PLANT_CAPACITY_MW),
            )
            block_control_cap = float(PLANT_CAPACITY_MW)
        block_curtailment_scale = float(block_control_cap) / float(PLANT_CAPACITY_MW)

    intraday = float(intraday_by_block.get(b, 0.0) or 0.0)
    intraday_effective = intraday
    intraday_weight = 1.0
    irr_ratio = 0.0
    base_adj = 0.0
    base_forecast_raw = None
    effective_base_forecast = None

    if prev_df is not None and b < engine_block:
        cond = "FROZEN"
        adj_pct = 0.0
        base_forecast = float(prev_map.get(b, 0.0) or 0.0)
        base_forecast_raw = base_forecast
        effective_base_forecast = base_forecast
        algo_raw = float(prev_map.get(b, 0.0) or 0.0)
        operation = "NONE"
        formula_text = "FROZEN: reuse previous schedule"
    elif b < dynamic_start_block:
        cond = "PRE_START"
        adj_pct = 0.0
        algo_raw = 0.0
        operation = "NONE"
        base_forecast = 0.0
        base_forecast_raw = 0.0
        effective_base_forecast = 0.0
        formula_text = "PRE_START: mw=0 (intraday-only mode; no day-ahead baseline)"
    else:
        base_forecast_raw = float(intraday_effective)
        effective_base_forecast = base_forecast_raw
        if block_control_status in {"CURTAILMENT", "SHUTDOWN"} and block_curtailment_scale is not None:
            effective_base_forecast = effective_base_forecast * block_curtailment_scale
        elif block_control_status == "SHUTDOWN":
            effective_base_forecast = 0.0
        base_forecast = effective_base_forecast
        if (
            block_control_status in {"CURTAILMENT", "SHUTDOWN"}
            and block_curtailment_scale is not None
            and block_control_cap is not None
            and PLANT_CAPACITY_MW > 0
            and base_forecast_raw is not None
            and effective_base_forecast is not None
        ):
            block_control_type = "PARTIAL_SHUTDOWN" if block_control_status == "SHUTDOWN" else "CURTAILMENT"
            schedule_logger.info("--- CONTROL CAP BASE FLOW ---")
            schedule_logger.info(
                "Control Type: %s | Base Forecast (raw): %.3f MW",
                block_control_type,
                base_forecast_raw,
            )
            schedule_logger.info(
                "Control Scale = effective_control_capacity / plant_capacity = "
                "%.3f / %.3f = %.6f",
                block_control_cap,
                PLANT_CAPACITY_MW,
                block_curtailment_scale,
            )
            schedule_logger.info(
                "Effective Base Forecast = Base Forecast (raw) * Control Scale = "
                "%.3f * %.6f = %.3f MW",
                base_forecast_raw,
                block_curtailment_scale,
                effective_base_forecast,
            )
        algo_raw = float(base_forecast)
        cond = "BASE_ONLY"
        adj_pct = 0.0
        operation = "NONE"
        base_adj = 0.0
        trend_type = "FLAT"
        slope_pct = 0.0
        formula_text = "raw=base_forecast"

    # ---------------------------------------------------------------------
    # Enercast accommodation check:
    # compare current vs previous reference forecast block-wise and apply only
    # residual weather adjustment when Enercast has already accommodated part/full.
    # ---------------------------------------------------------------------
    accommodation_state = "NOT_EVALUATED"
    accommodation_reason = "disabled_or_not_applicable"
    ref_forecast = None
    enercast_delta = None
    system_delta = None
    sign_e = None
    sign_w = None
    enercast_effect = None
    direction_match = None
    magnitude_match = None
    residual_before_clamp = None
    residual_after_clamp = None
    residual_cap = None
    required_magnitude = None

    is_plant_status_run = schedule_source == "plant_status_change"
    planned_recovery_accommodation = False
    allow_accommodation = bool(
        ACCOMMODATION_ENABLE
        and b >= engine_block
        and cond not in {"FROZEN", "PRE_START"}
        and block_control_status == "NORMAL"
        and (
            (not is_plant_status_run)
            or planned_recovery_accommodation
        )
    )

    if allow_accommodation:
        ref_forecast = reference_forecast_by_block.get(int(b))
        if ref_forecast is not None:
            enercast_delta = float(intraday) - float(ref_forecast)
            system_delta = float(algo_raw) - float(base_forecast)
            if abs(system_delta) >= float(ACCOMMODATION_MIN_WEATHER_DELTA_MW):
                sign_e = 0 if abs(enercast_delta) < 1e-9 else (1 if enercast_delta > 0 else -1)
                sign_w = 0 if abs(system_delta) < 1e-9 else (1 if system_delta > 0 else -1)
                enercast_effect = float(intraday_weight) * float(enercast_delta)
                direction_match = (sign_e == sign_w) or (sign_w == 0)
                required_magnitude = float(ACCOMMODATION_MATCH_ALPHA) * abs(system_delta)
                magnitude_match = (
                    abs(system_delta) < 1e-9
                    or abs(enercast_effect) >= required_magnitude
                )

                accommodation_state = "NOT_ACCOMMODATED"
                if direction_match and magnitude_match:
                    accommodation_state = "ACCOMMODATED"
                    accommodation_reason = "direction_match_and_magnitude_match"
                    algo_raw = float(intraday)
                elif direction_match:
                    accommodation_state = "PARTIAL"
                    accommodation_reason = "direction_match_but_magnitude_partial"
                    residual = system_delta - (float(ACCOMMODATION_RESIDUAL_GAMMA) * enercast_effect)
                    residual_before_clamp = float(residual)
                    residual_cap = max(float(base_forecast), 0.0) * (float(ACCOMMODATION_MAX_RESIDUAL_PCT) / 100.0)
                    residual = clamp(float(residual), -residual_cap, residual_cap)
                    residual_after_clamp = float(residual)
                    algo_raw = float(base_forecast) + float(residual)
                else:
                    accommodation_reason = "direction_mismatch_or_no_enercast_adjustment"
                # else keep full scheduler weather adjustment (algo_raw unchanged)

                formula_text = (
                    f"{formula_text} | accommodation={accommodation_state}"
                    f" | ref={ref_forecast:.3f}"
                    f" | enercast_delta={enercast_delta:.3f}"
                    f" | system_delta={system_delta:.3f}"
                )
            else:
                accommodation_state = "LOW_SIGNAL"
                accommodation_reason = "system_delta_below_min_threshold"
                # When scheduler weather delta itself is below minimum signal threshold,
                # keep Enercast intraday value as-is for this block.
                algo_raw = float(intraday)
                formula_text = (
                    f"{formula_text} | accommodation={accommodation_state}"
                    f" | ref={ref_forecast:.3f}"
                    f" | enercast_delta={enercast_delta:.3f}"
                    f" | system_delta={system_delta:.3f}"
                    f" | applied=intraday_as_is"
                )
        else:
            accommodation_state = "REFERENCE_MISSING"
            accommodation_reason = "no_reference_forecast_for_block"
    elif (
        ACCOMMODATION_ENABLE
        and b >= engine_block
        and cond not in {"FROZEN", "PRE_START"}
    ):
        if block_control_status != "NORMAL":
            accommodation_reason = "disabled_for_non_normal_control_status"
        elif is_plant_status_run and not planned_recovery_accommodation:
            accommodation_reason = "disabled_for_non_planned_recovery_plant_status_run"

    if b >= engine_block:
        schedule_logger.info(
            "ENERCAST ACCOMMODATION | block=%s | state=%s | reason=%s",
            int(b),
            accommodation_state,
            accommodation_reason,
        )
        if accommodation_state not in ("NOT_ACCOMMODATED", "LOW_SIGNAL") or block_control_status != "NORMAL":
            schedule_logger.info(
                "ENERCAST ACCOMMODATION INPUTS | intraday_curr=%.3f | reference=%s | base=%.3f | algo_raw_before_post=%.3f",
                float(intraday),
                ("NA" if ref_forecast is None else f"{float(ref_forecast):.3f}"),
                float(base_forecast),
                float(algo_raw),
            )
            if enercast_delta is not None and system_delta is not None:
                schedule_logger.info(
                    "ENERCAST ACCOMMODATION DELTAS | enercast_delta=%.3f | system_delta=%.3f | enercast_effect(weighted)=%.3f",
                    float(enercast_delta),
                    float(system_delta),
                    float(enercast_effect if enercast_effect is not None else 0.0),
                )
                schedule_logger.info(
                    "ENERCAST ACCOMMODATION CHECKS | sign_e=%s | sign_w=%s | direction_match=%s | required_magnitude=%.3f | magnitude_match=%s",
                    str(sign_e),
                    str(sign_w),
                    str(direction_match),
                    float(required_magnitude if required_magnitude is not None else 0.0),
                    str(magnitude_match),
                )
            if residual_before_clamp is not None or residual_after_clamp is not None:
                schedule_logger.info(
                    "ENERCAST ACCOMMODATION RESIDUAL | residual_before=%.3f | residual_cap=%.3f | residual_after=%.3f",
                    float(residual_before_clamp if residual_before_clamp is not None else 0.0),
                    float(residual_cap if residual_cap is not None else 0.0),
                    float(residual_after_clamp if residual_after_clamp is not None else 0.0),
                )

    effective_base = (
        effective_base_forecast
        if effective_base_forecast is not None
        else base_forecast
    )

    algo = algo_raw

    receivable_bias_info = None
    below_meter_applied = False
    if (
        b >= engine_block
        and _osepl_receivable_bias_enabled()
        and block_control_status == "NORMAL"
        and (effective_base is not None and float(effective_base) >= float(RECEIVABLE_MIN_BASE_MW))
        and irr_ratio >= float(RECEIVABLE_MIN_IRR_RATIO)
        and schedule_source != "plant_status_change"
    ):
        biased_algo, receivable_bias_info = _apply_receivable_bias(
            schedule_mw=algo,
            expected_gen_mw=effective_base,
            over_min_pct=RECEIVABLE_OVER_MIN_PCT,
            over_target_pct=RECEIVABLE_OVER_TARGET_PCT,
            over_max_pct=RECEIVABLE_OVER_MAX_PCT,
        )
        if float(biased_algo) != float(algo):
            schedule_logger.info(
                "Receivable bias applied | block=%s | algo=%.3f -> %.3f | "
                "expected=%.3f | target_over=%.2f%% | band=[%.2f%%..%.2f%%]",
                int(b),
                float(algo),
                float(biased_algo),
                float(effective_base),
                float(RECEIVABLE_OVER_TARGET_PCT),
                float(RECEIVABLE_OVER_MIN_PCT),
                float(RECEIVABLE_OVER_MAX_PCT),
            )
            algo = float(biased_algo)

    if b >= engine_block and _osepl_receivable_bias_enabled() and RECEIVABLE_FORCE_BELOW_METER:
        pass

    control_reason = None
    if b >= engine_block:
        algo, control_reason = _apply_control_overrides(
            algo, plant_status=block_control_status, curtailment_capacity=block_control_cap
        )
    if control_reason:
        if formula_text:
            formula_text = f"{formula_text} | control={control_reason}"
        else:
            formula_text = f"control={control_reason}"

    if b >= engine_block:
        schedule_logger.info(
            "FINAL BLOCK SCHEDULE | block=%s | final_algo=%.3f | intraday=%.3f | reference=%s | reference_source=%s | accommodation=%s | accepted=%s",
            int(b),
            float(algo),
            float(intraday) if intraday is not None else float("nan"),
            ("NA" if ref_forecast is None else f"{float(ref_forecast):.3f}"),
            reference_forecast_source,
            accommodation_state,
            bool(accepted) if "accepted" in locals() else True,
        )

    # Log detailed block calculation
    block_logger_manager.log_block_calculation(
        schedule_logger,
        block=b,
        is_frozen=(prev_df is not None and b < engine_block),
        frozen_algo_value=prev_map.get(b) if (prev_df is not None and b < engine_block) else None,
        intraday_forecast=intraday,
        dayahead_forecast=0.0,
        base_forecast=base_forecast,
        base_forecast_raw=base_forecast_raw,
        effective_base_forecast=effective_base,
        plant_status=block_control_status,
        curtailment_capacity=block_control_cap,
        curtailment_scale=block_curtailment_scale,
        plant_capacity_mw=PLANT_CAPACITY_MW,
        irr_ratio=irr_ratio,
        condition_used=cond,
        operation=operation,
        base_adjustment_pct=base_adj,
        final_adjustment_pct=adj_pct,
        formula_text=formula_text,
        algo_schedule=algo,
        previous_schedule_value=prev_map.get(b) if prev_df is not None else None,
        raw_schedule_value=algo_raw,
        receivable_bias_info=receivable_bias_info,
        below_meter_bias=below_meter_applied,
    )

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


generation_token = _safe_file_token(now_ist.strftime("%Y%m%dT%H%M%S"))
intraday_rev_token = _safe_file_token(intraday_rev_label)
# Preserve legacy continuous/lambda filename contract for downstream parsers.
# Only custom runs keep revision-suffixed schedule filenames.
if CUSTOM_START_BLOCK is None:
    out_file = OUTPUT_DAY / f"schedule_from_{engine_block:02d}_{generation_token}.csv"
else:
    out_file = OUTPUT_DAY / f"schedule_from_{engine_block:02d}_{intraday_rev_token}.csv"
new_sched_df = pd.DataFrame(rows)
accepted = True
reject_reason: str | None = None
importance = "HIGH"
logger.info(
    "SCHEDULE ACCEPTANCE | trigger=%s | importance=HIGH | decision=ACCEPTED | reason=scheduler_invoked_trigger",
    schedule_source,
)
schedule_logger.info(
    "SCHEDULE ACCEPTANCE | site=%s | trigger=%s | importance=HIGH | decision=ACCEPTED | reason=scheduler_invoked_trigger",
    SITE_ID,
    schedule_source,
)

if accepted:
    if pending_state_updates:
        state.update(pending_state_updates)
    write_schedule_artifacts(
        schedule_df=new_sched_df,
        out_file=out_file,
        schedule_reason_label=schedule_reason_label,
        schedule_reason_fields=schedule_reason_fields,
        engine_block=engine_block,
        window_id=window_id,
        importance=importance,
        dynamic_start_block=dynamic_start_block,
        now_ist=now_ist,
        timezone=IST,
        plant_status=plant_status,
        curtailment_capacity=curtailment_capacity,
        control_detail=control_detail,
        rel_path=_rel_path,
        logger=logger,
    )
    previous_schedule_file = out_file
    write_schedule_graph(
        generate_schedule_graph=generate_schedule_graph,
        schedule_csv=out_file,
        intraday_df=df_intraday,
        metered_df=metered_df,
        current_block=engine_block,
        output_dir=graph_output_dir,
        intraday_rev_token=intraday_rev_token,
        intraday_rev_label=intraday_rev_label,
        logger=logger,
    )
    if importance == "HIGH" or deferred_high_due:
        state["high_flag"] = False
        state["high_event"] = {"category": None, "sub_type": None, "timestamp": -1}
    state["control"] = control_detail
    state["control_mode"] = control_detail.get("control_mode")
    state["control_type"] = control_detail.get("control_type")
    state["effective_control_capacity_ac_mw"] = control_detail.get("effective_control_capacity_ac_mw")
    state["shutdown_reduction_mw"] = control_detail.get("shutdown_reduction_mw")
    state["site_ac_capacity_mw"] = control_detail.get("site_ac_capacity_mw")
    state["site_dc_capacity_mw"] = control_detail.get("site_dc_capacity_mw")
    state["dc_ac_ratio"] = control_detail.get("dc_ac_ratio")
    _save_state(state_path, state)

hhmm_now = now_ist.strftime("%H:%M")
slot_used_before_txt = "YES" if bool(slot_submitted_before) else "NO"
slot_used_after_txt = "YES" if bool(slot_submitted.get(slot_key)) else "NO"
importance_txt = str(importance) if importance is not None else "NA"
rejection_category = None
generated_detail = BlockDetail(
    block=int(engine_block),
    hhmm=hhmm_now,
    generated=True,
    reason_code=str(iteration_reason_code),
    trigger_type=str(schedule_source or "-"),
    threshold=None,
    dynamic_start_decision="NA",
    schedule_exists=("YES" if schedule_exists else "NO"),
    schedule_source=schedule_reason_label,
    output_file=(out_file.name if accepted else (previous_schedule_file.name if previous_schedule_file else None)),
    validation_status=("ACCEPTED" if accepted else "REJECTED"),
    reject_reason=reject_reason,
    intraday_rev=intraday_rev_label,
    intraday_status=("updated" if intraday_trigger_enabled else "no update"),
    day_ahead_status=("downloaded" if day_ahead_present else "not downloaded"),
    submission_status=("YES" if accepted else "NO"),
    slot_used_before=slot_used_before_txt,
    slot_used_after=slot_used_after_txt,
    importance=importance_txt,
    rejection_category=rejection_category,
)
structured_logger.append_summary_line(
    block=int(engine_block),
    generated=True,
    reason=str(iteration_reason_code),
    rejected=(not accepted),
    submission_status=("YES" if accepted else "NO"),
    slot_used_before=slot_used_before_txt,
    slot_used_after=slot_used_after_txt,
    rejection_category=rejection_category,
)
structured_logger.append_generated_detail(generated_detail)

logger.info("===== CONDITION-3 PHASE-6 ENGINE COMPLETED =====")

# =============================================================================
# COMBINED CSV
# =============================================================================
if os.getenv("SKIP_COMBINED_CSV", "0").strip() == "1":
    logger.info("Skipping Combined CSV generation (SKIP_COMBINED_CSV=1)")
else:
    write_combined_csv(
        final_schedule_path=previous_schedule_file,
        df_intraday=df_intraday,
        metered_df=metered_df,
        root_dir=root_dir,
        data_root=DATA_ROOT,
        combined_dir=combined_dir,
        test_date=TEST_DATE,
        penalty_band_mw=_penalty_band_mw(),
        rel_path=_rel_path,
        logger=logger,
    )










