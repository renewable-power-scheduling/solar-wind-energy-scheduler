import logging
import os
import numpy as np

from utils.site_config_loader import load_site_config

logger = logging.getLogger(__name__)

# ---------------- CONFIG ----------------
MIN_TREND_PTS = 2       # minimum points to compute trend
TREND_EPS_PCT = 1.5     # trend noise threshold (%)
EPS_SMALL_WM2 = 50.0    # minimum GTI for ratio stability
LOW_GTI_IRR_RATIO_DISABLE = 0.15  # disable weather multiplier below this ratio


SITE_ID = os.getenv("SITE_ID", "").strip().upper()

DEFAULT_ADJ_OVERRIDES = {
    "base_adjustment_thresholds": [6, 4, 2],
    "base_adjustment_values": [10, 7.5, 5.0, 2.5],
    "irradiance_state_thresholds": {
        "STABLE_CLEAR": 0.75,
        "VARIABLE_CLEAR": 0.45,
        "CLOUD_TRANSIENT": 0.20,
    },
    "irradiance_multiplier": {
        "STABLE_CLEAR": 1.15,
        "VARIABLE_CLEAR": 1.00,
        "CLOUD_TRANSIENT": 0.70,
        "OVERCAST": 0.55,
    },
    "temp_multiplier_thresholds": [40, 35, 25],
    "temp_multiplier_values": [0.95, 0.97, 1.00, 1.03],
    "wind_multiplier_thresholds": [1.5, 3, 5],
    "wind_multiplier_values": [0.95, 1.00, 1.03, 1.05],
}


def _load_adjustment_overrides() -> dict:
    if not SITE_ID:
        logger.warning("SITE_ID missing; using default adjustment_overrides")
        return {}

    try:
        cfg = load_site_config(SITE_ID)
    except Exception as exc:
        logger.warning(
            "Failed to load site config for SITE_ID=%s; using defaults (%s)",
            SITE_ID,
            exc,
        )
        return {}

    if not isinstance(cfg, dict):
        logger.warning("Invalid site config for SITE_ID=%s; using defaults", SITE_ID)
        return {}

    overrides = cfg.get("adjustment_overrides")
    if not isinstance(overrides, dict):
        logger.warning(
            "adjustment_overrides missing/invalid for SITE_ID=%s; using defaults",
            SITE_ID,
        )
        return {}
    return overrides


ADJ_OVERRIDES = _load_adjustment_overrides()


def _get_override(key: str):
    value = ADJ_OVERRIDES.get(key, DEFAULT_ADJ_OVERRIDES.get(key))
    if isinstance(value, dict) and isinstance(DEFAULT_ADJ_OVERRIDES.get(key), dict):
        merged = dict(DEFAULT_ADJ_OVERRIDES[key])
        merged.update(value)
        return merged
    return value


def compute_trend(past_block_values, eps_pct: float = TREND_EPS_PCT):
    """
    past_block_values: [(block, value, source), ...]
    Must be in ANY order.
    Returns: trend_type, slope_pct
    """
    if len(past_block_values) < MIN_TREND_PTS:
        logger.info("Trend: insufficient data -> FLAT")
        return "FLAT", 0.0

    past_block_values = sorted(past_block_values, key=lambda x: x[0])
    values = [v[1] for v in past_block_values]
    x = np.arange(len(values))
    y = np.array(values, dtype=float)

    slope, intercept = np.polyfit(x, y, 1)
    first_val = intercept
    last_val = slope * (len(values) - 1) + intercept

    if first_val <= 0:
        logger.warning("Trend: first value <= 0, forcing FLAT")
        return "FLAT", 0.0

    slope_pct = (last_val - first_val) / first_val * 100
    logger.info(
        f"Trend raw calc | first={first_val:.3f}, last={last_val:.3f}, "
        f"slope_pct={slope_pct:.2f}%"
    )

    if slope_pct > eps_pct:
        return "INCREASING", slope_pct
    if slope_pct < -eps_pct:
        return "DECREASING", slope_pct
    return "FLAT", slope_pct


def compute_base_adjustment(slope_pct):
    """
    Piecewise base adjustment buckets.
    """
    thresholds = _get_override("base_adjustment_thresholds")
    values = _get_override("base_adjustment_values")
    if not isinstance(thresholds, (list, tuple)) or len(thresholds) != 3:
        raise ValueError("base_adjustment_thresholds must be a list of 3 numbers")
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        raise ValueError("base_adjustment_values must be a list of 4 numbers")

    abs_slope = abs(slope_pct)
    if abs_slope >= thresholds[0]:
        base_adj = float(values[0])
    elif abs_slope >= thresholds[1]:
        base_adj = float(values[1])
    elif abs_slope >= thresholds[2]:
        base_adj = float(values[2])
    else:
        base_adj = float(values[3])

    logger.info(
        f"BaseAdj calc | |slope|={abs_slope:.2f}%, base_adj={base_adj:.2f}%"
    )
    return base_adj


def compute_irradiance_state(gti: float, max_gti_today: float) -> str:
    irr_thresholds = _get_override("irradiance_state_thresholds")
    if not isinstance(irr_thresholds, dict):
        raise ValueError("irradiance_state_thresholds must be a dict")

    irr_ratio_b = gti / max(max_gti_today, 1.0)
    if irr_ratio_b > float(irr_thresholds["STABLE_CLEAR"]):
        return "STABLE_CLEAR"
    if irr_ratio_b > float(irr_thresholds["VARIABLE_CLEAR"]):
        return "VARIABLE_CLEAR"
    if irr_ratio_b > float(irr_thresholds["CLOUD_TRANSIENT"]):
        return "CLOUD_TRANSIENT"
    return "OVERCAST"


