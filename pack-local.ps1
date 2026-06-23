# Build a clean local copy for "Load unpacked" (Chrome blocks most .crx sideloads).
param(
  [string]$Src = "",
  [switch]$Zip,
  [switch]$ForWebStore
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
  "list-preview.js",
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

# Clean icons folder for distribution (only the PNGs declared in manifest)
$iconsDest = Join-Path $dest "icons"
if (Test-Path $iconsDest) {
  Get-ChildItem $iconsDest -File | Where-Object { $_.Extension -ne '.png' } | Remove-Item -Force
}

# Ensure icons/ subdir has exactly the required PNGs and nothing else at extension root
$iconsDest = Join-Path $dest 'icons'
New-Item -ItemType Directory -Path $iconsDest -Force | Out-Null
# remove everything currently in icons/ and any loose icon files at root
Get-ChildItem $iconsDest -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Get-ChildItem $dest -File | Where-Object { $_.Name -match '^icon(16|48|128)\.' } | Remove-Item -Force
# copy only the three PNGs from source into icons/
$iconsSrc = Join-Path $Src 'icons'
@('icon16.png','icon48.png','icon128.png') | ForEach-Object {
  $srcFile = Join-Path $iconsSrc $_
  if (Test-Path $srcFile) {
    Copy-Item -LiteralPath $srcFile -Destination (Join-Path $iconsDest $_) -Force
  }
}

$doZip = $Zip -or $ForWebStore

if ($doZip) {
  $manifestPath = Join-Path $dest "manifest.json"
  $ver = "0.0.0"
  if (Test-Path $manifestPath) {
    try {
      $mf = Get-Content $manifestPath -Raw | ConvertFrom-Json
      if ($mf.version) { $ver = $mf.version }
    } catch {}
  }
  $zipName = "x_cleaner_v$ver.zip"
  $zipPath = Join-Path (Split-Path $dest -Parent) $zipName
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

  # Zip from inside the build dir so structure is flat at root + subdirs preserved
  $prev = Get-Location
  try {
    Set-Location $dest
    Compress-Archive -Path '.\*' -DestinationPath $zipPath -Force
  } finally {
    Set-Location $prev
  }
  Write-Host "Web Store zip created: $zipPath"
}

Write-Host "Built: $dest"
Write-Host ""
Write-Host "In Chrome (dev):"
Write-Host "  1. chrome://extensions"
Write-Host "  2. Turn on Developer mode"
Write-Host "  3. Load unpacked -> select the folder above"
Write-Host ""
Write-Host "For Chrome Web Store:"
Write-Host "  - Use -ForWebStore or -Zip when calling this script to produce x_cleaner_vX.Y.Z.zip"
Write-Host "  - Upload the zip at https://chrome.google.com/webstore/devconsole"
Write-Host "  - Use privacy policy: https://d2fl.com/cleaner/privacy-policy.html"
Write-Host ""
Write-Host "Do NOT drag the .crx onto Chrome - modern Chrome blocks that."