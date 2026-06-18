// On-page HUD for X Cleaner (collection runs via GraphQL in the background)
const HUD_ID = 'xcleaner-hud';
const HUD_DISMISSED_KEY = 'xc_hud_dismissed';
const FILTER_MONTHS_MIN = 1;
const FILTER_MONTHS_MAX = 24;
const FILTER_MONTHS_DEFAULT = 6;
const INACTIVE_MONTHS_PREF_KEY = 'xc_inactive_months_pref';

function isExtensionContextValid() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch (error) {
    return false;
  }
}

function sendToBackground(payload) {
  if (!isExtensionContextValid()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        void chrome.runtime.lastError;
        resolve(response ?? null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function clampFilterMonths(value) {
  const months = Math.round(Number(value));
  if (!Number.isFinite(months)) return FILTER_MONTHS_DEFAULT;
  return Math.min(FILTER_MONTHS_MAX, Math.max(FILTER_MONTHS_MIN, months));
}

function readHudFilterMonths(hud, inputId) {
  const input = hud?.querySelector(inputId);
  return clampFilterMonths(input?.value);
}

function setHudFilterMonths(hud, inputId, value) {
  const input = hud?.querySelector(inputId);
  if (!input) return;
  input.value = String(clampFilterMonths(value));
}

function persistFilterMonths(prefKey, value) {
  if (!isExtensionContextValid()) return;
  try {
    chrome.storage.local.set({ [prefKey]: clampFilterMonths(value) });
  } catch (error) {}
}

function wireHudFilterMonthsStepper(hud, {
  inputId,
  decId,
  incId,
  prefKey
}) {
  const input = hud.querySelector(inputId);
  const decBtn = hud.querySelector(decId);
  const incBtn = hud.querySelector(incId);
  if (!input) return;

  const bump = (delta) => {
    setHudFilterMonths(hud, inputId, readHudFilterMonths(hud, inputId) + delta);
    persistFilterMonths(prefKey, readHudFilterMonths(hud, inputId));
  };

  decBtn?.addEventListener('click', () => bump(-1));
  incBtn?.addEventListener('click', () => bump(1));
  input.addEventListener('change', () => {
    setHudFilterMonths(hud, inputId, input.value);
    persistFilterMonths(prefKey, readHudFilterMonths(hud, inputId));
  });

  if (!isExtensionContextValid()) return;
  chrome.storage.local.get(prefKey, (res) => {
    if (chrome.runtime.lastError) return;
    if (res[prefKey] != null) {
      setHudFilterMonths(hud, inputId, res[prefKey]);
    }
  });
}

function wireHudFilterMonthSteppers(hud) {
  wireHudFilterMonthsStepper(hud, {
    inputId: '#xcleaner-inactive-months',
    decId: '#xcleaner-inactive-months-dec',
    incId: '#xcleaner-inactive-months-inc',
    prefKey: INACTIVE_MONTHS_PREF_KEY
  });
}

function formatTotal(total) {
  return total == null ? '—' : total.toLocaleString();
}

function isHudDismissed() {
  try {
    return sessionStorage.getItem(HUD_DISMISSED_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function setHudDismissed(dismissed) {
  try {
    if (dismissed) {
      sessionStorage.setItem(HUD_DISMISSED_KEY, '1');
    } else {
      sessionStorage.removeItem(HUD_DISMISSED_KEY);
    }
  } catch (error) {}
}

function hideHud() {
  setHudDismissed(true);
  const hud = document.getElementById(HUD_ID);
  if (hud) hud.remove();
}

function selectedHudListType() {
  const followers = document.getElementById('xcleaner-mode-followers');
  return followers?.checked ? 'followers' : 'following';
}

function ensureHud() {
  let hud = document.getElementById(HUD_ID);
  if (hud) return hud;

  hud = document.createElement('div');
  hud.id = HUD_ID;
  hud.innerHTML = `
    <style>
      #${HUD_ID} {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483646;
        width: 270px;
        background: rgba(0, 0, 0, 0.9);
        color: #fff;
        border: 1px solid #2f3336;
        border-radius: 12px;
        padding: 12px;
        font: 13px/1.4 Arial, sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }
      #${HUD_ID} .xc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
      }
      #${HUD_ID} .xc-title { font-weight: 700; }
      #${HUD_ID} .xc-close {
        width: auto;
        margin: 0;
        padding: 2px 8px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #8b98a5;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      #${HUD_ID} .xc-close:hover { color: #fff; background: rgba(255,255,255,0.08); }
      #${HUD_ID} .xc-fresh-start {
        margin: 0 0 8px;
        font-size: 11px;
        color: #cfd9de;
        line-height: 1.35;
      }
      #${HUD_ID} .xc-fresh-start label {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        cursor: pointer;
        font-weight: 700;
      }
      #${HUD_ID} .xc-fresh-start input { margin-top: 2px; }
      #${HUD_ID} .xc-start { background: #e7e9ea; color: #0f1419; }
      #${HUD_ID} .xc-method { color: #8b98a5; font-size: 11px; margin-bottom: 6px; }
      #${HUD_ID} .xc-toggle {
        display: flex;
        gap: 6px;
        margin: 6px 0 8px;
      }
      #${HUD_ID} .xc-toggle label {
        flex: 1;
        text-align: center;
        padding: 6px 4px;
        border: 1px solid #2f3336;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
        color: #cfd9de;
      }
      #${HUD_ID} .xc-toggle input { display: none; }
      #${HUD_ID} .xc-toggle label:has(input:checked) {
        background: #1d9bf0;
        color: #fff;
        border-color: #1d9bf0;
      }
      #${HUD_ID} .xc-mutuals { color: #8b98a5; font-size: 11px; margin-bottom: 6px; min-height: 14px; }
      #${HUD_ID} .xc-account { color: #cfd9de; margin-bottom: 4px; }
      #${HUD_ID} .xc-progress { font-size: 22px; font-weight: 700; margin: 8px 0; }
      #${HUD_ID} .xc-status { color: #cfd9de; min-height: 18px; margin-bottom: 6px; font-size: 12px; line-height: 1.35; }
      #${HUD_ID} .xc-status-log {
        display: none;
        margin: 0 0 8px;
        padding: 6px 8px;
        border: 1px solid #2f3336;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.35);
        color: #9ec8e8;
        font-family: Consolas, "Courier New", monospace;
        font-size: 10px;
        line-height: 1.35;
        max-height: calc(10px * 1.35 * 10 + 12px);
        overflow-y: auto;
        overflow-x: hidden;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${HUD_ID} .xc-status-log.is-visible { display: block; }
      #${HUD_ID} .xc-status-log-label {
        display: none;
        color: #6e767d;
        font-size: 10px;
        margin-bottom: 4px;
      }
      #${HUD_ID} .xc-status-log-label.is-visible { display: block; }
      #${HUD_ID} .xc-mutuals-filter {
        display: block;
        font-size: 12px;
        margin: 6px 0 4px;
        color: #cfd9de;
      }
      #${HUD_ID} .xc-filter {
        margin: 8px 0;
        padding: 8px;
        border: 1px solid #2f3336;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.04);
      }
      #${HUD_ID} .xc-filter-title {
        font-size: 11px;
        font-weight: 700;
        color: #8b98a5;
        margin-bottom: 6px;
      }
      #${HUD_ID} .xc-filter label {
        display: block;
        font-size: 12px;
        margin: 4px 0;
        color: #cfd9de;
      }
      #${HUD_ID} .xc-months-filter {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
      }
      #${HUD_ID} .xc-months-stepper {
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }
      #${HUD_ID} .xc-months-stepper input {
        width: 38px;
        text-align: center;
        padding: 2px 4px;
        border: 1px solid #2f3336;
        border-radius: 6px;
        font-size: 12px;
        background: rgba(0, 0, 0, 0.35);
        color: #fff;
      }
      #${HUD_ID} .xc-months-stepper input::-webkit-outer-spin-button,
      #${HUD_ID} .xc-months-stepper input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      #${HUD_ID} .xc-months-stepper input[type=number] {
        -moz-appearance: textfield;
      }
      #${HUD_ID} .xc-months-stepper button {
        width: 22px;
        margin: 0;
        padding: 2px 0;
        font-size: 11px;
        line-height: 1.2;
        border-radius: 6px;
        background: #2f3336;
        color: #cfd9de;
      }
      #${HUD_ID} button {
        width: 100%;
        margin: 4px 0;
        padding: 8px 10px;
        border: none;
        border-radius: 999px;
        cursor: pointer;
        font-weight: 700;
      }
      #${HUD_ID} .xc-stop { background: #536471; color: #fff; }
      #${HUD_ID} .xc-filter-btn { background: #536471; color: #fff; }
      #${HUD_ID} .xc-export { background: #1d9bf0; color: #fff; }
      #${HUD_ID} .xc-export.export-locked { background: #536471; }
      #${HUD_ID} .xc-sub {
        margin: 8px 0;
        padding: 8px;
        border: 1px solid #2f3336;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.04);
      }
      #${HUD_ID} .xc-sub-status {
        color: #cfd9de;
        font-size: 11px;
        line-height: 1.4;
        margin-bottom: 6px;
        min-height: 28px;
      }
      #${HUD_ID} .xc-sub-actions {
        display: flex;
        gap: 6px;
      }
      #${HUD_ID} .xc-sub-actions button {
        flex: 1;
        margin: 0;
        padding: 7px 6px;
        font-size: 11px;
      }
      #${HUD_ID} .xc-sub-refresh { background: #536471; color: #fff; }
      #${HUD_ID} .xc-subscribe { background: #1d9bf0; color: #fff; }
      #${HUD_ID} button:disabled { opacity: 0.55; cursor: not-allowed; }
    </style>
    <div class="xc-header">
      <div class="xc-title">X Cleaner</div>
      <button class="xc-close" id="xcleaner-close" type="button" title="Close panel" aria-label="Close panel">×</button>
    </div>
    <div class="xc-method" id="xcleaner-method">Native sniffer (captures X's own requests)</div>
    <div class="xc-toggle">
      <label><input type="radio" name="xc-list-type" id="xcleaner-mode-following" value="following" checked>Following</label>
      <label><input type="radio" name="xc-list-type" id="xcleaner-mode-followers" value="followers">Followers</label>
    </div>
    <div class="xc-account" id="xcleaner-account">@—</div>
    <div class="xc-progress" id="xcleaner-progress">0 / —</div>
    <div class="xc-mutuals" id="xcleaner-mutuals"></div>
    <div class="xc-status" id="xcleaner-status">Ready</div>
    <div class="xc-status-log-label" id="xcleaner-status-log-label">Status log (debug, kept after finish)</div>
    <div class="xc-status-log" id="xcleaner-status-log" aria-live="polite"></div>
    <div class="xc-fresh-start">
      <label for="xcleaner-fresh-start">
        <input type="checkbox" id="xcleaner-fresh-start">
        <span>Fresh start (clear cached list for selected tab)</span>
      </label>
    </div>
    <button class="xc-start" id="xcleaner-start" type="button">Start Collection</button>
    <button class="xc-stop" id="xcleaner-stop" style="display:none;">Stop</button>
    <label class="xc-mutuals-filter" title="Uses the other list (Following/Followers) when relationship flags are missing">
      <input type="checkbox" id="xcleaner-remove-mutuals"> Remove mutuals
    </label>
    <div class="xc-filter">
      <div class="xc-filter-title">Pre-export filter</div>
      <label><input type="checkbox" id="xcleaner-remove-blue"> Remove Verified</label>
      <label class="xc-months-filter">
        <input type="checkbox" id="xcleaner-remove-inactive">
        <span>Last post &gt;</span>
        <span class="xc-months-stepper">
          <button type="button" id="xcleaner-inactive-months-dec" aria-label="Decrease months">−</button>
          <input type="number" id="xcleaner-inactive-months" value="6" min="1" max="24" step="1" aria-label="Last post months">
          <button type="button" id="xcleaner-inactive-months-inc" aria-label="Increase months">+</button>
        </span>
        <span>months</span>
      </label>
      <label title="Followers only: keep potential bots (&lt;10 tweets, default avatar, no bio, account &lt;30 days)">
        <input type="checkbox" id="xcleaner-bot-check"> Bot check
      </label>
      <button class="xc-filter-btn" id="xcleaner-filter" type="button">Filter</button>
    </div>
    <div class="xc-sub">
      <div class="xc-sub-status" id="xcleaner-sub-status">Checking subscription...</div>
      <div class="xc-sub-actions">
        <button class="xc-sub-refresh" id="xcleaner-sub-refresh" type="button">Refresh status</button>
        <button class="xc-subscribe" id="xcleaner-subscribe" type="button">Subscribe @d2fl</button>
      </div>
    </div>
    <button class="xc-export" id="xcleaner-export" title="Requires @d2fl subscription">Export CSV</button>
  `;

  document.documentElement.appendChild(hud);
  wireHudFilterMonthSteppers(hud);

  hud.querySelector('#xcleaner-close').addEventListener('click', () => {
    hideHud();
  });

  hud.querySelector('#xcleaner-start').addEventListener('click', () => {
    const listType = selectedHudListType();
    const forceRefresh = !!hud.querySelector('#xcleaner-fresh-start')?.checked;
    const statusEl = hud.querySelector('#xcleaner-status');
    statusEl.textContent = forceRefresh
      ? `Fresh start — clearing cached ${listLabel(listType).toLowerCase()}...`
      : `Starting ${listLabel(listType).toLowerCase()} collection...`;
    sendToBackground({ action: 'runExportFlow', listType, forceRefresh });
  });

  hud.querySelector('#xcleaner-stop').addEventListener('click', () => {
    sendToBackground({ action: 'stopScrape' });
  });

  hud.querySelector('#xcleaner-export').addEventListener('click', () => {
    sendToBackground({ action: 'exportCSV' });
  });

  hud.querySelector('#xcleaner-sub-refresh').addEventListener('click', async () => {
    const statusEl = hud.querySelector('#xcleaner-status');
    const refreshBtn = hud.querySelector('#xcleaner-sub-refresh');
    refreshBtn.disabled = true;
    statusEl.textContent = 'Refreshing subscription status...';
    const result = await sendToBackground({
      action: 'checkSubscription',
      syncFromTab: true,
      force: true
    });
    refreshBtn.disabled = false;
    if (!result) {
      statusEl.textContent = isExtensionContextValid()
        ? 'Refresh failed.'
        : 'Extension reloaded — refresh this X tab, then try again.';
      return;
    }
    updateHud(result);
    statusEl.textContent = result.subscriptionStatus || 'Subscription status updated.';
  });

  hud.querySelector('#xcleaner-subscribe').addEventListener('click', () => {
    sendToBackground({ action: 'openSubscribe' });
  });

  hud.querySelector('#xcleaner-filter').addEventListener('click', () => {
    const removeMutuals = hud.querySelector('#xcleaner-remove-mutuals').checked;
    const removeBlue = hud.querySelector('#xcleaner-remove-blue').checked;
    const removeInactive = hud.querySelector('#xcleaner-remove-inactive').checked;
    const botCheck = hud.querySelector('#xcleaner-bot-check').checked;
    sendToBackground({
      action: 'filterList',
      listType: selectedHudListType(),
      removeMutuals,
      removeBlue,
      removeInactive,
      botCheck,
      inactiveMonths: readHudFilterMonths(hud, '#xcleaner-inactive-months')
    });
  });

  const modeFollowing = hud.querySelector('#xcleaner-mode-following');
  const modeFollowers = hud.querySelector('#xcleaner-mode-followers');
  modeFollowing.addEventListener('change', () => {
    if (modeFollowing.checked) {
      sendToBackground({ action: 'setListType', listType: 'following' });
    }
  });
  modeFollowers.addEventListener('change', () => {
    if (modeFollowers.checked) {
      sendToBackground({ action: 'setListType', listType: 'followers' });
    }
  });

  return hud;
}

function listLabel(type) {
  return type === 'followers' ? 'Followers' : 'Following';
}

function formatHudSubscriptionStatus(state) {
  if (state.subscriptionStatus) return state.subscriptionStatus;
  const handle = state.username ? `@${state.username}` : '(not detected)';
  const freeLimit = state.freeFetchLimit || 200;
  if (state.isSubscribed) {
    if (state.subscriptionSource === 'subs.txt') {
      return `Beta access — unlimited fetch & export (${handle})`;
    }
    if (state.subscriptionSource === 'x-creator') {
      return `Subscribed to @d2fl on X — unlimited fetch & export (${handle})`;
    }
    return `Subscribed — unlimited fetch & export (${handle})`;
  }
  return `Free — fetch up to ${freeLimit} • export requires @d2fl (${handle})`;
}

function formatTotalForState(state) {
  if (state.fetchTarget != null) return state.fetchTarget.toLocaleString();
  if (state.totalList != null) return state.totalList.toLocaleString();
  const total = (state.listType || 'following') === 'followers'
    ? state.totalFollowers
    : state.totalFollowing;
  return total == null ? '—' : total.toLocaleString();
}

function renderDebugStatusLog(hud, state = {}) {
  const logEl = hud.querySelector('#xcleaner-status-log');
  const labelEl = hud.querySelector('#xcleaner-status-log-label');
  if (!logEl || !labelEl) return;

  const enabled = state.debugStatusLogEnabled !== false;
  const lines = Array.isArray(state.debugStatusLog) ? state.debugStatusLog : [];
  const showLog = enabled && lines.length > 0;
  logEl.classList.toggle('is-visible', showLog);
  labelEl.classList.toggle('is-visible', showLog);
  if (!showLog) {
    if (!enabled) logEl.textContent = '';
    return;
  }

  logEl.textContent = lines.length ? lines.join('\n') : '(waiting for status updates...)';
  logEl.scrollTop = logEl.scrollHeight;
}

function updateHud(state = {}) {
  if (isHudDismissed()) return;

  const hud = ensureHud();
  const count = state.count || 0;
  const type = state.listType || 'following';
  const label = listLabel(type).toLowerCase();

  hud.querySelector('#xcleaner-method').textContent =
    `Collect ${listLabel(type)} via native X responses`;
  hud.querySelector('#xcleaner-mode-following').checked = type !== 'followers';
  hud.querySelector('#xcleaner-mode-followers').checked = type === 'followers';
  hud.querySelector('#xcleaner-mode-following').disabled = !!state.isScraping;
  hud.querySelector('#xcleaner-mode-followers').disabled = !!state.isScraping;

  hud.querySelector('#xcleaner-account').textContent =
    state.username ? `@${state.username}` : '@—';
  const rawCount = state.rawCount || count;
  if (state.isEnriching && state.enrichTotal) {
    hud.querySelector('#xcleaner-progress').textContent =
      `${(state.enrichProcessed || 0).toLocaleString()} / ${state.enrichTotal.toLocaleString()} checked`;
  } else if (state.reason === 'filtering' || state.reason === 'filtered') {
    hud.querySelector('#xcleaner-progress').textContent =
      `${count.toLocaleString()} / ${rawCount.toLocaleString()}`;
  } else {
    hud.querySelector('#xcleaner-progress').textContent =
      `${count.toLocaleString()} / ${formatTotalForState(state)}`;
  }

  const mutualsEl = hud.querySelector('#xcleaner-mutuals');
  const mutuals = state.mutuals;
  const stored = state.storedCounts || {};
  const activeType = state.listType || 'following';
  const activeLabel = listLabel(activeType);
  const otherLabel = activeType === 'followers' ? 'Following' : 'Followers';
  const otherCount = activeType === 'followers' ? stored.following : stored.followers;
  const activeCount = state.count || (activeType === 'followers' ? stored.followers : stored.following) || 0;

  let mutualLine = '';
  if (mutuals) {
    mutualLine = `Mutuals: ${(mutuals.mutualCount || 0).toLocaleString()}`;
    if (mutuals.hasRelationshipData && mutuals.source) {
      const srcLabel = mutuals.source === 'followers' ? 'followers' : 'following';
      mutualLine += ` (live from ${srcLabel}`;
      if (mutuals.relationshipCoverage && mutuals.relationshipTotal) {
        mutualLine += `, ${mutuals.relationshipCoverage.toLocaleString()} / ${mutuals.relationshipTotal.toLocaleString()} with flags`;
      }
      mutualLine += ')';
    } else if (mutuals.hasBoth) {
      mutualLine += ` (${mutuals.followingCount.toLocaleString()} following ∩ ${mutuals.followersCount.toLocaleString()} followers)`;
    }
  }

  if ((state.reason === 'complete' || state.reason === 'stopped') && activeCount > 0) {
    let line = `${activeLabel}: ${activeCount.toLocaleString()} collected`;
    if (otherCount > 0) {
      line += ` • ${otherLabel}: ${otherCount.toLocaleString()} saved (prior)`;
    }
    if (mutualLine) line += ` • ${mutualLine}`;
    mutualsEl.textContent = line;
  } else if (state.isScraping && activeCount > 0 && mutualLine) {
    mutualsEl.textContent = mutualLine;
  } else if (mutualLine && (mutuals?.hasBoth || mutuals?.hasRelationshipData)) {
    mutualsEl.textContent = mutualLine;
  } else {
    const parts = [];
    if (stored.following > 0) parts.push(`${stored.following.toLocaleString()} following saved`);
    if (stored.followers > 0) parts.push(`${stored.followers.toLocaleString()} followers saved`);
    mutualsEl.textContent = parts.join(' • ');
  }

  const startBtn = hud.querySelector('#xcleaner-start');
  const freshStartEl = hud.querySelector('#xcleaner-fresh-start');
  const stopBtn = hud.querySelector('#xcleaner-stop');
  const exportBtn = hud.querySelector('#xcleaner-export');
  const filterBtn = hud.querySelector('#xcleaner-filter');
  const subStatusEl = hud.querySelector('#xcleaner-sub-status');
  const subRefreshBtn = hud.querySelector('#xcleaner-sub-refresh');
  const subSubscribeBtn = hud.querySelector('#xcleaner-subscribe');
  const statusEl = hud.querySelector('#xcleaner-status');
  const busy = !!state.isScraping;
  const filterBusy = !!state.isEnriching || state.reason === 'filtering';
  const canExport = !!state.canExport;

  subStatusEl.textContent = formatHudSubscriptionStatus(state);
  subSubscribeBtn.style.display = state.isSubscribed ? 'none' : 'block';
  subRefreshBtn.disabled = busy;
  subSubscribeBtn.disabled = busy;

  startBtn.style.display = busy ? 'none' : 'block';
  startBtn.disabled = filterBusy;
  if (freshStartEl) freshStartEl.disabled = busy;
  stopBtn.style.display = busy ? 'block' : 'none';
  exportBtn.disabled = count === 0 || busy || !canExport;
  exportBtn.classList.toggle('export-locked', count > 0 && !canExport);
  exportBtn.title = canExport ? 'Download CSV' : 'Export requires @d2fl subscription';
  filterBtn.disabled = count === 0 || busy || filterBusy;

  if (state.error) {
    statusEl.textContent = state.error;
  } else if (state.reason === 'profile-loaded' || state.reason === 'loading-profile') {
    statusEl.textContent = state.status || `Logged in as @${state.username || '—'}`;
  } else if (state.reason === 'waiting-native') {
    statusEl.textContent = state.status || `Waiting for X to load your ${label} list...`;
  } else if (state.reason === 'rate-limited') {
    statusEl.textContent = state.error || 'Rate limited — retrying...';
  } else if (state.reason === 'collecting' && state.status) {
    statusEl.textContent = state.status;
  } else if (state.isScraping) {
    if (state.status) {
      statusEl.textContent = state.status;
    } else {
      const pages = state.pages ? ` • pass ${state.pages}` : '';
      const added = state.addedLastPage != null ? ` • +${state.addedLastPage}` : '';
      statusEl.textContent = `Capturing native ${label} data${pages}${added}`;
    }
  } else if (state.reason === 'filtering') {
    statusEl.textContent = state.status || 'Applying filters...';
  } else if (state.reason === 'enriching' || state.isEnriching) {
    statusEl.textContent = state.status || 'Checking last tweet dates...';
  } else if (state.reason === 'filtered') {
    statusEl.textContent = state.status || `Filtered to ${count.toLocaleString()} accounts.`;
  } else if (state.reason === 'complete') {
    statusEl.textContent = state.status || (state.canExport
      ? 'Complete. Start again, filter, or export CSV any time.'
      : 'Complete (free tier). Filter here; subscribe @d2fl to export.');
  } else if (state.reason === 'exported') {
    statusEl.textContent = `Exported ${count.toLocaleString()} accounts.`;
  } else if (state.reason === 'stopped' && count > 0) {
    statusEl.textContent = 'Stopped. Start again or export CSV any time.';
  } else if (state.restoredFromStorage && count > 0) {
    statusEl.textContent = state.status || 'Restored from memory. Start again, filter, or export.';
  } else if (count > 0) {
    statusEl.textContent = 'Ready to export or start a fresh collection.';
  } else {
    statusEl.textContent = 'Press Start Collection to fetch your list.';
  }

  renderDebugStatusLog(hud, state);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({
      ok: true,
      hudPresent: !!document.getElementById(HUD_ID)
    });
    return true;
  }

  if (message.action === 'showHud') {
    setHudDismissed(false);
    updateHud(message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'hideHud') {
    hideHud();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'updateHud') {
    updateHud(message);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

function syncHudFromBackground() {
  if (isHudDismissed()) return;

  sendToBackground({ action: 'getStatus' }).then((state) => {
    if (!state) return;
    if (isHudDismissed() && !state.isScraping && !(state.debugStatusLog || []).length) return;
    if (
      state.isScraping ||
      state.count > 0 ||
      state.username ||
      state.reason === 'error' ||
      state.reason === 'complete' ||
      state.reason === 'stopped' ||
      state.reason === 'exported' ||
      state.reason === 'filtered' ||
      state.reason === 'filtering' ||
      state.reason === 'enriching' ||
      state.isEnriching ||
      (state.debugStatusLogEnabled && (state.debugStatusLog || []).length > 0)
    ) {
      updateHud(state);
    }
  }).catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncHudFromBackground);
} else {
  syncHudFromBackground();
}