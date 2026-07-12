---
tags:
  - tool
  - scheduler-runner
  - continuous-runner
  - orchestration
module: "[[Tools]]"
feature: "[[Continuous Scheduling]]"
---

# Run Continuous Standard

## Purpose

This script acts as a local, standalone scheduler that mimics the time-based triggers of a production environment. It is the "standard" version of the continuous runner, defaulting to the `Sirmour` site. It is designed to be a long-running process that continuously triggers the scheduling pipeline for every 15-minute block of the day.

Its primary function is to reliably execute the scheduling logic at the correct time for one or more sites, making it a valuable tool for testing or for running the system in an environment without cloud-native schedulers.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud	ools\continuous_runnerun_continuous_standard.py
```

## Configuration

The script is configured by editing variables at the top of the file.

| Variable                   | Type        | Description                                                                                                                                                                                   |
| :------------------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_ID`                  | `str`       | The primary site to run for. Defaults to `Sirmour`.                                                                                                                                           |
| `SITE_IDS`                 | `str`       | An optional comma-separated list of site IDs to run in the same process. If provided, this overrides `SITE_ID`.                                                                                  |
| `BLOCK_MINUTES`            | `int`       | The duration of a scheduling block in minutes. Hardcoded to `15`.                                                                                                                             |
| `OFFSET_MINUTES`           | `int`       | The number of minutes after a block starts to trigger its run. Hardcoded to `5`. This provides a delay for source data (like metered values) to become available.                               |
| `OFFSET_TOLERANCE_MINUTES` | `int`       | A small grace period in minutes to avoid missing a run due to minor script delays. Hardcoded to `1`.                                                                                            |

## Execution Flow

The script operates in an infinite `while True` loop, which represents the core of its timing and orchestration logic. The execution flow is functionally identical to that of `[[run_continuous_anjangoan.py]]`.

1.  **Initialization**:
    -   Resolves the list of target site IDs.
    -   Sets up logging to the console and a daily log file (e.g., `logs/SIRMOUR/2026-07-09/continuous_runner.log`).
    -   Loads a state file (`logs/SIRMOUR/continuous_scheduler_state.json`) which persists the timestamp of the last successfully executed block.

2.  **Timing Logic (per loop iteration)**:
    -   It calculates the current time and the current 15-minute block.
    -   It determines the target block to run for (either the current one or the next one, depending on the time).
    -   It calculates the exact time the run should start (`target_run_time`).
    -   The script **sleeps** until this `target_run_time`.

3.  **Engine Invocation**:
    -   After waking up, it performs a **duplicate check** against its state file.
    -   If the block is new, it updates the state file.
    -   It then iterates through the configured site(s), constructs an `event` payload for each, and calls the `run_fetcher` function from `[[fetcher_engine.py]]` to trigger the full pipeline.

4.  **Logging and Loop**: It logs the outcome and waits for the appropriate time to begin the next loop iteration.

## State Management

The script relies on a `continuous_scheduler_state.json` file, located in the site-specific log directory, to maintain robustness. This file stores the timestamp of the last executed block, ensuring that if the script is stopped and restarted, it will not re-process blocks that have already been handled.

## Dependencies

-   `[[fetcher_engine.py]]`: The main entry point for the entire scheduling pipeline.

## Related Documentation

-   [[run_continuous_anjangoan.py]]
-   [[Continuous Scheduling]]
-   [[Architecture Overview]]
