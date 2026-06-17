// On-page HUD for X Cleaner (collection runs via GraphQL in the background)
const HUD_ID = 'xcleaner-hud';

function formatTotal(total) {
  return total == null ? '—' : total.toLocaleString();
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
        width: 250px;
        background: rgba(0, 0, 0, 0.9);
        color: #fff;
        border: 1px solid #2f3336;
        border-radius: 12px;
        padding: 12px;
        font: 13px/1.4 Arial, sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }
      #${HUD_ID} .xc-title { font-weight: 700; margin-bottom: 4px; }
      #${HUD_ID} .xc-method { color: #8b98a5; font-size: 11px; margin-bottom: 6px; }
      #${HUD_ID} .xc-account { color: #cfd9de; margin-bottom: 4px; }
      #${HUD_ID} .xc-progress { font-size: 22px; font-weight: 700; margin: 8px 0; }
      #${HUD_ID} .xc-status { color: #cfd9de; min-height: 18px; margin-bottom: 8px; }
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
      #${HUD_ID} .xc-export { background: #1d9bf0; color: #fff; }
      #${HUD_ID} button:disabled { opacity: 0.55; cursor: not-allowed; }
    </style>
    <div class="xc-title">X Cleaner</div>
    <div class="xc-method">Native sniffer (captures X's own requests)</div>
    <div class="xc-account" id="xcleaner-account">@—</div>
    <div class="xc-progress" id="xcleaner-progress">0 / —</div>
    <div class="xc-status" id="xcleaner-status">Ready</div>
    <button class="xc-stop" id="xcleaner-stop" style="display:none;">Stop</button>
    <button class="xc-export" id="xcleaner-export">Export CSV</button>
  `;

  document.documentElement.appendChild(hud);

  hud.querySelector('#xcleaner-stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopScrape' }).catch(() => {});
  });

  hud.querySelector('#xcleaner-export').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'exportCSV' }).catch(() => {});
  });

  return hud;
}

function updateHud(state = {}) {
  const hud = ensureHud();
  const count = state.count || 0;

  hud.querySelector('#xcleaner-account').textContent =
    state.username ? `@${state.username}` : '@—';
  hud.querySelector('#xcleaner-progress').textContent =
    `${count.toLocaleString()} / ${formatTotal(state.totalFollowing)}`;

  const stopBtn = hud.querySelector('#xcleaner-stop');
  const exportBtn = hud.querySelector('#xcleaner-export');
  const statusEl = hud.querySelector('#xcleaner-status');

  stopBtn.style.display = state.isScraping ? 'block' : 'none';
  exportBtn.disabled = count === 0;

  if (state.error) {
    statusEl.textContent = state.error;
  } else if (state.reason === 'profile-loaded' || state.reason === 'loading-profile') {
    statusEl.textContent = state.status || `Logged in as @${state.username || '—'}`;
  } else if (state.reason === 'waiting-native') {
    statusEl.textContent = state.status || 'Waiting for X to load your following list...';
  } else if (state.reason === 'rate-limited') {
    statusEl.textContent = state.error || 'Rate limited — retrying...';
  } else if (state.isScraping) {
    if (state.status) {
      statusEl.textContent = state.status;
    } else {
      const pages = state.pages ? ` • pass ${state.pages}` : '';
      const added = state.addedLastPage != null ? ` • +${state.addedLastPage}` : '';
      statusEl.textContent = `Capturing native Following data${pages}${added}`;
    }
  } else if (state.reason === 'complete') {
    statusEl.textContent = 'Complete. Export CSV any time.';
  } else if (state.reason === 'exported') {
    statusEl.textContent = `Exported ${count.toLocaleString()} accounts.`;
  } else if (state.reason === 'stopped' && count > 0) {
    statusEl.textContent = 'Stopped. Export CSV any time.';
  } else if (count > 0) {
    statusEl.textContent = 'Ready to export.';
  } else {
    statusEl.textContent = 'Waiting to start...';
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'showHud') {
    updateHud(message);
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
  chrome.runtime.sendMessage({ action: 'getStatus' }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    if (
      state.isScraping ||
      state.count > 0 ||
      state.username ||
      state.reason === 'error' ||
      state.reason === 'complete' ||
      state.reason === 'exported'
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