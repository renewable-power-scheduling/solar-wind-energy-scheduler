---
type: "manual"
doc_id: "DOC-012"
tags: [backend, onboarding, site-addition, aws, deployment]
---
# DOC-012 New Site Onboarding and Migration Guide

## Purpose

This document is the knowledge-transfer guide for adding a new solar site to the cloud scheduling system. It covers:

- code-level changes in the repository
- site configuration and credentials
- Lambda wrapper creation
- Docker image build and push flow
- AWS Lambda creation or migration steps
- EventBridge cron wiring for the fetcher
- validation and rollout checklist

Use this document when a new backend developer needs to onboard a site end to end without reverse-engineering the whole codebase.

## Target Architecture

Each site in this system is deployed as a pair of Lambdas:

1. `SITE-fetcher`
2. `SITE-scheduler`

The rule is:

- fetcher owns input sync and trigger resolution
- scheduler only executes the strict payload it receives
- fetcher has EventBridge cron
- scheduler does not have cron

Related code:

- `cloud/fetcher_core/fetcher_engine.py`
- `cloud/scheduler_core/scheduler_entry.py`
- `cloud/deployment/site_lambda_manifest.json`
- `cloud/common/site_registry.py`

## What Must Be Added For A New Site

For a new site, the minimum repository work is:

1. add a site config JSON under `cloud/configs/sites`
2. add credentials mapping if the site uses its own FTP/SFTP credentials
3. add the site to `cloud/common/constants.py`
4. add a site wrapper directory under `cloud/lambda_sites/<site-lower>`
5. add the site to `cloud/deployment/site_lambda_manifest.json`
6. deploy the fetcher and scheduler Lambdas
7. attach EventBridge cron only to the fetcher
8. validate local custom-runner and cloud Lambda behavior

## Step 1: Create The Site Config

Add a new config file in:

- `cloud/configs/sites/NEWSITE.json`

Use an existing site as the base template:

- standard daily-file site example: `cloud/configs/sites/OSEPL.json`
- snapshot-per-block site example: `cloud/configs/sites/ANJANGOAN.json`

### Required sections

The new config must define these sections correctly:

- `site_id`
- `state`
- `schedule_submission`
- `intraday_revisions`
- `intraday_schedule_policy`
- `protocol`
- `plant_capacity_mw`
- `capacity`
- `penalty_band_pct`
- `connection`
- `paths`
- `file_patterns`
- `enercast`
- `runtime`
- `metered`
- `scheduling_parameters`
- `ddb_plant_id`
- `lambda_architecture`

### Most important fields

#### `connection`

Defines the FTP/SFTP host and connection settings:

- `host`
- `port`
- `tls` for FTP sites if needed
- `epsv` for FTP sites if needed
- `username`
- `password_env` or resolved password model used by your loader path

#### `paths`

Defines remote directories:

- `remote_forecasts`
- `remote_metered`

#### `file_patterns`

Defines how files are matched:

- `intraday_filename_regex`
- `day_ahead_filename_regex`
- `week_ahead_filename_regex` if used for that site
- `metered_template`
- `metered_snapshot_glob` if snapshot mode is used

#### `metered`

Defines how metered files are normalized:

- `timestamp_col`
- `power_col`
- `source_power_col` if source raw column differs
- `block_col` if needed
- `filename_mode`
- `power_unit`
- `delimiter`
- `round_to_15`

#### `lambda_architecture`

Defines cloud naming and cron:

- `fetcher_lambda_name`
- `scheduler_lambda_name`
- `fetcher_cron_profile`
- `fetcher_cron_expression`

### Metered mode decision

This is the first architectural decision for a new site.

Use standard daily-file mode when the site gives one daily meter file.  
Use snapshot-per-block mode when the site gives many timestamped snapshots through the day.

Current adapter selection happens in:

- `cloud/fetcher_core/fetch_worker.py`
- `cloud/fetcher_core/metered_adapters/standard_daily_file.py`
- `cloud/fetcher_core/metered_adapters/ftp_snapshot_per_block.py`

Rules:

- if `metered.filename_mode == "ftp_snapshot_per_block"`, the snapshot adapter is used
- otherwise the standard daily-file adapter is used

Do not add site-specific branching in fetcher core unless the new site truly introduces a new raw format.

### No-metered site pattern

If a site has no SCADA / no metered source and the system must run on forecast plus fallback logic only, use this explicit config pattern:

- `metered.enabled: false`
- `metered.filename_mode: "disabled"`

This now causes the fetcher to skip metered download cleanly instead of attempting a remote fetch and failing over through exception handling.

Current working example:

- `cloud/configs/sites/SAWDA.json`

### Current worked example: `NANDGAON` and `BAMKHAL`

These two sites are implemented as snapshot-per-block sites in the same source family as `ANJANGOAN`.

Repository additions for this pattern:

- `cloud/configs/sites/NANDGAON.json`
- `cloud/configs/sites/BAMKHAL.json`
- `cloud/configs/credentials/nandgaon_ftp_credentials.yaml`
- `cloud/configs/credentials/bamkhal_ftp_credentials.yaml`
- `cloud/lambda_sites/nandgaon/`
- `cloud/lambda_sites/bamkhal/`

Key points from this example:

- both use `protocol: "sftp"`
- both use `paths.remote_metered: "/incoming/powerdata_realtime/iliosPower"`
- both use `metered.filename_mode: "ftp_snapshot_per_block"`
- `NANDGAON` uses `metered_snapshot_glob: "SLM04506CB_{date_ddmmyy}_*.csv"`
- `BAMKHAL` uses `metered_snapshot_glob: "SLM045663C_{date_ddmmyy}_*.csv"`
- both follow the same fetcher cron pattern: `cron(3,18,33,48 * * * ? *)`

Capacity handling in these example configs is explicit:

- `NANDGAON`: DC `7.89`, AC `7.5`, ratio `1.052`
- `BAMKHAL`: DC `6.07`, AC `5.0`, ratio `1.214`

This is the correct pattern to follow when a new site shares the same raw metered snapshot family but has different forecast filename regexes, meter code, and AC/DC capacity.

## Step 2: Add Credentials

If the site needs new FTP/SFTP credentials, add a credentials file under:

- `cloud/configs/credentials`

Examples:

- `cloud/configs/credentials/osepl_ftp_credentials.yaml`
- `cloud/configs/credentials/anjangoan_ftp_credentials.yaml`

If your operational model stores the actual secret only in AWS environment variables, keep the repository file limited to non-secret mapping metadata and ensure the config points to the correct password environment variable.

## Step 3: Add The Site To Shared Constants

Update:

- `cloud/common/constants.py`

You must:

1. add the site to `SITE_IDS`
2. add it to `GLOBAL1_SITES` or `ILLIOS_POWER_SITES`

If the new site belongs to a new source-group family entirely, you must also extend:

- `cloud/common/constants.py`
- `cloud/common/site_registry.py`

Otherwise `site_registry.py` will reject the site as unknown.

## Step 4: Add Site Lambda Wrappers

Create a new directory:

- `cloud/lambda_sites/<site-lower>`

For example, if the site is `NEWSITE`, create:

- `cloud/lambda_sites/newsite/fetcher_handler.py`
- `cloud/lambda_sites/newsite/scheduler_handler.py`
- `cloud/lambda_sites/newsite/Dockerfile.fetcher`
- `cloud/lambda_sites/newsite/Dockerfile.scheduler`

### Fetcher handler pattern

```python
from cloud.fetcher_core.fetcher_engine import run


def lambda_handler(event, context):
    return run("NEWSITE", event, context)
```

### Scheduler handler pattern

