const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const filterBtn = document.getElementById('filterBtn');
const removeBlueEl = document.getElementById('removeBlue');
const removeNewEl = document.getElementById('removeNew');
const removeInactiveEl = document.getElementById('removeInactive');
const newAccountMonthsEl = document.getElementById('newAccountMonths');
const newAccountMonthsDecEl = document.getElementById('newAccountMonthsDec');
const newAccountMonthsIncEl = document.getElementById('newAccountMonthsInc');
const inactiveMonthsEl = document.getElementById('inactiveMonths');
const inactiveMonthsDecEl = document.getElementById('inactiveMonthsDec');
const inactiveMonthsIncEl = document.getElementById('inactiveMonthsInc');

const FILTER_MONTHS_MIN = 1;
const FILTER_MONTHS_MAX = 24;
const FILTER_MONTHS_DEFAULT = 6;
const NEW_ACCOUNT_MONTHS_PREF_KEY = 'xc_new_account_months_pref';
const INACTIVE_MONTHS_PREF_KEY = 'xc_inactive_months_pref';

function clampFilterMonths(value) {
  const months = Math.round(Number(value));
  if (!Number.isFinite(months)) return FILTER_MONTHS_DEFAULT;
  return Math.min(FILTER_MONTHS_MAX, Math.max(FILTER_MONTHS_MIN, months));
}

function readNewAccountMonths() {
  return clampFilterMonths(newAccountMonthsEl?.value);
}

function setNewAccountMonthsInput(value) {
  if (!newAccountMonthsEl) return;
  newAccountMonthsEl.value = String(clampFilterMonths(value));
}

function readInactiveMonths() {
  return clampFilterMonths(inactiveMonthsEl?.value);
}

function setInactiveMonthsInput(value) {
  if (!inactiveMonthsEl) return;
  inactiveMonthsEl.value = String(clampFilterMonths(value));
}

function persistFilterMonths(prefKey, value) {
  chrome.storage.local.set({ [prefKey]: clampFilterMonths(value) }).catch(() => {});
}

function bumpFilterMonths(inputEl, prefKey, delta) {
  const next = clampFilterMonths(inputEl?.value) + delta;
  if (inputEl) inputEl.value = String(next);
  persistFilterMonths(prefKey, next);
}
const accountEl = document.getElementById('account');
const methodEl = document.getElementById('method');
const fetchModeSelect = document.getElementById('fetchModeSelect');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');
const statusLogEl = document.getElementById('statusLog');
const statusLogLabelEl = document.getElementById('statusLogLabel');
const mutualsEl = document.getElementById('mutuals');
const subStatusEl = document.getElementById('subStatus');
const checkSubBtn = document.getElementById('checkSubBtn');
const upgradeBtn = document.getElementById('upgradeBtn');
const modeFollowingEl = document.getElementById('modeFollowing');
const modeFollowersEl = document.getElementById('modeFollowers');
const freshStartEl = document.getElementById('freshStart');

const PRO_CHECKOUT_URL = 'https://x.com/d2fl/creator-subscriptions/subscribe';
const FREE_FETCH_LIMIT = 200;

let pollTimer = null;
let currentListType = 'following';
let lastDebugStatusLog = [];
let lastDebugStatusLogEnabled = true;

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
  let text = formatSubscriptionStatus(state);
  if (state.subsFetchError) {
    text += ` — ⚠ ${state.subsFetchError}`;
  }
  subStatusEl.textContent = text;
  subStatusEl.style.color = state.subsFetchError ? '#b8860b' : '';
  const showSubscribe = !state.isSubscribed;
  upgradeBtn.style.display = showSubscribe ? 'block' : 'none';
  checkSubBtn.disabled = !!state.isScraping;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b00020' : '#222';
}

function renderDebugStatusLog(state = {}) {
  if (!statusLogEl || !statusLogLabelEl) return;
  const enabled = state.debugStatusLogEnabled != null
    ? !!state.debugStatusLogEnabled
    : lastDebugStatusLogEnabled;
  const incoming = Array.isArray(state.debugStatusLog) ? state.debugStatusLog : null;
  if (incoming?.length) {
    lastDebugStatusLog = incoming;
    lastDebugStatusLogEnabled = enabled;
  }
  const lines = incoming?.length ? incoming : lastDebugStatusLog;
  const showLog = enabled && lines.length > 0;
  statusLogEl.classList.toggle('is-visible', showLog);
  statusLogLabelEl.classList.toggle('is-visible', showLog);
  if (!showLog) {
    if (!enabled) statusLogEl.textContent = '';
    return;
  }
  statusLogEl.textContent = lines.length ? lines.join('\n') : '(waiting for status updates...)';
  statusLogEl.scrollTop = statusLogEl.scrollHeight;
  statusLogEl.title = lines.length ? 'Click to copy status log' : '';
}

