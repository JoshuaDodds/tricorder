import {
  MARKER_COLLAPSE_EPSILON_SECONDS,
  MARKER_LABEL_BASE_OFFSET_REM,
  MARKER_LABEL_EDGE_THRESHOLD,
  MARKER_LABEL_SPACING_THRESHOLD,
  MARKER_LABEL_STACK_SPACING_REM,
  WAVEFORM_REFRESH_INTERVAL_MS,
  WAVEFORM_ZOOM_DEFAULT,
  WAVEFORM_ZOOM_MAX,
  WAVEFORM_ZOOM_MIN,
} from "../../config.js";

let domRef = null;
let stateRef = null;
let configStateRef = null;
let waveformStateRef = null;
let clampRef = null;
let formatClockTimeRef = null;
let formatWaveformZoomRef = null;
let formatDurationRef = null;
let normalizeMotionSegmentsRef = null;
let toFiniteOrNullRef = null;
let recordWaveformUrlRef = null;
let renderRecordsRef = () => {};
let updatePlayerMetaRef = () => {};
let hideWaveformRmsRef = () => {};
let updateWaveformRmsRef = () => {};
let getPlayerDurationSecondsRef = null;
let focusPreviewSurfaceRef = () => {};
let getStoredWaveformAmplitudeRef = () => null;
let playbackStateRef = null;

function ensureInitialized() {
  if (!domRef || !waveformStateRef || typeof clampRef !== "function") {
    throw new Error("waveformControls not initialized");
  }
  if (typeof formatClockTimeRef !== "function") {
    throw new Error("waveformControls missing formatClockTime dependency");
  }
  if (typeof formatWaveformZoomRef !== "function") {
    throw new Error("waveformControls missing formatWaveformZoom dependency");
  }
  if (typeof normalizeMotionSegmentsRef !== "function") {
    throw new Error("waveformControls missing normalizeMotionSegments dependency");
  }
  if (typeof toFiniteOrNullRef !== "function") {
    throw new Error("waveformControls missing toFiniteOrNull dependency");
  }
  if (typeof recordWaveformUrlRef !== "function") {
    throw new Error("waveformControls missing recordWaveformUrl dependency");
  }
  if (typeof getPlayerDurationSecondsRef !== "function") {
    throw new Error("waveformControls missing getPlayerDurationSeconds dependency");
  }
  if (!playbackStateRef) {
    throw new Error("waveformControls missing playbackState dependency");
  }
}

export function initializeWaveformControls({
  dom,
  state,
  configState,
  waveformState,
  clamp,
  formatClockTime,
  formatWaveformZoom,
  formatDuration,
  normalizeMotionSegments,
  toFiniteOrNull,
  recordWaveformUrl,
  renderRecords,
  updatePlayerMeta,
  hideWaveformRms,
  updateWaveformRms,
  getPlayerDurationSeconds,
  focusPreviewSurface,
  getStoredWaveformAmplitude,
  playbackState,
} = {}) {
  domRef = dom;
  stateRef = state;
  configStateRef = configState;
  waveformStateRef = waveformState;
  clampRef = clamp;
  formatClockTimeRef = formatClockTime;
  formatWaveformZoomRef = formatWaveformZoom;
  formatDurationRef = formatDuration || ((value) => String(value));
  normalizeMotionSegmentsRef = normalizeMotionSegments;
  toFiniteOrNullRef = toFiniteOrNull;
  recordWaveformUrlRef = recordWaveformUrl;
  renderRecordsRef = typeof renderRecords === "function" ? renderRecords : () => {};
  updatePlayerMetaRef = typeof updatePlayerMeta === "function" ? updatePlayerMeta : () => {};
  hideWaveformRmsRef = typeof hideWaveformRms === "function" ? hideWaveformRms : () => {};
  updateWaveformRmsRef = typeof updateWaveformRms === "function" ? updateWaveformRms : () => {};
  getPlayerDurationSecondsRef = getPlayerDurationSeconds;
  focusPreviewSurfaceRef = typeof focusPreviewSurface === "function" ? focusPreviewSurface : () => {};
  getStoredWaveformAmplitudeRef = typeof getStoredWaveformAmplitude === "function"
    ? getStoredWaveformAmplitude
    : () => null;
  playbackStateRef = playbackState;

  ensureInitialized();
}

export function setCursorFraction(fraction) {
  ensureInitialized();
  const clamped = clampRef(fraction, 0, 1);
  waveformStateRef.lastFraction = clamped;
  if (domRef.waveformCursor) {
    domRef.waveformCursor.style.left = `${(clamped * 100).toFixed(3)}%`;
  }
  updateWaveformClock();
  updateWaveformRmsRef();
}

