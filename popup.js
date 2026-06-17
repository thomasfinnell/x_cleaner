const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const accountEl = document.getElementById('account');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');

let pollTimer = null;

function formatTotal(total) {
  return total == null ? '—' : total.toLocaleString();
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b00020' : '#222';
}

function renderProgress(state) {
  const count = state.count || 0;
  const total = state.totalFollowing;
  const username = state.username;

  accountEl.textContent = username ? `@${username}` : '@—';
  progressEl.textContent = `${count.toLocaleString()} / ${formatTotal(total)}`;

  startBtn.disabled = !!state.isScraping;
  stopBtn.style.display = state.isScraping ? 'block' : 'none';
  exportBtn.disabled = count === 0;
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
  if (state.reason === 'loading-profile') {
    return state.status || 'Opening your profile to confirm login...';
  }

  if (state.reason === 'profile-loaded' && !state.isScraping) {
    return state.status || `Logged in as @${state.username}. Opening Following...`;
  }

  if (state.reason === 'waiting-native') {
    return state.status || 'Waiting for X native Following responses...';
  }

  if (state.isScraping) {
    return state.status || 'Capturing native Following data. Watch the on-page panel.';
  }

  if (state.reason === 'complete') {
    return 'Collection complete. Export CSV from here or the X page panel.';
  }

  if (state.reason === 'end-of-list') {
    return 'Reached end of list. Export CSV when ready.';
  }

  if (state.reason === 'stopped' && state.count > 0) {
    return 'Collection stopped. Export CSV when ready.';
  }

  if (state.count > 0) {
    return 'Ready to export collected accounts.';
  }

  return 'Capturing native Following data. Progress also appears on the X page panel.';
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

startBtn.addEventListener('click', async () => {
  updateUI({ isScraping: true, count: 0, totalFollowing: null, username: null });
  setStatus('Detecting account, then opening profile and Following page...');
  startPolling();

  const result = await sendBackground('runExportFlow');

  if (!result.ok && !result.isScraping) {
    stopPolling();
    updateUI({
      isScraping: false,
      count: result.count || 0,
      totalFollowing: result.totalFollowing ?? null,
      username: result.username ?? null
    });
    setStatus(result.error || 'Failed to start collection.', true);
    return;
  }

  updateUI({
    isScraping: !!result.isScraping,
    count: result.count || 0,
    totalFollowing: result.totalFollowing,
    username: result.username
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

exportBtn.addEventListener('click', async () => {
  setStatus('Preparing CSV export...');
  const result = await sendBackground('exportCSV');

  if (!result.ok && !result.exported) {
    setStatus(result.error || 'Export failed.', true);
    return;
  }

  updateUI(result);
  setStatus(`Exported ${result.count || 0} accounts.`);
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

refreshStatus().then(() => {
  sendBackground('getJobState').then((state) => {
    if (state.isScraping) startPolling();
  });
});

window.addEventListener('unload', stopPolling);