// GraphQL fetch helpers for X Cleaner — reference implementation for following-list fetch
const XC_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJuFAFAAGmQ/NlzQ/ACAAANAAAAAAA';

const XC_QUERY_FALLBACKS = {
  Following: 'OLm4oHZBfqWx8jbcEhWoFw',
  Followers: '9jsVJ9l2uXUIKslHvJqIhw',
  BlueVerifiedFollowers: '9jsVJ9l2uXUIKslHvJqIhw',
  UserByScreenName: '681MIj51w00Aj6dY0GXnHw',
  SearchTimeline: 'gkP4jsxb7JNUVrNh8Xz_RQ',
  UserCreatorSubscriptions: '8qiWrxuavgRRACul8oJo4w'
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

const XC_NON_LIST_ENTRY_ID = /who-to-follow|who_to_follow|whotofollow|suggest|pymk|recommend|similar|promoted|connect|grok|messageprompt|subscribed|ranked|trend|explore|advertiser|recap|listheader|divider|label|cursor-top/i;
const XC_SUGGESTION_SOCIAL_TEXT = /who to follow|people to follow|suggested for you|because you follow|followed by people|popular in your|similar to @/i;

function relationshipHintsFromItemContent(itemContent) {
  if (!itemContent) return {};
  const hints = {};
  const socialText = String(
    itemContent.socialContext?.text
    || itemContent.social_context?.text
    || ''
  ).toLowerCase();
  if (socialText.includes('follows you')) hints.follows_you = true;
  const displayType = String(itemContent.userDisplayType || '').toLowerCase();
  if (
    XC_SUGGESTION_SOCIAL_TEXT.test(socialText)
    || /recommend|suggest|pymk|similar/.test(displayType)
  ) {
    hints.you_follow = false;
  }
  return hints;
}

function entryMetaFromItemContent(itemContent, entryId) {
  const socialText = String(
    itemContent?.socialContext?.text
    || itemContent?.social_context?.text
    || ''
  );
  const displayType = String(itemContent?.userDisplayType || '');
  const socialLower = socialText.toLowerCase();
  const displayLower = displayType.toLowerCase();
  const idLower = String(entryId || '').toLowerCase();
  const isSuggestion = XC_SUGGESTION_SOCIAL_TEXT.test(socialLower)
    || /recommend|suggest|pymk|similar/.test(displayLower)
    || (idLower && XC_NON_LIST_ENTRY_ID.test(idLower) && !idLower.startsWith('user-'));
  return {
    _xcEntryId: String(entryId || ''),
    _xcSocialContext: socialText,
    _xcUserDisplayType: displayType,
    _xcSuggestion: isSuggestion
  };
}

function xcIsSuggestionFollowingUser(user) {
  if (!user) return true;
  if (user.you_follow === false) return true;
  if (user._xcSuggestion === true) return true;
  const social = String(user._xcSocialContext || '').toLowerCase();
  if (XC_SUGGESTION_SOCIAL_TEXT.test(social)) return true;
  const displayType = String(user._xcUserDisplayType || '').toLowerCase();
  if (/recommend|suggest|pymk|similar/.test(displayType)) return true;
  const entryId = String(user._xcEntryId || '').toLowerCase();
  if (entryId && XC_NON_LIST_ENTRY_ID.test(entryId) && !entryId.startsWith('user-')) return true;
  return false;
}

function xcDomListMemberCheck(cell, listKind) {
  if (typeof window.__xcDomUserIsFollowingListMember === 'function') {
    return window.__xcDomUserIsFollowingListMember(cell, listKind);
  }
  return xcDomUserIsFollowingListMember(cell, listKind);
}

function xcDomYouFollowFromCell(cell, listKind) {
  if (listKind !== 'following') return null;
  if (typeof window.__xcDomUserCellShowsFollowingState === 'function' && window.__xcDomUserCellShowsFollowingState(cell)) {
    return true;
  }
  if (typeof window.__xcDomUserCellShowsFollowAction === 'function' && window.__xcDomUserCellShowsFollowAction(cell)) {
    return false;
  }
  return null;
}

function xcIsVerifiedFollowingListUser(user) {
  if (xcIsSuggestionFollowingUser(user)) return false;
  if (user._xcDomVerified === true) return true;
  if (user._xcFromFollowingOp === true) return true;
  if (user.you_follow === true) return true;
  if (user._xcTrustedFollow === true && user.you_follow !== false) return true;
  return false;
}

function xcFilterFollowingListUsers(users, opName = 'Following') {
  if (opName !== 'Following') return users || [];
  return (users || []).filter((user) => xcIsVerifiedFollowingListUser(user));
}

function isSuggestionTimelineModule(content, entryId) {
  const idLower = String(entryId || '').toLowerCase();
  if (XC_NON_LIST_ENTRY_ID.test(idLower) && !idLower.startsWith('user-')) return true;
  const moduleText = [
    content?.header?.text,
    content?.footer?.text,
    content?.clientEventInfo?.component,
    content?.displayType
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return XC_SUGGESTION_SOCIAL_TEXT.test(moduleText) || /who to follow|people to follow/.test(moduleText);
}

function xcDomUserIsFollowingListMember(cell, listKind) {
  if (!cell || listKind !== 'following') return true;
  if (cell.closest('[data-testid="sidebarColumn"]')) return false;

  let parent = cell.parentElement;
  for (let depth = 0; parent && depth < 16; depth += 1, parent = parent.parentElement) {
    for (const heading of parent.querySelectorAll('h2, [role="heading"]')) {
      const text = (heading.textContent || '').trim().toLowerCase();
      if (text === 'who to follow' || /^people to follow/.test(text)) return false;
    }
    const aria = (parent.getAttribute('aria-label') || '').toLowerCase();
    if (/who to follow|people to follow|suggest/.test(aria)) return false;
  }

  if (cell.querySelector('[data-testid="userFollow"]')) return false;
  for (const btn of cell.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (/^follow @/.test(label) && !label.includes('following')) return false;
  }
  for (const btn of cell.querySelectorAll('button, [role="button"]')) {
    const text = (btn.textContent || '').trim().toLowerCase();
    if (text === 'follow') return false;
  }
  return true;
}

function entryHasTrustedListUser(content) {
  const itemContent = content?.itemContent;
  return !!(
    itemContent?.user_results?.result
    || itemContent?.user?.result
  );
}

function readViewerRelationship(userResult, hints = {}) {
  if (!userResult || userResult.__typename === 'UserUnavailable') {
    return {
      you_follow: hints.you_follow ?? null,
      follows_you: hints.follows_you ?? null
    };
  }

  const legacy = userResult.legacy || {};
  const rel = userResult.relationship_perspectives || userResult.relationship || {};
  let youFollow = legacy.following;
  let followsYou = legacy.followed_by;

  if (youFollow == null && typeof rel.following === 'boolean') youFollow = rel.following;
  if (followsYou == null && typeof rel.followed_by === 'boolean') followsYou = rel.followed_by;
  if (youFollow == null && typeof userResult.following === 'boolean') youFollow = userResult.following;
  if (followsYou == null && typeof userResult.followed_by === 'boolean') followsYou = userResult.followed_by;

  if (hints.you_follow != null) youFollow = hints.you_follow;
  if (hints.follows_you != null) followsYou = hints.follows_you;

  return {
    you_follow: typeof youFollow === 'boolean' ? youFollow : null,
    follows_you: typeof followsYou === 'boolean' ? followsYou : null
  };
}

function parseFollowPageBody(body, listOpName = null) {
  const users = [];
  const seen = new Set();
  let nextCursor = null;

  const addUser = (userResult, hints = {}, trustedFollowEntry = false) => {
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
    const relationship = readViewerRelationship(userResult, hints);
    const isSuggestion = hints._xcSuggestion === true || relationship.you_follow === false;
    if (seen.has(key)) {
      const existing = users.find((user) => user.username.toLowerCase() === key);
      if (existing) {
        if (existing.you_follow == null && relationship.you_follow != null) existing.you_follow = relationship.you_follow;
        if (existing.follows_you == null && relationship.follows_you != null) existing.follows_you = relationship.follows_you;
        if (trustedFollowEntry) existing._xcTrustedFollow = true;
        if (isSuggestion) existing._xcSuggestion = true;
        if (!existing._xcEntryId && hints._xcEntryId) existing._xcEntryId = hints._xcEntryId;
        if (!existing._xcSocialContext && hints._xcSocialContext) existing._xcSocialContext = hints._xcSocialContext;
        if (!existing._xcUserDisplayType && hints._xcUserDisplayType) existing._xcUserDisplayType = hints._xcUserDisplayType;
      }
      return;
    }
    seen.add(key);

    users.push({
      username: screenName,
      display_name: legacy.name || core.name || '',
      friends_count: legacy.friends_count ?? null,
      followers_count: legacy.followers_count ?? null,
      tweet_count: legacy.statuses_count ?? null,
      created_at: legacy.created_at || core.created_at || '',
      bio: String(legacy.description || core.description || '').trim(),
      is_blue: !!userResult.is_blue_verified,
      default_avatar: !!legacy.default_profile_image,
      you_follow: relationship.you_follow,
      follows_you: relationship.follows_you,
      _xcEntryId: hints._xcEntryId || '',
      _xcSocialContext: hints._xcSocialContext || '',
      _xcUserDisplayType: hints._xcUserDisplayType || '',
      _xcSuggestion: isSuggestion,
      _xcTrustedFollow: trustedFollowEntry
    });
  };

  const absorbUserNode = (node, hints = {}, trustedFollowEntry = false) => {
    if (!node || typeof node !== 'object') return;
    const itemHints = {
      ...hints,
      ...relationshipHintsFromItemContent(node.itemContent || node)
    };
    if (node.user_results?.result) addUser(node.user_results.result, itemHints, trustedFollowEntry);
    if (node.user?.result) addUser(node.user.result, itemHints, trustedFollowEntry);
    if (node.itemContent?.user_results?.result) addUser(node.itemContent.user_results.result, itemHints, trustedFollowEntry);
    if (node.itemContent?.user?.result) addUser(node.itemContent.user.result, itemHints, trustedFollowEntry);
    if (node.legacy || node.core || node.__typename === 'User') addUser(node, itemHints, trustedFollowEntry);
  };

  const processModuleItems = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      absorbUserNode(item?.item?.itemContent || item?.itemContent || item?.content?.itemContent);
      absorbUserNode(item?.item?.content || item?.content);
      if (Array.isArray(item?.item?.content?.items)) {
        processModuleItems(item.item.content.items);
      }
    }
  };

  const processEntry = (entry) => {
    if (!entry) return;

    const entryId = entry.entryId || '';
    const content = entry.content || entry.item || {};

    if (
      entryId.includes('cursor-bottom') ||
      entryId.startsWith('cursor-bottom') ||
      content.cursorType === 'Bottom' ||
      (content.entryType === 'TimelineTimelineCursor' && content.cursorType === 'Bottom')
    ) {
      const value =
        content.value
        || content.itemContent?.value
        || content.cursor?.value
        || content.content?.value;
      if (value) nextCursor = value;
      return;
    }

    if (entryId.includes('cursor-top') || content.cursorType === 'Top') return;
    if (isSuggestionTimelineModule(content, entryId)) return;

    if (content.entryType === 'TimelineTimelineModule') {
      processModuleItems(content.items);
      return;
    }

    const entryHints = {
      ...relationshipHintsFromItemContent(content.itemContent),
      ...entryMetaFromItemContent(content.itemContent, entryId)
    };
    const trustedFollowEntry = listOpName !== 'Following'
      || String(entryId).toLowerCase().startsWith('user-')
      || entryHasTrustedListUser(content);
    absorbUserNode(content.itemContent, entryHints, trustedFollowEntry);
    processModuleItems(content.items);
  };

  const processInstructions = (instructions) => {
    if (!Array.isArray(instructions)) return;

    for (const instr of instructions) {
      for (const entry of instr.entries || []) {
        processEntry(entry);
      }
      if (instr.entry) processEntry(instr.entry);
      if (Array.isArray(instr.moduleItems)) {
        processModuleItems(instr.moduleItems);
      }
    }
  };

  const result = body?.data?.user?.result || body?.data?.user || {};
  const instructionPaths = [
    result.timeline?.timeline?.instructions,
    result.timeline_v2?.timeline?.instructions,
    result.following_timeline?.timeline?.instructions,
    result.followers_timeline?.timeline?.instructions,
    result.timeline?.instructions
  ];

  for (const instructions of instructionPaths) {
    processInstructions(instructions);
  }

  const connections = [
    result.followers_connection,
    result.following_connection,
    result.timeline?.followers_connection,
    result.timeline?.following_connection
  ];
  for (const conn of connections) {
    if (!conn) continue;
    const pageInfo = conn.page_info || conn.pageInfo || {};
    if (pageInfo.has_next_page !== false) {
      nextCursor = nextCursor
        || pageInfo.next_cursor
        || pageInfo.end_cursor
        || pageInfo.nextCursor
        || null;
    }
    const trustedConn = listOpName === 'Following';
    for (const edge of conn.edges || []) {
      absorbUserNode(edge?.node, {}, trustedConn);
      absorbUserNode(edge?.itemContent, {}, trustedConn);
      absorbUserNode(edge?.itemContent?.user_results?.result, {}, trustedConn);
      absorbUserNode(edge?.itemContent?.user?.result, {}, trustedConn);
    }
  }

  const scanForBottomCursor = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 22) return;
    if (Array.isArray(node)) {
      for (const item of node) scanForBottomCursor(item, depth + 1);
      return;
    }
    const entryId = String(node.entryId || '');
    const content = node.content || node.item || node;
    if (
      entryId.includes('cursor-bottom')
      || entryId.startsWith('cursor-bottom')
      || content?.cursorType === 'Bottom'
      || (content?.entryType === 'TimelineTimelineCursor' && content?.cursorType === 'Bottom')
    ) {
      const value =
        content?.value
        || content?.itemContent?.value
        || content?.cursor?.value
        || content?.content?.value;
      if (value) nextCursor = nextCursor || value;
    }
    for (const value of Object.values(node)) scanForBottomCursor(value, depth + 1);
  };
  if (!nextCursor) scanForBottomCursor(body?.data, 0);

  if (listOpName === 'Following') {
    for (const user of users) {
      if (!user._xcSuggestion && user.you_follow == null) user.you_follow = true;
      user._xcFromFollowingOp = true;
    }
    if (!users.length) {
      const walk = (node, depth, parentEntryId = '') => {
        if (!node || typeof node !== 'object' || depth > 22) return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1, parentEntryId);
          return;
        }
        const entryId = node.entryId || parentEntryId || '';
        const itemContent = node.itemContent || node.content?.itemContent;
        if (itemContent?.user_results?.result || itemContent?.user?.result) {
          const entryHints = {
            ...relationshipHintsFromItemContent(itemContent),
            ...entryMetaFromItemContent(itemContent, entryId)
          };
          absorbUserNode(itemContent, entryHints, true);
        }
        for (const value of Object.values(node)) walk(value, depth + 1, entryId);
      };
      walk(body?.data, 0);
      for (const user of users) {
        if (!user._xcSuggestion && user.you_follow == null) user.you_follow = true;
        user._xcFromFollowingOp = true;
      }
    }
    return {
      users: users.filter((user) => xcIsVerifiedFollowingListUser(user)),
      nextCursor
    };
  }

  return { users, nextCursor };
}

