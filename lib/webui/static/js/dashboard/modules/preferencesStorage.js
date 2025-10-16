import {
  CLIPPER_STORAGE_KEY,
  COLLECTION_STORAGE_KEY,
  DEFAULT_LIMIT,
  FILTER_STORAGE_KEY,
  MAX_LIMIT,
  SORT_STORAGE_KEY,
  VALID_TIME_RANGES,
  WAVEFORM_STORAGE_KEY,
} from "../../config.js";

function getLocalStorage() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

export function clampLimitValue(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    const parsed = Number.parseInt(candidate, 10);
    if (!Number.isNaN(parsed)) {
      candidate = parsed;
    }
  }
  if (!Number.isFinite(candidate)) {
    return DEFAULT_LIMIT;
  }
  const integer = Math.trunc(candidate);
  if (!Number.isFinite(integer) || integer < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.max(integer, 1), MAX_LIMIT);
}

export function clampOffsetValue(value, limit, total) {
  let candidate = value;
  if (typeof candidate === "string") {
    const parsed = Number.parseInt(candidate, 10);
    if (!Number.isNaN(parsed)) {
      candidate = parsed;
    }
  }
  const base = Number.isFinite(candidate) ? Math.max(0, Math.trunc(candidate)) : 0;
  const effectiveLimit = clampLimitValue(limit);
  const effectiveTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  if (effectiveTotal <= 0 || effectiveLimit <= 0) {
    return 0;
  }
  const maxIndex = effectiveTotal - 1;
  const lastPageOffset = Math.floor(maxIndex / effectiveLimit) * effectiveLimit;
  return Math.min(base, lastPageOffset);
}

export function loadStoredCollection(storage = getLocalStorage()) {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(COLLECTION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "saved" || normalized === "recent") {
      return normalized;
    }
    return null;
  } catch (error) {
    return null;
  }
}

export function persistCollection(collection, storage = getLocalStorage()) {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(COLLECTION_STORAGE_KEY, collection);
  } catch (error) {
    /* ignore persistence errors */
  }
}

export function readStoredFilters(storage = getLocalStorage()) {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(FILTER_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

export function persistFilters(filters, storage = getLocalStorage()) {
  if (!storage) {
    return;
  }
  try {
    const payload = {
      search: filters.search,
      day: filters.day,
      limit: filters.limit,
      timeRange: filters.timeRange,
    };
    storage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore persistence errors */
  }
}

export function clearStoredFilters(storage = getLocalStorage()) {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(FILTER_STORAGE_KEY);
  } catch (error) {
    /* ignore removal errors */
  }
}

function readStoredSortPreference(storage = getLocalStorage()) {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(SORT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

export function persistSortPreference(sortState, storage = getLocalStorage()) {
  if (!storage) {
    return;
  }
  try {
    const direction = sortState.direction === "desc" ? "desc" : "asc";
    const payload = {
      key: sortState.key,
      direction,
    };
    storage.setItem(SORT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore persistence errors */
  }
}

export function restoreSortFromStorage(sortButtons, sortState, storage = getLocalStorage()) {
  const stored = readStoredSortPreference(storage);
  if (!stored) {
    return;
  }
  const candidates = Array.isArray(sortButtons)
    ? sortButtons
    : Array.from(sortButtons ?? []);
  const validKeys = new Set(
    candidates
      .map((button) => (button?.dataset?.sortKey ?? "").trim())
      .filter((value) => value),
  );
  const candidateKey =
    typeof stored.key === "string" && stored.key.trim() ? stored.key.trim() : "";
  if (candidateKey && validKeys.has(candidateKey)) {
    sortState.key = candidateKey;
  }
  const candidateDirection =
    typeof stored.direction === "string" ? stored.direction.toLowerCase() : "";
  if (candidateDirection === "asc" || candidateDirection === "desc") {
    sortState.direction = candidateDirection;
  }
}

export function restoreFiltersFromStorage(currentFilters, storage = getLocalStorage()) {
  const stored = readStoredFilters(storage);
  if (!stored) {
    return currentFilters;
  }
  const next = {
    search: currentFilters.search,
    day: currentFilters.day,
    limit: currentFilters.limit,
    timeRange: currentFilters.timeRange,
  };
  if (typeof stored.search === "string") {
    next.search = stored.search;
  }
  if (typeof stored.day === "string") {
    next.day = stored.day;
  }
  if (Object.prototype.hasOwnProperty.call(stored, "limit")) {
    next.limit = clampLimitValue(stored.limit);
  }
  if (typeof stored.timeRange === "string" && VALID_TIME_RANGES.has(stored.timeRange)) {
    next.timeRange = stored.timeRange;
  }
  return next;
}

export function readStoredClipperPreference(storage = getLocalStorage()) {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(CLIPPER_STORAGE_KEY);
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
    return null;
  } catch (error) {
    return null;
  }
}

export function persistClipperPreference(enabled, storage = getLocalStorage()) {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CLIPPER_STORAGE_KEY, enabled ? "1" : "0");
  } catch (error) {
    /* ignore persistence errors */
  }
}

export function readStoredWaveformPreferences(storage = getLocalStorage()) {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(WAVEFORM_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

export function persistWaveformPreferences(amplitudeScale, storage = getLocalStorage()) {
  if (!storage) {
    return;
  }
  try {
    const payload = { amplitudeScale };
    storage.setItem(WAVEFORM_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    /* ignore persistence errors */
  }
}

export function getStoredWaveformAmplitude(storage = getLocalStorage()) {
  const stored = readStoredWaveformPreferences(storage);
  if (!stored || typeof stored !== "object") {
    return null;
  }
  const rawValue = Number.parseFloat(stored.amplitudeScale ?? stored.zoom);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return null;
  }
  return rawValue;
}
