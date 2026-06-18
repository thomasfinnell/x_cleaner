importScripts('subscription.js', 'api-fetch.js', 'rest-fetch.js');

let jobTabId = null;
let activeFetch = null;
let listType = 'following';
let jobState = {
  username: null,
  listType: 'following',
  totalFollowing: null,
  totalFollowers: null,
  count: 0,
  isScraping: false,
  reason: null,
  method: 'graphql'
};

const LIST_TYPES = ['following', 'followers'];
const LIST_CONFIG = {
  following: {
    persistKey: 'xc_following_persist',
    opName: 'Following',
    path: 'following',
    label: 'Following',
    totalKey: 'totalFollowing'
  },
  followers: {
    persistKey: 'xc_followers_persist',
    opName: 'Followers',
    path: 'followers',
    label: 'Followers',
    totalKey: 'totalFollowers'
  }
};

const listStore = {
  following: { list: [], raw: [] },
  followers: { list: [], raw: [] }
};

const DEFAULT_NEW_ACCOUNT_MONTHS = 6;
const DEFAULT_INACTIVE_MONTHS = 6;
const MIN_FILTER_MONTHS = 1;
const MAX_FILTER_MONTHS = 24;
const ENRICH_BATCH_SIZE = XC_REST_LOOKUP_BATCH_SIZE;
const ENRICH_BATCH_DELAY_MS = XC_REST_LOOKUP_DELAY_MS;
const XC_ACTIVITY_CACHE_KEY = 'xc_activity_cache';
const XC_ACTIVITY_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const XC_LIST_TYPE_PREF_KEY = 'xc_list_type_pref';
const XC_FETCH_MODE_PREF_KEY = 'xc_fetch_mode_pref';
const XC_FETCH_MODES = ['auto', 'rest', 'sniffer'];
const XC_FETCH_MODE_DEFAULT = 'auto';
const XC_PERSIST_VERSION = 1;
const XC_PERSIST_COLLECT_INTERVAL = 250;
const XC_PERSIST_DEBOUNCE_MS = 15000;
// Let X finish rendering after tab navigation before sniffing/API capture.
const XC_PROFILE_NAV_SETTLE_MS = 2500;
const XC_LIST_NAV_SETTLE_MS = 3500;
const XC_FOLLOWERS_NAV_SETTLE_MS = 5000;
const XC_PRE_LIST_FETCH_SETTLE_MS = 1500;
const XC_POST_SNIFFER_SETTLE_MS = 800;

// Set false to hide the scrollable status log in the HUD/popup.
const XC_DEBUG_STATUS_LOG = true;
const XC_DEBUG_STATUS_LOG_MAX_LINES = 50;
const XC_DEBUG_STATUS_LOG_STORAGE_KEY = 'xc_debug_status_log';

let activeEnrich = false;
let subscriptionInfo = xcBuildSubscriptionInfo('', false);
const restoredTypes = { following: false, followers: false };
let restorePromise = null;
const persistDebounceTimers = { following: null, followers: null };
const lastPersistedCounts = { following: 0, followers: 0 };

function listCfg(type = listType) {
  return LIST_CONFIG[type] || LIST_CONFIG.following;
}

function curList(type = listType) {
  return listStore[type].list;
}

function curRaw(type = listType) {
  return listStore[type].raw;
}

function setCurList(value, type = listType) {
  listStore[type].list = value;
}

function setCurRaw(value, type = listType) {
  listStore[type].raw = value;
}

function totalForType(type = listType) {
  const cfg = listCfg(type);
  return jobState[cfg.totalKey] ?? null;
}

function restoredFromStorage() {
  return restoredTypes.following || restoredTypes.followers;
}

async function sniffCreatorSubscriptions(tabId, options = {}) {
  const forceRefresh = !!options.forceNavigate;
  const passiveOnly = !!options.passiveOnly;

  if (!tabId) return { ok: false, handles: [] };

  await ensureSnifferInstalled(tabId);

  if (!forceRefresh) {
    const existing = await executeOnTab(tabId, readCreatorSubscriptionsCapture);
    if (existing?.ok) {
      return { ok: true, handles: existing.handles || [], capturedAt: existing.capturedAt };
    }
  }

  if (passiveOnly && !forceRefresh) {
    return { ok: false, handles: [] };
  }

  if (forceRefresh) {
    await executeOnTab(tabId, () => {
      try {
        sessionStorage.removeItem('xc_creator_subs_latest');
      } catch (error) {}
    });
  }

  const active = await fetchCreatorSubscriptionsFromTab(tabId);
  if (active?.ok) {
    const payload = {
      ok: true,
      handles: active.handles || [],
      capturedAt: Date.now()
    };
    await executeOnTab(tabId, (data) => {
      try {
        sessionStorage.setItem('xc_creator_subs_latest', JSON.stringify(data));
      } catch (error) {}
    }, [payload]);
    return payload;
  }

  return { ok: false, handles: [] };
}

function isXTabUrl(url) {
  return /^https:\/\/(x\.com|twitter\.com)\//.test(url || '');
}

async function resolveActiveUsername(explicitHandle) {
  if (explicitHandle) return explicitHandle;

  const tab = await findFocusedXTab();
  if (tab?.id) {
    jobTabId = tab.id;
    try {
      const detected = await detectHandle(tab.id);
      if (detected) {
        jobState.username = detected;
        return detected;
      }
    } catch (error) {
      console.warn('[X Cleaner] handle detect for subscription failed', error);
    }
  }

  if (jobState.username) return jobState.username;

  const tabId = await ensureJobTabId();
  if (!tabId) return null;

  try {
    const detected = await detectHandle(tabId);
    if (detected) {
      jobState.username = detected;
      return detected;
    }
  } catch (error) {
    console.warn('[X Cleaner] handle detect for subscription failed', error);
  }

  return null;
}

async function hydrateSubscriptionFromStorage(handle) {
  subscriptionInfo = await xcHydrateSubscriptionFromStorage(handle || jobState.username);
  return subscriptionInfo;
}

async function refreshSubscription(handle, forceCheck = false) {
  const resolvedHandle = await resolveActiveUsername(handle);
  if (!forceCheck) {
    await hydrateSubscriptionFromStorage(resolvedHandle);
  }

  const tabId = await ensureJobTabId();
  const timeoutMs = forceCheck ? 45000 : 12000;
  let timedOut = false;

  const checkPromise = xcCheckSubscription(resolvedHandle, {
    forceCheck,
    sniff: tabId
      ? () => sniffCreatorSubscriptions(tabId, {
        forceNavigate: forceCheck,
        passiveOnly: !forceCheck
      })
      : null
  });

  const result = await Promise.race([
    checkPromise,
    new Promise((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, timeoutMs);
    })
  ]);

  if (result) {
    subscriptionInfo = result;
  } else if (timedOut) {
    if (!subscriptionInfo?.hydratedFromStorage) {
      await hydrateSubscriptionFromStorage(resolvedHandle);
    }
    subscriptionInfo = {
      ...subscriptionInfo,
      subsFetchFailed: true,
      subsFetchError: `Subscription check timed out after ${Math.round(timeoutMs / 1000)}s`
    };
  }

  return subscriptionInfo;
}

function effectiveFetchTarget(totalList) {
  const cap = subscriptionInfo.fetchLimit;
  if (cap == null) {
    return totalList;
  }
  if (totalList == null) {
    return cap;
  }
  return Math.min(totalList, cap);
}

function normalizeFetchMode(mode) {
  const value = String(mode || '').toLowerCase();
  return XC_FETCH_MODES.includes(value) ? value : XC_FETCH_MODE_DEFAULT;
}

async function getFetchMode() {
  try {
    const stored = await chrome.storage.local.get(XC_FETCH_MODE_PREF_KEY);
    return normalizeFetchMode(stored[XC_FETCH_MODE_PREF_KEY]);
  } catch (error) {
    return XC_FETCH_MODE_DEFAULT;
  }
}

async function setFetchMode(mode) {
  const normalized = normalizeFetchMode(mode);
  await chrome.storage.local.set({ [XC_FETCH_MODE_PREF_KEY]: normalized });
  return normalized;
}

function fetchModeLabel(mode) {
  if (mode === 'rest') return 'REST v1.1 (200/page)';
  if (mode === 'sniffer') return 'native sniffer + GraphQL';
  return 'auto: REST → GraphQL worker → sniffer';
}

function trimListToFetchLimit(type = listType) {
  const cap = subscriptionInfo.fetchLimit;
  if (cap == null || curList(type).length <= cap) return;
  setCurList(curList(type).slice(0, cap), type);
}

function subscriptionPayload() {
  return {
    ...subscriptionInfo,
    subscriptionStatus: xcFormatSubscriptionStatus(subscriptionInfo, jobState.username)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      finish();
    }, timeout);
  });
}

async function waitAfterTabNavigation(tabId, settleMs = XC_LIST_NAV_SETTLE_MS) {
  await waitForTabComplete(tabId);
  if (settleMs > 0) {
    await sleep(settleMs);
  }
}

function mergeRelationshipFields(existing, incoming) {
  if (!existing || !incoming) return existing;
  if (existing.you_follow == null && incoming.you_follow != null) existing.you_follow = incoming.you_follow;
  if (existing.follows_you == null && incoming.follows_you != null) existing.follows_you = incoming.follows_you;
  return existing;
}

function mergeUserFields(existing, incoming) {
  if (!existing || !incoming) return existing;
  mergeRelationshipFields(existing, incoming);
  if (!existing.is_blue && incoming.is_blue) existing.is_blue = true;
  return existing;
}

function buildSeenFromCurList(type, ownerUsername) {
  const seen = new Set();
  const owner = (ownerUsername || '').toLowerCase();
  for (const user of curList(type)) {
    const key = (user.username || '').toLowerCase();
    if (key && key !== owner) seen.add(key);
  }
  return seen;
}

function resetListForFreshFallback(type) {
  if (curList(type).length > 0) return false;
  setCurList([], type);
  setCurRaw([], type);
  return true;
}

function listResumeIsTailOnly(type, totalList) {
  const cached = curList(type).length;
  return cached > 0 && (totalList == null || cached < totalList);
}

function addNativeUsers(nativeBatch, seen, ownerUsername, type = listType) {
  let added = 0;
  const owner = (ownerUsername || '').toLowerCase();
  const cfg = listCfg(type);
  const totalList = jobState[cfg.totalKey] ?? null;

  for (const user of nativeBatch.users || []) {
    if (totalList != null && curList(type).length >= totalList) break;
    const key = (user.username || '').toLowerCase();
    if (!key || key === owner) continue;
    if (seen.has(key)) {
      const existing = curList(type).find((row) => (row.username || '').toLowerCase() === key);
      mergeUserFields(existing, user);
      continue;
    }
    seen.add(key);
    curList(type).push(user);
    added++;
  }

  return added;
}

async function scrapeProfileStats(tabId, handle) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (screenName) => {
      const parseCountText = (text) => {
        const cleaned = (text || '').replace(/,/g, '').trim();
        const suffix = cleaned.match(/([\d.]+)\s*([KkMm])/);
        if (suffix) {
          const amount = parseFloat(suffix[1]);
          const multiplier = suffix[2].toLowerCase() === 'm' ? 1000000 : 1000;
          return Math.round(amount * multiplier);
        }

        const digits = cleaned.match(/(\d+)/);
        return digits ? parseInt(digits[1], 10) : null;
      };

      const sn = String(screenName || '').replace(/^@+/, '').toLowerCase();
      const html =
        document.documentElement.innerHTML +
        ' ' +
        Array.from(document.getElementsByTagName('script'))
          .map((script) => script.textContent || '')
          .join(' ');

      let following = null;
      let followers = null;
      let userId = null;

      const followingLink = document.querySelector(
        'a[href$="/following"], a[href*="/following"]'
      );
      if (followingLink) {
        following = parseCountText(followingLink.textContent || followingLink.innerText || '');
      }

      for (const link of document.querySelectorAll('a[href*="/followers"]')) {
        const href = (link.getAttribute('href') || '').toLowerCase();
        if (href.includes('verified_followers')) continue;
        if (href.endsWith('/followers') || /\/followers(?:[/?]|$)/.test(href)) {
          followers = parseCountText(link.textContent || link.innerText || '');
          break;
        }
      }

      if (following === null) {
        const friendsMatch = html.match(/"friends_count":(\d+)/i);
        if (friendsMatch) following = parseInt(friendsMatch[1], 10);
      }

      if (following === null) {
        const followingMatch = html.match(/"following_count":(\d+)/i);
        if (followingMatch) following = parseInt(followingMatch[1], 10);
      }

      if (followers === null) {
        const followersMatch = html.match(/"followers_count":(\d+)/i);
        if (followersMatch) followers = parseInt(followersMatch[1], 10);
      }

      const patterns = [
        new RegExp(`"screen_name":"${sn}"[^}]{0,1200}?"rest_id":"(\\d+)"`, 'i'),
        new RegExp(`"rest_id":"(\\d+)"[^}]{0,1200}?"screen_name":"${sn}"`, 'i'),
        new RegExp(`"screen_name":"${sn}"[^}]{0,1200}?"id":"(\\d+)"`, 'i')
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          userId = match[1];
          break;
        }
      }

      if (!userId) {
        const idx = html.toLowerCase().indexOf(`"screen_name":"${sn}"`);
        if (idx >= 0) {
          const windowText = html.slice(idx, idx + 1200);
          const nearMatch = windowText.match(/"rest_id":"?(\d{6,})"?/i);
          if (nearMatch) userId = nearMatch[1];
        }
      }

      return {
        username: screenName,
        totalFollowing: following,
        totalFollowers: followers,
        userId
      };
    },
    args: [handle]
  });

  return results?.[0]?.result || {
    username: handle,
    totalFollowing: null,
    totalFollowers: null,
    userId: null
  };
}

async function scrapeListPageTotal(tabId, type) {
  const cfg = listCfg(type);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (listPath, countKey, pathPattern) => {
      const parseCountText = (text) => {
        const cleaned = (text || '').replace(/,/g, '').trim();
        const suffix = cleaned.match(/([\d.]+)\s*([KkMm])/);
        if (suffix) {
          const amount = parseFloat(suffix[1]);
          const multiplier = suffix[2].toLowerCase() === 'm' ? 1000000 : 1000;
          return Math.round(amount * multiplier);
        }
        const digits = cleaned.match(/(\d+)/);
        return digits ? parseInt(digits[1], 10) : null;
      };

      const headingPattern = pathPattern || listPath;
      const headings = document.querySelectorAll('h2, [role="heading"], [data-testid="primaryColumn"] span');
      for (const node of headings) {
        const text = node.textContent || '';
        if (!new RegExp(headingPattern, 'i').test(text)) continue;
        const count = parseCountText(text);
        if (count != null) return count;
      }

      const html =
        document.documentElement.innerHTML +
        ' ' +
        Array.from(document.getElementsByTagName('script'))
          .map((script) => script.textContent || '')
          .join(' ');
      const match = html.match(new RegExp(`"${countKey}":(\\d+)`, 'i'));
      return match ? parseInt(match[1], 10) : null;
    },
    args: [
      cfg.path,
      cfg.totalKey === 'totalFollowers' ? 'followers_count' : 'friends_count',
      type === 'followers' ? 'followers|verified' : cfg.path
    ]
  });

  const value = results?.[0]?.result;
  return Number.isFinite(value) ? value : null;
}

function escapeCsvField(value) {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str.replace(/\r?\n/g, ' ')}"`;
}

function parseAccountCreatedAt(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function normalizeFilterMonths(value, fallback = DEFAULT_INACTIVE_MONTHS) {
  const months = Math.round(Number(value));
  if (!Number.isFinite(months)) return fallback;
  return Math.min(MAX_FILTER_MONTHS, Math.max(MIN_FILTER_MONTHS, months));
}

function normalizeNewAccountMonths(value) {
  return normalizeFilterMonths(value, DEFAULT_NEW_ACCOUNT_MONTHS);
}

function normalizeInactiveMonths(value) {
  return normalizeFilterMonths(value, DEFAULT_INACTIVE_MONTHS);
}

function isNewAccount(createdAt, months = DEFAULT_NEW_ACCOUNT_MONTHS) {
  const ts = parseAccountCreatedAt(createdAt);
  if (ts == null) return false;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return ts > cutoff.getTime();
}

function isInactiveAccount(lastActiveMs, months = DEFAULT_INACTIVE_MONTHS) {
  if (lastActiveMs == null) return false;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return lastActiveMs < cutoff.getTime();
}

function formatLastActiveField(ms) {
  if (!ms) return '';
  return new Date(ms).toISOString();
}

async function loadActivityCache() {
  const res = await chrome.storage.local.get(XC_ACTIVITY_CACHE_KEY);
  return res[XC_ACTIVITY_CACHE_KEY] || {};
}

async function saveActivityCache(cache) {
  await chrome.storage.local.set({ [XC_ACTIVITY_CACHE_KEY]: cache });
}

async function enrichLastActiveForUsers(tabId, users, onProgress) {
  const cache = await loadActivityCache();
  const now = Date.now();
  const enriched = users.map((user) => ({ ...user }));

  const needsLookup = [];
  for (const user of enriched) {
    const key = (user.username || '').toLowerCase();
    const entry = cache[key];
    if (entry?.last_active_ms && now - (entry.fetched_at || 0) < XC_ACTIVITY_CACHE_TTL_MS) {
      user.last_active_ms = entry.last_active_ms;
      continue;
    }
    needsLookup.push(user);
  }

  let processed = enriched.length - needsLookup.length;
  const total = enriched.length;
  if (onProgress) onProgress({ processed, total });

  if (tabId) {
    await xcRestPrepareSession(tabId);
  }

  for (let i = 0; i < needsLookup.length; i += ENRICH_BATCH_SIZE) {
    if (activeEnrich?.cancelled) break;

    const batch = needsLookup.slice(i, i + ENRICH_BATCH_SIZE);
    const handles = batch
      .map((user) => String(user.username || '').replace(/^@+/, '').trim())
      .filter(Boolean);

    try {
      const res = await xcRestUsersLookupBatch(handles, {
        tabId,
        preferTabContext: true,
        tabRetries: 2,
        requireCaptured: true
      });

      if (res?.ok && res.lastActive) {
        for (const [sn, ts] of Object.entries(res.lastActive)) {
          cache[sn] = { last_active_ms: ts, fetched_at: now };
        }
      }
    } catch (error) {
      console.warn('[X Cleaner] REST users/lookup batch failed', error);
      if (error.status === 429) {
        if (onProgress) onProgress({ processed, total, waiting: true });
        await sleep(XC_REST_RATE_LIMIT_BACKOFF_MS);
        if (activeEnrich?.cancelled) break;
        i -= ENRICH_BATCH_SIZE;
        continue;
      }
    }

    for (const user of batch) {
      const key = (user.username || '').toLowerCase();
      const entry = cache[key];
      user.last_active_ms = entry?.last_active_ms ?? null;
    }

    processed = Math.min(total, processed + batch.length);
    if (onProgress) onProgress({ processed, total, waiting: false });

    if (i + ENRICH_BATCH_SIZE < needsLookup.length) {
      if (onProgress) onProgress({ processed, total, waiting: true });
      await sleep(ENRICH_BATCH_DELAY_MS);
      if (activeEnrich?.cancelled) break;
    }
  }

  await saveActivityCache(cache);

  for (const user of enriched) {
    if (user.last_active_ms != null) continue;
    const key = (user.username || '').toLowerCase();
    const entry = cache[key];
    user.last_active_ms = entry?.last_active_ms ?? null;
  }

  return enriched;
}

function applyFollowingFilters(source, options = {}) {
  const {
    removeBlue = false,
    removeNew = false,
    newAccountMonths = DEFAULT_NEW_ACCOUNT_MONTHS
  } = options;
  if (!removeBlue && !removeNew) return source.slice();

  return source.filter((user) => {
    if (removeBlue && user.is_blue) return false;
    if (removeNew && isNewAccount(user.created_at, newAccountMonths)) return false;
    return true;
  });
}

function snapshotListRaw(type = listType) {
  setCurRaw(curList(type).slice(), type);
  jobState.rawCount = curRaw(type).length;
  schedulePersist(true, type);
}

function serializeJobStateForPersist(type = listType) {
  return {
    username: jobState.username,
    listType: type,
    totalFollowing: jobState.totalFollowing,
    totalFollowers: jobState.totalFollowers,
    count: curList(type).length,
    rawCount: curRaw(type).length || curList(type).length,
    isScraping: false,
    isEnriching: false,
    reason: jobState.reason,
    method: jobState.method,
    filterRemoved: jobState.filterRemoved ?? 0,
    status: jobState.status || null
  };
}

async function persistListState(type = listType) {
  const cfg = listCfg(type);
  if (!curList(type).length && !curRaw(type).length) {
    await chrome.storage.local.remove(cfg.persistKey);
    return;
  }

  const payload = {
    version: XC_PERSIST_VERSION,
    listType: type,
    savedAt: new Date().toISOString(),
    accountList: curList(type),
    accountListRaw: curRaw(type).length ? curRaw(type) : curList(type).slice(),
    jobState: serializeJobStateForPersist(type)
  };

  try {
    await chrome.storage.local.set({ [cfg.persistKey]: payload });
    lastPersistedCounts[type] = curList(type).length;
    if (type === listType) {
      jobState.savedAt = payload.savedAt;
    }
  } catch (error) {
    console.warn(`[X Cleaner] persist failed (${type})`, error);
  }
}

function schedulePersist(force = false, type = listType) {
  if (!curList(type).length && !curRaw(type).length) return;

  if (force) {
    clearTimeout(persistDebounceTimers[type]);
    persistDebounceTimers[type] = null;
    persistListState(type).catch(() => {});
    return;
  }

  if (jobState.isScraping && type === listType) {
    const delta = curList(type).length - lastPersistedCounts[type];
    if (delta < XC_PERSIST_COLLECT_INTERVAL) {
      clearTimeout(persistDebounceTimers[type]);
      persistDebounceTimers[type] = setTimeout(() => {
        persistListState(type).catch(() => {});
      }, XC_PERSIST_DEBOUNCE_MS);
      return;
    }
  }

  clearTimeout(persistDebounceTimers[type]);
  persistDebounceTimers[type] = setTimeout(() => {
    persistListState(type).catch(() => {});
  }, 500);
}

async function clearListPersist(type = listType) {
  const cfg = listCfg(type);
  clearTimeout(persistDebounceTimers[type]);
  persistDebounceTimers[type] = null;
  lastPersistedCounts[type] = 0;
  restoredTypes[type] = false;
  if (type === listType) {
    jobState.savedAt = null;
  }
  await chrome.storage.local.remove(cfg.persistKey);
}

async function purgePersistForOtherUsers(activeUsername) {
  const activeUser = (activeUsername || '').toLowerCase().replace(/^@+/, '');
  if (!activeUser) return;

  for (const type of LIST_TYPES) {
    const cfg = listCfg(type);
    const res = await chrome.storage.local.get(cfg.persistKey);
    const data = res[cfg.persistKey];
    const savedUser = (data?.jobState?.username || '').toLowerCase().replace(/^@+/, '');
    if (savedUser && savedUser !== activeUser) {
      await chrome.storage.local.remove(cfg.persistKey);
      console.log(`[X Cleaner] Removed cached ${cfg.label.toLowerCase()} for @${savedUser} (active @${activeUser})`);
    }
  }
}

function clearInMemoryLists() {
  for (const type of LIST_TYPES) {
    setCurList([], type);
    setCurRaw([], type);
    restoredTypes[type] = false;
    clearTimeout(persistDebounceTimers[type]);
    persistDebounceTimers[type] = null;
    lastPersistedCounts[type] = 0;
  }
}

async function applyAccountSwitch(detected) {
  clearInMemoryLists();
  await purgePersistForOtherUsers(detected);
  jobState = {
    ...jobState,
    username: detected,
    count: 0,
    rawCount: 0,
    totalFollowing: null,
    totalFollowers: null,
    savedAt: null,
    reason: null,
    filterRemoved: 0,
    status: null
  };
  await restoreAllListState();
}

async function alignAccountForJob(detected) {
  const next = String(detected || '').replace(/^@+/, '');
  if (!next) return;

  const prev = (jobState.username || '').toLowerCase();
  const nextLower = next.toLowerCase();

  if (prev && prev !== nextLower) {
    await applyAccountSwitch(next);
    return;
  }

  jobState.username = next;
  await purgePersistForOtherUsers(next);
  if (!curList('following').length && !curList('followers').length) {
    await restoreAllListState();
  }
}

async function restoreListState(type, options = {}) {
  if (curList(type).length || activeFetch?.running) return false;

  const cfg = listCfg(type);

  try {
    const res = await chrome.storage.local.get(cfg.persistKey);
    const data = res[cfg.persistKey];
    const accounts = data?.accountList || data?.followingList;
    if (!accounts?.length) return false;

    const activeUser = (options.username || jobState.username || '').toLowerCase().replace(/^@+/, '');
    const savedUser = (data.jobState?.username || '').toLowerCase().replace(/^@+/, '');
    if (activeUser && savedUser && activeUser !== savedUser) {
      await chrome.storage.local.remove(cfg.persistKey);
      return false;
    }
    if (!jobState.username && savedUser) {
      jobState.username = data.jobState?.username || savedUser;
    }

    setCurList(accounts, type);
    const raw = data.accountListRaw || data.followingListRaw;
    setCurRaw(raw?.length ? raw : accounts.slice(), type);

    if (type === listType) {
      jobState = {
        ...jobState,
        ...data.jobState,
        listType: type,
        isScraping: false,
        isEnriching: false,
        count: curList(type).length,
        rawCount: curRaw(type).length
      };
      jobState.savedAt = data.savedAt || null;
    }

    restoredTypes[type] = true;

    const tab = await findLastActiveXTab();
    if (tab?.id) jobTabId = tab.id;

    console.log(
      `[X Cleaner] Restored ${curList(type).length.toLocaleString()} ${cfg.label.toLowerCase()} from storage`
    );
    return true;
  } catch (error) {
    console.warn(`[X Cleaner] restore failed (${type})`, error);
    return false;
  }
}

async function restoreAllListState() {
  const pref = await chrome.storage.local.get(XC_LIST_TYPE_PREF_KEY);
  if (pref[XC_LIST_TYPE_PREF_KEY] && LIST_CONFIG[pref[XC_LIST_TYPE_PREF_KEY]]) {
    listType = pref[XC_LIST_TYPE_PREF_KEY];
    jobState.listType = listType;
  }

  let restored = false;
  for (const type of LIST_TYPES) {
    if (await restoreListState(type)) {
      restored = true;
    }
  }
  return restored;
}

function ensureRestored() {
  if (curList().length || activeFetch?.running) {
    return Promise.resolve(restoredFromStorage());
  }
  if (!restorePromise) {
    restorePromise = restoreAllListState().finally(() => {
      restorePromise = null;
    });
  }
  return restorePromise;
}

async function setListType(nextType) {
  if (!LIST_CONFIG[nextType]) {
    return { ok: false, error: 'Invalid list type.' };
  }

  await ensureRestored();
  listType = nextType;
  jobState.listType = nextType;
  jobState.count = curList().length;
  jobState.rawCount = curRaw().length || curList().length;

  const cfg = listCfg();
  const savedRes = await chrome.storage.local.get(cfg.persistKey);
  const saved = savedRes[cfg.persistKey];
  if (saved?.savedAt) {
    jobState.savedAt = saved.savedAt;
    if (saved.jobState) {
      const savedUser = (saved.jobState.username || '').toLowerCase();
      const activeUser = (jobState.username || '').toLowerCase();
      if (!activeUser || !savedUser || savedUser === activeUser) {
        jobState.reason = saved.jobState.reason ?? jobState.reason;
        jobState.filterRemoved = saved.jobState.filterRemoved ?? 0;
        jobState.totalFollowing = saved.jobState.totalFollowing ?? jobState.totalFollowing;
        jobState.totalFollowers = saved.jobState.totalFollowers ?? jobState.totalFollowers;
        jobState.username = saved.jobState.username ?? jobState.username;
      }
    }
  } else {
    jobState.savedAt = null;
  }

  await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: nextType });
  notifyProgress();
  return getStatus();
}

function usersForMutuals(type) {
  const bucket = listStore[type];
  return bucket.raw.length ? bucket.raw : bucket.list;
}

function countMutualsFromRelationships(type, users) {
  if (!users.length) return null;

  let withData = 0;
  let mutualCount = 0;

  for (const user of users) {
    const flag = type === 'followers' ? user.you_follow : user.follows_you;
    if (typeof flag !== 'boolean') continue;
    withData += 1;
    if (flag) mutualCount += 1;
  }

  if (withData === 0) return null;

  return {
    mutualCount,
    withData,
    total: users.length,
    source: type
  };
}

function computeMutuals() {
  const followingUsers = usersForMutuals('following');
  const followersUsers = usersForMutuals('followers');
  const followingCount = followingUsers.length;
  const followersCount = followersUsers.length;
  const hasBoth = followingCount > 0 && followersCount > 0;

  const tryOrder = listType === 'followers'
    ? ['followers', 'following']
    : ['following', 'followers'];

  for (const type of tryOrder) {
    const users = type === 'followers' ? followersUsers : followingUsers;
    const rel = countMutualsFromRelationships(type, users);
    if (rel) {
      return {
        followingCount,
        followersCount,
        mutualCount: rel.mutualCount,
        hasBoth,
        hasRelationshipData: true,
        method: 'relationship',
        source: rel.source,
        relationshipCoverage: rel.withData,
        relationshipTotal: rel.total
      };
    }
  }

  const followingSet = new Set(
    followingUsers.map((user) => (user.username || '').toLowerCase()).filter(Boolean)
  );
  const followersSet = new Set(
    followersUsers.map((user) => (user.username || '').toLowerCase()).filter(Boolean)
  );

  let mutualCount = 0;
  for (const name of followingSet) {
    if (followersSet.has(name)) mutualCount += 1;
  }

  return {
    followingCount: followingSet.size,
    followersCount: followersSet.size,
    mutualCount,
    hasBoth,
    hasRelationshipData: false,
    method: hasBoth ? 'intersection' : null,
    source: hasBoth ? 'both' : null,
    relationshipCoverage: 0,
    relationshipTotal: 0
  };
}

async function ensureJobTabId() {
  if (jobTabId) return jobTabId;
  const tab = await findLastActiveXTab();
  if (tab?.id) {
    jobTabId = tab.id;
    return jobTabId;
  }
  return null;
}

function formatCsvBool(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return '';
}

function buildCsv(users) {
  const header =
    'username,display_name,friends_count,followers_count,tweet_count,created_at,is_blue,default_avatar,you_follow,follows_you,last_tweet_at\n';
  const rows = users.map((user) =>
    [
      user.username,
      user.display_name ?? user.name ?? '',
      user.friends_count ?? '',
      user.followers_count ?? '',
      user.tweet_count ?? '',
      user.created_at ?? '',
      user.is_blue ?? false,
      user.default_avatar ?? false,
      formatCsvBool(user.you_follow),
      formatCsvBool(user.follows_you),
      formatLastActiveField(user.last_active_ms)
    ]
      .map(escapeCsvField)
      .join(',')
  ).join('\n');
  return header + rows + '\n';
}

async function sendHudMessage(tabId, payload, retries = 1) {
  if (!tabId) return false;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, payload);
      return true;
    } catch (error) {
      if (attempt + 1 >= retries) break;
      await sleep(400);
    }
  }

  return false;
}

async function ensureSnifferInstalled(tabId) {
  const installed = await executeOnTab(tabId, () => !!window.__xcSnifferInstalled);
  if (installed) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['xc-fetch-sniffer.js']
    });
    return true;
  } catch (error) {
    return false;
  }
}

function formatDebugStatusLine(state = {}) {
  const ts = new Date(state.timestamp || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const tags = [];
  if (state.method) tags.push(state.method);
  if (state.reason) tags.push(state.reason);
  if (state.fetchMode) tags.push(`mode:${state.fetchMode}`);
  if (state.restPage != null) tags.push(`restP${state.restPage}`);
  if (state.passes != null) tags.push(`pass${state.passes}`);
  else if (state.pages != null) tags.push(`p${state.pages}`);
  if (state.parsedLastPage != null) tags.push(`parsed${state.parsedLastPage}`);
  if (state.addedLastPage != null) tags.push(`+${state.addedLastPage}`);
  if (state.dupLastPage != null && state.dupLastPage > 0) tags.push(`dup${state.dupLastPage}`);
  let msg = String(
    (state.error && (state.reason === 'error' || state.reason === 'rest-empty'))
      ? state.error
      : (state.status || state.error || '')
  ).trim();
  const attemptSummary = state.attemptSummary || state.restAttemptSummary;
  if (attemptSummary && !msg.includes(attemptSummary)) {
    msg = msg ? `${msg} | attempts: ${attemptSummary}` : `attempts: ${attemptSummary}`;
  }
  const tagPrefix = tags.length ? `${tags.join(' ')}: ` : '';
  const line = `${tagPrefix}${msg || '(tick)'}`.trim();
  return line ? `[${ts}] ${line}` : null;
}

function resetDebugStatusLog(initialEntry = null) {
  if (!XC_DEBUG_STATUS_LOG) {
    jobState.debugStatusLog = [];
    return;
  }
  jobState.debugStatusLog = [];
  if (initialEntry) appendDebugStatusLog(initialEntry);
}

function appendDebugStatusLogStart(entry = {}) {
  if (!XC_DEBUG_STATUS_LOG) return;
  if (!Array.isArray(jobState.debugStatusLog) || !jobState.debugStatusLog.length) {
    resetDebugStatusLog(entry);
    return;
  }
  appendDebugStatusLog(entry);
}

function shouldAppendDebugStatusLog(entry = {}) {
  if (!XC_DEBUG_STATUS_LOG) return false;
  if (entry.reason === 'complete' || entry.reason === 'stopped' || entry.reason === 'start') return true;
  if (entry.reason === 'rest-empty' || entry.reason === 'error') return true;
  if (entry.error) return true;
  if (entry.attemptSummary || entry.restAttemptSummary) return true;
  const status = String(entry.status || '');
  if (/REST|GraphQL worker|fallback|sniffer|verify_credentials|attempts:|failed|error|switching|GraphQL plan|Short by|tail|DONE|dup|empty/i.test(status)) {
    return true;
  }
  if (entry.method === 'rest-v1.1' || entry.method === 'graphql-worker' || entry.method === 'graphql') {
    return true;
  }
  if (entry.method && entry.method !== 'native-sniffer') return true;
  if (entry.addedLastPage > 0) return true;
  if (entry.parsedLastPage > 0 && !entry.addedLastPage) return true;
  if (entry.reason === 'collecting' && entry.method === 'native-sniffer') return false;
  return !!status;
}

function persistDebugStatusLog() {
  if (!XC_DEBUG_STATUS_LOG) return;
  try {
    chrome.storage.local.set({
      [XC_DEBUG_STATUS_LOG_STORAGE_KEY]: jobState.debugStatusLog || []
    });
  } catch (error) {}
}

function appendDebugStatusLog(entry = {}) {
  if (!shouldAppendDebugStatusLog(entry)) return;
  const line = formatDebugStatusLine(entry);
  if (!line) return;
  if (!Array.isArray(jobState.debugStatusLog)) jobState.debugStatusLog = [];
  jobState.debugStatusLog.push(line);
  if (jobState.debugStatusLog.length > XC_DEBUG_STATUS_LOG_MAX_LINES) {
    jobState.debugStatusLog = jobState.debugStatusLog.slice(-XC_DEBUG_STATUS_LOG_MAX_LINES);
  }
  persistDebugStatusLog();
}

function debugStatusPayload() {
  return {
    debugStatusLogEnabled: XC_DEBUG_STATUS_LOG,
    debugStatusLog: XC_DEBUG_STATUS_LOG ? (jobState.debugStatusLog || []) : [],
    debugStatusLogPersisted: XC_DEBUG_STATUS_LOG
  };
}

function notifyProgress(extra = {}) {
  jobState = {
    ...jobState,
    listType,
    count: curList().length,
    rawCount: curRaw().length || curList().length,
    ...extra
  };

  appendDebugStatusLog({
    timestamp: Date.now(),
    ...jobState,
    ...extra
  });

  const payload = {
    type: 'scrapeStatus',
    ok: true,
    ...jobState,
    totalList: totalForType(),
    fetchTarget: effectiveFetchTarget(totalForType()),
    storedCounts: {
      following: listStore.following.list.length,
      followers: listStore.followers.list.length
    },
    mutuals: computeMutuals(),
    ...subscriptionPayload(),
    ...debugStatusPayload()
  };

  chrome.runtime.sendMessage(payload).catch(() => {});

  if (jobTabId) {
    sendHudMessage(jobTabId, { action: 'updateHud', ...jobState, ...debugStatusPayload() }).catch(() => {});
  }

  schedulePersist();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== jobTabId || changeInfo.status !== 'complete') return;
  if (!jobState.username && !jobState.isScraping) return;

  ensureSnifferInstalled(tabId)
    .then(() => sendHudMessage(tabId, {
      action: 'updateHud',
      ...jobState,
      count: curList().length,
      ...debugStatusPayload()
    }, 12))
    .catch(() => {});
});

