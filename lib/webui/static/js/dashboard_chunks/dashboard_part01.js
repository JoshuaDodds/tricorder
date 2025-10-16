import { createDashboardServices } from "./dashboard/configuration.js";
import {
  ARCHIVAL_BACKENDS,
  ARCHIVAL_ENDPOINT,
  AUTO_RECORD_ENDPOINT,
  AUTO_REFRESH_INTERVAL_MS,
  CONFIG_REFRESH_INTERVAL_MS,
  DEFAULT_LIMIT,
  EVENTS_ENDPOINT,
  EVENT_STREAM_REQUIRES_CREDENTIALS,
  EVENT_STREAM_SAME_ORIGIN,
  EVENT_TRIGGER_DEBOUNCE_MS,
  FILTER_PANEL_STORAGE_KEY,
  HEALTH_ENDPOINT,
  HEALTH_REFRESH_MIN_INTERVAL_MS,
  HLS_URL,
  KEYBOARD_JOG_RATE_SECONDS_PER_SECOND,
  MANUAL_RECORD_ENDPOINT,
  MARKER_COLLAPSE_EPSILON_SECONDS,
  MARKER_LABEL_BASE_OFFSET_REM,
  MARKER_LABEL_EDGE_THRESHOLD,
  MARKER_LABEL_SPACING_THRESHOLD,
  MARKER_LABEL_STACK_SPACING_REM,
  MAX_PLAYBACK_RATE,
  MIN_CLIP_DURATION_SECONDS,
  MIN_PLAYBACK_RATE,
  OFFLINE_REFRESH_INTERVAL_MS,
  OFFER_ENDPOINT,
  POINTER_IDLE_CLEAR_DELAY_MS,
  RECYCLE_BIN_STATE_STORAGE_KEY,
  SERVICE_REFRESH_INTERVAL_MS,
  SERVICE_RESULT_TTL_MS,
  SERVICES_ENDPOINT,
  SESSION_STORAGE_KEY,
  SPLIT_ENDPOINT,
  START_ENDPOINT,
  STATS_ENDPOINT,
  STOP_ENDPOINT,
  STREAM_BASE,
  STREAM_MODE,
  THEME_STORAGE_KEY,
  TRANSPORT_SCRUB_MAX,
  TRANSPORT_SKIP_BACK_SECONDS,
  TRANSPORT_SKIP_FORWARD_SECONDS,
  TRANSPORT_STORAGE_KEY,
  VALID_TIME_RANGES,
  VOICE_RECORDER_SERVICE_UNIT,
  WAVEFORM_REFRESH_INTERVAL_MS,
  WAVEFORM_ZOOM_DEFAULT,
  WAVEFORM_ZOOM_MAX,
  WAVEFORM_ZOOM_MIN,
  WEBRTC_ICE_SERVERS,
  WEB_SERVER_ENDPOINT,
  WEB_SERVER_TLS_PROVIDERS,
  WINDOW_NAME_PREFIX,
  EVENT_STREAM_HEARTBEAT_TIMEOUT_MS,
  EVENT_STREAM_RETRY_MAX_MS,
  EVENT_STREAM_RETRY_MIN_MS,
  clampPlaybackRateValue,
} from "./config.js";
import {
  dateFormatter,
  formatBytes,
  formatClockTime,
  formatClipLengthText,
  formatDate,
  formatDbDisplay,
  formatDuration,
  formatEncodingSource,
  formatHzDisplay,
  formatIsoDateTime,
  formatPlaybackRateLabel,
  formatQualityDisplay,
  formatRecorderUptimeHint,
  formatRecorderUptimeValue,
  formatRecordingStartTime,
  formatRatioDisplay,
  formatShortDuration,
  formatTimeSlug,
  formatTimecode,
  formatTransportClock,
  formatUnitless,
  formatWaveformZoom,
  normalizeEncodingSource,
  timeFormatter,
  userLocales,
} from "./formatters.js";
import {
  normalizeMotionSegments,
  normalizeStartTimestamps,
  normalizeTriggerSources,
  toFiniteOrNull,
} from "./dashboard/normalizers.js";
import { createFiltersLayoutManager } from "./dashboard/layout/filters.js";
import { dataAttributeFromDatasetKey, findChildByDataset } from "./dashboard/dom.js";
import { createDashboardDom } from "./dashboard/domRefs.js";
import { createRecorderDom } from "./dashboard/recorderDom.js";
import { createTabRecordingIndicator } from "./dashboard/modules/tabRecordingIndicator.js";
import { createThemeManager } from "./dashboard/theme.js";
import { createHealthManager } from "./dashboard/health.js";
import { createRecordingMetaController } from "./dashboard/modules/recordingMetaController.js";
import { createEncodingStatusController } from "./dashboard/modules/encodingStatusController.js";
import { createWebServerSettingsController } from "./dashboard/modules/webServerSettingsController.js";
import { createArchivalSettingsController } from "./dashboard/modules/archivalSettingsController.js";
import { createClipperController } from "./dashboard/modules/clipperController.js";
import { createRenameDialogController } from "./dashboard/modules/renameDialogController.js";
import { createScrollLockManager } from "./dashboard/modules/scrollLockManager.js";
import { createAppMenuController } from "./dashboard/modules/appMenuController.js";
import { createConfirmDialogController } from "./dashboard/modules/confirmDialogController.js";
import { createRecordingPathHelpers } from "./dashboard/modules/recordingPaths.js";
import { focusElementSilently } from "./dashboard/modules/focusUtils.js";
import { ensureOfflineStateOnError, normalizeErrorMessage, clamp, numericValue, getRecordStartSeconds } from "./dashboard/modules/commonUtils.js";
import { createPointerInteractionManager } from "./dashboard/modules/pointerManager.js";
import { createRecycleBinHelpers } from "./dashboard/modules/recycleBinHelpers.js";
import { createServicesController } from "./dashboard/modules/servicesController.js";
import { createDownloadHelpers } from "./dashboard/modules/downloads.js";
import {
  clampLimitValue,
  clampOffsetValue,
  loadStoredCollection,
  persistCollection,
  persistFilters,
  clearStoredFilters,
  restoreFiltersFromStorage,
  persistSortPreference,
  restoreSortFromStorage,
  persistWaveformPreferences,
  getStoredWaveformAmplitude,
} from "./dashboard/modules/preferencesStorage.js";
import stateApi, {
  dashboardState as state,
  healthState,
  splitEventState,
  updateDashboardState,
  updateHealthState,
  updateSplitEventState,
  getPendingSelectionRange,
  setPendingSelectionRange,
  clearPendingSelectionRange,
} from "./state.js";
import {
  COMPONENTS_REGISTRY,
  nowMilliseconds,
  requireDashboardComponent,
} from "./src/utils/dashboardRuntime.js";

