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
  if (dom.rmsIndicator.dataset.visible !== "false") {
    dom.rmsIndicator.dataset.visible = "false";
  }
  dom.rmsIndicator.setAttribute("aria-hidden", "true");
  dom.rmsIndicatorValue.textContent = "";
  rmsIndicatorState.visible = false;
  rmsIndicatorState.value = null;
  rmsIndicatorState.threshold = null;
}

function updateRmsIndicator(rawStatus) {
  if (!dom.rmsIndicator || !dom.rmsIndicatorValue) {
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
  dom.rmsIndicator.setAttribute("aria-hidden", "false");
  rmsIndicatorState.visible = true;
  rmsIndicatorState.value = whole;
  rmsIndicatorState.threshold = Number.isFinite(thresholdWhole) ? thresholdWhole : null;
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
  if (state.partialRecord) {
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
  dom.deleteSelected.disabled = state.selections.size === 0;
  if (dom.downloadSelected) {
    dom.downloadSelected.disabled = state.selections.size === 0;
  }
  if (dom.renameSelected) {
    dom.renameSelected.disabled = state.selections.size !== 1 || isRenameDialogPending();
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

function updatePlayerActions(record) {
  if (!dom.playerMetaActions) {
    return;
  }
  const hasRecord = Boolean(
    record && typeof record.path === "string" && record.path.trim() !== ""
  );
  if (!hasRecord) {
    dom.playerMetaActions.hidden = true;
    if (dom.playerDownload) {
      dom.playerDownload.removeAttribute("href");
      dom.playerDownload.removeAttribute("download");
    }
    if (dom.playerRename) {
      dom.playerRename.disabled = true;
    }
    if (dom.playerDelete) {
      dom.playerDelete.disabled = true;
    }
    return;
  }

  dom.playerMetaActions.hidden = false;
