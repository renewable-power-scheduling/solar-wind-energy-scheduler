---
tags:
  - utility
  - configuration
  - constants
  - common
module: "[[Common Utilities]]"
feature: "[[Site Groupings]]"
---

# Site Grouping Constants

## Purpose

This file provides a centralized place to define and manage logical groupings of sites. Instead of hardcoding lists of sites in different parts of the business logic, this file exports tuples that can be imported and used for validation or for applying group-specific rules.

This approach improves maintainability. If a new site needs to be added to a group, the change only needs to happen in this one file.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\common\constants.py
```

## Defined Constants

### `SITE_IDS`

A comprehensive tuple containing all known site IDs supported by the system.

```python
SITE_IDS = (
    "BHUPALPALLY",
    "KASIPET",
    "KOTHAGUDEM",
    "OSEPL",
    "SIRMOUR",
    "ANJANGOAN",
    "NANDGAON",
    "BAMKHAL",
)
```

### `GLOBAL1_SITES`

A tuple containing a specific subset of sites that belong to the "GLOBAL1" group. These sites may share common business logic, data sources, or scheduling policies.

```python
GLOBAL1_SITES = (
    "BHUPALPALLY",
    "KASIPET",
    "KOTHAGUDEM",
    "OSEPL",
    "SIRMOUR",
)
```

### `ILLIOS_POWER_SITES`

A tuple containing another subset of sites belonging to the "ILLIOS_POWER" group, which may have its own distinct set of rules or configurations.

```python
ILLIOS_POWER_SITES = (
    "ANJANGOAN",
    "NANDGAON",
    "BAMKHAL",
)
```

## Dependencies

- None

## Related Documentation

- [[Common Utilities]]
- [[Configuration Constants]]
- [[Site Configuration]]
