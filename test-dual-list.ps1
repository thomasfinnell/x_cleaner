# Offline smoke tests for dual-list logic (no Chrome required)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$passed = 0
$failed = 0

function Assert($name, $condition) {
  if ($condition) {
    Write-Host "[PASS] $name" -ForegroundColor Green
    $script:passed++
  } else {
    Write-Host "[FAIL] $name" -ForegroundColor Red
    $script:failed++
  }
}

# Required files
$required = @(
  'manifest.json', 'background.js', 'popup.js', 'popup.html', 'content.js',
  'api-fetch.js', 'xc-fetch-sniffer.js'
)
foreach ($f in $required) {
  Assert "file exists: $f" (Test-Path (Join-Path $root $f))
}

# Manifest JSON
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
Assert 'manifest version 0.90' ($manifest.version -eq '0.90')
Assert 'background service worker' ($manifest.background.service_worker -eq 'background.js')

# Action wiring (popup/background/content agree)
$bg = Get-Content (Join-Path $root 'background.js') -Raw
$popup = Get-Content (Join-Path $root 'popup.js') -Raw
$popupHtml = Get-Content (Join-Path $root 'popup.html') -Raw
$content = Get-Content (Join-Path $root 'content.js') -Raw
$api = Get-Content (Join-Path $root 'api-fetch.js') -Raw

Assert 'background handles setListType' ($bg -match "case 'setListType'")
Assert 'background handles runExportFlow listType' ($bg -match 'message\.listType')
Assert 'popup sends setListType' ($popup -match "sendBackground\('setListType'")
Assert 'popup sends listType on start' ($popup -match "sendBackground\('runExportFlow',\s*\{[\s\S]*?listType")
Assert 'content HUD setListType' ($content -match "action: 'setListType'")
Assert 'api readNativeList generalized' ($api -match 'function readNativeList')
Assert 'api waitForNativeList generalized' ($api -match 'function waitForNativeList')

# Separate persist keys
Assert 'following persist key' ($bg -match 'xc_following_persist')
Assert 'followers persist key' ($bg -match 'xc_followers_persist')
Assert 'list type preference key' ($bg -match 'xc_list_type_pref')

# CSV naming
Assert 'following csv pattern' ($bg -match 'x_\$\{cfg\.path\}_')
Assert 'followers path in config' ($bg -match "path: 'followers'")

# Mutual logic simulation (mirror computeMutuals)
$following = @('alice', 'bob', 'carol')
$followers = @('bob', 'carol', 'dave')
$followingSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$following, [StringComparer]::OrdinalIgnoreCase)
$followersSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$followers, [StringComparer]::OrdinalIgnoreCase)
$mutuals = @($followingSet | Where-Object { $followersSet.Contains($_) })
Assert 'mutual count alice/bob/carol' ($mutuals.Count -eq 2 -and $mutuals -contains 'bob' -and $mutuals -contains 'carol')

$sub = Get-Content (Join-Path $root 'subscription.js') -Raw
Assert 'subscription.js exists' (Test-Path (Join-Path $root 'subscription.js'))
Assert 'required creator d2fl' ($sub -match 'XC_REQUIRED_CREATOR')
Assert 'pro owner handles' ($sub -match 'XC_PRO_OWNER_HANDLES')
Assert 'sniffer captures UserCreatorSubscriptions' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'UserCreatorSubscriptions')
Assert 'readCreatorSubscriptionsCapture helper' ($api -match 'readCreatorSubscriptionsCapture')
Assert 'free fetch limit 200' ($sub -match 'XC_FREE_FETCH_LIMIT = 200')
Assert 'background imports subscription' ($bg -match "importScripts\('subscription\.js'")
Assert 'background checkSubscription action' ($bg -match "case 'checkSubscription'")
Assert 'background openSubscribe action' ($bg -match "case 'openSubscribe'")
Assert 'HUD subscribe button' ($content -match 'xcleaner-subscribe')
Assert 'HUD refresh subscription button' ($content -match 'xcleaner-sub-refresh')
Assert 'export gated in background' ($bg -match 'subscriptionInfo\.canExport')

# CSV import
Assert 'background parseImportCsvRows' ($bg -match 'function parseImportCsvRows')
Assert 'background loadListFromCsv' ($bg -match 'async function loadListFromCsv')
Assert 'background loadListCsv action' ($bg -match "case 'loadListCsv'")
Assert 'free import cap uses XC_FREE_FETCH_LIMIT' ($bg -match 'subscriptionInfo\.fetchLimit')
Assert 'popup load following csv' ($popup -match "sendBackground\('loadListCsv'")
Assert 'popup import mode replace/append' ($popup -match 'importModeReplace')
Assert 'HUD load following csv' ($content -match "action: 'loadListCsv'")
Assert 'HUD import replace/append' ($content -match 'xcleaner-import-replace')

# Fast vs gentle scroll
Assert 'fast scroll pref key' ($bg -match 'xc_fast_scroll_pref')
Assert 'gentle scroll step in api-fetch' ($api -match 'function injectedGentleScrollStep')
Assert 'background setFastScroll action' ($bg -match "case 'setFastScroll'")
Assert 'popup fast checkbox' ($popupHtml -match 'id="fastScroll"')
Assert 'HUD fast checkbox' ($content -match 'xcleaner-fast-scroll')
Assert 'popup fast scroll warning' ($popup -match 'shadowban')
Assert 'runExportFlow passes fastScroll' ($popup -match 'fastScroll')

Write-Host ""
Write-Host "Results: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }