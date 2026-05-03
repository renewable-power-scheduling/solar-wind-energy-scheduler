import logging
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ENGINE_SCRIPT = Path("run_phase9_engine.py")
CUSTOM_FETCHER_SCRIPT = Path("custom") / "custom_fetcher.py"
IST = ZoneInfo("Asia/Kolkata")
FIXED_DA_BLOCK_LABELS = {
    22: "Day-ahead 1st rev",
    88: "Day-ahead 2nd rev",
}

# ------------------------------------------------------------------
# CUSTOM RUN CONFIG (edit these values directly before running)
# ------------------------------------------------------------------
SITE_ID = "Kothagudem"  # e.g. SIRMOUR / KOTHAGUDEM / KASIPET / BHUPALPALLY / OSEPL
CUSTOM_DATE = "2026-04-16"  # YYYY-MM-DD
CUSTOM_START_BLOCKS = [31]  # one or more start blocks (1..96)
SKIP_FETCH = False  # True => use existing custom/input data


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
        datetime.strptime(CUSTOM_DATE, "%Y-%m-%d")
    except ValueError:
        logger.error("Invalid CUSTOM_DATE %s. Expected YYYY-MM-DD.", CUSTOM_DATE)
        return 2

    if not ENGINE_SCRIPT.exists():
        logger.error("Engine script not found: %s", ENGINE_SCRIPT)
        return 2
    if not SKIP_FETCH and not CUSTOM_FETCHER_SCRIPT.exists():
        logger.error("Custom fetcher not found: %s", CUSTOM_FETCHER_SCRIPT)
        return 2

    custom_root = Path("custom")
    site_id_norm = SITE_ID.strip().upper()
    custom_input_root = custom_root / "input" / site_id_norm
    custom_output_root = custom_root / "output" / site_id_norm
    day_output_root = custom_output_root / CUSTOM_DATE
    (day_output_root / "schedules").mkdir(parents=True, exist_ok=True)
    (day_output_root / "graphs").mkdir(parents=True, exist_ok=True)
    (day_output_root / "logs").mkdir(parents=True, exist_ok=True)
    (day_output_root / "combined").mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["SITE_ID"] = site_id_norm
    env["DATA_ROOT"] = str(custom_input_root)
    env["DATA_DATE"] = CUSTOM_DATE
    env["CUSTOM_OUTPUT_BASE"] = str(custom_output_root)
    env["LOG_ROOT"] = str(day_output_root / "logs")
    env["SKIP_FETCHER"] = "1"
    env["ENGINE_NOW_IST"] = f"{CUSTOM_DATE}T00:00:00+05:30"

    if not SKIP_FETCH:
        logger.info("Fetching custom input data for date %s", CUSTOM_DATE)
        fetch_proc = subprocess.run(
            [sys.executable, str(CUSTOM_FETCHER_SCRIPT), "--date", CUSTOM_DATE],
            env=env,
        )
        if fetch_proc.returncode != 0:
            logger.error("Custom fetch failed for %s", CUSTOM_DATE)
            return fetch_proc.returncode

    for block in CUSTOM_START_BLOCKS:
        env["CUSTOM_START_BLOCK"] = str(block)
        fixed_da_label = FIXED_DA_BLOCK_LABELS.get(block)
        if fixed_da_label is not None:
            env["RUN_DA_ONLY"] = "1"
            env["DA_SCHEDULE_REASON_LABEL"] = fixed_da_label
            logger.info(
                "Custom mode fixed DA block=%s -> run_da_only=1 schedule_reason=%s",
                block,
                fixed_da_label,
            )
        else:
            intraday_root = custom_input_root / CUSTOM_DATE / "enercast_data" / "intraday"
            has_intraday = intraday_root.exists() and any(intraday_root.glob("*.csv"))
            env["RUN_DA_ONLY"] = "0" if has_intraday else "1"
            env.pop("DA_SCHEDULE_REASON_LABEL", None)
            logger.info("Custom mode run_da_only=%s (intraday_present=%s)", env["RUN_DA_ONLY"], has_intraday)
        logger.info(
            "Launching engine for date %s with custom start block %s",
            CUSTOM_DATE,
            block,
        )
        proc = subprocess.run([sys.executable, str(ENGINE_SCRIPT)], env=env)
        if proc.returncode != 0:
            return proc.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
