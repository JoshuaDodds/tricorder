const AUTO_REFRESH_INTERVAL_MS = 1000;
const OFFLINE_REFRESH_INTERVAL_MS = 5000;
const REFRESH_INDICATOR_DELAY_MS = 600;
const MARKER_MIN_GAP_SECONDS = 0.05;
const KEYBOARD_JOG_RATE_SECONDS_PER_SECOND = 4;

const HLS_URL = "/hls/live.m3u8";
const START_ENDPOINT = "/hls/start";
const STOP_ENDPOINT = "/hls/stop";
const STATS_ENDPOINT = "/hls/stats";
const SESSION_STORAGE_KEY = "tricorder.session";
const WINDOW_NAME_PREFIX = "tricorder.session:";

const state = {
  filters: {
    search: "",
    day: "",
    limit: 500,
  },
  records: [],
  recordsFingerprint: "",
  total: 0,
  filteredSize: 0,
  availableDays: [],
  selections: new Set(),
  current: null,
  lastUpdated: null,
  sort: { key: "modified", direction: "asc" },
  storage: { recordings: 0, total: null, free: null, diskUsed: null },
};

const dom = {
  recordingCount: document.getElementById("recording-count"),
  selectedCount: document.getElementById("selected-count"),
  storageUsageText: document.getElementById("storage-usage-text"),
  storageHint: document.getElementById("storage-hint"),
  storageProgress: document.getElementById("storage-progress-bar"),
  lastUpdated: document.getElementById("last-updated"),
  tableBody: document.querySelector("#recordings-table tbody"),
  toggleAll: document.getElementById("toggle-all"),
  selectAll: document.getElementById("select-all"),
  clearSelection: document.getElementById("clear-selection"),
  deleteSelected: document.getElementById("delete-selected"),
  refreshButton: document.getElementById("refresh-button"),
  refreshIndicator: document.getElementById("refresh-indicator"),
  connectionStatus: document.getElementById("connection-status"),
  recordingIndicator: document.getElementById("recording-indicator"),
  recordingIndicatorText: document.getElementById("recording-indicator-text"),
  applyFilters: document.getElementById("apply-filters"),
  clearFilters: document.getElementById("clear-filters"),
  filterSearch: document.getElementById("filter-search"),
  filterDay: document.getElementById("filter-day"),
  filterLimit: document.getElementById("filter-limit"),
  playerCard: document.getElementById("player-card"),
  player: document.getElementById("preview-player"),
  playerMeta: document.getElementById("player-meta"),
  configViewer: document.getElementById("config-viewer"),
  liveToggle: document.getElementById("live-stream-toggle"),
  liveCard: document.getElementById("live-stream-card"),
  livePanel: document.getElementById("live-stream-panel"),
  liveStatus: document.getElementById("live-stream-status"),
  liveClients: document.getElementById("live-stream-clients"),
  liveEncoder: document.getElementById("live-stream-encoder"),
  liveClose: document.getElementById("live-stream-close"),
  liveAudio: document.getElementById("live-stream-audio"),
  previewClose: document.getElementById("preview-close"),
  waveformContainer: document.getElementById("waveform-container"),
  waveformCanvas: document.getElementById("waveform-canvas"),
  waveformClock: document.getElementById("waveform-clock"),
  waveformCursor: document.getElementById("waveform-cursor"),
  waveformTriggerMarker: document.getElementById("waveform-trigger-marker"),
  waveformReleaseMarker: document.getElementById("waveform-release-marker"),
  waveformEmpty: document.getElementById("waveform-empty"),
  waveformStatus: document.getElementById("waveform-status"),
  sortButtons: Array.from(document.querySelectorAll(".sort-button")),
  confirmModal: document.getElementById("confirm-modal"),
  confirmDialog: document.getElementById("confirm-modal-dialog"),
  confirmTitle: document.getElementById("confirm-modal-title"),
  confirmMessage: document.getElementById("confirm-modal-message"),
  confirmConfirm: document.getElementById("confirm-modal-confirm"),
  confirmCancel: document.getElementById("confirm-modal-cancel"),
};

const sortHeaderMap = new Map(
  dom.sortButtons.map((button) => [button.dataset.sortKey ?? "", button.closest("th")])
);

const userLocales = (() => {
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      return navigator.languages;
    }
    if (typeof navigator.language === "string" && navigator.language) {
      return [navigator.language];
    }
  }
  return undefined;
})();

const dateFormatter = new Intl.DateTimeFormat(userLocales, {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  hourCycle: "h23",
});

const timeFormatter = new Intl.DateTimeFormat(userLocales, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

let autoRefreshId = null;
let autoRefreshIntervalMs = AUTO_REFRESH_INTERVAL_MS;
let fetchInFlight = false;
let fetchQueued = false;
let refreshIndicatorTimer = null;
let pendingSelectionPath = null;

const waveformState = {
  peaks: null,
  requestId: 0,
  abortController: null,
  animationFrame: null,
  duration: 0,
  pointerId: null,
  isScrubbing: false,
  lastFraction: 0,
  triggerSeconds: null,
  releaseSeconds: null,
  peakScale: 32767,
  startEpoch: null,
};

const liveState = {
  open: false,
  active: false,
  statsTimer: null,
  hls: null,
  scriptPromise: null,
  sessionId: null,
};

const playbackState = {
  pausedViaSpacebar: new Set(),
  resetOnLoad: false,
  enforcePauseOnLoad: false,
};

const transportState = {
  keys: new Set(),
  direction: 0,
  animationFrame: null,
  lastTimestamp: null,
  wasPlaying: false,
  isJogging: false,
};

const confirmDialogState = {
  open: false,
  resolve: null,
  previouslyFocused: null,
};

const playerPlacement = {
  mode: "hidden",
  anchorPath: null,
  desktopRowElement: null,
  mobileCell: null,
};

const playerCardHome = dom.playerCard ? dom.playerCard.parentElement : null;
const playerCardHomeAnchor = dom.playerCard ? dom.playerCard.nextElementSibling : null;
const mobileLayoutQuery =
  typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 640px)") : null;

const configState = {
  prePadSeconds: null,
  postPadSeconds: null,
};

const connectionState = {
  offline: false,
};

const captureIndicatorState = {
  state: "unknown",
  message: "",
};

function startAutoRefresh() {
  if (autoRefreshId) {
    return;
  }
  autoRefreshId = window.setInterval(() => {
    fetchRecordings({ silent: true });
  }, autoRefreshIntervalMs);
}

function stopAutoRefresh() {
  if (autoRefreshId) {
    window.clearInterval(autoRefreshId);
    autoRefreshId = null;
  }
}

function restartAutoRefresh() {
  if (!autoRefreshId) {
    return;
  }
  stopAutoRefresh();
  startAutoRefresh();
}

function setAutoRefreshInterval(intervalMs) {
  const clamped = Math.max(intervalMs, AUTO_REFRESH_INTERVAL_MS);
  if (autoRefreshIntervalMs === clamped) {
    return;
  }
  autoRefreshIntervalMs = clamped;
  restartAutoRefresh();
}

function setConnectionStatus(message) {
  if (!dom.connectionStatus) {
    return;
  }
  if (message) {
    dom.connectionStatus.dataset.visible = "true";
    dom.connectionStatus.textContent = message;
    dom.connectionStatus.setAttribute("aria-hidden", "false");
  } else {
    dom.connectionStatus.dataset.visible = "false";
    dom.connectionStatus.textContent = "";
    dom.connectionStatus.setAttribute("aria-hidden", "true");
  }
}

function updateOfflineState(offline) {
  if (connectionState.offline === offline) {
    return;
  }
  connectionState.offline = offline;
  setConnectionStatus(offline ? "Offline: unable to reach recorder" : "");
}

function applyRecordingIndicator(state, message) {
  if (!dom.recordingIndicator || !dom.recordingIndicatorText) {
    return;
  }
  if (captureIndicatorState.state === state && captureIndicatorState.message === message) {
    return;
  }
  captureIndicatorState.state = state;
  captureIndicatorState.message = message;
  dom.recordingIndicator.dataset.state = state;
  dom.recordingIndicatorText.textContent = message;
  dom.recordingIndicator.setAttribute("aria-hidden", "false");
}

function setRecordingIndicatorUnknown(message = "Status unavailable") {
  applyRecordingIndicator("unknown", message);
}

function setRecordingIndicatorStatus(rawStatus) {
  if (!dom.recordingIndicator || !dom.recordingIndicatorText) {
    return;
  }
  if (!rawStatus || typeof rawStatus !== "object") {
    setRecordingIndicatorUnknown();
    return;
  }
  const capturing = Boolean(rawStatus.capturing);
  const state = capturing ? "active" : "idle";
  let message = capturing ? "Recording active" : "Recording idle";

  if (capturing) {
    const event = rawStatus.event;
    let detail = "";
    if (event && typeof event === "object") {
      const trigger = toFiniteOrNull(event.trigger_rms);
      if (trigger !== null) {
        detail = `RMS ${Math.round(trigger)}`;
      } else if (typeof event.base_name === "string" && event.base_name) {
        detail = event.base_name;
      }
    }
    if (detail) {
      message += ` • ${detail}`;
    }
  } else {
    const lastEvent = rawStatus.last_event;
    let detail = "";
    if (lastEvent && typeof lastEvent === "object") {
      const endedEpoch = toFiniteOrNull(lastEvent.ended_epoch);
      if (endedEpoch !== null) {
        const endedDate = new Date(endedEpoch * 1000);
        detail = `Last ${dateFormatter.format(endedDate)}`;
      } else if (typeof lastEvent.base_name === "string" && lastEvent.base_name) {
        detail = `Last ${lastEvent.base_name}`;
      }
    }
    if (!detail && typeof rawStatus.last_stop_reason === "string" && rawStatus.last_stop_reason) {
      detail = rawStatus.last_stop_reason;
    }
    if (detail) {
      message += ` • ${detail}`;
    }
  }

  applyRecordingIndicator(state, message);
}

function handleFetchSuccess() {
  setAutoRefreshInterval(AUTO_REFRESH_INTERVAL_MS);
  updateOfflineState(false);
}

function handleFetchFailure() {
  setAutoRefreshInterval(OFFLINE_REFRESH_INTERVAL_MS);
  updateOfflineState(true);
}

