// On-page HUD for X Cleaner (collection runs via GraphQL in the background)
const HUD_ID = 'xcleaner-hud';
const HUD_DISMISSED_KEY = 'xc_hud_dismissed';

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
      #${HUD_ID} .xc-status { color: #cfd9de; min-height: 18px; margin-bottom: 8px; }
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
    <button class="xc-start" id="xcleaner-start" type="button">Start Collection</button>
    <button class="xc-stop" id="xcleaner-stop" style="display:none;">Stop</button>
    <div class="xc-filter">
      <div class="xc-filter-title">Pre-export filter</div>
      <label><input type="checkbox" id="xcleaner-remove-blue"> Remove blue</label>
      <label><input type="checkbox" id="xcleaner-remove-new"> Remove new (&lt; 6 months)</label>
      <label><input type="checkbox" id="xcleaner-remove-inactive"> Remove inactive (no tweet &gt; 6 months)</label>
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

  hud.querySelector('#xcleaner-close').addEventListener('click', () => {
    hideHud();
  });

  hud.querySelector('#xcleaner-start').addEventListener('click', () => {
    const listType = selectedHudListType();
    const statusEl = hud.querySelector('#xcleaner-status');
    statusEl.textContent = `Starting ${listLabel(listType).toLowerCase()} collection...`;
    chrome.runtime.sendMessage({ action: 'runExportFlow', listType }).catch(() => {});
  });

  hud.querySelector('#xcleaner-stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopScrape' }).catch(() => {});
  });

  hud.querySelector('#xcleaner-export').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'exportCSV' }).catch(() => {});
  });

  hud.querySelector('#xcleaner-sub-refresh').addEventListener('click', () => {
    const statusEl = hud.querySelector('#xcleaner-status');
    const refreshBtn = hud.querySelector('#xcleaner-sub-refresh');
    refreshBtn.disabled = true;
    statusEl.textContent = 'Refreshing subscription status...';
    chrome.runtime.sendMessage({ action: 'checkSubscription', force: true }, (result) => {
      refreshBtn.disabled = false;
      if (chrome.runtime.lastError) {
        statusEl.textContent = chrome.runtime.lastError.message || 'Refresh failed.';
        return;
      }
      if (result) updateHud(result);
      statusEl.textContent = result?.subscriptionStatus || 'Subscription status updated.';
    });
  });

  hud.querySelector('#xcleaner-subscribe').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openSubscribe' }).catch(() => {});
  });

  hud.querySelector('#xcleaner-filter').addEventListener('click', () => {
    const removeBlue = hud.querySelector('#xcleaner-remove-blue').checked;
    const removeNew = hud.querySelector('#xcleaner-remove-new').checked;
    const removeInactive = hud.querySelector('#xcleaner-remove-inactive').checked;
    chrome.runtime.sendMessage({
      action: 'filterList',
      removeBlue,
      removeNew,
      removeInactive
    }).catch(() => {});
  });

  const modeFollowing = hud.querySelector('#xcleaner-mode-following');
  const modeFollowers = hud.querySelector('#xcleaner-mode-followers');
  modeFollowing.addEventListener('change', () => {
    if (modeFollowing.checked) {
      chrome.runtime.sendMessage({ action: 'setListType', listType: 'following' }).catch(() => {});
    }
  });
  modeFollowers.addEventListener('change', () => {
    if (modeFollowers.checked) {
      chrome.runtime.sendMessage({ action: 'setListType', listType: 'followers' }).catch(() => {});
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
  if (mutuals?.hasBoth) {
    mutualsEl.textContent =
      `Mutuals: ${mutuals.mutualCount.toLocaleString()} (${mutuals.followingCount.toLocaleString()} ∩ ${mutuals.followersCount.toLocaleString()})`;
  } else {
    const stored = state.storedCounts || {};
    const parts = [];
    if (stored.following > 0) parts.push(`${stored.following.toLocaleString()} following saved`);
    if (stored.followers > 0) parts.push(`${stored.followers.toLocaleString()} followers saved`);
    mutualsEl.textContent = parts.join(' • ');
  }

  const startBtn = hud.querySelector('#xcleaner-start');
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
    statusEl.textContent = state.canExport
      ? 'Complete. Start again, filter, or export CSV any time.'
      : (state.status || 'Complete (free tier). Filter here; subscribe @d2fl to export.');
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
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

  chrome.runtime.sendMessage({ action: 'checkSubscription', force: false }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    if (isHudDismissed() && !state.isScraping) return;
    if (
      state.isScraping ||
      state.count > 0 ||
      state.username ||
      state.reason === 'error' ||
      state.reason === 'complete' ||
      state.reason === 'exported' ||
      state.reason === 'filtered' ||
      state.reason === 'filtering' ||
      state.reason === 'enriching' ||
      state.isEnriching
    ) {
      updateHud(state);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncHudFromBackground);
} else {
  syncHudFromBackground();
}