# AWS Testing Migration

This bundle keeps the current scheduling logic and moves it to Lambda images without changing the normal intraday path.

## Lambda artifacts to deploy

Use these files from `cloud/illios_power`:

- `Dockerfile`
- `Dockerfile.fetcher`
- `Dockerfile.scheduler`
- `Dockerfile.whatsapp`
- `Dockerfile.manual_ingest`
- `Dockerfile.continuous`
- `Dockerfile.custom`
- `lambda_fetch_handler.py`
- `lambda_schedule_handler.py`
- `manual_schedule_ingest.py`
- `whatsapp_handler_lambda.py`
- `run_phase9_engine.py`
- `run_phase9_continuous.py`
- `run_phase9_custom.py`
- `requirements.txt`

If the deployment package for the AWS testing account needs the shared entrypoint behavior, keep the handler filenames unchanged and only swap the image tags.

## Build commands

From the repository root:

```powershell
docker build -f cloud/illios_power/Dockerfile.fetcher -t illios-power-fetcher:latest cloud/illios_power
docker build -f cloud/illios_power/Dockerfile.scheduler -t illios-power-scheduler:latest cloud/illios_power
docker build -f cloud/illios_power/Dockerfile.whatsapp -t illios-power-whatsapp:latest cloud/illios_power
docker build -f cloud/illios_power/Dockerfile.manual_ingest -t illios-power-manual-ingest:latest cloud/illios_power
docker build -f cloud/illios_power/Dockerfile.continuous -t illios-power-continuous:latest cloud/illios_power
docker build -f cloud/illios_power/Dockerfile.custom -t illios-power-custom:latest cloud/illios_power
```

## Lambda handler mappings

- Fetch Lambda: `lambda_fetch_handler.lambda_handler`
- Scheduler Lambda: `lambda_schedule_handler.lambda_handler`
- WhatsApp Lambda: `whatsapp_handler_lambda.lambda_handler`
- Manual ingest Lambda: `manual_schedule_ingest.lambda_handler`

## Environment variables to keep consistent

- `BUCKET`
- `PLANT_ID`
- `SITE_NAME`
- `SITE_IDS`
- `SCHEDULER_FUNCTION`
- `CONTROL_WINDOWS_TABLE`
- `CONTROL_STATE_TABLE`
- `WHATSAPP_TABLE_NAME`
- `SITE_TELEMETRY_TABLE_NAME`
- `FETCHER_SHARED_SESSION_SITES`

## Deployment rule

Do not change the intraday revision or schedule-generation behavior for the normal path. Only migrate the same code and handlers into the AWS testing account image/Lambda configuration.
