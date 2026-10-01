from __future__ import annotations

import logging
import os
from decimal import Decimal
from typing import Any

try:
    import boto3
except ImportError:  # pragma: no cover - Lambda image has boto3
    boto3 = None

logger = logging.getLogger(__name__)

DEFAULT_TABLE_NAME = "multi_generator_plant"
DEFAULT_PLANT_ID = "ZETRIC_SOLAR_PARK"
DEFAULT_PLANT_IDS = {
    "ZTRIC": "ZETRIC_SOLAR_PARK",
    "ZETRIC": "ZETRIC_SOLAR_PARK",
    "ENRICH": "ENRICH",
    "SHAHA": "SHAHA",
}


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def _safe_buyer_id(value: str) -> str:
    return str(value or "").strip().upper().replace(" ", "_").replace("/", "_").replace("-", "_")


def _unique_buyer_id(base_id: str, raw_buyer: dict[str, Any], seen_ids: set[str]) -> str:
    buyer_id = base_id or "BUYER"
    if buyer_id not in seen_ids:
        seen_ids.add(buyer_id)
        return buyer_id

    for key in ("contract_id", "approval_number"):
        suffix = _safe_buyer_id(str(raw_buyer.get(key) or ""))
        if not suffix:
            continue
        candidate = f"{buyer_id}_{suffix}"
        if candidate not in seen_ids:
            seen_ids.add(candidate)
            return candidate

    index = 2
    while f"{buyer_id}_{index}" in seen_ids:
        index += 1
    candidate = f"{buyer_id}_{index}"
    seen_ids.add(candidate)
    return candidate


