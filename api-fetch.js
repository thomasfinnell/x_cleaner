// GraphQL fetch helpers for X Cleaner — reference implementation for following-list fetch
const XC_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJuFAFAAGmQ/NlzQ/ACAAANAAAAAAA';

const XC_QUERY_FALLBACKS = {
  Following: 'OLm4oHZBfqWx8jbcEhWoFw',
  UserByScreenName: '681MIj51w00Aj6dY0GXnHw',
  SearchTimeline: 'gkP4jsxb7JNUVrNh8Xz_RQ'
};

const XC_LIST_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false
};

let xcQueryCatalog = null;
let xcQueryCatalogAt = 0;
const XC_QUERY_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

function xcParseJsStringList(raw) {
  return (raw || '')
    .split(',')
    .map((value) => value.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function parseFollowPageBody(body) {
  const users = [];
  const seen = new Set();
  let nextCursor = null;

  const addUser = (userResult) => {
    if (!userResult || userResult.__typename === 'UserUnavailable') return;

    const legacy = userResult.legacy || {};
    const core = userResult.core || {};
    const screenName = (
      legacy.screen_name ||
      core.screen_name ||
      userResult.screen_name ||
      ''
    ).trim();

    if (!screenName) return;

    const key = screenName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    users.push({
      username: screenName,
      display_name: legacy.name || core.name || '',
      friends_count: legacy.friends_count ?? null,
      followers_count: legacy.followers_count ?? null,
      tweet_count: legacy.statuses_count ?? null,
      created_at: legacy.created_at || core.created_at || '',
      is_blue: !!userResult.is_blue_verified,
      default_avatar: !!legacy.default_profile_image
    });
  };

  const processEntry = (entry) => {
    if (!entry) return;

    const entryId = entry.entryId || '';
    const content = entry.content || {};

    if (
      entryId.includes('cursor-bottom') ||
      content.cursorType === 'Bottom' ||
      (content.entryType === 'TimelineTimelineCursor' && content.cursorType === 'Bottom')
    ) {
      const value = content.value || content.itemContent?.value;
      if (value) nextCursor = value;
      return;
    }

    if (entryId.includes('cursor-top') || content.cursorType === 'Top') return;

    const itemContent = content.itemContent || {};
    if (itemContent.user_results?.result) addUser(itemContent.user_results.result);
    if (itemContent.user?.result) addUser(itemContent.user.result);

    if (Array.isArray(content.items)) {
      for (const item of content.items) {
        const nested = item?.item?.itemContent || item?.itemContent || {};
        if (nested.user_results?.result) addUser(nested.user_results.result);
        if (nested.user?.result) addUser(nested.user.result);
      }
    }
  };

  const processInstructions = (instructions) => {
    if (!Array.isArray(instructions)) return;

    for (const instr of instructions) {
      for (const entry of instr.entries || []) {
        processEntry(entry);
      }
      if (instr.entry) processEntry(instr.entry);
    }
  };

  const instructionPaths = [
    body?.data?.user?.result?.timeline?.timeline?.instructions,
    body?.data?.user?.result?.timeline_v2?.timeline?.instructions,
    body?.data?.user?.result?.following_timeline?.timeline?.instructions,
    body?.data?.user?.result?.followers_timeline?.timeline?.instructions,
    body?.data?.user?.result?.timeline?.instructions
  ];

  for (const instructions of instructionPaths) {
    processInstructions(instructions);
  }

  return { users, nextCursor };
}

function formatApiError(res, context) {
  const status = res?.status || 0;
  const gqlError = res?.body?.errors?.[0]?.message;

  if (status === 401) {
    return 'X auth failed (401). Reload x.com, confirm you are logged in, then retry.';
  }
  if (status === 404) {
    return `${context} endpoint not found (404). Query ID may be stale — reload x.com and retry.`;
  }
  if (status === 429) {
    return 'Rate limited (429). Slow down and retry.';
  }
  if (gqlError) return gqlError;
  if (res?.error) return String(res.error);
  if (status) return `${context} failed (HTTP ${status}).`;
  return `${context} request failed.`;
}

async function getXSessionCookies() {
  let ct0 = null;
  let authToken = null;

  for (const url of ['https://x.com', 'https://twitter.com']) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const cookie of cookies) {
        if (cookie.name === 'ct0' && cookie.value) ct0 = cookie.value;
        if (cookie.name === 'auth_token' && cookie.value) authToken = cookie.value;
      }
    } catch (error) {}
  }

  return { ct0, authToken, loggedIn: !!(ct0 && authToken) };
}