async function findLastActiveXTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://twitter.com/*']
  });

  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

async function findFocusedXTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id && isXTabUrl(activeTab.url)) {
    return activeTab;
  }
  return findLastActiveXTab();
}

async function syncActiveAccountFromTab(options = {}) {
  const {
    refreshSub = true,
    forceSubRefresh = false,
    tabId: preferredTabId,
    username: explicitUsername
  } = options;

  if (jobState.isScraping || activeFetch?.running) {
    await hydrateSubscriptionFromStorage(jobState.username);
    return { ok: true, switched: false, username: jobState.username, tabId: jobTabId };
  }

  let tab = null;
  if (preferredTabId) {
    try {
      tab = await chrome.tabs.get(preferredTabId);
    } catch (error) {
      tab = null;
    }
  }
  if (!tab?.id) {
    tab = await findFocusedXTab();
  }
  if (!tab?.id) {
    return {
      ok: false,
      switched: false,
      username: jobState.username,
      tabId: null,
      error: 'No X tab found. Open x.com in a browser tab first.'
    };
  }

  jobTabId = tab.id;

  let detected = explicitUsername ? String(explicitUsername).replace(/^@+/, '') : null;
  if (!detected) {
    try {
      detected = await detectHandle(tab.id);
    } catch (error) {
      console.warn('[X Cleaner] focused tab handle detect failed', error);
    }
  }

  if (!detected) {
    return { ok: true, switched: false, username: jobState.username, tabId: jobTabId };
  }

  const prevUsername = (jobState.username || '').toLowerCase();
  const nextUsername = detected.toLowerCase();
  const switched = !!prevUsername && prevUsername !== nextUsername;

  if (switched) {
    await applyAccountSwitch(detected);
  } else if (!jobState.username) {
    jobState.username = detected;
    await purgePersistForOtherUsers(detected);
    await restoreAllListState();
  } else {
    jobState.username = detected;
    await purgePersistForOtherUsers(detected);
  }

  if (refreshSub) {
    await refreshSubscription(detected, forceSubRefresh);
  }

  return { ok: true, switched, username: detected, tabId: jobTabId };
}

async function detectHandle(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const fromHref = (href) => {
        const match = (href || '').match(/\/([a-zA-Z0-9_]{1,15})(?:[/?]|$)/);
        return match ? match[1] : null;
      };

      const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (profileLink?.href) {
        const handle = fromHref(profileLink.href);
        if (handle) return handle;
      }

      const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (switcher) {
        const text = (switcher.innerText || switcher.textContent || '').trim();
        let match = text.match(/@([a-zA-Z0-9_]{1,15})/);
        if (match) return match[1];

        for (const span of switcher.querySelectorAll('span')) {
          const value = (span.textContent || '').trim();
          match = value.match(/^@?([a-zA-Z0-9_]{1,15})$/);
          if (match) return match[1];
        }
      }

      const pathMatch = location.pathname.match(/^\/([a-zA-Z0-9_]{1,15})(?:\/|$)/);
      if (pathMatch) {
        const reserved = new Set([
          'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search'
        ]);
        if (!reserved.has(pathMatch[1])) return pathMatch[1];
      }

      return null;
    }
  });

  return results?.[0]?.result || null;
}

function remainingListCount(type, totalList, fetchTarget) {
  const count = curList(type).length;
  if (fetchTarget != null && count < fetchTarget) return fetchTarget - count;
  if (totalList != null && count < totalList) return totalList - count;
  return 0;
}

const NATIVE_PAGE_SIZE = {
  following: 50,
  followers: 48
};

function nativePageSize(type = listType) {
  return NATIVE_PAGE_SIZE[type] || 50;
}

// GraphQL `count` — Following 20/page; Followers 100/page (full list via Followers op).
function graphqlListPageCount(type = listType) {
  return type === 'followers' ? 100 : 20;
}

function graphqlTailPageCount(type = listType) {
  return graphqlListPageCount(type);
}

// When the last page is a small tail, request one account per call (avoids oversize partial-page cursor loss).
const GRAPHQL_TAIL_SINGLE_MAX = 20;

function planGraphqlListFetch(type, totalList, collectedCount = 0) {
  const pageSize = graphqlListPageCount(type);
  if (totalList == null || totalList <= 0) {
    return {
      pageSize,
      remaining: null,
      fullPages: null,
      lastPageAccounts: null,
      totalPages: null,
      tailSingleAccount: false
    };
  }

  const collected = Math.max(0, collectedCount || 0);
  const remaining = Math.max(0, totalList - collected);
  const fullPages = Math.floor(remaining / pageSize);
  const lastPageAccounts = remaining % pageSize;
  const totalPages = fullPages + (lastPageAccounts > 0 ? 1 : 0);
  // Followers: 1/request on small tail. Following: one sized request (native batches are ~50).
  const tailSingleAccount = type === 'followers'
    && totalPages === 1
    && remaining > 0
    && remaining <= GRAPHQL_TAIL_SINGLE_MAX;

  return {
    pageSize,
    remaining,
    fullPages,
    lastPageAccounts: lastPageAccounts || (remaining > 0 && remaining <= pageSize ? remaining : 0),
    totalPages,
    tailSingleAccount
  };
}

function graphqlRequestCount(type, totalList, collectedCount = 0) {
  const pageSize = graphqlListPageCount(type);
  const plan = planGraphqlListFetch(type, totalList, collectedCount);
  if (plan.remaining == null || plan.remaining <= 0) return pageSize;
  if (plan.fullPages > 0) return pageSize;
  if (plan.tailSingleAccount) return 1;
  return Math.min(plan.remaining + 2, pageSize);
}

function graphqlPageStatusLabel(type, totalList, collectedCount, pageIndex, requestCount) {
  const plan = planGraphqlListFetch(type, totalList, collectedCount);
  if (plan.totalPages == null) return `page ${pageIndex}`;
  if (plan.tailSingleAccount) {
    return `tail ${plan.remaining.toLocaleString()} left, 1/request (#${pageIndex})`;
  }
  const pageNum = Math.min(pageIndex, plan.totalPages);
  return `page ${pageNum}/${plan.totalPages}, count=${requestCount}`;
}

const GRAPHQL_PAGE_DELAY_MS = {
  followers: 1100,
  following: 600
};

// Profile totals are often rounded — a "full page" count may still have another page.
function nativeListLikelyHasMore(count, totalList, type = listType) {
  if (count === 0) return false;
  if (totalList != null && count < totalList) return true;
  const pageSize = nativePageSize(type);
  if (count >= pageSize && count % pageSize === 0) return true;
  return false;
}

function nativeLikelyAtTail(type, collected, totalList) {
  if (totalList == null || collected <= 0) return false;
  const remaining = totalList - collected;
  if (remaining <= 0) return true;
  const pageSize = nativePageSize(type);
  return remaining <= pageSize && collected % pageSize !== 0;
}

function nativeStalePassLimit(type, totalList, collected) {
  if (nativeLikelyAtTail(type, collected, totalList)) return 3;
  const remaining = totalList != null ? totalList - collected : null;
  if (remaining != null && remaining <= nativePageSize(type)) return 4;
  if (totalList != null && collected < totalList) return 6;
  return 5;
}

function nativeListenTimeoutMs(type, passes, remaining) {
  if (passes === 0) {
    return type === 'followers' ? 20000 : 15000;
  }
  if (remaining > 0 && remaining <= 100) return 2000;
  return type === 'followers' ? 6000 : 4000;
}

function effectiveTotalList(type, profile) {
  const cfg = listCfg(type);
  const fromProfile = profile?.[cfg.totalKey];
  if (fromProfile != null) return fromProfile;
  return jobState[cfg.totalKey] ?? null;
}

