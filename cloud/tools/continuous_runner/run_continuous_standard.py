import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from logging import Logger

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cloud.fetcher_core.fetcher_engine import run as run_fetcher


IST = ZoneInfo("Asia/Kolkata")
BLOCK_MINUTES = 15
OFFSET_MINUTES = 5
OFFSET_TOLERANCE_MINUTES = 1
SITE_ID = "Sirmour"  # edit this site name before running
SITE_IDS = ""  # optional comma-separated site list; leave blank to use SITE_ID only
STATE_PATH = Path(
    os.getenv(
        "CONTINUOUS_STATE_PATH",
        str(Path("logs") / SITE_ID.strip().upper() / "continuous_scheduler_state.json"),
    )
)
RUNNER_LOG_DIR = Path(os.getenv("CONTINUOUS_LOG_DIR", str(Path("logs") / SITE_ID.strip().upper())))
FIXED_DA_BLOCK_LABELS = {}
DA_RECOVERY_WINDOWS = {}


def floor_to_block(ts: datetime) -> datetime:
    minute = (ts.minute // BLOCK_MINUTES) * BLOCK_MINUTES
    return ts.replace(minute=minute, second=0, microsecond=0)


def block_key(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M")


def _da_output_dir(site_id: str, schedule_date) -> Path:
    return Path("outputs") / site_id / schedule_date.strftime("%Y-%m-%d") / "Day-ahead"


def _has_da_artifacts(site_id: str, schedule_date, trigger_block: int) -> bool:
    base = _da_output_dir(site_id, schedule_date)
    csv_candidates = list(base.glob(f"schedule_from_{trigger_block:02d}*.csv"))
    if not csv_candidates:
        return False
    return any(candidate.with_suffix(".meta.json").exists() for candidate in csv_candidates)


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def sleep_until(target: datetime) -> None:
    while True:
        now = datetime.now(IST)
        remaining = (target - now).total_seconds()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 1.0))


def resolve_site_ids() -> list[str]:
    out: list[str] = []
    for token in SITE_IDS.split(","):
        s = token.strip().upper()
        if s and s not in out:
            out.append(s)
    if out:
        return out
    return [SITE_ID.strip().upper()]


def configure_logger() -> Logger:
    logger = logging.getLogger("continuous_runner")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(formatter)

    logger.addHandler(console)
    logger.propagate = False
    return logger


