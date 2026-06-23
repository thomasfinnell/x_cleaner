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
  'list-preview.js', 'api-fetch.js', 'xc-fetch-sniffer.js'
)
foreach ($f in $required) {
  Assert "file exists: $f" (Test-Path (Join-Path $root $f))
}

# Manifest JSON
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
Assert 'manifest version 0.97.x patch format' ($manifest.version -match '^0\.97\.\d+$')
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
Assert 'per-account persist storage key' ($bg -match 'function persistStorageKey')
Assert 'getStatus syncs active account' ($bg -match 'getStatusAsync[\s\S]*?syncActiveAccountFromTab')
Assert 'tab activation syncs account' ($bg -match 'tabs\.onActivated')
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
Assert 'export always allowed in payload' ($bg -match 'canExport: true')
Assert 'free tier window helper' ((Get-Content (Join-Path $root 'subscription.js') -Raw) -match 'xcEnsureFreeTierWindow')
Assert 'export waits for download complete' ($bg -match 'waitForDownloadComplete')
Assert 'export uses save dialog' ($bg -match 'saveAs: true')
Assert 'manifest downloads permission' (($manifest.permissions -join ',') -match 'downloads')
Assert 'background downloads csv helper' ($bg -match 'chrome\.downloads\.download')
Assert 'export accepts listType' ($bg -match 'exportCSV\(\{ listType: message\.listType \}\)')
Assert 'getStatus supports hud handoff' ($bg -match "message\.handoffAfterHud")
Assert 'popup refresh uses getStatus handoff' ($popup -match "refreshStatus\(\{[\s\S]*?handoffAfterHud: true")
Assert 'popup init loads status on open' ($popup -match "refreshStatus\(\{ syncFromTab: true")
Assert 'subscription allows export on free tier' ((Get-Content (Join-Path $root 'subscription.js') -Raw) -match 'function xcCanExport[\s\S]*?return true')
Assert 'sniffer list root resolver' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match '__xcResolveListRoot')
Assert 'dom collect uses list root resolver' ($api -match '__xcResolveListRoot')
Assert 'sniffer stamps follower relationship' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'stampListRelationships')
Assert 'sniffer classifies who-to-follow suggestions' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'isSuggestionFollowingUser')
Assert 'sniffer versioned reinstall' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'XC_SNIFFER_VERSION')
Assert 'sniffer dom follow-state helpers' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match '__xcDomUserCellShowsFollowingState')
Assert 'sniffer trusts user entries with user_results' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'entryHasTrustedListUser')
Assert 'sniffer list root fallback' ((Get-Content (Join-Path $root 'xc-fetch-sniffer.js') -Raw) -match 'bestCount')
Assert 'background ingest uses following classifier' ($bg -match 'xcIsVerifiedFollowingListUser')
Assert 'observe diagnostics helper' ($api -match 'function readObserveDiagnostics')
Assert 'sniffer version gate in background' ($bg -match 'XC_EXPECTED_SNIFFER_VERSION')
Assert 'native list read filters following suggestions' ($api -match 'function xcIsSuggestionFollowingUser')

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
Assert 'HUD blocking overlay' ($content -match 'is-blocking')
Assert 'HUD backdrop blur' ($content -match 'backdrop-filter')
Assert 'HUD page interaction blocker' ($content -match 'installHudPageBlocker')
Assert 'HUD centered modal panel' ($content -match 'xc-panel')
Assert 'popup fast scroll warning' ($popup -match 'shadowban')
Assert 'runExportFlow passes fastScroll' ($popup -match 'fastScroll')
Assert 'background forwards fastScroll on runExportFlow' ($bg -match 'fastScroll: message\.fastScroll')
Assert 'gentle path decision logged' ($bg -match 'useObservePath')

# Dual list cards + switch lock
Assert 'background buildListStats' ($bg -match 'function buildListStats')
Assert 'background listStats in status' ($bg -match 'listStats: buildListStats')
Assert 'popup following card' ($popupHtml -match 'id="followingCard"')
Assert 'popup followers card' ($popupHtml -match 'id="followersCard"')
Assert 'HUD following card' ($content -match 'xcleaner-following-card')
Assert 'HUD followers card' ($content -match 'xcleaner-followers-card')
Assert 'list switch lock helper' ($bg -match 'function isListTypeSwitchLocked')
Assert 'clear stale active fetch' ($bg -match 'function clearStaleActiveFetch')
Assert 'list switch unlocks after idle job' ($bg -match 'LIST_TYPE_MID_FLIGHT_REASONS')
Assert 'small shortfall tail-gap recovery' ($bg -match 'fetchListTailGap')