async function prefetchQueryCatalog(force = false) {
  const now = Date.now();
  if (!force && xcQueryCatalog && now - xcQueryCatalogAt < XC_QUERY_CATALOG_TTL_MS) {
    return xcQueryCatalog;
  }

  const catalog = {};
  const ops = ['Following', 'UserByScreenName', 'SearchTimeline'];

  try {
    const homeRes = await fetch('https://x.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await homeRes.text();
    const mainMatch = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-z0-9]+\.js/);
    if (!mainMatch) throw new Error('main.js URL not found');

    const jsRes = await fetch(mainMatch[0], {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const js = await jsRes.text();

    for (const op of ops) {
      const re = new RegExp(
        'queryId:"([^"]+)",operationName:"' + op + '",operationType:"query",metadata:\\{featureSwitches:\\[([^\\]]*)\\](?:,fieldToggles:\\[([^\\]]*)\\])?'
      );
      const match = js.match(re);
      if (match) {
        catalog[op] = {
          queryId: match[1],
          featureSwitches: xcParseJsStringList(match[2]),
          fieldToggles: xcParseJsStringList(match[3] || '')
        };
      }
    }
  } catch (error) {
    console.warn('[X Cleaner] prefetchQueryCatalog failed', error);
  }

  for (const op of ops) {
    if (!catalog[op]) {
      catalog[op] = { queryId: XC_QUERY_FALLBACKS[op] };
    }
  }

  xcQueryCatalog = catalog;
  xcQueryCatalogAt = now;
  return catalog;
}

async function fetchGraphQLFromWorker(opName, variables, options = {}) {
  const { catalog, ct0, referer } = options;
  const meta = catalog?.[opName] || {};
  const qid = meta.queryId || XC_QUERY_FALLBACKS[opName];

  if (!qid) {
    return { ok: false, status: 0, error: 'No queryId for ' + opName, body: {} };
  }

  const url =
    `https://x.com/i/api/graphql/${qid}/${opName}` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(XC_LIST_FEATURES))}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XC_BEARER_TOKEN}`,
        Referer: referer || 'https://x.com/',
        Origin: 'https://x.com',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-csrf-token': ct0 || ''
      },
      credentials: 'include'
    });

    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: String(error), body: {} };
  }
}

async function fetchFollowingPageWorker(params) {
  const { userId, screenName, cursor, count, catalog, ct0 } = params;
  const variables = {
    userId: String(userId),
    count: count || 100,
    includePromotedContent: false
  };
  if (cursor) variables.cursor = cursor;

  const res = await fetchGraphQLFromWorker('Following', variables, {
    catalog,
    ct0,
    referer: `https://x.com/${screenName}/following`
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: formatApiError(res, 'Following'),
      users: [],
      nextCursor: null
    };
  }

  if (res.body?.errors?.length) {
    return {
      ok: false,
      status: res.status,
      error: res.body.errors[0].message || 'GraphQL error',
      users: [],
      nextCursor: null
    };
  }

  const parsed = parseFollowPageBody(res.body);
  return {
    ok: true,
    status: res.status,
    users: parsed.users,
    nextCursor: parsed.nextCursor,
    pageCount: parsed.users.length
  };
}

function readNativeList(opName, minSeq) {
  const min = minSeq || 0;
  const op = opName || 'Following';

  try {
    const queueKey = `xc_list_queue_${op}`;
    const latestKey = `xc_list_latest_${op}`;
    const queueRaw = sessionStorage.getItem(queueKey);
    if (queueRaw) {
      const queue = JSON.parse(queueRaw);
      const pending = queue.filter((batch) => (batch.seq || 0) > min);
      if (pending.length > 0) {
        const users = [];
        let maxSeq = min;
        for (const batch of pending) {
          maxSeq = Math.max(maxSeq, batch.seq || 0);
          for (const user of batch.users || []) {
            users.push(user);
          }
        }
        const kept = queue.filter((batch) => (batch.seq || 0) <= min);
        sessionStorage.setItem(queueKey, JSON.stringify(kept));
        if (users.length > 0) {
          return { users, seq: maxSeq };
        }
        return { users: [], seq: maxSeq };
      }
    }

    const raw = sessionStorage.getItem(latestKey);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if ((data.seq || 0) > min && (data.users || []).length > 0) {
      return data;
    }
  } catch (error) {}
  return null;
}

