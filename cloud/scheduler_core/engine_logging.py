from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path


def configure_engine_logger(log_path: Path | None) -> logging.Logger:
    logger = logging.getLogger("phase7_engine")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    logger.propagate = False
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    if log_path is not None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.FileHandler(log_path, mode="a", encoding="utf-8")
            file_handler.setLevel(logging.INFO)
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)
        except Exception:
            pass

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setLevel(logging.INFO)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)
    return logger


class NoopScheduleLogger:
    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None

    def error(self, *args, **kwargs):
        return None


class NoopBlockLoggerManager:
    def __init__(self, date_logs_dir: Path):
        self.date_logs_dir = date_logs_dir

    def get_logger_for_schedule(self, *args, **kwargs):
        return NoopScheduleLogger()

    def log_schedule_header(self, *args, **kwargs):
        return None

    def log_block_calculation(self, *args, **kwargs):
        return None


def rel_path(path: str | Path, root: Path) -> str:
    try:
        return os.path.relpath(str(path), root)
    except Exception:
        return str(path)


def showwarning(logger: logging.Logger, root: Path, message, category, filename, lineno, file=None, line=None):
    logger.warning("Warning %s at %s:%s: %s", category.__name__, rel_path(filename, root), lineno, message)


def log_raw_inputs_manifest(
    *,
    logger: logging.Logger,
    site_id: str,
    repo_root: Path,
    engine_block: int,
    now_ist,
    raw_inputs_manifest_env: str | None = None,
) -> None:
    path = (raw_inputs_manifest_env if raw_inputs_manifest_env is not None else os.getenv("RAW_INPUTS_MANIFEST", "")).strip()
    if not path:
        return
    manifest_path = Path(path)
    if not manifest_path.exists():
        logger.warning("RAW INPUTS | manifest not found: %s", path)
        return

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("RAW INPUTS | failed to parse manifest: %s", path, exc_info=True)
        return

    raw = manifest.get("raw_inputs") or {}
    manifest_site_id = manifest.get("site_id", site_id)
    run_date = manifest.get("run_date", "")
    created_at = manifest.get("manifest_created_at_ist", "")
    logger.info("RAW INPUTS | site=%s | engine_block=%s | now_ist=%s", manifest_site_id, engine_block, now_ist.isoformat())
    if run_date or created_at:
        logger.info("RAW INPUTS | run_date=%s | manifest_created_at_ist=%s", run_date, created_at)

    logger.info("RAW INPUTS | 1) Enercast Forecasts")
    enercast = raw.get("enercast") or {}
    day_ahead_list = enercast.get("day_ahead") or []
    intraday_list = enercast.get("intraday") or []
    if day_ahead_list:
        logger.info("RAW INPUTS |    1.1) Day-ahead")
        for item in day_ahead_list:
            logger.info(
                "RAW INPUTS |      - %s | file=%s | fetched=%s -> %s | local=%s",
                item.get("action", "unknown"),
                item.get("filename", ""),
                item.get("download_started_at_ist", ""),
                item.get("download_finished_at_ist", item.get("recorded_at_ist", "")),
                item.get("local_path", ""),
            )
    else:
        logger.info("RAW INPUTS |    1.1) Day-ahead: none recorded")

    if intraday_list:
        logger.info("RAW INPUTS |    1.2) Intraday")
        for item in intraday_list:
            logger.info(
                "RAW INPUTS |      - %s | file=%s | fetched=%s -> %s | local=%s",
                item.get("action", "unknown"),
                item.get("filename", ""),
                item.get("download_started_at_ist", ""),
                item.get("download_finished_at_ist", item.get("recorded_at_ist", "")),
                item.get("local_path", ""),
            )
    else:
        logger.info("RAW INPUTS |    1.2) Intraday: none recorded")

    logger.info("RAW INPUTS | 2) Metered Data")
    metered = raw.get("metered") or []
    if metered:
        for item in metered:
            result = item.get("result") or {}
            logger.info(
                "RAW INPUTS |      - remote=%s | fetched=%s -> %s | local=%s | result=%s",
                item.get("remote_path", ""),
                item.get("download_started_at_ist", ""),
                item.get("download_finished_at_ist", ""),
                item.get("local_path", ""),
                result,
            )
    else:
        logger.info("RAW INPUTS |    Metered: none recorded")

    logger.info("RAW INPUTS | 3) Weather: omitted")
