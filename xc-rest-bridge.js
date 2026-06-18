// xc-rest-bridge.js — sync captured bearer/csrf from page session into extension storage (isolated world)
(function () {
  const BEARER_KEY = 'xc_rest_bearer_token';
  const CSRF_KEY = 'xc_rest_csrf_token';
  const SYNC_KEY = 'xc_rest_session_synced_at';

  function readCt0() {
    try {
      const match = document.cookie.match(/(?:^|; )ct0=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (error) {
      return '';
    }
  }

  function readBearer() {
    try {
      const fromSession = sessionStorage.getItem('xc_captured_bearer');
      if (fromSession && fromSession.length > 20) return fromSession;
      const fromLocal = localStorage.getItem('xc_captured_bearer');
      if (fromLocal && fromLocal.length > 20) return fromLocal;
    } catch (error) {}
    return '';
  }

  function syncRestSession(force = false) {
    const bearer = readBearer();
    const ct0 = readCt0();
    if (!bearer) return;

    const now = Date.now();
    try {
      const last = Number(localStorage.getItem(SYNC_KEY) || 0);
      if (!force && now - last < 1500) return;
      localStorage.setItem(SYNC_KEY, String(now));
    } catch (error) {}

    const payload = {
      [BEARER_KEY]: bearer,
      [CSRF_KEY]: ct0 || null,
      xc_rest_session_synced_at: now
    };

    try {
      chrome.storage.local.set(payload);
    } catch (error) {}
  }

  syncRestSession(true);
  setInterval(() => syncRestSession(false), 2000);

  window.addEventListener('xc-rest-session', () => syncRestSession(true));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== 'syncRestSession') return false;
    syncRestSession(true);
    sendResponse({
      ok: true,
      hasBearer: !!readBearer(),
      hasCt0: !!readCt0()
    });
    return true;
  });
})();