function readNativeFollowingList(minSeq) {
  return readNativeList('Following', minSeq);
}

function injectedScrollListToLoad() {
  try {
    const labels = ['Timeline: Following', 'Timeline: Followers', 'Following', 'Followers'];
    for (const label of labels) {
      const region = document.querySelector(`[aria-label="${label}"]`);
      if (region) region.scrollTop = region.scrollHeight;
    }
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    }
  } catch (error) {}
}

async function waitForNativeList(tabId, opName, minSeq, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const data = await executeOnTab(tabId, readNativeList, [opName, minSeq]);
    if (data) return data;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return null;
}

async function waitForNativeFollowingList(tabId, minSeq, timeoutMs = 10000) {
  return waitForNativeList(tabId, 'Following', minSeq, timeoutMs);
}

function readCreatorSubscriptionsCapture() {
  try {
    const raw = sessionStorage.getItem('xc_creator_subs_latest');
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.ok) return null;
    return data;
  } catch (error) {}
  return null;
}

async function waitForCreatorSubscriptionsCapture(tabId, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const data = await executeOnTab(tabId, readCreatorSubscriptionsCapture);
    if (data) return data;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return null;
}

async function searchLastActiveBatch(tabId, query, count, catalog) {
  return executeOnTab(tabId, injectedXCleanerApiCall, [{
    action: 'searchLastActive',
    query,
    count,
    queryCatalog: catalog
  }]);
}

async function fetchFollowingPageFromTab(tabId, params) {
  return executeOnTab(tabId, injectedXCleanerApiCall, [{
    action: 'followPage',
    userId: params.userId,
    screenName: params.screenName,
    cursor: params.cursor,
    count: params.count,
    queryCatalog: params.catalog,
    capturedTemplate: params.capturedTemplate || null
  }]);
}

