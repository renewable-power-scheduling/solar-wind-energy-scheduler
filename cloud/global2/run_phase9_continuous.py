import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from logging import Logger


IST = ZoneInfo("Asia/Kolkata")
BLOCK_MINUTES = 15
OFFSET_MINUTES = 5
OFFSET_TOLERANCE_MINUTES = 1
SITE_ID = os.getenv("SITE_ID", "GSNP").strip().upper()
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
STATE_PATH = Path(
    os.getenv(
        "CONTINUOUS_STATE_PATH",
        str(Path("logs") / SITE_ID / "continuous_scheduler_state.json"),
    )
)
ENGINE_SCRIPT = Path("run_phase9_engine.py")
RUNNER_LOG_DIR = Path(os.getenv("CONTINUOUS_LOG_DIR", str(Path("logs") / SITE_ID)))


def floor_to_block(ts: datetime) -> datetime:
    minute = (ts.minute // BLOCK_MINUTES) * BLOCK_MINUTES
    return ts.replace(minute=minute, second=0, microsecond=0)


def block_key(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M")


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
    if SITE_IDS_ENV:
        out: list[str] = []
        for token in SITE_IDS_ENV.split(","):
            s = token.strip().upper()
            if s and s not in out:
                out.append(s)
        if out:
            return out
    return [SITE_ID]


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

    if not ENGINE_SCRIPT.exists():
        raise FileNotFoundError(f"Engine script not found: {ENGINE_SCRIPT}")

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

        procs: list[tuple[str, subprocess.Popen]] = []
        for site in site_ids:
            env = dict(os.environ)
            env["SITE_ID"] = site
            env["SCHEDULER_TARGET_BLOCK_IST"] = block_key(target_block)
            procs.append((site, subprocess.Popen([sys.executable, str(ENGINE_SCRIPT)], env=env)))

        failed = False
        for site, proc in procs:
            rc = proc.wait()
            if rc == 0:
                logger.info("Pipeline completed for block %s | site=%s", target_key, site)
            else:
                failed = True
                logger.error("Pipeline failed for block %s | site=%s | exit code=%s", target_key, site, rc)

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