const resolvedStateApi =
  stateApi ||
  (typeof globalThis !== "undefined" && globalThis.TRICORDER_STATE) ||
  null;

if (!resolvedStateApi) {
  throw new Error("TRICORDER_STATE helpers are unavailable");
}
const {
  apiClient,
  apiPath: resolveApiPath,
  eventStreamFactory,
  eventStreamSupported: EVENT_STREAM_SUPPORTED,
} = createDashboardServices();

const apiPath = resolveApiPath;

const buildClipListRow = requireDashboardComponent(
  COMPONENTS_REGISTRY.buildClipListRow,
  "buildClipListRow",
);
const renderClipListEmptyState = requireDashboardComponent(
  COMPONENTS_REGISTRY.renderClipListEmptyState,
  "renderClipListEmptyState",
);
const syncFiltersPanel = requireDashboardComponent(
  COMPONENTS_REGISTRY.syncFiltersPanel,
  "syncFiltersPanel",
);
const createTransportController = requireDashboardComponent(
  COMPONENTS_REGISTRY.createTransportController,
  "createTransportController",
);
const renderRecordingMetaPanel = requireDashboardComponent(
  COMPONENTS_REGISTRY.renderRecordingMetaPanel,
  "renderRecordingMetaPanel",
);
const hideRecordingMetaPanel = requireDashboardComponent(
  COMPONENTS_REGISTRY.hideRecordingMetaPanel,
  "hideRecordingMetaPanel",
);
const updateRecordingMetaPanel = requireDashboardComponent(
  COMPONENTS_REGISTRY.updateRecordingMetaPanel,
  "updateRecordingMetaPanel",
);

if (typeof window !== "undefined") {
  window.TRICORDER_DASHBOARD_STATE = state;
}

const storedCollection = loadStoredCollection();
if (storedCollection === "saved" || storedCollection === "recent") {
  updateDashboardState((draft) => {
    draft.collection = storedCollection;
  }, "hydrate:collection");
}

