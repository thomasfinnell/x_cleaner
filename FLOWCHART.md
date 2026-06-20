# X Cleaner — Code Flow (v0.86)

Flowcharts for documentation. Renders in GitHub, Notion, VS Code (Mermaid), and most modern doc tools.

---

## 1. High-level architecture

```mermaid
flowchart TB
  subgraph Entry["Entry points"]
    POP[Extension popup<br/>popup.html + popup.js]
    HUD[On-page HUD<br/>content.js]
    BG[Service worker<br/>background.js]
  end

  subgraph ContentScripts["Content scripts on x.com"]
    SNIFF[xc-fetch-sniffer.js<br/>MAIN world — capture GraphQL]
    BRIDGE[xc-rest-bridge.js<br/>REST session bridge]
    CS[content.js<br/>HUD UI + message relay]
  end

  subgraph FetchLibs["Imported modules"]
    API[api-fetch.js<br/>GraphQL worker + inject helpers]
    REST[rest-fetch.js<br/>REST v1.1 list fetch]
    SUB[subscription.js<br/>@d2fl gate + owner handles]
  end

  subgraph Storage["Persistence"]
    LOCAL[(chrome.storage.local<br/>xc_following_persist<br/>xc_followers_persist<br/>xc_activity_cache<br/>xc_enrich_archive<br/>xfr_fetch_subscription_state)]
  end

  POP -->|runtime.sendMessage| BG
  HUD -->|runtime.sendMessage| BG
  BG --> API
  BG --> REST
  BG --> SUB
  BG <-->|persist / restore lists| LOCAL
  BG -->|tabs.sendMessage| CS
  BG -->|executeScript / inject| SNIFF
  BG -->|executeScript / inject| BRIDGE
  CS --> HUD
  BG -->|scrapeStatus broadcast| POP
  BG -->|updateHud| CS
```

---

## 2. Popup / HUD → background actions

```mermaid
flowchart TD
  A[User opens popup or HUD] --> B[getStatus / poll scrapeStatus]
  B --> C{User action?}

  C -->|Start Collection| D[runExportFlow<br/>listType, forceRefresh, handoffAfterHud]
  C -->|Stop / Close HUD| E[stopScrape]
  C -->|Filter| F[filterList<br/>mutuals / blue / inactive / botCheck]
  C -->|Export CSV| G[exportCSV]
  C -->|Load CSV| H[loadListCsv<br/>replace or append]
  C -->|Following / Followers toggle| I[setListType]
  C -->|Refresh subscription| J[checkSubscription<br/>syncFromTab optional]
  C -->|Subscribe| K[openSubscribe → x.com/d2fl]

  D --> L{handoffAfterHud?}
  F --> L
  J --> L

  L -->|Yes| M[ensureHudShown on X tab]
  M -->|OK| N[Return hudReady — popup closes]
  M -->|Fail| O[Error — refresh x.com]
  N --> P[Background job continues async]

  L -->|No| P
```

---

## 3. Collection flow (`runExportFlow`)

```mermaid
flowchart TD
  START[runExportFlow] --> RUNNING{activeFetch running?}
  RUNNING -->|Yes| ERR1[Error: already running]
  RUNNING -->|No| TAB[findFocusedXTab]
  TAB -->|None| ERR2[Error: open x.com tab]
  TAB -->|OK| TYPE[Set listType following/followers]

  TYPE --> ACCT[detectHandle + alignAccountForJob]
  ACCT --> FRESH{forceRefresh?}
  FRESH -->|Yes| CLR[Clear list + persist for type]
  FRESH -->|No| RES[restoreListState from storage]

  RES --> SUB[refreshSubscription]
  CLR --> SUB
  SUB --> HUD[ensureHudShown]
  HUD --> HAND{handoffAfterHud?}
  HAND -->|Yes| ASYNC[runExportFlowJob async]
  HAND -->|No| JOB[runExportFlowJob await]
  ASYNC --> RET[Return hudReady + isScraping]
  JOB --> DONE[Return final status]

  ASYNC --> FETCH
  JOB --> FETCH

  FETCH[runExportFlowJob] --> MODE{fetchMode}
```

---

## 4. Fetch mode cascade (auto)

