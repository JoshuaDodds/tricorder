
function handleSpacebarShortcut(event) {
  const isSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
  if (!isSpace || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (shouldIgnoreSpacebarTarget(event.target)) {
    return;
  }

  event.preventDefault();

  const players = getControllableAudioPlayers();
  const playing = players.filter((media) => media && !media.paused);

  if (playing.length > 0) {
    playbackState.pausedViaSpacebar.clear();
    for (const media of playing) {
      playbackState.pausedViaSpacebar.add(media);
      try {
        media.pause();
      } catch (error) {
        /* ignore pause errors */
      }
    }
    return;
  }

  const paused = Array.from(playbackState.pausedViaSpacebar).filter((media) => media && media.paused);
  if (paused.length > 0) {
    playbackState.pausedViaSpacebar.clear();
    for (const media of paused) {
      media.play().catch(() => undefined);
    }
    return;
  }

  resumeDefaultPlayers();
}

function setCollection(nextCollection, options = {}) {
  const { force = false, fetch = true } = options;
  const normalized = nextCollection === "saved" ? "saved" : "recent";
  if (state.collection === normalized && !force) {
    if (fetch) {
      fetchRecordings({ silent: false, force: true });
    }
    return;
  }

  state.collection = normalized;
  persistCollection(state.collection);
  state.offset = 0;
  state.selections.clear();
  state.selectionAnchor = "";
  state.selectionFocus = "";
  updateSelectionUI();
  setNowPlaying(null, { autoplay: false, resetToStart: true });
  updateCollectionUI();
  applyNowPlayingHighlight();
  if (fetch) {
    fetchRecordings({ silent: false, force: true });
  }
}

async function fetchRecordings(options = {}) {
  const { silent = false, force = false } = options;
  if (state.recycleBin.open && !force) {
    recordingsRefreshDeferred = true;
    return;
  }
  recordingsRefreshDeferred = false;
  if (fetchInFlight) {
    fetchQueued = true;
    return;
  }
  fetchInFlight = true;

  const limit = clampLimitValue(state.filters.limit);
  if (limit !== state.filters.limit) {
    state.filters.limit = limit;
    persistFilters(state.filters);
  }
  if (dom.filterLimit) {
    dom.filterLimit.value = String(limit);
  }
  if (state.total > 0) {
    const normalizedOffset = clampOffsetValue(state.offset, limit, state.total);
    if (normalizedOffset !== state.offset) {
      state.offset = normalizedOffset;
    }
  }
  const offset = Number.isFinite(state.offset) ? Math.max(0, Math.trunc(state.offset)) : 0;
  if (offset !== state.offset) {
    state.offset = offset;
  }

  const params = new URLSearchParams();
  if (state.filters.search) {
    params.set("search", state.filters.search);
  }
  if (state.filters.day) {
    params.set("day", state.filters.day);
  }
  if (state.filters.timeRange) {
    params.set("time_range", state.filters.timeRange);
  }
  params.set("limit", String(limit));
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  params.set("collection", state.collection === "saved" ? "saved" : "recent");

  const endpoint = apiPath(`/api/recordings?${params.toString()}`);
  try {
    const response = await apiClient.fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    const payloadCollectionRaw =
      typeof payload.collection === "string" ? payload.collection.trim().toLowerCase() : "";
    const payloadCollection = payloadCollectionRaw === "saved" ? "saved" : "recent";
    if (state.collection !== payloadCollection) {
      state.collection = payloadCollection;
      persistCollection(state.collection);
    }
    updateCollectionUI();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const normalizedRecords = items.map((item) => {
      const { startEpoch, startedEpoch, startedAt } = normalizeStartTimestamps(item);
      return {
        ...item,
        size_bytes: numericValue(item.size_bytes, 0),
        modified: numericValue(item.modified, 0),
        duration_seconds: Number.isFinite(item.duration_seconds)
          ? Number(item.duration_seconds)
          : null,
        start_epoch: startEpoch,
        started_epoch: startedEpoch,
        started_at: startedAt,
        trigger_offset_seconds: toFiniteOrNull(item.trigger_offset_seconds),
        release_offset_seconds: toFiniteOrNull(item.release_offset_seconds),
        motion_trigger_offset_seconds: toFiniteOrNull(
          item.motion_trigger_offset_seconds
        ),
        motion_release_offset_seconds: toFiniteOrNull(
          item.motion_release_offset_seconds
        ),
        motion_started_epoch: toFiniteOrNull(item.motion_started_epoch),
        motion_released_epoch: toFiniteOrNull(item.motion_released_epoch),
        motion_segments: normalizeMotionSegments(item.motion_segments),
        waveform_path:
          typeof item.waveform_path === "string" && item.waveform_path
            ? String(item.waveform_path)
            : null,
        manual_event: Boolean(item.manual_event),
        detected_rms: Boolean(item.detected_rms),
        detected_vad: Boolean(item.detected_vad),
        trigger_sources: normalizeTriggerSources(item.trigger_sources),
        end_reason:
          typeof item.end_reason === "string" && item.end_reason
            ? item.end_reason.trim()
            : "",
      };
    });
    const nextFingerprint = computeRecordsFingerprint(normalizedRecords, {
      skipPartialVolatile: true,
    });
    const recordsChanged = state.recordsFingerprint !== nextFingerprint;
    let effectiveLimit = limit;
    const payloadLimit = toFiniteOrNull(payload.limit);
    if (payloadLimit !== null) {
      const sanitizedLimit = clampLimitValue(payloadLimit);
      effectiveLimit = sanitizedLimit;
      if (sanitizedLimit !== state.filters.limit) {
        state.filters = {
          ...state.filters,
          limit: sanitizedLimit,
        };
        persistFilters(state.filters);
      }
    }
    const payloadTimeRange =
      typeof payload.time_range === "string" && VALID_TIME_RANGES.has(payload.time_range)
        ? payload.time_range
        : "";
    if (payloadTimeRange !== state.filters.timeRange) {
      state.filters = {
        ...state.filters,
        timeRange: payloadTimeRange,
      };
      persistFilters(state.filters);
    }
    const total = Number.isFinite(payload.total)
      ? Number(payload.total)
      : normalizedRecords.length;
    const totalSize = numericValue(payload.total_size_bytes, 0);
    state.records = normalizedRecords;
    if (clipper.state.undoTokens instanceof Map) {
      const knownPaths = new Set(normalizedRecords.map((record) => record.path));
      for (const [path] of clipper.state.undoTokens) {
        if (!knownPaths.has(path)) {
          clipper.state.undoTokens.delete(path);
        }
      }
    }
    state.recordsFingerprint = nextFingerprint;
    const payloadMotionState =
      payload.motion_state && typeof payload.motion_state === "object"
        ? payload.motion_state
        : null;
    const previousMotionState =
      state.motionState && typeof state.motionState === "object"
        ? state.motionState
        : null;
    const nextMotionState = resolveNextMotionState(
      payloadMotionState,
      previousMotionState,
      eventStreamState.connected
    );
    state.motionState = nextMotionState;
    const captureStatus = payload.capture_status;
    state.captureStatus = captureStatus && typeof captureStatus === "object" ? captureStatus : null;
    const previousPartialFingerprint = state.partialFingerprint;
    const nextPartial = deriveInProgressRecord(captureStatus);
    const nextPartialFingerprint = computePartialFingerprint(nextPartial);
    const partialChanged = previousPartialFingerprint !== nextPartialFingerprint;
    state.partialRecord = nextPartial;
    state.partialFingerprint = nextPartialFingerprint;
    if (nextPartial) {
      state.selections.delete(nextPartial.path);
    }
    state.total = total;
    state.filteredSize = totalSize;
    state.storage.recordings = numericValue(payload.recordings_total_bytes, totalSize);
    state.storage.recycleBin = numericValue(payload.recycle_bin_total_bytes, 0);
    state.storage.total = toFiniteOrNull(payload.storage_total_bytes);
    state.storage.free = toFiniteOrNull(payload.storage_free_bytes);
    state.storage.diskUsed = toFiniteOrNull(payload.storage_used_bytes);
    state.availableDays = Array.isArray(payload.available_days) ? payload.available_days : [];
    state.lastUpdated = new Date();
    const payloadOffset = toFiniteOrNull(payload.offset);
    const offsetBasis =
      payloadOffset !== null ? Math.max(0, Math.trunc(payloadOffset)) : offset;
    const normalizedOffset = clampOffsetValue(offsetBasis, effectiveLimit, total);
    state.offset = normalizedOffset;
    if (total > 0 && normalizedRecords.length === 0 && normalizedOffset < offsetBasis) {
      fetchQueued = true;
    }
    populateFilters();
    updateSortIndicators();

    let maintainCurrentSelection = true;
    if (pendingSelectionPath) {
      const candidatePath = pendingSelectionPath;
      updatePendingSelectionPath(null);
      const nextRecord = state.records.find((entry) => entry.path === candidatePath);
      if (nextRecord) {
        setNowPlaying(nextRecord, { autoplay: false, resetToStart: true });
        maintainCurrentSelection = false;
      }
    }

    const previewingRecycleRecord = isRecycleBinRecord(state.current);

    if (maintainCurrentSelection && state.current && !previewingRecycleRecord) {
      const current = state.records.find((entry) => entry.path === state.current.path);
      if (current) {
        state.current = current;
        const playbackInfo = updatePlaybackSourceForRecord(current, { preserveMode: true });
        updatePlayerMeta(current);
        updateWaveformMarkers();
        clipper.updateDuration(toFiniteOrNull(current.duration_seconds));
        if (playbackInfo.previousMode === "raw" && playbackInfo.nextMode !== "raw") {
          setPlaybackSource(playbackInfo.nextMode, { force: true });
        } else if (playbackInfo.nextMode === "raw" && playbackInfo.rawPathChanged) {
          setPlaybackSource("raw", { force: true });
        }
      } else {
        const partialPath = nextPartial ? nextPartial.path : null;
        if (state.current.isPartial && partialPath === state.current.path) {
          state.current = nextPartial;
          const partialPlayback = updatePlaybackSourceForRecord(nextPartial, { preserveMode: true });
          updatePlayerMeta(nextPartial);
          if (partialPlayback.previousMode === "raw" && partialPlayback.nextMode !== "raw") {
            setPlaybackSource(partialPlayback.nextMode, { force: true });
          } else if (partialPlayback.nextMode === "raw" && partialPlayback.rawPathChanged) {
            setPlaybackSource("raw", { force: true });
          }
        } else if (state.current.isPartial) {
          const finalizedRecord = findFinalizedRecordForPartial(state.current, state.records);
          if (finalizedRecord) {
            const wasPlaying = Boolean(dom.player && !dom.player.paused);
            const wasSelected = state.selections.has(state.current.path);
            state.selections.delete(state.current.path);
            if (wasSelected) {
              state.selections.add(finalizedRecord.path);
            }
            setNowPlaying(finalizedRecord, {
              autoplay: wasPlaying,
              resetToStart: true,
            });
            maintainCurrentSelection = false;
          } else {
            setNowPlaying(null);
          }
        } else {
          setNowPlaying(null);
        }
      }
    }

    if (!nextPartial && state.current && state.current.isPartial) {
      setNowPlaying(null);
    } else if (nextPartial && state.current && state.current.isPartial) {
      state.current = nextPartial;
      const nextPlayback = updatePlaybackSourceForRecord(nextPartial, { preserveMode: true });
      updatePlayerMeta(nextPartial);
      if (nextPlayback.previousMode === "raw" && nextPlayback.nextMode !== "raw") {
        setPlaybackSource(nextPlayback.nextMode, { force: true });
      } else if (nextPlayback.nextMode === "raw" && nextPlayback.rawPathChanged) {
        setPlaybackSource("raw", { force: true });
      }
    }

    let handledPartialUpdate = false;
    if (
      !recordsChanged &&
      partialChanged &&
      nextPartial &&
      nextPartial.path &&
      (!isPreviewRefreshHeld() || force)
    ) {
      handledPartialUpdate = updateInProgressRecordRow(nextPartial);
    }
    if (isPreviewRefreshHeld() && !force) {
      markPreviewRefreshPending();
    } else if (recordsChanged || (!handledPartialUpdate && partialChanged)) {
      renderRecords({ force });
    } else {
      updateSelectionUI();
      applyNowPlayingHighlight();
      syncPlayerPlacement();
    }
    updateStats();
    updatePaginationControls();
    setRecordingIndicatorStatus(payload.capture_status, state.motionState);
    updateRmsIndicator(payload.capture_status);
    updateRecordingMeta(payload.capture_status);
    updateEncodingStatus(payload.capture_status);
    updateSplitEventButton(captureStatus);
    updateAutoRecordButton(captureStatus);
    updateManualRecordButton(captureStatus);
    handleFetchSuccess();
  } catch (error) {
    console.error("Failed to load recordings", error);
    state.records = [];
    state.recordsFingerprint = "";
    state.total = 0;
    state.filteredSize = 0;
    state.offset = 0;
    state.storage.recordings = 0;
    state.storage.total = null;
    state.storage.free = null;
    state.storage.diskUsed = null;
    state.lastUpdated = null;
    state.motionState = null;
    if (isPreviewRefreshHeld() && !force) {
      markPreviewRefreshPending();
    } else {
      renderRecords({ force });
    }
    updateStats();
    updatePaginationControls();
    handleFetchFailure();
    setRecordingIndicatorUnknown();
    hideRmsIndicator();
    state.captureStatus = null;
    setSplitEventDisabled(true, "Recorder offline.");
    autoRecordState.enabled = true;
    autoRecordState.pending = false;
    autoRecordState.motionOverride = false;
    setAutoRecordDisabled(true, "Recorder status unavailable.");
    setAutoRecordButtonState(true);
    manualRecordState.enabled = false;
    manualRecordState.pending = false;
    setManualRecordDisabled(true, "Recorder status unavailable.");
    setManualRecordButtonState(false);
    fetchQueued = false;
  } finally {
    fetchInFlight = false;
    if (fetchQueued) {
      fetchQueued = false;
      fetchRecordings({ silent: true });
    }
  }
}

function parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return ["1", "true", "yes", "on"].includes(normalized);
  }
  return Boolean(value);
}

function parseMotionFlag(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["1", "true", "yes", "on", "running"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", "stopped"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function isMotionTriggeredEvent(source) {
  if (!source || typeof source !== "object") {
    return false;
  }

  const motionTrigger = toFiniteOrNull(source.motion_trigger_offset_seconds);
  if (Number.isFinite(motionTrigger)) {
    return true;
  }

  const motionReleaseOffset = toFiniteOrNull(source.motion_release_offset_seconds);
  if (Number.isFinite(motionReleaseOffset)) {
    return true;
  }

  const motionStarted = toFiniteOrNull(source.motion_started_epoch);
  if (Number.isFinite(motionStarted)) {
    return true;
  }

  const motionReleased = toFiniteOrNull(source.motion_released_epoch);
  if (Number.isFinite(motionReleased)) {
    return true;
  }

  const motionActive = parseBoolean(source.motion_active);
  if (motionActive === true) {
    return true;
  }

  const motionSequence = toFiniteOrNull(source.motion_sequence);
  if (Number.isFinite(motionSequence) && motionSequence > 0 && motionActive !== false) {
    return true;
  }

  return false;
}

function resolveNextMotionState(payloadSnapshot, previousSnapshot, eventStreamConnected) {
  const nextSnapshot =
    payloadSnapshot && typeof payloadSnapshot === "object" ? payloadSnapshot : null;
  const currentSnapshot =
    previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : null;
  const hasEventStream = Boolean(eventStreamConnected);

  if (nextSnapshot) {
    const payloadSequence = toFiniteOrNull(nextSnapshot.sequence);
    const currentSequence = currentSnapshot ? toFiniteOrNull(currentSnapshot.sequence) : null;
    if (
      !hasEventStream ||
      !currentSnapshot ||
      (payloadSequence !== null &&
        (currentSequence === null || payloadSequence > currentSequence))
    ) {
      return nextSnapshot;
    }
    return currentSnapshot;
  }

  if (!hasEventStream) {
    return null;
  }

  return currentSnapshot;
}

function __setEventStreamConnectedForTests(connected) {
  eventStreamState.connected = Boolean(connected);
}

function parseListInput(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
}

async function extractErrorMessage(response) {
  if (!response) {
    return "";
  }
  try {
    const payload = await response.json();
    if (payload && typeof payload === "object") {
      if (typeof payload.error === "string" && payload.error) {
        return payload.error;
      }
      if (typeof payload.message === "string" && payload.message) {
        return payload.message;
      }
    }
  } catch (error) {
    // Ignore JSON parsing issues.
  }
  try {
    const text = await response.text();
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  } catch (error) {
    // Ignore text extraction errors.
  }
  return "";
}

const AUDIO_SAMPLE_RATES = [48000, 32000, 16000];
const AUDIO_FRAME_LENGTHS = [10, 20, 30];
const STREAMING_MODES = new Set(["hls", "webrtc"]);
const TRANSCRIPTION_ENGINES = new Set(["vosk"]);

const AUDIO_FILTER_LIMITS = {
  denoise: {
    noise_floor_db: { min: -80, max: 0, formatter: formatDbDisplay },
  },
  highpass: {
    cutoff_hz: { min: 20, max: 2000, formatter: formatHzDisplay },
  },
  lowpass: {
    cutoff_hz: { min: 1000, max: 20000, formatter: formatHzDisplay },
  },
  notch: {
    freq_hz: { min: 20, max: 20000, formatter: formatHzDisplay },
    quality: { min: 0.1, max: 100, formatter: formatQualityDisplay },
  },
  spectral_gate: {
    sensitivity: { min: 0.1, max: 4, formatter: formatUnitless },
    reduction_db: { min: -60, max: 0, formatter: formatDbDisplay },
    noise_update: { min: 0, max: 1, formatter: formatRatioDisplay },
    noise_decay: { min: 0, max: 1, formatter: formatRatioDisplay },
  },
};

const AUDIO_FILTER_ENUMS = {
  denoise: {
    type: new Set(["afftdn"]),
  },
};

const AUDIO_FILTER_DEFAULTS = {
  denoise: { enabled: false, type: "afftdn", noise_floor_db: -30 },
  highpass: { enabled: false, cutoff_hz: 90 },
  lowpass: { enabled: false, cutoff_hz: 10000 },
  notch: { enabled: false, freq_hz: 60, quality: 30 },
  spectral_gate: {
    enabled: false,
    sensitivity: 1.5,
    reduction_db: -18,
    noise_update: 0.1,
    noise_decay: 0.95,
  },
};

const AUDIO_CALIBRATION_DEFAULTS = {
  auto_noise_profile: false,
  auto_gain: false,
};

function audioDefaults() {
  return {
    device: "",
    sample_rate: 48000,
    frame_ms: 20,
    gain: 2.5,
    vad_aggressiveness: 3,
    filter_chain: {
      denoise: { ...AUDIO_FILTER_DEFAULTS.denoise },
      highpass: { ...AUDIO_FILTER_DEFAULTS.highpass },
      lowpass: { ...AUDIO_FILTER_DEFAULTS.lowpass },
      notch: { ...AUDIO_FILTER_DEFAULTS.notch },
      spectral_gate: { ...AUDIO_FILTER_DEFAULTS.spectral_gate },
    },
    calibration: { ...AUDIO_CALIBRATION_DEFAULTS },
  };
}

function canonicalAudioSettings(settings) {
  const defaults = audioDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  if (typeof source.device === "string") {
    defaults.device = source.device.trim();
  }

  const sampleRate = Number(source.sample_rate);
  if (Number.isFinite(sampleRate)) {
    const rounded = Math.round(sampleRate);
    defaults.sample_rate = AUDIO_SAMPLE_RATES.includes(rounded)
      ? rounded
      : defaults.sample_rate;
  }

  const frameMs = Number(source.frame_ms);
  if (Number.isFinite(frameMs)) {
    const rounded = Math.round(frameMs);
    defaults.frame_ms = AUDIO_FRAME_LENGTHS.includes(rounded)
      ? rounded
      : defaults.frame_ms;
  }

  const gain = Number(source.gain);
  if (Number.isFinite(gain)) {
    defaults.gain = Math.max(0.1, Math.min(16, gain));
  }

  const vad = Number(source.vad_aggressiveness);
  if (Number.isFinite(vad)) {
    const rounded = Math.round(vad);
    defaults.vad_aggressiveness = Math.max(0, Math.min(3, rounded));
  }

  const filterSource =
    settings && typeof settings === "object" && settings.filter_chain && typeof settings.filter_chain === "object"
      ? settings.filter_chain
      : null;
  if (filterSource) {
    const target = defaults.filter_chain;
    for (const [stage, fieldSpecs] of Object.entries(AUDIO_FILTER_LIMITS)) {
      const stageTarget = target[stage];
      const stagePayload = filterSource[stage];
      if (!stageTarget || typeof stageTarget !== "object") {
        continue;
      }
      if (!stagePayload || typeof stagePayload !== "object") {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(stagePayload, "enabled")) {
        stageTarget.enabled = parseBoolean(stagePayload.enabled);
      }
      for (const [field, spec] of Object.entries(fieldSpecs)) {
        if (!Object.prototype.hasOwnProperty.call(stagePayload, field)) {
          continue;
        }
        const rawValue = Number(stagePayload[field]);
        if (Number.isFinite(rawValue)) {
          const clamped = Math.min(spec.max, Math.max(spec.min, rawValue));
          stageTarget[field] = clamped;
        }
      }
      const enumSpecs = AUDIO_FILTER_ENUMS[stage];
      if (enumSpecs && typeof enumSpecs === "object") {
        for (const [field, allowed] of Object.entries(enumSpecs)) {
          if (!Object.prototype.hasOwnProperty.call(stagePayload, field)) {
            continue;
          }
          const rawValue = stagePayload[field];
          if (typeof rawValue !== "string") {
            continue;
          }
          const normalized = rawValue.trim().toLowerCase();
          if (allowed instanceof Set && allowed.has(normalized)) {
            stageTarget[field] = normalized;
          }
        }
      }
    }
  }

  const calibrationSource =
    settings && typeof settings === "object" && settings.calibration && typeof settings.calibration === "object"
      ? settings.calibration
      : null;
  if (calibrationSource) {
    const calibrationTarget = defaults.calibration;
    if (Object.prototype.hasOwnProperty.call(calibrationSource, "auto_noise_profile")) {
      calibrationTarget.auto_noise_profile = parseBoolean(calibrationSource.auto_noise_profile);
    }
    if (Object.prototype.hasOwnProperty.call(calibrationSource, "auto_gain")) {
      calibrationTarget.auto_gain = parseBoolean(calibrationSource.auto_gain);
    }
  }

  return defaults;
}

function canonicalAudioFromConfig(config) {
  const section = config && typeof config === "object" ? config.audio : null;
  return canonicalAudioSettings(section);
}

function updateAudioFilterControls() {
  const section = recorderDom.sections ? recorderDom.sections.audio : null;
  if (!section) {
    return;
  }

  const stages = [
    {
      toggle: section.filterDenoiseEnabled,
      inputs: [
        {
          control: section.filterDenoiseFloor,
          display: section.filterDenoiseFloorDisplay,
          formatter: formatDbDisplay,
        },
        {
          control: section.filterDenoiseType,
        },
      ],
    },
    {
      toggle: section.filterHighpassEnabled,
      inputs: [
        {
          control: section.filterHighpassCutoff,
          display: section.filterHighpassDisplay,
          formatter: formatHzDisplay,
        },
      ],
    },
    {
      toggle: section.filterLowpassEnabled,
      inputs: [
        {
          control: section.filterLowpassCutoff,
          display: section.filterLowpassDisplay,
          formatter: formatHzDisplay,
        },
      ],
    },
    {
      toggle: section.filterNotchEnabled,
      inputs: [
        {
          control: section.filterNotchFrequency,
          display: section.filterNotchFrequencyDisplay,
          formatter: formatHzDisplay,
        },
        {
          control: section.filterNotchQuality,
          display: section.filterNotchQualityDisplay,
          formatter: formatQualityDisplay,
        },
      ],
    },
    {
      toggle: section.filterSpectralGateEnabled,
      inputs: [
        {
          control: section.filterSpectralGateSensitivity,
          display: section.filterSpectralGateSensitivityDisplay,
          formatter: formatUnitless,
        },
        {
          control: section.filterSpectralGateReduction,
          display: section.filterSpectralGateReductionDisplay,
          formatter: formatDbDisplay,
        },
        {
          control: section.filterSpectralGateNoiseUpdate,
          display: section.filterSpectralGateNoiseUpdateDisplay,
          formatter: formatRatioDisplay,
        },
        {
          control: section.filterSpectralGateNoiseDecay,
          display: section.filterSpectralGateNoiseDecayDisplay,
          formatter: formatRatioDisplay,
        },
      ],
    },
  ];

  for (const stage of stages) {
    const toggle = stage.toggle;
    const enabled =
      toggle instanceof HTMLInputElement && toggle.type === "checkbox"
        ? toggle.checked
        : true;
    for (const item of stage.inputs) {
      const { control, display, formatter } = item;
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) {
        continue;
      }
      control.disabled = !enabled;
      if (display instanceof HTMLElement && typeof formatter === "function") {
        display.textContent = formatter(control.value);
      }
    }
  }

  if (section.calibrateNoiseButton instanceof HTMLButtonElement) {
    const enabled = section.calibrationNoise instanceof HTMLInputElement ? section.calibrationNoise.checked : true;
    section.calibrateNoiseButton.disabled = !enabled;
    const hint = section.calibrationNoiseHint;
    if (hint instanceof HTMLElement) {
      hint.hidden = enabled;
      hint.setAttribute("aria-hidden", enabled ? "true" : "false");
    }
  }
}

function segmenterDefaults() {
  return {
    pre_pad_ms: 2000,
    post_pad_ms: 3000,
    motion_release_padding_minutes: 0,
    rms_threshold: 300,
    keep_window_frames: 30,
    start_consecutive: 25,
    keep_consecutive: 25,
    flush_threshold_bytes: 128 * 1024,
    max_queue_frames: 512,
    min_clip_seconds: 0,
    use_rnnoise: false,
    use_noisereduce: false,
    denoise_before_vad: false,
  };
}

function canonicalSegmenterSettings(settings) {
  const defaults = segmenterDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  function toInt(value, fallback, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    let candidate = Math.round(number);
    if (typeof min === "number") {
      candidate = Math.max(min, candidate);
    }
    if (typeof max === "number") {
      candidate = Math.min(max, candidate);
    }
    return candidate;
  }

  function toFloat(value, fallback, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    let candidate = number;
    if (typeof min === "number") {
      candidate = Math.max(min, candidate);
    }
    if (typeof max === "number") {
      candidate = Math.min(max, candidate);
    }
    return candidate;
  }

  defaults.pre_pad_ms = toInt(source.pre_pad_ms, defaults.pre_pad_ms, { min: 0, max: 60000 });
  defaults.post_pad_ms = toInt(source.post_pad_ms, defaults.post_pad_ms, { min: 0, max: 120000 });
  defaults.motion_release_padding_minutes = toFloat(
    source.motion_release_padding_minutes,
    defaults.motion_release_padding_minutes,
    { min: 0, max: 30 }
  );
  defaults.rms_threshold = toInt(source.rms_threshold, defaults.rms_threshold, { min: 0, max: 10000 });
  defaults.keep_window_frames = toInt(
    source.keep_window_frames,
    defaults.keep_window_frames,
    { min: 1, max: 2000 }
  );
  defaults.start_consecutive = toInt(
    source.start_consecutive,
    defaults.start_consecutive,
    { min: 1, max: 2000 }
  );
  defaults.keep_consecutive = toInt(
    source.keep_consecutive,
    defaults.keep_consecutive,
    { min: 1, max: 2000 }
  );
  defaults.flush_threshold_bytes = toInt(
    source.flush_threshold_bytes,
    defaults.flush_threshold_bytes,
    { min: 4096, max: 4 * 1024 * 1024 }
  );
  defaults.max_queue_frames = toInt(
    source.max_queue_frames,
    defaults.max_queue_frames,
    { min: 16, max: 4096 }
  );
  defaults.min_clip_seconds = toFloat(
    source.min_clip_seconds,
    defaults.min_clip_seconds,
    { min: 0, max: 600 }
  );

  defaults.use_rnnoise = parseBoolean(source.use_rnnoise);
  defaults.use_noisereduce = parseBoolean(source.use_noisereduce);
  defaults.denoise_before_vad = parseBoolean(source.denoise_before_vad);

  return defaults;
}

function canonicalSegmenterFromConfig(config) {
  const section = config && typeof config === "object" ? config.segmenter : null;
  return canonicalSegmenterSettings(section);
}

function adaptiveDefaults() {
  return {
    enabled: false,
    min_rms: null,
    min_thresh: 0.01,
    max_rms: null,
    max_thresh: 1,
    margin: 1.2,
    update_interval_sec: 5.0,
    window_sec: 10.0,
    hysteresis_tolerance: 0.1,
    release_percentile: 0.5,
    voiced_hold_sec: 6.0,
  };
}

function canonicalAdaptiveSettings(settings) {
  const defaults = adaptiveDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  function parseOptionalRms(value, fallback) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string" && value.trim() === "") {
      return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    const rounded = Math.round(number);
    if (rounded <= 0) {
      return null;
    }
    return Math.min(32767, rounded);
  }

  function clampFloat(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  defaults.min_thresh = clampFloat(source.min_thresh, defaults.min_thresh, 0, 1);
  defaults.max_thresh = clampFloat(source.max_thresh, defaults.max_thresh, 0, 1);
  defaults.max_rms = parseOptionalRms(source.max_rms, defaults.max_rms);
  defaults.min_rms = parseOptionalRms(source.min_rms, defaults.min_rms);
  defaults.margin = clampFloat(source.margin, defaults.margin, 0.5, 10);
  defaults.update_interval_sec = clampFloat(
    source.update_interval_sec,
    defaults.update_interval_sec,
    0.5,
    120
  );
  defaults.window_sec = clampFloat(source.window_sec, defaults.window_sec, 1, 300);
  defaults.hysteresis_tolerance = clampFloat(
    source.hysteresis_tolerance,
    defaults.hysteresis_tolerance,
    0,
    1
  );
  defaults.release_percentile = clampFloat(
    source.release_percentile,
    defaults.release_percentile,
    0.05,
    1
  );
  defaults.voiced_hold_sec = clampFloat(
    source.voiced_hold_sec,
    defaults.voiced_hold_sec,
    0,
    300
  );

  if (defaults.max_thresh < defaults.min_thresh) {
    defaults.max_thresh = defaults.min_thresh;
  }

  return defaults;
}

function canonicalAdaptiveFromConfig(config) {
  const section = config && typeof config === "object" ? config.adaptive_rms : null;
  return canonicalAdaptiveSettings(section);
}

function ingestDefaults() {
  return {
    stable_checks: 2,
    stable_interval_sec: 1.0,
    allowed_ext: [".wav", ".opus", ".flac", ".mp3"],
    ignore_suffixes: [".part", ".partial", ".tmp", ".incomplete", ".opdownload", ".crdownload"],
  };
}

function normalizeExtensionList(values, fallback) {
  const base = Array.isArray(fallback) ? fallback.slice() : [];
  if (!values) {
    return base;
  }
  const items = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    let candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!candidate.startsWith(".")) {
      candidate = `.${candidate}`;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      items.push(candidate);
    }
  }
  return items.length > 0 ? items : base;
}

function normalizeSuffixList(values, fallback) {
  const base = Array.isArray(fallback) ? fallback.slice() : [];
  if (!values) {
    return base;
  }
  const items = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    const candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      items.push(candidate);
    }
  }
  return items.length > 0 ? items : base;
}

function canonicalIngestSettings(settings) {
  const defaults = ingestDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  const stableChecks = Number(source.stable_checks);
  if (Number.isFinite(stableChecks)) {
    defaults.stable_checks = Math.max(1, Math.min(20, Math.round(stableChecks)));
  }

  const stableInterval = Number(source.stable_interval_sec);
  if (Number.isFinite(stableInterval)) {
    defaults.stable_interval_sec = Math.max(0.1, Math.min(30, stableInterval));
  }

  defaults.allowed_ext = normalizeExtensionList(source.allowed_ext, defaults.allowed_ext);
  defaults.ignore_suffixes = normalizeSuffixList(
    source.ignore_suffixes,
    defaults.ignore_suffixes
  );

  return defaults;
}

function canonicalIngestFromConfig(config) {
  const section = config && typeof config === "object" ? config.ingest : null;
  return canonicalIngestSettings(section);
}

function loggingDefaults() {
  return { dev_mode: false };
}

function canonicalLoggingSettings(settings) {
  const defaults = loggingDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  defaults.dev_mode = parseBoolean(source.dev_mode);
  return defaults;
}

function canonicalLoggingFromConfig(config) {
  const section = config && typeof config === "object" ? config.logging : null;
  return canonicalLoggingSettings(section);
}

function streamingDefaults() {
  return { mode: "hls", webrtc_history_seconds: 8.0 };
}

function canonicalStreamingSettings(settings) {
  const defaults = streamingDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  if (typeof source.mode === "string") {
    const candidate = source.mode.trim().toLowerCase();
    if (STREAMING_MODES.has(candidate)) {
      defaults.mode = candidate;
    }
  }

  const history = Number(source.webrtc_history_seconds);
  if (Number.isFinite(history)) {
    defaults.webrtc_history_seconds = Math.max(1, Math.min(600, history));
  }

  return defaults;
}

function canonicalStreamingFromConfig(config) {
  const section = config && typeof config === "object" ? config.streaming : null;
  return canonicalStreamingSettings(section);
}

function dashboardDefaults() {
  return { api_base: "" };
}

function canonicalDashboardSettings(settings) {
  const defaults = dashboardDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  if (typeof source.api_base === "string") {
    defaults.api_base = source.api_base.trim();
  }
  return defaults;
}

function canonicalDashboardFromConfig(config) {
  const section = config && typeof config === "object" ? config.dashboard : null;
  return canonicalDashboardSettings(section);
}

function transcriptionDefaults() {
  return {
    enabled: false,
    engine: "vosk",
    types: ["Human"],
    vosk_model_path: "/apps/tricorder/models/vosk-small-en-us-0.15",
    target_sample_rate: 16000,
    include_words: true,
    max_alternatives: 0,
  };
}

function canonicalTranscriptionSettings(settings) {
  const defaults = transcriptionDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  if (typeof source.engine === "string") {
    const candidate = source.engine.trim().toLowerCase();
    if (TRANSCRIPTION_ENGINES.has(candidate)) {
      defaults.engine = candidate;
    }
  }

  let rawTypes = [];
  if (Array.isArray(source.types)) {
    rawTypes = source.types;
  } else if (typeof source.types === "string") {
    rawTypes = parseListInput(source.types);
  }
  const normalizedTypes = [];
  for (const entry of rawTypes) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (!normalizedTypes.includes(trimmed)) {
      normalizedTypes.push(trimmed);
    }
  }
  if (normalizedTypes.length > 0) {
    defaults.types = normalizedTypes;
  }

  if (typeof source.vosk_model_path === "string") {
    const trimmed = source.vosk_model_path.trim();
    if (trimmed) {
      defaults.vosk_model_path = trimmed;
    }
  } else if (typeof source.model_path === "string") {
    const trimmed = source.model_path.trim();
    if (trimmed) {
      defaults.vosk_model_path = trimmed;
    }
  }

  const rate = Number(
    source.target_sample_rate !== undefined ? source.target_sample_rate : source.vosk_sample_rate
  );
  if (Number.isFinite(rate)) {
    const clamped = Math.max(8000, Math.min(96000, Math.round(rate)));
    defaults.target_sample_rate = clamped;
  }

  if (source.include_words !== undefined) {
    defaults.include_words = parseBoolean(source.include_words);
  }

  const alternatives = Number(source.max_alternatives);
  if (Number.isFinite(alternatives)) {
    defaults.max_alternatives = Math.max(0, Math.min(10, Math.round(alternatives)));
  }

  return defaults;
}

function canonicalTranscriptionFromConfig(config) {
  const section = config && typeof config === "object" ? config.transcription : null;
  return canonicalTranscriptionSettings(section);
}

function getRecorderSection(key) {
  const section = recorderState.sections.get(key);
  if (!section) {
    throw new Error(`Unknown recorder section: ${key}`);
  }
  return section;
}

function getRecorderSectionLabel(key) {
  if (typeof key !== "string" || !key) {
    return "section";
  }
  const safeKey = key.replace(/"/g, '\\"');
  const selector = `.recorder-section[data-section-key="${safeKey}"] .settings-section-title`;
  const heading = document.querySelector(selector);
  if (heading && heading.textContent) {
    return heading.textContent.trim();
  }
  return key.replace(/_/g, " ");
}

function setRecorderSaveAllStatus(text, state, options = {}) {
  const statusElement = recorderDom.saveAllStatus;
  if (!statusElement) {
    return;
  }

  if (recorderSaveAllState.statusTimeoutId) {
    window.clearTimeout(recorderSaveAllState.statusTimeoutId);
    recorderSaveAllState.statusTimeoutId = null;
  }

  const message = typeof text === "string" ? text : "";
  statusElement.textContent = message;
  if (state) {
    statusElement.dataset.state = state;
  } else if (statusElement.dataset.state) {
    delete statusElement.dataset.state;
  }
  statusElement.setAttribute("aria-hidden", message ? "false" : "true");

  if (!message || !options.autoHide) {
    return;
  }

  const duration = typeof options.duration === "number" ? Math.max(1000, options.duration) : 3200;
  recorderSaveAllState.statusTimeoutId = window.setTimeout(() => {
    recorderSaveAllState.statusTimeoutId = null;
    statusElement.textContent = "";
    if (statusElement.dataset.state) {
      delete statusElement.dataset.state;
    }
    statusElement.setAttribute("aria-hidden", "true");
  }, duration);
}

function getDirtyRecorderSectionKeys() {
  const dirty = [];
  for (const [key, section] of recorderState.sections.entries()) {
    if (section.state.dirty) {
      dirty.push(key);
    }
  }
  return dirty;
}

function updateSaveAllButtonState() {
  const button = recorderDom.saveAll;
  if (!button) {
    return;
  }
  const anySectionSaving = Array.from(recorderState.sections.values()).some((section) => section.state.saving);
  const dirtyKeys = getDirtyRecorderSectionKeys();
  const disable =
    recorderSaveAllState.saving ||
    anySectionSaving ||
    dirtyKeys.length === 0;

  button.disabled = disable;
  button.setAttribute("aria-busy", recorderSaveAllState.saving ? "true" : "false");
}

function setRecorderStatus(key, text, state, options = {}) {
  const section = getRecorderSection(key);
  const statusElement = section.options.status;
  if (!statusElement) {
    return;
  }
  if (section.state.statusTimeoutId) {
    window.clearTimeout(section.state.statusTimeoutId);
    section.state.statusTimeoutId = null;
  }

  const message = typeof text === "string" ? text : "";
  statusElement.textContent = message;
  if (state) {
    statusElement.dataset.state = state;
  } else if (statusElement.dataset.state) {
    delete statusElement.dataset.state;
  }
  statusElement.setAttribute("aria-hidden", message ? "false" : "true");

  if (message && options.autoHide) {
    const duration = typeof options.duration === "number" ? options.duration : 3200;
    section.state.statusTimeoutId = window.setTimeout(() => {
      section.state.statusTimeoutId = null;
      statusElement.textContent = "";
      if (statusElement.dataset.state) {
        delete statusElement.dataset.state;
      }
      statusElement.setAttribute("aria-hidden", "true");
    }, Math.max(1000, duration));
  }
}

function updateRecorderButtons(key) {
  const section = getRecorderSection(key);
  const { saveButton, resetButton, form } = section.options;
  if (saveButton) {
    saveButton.disabled = section.state.saving || !section.state.dirty;
  }
  if (resetButton) {
    const disableReset =
      section.state.saving ||
      (!section.state.dirty && !section.state.pendingSnapshot && !section.state.hasExternalUpdate);
    resetButton.disabled = disableReset;
  }
  if (form) {
    form.setAttribute("aria-busy", section.state.saving ? "true" : "false");
  }
  updateSaveAllButtonState();
}

function applyRecorderSectionData(key, data, { markPristine = false } = {}) {
  const section = getRecorderSection(key);
  if (typeof section.options.apply === "function") {
    section.options.apply(data);
  }
  section.state.current = data;
  if (markPristine) {
    section.state.lastAppliedFingerprint = JSON.stringify(data);
    section.state.dirty = false;
    section.state.pendingSnapshot = null;
    section.state.hasExternalUpdate = false;
  }
  updateRecorderButtons(key);
}

function markRecorderSectionDirty(key) {
  const section = getRecorderSection(key);
  if (section.state.saving) {
    return;
  }
  if (typeof section.options.read !== "function") {
    return;
  }
  const snapshot = section.options.read();
  const fingerprint = JSON.stringify(snapshot);
  const changed = fingerprint !== section.state.lastAppliedFingerprint;
  section.state.dirty = changed;
  if (changed) {
    setRecorderStatus(key, "Unsaved changes", "info");
  } else if (!section.state.hasExternalUpdate) {
    setRecorderStatus(key, "", null);
  }
  updateRecorderButtons(key);
}

function resetRecorderSection(key) {
  const section = getRecorderSection(key);
  if (section.state.saving) {
    return;
  }
  if (section.state.pendingSnapshot) {
    applyRecorderSectionData(key, section.state.pendingSnapshot, { markPristine: true });
    setRecorderStatus(key, "Loaded updated settings from disk.", "info", { autoHide: true, duration: 2500 });
    section.state.pendingSnapshot = null;
    section.state.hasExternalUpdate = false;
    return;
  }
  if (section.state.current) {
    applyRecorderSectionData(key, section.state.current, { markPristine: true });
    setRecorderStatus(key, "Reverted unsaved changes.", "info", { autoHide: true, duration: 2200 });
  }
}

async function saveAllRecorderSections() {
  if (recorderSaveAllState.saving) {
    return;
  }
  const dirtyKeys = getDirtyRecorderSectionKeys();
  if (dirtyKeys.length === 0) {
    return;
  }

  recorderSaveAllState.saving = true;
  updateSaveAllButtonState();
  setRecorderSaveAllStatus("Saving all changes…", "pending");

  const failures = [];
  for (const key of dirtyKeys) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await saveRecorderSection(key);
    if (!ok) {
      failures.push(key);
    }
  }

  recorderSaveAllState.saving = false;
  updateSaveAllButtonState();

  if (failures.length === 0) {
    setRecorderSaveAllStatus("Saved all pending changes.", "success", { autoHide: true, duration: 3600 });
    return;
  }

  const labels = failures.map((key) => getRecorderSectionLabel(key)).join(", ");
  if (failures.length === dirtyKeys.length) {
    setRecorderSaveAllStatus("Unable to save any sections. Check the errors above.", "error");
  } else {
    setRecorderSaveAllStatus(`Saved some changes, but ${labels} failed. Check the errors above.`, "warning");
  }
}

function summariseRestartResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { message: "Saved changes.", state: "success" };
  }
  const summary = [];
  let hasFailure = false;
  for (const entry of results) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const unit = typeof entry.unit === "string" && entry.unit ? entry.unit : "service";
    const ok = entry.ok !== false;
    hasFailure = hasFailure || !ok;
    summary.push(`${unit}${ok ? "" : " (failed)"}`);
  }
  const joined = summary.length > 0 ? summary.join(", ") : "services";
