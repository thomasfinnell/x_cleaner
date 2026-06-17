// Subscription gate: X UserCreatorSubscriptions sniff first, subs.txt fallback for beta testers.
// Free: fetch capped at XC_FREE_FETCH_LIMIT; export requires authorization.
const XC_SUBS_URL = 'https://d2fl.com/subs.txt';
const XC_PRO_CHECKOUT_URL = 'https://x.com/d2fl/creator-subscriptions/subscribe';
const XC_SUBSCRIPTIONS_PAGE_URL = 'https://x.com/settings/subscriptions';
const XC_REQUIRED_CREATOR = 'd2fl';
const XC_FREE_FETCH_LIMIT = 200;
const XC_SUB_STATE_KEY = 'xc_subscription_state';
const XC_SUB_CACHE_TTL_MS = 15 * 60 * 1000;

function xcNormalizeHandle(handle) {
  return (handle || '').trim().replace(/^@+/, '').toLowerCase();
}

async function xcFetchSubsList() {
  try {
    const res = await fetch(XC_SUBS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text
      .split(/\r?\n/)
      .map((line) => xcNormalizeHandle(line))
      .filter(Boolean);
  } catch (error) {
    console.warn('[X Cleaner] Failed to fetch subs.txt from d2fl.com:', error);
    return null;
  }
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
  if (!forceCheck) {
    const cached = xcReadCachedAuthorization(cache, normalized);
    if (cached) {
      state.isSubscribed = cached.isSubscribed;
      state.subscriptionSource = cached.source;
      state.lastHandle = normalized;
      await xcSaveSubscriptionState(state);
      return xcBuildSubscriptionInfo(normalized, cached.isSubscribed, cached.source, {
        xCreatorHandles: cached.xCreatorHandles,
        xSniffOk: cached.xSniffOk,
        subsTxtAuthorized: cached.subsTxtAuthorized
      });
    }
  }

  const subsTxtHandles = await xcFetchSubsList();
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
      subsTxtAuthorized: true
    });
  }

  let xCreatorHandles = [];
  let xSniffOk = false;

  if (typeof sniff === 'function') {
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
      xSniffOk
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

  return xcBuildSubscriptionInfo(normalized, resolved.isSubscribed, resolved.source, {
    xCreatorHandles: resolved.xCreatorHandles,
    xSniffOk: resolved.xSniffOk,
    subsTxtAuthorized: resolved.source === 'subs.txt'
  });
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