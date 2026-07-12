import logging
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cloud.common.graph_utils import generate_schedule_graph
from cloud.fetcher_core.fetcher_engine import run as run_fetcher


ENGINE_SCRIPT = Path(__file__).resolve().parents[2] / "scheduler_core" / "engine_runtime.py"
CUSTOM_FETCHER_SCRIPT = Path(__file__).resolve().parent / "custom_fetch_standard.py"
IST = ZoneInfo("Asia/Kolkata")
FIXED_DA_BLOCK_LABELS = {
    22: "Day-ahead 1st rev",
    88: "Day-ahead 2nd rev",
}

# ------------------------------------------------------------------
# CUSTOM RUN CONFIG (edit these values directly before running)
# ------------------------------------------------------------------
SITE_ID = "OSEPL"  # edit this site name for the global1 tree
CUSTOM_DATE = "2026-07-09"  # YYYY-MM-DD
CUSTOM_START_BLOCKS = [35]  # one or more start blocks (1..96)
SKIP_FETCH = False  # True => use existing custom/input data
INTRADAY_FILE_NAME = ""  # optional exact filename from custom/input/<SITE>/<DATE>/enercast_data/intraday
INTRADAY_FILE_NAMES = []  # optional list of filenames to simulate multiple intraday revisions
INTRADAY_SELECTION_MODE = "all"  # all | prompt | latest | configured


def _list_intraday_files(intraday_root: Path) -> list[Path]:
    if not intraday_root.exists():
        return []
    return sorted(
        [p for p in intraday_root.glob("*.csv") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


def _select_intraday_file_interactive(logger: logging.Logger, intraday_root: Path) -> str | None:
    files = _list_intraday_files(intraday_root)
    if not files:
        logger.warning("No intraday CSV files found in %s", intraday_root)
        return None

    print("\nAvailable intraday forecast files (latest first):")
    for i, p in enumerate(files, start=1):
        ts = datetime.fromtimestamp(p.stat().st_mtime, tz=IST).strftime("%Y-%m-%d %H:%M:%S %Z")
        print(f"  {i}. {p.name}   [mtime: {ts}]")

    while True:
        try:
            raw = input("\nSelect intraday file number to use (Enter=1 latest): ").strip()
        except EOFError:
            logger.info("No interactive input available; defaulting to latest intraday file.")
            return files[0].name

        if raw == "":
            return files[0].name
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(files):
                return files[idx - 1].name
        print(f"Invalid choice. Enter a number between 1 and {len(files)}, or press Enter for latest.")


def _safe_token(name: str) -> str:
    token = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name).strip())
    token = token.strip("._-")
    return token[:80] if token else "latest"


def _parse_ist(raw: object) -> datetime | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=IST)
    return parsed.astimezone(IST)


def _load_intraday_graph_df(csv_path: Path) -> pd.DataFrame | None:
    try:
        intraday_df = pd.read_csv(csv_path, skiprows=4)
    except Exception:
        return None
    if intraday_df.empty:
        return None
    block_col = next((col for col in ("block", "Block", "BLOCK", "BLK NO.") if col in intraday_df.columns), None)
    forecast_col = next(
        (
            col
            for col in (
                "forecast_mw",
                "forecast",
                "SchMW",
                "schmw",
                "schedule",
                "declaredForecast",
                "INTRADAY",
                "ANJANGAON",
                "KOTHAGUDEM",
                "KASIPET",
                "BHUPALPALLY",
                "SIRMOUR",
                "OSEPL",
            )
            if col in intraday_df.columns
        ),
        None,
    )
    if block_col is None or forecast_col is None:
        return None
    normalized = intraday_df[[block_col, forecast_col]].copy()
    normalized.columns = ["block", "forecast_mw"]
    normalized["block"] = pd.to_numeric(normalized["block"], errors="coerce")
    normalized["forecast_mw"] = pd.to_numeric(normalized["forecast_mw"], errors="coerce")
    normalized = normalized.dropna(subset=["block", "forecast_mw"])
    if normalized.empty:
        return None
    normalized["block"] = normalized["block"].astype(int)
    normalized = normalized[(normalized["block"] >= 1) & (normalized["block"] <= 96)]
    if normalized.empty:
        return None
    return normalized.sort_values("block").reset_index(drop=True)