if (statusLogEl) {
  statusLogEl.addEventListener('click', async () => {
    const text = statusLogEl.textContent || '';
    if (!text || text.startsWith('(waiting')) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Status log copied to clipboard.');
    } catch (error) {
      setStatus('Could not copy log — select text and copy manually.');
    }
  });
}

function mutualsSummaryLine(mutuals) {
  if (!mutuals || (mutuals.mutualCount == null && !mutuals.hasRelationshipData && !mutuals.hasBoth)) {
    return '';
  }

  let line = `Mutuals: ${(mutuals.mutualCount || 0).toLocaleString()}`;
  if (mutuals.hasRelationshipData && mutuals.source) {
    const srcLabel = mutuals.source === 'followers' ? 'followers' : 'following';
    line += ` (live from ${srcLabel}`;
    if (mutuals.relationshipCoverage && mutuals.relationshipTotal) {
      line += `, ${mutuals.relationshipCoverage.toLocaleString()} / ${mutuals.relationshipTotal.toLocaleString()} with flags`;
    }
    line += ')';
  } else if (mutuals.hasBoth) {
    line += ` (${mutuals.followingCount.toLocaleString()} following ∩ ${mutuals.followersCount.toLocaleString()} followers)`;
  }
  return line;
}

function renderMutuals(state) {
  const mutuals = state.mutuals;
  const stored = state.storedCounts || {};
  const activeType = state.listType || currentListType;
  const activeLabel = listLabel(activeType);
  const otherLabel = activeType === 'followers' ? 'Following' : 'Followers';
  const otherCount = activeType === 'followers' ? stored.following : stored.followers;
  const activeCount = state.count || (activeType === 'followers' ? stored.followers : stored.following) || 0;
  const mutualLine = mutualsSummaryLine(mutuals);

  if ((state.reason === 'complete' || state.reason === 'stopped') && activeCount > 0) {
    let line = `${activeLabel}: ${activeCount.toLocaleString()} collected`;
    if (otherCount > 0) {
      line += ` • ${otherLabel}: ${otherCount.toLocaleString()} saved (prior session)`;
    }
    if (mutualLine) line += ` • ${mutualLine}`;
    mutualsEl.textContent = line;
    return;
  }

  if (state.isScraping && activeCount > 0 && mutualLine) {
    mutualsEl.textContent = mutualLine;
    return;
  }

  if (!mutuals?.hasBoth && !mutuals?.hasRelationshipData) {
    const parts = [];
    if (stored.following > 0) parts.push(`${stored.following.toLocaleString()} following saved`);
    if (stored.followers > 0) parts.push(`${stored.followers.toLocaleString()} followers saved`);
    mutualsEl.textContent = parts.length ? parts.join(' • ') : '';
    return;
  }

  mutualsEl.textContent = mutualLine;
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
  const engineNote = state.fetchModeLabel || state.fetchMode || 'auto';
  const activeMethod = state.method === 'rest-v1.1'
    ? 'REST v1.1'
    : state.method === 'graphql-worker'
      ? 'GraphQL worker'
      : (state.method === 'native-sniffer' ? 'sniffer' : engineNote);
  methodEl.textContent = `Collect ${listLabel()} via ${activeMethod} (${limitNote})`;
  if (fetchModeSelect && state.fetchMode) {
    fetchModeSelect.value = state.fetchMode;
  }
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
  if (freshStartEl) freshStartEl.disabled = busy;
  if (fetchModeSelect) fetchModeSelect.disabled = busy;
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

  if (state.reason === 'collecting' && state.status) {
    return state.status;
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
    if (state.status) return state.status;
    if (state.canExport) {
      return `Collection complete. Filter or export ${label} CSV from here or the X page panel.`;
    }
    return `Collection complete (free tier). Filter in-app; subscribe @d2fl to export.`;
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
  const merged = {
    debugStatusLogEnabled: lastDebugStatusLogEnabled,
    debugStatusLog: lastDebugStatusLog,
    ...state
  };
  renderProgress(merged);
  setStatus(statusMessage(merged));
  renderDebugStatusLog(merged);
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

if (fetchModeSelect) {
  fetchModeSelect.addEventListener('change', async () => {
    const result = await sendBackground('setFetchMode', { fetchMode: fetchModeSelect.value });
    if (result.ok || result.fetchMode) {
      updateUI(result);
    }
  });
}

startBtn.addEventListener('click', async () => {
  const listType = selectedListType();
  const forceRefresh = !!freshStartEl?.checked;
  const prior = await sendBackground('getStatus');
  const priorCount = forceRefresh
    ? 0
    : (prior?.count
      || (listType === 'followers' ? prior?.storedCounts?.followers : prior?.storedCounts?.following)
      || 0);
  updateUI({
    isScraping: true,
    count: priorCount,
    totalFollowing: forceRefresh ? null : (prior?.totalFollowing ?? null),
    totalFollowers: forceRefresh ? null : (prior?.totalFollowers ?? null),
    listType,
    username: prior?.username || null
  });
  const fetchMode = fetchModeSelect?.value || 'auto';
  const freshNote = forceRefresh ? ' (fresh start — clearing cache)' : '';
  const modeHint = fetchMode === 'rest'
    ? `REST fetch for ${listLabel(listType)} (200/page)${freshNote}...`
    : fetchMode === 'sniffer'
      ? `Opening profile and ${listLabel(listType)} page (sniffer)${freshNote}...`
      : `Trying REST fetch for ${listLabel(listType)}, sniffer if needed${freshNote}...`;
  setStatus(modeHint);
  startPolling();

  const result = await sendBackground('runExportFlow', { listType, fetchMode, forceRefresh });

  stopPolling();
  await refreshStatus();

  if (!result.ok && !result.isScraping) {
    setStatus(result.error || 'Failed to start collection.', true);
    return;
  }
});

stopBtn.addEventListener('click', async () => {
  setStatus('Stopping collection...');
  const result = await sendBackground('stopScrape');

  if (!result.ok) {
    setStatus(result.error || 'Failed to stop collection.', true);
    return;
  }

  await refreshStatus();
});

filterBtn.addEventListener('click', async () => {
  setStatus('Applying filters...');
  const result = await sendBackground('filterList', {
    removeBlue: removeBlueEl.checked,
    removeNew: removeNewEl.checked,
    removeInactive: removeInactiveEl.checked,
    newAccountMonths: readNewAccountMonths(),
    inactiveMonths: readInactiveMonths()
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
    const result = await sendBackground('checkSubscription', { syncFromTab: true, force: true });
    if (result.ok === false && !result.isSubscribed) {
      setStatus(result.error || 'Could not refresh subscription.', true);
      return;
    }
    updateUI(result);
    if (result.subsFetchError) {
      setStatus(`${result.subsFetchError} — using cached subscription status.`, true);
    } else {
      setStatus(result.subscriptionStatus || 'Subscription status updated.');
    }
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

function wireFilterMonthsStepper({
  inputEl,
  decEl,
  incEl,
  prefKey,
  setInput,
  readValue
}) {
  decEl?.addEventListener('click', () => bumpFilterMonths(inputEl, prefKey, -1));
  incEl?.addEventListener('click', () => bumpFilterMonths(inputEl, prefKey, 1));
  inputEl?.addEventListener('change', () => {
    setInput(inputEl.value);
    persistFilterMonths(prefKey, readValue());
  });
  chrome.storage.local.get(prefKey, (res) => {
    if (chrome.runtime.lastError) return;
    if (res[prefKey] != null) setInput(res[prefKey]);
  });
}

wireFilterMonthsStepper({
  inputEl: newAccountMonthsEl,
  decEl: newAccountMonthsDecEl,
  incEl: newAccountMonthsIncEl,
  prefKey: NEW_ACCOUNT_MONTHS_PREF_KEY,
  setInput: setNewAccountMonthsInput,
  readValue: readNewAccountMonths
});

wireFilterMonthsStepper({
  inputEl: inactiveMonthsEl,
  decEl: inactiveMonthsDecEl,
  incEl: inactiveMonthsIncEl,
  prefKey: INACTIVE_MONTHS_PREF_KEY,
  setInput: setInactiveMonthsInput,
  readValue: readInactiveMonths
});

sendBackground('getStatus').then((state) => {
  if (state?.ok !== false) updateUI(state);
});

sendBackground('checkSubscription', { syncFromTab: true, force: false }).then((result) => {
  if (result?.ok !== false || result?.username || result?.isSubscribed != null) {
    updateUI(result);
  } else {
    refreshStatus();
  }
}).catch(() => {
  refreshStatus();
});

sendBackground('getJobState').then((state) => {
  if (state?.isScraping) startPolling();
});

window.addEventListener('unload', stopPolling);