```mermaid
flowchart TD
  MODE[fetchMode] --> AUTO{mode?}

  AUTO -->|rest or auto| REST[resolveProfileForFastFetch]
  REST --> CAP{Free tier cap?}
  CAP -->|200 max| TRIM[effectiveFetchTarget]
  CAP -->|Subscribed| FULL[Full list target]

  TRIM --> CACHED{Cached count ≥ total?}
  FULL --> CACHED
  CACHED -->|Yes| SKIP[Skip fetch — already complete]
  CACHED -->|No| RUNREST[runRestListFetch<br/>tailOnly if resuming]

  RUNREST -->|OK| PERSIST1[persist + notifyProgress]
  RUNREST -->|Partial/empty| GQL{auto mode?}
  GQL -->|No — rest only| FAILREST[Return REST error]
  GQL -->|Yes| WORKER[runGraphqlWorkerListFetch]

  WORKER -->|OK| PERSIST2[persist + complete]
  WORKER -->|Short/0| SNIFF[resetListForFreshFallback]

  AUTO -->|sniffer| SNIFF
  SNIFF --> NAV[Navigate profile → list tab]
  NAV --> CAPT[Native sniffer scroll + capture GraphQL pages]
  CAPT --> MERGE[Merge into listStore + debounced persist]
  MERGE --> LIMIT[trimListToFetchLimit if free tier]
  LIMIT --> DONE[reason: complete]

  PERSIST1 --> DONE
  PERSIST2 --> DONE
  SKIP --> DONE
```

---

## 5. Dual-list storage & account switch

```mermaid
flowchart LR
  subgraph Lists["In-memory listStore"]
    FOL[following.list + following.raw]
    FOLW[followers.list + followers.raw]
  end

  subgraph Keys["chrome.storage.local"]
    K1[xc_following_persist]
    K2[xc_followers_persist]
    K3[xc_list_type_pref]
  end

  FOL <-->|schedulePersist| K1
  FOLW <-->|schedulePersist| K2
  BG[background.js] -->|setListType| ACTIVE[Switch active listType]
  ACTIVE --> RESTORE[Restore saved jobState for that type]

  ACCT[New @handle detected] --> PURGE[purgePersistForOtherUsers]
  PURGE --> CLEAR[clearInMemoryLists]
  CLEAR --> RELOAD[restoreAllListState for active user]
```

---

## 6. Filter pipeline (`filterList`)

```mermaid
flowchart TD
  F[filterList] --> SRC{curRaw or curList empty?}
  SRC -->|Yes| E1[Error: nothing to filter]
  SRC -->|No| LOCK{Collection running?}
  LOCK -->|Yes| E2[Error: wait for collection]
  LOCK -->|No| SNAP[snapshotListRaw if needed]
  SNAP --> HUD[ensureFilterHudHandoff]
  HUD --> WORK[working = curRaw slice]

  WORK --> M{removeMutuals?}
  M -->|Yes| M1[Need other list or relationship flags]
  M1 --> M2[excludeMutuals]
  M2 --> M3[appliedFilters += non_mutuals]

  M3 --> B{removeBlue?}
  M -->|No| B
  B -->|Yes| B1[refreshBlueFlagsFromSniffer]
  B1 --> B2[Drop is_blue accounts]
  B2 --> B3[appliedFilters += non_blue]

  B3 --> I{removeInactive?<br/>Following only}
  B -->|No| I
  I -->|Yes| I1[Load activity cache + archive]
  I1 --> I2{REST lookup needed?}
  I2 -->|Yes| I3[enrichLastActiveForUsers]
  I2 -->|No| I4[Use cached last_active_ms]
  I3 --> I5[Keep inactive only — drop active]
  I4 --> I5
  I5 --> I6[appliedFilters += inactive]

  I6 --> BOT{botCheck?<br/>Followers only}
  I -->|No| BOT
  BOT -->|Yes| BOT1[Need you_follow flags]
  BOT1 --> BOT2[Skip accounts you follow]
  BOT2 --> BOT3[Enrich sparse profiles if needed]
  BOT3 --> BOT4[isPotentialBot signals]
  BOT4 --> BOT5[appliedFilters += bots]

  BOT5 --> FIN[setCurList filtered result]
  BOT -->|No| FIN
  FIN --> PERSIST[schedulePersist + reason: filtered]
```

**Bot-check signals:** default avatar, no bio, &lt;10 tweets, account &lt;30 days, @handle ending with &gt;4 digits, followers &gt;2× following.

---

## 7. CSV import (`loadListCsv`)

