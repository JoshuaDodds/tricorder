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
  return {
    message: `Saved changes. Restarted ${joined}.`,
    state: hasFailure ? "warning" : "success",
  };
}

async function saveRecorderSection(key) {
  const section = getRecorderSection(key);
  if (section.state.saving || !section.state.dirty) {
    return true;
  }
  if (typeof section.options.read !== "function" || !section.options.endpoint) {
    return false;
  }

  const payload = section.options.read();
  section.state.saving = true;
  updateRecorderButtons(key);
  setRecorderStatus(key, "Saving…", "pending");

  let success = true;
  try {
    const response = await apiClient.fetch(apiPath(section.options.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }

    if (!response.ok) {
      const message = body && typeof body.error === "string"
        ? body.error
        : `Request failed with ${response.status}`;
      throw new Error(message);
    }

    const canonical = typeof section.options.fromResponse === "function"
      ? section.options.fromResponse(body)
      : section.options.defaults();
    applyRecorderSectionData(key, canonical, { markPristine: true });
    section.state.loaded = true;

    if (body && typeof body.config_path === "string") {
      updateRecorderConfigPath(body.config_path);
    }

    const { message, state } = summariseRestartResults(body ? body.restart_results : null);
    setRecorderStatus(key, message, state, { autoHide: true, duration: 3600 });
    fetchConfig({ silent: true });
    fetchServices({ silent: true });
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to save settings.";
    setRecorderStatus(key, message, "error");
    success = false;
  } finally {
    section.state.saving = false;
    updateRecorderButtons(key);
  }
  return success;
}

async function fetchRecorderSection(key) {
  const section = getRecorderSection(key);
  if (!section.options.endpoint) {
    return;
  }
  try {
    const response = await apiClient.fetch(apiPath(section.options.endpoint), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    const payload = await response.json();
    const canonical = typeof section.options.fromResponse === "function"
      ? section.options.fromResponse(payload)
      : section.options.defaults();
    applyRecorderSectionData(key, canonical, { markPristine: true });
    section.state.loaded = true;
    if (payload && typeof payload.config_path === "string") {
      updateRecorderConfigPath(payload.config_path);
    }
    setRecorderStatus(key, "", null);
  } catch (error) {
    console.error(`Failed to fetch ${key} settings`, error);
    setRecorderStatus(key, "Unable to load settings.", "error");
  }
}

function syncRecorderSectionsFromConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }
  recorderState.latestConfig = config;
  for (const [key, section] of recorderState.sections.entries()) {
    if (typeof section.options.fromConfig !== "function") {
      continue;
    }
    const canonical = section.options.fromConfig(config);
    handleRecorderConfigSnapshot(key, canonical);
  }
  if (!recorderState.loaded) {
    recorderState.loaded = true;
  }
}

function nativeHlsSupported(audio) {
  return (
    audio.canPlayType("application/vnd.apple.mpegurl") ||
    audio.canPlayType("application/x-mpegURL")
  );
}

function loadHlsLibrary() {
  if (window.Hls && typeof window.Hls.isSupported === "function") {
    return Promise.resolve(window.Hls);
  }
  if (liveState.scriptPromise) {
    return liveState.scriptPromise;
  }
  liveState.scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
    script.async = true;
    script.onload = () => {
      if (window.Hls) {
        resolve(window.Hls);
      } else {
        reject(new Error("hls.js unavailable"));
      }
    };
    script.onerror = () => reject(new Error("Failed to load hls.js"));
    document.body.append(script);
  }).catch((error) => {
    console.error("Unable to load hls.js", error);
    liveState.scriptPromise = null;
    throw error;
  });
  return liveState.scriptPromise;
}

function generateSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    return Array.from(arr, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  const rand = Math.random().toString(36).slice(2);
  return `sess-${Date.now().toString(36)}-${rand}`;
}

function readSessionFromStorage() {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }
  } catch (error) {
    /* ignore storage errors */
  }

  if (typeof window.name === "string" && window.name.startsWith(WINDOW_NAME_PREFIX)) {
    return window.name.slice(WINDOW_NAME_PREFIX.length);
  }

  return null;
}

