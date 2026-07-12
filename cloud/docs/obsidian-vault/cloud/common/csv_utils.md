---
tags:
  - utility
  - data-processing
  - csv
  - common
module: "[[Common Utilities]]"
feature: "[[Data Processing]]"
---

# CSV Utilities

## Purpose

This module provides specialized, robust utility functions for loading and parsing the two main types of CSV files used in this application: Enercast forecast CSVs and metered data CSVs.

It serves as a crucial part of the data ingestion pipeline, encapsulating the complex and sometimes messy logic required to handle inconsistent real-world CSV formats in a single, dedicated location.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\common\csv_utils.py
```

## Functions

### `load_enercast_forecast_csv(path: Path) -> pd.DataFrame`

This function loads a forecast CSV file provided by the Enercast service. The implementation is highly defensive, suggesting that the format of these source files can be inconsistent.

-   **Logic**:
    1.  **Find Header**: The function does not assume the header is on a fixed line. It intelligently scans the file, looking for a line that contains keywords like "block", "from", "to", or "forecast" to identify the true header row.
    2.  **Find Forecast Column**: This is the most complex part of the module. It uses a multi-layered strategy to locate the column containing the actual forecast data:
        -   It first checks the site's configuration for a specific, defined forecast column name.
        -   If that is not found, it searches for common default column names like "forecast", "schmw", or "schedule".
        -   It can even handle files that appear to have multiple header rows.
        -   As a last resort, it looks for an "availability" column and assumes the forecast data is in the column to its immediate left.
    3.  **Parse Data**: Once the header and forecast column are identified, it parses the block number and forecast value from each data row.
    4.  **Deduplicate**: The function explicitly handles an edge case where a single CSV file might contain two complete sets of 1-96 block data. It ensures that only the first occurrence of each block is kept.
-   **Returns**: A clean `pandas.DataFrame` with standardized `block` and `forecast_mw` columns.

### `load_metered_csv(path: Path) -> pd.DataFrame`

This function loads a CSV file containing historical, time-series metered power data for a site.

-   **Logic**:
    1.  It loads the CSV using `pandas`.
    2.  It validates that the required timestamp and power columns (as defined in `[[config_constants.py]]`) exist in the file.
    3.  It standardizes the column names to `timestamp` and `metered_kw`.
    4.  It converts the power data from kilowatts (kW) to megawatts (MW).
    5.  It applies a data cleaning step, clamping any negative power values (likely sensor noise) to `0.0`.
    6.  It uses the `[[time_utils.timestamp_to_block]]` function to calculate the corresponding 15-minute block number for each row's timestamp.
-   **Returns**: A `pandas.DataFrame` with `block`, `timestamp`, and `metered_mw` columns.

## Private Helper Functions

-   `_norm_header_token(x: str)`: A key helper function that normalizes a CSV header string by converting it to lowercase and removing whitespace and special characters. This makes column matching more resilient to minor formatting differences.

## Dependencies

-   `pandas`: For all CSV reading and data manipulation.
-   `[[config_constants.py]]`: Provides the exact column names for metered data files.
-   `[[time_utils.py]]`: Used to convert timestamps to block numbers.
-   `[[config_loader.py]]`: Used to load site-specific configuration, which may contain overrides for forecast column names.

## Related Documentation

-   [[Data Processing]]
-   [[Common Utilities]]
