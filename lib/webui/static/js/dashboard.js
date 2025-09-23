const AUTO_REFRESH_INTERVAL_MS = 1000;
const OFFLINE_REFRESH_INTERVAL_MS = 5000;
const REFRESH_INDICATOR_DELAY_MS = 600;
const MARKER_MIN_GAP_SECONDS = 0.05;
const MAX_WAVEFORM_SAMPLES_PER_BUCKET = 1024;

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
  livePanel: document.getElementById("live-stream-panel"),
  liveStatus: document.getElementById("live-stream-status"),
  liveClients: document.getElementById("live-stream-clients"),
  liveEncoder: document.getElementById("live-stream-encoder"),
  liveClose: document.getElementById("live-stream-close"),
  liveAudio: document.getElementById("live-stream-audio"),
  waveformContainer: document.getElementById("waveform-container"),
  waveformCanvas: document.getElementById("waveform-canvas"),
  waveformCursor: document.getElementById("waveform-cursor"),
  waveformTriggerMarker: document.getElementById("waveform-trigger-marker"),
  waveformReleaseMarker: document.getElementById("waveform-release-marker"),
  waveformEmpty: document.getElementById("waveform-empty"),
  waveformStatus: document.getElementById("waveform-status"),
  sortButtons: Array.from(document.querySelectorAll(".sort-button")),
};

const sortHeaderMap = new Map(
  dom.sortButtons.map((button) => [button.dataset.sortKey ?? "", button.closest("th")])
);

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

let autoRefreshId = null;
let autoRefreshIntervalMs = AUTO_REFRESH_INTERVAL_MS;
let fetchInFlight = false;
let fetchQueued = false;
let refreshIndicatorTimer = null;

