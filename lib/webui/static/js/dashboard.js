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

function nowMilliseconds() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

const AUTO_REFRESH_INTERVAL_MS = 1000;
const OFFLINE_REFRESH_INTERVAL_MS = 5000;
const REFRESH_INDICATOR_DELAY_MS = 600;
const MARKER_MIN_GAP_SECONDS = 0.05;
const KEYBOARD_JOG_RATE_SECONDS_PER_SECOND = 4;
const MIN_CLIP_DURATION_SECONDS = 0.05;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const FILTER_STORAGE_KEY = "tricorder.dashboard.filters";
const CLIPPER_STORAGE_KEY = "tricorder.dashboard.clipper";
const THEME_STORAGE_KEY = "tricorder.dashboard.theme";

const STREAM_MODE = (() => {
  if (typeof document === "undefined" || !document.body || !document.body.dataset) {
    return "hls";
  }
  const mode = (document.body.dataset.tricorderStreamMode || "").trim().toLowerCase();
  return mode === "webrtc" ? "webrtc" : "hls";
})();
const STREAM_BASE = STREAM_MODE === "webrtc" ? "/webrtc" : "/hls";
const HLS_URL = STREAM_MODE === "hls" ? apiPath("/hls/live.m3u8") : "";
const START_ENDPOINT = apiPath(`${STREAM_BASE}/start`);
const STOP_ENDPOINT = apiPath(`${STREAM_BASE}/stop`);
const STATS_ENDPOINT = apiPath(`${STREAM_BASE}/stats`);
const OFFER_ENDPOINT = STREAM_MODE === "webrtc" ? apiPath("/webrtc/offer") : "";
const SERVICES_ENDPOINT = apiPath("/api/services");
const HEALTH_ENDPOINT = apiPath("/api/system-health");
const ARCHIVAL_ENDPOINT = apiPath("/api/config/archival");
const SERVICE_REFRESH_INTERVAL_MS = 5000;
const SERVICE_RESULT_TTL_MS = 15000;
const HEALTH_REFRESH_INTERVAL_MS = 30000;
const CONFIG_REFRESH_INTERVAL_MS = 5000;
const VOICE_RECORDER_SERVICE_UNIT = "voice-recorder.service";
const SESSION_STORAGE_KEY = "tricorder.session";
const WINDOW_NAME_PREFIX = "tricorder.session:";
const ARCHIVAL_BACKENDS = new Set(["network_share", "rsync"]);

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

const healthState = {
  sdCard: null,
  lastUpdated: null,
};

const dom = {
  systemBanner: document.getElementById("system-banner"),
  systemBannerMessage: document.getElementById("system-banner-message"),
  systemBannerDetail: document.getElementById("system-banner-detail"),
  recordingCount: document.getElementById("recording-count"),
  recordingCountMobile: document.getElementById("recording-count-mobile"),
  selectedCount: document.getElementById("selected-count"),
  selectedCountMobile: document.getElementById("selected-count-mobile"),
  storageUsageText: document.getElementById("storage-usage-text"),
  storageHint: document.getElementById("storage-hint"),
  storageProgress: document.getElementById("storage-progress-bar"),
  lastUpdated: document.getElementById("last-updated"),
  tableBody: document.querySelector("#recordings-table tbody"),
  toggleAll: document.getElementById("toggle-all"),
  selectAll: document.getElementById("select-all"),
  clearSelection: document.getElementById("clear-selection"),
  downloadSelected: document.getElementById("download-selected"),
  renameSelected: document.getElementById("rename-selected"),
  deleteSelected: document.getElementById("delete-selected"),
  refreshIndicator: document.getElementById("refresh-indicator"),
  themeToggle: document.getElementById("theme-toggle"),
  connectionStatus: document.getElementById("connection-status"),
  recordingIndicator: document.getElementById("recording-indicator"),
  recordingIndicatorText: document.getElementById("recording-indicator-text"),
  recordingMeta: document.getElementById("recording-meta"),
  recordingMetaText: document.getElementById("recording-meta-text"),
  rmsIndicator: document.getElementById("rms-indicator"),
  rmsIndicatorValue: document.getElementById("rms-indicator-value"),
  encodingStatus: document.getElementById("encoding-status"),
  encodingStatusText: document.getElementById("encoding-status-text"),
  applyFilters: document.getElementById("apply-filters"),
  clearFilters: document.getElementById("clear-filters"),
  filterSearch: document.getElementById("filter-search"),
  filterDay: document.getElementById("filter-day"),
  filterLimit: document.getElementById("filter-limit"),
  filtersPanel: document.getElementById("filters-panel"),
  filtersToggle: document.getElementById("filters-toggle"),
  filtersClose: document.getElementById("filters-close"),
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
  configOpen: document.getElementById("config-open"),
  configModal: document.getElementById("config-modal"),
  configDialog: document.getElementById("config-dialog"),
  configClose: document.getElementById("config-close"),
  configPathLabel: document.getElementById("config-dialog-path"),
  appMenuToggle: document.getElementById("app-menu-toggle"),
  appMenu: document.getElementById("app-menu"),
  archivalOpen: document.getElementById("archival-open"),
  archivalModal: document.getElementById("archival-modal"),
  archivalDialog: document.getElementById("archival-dialog"),
  archivalClose: document.getElementById("archival-close"),
  archivalForm: document.getElementById("archival-form"),
  archivalEnabled: document.getElementById("archival-enabled"),
  archivalBackend: document.getElementById("archival-backend"),
  archivalIncludeWaveforms: document.getElementById("archival-include-waveforms"),
  archivalNetworkShareSection: document.getElementById("archival-network-share-section"),
  archivalNetworkShareTarget: document.getElementById("archival-network-share-target"),
  archivalRsyncSection: document.getElementById("archival-rsync-section"),
  archivalRsyncDestination: document.getElementById("archival-rsync-destination"),
  archivalRsyncIdentity: document.getElementById("archival-rsync-identity"),
  archivalRsyncOptions: document.getElementById("archival-rsync-options"),
  archivalRsyncSshOptions: document.getElementById("archival-rsync-ssh-options"),
  archivalStatus: document.getElementById("archival-status"),
  archivalSave: document.getElementById("archival-save"),
  archivalReset: document.getElementById("archival-reset"),
  archivalConfigPath: document.getElementById("archival-config-path"),
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
  clipperContainer: document.getElementById("clipper-container"),
  clipperSection: document.getElementById("clipper-section"),
  clipperForm: document.getElementById("clipper-form"),
  clipperStartInput: document.getElementById("clipper-start"),
  clipperEndInput: document.getElementById("clipper-end"),
  clipperNameInput: document.getElementById("clipper-name"),
  clipperOverwriteToggle: document.getElementById("clipper-overwrite-toggle"),
  clipperSetStart: document.getElementById("clipper-set-start"),
  clipperSetEnd: document.getElementById("clipper-set-end"),
  clipperReset: document.getElementById("clipper-reset"),
  clipperSubmit: document.getElementById("clipper-submit"),
  clipperUndo: document.getElementById("clipper-undo"),
  clipperToggle: document.getElementById("clipper-toggle"),
  clipperStatus: document.getElementById("clipper-status"),
  clipperSummary: document.getElementById("clipper-summary"),
  clipperLength: document.getElementById("clipper-length"),
  sortButtons: Array.from(document.querySelectorAll(".sort-button")),
  confirmModal: document.getElementById("confirm-modal"),
  confirmDialog: document.getElementById("confirm-modal-dialog"),
  confirmTitle: document.getElementById("confirm-modal-title"),
  confirmMessage: document.getElementById("confirm-modal-message"),
  confirmConfirm: document.getElementById("confirm-modal-confirm"),
  confirmCancel: document.getElementById("confirm-modal-cancel"),
  renameModal: document.getElementById("rename-modal"),
  renameDialog: document.getElementById("rename-modal-dialog"),
  renameForm: document.getElementById("rename-form"),
  renameInput: document.getElementById("rename-input"),
  renameError: document.getElementById("rename-error"),
  renameConfirm: document.getElementById("rename-confirm"),
  renameCancel: document.getElementById("rename-cancel"),
};

const recorderDom = {
  menuItems: document.querySelectorAll(".recorder-menu-item"),
  modal: document.getElementById("recorder-settings-modal"),
  dialog: document.getElementById("recorder-settings-dialog"),
  close: document.getElementById("recorder-settings-close"),
  configPath: document.getElementById("recorder-settings-config-path"),
  sections: {
    audio: {
      form: document.getElementById("audio-form"),
      device: document.getElementById("audio-device"),
      sampleRate: document.getElementById("audio-sample-rate"),
      frameMs: document.getElementById("audio-frame-ms"),
      gain: document.getElementById("audio-gain"),
      vad: document.getElementById("audio-vad"),
      filterHighpassEnabled: document.getElementById("audio-filter-highpass-enabled"),
      filterHighpassCutoff: document.getElementById("audio-filter-highpass-cutoff"),
      filterHighpassDisplay: document.getElementById("audio-filter-highpass-cutoff-value"),
      filterLowpassEnabled: document.getElementById("audio-filter-lowpass-enabled"),
      filterLowpassCutoff: document.getElementById("audio-filter-lowpass-cutoff"),
      filterLowpassDisplay: document.getElementById("audio-filter-lowpass-cutoff-value"),
      filterNoiseGateEnabled: document.getElementById("audio-filter-noisegate-enabled"),
      filterNoiseGateThreshold: document.getElementById("audio-filter-noisegate-threshold"),
      filterNoiseGateDisplay: document.getElementById("audio-filter-noisegate-threshold-value"),
      calibrationNoise: document.getElementById("audio-calibration-noise"),
      calibrationGain: document.getElementById("audio-calibration-gain"),
      calibrateNoiseButton: document.getElementById("audio-calibrate-noise"),
      save: document.getElementById("audio-save"),
      reset: document.getElementById("audio-reset"),
      status: document.getElementById("audio-status"),
    },
    segmenter: {
      form: document.getElementById("segmenter-form"),
      prePad: document.getElementById("segmenter-pre-pad"),
      postPad: document.getElementById("segmenter-post-pad"),
      threshold: document.getElementById("segmenter-threshold"),
      keepWindow: document.getElementById("segmenter-keep-window"),
      startConsecutive: document.getElementById("segmenter-start-consecutive"),
      keepConsecutive: document.getElementById("segmenter-keep-consecutive"),
      flushBytes: document.getElementById("segmenter-flush-bytes"),
      maxQueue: document.getElementById("segmenter-max-queue"),
      useRnnoise: document.getElementById("segmenter-use-rnnoise"),
      useNoisereduce: document.getElementById("segmenter-use-noisereduce"),
      denoiseBeforeVad: document.getElementById("segmenter-denoise-before-vad"),
      save: document.getElementById("segmenter-save"),
      reset: document.getElementById("segmenter-reset"),
      status: document.getElementById("segmenter-status"),
    },
    adaptive_rms: {
      form: document.getElementById("adaptive-form"),
      enabled: document.getElementById("adaptive-enabled"),
      minThresh: document.getElementById("adaptive-min-thresh"),
      margin: document.getElementById("adaptive-margin"),
      updateInterval: document.getElementById("adaptive-update-interval"),
      window: document.getElementById("adaptive-window"),
      hysteresis: document.getElementById("adaptive-hysteresis"),
      release: document.getElementById("adaptive-release"),
      save: document.getElementById("adaptive-save"),
      reset: document.getElementById("adaptive-reset"),
      status: document.getElementById("adaptive-status"),
    },
    ingest: {
      form: document.getElementById("ingest-form"),
      stableChecks: document.getElementById("ingest-stable-checks"),
      stableInterval: document.getElementById("ingest-stable-interval"),
      allowedExt: document.getElementById("ingest-allowed-ext"),
      ignoreSuffixes: document.getElementById("ingest-ignore-suffixes"),
      save: document.getElementById("ingest-save"),
      reset: document.getElementById("ingest-reset"),
      status: document.getElementById("ingest-status"),
    },
    transcription: {
      form: document.getElementById("transcription-form"),
      enabled: document.getElementById("transcription-enabled"),
      engine: document.getElementById("transcription-engine"),
      types: document.getElementById("transcription-types"),
      modelPath: document.getElementById("transcription-model-path"),
      targetSampleRate: document.getElementById("transcription-target-sample-rate"),
      includeWords: document.getElementById("transcription-include-words"),
      maxAlternatives: document.getElementById("transcription-max-alternatives"),
      save: document.getElementById("transcription-save"),
      reset: document.getElementById("transcription-reset"),
      status: document.getElementById("transcription-status"),
    },
    logging: {
      form: document.getElementById("logging-form"),
      devMode: document.getElementById("logging-dev-mode"),
      save: document.getElementById("logging-save"),
      reset: document.getElementById("logging-reset"),
      status: document.getElementById("logging-status"),
    },
    streaming: {
      form: document.getElementById("streaming-form"),
      mode: document.getElementById("streaming-mode"),
      history: document.getElementById("streaming-history"),
      save: document.getElementById("streaming-save"),
      reset: document.getElementById("streaming-reset"),
      status: document.getElementById("streaming-status"),
    },
    dashboard: {
      form: document.getElementById("dashboard-form"),
      apiBase: document.getElementById("dashboard-api-base"),
      save: document.getElementById("dashboard-save"),
      reset: document.getElementById("dashboard-reset"),
      status: document.getElementById("dashboard-status"),
    },
  },
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

const VALID_THEMES = new Set(["dark", "light"]);

const themeState = {
  current: "dark",
  manual: false,
  mediaQuery: null,
  mediaListener: null,
};

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

const scrollLockState = {
  locks: new Set(),
};

function updateDocumentScrollLock() {
  if (!document || !document.body) {
    return;
  }
  if (scrollLockState.locks.size > 0) {
    document.body.dataset.scrollLocked = "true";
  } else if (document.body.dataset.scrollLocked) {
    delete document.body.dataset.scrollLocked;
  }
}

function lockDocumentScroll(lockId) {
  if (!lockId) {
    return;
  }
  scrollLockState.locks.add(lockId);
  updateDocumentScrollLock();
}

function unlockDocumentScroll(lockId) {
  if (!lockId) {
    return;
  }
  scrollLockState.locks.delete(lockId);
  updateDocumentScrollLock();
}

let autoRefreshId = null;
let configRefreshId = null;
let configRefreshSuspended = false;
let healthRefreshId = null;
let healthFetchInFlight = false;
let healthFetchQueued = false;
let configFetchInFlight = false;
let configFetchQueued = false;

function formatIsoDateTime(isoString) {
  if (typeof isoString !== "string" || !isoString) {
    return null;
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return dateFormatter.format(date);
  } catch (error) {
    console.warn("Unable to format ISO date", error);
  }
  return date.toISOString();
}

function setSystemBannerVisible(visible) {
  if (!dom.systemBanner) {
    return;
  }
  if (visible) {
    dom.systemBanner.hidden = false;
    dom.systemBanner.dataset.visible = "true";
  } else {
    dom.systemBanner.dataset.visible = "false";
    dom.systemBanner.hidden = true;
  }
}

function renderSdCardBanner() {
  if (!dom.systemBanner || !dom.systemBannerMessage || !dom.systemBannerDetail) {
    return;
  }
  const sdCard = healthState.sdCard;
  if (!sdCard || sdCard.warning_active !== true) {
    setSystemBannerVisible(false);
    dom.systemBannerDetail.textContent = "";
    return;
  }

  setSystemBannerVisible(true);

  const parts = [];
  const event = sdCard.last_event;
  if (event && typeof event === "object") {
    const when = formatIsoDateTime(event.timestamp);
    if (when) {
      parts.push(`Last error ${when}`);
    }
    if (typeof event.message === "string" && event.message) {
      parts.push(event.message);
    }
  } else {
    const firstDetected = formatIsoDateTime(sdCard.first_detected_at);
    if (firstDetected) {
      parts.push(`Warning first detected ${firstDetected}`);
    }
  }

  dom.systemBannerDetail.textContent = parts.join(" — ");
}

function applyHealthPayload(payload) {
  if (!payload || typeof payload !== "object") {
    healthState.sdCard = null;
    healthState.lastUpdated = null;
    renderSdCardBanner();
    return;
  }

  if (typeof payload.generated_at === "number") {
    healthState.lastUpdated = payload.generated_at;
  }

  const sdCard = payload.sd_card;
  if (sdCard && typeof sdCard === "object") {
    const normalised = {
      warning_active: sdCard.warning_active === true,
      first_detected_at:
        typeof sdCard.first_detected_at === "string" ? sdCard.first_detected_at : null,
      last_event: null,
    };
    if (sdCard.last_event && typeof sdCard.last_event === "object") {
      normalised.last_event = {
        timestamp:
          typeof sdCard.last_event.timestamp === "string"
            ? sdCard.last_event.timestamp
            : null,
        message:
          typeof sdCard.last_event.message === "string"
            ? sdCard.last_event.message
            : "",
      };
    }
    healthState.sdCard = normalised;
  } else {
    healthState.sdCard = null;
  }

  renderSdCardBanner();
}

async function fetchSystemHealth() {
  if (healthFetchInFlight) {
    healthFetchQueued = true;
    return;
  }
  healthFetchInFlight = true;
  try {
    const response = await fetch(HEALTH_ENDPOINT, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`System health request failed with ${response.status}`);
    }
    const payload = await response.json();
    applyHealthPayload(payload);
  } catch (error) {
    console.error("Failed to fetch system health", error);
  } finally {
    healthFetchInFlight = false;
    if (healthFetchQueued) {
      healthFetchQueued = false;
      fetchSystemHealth();
    }
  }
}

function startHealthRefresh() {
  stopHealthRefresh();
  fetchSystemHealth();
  healthRefreshId = window.setInterval(fetchSystemHealth, HEALTH_REFRESH_INTERVAL_MS);
}

function stopHealthRefresh() {
  if (healthRefreshId !== null) {
    window.clearInterval(healthRefreshId);
    healthRefreshId = null;
  }
}

function startConfigRefresh() {
  stopConfigRefresh();
  if (configRefreshSuspended) {
    return;
  }
  configRefreshId = window.setInterval(() => {
    fetchConfig({ silent: true });
  }, CONFIG_REFRESH_INTERVAL_MS);
}

function stopConfigRefresh() {
  if (configRefreshId !== null) {
    window.clearInterval(configRefreshId);
    configRefreshId = null;
  }
}

let autoRefreshIntervalMs = AUTO_REFRESH_INTERVAL_MS;
let autoRefreshSuspended = false;
let fetchInFlight = false;
let fetchQueued = false;

function isInteractiveFormField(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  const role = element.getAttribute("role");
  if (role === "textbox" || role === "combobox" || role === "spinbutton") {
    return true;
  }

  const tagName = element.tagName;
  if (tagName === "AUDIO" || tagName === "VIDEO") {
    return true;
  }
  if (tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }

  if (tagName === "INPUT") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      return false;
    }
    return true;
  }

  return false;
}

