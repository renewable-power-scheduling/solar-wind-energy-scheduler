param(
  [Parameter(Mandatory = $true)]
  [string]$InputJson,

  [switch]$Merge
)

$ErrorActionPreference = "Stop"

function Get-PlantAndDateFromSourceKey([string]$SourceKey) {
  $text = [string]$SourceKey
  $m = [regex]::Match($text, "generated/vedanjay/(?<plant>[^/]+)/outputs/(?<date>\d{4}-\d{2}-\d{2})/", "IgnoreCase")
  if (-not $m.Success) {
    return $null
  }
  $plant = $m.Groups["plant"].Value.ToUpperInvariant()
  if ($plant -in @("SHRIMOUR", "SHROMOUR")) { $plant = "SIRMOUR" }
  return @{
    plant = $plant
    date  = $m.Groups["date"].Value
  }
}

function Get-RowValue($Row, [string[]]$Names) {
  foreach ($name in $Names) {
    if ($null -eq $Row) { continue }
    if ($Row.PSObject -and $Row.PSObject.Properties.Match($name).Count -gt 0) {
      $val = $Row.$name
      if ($null -ne $val) { return $val }
    }
  }
  return $null
}

function Get-UniqueKey($Row) {
  $source = [string](Get-RowValue $Row @("source_file_key", "sourceFileKey"))
  $requestedBy = [string](Get-RowValue $Row @("requested_by", "requestedBy"))
  $savedAt = [string](Get-RowValue $Row @("saved_at", "savedAt"))
  $time = [string](Get-RowValue $Row @("time"))
  $oldValue = [string](Get-RowValue $Row @("old_value", "oldValue"))
  $newValue = [string](Get-RowValue $Row @("new_value", "newValue"))
  $block = [string](Get-RowValue $Row @("block"))
  return ($source.Trim() + "|" + $block.Trim() + "|" + $time.Trim() + "|" + $oldValue.Trim() + "|" + $newValue.Trim() + "|" + $savedAt.Trim() + "|" + $requestedBy.Trim()).ToLowerInvariant()
}

if (-not (Test-Path -LiteralPath $InputJson)) {
  throw "Input JSON not found: $InputJson"
}

$raw = Get-Content -LiteralPath $InputJson -Raw
$payload = $raw | ConvertFrom-Json

$items =
  if ($payload -is [System.Array]) { $payload }
  elseif ($null -ne $payload.items -and $payload.items -is [System.Array]) { $payload.items }
  else { @() }

if ($items.Count -eq 0) {
  throw "No items found in JSON (expected an array or { items: [...] })."
}

$firstSource = [string](Get-RowValue $items[0] @("source_file_key", "sourceFileKey"))
$meta = Get-PlantAndDateFromSourceKey $firstSource
if ($null -eq $meta) {
  throw "Could not infer plant/date from source_file_key: $firstSource"
}

$plant = $meta.plant
$date = $meta.date

$destDir = Join-Path $PSScriptRoot "..\\backend\\uploads\\schedule_changes\\$plant\\$date"
$resolved = Resolve-Path -LiteralPath $destDir -ErrorAction SilentlyContinue
if ($null -ne $resolved -and $resolved.Path) {
  $destDir = $resolved.Path
}
$destPath = Join-Path $destDir "schedule_changes.json"

New-Item -ItemType Directory -Path $destDir -Force | Out-Null

$existing = @()
if ($Merge -and (Test-Path -LiteralPath $destPath)) {
  try {
    $existingRaw = Get-Content -LiteralPath $destPath -Raw
    $existingPayload = $existingRaw | ConvertFrom-Json
    if ($existingPayload -is [System.Array]) { $existing = $existingPayload } else { $existing = @() }
  } catch {
    $existing = @()
  }
}

$merged = @()
$seen = @{}

foreach ($row in @($existing) + @($items)) {
  $k = Get-UniqueKey $row
  if (-not $seen.ContainsKey($k)) {
    $seen[$k] = $true
    $merged += $row
  }
}

# Stable ordering: by saved_at (when parseable), then by block.
$mergedSorted = $merged | Sort-Object `
  @{ Expression = {
      $saved = [string](Get-RowValue $_ @("saved_at", "savedAt"))
      try { [DateTimeOffset]::Parse($saved) } catch { [DateTimeOffset]::MinValue }
    }; Ascending = $true }, `
  @{ Expression = {
      $blockText = [string](Get-RowValue $_ @("block"))
      try { [int]$blockText } catch { 0 }
    }; Ascending = $true }

$json = $mergedSorted | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $destPath -Value $json -Encoding UTF8

Write-Host "Imported $($items.Count) rows -> $destPath"