export function updateWaveformClock() {
  ensureInitialized();
  if (!domRef.waveformClock) {
    return;
  }
  const element = domRef.waveformClock;
  const parentRow =
    element.parentElement && element.parentElement.classList.contains("waveform-clock-row")
      ? element.parentElement
      : null;
  const containerReady = Boolean(domRef.waveformContainer && !domRef.waveformContainer.hidden);
  const duration = Number.isFinite(waveformStateRef.duration) && waveformStateRef.duration > 0
    ? waveformStateRef.duration
    : null;
  const startEpoch = Number.isFinite(waveformStateRef.startEpoch)
    ? waveformStateRef.startEpoch
    : null;
  if (!containerReady || duration === null || startEpoch === null) {
    element.textContent = "--:--:--";
    element.dataset.active = "false";
    element.setAttribute("aria-hidden", "true");
    if (parentRow) {
      parentRow.dataset.active = "false";
    }
    return;
  }
  const offsetSeconds = clampRef(waveformStateRef.lastFraction, 0, 1) * duration;
  const timestamp = startEpoch + offsetSeconds;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    element.textContent = "--:--:--";
    element.dataset.active = "false";
    element.setAttribute("aria-hidden", "true");
    if (parentRow) {
      parentRow.dataset.active = "false";
    }
    return;
  }
  element.textContent = formatClockTimeRef(timestamp);
  element.dataset.active = "true";
  element.setAttribute("aria-hidden", "false");
  if (parentRow) {
    parentRow.dataset.active = "true";
  }
}

export function setWaveformMarker(element, seconds, duration) {
  ensureInitialized();
  if (!element) {
    return null;
  }
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) {
    element.dataset.active = "false";
    element.style.left = "0%";
    element.setAttribute("aria-hidden", "true");
    delete element.dataset.align;
    element.style.removeProperty("--marker-label-top");
    return null;
  }
  const fraction = clampRef(seconds / duration, 0, 1);
  element.style.left = `${(fraction * 100).toFixed(3)}%`;
  element.dataset.active = "true";
  element.dataset.align = "center";
  element.setAttribute("aria-hidden", "false");
  element.style.removeProperty("--marker-label-top");
  return fraction;
}

export function layoutWaveformMarkerLabels(markers) {
  ensureInitialized();
  if (!Array.isArray(markers) || markers.length === 0) {
    return;
  }

  const validMarkers = markers.filter(
    (marker) => marker && marker.element && Number.isFinite(marker.fraction)
  );
  if (validMarkers.length === 0) {
    return;
  }

  for (const marker of validMarkers) {
    marker.element.dataset.align = "center";
    marker.element.style.removeProperty("--marker-label-top");
  }

  for (const marker of validMarkers) {
    if (marker.fraction <= MARKER_LABEL_EDGE_THRESHOLD) {
      marker.element.dataset.align = "left";
    } else if (marker.fraction >= 1 - MARKER_LABEL_EDGE_THRESHOLD) {
      marker.element.dataset.align = "right";
    }
  }

  const sortedMarkers = validMarkers.slice().sort((a, b) => a.fraction - b.fraction);
  let cluster = [];

  function applyCluster(entries) {
    if (!entries || entries.length <= 1) {
      return;
    }
    entries.forEach((entry, index) => {
      entry.element.style.setProperty(
        "--marker-label-top",
        `calc(${MARKER_LABEL_BASE_OFFSET_REM}rem + ${index} * ${MARKER_LABEL_STACK_SPACING_REM}rem)`
      );
    });
  }

  for (const marker of sortedMarkers) {
    if (cluster.length === 0) {
      cluster.push(marker);
      continue;
    }
    const previous = cluster[cluster.length - 1];
    if (marker.fraction - previous.fraction <= MARKER_LABEL_SPACING_THRESHOLD) {
      cluster.push(marker);
    } else {
      applyCluster(cluster);
      cluster = [marker];
    }
  }
  applyCluster(cluster);
}