async function tabIsOnListPage(tabId, username, listPath) {
  const handle = String(username || '').replace(/^@+/, '').toLowerCase();
  if (!handle) return false;

  const pathname = await executeOnTab(tabId, () => (location.pathname || '').toLowerCase());
  if (!pathname) return false;

  const segments = listPath === 'followers'
    ? ['followers']
    : [listPath];

  return segments.some((segment) => {
    const base = `/${handle}/${segment}`;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

async function resolveListPagePath(tabId, screenName, listPath) {
  const basePath = listPath || 'following';
  // Always use /followers (all accounts), not /verified_followers subset tab.
  if (basePath === 'followers') return 'followers';
  const effective = await readEffectiveListPathFromTab(tabId, screenName, basePath);
  return effective || basePath;
}

async function resolveFollowersWorkerOpName(_tabId, opName) {
  if (opName !== 'Followers') return opName;
  return 'Followers';
}

async function followersWorkerOpCandidates(_tabId) {
  return ['Followers'];
}

async function recoverShortfallViaWorkerGraphql(tabId, profile, type, seen, totalList) {
  const gap = totalList != null ? totalList - curList(type).length : null;
  if (gap == null || gap <= 0 || gap > 100) return 0;

  const cfg = listCfg(type);
  const session = await getXSessionCookies();
  if (!session.ct0 || !profile.userId) return 0;

  let catalog = await prefetchQueryCatalog(true);
  catalog = await resolveCatalogWithTabQueryIds(tabId, catalog);
  const opNames = type === 'followers'
    ? await followersWorkerOpCandidates(tabId)
    : [cfg.opName];
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;
  let totalAdded = 0;

  appendDebugStatusLog({
    status: `Worker recovery: ${gap.toLocaleString()} short — sweeping ${opNames.join(' → ')}...`,
    reason: 'collecting',
    method: 'graphql-worker'
  });
  notifyProgress({
    reason: 'collecting',
    method: 'graphql-worker',
    status: `Short by ${gap.toLocaleString()} — worker GraphQL sweep...`
  });

  for (const opName of opNames) {
    if (!listFetchNeedsMore(type, totalList)) break;

    let cursor = null;
    let pages = 0;
    let stalePages = 0;
    const maxPages = Math.ceil((totalList || 500) / graphqlListPageCount(type)) + 8;

    while (!activeFetch?.cancelled && pages < maxPages && listFetchNeedsMore(type, totalList)) {
      const requestCount = graphqlRequestCount(type, totalList, curList(type).length);
      const res = await fetchListPageWorker({
        opName,
        userId: profile.userId,
        screenName: profile.username,
        cursor,
        count: requestCount,
        catalog,
        ct0: session.ct0,
        listPath: cfg.path
      });

      if (!res?.ok) {
        appendDebugStatusLog({
          status: `Worker recovery ${opName} failed: ${res?.error || res?.status || 'unknown'}`,
          method: 'graphql-worker',
          reason: 'collecting'
        });
        if (tabId && pages === 0) {
          const tabRes = await fetchListPageFromTab(tabId, {
            opName,
            userId: profile.userId,
            screenName: profile.username,
            cursor,
            count: requestCount,
            catalog,
            listPath: cfg.path,
            capturedTemplate: await readCapturedListTemplateFromTab(tabId, opName)
          });
          if (tabRes?.ok) {
            const parsedCount = (tabRes.users || []).length;
            const added = addNativeUsers({ users: tabRes.users || [] }, seen, profile.username, type);
            totalAdded += added;
            trimListToFetchLimit(type);
            pages += 1;
            notifyProgress({
              reason: 'collecting',
              method: 'graphql-worker',
              pages,
              addedLastPage: added,
              status: `Recovery tab ${opName} p${pages}: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added}, parsed ${parsedCount})`
            });
            if (!listFetchNeedsMore(type, totalList)) return totalAdded;
            const nextCursor = tabRes.nextCursor || null;
            if (nextCursor && nextCursor !== cursor) {
              cursor = nextCursor;
              stalePages = 0;
              continue;
            }
          }
        }
        break;
      }

      const parsedCount = (res.users || []).length;
      const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
      totalAdded += added;
      trimListToFetchLimit(type);
      pages += 1;

      notifyProgress({
        reason: 'collecting',
        method: 'graphql-worker',
        pages,
        addedLastPage: added,
        status: `Recovery ${opName} p${pages}: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added}, parsed ${parsedCount})`
      });

      if (!listFetchNeedsMore(type, totalList)) return totalAdded;

      const nextCursor = res.nextCursor || null;
      if (!nextCursor || nextCursor === cursor) {
        stalePages += 1;
        if (stalePages >= 2) break;
        continue;
      }

      stalePages = 0;
      cursor = nextCursor;
      await sleep(requestCount === 1 ? Math.min(pageDelayMs, 450) : pageDelayMs);
    }

    if (!listFetchNeedsMore(type, totalList) || totalAdded > 0) break;
  }

  return totalAdded;
}

async function warmRestListPageContext(tabId, profile, type = listType) {
  const cfg = listCfg(type);
  const username = profile?.username;
  if (!tabId || !username) return false;

  const listUrl = `https://x.com/${String(username).replace(/^@+/, '')}/${cfg.path}`;
  const fullSettleMs = type === 'followers' ? XC_FOLLOWERS_NAV_SETTLE_MS : XC_LIST_NAV_SETTLE_MS;
  const scrollMs = type === 'followers' ? 2500 : 1800;

  await ensureSnifferInstalled(tabId);

  const pathname = await executeOnTab(tabId, () => (location.pathname || '').toLowerCase());
  const onVerifiedFollowers = !!(pathname && pathname.includes('verified_followers'));
  const alreadyOnListPage = !onVerifiedFollowers && await tabIsOnListPage(tabId, username, cfg.path);

  if (alreadyOnListPage) {
    appendDebugStatusLog({
      status: `REST warmup: already on ${cfg.label.toLowerCase()} page — sniffer + session...`,
      method: 'rest-v1.1'
    });
    notifyProgress({
      reason: 'collecting',
      method: 'rest-v1.1',
      status: `Using open ${cfg.label.toLowerCase()} tab for REST session...`
    });
    await ensureSnifferInstalled(tabId);
    if (XC_PRE_LIST_FETCH_SETTLE_MS > 0) {
      await sleep(XC_PRE_LIST_FETCH_SETTLE_MS);
    }
  } else {
    appendDebugStatusLog({
      status: `REST warmup: opening ${cfg.label.toLowerCase()} page for session + sniffer...`,
      method: 'rest-v1.1'
    });
    notifyProgress({
      reason: 'collecting',
      method: 'rest-v1.1',
      status: `Opening ${cfg.label.toLowerCase()} page for REST session...`
    });
    await chrome.tabs.update(tabId, { url: listUrl, active: true });
    await waitAfterTabNavigation(tabId, fullSettleMs);
    await ensureSnifferInstalled(tabId);

    const afterPath = await executeOnTab(tabId, () => (location.pathname || '').toLowerCase());
    if (afterPath && afterPath.includes('verified_followers')) {
      await chrome.tabs.update(tabId, { url: listUrl, active: true });
      await waitAfterTabNavigation(tabId, fullSettleMs);
      await ensureSnifferInstalled(tabId);
    }
  }

  try {
    await executeOnTab(tabId, () => {
      window.scrollTo(0, Math.max(document.body.scrollHeight, 1200));
    });
    await sleep(alreadyOnListPage ? Math.min(scrollMs, 1200) : scrollMs);
  } catch (error) {}

  await xcRestPrepareSession(tabId);
  return true;
}

async function recoverShortfallViaRestSnifferCursor(tabId, profile, type, seen, totalList) {
  const cfg = listCfg(type);
  const gap = totalList != null ? totalList - curList(type).length : null;
  if (!tabId || !gap || gap <= 0) return 0;

  const cursor = await readNativeListCursorFromTab(tabId, cfg.opName);
  if (!cursor || cursor === '0') return 0;

  try {
    const page = await xcRestFetchListPage(profile.username, type, cursor, {
      tabId,
      userId: profile.userId,
      preferTabContext: true,
      pageSize: Math.min(200, Math.max(gap + 5, 20)),
      tabRetries: 2
    });
    const added = addNativeUsers({ users: page.users || [] }, seen, profile.username, type);
    trimListToFetchLimit(type);
    if (added > 0) {
      notifyProgress({
        reason: 'collecting',
        method: 'rest-v1.1',
        addedLastPage: added,
        status: `REST sniffer cursor: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added})`
      });
    }
    return added;
  } catch (error) {
    return 0;
  }
}

async function recoverShortfallViaRest(tabId, profile, type, seen, totalList) {
  const gap = totalList != null ? totalList - curList(type).length : null;
  if (gap == null || gap <= 0 || gap > 100 || !profile?.username) return 0;

  appendDebugStatusLog({
    status: `REST tail recovery: ${gap.toLocaleString()} short — multi-strategy REST...`,
    method: 'rest-v1.1',
    reason: 'collecting'
  });
  notifyProgress({
    reason: 'collecting',
    method: 'rest-v1.1',
    status: `Short by ${gap.toLocaleString()} — REST tail strategies...`
  });

  let snifferCursor = null;
  try {
    snifferCursor = await readNativeListCursorFromTab(tabId, listCfg(type).opName);
  } catch (error) {}

  const lastResult = {
    nextCursor: snifferCursor || '0',
    hasValidCursor: !!(snifferCursor && snifferCursor !== '0')
  };
  const requestOptions = {
    tabId,
    userId: profile.userId,
    preferTabContext: true,
    pageSize: totalList,
    tabRetries: 2
  };
  const allAttempts = [];

  try {
    const tail = await xcRestTryShortfallRecovery(
      profile.username,
      type,
      totalList,
      curList(type).length,
      lastResult,
      requestOptions,
      allAttempts
    );
    const recovery = tail?.recovery;
    if (recovery?.users?.length) {
      const added = addNativeUsers({ users: recovery.users }, seen, profile.username, type);
      trimListToFetchLimit(type);
      const attemptNote = xcRestFormatAttempts(recovery.attempts || allAttempts);
      appendDebugStatusLog({
        status: `REST tail ${tail.label || 'recovery'}: +${added} parsed ${recovery.users.length}${attemptNote ? ` (${attemptNote})` : ''}`,
        method: 'rest-v1.1',
        reason: 'collecting'
      });
      notifyProgress({
        reason: 'collecting',
        method: 'rest-v1.1',
        addedLastPage: added,
        status: `REST tail (${tail.label || 'recovery'}): ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added})`
      });
      return added;
    }
    if (allAttempts.length) {
      appendDebugStatusLog({
        status: `REST tail strategies empty — ${xcRestFormatAttempts(allAttempts)}`,
        method: 'rest-v1.1',
        reason: 'collecting'
      });
    }
  } catch (error) {
    appendDebugStatusLog({
      status: `REST tail recovery failed: ${error.message || error}`,
      method: 'rest-v1.1',
      reason: 'collecting'
    });
  }

  return 0;
}

async function recoverShortfallViaNativeScrollSniffer(tabId, profile, type, seen, totalList) {
  const cfg = listCfg(type);
  const gap = totalList != null ? totalList - curList(type).length : null;
  if (!tabId || !gap || gap <= 0 || gap > 100) return 0;

  let totalAdded = 0;
  let lastSeq = 0;
  const passes = gap <= 10 ? 4 : 2;
  const scrollDelayMs = type === 'followers' ? 2500 : 1800;
  const listenMs = type === 'followers' ? 7000 : 5000;

  appendDebugStatusLog({
    status: `Native scroll sniffer: ${gap.toLocaleString()} short — ${passes} scroll passes...`,
    method: 'native-sniffer',
    reason: 'collecting'
  });
  notifyProgress({
    reason: 'collecting',
    method: 'native-sniffer',
    status: `Scrolling ${cfg.label.toLowerCase()} to trigger native API (${gap.toLocaleString()} short)...`
  });

  for (let pass = 0; pass < passes && !activeFetch?.cancelled && listFetchNeedsMore(type, totalList); pass += 1) {
    await executeOnTab(tabId, injectedScrollListToLoad);
    await sleep(scrollDelayMs);

    const native = await waitForNativeList(tabId, cfg.opName, lastSeq, listenMs);
    if (native?.users?.length) {
      const added = addNativeUsers(native, seen, profile.username, type);
      totalAdded += added;
      trimListToFetchLimit(type);
      if (native.seq) lastSeq = Math.max(lastSeq, native.seq);
      if (added > 0) {
        notifyProgress({
          reason: 'collecting',
          method: 'native-sniffer',
          addedLastPage: added,
          status: `Scroll sniffer p${pass + 1}: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added})`
        });
      }
    }

    try {
      const drain = await readNativeListQueueDrainFromTab(tabId, cfg.opName);
      if (drain?.users?.length) {
        const drainAdded = addNativeUsers({ users: drain.users }, seen, profile.username, type);
        totalAdded += drainAdded;
        trimListToFetchLimit(type);
        if (drainAdded > 0) {
          notifyProgress({
            reason: 'collecting',
            method: 'native-sniffer',
            addedLastPage: drainAdded,
            status: `Scroll drain p${pass + 1}: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${drainAdded})`
          });
        }
      }
    } catch (error) {}

    if (!listFetchNeedsMore(type, totalList)) break;
  }

  return totalAdded;
}

async function recoverShortfallChain(tabId, profile, type, seen, totalList, options = {}) {
  const notes = [];
  let totalAdded = 0;

  const restAdded = await recoverShortfallViaRest(tabId, profile, type, seen, totalList);
  totalAdded += restAdded;
  if (restAdded > 0) notes.push(`rest:+${restAdded}`);

  if (listFetchNeedsMore(type, totalList)) {
    const gqlAdded = await recoverShortfallViaTabGraphql(
      tabId,
      profile,
      type,
      seen,
      totalList,
      options
    );
    totalAdded += gqlAdded;
    if (gqlAdded > 0) notes.push(`gql:+${gqlAdded}`);
  }

  if (listFetchNeedsMore(type, totalList)) {
    const workerAdded = await recoverShortfallViaWorkerGraphql(tabId, profile, type, seen, totalList);
    totalAdded += workerAdded;
    if (workerAdded > 0) notes.push(`worker:+${workerAdded}`);
  }

  return {
    totalAdded,
    summary: notes.length ? notes.join(', ') : ''
  };
}

async function recoverShortfallViaTabGraphql(tabId, profile, type, seen, totalList, options = {}) {
  const gap = totalList != null ? totalList - curList(type).length : null;
  if (gap == null || gap <= 0 || gap > 100 || !tabId) return 0;

  const cfg = listCfg(type);
  let totalAdded = 0;

  if (!options.skipWarmup) {
    await warmRestListPageContext(tabId, profile, type);
  }

  appendDebugStatusLog({
    status: `Tab recovery: ${gap.toLocaleString()} short — native sniffer + tab GraphQL...`,
    reason: 'collecting',
    method: 'graphql-tab'
  });
  notifyProgress({
    reason: 'collecting',
    method: 'rest-v1.1',
    status: `Short by ${gap.toLocaleString()} — tab GraphQL + sniffer tail...`
  });

  try {
    const nativeDrain = await readNativeListQueueDrainFromTab(tabId, cfg.opName);
    if (nativeDrain?.users?.length) {
      const added = addNativeUsers({ users: nativeDrain.users }, seen, profile.username, type);
      totalAdded += added;
      trimListToFetchLimit(type);
      if (added > 0) {
        notifyProgress({
          reason: 'collecting',
          method: 'rest-v1.1',
          addedLastPage: added,
          status: `Sniffer drain: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added})`
        });
      }
    }
  } catch (error) {}

  if (!listFetchNeedsMore(type, totalList)) return totalAdded;

  const scrollSnifferAdded = await recoverShortfallViaNativeScrollSniffer(tabId, profile, type, seen, totalList);
  totalAdded += scrollSnifferAdded;
  if (!listFetchNeedsMore(type, totalList)) return totalAdded;

  const domAdded = await fetchListTailDom(tabId, profile, type, seen, totalList);
  totalAdded += domAdded;
  if (!listFetchNeedsMore(type, totalList)) return totalAdded;

  const restCursorAdded = await recoverShortfallViaRestSnifferCursor(tabId, profile, type, seen, totalList);
  totalAdded += restCursorAdded;
  if (!listFetchNeedsMore(type, totalList)) return totalAdded;

  if (!profile.userId) {
    try {
      const catalog = await prefetchQueryCatalog(false);
      profile.userId = await resolveUserIdFromScreenName(profile.username, catalog, tabId);
    } catch (error) {}
  }
  if (!profile.userId) return totalAdded;

  const session = await getXSessionCookies();
  if (!session.ct0) return totalAdded;

  let catalog = await prefetchQueryCatalog(true);
  catalog = await resolveCatalogWithTabQueryIds(tabId, catalog);
  const opNames = type === 'followers' ? ['Followers'] : [cfg.opName];
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;
  const remainingGap = totalList != null ? totalList - curList(type).length : null;
  const maxPages = remainingGap != null && remainingGap <= 10
    ? 5
    : Math.ceil((totalList || 500) / graphqlListPageCount(type)) + 4;

  for (const opName of opNames) {
    if (!listFetchNeedsMore(type, totalList)) break;

    const capturedOp = await readCapturedListOpNameFromTab(tabId, opName);
    let captured = await readCapturedListTemplateFromTab(tabId, capturedOp || opName);
    if (!captured?.url) {
      await executeOnTab(tabId, injectedScrollListToLoad);
      await sleep(type === 'followers' ? 2200 : 1500);
      captured = await readCapturedListTemplateFromTab(tabId, capturedOp || opName);
    }
    let cursor = null;
    let pages = 0;
    let stalePages = 0;
    let zeroAddPages = 0;
    let droppedCaptured = false;

    while (!activeFetch?.cancelled && pages < maxPages && listFetchNeedsMore(type, totalList)) {
      const requestCount = graphqlRequestCount(type, totalList, curList(type).length);
      let res = await fetchListPageMerged(tabId, {
        opName: capturedOp || opName,
        userId: profile.userId,
        screenName: profile.username,
        cursor,
        count: requestCount,
        catalog,
        ct0: session.ct0,
        listPath: cfg.path,
        capturedTemplate: captured
      });

      if (
        !res?.ok
        && !droppedCaptured
        && captured?.url
        && (res?.status === 404 || /404/.test(res?.error || ''))
      ) {
        droppedCaptured = true;
        captured = null;
        appendDebugStatusLog({
          status: `Tab recovery ${opName}: captured GraphQL URL 404 — retrying with fresh query catalog`,
          method: 'graphql-tab',
          reason: 'collecting'
        });
        res = await fetchListPageMerged(tabId, {
          opName: capturedOp || opName,
          userId: profile.userId,
          screenName: profile.username,
          cursor,
          count: requestCount,
          catalog: await prefetchQueryCatalog(true),
          ct0: session.ct0,
          listPath: cfg.path,
          capturedTemplate: null
        });
      }

      if (!res?.ok) {
        appendDebugStatusLog({
          status: `Tab recovery ${opName} failed: ${res?.error || res?.status || 'unknown'}`,
          method: 'graphql-tab',
          reason: 'collecting'
        });
        break;
      }

      const parsedCount = (res.users || []).length;
      const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
      totalAdded += added;
      trimListToFetchLimit(type);
      pages += 1;

      notifyProgress({
        reason: 'collecting',
        method: 'rest-v1.1',
        pages,
        addedLastPage: added,
        status: `Tab recovery ${opName} p${pages}: ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} (+${added}, parsed ${parsedCount})`
      });

      if (!listFetchNeedsMore(type, totalList)) return totalAdded;

      if (added <= 0) {
        zeroAddPages += 1;
        if (zeroAddPages >= 2) break;
      } else {
        zeroAddPages = 0;
      }

      const nextCursor = res.nextCursor || null;
      if (!nextCursor || nextCursor === cursor) {
        stalePages += 1;
        if (stalePages >= 2) break;
        continue;
      }

      stalePages = 0;
      cursor = nextCursor;
      await sleep(requestCount === 1 ? Math.min(pageDelayMs, 450) : pageDelayMs);
    }

    if (!listFetchNeedsMore(type, totalList) || totalAdded > 0) break;
  }

  return totalAdded;
}

function listFetchNeedsMore(type, totalList) {
  const count = curList(type).length;
  const subscriptionCap = subscriptionInfo.fetchLimit;
  if (subscriptionCap != null && count >= subscriptionCap) return false;
  if (totalList != null && count >= totalList) return false;
  if (totalList != null && count < totalList) return true;
  return nativeListLikelyHasMore(count, totalList, type);
}

async function fetchListPageForJob(tabId, params) {
  const basePath = params.listPath || (params.opName === 'Followers' ? 'followers' : 'following');
  const listPath = await resolveListPagePath(tabId, params.screenName, basePath);
  const tabParams = { ...params, listPath };
  const tabRes = await fetchListPageFromTab(tabId, tabParams);
  if (tabRes?.ok) return tabRes;
  if (tabRes && !tabRes.ok) {
    console.warn('[X Cleaner] tab GraphQL failed, retrying from worker', tabRes.error || tabRes.status);
  }

  const session = await getXSessionCookies();
  const workerOpName = await resolveFollowersWorkerOpName(tabId, params.opName);
  return fetchListPageWorker({
    opName: workerOpName,
    userId: params.userId,
    screenName: params.screenName,
    cursor: params.cursor,
    count: params.count,
    catalog: params.catalog,
    ct0: session.ct0,
    listPath
  });
}

async function fetchListPageMerged(tabId, params) {
  const basePath = params.listPath || (params.opName === 'Followers' ? 'followers' : 'following');
  const listPath = await resolveListPagePath(tabId, params.screenName, basePath);
  const tabParams = { ...params, listPath };
  const tabRes = await fetchListPageFromTab(tabId, tabParams);

  const captured = params.capturedTemplate
    || (params.opName === 'Followers' ? await readCapturedListTemplateFromTab(tabId, params.opName) : null);
  if (tabRes?.ok && params.opName === 'Followers' && captured?.url) {
    return tabRes;
  }

  const session = await getXSessionCookies();
  const workerOpName = await resolveFollowersWorkerOpName(tabId, params.opName);
  const workerRes = await fetchListPageWorker({
    opName: workerOpName,
    userId: params.userId,
    screenName: params.screenName,
    cursor: params.cursor,
    count: params.count,
    catalog: params.catalog,
    ct0: session.ct0,
    listPath
  });

  if (workerRes?.ok && (!tabRes?.ok || (tabRes?.status === 404 || /404/.test(tabRes?.error || '')))) {
    return workerRes;
  }

  if (tabRes?.ok || workerRes?.ok) {
    return mergeListPageResults(tabRes, workerRes);
  }

  return tabRes || workerRes || { ok: false, error: 'GraphQL page failed', users: [], nextCursor: null };
}

async function fetchListPageWithRetry(tabId, params, options = {}) {
  const retries = options.retries ?? 3;
  let lastRes = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const res = await fetchListPageForJob(tabId, params);
    lastRes = res;
    if (res?.ok) return res;
    if (attempt < retries - 1) {
      await sleep(900 * (attempt + 1));
    }
  }

  return lastRes;
}

async function fetchFullListViaGraphql(tabId, profile, type, fetchTarget, totalList) {
  const cfg = listCfg(type);
  const opName = cfg.opName;
  let userId = profile.userId;
  if (!userId) {
    const catalog = await prefetchQueryCatalog(false);
    userId = await resolveUserIdFromScreenName(profile.username, catalog);
    profile.userId = userId;
  }
  if (!userId) {
    console.warn('[X Cleaner] Full GraphQL fetch skipped — could not resolve userId');
    return { users: [], lastCursor: null };
  }

  const catalog = await prefetchQueryCatalog(false);
  const owner = (profile.username || '').toLowerCase();
  // Only the free-tier cap may stop pagination — profile totals are often rounded (e.g. 50 vs 52).
  const subscriptionCap = subscriptionInfo.fetchLimit;
  const pageSize = graphqlListPageCount(type);
  const captured = await readCapturedListTemplateFromTab(tabId, opName);
  const ordered = [];
  const seen = new Set();
  let cursor = null;
  let lastValidCursor = null;
  let pages = 0;
  let stalePages = 0;
  const maxPages = 500;
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;

  notifyProgress({
    reason: 'collecting',
    method: 'graphql',
    status: `Fetching full ${cfg.label.toLowerCase()} list via GraphQL...`
  });

  while (!activeFetch?.cancelled && pages < maxPages) {
    const useCaptured = pages === 0
      && !cursor
      && (await tabIsOnListPage(tabId, profile.username, cfg.path));
    const res = await fetchListPageWithRetry(tabId, {
      opName,
      listPath: cfg.path,
      userId,
      screenName: profile.username,
      cursor,
      count: pageSize,
      catalog,
      capturedTemplate: useCaptured ? captured : null
    });

    if (!res?.ok) {
      console.warn('[X Cleaner] GraphQL page failed', res.error || res.status);
      break;
    }

    let pageAdded = 0;
    for (const user of res.users || []) {
      const key = (user.username || '').toLowerCase();
      if (!key || key === owner || seen.has(key)) continue;
      seen.add(key);
      ordered.push(user);
      pageAdded += 1;
    }

    if (pageAdded > 0) {
      stalePages = 0;
    } else {
      stalePages += 1;
    }

    const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
    notifyProgress({
      reason: 'collecting',
      method: 'graphql',
      pages: pages + 1,
      addedLastPage: pageAdded,
      status: `GraphQL ${ordered.length.toLocaleString()} / ${totalLabel} ${cfg.label.toLowerCase()} (+${pageAdded.toLocaleString()} page ${pages + 1})`
    });

    if (subscriptionCap != null && ordered.length >= subscriptionCap) break;

    const nextCursor = res.nextCursor || null;
    const likelyMore = nativeListLikelyHasMore(ordered.length, totalList, type);
    if (!nextCursor || nextCursor === cursor) {
      if (likelyMore && pageAdded > 0 && stalePages < 2) {
        stalePages += 1;
        await sleep(pageDelayMs * 2);
        continue;
      }
      break;
    }
    lastValidCursor = nextCursor;
    cursor = nextCursor;
    pages += 1;
    if (pageAdded === 0) stalePages += 1;
    await sleep(pageDelayMs);
  }

  return { users: ordered, lastCursor: lastValidCursor };
}

async function fetchListTailCursorSweep(tabId, profile, type, seen, totalList, captured) {
  const cfg = listCfg(type);
  const catalog = await prefetchQueryCatalog(false);
  const cursors = (await readNativeListTailCursorsFromTab(tabId, cfg.opName, 8)) || [];
  if (!cursors.length) return 0;

  const pageCount = graphqlTailPageCount(type);
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;
  let totalAdded = 0;

  notifyProgress({
    reason: 'collecting',
    method: 'graphql',
    status: `Tail cursor sweep across ${cursors.length} saved positions...`
  });

  for (const startCursor of [...cursors].reverse()) {
    if (!listFetchNeedsMore(type, totalList)) break;

    let cursor = startCursor;
    const visited = new Set([cursor]);

    for (let page = 0; page < 6 && listFetchNeedsMore(type, totalList); page += 1) {
      const res = await fetchListPageMerged(tabId, {
        opName: cfg.opName,
        listPath: cfg.path,
        userId: profile.userId,
        screenName: profile.username,
        cursor,
        count: pageCount,
        catalog,
        capturedTemplate: captured || null
      });

      if (!res?.ok) break;

      const parsedCount = (res.users || []).length;
      const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
      totalAdded += added;
      trimListToFetchLimit(type);

      if (added > 0) {
        const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
        notifyProgress({
          reason: 'collecting',
          method: 'graphql',
          addedLastPage: added,
          status: `Tail sweep ${curList(type).length.toLocaleString()} / ${totalLabel} (parsed ${parsedCount}, +${added})`
        });
      }

      if (!listFetchNeedsMore(type, totalList)) break;

      const nextCursor = res.nextCursor || null;
      if (!nextCursor || nextCursor === cursor || visited.has(nextCursor)) break;
      visited.add(nextCursor);
      cursor = nextCursor;
      await sleep(pageDelayMs);
    }
  }

  return totalAdded;
}

async function fetchListFinalPartialPage(tabId, profile, type, seen, totalList, captured) {
  const cfg = listCfg(type);
  const gap = totalList != null ? totalList - curList(type).length : null;
  if (gap == null || gap <= 0 || gap > nativePageSize(type)) return 0;

  const catalog = await prefetchQueryCatalog(false);
  const cursors = (await readNativeListTailCursorsFromTab(tabId, cfg.opName, 10)) || [];
  const latest = await readNativeListCursorFromTab(tabId, cfg.opName);
  if (latest) cursors.push(latest);
  const unique = [...new Set(cursors.filter(Boolean))];
  if (!unique.length) return 0;

  const listPath = await resolveListPagePath(tabId, profile.username, cfg.path);
  const plan = planGraphqlListFetch(type, totalList, curList(type).length);
  const requestCount = graphqlRequestCount(type, totalList, curList(type).length);
  let totalAdded = 0;
  const tailPasses = plan.tailSingleAccount ? Math.max(gap * 4, 12) : 1;

  notifyProgress({
    reason: 'collecting',
    method: 'graphql',
    status: plan.tailSingleAccount
      ? `Final tail: ${gap.toLocaleString()} ${cfg.label.toLowerCase()} — 1 account per request...`
      : `Fetching final partial page (~${gap.toLocaleString()} ${cfg.label.toLowerCase()}, count=${requestCount})...`
  });

  for (const startCursor of [...unique].reverse()) {
    if (!listFetchNeedsMore(type, totalList)) break;

    let cursor = startCursor;
    let staleTailPasses = 0;

    for (let pass = 0; pass < tailPasses && !activeFetch?.cancelled && listFetchNeedsMore(type, totalList); pass += 1) {
      const countNow = graphqlRequestCount(type, totalList, curList(type).length);
      const res = await fetchListPageMerged(tabId, {
        opName: cfg.opName,
        listPath,
        userId: profile.userId,
        screenName: profile.username,
        cursor,
        count: countNow,
        catalog,
        capturedTemplate: captured || null
      });

      if (!res?.ok) break;

      const parsedCount = (res.users || []).length;
      const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
      totalAdded += added;
      trimListToFetchLimit(type);

      const totalLabel = totalList.toLocaleString();
      const pageLabel = graphqlPageStatusLabel(type, totalList, curList(type).length, pass + 1, countNow);
      notifyProgress({
        reason: 'collecting',
        method: 'graphql',
        addedLastPage: added,
        status: `Final ${pageLabel} — ${curList(type).length.toLocaleString()} / ${totalLabel} (parsed ${parsedCount}, +${added})`
      });

      if (!listFetchNeedsMore(type, totalList)) break;

      const nextCursor = res.nextCursor || null;
      if (!nextCursor || nextCursor === cursor) {
        staleTailPasses += 1;
        if (!plan.tailSingleAccount || staleTailPasses >= 3) break;
        await sleep(GRAPHQL_PAGE_DELAY_MS[type] || 600);
        continue;
      }

      staleTailPasses = 0;
      cursor = nextCursor;
      if (!plan.tailSingleAccount) break;
      await sleep(Math.min(GRAPHQL_PAGE_DELAY_MS[type] || 600, 500));
    }

    if (totalAdded > 0 || !listFetchNeedsMore(type, totalList)) break;
  }

  return totalAdded;
}

async function fetchListTailScrollNative(tabId, profile, type, seen, totalList, lastSeq = 0) {
  const cfg = listCfg(type);
  let seq = lastSeq;
  let totalAdded = 0;
  let stalePasses = 0;
  const gap = totalList != null ? totalList - curList(type).length : null;
  const listenMs = gap != null && gap <= 15 ? 3500 : 5000;
  const stepDelayMs = type === 'followers' ? 1600 : 1200;
  const maxSteps = gap != null && gap <= 15 ? 8 : 12;

  notifyProgress({
    reason: 'collecting',
    method: 'native-sniffer',
    status: `Step-scrolling ${cfg.label.toLowerCase()} list for missing accounts...`
  });

  await executeOnTab(tabId, injectedScrollListToTop);
  await sleep(800);

  for (let step = 0; step < maxSteps && !activeFetch?.cancelled && listFetchNeedsMore(type, totalList); step += 1) {
    await executeOnTab(tabId, injectedScrollListStep);
    await sleep(stepDelayMs);

    const native = await waitForNativeList(tabId, cfg.opName, seq, listenMs);
    let added = 0;
    if (native) {
      added = addNativeUsers(native, seen, profile.username, type);
      if (native.seq) seq = Math.max(seq, native.seq);
    }

    if (added > 0) {
      totalAdded += added;
      stalePasses = 0;
      trimListToFetchLimit(type);
      const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
      notifyProgress({
        reason: 'collecting',
        method: 'native-sniffer',
        addedLastPage: added,
        status: `Tail scroll ${curList(type).length.toLocaleString()} / ${totalLabel} (+${added})`
      });
    } else {
      stalePasses += 1;
      if (stalePasses >= 6) break;
    }
  }

  return totalAdded;
}

async function fetchListTailGraphql(tabId, profile, type, seen, totalList, captured) {
  const cfg = listCfg(type);
  const catalog = await prefetchQueryCatalog(false);
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;
  const listPath = await resolveListPagePath(tabId, profile.username, cfg.path);
  const gap = totalList != null ? totalList - curList(type).length : null;
  let cursor = await readNativeListCursorFromTab(tabId, cfg.opName);
  const spareCursors = (await readNativeListAllCursorsFromTab(tabId, cfg.opName)) || [];
  let spareCursorIdx = 0;
  let pages = 0;
  let totalAdded = 0;
  let staleCursorPasses = 0;

  notifyProgress({
    reason: 'collecting',
    method: 'graphql',
    status: `Tail GraphQL for ${gap != null ? gap.toLocaleString() : 'remaining'} ${cfg.label.toLowerCase()}...`
  });

  while (!activeFetch?.cancelled && pages < 30 && listFetchNeedsMore(type, totalList)) {
    if (!cursor) {
      await executeOnTab(tabId, injectedScrollListToLoad);
      await sleep(pageDelayMs * 2);
      cursor = await readNativeListCursorFromTab(tabId, cfg.opName);
      if (!cursor && spareCursorIdx < spareCursors.length) {
        cursor = spareCursors[spareCursorIdx];
        spareCursorIdx += 1;
      }
      if (!cursor) {
        staleCursorPasses += 1;
        if (staleCursorPasses >= 6) break;
        continue;
      }
    }

    const requestCount = graphqlRequestCount(type, totalList, curList(type).length);
    const res = await fetchListPageMerged(tabId, {
      opName: cfg.opName,
      listPath,
      userId: profile.userId,
      screenName: profile.username,
      cursor,
      count: requestCount,
      catalog,
      capturedTemplate: captured || null
    });

    if (!res?.ok) break;

    const parsedCount = (res.users || []).length;
    const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
    totalAdded += added;
    trimListToFetchLimit(type);

    const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
    const pageLabel = graphqlPageStatusLabel(type, totalList, curList(type).length, pages + 1, requestCount);
    notifyProgress({
      reason: 'collecting',
      method: 'graphql',
      addedLastPage: added,
      status: `Tail GraphQL ${curList(type).length.toLocaleString()} / ${totalLabel} (${pageLabel}, parsed ${parsedCount}, +${added})`
    });

    if (!listFetchNeedsMore(type, totalList)) break;

    const nextCursor = res.nextCursor || null;
    if (!nextCursor || nextCursor === cursor) {
      if (parsedCount > 0 && listFetchNeedsMore(type, totalList) && staleCursorPasses < 8) {
        staleCursorPasses += 1;
        await sleep(pageDelayMs);
        continue;
      }
      staleCursorPasses += 1;
      cursor = null;
      if (staleCursorPasses >= 8) break;
      continue;
    }

    staleCursorPasses = 0;
    cursor = nextCursor;
    pages += 1;
    const tailDelay = requestCount === 1 ? Math.min(pageDelayMs, 450) : pageDelayMs;
    await sleep(tailDelay);
  }

  return totalAdded;
}

async function fetchListTailDom(tabId, profile, type, seen, totalList) {
  const cfg = listCfg(type);
  let totalAdded = 0;
  const settleMs = type === 'followers' ? 2200 : 1500;

  for (let pass = 0; pass < 2 && !activeFetch?.cancelled && listFetchNeedsMore(type, totalList); pass += 1) {
    const gap = totalList != null ? totalList - curList(type).length : null;
    notifyProgress({
      reason: 'collecting',
      method: 'dom-scrape',
      status: `Bottom scan pass ${pass + 1} for ${gap != null ? gap.toLocaleString() : 'remaining'} ${cfg.label.toLowerCase()}...`
    });

    await executeOnTab(tabId, injectedScrollListToLoad);
    await sleep(settleMs);

    const scraped = await collectVisibleListUsersFromTab(tabId, profile.username);
    const added = addNativeUsers({ users: scraped?.users || [] }, seen, profile.username, type);
    totalAdded += added;
    trimListToFetchLimit(type);

    if (added > 0) {
      const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
      notifyProgress({
        reason: 'collecting',
        method: 'dom-scrape',
        addedLastPage: added,
        status: `DOM scan ${curList(type).length.toLocaleString()} / ${totalLabel} ${cfg.label.toLowerCase()} (+${added})`
      });
    }
  }

  return totalAdded;
}

async function fetchListTailGap(tabId, profile, type, seen, totalList, lastSeq = 0) {
  const cfg = listCfg(type);
  if (!listFetchNeedsMore(type, totalList)) return 0;

  const gap = totalList != null ? totalList - curList(type).length : null;
  if (gap == null || gap <= 0 || gap > 80) return 0;

  let totalAdded = 0;
  const captured = await readCapturedListTemplateFromTab(tabId, cfg.opName);

  notifyProgress({
    reason: 'collecting',
    method: 'graphql',
    status: `Short by ${gap.toLocaleString()} — finishing ${cfg.label.toLowerCase()} tail...`
  });

  const drained = await readNativeListQueueDrainFromTab(tabId, cfg.opName);
  if (drained?.users?.length) {
    const queueAdded = addNativeUsers({ users: drained.users }, seen, profile.username, type);
    totalAdded += queueAdded;
    trimListToFetchLimit(type);
    if (queueAdded > 0) {
      const totalLabel = totalList.toLocaleString();
      notifyProgress({
        reason: 'collecting',
        method: 'native-sniffer',
        addedLastPage: queueAdded,
        status: `Queue drain ${curList(type).length.toLocaleString()} / ${totalLabel} (+${queueAdded})`
      });
    }
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList) && profile.userId) {
    totalAdded += await fetchListFinalPartialPage(tabId, profile, type, seen, totalList, captured);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList) && profile.userId) {
    totalAdded += await fetchListTailCursorSweep(tabId, profile, type, seen, totalList, captured);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList) && profile.userId) {
    totalAdded += await fetchListTailGraphql(tabId, profile, type, seen, totalList, captured);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList)) {
    totalAdded += await fetchListTailScrollNative(tabId, profile, type, seen, totalList, lastSeq);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList)) {
    totalAdded += await fetchListTailDom(tabId, profile, type, seen, totalList);
  }

  return totalAdded;
}

