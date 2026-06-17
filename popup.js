const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const filterBtn = document.getElementById('filterBtn');
const removeBlueEl = document.getElementById('removeBlue');
const removeNewEl = document.getElementById('removeNew');
const removeInactiveEl = document.getElementById('removeInactive');
const accountEl = document.getElementById('account');
const methodEl = document.getElementById('method');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');
const mutualsEl = document.getElementById('mutuals');
const subStatusEl = document.getElementById('subStatus');
const checkSubBtn = document.getElementById('checkSubBtn');
const upgradeBtn = document.getElementById('upgradeBtn');
const modeFollowingEl = document.getElementById('modeFollowing');
const modeFollowersEl = document.getElementById('modeFollowers');

const PRO_CHECKOUT_URL = 'https://x.com/d2fl/creator-subscriptions/subscribe';
const FREE_FETCH_LIMIT = 200;

let pollTimer = null;
let currentListType = 'following';

function selectedListType() {
  return modeFollowersEl.checked ? 'followers' : 'following';
}

function listLabel(type = currentListType) {
  return type === 'followers' ? 'Followers' : 'Following';
}

function formatTotal(state) {
  if (state.fetchTarget != null) return state.fetchTarget.toLocaleString();
  if (state.totalList != null) return state.totalList.toLocaleString();
  const total = currentListType === 'followers' ? state.totalFollowers : state.totalFollowing;
  return total == null ? '—' : total.toLocaleString();
}

function formatSubscriptionStatus(state) {
  if (state.subscriptionStatus) return state.subscriptionStatus;
  const handle = state.username ? `@${state.username}` : '(not detected)';
  if (state.isSubscribed) {
    if (state.subscriptionSource === 'subs.txt') {
      return `Beta access — unlimited fetch & export (${handle})`;
    }
    if (state.subscriptionSource === 'x-creator') {
      return `Subscribed to @d2fl on X — unlimited fetch & export (${handle})`;
    }
    return `Subscribed — unlimited fetch & export (${handle})`;
  }
  return `Free — fetch up to ${FREE_FETCH_LIMIT} • export requires @d2fl (${handle})`;
}

function renderSubscription(state) {
  subStatusEl.textContent = formatSubscriptionStatus(state);
  const showSubscribe = !state.isSubscribed;
  upgradeBtn.style.display = showSubscribe ? 'block' : 'none';
  checkSubBtn.disabled = !!state.isScraping;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b00020' : '#222';
}

function renderMutuals(state) {
  const mutuals = state.mutuals;
  if (!mutuals?.hasBoth) {
    const stored = state.storedCounts || {};
    const parts = [];
    if (stored.following > 0) parts.push(`${stored.following.toLocaleString()} following saved`);
    if (stored.followers > 0) parts.push(`${stored.followers.toLocaleString()} followers saved`);
    mutualsEl.textContent = parts.length ? parts.join(' • ') : '';
    return;
  }

  mutualsEl.textContent =
    `Mutuals: ${mutuals.mutualCount.toLocaleString()} (${mutuals.followingCount.toLocaleString()} following ∩ ${mutuals.followersCount.toLocaleString()} followers)`;
}

