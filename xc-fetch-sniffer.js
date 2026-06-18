// xc-fetch-sniffer.js — capture native X GraphQL Following responses (MAIN world)
(function () {
  if (window.__xcSnifferInstalled) return;
  window.__xcSnifferInstalled = true;
  window.__xcCapturedGql = window.__xcCapturedGql || {};
  window.__xcListSeq = window.__xcListSeq || 0;

  const LIST_OPS = new Set(['Following', 'Followers']);
  const CREATOR_SUBS_OPS = new Set(['UserCreatorSubscriptions']);

  const NON_LIST_ENTRY_ID = /who-to-follow|who_to_follow|whotofollow|suggest|promoted|connect|grok|messageprompt|subscribed|ranked|trend|explore|advertiser|recap|listheader|divider|label|cursor-top/i;
  const BLOCKED_HANDLES = new Set(['grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'explore', 'help', 'ads', 'business', 'developers', 'xai', 'create', 'search']);

  const parseListBody = (body) => {
    const users = [];
    let nextCursor = null;
    const seen = new Set();

    const relationshipHintsFromItemContent = (itemContent) => {
      if (!itemContent) return {};
      const hints = {};
      const socialText = String(
        itemContent.socialContext?.text
        || itemContent.social_context?.text
        || ''
      ).toLowerCase();
      if (socialText.includes('follows you')) hints.follows_you = true;
      return hints;
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
      const sn = legacy.screen_name || core.screen_name || userResult.screen_name;
      const id = userResult.rest_id || legacy.id_str || userResult.id;
      if (!sn) return;
      const key = String(sn).toLowerCase();
      if (BLOCKED_HANDLES.has(key)) return;
      const relationship = readViewerRelationship(userResult, hints);
      if (seen.has(key)) {
        const existing = users.find((user) => String(user.username).toLowerCase() === key);
        if (existing) {
          if (existing.you_follow == null && relationship.you_follow != null) existing.you_follow = relationship.you_follow;
          if (existing.follows_you == null && relationship.follows_you != null) existing.follows_you = relationship.follows_you;
        }
        return;
      }
      seen.add(key);
      users.push({
        username: sn,
        display_name: legacy.name || core.name || '',
        friends_count: legacy.friends_count ?? null,
        followers_count: legacy.followers_count ?? null,
        tweet_count: legacy.statuses_count ?? null,
        created_at: legacy.created_at || core.created_at || '',
        bio: String(legacy.description || core.description || '').trim(),
        is_blue: !!userResult.is_blue_verified,
        default_avatar: !!legacy.default_profile_image,
        rest_id: id,
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
      const idLower = String(entryId).toLowerCase();

      if (
        idLower.includes('cursor-bottom')
        || idLower.startsWith('cursor-bottom')
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

      if (idLower.includes('cursor-top') || content.cursorType === 'Top') return;
      if (NON_LIST_ENTRY_ID.test(idLower) && !idLower.startsWith('user-')) return;

      const entryHints = relationshipHintsFromItemContent(content.itemContent);
      absorbUserNode(content.itemContent, entryHints);
      processModuleItems(content.items);
      if (content.entryType === 'TimelineTimelineModule') {
        processModuleItems(content.items);
      }
    };

    const walkInstructions = (instructions) => {
      if (!Array.isArray(instructions)) return;
      for (const inst of instructions) {
        for (const entry of inst.entries || []) {
          processEntry(entry);
        }
        if (inst.entry) processEntry(inst.entry);
        if (Array.isArray(inst.moduleItems)) {
          processModuleItems(inst.moduleItems);
        }
      }
    };

    const result = body?.data?.user?.result || body?.data?.user || {};
    const timelines = [
      result.timeline?.timeline,
      result.timeline_v2?.timeline,
      result.followers_timeline?.timeline,
      result.following_timeline?.timeline
    ];
    for (const tl of timelines) {
      if (tl) walkInstructions(tl.instructions);
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

    return { users, nextCursor };
  };

  const parseCreatorSubscriptionsBody = (body) => {
    const handles = new Set();

    const addHandle = (userResult) => {
      if (!userResult || userResult.__typename === 'UserUnavailable') return;
      const legacy = userResult.legacy || {};
      const core = userResult.core || {};
      const sn = legacy.screen_name || core.screen_name || userResult.screen_name;
      if (!sn) return;
      const key = String(sn).toLowerCase();
      if (BLOCKED_HANDLES.has(key)) return;
      handles.add(key);
    };

    const walkEntries = (entries) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        const content = entry?.content || entry?.item || {};
        const userRes = content?.itemContent?.user_results?.result;
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
  };

  const storeCreatorSubsResponse = (opName, url, body) => {
    if (!body || body?.errors?.length) return;
    if (!body?.data) return;

    const payload = {
      opName,
      url,
      handles: parseCreatorSubscriptionsBody(body),
      capturedAt: Date.now(),
      ok: true
    };

    try {
      sessionStorage.setItem('xc_creator_subs_latest', JSON.stringify(payload));
    } catch (error) {}
  };

  const storeListResponse = (canonical, opName, url, body) => {
    const parsed = parseListBody(body);
    if (!parsed.users.length && !parsed.nextCursor) return;
    window.__xcListSeq += 1;
    const payload = {
      canonical,
      opName,
      url,
      users: parsed.users,
      nextCursor: parsed.nextCursor,
      capturedAt: Date.now(),
      seq: window.__xcListSeq
    };
    try {
      const queueKey = 'xc_list_queue_' + canonical;
      let queue = [];
      const existing = sessionStorage.getItem(queueKey);
      if (existing) queue = JSON.parse(existing);
      queue.push(payload);
      if (queue.length > 100) queue = queue.slice(-100);
      sessionStorage.setItem(queueKey, JSON.stringify(queue));
      sessionStorage.setItem('xc_list_latest_' + canonical, JSON.stringify(payload));
      sessionStorage.setItem('xc_list_latest_' + opName, JSON.stringify(payload));
    } catch (error) {}
  };

  const remember = (rawUrl, method) => {
    try {
      const u = String(rawUrl || '');
      if (!u.includes('/i/api/graphql/')) return null;
      const m = u.match(/\/graphql\/([^/]+)\/([^/?]+)/);
      if (!m) return null;
      const opName = decodeURIComponent(m[2]);
      if (opName === 'BlueVerifiedFollowers') return null;
      const canonical = opName;
      let kind = null;
      if (LIST_OPS.has(canonical)) kind = 'list';
      else if (CREATOR_SUBS_OPS.has(canonical)) kind = 'creatorSubs';
      else return null;

      const payload = { url: u, method: method || 'GET', capturedAt: Date.now(), operationName: opName };
      window.__xcCapturedGql[canonical] = payload;
      window.__xcCapturedGql[opName] = payload;
      return { canonical, opName, url: u, kind };
    } catch (error) {}
    return null;
  };

  const captureBearer = (headersLike) => {
    try {
      let auth = '';
      if (headersLike && typeof headersLike.get === 'function') {
        auth = headersLike.get('authorization') || headersLike.get('Authorization') || '';
      } else if (headersLike && typeof headersLike === 'object') {
        auth = headersLike.authorization || headersLike.Authorization || '';
      }
      if (!auth || !String(auth).startsWith('Bearer ')) return;
      const token = String(auth).slice(7).trim();
      if (!token || token.length < 20) return;
      sessionStorage.setItem('xc_captured_bearer', token);
      try {
        localStorage.setItem('xc_captured_bearer', token);
      } catch (storageError) {}
      try {
        window.dispatchEvent(new CustomEvent('xc-rest-session'));
      } catch (eventError) {}
    } catch (error) {}
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    if (req && typeof req !== 'string' && req.headers) {
      captureBearer(req.headers);
    }
    const url = typeof req === 'string' ? req : req?.url;
    const meta = url ? remember(url, 'GET') : null;
    const chain = origFetch.apply(this, args);
    if (!meta) return chain;
    return chain.then((resp) => {
      try {
        resp.clone().json().then((body) => {
          if (meta.kind === 'creatorSubs') {
            storeCreatorSubsResponse(meta.opName, meta.url, body);
          } else {
            storeListResponse(meta.canonical, meta.opName, meta.url, body);
          }
        }).catch(() => {});
      } catch (error) {}
      return resp;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xcUrl = url;
    this.__xcMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name || '').toLowerCase() === 'authorization') {
      captureBearer({ authorization: value });
    }
    return origSetRequestHeader.call(this, name, value);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__xcUrl ? remember(this.__xcUrl, this.__xcMethod) : null;
    if (meta) {
      this.addEventListener('load', function () {
        try {
          const body = JSON.parse(this.responseText);
          if (meta.kind === 'creatorSubs') {
            storeCreatorSubsResponse(meta.opName, meta.url, body);
          } else {
            storeListResponse(meta.canonical, meta.opName, meta.url, body);
          }
        } catch (error) {}
      });
    }
    return origSend.apply(this, args);
  };
})();