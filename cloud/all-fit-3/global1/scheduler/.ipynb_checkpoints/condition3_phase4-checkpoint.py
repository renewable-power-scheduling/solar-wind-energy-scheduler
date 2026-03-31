
# scheduler/condition3_phase4.py

from typing import List, Tuple
import logging
import numpy as np

logger = logging.getLogger("PHASE4")

# -------------------------------------------------
# Trend Detection (STABLE)
# -------------------------------------------------
def detect_trend(trend_values: List[float]):
    """
    trend_values: oldest → latest MW values
    Returns: (trend_type, slope_pct)
    """

    if trend_values is None or len(trend_values) < 2:
        return "FLAT", 0.0

    y = np.array(trend_values, dtype=float)
    x = np.arange(len(y))

    slope = np.polyfit(x, y, 1)[0]

    # ---- STABILITY FIX ----
    denom = max(np.mean(y), 1.0)
    slope_pct = (slope / denom) * 100

    if slope > 0:
        return "INCREASING", abs(slope_pct)
    elif slope < 0:
        return "DECREASING", abs(slope_pct)
    else:
        return "FLAT", 0.0


# -------------------------------------------------
# Trend → Base Adjustment %
# -------------------------------------------------
def trend_strength_to_base_adjustment(abs_slope_pct: float) -> float:
    if abs_slope_pct >= 6.0:
        return 10.0
    elif abs_slope_pct >= 4.0:
        return 7.5
    elif abs_slope_pct >= 2.0:
        return 5.0
    else:
        return 2.5


# -------------------------------------------------
# Weather Multiplier
# -------------------------------------------------
def weather_multiplier(cloud_severity: str, wind_confidence: str) -> float:
    multiplier = 1.0

    # Cloud impact
    if cloud_severity == "LOW":
        multiplier *= 0.85
    elif cloud_severity == "MEDIUM":
        multiplier *= 1.0
    else:  # HIGH
        multiplier *= 1.15

    # Wind impact
    if wind_confidence == "WEAK":
        multiplier *= 0.9
    elif wind_confidence == "MODERATE":
        multiplier *= 1.0
    else:  # STRONG
        multiplier *= 1.1

    return multiplier


# -------------------------------------------------
# MAIN CONDITION-3 (PHASE-4)
# -------------------------------------------------
def apply_condition3(
    *,
    block: int,
    base_forecast: float,
    intraday_forecast: float,
    weather_state: str,
    cloud_severity: str,
    wind_speed_ms: float,
    past_block_values: List[Tuple[int, float, str]]
):
    logger.info(f"--- BLOCK {block} | Condition-3 START ---")
    logger.info(f"Base Forecast: {base_forecast:.2f} MW")

    # ---- Build trend series ----
    trend_values = []
    for b, val, src in past_block_values:
        logger.info(f"Trend Block {b}: {val:.2f} MW ({src})")
        trend_values.append(val)

    logger.info(f"Trend series used (oldest→latest): {trend_values}")

    trend_type, slope_pct = detect_trend(trend_values)

    logger.info(f"Detected TrendType: {trend_type}")
    logger.info(f"Trend slope %: {slope_pct:.2f}")

    # ---- Decide ADD / SUBTRACT ----
    if trend_type == "DECREASING":
        operation = "SUBTRACT"
    elif trend_type == "INCREASING":
        operation = "ADD"
    else:
        operation = "SUBTRACT" if weather_state == "UNDER_GENERATION_SOON" else "ADD"

    logger.info(f"Operation: {operation}")

    # ---- Wind confidence (m/s) ----
    if wind_speed_ms < 3:
        wind_conf = "WEAK"
    elif wind_speed_ms < 7:
        wind_conf = "MODERATE"
    else:
        wind_conf = "STRONG"

    logger.info(
        f"Wind Speed: {wind_speed_ms:.2f} m/s ({wind_speed_ms*3.6:.2f} km/h) → {wind_conf}"
    )
    logger.info(f"Cloud Severity: {cloud_severity}")

    # ---- Adjustment ----
    base_adj = trend_strength_to_base_adjustment(abs(slope_pct))
    weather_mult = weather_multiplier(cloud_severity, wind_conf)

    final_adj_pct = round(base_adj * weather_mult, 2)
    if operation == "SUBTRACT":
        final_adj_pct *= -1

    logger.info(f"Base Adjustment %: {base_adj}")
    logger.info(f"Weather Multiplier: {weather_mult}")
    logger.info(f"Final Adjustment %: {final_adj_pct}")

    # ---- Final schedule ----
    final_schedule = round(
        base_forecast * (1 + final_adj_pct / 100), 2
    )

    logger.info(f"Final Schedule: {final_schedule:.2f} MW")
    logger.info(f"--- BLOCK {block} END ---")

    return "COND_3", final_adj_pct, final_schedule