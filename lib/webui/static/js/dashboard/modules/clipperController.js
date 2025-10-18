import {
  persistClipperPreference,
  readStoredClipperPreference,
} from "./preferencesStorage.js";

export function createClipperController({
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
  setPendingSelectionPath,
  MIN_CLIP_DURATION_SECONDS,
  ensurePreviewSectionOrder,
  updateClipSelectionRange,
}) {
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
    overwriteExisting: true,
  };

  const notifyClipSelection =
    typeof updateClipSelectionRange === "function" ? updateClipSelectionRange : () => {};

  function parseTimecodeInput(value) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.replace(/[^0-9:.]+/g, "");
    if (!normalized) {
      return null;
    }
    const parts = normalized.split(":");
    if (parts.length === 0) {
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
    refreshClipSelectionIndicator();
  }

  function refreshClipSelectionIndicator() {
    if (typeof notifyClipSelection !== "function") {
      return;
    }
    if (
      !clipperState.enabled ||
      !clipperState.available ||
      !Number.isFinite(clipperState.durationSeconds)
    ) {
      notifyClipSelection(null);
      return;
    }
    const duration = clipperState.durationSeconds;
    const startValue = Number.isFinite(clipperState.startSeconds)
      ? clamp(clipperState.startSeconds, 0, duration)
      : null;
    const endValue = Number.isFinite(clipperState.endSeconds)
      ? clamp(clipperState.endSeconds, 0, duration)
      : null;
    if (startValue === null || endValue === null) {
      notifyClipSelection(null);
      return;
    }
    const start = Math.min(startValue, endValue);
    const end = Math.max(startValue, endValue);
    if (!(end > start)) {
      notifyClipSelection(null);
      return;
    }
    notifyClipSelection({
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
    });
  }

  function setClipperVisible(available) {
    ensurePreviewSectionOrder();
    clipperState.available = Boolean(available);
    syncClipperUI();
    refreshClipSelectionIndicator();
  }

  function setClipperStatus(message, stateValue = "idle") {
    clipperState.status = message || "";
    clipperState.statusState = stateValue;
    updateClipperStatusElement();
  }

  function setClipperEnabled(enabled, { persist = true, focus = false } = {}) {
    const next = Boolean(enabled);
    if (clipperState.enabled === next) {
      syncClipperUI();
      refreshClipSelectionIndicator();
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

    if (persist && typeof persistClipperPreference === "function") {
      persistClipperPreference(next);
    }

    syncClipperUI();
    refreshClipSelectionIndicator();

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
    if (typeof readStoredClipperPreference !== "function") {
      clipperState.enabled = false;
      syncClipperUI();
      return;
    }
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
      clipperState.nameDirty = false;
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

  function updateClipperUI({ updateInputs = true, updateName = true } = {}) {
    const duration = Number.isFinite(clipperState.durationSeconds)
      ? clipperState.durationSeconds
      : 0;
    const start = clamp(
      Number.isFinite(clipperState.startSeconds) ? clipperState.startSeconds : 0,
      0,
      duration,
    );
    let end = clamp(
      Number.isFinite(clipperState.endSeconds) ? clipperState.endSeconds : duration,
      0,
      duration,
    );
    if (end - start < MIN_CLIP_DURATION_SECONDS) {
      if (duration < MIN_CLIP_DURATION_SECONDS) {
        const adjustedStart = Math.max(0, duration - MIN_CLIP_DURATION_SECONDS);
        clipperState.startSeconds = adjustedStart;
        clipperState.endSeconds = Math.min(duration, adjustedStart + MIN_CLIP_DURATION_SECONDS);
      } else {
        clipperState.startSeconds = start;
        clipperState.endSeconds = Math.min(
          duration,
          start + MIN_CLIP_DURATION_SECONDS,
        );
      }
      end = clipperState.endSeconds;
    } else {
      clipperState.startSeconds = start;
      clipperState.endSeconds = end;
    }

    if (updateName && !clipperState.nameDirty) {
      updateClipperName();
    }

    if (dom.clipperStartInput && updateInputs) {
      dom.clipperStartInput.value = formatTimecode(clipperState.startSeconds);
    }
    if (dom.clipperEndInput && updateInputs) {
      dom.clipperEndInput.value = formatTimecode(clipperState.endSeconds);
    }

    const clipLength = clipperState.endSeconds - clipperState.startSeconds;
    const valid =
      clipLength >= MIN_CLIP_DURATION_SECONDS &&
      clipLength <= Math.max(MIN_CLIP_DURATION_SECONDS, duration) &&
      clipperState.endSeconds >= clipperState.startSeconds;

    if (dom.clipperContainer) {
      dom.clipperContainer.dataset.busy = clipperState.busy ? "true" : "false";
    }
    if (dom.clipperForm) {
      dom.clipperForm.setAttribute("aria-busy", clipperState.busy ? "true" : "false");
    }
    if (dom.clipperSubmit) {
      dom.clipperSubmit.disabled = clipperState.busy || !valid;
      dom.clipperSubmit.setAttribute("aria-busy", clipperState.busy ? "true" : "false");
      dom.clipperSubmit.textContent = clipperState.busy ? "Saving…" : "Save clip";
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

    refreshClipSelectionIndicator();
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
      refreshClipSelectionIndicator();
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
      refreshClipSelectionIndicator();
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
    setClipperVisible(true);
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
      const response = await apiClient.fetch(apiPath("/api/recordings/clip/undo"), {
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
        setPendingSelectionPath(responsePayload.path);
      }

      updateClipperUI();
      await fetchRecordings({ silent: false, force: true });
    } catch (error) {
      console.error("Clip undo failed", error);
      clipperState.busy = false;
      const message =
        error instanceof Error && error.message ? error.message : "Unable to restore clip.";
      setClipperStatus(message, "error");
      updateClipperUI();
    }
  }

  async function submitClipperForm(event) {
    if (event) {
      event.preventDefault();
    }

    if (!dom.clipperForm || clipperState.busy) {
      return;
    }

    const record = state.current;
    if (!record || typeof record !== "object") {
      setClipperStatus("No recording selected.", "error");
      return;
    }

    if (!Number.isFinite(clipperState.durationSeconds)) {
      setClipperStatus("Select a valid range before saving.", "error");
      return;
    }

    const duration = clipperState.durationSeconds;
    const clipLength = clipperState.endSeconds - clipperState.startSeconds;
    if (clipLength < MIN_CLIP_DURATION_SECONDS || clipLength > duration) {
      setClipperStatus("Select a valid range before saving.", "error");
      return;
    }

    const payload = {
      source_path: record.path,
      start_seconds: clipperState.startSeconds,
      end_seconds: clipperState.endSeconds,
      overwrite_existing: clipperState.overwriteExisting,
    };

    let clipName = "";
    if (dom.clipperNameInput) {
      clipName = dom.clipperNameInput.value.trim();
    }

    if (!clipName) {
      setClipperStatus("Clip name is required.", "error");
      return;
    }

    const sanitized = sanitizeClipName(clipName);
    if (!sanitized) {
      setClipperStatus(
        "Clip name must use letters, numbers, dots, hyphens, or underscores.",
        "error",
      );
      return;
    }

    const ensured = ensureUniqueClipName(sanitized, record);
    payload.name = ensured;
    clipperState.nameDirty = clipName !== ensured;

    if (dom.clipperNameInput) {
      dom.clipperNameInput.value = ensured;
    }

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
      const response = await apiClient.fetch(apiPath("/api/recordings/clip"), {
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
        setPendingSelectionPath(responsePayload.path);
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
      await fetchRecordings({ silent: false, force: true });
    } catch (error) {
      console.error("Clip creation failed", error);
      clipperState.busy = false;
      const message =
        error instanceof Error && error.message ? error.message : "Unable to save clip.";
      setClipperStatus(message, "error");
      updateClipperUI();
    }
  }

  function updateClipperDuration(durationSeconds) {
    clipperState.durationSeconds = durationSeconds;
    updateClipperUI();
  }

  return {
    state: clipperState,
    setVisible: setClipperVisible,
    setStatus: setClipperStatus,
    setEnabled: setClipperEnabled,
    restorePreference: restoreClipperPreference,
    updateName: updateClipperName,
    updateUI: updateClipperUI,
    initialize: initializeClipper,
    resetRange: resetClipperRange,
    setStartFromPlayhead: setClipperStartFromPlayhead,
    setEndFromPlayhead: setClipperEndFromPlayhead,
    handleStartChange: handleClipperStartChange,
    handleEndChange: handleClipperEndChange,
    handleNameInput: handleClipperNameInput,
    handleNameBlur: handleClipperNameBlur,
    handleOverwriteChange: handleClipperOverwriteChange,
    handleReset: handleClipperReset,
    handleUndo: handleClipperUndo,
    submitForm: submitClipperForm,
    updateDuration: updateClipperDuration,
  };
}