async function injectedXCleanerApiCall(request) {
  const FALLBACK_QID = {
    Following: 'OLm4oHZBfqWx8jbcEhWoFw',
    UserByScreenName: '681MIj51w00Aj6dY0GXnHw',
    SearchTimeline: 'gkP4jsxb7JNUVrNh8Xz_RQ'
  };

  const FEATURES = {
    rweb_video_screen_enabled: false,
    rweb_cashtags_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    rweb_conversational_replies_downvote_enabled: false,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };

  const parseFollowPageBodyLocal = (body) => {
    const users = [];
    const seen = new Set();
    let nextCursor = null;

    const addUser = (userResult) => {
      if (!userResult || userResult.__typename === 'UserUnavailable') return;
      const legacy = userResult.legacy || {};
      const core = userResult.core || {};
      const screenName = (legacy.screen_name || core.screen_name || '').trim();
      if (!screenName || seen.has(screenName.toLowerCase())) return;
      seen.add(screenName.toLowerCase());
      users.push({
        username: screenName,
        display_name: legacy.name || core.name || '',
        friends_count: legacy.friends_count ?? null,
        followers_count: legacy.followers_count ?? null,
        tweet_count: legacy.statuses_count ?? null,
        created_at: legacy.created_at || core.created_at || '',
        is_blue: !!userResult.is_blue_verified,
        default_avatar: !!legacy.default_profile_image
      });
    };

    const processEntry = (entry) => {
      if (!entry) return;
      const entryId = entry.entryId || '';
      const content = entry.content || {};
      if (entryId.includes('cursor-bottom') || content.cursorType === 'Bottom') {
        const value = content.value || content.itemContent?.value;
        if (value) nextCursor = value;
        return;
      }
      const itemContent = content.itemContent || {};
      if (itemContent.user_results?.result) addUser(itemContent.user_results.result);
    };

    const instructionPaths = [
      body?.data?.user?.result?.timeline?.timeline?.instructions,
      body?.data?.user?.result?.timeline_v2?.timeline?.instructions,
      body?.data?.user?.result?.following_timeline?.timeline?.instructions,
      body?.data?.user?.result?.followers_timeline?.timeline?.instructions,
      body?.data?.user?.result?.timeline?.instructions
    ];

    for (const instructions of instructionPaths) {
      if (!Array.isArray(instructions)) continue;
      for (const instr of instructions) {
        for (const entry of instr.entries || []) processEntry(entry);
      }
    }

    return { users, nextCursor };
  };

  const buildHeaders = (referer) => {
    let ct0 = '';
    try {
      const match = document.cookie.match(/(?:^|; )ct0=([^;]+)/);
      if (match) ct0 = decodeURIComponent(match[1]);
    } catch (error) {}

    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      Referer: referer || 'https://x.com/',
      Origin: 'https://x.com',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-csrf-token': ct0
    };
  };

  const finishFollowPage = (res) => {
    if (!res.ok) {
      const status = res.status || 0;
      let error = `Following tab request failed (HTTP ${status})`;
      if (status === 401) {
        error = 'X auth failed (401) in tab. Reload x.com and retry.';
      } else if (status === 404) {
        error = 'Following endpoint not found (404) in tab.';
      } else if (res.body?.errors?.[0]?.message) {
        error = res.body.errors[0].message;
      }
      return { ok: false, status, error, users: [], nextCursor: null };
    }

    if (res.body?.errors?.length) {
      return {
        ok: false,
        status: res.status,
        error: res.body.errors[0].message || 'GraphQL error',
        users: [],
        nextCursor: null
      };
    }

    const parsed = parseFollowPageBodyLocal(res.body);
    return {
      ok: true,
      status: res.status,
      users: parsed.users,
      nextCursor: parsed.nextCursor,
      pageCount: parsed.users.length
    };
  };

  const action = request.action;

  if (action === 'followPage') {
    const screenName = String(request.screenName || '').replace(/^@+/, '');
    const referer = `https://x.com/${screenName}/following`;
    const variables = {
      userId: String(request.userId),
      count: request.count || 100,
      includePromotedContent: false
    };
    if (request.cursor) variables.cursor = request.cursor;

    const capturedTemplate = request.capturedTemplate;
    if (!request.cursor && capturedTemplate?.url) {
      const resp = await fetch(capturedTemplate.url, {
        method: capturedTemplate.method || 'GET',
        headers: buildHeaders(referer),
        credentials: 'include'
      });
      const body = await resp.json().catch(() => ({}));
      return finishFollowPage({ ok: resp.ok, status: resp.status, body });
    }

    const catalog = request.queryCatalog || {};
    const meta = catalog.Following || {};
    const qid = meta.queryId || FALLBACK_QID.Following;
    const url =
      `https://x.com/i/api/graphql/${qid}/Following` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(referer),
      credentials: 'include'
    });
    const body = await resp.json().catch(() => ({}));
    return finishFollowPage({ ok: resp.ok, status: resp.status, body });
  }

  if (action === 'searchLastActive') {
    const q = request.query || '';
    const count = request.count || 20;
    const catalog = request.queryCatalog || {};
    const meta = catalog.SearchTimeline || {};
    const qid = meta.queryId || FALLBACK_QID.SearchTimeline;
    const variables = {
      rawQuery: q,
      count,
      querySource: 'typed_query',
      product: 'Latest'
    };
    const url =
      `https://x.com/i/api/graphql/${qid}/SearchTimeline` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders('https://x.com/explore'),
      credentials: 'include'
    });
    const body = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: body?.errors?.[0]?.message || `Search failed (HTTP ${resp.status})`,
        lastActive: {}
      };
    }

    const lastActive = {};
    const instructions =
      body?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

    for (const instr of instructions) {
      if (instr.type !== 'TimelineAddEntries' || !instr.entries) continue;
      for (const entry of instr.entries) {
        const tweetRes = entry?.content?.itemContent?.tweet_results?.result;
        if (!tweetRes?.legacy) continue;
        const legacy = tweetRes.legacy;
        const userLegacy = tweetRes.core?.user_results?.result?.legacy || {};
        const sn = (userLegacy.screen_name || '').toLowerCase();
        if (!sn || !legacy.created_at) continue;
        const ts = Date.parse(legacy.created_at);
        if (Number.isNaN(ts)) continue;
        if (!lastActive[sn] || ts > lastActive[sn]) {
          lastActive[sn] = ts;
        }
      }
    }

    return { ok: true, status: resp.status, lastActive };
  }

  if (action === 'downloadCsv') {
    const blob = new Blob([request.csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = request.filename || 'x_following_export.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    return { ok: true };
  }

  return { ok: false, error: 'Unknown action: ' + action };
}

async function executeOnTab(tabId, func, args, world = 'MAIN') {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args: args || []
  });
  return results?.[0]?.result;
}