from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pandas as pd


@dataclass(frozen=True)
class PreviousSchedule:
    path: Path | None
    frame: pd.DataFrame | None
    source: str


def latest_schedule_file(output_day: Path) -> Path | None:
    if not output_day.exists():
        return None
    files = list(output_day.glob("schedule_from_*.csv"))
    if not files:
        return None
    return max(files, key=lambda path: path.stat().st_mtime)


def load_previous_schedule(
    *,
    previous_schedule_file: Path | None,
    custom_start_block: int | None,
    simulate_realtime_revision_flow: bool,
    day_ahead_dir: Path,
    site_id: str,
    run_date,
    pick_da2_reference_file: Callable[[Path, str, object], Path | None],
    logger,
    rel_path: Callable[[Path | None], str | None],
) -> PreviousSchedule:
    if previous_schedule_file is not None:
        return PreviousSchedule(
            path=previous_schedule_file,
            frame=pd.read_csv(previous_schedule_file),
            source="previous_schedule",
        )

    if custom_start_block is None or not simulate_realtime_revision_flow:
        return PreviousSchedule(path=None, frame=None, source="none")

    da2_fallback_file = pick_da2_reference_file(day_ahead_dir, site_id, run_date)
    if da2_fallback_file is None:
        return PreviousSchedule(path=None, frame=None, source="none")

    try:
        fallback_df = pd.read_csv(da2_fallback_file)
        if not fallback_df.empty and {"block", "algo_schedule_mw"}.issubset(fallback_df.columns):
            logger.info(
                "REALTIME FALLBACK | using DA-2 reference as frozen baseline: %s",
                rel_path(da2_fallback_file),
            )
            return PreviousSchedule(
                path=da2_fallback_file,
                frame=fallback_df,
                source="da2_fallback",
            )
    except Exception:
        logger.exception("Failed to load DA-2 fallback schedule: %s", rel_path(da2_fallback_file))

    return PreviousSchedule(path=None, frame=None, source="none")
