# Global1 DA Scheduler

This directory contains the dedicated Day-Ahead (DA) scheduler lambda for Global1.

## Trigger model

- EventBridge rule 1: `cron(15 5 * * ? *)` with input `{"revision":"DA1"}`
- EventBridge rule 2: `cron(45 21 * * ? *)` with input `{"revision":"DA2"}`

## Lambda handler

- `lambda_da_scheduler_handler.lambda_handler`

## Docker build (from repo root)

```bash
docker build -f global1_da_scheduler/Dockerfile.scheduler -t global1-da-scheduler:latest .
```

## Notes

- This lambda is DA-only.
- It runs all configured `SITE_IDS` sequentially.
- It uses the existing `global1/run_phase9_engine.py` with `RUN_DA_ONLY=1`.

