      delete row.dataset.motion;
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
    const nameWrapper = document.createElement("div");
    nameWrapper.className = "recycle-bin-name";
    const nameText = document.createElement("span");
    nameText.className = "recycle-bin-name-text";
    nameText.textContent = displayName;
    nameWrapper.append(nameText);
    if (isMotion) {
      const motionBadge = document.createElement("span");
      motionBadge.className = "badge badge-motion";
      motionBadge.textContent = "Motion";
      nameWrapper.append(motionBadge);
    }
    nameCell.append(nameWrapper);
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
    const response = await apiClient.fetch(apiPath("/api/recycle-bin"));
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
        motion_trigger_offset_seconds: toFiniteOrNull(entry.motion_trigger_offset_seconds),
        motion_release_offset_seconds: toFiniteOrNull(entry.motion_release_offset_seconds),
        motion_started_epoch: toFiniteOrNull(entry.motion_started_epoch),
        motion_released_epoch: toFiniteOrNull(entry.motion_released_epoch),
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
    const offline = ensureOfflineStateOnError(error, handleFetchFailure);
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
    const response = await apiClient.fetch(apiPath("/api/recycle-bin/restore"), {
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
    fetchRecordings({ silent: false, force: true });
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
    const response = await apiClient.fetch(apiPath("/api/recycle-bin/purge"), {
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
    fetchRecordings({ silent: false, force: true });
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
  const response = await apiClient.fetch(apiPath("/api/recordings/delete"), {
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
      updatePendingSelectionPath(nextSelectionPath);
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
    await fetchRecordings({ silent: false, force: true });
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

  const response = await apiClient.fetch(apiPath("/api/recordings/rename"), {
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
    updatePendingSelectionPath(newPath);
  }

  updateSelectionUI();
  await fetchRecordings({ silent: false, force: true });

  return payloadJson;
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

  persistFilters(state.filters);
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

  const response = await apiClient.fetch(withSession(OFFER_ENDPOINT), {
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