function closestInteractiveFormField(element) {
  let current = element instanceof Element ? element : null;
  while (current) {
    if (isInteractiveFormField(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findInteractiveElement(target, event = null) {
  const candidate = closestInteractiveFormField(target);
  if (candidate) {
    return candidate;
  }
  if (event && typeof event.composedPath === "function") {
    const path = event.composedPath();
    for (const node of path) {
      if (node instanceof HTMLElement && isInteractiveFormField(node)) {
        return node;
      }
    }
  }
  return null;
}

let refreshIndicatorTimer = null;
let pendingSelectionPath = null;
const renameDialogState = {
  open: false,
  target: null,
  pending: false,
  previouslyFocused: null,
};

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

const clipperState = {
  enabled: false,
  available: false,
  durationSeconds: null,
  startSeconds: 0,
  endSeconds: 0,
  busy: false,
  status: "",
  statusState: "idle",
  nameDirty: false,
  lastRecordPath: null,
  undoTokens: new Map(),
  // Default to overwriting existing clips so full-range renames reuse audio
  overwriteExisting: true,
};

const liveState = {
  open: false,
  active: false,
  statsTimer: null,
  hls: null,
  scriptPromise: null,
  sessionId: null,
  pc: null,
  stream: null,
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
const filtersLayoutQuery =
  typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 960px)") : null;
const reduceMotionQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

const filtersLayoutState = {
  isMobile: false,
  expanded: true,
  userOverride: false,
};

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

const archivalState = {
  current: null,
  lastAppliedFingerprint: "",
  dirty: false,
  saving: false,
  loading: false,
  loaded: false,
  pendingSnapshot: null,
  hasExternalUpdate: false,
  configPath: "",
  statusTimeoutId: null,
  fetchInFlight: false,
  fetchQueued: false,
};

const recorderState = {
  configPath: "",
  loaded: false,
  loadingPromise: null,
  sections: new Map(),
};

const recorderDialogState = {
  open: false,
  previouslyFocused: null,
  keydownHandler: null,
  activeSection: "",
};

const appMenuState = {
  open: false,
  previouslyFocused: null,
  pointerHandler: null,
  keydownHandler: null,
};

const archivalDialogState = {
  open: false,
  previouslyFocused: null,
  keydownHandler: null,
};

const configDialogState = {
  open: false,
  previouslyFocused: null,
  keydownHandler: null,
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

const rmsIndicatorState = {
  visible: false,
  value: null,
};

const recordingMetaState = {
  active: false,
  baseDuration: 0,
  baseTime: 0,
  sizeBytes: 0,
  text: "",
};

const recordingMetaTicker = {
  handle: null,
  usingAnimationFrame: false,
};

const encodingStatusState = {
  visible: false,
  hasActive: false,
  durationBase: 0,
  baseTime: 0,
  text: "",
  activeLabel: "",
  activeSource: "",
  pendingCount: 0,
  nextLabel: "",
  nextSource: "",
};

const encodingStatusTicker = {
  handle: null,
  usingAnimationFrame: false,
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

function readStoredClipperPreference() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CLIPPER_STORAGE_KEY);
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function persistClipperPreference(enabled) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    window.localStorage.setItem(CLIPPER_STORAGE_KEY, enabled ? "1" : "0");
  } catch (error) {
    /* ignore persistence errors */
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

function prefersReducedMotion() {
  if (!reduceMotionQuery) {
    return false;
  }
  return reduceMotionQuery.matches === true;
}

function setFiltersExpanded(expanded, options = {}) {
  if (!dom.filtersPanel) {
    return;
  }
  const { fromUser = false, focusPanel = false } = options;
  filtersLayoutState.expanded = expanded;
  if (!filtersLayoutState.isMobile) {
    filtersLayoutState.userOverride = false;
  } else if (fromUser) {
    filtersLayoutState.userOverride = true;
  }
  const stateValue = expanded ? "expanded" : "collapsed";
  dom.filtersPanel.dataset.state = stateValue;
  dom.filtersPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
  if (dom.filtersToggle) {
    dom.filtersToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  if (!expanded || !filtersLayoutState.isMobile || !focusPanel) {
    return;
  }
  window.requestAnimationFrame(() => {
    if (dom.filtersPanel) {
      const behavior = prefersReducedMotion() ? "auto" : "smooth";
      try {
        dom.filtersPanel.scrollIntoView({ block: "start", behavior });
      } catch (error) {
        dom.filtersPanel.scrollIntoView({ block: "start" });
      }
    }
    if (dom.filterSearch && typeof dom.filterSearch.focus === "function") {
      try {
        dom.filterSearch.focus({ preventScroll: true });
      } catch (error) {
        dom.filterSearch.focus();
      }
    }
  });
}

function updateFiltersLayout() {
  const isMobile = Boolean(filtersLayoutQuery && filtersLayoutQuery.matches);
  const changed = filtersLayoutState.isMobile !== isMobile;
  filtersLayoutState.isMobile = isMobile;
  if (!dom.filtersPanel) {
    return;
  }
  if (!isMobile) {
    filtersLayoutState.userOverride = false;
    setFiltersExpanded(true);
    return;
  }
  if (changed && !filtersLayoutState.userOverride) {
    setFiltersExpanded(false);
    return;
  }
  if (!filtersLayoutState.userOverride) {
    setFiltersExpanded(false);
  } else {
    setFiltersExpanded(filtersLayoutState.expanded);
  }
}

function setupResponsiveFilters() {
  if (!dom.filtersPanel) {
    return;
  }
  const initialState = dom.filtersPanel.dataset.state === "collapsed" ? "collapsed" : "expanded";
  filtersLayoutState.expanded = initialState !== "collapsed";
  updateFiltersLayout();
  if (filtersLayoutQuery) {
    const handleChange = () => {
      updateFiltersLayout();
    };
    if (typeof filtersLayoutQuery.addEventListener === "function") {
      filtersLayoutQuery.addEventListener("change", handleChange);
    } else if (typeof filtersLayoutQuery.addListener === "function") {
      filtersLayoutQuery.addListener(handleChange);
    }
  }
  if (dom.filtersToggle) {
    dom.filtersToggle.addEventListener("click", () => {
      if (!filtersLayoutState.isMobile) {
        if (dom.filtersPanel) {
          const behavior = prefersReducedMotion() ? "auto" : "smooth";
          try {
            dom.filtersPanel.scrollIntoView({ block: "start", behavior });
          } catch (error) {
            dom.filtersPanel.scrollIntoView({ block: "start" });
          }
        }
        if (dom.filterSearch && typeof dom.filterSearch.focus === "function") {
          window.requestAnimationFrame(() => {
            try {
              dom.filterSearch.focus({ preventScroll: true });
            } catch (error) {
              dom.filterSearch.focus();
            }
          });
        }
        return;
      }
      const next = !filtersLayoutState.expanded;
      setFiltersExpanded(next, { fromUser: true, focusPanel: next });
    });
  }
  if (dom.filtersClose) {
    dom.filtersClose.addEventListener("click", () => {
      if (!filtersLayoutState.isMobile) {
        return;
      }
      setFiltersExpanded(false, { fromUser: true });
      if (dom.filtersToggle && typeof dom.filtersToggle.focus === "function") {
        dom.filtersToggle.focus();
      }
    });
  }
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

function suspendConfigRefresh() {
  if (configRefreshSuspended) {
    return;
  }
  configRefreshSuspended = true;
  stopConfigRefresh();
}

function resumeConfigRefresh() {
  if (!configRefreshSuspended) {
    if (!configRefreshId) {
      startConfigRefresh();
    }
    return;
  }
  configRefreshSuspended = false;
  startConfigRefresh();
}

function suspendAutoRefresh() {
  suspendConfigRefresh();
  if (autoRefreshSuspended) {
    return;
  }
  autoRefreshSuspended = true;
  stopAutoRefresh();
}

function resumeAutoRefresh() {
  if (!autoRefreshSuspended) {
    resumeConfigRefresh();
    if (!autoRefreshId) {
      startAutoRefresh();
    }
    return;
  }
  autoRefreshSuspended = false;
  resumeConfigRefresh();
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
  hideRmsIndicator();
  hideRecordingMeta();
  hideEncodingStatus();
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
  const rawStopReason =
    typeof rawStatus.last_stop_reason === "string"
      ? rawStatus.last_stop_reason.trim()
      : "";
  const normalizedStopReason = rawStopReason.toLowerCase();
  const disabled = !capturing && normalizedStopReason === "shutdown";
  const state = capturing ? "active" : disabled ? "disabled" : "idle";
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
        detail = `Triggered @ ${Math.round(trigger)}`;
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
    message = disabled ? "Recording disabled" : "Recording idle";
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
    if (!detail && !disabled && rawStopReason) {
      detail = rawStopReason;
    }
    if (detail) {
      message += ` • ${detail}`;
    }
  }

  applyRecordingIndicator(state, message);
}

function scheduleRecordingMetaTick() {
  if (!recordingMetaState.active) {
    return;
  }
  if (recordingMetaTicker.handle !== null) {
    return;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    recordingMetaTicker.handle = window.requestAnimationFrame(handleRecordingMetaTick);
    recordingMetaTicker.usingAnimationFrame = true;
  } else {
    recordingMetaTicker.handle = setTimeout(() => {
      recordingMetaTicker.handle = null;
      handleRecordingMetaTick();
    }, 500);
    recordingMetaTicker.usingAnimationFrame = false;
  }
}

function cancelRecordingMetaTick() {
  if (recordingMetaTicker.handle === null) {
    return;
  }
  if (
    recordingMetaTicker.usingAnimationFrame &&
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function"
  ) {
    window.cancelAnimationFrame(recordingMetaTicker.handle);
  } else {
    clearTimeout(recordingMetaTicker.handle);
  }
  recordingMetaTicker.handle = null;
  recordingMetaTicker.usingAnimationFrame = false;
}

function handleRecordingMetaTick() {
  recordingMetaTicker.handle = null;
  if (!recordingMetaState.active) {
    return;
  }
  renderRecordingMeta();
  scheduleRecordingMetaTick();
}

function renderRecordingMeta() {
  if (!dom.recordingMeta || !dom.recordingMetaText || !recordingMetaState.active) {
    return;
  }
  const elapsedSeconds = Math.max(
    0,
    recordingMetaState.baseDuration + (nowMilliseconds() - recordingMetaState.baseTime) / 1000,
  );
  const sizeBytes = Number.isFinite(recordingMetaState.sizeBytes)
    ? Math.max(0, recordingMetaState.sizeBytes)
    : 0;
  const text = `Current Recording: ${formatShortDuration(elapsedSeconds)} • ${formatBytes(sizeBytes)}`;
  dom.recordingMeta.dataset.state = "active";
  if (text === recordingMetaState.text) {
    return;
  }
  dom.recordingMetaText.textContent = text;
  dom.recordingMeta.dataset.visible = "true";
  dom.recordingMeta.setAttribute("aria-hidden", "false");
  recordingMetaState.text = text;
}

function hideRecordingMeta() {
  if (!dom.recordingMeta || !dom.recordingMetaText) {
    return;
  }
  cancelRecordingMetaTick();
  recordingMetaState.active = false;
  recordingMetaState.baseDuration = 0;
  recordingMetaState.baseTime = nowMilliseconds();
  recordingMetaState.sizeBytes = 0;
  recordingMetaState.text = "";
  dom.recordingMeta.dataset.visible = "false";
  dom.recordingMeta.dataset.state = "idle";
  dom.recordingMeta.setAttribute("aria-hidden", "true");
  dom.recordingMetaText.textContent = "";
}

function updateRecordingMeta(rawStatus) {
  if (!dom.recordingMeta || !dom.recordingMetaText) {
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const capturing = status ? Boolean(status.capturing) : false;
  if (!capturing) {
    hideRecordingMeta();
    return;
  }
  const durationSeconds = status ? toFiniteOrNull(status.event_duration_seconds) : null;
  const sizeBytes = status ? toFiniteOrNull(status.event_size_bytes) : null;
  const event = status && typeof status.event === "object" ? status.event : null;
  const startedEpoch = event ? toFiniteOrNull(event.started_epoch) : null;

  if (durationSeconds !== null) {
    recordingMetaState.baseDuration = Math.max(0, durationSeconds);
    recordingMetaState.baseTime = nowMilliseconds();
  } else if (startedEpoch !== null) {
    recordingMetaState.baseDuration = Math.max(0, Date.now() / 1000 - startedEpoch);
    recordingMetaState.baseTime = nowMilliseconds();
  } else if (!recordingMetaState.active) {
    recordingMetaState.baseDuration = 0;
    recordingMetaState.baseTime = nowMilliseconds();
  }

  if (sizeBytes !== null) {
    recordingMetaState.sizeBytes = Math.max(0, sizeBytes);
  }

  recordingMetaState.active = true;
  recordingMetaState.text = "";
  renderRecordingMeta();
  scheduleRecordingMetaTick();
}

function scheduleEncodingStatusTick() {
  if (!encodingStatusState.hasActive) {
    return;
  }
  if (encodingStatusTicker.handle !== null) {
    return;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    encodingStatusTicker.handle = window.requestAnimationFrame(handleEncodingStatusTick);
    encodingStatusTicker.usingAnimationFrame = true;
  } else {
    encodingStatusTicker.handle = setTimeout(() => {
      encodingStatusTicker.handle = null;
      handleEncodingStatusTick();
    }, 500);
    encodingStatusTicker.usingAnimationFrame = false;
  }
}

function cancelEncodingStatusTick() {
  if (encodingStatusTicker.handle === null) {
    return;
  }
  if (
    encodingStatusTicker.usingAnimationFrame &&
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function"
  ) {
    window.cancelAnimationFrame(encodingStatusTicker.handle);
  } else {
    clearTimeout(encodingStatusTicker.handle);
  }
  encodingStatusTicker.handle = null;
  encodingStatusTicker.usingAnimationFrame = false;
}

function handleEncodingStatusTick() {
  encodingStatusTicker.handle = null;
  if (!encodingStatusState.hasActive) {
    return;
  }
  renderEncodingStatus();
  scheduleEncodingStatusTick();
}

function renderEncodingStatus() {
  if (!dom.encodingStatus || !dom.encodingStatusText) {
    return;
  }
  if (!encodingStatusState.visible) {
    if (dom.encodingStatus.dataset.visible !== "false") {
      dom.encodingStatus.dataset.visible = "false";
      dom.encodingStatus.setAttribute("aria-hidden", "true");
      dom.encodingStatusText.textContent = "";
    }
    encodingStatusState.text = "";
    return;
  }
  let durationSeconds = Math.max(0, encodingStatusState.durationBase);
  if (encodingStatusState.hasActive) {
    durationSeconds = Math.max(
      0,
      encodingStatusState.durationBase + (nowMilliseconds() - encodingStatusState.baseTime) / 1000,
    );
  }
  const parts = [];
  if (encodingStatusState.hasActive) {
    const sourceLabel = formatEncodingSource(encodingStatusState.activeSource);
    const statusLabel = sourceLabel ? `Encoding active (${sourceLabel})` : "Encoding active";
    parts.push(statusLabel);
    if (encodingStatusState.activeLabel) {
      parts.push(encodingStatusState.activeLabel);
    }
    parts.push(formatShortDuration(durationSeconds));
    if (encodingStatusState.pendingCount > 0) {
      parts.push(
        encodingStatusState.pendingCount === 1
          ? "1 pending"
          : `${encodingStatusState.pendingCount} pending`,
      );
    }
  } else {
    parts.push("Encoding pending");
    if (encodingStatusState.pendingCount > 0) {
      parts.push(
        encodingStatusState.pendingCount === 1
          ? "1 job queued"
          : `${encodingStatusState.pendingCount} jobs queued`,
      );
    }
    const nextSourceLabel = formatEncodingSource(encodingStatusState.nextSource);
    if (encodingStatusState.nextLabel) {
      const suffix = nextSourceLabel ? ` (${nextSourceLabel})` : "";
      parts.push(`Next: ${encodingStatusState.nextLabel}${suffix}`);
    } else if (nextSourceLabel) {
      parts.push(nextSourceLabel);
    }
  }
  const text = parts.join(" • ");
  if (text === encodingStatusState.text) {
    return;
  }
  dom.encodingStatusText.textContent = text;
  dom.encodingStatus.dataset.visible = "true";
  dom.encodingStatus.setAttribute("aria-hidden", "false");
  encodingStatusState.text = text;
}

function hideEncodingStatus() {
  if (!dom.encodingStatus || !dom.encodingStatusText) {
    return;
  }
  cancelEncodingStatusTick();
  encodingStatusState.visible = false;
  encodingStatusState.hasActive = false;
  encodingStatusState.durationBase = 0;
  encodingStatusState.baseTime = nowMilliseconds();
  encodingStatusState.activeLabel = "";
  encodingStatusState.activeSource = "";
  encodingStatusState.pendingCount = 0;
  encodingStatusState.nextLabel = "";
  encodingStatusState.nextSource = "";
  encodingStatusState.text = "";
  dom.encodingStatus.dataset.visible = "false";
  dom.encodingStatus.setAttribute("aria-hidden", "true");
  dom.encodingStatusText.textContent = "";
}

function updateEncodingStatus(rawStatus) {
  if (!dom.encodingStatus || !dom.encodingStatusText) {
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const encoding = status && typeof status.encoding === "object" ? status.encoding : null;
  const pending = encoding && Array.isArray(encoding.pending) ? encoding.pending : [];
  const active = encoding && encoding.active && typeof encoding.active === "object"
    ? encoding.active
    : null;

  if ((!pending || pending.length === 0) && !active) {
    hideEncodingStatus();
    return;
  }

  encodingStatusState.visible = true;
  encodingStatusState.pendingCount = Array.isArray(pending) ? pending.length : 0;
  encodingStatusState.nextLabel =
    encodingStatusState.pendingCount > 0 && typeof pending[0].base_name === "string"
      ? pending[0].base_name
      : "";
  encodingStatusState.nextSource =
    encodingStatusState.pendingCount > 0 && typeof pending[0].source === "string"
      ? normalizeEncodingSource(pending[0].source)
      : "";

  if (active) {
    encodingStatusState.hasActive = true;
    encodingStatusState.activeLabel =
      typeof active.base_name === "string" ? active.base_name : "";
    encodingStatusState.activeSource =
      typeof active.source === "string" ? normalizeEncodingSource(active.source) : "";
    const startedAt = toFiniteOrNull(active.started_at);
    let baseDuration = toFiniteOrNull(active.duration_seconds);
    if (!Number.isFinite(baseDuration)) {
      baseDuration = startedAt !== null ? Math.max(0, Date.now() / 1000 - startedAt) : 0;
    }
    encodingStatusState.durationBase = Math.max(0, baseDuration || 0);
    encodingStatusState.baseTime = nowMilliseconds();
  } else {
    encodingStatusState.hasActive = false;
    encodingStatusState.activeLabel = "";
    encodingStatusState.activeSource = "";
    encodingStatusState.durationBase = 0;
    encodingStatusState.baseTime = nowMilliseconds();
  }

  encodingStatusState.text = "";
  renderEncodingStatus();
  if (encodingStatusState.hasActive) {
    scheduleEncodingStatusTick();
  } else {
    cancelEncodingStatusTick();
  }
}

function hideRmsIndicator() {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  if (dom.rmsIndicator.dataset.visible !== "false") {
    dom.rmsIndicator.dataset.visible = "false";
  }
  dom.rmsIndicator.setAttribute("aria-hidden", "true");
  dom.rmsIndicatorValue.textContent = "";
  rmsIndicatorState.visible = false;
  rmsIndicatorState.value = null;
}

function updateRmsIndicator(rawStatus) {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const running = status ? parseBoolean(status.service_running) : false;
  const rmsValue = status ? toFiniteOrNull(status.current_rms) : null;
  if (!running || rmsValue === null) {
    hideRmsIndicator();
    return;
  }
  const whole = Math.trunc(rmsValue);
  if (!Number.isFinite(whole)) {
    hideRmsIndicator();
    return;
  }
  if (rmsIndicatorState.visible && rmsIndicatorState.value === whole) {
    return;
  }
  dom.rmsIndicatorValue.textContent = String(whole);
  dom.rmsIndicator.dataset.visible = "true";
  dom.rmsIndicator.setAttribute("aria-hidden", "false");
  rmsIndicatorState.visible = true;
  rmsIndicatorState.value = whole;
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

function formatShortDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(seconds);
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

function normalizeEncodingSource(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function formatEncodingSource(value) {
  const normalized = normalizeEncodingSource(value);
  if (!normalized) {
    return "";
  }
  if (normalized === "live") {
    return "Live capture";
  }
  if (normalized === "dropbox" || normalized === "ingest") {
    return "Dropbox ingest";
  }
  if (normalized === "unknown") {
    return "Unknown source";
  }
  return value.trim();
}

function formatTimecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00.000";
  }
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

function parseTimecodeInput(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/,/g, ".");
  const parts = normalized.split(":");
  if (parts.length > 3) {
    return null;
  }
  const secondsToken = parts.pop();
  if (secondsToken === undefined) {
    return null;
  }
  const seconds = Number.parseFloat(secondsToken);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  let minutes = 0;
  if (parts.length > 0) {
    const minutesToken = parts.pop();
    if (minutesToken === undefined) {
      return null;
    }
    minutes = Number.parseInt(minutesToken, 10);
    if (!Number.isFinite(minutes) || minutes < 0) {
      return null;
    }
  }
  let hours = 0;
  if (parts.length > 0) {
    const hoursToken = parts.pop();
    if (hoursToken === undefined) {
      return null;
    }
    hours = Number.parseInt(hoursToken, 10);
    if (!Number.isFinite(hours) || hours < 0) {
      return null;
    }
  }
  if (parts.length > 0) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTimeSlug(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "000000000";
  }
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}${minutes
      .toString()
      .padStart(2, "0")}${secs.toString().padStart(2, "0")}${millis
      .toString()
      .padStart(3, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}${secs
    .toString()
    .padStart(2, "0")}${millis.toString().padStart(3, "0")}`;
}

function sanitizeClipName(value) {
  if (typeof value !== "string") {
    return "";
  }
  const replaced = value.replace(/[^A-Za-z0-9._-]+/g, "_");
  const trimmed = replaced.replace(/^[._-]+|[._-]+$/g, "");
  if (!trimmed) {
    return "";
  }
  const truncated = trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
  return truncated.replace(/^[._-]+|[._-]+$/g, "");
}

function getRecordDirectoryPath(record) {
  if (record && typeof record === "object" && typeof record.path === "string") {
    const path = record.path;
    const lastSlash = path.lastIndexOf("/");
    return lastSlash > 0 ? path.slice(0, lastSlash) : "";
  }
  if (typeof record === "string" && record) {
    const lastSlash = record.lastIndexOf("/");
    return lastSlash > 0 ? record.slice(0, lastSlash) : "";
  }
  return "";
}

function deriveRecordBaseName(record) {
  if (record && typeof record === "object" && typeof record.name === "string" && record.name.trim()) {
    const sanitized = sanitizeClipName(record.name.trim());
    if (sanitized) {
      return sanitized;
    }
  }
  let candidate = "";
  if (record && typeof record === "object" && typeof record.path === "string" && record.path) {
    const parts = record.path.split("/");
    candidate = parts[parts.length - 1] || "";
  }
  if (!candidate && typeof record === "string") {
    const parts = record.split("/");
    candidate = parts[parts.length - 1] || "";
  }
  if (candidate.includes(".")) {
    const dot = candidate.lastIndexOf(".");
    candidate = dot > 0 ? candidate.slice(0, dot) : candidate;
  }
  const sanitized = sanitizeClipName(candidate);
  return sanitized || "clip";
}

function getOverwriteClipName(record) {
  return deriveRecordBaseName(record);
}

function generateClipRangeName(record, startSeconds, endSeconds) {
  const baseName = deriveRecordBaseName(record);
  const slug = `${baseName}_${formatTimeSlug(startSeconds)}-${formatTimeSlug(endSeconds)}`;
  const sanitized = sanitizeClipName(slug);
  return sanitized || baseName || "clip";
}

function ensureUniqueClipName(name, record) {
  const sanitized = sanitizeClipName(name);
  const baseName = sanitized || "clip";
  const directory = getRecordDirectoryPath(record);
  const extension =
    record && typeof record === "object" && typeof record.extension === "string" && record.extension
      ? record.extension
      : "opus";
  const prefix = directory ? `${directory}/` : "";
  const knownPaths = new Set();
  for (const entry of state.records) {
    if (entry && typeof entry.path === "string") {
      knownPaths.add(entry.path);
    }
  }
  let candidate = baseName;
  let suffix = 1;
  while (true) {
    const targetPath = `${prefix}${candidate}.${extension}`;
    if (knownPaths.has(targetPath)) {
      candidate = `${baseName}-${suffix}`;
      suffix += 1;
      continue;
    }
    break;
  }
  return candidate;
}

function computeClipDefaultName(record, startSeconds, endSeconds, overwriteExisting = true) {
  if (overwriteExisting) {
    return getOverwriteClipName(record);
  }
  const rangeName = generateClipRangeName(record, startSeconds, endSeconds);
  return ensureUniqueClipName(rangeName, record);
}

function formatClipLengthText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Clip length: --";
  }
  const durationText = formatDuration(seconds);
  return `Clip length: ${durationText} (${seconds.toFixed(3)}s)`;
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

function setRenameModalVisible(visible) {
  if (!dom.renameModal) {
    return;
  }
  if (visible) {
    dom.renameModal.hidden = false;
    dom.renameModal.dataset.visible = "true";
    dom.renameModal.setAttribute("aria-hidden", "false");
  } else {
    dom.renameModal.dataset.visible = "false";
    dom.renameModal.setAttribute("aria-hidden", "true");
    dom.renameModal.hidden = true;
  }
}

function setRenameDialogError(message) {
  if (!dom.renameError) {
    return;
  }
  if (typeof message === "string" && message) {
    dom.renameError.textContent = message;
    dom.renameError.hidden = false;
  } else {
    dom.renameError.textContent = "";
    dom.renameError.hidden = true;
  }
}

function setRenameDialogPending(pending) {
  renameDialogState.pending = Boolean(pending);
  if (dom.renameConfirm) {
    dom.renameConfirm.disabled = pending === true;
  }
  if (dom.renameInput) {
    dom.renameInput.disabled = pending === true;
  }
  if (dom.renameCancel) {
    dom.renameCancel.disabled = pending === true;
  }
  updateSelectionUI();
}

function closeRenameDialog() {
  if (!renameDialogState.open) {
    return;
  }
  renameDialogState.open = false;
  const previous = renameDialogState.previouslyFocused;
  renameDialogState.previouslyFocused = null;
  renameDialogState.target = null;
  setRenameDialogPending(false);
  setRenameDialogError("");
  setRenameModalVisible(false);
  if (previous && typeof previous.focus === "function") {
    window.requestAnimationFrame(() => {
      previous.focus();
    });
  }
}

function renameDialogFocusableElements() {
  if (!dom.renameDialog) {
    return [];
  }
  const nodes = dom.renameDialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled])'
  );
  return Array.from(nodes).filter((element) => element instanceof HTMLElement);
}

function openRenameDialog(record) {
  if (
    !dom.renameModal ||
    !dom.renameDialog ||
    !dom.renameForm ||
    !dom.renameInput ||
    !dom.renameConfirm ||
    !dom.renameCancel
  ) {
    if (
      record &&
      typeof record.path === "string" &&
      typeof window !== "undefined" &&
      typeof window.prompt === "function"
    ) {
      const promptValue = window.prompt(
        "Enter a new name for the recording",
        typeof record.name === "string" && record.name ? record.name : record.path
      );
      const trimmed = promptValue ? promptValue.trim() : "";
      if (trimmed) {
        const extensionValue =
          typeof record.extension === "string" && record.extension ? record.extension : "";
        const hasSuffix = trimmed.includes(".");
        const options = {};
        if (!hasSuffix && extensionValue) {
          options.extension = extensionValue;
        }
        void renameRecording(record.path, trimmed, options);
      }
    }
    return;
  }

  renameDialogState.open = true;
  renameDialogState.target = record || null;
  renameDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setRenameDialogPending(false);
  setRenameDialogError("");

  if (record && typeof record.name === "string") {
    dom.renameInput.value = record.name;
  } else if (record && typeof record.path === "string") {
    const parts = record.path.split("/");
    dom.renameInput.value = parts.length ? parts[parts.length - 1] : record.path;
  } else {
    dom.renameInput.value = "";
  }
  dom.renameInput.dataset.extension =
    record && typeof record.extension === "string" ? record.extension : "";

  setRenameModalVisible(true);

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (dom.renameDialog) {
        dom.renameDialog.focus();
      }
      if (dom.renameInput) {
        dom.renameInput.focus();
        dom.renameInput.select();
      }
    });
  });
}

async function handleRenameSubmit(event) {
  event.preventDefault();
  if (!renameDialogState.open || renameDialogState.pending) {
    return;
  }
  if (!dom.renameInput) {
    return;
  }
  const value = dom.renameInput.value.trim();
  if (!value) {
    setRenameDialogError("Enter a new name.");
    return;
  }
  const target = renameDialogState.target;
  if (!target || typeof target.path !== "string") {
    setRenameDialogError("Unable to rename this recording.");
    return;
  }

  const hasSuffix = value.includes(".");
  const extensionValue = dom.renameInput.dataset.extension || target.extension || "";
  const options = {};
  if (!hasSuffix && extensionValue) {
    options.extension = extensionValue;
  }

  setRenameDialogPending(true);
  try {
    await renameRecording(target.path, value, options);
    closeRenameDialog();
  } catch (error) {
    console.error("Rename request failed", error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unable to rename recording.";
    setRenameDialogError(message);
    setRenameDialogPending(false);
  }
}

if (dom.renameForm) {
  dom.renameForm.addEventListener("submit", handleRenameSubmit);
}

if (dom.renameCancel) {
  dom.renameCancel.addEventListener("click", () => {
    if (!renameDialogState.pending) {
      closeRenameDialog();
    }
  });
}

if (dom.renameModal) {
  dom.renameModal.addEventListener("click", (event) => {
    if (!renameDialogState.pending && event.target === dom.renameModal) {
      closeRenameDialog();
    }
  });
  dom.renameModal.addEventListener("keydown", (event) => {
    if (!renameDialogState.open) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (!renameDialogState.pending) {
        closeRenameDialog();
      }
      return;
    }
    if (event.key === "Tab") {
      const focusable = renameDialogFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const active =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      let index = focusable.indexOf(active);
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
    return;
  }
  dom.refreshIndicator.dataset.visible = visible ? "true" : "false";
  dom.refreshIndicator.setAttribute("aria-hidden", visible ? "false" : "true");
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
  if (dom.tableBody) {
    const rows = dom.tableBody.querySelectorAll("tr");
    for (const row of rows) {
      if (!(row instanceof HTMLElement)) {
        continue;
      }
      const path = row.getAttribute("data-path");
      if (!path) {
        continue;
      }
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox instanceof HTMLInputElement) {
        checkbox.checked = state.selections.has(path);
      }
    }
  }
  const selectedText = state.selections.size.toString();
  dom.selectedCount.textContent = selectedText;
  if (dom.selectedCountMobile) {
    dom.selectedCountMobile.textContent = selectedText;
  }
  dom.deleteSelected.disabled = state.selections.size === 0;
  if (dom.downloadSelected) {
    dom.downloadSelected.disabled = state.selections.size === 0;
  }
  if (dom.renameSelected) {
    dom.renameSelected.disabled = state.selections.size !== 1 || renameDialogState.pending;
  }

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
    initializeClipper(null);
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
  if (!sameRecord) {
    initializeClipper(record);
  }
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

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.textContent = "Rename";
    renameButton.classList.add("ghost-button");
    renameButton.classList.add("small");
    renameButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openRenameDialog(record);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.classList.add("danger-button");
    deleteButton.addEventListener("click", async () => {
      await requestRecordDeletion(record);
    });

    actionWrapper.append(downloadLink, renameButton, deleteButton);
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
  const recordingsText = state.total.toString();
  dom.recordingCount.textContent = recordingsText;
  if (dom.recordingCountMobile) {
    dom.recordingCountMobile.textContent = recordingsText;
  }
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

function updateClipperStatusElement() {
  if (!dom.clipperStatus) {
    return;
  }
  const message = clipperState.status || "";
  dom.clipperStatus.textContent = message;
  if (clipperState.statusState && clipperState.statusState !== "idle") {
    dom.clipperStatus.dataset.state = clipperState.statusState;
  } else if (dom.clipperStatus.dataset.state) {
    delete dom.clipperStatus.dataset.state;
  }
  const shouldShow = clipperState.enabled && clipperState.available;
  dom.clipperStatus.setAttribute("aria-hidden", shouldShow ? "false" : "true");
}

function updateClipperSummary() {
  if (!dom.clipperSummary) {
    return;
  }
  let message = "";
  if (!clipperState.available) {
    message = clipperState.enabled
      ? "Clip editor enabled. Select a recording to start editing."
      : "Select a recording to use the clip editor.";
  } else if (!clipperState.enabled) {
    message = "Enable the clip editor to create a clip from this recording.";
  }
  const hidden = !message;
  dom.clipperSummary.textContent = message;
  dom.clipperSummary.hidden = hidden;
  dom.clipperSummary.setAttribute("aria-hidden", hidden ? "true" : "false");
}

function syncClipperUI() {
  const available = Boolean(clipperState.available);
  const enabled = Boolean(clipperState.enabled);
  const shouldShow = available && enabled;

  if (dom.clipperSection) {
    dom.clipperSection.hidden = !shouldShow;
    dom.clipperSection.dataset.active = shouldShow ? "true" : "false";
    dom.clipperSection.setAttribute("aria-hidden", shouldShow ? "false" : "true");
  }
  if (dom.clipperContainer) {
    dom.clipperContainer.dataset.available = available ? "true" : "false";
    dom.clipperContainer.dataset.enabled = enabled ? "true" : "false";
  }
  if (dom.clipperToggle) {
    dom.clipperToggle.setAttribute("aria-expanded", shouldShow ? "true" : "false");
    dom.clipperToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    dom.clipperToggle.textContent = enabled ? "Disable clip editor" : "Enable clip editor";
  }

  updateClipperStatusElement();
  updateClipperSummary();
}

function setClipperVisible(available) {
  clipperState.available = Boolean(available);
  syncClipperUI();
}

function setClipperStatus(message, state = "idle") {
  clipperState.status = message || "";
  clipperState.statusState = state;
  updateClipperStatusElement();
}

function setClipperEnabled(enabled, { persist = true, focus = false } = {}) {
  const next = Boolean(enabled);
  if (clipperState.enabled === next) {
    syncClipperUI();
    if (focus && next && clipperState.available && dom.clipperStartInput) {
      window.requestAnimationFrame(() => {
        try {
          dom.clipperStartInput.focus({ preventScroll: true });
        } catch (error) {
          dom.clipperStartInput.focus();
        }
      });
    }
    return;
  }

  clipperState.enabled = next;

  if (persist) {
    persistClipperPreference(next);
  }

  syncClipperUI();

  if (next) {
    if (clipperState.available) {
      updateClipperUI({ updateInputs: true });
    }
    if (focus && clipperState.available && dom.clipperStartInput) {
      window.requestAnimationFrame(() => {
        try {
          dom.clipperStartInput.focus({ preventScroll: true });
        } catch (error) {
          dom.clipperStartInput.focus();
        }
      });
    }
  } else {
    resumeAutoRefresh();
  }
}

function restoreClipperPreference() {
  const stored = readStoredClipperPreference();
  if (stored === null) {
    clipperState.enabled = false;
    syncClipperUI();
    return;
  }
  setClipperEnabled(stored, { persist: false });
}

function updateClipperName(record = state.current) {
  if (!dom.clipperNameInput) {
    return;
  }
  const duration = Number.isFinite(clipperState.durationSeconds)
    ? clipperState.durationSeconds
    : null;
  if (duration === null || duration < MIN_CLIP_DURATION_SECONDS) {
    dom.clipperNameInput.value = "";
    return;
  }
  const defaultName = computeClipDefaultName(
    record,
    clipperState.startSeconds,
    clipperState.endSeconds,
    clipperState.overwriteExisting,
  );
  dom.clipperNameInput.value = defaultName;
  clipperState.nameDirty = false;
}

function updateClipperLengthElement(valid, clipLength) {
  if (!dom.clipperLength) {
    return;
  }
  if (valid) {
    dom.clipperLength.textContent = formatClipLengthText(clipLength);
    dom.clipperLength.dataset.state = "ready";
  } else {
    dom.clipperLength.textContent = "Clip length: invalid range";
    dom.clipperLength.dataset.state = "error";
  }
}

function updateClipperUI({ updateInputs = true, updateName = true } = {}) {
  const duration = Number.isFinite(clipperState.durationSeconds)
    ? clipperState.durationSeconds
    : null;
  if (duration === null || duration < MIN_CLIP_DURATION_SECONDS) {
    setClipperVisible(false);
    updateClipperStatusElement();
    return;
  }

  setClipperVisible(true);

  const start = clamp(Number.isFinite(clipperState.startSeconds) ? clipperState.startSeconds : 0, 0, duration);
  let end = clamp(Number.isFinite(clipperState.endSeconds) ? clipperState.endSeconds : duration, 0, duration);
  if (end - start < MIN_CLIP_DURATION_SECONDS) {
    end = Math.min(duration, start + MIN_CLIP_DURATION_SECONDS);
    if (end - start < MIN_CLIP_DURATION_SECONDS) {
      const adjustedStart = Math.max(0, end - MIN_CLIP_DURATION_SECONDS);
      clipperState.startSeconds = adjustedStart;
      clipperState.endSeconds = Math.min(duration, adjustedStart + MIN_CLIP_DURATION_SECONDS);
    } else {
      clipperState.startSeconds = start;
      clipperState.endSeconds = end;
    }
  } else {
    clipperState.startSeconds = start;
    clipperState.endSeconds = end;
  }

  if (updateName && !clipperState.nameDirty) {
    updateClipperName();
  }

  if (updateInputs) {
    if (dom.clipperStartInput) {
      dom.clipperStartInput.value = formatTimecode(clipperState.startSeconds);
    }
    if (dom.clipperEndInput) {
      dom.clipperEndInput.value = formatTimecode(clipperState.endSeconds);
    }
  }

  const clipLength = clipperState.endSeconds - clipperState.startSeconds;
  const valid = clipLength >= MIN_CLIP_DURATION_SECONDS && clipLength <= duration;
  updateClipperLengthElement(valid, clipLength);

  if (dom.clipperSubmit) {
    dom.clipperSubmit.disabled = clipperState.busy || !valid;
  }
  if (dom.clipperReset) {
    dom.clipperReset.disabled = clipperState.busy;
  }
  if (dom.clipperSetStart) {
    dom.clipperSetStart.disabled = clipperState.busy;
  }
  if (dom.clipperSetEnd) {
    dom.clipperSetEnd.disabled = clipperState.busy;
  }
  if (dom.clipperStartInput) {
    dom.clipperStartInput.disabled = clipperState.busy;
  }
  if (dom.clipperEndInput) {
    dom.clipperEndInput.disabled = clipperState.busy;
  }
  if (dom.clipperNameInput) {
    dom.clipperNameInput.disabled = clipperState.busy;
  }
  if (dom.clipperOverwriteToggle) {
    dom.clipperOverwriteToggle.checked = clipperState.overwriteExisting;
    dom.clipperOverwriteToggle.disabled = clipperState.busy;
  }

  if (dom.clipperUndo) {
    let undoToken = null;
    if (
      clipperState.undoTokens instanceof Map &&
      state.current &&
      typeof state.current.path === "string"
    ) {
      undoToken = clipperState.undoTokens.get(state.current.path) || null;
    }
    if (undoToken) {
      dom.clipperUndo.hidden = false;
      dom.clipperUndo.disabled = clipperState.busy;
      dom.clipperUndo.setAttribute("aria-hidden", "false");
    } else {
      dom.clipperUndo.hidden = true;
      dom.clipperUndo.disabled = true;
      dom.clipperUndo.setAttribute("aria-hidden", "true");
    }
  }

  updateClipperStatusElement();
}

function initializeClipper(record) {
  const duration = record ? toFiniteOrNull(record.duration_seconds) : null;
  if (!Number.isFinite(duration) || duration === null || duration < MIN_CLIP_DURATION_SECONDS) {
    clipperState.durationSeconds = null;
    clipperState.startSeconds = 0;
    clipperState.endSeconds = 0;
    clipperState.busy = false;
    clipperState.status = "";
    clipperState.statusState = "idle";
    clipperState.nameDirty = false;
    clipperState.lastRecordPath = record && typeof record.path === "string" ? record.path : null;
    clipperState.overwriteExisting = true;
    if (dom.clipperOverwriteToggle) {
      dom.clipperOverwriteToggle.checked = true;
    }
    setClipperVisible(false);
    updateClipperStatusElement();
    return;
  }

  clipperState.durationSeconds = duration;
  clipperState.startSeconds = 0;
  clipperState.endSeconds = duration;
  clipperState.busy = false;
  clipperState.status = "";
  clipperState.statusState = "idle";
  clipperState.nameDirty = false;
  clipperState.lastRecordPath = record && typeof record.path === "string" ? record.path : null;
  clipperState.overwriteExisting = true;
  if (dom.clipperOverwriteToggle) {
    dom.clipperOverwriteToggle.checked = true;
  }
  updateClipperUI({ updateInputs: true });
}

function resetClipperRange() {
  if (!Number.isFinite(clipperState.durationSeconds)) {
    return;
  }
  clipperState.startSeconds = 0;
  clipperState.endSeconds = clipperState.durationSeconds;
  clipperState.nameDirty = false;
  clipperState.overwriteExisting = true;
  setClipperStatus("", "idle");
  updateClipperUI();
}

function setClipperStartFromPlayhead() {
  if (!dom.player || !Number.isFinite(clipperState.durationSeconds)) {
    return;
  }
  const duration = clipperState.durationSeconds;
  const position = clamp(numericValue(dom.player.currentTime, 0), 0, duration);
  clipperState.startSeconds = position;
  if (clipperState.endSeconds - clipperState.startSeconds < MIN_CLIP_DURATION_SECONDS) {
    clipperState.endSeconds = Math.min(duration, position + MIN_CLIP_DURATION_SECONDS);
  }
  if (!clipperState.nameDirty) {
    updateClipperName();
  }
  setClipperStatus("", "idle");
  updateClipperUI();
}

function setClipperEndFromPlayhead() {
  if (!dom.player || !Number.isFinite(clipperState.durationSeconds)) {
    return;
  }
  const duration = clipperState.durationSeconds;
  const position = clamp(numericValue(dom.player.currentTime, duration), 0, duration);
  clipperState.endSeconds = position;
  if (clipperState.endSeconds - clipperState.startSeconds < MIN_CLIP_DURATION_SECONDS) {
    clipperState.startSeconds = Math.max(0, position - MIN_CLIP_DURATION_SECONDS);
  }
  if (!clipperState.nameDirty) {
    updateClipperName();
  }
  setClipperStatus("", "idle");
  updateClipperUI();
}

function handleClipperStartChange() {
  if (!dom.clipperStartInput || !Number.isFinite(clipperState.durationSeconds)) {
    return;
  }
  const parsed = parseTimecodeInput(dom.clipperStartInput.value);
  const duration = clipperState.durationSeconds;
  if (!Number.isFinite(parsed)) {
    setClipperStatus("Enter a valid start time.", "error");
    updateClipperUI({ updateInputs: true });
    return;
  }
  clipperState.startSeconds = clamp(parsed, 0, duration);
  if (clipperState.endSeconds - clipperState.startSeconds < MIN_CLIP_DURATION_SECONDS) {
    clipperState.endSeconds = Math.min(duration, clipperState.startSeconds + MIN_CLIP_DURATION_SECONDS);
  }
  setClipperStatus("", "idle");
  updateClipperUI();
}

function handleClipperEndChange() {
  if (!dom.clipperEndInput || !Number.isFinite(clipperState.durationSeconds)) {
    return;
  }
  const parsed = parseTimecodeInput(dom.clipperEndInput.value);
  const duration = clipperState.durationSeconds;
  if (!Number.isFinite(parsed)) {
    setClipperStatus("Enter a valid end time.", "error");
    updateClipperUI({ updateInputs: true });
    return;
  }
  clipperState.endSeconds = clamp(parsed, 0, duration);
  if (clipperState.endSeconds - clipperState.startSeconds < MIN_CLIP_DURATION_SECONDS) {
    clipperState.startSeconds = Math.max(0, clipperState.endSeconds - MIN_CLIP_DURATION_SECONDS);
  }
  setClipperStatus("", "idle");
  updateClipperUI();
}

function handleClipperNameInput() {
  if (!dom.clipperNameInput) {
    return;
  }
  const trimmed = dom.clipperNameInput.value.trim();
  const defaultName = computeClipDefaultName(
    state.current,
    clipperState.startSeconds,
    clipperState.endSeconds,
    clipperState.overwriteExisting,
  );
  clipperState.nameDirty = trimmed.length > 0 && trimmed !== defaultName;
}

function handleClipperNameBlur() {
  if (!dom.clipperNameInput) {
    return;
  }
  if (!dom.clipperNameInput.value.trim()) {
    updateClipperName();
  }
}

function handleClipperOverwriteChange() {
  if (!dom.clipperOverwriteToggle) {
    return;
  }
  const next = Boolean(dom.clipperOverwriteToggle.checked);
  if (clipperState.overwriteExisting === next) {
    return;
  }
  clipperState.overwriteExisting = next;
  if (!state.current || !Number.isFinite(clipperState.durationSeconds)) {
    updateClipperUI({ updateInputs: false, updateName: false });
    return;
  }
  const defaultOverwrite = computeClipDefaultName(
    state.current,
    clipperState.startSeconds,
    clipperState.endSeconds,
    true,
  );
  const defaultUnique = computeClipDefaultName(
    state.current,
    clipperState.startSeconds,
    clipperState.endSeconds,
    false,
  );
  if (!dom.clipperNameInput) {
    clipperState.nameDirty = false;
    updateClipperUI({ updateInputs: false, updateName: false });
    return;
  }
  if (next) {
    dom.clipperNameInput.value = defaultOverwrite;
    clipperState.nameDirty = false;
  } else {
    const trimmed = dom.clipperNameInput.value.trim();
    if (!trimmed || trimmed === defaultOverwrite) {
      dom.clipperNameInput.value = defaultUnique;
      clipperState.nameDirty = false;
    } else {
      const sanitized = sanitizeClipName(trimmed);
      if (!sanitized) {
        dom.clipperNameInput.value = defaultUnique;
        clipperState.nameDirty = false;
      } else {
        const ensured = ensureUniqueClipName(sanitized, state.current);
        dom.clipperNameInput.value = ensured;
        clipperState.nameDirty = ensured !== defaultUnique;
      }
    }
  }
  updateClipperUI({ updateInputs: false, updateName: false });
}

function handleClipperReset() {
  resetClipperRange();
}

async function handleClipperUndo() {
  if (
    !dom.clipperUndo ||
    !(clipperState.undoTokens instanceof Map) ||
    !state.current ||
    typeof state.current.path !== "string" ||
    clipperState.busy
  ) {
    return;
  }

  const recordPath = state.current.path;
  const token = clipperState.undoTokens.get(recordPath);
  if (!token) {
    return;
  }

  setClipperStatus("Restoring previous clip…", "pending");
  clipperState.busy = true;
  updateClipperUI();

  try {
    const response = await fetch(apiPath("/api/recordings/clip/undo"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      let message = `Unable to restore clip (status ${response.status})`;
      try {
        const errorBody = await response.json();
        if (errorBody && typeof errorBody === "object") {
          if (typeof errorBody.reason === "string" && errorBody.reason) {
            message = errorBody.reason;
          } else if (typeof errorBody.error === "string" && errorBody.error) {
            message = errorBody.error;
          }
        }
      } catch (jsonError) {
        try {
          const text = await response.text();
          if (text && text.trim()) {
            message = text.trim();
          }
        } catch (textError) {
          /* ignore text parse errors */
        }
      }
      throw new Error(message);
    }

    let responsePayload = null;
    try {
      responsePayload = await response.json();
    } catch (parseError) {
      responsePayload = null;
    }

    clipperState.busy = false;
    clipperState.undoTokens.delete(recordPath);
    setClipperStatus("Previous clip restored.", "success");

    if (responsePayload && typeof responsePayload.path === "string") {
      pendingSelectionPath = responsePayload.path;
    }

    updateClipperUI();
    await fetchRecordings({ silent: false });
  } catch (error) {
    console.error("Clip undo failed", error);
    clipperState.busy = false;
    const message = error instanceof Error && error.message ? error.message : "Unable to restore clip.";
    setClipperStatus(message, "error");
    updateClipperUI();
  }
}

async function submitClipperForm(event) {
  if (event) {
    event.preventDefault();
  }
  if (!state.current || !Number.isFinite(clipperState.durationSeconds)) {
    setClipperStatus("No recording selected.", "error");
    updateClipperUI();
    return;
  }

  const duration = clipperState.durationSeconds;
  const clipLength = clipperState.endSeconds - clipperState.startSeconds;
  if (clipLength < MIN_CLIP_DURATION_SECONDS || clipLength > duration) {
    setClipperStatus("Select a valid range before saving.", "error");
    updateClipperUI();
    return;
  }

  const record = state.current;
  const defaultName = computeClipDefaultName(
    record,
    clipperState.startSeconds,
    clipperState.endSeconds,
    clipperState.overwriteExisting,
  );
  let clipName = defaultName;
  if (dom.clipperNameInput) {
    const trimmed = dom.clipperNameInput.value.trim();
    if (trimmed) {
      const sanitized = sanitizeClipName(trimmed);
      if (!sanitized) {
        setClipperStatus("Clip name must use letters, numbers, dots, hyphens, or underscores.", "error");
        return;
      }
      dom.clipperNameInput.value = sanitized;
      clipName = sanitized;
    } else {
      dom.clipperNameInput.value = defaultName;
    }
  }

  if (!clipperState.overwriteExisting) {
    const ensured = ensureUniqueClipName(clipName, record);
    if (ensured !== clipName && dom.clipperNameInput) {
      dom.clipperNameInput.value = ensured;
    }
    clipName = ensured;
  }

  clipperState.nameDirty = clipName !== defaultName;

  const payload = {
    source_path: record.path,
    start_seconds: clipperState.startSeconds,
    end_seconds: clipperState.endSeconds,
    clip_name: clipName,
  };

  if (clipperState.overwriteExisting && record && typeof record.path === "string") {
    const extension =
      record && typeof record.extension === "string" ? record.extension.toLowerCase() : "";
    const renameTolerance = Math.max(0.05, duration * 0.01);
    const startNearZero =
      Number.isFinite(clipperState.startSeconds) &&
      Math.abs(clipperState.startSeconds) <= renameTolerance;
    const endNearDuration =
      Number.isFinite(clipperState.endSeconds) &&
      Math.abs(clipperState.endSeconds - duration) <= renameTolerance;
    const currentName =
      record && typeof record.name === "string" ? sanitizeClipName(record.name) : "";
    if (
      extension === "opus" &&
      startNearZero &&
      endNearDuration &&
      typeof clipName === "string" &&
      clipName &&
      clipName !== currentName
    ) {
      payload.overwrite_existing = record.path;
    }
  }

  if (!clipperState.overwriteExisting) {
    payload.allow_overwrite = false;
  }

  const startEpoch = getRecordStartSeconds(record);
  if (startEpoch !== null) {
    payload.source_start_epoch = startEpoch;
  }

  setClipperStatus("Saving clip…", "pending");
  clipperState.busy = true;
  updateClipperUI();

  try {
    const response = await fetch(apiPath("/api/recordings/clip"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let message = `Unable to save clip (status ${response.status})`;
      try {
        const errorBody = await response.json();
        if (errorBody && typeof errorBody === "object") {
          if (typeof errorBody.reason === "string" && errorBody.reason) {
            message = errorBody.reason;
          } else if (typeof errorBody.error === "string" && errorBody.error) {
            message = errorBody.error;
          }
        }
      } catch (jsonError) {
        try {
          const text = await response.text();
          if (text && text.trim()) {
            message = text.trim();
          }
        } catch (textError) {
          /* ignore text parse errors */
        }
      }
      throw new Error(message);
    }

    let responsePayload = null;
    try {
      responsePayload = await response.json();
    } catch (parseError) {
      responsePayload = null;
    }
    if (responsePayload && typeof responsePayload.path === "string") {
      pendingSelectionPath = responsePayload.path;
      if (clipperState.undoTokens instanceof Map) {
        const undoToken =
          typeof responsePayload.undo_token === "string" && responsePayload.undo_token.trim()
            ? responsePayload.undo_token.trim()
            : null;
        if (undoToken) {
          clipperState.undoTokens.set(responsePayload.path, undoToken);
        } else {
          clipperState.undoTokens.delete(responsePayload.path);
        }
      }
    }

    clipperState.busy = false;
    setClipperStatus("Clip saved.", "success");
    updateClipperUI();
    await fetchRecordings({ silent: false });
  } catch (error) {
    console.error("Clip creation failed", error);
    clipperState.busy = false;
    const message = error instanceof Error && error.message ? error.message : "Unable to save clip.";
    setClipperStatus(message, "error");
    updateClipperUI();
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
    if (clipperState.undoTokens instanceof Map) {
      const knownPaths = new Set(normalizedRecords.map((record) => record.path));
      for (const [path] of clipperState.undoTokens) {
        if (!knownPaths.has(path)) {
          clipperState.undoTokens.delete(path);
        }
      }
    }
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
        clipperState.durationSeconds = toFiniteOrNull(current.duration_seconds);
        updateClipperUI();
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
    updateRmsIndicator(payload.capture_status);
    updateRecordingMeta(payload.capture_status);
    updateEncodingStatus(payload.capture_status);
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
    hideRmsIndicator();
    if (dom.lastUpdated) {
      dom.lastUpdated.textContent = "Offline";
    }
    fetchQueued = false;
  } finally {
    hideRefreshIndicator();
    fetchInFlight = false;
    if (fetchQueued) {
      fetchQueued = false;
      fetchRecordings({ silent: true });
    }
  }
}

function parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return ["1", "true", "yes", "on"].includes(normalized);
  }
  return Boolean(value);
}

function parseListInput(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
}

const AUDIO_SAMPLE_RATES = [48000, 32000, 16000];
const AUDIO_FRAME_LENGTHS = [10, 20, 30];
const STREAMING_MODES = new Set(["hls", "webrtc"]);
const TRANSCRIPTION_ENGINES = new Set(["vosk"]);

const AUDIO_FILTER_LIMITS = {
  highpass: { field: "cutoff_hz", min: 20, max: 2000 },
  lowpass: { field: "cutoff_hz", min: 2000, max: 20000 },
  noise_gate: { field: "threshold_db", min: -90, max: 0 },
};

const AUDIO_FILTER_DEFAULTS = {
  highpass: { enabled: false, cutoff_hz: 90 },
  lowpass: { enabled: false, cutoff_hz: 12000 },
  noise_gate: { enabled: false, threshold_db: -45 },
};

const AUDIO_CALIBRATION_DEFAULTS = {
  auto_noise_profile: false,
  auto_gain: false,
};

function audioDefaults() {
  return {
    device: "",
    sample_rate: 48000,
    frame_ms: 20,
    gain: 2.5,
    vad_aggressiveness: 3,
    filter_chain: {
      highpass: { ...AUDIO_FILTER_DEFAULTS.highpass },
      lowpass: { ...AUDIO_FILTER_DEFAULTS.lowpass },
      noise_gate: { ...AUDIO_FILTER_DEFAULTS.noise_gate },
    },
    calibration: { ...AUDIO_CALIBRATION_DEFAULTS },
  };
}

function canonicalAudioSettings(settings) {
  const defaults = audioDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  if (typeof source.device === "string") {
    defaults.device = source.device.trim();
  }

  const sampleRate = Number(source.sample_rate);
  if (Number.isFinite(sampleRate)) {
    const rounded = Math.round(sampleRate);
    defaults.sample_rate = AUDIO_SAMPLE_RATES.includes(rounded)
      ? rounded
      : defaults.sample_rate;
  }

  const frameMs = Number(source.frame_ms);
  if (Number.isFinite(frameMs)) {
    const rounded = Math.round(frameMs);
    defaults.frame_ms = AUDIO_FRAME_LENGTHS.includes(rounded)
      ? rounded
      : defaults.frame_ms;
  }

  const gain = Number(source.gain);
  if (Number.isFinite(gain)) {
    defaults.gain = Math.max(0.1, Math.min(16, gain));
  }

  const vad = Number(source.vad_aggressiveness);
  if (Number.isFinite(vad)) {
    const rounded = Math.round(vad);
    defaults.vad_aggressiveness = Math.max(0, Math.min(3, rounded));
  }

  const filterSource =
    settings && typeof settings === "object" && settings.filter_chain && typeof settings.filter_chain === "object"
      ? settings.filter_chain
      : null;
  if (filterSource) {
    const target = defaults.filter_chain;
    for (const [stage, spec] of Object.entries(AUDIO_FILTER_LIMITS)) {
      const stageTarget = target[stage];
      const stagePayload = filterSource[stage];
      if (!stageTarget || typeof stageTarget !== "object") {
        continue;
      }
      if (!stagePayload || typeof stagePayload !== "object") {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(stagePayload, "enabled")) {
        stageTarget.enabled = parseBoolean(stagePayload.enabled);
      }
      const rawValue = Number(stagePayload[spec.field]);
      if (Number.isFinite(rawValue)) {
        const clamped = Math.min(spec.max, Math.max(spec.min, rawValue));
        stageTarget[spec.field] = clamped;
      }
    }
  }

  const calibrationSource =
    settings && typeof settings === "object" && settings.calibration && typeof settings.calibration === "object"
      ? settings.calibration
      : null;
  if (calibrationSource) {
    const calibrationTarget = defaults.calibration;
    if (Object.prototype.hasOwnProperty.call(calibrationSource, "auto_noise_profile")) {
      calibrationTarget.auto_noise_profile = parseBoolean(calibrationSource.auto_noise_profile);
    }
    if (Object.prototype.hasOwnProperty.call(calibrationSource, "auto_gain")) {
      calibrationTarget.auto_gain = parseBoolean(calibrationSource.auto_gain);
    }
  }

  return defaults;
}

function canonicalAudioFromConfig(config) {
  const section = config && typeof config === "object" ? config.audio : null;
  return canonicalAudioSettings(section);
}

function formatHzDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const rounded = Math.round(numeric);
  return `${rounded.toLocaleString()} Hz`;
}

function formatDbDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const rounded = Math.round(numeric * 10) / 10;
  const absValue = Math.abs(rounded);
  const decimals = Math.abs(Math.round(absValue) - absValue) > 1e-6 ? 1 : 0;
  const formatted = absValue.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const prefix = rounded < 0 ? "\u2212" : "";
  return `${prefix}${formatted} dB`;
}

function updateAudioFilterControls() {
  const section = recorderDom.sections ? recorderDom.sections.audio : null;
  if (!section) {
    return;
  }

  const stages = [
    {
      toggle: section.filterHighpassEnabled,
      slider: section.filterHighpassCutoff,
      display: section.filterHighpassDisplay,
      formatter: formatHzDisplay,
    },
    {
      toggle: section.filterLowpassEnabled,
      slider: section.filterLowpassCutoff,
      display: section.filterLowpassDisplay,
      formatter: formatHzDisplay,
    },
    {
      toggle: section.filterNoiseGateEnabled,
      slider: section.filterNoiseGateThreshold,
      display: section.filterNoiseGateDisplay,
      formatter: formatDbDisplay,
    },
  ];

  for (const stage of stages) {
    const { toggle, slider, display, formatter } = stage;
    if (!(slider instanceof HTMLInputElement)) {
      continue;
    }
    if (toggle instanceof HTMLInputElement) {
      slider.disabled = !toggle.checked;
    }
    if (display instanceof HTMLElement) {
      display.textContent = formatter(slider.value);
    }
  }

  if (section.calibrateNoiseButton instanceof HTMLButtonElement) {
    const enabled = section.calibrationNoise instanceof HTMLInputElement ? section.calibrationNoise.checked : true;
    section.calibrateNoiseButton.disabled = !enabled;
  }
}

function segmenterDefaults() {
  return {
    pre_pad_ms: 2000,
    post_pad_ms: 3000,
    rms_threshold: 300,
    keep_window_frames: 30,
    start_consecutive: 25,
    keep_consecutive: 25,
    flush_threshold_bytes: 128 * 1024,
    max_queue_frames: 512,
    use_rnnoise: false,
    use_noisereduce: false,
    denoise_before_vad: false,
  };
}

function canonicalSegmenterSettings(settings) {
  const defaults = segmenterDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  function toInt(value, fallback, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    let candidate = Math.round(number);
    if (typeof min === "number") {
      candidate = Math.max(min, candidate);
    }
    if (typeof max === "number") {
      candidate = Math.min(max, candidate);
    }
    return candidate;
  }

  defaults.pre_pad_ms = toInt(source.pre_pad_ms, defaults.pre_pad_ms, { min: 0, max: 60000 });
  defaults.post_pad_ms = toInt(source.post_pad_ms, defaults.post_pad_ms, { min: 0, max: 120000 });
  defaults.rms_threshold = toInt(source.rms_threshold, defaults.rms_threshold, { min: 0, max: 10000 });
  defaults.keep_window_frames = toInt(
    source.keep_window_frames,
    defaults.keep_window_frames,
    { min: 1, max: 2000 }
  );
  defaults.start_consecutive = toInt(
    source.start_consecutive,
    defaults.start_consecutive,
    { min: 1, max: 2000 }
  );
  defaults.keep_consecutive = toInt(
    source.keep_consecutive,
    defaults.keep_consecutive,
    { min: 1, max: 2000 }
  );
  defaults.flush_threshold_bytes = toInt(
    source.flush_threshold_bytes,
    defaults.flush_threshold_bytes,
    { min: 4096, max: 4 * 1024 * 1024 }
  );
  defaults.max_queue_frames = toInt(
    source.max_queue_frames,
    defaults.max_queue_frames,
    { min: 16, max: 4096 }
  );

  defaults.use_rnnoise = parseBoolean(source.use_rnnoise);
  defaults.use_noisereduce = parseBoolean(source.use_noisereduce);
  defaults.denoise_before_vad = parseBoolean(source.denoise_before_vad);

  return defaults;
}

function canonicalSegmenterFromConfig(config) {
  const section = config && typeof config === "object" ? config.segmenter : null;
  return canonicalSegmenterSettings(section);
}

function adaptiveDefaults() {
  return {
    enabled: false,
    min_thresh: 0.01,
    margin: 1.2,
    update_interval_sec: 5.0,
    window_sec: 10.0,
    hysteresis_tolerance: 0.1,
    release_percentile: 0.5,
  };
}

function canonicalAdaptiveSettings(settings) {
  const defaults = adaptiveDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  function clampFloat(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  defaults.min_thresh = clampFloat(source.min_thresh, defaults.min_thresh, 0, 1);
  defaults.margin = clampFloat(source.margin, defaults.margin, 0.5, 10);
  defaults.update_interval_sec = clampFloat(
    source.update_interval_sec,
    defaults.update_interval_sec,
    0.5,
    120
  );
  defaults.window_sec = clampFloat(source.window_sec, defaults.window_sec, 1, 300);
  defaults.hysteresis_tolerance = clampFloat(
    source.hysteresis_tolerance,
    defaults.hysteresis_tolerance,
    0,
    1
  );
  defaults.release_percentile = clampFloat(
    source.release_percentile,
    defaults.release_percentile,
    0.05,
    1
  );

  return defaults;
}

function canonicalAdaptiveFromConfig(config) {
  const section = config && typeof config === "object" ? config.adaptive_rms : null;
  return canonicalAdaptiveSettings(section);
}

function ingestDefaults() {
  return {
    stable_checks: 2,
    stable_interval_sec: 1.0,
    allowed_ext: [".wav", ".opus", ".flac", ".mp3"],
    ignore_suffixes: [".part", ".partial", ".tmp", ".incomplete", ".opdownload", ".crdownload"],
  };
}

function normalizeExtensionList(values, fallback) {
  const base = Array.isArray(fallback) ? fallback.slice() : [];
  if (!values) {
    return base;
  }
  const items = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    let candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!candidate.startsWith(".")) {
      candidate = `.${candidate}`;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      items.push(candidate);
    }
  }
  return items.length > 0 ? items : base;
}

function normalizeSuffixList(values, fallback) {
  const base = Array.isArray(fallback) ? fallback.slice() : [];
  if (!values) {
    return base;
  }
  const items = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    const candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      items.push(candidate);
    }
  }
  return items.length > 0 ? items : base;
}

function canonicalIngestSettings(settings) {
  const defaults = ingestDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  const stableChecks = Number(source.stable_checks);
  if (Number.isFinite(stableChecks)) {
    defaults.stable_checks = Math.max(1, Math.min(20, Math.round(stableChecks)));
  }

  const stableInterval = Number(source.stable_interval_sec);
  if (Number.isFinite(stableInterval)) {
    defaults.stable_interval_sec = Math.max(0.1, Math.min(30, stableInterval));
  }

  defaults.allowed_ext = normalizeExtensionList(source.allowed_ext, defaults.allowed_ext);
  defaults.ignore_suffixes = normalizeSuffixList(
    source.ignore_suffixes,
    defaults.ignore_suffixes
  );

  return defaults;
}

function canonicalIngestFromConfig(config) {
  const section = config && typeof config === "object" ? config.ingest : null;
  return canonicalIngestSettings(section);
}

function loggingDefaults() {
  return { dev_mode: false };
}

function canonicalLoggingSettings(settings) {
  const defaults = loggingDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  defaults.dev_mode = parseBoolean(source.dev_mode);
  return defaults;
}

function canonicalLoggingFromConfig(config) {
  const section = config && typeof config === "object" ? config.logging : null;
  return canonicalLoggingSettings(section);
}

function streamingDefaults() {
  return { mode: "hls", webrtc_history_seconds: 8.0 };
}

function canonicalStreamingSettings(settings) {
  const defaults = streamingDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  if (typeof source.mode === "string") {
    const candidate = source.mode.trim().toLowerCase();
    if (STREAMING_MODES.has(candidate)) {
      defaults.mode = candidate;
    }
  }

  const history = Number(source.webrtc_history_seconds);
  if (Number.isFinite(history)) {
    defaults.webrtc_history_seconds = Math.max(1, Math.min(600, history));
  }

  return defaults;
}

function canonicalStreamingFromConfig(config) {
  const section = config && typeof config === "object" ? config.streaming : null;
  return canonicalStreamingSettings(section);
}

function dashboardDefaults() {
  return { api_base: "" };
}

function canonicalDashboardSettings(settings) {
  const defaults = dashboardDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  if (typeof source.api_base === "string") {
    defaults.api_base = source.api_base.trim();
  }
  return defaults;
}

function canonicalDashboardFromConfig(config) {
  const section = config && typeof config === "object" ? config.dashboard : null;
  return canonicalDashboardSettings(section);
}


function transcriptionDefaults() {
  return {
    enabled: false,
    engine: "vosk",
    types: ["Human"],
    vosk_model_path: "/apps/tricorder/models/vosk-small-en-us-0.15",
    target_sample_rate: 16000,
    include_words: true,
    max_alternatives: 0,
  };
}

function canonicalTranscriptionSettings(settings) {
  const defaults = transcriptionDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  if (typeof source.engine === "string") {
    const candidate = source.engine.trim().toLowerCase();
    if (TRANSCRIPTION_ENGINES.has(candidate)) {
      defaults.engine = candidate;
    }
  }

  let rawTypes = [];
  if (Array.isArray(source.types)) {
    rawTypes = source.types;
  } else if (typeof source.types === "string") {
    rawTypes = parseListInput(source.types);
  }
  const normalizedTypes = [];
  for (const entry of rawTypes) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (!normalizedTypes.includes(trimmed)) {
      normalizedTypes.push(trimmed);
    }
  }
  if (normalizedTypes.length > 0) {
    defaults.types = normalizedTypes;
  }

  if (typeof source.vosk_model_path === "string") {
    const trimmed = source.vosk_model_path.trim();
    if (trimmed) {
      defaults.vosk_model_path = trimmed;
    }
  } else if (typeof source.model_path === "string") {
    const trimmed = source.model_path.trim();
    if (trimmed) {
      defaults.vosk_model_path = trimmed;
    }
  }

  const rate = Number(
    source.target_sample_rate !== undefined ? source.target_sample_rate : source.vosk_sample_rate
  );
  if (Number.isFinite(rate)) {
    const clamped = Math.max(8000, Math.min(96000, Math.round(rate)));
    defaults.target_sample_rate = clamped;
  }

  if (source.include_words !== undefined) {
    defaults.include_words = parseBoolean(source.include_words);
  }

  const alternatives = Number(source.max_alternatives);
  if (Number.isFinite(alternatives)) {
    defaults.max_alternatives = Math.max(0, Math.min(10, Math.round(alternatives)));
  }

  return defaults;
}

function canonicalTranscriptionFromConfig(config) {
  const section = config && typeof config === "object" ? config.transcription : null;
  return canonicalTranscriptionSettings(section);
}

function getRecorderSection(key) {
  const section = recorderState.sections.get(key);
  if (!section) {
    throw new Error(`Unknown recorder section: ${key}`);
  }
  return section;
}

function setRecorderStatus(key, text, state, options = {}) {
  const section = getRecorderSection(key);
  const statusElement = section.options.status;
  if (!statusElement) {
    return;
  }
  if (section.state.statusTimeoutId) {
    window.clearTimeout(section.state.statusTimeoutId);
    section.state.statusTimeoutId = null;
  }

  const message = typeof text === "string" ? text : "";
  statusElement.textContent = message;
  if (state) {
    statusElement.dataset.state = state;
  } else if (statusElement.dataset.state) {
    delete statusElement.dataset.state;
  }
  statusElement.setAttribute("aria-hidden", message ? "false" : "true");

  if (message && options.autoHide) {
    const duration = typeof options.duration === "number" ? options.duration : 3200;
    section.state.statusTimeoutId = window.setTimeout(() => {
      section.state.statusTimeoutId = null;
      statusElement.textContent = "";
      if (statusElement.dataset.state) {
        delete statusElement.dataset.state;
      }
      statusElement.setAttribute("aria-hidden", "true");
    }, Math.max(1000, duration));
  }
}

function updateRecorderButtons(key) {
  const section = getRecorderSection(key);
  const { saveButton, resetButton, form } = section.options;
  if (saveButton) {
    saveButton.disabled = section.state.saving || !section.state.dirty;
  }
  if (resetButton) {
    const disableReset =
      section.state.saving ||
      (!section.state.dirty && !section.state.pendingSnapshot && !section.state.hasExternalUpdate);
    resetButton.disabled = disableReset;
  }
  if (form) {
    form.setAttribute("aria-busy", section.state.saving ? "true" : "false");
  }
}

function applyRecorderSectionData(key, data, { markPristine = false } = {}) {
  const section = getRecorderSection(key);
  if (typeof section.options.apply === "function") {
    section.options.apply(data);
  }
  section.state.current = data;
  if (markPristine) {
    section.state.lastAppliedFingerprint = JSON.stringify(data);
    section.state.dirty = false;
    section.state.pendingSnapshot = null;
    section.state.hasExternalUpdate = false;
  }
  updateRecorderButtons(key);
}

function markRecorderSectionDirty(key) {
  const section = getRecorderSection(key);
  if (section.state.saving) {
    return;
  }
  if (typeof section.options.read !== "function") {
    return;
  }
  const snapshot = section.options.read();
  const fingerprint = JSON.stringify(snapshot);
  const changed = fingerprint !== section.state.lastAppliedFingerprint;
  section.state.dirty = changed;
  if (changed) {
    setRecorderStatus(key, "Unsaved changes", "info");
  } else if (!section.state.hasExternalUpdate) {
    setRecorderStatus(key, "", null);
  }
  updateRecorderButtons(key);
}

function resetRecorderSection(key) {
  const section = getRecorderSection(key);
  if (section.state.saving) {
    return;
  }
  if (section.state.pendingSnapshot) {
    applyRecorderSectionData(key, section.state.pendingSnapshot, { markPristine: true });
    setRecorderStatus(key, "Loaded updated settings from disk.", "info", { autoHide: true, duration: 2500 });
    section.state.pendingSnapshot = null;
    section.state.hasExternalUpdate = false;
    return;
  }
  if (section.state.current) {
    applyRecorderSectionData(key, section.state.current, { markPristine: true });
    setRecorderStatus(key, "Reverted unsaved changes.", "info", { autoHide: true, duration: 2200 });
  }
}

function summariseRestartResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { message: "Saved changes.", state: "success" };
  }
  const summary = [];
  let hasFailure = false;
  for (const entry of results) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const unit = typeof entry.unit === "string" && entry.unit ? entry.unit : "service";
    const ok = entry.ok !== false;
    hasFailure = hasFailure || !ok;
    summary.push(`${unit}${ok ? "" : " (failed)"}`);
  }
  const joined = summary.length > 0 ? summary.join(", ") : "services";
  return {
    message: `Saved changes. Restarted ${joined}.`,
    state: hasFailure ? "warning" : "success",
  };
}

async function saveRecorderSection(key) {
  const section = getRecorderSection(key);
  if (section.state.saving || !section.state.dirty) {
    return;
  }
  if (typeof section.options.read !== "function" || !section.options.endpoint) {
    return;
  }

  const payload = section.options.read();
  section.state.saving = true;
  updateRecorderButtons(key);
  setRecorderStatus(key, "Saving…", "pending");

  try {
    const response = await fetch(apiPath(section.options.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }

    if (!response.ok) {
      const message = body && typeof body.error === "string"
        ? body.error
        : `Request failed with ${response.status}`;
      throw new Error(message);
    }

    const canonical = typeof section.options.fromResponse === "function"
      ? section.options.fromResponse(body)
      : section.options.defaults();
    applyRecorderSectionData(key, canonical, { markPristine: true });
    section.state.loaded = true;

    if (body && typeof body.config_path === "string") {
      updateRecorderConfigPath(body.config_path);
    }

    const { message, state } = summariseRestartResults(body ? body.restart_results : null);
    setRecorderStatus(key, message, state, { autoHide: true, duration: 3600 });
    fetchConfig({ silent: true });
    fetchServices({ silent: true });
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to save settings.";
    setRecorderStatus(key, message, "error");
  } finally {
    section.state.saving = false;
    updateRecorderButtons(key);
  }
}

async function fetchRecorderSection(key) {
  const section = getRecorderSection(key);
  if (!section.options.endpoint) {
    return;
  }
  try {
    const response = await fetch(apiPath(section.options.endpoint), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    const payload = await response.json();
    const canonical = typeof section.options.fromResponse === "function"
      ? section.options.fromResponse(payload)
      : section.options.defaults();
    applyRecorderSectionData(key, canonical, { markPristine: true });
    section.state.loaded = true;
    if (payload && typeof payload.config_path === "string") {
      updateRecorderConfigPath(payload.config_path);
    }
    setRecorderStatus(key, "", null);
  } catch (error) {
    console.error(`Failed to fetch ${key} settings`, error);
    setRecorderStatus(key, "Unable to load settings.", "error");
  }
}

function syncRecorderSectionsFromConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }
  recorderState.latestConfig = config;
  for (const [key, section] of recorderState.sections.entries()) {
    if (typeof section.options.fromConfig !== "function") {
      continue;
    }
    const canonical = section.options.fromConfig(config);
    handleRecorderConfigSnapshot(key, canonical);
  }
  if (!recorderState.loaded) {
    recorderState.loaded = true;
  }
}

function handleRecorderConfigSnapshot(key, canonical) {
  const section = getRecorderSection(key);
  const fingerprint = JSON.stringify(canonical);
  section.state.current = canonical;

  if (!section.state.loaded && !section.state.saving) {
    applyRecorderSectionData(key, canonical, { markPristine: true });
    section.state.loaded = true;
    return;
  }

  if (fingerprint === section.state.lastAppliedFingerprint) {
    if (!section.state.dirty && !section.state.saving) {
      applyRecorderSectionData(key, canonical, { markPristine: true });
    }
    return;
  }

  if (!section.state.dirty && !section.state.saving) {
    applyRecorderSectionData(key, canonical, { markPristine: true });
    return;
  }

  section.state.pendingSnapshot = canonical;
  section.state.hasExternalUpdate = true;
  setRecorderStatus(key, "Updated on disk. Reset to load changes.", "info");
  updateRecorderButtons(key);
}

function updateRecorderConfigPath(path) {
  if (typeof path !== "string") {
    return;
  }
  recorderState.configPath = path;
  if (recorderDom.configPath) {
    recorderDom.configPath.textContent = path || "(unknown)";
  }
  if (dom.configPathLabel) {
    dom.configPathLabel.textContent = path || "(unknown)";
  }
}

function ensureRecorderSectionsLoaded() {
  if (recorderState.loadingPromise) {
    return recorderState.loadingPromise;
  }
  const keys = Array.from(recorderState.sections.keys());
  if (keys.length === 0) {
    recorderState.loaded = true;
    return Promise.resolve();
  }

  for (const key of keys) {
    setRecorderStatus(key, "Loading settings…", "pending");
  }

  const promise = Promise.all(keys.map((key) => fetchRecorderSection(key)))
    .catch((error) => {
      console.error("Failed to load recorder settings", error);
    })
    .finally(() => {
      recorderState.loadingPromise = null;
      recorderState.loaded = true;
    });

  recorderState.loadingPromise = promise;
  return promise;
}

function registerRecorderSection(options) {
  const {
    key,
    endpoint,
    defaults = () => ({}),
    fromConfig,
    fromResponse,
    read,
    apply,
    form,
    saveButton,
    resetButton,
    status,
  } = options;

  if (!key) {
    return;
  }

  const section = {
    options: {
      key,
      endpoint,
      defaults,
      fromConfig,
      fromResponse,
      read,
      apply,
      form,
      saveButton,
      resetButton,
      status,
    },
    state: {
      key,
      current: defaults(),
      lastAppliedFingerprint: "",
      dirty: false,
      saving: false,
      loaded: false,
      pendingSnapshot: null,
      hasExternalUpdate: false,
      statusTimeoutId: null,
    },
  };

  recorderState.sections.set(key, section);

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveRecorderSection(key);
    });
    form.addEventListener("input", () => {
      markRecorderSectionDirty(key);
    });
    form.addEventListener("change", () => {
      markRecorderSectionDirty(key);
    });
    form.setAttribute("novalidate", "novalidate");
  }

  if (resetButton) {
    resetButton.addEventListener("click", () => {
      resetRecorderSection(key);
    });
  }

  updateRecorderButtons(key);
}

function registerRecorderSections() {
  if (!recorderDom.sections) {
    return;
  }

  const definitions = [
    {
      key: "audio",
      dom: recorderDom.sections.audio,
      endpoint: "/api/config/audio",
      defaults: audioDefaults,
      fromConfig: canonicalAudioFromConfig,
      fromResponse: (payload) => canonicalAudioSettings(payload ? payload.audio : null),
      read: readAudioForm,
      apply: applyAudioForm,
    },
    {
      key: "segmenter",
      dom: recorderDom.sections.segmenter,
      endpoint: "/api/config/segmenter",
      defaults: segmenterDefaults,
      fromConfig: canonicalSegmenterFromConfig,
      fromResponse: (payload) => canonicalSegmenterSettings(payload ? payload.segmenter : null),
      read: readSegmenterForm,
      apply: applySegmenterForm,
    },
    {
      key: "adaptive_rms",
      dom: recorderDom.sections.adaptive_rms,
      endpoint: "/api/config/adaptive-rms",
      defaults: adaptiveDefaults,
      fromConfig: canonicalAdaptiveFromConfig,
      fromResponse: (payload) => canonicalAdaptiveSettings(payload ? payload.adaptive_rms : null),
      read: readAdaptiveForm,
      apply: applyAdaptiveForm,
    },
    {
      key: "ingest",
      dom: recorderDom.sections.ingest,
      endpoint: "/api/config/ingest",
      defaults: ingestDefaults,
      fromConfig: canonicalIngestFromConfig,
      fromResponse: (payload) => canonicalIngestSettings(payload ? payload.ingest : null),
      read: readIngestForm,
      apply: applyIngestForm,
    },
    {
      key: "transcription",
      dom: recorderDom.sections.transcription,
      endpoint: "/api/config/transcription",
      defaults: transcriptionDefaults,
      fromConfig: canonicalTranscriptionFromConfig,
      fromResponse: (payload) =>
        canonicalTranscriptionSettings(payload ? payload.transcription : null),
      read: readTranscriptionForm,
      apply: applyTranscriptionForm,
    },
    {
      key: "logging",
      dom: recorderDom.sections.logging,
      endpoint: "/api/config/logging",
      defaults: loggingDefaults,
      fromConfig: canonicalLoggingFromConfig,
      fromResponse: (payload) => canonicalLoggingSettings(payload ? payload.logging : null),
      read: readLoggingForm,
      apply: applyLoggingForm,
    },
    {
      key: "streaming",
      dom: recorderDom.sections.streaming,
      endpoint: "/api/config/streaming",
      defaults: streamingDefaults,
      fromConfig: canonicalStreamingFromConfig,
      fromResponse: (payload) => canonicalStreamingSettings(payload ? payload.streaming : null),
      read: readStreamingForm,
      apply: applyStreamingForm,
    },
    {
      key: "dashboard",
      dom: recorderDom.sections.dashboard,
      endpoint: "/api/config/dashboard",
      defaults: dashboardDefaults,
      fromConfig: canonicalDashboardFromConfig,
      fromResponse: (payload) => canonicalDashboardSettings(payload ? payload.dashboard : null),
      read: readDashboardForm,
      apply: applyDashboardForm,
    },
  ];

  for (const definition of definitions) {
    const domRefs = definition.dom;
    if (!domRefs || !domRefs.form) {
      continue;
    }
    registerRecorderSection({
      key: definition.key,
      endpoint: definition.endpoint,
      defaults: definition.defaults,
      fromConfig: definition.fromConfig,
      fromResponse: definition.fromResponse,
      read: definition.read,
      apply: definition.apply,
      form: domRefs.form,
      saveButton: domRefs.save,
      resetButton: domRefs.reset,
      status: domRefs.status,
    });
  }

  if (!recorderDialogState.activeSection) {
    const first = firstRecorderSectionKey();
    if (first) {
      setActiveRecorderSection(first);
    }
  } else {
    setActiveRecorderSection(recorderDialogState.activeSection);
  }
}

function applyAudioForm(data) {
  const section = recorderDom.sections.audio;
  if (!section) {
    return;
  }
  if (section.device) {
    section.device.value = data.device ?? "";
  }
  if (section.sampleRate) {
    section.sampleRate.value = String(data.sample_rate);
  }
  if (section.frameMs) {
    section.frameMs.value = String(data.frame_ms);
  }
  if (section.gain) {
    section.gain.value = String(data.gain);
  }
  if (section.vad) {
    section.vad.value = String(data.vad_aggressiveness);
  }
  const filters = data && typeof data === "object" && data.filter_chain ? data.filter_chain : {};
  if (section.filterHighpassEnabled) {
    section.filterHighpassEnabled.checked = Boolean(filters.highpass && filters.highpass.enabled);
  }
  if (section.filterHighpassCutoff && filters.highpass && typeof filters.highpass.cutoff_hz === "number") {
    section.filterHighpassCutoff.value = String(filters.highpass.cutoff_hz);
  }
  if (section.filterLowpassEnabled) {
    section.filterLowpassEnabled.checked = Boolean(filters.lowpass && filters.lowpass.enabled);
  }
  if (section.filterLowpassCutoff && filters.lowpass && typeof filters.lowpass.cutoff_hz === "number") {
    section.filterLowpassCutoff.value = String(filters.lowpass.cutoff_hz);
  }
  if (section.filterNoiseGateEnabled) {
    section.filterNoiseGateEnabled.checked = Boolean(
      filters.noise_gate && filters.noise_gate.enabled
    );
  }
  if (
    section.filterNoiseGateThreshold &&
    filters.noise_gate &&
    typeof filters.noise_gate.threshold_db === "number"
  ) {
    section.filterNoiseGateThreshold.value = String(filters.noise_gate.threshold_db);
  }
  const calibration = data && typeof data === "object" && data.calibration ? data.calibration : {};
  if (section.calibrationNoise) {
    section.calibrationNoise.checked = Boolean(calibration.auto_noise_profile);
  }
  if (section.calibrationGain) {
    section.calibrationGain.checked = Boolean(calibration.auto_gain);
  }
  updateAudioFilterControls();
}

function readAudioForm() {
  const section = recorderDom.sections.audio;
  if (!section) {
    return audioDefaults();
  }
  const payload = {
    device: section.device ? section.device.value : "",
    sample_rate: section.sampleRate ? Number(section.sampleRate.value) : undefined,
    frame_ms: section.frameMs ? Number(section.frameMs.value) : undefined,
    gain: section.gain ? Number(section.gain.value) : undefined,
    vad_aggressiveness: section.vad ? Number(section.vad.value) : undefined,
    filter_chain: {
      highpass: {
        enabled: section.filterHighpassEnabled ? section.filterHighpassEnabled.checked : false,
        cutoff_hz: section.filterHighpassCutoff ? Number(section.filterHighpassCutoff.value) : undefined,
      },
      lowpass: {
        enabled: section.filterLowpassEnabled ? section.filterLowpassEnabled.checked : false,
        cutoff_hz: section.filterLowpassCutoff ? Number(section.filterLowpassCutoff.value) : undefined,
      },
      noise_gate: {
        enabled: section.filterNoiseGateEnabled ? section.filterNoiseGateEnabled.checked : false,
        threshold_db: section.filterNoiseGateThreshold
          ? Number(section.filterNoiseGateThreshold.value)
          : undefined,
      },
    },
    calibration: {
      auto_noise_profile: section.calibrationNoise ? section.calibrationNoise.checked : false,
      auto_gain: section.calibrationGain ? section.calibrationGain.checked : false,
    },
  };
  return canonicalAudioSettings(payload);
}

function applySegmenterForm(data) {
  const section = recorderDom.sections.segmenter;
  if (!section) {
    return;
  }
  const mapping = [
    [section.prePad, data.pre_pad_ms],
    [section.postPad, data.post_pad_ms],
    [section.threshold, data.rms_threshold],
    [section.keepWindow, data.keep_window_frames],
    [section.startConsecutive, data.start_consecutive],
    [section.keepConsecutive, data.keep_consecutive],
    [section.flushBytes, data.flush_threshold_bytes],
    [section.maxQueue, data.max_queue_frames],
  ];
  for (const [input, value] of mapping) {
    if (input) {
      input.value = String(value);
    }
  }
  if (section.useRnnoise) {
    section.useRnnoise.checked = data.use_rnnoise;
  }
  if (section.useNoisereduce) {
    section.useNoisereduce.checked = data.use_noisereduce;
  }
  if (section.denoiseBeforeVad) {
    section.denoiseBeforeVad.checked = data.denoise_before_vad;
  }
}

function readSegmenterForm() {
  const section = recorderDom.sections.segmenter;
  if (!section) {
    return segmenterDefaults();
  }
  const payload = {
    pre_pad_ms: section.prePad ? Number(section.prePad.value) : undefined,
    post_pad_ms: section.postPad ? Number(section.postPad.value) : undefined,
    rms_threshold: section.threshold ? Number(section.threshold.value) : undefined,
    keep_window_frames: section.keepWindow ? Number(section.keepWindow.value) : undefined,
    start_consecutive: section.startConsecutive ? Number(section.startConsecutive.value) : undefined,
    keep_consecutive: section.keepConsecutive ? Number(section.keepConsecutive.value) : undefined,
    flush_threshold_bytes: section.flushBytes ? Number(section.flushBytes.value) : undefined,
    max_queue_frames: section.maxQueue ? Number(section.maxQueue.value) : undefined,
    use_rnnoise: section.useRnnoise ? section.useRnnoise.checked : false,
    use_noisereduce: section.useNoisereduce ? section.useNoisereduce.checked : false,
    denoise_before_vad: section.denoiseBeforeVad ? section.denoiseBeforeVad.checked : false,
  };
  return canonicalSegmenterSettings(payload);
}

function applyAdaptiveForm(data) {
  const section = recorderDom.sections.adaptive_rms;
  if (!section) {
    return;
  }
  if (section.enabled) {
    section.enabled.checked = data.enabled;
  }
  if (section.minThresh) {
    section.minThresh.value = String(data.min_thresh);
  }
  if (section.margin) {
    section.margin.value = String(data.margin);
  }
  if (section.updateInterval) {
    section.updateInterval.value = String(data.update_interval_sec);
  }
  if (section.window) {
    section.window.value = String(data.window_sec);
  }
  if (section.hysteresis) {
    section.hysteresis.value = String(data.hysteresis_tolerance);
  }
  if (section.release) {
    section.release.value = String(data.release_percentile);
  }
}

function readAdaptiveForm() {
  const section = recorderDom.sections.adaptive_rms;
  if (!section) {
    return adaptiveDefaults();
  }
  const payload = {
    enabled: section.enabled ? section.enabled.checked : false,
    min_thresh: section.minThresh ? Number(section.minThresh.value) : undefined,
    margin: section.margin ? Number(section.margin.value) : undefined,
    update_interval_sec: section.updateInterval ? Number(section.updateInterval.value) : undefined,
    window_sec: section.window ? Number(section.window.value) : undefined,
    hysteresis_tolerance: section.hysteresis ? Number(section.hysteresis.value) : undefined,
    release_percentile: section.release ? Number(section.release.value) : undefined,
  };
  return canonicalAdaptiveSettings(payload);
}

function applyIngestForm(data) {
  const section = recorderDom.sections.ingest;
  if (!section) {
    return;
  }
  if (section.stableChecks) {
    section.stableChecks.value = String(data.stable_checks);
  }
  if (section.stableInterval) {
    section.stableInterval.value = String(data.stable_interval_sec);
  }
  if (section.allowedExt) {
    section.allowedExt.value = (Array.isArray(data.allowed_ext) ? data.allowed_ext : [])
      .join("\n");
  }
  if (section.ignoreSuffixes) {
    section.ignoreSuffixes.value = (Array.isArray(data.ignore_suffixes) ? data.ignore_suffixes : [])
      .join("\n");
  }
}

function readIngestForm() {
  const section = recorderDom.sections.ingest;
  if (!section) {
    return ingestDefaults();
  }
  const payload = {
    stable_checks: section.stableChecks ? Number(section.stableChecks.value) : undefined,
    stable_interval_sec: section.stableInterval ? Number(section.stableInterval.value) : undefined,
    allowed_ext: section.allowedExt ? section.allowedExt.value : undefined,
    ignore_suffixes: section.ignoreSuffixes ? section.ignoreSuffixes.value : undefined,
  };
  return canonicalIngestSettings(payload);
}

function applyTranscriptionForm(data) {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }
  if (section.enabled) {
    section.enabled.checked = Boolean(data.enabled);
  }
  if (section.engine) {
    section.engine.value = data.engine ?? "vosk";
  }
  if (section.types) {
    const entries = Array.isArray(data.types) ? data.types : [];
    section.types.value = entries.join("\n");
  }
  if (section.modelPath) {
    section.modelPath.value = data.vosk_model_path ?? "";
  }
  if (section.targetSampleRate) {
    section.targetSampleRate.value = String(data.target_sample_rate);
  }
  if (section.includeWords) {
    section.includeWords.checked = Boolean(data.include_words);
  }
  if (section.maxAlternatives) {
    section.maxAlternatives.value = String(data.max_alternatives);
  }
}

function readTranscriptionForm() {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return transcriptionDefaults();
  }
  const payload = {
    enabled: section.enabled ? section.enabled.checked : false,
    engine: section.engine ? section.engine.value : undefined,
    types: section.types ? section.types.value : undefined,
    vosk_model_path: section.modelPath ? section.modelPath.value : undefined,
    target_sample_rate: section.targetSampleRate
      ? Number(section.targetSampleRate.value)
      : undefined,
    include_words: section.includeWords ? section.includeWords.checked : false,
    max_alternatives: section.maxAlternatives
      ? Number(section.maxAlternatives.value)
      : undefined,
  };
  return canonicalTranscriptionSettings(payload);
}

function applyLoggingForm(data) {
  const section = recorderDom.sections.logging;
  if (!section) {
    return;
  }
  if (section.devMode) {
    section.devMode.checked = data.dev_mode;
  }
}

function readLoggingForm() {
  const section = recorderDom.sections.logging;
  if (!section) {
    return loggingDefaults();
  }
  const payload = {
    dev_mode: section.devMode ? section.devMode.checked : false,
  };
  return canonicalLoggingSettings(payload);
}

function applyStreamingForm(data) {
  const section = recorderDom.sections.streaming;
  if (!section) {
    return;
  }
  if (section.mode) {
    section.mode.value = data.mode;
  }
  if (section.history) {
    section.history.value = String(data.webrtc_history_seconds);
  }
}

function readStreamingForm() {
  const section = recorderDom.sections.streaming;
  if (!section) {
    return streamingDefaults();
  }
  const payload = {
    mode: section.mode ? section.mode.value : undefined,
    webrtc_history_seconds: section.history ? Number(section.history.value) : undefined,
  };
  return canonicalStreamingSettings(payload);
}

function applyDashboardForm(data) {
  const section = recorderDom.sections.dashboard;
  if (!section) {
    return;
  }
  if (section.apiBase) {
    section.apiBase.value = data.api_base ?? "";
  }
}

function readDashboardForm() {
  const section = recorderDom.sections.dashboard;
  if (!section) {
    return dashboardDefaults();
  }
  const payload = {
    api_base: section.apiBase ? section.apiBase.value : "",
  };
  return canonicalDashboardSettings(payload);
}

function archivalDefaults() {
  return {
    enabled: false,
    backend: "network_share",
    include_waveform_sidecars: false,
    network_share: { target_dir: "" },
    rsync: {
      destination: "",
      ssh_identity: "",
      options: ["-az"],
      ssh_options: [],
    },
  };
}

function canonicalArchivalSettings(settings) {
  const defaults = archivalDefaults();
  if (!settings || typeof settings !== "object") {
    return defaults;
  }

  const canonical = {
    enabled: parseBoolean(settings.enabled),
    backend: defaults.backend,
    include_waveform_sidecars: parseBoolean(settings.include_waveform_sidecars),
    network_share: { target_dir: "" },
    rsync: {
      destination: "",
      ssh_identity: "",
      options: [],
      ssh_options: [],
    },
  };

  const backendValue = typeof settings.backend === "string" ? settings.backend.trim() : "";
  if (ARCHIVAL_BACKENDS.has(backendValue)) {
    canonical.backend = backendValue;
  }

  const networkShare =
    settings.network_share && typeof settings.network_share === "object"
      ? settings.network_share
      : {};
  if (typeof networkShare.target_dir === "string") {
    canonical.network_share.target_dir = networkShare.target_dir.trim();
  }

  const rsync = settings.rsync && typeof settings.rsync === "object" ? settings.rsync : {};
  if (typeof rsync.destination === "string") {
    canonical.rsync.destination = rsync.destination.trim();
  }
  if (typeof rsync.ssh_identity === "string") {
    canonical.rsync.ssh_identity = rsync.ssh_identity.trim();
  }

  if (Array.isArray(rsync.options)) {
    canonical.rsync.options = rsync.options
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item);
  } else if (typeof rsync.options === "string") {
    canonical.rsync.options = parseListInput(rsync.options);
  } else if (rsync.options == null) {
    canonical.rsync.options = defaults.rsync.options.slice();
  }

  if (Array.isArray(rsync.ssh_options)) {
    canonical.rsync.ssh_options = rsync.ssh_options
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item);
  } else if (typeof rsync.ssh_options === "string") {
    canonical.rsync.ssh_options = parseListInput(rsync.ssh_options);
  }

  if (canonical.rsync.options.length === 0 && rsync.options == null) {
    canonical.rsync.options = defaults.rsync.options.slice();
  }

  return canonical;
}

function computeArchivalFingerprint(settings) {
  return JSON.stringify(canonicalArchivalSettings(settings));
}

function normalizeArchivalResponse(payload) {
  const settings =
    payload && typeof payload === "object" ? canonicalArchivalSettings(payload.archival) : archivalDefaults();
  const configPath =
    payload && typeof payload === "object" && typeof payload.config_path === "string"
      ? payload.config_path
      : "";
  return { settings, configPath };
}

function updateArchivalConfigPath(path) {
  const text = typeof path === "string" ? path : "";
  archivalState.configPath = text;
  if (dom.archivalConfigPath) {
    dom.archivalConfigPath.textContent = text || "(unknown)";
  }
}

function updateArchivalBackendVisibility(backend) {
  const mode = ARCHIVAL_BACKENDS.has(backend) ? backend : "network_share";
  const showNetwork = mode === "network_share";
  const showRsync = mode === "rsync";
  if (dom.archivalNetworkShareSection) {
    dom.archivalNetworkShareSection.hidden = !showNetwork;
    dom.archivalNetworkShareSection.dataset.active = showNetwork ? "true" : "false";
    dom.archivalNetworkShareSection.setAttribute("aria-hidden", showNetwork ? "false" : "true");
  }
  if (dom.archivalRsyncSection) {
    dom.archivalRsyncSection.hidden = !showRsync;
    dom.archivalRsyncSection.dataset.active = showRsync ? "true" : "false";
    dom.archivalRsyncSection.setAttribute("aria-hidden", showRsync ? "false" : "true");
  }
}

function setArchivalStatus(message, state = "", options = {}) {
  if (!dom.archivalStatus) {
    return;
  }
  if (archivalState.statusTimeoutId) {
    window.clearTimeout(archivalState.statusTimeoutId);
    archivalState.statusTimeoutId = null;
  }
  const text = typeof message === "string" ? message : "";
  dom.archivalStatus.textContent = text;
  if (state) {
    dom.archivalStatus.dataset.state = state;
  } else {
    delete dom.archivalStatus.dataset.state;
  }
  dom.archivalStatus.setAttribute("aria-hidden", text ? "false" : "true");
  const { autoHide = false, duration = 3500 } = options;
  if (text && autoHide) {
    const delay = Number.isFinite(duration) ? Math.max(0, duration) : 3500;
    archivalState.statusTimeoutId = window.setTimeout(() => {
      archivalState.statusTimeoutId = null;
      if (!archivalState.dirty) {
        setArchivalStatus("", "");
      }
    }, delay);
  }
}

function updateArchivalButtons() {
  if (dom.archivalSave) {
    dom.archivalSave.disabled = archivalState.saving || !archivalState.dirty;
  }
  if (dom.archivalReset) {
    const disableReset =
      archivalState.saving || (!archivalState.dirty && !archivalState.pendingSnapshot && !archivalState.hasExternalUpdate);
    dom.archivalReset.disabled = disableReset;
  }
  if (dom.archivalDialog) {
    dom.archivalDialog.dataset.dirty = archivalState.dirty ? "true" : "false";
    dom.archivalDialog.dataset.saving = archivalState.saving ? "true" : "false";
    dom.archivalDialog.dataset.externalUpdate = archivalState.hasExternalUpdate ? "true" : "false";
  }
}

function setArchivalSaving(saving) {
  archivalState.saving = saving;
  if (dom.archivalForm) {
    dom.archivalForm.setAttribute("aria-busy", saving ? "true" : "false");
  }
  updateArchivalButtons();
}

function applyArchivalData(settings, { markPristine = true } = {}) {
  const canonical = canonicalArchivalSettings(settings);
  archivalState.current = canonical;
  if (dom.archivalEnabled) {
    dom.archivalEnabled.checked = canonical.enabled;
  }
  if (dom.archivalBackend) {
    dom.archivalBackend.value = canonical.backend;
  }
  if (dom.archivalIncludeWaveforms) {
    dom.archivalIncludeWaveforms.checked = canonical.include_waveform_sidecars;
  }
  if (dom.archivalNetworkShareTarget) {
    dom.archivalNetworkShareTarget.value = canonical.network_share.target_dir;
  }
  if (dom.archivalRsyncDestination) {
    dom.archivalRsyncDestination.value = canonical.rsync.destination;
  }
  if (dom.archivalRsyncIdentity) {
    dom.archivalRsyncIdentity.value = canonical.rsync.ssh_identity;
  }
  if (dom.archivalRsyncOptions) {
    dom.archivalRsyncOptions.value = canonical.rsync.options.join("\n");
  }
  if (dom.archivalRsyncSshOptions) {
    dom.archivalRsyncSshOptions.value = canonical.rsync.ssh_options.join("\n");
  }
  updateArchivalBackendVisibility(canonical.backend);

  if (markPristine) {
    archivalState.lastAppliedFingerprint = computeArchivalFingerprint(canonical);
    archivalState.dirty = false;
    archivalState.pendingSnapshot = null;
    archivalState.hasExternalUpdate = false;
  } else {
    updateArchivalDirtyState();
  }
  updateArchivalButtons();
}

function readArchivalForm() {
  return {
    enabled: dom.archivalEnabled ? dom.archivalEnabled.checked : false,
    backend: dom.archivalBackend ? dom.archivalBackend.value : "network_share",
    include_waveform_sidecars: dom.archivalIncludeWaveforms
      ? dom.archivalIncludeWaveforms.checked
      : false,
    network_share: {
      target_dir: dom.archivalNetworkShareTarget
        ? dom.archivalNetworkShareTarget.value.trim()
        : "",
    },
    rsync: {
      destination: dom.archivalRsyncDestination ? dom.archivalRsyncDestination.value.trim() : "",
      ssh_identity: dom.archivalRsyncIdentity ? dom.archivalRsyncIdentity.value.trim() : "",
      options: parseListInput(dom.archivalRsyncOptions ? dom.archivalRsyncOptions.value : ""),
      ssh_options: parseListInput(dom.archivalRsyncSshOptions ? dom.archivalRsyncSshOptions.value : ""),
    },
  };
}

function updateArchivalDirtyState() {
  const fingerprint = computeArchivalFingerprint(readArchivalForm());
  archivalState.dirty = fingerprint !== archivalState.lastAppliedFingerprint;
  updateArchivalButtons();
}

async function extractErrorMessage(response) {
  const contentType = response.headers ? response.headers.get("content-type") : "";
  if (contentType && contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      if (payload && typeof payload === "object" && payload) {
        const errorText = typeof payload.error === "string" ? payload.error.trim() : "";
        const errorList = Array.isArray(payload.errors)
          ? payload.errors
              .map((item) => (typeof item === "string" ? item.trim() : ""))
              .filter((item) => item)
          : [];
        if (errorText && errorList.length) {
          return `${errorText}\n- ${errorList.join("\n- ")}`;
        }
        if (errorText) {
          return errorText;
        }
        if (errorList.length) {
          return errorList.join("\n");
        }
        if (typeof payload.message === "string" && payload.message) {
          return payload.message;
        }
      }
    } catch (error) {
      /* ignore */
    }
  }
  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch (error) {
    /* ignore */
  }
  return `Request failed with status ${response.status}`;
}

async function fetchArchivalSettings({ silent = false } = {}) {
  if (archivalState.fetchInFlight) {
    archivalState.fetchQueued = true;
    return;
  }
  archivalState.fetchInFlight = true;
  archivalState.loading = true;
  if (!silent) {
    setArchivalStatus("Loading archival settings…", "info");
  }
  try {
    const response = await fetch(ARCHIVAL_ENDPOINT, { cache: "no-store" });
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw new Error(message);
    }
    const payload = await response.json();
    const { settings, configPath } = normalizeArchivalResponse(payload);
    applyArchivalData(settings, { markPristine: true });
    updateArchivalConfigPath(configPath);
    archivalState.loaded = true;
    if (!silent) {
      setArchivalStatus("Archival settings loaded.", "success", { autoHide: true, duration: 2500 });
    } else if (archivalState.hasExternalUpdate) {
      setArchivalStatus("Archival settings refreshed.", "info", { autoHide: true, duration: 2000 });
    }
  } catch (error) {
    console.error("Failed to fetch archival settings", error);
    if (!silent) {
      const message = error && error.message ? error.message : "Unable to load archival settings.";
      setArchivalStatus(message, "error");
    }
  } finally {
    archivalState.fetchInFlight = false;
    archivalState.loading = false;
    if (archivalState.fetchQueued) {
      archivalState.fetchQueued = false;
      fetchArchivalSettings({ silent: true });
    }
    updateArchivalButtons();
  }
}

function syncArchivalSnapshotFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    return;
  }
  const snapshot = canonicalArchivalSettings(cfg.archival);
  const fingerprint = computeArchivalFingerprint(snapshot);
  if (!archivalState.loaded) {
    applyArchivalData(snapshot, { markPristine: true });
    return;
  }
  if (fingerprint === archivalState.lastAppliedFingerprint) {
    return;
  }
  if (!archivalState.dirty) {
    applyArchivalData(snapshot, { markPristine: true });
    setArchivalStatus("Archival settings updated from config file.", "info", { autoHide: true, duration: 2500 });
  } else {
    archivalState.pendingSnapshot = snapshot;
    archivalState.hasExternalUpdate = true;
    setArchivalStatus("Archival settings changed on disk. Reset to load the new values.", "warning");
    updateArchivalButtons();
  }
}

async function saveArchivalSettings() {
  if (!dom.archivalForm) {
    return;
  }
  const payload = readArchivalForm();
  setArchivalStatus("Saving changes…", "pending");
  setArchivalSaving(true);
  try {
    const response = await fetch(ARCHIVAL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setArchivalStatus(message, "error");
      return;
    }
    const data = await response.json();
    const { settings, configPath } = normalizeArchivalResponse(data);
    applyArchivalData(settings, { markPristine: true });
    updateArchivalConfigPath(configPath);
    archivalState.loaded = true;
    setArchivalStatus("Archival settings saved.", "success", { autoHide: true, duration: 2500 });
  } catch (error) {
    console.error("Failed to save archival settings", error);
    const message = error && error.message ? error.message : "Unable to save archival settings.";
    setArchivalStatus(message, "error");
  } finally {
    setArchivalSaving(false);
  }
}

function handleArchivalReset() {
  if (archivalState.saving) {
    return;
  }
  if (archivalState.pendingSnapshot) {
    applyArchivalData(archivalState.pendingSnapshot, { markPristine: true });
    setArchivalStatus("Loaded updated settings from disk.", "info", { autoHide: true, duration: 2500 });
    return;
  }
  if (archivalState.current) {
    applyArchivalData(archivalState.current, { markPristine: true });
    setArchivalStatus("Reverted unsaved changes.", "info", { autoHide: true, duration: 2000 });
  }
}

async function fetchConfig({ silent = false } = {}) {
  if (configFetchInFlight) {
    configFetchQueued = true;
    return;
  }
  configFetchInFlight = true;
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
    if (payload && typeof payload.config_path === "string") {
      updateRecorderConfigPath(payload.config_path);
    }
    syncRecorderSectionsFromConfig(payload);
    syncArchivalSnapshotFromConfig(payload);
  } catch (error) {
    console.error("Failed to fetch config", error);
    if (!silent && dom.configViewer) {
      dom.configViewer.textContent = "Unable to load configuration.";
    }
  } finally {
    configFetchInFlight = false;
    if (configFetchQueued) {
      configFetchQueued = false;
      fetchConfig({ silent: true });
    }
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
    updateLiveToggleAvailabilityFromServices();
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
  updateLiveToggleAvailabilityFromServices();
}

function appMenuFocusableElements() {
  if (!dom.appMenu) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.appMenu.querySelectorAll(selectors);
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
    focusable.push(node);
  }
  return focusable;
}

function setAppMenuVisible(visible) {
  if (!dom.appMenu) {
    return;
  }
  dom.appMenu.dataset.visible = visible ? "true" : "false";
  dom.appMenu.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.appMenu.removeAttribute("hidden");
  } else {
    dom.appMenu.setAttribute("hidden", "hidden");
  }
}

function attachAppMenuHandlers() {
  if (!dom.appMenu) {
    return;
  }
  if (!appMenuState.pointerHandler) {
    appMenuState.pointerHandler = (event) => {
      if (!appMenuState.open) {
        return;
      }
      const target = event.target;
      if (
        (dom.appMenuToggle && target instanceof Node && dom.appMenuToggle.contains(target)) ||
        (dom.appMenu && target instanceof Node && dom.appMenu.contains(target))
      ) {
        return;
      }
      closeAppMenu({ restoreFocus: false });
    };
    document.addEventListener("pointerdown", appMenuState.pointerHandler, true);
  }
  if (!appMenuState.keydownHandler) {
    appMenuState.keydownHandler = (event) => {
      if (!appMenuState.open) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeAppMenu();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const target = event.target;
      if (
        !dom.appMenu ||
        !(target instanceof Node) ||
        (!dom.appMenu.contains(target) && (!dom.appMenuToggle || target !== dom.appMenuToggle))
      ) {
        return;
      }
      const focusable = appMenuFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        closeAppMenu();
        return;
      }
      if (dom.appMenuToggle && target === dom.appMenuToggle) {
        event.preventDefault();
        const destination = event.shiftKey
          ? focusable[focusable.length - 1]
          : focusable[0];
        if (destination instanceof HTMLElement) {
          destination.focus();
        }
        return;
      }
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.shiftKey) {
        if (!active) {
          event.preventDefault();
          last.focus();
        } else if (active === first) {
          event.preventDefault();
          if (dom.appMenuToggle && typeof dom.appMenuToggle.focus === "function") {
            dom.appMenuToggle.focus();
          } else {
            last.focus();
          }
        }
      } else if (!active || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", appMenuState.keydownHandler, true);
  }
}

function detachAppMenuHandlers() {
  if (appMenuState.pointerHandler) {
    document.removeEventListener("pointerdown", appMenuState.pointerHandler, true);
    appMenuState.pointerHandler = null;
  }
  if (appMenuState.keydownHandler) {
    document.removeEventListener("keydown", appMenuState.keydownHandler, true);
    appMenuState.keydownHandler = null;
  }
}

function focusFirstAppMenuItem() {
  const focusable = appMenuFocusableElements();
  if (focusable.length > 0) {
    focusable[0].focus();
  }
}

function openAppMenu() {
  if (!dom.appMenu || !dom.appMenuToggle) {
    return;
  }
  if (appMenuState.open) {
    focusFirstAppMenuItem();
    return;
  }
  appMenuState.open = true;
  appMenuState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dom.appMenuToggle.setAttribute("aria-expanded", "true");
  setAppMenuVisible(true);
  attachAppMenuHandlers();
  window.requestAnimationFrame(() => {
    focusFirstAppMenuItem();
  });
}

function closeAppMenu(options = {}) {
  if (!appMenuState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  appMenuState.open = false;
  setAppMenuVisible(false);
  if (dom.appMenuToggle) {
    dom.appMenuToggle.setAttribute("aria-expanded", "false");
  }
  detachAppMenuHandlers();
  const previous = appMenuState.previouslyFocused;
  appMenuState.previouslyFocused = null;
  if (!restoreFocus) {
    return;
  }
  if (previous && typeof previous.focus === "function") {
    previous.focus();
    return;
  }
  if (dom.appMenuToggle && typeof dom.appMenuToggle.focus === "function") {
    dom.appMenuToggle.focus();
  }
}

function toggleAppMenu() {
  if (appMenuState.open) {
    closeAppMenu();
  } else {
    openAppMenu();
  }
}

function recorderModalFocusableElements() {
  if (!recorderDom.dialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = recorderDom.dialog.querySelectorAll(selectors);
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

function setRecorderModalVisible(visible) {
  if (!recorderDom.modal) {
    return;
  }
  recorderDom.modal.dataset.visible = visible ? "true" : "false";
  recorderDom.modal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    recorderDom.modal.removeAttribute("hidden");
    lockDocumentScroll("recorder-settings");
  } else {
    recorderDom.modal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("recorder-settings");
  }
}

function attachRecorderDialogKeydown() {
  if (recorderDialogState.keydownHandler) {
    return;
  }
  recorderDialogState.keydownHandler = (event) => {
    if (!recorderDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      recorderDom.modal &&
      target instanceof Node &&
      (target === recorderDom.modal || recorderDom.modal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeRecorderDialog();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = recorderModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (recorderDom.dialog) {
        recorderDom.dialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === recorderDom.dialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", recorderDialogState.keydownHandler, true);
}

function detachRecorderDialogKeydown() {
  if (!recorderDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", recorderDialogState.keydownHandler, true);
  recorderDialogState.keydownHandler = null;
}

function focusRecorderDialog(sectionKey) {
  if (!recorderDom.dialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    let target = null;
    if (sectionKey) {
      const sectionContainer = recorderDom.dialog.querySelector(
        `.recorder-section[data-section-key="${sectionKey}"]`
      );
      if (sectionContainer instanceof HTMLElement) {
        const focusable = sectionContainer.querySelector(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable instanceof HTMLElement) {
          target = focusable;
        }
      }
    }
    if (!target) {
      const focusable = recorderModalFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
        return;
      }
      recorderDom.dialog.focus();
      return;
    }
    target.focus();
  });
}

function firstRecorderSectionKey() {
  for (const key of recorderState.sections.keys()) {
    return key;
  }
  return "";
}

function resolveRecorderSectionKey(preferred) {
  if (preferred && recorderState.sections.has(preferred)) {
    return preferred;
  }
  if (recorderDialogState.activeSection && recorderState.sections.has(recorderDialogState.activeSection)) {
    return recorderDialogState.activeSection;
  }
  return firstRecorderSectionKey();
}

function setActiveRecorderSection(sectionKey, options = {}) {
  const key = resolveRecorderSectionKey(sectionKey);
  recorderDialogState.activeSection = key || "";

  if (recorderDom.dialog) {
    if (key) {
      recorderDom.dialog.dataset.activeSection = key;
    } else if (recorderDom.dialog.dataset.activeSection) {
      delete recorderDom.dialog.dataset.activeSection;
    }
  }

  const { menuItems } = recorderDom;
  if (menuItems && typeof menuItems.length === "number") {
    for (const item of menuItems) {
      if (!(item instanceof HTMLElement)) {
        continue;
      }
      const itemKey = item.getAttribute("data-recorder-section");
      const active = itemKey === key && key;
      if (active) {
        item.setAttribute("aria-current", "true");
        item.dataset.active = "true";
      } else {
        item.removeAttribute("aria-current");
        if (item.dataset.active) {
          delete item.dataset.active;
        }
      }
    }
  }

  if (!key) {
    return;
  }

  const { scrollIntoView = false } = options;
  if (!scrollIntoView) {
    return;
  }
  const sectionContainer =
    recorderDom.dialog &&
    recorderDom.dialog.querySelector(`.recorder-section[data-section-key="${key}"]`);
  if (sectionContainer instanceof HTMLElement) {
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    sectionContainer.scrollIntoView({ block: "start", inline: "nearest", behavior });
  }
}

function openRecorderDialog(options = {}) {
  if (!recorderDom.modal || !recorderDom.dialog) {
    return;
  }
  const { focus = true, section = "" } = options;
  const resolvedSection = resolveRecorderSectionKey(section);

  if (recorderDialogState.open) {
    setActiveRecorderSection(resolvedSection, { scrollIntoView: true });
    if (focus) {
      focusRecorderDialog(resolvedSection);
    }
    return;
  }

  recorderDialogState.open = true;
  recorderDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setRecorderModalVisible(true);
  attachRecorderDialogKeydown();
  setActiveRecorderSection(resolvedSection, { scrollIntoView: true });

  if (!recorderState.loaded && !recorderState.loadingPromise) {
    ensureRecorderSectionsLoaded();
  }

  if (focus) {
    focusRecorderDialog(resolvedSection);
  }
}

function closeRecorderDialog(options = {}) {
  if (!recorderDom.modal) {
    return;
  }
  if (!recorderDialogState.open) {
    return;
  }

  recorderDialogState.open = false;
  setRecorderModalVisible(false);
  detachRecorderDialogKeydown();

  const { restoreFocus = true } = options;
  const previous = recorderDialogState.previouslyFocused;
  recorderDialogState.previouslyFocused = null;
  if (!restoreFocus) {
    return;
  }
  if (previous && typeof previous.focus === "function") {
    previous.focus();
  } else if (recorderDom.menuItems && recorderDom.menuItems[0] instanceof HTMLElement) {
    recorderDom.menuItems[0].focus();
  }
}

function archivalModalFocusableElements() {
  if (!dom.archivalDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.archivalDialog.querySelectorAll(selectors);
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

function setArchivalModalVisible(visible) {
  if (!dom.archivalModal) {
    return;
  }
  dom.archivalModal.dataset.visible = visible ? "true" : "false";
  dom.archivalModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.archivalModal.removeAttribute("hidden");
    lockDocumentScroll("archival-settings");
  } else {
    dom.archivalModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("archival-settings");
  }
}

function attachArchivalDialogKeydown() {
  if (archivalDialogState.keydownHandler) {
    return;
  }
  archivalDialogState.keydownHandler = (event) => {
    if (!archivalDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.archivalModal &&
      target instanceof Node &&
      (target === dom.archivalModal || dom.archivalModal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeArchivalModal();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = archivalModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.archivalDialog) {
        dom.archivalDialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.archivalDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", archivalDialogState.keydownHandler, true);
}

function detachArchivalDialogKeydown() {
  if (!archivalDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", archivalDialogState.keydownHandler, true);
  archivalDialogState.keydownHandler = null;
}

function focusArchivalDialog() {
  if (!dom.archivalDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = archivalModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.archivalDialog.focus();
    }
  });
}

function openArchivalModal(options = {}) {
  if (!dom.archivalModal || !dom.archivalDialog) {
    return;
  }
  const { focus = true } = options;
  if (archivalDialogState.open) {
    if (focus) {
      focusArchivalDialog();
    }
    return;
  }
  archivalDialogState.open = true;
  archivalDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setArchivalModalVisible(true);
  if (dom.archivalOpen) {
    dom.archivalOpen.setAttribute("aria-expanded", "true");
  }
  attachArchivalDialogKeydown();
  if (!archivalState.loaded && !archivalState.fetchInFlight) {
    fetchArchivalSettings({ silent: false });
  } else if (archivalState.hasExternalUpdate && archivalState.pendingSnapshot && !archivalState.saving) {
    setArchivalStatus(
      "Archival settings changed on disk. Reset to load the new values.",
      "warning"
    );
  } else {
    updateArchivalButtons();
  }
  if (focus) {
    focusArchivalDialog();
  }
}

function closeArchivalModal(options = {}) {
  if (!archivalDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  archivalDialogState.open = false;
  setArchivalModalVisible(false);
  if (dom.archivalOpen) {
    dom.archivalOpen.setAttribute("aria-expanded", "false");
  }
  detachArchivalDialogKeydown();
  const previous = archivalDialogState.previouslyFocused;
  archivalDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
}

function configModalFocusableElements() {
  if (!dom.configDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.configDialog.querySelectorAll(selectors);
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

function setConfigModalVisible(visible) {
  if (!dom.configModal) {
    return;
  }
  dom.configModal.dataset.visible = visible ? "true" : "false";
  dom.configModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.configModal.removeAttribute("hidden");
    lockDocumentScroll("config-snapshot");
  } else {
    dom.configModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("config-snapshot");
  }
}

function attachConfigDialogKeydown() {
  if (configDialogState.keydownHandler) {
    return;
  }
  configDialogState.keydownHandler = (event) => {
    if (!configDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.configModal &&
      target instanceof Node &&
      (target === dom.configModal || dom.configModal.contains(target));
    if (event.key === "Escape") {
      if (withinModal) {
        event.preventDefault();
      }
      closeConfigModal();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    if (!withinModal) {
      return;
    }
    const focusable = configModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.configDialog) {
        dom.configDialog.focus();
      }
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.configDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", configDialogState.keydownHandler, true);
}

function detachConfigDialogKeydown() {
  if (!configDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", configDialogState.keydownHandler, true);
  configDialogState.keydownHandler = null;
}

function focusConfigDialog() {
  if (!dom.configDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = configModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.configDialog.focus();
    }
  });
}

function openConfigModal(options = {}) {
  if (!dom.configModal || !dom.configDialog) {
    return;
  }
  const { focus = true } = options;
  if (dom.configOpen) {
    dom.configOpen.setAttribute("aria-expanded", "true");
  }
  if (configDialogState.open) {
    if (focus) {
      focusConfigDialog();
    }
    fetchConfig({ silent: true });
    return;
  }
  configDialogState.open = true;
  configDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setConfigModalVisible(true);
  attachConfigDialogKeydown();
  if (dom.configViewer) {
    dom.configViewer.scrollTop = 0;
  }
  fetchConfig({ silent: true });
  if (focus) {
    focusConfigDialog();
  }
}

function closeConfigModal(options = {}) {
  if (!configDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  configDialogState.open = false;
  setConfigModalVisible(false);
  if (dom.configOpen) {
    dom.configOpen.setAttribute("aria-expanded", "false");
  }
  detachConfigDialogKeydown();
  const previous = configDialogState.previouslyFocused;
  configDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
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
    lockDocumentScroll("services");
  } else {
    dom.servicesModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("services");
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

function extractFilenameFromDisposition(disposition) {
  if (typeof disposition !== "string" || !disposition) {
    return null;
  }
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (error) {
      return utf8Match[1];
    }
  }
  const simpleMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (simpleMatch && simpleMatch[1]) {
    return simpleMatch[1];
  }
  return null;
}

async function renameRecording(path, newName, options = {}) {
  if (typeof path !== "string" || !path || typeof newName !== "string" || !newName) {
    throw new Error("Invalid rename request");
  }
  const payload = {
    item: path,
    name: newName,
  };
  const extensionValue =
    options && typeof options.extension === "string" ? options.extension.trim() : "";
  if (extensionValue) {
    payload.extension = extensionValue;
  }

  const response = await fetch(apiPath("/api/recordings/rename"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = `Rename failed with status ${response.status}`;
    try {
      const errorPayload = await response.json();
      if (typeof errorPayload.error === "string" && errorPayload.error) {
        message = errorPayload.error;
      } else if (Array.isArray(errorPayload.errors) && errorPayload.errors.length) {
        const combined = errorPayload.errors
          .map((entry) => {
            const item = typeof entry.item === "string" ? entry.item : "";
            const errorText = typeof entry.error === "string" ? entry.error : "";
            return item ? `${item}: ${errorText}` : errorText;
          })
          .filter(Boolean)
          .join("\n");
        if (combined) {
          message = combined;
        }
      }
    } catch (error) {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const payloadJson = await response.json();
  const oldPath = typeof payloadJson.old_path === "string" ? payloadJson.old_path : path;
  const newPath = typeof payloadJson.new_path === "string" ? payloadJson.new_path : path;

  if (state.selections.has(oldPath)) {
    state.selections.delete(oldPath);
    state.selections.add(newPath);
  }
  if (state.current && state.current.path === oldPath) {
    pendingSelectionPath = newPath;
  }

  updateSelectionUI();
  await fetchRecordings({ silent: false });

  return payloadJson;
}

async function downloadRecordingsArchive(paths) {
  if (!Array.isArray(paths) || !paths.length) {
    return;
  }

  const response = await fetch(apiPath("/api/recordings/bulk-download"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items: paths }),
  });

  if (!response.ok) {
    let message = `Download failed with status ${response.status}`;
    try {
      const errorPayload = await response.json();
      if (typeof errorPayload.error === "string" && errorPayload.error) {
        message = errorPayload.error;
      } else if (Array.isArray(errorPayload.errors) && errorPayload.errors.length) {
        const combined = errorPayload.errors
          .map((entry) => {
            const item = typeof entry.item === "string" ? entry.item : "";
            const errorText = typeof entry.error === "string" ? entry.error : "";
            return item ? `${item}: ${errorText}` : errorText;
          })
          .filter(Boolean)
          .join("\n");
        if (combined) {
          message = combined;
        }
      }
    } catch (error) {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition");
  let filename = extractFilenameFromDisposition(disposition);
  if (!filename) {
    const now = new Date();
    if (!Number.isNaN(now.getTime())) {
      const timestamp =
        `${now.getFullYear()}` +
        `${String(now.getMonth() + 1).padStart(2, "0")}` +
        `${String(now.getDate()).padStart(2, "0")}` +
        `-${String(now.getHours()).padStart(2, "0")}` +
        `${String(now.getMinutes()).padStart(2, "0")}` +
        `${String(now.getSeconds()).padStart(2, "0")}`;
      filename = `tricorder-recordings-${timestamp}.zip`;
    } else {
      filename = "tricorder-recordings.zip";
    }
  }

  if (typeof window === "undefined" || !window.URL || !window.document) {
    return;
  }

  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename || "recordings.zip";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    window.URL.revokeObjectURL(blobUrl);
  }, 1000);
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

function setLiveToggleDisabled(disabled, reason = "") {
  if (!dom.liveToggle) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  if (dom.liveToggle.disabled !== nextDisabled) {
    dom.liveToggle.disabled = nextDisabled;
  }
  if (nextDisabled) {
    if (reason) {
      dom.liveToggle.title = reason;
    } else {
      dom.liveToggle.removeAttribute("title");
    }
    dom.liveToggle.setAttribute("aria-disabled", "true");
  } else {
    dom.liveToggle.removeAttribute("title");
    dom.liveToggle.removeAttribute("aria-disabled");
  }
}

function updateLiveToggleAvailabilityFromServices() {
  if (!dom.liveToggle) {
    return;
  }

  const service = servicesState.items.find(
    (entry) => entry && entry.unit === VOICE_RECORDER_SERVICE_UNIT,
  );
  if (!service) {
    let reason = "Recorder service status unavailable.";
    if (servicesState.items.length > 0) {
      reason = "Recorder service unavailable.";
    } else if (servicesState.error) {
      reason = servicesState.error;
    } else if (servicesState.fetchInFlight) {
      reason = "Checking recorder service status…";
    }
    setLiveToggleDisabled(true, reason);
    if (liveState.open) {
      closeLiveStreamPanel();
    }
    return;
  }

  const pending = servicesState.pending.has(service.unit);
  const available = service.available !== false;
  const active = service.is_active === true;

  let disabled = false;
  let reason = "";

  if (pending) {
    disabled = true;
    reason = "Recorder service changing state.";
  } else if (!available) {
    disabled = true;
    reason = service.error || "Recorder service unavailable.";
  } else if (!active) {
    disabled = true;
    reason = "Recorder service is stopped.";
  }

  setLiveToggleDisabled(disabled, reason);
  if (disabled && liveState.open) {
    closeLiveStreamPanel();
  }
}

function attachLiveStreamSource() {
  if (!dom.liveAudio) {
    return;
  }
  detachLiveStream();
  dom.liveAudio.autoplay = true;
  if (STREAM_MODE === "webrtc") {
    startWebRtcStream().catch((error) => {
      console.error("WebRTC setup failed", error);
      setLiveStatus("Error");
    });
    return;
  }
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

function waitForIceGatheringComplete(pc) {
  if (!pc) {
    return Promise.resolve();
  }
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", checkState);
  });
}

async function startWebRtcStream() {
  if (!dom.liveAudio) {
    return;
  }
  const pc = new RTCPeerConnection();
  liveState.pc = pc;
  const mediaStream = new MediaStream();
  liveState.stream = mediaStream;
  dom.liveAudio.srcObject = mediaStream;
  dom.liveAudio.setAttribute("playsinline", "true");

  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.addEventListener("track", (event) => {
    const [trackStream] = event.streams;
    if (trackStream) {
      trackStream.getTracks().forEach((track) => {
        mediaStream.addTrack(track);
      });
    } else if (event.track) {
      mediaStream.addTrack(event.track);
    }
    dom.liveAudio.play().catch(() => undefined);
    setLiveStatus("Live");
  });

  pc.addEventListener("connectionstatechange", () => {
    if (!liveState.active) {
      return;
    }
    if (pc.connectionState === "failed") {
      setLiveStatus("Connection failed");
    } else if (pc.connectionState === "connected") {
      setLiveStatus("Live");
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  if (!pc.localDescription) {
    throw new Error("Missing local description");
  }

  if (!OFFER_ENDPOINT) {
    throw new Error("Offer endpoint unavailable");
  }

  const response = await fetch(withSession(OFFER_ENDPOINT), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
    }),
  });

  if (!response.ok) {
    throw new Error(`offer failed with status ${response.status}`);
  }

  const answer = await response.json();
  if (!answer || typeof answer.sdp !== "string" || typeof answer.type !== "string") {
    throw new Error("invalid answer");
  }

  const rtcAnswer = new RTCSessionDescription({ sdp: answer.sdp, type: answer.type });
  await pc.setRemoteDescription(rtcAnswer);

  dom.liveAudio.play().catch(() => undefined);
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
  if (liveState.pc) {
    try {
      liveState.pc.close();
    } catch (error) {
      console.warn("Failed to close WebRTC connection", error);
    }
    liveState.pc = null;
  }
  if (liveState.stream) {
    try {
      const tracks = liveState.stream.getTracks();
      for (const track of tracks) {
        track.stop();
      }
    } catch (error) {
      console.warn("Failed to stop WebRTC tracks", error);
    }
    liveState.stream = null;
  }
  if (dom.liveAudio) {
    dom.liveAudio.pause();
    dom.liveAudio.removeAttribute("src");
    dom.liveAudio.srcObject = null;
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
  releaseLiveAudioFocus();
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

function releaseLiveAudioFocus() {
  if (!dom.liveAudio || typeof document === "undefined") {
    return;
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active !== dom.liveAudio) {
    return;
  }
  if (dom.liveToggle && typeof dom.liveToggle.focus === "function" && !dom.liveToggle.disabled) {
    try {
      dom.liveToggle.focus();
      return;
    } catch (error) {
      /* ignore focus errors */
    }
  }
  try {
    dom.liveAudio.blur();
  } catch (error) {
    /* ignore blur errors */
  }
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
  if (typeof document !== "undefined") {
    const handleGlobalFocusIn = (event) => {
      if (findInteractiveElement(event.target, event)) {
        suspendAutoRefresh();
      }
    };

    const handleGlobalFocusOut = (event) => {
      if (!findInteractiveElement(event.target, event)) {
        return;
      }
      window.requestAnimationFrame(() => {
        const active =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!findInteractiveElement(active)) {
          resumeAutoRefresh();
        }
      });
    };

    document.addEventListener("focusin", handleGlobalFocusIn);
    document.addEventListener("focusout", handleGlobalFocusOut);
    document.addEventListener("pointerdown", (event) => {
      if (findInteractiveElement(event.target, event)) {
        suspendAutoRefresh();
      }
    });
  }

  const audioSection = recorderDom.sections ? recorderDom.sections.audio : null;
  if (audioSection) {
    const toggles = [
      audioSection.filterHighpassEnabled,
      audioSection.filterLowpassEnabled,
      audioSection.filterNoiseGateEnabled,
      audioSection.calibrationNoise,
    ];
    for (const toggle of toggles) {
      if (toggle instanceof HTMLInputElement) {
        toggle.addEventListener("change", () => {
          updateAudioFilterControls();
        });
      }
    }
    const sliders = [
      audioSection.filterHighpassCutoff,
      audioSection.filterLowpassCutoff,
      audioSection.filterNoiseGateThreshold,
    ];
    for (const slider of sliders) {
      if (slider instanceof HTMLInputElement) {
        slider.addEventListener("input", updateAudioFilterControls);
        slider.addEventListener("change", updateAudioFilterControls);
      }
    }
    if (audioSection.calibrationGain instanceof HTMLInputElement) {
      audioSection.calibrationGain.addEventListener("change", updateAudioFilterControls);
    }
    if (audioSection.calibrateNoiseButton instanceof HTMLButtonElement) {
      audioSection.calibrateNoiseButton.addEventListener("click", () => {
        const targetUrl = "/static/docs/room-tuner.html";
        window.open(targetUrl, "_blank", "noopener");
      });
    }
  }

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

    dom.filtersPanel.addEventListener("focusin", suspendAutoRefresh);
    dom.filtersPanel.addEventListener("pointerdown", suspendAutoRefresh);
    dom.filtersPanel.addEventListener("focusout", handleFiltersFocusOut);
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

  if (dom.appMenuToggle && dom.appMenu) {
    dom.appMenuToggle.addEventListener("click", () => {
      toggleAppMenu();
    });
    dom.appMenuToggle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openAppMenu();
      } else if (event.key === "Escape" && appMenuState.open) {
        event.preventDefault();
        closeAppMenu();
      }
    });
  }

  if (recorderDom.menuItems && typeof recorderDom.menuItems.length === "number") {
    for (const item of recorderDom.menuItems) {
      if (!(item instanceof HTMLElement)) {
        continue;
      }
      item.addEventListener("click", () => {
        const section = item.getAttribute("data-recorder-section") || "";
        closeAppMenu({ restoreFocus: false });
        openRecorderDialog({ section });
      });
    }
  }

  if (recorderDom.close) {
    recorderDom.close.addEventListener("click", () => {
      closeRecorderDialog();
    });
  }

  if (recorderDom.modal) {
    recorderDom.modal.addEventListener("mousedown", (event) => {
      if (event.target === recorderDom.modal) {
        event.preventDefault();
      }
    });
    recorderDom.modal.addEventListener("click", (event) => {
      if (event.target === recorderDom.modal) {
        closeRecorderDialog();
      }
    });
  }

  if (dom.configOpen) {
    dom.configOpen.addEventListener("click", () => {
      closeAppMenu({ restoreFocus: false });
      openConfigModal();
    });
  }

  if (dom.configClose) {
    dom.configClose.addEventListener("click", () => {
      closeConfigModal();
    });
  }

  if (dom.configModal) {
    dom.configModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.configModal) {
        event.preventDefault();
      }
    });
    dom.configModal.addEventListener("click", (event) => {
      if (event.target === dom.configModal) {
        closeConfigModal();
      }
    });
  }

  if (dom.archivalOpen) {
    dom.archivalOpen.addEventListener("click", () => {
      closeAppMenu({ restoreFocus: false });
      openArchivalModal();
    });
  }

  if (dom.archivalClose) {
    dom.archivalClose.addEventListener("click", () => {
      closeArchivalModal();
    });
  }

  if (dom.archivalModal) {
    dom.archivalModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.archivalModal) {
        event.preventDefault();
      }
    });
    dom.archivalModal.addEventListener("click", (event) => {
      if (event.target === dom.archivalModal) {
        closeArchivalModal();
      }
    });
  }

  if (dom.archivalForm) {
    dom.archivalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveArchivalSettings();
    });

    const handleArchivalChange = (event) => {
      if (event && event.target === dom.archivalBackend) {
        updateArchivalBackendVisibility(dom.archivalBackend.value);
      }
      updateArchivalDirtyState();
    };

    dom.archivalForm.addEventListener("input", handleArchivalChange);
    dom.archivalForm.addEventListener("change", handleArchivalChange);
  }

  if (dom.archivalReset) {
    dom.archivalReset.addEventListener("click", () => {
      handleArchivalReset();
    });
  }

  if (dom.servicesOpen) {
    dom.servicesOpen.addEventListener("click", () => {
      closeAppMenu({ restoreFocus: false });
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

  if (dom.downloadSelected) {
    dom.downloadSelected.addEventListener("click", async () => {
      if (!state.selections.size) {
        return;
      }
      const paths = Array.from(state.selections.values());
      dom.downloadSelected.disabled = true;
      try {
        await downloadRecordingsArchive(paths);
      } catch (error) {
        console.error("Bulk download failed", error);
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Unable to download recordings.";
        if (typeof window !== "undefined" && typeof window.alert === "function") {
          window.alert(message);
        }
      } finally {
        updateSelectionUI();
      }
    });
  }

  if (dom.renameSelected) {
    dom.renameSelected.addEventListener("click", () => {
      if (renameDialogState.pending || state.selections.size !== 1) {
        return;
      }
      const [selectedPath] = Array.from(state.selections.values());
      if (typeof selectedPath !== "string" || !selectedPath) {
        return;
      }
      const record = state.records.find((entry) => entry.path === selectedPath);
      if (record) {
        openRenameDialog(record);
      }
    });
  }

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

  if (dom.clipperSetStart) {
    dom.clipperSetStart.addEventListener("click", () => {
      setClipperStartFromPlayhead();
    });
  }

  if (dom.clipperSetEnd) {
    dom.clipperSetEnd.addEventListener("click", () => {
      setClipperEndFromPlayhead();
    });
  }

  if (dom.clipperReset) {
    dom.clipperReset.addEventListener("click", handleClipperReset);
  }

  if (dom.clipperUndo) {
    dom.clipperUndo.addEventListener("click", handleClipperUndo);
  }

  if (dom.clipperStartInput) {
    dom.clipperStartInput.addEventListener("change", handleClipperStartChange);
  }

  if (dom.clipperEndInput) {
    dom.clipperEndInput.addEventListener("change", handleClipperEndChange);
  }

  if (dom.clipperNameInput) {
    dom.clipperNameInput.addEventListener("input", handleClipperNameInput);
    dom.clipperNameInput.addEventListener("blur", handleClipperNameBlur);
  }

  if (dom.clipperOverwriteToggle) {
    dom.clipperOverwriteToggle.addEventListener("change", handleClipperOverwriteChange);
  }

  if (dom.clipperForm) {
    dom.clipperForm.addEventListener("submit", submitClipperForm);
  }

  if (dom.clipperToggle) {
    dom.clipperToggle.addEventListener("click", () => {
      const next = !clipperState.enabled;
      setClipperEnabled(next, { focus: next });
    });
  }

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
    stopHealthRefresh();
    stopConfigRefresh();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  window.addEventListener("pagehide", () => {
    stopAutoRefresh();
    stopServicesRefresh();
    stopHealthRefresh();
    stopConfigRefresh();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAutoRefresh();
      stopServicesRefresh();
      stopHealthRefresh();
      stopConfigRefresh();
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
      startHealthRefresh();
      startConfigRefresh();
      fetchServices({ silent: true });
      fetchConfig({ silent: true });
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
  setupResponsiveFilters();
  populateFilters();
  updateSelectionUI();
  updateSortIndicators();
  updatePaginationControls();
  resetWaveform();
  restoreClipperPreference();
  setClipperVisible(false);
  updateClipperStatusElement();
  setRecordingIndicatorUnknown("Loading status…");
  setRefreshIndicatorVisible(false);
  setLiveButtonState(false);
  setLiveStatus("Idle");
  setLiveToggleDisabled(true, "Checking recorder service status…");
  setRecorderModalVisible(false);
  setConfigModalVisible(false);
  updateRecorderConfigPath(recorderState.configPath);
  registerRecorderSections();
  updateAudioFilterControls();
  setServicesModalVisible(false);
  applyArchivalData(archivalDefaults(), { markPristine: true });
  updateArchivalConfigPath(archivalState.configPath);
  attachEventListeners();
  fetchRecordings({ silent: false });
  fetchConfig({ silent: false });
  fetchArchivalSettings({ silent: true });
  startConfigRefresh();
  startHealthRefresh();
  fetchServices({ silent: true });
  startAutoRefresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}
