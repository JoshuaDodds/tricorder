export function createRecordingPathHelpers({
  apiPath,
  recycleBinAudioUrl,
  recycleBinWaveformUrl,
  isRecycleBinRecord,
  playbackSourceState,
}) {
  function recordingUrl(path, { download = false } = {}) {
    const encoded = path
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const suffix = download ? "?download=1" : "";
    return apiPath(`/recordings/${encoded}${suffix}`);
  }

  function normalizePlaybackSource(value) {
    return value === "raw" ? "raw" : "processed";
  }

  function recordHasRawAudio(record) {
    if (!record || isRecycleBinRecord(record)) {
      return false;
    }
    const rawCandidate =
      typeof record.raw_audio_path === "string" ? record.raw_audio_path.trim() : "";
    return rawCandidate !== "";
  }

  function recordAudioUrl(record, { download = false } = {}) {
    if (isRecycleBinRecord(record)) {
      return recycleBinAudioUrl(record.recycleBinId, { download });
    }
    if (record && typeof record.path === "string" && record.path) {
      return recordingUrl(record.path, { download });
    }
    return "";
  }

  function recordRawAudioUrl(record, { download = false } = {}) {
    if (!recordHasRawAudio(record)) {
      return "";
    }
    const rawPath = String(record.raw_audio_path).trim();
    if (!rawPath) {
      return "";
    }
    return recordingUrl(rawPath, { download });
  }

  function resolvePlaybackSourceUrl(
    record,
    { download = false, source = playbackSourceState.mode, allowFallback = true } = {},
  ) {
    const normalized = normalizePlaybackSource(source);
    if (normalized === "raw") {
      const rawUrl = recordRawAudioUrl(record, { download });
      if (rawUrl) {
        return rawUrl;
      }
      if (!allowFallback) {
        return "";
      }
    }
    return recordAudioUrl(record, { download });
  }

  function recordWaveformUrl(record) {
    if (!record) {
      return "";
    }
    if (isRecycleBinRecord(record)) {
      if (!record.waveform_available) {
        return "";
      }
      const identifier =
        typeof record.waveform_path === "string" && record.waveform_path
          ? record.waveform_path
          : record.recycleBinId;
      return recycleBinWaveformUrl(identifier);
    }
    if (typeof record.waveform_path === "string" && record.waveform_path) {
      return recordingUrl(record.waveform_path);
    }
    return "";
  }

  return {
    recordingUrl,
    normalizePlaybackSource,
    recordAudioUrl,
    recordHasRawAudio,
    recordRawAudioUrl,
    resolvePlaybackSourceUrl,
    recordWaveformUrl,
  };
}
