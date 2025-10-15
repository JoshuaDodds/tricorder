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

  const componentRegistry = ensureComponentRegistry();

  function renderRecordingMetaPanel(options) {
  const { dom, recordingMetaState, formatShortDuration, formatBytes, nowMilliseconds } = options;
  if (!dom.recordingMeta || !dom.recordingMetaText || !recordingMetaState.active) {
    return;
  }
  const elapsedSeconds = Math.max(
    0,
    recordingMetaState.baseDuration + (nowMilliseconds() - recordingMetaState.baseTime) / 1000,
  );
  const sizeBytes = Number.isFinite(recordingMetaState.sizeBytes)
    ? Math.max(0, recordingMetaState.sizeBytes)
    : 0;
  const text = `Current Recording: ${formatShortDuration(elapsedSeconds)} • ${formatBytes(sizeBytes)}`;
  dom.recordingMeta.dataset.state = "active";
  if (text === recordingMetaState.text) {
    return;
  }
  dom.recordingMetaText.textContent = text;
  dom.recordingMeta.dataset.visible = "true";
  dom.recordingMeta.setAttribute("aria-hidden", "false");
  recordingMetaState.text = text;
  }

  function hideRecordingMetaPanel(options) {
  const { dom, recordingMetaState, cancelRecordingMetaTick, nowMilliseconds } = options;
  if (!dom.recordingMeta || !dom.recordingMetaText) {
    return;
  }
  cancelRecordingMetaTick();
  recordingMetaState.active = false;
  recordingMetaState.baseDuration = 0;
  recordingMetaState.baseTime = nowMilliseconds();
  recordingMetaState.sizeBytes = 0;
  recordingMetaState.text = "";
  dom.recordingMeta.dataset.visible = "false";
  dom.recordingMeta.dataset.state = "idle";
  dom.recordingMeta.setAttribute("aria-hidden", "true");
  dom.recordingMetaText.textContent = "";
  }

  function updateRecordingMetaPanel(options) {
  const {
    dom,
    recordingMetaState,
    status,
    nowMilliseconds,
    toFiniteOrNull,
    parseBoolean,
    formatShortDuration,
    formatBytes,
    scheduleRecordingMetaTick,
    cancelRecordingMetaTick,
  } = options;

  if (!dom.recordingMeta || !dom.recordingMetaText) {
    return;
  }

  const normalizedStatus = status && typeof status === "object" ? status : null;
  const event = normalizedStatus && typeof normalizedStatus.event === "object"
    ? normalizedStatus.event
    : null;
  let capturing = normalizedStatus ? Boolean(normalizedStatus.capturing) : false;
  if (!capturing && event && parseBoolean(event.in_progress)) {
    capturing = true;
  }
  if (!capturing) {
    hideRecordingMetaPanel({
      dom,
      recordingMetaState,
      cancelRecordingMetaTick,
      nowMilliseconds,
    });
    return;
  }

  const durationSeconds = normalizedStatus ? toFiniteOrNull(normalizedStatus.event_duration_seconds) : null;
  const sizeBytes = normalizedStatus ? toFiniteOrNull(normalizedStatus.event_size_bytes) : null;
  const startedEpoch = event ? toFiniteOrNull(event.started_epoch) : null;

  if (durationSeconds !== null) {
    recordingMetaState.baseDuration = Math.max(0, durationSeconds);
    recordingMetaState.baseTime = nowMilliseconds();
  } else if (startedEpoch !== null) {
    recordingMetaState.baseDuration = Math.max(0, Date.now() / 1000 - startedEpoch);
    recordingMetaState.baseTime = nowMilliseconds();
  } else if (!recordingMetaState.active) {
    recordingMetaState.baseDuration = 0;
    recordingMetaState.baseTime = nowMilliseconds();
  }

  if (sizeBytes !== null) {
    recordingMetaState.sizeBytes = Math.max(0, sizeBytes);
  }

  recordingMetaState.active = true;
  recordingMetaState.text = "";
  renderRecordingMetaPanel({
    dom,
    recordingMetaState,
    formatShortDuration,
    formatBytes,
    nowMilliseconds,
  });
  scheduleRecordingMetaTick();
  }

  componentRegistry.renderRecordingMetaPanel = renderRecordingMetaPanel;
  componentRegistry.hideRecordingMetaPanel = hideRecordingMetaPanel;
  componentRegistry.updateRecordingMetaPanel = updateRecordingMetaPanel;
})();