```python
from cloud.scheduler_core.scheduler_entry import run


def lambda_handler(event, context):
    return run("NEWSITE", event, context)
```

### Dockerfile pattern

Use the same model as existing sites. Example fetcher Dockerfile:

```dockerfile
FROM public.ecr.aws/lambda/python:3.12

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY cloud/common/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY cloud ${LAMBDA_TASK_ROOT}/cloud

CMD ["cloud.lambda_sites.newsite.fetcher_handler.lambda_handler"]
```

Scheduler Dockerfile is the same except for the final `CMD`.

## Step 5: Add The Site To Deployment Manifest

Update:

- `cloud/deployment/site_lambda_manifest.json`

Add one new object under `sites`:

```json
{
  "site_id": "NEWSITE",
  "source_group": "global1",
  "fetcher_lambda_name": "NEWSITE-fetcher",
  "scheduler_lambda_name": "NEWSITE-scheduler",
  "fetcher_dockerfile": "cloud/lambda_sites/newsite/Dockerfile.fetcher",
  "scheduler_dockerfile": "cloud/lambda_sites/newsite/Dockerfile.scheduler",
  "fetcher_handler": "cloud.lambda_sites.newsite.fetcher_handler.lambda_handler",
  "scheduler_handler": "cloud.lambda_sites.newsite.scheduler_handler.lambda_handler",
  "fetcher_cron_profile": "normal",
  "fetcher_cron_expression": "cron(3,18,33,48 * * * ? *)",
  "scheduler_has_cron": false
}
```

Also add the site to `rollout_order`.

Important:

- `fetcher_lambda_name` and `scheduler_lambda_name` must match the site config
- `scheduler_has_cron` must remain `false`

## Step 6: Local Validation Before AWS

Before cloud deployment, validate locally using the custom runner path under:

- `cloud/tools/custom_runner`

Use the standard or snapshot runner depending on the site’s metered model.

You should validate:

1. forecast files match the configured regex
2. metered file normalization works
3. fetch manifest is written
4. trigger resolution behaves correctly
5. scheduler generates schedule output without path or config errors

If local custom runs fail, do not move to AWS deployment yet. Fix config or adapter problems first.

## Step 7: Build And Push Docker Images

This repository’s deployment scripts use Docker + ECR + Lambda image updates.

### Login to ECR

```powershell
$Profile = "Test_vedanjay"
$Region = "ap-south-1"
$AccountId = aws sts get-caller-identity --profile $Profile --query Account --output text
$Ecr = "$AccountId.dkr.ecr.$Region.amazonaws.com"
aws ecr get-login-password --region $Region --profile $Profile | docker login --username AWS --password-stdin $Ecr
```

### Build images manually

```powershell
docker build --platform linux/amd64 --provenance=false --sbom=false -f cloud/lambda_sites/newsite/Dockerfile.fetcher -t newsite-fetcher:latest .
docker build --platform linux/amd64 --provenance=false --sbom=false -f cloud/lambda_sites/newsite/Dockerfile.scheduler -t newsite-scheduler:latest .
```

### Create ECR repositories if they do not already exist

```powershell
aws ecr create-repository --profile $Profile --region $Region --repository-name newsite-fetcher
aws ecr create-repository --profile $Profile --region $Region --repository-name newsite-scheduler
```

### Tag and push

```powershell
docker tag newsite-fetcher:latest $Ecr/newsite-fetcher:latest
docker tag newsite-scheduler:latest $Ecr/newsite-scheduler:latest

docker push $Ecr/newsite-fetcher:latest
docker push $Ecr/newsite-scheduler:latest
```

## Step 8: Create Or Update AWS Lambda Functions

There are two possible cases.

### Case A: new Lambda functions do not exist yet

Create them as image-based Lambdas:

```powershell
aws lambda create-function `
  --profile $Profile `
  --region $Region `
  --function-name NEWSITE-fetcher `
  --package-type Image `
  --code ImageUri=$Ecr/newsite-fetcher:latest `
  --role arn:aws:iam::<ACCOUNT_ID>:role/<FETCHER_ROLE_NAME> `
  --timeout 900 `
  --memory-size 1024

aws lambda create-function `
  --profile $Profile `
  --region $Region `
  --function-name NEWSITE-scheduler `
  --package-type Image `
  --code ImageUri=$Ecr/newsite-scheduler:latest `
  --role arn:aws:iam::<ACCOUNT_ID>:role/<SCHEDULER_ROLE_NAME> `
  --timeout 900 `
  --memory-size 2048
```

Then set environment variables:

```powershell
aws lambda update-function-configuration `
  --profile $Profile `
  --region $Region `
  --function-name NEWSITE-fetcher `
  --environment "Variables={SITE_ID=NEWSITE,PLANT_ID=vedanjay,BUCKET=<bucket>,CONTROL_WINDOWS_TABLE=<table>,CONTROL_STATE_TABLE=<table>}"

aws lambda update-function-configuration `
  --profile $Profile `
  --region $Region `
  --function-name NEWSITE-scheduler `
  --environment "Variables={SITE_ID=NEWSITE,PLANT_ID=vedanjay,BUCKET=<bucket>,CONTROL_WINDOWS_TABLE=<table>,CONTROL_STATE_TABLE=<table>}"
```

### Case B: Lambda functions already exist and need migration to the new codebase

Update the images only:

```powershell
aws lambda update-function-code --profile $Profile --region $Region --function-name NEWSITE-fetcher --image-uri $Ecr/newsite-fetcher:latest
aws lambda update-function-code --profile $Profile --region $Region --function-name NEWSITE-scheduler --image-uri $Ecr/newsite-scheduler:latest
```

Then reconcile environment variables, timeout, memory, and role:

```powershell
aws lambda update-function-configuration --profile $Profile --region $Region --function-name NEWSITE-fetcher --timeout 900 --memory-size 1024
aws lambda update-function-configuration --profile $Profile --region $Region --function-name NEWSITE-scheduler --timeout 900 --memory-size 2048
```

## Step 9: Grant Fetcher Permission To Invoke Scheduler

The fetcher invokes the scheduler asynchronously, so the fetcher execution role must allow:

- `lambda:InvokeFunction` on `NEWSITE-scheduler`

At minimum the IAM policy attached to the fetcher role must include:

```json
{
  "Effect": "Allow",
  "Action": "lambda:InvokeFunction",
  "Resource": "arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:NEWSITE-scheduler"
}
```

If aliases are used, include the qualified function ARN as needed.

## Step 10: Create EventBridge Cron For Fetcher Only

The scheduler must not have cron.

Create the fetcher rule:

```powershell
$RuleName = "NEWSITE-fetcher-cron"
$TargetId = "NEWSITE-fetcher-target"

aws events put-rule `
  --profile $Profile `
  --region $Region `
  --name $RuleName `
  --schedule-expression "cron(3,18,33,48 * * * ? *)"
```

Get the fetcher Lambda ARN:

```powershell
$FetcherArn = aws lambda get-function --profile $Profile --region $Region --function-name NEWSITE-fetcher --query 'Configuration.FunctionArn' --output text
```

Attach the target:

```powershell
aws events put-targets `
  --profile $Profile `
  --region $Region `
  --rule $RuleName `
  --targets "[{\"Id\":\"$TargetId\",\"Arn\":\"$FetcherArn\"}]"
```

Grant EventBridge permission:

```powershell
$AccountId = aws sts get-caller-identity --profile $Profile --query Account --output text
$SourceArn = "arn:aws:events:$Region:$AccountId:rule/$RuleName"

aws lambda add-permission `
  --profile $Profile `
  --region $Region `
  --function-name NEWSITE-fetcher `
  --statement-id "$RuleName-invoke" `
  --action lambda:InvokeFunction `
  --principal events.amazonaws.com `
  --source-arn $SourceArn
