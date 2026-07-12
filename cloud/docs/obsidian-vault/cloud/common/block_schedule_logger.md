
# Block Schedule Logger

## Purpose

The `BlockScheduleLogger` is a dedicated logging utility designed to create detailed, human-readable logs for the block-by-block execution of the scheduling algorithm. It captures the inputs, intermediate calculations, and final outputs for each 15-minute time block, providing a clear audit trail for how the schedule was derived.

This logger is crucial for debugging, validation, and understanding the behavior of the scheduling engine, especially when analyzing the impact of different forecasts, curtailment events, and algorithmic adjustments.

## File Location

`d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\common\block_schedule_logger.py`

## Class: `BlockScheduleLogger`

### `__init__(self, test_date: date, logs_root: Path = None, use_date_subdir: bool = True)`

**Purpose:** Initializes the logger for a specific date.

-   **`test_date`**: The date for which the schedules are being generated.
-   **`logs_root`**: The root directory for logs. Defaults to a `logs` subdirectory in the current working directory.
-   **`use_date_subdir`**: If `True` (default), creates a date-stamped subdirectory (e.g., `2023-10-27`) within `logs_root` to store the log files for that day.

### `get_logger_for_schedule(self, engine_block: int, log_filename: str | None = None) -> logging.Logger`

**Purpose:** Creates and configures a specific `logging.Logger` instance for a single schedule run.

-   **`engine_block`**: The starting block number of the schedule being generated (e.g., block 48 for a schedule starting at 12:00).
-   **`log_filename`**: The name of the log file. If not provided, it defaults to a descriptive name like `schedule from 48 block.log`.
-   **Returns**: A fully configured logger instance that writes to a dedicated file. Each call with a unique `log_filepath` creates a new logger, ensuring logs for different schedule runs are kept separate.

### `log_schedule_header(self, logger: logging.Logger, ...)`

**Purpose:** Writes a standard header to the log file, providing context for the schedule run.

-   Includes the schedule filename, date, engine block, generation timestamp, and the reason for the schedule run (e.g., "INTRADAY").

### `log_block_calculation(self, logger: logging.Logger, block: int, is_frozen: bool, ...)`

**Purpose:** Logs the detailed calculation for a single 15-minute block. This is the core logging method.

-   **`logger`**: The logger instance for the current schedule.
-   **`block`**: The block number being calculated (1-96).
-   **`is_frozen`**: A boolean indicating if the block's value is frozen (i.e., taken from a previous schedule).
-   **`**kwargs`**: A dictionary of keyword arguments containing all the data points for the block's calculation, such as:
    -   Forecasts (`intraday_forecast`, `dayahead_forecast`, `base_forecast`)
    -   Plant status and curtailment details (`plant_status`, `curtailment_capacity`, `effective_base_forecast`)
    -   Ramp capping information
    -   The specific algorithmic condition that was applied (`condition_used`)
    -   The final calculated schedule value (`algo_schedule`)

### `log_summary(self, logger: logging.Logger, total_blocks: int, frozen_count: int)`

**Purpose:** Writes a summary section at the end of the log file.

-   Includes the total number of blocks processed, the number of blocks that were frozen, and the number of blocks for which new values were calculated.

## Execution Flow

1.  An instance of `BlockScheduleLogger` is created at the beginning of a scheduling process for a specific date.
2.  When a new schedule needs to be generated for a particular `engine_block`, `get_logger_for_schedule` is called to get a dedicated logger for that run.
3.  `log_schedule_header` is called to print the initial context.
4.  The scheduling engine loops through each time block (1-96). In each iteration, it calls `log_block_calculation` with all relevant data for that block.
5.  After the loop is complete, `log_summary` is called to write the final summary.

## Dependencies

-   `logging`
-   `datetime`
-   `pathlib`

## Related Documentation

-   [[scheduler_core]]
-   [[engine_runtime]]
