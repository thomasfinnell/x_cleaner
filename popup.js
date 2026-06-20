(function positionDebugPanel() {
  if (new URLSearchParams(location.search).get('panel') !== '1') return;
  const place = () => {
    try {
      const margin = 16;
      const width = window.outerWidth || 440;
      const left = Math.max(0, (screen.availWidth || screen.width || 1280) - width - margin);
      window.moveTo(left, 72);
    } catch (error) {}
  };
  place();
  window.addEventListener('load', place);
})();

const manifest = chrome.runtime.getManifest();
const appTitleEl = document.getElementById('appTitle');
if (appTitleEl && manifest?.version) {
  appTitleEl.textContent = `X Cleaner v${manifest.version}`;
}

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const viewBtn = document.getElementById('viewBtn');
const filterBtn = document.getElementById('filterBtn');
const removeMutualsEl = document.getElementById('removeMutuals');
const removeBlueEl = document.getElementById('removeBlue');
const removeInactiveEl = document.getElementById('removeInactive');
const botCheckEl = document.getElementById('botCheck');
const inactiveMonthsEl = document.getElementById('inactiveMonths');
const inactiveMonthsDecEl = document.getElementById('inactiveMonthsDec');
const inactiveMonthsIncEl = document.getElementById('inactiveMonthsInc');

const FILTER_MONTHS_MIN = 1;
const FILTER_MONTHS_MAX = 24;
const FILTER_MONTHS_DEFAULT = 6;
const INACTIVE_MONTHS_PREF_KEY = 'xc_inactive_months_pref';