function mergeListPageResults(tabRes, workerRes) {
  const tabOk = tabRes?.ok;
  const workerOk = workerRes?.ok;
  if (!tabOk && !workerOk) {
    return tabRes || workerRes || { ok: false, error: 'GraphQL page failed', users: [], nextCursor: null };
  }
  if (!tabOk) return workerRes;
  if (!workerOk) return tabRes;

  const userMap = new Map();
  for (const user of workerRes.users || []) {
    const key = (user.username || '').toLowerCase();
    if (key) userMap.set(key, user);
  }
  for (const user of tabRes.users || []) {
    const key = (user.username || '').toLowerCase();
    if (key) userMap.set(key, user);
  }

  const users = Array.from(userMap.values());
  return {
    ok: true,
    status: tabRes.status || workerRes.status,
    users,
    nextCursor: tabRes.nextCursor || workerRes.nextCursor || null,
    pageCount: users.length,
    tabCount: (tabRes.users || []).length,
    workerCount: (workerRes.users || []).length
  };
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

  for (const url of ['https://x.com']) {
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
  const ops = [
    'Following',
    'Followers',
    'BlueVerifiedFollowers',
    'UserByScreenName',
    'SearchTimeline',
    'UserCreatorSubscriptions'
  ];

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
      catalog[op] = { queryId: XC_QUERY_FALLBACKS[op] || XC_QUERY_FALLBACKS.Followers };
    }
  }
  if (!catalog.BlueVerifiedFollowers && catalog.Followers) {
    catalog.BlueVerifiedFollowers = { ...catalog.Followers };
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

async function fetchListPageWorker(params) {
  const {
    opName = 'Following',
    userId,
    screenName,
    cursor,
    count,
    catalog,
    ct0,
    listPath
  } = params;
  const path = listPath || (opName === 'Followers' ? 'followers' : 'following');
  const variables = {
    userId: String(userId),
    count: count || 100,
    includePromotedContent: false
  };
  if (cursor) variables.cursor = cursor;

  const res = await fetchGraphQLFromWorker(opName, variables, {
    catalog,
    ct0,
    referer: `https://x.com/${screenName}/${path}`
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: formatApiError(res, opName),
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

  const parsed = parseFollowPageBody(res.body, opName);
  return {
    ok: true,
    status: res.status,
    users: parsed.users,
    nextCursor: parsed.nextCursor,
    pageCount: parsed.users.length
  };
}

async function fetchFollowingPageWorker(params) {
  return fetchListPageWorker({ ...params, opName: 'Following' });
}

function nativeListStorageKeys(opName) {
  const op = opName || 'Following';
  if (op === 'Followers') {
    return {
      queueKeys: ['xc_list_queue_Followers'],
      latestKeys: ['xc_list_latest_Followers']
    };
  }
  return {
    queueKeys: [`xc_list_queue_${op}`],
    latestKeys: [`xc_list_latest_${op}`]
  };
}

function readNativeList(opName, minSeq) {
  const min = minSeq || 0;
  const op = opName || 'Following';
  let queueKeys;
  let latestKeys;
  if (op === 'Followers') {
    queueKeys = ['xc_list_queue_Followers'];
    latestKeys = ['xc_list_latest_Followers'];
  } else {
    queueKeys = [`xc_list_queue_${op}`];
    latestKeys = [`xc_list_latest_${op}`];
  }

  try {
    for (const queueKey of queueKeys) {
      const queueRaw = sessionStorage.getItem(queueKey);
      if (!queueRaw) continue;
      const queue = JSON.parse(queueRaw);
      const pending = queue.filter((batch) => (batch.seq || 0) > min);
      if (!pending.length) continue;

      const users = [];
      let maxSeq = min;
      let nextCursor = null;
      for (const batch of pending) {
        maxSeq = Math.max(maxSeq, batch.seq || 0);
        if (batch.nextCursor) nextCursor = batch.nextCursor;
        for (const user of batch.users || []) {
          users.push(user);
        }
      }
      const kept = queue.filter((batch) => (batch.seq || 0) <= maxSeq);
      sessionStorage.setItem(queueKey, JSON.stringify(kept));
      const filteredUsers = xcFilterFollowingListUsers(users, op);
      return {
        users: filteredUsers,
        seq: maxSeq,
        nextCursor,
        rawCount: users.length
      };
    }

    for (const latestKey of latestKeys) {
      const raw = sessionStorage.getItem(latestKey);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if ((data.seq || 0) > min && (data.users || []).length > 0) {
        const filteredUsers = xcFilterFollowingListUsers(data.users || [], op);
        return {
          ...data,
          users: filteredUsers,
          rawCount: (data.users || []).length
        };
      }
    }
  } catch (error) {}
  return null;
}

function readNativeListCursor(opName) {
  let latestKeys;
  const op = opName || 'Following';
  if (op === 'Followers') {
    latestKeys = ['xc_list_latest_Followers'];
  } else {
    latestKeys = [`xc_list_latest_${op}`];
  }
  try {
    for (const latestKey of latestKeys) {
      const raw = sessionStorage.getItem(latestKey);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (data?.nextCursor) return data.nextCursor;
    }
  } catch (error) {}
  return null;
}

function readLatestSnifferListTemplate(opName) {
  const keys = opName === 'Followers'
    ? ['Followers']
    : [opName];
  for (const key of keys) {
    try {
      const raw = sessionStorage.getItem(`xc_list_latest_${key}`);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (data?.url) return { url: data.url, method: 'GET' };
    } catch (error) {}
  }
  return null;
}

function readCapturedListTemplate(opName) {
  try {
    const fromSniffer = readLatestSnifferListTemplate(opName);
    if (fromSniffer) return fromSniffer;

    const captured = window.__xcCapturedGql || {};
    const pick = (key) => (captured[key]?.url ? captured[key] : null);
    const direct = pick(opName);
    if (direct) return direct;
    if (opName === 'Followers') {
      const gqlEntries = performance.getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/i/api/graphql/'));
      const followersEntries = gqlEntries.filter((entry) => (
        entry.name.includes('/Followers')
        && !entry.name.includes('BlueVerifiedFollowers')
      ));
      if (followersEntries.length) {
        const url = followersEntries[followersEntries.length - 1].name;
        return { url, method: 'GET' };
      }
    }
  } catch (error) {}
  return null;
}

function readEffectiveListPath(screenName, preferredPath) {
  const handle = String(screenName || '').replace(/^@+/, '').toLowerCase();
  const pathname = (location.pathname || '').toLowerCase();
  if (!handle || !pathname) return preferredPath || 'following';

  if (preferredPath === 'following') {
    const base = `/${handle}/following`;
    if (pathname === base || pathname.startsWith(`${base}/`)) return 'following';
    return preferredPath;
  }

  const followersBase = `/${handle}/followers`;
  if (pathname === followersBase || pathname.startsWith(`${followersBase}/`)) {
    return 'followers';
  }
  // Never use verified_followers for all-followers collection — always target /followers.
  return preferredPath === 'followers' ? 'followers' : (preferredPath || 'followers');
}

function readCapturedListOpName(opName) {
  const template = readCapturedListTemplate(opName);
  if (!template?.url) return opName;
  try {
    const match = template.url.match(/\/graphql\/[^/]+\/([^/?]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch (error) {}
  return opName;
}

function readNativeListQueueDrain(opName) {
  const { queueKeys, latestKeys } = nativeListStorageKeys(opName);
  const users = [];
  const seen = new Set();
  let nextCursor = null;

  const absorbBatch = (batch) => {
    if (!batch) return;
    if (batch.nextCursor) nextCursor = batch.nextCursor;
    for (const user of batch.users || []) {
      const key = (user.username || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      users.push(user);
    }
  };

  try {
    for (const queueKey of queueKeys) {
      const raw = sessionStorage.getItem(queueKey);
      if (!raw) continue;
      const queue = JSON.parse(raw);
      if (Array.isArray(queue)) {
        for (const batch of queue) absorbBatch(batch);
      }
    }
    for (const latestKey of latestKeys) {
      const raw = sessionStorage.getItem(latestKey);
      if (!raw) continue;
      absorbBatch(JSON.parse(raw));
    }
  } catch (error) {}

  return { users: xcFilterFollowingListUsers(users, opName), nextCursor };
}

function readNativeListAllCursors(opName) {
  const { queueKeys, latestKeys } = nativeListStorageKeys(opName);
  const cursors = [];
  const seen = new Set();

  const addCursor = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    cursors.push(value);
  };

  try {
    for (const queueKey of queueKeys) {
      const raw = sessionStorage.getItem(queueKey);
      if (!raw) continue;
      const queue = JSON.parse(raw);
      if (!Array.isArray(queue)) continue;
      for (const batch of queue) addCursor(batch?.nextCursor);
    }
    for (const latestKey of latestKeys) {
      const raw = sessionStorage.getItem(latestKey);
      if (!raw) continue;
      addCursor(JSON.parse(raw)?.nextCursor);
    }
  } catch (error) {}

  return cursors;
}

function readNativeListTailCursors(opName, limit = 6) {
  const { queueKeys, latestKeys } = nativeListStorageKeys(opName);
  const ordered = [];

  try {
    for (const queueKey of queueKeys) {
      const raw = sessionStorage.getItem(queueKey);
      if (!raw) continue;
      const queue = JSON.parse(raw);
      if (!Array.isArray(queue)) continue;
      for (const batch of queue) {
        if (batch?.nextCursor) ordered.push(batch.nextCursor);
      }
    }
    for (const latestKey of latestKeys) {
      const raw = sessionStorage.getItem(latestKey);
      if (!raw) continue;
      const latest = JSON.parse(raw);
      if (latest?.nextCursor) ordered.push(latest.nextCursor);
    }
  } catch (error) {}

  const unique = [];
  const seen = new Set();
  for (const cursor of ordered) {
    if (!cursor || seen.has(cursor)) continue;
    seen.add(cursor);
    unique.push(cursor);
  }

  return unique.slice(-limit);
}

function injectedCollectVisibleListUsers(screenName) {
  const owner = String(screenName || '').replace(/^@+/, '').toLowerCase();
  const skip = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i',
    'compose', 'login', 'signup', 'followers', 'following', 'account', 'privacy',
    'grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'help',
    'ads', 'business', 'developers', 'xai', 'create', owner
  ].filter(Boolean));

  const findListRoot = () => (
    typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null
  );
  const listKind = typeof window.__xcListPageKind === 'function' ? window.__xcListPageKind() : null;

  const addHandle = (found, localSeen, handle, youFollow) => {
    const key = String(handle || '').toLowerCase();
    if (!key || skip.has(key) || localSeen.has(key)) return;
    if (listKind === 'following' && youFollow === false) return;
    localSeen.add(key);
    found.push({
      username: handle,
      display_name: '',
      friends_count: null,
      followers_count: null,
      tweet_count: null,
      created_at: '',
      is_blue: false,
      default_avatar: false,
      follows_you: listKind === 'followers' ? true : null,
      you_follow: listKind === 'following' ? true : null,
      _xcDomVerified: listKind === 'following'
    });
  };

  const scrapeScope = (scope) => {
    const found = [];
    const localSeen = new Set();
    scope.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
      if (typeof window.__xcDomUserIsFollowingListMember === 'function' && !window.__xcDomUserIsFollowingListMember(cell, listKind)) return;
      let youFollow = null;
      if (listKind === 'following') {
        if (typeof window.__xcDomUserCellShowsFollowingState === 'function' && window.__xcDomUserCellShowsFollowingState(cell)) {
          youFollow = true;
        } else if (typeof window.__xcDomUserCellShowsFollowAction === 'function' && window.__xcDomUserCellShowsFollowAction(cell)) {
          youFollow = false;
        }
      }
      const nameLink = cell.querySelector('[data-testid="User-Name"] a[href^="/"]');
      if (nameLink) {
        const href = (nameLink.getAttribute('href') || '').split('?')[0];
        const match = href.match(/^\/([^/]+)$/);
        if (match) addHandle(found, localSeen, match[1], youFollow);
      }

      if (!nameLink) {
        const profileLink = cell.querySelector('a[href^="/"][role="link"]');
        if (profileLink) {
          const href = (profileLink.getAttribute('href') || '').split('?')[0];
          const match = href.match(/^\/([^/]+)$/);
          if (match) addHandle(found, localSeen, match[1], youFollow);
        }
      }
    });
    return found;
  };

  const root = findListRoot();
  if (!root) return { users: [] };

  const users = [];
  const seen = new Set();
  const addBatch = (batch) => {
    for (const user of batch) {
      const key = (user.username || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      users.push(user);
    }
  };

  root.scrollTop = root.scrollHeight;
  addBatch(scrapeScope(root));

  root.scrollTop = 0;
  const maxSteps = 40;
  for (let step = 0; step < maxSteps; step += 1) {
    addBatch(scrapeScope(root));
    const stepSize = Math.max(180, Math.floor(root.clientHeight * 0.75));
    const before = root.scrollTop;
    root.scrollTop = Math.min(root.scrollTop + stepSize, root.scrollHeight);
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 6) {
      addBatch(scrapeScope(root));
      root.scrollTop = root.scrollHeight;
      addBatch(scrapeScope(root));
      break;
    }
    if (root.scrollTop <= before && step > 2) break;
  }

  return { users };
}

function injectedFindListRoot() {
  return typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null;
}

function injectedParseUserCellFromDom(cell, ownerLower, skip) {
  if (!cell) return null;
  let handle = null;
  const nameLink = cell.querySelector('[data-testid="User-Name"] a[href^="/"]');
  if (nameLink) {
    const href = (nameLink.getAttribute('href') || '').split('?')[0];
    const match = href.match(/^\/([^/]+)$/);
    if (match) handle = match[1];
  }
  if (!handle) {
    const profileLink = cell.querySelector('a[href^="/"][role="link"]');
    if (profileLink) {
      const href = (profileLink.getAttribute('href') || '').split('?')[0];
      const match = href.match(/^\/([^/]+)$/);
      if (match) handle = match[1];
    }
  }
  if (!handle) return null;
  const key = String(handle).toLowerCase();
  if (!key || skip.has(key)) return null;

  const displayEl = cell.querySelector('[data-testid="User-Name"] span');
  const displayName = displayEl ? String(displayEl.textContent || '').trim() : '';
  const isBlue = !!(
    cell.querySelector('[data-testid="icon-verified"]')
    || cell.querySelector('svg[aria-label*="Verified"]')
    || cell.querySelector('[aria-label*="Verified account"]')
  );

  return {
    username: handle,
    display_name: displayName,
    friends_count: null,
    followers_count: null,
    tweet_count: null,
    created_at: '',
    bio: '',
    is_blue: isBlue,
    default_avatar: false
  };
}

function injectedStartListObserver(screenName) {
  if (window.__xcObserveState?.observer) {
    return { ok: true, already: true };
  }

  const owner = String(screenName || '').replace(/^@+/, '').toLowerCase();
  const skip = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i',
    'compose', 'login', 'signup', 'followers', 'following', 'account', 'privacy',
    'grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'help',
    'ads', 'business', 'developers', 'xai', 'create', owner
  ].filter(Boolean));

  const findListRoot = () => (
    typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null
  );
  const listKind = typeof window.__xcListPageKind === 'function' ? window.__xcListPageKind() : null;

  const parseUserCell = (cell) => {
    if (!cell) return null;
    if (typeof window.__xcDomUserIsFollowingListMember === 'function' && !window.__xcDomUserIsFollowingListMember(cell, listKind)) return null;
    let handle = null;
    const nameLink = cell.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (nameLink) {
      const href = (nameLink.getAttribute('href') || '').split('?')[0];
      const match = href.match(/^\/([^/]+)$/);
      if (match) handle = match[1];
    }
    if (!handle) {
      const profileLink = cell.querySelector('a[href^="/"][role="link"]');
      if (profileLink) {
        const href = (profileLink.getAttribute('href') || '').split('?')[0];
        const match = href.match(/^\/([^/]+)$/);
        if (match) handle = match[1];
      }
    }
    if (!handle) return null;
    const key = String(handle).toLowerCase();
    if (!key || skip.has(key)) return null;
    const displayEl = cell.querySelector('[data-testid="User-Name"] span');
    return {
      username: handle,
      display_name: displayEl ? String(displayEl.textContent || '').trim() : '',
      friends_count: null,
      followers_count: null,
      tweet_count: null,
      created_at: '',
      bio: '',
      is_blue: !!(
        cell.querySelector('[data-testid="icon-verified"]')
        || cell.querySelector('svg[aria-label*="Verified"]')
      ),
      default_avatar: false,
      follows_you: listKind === 'followers' ? true : null,
      you_follow: listKind === 'following' ? true : null,
      _xcDomVerified: listKind === 'following'
    };
  };

  const root = findListRoot();
  if (!root) return { ok: false, error: 'list root not found' };

  const state = {
    observer: null,
    users: [],
    seen: new Set()
  };

  const ingestCell = (cell) => {
    const user = parseUserCell(cell);
    if (!user) return;
    const key = user.username.toLowerCase();
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.users.push(user);
  };

  const scanRoot = (scope) => {
    scope.querySelectorAll('[data-testid="UserCell"]').forEach(ingestCell);
  };

  scanRoot(root);

  state.observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!node || node.nodeType !== 1) continue;
        if (node.matches?.('[data-testid="UserCell"]')) ingestCell(node);
        node.querySelectorAll?.('[data-testid="UserCell"]').forEach(ingestCell);
      }
    }
  });
  state.observer.observe(root, { childList: true, subtree: true });
  window.__xcObserveState = state;
  return { ok: true, initial: state.users.length };
}

