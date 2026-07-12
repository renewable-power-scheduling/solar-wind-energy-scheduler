import logging
from pathlib import Path
from datetime import datetime, date


class BlockScheduleLogger:
    def __init__(self, test_date: date, logs_root: Path = None, use_date_subdir: bool = True):
        self.test_date = test_date
        self.logs_root = logs_root or Path("logs")
        if use_date_subdir:
            self.date_logs_dir = self.logs_root / test_date.strftime("%Y-%m-%d")
        else:
            self.date_logs_dir = self.logs_root
        self.date_logs_dir.mkdir(parents=True, exist_ok=True)

    def get_logger_for_schedule(self, engine_block: int, log_filename: str | None = None) -> logging.Logger:
        log_filename = log_filename or f"schedule from {engine_block} block.log"
        log_filepath = self.date_logs_dir / log_filename

        logger = logging.getLogger(f"schedule_blocks_{log_filepath}")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

        file_handler = logging.FileHandler(log_filepath, mode="a", encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

        return logger

    def log_schedule_header(self, logger: logging.Logger, engine_block: int, test_date: date, dynamic_start_block: int = None, schedule_reason: str | None = None):
        logger.info("=" * 80)
        logger.info(f"SCHEDULE FILE: schedule_from_{engine_block:02d}.csv")
        logger.info(f"DATE: {test_date.strftime('%Y-%m-%d')}")
        logger.info(f"ENGINE BLOCK (Start Block): {engine_block}")
        if dynamic_start_block is not None:
            logger.info(f"SCHEDULE START BLOCK: {dynamic_start_block}")
        if schedule_reason is not None:
            logger.info(f"SCHEDULE REASON: {schedule_reason}")
        logger.info(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        logger.info("=" * 80)

    def log_block_calculation(self, logger: logging.Logger, block: int, is_frozen: bool, frozen_algo_value: float = None, **kwargs):
        logger.info("-" * 80)
        logger.info(f"BLOCK {block:02d}")
        logger.info("-" * 80)

        if is_frozen:
            logger.info("STATUS: FROZEN (Value from previous schedule)")
            logger.info(f"FROZEN ALGO SCHEDULE: {frozen_algo_value:.3f} MW")
            logger.info("-" * 80)
            return

        logger.info("--- FORECAST DATA ---")
        intraday = kwargs.get("intraday_forecast", 0)
        dayahead = kwargs.get("dayahead_forecast", 0)
        base_forecast = kwargs.get("base_forecast", 0)
        base_forecast_raw = kwargs.get("base_forecast_raw", None)
        effective_base_forecast = kwargs.get("effective_base_forecast", None)

        logger.info(f"Intraday Forecast (Enercast): {intraday:.3f} MW")
        logger.info(f"Day-ahead Forecast (Enercast): {dayahead:.3f} MW")

        if base_forecast_raw is not None:
            logger.info(f"Base Forecast (raw, before curtailment/shutdown): {base_forecast_raw:.3f} MW")
        logger.info(f"Base Forecast (used for schedule): {base_forecast:.3f} MW")
        if effective_base_forecast is not None:
            logger.info(f"Effective Base Forecast (after curtailment/shutdown): {effective_base_forecast:.3f} MW")
        plant_status = kwargs.get("plant_status")
        curtailment_capacity = kwargs.get("curtailment_capacity")
        curtailment_scale = kwargs.get("curtailment_scale")
        plant_capacity_mw = kwargs.get("plant_capacity_mw")
        if plant_status:
            logger.info(f"Plant Status: {plant_status}")
        if plant_status == "CURTAILMENT":
            if curtailment_capacity is not None and plant_capacity_mw is not None and curtailment_scale is not None and base_forecast_raw is not None and effective_base_forecast is not None:
                logger.info("Curtailment Scale = curtailment_capacity / plant_capacity = " f"{curtailment_capacity:.3f} / {plant_capacity_mw:.3f} = {curtailment_scale:.6f}")
                logger.info("Effective Base Forecast = Base Forecast (raw) * Curtailment Scale = " f"{base_forecast_raw:.3f} * {curtailment_scale:.6f} = " f"{effective_base_forecast:.3f} MW")
        elif plant_status == "SHUTDOWN":
            if base_forecast_raw is not None and effective_base_forecast is not None:
                logger.info("Effective Base Forecast = Base Forecast (raw) * 0 (shutdown) = " f"{base_forecast_raw:.3f} * 0 = {effective_base_forecast:.3f} MW")
        elif base_forecast_raw is not None and effective_base_forecast is not None:
            logger.info("Effective Base Forecast = Base Forecast (raw) = " f"{effective_base_forecast:.3f} MW")

        ramp_cap_value = kwargs.get("ramp_cap_value", None)
        ramp_cap_reason = kwargs.get("ramp_cap_reason", None)
        if ramp_cap_value is not None:
            logger.info(f"Ramp Cap Applied: {ramp_cap_value:.3f} MW")
            if ramp_cap_reason:
                logger.info(f"Ramp Cap Reason: {ramp_cap_reason}")

        logger.info("--- SCHEDULE CALCULATION ---")
        condition_used = kwargs.get("condition_used", "NONE")
        logger.info(f"Condition Applied: {condition_used}")
        if effective_base_forecast is not None:
            logger.info(f"Effective Base Forecast Used for Adjustments: {effective_base_forecast:.3f} MW")

        logger.info("--- FINAL RESULT ---")
        algo_schedule = kwargs.get("algo_schedule", 0)
        raw_schedule_value = kwargs.get("raw_schedule_value")
        if raw_schedule_value is not None:
            logger.info(f"Raw Schedule (before smoothing): {raw_schedule_value:.3f} MW")
        logger.info(f"Final Scheduled MW: {algo_schedule:.3f} MW")
        prev_schedule_value = kwargs.get("previous_schedule_value", None)
        if prev_schedule_value is not None:
            logger.info(f"Previous Schedule Value: {prev_schedule_value:.3f} MW")
        logger.info("-" * 80)

    def log_summary(self, logger: logging.Logger, total_blocks: int, frozen_count: int):
        logger.info("=" * 80)
        logger.info("SUMMARY")
        logger.info(f"Total Blocks: {total_blocks}")
        logger.info(f"Frozen Blocks (from previous): {frozen_count}")
        logger.info(f"New Calculated Blocks: {total_blocks - frozen_count}")
        logger.info("=" * 80)
