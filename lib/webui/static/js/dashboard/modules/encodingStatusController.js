function requireFunction(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`${name} must be a function.`);
  }
  return fn;
}

export function createEncodingStatusController(options = {}) {
  const {
    dom,
    encodingStatusState,
    encodingStatusTicker,
    formatShortDuration,
    formatEncodingSource,
    normalizeEncodingSource,
    nowMilliseconds,
    toFiniteOrNull,
  } = options;

  if (!dom) {
    throw new Error("Encoding status controller requires dashboard DOM references.");
  }
  if (!encodingStatusState) {
    throw new Error("Encoding status controller requires a state object.");
  }
  if (!encodingStatusTicker) {
    throw new Error("Encoding status controller requires a ticker reference.");
  }

  const formatDuration = requireFunction(formatShortDuration, "formatShortDuration");
  const formatSource = requireFunction(formatEncodingSource, "formatEncodingSource");
  const normalizeSource = requireFunction(normalizeEncodingSource, "normalizeEncodingSource");
  const getTime = requireFunction(nowMilliseconds, "nowMilliseconds");
  const toFinite = requireFunction(toFiniteOrNull, "toFiniteOrNull");

  function scheduleEncodingStatusTick() {
    if (!encodingStatusState.hasActive) {
      return;
    }
    if (encodingStatusTicker.handle !== null) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      encodingStatusTicker.handle = window.requestAnimationFrame(handleEncodingStatusTick);
      encodingStatusTicker.usingAnimationFrame = true;
    } else {
      encodingStatusTicker.handle = setTimeout(() => {
        encodingStatusTicker.handle = null;
        handleEncodingStatusTick();
      }, 500);
      encodingStatusTicker.usingAnimationFrame = false;
    }
  }

  function cancelEncodingStatusTick() {
    if (encodingStatusTicker.handle === null) {
      return;
    }
    if (
      encodingStatusTicker.usingAnimationFrame &&
      typeof window !== "undefined" &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(encodingStatusTicker.handle);
    } else {
      clearTimeout(encodingStatusTicker.handle);
    }
    encodingStatusTicker.handle = null;
    encodingStatusTicker.usingAnimationFrame = false;
  }

  function handleEncodingStatusTick() {
    encodingStatusTicker.handle = null;
    if (!encodingStatusState.hasActive) {
      return;
    }
    renderEncodingStatus();
    scheduleEncodingStatusTick();
  }

  function renderEncodingStatus() {
    if (!dom.encodingStatus || !dom.encodingStatusText) {
      return;
    }
    if (!encodingStatusState.visible) {
      if (dom.encodingStatus.dataset.visible !== "false") {
        dom.encodingStatus.dataset.visible = "false";
        dom.encodingStatus.setAttribute("aria-hidden", "true");
        dom.encodingStatusText.textContent = "";
      }
      encodingStatusState.text = "";
      return;
    }
    let durationSeconds = Math.max(0, encodingStatusState.durationBase);
    if (encodingStatusState.hasActive) {
      durationSeconds = Math.max(
        0,
        encodingStatusState.durationBase + (getTime() - encodingStatusState.baseTime) / 1000,
      );
    }
    const parts = [];
    if (encodingStatusState.hasActive) {
      const sourceLabel = formatSource(encodingStatusState.activeSource);
      const activeCount = Math.max(1, encodingStatusState.activeCount || 0);
      let statusLabel = sourceLabel ? `Encoding active (${sourceLabel})` : "Encoding active";
      if (activeCount > 1) {
        statusLabel = `${statusLabel} (${activeCount} jobs)`;
      }
      parts.push(statusLabel);
      if (encodingStatusState.activeLabel) {
        parts.push(encodingStatusState.activeLabel);
      }
      parts.push(formatDuration(durationSeconds));
      if (encodingStatusState.additionalActive > 0) {
        parts.push(`+${encodingStatusState.additionalActive} more active`);
      }
      if (encodingStatusState.pendingCount > 0) {
        parts.push(
          encodingStatusState.pendingCount === 1
            ? "1 pending"
            : `${encodingStatusState.pendingCount} pending`,
        );
      }
    } else {
      parts.push("Encoding pending");
      if (encodingStatusState.pendingCount > 0) {
        parts.push(
          encodingStatusState.pendingCount === 1
            ? "1 job queued"
            : `${encodingStatusState.pendingCount} jobs queued`,
        );
      }
      const nextSourceLabel = formatSource(encodingStatusState.nextSource);
      if (encodingStatusState.nextLabel) {
        const suffix = nextSourceLabel ? ` (${nextSourceLabel})` : "";
        parts.push(`Next: ${encodingStatusState.nextLabel}${suffix}`);
      } else if (nextSourceLabel) {
        parts.push(nextSourceLabel);
      }
    }
    const text = parts.join(" • ");
    if (text === encodingStatusState.text) {
      return;
    }
    dom.encodingStatusText.textContent = text;
    dom.encodingStatus.dataset.visible = "true";
    dom.encodingStatus.setAttribute("aria-hidden", "false");
    encodingStatusState.text = text;
  }

  function hideEncodingStatus() {
    if (!dom.encodingStatus || !dom.encodingStatusText) {
      return;
    }
    cancelEncodingStatusTick();
    encodingStatusState.visible = false;
    encodingStatusState.hasActive = false;
    encodingStatusState.durationBase = 0;
    encodingStatusState.baseTime = getTime();
    encodingStatusState.activeLabel = "";
    encodingStatusState.activeSource = "";
    encodingStatusState.activeCount = 0;
    encodingStatusState.additionalActive = 0;
    encodingStatusState.pendingCount = 0;
    encodingStatusState.nextLabel = "";
    encodingStatusState.nextSource = "";
    encodingStatusState.text = "";
    dom.encodingStatus.dataset.visible = "false";
    dom.encodingStatus.setAttribute("aria-hidden", "true");
    dom.encodingStatusText.textContent = "";
  }

  function updateEncodingStatus(rawStatus) {
    if (!dom.encodingStatus || !dom.encodingStatusText) {
      return;
    }
    const status = rawStatus && typeof rawStatus === "object" ? rawStatus : null;
    const encoding = status && typeof status.encoding === "object" ? status.encoding : null;
    const pending = encoding && Array.isArray(encoding.pending) ? encoding.pending : [];
    const rawActive = encoding ? encoding.active : null;
    let activeList = [];
    if (Array.isArray(rawActive)) {
      activeList = rawActive.filter((item) => item && typeof item === "object");
    } else if (rawActive && typeof rawActive === "object") {
      activeList = [rawActive];
    }
    const active = activeList.length > 0 ? activeList[0] : null;

    if ((!pending || pending.length === 0) && activeList.length === 0) {
      hideEncodingStatus();
      return;
    }

    encodingStatusState.visible = true;
    encodingStatusState.pendingCount = Array.isArray(pending) ? pending.length : 0;
    encodingStatusState.nextLabel =
      encodingStatusState.pendingCount > 0 && typeof pending[0].base_name === "string"
        ? pending[0].base_name
        : "";
    encodingStatusState.nextSource =
      encodingStatusState.pendingCount > 0 && typeof pending[0].source === "string"
        ? normalizeSource(pending[0].source)
        : "";

    encodingStatusState.activeCount = activeList.length;
    encodingStatusState.additionalActive = Math.max(0, activeList.length - 1);

    if (active) {
      encodingStatusState.hasActive = true;
      encodingStatusState.activeLabel =
        typeof active.base_name === "string" ? active.base_name : "";
      encodingStatusState.activeSource =
        typeof active.source === "string" ? normalizeSource(active.source) : "";
      const startedAt = toFinite(active.started_at);
      let baseDuration = toFinite(active.duration_seconds);
      if (!Number.isFinite(baseDuration)) {
        baseDuration = startedAt !== null ? Math.max(0, Date.now() / 1000 - startedAt) : 0;
      }
      encodingStatusState.durationBase = Math.max(0, baseDuration || 0);
      encodingStatusState.baseTime = getTime();
    } else {
      encodingStatusState.hasActive = false;
      encodingStatusState.activeLabel = "";
      encodingStatusState.activeSource = "";
      encodingStatusState.durationBase = 0;
      encodingStatusState.baseTime = getTime();
    }

    encodingStatusState.text = "";
    renderEncodingStatus();
    if (encodingStatusState.hasActive) {
      scheduleEncodingStatusTick();
    } else {
      cancelEncodingStatusTick();
    }
  }

  return {
    scheduleEncodingStatusTick,
    cancelEncodingStatusTick,
    renderEncodingStatus,
    hideEncodingStatus,
    updateEncodingStatus,
  };
}