const waveformState = {
  audioContext: null,
  peaks: null,
  buffer: null,
  requestId: 0,
  abortController: null,
  animationFrame: null,
  duration: 0,
  pointerId: null,
  isScrubbing: false,
  lastFraction: 0,
  triggerSeconds: null,
  releaseSeconds: null,
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
      const left = Number.isFinite(a.modified) ? a.modified : 0;
      const right = Number.isFinite(b.modified) ? b.modified : 0;
      result = left - right;
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
  details.push(formatDate(record.modified));
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

function setNowPlaying(record, options = {}) {
  const { autoplay = true, resetToStart = true, sourceRow = null } = options;
  const previous = state.current;
  state.current = record;
  if (!record) {
    updatePlayerMeta(null);
    detachPlayerCard();
    playbackState.pausedViaSpacebar.delete(dom.player);
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

  const sameRecord = previous && previous.path === record.path;

  if (sameRecord) {
    playbackState.resetOnLoad = false;
    playbackState.enforcePauseOnLoad = !autoplay;
    playbackState.pausedViaSpacebar.delete(dom.player);
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
  playbackState.pausedViaSpacebar.delete(dom.player);

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
    const updatedText = formatDate(record.modified);
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

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.addEventListener("click", () => {
      setNowPlaying(record, { autoplay: true, resetToStart: true, sourceRow: row });
    });

    const downloadLink = document.createElement("a");
    downloadLink.href = recordingUrl(record.path, { download: true });
    downloadLink.textContent = "Download";
    downloadLink.setAttribute("download", `${record.name}.${record.extension || "opus"}`);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.classList.add("danger-button");
    deleteButton.addEventListener("click", () => {
      const extLabel = record.extension ? `.${record.extension}` : "";
      const confirmed = window.confirm(`Delete ${record.name}${extLabel}?`);
      if (confirmed) {
        deleteRecordings([record.path]);
      }
    });

    actionWrapper.append(playButton, downloadLink, deleteButton);
    actionsCell.append(actionWrapper);
    row.append(actionsCell);

    row.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element) {
        if (
          target.closest("button") ||
          target.closest("a") ||
          target.closest("input") ||
          target.closest(".action-buttons")
        ) {
          return;
        }
      }
      setNowPlaying(record, { autoplay: false, resetToStart: true, sourceRow: row });
    });

    row.addEventListener("dblclick", (event) => {
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest("button") || target.closest("a") || target.closest("input")) {
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

function ensureAudioContext() {
  if (waveformState.audioContext) {
    return waveformState.audioContext;
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Web Audio not supported");
  }
  waveformState.audioContext = new AudioContextCtor();
  return waveformState.audioContext;
}

function setCursorFraction(fraction) {
  const clamped = clamp(fraction, 0, 1);
  waveformState.lastFraction = clamped;
  if (dom.waveformCursor) {
    dom.waveformCursor.style.left = `${(clamped * 100).toFixed(3)}%`;
  }
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
  waveformState.buffer = null;
  waveformState.duration = 0;
  waveformState.lastFraction = 0;
  waveformState.triggerSeconds = null;
  waveformState.releaseSeconds = null;
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
}

function drawWaveformFromBuffer(buffer) {
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

  const channelCount = Math.max(1, buffer.numberOfChannels || 1);
  const channels = Array.from({ length: channelCount }, (_, idx) => buffer.getChannelData(idx));
  const sampleCount = Math.max(256, Math.min(4096, Math.floor(width / dpr)));
  const totalSamples = channels[0] ? channels[0].length : 0;
  if (totalSamples <= 0) {
    ctx.clearRect(0, 0, width, height);
    waveformState.peaks = new Float32Array(0);
    return;
  }
  const blockSize = Math.max(1, Math.floor(totalSamples / sampleCount));
  const peaks = new Float32Array(sampleCount * 2);

  const sampleAt = channelCount === 1
    ? (index) => {
        const value = channels[0][index] ?? 0;
        return Number.isFinite(value) ? value : 0;
      }
    : (index) => {
        let sum = 0;
        for (let c = 0; c < channelCount; c += 1) {
          sum += channels[c][index] ?? 0;
        }
        const value = sum / channelCount;
        return Number.isFinite(value) ? value : 0;
      };

  for (let i = 0; i < sampleCount; i += 1) {
    const start = Math.min(i * blockSize, totalSamples);
    let end = Math.min(start + blockSize, totalSamples);
    if (i === sampleCount - 1) {
      end = totalSamples;
    }
    if (end <= start) {
      peaks[i * 2] = 0;
      peaks[i * 2 + 1] = 0;
      continue;
    }
    const span = end - start;
    const stride = Math.max(1, Math.floor(span / MAX_WAVEFORM_SAMPLES_PER_BUCKET));
    let min = 1;
    let max = -1;
    for (let j = start; j < end; j += stride) {
      const sample = sampleAt(j);
      if (sample < min) {
        min = sample;
      }
      if (sample > max) {
        max = sample;
      }
    }
    const lastIndex = end - 1;
    if ((lastIndex - start) % stride !== 0) {
      const sample = sampleAt(lastIndex);
      if (sample < min) {
        min = sample;
      }
      if (sample > max) {
        max = sample;
      }
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }

  waveformState.peaks = peaks;

  ctx.clearRect(0, 0, width, height);
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
  if (waveformState.buffer && dom.waveformContainer && !dom.waveformContainer.hidden) {
    drawWaveformFromBuffer(waveformState.buffer);
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
  dom.waveformEmpty.textContent = "Analyzing audio…";
  if (dom.waveformStatus) {
    dom.waveformStatus.textContent = "Loading…";
  }
  setCursorFraction(0);
  waveformState.triggerSeconds = null;
  waveformState.releaseSeconds = null;
  setWaveformMarker(dom.waveformTriggerMarker, null, null);
  setWaveformMarker(dom.waveformReleaseMarker, null, null);

  try {
    const response = await fetch(recordingUrl(record.path), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`waveform request failed with status ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const audioContext = ensureAudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    if (waveformState.requestId !== requestId) {
      return;
    }

    waveformState.duration = audioBuffer.duration;
    waveformState.buffer = audioBuffer;
    const previousDuration = Number.isFinite(record.duration_seconds)
      ? record.duration_seconds
      : null;
    record.duration_seconds = audioBuffer.duration;

    const finalizeWaveform = () => {
      drawWaveformFromBuffer(audioBuffer);
      dom.waveformContainer.dataset.ready = "true";
      updateCursorFromPlayer();
      updateWaveformMarkers();
      startCursorAnimation();
    };

    dom.waveformContainer.dataset.ready = "false";
    dom.waveformContainer.hidden = false;
    dom.waveformEmpty.hidden = true;

    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(finalizeWaveform);
    } else {
      finalizeWaveform();
    }

    if (dom.waveformStatus) {
      dom.waveformStatus.textContent = `Length: ${formatDuration(audioBuffer.duration)}`;
    }

    if (previousDuration === null || Math.abs(previousDuration - audioBuffer.duration) > 0.05) {
      renderRecords();
    }
    updatePlayerMeta(record);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.error("Failed to load waveform", error);
    if (waveformState.requestId === requestId) {
      waveformState.buffer = null;
      waveformState.peaks = null;
      dom.waveformContainer.hidden = true;
      dom.waveformContainer.dataset.ready = "false";
      dom.waveformEmpty.hidden = false;
      dom.waveformEmpty.textContent = "Waveform unavailable for this recording.";
      if (dom.waveformStatus) {
        dom.waveformStatus.textContent = "";
      }
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
  if (!waveformState.isScrubbing || event.pointerId !== waveformState.pointerId) {
    return;
  }
  seekFromPointer(event);
}

function handleWaveformPointerUp(event) {
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
    state.records = items.map((item) => ({
      ...item,
      size_bytes: numericValue(item.size_bytes, 0),
      modified: numericValue(item.modified, 0),
      duration_seconds: Number.isFinite(item.duration_seconds)
        ? Number(item.duration_seconds)
        : null,
      trigger_offset_seconds: toFiniteOrNull(item.trigger_offset_seconds),
      release_offset_seconds: toFiniteOrNull(item.release_offset_seconds),
    }));
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

    if (state.current) {
      const current = state.records.find((entry) => entry.path === state.current.path);
      if (current) {
        state.current = current;
        updatePlayerMeta(current);
        updateWaveformMarkers();
      } else {
        setNowPlaying(null);
      }
    }

    renderRecords();
    updateStats();
    handleFetchSuccess();
  } catch (error) {
    console.error("Failed to load recordings", error);
    state.records = [];
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

async function deleteRecordings(paths) {
  if (!paths || !paths.length) {
    return;
  }
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
  dom.liveToggle.textContent = active ? "Stop Live Stream" : "Live Stream";
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

  dom.deleteSelected.addEventListener("click", () => {
    if (!state.selections.size) {
      return;
    }
    const confirmed = window.confirm(`Delete ${state.selections.size} selected recording(s)?`);
    if (!confirmed) {
      return;
    }
    const paths = Array.from(state.selections.values());
    deleteRecordings(paths);
  });

  if (dom.waveformContainer) {
    dom.waveformContainer.addEventListener("pointerdown", handleWaveformPointerDown);
    dom.waveformContainer.addEventListener("pointermove", handleWaveformPointerMove);
    dom.waveformContainer.addEventListener("pointerup", handleWaveformPointerUp);
    dom.waveformContainer.addEventListener("pointercancel", handleWaveformPointerUp);
  }

  window.addEventListener("resize", redrawWaveform);
  window.addEventListener("resize", syncPlayerPlacement);
  window.addEventListener("keydown", handleSpacebarShortcut);

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