function formatDate(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }
  return dateFormatter.format(new Date(seconds * 1000));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** idx;
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function formatClockTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return "--:--:--";
  }
  try {
    return timeFormatter.format(new Date(epochSeconds * 1000));
  } catch (error) {
    return "--:--:--";
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function numericValue(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toFiniteOrNull(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getRecordStartSeconds(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  if (Number.isFinite(record.start_epoch)) {
    return Number(record.start_epoch);
  }
  if (Number.isFinite(record.started_epoch)) {
    return Number(record.started_epoch);
  }
  if (typeof record.started_at === "string" && record.started_at.trim() !== "") {
    const parsedStarted = Date.parse(record.started_at);
    if (!Number.isNaN(parsedStarted)) {
      return parsedStarted / 1000;
    }
  }
  if (Number.isFinite(record.modified)) {
    return Number(record.modified);
  }
  if (typeof record.modified_iso === "string" && record.modified_iso.trim() !== "") {
    const parsedModified = Date.parse(record.modified_iso);
    if (!Number.isNaN(parsedModified)) {
      return parsedModified / 1000;
    }
  }
  return null;
}

function confirmDialogFocusableElements() {
  const focusable = [];
  if (dom.confirmConfirm instanceof HTMLElement && !dom.confirmConfirm.disabled) {
    focusable.push(dom.confirmConfirm);
  }
  if (dom.confirmCancel instanceof HTMLElement && !dom.confirmCancel.disabled) {
    focusable.push(dom.confirmCancel);
  }
  return focusable;
}

function setConfirmDialogVisibility(visible) {
  if (!dom.confirmModal) {
    return;
  }
  dom.confirmModal.dataset.visible = visible ? "true" : "false";
  dom.confirmModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.confirmModal.removeAttribute("hidden");
  } else {
    dom.confirmModal.setAttribute("hidden", "hidden");
  }
}

// Global key handlers for the confirm modal (works across Firefox/Chrome/iOS)
function attachConfirmGlobalKeyHandlers() {
  // Avoid adding twice
  if (confirmDialogState._globalKeydown) return;

  confirmDialogState._globalKeydown = (event) => {
    if (!confirmDialogState.open) return;

    // ESC cancels
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      resolveConfirmDialog(false);
      return;
    }

    // ENTER confirms unless Cancel has focus
    if (event.key === "Enter") {
      if (event.target === dom.confirmCancel) return;
      event.preventDefault();
      event.stopPropagation();
      resolveConfirmDialog(true);
    }
  };

  // Capture phase so we get the key even if focus is outside the dialog
  document.addEventListener("keydown", confirmDialogState._globalKeydown, true);
}

function detachConfirmGlobalKeyHandlers() {
  if (!confirmDialogState._globalKeydown) return;
  document.removeEventListener("keydown", confirmDialogState._globalKeydown, true);
  confirmDialogState._globalKeydown = null;
}

function resolveConfirmDialog(result) {
  if (!confirmDialogState.open) return;
  confirmDialogState.open = false;

  // Important: remove global key listener
  detachConfirmGlobalKeyHandlers();

  const resolver = confirmDialogState.resolve;
  confirmDialogState.resolve = null;
  const previousFocus = confirmDialogState.previouslyFocused;
  confirmDialogState.previouslyFocused = null;
  setConfirmDialogVisibility(false);
  if (typeof resolver === "function") resolver(result);
  if (previousFocus && typeof previousFocus.focus === "function") {
    window.requestAnimationFrame(() => previousFocus.focus());
  }
}

function showConfirmDialog(options = {}) {
  const {
    title = "Confirm",
    message = "",
    confirmText = "OK",
    cancelText = "Cancel",
  } = options;

  if (
    !dom.confirmModal ||
    !dom.confirmDialog ||
    !dom.confirmTitle ||
    !dom.confirmMessage ||
    !dom.confirmConfirm ||
    !dom.confirmCancel
  ) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return Promise.resolve(window.confirm(message));
    }
    return Promise.resolve(false);
  }
  if (confirmDialogState.open) {
    return Promise.resolve(false);
  }

  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmConfirm.textContent = confirmText;
  dom.confirmCancel.textContent = cancelText;

  confirmDialogState.open = true;
  confirmDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Make the modal visible
  setConfirmDialogVisibility(true);

  // Attach global key handlers while open
  attachConfirmGlobalKeyHandlers();


  // Important: activate the dialog itself first, then move focus to OK.
  return new Promise((resolve) => {
    confirmDialogState.resolve = (result) => {
      resolve(result);
    };

    // Blur whatever had focus so the page doesn't keep the key events
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }

    // Two rafs help on Firefox/iOS to ensure visibility/layout is committed before focusing
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (dom.confirmDialog) {
          dom.confirmDialog.focus(); // activate dialog for key events
        }
        if (dom.confirmConfirm) {
          dom.confirmConfirm.focus(); // then put focus on OK
        }
      });
    });
  });
}

function handleConfirmDialogKeydown(event) {
  if (!confirmDialogState.open) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    resolveConfirmDialog(false);
    return;
  }
  if (event.key === "Enter") {
    if (event.target === dom.confirmCancel) {
      return;
    }
    event.preventDefault();
    resolveConfirmDialog(true);
    return;
  }
  if (event.key === "Tab") {
    const focusable = confirmDialogFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let index = focusable.indexOf(activeElement);
    if (index === -1) {
      index = 0;
    }
    if (event.shiftKey) {
      index = index <= 0 ? focusable.length - 1 : index - 1;
    } else {
      index = index >= focusable.length - 1 ? 0 : index + 1;
    }
    event.preventDefault();
    focusable[index].focus();
  }
}

function confirmDeletionPrompt(message, title = "Delete recordings") {
  return showConfirmDialog({
    title,
    message,
    confirmText: "OK",
    cancelText: "Cancel",
  });
}

if (dom.confirmConfirm) {
  dom.confirmConfirm.addEventListener("click", () => {
    resolveConfirmDialog(true);
  });
}

if (dom.confirmCancel) {
  dom.confirmCancel.addEventListener("click", () => {
    resolveConfirmDialog(false);
  });
}

if (dom.confirmModal) {
  dom.confirmModal.addEventListener("click", (event) => {
    if (event.target === dom.confirmModal) {
      resolveConfirmDialog(false);
    }
  });
  dom.confirmModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveConfirmDialog(false);
      return;
    }

    if (event.target === dom.confirmModal) {
      resolveConfirmDialog(false);
      return;
    }

    handleConfirmDialogKeydown(event);
  });
}

function clearRefreshIndicatorTimer() {
  if (refreshIndicatorTimer) {
    window.clearTimeout(refreshIndicatorTimer);
    refreshIndicatorTimer = null;
  }
}

function setRefreshIndicatorVisible(visible) {
  if (!dom.refreshIndicator) {
    if (dom.refreshButton) {
      dom.refreshButton.setAttribute("aria-busy", visible ? "true" : "false");
    }
    return;
  }
  dom.refreshIndicator.dataset.visible = visible ? "true" : "false";
  dom.refreshIndicator.setAttribute("aria-hidden", visible ? "false" : "true");
  if (dom.refreshButton) {
    dom.refreshButton.setAttribute("aria-busy", visible ? "true" : "false");
  }
}

function scheduleRefreshIndicator() {
  clearRefreshIndicatorTimer();
  if (!dom.refreshIndicator) {
    setRefreshIndicatorVisible(false);
    return;
  }
  setRefreshIndicatorVisible(false);
  refreshIndicatorTimer = window.setTimeout(() => {
    setRefreshIndicatorVisible(true);
    refreshIndicatorTimer = null;
  }, REFRESH_INDICATOR_DELAY_MS);
}

function hideRefreshIndicator() {
  clearRefreshIndicatorTimer();
  setRefreshIndicatorVisible(false);
}

function recordingUrl(path, { download = false } = {}) {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const suffix = download ? "?download=1" : "";
  return `/recordings/${encoded}${suffix}`;
}

function populateFilters() {
  const daySelect = dom.filterDay;
  if (!daySelect) {
    return;
  }

  const currentDay = daySelect.value;

  daySelect.innerHTML = "";
  const dayOptions = ["", ...state.availableDays];
  for (const day of dayOptions) {
    const option = document.createElement("option");
    option.value = day;
    option.textContent = day || "All days";
    if (day === state.filters.day || day === currentDay) {
      option.selected = true;
    }
    daySelect.append(option);
  }

  if (dom.filterLimit) {
    dom.filterLimit.value = String(state.filters.limit);
  }
}

function stringCompare(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function compareRecords(a, b) {
  const { key, direction } = state.sort;
  const dir = direction === "asc" ? 1 : -1;

  let result = 0;
  switch (key) {
    case "name":
      result = stringCompare(String(a.name ?? ""), String(b.name ?? ""));
      break;
    case "day":
      result = stringCompare(String(a.day ?? ""), String(b.day ?? ""));
      break;
    case "modified": {
      const left = getRecordStartSeconds(a);
      const right = getRecordStartSeconds(b);
      const leftVal = Number.isFinite(left) ? left : 0;
      const rightVal = Number.isFinite(right) ? right : 0;
      result = leftVal - rightVal;
      break;
    }
    case "duration": {
      const left = Number.isFinite(a.duration_seconds) ? a.duration_seconds : -1;
      const right = Number.isFinite(b.duration_seconds) ? b.duration_seconds : -1;
      result = left - right;
      break;
    }
    case "size_bytes": {
      const left = Number.isFinite(a.size_bytes) ? a.size_bytes : 0;
      const right = Number.isFinite(b.size_bytes) ? b.size_bytes : 0;
      result = left - right;
      break;
    }
    case "extension":
      result = stringCompare(String(a.extension ?? ""), String(b.extension ?? ""));
      break;
    default:
      result = 0;
      break;
  }

  if (result === 0 && key !== "name") {
    result = stringCompare(String(a.name ?? ""), String(b.name ?? ""));
  }

  return result * dir;
}

function getVisibleRecords() {
  return [...state.records].sort(compareRecords);
}

function computeRecordsFingerprint(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return "";
  }
  const parts = [];
  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const path = typeof record.path === "string" ? record.path : "";
    const modified = Number.isFinite(record.modified) ? record.modified : "";
    const size = Number.isFinite(record.size_bytes) ? record.size_bytes : "";
    const duration = Number.isFinite(record.duration_seconds)
      ? record.duration_seconds
      : "";
    const trigger = Number.isFinite(record.trigger_offset_seconds)
      ? record.trigger_offset_seconds
      : "";
    const release = Number.isFinite(record.release_offset_seconds)
      ? record.release_offset_seconds
      : "";
    const waveform = typeof record.waveform_path === "string" ? record.waveform_path : "";
    parts.push(`${path}|${modified}|${size}|${duration}|${trigger}|${release}|${waveform}`);
  }
  return parts.join("\n");
}

