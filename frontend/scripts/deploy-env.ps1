param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("prod", "test")]
    [string]$Environment,

    [string]$Action = "up"
)

$ErrorActionPreference = "Stop"

function Load-EnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Env file not found: $Path"
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line) { return }
        if ($line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$envFile = Join-Path $repoRoot "deploy\env\$Environment.env"
$composeFile = if ($Environment -eq "prod") {
    Join-Path $repoRoot "docker-compose.prod.yml"
} else {
    Join-Path $repoRoot "docker-compose.test.yml"
}

Load-EnvFile -Path $envFile

$requiredVars = @("AWS_ACCOUNT_ID", "AWS_REGION", "S3_BUCKET")
foreach ($varName in $requiredVars) {
    $value = [Environment]::GetEnvironmentVariable($varName, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required variable '$varName' in $envFile"
    }
}

$awsRegion = [Environment]::GetEnvironmentVariable("AWS_REGION", "Process")
$awsAccountId = [Environment]::GetEnvironmentVariable("AWS_ACCOUNT_ID", "Process")
$awsProfile = [Environment]::GetEnvironmentVariable("AWS_PROFILE", "Process")
$ecrHost = "$awsAccountId.dkr.ecr.$awsRegion.amazonaws.com"

Write-Host "Environment: $Environment" -ForegroundColor Cyan
Write-Host "Using compose: $composeFile" -ForegroundColor Cyan
Write-Host "Using env: $envFile" -ForegroundColor Cyan

if ($Action -eq "login" -or $Action -eq "up" -or $Action -eq "pull") {
    if ($awsProfile) {
        aws ecr get-login-password --region $awsRegion --profile $awsProfile | docker login --username AWS --password-stdin $ecrHost
    } else {
        aws ecr get-login-password --region $awsRegion | docker login --username AWS --password-stdin $ecrHost
    }
}

switch ($Action) {
    "login" {
        Write-Host "ECR login complete." -ForegroundColor Green
    }
    "pull" {
        docker compose --env-file $envFile -f $composeFile pull
    }
    "up" {
        docker compose --env-file $envFile -f $composeFile pull
        docker compose --env-file $envFile -f $composeFile up -d
        docker compose --env-file $envFile -f $composeFile ps
    }
    "down" {
        docker compose --env-file $envFile -f $composeFile down
    }
    default {
        throw "Unsupported action '$Action'. Use one of: login, pull, up, down"
    }
}