# Observe-only gentle mode (Fast off)
Assert 'observe list fetch function' ($bg -match 'async function runObserveListFetch')
Assert 'observe graphql handoff' ($bg -match 'async function observeTryGraphqlHandoff')
Assert 'following observe graphql handoff' ($bg -match "type === 'following'[\s\S]*?observe → GraphQL")
Assert 'following one-pass handoff at zero' ($bg -match 'observeGraphqlHandoffMinPasses[\s\S]*?following.*collected === 0\) return 1')
Assert 'graphql uses merged fetch not tab-only' ($bg -match 'continueListFetchWithGraphql[\s\S]*?fetchListPageMerged')
Assert 'graphql retry in tab' ($bg -match 'retrying .* in tab with live query id')
Assert 'build graphql catalog helper' ($bg -match 'async function buildGraphqlCatalog')
Assert 'followers graphql uses tab session' ($bg -match 'async function fetchListGraphqlPage')
Assert 'followers graphql tab-first' ($bg -match "type === 'followers'[\s\S]*?return tabRes")
Assert 'tab graphql recovery gap 200' ($bg -match 'recoverShortfallViaTabGraphql[\s\S]*?gap > 200')
Assert 'followers handoff rest cursor' ($bg -match 'REST sniffer cursor \(\$\{collected')
Assert 'rest sniffer cursor paginated' ($bg -match 'recoverShortfallViaRestSnifferCursor[\s\S]*?maxPages')
Assert 'rest sniffer cursor chains nextCursor' ($bg -match 'recoverShortfallViaRestSnifferCursor[\s\S]*?restCursor = nextCursor')
Assert 'followers handoff skips graphql' ($bg -match "if \(type === 'followers'\) \{[\s\S]*?recoverShortfallViaTabGraphql[\s\S]*?return true")
Assert 'following observe rest handoff' ($bg -match "restGapCap = type === 'following' \? 200")
Assert 'following graphql failure recovery' ($bg -match 'GraphQL failed[\s\S]*?recoverShortfallViaRestSnifferCursor[\s\S]*?recoverShortfallViaTabGraphql')
Assert 'followers graphql sniffer template' ($bg -match 'readCapturedListTemplateFromTab\(tabId, params\.opName\)')
Assert 'worker recovery allows 200 gap' ($bg -match 'gap > 200')
Assert 'sticky job cancel flag' ($bg -match 'let jobCancelled = false')
Assert 'isJobCancelled sticky flag' ($bg -match 'function isJobCancelled[\s\S]*?jobCancelled')
Assert 'observe loop uses isJobCancelled' ($bg -match 'while \(!isJobCancelled\(\)\)')
Assert 'waitForNativeList respects cancel' ($api -match 'isJobCancelled')
Assert 'hideHud stops before remove' ($content -match "action: 'dismissHud'[\s\S]*?hud\.remove\(\)")
Assert 'observe finish shortfall recovery' ($bg -match 'async function observeFinishShortfall')
Assert 'graphql restart from top option' ($bg -match 'restartFromTop')
Assert 'observe adaptive followers pace' ($bg -match 'function observeLoopPaceMs')
Assert 'gentle mode routes to observe' ($bg -match '!fastScrollEnabled && fetchMode === .auto.')
Assert 'observe export flow job' ($bg -match 'async function runObserveExportFlowJob')
Assert 'gentle dwell 30s base' ($bg -match 'XC_GENTLE_DWELL_BASE_MS = 30000')
Assert 'gentle dwell 5s jitter' ($bg -match 'XC_GENTLE_DWELL_JITTER_MS = 5000')
Assert 'list mutation observer start' ($api -match 'function injectedStartListObserver')
Assert 'list mutation observer drain' ($api -match 'function injectedDrainObserveListUsers')
Assert 'light dom collect helper' ($api -match 'function injectedCollectVisibleListUsersLight')
Assert 'observe scroll mode label' ($bg -match 'observe \+ gentle scroll')
Assert 'debug status log enabled' ($bg -match 'XC_DEBUG_STATUS_LOG = true')
Assert 'popup status log element' ($popupHtml -match 'id="statusLog"')
Assert 'HUD status log element' ($content -match 'id="xcleaner-status-log"')
Assert 'popup version from manifest' ($popup -match 'getManifest\(\)')
Assert 'persistent popup when debug log' ($bg -match 'configureActionPopupForDebugLog')
Assert 'gentle scroll inlined findRegion' ($api -match 'function injectedGentleScrollStep[\s\S]*?const findRegion = \(\) =>')
Assert 'observe keeps scrolling when short' ($bg -match 'stillShort && gap')
Assert 'observe tail recovery uses fetchListTailGap' ($bg -match 'async function observeRecoverShortfall[\s\S]*?fetchListTailGap')
Assert 'observe tail nudge scrolls to end' ($bg -match 'scrollListToLoad\(tabId, \{ gap, aggressive: true \}\)')
Assert 'gentle dwell skips small tail gap' ($bg -match 'gap != null && gap > 0 && gap <= 15\) return')
Assert 'popup method line hidden' ($popupHtml -match '#method \{ display: none; \}')
Assert 'HUD method line hidden' ($content -match '\.xc-method \{ display: none; \}')
Assert 'background getListPreview action' ($bg -match "case 'getListPreview'")
Assert 'list preview modal helper' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'xcShowListPreviewModal')
Assert 'view preview username profile links' (
  ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'xc-preview-profile-link') -and
  ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'function xcPreviewProfileUrl')
)
Assert 'popup view button' ($popupHtml -match 'id="viewBtn"')
Assert 'HUD view button' ($content -match 'id="xcleaner-view"')
Assert 'manifest loads list-preview in content' (($manifest.content_scripts | ForEach-Object { $_.js }) -join ',' -match 'list-preview\.js')
Assert 'view count helper' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'function xcCountForListType')
Assert 'view count ignores zero stats' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'if \(best > 0\) return best')
Assert 'free mode view preview helper' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'function xcCanViewListPreview')
Assert 'view preview uses canExport free gate' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'state\.canExport === false')
Assert 'list preview helpers always exported' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'globalThis\.xcCanViewListPreview')
Assert 'popup status polling keeps collecting' ($popup -match 'shouldKeepStatusPolling')
Assert 'list switch uses server lock only' ($popup -match 'function isListTypeLocked[\s\S]*?return !!state\.listTypeLocked')
Assert 'popup list card switch wiring' ($popup -match 'wireListCardSwitch')
Assert 'observe tail REST fallback' ($bg -match 'targeted REST lookup')
Assert 'setListType restores list rows' ($bg -match 'await restoreListState\(nextType\)')
Assert 'ensureRestored loads all lists' ($bg -notmatch 'if \(curList\(\)\.length \|\| activeFetch')
Assert 'popup view uses selected list count' ($popup -match 'xcCountForListType\(state, previewType\)')
Assert 'HUD view uses selected list count' ($content -match 'hudCountForListType\(state, hudType\)')
Assert 'getStatus restores before counts' ($bg -match 'async function getStatusAsync[\s\S]*?await ensureRestored')
Assert 'csv import returns status counts' ($bg -match 'loadListFromCsv[\s\S]*?getStatus\(\)')
Assert 'progress payload includes listStats' ($bg -match 'notifyProgress[\s\S]*?listStats: buildListStats\(\)')
Assert 'debug log preserved on jobState assign' ($bg -match 'function assignJobState')
Assert 'stop restores debug log from storage' ($bg -match 'async function finishStoppedJob[\s\S]*?restoreDebugStatusLogFromStorage')
Assert 'stop returns debug payload' ($bg -match 'async function stopScrape[\s\S]*?debugStatusPayload')
Assert 'debug log merge helper' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'function xcPickDebugStatusLog')
Assert 'content script inject includes list-preview' ($bg -match "files: \['list-preview\.js', 'content\.js'\]")
Assert 'list-preview safe to inject twice' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match '__xcListPreviewReady')
Assert 'content hud local count helper' ($content -match 'function hudCountForListType')
Assert 'popup panel positions right' ($popup -match 'positionDebugPanel')