const dom = createDashboardDom();

const {
  hoveredInteractiveElements,
  stopPointerIdleTimer,
  clearHoveredInteractiveElements,
  pruneHoveredInteractiveElements,
  recordPointerActivity,
  findInteractiveElement,
  escapeSelector,
  hasHoveredInteractiveElements,
} = createPointerInteractionManager({
  pointerIdleDelayMs: POINTER_IDLE_CLEAR_DELAY_MS,
  nowMilliseconds,
  onHoverStateCleared: () => {
    resumeAutoRefresh();
  },
});

const {
  loadPersistedRecycleBinState,
  persistRecycleBinState,
  getRecycleBinItem,
  isRecycleBinRecord,
  recycleBinContainsId,
  getRecycleBinIndex,
  applyRecycleBinRangeSelection,
  recycleBinAudioUrl,
  recycleBinWaveformUrl,
  getRecycleBinRow,
  recycleBinRecordFromItem,
} = createRecycleBinHelpers({
  state,
  dom,
  apiPath,
  toFiniteOrNull,
  normalizeStartTimestamps,
  storageKey: RECYCLE_BIN_STATE_STORAGE_KEY,
  escapeSelector,
});

const persistedRecycleBinState = loadPersistedRecycleBinState();
if (persistedRecycleBinState) {
  updateDashboardState((draft) => {
    if (
      Array.isArray(persistedRecycleBinState.selected) &&
      persistedRecycleBinState.selected.length > 0
    ) {
      draft.recycleBin.selected = new Set(
        persistedRecycleBinState.selected.filter((value) => typeof value === "string" && value)
      );
    }
    if (
      typeof persistedRecycleBinState.activeId === "string" &&
      persistedRecycleBinState.activeId
    ) {
      draft.recycleBin.activeId = persistedRecycleBinState.activeId;
    }
    if (
      typeof persistedRecycleBinState.anchorId === "string" &&
      persistedRecycleBinState.anchorId
    ) {
      draft.recycleBin.anchorId = persistedRecycleBinState.anchorId;
    }
  }, "hydrate:recycle-bin");
}

updateCollectionUI();

const {
  stopTabRecordingTitleIndicator,
  refreshTabRecordingTitleIndicator,
  setTabRecordingActive,
} = createTabRecordingIndicator({ prefersReducedMotion });

