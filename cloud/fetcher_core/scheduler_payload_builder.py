from __future__ import annotations

from cloud.common.idempotency import build_idempotency_key
from cloud.common.payload_models import SchedulerPayload


def build_payload(**kwargs) -> SchedulerPayload:
    if "idempotency_key" not in kwargs:
        kwargs["idempotency_key"] = build_idempotency_key(
            kwargs["site_id"],
            kwargs["run_date"],
            kwargs["current_block"],
            kwargs["trigger_type"],
            kwargs["source_event_id"],
        )
    return SchedulerPayload(**kwargs)
