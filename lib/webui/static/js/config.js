const EVENT_STREAM_SUPPORTED =
  typeof window !== "undefined" && typeof EventSource !== "undefined";

function normalizeApiBase(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

const API_BASE = (() => {
  if (typeof window === "undefined") {
    return "";
  }
  const globalBase = normalizeApiBase(window.TRICORDER_API_BASE);
  if (globalBase) {
    return globalBase;
  }
  if (typeof document !== "undefined" && document.body && document.body.dataset) {
    const dataBase = normalizeApiBase(document.body.dataset.tricorderApiBase);
    if (dataBase) {
      return dataBase;
    }
  }
  return "";
})();

function apiPath(path) {
  if (!path) {
    return API_BASE;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE) {
    return normalized;
  }
  if (normalized === "/") {
    return API_BASE;
  }
  return `${API_BASE}${normalized}`;
}

const AUTO_REFRESH_INTERVAL_MS = 1000;
const OFFLINE_REFRESH_INTERVAL_MS = 5000;
const EVENT_TRIGGER_DEBOUNCE_MS = 250;
const WAVEFORM_REFRESH_INTERVAL_MS = 3000;
const POINTER_IDLE_CLEAR_DELAY_MS = 10000;
const MARKER_COLLAPSE_EPSILON_SECONDS = 0.002;
const MARKER_LABEL_EDGE_THRESHOLD = 0.08;
const MARKER_LABEL_SPACING_THRESHOLD = 0.04;
const MARKER_LABEL_BASE_OFFSET_REM = 0.95;
const MARKER_LABEL_STACK_SPACING_REM = 1.5;
const KEYBOARD_JOG_RATE_SECONDS_PER_SECOND = 4;
const MIN_CLIP_DURATION_SECONDS = 0.05;
const DEFAULT_LIMIT = 200;
const VALID_TIME_RANGES = new Set(["", "1h", "2h", "4h", "8h", "12h", "1d"]);
const MAX_LIMIT = 1000;
const FILTER_STORAGE_KEY = "tricorder.dashboard.filters";
const SORT_STORAGE_KEY = "tricorder.dashboard.sort";
const FILTER_PANEL_STORAGE_KEY = "tricorder.dashboard.filtersPanel";
const CLIPPER_STORAGE_KEY = "tricorder.dashboard.clipper";
const THEME_STORAGE_KEY = "tricorder.dashboard.theme";
const RECYCLE_BIN_STATE_STORAGE_KEY = "tricorder.dashboard.recycleBin";
const WAVEFORM_STORAGE_KEY = "tricorder.dashboard.waveform";
const TRANSPORT_STORAGE_KEY = "tricorder.dashboard.transport";
const COLLECTION_STORAGE_KEY = "tricorder.dashboard.collection";
const TRANSPORT_SCRUB_MAX = 1000;
const TRANSPORT_SKIP_BACK_SECONDS = 10;
const TRANSPORT_SKIP_FORWARD_SECONDS = 30;
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 2;

function resolveStreamMode() {
  if (typeof document === "undefined" || !document.body || !document.body.dataset) {
    return "hls";
  }
  const mode = (document.body.dataset.tricorderStreamMode || "").trim().toLowerCase();
  return mode === "webrtc" ? "webrtc" : "hls";
}

const STREAM_MODE = resolveStreamMode();

const DEFAULT_WEBRTC_ICE_SERVERS = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

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

  const urlsRaw = entry.urls;
  const urls = [];
  if (typeof urlsRaw === "string") {
    const trimmed = urlsRaw.trim();
    if (trimmed) {
      urls.push(trimmed);
    }
  } else if (Array.isArray(urlsRaw)) {
    for (const value of urlsRaw) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          urls.push(trimmed);
        }
      }
    }
  }

  if (urls.length === 0) {
    return null;
  }

  const normalized = { urls };
  if (typeof entry.username === "string") {
    const username = entry.username.trim();
    if (username) {
      normalized.username = username;
    }
  }
  if (typeof entry.credential === "string") {
    const credential = entry.credential.trim();
    if (credential) {
      normalized.credential = credential;
    }
  }
  return normalized;
}

