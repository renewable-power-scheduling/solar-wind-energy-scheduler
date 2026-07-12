from __future__ import annotations

from typing import Any

from cloud.common.config_loader import config_path_for_site, load_site_config
from cloud.common.constants import GLOBAL1_SITES, ILLIOS_POWER_SITES


def _source_group_for_site(site_id: str) -> str:
    site_token = str(site_id or "").strip().upper()
    if site_token in GLOBAL1_SITES:
        return "global1"
    if site_token in ILLIOS_POWER_SITES:
        return "illios_power"
    raise KeyError(f"Unknown site id: {site_token}")


def get_site_entry(site_id: str) -> dict[str, Any]:
    site_token = str(site_id or "").strip().upper()
    cfg = load_site_config(site_token)
    lambda_arch = cfg.get("lambda_architecture") if isinstance(cfg, dict) else {}
    return {
        "site_id": site_token,
        "config_path": str(config_path_for_site(site_token)),
        "source_group": _source_group_for_site(site_token),
        "fetcher_lambda_name": lambda_arch.get("fetcher_lambda_name", f"{site_token}-fetcher"),
        "scheduler_lambda_name": lambda_arch.get("scheduler_lambda_name", f"{site_token}-scheduler"),
        "cron_profile": lambda_arch.get("fetcher_cron_profile"),
        "cron_expression": lambda_arch.get("fetcher_cron_expression"),
    }


def list_site_entries() -> list[dict[str, Any]]:
    return [get_site_entry(site_id) for site_id in GLOBAL1_SITES + ILLIOS_POWER_SITES]
