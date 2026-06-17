importScripts('api-fetch.js');

let jobTabId = null;
let activeFetch = null;
let jobState = {
  username: null,
  totalFollowing: null,
  count: 0,
  isScraping: false,
  reason: null,
  method: 'graphql'
};

let followingList = [];

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
    followingList.push(user);
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
      let userId = null;

      const followingLink = document.querySelector(
        'a[href$="/following"], a[href*="/following"]'
      );
      if (followingLink) {
        following = parseCountText(followingLink.textContent || followingLink.innerText || '');
      }

      if (following === null) {
        const friendsMatch = html.match(/"friends_count":(\d+)/i);
        if (friendsMatch) following = parseInt(friendsMatch[1], 10);
      }

      if (following === null) {
        const followingMatch = html.match(/"following_count":(\d+)/i);
        if (followingMatch) following = parseInt(followingMatch[1], 10);
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
        userId
      };
    },
    args: [handle]
  });

  return results?.[0]?.result || { username: handle, totalFollowing: null, userId: null };
}

function escapeCsvField(value) {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str.replace(/\r?\n/g, ' ')}"`;
}

function buildCsv(users) {
  const header =
    'username,display_name,friends_count,followers_count,tweet_count,created_at,is_blue,default_avatar\n';
  const rows = users.map((user) =>
    [
      user.username,
      user.display_name ?? user.name ?? '',
      user.friends_count ?? '',
      user.followers_count ?? '',
      user.tweet_count ?? '',
      user.created_at ?? '',
      user.is_blue ?? false,
      user.default_avatar ?? false
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
    count: followingList.length,
    ...extra
  };

  const payload = {
    type: 'scrapeStatus',
    ok: true,
    ...jobState
  };

  chrome.runtime.sendMessage(payload).catch(() => {});

  if (jobTabId) {
    sendHudMessage(jobTabId, { action: 'updateHud', ...jobState }).catch(() => {});
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== jobTabId || changeInfo.status !== 'complete') return;
  if (!jobState.username && !jobState.isScraping) return;

  ensureSnifferInstalled(tabId)
    .then(() => sendHudMessage(tabId, { action: 'updateHud', ...jobState, count: followingList.length }, 12))
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

async function runNativeFollowingFetch(tabId, profile) {
  const session = await getXSessionCookies();
  if (!session.loggedIn) {
    throw new Error('Not logged in to X. Open x.com, sign in, then try again.');
  }

  const totalFollowing = profile.totalFollowing;
  const resolvedUsername = profile.username;

  await executeOnTab(tabId, () => {
    try {
      sessionStorage.removeItem('xc_list_queue_Following');
      sessionStorage.removeItem('xc_list_latest_Following');
    } catch (error) {}
  });

  await chrome.tabs.update(tabId, {
    url: `https://x.com/${resolvedUsername}/following`,
    active: true
  });
  await waitForTabComplete(tabId);
  await sleep(1500);
  await ensureSnifferInstalled(tabId);

  const hudState = {
    action: 'showHud',
    username: resolvedUsername,
    totalFollowing,
    count: 0,
    isScraping: true,
    reason: 'waiting-native',
    method: 'native-sniffer',
    status: 'Listening for X native Following responses...'
  };
  await sendHudMessage(tabId, hudState, 20);

  followingList = [];
  jobState = {
    username: resolvedUsername,
    totalFollowing,
    count: 0,
    isScraping: true,
    reason: 'waiting-native',
    method: 'native-sniffer',
    status: 'Listening for X native Following responses...'
  };
  notifyProgress();

  const seen = new Set();
  let lastSeq = 0;
  let stalePasses = 0;
  let passes = 0;

  while (!activeFetch?.cancelled) {
    const native = await waitForNativeFollowingList(tabId, lastSeq, passes === 0 ? 15000 : 6000);
    const added = native ? addNativeUsers(native, seen, resolvedUsername) : 0;

    if (native) {
      lastSeq = native.seq || lastSeq;
      stalePasses = 0;
    } else {
      stalePasses += 1;
    }

    passes += 1;
    notifyProgress({
      reason: 'collecting',
      pages: passes,
      addedLastPage: added,
      status: `Collected ${followingList.length.toLocaleString()} / ${totalFollowing != null ? totalFollowing.toLocaleString() : '—'}`
    });

    if (totalFollowing != null && followingList.length >= totalFollowing) break;
    if (followingList.length > 0 && stalePasses >= 6) break;
    if (passes > 2000) break;

    await executeOnTab(tabId, injectedScrollListToLoad);
    await sleep(1800);
  }

  if (followingList.length === 0) {
    throw new Error(
      'No following accounts captured from X native responses. Reload the extension at chrome://extensions/, refresh the x.com tab once, then try again.'
    );
  }

  const reason = activeFetch?.cancelled ? 'stopped' : 'complete';
  jobState.isScraping = false;
  jobState.reason = reason;
  notifyProgress();
}

async function runExportFlow() {
  if (activeFetch?.running) {
    return { ok: false, error: 'Collection already running.' };
  }

  const tab = await findLastActiveXTab();
  if (!tab?.id) {
    return { ok: false, error: 'No X tab found. Open x.com in a browser tab first.' };
  }

  jobTabId = tab.id;

  const username = await detectHandle(tab.id);
  if (!username) {
    return {
      ok: false,
      error: 'Could not detect your X username. Open x.com/home or your profile, then try again.'
    };
  }

  try {
    jobState = {
      username,
      totalFollowing: null,
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
    if (profile.totalFollowing == null && profile.userId == null) {
      throw new Error('Could not read your profile on X. Confirm you are logged in and try again.');
    }

    jobState = {
      username: profile.username || username,
      totalFollowing: profile.totalFollowing,
      count: 0,
      isScraping: true,
      reason: 'profile-loaded',
      method: 'native-sniffer'
    };
    await sendHudMessage(tab.id, {
      action: 'updateHud',
      ...jobState,
      status: `Logged in as @${jobState.username} • ${profile.totalFollowing != null ? profile.totalFollowing.toLocaleString() : '—'} following`
    }, 12);
    notifyProgress({
      status: `Logged in as @${jobState.username} • opening Following...`
    });
    await sleep(800);

    activeFetch = { running: true, cancelled: false };
    await runNativeFollowingFetch(tab.id, {
      username: jobState.username,
      totalFollowing: jobState.totalFollowing,
      userId: profile.userId
    });
    return {
      ok: true,
      ...jobState,
      count: followingList.length
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
    return { ok: true, ...jobState, count: followingList.length, reason: 'stopping' };
  }

  jobState.isScraping = false;
  jobState.reason = 'stopped';
  notifyProgress();
  return { ok: true, ...jobState, count: followingList.length };
}

async function exportCSV() {
  if (!followingList.length) {
    return { ok: false, error: 'No accounts collected yet.' };
  }

  if (!jobTabId) {
    return { ok: false, error: 'No X tab available for download.' };
  }

  const owner = jobState.username || 'user';
  const filename = `x_following_${owner}_${new Date().toISOString().slice(0, 10)}.csv`;
  const csvContent = buildCsv(followingList);

  await executeOnTab(jobTabId, injectedXCleanerApiCall, [{
    action: 'downloadCsv',
    csvContent,
    filename
  }]);

  jobState.reason = 'exported';
  notifyProgress();
  return { ok: true, ...jobState, count: followingList.length, exported: true };
}

function getStatus() {
  return {
    ok: true,
    ...jobState,
    count: followingList.length
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Cleaner v0.62 installed (native Following sniffer)');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'scrapeStatus') {
    return false;
  }

  (async () => {
    switch (message.action) {
      case 'runExportFlow':
        sendResponse(await runExportFlow());
        break;
      case 'stopScrape':
        sendResponse(await stopScrape());
        break;
      case 'exportCSV':
        sendResponse(await exportCSV());
        break;
      case 'getStatus':
        sendResponse(getStatus());
        break;
      case 'getJobState':
        sendResponse(getStatus());
        break;
      default:
        sendResponse({ ok: false, error: 'Unknown action.' });
    }
  })();

  return true;
});