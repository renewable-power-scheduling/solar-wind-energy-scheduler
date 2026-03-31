## WhatsApp Integration Schema (global2)

This integration uses two DynamoDB tables:

1. `DDB_TABLE` (existing control-state table)
- Partition key: `plant_id` (String)
- Required attributes:
  - `plant_status` (String): `NORMAL` | `CURTAILMENT` | `SHUTDOWN`
  - `curtailment_capacity` (Number, optional for curtailment)
  - `updated_at` (String, ISO timestamp)
- Purpose: immediate control overrides in scheduler.

2. `WHATSAPP_TABLE_NAME` (meter message table; current deployed name: `whatsapp_meter_data`)
- Current columns:
  - `site_id` (String)
  - `timestamp` (String, ISO timestamp)
  - `actual_mw` (Number/String)
  - `source` (String, typically `whatsapp`)
- Scheduler mapping in `global2` now reads:
  - site from `site_id`
  - event time from `timestamp`
  - generation from `actual_mw`
  - dedup key from `timestamp` (or fallback composite)
- Optional attributes:
  - `confidence` (Number, 0..1)
  - `raw_message` (String)
  - `received_at` (String, ISO timestamp)
  - `plant_id` (String)

Notes:
- Scheduler reads latest valid message per site from `WHATSAPP_TABLE_NAME`.
- Message is ignored if stale/future/out-of-range per site config.
- Control commands (`CURTAILMENT`, `SHUTDOWN`) continue to be handled through `DDB_TABLE`.
- If `WHATSAPP_TABLE_NAME` is missing or disabled, scheduler behavior remains unchanged.
