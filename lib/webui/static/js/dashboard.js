function normalizeApiBase(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

const API_BASE = (() => {
  if (typeof window === "undefined") {
    return "";
  }
  const globalBase = normalizeApiBase(window.TRICORDER_API_BASE);
  if (globalBase) {
    return globalBase;
  }
  if (typeof document !== "undefined" && document.body && document.body.dataset) {
    const dataBase = normalizeApiBase(document.body.dataset.tricorderApiBase);
    if (dataBase) {
      return dataBase;
    }
  }
  return "";
})();

function apiPath(path) {
  if (!path) {
    return API_BASE;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE) {
    return normalized;
  }
  if (normalized === "/") {
    return API_BASE;
  }
  return `${API_BASE}${normalized}`;
}

const AUTO_REFRESH_INTERVAL_MS = 1000;
const OFFLINE_REFRESH_INTERVAL_MS = 5000;
const REFRESH_INDICATOR_DELAY_MS = 600;
const MARKER_MIN_GAP_SECONDS = 0.05;
const KEYBOARD_JOG_RATE_SECONDS_PER_SECOND = 4;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const FILTER_STORAGE_KEY = "tricorder.dashboard.filters";
const THEME_STORAGE_KEY = "tricorder.dashboard.theme";

const HLS_URL = apiPath("/hls/live.m3u8");
const START_ENDPOINT = apiPath("/hls/start");
const STOP_ENDPOINT = apiPath("/hls/stop");
const STATS_ENDPOINT = apiPath("/hls/stats");
const SERVICES_ENDPOINT = apiPath("/api/services");
const SERVICE_REFRESH_INTERVAL_MS = 5000;
const SERVICE_RESULT_TTL_MS = 15000;
const SESSION_STORAGE_KEY = "tricorder.session";
const WINDOW_NAME_PREFIX = "tricorder.session:";

const state = {
  filters: {
    search: "",
    day: "",
    limit: DEFAULT_LIMIT,
  },
  records: [],
  recordsFingerprint: "",
  total: 0,
  filteredSize: 0,
  offset: 0,
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
  themeToggle: document.getElementById("theme-toggle"),
  connectionStatus: document.getElementById("connection-status"),
  recordingIndicator: document.getElementById("recording-indicator"),
  recordingIndicatorText: document.getElementById("recording-indicator-text"),
  applyFilters: document.getElementById("apply-filters"),
  clearFilters: document.getElementById("clear-filters"),
  filterSearch: document.getElementById("filter-search"),
  filterDay: document.getElementById("filter-day"),
  filterLimit: document.getElementById("filter-limit"),
  resultsSummary: document.getElementById("results-summary"),
  paginationControls: document.getElementById("pagination-controls"),
  paginationStatus: document.getElementById("pagination-status"),
  pagePrev: document.getElementById("page-prev"),
  pageNext: document.getElementById("page-next"),
  filtersPanel: document.querySelector(".filters-panel"),
  playerCard: document.getElementById("player-card"),
  player: document.getElementById("preview-player"),
  playerMeta: document.getElementById("player-meta"),
  configViewer: document.getElementById("config-viewer"),
  servicesOpen: document.getElementById("services-open"),
  servicesModal: document.getElementById("services-modal"),
  servicesDialog: document.getElementById("services-dialog"),
  servicesBody: document.getElementById("services-dialog-body"),
  servicesClose: document.getElementById("services-close"),
  servicesList: document.getElementById("services-list"),
  servicesEmpty: document.getElementById("services-empty"),
  servicesStatus: document.getElementById("services-status"),
  servicesRefresh: document.getElementById("services-refresh"),
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

const VALID_THEMES = new Set(["dark", "light"]);

const themeState = {
  current: "dark",
  manual: false,
  mediaQuery: null,
  mediaListener: null,
};

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

function readStoredTheme() {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (VALID_THEMES.has(normalized)) {
        return normalized;
      }
    }
  } catch (error) {
    return null;
  }
  return null;
}

function writeStoredTheme(theme) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    /* ignore storage errors */
  }
}

function updateThemeToggle(theme) {
  if (!dom.themeToggle) {
    return;
  }
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "Switch to light theme" : "Switch to dark theme";
  dom.themeToggle.textContent = label;
  dom.themeToggle.setAttribute("aria-label", label);
  dom.themeToggle.setAttribute("title", label);
  dom.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  dom.themeToggle.dataset.currentTheme = theme;
}

function applyTheme(theme) {
  const nextTheme = VALID_THEMES.has(theme) ? theme : "dark";
  themeState.current = nextTheme;
  if (document.body) {
    document.body.setAttribute("data-theme", nextTheme);
  }
  updateThemeToggle(nextTheme);
}

function handleSystemThemeChange(event) {
  if (themeState.manual) {
    return;
  }
  applyTheme(event.matches ? "dark" : "light");
}

function ensureSystemThemeSubscription() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    themeState.mediaQuery = null;
    themeState.mediaListener = null;
    return "dark";
  }
  if (themeState.mediaQuery && themeState.mediaListener) {
    return themeState.mediaQuery.matches ? "dark" : "light";
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event) => {
    handleSystemThemeChange(event);
  };
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
  } else if (typeof query.addListener === "function") {
    query.addListener(listener);
  }
  themeState.mediaQuery = query;
  themeState.mediaListener = listener;
  return query.matches ? "dark" : "light";
}