function injectedDrainObserveListUsers() {
  const state = window.__xcObserveState;
  if (!state) return { users: [] };
  const users = state.users.splice(0, state.users.length);
  return { users };
}

function injectedStopListObserver() {
  const state = window.__xcObserveState;
  if (state?.observer) {
    try {
      state.observer.disconnect();
    } catch (error) {}
  }
  window.__xcObserveState = null;
  return { ok: true };
}

function injectedCollectVisibleListUsersLight(screenName) {
  const owner = String(screenName || '').replace(/^@+/, '').toLowerCase();
  const skip = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i',
    'compose', 'login', 'signup', 'followers', 'following', 'account', 'privacy',
    'grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'help',
    'ads', 'business', 'developers', 'xai', 'create', owner
  ].filter(Boolean));

  const findListRoot = () => (
    typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null
  );
  const listKind = typeof window.__xcListPageKind === 'function' ? window.__xcListPageKind() : null;

  const parseUserCell = (cell) => {
    if (!cell) return null;
    if (typeof window.__xcDomUserIsFollowingListMember === 'function' && !window.__xcDomUserIsFollowingListMember(cell, listKind)) return null;
    let handle = null;
    const nameLink = cell.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (nameLink) {
      const href = (nameLink.getAttribute('href') || '').split('?')[0];
      const match = href.match(/^\/([^/]+)$/);
      if (match) handle = match[1];
    }
    if (!handle) {
      const profileLink = cell.querySelector('a[href^="/"][role="link"]');
      if (profileLink) {
        const href = (profileLink.getAttribute('href') || '').split('?')[0];
        const match = href.match(/^\/([^/]+)$/);
        if (match) handle = match[1];
      }
    }
    if (!handle) return null;
    const key = String(handle).toLowerCase();
    if (!key || skip.has(key)) return null;
    return {
      username: handle,
      display_name: '',
      friends_count: null,
      followers_count: null,
      tweet_count: null,
      created_at: '',
      is_blue: false,
      default_avatar: false,
      follows_you: listKind === 'followers' ? true : null,
      you_follow: listKind === 'following' ? true : null,
      _xcDomVerified: listKind === 'following'
    };
  };

  const root = findListRoot();
  if (!root) return { users: [] };

  const users = [];
  const seen = new Set();
  root.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
    const user = parseUserCell(cell);
    if (!user) return;
    const key = user.username.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    users.push(user);
  });

  return { users };
}

