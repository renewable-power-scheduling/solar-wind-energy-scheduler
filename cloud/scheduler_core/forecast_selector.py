from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class ReferenceForecast:
    by_block: dict[int, float]
    source: str


def latest_file_in_dir(dir_path: Path) -> Path | None:
    if not dir_path.exists():
        return None
    files = [path for path in dir_path.glob("*.csv") if path.is_file()]
    if not files:
        return None
    return max(files, key=lambda path: path.stat().st_mtime)


def pick_previous_intraday_file(intraday_dir: Path, current_file: Path) -> Path | None:
    files = sorted(
        [path for path in intraday_dir.glob("*.csv") if path.is_file()],
        key=lambda path: path.stat().st_mtime,
    )
    if not files:
        return None
    try:
        idx = [path.name for path in files].index(current_file.name)
    except ValueError:
        return files[-2] if len(files) >= 2 else None
    return files[idx - 1] if idx > 0 else None


def select_reference_forecast(
    *,
    intraday_dir: Path,
    current_intraday_file: Path,
    day_ahead_dir: Path,
    site_id: str,
    run_date,
    forecast_by_block_from_csv: Callable[[Path | None], dict[int, float]],
    pick_da2_reference_file: Callable[[Path, str, object], Path | None],
) -> ReferenceForecast:
    previous_intraday = pick_previous_intraday_file(intraday_dir, current_intraday_file)
    if previous_intraday is not None:
        by_block = forecast_by_block_from_csv(previous_intraday)
        if by_block:
            return ReferenceForecast(
                by_block=by_block,
                source=f"previous_intraday:{previous_intraday.name}",
            )

    day_ahead_reference = pick_da2_reference_file(day_ahead_dir, site_id, run_date)
    by_block = forecast_by_block_from_csv(day_ahead_reference)
    if by_block and day_ahead_reference is not None:
        return ReferenceForecast(
            by_block=by_block,
            source=f"da2_reference:{day_ahead_reference.name}",
        )

    return ReferenceForecast(by_block={}, source="none")