function resolveIceServers() {
  if (typeof document === "undefined" || !document.body || !document.body.dataset) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  const raw = document.body.dataset.tricorderWebrtcIceServers;
  if (!raw) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("Failed to parse WebRTC ICE servers config", error);
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  if (!Array.isArray(parsed)) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  if (parsed.length === 0) {
    return [];
  }
  const normalized = [];
  for (const entry of parsed) {
    const candidate = normalizeIceServerEntry(entry);
    if (candidate) {
      normalized.push(candidate);
    }
  }
  if (normalized.length === 0) {
    console.warn("No valid ICE servers configured; falling back to defaults");
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
  return normalized;
}

const WEBRTC_ICE_SERVERS = resolveIceServers();
const STREAM_BASE = STREAM_MODE === "webrtc" ? "/webrtc" : "/hls";
const HLS_URL = STREAM_MODE === "hls" ? apiPath("/hls/live.m3u8") : "";
const START_ENDPOINT = apiPath(`${STREAM_BASE}/start`);
const STOP_ENDPOINT = apiPath(`${STREAM_BASE}/stop`);
const STATS_ENDPOINT = apiPath(`${STREAM_BASE}/stats`);
const OFFER_ENDPOINT = STREAM_MODE === "webrtc" ? apiPath("/webrtc/offer") : "";
const SERVICES_ENDPOINT = apiPath("/api/services");
const HEALTH_ENDPOINT = apiPath("/api/system-health");
const WEB_SERVER_ENDPOINT = apiPath("/api/config/web-server");
const ARCHIVAL_ENDPOINT = apiPath("/api/config/archival");
const SPLIT_ENDPOINT = apiPath("/api/capture/split");
const AUTO_RECORD_ENDPOINT = apiPath("/api/capture/auto-record");
const MANUAL_RECORD_ENDPOINT = apiPath("/api/capture/manual-record");
const EVENTS_ENDPOINT = apiPath("/api/events");

function isSameOriginUrl(url) {
  if (typeof window === "undefined" || !window.location) {
    return true;
  }
  if (typeof url !== "string" || !url) {
    return true;
  }
  try {
    const resolved = new URL(url, window.location.href);
    return resolved.origin === window.location.origin;
  } catch (error) {
    return true;
  }
}

const EVENT_STREAM_SAME_ORIGIN = isSameOriginUrl(EVENTS_ENDPOINT);
const EVENT_STREAM_REQUIRES_CREDENTIALS = !EVENT_STREAM_SAME_ORIGIN;
const SERVICE_REFRESH_INTERVAL_MS = 5000;
const SERVICE_RESULT_TTL_MS = 15000;
const HEALTH_REFRESH_MIN_INTERVAL_MS = AUTO_REFRESH_INTERVAL_MS;
const CONFIG_REFRESH_INTERVAL_MS = 5000;
const VOICE_RECORDER_SERVICE_UNIT = "voice-recorder.service";
const SESSION_STORAGE_KEY = "tricorder.session";
const WINDOW_NAME_PREFIX = "tricorder.session:";
const ARCHIVAL_BACKENDS = new Set(["network_share", "rsync"]);
const WEB_SERVER_TLS_PROVIDERS = new Set(["letsencrypt", "manual"]);
const EVENT_STREAM_RETRY_MIN_MS = 1000;
const EVENT_STREAM_RETRY_MAX_MS = 15000;
const EVENT_STREAM_HEARTBEAT_TIMEOUT_MS = 30000;
const WAVEFORM_ZOOM_DEFAULT = 1;
const WAVEFORM_ZOOM_MIN = 0.25;
const WAVEFORM_ZOOM_MAX = 10;

function clampPlaybackRateValue(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  if (value < MIN_PLAYBACK_RATE) {
    return MIN_PLAYBACK_RATE;
  }
  if (value > MAX_PLAYBACK_RATE) {
    return MAX_PLAYBACK_RATE;
  }
  return value;
}

export {
  API_BASE,
  ARCHIVAL_BACKENDS,
  ARCHIVAL_ENDPOINT,
  AUTO_RECORD_ENDPOINT,
  AUTO_REFRESH_INTERVAL_MS,
  CLIPPER_STORAGE_KEY,
  COLLECTION_STORAGE_KEY,
  CONFIG_REFRESH_INTERVAL_MS,
  DEFAULT_LIMIT,
  EVENTS_ENDPOINT,
  EVENT_STREAM_HEARTBEAT_TIMEOUT_MS,
  EVENT_STREAM_REQUIRES_CREDENTIALS,
  EVENT_STREAM_RETRY_MAX_MS,
  EVENT_STREAM_RETRY_MIN_MS,
  EVENT_STREAM_SAME_ORIGIN,
  EVENT_STREAM_SUPPORTED,
  EVENT_TRIGGER_DEBOUNCE_MS,
  FILTER_PANEL_STORAGE_KEY,
  FILTER_STORAGE_KEY,
  HLS_URL,
  HEALTH_ENDPOINT,
  HEALTH_REFRESH_MIN_INTERVAL_MS,
  KEYBOARD_JOG_RATE_SECONDS_PER_SECOND,
  MANUAL_RECORD_ENDPOINT,
  MARKER_COLLAPSE_EPSILON_SECONDS,
  MARKER_LABEL_BASE_OFFSET_REM,
  MARKER_LABEL_EDGE_THRESHOLD,
  MARKER_LABEL_SPACING_THRESHOLD,
  MARKER_LABEL_STACK_SPACING_REM,
  MAX_LIMIT,
  MAX_PLAYBACK_RATE,
  MIN_CLIP_DURATION_SECONDS,
  MIN_PLAYBACK_RATE,
  OFFER_ENDPOINT,
  OFFLINE_REFRESH_INTERVAL_MS,
  POINTER_IDLE_CLEAR_DELAY_MS,
  RECYCLE_BIN_STATE_STORAGE_KEY,
  SERVICES_ENDPOINT,
  SERVICE_REFRESH_INTERVAL_MS,
  SERVICE_RESULT_TTL_MS,
  SESSION_STORAGE_KEY,
  SORT_STORAGE_KEY,
  SPLIT_ENDPOINT,
  START_ENDPOINT,
  STATS_ENDPOINT,
  STOP_ENDPOINT,
  STREAM_BASE,
  STREAM_MODE,
  THEME_STORAGE_KEY,
  TRANSPORT_SCRUB_MAX,
  TRANSPORT_SKIP_BACK_SECONDS,
  TRANSPORT_SKIP_FORWARD_SECONDS,
  TRANSPORT_STORAGE_KEY,
  VALID_TIME_RANGES,
  VOICE_RECORDER_SERVICE_UNIT,
  WAVEFORM_REFRESH_INTERVAL_MS,
  WAVEFORM_STORAGE_KEY,
  WAVEFORM_ZOOM_DEFAULT,
  WAVEFORM_ZOOM_MAX,
  WAVEFORM_ZOOM_MIN,
  WEBRTC_ICE_SERVERS,
  WEB_SERVER_ENDPOINT,
  WEB_SERVER_TLS_PROVIDERS,
  WINDOW_NAME_PREFIX,
  apiPath,
  clampPlaybackRateValue,
  isSameOriginUrl,
  normalizeApiBase,
};