export function renderMotionSegments(duration) {
  ensureInitialized();
  if (!domRef.waveformMotionSegments) {
    return;
  }

  const container = domRef.waveformMotionSegments;
  container.textContent = "";
  container.hidden = true;

  const segments = normalizeMotionSegmentsRef(waveformStateRef.motionSegments);
  if (!Number.isFinite(duration) || duration <= 0 || segments.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") {
      continue;
    }
    const startSeconds = Number(segment.start);
    if (!Number.isFinite(startSeconds)) {
      continue;
    }

    const clampedStart = clampRef(startSeconds, 0, duration);
    if (clampedStart >= duration) {
      continue;
    }

    let clampedEnd = null;
    if (Number.isFinite(segment.end)) {
      clampedEnd = clampRef(Number(segment.end), clampedStart, duration);
    }

    const element = document.createElement("div");
    element.className = "waveform-motion-segment";
    element.style.left = `${(clampedStart / duration) * 100}%`;

    if (clampedEnd === null) {
      element.dataset.open = "true";
      element.style.right = "0";
    } else {
      const widthFraction = Math.max(clampedEnd - clampedStart, 0) / duration;
      element.style.width = `${widthFraction * 100}%`;
    }

    fragment.appendChild(element);
  }

  if (fragment.childNodes.length > 0) {
    container.appendChild(fragment);
    container.hidden = false;
  }
}

export function setWaveformClipSelection(selection) {
  ensureInitialized();
  const element = domRef.waveformClipSelection;
  if (!element) {
    waveformStateRef.clipSelection = null;
    return;
  }

  const duration = selection && Number.isFinite(selection.durationSeconds)
    ? Math.max(selection.durationSeconds, 0)
    : null;
  const startValue = selection && Number.isFinite(selection.startSeconds)
    ? selection.startSeconds
    : null;
  const endValue = selection && Number.isFinite(selection.endSeconds)
    ? selection.endSeconds
    : null;

  if (duration === null || duration <= 0 || startValue === null || endValue === null) {
    element.dataset.active = "false";
    element.style.left = "0%";
    element.style.width = "0%";
    element.setAttribute("aria-hidden", "true");
    waveformStateRef.clipSelection = null;
    return;
  }

  const start = clampRef(Math.min(startValue, endValue), 0, duration);
  const end = clampRef(Math.max(startValue, endValue), 0, duration);
  if (!(end > start)) {
    element.dataset.active = "false";
    element.style.left = "0%";
    element.style.width = "0%";
    element.setAttribute("aria-hidden", "true");
    waveformStateRef.clipSelection = null;
    return;
  }

  const startFraction = clampRef(start / duration, 0, 1);
  const endFraction = clampRef(end / duration, 0, 1);
  element.style.left = `${(startFraction * 100).toFixed(3)}%`;
  element.style.width = `${((endFraction - startFraction) * 100).toFixed(3)}%`;
  element.dataset.active = "true";
  element.setAttribute("aria-hidden", "false");
  waveformStateRef.clipSelection = {
    startSeconds: start,
    endSeconds: end,
    durationSeconds: duration,
  };
}

export function updateWaveformMarkers() {
  ensureInitialized();
  const duration = Number.isFinite(waveformStateRef.duration) && waveformStateRef.duration > 0
    ? waveformStateRef.duration
    : 0;
  if (!stateRef?.current || duration <= 0) {
    waveformStateRef.triggerSeconds = null;
    waveformStateRef.releaseSeconds = null;
    waveformStateRef.motionTriggerSeconds = null;
    waveformStateRef.motionReleaseSeconds = null;
    waveformStateRef.motionSegments = [];
    setWaveformMarker(domRef.waveformTriggerMarker, null, null);
    setWaveformMarker(domRef.waveformMotionStartMarker, null, null);
    setWaveformMarker(domRef.waveformMotionEndMarker, null, null);
    setWaveformMarker(domRef.waveformReleaseMarker, null, null);
    renderMotionSegments(null);
    return;
  }

  const collapseThreshold = MARKER_COLLAPSE_EPSILON_SECONDS;

  waveformStateRef.motionSegments = Array.isArray(stateRef.current.motion_segments)
    ? stateRef.current.motion_segments
    : [];
  let triggerSeconds = toFiniteOrNullRef(stateRef.current.trigger_offset_seconds);
  if (!Number.isFinite(triggerSeconds)) {
    triggerSeconds = Number.isFinite(configStateRef?.prePadSeconds)
      ? configStateRef.prePadSeconds
      : null;
  }
  if (Number.isFinite(triggerSeconds)) {
    triggerSeconds = clampRef(triggerSeconds, 0, duration);
  } else {
    triggerSeconds = null;
  }

  let releaseSeconds = toFiniteOrNullRef(stateRef.current.release_offset_seconds);
  if (!Number.isFinite(releaseSeconds)) {
    if (Number.isFinite(configStateRef?.postPadSeconds)) {
      const candidate = duration - configStateRef.postPadSeconds;
      if (candidate >= 0 && candidate <= duration) {
        releaseSeconds = candidate;
      }
    }
  }
  if (Number.isFinite(releaseSeconds)) {
    releaseSeconds = clampRef(releaseSeconds, 0, duration);
  } else {
    releaseSeconds = null;
  }

  if (
    releaseSeconds !== null &&
    triggerSeconds !== null &&
    Math.abs(releaseSeconds - triggerSeconds) <= collapseThreshold
  ) {
    releaseSeconds = triggerSeconds;
  }

  let motionTriggerSeconds = toFiniteOrNullRef(stateRef.current.motion_trigger_offset_seconds);
  if (Number.isFinite(motionTriggerSeconds)) {
    motionTriggerSeconds = clampRef(motionTriggerSeconds, 0, duration);
  } else {
    motionTriggerSeconds = null;
  }

  let motionReleaseSeconds = toFiniteOrNullRef(stateRef.current.motion_release_offset_seconds);
  if (Number.isFinite(motionReleaseSeconds)) {
    motionReleaseSeconds = clampRef(motionReleaseSeconds, 0, duration);
  } else {
    motionReleaseSeconds = null;
  }

  if (
    motionReleaseSeconds !== null &&
    motionTriggerSeconds !== null &&
    Math.abs(motionReleaseSeconds - motionTriggerSeconds) <= collapseThreshold
  ) {
    motionReleaseSeconds = motionTriggerSeconds;
  }

  if (
    motionReleaseSeconds !== null &&
    motionTriggerSeconds === null &&
    triggerSeconds !== null &&
    Math.abs(motionReleaseSeconds - triggerSeconds) <= collapseThreshold
  ) {
    motionReleaseSeconds = triggerSeconds;
  }

  waveformStateRef.triggerSeconds = triggerSeconds;
  waveformStateRef.releaseSeconds = releaseSeconds;
  waveformStateRef.motionTriggerSeconds = motionTriggerSeconds;
  waveformStateRef.motionReleaseSeconds = motionReleaseSeconds;
  const markersForLayout = [];

  const triggerFraction = setWaveformMarker(domRef.waveformTriggerMarker, triggerSeconds, duration);
  if (Number.isFinite(triggerFraction)) {
    markersForLayout.push({ element: domRef.waveformTriggerMarker, fraction: triggerFraction });
  }

  const motionTriggerFraction = setWaveformMarker(
    domRef.waveformMotionStartMarker,
    motionTriggerSeconds,
    duration,
  );
  if (Number.isFinite(motionTriggerFraction)) {
    markersForLayout.push({ element: domRef.waveformMotionStartMarker, fraction: motionTriggerFraction });
  }

  const motionReleaseFraction = setWaveformMarker(
    domRef.waveformMotionEndMarker,
    motionReleaseSeconds,
    duration,
  );
  if (Number.isFinite(motionReleaseFraction)) {
    markersForLayout.push({ element: domRef.waveformMotionEndMarker, fraction: motionReleaseFraction });
  }

  const releaseFraction = setWaveformMarker(domRef.waveformReleaseMarker, releaseSeconds, duration);
  if (Number.isFinite(releaseFraction)) {
    markersForLayout.push({ element: domRef.waveformReleaseMarker, fraction: releaseFraction });
  }

  layoutWaveformMarkerLabels(markersForLayout);
  renderMotionSegments(duration);
}

export function updateCursorFromPlayer() {
  ensureInitialized();
  if (!domRef.waveformContainer || domRef.waveformContainer.hidden) {
    return;
  }
  const duration = getPlayerDurationSecondsRef();
  if (!Number.isFinite(duration) || duration <= 0) {
    setCursorFraction(0);
    return;
  }
  const currentTime = Number.isFinite(domRef.player?.currentTime)
    ? domRef.player.currentTime
    : 0;
  const fraction = clampRef(currentTime / duration, 0, 1);
  setCursorFraction(fraction);
}

export function handlePlayerLoadedMetadata() {
  ensureInitialized();
  if (playbackStateRef.resetOnLoad) {
    try {
      domRef.player.currentTime = 0;
    } catch (error) {
      /* ignore seek errors */
    }
  }
  if (playbackStateRef.enforcePauseOnLoad) {
    try {
      domRef.player.pause();
    } catch (error) {
      /* ignore pause errors */
    }
  }
  playbackStateRef.resetOnLoad = false;
  playbackStateRef.enforcePauseOnLoad = false;
  updateCursorFromPlayer();
}

export function stopCursorAnimation() {
  ensureInitialized();
  if (waveformStateRef.animationFrame) {
    window.cancelAnimationFrame(waveformStateRef.animationFrame);
    waveformStateRef.animationFrame = null;
  }
}

export function startCursorAnimation() {
  ensureInitialized();
  if (waveformStateRef.animationFrame || !domRef.waveformContainer || domRef.waveformContainer.hidden) {
    return;
  }
  const step = () => {
    updateCursorFromPlayer();
    waveformStateRef.animationFrame = window.requestAnimationFrame(step);
  };
  waveformStateRef.animationFrame = window.requestAnimationFrame(step);
}

export function clearWaveformRefresh() {
  ensureInitialized();
  if (waveformStateRef.refreshTimer !== null) {
    window.clearTimeout(waveformStateRef.refreshTimer);
    waveformStateRef.refreshTimer = null;
  }
  waveformStateRef.refreshRecordPath = "";
}

export function scheduleWaveformRefresh(record) {
  ensureInitialized();
  if (!record || !record.isPartial) {
    return;
  }
  const path = typeof record.path === "string" ? record.path : "";
  if (!path) {
    return;
  }

  clearWaveformRefresh();
  waveformStateRef.refreshRecordPath = path;
  waveformStateRef.refreshTimer = window.setTimeout(() => {
    waveformStateRef.refreshTimer = null;
    const current = stateRef?.current && stateRef.current.path === path ? stateRef.current : null;
    if (!current) {
      waveformStateRef.refreshRecordPath = "";
      return;
    }
    if (domRef.player && !domRef.player.paused && !domRef.player.ended) {
      scheduleWaveformRefresh(current);
      return;
    }
    loadWaveform(current);
  }, WAVEFORM_REFRESH_INTERVAL_MS);
}

export function resetWaveform() {
  ensureInitialized();
  stopCursorAnimation();
  clearWaveformRefresh();
  waveformStateRef.peaks = null;
  waveformStateRef.duration = 0;
  waveformStateRef.lastFraction = 0;
  waveformStateRef.triggerSeconds = null;
  waveformStateRef.releaseSeconds = null;
  waveformStateRef.motionTriggerSeconds = null;
  waveformStateRef.motionReleaseSeconds = null;
  waveformStateRef.peakScale = 32767;
  waveformStateRef.startEpoch = null;
  waveformStateRef.rmsValues = null;
  waveformStateRef.clipSelection = null;
  if (waveformStateRef.abortController) {
    waveformStateRef.abortController.abort();
    waveformStateRef.abortController = null;
  }
  if (domRef.waveformContainer) {
    domRef.waveformContainer.hidden = true;
    domRef.waveformContainer.dataset.ready = "false";
  }
  if (domRef.waveformCursor) {
    domRef.waveformCursor.style.left = "0%";
  }
  setWaveformMarker(domRef.waveformTriggerMarker, null, null);
  setWaveformMarker(domRef.waveformMotionStartMarker, null, null);
  setWaveformMarker(domRef.waveformMotionEndMarker, null, null);
  setWaveformMarker(domRef.waveformReleaseMarker, null, null);
  hideWaveformRmsRef();
  if (domRef.waveformEmpty) {
    domRef.waveformEmpty.hidden = false;
    domRef.waveformEmpty.textContent = "Select a recording to render its waveform.";
  }
  if (domRef.waveformStatus) {
    domRef.waveformStatus.textContent = "";
  }
  setWaveformClipSelection(null);
  updateWaveformClock();
}

export function getWaveformZoomLimits() {
  ensureInitialized();
  let min = WAVEFORM_ZOOM_MIN;
  let max = WAVEFORM_ZOOM_MAX;
  const input = domRef.waveformZoomInput;
  if (input) {
    const parsedMin = Number.parseFloat(input.min);
    if (Number.isFinite(parsedMin) && parsedMin > 0) {
      min = parsedMin;
    }
    const parsedMax = Number.parseFloat(input.max);
    if (Number.isFinite(parsedMax) && parsedMax > 0) {
      max = parsedMax;
    }
  }
  if (!(max > min)) {
    min = WAVEFORM_ZOOM_MIN;
    max = WAVEFORM_ZOOM_MAX;
  }
  return { min, max };
}

export function normalizeWaveformZoom(value) {
  ensureInitialized();
  const { min, max } = getWaveformZoomLimits();
  const fallback = WAVEFORM_ZOOM_DEFAULT;
  const candidate = Number.isFinite(value) && value > 0 ? value : fallback;
  return clampRef(candidate, min, max);
}

export function restoreWaveformPreferences() {
  ensureInitialized();
  const rawValue = getStoredWaveformAmplitudeRef();
  if (rawValue === null) {
    return;
  }
  waveformStateRef.amplitudeScale = normalizeWaveformZoom(rawValue);
}

