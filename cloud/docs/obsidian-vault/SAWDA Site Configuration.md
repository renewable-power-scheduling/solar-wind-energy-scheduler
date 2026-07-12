---
tags:
  - site-configuration
  - sawda
---

# SAWDA Site Configuration

## 1. Overview

This document outlines the configuration for the SAWDA solar power site. SAWDA is located in Madhya Pradesh and has a generation capacity of 7.5 MW.

## 2. File Location

`cloud/configs/sites/SAWDA.json`

## 3. Configuration Details

### 3.1. Site Information

- **Site ID**: `SAWDA`
- **State**: `MADHYA_PRADESH`
- **Plant Capacity**: 7.5 MW (AC)
- **DC Capacity**: 8.54 MW
- **DC/AC Ratio**: 1.139

### 3.2. Scheduling and Revisions

- **Schedule Submission**: Schedules are submitted in 90-minute slots throughout the day, starting from 04:00 and ending at 19:00.
- **Intraday Revisions**: There are 12 intraday revisions, starting from revision 1 at 01:15 - 01:30 and ending with revision 12 at 17:45 - 18:00.
- **Intraday Schedule Policy**:
    - `slot_end_only`: `true`
    - `intraday_trigger_scope`: `slot_end_only`
    - `first_mandatory_revision`: 4
    - `first_arrival_block`: 24
    - `first_generation_block`: 24

### 3.3. Data Transfer (SFTP)

- **Protocol**: `sftp`
- **Host**: `transfer.enercast.de`
- **Port**: 22
- **Username**: `vedanjay`
- **Remote Paths**:
    - Forecasts: `/forecasts`
    - Metered Data: `/incoming/powerdata_realtime/iliosPower`

### 3.4. File Patterns

- **Intraday Forecast**: `^vedanjay_SAWDA_PV_Intraday_{current_date}-\d{2}-\d{2}\+0530\.csv$`
- **Day-Ahead Forecast**: `^vedanjay_SAWDA_PV_Dayahead_{current_date}-\d{2}-\d{2}\+0530\.csv$`
- **Metered Data**: `sawda_{date_yyyymmdd}.csv`

### 3.5. Weather and Forecasting

- **Enercast Owner**: `vedanjay`
- **Enercast Site Tag**: `SAWDA_PV`
- **Forecast Column**: `SAWDA`
- **Weather Model**: `gfs_seamless`
- **Coordinates**: 21.02138889, 75.60027778
- **Timezone**: `Asia/Kolkata`

### 3.6. Runtime and Scheduling Parameters

- **Runtime**:
    - `run_continuous`: `true`
    - `retry_seconds_on_error`: 60
- **Scheduling Parameters**: This section defines the core parameters for the scheduling algorithm, including weights for metered vs. intraday data, irradiance trust levels, and ramp rate controls.

### 3.7. AWS Lambda

- **Fetcher Lambda**: `SAWDA-fetcher`
- **Scheduler Lambda**: `SAWDA-scheduler`
- **Fetcher Cron**: `cron(3,18,33,48 * * * ? *)` (Runs at 3, 18, 33, and 48 minutes past the hour)

### 3.8. Adjustment Overrides

This section provides site-specific overrides for schedule adjustments based on irradiance, temperature, and wind speed.

## 4. Related Documents

- [[Backend Logic Architecture]]
- [[SAWDA-fetcher Lambda]]
- [[SAWDA-scheduler Lambda]]