def configure_daily_file_handler(logger: Logger, now_ist: datetime) -> None:
    day_dir = RUNNER_LOG_DIR / now_ist.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    day_log_path = day_dir / "continuous_runner.log"
    current_date = now_ist.strftime("%Y-%m-%d")

    if getattr(logger, "_daily_log_date", None) == current_date:
        return

    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")
    for h in list(logger.handlers):
        if isinstance(h, logging.FileHandler):
            logger.removeHandler(h)
            h.close()

    file_handler = logging.FileHandler(day_log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    logger._daily_log_date = current_date


def main() -> None:
    logger = configure_logger()
    configure_daily_file_handler(logger, datetime.now(IST))
    site_ids = resolve_site_ids()
    logger.info("===== CONTINUOUS 15-MIN SCHEDULER STARTED =====")
    logger.info(
        "Config | block=%s min, offset=%s min, tolerance=%s min, tz=%s",
        BLOCK_MINUTES,
        OFFSET_MINUTES,
        OFFSET_TOLERANCE_MINUTES,
        "Asia/Kolkata",
    )
    logger.info("Sites configured for continuous run: %s", ", ".join(site_ids))

    state = load_state()
    last_executed = state.get("last_executed_block")

    while True:
        now = datetime.now(IST)
        configure_daily_file_handler(logger, now)
        current_block = floor_to_block(now)
        offset_deadline = current_block + timedelta(minutes=OFFSET_MINUTES)

        if now <= offset_deadline + timedelta(minutes=OFFSET_TOLERANCE_MINUTES):
            target_block = current_block
            target_run_time = offset_deadline
            decision = "WAIT_CURRENT_BLOCK_OFFSET"
            if now == offset_deadline:
                logger.info(
                    "At offset deadline (now=%s, offset_deadline=%s, current_block=%s, target_block=%s); still running current block to avoid skip",
                    now.isoformat(),
                    offset_deadline.isoformat(),
                    current_block.isoformat(),
                    target_block.isoformat(),
                )
            elif now > offset_deadline:
                logger.info(
                    "Within tolerance window (now=%s, offset_deadline=%s, tolerance=%s min, current_block=%s, target_block=%s); running current block",
                    now.isoformat(),
                    offset_deadline.isoformat(),
                    OFFSET_TOLERANCE_MINUTES,
                    current_block.isoformat(),
                    target_block.isoformat(),
                )
        else:
            target_block = current_block + timedelta(minutes=BLOCK_MINUTES)
            target_run_time = target_block + timedelta(minutes=OFFSET_MINUTES)
            decision = "WAIT_NEXT_BLOCK_OFFSET"

        target_end_time = target_block + timedelta(minutes=BLOCK_MINUTES)
        target_end_with_tolerance = target_end_time + timedelta(minutes=OFFSET_TOLERANCE_MINUTES)
        logger.info(
            "Now=%s | CurrentBlock=%s | OffsetDeadline=%s | Decision=%s | TargetBlock=%s | TargetRun=%s | TargetEnd=%s | TargetEndWithTolerance=%s",
            now.isoformat(),
            current_block.isoformat(),
            offset_deadline.isoformat(),
            decision,
            target_block.isoformat(),
            target_run_time.isoformat(),
            target_end_time.isoformat(),
            target_end_with_tolerance.isoformat(),
        )

        if now < target_run_time:
            sleep_until(target_run_time)
            now = datetime.now(IST)

        if now > target_run_time + timedelta(minutes=OFFSET_MINUTES):
            logger.info("Missed target run window due to drift; recomputing")
            continue

        target_key = block_key(target_block)
        if target_key == last_executed:
            logger.info("Duplicate guard: block %s already executed; waiting next offset window", target_key)
            sleep_until(target_block + timedelta(minutes=BLOCK_MINUTES + OFFSET_MINUTES))
            continue

        logger.info("Executing pipeline for block %s", target_key)
        state["last_executed_block"] = target_key
        save_state(state)
        last_executed = target_key

        block_num = int(target_block.strftime("%H")) * 4 + (int(target_block.strftime("%M")) // 15) + 1
        for site in site_ids:
            response = run_fetcher(
                site,
                {
                    "local_invoke": True,
                    "run_date": target_block.strftime("%Y-%m-%d"),
                    "run_ts_ist": target_block.isoformat(),
                    "current_block": block_num,
                },
                context=None,
            )
            if int(response.get("statusCode", 500)) == 200:
                logger.info("Fetcher pipeline completed for block %s | site=%s", target_key, site)
                site_ok = True
            else:
                logger.error("Fetcher pipeline failed for block %s | site=%s | status=%s", target_key, site, response.get("statusCode"))
                site_ok = False
            state.setdefault("site_status", {})[site] = site_ok

        failed = any(not bool((state.get("site_status") or {}).get(site, False)) for site in site_ids)
        if failed:
            logger.error("One or more site runs failed for block %s", target_key)
        else:
            logger.info("All site runs completed for block %s", target_key)
        execution_end = datetime.now(IST)
        block_end = target_block + timedelta(minutes=BLOCK_MINUTES)
        block_end_with_tolerance = block_end + timedelta(minutes=OFFSET_TOLERANCE_MINUTES)
        logger.info(
            "Execution ended | Now=%s | BlockEnd=%s | BlockEndWithTolerance=%s",
            execution_end.isoformat(),
            block_end.isoformat(),
            block_end_with_tolerance.isoformat(),
        )
        logger.info("Returning to runner loop")

        sleep_until(target_block + timedelta(minutes=BLOCK_MINUTES + OFFSET_MINUTES))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logging.getLogger(__name__).info("Scheduler stopped by user")
