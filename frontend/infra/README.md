# Manual Schedule API Gateway Bootstrap

This folder contains the first deployable API Gateway for manual schedule changes:
- CloudFormation stack: `infra/apigw-manual-schedule.yaml`
- Lambda handler: `infra/lambda/manual_changes_ingest.py`

## What Gets Created

- API Gateway REST endpoint:
  - `POST /v1/manual-schedule-changes`
  - `OPTIONS /v1/manual-schedule-changes` (CORS preflight)
- API Gateway request model validation for payload shape.
- Lambda integration (`AWS_PROXY`) for ingestion.
- Optional S3 persistence of:
  - original JSON request
  - generated CSV from `changes[]`.

## Expected JSON Payload

```json
{
  "org_id": "vedanjay",
  "site_id": "KOTHAGUDEM",
  "schedule_date": "2026-04-17",
  "schedule_type": "INTRADAY",
  "reference_block": 45,
  "baseline_schedule_s3_key": "generated/vedanjay/KOTHAGUDEM/outputs/2026-04-17/schedule_from_49.csv",
  "submitted_by": "VPPL6127",
  "submitted_at_ist": "2026-04-18T12:20:00+05:30",
  "comment": "Intraday correction",
  "request_id": "d65c0f90-3c17-4ddb-8cf3-0f77f77f1a03",
  "changes": [
    { "block": 46, "mw": 3.5 }
  ]
}
```

## Deploy Steps (PowerShell)

1. Package lambda zip:

```powershell
cd "C:\Users\HP\Downloads\Companyvppl\Companyvppl\QCA DASHBOARD FINAL"
Compress-Archive -Path ".\infra\lambda\manual_changes_ingest.py" -DestinationPath ".\infra\manual_changes_ingest.zip" -Force
```

2. Upload zip to an S3 bucket used for deployment artifacts:

```powershell
aws s3 cp ".\infra\manual_changes_ingest.zip" "s3://<DEPLOY_ARTIFACT_BUCKET>/lambdas/manual_changes_ingest.zip"
```

3. Deploy CloudFormation stack:

```powershell
aws cloudformation deploy `
  --stack-name qca-manual-schedule-api `
  --template-file ".\infra\apigw-manual-schedule.yaml" `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides `
      ProjectName=qca-manual-schedule `
      StageName=dev `
      LambdaCodeS3Bucket=<DEPLOY_ARTIFACT_BUCKET> `
      LambdaCodeS3Key=lambdas/manual_changes_ingest.zip `
      DataBucketName=vedanjay-schedules-test-218708247175 `
      ManualPrefix=manual/changes
```

4. Get API URL output:

```powershell
aws cloudformation describe-stacks `
  --stack-name qca-manual-schedule-api `
  --query "Stacks[0].Outputs[?OutputKey=='ApiInvokeUrl'].OutputValue" `
  --output text
```

## Test Request

```powershell
$url = "<PASTE_API_URL>"
$body = @{
  org_id = "vedanjay"
  site_id = "KOTHAGUDEM"
  schedule_date = "2026-04-17"
  schedule_type = "INTRADAY"
  reference_block = 45
  baseline_schedule_s3_key = "generated/vedanjay/KOTHAGUDEM/outputs/2026-04-17/schedule_from_49.csv"
  submitted_by = "VPPL6127"
  submitted_at_ist = "2026-04-18T12:20:00+05:30"
  comment = "Intraday correction"
  request_id = "d65c0f90-3c17-4ddb-8cf3-0f77f77f1a03"
  changes = @(
    @{ block = 46; mw = 3.5 }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body
```

## Current Scope

This first version validates and persists manual changes. It does not yet merge with baseline schedule CSV. Next step is to add baseline fetch + merge + derived manual full schedule CSV generation.
