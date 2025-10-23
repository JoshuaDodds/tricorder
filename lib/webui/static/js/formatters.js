import { clampPlaybackRateValue, WAVEFORM_ZOOM_DEFAULT } from "./config.js";

function collectCandidateLocales() {
  if (typeof navigator === "undefined") {
    return [];
  }
  const candidates = [];
  if (Array.isArray(navigator.languages)) {
    for (const value of navigator.languages) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          candidates.push(trimmed);
        }
      }
    }
  }
  if (typeof navigator.language === "string") {
    const trimmed = navigator.language.trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  }
  return candidates;
}

function resolveUserLocales() {
  const candidates = collectCandidateLocales();
  if (candidates.length === 0) {
    return undefined;
  }

  if (typeof Intl !== "undefined" && typeof Intl.getCanonicalLocales === "function") {
    const canonical = [];
    const seen = new Set();
    for (const candidate of candidates) {
      try {
        const normalized = Intl.getCanonicalLocales([candidate]);
        for (const locale of normalized) {
          if (!seen.has(locale)) {
            canonical.push(locale);
            seen.add(locale);
          }
        }
      } catch (error) {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn(`Ignoring invalid locale "${candidate}"`, error);
        }
      }
    }
    if (canonical.length > 0) {
      return canonical;
    }
  }

  return undefined;
}

function createDateTimeFormatter(locales, options) {
  try {
    return new Intl.DateTimeFormat(locales, options);
  } catch (error) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("Falling back to default locale for date formatting", error);
    }
    return new Intl.DateTimeFormat(undefined, options);
  }
}

const userLocales = resolveUserLocales();

const dateFormatter = createDateTimeFormatter(userLocales, {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  hourCycle: "h23",
});

const timeFormatter = createDateTimeFormatter(userLocales, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

function formatIsoDateTime(isoString) {
  if (typeof isoString !== "string" || !isoString) {
    return null;
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return dateFormatter.format(date);
  } catch (error) {
    console.warn("Unable to format ISO date", error);
  }
  return date.toISOString();
}

function formatRecorderUptimeValue(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function formatRecorderUptimeHint(startEpoch) {
  if (!Number.isFinite(startEpoch)) {
    return "";
  }
  try {
    return `since ${dateFormatter.format(new Date(startEpoch * 1000))}`;
  } catch (error) {
    console.warn("Unable to format recorder uptime start", error);
  }
  return "";
}

function formatTransportClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function formatPlaybackRateLabel(value) {
  const normalized = clampPlaybackRateValue(value);
  if (Number.isInteger(normalized)) {
    return `${normalized}×`;
  }
  const formatted = normalized.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}×`;
}

function formatDate(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }
  return dateFormatter.format(new Date(seconds * 1000));
}

function formatRecordingStartTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const startDate = new Date(seconds * 1000);
  const now = new Date();
  const sameDay =
    startDate.getFullYear() === now.getFullYear() &&
    startDate.getMonth() === now.getMonth() &&
    startDate.getDate() === now.getDate();
  if (sameDay) {
    return timeFormatter.format(startDate);
  }
  return dateFormatter.format(startDate);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** idx;
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function formatShortDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function normalizeEncodingSource(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function formatEncodingSource(value) {
  const normalized = normalizeEncodingSource(value);
  if (!normalized) {
    return "";
  }
  if (normalized === "live") {
    return "Live capture";
  }
  if (normalized === "dropbox" || normalized === "ingest") {
    return "Dropbox ingest";
  }
  if (normalized === "unknown") {
    return "Unknown source";
  }
  return value.trim();
}

function formatTimecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00.000";
  }
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

function formatTimeSlug(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "000000000";
  }
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}${minutes
      .toString()
      .padStart(2, "0")}${secs.toString().padStart(2, "0")}${millis
      .toString()
      .padStart(3, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}${secs
    .toString()
    .padStart(2, "0")}${millis.toString().padStart(3, "0")}`;
}

function formatClipLengthText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Clip length: --";
  }
  const durationText = formatDuration(seconds);
  return `Clip length: ${durationText} (${seconds.toFixed(3)}s)`;
}

function formatClockTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return "--:--:--";
  }
  try {
    return timeFormatter.format(new Date(epochSeconds * 1000));
  } catch (error) {
    return "--:--:--";
  }
}

function formatWaveformZoom(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return `${WAVEFORM_ZOOM_DEFAULT}×`;
  }
  const decimals = value < 1 ? 2 : 1;
  const fixed = value.toFixed(decimals);
  const trimmed = Number.parseFloat(fixed).toString();
  return `${trimmed}×`;
}

function formatHzDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const rounded = Math.round(numeric);
  return `${rounded.toLocaleString()} Hz`;
}

function formatDbDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const rounded = Math.round(numeric * 10) / 10;
  const absValue = Math.abs(rounded);
  const decimals = Math.abs(Math.round(absValue) - absValue) > 1e-6 ? 1 : 0;
  const formatted = absValue.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const prefix = rounded < 0 ? "\u2212" : "";
  return `${prefix}${formatted} dB`;
}

function formatUnitless(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const decimals = numeric < 1 ? 2 : 1;
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatQualityDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const decimals = numeric < 10 ? 1 : 0;
  const formatted = numeric.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `Q ${formatted}`;
}

function formatRatioDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const clamped = Math.min(1, Math.max(0, numeric));
  return clamped.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export {
  dateFormatter,
  formatBytes,
  formatClockTime,
  formatClipLengthText,
  formatDate,
  formatDbDisplay,
  formatDuration,
  formatEncodingSource,
  formatHzDisplay,
  formatIsoDateTime,
  formatPlaybackRateLabel,
  formatQualityDisplay,
  formatRecorderUptimeHint,
  formatRecorderUptimeValue,
  formatRecordingStartTime,
  formatRatioDisplay,
  formatShortDuration,
  formatTimeSlug,
  formatTimecode,
  formatTransportClock,
  formatUnitless,
  formatWaveformZoom,
  normalizeEncodingSource,
  timeFormatter,
  userLocales,
};
