function createNoopLogger() {
  return {
    log() {},
    info() {},
    warn() {},
    error() {},
  };
}

function extractErrorDetail(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error.message === "string") {
    return error.message;
  }
  if (error && typeof error.toString === "function") {
    return error.toString();
  }
  return "";
}

function normalizeLogContext(label, detail) {
  const parts = [];
  if (label) {
    parts.push(label);
  }
  if (detail) {
    parts.push(detail);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(": ");
}

function isEventSourceInitOptionsError(error) {
  if (!error) {
    return false;
  }
  if (typeof TypeError !== "undefined" && error instanceof TypeError) {
    return true;
  }
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  if (name === "typeerror") {
    return true;
  }
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (!message) {
    return false;
  }
  if (message.indexOf("eventsource") === -1) {
    return false;
  }
  return message.indexOf("constructor") !== -1 || message.indexOf("init") !== -1 || message.indexOf("credentials") !== -1;
}

export function createEventStreamFactory(options = {}) {
  const windowRef = options.window || (typeof window !== "undefined" ? window : null);
  const EventSourceImpl = options.eventSource || (typeof EventSource !== "undefined" ? EventSource : null);
  const logger = options.logger || (typeof console !== "undefined" ? console : createNoopLogger());

  let initOptionsSupported = EventSourceImpl ? null : false;
  let initOptionsWarned = false;

  function isSupported() {
    return Boolean(EventSourceImpl);
  }

  function create(url, createOptions) {
    const opts = createOptions || {};
    const requiresCredentials = Boolean(opts.requiresCredentials);
    const label = typeof opts.label === "string" && opts.label ? opts.label : "event stream";

    if (!EventSourceImpl || !url) {
      return { source: null, credentialInitUnsupported: requiresCredentials };
    }

    const shouldTryInitOptions = initOptionsSupported !== false;
    if (shouldTryInitOptions) {
      try {
        const source = new EventSourceImpl(url, { withCredentials: true });
        initOptionsSupported = true;
        return { source, credentialInitUnsupported: false };
      } catch (error) {
        if (isEventSourceInitOptionsError(error)) {
          initOptionsSupported = false;
          if (!initOptionsWarned && logger && typeof logger.warn === "function") {
            const detail = extractErrorDetail(error);
            const context = normalizeLogContext(label, detail);
            if (requiresCredentials) {
              logger.warn("Event stream credentials unsupported; fallback required", context);
            } else {
              logger.warn("Event stream init options unsupported; retrying without credentials", context);
            }
            initOptionsWarned = true;
          }
          if (requiresCredentials) {
            return { source: null, credentialInitUnsupported: true };
          }
        } else {
          throw error;
        }
      }
    }

    if (requiresCredentials && initOptionsSupported === false) {
      return { source: null, credentialInitUnsupported: true };
    }

    return { source: new EventSourceImpl(url), credentialInitUnsupported: false };
  }

  return {
    isSupported,
    create,
  };
}
