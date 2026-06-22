// rest-fetch.js — REST API v1.1 list fetch + session helpers (parallel path vs sniffer)

const XC_REST_BEARER_DEFAULT =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJuFAFAAGmQ/NlzQ/ACAAANAAAAAAA';

const XC_REST_BEARER_STORAGE_KEY = 'xc_rest_bearer_token';
const XC_REST_CSRF_STORAGE_KEY = 'xc_rest_csrf_token';
const XC_REST_PAGE_SIZE = 200;
const XC_REST_PAGE_DELAY_MS = 350;
const XC_REST_LOOKUP_BATCH_SIZE = 100;
const XC_REST_LOOKUP_DELAY_MS = 350;
const XC_REST_RATE_LIMIT_BACKOFF_MS = 60000;
const XC_REST_MAX_PAGES = 500;

const XC_REST_API_ORIGIN = 'https://api.x.com/1.1';
const XC_REST_LIST_ENDPOINTS = {
  following: `${XC_REST_API_ORIGIN}/friends/list.json`,
  followers: `${XC_REST_API_ORIGIN}/followers/list.json`
};

async function xcRestCollectAllCookies() {
  const jar = {};
  const urls = ['https://x.com', 'https://api.x.com'];
  const domains = ['.x.com', 'x.com'];

  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const cookie of cookies) {
        jar[cookie.name] = cookie.value;
      }
    } catch (error) {}
  }

  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies) {
        jar[cookie.name] = cookie.value;
      }
    } catch (error) {}
  }

  return jar;
}

async function xcRestReadBearerFromTab(tabId) {
  if (!tabId) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          return sessionStorage.getItem('xc_captured_bearer') || null;
        } catch (error) {
          return null;
        }
      }
    });
    const token = results?.[0]?.result;
    return token && String(token).length > 20 ? String(token) : null;
  } catch (error) {
    return null;
  }
}

function xcRestParseUserIdFromCookies(cookies) {
  const twid = cookies?.twid;
  if (!twid) return null;
  try {
    const decoded = decodeURIComponent(String(twid));
    const match = decoded.match(/u=(\d+)/);
    if (match?.[1]) return match[1];
  } catch (error) {}
  const rawMatch = String(twid).match(/u%3D(\d+)|u=(\d+)/i);
  if (rawMatch) return rawMatch[1] || rawMatch[2] || null;
  return null;
}

async function xcRestSyncSessionFromTab(tabId) {
  if (!tabId) return { ok: false };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'syncRestSession' });
    if (response?.ok) return response;
  } catch (error) {}
  return { ok: false };
}

async function xcRestPrepareSession(tabId) {
  await xcRestSyncSessionFromTab(tabId);
  const fromTab = await xcRestReadBearerFromTab(tabId);
  if (fromTab) {
    try {
      const cookies = await xcRestCollectAllCookies();
      await chrome.storage.local.set({
        [XC_REST_BEARER_STORAGE_KEY]: fromTab,
        [XC_REST_CSRF_STORAGE_KEY]: cookies.ct0 || null
      });
    } catch (error) {}
  }
  return xcRestResolveBearer(tabId, { requireCaptured: false });
}

async function xcRestWaitForBearer(tabId, options = {}) {
  if (!tabId) return null;
  const maxMs = options.maxMs ?? 10000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await xcRestPrepareSession(tabId);
    const bearer = await xcRestResolveBearer(tabId, { requireCaptured: true });
    if (bearer) return bearer;
    await xcRestSleep(intervalMs);
  }
  return null;
}

async function xcRestResolveBearer(tabId, options = {}) {
  const requireCaptured = !!options.requireCaptured;

  try {
    const stored = await chrome.storage.local.get([
      XC_REST_BEARER_STORAGE_KEY,
      XC_REST_CSRF_STORAGE_KEY
    ]);
    const cached = stored[XC_REST_BEARER_STORAGE_KEY];
    if (cached && String(cached).length > 20) {
      return String(cached);
    }
  } catch (error) {}

  const fromTab = await xcRestReadBearerFromTab(tabId);
  if (fromTab) {
    try {
      await chrome.storage.local.set({ [XC_REST_BEARER_STORAGE_KEY]: fromTab });
    } catch (error) {}
    return fromTab;
  }

  if (requireCaptured) {
    return null;
  }

  return XC_REST_BEARER_DEFAULT;
}

