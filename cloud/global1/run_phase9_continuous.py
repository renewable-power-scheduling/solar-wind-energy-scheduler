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
SITE_ID = os.getenv("SITE_ID", "Bhupalpally").strip().upper()
SITE_IDS_ENV = os.getenv("SITE_IDS", "").strip()
STATE_PATH = Path(
    os.getenv(
        "CONTINUOUS_STATE_PATH",
        str(Path("logs") / SITE_ID / "continuous_scheduler_state.json"),
    )
)
ENGINE_SCRIPT = Path("run_phase9_engine.py")
RUNNER_LOG_DIR = Path(os.getenv("CONTINUOUS_LOG_DIR", str(Path("logs") / SITE_ID)))
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
    csv_path = base / f"schedule_from_{trigger_block:02d}.csv"
    meta_path = csv_path.with_suffix(".meta.json")
    return csv_path.exists() and meta_path.exists()


def _run_da_recovery(site_id: str, target_block: datetime, trigger_block: int, reason_label: str) -> int:
    env = dict(os.environ)
    env["SITE_ID"] = site_id
    env["ENGINE_BLOCK_OVERRIDE"] = str(trigger_block)
    env["ENGINE_NOW_IST"] = target_block.isoformat()
    env["RUN_DA_ONLY"] = "1"
    env["DA_SCHEDULE_REASON_LABEL"] = reason_label
    proc = subprocess.run([sys.executable, str(ENGINE_SCRIPT)], env=env)
    return int(proc.returncode)


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


def run_engine_for_block(target_block: datetime, site_id: str) -> int:
    env = dict(os.environ)
    env["SITE_ID"] = site_id
    block_num = int(target_block.strftime("%H")) * 4 + (int(target_block.strftime("%M")) // 15) + 1
    env["ENGINE_BLOCK_OVERRIDE"] = str(block_num)
    fixed_da_label = FIXED_DA_BLOCK_LABELS.get(block_num)
    if fixed_da_label is not None:
        env["RUN_DA_ONLY"] = "1"
        env["DA_SCHEDULE_REASON_LABEL"] = fixed_da_label
    else:
        env.pop("RUN_DA_ONLY", None)
        env.pop("DA_SCHEDULE_REASON_LABEL", None)
    proc = subprocess.run([sys.executable, str(ENGINE_SCRIPT)], env=env)
    return proc.returncode


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

        block_num = int(target_block.strftime("%H")) * 4 + (int(target_block.strftime("%M")) // 15) + 1
        schedule_date = target_block.date() + timedelta(days=1)
        procs: list[tuple[str, subprocess.Popen]] = []
        for site in site_ids:
            env = dict(os.environ)
            env["SITE_ID"] = site
            env["ENGINE_BLOCK_OVERRIDE"] = str(block_num)
            fixed_da_label = FIXED_DA_BLOCK_LABELS.get(block_num)
            if fixed_da_label is not None:
                env["RUN_DA_ONLY"] = "1"
                env["DA_SCHEDULE_REASON_LABEL"] = fixed_da_label
            else:
                env.pop("RUN_DA_ONLY", None)
                env.pop("DA_SCHEDULE_REASON_LABEL", None)
            procs.append((site, subprocess.Popen([sys.executable, str(ENGINE_SCRIPT)], env=env)))

        site_ok: dict[str, bool] = {}
        for site, proc in procs:
            rc = proc.wait()
            if rc == 0:
                site_ok[site] = True
                logger.info("Pipeline completed for block %s | site=%s", target_key, site)
            else:
                site_ok[site] = False
                logger.error("Pipeline failed for block %s | site=%s | exit code=%s", target_key, site, rc)

        recovery_target = DA_RECOVERY_WINDOWS.get(block_num)
        if recovery_target is not None:
            trigger_block, reason_label = recovery_target
            missing_sites = [
                site for site in site_ids
                if not _has_da_artifacts(site, schedule_date, trigger_block)
            ]
            if missing_sites:
                logger.warning(
                    "DA recovery check | block=%s | trigger_block=%s | schedule_date=%s | missing_sites=%s",
                    block_num,
                    trigger_block,
                    schedule_date.strftime("%Y-%m-%d"),
                    ",".join(missing_sites),
                )
                for site in missing_sites:
                    rc = _run_da_recovery(
                        site_id=site,
                        target_block=target_block,
                        trigger_block=trigger_block,
                        reason_label=reason_label,
                    )
                    recovered = (rc == 0) and _has_da_artifacts(site, schedule_date, trigger_block)
                    if recovered:
                        site_ok[site] = True
                        logger.info(
                            "DA recovery succeeded | site=%s | trigger_block=%s | schedule_date=%s",
                            site,
                            trigger_block,
                            schedule_date.strftime("%Y-%m-%d"),
                        )
                    else:
                        site_ok[site] = False
                        logger.error(
                            "DA recovery failed | site=%s | trigger_block=%s | schedule_date=%s | exit_code=%s",
                            site,
                            trigger_block,
                            schedule_date.strftime("%Y-%m-%d"),
                            rc,
                        )
            else:
                logger.info(
                    "DA recovery check passed | block=%s | trigger_block=%s | all sites present for %s",
                    block_num,
                    trigger_block,
                    schedule_date.strftime("%Y-%m-%d"),
                )

        failed = any(not site_ok.get(site, False) for site in site_ids)
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
