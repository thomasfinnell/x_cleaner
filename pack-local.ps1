# Build a clean local copy for "Load unpacked" (Chrome blocks most .crx sideloads).
param(
  [string]$Src = ""
)

if (-not $Src) {
  $Src = $PSScriptRoot
  if (-not $Src) {
    $Src = Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  if (-not $Src) {
    $Src = (Get-Location).Path
  }
}

# Join-Path fails on \\?\ extended paths; strip the prefix for local file ops.
if ($Src -like '\\?\*') {
  $Src = $Src.Substring(4)
}

$dest = Join-Path $env:USERPROFILE "x_cleaner_build"

$include = @(
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "content.js",
  "xc-fetch-sniffer.js",
  "xc-rest-bridge.js",
  "subscription.js",
  "api-fetch.js",
  "rest-fetch.js",
  "icons"
)

if (Test-Path $dest) {
  Remove-Item $dest -Recurse -Force
}
New-Item -ItemType Directory -Path $dest | Out-Null

foreach ($item in $include) {
  $from = [System.IO.Path]::Combine($Src, $item)
  if (-not (Test-Path -LiteralPath $from)) {
    Write-Error "Missing required file: $item"
    exit 1
  }
  Copy-Item -LiteralPath $from -Destination ([System.IO.Path]::Combine($dest, $item)) -Recurse -Force
}

Write-Host "Built: $dest"
Write-Host ""
Write-Host "In Chrome:"
Write-Host "  1. chrome://extensions"
Write-Host "  2. Turn on Developer mode"
Write-Host "  3. Load unpacked -> select the folder above"
Write-Host ""
Write-Host "Do NOT drag the .crx onto Chrome - modern Chrome blocks that."