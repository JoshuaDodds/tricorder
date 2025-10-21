import {
  normalizeMotionSegments,
  normalizeTriggerSources,
  toFiniteOrNull,
} from "../normalizers.js";

export function toFinalizedRecordingPath(partialPath) {
  if (typeof partialPath !== "string" || !partialPath) {
    return null;
  }
  const finalized = partialPath.replace(/\.partial(?=\.[^/.]+$)/, "");
  if (finalized === partialPath) {
    return null;
  }
  return finalized;
}

export function findFinalizedRecordForPartial(record, records) {
  if (!record || !record.isPartial || typeof record.path !== "string") {
    return null;
  }
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }
  const candidatePath = toFinalizedRecordingPath(record.path);
  if (!candidatePath) {
    return null;
  }
  return records.find((entry) => entry && entry.path === candidatePath) || null;
}

export function normalizeRecordingProgressRecord(progress) {
  if (!progress || typeof progress !== "object") {
    return null;
  }
  const rawPath = typeof progress.path === "string" ? progress.path.trim() : "";
  if (!rawPath) {
    return null;
  }
  const name =
    typeof progress.name === "string" && progress.name
      ? progress.name
      : "Current recording";
  const streamPath =
    typeof progress.stream_path === "string" && progress.stream_path
      ? progress.stream_path
      : rawPath;
  const sizeValue = toFiniteOrNull(progress.size_bytes);
  const durationValue = toFiniteOrNull(progress.duration_seconds);
  const modifiedValue = toFiniteOrNull(progress.modified);
  const startEpoch = toFiniteOrNull(progress.start_epoch);
  const startedEpoch = toFiniteOrNull(progress.started_epoch);
  const triggerOffset = toFiniteOrNull(progress.trigger_offset_seconds);
  const releaseOffset = toFiniteOrNull(progress.release_offset_seconds);
  const motionTriggerOffset = toFiniteOrNull(progress.motion_trigger_offset_seconds);
  const motionReleaseOffset = toFiniteOrNull(progress.motion_release_offset_seconds);
  const motionStartedEpoch = toFiniteOrNull(progress.motion_started_epoch);
  const motionReleasedEpoch = toFiniteOrNull(progress.motion_released_epoch);
  const motionSegments = normalizeMotionSegments(progress.motion_segments);
  const triggerSources = normalizeTriggerSources(progress.trigger_sources);

  const record = {
    name,
    path: rawPath,
    stream_path: streamPath,
    day: typeof progress.day === "string" ? progress.day : "",
    collection:
      typeof progress.collection === "string" && progress.collection
        ? progress.collection
        : "recent",
    extension:
      typeof progress.extension === "string" && progress.extension
        ? progress.extension
        : "",
    size_bytes: Number.isFinite(sizeValue) ? Math.max(0, Math.trunc(sizeValue)) : 0,
    modified:
      Number.isFinite(modifiedValue) && modifiedValue !== null
        ? modifiedValue
        : Date.now() / 1000,
    modified_iso:
      typeof progress.modified_iso === "string" ? progress.modified_iso : "",
    duration_seconds: Number.isFinite(durationValue) ? Math.max(0, durationValue) : null,
    start_epoch: Number.isFinite(startEpoch) ? startEpoch : null,
    started_epoch: Number.isFinite(startedEpoch) ? startedEpoch : null,
    started_at: typeof progress.started_at === "string" ? progress.started_at : "",
    waveform_path:
      typeof progress.waveform_path === "string" ? progress.waveform_path : "",
    has_transcript: false,
    transcript_path: "",
    transcript_event_type: "",
    transcript_text: "",
    transcript_updated: null,
    transcript_updated_iso: "",
    trigger_offset_seconds: Number.isFinite(triggerOffset) ? triggerOffset : null,
    release_offset_seconds: Number.isFinite(releaseOffset) ? releaseOffset : null,
    motion_trigger_offset_seconds: Number.isFinite(motionTriggerOffset)
      ? motionTriggerOffset
      : null,
    motion_release_offset_seconds: Number.isFinite(motionReleaseOffset)
      ? motionReleaseOffset
      : null,
    motion_started_epoch: Number.isFinite(motionStartedEpoch) ? motionStartedEpoch : null,
    motion_released_epoch: Number.isFinite(motionReleasedEpoch)
      ? motionReleasedEpoch
      : null,
    motion_segments: motionSegments,
    trigger_sources: triggerSources,
    isPartial: true,
    inProgress: true,
  };

  return record;
}

