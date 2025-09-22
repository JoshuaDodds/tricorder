const state = {
  filters: {
    search: "",
    day: "",
    extension: "",
    limit: 200,
  },
  records: [],
  total: 0,
  totalSize: 0,
  availableDays: [],
  availableExtensions: [],
  selections: new Set(),
  current: null,
  lastUpdated: null,
};

const dom = {
  recordingCount: document.getElementById("recording-count"),
  selectedCount: document.getElementById("selected-count"),
  storageUsage: document.getElementById("storage-usage"),
  lastUpdated: document.getElementById("last-updated"),
  tableBody: document.querySelector("#recordings-table tbody"),
  toggleAll: document.getElementById("toggle-all"),
  selectAll: document.getElementById("select-all"),
  clearSelection: document.getElementById("clear-selection"),
  deleteSelected: document.getElementById("delete-selected"),
  refreshButton: document.getElementById("refresh-button"),
  applyFilters: document.getElementById("apply-filters"),
  clearFilters: document.getElementById("clear-filters"),
  filterSearch: document.getElementById("filter-search"),
  filterDay: document.getElementById("filter-day"),
  filterExtension: document.getElementById("filter-extension"),
  filterLimit: document.getElementById("filter-limit"),
  player: document.getElementById("preview-player"),
  playerMeta: document.getElementById("player-meta"),
  configViewer: document.getElementById("config-viewer"),
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(seconds) {
  if (!seconds) {
    return "--";
  }
  return dateFormatter.format(new Date(seconds * 1000));
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** idx;
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
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
  const extSelect = dom.filterExtension;

  const currentDay = daySelect.value;
  const currentExt = extSelect.value;

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

  extSelect.innerHTML = "";
  const extOptions = ["", ...state.availableExtensions];
  for (const ext of extOptions) {
    const option = document.createElement("option");
    option.value = ext;
    option.textContent = ext ? `.${ext}` : "All types";
    if (ext === state.filters.extension || ext === currentExt) {
      option.selected = true;
    }
    extSelect.append(option);
  }
}

function updateSelectionUI() {
  dom.selectedCount.textContent = state.selections.size.toString();
  dom.deleteSelected.disabled = state.selections.size === 0;

  if (!state.records.length) {
    dom.toggleAll.checked = false;
    dom.toggleAll.indeterminate = false;
    return;
  }

  let selectedVisible = 0;
  for (const record of state.records) {
    if (state.selections.has(record.path)) {
      selectedVisible += 1;
    }
  }

  dom.toggleAll.checked = selectedVisible === state.records.length;
  if (selectedVisible === 0 || selectedVisible === state.records.length) {
    dom.toggleAll.indeterminate = false;
  } else {
    dom.toggleAll.indeterminate = true;
  }
}

function renderEmptyState(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 7;
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

function setNowPlaying(record) {
  state.current = record;
  if (!record) {
    dom.playerMeta.textContent = "Select a recording to preview.";
    dom.player.removeAttribute("src");
    applyNowPlayingHighlight();
    return;
  }

  const url = recordingUrl(record.path);
  dom.player.src = url;
  dom.player.play().catch(() => {
    /* ignore autoplay failures */
  });

  const details = [];
  const extText = record.extension ? `.${record.extension}` : "";
  details.push(`${record.name}${extText}`);
  if (record.day) {
    details.push(record.day);
  }
  details.push(formatDate(record.modified));
  details.push(formatBytes(record.size_bytes));
  dom.playerMeta.textContent = `Now playing: ${details.join(" • ")}`;
  applyNowPlayingHighlight();
}

function renderRecords() {
  dom.tableBody.innerHTML = "";

  if (!state.records.length) {
    renderEmptyState("No recordings match the selected filters.");
    updateSelectionUI();
    applyNowPlayingHighlight();
    return;
  }

  for (const record of state.records) {
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

    const nameCell = document.createElement("td");
    nameCell.textContent = record.name;
    row.append(nameCell);

    const dayCell = document.createElement("td");
    dayCell.textContent = record.day || "—";
    row.append(dayCell);

    const updatedCell = document.createElement("td");
    updatedCell.textContent = formatDate(record.modified);
    row.append(updatedCell);

    const sizeCell = document.createElement("td");
    sizeCell.textContent = formatBytes(record.size_bytes);
    row.append(sizeCell);

    const extCell = document.createElement("td");
    extCell.innerHTML = record.extension
      ? `<span class="badge">.${record.extension}</span>`
      : "";
    row.append(extCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions";
    const actionWrapper = document.createElement("div");
    actionWrapper.className = "action-buttons";

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.addEventListener("click", () => {
      setNowPlaying(record);
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
      const confirmed = window.confirm(`Delete ${record.name}.${record.extension}?`);
      if (confirmed) {
        deleteRecordings([record.path]);
      }
    });

    actionWrapper.append(playButton, downloadLink, deleteButton);
    actionsCell.append(actionWrapper);
    row.append(actionsCell);

    row.addEventListener("dblclick", () => {
      setNowPlaying(record);
    });

    dom.tableBody.append(row);
  }

  applyNowPlayingHighlight();
  updateSelectionUI();
}

function updateStats() {
  dom.recordingCount.textContent = state.total.toString();
  dom.storageUsage.textContent = formatBytes(state.totalSize);
  if (state.lastUpdated) {
    dom.lastUpdated.textContent = dateFormatter.format(state.lastUpdated);
  }
}

async function fetchRecordings() {
  const params = new URLSearchParams();
  if (state.filters.search) {
    params.set("search", state.filters.search);
  }
  if (state.filters.day) {
    params.set("day", state.filters.day);
  }
  if (state.filters.extension) {
    params.set("ext", state.filters.extension);
  }
  params.set("limit", String(state.filters.limit));

  const endpoint = `/api/recordings?${params.toString()}`;
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    state.records = payload.items ?? [];
    state.total = typeof payload.total === "number" ? payload.total : state.records.length;
    state.totalSize = typeof payload.total_size_bytes === "number" ? payload.total_size_bytes : 0;
    state.availableDays = Array.isArray(payload.available_days) ? payload.available_days : [];
    state.availableExtensions = Array.isArray(payload.available_extensions)
      ? payload.available_extensions
      : [];
    state.lastUpdated = new Date();
    populateFilters();
    renderRecords();
    updateStats();
  } catch (error) {
    console.error("Failed to load recordings", error);
    state.records = [];
    state.total = 0;
    state.totalSize = 0;
    renderRecords();
    updateStats();
    dom.lastUpdated.textContent = "Error";
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
    await fetchRecordings();
  }
}

function applyFiltersFromInputs() {
  state.filters.search = dom.filterSearch.value.trim();
  state.filters.day = dom.filterDay.value.trim();
  state.filters.extension = dom.filterExtension.value.trim();
  const parsedLimit = Number.parseInt(dom.filterLimit.value, 10);
  if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
    state.filters.limit = Math.min(Math.max(parsedLimit, 1), 1000);
  }
}

function clearFilters() {
  dom.filterSearch.value = "";
  dom.filterDay.value = "";
  dom.filterExtension.value = "";
  dom.filterLimit.value = "200";
  state.filters = { search: "", day: "", extension: "", limit: 200 };
}

function attachEventListeners() {
  dom.applyFilters.addEventListener("click", () => {
    applyFiltersFromInputs();
    state.selections.clear();
    fetchRecordings();
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
    fetchRecordings();
    updateSelectionUI();
  });

  dom.refreshButton.addEventListener("click", () => {
    fetchRecordings();
  });

  dom.toggleAll.addEventListener("change", (event) => {
    if (event.target.checked) {
      for (const record of state.records) {
        state.selections.add(record.path);
      }
    } else {
      for (const record of state.records) {
        state.selections.delete(record.path);
      }
    }
    renderRecords();
  });

  dom.selectAll.addEventListener("click", () => {
    for (const record of state.records) {
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

  dom.player.addEventListener("ended", () => {
    applyNowPlayingHighlight();
  });
}

function initialize() {
  populateFilters();
  updateSelectionUI();
  attachEventListeners();
  fetchRecordings();
  fetchConfig();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}
