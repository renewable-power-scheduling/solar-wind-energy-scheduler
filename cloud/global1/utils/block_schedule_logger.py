"""
Block-wise detailed logging for schedule generation.
Creates detailed logs for each schedule file with all conditions and parameters.
"""

import logging
from pathlib import Path
from datetime import datetime, date


class BlockScheduleLogger:
    """
    Creates a detailed log file for each schedule file generated.
    Logs all conditions, thresholds, weather parameters, and calculation details.
    """

    def log_weather_state_overview(self, logger: logging.Logger, weather_state_map: dict):
        """
        Log the weather state for all blocks at the start of the log file.
        Args:
            logger: Logger instance
            weather_state_map: dict mapping block number to weather state
        """
        logger.info("BLOCK-WISE WEATHER STATE OVERVIEW")
        logger.info("Block | Weather State")
        for block in sorted(weather_state_map.keys()):
            logger.info(f"{block:02d}    | {weather_state_map[block]}")
        logger.info("-" * 80)

    def __init__(self, test_date: date, logs_root: Path = None, use_date_subdir: bool = True):
        """
        Initialize logger for a specific date.

        Args:
            test_date: The date being processed
            logs_root: Root directory for logs (default: logs/)
        """
        self.test_date = test_date
        self.logs_root = logs_root or Path("logs")

        # Create logs directory with date subfolder
        if use_date_subdir:
            self.date_logs_dir = self.logs_root / test_date.strftime("%Y-%m-%d")
        else:
            self.date_logs_dir = self.logs_root
        self.date_logs_dir.mkdir(parents=True, exist_ok=True)

    def get_logger_for_schedule(self, engine_block: int, log_filename: str | None = None) -> logging.Logger:
        """
        Create and return a logger for a specific schedule file.

        Args:
            engine_block: The engine block number (e.g., 20, 21, ...)

        Returns:
            Configured logger instance
        """
        log_filename = log_filename or f"schedule from {engine_block} block.log"
        log_filepath = self.date_logs_dir / log_filename

        logger = logging.getLogger(f"schedule_blocks_{log_filepath}")
        logger.handlers.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        formatter = logging.Formatter(
            "%(asctime)s | %(levelname)s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )

        file_handler = logging.FileHandler(log_filepath, mode="a", encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

        return logger

    def log_schedule_header(
        self,
        logger: logging.Logger,
        engine_block: int,
        test_date: date,
        dynamic_start_block: int = None,
        metered_pair: list = None,
        schedule_reason: str | None = None,
    ):
        """Log header information for the schedule file."""
        logger.info("=" * 80)
        logger.info(f"SCHEDULE FILE: schedule_from_{engine_block:02d}.csv")
        logger.info(f"DATE: {test_date.strftime('%Y-%m-%d')}")
        logger.info(f"ENGINE BLOCK (Start Block): {engine_block}")
        if dynamic_start_block is not None:
            logger.info(f"DYNAMIC START BLOCK: {dynamic_start_block}")
        if schedule_reason is not None:
            logger.info(f"SCHEDULE REASON: {schedule_reason}")

        if metered_pair:
            if len(metered_pair) == 2:
                logger.info(
                    "METERED PAIR USED (engine_block-2, engine_block-1): "
                    f"{metered_pair[0]:.3f} MW, {metered_pair[1]:.3f} MW"
                )
            else:
                logger.info(f"METERED PAIR USED: {metered_pair[0]:.3f} MW")
        logger.info(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        logger.info("=" * 80)

    def log_block_calculation(
        self,
        logger: logging.Logger,
        block: int,
        is_frozen: bool,
        frozen_algo_value: float = None,
        **kwargs
    ):
        """
        Log detailed calculation for a single block.

        Args:
            logger: Logger instance
            block: Block number
            is_frozen: Whether this block is frozen from previous schedule
            frozen_algo_value: The frozen algo value if block is frozen
            **kwargs: All calculation parameters
        """
        logger.info("-" * 80)
        logger.info(f"BLOCK {block:02d}")
        logger.info("-" * 80)

        if is_frozen:
            logger.info("STATUS: FROZEN (Value from previous schedule)")
            logger.info(f"FROZEN ALGO SCHEDULE: {frozen_algo_value:.3f} MW")
            logger.info("-" * 80)
            return

        # Metered data
        logger.info("--- METERED DATA ---")
        metered_val = kwargs.get("metered_val")
        last_two_metered = kwargs.get("last_two_metered", [])
        if metered_val is not None:
            logger.info(f"Metered Value (actual): {metered_val:.3f} MW")
        else:
            logger.info("Metered Value: NOT YET AVAILABLE")
        logger.info(f"Last Two Metered Values (for trend): {[f'{m:.3f}' for m in last_two_metered]}")

        # Forecasts
        logger.info("--- FORECAST DATA ---")
        intraday = kwargs.get("intraday_forecast", 0)
        dayahead = kwargs.get("dayahead_forecast", 0)
        base_forecast = kwargs.get("base_forecast", 0)
        base_forecast_raw = kwargs.get("base_forecast_raw", None)
        effective_base_forecast = kwargs.get("effective_base_forecast", None)

        logger.info(f"Intraday Forecast (Enercast): {intraday:.3f} MW")
        logger.info(f"Day-ahead Forecast (Enercast): {dayahead:.3f} MW")

        if base_forecast_raw is not None:
            logger.info(
                f"Base Forecast (raw, before curtailment/shutdown): {base_forecast_raw:.3f} MW"
            )
        logger.info(f"Base Forecast (used for schedule): {base_forecast:.3f} MW")
        if effective_base_forecast is not None:
            logger.info(
                f"Effective Base Forecast (after curtailment/shutdown): {effective_base_forecast:.3f} MW"
            )
        meter_ref = kwargs.get("meter_ref")
        meter_weight = kwargs.get("meter_weight")
        meter_factor = kwargs.get("meter_factor")
        if meter_ref is not None and meter_weight is not None and meter_factor is not None:
            logger.info(
                f"Base Blend Inputs: meter_ref={meter_ref:.3f} MW, "
                f"meter_factor={meter_factor:.3f}, meter_weight={meter_weight:.3f}"
            )
        plant_status = kwargs.get("plant_status")
        curtailment_capacity = kwargs.get("curtailment_capacity")
        curtailment_scale = kwargs.get("curtailment_scale")
        plant_capacity_mw = kwargs.get("plant_capacity_mw")
        if plant_status:
            logger.info(f"Plant Status: {plant_status}")
        if plant_status == "CURTAILMENT":
            if (
                curtailment_capacity is not None
                and plant_capacity_mw is not None
                and curtailment_scale is not None
                and base_forecast_raw is not None
                and effective_base_forecast is not None
            ):
                logger.info(
                    "Curtailment Scale = curtailment_capacity / plant_capacity = "
                    f"{curtailment_capacity:.3f} / {plant_capacity_mw:.3f} = {curtailment_scale:.6f}"
                )
                logger.info(
                    "Effective Base Forecast = Base Forecast (raw) * Curtailment Scale = "
                    f"{base_forecast_raw:.3f} * {curtailment_scale:.6f} = "
                    f"{effective_base_forecast:.3f} MW"
                )
        elif plant_status == "SHUTDOWN":
            if base_forecast_raw is not None and effective_base_forecast is not None:
                logger.info(
                    "Effective Base Forecast = Base Forecast (raw) * 0 (shutdown) = "
                    f"{base_forecast_raw:.3f} * 0 = {effective_base_forecast:.3f} MW"
                )
        elif base_forecast_raw is not None and effective_base_forecast is not None:
            logger.info(
                "Effective Base Forecast = Base Forecast (raw) = "
                f"{effective_base_forecast:.3f} MW"
            )

        # Weather parameters
        logger.info("--- WEATHER PARAMETERS ---")
        gti = kwargs.get("gti", 0)
        dhi = kwargs.get("dhi", 0)
        dni = kwargs.get("dni", 0)
        temp_2m = kwargs.get("temp_2m", 0)
        wind_speed_10m = kwargs.get("wind_speed_10m", 0)
        diffuse_ratio_current = kwargs.get("diffuse_ratio_current", None)
        irradiance_state = kwargs.get("irradiance_state", "UNKNOWN")
        weather_state = kwargs.get("weather_state", "NORMAL")
        irradiance_multiplier = kwargs.get("irradiance_multiplier", None)
        temp_multiplier = kwargs.get("temp_multiplier", None)
        wind_multiplier = kwargs.get("wind_multiplier", None)
        irr_ratio = kwargs.get("irr_ratio", None)
        cloud_threshold = kwargs.get("cloud_threshold", None)
        shift_threshold = kwargs.get("shift_threshold", None)

        logger.info(f"GTI: {gti:.1f} W/m^2")
        logger.info(f"DHI: {dhi:.1f} W/m^2")
        logger.info(f"DNI: {dni:.1f} W/m^2")
        if irr_ratio is not None:
            logger.info(f"Irradiance Ratio (GTI/MAX_GTI): {irr_ratio:.3f}")
        if diffuse_ratio_current is not None:
            logger.info(f"Diffuse Ratio (current): {diffuse_ratio_current:.3f}")
        logger.info(f"Irradiance State: {irradiance_state}")
        logger.info(f"Temp @ 2m: {temp_2m:.2f} C")
        logger.info(f"Wind @ 10m: {wind_speed_10m:.2f} m/s")
        logger.info(f"Weather State: {weather_state}")
        if cloud_threshold is not None and shift_threshold is not None:
            logger.info(
                f"Dynamic Thresholds: cloud_thr={cloud_threshold:.4f}, "
                f"shift_thr={shift_threshold:.4f}"
            )
        if (
            irradiance_multiplier is not None
            and temp_multiplier is not None
            and wind_multiplier is not None
        ):
            logger.info(
                f"Multipliers: irradiance={irradiance_multiplier:.2f}x, "
                f"temp={temp_multiplier:.2f}x, wind={wind_multiplier:.2f}x"
            )
            logger.info(
                "Weather Multiplier (combined): "
                f"{irradiance_multiplier * temp_multiplier * wind_multiplier:.2f}x"
            )

        abrupt_weather = kwargs.get("abrupt_weather", False)
        logger.info(f"Abrupt Weather Change Detected: {abrupt_weather}")
        abrupt_info = kwargs.get("abrupt_info") or {}
        if abrupt_info:
            logger.info("--- ABRUPT DETECTION ---")
            logger.info(
                "Abrupt Decision: state=%s, stage=%s, type=%s",
                abrupt_info.get("state", "NORMAL"),
                abrupt_info.get("decision_stage", "UNKNOWN"),
                abrupt_info.get("abrupt_type"),
            )
            logger.info(
                "Cloud comparison: current_norm=%.4f, forecast_index=%.4f, dev=%.4f, threshold=%.4f",
                float(abrupt_info.get("cloud_now_norm", 0.0) or 0.0),
                float(abrupt_info.get("forecast_cloud_index", 0.0) or 0.0),
                float(abrupt_info.get("cloud_dev", 0.0) or 0.0),
                float(abrupt_info.get("cloud_threshold", 0.0) or 0.0),
            )
            logger.info(
                "Shift comparison: shift_ratio=%.4f, threshold=%.4f, combined_intensity=%.4f",
                float(abrupt_info.get("shift_ratio", 0.0) or 0.0),
                float(abrupt_info.get("shift_threshold", 0.0) or 0.0),
                float(abrupt_info.get("combined_intensity", 0.0) or 0.0),
            )
            logger.info(
                "Weather window: GTI[T]=%s, GTI[T+1]=%s, GTI[T+2]=%s, GTI[T+3]=%s, DHI[T]=%s, min_gti_valid=%.3f",
                abrupt_info.get("gti_t"),
                abrupt_info.get("gti_t1"),
                abrupt_info.get("gti_t2"),
                abrupt_info.get("gti_t3"),
                abrupt_info.get("dhi_t"),
                float(abrupt_info.get("min_gti_valid", 0.0) or 0.0),
            )

        # Trend analysis
        logger.info("--- TREND ANALYSIS ---")
        past_block_values = kwargs.get("past_block_values", [])
        trend_calc_values = kwargs.get("trend_calc_values", [])
        if past_block_values:
            logger.info("Trend series (oldest -> latest):")
            for pb, val, source in past_block_values:
                logger.info(f"  Block {pb:02d}: {val:.3f} MW (source: {source})")
        else:
            logger.info("Trend series: INSUFFICIENT DATA")
        if trend_calc_values:
            logger.info(
                "Trend values used for slope calc: "
                + ", ".join(
                    f"B{pb:02d}={val:.3f}({source})" for pb, val, source in trend_calc_values
                )
            )

        trend_type = kwargs.get("trend_type", "FLAT")
        slope_pct = kwargs.get("slope_pct", 0)
        trend_eps = kwargs.get("trend_eps", None)
        logger.info(f"Detected Trend Type: {trend_type}")
        logger.info(f"Trend Slope Percentage: {slope_pct:.2f}%")
        if trend_eps is not None:
            logger.info(f"Trend EPS Threshold: {trend_eps:.2f}%")

        ramp_cap_value = kwargs.get("ramp_cap_value", None)
        ramp_cap_reason = kwargs.get("ramp_cap_reason", None)
        if ramp_cap_value is not None:
            logger.info(f"Ramp Cap Applied: {ramp_cap_value:.3f} MW")
            if ramp_cap_reason:
                logger.info(f"Ramp Cap Reason: {ramp_cap_reason}")

        # Condition and adjustment logic
        logger.info("--- SCHEDULE CALCULATION ---")
        condition_used = kwargs.get("condition_used", "NONE")
        logger.info(f"Condition Applied: {condition_used}")
        if effective_base_forecast is not None:
            logger.info(
                f"Effective Base Forecast Used for Adjustments: {effective_base_forecast:.3f} MW"
            )

        if condition_used in ("COND_3", "CONDITION_3"):
            logger.info("Condition-3 (Phase-6) Applied:")
            logger.info(
                f"  Forecast Mismatch: Intraday ({intraday:.3f}) != Day-ahead ({dayahead:.3f})"
            )

            operation = kwargs.get("operation", "UNKNOWN")
            logger.info(f"  Operation: {operation}")

            base_adj = kwargs.get("base_adjustment_pct", 0)
            logger.info(f"  Base Adjustment %: {base_adj:.2f}%")

            weather_mult = kwargs.get("weather_multiplier", 1.0)
            irr_mult = kwargs.get("irradiance_multiplier", 1.0)
            temp_mult = kwargs.get("temp_multiplier", 1.0)
            wind_mult = kwargs.get("wind_multiplier", 1.0)
            logger.info(f"  Irradiance Multiplier: {irr_mult:.2f}x")
            logger.info(f"  Temp Multiplier: {temp_mult:.2f}x")
            logger.info(f"  Wind Multiplier: {wind_mult:.2f}x")
            logger.info(f"  Weather Multiplier: {weather_mult:.2f}x")

            final_adj_pct = kwargs.get("final_adjustment_pct", 0)
            logger.info(f"  Final Adjustment %: {final_adj_pct:.2f}%")
            logger.info(
                f"  Calculation: {base_forecast:.3f} MW * (1 + {final_adj_pct:.2f}% / 100)"
            )
        else:
            logger.info("Condition-3: NOT APPLIED for this block path")
            final_adj_pct = kwargs.get("final_adjustment_pct", 0)
            logger.info(f"  Final Adjustment %: {final_adj_pct:.2f}%")

        formula_text = kwargs.get("formula_text")
        if formula_text:
            logger.info(f"  Formula (expanded): {formula_text}")

        # Final result
        logger.info("--- FINAL RESULT ---")
        algo_schedule = kwargs.get("algo_schedule", 0)
        raw_schedule_value = kwargs.get("raw_schedule_value")
        if raw_schedule_value is not None:
            logger.info(f"Raw Schedule (before smoothing): {raw_schedule_value:.3f} MW")
        logger.info(f"Final Scheduled MW: {algo_schedule:.3f} MW")
        prev_schedule_value = kwargs.get("previous_schedule_value", None)
        if prev_schedule_value is not None:
            logger.info(f"Previous Schedule Value: {prev_schedule_value:.3f} MW")
        if metered_val is not None:
            deviation = algo_schedule - metered_val
            logger.info(f"Deviation from Metered: {deviation:+.3f} MW")

        logger.info("-" * 80)

    def log_summary(self, logger: logging.Logger, total_blocks: int, frozen_count: int):
        """Log summary statistics for the schedule file."""
        logger.info("=" * 80)
        logger.info("SUMMARY")
        logger.info(f"Total Blocks: {total_blocks}")
        logger.info(f"Frozen Blocks (from previous): {frozen_count}")
        logger.info(f"New Calculated Blocks: {total_blocks - frozen_count}")
        logger.info("=" * 80)