function clampFilterMonths(value) {
  const months = Math.round(Number(value));
  if (!Number.isFinite(months)) return FILTER_MONTHS_DEFAULT;
  return Math.min(FILTER_MONTHS_MAX, Math.max(FILTER_MONTHS_MIN, months));
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
const followingCardEl = document.getElementById('followingCard');
const followersCardEl = document.getElementById('followersCard');
const followingCountEl = document.getElementById('followingCount');
const followersCountEl = document.getElementById('followersCount');
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
const loadFollowingBtn = document.getElementById('loadFollowingBtn');
const loadFollowersBtn = document.getElementById('loadFollowersBtn');
const importFollowingInput = document.getElementById('importFollowingInput');
const importFollowersInput = document.getElementById('importFollowersInput');
const importInfoEl = document.getElementById('importInfo');
const importModeReplaceEl = document.getElementById('importModeReplace');
const fastScrollEl = document.getElementById('fastScroll');
const fastScrollToastEl = document.getElementById('fastScrollToast');

const FAST_SCROLL_PREF_KEY = 'xc_fast_scroll_pref';
const FAST_SCROLL_WARN = 'Fast mode uses REST bulk + aggressive scrolling and may trigger reduced reach or a shadowban on X. Leave unchecked for observe-only gentle pacing (scroll + sniffer + DOM, no REST bulk).';
let fastScrollToastTimer = null;

function closePopup() {
  window.close();
}

const PRO_CHECKOUT_URL = 'https://x.com/d2fl/creator-subscriptions/subscribe';
const FREE_FETCH_LIMIT = 200;

let pollTimer = null;
let currentListType = 'following';
let pendingListType = null;
let lastDebugStatusLog = [];
let lastDebugStatusLogEnabled = true;

function selectedListType() {
  return modeFollowersEl.checked ? 'followers' : 'following';
}

function selectedImportMode() {
  return importModeReplaceEl?.checked ? 'replace' : 'append';
}

function activeListCount(state = {}) {
  return xcCountForListType(state, selectedListType());
}

function listLabel(type = currentListType) {
  return type === 'followers' ? 'Followers' : 'Following';
}

function isListTypeLocked(state = {}) {
  return !!state.listTypeLocked;
}

function syncListTypeUi(type = 'following') {
  if (type === 'followers') {
    modeFollowersEl.checked = true;
  } else {
    modeFollowingEl.checked = true;
  }
  followingCardEl?.classList.toggle('active', type !== 'followers');
  followersCardEl?.classList.toggle('active', type === 'followers');
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
    if (state.subscriptionSource === 'owner') {
      return `Owner account — unlimited fetch & export (${handle})`;
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
  if (state.sniffFailed && state.sniffError) {
    text += ` — ⚠ ${state.sniffError}`;
  }
  subStatusEl.textContent = text;
  subStatusEl.style.color = state.sniffFailed && state.sniffError ? '#b8860b' : '';
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
  const merged = typeof xcPickDebugStatusLog === 'function'
    ? xcPickDebugStatusLog(state.debugStatusLog, lastDebugStatusLog)
    : (Array.isArray(state.debugStatusLog) && state.debugStatusLog.length
      ? state.debugStatusLog
      : lastDebugStatusLog);
  if (merged.length) {
    lastDebugStatusLog = merged;
    lastDebugStatusLogEnabled = enabled;
  }
  const lines = merged;
  const showLog = enabled;
  statusLogEl.classList.toggle('is-visible', showLog);
  statusLogLabelEl.classList.toggle('is-visible', showLog);
  if (!showLog) {
    statusLogEl.textContent = '';
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

function formatListTotal(total) {
  if (total == null || total === '') return '—';
  const num = Number(total);
  return Number.isFinite(num) ? num.toLocaleString() : '—';
}

function renderListCards(state) {
  const stats = state.listStats || {};
  const stored = state.storedCounts || {};
  const activeType = state.listType || currentListType;

  const following = stats.following || {
    count: stored.following || 0,
    rawCount: stored.following || 0,
    total: state.totalFollowing ?? null
  };
  const followers = stats.followers || {
    count: stored.followers || 0,
    rawCount: stored.followers || 0,
    total: state.totalFollowers ?? null
  };

  if (followingCountEl) {
    followingCountEl.textContent = `${(following.count || 0).toLocaleString()} / ${formatListTotal(following.total)}`;
  }
  if (followersCountEl) {
    followersCountEl.textContent = `${(followers.count || 0).toLocaleString()} / ${formatListTotal(followers.total)}`;
  }

  const mutualLine = mutualsSummaryLine(state.mutuals);
  mutualsEl.textContent = mutualLine || '';
}

function renderActiveProgress(state) {
  const activeType = state.listType || currentListType;
  const stats = state.listStats || {};
  const activeStats = activeType === 'followers' ? stats.followers : stats.following;
  const count = activeStats?.count ?? state.count ?? 0;
  const rawCount = activeStats?.rawCount ?? state.rawCount ?? count;

  if (state.isEnriching && state.enrichTotal) {
    progressEl.textContent =
      `${listLabel(activeType)}: checking ${(state.enrichProcessed || 0).toLocaleString()} / ${state.enrichTotal.toLocaleString()}`;
    return;
  }
  if (state.reason === 'filtering' || state.reason === 'filtered') {
    progressEl.textContent = `${listLabel(activeType)} filter: ${count.toLocaleString()} / ${rawCount.toLocaleString()}`;
    return;
  }
  if (state.isScraping && state.status) {
    progressEl.textContent = state.status;
    return;
  }
  if (state.status && (state.reason === 'complete' || state.reason === 'stopped')) {
    progressEl.textContent = state.status;
    return;
  }
  progressEl.textContent = '';
}

function renderProgress(state) {
  const count = state.count || 0;
  const rawCount = state.rawCount || count;
  const username = state.username;
  currentListType = state.listType || currentListType || selectedListType();
  syncListTypeUi(pendingListType || currentListType);

  accountEl.textContent = username ? `@${username}` : '@—';
  const limitNote = state.isSubscribed
    ? 'unlimited'
    : `up to ${state.fetchLimit || FREE_FETCH_LIMIT}`;
  const engineNote = state.fetchModeLabel || state.fetchMode || 'auto';
  const activeMethod = state.method === 'rest-v1.1'
    ? 'REST v1.1'
    : state.method === 'graphql-worker'
      ? 'GraphQL worker'
      : state.method === 'observe'
        ? 'observe'
        : (state.method === 'native-sniffer' ? 'sniffer' : engineNote);
  const scrollNote = state.fastScrollLabel || (state.fastScroll ? 'fast scroll' : 'gentle scroll');
  methodEl.textContent = `Collect ${listLabel()} via ${activeMethod}, ${scrollNote} (${limitNote})`;
  if (fastScrollEl && state.fastScroll != null && fastScrollEl.checked !== !!state.fastScroll) {
    fastScrollEl.checked = !!state.fastScroll;
  }
  renderSubscription(state);
  renderListCards(state);
  renderActiveProgress(state);

  const busy = !!state.isScraping;
  const listLocked = isListTypeLocked(state);
  startBtn.disabled = busy;
  modeFollowingEl.disabled = listLocked;
  modeFollowersEl.disabled = listLocked;
  if (freshStartEl) freshStartEl.disabled = busy;
  if (fastScrollEl) fastScrollEl.disabled = busy;
  stopBtn.style.display = busy ? 'block' : 'none';
  const canExport = !!state.canExport;
  const previewType = pendingListType || selectedListType();
  const previewCount = xcCountForListType(state, previewType);
  const canView = canViewListPreview(state, previewType);
  if (viewBtn) {
    viewBtn.disabled = !canView;
    viewBtn.title = canView
      ? previewCount > 0
        ? busy
          ? `Preview first 5 ${listLabel(previewType).toLowerCase()} (${previewCount.toLocaleString()} loaded so far)`
          : `Preview first 5 ${listLabel(previewType).toLowerCase()} records`
        : `Preview first 5 ${listLabel(previewType).toLowerCase()} (free — up to 5 rows)`
      : 'Collect or import a list first';
  }
  exportBtn.disabled = count === 0 || !canExport;
  exportBtn.classList.toggle('export-locked', count > 0 && !canExport);
  exportBtn.title = canExport
    ? 'Download CSV'
    : 'Export requires @d2fl subscription';
  const filterSourceCount = typeof xcRawCountForListType === 'function'
    ? xcRawCountForListType(state, previewType)
    : (state.rawCount || count);
  const canFilter = filterSourceCount > 0;
  filterBtn.disabled =
    !canFilter || busy || !!state.isEnriching || state.reason === 'filtering';
  filterBtn.title = canFilter
    ? count === 0
      ? `Re-filter from ${filterSourceCount.toLocaleString()} collected ${listLabel(previewType).toLowerCase()} (current filter removed all)`
      : `Filter ${listLabel(previewType).toLowerCase()} (${count.toLocaleString()} shown / ${filterSourceCount.toLocaleString()} collected)`
    : 'Collect or import a list first';
  const importBusy = busy || !!state.isEnriching || state.reason === 'filtering';
  if (loadFollowingBtn) loadFollowingBtn.disabled = importBusy;
  if (loadFollowersBtn) loadFollowersBtn.disabled = importBusy;
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

function shouldKeepStatusPolling(state = {}) {
  if (!state) return false;
  if (state.isScraping) return true;
  const activeReasons = new Set([
    'start',
    'collecting',
    'loading-profile',
    'profile-loaded',
    'waiting-native',
    'filtering',
    'enriching'
  ]);
  return activeReasons.has(state.reason);
}

function canViewListPreview(state = {}, type = 'following') {
  if (typeof xcCanViewListPreview === 'function') {
    return xcCanViewListPreview(state, type);
  }
  const count = typeof xcCountForListType === 'function'
    ? xcCountForListType(state, type)
    : (state.count || 0);
  if (count > 0) return true;
  const stored = state.storedCounts || {};
  if ((stored.following || 0) > 0 || (stored.followers || 0) > 0) return true;
  if (state.canExport === false) return true;
  return false;
}

async function refreshStatus() {
  await sendBackground('syncFromFocusedTab', { refreshSub: false });
  const result = await sendBackground('getStatus');
  if (result?.ok !== false) {
    updateUI(result);
    if (shouldKeepStatusPolling(result)) {
      startPolling();
    } else if (['complete', 'stopped', 'exported', 'filtered', 'error', 'observe-empty', 'rest-empty'].includes(result.reason)) {
      stopPolling();
    }
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
  if (nextType === (pendingListType || currentListType)) return;
  pendingListType = nextType;
  syncListTypeUi(nextType);
  const result = await sendBackground('setListType', { listType: nextType });
  pendingListType = null;
  if (result?.ok !== false) {
    currentListType = result.listType || nextType;
    updateUI(result);
  } else if (result?.error) {
    setStatus(result.error, true);
    syncListTypeUi(currentListType);
  }
}

function wireListCardSwitch(cardEl, nextType) {
  cardEl?.addEventListener('click', () => {
    if (modeFollowingEl.disabled || modeFollowersEl.disabled) return;
    switchListType(nextType);
  });
}

modeFollowingEl.addEventListener('change', () => {
  if (modeFollowingEl.checked) switchListType('following');
});

modeFollowersEl.addEventListener('change', () => {
  if (modeFollowersEl.checked) switchListType('followers');
});

wireListCardSwitch(followingCardEl, 'following');
wireListCardSwitch(followersCardEl, 'followers');

function showFastScrollWarning() {
  if (!fastScrollToastEl) return;
  fastScrollToastEl.textContent = FAST_SCROLL_WARN;
  fastScrollToastEl.hidden = false;
  clearTimeout(fastScrollToastTimer);
  fastScrollToastTimer = setTimeout(() => {
    fastScrollToastEl.hidden = true;
  }, 8000);
}

function hideFastScrollWarning() {
  if (!fastScrollToastEl) return;
  fastScrollToastEl.hidden = true;
  clearTimeout(fastScrollToastTimer);
}

fastScrollEl?.addEventListener('change', async () => {
  const enabled = !!fastScrollEl.checked;
  if (enabled) {
    showFastScrollWarning();
  } else {
    hideFastScrollWarning();
  }
  const result = await sendBackground('setFastScroll', { fastScroll: enabled });
  if (result?.ok !== false) updateUI(result);
});

startBtn.addEventListener('click', async () => {
  const listType = selectedListType();
  const forceRefresh = !!freshStartEl?.checked;
  const fetchMode = 'auto';
  const fastScroll = !!fastScrollEl?.checked;
  startBtn.disabled = true;
  setStatus('Opening on-page panel on your X tab...');
  const result = await sendBackground('runExportFlow', {
    listType,
    fetchMode,
    forceRefresh,
    fastScroll,
    handoffAfterHud: true
  });
  if (result?.hudReady) {
    closePopup();
    return;
  }
  startBtn.disabled = false;
  setStatus(result?.error || 'Could not start collection — keep an x.com tab open and try again.', true);
});

stopBtn.addEventListener('click', async () => {
  const result = await sendBackground('stopScrape');
  if (result) updateUI(result);
  const refreshed = await sendBackground('getStatus');
  if (refreshed) updateUI(refreshed);
  if (!lastDebugStatusLogEnabled) closePopup();
});

filterBtn.addEventListener('click', async () => {
  filterBtn.disabled = true;
  setStatus('Opening on-page panel on your X tab...');
  const result = await sendBackground('filterList', {
    listType: selectedListType(),
    removeMutuals: removeMutualsEl?.checked,
    removeBlue: removeBlueEl.checked,
    removeInactive: removeInactiveEl.checked,
    botCheck: botCheckEl?.checked,
    inactiveMonths: readInactiveMonths(),
    handoffAfterHud: true
  });
  if (result?.hudReady) {
    closePopup();
    return;
  }
  filterBtn.disabled = false;
  setStatus(
    result?.error || 'Could not open on-page panel — keep an x.com tab open and try again.',
    true
  );
});

checkSubBtn.addEventListener('click', async () => {
  checkSubBtn.disabled = true;
  setStatus('Opening on-page panel on your X tab...');
  const result = await sendBackground('checkSubscription', {
    syncFromTab: true,
    force: true,
    handoffAfterHud: true
  });
  if (result?.hudReady) {
    closePopup();
    return;
  }
  checkSubBtn.disabled = false;
  setStatus(
    result?.error || 'Could not open on-page panel — keep an x.com tab open and try again.',
    true
  );
});

upgradeBtn.addEventListener('click', () => {
  sendBackground('openSubscribe');
  closePopup();
});

viewBtn?.addEventListener('click', () => {
  if (viewBtn.disabled) return;
  xcOpenListPreview((listType) => sendBackground('getListPreview', { listType }), selectedListType());
});

exportBtn.addEventListener('click', () => {
  if (exportBtn.disabled) return;
  sendBackground('exportCSV');
  closePopup();
});

async function handleCsvImport(listType, file) {
  if (!file) return;
  const mode = selectedImportMode();
  if (loadFollowingBtn) loadFollowingBtn.disabled = true;
  if (loadFollowersBtn) loadFollowersBtn.disabled = true;
  setStatus(`Loading ${listLabel(listType).toLowerCase()} CSV...`);
  try {
    const csvText = await file.text();
    const result = await sendBackground('loadListCsv', { listType, csvText, mode });
    if (result?.ok !== false && (result.ok || result.count > 0)) {
      updateUI(result);
      if (importInfoEl) {
        importInfoEl.textContent = result.status || `Loaded ${(result.importLoaded || result.count || 0).toLocaleString()} ${listLabel(listType).toLowerCase()}.`;
      }
      return;
    }
    setStatus(result?.error || 'CSV import failed.', true);
  } catch (error) {
    setStatus(String(error?.message || error || 'CSV import failed.'), true);
  } finally {
    if (loadFollowingBtn) loadFollowingBtn.disabled = false;
    if (loadFollowersBtn) loadFollowersBtn.disabled = false;
  }
}

loadFollowingBtn?.addEventListener('click', () => importFollowingInput?.click());
loadFollowersBtn?.addEventListener('click', () => importFollowersInput?.click());

importFollowingInput?.addEventListener('change', async () => {
  const file = importFollowingInput.files?.[0];
  importFollowingInput.value = '';
  await handleCsvImport('following', file);
});

importFollowersInput?.addEventListener('change', async () => {
  const file = importFollowersInput.files?.[0];
  importFollowersInput.value = '';
  await handleCsvImport('followers', file);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'scrapeStatus') return;
  updateUI(message);
  if (shouldKeepStatusPolling(message)) {
    startPolling();
  } else if (['complete', 'stopped', 'exported', 'filtered', 'error', 'observe-empty', 'rest-empty'].includes(message.reason)) {
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
  inputEl: inactiveMonthsEl,
  decEl: inactiveMonthsDecEl,
  incEl: inactiveMonthsIncEl,
  prefKey: INACTIVE_MONTHS_PREF_KEY,
  setInput: setInactiveMonthsInput,
  readValue: readInactiveMonths
});

chrome.storage.local.get(FAST_SCROLL_PREF_KEY, (res) => {
  if (chrome.runtime.lastError || !fastScrollEl) return;
  fastScrollEl.checked = !!res[FAST_SCROLL_PREF_KEY];
});

refreshStatus();

sendBackground('getJobState').then((state) => {
  if (state?.fastScroll != null && fastScrollEl) {
    fastScrollEl.checked = !!state.fastScroll;
  }
  if (state) updateUI(state);
  if (shouldKeepStatusPolling(state)) startPolling();
});

window.addEventListener('unload', stopPolling);