```mermaid
flowchart TD
  IMP[loadListCsv] --> BLOCK{Collection or enrich running?}
  BLOCK -->|Yes| E1[Error: wait]
  BLOCK -->|No| PARSE[extractUsersFromImportCsv]
  PARSE -->|0 rows| E2[Error: no valid usernames]
  PARSE -->|OK| MODE{mode?}

  MODE -->|replace| REP[Replace curList + curRaw]
  MODE -->|append| APP[mergeImportedUserLists dedupe by username]

  REP --> CAP
  APP --> CAP

  CAP{Free tier > 200?}
  CAP -->|Yes| TRUNC[Slice to 200 + status note]
  CAP -->|No| SAVE
  TRUNC --> SAVE[setCurList + schedulePersist]
  SAVE --> STAT[reason: complete<br/>appliedFilters cleared]
```

Accepts X Cleaner exports or simple one-handle-per-line CSVs. Same 200-record cap as live fetch on free tier.

---

## 8. Export CSV

```mermaid
flowchart TD
  EXP[exportCSV] --> EMPTY{curList empty?}
  EMPTY -->|Yes| E1[Error]
  EMPTY -->|No| SUB[refreshSubscription]
  SUB --> GATE{canExport?}
  GATE -->|No — free tier| E2[Error: requires @d2fl]
  GATE -->|Yes| BUILD[buildCsv from curList]
  BUILD --> NAME[x_following_or_followers_@user_date_filters.csv]
  NAME --> DL[injected downloadCsv on X tab]
  DL --> OK[reason: exported]
```

---

## 9. Subscription check

```mermaid
flowchart TD
  CHK[refreshSubscription / checkSubscription] --> CACHE{Valid cache in<br/>xfr_fetch_subscription_state?}
  CACHE -->|Yes, not forced| HIT[Use cached isSubscribed]
  CACHE -->|No or force| SNIFF[sniffCreatorSubscriptions on X tab]

  SNIFF --> AUTH[xcResolveAuthorization]
  AUTH --> OWNER{Pro owner handle?<br/>d2fl / alt_d2fl / d2fl_alt}
  OWNER -->|Yes| PRO1[isSubscribed = true, source: owner]
  OWNER -->|No| XCREATOR{d2fl in sniffed<br/>creator subscriptions?}
  XCREATOR -->|Yes| PRO2[isSubscribed = true, source: x-creator]
  XCREATOR -->|No| FREE[isSubscribed = false]

  PRO1 --> INFO[subscriptionInfo]
  PRO2 --> INFO
  FREE --> INFO
  HIT --> INFO

  INFO --> LIMITS{isSubscribed?}
  LIMITS -->|No| CAP[fetchLimit = 200<br/>canExport = false]
  LIMITS -->|Yes| UNLIM[fetchLimit = null<br/>canExport = true]
```

Shared subscription storage key with **X Follower Remover** (`xfr_fetch_subscription_state`).

---

## 10. Mutual detection

```mermaid
flowchart TD
  M[computeMutuals] --> BOTH{Both following and<br/>followers lists populated?}
  BOTH -->|No| PART[Partial counts only]
  BOTH -->|Yes| FLAGS[Read you_follow / follows_you flags]

  FLAGS --> F1[Following list: follows_you on each row]
  FLAGS --> F2[Followers list: you_follow on each row]
  F1 --> COUNT[mutualCount when flags available]
  F2 --> COUNT

  COUNT --> FILTER[Used by Remove mutuals filter<br/>and bot-check you_follow gate]
```

Fetching both lists (or REST relationship flags) enables mutual filtering and bot-check skip-for-following logic.

---

## 11. Progress notifications

```mermaid
flowchart LR
  BG[background.js] --> NP[notifyProgress]
  NP --> MSG[type: scrapeStatus]
  MSG --> POP[popup.js onMessage]
  MSG --> HUD[content.js updateHud]
  NP --> PERSIST[schedulePersist on milestones]
```

---

## Key files

| File | Role |
|------|------|
| `popup.js` / `popup.html` | Compact UI: start, filter, export, load CSV, list-type toggle |
| `content.js` | On-page HUD — mirrors popup actions, live progress |
| `background.js` | Collection, filter, import/export, persistence, subscription |
| `api-fetch.js` | GraphQL worker, profile resolve, CSV download inject |
| `rest-fetch.js` | REST v1.1 following/followers pagination |
| `xc-fetch-sniffer.js` | MAIN-world fetch/XHR capture for GraphQL + subscriptions |
| `xc-rest-bridge.js` | Sync REST auth tokens from page context |
| `subscription.js` | @d2fl Pro gate, owner handles, free-tier limits |