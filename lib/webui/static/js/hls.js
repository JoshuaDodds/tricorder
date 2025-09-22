(() => {
  const HLS_URL = '/hls/live.m3u8';
  const START_ENDPOINT = '/hls/start';
  const STOP_ENDPOINT = '/hls/stop';
  const STATS_ENDPOINT = '/hls/stats';
  const RECORDINGS_ENDPOINT = '/api/recordings';
  const RECORDINGS_DELETE_ENDPOINT = '/api/recordings/delete';
  const CONFIG_ENDPOINT = '/api/config';
  const RECORDINGS_LIMIT = 100;
  const KNOWN_TYPES = ['Both', 'Human', 'Other'];

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

  function setupLiveStream() {
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

  function setupRecordings() {
    const daySelect = document.getElementById('filter-day');
    const typeSelect = document.getElementById('filter-type');
    const searchInput = document.getElementById('filter-search');
    const refreshButton = document.getElementById('refresh-recordings');
    const statusEl = document.getElementById('recordings-status');
    const tableBody = document.getElementById('recordings-body');
    const selectAll = document.getElementById('select-all-recordings');
    const deleteButton = document.getElementById('delete-selected');
    const player = document.getElementById('recording-player');
    const info = document.getElementById('recording-info');

    if (!daySelect || !typeSelect || !tableBody || !statusEl) {
      return;
    }

    const state = {
      items: [],
      days: [],
      hasMore: false,
      filters: {
        day: null,
        type: null,
        q: null,
      },
      selected: new Set(),
      currentId: null,
      loading: false,
      searchTimer: null,
      requestId: 0,
    };

    function formatDayLabel(value) {
      if (!value || value.length !== 8) {
        return value;
      }
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    }

    function setStatus(message) {
      if (statusEl) {
        statusEl.textContent = message || '';
      }
    }

    function syncFilterInputs() {
      const dayValue = state.filters.day || 'all';
      if (daySelect.value !== dayValue) {
        daySelect.value = dayValue;
      }
      const typeValue = state.filters.type || 'all';
      if (typeSelect.value !== typeValue) {
        typeSelect.value = typeValue;
      }
      const searchValue = state.filters.q || '';
      if (searchInput.value !== searchValue) {
        searchInput.value = searchValue;
      }
    }

    function syncSelectAll() {
      if (!selectAll) {
        return;
      }
      if (!state.items.length) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
        return;
      }
      const selectedCount = state.selected.size;
      if (selectedCount === 0) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
      } else if (selectedCount === state.items.length) {
        selectAll.checked = true;
        selectAll.indeterminate = false;
      } else {
        selectAll.indeterminate = true;
        selectAll.checked = false;
      }
    }

    function updateDeleteButtonState() {
      if (deleteButton) {
        deleteButton.disabled = state.selected.size === 0;
      }
    }

    function updateStatusMessage() {
      if (state.loading) {
        setStatus('Loading recordings…');
        return;
      }
      if (!state.items.length) {
        if (state.filters.day || state.filters.type || state.filters.q) {
          setStatus('No recordings match the current filters.');
        } else {
          setStatus('No recordings found.');
        }
        return;
      }
      let message = `Showing ${state.items.length} recording${state.items.length === 1 ? '' : 's'}.`;
      if (state.hasMore) {
        message += ' Newer recordings exist; refine filters to narrow further.';
      }
      setStatus(message);
    }

    function cleanupSelection() {
      const validIds = new Set(state.items.map((item) => item.id));
      state.selected.forEach((id) => {
        if (!validIds.has(id)) {
          state.selected.delete(id);
        }
      });
      if (state.currentId && !validIds.has(state.currentId)) {
        state.currentId = null;
        if (player) {
          player.removeAttribute('src');
          player.load();
        }
        if (info) {
          info.textContent = 'Select a recording to begin playback.';
          info.classList.add('muted');
        }
      }
    }

    function renderDayOptions() {
      if (!daySelect) {
        return;
      }
      for (let i = daySelect.options.length - 1; i >= 1; i -= 1) {
        daySelect.remove(i);
      }
      state.days.forEach((day) => {
        const option = document.createElement('option');
        option.value = day;
        option.textContent = formatDayLabel(day);
        daySelect.appendChild(option);
      });
    }

    function playRecording(item) {
      if (!player || !item) {
        return;
      }
      state.currentId = item.id;
      player.src = item.url;
      player.currentTime = 0;
      player.play().catch(() => undefined);
      if (info) {
        const detail = item.details ? ` · ${item.details}` : '';
        info.textContent = `${item.title}${detail ? detail : ''} (${item.size_label})`;
        info.classList.remove('muted');
      }
      Array.from(tableBody.querySelectorAll('tr')).forEach((row) => {
        if (row.dataset && row.dataset.id) {
          if (row.dataset.id === item.id) {
            row.classList.add('playing');
          } else {
            row.classList.remove('playing');
          }
        }
      });
    }

    function attachRowEvents(row, item, checkbox) {
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.selected.add(item.id);
          row.classList.add('selected');
        } else {
          state.selected.delete(item.id);
          row.classList.remove('selected');
        }
        syncSelectAll();
        updateDeleteButtonState();
      });

      row.addEventListener('dblclick', (event) => {
        if (!(event.target instanceof HTMLInputElement)) {
          playRecording(item);
        }
      });
    }

    function renderTable() {
      tableBody.innerHTML = '';
      if (!state.items.length) {
        syncSelectAll();
        updateDeleteButtonState();
        return;
      }

      state.items.forEach((item) => {
        const row = document.createElement('tr');
        row.dataset.id = item.id;
        if (state.selected.has(item.id)) {
          row.classList.add('selected');
        }
        if (item.id === state.currentId) {
          row.classList.add('playing');
        }

        const selectCell = document.createElement('td');
        selectCell.className = 'select-col';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'recording-select';
        checkbox.checked = state.selected.has(item.id);
        selectCell.appendChild(checkbox);
        row.appendChild(selectCell);

        const dayCell = document.createElement('td');
        dayCell.textContent = item.day_label || item.day || '';
        row.appendChild(dayCell);

        const timeCell = document.createElement('td');
        timeCell.textContent = item.time || '—';
        row.appendChild(timeCell);

        const typeCell = document.createElement('td');
        typeCell.textContent = item.type || '';
        if (item.details) {
          const detail = document.createElement('div');
          detail.className = 'muted';
          detail.textContent = item.details;
          typeCell.appendChild(detail);
        }
        row.appendChild(typeCell);

        const sizeCell = document.createElement('td');
        sizeCell.textContent = item.size_label || '';
        row.appendChild(sizeCell);

        const actionsCell = document.createElement('td');
        actionsCell.className = 'actions-col';
        const actions = document.createElement('div');
        actions.className = 'row-actions';

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.textContent = 'Play';
        playBtn.addEventListener('click', () => playRecording(item));
        actions.appendChild(playBtn);

        const downloadLink = document.createElement('a');
        downloadLink.href = item.url;
        downloadLink.textContent = 'Download';
        downloadLink.setAttribute('download', item.download_name || item.name);
        actions.appendChild(downloadLink);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = 'Delete';
        deleteBtn.className = 'danger';
        deleteBtn.addEventListener('click', () => {
          confirmAndDelete([item.id]);
        });
        actions.appendChild(deleteBtn);

        actionsCell.appendChild(actions);
        row.appendChild(actionsCell);

        tableBody.appendChild(row);
        attachRowEvents(row, item, checkbox);
      });

      syncSelectAll();
      updateDeleteButtonState();
    }

    function confirmAndDelete(ids) {
      if (!ids.length) {
        return;
      }
      const message = ids.length === 1
        ? 'Delete this recording? This action permanently removes the file.'
        : `Delete ${ids.length} recordings? This action permanently removes the files.`;
      if (!window.confirm(message)) {
        return;
      }
      setStatus('Deleting recordings…');
      if (deleteButton) {
        deleteButton.disabled = true;
      }
      fetch(RECORDINGS_DELETE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ids }),
      })
        .then((response) => {
          if (!response.ok) {
            return response.json().catch(() => ({})).then((payload) => {
              throw new Error(payload.error || 'Delete failed');
            });
          }
          return response.json();
        })
        .then((payload) => {
          const deletedIds = Array.isArray(payload.deleted) ? payload.deleted : [];
          const failed = Array.isArray(payload.failed) ? payload.failed : [];
          deletedIds.forEach((id) => state.selected.delete(id));
          if (failed.length) {
            const failureSummary = failed
              .map((item) => `${item.id || 'unknown'} (${item.error || 'failed'})`)
              .join(', ');
            setStatus(`Some deletions failed: ${failureSummary}`);
          } else if (deletedIds.length) {
            setStatus(`Deleted ${deletedIds.length} recording${deletedIds.length === 1 ? '' : 's'}.`);
          } else {
            setStatus('No recordings were deleted.');
          }
          if (state.currentId && deletedIds.includes(state.currentId)) {
            state.currentId = null;
            if (player) {
              player.removeAttribute('src');
              player.load();
            }
            if (info) {
              info.textContent = 'Select a recording to begin playback.';
              info.classList.add('muted');
            }
          }
          loadRecordings();
        })
        .catch((error) => {
          setStatus(error.message || 'Failed to delete recordings.');
          updateDeleteButtonState();
        });
    }

    function buildQueryParams() {
      const params = new URLSearchParams();
      params.set('limit', String(RECORDINGS_LIMIT));
      if (state.filters.day) {
        params.set('day', state.filters.day);
      }
      if (state.filters.type) {
        params.set('type', state.filters.type);
      }
      if (state.filters.q) {
        params.set('q', state.filters.q);
      }
      return params;
    }

    function loadRecordings(options) {
      const silent = options && options.silent;
      state.requestId += 1;
      const currentRequest = state.requestId;
      state.loading = true;
      if (!silent) {
        setStatus('Loading recordings…');
      }
      fetch(`${RECORDINGS_ENDPOINT}?${buildQueryParams().toString()}`, { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) {
            return response.json().catch(() => ({})).then((payload) => {
              throw new Error(payload.error || 'Failed to load recordings');
            });
          }
          return response.json();
        })
        .then((payload) => {
          if (currentRequest !== state.requestId) {
            return;
          }
          state.items = Array.isArray(payload.items) ? payload.items : [];
          state.hasMore = Boolean(payload.has_more);
          state.days = Array.isArray(payload.days) ? payload.days : [];
          if (payload.filters) {
            state.filters.day = payload.filters.day || null;
            state.filters.type = payload.filters.type || null;
            state.filters.q = payload.filters.q || null;
          }
          if (state.filters.day && !state.days.includes(state.filters.day)) {
            state.filters.day = null;
          }
          if (state.filters.type && !KNOWN_TYPES.includes(state.filters.type)) {
            state.filters.type = null;
          }
          renderDayOptions();
          syncFilterInputs();
          cleanupSelection();
          renderTable();
          state.loading = false;
          updateStatusMessage();
        })
        .catch((error) => {
          if (currentRequest !== state.requestId) {
            return;
          }
          state.loading = false;
          setStatus(error.message || 'Failed to load recordings.');
        })
        .finally(() => {
          if (currentRequest === state.requestId) {
            updateDeleteButtonState();
          }
        });
    }

    if (daySelect) {
      daySelect.addEventListener('change', () => {
        const value = daySelect.value;
        state.filters.day = value === 'all' ? null : value;
        loadRecordings();
      });
    }

    if (typeSelect) {
      typeSelect.addEventListener('change', () => {
        const value = typeSelect.value;
        state.filters.type = value === 'all' ? null : value;
        loadRecordings();
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        window.clearTimeout(state.searchTimer);
        state.searchTimer = window.setTimeout(() => {
          const value = searchInput.value.trim();
          state.filters.q = value || null;
          loadRecordings({ silent: true });
        }, 250);
      });
    }

    if (refreshButton) {
      refreshButton.addEventListener('click', () => {
        loadRecordings();
      });
    }

    if (selectAll) {
      selectAll.addEventListener('change', () => {
        if (!state.items.length) {
          selectAll.checked = false;
          selectAll.indeterminate = false;
          return;
        }
        state.selected.clear();
        if (selectAll.checked) {
          state.items.forEach((item) => state.selected.add(item.id));
        }
        Array.from(tableBody.querySelectorAll('tr')).forEach((row) => {
          if (!row.dataset || !row.dataset.id) {
            return;
          }
          if (state.selected.has(row.dataset.id)) {
            row.classList.add('selected');
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb instanceof HTMLInputElement) {
              cb.checked = true;
            }
          } else {
            row.classList.remove('selected');
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb instanceof HTMLInputElement) {
              cb.checked = false;
            }
          }
        });
        updateDeleteButtonState();
        syncSelectAll();
      });
    }

    if (deleteButton) {
      deleteButton.addEventListener('click', () => {
        confirmAndDelete(Array.from(state.selected));
      });
    }

    loadRecordings();
  }

  function setupConfigViewer() {
    const toggle = document.getElementById('toggle-config');
    const pre = document.getElementById('config-view');
    const status = document.getElementById('config-status');

    if (!toggle || !pre) {
      return;
    }

    const state = {
      loaded: false,
      visible: false,
      text: '',
    };

    function show() {
      pre.hidden = false;
      state.visible = true;
      toggle.textContent = 'Hide configuration';
    }

    function hide() {
      pre.hidden = true;
      state.visible = false;
      toggle.textContent = 'Show configuration';
    }

    function loadConfig() {
      if (status) {
        status.textContent = 'Loading configuration…';
      }
      fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) {
            return response.json().catch(() => ({})).then((payload) => {
              throw new Error(payload.error || 'Failed to load configuration');
            });
          }
          return response.json();
        })
        .then((payload) => {
          const text = typeof payload.text === 'string'
            ? payload.text
            : JSON.stringify(payload.config || {}, null, 2);
          pre.textContent = text;
          state.text = text;
          state.loaded = true;
          if (status) {
            status.textContent = '';
          }
          show();
        })
        .catch((error) => {
          if (status) {
            status.textContent = error.message || 'Failed to load configuration.';
          }
        });
    }

    toggle.addEventListener('click', () => {
      if (!state.loaded) {
        loadConfig();
        return;
      }
      if (state.visible) {
        hide();
      } else {
        if (!state.text) {
          loadConfig();
          return;
        }
        if (status) {
          status.textContent = '';
        }
        show();
      }
    });
  }

  function init() {
    setupLiveStream();
    setupRecordings();
    setupConfigViewer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
