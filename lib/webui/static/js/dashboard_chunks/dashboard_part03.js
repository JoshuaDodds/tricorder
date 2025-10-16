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
    renderEmptyState("No recordings match the selected filters.");
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
  const needsSubtext = Boolean(record.day) || Boolean(updatedSubtext) || Boolean(record.extension);
  if (needsSubtext || row.querySelector(".record-mobile-subtext")) {
    const subtextContainer = needsSubtext
      ? ensureRecordMobileSubtext(row)
      : row.querySelector(".record-mobile-subtext");
    if (subtextContainer) {
      updateSubtextSpan(subtextContainer, "day", record.day || "");
      updateSubtextSpan(subtextContainer, "updated", updatedSubtext);
      updateSubtextSpan(
        subtextContainer,
        "extension",
        record.extension ? `.${record.extension}` : "",
      );
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

function renderMotionSegments(duration) {
  if (!dom.waveformMotionSegments) {
    return;
  }

  const container = dom.waveformMotionSegments;
  container.textContent = "";
  container.hidden = true;

  const segments = normalizeMotionSegments(waveformState.motionSegments);
  if (!Number.isFinite(duration) || duration <= 0 || segments.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") {
      continue;
    }
    const startSeconds = Number(segment.start);
    if (!Number.isFinite(startSeconds)) {
      continue;
    }

    const clampedStart = clamp(startSeconds, 0, duration);
    if (clampedStart >= duration) {
      continue;
    }

    let clampedEnd = null;
    if (Number.isFinite(segment.end)) {
      clampedEnd = clamp(Number(segment.end), clampedStart, duration);
    }

    const element = document.createElement("div");
    element.className = "waveform-motion-segment";
    element.style.left = `${(clampedStart / duration) * 100}%`;

    if (clampedEnd === null) {
      element.dataset.open = "true";
      element.style.right = "0";
    } else {
      const widthFraction = Math.max(clampedEnd - clampedStart, 0) / duration;
      element.style.width = `${widthFraction * 100}%`;
    }

    fragment.appendChild(element);
  }

  if (fragment.childNodes.length > 0) {
    container.appendChild(fragment);
    container.hidden = false;
  }
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
    waveformState.motionSegments = [];
    setWaveformMarker(dom.waveformTriggerMarker, null, null);
    setWaveformMarker(dom.waveformMotionStartMarker, null, null);
    setWaveformMarker(dom.waveformMotionEndMarker, null, null);
    setWaveformMarker(dom.waveformReleaseMarker, null, null);
    renderMotionSegments(null);
    return;
  }

  const collapseThreshold = MARKER_COLLAPSE_EPSILON_SECONDS;

  waveformState.motionSegments = Array.isArray(state.current.motion_segments)
    ? state.current.motion_segments
    : [];
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
  renderMotionSegments(duration);
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

function restoreWaveformPreferences() {
  const rawValue = getStoredWaveformAmplitude();
  if (rawValue === null) {
    return;
  }
  waveformState.amplitudeScale = normalizeWaveformZoom(rawValue);
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
