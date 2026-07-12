---
tags:
  - utility
  - business-logic
  - common
module: "[[Common Utilities]]"
feature: "[[Capacity Calculation]]"
---

# Capacity

## Purpose

This module provides utility functions for calculating a power plant's **effective capacity**. The effective capacity is the actual maximum power a plant can generate at a given moment, which may be lower than its nameplate (or "sticker") capacity due to operational constraints like shutdowns or curtailment orders.

This module centralizes this complex business logic, so other parts of the system can simply ask "What is the current capacity?" without needing to know the details of why it might be reduced.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\common\capacity.py
```

## Functions

### `resolve_capacity_config(site_cfg: dict) -> dict`

This function extracts and normalizes capacity-related settings from a site's configuration dictionary (`site_cfg`).

-   **Logic**: It reads the `capacity` sub-dictionary and also checks for a legacy `plant_capacity_mw` value for backward compatibility. It ensures that `dc_capacity_mw`, `ac_capacity_mw`, and `dc_ac_ratio` are all present and correctly typed as floats, providing sensible defaults if they are missing.
-   **Returns**: A clean dictionary containing the following keys:
    -   `dc_capacity_mw`
    -   `ac_capacity_mw`
    -   `dc_ac_ratio`

### `effective_capacity_ac_mw(...) -> float`

This is the main function of the module. It calculates the effective AC capacity of the plant by considering its current operational status.

-   **Parameters**:
    -   `site_cfg`: The configuration dictionary for the site.
    -   `plant_status`: The current operational status (e.g., `"NORMAL"`, `"SHUTDOWN"`, `"CURTAILMENT"`).
    -   `control_mode`: (Optional) A special control mode, such as `"DC"`.
    -   `curtailment_capacity_mw`: (Optional) The specific capacity limit during a curtailment event.
    -   `shutdown_reduction_mw`: (Optional) The amount of DC capacity that has been shut down.

-   **Logic**: It determines the capacity based on a hierarchy of rules:
    1.  **Shutdown**: If `plant_status` is `SHUTDOWN`, the capacity is `0.0` MW (unless in the special "DC" mode).
    2.  **Curtailment**: If `plant_status` is `CURTAILMENT` and `curtailment_capacity_mw` is provided, the effective capacity is set to that specific value.
    3.  **Partial Shutdown (DC Mode)**: A special case where only part of the DC field is shut down. The calculation reduces the total DC capacity and then converts the remainder back to an effective AC capacity using the DC/AC ratio.
    4.  **Normal**: If none of the above conditions apply, it returns the plant's standard `ac_capacity_mw` from its configuration.

-   **Returns**: The calculated effective AC capacity in MW as a `float`.

## Dependencies

- None

## Related Documentation

- [[Common Utilities]]
- [[Site Configuration]]