function updateSortIndicators() {
  for (const button of dom.sortButtons) {
    const key = button.dataset.sortKey ?? "";
    const isActive = state.sort.key === key;
    button.dataset.active = isActive ? "true" : "false";
    button.dataset.direction = isActive ? state.sort.direction : "";
    const header = sortHeaderMap.get(key);
    if (header) {
      if (isActive) {
        header.dataset.sorted = "true";
        header.setAttribute(
          "aria-sort",
          state.sort.direction === "asc" ? "ascending" : "descending"
        );
      } else {
        header.dataset.sorted = "false";
        header.setAttribute("aria-sort", "none");
      }
    }
  }
}

function updateSelectionUI(records = null) {
  const visible = Array.isArray(records) ? records : getVisibleRecords();
  dom.selectedCount.textContent = state.selections.size.toString();
  dom.deleteSelected.disabled = state.selections.size === 0;

  if (!visible.length) {
    dom.toggleAll.checked = false;
    dom.toggleAll.indeterminate = false;
    return;
  }

  let selectedVisible = 0;
  for (const record of visible) {
    if (state.selections.has(record.path)) {
      selectedVisible += 1;
    }
  }

  dom.toggleAll.checked = selectedVisible === visible.length;
  if (selectedVisible === 0 || selectedVisible === visible.length) {
    dom.toggleAll.indeterminate = false;
  } else {
    dom.toggleAll.indeterminate = true;
  }
}

function renderEmptyState(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 8;
  cell.className = "empty-state";
  cell.textContent = message;
  row.append(cell);
  dom.tableBody.append(row);
}

function applyNowPlayingHighlight() {
  const rows = dom.tableBody.querySelectorAll("tr");
  rows.forEach((row) => {
    const path = row.getAttribute("data-path");
    if (!path) {
      row.classList.remove("active-row");
      return;
    }
    if (state.current && state.current.path === path) {
      row.classList.add("active-row");
    } else {
      row.classList.remove("active-row");
    }
  });
}

function updatePlayerMeta(record) {
  if (!record) {
    dom.playerMeta.textContent = "Select a recording to preview.";
    return;
  }
  const details = [];
  const extText = record.extension ? `.${record.extension}` : "";
  details.push(`${record.name}${extText}`);
  if (record.day) {
    details.push(record.day);
  }
  const startSeconds = getRecordStartSeconds(record);
  details.push(formatDate(startSeconds !== null ? startSeconds : record.modified));
  details.push(formatBytes(record.size_bytes));
  if (Number.isFinite(record.duration_seconds) && record.duration_seconds > 0) {
    details.push(formatDuration(record.duration_seconds));
  }
  dom.playerMeta.textContent = `Now playing: ${details.join(" • ")}`;
}

function layoutIsMobile() {
  if (mobileLayoutQuery) {
    return mobileLayoutQuery.matches;
  }
  return window.innerWidth <= 640;
}

function getTableColumnCount() {
  const headerRow = document.querySelector("#recordings-table thead tr");
  if (headerRow && headerRow.children.length > 0) {
    return headerRow.children.length;
  }
  const sampleRow = dom.tableBody ? dom.tableBody.querySelector("tr[data-path]") : null;
  if (sampleRow && sampleRow.children.length > 0) {
    return sampleRow.children.length;
  }
  return 1;
}

function findRowForRecord(record) {
  if (!record || !dom.tableBody) {
    return null;
  }
  const rows = dom.tableBody.querySelectorAll("tr[data-path]");
  for (const row of rows) {
    if (row.dataset.path === record.path) {
      return row;
    }
  }
  return null;
}

function restorePlayerCardHome() {
  if (!dom.playerCard || !playerCardHome) {
    return;
  }
  if (dom.playerCard.parentElement === playerCardHome) {
    return;
  }
  if (playerCardHomeAnchor && playerCardHomeAnchor.parentElement === playerCardHome) {
    playerCardHome.insertBefore(dom.playerCard, playerCardHomeAnchor);
  } else {
    playerCardHome.append(dom.playerCard);
  }
}

function detachPlayerCard() {
  if (!dom.playerCard) {
    return;
  }
  restorePlayerCardHome();
  if (playerPlacement.desktopRowElement && playerPlacement.desktopRowElement.parentElement) {
    playerPlacement.desktopRowElement.parentElement.removeChild(playerPlacement.desktopRowElement);
  }
  if (playerPlacement.mobileCell && playerPlacement.mobileCell.parentElement) {
    playerPlacement.mobileCell.parentElement.removeChild(playerPlacement.mobileCell);
  }
  dom.playerCard.hidden = true;
  dom.playerCard.dataset.active = "false";
  playerPlacement.mode = "hidden";
  playerPlacement.anchorPath = null;
  playerPlacement.desktopRowElement = null;
  playerPlacement.mobileCell = null;
}

function ensureDesktopRow() {
  if (!dom.playerCard) {
    return null;
  }
  if (!playerPlacement.desktopRowElement) {
    const row = document.createElement("tr");
    row.className = "player-row";
    const cell = document.createElement("td");
    cell.className = "player-cell";
    row.append(cell);
    playerPlacement.desktopRowElement = row;
  }
  const cell = playerPlacement.desktopRowElement.firstElementChild;
  if (cell instanceof HTMLTableCellElement) {
    cell.colSpan = getTableColumnCount();
    if (!cell.contains(dom.playerCard)) {
      cell.append(dom.playerCard);
    }
  }
  return playerPlacement.desktopRowElement;
}

function placePlayerCard(record, sourceRow = null) {
  if (!dom.playerCard || !record) {
    return;
  }
  const targetRow = sourceRow ?? findRowForRecord(record);
  if (!targetRow || !targetRow.parentElement) {
    detachPlayerCard();
    return;
  }

  const isMobileLayout = layoutIsMobile();
  if (isMobileLayout) {
    const previousCell = playerPlacement.mobileCell;
    let container = targetRow.querySelector(".mobile-player-cell");
    if (!container) {
      container = document.createElement("td");
      container.className = "mobile-player-cell";
      container.colSpan = getTableColumnCount();
      const nameCell = targetRow.querySelector(".cell-name");
      if (nameCell) {
        targetRow.insertBefore(container, nameCell);
      } else {
        targetRow.insertBefore(container, targetRow.firstChild);
      }
    }
    if (!container.contains(dom.playerCard)) {
      container.append(dom.playerCard);
    }
    if (previousCell && previousCell !== container && previousCell.parentElement) {
      previousCell.parentElement.removeChild(previousCell);
    }
    if (playerPlacement.desktopRowElement && playerPlacement.desktopRowElement.parentElement) {
      playerPlacement.desktopRowElement.parentElement.removeChild(playerPlacement.desktopRowElement);
    }
    dom.playerCard.hidden = false;
    dom.playerCard.dataset.active = "true";
    playerPlacement.mode = "mobile";
    playerPlacement.anchorPath = record.path;
    playerPlacement.mobileCell = container;
    return;
  }

  const playerRow = ensureDesktopRow();
  if (!playerRow) {
    return;
  }
  if (playerPlacement.mobileCell && playerPlacement.mobileCell.parentElement) {
    playerPlacement.mobileCell.parentElement.removeChild(playerPlacement.mobileCell);
    playerPlacement.mobileCell = null;
  }
  targetRow.parentElement.insertBefore(playerRow, targetRow);
  dom.playerCard.hidden = false;
  dom.playerCard.dataset.active = "true";
  playerPlacement.mode = "desktop";
  playerPlacement.anchorPath = record.path;
}

function syncPlayerPlacement() {
  if (!dom.playerCard) {
    return;
  }
  if (!state.current) {
    detachPlayerCard();
    return;
  }
  placePlayerCard(state.current);
}

function resetAllPlayButtons() {
  if (!dom.tableBody) {
    return;
  }
  const rows = dom.tableBody.querySelectorAll("tr[data-path]");
  rows.forEach((row) => {
    row.classList.remove("active-row");
    const button = row.querySelector(
      "button.button-play, button.button-pause, button.button-stop",
    );
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.classList.remove("button-pause");
    button.classList.remove("button-stop");
    button.classList.add("button-play");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Play");
    button.textContent = "Play";
  });
}

function setNowPlaying(record, options = {}) {
  const { autoplay = true, resetToStart = true, sourceRow = null } = options;
  const previous = state.current;
  const sameRecord = Boolean(previous && record && previous.path === record.path);

  cancelKeyboardJog();

  playbackState.pausedViaSpacebar.delete(dom.player);

  if (!sameRecord && dom.player) {
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }

    resetAllPlayButtons();
  }

  state.current = record;
  if (!record) {
    updatePlayerMeta(null);
    detachPlayerCard();
    playbackState.resetOnLoad = false;
    playbackState.enforcePauseOnLoad = false;
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }
    dom.player.removeAttribute("src");
    resetWaveform();
    applyNowPlayingHighlight();
    return;
  }

  updatePlayerMeta(record);
  applyNowPlayingHighlight();
  placePlayerCard(record, sourceRow);

  if (sameRecord) {
    playbackState.resetOnLoad = false;
    playbackState.enforcePauseOnLoad = !autoplay;
    if (resetToStart) {
      try {
        dom.player.currentTime = 0;
      } catch (error) {
        /* ignore seek errors */
      }
      updateCursorFromPlayer();
    }
    if (autoplay) {
      dom.player.play().catch(() => undefined);
    } else {
      try {
        dom.player.pause();
      } catch (error) {
        /* ignore pause errors */
      }
    }
    updateWaveformMarkers();
    return;
  }

  playbackState.resetOnLoad = resetToStart;
  playbackState.enforcePauseOnLoad = !autoplay;

  const url = recordingUrl(record.path);
  dom.player.src = url;
  dom.player.load();
  if (resetToStart) {
    try {
      dom.player.currentTime = 0;
    } catch (error) {
      /* ignore seek errors */
    }
  }
  if (autoplay) {
    dom.player.play().catch(() => {
      /* ignore autoplay failures */
    });
  } else {
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }
  }

  setWaveformMarker(dom.waveformTriggerMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);
  loadWaveform(record);
}

function renderRecords() {
  dom.tableBody.innerHTML = "";

  const records = getVisibleRecords();

  if (!records.length) {
    renderEmptyState("No recordings match the selected filters.");
    updateSelectionUI(records);
    applyNowPlayingHighlight();
    syncPlayerPlacement();
    return;
  }

  for (const record of records) {
    const row = document.createElement("tr");
    row.dataset.path = record.path;

    const checkboxCell = document.createElement("td");
    checkboxCell.className = "checkbox-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selections.has(record.path);
    checkbox.addEventListener("change", (event) => {
      if (event.target.checked) {
        state.selections.add(record.path);
      } else {
        state.selections.delete(record.path);
      }
      updateSelectionUI();
      applyNowPlayingHighlight();
    });
    checkboxCell.append(checkbox);
    row.append(checkboxCell);

    const dayText = record.day || "—";
    const updatedSeconds = getRecordStartSeconds(record);
    const updatedText = formatDate(
      updatedSeconds !== null ? updatedSeconds : record.modified
    );
    const durationText = formatDuration(record.duration_seconds);
    const sizeText = formatBytes(record.size_bytes);

    const nameCell = document.createElement("td");
    nameCell.className = "cell-name";
    const nameTitle = document.createElement("div");
    nameTitle.className = "record-title";
    nameTitle.textContent = record.name;
    nameCell.append(nameTitle);

    const mobileMeta = document.createElement("div");
    mobileMeta.className = "record-mobile-meta";
    if (durationText && durationText !== "--") {
      const durationPill = document.createElement("span");
      durationPill.className = "meta-pill";
      durationPill.textContent = `Length ${durationText}`;
      mobileMeta.append(durationPill);
    }
    if (sizeText) {
      const sizePill = document.createElement("span");
      sizePill.className = "meta-pill";
      sizePill.textContent = `Size ${sizeText}`;
      mobileMeta.append(sizePill);
    }
    if (mobileMeta.childElementCount > 0) {
      nameCell.append(mobileMeta);
    }

    const mobileSubtext = document.createElement("div");
    mobileSubtext.className = "record-mobile-subtext";
    if (record.day) {
      const daySpan = document.createElement("span");
      daySpan.textContent = record.day;
      mobileSubtext.append(daySpan);
    }
    if (updatedText && updatedText !== "--") {
      const updatedSpan = document.createElement("span");
      updatedSpan.textContent = updatedText;
      mobileSubtext.append(updatedSpan);
    }
    if (record.extension) {
      const typeSpan = document.createElement("span");
      typeSpan.textContent = `.${record.extension}`;
      mobileSubtext.append(typeSpan);
    }
    if (mobileSubtext.childElementCount > 0) {
      nameCell.append(mobileSubtext);
    }
    row.append(nameCell);

    const dayCell = document.createElement("td");
    dayCell.className = "cell-day";
    dayCell.textContent = dayText;
    row.append(dayCell);

    const updatedCell = document.createElement("td");
    updatedCell.className = "cell-updated";
    updatedCell.textContent = updatedText;
    row.append(updatedCell);

    const durationCell = document.createElement("td");
    durationCell.className = "numeric length-cell cell-duration";
    durationCell.textContent = durationText;
    row.append(durationCell);

    const sizeCell = document.createElement("td");
    sizeCell.className = "numeric cell-size";
    sizeCell.textContent = sizeText;
    row.append(sizeCell);

    const extCell = document.createElement("td");
    extCell.className = "cell-type";
    extCell.innerHTML = record.extension
      ? `<span class="badge">.${record.extension}</span>`
      : "";
    row.append(extCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions cell-actions";
    const actionWrapper = document.createElement("div");
    actionWrapper.className = "action-buttons";

    const downloadLink = document.createElement("a");
    downloadLink.href = recordingUrl(record.path, { download: true });
    downloadLink.textContent = "Download";
    downloadLink.setAttribute("download", `${record.name}.${record.extension || "opus"}`);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.classList.add("danger-button");
    deleteButton.addEventListener("click", async () => {
      await requestRecordDeletion(record);
    });

    actionWrapper.append(downloadLink, deleteButton);
    actionsCell.append(actionWrapper);
    row.append(actionsCell);

    row.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element) {
        if (
          target.closest("button") ||
          target.closest("a") ||
          target.closest("input") ||
          target.closest(".action-buttons") ||
          target.closest(".player-card")
        ) {
          return;
        }
      }
      setNowPlaying(record, { autoplay: false, resetToStart: true, sourceRow: row });
    });

    row.addEventListener("dblclick", (event) => {
      const target = event.target;
      if (target instanceof Element) {
        if (
          target.closest("button") ||
          target.closest("a") ||
          target.closest("input") ||
          target.closest(".player-card")
        ) {
          return;
        }
      }
      setNowPlaying(record, { autoplay: true, resetToStart: true, sourceRow: row });
    });

    dom.tableBody.append(row);
  }

  applyNowPlayingHighlight();
  updateSelectionUI(records);
  syncPlayerPlacement();
}

function updateStats() {
  dom.recordingCount.textContent = state.total.toString();
  const recordingsUsed = Number.isFinite(state.storage.recordings)
    ? state.storage.recordings
    : 0;
  const diskTotal = Number.isFinite(state.storage.total) && state.storage.total > 0
    ? state.storage.total
    : null;
  const diskFree = Number.isFinite(state.storage.free) && state.storage.free >= 0
    ? state.storage.free
    : null;
  const diskUsed = Number.isFinite(state.storage.diskUsed) && state.storage.diskUsed >= 0
    ? state.storage.diskUsed
    : null;

  const hasCapacity = diskTotal !== null || diskFree !== null;
  const effectiveTotal = hasCapacity
    ? diskTotal ?? recordingsUsed + Math.max(diskFree ?? 0, 0)
    : null;
  if (hasCapacity && Number.isFinite(effectiveTotal) && effectiveTotal > 0) {
    dom.storageUsageText.textContent = `${formatBytes(recordingsUsed)} of ${formatBytes(effectiveTotal)} available`;
  } else if (hasCapacity) {
    dom.storageUsageText.textContent = `${formatBytes(recordingsUsed)} of ${formatBytes(Math.max(recordingsUsed, 0))} available`;
  } else {
    dom.storageUsageText.textContent = formatBytes(recordingsUsed);
  }

  let freeHint = diskFree;
  if (freeHint === null && diskTotal !== null) {
    if (diskUsed !== null) {
      freeHint = Math.max(diskTotal - diskUsed, 0);
    } else {
      freeHint = Math.max(diskTotal - recordingsUsed, 0);
    }
  }
  if (Number.isFinite(freeHint)) {
    dom.storageHint.textContent = `Free space: ${formatBytes(freeHint)}`;
  } else {
    dom.storageHint.textContent = "Free space: --";
  }

  const progress = hasCapacity && Number.isFinite(effectiveTotal) && effectiveTotal > 0
    ? clamp((recordingsUsed / effectiveTotal) * 100, 0, 100)
    : 0;
  dom.storageProgress.style.width = `${progress}%`;
  if (state.lastUpdated) {
    dom.lastUpdated.textContent = dateFormatter.format(state.lastUpdated);
  }
}

function setCursorFraction(fraction) {
  const clamped = clamp(fraction, 0, 1);
  waveformState.lastFraction = clamped;
  if (dom.waveformCursor) {
    dom.waveformCursor.style.left = `${(clamped * 100).toFixed(3)}%`;
  }
  updateWaveformClock();
}

function updateWaveformClock() {
  if (!dom.waveformClock) {
    return;
  }
  const element = dom.waveformClock;
  const containerReady = Boolean(dom.waveformContainer && !dom.waveformContainer.hidden);
  const duration = Number.isFinite(waveformState.duration) && waveformState.duration > 0
    ? waveformState.duration
    : null;
  const startEpoch = Number.isFinite(waveformState.startEpoch)
    ? waveformState.startEpoch
    : null;
  if (!containerReady || duration === null || startEpoch === null) {
    element.textContent = "--:--:--";
    element.dataset.active = "false";
    element.setAttribute("aria-hidden", "true");
    return;
  }
  const offsetSeconds = clamp(waveformState.lastFraction, 0, 1) * duration;
  const timestamp = startEpoch + offsetSeconds;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    element.textContent = "--:--:--";
    element.dataset.active = "false";
    element.setAttribute("aria-hidden", "true");
    return;
  }
  element.textContent = formatClockTime(timestamp);
  element.dataset.active = "true";
  element.setAttribute("aria-hidden", "false");
}

function setWaveformMarker(element, seconds, duration) {
  if (!element) {
    return;
  }
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) {
    element.dataset.active = "false";
    element.style.left = "0%";
    element.setAttribute("aria-hidden", "true");
    return;
  }
  const fraction = clamp(seconds / duration, 0, 1);
  element.style.left = `${(fraction * 100).toFixed(3)}%`;
  element.dataset.active = "true";
  element.setAttribute("aria-hidden", "false");
}

function updateWaveformMarkers() {
  const duration = Number.isFinite(waveformState.duration) && waveformState.duration > 0
    ? waveformState.duration
    : 0;
  if (!state.current || duration <= 0) {
    waveformState.triggerSeconds = null;
    waveformState.releaseSeconds = null;
    setWaveformMarker(dom.waveformTriggerMarker, null, null);
    setWaveformMarker(dom.waveformReleaseMarker, null, null);
    return;
  }

  const minGap = MARKER_MIN_GAP_SECONDS;

  let triggerSeconds = toFiniteOrNull(state.current.trigger_offset_seconds);
  if (!Number.isFinite(triggerSeconds)) {
    triggerSeconds = Number.isFinite(configState.prePadSeconds) ? configState.prePadSeconds : null;
  }
  if (Number.isFinite(triggerSeconds)) {
    triggerSeconds = clamp(triggerSeconds, 0, duration);
    if (triggerSeconds <= minGap || triggerSeconds >= duration - minGap) {
      triggerSeconds = null;
    }
  } else {
    triggerSeconds = null;
  }

  let releaseSeconds = toFiniteOrNull(state.current.release_offset_seconds);
  if (!Number.isFinite(releaseSeconds)) {
    if (Number.isFinite(configState.postPadSeconds)) {
      const candidate = duration - configState.postPadSeconds;
      if (candidate > minGap && candidate < duration - minGap) {
        releaseSeconds = candidate;
      }
    }
  }
  if (Number.isFinite(releaseSeconds)) {
    releaseSeconds = clamp(releaseSeconds, 0, duration);
    if (releaseSeconds <= minGap || releaseSeconds >= duration - minGap) {
      releaseSeconds = null;
    }
  } else {
    releaseSeconds = null;
  }

  if (releaseSeconds !== null && triggerSeconds !== null && releaseSeconds - triggerSeconds <= minGap) {
    releaseSeconds = null;
  }

  waveformState.triggerSeconds = triggerSeconds;
  waveformState.releaseSeconds = releaseSeconds;
  setWaveformMarker(dom.waveformTriggerMarker, triggerSeconds, duration);
  setWaveformMarker(dom.waveformReleaseMarker, releaseSeconds, duration);
}

