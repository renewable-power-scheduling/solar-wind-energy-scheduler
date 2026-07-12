# Illios Power deployment bundle

This folder is the isolated deployment tree for the ANJANGOAN-style plants.

- `Dockerfile.fetcher` builds the isolated fetcher image.
- `Dockerfile.scheduler` builds the isolated intraday scheduler image.
- `Dockerfile.continuous` builds the isolated continuous runner image.
- `Dockerfile.custom` builds the isolated custom/backfill runner image.
- `config/sites/anjangoan.json` is the ANJANGOAN site config for this tree.
- `continuous-env.json` and `custom-env.json` are local runner env samples.

This tree is separate from `cloud/global1`.
Global1 should keep only:
- SIRMOUR
- KOTHAGUDEM
- KASIPET
- BHUPALPALLY
- OSEPL

ANJANGOAN-family sites should be added here instead.


lambda_fetch_handler.py
lambda_schedule_handler.py
manual_schedule_ingest.py
requirements.txt
run_continuous_schedule.py
run_custom_schedule.py
run_fetch_for_all_sites.py
run_fetch_for_site.py
run_phase9_continuous.py
run_phase9_custom.py
run_phase9_engine.py
whatsapp_handler_lambda.py