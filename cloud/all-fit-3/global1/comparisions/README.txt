Hierarchy expected under this folder:

comparisions/
  <PLANT>/
    <YYYY-MM-DD>/
      System/
      vedanjay/
      metered_data/
      compared/

Script:
  compare_schedules.py

Run with hierarchy mode:
  python compare_schedules.py --root "<path_to_comparisions>" --plant GSNP --date 2026-03-12

Run with direct paths:
  python compare_schedules.py --system "<system_file_or_dir>" --vedanjay "<vedanjay_file_or_dir>" --out "<out_dir>" --date 2026-03-12

Outputs:
  compared/schedule-comparison-<date>.csv
  compared/schedule-comparison-<date>.html

Site-specific column mapping:
  Add JSON files at:
    comparisions/config/sites/<plant>.json
  Example:
    {
      "site_id": "KASIPET",
      "comparison": {
        "system": { "block_column": "block", "value_column": "algo_schedule_mw" },
        "vedanjay": { "block_column": "Block", "value_column": ["Schedule", "Forecast"] },
        "metered": { "time_column": "Timestamp", "value_column": "Active Power-Avg MFM-OUT (KW)" }
      }
    }