export function updateWaveformZoomDisplay(scale) {
  ensureInitialized();
  const formatted = formatWaveformZoomRef(scale);
  if (domRef.waveformZoomValue) {
    domRef.waveformZoomValue.textContent = formatted;
  }
  if (domRef.waveformZoomInput) {
    domRef.waveformZoomInput.setAttribute("aria-valuetext", formatted);
    domRef.waveformZoomInput.value = String(scale.toFixed(2));
  }
}

export function getWaveformAmplitudeScale() {
  ensureInitialized();
  const normalized = normalizeWaveformZoom(waveformStateRef.amplitudeScale);
  waveformStateRef.amplitudeScale = normalized;
  return normalized;
}

export function drawWaveformFromPeaks(peaks) {
  ensureInitialized();
  if (!domRef.waveformCanvas || !domRef.waveformContainer) {
    return;
  }
  const containerWidth = domRef.waveformContainer.clientWidth;
  const containerHeight = domRef.waveformContainer.clientHeight;
  if (containerWidth <= 0 || containerHeight <= 0) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(containerWidth * dpr));
  const height = Math.max(1, Math.floor(containerHeight * dpr));
  domRef.waveformCanvas.width = width;
  domRef.waveformCanvas.height = height;
  domRef.waveformCanvas.style.width = "100%";
  domRef.waveformCanvas.style.height = "100%";

  const ctx = domRef.waveformCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const sampleCount = Math.floor(peaks.length / 2);
  ctx.clearRect(0, 0, width, height);
  if (sampleCount <= 0) {
    return;
  }

  const mid = height / 2;
  const amplitude = height / 2;
  const gain = getWaveformAmplitudeScale();
  const denom = sampleCount > 1 ? sampleCount - 1 : 1;

  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const peak = peaks[i * 2 + 1];
    const scaled = clampRef(peak * gain, -1, 1);
    const y = mid - scaled * amplitude;
    ctx.lineTo(x, y);
  }
  for (let i = sampleCount - 1; i >= 0; i -= 1) {
    const x = (i / denom) * width;
    const trough = peaks[i * 2];
    const scaled = clampRef(trough * gain, -1, 1);
    const y = mid - scaled * amplitude;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(56, 189, 248, 0.28)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const peak = peaks[i * 2 + 1];
    const scaled = clampRef(peak * gain, -1, 1);
    const y = mid - scaled * amplitude;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const x = (i / denom) * width;
    const trough = peaks[i * 2];
    const scaled = clampRef(trough * gain, -1, 1);
    const y = mid - scaled * amplitude;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();

  updateWaveformMarkers();
}

export function redrawWaveform() {
  ensureInitialized();
  if (waveformStateRef.peaks && domRef.waveformContainer && !domRef.waveformContainer.hidden) {
    drawWaveformFromPeaks(waveformStateRef.peaks);
    updateCursorFromPlayer();
    updateWaveformMarkers();
  }
}