async function continueListFetchWithGraphql(tabId, profile, type, seen, fetchTarget, totalList) {
  const cfg = listCfg(type);
  const opName = type === 'followers'
    ? await resolveFollowersWorkerOpName(tabId, cfg.opName)
    : cfg.opName;
  let userId = profile.userId;
  if (!userId) {
    const catalog = await prefetchQueryCatalog(false);
    userId = await resolveUserIdFromScreenName(profile.username, catalog);
    profile.userId = userId;
  }
  if (!userId) {
    console.warn('[X Cleaner] GraphQL continuation skipped — could not resolve userId');
    return 0;
  }

  if (!listFetchNeedsMore(type, totalList)) return 0;

  const subscriptionCap = subscriptionInfo.fetchLimit;
  const catalog = await prefetchQueryCatalog(false);
  const pageSize = graphqlListPageCount(type);
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;
  let cursor = await readNativeListCursorFromTab(tabId, opName);
  if (!cursor && seen.size > nativePageSize(type)) {
    await executeOnTab(tabId, injectedScrollListToLoad);
    await sleep(pageDelayMs * 2);
    cursor = await readNativeListCursorFromTab(tabId, opName);
    if (!cursor) {
      const resumeCursors = (await readNativeListTailCursorsFromTab(tabId, opName, 4)) || [];
      if (resumeCursors.length > 0) {
        cursor = resumeCursors[resumeCursors.length - 1];
      }
    }
  }
  const captured = await readCapturedListTemplateFromTab(tabId, opName);
  const useCapturedEndpoint = !!captured?.url;
  const listPath = await resolveListPagePath(tabId, profile.username, cfg.path);
  let pages = 0;
  let totalAdded = 0;
  let cursorRetries = 0;
  const maxPages = 500;

  const startPlan = planGraphqlListFetch(type, totalList, curList(type).length);
  jobState.method = 'graphql';
  notifyProgress({
    reason: 'collecting',
    method: 'graphql',
    status: startPlan.totalPages != null
      ? `Collected ${curList(type).length.toLocaleString()} via native — GraphQL plan: ${startPlan.totalPages} page(s), ${startPlan.remaining.toLocaleString()} left${startPlan.tailSingleAccount ? ' (tail: 1/request)' : ''}...`
      : `Collected ${curList(type).length.toLocaleString()} via native — continuing with GraphQL pages...`
  });

  while (!activeFetch?.cancelled && pages < maxPages) {
    if (!listFetchNeedsMore(type, totalList)) break;

    const requestCount = graphqlRequestCount(type, totalList, curList(type).length);
    const fetchParams = {
      opName,
      listPath,
      userId,
      screenName: profile.username,
      cursor,
      count: requestCount,
      catalog,
      capturedTemplate: useCapturedEndpoint ? captured : (pages === 0 && !cursor ? captured : null)
    };
    const res = useCapturedEndpoint
      ? await fetchListPageFromTab(tabId, fetchParams)
      : await fetchListPageMerged(tabId, fetchParams);

    if (!res?.ok) {
      console.warn('[X Cleaner] GraphQL page failed', res.error || res.status);
      notifyProgress({
        reason: 'collecting',
        method: 'graphql',
        status: `GraphQL failed: ${res.error || `HTTP ${res.status || 0}`}. Collected ${curList(type).length.toLocaleString()} so far.`
      });
      break;
    }

    const parsedCount = (res.users || []).length;
    const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
    totalAdded += added;
    trimListToFetchLimit(type);

    const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
    const dupes = Math.max(0, parsedCount - added);
    const dupNote = dupes > 0 ? `, ${dupes} dupes` : '';
    const srcNote = res.tabCount != null || res.workerCount != null
      ? ` [tab ${res.tabCount ?? 0}/worker ${res.workerCount ?? 0}]`
      : '';
    const pageLabel = graphqlPageStatusLabel(type, totalList, curList(type).length, pages + 1, requestCount);
    notifyProgress({
      reason: 'collecting',
      method: 'graphql',
      pages: pages + 1,
      parsedLastPage: parsedCount,
      dupLastPage: dupes,
      addedLastPage: added,
      fetchTarget,
      status: `GraphQL ${curList(type).length.toLocaleString()} / ${totalLabel} ${cfg.label.toLowerCase()} (${pageLabel}, parsed ${parsedCount}, +${added}${dupNote}${srcNote})`
    });

    if (subscriptionCap != null && curList(type).length >= subscriptionCap) break;

    const nextCursor = res.nextCursor || null;
    if (added === 0 && parsedCount > 0 && nextCursor && nextCursor !== cursor) {
      cursorRetries = 0;
      cursor = nextCursor;
      pages += 1;
      await sleep(requestCount === 1 ? Math.min(pageDelayMs, 450) : pageDelayMs);
      continue;
    }

    if (!nextCursor || nextCursor === cursor) {
      const tailGap = totalList != null ? totalList - curList(type).length : null;
      const maxCursorRetries = type === 'followers' && tailGap != null && tailGap > 0 ? 15 : (tailGap != null && tailGap <= 20 ? 12 : 3);
      if (listFetchNeedsMore(type, totalList) && cursorRetries < maxCursorRetries) {
        cursorRetries += 1;
        await executeOnTab(tabId, injectedScrollListToLoad);
        await sleep(pageDelayMs * 2);
        const refreshed = await readNativeListCursorFromTab(tabId, opName);
        if (refreshed && refreshed !== cursor) {
          cursor = refreshed;
          continue;
        }
        continue;
      }
      if (listFetchNeedsMore(type, totalList)) {
        break;
      }
      break;
    }

    cursorRetries = 0;
    cursor = nextCursor;
    pages += 1;
    const tailDelay = requestCount === 1 ? Math.min(pageDelayMs, 450) : pageDelayMs;
    await sleep(tailDelay);
  }

  return totalAdded;
}

