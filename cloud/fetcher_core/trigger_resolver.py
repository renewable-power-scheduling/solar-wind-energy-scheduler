from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import boto3
except ImportError:
    boto3 = None

from cloud.common.intraday_revision import resolve_intraday_revision
from cloud.common.trigger_types import CUSTOM, INTRADAY_REVISION, NONE, PLANT_STATUS_CHANGE, WHATSAPP_METER_FALLBACK


@dataclass
class TriggerDecision:
    trigger_type: str
    schedule_reason: str
    source_event_id: str
    selected_forecast_type: str | None = None
    intraday_revision: int | None = None
    intraday_forecast_name: str | None = None
    planned_window_ids: list[str] | None = None
    whatsapp_fallback: dict[str, Any] | None = None
    intraday_detail: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _local_state_path(site_id: str) -> Path:
    return Path(__file__).resolve().parents[1] / "logs" / site_id.upper() / "fetcher_decision_state.json"


def _state_s3_key(site_id: str) -> str:
    plant_id = str(os.getenv("PLANT_ID", "vedanjay")).strip() or "vedanjay"
    return f"state/{plant_id}/{site_id.upper()}/fetcher_decision_state.json"


def load_decision_state(site_id: str) -> dict[str, Any]:
    bucket = str(os.getenv("BUCKET", "")).strip()
    if bucket and boto3 is not None:
        try:
            body = boto3.client("s3").get_object(Bucket=bucket, Key=_state_s3_key(site_id))["Body"].read()
            payload = json.loads(body.decode("utf-8"))
            if isinstance(payload, dict):
                return payload
        except Exception:
            pass

    path = _local_state_path(site_id)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def save_decision_state(site_id: str, state: dict[str, Any]) -> None:
    state = dict(state or {})
    state["updated_at_ist"] = datetime.now().astimezone().isoformat()
    bucket = str(os.getenv("BUCKET", "")).strip()
    if bucket and boto3 is not None:
        try:
            boto3.client("s3").put_object(
                Bucket=bucket,
                Key=_state_s3_key(site_id),
                Body=json.dumps(state, indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            return
        except Exception:
            pass

    path = _local_state_path(site_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def resolve_trigger(
    *,
    site_id: str,
    event: dict[str, Any],
    latest_intraday_name: str | None,
    pending_planned_windows: list[dict[str, Any]] | None = None,
    whatsapp_assessment: dict[str, Any] | None = None,
    decision_state: dict[str, Any] | None = None,
    intraday_assessment: dict[str, Any] | None = None,
) -> TriggerDecision:
    explicit_type = str(event.get("trigger_type") or "").strip().upper()
    if explicit_type == CUSTOM:
        source_event_id = str(event.get("source_event_id") or latest_intraday_name or "custom").strip() or "custom"
        return TriggerDecision(
            trigger_type=CUSTOM,
            schedule_reason="custom schedule trigger",
            source_event_id=source_event_id,
            selected_forecast_type="INTRADAY",
            intraday_revision=(
                (resolve_intraday_revision(site_id, latest_intraday_name) or {}).get("revision")
            ),
            intraday_forecast_name=latest_intraday_name,
        )

    if explicit_type == PLANT_STATUS_CHANGE:
        source_event_id = str(event.get("source_event_id") or "plant_status_change").strip() or "plant_status_change"
        return TriggerDecision(
            trigger_type=PLANT_STATUS_CHANGE,
            schedule_reason=str(event.get("schedule_reason") or "plant status change").strip() or "plant status change",
            source_event_id=source_event_id,
            intraday_forecast_name=latest_intraday_name,
        )

    if explicit_type == WHATSAPP_METER_FALLBACK:
        source_event_id = str(event.get("source_event_id") or "whatsapp_meter_fallback").strip() or "whatsapp_meter_fallback"
        return TriggerDecision(
            trigger_type=WHATSAPP_METER_FALLBACK,
            schedule_reason="whatsapp_out_of_band_adjustment",
            source_event_id=source_event_id,
            intraday_forecast_name=latest_intraday_name,
            whatsapp_fallback=dict(whatsapp_assessment or {}),
        )

    planned = list(pending_planned_windows or [])
    if planned:
        first = planned[0]
        plant_status = str(first.get("plant_status") or "").strip().upper()
        reason = "plant status change"
        if plant_status == "SHUTDOWN":
            reason = "shutdown"
        elif plant_status == "CURTAILMENT":
            reason = "curtailment"
        elif plant_status == "NORMAL":
            reason = "normal"
        return TriggerDecision(
            trigger_type=PLANT_STATUS_CHANGE,
            schedule_reason=reason,
            source_event_id="planned_control:" + ",".join(str(item.get("window_id") or "").strip() for item in planned if str(item.get("window_id") or "").strip()),
            intraday_forecast_name=latest_intraday_name,
            planned_window_ids=[str(item.get("window_id") or "").strip() for item in planned if str(item.get("window_id") or "").strip()],
        )

    if intraday_assessment and bool(intraday_assessment.get("triggered")):
        latest_name = str(intraday_assessment.get("latest_intraday_name") or latest_intraday_name or "").strip() or None
        revision = intraday_assessment.get("current_revision")
        if revision is None:
            revision = (resolve_intraday_revision(site_id, latest_name) or {}).get("revision")
        return TriggerDecision(
            trigger_type=INTRADAY_REVISION,
            schedule_reason=(f"intraday revision {revision} trigger" if revision is not None else "intraday revision trigger"),
            source_event_id=str(intraday_assessment.get("source_event_id") or latest_name or "intraday_revision"),
            selected_forecast_type="INTRADAY",
            intraday_revision=revision,
            intraday_forecast_name=latest_name,
            intraday_detail=dict(intraday_assessment),
        )

    if whatsapp_assessment and bool(whatsapp_assessment.get("triggered")):
        source_event_id = str(whatsapp_assessment.get("message_id") or "whatsapp_out_of_band").strip() or "whatsapp_out_of_band"
        return TriggerDecision(
            trigger_type=WHATSAPP_METER_FALLBACK,
            schedule_reason="whatsapp_out_of_band_adjustment",
            source_event_id=source_event_id,
            intraday_forecast_name=latest_intraday_name,
            whatsapp_fallback=dict(whatsapp_assessment),
        )

    return TriggerDecision(
        trigger_type=NONE,
        schedule_reason="no trigger no schedule generated",
        source_event_id="none",
    )