function initializeTheme() {
  const storedTheme = readStoredTheme();
  if (storedTheme) {
    themeState.manual = true;
    applyTheme(storedTheme);
    return;
  }
  themeState.manual = false;
  const systemTheme = ensureSystemThemeSubscription();
  applyTheme(systemTheme);
}

function toggleTheme() {
  const nextTheme = themeState.current === "dark" ? "light" : "dark";
  themeState.manual = true;
  applyTheme(nextTheme);
  writeStoredTheme(nextTheme);
}

let autoRefreshId = null;
let autoRefreshIntervalMs = AUTO_REFRESH_INTERVAL_MS;
let autoRefreshSuspended = false;
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

const servicesState = {
  items: [],
  lastUpdated: null,
  fetchInFlight: false,
  fetchQueued: false,
  pending: new Set(),
  lastResults: new Map(),
  timerId: null,
  error: null,
  refreshAfterActionId: null,
};

const servicesDialogState = {
  open: false,
  previouslyFocused: null,
  keydownHandler: null,
};

const connectionState = {
  offline: false,
};

const captureIndicatorState = {
  state: "unknown",
  message: "",
};

function clampLimitValue(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    const parsed = Number.parseInt(candidate, 10);
    if (!Number.isNaN(parsed)) {
      candidate = parsed;
    }
  }
  if (!Number.isFinite(candidate)) {
    return DEFAULT_LIMIT;
  }
  const integer = Math.trunc(candidate);
  if (!Number.isFinite(integer) || integer < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.max(integer, 1), MAX_LIMIT);
}

function clampOffsetValue(value, limit, total) {
  let candidate = value;
  if (typeof candidate === "string") {
    const parsed = Number.parseInt(candidate, 10);
    if (!Number.isNaN(parsed)) {
      candidate = parsed;
    }
  }
  const base = Number.isFinite(candidate) ? Math.max(0, Math.trunc(candidate)) : 0;
  const effectiveLimit = clampLimitValue(limit);
  const effectiveTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  if (effectiveTotal <= 0 || effectiveLimit <= 0) {
    return 0;
  }
  const maxIndex = effectiveTotal - 1;
  const lastPageOffset = Math.floor(maxIndex / effectiveLimit) * effectiveLimit;
  return Math.min(base, lastPageOffset);
}

function readStoredFilters() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function persistFilters() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    const payload = {
      search: state.filters.search,
      day: state.filters.day,
      limit: state.filters.limit,
    };
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore persistence errors */
  }
}

function clearStoredFilters() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    window.localStorage.removeItem(FILTER_STORAGE_KEY);
  } catch (error) {
    /* ignore removal errors */
  }
}

function restoreFiltersFromStorage() {
  const stored = readStoredFilters();
  if (!stored) {
    return;
  }
  const next = {
    search: state.filters.search,
    day: state.filters.day,
    limit: state.filters.limit,
  };
  if (typeof stored.search === "string") {
    next.search = stored.search;
  }
  if (typeof stored.day === "string") {
    next.day = stored.day;
  }
  if (Object.prototype.hasOwnProperty.call(stored, "limit")) {
    next.limit = clampLimitValue(stored.limit);
  }
  state.filters = next;
}

function startAutoRefresh() {
  if (autoRefreshSuspended || autoRefreshId) {
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
  if (autoRefreshSuspended) {
    return;
  }
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

function suspendAutoRefresh() {
  if (autoRefreshSuspended) {
    return;
  }
  autoRefreshSuspended = true;
  stopAutoRefresh();
}

function resumeAutoRefresh() {
  if (!autoRefreshSuspended) {
    if (!autoRefreshId) {
      startAutoRefresh();
    }
    return;
  }
  autoRefreshSuspended = false;
  startAutoRefresh();
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
  let message;

  if (capturing) {
    const event = rawStatus.event;
    let detail = "";
    let startedLabel = "";
    if (event && typeof event === "object") {
      const startedEpoch = toFiniteOrNull(event.started_epoch);
      if (startedEpoch !== null) {
        const formatted = formatRecordingStartTime(startedEpoch);
        if (formatted) {
          startedLabel = formatted;
        }
      }
      if (!startedLabel && typeof event.started_at === "string" && event.started_at) {
        startedLabel = event.started_at;
      }
      const trigger = toFiniteOrNull(event.trigger_rms);
      if (trigger !== null) {
        detail = `RMS ${Math.round(trigger)}`;
      } else if (typeof event.base_name === "string" && event.base_name) {
        detail = event.base_name;
      }
    }
    message = startedLabel
      ? `Recording active since ${startedLabel}`
      : "Recording active";
    if (detail) {
      message += ` • ${detail}`;
    }
  } else {
    message = "Recording idle";
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

function formatRecordingStartTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const startDate = new Date(seconds * 1000);
  const now = new Date();
  const sameDay =
    startDate.getFullYear() === now.getFullYear() &&
    startDate.getMonth() === now.getMonth() &&
    startDate.getDate() === now.getDate();
  if (sameDay) {
    return timeFormatter.format(startDate);
  }
  return dateFormatter.format(startDate);
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
  return apiPath(`/recordings/${encoded}${suffix}`);
}

function populateFilters() {
  if (dom.filterSearch) {
    dom.filterSearch.value = state.filters.search;
  }

  const daySelect = dom.filterDay;
  if (daySelect) {
    const previousValue = daySelect.value;
    daySelect.innerHTML = "";
    const dayOptions = ["", ...state.availableDays];
    let matched = false;
    for (const day of dayOptions) {
      const option = document.createElement("option");
      option.value = day;
      option.textContent = day || "All days";
      if (!matched && day === state.filters.day) {
        option.selected = true;
        matched = true;
      } else if (!matched && !state.filters.day && day === previousValue) {
        option.selected = true;
        matched = true;
      }
      daySelect.append(option);
    }
    if (!matched && daySelect.options.length > 0) {
      daySelect.options[0].selected = true;
    }
    if (state.filters.day && daySelect.value !== state.filters.day) {
      daySelect.value = state.filters.day;
    }
  }

  if (dom.filterLimit) {
    const limit = clampLimitValue(state.filters.limit);
    if (limit !== state.filters.limit) {
      state.filters.limit = limit;
      persistFilters();
    }
    dom.filterLimit.value = String(limit);
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

function previewIsActive() {
  return Boolean(
    dom.playerCard &&
      dom.playerCard.dataset.active === "true" &&
      !dom.playerCard.hidden &&
      state.current,
  );
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
  updatePaginationControls();
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

function updatePaginationControls() {
  const limit = clampLimitValue(state.filters.limit);
  const total = Number.isFinite(state.total) && state.total > 0 ? Math.trunc(state.total) : 0;
  const offset = Number.isFinite(state.offset) ? Math.max(0, Math.trunc(state.offset)) : 0;
  const visibleCount = Array.isArray(state.records) ? state.records.length : 0;

  if (dom.resultsSummary) {
    let summary = "";
    if ((fetchInFlight || !state.lastUpdated) && total === 0 && visibleCount === 0) {
      summary = "Loading recordings…";
    } else if (connectionState.offline && total === 0 && visibleCount === 0) {
      summary = "Unable to load recordings.";
    } else if (total === 0) {
      const hasFilters = Boolean(state.filters.search || state.filters.day);
      summary = hasFilters ? "No recordings match the selected filters." : "No recordings available.";
    } else if (visibleCount === 0) {
      summary = "No recordings on this page.";
    } else {
      const start = offset + 1;
      const end = Math.min(offset + visibleCount, total);
      const sizeHint = state.filteredSize > 0 ? formatBytes(state.filteredSize) : null;
      summary = `Showing ${start}–${end} of ${total} recordings${
        sizeHint ? ` • ${sizeHint} total` : ""
      }`;
    }
    dom.resultsSummary.textContent = summary;
  }

  if (dom.paginationControls) {
    dom.paginationControls.hidden = total <= limit;
  }

  if (dom.paginationStatus) {
    const totalPages = total > 0 ? Math.max(Math.ceil(total / limit), 1) : 1;
    const currentPage = total > 0 ? Math.min(Math.floor(offset / limit) + 1, totalPages) : 1;
    dom.paginationStatus.textContent = `Page ${currentPage} of ${totalPages}`;
  }

  if (dom.pagePrev) {
    dom.pagePrev.disabled = offset <= 0 || total === 0;
  }

  if (dom.pageNext) {
    const hasNext = total > 0 && offset + visibleCount < total;
    dom.pageNext.disabled = !hasNext;
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

    let startEpoch = toFiniteOrNull(payload.start_epoch);
    if (startEpoch === null) {
      startEpoch = toFiniteOrNull(payload.started_epoch);
    }
    if (
      startEpoch === null &&
      typeof payload.started_at === "string" &&
      payload.started_at.trim() !== ""
    ) {
      const parsedStartedAt = Date.parse(payload.started_at);
      if (!Number.isNaN(parsedStartedAt)) {
        startEpoch = parsedStartedAt / 1000;
      }
    }
    if (startEpoch === null && Number.isFinite(record.start_epoch)) {
      startEpoch = Number(record.start_epoch);
    }
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

    let endEpoch = toFiniteOrNull(payload.end_epoch);
    if (endEpoch === null) {
      endEpoch = toFiniteOrNull(payload.ended_epoch);
    }
    if (
      endEpoch === null &&
      typeof payload.ended_at === "string" &&
      payload.ended_at.trim() !== ""
    ) {
      const parsedEndedAt = Date.parse(payload.ended_at);
      if (!Number.isNaN(parsedEndedAt)) {
        endEpoch = parsedEndedAt / 1000;
      }
    }
    if (endEpoch === null && Number.isFinite(record.modified)) {
      endEpoch = Number(record.modified);
    }
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

function seekToEventStart() {
  if (!previewIsActive() || !dom.player) {
    return false;
  }
  try {
    dom.player.currentTime = 0;
  } catch (error) {
    return false;
  }
  updateCursorFromPlayer();
  return true;
}

function seekToEventEnd() {
  if (!previewIsActive() || !dom.player) {
    return false;
  }
  const duration = numericValue(dom.player.duration, NaN);
  if (!Number.isFinite(duration) || duration <= 0) {
    return false;
  }
  try {
    dom.player.currentTime = duration;
  } catch (error) {
    return false;
  }
  updateCursorFromPlayer();
  return true;
}

function seekBySeconds(offsetSeconds) {
  if (!previewIsActive() || !dom.player || !Number.isFinite(offsetSeconds) || offsetSeconds === 0) {
    return false;
  }
  const duration = numericValue(dom.player.duration, NaN);
  if (!Number.isFinite(duration) || duration <= 0) {
    return false;
  }
  const currentTime = Number.isFinite(dom.player.currentTime) ? dom.player.currentTime : 0;
  const nextTime = clamp(currentTime + offsetSeconds, 0, duration);
  try {
    dom.player.currentTime = nextTime;
  } catch (error) {
    return false;
  }
  updateCursorFromPlayer();
  return true;
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

function handlePreviewShortcutKeydown(event) {
  const isEscape =
    event.key === "Escape" || event.code === "Escape" || event.key === "Esc";
  const previewActive = previewIsActive();
  if (isEscape) {
    if (!previewActive) {
      return false;
    }
    event.preventDefault();
    setNowPlaying(null);
    return true;
  }

  if (!previewActive) {
    return false;
  }

  const isHome = event.key === "Home" || event.code === "Home";
  const isEnd = event.key === "End" || event.code === "End";
  const isPageUp = event.key === "PageUp" || event.code === "PageUp";
  const isPageDown = event.key === "PageDown" || event.code === "PageDown";

  if (!isHome && !isEnd && !isPageUp && !isPageDown) {
    return false;
  }

  if (shouldIgnoreSpacebarTarget(event.target)) {
    return false;
  }

  cancelKeyboardJog();

  if (isHome) {
    seekToEventStart();
    event.preventDefault();
    return true;
  }

  if (isEnd) {
    seekToEventEnd();
    event.preventDefault();
    return true;
  }

  if (isPageUp) {
    seekBySeconds(60);
    event.preventDefault();
    return true;
  }

  if (isPageDown) {
    seekBySeconds(-60);
    event.preventDefault();
    return true;
  }

  return false;
}

function handlePreviewKeydown(event) {
  const handled = handlePreviewShortcutKeydown(event);
  if (handled) {
    event.stopPropagation();
  }
}

async function handleTransportKeydown(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (confirmDialogState.open) {
    return;
  }

  if (handlePreviewShortcutKeydown(event)) {
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

  const limit = clampLimitValue(state.filters.limit);
  if (limit !== state.filters.limit) {
    state.filters.limit = limit;
    persistFilters();
  }
  if (dom.filterLimit) {
    dom.filterLimit.value = String(limit);
  }
  if (state.total > 0) {
    const normalizedOffset = clampOffsetValue(state.offset, limit, state.total);
    if (normalizedOffset !== state.offset) {
      state.offset = normalizedOffset;
    }
  }
  const offset = Number.isFinite(state.offset) ? Math.max(0, Math.trunc(state.offset)) : 0;
  if (offset !== state.offset) {
    state.offset = offset;
  }

  const params = new URLSearchParams();
  if (state.filters.search) {
    params.set("search", state.filters.search);
  }
  if (state.filters.day) {
    params.set("day", state.filters.day);
  }
  params.set("limit", String(limit));
  if (offset > 0) {
    params.set("offset", String(offset));
  }

  const endpoint = apiPath(`/api/recordings?${params.toString()}`);
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
    let effectiveLimit = limit;
    const payloadLimit = toFiniteOrNull(payload.limit);
    if (payloadLimit !== null) {
      const sanitizedLimit = clampLimitValue(payloadLimit);
      effectiveLimit = sanitizedLimit;
      if (sanitizedLimit !== state.filters.limit) {
        state.filters = {
          ...state.filters,
          limit: sanitizedLimit,
        };
        persistFilters();
      }
    }
    const total = Number.isFinite(payload.total)
      ? Number(payload.total)
      : normalizedRecords.length;
    const totalSize = numericValue(payload.total_size_bytes, 0);
    state.records = normalizedRecords;
    state.recordsFingerprint = nextFingerprint;
    state.total = total;
    state.filteredSize = totalSize;
    state.storage.recordings = numericValue(payload.recordings_total_bytes, totalSize);
    state.storage.total = toFiniteOrNull(payload.storage_total_bytes);
    state.storage.free = toFiniteOrNull(payload.storage_free_bytes);
    state.storage.diskUsed = toFiniteOrNull(payload.storage_used_bytes);
    state.availableDays = Array.isArray(payload.available_days) ? payload.available_days : [];
    state.lastUpdated = new Date();
    const payloadOffset = toFiniteOrNull(payload.offset);
    const offsetBasis =
      payloadOffset !== null ? Math.max(0, Math.trunc(payloadOffset)) : offset;
    const normalizedOffset = clampOffsetValue(offsetBasis, effectiveLimit, total);
    state.offset = normalizedOffset;
    if (total > 0 && normalizedRecords.length === 0 && normalizedOffset < offsetBasis) {
      fetchQueued = true;
    }
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
    updatePaginationControls();
    setRecordingIndicatorStatus(payload.capture_status);
    handleFetchSuccess();
  } catch (error) {
    console.error("Failed to load recordings", error);
    state.records = [];
    state.recordsFingerprint = "";
    state.total = 0;
    state.filteredSize = 0;
    state.offset = 0;
    state.storage.recordings = 0;
    state.storage.total = null;
    state.storage.free = null;
    state.storage.diskUsed = null;
    state.lastUpdated = null;
    renderRecords();
    updateStats();
    updatePaginationControls();
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
    const response = await fetch(apiPath("/api/config"), { cache: "no-store" });
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

function serviceActionEndpoint(unit) {
  return `${SERVICES_ENDPOINT}/${encodeURIComponent(unit)}/action`;
}

function normalizeServiceEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const unit = typeof entry.unit === "string" ? entry.unit : "";
  if (!unit) {
    return null;
  }
  const available = entry.available !== false;
  const statusText =
    typeof entry.status_text === "string" && entry.status_text
      ? entry.status_text
      : available
      ? "Unknown"
      : "Unavailable";
  const fallbackState = available
    ? entry.is_active === true
      ? "active"
      : "inactive"
    : "error";
  const statusState =
    typeof entry.status_state === "string" && entry.status_state
      ? entry.status_state
      : fallbackState;

  const relatedUnits = Array.isArray(entry.related_units)
    ? entry.related_units
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const relatedUnit = typeof item.unit === "string" ? item.unit : "";
          if (!relatedUnit) {
            return null;
          }
          const relatedAvailable = item.available !== false;
          const relatedFallbackState = relatedAvailable
            ? item.is_active === true
              ? "active"
              : "inactive"
            : "error";
          return {
            unit: relatedUnit,
            label:
              typeof item.label === "string" && item.label
                ? item.label
                : relatedUnit,
            relation:
              typeof item.relation === "string" && item.relation
                ? item.relation
                : "triggered-by",
            status_text:
              typeof item.status_text === "string" && item.status_text
                ? item.status_text
                : relatedAvailable
                ? "Unknown"
                : "Unavailable",
            status_state:
              typeof item.status_state === "string" && item.status_state
                ? item.status_state
                : relatedFallbackState,
            available: relatedAvailable,
            is_active: item.is_active === true,
            system_description:
              typeof item.system_description === "string"
                ? item.system_description
                : "",
          };
        })
        .filter((item) => item !== null)
    : [];
  return {
    unit,
    label: typeof entry.label === "string" && entry.label ? entry.label : unit,
    description:
      typeof entry.description === "string" ? entry.description : "",
    available,
    status_text: statusText,
    status_state: statusState,
    is_active: entry.is_active === true,
    auto_restart: entry.auto_restart === true,
    can_start: entry.can_start === true,
    can_stop: entry.can_stop === true,
    can_reload: entry.can_reload === true,
    load_state: typeof entry.load_state === "string" ? entry.load_state : "",
    active_state:
      typeof entry.active_state === "string" ? entry.active_state : "",
    sub_state: typeof entry.sub_state === "string" ? entry.sub_state : "",
    unit_file_state:
      typeof entry.unit_file_state === "string" ? entry.unit_file_state : "",
    system_description:
      typeof entry.system_description === "string"
        ? entry.system_description
        : "",
    error: typeof entry.error === "string" ? entry.error : "",
    related_units: relatedUnits,
  };
}

function setServicesStatus(message, state = "") {
  if (!dom.servicesStatus) {
    return;
  }
  dom.servicesStatus.textContent = message || "";
  if (state) {
    dom.servicesStatus.dataset.state = state;
  } else {
    delete dom.servicesStatus.dataset.state;
  }
  dom.servicesStatus.setAttribute("aria-hidden", message ? "false" : "true");
}

function pruneExpiredServiceResults(now) {
  const ttl = SERVICE_RESULT_TTL_MS;
  for (const [unit, result] of servicesState.lastResults.entries()) {
    if (!result || typeof result !== "object") {
      servicesState.lastResults.delete(unit);
      continue;
    }
    const timestamp = Number(result.timestamp);
    if (!Number.isFinite(timestamp) || now - timestamp > ttl) {
      servicesState.lastResults.delete(unit);
    }
  }
}

function renderServices() {
  if (!dom.servicesList) {
    return;
  }

  const hasItems = servicesState.items.length > 0;
  if (dom.servicesEmpty) {
    dom.servicesEmpty.hidden = hasItems;
    dom.servicesEmpty.setAttribute("aria-hidden", hasItems ? "true" : "false");
  }

  if (servicesState.error) {
    setServicesStatus(servicesState.error, "error");
  } else if (hasItems && servicesState.lastUpdated instanceof Date) {
    setServicesStatus(
      `Updated ${timeFormatter.format(servicesState.lastUpdated)}`,
      "info"
    );
  } else if (!hasItems) {
    setServicesStatus("", "");
  }

  dom.servicesList.innerHTML = "";
  if (!hasItems) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const now = Date.now();
  pruneExpiredServiceResults(now);

  for (const service of servicesState.items) {
    const row = document.createElement("div");
    row.className = "service-row";
    row.dataset.unit = service.unit;
    row.dataset.pending = servicesState.pending.has(service.unit)
      ? "true"
      : "false";
    row.dataset.available = service.available ? "true" : "false";
    row.dataset.autoRestart = service.auto_restart ? "true" : "false";

    const header = document.createElement("div");
    header.className = "service-row-header";

    const titles = document.createElement("div");
    titles.className = "service-row-titles";

    const label = document.createElement("div");
    label.className = "service-label";
    label.textContent = service.label;

    const unitText = document.createElement("div");
    unitText.className = "service-unit";
    unitText.textContent = service.unit;

    titles.append(label, unitText);

    const status = document.createElement("span");
    status.className = "service-status";
    const statusState =
      typeof service.status_state === "string" && service.status_state
        ? service.status_state
        : !service.available
        ? "error"
        : service.is_active
        ? "active"
        : "inactive";
    status.dataset.state = statusState;
    status.textContent = service.status_text;

    header.append(titles, status);

    const actions = document.createElement("div");
    actions.className = "service-actions";
    const pending = servicesState.pending.has(service.unit);
    const disableAll = pending || !service.available;

    const startDisabled = disableAll || !service.can_start || service.is_active;
    const stopDisabled = disableAll || !service.can_stop || !service.is_active;
    const reloadDisabled = disableAll;

    const startButton = createServiceActionButton(
      service,
      "start",
      "Start",
      "primary-button",
      startDisabled
    );
    const stopButton = createServiceActionButton(
      service,
      "stop",
      "Stop",
      "danger-button",
      stopDisabled
    );
    const reloadButton = createServiceActionButton(
      service,
      "reload",
      "Reload",
      "ghost-button",
      reloadDisabled
    );

    if (!service.can_reload) {
      reloadButton.title = "Reload not supported; falls back to restart.";
    }

    actions.append(startButton, stopButton, reloadButton);

    const meta = document.createElement("div");
    meta.className = "service-meta";
    if (service.description) {
      const desc = document.createElement("div");
      desc.className = "service-description";
      desc.textContent = service.description;
      meta.append(desc);
    } else if (service.system_description) {
      const desc = document.createElement("div");
      desc.className = "service-description";
      desc.textContent = service.system_description;
      meta.append(desc);
    }

    const details = [];
    if (service.unit_file_state) {
      details.push(service.unit_file_state);
    }
    if (service.auto_restart) {
      details.push("Auto-restart");
    }
    if (!service.available && service.error) {
      details.push(service.error);
    }

    if (details.length > 0) {
      const detailLine = document.createElement("div");
      detailLine.className = "service-details";
      detailLine.textContent = details.join(" · ");
      meta.append(detailLine);
    }

    if (Array.isArray(service.related_units) && service.related_units.length > 0) {
      const relatedContainer = document.createElement("div");
      relatedContainer.className = "service-related";
      relatedContainer.setAttribute("role", "group");
      relatedContainer.setAttribute("aria-label", "Related units");

      const heading = document.createElement("div");
      heading.className = "service-related-heading";
      heading.textContent = "Related units";
      relatedContainer.append(heading);

      const list = document.createElement("ul");
      list.className = "service-related-list";

      for (const related of service.related_units) {
        const item = document.createElement("li");
        item.className = "service-related-item";
        if (related.status_state) {
          item.dataset.state = related.status_state;
        }

        const name = document.createElement("span");
        name.className = "service-related-name";
        const displayName = related.label || related.unit;
        name.textContent = displayName;
        if (related.system_description) {
          name.title = related.system_description;
        }

        const summary = document.createElement("span");
        summary.className = "service-related-status";
        summary.textContent = related.status_text;
        if (related.unit && !related.system_description) {
          summary.title = related.unit;
        }

        item.append(name, summary);
        list.append(item);
      }

      relatedContainer.append(list);
      meta.append(relatedContainer);
    }

    const message = document.createElement("div");
    message.className = "service-message";
    message.dataset.visible = "false";

    let messageText = "";
    let messageState = "info";
    let showMessage = false;

    if (pending) {
      messageText = "Applying action…";
      messageState = "pending";
      showMessage = true;
    } else if (!service.available && service.error) {
      messageText = service.error;
      messageState = "error";
      showMessage = true;
    } else {
      const result = servicesState.lastResults.get(service.unit);
      if (result) {
        messageText = typeof result.message === "string" ? result.message : "";
        messageState = result.ok ? "ok" : "error";
        showMessage = Boolean(messageText);
      }
    }

    if (showMessage) {
      message.dataset.visible = "true";
      message.dataset.state = messageState;
      message.textContent = messageText;
    }

    row.append(header, actions, meta, message);
    fragment.append(row);
  }

  dom.servicesList.append(fragment);
}

function servicesModalFocusableElements() {
  if (!dom.servicesDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.servicesDialog.querySelectorAll(selectors);
  const focusable = [];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    if (node.hasAttribute("disabled")) {
      continue;
    }
    if (node.getAttribute("aria-hidden") === "true") {
      continue;
    }
    if (node.offsetParent === null && node !== document.activeElement) {
      continue;
    }
    focusable.push(node);
  }
  return focusable;
}

function setServicesModalVisible(visible) {
  if (!dom.servicesModal) {
    return;
  }
  dom.servicesModal.dataset.visible = visible ? "true" : "false";
  dom.servicesModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.servicesModal.removeAttribute("hidden");
  } else {
    dom.servicesModal.setAttribute("hidden", "hidden");
  }
}

function attachServicesDialogKeydown() {
  if (servicesDialogState.keydownHandler) {
    return;
  }
  servicesDialogState.keydownHandler = (event) => {
    if (!servicesDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.servicesModal &&
      target instanceof Node &&
      (target === dom.servicesModal || dom.servicesModal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeServicesModal();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = servicesModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.servicesDialog) {
        dom.servicesDialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.servicesDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", servicesDialogState.keydownHandler, true);
}

function detachServicesDialogKeydown() {
  if (!servicesDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", servicesDialogState.keydownHandler, true);
  servicesDialogState.keydownHandler = null;
}

function focusServicesDialog() {
  if (!dom.servicesDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = servicesModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.servicesDialog.focus();
    }
  });
}

function openServicesModal(options = {}) {
  if (!dom.servicesModal || !dom.servicesDialog) {
    return;
  }
  const { focus = true } = options;
  if (dom.servicesOpen) {
    dom.servicesOpen.setAttribute("aria-expanded", "true");
  }
  if (servicesDialogState.open) {
    if (focus) {
      focusServicesDialog();
    }
    fetchServices({ silent: false });
    startServicesRefresh();
    return;
  }
  servicesDialogState.open = true;
  servicesDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setServicesModalVisible(true);
  if (dom.servicesBody) {
    dom.servicesBody.scrollTop = 0;
  }
  fetchServices({ silent: false });
  attachServicesDialogKeydown();
  startServicesRefresh();
  if (focus) {
    focusServicesDialog();
  }
}

function closeServicesModal(options = {}) {
  if (!servicesDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  servicesDialogState.open = false;
  stopServicesRefresh();
  setServicesModalVisible(false);
  if (dom.servicesOpen) {
    dom.servicesOpen.setAttribute("aria-expanded", "false");
  }
  detachServicesDialogKeydown();
  const previous = servicesDialogState.previouslyFocused;
  servicesDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
}

function createServiceActionButton(service, action, label, className, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className} small`;
  button.dataset.serviceUnit = service.unit;
  button.dataset.action = action;
  button.textContent = label;
  button.disabled = Boolean(disabled);
  button.setAttribute(
    "aria-label",
    `${label} ${service.label}`
  );
  button.addEventListener("click", (event) => {
    if (button.disabled) {
      return;
    }
    event.preventDefault();
    const unit = button.dataset.serviceUnit || "";
    const buttonAction = button.dataset.action || "";
    if (!unit || !buttonAction) {
      return;
    }
    handleServiceAction(unit, buttonAction);
  });
  return button;
}

async function fetchServices(options = {}) {
  if (!dom.servicesList) {
    return;
  }
  const { silent = false } = options;
  if (servicesState.fetchInFlight) {
    servicesState.fetchQueued = true;
    return;
  }
  servicesState.fetchInFlight = true;
  if (!silent) {
    setServicesStatus("Loading services…", "loading");
  }
  try {
    const response = await fetch(SERVICES_ENDPOINT, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    const items = Array.isArray(payload.services) ? payload.services : [];
    const normalized = items
      .map((entry) => normalizeServiceEntry(entry))
      .filter((entry) => entry !== null);
    servicesState.items = normalized;
    const updatedAt = Number(payload.updated_at);
    if (Number.isFinite(updatedAt) && updatedAt > 0) {
      servicesState.lastUpdated = new Date(updatedAt * 1000);
    } else {
      servicesState.lastUpdated = new Date();
    }
    servicesState.error = null;
    renderServices();
  } catch (error) {
    console.error("Failed to load services", error);
    servicesState.error = error instanceof Error ? error.message : String(error);
    if (!servicesState.error) {
      servicesState.error = "Unable to load services.";
    }
    renderServices();
  } finally {
    servicesState.fetchInFlight = false;
    if (servicesState.fetchQueued) {
      servicesState.fetchQueued = false;
      fetchServices({ silent: true });
    }
  }
}

function stopServicesRefresh() {
  if (servicesState.timerId) {
    window.clearInterval(servicesState.timerId);
    servicesState.timerId = null;
  }
}

function startServicesRefresh() {
  if (servicesState.timerId || !dom.servicesList || !servicesDialogState.open) {
    return;
  }
  servicesState.timerId = window.setInterval(() => {
    fetchServices({ silent: true });
  }, SERVICE_REFRESH_INTERVAL_MS);
}

function capitalizeAction(action) {
  if (typeof action !== "string" || !action) {
    return "Action";
  }
  return action.charAt(0).toUpperCase() + action.slice(1);
}

async function handleServiceAction(unit, action) {
  if (!unit || !action) {
    return;
  }
  if (servicesState.pending.has(unit)) {
    return;
  }

  servicesState.pending.add(unit);
  renderServices();

  try {
    const response = await fetch(serviceActionEndpoint(unit), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    const ok = payload.ok !== false;
    const executed =
      typeof payload.executed_action === "string" && payload.executed_action
        ? payload.executed_action
        : action;
    let message = "";
    if (typeof payload.message === "string" && payload.message.trim()) {
      message = payload.message.trim();
    } else {
      message = ok
        ? `${capitalizeAction(executed)} succeeded.`
        : `${capitalizeAction(executed)} failed.`;
    }
    servicesState.lastResults.set(unit, {
      ok,
      message,
      executedAction: executed,
      timestamp: Date.now(),
      scheduledActions: Array.isArray(payload.scheduled_actions)
        ? payload.scheduled_actions.slice()
        : [],
    });
  } catch (error) {
    console.error("Service action failed", error);
    const message = error instanceof Error ? error.message : String(error);
    servicesState.lastResults.set(unit, {
      ok: false,
      message: message || "Service action failed.",
      executedAction: action,
      timestamp: Date.now(),
      scheduledActions: [],
    });
  } finally {
    servicesState.pending.delete(unit);
    renderServices();
    if (servicesState.refreshAfterActionId) {
      window.clearTimeout(servicesState.refreshAfterActionId);
    }
    servicesState.refreshAfterActionId = window.setTimeout(() => {
      servicesState.refreshAfterActionId = null;
      fetchServices({ silent: true });
    }, 800);
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
    const response = await fetch(apiPath("/api/recordings/delete"), {
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
  const search = dom.filterSearch ? dom.filterSearch.value.trim() : "";
  const day = dom.filterDay ? dom.filterDay.value.trim() : "";
  let limit = state.filters.limit;
  if (dom.filterLimit) {
    const parsed = Number.parseInt(dom.filterLimit.value, 10);
    if (!Number.isNaN(parsed)) {
      limit = clampLimitValue(parsed);
    }
  }
  const nextFilters = {
    search,
    day,
    limit: clampLimitValue(limit),
  };
  const changed =
    nextFilters.search !== state.filters.search ||
    nextFilters.day !== state.filters.day ||
    nextFilters.limit !== state.filters.limit;

  state.filters = nextFilters;

  if (dom.filterSearch) {
    dom.filterSearch.value = nextFilters.search;
  }
  if (dom.filterDay && dom.filterDay.value !== nextFilters.day) {
    dom.filterDay.value = nextFilters.day;
  }
  if (dom.filterLimit) {
    dom.filterLimit.value = String(nextFilters.limit);
  }

  if (changed) {
    state.offset = 0;
  }

  persistFilters();
}

function clearFilters() {
  if (dom.filterSearch) {
    dom.filterSearch.value = "";
  }
  if (dom.filterDay) {
    dom.filterDay.value = "";
  }
  if (dom.filterLimit) {
    dom.filterLimit.value = String(DEFAULT_LIMIT);
  }
  state.filters = { search: "", day: "", limit: DEFAULT_LIMIT };
  state.offset = 0;
  clearStoredFilters();
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

function handleServiceListClick(event) {
  let target = event.target;
  if (!(target instanceof Element)) {
    target = target instanceof Node ? target.parentElement : null;
  }
  if (!target) {
    return;
  }
  const button = target.closest("button[data-service-unit][data-action]");
  if (!button || button.disabled) {
    return;
  }
  const unit = button.dataset.serviceUnit || "";
  const action = button.dataset.action || "";
  if (!unit || !action) {
    return;
  }
  event.preventDefault();
  handleServiceAction(unit, action);
}

function attachEventListeners() {
  if (dom.filtersPanel) {
    const handleFiltersFocusOut = (event) => {
      const next =
        event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
      if (next && dom.filtersPanel.contains(next)) {
        return;
      }
      window.requestAnimationFrame(() => {
        const active =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (!active || !dom.filtersPanel.contains(active)) {
          resumeAutoRefresh();
        }
      });
    };

    const handleFiltersPointerEnd = () => {
      window.requestAnimationFrame(() => {
        const active =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (!active || !dom.filtersPanel.contains(active)) {
          resumeAutoRefresh();
        }
      });
    };

    dom.filtersPanel.addEventListener("focusin", suspendAutoRefresh);
    dom.filtersPanel.addEventListener("pointerdown", suspendAutoRefresh);
    dom.filtersPanel.addEventListener("focusout", handleFiltersFocusOut);
    dom.filtersPanel.addEventListener("pointerup", handleFiltersPointerEnd);
    dom.filtersPanel.addEventListener("pointercancel", handleFiltersPointerEnd);
    dom.filtersPanel.addEventListener("pointerleave", handleFiltersPointerEnd);
  }

  dom.applyFilters.addEventListener("click", () => {
    applyFiltersFromInputs();
    state.selections.clear();
    fetchRecordings({ silent: false });
    updateSelectionUI();
    resumeAutoRefresh();
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
    resumeAutoRefresh();
  });

  if (dom.themeToggle) {
    dom.themeToggle.addEventListener("click", () => {
      toggleTheme();
    });
  }

  if (dom.refreshButton) {
    dom.refreshButton.addEventListener("click", () => {
      fetchRecordings({ silent: false });
    });
  }

  if (dom.servicesOpen) {
    dom.servicesOpen.addEventListener("click", () => {
      if (servicesDialogState.open) {
        closeServicesModal();
      } else {
        openServicesModal();
      }
    });
  }

  if (dom.servicesClose) {
    dom.servicesClose.addEventListener("click", () => {
      closeServicesModal();
    });
  }

  if (dom.servicesModal) {
    dom.servicesModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.servicesModal) {
        event.preventDefault();
      }
    });
    dom.servicesModal.addEventListener("click", (event) => {
      if (event.target === dom.servicesModal) {
        closeServicesModal();
      }
    });
  }

  if (dom.servicesRefresh) {
    dom.servicesRefresh.addEventListener("click", () => {
      fetchServices({ silent: false });
    });
  }

  if (dom.pagePrev) {
    dom.pagePrev.addEventListener("click", () => {
      if (dom.pagePrev.disabled) {
        return;
      }
      const limitValue = clampLimitValue(state.filters.limit);
      const currentOffset = Number.isFinite(state.offset) ? Math.trunc(state.offset) : 0;
      const nextOffset = Math.max(0, currentOffset - limitValue);
      if (nextOffset === currentOffset) {
        return;
      }
      state.offset = nextOffset;
      fetchRecordings({ silent: false });
      updatePaginationControls();
    });
  }

  if (dom.pageNext) {
    dom.pageNext.addEventListener("click", () => {
      if (dom.pageNext.disabled) {
        return;
      }
      const limitValue = clampLimitValue(state.filters.limit);
      const currentOffset = Number.isFinite(state.offset) ? Math.trunc(state.offset) : 0;
      const nextOffset = Math.max(0, currentOffset + limitValue);
      if (nextOffset === currentOffset) {
        return;
      }
      state.offset = nextOffset;
      fetchRecordings({ silent: false });
      updatePaginationControls();
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

  if (dom.playerCard) {
    dom.playerCard.addEventListener("keydown", handlePreviewKeydown);
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
    stopServicesRefresh();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  window.addEventListener("pagehide", () => {
    stopAutoRefresh();
    stopServicesRefresh();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAutoRefresh();
      stopServicesRefresh();
      if (liveState.open) {
        cancelLiveStats();
        sendStop(false);
        if (dom.liveAudio) {
          dom.liveAudio.pause();
        }
      }
    } else {
      startAutoRefresh();
      startServicesRefresh();
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
  initializeTheme();
  restoreFiltersFromStorage();
  populateFilters();
  updateSelectionUI();
  updateSortIndicators();
  updatePaginationControls();
  resetWaveform();
  setRecordingIndicatorUnknown("Loading status…");
  setRefreshIndicatorVisible(false);
  setLiveButtonState(false);
  setLiveStatus("Idle");
  setServicesModalVisible(false);
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
