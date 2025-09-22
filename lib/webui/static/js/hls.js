(() => {
  const HLS_URL = '/hls/live.m3u8';
  const START_ENDPOINT = '/hls/start';
  const STOP_ENDPOINT = '/hls/stop';
  const STATS_ENDPOINT = '/hls/stats';

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

  function init() {
    const audio = document.getElementById('player');
    const clients = document.getElementById('clients');
    const encoderState = document.getElementById('enc');

    if (!audio || !clients || !encoderState) {
      return;
    }

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
      fetch(START_ENDPOINT, { cache: 'no-store' }).catch(() => undefined);
      if (nativeHlsSupported(audio)) {
        audio.src = HLS_URL;
      } else {
        loadHlsPolyfill(audio);
      }
    }

    function stopPlayback() {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(STOP_ENDPOINT);
      } else {
        fetch(STOP_ENDPOINT, { keepalive: true }).catch(() => undefined);
      }
    }

    window.addEventListener('beforeunload', stopPlayback);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        stopPlayback();
      } else if (document.visibilityState === 'visible') {
        fetch(START_ENDPOINT, { cache: 'no-store' }).catch(() => undefined);
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