async function runNativeListFetch(tabId, profile, type = listType) {
  const session = await getXSessionCookies();
  if (!session.loggedIn) {
    throw new Error('Not logged in to X. Open x.com, sign in, then try again.');
  }

  const cfg = listCfg(type);
  const resolvedUsername = profile.username;
  if (!profile.userId) {
    const catalog = await prefetchQueryCatalog(false);
    profile.userId = await resolveUserIdFromScreenName(resolvedUsername, catalog);
  }
  const totalList = effectiveTotalList(type, profile);
  if (totalList != null) {
    profile[cfg.totalKey] = totalList;
    jobState[cfg.totalKey] = totalList;
  }

  const resuming = curList(type).length > 0;
  if (!resuming) {
    await executeOnTab(tabId, (opName) => {
      try {
        sessionStorage.removeItem(`xc_list_queue_${opName}`);
        sessionStorage.removeItem(`xc_list_latest_${opName}`);
        sessionStorage.removeItem('xc_list_queue_BlueVerifiedFollowers');
        sessionStorage.removeItem('xc_list_latest_BlueVerifiedFollowers');
      } catch (error) {}
    }, [cfg.opName]);
  }

  const listUrl = `https://x.com/${resolvedUsername}/${cfg.path}`;
  await ensureSnifferInstalled(tabId);

  await chrome.tabs.update(tabId, {
    url: listUrl,
    active: true
  });
  await waitForTabComplete(tabId);
  await ensureSnifferInstalled(tabId);

  // Reload once so the timeline GraphQL request runs with the sniffer hooked.
  await executeOnTab(tabId, () => {
    location.reload();
  });
  const listNavSettleMs = type === 'followers' ? XC_FOLLOWERS_NAV_SETTLE_MS : XC_LIST_NAV_SETTLE_MS;
  await waitAfterTabNavigation(tabId, listNavSettleMs);
  await ensureSnifferInstalled(tabId);

  const listPageTotal = await scrapeListPageTotal(tabId, type);
  if (listPageTotal != null && (totalList == null || listPageTotal > totalList)) {
    totalList = listPageTotal;
    profile[cfg.totalKey] = listPageTotal;
    jobState[cfg.totalKey] = listPageTotal;
  }

  const cachedCount = curList(type).length;
  const tailResume = listResumeIsTailOnly(type, totalList);

  if (cachedCount > 0 && totalList != null && cachedCount >= totalList) {
    snapshotListRaw(type);
    jobState.isScraping = false;
    jobState.reason = 'complete';
    jobState.count = cachedCount;
    jobState.status = `Already have ${cachedCount.toLocaleString()} ${cfg.label.toLowerCase()} — skipping sniffer fetch`;
    notifyProgress({ status: jobState.status });
    schedulePersist(true, type);
    return;
  }

  appendDebugStatusLogStart({
    status: tailResume
      ? `Tail-only sniffer resume: ${cachedCount.toLocaleString()} / ${totalList?.toLocaleString() || '—'} ${cfg.label} cached`
      : `Starting ${cfg.label} collection (sniffer)`,
    reason: 'start',
    method: 'native-sniffer',
    listType: type
  });

  const hudState = {
    action: 'showHud',
    username: resolvedUsername,
    listType: type,
    totalFollowing: profile.totalFollowing,
    totalFollowers: profile.totalFollowers,
    count: cachedCount,
    isScraping: true,
    reason: 'waiting-native',
    method: 'native-sniffer',
    status: tailResume
      ? `Sniffer tail: ${cachedCount.toLocaleString()} / ${totalList?.toLocaleString() || '—'} ${cfg.label.toLowerCase()}...`
      : `Listening for X native ${cfg.label} responses...`,
    ...debugStatusPayload()
  };
  await sendHudMessage(tabId, hudState, 20);

  if (!cachedCount) {
    setCurList([], type);
    setCurRaw([], type);
  }
  listType = type;
  const debugLogSnapshot = jobState.debugStatusLog;
  jobState = {
    username: resolvedUsername,
    listType: type,
    totalFollowing: profile.totalFollowing,
    totalFollowers: profile.totalFollowers,
    count: cachedCount,
    rawCount: curRaw(type).length || cachedCount,
    isScraping: true,
    reason: 'waiting-native',
    method: 'native-sniffer',
    status: hudState.status,
    debugStatusLog: debugLogSnapshot
  };
  notifyProgress();

  const seen = buildSeenFromCurList(type, resolvedUsername);
  let lastSeq = 0;
  let stalePasses = 0;
  let dupBatches = 0;
  let passes = 0;
  let batchesWithAdds = 0;
  const fetchTarget = effectiveFetchTarget(totalList);

  if (tailResume && totalList != null && profile.userId) {
    appendDebugStatusLog({
      status: `Sniffer tail-only: skipping full native sweep (${cachedCount}/${totalList})`,
      method: 'native-sniffer',
      reason: 'collecting'
    });
    await fetchListTailGap(tabId, profile, type, seen, totalList, lastSeq);
    if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList)) {
      await recoverShortfallChain(tabId, profile, type, seen, totalList, { skipWarmup: true });
    }
    if (curList(type).length > 0) {
      trimListToFetchLimit(type);
      snapshotListRaw(type);
      jobState.isScraping = false;
      jobState.reason = activeFetch?.cancelled ? 'stopped' : 'complete';
      jobState.count = curList(type).length;
      const shortBy = totalList != null ? Math.max(0, totalList - curList(type).length) : 0;
      jobState.status = shortBy > 0
        ? `Sniffer tail — ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} ${cfg.label.toLowerCase()} (short by ${shortBy})`
        : `Sniffer tail complete — ${curList(type).length.toLocaleString()} ${cfg.label.toLowerCase()}`;
      notifyProgress({ status: jobState.status });
      schedulePersist(true, type);
      return;
    }
  }

  while (!activeFetch?.cancelled) {
    const remaining = remainingListCount(type, totalList, fetchTarget);
    const listenMs = nativeListenTimeoutMs(type, passes, remaining);
    const native = await waitForNativeList(
      tabId,
      cfg.opName,
      lastSeq,
      listenMs
    );
    let added = 0;
    let parsedLastBatch = 0;
    if (native) {
      const batchUsers = native.users || [];
      parsedLastBatch = batchUsers.length;
      if (batchUsers.length > 0) {
        added = addNativeUsers(native, seen, resolvedUsername, type);
        if (native.seq) lastSeq = Math.max(lastSeq, native.seq);
        if (added > 0) {
          dupBatches = 0;
          stalePasses = 0;
          batchesWithAdds += 1;
        } else {
          dupBatches += 1;
          stalePasses += 1;
        }
      } else if (native.seq) {
        lastSeq = Math.max(lastSeq, native.seq);
        stalePasses += 1;
      } else {
        stalePasses += 1;
      }
    } else {
      stalePasses += 1;
    }

    trimListToFetchLimit(type);
    passes += 1;

    const targetLabel = fetchTarget != null ? fetchTarget.toLocaleString() : '—';
    const capNote = subscriptionInfo.fetchLimit != null && !subscriptionInfo.isSubscribed
      ? ' (free limit)'
      : '';
    const dupes = Math.max(0, parsedLastBatch - added);
    const atTail = nativeLikelyAtTail(type, curList(type).length, totalList);
    const tailNote = atTail ? ' [tail]' : '';
    const staleNote = stalePasses > 0 ? `, stale ${stalePasses}` : '';
    const dupNote = dupes > 0 ? `, ${dupes} dupes` : '';
    notifyProgress({
      reason: 'collecting',
      method: 'native-sniffer',
      passes,
      pages: batchesWithAdds,
      parsedLastPage: parsedLastBatch,
      dupLastPage: dupes,
      addedLastPage: added,
      fetchTarget,
      status: `Native ${curList().length.toLocaleString()} / ${targetLabel}${capNote} ${cfg.label.toLowerCase()} (+${added}, parsed ${parsedLastBatch}${dupNote}${staleNote})${tailNote}`
    });

    if (subscriptionInfo.fetchLimit != null && curList(type).length >= subscriptionInfo.fetchLimit) break;
    if (
      totalList != null &&
      curList(type).length >= totalList &&
      !nativeListLikelyHasMore(curList(type).length, totalList, type)
    ) {
      break;
    }

    const collected = curList(type).length;
    if (atTail && (dupBatches >= 2 || stalePasses >= 3)) {
      appendDebugStatusLog({
        status: `Native tail detected at ${collected.toLocaleString()} — switching to GraphQL`,
        reason: 'collecting',
        method: 'native-sniffer'
      });
      notifyProgress({
        reason: 'collecting',
        method: 'graphql',
        status: `Native done at ${collected.toLocaleString()} (tail) — continuing via GraphQL...`
      });
      break;
    }

    const staleLimit = nativeStalePassLimit(type, totalList, collected);
    if (collected > 0 && stalePasses >= staleLimit) {
      appendDebugStatusLog({
        status: `Native stale limit (${stalePasses}/${staleLimit}) — switching to GraphQL`,
        reason: 'collecting',
        method: 'native-sniffer'
      });
      break;
    }
    if (passes > 2000) break;

    const onListPage = await tabIsOnListPage(tabId, resolvedUsername, cfg.path);
    if (!onListPage) {
      await chrome.tabs.update(tabId, { url: listUrl });
      await waitForTabComplete(tabId);
      await sleep(1200);
      continue;
    }

    await executeOnTab(tabId, injectedScrollListToLoad);
    const scrollDelayMs = remaining > 0 && remaining <= 100 ? 1200 : (type === 'followers' ? 2200 : 1800);
    await sleep(scrollDelayMs);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList) && profile.userId) {
    await continueListFetchWithGraphql(tabId, profile, type, seen, fetchTarget, totalList);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList)) {
    await fetchListTailGap(tabId, profile, type, seen, totalList, lastSeq);
  }

  if (!activeFetch?.cancelled && listFetchNeedsMore(type, totalList) && profile.userId) {
    await recoverShortfallViaWorkerGraphql(tabId, profile, type, seen, totalList);
  }

  if (curList().length === 0) {
    if (activeFetch?.cancelled) {
      jobState.isScraping = false;
      jobState.reason = 'stopped';
      notifyProgress({ status: 'Stopped.' });
      return;
    }
    throw new Error(
      `No ${cfg.label.toLowerCase()} accounts captured from X native responses. Reload the extension at chrome://extensions/, refresh the x.com tab once, then try again.`
    );
  }

  trimListToFetchLimit(type);
  snapshotListRaw(type);

  const reason = activeFetch?.cancelled ? 'stopped' : 'complete';
  jobState.isScraping = false;
  jobState.reason = reason;
  restoredTypes[type] = false;

  const finalCount = curList(type).length;
  const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
  let doneStatus = `Collected ${finalCount.toLocaleString()} / ${totalLabel} ${cfg.label.toLowerCase()}.`;
  if (totalList != null && finalCount < totalList) {
    doneStatus += ` (${(totalList - finalCount).toLocaleString()} short of profile total — try Refresh or collect again.)`;
  } else if (nativeListLikelyHasMore(finalCount, totalList, type)) {
    doneStatus += ' (ends on a full page — more accounts may exist.)';
  }

  if (
    subscriptionInfo.fetchLimit != null &&
    fetchTarget != null &&
    finalCount >= fetchTarget &&
    (totalList == null || fetchTarget < totalList)
  ) {
    doneStatus = `Free tier limit reached (${XC_FREE_FETCH_LIMIT}). Subscribe @d2fl to export full lists.`;
  }

  notifyProgress({
    status: `DONE — ${doneStatus}`,
    reason: 'complete',
    method: jobState.method || 'native-sniffer'
  });
  persistDebugStatusLog();
  schedulePersist(true, type);
}

function finishEmptyFilter() {
  setCurList([]);
  jobState.filterRemoved = curRaw().length;
  jobState.reason = 'filtered';
  jobState.isEnriching = false;
  jobState.filterPhase = null;
  notifyProgress({ status: 'All accounts removed by filters.' });
  schedulePersist(true);
  return {
    ok: true,
    ...jobState,
    count: 0,
    rawCount: curRaw().length,
    removed: jobState.filterRemoved
  };
}

