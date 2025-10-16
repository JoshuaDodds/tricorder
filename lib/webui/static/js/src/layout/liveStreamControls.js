export function createLiveStreamControls(deps = {}) {
  const {
    dom,
    liveState,
    playbackState,
    ensureSessionId,
    setLiveStatus,
    sendStart,
    sendStop,
    scheduleLiveStats,
    cancelLiveStats,
    loadHlsLibrary,
    nativeHlsSupported,
    streamMode,
    hlsUrl,
    iceServers,
    offerEndpoint,
    apiClient,
    withSession,
    setLiveButtonState,
    focusElementSilently,
  } = deps;

  if (!dom || typeof dom !== "object") {
    throw new Error("createLiveStreamControls requires dashboard DOM references");
  }
  if (!liveState || typeof liveState !== "object") {
    throw new Error("createLiveStreamControls requires liveState");
  }
  if (!playbackState || typeof playbackState !== "object") {
    throw new Error("createLiveStreamControls requires playbackState");
  }
  if (typeof ensureSessionId !== "function") {
    throw new Error("createLiveStreamControls requires ensureSessionId");
  }
  if (typeof setLiveStatus !== "function") {
    throw new Error("createLiveStreamControls requires setLiveStatus");
  }
  if (typeof sendStart !== "function") {
    throw new Error("createLiveStreamControls requires sendStart");
  }
  if (typeof sendStop !== "function") {
    throw new Error("createLiveStreamControls requires sendStop");
  }
  if (typeof scheduleLiveStats !== "function") {
    throw new Error("createLiveStreamControls requires scheduleLiveStats");
  }
  if (typeof cancelLiveStats !== "function") {
    throw new Error("createLiveStreamControls requires cancelLiveStats");
  }
  if (typeof loadHlsLibrary !== "function") {
    throw new Error("createLiveStreamControls requires loadHlsLibrary");
  }
  if (typeof nativeHlsSupported !== "function") {
    throw new Error("createLiveStreamControls requires nativeHlsSupported");
  }
  if (typeof streamMode !== "string") {
    throw new Error("createLiveStreamControls requires streamMode string");
  }
  if (typeof hlsUrl !== "string") {
    throw new Error("createLiveStreamControls requires hlsUrl string");
  }
  if (!Array.isArray(iceServers)) {
    throw new Error("createLiveStreamControls requires iceServers array");
  }
  if (typeof apiClient !== "object" || typeof apiClient.fetch !== "function") {
    throw new Error("createLiveStreamControls requires apiClient.fetch");
  }
  if (typeof withSession !== "function") {
    throw new Error("createLiveStreamControls requires withSession");
  }
  if (typeof setLiveButtonState !== "function") {
    throw new Error("createLiveStreamControls requires setLiveButtonState");
  }
  if (typeof focusElementSilently !== "function") {
    throw new Error("createLiveStreamControls requires focusElementSilently");
  }

  async function waitForIceGatheringComplete(pc, { timeoutMs = 2500 } = {}) {
    if (!pc) {
      return;
    }
    if (pc.iceGatheringState === "complete") {
      return;
    }

    await new Promise((resolve) => {
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
    if (iceServers.length > 0) {
      pcConfig.iceServers = iceServers;
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

    if (!offerEndpoint) {
      throw new Error("Offer endpoint unavailable");
    }

    const response = await apiClient.fetch(withSession(offerEndpoint), {
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

  function detachLiveStream() {
    if (liveState.hls) {
      try {
        liveState.hls.destroy();
      } catch (error) {
        console.warn("Failed to destroy hls.js instance", error);
      }
      liveState.hls = null;
    }
    if (liveState.pc) {
      try {
        liveState.pc.close();
      } catch (error) {
        console.warn("Failed to close WebRTC connection", error);
      }
      liveState.pc = null;
    }
    if (liveState.stream) {
      try {
        const tracks = liveState.stream.getTracks();
        for (const track of tracks) {
          track.stop();
        }
      } catch (error) {
        console.warn("Failed to stop WebRTC tracks", error);
      }
      liveState.stream = null;
    }
    if (dom.liveAudio) {
      dom.liveAudio.pause();
      dom.liveAudio.removeAttribute("src");
      dom.liveAudio.srcObject = null;
      dom.liveAudio.load();
      playbackState.pausedViaSpacebar.delete(dom.liveAudio);
    }
  }

  function attachLiveStreamSource() {
    if (!dom.liveAudio) {
      return;
    }
    detachLiveStream();
    dom.liveAudio.autoplay = true;
    if (streamMode === "webrtc") {
      startWebRtcStream().catch((error) => {
        console.error("WebRTC setup failed", error);
        setLiveStatus("Error");
      });
      return;
    }
    if (nativeHlsSupported(dom.liveAudio)) {
      dom.liveAudio.src = hlsUrl;
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
          liveState.hls.loadSource(hlsUrl);
          liveState.hls.attachMedia(dom.liveAudio);
        } else {
          dom.liveAudio.src = hlsUrl;
        }
        dom.liveAudio.play().catch(() => undefined);
      })
      .catch(() => {
        dom.liveAudio.src = hlsUrl;
        dom.liveAudio.play().catch(() => undefined);
      });
  }

  function startLiveStream() {
    if (liveState.active) {
      return;
    }
    if (!dom.liveAudio) {
      return;
    }
    ensureSessionId();
    liveState.active = true;
    setLiveStatus("Connecting…");
    sendStart();
    attachLiveStreamSource();
    scheduleLiveStats();
  }

  function stopLiveStream({ sendSignal = true, useBeacon = false } = {}) {
    if (sendSignal) {
      sendStop(useBeacon);
    }
    cancelLiveStats();
    detachLiveStream();
    liveState.active = false;
    if (dom.liveClients) {
      dom.liveClients.textContent = "0";
    }
    if (dom.liveEncoder) {
      dom.liveEncoder.textContent = "stopped";
    }
    setLiveStatus("Idle");
    releaseLiveAudioFocus();
  }

  function openLiveStreamPanel() {
    if (liveState.open) {
      return;
    }
    liveState.open = true;
    if (dom.liveCard) {
      dom.liveCard.hidden = false;
      dom.liveCard.dataset.active = "true";
      dom.liveCard.setAttribute("aria-hidden", "false");
    }
    if (dom.livePanel) {
      dom.livePanel.classList.add("expanded");
      dom.livePanel.setAttribute("aria-hidden", "false");
    }
    setLiveButtonState(true);
    startLiveStream();
  }

  function closeLiveStreamPanel() {
    if (!liveState.open) {
      return;
    }
    liveState.open = false;
    if (dom.livePanel) {
      dom.livePanel.classList.remove("expanded");
      dom.livePanel.setAttribute("aria-hidden", "true");
    }
    if (dom.liveCard) {
      dom.liveCard.dataset.active = "false";
      dom.liveCard.hidden = true;
      dom.liveCard.setAttribute("aria-hidden", "true");
    }
    setLiveButtonState(false);
    stopLiveStream({ sendSignal: true });
  }

  function focusLiveStreamPanel() {
    if (!dom.livePanel || dom.livePanel.getAttribute("aria-hidden") === "true") {
      return false;
    }
    return focusElementSilently(dom.livePanel);
  }

  function focusPreviewSurface() {
    if (dom.waveformContainer && !dom.waveformContainer.hidden) {
      if (focusElementSilently(dom.waveformContainer)) {
        return true;
      }
    }
    if (
      dom.playerCard &&
      dom.playerCard.dataset.active === "true" &&
      dom.playerCard.hidden !== true
    ) {
      if (focusElementSilently(dom.playerCard)) {
        return true;
      }
    }
    return false;
  }

  function releaseLiveAudioFocus() {
    if (!dom.liveAudio || typeof document === "undefined") {
      return;
    }
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (active !== dom.liveAudio) {
      return;
    }
    if (focusLiveStreamPanel()) {
      return;
    }
    try {
      dom.liveAudio.blur();
    } catch (error) {
      /* ignore blur errors */
    }
  }

  return {
    stopLiveStream,
    openLiveStreamPanel,
    closeLiveStreamPanel,
    focusLiveStreamPanel,
    focusPreviewSurface,
    releaseLiveAudioFocus,
  };
}
