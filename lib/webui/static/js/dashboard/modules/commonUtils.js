export function ensureOfflineStateOnError(error, handleFetchFailure) {
  const offline = isOfflineFetchError(error);
  if (offline) {
    handleFetchFailure();
  }
  return offline;
}

export function normalizeErrorMessage(error, fallback) {
  if (error instanceof Error && typeof error.message === "string") {
    const trimmed = error.message.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function numericValue(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function getRecordStartSeconds(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  if (Number.isFinite(record.start_epoch)) {
    return Number(record.start_epoch);
  }
  if (Number.isFinite(record.started_epoch)) {
    return Number(record.started_epoch);
  }
  if (typeof record.started_at === "string" && record.started_at.trim() !== "") {
    const parsedStarted = Date.parse(record.started_at);
    if (!Number.isNaN(parsedStarted)) {
      return parsedStarted / 1000;
    }
  }
  if (Number.isFinite(record.modified)) {
    return Number(record.modified);
  }
  if (typeof record.modified_iso === "string" && record.modified_iso.trim() !== "") {
    const parsedModified = Date.parse(record.modified_iso);
    if (!Number.isNaN(parsedModified)) {
      return parsedModified / 1000;
    }
  }
  return null;
}

const NETWORK_ERROR_PATTERNS = [
  /failed to fetch/i,
  /network ?error/i,
  /connection (?:refused|reset|aborted|closed)/i,
  /load failed/i,
  /offline/i,
];

export function isOfflineFetchError(error) {
  if (!error) {
    return false;
  }
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : typeof error === "string"
      ? error.trim()
      : "";
  if (name === "typeerror") {
    if (!message) {
      return false;
    }
    return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  }
  if (!message) {
    return false;
  }
  return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
