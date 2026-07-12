---
tags:
  - tool
  - data-fetcher
  - custom-runner
module: "[[Tools]]"
feature: "[[Custom Data Fetching]]"
---

# Custom Fetch Anjangoan

## Purpose

This script is a command-line utility for fetching date-specific data for a given site and storing it in a custom input directory. It acts as a wrapper around the core `[[fetch_worker.py]]` script, configuring it to run for a specific use case.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud	ools\custom_runner\custom_fetch_anjangoan.py
```

## Execution Flow

1.  **Parse Arguments**: The script parses the `--date` and `--site` command-line arguments. The site defaults to `ANJANGOAN` if not provided or if the `SITE_ID` environment variable is not set.
2.  **Validate Date**: It validates that the provided date string is in `YYYY-MM-DD` format.
3.  **Set Environment**: It sets several environment variables to control the execution of the `fetch_worker.py` script.
4.  **Invoke Fetch Worker**: It invokes the `[[fetch_worker.py]]` script using a subprocess, passing along the site and date. The custom environment variables ensure that the fetcher runs once and stores its output in the `custom/input` directory.

## Arguments

| Argument | Required | Description                                    |
| :------- | :------- | :--------------------------------------------- |
| `--date` | Yes      | The target date for fetching data (YYYY-MM-DD) |
| `--site` | No       | The site ID. Defaults to `ANJANGOAN`.          |

## Environment Variables Set

This script sets the following environment variables before calling `fetch_worker.py`:

| Variable                       | Value                                     | Purpose                                                                                                                             |
| :----------------------------- | :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `RUN_ONCE`                     | `1`                                       | Instructs the fetcher to run a single time and then exit.                                                                           |
| `FETCH_BASE_DIR`               | `.../custom/input`                        | Overrides the default output directory for the fetched data.                                                                        |
| `SITE_ID`                      | The value from the `--site` argument.     | Specifies the target site.                                                                                                          |
| `SITE_NAME`                    | The value from the `--site` argument.     | Specifies the target site name.                                                                                                     |
| `FETCH_DATE`                   | The value from the `--date` argument.     | Specifies the date to fetch data for.                                                                                               |
| `FETCH_ALL_FORECAST_REVISIONS` | `1`                                       | Instructs the fetcher to retrieve all available forecast revisions for the given day, not just the latest one.                        |

## Dependencies

-   `[[fetch_worker.py]]`: The core data fetching script that this utility wraps.

## Related Documentation

-   [[custom_fetch_standard.py]]
-   [[run_custom_anjangoan.py]]
-   [[Tools]]
-   [[Custom Data Fetching]]