function updateCursorFromPlayer() {
  if (!dom.waveformContainer || dom.waveformContainer.hidden) {
    return;
  }
  const duration = numericValue(dom.player.duration, 0);
  if (duration <= 0) {
    setCursorFraction(0);
    return;
  }
  const fraction = clamp(dom.player.currentTime / duration, 0, 1);
  setCursorFraction(fraction);
}

function handlePlayerLoadedMetadata() {
  if (playbackState.resetOnLoad) {
    try {
      dom.player.currentTime = 0;
    } catch (error) {
      /* ignore seek errors */
    }
  }
  if (playbackState.enforcePauseOnLoad) {
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }
  }
  playbackState.resetOnLoad = false;
  playbackState.enforcePauseOnLoad = false;
  updateCursorFromPlayer();
}

function stopCursorAnimation() {
  if (waveformState.animationFrame) {
    window.cancelAnimationFrame(waveformState.animationFrame);
    waveformState.animationFrame = null;
  }
}

function startCursorAnimation() {
  if (waveformState.animationFrame || !dom.waveformContainer || dom.waveformContainer.hidden) {
    return;
  }
  const step = () => {
    updateCursorFromPlayer();
    waveformState.animationFrame = window.requestAnimationFrame(step);
  };
  waveformState.animationFrame = window.requestAnimationFrame(step);
}

function resetWaveform() {
  stopCursorAnimation();
  waveformState.peaks = null;
  waveformState.duration = 0;
  waveformState.lastFraction = 0;
  waveformState.triggerSeconds = null;
  waveformState.releaseSeconds = null;
  waveformState.peakScale = 32767;
  waveformState.startEpoch = null;
  if (waveformState.abortController) {
    waveformState.abortController.abort();
    waveformState.abortController = null;
  }
  if (dom.waveformContainer) {
    dom.waveformContainer.hidden = true;
    dom.waveformContainer.dataset.ready = "false";
  }
  if (dom.waveformCursor) {
    dom.waveformCursor.style.left = "0%";
  }
  setWaveformMarker(dom.waveformTriggerMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);
  if (dom.waveformEmpty) {
    dom.waveformEmpty.hidden = false;
    dom.waveformEmpty.textContent = "Select a recording to render its waveform.";
  }
  if (dom.waveformStatus) {
    dom.waveformStatus.textContent = "";
  }
  updateWaveformClock();
}

function drawWaveformFromPeaks(peaks) {
  if (!dom.waveformCanvas || !dom.waveformContainer) {
    return;
  }
  const containerWidth = dom.waveformContainer.clientWidth;
  const containerHeight = dom.waveformContainer.clientHeight;
  if (containerWidth <= 0 || containerHeight <= 0) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(containerWidth * dpr));
  const height = Math.max(1, Math.floor(containerHeight * dpr));
  dom.waveformCanvas.width = width;
  dom.waveformCanvas.height = height;
  dom.waveformCanvas.style.width = "100%";
  dom.waveformCanvas.style.height = "100%";

  const ctx = dom.waveformCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const sampleCount = Math.floor(peaks.length / 2);
  ctx.clearRect(0, 0, width, height);
  if (sampleCount <= 0) {
    return;
  }

  const mid = height / 2;
  const amplitude = height / 2;
  const denom = sampleCount > 1 ? sampleCount - 1 : 1;

  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const peak = peaks[i * 2 + 1];
    const y = mid - peak * amplitude;
    ctx.lineTo(x, y);
  }
  for (let i = sampleCount - 1; i >= 0; i -= 1) {
    const x = (i / denom) * width;
    const trough = peaks[i * 2];
    const y = mid - trough * amplitude;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(56, 189, 248, 0.28)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const peak = peaks[i * 2 + 1];
    const y = mid - peak * amplitude;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const trough = peaks[i * 2];
    const y = mid - trough * amplitude;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();

  updateWaveformMarkers();
}

function redrawWaveform() {
  if (waveformState.peaks && dom.waveformContainer && !dom.waveformContainer.hidden) {
    drawWaveformFromPeaks(waveformState.peaks);
    updateCursorFromPlayer();
    updateWaveformMarkers();
  }
}

async function loadWaveform(record) {
  if (!dom.waveformContainer || !dom.waveformEmpty) {
    return;
  }
  if (!record || !record.path) {
    resetWaveform();
    return;
  }
  if (!record.waveform_path) {
    resetWaveform();
    if (dom.waveformEmpty) {
      dom.waveformEmpty.textContent = "Waveform unavailable for this recording.";
    }
    if (dom.waveformStatus) {
      dom.waveformStatus.textContent = "";
    }
    return;
  }
  const requestId = (waveformState.requestId += 1);
  if (waveformState.abortController) {
    waveformState.abortController.abort();
  }
  const controller = new AbortController();
  waveformState.abortController = controller;

  stopCursorAnimation();
  dom.waveformContainer.hidden = true;
  dom.waveformContainer.dataset.ready = "false";
  dom.waveformEmpty.hidden = false;
  dom.waveformEmpty.textContent = "Loading waveform…";
  if (dom.waveformStatus) {
    dom.waveformStatus.textContent = "Loading…";
  }
  setCursorFraction(0);
  waveformState.triggerSeconds = null;
  waveformState.releaseSeconds = null;
  waveformState.startEpoch = null;
  setWaveformMarker(dom.waveformTriggerMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);

  try {
    const response = await fetch(recordingUrl(record.waveform_path), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`waveform request failed with status ${response.status}`);
    }
    const payload = await response.json();
    if (waveformState.requestId !== requestId) {
      return;
    }

    const peaksData = Array.isArray(payload.peaks) ? payload.peaks : [];
    const peakScale = Number.isFinite(payload.peak_scale) && Number(payload.peak_scale) > 0
      ? Number(payload.peak_scale)
      : 32767;
    const sampleCount = Math.floor(peaksData.length / 2);
    if (sampleCount <= 0) {
      throw new Error("waveform payload missing peaks");
    }

    const normalized = new Float32Array(sampleCount * 2);
    for (let i = 0; i < sampleCount * 2; i += 1) {
      const raw = Number(peaksData[i]);
      if (!Number.isFinite(raw)) {
        normalized[i] = 0;
      } else {
        normalized[i] = clamp(raw / peakScale, -1, 1);
      }
    }

    const existingDuration = Number.isFinite(record.duration_seconds) && record.duration_seconds > 0
      ? Number(record.duration_seconds)
      : null;
    const payloadDuration = Number(payload.duration_seconds);
    const effectiveDuration = Number.isFinite(payloadDuration) && payloadDuration > 0
      ? payloadDuration
      : existingDuration ?? 0;

    waveformState.peaks = normalized;
    waveformState.peakScale = peakScale;
    waveformState.duration = effectiveDuration;
    record.duration_seconds = effectiveDuration;

    let startEpoch = Number.isFinite(record.start_epoch)
      ? Number(record.start_epoch)
      : null;
    if (startEpoch === null && Number.isFinite(record.started_epoch)) {
      startEpoch = Number(record.started_epoch);
    }
    if (
      startEpoch === null &&
      typeof record.started_at === "string" &&
      record.started_at.trim() !== ""
    ) {
      const parsedStartedAt = Date.parse(record.started_at);
      if (!Number.isNaN(parsedStartedAt)) {
        startEpoch = parsedStartedAt / 1000;
      }
    }
    let endEpoch = Number.isFinite(record.modified) ? Number(record.modified) : null;
    if (endEpoch === null && typeof record.modified_iso === "string" && record.modified_iso) {
      const parsedModified = Date.parse(record.modified_iso);
      if (!Number.isNaN(parsedModified)) {
        endEpoch = parsedModified / 1000;
      }
    }
    if (startEpoch === null && Number.isFinite(endEpoch) && effectiveDuration > 0) {
      startEpoch = endEpoch - effectiveDuration;
    }
    if (Number.isFinite(startEpoch) && effectiveDuration > 0) {
      waveformState.startEpoch = startEpoch;
      record.start_epoch = startEpoch;
    } else {
      waveformState.startEpoch = null;
      delete record.start_epoch;
    }

    dom.waveformContainer.hidden = false;
    dom.waveformContainer.dataset.ready = "true";
    dom.waveformEmpty.hidden = true;
    drawWaveformFromPeaks(normalized);
    updateCursorFromPlayer();
    updateWaveformMarkers();
    updateWaveformClock();
    startCursorAnimation();

    if (dom.waveformStatus) {
      const message = effectiveDuration > 0
        ? `Length: ${formatDuration(effectiveDuration)}`
        : "Waveform ready";
      dom.waveformStatus.textContent = message;
    }

    if (existingDuration === null || Math.abs(effectiveDuration - existingDuration) > 0.05) {
      renderRecords();
    }
    updatePlayerMeta(record);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.error("Failed to load waveform", error);
    if (waveformState.requestId === requestId) {
      waveformState.peaks = null;
      waveformState.duration = 0;
      waveformState.startEpoch = null;
      dom.waveformContainer.hidden = true;
      dom.waveformContainer.dataset.ready = "false";
      dom.waveformEmpty.hidden = false;
      dom.waveformEmpty.textContent = "Waveform unavailable for this recording.";
      if (dom.waveformStatus) {
        dom.waveformStatus.textContent = "";
      }
      updateWaveformClock();
    }
  } finally {
    if (waveformState.abortController === controller) {
      waveformState.abortController = null;
    }
  }
}

function seekFromPointer(event) {
  if (!dom.waveformContainer || dom.waveformContainer.hidden) {
    return;
  }
  const rect = dom.waveformContainer.getBoundingClientRect();
  if (rect.width <= 0) {
    return;
  }
  const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const duration = numericValue(dom.player.duration, 0);
  if (duration <= 0) {
    return;
  }
  dom.player.currentTime = fraction * duration;
  setCursorFraction(fraction);
}

