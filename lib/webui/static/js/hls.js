(() => {
  const HLS_URL = '/hls/live.m3u8';
  const START_ENDPOINT = '/hls/start';
  const STOP_ENDPOINT = '/hls/stop';
  const STATS_ENDPOINT = '/hls/stats';
  const SESSION_STORAGE_KEY = 'tricorder.session';
  const WINDOW_NAME_PREFIX = 'tricorder.session:';

  let cachedSessionId = null;

  function nativeHlsSupported(audio) {
    return (
      audio.canPlayType('application/vnd.apple.mpegurl') ||
      audio.canPlayType('application/x-mpegURL')
    );
  }

  function loadHlsPolyfill(audio) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
    script.async = true;
    script.onload = () => {
      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ lowLatencyMode: true });
        hls.loadSource(HLS_URL);
        hls.attachMedia(audio);
      } else {
        audio.src = HLS_URL;
      }
    };
    document.body.appendChild(script);
  }

  function generateSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const arr = new Uint8Array(16);
      window.crypto.getRandomValues(arr);
      return Array.from(arr, (x) => x.toString(16).padStart(2, '0')).join('');
    }
    const rand = Math.random().toString(36).slice(2);
    return `sess-${Date.now().toString(36)}-${rand}`;
  }

  function readSessionFromStorage() {
    try {
      const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) {
        return existing;
      }
    } catch (err) {
      /* ignore storage errors */
    }

    if (typeof window.name === 'string' && window.name.startsWith(WINDOW_NAME_PREFIX)) {
      return window.name.slice(WINDOW_NAME_PREFIX.length);
    }

    return null;
  }

  function persistSessionId(id) {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    } catch (err) {
      /* ignore storage errors */
    }

    try {
      window.name = `${WINDOW_NAME_PREFIX}${id}`;
    } catch (err) {
      /* ignore window.name assignment errors */
    }
  }

  function ensureSessionId() {
    if (cachedSessionId) {
      return cachedSessionId;
    }

    const existing = readSessionFromStorage();
    if (existing) {
      cachedSessionId = existing;
      persistSessionId(existing);
      return existing;
    }

    cachedSessionId = generateSessionId();
    persistSessionId(cachedSessionId);
    return cachedSessionId;
  }

  function withSession(path) {
    const id = ensureSessionId();
    if (!id) {
      return path;
    }
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}session=${encodeURIComponent(id)}`;
  }

  function sendStart() {
    fetch(withSession(START_ENDPOINT), { cache: 'no-store' }).catch(() => undefined);
  }

  function sendStop(useBeacon) {
    const url = withSession(STOP_ENDPOINT);
    if (useBeacon && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(url, '');
        return;
      } catch (err) {
        /* ignore beacon errors and fall back to fetch */
      }
    }
    fetch(url, { cache: 'no-store', keepalive: true }).catch(() => undefined);
  }

  function init() {
    const audio = document.getElementById('player');
    const clients = document.getElementById('clients');
    const encoderState = document.getElementById('enc');

    if (!audio || !clients || !encoderState) {
      return;
    }

    ensureSessionId();

    function updateStats() {
      fetch(STATS_ENDPOINT, { cache: 'no-store' })
        .then((response) => response.json())
        .then((payload) => {
          clients.textContent = payload.active_clients;
          encoderState.textContent = payload.encoder_running ? 'running' : 'stopped';
        })
        .catch(() => undefined);
    }

    function startPlayback() {
      sendStart();
      if (nativeHlsSupported(audio)) {
        audio.src = HLS_URL;
      } else {
        loadHlsPolyfill(audio);
      }
    }

    window.addEventListener('beforeunload', () => {
      sendStop(true);
    });

    window.addEventListener('pagehide', () => {
      sendStop(true);
    });

    let hiddenPlaybackStopHandler = null;

    function removeHiddenPlaybackStopHandler() {
      if (!hiddenPlaybackStopHandler) {
        return;
      }
      audio.removeEventListener('pause', hiddenPlaybackStopHandler);
      audio.removeEventListener('ended', hiddenPlaybackStopHandler);
      hiddenPlaybackStopHandler = null;
    }

    function ensureHiddenPlaybackStopHandler() {
      if (hiddenPlaybackStopHandler) {
        return;
      }
      hiddenPlaybackStopHandler = () => {
        if (document.visibilityState !== 'hidden') {
          return;
        }
        removeHiddenPlaybackStopHandler();
        sendStop(false);
      };
      audio.addEventListener('pause', hiddenPlaybackStopHandler);
      audio.addEventListener('ended', hiddenPlaybackStopHandler);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (audio.paused || audio.ended) {
          removeHiddenPlaybackStopHandler();
          sendStop(false);
        } else {
          ensureHiddenPlaybackStopHandler();
        }
      } else if (document.visibilityState === 'visible') {
        removeHiddenPlaybackStopHandler();
        sendStart();
      }
    });

    startPlayback();
    updateStats();
    window.setInterval(updateStats, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
