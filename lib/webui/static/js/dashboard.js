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

function normalizeStartTimestamps(source) {
  const startEpochCandidate = toFiniteOrNull(source && source.start_epoch);
  const startedEpochCandidate = toFiniteOrNull(source && source.started_epoch);
  const startedAtRaw =
    typeof (source && source.started_at) === "string"
      ? source.started_at.trim()
      : "";

  let startEpoch = startEpochCandidate;
  let startedEpoch = startedEpochCandidate;
  let startedAt = startedAtRaw;

  if (startEpoch === null && startedEpoch !== null) {
    startEpoch = startedEpoch;
  }

  if (startEpoch === null && startedAt) {
    const parsed = Date.parse(startedAt);
    if (!Number.isNaN(parsed)) {
      startEpoch = parsed / 1000;
    }
  }

  if (startedEpoch === null) {
    startedEpoch = startEpoch;
  }

  if (!startedAt && startEpoch !== null) {
    try {
      startedAt = new Date(startEpoch * 1000).toISOString();
    } catch (error) {
      startedAt = "";
    }
  }

  const normalizedStartEpoch =
    typeof startEpoch === "number" && Number.isFinite(startEpoch) ? startEpoch : null;
  const normalizedStartedEpoch =
    typeof startedEpoch === "number" && Number.isFinite(startedEpoch)
      ? startedEpoch
      : null;

  return {
    startEpoch: normalizedStartEpoch,
    startedEpoch: normalizedStartedEpoch,
    startedAt,
  };
}

const AUTO_REFRESH_INTERVAL_MS = 1000;
const OFFLINE_REFRESH_INTERVAL_MS = 5000;
const WAVEFORM_REFRESH_INTERVAL_MS = 3000;
const MARKER_COLLAPSE_EPSILON_SECONDS = 0.002;
const MARKER_LABEL_EDGE_THRESHOLD = 0.08;
const MARKER_LABEL_SPACING_THRESHOLD = 0.04;
const MARKER_LABEL_BASE_OFFSET_REM = 0.95;
const MARKER_LABEL_STACK_SPACING_REM = 1.5;
const KEYBOARD_JOG_RATE_SECONDS_PER_SECOND = 4;
const MIN_CLIP_DURATION_SECONDS = 0.05;
const DEFAULT_LIMIT = 200;
const VALID_TIME_RANGES = new Set(["", "1h", "2h", "4h", "8h", "12h", "1d"]);
const MAX_LIMIT = 1000;
const FILTER_STORAGE_KEY = "tricorder.dashboard.filters";
const SORT_STORAGE_KEY = "tricorder.dashboard.sort";
const FILTER_PANEL_STORAGE_KEY = "tricorder.dashboard.filtersPanel";
const CLIPPER_STORAGE_KEY = "tricorder.dashboard.clipper";
const THEME_STORAGE_KEY = "tricorder.dashboard.theme";
const RECYCLE_BIN_STATE_STORAGE_KEY = "tricorder.dashboard.recycleBin";
const WAVEFORM_STORAGE_KEY = "tricorder.dashboard.waveform";
const TRANSPORT_STORAGE_KEY = "tricorder.dashboard.transport";
const COLLECTION_STORAGE_KEY = "tricorder.dashboard.collection";
const TRANSPORT_SCRUB_MAX = 1000;
const TRANSPORT_SKIP_BACK_SECONDS = 10;
const TRANSPORT_SKIP_FORWARD_SECONDS = 30;
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 2;

const STREAM_MODE = (() => {
  if (typeof document === "undefined" || !document.body || !document.body.dataset) {
    return "hls";
  }
  const mode = (document.body.dataset.tricorderStreamMode || "").trim().toLowerCase();
  return mode === "webrtc" ? "webrtc" : "hls";
})();
const DEFAULT_WEBRTC_ICE_SERVERS = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

function normalizeIceServerEntry(entry) {
  if (!entry) {
    return null;
  }
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }
    return { urls: [trimmed] };
  }
  if (typeof entry !== "object") {
    return null;
  }

  const urlsRaw = entry.urls;
  const urls = [];
  if (typeof urlsRaw === "string") {
    const trimmed = urlsRaw.trim();
    if (trimmed) {
      urls.push(trimmed);
    }
  } else if (Array.isArray(urlsRaw)) {
    for (const value of urlsRaw) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          urls.push(trimmed);
        }
      }
    }
  }

  if (urls.length === 0) {
    return null;
  }

  const normalized = { urls };
  if (typeof entry.username === "string") {
    const username = entry.username.trim();
    if (username) {
      normalized.username = username;
    }
  }
  if (typeof entry.credential === "string") {
    const credential = entry.credential.trim();
    if (credential) {
      normalized.credential = credential;
    }
  }
  return normalized;
}

