// On-page modal for X Cleaner — full-screen blur + page lock while collecting
var HUD_ID = 'xcleaner-hud';
var HUD_DISMISSED_KEY = 'xc_hud_dismissed';
var HUD_PAGE_BLOCK_CLASS = 'xcleaner-page-blocked';
var hudPageBlockerInstalled = false;
var FILTER_MONTHS_MIN = 1;
var FILTER_MONTHS_MAX = 24;
var FILTER_MONTHS_DEFAULT = 6;
var INACTIVE_MONTHS_PREF_KEY = 'xc_inactive_months_pref';
var FAST_SCROLL_PREF_KEY = 'xc_fast_scroll_pref';
var FAST_SCROLL_WARN = 'Fast mode uses REST bulk + aggressive scrolling and may trigger reduced reach or a shadowban on X. Leave unchecked for observe-only gentle pacing (scroll + sniffer + DOM, no REST bulk).';
var EXT_VERSION = chrome.runtime.getManifest().version || '';
let lastHudDebugStatusLog = [];
let lastHudDebugStatusLogEnabled = true;
let lastHudPayload = {};
let pendingHudListType = null;
let hudCurrentListType = 'following';

function hudPickDebugStatusLog(incoming, cached) {
  if (typeof xcPickDebugStatusLog === 'function') {
    return xcPickDebugStatusLog(incoming, cached);
  }
  const next = Array.isArray(incoming) ? incoming : [];
  const prev = Array.isArray(cached) ? cached : [];
  return next.length >= prev.length ? next : prev;
}

function hudCanViewListPreview(state = {}, type = 'following') {
  if (typeof xcCanViewListPreview === 'function') {
    return xcCanViewListPreview(state, type);
  }
  const count = hudCountForListType(state, type);
  if (count > 0) return true;
  const stored = state.storedCounts || {};
  if ((stored.following || 0) > 0 || (stored.followers || 0) > 0) return true;
  if (state.canExport === false) return true;
  return (state.count || 0) > 0;
}

function hudRawCountForListType(state = {}, type = 'following') {
  if (typeof xcRawCountForListType === 'function') {
    return xcRawCountForListType(state, type);
  }
  const stats = state.listStats || {};
  const typeStats = type === 'followers' ? stats.followers : stats.following;
  const activeType = state.listType || type;
  const raw = Number(typeStats?.rawCount);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (activeType === type) {
    const stateRaw = Number(state.rawCount);
    if (Number.isFinite(stateRaw) && stateRaw > 0) return stateRaw;
  }
  return hudCountForListType(state, type);
}

function hudCountForListType(state = {}, type = 'following') {
  if (typeof xcCountForListType === 'function') {
    return xcCountForListType(state, type);
  }
  const stats = state.listStats || {};
  const stored = state.storedCounts || {};
  const typeStats = type === 'followers' ? stats.followers : stats.following;
  const activeType = state.listType || type;
  const candidates = [
    typeStats?.count,
    stored[type],
    activeType === type ? state.count : null,
    activeType === type ? state.rawCount : null
  ];
  let best = 0;
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > best) best = n;
  }
  if (best > 0) return best;
  if (typeStats?.count != null) return typeStats.count;
  if (stored[type] != null) return stored[type];
  if (activeType === type && state.count != null) return state.count;
  return 0;
}

function hudOpenListPreview(listType) {
  const fetchPreview = (type) => sendToBackground({ action: 'getListPreview', listType: type });
  if (typeof xcOpenListPreview === 'function') {
    xcOpenListPreview(fetchPreview, listType);
    return;
  }
  fetchPreview(listType).then((payload) => {
    if (!payload?.ok) {
      window.alert(payload?.error || 'Could not load list preview.');
    }
  }).catch(() => {});
}

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

function isHudBlockingState(state = {}) {
  return !!(
    state.isScraping
    || state.isEnriching
    || state.reason === 'filtering'
    || state.reason === 'loading-profile'
    || state.reason === 'waiting-native'
    || state.reason === 'collecting'
    || state.reason === 'profile-loaded'
  );
}

function flashBlockingNotice(hud) {
  const notice = hud?.querySelector('#xcleaner-blocking-notice');
  if (!notice) return;
  notice.hidden = false;
  notice.classList.add('is-flash');
  clearTimeout(flashBlockingNotice._timer);
  flashBlockingNotice._timer = setTimeout(() => {
    notice.classList.remove('is-flash');
  }, 1400);
}

function setHudBlockingMode(hud, blocking) {
  if (!hud) return;
  hud.classList.toggle('is-blocking', blocking);
  document.documentElement.classList.toggle(HUD_PAGE_BLOCK_CLASS, blocking);
  const closeBtn = hud.querySelector('#xcleaner-close');
  if (closeBtn) closeBtn.style.display = blocking ? 'none' : '';
  const notice = hud.querySelector('#xcleaner-blocking-notice');
  if (notice) notice.hidden = !blocking;
  if (!blocking) notice?.classList.remove('is-flash');
}