def _reduce_final_frozen_schedule(day_root: Path, site_id: str, custom_date: str, latest_intraday_df: pd.DataFrame, metered_by_block: pd.Series) -> None:
    schedules_dir = day_root / custom_date / "intraday_runs"
    frozen_dir = day_root / custom_date / "frozen"
    frozen_dir.mkdir(parents=True, exist_ok=True)
    schedule_files = sorted(schedules_dir.rglob("schedules/schedule_from_*.csv"))
    revisions = []
    for csv_path in schedule_files:
        meta_path = csv_path.with_suffix(".meta.json")
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        effective_ts = _parse_ist(meta.get("effective_timestamp_ist")) or _parse_ist(meta.get("run_timestamp_ist")) or _parse_ist(meta.get("created_at_ist"))
        if effective_ts is None:
            continue
        try:
            sched_df = pd.read_csv(csv_path)
        except Exception:
            continue
        revisions.append((effective_ts, sched_df))
    if not revisions:
        return
    revisions.sort(key=lambda item: item[0])
    start_day = datetime.strptime(custom_date, "%Y-%m-%d").replace(tzinfo=IST)
    final_rows = []
    for block in range(1, 97):
        block_time = start_day + pd.Timedelta(minutes=(block - 1) * 15)
        chosen = revisions[0][1]
        for effective_ts, sched_df in revisions:
            if effective_ts <= block_time:
                chosen = sched_df
            else:
                break
        row = chosen.loc[chosen["block"] == block]
        if row.empty:
            continue
        final_rows.append(row.iloc[0].to_dict())
    if not final_rows:
        return
    final_df = pd.DataFrame(final_rows).sort_values("block")
    final_csv = frozen_dir / f"frozen_schedule_{custom_date}_{site_id}.csv"
    final_df.to_csv(final_csv, index=False)
    generate_schedule_graph(
        schedule_csv=final_csv,
        intraday_df=latest_intraday_df,
        metered_by_block=metered_by_block,
        current_block=int(final_df["block"].max()),
        output_dir=frozen_dir,
        intraday_rev_token="frozen_final",
        intraday_rev_label="frozen_final",
    )