const WEBRTC_ICE_SERVERS = (() => {
  if (typeof document === "undefined" || !document.body || !document.body.dataset) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  const raw = document.body.dataset.tricorderWebrtcIceServers;
  if (!raw) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("Failed to parse WebRTC ICE servers config", error);
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  if (!Array.isArray(parsed)) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  if (parsed.length === 0) {
    return [];
  }
  const normalized = [];
  for (const entry of parsed) {
    const candidate = normalizeIceServerEntry(entry);
    if (candidate) {
      normalized.push(candidate);
    }
  }
  if (normalized.length === 0) {
    console.warn("No valid ICE servers configured; falling back to defaults");
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  return normalized;
})();
const STREAM_BASE = STREAM_MODE === "webrtc" ? "/webrtc" : "/hls";
const HLS_URL = STREAM_MODE === "hls" ? apiPath("/hls/live.m3u8") : "";
const START_ENDPOINT = apiPath(`${STREAM_BASE}/start`);
const STOP_ENDPOINT = apiPath(`${STREAM_BASE}/stop`);
const STATS_ENDPOINT = apiPath(`${STREAM_BASE}/stats`);
const OFFER_ENDPOINT = STREAM_MODE === "webrtc" ? apiPath("/webrtc/offer") : "";
const SERVICES_ENDPOINT = apiPath("/api/services");
const HEALTH_ENDPOINT = apiPath("/api/system-health");
const WEB_SERVER_ENDPOINT = apiPath("/api/config/web-server");
const ARCHIVAL_ENDPOINT = apiPath("/api/config/archival");
const SPLIT_ENDPOINT = apiPath("/api/capture/split");
const MANUAL_RECORD_ENDPOINT = apiPath("/api/capture/manual-record");
const SERVICE_REFRESH_INTERVAL_MS = 5000;
const SERVICE_RESULT_TTL_MS = 15000;
const HEALTH_REFRESH_MIN_INTERVAL_MS = AUTO_REFRESH_INTERVAL_MS;
const CONFIG_REFRESH_INTERVAL_MS = 5000;
const VOICE_RECORDER_SERVICE_UNIT = "voice-recorder.service";
const SESSION_STORAGE_KEY = "tricorder.session";
const WINDOW_NAME_PREFIX = "tricorder.session:";
const ARCHIVAL_BACKENDS = new Set(["network_share", "rsync"]);
const WEB_SERVER_TLS_PROVIDERS = new Set(["letsencrypt", "manual"]);

const state = {
  filters: {
    search: "",
    day: "",
    limit: DEFAULT_LIMIT,
    timeRange: "",
  },
  collection: "recent",
  records: [],
  recordsFingerprint: "",
  partialFingerprint: "",
  total: 0,
  filteredSize: 0,
  offset: 0,
  availableDays: [],
  selections: new Set(),
  selectionAnchor: "",
  selectionFocus: "",
  current: null,
  partialRecord: null,
  captureStatus: null,
  motionState: null,
  lastUpdated: null,
  sort: { key: "modified", direction: "asc" },
  storage: { recordings: 0, recycleBin: 0, total: null, free: null, diskUsed: null },
  recycleBin: {
    open: false,
    items: [],
    selected: new Set(),
    activeId: "",
    loading: false,
    anchorId: "",
  },
};

let pendingSelectionRange = null;

if (typeof window !== "undefined") {
  window.TRICORDER_DASHBOARD_STATE = state;
}

const storedCollection = loadStoredCollection();
if (storedCollection === "saved" || storedCollection === "recent") {
  state.collection = storedCollection;
}

const persistedRecycleBinState = loadPersistedRecycleBinState();
if (persistedRecycleBinState) {
  if (Array.isArray(persistedRecycleBinState.selected) && persistedRecycleBinState.selected.length > 0) {
    state.recycleBin.selected = new Set(
      persistedRecycleBinState.selected.filter((value) => typeof value === "string" && value)
    );
  }
  if (typeof persistedRecycleBinState.activeId === "string" && persistedRecycleBinState.activeId) {
    state.recycleBin.activeId = persistedRecycleBinState.activeId;
  }
  if (typeof persistedRecycleBinState.anchorId === "string" && persistedRecycleBinState.anchorId) {
    state.recycleBin.anchorId = persistedRecycleBinState.anchorId;
  }
}

const healthState = {
  sdCard: null,
  lastUpdated: null,
  resources: {
    cpu: null,
    memory: null,
  },
};

const dom = {
  systemBanner: document.getElementById("system-banner"),
  systemBannerMessage: document.getElementById("system-banner-message"),
  systemBannerDetail: document.getElementById("system-banner-detail"),
  recordingCount: document.getElementById("recording-count"),
  selectedCount: document.getElementById("selected-count"),
  recordingsHeading: document.getElementById("recordings-heading"),
  recordingsTabRecent: document.getElementById("recordings-tab-recent"),
  recordingsTabSaved: document.getElementById("recordings-tab-saved"),
  storageUsageText: document.getElementById("storage-usage-text"),
  storageHint: document.getElementById("storage-hint"),
  storageProgress: document.getElementById("storage-progress-bar"),
  recorderUptimeValue: document.getElementById("recorder-uptime-value"),
  recorderUptimeHint: document.getElementById("recorder-uptime-hint"),
  lastUpdated: document.getElementById("last-updated"),
  tableBody: document.querySelector("#recordings-table tbody"),
  toggleAll: document.getElementById("toggle-all"),
  selectAll: document.getElementById("select-all"),
  clearSelection: document.getElementById("clear-selection"),
  downloadSelected: document.getElementById("download-selected"),
  renameSelected: document.getElementById("rename-selected"),
  deleteSelected: document.getElementById("delete-selected"),
  recycleBinOpen: document.getElementById("open-recycle-bin"),
  recycleBinTotalCount: document.getElementById("recycle-bin-total-count"),
  recycleBinSelectedCount: document.getElementById("recycle-bin-selected-count"),
  refreshIndicator: document.getElementById("refresh-indicator"),
  themeToggle: document.getElementById("theme-toggle"),
  splitEvent: document.getElementById("split-event-trigger"),
  connectionStatus: document.getElementById("connection-status"),
  recordingIndicator: document.getElementById("recording-indicator"),
  recordingIndicatorText: document.getElementById("recording-indicator-text"),
  recordingIndicatorMotion: document.getElementById("recording-indicator-motion"),
  recordingMeta: document.getElementById("recording-meta"),
  recordingMetaText: document.getElementById("recording-meta-text"),
  rmsIndicator: document.getElementById("rms-indicator"),
  rmsIndicatorValue: document.getElementById("rms-indicator-value"),
  encodingStatus: document.getElementById("encoding-status"),
  encodingStatusText: document.getElementById("encoding-status-text"),
  cpuUsage: document.getElementById("cpu-usage-value"),
  cpuLoadAverage: document.getElementById("cpu-load-average"),
  memoryUsage: document.getElementById("memory-usage-value"),
  memoryDetail: document.getElementById("memory-usage-detail"),
  applyFilters: document.getElementById("apply-filters"),
  clearFilters: document.getElementById("clear-filters"),
  filterSearch: document.getElementById("filter-search"),
  filterDay: document.getElementById("filter-day"),
  filterTimeRange: document.getElementById("filter-time-range"),
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
  playerMetaText: document.getElementById("player-meta-text"),
  playerMetaActions: document.getElementById("player-meta-actions"),
  playerDownload: document.getElementById("player-download"),
  playerRename: document.getElementById("player-rename"),
  playerDelete: document.getElementById("player-delete"),
  transportContainer: document.getElementById("player-transport"),
  transportRestart: document.getElementById("transport-restart"),
  transportRewind: document.getElementById("transport-rewind"),
  transportPlay: document.getElementById("transport-play"),
  transportPlayIcon: document.querySelector("#transport-play .transport-button-icon"),
  transportPlayText: document.querySelector("#transport-play .transport-button-text"),
  transportForward: document.getElementById("transport-forward"),
  transportEnd: document.getElementById("transport-end"),
  transportScrubber: document.getElementById("transport-scrubber"),
  transportCurrent: document.getElementById("transport-current"),
  transportDuration: document.getElementById("transport-duration"),
  transportMute: document.getElementById("transport-mute"),
  transportMuteIcon: document.querySelector("#transport-mute .transport-button-icon"),
  transportMuteText: document.querySelector("#transport-mute .transport-button-text"),
  transportVolume: document.getElementById("transport-volume"),
  transportSpeed: document.getElementById("transport-speed-select"),
  playbackSourceGroup: document.getElementById("playback-source-group"),
  playbackSourceProcessed: document.getElementById("playback-source-processed"),
  playbackSourceRaw: document.getElementById("playback-source-raw"),
  playbackSourceActive: document.getElementById("playback-source-active"),
  playbackSourceHint: document.getElementById("playback-source-hint"),
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
  webServerOpen: document.getElementById("web-server-open"),
  webServerModal: document.getElementById("web-server-modal"),
  webServerDialog: document.getElementById("web-server-dialog"),
  webServerClose: document.getElementById("web-server-close"),
  webServerForm: document.getElementById("web-server-form"),
  webServerMode: document.getElementById("web-server-mode"),
  webServerHost: document.getElementById("web-server-host"),
  webServerPort: document.getElementById("web-server-port"),
  webServerTlsProvider: document.getElementById("web-server-tls-provider"),
  webServerLetsEncryptSection: document.getElementById("web-server-letsencrypt-section"),
  webServerManualSection: document.getElementById("web-server-manual-section"),
  webServerLetsEncryptDomains: document.getElementById("web-server-letsencrypt-domains"),
  webServerLetsEncryptEmail: document.getElementById("web-server-letsencrypt-email"),
  webServerLetsEncryptStaging: document.getElementById("web-server-letsencrypt-staging"),
  webServerLetsEncryptHttpPort: document.getElementById("web-server-letsencrypt-http-port"),
  webServerLetsEncryptCacheDir: document.getElementById("web-server-letsencrypt-cache-dir"),
  webServerLetsEncryptCertbot: document.getElementById("web-server-letsencrypt-certbot"),
  webServerLetsEncryptRenewBefore: document.getElementById("web-server-letsencrypt-renew-before"),
  webServerManualCert: document.getElementById("web-server-cert"),
  webServerManualKey: document.getElementById("web-server-key"),
  webServerStatus: document.getElementById("web-server-status"),
  webServerSave: document.getElementById("web-server-save"),
  webServerReset: document.getElementById("web-server-reset"),
  webServerConfigPath: document.getElementById("web-server-config-path"),
  servicesOpen: document.getElementById("services-open"),
  servicesModal: document.getElementById("services-modal"),
  servicesDialog: document.getElementById("services-dialog"),
  servicesBody: document.getElementById("services-dialog-body"),
  servicesClose: document.getElementById("services-close"),
  servicesList: document.getElementById("services-list"),
  servicesEmpty: document.getElementById("services-empty"),
  servicesStatus: document.getElementById("services-status"),
  servicesRefresh: document.getElementById("services-refresh"),
  recycleBinModal: document.getElementById("recycle-bin-modal"),
  recycleBinDialog: document.getElementById("recycle-bin-dialog"),
  recycleBinClose: document.getElementById("recycle-bin-close"),
  recycleBinRefresh: document.getElementById("recycle-bin-refresh"),
  recycleBinRestore: document.getElementById("recycle-bin-restore"),
  recycleBinPurge: document.getElementById("recycle-bin-purge"),
  recycleBinToggleAll: document.getElementById("recycle-bin-toggle-all"),
  recycleBinTableBody: document.getElementById("recycle-bin-tbody"),
  recycleBinEmpty: document.getElementById("recycle-bin-empty"),
  recycleBinTable: document.getElementById("recycle-bin-table"),
  manualToggle: document.getElementById("manual-record-toggle"),
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
  waveformMotionStartMarker: document.getElementById("waveform-motion-start-marker"),
  waveformMotionEndMarker: document.getElementById("waveform-motion-end-marker"),
  waveformReleaseMarker: document.getElementById("waveform-release-marker"),
  waveformEmpty: document.getElementById("waveform-empty"),
  waveformStatus: document.getElementById("waveform-status"),
  waveformZoomInput: document.getElementById("waveform-zoom"),
  waveformZoomValue: document.getElementById("waveform-zoom-value"),
  waveformRmsRow: document.getElementById("waveform-rms-row"),
  waveformRmsValue: document.getElementById("waveform-rms-value"),
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

updateCollectionUI();

const splitEventState = {
  pending: false,
};

const manualRecordState = {
  enabled: false,
  pending: false,
  reason: "",
};

if (dom.splitEvent) {
  dom.splitEvent.dataset.defaultLabel = dom.splitEvent.textContent || "Split Event";
  dom.splitEvent.dataset.pendingLabel = "Splitting…";
  setSplitEventDisabled(true, "Recorder status unavailable.");
}

const recorderDom = {
  menuItems: document.querySelectorAll(".recorder-menu-item"),
  modal: document.getElementById("recorder-settings-modal"),
  dialog: document.getElementById("recorder-settings-dialog"),
  close: document.getElementById("recorder-settings-close"),
  configPath: document.getElementById("recorder-settings-config-path"),
  saveAll: document.getElementById("recorder-save-all"),
  saveAllStatus: document.getElementById("recorder-save-all-status"),
  sections: {
    audio: {
      form: document.getElementById("audio-form"),
      device: document.getElementById("audio-device"),
      sampleRate: document.getElementById("audio-sample-rate"),
      frameMs: document.getElementById("audio-frame-ms"),
      gain: document.getElementById("audio-gain"),
      vad: document.getElementById("audio-vad"),
      filterDenoiseEnabled: document.getElementById("audio-filter-denoise-enabled"),
      filterDenoiseType: document.getElementById("audio-filter-denoise-type"),
      filterDenoiseFloor: document.getElementById("audio-filter-denoise-floor"),
      filterDenoiseFloorDisplay: document.getElementById("audio-filter-denoise-floor-value"),
      filterHighpassEnabled: document.getElementById("audio-filter-highpass-enabled"),
      filterHighpassCutoff: document.getElementById("audio-filter-highpass-cutoff"),
      filterHighpassDisplay: document.getElementById("audio-filter-highpass-cutoff-value"),
      filterLowpassEnabled: document.getElementById("audio-filter-lowpass-enabled"),
      filterLowpassCutoff: document.getElementById("audio-filter-lowpass-cutoff"),
      filterLowpassDisplay: document.getElementById("audio-filter-lowpass-cutoff-value"),
      filterNotchEnabled: document.getElementById("audio-filter-notch-enabled"),
      filterNotchFrequency: document.getElementById("audio-filter-notch-frequency"),
      filterNotchFrequencyDisplay: document.getElementById("audio-filter-notch-frequency-value"),
      filterNotchQuality: document.getElementById("audio-filter-notch-quality"),
      filterNotchQualityDisplay: document.getElementById("audio-filter-notch-quality-value"),
      filterSpectralGateEnabled: document.getElementById("audio-filter-spectral-enabled"),
      filterSpectralGateSensitivity: document.getElementById("audio-filter-spectral-sensitivity"),
      filterSpectralGateSensitivityDisplay: document.getElementById("audio-filter-spectral-sensitivity-value"),
      filterSpectralGateReduction: document.getElementById("audio-filter-spectral-reduction"),
      filterSpectralGateReductionDisplay: document.getElementById("audio-filter-spectral-reduction-value"),
      filterSpectralGateNoiseUpdate: document.getElementById("audio-filter-spectral-update"),
      filterSpectralGateNoiseUpdateDisplay: document.getElementById("audio-filter-spectral-update-value"),
      filterSpectralGateNoiseDecay: document.getElementById("audio-filter-spectral-decay"),
      filterSpectralGateNoiseDecayDisplay: document.getElementById("audio-filter-spectral-decay-value"),
      calibrationNoise: document.getElementById("audio-calibration-noise"),
      calibrationGain: document.getElementById("audio-calibration-gain"),
      calibrateNoiseButton: document.getElementById("audio-calibrate-noise"),
      calibrationNoiseHint: document.getElementById("audio-calibration-noise-hint"),
      save: document.getElementById("audio-save"),
      reset: document.getElementById("audio-reset"),
      status: document.getElementById("audio-status"),
    },
    segmenter: {
      form: document.getElementById("segmenter-form"),
      prePad: document.getElementById("segmenter-pre-pad"),
      postPad: document.getElementById("segmenter-post-pad"),
      motionPaddingMinutes: document.getElementById("segmenter-motion-padding-minutes"),
      threshold: document.getElementById("segmenter-threshold"),
      keepWindow: document.getElementById("segmenter-keep-window"),
      startConsecutive: document.getElementById("segmenter-start-consecutive"),
      keepConsecutive: document.getElementById("segmenter-keep-consecutive"),
      flushBytes: document.getElementById("segmenter-flush-bytes"),
      maxQueue: document.getElementById("segmenter-max-queue"),
      minClipSeconds: document.getElementById("segmenter-min-clip-seconds"),
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
      minRms: document.getElementById("adaptive-min-rms"),
      minThresh: document.getElementById("adaptive-min-thresh"),
      maxRms: document.getElementById("adaptive-max-rms"),
      margin: document.getElementById("adaptive-margin"),
      updateInterval: document.getElementById("adaptive-update-interval"),
      window: document.getElementById("adaptive-window"),
      hysteresis: document.getElementById("adaptive-hysteresis"),
      release: document.getElementById("adaptive-release"),
      voicedHold: document.getElementById("adaptive-voiced-hold"),
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
      modelRefresh: document.getElementById("transcription-model-refresh"),
      modelDiscovery: document.getElementById("transcription-model-discovery"),
      modelOptions: document.getElementById("transcription-model-options"),
      modelApply: document.getElementById("transcription-model-apply"),
      modelDismiss: document.getElementById("transcription-model-dismiss"),
      modelStatus: document.getElementById("transcription-model-status"),
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
let healthRefreshIntervalMs = HEALTH_REFRESH_MIN_INTERVAL_MS;
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

function renderResourceStats() {
  const resources = healthState.resources || {};
  const cpu = resources.cpu ?? null;
  if (dom.cpuUsage) {
    if (cpu && Number.isFinite(cpu.percent)) {
      const clamped = clamp(cpu.percent, 0, 100);
      dom.cpuUsage.textContent = `${clamped.toFixed(clamped >= 100 ? 0 : 1)}%`;
    } else {
      dom.cpuUsage.textContent = "--";
    }
  }
  if (dom.cpuLoadAverage) {
    if (cpu && Number.isFinite(cpu.load1m)) {
      const loadParts = [`load ${cpu.load1m.toFixed(2)}`];
      if (Number.isFinite(cpu.cores) && cpu.cores > 0) {
        const cores = Math.round(cpu.cores);
        loadParts.push(`${cores} ${cores === 1 ? "core" : "cores"}`);
      }
      dom.cpuLoadAverage.textContent = loadParts.join(" • ");
    } else {
      dom.cpuLoadAverage.textContent = "--";
    }
  }
  const memory = resources.memory ?? null;
  if (dom.memoryUsage) {
    if (memory && Number.isFinite(memory.percent)) {
      const percent = clamp(memory.percent, 0, 100);
      dom.memoryUsage.textContent = `${percent.toFixed(percent >= 100 ? 0 : 1)}%`;
    } else {
      dom.memoryUsage.textContent = "--";
    }
  }
  if (dom.memoryDetail) {
    if (memory) {
      const parts = [];
      if (Number.isFinite(memory.usedBytes) && Number.isFinite(memory.totalBytes)) {
        parts.push(`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`);
      } else if (Number.isFinite(memory.totalBytes)) {
        parts.push(`${formatBytes(memory.totalBytes)} total`);
      }
      if (Number.isFinite(memory.availableBytes)) {
        parts.push(`${formatBytes(memory.availableBytes)} free`);
      }
      dom.memoryDetail.textContent = parts.length ? parts.join(" • ") : "--";
    } else {
      dom.memoryDetail.textContent = "--";
    }
  }
}

function formatRecorderUptimeValue(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function formatRecorderUptimeHint(startEpoch) {
  if (!Number.isFinite(startEpoch)) {
    return "";
  }
  try {
    return `since ${dateFormatter.format(new Date(startEpoch * 1000))}`;
  } catch (error) {
    console.warn("Unable to format recorder uptime start", error);
  }
  return "";
}

function stopRecorderUptimeTimer() {
  if (recorderUptimeState.timerId && typeof window !== "undefined") {
    window.clearInterval(recorderUptimeState.timerId);
    recorderUptimeState.timerId = null;
  }
}

function ensureRecorderUptimeTimer() {
  if (recorderUptimeState.timerId || typeof window === "undefined") {
    return;
  }
  recorderUptimeState.timerId = window.setInterval(() => {
    if (!recorderUptimeState.active) {
      stopRecorderUptimeTimer();
      return;
    }
    renderRecorderUptime();
  }, 1000);
}

function renderRecorderUptime() {
  if (!dom.recorderUptimeValue) {
    return;
  }
  let valueText = recorderUptimeState.statusText || "--";
  let hintText = recorderUptimeState.hint || "";
  if (recorderUptimeState.active && Number.isFinite(recorderUptimeState.startEpoch)) {
    const now = Date.now() / 1000;
    const uptimeSeconds = Math.max(0, now - recorderUptimeState.startEpoch);
    valueText = formatRecorderUptimeValue(uptimeSeconds);
    hintText = formatRecorderUptimeHint(recorderUptimeState.startEpoch);
  }
  dom.recorderUptimeValue.textContent = valueText;
  if (dom.recorderUptimeHint) {
    if (hintText) {
      dom.recorderUptimeHint.textContent = hintText;
      dom.recorderUptimeHint.hidden = false;
    } else {
      dom.recorderUptimeHint.textContent = "";
      dom.recorderUptimeHint.hidden = true;
    }
  }
}

function setRecorderUptimeStatus(statusText, options = {}) {
  const { available = false, hint = "" } = options;
  recorderUptimeState.active = false;
  recorderUptimeState.available = Boolean(available);
  recorderUptimeState.startEpoch = null;
  recorderUptimeState.statusText = statusText || "--";
  recorderUptimeState.hint = hint || "";
  stopRecorderUptimeTimer();
  renderRecorderUptime();
}

function setRecorderUptimeActive(startEpoch) {
  if (!Number.isFinite(startEpoch) || startEpoch <= 0) {
    setRecorderUptimeStatus("Running", { available: true });
    return;
  }
  recorderUptimeState.available = true;
  recorderUptimeState.active = true;
  recorderUptimeState.startEpoch = startEpoch;
  recorderUptimeState.statusText = "";
  recorderUptimeState.hint = "";
  renderRecorderUptime();
  ensureRecorderUptimeTimer();
}

function updateRecorderUptimeFromServices() {
  const voiceService = servicesState.items.find(
    (item) => item.unit === VOICE_RECORDER_SERVICE_UNIT,
  );
  if (!voiceService) {
    setRecorderUptimeStatus("Unavailable");
    return;
  }
  if (voiceService.available === false) {
    const hint = voiceService.error || voiceService.status_text || "";
    setRecorderUptimeStatus("Unavailable", { hint });
    return;
  }
  if (!voiceService.is_active) {
    const hint = voiceService.status_text || "";
    setRecorderUptimeStatus("Stopped", { available: true, hint });
    return;
  }
  if (Number.isFinite(voiceService.activeEnterEpoch)) {
    setRecorderUptimeActive(voiceService.activeEnterEpoch);
    return;
  }
  const hint = voiceService.status_text || "";
  setRecorderUptimeStatus("Running", { available: true, hint });
}

function applyHealthPayload(payload) {
  if (!payload || typeof payload !== "object") {
    healthState.sdCard = null;
    healthState.lastUpdated = null;
    healthState.resources.cpu = null;
    healthState.resources.memory = null;
    renderSdCardBanner();
    renderResourceStats();
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

  const resources = payload.resources;
  if (resources && typeof resources === "object") {
    const cpu = resources.cpu;
    if (cpu && typeof cpu === "object") {
      healthState.resources.cpu = {
        percent: toFiniteOrNull(cpu.percent),
        load1m: toFiniteOrNull(cpu.load_1m ?? cpu.load1m),
        cores: Number.isFinite(cpu.cores) ? cpu.cores : null,
      };
    } else {
      healthState.resources.cpu = null;
    }

    const memory = resources.memory;
    if (memory && typeof memory === "object") {
      healthState.resources.memory = {
        percent: toFiniteOrNull(memory.percent),
        totalBytes: toFiniteOrNull(memory.total_bytes),
        usedBytes: toFiniteOrNull(memory.used_bytes),
        availableBytes: toFiniteOrNull(memory.available_bytes),
      };
    } else {
      healthState.resources.memory = null;
    }
  } else {
    healthState.resources.cpu = null;
    healthState.resources.memory = null;
  }

  renderSdCardBanner();
  renderResourceStats();
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
    ensureOfflineStateOnError(error);
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
  healthRefreshId = window.setInterval(
    fetchSystemHealth,
    healthRefreshIntervalMs
  );
}

function stopHealthRefresh() {
  if (healthRefreshId !== null) {
    window.clearInterval(healthRefreshId);
    healthRefreshId = null;
  }
}

function restartHealthRefresh() {
  if (healthRefreshId === null) {
    return;
  }
  startHealthRefresh();
}

function setHealthRefreshInterval(intervalMs) {
  const clamped = Math.max(intervalMs, HEALTH_REFRESH_MIN_INTERVAL_MS);
  if (healthRefreshIntervalMs === clamped) {
    return;
  }
  healthRefreshIntervalMs = clamped;
  restartHealthRefresh();
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
let recordingsRefreshDeferred = false;
const hoveredInteractiveElements = new Set();

const INTERACTIVE_ROLE_NAMES = new Set([
  "button",
  "checkbox",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

function isInteractiveFormField(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  const role = element.getAttribute("role");
  if (role && INTERACTIVE_ROLE_NAMES.has(role)) {
    return true;
  }

  const tagName = element.tagName;
  if (tagName === "AUDIO" || tagName === "VIDEO") {
    return true;
  }
  if (tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (tagName === "BUTTON") {
    return true;
  }

  if (tagName === "INPUT") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "hidden") {
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

function escapeSelector(value) {
  const text = String(value);
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(text);
  }
  return text.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

let pendingSelectionPath = null;
const renameDialogState = {
  open: false,
  target: null,
  pending: false,
  previouslyFocused: null,
};

const WAVEFORM_ZOOM_DEFAULT = 1;
const WAVEFORM_ZOOM_MIN = 0.25;
const WAVEFORM_ZOOM_MAX = 10;

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
  motionTriggerSeconds: null,
  motionReleaseSeconds: null,
  peakScale: 32767,
  startEpoch: null,
  rmsValues: null,
  refreshTimer: null,
  refreshRecordPath: "",
  amplitudeScale: WAVEFORM_ZOOM_DEFAULT,
};

function getPlayerDurationSeconds() {
  if (!dom.player) {
    return Number.NaN;
  }

  const nativeDuration = Number(dom.player.duration);
  if (Number.isFinite(nativeDuration) && nativeDuration > 0) {
    return nativeDuration;
  }

  const seekable = dom.player.seekable;
  if (seekable && typeof seekable.length === "number" && seekable.length > 0) {
    try {
      const end = seekable.end(seekable.length - 1);
      if (Number.isFinite(end) && end > 0) {
        return end;
      }
    } catch (error) {
      /* ignore seekable errors */
    }
  }

  if (Number.isFinite(waveformState.duration) && waveformState.duration > 0) {
    return waveformState.duration;
  }

  const record = state.current;
  if (record && record.duration_seconds !== undefined) {
    const recordDuration = Number(record.duration_seconds);
    if (Number.isFinite(recordDuration) && recordDuration > 0) {
      return recordDuration;
    }
  }

  return Number.NaN;
}

function clampVolume(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return clamp(value, 0, 1);
}

function clampPlaybackRateValue(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return clamp(value, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
}

function formatTransportClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
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

function formatPlaybackRateLabel(value) {
  const normalized = clampPlaybackRateValue(value);
  if (Number.isInteger(normalized)) {
    return `${normalized}×`;
  }
  const formatted = normalized.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}×`;
}

function loadTransportPreferences() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(TRANSPORT_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    transportPreferences.volume = 1;
    transportPreferences.muted = false;
    if (Number.isFinite(parsed.playbackRate)) {
      transportPreferences.playbackRate = clampPlaybackRateValue(parsed.playbackRate);
    }
  } catch (error) {
    console.warn("Unable to restore transport preferences", error);
  }
}

function persistTransportPreferences() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const payload = {
      volume: 1,
      muted: false,
      playbackRate: clampPlaybackRateValue(
        dom.player ? dom.player.playbackRate : transportPreferences.playbackRate,
      ),
    };
    window.localStorage.setItem(TRANSPORT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Unable to persist transport preferences", error);
  }
}

function applyTransportPreferences() {
  if (!dom.player) {
    return;
  }
  transportPreferences.volume = 1;
  transportPreferences.muted = false;
  dom.player.volume = 1;
  dom.player.muted = false;
  dom.player.playbackRate = clampPlaybackRateValue(transportPreferences.playbackRate);
  transportState.lastUserVolume = 1;
}

function ensureTransportRateOption(rate) {
  if (!dom.transportSpeed) {
    return;
  }
  const normalized = clampPlaybackRateValue(rate);
  const existing = Array.from(dom.transportSpeed.options || []).find((option) => {
    return Number.parseFloat(option.value) === normalized;
  });
  if (existing) {
    return;
  }
  const option = document.createElement("option");
  option.value = normalized.toString();
  option.textContent = formatPlaybackRateLabel(normalized);
  dom.transportSpeed.append(option);
}

function setTransportActive(active) {
  if (!dom.transportContainer) {
    return;
  }
  dom.transportContainer.hidden = !active;
  dom.transportContainer.dataset.active = active ? "true" : "false";
  if (!active) {
    dom.transportContainer.removeAttribute("data-ready");
  }
}

function setTransportControlsDisabled(disabled) {
  const controls = [
    dom.transportRestart,
    dom.transportRewind,
    dom.transportPlay,
    dom.transportForward,
    dom.transportEnd,
    dom.transportMute,
    dom.transportVolume,
    dom.transportSpeed,
  ];
  for (const control of controls) {
    if (!control) {
      continue;
    }
    control.disabled = disabled;
    if (disabled) {
      control.setAttribute("aria-disabled", "true");
    } else {
      control.removeAttribute("aria-disabled");
    }
  }
}

function resetTransportUi() {
  transportState.scrubbing = false;
  transportState.scrubWasPlaying = false;
  if (dom.transportScrubber) {
    dom.transportScrubber.value = "0";
    dom.transportScrubber.disabled = true;
    dom.transportScrubber.setAttribute("aria-valuemin", "0");
    dom.transportScrubber.setAttribute("aria-valuemax", TRANSPORT_SCRUB_MAX.toString());
    dom.transportScrubber.setAttribute("aria-valuenow", "0");
    dom.transportScrubber.setAttribute("aria-valuetext", "0:00");
  }
  if (dom.transportCurrent) {
    dom.transportCurrent.textContent = "0:00";
  }
  if (dom.transportDuration) {
    dom.transportDuration.textContent = "0:00";
  }
  setTransportControlsDisabled(true);
  updateTransportPlayState();
  updateTransportVolumeUI();
  updateTransportSpeedUI();
}

function updateTransportAvailability() {
  if (!dom.transportContainer) {
    return;
  }
  const active = Boolean(state.current);
  setTransportActive(active);
  if (!active) {
    resetTransportUi();
    return;
  }
  const ready = hasPlayableSource(dom.player);
  dom.transportContainer.dataset.ready = ready ? "true" : "false";
  setTransportControlsDisabled(!ready);
  if (dom.transportScrubber) {
    dom.transportScrubber.disabled = !ready;
  }
  updateTransportPlayState();
  updateTransportProgressUI();
  updateTransportVolumeUI();
  updateTransportSpeedUI();
}

function updateTransportPlayState() {
  if (!dom.transportPlay) {
    return;
  }
  const ready = Boolean(state.current) && hasPlayableSource(dom.player);
  const playing = ready && dom.player && !dom.player.paused && !dom.player.ended;
  dom.transportPlay.disabled = !ready;
  dom.transportPlay.setAttribute("aria-pressed", playing ? "true" : "false");
  const label = playing ? "Pause" : "Play";
  dom.transportPlay.setAttribute("aria-label", label);
  if (dom.transportPlayText) {
    dom.transportPlayText.textContent = label;
  } else {
    dom.transportPlay.textContent = label;
  }
  if (dom.transportPlayIcon) {
    dom.transportPlayIcon.textContent = playing ? "⏸" : "▶";
  }
}

function scrubValueToSeconds(value, duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const fraction = clamp(numeric / TRANSPORT_SCRUB_MAX, 0, 1);
  return duration * fraction;
}

function updateTransportProgressUI() {
  if (!dom.transportScrubber || !dom.transportCurrent || !dom.transportDuration) {
    return;
  }
  const ready = Boolean(state.current) && hasPlayableSource(dom.player);
  const duration = ready ? getPlayerDurationSeconds() : Number.NaN;
  if (!Number.isFinite(duration) || duration <= 0) {
    dom.transportScrubber.disabled = true;
    if (!transportState.scrubbing) {
      dom.transportScrubber.value = "0";
    }
    dom.transportScrubber.setAttribute("aria-valuemin", "0");
    dom.transportScrubber.setAttribute("aria-valuemax", TRANSPORT_SCRUB_MAX.toString());
    dom.transportScrubber.setAttribute("aria-valuenow", "0");
    dom.transportScrubber.setAttribute("aria-valuetext", "0:00");
    dom.transportCurrent.textContent = "0:00";
    dom.transportDuration.textContent = ready ? "0:00" : "0:00";
    return;
  }

  dom.transportScrubber.disabled = !ready;
  const currentTime = Number.isFinite(dom.player.currentTime)
    ? clamp(dom.player.currentTime, 0, duration)
    : 0;
  const fraction = clamp(currentTime / duration, 0, 1);
  const sliderValue = Math.round(fraction * TRANSPORT_SCRUB_MAX);
  if (!transportState.scrubbing) {
    dom.transportScrubber.value = sliderValue.toString();
  }
  dom.transportScrubber.setAttribute("aria-valuemin", "0");
  dom.transportScrubber.setAttribute("aria-valuemax", TRANSPORT_SCRUB_MAX.toString());
  const displaySeconds = transportState.scrubbing
    ? scrubValueToSeconds(dom.transportScrubber.value, duration)
    : currentTime;
  const ariaValue = transportState.scrubbing
    ? dom.transportScrubber.value
    : sliderValue.toString();
  dom.transportScrubber.setAttribute("aria-valuenow", ariaValue);
  const formattedCurrent = formatTransportClock(displaySeconds);
  dom.transportScrubber.setAttribute("aria-valuetext", formattedCurrent);
  dom.transportCurrent.textContent = formattedCurrent;
  dom.transportDuration.textContent = formatTransportClock(duration);
}

function updateTransportVolumeUI() {
  if (!dom.transportVolume && !dom.transportMute) {
    return;
  }
  const ready = Boolean(state.current) && hasPlayableSource(dom.player);
  const volume = dom.player ? clampVolume(dom.player.volume) : transportPreferences.volume;
  const muted = dom.player ? Boolean(dom.player.muted) : transportPreferences.muted;
  if (dom.transportVolume) {
    const sliderValue = Math.round(volume * 100);
    dom.transportVolume.value = sliderValue.toString();
    dom.transportVolume.disabled = !ready;
    dom.transportVolume.setAttribute("aria-valuenow", sliderValue.toString());
    dom.transportVolume.setAttribute("aria-valuetext", `${sliderValue}%`);
  }
  if (dom.transportMute) {
    dom.transportMute.disabled = !ready;
    const effectiveMuted = muted || volume === 0;
    dom.transportMute.setAttribute("aria-pressed", effectiveMuted ? "true" : "false");
    if (dom.transportMuteText) {
      dom.transportMuteText.textContent = effectiveMuted ? "Unmute" : "Mute";
    } else {
      dom.transportMute.textContent = effectiveMuted ? "Unmute" : "Mute";
    }
    if (dom.transportMuteIcon) {
      dom.transportMuteIcon.textContent = effectiveMuted ? "🔇" : "🔊";
    }
  }
}

function updateTransportSpeedUI() {
  if (!dom.transportSpeed) {
    return;
  }
  const ready = Boolean(state.current) && hasPlayableSource(dom.player);
  const playbackRate = dom.player
    ? clampPlaybackRateValue(dom.player.playbackRate)
    : transportPreferences.playbackRate;
  ensureTransportRateOption(playbackRate);
  dom.transportSpeed.value = playbackRate.toString();
  dom.transportSpeed.disabled = !ready;
}

function beginTransportScrub() {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  if (!transportState.scrubbing) {
    transportState.scrubbing = true;
    transportState.scrubWasPlaying = !dom.player.paused && !dom.player.ended;
    if (transportState.scrubWasPlaying) {
      try {
        dom.player.pause();
      } catch (error) {
        /* ignore pause errors */
      }
    }
  }
}

function commitTransportScrub() {
  if (!transportState.scrubbing) {
    return;
  }
  transportState.scrubbing = false;
  const duration = getPlayerDurationSeconds();
  if (dom.player && Number.isFinite(duration) && duration > 0 && dom.transportScrubber) {
    const nextSeconds = scrubValueToSeconds(dom.transportScrubber.value, duration);
    try {
      dom.player.currentTime = nextSeconds;
    } catch (error) {
      /* ignore seek errors */
    }
  }
  const shouldResume = transportState.scrubWasPlaying;
  transportState.scrubWasPlaying = false;
  updateTransportProgressUI();
  if (shouldResume && dom.player) {
    dom.player.play().catch(() => undefined);
  }
}

function skipTransportBy(offsetSeconds) {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  const duration = getPlayerDurationSeconds();
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  const currentTime = Number.isFinite(dom.player.currentTime) ? dom.player.currentTime : 0;
  const nextTime = clamp(currentTime + offsetSeconds, 0, duration);
  try {
    dom.player.currentTime = nextTime;
  } catch (error) {
    /* ignore seek errors */
  }
  updateTransportProgressUI();
}

function restartTransport() {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  const wasPlaying = !dom.player.paused && !dom.player.ended;
  try {
    dom.player.currentTime = 0;
  } catch (error) {
    /* ignore seek errors */
  }
  updateTransportProgressUI();
  if (wasPlaying) {
    dom.player.play().catch(() => undefined);
  }
}

function jumpToTransportEnd() {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  const duration = getPlayerDurationSeconds();
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  try {
    dom.player.currentTime = duration;
  } catch (error) {
    /* ignore seek errors */
  }
  updateTransportProgressUI();
}

function rememberLastUserVolume(volume) {
  const normalized = clampVolume(volume);
  if (normalized > 0) {
    transportState.lastUserVolume = normalized;
  }
}

function handleTransportMuteToggle() {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  const currentlyMuted = dom.player.muted || dom.player.volume === 0;
  if (currentlyMuted) {
    dom.player.muted = false;
    const restoreVolume = transportState.lastUserVolume > 0 ? transportState.lastUserVolume : 1;
    dom.player.volume = clampVolume(restoreVolume);
  } else {
    rememberLastUserVolume(dom.player.volume);
    dom.player.muted = true;
  }
}

function handleTransportVolumeInput(event) {
  if (!dom.player || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  const percent = Number.parseInt(event.target.value, 10);
  if (!Number.isFinite(percent)) {
    return;
  }
  const volume = clampVolume(percent / 100);
  if (volume > 0) {
    dom.player.muted = false;
    dom.player.volume = volume;
  } else {
    dom.player.volume = 0;
    dom.player.muted = true;
  }
}

function handleTransportSpeedChange(event) {
  if (!dom.player || !(event.target instanceof HTMLSelectElement)) {
    return;
  }
  const rate = clampPlaybackRateValue(Number.parseFloat(event.target.value));
  dom.player.playbackRate = rate;
}

function handleTransportPlayToggle() {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  if (dom.player.paused || dom.player.ended) {
    dom.player.play().catch(() => undefined);
  } else {
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }
  }
}

function handleTransportScrubberInput() {
  if (!dom.player || !dom.transportScrubber || !hasPlayableSource(dom.player)) {
    return;
  }
  beginTransportScrub();
  updateTransportProgressUI();
}

function handleTransportScrubberCommit() {
  commitTransportScrub();
}

function handleTransportScrubberPointerDown() {
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return;
  }
  beginTransportScrub();
}

function handleTransportScrubberPointerUp() {
  handleTransportScrubberCommit();
}

function handleTransportScrubberBlur() {
  if (transportState.scrubbing) {
    handleTransportScrubberCommit();
  }
}

function handlePlayerVolumeChange() {
  if (!dom.player) {
    return;
  }
  const volume = clampVolume(dom.player.volume);
  const muted = Boolean(dom.player.muted);
  if (!muted && volume > 0) {
    rememberLastUserVolume(volume);
  }
  transportPreferences.volume = volume;
  transportPreferences.muted = muted;
  updateTransportVolumeUI();
  persistTransportPreferences();
}

function handlePlayerRateChange() {
  if (!dom.player) {
    return;
  }
  const rate = clampPlaybackRateValue(dom.player.playbackRate);
  transportPreferences.playbackRate = rate;
  updateTransportSpeedUI();
  persistTransportPreferences();
}

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

const playbackSourceState = {
  mode: "processed",
  hasRaw: false,
  rawPath: "",
  recordPath: "",
  pendingSeek: null,
  pendingPlay: false,
  suppressTransportReset: false,
};

const transportState = {
  keys: new Set(),
  direction: 0,
  animationFrame: null,
  lastTimestamp: null,
  wasPlaying: false,
  isJogging: false,
  scrubbing: false,
  scrubWasPlaying: false,
  lastUserVolume: 1,
};

const transportPreferences = {
  volume: 1,
  muted: false,
  playbackRate: 1,
};

const PLAYBACK_SOURCE_LABELS = {
  processed: "Processed (Opus)",
  raw: "Raw capture (PCM)",
};

const focusState = {
  previewPointer: false,
  livePointer: false,
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
  recycleBinRowElement: null,
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

function readStoredFilterPanelPreference() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(FILTER_PANEL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.expanded === "boolean") {
      return parsed.expanded;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function persistFilterPanelPreference(expanded) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    window.localStorage.setItem(
      FILTER_PANEL_STORAGE_KEY,
      JSON.stringify({ expanded: Boolean(expanded) })
    );
  } catch (error) {
    /* ignore persistence errors */
  }
}

function restoreFilterPanelPreference() {
  const stored = readStoredFilterPanelPreference();
  if (typeof stored !== "boolean") {
    return;
  }
  filtersLayoutState.expanded = stored;
  filtersLayoutState.userOverride = true;
  if (dom.filtersPanel) {
    dom.filtersPanel.dataset.state = stored ? "expanded" : "collapsed";
  }
}

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

const recorderUptimeState = {
  active: false,
  available: false,
  startEpoch: null,
  statusText: "Loading…",
  hint: "",
  timerId: null,
};

const webServerState = {
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

const recorderSaveAllState = {
  saving: false,
  statusTimeoutId: null,
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

const webServerDialogState = {
  open: false,
  previouslyFocused: null,
  keydownHandler: null,
};

const recycleBinDialogState = {
  open: false,
  previouslyFocused: null,
  keydownHandler: null,
  previewing: false,
  previousRecord: null,
};


const transcriptionModelState = {
  loading: false,
  models: [],
};


const connectionState = {
  offline: false,
};

const captureIndicatorState = {
  state: "unknown",
  message: "",
  motion: false,
};

const rmsIndicatorState = {
  visible: false,
  value: null,
  threshold: null,
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
  activeCount: 0,
  additionalActive: 0,
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

function loadStoredCollection() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(COLLECTION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "saved" || normalized === "recent") {
      return normalized;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function persistCollection() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    window.localStorage.setItem(COLLECTION_STORAGE_KEY, state.collection);
  } catch (error) {
    /* ignore persistence errors */
  }
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
      timeRange: state.filters.timeRange,
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

function readStoredSortPreference() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
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

function persistSortPreference() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    const direction = state.sort.direction === "desc" ? "desc" : "asc";
    const payload = {
      key: state.sort.key,
      direction,
    };
    window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore persistence errors */
  }
}

function restoreSortFromStorage() {
  const stored = readStoredSortPreference();
  if (!stored) {
    return;
  }
  const validKeys = new Set(
    dom.sortButtons
      .map((button) => (button.dataset.sortKey ?? "").trim())
      .filter((value) => value)
  );
  const candidateKey =
    typeof stored.key === "string" && stored.key.trim() ? stored.key.trim() : "";
  if (candidateKey && validKeys.has(candidateKey)) {
    state.sort.key = candidateKey;
  }
  const candidateDirection =
    typeof stored.direction === "string" ? stored.direction.toLowerCase() : "";
  if (candidateDirection === "asc" || candidateDirection === "desc") {
    state.sort.direction = candidateDirection;
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
    timeRange: state.filters.timeRange,
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
  if (typeof stored.timeRange === "string" && VALID_TIME_RANGES.has(stored.timeRange)) {
    next.timeRange = stored.timeRange;
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
  if (fromUser) {
    persistFilterPanelPreference(expanded);
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
  if (autoRefreshSuspended || autoRefreshId || state.recycleBin.open) {
    return;
  }
  autoRefreshId = window.setInterval(() => {
    if (state.recycleBin.open) {
      recordingsRefreshDeferred = true;
      return;
    }
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
    setHealthRefreshInterval(clamped);
    return;
  }
  autoRefreshIntervalMs = clamped;
  restartAutoRefresh();
  setHealthRefreshInterval(clamped);
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
  if (state.recycleBin.open || hoveredInteractiveElements.size > 0) {
    return;
  }
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

function applyRecordingIndicator(state, message, { motion = false } = {}) {
  if (!dom.recordingIndicator || !dom.recordingIndicatorText) {
    return;
  }
  if (
    captureIndicatorState.state === state &&
    captureIndicatorState.message === message &&
    captureIndicatorState.motion === motion
  ) {
    return;
  }
  captureIndicatorState.state = state;
  captureIndicatorState.message = message;
  captureIndicatorState.motion = motion;
  dom.recordingIndicator.dataset.state = state;
  dom.recordingIndicatorText.textContent = message;
  dom.recordingIndicator.setAttribute("aria-hidden", "false");
  if (dom.recordingIndicatorMotion) {
    dom.recordingIndicatorMotion.hidden = !motion;
  }
}

function setRecordingIndicatorUnknown(message = "Status unavailable") {
  applyRecordingIndicator("unknown", message, { motion: false });
  hideRmsIndicator();
  hideRecordingMeta();
  hideEncodingStatus();
  setSplitEventDisabled(true, "Recorder status unavailable.");
}

function setRecordingIndicatorStatus(rawStatus, motionSnapshot = null) {
  if (!dom.recordingIndicator || !dom.recordingIndicatorText) {
    return;
  }
  if (!rawStatus || typeof rawStatus !== "object") {
    setRecordingIndicatorUnknown();
    return;
  }
  const event = rawStatus && typeof rawStatus.event === "object" ? rawStatus.event : null;
  let capturing = Boolean(rawStatus.capturing);
  if (!capturing && event && parseBoolean(event.in_progress)) {
    capturing = true;
  }
  const manualRecording = parseBoolean(rawStatus.manual_recording);
  const motionTriggered = capturing && !manualRecording && isMotionTriggeredEvent(event);
  const motionState =
    motionSnapshot && typeof motionSnapshot === "object"
      ? motionSnapshot
      : state.motionState;
  let liveMotion = null;
  if (motionState && Object.prototype.hasOwnProperty.call(motionState, "motion_active")) {
    const parsedMotion = parseMotionFlag(motionState.motion_active);
    if (parsedMotion !== null) {
      liveMotion = parsedMotion;
    }
  }
  if (
    liveMotion === null &&
    rawStatus &&
    typeof rawStatus === "object" &&
    Object.prototype.hasOwnProperty.call(rawStatus, "motion_active")
  ) {
    const parsedMotion = parseMotionFlag(rawStatus.motion_active);
    if (parsedMotion !== null) {
      liveMotion = parsedMotion;
    }
  }
  const indicatorMotion = liveMotion === null ? motionTriggered : liveMotion;
  const rawStopReason =
    typeof rawStatus.last_stop_reason === "string"
      ? rawStatus.last_stop_reason.trim()
      : "";
  const normalizedStopReason = rawStopReason.toLowerCase();
  const disabled = !capturing && normalizedStopReason === "shutdown";
  const indicatorState = capturing ? "active" : disabled ? "disabled" : "idle";
  let message;

  if (dom.recordingIndicator) {
    dom.recordingIndicator.dataset.manual = manualRecording ? "true" : "false";
  }

  if (capturing) {
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
    if (manualRecording) {
      message = startedLabel
        ? `Manual recording active since ${startedLabel}`
        : "Manual recording active";
    } else {
      message = startedLabel
        ? `Recording active since ${startedLabel}`
        : "Recording active";
    }
    if (detail) {
      message += ` • ${detail}`;
    }
  } else {
    if (manualRecording) {
      message = "Manual recording enabled";
    } else {
      message = disabled ? "Recording disabled" : "Recording idle";
    }
    const lastEvent = rawStatus.last_event;
    let detail = "";
    if (lastEvent && typeof lastEvent === "object") {
      const startedEpoch = toFiniteOrNull(lastEvent.started_epoch);
      const endedEpoch = toFiniteOrNull(lastEvent.ended_epoch);
      if (startedEpoch !== null) {
        const startedDate = new Date(startedEpoch * 1000);
        detail = `Last ${dateFormatter.format(startedDate)}`;
      } else if (typeof lastEvent.started_at === "string" && lastEvent.started_at) {
        detail = `Last ${lastEvent.started_at}`;
      } else if (endedEpoch !== null) {
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

  applyRecordingIndicator(indicatorState, message, { motion: indicatorMotion });
}

function setSplitEventDisabled(disabled, reason = "") {
  if (!dom.splitEvent) {
    return;
  }
  const button = dom.splitEvent;
  const nextDisabled = Boolean(disabled) || splitEventState.pending;
  if (button.disabled !== nextDisabled) {
    button.disabled = nextDisabled;
  }
  if (nextDisabled) {
    const message = splitEventState.pending ? "Split request in progress." : reason;
    if (message) {
      button.title = message;
    } else {
      button.removeAttribute("title");
    }
    button.setAttribute("aria-disabled", "true");
  } else {
    button.removeAttribute("title");
    button.removeAttribute("aria-disabled");
  }
}

function updateSplitEventButton(rawStatus) {
  if (!dom.splitEvent) {
    return;
  }
  if (splitEventState.pending) {
    setSplitEventDisabled(true, "Split request in progress.");
    return;
  }

  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : state.captureStatus;
  if (!status || typeof status !== "object") {
    setSplitEventDisabled(true, "Recorder status unavailable.");
    return;
  }

  const serviceRunning = parseBoolean(status.service_running);
  if (!serviceRunning) {
    setSplitEventDisabled(true, "Recorder service offline.");
    return;
  }

  const event = status.event && typeof status.event === "object" ? status.event : null;
  let capturing = Boolean(status.capturing);
  if (!capturing && event && parseBoolean(event.in_progress)) {
    capturing = true;
  }

  if (!capturing) {
    setSplitEventDisabled(true, "Recorder idle.");
    return;
  }

  if (!event) {
    setSplitEventDisabled(true, "Active event details unavailable.");
    return;
  }

  setSplitEventDisabled(false);
}

function setSplitEventPending(pending) {
  const nextPending = Boolean(pending);
  if (splitEventState.pending === nextPending) {
    return;
  }
  splitEventState.pending = nextPending;
  if (!dom.splitEvent) {
    return;
  }
  if (nextPending) {
    const label = dom.splitEvent.dataset.pendingLabel || "Splitting…";
    dom.splitEvent.textContent = label;
    dom.splitEvent.setAttribute("aria-busy", "true");
    setSplitEventDisabled(true, "Split request in progress.");
  } else {
    const label = dom.splitEvent.dataset.defaultLabel || "Split Event";
    dom.splitEvent.textContent = label;
    dom.splitEvent.removeAttribute("aria-busy");
    updateSplitEventButton(state.captureStatus);
  }
}

async function requestSplitEvent() {
  if (!dom.splitEvent || splitEventState.pending || dom.splitEvent.disabled) {
    return;
  }
  setSplitEventPending(true);
  try {
    const response = await fetch(SPLIT_ENDPOINT, { method: "POST" });
    if (!response.ok) {
      let message = `Split request failed (status ${response.status})`;
      try {
        const errorPayload = await response.json();
        if (errorPayload && typeof errorPayload === "object") {
          if (typeof errorPayload.reason === "string" && errorPayload.reason) {
            message = errorPayload.reason;
          } else if (typeof errorPayload.error === "string" && errorPayload.error) {
            message = errorPayload.error;
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
    await fetchRecordings({ silent: true });
  } catch (error) {
    console.error("Split event request failed", error);
    const message = error instanceof Error && error.message ? error.message : "Unable to split event.";
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
    }
  } finally {
    setSplitEventPending(false);
  }
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
  const event = status && typeof status.event === "object" ? status.event : null;
  let capturing = status ? Boolean(status.capturing) : false;
  if (!capturing && event && parseBoolean(event.in_progress)) {
    capturing = true;
  }
  if (!capturing) {
    hideRecordingMeta();
    return;
  }
  const durationSeconds = status ? toFiniteOrNull(status.event_duration_seconds) : null;
  const sizeBytes = status ? toFiniteOrNull(status.event_size_bytes) : null;
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
    const activeCount = Math.max(1, encodingStatusState.activeCount || 0);
    let statusLabel = sourceLabel ? `Encoding active (${sourceLabel})` : "Encoding active";
    if (activeCount > 1) {
      statusLabel = `${statusLabel} (${activeCount} jobs)`;
    }
    parts.push(statusLabel);
    if (encodingStatusState.activeLabel) {
      parts.push(encodingStatusState.activeLabel);
    }
    parts.push(formatShortDuration(durationSeconds));
    if (encodingStatusState.additionalActive > 0) {
      parts.push(`+${encodingStatusState.additionalActive} more active`);
    }
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
  encodingStatusState.activeCount = 0;
  encodingStatusState.additionalActive = 0;
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
  const rawActive = encoding ? encoding.active : null;
  let activeList = [];
  if (Array.isArray(rawActive)) {
    activeList = rawActive.filter((item) => item && typeof item === "object");
  } else if (rawActive && typeof rawActive === "object") {
    activeList = [rawActive];
  }
  const active = activeList.length > 0 ? activeList[0] : null;

  if ((!pending || pending.length === 0) && activeList.length === 0) {
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

  encodingStatusState.activeCount = activeList.length;
  encodingStatusState.additionalActive = Math.max(0, activeList.length - 1);

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
  rmsIndicatorState.threshold = null;
}

function updateRmsIndicator(rawStatus) {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const running = status ? parseBoolean(status.service_running) : false;
  const rmsValue = status ? toFiniteOrNull(status.current_rms) : null;
  const adaptiveThreshold = status ? toFiniteOrNull(status.adaptive_rms_threshold) : null;
  const adaptiveEnabled = status ? parseBoolean(status.adaptive_rms_enabled) : false;
  if (!running || rmsValue === null) {
    hideRmsIndicator();
    return;
  }
  const whole = Math.trunc(rmsValue);
  if (!Number.isFinite(whole)) {
    hideRmsIndicator();
    return;
  }
  const thresholdWhole =
    adaptiveEnabled && Number.isFinite(adaptiveThreshold)
      ? Math.trunc(adaptiveThreshold)
      : null;
  if (
    rmsIndicatorState.visible &&
    rmsIndicatorState.value === whole &&
    rmsIndicatorState.threshold === thresholdWhole
  ) {
    return;
  }
  if (thresholdWhole !== null && Number.isFinite(thresholdWhole)) {
    dom.rmsIndicatorValue.textContent = `${whole}/${thresholdWhole}`;
  } else {
    dom.rmsIndicatorValue.textContent = String(whole);
  }
  dom.rmsIndicator.dataset.visible = "true";
  dom.rmsIndicator.setAttribute("aria-hidden", "false");
  rmsIndicatorState.visible = true;
  rmsIndicatorState.value = whole;
  rmsIndicatorState.threshold = Number.isFinite(thresholdWhole) ? thresholdWhole : null;
}

function handleFetchSuccess() {
  setAutoRefreshInterval(AUTO_REFRESH_INTERVAL_MS);
  updateOfflineState(false);
}

function handleFetchFailure() {
  setAutoRefreshInterval(OFFLINE_REFRESH_INTERVAL_MS);
  updateOfflineState(true);
}

const NETWORK_ERROR_PATTERNS = [
  /failed to fetch/i,
  /network ?error/i,
  /connection (?:refused|reset|aborted|closed)/i,
  /load failed/i,
  /offline/i,
];

function isOfflineFetchError(error) {
  if (!error) {
    return false;
  }
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : typeof error === "string"
      ? error.trim()
      : "";
  if (name === "typeerror") {
    if (!message) {
      return false;
    }
    return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  }
  if (!message) {
    return false;
  }
  return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function ensureOfflineStateOnError(error) {
  const offline = isOfflineFetchError(error);
  if (offline) {
    handleFetchFailure();
  }
  return offline;
}

function normalizeErrorMessage(error, fallback) {
  if (error instanceof Error && typeof error.message === "string") {
    const trimmed = error.message.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
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

function confirmDeletionPrompt(message, title = "Move recordings to recycle bin") {
  return showConfirmDialog({
    title,
    message,
    confirmText: "Move",
    cancelText: "Cancel",
  });
}

function confirmRecycleBinPurgePrompt(count) {
  const total = Number(count) || 0;
  const title = total === 1 ? "Delete recording permanently" : "Delete recordings permanently";
  const message =
    total === 1
      ? "Permanently delete the selected recording? This cannot be undone."
      : `Permanently delete ${total} selected recordings? This cannot be undone.`;
  return showConfirmDialog({
    title,
    message,
    confirmText: "Delete permanently",
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
  updatePlayerActions(state.current);
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

function recordingUrl(path, { download = false } = {}) {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const suffix = download ? "?download=1" : "";
  return apiPath(`/recordings/${encoded}${suffix}`);
}

function normalizePlaybackSource(value) {
  return value === "raw" ? "raw" : "processed";
}

function recordAudioUrl(record, { download = false } = {}) {
  if (isRecycleBinRecord(record)) {
    return recycleBinAudioUrl(record.recycleBinId, { download });
  }
  if (record && typeof record.path === "string" && record.path) {
    return recordingUrl(record.path, { download });
  }
  return "";
}

function recordHasRawAudio(record) {
  if (!record || isRecycleBinRecord(record)) {
    return false;
  }
  const rawCandidate =
    typeof record.raw_audio_path === "string" ? record.raw_audio_path.trim() : "";
  return rawCandidate !== "";
}

function recordRawAudioUrl(record, { download = false } = {}) {
  if (!recordHasRawAudio(record)) {
    return "";
  }
  const rawPath = String(record.raw_audio_path).trim();
  if (!rawPath) {
    return "";
  }
  return recordingUrl(rawPath, { download });
}

function resolvePlaybackSourceUrl(
  record,
  { download = false, source = playbackSourceState.mode, allowFallback = true } = {},
) {
  const normalized = normalizePlaybackSource(source);
  if (normalized === "raw") {
    const rawUrl = recordRawAudioUrl(record, { download });
    if (rawUrl) {
      return rawUrl;
    }
    if (!allowFallback) {
      return "";
    }
  }
  return recordAudioUrl(record, { download });
}

function recordWaveformUrl(record) {
  if (!record) {
    return "";
  }
  if (isRecycleBinRecord(record)) {
    if (!record.waveform_available) {
      return "";
    }
    const identifier =
      typeof record.waveform_path === "string" && record.waveform_path
        ? record.waveform_path
        : record.recycleBinId;
    return recycleBinWaveformUrl(identifier);
  }
  if (typeof record.waveform_path === "string" && record.waveform_path) {
    return recordingUrl(record.waveform_path);
  }
  return "";
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

  if (dom.filterTimeRange) {
    const sanitized = VALID_TIME_RANGES.has(state.filters.timeRange)
      ? state.filters.timeRange
      : "";
    if (dom.filterTimeRange.value !== sanitized) {
      dom.filterTimeRange.value = sanitized;
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

function deriveInProgressRecord(captureStatus) {
  const status =
    captureStatus && typeof captureStatus === "object" ? captureStatus : null;
  if (!status || !status.capturing) {
    return null;
  }

  const event = status && typeof status.event === "object" ? status.event : null;
  if (!event || event.in_progress !== true) {
    return null;
  }

  const relCandidates = [];
  if (
    typeof event.partial_recording_rel_path === "string" &&
    event.partial_recording_rel_path.trim() !== ""
  ) {
    relCandidates.push(event.partial_recording_rel_path.trim());
  }
  if (
    typeof status.partial_recording_rel_path === "string" &&
    status.partial_recording_rel_path.trim() !== ""
  ) {
    relCandidates.push(status.partial_recording_rel_path.trim());
  }

  const relPath = relCandidates.find((value) => value) || "";
  if (!relPath) {
    return null;
  }

  const waveformRelCandidates = [];
  if (
    typeof event.partial_waveform_rel_path === "string" &&
    event.partial_waveform_rel_path.trim() !== ""
  ) {
    waveformRelCandidates.push(event.partial_waveform_rel_path.trim());
  }
  if (
    typeof status.partial_waveform_rel_path === "string" &&
    status.partial_waveform_rel_path.trim() !== ""
  ) {
    waveformRelCandidates.push(status.partial_waveform_rel_path.trim());
  }
  const waveformRelPath = waveformRelCandidates.find((value) => value) || "";

  const sizeValue = toFiniteOrNull(status.event_size_bytes);
  const durationValue = toFiniteOrNull(status.event_duration_seconds);
  const startedEpoch = toFiniteOrNull(event.started_epoch);
  const startedAt =
    typeof event.started_at === "string" && event.started_at
      ? event.started_at
      : "";
  const baseName =
    typeof event.base_name === "string" && event.base_name
      ? event.base_name
      : "Current recording";
  const streamingFormat =
    typeof event.streaming_container_format === "string" &&
    event.streaming_container_format
      ? event.streaming_container_format.toLowerCase()
      : typeof status.streaming_container_format === "string" &&
          status.streaming_container_format
        ? status.streaming_container_format.toLowerCase()
        : "opus";
  const extension = streamingFormat === "webm" ? "webm" : "opus";
  const day = relPath.split("/")[0] || "";
  const modifiedEpoch =
    startedEpoch !== null ? startedEpoch : Date.now() / 1000;

  let waveformPath = "";
  if (waveformRelPath) {
    waveformPath = waveformRelPath;
  } else if (
    typeof event.partial_waveform_path === "string" &&
    event.partial_waveform_path
  ) {
    waveformPath = event.partial_waveform_path;
  } else if (
    typeof status.partial_waveform_path === "string" &&
    status.partial_waveform_path
  ) {
    waveformPath = status.partial_waveform_path;
  }

  return {
    name: baseName,
    path: relPath,
    stream_path: relPath,
    day,
    extension,
    size_bytes: sizeValue !== null ? Math.max(0, sizeValue) : 0,
    modified: modifiedEpoch,
    modified_iso: new Date(modifiedEpoch * 1000).toISOString(),
    duration_seconds: durationValue !== null ? Math.max(0, durationValue) : null,
    start_epoch: startedEpoch,
    started_at: startedAt,
    waveform_path: waveformPath,
    has_transcript: false,
    transcript_path: "",
    transcript_event_type: "",
    transcript_text: "",
    transcript_updated: null,
    transcript_updated_iso: "",
    trigger_offset_seconds: null,
    release_offset_seconds: null,
    motion_trigger_offset_seconds: toFiniteOrNull(event.motion_trigger_offset_seconds),
    motion_release_offset_seconds: toFiniteOrNull(event.motion_release_offset_seconds),
    motion_started_epoch: toFiniteOrNull(event.motion_started_epoch),
    motion_released_epoch: toFiniteOrNull(event.motion_released_epoch),
    isPartial: true,
    inProgress: true,
  };
}

function getVisibleRecords() {
  const sorted = [...state.records].sort(compareRecords);
  if (state.partialRecord) {
    const filtered = sorted.filter((entry) => entry.path !== state.partialRecord.path);
    return [state.partialRecord, ...filtered];
  }
  return sorted;
}

function getSelectableRecords() {
  return getVisibleRecords().filter((record) => record && !record.isPartial);
}

function findNearestSelectionAnchor(records, targetIndex) {
  let previous = { path: "", distance: Number.POSITIVE_INFINITY };
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = records[index];
    if (!candidate || typeof candidate.path !== "string" || !candidate.path) {
      continue;
    }
    if (state.selections.has(candidate.path)) {
      previous = { path: candidate.path, distance: targetIndex - index };
      break;
    }
  }

  let next = { path: "", distance: Number.POSITIVE_INFINITY };
  for (let index = targetIndex + 1; index < records.length; index += 1) {
    const candidate = records[index];
    if (!candidate || typeof candidate.path !== "string" || !candidate.path) {
      continue;
    }
    if (state.selections.has(candidate.path)) {
      next = { path: candidate.path, distance: index - targetIndex };
      break;
    }
  }

  if (previous.path && next.path) {
    return previous.distance <= next.distance ? previous.path : next.path;
  }
  if (previous.path) {
    return previous.path;
  }
  if (next.path) {
    return next.path;
  }
  return "";
}

function resolveSelectionAnchor(targetPath) {
  if (typeof targetPath !== "string" || !targetPath) {
    return "";
  }

  const records = getSelectableRecords();
  if (!records.length) {
    return "";
  }

  const targetIndex = records.findIndex((record) => record && record.path === targetPath);
  if (targetIndex === -1) {
    return "";
  }

  const anchorCandidate = state.selectionAnchor;
  if (
    typeof anchorCandidate === "string" &&
    anchorCandidate &&
    anchorCandidate !== targetPath &&
    records.some((record) => record && record.path === anchorCandidate)
  ) {
    return anchorCandidate;
  }

  const focusCandidate = state.selectionFocus;
  if (
    typeof focusCandidate === "string" &&
    focusCandidate &&
    focusCandidate !== targetPath &&
    records.some((record) => record && record.path === focusCandidate)
  ) {
    return focusCandidate;
  }

  const nearest = findNearestSelectionAnchor(records, targetIndex);
  if (nearest && nearest !== targetPath) {
    return nearest;
  }

  return "";
}

function applySelectionRange(anchorPath, targetPath, shouldSelect) {
  if (typeof anchorPath !== "string" || !anchorPath) {
    return false;
  }
  if (typeof targetPath !== "string" || !targetPath) {
    return false;
  }
  const records = getSelectableRecords();
  const anchorIndex = records.findIndex((record) => record && record.path === anchorPath);
  const targetIndex = records.findIndex((record) => record && record.path === targetPath);
  if (anchorIndex === -1 || targetIndex === -1) {
    return false;
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const updated = new Set(state.selections);
  let changed = false;
  for (let index = start; index <= end; index += 1) {
    const entry = records[index];
    if (!entry || typeof entry.path !== "string" || !entry.path) {
      continue;
    }
    if (shouldSelect) {
      if (!updated.has(entry.path)) {
        updated.add(entry.path);
        changed = true;
      }
    } else if (updated.delete(entry.path)) {
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  state.selections = updated;
  return true;
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
    const motionTrigger = Number.isFinite(record.motion_trigger_offset_seconds)
      ? record.motion_trigger_offset_seconds
      : "";
    const motionRelease = Number.isFinite(record.motion_release_offset_seconds)
      ? record.motion_release_offset_seconds
      : "";
    const motionStarted = Number.isFinite(record.motion_started_epoch)
      ? record.motion_started_epoch
      : "";
    const motionReleased = Number.isFinite(record.motion_released_epoch)
      ? record.motion_released_epoch
      : "";
    const waveform = typeof record.waveform_path === "string" ? record.waveform_path : "";
    parts.push(
      `${path}|${modified}|${size}|${duration}|${trigger}|${release}|${motionTrigger}|${motionRelease}|${motionStarted}|${motionReleased}|${waveform}`
    );
  }
  return parts.join("\n");
}

function computePartialFingerprint(record) {
  if (!record || typeof record !== "object") {
    return "";
  }

  const path = typeof record.path === "string" ? record.path : "";
  const size = Number.isFinite(record.size_bytes) ? record.size_bytes : "";
  const duration = Number.isFinite(record.duration_seconds)
    ? record.duration_seconds
    : "";
  const modified = Number.isFinite(record.modified) ? record.modified : "";
  const name = typeof record.name === "string" ? record.name : "";
  const extension = typeof record.extension === "string" ? record.extension : "";
  const inProgress = record && record.inProgress === true ? "1" : "0";
  const motionTrigger = Number.isFinite(record.motion_trigger_offset_seconds)
    ? record.motion_trigger_offset_seconds
    : "";
  const motionRelease = Number.isFinite(record.motion_release_offset_seconds)
    ? record.motion_release_offset_seconds
    : "";
  const motionStarted = Number.isFinite(record.motion_started_epoch)
    ? record.motion_started_epoch
    : "";
  const motionReleased = Number.isFinite(record.motion_released_epoch)
    ? record.motion_released_epoch
    : "";

  return [
    path,
    size,
    duration,
    modified,
    name,
    extension,
    inProgress,
    motionTrigger,
    motionRelease,
    motionStarted,
    motionReleased,
  ].join("|");
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
  const selectable = visible.filter((record) => !record.isPartial);
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
  if (dom.selectedCount) {
    dom.selectedCount.textContent = selectedText;
  }
  dom.deleteSelected.disabled = state.selections.size === 0;
  if (dom.downloadSelected) {
    dom.downloadSelected.disabled = state.selections.size === 0;
  }
  if (dom.renameSelected) {
    dom.renameSelected.disabled = state.selections.size !== 1 || renameDialogState.pending;
  }

  if (!selectable.length) {
    dom.toggleAll.checked = false;
    dom.toggleAll.indeterminate = false;
    if (dom.toggleAll) {
      dom.toggleAll.disabled = true;
    }
    return;
  }

  if (dom.toggleAll) {
    dom.toggleAll.disabled = false;
  }

  let selectedVisible = 0;
  for (const record of selectable) {
    if (state.selections.has(record.path)) {
      selectedVisible += 1;
    }
  }

  dom.toggleAll.checked = selectedVisible === selectable.length;
  if (selectedVisible === 0 || selectedVisible === selectable.length) {
    dom.toggleAll.indeterminate = false;
  } else {
    dom.toggleAll.indeterminate = true;
  }

  if (typeof state.selectionAnchor === "string" && state.selectionAnchor) {
    const anchorExists = selectable.some(
      (record) => record && record.path === state.selectionAnchor,
    );
    if (!anchorExists) {
      const focusPath = state.selectionFocus;
      const focusExists = selectable.some(
        (record) => record && record.path === focusPath,
      );
      if (focusExists && focusPath) {
        state.selectionAnchor = focusPath;
      } else {
        const fallback = selectable.find((record) => state.selections.has(record.path));
        if (fallback && typeof fallback.path === "string") {
          state.selectionAnchor = fallback.path;
          state.selectionFocus = fallback.path;
        } else {
          state.selectionAnchor = "";
          if (state.selections.size === 0) {
            state.selectionFocus = "";
          }
        }
      }
    }
  } else if (state.selections.size === 0) {
    state.selectionFocus = "";
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

function updatePlayerActions(record) {
  if (!dom.playerMetaActions) {
    return;
  }
  const hasRecord = Boolean(
    record && typeof record.path === "string" && record.path.trim() !== ""
  );
  if (!hasRecord) {
    dom.playerMetaActions.hidden = true;
    if (dom.playerDownload) {
      dom.playerDownload.removeAttribute("href");
      dom.playerDownload.removeAttribute("download");
    }
    if (dom.playerRename) {
      dom.playerRename.disabled = true;
    }
    if (dom.playerDelete) {
      dom.playerDelete.disabled = true;
    }
    return;
  }

  dom.playerMetaActions.hidden = false;
  const isPartial = Boolean(record.isPartial);
  const isRecycle = isRecycleBinRecord(record);
  if (isRecycle) {
    dom.playerMetaActions.hidden = true;
  }
  if (dom.playerDownload) {
    if (isPartial) {
      dom.playerDownload.removeAttribute("href");
      dom.playerDownload.removeAttribute("download");
      dom.playerDownload.setAttribute("aria-disabled", "true");
    } else {
      const downloadUrl = resolvePlaybackSourceUrl(record, { download: true });
      if (downloadUrl) {
        dom.playerDownload.href = downloadUrl;
      } else {
        dom.playerDownload.removeAttribute("href");
      }
      const baseName =
        typeof record.name === "string" && record.name ? record.name : record.path;
      const extension =
        typeof record.extension === "string" && record.extension
          ? `.${record.extension}`
          : "";
      dom.playerDownload.setAttribute("download", `${baseName}${extension}`);
      dom.playerDownload.removeAttribute("aria-disabled");
    }
  }
  if (dom.playerRename) {
    dom.playerRename.disabled =
      isPartial || isRecycle || Boolean(renameDialogState.pending);
  }
  if (dom.playerDelete) {
    dom.playerDelete.disabled = isPartial || isRecycle;
  }
}

function updatePlayerMeta(record) {
  const metaTarget = dom.playerMetaText || dom.playerMeta;
  if (!metaTarget) {
    updatePlayerActions(record || null);
    return;
  }

  const hasRecord = Boolean(
    record && typeof record.path === "string" && record.path.trim() !== ""
  );
  if (!hasRecord) {
    metaTarget.textContent = "Select a recording to preview.";
    updatePlayerActions(null);
    return;
  }

  const isPartial = Boolean(record.isPartial);
  const isRecycle = isRecycleBinRecord(record);
  const details = [];
  if (isPartial) {
    details.push("Recording in progress");
  }
  const extText = record.extension ? `.${record.extension}` : "";
  const nameText =
    typeof record.name === "string" && record.name ? record.name : record.path;
  if (isRecycle) {
    const baseDetails = [];
    const displayName = nameText || record.recycleBinId || "Recycle bin entry";
    baseDetails.push(`${displayName}${extText}`);
    if (record.original_path) {
      baseDetails.push(`Original: ${record.original_path}`);
    }
    const deletedText = formatIsoDateTime(record.deleted_at) || formatDate(record.deleted_at_epoch);
    if (deletedText) {
      baseDetails.push(`Deleted ${deletedText}`);
    }
    baseDetails.push(formatBytes(record.size_bytes));
    if (Number.isFinite(record.duration_seconds) && record.duration_seconds > 0) {
      baseDetails.push(formatDuration(record.duration_seconds));
    }
    if (record.restorable === false) {
      baseDetails.push("Destination in use");
    }
    metaTarget.textContent = `Recycle bin preview: ${baseDetails.join(" • ")}`;
  } else {
    details.push(`${nameText}${extText}`);
    if (record.day) {
      details.push(record.day);
    }
    const startSeconds = getRecordStartSeconds(record);
    details.push(formatDate(startSeconds !== null ? startSeconds : record.modified));
    details.push(formatBytes(record.size_bytes));
    if (Number.isFinite(record.duration_seconds) && record.duration_seconds > 0) {
      details.push(formatDuration(record.duration_seconds));
    }
    if (isMotionTriggeredEvent(record)) {
      details.push("Motion event");
    }
    metaTarget.textContent = `Now playing: ${details.join(" • ")}`;
  }
  updatePlayerActions(record);
}

function ensurePreviewSectionOrder() {
  if (!dom.playerMeta || !dom.clipperContainer) {
    return;
  }

  const clipperParent = dom.clipperContainer.parentElement;
  if (!clipperParent) {
    return;
  }

  if (dom.playerMeta.parentElement !== clipperParent) {
    clipperParent.insertBefore(dom.playerMeta, dom.clipperContainer);
    return;
  }

  if (dom.playerMeta.nextElementSibling !== dom.clipperContainer) {
    clipperParent.insertBefore(dom.playerMeta, dom.clipperContainer);
  }
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

function getRecycleBinColumnCount() {
  if (dom.recycleBinTable && dom.recycleBinTable.tHead) {
    const headerRow = dom.recycleBinTable.tHead.rows[0];
    if (headerRow && headerRow.children.length > 0) {
      return headerRow.children.length;
    }
  }
  const sampleRow = dom.recycleBinTableBody
    ? dom.recycleBinTableBody.querySelector("tr[data-id]")
    : null;
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
  if (playerPlacement.recycleBinRowElement && playerPlacement.recycleBinRowElement.parentElement) {
    playerPlacement.recycleBinRowElement.parentElement.removeChild(playerPlacement.recycleBinRowElement);
  }
  dom.playerCard.hidden = true;
  dom.playerCard.dataset.active = "false";
  playerPlacement.mode = "hidden";
  playerPlacement.anchorPath = null;
  playerPlacement.desktopRowElement = null;
  playerPlacement.mobileCell = null;
  playerPlacement.recycleBinRowElement = null;
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

function ensureRecycleBinRow() {
  if (!dom.playerCard) {
    return null;
  }
  if (!playerPlacement.recycleBinRowElement) {
    const row = document.createElement("tr");
    row.className = "player-row recycle-bin-player-row";
    const cell = document.createElement("td");
    cell.className = "player-cell recycle-bin-player-cell";
    row.append(cell);
    playerPlacement.recycleBinRowElement = row;
  }
  const cell = playerPlacement.recycleBinRowElement.firstElementChild;
  if (cell instanceof HTMLTableCellElement) {
    cell.colSpan = getRecycleBinColumnCount();
    if (!cell.contains(dom.playerCard)) {
      cell.append(dom.playerCard);
    }
  }
  return playerPlacement.recycleBinRowElement;
}

function placePlayerCard(record, sourceRow = null) {
  if (!dom.playerCard || !record) {
    return;
  }
  const isRecycle = isRecycleBinRecord(record);
  let targetRow =
    sourceRow ?? (isRecycle ? getRecycleBinRow(record.recycleBinId) : findRowForRecord(record));
  if (targetRow && !targetRow.parentElement) {
    targetRow = isRecycle
      ? getRecycleBinRow(record.recycleBinId)
      : findRowForRecord(record);
  }
  if (!targetRow || !targetRow.parentElement) {
    detachPlayerCard();
    return;
  }

  if (isRecycle) {
    const row = ensureRecycleBinRow();
    if (!row) {
      return;
    }
    if (playerPlacement.mobileCell && playerPlacement.mobileCell.parentElement) {
      playerPlacement.mobileCell.parentElement.removeChild(playerPlacement.mobileCell);
      playerPlacement.mobileCell = null;
    }
    if (playerPlacement.desktopRowElement && playerPlacement.desktopRowElement.parentElement) {
      playerPlacement.desktopRowElement.parentElement.removeChild(playerPlacement.desktopRowElement);
    }
    const parent = targetRow.parentElement;
    const nextSibling = targetRow.nextSibling;
    if (nextSibling) {
      parent.insertBefore(row, nextSibling);
    } else {
      parent.append(row);
    }
    dom.playerCard.hidden = false;
    dom.playerCard.dataset.active = "true";
    playerPlacement.mode = "recycle-bin";
    playerPlacement.anchorPath = record.path;
    return;
  }

  if (playerPlacement.recycleBinRowElement && playerPlacement.recycleBinRowElement.parentElement) {
    playerPlacement.recycleBinRowElement.parentElement.removeChild(playerPlacement.recycleBinRowElement);
  }
  playerPlacement.recycleBinRowElement = null;

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

function recordMetadataChanged(previous, next) {
  if (!previous || !next) {
    return false;
  }

  const previousModified = Number.isFinite(previous.modified)
    ? Number(previous.modified)
    : null;
  const nextModified = Number.isFinite(next.modified) ? Number(next.modified) : null;
  if (previousModified !== null && nextModified !== null && previousModified !== nextModified) {
    return true;
  }
  if (previousModified === null || nextModified === null) {
    const prevIso = typeof previous.modified_iso === "string" ? previous.modified_iso : "";
    const nextIso = typeof next.modified_iso === "string" ? next.modified_iso : "";
    if (prevIso !== nextIso) {
      return true;
    }
  }

  const previousDuration = Number.isFinite(previous.duration_seconds)
    ? Number(previous.duration_seconds)
    : null;
  const nextDuration = Number.isFinite(next.duration_seconds) ? Number(next.duration_seconds) : null;
  if (previousDuration !== nextDuration) {
    return true;
  }

  const previousSize = Number.isFinite(previous.size_bytes) ? Number(previous.size_bytes) : null;
  const nextSize = Number.isFinite(next.size_bytes) ? Number(next.size_bytes) : null;
  if (previousSize !== nextSize) {
    return true;
  }

  const previousWaveform = typeof previous.waveform_path === "string" ? previous.waveform_path : "";
  const nextWaveform = typeof next.waveform_path === "string" ? next.waveform_path : "";
  if (previousWaveform !== nextWaveform) {
    return true;
  }

  return false;
}

function updatePlaybackSourceForRecord(record, { preserveMode = false } = {}) {
  const previousMode = normalizePlaybackSource(playbackSourceState.mode);
  const previousRawPath =
    typeof playbackSourceState.rawPath === "string" ? playbackSourceState.rawPath : "";
  const previousRecordPath =
    typeof playbackSourceState.recordPath === "string" ? playbackSourceState.recordPath : "";

  const hasRaw = recordHasRawAudio(record);
  let rawPath = "";
  if (hasRaw && record && typeof record.raw_audio_path === "string") {
    rawPath = record.raw_audio_path.trim();
  }

  const nextRecordPath =
    record && typeof record.path === "string" ? record.path.trim() : "";
  const recordChanged = nextRecordPath !== previousRecordPath;

  playbackSourceState.hasRaw = hasRaw;
  playbackSourceState.rawPath = rawPath;
  playbackSourceState.recordPath = nextRecordPath;
  if (recordChanged) {
    playbackSourceState.pendingSeek = null;
    playbackSourceState.pendingPlay = false;
    playbackSourceState.suppressTransportReset = false;
  }

  let nextMode = "processed";
  if (hasRaw && preserveMode && previousMode === "raw") {
    nextMode = "raw";
  }
  playbackSourceState.mode = nextMode;

  applyPlaybackSourceUi();

  return {
    previousMode,
    nextMode,
    hasRaw,
    rawPath,
    rawPathChanged: rawPath !== previousRawPath,
  };
}

function applyPlaybackSourceUi() {
  if (!dom.playbackSourceGroup) {
    return;
  }

  const record = state.current;
  const hasRecord = Boolean(
    record && typeof record === "object" && typeof record.path === "string" && record.path.trim() !== "",
  );
  const hasRaw = playbackSourceState.hasRaw;
  const activeMode = hasRecord
    ? playbackSourceState.mode === "raw" && hasRaw
      ? "raw"
      : "processed"
    : "processed";

  dom.playbackSourceGroup.hidden = !hasRecord;
  dom.playbackSourceGroup.dataset.active = hasRecord ? "true" : "false";
  dom.playbackSourceGroup.dataset.rawAvailable = hasRaw ? "true" : "false";
  dom.playbackSourceGroup.dataset.source = activeMode;

  if (dom.playbackSourceProcessed) {
    dom.playbackSourceProcessed.disabled = !hasRecord;
    if (dom.playbackSourceProcessed.classList) {
      dom.playbackSourceProcessed.classList.toggle("is-active", activeMode === "processed");
    }
    dom.playbackSourceProcessed.dataset.active = activeMode === "processed" ? "true" : "false";
    if (typeof dom.playbackSourceProcessed.setAttribute === "function") {
      dom.playbackSourceProcessed.setAttribute(
        "aria-pressed",
        activeMode === "processed" ? "true" : "false",
      );
    }
  }

  if (dom.playbackSourceRaw) {
    const rawEnabled = hasRecord && hasRaw;
    dom.playbackSourceRaw.disabled = !rawEnabled;
    if (dom.playbackSourceRaw.classList) {
      dom.playbackSourceRaw.classList.toggle("is-active", activeMode === "raw");
    }
    dom.playbackSourceRaw.dataset.active = activeMode === "raw" ? "true" : "false";
    if (typeof dom.playbackSourceRaw.setAttribute === "function") {
      dom.playbackSourceRaw.setAttribute("aria-pressed", activeMode === "raw" ? "true" : "false");
      if (rawEnabled) {
        dom.playbackSourceRaw.removeAttribute("aria-disabled");
      } else {
        dom.playbackSourceRaw.setAttribute("aria-disabled", "true");
      }
    }
  }

  if (dom.playbackSourceActive) {
    dom.playbackSourceActive.textContent =
      PLAYBACK_SOURCE_LABELS[activeMode] || PLAYBACK_SOURCE_LABELS.processed;
  }

  if (dom.playbackSourceHint) {
    dom.playbackSourceHint.hidden = !hasRecord || hasRaw;
  }
}

function setPlaybackSource(mode, options = {}) {
  const { userInitiated = false, force = false, allowFallback = true } = options;
  const sanitized = normalizePlaybackSource(mode);
  const record = state.current;

  if (!record || !dom.player) {
    playbackSourceState.mode = "processed";
    playbackSourceState.hasRaw = false;
    playbackSourceState.rawPath = "";
    playbackSourceState.recordPath = "";
    playbackSourceState.pendingSeek = null;
    playbackSourceState.pendingPlay = false;
    playbackSourceState.suppressTransportReset = false;
    applyPlaybackSourceUi();
    return;
  }

  if (sanitized === "raw" && !playbackSourceState.hasRaw) {
    playbackSourceState.mode = "processed";
    applyPlaybackSourceUi();
    if (userInitiated && dom.playbackSourceHint) {
      dom.playbackSourceHint.hidden = false;
    }
    return;
  }

  const currentMode = normalizePlaybackSource(playbackSourceState.mode);
  if (currentMode === sanitized && !force) {
    applyPlaybackSourceUi();
    return;
  }

  const targetUrl = resolvePlaybackSourceUrl(record, {
    source: sanitized,
    allowFallback,
  });
  if (!targetUrl) {
    if (sanitized === "raw" && allowFallback) {
      playbackSourceState.mode = "processed";
      applyPlaybackSourceUi();
    }
    return;
  }

  const currentTime = Number.isFinite(dom.player.currentTime) ? dom.player.currentTime : 0;
  const wasPlaying = !dom.player.paused && !dom.player.ended;

  playbackSourceState.mode = sanitized;
  playbackSourceState.pendingSeek = currentTime;
  playbackSourceState.pendingPlay = wasPlaying;
  playbackSourceState.suppressTransportReset = true;

  applyPlaybackSourceUi();

  const cleanup = () => {
    dom.player.removeEventListener("loadedmetadata", handleLoaded);
    dom.player.removeEventListener("error", handleError);
  };

  const handleLoaded = () => {
    cleanup();
    playbackSourceState.suppressTransportReset = false;
    if (playbackSourceState.pendingSeek !== null) {
      let seekTime = playbackSourceState.pendingSeek;
      const duration = Number.isFinite(dom.player.duration) ? dom.player.duration : Number.NaN;
      if (Number.isFinite(duration) && duration > 0) {
        seekTime = clamp(seekTime, 0, Math.max(duration - 0.02, 0));
      }
      try {
        dom.player.currentTime = seekTime;
      } catch (error) {
        /* ignore seek errors */
      }
    }
    if (playbackSourceState.pendingPlay) {
      dom.player.play().catch(() => undefined);
    }
    playbackSourceState.pendingSeek = null;
    playbackSourceState.pendingPlay = false;
    updateTransportProgressUI();
    updateCursorFromPlayer();
  };

  const handleError = () => {
    cleanup();
    playbackSourceState.suppressTransportReset = false;
    playbackSourceState.pendingSeek = null;
    playbackSourceState.pendingPlay = false;
    if (sanitized === "raw" && allowFallback) {
      setPlaybackSource("processed", { force: true, allowFallback: false });
    } else {
      applyPlaybackSourceUi();
    }
  };

  dom.player.addEventListener("loadedmetadata", handleLoaded);
  dom.player.addEventListener("error", handleError);

  playbackState.resetOnLoad = false;
  playbackState.enforcePauseOnLoad = !wasPlaying;
  dom.player.src = targetUrl;
  dom.player.load();
  if (!wasPlaying) {
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }
  }
  updatePlayerActions(record);
  updateTransportAvailability();
}

function getPlaybackSourceState() {
  return {
    mode: playbackSourceState.mode,
    hasRaw: playbackSourceState.hasRaw,
    rawPath: playbackSourceState.rawPath,
  };
}

function setNowPlaying(record, options = {}) {
  const { autoplay = true, resetToStart = true, sourceRow = null } = options;
  const previous = state.current;
  const samePath = Boolean(previous && record && previous.path === record.path);
  const recordChanged = samePath && recordMetadataChanged(previous, record);
  const sameRecord = samePath && !recordChanged;
  const recordIsRecycle = isRecycleBinRecord(record);

  cancelKeyboardJog();

  playbackState.pausedViaSpacebar.delete(dom.player);
  transportState.scrubbing = false;
  transportState.scrubWasPlaying = false;

  if (!sameRecord && dom.player) {
    try {
      dom.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }

    resetAllPlayButtons();
  }

  state.current = record;
  setTransportActive(Boolean(record));
  if (!record) {
    updatePlaybackSourceForRecord(null);
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
    if (dom.playerCard) {
      dom.playerCard.dataset.context = "recordings";
    }
    resetTransportUi();
    updateTransportAvailability();
    return;
  }

  updatePlaybackSourceForRecord(record, { preserveMode: sameRecord });

  if (dom.playerCard) {
    dom.playerCard.dataset.context = recordIsRecycle ? "recycle-bin" : "recordings";
  }
  ensurePreviewSectionOrder();
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
    updateTransportAvailability();
    return;
  }

  playbackState.resetOnLoad = resetToStart;
  playbackState.enforcePauseOnLoad = !autoplay;

  const url = resolvePlaybackSourceUrl(record, {
    source: playbackSourceState.mode,
  });
  if (url) {
    dom.player.src = url;
  } else {
    dom.player.removeAttribute("src");
  }
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
  setWaveformMarker(dom.waveformMotionStartMarker, null, null);
  setWaveformMarker(dom.waveformMotionEndMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);
  loadWaveform(record);
  updateTransportAvailability();
}

function renderRecords() {
  if (!dom.tableBody) {
    return;
  }

  pendingSelectionRange = null;

  const shouldPreservePreview =
    previewIsActive() &&
    dom.playerCard &&
    (playerPlacement.mode === "desktop" || playerPlacement.mode === "mobile");
  if (shouldPreservePreview) {
    restorePlayerCardHome();
  }

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
    const isPartial = Boolean(record.isPartial);
    const isMotion = isMotionTriggeredEvent(record);
    const recordCollection =
      typeof record.collection === "string" && record.collection
        ? record.collection
        : state.collection;
    if (isPartial) {
      row.dataset.recordingState = "in-progress";
      row.classList.add("record-in-progress");
    }
    if (isMotion) {
      row.dataset.motion = "true";
    }

    const checkboxCell = document.createElement("td");
    checkboxCell.className = "checkbox-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !isPartial && state.selections.has(record.path);
    checkbox.disabled = isPartial;
    checkbox.addEventListener("click", (event) => {
      if (!(event instanceof MouseEvent)) {
        return;
      }
      state.selectionFocus = record.path;
      if (event.shiftKey) {
        const anchorPath = resolveSelectionAnchor(record.path);
        if (!anchorPath) {
          pendingSelectionRange = null;
          state.selectionAnchor = record.path;
          return;
        }
        const wasSelected = state.selections.has(record.path);
        pendingSelectionRange = {
          anchorPath,
          targetPath: record.path,
          shouldSelect: !wasSelected,
        };
        return;
      }
      pendingSelectionRange = null;
      state.selectionAnchor = record.path;
    });
    checkbox.addEventListener("change", (event) => {
      state.selectionFocus = record.path;
      if (
        pendingSelectionRange &&
        pendingSelectionRange.targetPath === record.path
      ) {
        const { anchorPath, targetPath, shouldSelect } = pendingSelectionRange;
        pendingSelectionRange = null;
        const changed = applySelectionRange(anchorPath, targetPath, shouldSelect);
        state.selectionAnchor = targetPath;
        const isSelected = state.selections.has(targetPath);
        if (event.target instanceof HTMLInputElement) {
          if (event.target.checked !== isSelected) {
            event.target.checked = isSelected;
          }
        } else if (checkbox.checked !== isSelected) {
          checkbox.checked = isSelected;
        }
        updateSelectionUI();
        if (changed) {
          applyNowPlayingHighlight();
        }
        return;
      }

      pendingSelectionRange = null;
      if (event.target.checked) {
        state.selections.add(record.path);
      } else {
        state.selections.delete(record.path);
      }
      state.selectionAnchor = record.path;
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
    if (isPartial) {
      const badge = document.createElement("span");
      badge.className = "badge badge-recording";
      badge.textContent = "Recording";
      nameTitle.append(" ", badge);
    }
    if (isMotion) {
      const motionBadge = document.createElement("span");
      motionBadge.className = "badge badge-motion";
      motionBadge.textContent = "Motion";
      nameTitle.append(" ", motionBadge);
    }
    nameCell.append(nameTitle);

    const mobileMeta = document.createElement("div");
    mobileMeta.className = "record-mobile-meta";
    if (isPartial) {
      const livePill = document.createElement("span");
      livePill.className = "meta-pill live-pill";
      livePill.textContent = "Recording…";
      mobileMeta.append(livePill);
    }
    if (isMotion) {
      const motionPill = document.createElement("span");
      motionPill.className = "meta-pill motion-pill";
      motionPill.textContent = "Motion event";
      mobileMeta.append(motionPill);
    }
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

    const actionsRow = document.createElement("div");
    actionsRow.className = "record-actions-row action-buttons";
    if (isPartial) {
      const statusLabel = document.createElement("span");
      statusLabel.className = "in-progress-label";
      statusLabel.textContent = "Finalizing";
      actionsRow.append(statusLabel);
    } else {
      if (recordCollection === "saved") {
        const unsaveButton = document.createElement("button");
        unsaveButton.type = "button";
        unsaveButton.textContent = "Unsave";
        unsaveButton.classList.add("ghost-button", "small");
        unsaveButton.addEventListener("click", (event) => {
          event.stopPropagation();
          handleUnsaveRecord(record, unsaveButton);
        });
        actionsRow.append(unsaveButton);
      } else {
        const saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.textContent = "Save";
        saveButton.classList.add("primary-button", "small");
        saveButton.addEventListener("click", (event) => {
          event.stopPropagation();
          handleSaveRecord(record, saveButton);
        });
        actionsRow.append(saveButton);
      }

      const downloadLink = document.createElement("a");
      downloadLink.href = recordAudioUrl(record, { download: true });
      downloadLink.textContent = "Download";
      downloadLink.classList.add("ghost-button", "small");
      downloadLink.setAttribute(
        "download",
        `${record.name}.${record.extension || "opus"}`
      );
      downloadLink.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.textContent = "Rename";
      renameButton.classList.add("ghost-button", "small");
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openRenameDialog(record);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.classList.add("danger-button", "small");
      deleteButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        await requestRecordDeletion(record);
      });

      actionsRow.append(downloadLink, renameButton, deleteButton);
    }

    nameCell.append(actionsRow);
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

async function handleSaveRecord(record, button) {
  if (!record || typeof record.path !== "string" || !record.path) {
    return;
  }

  let previousLabel = "";
  if (button instanceof HTMLButtonElement) {
    previousLabel = button.textContent || "";
    button.disabled = true;
    button.textContent = "Saving…";
  }

  try {
    const response = await fetch(apiPath("/api/recordings/save"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [record.path] }),
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    await response.json();
    await fetchRecordings({ silent: false, force: true });
  } catch (error) {
    console.error("Unable to save recording", error);
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = previousLabel || "Save";
    }
    return;
  }

  if (button instanceof HTMLButtonElement) {
    button.disabled = false;
    button.textContent = previousLabel || "Save";
  }
}

async function handleUnsaveRecord(record, button) {
  if (!record || typeof record.path !== "string" || !record.path) {
    return;
  }

  let previousLabel = "";
  if (button instanceof HTMLButtonElement) {
    previousLabel = button.textContent || "";
    button.disabled = true;
    button.textContent = "Unsaving…";
  }

  try {
    const response = await fetch(apiPath("/api/recordings/unsave"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [record.path] }),
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    await response.json();
    await fetchRecordings({ silent: false, force: true });
  } catch (error) {
    console.error("Unable to unsave recording", error);
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = previousLabel || "Unsave";
    }
    return;
  }

  if (button instanceof HTMLButtonElement) {
    button.disabled = false;
    button.textContent = previousLabel || "Unsave";
  }
}

function updateStats() {
  const recordingsText = state.total.toString();
  if (dom.recordingCount) {
    dom.recordingCount.textContent = recordingsText;
  }
  const recordingsUsed = Number.isFinite(state.storage.recordings)
    ? state.storage.recordings
    : 0;
  const recycleBinUsed = Number.isFinite(state.storage.recycleBin)
    ? state.storage.recycleBin
    : 0;
  const totalUsed = recordingsUsed + recycleBinUsed;
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
    ? diskTotal ?? totalUsed + Math.max(diskFree ?? 0, 0)
    : null;
  if (hasCapacity && Number.isFinite(effectiveTotal) && effectiveTotal > 0) {
    dom.storageUsageText.textContent = `${formatBytes(totalUsed)} of ${formatBytes(effectiveTotal)} available`;
  } else if (hasCapacity) {
    dom.storageUsageText.textContent = `${formatBytes(totalUsed)} of ${formatBytes(Math.max(totalUsed, 0))} available`;
  } else {
    dom.storageUsageText.textContent = formatBytes(totalUsed);
  }

  let freeHint = diskFree;
  if (freeHint === null && diskTotal !== null) {
    if (diskUsed !== null) {
      freeHint = Math.max(diskTotal - diskUsed, 0);
    } else {
      freeHint = Math.max(diskTotal - totalUsed, 0);
    }
  }
  if (Number.isFinite(freeHint)) {
    const parts = [`Free space: ${formatBytes(freeHint)}`];
    if (recycleBinUsed > 0) {
      parts.push(`Recycle bin: ${formatBytes(recycleBinUsed)}`);
    }
    dom.storageHint.textContent = parts.join(" • ");
  } else {
    dom.storageHint.textContent = "Free space: --";
  }

  const progress = hasCapacity && Number.isFinite(effectiveTotal) && effectiveTotal > 0
    ? clamp((totalUsed / effectiveTotal) * 100, 0, 100)
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
  const collectionLabel = state.collection === "saved" ? "saved recordings" : "recordings";

  if (dom.resultsSummary) {
    let summary = "";
    if ((fetchInFlight || !state.lastUpdated) && total === 0 && visibleCount === 0) {
      summary = `Loading ${collectionLabel}…`;
    } else if (connectionState.offline && total === 0 && visibleCount === 0) {
      summary = `Unable to load ${collectionLabel}.`;
    } else if (total === 0) {
      const hasFilters = Boolean(
        state.filters.search || state.filters.day || state.filters.timeRange
      );
      summary = hasFilters
        ? `No ${collectionLabel} match the selected filters.`
        : `No ${collectionLabel} available.`;
    } else if (visibleCount === 0) {
      summary = `No ${collectionLabel} on this page.`;
    } else {
      const start = offset + 1;
      const end = Math.min(offset + visibleCount, total);
      const sizeHint = state.filteredSize > 0 ? formatBytes(state.filteredSize) : null;
      summary = `Showing ${start}–${end} of ${total} ${collectionLabel}${
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

function updateCollectionUI() {
  if (dom.recordingsHeading) {
    dom.recordingsHeading.textContent =
      state.collection === "saved" ? "Saved recordings" : "Recent recordings";
  }
  const recentTab = dom.recordingsTabRecent;
  const savedTab = dom.recordingsTabSaved;
  if (recentTab) {
    const active = state.collection === "recent";
    recentTab.classList.toggle("active", active);
    recentTab.dataset.active = active ? "true" : "false";
    recentTab.setAttribute("aria-selected", active ? "true" : "false");
  }
  if (savedTab) {
    const active = state.collection === "saved";
    savedTab.classList.toggle("active", active);
    savedTab.dataset.active = active ? "true" : "false";
    savedTab.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function hideWaveformRms() {
  if (!dom.waveformRmsRow || !dom.waveformRmsValue) {
    return;
  }
  dom.waveformRmsRow.dataset.active = "false";
  dom.waveformRmsValue.dataset.active = "false";
  dom.waveformRmsValue.textContent = "RMS --";
  dom.waveformRmsValue.setAttribute("aria-hidden", "true");
}

function updateWaveformRms() {
  if (!dom.waveformRmsRow || !dom.waveformRmsValue) {
    return;
  }
  const containerReady = Boolean(dom.waveformContainer && !dom.waveformContainer.hidden);
  const values = waveformState.rmsValues;
  const peakScale = Number.isFinite(waveformState.peakScale) && waveformState.peakScale > 0
    ? waveformState.peakScale
    : null;
  if (!containerReady || !values || values.length === 0 || peakScale === null) {
    hideWaveformRms();
    return;
  }
  const clampedFraction = clamp(waveformState.lastFraction, 0, 1);
  const index = Math.min(values.length - 1, Math.floor(clampedFraction * values.length));
  if (!Number.isFinite(index) || index < 0 || index >= values.length) {
    hideWaveformRms();
    return;
  }
  const ratio = values[index];
  if (!Number.isFinite(ratio) || ratio < 0) {
    hideWaveformRms();
    return;
  }
  const amplitude = ratio * peakScale;
  if (!Number.isFinite(amplitude) || amplitude < 0) {
    hideWaveformRms();
    return;
  }
  const rounded = Math.round(amplitude);
  const formatted = rounded.toLocaleString();
  dom.waveformRmsRow.dataset.active = "true";
  dom.waveformRmsValue.dataset.active = "true";
  dom.waveformRmsValue.textContent = `RMS ${formatted}`;
  dom.waveformRmsValue.setAttribute("aria-hidden", "false");
}

function setCursorFraction(fraction) {
  const clamped = clamp(fraction, 0, 1);
  waveformState.lastFraction = clamped;
  if (dom.waveformCursor) {
    dom.waveformCursor.style.left = `${(clamped * 100).toFixed(3)}%`;
  }
  updateWaveformClock();
  updateWaveformRms();
}

function updateWaveformClock() {
  if (!dom.waveformClock) {
    return;
  }
  const element = dom.waveformClock;
  const parentRow =
    element.parentElement && element.parentElement.classList.contains("waveform-clock-row")
      ? element.parentElement
      : null;
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
    if (parentRow) {
      parentRow.dataset.active = "false";
    }
    return;
  }
  const offsetSeconds = clamp(waveformState.lastFraction, 0, 1) * duration;
  const timestamp = startEpoch + offsetSeconds;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    element.textContent = "--:--:--";
    element.dataset.active = "false";
    element.setAttribute("aria-hidden", "true");
    if (parentRow) {
      parentRow.dataset.active = "false";
    }
    return;
  }
  element.textContent = formatClockTime(timestamp);
  element.dataset.active = "true";
  element.setAttribute("aria-hidden", "false");
  if (parentRow) {
    parentRow.dataset.active = "true";
  }
}

function setWaveformMarker(element, seconds, duration) {
  if (!element) {
    return null;
  }
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) {
    element.dataset.active = "false";
    element.style.left = "0%";
    element.setAttribute("aria-hidden", "true");
    delete element.dataset.align;
    element.style.removeProperty("--marker-label-top");
    return null;
  }
  const fraction = clamp(seconds / duration, 0, 1);
  element.style.left = `${(fraction * 100).toFixed(3)}%`;
  element.dataset.active = "true";
  element.dataset.align = "center";
  element.setAttribute("aria-hidden", "false");
  element.style.removeProperty("--marker-label-top");
  return fraction;
}

function layoutWaveformMarkerLabels(markers) {
  if (!Array.isArray(markers) || markers.length === 0) {
    return;
  }

  const validMarkers = markers.filter(
    (marker) => marker && marker.element && Number.isFinite(marker.fraction)
  );
  if (validMarkers.length === 0) {
    return;
  }

  for (const marker of validMarkers) {
    marker.element.dataset.align = "center";
    marker.element.style.removeProperty("--marker-label-top");
  }

  for (const marker of validMarkers) {
    if (marker.fraction <= MARKER_LABEL_EDGE_THRESHOLD) {
      marker.element.dataset.align = "left";
    } else if (marker.fraction >= 1 - MARKER_LABEL_EDGE_THRESHOLD) {
      marker.element.dataset.align = "right";
    }
  }

  const sortedMarkers = validMarkers.slice().sort((a, b) => a.fraction - b.fraction);
  let cluster = [];

  function applyCluster(entries) {
    if (!entries || entries.length <= 1) {
      return;
    }
    entries.forEach((entry, index) => {
      entry.element.style.setProperty(
        "--marker-label-top",
        `calc(${MARKER_LABEL_BASE_OFFSET_REM}rem + ${index} * ${MARKER_LABEL_STACK_SPACING_REM}rem)`
      );
    });
  }

  for (const marker of sortedMarkers) {
    if (cluster.length === 0) {
      cluster.push(marker);
      continue;
    }
    const previous = cluster[cluster.length - 1];
    if (marker.fraction - previous.fraction <= MARKER_LABEL_SPACING_THRESHOLD) {
      cluster.push(marker);
    } else {
      applyCluster(cluster);
      cluster = [marker];
    }
  }
  applyCluster(cluster);
}

function updateWaveformMarkers() {
  const duration = Number.isFinite(waveformState.duration) && waveformState.duration > 0
    ? waveformState.duration
    : 0;
  if (!state.current || duration <= 0) {
    waveformState.triggerSeconds = null;
    waveformState.releaseSeconds = null;
    waveformState.motionTriggerSeconds = null;
    waveformState.motionReleaseSeconds = null;
    setWaveformMarker(dom.waveformTriggerMarker, null, null);
    setWaveformMarker(dom.waveformMotionStartMarker, null, null);
    setWaveformMarker(dom.waveformMotionEndMarker, null, null);
    setWaveformMarker(dom.waveformReleaseMarker, null, null);
    return;
  }

  const collapseThreshold = MARKER_COLLAPSE_EPSILON_SECONDS;

  let triggerSeconds = toFiniteOrNull(state.current.trigger_offset_seconds);
  if (!Number.isFinite(triggerSeconds)) {
    triggerSeconds = Number.isFinite(configState.prePadSeconds) ? configState.prePadSeconds : null;
  }
  if (Number.isFinite(triggerSeconds)) {
    triggerSeconds = clamp(triggerSeconds, 0, duration);
  } else {
    triggerSeconds = null;
  }

  let releaseSeconds = toFiniteOrNull(state.current.release_offset_seconds);
  if (!Number.isFinite(releaseSeconds)) {
    if (Number.isFinite(configState.postPadSeconds)) {
      const candidate = duration - configState.postPadSeconds;
      if (candidate >= 0 && candidate <= duration) {
        releaseSeconds = candidate;
      }
    }
  }
  if (Number.isFinite(releaseSeconds)) {
    releaseSeconds = clamp(releaseSeconds, 0, duration);
  } else {
    releaseSeconds = null;
  }

  if (
    releaseSeconds !== null &&
    triggerSeconds !== null &&
    Math.abs(releaseSeconds - triggerSeconds) <= collapseThreshold
  ) {
    releaseSeconds = triggerSeconds;
  }

  let motionTriggerSeconds = toFiniteOrNull(state.current.motion_trigger_offset_seconds);
  if (Number.isFinite(motionTriggerSeconds)) {
    motionTriggerSeconds = clamp(motionTriggerSeconds, 0, duration);
  } else {
    motionTriggerSeconds = null;
  }

  let motionReleaseSeconds = toFiniteOrNull(state.current.motion_release_offset_seconds);
  if (Number.isFinite(motionReleaseSeconds)) {
    motionReleaseSeconds = clamp(motionReleaseSeconds, 0, duration);
  } else {
    motionReleaseSeconds = null;
  }

  if (
    motionReleaseSeconds !== null &&
    motionTriggerSeconds !== null &&
    Math.abs(motionReleaseSeconds - motionTriggerSeconds) <= collapseThreshold
  ) {
    motionReleaseSeconds = motionTriggerSeconds;
  }

  if (
    motionReleaseSeconds !== null &&
    motionTriggerSeconds === null &&
    triggerSeconds !== null &&
    Math.abs(motionReleaseSeconds - triggerSeconds) <= collapseThreshold
  ) {
    motionReleaseSeconds = triggerSeconds;
  }

  waveformState.triggerSeconds = triggerSeconds;
  waveformState.releaseSeconds = releaseSeconds;
  waveformState.motionTriggerSeconds = motionTriggerSeconds;
  waveformState.motionReleaseSeconds = motionReleaseSeconds;
  const markersForLayout = [];

  const triggerFraction = setWaveformMarker(dom.waveformTriggerMarker, triggerSeconds, duration);
  if (Number.isFinite(triggerFraction)) {
    markersForLayout.push({ element: dom.waveformTriggerMarker, fraction: triggerFraction });
  }

  const motionTriggerFraction = setWaveformMarker(dom.waveformMotionStartMarker, motionTriggerSeconds, duration);
  if (Number.isFinite(motionTriggerFraction)) {
    markersForLayout.push({ element: dom.waveformMotionStartMarker, fraction: motionTriggerFraction });
  }

  const motionReleaseFraction = setWaveformMarker(dom.waveformMotionEndMarker, motionReleaseSeconds, duration);
  if (Number.isFinite(motionReleaseFraction)) {
    markersForLayout.push({ element: dom.waveformMotionEndMarker, fraction: motionReleaseFraction });
  }

  const releaseFraction = setWaveformMarker(dom.waveformReleaseMarker, releaseSeconds, duration);
  if (Number.isFinite(releaseFraction)) {
    markersForLayout.push({ element: dom.waveformReleaseMarker, fraction: releaseFraction });
  }

  layoutWaveformMarkerLabels(markersForLayout);
}

function updateCursorFromPlayer() {
  if (!dom.waveformContainer || dom.waveformContainer.hidden) {
    return;
  }
  const duration = getPlayerDurationSeconds();
  if (!Number.isFinite(duration) || duration <= 0) {
    setCursorFraction(0);
    return;
  }
  const currentTime = Number.isFinite(dom.player.currentTime)
    ? dom.player.currentTime
    : 0;
  const fraction = clamp(currentTime / duration, 0, 1);
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

function clearWaveformRefresh() {
  if (waveformState.refreshTimer !== null) {
    window.clearTimeout(waveformState.refreshTimer);
    waveformState.refreshTimer = null;
  }
  waveformState.refreshRecordPath = "";
}

function scheduleWaveformRefresh(record) {
  if (!record || !record.isPartial) {
    return;
  }
  const path = typeof record.path === "string" ? record.path : "";
  if (!path) {
    return;
  }

  clearWaveformRefresh();
  waveformState.refreshRecordPath = path;
  waveformState.refreshTimer = window.setTimeout(() => {
    waveformState.refreshTimer = null;
    const current = state.current && state.current.path === path ? state.current : null;
    if (!current) {
      waveformState.refreshRecordPath = "";
      return;
    }
    if (dom.player && !dom.player.paused && !dom.player.ended) {
      scheduleWaveformRefresh(current);
      return;
    }
    loadWaveform(current);
  }, WAVEFORM_REFRESH_INTERVAL_MS);
}

function resetWaveform() {
  stopCursorAnimation();
  clearWaveformRefresh();
  waveformState.peaks = null;
  waveformState.duration = 0;
  waveformState.lastFraction = 0;
  waveformState.triggerSeconds = null;
  waveformState.releaseSeconds = null;
  waveformState.motionTriggerSeconds = null;
  waveformState.motionReleaseSeconds = null;
  waveformState.peakScale = 32767;
  waveformState.startEpoch = null;
  waveformState.rmsValues = null;
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
  setWaveformMarker(dom.waveformMotionStartMarker, null, null);
  setWaveformMarker(dom.waveformMotionEndMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);
  hideWaveformRms();
  if (dom.waveformEmpty) {
    dom.waveformEmpty.hidden = false;
    dom.waveformEmpty.textContent = "Select a recording to render its waveform.";
  }
  if (dom.waveformStatus) {
    dom.waveformStatus.textContent = "";
  }
  updateWaveformClock();
}

function getWaveformZoomLimits() {
  let min = WAVEFORM_ZOOM_MIN;
  let max = WAVEFORM_ZOOM_MAX;
  const input = dom.waveformZoomInput;
  if (input) {
    const parsedMin = Number.parseFloat(input.min);
    if (Number.isFinite(parsedMin) && parsedMin > 0) {
      min = parsedMin;
    }
    const parsedMax = Number.parseFloat(input.max);
    if (Number.isFinite(parsedMax) && parsedMax > 0) {
      max = parsedMax;
    }
  }
  if (!(max > min)) {
    min = WAVEFORM_ZOOM_MIN;
    max = WAVEFORM_ZOOM_MAX;
  }
  return { min, max };
}

function normalizeWaveformZoom(value) {
  const { min, max } = getWaveformZoomLimits();
  const fallback = WAVEFORM_ZOOM_DEFAULT;
  const candidate = Number.isFinite(value) && value > 0 ? value : fallback;
  return clamp(candidate, min, max);
}

function readStoredWaveformPreferences() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
  } catch (error) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(WAVEFORM_STORAGE_KEY);
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

function persistWaveformPreferences() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
  } catch (error) {
    return;
  }
  try {
    const normalized = normalizeWaveformZoom(waveformState.amplitudeScale);
    const payload = { amplitudeScale: normalized };
    window.localStorage.setItem(WAVEFORM_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore persistence errors */
  }
}

function restoreWaveformPreferences() {
  const stored = readStoredWaveformPreferences();
  if (!stored || typeof stored !== "object") {
    return;
  }
  const rawValue = Number.parseFloat(stored.amplitudeScale ?? stored.zoom);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return;
  }
  waveformState.amplitudeScale = normalizeWaveformZoom(rawValue);
}

function formatWaveformZoom(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return `${WAVEFORM_ZOOM_DEFAULT}×`;
  }
  const decimals = value < 1 ? 2 : 1;
  const fixed = value.toFixed(decimals);
  const trimmed = Number.parseFloat(fixed).toString();
  return `${trimmed}×`;
}

function updateWaveformZoomDisplay(scale) {
  const formatted = formatWaveformZoom(scale);
  if (dom.waveformZoomValue) {
    dom.waveformZoomValue.textContent = formatted;
  }
  if (dom.waveformZoomInput) {
    dom.waveformZoomInput.setAttribute("aria-valuetext", formatted);
  }
}

function getWaveformAmplitudeScale() {
  const normalized = normalizeWaveformZoom(waveformState.amplitudeScale);
  waveformState.amplitudeScale = normalized;
  return normalized;
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
  const gain = getWaveformAmplitudeScale();
  const denom = sampleCount > 1 ? sampleCount - 1 : 1;

  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const peak = peaks[i * 2 + 1];
    const scaled = clamp(peak * gain, -1, 1);
    const y = mid - scaled * amplitude;
    ctx.lineTo(x, y);
  }
  for (let i = sampleCount - 1; i >= 0; i -= 1) {
    const x = (i / denom) * width;
    const trough = peaks[i * 2];
    const scaled = clamp(trough * gain, -1, 1);
    const y = mid - scaled * amplitude;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(56, 189, 248, 0.28)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const peak = peaks[i * 2 + 1];
    const scaled = clamp(peak * gain, -1, 1);
    const y = mid - scaled * amplitude;
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
    const scaled = clamp(trough * gain, -1, 1);
    const y = mid - scaled * amplitude;
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
  ensurePreviewSectionOrder();
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

  if (dom.clipperContainer) {
    dom.clipperContainer.dataset.busy = clipperState.busy ? "true" : "false";
  }
  if (dom.clipperForm) {
    dom.clipperForm.setAttribute("aria-busy", clipperState.busy ? "true" : "false");
  }
  if (dom.clipperSubmit) {
    if (!dom.clipperSubmit.dataset.defaultLabel) {
      dom.clipperSubmit.dataset.defaultLabel = dom.clipperSubmit.textContent
        ? dom.clipperSubmit.textContent.trim()
        : "Save clip";
    }
    dom.clipperSubmit.disabled = clipperState.busy || !valid;
    dom.clipperSubmit.setAttribute("aria-busy", clipperState.busy ? "true" : "false");
    dom.clipperSubmit.textContent = clipperState.busy
      ? "Saving clip…"
      : dom.clipperSubmit.dataset.defaultLabel;
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
  if (isRecycleBinRecord(record)) {
    clipperState.durationSeconds = null;
    clipperState.startSeconds = 0;
    clipperState.endSeconds = 0;
    clipperState.busy = false;
    clipperState.status = "";
    clipperState.statusState = "idle";
    clipperState.nameDirty = false;
    clipperState.lastRecordPath = null;
    clipperState.overwriteExisting = true;
    if (dom.clipperOverwriteToggle) {
      dom.clipperOverwriteToggle.checked = true;
    }
    setClipperVisible(false);
    updateClipperStatusElement();
    return;
  }
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
  clearWaveformRefresh();
  if (!record) {
    resetWaveform();
    return;
  }
  const waveformUrl = recordWaveformUrl(record);
  if (!waveformUrl) {
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
  waveformState.motionTriggerSeconds = null;
  waveformState.motionReleaseSeconds = null;
  waveformState.startEpoch = null;
  waveformState.rmsValues = null;
  setWaveformMarker(dom.waveformTriggerMarker, null, null);
  setWaveformMarker(dom.waveformMotionStartMarker, null, null);
  setWaveformMarker(dom.waveformMotionEndMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);
  hideWaveformRms();

  try {
    const response = await fetch(waveformUrl, {
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

    let normalizedRms = null;
    if (
      Array.isArray(payload.rms_values) &&
      payload.rms_values.length > 0 &&
      Number.isFinite(peakScale) &&
      peakScale > 0
    ) {
      const bucketCount = Math.min(sampleCount, payload.rms_values.length);
      normalizedRms = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        if (i < bucketCount) {
          const rawValue = Number(payload.rms_values[i]);
          if (Number.isFinite(rawValue)) {
            normalizedRms[i] = clamp(Math.abs(rawValue) / peakScale, 0, 1);
          } else {
            normalizedRms[i] = 0;
          }
        } else {
          normalizedRms[i] = 0;
        }
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
    waveformState.rmsValues = normalizedRms;
    record.duration_seconds = effectiveDuration;
    record.motion_trigger_offset_seconds = toFiniteOrNull(
      payload.motion_trigger_offset_seconds
    );
    record.motion_release_offset_seconds = toFiniteOrNull(
      payload.motion_release_offset_seconds
    );
    record.motion_started_epoch = toFiniteOrNull(payload.motion_started_epoch);
    record.motion_released_epoch = toFiniteOrNull(payload.motion_released_epoch);

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
    updateWaveformRms();
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

    if (waveformState.requestId === requestId) {
      scheduleWaveformRefresh(record);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.error("Failed to load waveform", error);
    if (waveformState.requestId === requestId) {
      waveformState.peaks = null;
      waveformState.duration = 0;
      waveformState.startEpoch = null;
      waveformState.rmsValues = null;
      dom.waveformContainer.hidden = true;
      dom.waveformContainer.dataset.ready = "false";
      dom.waveformEmpty.hidden = false;
      dom.waveformEmpty.textContent = "Waveform unavailable for this recording.";
      if (dom.waveformStatus) {
        dom.waveformStatus.textContent = "";
      }
      updateWaveformClock();
      hideWaveformRms();
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
  const duration = getPlayerDurationSeconds();
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  dom.player.currentTime = fraction * duration;
  setCursorFraction(fraction);
}

function handleWaveformPointerDown(event) {
  event.stopPropagation();
  focusPreviewSurface();
  const duration = getPlayerDurationSeconds();
  if (!Number.isFinite(duration) || duration <= 0) {
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
  const duration = getPlayerDurationSeconds();
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
  const duration = getPlayerDurationSeconds();
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
  if (!dom.player || !hasPlayableSource(dom.player)) {
    return false;
  }
  const duration = getPlayerDurationSeconds();
  return Number.isFinite(duration) && duration > 0;
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
      const duration = getPlayerDurationSeconds();
      if (Number.isFinite(duration) && duration > 0) {
        const currentTime = Number.isFinite(dom.player.currentTime) ? dom.player.currentTime : 0;
        const offset = transportState.direction * KEYBOARD_JOG_RATE_SECONDS_PER_SECOND * deltaSeconds;
        const nextTime = clamp(currentTime + offset, 0, duration);
        dom.player.currentTime = nextTime;
        updateCursorFromPlayer();
      }
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

function selectAdjacentRecycleBinItem(offset) {
  if (!Number.isFinite(offset) || offset === 0) {
    return false;
  }
  const items = state.recycleBin.items;
  if (!Array.isArray(items) || items.length === 0) {
    return false;
  }

  const currentId = state.recycleBin.activeId;
  let index = -1;
  if (typeof currentId === "string" && currentId) {
    index = items.findIndex((entry) => entry && entry.id === currentId);
  }

  let nextIndex;
  if (index === -1) {
    nextIndex = offset > 0 ? 0 : items.length - 1;
  } else {
    nextIndex = clamp(index + offset, 0, items.length - 1);
  }

  if (nextIndex === index || nextIndex < 0 || nextIndex >= items.length) {
    return false;
  }

  const nextItem = items[nextIndex];
  if (!nextItem || typeof nextItem.id !== "string" || !nextItem.id) {
    return false;
  }
  state.recycleBin.selected = new Set([nextItem.id]);
  state.recycleBin.activeId = nextItem.id;
  state.recycleBin.anchorId = nextItem.id;
  persistRecycleBinState();
  renderRecycleBinItems();
  const row = getRecycleBinRow(nextItem.id);
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

  if (state.recycleBin.open) {
    const handled = handleRecycleBinTransportKeydown(event);
    if (handled) {
      return;
    }
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

function handleRecycleBinTransportKeydown(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const isUp = isArrowKey(event, "ArrowUp");
  const isDown = isArrowKey(event, "ArrowDown");
  if (!isUp && !isDown) {
    return false;
  }
  if (shouldIgnoreSpacebarTarget(event.target)) {
    return false;
  }
  const moved = selectAdjacentRecycleBinItem(isDown ? 1 : -1);
  if (moved) {
    event.preventDefault();
    return true;
  }
  return false;
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

function setCollection(nextCollection, options = {}) {
  const { force = false, fetch = true } = options;
  const normalized = nextCollection === "saved" ? "saved" : "recent";
  if (state.collection === normalized && !force) {
    if (fetch) {
      fetchRecordings({ silent: false, force: true });
    }
    return;
  }

  state.collection = normalized;
  persistCollection();
  state.offset = 0;
  state.selections.clear();
  state.selectionAnchor = "";
  state.selectionFocus = "";
  updateSelectionUI();
  setNowPlaying(null, { autoplay: false, resetToStart: true });
  updateCollectionUI();
  applyNowPlayingHighlight();
  if (fetch) {
    fetchRecordings({ silent: false, force: true });
  }
}

async function fetchRecordings(options = {}) {
  const { silent = false, force = false } = options;
  if (state.recycleBin.open && !force) {
    recordingsRefreshDeferred = true;
    return;
  }
  recordingsRefreshDeferred = false;
  if (fetchInFlight) {
    fetchQueued = true;
    return;
  }
  fetchInFlight = true;

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
  if (state.filters.timeRange) {
    params.set("time_range", state.filters.timeRange);
  }
  params.set("limit", String(limit));
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  params.set("collection", state.collection === "saved" ? "saved" : "recent");

  const endpoint = apiPath(`/api/recordings?${params.toString()}`);
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    const payloadCollectionRaw =
      typeof payload.collection === "string" ? payload.collection.trim().toLowerCase() : "";
    const payloadCollection = payloadCollectionRaw === "saved" ? "saved" : "recent";
    if (state.collection !== payloadCollection) {
      state.collection = payloadCollection;
      persistCollection();
    }
    updateCollectionUI();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const normalizedRecords = items.map((item) => {
      const { startEpoch, startedEpoch, startedAt } = normalizeStartTimestamps(item);
      return {
        ...item,
        size_bytes: numericValue(item.size_bytes, 0),
        modified: numericValue(item.modified, 0),
        duration_seconds: Number.isFinite(item.duration_seconds)
          ? Number(item.duration_seconds)
          : null,
        start_epoch: startEpoch,
        started_epoch: startedEpoch,
        started_at: startedAt,
        trigger_offset_seconds: toFiniteOrNull(item.trigger_offset_seconds),
        release_offset_seconds: toFiniteOrNull(item.release_offset_seconds),
        motion_trigger_offset_seconds: toFiniteOrNull(
          item.motion_trigger_offset_seconds
        ),
        motion_release_offset_seconds: toFiniteOrNull(
          item.motion_release_offset_seconds
        ),
        motion_started_epoch: toFiniteOrNull(item.motion_started_epoch),
        motion_released_epoch: toFiniteOrNull(item.motion_released_epoch),
        waveform_path:
          typeof item.waveform_path === "string" && item.waveform_path
            ? String(item.waveform_path)
            : null,
      };
    });
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
    const payloadTimeRange =
      typeof payload.time_range === "string" && VALID_TIME_RANGES.has(payload.time_range)
        ? payload.time_range
        : "";
    if (payloadTimeRange !== state.filters.timeRange) {
      state.filters = {
        ...state.filters,
        timeRange: payloadTimeRange,
      };
      persistFilters();
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
    const motionState =
      payload.motion_state && typeof payload.motion_state === "object"
        ? payload.motion_state
        : null;
    state.motionState = motionState;
    const captureStatus = payload.capture_status;
    state.captureStatus = captureStatus && typeof captureStatus === "object" ? captureStatus : null;
    const previousPartialFingerprint = state.partialFingerprint;
    const nextPartial = deriveInProgressRecord(captureStatus);
    const nextPartialFingerprint = computePartialFingerprint(nextPartial);
    const partialChanged = previousPartialFingerprint !== nextPartialFingerprint;
    state.partialRecord = nextPartial;
    state.partialFingerprint = nextPartialFingerprint;
    if (nextPartial) {
      state.selections.delete(nextPartial.path);
    }
    state.total = total;
    state.filteredSize = totalSize;
    state.storage.recordings = numericValue(payload.recordings_total_bytes, totalSize);
    state.storage.recycleBin = numericValue(payload.recycle_bin_total_bytes, 0);
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

    const previewingRecycleRecord = isRecycleBinRecord(state.current);

    if (maintainCurrentSelection && state.current && !previewingRecycleRecord) {
      const current = state.records.find((entry) => entry.path === state.current.path);
      if (current) {
        state.current = current;
        const playbackInfo = updatePlaybackSourceForRecord(current, { preserveMode: true });
        updatePlayerMeta(current);
        updateWaveformMarkers();
        clipperState.durationSeconds = toFiniteOrNull(current.duration_seconds);
        updateClipperUI();
        if (playbackInfo.previousMode === "raw" && playbackInfo.nextMode !== "raw") {
          setPlaybackSource(playbackInfo.nextMode, { force: true });
        } else if (playbackInfo.nextMode === "raw" && playbackInfo.rawPathChanged) {
          setPlaybackSource("raw", { force: true });
        }
      } else {
        const partialPath = nextPartial ? nextPartial.path : null;
        if (state.current.isPartial && partialPath === state.current.path) {
          state.current = nextPartial;
          const partialPlayback = updatePlaybackSourceForRecord(nextPartial, { preserveMode: true });
          updatePlayerMeta(nextPartial);
          if (partialPlayback.previousMode === "raw" && partialPlayback.nextMode !== "raw") {
            setPlaybackSource(partialPlayback.nextMode, { force: true });
          } else if (partialPlayback.nextMode === "raw" && partialPlayback.rawPathChanged) {
            setPlaybackSource("raw", { force: true });
          }
        } else {
          setNowPlaying(null);
        }
      }
    }

    if (!nextPartial && state.current && state.current.isPartial) {
      setNowPlaying(null);
    } else if (nextPartial && state.current && state.current.isPartial) {
      state.current = nextPartial;
      const nextPlayback = updatePlaybackSourceForRecord(nextPartial, { preserveMode: true });
      updatePlayerMeta(nextPartial);
      if (nextPlayback.previousMode === "raw" && nextPlayback.nextMode !== "raw") {
        setPlaybackSource(nextPlayback.nextMode, { force: true });
      } else if (nextPlayback.nextMode === "raw" && nextPlayback.rawPathChanged) {
        setPlaybackSource("raw", { force: true });
      }
    }

    if (recordsChanged || partialChanged) {
      renderRecords();
    } else {
      updateSelectionUI();
      applyNowPlayingHighlight();
      syncPlayerPlacement();
    }
    updateStats();
    updatePaginationControls();
    setRecordingIndicatorStatus(payload.capture_status, motionState);
    updateRmsIndicator(payload.capture_status);
    updateRecordingMeta(payload.capture_status);
    updateEncodingStatus(payload.capture_status);
    updateSplitEventButton(captureStatus);
    updateManualRecordButton(captureStatus);
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
    state.motionState = null;
    renderRecords();
    updateStats();
    updatePaginationControls();
    handleFetchFailure();
    setRecordingIndicatorUnknown();
    hideRmsIndicator();
    if (dom.lastUpdated) {
      dom.lastUpdated.textContent = "Offline";
    }
    state.captureStatus = null;
    setSplitEventDisabled(true, "Recorder offline.");
    manualRecordState.enabled = false;
    manualRecordState.pending = false;
    setManualRecordDisabled(true, "Recorder status unavailable.");
    setManualRecordButtonState(false);
    fetchQueued = false;
  } finally {
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

function parseMotionFlag(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["1", "true", "yes", "on", "running"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", "stopped"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function isMotionTriggeredEvent(source) {
  if (!source || typeof source !== "object") {
    return false;
  }

  const motionTrigger = toFiniteOrNull(source.motion_trigger_offset_seconds);
  if (Number.isFinite(motionTrigger)) {
    return true;
  }

  const motionReleaseOffset = toFiniteOrNull(source.motion_release_offset_seconds);
  if (Number.isFinite(motionReleaseOffset)) {
    return true;
  }

  const motionStarted = toFiniteOrNull(source.motion_started_epoch);
  if (Number.isFinite(motionStarted)) {
    return true;
  }

  const motionReleased = toFiniteOrNull(source.motion_released_epoch);
  if (Number.isFinite(motionReleased)) {
    return true;
  }

  const motionActive = parseBoolean(source.motion_active);
  if (motionActive === true) {
    return true;
  }

  const motionSequence = toFiniteOrNull(source.motion_sequence);
  if (Number.isFinite(motionSequence) && motionSequence > 0 && motionActive !== false) {
    return true;
  }

  return false;
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
  denoise: {
    noise_floor_db: { min: -80, max: 0, formatter: formatDbDisplay },
  },
  highpass: {
    cutoff_hz: { min: 20, max: 2000, formatter: formatHzDisplay },
  },
  lowpass: {
    cutoff_hz: { min: 1000, max: 20000, formatter: formatHzDisplay },
  },
  notch: {
    freq_hz: { min: 20, max: 20000, formatter: formatHzDisplay },
    quality: { min: 0.1, max: 100, formatter: formatQualityDisplay },
  },
  spectral_gate: {
    sensitivity: { min: 0.1, max: 4, formatter: formatUnitless },
    reduction_db: { min: -60, max: 0, formatter: formatDbDisplay },
    noise_update: { min: 0, max: 1, formatter: formatRatioDisplay },
    noise_decay: { min: 0, max: 1, formatter: formatRatioDisplay },
  },
};

const AUDIO_FILTER_ENUMS = {
  denoise: {
    type: new Set(["afftdn"]),
  },
};

const AUDIO_FILTER_DEFAULTS = {
  denoise: { enabled: false, type: "afftdn", noise_floor_db: -30 },
  highpass: { enabled: false, cutoff_hz: 90 },
  lowpass: { enabled: false, cutoff_hz: 10000 },
  notch: { enabled: false, freq_hz: 60, quality: 30 },
  spectral_gate: {
    enabled: false,
    sensitivity: 1.5,
    reduction_db: -18,
    noise_update: 0.1,
    noise_decay: 0.95,
  },
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
      denoise: { ...AUDIO_FILTER_DEFAULTS.denoise },
      highpass: { ...AUDIO_FILTER_DEFAULTS.highpass },
      lowpass: { ...AUDIO_FILTER_DEFAULTS.lowpass },
      notch: { ...AUDIO_FILTER_DEFAULTS.notch },
      spectral_gate: { ...AUDIO_FILTER_DEFAULTS.spectral_gate },
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
    for (const [stage, fieldSpecs] of Object.entries(AUDIO_FILTER_LIMITS)) {
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
      for (const [field, spec] of Object.entries(fieldSpecs)) {
        if (!Object.prototype.hasOwnProperty.call(stagePayload, field)) {
          continue;
        }
        const rawValue = Number(stagePayload[field]);
        if (Number.isFinite(rawValue)) {
          const clamped = Math.min(spec.max, Math.max(spec.min, rawValue));
          stageTarget[field] = clamped;
        }
      }
      const enumSpecs = AUDIO_FILTER_ENUMS[stage];
      if (enumSpecs && typeof enumSpecs === "object") {
        for (const [field, allowed] of Object.entries(enumSpecs)) {
          if (!Object.prototype.hasOwnProperty.call(stagePayload, field)) {
            continue;
          }
          const rawValue = stagePayload[field];
          if (typeof rawValue !== "string") {
            continue;
          }
          const normalized = rawValue.trim().toLowerCase();
          if (allowed instanceof Set && allowed.has(normalized)) {
            stageTarget[field] = normalized;
          }
        }
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

function formatUnitless(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const decimals = numeric < 1 ? 2 : 1;
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatQualityDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const decimals = numeric < 10 ? 1 : 0;
  const formatted = numeric.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `Q ${formatted}`;
}

function formatRatioDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const clamped = Math.min(1, Math.max(0, numeric));
  return clamped.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function updateAudioFilterControls() {
  const section = recorderDom.sections ? recorderDom.sections.audio : null;
  if (!section) {
    return;
  }

  const stages = [
    {
      toggle: section.filterDenoiseEnabled,
      inputs: [
        {
          control: section.filterDenoiseFloor,
          display: section.filterDenoiseFloorDisplay,
          formatter: formatDbDisplay,
        },
        {
          control: section.filterDenoiseType,
        },
      ],
    },
    {
      toggle: section.filterHighpassEnabled,
      inputs: [
        {
          control: section.filterHighpassCutoff,
          display: section.filterHighpassDisplay,
          formatter: formatHzDisplay,
        },
      ],
    },
    {
      toggle: section.filterLowpassEnabled,
      inputs: [
        {
          control: section.filterLowpassCutoff,
          display: section.filterLowpassDisplay,
          formatter: formatHzDisplay,
        },
      ],
    },
    {
      toggle: section.filterNotchEnabled,
      inputs: [
        {
          control: section.filterNotchFrequency,
          display: section.filterNotchFrequencyDisplay,
          formatter: formatHzDisplay,
        },
        {
          control: section.filterNotchQuality,
          display: section.filterNotchQualityDisplay,
          formatter: formatQualityDisplay,
        },
      ],
    },
    {
      toggle: section.filterSpectralGateEnabled,
      inputs: [
        {
          control: section.filterSpectralGateSensitivity,
          display: section.filterSpectralGateSensitivityDisplay,
          formatter: formatUnitless,
        },
        {
          control: section.filterSpectralGateReduction,
          display: section.filterSpectralGateReductionDisplay,
          formatter: formatDbDisplay,
        },
        {
          control: section.filterSpectralGateNoiseUpdate,
          display: section.filterSpectralGateNoiseUpdateDisplay,
          formatter: formatRatioDisplay,
        },
        {
          control: section.filterSpectralGateNoiseDecay,
          display: section.filterSpectralGateNoiseDecayDisplay,
          formatter: formatRatioDisplay,
        },
      ],
    },
  ];

  for (const stage of stages) {
    const toggle = stage.toggle;
    const enabled =
      toggle instanceof HTMLInputElement && toggle.type === "checkbox"
        ? toggle.checked
        : true;
    for (const item of stage.inputs) {
      const { control, display, formatter } = item;
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) {
        continue;
      }
      control.disabled = !enabled;
      if (display instanceof HTMLElement && typeof formatter === "function") {
        display.textContent = formatter(control.value);
      }
    }
  }

  if (section.calibrateNoiseButton instanceof HTMLButtonElement) {
    const enabled = section.calibrationNoise instanceof HTMLInputElement ? section.calibrationNoise.checked : true;
    section.calibrateNoiseButton.disabled = !enabled;
    const hint = section.calibrationNoiseHint;
    if (hint instanceof HTMLElement) {
      hint.hidden = enabled;
      hint.setAttribute("aria-hidden", enabled ? "true" : "false");
    }
  }
}

function segmenterDefaults() {
  return {
    pre_pad_ms: 2000,
    post_pad_ms: 3000,
    motion_release_padding_minutes: 0,
    rms_threshold: 300,
    keep_window_frames: 30,
    start_consecutive: 25,
    keep_consecutive: 25,
    flush_threshold_bytes: 128 * 1024,
    max_queue_frames: 512,
    min_clip_seconds: 0,
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

  function toFloat(value, fallback, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    let candidate = number;
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
  defaults.motion_release_padding_minutes = toFloat(
    source.motion_release_padding_minutes,
    defaults.motion_release_padding_minutes,
    { min: 0, max: 30 }
  );
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
  defaults.min_clip_seconds = toFloat(
    source.min_clip_seconds,
    defaults.min_clip_seconds,
    { min: 0, max: 600 }
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
    min_rms: null,
    min_thresh: 0.01,
    max_rms: null,
    max_thresh: 1,
    margin: 1.2,
    update_interval_sec: 5.0,
    window_sec: 10.0,
    hysteresis_tolerance: 0.1,
    release_percentile: 0.5,
    voiced_hold_sec: 6.0,
  };
}

function canonicalAdaptiveSettings(settings) {
  const defaults = adaptiveDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  function parseOptionalRms(value, fallback) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string" && value.trim() === "") {
      return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    const rounded = Math.round(number);
    if (rounded <= 0) {
      return null;
    }
    return Math.min(32767, rounded);
  }

  function clampFloat(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  defaults.min_thresh = clampFloat(source.min_thresh, defaults.min_thresh, 0, 1);
  defaults.max_thresh = clampFloat(source.max_thresh, defaults.max_thresh, 0, 1);
  defaults.max_rms = parseOptionalRms(source.max_rms, defaults.max_rms);
  defaults.min_rms = parseOptionalRms(source.min_rms, defaults.min_rms);
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
  defaults.voiced_hold_sec = clampFloat(
    source.voiced_hold_sec,
    defaults.voiced_hold_sec,
    0,
    300
  );

  if (defaults.max_thresh < defaults.min_thresh) {
    defaults.max_thresh = defaults.min_thresh;
  }

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

function getRecorderSectionLabel(key) {
  if (typeof key !== "string" || !key) {
    return "section";
  }
  const safeKey = key.replace(/"/g, '\\"');
  const selector = `.recorder-section[data-section-key="${safeKey}"] .settings-section-title`;
  const heading = document.querySelector(selector);
  if (heading && heading.textContent) {
    return heading.textContent.trim();
  }
  return key.replace(/_/g, " ");
}

function setRecorderSaveAllStatus(text, state, options = {}) {
  const statusElement = recorderDom.saveAllStatus;
  if (!statusElement) {
    return;
  }

  if (recorderSaveAllState.statusTimeoutId) {
    window.clearTimeout(recorderSaveAllState.statusTimeoutId);
    recorderSaveAllState.statusTimeoutId = null;
  }

  const message = typeof text === "string" ? text : "";
  statusElement.textContent = message;
  if (state) {
    statusElement.dataset.state = state;
  } else if (statusElement.dataset.state) {
    delete statusElement.dataset.state;
  }
  statusElement.setAttribute("aria-hidden", message ? "false" : "true");

  if (!message || !options.autoHide) {
    return;
  }

  const duration = typeof options.duration === "number" ? Math.max(1000, options.duration) : 3200;
  recorderSaveAllState.statusTimeoutId = window.setTimeout(() => {
    recorderSaveAllState.statusTimeoutId = null;
    statusElement.textContent = "";
    if (statusElement.dataset.state) {
      delete statusElement.dataset.state;
    }
    statusElement.setAttribute("aria-hidden", "true");
  }, duration);
}

function getDirtyRecorderSectionKeys() {
  const dirty = [];
  for (const [key, section] of recorderState.sections.entries()) {
    if (section.state.dirty) {
      dirty.push(key);
    }
  }
  return dirty;
}

function updateSaveAllButtonState() {
  const button = recorderDom.saveAll;
  if (!button) {
    return;
  }
  const anySectionSaving = Array.from(recorderState.sections.values()).some((section) => section.state.saving);
  const dirtyKeys = getDirtyRecorderSectionKeys();
  const disable =
    recorderSaveAllState.saving ||
    anySectionSaving ||
    dirtyKeys.length === 0;

  button.disabled = disable;
  button.setAttribute("aria-busy", recorderSaveAllState.saving ? "true" : "false");
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
  updateSaveAllButtonState();
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

async function saveAllRecorderSections() {
  if (recorderSaveAllState.saving) {
    return;
  }
  const dirtyKeys = getDirtyRecorderSectionKeys();
  if (dirtyKeys.length === 0) {
    return;
  }

  recorderSaveAllState.saving = true;
  updateSaveAllButtonState();
  setRecorderSaveAllStatus("Saving all changes…", "pending");

  const failures = [];
  for (const key of dirtyKeys) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await saveRecorderSection(key);
    if (!ok) {
      failures.push(key);
    }
  }

  recorderSaveAllState.saving = false;
  updateSaveAllButtonState();

  if (failures.length === 0) {
    setRecorderSaveAllStatus("Saved all pending changes.", "success", { autoHide: true, duration: 3600 });
    return;
  }

  const labels = failures.map((key) => getRecorderSectionLabel(key)).join(", ");
  if (failures.length === dirtyKeys.length) {
    setRecorderSaveAllStatus("Unable to save any sections. Check the errors above.", "error");
  } else {
    setRecorderSaveAllStatus(`Saved some changes, but ${labels} failed. Check the errors above.`, "warning");
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
    return true;
  }
  if (typeof section.options.read !== "function" || !section.options.endpoint) {
    return false;
  }

  const payload = section.options.read();
  section.state.saving = true;
  updateRecorderButtons(key);
  setRecorderStatus(key, "Saving…", "pending");

  let success = true;
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
    success = false;
  } finally {
    section.state.saving = false;
    updateRecorderButtons(key);
  }
  return success;
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
  if (section.filterDenoiseEnabled) {
    section.filterDenoiseEnabled.checked = Boolean(filters.denoise && filters.denoise.enabled);
  }
  if (section.filterDenoiseType && filters.denoise && typeof filters.denoise.type === "string") {
    section.filterDenoiseType.value = filters.denoise.type;
  }
  if (
    section.filterDenoiseFloor &&
    filters.denoise &&
    typeof filters.denoise.noise_floor_db === "number"
  ) {
    section.filterDenoiseFloor.value = String(filters.denoise.noise_floor_db);
  }
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
  if (section.filterNotchEnabled) {
    section.filterNotchEnabled.checked = Boolean(filters.notch && filters.notch.enabled);
  }
  if (section.filterNotchFrequency && filters.notch && typeof filters.notch.freq_hz === "number") {
    section.filterNotchFrequency.value = String(filters.notch.freq_hz);
  }
  if (section.filterNotchQuality && filters.notch && typeof filters.notch.quality === "number") {
    section.filterNotchQuality.value = String(filters.notch.quality);
  }
  if (section.filterSpectralGateEnabled) {
    section.filterSpectralGateEnabled.checked = Boolean(
      filters.spectral_gate && filters.spectral_gate.enabled
    );
  }
  if (
    section.filterSpectralGateSensitivity &&
    filters.spectral_gate &&
    typeof filters.spectral_gate.sensitivity === "number"
  ) {
    section.filterSpectralGateSensitivity.value = String(filters.spectral_gate.sensitivity);
  }
  if (
    section.filterSpectralGateReduction &&
    filters.spectral_gate &&
    typeof filters.spectral_gate.reduction_db === "number"
  ) {
    section.filterSpectralGateReduction.value = String(filters.spectral_gate.reduction_db);
  }
  if (
    section.filterSpectralGateNoiseUpdate &&
    filters.spectral_gate &&
    typeof filters.spectral_gate.noise_update === "number"
  ) {
    section.filterSpectralGateNoiseUpdate.value = String(filters.spectral_gate.noise_update);
  }
  if (
    section.filterSpectralGateNoiseDecay &&
    filters.spectral_gate &&
    typeof filters.spectral_gate.noise_decay === "number"
  ) {
    section.filterSpectralGateNoiseDecay.value = String(filters.spectral_gate.noise_decay);
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
      denoise: {
        enabled: section.filterDenoiseEnabled ? section.filterDenoiseEnabled.checked : false,
        type: section.filterDenoiseType ? section.filterDenoiseType.value : undefined,
        noise_floor_db: section.filterDenoiseFloor
          ? Number(section.filterDenoiseFloor.value)
          : undefined,
      },
      highpass: {
        enabled: section.filterHighpassEnabled ? section.filterHighpassEnabled.checked : false,
        cutoff_hz: section.filterHighpassCutoff ? Number(section.filterHighpassCutoff.value) : undefined,
      },
      lowpass: {
        enabled: section.filterLowpassEnabled ? section.filterLowpassEnabled.checked : false,
        cutoff_hz: section.filterLowpassCutoff ? Number(section.filterLowpassCutoff.value) : undefined,
      },
      notch: {
        enabled: section.filterNotchEnabled ? section.filterNotchEnabled.checked : false,
        freq_hz: section.filterNotchFrequency ? Number(section.filterNotchFrequency.value) : undefined,
        quality: section.filterNotchQuality ? Number(section.filterNotchQuality.value) : undefined,
      },
      spectral_gate: {
        enabled: section.filterSpectralGateEnabled ? section.filterSpectralGateEnabled.checked : false,
        sensitivity: section.filterSpectralGateSensitivity
          ? Number(section.filterSpectralGateSensitivity.value)
          : undefined,
        reduction_db: section.filterSpectralGateReduction
          ? Number(section.filterSpectralGateReduction.value)
          : undefined,
        noise_update: section.filterSpectralGateNoiseUpdate
          ? Number(section.filterSpectralGateNoiseUpdate.value)
          : undefined,
        noise_decay: section.filterSpectralGateNoiseDecay
          ? Number(section.filterSpectralGateNoiseDecay.value)
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
    [section.motionPaddingMinutes, data.motion_release_padding_minutes],
    [section.threshold, data.rms_threshold],
    [section.keepWindow, data.keep_window_frames],
    [section.startConsecutive, data.start_consecutive],
    [section.keepConsecutive, data.keep_consecutive],
    [section.flushBytes, data.flush_threshold_bytes],
    [section.maxQueue, data.max_queue_frames],
    [section.minClipSeconds, data.min_clip_seconds],
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
    motion_release_padding_minutes: section.motionPaddingMinutes
      ? Number(section.motionPaddingMinutes.value)
      : undefined,
    rms_threshold: section.threshold ? Number(section.threshold.value) : undefined,
    keep_window_frames: section.keepWindow ? Number(section.keepWindow.value) : undefined,
    start_consecutive: section.startConsecutive ? Number(section.startConsecutive.value) : undefined,
    keep_consecutive: section.keepConsecutive ? Number(section.keepConsecutive.value) : undefined,
    flush_threshold_bytes: section.flushBytes ? Number(section.flushBytes.value) : undefined,
    max_queue_frames: section.maxQueue ? Number(section.maxQueue.value) : undefined,
    min_clip_seconds: section.minClipSeconds ? Number(section.minClipSeconds.value) : undefined,
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
  if (section.minRms) {
    section.minRms.value =
      data.min_rms === null || data.min_rms === undefined ? "" : String(data.min_rms);
  }
  if (section.minThresh) {
    section.minThresh.value = String(data.min_thresh);
  }
  section.maxThreshValue = typeof data.max_thresh === "number" ? data.max_thresh : undefined;
  if (section.maxRms) {
    section.maxRms.value =
      data.max_rms === null || data.max_rms === undefined ? "" : String(data.max_rms);
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
  if (section.voicedHold) {
    section.voicedHold.value = String(data.voiced_hold_sec);
  }
}

function readAdaptiveForm() {
  const section = recorderDom.sections.adaptive_rms;
  if (!section) {
    return adaptiveDefaults();
  }
  const payload = {
    enabled: section.enabled ? section.enabled.checked : false,
    min_rms: section.minRms
      ? section.minRms.value.trim() === ""
        ? null
        : Number(section.minRms.value)
      : undefined,
    min_thresh: section.minThresh
      ? section.minThresh.value.trim() === ""
        ? undefined
        : Number(section.minThresh.value)
      : undefined,
    max_thresh:
      typeof section.maxThreshValue === "number" ? section.maxThreshValue : undefined,
    max_rms: section.maxRms
      ? section.maxRms.value.trim() === ""
        ? null
        : Number(section.maxRms.value)
      : undefined,
    margin: section.margin ? Number(section.margin.value) : undefined,
    update_interval_sec: section.updateInterval ? Number(section.updateInterval.value) : undefined,
    window_sec: section.window ? Number(section.window.value) : undefined,
    hysteresis_tolerance: section.hysteresis ? Number(section.hysteresis.value) : undefined,
    release_percentile: section.release ? Number(section.release.value) : undefined,
    voiced_hold_sec: section.voicedHold ? Number(section.voicedHold.value) : undefined,
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

function setTranscriptionModelStatus(message, state = "info") {
  const section = recorderDom.sections.transcription;
  const element = section && section.modelStatus instanceof HTMLElement ? section.modelStatus : null;
  if (!element) {
    return;
  }
  if (message) {
    element.textContent = message;
    element.dataset.state = state;
    element.setAttribute("aria-hidden", "false");
  } else {
    element.textContent = "";
    delete element.dataset.state;
    element.setAttribute("aria-hidden", "true");
  }
}

function setTranscriptionModelLoading(loading) {
  const section = recorderDom.sections.transcription;
  if (!section || !(section.modelRefresh instanceof HTMLButtonElement)) {
    return;
  }
  section.modelRefresh.disabled = Boolean(loading);
  section.modelRefresh.setAttribute("aria-busy", loading ? "true" : "false");
}

function hideTranscriptionModelDiscovery() {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }
  if (section.modelOptions instanceof HTMLSelectElement) {
    section.modelOptions.innerHTML = "";
  }
  if (section.modelDiscovery instanceof HTMLElement) {
    section.modelDiscovery.hidden = true;
  }
}

function showTranscriptionModelDiscovery(models, configuredPath = "") {
  const section = recorderDom.sections.transcription;
  if (!section || !(section.modelOptions instanceof HTMLSelectElement)) {
    return;
  }

  section.modelOptions.innerHTML = "";
  const entries = Array.isArray(models) ? models : [];
  let selectedValue = "";
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) {
      continue;
    }
    const label =
      typeof entry.label === "string" && entry.label
        ? entry.label
        : typeof entry.name === "string" && entry.name
        ? entry.name
        : path;
    if (!label) {
      continue;
    }
    const option = document.createElement("option");
    option.value = path;
    option.textContent = label;
    if (typeof entry.language === "string" && entry.language) {
      option.dataset.language = entry.language;
    }
    section.modelOptions.append(option);
    if (!selectedValue && typeof configuredPath === "string" && configuredPath === path) {
      selectedValue = path;
    }
  }

  if (section.modelDiscovery instanceof HTMLElement) {
    section.modelDiscovery.hidden = section.modelOptions.options.length === 0;
  }

  if (section.modelOptions.options.length > 0) {
    section.modelOptions.value = selectedValue || section.modelOptions.options[0].value;
  }
}

function applySelectedTranscriptionModel() {
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }
  if (!(section.modelOptions instanceof HTMLSelectElement) || !(section.modelPath instanceof HTMLInputElement)) {
    return;
  }
  const value = section.modelOptions.value;
  if (!value) {
    return;
  }
  section.modelPath.value = value;
  markRecorderSectionDirty("transcription");
  const selected = transcriptionModelState.models.find((entry) => entry && entry.path === value);
  if (selected && selected.label) {
    setTranscriptionModelStatus(`Selected ${selected.label}.`, "info");
  } else {
    setTranscriptionModelStatus("Updated model path from detected entry.", "info");
  }
  try {
    section.modelPath.focus({ preventScroll: true });
  } catch (error) {
    /* ignore focus errors */
  }
}

async function refreshTranscriptionModels() {
  if (transcriptionModelState.loading) {
    return;
  }
  const section = recorderDom.sections.transcription;
  if (!section) {
    return;
  }

  transcriptionModelState.loading = true;
  setTranscriptionModelLoading(true);
  hideTranscriptionModelDiscovery();
  setTranscriptionModelStatus("Scanning for installed models…", "pending");

  try {
    const response = await fetch("/api/transcription/models", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const sanitized = [];
    for (const entry of models) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const path = typeof entry.path === "string" ? entry.path : "";
      if (!path) {
        continue;
      }
      const label =
        typeof entry.label === "string" && entry.label
          ? entry.label
          : typeof entry.name === "string" && entry.name
          ? entry.name
          : path;
      const language =
        typeof entry.language === "string" && entry.language ? entry.language : null;
      sanitized.push({ path, label, language });
    }

    transcriptionModelState.models = sanitized;
    const configuredPath =
      typeof payload?.configured_path === "string" ? payload.configured_path : "";
    showTranscriptionModelDiscovery(sanitized, configuredPath);

    const searched = Array.isArray(payload?.searched) ? payload.searched : [];
    const configuredExists = Boolean(payload && payload.configured_exists);
    let message = "";
    let state = "success";
    if (sanitized.length > 0) {
      const count = sanitized.length;
      message = count === 1 ? "Found 1 Vosk model." : `Found ${count} Vosk models.`;
    } else {
      message = "No Vosk models were found.";
      if (searched.length > 0) {
        const display = searched.slice(0, 3);
        const remainder = searched.length - display.length;
        const joined = display.join(", ");
        const suffix = remainder > 0 ? `, … (+${remainder} more)` : "";
        message += ` Checked ${joined}${suffix}.`;
      }
      state = "warning";
    }

    if (configuredPath && !configuredExists) {
      message += ` Current configured path is missing (${configuredPath}).`;
      state = sanitized.length > 0 ? "warning" : "error";
    }

    setTranscriptionModelStatus(message, state);

    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      console.warn("Model discovery reported issues", payload.errors);
    }
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unable to discover Vosk models.";
    setTranscriptionModelStatus(message, "error");
    transcriptionModelState.models = [];
    hideTranscriptionModelDiscovery();
  } finally {
    transcriptionModelState.loading = false;
    setTranscriptionModelLoading(false);
  }
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

function webServerDefaults() {
  return {
    mode: "http",
    listen_host: "0.0.0.0",
    listen_port: 8080,
    tls_provider: "letsencrypt",
    certificate_path: "",
    private_key_path: "",
    lets_encrypt: {
      enabled: false,
      email: "",
      domains: [],
      cache_dir: "/apps/tricorder/letsencrypt",
      staging: false,
      certbot_path: "certbot",
      http_port: 80,
      renew_before_days: 30,
    },
  };
}

function canonicalWebServerSettings(settings) {
  const defaults = webServerDefaults();
  if (!settings || typeof settings !== "object") {
    return defaults;
  }

  const canonical = {
    mode: defaults.mode,
    listen_host: defaults.listen_host,
    listen_port: defaults.listen_port,
    tls_provider: defaults.tls_provider,
    certificate_path: "",
    private_key_path: "",
    lets_encrypt: {
      enabled: false,
      email: "",
      domains: [],
      cache_dir: defaults.lets_encrypt.cache_dir,
      staging: false,
      certbot_path: defaults.lets_encrypt.certbot_path,
      http_port: defaults.lets_encrypt.http_port,
      renew_before_days: defaults.lets_encrypt.renew_before_days,
    },
  };

  if (typeof settings.mode === "string") {
    const mode = settings.mode.trim().toLowerCase();
    if (mode === "https" || mode === "http") {
      canonical.mode = mode;
    }
  }

  if (typeof settings.listen_host === "string") {
    const host = settings.listen_host.trim();
    canonical.listen_host = host || defaults.listen_host;
  }

  const portValue = settings.listen_port;
  if (typeof portValue === "number" && Number.isFinite(portValue)) {
    const normalized = Math.min(65535, Math.max(1, Math.round(portValue)));
    canonical.listen_port = normalized;
  } else if (typeof portValue === "string" && portValue.trim() !== "") {
    const parsed = Number(portValue);
    if (Number.isFinite(parsed)) {
      const normalized = Math.min(65535, Math.max(1, Math.round(parsed)));
      canonical.listen_port = normalized;
    }
  }

  if (typeof settings.tls_provider === "string") {
    const provider = settings.tls_provider.trim().toLowerCase();
    if (WEB_SERVER_TLS_PROVIDERS.has(provider)) {
      canonical.tls_provider = provider;
    }
  }

  if (typeof settings.certificate_path === "string") {
    canonical.certificate_path = settings.certificate_path.trim();
  }
  if (typeof settings.private_key_path === "string") {
    canonical.private_key_path = settings.private_key_path.trim();
  }

  const letsEncrypt =
    settings.lets_encrypt && typeof settings.lets_encrypt === "object"
      ? settings.lets_encrypt
      : {};
  canonical.lets_encrypt.enabled = parseBoolean(letsEncrypt.enabled);
  if (typeof letsEncrypt.email === "string") {
    canonical.lets_encrypt.email = letsEncrypt.email.trim();
  }
  if (Array.isArray(letsEncrypt.domains)) {
    canonical.lets_encrypt.domains = letsEncrypt.domains
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item);
  } else if (typeof letsEncrypt.domains === "string") {
    canonical.lets_encrypt.domains = parseListInput(letsEncrypt.domains);
  }
  if (typeof letsEncrypt.cache_dir === "string") {
    canonical.lets_encrypt.cache_dir = letsEncrypt.cache_dir.trim() || defaults.lets_encrypt.cache_dir;
  }
  canonical.lets_encrypt.staging = parseBoolean(letsEncrypt.staging);
  if (typeof letsEncrypt.certbot_path === "string") {
    canonical.lets_encrypt.certbot_path = letsEncrypt.certbot_path.trim() || defaults.lets_encrypt.certbot_path;
  }
  const httpPortValue = letsEncrypt.http_port;
  if (typeof httpPortValue === "number" && Number.isFinite(httpPortValue)) {
    canonical.lets_encrypt.http_port = Math.min(65535, Math.max(1, Math.round(httpPortValue)));
  } else if (typeof httpPortValue === "string" && httpPortValue.trim() !== "") {
    const parsed = Number(httpPortValue);
    if (Number.isFinite(parsed)) {
      canonical.lets_encrypt.http_port = Math.min(65535, Math.max(1, Math.round(parsed)));
    }
  }
  const renewValue = letsEncrypt.renew_before_days;
  if (typeof renewValue === "number" && Number.isFinite(renewValue)) {
    canonical.lets_encrypt.renew_before_days = Math.max(1, Math.round(renewValue));
  } else if (typeof renewValue === "string" && renewValue.trim() !== "") {
    const parsed = Number(renewValue);
    if (Number.isFinite(parsed)) {
      canonical.lets_encrypt.renew_before_days = Math.max(1, Math.round(parsed));
    }
  }

  if (canonical.mode !== "https") {
    canonical.tls_provider = defaults.tls_provider;
    canonical.lets_encrypt.enabled = false;
  } else if (!WEB_SERVER_TLS_PROVIDERS.has(canonical.tls_provider)) {
    canonical.tls_provider = "letsencrypt";
  }

  return canonical;
}

function computeWebServerFingerprint(settings) {
  return JSON.stringify(canonicalWebServerSettings(settings));
}

function normalizeWebServerResponse(payload) {
  const settings =
    payload && typeof payload === "object"
      ? canonicalWebServerSettings(payload["web_server"])
      : webServerDefaults();
  const configPath =
    payload && typeof payload === "object" && typeof payload.config_path === "string"
      ? payload.config_path
      : "";
  return { settings, configPath };
}

function updateWebServerConfigPath(path) {
  const text = typeof path === "string" ? path : "";
  webServerState.configPath = text;
  if (dom.webServerConfigPath) {
    dom.webServerConfigPath.textContent = text || "(unknown)";
  }
}

function updateWebServerVisibility() {
  const mode = dom.webServerMode ? dom.webServerMode.value : "http";
  const provider = dom.webServerTlsProvider ? dom.webServerTlsProvider.value : "letsencrypt";
  const showTls = mode === "https";
  const showLetsEncrypt = showTls && provider === "letsencrypt";
  const showManual = showTls && provider === "manual";
  if (dom.webServerLetsEncryptSection) {
    dom.webServerLetsEncryptSection.hidden = !showLetsEncrypt;
    dom.webServerLetsEncryptSection.dataset.active = showLetsEncrypt ? "true" : "false";
    dom.webServerLetsEncryptSection.setAttribute("aria-hidden", showLetsEncrypt ? "false" : "true");
  }
  if (dom.webServerManualSection) {
    dom.webServerManualSection.hidden = !showManual;
    dom.webServerManualSection.dataset.active = showManual ? "true" : "false";
    dom.webServerManualSection.setAttribute("aria-hidden", showManual ? "false" : "true");
  }
}

function setWebServerStatus(message, state = "", options = {}) {
  if (!dom.webServerStatus) {
    return;
  }
  if (webServerState.statusTimeoutId) {
    window.clearTimeout(webServerState.statusTimeoutId);
    webServerState.statusTimeoutId = null;
  }
  const text = typeof message === "string" ? message : "";
  dom.webServerStatus.textContent = text;
  if (state) {
    dom.webServerStatus.dataset.state = state;
  } else {
    delete dom.webServerStatus.dataset.state;
  }
  dom.webServerStatus.setAttribute("aria-hidden", text ? "false" : "true");
  const { autoHide = false, duration = 3500 } = options;
  if (text && autoHide) {
    const delay = Number.isFinite(duration) ? Math.max(0, duration) : 3500;
    webServerState.statusTimeoutId = window.setTimeout(() => {
      webServerState.statusTimeoutId = null;
      if (!webServerState.dirty) {
        setWebServerStatus("", "");
      }
    }, delay);
  }
}

function updateWebServerButtons() {
  if (dom.webServerSave) {
    dom.webServerSave.disabled = webServerState.saving || !webServerState.dirty;
  }
  if (dom.webServerReset) {
    const disableReset =
      webServerState.saving ||
      (!webServerState.dirty && !webServerState.pendingSnapshot && !webServerState.hasExternalUpdate);
    dom.webServerReset.disabled = disableReset;
  }
  if (dom.webServerDialog) {
    dom.webServerDialog.dataset.dirty = webServerState.dirty ? "true" : "false";
    dom.webServerDialog.dataset.saving = webServerState.saving ? "true" : "false";
    dom.webServerDialog.dataset.externalUpdate = webServerState.hasExternalUpdate ? "true" : "false";
  }
}

function setWebServerSaving(saving) {
  webServerState.saving = saving;
  if (dom.webServerForm) {
    dom.webServerForm.setAttribute("aria-busy", saving ? "true" : "false");
  }
  updateWebServerButtons();
}

function applyWebServerData(settings, { markPristine = true } = {}) {
  const canonical = canonicalWebServerSettings(settings);
  webServerState.current = canonical;
  if (dom.webServerMode) {
    dom.webServerMode.value = canonical.mode;
  }
  if (dom.webServerHost) {
    dom.webServerHost.value = canonical.listen_host;
  }
  if (dom.webServerPort) {
    dom.webServerPort.value = String(canonical.listen_port);
  }
  if (dom.webServerTlsProvider) {
    dom.webServerTlsProvider.value = canonical.tls_provider;
  }
  if (dom.webServerManualCert) {
    dom.webServerManualCert.value = canonical.certificate_path || "";
  }
  if (dom.webServerManualKey) {
    dom.webServerManualKey.value = canonical.private_key_path || "";
  }
  if (dom.webServerLetsEncryptDomains) {
    dom.webServerLetsEncryptDomains.value = canonical.lets_encrypt.domains.join("\n");
  }
  if (dom.webServerLetsEncryptEmail) {
    dom.webServerLetsEncryptEmail.value = canonical.lets_encrypt.email || "";
  }
  if (dom.webServerLetsEncryptStaging) {
    dom.webServerLetsEncryptStaging.checked = Boolean(canonical.lets_encrypt.staging);
  }
  if (dom.webServerLetsEncryptHttpPort) {
    dom.webServerLetsEncryptHttpPort.value = String(canonical.lets_encrypt.http_port);
  }
  if (dom.webServerLetsEncryptCacheDir) {
    dom.webServerLetsEncryptCacheDir.value = canonical.lets_encrypt.cache_dir || "";
  }
  if (dom.webServerLetsEncryptCertbot) {
    dom.webServerLetsEncryptCertbot.value = canonical.lets_encrypt.certbot_path || "";
  }
  if (dom.webServerLetsEncryptRenewBefore) {
    dom.webServerLetsEncryptRenewBefore.value = String(canonical.lets_encrypt.renew_before_days);
  }

  updateWebServerVisibility();

  if (markPristine) {
    webServerState.lastAppliedFingerprint = computeWebServerFingerprint(canonical);
    webServerState.dirty = false;
    webServerState.pendingSnapshot = null;
    webServerState.hasExternalUpdate = false;
  }
  updateWebServerButtons();
}

function readWebServerForm() {
  const payload = {
    mode: dom.webServerMode ? dom.webServerMode.value : "http",
    listen_host: dom.webServerHost ? dom.webServerHost.value : "",
    listen_port: dom.webServerPort ? dom.webServerPort.value : "",
    tls_provider: dom.webServerTlsProvider ? dom.webServerTlsProvider.value : "letsencrypt",
    certificate_path: dom.webServerManualCert ? dom.webServerManualCert.value : "",
    private_key_path: dom.webServerManualKey ? dom.webServerManualKey.value : "",
    lets_encrypt: {
      enabled: true,
      email: dom.webServerLetsEncryptEmail ? dom.webServerLetsEncryptEmail.value : "",
      domains: dom.webServerLetsEncryptDomains ? dom.webServerLetsEncryptDomains.value : "",
      staging: dom.webServerLetsEncryptStaging ? dom.webServerLetsEncryptStaging.checked : false,
      http_port: dom.webServerLetsEncryptHttpPort ? dom.webServerLetsEncryptHttpPort.value : "",
      cache_dir: dom.webServerLetsEncryptCacheDir ? dom.webServerLetsEncryptCacheDir.value : "",
      certbot_path: dom.webServerLetsEncryptCertbot ? dom.webServerLetsEncryptCertbot.value : "",
      renew_before_days: dom.webServerLetsEncryptRenewBefore
        ? dom.webServerLetsEncryptRenewBefore.value
        : "",
    },
  };
  const canonical = canonicalWebServerSettings(payload);
  return canonical;
}

function updateWebServerDirtyState() {
  const fingerprint = computeWebServerFingerprint(readWebServerForm());
  webServerState.dirty = fingerprint !== webServerState.lastAppliedFingerprint;
  updateWebServerButtons();
}

function handleWebServerReset() {
  if (webServerState.saving) {
    return;
  }
  if (webServerState.pendingSnapshot) {
    applyWebServerData(webServerState.pendingSnapshot, { markPristine: true });
    setWebServerStatus("Loaded updated settings from disk.", "info", { autoHide: true, duration: 2500 });
    return;
  }
  if (webServerState.current) {
    applyWebServerData(webServerState.current, { markPristine: true });
    setWebServerStatus("Reverted unsaved changes.", "info", { autoHide: true, duration: 2000 });
  }
}

async function fetchWebServerSettings({ silent = false } = {}) {
  if (webServerState.fetchInFlight) {
    webServerState.fetchQueued = true;
    return;
  }
  webServerState.fetchInFlight = true;
  webServerState.loading = true;
  if (!silent) {
    setWebServerStatus("Loading web server settings…", "info");
  }
  try {
    const response = await fetch(WEB_SERVER_ENDPOINT, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    const payload = await response.json();
    const { settings, configPath } = normalizeWebServerResponse(payload);
    applyWebServerData(settings, { markPristine: true });
    updateWebServerConfigPath(configPath);
    webServerState.loaded = true;
    if (!silent) {
      setWebServerStatus("Loaded web server settings.", "success", { autoHide: true, duration: 1800 });
    } else if (!webServerState.dirty) {
      setWebServerStatus("", "");
    }
  } catch (error) {
    console.error("Failed to fetch web server settings", error);
    const message = error && error.message ? error.message : "Unable to load web server settings.";
    setWebServerStatus(message, "error");
  } finally {
    webServerState.fetchInFlight = false;
    webServerState.loading = false;
    updateWebServerButtons();
    if (webServerState.fetchQueued) {
      webServerState.fetchQueued = false;
      fetchWebServerSettings({ silent: true });
    }
  }
}

function syncWebServerSnapshotFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    return;
  }
  const snapshot = canonicalWebServerSettings(cfg.web_server);
  const fingerprint = computeWebServerFingerprint(snapshot);
  if (!webServerState.loaded) {
    applyWebServerData(snapshot, { markPristine: true });
    return;
  }
  if (fingerprint === webServerState.lastAppliedFingerprint) {
    return;
  }
  if (!webServerState.dirty) {
    applyWebServerData(snapshot, { markPristine: true });
    setWebServerStatus("Web server settings updated from config file.", "info", {
      autoHide: true,
      duration: 2500,
    });
  } else {
    webServerState.pendingSnapshot = snapshot;
    webServerState.hasExternalUpdate = true;
    setWebServerStatus("Web server settings changed on disk. Reset to load the new values.", "warning");
    updateWebServerButtons();
  }
}

async function saveWebServerSettings() {
  if (webServerState.saving) {
    return;
  }
  setWebServerSaving(true);
  setWebServerStatus("Saving web server settings…", "info");
  try {
    const payload = readWebServerForm();
    const response = await fetch(WEB_SERVER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorText = await extractErrorMessage(response);
      throw new Error(errorText || `Request failed with ${response.status}`);
    }
    const body = await response.json();
    const { settings, configPath } = normalizeWebServerResponse(body);
    applyWebServerData(settings, { markPristine: true });
    updateWebServerConfigPath(configPath);
    webServerState.loaded = true;
    setWebServerStatus("Saved web server settings.", "success", { autoHide: true, duration: 2000 });
  } catch (error) {
    console.error("Failed to save web server settings", error);
    const message = error && error.message ? error.message : "Unable to save web server settings.";
    setWebServerStatus(message, "error");
  } finally {
    setWebServerSaving(false);
  }
}

function webServerModalFocusableElements() {
  if (!dom.webServerDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.webServerDialog.querySelectorAll(selectors);
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

function setWebServerModalVisible(visible) {
  if (!dom.webServerModal) {
    return;
  }
  dom.webServerModal.dataset.visible = visible ? "true" : "false";
  dom.webServerModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.webServerModal.removeAttribute("hidden");
    lockDocumentScroll("web-server-settings");
  } else {
    dom.webServerModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("web-server-settings");
  }
}

function attachWebServerDialogKeydown() {
  if (webServerDialogState.keydownHandler) {
    return;
  }
  webServerDialogState.keydownHandler = (event) => {
    if (!webServerDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.webServerModal &&
      target instanceof Node &&
      (target === dom.webServerModal || dom.webServerModal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeWebServerModal();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = webServerModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.webServerDialog) {
        dom.webServerDialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.webServerDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", webServerDialogState.keydownHandler, true);
}

function detachWebServerDialogKeydown() {
  if (!webServerDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", webServerDialogState.keydownHandler, true);
  webServerDialogState.keydownHandler = null;
}

function focusWebServerDialog() {
  if (!dom.webServerDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = webServerModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.webServerDialog.focus();
    }
  });
}

function openWebServerModal(options = {}) {
  if (!dom.webServerModal || !dom.webServerDialog) {
    return;
  }
  const { focus = true } = options;
  if (webServerDialogState.open) {
    if (focus) {
      focusWebServerDialog();
    }
    return;
  }
  webServerDialogState.open = true;
  webServerDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setWebServerModalVisible(true);
  if (dom.webServerOpen) {
    dom.webServerOpen.setAttribute("aria-expanded", "true");
  }
  attachWebServerDialogKeydown();
  if (!webServerState.loaded && !webServerState.fetchInFlight) {
    fetchWebServerSettings({ silent: false });
  } else if (webServerState.hasExternalUpdate && webServerState.pendingSnapshot && !webServerState.saving) {
    setWebServerStatus(
      "Web server settings changed on disk. Reset to load the new values.",
      "warning"
    );
  } else {
    updateWebServerButtons();
  }
  if (focus) {
    focusWebServerDialog();
  }
}

function closeWebServerModal(options = {}) {
  if (!webServerDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  webServerDialogState.open = false;
  setWebServerModalVisible(false);
  if (dom.webServerOpen) {
    dom.webServerOpen.setAttribute("aria-expanded", "false");
  }
  detachWebServerDialogKeydown();
  const previous = webServerDialogState.previouslyFocused;
  webServerDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
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
    syncWebServerSnapshotFromConfig(payload);
    syncArchivalSnapshotFromConfig(payload);
  } catch (error) {
    console.error("Failed to fetch config", error);
    const offline = ensureOfflineStateOnError(error);
    if (!silent && dom.configViewer) {
      const message = offline
        ? "Recorder unreachable. Unable to load configuration."
        : "Unable to load configuration.";
      dom.configViewer.textContent = message;
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
    activeEnterEpoch: toFiniteOrNull(entry.active_enter_epoch),
    activeEnterTimestamp:
      typeof entry.active_enter_timestamp === "string"
        ? entry.active_enter_timestamp
        : "",
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

function recycleBinModalFocusableElements() {
  if (!dom.recycleBinDialog) {
    return [];
  }
  const selectors =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = dom.recycleBinDialog.querySelectorAll(selectors);
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

function setRecycleBinModalVisible(visible) {
  if (!dom.recycleBinModal) {
    return;
  }
  dom.recycleBinModal.dataset.visible = visible ? "true" : "false";
  dom.recycleBinModal.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    dom.recycleBinModal.removeAttribute("hidden");
    lockDocumentScroll("recycle-bin");
  } else {
    dom.recycleBinModal.setAttribute("hidden", "hidden");
    unlockDocumentScroll("recycle-bin");
  }
}

function attachRecycleBinDialogKeydown() {
  if (recycleBinDialogState.keydownHandler) {
    return;
  }
  recycleBinDialogState.keydownHandler = (event) => {
    if (!recycleBinDialogState.open) {
      return;
    }
    const target = event.target;
    const withinModal =
      dom.recycleBinModal &&
      target instanceof Node &&
      (target === dom.recycleBinModal || dom.recycleBinModal.contains(target));
    if (event.key === "Escape") {
      event.preventDefault();
      closeRecycleBinModal();
      return;
    }
    if (event.key !== "Tab" || !withinModal) {
      return;
    }
    const focusable = recycleBinModalFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      if (dom.recycleBinDialog) {
        dom.recycleBinDialog.focus();
      }
      return;
    }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey) {
      if (!active || active === first || active === dom.recycleBinDialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", recycleBinDialogState.keydownHandler, true);
}

function detachRecycleBinDialogKeydown() {
  if (!recycleBinDialogState.keydownHandler) {
    return;
  }
  document.removeEventListener("keydown", recycleBinDialogState.keydownHandler, true);
  recycleBinDialogState.keydownHandler = null;
}

function focusRecycleBinDialog() {
  if (!dom.recycleBinDialog) {
    return;
  }
  window.requestAnimationFrame(() => {
    const focusable = recycleBinModalFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dom.recycleBinDialog.focus();
    }
  });
}

function openRecycleBinModal(options = {}) {
  if (!dom.recycleBinModal || !dom.recycleBinDialog) {
    return;
  }
  const { focus = true } = options;
  suspendAutoRefresh();
  if (dom.recycleBinOpen) {
    dom.recycleBinOpen.setAttribute("aria-expanded", "true");
  }
  if (recycleBinDialogState.open) {
    if (focus) {
      focusRecycleBinDialog();
    }
    fetchRecycleBin({ silent: false });
    return;
  }
  recycleBinDialogState.open = true;
  state.recycleBin.open = true;
  recycleBinDialogState.previewing = false;
  recycleBinDialogState.previousRecord = null;
  recycleBinDialogState.previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setRecycleBinModalVisible(true);
  attachRecycleBinDialogKeydown();
  fetchRecycleBin({ silent: false });
  if (focus) {
    focusRecycleBinDialog();
  }
}

function closeRecycleBinModal(options = {}) {
  if (!recycleBinDialogState.open) {
    return;
  }
  const { restoreFocus = true } = options;
  const shouldRefreshRecordings = recordingsRefreshDeferred;
  recordingsRefreshDeferred = false;
  recycleBinDialogState.open = false;
  state.recycleBin.open = false;
  setRecycleBinModalVisible(false);
  detachRecycleBinDialogKeydown();
  if (dom.recycleBinOpen) {
    dom.recycleBinOpen.setAttribute("aria-expanded", "false");
  }
  restoreRecycleBinPreview();
  if (shouldRefreshRecordings) {
    fetchRecordings({ silent: true, force: true });
  }
  resumeAutoRefresh();
  const previous = recycleBinDialogState.previouslyFocused;
  recycleBinDialogState.previouslyFocused = null;
  if (restoreFocus && previous && typeof previous.focus === "function") {
    previous.focus();
  }
}

function loadPersistedRecycleBinState() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const storage = window.sessionStorage;
    if (!storage || typeof storage.getItem !== "function") {
      return null;
    }
    const raw = storage.getItem(RECYCLE_BIN_STATE_STORAGE_KEY);
    if (typeof raw !== "string" || !raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const selected = Array.isArray(parsed.selected)
      ? parsed.selected.filter((value) => typeof value === "string" && value)
      : [];
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : "";
    const anchorId = typeof parsed.anchorId === "string" ? parsed.anchorId : "";
    return { selected, activeId, anchorId };
  } catch (error) {
    return null;
  }
}

function persistRecycleBinState() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const storage = window.sessionStorage;
    if (!storage || typeof storage.setItem !== "function") {
      return;
    }
    const selected = Array.from(state.recycleBin.selected.values());
    const activeId = typeof state.recycleBin.activeId === "string" ? state.recycleBin.activeId : "";
    const anchorId = typeof state.recycleBin.anchorId === "string" ? state.recycleBin.anchorId : "";
    if (selected.length === 0 && !activeId && !anchorId) {
      storage.removeItem(RECYCLE_BIN_STATE_STORAGE_KEY);
      return;
    }
    const payload = { selected, activeId, anchorId };
    storage.setItem(RECYCLE_BIN_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore storage errors */
  }
}

function getRecycleBinItem(id) {
  if (typeof id !== "string" || !id) {
    return null;
  }
  for (const item of state.recycleBin.items) {
    if (item && item.id === id) {
      return item;
    }
  }
  return null;
}

function isRecycleBinRecord(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      record.source === "recycle-bin" &&
      typeof record.recycleBinId === "string" &&
      record.recycleBinId
  );
}

function recycleBinContainsId(id) {
  if (typeof id !== "string" || !id) {
    return false;
  }
  return state.recycleBin.items.some((item) => item && item.id === id);
}

function getRecycleBinIndex(id) {
  if (typeof id !== "string" || !id) {
    return -1;
  }
  for (let index = 0; index < state.recycleBin.items.length; index += 1) {
    const entry = state.recycleBin.items[index];
    if (entry && entry.id === id) {
      return index;
    }
  }
  return -1;
}

function applyRecycleBinRangeSelection(anchorId, targetId, shouldSelect) {
  const anchorIndex = getRecycleBinIndex(anchorId);
  const targetIndex = getRecycleBinIndex(targetId);
  if (anchorIndex === -1 || targetIndex === -1) {
    return false;
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const updated = new Set(state.recycleBin.selected);
  let changed = false;
  for (let index = start; index <= end; index += 1) {
    const entry = state.recycleBin.items[index];
    if (!entry || typeof entry.id !== "string" || !entry.id) {
      continue;
    }
    if (shouldSelect) {
      if (!updated.has(entry.id)) {
        changed = true;
      }
      updated.add(entry.id);
    } else {
      if (updated.delete(entry.id)) {
        changed = true;
      }
    }
  }
  if (!changed) {
    return false;
  }
  state.recycleBin.selected = updated;
  return true;
}

function recycleBinAudioUrl(id, { download = false } = {}) {
  if (typeof id !== "string" || !id) {
    return "";
  }
  const encoded = encodeURIComponent(id);
  const suffix = download ? "?download=1" : "";
  return apiPath(`/recycle-bin/${encoded}${suffix}`);
}

function recycleBinWaveformUrl(id) {
  if (typeof id !== "string" || !id) {
    return "";
  }
  const encoded = encodeURIComponent(id);
  return apiPath(`/api/recycle-bin/${encoded}/waveform`);
}

function getRecycleBinRow(id) {
  if (!dom.recycleBinTableBody || typeof id !== "string" || !id) {
    return null;
  }
  const selector = `tr[data-id="${escapeSelector(id)}"]`;
  return dom.recycleBinTableBody.querySelector(selector);
}

function recycleBinRecordFromItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const id = typeof item.id === "string" ? item.id : "";
  if (!id) {
    return null;
  }
  const extension =
    typeof item.extension === "string" && item.extension ? item.extension : "";
  const name = typeof item.name === "string" && item.name ? item.name : "";
  const sizeValue = Number(item.size_bytes);
  const durationValue =
    typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds)
      ? item.duration_seconds
      : null;
  const deletedEpoch = Number.isFinite(Number(item.deleted_at_epoch))
    ? Number(item.deleted_at_epoch)
    : null;
  const { startEpoch, startedEpoch, startedAt } = normalizeStartTimestamps(item);
  const normalizedStartEpoch =
    typeof startEpoch === "number" && Number.isFinite(startEpoch) ? startEpoch : null;
  const normalizedStartedEpoch =
    typeof startedEpoch === "number" && Number.isFinite(startedEpoch)
      ? startedEpoch
      : normalizedStartEpoch;
  const normalizedStartedAt = typeof startedAt === "string" ? startedAt : "";
  return {
    path: `recycle-bin/${id}`,
    name,
    extension,
    size_bytes: Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : 0,
    duration_seconds: durationValue !== null && durationValue > 0 ? durationValue : null,
    modified: deletedEpoch,
    modified_iso: typeof item.deleted_at === "string" ? item.deleted_at : "",
    start_epoch: normalizedStartEpoch,
    started_epoch: normalizedStartedEpoch,
    started_at: normalizedStartedAt,
    original_path: typeof item.original_path === "string" ? item.original_path : "",
    deleted_at: typeof item.deleted_at === "string" ? item.deleted_at : "",
    deleted_at_epoch: deletedEpoch,
    recycleBinId: id,
    recycleBinEntry: item,
    waveform_path: item.waveform_available ? id : "",
    waveform_available: Boolean(item.waveform_available),
    source: "recycle-bin",
    restorable: item.restorable !== false,
  };
}

function restoreRecycleBinPreview() {
  if (!recycleBinDialogState.previewing) {
    return;
  }
  recycleBinDialogState.previewing = false;
  const previous = recycleBinDialogState.previousRecord || null;
  recycleBinDialogState.previousRecord = null;
  if (isRecycleBinRecord(state.current)) {
    if (previous) {
      setNowPlaying(previous, { autoplay: false, resetToStart: false });
    } else {
      setNowPlaying(null, { autoplay: false, resetToStart: true });
    }
  }
}

function updateRecycleBinControls() {
  const selectedCount = state.recycleBin.selected.size;
  const totalCount = state.recycleBin.items.length;
  if (dom.recycleBinTotalCount) {
    dom.recycleBinTotalCount.textContent = totalCount.toString();
  }
  if (dom.recycleBinSelectedCount) {
    dom.recycleBinSelectedCount.textContent = selectedCount.toString();
  }
  if (dom.recycleBinRestore) {
    dom.recycleBinRestore.disabled =
      !selectedCount || state.recycleBin.loading || state.recycleBin.items.length === 0;
  }
  if (dom.recycleBinPurge) {
    dom.recycleBinPurge.disabled =
      !selectedCount || state.recycleBin.loading || state.recycleBin.items.length === 0;
  }
  if (dom.recycleBinRefresh) {
    dom.recycleBinRefresh.disabled = state.recycleBin.loading;
  }
  if (dom.recycleBinToggleAll) {
    const total = state.recycleBin.items.length;
    const selected = selectedCount;
    dom.recycleBinToggleAll.disabled = total === 0;
    dom.recycleBinToggleAll.checked = total > 0 && selected === total;
    dom.recycleBinToggleAll.indeterminate = selected > 0 && selected < total;
  }
}

function updateRecycleBinPreview() {
  if (!state.recycleBin.open) {
    return;
  }
  const item = getRecycleBinItem(state.recycleBin.activeId);
  if (!item) {
    restoreRecycleBinPreview();
    return;
  }
  const row = getRecycleBinRow(item.id);
  if (!row) {
    return;
  }
  if (!recycleBinDialogState.previewing) {
    recycleBinDialogState.previousRecord = isRecycleBinRecord(state.current)
      ? null
      : state.current;
    recycleBinDialogState.previewing = true;
  }
  if (isRecycleBinRecord(state.current) && state.current.recycleBinId === item.id) {
    placePlayerCard(state.current, row);
    return;
  }
  const record = recycleBinRecordFromItem(item);
  if (!record) {
    return;
  }
  setNowPlaying(record, { autoplay: false, resetToStart: true, sourceRow: row });
}

function renderRecycleBinItems() {
  if (!dom.recycleBinTableBody) {
    return;
  }
  dom.recycleBinTableBody.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const item of state.recycleBin.items) {
    if (!item || typeof item.id !== "string" || !item.id) {
      continue;
    }
    const row = document.createElement("tr");
    row.dataset.id = item.id;
    row.dataset.restorable = item.restorable === false ? "false" : "true";
    const isSelected = state.recycleBin.selected.has(item.id);
    const isActive = state.recycleBin.activeId === item.id;
    if (isSelected) {
      row.dataset.selected = "true";
    } else {
      delete row.dataset.selected;
    }
    if (isActive) {
      row.dataset.active = "true";
    } else {
      delete row.dataset.active;
    }

    const checkboxCell = document.createElement("td");
    checkboxCell.className = "checkbox-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isSelected;
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(event instanceof MouseEvent)) {
        return;
      }
      if (event.shiftKey && typeof state.recycleBin.anchorId === "string" && state.recycleBin.anchorId) {
        event.preventDefault();
        const shouldSelect = !checkbox.checked;
        const changed = applyRecycleBinRangeSelection(state.recycleBin.anchorId, item.id, shouldSelect);
        state.recycleBin.anchorId = item.id;
        checkbox.checked = state.recycleBin.selected.has(item.id);
        if (changed) {
          if (
            !shouldSelect &&
            typeof state.recycleBin.activeId === "string" &&
            state.recycleBin.activeId &&
            !state.recycleBin.selected.has(state.recycleBin.activeId)
          ) {
            state.recycleBin.activeId = "";
          }
          persistRecycleBinState();
          renderRecycleBinItems();
        }
        return;
      }
      state.recycleBin.anchorId = item.id;
    });
    checkbox.addEventListener("change", () => {
      const updated = new Set(state.recycleBin.selected);
      if (checkbox.checked) {
        updated.add(item.id);
      } else {
        updated.delete(item.id);
        if (state.recycleBin.activeId === item.id) {
          state.recycleBin.activeId = "";
        }
      }
      state.recycleBin.selected = updated;
      state.recycleBin.anchorId = item.id;
      persistRecycleBinState();
      renderRecycleBinItems();
    });
    checkboxCell.append(checkbox);
    row.append(checkboxCell);

    const nameCell = document.createElement("td");
    const displayName = item.name && item.name.trim() ? item.name : item.original_path || item.id;
    nameCell.textContent = displayName;
    if (item.original_path) {
      nameCell.title = item.original_path;
    }
    row.append(nameCell);

    const lengthCell = document.createElement("td");
    if (typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds)) {
      lengthCell.textContent = formatDuration(item.duration_seconds);
    } else {
      lengthCell.textContent = "--";
    }
    row.append(lengthCell);

    const labelCell = document.createElement("td");
    labelCell.className = "recycle-bin-label-cell";
    if (item.autoMoved) {
      const autoLabel = document.createElement("span");
      autoLabel.className = "badge recycle-bin-auto-label";
      autoLabel.textContent = "Auto (short clip)";
      labelCell.append(autoLabel);
    }
    if (item.restorable === false) {
      const conflict = document.createElement("span");
      conflict.className = "recycle-bin-conflict";
      conflict.textContent = "In use";
      labelCell.append(conflict);
    }
    row.append(labelCell);

    const deletedCell = document.createElement("td");
    deletedCell.textContent = formatIsoDateTime(item.deleted_at) || "--";
    row.append(deletedCell);

    const sizeCell = document.createElement("td");
    sizeCell.textContent = formatBytes(Number(item.size_bytes) || 0);
    row.append(sizeCell);

    row.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement) {
        if (event.target.closest("input, button, a")) {
          return;
        }
      }
      state.recycleBin.selected = new Set([item.id]);
      state.recycleBin.activeId = item.id;
      state.recycleBin.anchorId = item.id;
      persistRecycleBinState();
      renderRecycleBinItems();
    });

    fragment.append(row);
  }
  dom.recycleBinTableBody.append(fragment);
  if (dom.recycleBinEmpty) {
    dom.recycleBinEmpty.hidden = state.recycleBin.items.length !== 0;
  }
  updateRecycleBinControls();
  updateRecycleBinPreview();
}

async function fetchRecycleBin(options = {}) {
  const { silent = false } = options;
  if (state.recycleBin.loading) {
    return;
  }
  state.recycleBin.loading = true;
  updateRecycleBinControls();
  try {
    const response = await fetch(apiPath("/api/recycle-bin"));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const normalized = [];
    for (const entry of rawItems) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const idValue = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!idValue) {
        continue;
      }
      const sizeValue = Number(entry.size_bytes);
      const rawDuration = entry.duration_seconds;
      const durationValue = typeof rawDuration === "number" ? rawDuration : null;
      const { startEpoch, startedEpoch, startedAt } = normalizeStartTimestamps(entry);
      const reason =
        typeof entry.reason === "string" && entry.reason ? entry.reason.trim() : "";
      const autoMoved = reason === "short_clip";

      normalized.push({
        id: idValue,
        name: typeof entry.name === "string" ? entry.name : "",
        original_path: typeof entry.original_path === "string" ? entry.original_path : "",
        deleted_at: typeof entry.deleted_at === "string" ? entry.deleted_at : "",
        deleted_at_epoch: Number.isFinite(Number(entry.deleted_at_epoch))
          ? Number(entry.deleted_at_epoch)
          : null,
        size_bytes: Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : 0,
        duration_seconds:
          typeof durationValue === "number" && Number.isFinite(durationValue) && durationValue > 0
            ? durationValue
            : null,
        restorable: entry.restorable !== false,
        extension:
          typeof entry.extension === "string" && entry.extension ? entry.extension : "",
        waveform_available: entry.waveform_available !== false && Boolean(entry.waveform_available),
        start_epoch: startEpoch,
        started_epoch: startedEpoch,
        started_at: startedAt,
        reason,
        autoMoved,
      });
    }

    const previousSelected = new Set(state.recycleBin.selected);
    state.recycleBin.items = normalized;
    const nextSelected = new Set();
    for (const id of previousSelected) {
      if (recycleBinContainsId(id)) {
        nextSelected.add(id);
      }
    }
    state.recycleBin.selected = nextSelected;
    const hadActive = typeof state.recycleBin.activeId === "string" && state.recycleBin.activeId;
    if (!recycleBinContainsId(state.recycleBin.activeId)) {
      if (hadActive && nextSelected.size > 0) {
        const nextValue = nextSelected.values().next().value;
        state.recycleBin.activeId = typeof nextValue === "string" ? nextValue : "";
      } else if (hadActive) {
        state.recycleBin.activeId = "";
      }
    }
    if (!recycleBinContainsId(state.recycleBin.anchorId)) {
      if (nextSelected.size > 0) {
        let replacement = "";
        for (const value of nextSelected.values()) {
          replacement = value;
        }
        state.recycleBin.anchorId = typeof replacement === "string" ? replacement : "";
      } else if (state.recycleBin.activeId && recycleBinContainsId(state.recycleBin.activeId)) {
        state.recycleBin.anchorId = state.recycleBin.activeId;
      } else {
        state.recycleBin.anchorId = "";
      }
    }
    persistRecycleBinState();
    renderRecycleBinItems();
  } catch (error) {
    console.error("Unable to load recycle bin", error);
    const offline = ensureOfflineStateOnError(error);
    if (!silent) {
      const message = offline
        ? "Recorder unreachable. Unable to load recycle bin entries."
        : "Unable to load recycle bin entries.";
      window.alert(message);
    }
  } finally {
    state.recycleBin.loading = false;
    updateRecycleBinControls();
  }
}

async function restoreRecycleBinSelection() {
  if (state.recycleBin.loading) {
    return;
  }
  const ids = Array.from(state.recycleBin.selected);
  if (ids.length === 0) {
    return;
  }
  state.recycleBin.loading = true;
  updateRecycleBinControls();
  try {
    const response = await fetch(apiPath("/api/recycle-bin/restore"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ids }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const restored = Array.isArray(payload.restored) ? payload.restored : [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
      const message = errors
        .map((entry) => {
          const item = typeof entry?.item === "string" ? entry.item : "";
          const errorText = typeof entry?.error === "string" ? entry.error : "unknown error";
          return item ? `${item}: ${errorText}` : errorText;
        })
        .join("\n");
      if (message) {
        window.alert(`Some recordings could not be restored:\n${message}`);
      }
    }
    if (restored.length === 0 && errors.length > 0) {
      return;
    }
    state.recycleBin.selected = new Set();
    state.recycleBin.activeId = "";
    state.recycleBin.anchorId = "";
    persistRecycleBinState();
    state.recycleBin.loading = false;
    updateRecycleBinControls();
    await fetchRecycleBin({ silent: false });
    fetchRecordings({ silent: false });
  } catch (error) {
    console.error("Unable to restore recycle bin entries", error);
    window.alert("Unable to restore selected recordings.");
  } finally {
    state.recycleBin.loading = false;
    updateRecycleBinControls();
  }
}

async function purgeRecycleBinSelection() {
  if (state.recycleBin.loading) {
    return;
  }
  const ids = Array.from(state.recycleBin.selected);
  if (ids.length === 0) {
    return;
  }
  const confirmed = await confirmRecycleBinPurgePrompt(ids.length);
  if (!confirmed) {
    return;
  }

  state.recycleBin.loading = true;
  updateRecycleBinControls();

  let shouldReload = false;
  try {
    const response = await fetch(apiPath("/api/recycle-bin/purge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ids }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const purged = Array.isArray(payload.purged) ? payload.purged : [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];

    if (errors.length > 0) {
      const message = errors
        .map((entry) => {
          const item = typeof entry?.item === "string" ? entry.item : "";
          const errorText = typeof entry?.error === "string" ? entry.error : "unknown error";
          return item ? `${item}: ${errorText}` : errorText;
        })
        .join("\n");
      if (message) {
        window.alert(`Some recordings could not be deleted:\n${message}`);
      }
    }

    if (purged.length > 0) {
      state.recycleBin.selected = new Set();
      state.recycleBin.activeId = "";
      state.recycleBin.anchorId = "";
      persistRecycleBinState();
    }

    shouldReload = purged.length > 0 || errors.length > 0;
  } catch (error) {
    console.error("Unable to purge recycle bin entries", error);
    window.alert("Unable to delete selected recordings permanently.");
  } finally {
    state.recycleBin.loading = false;
    updateRecycleBinControls();
  }

  if (shouldReload) {
    await fetchRecycleBin({ silent: false });
    fetchRecordings({ silent: false });
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
    updateRecorderUptimeFromServices();
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
    const offline = ensureOfflineStateOnError(error);
    if (offline) {
      servicesState.error = "Recorder unreachable. Unable to load services.";
    } else {
      servicesState.error = normalizeErrorMessage(error, "Unable to load services.");
    }
    if (!recorderUptimeState.active && recorderUptimeState.startEpoch === null) {
      const hint = servicesState.error || "";
      setRecorderUptimeStatus("Offline", { hint });
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
    const offline = ensureOfflineStateOnError(error);
    const fallback = `${capitalizeAction(action)} failed.`;
    let message = normalizeErrorMessage(error, fallback);
    if (offline) {
      message = `${capitalizeAction(action)} failed: recorder unreachable.`;
    }
    servicesState.lastResults.set(unit, {
      ok: false,
      message: message || fallback,
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
      if (state.selectionAnchor === path) {
        state.selectionAnchor = "";
        if (state.selectionFocus === path) {
          state.selectionFocus = "";
        }
      }
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
  if (state.selectionAnchor === oldPath) {
    state.selectionAnchor = newPath;
    state.selectionFocus = newPath;
  } else if (state.selectionFocus === oldPath) {
    state.selectionFocus = newPath;
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
  let timeRange = state.filters.timeRange;
  if (dom.filterTimeRange) {
    const raw = dom.filterTimeRange.value.trim();
    timeRange = VALID_TIME_RANGES.has(raw) ? raw : "";
  }
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
    timeRange,
    limit: clampLimitValue(limit),
  };
  const changed =
    nextFilters.search !== state.filters.search ||
    nextFilters.day !== state.filters.day ||
    nextFilters.timeRange !== state.filters.timeRange ||
    nextFilters.limit !== state.filters.limit;

  state.filters = nextFilters;

  if (dom.filterSearch) {
    dom.filterSearch.value = nextFilters.search;
  }
  if (dom.filterDay && dom.filterDay.value !== nextFilters.day) {
    dom.filterDay.value = nextFilters.day;
  }
  if (dom.filterTimeRange && dom.filterTimeRange.value !== nextFilters.timeRange) {
    dom.filterTimeRange.value = nextFilters.timeRange;
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
  if (dom.filterTimeRange) {
    dom.filterTimeRange.value = "";
  }
  if (dom.filterLimit) {
    dom.filterLimit.value = String(DEFAULT_LIMIT);
  }
  state.filters = { search: "", day: "", limit: DEFAULT_LIMIT, timeRange: "" };
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

function setManualRecordButtonState(active) {
  if (!dom.manualToggle) {
    return;
  }
  dom.manualToggle.setAttribute("aria-pressed", active ? "true" : "false");
  dom.manualToggle.textContent = active ? "Stop Manual" : "Manual Record";
}

function setManualRecordDisabled(disabled, reason = "") {
  if (!dom.manualToggle) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  if (dom.manualToggle.disabled !== nextDisabled) {
    dom.manualToggle.disabled = nextDisabled;
  }
  if (nextDisabled) {
    if (reason) {
      dom.manualToggle.title = reason;
    } else {
      dom.manualToggle.removeAttribute("title");
    }
    dom.manualToggle.setAttribute("aria-disabled", "true");
  } else {
    dom.manualToggle.removeAttribute("title");
    dom.manualToggle.removeAttribute("aria-disabled");
  }
}

function updateManualRecordButton(rawStatus) {
  if (!dom.manualToggle) {
    return;
  }
  if (manualRecordState.pending) {
    const pendingReason = manualRecordState.reason || "Manual toggle in progress.";
    setManualRecordDisabled(true, pendingReason);
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const enabled = status ? parseBoolean(status.manual_recording) : false;
  manualRecordState.enabled = Boolean(enabled);
  setManualRecordButtonState(manualRecordState.enabled);
  let disabled = false;
  let reason = "";
  if (!status) {
    disabled = true;
    reason = "Recorder status unavailable.";
  } else if (!parseBoolean(status.service_running)) {
    disabled = true;
    const stopReason =
      typeof status.last_stop_reason === "string" ? status.last_stop_reason.trim() : "";
    reason = stopReason || "Recorder service is stopped.";
  }
  setManualRecordDisabled(disabled, reason);
}

function setManualRecordPending(pending, message = "") {
  manualRecordState.pending = Boolean(pending);
  manualRecordState.reason = message;
  if (!dom.manualToggle) {
    return;
  }
  if (manualRecordState.pending) {
    dom.manualToggle.setAttribute("aria-busy", "true");
    setManualRecordDisabled(true, message || "Manual toggle in progress.");
  } else {
    dom.manualToggle.removeAttribute("aria-busy");
    updateManualRecordButton(state.captureStatus);
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

function waitForIceGatheringComplete(pc, { timeoutMs = 2500 } = {}) {
  if (!pc) {
    return Promise.resolve();
  }
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        settle();
      }
    };

    const onCandidate = (event) => {
      if (!event.candidate) {
        settle();
      }
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = window.setTimeout(settle, timeoutMs);
    }
  });
}

async function startWebRtcStream() {
  if (!dom.liveAudio) {
    return;
  }
  const pcConfig = {};
  if (WEBRTC_ICE_SERVERS.length > 0) {
    pcConfig.iceServers = WEBRTC_ICE_SERVERS;
  }
  const pc = new RTCPeerConnection(pcConfig);
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

function focusElementSilently(element) {
  if (!element || typeof element.focus !== "function") {
    return false;
  }
  try {
    element.focus({ preventScroll: true });
    return true;
  } catch (error) {
    try {
      element.focus();
      return true;
    } catch (error2) {
      return false;
    }
  }
}

function focusLiveStreamPanel() {
  if (!dom.livePanel || dom.livePanel.getAttribute("aria-hidden") === "true") {
    return false;
  }
  return focusElementSilently(dom.livePanel);
}

function focusPreviewSurface() {
  if (dom.waveformContainer && !dom.waveformContainer.hidden) {
    if (focusElementSilently(dom.waveformContainer)) {
      return true;
    }
  }
  if (
    dom.playerCard &&
    dom.playerCard.dataset.active === "true" &&
    dom.playerCard.hidden !== true
  ) {
    if (focusElementSilently(dom.playerCard)) {
      return true;
    }
  }
  return false;
}

function releaseLiveAudioFocus() {
  if (!dom.liveAudio || typeof document === "undefined") {
    return;
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active !== dom.liveAudio) {
    return;
  }
  if (focusLiveStreamPanel()) {
    return;
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

    const handlePointerOver = (event) => {
      const interactive = findInteractiveElement(event.target, event);
      if (!interactive) {
        return;
      }
      hoveredInteractiveElements.add(interactive);
      suspendAutoRefresh();
    };

    const handlePointerOut = (event) => {
      const interactive = findInteractiveElement(event.target, event);
      if (!interactive) {
        return;
      }
      const relatedTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      const nextInteractive = relatedTarget ? findInteractiveElement(relatedTarget) : null;
      if (nextInteractive === interactive) {
        return;
      }
      hoveredInteractiveElements.delete(interactive);
      if (nextInteractive) {
        return;
      }
      if (hoveredInteractiveElements.size > 0) {
        return;
      }
      window.requestAnimationFrame(() => {
        const active =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!findInteractiveElement(active) && hoveredInteractiveElements.size === 0) {
          resumeAutoRefresh();
        }
      });
    };

    document.addEventListener("focusin", handleGlobalFocusIn);
    document.addEventListener("focusout", handleGlobalFocusOut);
    document.addEventListener("pointerdown", (event) => {
      if (findInteractiveElement(event.target, event)) {
        suspendAutoRefresh();
        return;
      }
      // Clicking outside of interactive controls should release any
      // manual suspension so status polling keeps running even if the
      // previously focused element retained focus (common for buttons).
      window.requestAnimationFrame(() => {
        resumeAutoRefresh();
      });
    });
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
  }

  const audioSection = recorderDom.sections ? recorderDom.sections.audio : null;
  if (audioSection) {
    const toggles = [
      audioSection.filterDenoiseEnabled,
      audioSection.filterHighpassEnabled,
      audioSection.filterLowpassEnabled,
      audioSection.filterNotchEnabled,
      audioSection.filterSpectralGateEnabled,
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
      audioSection.filterDenoiseFloor,
      audioSection.filterHighpassCutoff,
      audioSection.filterLowpassCutoff,
      audioSection.filterNotchFrequency,
      audioSection.filterNotchQuality,
      audioSection.filterSpectralGateSensitivity,
      audioSection.filterSpectralGateReduction,
      audioSection.filterSpectralGateNoiseUpdate,
      audioSection.filterSpectralGateNoiseDecay,
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
    if (audioSection.filterDenoiseType instanceof HTMLSelectElement) {
      audioSection.filterDenoiseType.addEventListener("change", updateAudioFilterControls);
    }
    if (audioSection.calibrateNoiseButton instanceof HTMLButtonElement) {
      audioSection.calibrateNoiseButton.addEventListener("click", () => {
        const targetUrl = "/static/docs/room-tuner.html";
        window.open(targetUrl, "_blank", "noopener");
      });
    }
  }

  const transcriptionSection = recorderDom.sections ? recorderDom.sections.transcription : null;
  if (transcriptionSection) {
    if (transcriptionSection.modelRefresh instanceof HTMLButtonElement) {
      transcriptionSection.modelRefresh.addEventListener("click", () => {
        refreshTranscriptionModels();
      });
    }
    if (transcriptionSection.modelApply instanceof HTMLButtonElement) {
      transcriptionSection.modelApply.addEventListener("click", () => {
        applySelectedTranscriptionModel();
      });
    }
    if (transcriptionSection.modelDismiss instanceof HTMLButtonElement) {
      transcriptionSection.modelDismiss.addEventListener("click", () => {
        transcriptionModelState.models = [];
        hideTranscriptionModelDiscovery();
        setTranscriptionModelStatus("", "info");
      });
    }
    if (transcriptionSection.modelOptions instanceof HTMLSelectElement) {
      transcriptionSection.modelOptions.addEventListener("change", () => {
        const value = transcriptionSection.modelOptions.value;
        const selected = transcriptionModelState.models.find((entry) => entry && entry.path === value);
        if (selected && selected.label) {
          setTranscriptionModelStatus(`Selected ${selected.label}.`, "info");
        } else {
          setTranscriptionModelStatus("", "info");
        }
      });
      transcriptionSection.modelOptions.addEventListener("dblclick", () => {
        applySelectedTranscriptionModel();
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
    state.selectionAnchor = "";
    state.selectionFocus = "";
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
    state.selectionAnchor = "";
    state.selectionFocus = "";
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

  if (recorderDom.saveAll) {
    recorderDom.saveAll.addEventListener("click", () => {
      void saveAllRecorderSections();
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

  if (dom.webServerOpen) {
    dom.webServerOpen.addEventListener("click", () => {
      closeAppMenu({ restoreFocus: false });
      openWebServerModal();
    });
  }

  if (dom.webServerClose) {
    dom.webServerClose.addEventListener("click", () => {
      closeWebServerModal();
    });
  }

  if (dom.webServerModal) {
    dom.webServerModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.webServerModal) {
        event.preventDefault();
      }
    });
    dom.webServerModal.addEventListener("click", (event) => {
      if (event.target === dom.webServerModal) {
        closeWebServerModal();
      }
    });
  }

  if (dom.webServerForm) {
    dom.webServerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveWebServerSettings();
    });

    const handleWebServerChange = (event) => {
      if (event && (event.target === dom.webServerMode || event.target === dom.webServerTlsProvider)) {
        updateWebServerVisibility();
      }
      updateWebServerDirtyState();
    };

    dom.webServerForm.addEventListener("input", handleWebServerChange);
    dom.webServerForm.addEventListener("change", handleWebServerChange);
  }

  if (dom.webServerReset) {
    dom.webServerReset.addEventListener("click", () => {
      handleWebServerReset();
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
      persistSortPreference();
      renderRecords();
    });
  }

  dom.toggleAll.addEventListener("change", (event) => {
    const records = getVisibleRecords().filter((record) => !record.isPartial);
    if (event.target.checked) {
      for (const record of records) {
        state.selections.add(record.path);
      }
      if (records.length > 0) {
        state.selectionAnchor = records[records.length - 1].path;
        state.selectionFocus = records[records.length - 1].path;
      }
    } else {
      for (const record of records) {
        state.selections.delete(record.path);
      }
      state.selectionAnchor = "";
      state.selectionFocus = "";
    }
    renderRecords();
  });

  dom.selectAll.addEventListener("click", () => {
    const records = getVisibleRecords().filter((record) => !record.isPartial);
    for (const record of records) {
      state.selections.add(record.path);
    }
    if (records.length > 0) {
      state.selectionAnchor = records[records.length - 1].path;
      state.selectionFocus = records[records.length - 1].path;
    }
    renderRecords();
  });

  dom.clearSelection.addEventListener("click", () => {
    state.selections.clear();
    state.selectionAnchor = "";
    state.selectionFocus = "";
    renderRecords();
  });

  if (dom.recycleBinOpen) {
    dom.recycleBinOpen.addEventListener("click", () => {
      openRecycleBinModal({ focus: true });
    });
  }

  if (dom.recycleBinClose) {
    dom.recycleBinClose.addEventListener("click", () => {
      closeRecycleBinModal();
    });
  }

  if (dom.recycleBinRefresh) {
    dom.recycleBinRefresh.addEventListener("click", () => {
      fetchRecycleBin({ silent: false });
    });
  }

  if (dom.recycleBinRestore) {
    dom.recycleBinRestore.addEventListener("click", async () => {
      await restoreRecycleBinSelection();
    });
  }

  if (dom.recycleBinPurge) {
    dom.recycleBinPurge.addEventListener("click", async () => {
      await purgeRecycleBinSelection();
    });
  }

  if (dom.recycleBinToggleAll) {
    dom.recycleBinToggleAll.addEventListener("change", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.checked) {
        const updated = new Set();
        for (const entry of state.recycleBin.items) {
          if (entry && typeof entry.id === "string" && entry.id) {
            updated.add(entry.id);
          }
        }
        state.recycleBin.selected = updated;
        if (!recycleBinContainsId(state.recycleBin.activeId)) {
          state.recycleBin.activeId = "";
        }
        if (!recycleBinContainsId(state.recycleBin.anchorId)) {
          let anchor = "";
          for (const value of updated.values()) {
            anchor = value;
          }
          state.recycleBin.anchorId = typeof anchor === "string" ? anchor : "";
        }
      } else {
        state.recycleBin.selected = new Set();
        state.recycleBin.activeId = "";
        state.recycleBin.anchorId = "";
      }
      persistRecycleBinState();
      renderRecycleBinItems();
    });
  }

  if (dom.recycleBinModal) {
    dom.recycleBinModal.addEventListener("mousedown", (event) => {
      if (event.target === dom.recycleBinModal) {
        event.preventDefault();
      }
    });
    dom.recycleBinModal.addEventListener("click", (event) => {
      if (event.target === dom.recycleBinModal) {
        closeRecycleBinModal();
      }
    });
  }

  dom.deleteSelected.addEventListener("click", async () => {
    if (!state.selections.size) {
      return;
    }
    const count = state.selections.size;
    const message = `Move ${count} selected recording${count === 1 ? "" : "s"} to the recycle bin?`;
    const title =
      count === 1 ? "Move recording to recycle bin" : "Move recordings to recycle bin";
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

  if (dom.waveformZoomInput instanceof HTMLInputElement) {
    const storedValue = Number.isFinite(waveformState.amplitudeScale)
      ? waveformState.amplitudeScale
      : Number.parseFloat(dom.waveformZoomInput.value);
    const initial = normalizeWaveformZoom(storedValue);
    waveformState.amplitudeScale = initial;
    dom.waveformZoomInput.value = initial.toString();
    updateWaveformZoomDisplay(initial);
    const handleWaveformZoomChange = (event) => {
      if (!(event.target instanceof HTMLInputElement)) {
        return;
      }
      const normalized = normalizeWaveformZoom(Number.parseFloat(event.target.value));
      waveformState.amplitudeScale = normalized;
      event.target.value = normalized.toString();
      updateWaveformZoomDisplay(normalized);
      persistWaveformPreferences();
      redrawWaveform();
    };
    dom.waveformZoomInput.addEventListener("input", handleWaveformZoomChange);
    dom.waveformZoomInput.addEventListener("change", handleWaveformZoomChange);
  } else {
    updateWaveformZoomDisplay(normalizeWaveformZoom(waveformState.amplitudeScale));
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

  const handlePreviewPointerReset = () => {
    focusState.previewPointer = false;
  };

  dom.player.addEventListener("pointerdown", () => {
    focusState.previewPointer = true;
  });
  dom.player.addEventListener("pointerup", handlePreviewPointerReset);
  dom.player.addEventListener("pointercancel", handlePreviewPointerReset);
  dom.player.addEventListener("focus", () => {
    if (!focusState.previewPointer) {
      return;
    }
    focusState.previewPointer = false;
    window.requestAnimationFrame(() => {
      if (!focusPreviewSurface()) {
        try {
          dom.player.blur();
        } catch (error) {
          /* ignore blur errors */
        }
      }
    });
  });
  dom.player.addEventListener("blur", handlePreviewPointerReset);

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
    updateTransportPlayState();
    updateTransportProgressUI();
  });
  dom.player.addEventListener("pause", () => {
    stopCursorAnimation();
    updateCursorFromPlayer();
    updateTransportPlayState();
    updateTransportProgressUI();
  });
  dom.player.addEventListener("timeupdate", () => {
    updateCursorFromPlayer();
    if (!transportState.scrubbing) {
      updateTransportProgressUI();
    }
  });
  dom.player.addEventListener("seeked", () => {
    updateCursorFromPlayer();
    updateTransportProgressUI();
  });
  dom.player.addEventListener("loadedmetadata", (event) => {
    handlePlayerLoadedMetadata(event);
    updateTransportAvailability();
  });
  dom.player.addEventListener("durationchange", updateTransportProgressUI);
  dom.player.addEventListener("ended", () => {
    applyNowPlayingHighlight();
    stopCursorAnimation();
    updateCursorFromPlayer();
    updateTransportProgressUI();
    updateTransportPlayState();
    playbackState.pausedViaSpacebar.delete(dom.player);
  });
  dom.player.addEventListener("emptied", () => {
    playbackState.pausedViaSpacebar.delete(dom.player);
    playbackState.resetOnLoad = false;
    playbackState.enforcePauseOnLoad = false;
    if (!playbackSourceState.suppressTransportReset) {
      resetTransportUi();
    }
    updateTransportAvailability();
  });
  dom.player.addEventListener("volumechange", handlePlayerVolumeChange);
  dom.player.addEventListener("ratechange", handlePlayerRateChange);

  if (dom.transportPlay) {
    dom.transportPlay.addEventListener("click", handleTransportPlayToggle);
  }
  if (dom.transportRestart) {
    dom.transportRestart.addEventListener("click", () => {
      restartTransport();
    });
  }
  if (dom.transportRewind) {
    dom.transportRewind.addEventListener("click", () => {
      skipTransportBy(-TRANSPORT_SKIP_BACK_SECONDS);
    });
  }
  if (dom.transportForward) {
    dom.transportForward.addEventListener("click", () => {
      skipTransportBy(TRANSPORT_SKIP_FORWARD_SECONDS);
    });
  }
  if (dom.transportEnd) {
    dom.transportEnd.addEventListener("click", () => {
      jumpToTransportEnd();
    });
  }
  if (dom.transportMute) {
    dom.transportMute.addEventListener("click", handleTransportMuteToggle);
  }
  if (dom.transportVolume) {
    dom.transportVolume.addEventListener("input", handleTransportVolumeInput);
  }
  if (dom.transportSpeed) {
    dom.transportSpeed.addEventListener("change", handleTransportSpeedChange);
  }
  if (dom.transportScrubber) {
    dom.transportScrubber.addEventListener("input", handleTransportScrubberInput);
    dom.transportScrubber.addEventListener("change", handleTransportScrubberCommit);
    dom.transportScrubber.addEventListener("pointerdown", handleTransportScrubberPointerDown);
    dom.transportScrubber.addEventListener("pointerup", handleTransportScrubberPointerUp);
    dom.transportScrubber.addEventListener("pointercancel", handleTransportScrubberPointerUp);
    dom.transportScrubber.addEventListener("blur", handleTransportScrubberBlur);
  }

  if (dom.playbackSourceProcessed) {
    dom.playbackSourceProcessed.addEventListener("click", () => {
      setPlaybackSource("processed", { userInitiated: true });
    });
  }
  if (dom.playbackSourceRaw) {
    dom.playbackSourceRaw.addEventListener("click", () => {
      setPlaybackSource("raw", { userInitiated: true });
    });
  }

  applyPlaybackSourceUi();

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

  if (dom.recordingsTabRecent) {
    dom.recordingsTabRecent.addEventListener("click", () => {
      setCollection("recent");
    });
  }

  if (dom.recordingsTabSaved) {
    dom.recordingsTabSaved.addEventListener("click", () => {
      setCollection("saved");
    });
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

  if (dom.splitEvent) {
    dom.splitEvent.addEventListener("click", () => {
      requestSplitEvent();
    });
  }

  if (dom.manualToggle) {
    dom.manualToggle.addEventListener("click", async () => {
      if (manualRecordState.pending || dom.manualToggle.disabled) {
        return;
      }
      const nextEnabled = !manualRecordState.enabled;
      const pendingMessage = nextEnabled
        ? "Enabling manual recording…"
        : "Stopping manual recording…";
      setManualRecordPending(true, pendingMessage);
      try {
        const response = await fetch(MANUAL_RECORD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        if (!response.ok) {
          let message = `Manual record request failed (status ${response.status})`;
          try {
            const errorPayload = await response.json();
            if (errorPayload && typeof errorPayload === "object") {
              if (typeof errorPayload.error === "string" && errorPayload.error) {
                message = errorPayload.error;
              } else if (typeof errorPayload.reason === "string" && errorPayload.reason) {
                message = errorPayload.reason;
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
        let enabledResult = nextEnabled;
        try {
          const payload = await response.json();
          if (payload && typeof payload === "object" && "enabled" in payload) {
            enabledResult = parseBoolean(payload.enabled);
          }
        } catch (parseError) {
          enabledResult = nextEnabled;
        }
        manualRecordState.enabled = Boolean(enabledResult);
        manualRecordState.reason = "";
        setManualRecordButtonState(manualRecordState.enabled);
        updateManualRecordButton(state.captureStatus);
      } catch (manualError) {
        const message =
          manualError instanceof Error && manualError.message
            ? manualError.message
            : "Manual record toggle failed";
        console.error("Manual record toggle failed", manualError);
        setManualRecordPending(false);
        manualRecordState.pending = false;
        manualRecordState.reason = "";
        if (dom.manualToggle) {
          dom.manualToggle.removeAttribute("aria-busy");
          dom.manualToggle.title = message;
        }
        return;
      }
      setManualRecordPending(false);
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

  if (dom.playerRename) {
    dom.playerRename.addEventListener("click", () => {
      if (renameDialogState.pending || !state.current) {
        return;
      }
      openRenameDialog(state.current);
    });
  }

  if (dom.playerDelete) {
    dom.playerDelete.addEventListener("click", async () => {
      if (!state.current) {
        return;
      }
      await requestRecordDeletion(state.current);
    });
  }

  if (dom.playerCard) {
    dom.playerCard.addEventListener("keydown", handlePreviewKeydown);
    dom.playerCard.addEventListener("pointerdown", (event) => {
      if (findInteractiveElement(event.target, event)) {
        return;
      }
      focusPreviewSurface();
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
    const handleLivePointerReset = () => {
      focusState.livePointer = false;
    };
    dom.liveAudio.addEventListener("pointerdown", () => {
      focusState.livePointer = true;
    });
    dom.liveAudio.addEventListener("pointerup", handleLivePointerReset);
    dom.liveAudio.addEventListener("pointercancel", handleLivePointerReset);
    dom.liveAudio.addEventListener("focus", () => {
      if (!focusState.livePointer) {
        return;
      }
      focusState.livePointer = false;
      window.requestAnimationFrame(() => {
        if (!focusLiveStreamPanel()) {
          try {
            dom.liveAudio.blur();
          } catch (error) {
            /* ignore blur errors */
          }
        }
      });
    });
    dom.liveAudio.addEventListener("blur", handleLivePointerReset);
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
      if (liveState.open && liveState.active) {
        cancelLiveStats();
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
  restoreSortFromStorage();
  restoreFilterPanelPreference();
  setupResponsiveFilters();
  populateFilters();
  updateSelectionUI();
  updateSortIndicators();
  updatePaginationControls();
  resetWaveform();
  loadTransportPreferences();
  applyTransportPreferences();
  setTransportActive(false);
  resetTransportUi();
  restoreWaveformPreferences();
  restoreClipperPreference();
  setClipperVisible(false);
  updateClipperStatusElement();
  setRecordingIndicatorUnknown("Loading status…");
  setLiveButtonState(false);
  setLiveStatus("Idle");
  setLiveToggleDisabled(true, "Checking recorder service status…");
  setRecorderModalVisible(false);
  setConfigModalVisible(false);
  setWebServerModalVisible(false);
  updateRecorderConfigPath(recorderState.configPath);
  registerRecorderSections();
  updateAudioFilterControls();
  setServicesModalVisible(false);
  applyWebServerData(webServerDefaults(), { markPristine: true });
  updateWebServerConfigPath(webServerState.configPath);
  applyArchivalData(archivalDefaults(), { markPristine: true });
  updateArchivalConfigPath(archivalState.configPath);
  attachEventListeners();
  updateTransportAvailability();
  renderRecorderUptime();
  fetchRecordings({ silent: false });
  fetchConfig({ silent: false });
  fetchWebServerSettings({ silent: true });
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
