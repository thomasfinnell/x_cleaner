importScripts('subscription.js', 'api-fetch.js');

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

const NEW_ACCOUNT_MONTHS = 6;
const INACTIVE_MONTHS = 6;
const ENRICH_BATCH_SIZE = 8;
const ENRICH_BATCH_DELAY_MS = 4500;
const XC_ACTIVITY_CACHE_KEY = 'xc_activity_cache';
const XC_ACTIVITY_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const XC_LIST_TYPE_PREF_KEY = 'xc_list_type_pref';
const XC_PERSIST_VERSION = 1;
const XC_PERSIST_COLLECT_INTERVAL = 250;
const XC_PERSIST_DEBOUNCE_MS = 15000;

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
  const forceNavigate = !!options.forceNavigate;
  const passiveOnly = !!options.passiveOnly;

  if (!tabId) return { ok: false, handles: [] };

  await ensureSnifferInstalled(tabId);

  const existing = await executeOnTab(tabId, readCreatorSubscriptionsCapture);
  if (existing?.ok) {
    return { ok: true, handles: existing.handles || [], capturedAt: existing.capturedAt };
  }

  if (passiveOnly && !forceNavigate) {
    return { ok: false, handles: [] };
  }

  await executeOnTab(tabId, () => {
    try {
      sessionStorage.removeItem('xc_creator_subs_latest');
    } catch (error) {}
  });

  await chrome.tabs.update(tabId, { url: XC_SUBSCRIPTIONS_PAGE_URL });
  await waitForTabComplete(tabId);
  await sleep(2000);

  const captured = await waitForCreatorSubscriptionsCapture(tabId, 14000);
  if (captured?.ok) {
    return { ok: true, handles: captured.handles || [], capturedAt: captured.capturedAt };
  }

  return { ok: false, handles: [] };
}