def _load_graph_inputs(custom_input_root: Path, custom_date: str) -> tuple[pd.DataFrame, pd.Series]:
    intraday_dir = custom_input_root / custom_date / "enercast_data" / "intraday"
    metered_dir = custom_input_root / custom_date / "metered_data"
    intraday_files = sorted(intraday_dir.glob("*.csv")) if intraday_dir.exists() else []
    metered_files = sorted(metered_dir.glob("*.csv")) if metered_dir.exists() else []
    intraday_df = pd.DataFrame(columns=["block", "forecast_mw"])
    for intraday_file in reversed(intraday_files):
        candidate_df = _load_intraday_graph_df(intraday_file)
        if candidate_df is not None:
            intraday_df = candidate_df
            break
    metered_df = pd.read_csv(metered_files[-1]) if metered_files else pd.DataFrame(columns=["block", "metered_mw"])
    if not metered_df.empty and "block" not in metered_df.columns:
        block_col = next((col for col in ("block", "Block", "BLOCK") if col in metered_df.columns), None)
        power_col = next((col for col in ("metered_mw", "metered_kw", "Active Power-Avg MFM-OUT (KW)") if col in metered_df.columns), None)
        if block_col is not None and power_col is not None:
            metered_df = metered_df[[block_col, power_col]].copy()
            metered_df.columns = ["block", "metered_mw"]
    if not metered_df.empty and {"block", "metered_mw"}.issubset(metered_df.columns):
        metered_by_block = metered_df.groupby("block")["metered_mw"].mean()
    else:
        metered_by_block = pd.Series(dtype=float)
    return intraday_df, metered_by_block


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    logger = logging.getLogger(__name__)

    if not CUSTOM_START_BLOCKS:
        logger.error("CUSTOM_START_BLOCKS is empty. Add at least one block.")
        return 2
    for block in CUSTOM_START_BLOCKS:
        if block < 1 or block > 96:
            logger.error("Invalid block %s in CUSTOM_START_BLOCKS. Must be between 1 and 96.", block)
            return 2
    try:
        custom_date = datetime.strptime(CUSTOM_DATE, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        logger.error("Invalid CUSTOM_DATE %s. Expected YYYY-MM-DD.", CUSTOM_DATE)
        return 2

    if not ENGINE_SCRIPT.exists():
        logger.error("Engine script not found: %s", ENGINE_SCRIPT)
        return 2
    if not SKIP_FETCH and not CUSTOM_FETCHER_SCRIPT.exists():
        logger.error("Custom fetcher not found: %s", CUSTOM_FETCHER_SCRIPT)
        return 2

    custom_root = Path(__file__).resolve().parents[2] / "custom"
    site_id_norm = SITE_ID.strip().upper()
    custom_input_root = custom_root / "input" / site_id_norm
    custom_output_root = custom_root / "output" / site_id_norm
    day_output_root = custom_output_root / custom_date
    (day_output_root / "schedules").mkdir(parents=True, exist_ok=True)
    (day_output_root / "graphs").mkdir(parents=True, exist_ok=True)
    (day_output_root / "logs").mkdir(parents=True, exist_ok=True)
    (day_output_root / "combined").mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["SITE_ID"] = site_id_norm

    if not SKIP_FETCH:
        logger.info("Fetching custom input data for date %s", custom_date)
        import subprocess
        fetch_proc = subprocess.run(
            [sys.executable, str(CUSTOM_FETCHER_SCRIPT), "--date", custom_date],
            env=env,
        )
        if fetch_proc.returncode != 0:
            logger.error("Custom fetch failed for %s", custom_date)
            return fetch_proc.returncode

    intraday_root = custom_input_root / custom_date / "enercast_data" / "intraday"
    selection_mode = str(INTRADAY_SELECTION_MODE or "prompt").strip().lower()
    intraday_runs: list[str | None]
    if selection_mode == "configured":
        if INTRADAY_FILE_NAMES:
            intraday_runs = [str(x).strip() for x in INTRADAY_FILE_NAMES if str(x).strip()]
        elif INTRADAY_FILE_NAME.strip():
            intraday_runs = [INTRADAY_FILE_NAME.strip()]
        else:
            logger.warning("INTRADAY_SELECTION_MODE=configured but no INTRADAY_FILE_NAME(S) provided; using latest.")
            intraday_runs = [None]
    elif selection_mode == "all":
        files = _list_intraday_files(intraday_root)
        intraday_runs = [p.name for p in files]
        if not intraday_runs:
            logger.warning("No intraday files found for all-mode; using latest fallback behavior.")
            intraday_runs = [None]
    elif selection_mode == "latest":
        intraday_runs = [None]
    else:
        selected = _select_intraday_file_interactive(logger, intraday_root)
        intraday_runs = [selected] if selected else [None]

    for block in CUSTOM_START_BLOCKS:
        fixed_da_label = FIXED_DA_BLOCK_LABELS.get(block)
        has_intraday = intraday_root.exists() and any(intraday_root.glob("*.csv"))
        for intraday_name in intraday_runs:
            run_token = "latest"
            if intraday_name:
                run_token = _safe_token(Path(intraday_name).stem)
                logger.info(
                    "Launching fetcher->scheduler | date=%s | custom_start_block=%s | intraday_file=%s",
                    custom_date,
                    block,
                    intraday_name,
                )
            else:
                logger.info(
                    "Launching fetcher->scheduler | date=%s | custom_start_block=%s | intraday_file=LATEST",
                    custom_date,
                    block,
                )

            run_output_root = custom_output_root / custom_date / "intraday_runs" / run_token
            (run_output_root / custom_date / "schedules").mkdir(parents=True, exist_ok=True)
            (run_output_root / custom_date / "graphs").mkdir(parents=True, exist_ok=True)
            (run_output_root / custom_date / "logs").mkdir(parents=True, exist_ok=True)
            (run_output_root / custom_date / "combined").mkdir(parents=True, exist_ok=True)

            event = {
                "local_invoke": True,
                "force_local_rerun": True,
                "skip_fetch": True,
                "trigger_type": "CUSTOM",
                "run_date": custom_date,
                "run_ts_ist": f"{custom_date}T00:00:00+05:30",
                "current_block": block,
                "custom_start_block": block,
                "intraday_file_name": intraday_name,
                "source_event_id": intraday_name or f"custom_block_{block}",
                "local_env": {
                    "DATA_ROOT": str(custom_input_root),
                    "DATA_DATE": custom_date,
                    "CUSTOM_OUTPUT_BASE": str(run_output_root),
                    "LOG_ROOT": str(run_output_root / custom_date / "logs"),
                    "FORCE_LOCAL_RERUN": "1",
                    "CUSTOM_GRAPH_FULL_METERED": "1",
                    "RUN_DA_ONLY": "1" if fixed_da_label is not None else ("0" if has_intraday else "1"),
                    "DA_SCHEDULE_REASON_LABEL": fixed_da_label or "",
                },
            }
            response = run_fetcher(site_id_norm, event, context=None)
            if int(response.get("statusCode", 500)) != 200:
                return int(response.get("statusCode", 500))
    latest_intraday_df, metered_by_block = _load_graph_inputs(custom_input_root, custom_date)
    _reduce_final_frozen_schedule(custom_output_root, site_id_norm, custom_date, latest_intraday_df, metered_by_block)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