async function filterList(options = {}) {
  const source = curRaw().length ? curRaw() : curList();
  if (!source.length) {
    return { ok: false, error: `No ${listCfg().label.toLowerCase()} collected yet.` };
  }

  if (jobState.isScraping) {
    return { ok: false, error: 'Wait until collection finishes before filtering.' };
  }

  if (activeEnrich?.running) {
    return { ok: false, error: 'Activity lookup already running.' };
  }

  if (!curRaw().length) {
    snapshotListRaw();
  }

  const removeBlue = !!options.removeBlue;
  const removeNew = !!options.removeNew;
  const removeInactive = !!options.removeInactive;
  const newAccountMonths = normalizeNewAccountMonths(options.newAccountMonths);
  const inactiveMonths = normalizeInactiveMonths(options.inactiveMonths);

  if (!removeBlue && !removeNew && !removeInactive) {
    setCurList(curRaw().slice());
    jobState.filterRemoved = 0;
    jobState.reason = curList().length ? 'complete' : jobState.reason;
    jobState.filterPhase = null;
    notifyProgress({ status: `${curList().length.toLocaleString()} accounts ready to export.` });
    schedulePersist(true);
    return {
      ok: true,
      ...jobState,
      count: curList().length,
      rawCount: curRaw().length,
      removed: 0
    };
  }

  let working = curRaw().slice();
  const parts = [];
  jobState.reason = 'filtering';
  jobState.isEnriching = false;
  jobState.enrichProcessed = 0;
  jobState.enrichTotal = 0;

  if (removeBlue) {
    const before = working.length;
    working = applyFollowingFilters(working, { removeBlue: true, removeNew: false });
    setCurList(working);
    jobState.filterRemoved = curRaw().length - working.length;
    jobState.filterPhase = 'blue';
    const removed = before - working.length;
    if (removed > 0) parts.push(`blue (${removed.toLocaleString()})`);
    notifyProgress({
      reason: 'filtering',
      filterPhase: 'blue',
      status: `Remove blue: ${working.length.toLocaleString()} remaining (−${removed.toLocaleString()})`
    });
    schedulePersist(true);
    if (!working.length) return finishEmptyFilter();
  }

  if (removeNew) {
    const before = working.length;
    working = applyFollowingFilters(working, {
      removeBlue: false,
      removeNew: true,
      newAccountMonths
    });
    setCurList(working);
    jobState.filterRemoved = curRaw().length - working.length;
    jobState.filterPhase = 'new';
    const removed = before - working.length;
    if (removed > 0) parts.push(`new (${removed.toLocaleString()})`);
    notifyProgress({
      reason: 'filtering',
      filterPhase: 'new',
      status: `Remove new (< ${newAccountMonths} mo): ${working.length.toLocaleString()} remaining (−${removed.toLocaleString()})`
    });
    schedulePersist(true);
    if (!working.length) return finishEmptyFilter();
  }

  if (removeInactive) {
    if (!(await ensureJobTabId())) {
      return { ok: false, error: 'No X tab available for activity lookup.' };
    }

    setCurList(working);
    activeEnrich = { running: true, cancelled: false };
    jobState.isEnriching = true;
    jobState.reason = 'enriching';
    jobState.filterPhase = 'inactive';
    jobState.enrichTotal = working.length;
    jobState.enrichProcessed = 0;
    notifyProgress({
      reason: 'enriching',
      isEnriching: true,
      enrichProcessed: 0,
      enrichTotal: working.length,
      status: `REST lookup: last tweet for ${working.length.toLocaleString()} accounts (${inactiveMonths} mo inactive)...`
    });

    let enrichCancelled = false;
    try {
      working = await enrichLastActiveForUsers(jobTabId, working, (progress) => {
        const status = progress.waiting
          ? `Waiting… checked ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
          : `REST last-tweet lookup ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}...`;
        notifyProgress({
          reason: 'enriching',
          isEnriching: true,
          enrichProcessed: progress.processed,
          enrichTotal: progress.total,
          status
        });
      });
      enrichCancelled = !!activeEnrich?.cancelled;
    } finally {
      activeEnrich = null;
      jobState.isEnriching = false;
    }

    if (enrichCancelled) {
      setCurList(working);
      return finishStoppedJob();
    }

    const beforeInactive = working.length;
    working = working.filter((user) => !isInactiveAccount(user.last_active_ms, inactiveMonths));
    setCurList(working);
    const inactiveRemoved = beforeInactive - working.length;
    if (inactiveRemoved > 0) {
      parts.push(`inactive (${inactiveRemoved.toLocaleString()})`);
    }
    jobState.filterRemoved = curRaw().length - working.length;
    jobState.filterPhase = 'inactive';
    notifyProgress({
      reason: 'filtering',
      filterPhase: 'inactive',
      isEnriching: false,
      enrichProcessed: beforeInactive,
      enrichTotal: beforeInactive,
      status: `Remove inactive (${inactiveMonths} mo): ${working.length.toLocaleString()} remaining (−${inactiveRemoved.toLocaleString()})`
    });
    schedulePersist(true);
    if (!working.length) return finishEmptyFilter();
  }

  setCurList(working);
  jobState.filterRemoved = curRaw().length - curList().length;
  jobState.reason = 'filtered';
  jobState.filterPhase = null;
  jobState.isEnriching = false;

  notifyProgress({
    status: `Filtered: ${curList().length.toLocaleString()} remaining (removed ${jobState.filterRemoved.toLocaleString()}${parts.length ? ` — ${parts.join(', ')}` : ''})`
  });
  schedulePersist(true);

  return {
    ok: true,
    ...jobState,
    count: curList().length,
    rawCount: curRaw().length,
    removed: jobState.filterRemoved
  };
}

async function resolveUsernameForFetch(tabId, fallbackUsername = null) {
  const candidates = [
    fallbackUsername,
    tabId ? await detectHandle(tabId) : null,
    jobState.username,
    subscriptionInfo?.lastHandle
  ];

  for (const value of candidates) {
    const handle = String(value || '').replace(/^@+/, '').trim();
    if (handle) return handle;
  }

  return null;
}

async function resolveProfileViaTab(tabId, username) {
  const handle = String(username || '').replace(/^@+/, '');
  if (!tabId || !handle) return null;

  let totalFollowing = null;
  let totalFollowers = null;
  let userId = null;
  try {
    await ensureSnifferInstalled(tabId);

    const onProfile = await executeOnTab(tabId, (sn) => {
      const p = (location.pathname || '').toLowerCase();
      const base = `/${String(sn || '').replace(/^@+/, '').toLowerCase()}`;
      return p === base
        || p.startsWith(`${base}/`)
        || p.includes('/followers')
        || p.includes('/following');
    }, [handle]);

    if (!onProfile) {
      await chrome.tabs.update(tabId, { url: `https://x.com/${handle}`, active: true });
      await waitForTabComplete(tabId);
      await sleep(XC_PROFILE_NAV_SETTLE_MS);
      await ensureSnifferInstalled(tabId);
    }

    const scraped = await scrapeProfileStats(tabId, handle);
    totalFollowing = scraped.totalFollowing ?? null;
    totalFollowers = scraped.totalFollowers ?? null;
    userId = scraped.userId ?? null;
  } catch (error) {}

  const catalog = await prefetchQueryCatalog(false);

  if (!userId) {
    userId = await resolveUserIdFromScreenName(handle, catalog, tabId);
  }

  return {
    username: handle,
    userId: userId || null,
    totalFollowing,
    totalFollowers
  };
}

async function resolveProfileViaRest(fallbackUsername, tabId = null) {
  const session = await getXSessionCookies();
  if (!session.loggedIn) {
    throw new Error('Not logged in to X. Open x.com, sign in, then try again.');
  }

  const attempts = [];
  const cookies = await xcRestCollectAllCookies();
  let userIdFromCookie = xcRestParseUserIdFromCookies(cookies);
  const username = await resolveUsernameForFetch(tabId, fallbackUsername);

  if (tabId) {
    await ensureSnifferInstalled(tabId);
    const existingBearer = await xcRestReadBearerFromTab(tabId);
    if (!existingBearer) {
      await warmRestBearer(tabId);
    }
    await xcRestPrepareSession(tabId);
  }

  try {
    const creds = await xcRestVerifyCredentials({ tabId });
    appendDebugStatusLog({
      status: `REST verify_credentials OK — @${creds.screenName || fallbackUsername || '?'}`,
      method: 'rest-v1.1',
      reason: 'profile-loaded'
    });
    return {
      username: creds.screenName || fallbackUsername,
      userId: creds.userId,
      totalFollowing: creds.friendsCount ?? null,
      totalFollowers: creds.followersCount ?? null
    };
  } catch (error) {
    attempts.push(`verify_credentials: ${error.attemptSummary || error.message}`);
  }

  if (username) {
    try {
      const show = await xcRestUsersShow(username, { tabId });
      appendDebugStatusLog({
        status: `REST users/show OK — @${show.screenName} (verify_credentials unavailable)`,
        method: 'rest-v1.1',
        reason: 'profile-loaded'
      });
      return {
        username: show.screenName || username,
        userId: show.userId,
        totalFollowing: show.friendsCount ?? null,
        totalFollowers: show.followersCount ?? null
      };
    } catch (error) {
      attempts.push(`users/show: ${error.attemptSummary || error.message}`);
    }
  }

  let totalFollowing = null;
  let totalFollowers = null;
  let resolvedUserId = userIdFromCookie || null;

  if (tabId && username) {
    const tabProfile = await resolveProfileViaTab(tabId, username);
    if (tabProfile?.username) {
      totalFollowing = tabProfile.totalFollowing ?? totalFollowing;
      totalFollowers = tabProfile.totalFollowers ?? totalFollowers;
      resolvedUserId = tabProfile.userId || resolvedUserId;
    } else {
      attempts.push('tab: profile page scrape failed');
    }
  } else if (!username) {
    attempts.push('no username detected — open x.com/home while logged in');
  }

  if (username && tabId) {
    let probeOk = false;
    const probeBearer = await xcRestWaitForBearer(tabId, { maxMs: 12000 });
    if (probeBearer) {
      await sleep(2000);
      await xcRestPrepareSession(tabId);
    } else {
      attempts.push('list probe: bearer not captured yet (open x.com/home, wait for feed)');
    }
    for (const probeType of ['following', 'followers']) {
      if (!probeBearer) break;
      try {
        const probe = await xcRestFetchListPage(username, probeType, '-1', {
          tabId,
          pageSize: 5,
          preferTabContext: true,
          tabRetries: 2
        });
        const probeCount = probe.rawCount ?? probe.users?.length ?? 0;
        const winnerFailed = (probe?.attempts || []).some((line) => {
          const text = typeof line === 'string'
            ? line
            : `${line.strategy || ''}: ${line.error || line.detail || ''}`;
          const strategy = probe?.strategy || '';
          if (strategy && !text.includes(strategy.replace('tab@', ''))) return false;
          return /tab@x\.com:.*(authenticate you|Unauthorized|Forbidden)/i.test(text)
            || /tab:.*(authenticate you|Unauthorized|Forbidden)/i.test(text);
        });
        if (probe?.strategy && (probeCount > 0 || !winnerFailed)) {
          appendDebugStatusLog({
            status: `REST list probe OK — @${username} (${probe.strategy}, ${probeType}, ${probeCount} users on probe page)`,
            method: 'rest-v1.1',
            reason: 'profile-loaded'
          });
          probeOk = true;
          break;
        }
        if (probe?.attempts?.length) {
          attempts.push(`${probeType} probe: ${xcRestFormatAttempts(probe.attempts || [])}`);
        } else {
          attempts.push(`${probeType} probe: empty response`);
        }
      } catch (error) {
        attempts.push(`${probeType} probe: ${error.attemptSummary || error.message}`);
      }
    }
    if (probeOk) {
      return {
        username,
        userId: resolvedUserId,
        totalFollowing,
        totalFollowers
      };
    }
  }

  if (username) {
    appendDebugStatusLog({
      status: `REST profile: @${username} (account API blocked; list probe did not return users yet)`,
      method: 'rest-v1.1',
      reason: 'profile-loaded'
    });
    return {
      username,
      userId: resolvedUserId,
      totalFollowing,
      totalFollowers
    };
  }

  const summary = attempts.join(' | ');
  const err = new Error(
    `REST profile resolution failed. ${summary} — open x.com while logged in, or use Auto mode.`
  );
  err.attemptSummary = summary;
  appendDebugStatusLog({
    status: err.message,
    method: 'rest-v1.1',
    reason: 'error',
    error: err.message
  });
  throw err;
}

async function resolveProfileForFastFetch(tabId, fallbackUsername) {
  return resolveProfileViaRest(fallbackUsername, tabId);
}

async function runGraphqlWorkerListFetch(tabId, profile, type = listType) {
  const cfg = listCfg(type);
  const totalList = profile[cfg.totalKey] ?? jobState[cfg.totalKey] ?? null;
  const fetchTarget = effectiveFetchTarget(totalList);
  const seen = buildSeenFromCurList(type, profile.username);

  let userId = profile.userId;
  if (!userId) {
    const catalog = await prefetchQueryCatalog(false);
    userId = await resolveUserIdFromScreenName(profile.username, catalog);
    profile.userId = userId;
  }
  if (!userId) {
    throw new Error('Could not resolve user id for GraphQL worker fetch.');
  }

  const session = await getXSessionCookies();
  if (!session.ct0) {
    throw new Error('Missing ct0 cookie for GraphQL worker fetch.');
  }

  const catalog = await prefetchQueryCatalog(false);
  const opName = type === 'followers'
    ? (await resolveFollowersWorkerOpName(tabId, cfg.opName))
    : cfg.opName;
  const pageDelayMs = GRAPHQL_PAGE_DELAY_MS[type] || 600;
  let cursor = null;

  const tailResume = listResumeIsTailOnly(type, totalList);
  appendDebugStatusLogStart({
    status: tailResume
      ? `Tail-only GraphQL worker resume: ${curList(type).length.toLocaleString()} / ${totalList?.toLocaleString() || '—'} ${cfg.label} cached`
      : `Starting GraphQL worker ${cfg.label} collection`,
    reason: 'start',
    method: 'graphql-worker',
    listType: type
  });

  const opCandidates = type === 'followers'
    ? await followersWorkerOpCandidates(tabId)
    : [opName];

  jobState = {
    ...jobState,
    username: profile.username,
    listType: type,
    totalFollowing: profile.totalFollowing ?? jobState.totalFollowing,
    totalFollowers: profile.totalFollowers ?? jobState.totalFollowers,
    count: curList(type).length,
    isScraping: true,
    reason: 'collecting',
    method: 'graphql-worker',
    status: tailResume
      ? `GraphQL tail: ${curList(type).length.toLocaleString()} / ${totalList?.toLocaleString() || '—'} ${cfg.label.toLowerCase()}...`
      : `GraphQL worker: ${cfg.label} via ${opCandidates.join(' → ')} (${graphqlListPageCount(type)}/page)...`
  };

  if (tabId) {
    await sendHudMessage(tabId, { action: 'showHud', ...jobState }, 12);
  }
  notifyProgress({ status: jobState.status });

  let activeOpName = opCandidates[0];
  let pages = 0;

  for (let opIdx = 0; opIdx < opCandidates.length && !activeFetch?.cancelled; opIdx += 1) {
    activeOpName = opCandidates[opIdx];
    cursor = null;
    pages = 0;
    let gotUsers = false;

    if (opIdx > 0) {
      appendDebugStatusLog({
        status: `GraphQL worker switching to ${activeOpName}...`,
        reason: 'collecting',
        method: 'graphql-worker'
      });
      notifyProgress({
        status: `GraphQL worker retry with ${activeOpName}...`,
        method: 'graphql-worker'
      });
    }

    while (!activeFetch?.cancelled && pages < 500) {
      if (!listFetchNeedsMore(type, totalList)) break;

      const requestCount = graphqlRequestCount(type, totalList, curList(type).length);
      const res = await fetchListPageWorker({
        opName: activeOpName,
        userId,
        screenName: profile.username,
        cursor,
        count: requestCount,
        catalog,
        ct0: session.ct0,
        listPath: cfg.path
      });

      if (!res?.ok) {
        if (pages === 0 && opIdx < opCandidates.length - 1) break;
        throw new Error(res.error || `GraphQL worker failed (HTTP ${res.status || 0})`);
      }

      const parsedCount = (res.users || []).length;
      const added = addNativeUsers({ users: res.users || [] }, seen, profile.username, type);
      trimListToFetchLimit(type);
      pages += 1;
      if (parsedCount > 0) gotUsers = true;

      const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
      notifyProgress({
        reason: 'collecting',
        method: 'graphql-worker',
        pages,
        addedLastPage: added,
        status: `GraphQL worker ${activeOpName} p${pages}: ${curList(type).length.toLocaleString()} / ${totalLabel} (+${added}, parsed ${parsedCount})`
      });

      if (fetchTarget != null && curList(type).length >= fetchTarget) break;

      const nextCursor = res.nextCursor || null;
      if (!nextCursor || nextCursor === cursor) {
        if (added === 0 && parsedCount === 0) break;
        if (!nextCursor) break;
      }

      if (added === 0 && parsedCount === 0) break;

      cursor = nextCursor;
      await sleep(requestCount === 1 ? Math.min(pageDelayMs, 450) : pageDelayMs);
    }

    if (gotUsers || curList(type).length > 0 || !listFetchNeedsMore(type, totalList)) break;
  }

  snapshotListRaw(type);
  jobState.isScraping = false;
  jobState.reason = curList(type).length > 0 ? 'complete' : 'rest-empty';
  jobState.method = 'graphql-worker';
  jobState.count = curList(type).length;
  jobState.status = curList(type).length > 0
    ? `GraphQL worker complete — ${curList(type).length.toLocaleString()} ${cfg.label.toLowerCase()} (${pages} pages, ${activeOpName})`
    : `GraphQL worker returned 0 (${opCandidates.join(' → ')})`;
  notifyProgress({ status: jobState.status });

  return {
    ok: curList(type).length > 0,
    count: curList(type).length,
    pages,
    method: 'graphql-worker',
    opName: activeOpName
  };
}

async function warmRestBearer(tabId) {
  await ensureSnifferInstalled(tabId);
  const existing = await xcRestReadBearerFromTab(tabId);
  if (existing && existing.length > 20) return existing;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isXTabUrl(tab?.url)) {
      await chrome.tabs.update(tabId, { url: 'https://x.com/home' });
      await waitForTabComplete(tabId);
    } else if (!/\/home|\/i\//.test(tab.url || '')) {
      await chrome.tabs.update(tabId, { url: 'https://x.com/home' });
      await waitForTabComplete(tabId);
    } else {
      await executeOnTab(tabId, () => {
        location.reload();
      });
      await waitForTabComplete(tabId);
    }
    await sleep(XC_PRE_LIST_FETCH_SETTLE_MS);
    await ensureSnifferInstalled(tabId);
    await xcRestPrepareSession(tabId);
  } catch (error) {}

  return xcRestReadBearerFromTab(tabId);
}

async function runRestListFetch(tabId, profile, type = listType, options = {}) {
  const cfg = listCfg(type);
  const totalList = profile[cfg.totalKey] ?? jobState[cfg.totalKey] ?? null;
  const fetchTarget = effectiveFetchTarget(totalList);
  const restPageSize = totalList != null && totalList > 0 && totalList <= XC_REST_PAGE_SIZE
    ? totalList
    : XC_REST_PAGE_SIZE;
  const cachedCount = curList(type).length;
  const tailOnly = !!(
    options.tailOnly
    || (cachedCount > 0 && totalList != null && cachedCount < totalList)
  );
  const seen = buildSeenFromCurList(type, profile.username);

  appendDebugStatusLogStart({
    status: tailOnly
      ? `Tail-only resume: ${cachedCount.toLocaleString()} / ${totalList?.toLocaleString() || '—'} ${cfg.label} cached`
      : `Starting REST ${cfg.label} collection`,
    reason: 'start',
    method: 'rest-v1.1',
    listType: type
  });

  jobState = {
    ...jobState,
    username: profile.username,
    listType: type,
    totalFollowing: profile.totalFollowing ?? jobState.totalFollowing,
    totalFollowers: profile.totalFollowers ?? jobState.totalFollowers,
    count: cachedCount,
    isScraping: true,
    reason: 'collecting',
    method: 'rest-v1.1',
    status: tailOnly
      ? `Tail fetch: ${cachedCount.toLocaleString()} / ${totalList?.toLocaleString() || '—'} ${cfg.label.toLowerCase()}...`
      : `REST fetch: ${cfg.label} (${restPageSize}/page)...`
  };

  if (tabId) {
    await sendHudMessage(tabId, {
      action: 'showHud',
      ...jobState
    }, 12);
  }
  notifyProgress({ status: jobState.status });

  if (tabId) {
    await ensureSnifferInstalled(tabId);
    await warmRestListPageContext(tabId, profile, type);
    let bearer = await xcRestResolveBearer(tabId, { requireCaptured: true });
    if (!bearer) {
      await warmRestBearer(tabId);
      bearer = await xcRestResolveBearer(tabId, { requireCaptured: true });
    }
    appendDebugStatusLog({
      status: bearer
        ? `REST session ready (captured bearer, ${bearer.length} chars)`
        : 'REST session not ready — open x.com/home, wait for feed, then retry',
      method: 'rest-v1.1'
    });
    if (!bearer) {
      throw new Error('No captured X bearer token. Open x.com/home, let the feed load (triggers API calls), then retry REST fetch.');
    }

    try {
      if (totalList != null && totalList <= 100) {
        const domPre = await collectVisibleListUsersFromTab(tabId, profile.username);
        const domAdded = addNativeUsers({ users: domPre?.users || [] }, seen, profile.username, type);
        trimListToFetchLimit(type);
        if (domAdded > 0) {
          const totalLabel = totalList.toLocaleString();
          notifyProgress({
            reason: 'collecting',
            method: 'rest-v1.1',
            addedLastPage: domAdded,
            status: `DOM pre-load: ${curList(type).length.toLocaleString()} / ${totalLabel} (+${domAdded})`
          });
        }
      }

      const preDrain = await readNativeListQueueDrainFromTab(tabId, cfg.opName);
      if (preDrain?.users?.length) {
        const preAdded = addNativeUsers({ users: preDrain.users }, seen, profile.username, type);
        trimListToFetchLimit(type);
        const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
        notifyProgress({
          reason: 'collecting',
          method: 'rest-v1.1',
          addedLastPage: preAdded,
          status: preAdded > 0
            ? `Sniffer pre-load: ${curList(type).length.toLocaleString()} / ${totalLabel} (+${preAdded})`
            : `Sniffer pre-load: ${preDrain.users.length} captured, ${preAdded} new (already had ${curList(type).length})`
        });
      }
    } catch (error) {}
  }

  if (tailOnly) {
    let result = {
      collected: curList(type).length,
      pages: 0,
      shortfall: totalList != null ? Math.max(0, totalList - curList(type).length) : 0,
      attemptSummary: 'tail-resume'
    };
    if (totalList != null && curList(type).length < totalList && tabId) {
      const chain = await recoverShortfallChain(tabId, profile, type, seen, totalList, { skipWarmup: true });
      if (chain.summary) {
        result.attemptSummary = `tail-resume (${chain.summary})`;
      }
      result.collected = curList(type).length;
      result.shortfall = Math.max(0, totalList - curList(type).length);
    }
    snapshotListRaw(type);
    jobState.isScraping = false;
    jobState.reason = curList(type).length > 0 ? 'complete' : 'rest-empty';
    jobState.method = 'rest-v1.1';
    jobState.count = curList(type).length;
    jobState.restAttemptSummary = result.attemptSummary || null;
    const shortBy = result.shortfall || 0;
    jobState.status = curList(type).length > 0
      ? shortBy > 0
        ? `REST tail — ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} ${cfg.label.toLowerCase()} (short by ${shortBy})`
        : `REST tail complete — ${curList(type).length.toLocaleString()} ${cfg.label.toLowerCase()}`
      : `REST tail returned 0 — ${result.attemptSummary || 'no new users'}`;
    notifyProgress({ status: jobState.status });
    persistListState(type).catch(() => {});
    return {
      ok: curList(type).length > 0,
      count: curList(type).length,
      pages: result.pages,
      method: 'rest-v1.1',
      attemptSummary: result.attemptSummary || null
    };
  }

  let result;
  const restAlreadyComplete = totalList != null && curList(type).length >= totalList;
  try {
    if (restAlreadyComplete) {
      result = {
        collected: curList(type).length,
        pages: 0,
        shortfall: 0,
        attemptSummary: 'sniffer pre-load'
      };
    } else {
    result = await xcRestFetchFullList(profile.username, type, {
      pageSize: restPageSize,
      pageDelayMs: XC_REST_PAGE_DELAY_MS,
      maxUsers: fetchTarget,
      knownTotal: totalList,
      userId: profile.userId,
      tabId,
      shouldCancel: () => isJobCancelled(),
      onPage: async (info) => {
        throwIfCancelled();

        if (info.rateLimited) {
          notifyProgress({
            reason: 'collecting',
            method: 'rest-v1.1',
            status: `Rate limited — waiting ${Math.round((info.waitingMs || 0) / 1000)}s...`
          });
          return;
        }

        const added = addNativeUsers({ users: info.users || [] }, seen, profile.username, type);
        trimListToFetchLimit(type);

        const totalLabel = totalList != null ? totalList.toLocaleString() : '—';
        const strategyNote = info.strategy ? ` [${info.strategy}]` : '';
        const recoveryNote = info.shortfallRecovery
          ? ` (tail recovery${info.shortfallLabel ? `: ${info.shortfallLabel}` : ''})`
          : '';
        notifyProgress({
          reason: 'collecting',
          method: 'rest-v1.1',
          addedLastPage: added,
          restPage: info.page,
          status: `REST page ${info.page}: ${curList(type).length.toLocaleString()} / ${totalLabel} (+${added})${strategyNote}${recoveryNote}`
        });
      }
    });
    }
  } catch (error) {
    if (curList(type).length > 0) {
      result = {
        collected: curList(type).length,
        pages: jobState.restPage || 1,
        shortfall: totalList != null ? Math.max(0, totalList - curList(type).length) : 0,
        partialError: error.message || String(error),
        attemptSummary: error.attemptSummary || error.message || null
      };
    } else {
      throw error;
    }
  }

  let shortBy = totalList != null && curList(type).length < totalList
    ? totalList - curList(type).length
    : (result.shortfall || 0);

  if (shortBy > 0 && shortBy <= 100 && tabId) {
    const chain = await recoverShortfallChain(tabId, profile, type, seen, totalList, { skipWarmup: true });
    if (chain.totalAdded > 0) {
      shortBy = totalList != null ? Math.max(0, totalList - curList(type).length) : 0;
      const tailNote = `shortfall (${chain.summary})`;
      result.attemptSummary = result.attemptSummary
        ? `${result.attemptSummary} | ${tailNote}`
        : tailNote;
    }
  }

  snapshotListRaw(type);
  jobState.isScraping = false;
  jobState.reason = curList(type).length > 0 ? 'complete' : 'rest-empty';
  jobState.method = 'rest-v1.1';
  jobState.count = curList(type).length;
  jobState.restAttemptSummary = result.attemptSummary || null;
  const authBlocked = /authenticate you|page does not exist|Unauthorized|Forbidden/i.test(result.attemptSummary || '');
  const partialNote = result.partialError ? `; page error: ${result.partialError}` : '';
  jobState.status = curList(type).length > 0
    ? shortBy > 0
      ? `REST complete — ${curList(type).length.toLocaleString()} / ${totalList.toLocaleString()} ${cfg.label.toLowerCase()} (${result.pages} pages; short by ${shortBy}${partialNote})`
      : `REST complete — ${curList(type).length.toLocaleString()} ${cfg.label.toLowerCase()} (${result.pages} pages${partialNote})`
    : authBlocked
      ? `REST v1.1 blocked for this session (${result.attemptSummary || 'auth failed'}) — use Auto mode`
      : `REST returned 0 — ${result.attemptSummary || 'all strategies empty'}`;
  notifyProgress({ status: jobState.status });

  return {
    ok: curList(type).length > 0,
    count: curList(type).length,
    pages: result.pages,
    method: 'rest-v1.1',
    attemptSummary: result.attemptSummary || null
  };
}

