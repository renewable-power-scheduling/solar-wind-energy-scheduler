from __future__ import annotations

from cloud.common.config_loader import load_site_config
from cloud.scheduler_core import schedule_policy


def positive_float(value, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float(default)
    return parsed if parsed > 0.0 else float(default)


def resolve_site_capacity(site_cfg: dict, default_capacity_mw: float) -> tuple[float, float, float]:
    legacy_capacity = positive_float(site_cfg.get("plant_capacity_mw"), default_capacity_mw)
    capacity_cfg = site_cfg.get("capacity", {}) if isinstance(site_cfg.get("capacity"), dict) else {}

    ac_capacity = positive_float(capacity_cfg.get("ac_capacity_mw"), legacy_capacity)
    dc_capacity = positive_float(capacity_cfg.get("dc_capacity_mw"), legacy_capacity)
    ratio_default = dc_capacity / ac_capacity if ac_capacity > 0.0 else 1.0
    dc_ac_ratio = positive_float(capacity_cfg.get("dc_ac_ratio"), ratio_default)

    return ac_capacity, dc_capacity, dc_ac_ratio


def resolve_site_overrides(site_id: str, defaults: dict) -> dict:
    try:
        site_cfg = load_site_config(site_id)
    except Exception as exc:
        raise RuntimeError(f"Site config load failed for SITE_ID={site_id}") from exc

    sched = site_cfg.get("scheduling_parameters", {})
    site_ac_capacity_mw, site_dc_capacity_mw, dc_ac_ratio = resolve_site_capacity(
        site_cfg,
        float(defaults["plant_capacity_mw"]),
    )
    intraday_policy = site_cfg.get("intraday_schedule_policy", {}) if isinstance(site_cfg, dict) else {}
    penalty_band_mw = (
        float(site_cfg["penalty_band_mw"])
        if site_cfg.get("penalty_band_mw") is not None
        else None
    )
    return {
        "start_block": int(sched.get("start_block", defaults["start_block"])),
        "gen_end_block": int(sched.get("gen_end_block", defaults["gen_end_block"])),
        "weight_meter": float(sched.get("weight_meter", defaults["weight_meter"])),
        "weight_intraday": float(sched.get("weight_intraday", defaults["weight_intraday"])),
        "irr_full_trust": float(sched.get("irr_full_trust", defaults["irr_full_trust"])),
        "irr_zero_trust": float(sched.get("irr_zero_trust", defaults["irr_zero_trust"])),
        "low_gti_irr_ratio_threshold": float(
            sched.get("low_gti_irr_ratio_threshold", defaults["low_gti_irr_ratio_threshold"])
        ),
        "low_gti_damp_factor": float(sched.get("low_gti_damp_factor", defaults["low_gti_damp_factor"])),
        "ramp_cap_factor": float(sched.get("ramp_cap_factor", defaults["ramp_cap_factor"])),
        "ramp_ramp_mult": float(sched.get("ramp_ramp_mult", defaults["ramp_ramp_mult"])),
        "ramp_enable_irr_ratio": float(sched.get("ramp_enable_irr_ratio", defaults["ramp_enable_irr_ratio"])),
        "receivable_bias_enable": bool(sched.get("receivable_bias_enable", defaults["receivable_bias_enable"])),
        "receivable_over_min_pct": float(sched.get("receivable_over_min_pct", defaults["receivable_over_min_pct"])),
        "receivable_over_target_pct": float(
            sched.get("receivable_over_target_pct", defaults["receivable_over_target_pct"])
        ),
        "receivable_over_max_pct": float(sched.get("receivable_over_max_pct", defaults["receivable_over_max_pct"])),
        "receivable_min_base_mw": float(sched.get("receivable_min_base_mw", defaults["receivable_min_base_mw"])),
        "receivable_min_irr_ratio": float(
            sched.get("receivable_min_irr_ratio", defaults["receivable_min_irr_ratio"])
        ),
        "receivable_force_below_meter": bool(
            sched.get("receivable_force_below_meter", defaults["receivable_force_below_meter"])
        ),
        "receivable_below_meter_margin_mw": float(
            sched.get("receivable_below_meter_margin_mw", defaults["receivable_below_meter_margin_mw"])
        ),
        "regen_min_deviation_mw": float(sched.get("regen_min_deviation_mw", defaults["regen_min_deviation_mw"])),
        "regen_cooldown_blocks": int(sched.get("regen_cooldown_blocks", defaults["regen_cooldown_blocks"])),
        "site_ac_capacity_mw": site_ac_capacity_mw,
        "site_dc_capacity_mw": site_dc_capacity_mw,
        "dc_ac_ratio": dc_ac_ratio,
        "plant_capacity_mw": site_ac_capacity_mw,
        "penalty_band_pct": float(site_cfg.get("penalty_band_pct", defaults["penalty_band_pct"])),
        "penalty_band_mw": penalty_band_mw,
        "submission_slots": schedule_policy.build_submission_slots(site_cfg),
        "first_intraday_mandatory_revision": int(
            intraday_policy.get("first_mandatory_revision", defaults["first_intraday_mandatory_revision"])
        ),
        "mandatory_generation_block": (
            int(intraday_policy["mandatory_generation_block"])
            if intraday_policy.get("mandatory_generation_block") is not None
            else None
        ),
        "first_intraday_generation_block": (
            int(intraday_policy["first_generation_block"])
            if intraday_policy.get("first_generation_block") is not None
            else None
        ),
        "first_intraday_arrival_block": (
            int(intraday_policy["first_arrival_block"])
            if intraday_policy.get("first_arrival_block") is not None
            else None
        ),
        "intraday_slot_end_only": bool(intraday_policy.get("slot_end_only", True)),
    }