function handleWaveformPointerDown(event) {
  event.stopPropagation();
  if (!Number.isFinite(dom.player.duration) || dom.player.duration <= 0) {
    return;
  }
  waveformState.isScrubbing = true;
  waveformState.pointerId = event.pointerId;
  try {
    dom.waveformContainer.setPointerCapture(event.pointerId);
  } catch (err) {
    /* ignore capture errors */
  }
  seekFromPointer(event);
  event.preventDefault();
}

function handleWaveformPointerMove(event) {
  event.stopPropagation();
  if (!waveformState.isScrubbing || event.pointerId !== waveformState.pointerId) {
    return;
  }
  seekFromPointer(event);
}

function handleWaveformPointerUp(event) {
  event.stopPropagation();
  if (event.pointerId !== waveformState.pointerId) {
    return;
  }
  waveformState.isScrubbing = false;
  waveformState.pointerId = null;
  try {
    dom.waveformContainer.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* ignore release errors */
  }
  updateCursorFromPlayer();
}

function isMediaElement(value) {
  if (!value) {
    return false;
  }
  if (typeof HTMLMediaElement === "undefined") {
    return typeof value.pause === "function" && typeof value.play === "function";
  }
  return value instanceof HTMLMediaElement;
}

function getControllableAudioPlayers() {
  const players = [];
  if (isMediaElement(dom.player)) {
    players.push(dom.player);
  }
  if (isMediaElement(dom.liveAudio)) {
    players.push(dom.liveAudio);
  }
  return players;
}

function hasPlayableSource(media) {
  if (!media) {
    return false;
  }
  if (typeof media.currentSrc === "string" && media.currentSrc.trim() !== "") {
    return true;
  }
  if (typeof media.src === "string") {
    const src = media.src.trim();
    if (src !== "" && src !== window.location.href) {
      return true;
    }
  }
  return false;
}

function shouldIgnoreSpacebarTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const interactiveSelector =
    "input, textarea, select, button, [role='button'], [role='textbox'], [role='combobox'], [role='listbox'], a[href], summary";
  if (target.closest(interactiveSelector)) {
    return true;
  }
  const tagName = target.tagName;
  return tagName === "AUDIO" || tagName === "VIDEO";
}

function isArrowKey(event, name) {
  const fallback = name.startsWith("Arrow") ? name.slice(5) : name;
  return event.key === name || event.code === name || event.key === fallback;
}

function canUseKeyboardJog() {
  return (
    dom.player &&
    hasPlayableSource(dom.player) &&
    Number.isFinite(dom.player.duration) &&
    dom.player.duration > 0
  );
}

function startKeyboardJog(direction) {
  if (!Number.isFinite(direction) || direction === 0) {
    return transportState.isJogging;
  }
  if (!canUseKeyboardJog()) {
    return false;
  }

  transportState.direction = direction;

  const wasJogging = transportState.isJogging;
  if (!wasJogging) {
    transportState.wasPlaying = dom.player ? !dom.player.paused && !dom.player.ended : false;
    transportState.isJogging = true;
    transportState.lastTimestamp = null;
  }

  try {
    dom.player.pause();
  } catch (error) {
    /* ignore pause errors */
  }

  if (!wasJogging) {
    if (transportState.animationFrame) {
      window.cancelAnimationFrame(transportState.animationFrame);
    }
    transportState.animationFrame = window.requestAnimationFrame(performKeyboardJogStep);
  }

  return true;
}

function performKeyboardJogStep(timestamp) {
  if (!transportState.isJogging) {
    transportState.animationFrame = null;
    transportState.lastTimestamp = null;
    return;
  }

  if (!canUseKeyboardJog()) {
    transportState.keys.clear();
    stopKeyboardJog(false);
    return;
  }

  if (transportState.lastTimestamp !== null) {
    const deltaSeconds = (timestamp - transportState.lastTimestamp) / 1000;
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0 && transportState.direction !== 0) {
      const duration = dom.player.duration;
      const currentTime = Number.isFinite(dom.player.currentTime) ? dom.player.currentTime : 0;
      const offset = transportState.direction * KEYBOARD_JOG_RATE_SECONDS_PER_SECOND * deltaSeconds;
      const nextTime = clamp(currentTime + offset, 0, duration);
      dom.player.currentTime = nextTime;
      updateCursorFromPlayer();
    }
  }

  transportState.lastTimestamp = timestamp;
  transportState.animationFrame = window.requestAnimationFrame(performKeyboardJogStep);
}

function stopKeyboardJog(resumePlayback) {
  if (transportState.animationFrame) {
    window.cancelAnimationFrame(transportState.animationFrame);
    transportState.animationFrame = null;
  }
  transportState.lastTimestamp = null;
  transportState.direction = 0;

  if (!transportState.isJogging) {
    transportState.wasPlaying = false;
    return;
  }

  transportState.isJogging = false;
  updateCursorFromPlayer();

  const shouldResume =
    resumePlayback &&
    transportState.wasPlaying &&
    dom.player &&
    hasPlayableSource(dom.player);
  transportState.wasPlaying = false;
  if (shouldResume) {
    dom.player.play().catch(() => undefined);
  }
}

function cancelKeyboardJog() {
  transportState.keys.clear();
  stopKeyboardJog(false);
}

function selectAdjacentRecord(offset) {
  if (!Number.isFinite(offset) || offset === 0) {
    return false;
  }

  const records = getVisibleRecords();
  if (!records.length) {
    return false;
  }

  const currentPath = state.current ? state.current.path : null;
  let index = -1;
  if (currentPath) {
    index = records.findIndex((record) => record.path === currentPath);
  }

  let nextIndex;
  if (index === -1) {
    nextIndex = offset > 0 ? 0 : records.length - 1;
  } else {
    nextIndex = clamp(index + offset, 0, records.length - 1);
  }

  if (nextIndex === index || nextIndex < 0 || nextIndex >= records.length) {
    return false;
  }

  const nextRecord = records[nextIndex];
  const row = findRowForRecord(nextRecord);
  setNowPlaying(nextRecord, { autoplay: false, resetToStart: true, sourceRow: row ?? null });
  if (row && typeof row.scrollIntoView === "function") {
    try {
      row.scrollIntoView({ block: "nearest" });
    } catch (error) {
      /* ignore scrolling errors */
    }
  }
  return true;
}

async function handleTransportKeydown(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (confirmDialogState.open) {
    return;
  }

  const isLeft = isArrowKey(event, "ArrowLeft");
  const isRight = isArrowKey(event, "ArrowRight");
  if (isLeft || isRight) {
    if (shouldIgnoreSpacebarTarget(event.target)) {
      return;
    }

    const keyId = isLeft ? "ArrowLeft" : "ArrowRight";
    transportState.keys.add(keyId);
    const started = startKeyboardJog(isLeft ? -1 : 1);
    if (!started) {
      transportState.keys.delete(keyId);
      return;
    }
    event.preventDefault();
    return;
  }

  const isUp = isArrowKey(event, "ArrowUp");
  const isDown = isArrowKey(event, "ArrowDown");
  if (isUp || isDown) {
    if (shouldIgnoreSpacebarTarget(event.target)) {
      return;
    }

    const moved = selectAdjacentRecord(isDown ? 1 : -1);
    if (moved) {
      event.preventDefault();
    }
    return;
  }

  const isDelete = event.key === "Delete" || event.code === "Delete" || event.key === "Del";
  if (isDelete) {
    if (shouldIgnoreSpacebarTarget(event.target)) {
      return;
    }
    if (!state.current || typeof state.current.path !== "string" || !state.current.path) {
      return;
    }
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    await requestRecordDeletion(state.current, { bypassConfirm: event.shiftKey });
  }
}

function handleTransportKeyup(event) {
  const isLeft = isArrowKey(event, "ArrowLeft");
  const isRight = isArrowKey(event, "ArrowRight");
  if (!isLeft && !isRight) {
    return;
  }

  const keyId = isLeft ? "ArrowLeft" : "ArrowRight";
  if (transportState.keys.has(keyId)) {
    transportState.keys.delete(keyId);
  }

  const hasRight = transportState.keys.has("ArrowRight");
  const hasLeft = transportState.keys.has("ArrowLeft");
  if (!hasLeft && !hasRight) {
    stopKeyboardJog(true);
    return;
  }

  startKeyboardJog(hasRight ? 1 : -1);
}

function resumeDefaultPlayers() {
  playbackState.pausedViaSpacebar.clear();
  if (dom.player && state.current && hasPlayableSource(dom.player)) {
    dom.player.play().catch(() => undefined);
    return;
  }
  if (dom.liveAudio && liveState.active && hasPlayableSource(dom.liveAudio)) {
    dom.liveAudio.play().catch(() => undefined);
    return;
  }
  const fallback = getControllableAudioPlayers().find((media) => hasPlayableSource(media));
  if (fallback) {
    fallback.play().catch(() => undefined);
  }
}