async function runExportFlow(requestedType = listType, options = {}) {
  if (activeFetch?.running) {
    return { ok: false, error: 'Collection already running.' };
  }

  const type = LIST_CONFIG[requestedType] ? requestedType : listType;
  const cfg = listCfg(type);
  const fetchMode = normalizeFetchMode(options.fetchMode || (await getFetchMode()));

  const tab = await findFocusedXTab();
  if (!tab?.id) {
    return { ok: false, error: 'No X tab found. Open x.com in a browser tab first.' };
  }

  jobTabId = tab.id;
  listType = type;
  jobState.listType = type;
  jobState.fetchMode = fetchMode;

  let username = await detectHandle(tab.id);
  await alignAccountForJob(username || '');

  if (options.forceRefresh) {
    setCurList([], type);
    setCurRaw([], type);
    restoredTypes[type] = false;
    await clearListPersist(type);
    if (type === listType) {
      jobState.count = 0;
      jobState.rawCount = 0;
      jobState.savedAt = null;
    }
  } else {
    await restoreListState(type);
    if (!curList(type).length) {
      await restoreListState(type, { username });
    }
  }

  const cachedCount = curList(type).length;

  resetDebugStatusLog({
    status: options.forceRefresh
      ? `Fresh start — cleared cached ${cfg.label.toLowerCase()} (${fetchMode} mode)`
      : cachedCount > 0
        ? `Resuming — ${cachedCount.toLocaleString()} ${cfg.label} cached (${fetchMode} mode)`
        : `Collection started — ${fetchMode} mode, ${cfg.label}`,
    reason: 'start',
    fetchMode,
    listType: type
  });

  await hydrateSubscriptionFromStorage(username);
  refreshSubscription(username, false).catch(() => {});

  try {
    activeFetch = { running: true, cancelled: false };

    let profile = null;
    let fastFetchSucceeded = false;

    if (fetchMode === 'rest' || fetchMode === 'auto') {
      jobState = {
        username: username || null,
        listType: type,
        totalFollowing: null,
        totalFollowers: null,
        count: 0,
        isScraping: true,
        reason: 'loading-profile',
        method: 'rest-v1.1',
        fetchMode
      };
      notifyProgress({ status: 'Resolving session (REST profile)...' });
      await ensureSnifferInstalled(tab.id);

      try {
        profile = await resolveProfileForFastFetch(tab.id, username);
        username = profile.username || username;
        jobState.username = username;
        await alignAccountForJob(username);

        jobState.totalFollowing = profile.totalFollowing;
        jobState.totalFollowers = profile.totalFollowers;
        jobState.reason = 'profile-loaded';

        const totalForFetch = profile[cfg.totalKey];
        const totalLabel = totalForFetch != null ? totalForFetch.toLocaleString() : '—';
        const resumeCount = curList(type).length;
        const tailOnly = resumeCount > 0
          && totalForFetch != null
          && resumeCount < totalForFetch;

        if (resumeCount > 0 && totalForFetch != null && resumeCount >= totalForFetch) {
          jobState.count = resumeCount;
          jobState.reason = 'complete';
          jobState.isScraping = false;
          jobState.status = `Already have ${resumeCount.toLocaleString()} ${cfg.label.toLowerCase()} — skipping fetch`;
          notifyProgress({ status: jobState.status });
          fastFetchSucceeded = true;
          await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
          persistListState(type).catch(() => {});
          return {
            ok: true,
            ...jobState,
            count: resumeCount,
            mutuals: computeMutuals(),
            fetchMode,
            ...subscriptionPayload(),
            ...debugStatusPayload()
          };
        }

        notifyProgress({
          status: tailOnly
            ? `Logged in as @${username} • tail fetch ${cfg.label.toLowerCase()} (${resumeCount}/${totalLabel})`
            : `Logged in as @${username} • REST fetch ${cfg.label.toLowerCase()} (${totalLabel})`
        });

        const restResult = await runRestListFetch(tab.id, profile, type, { tailOnly });

        if (restResult.ok) {
          fastFetchSucceeded = true;
          await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
          return {
            ok: true,
            ...jobState,
            count: curList().length,
            mutuals: computeMutuals(),
            fetchMode,
            ...subscriptionPayload(),
            ...debugStatusPayload()
          };
        }

        if (fetchMode === 'auto') {
          notifyProgress({
            status: curList(type).length > 0
              ? `REST short (${restResult.attemptSummary || 'partial'}) — tail via GraphQL worker...`
              : `REST empty (${restResult.attemptSummary || 'no users'}) — trying GraphQL worker...`
          });
          resetListForFreshFallback(type);

          const gqlResult = await runGraphqlWorkerListFetch(tab.id, profile, type);
          if (gqlResult.ok) {
            fastFetchSucceeded = true;
            await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
            return {
              ok: true,
              ...jobState,
              count: curList().length,
              mutuals: computeMutuals(),
              fetchMode,
              ...subscriptionPayload(),
              ...debugStatusPayload()
            };
          }

          notifyProgress({
            status: curList(type).length > 0
              ? 'GraphQL worker short — finishing tail via native sniffer...'
              : 'GraphQL worker returned 0 — falling back to native sniffer...'
          });
          resetListForFreshFallback(type);
        } else {
          await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
          return {
            ok: false,
            error: restResult.attemptSummary
              ? `REST fetch returned no accounts (${restResult.attemptSummary}).`
              : 'REST fetch returned no accounts.',
            ...jobState,
            count: curList().length,
            mutuals: computeMutuals(),
            fetchMode,
            ...subscriptionPayload(),
            ...debugStatusPayload()
          };
        }
      } catch (restError) {
        if (fetchMode === 'rest') {
          throw restError;
        }

        notifyProgress({
          status: curList(type).length > 0
            ? `REST failed (${restError.message}) — tail via GraphQL worker...`
            : `REST failed (${restError.message}) — trying GraphQL worker...`
        });
        resetListForFreshFallback(type);

        try {
          if (!profile?.userId && !profile?.username) {
            profile = await resolveProfileForFastFetch(tab.id, username);
            username = profile.username || username;
            jobState.username = username;
          }
          const gqlResult = await runGraphqlWorkerListFetch(tab.id, profile, type);
          if (gqlResult.ok) {
            fastFetchSucceeded = true;
            await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
            return {
              ok: true,
              ...jobState,
              count: curList().length,
              mutuals: computeMutuals(),
              fetchMode,
              ...subscriptionPayload(),
              ...debugStatusPayload()
            };
          }
        } catch (gqlError) {
          notifyProgress({
            status: `GraphQL worker failed (${gqlError.message}) — falling back to native sniffer...`
          });
        }

        resetListForFreshFallback(type);
        profile = profile || null;
      }
    }

    if (fetchMode === 'sniffer' || (fetchMode === 'auto' && !fastFetchSucceeded)) {
      if (!username) {
        username = await detectHandle(tab.id);
        if (!username) {
          return {
            ok: false,
            error: 'Could not detect your X username. Open x.com/home or your profile, then try again.'
          };
        }
      }

      jobState = {
        username,
        listType: type,
        totalFollowing: profile?.totalFollowing ?? null,
        totalFollowers: profile?.totalFollowers ?? null,
        count: curList(type).length,
        isScraping: true,
        reason: 'loading-profile',
        method: 'native-sniffer',
        fetchMode
      };
      await sendHudMessage(tab.id, {
        action: 'showHud',
        ...jobState,
        status: 'Opening your profile...'
      }, 8);
      notifyProgress({ status: 'Opening your profile...' });

      throwIfCancelled();

      await chrome.tabs.update(tab.id, {
        url: `https://x.com/${username}`,
        active: true
      });
      await waitAfterTabNavigation(tab.id, XC_PROFILE_NAV_SETTLE_MS);
      throwIfCancelled();

      profile = await scrapeProfileStats(tab.id, username);
      throwIfCancelled();
      if (!profile.userId) {
        const catalog = await prefetchQueryCatalog(false);
        profile.userId = await resolveUserIdFromScreenName(profile.username || username, catalog);
      }
      const totalForFetch = profile[cfg.totalKey];
      if (totalForFetch == null && profile.userId == null) {
        throw new Error('Could not read your profile on X. Confirm you are logged in and try again.');
      }

      jobState = {
        username: profile.username || username,
        listType: type,
        totalFollowing: profile.totalFollowing,
        totalFollowers: profile.totalFollowers,
        count: curList(type).length,
        isScraping: true,
        reason: 'profile-loaded',
        method: 'native-sniffer',
        fetchMode
      };
      const totalLabel = totalForFetch != null ? totalForFetch.toLocaleString() : '—';
      await sendHudMessage(tab.id, {
        action: 'updateHud',
        ...jobState,
        status: `Logged in as @${jobState.username} • ${totalLabel} ${cfg.label.toLowerCase()}`
      }, 12);
      notifyProgress({
        status: `Logged in as @${jobState.username} • opening ${cfg.label}...`
      });
      await sleep(XC_PRE_LIST_FETCH_SETTLE_MS);
      throwIfCancelled();

      await runNativeListFetch(tab.id, {
        username: jobState.username,
        totalFollowing: profile.totalFollowing,
        totalFollowers: profile.totalFollowers,
        userId: profile.userId
      }, type);
    }

    await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
    persistDebugStatusLog();
    return {
      ok: true,
      ...jobState,
      count: curList().length,
      mutuals: computeMutuals(),
      fetchMode,
      ...subscriptionPayload(),
      ...debugStatusPayload()
    };
  } catch (error) {
    if (isCancelledError(error)) {
      return finishStoppedJob();
    }
    jobState.isScraping = false;
    jobState.reason = 'error';
    const errorText = String(error.message || error);
    const errorDetail = error.attemptSummary ? `${errorText} (${error.attemptSummary})` : errorText;
    notifyProgress({ status: errorDetail, error: errorDetail, reason: 'error' });
    persistDebugStatusLog();
    return {
      ok: false,
      error: errorDetail,
      ...jobState,
      ...subscriptionPayload(),
      ...debugStatusPayload()
    };
  } finally {
    activeFetch = null;
  }
}

function isJobCancelled() {
  return !!(activeFetch?.cancelled || activeEnrich?.cancelled);
}

function throwIfCancelled() {
  if (isJobCancelled()) {
    const error = new Error('Job cancelled');
    error.code = 'XC_CANCELLED';
    throw error;
  }
}

function isCancelledError(error) {
  return error?.code === 'XC_CANCELLED' || isJobCancelled();
}

function finishStoppedJob(status = 'Stopped.') {
  jobState.isScraping = false;
  jobState.isEnriching = false;
  jobState.filterPhase = null;
  jobState.reason = 'stopped';
  notifyProgress({ status, reason: 'stopped' });
  persistDebugStatusLog();
  schedulePersist(true);
  return {
    ok: true,
    ...jobState,
    count: curList().length,
    reason: 'stopped',
    ...debugStatusPayload()
  };
}

async function stopScrape() {
  let hadActiveWork = false;

  if (activeFetch) {
    activeFetch.cancelled = true;
    hadActiveWork = true;
  }

  if (activeEnrich) {
    activeEnrich.cancelled = true;
    hadActiveWork = true;
  }

  if (
    jobState.isScraping ||
    jobState.isEnriching ||
    jobState.reason === 'filtering' ||
    jobState.reason === 'enriching' ||
    jobState.reason === 'loading-profile' ||
    jobState.reason === 'profile-loaded' ||
    jobState.reason === 'waiting-native' ||
    jobState.reason === 'collecting'
  ) {
    hadActiveWork = true;
  }

  if (hadActiveWork) {
    return finishStoppedJob();
  }

  jobState.isScraping = false;
  jobState.isEnriching = false;
  jobState.reason = 'stopped';
  notifyProgress();
  return { ok: true, ...jobState, count: curList().length, reason: 'stopped' };
}

async function exportCSV() {
  await ensureRestored();

  if (!curList().length) {
    return { ok: false, error: `No ${listCfg().label.toLowerCase()} collected yet.` };
  }

  await refreshSubscription(jobState.username);
  if (!subscriptionInfo.canExport) {
    return {
      ok: false,
      error: `Export requires a @d2fl subscription. Subscribe at ${XC_PRO_CHECKOUT_URL}`,
      ...subscriptionPayload()
    };
  }

  if (!(await ensureJobTabId())) {
    return { ok: false, error: 'No X tab available for download.' };
  }

  const owner = jobState.username || 'user';
  const cfg = listCfg();
  const filename = `x_${cfg.path}_${owner}_${new Date().toISOString().slice(0, 10)}.csv`;
  const csvContent = buildCsv(curList());

  await executeOnTab(jobTabId, injectedXCleanerApiCall, [{
    action: 'downloadCsv',
    csvContent,
    filename
  }]);

  jobState.reason = 'exported';
  notifyProgress();
  return { ok: true, ...jobState, count: curList().length, exported: true, filename };
}

async function getStatusAsync() {
  await restoreDebugStatusLogFromStorage();
  if (jobState.username) {
    await hydrateSubscriptionFromStorage(jobState.username);
  }
  const fetchMode = await getFetchMode();
  const storedCounts = {
    following: listStore.following.list.length,
    followers: listStore.followers.list.length
  };
  return {
    ok: true,
    ...jobState,
    listType,
    count: curList().length,
    rawCount: curRaw().length || curList().length,
    totalList: totalForType(),
    storedCounts,
    restoredFromStorage: restoredFromStorage(),
    restoredTypes: { ...restoredTypes },
    mutuals: computeMutuals(),
    fetchTarget: effectiveFetchTarget(totalForType()),
    fetchMode,
    fetchModeLabel: fetchModeLabel(fetchMode),
    ...subscriptionPayload(),
    ...debugStatusPayload()
  };
}

function getStatus() {
  const storedCounts = {
    following: listStore.following.list.length,
    followers: listStore.followers.list.length
  };
  return {
    ok: true,
    ...jobState,
    listType,
    count: curList().length,
    rawCount: curRaw().length || curList().length,
    totalList: totalForType(),
    storedCounts,
    restoredFromStorage: restoredFromStorage(),
    restoredTypes: { ...restoredTypes },
    mutuals: computeMutuals(),
    fetchTarget: effectiveFetchTarget(totalForType()),
    fetchMode: jobState.fetchMode || XC_FETCH_MODE_DEFAULT,
    fetchModeLabel: fetchModeLabel(jobState.fetchMode || XC_FETCH_MODE_DEFAULT),
    ...subscriptionPayload(),
    ...debugStatusPayload()
  };
}

async function restoreDebugStatusLogFromStorage() {
  if (!XC_DEBUG_STATUS_LOG) return;
  try {
    const stored = await chrome.storage.local.get(XC_DEBUG_STATUS_LOG_STORAGE_KEY);
    const lines = stored[XC_DEBUG_STATUS_LOG_STORAGE_KEY];
    if (!Array.isArray(lines) || !lines.length) return;
    const storedLines = lines.slice(-XC_DEBUG_STATUS_LOG_MAX_LINES);
    const current = Array.isArray(jobState.debugStatusLog) ? jobState.debugStatusLog : [];
    jobState.debugStatusLog = current.length >= storedLines.length ? current : storedLines;
  } catch (error) {}
}

async function bootstrapSubscription() {
  await syncActiveAccountFromTab({ refreshSub: false });
  await restoreDebugStatusLogFromStorage();
  if (jobState.username) {
    await restoreAllListState();
    await hydrateSubscriptionFromStorage(jobState.username);
  }
  refreshSubscription(null, false).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Cleaner v0.80 installed (REST tab-context + PlugMonkey-style session)');
  bootstrapSubscription().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapSubscription().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'scrapeStatus') {
    return false;
  }

  (async () => {
    if (message.action === 'syncFromFocusedTab') {
      await syncActiveAccountFromTab({
        tabId: message.tabId,
        username: message.username || null,
        refreshSub: message.refreshSub !== false,
        forceSubRefresh: !!message.force
      });
      notifyProgress();
      sendResponse({ ok: true, ...getStatus() });
      return;
    }

    await ensureRestored();

    switch (message.action) {
      case 'runExportFlow':
        sendResponse(await runExportFlow(message.listType || listType, {
          fetchMode: message.fetchMode,
          forceRefresh: !!message.forceRefresh
        }));
        break;
      case 'stopScrape':
        sendResponse(await stopScrape());
        break;
      case 'exportCSV':
        sendResponse(await exportCSV());
        break;
      case 'setListType':
        sendResponse(await setListType(message.listType));
        break;
      case 'filterFollowingList':
      case 'filterList':
        sendResponse(await filterList({
          removeBlue: !!message.removeBlue,
          removeNew: !!message.removeNew,
          removeInactive: !!message.removeInactive,
          newAccountMonths: message.newAccountMonths,
          inactiveMonths: message.inactiveMonths
        }));
        break;
      case 'getMutuals':
        sendResponse({ ok: true, ...computeMutuals() });
        break;
      case 'checkSubscription':
        if (message.syncFromTab) {
          await syncActiveAccountFromTab({
            tabId: message.tabId,
            username: message.username || null,
            refreshSub: true,
            forceSubRefresh: !!message.force
          });
        } else {
          await refreshSubscription(message.username || null, !!message.force);
        }
        notifyProgress();
        sendResponse({ ok: true, ...getStatus() });
        break;
      case 'setFetchMode':
        sendResponse({
          ok: true,
          fetchMode: await setFetchMode(message.fetchMode),
          ...(await getStatusAsync())
        });
        break;
      case 'getStatus':
      case 'getJobState':
        await restoreDebugStatusLogFromStorage();
        sendResponse(await getStatusAsync());
        break;
      case 'openSubscribe':
        chrome.tabs.create({
          url: subscriptionInfo.checkoutUrl || XC_PRO_CHECKOUT_URL,
          active: true
        });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: 'Unknown action.' });
    }
  })();

  return true;
});