export function deriveInProgressRecord(captureStatus) {
  const status =
    captureStatus && typeof captureStatus === "object" ? captureStatus : null;
  if (!status || !status.capturing) {
    return null;
  }

  const event = status && typeof status.event === "object" ? status.event : null;
  if (!event || event.in_progress !== true) {
    return null;
  }

  const triggerCandidates = [];
  if (Array.isArray(event.trigger_sources)) {
    triggerCandidates.push(...event.trigger_sources);
  }
  if (Array.isArray(status.trigger_sources)) {
    triggerCandidates.push(...status.trigger_sources);
  }
  const triggerSources = normalizeTriggerSources(triggerCandidates);

  const relCandidates = [];
  if (
    typeof event.partial_recording_rel_path === "string" &&
    event.partial_recording_rel_path.trim() !== ""
  ) {
    relCandidates.push(event.partial_recording_rel_path.trim());
  }
  if (
    typeof status.partial_recording_rel_path === "string" &&
    status.partial_recording_rel_path.trim() !== ""
  ) {
    relCandidates.push(status.partial_recording_rel_path.trim());
  }

  const relPath = relCandidates.find((value) => value) || "";
  if (!relPath) {
    return null;
  }

  const waveformRelCandidates = [];
  if (
    typeof event.partial_waveform_rel_path === "string" &&
    event.partial_waveform_rel_path.trim() !== ""
  ) {
    waveformRelCandidates.push(event.partial_waveform_rel_path.trim());
  }
  if (
    typeof status.partial_waveform_rel_path === "string" &&
    status.partial_waveform_rel_path.trim() !== ""
  ) {
    waveformRelCandidates.push(status.partial_waveform_rel_path.trim());
  }
  const waveformRelPath = waveformRelCandidates.find((value) => value) || "";

  const sizeValue = toFiniteOrNull(status.event_size_bytes);
  const durationValue = toFiniteOrNull(status.event_duration_seconds);
  const startedEpoch = toFiniteOrNull(event.started_epoch);
  const startedAt =
    typeof event.started_at === "string" && event.started_at
      ? event.started_at
      : "";
  const baseName =
    typeof event.base_name === "string" && event.base_name
      ? event.base_name
      : "Current recording";
  const streamingFormat =
    typeof event.streaming_container_format === "string" &&
    event.streaming_container_format
      ? event.streaming_container_format.toLowerCase()
      : typeof status.streaming_container_format === "string" &&
          status.streaming_container_format
        ? status.streaming_container_format.toLowerCase()
        : "opus";
  const extension = streamingFormat === "webm" ? "webm" : "opus";
  const day = relPath.split("/")[0] || "";
  const modifiedEpoch =
    startedEpoch !== null ? startedEpoch : Date.now() / 1000;

  let waveformPath = "";
  if (waveformRelPath) {
    waveformPath = waveformRelPath;
  } else if (
    typeof event.partial_waveform_path === "string" &&
    event.partial_waveform_path
  ) {
    waveformPath = event.partial_waveform_path;
  } else if (
    typeof status.partial_waveform_path === "string" &&
    status.partial_waveform_path
  ) {
    waveformPath = status.partial_waveform_path;
  }

  return {
    name: baseName,
    path: relPath,
    stream_path: relPath,
    day,
    extension,
    size_bytes: sizeValue !== null ? Math.max(0, sizeValue) : 0,
    modified: modifiedEpoch,
    modified_iso: new Date(modifiedEpoch * 1000).toISOString(),
    duration_seconds: durationValue !== null ? Math.max(0, durationValue) : null,
    start_epoch: startedEpoch,
    started_at: startedAt,
    waveform_path: waveformPath,
    has_transcript: false,
    transcript_path: "",
    transcript_event_type: "",
    transcript_text: "",
    transcript_updated: null,
    transcript_updated_iso: "",
    trigger_offset_seconds: null,
    release_offset_seconds: null,
    motion_trigger_offset_seconds: toFiniteOrNull(event.motion_trigger_offset_seconds),
    motion_release_offset_seconds: toFiniteOrNull(event.motion_release_offset_seconds),
    motion_started_epoch: toFiniteOrNull(event.motion_started_epoch),
    motion_released_epoch: toFiniteOrNull(event.motion_released_epoch),
    motion_segments: normalizeMotionSegments(event.motion_segments),
    trigger_sources: triggerSources,
    isPartial: true,
    inProgress: true,
  };
}