function installHudPageBlocker(hud) {
  if (hudPageBlockerInstalled || !hud) return;
  hudPageBlockerInstalled = true;

  const blockOutside = (event) => {
    if (!hud.classList.contains('is-blocking')) return;
    const panel = hud.querySelector('.xc-panel');
    if (panel && (panel === event.target || panel.contains(event.target))) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    flashBlockingNotice(hud);
    return false;
  };

  for (const type of ['pointerdown', 'click', 'mousedown', 'touchstart', 'keydown', 'wheel']) {
    document.addEventListener(type, blockOutside, true);
  }

  hud.querySelector('.xc-backdrop')?.addEventListener('click', () => {
    if (hud.classList.contains('is-blocking')) flashBlockingNotice(hud);
  });
}

async function hideHud() {
  try {
    const result = await sendToBackground({ action: 'dismissHud' });
    if (result?.ok === false) {
      setHudDismissed(false);
      const statusEl = document.getElementById(HUD_ID)?.querySelector('#xcleaner-status');
      if (statusEl) statusEl.textContent = 'Could not stop collection — use Stop or reload the extension.';
      return;
    }
  } catch (error) {
    setHudDismissed(false);
    const statusEl = document.getElementById(HUD_ID)?.querySelector('#xcleaner-status');
    if (statusEl) statusEl.textContent = 'Extension unreachable — collection may still be running.';
    return;
  }

  setHudDismissed(true);
  const hud = document.getElementById(HUD_ID);
  if (hud) {
    setHudBlockingMode(hud, false);
    hud.remove();
  }
  document.documentElement.classList.remove(HUD_PAGE_BLOCK_CLASS);
}

function selectedHudListType() {
  const followers = document.getElementById('xcleaner-mode-followers');
  return followers?.checked ? 'followers' : 'following';
}

function wireHudStatusLogClick(hud) {
  const hudStatusLogEl = hud.querySelector('#xcleaner-status-log');
  if (!hudStatusLogEl || hudStatusLogEl.dataset.copyWired === '1') return;
  hudStatusLogEl.dataset.copyWired = '1';
  hudStatusLogEl.addEventListener('click', async () => {
    const text = hudStatusLogEl.textContent || '';
    if (!text || text.startsWith('(waiting')) return;
    const statusEl = hud.querySelector('#xcleaner-status');
    try {
      await navigator.clipboard.writeText(text);
      if (statusEl) statusEl.textContent = 'Status log copied to clipboard.';
    } catch (error) {
      if (statusEl) statusEl.textContent = 'Could not copy log — select text and copy manually.';
    }
  });
}

function ensureHudStatusLogElements(hud) {
  if (hud.querySelector('#xcleaner-status-log')) {
    wireHudStatusLogClick(hud);
    return;
  }
  const statusEl = hud.querySelector('#xcleaner-status');
  if (!statusEl) return;
  const label = document.createElement('div');
  label.className = 'xc-status-log-label';
  label.id = 'xcleaner-status-log-label';
  label.textContent = 'Status log';
  const log = document.createElement('div');
  log.className = 'xc-status-log';
  log.id = 'xcleaner-status-log';
  log.title = 'Click to copy status log';
  statusEl.insertAdjacentElement('afterend', label);
  label.insertAdjacentElement('afterend', log);
  wireHudStatusLogClick(hud);
}

