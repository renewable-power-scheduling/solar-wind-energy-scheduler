from __future__ import annotations


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(value, upper))


def penalty_band_mw(*, penalty_band_mw: float | None, penalty_band_pct: float, plant_capacity_mw: float) -> float:
    if penalty_band_mw is not None:
        return float(penalty_band_mw)
    band_frac = penalty_band_pct / 100.0 if penalty_band_pct > 1.0 else penalty_band_pct
    return float(plant_capacity_mw) * float(band_frac)


def apply_receivable_bias(
    schedule_mw: float,
    expected_gen_mw: float,
    over_min_pct: float,
    over_target_pct: float,
    over_max_pct: float,
) -> tuple[float, dict]:
    expected = max(float(expected_gen_mw), 0.0)
    if expected <= 0.0:
        return schedule_mw, {"applied": False, "reason": "expected_gen<=0"}

    safe_min = max(float(over_min_pct), 0.0)
    safe_target = max(float(over_target_pct), safe_min)
    safe_max = max(float(over_max_pct), safe_target)

    min_sched = expected / (1.0 + (safe_max / 100.0))
    max_sched = expected / (1.0 + (safe_min / 100.0))
    target_sched = expected / (1.0 + (safe_target / 100.0))

    clamped = float(clamp(float(schedule_mw), min_sched, max_sched))
    return clamped, {
        "applied": True,
        "expected_gen_mw": expected,
        "min_sched": min_sched,
        "target_sched": target_sched,
        "max_sched": max_sched,
        "over_min_pct": safe_min,
        "over_target_pct": safe_target,
        "over_max_pct": safe_max,
    }


def clamp_below_meter_within_band(
    schedule_mw: float,
    meter_mw: float,
    margin_mw: float,
    band_mw: float,
) -> tuple[float, dict]:
    meter_val = max(float(meter_mw), 0.0)
    margin_val = max(float(margin_mw), 0.0)
    band_val = max(float(band_mw), 0.0)

    lower_bound = max(meter_val - band_val, 0.0)
    upper_bound = max(meter_val - margin_val, 0.0)

    if upper_bound < lower_bound:
        upper_bound = lower_bound

    clamped = float(clamp(float(schedule_mw), lower_bound, upper_bound))
    return clamped, {
        "meter_mw": meter_val,
        "lower_bound": lower_bound,
        "upper_bound": upper_bound,
        "margin_mw": margin_val,
        "band_mw": band_val,
    }