function handleSpacebarShortcut(event) {
  const isSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
  if (!isSpace || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (shouldIgnoreSpacebarTarget(event.target)) {
    return;
  }

  event.preventDefault();

  const players = getControllableAudioPlayers();
  const playing = players.filter((media) => media && !media.paused);

  if (playing.length > 0) {
    playbackState.pausedViaSpacebar.clear();
    for (const media of playing) {
      playbackState.pausedViaSpacebar.add(media);
      try {
        media.pause();
      } catch (error) {
        /* ignore pause errors */
      }
    }
    return;
  }

  const paused = Array.from(playbackState.pausedViaSpacebar).filter((media) => media && media.paused);
  if (paused.length > 0) {
    playbackState.pausedViaSpacebar.clear();
    for (const media of paused) {
      media.play().catch(() => undefined);
    }
    return;
  }

  resumeDefaultPlayers();
}

async function fetchRecordings(options = {}) {
  const { silent = false } = options;
  if (fetchInFlight) {
    fetchQueued = true;
    return;
  }
  fetchInFlight = true;

  if (dom.refreshButton) {
    dom.refreshButton.disabled = true;
  }
  scheduleRefreshIndicator();

  const params = new URLSearchParams();
  if (state.filters.search) {
    params.set("search", state.filters.search);
  }
  if (state.filters.day) {
    params.set("day", state.filters.day);
  }
  params.set("limit", String(state.filters.limit));

  const endpoint = `/api/recordings?${params.toString()}`;
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const normalizedRecords = items.map((item) => ({
      ...item,
      size_bytes: numericValue(item.size_bytes, 0),
      modified: numericValue(item.modified, 0),
      duration_seconds: Number.isFinite(item.duration_seconds)
        ? Number(item.duration_seconds)
        : null,
      start_epoch: toFiniteOrNull(item.start_epoch),
      started_at:
        typeof item.started_at === "string" && item.started_at
          ? String(item.started_at)
          : "",
      trigger_offset_seconds: toFiniteOrNull(item.trigger_offset_seconds),
      release_offset_seconds: toFiniteOrNull(item.release_offset_seconds),
      waveform_path:
        typeof item.waveform_path === "string" && item.waveform_path
          ? String(item.waveform_path)
          : null,
    }));
    const nextFingerprint = computeRecordsFingerprint(normalizedRecords);
    const recordsChanged = state.recordsFingerprint !== nextFingerprint;
    state.records = normalizedRecords;
    state.recordsFingerprint = nextFingerprint;
    state.total = Number.isFinite(payload.total)
      ? Number(payload.total)
      : state.records.length;
    state.filteredSize = numericValue(payload.total_size_bytes, 0);
    state.storage.recordings = numericValue(payload.recordings_total_bytes, state.filteredSize);
    state.storage.total = toFiniteOrNull(payload.storage_total_bytes);
    state.storage.free = toFiniteOrNull(payload.storage_free_bytes);
    state.storage.diskUsed = toFiniteOrNull(payload.storage_used_bytes);
    state.availableDays = Array.isArray(payload.available_days) ? payload.available_days : [];
    state.lastUpdated = new Date();
    populateFilters();
    updateSortIndicators();

    let maintainCurrentSelection = true;
    if (pendingSelectionPath) {
      const candidatePath = pendingSelectionPath;
      pendingSelectionPath = null;
      const nextRecord = state.records.find((entry) => entry.path === candidatePath);
      if (nextRecord) {
        setNowPlaying(nextRecord, { autoplay: false, resetToStart: true });
        maintainCurrentSelection = false;
      }
    }

    if (maintainCurrentSelection && state.current) {
      const current = state.records.find((entry) => entry.path === state.current.path);
      if (current) {
        state.current = current;
        updatePlayerMeta(current);
        updateWaveformMarkers();
      } else {
        setNowPlaying(null);
      }
    }

    if (recordsChanged) {
      renderRecords();
    } else {
      updateSelectionUI();
      applyNowPlayingHighlight();
      syncPlayerPlacement();
    }
    updateStats();
    setRecordingIndicatorStatus(payload.capture_status);
    handleFetchSuccess();
  } catch (error) {
    console.error("Failed to load recordings", error);
    state.records = [];
    state.recordsFingerprint = "";
    state.total = 0;
    state.filteredSize = 0;
    state.storage.recordings = 0;
    state.storage.total = null;
    state.storage.free = null;
    state.storage.diskUsed = null;
    state.lastUpdated = null;
    renderRecords();
    updateStats();
    handleFetchFailure();
    setRecordingIndicatorUnknown();
    if (dom.lastUpdated) {
      dom.lastUpdated.textContent = "Offline";
    }
    fetchQueued = false;
  } finally {
    hideRefreshIndicator();
    if (dom.refreshButton) {
      dom.refreshButton.disabled = false;
    }
    fetchInFlight = false;
    if (fetchQueued) {
      fetchQueued = false;
      fetchRecordings({ silent: true });
    }
  }
}

async function fetchConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Config request failed with ${response.status}`);
    }
    const payload = await response.json();
    dom.configViewer.textContent = JSON.stringify(payload, null, 2);
    const segmenterCfg = payload && typeof payload === "object" ? payload.segmenter : null;
    const prePadMs = segmenterCfg && typeof segmenterCfg === "object"
      ? toFiniteOrNull(segmenterCfg.pre_pad_ms)
      : null;
    const postPadMs = segmenterCfg && typeof segmenterCfg === "object"
      ? toFiniteOrNull(segmenterCfg.post_pad_ms)
      : null;
    configState.prePadSeconds = prePadMs !== null && prePadMs >= 0 ? prePadMs / 1000 : null;
    configState.postPadSeconds = postPadMs !== null && postPadMs >= 0 ? postPadMs / 1000 : null;
    updateWaveformMarkers();
  } catch (error) {
    console.error("Failed to fetch config", error);
    dom.configViewer.textContent = "Unable to load configuration.";
  }
}

async function requestRecordDeletion(record, options = {}) {
  const { bypassConfirm = false } = options;
  if (!record || typeof record.path !== "string" || record.path.trim() === "") {
    return;
  }

  if (!bypassConfirm) {
    const baseName =
      typeof record.name === "string" && record.name ? record.name : record.path;
    const extLabel = record.extension ? `.${record.extension}` : "";
    const confirmed = await confirmDeletionPrompt(
      `Delete ${baseName}${extLabel}?`,
      "Delete recording",
    );
    if (!confirmed) {
      return;
    }
  }

  await deleteRecordings([record.path]);
}

function findNextSelectionPath(paths) {
  if (!state.current || !Array.isArray(paths) || paths.length !== 1) {
    return null;
  }

  const [targetPath] = paths;
  if (typeof targetPath !== "string" || targetPath !== state.current.path) {
    return null;
  }

  const visible = getVisibleRecords();
  if (!visible.length) {
    return null;
  }

  const currentIndex = visible.findIndex((record) => record.path === targetPath);
  if (currentIndex === -1) {
    return null;
  }

  for (let index = currentIndex + 1; index < visible.length; index += 1) {
    const candidate = visible[index];
    if (candidate.path !== targetPath) {
      return candidate.path;
    }
  }

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = visible[index];
    if (candidate.path !== targetPath) {
      return candidate.path;
    }
  }

  return null;
}

async function deleteRecordings(paths) {
  if (!paths || !paths.length) {
    return;
  }
  const nextSelectionPath = findNextSelectionPath(paths);
  try {
    const response = await fetch("/api/recordings/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: paths }),
    });
    if (!response.ok) {
      throw new Error(`Delete failed with status ${response.status}`);
    }
    const payload = await response.json();
    const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
    if (
      nextSelectionPath &&
      paths.length === 1 &&
      typeof paths[0] === "string" &&
      deleted.includes(paths[0])
    ) {
      pendingSelectionPath = nextSelectionPath;
    }
    for (const path of deleted) {
      state.selections.delete(path);
      if (state.current && state.current.path === path) {
        setNowPlaying(null);
      }
    }
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const message = payload.errors.map((entry) => `${entry.item}: ${entry.error}`).join("\n");
      window.alert(`Some files could not be deleted:\n${message}`);
    }
  } catch (error) {
    console.error("Deletion request failed", error);
    window.alert("Unable to delete selected recordings.");
  } finally {
    await fetchRecordings({ silent: false });
  }
}

function applyFiltersFromInputs() {
  state.filters.search = dom.filterSearch.value.trim();
  state.filters.day = dom.filterDay.value.trim();
  const parsedLimit = Number.parseInt(dom.filterLimit.value, 10);
  if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
    state.filters.limit = Math.min(Math.max(parsedLimit, 1), 1000);
  } else if (dom.filterLimit) {
    dom.filterLimit.value = String(state.filters.limit);
  }
}

function clearFilters() {
  dom.filterSearch.value = "";
  dom.filterDay.value = "";
  dom.filterLimit.value = "500";
  state.filters = { search: "", day: "", limit: 500 };
}

function nativeHlsSupported(audio) {
  return (
    audio.canPlayType("application/vnd.apple.mpegurl") ||
    audio.canPlayType("application/x-mpegURL")
  );
}

function loadHlsLibrary() {
  if (window.Hls && typeof window.Hls.isSupported === "function") {
    return Promise.resolve(window.Hls);
  }
  if (liveState.scriptPromise) {
    return liveState.scriptPromise;
  }
  liveState.scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
    script.async = true;
    script.onload = () => {
      if (window.Hls) {
        resolve(window.Hls);
      } else {
        reject(new Error("hls.js unavailable"));
      }
    };
    script.onerror = () => reject(new Error("Failed to load hls.js"));
    document.body.append(script);
  }).catch((error) => {
    console.error("Unable to load hls.js", error);
    liveState.scriptPromise = null;
    throw error;
  });
  return liveState.scriptPromise;
}

function generateSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    return Array.from(arr, (x) => x.toString(16).padStart(2, "0")).join("");
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
  } catch (error) {
    /* ignore storage errors */
  }

  if (typeof window.name === "string" && window.name.startsWith(WINDOW_NAME_PREFIX)) {
    return window.name.slice(WINDOW_NAME_PREFIX.length);
  }

  return null;
}

function persistSessionId(id) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch (error) {
    /* ignore storage errors */
  }

  try {
    window.name = `${WINDOW_NAME_PREFIX}${id}`;
  } catch (error) {
    /* ignore window.name assignment errors */
  }
}

function ensureSessionId() {
  if (liveState.sessionId) {
    return liveState.sessionId;
  }

  const existing = readSessionFromStorage();
  if (existing) {
    liveState.sessionId = existing;
    persistSessionId(existing);
    return existing;
  }

  const generated = generateSessionId();
  liveState.sessionId = generated;
  persistSessionId(generated);
  return generated;
}

function withSession(path) {
  const id = ensureSessionId();
  if (!id) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}session=${encodeURIComponent(id)}`;
}

function sendStart() {
  fetch(withSession(START_ENDPOINT), { cache: "no-store" }).catch(() => undefined);
}

function sendStop(useBeacon) {
  const url = withSession(STOP_ENDPOINT);
  if (useBeacon && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(url, "");
      return;
    } catch (error) {
      /* fall back to fetch */
    }
  }
  fetch(url, { cache: "no-store", keepalive: true }).catch(() => undefined);
}

async function refreshLiveStats() {
  try {
    const response = await fetch(STATS_ENDPOINT, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`stats ${response.status}`);
    }
    const payload = await response.json();
    if (dom.liveClients) {
      dom.liveClients.textContent = String(payload.active_clients ?? 0);
    }
    if (dom.liveEncoder) {
      dom.liveEncoder.textContent = payload.encoder_running ? "running" : "stopped";
    }
  } catch (error) {
    console.debug("Failed to fetch live stats", error);
  }
}

function scheduleLiveStats() {
  cancelLiveStats();
  refreshLiveStats();
  liveState.statsTimer = window.setInterval(refreshLiveStats, 2000);
}

function cancelLiveStats() {
  if (liveState.statsTimer) {
    window.clearInterval(liveState.statsTimer);
    liveState.statsTimer = null;
  }
}

