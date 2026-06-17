// xc-fetch-sniffer.js — capture native X GraphQL Following responses (MAIN world)
(function () {
  if (window.__xcSnifferInstalled) return;
  window.__xcSnifferInstalled = true;
  window.__xcCapturedGql = window.__xcCapturedGql || {};
  window.__xcListSeq = window.__xcListSeq || 0;

  const OP_ALIASES = { BlueVerifiedFollowers: 'Followers' };
  const LIST_OPS = new Set(['Following', 'Followers']);
  const CREATOR_SUBS_OPS = new Set(['UserCreatorSubscriptions']);

  const NON_LIST_ENTRY_ID = /who-to-follow|who_to_follow|whotofollow|suggest|promoted|connect|grok|messageprompt|subscribed|ranked|trend|explore|advertiser|recap|listheader|divider|label|cursor-top/i;
  const BLOCKED_HANDLES = new Set(['grok', 'x', 'twitter', 'support', 'safety', 'premium', 'verified', 'explore', 'help', 'ads', 'business', 'developers', 'xai', 'create', 'search']);

  const parseListBody = (body) => {
    const users = [];
    let nextCursor = null;
    const seen = new Set();

    const shouldSkipListEntry = (entryId, content) => {
      const id = String(entryId || '');
      const idLower = id.toLowerCase();
      if (idLower.includes('cursor-top') || content?.cursorType === 'Top') return true;
      if (id.startsWith('user-')) return false;
      if (NON_LIST_ENTRY_ID.test(idLower)) return true;
      const entryType = content?.entryType || '';
      if (entryType === 'TimelineTimelineModule' || entryType === 'TimelineTimelineCursor') return true;
      return false;
    };

    const isListUserEntry = (entryId, content) => {
      if (shouldSkipListEntry(entryId, content)) return false;
      const id = String(entryId || '');
      if (id.startsWith('user-')) return true;
      return content?.entryType === 'TimelineTimelineItem' && !!content?.itemContent?.user_results?.result;
    };

    const addUser = (userResult) => {
      if (!userResult || userResult.__typename === 'UserUnavailable') return;
      const legacy = userResult.legacy || {};
      const core = userResult.core || {};
      const sn = legacy.screen_name || core.screen_name || userResult.screen_name;
      const id = userResult.rest_id || legacy.id_str || userResult.id;
      if (!sn) return;
      const key = String(sn).toLowerCase();
      if (BLOCKED_HANDLES.has(key) || seen.has(key)) return;
      seen.add(key);
      users.push({
        username: sn,
        display_name: legacy.name || core.name || '',
        friends_count: legacy.friends_count ?? null,
        followers_count: legacy.followers_count ?? null,
        tweet_count: legacy.statuses_count ?? null,
        created_at: legacy.created_at || core.created_at || '',
        is_blue: !!userResult.is_blue_verified,
        default_avatar: !!legacy.default_profile_image,
        rest_id: id
      });
    };

    const noteCursor = (entryId, content) => {
      const c = content || {};
      const id = String(entryId || '');
      const isBottom = id.includes('cursor-bottom')
        || id.startsWith('cursor-bottom')
        || c.cursorType === 'Bottom'
        || (c.entryType === 'TimelineTimelineCursor' && c.cursorType === 'Bottom');
      if (isBottom) {
        nextCursor = c.value || c.cursor?.value || c.content?.value || nextCursor;
      }
    };

    const walkEntries = (entries) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        const entryId = entry.entryId || '';
        const content = entry.content || entry.item || {};
        noteCursor(entryId, content);
        if (!isListUserEntry(entryId, content)) continue;
        addUser(content.itemContent?.user_results?.result);
      }
    };

    const walkInstructions = (instructions) => {
      if (!Array.isArray(instructions)) return;
      for (const inst of instructions) {
        if (inst.type === 'TimelineAddEntries') walkEntries(inst.entries);
        if (inst.type === 'TimelineReplaceEntry' && inst.entry) walkEntries([inst.entry]);
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
      const canonical = OP_ALIASES[opName] || opName;
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

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
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