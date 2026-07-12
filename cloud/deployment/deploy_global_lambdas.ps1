param(
    [string]$Profile = "Test_vedanjay",
    [string]$Region = "ap-south-1"
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

foreach ($lambda in $Manifest.global_lambdas) {
    $name = $lambda.name
    $imageLocal = "$name:latest"
    $imageRemote = "$Ecr/$name:latest"

    Write-Host "Building global Lambda image for $name"
    docker build --platform linux/amd64 --provenance=false --sbom=false -f $lambda.dockerfile -t $imageLocal .

    docker tag $imageLocal $imageRemote
    docker push $imageRemote

    aws lambda update-function-code --profile $Profile --region $Region --function-name $name --image-uri $imageRemote | Out-Null
}

Write-Host "Global Lambda deployment completed."
