const DEFAULT_RETRY_ATTEMPTS = 0;
const DEFAULT_RETRY_MIN_DELAY_MS = 0;
const DEFAULT_RETRY_MAX_DELAY_MS = 0;
const DEFAULT_RETRY_JITTER_RATIO = 0.1;

function createNoopLogger() {
  return {
    log() {},
    info() {},
    warn() {},
    error() {},
  };
}

export function normalizeApiBase(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

export function resolveApiBase(options = {}) {
  const windowRef = options.window || (typeof window !== "undefined" ? window : null);
  const documentRef = options.document || (typeof document !== "undefined" ? document : null);

  if (windowRef && typeof windowRef.TRICORDER_API_BASE === "string") {
    const fromWindow = normalizeApiBase(windowRef.TRICORDER_API_BASE);
    if (fromWindow) {
      return fromWindow;
    }
  }

  if (
    documentRef &&
    documentRef.body &&
    documentRef.body.dataset &&
    typeof documentRef.body.dataset.tricorderApiBase === "string"
  ) {
    const fromDataset = normalizeApiBase(documentRef.body.dataset.tricorderApiBase);
    if (fromDataset) {
      return fromDataset;
    }
  }

  return "";
}

function createDelayScheduler(options = {}) {
  if (options.window && typeof options.window.setTimeout === "function") {
    return function schedule(callback, ms) {
      return options.window.setTimeout(callback, ms);
    };
  }
  if (typeof setTimeout === "function") {
    return function schedule(callback, ms) {
      return setTimeout(callback, ms);
    };
  }
  return function schedule(callback) {
    callback();
    return 0;
  };
}

function computeRetryDelay(minDelay, maxDelay, attempt, jitterRatio) {
  const clampedMin = Number.isFinite(minDelay) && minDelay > 0 ? minDelay : 0;
  const clampedMax = Number.isFinite(maxDelay) && maxDelay >= clampedMin ? maxDelay : clampedMin;
  if (clampedMin === 0 && clampedMax === 0) {
    return 0;
  }
  const base = clampedMin === 0 ? 0 : Math.min(clampedMax, clampedMin * Math.pow(2, attempt));
  if (base === 0) {
    return 0;
  }
  const normalizedJitter = Number.isFinite(jitterRatio) ? Math.max(0, Math.min(1, jitterRatio)) : 0;
  if (normalizedJitter === 0) {
    return base;
  }
  const jitter = base * normalizedJitter;
  return base + Math.random() * jitter;
}

function wait(delayMs, scheduler) {
  if (!scheduler || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise(function resolvePromise(resolve) {
    scheduler(resolve, delayMs);
  });
}

function ensureFetchImplementation(options) {
  if (options.fetch && typeof options.fetch === "function") {
    return options.fetch;
  }
  if (options.window && typeof options.window.fetch === "function") {
    return options.window.fetch.bind(options.window);
  }
  if (typeof fetch === "function") {
    return fetch;
  }
  return null;
}

export function createApiClient(options = {}) {
  const windowRef = options.window || (typeof window !== "undefined" ? window : null);
  const documentRef = options.document || (typeof document !== "undefined" ? document : null);
  const logger = options.logger || (typeof console !== "undefined" ? console : createNoopLogger());
  const scheduler = createDelayScheduler({ window: windowRef });
  const fetchImpl = ensureFetchImplementation({ fetch: options.fetch, window: windowRef });

  if (!fetchImpl) {
    throw new Error("No fetch implementation available for API client");
  }

  const baseOverride = normalizeApiBase(options.baseUrl);
  const baseUrl = baseOverride || resolveApiBase({ window: windowRef, document: documentRef });

  const defaultRetry = options.retry || {};
  const defaultAttempts = Number.isFinite(defaultRetry.attempts)
    ? Math.max(0, Math.trunc(defaultRetry.attempts))
    : DEFAULT_RETRY_ATTEMPTS;
  const defaultMinDelay = Number.isFinite(defaultRetry.minDelayMs)
    ? Math.max(0, defaultRetry.minDelayMs)
    : DEFAULT_RETRY_MIN_DELAY_MS;
  const defaultMaxDelay = Number.isFinite(defaultRetry.maxDelayMs)
    ? Math.max(defaultMinDelay, defaultRetry.maxDelayMs)
    : Math.max(defaultMinDelay, DEFAULT_RETRY_MAX_DELAY_MS);
  const defaultJitter = Number.isFinite(defaultRetry.jitterRatio)
    ? Math.max(0, Math.min(1, defaultRetry.jitterRatio))
    : DEFAULT_RETRY_JITTER_RATIO;

  function buildPath(path) {
    if (!path) {
      return baseUrl;
    }
    if (typeof path === "string") {
      const trimmed = path.trim();
      if (!trimmed) {
        return baseUrl;
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//")) {
        return trimmed;
      }
      const normalized = trimmed.charAt(0) === "/" ? trimmed : "/" + trimmed;
      if (!baseUrl) {
        return normalized;
      }
      if (normalized === "/") {
        return baseUrl;
      }
      return baseUrl + normalized;
    }
    return baseUrl;
  }

  function resolveAttempts(value) {
    if (!Number.isFinite(value)) {
      return defaultAttempts;
    }
    return Math.max(0, Math.trunc(value));
  }

  function resolveMinDelay(value) {
    if (!Number.isFinite(value)) {
      return defaultMinDelay;
    }
    return Math.max(0, value);
  }

  function resolveMaxDelay(value, minDelay) {
    if (!Number.isFinite(value)) {
      return Math.max(minDelay, defaultMaxDelay);
    }
    return Math.max(minDelay, value);
  }

  function resolveJitter(value) {
    if (!Number.isFinite(value)) {
      return defaultJitter;
    }
    return Math.max(0, Math.min(1, value));
  }

  async function performRequest(path, init, requestOptions) {
    const url = buildPath(path);
    const attempts = resolveAttempts(requestOptions && requestOptions.retryAttempts);
    const minDelay = resolveMinDelay(requestOptions && requestOptions.retryMinDelayMs);
    const maxDelay = resolveMaxDelay(requestOptions && requestOptions.retryMaxDelayMs, minDelay);
    const jitter = resolveJitter(requestOptions && requestOptions.retryJitterRatio);

    let attempt = 0;
    // Always perform at least one attempt.
    while (true) {
      try {
        return await fetchImpl(url, init);
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
        const delayMs = computeRetryDelay(minDelay, maxDelay, attempt, jitter);
        if (logger && typeof logger.warn === "function" && delayMs > 0) {
          const message = error && error.message ? error.message : String(error);
          logger.warn("Retrying dashboard request after error", { url, attempt: attempt + 1, message });
        }
        await wait(delayMs, scheduler);
        attempt += 1;
      }
    }
  }

  async function fetchJson(path, init, requestOptions) {
    const response = await performRequest(path, init, requestOptions || {});
    if (!response || typeof response.json !== "function") {
      return null;
    }
    try {
      return await response.json();
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("Failed to parse JSON response", { path: buildPath(path), error: error && error.message ? error.message : String(error) });
      }
      throw error;
    }
  }

  return {
    baseUrl,
    path: buildPath,
    fetch: function fetchWithBase(path, init, requestOptions) {
      return performRequest(path, init, requestOptions || {});
    },
    fetchJson,
  };
}