function persistSessionId(id) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch (error) {
    /* ignore storage errors */
  }

  try {
    window.name = `${WINDOW_NAME_PREFIX}${id}`;
  } catch (error) {
    /* ignore window.name assignment errors */
  }
}

function ensureSessionId() {
  if (liveState.sessionId) {
    return liveState.sessionId;
  }

  const existing = readSessionFromStorage();
  if (existing) {
    liveState.sessionId = existing;
    persistSessionId(existing);
    return existing;
  }

  const generated = generateSessionId();
  liveState.sessionId = generated;
  persistSessionId(generated);
  return generated;
}

function withSession(path) {
  const id = ensureSessionId();
  if (!id) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}session=${encodeURIComponent(id)}`;
}

function sendStart() {
  apiClient.fetch(withSession(START_ENDPOINT), { cache: "no-store" }).catch(() => undefined);
}

function sendStop(useBeacon) {
  const url = withSession(STOP_ENDPOINT);
  if (useBeacon && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(url, "");
      return;
    } catch (error) {
      /* fall back to fetch */
    }
  }
  apiClient.fetch(url, { cache: "no-store", keepalive: true }).catch(() => undefined);
}

async function refreshLiveStats() {
  try {
    const response = await apiClient.fetch(STATS_ENDPOINT, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`stats ${response.status}`);
    }
    const payload = await response.json();
    if (dom.liveClients) {
      dom.liveClients.textContent = String(payload.active_clients ?? 0);
    }
    if (dom.liveEncoder) {
      dom.liveEncoder.textContent = payload.encoder_running ? "running" : "stopped";
    }
  } catch (error) {
    console.debug("Failed to fetch live stats", error);
  }
}

function scheduleLiveStats() {
  cancelLiveStats();
  refreshLiveStats();
  liveState.statsTimer = window.setInterval(refreshLiveStats, 2000);
}

function cancelLiveStats() {
  if (liveState.statsTimer) {
    window.clearInterval(liveState.statsTimer);
    liveState.statsTimer = null;
  }
}

function setLiveStatus(text) {
  if (dom.liveStatus) {
    dom.liveStatus.textContent = text;
  }
}

function setAutoRecordButtonState(active) {
  if (!dom.autoToggle) {
    return;
  }
  const nextActive = Boolean(active);
  dom.autoToggle.setAttribute("aria-pressed", nextActive ? "true" : "false");
  dom.autoToggle.textContent = nextActive ? "Disable Auto" : "Enable Auto";
}

function setAutoRecordDisabled(disabled, reason = "") {
  if (!dom.autoToggle) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  if (dom.autoToggle.disabled !== nextDisabled) {
    dom.autoToggle.disabled = nextDisabled;
  }
  if (nextDisabled) {
    if (reason) {
      dom.autoToggle.title = reason;
    } else {
      dom.autoToggle.removeAttribute("title");
    }
    dom.autoToggle.setAttribute("aria-disabled", "true");
  } else {
    dom.autoToggle.removeAttribute("title");
    dom.autoToggle.removeAttribute("aria-disabled");
  }
}

function updateAutoRecordButton(rawStatus) {
  if (!dom.autoToggle) {
    return;
  }
  if (autoRecordState.pending) {
    const pendingReason =
      autoRecordState.reason || "Auto capture toggle in progress.";
    setAutoRecordDisabled(true, pendingReason);
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : state.captureStatus;
  let enabled = true;
  if (status && typeof status === "object") {
    if (Object.prototype.hasOwnProperty.call(status, "auto_recording_enabled")) {
      enabled = parseBoolean(status.auto_recording_enabled);
    }
    autoRecordState.motionOverride = parseBoolean(
      status.auto_record_motion_override
    );
  } else {
    autoRecordState.motionOverride = false;
  }
  autoRecordState.enabled = enabled !== false;
  setAutoRecordButtonState(autoRecordState.enabled);
  let disabled = false;
  let reason = "";
  if (!status || typeof status !== "object") {
    disabled = true;
    reason = "Recorder status unavailable.";
  } else if (!parseBoolean(status.service_running)) {
    disabled = true;
    const stopReason =
      typeof status.last_stop_reason === "string"
        ? status.last_stop_reason.trim()
        : "";
    reason = stopReason || "Recorder service is stopped.";
  }
  setAutoRecordDisabled(disabled, reason);
}

function setAutoRecordPending(pending, message = "") {
  autoRecordState.pending = Boolean(pending);
  autoRecordState.reason = message;
  if (!dom.autoToggle) {
    return;
  }
  if (autoRecordState.pending) {
    dom.autoToggle.setAttribute("aria-busy", "true");
    setAutoRecordDisabled(true, message || "Auto capture toggle in progress.");
  } else {
    dom.autoToggle.removeAttribute("aria-busy");
    updateAutoRecordButton(state.captureStatus);
  }
}

function setManualRecordButtonState(active) {
  if (!dom.manualToggle) {
    return;
  }
  dom.manualToggle.setAttribute("aria-pressed", active ? "true" : "false");
  dom.manualToggle.textContent = active ? "Stop Manual" : "Manual Record";
}

function setManualRecordDisabled(disabled, reason = "") {
  if (!dom.manualToggle) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  if (dom.manualToggle.disabled !== nextDisabled) {
    dom.manualToggle.disabled = nextDisabled;
  }
  if (nextDisabled) {
    if (reason) {
      dom.manualToggle.title = reason;
    } else {
      dom.manualToggle.removeAttribute("title");
    }
    dom.manualToggle.setAttribute("aria-disabled", "true");
  } else {
    dom.manualToggle.removeAttribute("title");
    dom.manualToggle.removeAttribute("aria-disabled");
  }
}

function updateManualRecordButton(rawStatus) {
  if (!dom.manualToggle) {
    return;
  }
  if (manualRecordState.pending) {
    const pendingReason = manualRecordState.reason || "Manual toggle in progress.";
    setManualRecordDisabled(true, pendingReason);
    return;
  }
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
  const enabled = status ? parseBoolean(status.manual_recording) : false;
  manualRecordState.enabled = Boolean(enabled);
  setManualRecordButtonState(manualRecordState.enabled);
  let disabled = false;
  let reason = "";
  if (!status) {
    disabled = true;
    reason = "Recorder status unavailable.";
  } else if (!parseBoolean(status.service_running)) {
    disabled = true;
    const stopReason =
      typeof status.last_stop_reason === "string" ? status.last_stop_reason.trim() : "";
    reason = stopReason || "Recorder service is stopped.";
  }
  setManualRecordDisabled(disabled, reason);
}

function setManualRecordPending(pending, message = "") {
  manualRecordState.pending = Boolean(pending);
  manualRecordState.reason = message;
  if (!dom.manualToggle) {
    return;
  }
  if (manualRecordState.pending) {
    dom.manualToggle.setAttribute("aria-busy", "true");
    setManualRecordDisabled(true, message || "Manual toggle in progress.");
  } else {
    dom.manualToggle.removeAttribute("aria-busy");
    updateManualRecordButton(state.captureStatus);
  }
}

function setLiveButtonState(active) {
  if (!dom.liveToggle) {
    return;
  }
  dom.liveToggle.setAttribute("aria-pressed", active ? "true" : "false");
  dom.liveToggle.textContent = active ? "Stop Stream" : "Live Stream";
}

function setLiveToggleDisabled(disabled, reason = "") {
  if (!dom.liveToggle) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  if (dom.liveToggle.disabled !== nextDisabled) {
    dom.liveToggle.disabled = nextDisabled;
  }
  if (nextDisabled) {
    if (reason) {
      dom.liveToggle.title = reason;
    } else {
      dom.liveToggle.removeAttribute("title");
    }
    dom.liveToggle.setAttribute("aria-disabled", "true");
  } else {
    dom.liveToggle.removeAttribute("title");
    dom.liveToggle.removeAttribute("aria-disabled");
  }
}

function updateLiveToggleAvailabilityFromServices() {
  if (!dom.liveToggle) {
    return;
  }

  const service = servicesState.items.find(
    (entry) => entry && entry.unit === VOICE_RECORDER_SERVICE_UNIT,
  );
  if (!service) {
    let reason = "Recorder service status unavailable.";
    if (servicesState.items.length > 0) {
      reason = "Recorder service unavailable.";
    } else if (servicesState.error) {
      reason = servicesState.error;
    } else if (servicesState.fetchInFlight) {
      reason = "Checking recorder service status…";
    }
    setLiveToggleDisabled(true, reason);
    if (liveState.open) {
      closeLiveStreamPanel();
    }
    return;
  }

  const pending = servicesState.pending.has(service.unit);
  const available = service.available !== false;
  const active = service.is_active === true;

  let disabled = false;
  let reason = "";

  if (pending) {
    disabled = true;
    reason = "Recorder service changing state.";
  } else if (!available) {
    disabled = true;
    reason = service.error || "Recorder service unavailable.";
  } else if (!active) {
    disabled = true;
    reason = "Recorder service is stopped.";
  }

  setLiveToggleDisabled(disabled, reason);
  if (disabled && liveState.open) {
    closeLiveStreamPanel();
  }
}

function attachLiveStreamSource() {
  if (!dom.liveAudio) {
    return;
  }
  detachLiveStream();
  dom.liveAudio.autoplay = true;
  if (STREAM_MODE === "webrtc") {
    startWebRtcStream().catch((error) => {
      console.error("WebRTC setup failed", error);
      setLiveStatus("Error");
    });
    return;
  }
  if (nativeHlsSupported(dom.liveAudio)) {
    dom.liveAudio.src = HLS_URL;
    dom.liveAudio.play().catch(() => undefined);
    return;
  }

  loadHlsLibrary()
    .then(() => {
      if (!liveState.open) {
        return;
      }
      if (window.Hls && window.Hls.isSupported()) {
        liveState.hls = new window.Hls({ lowLatencyMode: true });
        liveState.hls.loadSource(HLS_URL);
        liveState.hls.attachMedia(dom.liveAudio);
      } else {
        dom.liveAudio.src = HLS_URL;
      }
      dom.liveAudio.play().catch(() => undefined);
    })
    .catch(() => {
      dom.liveAudio.src = HLS_URL;
      dom.liveAudio.play().catch(() => undefined);
    });
}

function waitForIceGatheringComplete(pc, { timeoutMs = 2500 } = {}) {
  if (!pc) {
    return Promise.resolve();
  }
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        settle();
      }
    };

    const onCandidate = (event) => {
      if (!event.candidate) {
        settle();
      }
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = window.setTimeout(settle, timeoutMs);
    }
  });
}

async function startWebRtcStream() {
  if (!dom.liveAudio) {
    return;
  }
  const pcConfig = {};
  if (WEBRTC_ICE_SERVERS.length > 0) {
    pcConfig.iceServers = WEBRTC_ICE_SERVERS;
  }
  const pc = new RTCPeerConnection(pcConfig);
  liveState.pc = pc;
  const mediaStream = new MediaStream();
  liveState.stream = mediaStream;
  dom.liveAudio.srcObject = mediaStream;
  dom.liveAudio.setAttribute("playsinline", "true");

  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.addEventListener("track", (event) => {
    const [trackStream] = event.streams;
    if (trackStream) {
      trackStream.getTracks().forEach((track) => {
        mediaStream.addTrack(track);
      });
    } else if (event.track) {
      mediaStream.addTrack(event.track);
    }
    dom.liveAudio.play().catch(() => undefined);
    setLiveStatus("Live");
  });

  pc.addEventListener("connectionstatechange", () => {
    if (!liveState.active) {
      return;
    }
    if (pc.connectionState === "failed") {
      setLiveStatus("Connection failed");
    } else if (pc.connectionState === "connected") {
      setLiveStatus("Live");
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  if (!pc.localDescription) {
    throw new Error("Missing local description");
  }

  if (!OFFER_ENDPOINT) {
    throw new Error("Offer endpoint unavailable");
  }

  const response = await apiClient.fetch(withSession(OFFER_ENDPOINT), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
    }),
  });

  if (!response.ok) {
    throw new Error(`offer failed with status ${response.status}`);
  }

  const answer = await response.json();
  if (!answer || typeof answer.sdp !== "string" || typeof answer.type !== "string") {
    throw new Error("invalid answer");
  }

  const rtcAnswer = new RTCSessionDescription({ sdp: answer.sdp, type: answer.type });
  await pc.setRemoteDescription(rtcAnswer);

  dom.liveAudio.play().catch(() => undefined);
}
