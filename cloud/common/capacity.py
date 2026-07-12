from __future__ import annotations


def resolve_capacity_config(site_cfg: dict) -> dict:
    capacity_cfg = dict(site_cfg.get("capacity") or {})
    legacy_capacity = float(site_cfg.get("plant_capacity_mw", 0.0) or 0.0)
    dc_capacity = float(capacity_cfg.get("dc_capacity_mw", legacy_capacity) or legacy_capacity)
    ac_capacity = float(capacity_cfg.get("ac_capacity_mw", legacy_capacity) or legacy_capacity)
    ratio = float(capacity_cfg.get("dc_ac_ratio", 1.0) or 1.0)
    return {
        "dc_capacity_mw": dc_capacity,
        "ac_capacity_mw": ac_capacity,
        "dc_ac_ratio": ratio,
    }


def effective_capacity_ac_mw(
    site_cfg: dict,
    plant_status: str,
    control_mode: str | None = None,
    curtailment_capacity_mw: float | None = None,
    shutdown_reduction_mw: float | None = None,
) -> float:
    caps = resolve_capacity_config(site_cfg)
    status = str(plant_status or "NORMAL").strip().upper()
    mode = str(control_mode or "").strip().upper()
    if status == "SHUTDOWN" and mode != "DC":
        return 0.0
    if status == "CURTAILMENT" and curtailment_capacity_mw is not None:
        return float(curtailment_capacity_mw)
    if status == "SHUTDOWN" and mode == "DC" and shutdown_reduction_mw is not None:
        remaining_dc = max(0.0, caps["dc_capacity_mw"] - float(shutdown_reduction_mw))
        return remaining_dc / max(caps["dc_ac_ratio"], 1e-9)
    return caps["ac_capacity_mw"]
