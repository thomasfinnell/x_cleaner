// Subscription gate: X UserCreatorSubscriptions sniff first, subs.txt fallback for beta testers.
// Free: fetch capped at XC_FREE_FETCH_LIMIT; export requires authorization.
const XC_SUBS_URL = 'https://d2fl.com/subs.txt';
const XC_PRO_CHECKOUT_URL = 'https://x.com/d2fl/creator-subscriptions/subscribe';
const XC_SUBSCRIPTIONS_PAGE_URL = 'https://x.com/settings/subscriptions';
const XC_REQUIRED_CREATOR = 'd2fl';
const XC_FREE_FETCH_LIMIT = 200;
const XC_SUB_STATE_KEY = 'xfr_fetch_subscription_state';
const XC_SUB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const XC_SUBS_FETCH_RETRIES = 3;
const XC_SUBS_FETCH_TIMEOUT_MS = 12000;
const XC_SUBS_FETCH_RETRY_DELAY_MS = 1500;

let xcLastSubsFetchError = null;

function xcNormalizeHandle(handle) {
  return (handle || '').trim().replace(/^@+/, '').toLowerCase();
}

function xcSubsFetchSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xcGetLastSubsFetchError() {
  return xcLastSubsFetchError;
}

async function xcFetchWithTimeout(url, options = {}, timeoutMs = XC_SUBS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function xcParseSubsTxtBody(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];

  const lowered = raw.slice(0, 256).toLowerCase();
  if (lowered.startsWith('<!doctype') || lowered.startsWith('<html') || lowered.includes('<head')) {
    throw new Error('Received HTML instead of subs.txt (hosting challenge or redirect)');
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .map((line) => xcNormalizeHandle(line))
    .filter(Boolean);
}

async function xcFetchSubsList(options = {}) {
  const maxAttempts = options.retries ?? XC_SUBS_FETCH_RETRIES;
  const baseDelayMs = options.retryDelayMs ?? XC_SUBS_FETCH_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? XC_SUBS_FETCH_TIMEOUT_MS;
  const fetchOptions = {
    cache: 'no-store',
    headers: {
      Accept: 'text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };

  xcLastSubsFetchError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await xcFetchWithTimeout(XC_SUBS_URL, fetchOptions, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        throw new Error('Content-Type text/html (expected text/plain)');
      }
      const text = await res.text();
      const handles = xcParseSubsTxtBody(text);
      if (!handles.length) {
        throw new Error('subs.txt was empty or unreadable');
      }
      return { handles, raw: text };
    } catch (error) {
      const detail = error?.name === 'AbortError'
        ? 'timed out'
        : (error?.message || String(error));
      xcLastSubsFetchError = attempt < maxAttempts
        ? `Subscription check attempt ${attempt}/${maxAttempts} failed (${detail})`
        : `Could not reach d2fl.com subscription service after ${maxAttempts} attempts (${detail})`;
      console.warn(`[X Cleaner] ${xcLastSubsFetchError}`);
      if (attempt < maxAttempts) {
        await xcSubsFetchSleep(baseDelayMs * attempt);
      }
    }
  }

  return null;
}

async function xcLoadSubscriptionState() {
  const res = await chrome.storage.local.get(XC_SUB_STATE_KEY);
  const stored = res[XC_SUB_STATE_KEY];
  if (stored && typeof stored === 'object') {
    return stored;
  }
  return {
    isSubscribed: false,
    subscriptionSource: null,
    subscriptionCache: null,
    lastHandle: null
  };
}

async function xcSaveSubscriptionState(state) {
  await chrome.storage.local.set({ [XC_SUB_STATE_KEY]: state });
}

function xcGetFetchLimit(isSubscribed) {
  return isSubscribed ? null : XC_FREE_FETCH_LIMIT;
}

function xcCanExport(isSubscribed) {
  return !!isSubscribed;
}

function xcBuildSubscriptionInfo(handle, isSubscribed, source = null, extra = {}) {
  const fetchLimit = xcGetFetchLimit(isSubscribed);
  return {
    isSubscribed: !!isSubscribed,
    subscriptionSource: source,
    fetchLimit,
    canExport: xcCanExport(isSubscribed),
    freeFetchLimit: XC_FREE_FETCH_LIMIT,
    checkoutUrl: XC_PRO_CHECKOUT_URL,
    requiredCreator: XC_REQUIRED_CREATOR,
    ...extra
  };
}

function xcResolveAuthorization(userHandle, xCreatorHandles, xSniffOk, subsTxtHandles) {
  const normalized = xcNormalizeHandle(userHandle);
  const required = xcNormalizeHandle(XC_REQUIRED_CREATOR);

  if (subsTxtHandles && normalized && subsTxtHandles.includes(normalized)) {
    return {
      isSubscribed: true,
      source: 'subs.txt',
      xCreatorHandles: xCreatorHandles || [],
      xSniffOk: !!xSniffOk
    };
  }

  if (xSniffOk && Array.isArray(xCreatorHandles)) {
    const subscribedOnX = xCreatorHandles
      .map((h) => xcNormalizeHandle(h))
      .includes(required);
    if (subscribedOnX) {
      return {
        isSubscribed: true,
        source: 'x-creator',
        xCreatorHandles,
        xSniffOk: true
      };
    }
  }

  return {
    isSubscribed: false,
    source: null,
    xCreatorHandles: xCreatorHandles || [],
    xSniffOk: !!xSniffOk
  };
}

function xcSubscriptionCacheIsFresh(handle, cache = null) {
  const normalized = xcNormalizeHandle(handle);
  if (!normalized) return false;
  const entry = cache ?? null;
  return !!xcReadCachedAuthorization(entry, normalized);
}

async function xcSubscriptionCacheIsFreshForHandle(handle) {
  const state = await xcLoadSubscriptionState();
  return xcSubscriptionCacheIsFresh(handle, state.subscriptionCache);
}

function xcReadCachedAuthorization(cache, normalized) {
  if (!cache?.lastCheck || !normalized) return null;
  if (Date.now() - cache.lastCheck >= XC_SUB_CACHE_TTL_MS) return null;

  if (cache.userHandle === normalized && typeof cache.isSubscribed === 'boolean') {
    return {
      isSubscribed: cache.isSubscribed,
      source: cache.source || null,
      xCreatorHandles: cache.xCreatorHandles || [],
      xSniffOk: !!cache.xSniffOk,
      subsTxtAuthorized: cache.source === 'subs.txt'
    };
  }

  // Legacy cache stored the full subs.txt list in `handles`.
  if (Array.isArray(cache.handles)) {
    const isSubscribed = cache.handles.includes(normalized);
    return {
      isSubscribed,
      source: isSubscribed ? 'subs.txt' : null,
      xCreatorHandles: [],
      xSniffOk: false,
      subsTxtAuthorized: isSubscribed
    };
  }

  return null;
}

function xcBuildInfoFromCachedAuth(normalized, cached, extra = {}) {
  return xcBuildSubscriptionInfo(normalized, cached.isSubscribed, cached.source, {
    xCreatorHandles: cached.xCreatorHandles || [],
    xSniffOk: !!cached.xSniffOk,
    subsTxtAuthorized: !!cached.subsTxtAuthorized || cached.source === 'subs.txt',
    subsFetchFailed: false,
    subsFetchError: null,
    subsTxtMatched: cached.source === 'subs.txt' ? cached.isSubscribed : false,
    subsTxtHandleCount: extra.subsTxtHandleCount ?? 0,
    hydratedFromStorage: true,
    ...extra
  });
}

async function xcHydrateSubscriptionFromStorage(handle) {
  const state = await xcLoadSubscriptionState();
  const normalized = xcNormalizeHandle(handle || state.lastHandle || '');
  if (!normalized) {
    return xcBuildSubscriptionInfo('', false, null, { hydratedFromStorage: true });
  }

  const cache = state.subscriptionCache;
  const cached = xcReadCachedAuthorization(cache, normalized);
  if (cached) {
    return xcBuildInfoFromCachedAuth(normalized, cached, {
      subsTxtHandleCount: cache?.subsTxtHandles?.length ?? 0
    });
  }

  if (state.lastHandle === normalized) {
    return xcBuildSubscriptionInfo(normalized, !!state.isSubscribed, state.subscriptionSource, {
      xCreatorHandles: cache?.xCreatorHandles || [],
      xSniffOk: !!cache?.xSniffOk,
      subsTxtAuthorized: state.subscriptionSource === 'subs.txt',
      subsTxtHandleCount: cache?.subsTxtHandles?.length ?? 0,
      hydratedFromStorage: true
    });
  }

  return xcBuildSubscriptionInfo(normalized, false, null, { hydratedFromStorage: true });
}

async function xcCheckSubscription(handle, options = {}) {
  const normalized = xcNormalizeHandle(handle);
  const forceCheck = !!options.forceCheck;
  const sniff = options.sniff || null;
  const state = await xcLoadSubscriptionState();

  if (!normalized) {
    const info = xcBuildSubscriptionInfo('', false, null);
    state.isSubscribed = false;
    state.subscriptionSource = null;
    state.lastHandle = null;
    await xcSaveSubscriptionState(state);
    return info;
  }

  const cache = state.subscriptionCache;
  const cached = !forceCheck ? xcReadCachedAuthorization(cache, normalized) : null;
  const cacheFresh = !!cached;

  // Passive checks: return fresh cache immediately so UI is not blocked on subs.txt.
  if (cacheFresh && !forceCheck) {
    return xcBuildInfoFromCachedAuth(normalized, cached, {
      subsTxtHandleCount: cache?.subsTxtHandles?.length ?? 0
    });
  }

  const subsFetchOpts = forceCheck
    ? { retries: XC_SUBS_FETCH_RETRIES, timeoutMs: XC_SUBS_FETCH_TIMEOUT_MS }
    : { retries: 1, timeoutMs: 6000 };
  const subsTxtResult = await xcFetchSubsList(subsFetchOpts);
  const subsTxtHandles = subsTxtResult?.handles || null;
  const subsFetchFailed = subsTxtResult === null;
  const subsFetchError = subsFetchFailed ? xcLastSubsFetchError : null;
  const subsTxtMatched = !subsFetchFailed && subsTxtHandles.includes(normalized);

  let resolved = xcResolveAuthorization(normalized, [], false, subsTxtHandles);
  if (resolved.isSubscribed) {
    state.isSubscribed = true;
    state.subscriptionSource = resolved.source;
    state.lastHandle = normalized;
    state.subscriptionCache = {
      lastCheck: Date.now(),
      userHandle: normalized,
      isSubscribed: true,
      source: resolved.source,
      xCreatorHandles: [],
      xSniffOk: false,
      subsTxtHandles: subsTxtHandles || []
    };
    await xcSaveSubscriptionState(state);
    return xcBuildSubscriptionInfo(normalized, true, resolved.source, {
      xCreatorHandles: [],
      xSniffOk: false,
      subsTxtAuthorized: true,
      subsFetchFailed,
      subsFetchError,
      subsTxtMatched,
      subsTxtHandleCount: subsTxtHandles?.length ?? 0
    });
  }

  let xCreatorHandles = cached?.xCreatorHandles || [];
  let xSniffOk = !!cached?.xSniffOk;

  if (!cacheFresh && typeof sniff === 'function') {
    try {
      const sniffResult = await sniff();
      if (sniffResult?.ok) {
        xSniffOk = true;
        xCreatorHandles = Array.isArray(sniffResult.handles) ? sniffResult.handles : [];
      }
    } catch (error) {
      console.warn('[X Cleaner] creator subscription sniff failed', error);
    }
  }

  resolved = xcResolveAuthorization(normalized, xCreatorHandles, xSniffOk, subsTxtHandles);

  if (subsTxtHandles === null && !resolved.isSubscribed && state.lastHandle === normalized) {
    return xcBuildSubscriptionInfo(normalized, !!state.isSubscribed, state.subscriptionSource, {
      xCreatorHandles,
      xSniffOk,
      subsFetchFailed: true,
      subsFetchError,
      subsTxtMatched: false,
      subsTxtHandleCount: 0
    });
  }

  // Keep prior authorization when a passive re-check cannot re-prove access (wrong tab, sniff miss).
  if (
    !resolved.isSubscribed
    && state.isSubscribed
    && state.lastHandle === normalized
    && (
      (state.subscriptionSource === 'x-creator' && (!xSniffOk || !xCreatorHandles.length))
      || (state.subscriptionSource === 'subs.txt' && subsFetchFailed)
    )
  ) {
    return xcBuildSubscriptionInfo(normalized, true, state.subscriptionSource, {
      xCreatorHandles: state.subscriptionCache?.xCreatorHandles || xCreatorHandles,
      xSniffOk: state.subscriptionCache?.xSniffOk || xSniffOk,
      subsTxtAuthorized: state.subscriptionSource === 'subs.txt',
      subsFetchFailed,
      subsFetchError,
      subsTxtMatched: state.subscriptionSource === 'subs.txt' ? true : subsTxtMatched,
      subsTxtHandleCount: subsTxtHandles?.length ?? state.subscriptionCache?.subsTxtHandles?.length ?? 0
    });
  }

  state.isSubscribed = resolved.isSubscribed;
  state.subscriptionSource = resolved.source;
  state.lastHandle = normalized;
  state.subscriptionCache = {
    lastCheck: Date.now(),
    userHandle: normalized,
    isSubscribed: resolved.isSubscribed,
    source: resolved.source,
    xCreatorHandles: resolved.xCreatorHandles,
    xSniffOk: resolved.xSniffOk,
    subsTxtHandles: subsTxtHandles || cache?.subsTxtHandles || []
  };
  await xcSaveSubscriptionState(state);

  const info = xcBuildSubscriptionInfo(normalized, resolved.isSubscribed, resolved.source, {
    xCreatorHandles: resolved.xCreatorHandles,
    xSniffOk: resolved.xSniffOk,
    subsTxtAuthorized: resolved.source === 'subs.txt',
    subsFetchFailed,
    subsFetchError,
    subsTxtMatched,
    subsTxtHandleCount: subsTxtHandles?.length ?? 0
  });

  if (!resolved.isSubscribed && !subsFetchFailed) {
    console.log(
      `[X Cleaner] subs.txt loaded (${subsTxtHandles.length} handles); @${normalized} ${subsTxtMatched ? 'authorized' : 'not in list'}`
    );
  }

  return info;
}

function xcFormatSubscriptionStatus(info, handle) {
  const label = handle ? `@${xcNormalizeHandle(handle)}` : '(not detected)';
  if (info.isSubscribed) {
    if (info.subscriptionSource === 'x-creator') {
      return `Subscribed to @${XC_REQUIRED_CREATOR} on X — unlimited fetch & export (${label})`;
    }
    if (info.subscriptionSource === 'subs.txt') {
      return `Beta access — unlimited fetch & export (${label})`;
    }
    return `Subscribed — unlimited fetch & export (${label})`;
  }
  return `Free — fetch up to ${XC_FREE_FETCH_LIMIT} • export requires @${XC_REQUIRED_CREATOR} (${label})`;
}