export function computeRecordsFingerprint(records, options = null) {
  if (!Array.isArray(records) || records.length === 0) {
    return "";
  }
  const skipPartialVolatile =
    options && options.skipPartialVolatile === true;
  const parts = [];
  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const path = typeof record.path === "string" ? record.path : "";
    const isPartial = Boolean(record.isPartial);
    const modified = Number.isFinite(record.modified) ? record.modified : "";
    const size = Number.isFinite(record.size_bytes) ? record.size_bytes : "";
    const duration = Number.isFinite(record.duration_seconds)
      ? record.duration_seconds
      : "";
    const trigger = Number.isFinite(record.trigger_offset_seconds)
      ? record.trigger_offset_seconds
      : "";
    const release = Number.isFinite(record.release_offset_seconds)
      ? record.release_offset_seconds
      : "";
    const motionTrigger = Number.isFinite(record.motion_trigger_offset_seconds)
      ? record.motion_trigger_offset_seconds
      : "";
    const motionRelease = Number.isFinite(record.motion_release_offset_seconds)
      ? record.motion_release_offset_seconds
      : "";
    const motionStarted = Number.isFinite(record.motion_started_epoch)
      ? record.motion_started_epoch
      : "";
    const motionReleased = Number.isFinite(record.motion_released_epoch)
      ? record.motion_released_epoch
      : "";
    const segmentsSource = Array.isArray(record.motion_segments)
      ? record.motion_segments
      : [];
    const motionSegmentsKey = segmentsSource
      .map((segment) => {
        if (!segment || typeof segment !== "object") {
          return "";
        }
        const start = toFiniteOrNull(segment.start);
        const end = toFiniteOrNull(segment.end);
        const safeStart = Number.isFinite(start) ? start : "";
        const safeEnd = Number.isFinite(end) ? end : "";
        return `${safeStart}-${safeEnd}`;
      })
      .join(";");
    const waveform = typeof record.waveform_path === "string" ? record.waveform_path : "";
    let safeModified = modified;
    let safeSize = size;
    let safeDuration = duration;
    let safeTrigger = trigger;
    let safeRelease = release;
    let safeMotionTrigger = motionTrigger;
    let safeMotionRelease = motionRelease;
    let safeMotionStarted = motionStarted;
    let safeMotionReleased = motionReleased;
    let safeMotionSegments = motionSegmentsKey;
    let safeWaveform = waveform;
    if (skipPartialVolatile && isPartial) {
      safeModified = "";
      safeSize = "";
      safeDuration = "";
      safeTrigger = "";
      safeRelease = "";
      safeMotionTrigger = "";
      safeMotionRelease = "";
      safeMotionStarted = "";
      safeMotionReleased = "";
      safeMotionSegments = "";
      safeWaveform = "";
    }
    if (skipPartialVolatile) {
      parts.push(
        `${path}|${isPartial ? "partial" : "final"}|${safeModified}|${safeSize}|${safeDuration}|${safeTrigger}|${safeRelease}|${safeMotionTrigger}|${safeMotionRelease}|${safeMotionStarted}|${safeMotionReleased}|${safeMotionSegments}|${safeWaveform}`
      );
    } else {
      parts.push(
        `${path}|${safeModified}|${safeSize}|${safeDuration}|${safeTrigger}|${safeRelease}|${safeMotionTrigger}|${safeMotionRelease}|${safeMotionStarted}|${safeMotionReleased}|${safeMotionSegments}|${safeWaveform}`
      );
    }
  }
  return parts.join("\n");
}

export function computePartialFingerprint(record) {
  if (!record || typeof record !== "object") {
    return "";
  }

  const path = typeof record.path === "string" ? record.path : "";
  const size = Number.isFinite(record.size_bytes) ? record.size_bytes : "";
  const duration = Number.isFinite(record.duration_seconds)
    ? record.duration_seconds
    : "";
  const modified = Number.isFinite(record.modified) ? record.modified : "";
  const name = typeof record.name === "string" ? record.name : "";
  const extension = typeof record.extension === "string" ? record.extension : "";
  const inProgress = record && record.inProgress === true ? "1" : "0";
  const motionTrigger = Number.isFinite(record.motion_trigger_offset_seconds)
    ? record.motion_trigger_offset_seconds
    : "";
  const motionRelease = Number.isFinite(record.motion_release_offset_seconds)
    ? record.motion_release_offset_seconds
    : "";
  const motionStarted = Number.isFinite(record.motion_started_epoch)
    ? record.motion_started_epoch
    : "";
  const motionReleased = Number.isFinite(record.motion_released_epoch)
    ? record.motion_released_epoch
    : "";
  const segmentsSource = Array.isArray(record.motion_segments)
    ? record.motion_segments
    : [];
  const motionSegments = segmentsSource
    .map((segment) => {
      if (!segment || typeof segment !== "object") {
        return "";
      }
      const start = toFiniteOrNull(segment.start);
      const end = toFiniteOrNull(segment.end);
      const safeStart = Number.isFinite(start) ? start : "";
      const safeEnd = Number.isFinite(end) ? end : "";
      return `${safeStart}-${safeEnd}`;
    })
    .join(";");

  return [
    path,
    size,
    duration,
    modified,
    name,
    extension,
    inProgress,
    motionTrigger,
    motionRelease,
    motionStarted,
    motionReleased,
    motionSegments,
  ].join("|");
}