def _float_value(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _asset_capacity_mw(raw_buyer: dict[str, Any]) -> float:
    assets = raw_buyer.get("assets")
    if not isinstance(assets, list):
        return 0.0
    total = 0.0
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        total += _float_value(asset.get("capacity_ac_mw"))
    return total


def _normalize_buyers(raw_buyers: Any) -> list[dict[str, Any]]:
    buyers: list[dict[str, Any]] = []
    seen_buyer_ids: set[str] = set()
    for raw_buyer in raw_buyers or []:
        if not isinstance(raw_buyer, dict):
            continue
        buyer_name = str(raw_buyer.get("buyer_name") or "").strip()
        capacity = _float_value(raw_buyer.get("schedule_capacity_mw"))
        if capacity <= 0:
            capacity = _asset_capacity_mw(raw_buyer)
        if not buyer_name or capacity <= 0:
            continue
        base_buyer_id = _safe_buyer_id(buyer_name)
        buyers.append(
            {
                "buyer_id": _unique_buyer_id(base_buyer_id, raw_buyer, seen_buyer_ids),
                "buyer_name": buyer_name,
                "capacity_mw": capacity,
                "contract_id": str(raw_buyer.get("contract_id") or "").strip(),
                "approval_number": str(raw_buyer.get("approval_number") or "").strip(),
            }
        )
    return buyers


def _normalize_schedule_type_overrides(raw_overrides: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw_overrides, dict):
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for schedule_type, raw_cfg in raw_overrides.items():
        if not isinstance(raw_cfg, dict):
            continue
        token = str(schedule_type or "").strip().lower()
        if token not in {"intraday", "day_ahead", "week_ahead"}:
            continue
        buyers = _normalize_buyers(raw_cfg.get("buyers"))
        reference_capacity = _float_value(raw_cfg.get("reference_capacity_mw"))
        override: dict[str, Any] = {}
        if reference_capacity > 0:
            override["reference_capacity_mw"] = reference_capacity
        if buyers:
            override["buyers"] = buyers
        if override:
            normalized[token] = override
    return normalized


def _normalize_frontend_config(item: dict[str, Any]) -> dict[str, Any] | None:
    buyers = _normalize_buyers(item.get("buyers"))
    if not buyers:
        return None

    current_capacity = item.get("currently_scheduling_capacity") if isinstance(item.get("currently_scheduling_capacity"), dict) else {}
    reference_capacity = _float_value(current_capacity.get("ac_mw"))
    if reference_capacity <= 0:
        return None

    template_config = item.get("template_config") if isinstance(item.get("template_config"), dict) else {}
    plants = template_config.get("multi_generator_plants") if isinstance(template_config, dict) else []
    if not isinstance(plants, list):
        plants = []
    active_plant = next((p for p in plants if isinstance(p, dict) and str(p.get("plantName") or p.get("plant_name") or "").strip()), {})
    schedule_type_overrides = _normalize_schedule_type_overrides(item.get("schedule_type_overrides"))

    normalized = {
        "config_source": "dynamodb_multi_generator_plant",
        "plant_id": item.get("plant_id") or DEFAULT_PLANT_ID,
        "plant_name": item.get("plant_name") or active_plant.get("plantName") or "ZETRIC",
        "reference_capacity_mw": reference_capacity,
        "currently_scheduling_capacity_mw": reference_capacity,
        "buyers": buyers,
        "template": {
            "scheduling_entity": active_plant.get("schedulingEntity") or "MH_VEDANJAY",
            "pos_name": active_plant.get("posName") or "Chakur 132kV",
            "downstream_name": active_plant.get("downstreamName") or "Chakur 132kV",
            "energy_type": active_plant.get("energyType") or "SOLAR",
            "contract_type": active_plant.get("contractType") or "MTOA",
            "exchange_type": active_plant.get("exchangeType") or "NA",
            "transaction_type": active_plant.get("transactionType") or "INTRA",
            "re_generator_name": active_plant.get("reGeneratorName") or active_plant.get("posName") or "Chakur 132kV",
            "path": active_plant.get("path") or "A-B",
            "stu_name": active_plant.get("stuName") or active_plant.get("posName") or "Chakur 132kV",
        },
    }
    if schedule_type_overrides:
        normalized["schedule_type_overrides"] = schedule_type_overrides
    return normalized


def load_frontend_multi_generator_config(
    *,
    site_id: str,
    plant_id: str | None = None,
    table_name: str | None = None,
) -> dict[str, Any] | None:
    site_token = str(site_id or "").strip().upper()
    if site_token not in DEFAULT_PLANT_IDS:
        return None
    if boto3 is None:
        logger.info("boto3 unavailable; frontend multi-generator config skipped")
        return None

    configured_table = str(table_name or os.getenv("MULTI_GENERATOR_PLANT_TABLE") or DEFAULT_TABLE_NAME).strip()
    configured_plant = str(plant_id or os.getenv("MULTI_GENERATOR_PLANT_ID") or DEFAULT_PLANT_IDS.get(site_token, DEFAULT_PLANT_ID)).strip()
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
    if not configured_table or not configured_plant:
        return None

    try:
        table = boto3.resource("dynamodb", region_name=region).Table(configured_table)
        response = table.get_item(Key={"plant_id": configured_plant})
        item = _jsonable(response.get("Item") or {})
        if not item:
            logger.info("No frontend multi-generator config found table=%s plant_id=%s", configured_table, configured_plant)
            return None
        normalized = _normalize_frontend_config(item)
        if normalized:
            logger.info(
                "Loaded frontend multi-generator config site=%s plant_id=%s buyers=%s reference_capacity=%.3f",
                site_id,
                configured_plant,
                len(normalized.get("buyers") or []),
                float(normalized.get("reference_capacity_mw") or 0.0),
            )
        return normalized
    except Exception:
        logger.exception("Failed to load frontend multi-generator config; static config fallback will be used")
        return None


def apply_frontend_multi_generator_config(config: dict[str, Any]) -> dict[str, Any]:
    dynamic = load_frontend_multi_generator_config(site_id=str(config.get("site_id") or ""))
    if not dynamic:
        return config

    merged = dict(config)
    formula = dict(merged.get("multiple_generator_formula") or merged.get("forecast_scaling") or {})
    formula["reference_capacity_mw"] = dynamic["reference_capacity_mw"]
    formula["buyers"] = dynamic["buyers"]
    if dynamic.get("schedule_type_overrides"):
        formula["schedule_type_overrides"] = dynamic["schedule_type_overrides"]
    merged["multiple_generator_formula"] = formula
    merged["dynamic_multi_generator_config"] = dynamic
    return merged