function renderProgress(state) {
  const count = state.count || 0;
  const rawCount = state.rawCount || count;
  const username = state.username;
  currentListType = state.listType || selectedListType();

  if (currentListType === 'followers') {
    modeFollowersEl.checked = true;
  } else {
    modeFollowingEl.checked = true;
  }

  accountEl.textContent = username ? `@${username}` : '@—';
  const limitNote = state.isSubscribed
    ? 'unlimited'
    : `up to ${state.fetchLimit || FREE_FETCH_LIMIT}`;
  methodEl.textContent = `Collect ${listLabel()} via native X responses (${limitNote})`;
  renderSubscription(state);

  if (state.isEnriching && state.enrichTotal) {
    progressEl.textContent =
      `${(state.enrichProcessed || 0).toLocaleString()} / ${state.enrichTotal.toLocaleString()} checked`;
  } else if (state.reason === 'filtering' || state.reason === 'filtered') {
    progressEl.textContent = `${count.toLocaleString()} / ${rawCount.toLocaleString()}`;
  } else {
    progressEl.textContent = `${count.toLocaleString()} / ${formatTotal(state)}`;
  }

  renderMutuals(state);

  const busy = !!state.isScraping;
  startBtn.disabled = busy;
  modeFollowingEl.disabled = busy;
  modeFollowersEl.disabled = busy;
  stopBtn.style.display = busy ? 'block' : 'none';
  const canExport = !!state.canExport;
  exportBtn.disabled = count === 0 || !canExport;
  exportBtn.classList.toggle('export-locked', count > 0 && !canExport);
  exportBtn.title = canExport
    ? 'Download CSV'
    : 'Export requires @d2fl subscription';
  filterBtn.disabled =
    count === 0 || busy || !!state.isEnriching || state.reason === 'filtering';
}

function sendBackground(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || 'Background worker unavailable.'
        });
        return;
      }

      resolve(response || { ok: false, error: 'No response from extension.' });
    });
  });
}

function statusMessage(state) {
  const label = listLabel(state.listType || currentListType).toLowerCase();

  if (state.reason === 'loading-profile') {
    return state.status || 'Opening your profile to confirm login...';
  }

  if (state.reason === 'profile-loaded' && !state.isScraping) {
    return state.status || `Logged in as @${state.username}. Opening ${label}...`;
  }

  if (state.reason === 'waiting-native') {
    return state.status || `Waiting for X native ${label} responses...`;
  }

  if (state.isScraping) {
    return state.status || `Capturing native ${label} data. Watch the on-page panel.`;
  }

  if (state.reason === 'filtering') {
    return state.status || 'Applying filters...';
  }

  if (state.reason === 'enriching' || state.isEnriching) {
    const done = state.enrichProcessed != null ? state.enrichProcessed.toLocaleString() : '0';
    const total = state.enrichTotal != null ? state.enrichTotal.toLocaleString() : '—';
    return state.status || `Checking last tweet dates ${done} / ${total}...`;
  }

  if (state.reason === 'filtered') {
    const removed = state.filterRemoved != null ? ` Removed ${state.filterRemoved.toLocaleString()}.` : '';
    return (state.status || 'List filtered.') + removed;
  }

  if (state.reason === 'complete') {
    if (state.canExport) {
      return `Collection complete. Filter or export ${label} CSV from here or the X page panel.`;
    }
    return state.status || `Collection complete (free tier). Filter in-app; subscribe @d2fl to export.`;
  }

  if (state.reason === 'end-of-list') {
    return 'Reached end of list. Export CSV when ready.';
  }

  if (state.reason === 'stopped' && state.count > 0) {
    return 'Collection stopped. Export CSV when ready.';
  }

  if (state.restoredFromStorage && state.savedAt && state.count > 0) {
    const when = new Date(state.savedAt).toLocaleString();
    return `Restored ${state.count.toLocaleString()} ${label} (saved ${when}). Filter or export — no re-fetch needed.`;
  }

  if (state.count > 0) {
    return state.canExport
      ? `Ready to export collected ${label}.`
      : `${state.count.toLocaleString()} ${label} loaded. Export requires @d2fl subscription.`;
  }

  return `Select Following or Followers, then start collection. Progress also appears on the X page panel.`;
}

function updateUI(state = {}) {
  renderProgress(state);
  setStatus(statusMessage(state));
}