function setLiveStatus(text) {
  if (dom.liveStatus) {
    dom.liveStatus.textContent = text;
  }
}

function setLiveButtonState(active) {
  if (!dom.liveToggle) {
    return;
  }
  dom.liveToggle.setAttribute("aria-pressed", active ? "true" : "false");
  dom.liveToggle.textContent = active ? "Stop Stream" : "Live Stream";
}

function attachLiveStreamSource() {
  if (!dom.liveAudio) {
    return;
  }
  detachLiveStream();
  dom.liveAudio.autoplay = true;
  if (nativeHlsSupported(dom.liveAudio)) {
    dom.liveAudio.src = HLS_URL;
    dom.liveAudio.play().catch(() => undefined);
    return;
  }

  loadHlsLibrary()
    .then(() => {
      if (!liveState.open) {
        return;
      }
      if (window.Hls && window.Hls.isSupported()) {
        liveState.hls = new window.Hls({ lowLatencyMode: true });
        liveState.hls.loadSource(HLS_URL);
        liveState.hls.attachMedia(dom.liveAudio);
      } else {
        dom.liveAudio.src = HLS_URL;
      }
      dom.liveAudio.play().catch(() => undefined);
    })
    .catch(() => {
      dom.liveAudio.src = HLS_URL;
      dom.liveAudio.play().catch(() => undefined);
    });
}

function detachLiveStream() {
  if (liveState.hls) {
    try {
      liveState.hls.destroy();
    } catch (error) {
      console.warn("Failed to destroy hls.js instance", error);
    }
    liveState.hls = null;
  }
  if (dom.liveAudio) {
    dom.liveAudio.pause();
    dom.liveAudio.removeAttribute("src");
    dom.liveAudio.load();
    playbackState.pausedViaSpacebar.delete(dom.liveAudio);
  }
}

function startLiveStream() {
  if (liveState.active) {
    return;
  }
  if (!dom.liveAudio) {
    return;
  }
  ensureSessionId();
  liveState.active = true;
  setLiveStatus("Connecting…");
  sendStart();
  attachLiveStreamSource();
  scheduleLiveStats();
}

function stopLiveStream({ sendSignal = true, useBeacon = false } = {}) {
  if (sendSignal) {
    sendStop(useBeacon);
  }
  cancelLiveStats();
  detachLiveStream();
  liveState.active = false;
  if (dom.liveClients) {
    dom.liveClients.textContent = "0";
  }
  if (dom.liveEncoder) {
    dom.liveEncoder.textContent = "stopped";
  }
  setLiveStatus("Idle");
}

function openLiveStreamPanel() {
  if (liveState.open) {
    return;
  }
  liveState.open = true;
  if (dom.liveCard) {
    dom.liveCard.hidden = false;
    dom.liveCard.dataset.active = "true";
    dom.liveCard.setAttribute("aria-hidden", "false");
  }
  if (dom.livePanel) {
    dom.livePanel.classList.add("expanded");
    dom.livePanel.setAttribute("aria-hidden", "false");
  }
  setLiveButtonState(true);
  startLiveStream();
}

function closeLiveStreamPanel() {
  if (!liveState.open) {
    return;
  }
  liveState.open = false;
  if (dom.livePanel) {
    dom.livePanel.classList.remove("expanded");
    dom.livePanel.setAttribute("aria-hidden", "true");
  }
  if (dom.liveCard) {
    dom.liveCard.dataset.active = "false";
    dom.liveCard.hidden = true;
    dom.liveCard.setAttribute("aria-hidden", "true");
  }
  setLiveButtonState(false);
  stopLiveStream({ sendSignal: true });
}

function attachEventListeners() {
  dom.applyFilters.addEventListener("click", () => {
    applyFiltersFromInputs();
    state.selections.clear();
    fetchRecordings({ silent: false });
    updateSelectionUI();
  });

  dom.filterSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dom.applyFilters.click();
    }
  });

  dom.clearFilters.addEventListener("click", () => {
    clearFilters();
    state.selections.clear();
    fetchRecordings({ silent: false });
    updateSelectionUI();
  });

  if (dom.refreshButton) {
    dom.refreshButton.addEventListener("click", () => {
      fetchRecordings({ silent: false });
    });
  }

  for (const button of dom.sortButtons) {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (!key) {
        return;
      }
      if (state.sort.key === key) {
        state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.direction = "asc";
      }
      updateSortIndicators();
      renderRecords();
    });
  }

  dom.toggleAll.addEventListener("change", (event) => {
    const records = getVisibleRecords();
    if (event.target.checked) {
      for (const record of records) {
        state.selections.add(record.path);
      }
    } else {
      for (const record of records) {
        state.selections.delete(record.path);
      }
    }
    renderRecords();
  });

  dom.selectAll.addEventListener("click", () => {
    const records = getVisibleRecords();
    for (const record of records) {
      state.selections.add(record.path);
    }
    renderRecords();
  });

  dom.clearSelection.addEventListener("click", () => {
    state.selections.clear();
    renderRecords();
  });

  dom.deleteSelected.addEventListener("click", async () => {
    if (!state.selections.size) {
      return;
    }
    const count = state.selections.size;
    const message = `Delete ${count} selected recording${count === 1 ? "" : "s"}?`;
    const title = count === 1 ? "Delete recording" : "Delete recordings";
    const confirmed = await confirmDeletionPrompt(message, title);
    if (!confirmed) {
      return;
    }
    const paths = Array.from(state.selections.values());
    await deleteRecordings(paths);
  });

  if (dom.waveformContainer) {
    dom.waveformContainer.addEventListener("pointerdown", handleWaveformPointerDown);
    dom.waveformContainer.addEventListener("pointermove", handleWaveformPointerMove);
    dom.waveformContainer.addEventListener("pointerup", handleWaveformPointerUp);
    dom.waveformContainer.addEventListener("pointercancel", handleWaveformPointerUp);
    dom.waveformContainer.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  window.addEventListener("resize", redrawWaveform);
  window.addEventListener("resize", syncPlayerPlacement);
  window.addEventListener("keydown", handleTransportKeydown);
  window.addEventListener("keyup", handleTransportKeyup);
  window.addEventListener("blur", cancelKeyboardJog);
  window.addEventListener("keydown", handleSpacebarShortcut);

  const suppressPlayerPropagation = (event) => {
    event.stopPropagation();
  };

  dom.player.addEventListener("click", suppressPlayerPropagation);
  dom.player.addEventListener("dblclick", suppressPlayerPropagation);
  dom.player.addEventListener("pointerdown", suppressPlayerPropagation);
  dom.player.addEventListener("pointerup", suppressPlayerPropagation);

  dom.player.addEventListener("play", () => {
    playbackState.pausedViaSpacebar.delete(dom.player);
    startCursorAnimation();
  });
  dom.player.addEventListener("pause", () => {
    stopCursorAnimation();
    updateCursorFromPlayer();
  });
  dom.player.addEventListener("timeupdate", updateCursorFromPlayer);
  dom.player.addEventListener("seeked", updateCursorFromPlayer);
  dom.player.addEventListener("loadedmetadata", handlePlayerLoadedMetadata);
  dom.player.addEventListener("ended", () => {
    applyNowPlayingHighlight();
    stopCursorAnimation();
    updateCursorFromPlayer();
    playbackState.pausedViaSpacebar.delete(dom.player);
  });
  dom.player.addEventListener("emptied", () => {
    playbackState.pausedViaSpacebar.delete(dom.player);
    playbackState.resetOnLoad = false;
    playbackState.enforcePauseOnLoad = false;
  });

  if (dom.liveToggle) {
    dom.liveToggle.addEventListener("click", () => {
      if (liveState.open) {
        closeLiveStreamPanel();
      } else {
        openLiveStreamPanel();
      }
    });
  }

  if (dom.liveClose) {
    dom.liveClose.addEventListener("click", () => {
      closeLiveStreamPanel();
    });
  }

  if (dom.previewClose) {
    dom.previewClose.addEventListener("click", () => {
      setNowPlaying(null);
    });
  }

  if (dom.liveAudio) {
    dom.liveAudio.addEventListener("playing", () => {
      playbackState.pausedViaSpacebar.delete(dom.liveAudio);
      if (liveState.open) {
        setLiveStatus("Live");
      }
    });
    dom.liveAudio.addEventListener("waiting", () => {
      if (liveState.open) {
        setLiveStatus("Buffering…");
      }
    });
    dom.liveAudio.addEventListener("pause", () => {
      if (!liveState.open) {
        return;
      }
      if (liveState.active) {
        setLiveStatus("Paused");
      } else {
        setLiveStatus("Idle");
      }
    });
    dom.liveAudio.addEventListener("error", () => {
      setLiveStatus("Unavailable");
    });
    dom.liveAudio.addEventListener("stalled", () => {
      if (liveState.open) {
        setLiveStatus("Buffering…");
      }
    });
    dom.liveAudio.addEventListener("ended", () => {
      playbackState.pausedViaSpacebar.delete(dom.liveAudio);
    });
  }

  window.addEventListener("beforeunload", () => {
    stopAutoRefresh();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  window.addEventListener("pagehide", () => {
    stopAutoRefresh();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAutoRefresh();
      if (liveState.open) {
        cancelLiveStats();
        sendStop(false);
        if (dom.liveAudio) {
          dom.liveAudio.pause();
        }
      }
    } else {
      startAutoRefresh();
      if (liveState.open && liveState.active) {
        scheduleLiveStats();
        sendStart();
        if (dom.liveAudio) {
          dom.liveAudio.play().catch(() => undefined);
        }
      }
    }
  });

  if (mobileLayoutQuery) {
    const handleLayoutChange = () => {
      syncPlayerPlacement();
    };
    if (typeof mobileLayoutQuery.addEventListener === "function") {
      mobileLayoutQuery.addEventListener("change", handleLayoutChange);
    } else if (typeof mobileLayoutQuery.addListener === "function") {
      mobileLayoutQuery.addListener(handleLayoutChange);
    }
  }
}

function initialize() {
  populateFilters();
  updateSelectionUI();
  updateSortIndicators();
  resetWaveform();
  setRecordingIndicatorUnknown("Loading status…");
  setRefreshIndicatorVisible(false);
  setLiveButtonState(false);
  setLiveStatus("Idle");
  attachEventListeners();
  fetchRecordings({ silent: false });
  fetchConfig();
  startAutoRefresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}