function readObserveDiagnostics(opName = 'Following') {
  const listKind = typeof window.__xcListPageKind === 'function' ? window.__xcListPageKind() : null;
  const root = typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null;
  let queueLen = 0;
  let latestRaw = 0;
  let latestKept = 0;
  try {
    const queueRaw = sessionStorage.getItem(`xc_list_queue_${opName}`);
    if (queueRaw) queueLen = JSON.parse(queueRaw).length;
    const latestRawKey = sessionStorage.getItem(`xc_list_latest_${opName}`);
    if (latestRawKey) {
      const latest = JSON.parse(latestRawKey);
      latestRaw = (latest.users || []).length;
      latestKept = xcFilterFollowingListUsers(latest.users || [], opName).length;
    }
  } catch (error) {}
  const captured = !!(window.__xcCapturedGql?.[opName]?.url);
  const userCells = root
    ? root.querySelectorAll('[data-testid="UserCell"]').length
    : document.querySelectorAll('[data-testid="UserCell"]').length;
  return {
    snifferVersion: window.__xcSnifferVersion || 0,
    listKind,
    listRoot: !!root,
    userCells,
    observerUsers: window.__xcObserveState?.users?.length || 0,
    queueLen,
    latestRaw,
    latestKept,
    capturedGql: captured,
    pathname: location.pathname || ''
  };
}

