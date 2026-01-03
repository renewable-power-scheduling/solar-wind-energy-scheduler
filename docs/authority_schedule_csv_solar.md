# Authority Schedule CSV Specification (Solar Plant)

## Purpose

This document explains the structure and meaning of the **authority-facing intraday schedule CSV** used for **solar power plants**.  
It is intended to be a common reference for backend, ML, and system integration teams to ensure that generated schedules are compliant with authority requirements.

> ⚠️ Note:  
> This schedule format is applicable to **solar plants only**.  
> Wind plant schedules may have different behavior and constraints and are **not covered** in this document.

---

## Schedule Resolution

- One day is divided into **96 time blocks**
- Each block represents a **15-minute interval**
- Block numbering:
  - Block 1 → 00:00–00:15
  - Block 96 → 23:45–24:00

Each row in the schedule corresponds to **one time block**.

---

## High-Level Structure of the CSV

The schedule CSV consists of two logical parts:

1. **Metadata Section**  
   Contains plant, contract, and transmission details (POS, Contract ID, Capacity, Buyer, etc.).

2. **Block-wise Schedule Table**  
   Contains block-level values such as forecast, available capacity, and final schedule.

This document focuses on the **block-wise schedule table**, which is the core authority submission.

---

## Block-wise Schedule Table

### Block Column

| Column | Description                           |
| ------ | ------------------------------------- |
| Block  | 15-minute time block number (1 to 96) |

**Constraints**

- Must contain all blocks from 1 to 96
- No missing or duplicate blocks
- Blocks must be in ascending order

---

## Repeating Column Groups (Per Contract)

The schedule table contains **repeating groups of columns**, where each group corresponds to **one contract / transaction path**.

Each group follows this pattern:

Declared Forecast | Intra Avc / Inter Avc | Schedule

---

## Column Definitions

### Declared Forecast (MW)

- Forecasted solar generation for the given block
- Unit: **MW**
- Provided by the forecasting system or generator declaration
- Can be zero during night hours
- May vary smoothly during daylight hours

**Important**

- Declared Forecast is an **input**
- It is not a committed value

---

### Intra Avc / Inter Avc (MW)

- Approved available capacity for the block
- Unit: **MW**
- Represents the **maximum allowed schedule**
- Usually constant across all blocks for a given contract

**Types**

- **Intra Avc** → Intra-state transaction
- **Inter Avc** → Inter-state transaction

**Rule**
Schedule ≤ Avc

---

### Schedule (MW)

- Final scheduled power submitted to the authority
- Unit: **MW**
- This is the **legally binding value**
- Used by the authority for:
  - Deviation calculation
  - DSM / penalty assessment
  - Grid operation

**General logic**

Schedule = min(Declared Forecast, Avc)

(subject to system and regulatory adjustments)

---

## Typical Solar Plant Behavior

- Blocks during night hours (early morning and late evening) will have:
  - Declared Forecast = 0
  - Schedule = 0
- Daytime blocks show gradual ramp-up and ramp-down consistent with solar generation

This behavior confirms that the schedule applies to a **solar generation profile**.

---

## Key Validation Rules

- Total blocks must be exactly **96**
- All numeric values must be non-negative
- Schedule must not exceed the corresponding Avc
- Decimal precision must be consistent across the file
- Column order must not be changed
- No extra or missing columns are allowed

---

## Summary

This schedule CSV represents the **final authority submission** for a solar plant on an intraday basis.  
It combines forecasted generation, approved capacity, and final scheduled values for each 15-minute block, ensuring controlled and compliant grid operation.

This document should be used as the **reference guide** while generating, validating, or reviewing solar schedule CSV files.