```

## Step 11: Use The Existing Deployment Script

If the manifest is updated correctly, the simplest update path is:

```powershell
cd cloud/deployment
.\deploy_site_lambdas.ps1 -Profile Test_vedanjay -Region ap-south-1 -ApplyCron
```

This script:

1. logs into ECR
2. builds fetcher and scheduler images
3. pushes both images
4. updates Lambda functions
5. optionally creates or updates the fetcher cron rule

Important limitation:

- the script assumes the Lambda functions already exist
- if this is a brand-new site, create the functions first, then use the script for subsequent updates

## Step 12: If The Site Needs WhatsApp Control Parsing

Only touch the WhatsApp handler if the new site introduces a new group name, alias, or parsing rule.

Relevant file:

- `cloud/whatsapp/handler.py`

Only add:

- site aliases
- group-name aliases
- site normalization support

Do not add new business logic there unless the message format truly differs.

## Step 13: Migration Checklist For Existing Legacy Site

If you are migrating a site from an older Lambda setup:

1. copy its actual FTP/SFTP details and verify file naming patterns against the new config
2. create the new site config
3. map the site into `constants.py`
4. add wrappers and manifest entry
5. create or update ECR repositories
6. create the new fetcher/scheduler Lambdas or repoint old Lambdas to the new images
7. remove scheduler cron if the old scheduler had one
8. create fetcher cron
9. confirm the fetcher role can invoke the scheduler
10. run one manual/custom validation and one cron-driven validation

## Minimum Validation Checklist

### Local

- forecast regex matches real remote filenames
- metered adapter works with actual raw files
- `fetch_manifest.json` is written
- strict scheduler payload is built
- schedule CSV and meta files are generated

### AWS

- fetcher logs show successful sync
- fetcher logs show correct trigger resolution
- fetcher invokes `SITE-scheduler`
- scheduler logs show strict payload execution
- outputs land in the correct generated S3 prefix
- no scheduler cron exists

## Common Failure Modes

- date format mismatch like `2026-07-9` instead of `2026-07-09`
- forecast regex too strict for the actual Enercast filename
- wrong `metered.filename_mode`
- wrong `metered_snapshot_glob`
- site not added to `constants.py`, causing registry failures
- fetcher/scheduler names mismatched between config and manifest
- Lambda role missing `lambda:InvokeFunction`
- EventBridge cron attached to scheduler instead of fetcher
- environment variables missing bucket or DynamoDB table names

## Read These Files Before Adding A Site

- `cloud/configs/sites/OSEPL.json`
- `cloud/configs/sites/ANJANGOAN.json`
- `cloud/common/constants.py`
- `cloud/common/site_registry.py`
- `cloud/fetcher_core/fetch_worker.py`
- `cloud/fetcher_core/metered_adapters/standard_daily_file.py`
- `cloud/fetcher_core/metered_adapters/ftp_snapshot_per_block.py`
- `cloud/lambda_sites/osepl/fetcher_handler.py`
- `cloud/lambda_sites/osepl/scheduler_handler.py`
- `cloud/deployment/site_lambda_manifest.json`
- `cloud/deployment/deploy_site_lambdas.ps1`

## Final Rule

Add new sites through configuration and wrappers first.  
Do not push site-specific branching into fetcher core or scheduler core unless the new site introduces a truly new protocol, file structure, or business rule.

Related:

- `cloud/docs/obsidian-vault/DOC-008 Backend Logic Architecture.md`
- `cloud/docs/obsidian-vault/DOC-009 Backend Code Reference Manual.md`
- `cloud/docs/obsidian-vault/DOC-010 Backend Cloud Infrastructure and Deployment Guide.md`
- `cloud/docs/obsidian-vault/DOC-011 Backend Developer Playbook.md`