export async function loadWaveform(record) {
  ensureInitialized();
  if (!domRef.waveformContainer || !domRef.waveformEmpty) {
    return;
  }
  clearWaveformRefresh();
  if (!record) {
    resetWaveform();
    return;
  }
  const waveformUrl = recordWaveformUrlRef(record);
  if (!waveformUrl) {
    resetWaveform();
    if (domRef.waveformEmpty) {
      domRef.waveformEmpty.textContent = "Waveform unavailable for this recording.";
    }
    if (domRef.waveformStatus) {
      domRef.waveformStatus.textContent = "";
    }
    return;
  }
  const requestId = (waveformStateRef.requestId += 1);
  if (waveformStateRef.abortController) {
    waveformStateRef.abortController.abort();
  }
  const controller = new AbortController();
  waveformStateRef.abortController = controller;

  stopCursorAnimation();
  domRef.waveformContainer.hidden = true;
  domRef.waveformContainer.dataset.ready = "false";
  domRef.waveformEmpty.hidden = false;
  domRef.waveformEmpty.textContent = "Loading waveform…";
  if (domRef.waveformStatus) {
    domRef.waveformStatus.textContent = "Loading…";
  }
  setCursorFraction(0);
  waveformStateRef.triggerSeconds = null;
  waveformStateRef.releaseSeconds = null;
  waveformStateRef.motionTriggerSeconds = null;
  waveformStateRef.motionReleaseSeconds = null;
  waveformStateRef.motionSegments = [];
  waveformStateRef.startEpoch = null;
  waveformStateRef.rmsValues = null;
  setWaveformMarker(domRef.waveformTriggerMarker, null, null);
  setWaveformMarker(domRef.waveformMotionStartMarker, null, null);
  setWaveformMarker(domRef.waveformMotionEndMarker, null, null);
  setWaveformMarker(domRef.waveformReleaseMarker, null, null);
  hideWaveformRmsRef();

  try {
    const response = await fetch(waveformUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`waveform request failed with status ${response.status}`);
    }
    const payload = await response.json();
    if (waveformStateRef.requestId !== requestId) {
      return;
    }

    const peaksData = Array.isArray(payload.peaks) ? payload.peaks : [];
    const peakScale = Number.isFinite(payload.peak_scale) && Number(payload.peak_scale) > 0
      ? Number(payload.peak_scale)
      : 32767;
    const sampleCount = Math.floor(peaksData.length / 2);
    if (sampleCount <= 0) {
      throw new Error("waveform payload missing peaks");
    }

    const normalized = new Float32Array(sampleCount * 2);
    for (let i = 0; i < sampleCount * 2; i += 1) {
      const raw = Number(peaksData[i]);
      if (!Number.isFinite(raw)) {
        normalized[i] = 0;
      } else {
        normalized[i] = clampRef(raw / peakScale, -1, 1);
      }
    }

    let normalizedRms = null;
    if (
      Array.isArray(payload.rms_values) &&
      payload.rms_values.length > 0 &&
      Number.isFinite(peakScale) &&
      peakScale > 0
    ) {
      const bucketCount = Math.min(sampleCount, payload.rms_values.length);
      normalizedRms = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        if (i < bucketCount) {
          const rawValue = Number(payload.rms_values[i]);
          if (Number.isFinite(rawValue)) {
            normalizedRms[i] = clampRef(Math.abs(rawValue) / peakScale, 0, 1);
          } else {
            normalizedRms[i] = 0;
          }
        } else {
          normalizedRms[i] = 0;
        }
      }
    }

    const existingDuration = Number.isFinite(record.duration_seconds) && record.duration_seconds > 0
      ? Number(record.duration_seconds)
      : null;
    const payloadDuration = Number(payload.duration_seconds);
    const effectiveDuration = Number.isFinite(payloadDuration) && payloadDuration > 0
      ? payloadDuration
      : existingDuration ?? 0;

    waveformStateRef.peaks = normalized;
    waveformStateRef.peakScale = peakScale;
    waveformStateRef.duration = effectiveDuration;
    waveformStateRef.rmsValues = normalizedRms;
    record.duration_seconds = effectiveDuration;
    record.motion_trigger_offset_seconds = toFiniteOrNullRef(
      payload.motion_trigger_offset_seconds
    );
    record.motion_release_offset_seconds = toFiniteOrNullRef(
      payload.motion_release_offset_seconds
    );
    record.motion_started_epoch = toFiniteOrNullRef(payload.motion_started_epoch);
    record.motion_released_epoch = toFiniteOrNullRef(payload.motion_released_epoch);
    const segments = normalizeMotionSegmentsRef(payload.motion_segments);
    record.motion_segments = segments;
    waveformStateRef.motionSegments = segments;

    let startEpoch = toFiniteOrNullRef(payload.start_epoch);
    if (startEpoch === null) {
      startEpoch = toFiniteOrNullRef(payload.started_epoch);
    }
    if (
      startEpoch === null &&
      typeof payload.started_at === "string" &&
      payload.started_at.trim() !== ""
    ) {
      const parsedStartedAt = Date.parse(payload.started_at);
      if (!Number.isNaN(parsedStartedAt)) {
        startEpoch = parsedStartedAt / 1000;
      }
    }
    if (startEpoch === null && Number.isFinite(record.start_epoch)) {
      startEpoch = Number(record.start_epoch);
    }
    if (startEpoch === null && Number.isFinite(record.started_epoch)) {
      startEpoch = Number(record.started_epoch);
    }
    if (
      startEpoch === null &&
      typeof record.started_at === "string" &&
      record.started_at.trim() !== ""
    ) {
      const parsedStartedAt = Date.parse(record.started_at);
      if (!Number.isNaN(parsedStartedAt)) {
        startEpoch = parsedStartedAt / 1000;
      }
    }

    let endEpoch = toFiniteOrNullRef(payload.end_epoch);
    if (endEpoch === null) {
      endEpoch = toFiniteOrNullRef(payload.ended_epoch);
    }
    if (
      endEpoch === null &&
      typeof payload.ended_at === "string" &&
      payload.ended_at.trim() !== ""
    ) {
      const parsedEndedAt = Date.parse(payload.ended_at);
      if (!Number.isNaN(parsedEndedAt)) {
        endEpoch = parsedEndedAt / 1000;
      }
    }
    if (endEpoch === null && Number.isFinite(record.modified)) {
      endEpoch = Number(record.modified);
    }
    if (endEpoch === null && typeof record.modified_iso === "string" && record.modified_iso) {
      const parsedModified = Date.parse(record.modified_iso);
      if (!Number.isNaN(parsedModified)) {
        endEpoch = parsedModified / 1000;
      }
    }
    if (startEpoch === null && Number.isFinite(endEpoch) && effectiveDuration > 0) {
      startEpoch = endEpoch - effectiveDuration;
    }
    if (Number.isFinite(startEpoch) && effectiveDuration > 0) {
      waveformStateRef.startEpoch = startEpoch;
      record.start_epoch = startEpoch;
    } else {
      waveformStateRef.startEpoch = null;
      delete record.start_epoch;
    }

    domRef.waveformContainer.hidden = false;
    domRef.waveformContainer.dataset.ready = "true";
    domRef.waveformEmpty.hidden = true;
    drawWaveformFromPeaks(normalized);
    updateCursorFromPlayer();
    updateWaveformMarkers();
    updateWaveformClock();
    updateWaveformRmsRef();
    startCursorAnimation();
    if (waveformStateRef.clipSelection) {
      setWaveformClipSelection({
        ...waveformStateRef.clipSelection,
        durationSeconds: effectiveDuration,
      });
    }

    if (domRef.waveformStatus) {
      const message = effectiveDuration > 0
        ? `Length: ${formatDurationRef(effectiveDuration)}`
        : "Waveform ready";
      domRef.waveformStatus.textContent = message;
    }

    if (existingDuration === null || Math.abs(effectiveDuration - existingDuration) > 0.05) {
      renderRecordsRef();
    }
    updatePlayerMetaRef(record);

    if (waveformStateRef.requestId === requestId) {
      scheduleWaveformRefresh(record);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.error("Failed to load waveform", error);
    if (waveformStateRef.requestId === requestId) {
      waveformStateRef.peaks = null;
      waveformStateRef.duration = 0;
      waveformStateRef.startEpoch = null;
      waveformStateRef.rmsValues = null;
      domRef.waveformContainer.hidden = true;
      domRef.waveformContainer.dataset.ready = "false";
      domRef.waveformEmpty.hidden = false;
      domRef.waveformEmpty.textContent = "Waveform unavailable for this recording.";
      if (domRef.waveformStatus) {
        domRef.waveformStatus.textContent = "";
      }
      updateWaveformClock();
      hideWaveformRmsRef();
    }
  } finally {
    if (waveformStateRef.abortController === controller) {
      waveformStateRef.abortController = null;
    }
  }
}

