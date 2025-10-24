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
  CAPTURE_STOP_ENDPOINT,
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
} from "./dashboard/utils/dashboardRuntime.js";
import {
  toFinalizedRecordingPath,
  findFinalizedRecordForPartial,
  normalizeRecordingProgressRecord,
  deriveInProgressRecord,
  computeRecordsFingerprint,
  computePartialFingerprint,
} from "./dashboard/utils/recordingProgress.js";
import {
  recordMetadataChanged,
  resolveTriggerFlags,
} from "./dashboard/utils/recordMetadata.js";
import {
  ensureTriggerBadge,
  updateMetaPill,
  updateSubtextSpan,
} from "./dashboard/layout/recordRowDom.js";
import {
  initializeWaveformControls,
  setCursorFraction,
  updateWaveformClock,
  setWaveformMarker,
  layoutWaveformMarkerLabels,
  renderMotionSegments,
  setWaveformClipSelection,
  updateWaveformMarkers,
  updateCursorFromPlayer,
  handlePlayerLoadedMetadata,
  stopCursorAnimation,
  startCursorAnimation,
  clearWaveformRefresh,
  scheduleWaveformRefresh,
  resetWaveform,
  getWaveformZoomLimits,
  normalizeWaveformZoom,
  restoreWaveformPreferences,
  updateWaveformZoomDisplay,
  getWaveformAmplitudeScale,
  drawWaveformFromPeaks,
  redrawWaveform,
  loadWaveform,
  seekFromPointer,
  handleWaveformPointerDown,
  handleWaveformPointerMove,
  handleWaveformPointerUp,
} from "./dashboard/layout/waveformControls.js";
import { createRecorderConfigUi } from "./dashboard/layout/recorderConfigUi.js";
import { createFilterControls } from "./dashboard/layout/filterControls.js";
import { createLiveStreamControls } from "./dashboard/layout/liveStreamControls.js";
import { createDashboardInitializer } from "./dashboard/layout/dashboardInitializer.js";
import { createRecycleBinService } from "./dashboard/services/recycleBinService.js";
import {
  parseBoolean,
  parseMotionFlag,
  isMotionTriggeredEvent,
  resolveNextMotionState,
  parseListInput,
  extractErrorMessage,
  audioDefaults,
  canonicalAudioSettings,
  canonicalAudioFromConfig,
  segmenterDefaults,
  canonicalSegmenterSettings,
  canonicalSegmenterFromConfig,
  adaptiveDefaults,
  canonicalAdaptiveSettings,
  canonicalAdaptiveFromConfig,
  ingestDefaults,
  canonicalIngestSettings,
  canonicalIngestFromConfig,
  loggingDefaults,
  canonicalLoggingSettings,
  canonicalLoggingFromConfig,
  streamingDefaults,
  canonicalStreamingSettings,
  canonicalStreamingFromConfig,
  dashboardDefaults,
  canonicalDashboardSettings,
  canonicalDashboardFromConfig,
  pathsDefaults,
  canonicalPathsSettings,
  canonicalPathsFromConfig,
  notificationsDefaults,
  canonicalNotificationsSettings,
  canonicalNotificationsFromConfig,
  transcriptionDefaults,
  canonicalTranscriptionSettings,
  canonicalTranscriptionFromConfig,
} from "./dashboard/utils/recorderSettings.js";

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
if (storedCollection === "saved" || storedCollection === "recent" || storedCollection === "recycle") {
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
  isRecycleBinRecord,
  recycleBinContainsId,
  recycleBinAudioUrl,
  recycleBinWaveformUrl,
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

function isRecycleView() {
  return state.collection === "recycle";
}

function recyclePathFromId(id) {
  if (typeof id !== "string" || !id) {
    return "";
  }
  return `recycle-bin/${id}`;
}

function recycleIdFromPath(path) {
  if (typeof path !== "string" || !path) {
    return "";
  }
  if (!path.startsWith("recycle-bin/")) {
    return "";
  }
  return path.slice("recycle-bin/".length);
}

function applyRecycleSelectionToPaths() {
  if (!isRecycleView()) {
    return;
  }
  const selectedPaths = new Set(
    Array.from(state.recycleBin.selected.values())
      .map((id) => recyclePathFromId(id))
      .filter(Boolean),
  );
  state.selections = selectedPaths;
  const anchorPath = recyclePathFromId(state.recycleBin.anchorId);
  state.selectionAnchor = anchorPath;
  if (anchorPath) {
    state.selectionFocus = anchorPath;
  } else if (state.selections.size === 0) {
    state.selectionFocus = "";
  }
}

function syncRecycleSelectionFromPaths() {
  if (!isRecycleView()) {
    return;
  }
  const nextSelected = new Set();
  for (const path of state.selections) {
    const id = recycleIdFromPath(path);
    if (id) {
      nextSelected.add(id);
    }
  }
  state.recycleBin.selected = nextSelected;
  state.recycleBin.anchorId = recycleIdFromPath(state.selectionAnchor);
  const focusId = recycleIdFromPath(state.selectionFocus);
  if (focusId) {
    state.recycleBin.activeId = focusId;
  } else if (!nextSelected.has(state.recycleBin.activeId)) {
    state.recycleBin.activeId = "";
  }
  persistRecycleBinState();
}

function renderRecycleBinList() {
  const items = Array.isArray(state.recycleBin.items) ? state.recycleBin.items : [];
  const records = [];
  let totalSize = 0;
  for (const item of items) {
    const record = recycleBinRecordFromItem(item);
    if (!record || typeof record.path !== "string" || !record.path) {
      continue;
    }
    records.push(record);
    const sizeValue = Number(record.size_bytes);
    if (Number.isFinite(sizeValue) && sizeValue > 0) {
      totalSize += sizeValue;
    }
  }
  if (!isRecycleView()) {
    return;
  }
  state.records = records;
  state.total = records.length;
  state.filteredSize = totalSize;
  state.offset = 0;
  state.recordsFingerprint = computeRecordsFingerprint(records, { skipPartialVolatile: true });
  state.lastUpdated = Date.now();
  applyRecycleSelectionToPaths();
  renderRecords({ force: true });
  updateStats();
  updatePaginationControls();
}

function updateRecycleBinListControls() {
  if (!isRecycleView()) {
    return;
  }
  updateSelectionUI();
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
  capturing: false,
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
  clipSelection: null,
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
  updateClipSelectionRange: setWaveformClipSelection,
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
  processed: "Opus",
  raw: "Wav",
};

const configState = {
  prePadSeconds: null,
  postPadSeconds: null,
};

const {
  stopLiveStream,
  openLiveStreamPanel,
  closeLiveStreamPanel,
  focusLiveStreamPanel,
  focusPreviewSurface,
  releaseLiveAudioFocus,
} = createLiveStreamControls({
  dom,
  liveState,
  playbackState,
  ensureSessionId,
  setLiveStatus,
  sendStart,
  sendStop,
  scheduleLiveStats,
  cancelLiveStats,
  loadHlsLibrary,
  nativeHlsSupported,
  streamMode: STREAM_MODE,
  hlsUrl: HLS_URL,
  iceServers: WEBRTC_ICE_SERVERS,
  offerEndpoint: OFFER_ENDPOINT,
  apiClient,
  withSession,
  setLiveButtonState,
  focusElementSilently,
});

initializeWaveformControls({
  dom,
  state,
  configState,
  waveformState,
  clamp,
  formatClockTime,
  formatWaveformZoom,
  formatDuration,
  normalizeMotionSegments,
  toFiniteOrNull,
  recordWaveformUrl,
  renderRecords,
  updatePlayerMeta,
  hideWaveformRms,
  updateWaveformRms,
  getPlayerDurationSeconds,
  focusPreviewSurface,
  getStoredWaveformAmplitude,
  playbackState,
});

const focusState = {
  previewPointer: false,
  livePointer: false,
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

const transcriptionModelState = {
  loading: false,
  models: [],
};


let fetchRecycleBinDelegate = () => Promise.resolve();

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

const {
  handleRecorderConfigSnapshot,
  updateRecorderConfigPath,
  ensureRecorderSectionsLoaded,
  registerRecorderSection,
  registerRecorderSections,
  applyAudioForm,
  readAudioForm,
  applySegmenterForm,
  readSegmenterForm,
  applyAdaptiveForm,
  readAdaptiveForm,
  applyIngestForm,
  readIngestForm,
  applyPathsForm,
  readPathsForm,
  applyTranscriptionForm,
  readTranscriptionForm,
  setTranscriptionModelStatus,
  setTranscriptionModelLoading,
  hideTranscriptionModelDiscovery,
  showTranscriptionModelDiscovery,
  applySelectedTranscriptionModel,
  refreshTranscriptionModels,
  applyLoggingForm,
  readLoggingForm,
  applyNotificationsForm,
  readNotificationsForm,
  applyStreamingForm,
  readStreamingForm,
  applyDashboardForm,
  readDashboardForm,
  configModalFocusableElements,
  setConfigModalVisible,
  attachConfigDialogKeydown,
  detachConfigDialogKeydown,
  focusConfigDialog,
  openConfigModal,
  closeConfigModal,
  servicesModalFocusableElements,
  setServicesModalVisible,
  attachServicesDialogKeydown,
  detachServicesDialogKeydown,
  focusServicesDialog,
  openServicesModal,
  closeServicesModal,
} = createRecorderConfigUi({
  state,
  dom,
  recorderState,
  recorderDom,
  recorderDialogState,
  configDialogState,
  servicesDialogState,
  transcriptionModelState,
  apiClient,
  lockDocumentScroll,
  unlockDocumentScroll,
  suspendAutoRefresh,
  resumeAutoRefresh,
  fetchConfig,
  fetchServices,
  startServicesRefresh,
  stopServicesRefresh,
  getRecorderSection,
  applyRecorderSectionData,
  setRecorderStatus,
  updateRecorderButtons,
  fetchRecorderSection,
  saveRecorderSection,
  markRecorderSectionDirty,
  resetRecorderSection,
  firstRecorderSectionKey,
  setActiveRecorderSection,
  updateAudioFilterControls,
  audioDefaults,
  canonicalAudioSettings,
  canonicalAudioFromConfig,
  segmenterDefaults,
  canonicalSegmenterSettings,
  canonicalSegmenterFromConfig,
  adaptiveDefaults,
  canonicalAdaptiveSettings,
  canonicalAdaptiveFromConfig,
  ingestDefaults,
  canonicalIngestSettings,
  canonicalIngestFromConfig,
  transcriptionDefaults,
  canonicalTranscriptionSettings,
  canonicalTranscriptionFromConfig,
  loggingDefaults,
  canonicalLoggingSettings,
  canonicalLoggingFromConfig,
  pathsDefaults,
  canonicalPathsSettings,
  canonicalPathsFromConfig,
  notificationsDefaults,
  canonicalNotificationsSettings,
  canonicalNotificationsFromConfig,
  streamingDefaults,
  canonicalStreamingSettings,
  canonicalStreamingFromConfig,
  dashboardDefaults,
  canonicalDashboardSettings,
  canonicalDashboardFromConfig,
  parseListInput,
});


const {
  fetchRecycleBin,
  restoreRecycleBinSelection,
  purgeRecycleBinSelection,
  purgeRecycleBinEntries,
  requestRecordDeletion,
  requestSelectionDeletion,
  deleteRecordings,
  renameRecording,
} = createRecycleBinService({
  state,
  apiClient,
  apiPath,
  normalizeStartTimestamps,
  toFiniteOrNull,
  recycleBinContainsId,
  persistRecycleBinState,
  renderRecycleBinItems: renderRecycleBinList,
  updateRecycleBinControls: updateRecycleBinListControls,
  ensureOfflineStateOnError,
  handleFetchFailure,
  fetchRecordings,
  confirmRecycleBinPurgePrompt,
  confirmDeletionPrompt,
  updatePendingSelectionPath,
  setNowPlaying,
  getVisibleRecords,
  updateSelectionUI,
  syncRecycleSelectionFromPaths,
  recyclePathFromId,
});

fetchRecycleBinDelegate = fetchRecycleBin;

const { applyFiltersFromInputs, clearFilters } = createFilterControls({
  dom,
  state,
  clampLimitValue,
  persistFilters,
  clearStoredFilters,
  defaultLimit: DEFAULT_LIMIT,
  validTimeRanges: VALID_TIME_RANGES,
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
  source: null,
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
});

function requestRecordingsRefresh({ immediate = false } = {}) {
  if (autoRefreshSuspended) {
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
    if (autoRefreshSuspended) {
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
  if (autoRefreshSuspended || autoRefreshId) {
    return;
  }
  if (eventStreamState.connected) {
    flushRecordingsEventQueue();
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
  if (hasHoveredInteractiveElements()) {
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
  }
  const source = eventStreamState.source;
  if (source instanceof EventSource) {
    source.removeEventListener("open", handleEventStreamOpen);
    source.removeEventListener("error", handleEventStreamError);
    source.removeEventListener("capture_status", handleCaptureStatusEvent);
    source.removeEventListener("config_updated", handleConfigUpdatedEvent);
    source.removeEventListener("recordings_changed", handleRecordingsChangedEvent);
    source.removeEventListener("system_health_updated", handleSystemHealthUpdatedEvent);
    source.removeEventListener("heartbeat", handleEventStreamHeartbeat);
    try {
      source.close();
    } catch (error) {
      console.debug("Failed to close dashboard event stream", error);
    }
  }
  eventStreamState.source = null;
  eventStreamState.connected = false;
  if (eventStreamState.reconnectHandle) {
    window.clearTimeout(eventStreamState.reconnectHandle);
    eventStreamState.reconnectHandle = null;
  }
  if (scheduleReconnect) {
    scheduleEventStreamReconnect();
    enablePollingFallback();
  }
}

function scheduleEventStreamReconnect() {
  if (eventStreamState.reconnectHandle) {
    return;
  }
  const delay = Math.min(eventStreamState.reconnectDelayMs, EVENT_STREAM_RETRY_MAX_MS);
  eventStreamState.reconnectHandle = window.setTimeout(() => {
    eventStreamState.reconnectHandle = null;
    openEventStream();
  }, delay);
  eventStreamState.reconnectDelayMs = Math.min(
    EVENT_STREAM_RETRY_MAX_MS,
    eventStreamState.reconnectDelayMs * 2
  );
}

function handleEventStreamOpen() {
  resetEventStreamBackoff();
  markEventStreamHeartbeat();
  pollingFallbackActive = false;
  stopAutoRefresh();
  stopHealthRefresh();
  stopConfigRefresh();
  flushRecordingsEventQueue();
  requestSystemHealthRefresh({ immediate: true });
  requestConfigRefresh({ immediate: true });
  if (eventStreamState.reconnectHandle) {
    window.clearTimeout(eventStreamState.reconnectHandle);
    eventStreamState.reconnectHandle = null;
  }
}

function handleEventStreamError(event) {
  if (!eventStreamState.source) {
    return;
  }
  if (eventStreamState.source.readyState === EventSource.CLOSED) {
    closeEventStream({ scheduleReconnect: true });
  } else if (eventStreamState.source.readyState === EventSource.CONNECTING) {
    closeEventStream({ scheduleReconnect: true });
  }
}

function handleEventStreamHeartbeat() {
  markEventStreamHeartbeat();
}

function parseEventStreamData(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Failed to parse dashboard event payload", error);
    return null;
  }
}

function isCaptureSessionActive(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }

  let capturing = Boolean(snapshot.capturing);
  const event =
    snapshot && typeof snapshot.event === "object" ? snapshot.event : null;
  if (!capturing && event && parseBoolean(event.in_progress)) {
    capturing = true;
  }

  const manualRecording = parseBoolean(snapshot.manual_recording);
  return capturing || manualRecording;
}

function applyCaptureStatusPush(rawStatus) {
  const previousStatus =
    state.captureStatus && typeof state.captureStatus === "object"
      ? state.captureStatus
      : null;
  const previousPartialRecord =
    state.partialRecord && typeof state.partialRecord === "object"
      ? state.partialRecord
      : null;
  const previousPartialPath =
    previousPartialRecord && typeof previousPartialRecord.path === "string"
      ? previousPartialRecord.path
      : "";
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const wasActive = isCaptureSessionActive(previousStatus);

  updateDashboardState((draft) => {
    draft.captureStatus = status;
  }, "capture:status");
  const previousMotionState =
    state.motionState && typeof state.motionState === "object"
      ? state.motionState
      : null;
  let motionSnapshot = null;
  if (status && typeof status === "object") {
    const hasEmbeddedState =
      status.motion_state && typeof status.motion_state === "object";
    if (hasEmbeddedState) {
      motionSnapshot = { ...status.motion_state };
    }
    const motionKeys = [
      "motion_sequence",
      "motion_padding_config_seconds",
      "motion_padding_seconds_remaining",
      "motion_padding_deadline_epoch",
      "motion_padding_started_epoch",
    ];
    for (const key of motionKeys) {
      if (Object.prototype.hasOwnProperty.call(status, key)) {
        if (!motionSnapshot) {
          motionSnapshot = previousMotionState
            ? { ...previousMotionState }
            : {};
        }
        motionSnapshot[key] = status[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(status, "motion_active")) {
      if (!motionSnapshot) {
        motionSnapshot = previousMotionState
          ? { ...previousMotionState }
          : {};
      }
      motionSnapshot.motion_active = status.motion_active;
    }
    if (motionSnapshot && Object.keys(motionSnapshot).length === 0) {
      motionSnapshot = null;
    }
  }
  let nextMotionState = resolveNextMotionState(
    motionSnapshot,
    previousMotionState,
    eventStreamState.connected
  );
  if (
    nextMotionState === previousMotionState &&
    motionSnapshot &&
    typeof motionSnapshot === "object" &&
    previousMotionState &&
    typeof previousMotionState === "object" &&
    eventStreamState.connected
  ) {
    const snapshotKeys = Object.keys(motionSnapshot);
    let hasDifference = false;
    for (const key of snapshotKeys) {
      if (!Object.is(motionSnapshot[key], previousMotionState[key])) {
        hasDifference = true;
        break;
      }
    }
    if (hasDifference) {
      const mergedMotionState = { ...previousMotionState };
      for (const key of snapshotKeys) {
        if (Object.prototype.hasOwnProperty.call(motionSnapshot, key)) {
          mergedMotionState[key] = motionSnapshot[key];
        }
      }
      nextMotionState = mergedMotionState;
    }
  }
  updateDashboardState((draft) => {
    draft.motionState = nextMotionState;
  }, "capture:motion");

  setRecordingIndicatorStatus(status, state.motionState);
  updateRmsIndicator(status);
  updateRecordingMeta(status);
  updateEncodingStatus(status);
  updateSplitEventButton(status);
  updateAutoRecordButton(status);
  updateManualRecordButton(status);

  let nextPartial = null;
  if (
    status &&
    typeof status === "object" &&
    status.recording_progress &&
    typeof status.recording_progress === "object"
  ) {
    nextPartial = normalizeRecordingProgressRecord(status.recording_progress);
  }
  if (!nextPartial) {
    nextPartial = deriveInProgressRecord(status);
  }
  const nextPartialFingerprint = computePartialFingerprint(nextPartial);
  const previousFingerprint = state.partialFingerprint;
  const nextPartialPath =
    nextPartial && typeof nextPartial.path === "string"
      ? nextPartial.path
      : "";
  updateDashboardState((draft) => {
    draft.partialRecord = nextPartial;
    draft.partialFingerprint = nextPartialFingerprint;
    if (nextPartial && nextPartial.path) {
      draft.selections.delete(nextPartial.path);
    }
  }, "capture:partial");

  const partialChanged = previousFingerprint !== nextPartialFingerprint;

  if (partialChanged) {
    if (state.current && state.current.isPartial) {
      if (nextPartial && state.current.path === nextPartial.path) {
        state.current = nextPartial;
        const playbackInfo = updatePlaybackSourceForRecord(nextPartial, {
          preserveMode: true,
        });
        updatePlayerMeta(nextPartial);
        if (playbackInfo.previousMode === "raw" && playbackInfo.nextMode !== "raw") {
          setPlaybackSource(playbackInfo.nextMode, { force: true });
        } else if (playbackInfo.nextMode === "raw" && playbackInfo.rawPathChanged) {
          setPlaybackSource("raw", { force: true });
        }
      } else if (!nextPartial) {
        setNowPlaying(null);
      }
    }
  }

  const nextActive = isCaptureSessionActive(status);
  const partialPathChanged = previousPartialPath !== nextPartialPath;
  const partialAppeared = partialPathChanged && Boolean(nextPartialPath);
  const partialCleared =
    partialPathChanged && Boolean(previousPartialPath) && !nextPartialPath;

  if (wasActive && !nextActive) {
    requestRecordingsRefresh({ immediate: true });
  } else if (!wasActive && nextActive) {
    requestRecordingsRefresh();
  } else if (partialAppeared || (partialPathChanged && nextActive)) {
    requestRecordingsRefresh();
  } else if (partialCleared) {
    requestRecordingsRefresh({ immediate: true });
  }

  if (partialChanged) {
    if (isPreviewRefreshHeld()) {
      markPreviewRefreshPending();
    } else {
      renderRecords();
      updateSelectionUI();
      applyNowPlayingHighlight();
      syncPlayerPlacement();
    }
  }
}

function handleCaptureStatusEvent(event) {
  markEventStreamHeartbeat();
  if (!event) {
    return;
  }
  if (typeof event.lastEventId === "string" && event.lastEventId) {
    eventStreamState.lastEventId = event.lastEventId;
  }
  const payload = parseEventStreamData(event.data);
  if (payload && typeof payload === "object") {
    applyCaptureStatusPush(payload);
  }
}

function handleConfigUpdatedEvent(event) {
  markEventStreamHeartbeat();
  if (!event) {
    return;
  }
  if (typeof event.lastEventId === "string" && event.lastEventId) {
    eventStreamState.lastEventId = event.lastEventId;
  }
  const payload = parseEventStreamData(event.data);
  if (payload && typeof payload === "object") {
    const rawSection = typeof payload.section === "string" ? payload.section.trim() : "";
    const sectionKey = rawSection.toLowerCase();
    if (sectionKey === "archival" && !archivalState.saving) {
      notifyArchivalExternalUpdate();
    } else if (sectionKey === "web_server" && !webServerState.saving) {
      notifyWebServerExternalUpdate();
    } else if (recorderState.sections.has(sectionKey)) {
      const section = recorderState.sections.get(sectionKey);
      if (section && !section.state.saving) {
        section.state.hasExternalUpdate = true;
        if (!section.state.dirty) {
          setRecorderStatus(sectionKey, "Updated on disk. Reset to load changes.", "info");
        }
        updateRecorderButtons(sectionKey);
      }
    }
  }
  requestConfigRefresh();
}

function handleRecordingsChangedEvent(event) {
  markEventStreamHeartbeat();
  if (!event) {
    return;
  }
  if (typeof event.lastEventId === "string" && event.lastEventId) {
    eventStreamState.lastEventId = event.lastEventId;
  }
  requestRecordingsRefresh();
}

function handleSystemHealthUpdatedEvent(event) {
  markEventStreamHeartbeat();
  if (!event) {
    return;
  }
  if (typeof event.lastEventId === "string" && event.lastEventId) {
    eventStreamState.lastEventId = event.lastEventId;
  }
  requestSystemHealthRefresh();
}

function openEventStream() {
  if (typeof window === "undefined") {
    return;
  }
  if (!EVENT_STREAM_SUPPORTED) {
    enablePollingFallback();
    return;
  }
  if (eventStreamState.credentialInitUnsupported) {
    enablePollingFallback();
    return;
  }
  if (eventStreamState.source) {
    return;
  }
  try {
    const lastEventId =
      typeof eventStreamState.lastEventId === "string" && eventStreamState.lastEventId
        ? eventStreamState.lastEventId
        : null;
    const baseEventsUrl = EVENTS_ENDPOINT;
    const eventsUrl = lastEventId
      ? `${baseEventsUrl}${baseEventsUrl.includes("?") ? "&" : "?"}last_event_id=${encodeURIComponent(
          lastEventId
        )}`
      : baseEventsUrl;
    const source = createEventStreamSource(eventsUrl);
    if (!source) {
      enablePollingFallback();
      if (!eventStreamState.credentialInitUnsupported) {
        scheduleEventStreamReconnect();
      }
      return;
    }
    eventStreamState.source = source;
    eventStreamState.lastHeartbeat = Date.now();
    source.addEventListener("open", handleEventStreamOpen);
    source.addEventListener("error", handleEventStreamError);
    source.addEventListener("capture_status", handleCaptureStatusEvent);
    source.addEventListener("config_updated", handleConfigUpdatedEvent);
    source.addEventListener("recordings_changed", handleRecordingsChangedEvent);
    source.addEventListener("system_health_updated", handleSystemHealthUpdatedEvent);
    source.addEventListener("heartbeat", handleEventStreamHeartbeat);
  } catch (error) {
    console.error("Failed to open dashboard event stream", error);
    enablePollingFallback();
    scheduleEventStreamReconnect();
    return;
  }

  resetEventStreamBackoff();
  scheduleEventStreamHeartbeatCheck();
}

function initializeEventStream() {
  if (typeof document === "undefined") {
    return;
  }
  openEventStream();
}

function applyRecordingIndicator(state, message, { motion = false } = {}) {
  setTabRecordingActive(state === "active", { motion });
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
  let autoRecordingEnabled = true;
  if (Object.prototype.hasOwnProperty.call(rawStatus, "auto_recording_enabled")) {
    autoRecordingEnabled = parseBoolean(rawStatus.auto_recording_enabled);
  }
  const motionOverrideEnabled = parseBoolean(rawStatus.auto_record_motion_override);
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
  const autoPaused = !capturing && !manualRecording && !autoRecordingEnabled;
  const disabled =
    autoPaused || (!capturing && normalizedStopReason === "shutdown");
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
      if (motionTriggered && !manualRecording && !autoRecordingEnabled && motionOverrideEnabled) {
        message = startedLabel
          ? `Motion override recording since ${startedLabel}`
          : "Motion override recording";
      } else {
        message = startedLabel
          ? `Recording active since ${startedLabel}`
          : "Recording active";
        if (!autoRecordingEnabled && !motionTriggered) {
          if (motionOverrideEnabled) {
            message += " • Motion override armed";
          } else {
            message += " • Auto capture paused";
          }
        }
      }
    }
    if (detail) {
      message += ` • ${detail}`;
    }
  } else {
    if (manualRecording) {
      message = "Manual recording enabled";
    } else if (!autoRecordingEnabled) {
      message = "Auto capture paused";
      if (motionOverrideEnabled) {
        message += " • Motion override armed";
      }
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
  updateSplitEventState((draft) => {
    draft.pending = nextPending;
  }, nextPending ? "split:pending" : "split:idle");
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
    const response = await apiClient.fetch(SPLIT_ENDPOINT, { method: "POST" });
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

function hideRmsIndicator() {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  if (dom.rmsIndicator.dataset.preview === "true") {
    return;
  }
  if (dom.rmsIndicator.dataset.visible !== "false") {
    dom.rmsIndicator.dataset.visible = "false";
  }
  if (dom.rmsIndicator.dataset.source) {
    delete dom.rmsIndicator.dataset.source;
  }
  dom.rmsIndicator.setAttribute("aria-hidden", "true");
  dom.rmsIndicatorValue.textContent = "";
  rmsIndicatorState.visible = false;
  rmsIndicatorState.value = null;
  rmsIndicatorState.threshold = null;
  rmsIndicatorState.source = null;
}

function updateRmsIndicator(rawStatus) {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  if (dom.rmsIndicator.dataset.preview === "true") {
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
  dom.rmsIndicator.dataset.source = "status";
  dom.rmsIndicator.setAttribute("aria-hidden", "false");
  rmsIndicatorState.visible = true;
  rmsIndicatorState.value = whole;
  rmsIndicatorState.threshold = Number.isFinite(thresholdWhole) ? thresholdWhole : null;
  rmsIndicatorState.source = "status";
}

function handleFetchSuccess() {
  setAutoRefreshInterval(AUTO_REFRESH_INTERVAL_MS);
  updateOfflineState(false);
}

function handleFetchFailure() {
  setAutoRefreshInterval(OFFLINE_REFRESH_INTERVAL_MS);
  updateOfflineState(true);
}

function populateFilters() {
  syncFiltersPanel({
    dom,
    state,
    validTimeRanges: VALID_TIME_RANGES,
    clampLimitValue,
    persistFilters,
  });
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
  const sorted = [...state.records].sort(compareRecords);
  if (state.partialRecord && !isRecycleView()) {
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
  const isRecycle = isRecycleView();
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
  dom.deleteSelected.disabled = isRecycle || state.selections.size === 0;
  if (dom.downloadSelected) {
    dom.downloadSelected.disabled = isRecycle || state.selections.size === 0;
  }
  if (dom.renameSelected) {
    dom.renameSelected.disabled =
      isRecycle || state.selections.size !== 1 || isRenameDialogPending();
  }
  if (dom.restoreSelected) {
    dom.restoreSelected.disabled = !isRecycle || state.selections.size === 0;
  }
  if (dom.purgeSelected) {
    dom.purgeSelected.disabled = !isRecycle || state.selections.size === 0;
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

  if (isRecycle) {
    syncRecycleSelectionFromPaths();
  }
}

function renderEmptyState(message) {
  renderClipListEmptyState(dom.tableBody, message);
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

function getRawDownloadName(record) {
  if (!recordHasRawAudio(record)) {
    return "";
  }
  if (isRecycleBinRecord(record)) {
    const candidate =
      typeof record.recycleBinRawName === "string" && record.recycleBinRawName
        ? record.recycleBinRawName
        : "";
    return candidate;
  }
  const rawPath =
    record && typeof record.raw_audio_path === "string" ? record.raw_audio_path.trim() : "";
  if (!rawPath) {
    return "";
  }
  const parts = rawPath.split("/");
  return parts.length ? parts[parts.length - 1] : "";
}

function getProcessedDownloadName(record) {
  if (!record || typeof record.path !== "string" || !record.path) {
    return "";
  }
  const baseName =
    typeof record.name === "string" && record.name ? record.name : record.path;
  const extension =
    typeof record.extension === "string" && record.extension ? `.${record.extension}` : "";
  return `${baseName}${extension}`;
}

function resolveRecordDownloadName(record) {
  if (!record || typeof record.path !== "string" || !record.path) {
    return "";
  }
  const baseName = typeof record.name === "string" && record.name ? record.name : record.path;
  const rawActive = playbackSourceState.mode === "raw" && playbackSourceState.hasRaw;
  if (rawActive) {
    const rawName = getRawDownloadName(record);
    if (rawName) {
      return rawName;
    }
  }
  return getProcessedDownloadName(record);
}

function updatePlayerMeta(record) {
  const metaTarget = dom.playerMetaText || dom.playerMeta;
  if (!metaTarget) {
    return;
  }

  const hasRecord = Boolean(
    record && typeof record.path === "string" && record.path.trim() !== ""
  );
  if (!hasRecord) {
    metaTarget.textContent = "Select a recording to preview.";
    return;
  }

  const isPartial = Boolean(record.isPartial);
  const isRecycle = isRecycleBinRecord(record);
  const details = [];
  const triggerFlags = resolveTriggerFlags(record.trigger_sources);
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
    metaTarget.textContent = `Filename: ${baseDetails.join(" • ")}`;
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
    if (triggerFlags.manual) {
      details.push("Manual recording");
    }
    if (triggerFlags.split) {
      details.push("Split event");
    }
    if (triggerFlags.rmsVad) {
      details.push("RMS + VAD");
    }
    metaTarget.textContent = `Filename: ${details.join(" • ")}`;
  }
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
  let targetRow = sourceRow ?? findRowForRecord(record);
  if (targetRow && !targetRow.parentElement) {
    targetRow = findRowForRecord(record);
  }
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
  const parent = targetRow.parentElement;
  const nextSibling = targetRow.nextSibling;
  if (nextSibling) {
    parent.insertBefore(playerRow, nextSibling);
  } else {
    parent.append(playerRow);
  }
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

function updatePlaybackSourceForRecord(record, { preserveMode = false } = {}) {
  const previousMode = normalizePlaybackSource(playbackSourceState.mode);
  const previousRawPath =
    typeof playbackSourceState.rawPath === "string" ? playbackSourceState.rawPath : "";
  const previousRecordPath =
    typeof playbackSourceState.recordPath === "string" ? playbackSourceState.recordPath : "";

  const hasRaw = recordHasRawAudio(record);
  let rawPath = "";
  if (hasRaw) {
    rawPath = recordRawAudioUrl(record) || "";
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

  let nextMode = hasRaw ? "raw" : "processed";
  if (preserveMode) {
    nextMode = previousMode === "raw" && hasRaw ? "raw" : "processed";
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
  if (record) {
    holdPreviewRefresh();
  } else {
    releasePreviewRefresh();
  }
  setTransportActive(Boolean(record));
  if (!record) {
    updatePlaybackSourceForRecord(null);
    clipper.initialize(null);
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
    clipper.initialize(record);
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

function renderRecords(options = {}) {
  const { force = false } = options;
  if (!dom.tableBody) {
    return;
  }
  const previewHeld = isPreviewRefreshHeld();
  if (!force && previewHeld) {
    markPreviewRefreshPending();
    return;
  }
  if (!force || !previewHeld) {
    previewRefreshPending = false;
  }

  clearPendingSelectionRange();

  const shouldPreservePreview =
    previewIsActive() &&
    dom.playerCard &&
    (playerPlacement.mode === "desktop" || playerPlacement.mode === "mobile");
  if (shouldPreservePreview) {
    restorePlayerCardHome();
  }

  dom.tableBody.innerHTML = "";
  pruneHoveredInteractiveElements();

  const records = getVisibleRecords();

  if (!records.length) {
    const emptyMessage = isRecycleView()
      ? "No recordings in the recycle bin."
      : "No recordings match the selected filters.";
    renderEmptyState(emptyMessage);
    updateSelectionUI(records);
    applyNowPlayingHighlight();
    syncPlayerPlacement();
    return;
  }

  const clipListContext = {
    state,
    resolveTriggerFlags,
    isMotionTriggeredEvent,
    getRecordStartSeconds,
    formatDate,
    formatDuration,
    formatBytes,
    ensureTriggerBadge,
    recordAudioUrl,
    recordRawAudioUrl,
    recordHasRawAudio,
    getRawDownloadName,
    getProcessedDownloadName,
    resolvePlaybackSourceUrl,
    resolveRecordDownloadName,
    handleSaveRecord,
    handleUnsaveRecord,
    openRenameDialog,
    requestRecordDeletion,
    resolveSelectionAnchor,
    applySelectionRange,
    updateSelectionUI,
    applyNowPlayingHighlight,
    setNowPlaying,
    getPendingSelectionRange,
    setPendingSelectionRange,
    clearPendingSelectionRange,
  };

  for (const record of records) {
    const row = buildClipListRow(record, clipListContext);
    dom.tableBody.append(row);
  }

  applyNowPlayingHighlight();
  updateSelectionUI(records);
  syncPlayerPlacement();
  updatePaginationControls();
}

function ensureRecordMobileMeta(row) {
  if (!row) {
    return null;
  }
  let container = row.querySelector(".record-mobile-meta");
  if (container) {
    return container;
  }
  const nameCell = row.querySelector(".cell-name");
  if (!nameCell) {
    return null;
  }
  container = document.createElement("div");
  container.className = "record-mobile-meta";
  const title = nameCell.querySelector(".record-title");
  if (title && title.nextSibling) {
    nameCell.insertBefore(container, title.nextSibling);
  } else {
    nameCell.append(container);
  }
  return container;
}

function ensureRecordMobileSubtext(row) {
  if (!row) {
    return null;
  }
  let container = row.querySelector(".record-mobile-subtext");
  if (container) {
    return container;
  }
  const nameCell = row.querySelector(".cell-name");
  if (!nameCell) {
    return null;
  }
  container = document.createElement("div");
  container.className = "record-mobile-subtext";
  const meta = nameCell.querySelector(".record-mobile-meta");
  if (meta && meta.nextSibling) {
    nameCell.insertBefore(container, meta.nextSibling);
  } else {
    nameCell.append(container);
  }
  return container;
}function updateInProgressRecordRow(record) {
  if (!record || typeof record.path !== "string" || !record.path) {
    return false;
  }
  if (!dom.tableBody) {
    return false;
  }
  const row = findRowForRecord(record);
  if (!row) {
    return false;
  }

  row.dataset.recordingState = "in-progress";
  row.classList.add("record-in-progress");

  const isMotion = isMotionTriggeredEvent(record);
  const triggerFlags = resolveTriggerFlags(record.trigger_sources);
  if (isMotion) {
    row.dataset.motion = "true";
  } else if (row.dataset.motion) {
    delete row.dataset.motion;
  }

  const dayText = record.day || "—";
  const updatedSeconds = getRecordStartSeconds(record);
  const updatedText = formatDate(
    updatedSeconds !== null ? updatedSeconds : record.modified,
  );
  const durationText = formatDuration(record.duration_seconds);
  const sizeText = formatBytes(record.size_bytes);

  const dayCell = row.querySelector(".cell-day");
  if (dayCell) {
    dayCell.textContent = dayText;
  }
  const updatedCell = row.querySelector(".cell-updated");
  if (updatedCell) {
    updatedCell.textContent = updatedText;
  }
  const durationCell = row.querySelector(".cell-duration");
  if (durationCell) {
    durationCell.textContent = durationText;
  }
  const sizeCell = row.querySelector(".cell-size");
  if (sizeCell) {
    sizeCell.textContent = sizeText;
  }

  const nameCell = row.querySelector(".cell-name");
  if (nameCell) {
    const nameTitle = nameCell.querySelector(".record-title");
    if (nameTitle) {
      let motionBadge = nameTitle.querySelector(".badge-motion");
      if (isMotion) {
        if (!motionBadge) {
          motionBadge = document.createElement("span");
          motionBadge.className = "badge badge-motion";
          motionBadge.textContent = "Motion";
          const spacer = document.createTextNode(" ");
          nameTitle.append(spacer, motionBadge);
        }
      } else if (motionBadge) {
        const previousSibling = motionBadge.previousSibling;
        motionBadge.remove();
        if (
          previousSibling &&
          previousSibling.nodeType === Node.TEXT_NODE &&
          !previousSibling.textContent.trim()
        ) {
          previousSibling.remove();
        }
      }
    }
    ensureTriggerBadge(
      nameTitle,
      "manual",
      "Manual",
      "badge-trigger-manual",
      triggerFlags.manual,
    );
    ensureTriggerBadge(
      nameTitle,
      "split",
      "Split",
      "badge-trigger-split",
      triggerFlags.split,
    );
    ensureTriggerBadge(
      nameTitle,
      "rmsvad",
      "RMS + VAD",
      "badge-trigger-rmsvad",
      triggerFlags.rmsVad,
    );
  }

  const needsDurationPill = Boolean(durationText && durationText !== "--");
  const needsSizePill = Boolean(sizeText);
  if (
    isMotion ||
    needsDurationPill ||
    needsSizePill ||
    row.querySelector(".record-mobile-meta")
  ) {
    const metaContainer =
      isMotion || needsDurationPill || needsSizePill
        ? ensureRecordMobileMeta(row)
        : row.querySelector(".record-mobile-meta");
    if (metaContainer) {
      updateMetaPill(
        metaContainer,
        "duration",
        needsDurationPill ? `Length ${durationText}` : "",
      );
      updateMetaPill(
        metaContainer,
        "size",
        needsSizePill ? `Size ${sizeText}` : "",
      );
      updateMetaPill(
        metaContainer,
        "motion",
        isMotion ? "Motion event" : "",
        "meta-pill motion-pill",
      );
      updateMetaPill(
        metaContainer,
        "manual-trigger",
        triggerFlags.manual ? "Manual" : "",
        "meta-pill manual-pill",
      );
      updateMetaPill(
        metaContainer,
        "split-trigger",
        triggerFlags.split ? "Split event" : "",
        "meta-pill split-pill",
      );
      updateMetaPill(
        metaContainer,
        "rmsvad-trigger",
        triggerFlags.rmsVad ? "RMS + VAD" : "",
        "meta-pill rmsvad-pill",
      );
      if (!metaContainer.childElementCount) {
        metaContainer.remove();
      }
    }
  }

  const updatedSubtext = updatedText && updatedText !== "--" ? updatedText : "";
  const needsSubtext = Boolean(record.day) || Boolean(updatedSubtext);
  if (needsSubtext || row.querySelector(".record-mobile-subtext")) {
    const subtextContainer = needsSubtext
      ? ensureRecordMobileSubtext(row)
      : row.querySelector(".record-mobile-subtext");
    if (subtextContainer) {
      updateSubtextSpan(subtextContainer, "day", record.day || "");
      updateSubtextSpan(subtextContainer, "updated", updatedSubtext);
      const legacyExtension = subtextContainer.querySelector('[data-subtext-role="extension"]');
      if (legacyExtension && typeof legacyExtension.remove === "function") {
        legacyExtension.remove();
      }
      if (!subtextContainer.childElementCount) {
        subtextContainer.remove();
      }
    }
  }

  const statusLabel = row.querySelector(".in-progress-label");
  if (statusLabel) {
    statusLabel.textContent = record.inProgress ? "Recording…" : "Finalizing";
  }

  return true;
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
    const response = await apiClient.fetch(apiPath("/api/recordings/save"), {
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
    const response = await apiClient.fetch(apiPath("/api/recordings/unsave"), {
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
  const counts = state.collectionCounts || {};
  const recentCount = Number.isFinite(counts.recent) ? counts.recent : 0;
  const savedCount = Number.isFinite(counts.saved) ? counts.saved : 0;
  const recycleCount = Number.isFinite(counts.recycle) ? counts.recycle : 0;
  if (dom.recordingCountRecent) {
    dom.recordingCountRecent.textContent = recentCount.toString();
  }
  if (dom.recordingCountSaved) {
    dom.recordingCountSaved.textContent = savedCount.toString();
  }
  if (dom.recordingCountRecycle) {
    dom.recordingCountRecycle.textContent = recycleCount.toString();
  }

  const recentUsed = Number.isFinite(state.storage.recordings)
    ? state.storage.recordings
    : 0;
  const savedUsed = Number.isFinite(state.storage.saved) ? state.storage.saved : 0;
  const recycleBinUsed = Number.isFinite(state.storage.recycleBin)
    ? state.storage.recycleBin
    : 0;
  const totalUsed = recentUsed + savedUsed + recycleBinUsed;
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
    dom.storageUsageText.textContent = `${formatBytes(totalUsed)} of ${formatBytes(effectiveTotal)}`;
  } else if (hasCapacity) {
    dom.storageUsageText.textContent = `${formatBytes(totalUsed)} of ${formatBytes(Math.max(totalUsed, 0))}`;
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
    if (recycleBinUsed > 0 || savedUsed > 0) {
      const usageParts = [];
      usageParts.push(`Recycle bin: ${formatBytes(recycleBinUsed)}`);
      usageParts.push(`Saved: ${formatBytes(savedUsed)}`);
      parts.push(usageParts.join(" • "));
    }
    dom.storageHint.textContent = parts.join(" • ");
  } else {
    dom.storageHint.textContent = "Free space: --";
  }

  const progress = hasCapacity && Number.isFinite(effectiveTotal) && effectiveTotal > 0
    ? clamp((totalUsed / effectiveTotal) * 100, 0, 100)
    : 0;
  dom.storageProgress.style.width = `${progress}%`;
}

function updatePaginationControls() {
  const isRecycle = isRecycleView();
  const limit = clampLimitValue(state.filters.limit);
  const total = Number.isFinite(state.total) && state.total > 0 ? Math.trunc(state.total) : 0;
  const offset = isRecycle ? 0 : Number.isFinite(state.offset) ? Math.max(0, Math.trunc(state.offset)) : 0;
  const visibleCount = Array.isArray(state.records) ? state.records.length : 0;
  const collectionLabel = isRecycle
    ? "recycled recordings"
    : state.collection === "saved"
      ? "saved recordings"
      : "recordings";

  if (dom.resultsSummary) {
    let summary = "";
    if ((fetchInFlight || !state.lastUpdated) && total === 0 && visibleCount === 0) {
      summary = `Loading ${collectionLabel}…`;
    } else if (connectionState.offline && total === 0 && visibleCount === 0) {
      summary = `Unable to load ${collectionLabel}.`;
    } else if (total === 0) {
      summary = isRecycle
        ? "No recordings in the recycle bin."
        : Boolean(state.filters.search || state.filters.day || state.filters.timeRange)
          ? `No ${collectionLabel} match the selected filters.`
          : `No ${collectionLabel} available.`;
    } else if (isRecycle) {
      const sizeHint = state.filteredSize > 0 ? formatBytes(state.filteredSize) : null;
      summary = `Showing ${visibleCount} ${collectionLabel}${sizeHint ? ` • ${sizeHint} total` : ""}`;
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
    dom.paginationControls.hidden = isRecycle || total <= limit;
  }

  if (dom.paginationStatus) {
    if (isRecycle) {
      dom.paginationStatus.textContent = "Page 1 of 1";
    } else {
      const totalPages = total > 0 ? Math.max(Math.ceil(total / limit), 1) : 1;
      const currentPage = total > 0 ? Math.min(Math.floor(offset / limit) + 1, totalPages) : 1;
      dom.paginationStatus.textContent = `Page ${currentPage} of ${totalPages}`;
    }
  }

  if (dom.pagePrev) {
    dom.pagePrev.disabled = isRecycle || offset <= 0 || total === 0;
  }

  if (dom.pageNext) {
    const hasNext = !isRecycle && total > 0 && offset + visibleCount < total;
    dom.pageNext.disabled = !hasNext;
  }
}

function updateCollectionUI() {
  if (dom.recordingsHeading) {
    dom.recordingsHeading.textContent =
      state.collection === "saved"
        ? "Saved recordings"
        : state.collection === "recycle"
          ? "Recycle bin"
          : "Recent recordings";
  }
  const recentTab = dom.recordingsTabRecent;
  const savedTab = dom.recordingsTabSaved;
  const recycleTab = dom.recordingsTabRecycle;
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
  if (recycleTab) {
    const active = state.collection === "recycle";
    recycleTab.classList.toggle("active", active);
    recycleTab.dataset.active = active ? "true" : "false";
    recycleTab.setAttribute("aria-selected", active ? "true" : "false");
  }
  updateActionVisibility();
}

function updateActionVisibility() {
  const isRecycle = isRecycleView();
  if (dom.downloadSelected) {
    dom.downloadSelected.hidden = isRecycle;
  }
  if (dom.renameSelected) {
    dom.renameSelected.hidden = isRecycle;
  }
  if (dom.deleteSelected) {
    dom.deleteSelected.hidden = isRecycle;
  }
  if (dom.restoreSelected) {
    dom.restoreSelected.hidden = !isRecycle;
  }
  if (dom.purgeSelected) {
    dom.purgeSelected.hidden = !isRecycle;
  }
}

function hideWaveformRms() {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  if (!previewIsActive()) {
    delete dom.rmsIndicator.dataset.preview;
    hideRmsIndicator();
    return;
  }
  dom.rmsIndicator.dataset.preview = "true";
  dom.rmsIndicator.dataset.visible = "false";
  dom.rmsIndicator.setAttribute("aria-hidden", "true");
  dom.rmsIndicatorValue.textContent = "--";
  dom.rmsIndicatorValue.setAttribute("aria-hidden", "true");
}

function updateWaveformRms() {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
    return;
  }
  if (!previewIsActive()) {
    hideWaveformRms();
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
  dom.rmsIndicator.dataset.preview = "true";
  dom.rmsIndicator.dataset.visible = "true";
  dom.rmsIndicator.setAttribute("aria-hidden", "false");
  dom.rmsIndicatorValue.textContent = formatted;
  dom.rmsIndicatorValue.setAttribute("aria-hidden", "false");
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

function shouldIgnoreRecordDeletionTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const interactiveSelector =
    "input, textarea, select, button, [role='button'], [role='textbox'], [role='combobox'], [role='listbox'], a[href], summary";
  const interactive = target.closest(interactiveSelector);
  if (!interactive) {
    return false;
  }
  if (interactive instanceof HTMLInputElement) {
    const type = typeof interactive.type === "string" ? interactive.type.toLowerCase() : "";
    if (type === "checkbox" || type === "radio") {
      return false;
    }
  }
  return true;
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
  if (isConfirmDialogOpen()) {
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
    if (shouldIgnoreRecordDeletionTarget(event.target)) {
      return;
    }
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    const hasSelection = state.selections && state.selections.size > 0;
    if (isRecycleView()) {
      if (hasSelection) {
        await purgeRecycleBinSelection({ bypassConfirm: event.shiftKey });
        return;
      }
      if (!state.current || typeof state.current.path !== "string" || !state.current.path) {
        return;
      }
      const currentId = recycleIdFromPath(state.current.path);
      if (currentId) {
        await purgeRecycleBinEntries([currentId], { bypassConfirm: event.shiftKey });
      }
      return;
    }
    if (hasSelection) {
      await requestSelectionDeletion({ bypassConfirm: event.shiftKey });
      return;
    }
    if (!state.current || typeof state.current.path !== "string" || !state.current.path) {
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

function setCollection(nextCollection, options = {}) {
  const { force = false, fetch = true } = options;
  let normalized = "recent";
  if (nextCollection === "saved") {
    normalized = "saved";
  } else if (nextCollection === "recycle") {
    normalized = "recycle";
  }
  if (state.collection === normalized && !force) {
    if (fetch) {
      fetchRecordings({ silent: false, force: true });
    }
    return;
  }

  state.collection = normalized;
  persistCollection(state.collection);
  state.offset = 0;
  state.recycleBin.open = normalized === "recycle";
  if (normalized === "recycle") {
    applyRecycleSelectionToPaths();
  } else {
    state.selections.clear();
    state.selectionAnchor = "";
    state.selectionFocus = "";
  }
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
  recordingsRefreshDeferred = false;
  if (fetchInFlight) {
    fetchQueued = true;
    return;
  }
  fetchInFlight = true;

  if (isRecycleView()) {
    try {
      await fetchRecycleBin({ silent });
    } finally {
      fetchInFlight = false;
      updateStats();
      updatePaginationControls();
      if (fetchQueued) {
        fetchQueued = false;
        fetchRecordings({ silent: true, force: true });
      }
    }
    return;
  }

  const limit = clampLimitValue(state.filters.limit);
  if (limit !== state.filters.limit) {
    state.filters.limit = limit;
    persistFilters(state.filters);
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
    const response = await apiClient.fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    const payloadCollectionRaw =
      typeof payload.collection === "string" ? payload.collection.trim().toLowerCase() : "";
    const payloadCollection = payloadCollectionRaw === "saved" ? "saved" : "recent";
    if (state.collection !== payloadCollection) {
      state.collection = payloadCollection;
      persistCollection(state.collection);
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
        motion_segments: normalizeMotionSegments(item.motion_segments),
        waveform_path:
          typeof item.waveform_path === "string" && item.waveform_path
            ? String(item.waveform_path)
            : null,
        undo_token:
          typeof item.undo_token === "string" && item.undo_token.trim()
            ? item.undo_token.trim()
            : null,
        manual_event: Boolean(item.manual_event),
        detected_rms: Boolean(item.detected_rms),
        detected_vad: Boolean(item.detected_vad),
        trigger_sources: normalizeTriggerSources(item.trigger_sources),
        end_reason:
          typeof item.end_reason === "string" && item.end_reason
            ? item.end_reason.trim()
            : "",
      };
    });
    const nextFingerprint = computeRecordsFingerprint(normalizedRecords, {
      skipPartialVolatile: true,
    });
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
        persistFilters(state.filters);
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
      persistFilters(state.filters);
    }
    const total = Number.isFinite(payload.total)
      ? Number(payload.total)
      : normalizedRecords.length;
    const totalSize = numericValue(payload.total_size_bytes, 0);
    state.records = normalizedRecords;
    if (clipper.state.undoTokens instanceof Map) {
      const knownPaths = new Set();
      for (const record of normalizedRecords) {
        if (!record || typeof record.path !== "string") {
          continue;
        }
        knownPaths.add(record.path);
        const undoToken =
          typeof record.undo_token === "string" && record.undo_token
            ? record.undo_token
            : null;
        if (undoToken) {
          clipper.state.undoTokens.set(record.path, undoToken);
        } else {
          clipper.state.undoTokens.delete(record.path);
        }
      }
      for (const path of Array.from(clipper.state.undoTokens.keys())) {
        if (!knownPaths.has(path)) {
          clipper.state.undoTokens.delete(path);
        }
      }
    }
    state.recordsFingerprint = nextFingerprint;
    const payloadMotionState =
      payload.motion_state && typeof payload.motion_state === "object"
        ? payload.motion_state
        : null;
    const previousMotionState =
      state.motionState && typeof state.motionState === "object"
        ? state.motionState
        : null;
    const nextMotionState = resolveNextMotionState(
      payloadMotionState,
      previousMotionState,
      eventStreamState.connected
    );
    state.motionState = nextMotionState;
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
    const collectionCountsPayload =
      payload.collection_counts && typeof payload.collection_counts === "object"
        ? payload.collection_counts
        : null;
    const resolveCollectionCount = (key, fallback = 0) => {
      if (!collectionCountsPayload) {
        return fallback;
      }
      const value = Number(collectionCountsPayload[key]);
      return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
    };
    const counts = {
      recent: resolveCollectionCount("recent", 0),
      saved: resolveCollectionCount("saved", 0),
      recycle: resolveCollectionCount("recycle", 0),
    };
    if (state.collection === "recent" && counts.recent === 0 && total > 0) {
      counts.recent = total;
    }
    if (state.collection === "saved" && counts.saved === 0 && total > 0) {
      counts.saved = total;
    }
    if (state.collection === "recycle" && counts.recycle === 0 && total > 0) {
      counts.recycle = total;
    }
    state.collectionCounts.recent = counts.recent;
    state.collectionCounts.saved = counts.saved;
    state.collectionCounts.recycle = counts.recycle;

    const collectionSizesPayload =
      payload.collection_size_bytes && typeof payload.collection_size_bytes === "object"
        ? payload.collection_size_bytes
        : null;
    const resolveCollectionSize = (key, fallback = 0) =>
      numericValue(collectionSizesPayload ? collectionSizesPayload[key] : undefined, fallback);

    const recentSizeFallback = numericValue(payload.recordings_total_bytes, totalSize);
    const recycleSizeFallback = numericValue(payload.recycle_bin_total_bytes, 0);

    state.storage.recordings = resolveCollectionSize("recent", recentSizeFallback);
    state.storage.saved = resolveCollectionSize("saved", 0);
    state.storage.recycleBin = resolveCollectionSize("recycle", recycleSizeFallback);
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
      updatePendingSelectionPath(null);
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
        clipper.updateDuration(toFiniteOrNull(current.duration_seconds));
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
        } else if (state.current.isPartial) {
          const finalizedRecord = findFinalizedRecordForPartial(state.current, state.records);
          if (finalizedRecord) {
            const wasPlaying = Boolean(dom.player && !dom.player.paused);
            const wasSelected = state.selections.has(state.current.path);
            state.selections.delete(state.current.path);
            if (wasSelected) {
              state.selections.add(finalizedRecord.path);
            }
            setNowPlaying(finalizedRecord, {
              autoplay: wasPlaying,
              resetToStart: true,
            });
            maintainCurrentSelection = false;
          } else {
            setNowPlaying(null);
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

    let handledPartialUpdate = false;
    if (
      !recordsChanged &&
      partialChanged &&
      nextPartial &&
      nextPartial.path &&
      (!isPreviewRefreshHeld() || force)
    ) {
      handledPartialUpdate = updateInProgressRecordRow(nextPartial);
    }
    if (isPreviewRefreshHeld() && !force) {
      markPreviewRefreshPending();
    } else if (recordsChanged || (!handledPartialUpdate && partialChanged)) {
      renderRecords({ force });
    } else {
      updateSelectionUI();
      applyNowPlayingHighlight();
      syncPlayerPlacement();
    }
    updateStats();
    updatePaginationControls();
    setRecordingIndicatorStatus(payload.capture_status, state.motionState);
    updateRmsIndicator(payload.capture_status);
    updateRecordingMeta(payload.capture_status);
    updateEncodingStatus(payload.capture_status);
    updateSplitEventButton(captureStatus);
    updateAutoRecordButton(captureStatus);
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
    state.storage.saved = 0;
    state.storage.recycleBin = 0;
    state.storage.total = null;
    state.storage.free = null;
    state.storage.diskUsed = null;
    state.lastUpdated = null;
    state.motionState = null;
    state.collectionCounts.recent = 0;
    state.collectionCounts.saved = 0;
    state.collectionCounts.recycle = 0;
    if (isPreviewRefreshHeld() && !force) {
      markPreviewRefreshPending();
    } else {
      renderRecords({ force });
    }
    updateStats();
    updatePaginationControls();
    handleFetchFailure();
    setRecordingIndicatorUnknown();
    hideRmsIndicator();
    state.captureStatus = null;
    setSplitEventDisabled(true, "Recorder offline.");
    autoRecordState.enabled = true;
    autoRecordState.pending = false;
    autoRecordState.motionOverride = false;
    setAutoRecordDisabled(true, "Recorder status unavailable.");
    setAutoRecordButtonState(true);
    manualRecordState.enabled = false;
    manualRecordState.pending = false;
    manualRecordState.capturing = false;
    setManualRecordDisabled(true, "Recorder status unavailable.");
    setManualRecordButtonState();
    fetchQueued = false;
  } finally {
    fetchInFlight = false;
    if (fetchQueued) {
      fetchQueued = false;
      fetchRecordings({ silent: true });
    }
  }
}

function __setEventStreamConnectedForTests(connected) {
  eventStreamState.connected = Boolean(connected);
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
    const response = await apiClient.fetch(apiPath(section.options.endpoint), {
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
    const response = await apiClient.fetch(apiPath(section.options.endpoint), { cache: "no-store" });
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
  apiClient.fetch(withSession(START_ENDPOINT), { cache: "no-store" }).catch(() => undefined);
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
  apiClient.fetch(url, { cache: "no-store", keepalive: true }).catch(() => undefined);
}

async function refreshLiveStats() {
  try {
    const response = await apiClient.fetch(STATS_ENDPOINT, { cache: "no-store" });
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

function setAutoRecordButtonState(active) {
  if (!dom.autoToggle) {
    return;
  }
  const nextActive = Boolean(active);
  dom.autoToggle.setAttribute("aria-pressed", nextActive ? "true" : "false");
  dom.autoToggle.textContent = nextActive ? "Disable Auto" : "Enable Auto";
}

function setAutoRecordDisabled(disabled, reason = "") {
  if (!dom.autoToggle) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  if (dom.autoToggle.disabled !== nextDisabled) {
    dom.autoToggle.disabled = nextDisabled;
  }
  if (nextDisabled) {
    if (reason) {
      dom.autoToggle.title = reason;
    } else {
      dom.autoToggle.removeAttribute("title");
    }
    dom.autoToggle.setAttribute("aria-disabled", "true");
  } else {
    dom.autoToggle.removeAttribute("title");
    dom.autoToggle.removeAttribute("aria-disabled");
  }
}

function updateAutoRecordButton(rawStatus) {
  if (!dom.autoToggle) {
    return;
  }
  if (autoRecordState.pending) {
    const pendingReason =
      autoRecordState.reason || "Auto capture toggle in progress.";
    setAutoRecordDisabled(true, pendingReason);
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : state.captureStatus;
  let enabled = true;
  if (status && typeof status === "object") {
    if (Object.prototype.hasOwnProperty.call(status, "auto_recording_enabled")) {
      enabled = parseBoolean(status.auto_recording_enabled);
    }
    autoRecordState.motionOverride = parseBoolean(
      status.auto_record_motion_override
    );
  } else {
    autoRecordState.motionOverride = false;
  }
  autoRecordState.enabled = enabled !== false;
  setAutoRecordButtonState(autoRecordState.enabled);
  let disabled = false;
  let reason = "";
  if (!status || typeof status !== "object") {
    disabled = true;
    reason = "Recorder status unavailable.";
  } else if (!parseBoolean(status.service_running)) {
    disabled = true;
    const stopReason =
      typeof status.last_stop_reason === "string"
        ? status.last_stop_reason.trim()
        : "";
    reason = stopReason || "Recorder service is stopped.";
  }
  setAutoRecordDisabled(disabled, reason);
}

function setAutoRecordPending(pending, message = "") {
  autoRecordState.pending = Boolean(pending);
  autoRecordState.reason = message;
  if (!dom.autoToggle) {
    return;
  }
  if (autoRecordState.pending) {
    dom.autoToggle.setAttribute("aria-busy", "true");
    setAutoRecordDisabled(true, message || "Auto capture toggle in progress.");
  } else {
    dom.autoToggle.removeAttribute("aria-busy");
    updateAutoRecordButton(state.captureStatus);
  }
}

function setManualRecordButtonState() {
  if (!dom.manualToggle) {
    return;
  }
  const manualEnabled = Boolean(manualRecordState.enabled);
  const capturing = Boolean(manualRecordState.capturing);
  dom.manualToggle.setAttribute("aria-pressed", manualEnabled ? "true" : "false");
  let label = "Manual Record";
  if (capturing) {
    label = "Stop Capture";
  } else if (manualEnabled) {
    label = "Stop Manual";
  }
  dom.manualToggle.textContent = label;
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
  const capturing = status ? parseBoolean(status.capturing) : false;
  manualRecordState.capturing = Boolean(capturing);
  setManualRecordButtonState();
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
      if (hasHoveredInteractiveElements()) {
        recordPointerActivity();
      }
      const interactive = findInteractiveElement(event.target, event);
      if (!interactive) {
        return;
      }
      hoveredInteractiveElements.add(interactive);
      recordPointerActivity();
      suspendAutoRefresh();
    };

    const handlePointerOut = (event) => {
      if (hasHoveredInteractiveElements()) {
        recordPointerActivity();
      }
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
      if (!hasHoveredInteractiveElements()) {
        stopPointerIdleTimer();
      }
      if (nextInteractive) {
        return;
      }
      if (hasHoveredInteractiveElements()) {
        return;
      }
      window.requestAnimationFrame(() => {
        const active =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!findInteractiveElement(active) && !hasHoveredInteractiveElements()) {
          resumeAutoRefresh();
        }
      });
    };

    document.addEventListener("focusin", handleGlobalFocusIn);
    document.addEventListener("focusout", handleGlobalFocusOut);
    document.addEventListener("pointerdown", (event) => {
      recordPointerActivity();
      if (findInteractiveElement(event.target, event)) {
        suspendAutoRefresh();
        return;
      }
      clearHoveredInteractiveElements();
      // Clicking outside of interactive controls should release any
      // manual suspension so status polling keeps running even if the
      // previously focused element retained focus (common for buttons).
      window.requestAnimationFrame(() => {
        resumeAutoRefresh();
      });
    });
    document.addEventListener("pointermove", () => {
      if (hasHoveredInteractiveElements()) {
        recordPointerActivity();
      }
    }, true);
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);

    const refreshAfterFocus = () => {
      pruneHoveredInteractiveElements();
      clearHoveredInteractiveElements();
      resumeAutoRefresh();
      requestRecordingsRefresh({ immediate: true });
    };

    window.addEventListener("focus", refreshAfterFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshAfterFocus();
      }
    });
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
    fetchRecordings({ silent: false, force: true });
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
    fetchRecordings({ silent: false, force: true });
    updateSelectionUI();
    resumeAutoRefresh();
  });

  if (dom.themeToggle) {
    dom.themeToggle.addEventListener("click", () => {
      themeManager.toggle();
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
      } else if (event.key === "Escape" && isAppMenuOpen()) {
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

  attachWebServerEventListeners();
  attachArchivalEventListeners();

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
      fetchRecordings({ silent: false, force: true });
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
      fetchRecordings({ silent: false, force: true });
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
      persistSortPreference(state.sort);
      renderRecords({ force: true });
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
    renderRecords({ force: true });
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
    renderRecords({ force: true });
  });

  dom.clearSelection.addEventListener("click", () => {
    state.selections.clear();
    state.selectionAnchor = "";
    state.selectionFocus = "";
    renderRecords({ force: true });
  });

  dom.deleteSelected.addEventListener("click", async () => {
    await requestSelectionDeletion();
  });

  if (dom.restoreSelected) {
    dom.restoreSelected.addEventListener("click", async () => {
      if (!isRecycleView() || !state.selections.size) {
        return;
      }
      syncRecycleSelectionFromPaths();
      await restoreRecycleBinSelection();
    });
  }

  if (dom.purgeSelected) {
    dom.purgeSelected.addEventListener("click", async () => {
      if (!isRecycleView()) {
        return;
      }
      await purgeRecycleBinSelection();
    });
  }

  if (dom.downloadSelected) {
    dom.downloadSelected.addEventListener("click", async () => {
      if (!state.selections.size) {
        return;
      }
      if (isRecycleView()) {
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
      if (isRecycleView() || isRenameDialogPending() || state.selections.size !== 1) {
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
      persistWaveformPreferences(normalizeWaveformZoom(waveformState.amplitudeScale));
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
      clipper.setStartFromPlayhead();
    });
  }

  if (dom.clipperSetEnd) {
    dom.clipperSetEnd.addEventListener("click", () => {
      clipper.setEndFromPlayhead();
    });
  }

  if (dom.clipperReset) {
    dom.clipperReset.addEventListener("click", clipper.handleReset);
  }

  if (dom.clipperUndo) {
    dom.clipperUndo.addEventListener("click", clipper.handleUndo);
  }

  if (dom.clipperStartInput) {
    dom.clipperStartInput.addEventListener("change", clipper.handleStartChange);
  }

  if (dom.clipperEndInput) {
    dom.clipperEndInput.addEventListener("change", clipper.handleEndChange);
  }

  if (dom.clipperNameInput) {
    dom.clipperNameInput.addEventListener("input", clipper.handleNameInput);
    dom.clipperNameInput.addEventListener("blur", clipper.handleNameBlur);
  }

  if (dom.clipperOverwriteToggle) {
    dom.clipperOverwriteToggle.addEventListener("change", clipper.handleOverwriteChange);
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

  if (dom.recordingsTabRecycle) {
    dom.recordingsTabRecycle.addEventListener("click", () => {
      setCollection("recycle");
    });
  }

  if (dom.clipperForm) {
    dom.clipperForm.addEventListener("submit", clipper.submitForm);
  }

  if (dom.clipperToggle) {
    dom.clipperToggle.addEventListener("click", () => {
      const next = !clipper.state.enabled;
      clipper.setEnabled(next, { focus: next });
    });
  }

  if (dom.splitEvent) {
    dom.splitEvent.addEventListener("click", () => {
      requestSplitEvent();
    });
  }

  if (dom.autoToggle) {
    setAutoRecordButtonState(autoRecordState.enabled);
    setAutoRecordDisabled(true, "Recorder status unavailable.");
    dom.autoToggle.addEventListener("click", async () => {
      if (autoRecordState.pending || dom.autoToggle.disabled) {
        return;
      }
      const nextEnabled = !autoRecordState.enabled;
      const pendingMessage = nextEnabled
        ? "Enabling auto capture…"
        : "Pausing auto capture…";
      setAutoRecordPending(true, pendingMessage);
      try {
        const response = await apiClient.fetch(AUTO_RECORD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        if (!response.ok) {
          let message = `Auto capture request failed (status ${response.status})`;
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
        autoRecordState.enabled = Boolean(enabledResult);
        autoRecordState.reason = "";
        setAutoRecordButtonState(autoRecordState.enabled);
        updateAutoRecordButton(state.captureStatus);
      } catch (autoError) {
        const message =
          autoError instanceof Error && autoError.message
            ? autoError.message
            : "Auto capture toggle failed";
        console.error("Auto record toggle failed", autoError);
        setAutoRecordPending(false);
        autoRecordState.pending = false;
        autoRecordState.reason = "";
        if (dom.autoToggle) {
          dom.autoToggle.removeAttribute("aria-busy");
          dom.autoToggle.title = message;
        }
        return;
      }
      setAutoRecordPending(false);
    });
  }

  if (dom.manualToggle) {
    dom.manualToggle.addEventListener("click", async () => {
      if (manualRecordState.pending || dom.manualToggle.disabled) {
        return;
      }
      const capturing = Boolean(manualRecordState.capturing);
      const manualEnabled = Boolean(manualRecordState.enabled);
      if (capturing && !manualEnabled) {
        const pendingMessage = "Stopping capture…";
        setManualRecordPending(true, pendingMessage);
        try {
          const response = await apiClient.fetch(CAPTURE_STOP_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!response.ok) {
            let message = `Capture stop request failed (status ${response.status})`;
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
          manualRecordState.reason = "";
        } catch (stopError) {
          const message =
            stopError instanceof Error && stopError.message
              ? stopError.message
              : "Capture stop request failed";
          console.error("Manual capture stop failed", stopError);
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
        return;
      }
      const nextEnabled = !manualEnabled;
      const pendingMessage = nextEnabled
        ? "Enabling manual recording…"
        : "Stopping manual recording…";
      setManualRecordPending(true, pendingMessage);
      try {
        const response = await apiClient.fetch(MANUAL_RECORD_ENDPOINT, {
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
        manualRecordState.capturing = Boolean(manualRecordState.enabled);
        setManualRecordButtonState();
        updateAutoRecordButton(state.captureStatus);
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
    closeEventStream();
    if (liveState.open || liveState.active) {
      stopLiveStream({ sendSignal: true, useBeacon: true });
    }
  });

  window.addEventListener("pagehide", () => {
    stopAutoRefresh();
    stopServicesRefresh();
    stopHealthRefresh();
    stopConfigRefresh();
    closeEventStream();
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
    refreshTabRecordingTitleIndicator();
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

const { initialize } = createDashboardInitializer({
  dom,
  state,
  themeManager,
  restoreFiltersFromStorage,
  restoreSortFromStorage,
  restoreFilterPanelPreference,
  setupResponsiveFilters,
  populateFilters,
  updateSelectionUI,
  updateSortIndicators,
  updatePaginationControls,
  resetWaveform,
  loadTransportPreferences,
  applyTransportPreferences,
  setTransportActive,
  resetTransportUi,
  restoreWaveformPreferences,
  clipper,
  setRecordingIndicatorUnknown,
  setLiveButtonState,
  setLiveStatus,
  setLiveToggleDisabled,
  setRecorderModalVisible,
  setConfigModalVisible,
  initializeWebServerDom,
  initializeArchivalDom,
  recorderState,
  updateRecorderConfigPath,
  registerRecorderSections,
  updateAudioFilterControls,
  setServicesModalVisible,
  attachEventListeners,
  initializeEventStream,
  updateTransportAvailability,
  renderRecorderUptime,
  fetchRecordings,
  fetchConfig,
  fetchWebServerSettings,
  fetchArchivalSettings,
  fetchSystemHealth,
  fetchServices,
  enablePollingFallback,
  eventStreamSupported: EVENT_STREAM_SUPPORTED,
});

const dashboardPublicApi = {
  renderRecords,
  setRecordingIndicatorStatus,
  __setEventStreamConnectedForTests,
  requestRecordingsRefresh,
  updateSelectionUI,
  applyNowPlayingHighlight,
  syncPlayerPlacement,
  updateRmsIndicator,
  updateRecordingMeta,
  updateEncodingStatus,
  updateSplitEventButton,
  updateAutoRecordButton,
  updateManualRecordButton,
  applyCaptureStatusPush,
  resolveNextMotionState,
  isMotionTriggeredEvent,
  resolveSelectionAnchor,
  applySelectionRange,
  updatePlaybackSourceForRecord,
  getPlaybackSourceState,
  setPlaybackSource,
};

if (typeof window !== "undefined") {
  Object.assign(window, dashboardPublicApi);
}

export {
  renderRecords,
  setRecordingIndicatorStatus,
  __setEventStreamConnectedForTests,
  requestRecordingsRefresh,
  updateSelectionUI,
  applyNowPlayingHighlight,
  syncPlayerPlacement,
  updateRmsIndicator,
  updateRecordingMeta,
  updateEncodingStatus,
  updateSplitEventButton,
  updateAutoRecordButton,
  updateManualRecordButton,
  applyCaptureStatusPush,
  resolveNextMotionState,
  isMotionTriggeredEvent,
  resolveSelectionAnchor,
  applySelectionRange,
  updatePlaybackSourceForRecord,
  getPlaybackSourceState,
  setPlaybackSource,
};

let hasInitialized = false;

function initializeOnce() {
  if (hasInitialized) {
    return dashboardPublicApi;
  }
  hasInitialized = true;
  initialize();
  return dashboardPublicApi;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeOnce, { once: true });
  } else {
    initializeOnce();
  }
} else {
  initializeOnce();
}

function bootstrapDashboard() {
  return initializeOnce();
}

export { bootstrapDashboard };
export default bootstrapDashboard;
