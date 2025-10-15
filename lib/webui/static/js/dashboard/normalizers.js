// Normalization helpers for dashboard API payloads and configuration.
function toFiniteOrNull(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMotionSegments(source) {
  if (!Array.isArray(source)) {
    return [];
  }
  const segments = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const startValue = toFiniteOrNull(entry.start);
    if (!Number.isFinite(startValue)) {
      continue;
    }
    const start = Math.max(0, startValue);
    const endValue = toFiniteOrNull(entry.end);
    let end = null;
    if (Number.isFinite(endValue)) {
      end = Math.max(start, endValue);
    }
    segments.push({ start, end });
  }
  return segments;
}

function normalizeTriggerSources(source) {
  if (!Array.isArray(source)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of source) {
    if (typeof entry !== "string") {
      continue;
    }
    const token = entry.trim().toLowerCase();
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    normalized.push(token);
  }
  return normalized;
}

function normalizeStartTimestamps(source) {
  const startEpochCandidate = toFiniteOrNull(source && source.start_epoch);
  const startedEpochCandidate = toFiniteOrNull(source && source.started_epoch);
  const startedAtRaw =
    typeof (source && source.started_at) === "string" ? source.started_at.trim() : "";

  let startEpoch = startEpochCandidate;
  let startedEpoch = startedEpochCandidate;
  let startedAt = startedAtRaw;

  if (startEpoch === null && startedEpoch !== null) {
    startEpoch = startedEpoch;
  }

  if (startEpoch === null && startedAt) {
    const parsed = Date.parse(startedAt);
    if (!Number.isNaN(parsed)) {
      startEpoch = parsed / 1000;
    }
  }

  if (startedEpoch === null) {
    startedEpoch = startEpoch;
  }

  if (!startedAt && startEpoch !== null) {
    try {
      startedAt = new Date(startEpoch * 1000).toISOString();
    } catch (error) {
      startedAt = "";
    }
  }

  const normalizedStartEpoch =
    typeof startEpoch === "number" && Number.isFinite(startEpoch) ? startEpoch : null;
  const normalizedStartedEpoch =
    typeof startedEpoch === "number" && Number.isFinite(startedEpoch)
      ? startedEpoch
      : null;

  return {
    startEpoch: normalizedStartEpoch,
    startedEpoch: normalizedStartedEpoch,
    startedAt,
  };
}

function normalizeIceServerEntry(entry) {
  if (!entry) {
    return null;
  }
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }
    return { urls: [trimmed] };
  }
  if (typeof entry !== "object") {
    return null;
  }
  const urls = [];
  const username = typeof entry.username === "string" ? entry.username : undefined;
  const credential = typeof entry.credential === "string" ? entry.credential : undefined;
  if (Array.isArray(entry.urls)) {
    for (const url of entry.urls) {
      if (typeof url === "string" && url.trim()) {
        urls.push(url.trim());
      }
    }
  } else if (typeof entry.url === "string" && entry.url.trim()) {
    urls.push(entry.url.trim());
  }
  if (urls.length === 0) {
    return null;
  }
  const candidate = { urls };
  if (username) {
    candidate.username = username;
  }
  if (credential) {
    candidate.credential = credential;
  }
  return candidate;
}

export {
  normalizeIceServerEntry,
  normalizeMotionSegments,
  normalizeStartTimestamps,
  normalizeTriggerSources,
  toFiniteOrNull,
};
