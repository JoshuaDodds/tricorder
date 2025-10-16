// Dashboard configuration helpers responsible for resolving API and event stream clients.
import { createApiClient } from "../api.js";
import { createEventStreamFactory } from "../events.js";

function parseRetryConfig(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  function parseInteger(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return null;
      }
      return Math.max(0, Math.trunc(value));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return Math.max(0, Math.trunc(parsed));
    }
    return null;
  }

  function parseNumber(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return null;
      }
      return Math.max(0, value);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return Math.max(0, parsed);
    }
    return null;
  }

  function parseRatio(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return null;
      }
      return Math.max(0, Math.min(1, value));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return Math.max(0, Math.min(1, parsed));
    }
    return null;
  }

  const attempts = parseInteger(source.attempts);
  const minDelay = parseNumber(source.minDelayMs);
  const maxDelay = parseNumber(source.maxDelayMs);
  const jitterRatio = parseRatio(source.jitterRatio);

  if (attempts === null && minDelay === null && maxDelay === null && jitterRatio === null) {
    return null;
  }

  const resolved = {};
  if (attempts !== null) {
    resolved.attempts = attempts;
  }
  if (minDelay !== null) {
    resolved.minDelayMs = minDelay;
  }
  if (maxDelay !== null) {
    resolved.maxDelayMs = maxDelay;
  }
  if (jitterRatio !== null) {
    resolved.jitterRatio = jitterRatio;
  }
  if (
    resolved.minDelayMs !== undefined &&
    resolved.maxDelayMs !== undefined &&
    resolved.maxDelayMs < resolved.minDelayMs
  ) {
    resolved.maxDelayMs = resolved.minDelayMs;
  }
  return resolved;
}

function resolveApiRetryConfig() {
  if (typeof window !== "undefined" && window.TRICORDER_API_RETRY) {
    const parsed = parseRetryConfig(window.TRICORDER_API_RETRY);
    if (parsed) {
      return parsed;
    }
  }
  if (typeof document !== "undefined" && document.body && document.body.dataset) {
    const dataset = document.body.dataset;
    const candidate = {
      attempts: dataset.tricorderApiRetryAttempts,
      minDelayMs: dataset.tricorderApiRetryMinMs,
      maxDelayMs: dataset.tricorderApiRetryMaxMs,
      jitterRatio: dataset.tricorderApiRetryJitterRatio,
    };
    const parsed = parseRetryConfig(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function createDashboardApiClient({ logger } = {}) {
  return createApiClient({
    logger: logger ?? (typeof console !== "undefined" ? console : undefined),
    retry: resolveApiRetryConfig() || undefined,
  });
}

function createDashboardEventStreamFactory({
  windowOverride = undefined,
  eventSourceOverride = undefined,
  logger,
} = {}) {
  return createEventStreamFactory({
    window: windowOverride ?? (typeof window !== "undefined" ? window : null),
    eventSource: eventSourceOverride ?? (typeof EventSource !== "undefined" ? EventSource : null),
    logger: logger ?? (typeof console !== "undefined" ? console : undefined),
  });
}

function createDashboardServices(options = {}) {
  const apiClient = createDashboardApiClient(options);
  const eventStreamFactory = createDashboardEventStreamFactory(options);
  const apiPath = (path) => apiClient.path(path);
  const eventStreamSupported = eventStreamFactory.isSupported();
  return {
    apiClient,
    apiPath,
    eventStreamFactory,
    eventStreamSupported,
  };
}

export {
  createDashboardApiClient,
  createDashboardEventStreamFactory,
  createDashboardServices,
  parseRetryConfig,
  resolveApiRetryConfig,
};
