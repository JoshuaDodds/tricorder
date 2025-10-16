export function recordMetadataChanged(previous, next) {
  if (!previous || !next) {
    return false;
  }

  const previousModified = Number.isFinite(previous.modified)
    ? Number(previous.modified)
    : null;
  const nextModified = Number.isFinite(next.modified) ? Number(next.modified) : null;
  if (previousModified !== null && nextModified !== null && previousModified !== nextModified) {
    return true;
  }
  if (previousModified === null || nextModified === null) {
    const prevIso = typeof previous.modified_iso === "string" ? previous.modified_iso : "";
    const nextIso = typeof next.modified_iso === "string" ? next.modified_iso : "";
    if (prevIso !== nextIso) {
      return true;
    }
  }

  const previousDuration = Number.isFinite(previous.duration_seconds)
    ? Number(previous.duration_seconds)
    : null;
  const nextDuration = Number.isFinite(next.duration_seconds) ? Number(next.duration_seconds) : null;
  if (previousDuration !== nextDuration) {
    return true;
  }

  const previousSize = Number.isFinite(previous.size_bytes) ? Number(previous.size_bytes) : null;
  const nextSize = Number.isFinite(next.size_bytes) ? Number(next.size_bytes) : null;
  if (previousSize !== nextSize) {
    return true;
  }

  const previousWaveform =
    typeof previous.waveform_path === "string" ? previous.waveform_path : "";
  const nextWaveform = typeof next.waveform_path === "string" ? next.waveform_path : "";
  if (previousWaveform !== nextWaveform) {
    return true;
  }

  return false;
}

export function resolveTriggerFlags(source) {
  const triggers = Array.isArray(source) ? source : [];
  const normalized = new Set();
  for (const entry of triggers) {
    if (typeof entry !== "string") {
      continue;
    }
    const token = entry.trim().toLowerCase();
    if (!token) {
      continue;
    }
    normalized.add(token);
  }
  const manual = normalized.has("manual");
  const split = normalized.has("split");
  const motion = normalized.has("motion");
  const rms = normalized.has("rms");
  const vad = normalized.has("vad") || normalized.has("bad");
  return {
    manual,
    split,
    motion,
    rms,
    vad,
    rmsVad: rms && vad,
  };
}
