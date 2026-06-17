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
Assert 'manifest version 0.63' ($manifest.version -eq '0.63')
Assert 'background service worker' ($manifest.background.service_worker -eq 'background.js')

# Action wiring (popup/background/content agree)
$bg = Get-Content (Join-Path $root 'background.js') -Raw
$popup = Get-Content (Join-Path $root 'popup.js') -Raw
$content = Get-Content (Join-Path $root 'content.js') -Raw
$api = Get-Content (Join-Path $root 'api-fetch.js') -Raw

Assert 'background handles setListType' ($bg -match "case 'setListType'")
Assert 'background handles runExportFlow listType' ($bg -match 'message\.listType')
Assert 'popup sends setListType' ($popup -match "sendBackground\('setListType'")
Assert 'popup sends listType on start' ($popup -match "runExportFlow', \{ listType \}")
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
Assert 'subs.txt url' ($sub -match 'd2fl\.com/subs\.txt')
Assert 'required creator d2fl' ($sub -match 'XC_REQUIRED_CREATOR')
Assert 'sniffer captures UserCreatorSubscriptions' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'UserCreatorSubscriptions')
Assert 'readCreatorSubscriptionsCapture helper' ($api -match 'readCreatorSubscriptionsCapture')
Assert 'free fetch limit 200' ($sub -match 'XC_FREE_FETCH_LIMIT = 200')
Assert 'background imports subscription' ($bg -match "importScripts\('subscription\.js'")
Assert 'background checkSubscription action' ($bg -match "case 'checkSubscription'")
Assert 'background openSubscribe action' ($bg -match "case 'openSubscribe'")
Assert 'HUD subscribe button' ($content -match 'xcleaner-subscribe')
Assert 'HUD refresh subscription button' ($content -match 'xcleaner-sub-refresh')
Assert 'export gated in background' ($bg -match 'subscriptionInfo\.canExport')
Assert 'manifest allows d2fl.com' ((Get-Content (Join-Path $root 'manifest.json') -Raw) -match 'd2fl\.com')

Write-Host ""
Write-Host "Results: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }