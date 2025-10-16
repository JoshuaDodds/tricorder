function requireFunction(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`${name} must be a function.`);
  }
  return fn;
}

export function createRecordingMetaController(options = {}) {
  const {
    dom,
    recordingMetaState,
    recordingMetaTicker,
    renderPanel,
    hidePanel,
    updatePanel,
    nowMilliseconds,
    formatShortDuration,
    formatBytes,
    toFiniteOrNull,
    parseBoolean,
  } = options;

  if (!dom) {
    throw new Error("Recording meta controller requires dashboard DOM references.");
  }
  if (!recordingMetaState) {
    throw new Error("Recording meta controller requires a state object.");
  }
  if (!recordingMetaTicker) {
    throw new Error("Recording meta controller requires a ticker reference.");
  }

  const getTime = requireFunction(nowMilliseconds, "nowMilliseconds");
  const formatDuration = requireFunction(formatShortDuration, "formatShortDuration");
  const formatSize = requireFunction(formatBytes, "formatBytes");
  const toFinite = requireFunction(toFiniteOrNull, "toFiniteOrNull");
  const parseBool = requireFunction(parseBoolean, "parseBoolean");
  const renderMetaPanel = requireFunction(renderPanel, "renderPanel");
  const hideMetaPanel = requireFunction(hidePanel, "hidePanel");
  const updateMetaPanel = requireFunction(updatePanel, "updatePanel");

  function scheduleRecordingMetaTick() {
    if (!recordingMetaState.active) {
      return;
    }
    if (recordingMetaTicker.handle !== null) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      recordingMetaTicker.handle = window.requestAnimationFrame(handleRecordingMetaTick);
      recordingMetaTicker.usingAnimationFrame = true;
    } else {
      recordingMetaTicker.handle = setTimeout(() => {
        recordingMetaTicker.handle = null;
        handleRecordingMetaTick();
      }, 500);
      recordingMetaTicker.usingAnimationFrame = false;
    }
  }

  function cancelRecordingMetaTick() {
    if (recordingMetaTicker.handle === null) {
      return;
    }
    if (
      recordingMetaTicker.usingAnimationFrame &&
      typeof window !== "undefined" &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(recordingMetaTicker.handle);
    } else {
      clearTimeout(recordingMetaTicker.handle);
    }
    recordingMetaTicker.handle = null;
    recordingMetaTicker.usingAnimationFrame = false;
  }

  function handleRecordingMetaTick() {
    recordingMetaTicker.handle = null;
    if (!recordingMetaState.active) {
      return;
    }
    renderRecordingMeta();
    scheduleRecordingMetaTick();
  }

  function renderRecordingMeta() {
    renderMetaPanel({
      dom,
      recordingMetaState,
      formatShortDuration: formatDuration,
      formatBytes: formatSize,
      nowMilliseconds: getTime,
    });
  }

  function hideRecordingMeta() {
    hideMetaPanel({
      dom,
      recordingMetaState,
      cancelRecordingMetaTick,
      nowMilliseconds: getTime,
    });
  }

  function updateRecordingMeta(rawStatus) {
    updateMetaPanel({
      dom,
      recordingMetaState,
      status: rawStatus,
      nowMilliseconds: getTime,
      toFiniteOrNull: toFinite,
      parseBoolean: parseBool,
      formatShortDuration: formatDuration,
      formatBytes: formatSize,
      scheduleRecordingMetaTick,
      cancelRecordingMetaTick,
    });
  }

  return {
    scheduleRecordingMetaTick,
    cancelRecordingMetaTick,
    renderRecordingMeta,
    hideRecordingMeta,
    updateRecordingMeta,
  };
}

