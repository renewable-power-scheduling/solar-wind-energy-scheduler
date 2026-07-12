from __future__ import annotations

from datetime import datetime


def timestamp_to_block(run_ts: datetime) -> int:
    minutes = (run_ts.hour * 60) + run_ts.minute
    return max(1, min(96, 1 + (minutes // 15)))
