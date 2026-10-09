from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any


def safe_id(value: Any) -> str:
    return str(value or "").strip().upper().replace(" ", "_").replace("/", "_").replace("-", "_")


def site_token(value: Any) -> str:
    token = safe_id(value)
    return "ZTRIC" if token == "ZETRIC" else token


def float_value(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def tokens(*values: Any) -> set[str]:
    return {token for token in (safe_id(v) for v in values) if token}


def block_window(run_date: str, block: int) -> tuple[datetime, datetime]:
    base = datetime.strptime(run_date, "%Y-%m-%d")
    start = base + timedelta(minutes=(int(block) - 1) * 15)
    return start, start + timedelta(minutes=15)


def overlaps(window: dict[str, Any], block_start: datetime, block_end: datetime, site_id: str) -> bool:
    if window.get("active") is False:
        return False
    w_site = site_token(window.get("site") or window.get("site_id"))
    site = site_token(site_id)
    if w_site and w_site not in {"ALL", site}:
        return False

    start_dt = window.get("start_time")
    end_dt = window.get("end_time")
    if isinstance(start_dt, str):
        start_dt = datetime.fromisoformat(start_dt)
    if isinstance(end_dt, str):
        end_dt = datetime.fromisoformat(end_dt)
    if start_dt is None:
        return False

    cmp_start = block_start
    cmp_end = block_end
    if start_dt.tzinfo is not None:
        cmp_start = cmp_start.replace(tzinfo=start_dt.tzinfo) if cmp_start.tzinfo is None else cmp_start.astimezone(start_dt.tzinfo)
        cmp_end = cmp_end.replace(tzinfo=start_dt.tzinfo) if cmp_end.tzinfo is None else cmp_end.astimezone(start_dt.tzinfo)

    if bool(window.get("is_open_ended")) and end_dt is None:
        return cmp_end > start_dt
    if end_dt is None:
        return False
    return not (end_dt <= cmp_start or start_dt >= cmp_end)


def child_profiles(config: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for child in config.get("children") or []:
        if not isinstance(child, dict) or child.get("enabled", True) is False:
            continue
        ac = float_value(child.get("ac_capacity_mw") or child.get("capacity_ac_mw"))
        if ac <= 0:
            continue
        out.append(
            {
                "ac": ac,
                "dc": float_value(child.get("dc_capacity_mw") or child.get("capacity_dc_mw"), ac),
                "tokens": tokens(
                    child.get("asset_code"),
                    child.get("asset_id"),
                    child.get("asset_name"),
                    child.get("s3_folder_name"),
                    child.get("forecast_tag"),
                    child.get("forecast_column"),
                ),
            }
        )
    return out


def column_profiles(buyers: list[dict[str, Any]], buyer_ids: list[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for buyer, buyer_id in zip(buyers, buyer_ids):
        ac = float_value(buyer.get("capacity_mw") or buyer.get("buyer_capacity_mw"))
        if ac <= 0:
            continue
        out[buyer_id] = {
            "ac": ac,
            "dc": float_value(buyer.get("dc_capacity_mw"), ac),
            "tokens": tokens(buyer_id, buyer.get("buyer_id"), buyer.get("buyer_name"), buyer.get("asset_id"), buyer.get("asset_name")),
        }
    return out


def match_profile(window: dict[str, Any], profiles: list[dict[str, Any]]) -> dict[str, Any] | None:
    wanted = tokens(window.get("asset_id"), window.get("asset_name"))
    if not wanted:
        return None
    for profile in profiles:
        if wanted & set(profile.get("tokens") or set()):
            return profile
    return None


def match_column(window: dict[str, Any], profiles: dict[str, dict[str, Any]]) -> str | None:
    wanted = tokens(window.get("asset_id"), window.get("asset_name"))
    if not wanted:
        return None
    for column, profile in profiles.items():
        if wanted & set(profile.get("tokens") or set()):
            return column
    return None


def effective_ac(window: dict[str, Any], ac_capacity: float, dc_capacity: float) -> tuple[float | None, str]:
    status = str(window.get("plant_status") or "NORMAL").strip().upper()
    mode = str(window.get("control_mode") or "").strip().upper()
    if not mode:
        mode = "AC" if status == "CURTAILMENT" else "FULL"

    if status == "SHUTDOWN" and mode == "FULL":
        return 0.0, "SHUTDOWN"
    if status == "SHUTDOWN" and mode == "DC":
        reduction = float_value(window.get("shutdown_reduction_mw"))
        if reduction <= 0:
            return 0.0, "SHUTDOWN"
        ratio = float(dc_capacity) / float(ac_capacity) if ac_capacity > 0 else 0.0
        remaining_dc = max(float(dc_capacity) - reduction, 0.0)
        cap = remaining_dc / ratio if ratio > 0 else 0.0
        return min(cap, ac_capacity), "PARTIAL_SHUTDOWN"
    if status == "CURTAILMENT":
        cap = float_value(window.get("curtailment_capacity"))
        if cap <= 0:
            return None, "CURTAILMENT"
        return min(cap, ac_capacity), "CURTAILMENT"
    return None, "NORMAL"


def scale_values(values: dict[str, float], factor: float, selected_columns: list[str] | None = None) -> None:
    safe_factor = max(0.0, min(float(factor), 1.0))
    for column in selected_columns or list(values.keys()):
        values[column] = max(float(values.get(column, 0.0)) * safe_factor, 0.0)


def apply_multi_generator_controls(
    *,
    values: dict[str, float],
    run_date: str,
    block: int,
    site_id: str,
    config: dict[str, Any],
    buyers: list[dict[str, Any]],
    buyer_ids: list[str],
    reference_capacity_mw: float,
    control_windows: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not control_windows:
        return []

    block_start, block_end = block_window(run_date, block)
    col_profiles = column_profiles(buyers, buyer_ids)
    assets = child_profiles(config)
    total_ac = max(float(reference_capacity_mw), sum(float_value(p.get("ac")) for p in col_profiles.values()), 0.0)
    total_dc = sum(float_value(p.get("dc")) for p in assets) or total_ac
    if total_ac <= 0:
        return []

    applied: list[dict[str, Any]] = []
    for window in control_windows:
        if not overlaps(window, block_start, block_end, site_id):
            continue

        scope = safe_id(window.get("asset_scope") or "plant")
        is_combined = scope in {"COMBINED", "PLANT", "SITE", "ALL"} or safe_id(window.get("asset_id")) == "COMBINED"
        if is_combined:
            cap, control_type = effective_ac(window, total_ac, total_dc)
            if cap is None:
                continue
            factor = cap / total_ac if total_ac > 0 else 0.0
            scale_values(values, factor)
            applied.append({"block": block, "window_id": window.get("window_id"), "scope": "combined", "control_type": control_type, "scale_factor": factor})
            continue

        profile = match_profile(window, assets) or match_profile(window, list(col_profiles.values()))
        if not profile:
            continue
        asset_ac = float_value(profile.get("ac"))
        asset_dc = float_value(profile.get("dc"), asset_ac)
        if asset_ac <= 0:
            continue
        cap, control_type = effective_ac(window, asset_ac, asset_dc)
        if cap is None:
            continue
        factor = cap / asset_ac if asset_ac > 0 else 0.0
        column = match_column(window, col_profiles)
        if column:
            scale_values(values, factor, [column])
            scope_label = "asset_column"
        else:
            factor = max(total_ac - asset_ac + cap, 0.0) / total_ac
            scale_values(values, factor)
            scope_label = "asset_capacity_pool"
        applied.append({"block": block, "window_id": window.get("window_id"), "scope": scope_label, "asset_id": window.get("asset_id"), "control_type": control_type, "scale_factor": factor})
    return applied