function ensureHud() {
  let hud = document.getElementById(HUD_ID);
  if (hud && !hud.querySelector('.xc-panel')) {
    hud.remove();
    hud = null;
  }
  if (hud) {
    const titleEl = hud.querySelector('.xc-title');
    if (titleEl && EXT_VERSION) {
      titleEl.textContent = `X Cleaner v${EXT_VERSION}`;
    }
    ensureHudStatusLogElements(hud);
    installHudPageBlocker(hud);
    return hud;
  }

  hud = document.createElement('div');
  hud.id = HUD_ID;
  hud.innerHTML = `
    <style>
      html.${HUD_PAGE_BLOCK_CLASS},
      html.${HUD_PAGE_BLOCK_CLASS} body {
        overflow: hidden !important;
      }
      #${HUD_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px 16px;
        pointer-events: none;
        font: 13px/1.4 Arial, sans-serif;
        color: #fff;
      }
      #${HUD_ID} .xc-backdrop {
        position: absolute;
        inset: 0;
        pointer-events: auto;
        background: transparent;
        transition: background 0.2s ease, backdrop-filter 0.2s ease;
      }
      #${HUD_ID}.is-blocking .xc-backdrop {
        background: rgba(15, 20, 25, 0.62);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      #${HUD_ID} .xc-panel {
        position: relative;
        z-index: 1;
        pointer-events: auto;
        width: min(420px, 100%);
        max-height: min(92vh, 920px);
        overflow-x: hidden;
        overflow-y: auto;
        background: rgba(0, 0, 0, 0.94);
        border: 1px solid #2f3336;
        border-radius: 16px;
        padding: 14px 14px 12px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      }
      #${HUD_ID} .xc-blocking-notice {
        margin: 0 0 10px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(29, 155, 240, 0.45);
        background: rgba(29, 155, 240, 0.12);
        color: #8ecdf8;
        font-size: 11px;
        line-height: 1.4;
        font-weight: 700;
      }
      #${HUD_ID} .xc-blocking-notice.is-flash {
        border-color: #ffd400;
        background: rgba(255, 212, 0, 0.14);
        color: #ffe58f;
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
      #${HUD_ID} .xc-method { display: none; }
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
      #${HUD_ID} .xc-view {
        background: #38444d;
        color: #fff;
        border: 1px solid #536471;
      }
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
      #${HUD_ID} .xc-import {
        margin: 8px 0 0;
        padding: 8px;
        border: 1px solid #2f3336;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.04);
      }
      #${HUD_ID} .xc-import-title {
        font-size: 11px;
        font-weight: 700;
        color: #8b98a5;
        margin-bottom: 6px;
      }
      #${HUD_ID} .xc-import label {
        display: block;
        font-size: 11px;
        margin: 3px 0;
        color: #cfd9de;
      }
      #${HUD_ID} .xc-import-actions {
        display: flex;
        gap: 6px;
        margin-top: 6px;
      }
      #${HUD_ID} .xc-import-actions button {
        flex: 1;
        margin: 0;
        padding: 7px 6px;
        font-size: 11px;
        background: #536471;
        color: #fff;
      }
      #${HUD_ID} .xc-import-hint {
        margin-top: 6px;
        font-size: 10px;
        color: #8b98a5;
        line-height: 1.35;
        min-height: 12px;
      }
      #${HUD_ID} .xc-fast-scroll {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 700;
        color: #cfd9de;
      }
      #${HUD_ID} .xc-fast-toast {
        margin: 0 0 8px;
        padding: 8px;
        border-radius: 8px;
        background: rgba(255, 196, 77, 0.15);
        border: 1px solid rgba(245, 194, 107, 0.55);
        color: #ffd400;
        font-size: 10px;
        line-height: 1.4;
      }
      #${HUD_ID} .xc-fast-toast[hidden] { display: none; }
      #${HUD_ID} .xc-list-cards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin: 0 0 8px;
      }
      #${HUD_ID} .xc-list-card {
        border: 1px solid #2f3336;
        border-radius: 8px;
        padding: 7px 8px;
        background: rgba(255, 255, 255, 0.04);
        cursor: pointer;
      }
      #${HUD_ID} .xc-list-card.active {
        border-color: #1d9bf0;
        background: rgba(29, 155, 240, 0.12);
        box-shadow: inset 0 0 0 1px #1d9bf0;
      }
      #${HUD_ID} .xc-list-card-title {
        font-size: 10px;
        font-weight: 700;
        color: #8b98a5;
        margin-bottom: 3px;
      }
      #${HUD_ID} .xc-list-card-count {
        font-size: 16px;
        font-weight: 700;
        color: #fff;
        line-height: 1.2;
      }
    </style>
    <div class="xc-backdrop" aria-hidden="true"></div>
    <div class="xc-panel" role="dialog" aria-modal="true" aria-labelledby="xcleaner-title">
    <div class="xc-blocking-notice" id="xcleaner-blocking-notice" hidden>
      Collection in progress — X is locked. Press Stop to cancel, or wait until complete.
    </div>
    <div class="xc-header">
      <div class="xc-title" id="xcleaner-title">X Cleaner${EXT_VERSION ? ` v${EXT_VERSION}` : ''}</div>
      <button class="xc-close" id="xcleaner-close" type="button" title="Close panel" aria-label="Close panel">×</button>
    </div>
    <label class="xc-fast-scroll" title="Fast uses aggressive scrolling and may reduce reach on X">
      <input type="checkbox" id="xcleaner-fast-scroll">
      Fast
    </label>
    <div class="xc-fast-toast" id="xcleaner-fast-toast" hidden></div>
    <div class="xc-toggle">
      <label><input type="radio" name="xc-list-type" id="xcleaner-mode-following" value="following" checked>Following</label>
      <label><input type="radio" name="xc-list-type" id="xcleaner-mode-followers" value="followers">Followers</label>
    </div>
    <div class="xc-list-cards">
      <div class="xc-list-card active" id="xcleaner-following-card" data-type="following">
        <div class="xc-list-card-title">Following</div>
        <div class="xc-list-card-count" id="xcleaner-following-count">0 / —</div>
      </div>
      <div class="xc-list-card" id="xcleaner-followers-card" data-type="followers">
        <div class="xc-list-card-title">Followers</div>
        <div class="xc-list-card-count" id="xcleaner-followers-count">0 / —</div>
      </div>
    </div>
    <div class="xc-method" id="xcleaner-method">Native sniffer (captures X's own requests)</div>
    <div class="xc-account" id="xcleaner-account">@—</div>
    <div class="xc-mutuals" id="xcleaner-mutuals"></div>
    <div class="xc-status" id="xcleaner-status">Ready</div>
    <div class="xc-status-log-label" id="xcleaner-status-log-label">Status log</div>
    <div class="xc-status-log" id="xcleaner-status-log" title="Click to copy status log"></div>
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
      <label class="xc-months-filter" title="Following only: keeps accounts older than N months with no recent posts. Filters by account age first, then checks last tweet slowly.">
        <input type="checkbox" id="xcleaner-remove-inactive">
        <span>Last post &gt;</span>
        <span class="xc-months-stepper">
          <button type="button" id="xcleaner-inactive-months-dec" aria-label="Decrease months">−</button>
          <input type="number" id="xcleaner-inactive-months" value="6" min="1" max="24" step="1" aria-label="Last post months">
          <button type="button" id="xcleaner-inactive-months-inc" aria-label="Increase months">+</button>
        </span>
        <span>months</span>
      </label>
      <label title="Followers only: keep potential bots you do not follow. Skips accounts you follow (you_follow from Followers REST, or Following list if fetched). Signals: &lt;10 tweets, default avatar, no bio, account &lt;30 days, @handle ending with &gt;4 digits, followers &gt;2× following.">
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
    <button class="xc-view" id="xcleaner-view" type="button" title="Preview first 5/10 records in the active list (more for subscribers)">View</button>
    <button class="xc-export" id="xcleaner-export" title="Download CSV">Export CSV</button>
    <div class="xc-import">
      <div class="xc-import-title">Load CSV</div>
      <label><input type="radio" name="xc-import-mode" id="xcleaner-import-replace" value="replace" checked> Replace list</label>
      <label><input type="radio" name="xc-import-mode" id="xcleaner-import-append" value="append"> Append (dedupe)</label>
      <div class="xc-import-actions">
        <button type="button" id="xcleaner-load-following">Load Following</button>
        <button type="button" id="xcleaner-load-followers">Load Followers</button>
      </div>
      <input id="xcleaner-import-following-input" type="file" accept=".csv,text/csv" hidden>
      <input id="xcleaner-import-followers-input" type="file" accept=".csv,text/csv" hidden>
      <div class="xc-import-hint" id="xcleaner-import-info">X Cleaner export or one handle per line. Free tier: 200 records max.</div>
    </div>
    </div>
  `;

  document.documentElement.appendChild(hud);
  installHudPageBlocker(hud);
  wireHudFilterMonthSteppers(hud);

  wireHudStatusLogClick(hud);

  const fastScrollEl = hud.querySelector('#xcleaner-fast-scroll');
  const fastScrollToastEl = hud.querySelector('#xcleaner-fast-toast');
  let fastScrollToastTimer = null;

  const showHudFastScrollWarning = () => {
    if (!fastScrollToastEl) return;
    fastScrollToastEl.textContent = FAST_SCROLL_WARN;
    fastScrollToastEl.hidden = false;
    clearTimeout(fastScrollToastTimer);
    fastScrollToastTimer = setTimeout(() => {
      fastScrollToastEl.hidden = true;
    }, 8000);
  };

  const hideHudFastScrollWarning = () => {
    if (!fastScrollToastEl) return;
    fastScrollToastEl.hidden = true;
    clearTimeout(fastScrollToastTimer);
  };

  if (isExtensionContextValid()) {
    chrome.storage.local.get(FAST_SCROLL_PREF_KEY, (res) => {
      if (chrome.runtime.lastError || !fastScrollEl) return;
      fastScrollEl.checked = !!res[FAST_SCROLL_PREF_KEY];
    });
  }

  fastScrollEl?.addEventListener('change', async () => {
    const enabled = !!fastScrollEl.checked;
    if (enabled) {
      showHudFastScrollWarning();
    } else {
      hideHudFastScrollWarning();
    }
    const result = await sendToBackground({ action: 'setFastScroll', fastScroll: enabled });
    if (result?.ok !== false) updateHud(result);
  });

  hud.querySelector('#xcleaner-close').addEventListener('click', () => {
    if (hud.classList.contains('is-blocking')) {
      const statusEl = hud.querySelector('#xcleaner-status');
      if (statusEl) statusEl.textContent = 'Stopping collection before close...';
    }
    void hideHud();
  });

  hud.querySelector('#xcleaner-start').addEventListener('click', async () => {
    const listType = selectedHudListType();
    const forceRefresh = !!hud.querySelector('#xcleaner-fresh-start')?.checked;
    const fastScroll = !!hud.querySelector('#xcleaner-fast-scroll')?.checked;
    const statusEl = hud.querySelector('#xcleaner-status');
    const startBtn = hud.querySelector('#xcleaner-start');
    if (startBtn) startBtn.disabled = true;
    statusEl.textContent = forceRefresh
      ? `Fresh start — clearing cached ${listLabel(listType).toLowerCase()}...`
      : `Starting ${listLabel(listType).toLowerCase()} collection...`;
    try {
      const result = await sendToBackground({
        action: 'runExportFlow',
        listType,
        forceRefresh,
        fastScroll,
        fetchMode: 'auto'
      });
      if (result?.ok === false) {
        statusEl.textContent = result?.error || 'Could not start collection.';
        if (startBtn) startBtn.disabled = false;
        return;
      }
      if (result) updateHud(result);
    } catch (error) {
      statusEl.textContent = String(error?.message || error || 'Could not start collection.');
      if (startBtn) startBtn.disabled = false;
    }
  });

  hud.querySelector('#xcleaner-stop').addEventListener('click', async () => {
    const result = await sendToBackground({ action: 'stopScrape' });
    if (result) updateHud(result);
    const refreshed = await sendToBackground({ action: 'getStatus' });
    if (refreshed) updateHud(refreshed);
  });

  hud.querySelector('#xcleaner-view')?.addEventListener('click', () => {
    hudOpenListPreview(selectedHudListType());
  });

  hud.querySelector('#xcleaner-export').addEventListener('click', async () => {
    const exportBtn = hud.querySelector('#xcleaner-export');
    const statusEl = hud.querySelector('#xcleaner-status');
    if (exportBtn.disabled) return;
    exportBtn.disabled = true;
    const result = await sendToBackground({
      action: 'exportCSV',
      listType: selectedHudListType()
    });
    if (result?.ok) {
      updateHud(result);
      if (result.status) statusEl.textContent = result.status;
      return;
    }
    exportBtn.disabled = false;
    statusEl.textContent = result?.error || 'Export failed.';
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

  hud.querySelector('#xcleaner-filter').addEventListener('click', async () => {
    const filterBtn = hud.querySelector('#xcleaner-filter');
    const statusEl = hud.querySelector('#xcleaner-status');
    const removeMutuals = hud.querySelector('#xcleaner-remove-mutuals').checked;
    const removeBlue = hud.querySelector('#xcleaner-remove-blue').checked;
    const removeInactive = hud.querySelector('#xcleaner-remove-inactive').checked;
    const botCheck = hud.querySelector('#xcleaner-bot-check').checked;
    filterBtn.disabled = true;
    statusEl.textContent = 'Applying filters...';
    try {
      const result = await sendToBackground({
        action: 'filterList',
        listType: selectedHudListType(),
        removeMutuals,
        removeBlue,
        removeInactive,
        botCheck,
        inactiveMonths: readHudFilterMonths(hud, '#xcleaner-inactive-months')
      });
      if (!result) {
        statusEl.textContent = isExtensionContextValid()
          ? 'Filter failed — no response from extension.'
          : 'Extension reloaded — refresh this X tab, then try again.';
        return;
      }
      updateHud(result);
      if (result.error) {
        statusEl.textContent = result.error;
      }
    } catch (error) {
      statusEl.textContent = String(error?.message || error || 'Filter failed.');
    } finally {
      const refreshed = await sendToBackground({ action: 'getStatus' });
      if (refreshed) updateHud(refreshed);
    }
  });

  const modeFollowing = hud.querySelector('#xcleaner-mode-following');
  const modeFollowers = hud.querySelector('#xcleaner-mode-followers');
  modeFollowing.addEventListener('change', () => {
    if (!modeFollowing.checked) return;
    switchHudListType(hud, 'following');
  });
  modeFollowers.addEventListener('change', () => {
    if (!modeFollowers.checked) return;
    switchHudListType(hud, 'followers');
  });
  hud.querySelector('#xcleaner-following-card')?.addEventListener('click', () => {
    switchHudListType(hud, 'following');
  });
  hud.querySelector('#xcleaner-followers-card')?.addEventListener('click', () => {
    switchHudListType(hud, 'followers');
  });

  const selectedHudImportMode = () => (
    hud.querySelector('#xcleaner-import-replace')?.checked ? 'replace' : 'append'
  );

  async function handleHudCsvImport(listType, file) {
    if (!file) return;
    const statusEl = hud.querySelector('#xcleaner-status');
    const infoEl = hud.querySelector('#xcleaner-import-info');
    const loadFollowingBtn = hud.querySelector('#xcleaner-load-following');
    const loadFollowersBtn = hud.querySelector('#xcleaner-load-followers');
    loadFollowingBtn.disabled = true;
    loadFollowersBtn.disabled = true;
    statusEl.textContent = `Loading ${listLabel(listType).toLowerCase()} CSV...`;
    try {
      const csvText = await file.text();
      const result = await sendToBackground({
        action: 'loadListCsv',
        listType,
        csvText,
        mode: selectedHudImportMode()
      });
      if (result?.ok !== false && (result.ok || result.count > 0)) {
        updateHud(result);
        if (infoEl) {
          infoEl.textContent = result.status || `Loaded ${(result.importLoaded || result.count || 0).toLocaleString()} ${listLabel(listType).toLowerCase()}.`;
        }
        return;
      }
      statusEl.textContent = result?.error || 'CSV import failed.';
    } catch (error) {
      statusEl.textContent = String(error?.message || error || 'CSV import failed.');
    } finally {
      loadFollowingBtn.disabled = false;
      loadFollowersBtn.disabled = false;
    }
  }

  hud.querySelector('#xcleaner-load-following')?.addEventListener('click', () => {
    hud.querySelector('#xcleaner-import-following-input')?.click();
  });
  hud.querySelector('#xcleaner-load-followers')?.addEventListener('click', () => {
    hud.querySelector('#xcleaner-import-followers-input')?.click();
  });
  hud.querySelector('#xcleaner-import-following-input')?.addEventListener('change', async () => {
    const input = hud.querySelector('#xcleaner-import-following-input');
    const file = input?.files?.[0];
    if (input) input.value = '';
    await handleHudCsvImport('following', file);
  });
  hud.querySelector('#xcleaner-import-followers-input')?.addEventListener('change', async () => {
    const input = hud.querySelector('#xcleaner-import-followers-input');
    const file = input?.files?.[0];
    if (input) input.value = '';
    await handleHudCsvImport('followers', file);
  });

  hud.dataset.xcWired = '1';
  return hud;
}

function listLabel(type) {
  return type === 'followers' ? 'Followers' : 'Following';
}

function isListTypeLocked(state = {}) {
  return !!state.listTypeLocked;
}

function syncHudListTypeUi(hud, type = 'following') {
  hud.querySelector('#xcleaner-mode-following').checked = type !== 'followers';
  hud.querySelector('#xcleaner-mode-followers').checked = type === 'followers';
  hud.querySelector('#xcleaner-following-card')?.classList.toggle('active', type !== 'followers');
  hud.querySelector('#xcleaner-followers-card')?.classList.toggle('active', type === 'followers');

  // Last post filter only for following; bot check only for followers
  const inactiveLabel = hud.querySelector('#xcleaner-remove-inactive')?.closest('label');
  const inactiveChk = hud.querySelector('#xcleaner-remove-inactive');
  const isFollowing = type === 'following';
  if (inactiveChk) {
    inactiveChk.disabled = !isFollowing;
    if (!isFollowing) inactiveChk.checked = false;
  }
  if (inactiveLabel) {
    inactiveLabel.style.opacity = isFollowing ? '' : '0.5';
    if (!isFollowing) {
      const stepper = inactiveLabel.querySelector('.xc-months-stepper');
      if (stepper) stepper.style.pointerEvents = 'none';
    }
  }

  const botChk = hud.querySelector('#xcleaner-bot-check');
  const isFollowers = type === 'followers';
  if (botChk) {
    botChk.disabled = !isFollowers;
    if (!isFollowers) botChk.checked = false;
  }
  // ensure bot label also reflects
  const botLabel = botChk?.closest('label');
  if (botLabel) {
    botLabel.style.opacity = isFollowers ? '' : '0.5';
  }
}

async function switchHudListType(hud, nextType) {
  if (nextType === (pendingHudListType || hudCurrentListType)) return;
  const modeFollowing = hud.querySelector('#xcleaner-mode-following');
  const modeFollowers = hud.querySelector('#xcleaner-mode-followers');
  if (modeFollowing?.disabled || modeFollowers?.disabled) return;

  pendingHudListType = nextType;
  syncHudListTypeUi(hud, nextType);
  const result = await sendToBackground({ action: 'setListType', listType: nextType });
  pendingHudListType = null;
  if (result?.ok !== false) {
    hudCurrentListType = result.listType || nextType;
    updateHud(result);
    return;
  }
  syncHudListTypeUi(hud, hudCurrentListType);
  if (result?.error) {
    hud.querySelector('#xcleaner-status').textContent = result.error;
  }
}

function formatHudSubscriptionStatus(state) {
  if (state.subscriptionStatus) return state.subscriptionStatus;
  const handle = state.username ? `@${state.username}` : '(not detected)';
  const freeLimit = state.freeFetchLimit || 200;
  if (state.isSubscribed) {
    if (state.subscriptionSource === 'owner') {
      return `Owner account — unlimited fetch & export (${handle})`;
    }
    if (state.subscriptionSource === 'x-creator') {
      return `Subscribed to @d2fl on X — unlimited fetch & export (${handle})`;
    }
    return `Subscribed — unlimited fetch & export (${handle})`;
  }
  if (state.freeTierResetsAt) {
    return `Free — up to ${freeLimit} records per 24h (fetch & export) • resets ${new Date(state.freeTierResetsAt).toLocaleString()} (${handle})`;
  }
  return `Free — up to ${freeLimit} records per 24h (fetch & export) (${handle})`;
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

  if (state.debugStatusLogEnabled != null) {
    lastHudDebugStatusLogEnabled = !!state.debugStatusLogEnabled;
  }
  const merged = hudPickDebugStatusLog(state.debugStatusLog, lastHudDebugStatusLog);
  if (merged.length) {
    lastHudDebugStatusLog = merged;
  }
  const enabled = state.debugStatusLogEnabled != null
    ? !!state.debugStatusLogEnabled
    : lastHudDebugStatusLogEnabled;
  const lines = merged;
  const showLog = enabled;
  logEl.classList.toggle('is-visible', showLog);
  labelEl.classList.toggle('is-visible', showLog);
  if (!showLog) {
    logEl.textContent = '';
    return;
  }

  logEl.textContent = lines.length ? lines.join('\n') : '(waiting for status updates...)';
  logEl.scrollTop = logEl.scrollHeight;
}

function hudFormatListTotal(total) {
  if (total == null || total === '') return '—';
  const num = Number(total);
  return Number.isFinite(num) ? num.toLocaleString() : '—';
}

function updateHud(state = {}) {
  if (isHudDismissed()) return;

  const merged = {
    ...lastHudPayload,
    ...state,
    listStats: state.listStats || lastHudPayload.listStats,
    storedCounts: state.storedCounts || lastHudPayload.storedCounts,
    mutuals: state.mutuals || lastHudPayload.mutuals
  };
  lastHudPayload = merged;
  state = merged;

  const hud = ensureHud();
  const count = state.count || 0;
  const type = state.listType || hudCurrentListType || 'following';
  hudCurrentListType = type;
  const uiType = pendingHudListType || type;
  const label = listLabel(type).toLowerCase();


  const fastScrollEl = hud.querySelector('#xcleaner-fast-scroll');
  if (fastScrollEl && state.fastScroll != null && fastScrollEl.checked !== !!state.fastScroll) {
    fastScrollEl.checked = !!state.fastScroll;
  }
  syncHudListTypeUi(hud, uiType);
  const listLocked = isListTypeLocked(state);
  hud.querySelector('#xcleaner-mode-following').disabled = listLocked;
  hud.querySelector('#xcleaner-mode-followers').disabled = listLocked;

  hud.querySelector('#xcleaner-account').textContent =
    state.username ? `@${state.username}` : '@—';

  const stats = state.listStats || {};
  const stored = state.storedCounts || {};
  const following = stats.following || {
    count: stored.following || 0,
    total: state.totalFollowing ?? null
  };
  const followers = stats.followers || {
    count: stored.followers || 0,
    total: state.totalFollowers ?? null
  };
  hud.querySelector('#xcleaner-following-count').textContent =
    `${(following.count || 0).toLocaleString()} / ${hudFormatListTotal(following.total)}`;
  hud.querySelector('#xcleaner-followers-count').textContent =
    `${(followers.count || 0).toLocaleString()} / ${hudFormatListTotal(followers.total)}`;
  const mutualsEl = hud.querySelector('#xcleaner-mutuals');
  const mutuals = state.mutuals;
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
  mutualsEl.textContent = mutualLine || '';

  const startBtn = hud.querySelector('#xcleaner-start');
  const freshStartEl = hud.querySelector('#xcleaner-fresh-start');
  const stopBtn = hud.querySelector('#xcleaner-stop');
  const viewBtn = hud.querySelector('#xcleaner-view');
  const exportBtn = hud.querySelector('#xcleaner-export');
  const filterBtn = hud.querySelector('#xcleaner-filter');
  const subStatusEl = hud.querySelector('#xcleaner-sub-status');
  const subRefreshBtn = hud.querySelector('#xcleaner-sub-refresh');
  const subSubscribeBtn = hud.querySelector('#xcleaner-subscribe');
  const statusEl = hud.querySelector('#xcleaner-status');
  const busy = !!state.isScraping;
  const filterBusy = !!state.isEnriching || state.reason === 'filtering';
  let subText = formatHudSubscriptionStatus(state);
  if (state.sniffFailed && state.sniffError) {
    subText += ` — ⚠ ${state.sniffError}`;
  }
  subStatusEl.textContent = subText;
  subStatusEl.style.color = state.sniffFailed && state.sniffError ? '#ffd400' : '';
  subSubscribeBtn.style.display = state.isSubscribed ? 'none' : 'block';
  subRefreshBtn.disabled = busy;
  subSubscribeBtn.disabled = busy;

  startBtn.style.display = busy ? 'none' : 'block';
  startBtn.disabled = filterBusy;
  if (freshStartEl) freshStartEl.disabled = busy;
  if (fastScrollEl) fastScrollEl.disabled = busy;
  stopBtn.style.display = busy ? 'block' : 'none';
  const hudType = pendingHudListType || selectedHudListType();
  const previewCount = hudCountForListType(state, hudType);
  const canView = hudCanViewListPreview(state, hudType);
  const isNonFree = !!state.isSubscribed || state.canExport === true;
  const previewRowsLabel = isNonFree ? '10' : '5';
  const freeNote = isNonFree ? '' : ' (free — up to 5 rows)';
  if (viewBtn) {
    viewBtn.disabled = !canView;
    viewBtn.title = canView
      ? previewCount > 0
        ? busy
          ? `Preview first ${previewRowsLabel} ${listLabel(hudType).toLowerCase()} (${previewCount.toLocaleString()} loaded so far)`
          : `Preview first ${previewRowsLabel} ${listLabel(hudType).toLowerCase()} records`
        : `Preview first ${previewRowsLabel} ${listLabel(hudType).toLowerCase()}${freeNote}`
      : 'Collect or import a list first';
  }
  exportBtn.disabled = count === 0 || busy;
  exportBtn.classList.remove('export-locked');
  exportBtn.title = count > 0
    ? `Download CSV (${count.toLocaleString()} records${state.fetchLimit != null ? `, free max ${state.fetchLimit}` : ''})`
    : 'Collect or import a list first';
  const filterSourceCount = hudRawCountForListType(state, hudType);
  const canFilter = filterSourceCount > 0;
  filterBtn.disabled = !canFilter || busy || filterBusy;
  filterBtn.title = canFilter
    ? count === 0
      ? `Re-filter from ${filterSourceCount.toLocaleString()} collected ${listLabel(hudType).toLowerCase()} (current filter removed all)`
      : `Filter ${listLabel(hudType).toLowerCase()} (${count.toLocaleString()} shown / ${filterSourceCount.toLocaleString()} collected)`
    : 'Collect or import a list first';
  const importBusy = busy || filterBusy;
  const loadFollowingBtn = hud.querySelector('#xcleaner-load-following');
  const loadFollowersBtn = hud.querySelector('#xcleaner-load-followers');
  if (loadFollowingBtn) loadFollowingBtn.disabled = importBusy;
  if (loadFollowersBtn) loadFollowersBtn.disabled = importBusy;

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
    statusEl.textContent = state.status || 'Complete. Start again, filter, or export CSV any time.';
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
  setHudBlockingMode(hud, isHudBlockingState(state));
}

if (!globalThis.__xcCleanerMessageHooked) {
  globalThis.__xcCleanerMessageHooked = true;
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
      void hideHud().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message.action === 'updateHud') {
      updateHud(message);
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
}

function syncHudFromBackground() {
  if (isHudDismissed()) return;

  sendToBackground({ action: 'getStatus' }).then((state) => {
    if (!state) return;
    if (isHudDismissed() && !state.isScraping && !(state.debugStatusLog || []).length) return;
    const stored = state.storedCounts || {};
    const hasStoredList =
      (stored.following || 0) > 0 ||
      (stored.followers || 0) > 0 ||
      (state.listStats?.following?.count || 0) > 0 ||
      (state.listStats?.followers?.count || 0) > 0;
    if (
      state.isScraping ||
      state.count > 0 ||
      hasStoredList ||
      state.username ||
      state.reason === 'error' ||
      state.reason === 'complete' ||
      state.reason === 'stopped' ||
      (state.debugStatusLog || []).length > 0 ||
      state.reason === 'exported' ||
      state.reason === 'filtered' ||
      state.reason === 'filtering' ||
      state.reason === 'enriching' ||
      state.isEnriching ||
      state.debugStatusLogEnabled
    ) {
      updateHud(state);
    }
  }).catch(() => {});
}

if (!globalThis.__xcCleanerDomSynced) {
  globalThis.__xcCleanerDomSynced = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncHudFromBackground);
  } else {
    syncHudFromBackground();
  }
}