const autoRecordState = {
  enabled: true,
  pending: false,
  reason: "",
  motionOverride: false,
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

const recorderDom = createRecorderDom();

const sortHeaderMap = new Map(
  dom.sortButtons.map((button) => [button.dataset.sortKey ?? "", button.closest("th")])
);

const themeManager = createThemeManager({
  storageKey: THEME_STORAGE_KEY,
  toggleElement: dom.themeToggle,
});

const { lockDocumentScroll, unlockDocumentScroll } = createScrollLockManager();

const appMenuController = createAppMenuController({ dom });
const { openAppMenu, closeAppMenu, toggleAppMenu, isOpen: isAppMenuOpen } =
  appMenuController;

const confirmDialogController = createConfirmDialogController({ dom });
const {
  showConfirmDialog,
  confirmDeletionPrompt,
  confirmRecycleBinPurgePrompt,
  initialize: initializeConfirmDialog,
  isOpen: isConfirmDialogOpen,
} = confirmDialogController;
initializeConfirmDialog();

let autoRefreshId = null;
let configRefreshId = null;
let configRefreshSuspended = false;
let configFetchInFlight = false;
let configFetchQueued = false;
let configRefreshPending = false;
let configEventTimer = null;
let recordingsRefreshPending = false;
let recordingsEventTimer = null;
let previewRefreshHold = false;
let previewRefreshPending = false;

function startConfigRefresh() {
  stopConfigRefresh();
  if (configRefreshSuspended) {
    return;
  }
  if (eventStreamState.connected) {
    if (configRefreshPending) {
      requestConfigRefresh({ immediate: true });
    }
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
  if (configEventTimer !== null) {
    window.clearTimeout(configEventTimer);
    configEventTimer = null;
    configRefreshPending = true;
  }
}

function requestConfigRefresh({ immediate = false } = {}) {
  if (configRefreshSuspended) {
    configRefreshPending = true;
    return;
  }
  if (immediate) {
    if (configEventTimer !== null) {
      window.clearTimeout(configEventTimer);
      configEventTimer = null;
    }
    configRefreshPending = false;
    fetchConfig({ silent: true });
    return;
  }
  if (configEventTimer !== null) {
    configRefreshPending = true;
    return;
  }
  configRefreshPending = true;
  configEventTimer = window.setTimeout(() => {
    configEventTimer = null;
    if (configRefreshSuspended) {
      configRefreshPending = true;
      return;
    }
    configRefreshPending = false;
    fetchConfig({ silent: true });
  }, EVENT_TRIGGER_DEBOUNCE_MS);
}

let autoRefreshIntervalMs = AUTO_REFRESH_INTERVAL_MS;
let autoRefreshSuspended = false;
let pollingFallbackActive = false;
let fetchInFlight = false;
let fetchQueued = false;
let recordingsRefreshDeferred = false;

function enablePollingFallback() {
  if (!pollingFallbackActive) {
    pollingFallbackActive = true;
  }
  startAutoRefresh();
  startHealthRefresh();
  startConfigRefresh();
}

let pendingSelectionPath = null;
function updatePendingSelectionPath(nextPath) {
  pendingSelectionPath = nextPath;
}

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
  motionSegments: [],
  peakScale: 32767,
  startEpoch: null,
  rmsValues: null,
  refreshTimer: null,
  refreshRecordPath: "",
  amplitudeScale: WAVEFORM_ZOOM_DEFAULT,
};

const {
  transportState,
  getPlayerDurationSeconds,
  loadTransportPreferences,
  applyTransportPreferences,
  setTransportActive,
  resetTransportUi,
  updateTransportAvailability,
  updateTransportPlayState,
  updateTransportProgressUI,
  skipTransportBy,
  restartTransport,
  jumpToTransportEnd,
  handleTransportMuteToggle,
  handleTransportVolumeInput,
  handleTransportSpeedChange,
  handleTransportPlayToggle,
  handleTransportScrubberInput,
  handleTransportScrubberCommit,
  handleTransportScrubberPointerDown,
  handleTransportScrubberPointerUp,
  handleTransportScrubberBlur,
  handlePlayerVolumeChange,
  handlePlayerRateChange,
} = createTransportController({
  dom,
  state,
  waveformState,
  clamp,
  hasPlayableSource,
  clampPlaybackRateValue,
  formatTransportClock,
  formatPlaybackRateLabel,
  transportScrubMax: TRANSPORT_SCRUB_MAX,
  transportStorageKey: TRANSPORT_STORAGE_KEY,
});


const clipper = createClipperController({
  dom,
  state,
  clamp,
  numericValue,
  formatTimecode,
  formatTimeSlug,
  toFiniteOrNull,
  isRecycleBinRecord,
  fetchRecordings,
  apiClient,
  apiPath,
  getRecordStartSeconds,
  resumeAutoRefresh,
  setPendingSelectionPath: updatePendingSelectionPath,
  MIN_CLIP_DURATION_SECONDS,
  ensurePreviewSectionOrder,
});

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

const {
  recordingUrl,
  normalizePlaybackSource,
  recordAudioUrl,
  recordHasRawAudio,
  recordRawAudioUrl,
  resolvePlaybackSourceUrl,
  recordWaveformUrl,
} = createRecordingPathHelpers({
  apiPath,
  recycleBinAudioUrl,
  recycleBinWaveformUrl,
  isRecycleBinRecord,
  playbackSourceState,
});

const { downloadRecordingsArchive } = createDownloadHelpers({
  apiClient,
  apiPath,
});

const PLAYBACK_SOURCE_LABELS = {
  processed: "Processed (Opus)",
  raw: "Raw capture (PCM)",
};

const focusState = {
  previewPointer: false,
  livePointer: false,
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

function prefersReducedMotion() {
  if (!reduceMotionQuery) {
    return false;
  }
  return reduceMotionQuery.matches === true;
}

const {
  state: filtersLayoutState,
  restorePreference: restoreFilterPanelPreference,
  setExpanded: setFiltersExpanded,
  updateLayout: updateFiltersLayout,
  setupResponsiveFilters,
} = createFiltersLayoutManager({
  dom,
  filtersLayoutQuery,
  prefersReducedMotion,
});

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

const webServerController = createWebServerSettingsController({
  dom,
  apiClient,
  lockDocumentScroll,
  unlockDocumentScroll,
  parseBoolean,
  parseListInput,
  closeAppMenu,
  webServerEndpoint: WEB_SERVER_ENDPOINT,
  webServerTlsProviders: WEB_SERVER_TLS_PROVIDERS,
  extractErrorMessage,
});
const webServerState = webServerController.state;
const {
  webServerDefaults,
  updateConfigPath: updateWebServerConfigPath,
  updateVisibility: updateWebServerVisibility,
  setStatus: setWebServerStatus,
  updateButtons: updateWebServerButtons,
  applyData: applyWebServerData,
  setModalVisible: setWebServerModalVisible,
  fetchSettings: fetchWebServerSettings,
  saveSettings: saveWebServerSettings,
  openModal: openWebServerModal,
  closeModal: closeWebServerModal,
  updateDirtyState: updateWebServerDirtyState,
  handleReset: handleWebServerReset,
  notifyExternalUpdate: notifyWebServerExternalUpdate,
  applySnapshot: applyWebServerSnapshot,
  attachEventListeners: attachWebServerEventListeners,
  initializeDom: initializeWebServerDom,
} = webServerController;

const archivalController = createArchivalSettingsController({
  dom,
  apiClient,
  lockDocumentScroll,
  unlockDocumentScroll,
  parseBoolean,
  parseListInput,
  closeAppMenu,
  archivalEndpoint: ARCHIVAL_ENDPOINT,
  archivalBackends: ARCHIVAL_BACKENDS,
  extractErrorMessage,
});
const archivalState = archivalController.state;
const {
  archivalDefaults,
  updateConfigPath: updateArchivalConfigPath,
  updateBackendVisibility: updateArchivalBackendVisibility,
  setStatus: setArchivalStatus,
  updateButtons: updateArchivalButtons,
  applyData: applyArchivalData,
  setModalVisible: setArchivalModalVisible,
  fetchSettings: fetchArchivalSettings,
  saveSettings: saveArchivalSettings,
  openModal: openArchivalModal,
  closeModal: closeArchivalModal,
  updateDirtyState: updateArchivalDirtyState,
  handleReset: handleArchivalReset,
  notifyExternalUpdate: notifyArchivalExternalUpdate,
  applySnapshot: applyArchivalSnapshot,
  attachEventListeners: attachArchivalEventListeners,
  initializeDom: initializeArchivalDom,
} = archivalController;

function syncWebServerSnapshotFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    return;
  }
  applyWebServerSnapshot(cfg.web_server);
}

function syncArchivalSnapshotFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    return;
  }
  applyArchivalSnapshot(cfg);
}

async function fetchConfig({ silent = false } = {}) {
  if (configFetchInFlight) {
    configFetchQueued = true;
    return;
  }
  configFetchInFlight = true;
  try {
    const response = await apiClient.fetch(apiPath("/api/config"), { cache: "no-store" });
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
    const offline = ensureOfflineStateOnError(error, handleFetchFailure);
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

function setServicesStatus(message, state = "") {
  if (!dom.servicesStatus) {
    return;
  }
  const text = typeof message === "string" ? message : "";
  dom.servicesStatus.textContent = text;
  if (state) {
    dom.servicesStatus.dataset.state = state;
  } else {
    delete dom.servicesStatus.dataset.state;
  }
  dom.servicesStatus.setAttribute("aria-hidden", text ? "false" : "true");
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
        `.recorder-section[data-section-key="${sectionKey}"]`,
      );
      if (sectionContainer instanceof HTMLElement) {
        const focusable = sectionContainer.querySelector(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    if (!focusElementSilently(previous)) {
      previous.focus();
    }
  } else if (recorderDom.menuItems && recorderDom.menuItems[0] instanceof HTMLElement) {
    recorderDom.menuItems[0].focus();
  }
}

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

const eventStreamState = {
  source: null,
  reconnectHandle: null,
  reconnectDelayMs: EVENT_STREAM_RETRY_MIN_MS,
  lastHeartbeat: 0,
  lastEventId: "",
  connected: false,
  heartbeatHandle: null,
  credentialInitUnsupported: false,
};

const healthManager = createHealthManager({
  dom,
  healthState,
  updateHealthState,
  getServicesItems: () => servicesState.items,
  voiceRecorderUnit: VOICE_RECORDER_SERVICE_UNIT,
  formatIsoDateTime,
  formatBytes,
  formatRecorderUptimeValue,
  formatRecorderUptimeHint,
  toFiniteOrNull,
  clamp,
  apiClient,
  healthEndpoint: HEALTH_ENDPOINT,
  ensureOfflineStateOnError,
  eventTriggerDebounceMs: EVENT_TRIGGER_DEBOUNCE_MS,
  healthRefreshMinIntervalMs: HEALTH_REFRESH_MIN_INTERVAL_MS,
  isEventStreamConnected: () => eventStreamState.connected,
  window: typeof window !== "undefined" ? window : null,
  logger: typeof console !== "undefined" ? console : null,
});

const {
  renderRecorderUptime,
  setRecorderUptimeStatus,
  setRecorderUptimeActive,
  updateRecorderUptimeFromServices,
  fetchSystemHealth,
  requestSystemHealthRefresh,
  startHealthRefresh,
  stopHealthRefresh,
  restartHealthRefresh,
  setHealthRefreshInterval,
  isRecorderUptimeKnown,
} = healthManager;

const {
  fetchServices,
  renderServices,
  startServicesRefresh,
  stopServicesRefresh,
  handleServiceAction,
} = createServicesController({
  dom,
  servicesState,
  servicesDialogState,
  apiClient,
  SERVICES_ENDPOINT,
  SERVICE_REFRESH_INTERVAL_MS,
  SERVICE_RESULT_TTL_MS,
  ensureOfflineStateOnError,
  normalizeErrorMessage,
  handleFetchFailure,
  updateRecorderUptimeFromServices,
  updateLiveToggleAvailabilityFromServices,
  setRecorderUptimeStatus,
  isRecorderUptimeKnown,
  setServicesStatus,
  timeFormatter,
});

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

const {
  hideRecordingMeta,
  updateRecordingMeta,
} = createRecordingMetaController({
  dom,
  recordingMetaState,
  recordingMetaTicker,
  renderPanel: renderRecordingMetaPanel,
  hidePanel: hideRecordingMetaPanel,
  updatePanel: updateRecordingMetaPanel,
  nowMilliseconds,
  formatShortDuration,
  formatBytes,
  toFiniteOrNull,
  parseBoolean,
});

const {
  hideEncodingStatus,
  updateEncodingStatus,
} = createEncodingStatusController({
  dom,
  encodingStatusState,
  encodingStatusTicker,
  formatShortDuration,
  formatEncodingSource,
  normalizeEncodingSource,
  nowMilliseconds,
  toFiniteOrNull,
});

const {
  openRenameDialog,
  isPending: isRenameDialogPending,
} = createRenameDialogController({
  dom,
  state,
  renameRecording,
  updateSelectionUI,
  updatePlayerActions,
});

function requestRecordingsRefresh({ immediate = false } = {}) {
  if (state.recycleBin.open || autoRefreshSuspended) {
    recordingsRefreshDeferred = true;
    recordingsRefreshPending = true;
    return;
  }
  if (immediate) {
    if (recordingsEventTimer !== null) {
      window.clearTimeout(recordingsEventTimer);
      recordingsEventTimer = null;
    }
    recordingsRefreshDeferred = false;
    recordingsRefreshPending = false;
    fetchRecordings({ silent: true });
    return;
  }
  if (recordingsEventTimer !== null) {
    recordingsRefreshPending = true;
    return;
  }
  recordingsRefreshPending = true;
  recordingsEventTimer = window.setTimeout(() => {
    recordingsEventTimer = null;
    if (state.recycleBin.open || autoRefreshSuspended) {
      recordingsRefreshDeferred = true;
      recordingsRefreshPending = true;
      return;
    }
    recordingsRefreshDeferred = false;
    recordingsRefreshPending = false;
    fetchRecordings({ silent: true });
  }, EVENT_TRIGGER_DEBOUNCE_MS);
}

function flushRecordingsEventQueue() {
  if (recordingsEventTimer !== null) {
    window.clearTimeout(recordingsEventTimer);
    recordingsEventTimer = null;
  }
  if (recordingsRefreshDeferred || recordingsRefreshPending) {
    recordingsRefreshDeferred = false;
    requestRecordingsRefresh({ immediate: true });
  }
}

function startAutoRefresh() {
  if (autoRefreshSuspended || autoRefreshId || state.recycleBin.open) {
    return;
  }
  if (eventStreamState.connected) {
    flushRecordingsEventQueue();
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
  if (recordingsEventTimer !== null) {
    window.clearTimeout(recordingsEventTimer);
    recordingsEventTimer = null;
    recordingsRefreshPending = true;
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
  if (configEventTimer !== null) {
    configRefreshPending = true;
  }
  configRefreshSuspended = true;
  stopConfigRefresh();
}

function resumeConfigRefresh() {
  if (!configRefreshSuspended) {
    if (eventStreamState.connected) {
      if (configRefreshPending) {
        requestConfigRefresh({ immediate: true });
      }
      return;
    }
    if (!configRefreshId) {
      startConfigRefresh();
    }
    return;
  }
  configRefreshSuspended = false;
  if (eventStreamState.connected) {
    if (configRefreshPending) {
      requestConfigRefresh({ immediate: true });
    }
    return;
  }
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
  if (isPreviewRefreshHeld()) {
    return;
  }
  if (state.recycleBin.open || hasHoveredInteractiveElements()) {
    return;
  }
  if (!autoRefreshSuspended) {
    resumeConfigRefresh();
    if (eventStreamState.connected) {
      flushRecordingsEventQueue();
      return;
    }
    if (!autoRefreshId) {
      startAutoRefresh();
    }
    return;
  }
  autoRefreshSuspended = false;
  resumeConfigRefresh();
  if (eventStreamState.connected) {
    flushRecordingsEventQueue();
    return;
  }
  startAutoRefresh();
}

function isPreviewRefreshHeld() {
  return previewRefreshHold;
}

function markPreviewRefreshPending() {
  previewRefreshPending = true;
}

function holdPreviewRefresh() {
  if (previewRefreshHold) {
    return;
  }
  previewRefreshHold = true;
  suspendAutoRefresh();
}

function releasePreviewRefresh() {
  if (!previewRefreshHold) {
    return;
  }
  previewRefreshHold = false;
  resumeAutoRefresh();
  if (!previewRefreshPending) {
    return;
  }
  previewRefreshPending = false;
  renderRecords({ force: true });
  updateSelectionUI();
  applyNowPlayingHighlight();
  syncPlayerPlacement();
  requestRecordingsRefresh({ immediate: true });
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

function createEventStreamSource(url) {
  if (!EVENT_STREAM_SUPPORTED || !url) {
    return null;
  }
  if (eventStreamState.credentialInitUnsupported) {
    return null;
  }
  const creation = eventStreamFactory.create(url, {
    requiresCredentials: EVENT_STREAM_REQUIRES_CREDENTIALS,
    label: "dashboard event stream",
  });
  if (!creation) {
    return null;
  }
  if (creation.credentialInitUnsupported) {
    eventStreamState.credentialInitUnsupported = true;
    return null;
  }
  return creation.source || null;
}

function resetEventStreamBackoff() {
  eventStreamState.reconnectDelayMs = EVENT_STREAM_RETRY_MIN_MS;
}

function scheduleEventStreamHeartbeatCheck() {
  if (eventStreamState.heartbeatHandle) {
    window.clearTimeout(eventStreamState.heartbeatHandle);
  }
  if (!eventStreamState.connected) {
    eventStreamState.heartbeatHandle = null;
    return;
  }
  eventStreamState.heartbeatHandle = window.setTimeout(() => {
    const elapsed = Date.now() - eventStreamState.lastHeartbeat;
    if (elapsed >= EVENT_STREAM_HEARTBEAT_TIMEOUT_MS) {
      console.warn("Dashboard event stream heartbeat timeout");
      closeEventStream({ scheduleReconnect: true });
      return;
    }
    scheduleEventStreamHeartbeatCheck();
  }, EVENT_STREAM_HEARTBEAT_TIMEOUT_MS);
}

function markEventStreamHeartbeat() {
  eventStreamState.lastHeartbeat = Date.now();
  if (!eventStreamState.connected) {
    eventStreamState.connected = true;
    updateOfflineState(false);
  }
  scheduleEventStreamHeartbeatCheck();
}

function closeEventStream({ scheduleReconnect = false } = {}) {
  if (eventStreamState.heartbeatHandle) {
    window.clearTimeout(eventStreamState.heartbeatHandle);
    eventStreamState.heartbeatHandle = null;
