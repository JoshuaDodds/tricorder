(() => {
  function ensureComponentRegistry() {
    const root =
      typeof globalThis !== "undefined"
        ? globalThis
        : typeof window !== "undefined"
          ? window
          : {};
    if (!root.__TRICORDER_COMPONENTS__) {
      root.__TRICORDER_COMPONENTS__ = {};
    }
    return root.__TRICORDER_COMPONENTS__;
  }

  const clipListRegistry = ensureComponentRegistry();

  function renderClipListEmptyState(tableBody, message) {
    if (!tableBody) {
      return;
    }
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-state";
    cell.textContent = message;
    row.append(cell);
    tableBody.append(row);
  }

  function buildClipListRow(record, context) {
  const {
    state,
    resolveTriggerFlags,
    isMotionTriggeredEvent,
    getRecordStartSeconds,
    formatDate,
    formatDuration,
    formatBytes,
    ensureTriggerBadge,
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
  } = context;

  const row = document.createElement("tr");
  row.dataset.path = record.path;

  const isPartial = Boolean(record.isPartial);
  const isMotion = Boolean(isMotionTriggeredEvent(record));
  const triggerFlags = resolveTriggerFlags(record.trigger_sources);
  const recordCollection =
    typeof record.collection === "string" && record.collection
      ? record.collection
      : state.collection;
  const isRecycleRecord = record.source === "recycle-bin";

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
        clearPendingSelectionRange();
        state.selectionAnchor = record.path;
        return;
      }
      const wasSelected = state.selections.has(record.path);
      setPendingSelectionRange({
        anchorPath,
        targetPath: record.path,
        shouldSelect: !wasSelected,
      });
      return;
    }
    clearPendingSelectionRange();
    state.selectionAnchor = record.path;
  });

  checkbox.addEventListener("change", (event) => {
    state.selectionFocus = record.path;
    const pending = getPendingSelectionRange();
    if (pending && pending.targetPath === record.path) {
      clearPendingSelectionRange();
      const { anchorPath, targetPath, shouldSelect } = pending;
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

    clearPendingSelectionRange();
    if (event.target instanceof HTMLInputElement && event.target.checked) {
      state.selections.add(record.path);
    } else if (event.target instanceof HTMLInputElement) {
      state.selections.delete(record.path);
    } else if (checkbox.checked) {
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
    updatedSeconds !== null ? updatedSeconds : record.modified,
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
  nameCell.append(nameTitle);

  const mobileMeta = document.createElement("div");
  mobileMeta.className = "record-mobile-meta";
  if (isPartial) {
    const livePill = document.createElement("span");
    livePill.className = "meta-pill live-pill";
    livePill.dataset.metaRole = "live";
    livePill.textContent = "Recording…";
    mobileMeta.append(livePill);
  }
  if (isMotion) {
    const motionPill = document.createElement("span");
    motionPill.className = "meta-pill motion-pill";
    motionPill.dataset.metaRole = "motion";
    motionPill.textContent = "Motion event";
    mobileMeta.append(motionPill);
  }
  if (triggerFlags.manual) {
    const manualPill = document.createElement("span");
    manualPill.className = "meta-pill manual-pill";
    manualPill.dataset.metaRole = "manual-trigger";
    manualPill.textContent = "Manual";
    mobileMeta.append(manualPill);
  }
  if (triggerFlags.split) {
    const splitPill = document.createElement("span");
    splitPill.className = "meta-pill split-pill";
    splitPill.dataset.metaRole = "split-trigger";
    splitPill.textContent = "Split event";
    mobileMeta.append(splitPill);
  }
  if (triggerFlags.rmsVad) {
    const rmsVadPill = document.createElement("span");
    rmsVadPill.className = "meta-pill rmsvad-pill";
    rmsVadPill.dataset.metaRole = "rmsvad-trigger";
    rmsVadPill.textContent = "RMS + VAD";
    mobileMeta.append(rmsVadPill);
  }
  if (durationText && durationText !== "--") {
    const durationPill = document.createElement("span");
    durationPill.className = "meta-pill";
    durationPill.dataset.metaRole = "duration";
    durationPill.textContent = `Length ${durationText}`;
    mobileMeta.append(durationPill);
  }
  if (sizeText) {
    const sizePill = document.createElement("span");
    sizePill.className = "meta-pill";
    sizePill.dataset.metaRole = "size";
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
    daySpan.dataset.subtextRole = "day";
    daySpan.textContent = record.day;
    mobileSubtext.append(daySpan);
  }
  if (updatedText && updatedText !== "--") {
    const updatedSpan = document.createElement("span");
    updatedSpan.dataset.subtextRole = "updated";
    updatedSpan.textContent = updatedText;
    mobileSubtext.append(updatedSpan);
  }
  if (mobileSubtext.childElementCount > 0) {
    nameCell.append(mobileSubtext);
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "record-actions-row action-buttons";
  if (isPartial) {
    const statusLabel = document.createElement("span");
    statusLabel.className = "in-progress-label";
    statusLabel.textContent = record.inProgress ? "Recording…" : "Finalizing";
    actionsRow.append(statusLabel);
  } else if (!isRecycleRecord) {
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
    const downloadUrl = resolvePlaybackSourceUrl(record, { download: true });
    downloadLink.textContent = "Download";
    downloadLink.classList.add("ghost-button", "small");
    if (downloadUrl) {
      downloadLink.href = downloadUrl;
      downloadLink.removeAttribute("aria-disabled");
    } else {
      downloadLink.removeAttribute("href");
      downloadLink.setAttribute("aria-disabled", "true");
    }
    const downloadName =
      typeof resolveRecordDownloadName === "function"
        ? resolveRecordDownloadName(record)
        : "";
    if (downloadName) {
      downloadLink.setAttribute("download", downloadName);
    } else {
      downloadLink.removeAttribute("download");
    }
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
  } else {
    const downloadLink = document.createElement("a");
    const downloadUrl = resolvePlaybackSourceUrl(record, { download: true });
    downloadLink.textContent = "Download";
    downloadLink.classList.add("ghost-button", "small");
    if (downloadUrl) {
      downloadLink.href = downloadUrl;
      downloadLink.removeAttribute("aria-disabled");
    } else {
      downloadLink.removeAttribute("href");
      downloadLink.setAttribute("aria-disabled", "true");
    }
    const downloadName =
      typeof resolveRecordDownloadName === "function"
        ? resolveRecordDownloadName(record)
        : "";
    if (downloadName) {
      downloadLink.setAttribute("download", downloadName);
    } else {
      downloadLink.removeAttribute("download");
    }
    downloadLink.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    actionsRow.append(downloadLink);
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

  return row;
  }

  clipListRegistry.renderClipListEmptyState = renderClipListEmptyState;
  clipListRegistry.buildClipListRow = buildClipListRow;
})();
