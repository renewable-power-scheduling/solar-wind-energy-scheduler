---
tags:
  - tool
  - scheduler-runner
  - continuous-runner
  - orchestration
module: "[[Tools]]"
feature: "[[Continuous Scheduling]]"
---

# Run Continuous Anjangoan

## Purpose

This script acts as a local, standalone scheduler that mimics the time-based triggers of a production environment (like AWS EventBridge). It is designed to be a long-running process that continuously triggers the scheduling pipeline for every 15-minute block of the day.

Its primary function is to reliably execute the scheduling logic at the correct time for one or more sites, making it an essential tool for long-duration testing or for running the system in an environment without cloud-native schedulers.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud	ools\continuous_runnerun_continuous_anjangoan.py
```

## Configuration

The script is configured by editing variables at the top of the file.

| Variable                   | Type        | Description                                                                                                                                                                                   |
| :------------------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_ID`                  | `str`       | The primary site to run for. Defaults to `Anjangoan`.                                                                                                                                         |
| `SITE_IDS`                 | `str`       | An optional comma-separated list of site IDs to run in the same process. If provided, this overrides `SITE_ID`.                                                                                  |
| `BLOCK_MINUTES`            | `int`       | The duration of a scheduling block in minutes. Hardcoded to `15`.                                                                                                                             |
| `OFFSET_MINUTES`           | `int`       | The number of minutes after a block starts to trigger its run. Hardcoded to `5`. This provides a delay for source data (like metered values) to become available.                               |
| `OFFSET_TOLERANCE_MINUTES` | `int`       | A small grace period in minutes to avoid missing a run due to minor script delays. Hardcoded to `1`.                                                                                            |

## Execution Flow

The script operates in an infinite `while True` loop, which represents the core of its timing and orchestration logic.

1.  **Initialization**:
    -   Resolves the list of target site IDs from the configuration.
    -   Sets up logging to both the console and a daily log file (e.g., `logs/Anjangoan/2026-07-09/continuous_runner.log`).
    -   Loads a state file (`continuous_scheduler_state.json`) which persists the timestamp of the last successfully executed block. This prevents the script from re-running a block if it's restarted.

2.  **Timing Logic (per loop iteration)**:
    a.  It determines the current time (`now`) and calculates the start time of the current 15-minute block (e.g., if it's 10:08, the block is 10:00).
    b.  It calculates the `offset_deadline` for the current block (e.g., 10:05 for the 10:00 block).
    c.  **It decides the `target_block` to run**:
        -   If `now` is before the deadline (plus tolerance) for the *current* block, it targets the *current* block.
        -   If `now` has already passed the deadline for the current block, it targets the *next* upcoming block.
    d.  It calculates the exact `target_run_time` for the `target_block` (which is `target_block + OFFSET_MINUTES`).
    e.  The script then **sleeps** until this `target_run_time`.

3.  **Engine Invocation**:
    a.  After waking up, it performs a **duplicate check** against the `last_executed_block` value in its state file to ensure it doesn't run the same block twice.
    b.  If the block is new, it updates the state file to mark the block as "in-progress".
    c.  It then iterates through the configured site(s). For each site, it constructs an `event` payload and calls the `run_fetcher` function from `[[fetcher_engine.py]]`. This triggers the full data fetching and scheduling pipeline for that site and block.

4.  **Logging and Loop**: It logs the success or failure of each site's run and then sleeps for a short period before starting the next iteration of the main loop to plan the next block's run.

## State Management

The script relies on a `continuous_scheduler_state.json` file to maintain robustness. This file stores the timestamp of the last executed block, ensuring that if the script is stopped and restarted, it will not re-process blocks that have already been handled.

## Dependencies

-   `[[fetcher_engine.py]]`: The main entry point for the entire scheduling pipeline.

## Related Documentation

-   [[run_continuous_standard.py]]
-   [[Continuous Scheduling]]
-   [[Architecture Overview]]