async function readObserveDiagnosticsFromTab(tabId, opName = 'Following') {
  return executeOnTab(tabId, readObserveDiagnostics, [opName]);
}

async function startListObserverFromTab(tabId, screenName) {
  return executeOnTab(tabId, injectedStartListObserver, [screenName]);
}

async function drainListObserverFromTab(tabId) {
  return executeOnTab(tabId, injectedDrainObserveListUsers, []);
}

async function stopListObserverFromTab(tabId) {
  return executeOnTab(tabId, injectedStopListObserver, []);
}

async function collectVisibleListUsersLightFromTab(tabId, screenName) {
  return executeOnTab(tabId, injectedCollectVisibleListUsersLight, [screenName]);
}

function readNativeFollowingList(minSeq) {
  return readNativeList('Following', minSeq);
}

function findListScrollRegion() {
  return typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null;
}

function injectedGentleScrollStep(patternIndex = 0) {
  const patterns = ['page', 'wheel', 'page', 'micro'];
  const pattern = patterns[Math.abs(Math.floor(patternIndex)) % patterns.length];

  const findRegion = () => {
    const el = typeof window.__xcResolveListRoot === 'function' ? window.__xcResolveListRoot() : null;
    if (el) {
      const label = (el.getAttribute('aria-label') || 'listTimeline').trim();
      return { el, label };
    }
    return { el: null, label: 'none' };
  };

  const { el: region, label: regionLabel } = findRegion();
  if (!region) return { pattern, moved: false, region: regionLabel };

  const nudgeWindow = () => {
    const step = Math.max(180, Math.floor((window.innerHeight || 640) * 0.45));
    const before = window.scrollY || document.documentElement.scrollTop || 0;
    window.scrollBy({ top: step, behavior: 'auto' });
    const after = window.scrollY || document.documentElement.scrollTop || 0;
    return after > before;
  };

  try {
    if (pattern === 'page') {
      const step = Math.max(180, Math.floor(region.clientHeight * 0.85));
      const before = region.scrollTop;
      region.scrollTop = Math.min(region.scrollTop + step, region.scrollHeight);
      const moved = region.scrollTop > before || nudgeWindow();
      return { pattern, moved, region: regionLabel };
    }

    if (pattern === 'wheel') {
      let moved = false;
      const chunks = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < chunks; i += 1) {
        const delta = 90 + Math.floor(Math.random() * 90);
        const before = region.scrollTop;
        region.scrollTop = Math.min(region.scrollTop + delta, region.scrollHeight);
        if (region.scrollTop > before) moved = true;
        region.dispatchEvent(new WheelEvent('wheel', {
          deltaY: delta,
          bubbles: true,
          cancelable: true
        }));
      }
      if (!moved) moved = nudgeWindow();
      return { pattern, moved, region: regionLabel };
    }

    if (pattern === 'micro') {
      region.scrollTop = Math.max(0, region.scrollTop - (60 + Math.floor(Math.random() * 50)));
      const step = Math.max(180, Math.floor(region.clientHeight * 0.85));
      const before = region.scrollTop;
      region.scrollTop = Math.min(region.scrollTop + step, region.scrollHeight);
      const moved = region.scrollTop > before || nudgeWindow();
      return { pattern, moved, region: regionLabel };
    }
  } catch (error) {}

  return { pattern, moved: nudgeWindow(), region: regionLabel };
}

