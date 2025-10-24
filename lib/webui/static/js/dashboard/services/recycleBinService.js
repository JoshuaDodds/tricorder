export function createRecycleBinService(deps = {}) {
  const {
    state,
    apiClient,
    apiPath,
    normalizeStartTimestamps,
    toFiniteOrNull,
    recycleBinContainsId,
    persistRecycleBinState,
    renderRecycleBinItems,
    updateRecycleBinControls,
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
    shouldDeferDashboardUpdate,
    markRecordingsRefreshDeferred,
  } = deps;

  if (!state || typeof state !== "object") {
    throw new Error("createRecycleBinService requires a dashboard state reference");
  }
  if (!apiClient || typeof apiClient.fetch !== "function") {
    throw new Error("createRecycleBinService requires an apiClient with fetch()");
  }
  if (typeof apiPath !== "function") {
    throw new Error("createRecycleBinService requires an apiPath helper");
  }
  if (typeof normalizeStartTimestamps !== "function") {
    throw new Error("createRecycleBinService requires normalizeStartTimestamps");
  }
  if (typeof toFiniteOrNull !== "function") {
    throw new Error("createRecycleBinService requires toFiniteOrNull");
  }
  if (typeof recycleBinContainsId !== "function") {
    throw new Error("createRecycleBinService requires recycleBinContainsId");
  }
  if (typeof persistRecycleBinState !== "function") {
    throw new Error("createRecycleBinService requires persistRecycleBinState");
  }
  if (typeof renderRecycleBinItems !== "function") {
    throw new Error("createRecycleBinService requires renderRecycleBinItems");
  }
  if (typeof updateRecycleBinControls !== "function") {
    throw new Error("createRecycleBinService requires updateRecycleBinControls");
  }
  if (typeof ensureOfflineStateOnError !== "function") {
    throw new Error("createRecycleBinService requires ensureOfflineStateOnError");
  }
  if (typeof handleFetchFailure !== "function") {
    throw new Error("createRecycleBinService requires handleFetchFailure");
  }
  if (typeof fetchRecordings !== "function") {
    throw new Error("createRecycleBinService requires fetchRecordings");
  }
  if (typeof confirmRecycleBinPurgePrompt !== "function") {
    throw new Error("createRecycleBinService requires confirmRecycleBinPurgePrompt");
  }
  if (typeof confirmDeletionPrompt !== "function") {
    throw new Error("createRecycleBinService requires confirmDeletionPrompt");
  }
  if (typeof updatePendingSelectionPath !== "function") {
    throw new Error("createRecycleBinService requires updatePendingSelectionPath");
  }
  if (typeof setNowPlaying !== "function") {
    throw new Error("createRecycleBinService requires setNowPlaying");
  }
  if (typeof getVisibleRecords !== "function") {
    throw new Error("createRecycleBinService requires getVisibleRecords");
  }
  if (typeof updateSelectionUI !== "function") {
    throw new Error("createRecycleBinService requires updateSelectionUI");
  }
  if (typeof syncRecycleSelectionFromPaths !== "function") {
    throw new Error(
      "createRecycleBinService requires syncRecycleSelectionFromPaths",
    );
  }
  if (typeof recyclePathFromId !== "function") {
    throw new Error("createRecycleBinService requires recyclePathFromId");
  }
  if (typeof shouldDeferDashboardUpdate !== "function") {
    throw new Error("createRecycleBinService requires shouldDeferDashboardUpdate");
  }
  if (typeof markRecordingsRefreshDeferred !== "function") {
    throw new Error("createRecycleBinService requires markRecordingsRefreshDeferred");
  }

  async function fetchRecycleBin(options = {}) {
    const { silent = false, force = false } = options;
    if (state.recycleBin.loading) {
      return true;
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
        const reason = typeof entry.reason === "string" && entry.reason ? entry.reason.trim() : "";
        const autoMoved = reason === "short_clip";

        normalized.push({
          id: idValue,
          name: typeof entry.name === "string" ? entry.name : "",
          original_path: typeof entry.original_path === "string" ? entry.original_path : "",
          day: typeof entry.day === "string" ? entry.day : "",
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
          raw_audio_path:
            typeof entry.raw_audio_path === "string" && entry.raw_audio_path
              ? entry.raw_audio_path
              : "",
          raw_audio_available: entry.raw_audio_available === true,
          raw_audio_name:
            typeof entry.raw_audio_name === "string" ? entry.raw_audio_name : "",
        });
      }

      const totalSize = normalized.reduce((accumulator, entry) => {
        const size = Number(entry.size_bytes);
        if (Number.isFinite(size) && size >= 0) {
          return accumulator + size;
        }
        return accumulator;
      }, 0);
      const totalCountRaw = Number(payload.total);
      const totalCount =
        Number.isFinite(totalCountRaw) && totalCountRaw >= 0
          ? Math.trunc(totalCountRaw)
          : normalized.length;

      if (shouldDeferDashboardUpdate({ silent, force })) {
        markRecordingsRefreshDeferred();
        return false;
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
      state.collectionCounts.recycle = totalCount;
      state.storage.recycleBin = totalSize;
      if (state.collection === "recycle") {
        state.total = totalCount;
        state.filteredSize = totalSize;
      }
      state.lastUpdated = new Date();
      return true;
    } catch (error) {
      console.error("Unable to load recycle bin", error);
      const offline = ensureOfflineStateOnError(error, handleFetchFailure);
      if (!silent) {
        const message = offline
          ? "Recorder unreachable. Unable to load recycle bin entries."
          : "Unable to load recycle bin entries.";
        window.alert(message);
      }
      return false;
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

  async function purgeRecycleBinEntries(ids, options = {}) {
    const { bypassConfirm = false } = options;
    if (state.recycleBin.loading) {
      return;
    }
    const sanitized = Array.isArray(ids)
      ? Array.from(
          new Set(
            ids
              .map((value) => (typeof value === "string" ? value.trim() : ""))
              .filter((value) => value),
          ),
        )
      : [];
    if (sanitized.length === 0) {
      return;
    }
    if (!bypassConfirm) {
      const confirmed = await confirmRecycleBinPurgePrompt(sanitized.length);
      if (!confirmed) {
        return;
      }
    }

    const purgePaths = sanitized.map((id) => recyclePathFromId(id)).filter(Boolean);
    const nextSelectionPath =
      purgePaths.length === 1 ? findNextSelectionPath(purgePaths) : null;

    state.recycleBin.loading = true;
    updateRecycleBinControls();

    let shouldReload = false;
    try {
      const response = await apiClient.fetch(apiPath("/api/recycle-bin/purge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: sanitized }),
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
        const nextSelected = new Set(state.recycleBin.selected);
        for (const entryId of purged) {
          nextSelected.delete(entryId);
          const path = recyclePathFromId(entryId);
          if (path) {
            state.selections.delete(path);
            if (state.selectionAnchor === path) {
              state.selectionAnchor = "";
            }
            if (state.selectionFocus === path) {
              state.selectionFocus = "";
            }
            if (state.current && state.current.path === path) {
              setNowPlaying(null);
            }
          }
        }
        state.recycleBin.selected = nextSelected;
        if (!nextSelected.has(state.recycleBin.activeId)) {
          state.recycleBin.activeId = "";
        }
        if (!nextSelected.has(state.recycleBin.anchorId)) {
          state.recycleBin.anchorId = "";
        }
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

    if (nextSelectionPath) {
      updatePendingSelectionPath(nextSelectionPath);
    }

    if (shouldReload) {
      await fetchRecycleBin({ silent: false });
    }
  }

  async function purgeRecycleBinSelection(options = {}) {
    syncRecycleSelectionFromPaths();
    const ids = Array.from(state.recycleBin.selected);
    await purgeRecycleBinEntries(ids, options);
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

  async function requestSelectionDeletion(options = {}) {
    const { bypassConfirm = false } = options;
    if (!state.selections || state.selections.size === 0) {
      return;
    }
    const paths = Array.from(state.selections.values()).filter((value) => {
      if (typeof value !== "string" || !value) {
        return false;
      }
      return !value.startsWith("recycle-bin/");
    });
    if (paths.length === 0) {
      return;
    }
    if (!bypassConfirm) {
      const count = paths.length;
      const message = `Move ${count} selected recording${count === 1 ? "" : "s"} to the recycle bin?`;
      const title = count === 1 ? "Move recording to recycle bin" : "Move recordings to recycle bin";
      const confirmed = await confirmDeletionPrompt(message, title);
      if (!confirmed) {
        return;
      }
    }
    await deleteRecordings(paths);
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

  return {
    fetchRecycleBin,
    restoreRecycleBinSelection,
    purgeRecycleBinSelection,
    purgeRecycleBinEntries,
    requestRecordDeletion,
    requestSelectionDeletion,
    deleteRecordings,
    renameRecording,
  };
}