async function refreshStatus() {
  const result = await sendBackground('getStatus');
  if (result.ok || result.count > 0 || result.username || result.isScraping) {
    updateUI(result);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshStatus, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function switchListType(nextType) {
  if (nextType === currentListType) return;
  const result = await sendBackground('setListType', { listType: nextType });
  if (result.ok || result.count > 0 || result.username) {
    updateUI(result);
  }
}

modeFollowingEl.addEventListener('change', () => {
  if (modeFollowingEl.checked) switchListType('following');
});

modeFollowersEl.addEventListener('change', () => {
  if (modeFollowersEl.checked) switchListType('followers');
});

startBtn.addEventListener('click', async () => {
  const listType = selectedListType();
  updateUI({
    isScraping: true,
    count: 0,
    totalFollowing: null,
    totalFollowers: null,
    listType,
    username: null
  });
  setStatus(`Detecting account, then opening profile and ${listLabel(listType)} page...`);
  startPolling();

  const result = await sendBackground('runExportFlow', { listType });

  if (!result.ok && !result.isScraping) {
    stopPolling();
    updateUI({
      isScraping: false,
      count: result.count || 0,
      totalFollowing: result.totalFollowing ?? null,
      totalFollowers: result.totalFollowers ?? null,
      listType: result.listType || listType,
      username: result.username ?? null
    });
    setStatus(result.error || 'Failed to start collection.', true);
    return;
  }

  updateUI({
    isScraping: !!result.isScraping,
    count: result.count || 0,
    totalFollowing: result.totalFollowing,
    totalFollowers: result.totalFollowers,
    listType: result.listType || listType,
    username: result.username,
    mutuals: result.mutuals
  });
});

stopBtn.addEventListener('click', async () => {
  setStatus('Stopping collection...');
  const result = await sendBackground('stopScrape');

  if (!result.ok) {
    setStatus(result.error || 'Failed to stop collection.', true);
    return;
  }

  updateUI({ ...result, reason: 'stopped' });
});

filterBtn.addEventListener('click', async () => {
  setStatus('Applying filters...');
  const result = await sendBackground('filterList', {
    removeBlue: removeBlueEl.checked,
    removeNew: removeNewEl.checked,
    removeInactive: removeInactiveEl.checked
  });

  if (!result.ok) {
    setStatus(result.error || 'Filter failed.', true);
    return;
  }

  updateUI(result);
  if (result.removed > 0) {
    setStatus(
      `Filtered to ${result.count.toLocaleString()} accounts (removed ${result.removed.toLocaleString()}).`
    );
  } else {
    setStatus(`${result.count.toLocaleString()} accounts ready to export.`);
  }
});

checkSubBtn.addEventListener('click', async () => {
  checkSubBtn.disabled = true;
  setStatus('Refreshing subscription status...');
  try {
    const result = await sendBackground('checkSubscription', { force: true });
    if (result.ok === false && !result.isSubscribed) {
      setStatus(result.error || 'Could not refresh subscription.', true);
      return;
    }
    updateUI(result);
    setStatus(result.subscriptionStatus || 'Subscription status updated.');
  } finally {
    checkSubBtn.disabled = false;
  }
});

upgradeBtn.addEventListener('click', () => {
  sendBackground('openSubscribe');
});

exportBtn.addEventListener('click', async () => {
  if (exportBtn.disabled) return;
  setStatus('Preparing CSV export...');
  const result = await sendBackground('exportCSV');

  if (!result.ok && !result.exported) {
    setStatus(result.error || 'Export failed.', true);
    return;
  }

  updateUI(result);
  setStatus(`Exported ${result.count || 0} accounts${result.filename ? ` (${result.filename})` : ''}.`);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'scrapeStatus') return;
  updateUI(message);
  if (message.isScraping) {
    startPolling();
  } else {
    stopPolling();
  }
});

sendBackground('checkSubscription', { force: false }).then((result) => {
  if (result.ok !== false || result.username || result.isSubscribed) {
    updateUI(result);
  } else {
    refreshStatus();
  }
  sendBackground('getJobState').then((state) => {
    if (state.isScraping) startPolling();
  });
});

window.addEventListener('unload', stopPolling);