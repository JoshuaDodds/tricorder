// Dashboard health and recorder uptime management helpers.
function defaultClamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function defaultGetServicesItems() {
  return [];
}

function ensureNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createHealthManager(options) {
  const {
    dom,
    healthState,
    updateHealthState,
    getServicesItems = defaultGetServicesItems,
    voiceRecorderUnit = "",
    formatIsoDateTime,
    formatBytes,
    formatRecorderUptimeValue,
    formatRecorderUptimeHint,
    toFiniteOrNull,
    clamp = defaultClamp,
    apiClient,
    healthEndpoint,
    ensureOfflineStateOnError,
    eventTriggerDebounceMs = 0,
    healthRefreshMinIntervalMs = 0,
    isEventStreamConnected = () => false,
    window: windowOverride = undefined,
    logger: loggerOverride = undefined,
  } = options;

  const windowRef =
    windowOverride !== undefined ? windowOverride : typeof window !== "undefined" ? window : null;
  const logger =
    loggerOverride !== undefined ? loggerOverride : typeof console !== "undefined" ? console : null;

  const debounceMs = Math.max(0, ensureNumber(eventTriggerDebounceMs, 0));
  const minRefreshInterval = Math.max(0, ensureNumber(healthRefreshMinIntervalMs, 0));

  const recorderUptimeState = {
    active: false,
    available: false,
    startEpoch: null,
    statusText: "Loading…",
    hint: "",
    timerId: null,
  };

  const refreshState = {
    refreshId: null,
    eventTimer: null,
    refreshPending: false,
    refreshIntervalMs: minRefreshInterval,
    fetchInFlight: false,
    fetchQueued: false,
  };

  function setSystemBannerVisible(visible) {
    if (!dom || !dom.systemBanner) {
      return;
    }
    if (visible) {
      dom.systemBanner.hidden = false;
      dom.systemBanner.dataset.visible = "true";
    } else {
      dom.systemBanner.dataset.visible = "false";
      dom.systemBanner.hidden = true;
    }
  }

  function renderSdCardBanner() {
    if (!dom || !dom.systemBanner || !dom.systemBannerMessage || !dom.systemBannerDetail) {
      return;
    }
    const sdCard = healthState ? healthState.sdCard : null;
    if (!sdCard || sdCard.warning_active !== true) {
      setSystemBannerVisible(false);
      dom.systemBannerDetail.textContent = "";
      return;
    }

    setSystemBannerVisible(true);

    const parts = [];
    const event = sdCard.last_event;
    if (event && typeof event === "object") {
      const when = typeof formatIsoDateTime === "function" ? formatIsoDateTime(event.timestamp) : "";
      if (when) {
        parts.push(`Last error ${when}`);
      }
      if (typeof event.message === "string" && event.message) {
        parts.push(event.message);
      }
    } else {
      const firstDetected =
        typeof formatIsoDateTime === "function" ? formatIsoDateTime(sdCard.first_detected_at) : "";
      if (firstDetected) {
        parts.push(`Warning first detected ${firstDetected}`);
      }
    }

    dom.systemBannerDetail.textContent = parts.join(" — ");
  }

  function renderResourceStats() {
    const resources = (healthState && healthState.resources) || {};
    const cpu = resources.cpu ?? null;
    if (dom && dom.cpuUsage) {
      if (cpu && Number.isFinite(cpu.percent)) {
        const clamped = clamp(cpu.percent, 0, 100);
        dom.cpuUsage.textContent = `${clamped.toFixed(clamped >= 100 ? 0 : 1)}%`;
      } else {
        dom.cpuUsage.textContent = "--";
      }
    }
    if (dom && dom.cpuLoadAverage) {
      if (cpu && Number.isFinite(cpu.load1m)) {
        const loadParts = [`load ${cpu.load1m.toFixed(2)}`];
        if (Number.isFinite(cpu.cores) && cpu.cores > 0) {
          const cores = Math.round(cpu.cores);
          loadParts.push(`${cores} ${cores === 1 ? "core" : "cores"}`);
        }
        dom.cpuLoadAverage.textContent = loadParts.join(" • ");
      } else {
        dom.cpuLoadAverage.textContent = "--";
      }
    }
    const memory = resources.memory ?? null;
    if (dom && dom.memoryUsage) {
      if (memory && Number.isFinite(memory.percent)) {
        const percent = clamp(memory.percent, 0, 100);
        dom.memoryUsage.textContent = `${percent.toFixed(percent >= 100 ? 0 : 1)}%`;
      } else {
        dom.memoryUsage.textContent = "--";
      }
    }
    if (dom && dom.memoryDetail) {
      if (memory) {
        const parts = [];
        if (Number.isFinite(memory.usedBytes) && Number.isFinite(memory.totalBytes)) {
          const used = typeof formatBytes === "function" ? formatBytes(memory.usedBytes) : `${memory.usedBytes}`;
          const total = typeof formatBytes === "function" ? formatBytes(memory.totalBytes) : `${memory.totalBytes}`;
          parts.push(`${used} / ${total}`);
        } else if (Number.isFinite(memory.totalBytes)) {
          const total = typeof formatBytes === "function" ? formatBytes(memory.totalBytes) : `${memory.totalBytes}`;
          parts.push(`${total} total`);
        }
        if (Number.isFinite(memory.availableBytes)) {
          const available =
            typeof formatBytes === "function" ? formatBytes(memory.availableBytes) : `${memory.availableBytes}`;
          parts.push(`${available} free`);
        }
        dom.memoryDetail.textContent = parts.length ? parts.join(" • ") : "--";
      } else {
        dom.memoryDetail.textContent = "--";
      }
    }
    const temperature = resources.temperature ?? null;
    if (dom && dom.temperatureValue) {
      let celsius = null;
      if (temperature && typeof temperature === "object") {
        if (typeof toFiniteOrNull === "function") {
          celsius = toFiniteOrNull(temperature.celsius);
        }
        if (celsius === null && typeof toFiniteOrNull === "function") {
          const fahrenheit = toFiniteOrNull(temperature.fahrenheit);
          if (fahrenheit !== null) {
            celsius = ((fahrenheit - 32) * 5) / 9;
          }
        }
      }
      if (celsius !== null && Number.isFinite(celsius)) {
        const clamped = clamp(celsius, -100, 200);
        dom.temperatureValue.textContent = `${clamped.toFixed(Math.abs(clamped) >= 100 ? 0 : 1)}°C`;
      } else {
        dom.temperatureValue.textContent = "--";
      }
    }
    if (dom && dom.temperatureDetail) {
      let detail = "--";
      if (temperature && typeof temperature === "object") {
        const parts = [];
        if (typeof toFiniteOrNull === "function") {
          const fahrenheit = toFiniteOrNull(temperature.fahrenheit);
          if (fahrenheit !== null && Number.isFinite(fahrenheit)) {
            const clampedF = clamp(fahrenheit, -100, 392);
            parts.push(`${clampedF.toFixed(Math.abs(clampedF) >= 100 ? 0 : 1)}°F`);
          }
        }
        if (typeof temperature.sensor === "string" && temperature.sensor) {
          parts.push(temperature.sensor);
        }
        if (temperature.throttled === true) {
          const reasonText = Array.isArray(temperature.throttleReasons) && temperature.throttleReasons.length
            ? temperature.throttleReasons.join(", ")
            : "Active";
          parts.push(`Throttled${reasonText ? ` (${reasonText})` : ""}`);
        } else if (temperature.throttled === false) {
          parts.push("Not throttled");
        }
        if (parts.length) {
          detail = parts.join(" • ");
        }
      }
      dom.temperatureDetail.textContent = detail;
    }
  }

  function stopRecorderUptimeTimer() {
    if (!windowRef) {
      recorderUptimeState.timerId = null;
      return;
    }
    if (recorderUptimeState.timerId) {
      windowRef.clearInterval(recorderUptimeState.timerId);
      recorderUptimeState.timerId = null;
    }
  }

  function renderRecorderUptime() {
    if (!dom || !dom.recorderUptimeValue) {
      return;
    }
    let valueText = recorderUptimeState.statusText || "--";
    let hintText = recorderUptimeState.hint || "";
    if (recorderUptimeState.active && Number.isFinite(recorderUptimeState.startEpoch)) {
      const now = Date.now() / 1000;
      const uptimeSeconds = Math.max(0, now - recorderUptimeState.startEpoch);
      valueText =
        typeof formatRecorderUptimeValue === "function"
          ? formatRecorderUptimeValue(uptimeSeconds)
          : `${uptimeSeconds}`;
      hintText =
        typeof formatRecorderUptimeHint === "function"
          ? formatRecorderUptimeHint(recorderUptimeState.startEpoch)
          : "";
    }
    dom.recorderUptimeValue.textContent = valueText;
    if (dom.recorderUptimeHint) {
      if (hintText) {
        dom.recorderUptimeHint.textContent = hintText;
        dom.recorderUptimeHint.hidden = false;
      } else {
        dom.recorderUptimeHint.textContent = "";
        dom.recorderUptimeHint.hidden = true;
      }
    }
  }

  function ensureRecorderUptimeTimer() {
    if (!windowRef || recorderUptimeState.timerId) {
      return;
    }
    recorderUptimeState.timerId = windowRef.setInterval(() => {
      if (!recorderUptimeState.active) {
        stopRecorderUptimeTimer();
        return;
      }
      renderRecorderUptime();
    }, 1000);
  }

  function setRecorderUptimeStatus(statusText, options = {}) {
    const { available = false, hint = "" } = options;
    recorderUptimeState.active = false;
    recorderUptimeState.available = Boolean(available);
    recorderUptimeState.startEpoch = null;
    recorderUptimeState.statusText = statusText || "--";
    recorderUptimeState.hint = hint || "";
    stopRecorderUptimeTimer();
    renderRecorderUptime();
  }

  function setRecorderUptimeActive(startEpoch) {
    if (!Number.isFinite(startEpoch) || startEpoch <= 0) {
      setRecorderUptimeStatus("Running", { available: true });
      return;
    }
    recorderUptimeState.available = true;
    recorderUptimeState.active = true;
    recorderUptimeState.startEpoch = startEpoch;
    recorderUptimeState.statusText = "";
    recorderUptimeState.hint = "";
    renderRecorderUptime();
    ensureRecorderUptimeTimer();
  }

  function isRecorderUptimeKnown() {
    return recorderUptimeState.active || recorderUptimeState.startEpoch !== null;
  }

  function updateRecorderUptimeFromServices() {
    const services = getServicesItems() || [];
    const voiceService = services.find((item) => item && item.unit === voiceRecorderUnit);
    if (!voiceService) {
      setRecorderUptimeStatus("Unavailable");
      return;
    }
    if (voiceService.available === false) {
      const hint = voiceService.error || voiceService.status_text || "";
      setRecorderUptimeStatus("Unavailable", { hint });
      return;
    }
    if (!voiceService.is_active) {
      const hint = voiceService.status_text || "";
      setRecorderUptimeStatus("Stopped", { available: true, hint });
      return;
    }
    if (Number.isFinite(voiceService.activeEnterEpoch)) {
      setRecorderUptimeActive(voiceService.activeEnterEpoch);
      return;
    }
    const hint = voiceService.status_text || "";
    setRecorderUptimeStatus("Running", { available: true, hint });
  }

  function resetHealthState() {
    if (typeof updateHealthState !== "function") {
      return;
    }
    updateHealthState((draft) => {
      draft.sdCard = null;
      draft.lastUpdated = null;
      if (draft.resources && typeof draft.resources === "object") {
        draft.resources.cpu = null;
        draft.resources.memory = null;
        draft.resources.temperature = null;
      }
    }, "health:reset");
  }

  function applyHealthPayload(payload) {
    if (!payload || typeof payload !== "object") {
      resetHealthState();
      renderSdCardBanner();
      renderResourceStats();
      return;
    }

    const sdCard = payload.sd_card;
    let nextSdCard = null;
    if (sdCard && typeof sdCard === "object") {
      nextSdCard = {
        warning_active: sdCard.warning_active === true,
        first_detected_at:
          typeof sdCard.first_detected_at === "string" ? sdCard.first_detected_at : null,
        last_event: null,
      };
      if (sdCard.last_event && typeof sdCard.last_event === "object") {
        nextSdCard.last_event = {
          timestamp:
            typeof sdCard.last_event.timestamp === "string" ? sdCard.last_event.timestamp : null,
          message: typeof sdCard.last_event.message === "string" ? sdCard.last_event.message : "",
        };
      }
    }

    let nextCpu = null;
    let nextMemory = null;
    let nextTemperature = null;
    const resources = payload.resources;
    if (resources && typeof resources === "object") {
      const cpu = resources.cpu;
      if (cpu && typeof cpu === "object") {
        const load1mValue =
          typeof cpu.load_1m !== "undefined" ? cpu.load_1m : typeof cpu.load1m !== "undefined" ? cpu.load1m : null;
        nextCpu = {
          percent: typeof toFiniteOrNull === "function" ? toFiniteOrNull(cpu.percent) : null,
          load1m: typeof toFiniteOrNull === "function" ? toFiniteOrNull(load1mValue) : null,
          cores: Number.isFinite(cpu.cores) ? cpu.cores : null,
        };
      }

      const memory = resources.memory;
      if (memory && typeof memory === "object") {
        nextMemory = {
          percent: typeof toFiniteOrNull === "function" ? toFiniteOrNull(memory.percent) : null,
          totalBytes: typeof toFiniteOrNull === "function" ? toFiniteOrNull(memory.total_bytes) : null,
          usedBytes: typeof toFiniteOrNull === "function" ? toFiniteOrNull(memory.used_bytes) : null,
          availableBytes: typeof toFiniteOrNull === "function" ? toFiniteOrNull(memory.available_bytes) : null,
        };
      }

      const temperature = resources.temperature;
      if (temperature && typeof temperature === "object") {
        const celsiusSource =
          typeof temperature.celsius !== "undefined" ? temperature.celsius : temperature.celsius_c;
        const fahrenheitSource =
          typeof temperature.fahrenheit !== "undefined" ? temperature.fahrenheit : temperature.fahrenheit_f;
        const throttleState =
          temperature.throttled === true
            ? true
            : temperature.throttled === false
              ? false
              : null;
        const throttleReasonsRaw = Array.isArray(temperature.throttleReasons)
          ? temperature.throttleReasons
          : Array.isArray(temperature.throttle_reasons)
            ? temperature.throttle_reasons
            : typeof temperature.throttle_reason === "string"
              ? temperature.throttle_reason
                  .split(/[;,]/)
                  .map((item) => item.trim())
                  .filter(Boolean)
              : [];
        const throttleReasons = Array.from(
          new Set(throttleReasonsRaw.filter((item) => typeof item === "string" && item)),
        );
        nextTemperature = {
          celsius: typeof toFiniteOrNull === "function" ? toFiniteOrNull(celsiusSource) : null,
          fahrenheit: typeof toFiniteOrNull === "function" ? toFiniteOrNull(fahrenheitSource) : null,
          sensor: typeof temperature.sensor === "string" ? temperature.sensor : null,
          throttled: throttleState,
          throttleReasons,
        };
      }
    }

    const hasTimestamp = typeof payload.generated_at === "number";
    const nextTimestamp = hasTimestamp ? payload.generated_at : null;

    if (typeof updateHealthState === "function") {
      updateHealthState((draft) => {
        if (hasTimestamp) {
          draft.lastUpdated = nextTimestamp;
        }
        draft.sdCard = nextSdCard;
        if (draft.resources && typeof draft.resources === "object") {
          draft.resources.cpu = nextCpu;
          draft.resources.memory = nextMemory;
          draft.resources.temperature = nextTemperature;
        }
      }, "health:payload");
    }

    renderSdCardBanner();
    renderResourceStats();
  }

  async function fetchSystemHealth() {
    if (!apiClient || typeof apiClient.fetch !== "function" || !healthEndpoint) {
      return;
    }
    if (refreshState.fetchInFlight) {
      refreshState.fetchQueued = true;
      return;
    }
    refreshState.fetchInFlight = true;
    try {
      const response = await apiClient.fetch(healthEndpoint, { cache: "no-store" });
      if (!response || !response.ok) {
        throw new Error(
          response ? `System health request failed with ${response.status}` : "System health request failed",
        );
      }
      const payload = await response.json();
      applyHealthPayload(payload);
    } catch (error) {
      if (logger && typeof logger.error === "function") {
        logger.error("Failed to fetch system health", error);
      }
      if (typeof ensureOfflineStateOnError === "function") {
        ensureOfflineStateOnError(error);
      }
    } finally {
      refreshState.fetchInFlight = false;
      if (refreshState.fetchQueued) {
        refreshState.fetchQueued = false;
        fetchSystemHealth();
      }
    }
  }

  function clearHealthEventTimer() {
    if (!windowRef) {
      refreshState.eventTimer = null;
      return;
    }
    if (refreshState.eventTimer !== null) {
      windowRef.clearTimeout(refreshState.eventTimer);
      refreshState.eventTimer = null;
    }
  }

  function requestSystemHealthRefresh({ immediate = false } = {}) {
    if (!windowRef) {
      if (immediate) {
        refreshState.refreshPending = false;
        fetchSystemHealth();
      } else {
        refreshState.refreshPending = true;
      }
      return;
    }
    if (immediate) {
      clearHealthEventTimer();
      refreshState.refreshPending = false;
      fetchSystemHealth();
      return;
    }
    if (refreshState.eventTimer !== null) {
      refreshState.refreshPending = true;
      return;
    }
    refreshState.refreshPending = true;
    refreshState.eventTimer = windowRef.setTimeout(() => {
      refreshState.eventTimer = null;
      if (!windowRef) {
        refreshState.refreshPending = true;
        return;
      }
      refreshState.refreshPending = false;
      fetchSystemHealth();
    }, debounceMs);
  }

  function stopHealthRefresh() {
    if (windowRef && refreshState.refreshId !== null) {
      windowRef.clearInterval(refreshState.refreshId);
    }
    refreshState.refreshId = null;
    if (windowRef) {
      clearHealthEventTimer();
      if (refreshState.eventTimer === null) {
        refreshState.refreshPending = true;
      }
    }
  }

  function startHealthRefresh() {
    stopHealthRefresh();
    if (!windowRef) {
      fetchSystemHealth();
      return;
    }
    if (isEventStreamConnected()) {
      if (refreshState.refreshPending) {
        requestSystemHealthRefresh({ immediate: true });
      }
      return;
    }
    fetchSystemHealth();
    refreshState.refreshId = windowRef.setInterval(() => {
      fetchSystemHealth();
    }, Math.max(refreshState.refreshIntervalMs, minRefreshInterval));
  }

  function restartHealthRefresh() {
    if (refreshState.refreshId === null) {
      return;
    }
    startHealthRefresh();
  }

  function setHealthRefreshInterval(intervalMs) {
    const clamped = Math.max(minRefreshInterval, ensureNumber(intervalMs, minRefreshInterval));
    if (refreshState.refreshIntervalMs === clamped) {
      return;
    }
    refreshState.refreshIntervalMs = clamped;
    restartHealthRefresh();
  }

  return {
    renderRecorderUptime,
    setRecorderUptimeStatus,
    setRecorderUptimeActive,
    updateRecorderUptimeFromServices,
    fetchSystemHealth,
    requestSystemHealthRefresh,
    startHealthRefresh,
    stopHealthRefresh,
    restartHealthRefresh,
    setHealthRefreshInterval,
    renderSdCardBanner,
    renderResourceStats,
    applyHealthPayload,
    isRecorderUptimeKnown,
  };
}

export { createHealthManager };
