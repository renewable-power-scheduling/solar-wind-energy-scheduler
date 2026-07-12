---
tags:
  - utility
  - configuration
  - constants
  - common
module: "[[Common Utilities]]"
feature: "[[Configuration Constants]]"
---

# Configuration Constants

## Purpose

This file serves as a single source of truth for various hardcoded "magic values" and constants used throughout the application. Centralizing these values improves code readability and makes the system easier to maintain, as changes to fundamental properties (like a column name in a source file) only need to be updated in this one location.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\common\config_constants.py
```

## Defined Constants

### Block Settings

These constants define the fundamental properties of the 15-minute block system.

| Constant        | Value | Description                                                                                             |
| :-------------- | :---- | :------------------------------------------------------------------------------------------------------ |
| `BLOCKS_PER_DAY`  | `96`  | The total number of 15-minute scheduling blocks in a 24-hour period.                                    |
| `BLOCK_MINUTES`   | `15`  | The duration of a single block in minutes.                                                              |
| `GEN_END_BLOCK`   | `80`  | The last block of the day where generation is expected (block 80 ends at 20:00). Used to ignore night blocks. |

### Units

| Constant     | Value | Description                                  |
| :----------- | :---- | :------------------------------------------- |
| `POWER_UNIT` | `MW`  | The standard unit of power used in the system (Megawatts). |

### Metered Data CSV Columns

These constants specify the exact, case-sensitive column headers expected in the metered data CSV files. This is critical for reliable parsing.

| Constant              | Value                                           | Description                                |
| :-------------------- | :---------------------------------------------- | :----------------------------------------- |
| `METERED_POWER_COL`   | `"Active Power-avg MFM-OUT(Meter Power) (kW)"`  | The name of the column containing power data. |
| `METERED_TS_COL`      | `"Timestamp"`                                   | The name of the column containing the timestamp. |

### CSV Parsing

| Constant              | Value | Description                                                              |
| :-------------------- | :---- | :----------------------------------------------------------------------- |
| `ENERCAST_META_LINES` | `4`   | The number of metadata header lines to skip at the top of Enercast forecast CSV files. |

### Data Cleaning

| Constant                        | Value  | Description                                                                                                                               |
| :------------------------------ | :----- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAMP_NEGATIVE_METERED_TO_ZERO`  | `True` | A boolean flag indicating that negative metered power values should be clamped to zero during data processing to eliminate sensor noise. |

## Dependencies

- None

## Related Documentation

- [[Common Utilities]]
- [[Data Processing]]
