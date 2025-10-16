export function createRecorderConfigUi(deps) {
  const {
    state,
    dom,
    recorderState,
    recorderDom,
    recorderDialogState,
    configDialogState,
    servicesDialogState,
    recycleBinDialogState,
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
    fetchRecycleBin,
    fetchRecordings,
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
    streamingDefaults,
    canonicalStreamingSettings,
    canonicalStreamingFromConfig,
    dashboardDefaults,
    canonicalDashboardSettings,
    canonicalDashboardFromConfig,
    parseListInput,
    applyRecycleBinRangeSelection,
    persistRecycleBinState,
    getRecycleBinItem,
    getRecycleBinRow,
    recycleBinRecordFromItem,
    isRecycleBinRecord,
    setNowPlaying,
    placePlayerCard,
    isMotionTriggeredEvent,
    formatDuration,
    formatIsoDateTime,
    formatBytes,
    getRecordingsRefreshDeferred,
    setRecordingsRefreshDeferred,
  } = deps;

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
    if (section.frameMs) {
      section.frameMs.value = String(data.frame_ms);
    }
    if (section.gain) {
      section.gain.value = String(data.gain);
    }
    if (section.vad) {
      section.vad.value = String(data.vad_aggressiveness);
    }
    const filters =
      data && typeof data === "object" && data.filter_chain ? data.filter_chain : {};
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
      section.calibrationNoise.checked = Boolean(
        filters.calibration && filters.calibration.auto_noise_profile,
      );
    }
    if (section.calibrationGain) {
      section.calibrationGain.checked = Boolean(
        filters.calibration && filters.calibration.auto_gain,
      );
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
      frame_ms: section.frameMs ? Number(section.frameMs.value) : undefined,
      gain: section.gain ? Number(section.gain.value) : undefined,
      vad_aggressiveness: section.vad ? Number(section.vad.value) : undefined,
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
    const mapping = [
      [section.prePad, data.pre_pad_ms],
      [section.postPad, data.post_pad_ms],
      [section.motionPaddingMinutes, data.motion_release_padding_minutes],
      [section.threshold, data.rms_threshold],
      [section.keepWindow, data.keep_window_frames],
      [section.startConsecutive, data.start_consecutive],
      [section.keepConsecutive, data.keep_consecutive],
      [section.flushBytes, data.flush_threshold_bytes],
      [section.maxQueue, data.max_queue_frames],
      [section.minClipSeconds, data.min_clip_seconds],
    ];
    for (const [input, value] of mapping) {
      if (input) {
        input.value = String(value);
      }
    }
    if (section.useRnnoise) {
      section.useRnnoise.checked = data.use_rnnoise;
    }
    if (section.useNoisereduce) {
      section.useNoisereduce.checked = data.use_noisereduce;
    }
    if (section.denoiseBeforeVad) {
      section.denoiseBeforeVad.checked = data.denoise_before_vad;
    }
  }

  function readSegmenterForm() {
    const section = recorderDom.sections.segmenter;
    if (!section) {
      return segmenterDefaults();
    }
    const payload = {
      pre_pad_ms: section.prePad ? Number(section.prePad.value) : undefined,
      post_pad_ms: section.postPad ? Number(section.postPad.value) : undefined,
      motion_release_padding_minutes: section.motionPaddingMinutes
        ? Number(section.motionPaddingMinutes.value)
        : undefined,
      rms_threshold: section.threshold ? Number(section.threshold.value) : undefined,
      keep_window_frames: section.keepWindow ? Number(section.keepWindow.value) : undefined,
      start_consecutive: section.startConsecutive
        ? Number(section.startConsecutive.value)
        : undefined,
      keep_consecutive: section.keepConsecutive
        ? Number(section.keepConsecutive.value)
        : undefined,
      flush_threshold_bytes: section.flushBytes
        ? Number(section.flushBytes.value)
        : undefined,
      max_queue_frames: section.maxQueue ? Number(section.maxQueue.value) : undefined,
      min_clip_seconds: section.minClipSeconds
        ? Number(section.minClipSeconds.value)
        : undefined,
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
      [section.minimum, data.minimum],
      [section.maximum, data.maximum],
      [section.target, data.target],
      [section.window, data.window],
      [section.threshold, data.threshold],
      [section.releaseWindow, data.release_window],
      [section.releaseThreshold, data.release_threshold],
      [section.noiseFloor, data.noise_floor],
      [section.noiseMax, data.noise_maximum],
    ];
    for (const [input, value, mode] of mapping) {
      if (!input) {
        continue;
      }
      if (mode === "checked") {
        input.checked = Boolean(value);
      } else {
        input.value = String(value);
      }
    }
  }

  function readAdaptiveForm() {
    const section = recorderDom.sections.adaptive_rms;
    if (!section) {
      return adaptiveDefaults();
    }
    const payload = {
      enabled: section.enabled ? section.enabled.checked : false,
      minimum: section.minimum ? Number(section.minimum.value) : undefined,
      maximum: section.maximum ? Number(section.maximum.value) : undefined,
      target: section.target ? Number(section.target.value) : undefined,
      window: section.window ? Number(section.window.value) : undefined,
      threshold: section.threshold ? Number(section.threshold.value) : undefined,
      release_window: section.releaseWindow ? Number(section.releaseWindow.value) : undefined,
      release_threshold: section.releaseThreshold
        ? Number(section.releaseThreshold.value)
        : undefined,
      noise_floor: section.noiseFloor ? Number(section.noiseFloor.value) : undefined,
      noise_maximum: section.noiseMax ? Number(section.noiseMax.value) : undefined,
    };
    return canonicalAdaptiveSettings(payload);
  }

  function applyIngestForm(data) {
    const section = recorderDom.sections.ingest;
    if (!section) {
      return;
    }
    if (section.enabled) {
      section.enabled.checked = data.enabled;
    }
    if (section.hostname) {
      section.hostname.value = data.hostname ?? "";
    }
    if (section.port) {
      section.port.value = String(data.port);
    }
    if (section.transport) {
      section.transport.value = data.transport ?? "";
    }
    if (section.backupHostname) {
      section.backupHostname.value = data.backup_hostname ?? "";
    }
    if (section.backupPort) {
      section.backupPort.value = String(data.backup_port);
    }
    if (section.backupTransport) {
      section.backupTransport.value = data.backup_transport ?? "";
    }
    if (section.token) {
      section.token.value = data.token ?? "";
    }
    if (section.channel) {
      section.channel.value = data.channel ?? "";
    }
    if (section.tags) {
      section.tags.value = data.tags.join("\n");
    }
  }

  function readIngestForm() {
    const section = recorderDom.sections.ingest;
    if (!section) {
      return ingestDefaults();
    }
    const payload = {
      enabled: section.enabled ? section.enabled.checked : false,
      hostname: section.hostname ? section.hostname.value : undefined,
      port: section.port ? Number(section.port.value) : undefined,
      transport: section.transport ? section.transport.value : undefined,
      backup_hostname: section.backupHostname ? section.backupHostname.value : undefined,
      backup_port: section.backupPort ? Number(section.backupPort.value) : undefined,
      backup_transport: section.backupTransport ? section.backupTransport.value : undefined,
      token: section.token ? section.token.value : undefined,
      channel: section.channel ? section.channel.value : undefined,
      tags: section.tags ? parseListInput(section.tags.value) : undefined,
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

  function recycleBinModalFocusableElements() {
    if (!dom.recycleBinDialog) {
      return [];
    }
    const selectors =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = dom.recycleBinDialog.querySelectorAll(selectors);
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

  function setRecycleBinModalVisible(visible) {
    if (!dom.recycleBinModal) {
      return;
    }
    dom.recycleBinModal.dataset.visible = visible ? "true" : "false";
    dom.recycleBinModal.setAttribute("aria-hidden", visible ? "false" : "true");
    if (visible) {
      dom.recycleBinModal.removeAttribute("hidden");
      lockDocumentScroll("recycle-bin");
    } else {
      dom.recycleBinModal.setAttribute("hidden", "hidden");
      unlockDocumentScroll("recycle-bin");
    }
  }

  function attachRecycleBinDialogKeydown() {
    if (recycleBinDialogState.keydownHandler) {
      return;
    }
    recycleBinDialogState.keydownHandler = (event) => {
      if (!recycleBinDialogState.open) {
        return;
      }
      const target = event.target;
      const withinModal =
        dom.recycleBinModal &&
        target instanceof Node &&
        (target === dom.recycleBinModal || dom.recycleBinModal.contains(target));
      if (event.key === "Escape") {
        event.preventDefault();
        closeRecycleBinModal();
        return;
      }
      if (event.key !== "Tab" || !withinModal) {
        return;
      }
      const focusable = recycleBinModalFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        if (dom.recycleBinDialog) {
          dom.recycleBinDialog.focus();
        }
        return;
      }
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.shiftKey) {
        if (!active || active === first || active === dom.recycleBinDialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", recycleBinDialogState.keydownHandler, true);
  }

  function detachRecycleBinDialogKeydown() {
    if (!recycleBinDialogState.keydownHandler) {
      return;
    }
    document.removeEventListener("keydown", recycleBinDialogState.keydownHandler, true);
    recycleBinDialogState.keydownHandler = null;
  }

  function focusRecycleBinDialog() {
    if (!dom.recycleBinDialog) {
      return;
    }
    window.requestAnimationFrame(() => {
      const focusable = recycleBinModalFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dom.recycleBinDialog.focus();
      }
    });
  }

  function openRecycleBinModal(options = {}) {
    if (!dom.recycleBinModal || !dom.recycleBinDialog) {
      return;
    }
    const { focus = true } = options;
    suspendAutoRefresh();
    if (dom.recycleBinOpen) {
      dom.recycleBinOpen.setAttribute("aria-expanded", "true");
    }
    if (recycleBinDialogState.open) {
      if (focus) {
        focusRecycleBinDialog();
      }
      fetchRecycleBin({ silent: false });
      return;
    }
    recycleBinDialogState.open = true;
    state.recycleBin.open = true;
    recycleBinDialogState.previewing = false;
    recycleBinDialogState.previousRecord = null;
    recycleBinDialogState.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRecycleBinModalVisible(true);
    attachRecycleBinDialogKeydown();
    fetchRecycleBin({ silent: false });
    if (focus) {
      focusRecycleBinDialog();
    }
  }

  function closeRecycleBinModal(options = {}) {
    if (!recycleBinDialogState.open) {
      return;
    }
    const { restoreFocus = true } = options;
    const shouldRefreshRecordings = getRecordingsRefreshDeferred();
    setRecordingsRefreshDeferred(false);
    recycleBinDialogState.open = false;
    state.recycleBin.open = false;
    setRecycleBinModalVisible(false);
    detachRecycleBinDialogKeydown();
    if (dom.recycleBinOpen) {
      dom.recycleBinOpen.setAttribute("aria-expanded", "false");
    }
    restoreRecycleBinPreview();
    if (shouldRefreshRecordings) {
      fetchRecordings({ silent: true, force: true });
    }
    resumeAutoRefresh();
    const previous = recycleBinDialogState.previouslyFocused;
    recycleBinDialogState.previouslyFocused = null;
    if (restoreFocus && previous && typeof previous.focus === "function") {
      previous.focus();
    }
  }

  function restoreRecycleBinPreview() {
    if (!recycleBinDialogState.previewing) {
      return;
    }
    recycleBinDialogState.previewing = false;
    const previous = recycleBinDialogState.previousRecord || null;
    recycleBinDialogState.previousRecord = null;
    if (isRecycleBinRecord(state.current)) {
      if (previous) {
        setNowPlaying(previous, { autoplay: false, resetToStart: false });
      } else {
        setNowPlaying(null, { autoplay: false, resetToStart: true });
      }
    }
  }

  function updateRecycleBinControls() {
    const selectedCount = state.recycleBin.selected.size;
    const totalCount = state.recycleBin.items.length;
    if (dom.recycleBinTotalCount) {
      dom.recycleBinTotalCount.textContent = totalCount.toString();
    }
    if (dom.recycleBinSelectedCount) {
      dom.recycleBinSelectedCount.textContent = selectedCount.toString();
    }
    if (dom.recycleBinRestore) {
      dom.recycleBinRestore.disabled =
        !selectedCount || state.recycleBin.loading || state.recycleBin.items.length === 0;
    }
    if (dom.recycleBinPurge) {
      dom.recycleBinPurge.disabled =
        !selectedCount || state.recycleBin.loading || state.recycleBin.items.length === 0;
    }
    if (dom.recycleBinRefresh) {
      dom.recycleBinRefresh.disabled = state.recycleBin.loading;
    }
    if (dom.recycleBinToggleAll) {
      const total = state.recycleBin.items.length;
      const selected = selectedCount;
      dom.recycleBinToggleAll.disabled = total === 0;
      dom.recycleBinToggleAll.checked = total > 0 && selected === total;
      dom.recycleBinToggleAll.indeterminate = selected > 0 && selected < total;
    }
  }

  function updateRecycleBinPreview() {
    if (!state.recycleBin.open) {
      return;
    }
    const item = getRecycleBinItem(state.recycleBin.activeId);
    if (!item) {
      restoreRecycleBinPreview();
      return;
    }
    const row = getRecycleBinRow(item.id);
    if (!row) {
      return;
    }
    if (!recycleBinDialogState.previewing) {
      recycleBinDialogState.previousRecord = isRecycleBinRecord(state.current)
        ? null
        : state.current;
      recycleBinDialogState.previewing = true;
    }
    if (isRecycleBinRecord(state.current) && state.current.recycleBinId === item.id) {
      placePlayerCard(state.current, row);
      return;
    }
    const record = recycleBinRecordFromItem(item);
    if (!record) {
      return;
    }
    setNowPlaying(record, { autoplay: false, resetToStart: true, sourceRow: row });
  }

  function renderRecycleBinItems() {
    if (!dom.recycleBinTableBody) {
      return;
    }
    dom.recycleBinTableBody.textContent = "";
    const fragment = document.createDocumentFragment();
    for (const item of state.recycleBin.items) {
      if (!item || typeof item.id !== "string" || !item.id) {
        continue;
      }
      const row = document.createElement("tr");
      row.dataset.id = item.id;
      row.dataset.restorable = item.restorable === false ? "false" : "true";
      const isSelected = state.recycleBin.selected.has(item.id);
      const isActive = state.recycleBin.activeId === item.id;
      const isMotion = isMotionTriggeredEvent(item);
      if (isSelected) {
        row.dataset.selected = "true";
      } else {
        delete row.dataset.selected;
      }
      if (isActive) {
        row.dataset.active = "true";
      } else {
        delete row.dataset.active;
      }
      if (isMotion) {
        row.dataset.motion = "true";
      } else {
        delete row.dataset.motion;
      }

      const checkboxCell = document.createElement("td");
      checkboxCell.className = "checkbox-cell";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isSelected;
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!(event instanceof MouseEvent)) {
          return;
        }
        if (
          event.shiftKey &&
          typeof state.recycleBin.anchorId === "string" &&
          state.recycleBin.anchorId
        ) {
          event.preventDefault();
          const shouldSelect = !checkbox.checked;
          const changed = applyRecycleBinRangeSelection(
            state.recycleBin.anchorId,
            item.id,
            shouldSelect,
          );
          state.recycleBin.anchorId = item.id;
          checkbox.checked = state.recycleBin.selected.has(item.id);
          if (changed) {
            if (
              !shouldSelect &&
              typeof state.recycleBin.activeId === "string" &&
              state.recycleBin.activeId &&
              !state.recycleBin.selected.has(state.recycleBin.activeId)
            ) {
              state.recycleBin.activeId = "";
            }
            persistRecycleBinState();
            renderRecycleBinItems();
          }
          return;
        }
        state.recycleBin.anchorId = item.id;
      });
      checkbox.addEventListener("change", () => {
        const updated = new Set(state.recycleBin.selected);
        if (checkbox.checked) {
          updated.add(item.id);
        } else {
          updated.delete(item.id);
          if (state.recycleBin.activeId === item.id) {
            state.recycleBin.activeId = "";
          }
        }
        state.recycleBin.selected = updated;
        state.recycleBin.anchorId = item.id;
        persistRecycleBinState();
        renderRecycleBinItems();
      });
      checkboxCell.append(checkbox);
      row.append(checkboxCell);

      const nameCell = document.createElement("td");
      const displayName =
        item.name && item.name.trim() ? item.name : item.original_path || item.id;
      const nameWrapper = document.createElement("div");
      nameWrapper.className = "recycle-bin-name";
      const nameText = document.createElement("span");
      nameText.className = "recycle-bin-name-text";
      nameText.textContent = displayName;
      nameWrapper.append(nameText);
      if (isMotion) {
        const motionBadge = document.createElement("span");
        motionBadge.className = "badge badge-motion";
        motionBadge.textContent = "Motion";
        nameWrapper.append(motionBadge);
      }
      nameCell.append(nameWrapper);
      if (item.original_path) {
        nameCell.title = item.original_path;
      }
      row.append(nameCell);

      const lengthCell = document.createElement("td");
      if (typeof item.duration_seconds === "number" && Number.isFinite(item.duration_seconds)) {
        lengthCell.textContent = formatDuration(item.duration_seconds);
      } else {
        lengthCell.textContent = "--";
      }
      row.append(lengthCell);

      const labelCell = document.createElement("td");
      labelCell.className = "recycle-bin-label-cell";
      if (item.autoMoved) {
        const autoLabel = document.createElement("span");
        autoLabel.className = "badge recycle-bin-auto-label";
        autoLabel.textContent = "Auto (short clip)";
        labelCell.append(autoLabel);
      }
      if (item.restorable === false) {
        const conflict = document.createElement("span");
        conflict.className = "recycle-bin-conflict";
        conflict.textContent = "In use";
        labelCell.append(conflict);
      }
      row.append(labelCell);

      const deletedCell = document.createElement("td");
      deletedCell.textContent = formatIsoDateTime(item.deleted_at) || "--";
      row.append(deletedCell);

      const sizeCell = document.createElement("td");
      sizeCell.textContent = formatBytes(Number(item.size_bytes) || 0);
      row.append(sizeCell);

      row.addEventListener("click", (event) => {
        if (event.target instanceof HTMLElement) {
          if (event.target.closest("input, button, a")) {
            return;
          }
        }
        state.recycleBin.selected = new Set([item.id]);
        state.recycleBin.activeId = item.id;
        state.recycleBin.anchorId = item.id;
        persistRecycleBinState();
        renderRecycleBinItems();
      });

      fragment.append(row);
    }
    dom.recycleBinTableBody.append(fragment);
    if (dom.recycleBinEmpty) {
      dom.recycleBinEmpty.hidden = state.recycleBin.items.length !== 0;
    }
    updateRecycleBinControls();
    updateRecycleBinPreview();
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
    applyStreamingForm,
    readStreamingForm,
    applyDashboardForm,
    readDashboardForm,
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
    recycleBinModalFocusableElements,
    setRecycleBinModalVisible,
    attachRecycleBinDialogKeydown,
    detachRecycleBinDialogKeydown,
    focusRecycleBinDialog,
    openRecycleBinModal,
    closeRecycleBinModal,
    restoreRecycleBinPreview,
    updateRecycleBinControls,
    updateRecycleBinPreview,
    renderRecycleBinItems,
  };
}