async function resolveActiveUsername(explicitHandle) {
  if (explicitHandle) return explicitHandle;
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

async function refreshSubscription(handle, forceCheck = false) {
  const resolvedHandle = await resolveActiveUsername(handle);
  const tabId = await ensureJobTabId();

  subscriptionInfo = await xcCheckSubscription(resolvedHandle, {
    forceCheck,
    sniff: tabId
      ? () => sniffCreatorSubscriptions(tabId, {
        forceNavigate: forceCheck,
        passiveOnly: !forceCheck
      })
      : null
  });

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

function addNativeUsers(nativeBatch, seen, ownerUsername) {
  let added = 0;
  const owner = (ownerUsername || '').toLowerCase();

  for (const user of nativeBatch.users || []) {
    const key = (user.username || '').toLowerCase();
    if (!key || key === owner || seen.has(key)) continue;
    seen.add(key);
    curList().push(user);
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

      const followersLink = document.querySelector(
        'a[href$="/verified_followers"], a[href*="/followers"], a[href*="/verified_followers"]'
      );
      if (followersLink) {
        followers = parseCountText(followersLink.textContent || followersLink.innerText || '');
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

function escapeCsvField(value) {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str.replace(/\r?\n/g, ' ')}"`;
}

function parseAccountCreatedAt(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function isNewAccount(createdAt, months = NEW_ACCOUNT_MONTHS) {
  const ts = parseAccountCreatedAt(createdAt);
  if (ts == null) return false;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return ts > cutoff.getTime();
}

function isInactiveAccount(lastActiveMs, months = INACTIVE_MONTHS) {
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
  const catalog = await prefetchQueryCatalog(false);
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

  for (let i = 0; i < needsLookup.length; i += ENRICH_BATCH_SIZE) {
    if (activeEnrich?.cancelled) break;

    const batch = needsLookup.slice(i, i + ENRICH_BATCH_SIZE);
    const q = batch.map((user) => `from:${user.username}`).join(' OR ');

    try {
      const res = await searchLastActiveBatch(
        tabId,
        q,
        Math.max(20, batch.length * 3),
        catalog
      );

      if (res?.ok && res.lastActive) {
        for (const [sn, ts] of Object.entries(res.lastActive)) {
          cache[sn] = { last_active_ms: ts, fetched_at: now };
        }
      }
    } catch (error) {
      console.warn('[X Cleaner] activity batch failed', error);
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
  const { removeBlue = false, removeNew = false } = options;
  if (!removeBlue && !removeNew) return source.slice();

  return source.filter((user) => {
    if (removeBlue && user.is_blue) return false;
    if (removeNew && isNewAccount(user.created_at)) return false;
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

async function restoreListState(type) {
  if (curList(type).length || activeFetch?.running) return false;

  const cfg = listCfg(type);

  try {
    const res = await chrome.storage.local.get(cfg.persistKey);
    const data = res[cfg.persistKey];
    const accounts = data?.accountList || data?.followingList;
    if (!accounts?.length) return false;

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
      jobState.reason = saved.jobState.reason ?? jobState.reason;
      jobState.filterRemoved = saved.jobState.filterRemoved ?? 0;
      jobState.totalFollowing = saved.jobState.totalFollowing ?? jobState.totalFollowing;
      jobState.totalFollowers = saved.jobState.totalFollowers ?? jobState.totalFollowers;
      jobState.username = saved.jobState.username ?? jobState.username;
    }
  } else {
    jobState.savedAt = null;
  }

  await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: nextType });
  notifyProgress();
  return getStatus();
}

function computeMutuals() {
  const followingSet = new Set(
    listStore.following.raw.length
      ? listStore.following.raw.map((u) => (u.username || '').toLowerCase())
      : listStore.following.list.map((u) => (u.username || '').toLowerCase())
  );
  const followersSet = new Set(
    listStore.followers.raw.length
      ? listStore.followers.raw.map((u) => (u.username || '').toLowerCase())
      : listStore.followers.list.map((u) => (u.username || '').toLowerCase())
  );

  const mutuals = [];
  for (const name of followingSet) {
    if (name && followersSet.has(name)) {
      mutuals.push(name);
    }
  }

  return {
    followingCount: followingSet.size,
    followersCount: followersSet.size,
    mutualCount: mutuals.length,
    hasBoth: followingSet.size > 0 && followersSet.size > 0
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

function buildCsv(users) {
  const header =
    'username,display_name,friends_count,followers_count,tweet_count,created_at,is_blue,default_avatar,last_tweet_at\n';
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

function notifyProgress(extra = {}) {
  jobState = {
    ...jobState,
    listType,
    count: curList().length,
    rawCount: curRaw().length || curList().length,
    ...extra
  };

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
    ...subscriptionPayload()
  };

  chrome.runtime.sendMessage(payload).catch(() => {});

  if (jobTabId) {
    sendHudMessage(jobTabId, { action: 'updateHud', ...jobState }).catch(() => {});
  }

  schedulePersist();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== jobTabId || changeInfo.status !== 'complete') return;
  if (!jobState.username && !jobState.isScraping) return;

  ensureSnifferInstalled(tabId)
    .then(() => sendHudMessage(tabId, { action: 'updateHud', ...jobState, count: curList().length }, 12))
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

async function runNativeListFetch(tabId, profile, type = listType) {
  const session = await getXSessionCookies();
  if (!session.loggedIn) {
    throw new Error('Not logged in to X. Open x.com, sign in, then try again.');
  }

  const cfg = listCfg(type);
  const totalList = profile[cfg.totalKey];
  const resolvedUsername = profile.username;

  await executeOnTab(tabId, (opName) => {
    try {
      sessionStorage.removeItem(`xc_list_queue_${opName}`);
      sessionStorage.removeItem(`xc_list_latest_${opName}`);
    } catch (error) {}
  }, [cfg.opName]);

  await chrome.tabs.update(tabId, {
    url: `https://x.com/${resolvedUsername}/${cfg.path}`,
    active: true
  });
  await waitForTabComplete(tabId);
  await sleep(1500);
  await ensureSnifferInstalled(tabId);

  const hudState = {
    action: 'showHud',
    username: resolvedUsername,
    listType: type,
    totalFollowing: profile.totalFollowing,
    totalFollowers: profile.totalFollowers,
    count: 0,
    isScraping: true,
    reason: 'waiting-native',
    method: 'native-sniffer',
    status: `Listening for X native ${cfg.label} responses...`
  };
  await sendHudMessage(tabId, hudState, 20);

  setCurList([], type);
  setCurRaw([], type);
  listType = type;
  jobState = {
    username: resolvedUsername,
    listType: type,
    totalFollowing: profile.totalFollowing,
    totalFollowers: profile.totalFollowers,
    count: 0,
    rawCount: 0,
    isScraping: true,
    reason: 'waiting-native',
    method: 'native-sniffer',
    status: `Listening for X native ${cfg.label} responses...`
  };
  notifyProgress();

  const seen = new Set();
  let lastSeq = 0;
  let stalePasses = 0;
  let passes = 0;
  const fetchTarget = effectiveFetchTarget(totalList);

  while (!activeFetch?.cancelled) {
    const native = await waitForNativeList(
      tabId,
      cfg.opName,
      lastSeq,
      passes === 0 ? 15000 : 6000
    );
    const added = native ? addNativeUsers(native, seen, resolvedUsername) : 0;

    if (native) {
      lastSeq = native.seq || lastSeq;
      stalePasses = 0;
    } else {
      stalePasses += 1;
    }

    trimListToFetchLimit(type);
    passes += 1;

    const targetLabel = fetchTarget != null ? fetchTarget.toLocaleString() : '—';
    const capNote = subscriptionInfo.fetchLimit != null && !subscriptionInfo.isSubscribed
      ? ' (free limit)'
      : '';
    notifyProgress({
      reason: 'collecting',
      pages: passes,
      addedLastPage: added,
      fetchTarget,
      status: `Collected ${curList().length.toLocaleString()} / ${targetLabel}${capNote} ${cfg.label.toLowerCase()}`
    });

    if (fetchTarget != null && curList().length >= fetchTarget) break;
    if (totalList != null && curList().length >= totalList) break;
    if (curList().length > 0 && stalePasses >= 6) break;
    if (passes > 2000) break;

    await executeOnTab(tabId, injectedScrollListToLoad);
    await sleep(1800);
  }

  if (curList().length === 0) {
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

  const doneStatus = subscriptionInfo.fetchLimit != null &&
    fetchTarget != null &&
    curList().length >= fetchTarget &&
    (totalList == null || fetchTarget < totalList)
    ? `Free tier limit reached (${XC_FREE_FETCH_LIMIT}). Subscribe @d2fl to export full lists.`
    : null;
  notifyProgress(doneStatus ? { status: doneStatus } : {});
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
    working = applyFollowingFilters(working, { removeBlue: false, removeNew: true });
    setCurList(working);
    jobState.filterRemoved = curRaw().length - working.length;
    jobState.filterPhase = 'new';
    const removed = before - working.length;
    if (removed > 0) parts.push(`new (${removed.toLocaleString()})`);
    notifyProgress({
      reason: 'filtering',
      filterPhase: 'new',
      status: `Remove new: ${working.length.toLocaleString()} remaining (−${removed.toLocaleString()})`
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
      status: `Enriching ${working.length.toLocaleString()} accounts for last tweet date...`
    });

    try {
      working = await enrichLastActiveForUsers(jobTabId, working, (progress) => {
        const status = progress.waiting
          ? `Waiting… checked ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
          : `Checking last tweet ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}...`;
        notifyProgress({
          reason: 'enriching',
          isEnriching: true,
          enrichProcessed: progress.processed,
          enrichTotal: progress.total,
          status
        });
      });
    } finally {
      activeEnrich = null;
      jobState.isEnriching = false;
    }

    const beforeInactive = working.length;
    working = working.filter((user) => !isInactiveAccount(user.last_active_ms));
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
      status: `Remove inactive: ${working.length.toLocaleString()} remaining (−${inactiveRemoved.toLocaleString()})`
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

async function runExportFlow(requestedType = listType) {
  if (activeFetch?.running) {
    return { ok: false, error: 'Collection already running.' };
  }

  const type = LIST_CONFIG[requestedType] ? requestedType : listType;
  const cfg = listCfg(type);

  const tab = await findLastActiveXTab();
  if (!tab?.id) {
    return { ok: false, error: 'No X tab found. Open x.com in a browser tab first.' };
  }

  jobTabId = tab.id;
  listType = type;
  jobState.listType = type;
  setCurList([], type);
  setCurRaw([], type);
  await clearListPersist(type);

  const username = await detectHandle(tab.id);
  if (!username) {
    return {
      ok: false,
      error: 'Could not detect your X username. Open x.com/home or your profile, then try again.'
    };
  }

  await refreshSubscription(username, true);

  try {
    jobState = {
      username,
      listType: type,
      totalFollowing: null,
      totalFollowers: null,
      count: 0,
      isScraping: true,
      reason: 'loading-profile',
      method: 'native-sniffer'
    };
    await sendHudMessage(tab.id, {
      action: 'showHud',
      ...jobState,
      status: 'Opening your profile...'
    }, 8);
    notifyProgress({ status: 'Opening your profile...' });

    await chrome.tabs.update(tab.id, {
      url: `https://x.com/${username}`,
      active: true
    });
    await waitForTabComplete(tab.id);
    await sleep(2000);

    const profile = await scrapeProfileStats(tab.id, username);
    const totalForFetch = profile[cfg.totalKey];
    if (totalForFetch == null && profile.userId == null) {
      throw new Error('Could not read your profile on X. Confirm you are logged in and try again.');
    }

    jobState = {
      username: profile.username || username,
      listType: type,
      totalFollowing: profile.totalFollowing,
      totalFollowers: profile.totalFollowers,
      count: 0,
      isScraping: true,
      reason: 'profile-loaded',
      method: 'native-sniffer'
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
    await sleep(800);

    activeFetch = { running: true, cancelled: false };
    await runNativeListFetch(tab.id, {
      username: jobState.username,
      totalFollowing: profile.totalFollowing,
      totalFollowers: profile.totalFollowers,
      userId: profile.userId
    }, type);
    await chrome.storage.local.set({ [XC_LIST_TYPE_PREF_KEY]: type });
    return {
      ok: true,
      ...jobState,
      count: curList().length,
      mutuals: computeMutuals()
    };
  } catch (error) {
    jobState.isScraping = false;
    jobState.reason = 'error';
    notifyProgress({ error: String(error.message || error) });
    return { ok: false, error: String(error.message || error), ...jobState };
  } finally {
    activeFetch = null;
  }
}

async function stopScrape() {
  if (activeFetch) {
    activeFetch.cancelled = true;
    return { ok: true, ...jobState, count: curList().length, reason: 'stopping' };
  }

  jobState.isScraping = false;
  jobState.reason = 'stopped';
  notifyProgress();
  return { ok: true, ...jobState, count: curList().length };
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
    ...subscriptionPayload()
  };
}

async function bootstrapSubscription() {
  await ensureRestored();
  await refreshSubscription(null, false);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Cleaner v0.63 installed (Following/Followers + subscription gate)');
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
    await ensureRestored();

    switch (message.action) {
      case 'runExportFlow':
        sendResponse(await runExportFlow(message.listType || listType));
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
          removeInactive: !!message.removeInactive
        }));
        break;
      case 'getMutuals':
        await ensureRestored();
        sendResponse({ ok: true, ...computeMutuals() });
        break;
      case 'checkSubscription':
        await refreshSubscription(message.username || null, !!message.force);
        notifyProgress();
        sendResponse({ ok: true, ...getStatus() });
        break;
      case 'getStatus':
      case 'getJobState':
        sendResponse(getStatus());
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