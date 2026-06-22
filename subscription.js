// Subscription gate: @d2fl X Creator Subscription + built-in owner handles for d2fl team.
// Shared storage key with X Follower Remover (xfr_fetch_subscription_state).
const XC_PRO_CHECKOUT_URL = 'https://x.com/d2fl/creator-subscriptions/subscribe';
const XC_SUBSCRIPTIONS_PAGE_URL = 'https://x.com/settings/subscriptions';
const XC_REQUIRED_CREATOR = 'd2fl';
const XC_PRO_OWNER_HANDLES = new Set(['alt_d2fl', 'd2fl', 'd2fl_alt']);
const XC_FREE_FETCH_LIMIT = 200;
const XC_SUB_STATE_KEY = 'xfr_fetch_subscription_state';
const XC_SUB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const XC_FREE_TIER_WINDOW_MS = XC_SUB_CACHE_TTL_MS;
const XC_FREE_TIER_WINDOW_KEY = 'xc_free_tier_window';

function xcNormalizeHandle(handle) {
  return (handle || '').trim().replace(/^@+/, '').toLowerCase();
}

function xcIsProOwnerHandle(handle) {
  return XC_PRO_OWNER_HANDLES.has(xcNormalizeHandle(handle));
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

function xcCanExport(_isSubscribed) {
  return true;
}

function xcBuildSubscriptionInfo(handle, isSubscribed, source = null, extra = {}) {
  const fetchLimit = xcGetFetchLimit(isSubscribed);
  return {
    isSubscribed: !!isSubscribed,
    subscriptionSource: source,
    fetchLimit,
    canExport: true,
    freeFetchLimit: XC_FREE_FETCH_LIMIT,
    freeTierWindowMs: XC_FREE_TIER_WINDOW_MS,
    checkoutUrl: XC_PRO_CHECKOUT_URL,
    requiredCreator: XC_REQUIRED_CREATOR,
    ...extra
  };
}

async function xcEnsureFreeTierWindow(handle) {
  const normalized = xcNormalizeHandle(handle);
  if (!normalized) {
    return { reset: false, windowStart: null, resetsAt: null };
  }

  const res = await chrome.storage.local.get(XC_FREE_TIER_WINDOW_KEY);
  const windows = res[XC_FREE_TIER_WINDOW_KEY] || {};
  const entry = windows[normalized];
  const now = Date.now();

  if (entry?.windowStart && now - entry.windowStart < XC_FREE_TIER_WINDOW_MS) {
    return {
      reset: false,
      windowStart: entry.windowStart,
      resetsAt: entry.windowStart + XC_FREE_TIER_WINDOW_MS
    };
  }

  const reset = !!(entry?.windowStart);
  windows[normalized] = { windowStart: now };
  await chrome.storage.local.set({ [XC_FREE_TIER_WINDOW_KEY]: windows });
  return {
    reset,
    windowStart: now,
    resetsAt: now + XC_FREE_TIER_WINDOW_MS
  };
}

function xcResolveAuthorization(userHandle, xCreatorHandles, xSniffOk) {
  const normalized = xcNormalizeHandle(userHandle);
  const required = xcNormalizeHandle(XC_REQUIRED_CREATOR);

  if (xcIsProOwnerHandle(normalized)) {
    return {
      isSubscribed: true,
      source: 'owner',
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
  return !!xcReadCachedAuthorization(cache, normalized);
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
      xSniffOk: !!cache.xSniffOk
    };
  }

  return null;
}

function xcBuildInfoFromCachedAuth(normalized, cached, extra = {}) {
  return xcBuildSubscriptionInfo(normalized, cached.isSubscribed, cached.source, {
    xCreatorHandles: cached.xCreatorHandles || [],
    xSniffOk: !!cached.xSniffOk,
    sniffFailed: false,
    sniffError: null,
    hydratedFromStorage: true,
    ...extra
  });
}

async function xcPersistResolvedSubscription(normalized, resolved) {
  const state = await xcLoadSubscriptionState();
  state.isSubscribed = resolved.isSubscribed;
  state.subscriptionSource = resolved.source;
  state.lastHandle = normalized;
  state.subscriptionCache = {
    lastCheck: Date.now(),
    userHandle: normalized,
    isSubscribed: resolved.isSubscribed,
    source: resolved.source,
    xCreatorHandles: resolved.xCreatorHandles,
    xSniffOk: resolved.xSniffOk
  };
  await xcSaveSubscriptionState(state);
  return state;
}

async function xcHydrateSubscriptionFromStorage(handle) {
  const state = await xcLoadSubscriptionState();
  const normalized = xcNormalizeHandle(handle || state.lastHandle || '');
  if (!normalized) {
    return xcBuildSubscriptionInfo('', false, null, { hydratedFromStorage: true });
  }

  if (xcIsProOwnerHandle(normalized)) {
    return xcBuildSubscriptionInfo(normalized, true, 'owner', { hydratedFromStorage: true });
  }

  const cache = state.subscriptionCache;
  const cached = xcReadCachedAuthorization(cache, normalized);
  if (cached) {
    return xcBuildInfoFromCachedAuth(normalized, cached);
  }

  if (state.lastHandle === normalized) {
    return xcBuildSubscriptionInfo(normalized, !!state.isSubscribed, state.subscriptionSource, {
      xCreatorHandles: cache?.xCreatorHandles || [],
      xSniffOk: !!cache?.xSniffOk,
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

  if (xcIsProOwnerHandle(normalized)) {
    const resolved = {
      isSubscribed: true,
      source: 'owner',
      xCreatorHandles: [],
      xSniffOk: false
    };
    await xcPersistResolvedSubscription(normalized, resolved);
    return xcBuildSubscriptionInfo(normalized, true, 'owner', {
      xCreatorHandles: [],
      xSniffOk: false,
      sniffFailed: false,
      sniffError: null
    });
  }

  const cache = state.subscriptionCache;
  const cached = !forceCheck ? xcReadCachedAuthorization(cache, normalized) : null;

  if (cached && !forceCheck) {
    return xcBuildInfoFromCachedAuth(normalized, cached);
  }

  let xCreatorHandles = cached?.xCreatorHandles || cache?.xCreatorHandles || [];
  let xSniffOk = !!(cached?.xSniffOk || cache?.xSniffOk);
  let sniffFailed = false;
  let sniffError = null;

  if (typeof sniff === 'function') {
    try {
      const sniffResult = await sniff();
      if (sniffResult?.ok) {
        xSniffOk = true;
        xCreatorHandles = Array.isArray(sniffResult.handles) ? sniffResult.handles : [];
      } else {
        sniffFailed = true;
        sniffError = 'Could not read X creator subscriptions from the open tab';
      }
    } catch (error) {
      sniffFailed = true;
      sniffError = error?.message || String(error);
      console.warn('[X Cleaner] creator subscription sniff failed', error);
    }
  } else if (forceCheck) {
    sniffFailed = true;
    sniffError = 'No X tab available for subscription check';
  }

  const resolved = xcResolveAuthorization(normalized, xCreatorHandles, xSniffOk);

  if (
    !resolved.isSubscribed
    && state.isSubscribed
    && state.lastHandle === normalized
    && state.subscriptionSource === 'x-creator'
    && sniffFailed
  ) {
    return xcBuildSubscriptionInfo(normalized, true, state.subscriptionSource, {
      xCreatorHandles: state.subscriptionCache?.xCreatorHandles || xCreatorHandles,
      xSniffOk: state.subscriptionCache?.xSniffOk || xSniffOk,
      sniffFailed: true,
      sniffError
    });
  }

  await xcPersistResolvedSubscription(normalized, resolved);

  return xcBuildSubscriptionInfo(normalized, resolved.isSubscribed, resolved.source, {
    xCreatorHandles: resolved.xCreatorHandles,
    xSniffOk: resolved.xSniffOk,
    sniffFailed: resolved.isSubscribed ? false : sniffFailed,
    sniffError: resolved.isSubscribed ? null : sniffError
  });
}

function xcFormatSubscriptionStatus(info, handle) {
  const label = handle ? `@${xcNormalizeHandle(handle)}` : '(not detected)';
  if (info.isSubscribed) {
    if (info.subscriptionSource === 'owner') {
      return `Owner account — unlimited fetch & export (${label})`;
    }
    if (info.subscriptionSource === 'x-creator') {
      return `Subscribed to @${XC_REQUIRED_CREATOR} on X — unlimited fetch & export (${label})`;
    }
    return `Subscribed — unlimited fetch & export (${label})`;
  }
  const resetsNote = info.freeTierResetsAt
    ? ` • resets ${new Date(info.freeTierResetsAt).toLocaleString()}`
    : ' • resets every 24h';
  return `Free — up to ${XC_FREE_FETCH_LIMIT} records per 24h (fetch & export)${resetsNote} (${label})`;
}