function xcRestCookieHeader(cookies) {
  return Object.entries(cookies || {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function xcRestListApiError(body, status) {
  if (body?.errors?.length) {
    return body.errors.map((e) => e.message || String(e)).join('; ');
  }
  if (body?.error) return String(body.error);
  if (status === 401) return 'Unauthorized — log in to x.com and retry';
  if (status === 403) return 'Forbidden — REST API blocked for this session';
  if (status === 429) return 'Rate limited — try again shortly';
  return `API error (HTTP ${status})`;
}

function xcRestUsesListStyleHeaders(url) {
  return (
    url.includes('account/verify_credentials.json')
    || url.includes('friends/list.json')
    || url.includes('followers/list.json')
    || url.includes('users/lookup.json')
  );
}

async function xcRestMakeApiRequest(url, method = 'GET', body = null, options = {}) {
  const cookies = options.cookies || (await xcRestCollectAllCookies());
  const ct0 = cookies.ct0 || '';
  const authToken = cookies.auth_token || '';
  const bearer = options.bearer || (await xcRestResolveBearer(options.tabId || null, options));

  if (!ct0 || !authToken) {
    throw new Error('Missing x.com session cookies (auth_token / ct0). Open x.com while logged in.');
  }

  let csrfToken = ct0;
  try {
    const stored = await chrome.storage.local.get(XC_REST_CSRF_STORAGE_KEY);
    if (stored[XC_REST_CSRF_STORAGE_KEY]) {
      csrfToken = stored[XC_REST_CSRF_STORAGE_KEY];
    }
  } catch (error) {}
  if (cookies.ct0 && cookies.ct0 !== csrfToken) {
    csrfToken = cookies.ct0;
  }

  if (!bearer) {
    throw new Error('Missing captured X bearer token. Open x.com/home, wait for the feed to load, then retry REST fetch.');
  }

  const cookieHeader = xcRestCookieHeader(cookies);
  const headers = xcRestUsesListStyleHeaders(url)
    ? {
      Authorization: `Bearer ${bearer}`,
      'x-csrf-token': csrfToken,
      'x-twitter-auth-type': 'OAuth2Session',
      Accept: '*/*',
      Cookie: cookieHeader,
      'x-twitter-client-language': 'en',
      'x-twitter-active-user': 'yes'
    }
    : {
      Authorization: `Bearer ${bearer}`,
      'x-csrf-token': csrfToken,
      'x-twitter-auth-type': 'OAuth2Session',
      Accept: '*/*',
      Cookie: cookieHeader,
      'x-twitter-client-language': 'en',
      'x-twitter-active-user': 'yes',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

  const requestOptions = {
    method,
    headers,
    credentials: 'include'
  };

  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  requestOptions.signal = controller.signal;

  if (body && method !== 'GET') {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      form.append(key, String(value));
    }
    requestOptions.body = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const err = new Error(`REST request timed out (${Math.round(timeoutMs / 1000)}s)`);
      err.code = 'XC_REST_TIMEOUT';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    const err = new Error(`Invalid JSON from REST API (HTTP ${response.status})`);
    err.status = response.status;
    err.raw = text.slice(0, 300);
    throw err;
  }

  if (!response.ok) {
    const message = xcRestListApiError(parsed, response.status);
    const err = new Error(message);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

function xcRestDetectBlue(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.ext_is_blue_verified === true || raw.is_blue_verified === true) return true;

  const verifiedType = String(raw.verified_type || raw.ext_verified_type || '').toLowerCase();
  if (verifiedType === 'blue' || verifiedType === 'business' || verifiedType === 'government') {
    return true;
  }

  // followers/list + friends/list often omit ext_is_blue_verified but still set verified.
  if (raw.verified === true) return true;

  return false;
}

function xcRestMapApiUser(raw, listType) {
  const screenName = (raw.screen_name || '').trim();
  if (!screenName) return null;

  const isBlue = xcRestDetectBlue(raw);

  const mapped = {
    username: screenName,
    display_name: raw.name || '',
    friends_count: raw.friends_count ?? null,
    followers_count: raw.followers_count ?? null,
    tweet_count: raw.statuses_count ?? null,
    created_at: raw.created_at || '',
    bio: String(raw.description || '').trim(),
    is_blue: isBlue,
    default_avatar: !!raw.default_profile_image,
    you_follow: listType === 'following' ? true : (raw.following ?? null),
    follows_you: listType === 'followers' ? true : (raw.followed_by ?? null)
  };

  // Capture last post time if the (non-skipped) response includes status (following lists)
  const statusCreated = raw?.status?.created_at;
  if (statusCreated) {
    const ts = Date.parse(statusCreated);
    if (!Number.isNaN(ts)) {
      mapped.last_active_ms = ts;
    }
  }

  return mapped;
}

function xcRestMapVerifyCredentials(response) {
  return {
    userId: response.id_str,
    screenName: response.screen_name,
    name: response.name,
    followersCount: response.followers_count,
    friendsCount: response.friends_count,
    verified: !!response.verified,
    protected: !!response.protected
  };
}

async function xcRestVerifyCredentials(options = {}) {
  const query = '?skip_status=true&include_email=false';
  const url = `${XC_REST_API_ORIGIN}/account/verify_credentials.json${query}`;
  const attempts = [];
  let lastError = null;

  const tryRequest = async (requestOptions = {}) => {
    const response = await xcRestMakeApiRequest(url, 'GET', null, {
      ...options,
      ...requestOptions
    });
    return xcRestMapVerifyCredentials(response);
  };

  try {
    return await tryRequest();
  } catch (error) {
    attempts.push(`x.com: ${error.message}`);
    lastError = error;

    if (error.status === 401 && options.tabId) {
      try {
        await chrome.storage.local.remove(XC_REST_BEARER_STORAGE_KEY);
      } catch (storageError) {}
      const freshBearer = await xcRestReadBearerFromTab(options.tabId);
      if (freshBearer) {
        try {
          return await tryRequest({ bearer: freshBearer });
        } catch (retryError) {
          attempts.push(`x.com (fresh bearer): ${retryError.message}`);
          lastError = retryError;
        }
      }
    }
  }

  const err = new Error(lastError?.message || 'verify_credentials failed');
  err.status = lastError?.status;
  err.attempts = attempts;
  err.attemptSummary = attempts.join(' | ');
  throw err;
}

function xcRestMapUsersShow(response) {
  return {
    userId: response.id_str,
    screenName: response.screen_name,
    name: response.name,
    followersCount: response.followers_count,
    friendsCount: response.friends_count,
    verified: !!response.verified,
    protected: !!response.protected
  };
}

function xcRestParseUsersLookupFields(body, listType = 'followers') {
  const lastActive = {};
  const blueByName = {};
  const profilesByName = {};
  const users = Array.isArray(body) ? body : [];
  for (const raw of users) {
    const sn = String(raw?.screen_name || '').toLowerCase().replace(/^@+/, '');
    if (!sn) continue;
    if (xcRestDetectBlue(raw)) blueByName[sn] = true;
    const mapped = xcRestMapApiUser(raw, listType);
    if (mapped) profilesByName[sn] = mapped;
    const createdAt = raw?.status?.created_at;
    if (!createdAt) continue;
    const ts = Date.parse(createdAt);
    if (Number.isNaN(ts)) continue;
    lastActive[sn] = ts;
  }
  return { lastActive, blueByName, profilesByName };
}

function xcRestParseUsersLookupLastActive(body) {
  return xcRestParseUsersLookupFields(body).lastActive;
}

function injectedRestUsersLookup(request) {
  const screenNames = Array.isArray(request.screenNames) ? request.screenNames : [];
  const handles = screenNames
    .map((name) => String(name || '').replace(/^@+/, '').trim())
    .filter(Boolean);
  if (!handles.length) {
    return { ok: false, error: 'No screen names for users/lookup' };
  }

  const cookieHeader = request.cookieHeader || '';
  let bearer = request.bearer || '';

  try {
    const captured = sessionStorage.getItem('xc_captured_bearer')
      || localStorage.getItem('xc_captured_bearer');
    if (captured && captured.length > 20) bearer = captured;
  } catch (error) {}

  if (!bearer) {
    return { ok: false, error: 'No captured bearer in tab — open x.com/home and wait for feed to load' };
  }

  const ct0Match = cookieHeader.match(/(?:^|;\s*)ct0=([^;]+)/);
  const ct0 = ct0Match ? decodeURIComponent(ct0Match[1]) : '';
  const endpoints = [`${XC_REST_API_ORIGIN}/users/lookup.json`];

  const query = new URLSearchParams({
    screen_name: handles.join(','),
    // no include_entities (or minimal) following samples approach for user detail
    skip_status: 'false'
  });

  const headers = {
    Authorization: `Bearer ${bearer}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    Accept: '*/*',
    Cookie: cookieHeader,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes'
  };

  const attempts = [];

  const fetchOne = async (base) => {
    const label = 'tab@x.com';
    const resp = await fetch(`${base}?${query.toString()}`, {
      method: 'GET',
      headers,
      credentials: 'include'
    });
    const text = await resp.text();
    let body = [];
    try {
      body = text ? JSON.parse(text) : [];
    } catch (error) {}
    if (!resp.ok) {
      const message = body?.errors?.[0]?.message || body?.error || text.slice(0, 160);
      attempts.push(`${label}: ${message}`);
      return null;
    }
    return { body, label, url: `${base}?${query.toString()}` };
  };

  return (async () => {
    for (const base of endpoints) {
      try {
        const result = await fetchOne(base);
        if (result) {
          const parsed = xcRestParseUsersLookupFields(result.body);
          return {
            ok: true,
            body: result.body,
            strategy: result.label,
            url: result.url,
            attempts,
            lastActive: parsed.lastActive,
            blueByName: parsed.blueByName
          };
        }
      } catch (error) {
        attempts.push(`tab@x.com: ${error.message}`);
      }
    }
    return {
      ok: false,
      error: attempts[attempts.length - 1] || 'Tab REST users/lookup failed',
      attempts,
      lastActive: {}
    };
  })();
}

async function xcRestUsersLookupFromTab(tabId, screenNames, options = {}) {
  if (!tabId) return null;

  const handles = (Array.isArray(screenNames) ? screenNames : [])
    .map((name) => String(name || '').replace(/^@+/, '').trim())
    .filter(Boolean);
  if (!handles.length) {
    return { ok: true, lastActive: {}, attempts: [] };
  }

  const cookies = options.cookies || (await xcRestCollectAllCookies());
  const bearer = options.bearer || (await xcRestResolveBearer(tabId, { requireCaptured: true }));

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectedRestUsersLookup,
      args: [{
        screenNames: handles,
        cookieHeader: xcRestCookieHeader(cookies),
        bearer,
        preferredTabHost: options.preferredTabHost || null
      }]
    });
    const payload = results?.[0]?.result;
    if (!payload?.ok) {
      return {
        ok: false,
        error: payload?.error || 'Tab REST users/lookup failed',
        attempts: payload?.attempts || [],
        lastActive: {}
      };
    }

    const listType = options.listType || 'followers';
    const parsed = xcRestParseUsersLookupFields(payload.body || [], listType);
    if (payload.lastActive) {
      Object.assign(parsed.lastActive, payload.lastActive);
    }
    if (payload.blueByName) {
      Object.assign(parsed.blueByName, payload.blueByName);
    }
    return {
      ok: true,
      lastActive: parsed.lastActive,
      blueByName: parsed.blueByName,
      profilesByName: parsed.profilesByName,
      strategy: payload.strategy,
      attempts: payload.attempts || [],
      matched: Object.keys(parsed.lastActive).length,
      blueMatched: Object.keys(parsed.blueByName).length,
      profileMatched: Object.keys(parsed.profilesByName).length
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      lastActive: {},
      attempts: []
    };
  }
}

async function xcRestUsersLookupBatch(screenNames, options = {}) {
  const handles = (Array.isArray(screenNames) ? screenNames : [])
    .map((name) => String(name || '').replace(/^@+/, '').trim())
    .filter(Boolean);
  if (!handles.length) {
    return { ok: true, lastActive: {}, attempts: [] };
  }

  const tabId = options.tabId || null;
  const attempts = [];

  if (tabId && options.preferTabContext !== false) {
    await xcRestSyncSessionFromTab(tabId);
    const tabRetries = options.tabRetries ?? 2;
    let lastTabFail = null;
    for (let retry = 0; retry < tabRetries; retry += 1) {
      if (retry > 0) {
        await xcRestSleep(400 * retry);
      }
      const tabResult = await xcRestUsersLookupFromTab(tabId, handles, options);
      if (tabResult?.attempts?.length) attempts.push(...tabResult.attempts);
      if (tabResult?.ok) {
        return { ...tabResult, attempts };
      }
      lastTabFail = tabResult;
      if (tabResult?.error) {
        attempts.push(`tab: ${tabResult.error}`);
      }
    }
    if (options.tabOnly) {
      const err = new Error(lastTabFail?.error || 'Tab REST users/lookup failed');
      err.attempts = attempts;
      throw err;
    }
  }

  const query = new URLSearchParams({
    screen_name: handles.join(','),
    // no include_entities (or minimal) following samples approach for user detail
    skip_status: 'false'
  });
  const url = `${XC_REST_API_ORIGIN}/users/lookup.json?${query.toString()}`;
  const label = 'worker@x.com';

  try {
    const body = await xcRestMakeApiRequest(url, 'GET', null, options);
    const listType = options.listType || 'followers';
    const parsed = xcRestParseUsersLookupFields(body, listType);
    attempts.push({
      strategy: label,
      users: handles.length,
      matched: Object.keys(parsed.lastActive).length,
      blueMatched: Object.keys(parsed.blueByName).length,
      profileMatched: Object.keys(parsed.profilesByName).length
    });
    return {
      ok: true,
      lastActive: parsed.lastActive,
      blueByName: parsed.blueByName,
      profilesByName: parsed.profilesByName,
      attempts,
      strategy: label
    };
  } catch (error) {
    attempts.push(`${label}: ${error.message}`);
    if (error.status === 429) {
      error.attempts = attempts;
      throw error;
    }
    const err = new Error(error.message || 'users/lookup failed');
    err.status = error.status;
    err.attempts = attempts;
    throw err;
  }
}

async function xcRestUsersShow(screenName, options = {}) {
  const handle = String(screenName || '').replace(/^@+/, '');
  if (!handle) {
    throw new Error('Missing screen_name for users/show');
  }

  const query = `?screen_name=${encodeURIComponent(handle)}&skip_status=true`;
  const url = `${XC_REST_API_ORIGIN}/users/show.json${query}`;
  const attempts = [];
  let lastError = null;

  const tryRequest = async (requestOptions = {}) => {
    const response = await xcRestMakeApiRequest(url, 'GET', null, {
      ...options,
      ...requestOptions
    });
    return xcRestMapUsersShow(response);
  };

  try {
    return await tryRequest();
  } catch (error) {
    attempts.push(`x.com: ${error.message}`);
    lastError = error;

    if (error.status === 401 && options.tabId) {
      try {
        await chrome.storage.local.remove(XC_REST_BEARER_STORAGE_KEY);
      } catch (storageError) {}
      const freshBearer = await xcRestReadBearerFromTab(options.tabId);
      if (freshBearer) {
        try {
          return await tryRequest({ bearer: freshBearer });
        } catch (retryError) {
          attempts.push(`x.com (fresh bearer): ${retryError.message}`);
          lastError = retryError;
        }
      }
    }
  }

  const err = new Error(lastError?.message || 'users/show failed');
  err.status = lastError?.status;
  err.attempts = attempts;
  err.attemptSummary = attempts.join(' | ');
  throw err;
}

function xcRestListBaseUrl(listType) {
  return XC_REST_LIST_ENDPOINTS[listType] || XC_REST_LIST_ENDPOINTS.following;
}

function xcRestBuildListUrl(listType, params) {
  const baseUrl = xcRestListBaseUrl(listType);
  const query = new URLSearchParams();
  query.set('count', String(params.count || XC_REST_PAGE_SIZE));
  query.set('cursor', String(params.cursor ?? '-1'));
  // Omit skip_status for 'following' lists (informed by samples best practice in
  // Remove_src/samples/src/background/api/friendships.ts and core.ts) so the
  // response users can include `status.created_at` (last post time).
  if (listType !== 'following') {
    query.set('skip_status', 'true');
  }
  if (params.userId) {
    query.set('user_id', String(params.userId));
  } else if (params.screenName) {
    query.set('screen_name', String(params.screenName).replace(/^@+/, ''));
  }
  return `${baseUrl}?${query.toString()}`;
}

function xcRestNormalizeAttempt(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object') {
    if (entry.detail) return entry.detail;
    if (entry.error) {
      const label = entry.strategy || entry.label || 'attempt';
      return `${label}: ${entry.error}`;
    }
    const label = entry.strategy || entry.label || 'attempt';
    const count = entry.users ?? entry.rawCount;
    if (count != null) {
      const cursorNote = entry.nextCursor && entry.nextCursor !== '0'
        ? `, cursor ${entry.nextCursor}`
        : '';
      const moreNote = entry.hasMore === false ? ', done' : '';
      const dropNote = entry.droppedCount > 0 ? `, dropped ${entry.droppedCount}` : '';
      const apiNote = entry.apiRawCount != null && entry.apiRawCount !== count
        ? ` (api ${entry.apiRawCount})`
        : '';
      return `${label}: ${count} users${apiNote}${cursorNote}${moreNote}${dropNote}`;
    }
  }
  return String(entry);
}

function xcRestParseListResponse(body, listType) {
  const rawUsers = body.users || [];
  const users = rawUsers
    .map((row) => xcRestMapApiUser(row, listType))
    .filter(Boolean);

  const nextCursorRaw = body.next_cursor_str ?? body.next_cursor ?? '0';
  const nextCursor = String(nextCursorRaw);
  const hasValidCursor = nextCursor !== '0' && nextCursor !== '';
  const hasMore = hasValidCursor && users.length > 0;

  return {
    users,
    nextCursor,
    hasMore,
    hasValidCursor,
    previousCursor: body.previous_cursor_str || null,
    rawCount: users.length,
    apiRawCount: rawUsers.length,
    droppedCount: Math.max(0, rawUsers.length - users.length),
    totalCount: body.total_count ?? null
  };
}

function injectedRestListFetch(request) {
  const listType = request.listType || 'following';
  const screenName = String(request.screenName || '').replace(/^@+/, '');
  const cursor = String(request.cursor ?? '-1');
  const count = request.count || 200;
  const cookieHeader = request.cookieHeader || '';
  let bearer = request.bearer || '';

  try {
    const captured = sessionStorage.getItem('xc_captured_bearer')
      || localStorage.getItem('xc_captured_bearer');
    if (captured && captured.length > 20) bearer = captured;
  } catch (error) {}

  if (!bearer) {
    return { ok: false, error: 'No captured bearer in tab — open x.com/home and wait for feed to load' };
  }

  if (!request.userId && !screenName) {
    return { ok: false, error: 'No screen_name or user_id for REST list fetch' };
  }

  const ct0Match = cookieHeader.match(/(?:^|;\s*)ct0=([^;]+)/);
  const ct0 = ct0Match ? decodeURIComponent(ct0Match[1]) : '';
  const endpoints = [XC_REST_LIST_ENDPOINTS[listType] || XC_REST_LIST_ENDPOINTS.following];

  const query = new URLSearchParams({
    count: String(count),
    cursor
  });
  // Omit skip_status for 'following' (samples best practice) to allow status in response
  // for last post enrichment on Following lists. Keep for followers.
  if (listType !== 'following') {
    query.set('skip_status', 'true');
  }
  if (request.userId) {
    query.set('user_id', String(request.userId));
  } else if (screenName) {
    query.set('screen_name', screenName);
  }

  const headers = {
    Authorization: `Bearer ${bearer}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    Accept: '*/*',
    Cookie: cookieHeader,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes'
  };

  const attempts = [];

  const fetchOne = async (base) => {
    const label = 'tab@x.com';
    const resp = await fetch(`${base}?${query.toString()}`, {
      method: 'GET',
      headers,
      credentials: 'include'
    });
    const text = await resp.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {}
    if (!resp.ok) {
      const message = body?.errors?.[0]?.message || body?.error || text.slice(0, 160);
      attempts.push(`${label}: ${message}`);
      return null;
    }
    return { body, label, url: `${base}?${query.toString()}` };
  };

  return (async () => {
    for (const base of endpoints) {
      try {
        const result = await fetchOne(base);
        if (result) {
          return {
            ok: true,
            body: result.body,
            strategy: result.label,
            url: result.url,
            attempts
          };
        }
      } catch (error) {
        attempts.push(`tab@x.com: ${error.message}`);
      }
    }
    return {
      ok: false,
      error: attempts[attempts.length - 1] || 'Tab REST list fetch failed',
      attempts
    };
  })();
}

async function xcRestFetchListPageFromTab(tabId, params, options = {}) {
  if (!tabId) return null;

  const cookies = options.cookies || (await xcRestCollectAllCookies());
  const bearer = options.bearer || (await xcRestResolveBearer(tabId, { requireCaptured: true }));

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectedRestListFetch,
      args: [{
        listType: params.listType,
        screenName: params.screenName,
        userId: params.userId || null,
        cursor: params.cursor,
        count: params.count || XC_REST_PAGE_SIZE,
        cookieHeader: xcRestCookieHeader(cookies),
        bearer,
        preferredTabHost: params.preferredTabHost || null
      }]
    });
    const payload = results?.[0]?.result;
    if (!payload?.ok) {
      return {
        ok: false,
        error: payload?.error || 'Tab REST fetch failed',
        attempts: payload?.attempts || [],
        users: [],
        nextCursor: null,
        hasMore: false,
        rawCount: 0
      };
    }

    const parsed = xcRestParseListResponse(payload.body, params.listType);
    const attempts = [
      ...(payload.attempts || []).map((entry) => xcRestNormalizeAttempt(entry)).filter(Boolean),
      {
        strategy: payload.strategy || 'tab',
        users: parsed.rawCount,
        apiRawCount: parsed.apiRawCount,
        droppedCount: parsed.droppedCount,
        hasMore: parsed.hasMore,
        nextCursor: parsed.nextCursor
      }
    ];
    return {
      ok: true,
      ...parsed,
      url: payload.url,
      strategy: payload.strategy,
      attempts
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      users: [],
      nextCursor: null,
      hasMore: false,
      rawCount: 0
    };
  }
}

async function xcRestFetchListPageOnce(params, options = {}) {
  const url = xcRestBuildListUrl(params.listType, params);
  const body = await xcRestMakeApiRequest(url, 'GET', null, options);
  const parsed = xcRestParseListResponse(body, params.listType);
  return {
    ...parsed,
    url,
    strategy: params.strategy || 'unknown'
  };
}

function xcRestPinnedTabHost(pinnedStrategy) {
  if (!pinnedStrategy || !String(pinnedStrategy).startsWith('tab@')) return null;
  return 'x.com';
}

async function xcRestFetchListPage(screenName, listType, cursor = '-1', options = {}) {
  const strategies = [];
  const pageSize = options.pageSize || XC_REST_PAGE_SIZE;
  const userId = options.userId || null;
  const tabId = options.tabId || null;
  const attempts = [];
  const pinnedStrategy = options.pinnedStrategy || null;
  const tabOnly = !!pinnedStrategy && String(pinnedStrategy).startsWith('tab@');
  const tabRetries = options.tabRetries ?? (cursor !== '-1' ? 3 : 1);
  const preferredTabHost = options.preferredTabHost || xcRestPinnedTabHost(pinnedStrategy);

  const tabUserId = options.preferUserId && userId ? userId : null;
  const tabScreenName = tabUserId ? null : screenName;

  if (tabId && (tabScreenName || tabUserId) && options.preferTabContext !== false) {
    await xcRestSyncSessionFromTab(tabId);
    let lastTabFail = null;
    for (let retry = 0; retry < tabRetries; retry += 1) {
      if (retry > 0) {
        await xcRestSleep(400 * retry);
      }
      const tabResult = await xcRestFetchListPageFromTab(tabId, {
        listType,
        screenName: tabScreenName,
        userId: tabUserId,
        cursor,
        count: pageSize,
        preferredTabHost
      }, options);
      if (tabResult?.attempts?.length) attempts.push(...tabResult.attempts);
      if (tabResult?.ok) {
        return { ...tabResult, attempts };
      }
      lastTabFail = tabResult;
      if (tabResult?.error) {
        attempts.push(`tab: ${tabResult.error}`);
      }
    }
    if (tabOnly) {
      const err = new Error(lastTabFail?.error || 'Tab REST list fetch failed');
      err.attempts = attempts;
      throw err;
    }
  }

  if (tabOnly) {
    const err = new Error('Tab REST list fetch failed (no tab context)');
    err.attempts = attempts;
    throw err;
  }

  const workerOptions = {
    ...options,
    requireCaptured: true,
    bearer: options.bearer || (await xcRestResolveBearer(tabId, { requireCaptured: true }))
  };

  if (screenName) {
    strategies.push({
      strategy: 'screen_name@x.com',
      listType,
      screenName,
      cursor,
      count: pageSize
    });
  }
  if (userId) {
    strategies.push({
      strategy: 'user_id@x.com',
      listType,
      userId,
      cursor,
      count: pageSize
    });
  }

  let lastEmpty = null;

  for (const strategyParams of strategies) {
    try {
      const result = await xcRestFetchListPageOnce(strategyParams, workerOptions);
      attempts.push({
        strategy: result.strategy,
        url: result.url,
        users: result.rawCount,
        hasMore: result.hasMore
      });
      if (result.users.length > 0) {
        return { ...result, attempts };
      }
      lastEmpty = result;
    } catch (error) {
      attempts.push({
        strategy: strategyParams.strategy,
        error: error.message,
        status: error.status || 0
      });
      if (error.status === 429) {
        error.attempts = attempts;
        throw error;
      }
    }
  }

  if (lastEmpty) {
    return { ...lastEmpty, attempts };
  }

  const err = new Error('REST list fetch failed for all strategies');
  err.attempts = attempts;
  throw err;
}

function xcRestSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xcRestFormatAttempts(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return '';
  return attempts
    .map((entry) => xcRestNormalizeAttempt(entry))
    .filter(Boolean)
    .join(' | ');
}

async function xcRestTryShortfallRecovery(screenName, listType, knownTotal, collected, lastResult, requestOptions, allAttempts) {
  const gap = knownTotal - collected;
  if (gap <= 0) return null;

  const userId = requestOptions.userId || null;
  const strategies = [];

  if (lastResult?.hasValidCursor) {
    strategies.push({
      label: 'cursor-continue',
      cursor: lastResult.nextCursor,
      count: Math.min(gap + 5, XC_REST_PAGE_SIZE),
      preferUserId: false
    });
  }

  if (userId) {
    strategies.push({
      label: 'user_id-full',
      cursor: '-1',
      count: knownTotal,
      preferUserId: true
    });
  }

  strategies.push(
    {
      label: 'screen_name-full',
      cursor: '-1',
      count: knownTotal,
      preferUserId: false
    },
    {
      label: 'screen_name-sized',
      cursor: '-1',
      count: Math.min(XC_REST_PAGE_SIZE, gap + collected + 2),
      preferUserId: false
    }
  );

  for (const strat of strategies) {
    try {
      const recovery = await xcRestFetchListPage(screenName, listType, strat.cursor, {
        ...requestOptions,
        pageSize: strat.count,
        preferUserId: strat.preferUserId,
        preferTabContext: true,
        tabRetries: 2,
        pinnedStrategy: null,
        preferredTabHost: requestOptions.preferredTabHost || null
      });
      if (recovery.attempts?.length) {
        allAttempts.push({
          strategy: `tail:${strat.label}`,
          detail: xcRestFormatAttempts(recovery.attempts)
        });
      }
      if (recovery.users?.length > 0) {
        return { recovery, label: strat.label };
      }
    } catch (error) {
      if (error.attempts) allAttempts.push(...error.attempts);
      allAttempts.push({ strategy: `tail:${strat.label}`, error: error.message || String(error) });
    }
  }

  return null;
}

async function xcRestFetchFullList(screenName, listType, options = {}) {
  const pageSize = options.pageSize || XC_REST_PAGE_SIZE;
  const pageDelayMs = options.pageDelayMs ?? XC_REST_PAGE_DELAY_MS;
  const maxUsers = options.maxUsers ?? null;
  const knownTotal = options.knownTotal ?? null;
  const userId = options.userId || null;
  const tabId = options.tabId || null;
  const onPage = typeof options.onPage === 'function' ? options.onPage : null;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false;

  if (tabId) {
    await xcRestPrepareSession(tabId);
  }

  const requestOptions = {
    pageSize,
    userId,
    tabId,
    preferTabContext: options.preferTabContext !== false,
    tabRetries: options.tabRetries ?? 3
  };

  let cursor = '-1';
  let page = 0;
  let collected = 0;
  let rateLimitRetries = 0;
  let partialError = null;
  const allAttempts = [];

  while (page < XC_REST_MAX_PAGES) {
    if (shouldCancel()) {
      const error = new Error('Job cancelled');
      error.code = 'XC_CANCELLED';
      throw error;
    }

    let result;
    try {
      result = await xcRestFetchListPage(screenName, listType, cursor, requestOptions);
      rateLimitRetries = 0;
      if (result.attempts) allAttempts.push(...result.attempts);
    } catch (error) {
      if (error.attempts) allAttempts.push(...error.attempts);
      if (error.status === 429 && rateLimitRetries < 3) {
        rateLimitRetries += 1;
        const waitMs = XC_REST_RATE_LIMIT_BACKOFF_MS * rateLimitRetries;
        if (onPage) {
          await onPage({
            page,
            users: [],
            collected,
            nextCursor: cursor,
            waitingMs: waitMs,
            rateLimited: true
          });
        }
        await xcRestSleep(waitMs);
        continue;
      }
      if (collected > 0) {
        partialError = error.message || String(error);
        allAttempts.push({ strategy: 'pagination', error: partialError });
        break;
      }
      error.attemptSummary = xcRestFormatAttempts(allAttempts);
      throw error;
    }

    page += 1;
    collected += result.users.length;

    if (result.strategy) {
      requestOptions.pinnedStrategy = result.strategy;
      requestOptions.preferredTabHost = xcRestPinnedTabHost(result.strategy);
    }

    if (onPage) {
      await onPage({
        page,
        users: result.users,
        collected,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        strategy: result.strategy,
        attempts: result.attempts
      });
    }

    if (maxUsers != null && collected >= maxUsers) break;
    if (knownTotal != null && collected >= knownTotal) break;

    if (result.users.length > 0 && result.hasMore && result.hasValidCursor) {
      cursor = result.nextCursor;
      if (pageDelayMs > 0) {
        await xcRestSleep(pageDelayMs);
      }
      continue;
    }

    break;
  }

  const shortfall = knownTotal != null && collected < knownTotal
    ? knownTotal - collected
    : 0;

  return {
    collected,
    pages: page,
    knownTotal,
    shortfall,
    partialError,
    attemptSummary: xcRestFormatAttempts(allAttempts)
  };
}