# Last-post (inactive) filter
Assert 'inactive filter runs on followers' ($bg -notmatch 'Last post filter applies to Following — skipped on Followers')
Assert 'inactive enrich rate limit cap' ($bg -match 'ENRICH_RATE_LIMIT_MAX_RETRIES')
Assert 'inactive enrich bearer wait' ($bg -match 'ENRICH_BEARER_WAIT_MS')
Assert 'inactive filter passes list type to lookup' ($bg -match 'enrichLastActiveForUsers\(jobTabId, parts\.needsLookup, type')
Assert 'inactive partition by account age' ($bg -match 'partitionInactiveFilterCandidates')
Assert 'inactive lookup uses gentler batching' ($bg -match 'INACTIVE_LOOKUP_BATCH_SIZE')
Assert 'users lookup requests status' ((Get-Content (Join-Path $root 'rest-fetch.js') -Raw) -match "skip_status: 'false'")
Assert 'HUD filter awaits background response' ($content -match "action: 'filterList'[\s\S]*?await sendToBackground")
Assert 'raw count helper for filter gate' ((Get-Content (Join-Path $root 'list-preview.js') -Raw) -match 'function xcRawCountForListType')
Assert 'HUD filter uses raw count not filtered count' ($content -match 'hudRawCountForListType')
Assert 'popup filter uses raw count not filtered count' ($popup -match 'xcRawCountForListType')
Assert 'background dismissHud action' ($bg -match "case 'dismissHud'")
Assert 'dismissHud stops active work' ($bg -match 'async function dismissHud')
Assert 'cancel active work helper' ($bg -match 'function cancelActiveWork')
Assert 'HUD close dismisses and stops' ($content -match "action: 'dismissHud'")
Assert 'fresh start persist guard' ($bg -match 'persistGuard')
Assert 'fresh start blocks restore while active' ($bg -match 'freshStartBackupTypes\.has\(type\)')
Assert 'fresh start stop finalize helper' ($bg -match 'persistFreshStartStopState')
Assert 'filter returns full hud state' ($bg -match 'function buildFilterClientResponse')
Assert 'HUD merges partial filter updates' ($content -match 'lastHudPayload')

Write-Host ""
Write-Host "Results: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }