export function createRecorderConfigUi(deps) {
  const {
    state,
    dom,
    recorderState,
    recorderDom,
    recorderDialogState,
    configDialogState,
    servicesDialogState,
    transcriptionModelState,
    apiClient,
    lockDocumentScroll,
    unlockDocumentScroll,
    suspendAutoRefresh,
    resumeAutoRefresh,
    fetchConfig,
    fetchServices,
    startServicesRefresh,
    stopServicesRefresh,
    getRecorderSection,
    applyRecorderSectionData,
    setRecorderStatus,
    updateRecorderButtons,
    fetchRecorderSection,
    saveRecorderSection,
    markRecorderSectionDirty,
    resetRecorderSection,
    firstRecorderSectionKey,
    setActiveRecorderSection,
    updateAudioFilterControls,
    audioDefaults,
    canonicalAudioSettings,
    canonicalAudioFromConfig,
    segmenterDefaults,
    canonicalSegmenterSettings,
    canonicalSegmenterFromConfig,
    adaptiveDefaults,
    canonicalAdaptiveSettings,
    canonicalAdaptiveFromConfig,
    ingestDefaults,
    canonicalIngestSettings,
    canonicalIngestFromConfig,
    transcriptionDefaults,
    canonicalTranscriptionSettings,
    canonicalTranscriptionFromConfig,
    loggingDefaults,
    canonicalLoggingSettings,
    canonicalLoggingFromConfig,
    pathsDefaults,
    canonicalPathsSettings,
    canonicalPathsFromConfig,
    notificationsDefaults,
    canonicalNotificationsSettings,
    canonicalNotificationsFromConfig,
    streamingDefaults,
    canonicalStreamingSettings,
    canonicalStreamingFromConfig,
    dashboardDefaults,
    canonicalDashboardSettings,
    canonicalDashboardFromConfig,
    parseListInput,
  } = deps;

  function setTextFieldValue(input, value) {
    if (!input) {
      return;
    }
    if (value === null || value === undefined) {
      input.value = "";
      return;
    }
    input.value = String(value);
  }

  function setCheckboxValue(input, value) {
    if (!input) {
      return;
    }
    input.checked = Boolean(value);
  }

  function getNumberInputValue(input) {
    if (!input) {
      return undefined;
    }
    const raw = input.value != null ? String(input.value).trim() : "";
    if (!raw) {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function parseHeaderTextarea(text) {
    if (typeof text !== "string") {
      return {};
    }
    const headers = {};
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.indexOf(":");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!key) {
        continue;
      }
      headers[key] = value;
    }
    return headers;
  }

  function formatHeaderTextarea(headers) {
    if (!headers || typeof headers !== "object") {
      return "";
    }
    const entries = Object.entries(headers);
    if (!entries.length) {
      return "";
    }
    return entries
      .filter(([key]) => typeof key === "string" && key.trim())
      .map(([key, value]) => {
        const headerValue =
          typeof value === "string" ? value.trim() : String(value ?? "").trim();
        return `${key.trim()}: ${headerValue}`;
      })
      .join("\n");
  }

  function handleRecorderConfigSnapshot(key, canonical) {
    const section = getRecorderSection(key);
    const fingerprint = JSON.stringify(canonical);
    section.state.current = canonical;

    if (!section.state.loaded && !section.state.saving) {
      applyRecorderSectionData(key, canonical, { markPristine: true });
      section.state.loaded = true;
      return;
    }

    if (fingerprint === section.state.lastAppliedFingerprint) {
      if (!section.state.dirty && !section.state.saving) {
        applyRecorderSectionData(key, canonical, { markPristine: true });
      }
      return;
    }

    if (!section.state.dirty && !section.state.saving) {
      applyRecorderSectionData(key, canonical, { markPristine: true });
      return;
    }

    section.state.pendingSnapshot = canonical;
    section.state.hasExternalUpdate = true;
    setRecorderStatus(key, "Updated on disk. Reset to load changes.", "info");
    updateRecorderButtons(key);
  }

  function updateRecorderConfigPath(path) {
    if (typeof path !== "string") {
      return;
    }
    recorderState.configPath = path;
    if (recorderDom.configPath) {
      recorderDom.configPath.textContent = path || "(unknown)";
    }
    if (dom.configPathLabel) {
      dom.configPathLabel.textContent = path || "(unknown)";
    }
  }

  function ensureRecorderSectionsLoaded() {
    if (recorderState.loadingPromise) {
      return recorderState.loadingPromise;
    }
    const keys = Array.from(recorderState.sections.keys());
    if (keys.length === 0) {
      recorderState.loaded = true;
      return Promise.resolve();
    }

    for (const key of keys) {
      setRecorderStatus(key, "Loading settings…", "pending");
    }

    const promise = Promise.all(keys.map((key) => fetchRecorderSection(key)))
      .catch((error) => {
        console.error("Failed to load recorder settings", error);
      })
      .finally(() => {
        recorderState.loadingPromise = null;
        recorderState.loaded = true;
      });

    recorderState.loadingPromise = promise;
    return promise;
  }

  function registerRecorderSection(options) {
    const {
      key,
      endpoint,
      defaults = () => ({}),
      fromConfig,
      fromResponse,
      read,
      apply,
      form,
      saveButton,
      resetButton,
      status,
    } = options;

    if (!key) {
      return;
    }

    const section = {
      options: {
        key,
        endpoint,
        defaults,
        fromConfig,
        fromResponse,
        read,
        apply,
        form,
        saveButton,
        resetButton,
        status,
      },
      state: {
        key,
        current: defaults(),
        lastAppliedFingerprint: "",
        dirty: false,
        saving: false,
        loaded: false,
        pendingSnapshot: null,
        hasExternalUpdate: false,
        statusTimeoutId: null,
      },
    };

    recorderState.sections.set(key, section);

    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveRecorderSection(key);
      });
      form.addEventListener("input", () => {
        markRecorderSectionDirty(key);
      });
      form.addEventListener("change", () => {
        markRecorderSectionDirty(key);
      });
      form.setAttribute("novalidate", "novalidate");
    }

    if (resetButton) {
      resetButton.addEventListener("click", () => {
        resetRecorderSection(key);
      });
    }

    updateRecorderButtons(key);
  }

  function registerRecorderSections() {
    if (!recorderDom.sections) {
      return;
    }

    const definitions = [
      {
        key: "audio",
        dom: recorderDom.sections.audio,
        endpoint: "/api/config/audio",
        defaults: audioDefaults,
        fromConfig: canonicalAudioFromConfig,
        fromResponse: (payload) => canonicalAudioSettings(payload ? payload.audio : null),
        read: readAudioForm,
        apply: applyAudioForm,
      },
      {
        key: "paths",
        dom: recorderDom.sections.paths,
        endpoint: "/api/config/paths",
        defaults: pathsDefaults,
        fromConfig: canonicalPathsFromConfig,
        fromResponse: (payload) =>
          canonicalPathsSettings(payload ? payload.paths : null),
        read: readPathsForm,
        apply: applyPathsForm,
      },
      {
        key: "segmenter",
        dom: recorderDom.sections.segmenter,
        endpoint: "/api/config/segmenter",
        defaults: segmenterDefaults,
        fromConfig: canonicalSegmenterFromConfig,
        fromResponse: (payload) =>
          canonicalSegmenterSettings(payload ? payload.segmenter : null),
        read: readSegmenterForm,
        apply: applySegmenterForm,
      },
      {
        key: "adaptive_rms",
        dom: recorderDom.sections.adaptive_rms,
        endpoint: "/api/config/adaptive-rms",
        defaults: adaptiveDefaults,
        fromConfig: canonicalAdaptiveFromConfig,
        fromResponse: (payload) =>
          canonicalAdaptiveSettings(payload ? payload.adaptive_rms : null),
        read: readAdaptiveForm,
        apply: applyAdaptiveForm,
      },
      {
        key: "ingest",
        dom: recorderDom.sections.ingest,
        endpoint: "/api/config/ingest",
        defaults: ingestDefaults,
        fromConfig: canonicalIngestFromConfig,
        fromResponse: (payload) => canonicalIngestSettings(payload ? payload.ingest : null),
        read: readIngestForm,
        apply: applyIngestForm,
      },
      {
        key: "transcription",
        dom: recorderDom.sections.transcription,
        endpoint: "/api/config/transcription",
        defaults: transcriptionDefaults,
        fromConfig: canonicalTranscriptionFromConfig,
        fromResponse: (payload) =>
          canonicalTranscriptionSettings(payload ? payload.transcription : null),
        read: readTranscriptionForm,
        apply: applyTranscriptionForm,
      },
      {
        key: "logging",
        dom: recorderDom.sections.logging,
        endpoint: "/api/config/logging",
        defaults: loggingDefaults,
        fromConfig: canonicalLoggingFromConfig,
        fromResponse: (payload) => canonicalLoggingSettings(payload ? payload.logging : null),
        read: readLoggingForm,
        apply: applyLoggingForm,
      },
      {
        key: "notifications",
        dom: recorderDom.sections.notifications,
        endpoint: "/api/config/notifications",
        defaults: notificationsDefaults,
        fromConfig: canonicalNotificationsFromConfig,
        fromResponse: (payload) =>
          canonicalNotificationsSettings(payload ? payload.notifications : null),
        read: readNotificationsForm,
        apply: applyNotificationsForm,
      },
      {
        key: "streaming",
        dom: recorderDom.sections.streaming,
        endpoint: "/api/config/streaming",
        defaults: streamingDefaults,
        fromConfig: canonicalStreamingFromConfig,
        fromResponse: (payload) =>
          canonicalStreamingSettings(payload ? payload.streaming : null),
        read: readStreamingForm,
        apply: applyStreamingForm,
      },
      {
        key: "dashboard",
        dom: recorderDom.sections.dashboard,
        endpoint: "/api/config/dashboard",
        defaults: dashboardDefaults,
        fromConfig: canonicalDashboardFromConfig,
        fromResponse: (payload) =>
          canonicalDashboardSettings(payload ? payload.dashboard : null),
        read: readDashboardForm,
        apply: applyDashboardForm,
      },
    ];

    for (const definition of definitions) {
      const domRefs = definition.dom;
      if (!domRefs || !domRefs.form) {
        continue;
      }
      registerRecorderSection({
        key: definition.key,
        endpoint: definition.endpoint,
        defaults: definition.defaults,
        fromConfig: definition.fromConfig,
        fromResponse: definition.fromResponse,
        read: definition.read,
        apply: definition.apply,
        form: domRefs.form,
        saveButton: domRefs.save,
        resetButton: domRefs.reset,
        status: domRefs.status,
      });
    }

    if (!recorderDialogState.activeSection) {
      const first = firstRecorderSectionKey();
      if (first) {
        setActiveRecorderSection(first);
      }
    } else {
      setActiveRecorderSection(recorderDialogState.activeSection);
    }
  }

  function applyAudioForm(data) {
    const section = recorderDom.sections.audio;
    if (!section) {
      return;
    }
    if (section.device) {
      section.device.value = data.device ?? "";
    }
    if (section.sampleRate) {
      section.sampleRate.value = String(data.sample_rate);
    }
    if (section.channels) {
      section.channels.value = String(data.channels ?? 1);
    }
    if (section.frameMs) {
      section.frameMs.value = String(data.frame_ms);
    }
    if (section.gain) {
      section.gain.value = String(data.gain);
    }
    if (section.vad) {
      section.vad.value = String(data.vad_aggressiveness);
    }
    if (section.usbReset) {
      section.usbReset.checked = data.usb_reset_workaround !== false;
    }
    const filters =
      data && typeof data === "object" && data.filter_chain ? data.filter_chain : {};
    const calibration =
      data && typeof data === "object" && data.calibration ? data.calibration : {};
    if (section.filterDenoiseEnabled) {
      section.filterDenoiseEnabled.checked = Boolean(
        filters.denoise && filters.denoise.enabled,
      );
    }
    if (section.filterDenoiseType && filters.denoise && typeof filters.denoise.type === "string") {
      section.filterDenoiseType.value = filters.denoise.type;
    }
    if (
      section.filterDenoiseFloor &&
      filters.denoise &&
      typeof filters.denoise.noise_floor_db === "number"
    ) {
      section.filterDenoiseFloor.value = String(filters.denoise.noise_floor_db);
    }
    if (section.filterHighpassEnabled) {
      section.filterHighpassEnabled.checked = Boolean(
        filters.highpass && filters.highpass.enabled,
      );
    }
    if (
      section.filterHighpassCutoff &&
      filters.highpass &&
      typeof filters.highpass.cutoff_hz === "number"
    ) {
      section.filterHighpassCutoff.value = String(filters.highpass.cutoff_hz);
    }
    if (section.filterLowpassEnabled) {
      section.filterLowpassEnabled.checked = Boolean(
        filters.lowpass && filters.lowpass.enabled,
      );
    }
    if (
      section.filterLowpassCutoff &&
      filters.lowpass &&
      typeof filters.lowpass.cutoff_hz === "number"
    ) {
      section.filterLowpassCutoff.value = String(filters.lowpass.cutoff_hz);
    }
    if (section.filterNotchEnabled) {
      section.filterNotchEnabled.checked = Boolean(
        filters.notch && filters.notch.enabled,
      );
    }
    if (
      section.filterNotchFrequency &&
      filters.notch &&
      typeof filters.notch.freq_hz === "number"
    ) {
      section.filterNotchFrequency.value = String(filters.notch.freq_hz);
    }
    if (
      section.filterNotchQuality &&
      filters.notch &&
      typeof filters.notch.quality === "number"
    ) {
      section.filterNotchQuality.value = String(filters.notch.quality);
    }
    if (section.filterSpectralGateEnabled) {
      section.filterSpectralGateEnabled.checked = Boolean(
        filters.spectral_gate && filters.spectral_gate.enabled,
      );
    }
    if (
      section.filterSpectralGateSensitivity &&
      filters.spectral_gate &&
      typeof filters.spectral_gate.sensitivity === "number"
    ) {
      section.filterSpectralGateSensitivity.value = String(filters.spectral_gate.sensitivity);
    }
    if (
      section.filterSpectralGateReduction &&
      filters.spectral_gate &&
      typeof filters.spectral_gate.reduction_db === "number"
    ) {
      section.filterSpectralGateReduction.value = String(filters.spectral_gate.reduction_db);
    }
    if (
      section.filterSpectralGateNoiseUpdate &&
      filters.spectral_gate &&
      typeof filters.spectral_gate.noise_update === "number"
    ) {
      section.filterSpectralGateNoiseUpdate.value = String(filters.spectral_gate.noise_update);
    }
    if (
      section.filterSpectralGateNoiseDecay &&
      filters.spectral_gate &&
      typeof filters.spectral_gate.noise_decay === "number"
    ) {
      section.filterSpectralGateNoiseDecay.value = String(filters.spectral_gate.noise_decay);
    }
    if (section.calibrationNoise) {
      section.calibrationNoise.checked = Boolean(calibration.auto_noise_profile);
    }
    if (section.calibrationGain) {
      section.calibrationGain.checked = Boolean(calibration.auto_gain);
    }
    updateAudioFilterControls();
  }

  function readAudioForm() {
    const section = recorderDom.sections.audio;
    if (!section) {
      return audioDefaults();
    }
    const payload = {
      device: section.device ? section.device.value : "",
      sample_rate: section.sampleRate ? Number(section.sampleRate.value) : undefined,
      channels: section.channels ? Number(section.channels.value) : undefined,
      frame_ms: section.frameMs ? Number(section.frameMs.value) : undefined,
      gain: section.gain ? Number(section.gain.value) : undefined,
      vad_aggressiveness: section.vad ? Number(section.vad.value) : undefined,
      usb_reset_workaround: section.usbReset ? section.usbReset.checked : undefined,
      filter_chain: {
        denoise: {
          enabled: section.filterDenoiseEnabled ? section.filterDenoiseEnabled.checked : false,
          type: section.filterDenoiseType ? section.filterDenoiseType.value : undefined,
          noise_floor_db: section.filterDenoiseFloor
            ? Number(section.filterDenoiseFloor.value)
            : undefined,
        },
        highpass: {
          enabled: section.filterHighpassEnabled ? section.filterHighpassEnabled.checked : false,
          cutoff_hz: section.filterHighpassCutoff
            ? Number(section.filterHighpassCutoff.value)
            : undefined,
        },
        lowpass: {
          enabled: section.filterLowpassEnabled ? section.filterLowpassEnabled.checked : false,
          cutoff_hz: section.filterLowpassCutoff
            ? Number(section.filterLowpassCutoff.value)
            : undefined,
        },
        notch: {
          enabled: section.filterNotchEnabled ? section.filterNotchEnabled.checked : false,
          freq_hz: section.filterNotchFrequency
            ? Number(section.filterNotchFrequency.value)
            : undefined,
          quality: section.filterNotchQuality
            ? Number(section.filterNotchQuality.value)
            : undefined,
        },
        spectral_gate: {
          enabled: section.filterSpectralGateEnabled
            ? section.filterSpectralGateEnabled.checked
            : false,
          sensitivity: section.filterSpectralGateSensitivity
            ? Number(section.filterSpectralGateSensitivity.value)
            : undefined,
          reduction_db: section.filterSpectralGateReduction
            ? Number(section.filterSpectralGateReduction.value)
            : undefined,
          noise_update: section.filterSpectralGateNoiseUpdate
            ? Number(section.filterSpectralGateNoiseUpdate.value)
            : undefined,
          noise_decay: section.filterSpectralGateNoiseDecay
            ? Number(section.filterSpectralGateNoiseDecay.value)
            : undefined,
        },
      },
      calibration: {
        auto_noise_profile: section.calibrationNoise ? section.calibrationNoise.checked : false,
        auto_gain: section.calibrationGain ? section.calibrationGain.checked : false,
      },
    };
    return canonicalAudioSettings(payload);
  }

  function applySegmenterForm(data) {
    const section = recorderDom.sections.segmenter;
    if (!section) {
      return;
    }
    const settings = canonicalSegmenterSettings(data);
    setTextFieldValue(section.prePad, settings.pre_pad_ms);
    setTextFieldValue(section.postPad, settings.post_pad_ms);
    setTextFieldValue(
      section.motionPaddingMinutes,
      settings.motion_release_padding_minutes,
    );
    setTextFieldValue(section.threshold, settings.rms_threshold);
    setCheckboxValue(section.rmsTrigger, settings.enable_rms_trigger);
    setCheckboxValue(section.vadTrigger, settings.enable_vad_trigger);
    setTextFieldValue(section.keepWindow, settings.keep_window_frames);
    setTextFieldValue(section.startConsecutive, settings.start_consecutive);
    setTextFieldValue(section.keepConsecutive, settings.keep_consecutive);
    setTextFieldValue(section.autosplitMinutes, settings.autosplit_interval_minutes);
    setCheckboxValue(section.autoRecordMotion, settings.auto_record_motion_override);
    setTextFieldValue(section.flushBytes, settings.flush_threshold_bytes);
    setTextFieldValue(section.maxQueue, settings.max_queue_frames);
    setTextFieldValue(section.minClipSeconds, settings.min_clip_seconds);
    setTextFieldValue(section.maxPending, settings.max_pending_encodes);
    setTextFieldValue(section.filterAvgBudget, settings.filter_chain_avg_budget_ms);
    setTextFieldValue(section.filterPeakBudget, settings.filter_chain_peak_budget_ms);
    setTextFieldValue(section.filterMetricsWindow, settings.filter_chain_metrics_window);
    setTextFieldValue(section.filterLogThrottle, settings.filter_chain_log_throttle_sec);
    setCheckboxValue(section.streamingEncode, settings.streaming_encode);
    if (section.streamingContainer) {
      const container =
        typeof settings.streaming_encode_container === "string"
          ? settings.streaming_encode_container
          : "";
      section.streamingContainer.value = container;
    }
    const parallel =
      settings.parallel_encode && typeof settings.parallel_encode === "object"
        ? settings.parallel_encode
        : segmenterDefaults().parallel_encode;
    setCheckboxValue(section.parallelEnabled, parallel.enabled);
    setTextFieldValue(section.parallelLoad, parallel.load_avg_per_cpu);
    setTextFieldValue(section.parallelMinSeconds, parallel.min_event_seconds);
    setTextFieldValue(section.parallelCpuInterval, parallel.cpu_check_interval_sec);
    setTextFieldValue(section.parallelMaxWorkers, parallel.offline_max_workers);
    setTextFieldValue(section.parallelOfflineLoad, parallel.offline_load_avg_per_cpu);
    setTextFieldValue(
      section.parallelOfflineInterval,
      parallel.offline_cpu_check_interval_sec,
    );
    setTextFieldValue(section.parallelBuckets, parallel.live_waveform_buckets);
    setTextFieldValue(
      section.parallelUpdateInterval,
      parallel.live_waveform_update_interval_sec,
    );

    const eventTags =
      settings.event_tags && typeof settings.event_tags === "object"
        ? settings.event_tags
        : {};
    setTextFieldValue(section.eventTagHuman, eventTags.human);
    setTextFieldValue(section.eventTagOther, eventTags.other);
    setTextFieldValue(section.eventTagBoth, eventTags.both);

    setCheckboxValue(section.useRnnoise, settings.use_rnnoise);
    setCheckboxValue(section.useNoisereduce, settings.use_noisereduce);
    setCheckboxValue(section.denoiseBeforeVad, settings.denoise_before_vad);
  }

  function readSegmenterForm() {
    const section = recorderDom.sections.segmenter;
    if (!section) {
      return segmenterDefaults();
    }
    const payload = {
      pre_pad_ms: getNumberInputValue(section.prePad),
      post_pad_ms: getNumberInputValue(section.postPad),
      motion_release_padding_minutes: getNumberInputValue(section.motionPaddingMinutes),
      rms_threshold: getNumberInputValue(section.threshold),
      keep_window_frames: getNumberInputValue(section.keepWindow),
      start_consecutive: getNumberInputValue(section.startConsecutive),
      keep_consecutive: getNumberInputValue(section.keepConsecutive),
      autosplit_interval_minutes: getNumberInputValue(section.autosplitMinutes),
      auto_record_motion_override: section.autoRecordMotion
        ? section.autoRecordMotion.checked
        : false,
      enable_rms_trigger: section.rmsTrigger
        ? section.rmsTrigger.checked
        : true,
      enable_vad_trigger: section.vadTrigger
        ? section.vadTrigger.checked
        : true,
      flush_threshold_bytes: getNumberInputValue(section.flushBytes),
      max_queue_frames: getNumberInputValue(section.maxQueue),
      min_clip_seconds: getNumberInputValue(section.minClipSeconds),
      max_pending_encodes: getNumberInputValue(section.maxPending),
      filter_chain_avg_budget_ms: getNumberInputValue(section.filterAvgBudget),
      filter_chain_peak_budget_ms: getNumberInputValue(section.filterPeakBudget),
      filter_chain_metrics_window: getNumberInputValue(section.filterMetricsWindow),
      filter_chain_log_throttle_sec: getNumberInputValue(section.filterLogThrottle),
      streaming_encode: section.streamingEncode ? section.streamingEncode.checked : false,
      streaming_encode_container: section.streamingContainer
        ? section.streamingContainer.value
        : undefined,
      parallel_encode: {
        enabled: section.parallelEnabled ? section.parallelEnabled.checked : false,
        load_avg_per_cpu: getNumberInputValue(section.parallelLoad),
        min_event_seconds: getNumberInputValue(section.parallelMinSeconds),
        cpu_check_interval_sec: getNumberInputValue(section.parallelCpuInterval),
        offline_max_workers: getNumberInputValue(section.parallelMaxWorkers),
        offline_load_avg_per_cpu: getNumberInputValue(section.parallelOfflineLoad),
        offline_cpu_check_interval_sec: getNumberInputValue(section.parallelOfflineInterval),
        live_waveform_buckets: getNumberInputValue(section.parallelBuckets),
        live_waveform_update_interval_sec: getNumberInputValue(section.parallelUpdateInterval),
      },
      event_tags: {
        human: section.eventTagHuman ? section.eventTagHuman.value.trim() : "",
        other: section.eventTagOther ? section.eventTagOther.value.trim() : "",
        both: section.eventTagBoth ? section.eventTagBoth.value.trim() : "",
      },
      use_rnnoise: section.useRnnoise ? section.useRnnoise.checked : false,
      use_noisereduce: section.useNoisereduce ? section.useNoisereduce.checked : false,
      denoise_before_vad: section.denoiseBeforeVad ? section.denoiseBeforeVad.checked : false,
    };
    return canonicalSegmenterSettings(payload);
  }

  function applyAdaptiveForm(data) {
    const section = recorderDom.sections.adaptive_rms;
    if (!section) {
      return;
    }
    const mapping = [
      [section.enabled, data.enabled, "checked"],
      [section.minRms, data.min_rms],
      [section.minThresh, data.min_thresh],
      [section.maxRms, data.max_rms],
      [section.margin, data.margin],
      [section.updateInterval, data.update_interval_sec],
      [section.window, data.window_sec],
      [section.hysteresis, data.hysteresis_tolerance],
      [section.release, data.release_percentile],
      [section.voicedHold, data.voiced_hold_sec],
    ];
    for (const [input, value, mode] of mapping) {
      if (!input) {
        continue;
      }
      if (mode === "checked") {
        input.checked = Boolean(value);
        continue;
      }
      if (value === null || value === undefined) {
        input.value = "";
        continue;
      }
      input.value = String(value);
    }
  }

  function readAdaptiveForm() {
    const section = recorderDom.sections.adaptive_rms;
    if (!section) {
      return adaptiveDefaults();
    }

    function numberFromInput(input) {
      if (!input) {
        return undefined;
      }
      const trimmed = input.value != null ? String(input.value).trim() : "";
      if (!trimmed) {
        return undefined;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    const payload = {
      enabled: section.enabled ? section.enabled.checked : false,
      min_rms: numberFromInput(section.minRms),
      min_thresh: numberFromInput(section.minThresh),
      max_rms: numberFromInput(section.maxRms),
      margin: numberFromInput(section.margin),
      update_interval_sec: numberFromInput(section.updateInterval),
      window_sec: numberFromInput(section.window),
      hysteresis_tolerance: numberFromInput(section.hysteresis),
      release_percentile: numberFromInput(section.release),
      voiced_hold_sec: numberFromInput(section.voicedHold),
    };
    return canonicalAdaptiveSettings(payload);
  }

  function applyIngestForm(data) {
    const section = recorderDom.sections.ingest;
    if (!section) {
      return;
    }
    if (section.stableChecks) {
      section.stableChecks.value = data.stable_checks != null ? String(data.stable_checks) : "";
    }
    if (section.stableInterval) {
      section.stableInterval.value =
        data.stable_interval_sec != null ? String(data.stable_interval_sec) : "";
    }
    if (section.allowedExt) {
      section.allowedExt.value = Array.isArray(data.allowed_ext)
        ? data.allowed_ext.join("\n")
        : typeof data.allowed_ext === "string"
        ? data.allowed_ext
        : "";
    }
    if (section.ignoreSuffixes) {
      section.ignoreSuffixes.value = Array.isArray(data.ignore_suffixes)
        ? data.ignore_suffixes.join("\n")
        : typeof data.ignore_suffixes === "string"
        ? data.ignore_suffixes
        : "";
    }
  }

  function readIngestForm() {
    const section = recorderDom.sections.ingest;
    if (!section) {
      return ingestDefaults();
    }

    function numberFromInput(input) {
      if (!input) {
        return undefined;
      }
      const trimmed = input.value != null ? String(input.value).trim() : "";
      if (!trimmed) {
        return undefined;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    const payload = {
      stable_checks: numberFromInput(section.stableChecks),
      stable_interval_sec: numberFromInput(section.stableInterval),
      allowed_ext: section.allowedExt ? section.allowedExt.value : undefined,
      ignore_suffixes: section.ignoreSuffixes ? section.ignoreSuffixes.value : undefined,
    };
    return canonicalIngestSettings(payload);
  }

  function applyTranscriptionForm(data) {
    const section = recorderDom.sections.transcription;
    if (!section) {
      return;
    }
    if (section.enabled) {
      section.enabled.checked = Boolean(data.enabled);
    }
    if (section.engine) {
      section.engine.value = data.engine ?? "vosk";
    }
    if (section.types) {
      const entries = Array.isArray(data.types) ? data.types : [];
      section.types.value = entries.join("\n");
    }
    if (section.modelPath) {
      section.modelPath.value = data.vosk_model_path ?? "";
    }
    if (section.targetSampleRate) {
      section.targetSampleRate.value = String(data.target_sample_rate);
    }
    if (section.includeWords) {
      section.includeWords.checked = Boolean(data.include_words);
    }
    if (section.maxAlternatives) {
      section.maxAlternatives.value = String(data.max_alternatives);
    }
  }

  function readTranscriptionForm() {
    const section = recorderDom.sections.transcription;
    if (!section) {
      return transcriptionDefaults();
    }
    const payload = {
      enabled: section.enabled ? section.enabled.checked : false,
      engine: section.engine ? section.engine.value : undefined,
      types: section.types ? section.types.value : undefined,
      vosk_model_path: section.modelPath ? section.modelPath.value : undefined,
      target_sample_rate: section.targetSampleRate
        ? Number(section.targetSampleRate.value)
        : undefined,
      include_words: section.includeWords ? section.includeWords.checked : false,
      max_alternatives: section.maxAlternatives
        ? Number(section.maxAlternatives.value)
        : undefined,
    };
    return canonicalTranscriptionSettings(payload);
  }

  function setTranscriptionModelStatus(message, stateValue = "info") {
    const section = recorderDom.sections.transcription;
    const element =
      section && section.modelStatus instanceof HTMLElement ? section.modelStatus : null;
    if (!element) {
      return;
    }
    if (message) {
      element.textContent = message;
      element.dataset.state = stateValue;
      element.setAttribute("aria-hidden", "false");
    } else {
      element.textContent = "";
      delete element.dataset.state;
      element.setAttribute("aria-hidden", "true");
    }
  }

  function setTranscriptionModelLoading(loading) {
    const section = recorderDom.sections.transcription;
    if (!section || !(section.modelRefresh instanceof HTMLButtonElement)) {
      return;
    }
    section.modelRefresh.disabled = Boolean(loading);
    section.modelRefresh.setAttribute("aria-busy", loading ? "true" : "false");
  }

  function hideTranscriptionModelDiscovery() {
    const section = recorderDom.sections.transcription;
    if (!section) {
      return;
    }
    if (section.modelOptions instanceof HTMLSelectElement) {
      section.modelOptions.innerHTML = "";
    }
    if (section.modelDiscovery instanceof HTMLElement) {
      section.modelDiscovery.hidden = true;
    }
  }

  function showTranscriptionModelDiscovery(models, configuredPath = "") {
    const section = recorderDom.sections.transcription;
    if (!section || !(section.modelOptions instanceof HTMLSelectElement)) {
      return;
    }

    section.modelOptions.innerHTML = "";
    const entries = Array.isArray(models) ? models : [];
    let selectedValue = "";
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const path = typeof entry.path === "string" ? entry.path : "";
      if (!path) {
        continue;
      }
      const label =
        typeof entry.label === "string" && entry.label
          ? entry.label
          : typeof entry.name === "string" && entry.name
          ? entry.name
          : path;
      if (!label) {
        continue;
      }
      const option = document.createElement("option");
      option.value = path;
      option.textContent = label;
      if (typeof entry.language === "string" && entry.language) {
        option.dataset.language = entry.language;
      }
      section.modelOptions.append(option);
      if (!selectedValue && typeof configuredPath === "string" && configuredPath === path) {
        selectedValue = path;
      }
    }

    if (section.modelDiscovery instanceof HTMLElement) {
      section.modelDiscovery.hidden = section.modelOptions.options.length === 0;
    }

    if (section.modelOptions.options.length > 0) {
      section.modelOptions.value = selectedValue || section.modelOptions.options[0].value;
    }
  }

  function applySelectedTranscriptionModel() {
    const section = recorderDom.sections.transcription;
    if (!section) {
      return;
    }
    if (
      !(section.modelOptions instanceof HTMLSelectElement) ||
      !(section.modelPath instanceof HTMLInputElement)
    ) {
      return;
    }
    const value = section.modelOptions.value;
    if (!value) {
      return;
    }
    section.modelPath.value = value;
    markRecorderSectionDirty("transcription");
    const selected = transcriptionModelState.models.find(
      (entry) => entry && entry.path === value,
    );
    if (selected && selected.label) {
      setTranscriptionModelStatus(`Selected ${selected.label}.`, "info");
    } else {
      setTranscriptionModelStatus("Updated model path from detected entry.", "info");
    }
    try {
      section.modelPath.focus({ preventScroll: true });
    } catch (error) {
      /* ignore focus errors */
    }
  }

  async function refreshTranscriptionModels() {
    if (transcriptionModelState.loading) {
      return;
    }
    const section = recorderDom.sections.transcription;
    if (!section) {
      return;
    }

    transcriptionModelState.loading = true;
    setTranscriptionModelLoading(true);
    hideTranscriptionModelDiscovery();
    setTranscriptionModelStatus("Scanning for installed models…", "pending");

    try {
      const response = await apiClient.fetch("/api/transcription/models", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const payload = await response.json();
      const models = Array.isArray(payload?.models) ? payload.models : [];
      const sanitized = [];
      for (const entry of models) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const path = typeof entry.path === "string" ? entry.path : "";
        if (!path) {
          continue;
        }
        const label =
          typeof entry.label === "string" && entry.label
            ? entry.label
            : typeof entry.name === "string" && entry.name
            ? entry.name
            : path;
        const language =
          typeof entry.language === "string" && entry.language ? entry.language : null;
        sanitized.push({ path, label, language });
      }

      transcriptionModelState.models = sanitized;
      const configuredPath =
        typeof payload?.configured_path === "string" ? payload.configured_path : "";
      showTranscriptionModelDiscovery(sanitized, configuredPath);

      const searched = Array.isArray(payload?.searched) ? payload.searched : [];
      const configuredExists = Boolean(payload && payload.configured_exists);
      let message = "";
      let stateValue = "success";
      if (sanitized.length > 0) {
        const count = sanitized.length;
        message = count === 1 ? "Found 1 Vosk model." : `Found ${count} Vosk models.`;
      } else {
        message = "No Vosk models were found.";
        if (searched.length > 0) {
          const display = searched.slice(0, 3);
          const remainder = searched.length - display.length;
          const joined = display.join(", ");
          const suffix = remainder > 0 ? `, … (+${remainder} more)` : "";
          message += ` Checked ${joined}${suffix}.`;
        }
        stateValue = "warning";
      }

      if (configuredPath && !configuredExists) {
        message += ` Current configured path is missing (${configuredPath}).`;
        stateValue = sanitized.length > 0 ? "warning" : "error";
      }

      setTranscriptionModelStatus(message, stateValue);

      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        console.warn("Model discovery reported issues", payload.errors);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to discover Vosk models.";
      setTranscriptionModelStatus(message, "error");
      transcriptionModelState.models = [];
      hideTranscriptionModelDiscovery();
    } finally {
      transcriptionModelState.loading = false;
      setTranscriptionModelLoading(false);
    }
  }

  function applyLoggingForm(data) {
    const section = recorderDom.sections.logging;
    if (!section) {
      return;
    }
    if (section.devMode) {
      section.devMode.checked = data.dev_mode;
    }
  }

  function readLoggingForm() {
    const section = recorderDom.sections.logging;
    if (!section) {
      return loggingDefaults();
    }
    const payload = {
      dev_mode: section.devMode ? section.devMode.checked : false,
    };
    return canonicalLoggingSettings(payload);
  }

  function applyPathsForm(data) {
    const section = recorderDom.sections.paths;
    if (!section) {
      return;
    }
    const settings = canonicalPathsSettings(data);
    setTextFieldValue(section.tmpDir, settings.tmp_dir);
    setTextFieldValue(section.recordingsDir, settings.recordings_dir);
    setTextFieldValue(section.dropboxDir, settings.dropbox_dir);
    setTextFieldValue(section.ingestDir, settings.ingest_work_dir);
    setTextFieldValue(section.encoderScript, settings.encoder_script);
  }

  function readPathsForm() {
    const section = recorderDom.sections.paths;
    if (!section) {
      return pathsDefaults();
    }
    const payload = {
      tmp_dir: section.tmpDir ? section.tmpDir.value.trim() : "",
      recordings_dir: section.recordingsDir ? section.recordingsDir.value.trim() : "",
      dropbox_dir: section.dropboxDir ? section.dropboxDir.value.trim() : "",
      ingest_work_dir: section.ingestDir ? section.ingestDir.value.trim() : "",
      encoder_script: section.encoderScript ? section.encoderScript.value.trim() : "",
    };
    return canonicalPathsSettings(payload);
  }

  function applyStreamingForm(data) {
    const section = recorderDom.sections.streaming;
    if (!section) {
      return;
    }
    if (section.mode) {
      section.mode.value = data.mode;
    }
    if (section.history) {
      section.history.value = String(data.webrtc_history_seconds);
    }
  }

  function readStreamingForm() {
    const section = recorderDom.sections.streaming;
    if (!section) {
      return streamingDefaults();
    }
    const payload = {
      mode: section.mode ? section.mode.value : undefined,
      webrtc_history_seconds: section.history ? Number(section.history.value) : undefined,
    };
    return canonicalStreamingSettings(payload);
  }

  function applyDashboardForm(data) {
    const section = recorderDom.sections.dashboard;
    if (!section) {
      return;
    }
    if (section.apiBase) {
      section.apiBase.value = data.api_base ?? "";
    }
  }

  function readDashboardForm() {
    const section = recorderDom.sections.dashboard;
    if (!section) {
      return dashboardDefaults();
    }
    const payload = {
      api_base: section.apiBase ? section.apiBase.value : "",
    };
    return canonicalDashboardSettings(payload);
  }

  function applyNotificationsForm(data) {
    const section = recorderDom.sections.notifications;
    if (!section) {
      return;
    }
    const settings = canonicalNotificationsSettings(data);
    setCheckboxValue(section.enabled, settings.enabled);
    if (section.allowedTypes) {
      section.allowedTypes.value = Array.isArray(settings.allowed_event_types)
        ? settings.allowed_event_types.join("\n")
        : "";
    }
    if (section.minTrigger) {
      setTextFieldValue(section.minTrigger, settings.min_trigger_rms);
    }
    const webhook =
      settings.webhook && typeof settings.webhook === "object"
        ? settings.webhook
        : notificationsDefaults().webhook;
    setTextFieldValue(section.webhookUrl, webhook.url);
    setTextFieldValue(section.webhookMethod, webhook.method);
    if (section.webhookHeaders) {
      section.webhookHeaders.value = formatHeaderTextarea(webhook.headers);
    }
    setTextFieldValue(section.webhookTimeout, webhook.timeout_sec);

    const email =
      settings.email && typeof settings.email === "object"
        ? settings.email
        : notificationsDefaults().email;
    setTextFieldValue(section.emailHost, email.smtp_host);
    setTextFieldValue(section.emailPort, email.smtp_port);
    setCheckboxValue(section.emailTls, email.use_tls);
    setCheckboxValue(section.emailSsl, email.use_ssl);
    setTextFieldValue(section.emailUsername, email.username);
    setTextFieldValue(section.emailPassword, email.password);
    setTextFieldValue(section.emailFrom, email.from);
    if (section.emailTo) {
      section.emailTo.value = Array.isArray(email.to) ? email.to.join("\n") : "";
    }
    setTextFieldValue(section.emailSubject, email.subject_template);
    if (section.emailBody) {
      section.emailBody.value =
        typeof email.body_template === "string" ? email.body_template : "";
    }
  }

  function readNotificationsForm() {
    const section = recorderDom.sections.notifications;
    if (!section) {
      return notificationsDefaults();
    }
    const allowedTypes = section.allowedTypes
      ? parseListInput(section.allowedTypes.value || "")
      : [];
    let minTrigger = getNumberInputValue(section.minTrigger);
    if (minTrigger === undefined) {
      minTrigger = null;
    }
    const payload = {
      enabled: section.enabled ? section.enabled.checked : false,
      allowed_event_types: allowedTypes,
      min_trigger_rms: minTrigger,
      webhook: {
        url: section.webhookUrl ? section.webhookUrl.value.trim() : "",
        method: section.webhookMethod ? section.webhookMethod.value.trim() : "",
        headers: parseHeaderTextarea(section.webhookHeaders ? section.webhookHeaders.value : ""),
        timeout_sec: getNumberInputValue(section.webhookTimeout),
      },
      email: {
        smtp_host: section.emailHost ? section.emailHost.value.trim() : "",
        smtp_port: getNumberInputValue(section.emailPort),
        use_tls: section.emailTls ? section.emailTls.checked : false,
        use_ssl: section.emailSsl ? section.emailSsl.checked : false,
        username: section.emailUsername ? section.emailUsername.value.trim() : "",
        password: section.emailPassword ? section.emailPassword.value : "",
        from: section.emailFrom ? section.emailFrom.value.trim() : "",
        to: section.emailTo ? parseListInput(section.emailTo.value || "") : [],
        subject_template: section.emailSubject ? section.emailSubject.value : "",
        body_template: section.emailBody ? section.emailBody.value : "",
      },
    };
    const normalized = canonicalNotificationsSettings(payload);
    if (normalized.min_trigger_rms === undefined) {
      normalized.min_trigger_rms = null;
    }
    return normalized;
  }

  function configModalFocusableElements() {
    if (!dom.configDialog) {
      return [];
    }
    const selectors =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = dom.configDialog.querySelectorAll(selectors);
    const focusable = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (node.hasAttribute("disabled")) {
        continue;
      }
      if (node.getAttribute("aria-hidden") === "true") {
        continue;
      }
      if (node.offsetParent === null && node !== document.activeElement) {
        continue;
      }
      focusable.push(node);
    }
    return focusable;
  }

  function setConfigModalVisible(visible) {
    if (!dom.configModal) {
      return;
    }
    dom.configModal.dataset.visible = visible ? "true" : "false";
    dom.configModal.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.configModal.removeAttribute("hidden");
      lockDocumentScroll("config-snapshot");
    } else {
      dom.configModal.setAttribute("hidden", "hidden");
      unlockDocumentScroll("config-snapshot");
    }
  }

  function attachConfigDialogKeydown() {
    if (configDialogState.keydownHandler) {
      return;
    }
    configDialogState.keydownHandler = (event) => {
      if (!configDialogState.open) {
        return;
      }
      const target = event.target;
      const withinModal =
        dom.configModal &&
        target instanceof Node &&
        (target === dom.configModal || dom.configModal.contains(target));
      if (event.key === "Escape") {
        if (withinModal) {
          event.preventDefault();
        }
        closeConfigModal();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      if (!withinModal) {
        return;
      }
      const focusable = configModalFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        if (dom.configDialog) {
          dom.configDialog.focus();
        }
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (!active || active === first || active === dom.configDialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", configDialogState.keydownHandler, true);
  }

  function detachConfigDialogKeydown() {
    if (!configDialogState.keydownHandler) {
      return;
    }
    document.removeEventListener("keydown", configDialogState.keydownHandler, true);
    configDialogState.keydownHandler = null;
  }

  function focusConfigDialog() {
    if (!dom.configDialog) {
      return;
    }
    window.requestAnimationFrame(() => {
      const focusable = configModalFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dom.configDialog.focus();
      }
    });
  }

  function openConfigModal(options = {}) {
    if (!dom.configModal || !dom.configDialog) {
      return;
    }
    const { focus = true } = options;
    if (dom.configOpen) {
      dom.configOpen.setAttribute("aria-expanded", "true");
    }
    if (configDialogState.open) {
      if (focus) {
        focusConfigDialog();
      }
      fetchConfig({ silent: true });
      return;
    }
    configDialogState.open = true;
    configDialogState.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfigModalVisible(true);
    attachConfigDialogKeydown();
    if (dom.configViewer) {
      dom.configViewer.scrollTop = 0;
    }
    fetchConfig({ silent: true });
    if (focus) {
      focusConfigDialog();
    }
  }

  function closeConfigModal(options = {}) {
    if (!configDialogState.open) {
      return;
    }
    const { restoreFocus = true } = options;
    configDialogState.open = false;
    setConfigModalVisible(false);
    if (dom.configOpen) {
      dom.configOpen.setAttribute("aria-expanded", "false");
    }
    detachConfigDialogKeydown();
    const previous = configDialogState.previouslyFocused;
    configDialogState.previouslyFocused = null;
    if (restoreFocus && previous && typeof previous.focus === "function") {
      previous.focus();
    }
  }

  function servicesModalFocusableElements() {
    if (!dom.servicesDialog) {
      return [];
    }
    const selectors =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = dom.servicesDialog.querySelectorAll(selectors);
    const focusable = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (node.hasAttribute("disabled")) {
        continue;
      }
      if (node.getAttribute("aria-hidden") === "true") {
        continue;
      }
      if (node.offsetParent === null && node !== document.activeElement) {
        continue;
      }
      focusable.push(node);
    }
    return focusable;
  }

  function setServicesModalVisible(visible) {
    if (!dom.servicesModal) {
      return;
    }
    dom.servicesModal.dataset.visible = visible ? "true" : "false";
    dom.servicesModal.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.servicesModal.removeAttribute("hidden");
      lockDocumentScroll("services");
    } else {
      dom.servicesModal.setAttribute("hidden", "hidden");
      unlockDocumentScroll("services");
    }
  }

  function attachServicesDialogKeydown() {
    if (servicesDialogState.keydownHandler) {
      return;
    }
    servicesDialogState.keydownHandler = (event) => {
      if (!servicesDialogState.open) {
        return;
      }
      const target = event.target;
      const withinModal =
        dom.servicesModal &&
        target instanceof Node &&
        (target === dom.servicesModal || dom.servicesModal.contains(target));
      if (event.key === "Escape") {
        event.preventDefault();
        closeServicesModal();
        return;
      }
      if (event.key !== "Tab" || !withinModal) {
        return;
      }
      const focusable = servicesModalFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        if (dom.servicesDialog) {
          dom.servicesDialog.focus();
        }
        return;
      }
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.shiftKey) {
        if (!active || active === first || active === dom.servicesDialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", servicesDialogState.keydownHandler, true);
  }

  function detachServicesDialogKeydown() {
    if (!servicesDialogState.keydownHandler) {
      return;
    }
    document.removeEventListener("keydown", servicesDialogState.keydownHandler, true);
    servicesDialogState.keydownHandler = null;
  }

  function focusServicesDialog() {
    if (!dom.servicesDialog) {
      return;
    }
    window.requestAnimationFrame(() => {
      const focusable = servicesModalFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dom.servicesDialog.focus();
      }
    });
  }

  function openServicesModal(options = {}) {
    if (!dom.servicesModal || !dom.servicesDialog) {
      return;
    }
    const { focus = true } = options;
    if (dom.servicesOpen) {
      dom.servicesOpen.setAttribute("aria-expanded", "true");
    }
    if (servicesDialogState.open) {
      if (focus) {
        focusServicesDialog();
      }
      fetchServices({ silent: false });
      startServicesRefresh();
      return;
    }
    servicesDialogState.open = true;
    servicesDialogState.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setServicesModalVisible(true);
    if (dom.servicesBody) {
      dom.servicesBody.scrollTop = 0;
    }
    fetchServices({ silent: false });
    attachServicesDialogKeydown();
    startServicesRefresh();
    if (focus) {
      focusServicesDialog();
    }
  }

  function closeServicesModal(options = {}) {
    if (!servicesDialogState.open) {
      return;
    }
    const { restoreFocus = true } = options;
    servicesDialogState.open = false;
    stopServicesRefresh();
    setServicesModalVisible(false);
    if (dom.servicesOpen) {
      dom.servicesOpen.setAttribute("aria-expanded", "false");
    }
    detachServicesDialogKeydown();
    const previous = servicesDialogState.previouslyFocused;
    servicesDialogState.previouslyFocused = null;
    if (restoreFocus && previous && typeof previous.focus === "function") {
      previous.focus();
    }
  }

  return {
    handleRecorderConfigSnapshot,
    updateRecorderConfigPath,
    ensureRecorderSectionsLoaded,
    registerRecorderSection,
    registerRecorderSections,
    applyAudioForm,
    readAudioForm,
    applySegmenterForm,
    readSegmenterForm,
    applyAdaptiveForm,
    readAdaptiveForm,
    applyIngestForm,
    readIngestForm,
    applyTranscriptionForm,
    readTranscriptionForm,
    setTranscriptionModelStatus,
    setTranscriptionModelLoading,
    hideTranscriptionModelDiscovery,
    showTranscriptionModelDiscovery,
    applySelectedTranscriptionModel,
    refreshTranscriptionModels,
    applyLoggingForm,
    readLoggingForm,
    applyPathsForm,
    readPathsForm,
    applyStreamingForm,
    readStreamingForm,
    applyDashboardForm,
    readDashboardForm,
    applyNotificationsForm,
    readNotificationsForm,
    configModalFocusableElements,
    setConfigModalVisible,
    attachConfigDialogKeydown,
    detachConfigDialogKeydown,
    focusConfigDialog,
    openConfigModal,
    closeConfigModal,
    servicesModalFocusableElements,
    setServicesModalVisible,
    attachServicesDialogKeydown,
    detachServicesDialogKeydown,
    focusServicesDialog,
    openServicesModal,
    closeServicesModal,
  };
}