async function gentleScrollStepFromTab(tabId, patternIndex = 0) {
  return executeOnTab(tabId, injectedGentleScrollStep, [patternIndex]);
}

function injectedScrollListStep() {
  try {
    const labels = ['Timeline: Followers', 'Timeline: Following', 'Followers', 'Following'];
    for (const label of labels) {
      const region = document.querySelector(`[aria-label="${label}"]`);
      if (!region) continue;
      const step = Math.max(220, Math.floor(region.clientHeight * 0.82));
      region.scrollTop = Math.min(region.scrollTop + step, region.scrollHeight);
      return true;
    }
    const main = document.querySelector('main');
    if (main) {
      const step = Math.max(220, Math.floor(main.clientHeight * 0.82));
      main.scrollTop = Math.min(main.scrollTop + step, main.scrollHeight);
    }
  } catch (error) {}
}

function injectedScrollListToTop() {
  try {
    const labels = ['Timeline: Followers', 'Timeline: Following', 'Followers', 'Following'];
    for (const label of labels) {
      const region = document.querySelector(`[aria-label="${label}"]`);
      if (region) {
        region.scrollTop = 0;
        return;
      }
    }
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
  } catch (error) {}
}

function injectedScrollListToLoad() {
  try {
    const scrollToEnd = (el) => {
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return el.scrollTop > before;
    };

    let moved = false;
    const labels = [
      'Timeline: Followers',
      'Timeline: Following',
      'Followers',
      'Following'
    ];
    for (const label of labels) {
      const region = document.querySelector(`[aria-label="${label}"]`);
      if (scrollToEnd(region)) moved = true;
    }

    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (scrollToEnd(column)) moved = true;

    document.querySelectorAll('section[role="region"]').forEach((section) => {
      if (scrollToEnd(section)) moved = true;
    });

    const main = document.querySelector('main');
    if (scrollToEnd(main)) moved = true;

    window.scrollTo(0, document.body.scrollHeight);
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    }

    if (!moved) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', code: 'End', bubbles: true }));
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1600, bubbles: true }));
    }
  } catch (error) {}
}

async function waitForNativeList(tabId, opName, minSeq, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (typeof isJobCancelled === 'function' && isJobCancelled()) return null;
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

function parseCreatorSubscriptionsBody(body) {
  const handles = new Set();
  const blocked = new Set(['grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'explore', 'help', 'ads', 'business', 'developers', 'xai', 'create', 'search']);

  const addHandle = (userResult) => {
    if (!userResult || userResult.__typename === 'UserUnavailable') return;
    const legacy = userResult.legacy || {};
    const core = userResult.core || {};
    const sn = (legacy.screen_name || core.screen_name || userResult.screen_name || '').toLowerCase();
    if (!sn || blocked.has(sn)) return;
    handles.add(sn);
  };

  const walkEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const userRes = entry?.content?.itemContent?.user_results?.result;
      if (userRes) addHandle(userRes);
    }
  };

  const walkInstructions = (instructions) => {
    if (!Array.isArray(instructions)) return;
    for (const inst of instructions) {
      if (inst.type === 'TimelineAddEntries') walkEntries(inst.entries);
      if (inst.type === 'TimelineReplaceEntry' && inst.entry) walkEntries([inst.entry]);
    }
  };

  const result =
    body?.data?.viewer?.user_results?.result
    || body?.data?.user?.result
    || body?.data?.user_result_by_rest_id?.result
    || {};

  const timelines = [
    result.creator_subscriptions_timeline?.timeline,
    result.creator_subscriptions?.timeline,
    result.subscriptions_timeline?.timeline,
    result.timeline?.timeline,
    result.timeline_v2?.timeline
  ];

  for (const tl of timelines) {
    if (tl) walkInstructions(tl.instructions);
  }

  if (!handles.size) {
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 14) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (node.itemContent?.user_results?.result) {
        addHandle(node.itemContent.user_results.result);
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    };
    walk(body, 0);
  }

  return Array.from(handles);
}

async function fetchCreatorSubscriptionsFromTab(tabId) {
  const catalog = await prefetchQueryCatalog(false);
  return executeOnTab(tabId, injectedXCleanerApiCall, [{
    action: 'fetchCreatorSubscriptions',
    queryCatalog: catalog
  }]);
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

async function resolveUserIdFromTab(tabId, screenName, catalog = null) {
  const handle = String(screenName || '').replace(/^@+/, '');
  if (!tabId || !handle) return null;

  try {
    const cat = catalog || (await prefetchQueryCatalog(false));
    const res = await executeOnTab(tabId, injectedXCleanerApiCall, [{
      action: 'resolveUser',
      screenName: handle,
      queryCatalog: cat
    }]);
    if (res?.ok && res.userId) return String(res.userId);
  } catch (error) {}

  return null;
}

async function resolveUserIdFromScreenName(screenName, catalog, tabId = null) {
  const handle = String(screenName || '').replace(/^@+/, '');
  if (!handle) return null;

  if (tabId) {
    const fromTab = await resolveUserIdFromTab(tabId, handle, catalog);
    if (fromTab) return fromTab;
  }

  const session = await getXSessionCookies();
  if (!session.loggedIn) return null;

  const res = await fetchGraphQLFromWorker(
    'UserByScreenName',
    {
      screen_name: handle,
      withSafetyModeUserFields: true
    },
    {
      catalog,
      ct0: session.ct0,
      referer: `https://x.com/${handle}`
    }
  );

  if (!res.ok) return null;
  return res.body?.data?.user?.result?.rest_id || null;
}

async function fetchFollowingPageFromTab(tabId, params) {
  return fetchListPageFromTab(tabId, { ...params, opName: 'Following' });
}

async function fetchListPageFromTab(tabId, params) {
  return executeOnTab(tabId, injectedXCleanerApiCall, [{
    action: 'followPage',
    opName: params.opName || 'Following',
    listPath: params.listPath || null,
    userId: params.userId,
    screenName: params.screenName,
    cursor: params.cursor,
    count: params.count,
    queryCatalog: params.catalog,
    capturedTemplate: params.capturedTemplate || null
  }]);
}

async function readNativeListCursorFromTab(tabId, opName) {
  return executeOnTab(tabId, readNativeListCursor, [opName]);
}

function readLiveFollowersQueryId() {
  try {
    const raw = sessionStorage.getItem('xc_list_latest_Followers');
    if (raw) {
      const data = JSON.parse(raw);
      const url = data?.url || '';
      const match = url.match(/\/graphql\/([^/]+)\/Followers/);
      if (match) return match[1];
    }

    const entries = performance.getEntriesByType('resource')
      .filter((entry) => (
        entry.name.includes('/i/api/graphql/')
        && /\/Followers/.test(entry.name)
        && !entry.name.includes('BlueVerifiedFollowers')
      ));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const match = entries[i].name.match(/\/graphql\/([^/]+)\/Followers/);
      if (match) return match[1];
    }
  } catch (error) {}
  return null;
}

async function resolveCatalogWithTabQueryIds(tabId, catalog) {
  if (!tabId) return catalog || {};
  const base = catalog || {};
  try {
    const qid = await executeOnTab(tabId, readLiveFollowersQueryId);
    if (!qid) return base;
    return {
      ...base,
      Followers: {
        ...(base.Followers || {}),
        queryId: qid
      }
    };
  } catch (error) {
    return base;
  }
}

async function readCapturedListTemplateFromTab(tabId, opName) {
  return executeOnTab(tabId, readCapturedListTemplate, [opName]);
}

async function readEffectiveListPathFromTab(tabId, screenName, preferredPath) {
  return executeOnTab(tabId, readEffectiveListPath, [screenName, preferredPath]);
}

async function readCapturedListOpNameFromTab(tabId, opName) {
  return executeOnTab(tabId, readCapturedListOpName, [opName]);
}

