export function createRecycleBinHelpers({
  state,
  dom,
  apiPath,
  toFiniteOrNull,
  normalizeStartTimestamps,
  storageKey,
  escapeSelector,
  windowRef = typeof window !== "undefined" ? window : null,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("createRecycleBinHelpers requires a dashboard state reference");
  }
  if (typeof apiPath !== "function") {
    throw new Error("createRecycleBinHelpers requires an apiPath helper");
  }
  if (typeof toFiniteOrNull !== "function") {
    throw new Error("createRecycleBinHelpers requires a toFiniteOrNull helper");
  }
  if (typeof normalizeStartTimestamps !== "function") {
    throw new Error("createRecycleBinHelpers requires a normalizeStartTimestamps helper");
  }

  function getSessionStorage() {
    if (!windowRef || typeof windowRef.sessionStorage === "undefined") {
      return null;
    }
    try {
      return windowRef.sessionStorage;
    } catch (error) {
      return null;
    }
  }

  function loadPersistedRecycleBinState() {
    const storage = getSessionStorage();
    if (!storage || typeof storage.getItem !== "function") {
      return null;
    }
    if (!storageKey) {
      return null;
    }
    try {
      const raw = storage.getItem(storageKey);
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
    const storage = getSessionStorage();
    if (!storage || typeof storage.setItem !== "function") {
      return;
    }
    if (!storageKey) {
      return;
    }
    try {
      const selected = Array.from(state.recycleBin.selected.values());
      const activeId = typeof state.recycleBin.activeId === "string" ? state.recycleBin.activeId : "";
      const anchorId = typeof state.recycleBin.anchorId === "string" ? state.recycleBin.anchorId : "";
      if (selected.length === 0 && !activeId && !anchorId) {
        storage.removeItem(storageKey);
        return;
      }
      const payload = { selected, activeId, anchorId };
      storage.setItem(storageKey, JSON.stringify(payload));
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
        record.recycleBinId,
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
      } else if (updated.delete(entry.id)) {
        changed = true;
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
    if (!dom || !dom.recycleBinTableBody || typeof id !== "string" || !id) {
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
    const extension = typeof item.extension === "string" && item.extension ? item.extension : "";
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
    const motionTrigger = toFiniteOrNull(item.motion_trigger_offset_seconds);
    const motionRelease = toFiniteOrNull(item.motion_release_offset_seconds);
    const motionStarted = toFiniteOrNull(item.motion_started_epoch);
    const motionReleased = toFiniteOrNull(item.motion_released_epoch);
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
      motion_trigger_offset_seconds: motionTrigger,
      motion_release_offset_seconds: motionRelease,
      motion_started_epoch: motionStarted,
      motion_released_epoch: motionReleased,
    };
  }

  return {
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
  };
}
