---
type: "Configuration"
module: "Configuration"
feature: "Site Configuration"
site: "SAWDA"
tags: ["json", "configuration", "site", "sawda"]
---

# `SAWDA.json`

This file contains the complete configuration specific to the SAWDA solar power site. It defines everything from the site's physical characteristics to how its power generation should be scheduled, forecasted, and adjusted.

## File Location

`d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\configs\sites\SAWDA.json`

## Structure and Fields

The JSON object is structured into several key sections, each controlling a different aspect of the system's behavior for the SAWDA site.

### Top-Level Configuration

-   `site_id`: "SAWDA" - A unique identifier for the site.
-   `state`: "MADHYA_PRADESH" - The state where the site is located.
-   `protocol`: "sftp" - The protocol used for data transfer (e.g., FTP, SFTP).
-   `plant_capacity_mw`: 7.5 - The nominal power capacity of the plant in megawatts.
-   `penalty_band_pct`: 0.10 - A 10% tolerance band for scheduling penalties.
-   `ddb_plant_id`: "SAWDA" - The identifier for the plant in DynamoDB.

### `schedule_submission`

Defines the time slots for submitting power generation schedules.

-   `slot_minutes`: 90 - Each scheduling slot is 90 minutes long.
-   `slots`: An array of objects, each defining the `start` and `end` time for a submission slot throughout the day.

### `intraday_revisions`

Specifies the windows for intraday schedule revisions. This is crucial for making adjustments based on real-time conditions.

-   Each object in the array defines a `revision` number, the `block` number it corresponds to (out of 96 blocks in a day), and the `start` and `end` time for that revision window.

### `intraday_schedule_policy`

Governs the logic for handling intraday revisions.

-   `slot_end_only`: `true` - Indicates that triggers for revisions are based only on the end of a slot.
-   `intraday_trigger_scope`: "slot_end_only" - Reinforces the trigger scope.
-   `first_mandatory_revision`: 4 - The first revision that must be processed is revision 4.
-   `mandatory_revision_no`: 4 - The mandatory revision number.
-   `first_arrival_block`: 24 - The first time block (out of 96) when generation data is expected to arrive.
-   `first_generation_block`: 24 - The first block where generation is expected.
-   `mandatory_generation_block`: 24 - A mandatory block for generation checking.

### `capacity`

Detailed capacity specifications for the plant.

-   `dc_capacity_mw`: 8.54 - The total capacity of the DC solar panels.
-   `ac_capacity_mw`: 7.5 - The capacity of the AC inverters.
-   `dc_ac_ratio`: 1.139 - The ratio of DC to AC capacity, indicating the inverter loading ratio.
-   `plant_capacity_field_meaning`: "AC" - Clarifies that the primary `plant_capacity_mw` refers to the AC capacity.

### `connection` and `paths`

Defines the SFTP connection details for accessing data from Enercast.

-   `connection`: Contains the `host`, `port`, `username`, and `password_env` (the name of the environment variable holding the password).
-   `paths`: Specifies the remote directory paths for `forecasts` and `metered` data.

### `file_patterns`

Regular expressions and templates for identifying specific data files.

-   `intraday_filename_regex`: A regex to match the intraday forecast CSV file from Enercast.
-   `day_ahead_filename_regex`: A regex to match the day-ahead forecast CSV file.
-   `metered_template`: The expected filename format for metered power data.

### `enercast`

Configuration for parsing Enercast-specific forecast files.

-   `owner`: "vedanjay" - The owner of the forecast product.
-   `site_tag`: "SAWDA_PV" - The site tag used within Enercast files.
-   `forecast_column`: "SAWDA" - The name of the column in the CSV that contains the forecast data for this site.
-   `date_row_labels`: An array of possible labels (e.g., "DATE:") used to identify the date row in the CSV.
-   `date_formats`: An array of possible date formats to parse.

### `weather`

Configuration for fetching weather data.

-   `latitude`, `longitude`: The precise geographical coordinates of the site.
-   `model`: "gfs_seamless" - The weather forecast model to use (Global Forecast System).
-   `timezone`: "Asia/Kolkata" - The local timezone.
-   `current_vars`, `minutely_vars`: The specific weather variables to be fetched for current and minutely forecasts (e.g., temperature, wind speed, cloud cover, radiation).

### `runtime`

Parameters controlling the execution of the scheduling engine.

-   `run_continuous`: `true` - The engine should run continuously.
-   `retry_seconds_on_error`: 60 - Wait 60 seconds before retrying after an error.
-   `timezone`: "Asia/Kolkata" - The operational timezone.

### `metered`

Configuration for processing real-time metered data.

-   `enabled`: `false` - Metered data processing is currently disabled for this site.
-   The other fields (`timestamp_col`, `power_col`, etc.) define how to parse the metered data file if it were enabled.

### `scheduling_parameters`

A set of fine-tuning parameters for the core scheduling algorithm. These values control how the algorithm balances different inputs and constraints.

-   `weight_meter`, `weight_intraday`: Weights to assign to metered data vs. intraday forecasts (0.02 vs 0.98).
-   `irr_full_trust`, `irr_zero_trust`: Trust thresholds for irradiance values.
-   `ramp_cap_factor`: A factor to control the rate of change (ramp) of the power schedule.
-   ...and other algorithmic tuning constants.

### `lambda_architecture`

Defines the AWS Lambda functions and triggers associated with this site.

-   `fetcher_lambda_name`: "SAWDA-fetcher" - The name of the Lambda function responsible for fetching data.
-   `scheduler_lambda_name`: "SAWDA-scheduler" - The name of the Lambda function that runs the scheduling logic.
-   `fetcher_cron_profile`: "normal" - A profile for the cron job.
-   `fetcher_cron_expression`: A cron expression (`cron(3,18,33,48 * * * ? *)`) that triggers the fetcher Lambda at 3, 18, 33, and 48 minutes past every hour.

### `adjustment_overrides`

Contains thresholds and multipliers for making dynamic adjustments to the schedule based on real-time weather conditions. This is a form of rule-based expert system to refine the schedule.

-   `base_adjustment_thresholds`/`values`: Rules for baseline adjustments.
-   `irradiance_state_thresholds`/`multiplier`: Rules based on irradiance conditions (e.g., "STABLE_CLEAR", "OVERCAST").
-   `temp_multiplier_thresholds`/`values`: Rules based on ambient temperature.
-   `wind_multiplier_thresholds`/`values`: Rules based on wind speed.

## Related Documents

-   [[Backend Logic Architecture]]
-   [[Backend Code Reference Manual]]
-   [[~-cloud-fetcher_core-fetcher_engine.py~]]
-   [[~-cloud-scheduler_core-scheduler_entry.py~]]