async function readNativeListQueueDrainFromTab(tabId, opName) {
  return executeOnTab(tabId, readNativeListQueueDrain, [opName]);
}

async function readNativeListAllCursorsFromTab(tabId, opName) {
  return executeOnTab(tabId, readNativeListAllCursors, [opName]);
}

async function readNativeListTailCursorsFromTab(tabId, opName, limit = 6) {
  return executeOnTab(tabId, readNativeListTailCursors, [opName, limit]);
}

async function collectVisibleListUsersFromTab(tabId, screenName) {
  return executeOnTab(tabId, injectedCollectVisibleListUsers, [screenName]);
}

async function injectedXCleanerApiCall(request) {
  const FALLBACK_QID = {
    Following: 'OLm4oHZBfqWx8jbcEhWoFw',
    Followers: '9jsVJ9l2uXUIKslHvJqIhw',
    UserByScreenName: '681MIj51w00Aj6dY0GXnHw',
    SearchTimeline: 'gkP4jsxb7JNUVrNh8Xz_RQ',
    UserCreatorSubscriptions: '8qiWrxuavgRRACul8oJo4w'
  };

  const parseCreatorSubscriptionsBodyLocal = (body) => {
    const handles = new Set();
    const blocked = new Set(['grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'explore', 'help', 'ads', 'business', 'developers', 'xai', 'create', 'search']);
    const addHandle = (userResult) => {
      if (!userResult || userResult.__typename === 'UserUnavailable') return;
      const legacy = userResult.legacy || {};
      const core = userResult.core || {};
      const sn = (legacy.screen_name || core.screen_name || userResult.screen_name || '').toLowerCase();
      if (!sn || blocked.has(sn)) return;
      handles.add(sn);
    };
    const walkEntries = (entries) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        const userRes = entry?.content?.itemContent?.user_results?.result;
        if (userRes) addHandle(userRes);
      }
    };
    const walkInstructions = (instructions) => {
      if (!Array.isArray(instructions)) return;
      for (const inst of instructions) {
        if (inst.type === 'TimelineAddEntries') walkEntries(inst.entries);
        if (inst.type === 'TimelineReplaceEntry' && inst.entry) walkEntries([inst.entry]);
      }
    };
    const result =
      body?.data?.viewer?.user_results?.result
      || body?.data?.user?.result
      || body?.data?.user_result_by_rest_id?.result
      || {};
    const timelines = [
      result.creator_subscriptions_timeline?.timeline,
      result.creator_subscriptions?.timeline,
      result.subscriptions_timeline?.timeline,
      result.timeline?.timeline,
      result.timeline_v2?.timeline
    ];
    for (const tl of timelines) {
      if (tl) walkInstructions(tl.instructions);
    }
    if (!handles.size) {
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 14) return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
          return;
        }
        if (node.itemContent?.user_results?.result) addHandle(node.itemContent.user_results.result);
        for (const value of Object.values(node)) walk(value, depth + 1);
      };
      walk(body, 0);
    }
    return Array.from(handles);
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

    const SUGGESTION_SOCIAL_TEXT = /who to follow|people to follow|suggested for you|because you follow|followed by people|popular in your|similar to @/i;
    const NON_LIST_ENTRY_ID = /who-to-follow|who_to_follow|whotofollow|suggest|pymk|recommend|similar|promoted|connect|grok|messageprompt|subscribed|ranked|trend|explore|advertiser|recap|listheader|divider|label|cursor-top/i;

    const relationshipHintsFromItemContent = (itemContent) => {
      if (!itemContent) return {};
      const hints = {};
      const socialText = String(
        itemContent.socialContext?.text
        || itemContent.social_context?.text
        || ''
      ).toLowerCase();
      if (socialText.includes('follows you')) hints.follows_you = true;
      if (SUGGESTION_SOCIAL_TEXT.test(socialText)) hints.you_follow = false;
      return hints;
    };

    const isSuggestionTimelineModule = (content, entryId) => {
      const idLower = String(entryId || '').toLowerCase();
      if (NON_LIST_ENTRY_ID.test(idLower) && !idLower.startsWith('user-')) return true;
      const moduleText = [
        content?.header?.text,
        content?.footer?.text,
        content?.clientEventInfo?.component,
        content?.displayType
      ].map((value) => String(value || '').toLowerCase()).join(' ');
      return SUGGESTION_SOCIAL_TEXT.test(moduleText) || /who to follow|people to follow/.test(moduleText);
    };

    const readViewerRelationship = (userResult, hints = {}) => {
      if (!userResult || userResult.__typename === 'UserUnavailable') {
        return {
          you_follow: hints.you_follow ?? null,
          follows_you: hints.follows_you ?? null
        };
      }
      const legacy = userResult.legacy || {};
      const rel = userResult.relationship_perspectives || userResult.relationship || {};
      let youFollow = legacy.following;
      let followsYou = legacy.followed_by;
      if (youFollow == null && typeof rel.following === 'boolean') youFollow = rel.following;
      if (followsYou == null && typeof rel.followed_by === 'boolean') followsYou = rel.followed_by;
      if (youFollow == null && typeof userResult.following === 'boolean') youFollow = userResult.following;
      if (followsYou == null && typeof userResult.followed_by === 'boolean') followsYou = userResult.followed_by;
      if (hints.you_follow != null) youFollow = hints.you_follow;
      if (hints.follows_you != null) followsYou = hints.follows_you;
      return {
        you_follow: typeof youFollow === 'boolean' ? youFollow : null,
        follows_you: typeof followsYou === 'boolean' ? followsYou : null
      };
    };

    const addUser = (userResult, hints = {}) => {
      if (!userResult || userResult.__typename === 'UserUnavailable') return;

      const legacy = userResult.legacy || {};
      const core = userResult.core || {};
      const screenName = (
        legacy.screen_name
        || core.screen_name
        || userResult.screen_name
        || ''
      ).trim();

      if (!screenName) return;

      const key = screenName.toLowerCase();
      const relationship = readViewerRelationship(userResult, hints);
      if (request.opName === 'Following' && relationship.you_follow === false) return;
      if (seen.has(key)) {
        const existing = users.find((user) => user.username.toLowerCase() === key);
        if (existing) {
          if (existing.you_follow == null && relationship.you_follow != null) existing.you_follow = relationship.you_follow;
          if (existing.follows_you == null && relationship.follows_you != null) existing.follows_you = relationship.follows_you;
        }
        return;
      }
      seen.add(key);

      users.push({
        username: screenName,
        display_name: legacy.name || core.name || '',
        friends_count: legacy.friends_count ?? null,
        followers_count: legacy.followers_count ?? null,
        tweet_count: legacy.statuses_count ?? null,
        created_at: legacy.created_at || core.created_at || '',
        bio: String(legacy.description || core.description || '').trim(),
        is_blue: !!userResult.is_blue_verified,
        default_avatar: !!legacy.default_profile_image,
        you_follow: relationship.you_follow,
        follows_you: relationship.follows_you
      });
    };

    const absorbUserNode = (node, hints = {}) => {
      if (!node || typeof node !== 'object') return;
      const itemHints = {
        ...hints,
        ...relationshipHintsFromItemContent(node.itemContent || node)
      };
      if (node.user_results?.result) addUser(node.user_results.result, itemHints);
      if (node.user?.result) addUser(node.user.result, itemHints);
      if (node.itemContent?.user_results?.result) addUser(node.itemContent.user_results.result, itemHints);
      if (node.itemContent?.user?.result) addUser(node.itemContent.user.result, itemHints);
      if (node.legacy || node.core || node.__typename === 'User') addUser(node, itemHints);
    };

    const processModuleItems = (items) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        absorbUserNode(item?.item?.itemContent || item?.itemContent || item?.content?.itemContent);
        absorbUserNode(item?.item?.content || item?.content);
        if (Array.isArray(item?.item?.content?.items)) {
          processModuleItems(item.item.content.items);
        }
      }
    };

    const processEntry = (entry) => {
      if (!entry) return;

      const entryId = entry.entryId || '';
      const content = entry.content || entry.item || {};

      if (
        entryId.includes('cursor-bottom')
        || entryId.startsWith('cursor-bottom')
        || content.cursorType === 'Bottom'
        || (content.entryType === 'TimelineTimelineCursor' && content.cursorType === 'Bottom')
      ) {
        const value =
          content.value
          || content.itemContent?.value
          || content.cursor?.value
          || content.content?.value;
        if (value) nextCursor = value;
        return;
      }

      if (entryId.includes('cursor-top') || content.cursorType === 'Top') return;
      if (isSuggestionTimelineModule(content, entryId)) return;

      const entryHints = relationshipHintsFromItemContent(content.itemContent);
      absorbUserNode(content.itemContent, entryHints);
      processModuleItems(content.items);

      if (content.entryType === 'TimelineTimelineModule') {
        processModuleItems(content.items);
      }
    };

    const processInstructions = (instructions) => {
      if (!Array.isArray(instructions)) return;

      for (const instr of instructions) {
        for (const entry of instr.entries || []) {
          processEntry(entry);
        }
        if (instr.entry) processEntry(instr.entry);
        if (Array.isArray(instr.moduleItems)) {
          processModuleItems(instr.moduleItems);
        }
      }
    };

    const result = body?.data?.user?.result || body?.data?.user || {};
    const instructionPaths = [
      result.timeline?.timeline?.instructions,
      result.timeline_v2?.timeline?.instructions,
      result.following_timeline?.timeline?.instructions,
      result.followers_timeline?.timeline?.instructions,
      result.timeline?.instructions
    ];

    for (const instructions of instructionPaths) {
      processInstructions(instructions);
    }

    const connections = [
      result.followers_connection,
      result.following_connection,
      result.timeline?.followers_connection,
      result.timeline?.following_connection
    ];
    for (const conn of connections) {
      if (!conn) continue;
      const pageInfo = conn.page_info || conn.pageInfo || {};
      if (pageInfo.has_next_page !== false) {
        nextCursor = nextCursor
          || pageInfo.next_cursor
          || pageInfo.end_cursor
          || pageInfo.nextCursor
          || null;
      }
      for (const edge of conn.edges || []) {
        absorbUserNode(edge?.node);
        absorbUserNode(edge?.itemContent);
        absorbUserNode(edge?.itemContent?.user_results?.result);
        absorbUserNode(edge?.itemContent?.user?.result);
      }
    }

    const scanForBottomCursor = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 22) return;
      if (Array.isArray(node)) {
        for (const item of node) scanForBottomCursor(item, depth + 1);
        return;
      }
      const entryId = String(node.entryId || '');
      const content = node.content || node.item || node;
      if (
        entryId.includes('cursor-bottom')
        || entryId.startsWith('cursor-bottom')
        || content?.cursorType === 'Bottom'
        || (content?.entryType === 'TimelineTimelineCursor' && content?.cursorType === 'Bottom')
      ) {
        const value =
          content?.value
          || content?.itemContent?.value
          || content?.cursor?.value
          || content?.content?.value;
        if (value) nextCursor = nextCursor || value;
      }
      for (const value of Object.values(node)) scanForBottomCursor(value, depth + 1);
    };
    if (!nextCursor) scanForBottomCursor(body?.data, 0);

    return { users, nextCursor };
  };

  const readCapturedBearer = () => {
    try {
      const token = sessionStorage.getItem('xc_captured_bearer')
        || localStorage.getItem('xc_captured_bearer');
      return token && String(token).length > 20 ? String(token) : '';
    } catch (error) {
      return '';
    }
  };

  const buildHeaders = (referer) => {
    let ct0 = '';
    try {
      const match = document.cookie.match(/(?:^|; )ct0=([^;]+)/);
      if (match) ct0 = decodeURIComponent(match[1]);
    } catch (error) {}

    const headers = {
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

    const bearer = readCapturedBearer();
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }

    return headers;
  };

  const finishFollowPage = (res, opName = 'Following') => {
    if (!res.ok) {
      const status = res.status || 0;
      let error = `${opName} tab request failed (HTTP ${status})`;
      if (status === 401) {
        error = 'X auth failed (401) in tab. Reload x.com and retry.';
      } else if (status === 403) {
        error = `${opName} tab request forbidden (403) — bearer/csrf missing in tab`;
      } else if (status === 404) {
        error = `${opName} endpoint not found (404) in tab.`;
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

  if (action === 'resolveUser') {
    const screenName = String(request.screenName || '').replace(/^@+/, '');
    const referer = screenName ? `https://x.com/${screenName}` : 'https://x.com/home';
    const catalog = request.queryCatalog || {};
    const meta = catalog.UserByScreenName || {};
    const qid = meta.queryId || FALLBACK_QID.UserByScreenName;
    const variables = {
      screen_name: screenName,
      withSafetyModeUserFields: true
    };
    const url =
      `https://x.com/i/api/graphql/${qid}/UserByScreenName` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(referer),
      credentials: 'include'
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: resp.status === 401
          ? 'Tab GraphQL auth failed (401)'
          : (body?.errors?.[0]?.message || `HTTP ${resp.status}`)
      };
    }
    const restId = body?.data?.user?.result?.rest_id;
    if (!restId) return { ok: false, error: `User not found: @${screenName}` };
    return { ok: true, userId: restId };
  }

  if (action === 'followPage') {
    const screenName = String(request.screenName || '').replace(/^@+/, '');
    const opName = request.opName || 'Following';
    const listPath = request.listPath || (opName === 'Followers' ? 'followers' : 'following');
    const referer = `https://x.com/${screenName}/${listPath}`;
    const variables = {
      userId: String(request.userId),
      count: request.count || 100,
      includePromotedContent: false
    };
    if (request.cursor) variables.cursor = request.cursor;

    const capturedTemplate = request.capturedTemplate;
    if (capturedTemplate?.url) {
      let fetchUrl = capturedTemplate.url;
      try {
        const urlObj = new URL(fetchUrl);
        const vars = JSON.parse(urlObj.searchParams.get('variables') || '{}');
        if (request.userId) vars.userId = String(request.userId);
        if (request.count != null) vars.count = request.count;
        if (request.cursor) vars.cursor = request.cursor;
        else delete vars.cursor;
        urlObj.searchParams.set('variables', JSON.stringify(vars));
        fetchUrl = urlObj.toString();
      } catch (error) {}

      const resp = await fetch(fetchUrl, {
        method: capturedTemplate.method || 'GET',
        headers: buildHeaders(referer),
        credentials: 'include'
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.ok || resp.status !== 404) {
        return finishFollowPage({ ok: resp.ok, status: resp.status, body }, opName);
      }
    }

    const catalog = request.queryCatalog || {};
    const meta = catalog[opName] || catalog.Following || {};
    const qid = meta.queryId || FALLBACK_QID[opName] || FALLBACK_QID.Following;
    const url =
      `https://x.com/i/api/graphql/${qid}/${opName}` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(referer),
      credentials: 'include'
    });
    const body = await resp.json().catch(() => ({}));
    return finishFollowPage({ ok: resp.ok, status: resp.status, body }, opName);
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

  if (action === 'fetchCreatorSubscriptions') {
    const catalog = request.queryCatalog || {};
    const meta = catalog.UserCreatorSubscriptions || {};
    const qid = meta.queryId || FALLBACK_QID.UserCreatorSubscriptions;
    const variables = { count: 100, includePromotedContent: false };
    const url =
      `https://x.com/i/api/graphql/${qid}/UserCreatorSubscriptions` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders('https://x.com/home'),
      credentials: 'include'
    });
    const body = await resp.json().catch(() => ({}));

    if (!resp.ok || body?.errors?.length) {
      return {
        ok: false,
        status: resp.status,
        handles: [],
        error: body?.errors?.[0]?.message || `Subscription lookup failed (HTTP ${resp.status})`
      };
    }

    return {
      ok: true,
      status: resp.status,
      handles: parseCreatorSubscriptionsBodyLocal(body)
    };
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