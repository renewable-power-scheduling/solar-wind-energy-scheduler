from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SchedulerPayload:
    payload_version: str
    site_id: str
    run_date: str
    run_ts_ist: str
    current_block: int
    current_slot: str | None
    trigger_type: str
    schedule_reason: str
    source_event_id: str
    idempotency_key: str
    fetch_manifest_s3_path: str | None = None
    selected_forecast_type: str | None = None
    intraday_revision: int | None = None
    intraday_forecast_s3_path: str | None = None
    day_ahead_forecast_s3_path: str | None = None
    metered_status: str | None = None
    normalized_metered_s3_path: str | None = None
    scheduler_workspace_manifest: dict[str, Any] = field(default_factory=dict)
    control_state: dict[str, Any] = field(default_factory=dict)
    whatsapp_fallback: dict[str, Any] = field(default_factory=dict)
    local_env: dict[str, Any] = field(default_factory=dict)
    custom_start_block: int | None = None
    intraday_file_name: str | None = None
