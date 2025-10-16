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

  function createTransportController(context) {
    const {
      dom,
      state,
      waveformState,
      clamp,
      hasPlayableSource,
      clampPlaybackRateValue,
      formatTransportClock,
      formatPlaybackRateLabel,
      transportScrubMax,
      transportStorageKey,
    } = context || {};

    if (!dom || !state || !waveformState) {
      throw new Error("Transport controller requires DOM, state, and waveform references.");
    }
    if (typeof clamp !== "function") {
      throw new Error("Transport controller requires a clamp helper function.");
    }
    if (typeof hasPlayableSource !== "function") {
      throw new Error("Transport controller requires a playable source checker.");
    }
    if (typeof clampPlaybackRateValue !== "function") {
      throw new Error("Transport controller requires a playback rate clamp helper.");
    }
    if (typeof formatTransportClock !== "function") {
      throw new Error("Transport controller requires a transport clock formatter.");
    }
    if (typeof formatPlaybackRateLabel !== "function") {
      throw new Error("Transport controller requires a playback rate label formatter.");
    }

    const scrubMax = Number.isFinite(transportScrubMax) ? transportScrubMax : 1000;
    const storageKey = typeof transportStorageKey === "string" ? transportStorageKey : "";

    const transportState = {
      keys: new Set(),
      direction: 0,
      animationFrame: null,
      lastTimestamp: null,
      wasPlaying: false,
      isJogging: false,
      scrubbing: false,
      scrubWasPlaying: false,
      lastUserVolume: 1,
    };

    const transportPreferences = {
      volume: 1,
      muted: false,
      playbackRate: 1,
    };

    function getPlayerDurationSeconds() {
      if (!dom.player) {
        return Number.NaN;
      }

      const nativeDuration = Number(dom.player.duration);
      if (Number.isFinite(nativeDuration) && nativeDuration > 0) {
        return nativeDuration;
      }

      const seekable = dom.player.seekable;
      if (seekable && typeof seekable.length === "number" && seekable.length > 0) {
        try {
          const end = seekable.end(seekable.length - 1);
          if (Number.isFinite(end) && end > 0) {
            return end;
          }
        } catch (error) {
          /* ignore seekable errors */
        }
      }

      if (Number.isFinite(waveformState.duration) && waveformState.duration > 0) {
        return waveformState.duration;
      }

      const record = state.current;
      if (record && record.duration_seconds !== undefined) {
        const recordDuration = Number(record.duration_seconds);
        if (Number.isFinite(recordDuration) && recordDuration > 0) {
          return recordDuration;
        }
      }

      return Number.NaN;
    }

    function clampVolume(value) {
      if (!Number.isFinite(value)) {
        return 1;
      }
      return clamp(value, 0, 1);
    }

    function loadTransportPreferences() {
      if (typeof window === "undefined" || !window.localStorage || !storageKey) {
        return;
      }
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) {
          return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
          return;
        }
        transportPreferences.volume = 1;
        transportPreferences.muted = false;
        if (Number.isFinite(parsed.playbackRate)) {
          transportPreferences.playbackRate = clampPlaybackRateValue(parsed.playbackRate);
        }
      } catch (error) {
        console.warn("Unable to restore transport preferences", error);
      }
    }

    function persistTransportPreferences() {
      if (typeof window === "undefined" || !window.localStorage || !storageKey) {
        return;
      }
      try {
        const payload = {
          volume: 1,
          muted: false,
          playbackRate: clampPlaybackRateValue(
            dom.player ? dom.player.playbackRate : transportPreferences.playbackRate,
          ),
        };
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch (error) {
        console.warn("Unable to persist transport preferences", error);
      }
    }

    function applyTransportPreferences() {
      if (!dom.player) {
        return;
      }
      transportPreferences.volume = 1;
      transportPreferences.muted = false;
      dom.player.volume = clampVolume(transportPreferences.volume);
      dom.player.muted = transportPreferences.muted;
      dom.player.playbackRate = clampPlaybackRateValue(transportPreferences.playbackRate);
    }

    function ensureTransportRateOption(rate) {
      if (!dom.transportSpeed) {
        return;
      }
      const normalized = clampPlaybackRateValue(rate);
      const existing = Array.from(dom.transportSpeed.options || []).find((option) => {
        return Number.parseFloat(option.value) === normalized;
      });
      if (existing) {
        return;
      }
      const option = document.createElement("option");
      option.value = normalized.toString();
      option.textContent = formatPlaybackRateLabel(normalized);
      dom.transportSpeed.append(option);
    }

    function setTransportActive(active) {
      if (!dom.transportContainer) {
        return;
      }
      dom.transportContainer.hidden = !active;
      dom.transportContainer.dataset.active = active ? "true" : "false";
      if (!active) {
        dom.transportContainer.removeAttribute("data-ready");
      }
    }

    function setTransportControlsDisabled(disabled) {
      const controls = [
        dom.transportRestart,
        dom.transportRewind,
        dom.transportPlay,
        dom.transportForward,
        dom.transportEnd,
        dom.transportMute,
        dom.transportVolume,
        dom.transportSpeed,
      ];
      for (const control of controls) {
        if (!control) {
          continue;
        }
        control.disabled = disabled;
        if (disabled) {
          control.setAttribute("aria-disabled", "true");
        } else {
          control.removeAttribute("aria-disabled");
        }
      }
    }

    function resetTransportUi() {
      transportState.scrubbing = false;
      transportState.scrubWasPlaying = false;
      if (dom.transportScrubber) {
        dom.transportScrubber.value = "0";
        dom.transportScrubber.disabled = true;
        dom.transportScrubber.setAttribute("aria-valuemin", "0");
        dom.transportScrubber.setAttribute("aria-valuemax", scrubMax.toString());
        dom.transportScrubber.setAttribute("aria-valuenow", "0");
        dom.transportScrubber.setAttribute("aria-valuetext", "0:00");
      }
      if (dom.transportCurrent) {
        dom.transportCurrent.textContent = "0:00";
      }
      if (dom.transportDuration) {
        dom.transportDuration.textContent = "0:00";
      }
      setTransportControlsDisabled(true);
      updateTransportPlayState();
      updateTransportVolumeUI();
      updateTransportSpeedUI();
    }

    function updateTransportAvailability() {
      if (!dom.transportContainer) {
        return;
      }
      const active = Boolean(state.current);
      setTransportActive(active);
      if (!active) {
        resetTransportUi();
        return;
      }
      const ready = hasPlayableSource(dom.player);
      dom.transportContainer.dataset.ready = ready ? "true" : "false";
      setTransportControlsDisabled(!ready);
      if (dom.transportScrubber) {
        dom.transportScrubber.disabled = !ready;
      }
      updateTransportPlayState();
      updateTransportProgressUI();
      updateTransportVolumeUI();
      updateTransportSpeedUI();
    }

    function updateTransportPlayState() {
      if (!dom.transportPlay) {
        return;
      }
      const ready = Boolean(state.current) && hasPlayableSource(dom.player);
      const playing = ready && dom.player && !dom.player.paused && !dom.player.ended;
      dom.transportPlay.disabled = !ready;
      dom.transportPlay.setAttribute("aria-pressed", playing ? "true" : "false");
      const label = playing ? "Pause" : "Play";
      dom.transportPlay.setAttribute("aria-label", label);
      if (dom.transportPlayText) {
        dom.transportPlayText.textContent = label;
      } else {
        dom.transportPlay.textContent = label;
      }
      if (dom.transportPlayIcon) {
        dom.transportPlayIcon.textContent = playing ? "⏸" : "▶";
      }
    }

    function scrubValueToSeconds(value, duration) {
      if (!Number.isFinite(duration) || duration <= 0) {
        return 0;
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return 0;
      }
      const fraction = clamp(numeric / scrubMax, 0, 1);
      return duration * fraction;
    }

    function updateTransportProgressUI() {
      if (!dom.transportScrubber || !dom.transportCurrent || !dom.transportDuration) {
        return;
      }
      const ready = Boolean(state.current) && hasPlayableSource(dom.player);
      const duration = ready ? getPlayerDurationSeconds() : Number.NaN;
      if (!Number.isFinite(duration) || duration <= 0) {
        dom.transportScrubber.disabled = true;
        if (!transportState.scrubbing) {
          dom.transportScrubber.value = "0";
        }
        dom.transportScrubber.setAttribute("aria-valuemin", "0");
        dom.transportScrubber.setAttribute("aria-valuemax", scrubMax.toString());
        dom.transportScrubber.setAttribute("aria-valuenow", "0");
        dom.transportScrubber.setAttribute("aria-valuetext", "0:00");
        dom.transportCurrent.textContent = "0:00";
        dom.transportDuration.textContent = ready ? "0:00" : "0:00";
        return;
      }

      dom.transportScrubber.disabled = !ready;
      const currentTime = Number.isFinite(dom.player.currentTime)
        ? clamp(dom.player.currentTime, 0, duration)
        : 0;
      const fraction = clamp(currentTime / duration, 0, 1);
      const sliderValue = Math.round(fraction * scrubMax);
      if (!transportState.scrubbing) {
        dom.transportScrubber.value = sliderValue.toString();
      }
      dom.transportScrubber.setAttribute("aria-valuemin", "0");
      dom.transportScrubber.setAttribute("aria-valuemax", scrubMax.toString());
      const displaySeconds = transportState.scrubbing
        ? scrubValueToSeconds(dom.transportScrubber.value, duration)
        : currentTime;
      const ariaValue = transportState.scrubbing
        ? dom.transportScrubber.value
        : sliderValue.toString();
      dom.transportScrubber.setAttribute("aria-valuenow", ariaValue);
      const formattedCurrent = formatTransportClock(displaySeconds);
      dom.transportScrubber.setAttribute("aria-valuetext", formattedCurrent);
      dom.transportCurrent.textContent = formattedCurrent;
      dom.transportDuration.textContent = formatTransportClock(duration);
    }

    function updateTransportVolumeUI() {
      if (!dom.transportVolume && !dom.transportMute) {
        return;
      }
      const ready = Boolean(state.current) && hasPlayableSource(dom.player);
      const volume = dom.player ? clampVolume(dom.player.volume) : transportPreferences.volume;
      const muted = dom.player ? Boolean(dom.player.muted) : transportPreferences.muted;
      if (dom.transportVolume) {
        const sliderValue = Math.round(volume * 100);
        dom.transportVolume.value = sliderValue.toString();
        dom.transportVolume.disabled = !ready;
        dom.transportVolume.setAttribute("aria-valuenow", sliderValue.toString());
        dom.transportVolume.setAttribute("aria-valuetext", `${sliderValue}%`);
      }
      if (dom.transportMute) {
        dom.transportMute.disabled = !ready;
        const effectiveMuted = muted || volume === 0;
        dom.transportMute.setAttribute("aria-pressed", effectiveMuted ? "true" : "false");
        if (dom.transportMuteText) {
          dom.transportMuteText.textContent = effectiveMuted ? "Unmute" : "Mute";
        } else {
          dom.transportMute.textContent = effectiveMuted ? "Unmute" : "Mute";
        }
        if (dom.transportMuteIcon) {
          dom.transportMuteIcon.textContent = effectiveMuted ? "🔇" : "🔈";
        }
      }
    }

    function updateTransportSpeedUI() {
      if (!dom.transportSpeed) {
        return;
      }
      const ready = Boolean(state.current) && hasPlayableSource(dom.player);
      const playbackRate = dom.player
        ? clampPlaybackRateValue(dom.player.playbackRate)
        : transportPreferences.playbackRate;
      ensureTransportRateOption(playbackRate);
      dom.transportSpeed.value = playbackRate.toString();
      dom.transportSpeed.disabled = !ready;
    }

    function beginTransportScrub() {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      if (!transportState.scrubbing) {
        transportState.scrubbing = true;
        transportState.scrubWasPlaying = !dom.player.paused && !dom.player.ended;
        if (transportState.scrubWasPlaying) {
          try {
            dom.player.pause();
          } catch (error) {
            /* ignore pause errors */
          }
        }
      }
    }

    function commitTransportScrub() {
      if (!transportState.scrubbing) {
        return;
      }
      transportState.scrubbing = false;
      const duration = getPlayerDurationSeconds();
      if (dom.player && Number.isFinite(duration) && duration > 0 && dom.transportScrubber) {
        const nextSeconds = scrubValueToSeconds(dom.transportScrubber.value, duration);
        try {
          dom.player.currentTime = nextSeconds;
        } catch (error) {
          /* ignore seek errors */
        }
      }
      const shouldResume = transportState.scrubWasPlaying;
      transportState.scrubWasPlaying = false;
      updateTransportProgressUI();
      if (shouldResume && dom.player) {
        dom.player.play().catch(() => undefined);
      }
    }

    function skipTransportBy(offsetSeconds) {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      const duration = getPlayerDurationSeconds();
      if (!Number.isFinite(duration) || duration <= 0) {
        return;
      }
      const currentTime = Number.isFinite(dom.player.currentTime) ? dom.player.currentTime : 0;
      const nextTime = clamp(currentTime + offsetSeconds, 0, duration);
      try {
        dom.player.currentTime = nextTime;
      } catch (error) {
        /* ignore seek errors */
      }
      updateTransportProgressUI();
    }

    function restartTransport() {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      const wasPlaying = !dom.player.paused && !dom.player.ended;
      try {
        dom.player.currentTime = 0;
      } catch (error) {
        /* ignore seek errors */
      }
      updateTransportProgressUI();
      if (wasPlaying) {
        dom.player.play().catch(() => undefined);
      }
    }

    function jumpToTransportEnd() {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      const duration = getPlayerDurationSeconds();
      if (!Number.isFinite(duration) || duration <= 0) {
        return;
      }
      try {
        dom.player.currentTime = duration;
      } catch (error) {
        /* ignore seek errors */
      }
      updateTransportProgressUI();
    }

    function rememberLastUserVolume(volume) {
      const normalized = clampVolume(volume);
      if (normalized > 0) {
        transportState.lastUserVolume = normalized;
      }
    }

    function handleTransportMuteToggle() {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      const currentlyMuted = dom.player.muted || dom.player.volume === 0;
      if (currentlyMuted) {
        dom.player.muted = false;
        const restoreVolume = transportState.lastUserVolume > 0 ? transportState.lastUserVolume : 1;
        dom.player.volume = clampVolume(restoreVolume);
      } else {
        rememberLastUserVolume(dom.player.volume);
        dom.player.muted = true;
      }
    }

    function handleTransportVolumeInput(event) {
      if (!dom.player || !(event.target instanceof HTMLInputElement)) {
        return;
      }
      const percent = Number.parseInt(event.target.value, 10);
      if (!Number.isFinite(percent)) {
        return;
      }
      const volume = clampVolume(percent / 100);
      if (volume > 0) {
        dom.player.muted = false;
        dom.player.volume = volume;
      } else {
        dom.player.volume = 0;
        dom.player.muted = true;
      }
    }

    function handleTransportSpeedChange(event) {
      if (!dom.player || !(event.target instanceof HTMLSelectElement)) {
        return;
      }
      const rate = clampPlaybackRateValue(Number.parseFloat(event.target.value));
      dom.player.playbackRate = rate;
    }

    function handleTransportPlayToggle() {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      if (dom.player.paused || dom.player.ended) {
        dom.player.play().catch(() => undefined);
      } else {
        try {
          dom.player.pause();
        } catch (error) {
          /* ignore pause errors */
        }
      }
    }

    function handleTransportScrubberInput() {
      if (!dom.player || !dom.transportScrubber || !hasPlayableSource(dom.player)) {
        return;
      }
      beginTransportScrub();
      updateTransportProgressUI();
    }

    function handleTransportScrubberCommit() {
      commitTransportScrub();
    }

    function handleTransportScrubberPointerDown() {
      if (!dom.player || !hasPlayableSource(dom.player)) {
        return;
      }
      beginTransportScrub();
    }

    function handleTransportScrubberPointerUp() {
      handleTransportScrubberCommit();
    }

    function handleTransportScrubberBlur() {
      if (transportState.scrubbing) {
        handleTransportScrubberCommit();
      }
    }

    function handlePlayerVolumeChange() {
      if (!dom.player) {
        return;
      }
      const volume = clampVolume(dom.player.volume);
      const muted = Boolean(dom.player.muted);
      if (!muted && volume > 0) {
        rememberLastUserVolume(volume);
      }
      transportPreferences.volume = volume;
      transportPreferences.muted = muted;
      updateTransportVolumeUI();
      persistTransportPreferences();
    }

    function handlePlayerRateChange() {
      if (!dom.player) {
        return;
      }
      const rate = clampPlaybackRateValue(dom.player.playbackRate);
      transportPreferences.playbackRate = rate;
      updateTransportSpeedUI();
      persistTransportPreferences();
    }

    return {
      transportState,
      getPlayerDurationSeconds,
      loadTransportPreferences,
      applyTransportPreferences,
      setTransportActive,
      resetTransportUi,
      updateTransportAvailability,
      updateTransportPlayState,
      updateTransportProgressUI,
      skipTransportBy,
      restartTransport,
      jumpToTransportEnd,
      handleTransportMuteToggle,
      handleTransportVolumeInput,
      handleTransportSpeedChange,
      handleTransportPlayToggle,
      handleTransportScrubberInput,
      handleTransportScrubberCommit,
      handleTransportScrubberPointerDown,
      handleTransportScrubberPointerUp,
      handleTransportScrubberBlur,
      handlePlayerVolumeChange,
      handlePlayerRateChange,
    };
  }

  componentRegistry.createTransportController = createTransportController;
})();
