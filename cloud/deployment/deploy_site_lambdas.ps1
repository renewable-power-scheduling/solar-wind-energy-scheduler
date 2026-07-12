param(
    [string]$Profile = "Test_vedanjay",
    [string]$Region = "ap-south-1",
    [switch]$ApplyCron
)

$ErrorActionPreference = "Stop"

$AccountId = aws sts get-caller-identity --profile $Profile --query Account --output text
if (-not $AccountId) {
    throw "Unable to resolve AWS account id."
}

$Ecr = "$AccountId.dkr.ecr.$Region.amazonaws.com"
$ManifestPath = Join-Path $PSScriptRoot "site_lambda_manifest.json"
$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json

$LoginPassword = aws ecr get-login-password --region $Region --profile $Profile
$LoginPassword | docker login --username AWS --password-stdin $Ecr

foreach ($site in $Manifest.sites) {
    $siteId = $site.site_id
    $siteLower = $siteId.ToLower()

    $fetcherImageLocal = "$siteLower-fetcher:latest"
    $schedulerImageLocal = "$siteLower-scheduler:latest"
    $fetcherImageRemote = "$Ecr/$($site.fetcher_lambda_name.ToLower()):latest"
    $schedulerImageRemote = "$Ecr/$($site.scheduler_lambda_name.ToLower()):latest"

    Write-Host "Building fetcher image for $siteId"
    docker build --platform linux/amd64 --provenance=false --sbom=false -f $site.fetcher_dockerfile -t $fetcherImageLocal .

    Write-Host "Building scheduler image for $siteId"
    docker build --platform linux/amd64 --provenance=false --sbom=false -f $site.scheduler_dockerfile -t $schedulerImageLocal .

    docker tag $fetcherImageLocal $fetcherImageRemote
    docker tag $schedulerImageLocal $schedulerImageRemote

    docker push $fetcherImageRemote
    docker push $schedulerImageRemote

    aws lambda update-function-code --profile $Profile --region $Region --function-name $site.fetcher_lambda_name --image-uri $fetcherImageRemote | Out-Null
    aws lambda update-function-code --profile $Profile --region $Region --function-name $site.scheduler_lambda_name --image-uri $schedulerImageRemote | Out-Null

    if ($ApplyCron) {
        $ruleName = "$($site.fetcher_lambda_name)-cron"
        $targetId = "$($site.fetcher_lambda_name)-target"

        aws events put-rule `
            --profile $Profile `
            --region $Region `
            --name $ruleName `
            --schedule-expression $site.fetcher_cron_expression | Out-Null

        $fetcherArn = aws lambda get-function --profile $Profile --region $Region --function-name $site.fetcher_lambda_name --query 'Configuration.FunctionArn' --output text

        aws events put-targets `
            --profile $Profile `
            --region $Region `
            --rule $ruleName `
            --targets "[{\"Id\":\"$targetId\",\"Arn\":\"$fetcherArn\"}]" | Out-Null

        $sourceArn = "arn:aws:events:$Region:$AccountId:rule/$ruleName"
        try {
            aws lambda add-permission `
                --profile $Profile `
                --region $Region `
                --function-name $site.fetcher_lambda_name `
                --statement-id "$ruleName-invoke" `
                --action lambda:InvokeFunction `
                --principal events.amazonaws.com `
                --source-arn $sourceArn | Out-Null
        } catch {
            Write-Host "Permission may already exist for $ruleName"
        }
    }
}

Write-Host "Site Lambda deployment completed."