def compute_irradiance_multiplier(irradiance_state: str) -> float:
    irr_mult = _get_override("irradiance_multiplier")
    if not isinstance(irr_mult, dict):
        raise ValueError("irradiance_multiplier must be a dict")

    if irradiance_state == "STABLE_CLEAR":
        return float(irr_mult["STABLE_CLEAR"])
    if irradiance_state == "VARIABLE_CLEAR":
        return float(irr_mult["VARIABLE_CLEAR"])
    if irradiance_state == "CLOUD_TRANSIENT":
        return float(irr_mult["CLOUD_TRANSIENT"])
    return float(irr_mult["OVERCAST"])


def compute_temp_multiplier(temp_2m: float) -> float:
    thresholds = _get_override("temp_multiplier_thresholds")
    values = _get_override("temp_multiplier_values")
    if not isinstance(thresholds, (list, tuple)) or len(thresholds) != 3:
        raise ValueError("temp_multiplier_thresholds must be a list of 3 numbers")
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        raise ValueError("temp_multiplier_values must be a list of 4 numbers")

    if temp_2m >= thresholds[0]:
        return float(values[0])
    if temp_2m >= thresholds[1]:
        return float(values[1])
    if temp_2m >= thresholds[2]:
        return float(values[2])
    return float(values[3])


def compute_wind_multiplier(wind_speed_10m: float) -> float:
    thresholds = _get_override("wind_multiplier_thresholds")
    values = _get_override("wind_multiplier_values")
    if not isinstance(thresholds, (list, tuple)) or len(thresholds) != 3:
        raise ValueError("wind_multiplier_thresholds must be a list of 3 numbers")
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        raise ValueError("wind_multiplier_values must be a list of 4 numbers")

    if wind_speed_10m < thresholds[0]:
        return float(values[0])
    if wind_speed_10m < thresholds[1]:
        return float(values[1])
    if wind_speed_10m < thresholds[2]:
        return float(values[2])
    return float(values[3])


# ---------------- MAIN LOGIC ----------------
def apply_condition3(
    block,
    base_forecast,
    intraday_forecast,
    weather_state,
    gti,
    dhi,
    temp_2m,
    wind_speed_10m,
    past_block_values,
    max_gti_today,
    dampen_factor=1.0,
    return_details=False
):
    """
    CONDITION-3 PHASE-6 LOGIC (irradiance + temperature + wind multipliers)
    """
    # STEP 1: Trend detection
    trend_type, slope_pct = compute_trend(past_block_values, eps_pct=TREND_EPS_PCT)

    # STEP 2: Base adjustment (continuous)
    base_adj = compute_base_adjustment(slope_pct)

    # STEP 3: Decide operation (weather state no longer overrides direction)
    if trend_type == "INCREASING":
        operation = "ADD"
    elif trend_type == "DECREASING":
        operation = "SUBTRACT"
    else:
        operation = "ADD"

    logger.info(
        f"Operation decision | trend={trend_type}, "
        f"weather_state={weather_state}, operation={operation}"
    )

    # STEP 4: Multipliers
    irradiance_state = compute_irradiance_state(gti, max_gti_today=max_gti_today)
    irradiance_multiplier = compute_irradiance_multiplier(irradiance_state)
    temp_multiplier = compute_temp_multiplier(temp_2m)
    wind_multiplier = compute_wind_multiplier(wind_speed_10m)

    irr_ratio = gti / max(max_gti_today, 1.0)
    if irr_ratio < LOW_GTI_IRR_RATIO_DISABLE:
        weather_multiplier = 1.0
        logger.info(
            "Low GTI ratio (%.3f) -> weather multiplier disabled (1.00x)",
            irr_ratio,
        )
    else:
        weather_multiplier = (
            irradiance_multiplier * temp_multiplier * wind_multiplier
        )

    logger.info(
        f"Irradiance | state={irradiance_state}, mult={irradiance_multiplier:.2f}x"
    )
    logger.info(
        f"Temp/Wind | temp_2m={temp_2m:.2f} C ({temp_multiplier:.2f}x), "
        f"wind_10m={wind_speed_10m:.2f} m/s ({wind_multiplier:.2f}x)"
    )
    logger.info(f"Combined multiplier = {weather_multiplier:.3f}x")

    # STEP 5: Final adjustment %
    final_adj_pct = base_adj * weather_multiplier

    if operation == "SUBTRACT":
        final_adj_pct = -abs(final_adj_pct)
    else:
        final_adj_pct = abs(final_adj_pct)

    if dampen_factor != 1.0:
        final_adj_pct = final_adj_pct * dampen_factor
        logger.info(f"DampenFactor = {dampen_factor:.2f}x")

    logger.info(f"FinalAdjPct = {final_adj_pct:.2f}%")

    # STEP 6: Final schedule
    algo_schedule = base_forecast * (1 + final_adj_pct / 100)

    logger.info(
        f"Final Schedule | block={block}, base={base_forecast:.3f}, "
        f"algo={algo_schedule:.3f}"
    )

    if return_details:
        return (
            "CONDITION_3",
            final_adj_pct,
            algo_schedule,
            trend_type,
            slope_pct,
            operation,
            base_adj,
            weather_multiplier,
            irradiance_state,
            irradiance_multiplier,
            temp_multiplier,
            wind_multiplier,
        )

    return "CONDITION_3", final_adj_pct, algo_schedule