export function seekFromPointer(event) {
  ensureInitialized();
  if (!domRef.waveformContainer || domRef.waveformContainer.hidden) {
    return;
  }
  const rect = domRef.waveformContainer.getBoundingClientRect();
  if (rect.width <= 0) {
    return;
  }
  const fraction = clampRef((event.clientX - rect.left) / rect.width, 0, 1);
  const duration = getPlayerDurationSecondsRef();
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  if (domRef.player) {
    domRef.player.currentTime = fraction * duration;
  }
  setCursorFraction(fraction);
}

export function handleWaveformPointerDown(event) {
  ensureInitialized();
  event.stopPropagation();
  focusPreviewSurfaceRef();
  const duration = getPlayerDurationSecondsRef();
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  waveformStateRef.isScrubbing = true;
  waveformStateRef.pointerId = event.pointerId;
  try {
    domRef.waveformContainer.setPointerCapture(event.pointerId);
  } catch (err) {
    /* ignore capture errors */
  }
  seekFromPointer(event);
  event.preventDefault();
}

export function handleWaveformPointerMove(event) {
  ensureInitialized();
  event.stopPropagation();
  if (!waveformStateRef.isScrubbing || event.pointerId !== waveformStateRef.pointerId) {
    return;
  }
  seekFromPointer(event);
}

export function handleWaveformPointerUp(event) {
  ensureInitialized();
  event.stopPropagation();
  if (event.pointerId !== waveformStateRef.pointerId) {
    return;
  }
  waveformStateRef.isScrubbing = false;
  waveformStateRef.pointerId = null;
  try {
    domRef.waveformContainer.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* ignore release errors */
  }
  updateCursorFromPlayer();
}
