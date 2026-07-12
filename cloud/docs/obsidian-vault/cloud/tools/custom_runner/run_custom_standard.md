---
tags:
  - tool
  - scheduler-runner
  - custom-runner
  - testing
module: "[[Tools]]"
feature: "[[Custom Scheduling Runs]]"
---

# Run Custom Standard

## Purpose

This script is a powerful, configurable tool for running the scheduling engine for a specific site and date, acting as the "standard" version of the custom runner. It defaults to the `OSEPL` site. It allows for detailed control over the inputs and execution flow, making it ideal for development, testing, and debugging the scheduling logic for sites in the "global1" group.

It can simulate various scenarios, such as:
- Triggering scheduling runs for specific 15-minute blocks.
- Using different intraday forecast files for different runs.
- Skipping the data fetching step to use local, pre-existing data.
- Generating a final "frozen" schedule that simulates the real-world, progressive revision process throughout the day.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud	ools\custom_runnerun_custom_standard.py
```

## Configuration

This script is primarily configured by editing the `CUSTOM RUN CONFIG` section directly within the file. This design choice allows for complex configurations that would be cumbersome to pass as command-line arguments.

| Variable                  | Type          | Description                                                                                                                              |
| :------------------------ | :------------ | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_ID`                 | `str`         | The target site ID. Defaults to `OSEPL`.                                                                                                 |
| `CUSTOM_DATE`             | `str`         | The target date in `YYYY-MM-DD` format.                                                                                                  |
| `CUSTOM_START_BLOCKS`     | `list[int]`   | A list of one or more starting blocks (1-96) to trigger scheduling runs for.                                                             |
| `SKIP_FETCH`              | `bool`        | If `True`, the script will use existing data in `custom/input` instead of fetching new data.                                             |
| `INTRADAY_FILE_NAME`      | `str`         | (Optional) The exact filename of an intraday forecast CSV from `custom/input/<SITE>/<DATE>/enercast_data/intraday` to use for the run.     |
| `INTRADAY_FILE_NAMES`     | `list[str]`   | (Optional) A list of filenames to simulate multiple, sequential intraday revisions.                                                      |
| `INTRADAY_SELECTION_MODE` | `str`         | How to select the intraday forecast file: `all` (run for every file), `prompt` (interactive), `latest`, or `configured` (use the variables above). |

## Execution Flow

1.  **Configuration Validation**: The script first validates the settings in the `CUSTOM RUN CONFIG` section.
2.  **Data Fetching (Optional)**: If `SKIP_FETCH` is `False`, it invokes `[[custom_fetch_standard.py]]` to download the required input data (forecasts, metered data, etc.) into the `custom/input` directory.
3.  **Intraday File Selection**: It determines which intraday forecast CSV file(s) to use based on the `INTRADAY_SELECTION_MODE`. This allows for simulating runs with different forecast versions.
4.  **Engine Invocation Loop**: The script iterates through each `CUSTOM_START_BLOCKS` and each selected intraday file. In each iteration, it:
    a.  Constructs an `event` payload that mimics the JSON event passed to an AWS Lambda function.
    b.  Calls the `run` function from the `[[fetcher_engine.py]]` module, which is the primary entry point for the entire scheduling process.
5.  **Final Schedule Reduction**: After all individual runs are complete, the `_reduce_final_frozen_schedule` function is called. This function simulates a real day's operations by scanning all generated partial schedules and combining them into a single, coherent "frozen" schedule for the day.
6.  **Graph Generation**: Finally, it generates a plot visualizing the final frozen schedule, the latest intraday forecast, and the actual metered data.

## Key Functions

The key functions in this script are identical in purpose and implementation to those in `[[run_custom_anjangoan.py]]`.

-   `main()`: Orchestrates the entire process.
-   `_select_intraday_file_interactive()`: Prompts the user to select an intraday file.
-   `_reduce_final_frozen_schedule()`: Combines partial schedules into a final daily schedule.
-   `_load_intraday_graph_df()` / `_load_graph_inputs()`: Helper functions for loading data for graphing.

## Dependencies

-   `[[engine_runtime.py]]`: The core scheduling engine logic.
-   `[[custom_fetch_standard.py]]`: The script used to fetch input data.
-   `[[fetcher_engine.py]]`: The main entry point that this script calls.
-   `[[graph_utils.py]]`: Utilities for generating schedule graphs.
-   `pandas`: For all data manipulation.

## Related Documentation

-   [[run_custom_anjangoan.py]]
-   [[custom_fetch_standard.py]]
-   [[Custom Scheduling Runs]]
-   [[Architecture Overview]]
