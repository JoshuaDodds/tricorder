import { toFiniteOrNull } from "../normalizers.js";
import {
  formatDbDisplay,
  formatHzDisplay,
  formatQualityDisplay,
  formatUnitless,
  formatRatioDisplay,
} from "../../formatters.js";

function parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return ["1", "true", "yes", "on"].includes(normalized);
  }
  return Boolean(value);
}

function parseMotionFlag(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["1", "true", "yes", "on", "running"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", "stopped"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function isMotionTriggeredEvent(source) {
  if (!source || typeof source !== "object") {
    return false;
  }

  const motionTrigger = toFiniteOrNull(source.motion_trigger_offset_seconds);
  if (Number.isFinite(motionTrigger)) {
    return true;
  }

  const motionReleaseOffset = toFiniteOrNull(source.motion_release_offset_seconds);
  if (Number.isFinite(motionReleaseOffset)) {
    return true;
  }

  const motionStarted = toFiniteOrNull(source.motion_started_epoch);
  if (Number.isFinite(motionStarted)) {
    return true;
  }

  const motionReleased = toFiniteOrNull(source.motion_released_epoch);
  if (Number.isFinite(motionReleased)) {
    return true;
  }

  const motionActive = parseBoolean(source.motion_active);
  if (motionActive === true) {
    return true;
  }

  const motionSequence = toFiniteOrNull(source.motion_sequence);
  if (Number.isFinite(motionSequence) && motionSequence > 0 && motionActive !== false) {
    return true;
  }

  return false;
}

function resolveNextMotionState(payloadSnapshot, previousSnapshot, eventStreamConnected) {
  const nextSnapshot =
    payloadSnapshot && typeof payloadSnapshot === "object" ? payloadSnapshot : null;
  const currentSnapshot =
    previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : null;
  const hasEventStream = Boolean(eventStreamConnected);

  if (nextSnapshot) {
    const payloadSequence = toFiniteOrNull(nextSnapshot.sequence);
    const currentSequence = currentSnapshot ? toFiniteOrNull(currentSnapshot.sequence) : null;
    if (
      !hasEventStream ||
      !currentSnapshot ||
      (payloadSequence !== null &&
        (currentSequence === null || payloadSequence > currentSequence))
    ) {
      return nextSnapshot;
    }
    return currentSnapshot;
  }

  if (!hasEventStream) {
    return null;
  }

  return currentSnapshot;
}

function parseListInput(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
}

async function extractErrorMessage(response) {
  if (!response) {
    return "";
  }
  try {
    const payload = await response.json();
    if (payload && typeof payload === "object") {
      if (typeof payload.error === "string" && payload.error) {
        return payload.error;
      }
      if (typeof payload.message === "string" && payload.message) {
        return payload.message;
      }
    }
  } catch (error) {
    // Ignore JSON parsing issues.
  }
  try {
    const text = await response.text();
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  } catch (error) {
    // Ignore text extraction errors.
  }
  return "";
}

const AUDIO_SAMPLE_RATES = [48000, 32000, 16000];
const AUDIO_FRAME_LENGTHS = [10, 20, 30];
const STREAMING_MODES = new Set(["hls", "webrtc"]);
const TRANSCRIPTION_ENGINES = new Set(["vosk"]);

const AUDIO_FILTER_LIMITS = {
  denoise: {
    noise_floor_db: { min: -80, max: 0, formatter: formatDbDisplay },
  },
  highpass: {
    cutoff_hz: { min: 20, max: 2000, formatter: formatHzDisplay },
  },
  lowpass: {
    cutoff_hz: { min: 1000, max: 20000, formatter: formatHzDisplay },
  },
  notch: {
    freq_hz: { min: 20, max: 20000, formatter: formatHzDisplay },
    quality: { min: 0.1, max: 100, formatter: formatQualityDisplay },
  },
  spectral_gate: {
    sensitivity: { min: 0.1, max: 4, formatter: formatUnitless },
    reduction_db: { min: -60, max: 0, formatter: formatDbDisplay },
    noise_update: { min: 0, max: 1, formatter: formatRatioDisplay },
    noise_decay: { min: 0, max: 1, formatter: formatRatioDisplay },
  },
};

const AUDIO_FILTER_ENUMS = {
  denoise: {
    type: new Set(["afftdn"]),
  },
};

const AUDIO_FILTER_DEFAULTS = {
  denoise: { enabled: false, type: "afftdn", noise_floor_db: -30 },
  highpass: { enabled: false, cutoff_hz: 90 },
  lowpass: { enabled: false, cutoff_hz: 10000 },
  notch: { enabled: false, freq_hz: 60, quality: 30 },
  spectral_gate: {
    enabled: false,
    sensitivity: 1.5,
    reduction_db: -18,
    noise_update: 0.1,
    noise_decay: 0.95,
  },
};

const AUDIO_CALIBRATION_DEFAULTS = {
  auto_noise_profile: false,
  auto_gain: false,
};

function audioDefaults() {
  return {
    device: "",
    sample_rate: 48000,
    channels: 1,
    frame_ms: 20,
    gain: 2.5,
    vad_aggressiveness: 3,
    usb_reset_workaround: true,
    filter_chain: {
      denoise: { ...AUDIO_FILTER_DEFAULTS.denoise },
      highpass: { ...AUDIO_FILTER_DEFAULTS.highpass },
      lowpass: { ...AUDIO_FILTER_DEFAULTS.lowpass },
      notch: { ...AUDIO_FILTER_DEFAULTS.notch },
      spectral_gate: { ...AUDIO_FILTER_DEFAULTS.spectral_gate },
    },
    calibration: { ...AUDIO_CALIBRATION_DEFAULTS },
  };
}

function canonicalAudioSettings(settings) {
  const defaults = audioDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  if (typeof source.device === "string") {
    defaults.device = source.device.trim();
  }

  const sampleRate = Number(source.sample_rate);
  if (Number.isFinite(sampleRate)) {
    const rounded = Math.round(sampleRate);
    defaults.sample_rate = AUDIO_SAMPLE_RATES.includes(rounded)
      ? rounded
      : defaults.sample_rate;
  }

  const channels = Number(source.channels);
  if (Number.isFinite(channels)) {
    const rounded = Math.round(channels);
    defaults.channels = rounded === 2 ? 2 : 1;
  }

  const frameMs = Number(source.frame_ms);
  if (Number.isFinite(frameMs)) {
    const rounded = Math.round(frameMs);
    defaults.frame_ms = AUDIO_FRAME_LENGTHS.includes(rounded)
      ? rounded
      : defaults.frame_ms;
  }

  const gain = Number(source.gain);
  if (Number.isFinite(gain)) {
    defaults.gain = Math.max(0.1, Math.min(16, gain));
  }

  const vad = Number(source.vad_aggressiveness);
  if (Number.isFinite(vad)) {
    const rounded = Math.round(vad);
    defaults.vad_aggressiveness = Math.max(0, Math.min(3, rounded));
  }

  if (Object.prototype.hasOwnProperty.call(source, "usb_reset_workaround")) {
    defaults.usb_reset_workaround = parseBoolean(source.usb_reset_workaround);
  }

  const filterSource =
    settings && typeof settings === "object" && settings.filter_chain && typeof settings.filter_chain === "object"
      ? settings.filter_chain
      : null;
  if (filterSource) {
    const target = defaults.filter_chain;
    for (const [stage, fieldSpecs] of Object.entries(AUDIO_FILTER_LIMITS)) {
      const stageTarget = target[stage];
      const stagePayload = filterSource[stage];
      if (!stageTarget || typeof stageTarget !== "object") {
        continue;
      }
      if (!stagePayload || typeof stagePayload !== "object") {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(stagePayload, "enabled")) {
        stageTarget.enabled = parseBoolean(stagePayload.enabled);
      }
      for (const [field, spec] of Object.entries(fieldSpecs)) {
        if (!Object.prototype.hasOwnProperty.call(stagePayload, field)) {
          continue;
        }
        const rawValue = Number(stagePayload[field]);
        if (Number.isFinite(rawValue)) {
          const clamped = Math.min(spec.max, Math.max(spec.min, rawValue));
          stageTarget[field] = clamped;
        }
      }
      const enumSpecs = AUDIO_FILTER_ENUMS[stage];
      if (enumSpecs && typeof enumSpecs === "object") {
        for (const [field, allowed] of Object.entries(enumSpecs)) {
          if (!Object.prototype.hasOwnProperty.call(stagePayload, field)) {
            continue;
          }
          const rawValue = stagePayload[field];
          if (typeof rawValue !== "string") {
            continue;
          }
          const normalized = rawValue.trim().toLowerCase();
          if (allowed instanceof Set && allowed.has(normalized)) {
            stageTarget[field] = normalized;
          }
        }
      }
    }
  }

  const calibrationSource =
    settings && typeof settings === "object" && settings.calibration && typeof settings.calibration === "object"
      ? settings.calibration
      : null;
  if (calibrationSource) {
    const calibrationTarget = defaults.calibration;
    if (Object.prototype.hasOwnProperty.call(calibrationSource, "auto_noise_profile")) {
      calibrationTarget.auto_noise_profile = parseBoolean(calibrationSource.auto_noise_profile);
    }
    if (Object.prototype.hasOwnProperty.call(calibrationSource, "auto_gain")) {
      calibrationTarget.auto_gain = parseBoolean(calibrationSource.auto_gain);
    }
  }

  return defaults;
}

function canonicalAudioFromConfig(config) {
  const section = config && typeof config === "object" ? config.audio : null;
  return canonicalAudioSettings(section);
}

function segmenterDefaults() {
  return {
    pre_pad_ms: 2000,
    post_pad_ms: 3000,
    motion_release_padding_minutes: 0,
    rms_threshold: 300,
    keep_window_frames: 30,
    start_consecutive: 25,
    keep_consecutive: 25,
    flush_threshold_bytes: 128 * 1024,
    max_queue_frames: 512,
    min_clip_seconds: 0,
    use_rnnoise: false,
    use_noisereduce: false,
    denoise_before_vad: false,
    autosplit_interval_minutes: 15,
    auto_record_motion_override: true,
    enable_rms_trigger: true,
    enable_vad_trigger: true,
    filter_chain_avg_budget_ms: 6,
    filter_chain_peak_budget_ms: 15,
    filter_chain_metrics_window: 50,
    filter_chain_log_throttle_sec: 30,
    streaming_encode: false,
    streaming_encode_container: "opus",
    parallel_encode: {
      enabled: true,
      load_avg_per_cpu: 0.75,
      min_event_seconds: 1,
      cpu_check_interval_sec: 1,
      offline_max_workers: 2,
      offline_load_avg_per_cpu: 0.75,
      offline_cpu_check_interval_sec: 1,
      live_waveform_buckets: 1024,
      live_waveform_update_interval_sec: 1,
    },
    max_pending_encodes: 8,
    event_tags: {
      human: "Human",
      other: "Other",
      both: "Both",
    },
  };
}

function canonicalSegmenterSettings(settings) {
  const defaults = segmenterDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  function toInt(value, fallback, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    let candidate = Math.round(number);
    if (typeof min === "number") {
      candidate = Math.max(min, candidate);
    }
    if (typeof max === "number") {
      candidate = Math.min(max, candidate);
    }
    return candidate;
  }

  function toFloat(value, fallback, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    let candidate = number;
    if (typeof min === "number") {
      candidate = Math.max(min, candidate);
    }
    if (typeof max === "number") {
      candidate = Math.min(max, candidate);
    }
    return candidate;
  }

  defaults.pre_pad_ms = toInt(source.pre_pad_ms, defaults.pre_pad_ms, { min: 0, max: 60000 });
  defaults.post_pad_ms = toInt(source.post_pad_ms, defaults.post_pad_ms, { min: 0, max: 120000 });
  defaults.motion_release_padding_minutes = toFloat(
    source.motion_release_padding_minutes,
    defaults.motion_release_padding_minutes,
    { min: 0, max: 30 }
  );
  defaults.rms_threshold = toInt(source.rms_threshold, defaults.rms_threshold, { min: 0, max: 10000 });
  defaults.keep_window_frames = toInt(
    source.keep_window_frames,
    defaults.keep_window_frames,
    { min: 1, max: 2000 }
  );
  defaults.start_consecutive = toInt(
    source.start_consecutive,
    defaults.start_consecutive,
    { min: 1, max: 2000 }
  );
  defaults.keep_consecutive = toInt(
    source.keep_consecutive,
    defaults.keep_consecutive,
    { min: 1, max: 2000 }
  );
  defaults.flush_threshold_bytes = toInt(
    source.flush_threshold_bytes,
    defaults.flush_threshold_bytes,
    { min: 4096, max: 4 * 1024 * 1024 }
  );
  defaults.max_queue_frames = toInt(
    source.max_queue_frames,
    defaults.max_queue_frames,
    { min: 16, max: 4096 }
  );
  defaults.min_clip_seconds = toFloat(
    source.min_clip_seconds,
    defaults.min_clip_seconds,
    { min: 0, max: 600 }
  );

  defaults.use_rnnoise = parseBoolean(source.use_rnnoise);
  defaults.use_noisereduce = parseBoolean(source.use_noisereduce);
  defaults.denoise_before_vad = parseBoolean(source.denoise_before_vad);

  defaults.autosplit_interval_minutes = toFloat(
    source.autosplit_interval_minutes,
    defaults.autosplit_interval_minutes,
    { min: 0, max: 24 * 60 }
  );
  defaults.auto_record_motion_override = parseBoolean(source.auto_record_motion_override);
  if (Object.prototype.hasOwnProperty.call(source, "enable_rms_trigger")) {
    defaults.enable_rms_trigger = parseBoolean(source.enable_rms_trigger);
  }
  if (Object.prototype.hasOwnProperty.call(source, "enable_vad_trigger")) {
    defaults.enable_vad_trigger = parseBoolean(source.enable_vad_trigger);
  }
  defaults.filter_chain_avg_budget_ms = toFloat(
    source.filter_chain_avg_budget_ms,
    defaults.filter_chain_avg_budget_ms,
    { min: 0, max: 100 }
  );
  defaults.filter_chain_peak_budget_ms = toFloat(
    source.filter_chain_peak_budget_ms,
    defaults.filter_chain_peak_budget_ms,
    { min: 0, max: 250 }
  );
  defaults.filter_chain_metrics_window = toInt(
    source.filter_chain_metrics_window,
    defaults.filter_chain_metrics_window,
    { min: 1, max: 10000 }
  );
  defaults.filter_chain_log_throttle_sec = toFloat(
    source.filter_chain_log_throttle_sec,
    defaults.filter_chain_log_throttle_sec,
    { min: 0, max: 600 }
  );

  defaults.streaming_encode = parseBoolean(source.streaming_encode);
  if (typeof source.streaming_encode_container === "string") {
    const normalized = source.streaming_encode_container.trim().toLowerCase();
    if (normalized === "opus" || normalized === "webm") {
      defaults.streaming_encode_container = normalized;
    }
  }

  defaults.max_pending_encodes = toInt(
    source.max_pending_encodes,
    defaults.max_pending_encodes,
    { min: 0, max: 1000 }
  );

  const parallelDefaults =
    defaults.parallel_encode && typeof defaults.parallel_encode === "object"
      ? defaults.parallel_encode
      : {
          enabled: true,
          load_avg_per_cpu: 0.75,
          min_event_seconds: 1,
          cpu_check_interval_sec: 1,
          offline_max_workers: 2,
          offline_load_avg_per_cpu: 0.75,
          offline_cpu_check_interval_sec: 1,
          live_waveform_buckets: 1024,
          live_waveform_update_interval_sec: 1,
        };
  const parallelSource =
    source.parallel_encode && typeof source.parallel_encode === "object"
      ? source.parallel_encode
      : {};
  parallelDefaults.enabled = parseBoolean(parallelSource.enabled);
  parallelDefaults.load_avg_per_cpu = toFloat(
    parallelSource.load_avg_per_cpu,
    parallelDefaults.load_avg_per_cpu,
    { min: 0, max: 10 }
  );
  parallelDefaults.min_event_seconds = toFloat(
    parallelSource.min_event_seconds,
    parallelDefaults.min_event_seconds,
    { min: 0, max: 3600 }
  );
  parallelDefaults.cpu_check_interval_sec = toFloat(
    parallelSource.cpu_check_interval_sec,
    parallelDefaults.cpu_check_interval_sec,
    { min: 0, max: 3600 }
  );
  parallelDefaults.offline_max_workers = toInt(
    parallelSource.offline_max_workers,
    parallelDefaults.offline_max_workers,
    { min: 0, max: 32 }
  );
  parallelDefaults.offline_load_avg_per_cpu = toFloat(
    parallelSource.offline_load_avg_per_cpu,
    parallelDefaults.offline_load_avg_per_cpu,
    { min: 0, max: 10 }
  );
  parallelDefaults.offline_cpu_check_interval_sec = toFloat(
    parallelSource.offline_cpu_check_interval_sec,
    parallelDefaults.offline_cpu_check_interval_sec,
    { min: 0, max: 3600 }
  );
  parallelDefaults.live_waveform_buckets = toInt(
    parallelSource.live_waveform_buckets,
    parallelDefaults.live_waveform_buckets,
    { min: 1, max: 16384 }
  );
  parallelDefaults.live_waveform_update_interval_sec = toFloat(
    parallelSource.live_waveform_update_interval_sec,
    parallelDefaults.live_waveform_update_interval_sec,
    { min: 0.05, max: 60 }
  );
  defaults.parallel_encode = parallelDefaults;

  const tagDefaults =
    defaults.event_tags && typeof defaults.event_tags === "object"
      ? defaults.event_tags
      : {};
  if (source.event_tags && typeof source.event_tags === "object") {
    for (const [key, value] of Object.entries(source.event_tags)) {
      if (typeof key === "string" && typeof value === "string") {
        const trimmedKey = key.trim();
        if (trimmedKey) {
          tagDefaults[trimmedKey] = value.trim();
        }
      }
    }
  }
  defaults.event_tags = tagDefaults;

  return defaults;
}

function canonicalSegmenterFromConfig(config) {
  const section = config && typeof config === "object" ? config.segmenter : null;
  return canonicalSegmenterSettings(section);
}

function pathsDefaults() {
  return {
    tmp_dir: "/apps/tricorder/tmp",
    recordings_dir: "/apps/tricorder/recordings",
    dropbox_dir: "/apps/tricorder/dropbox",
    ingest_work_dir: "/apps/tricorder/tmp/ingest",
    encoder_script: "/apps/tricorder/bin/encode_and_store.sh",
  };
}

function canonicalPathsSettings(settings) {
  const defaults = pathsDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  for (const key of Object.keys(defaults)) {
    const value = source[key];
    if (typeof value === "string") {
      defaults[key] = value.trim();
    }
  }
  return defaults;
}

function canonicalPathsFromConfig(config) {
  const section = config && typeof config === "object" ? config.paths : null;
  return canonicalPathsSettings(section);
}

function notificationsDefaults() {
  return {
    enabled: false,
    allowed_event_types: [],
    min_trigger_rms: null,
    webhook: {
      url: "",
      method: "POST",
      headers: {},
      timeout_sec: 5,
    },
    email: {
      smtp_host: "",
      smtp_port: 587,
      use_tls: true,
      use_ssl: false,
      username: "",
      password: "",
      from: "",
      to: [],
      subject_template: "Tricorder event: {etype} (RMS {trigger_rms})",
      body_template:
        "Event {base_name} completed on {host}.\n" +
        "Type: {etype}\n" +
        "Trigger RMS: {trigger_rms}\n" +
        "Average RMS: {avg_rms}\n" +
        "Duration: {duration_seconds}s\n" +
        "Start: {started_at}\n" +
        "Reason: {end_reason}",
    },
  };
}

function canonicalNotificationsSettings(settings) {
  const defaults = notificationsDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  if (Array.isArray(source.allowed_event_types)) {
    defaults.allowed_event_types = source.allowed_event_types
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item);
  } else if (typeof source.allowed_event_types === "string") {
    defaults.allowed_event_types = parseListInput(source.allowed_event_types);
  }

  if (Object.prototype.hasOwnProperty.call(source, "min_trigger_rms")) {
    const value = source.min_trigger_rms;
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
      defaults.min_trigger_rms = null;
    } else {
      const number = Number(value);
      if (Number.isFinite(number)) {
        defaults.min_trigger_rms = Math.max(0, Math.round(number));
      }
    }
  }

  const webhookSource =
    source.webhook && typeof source.webhook === "object" ? source.webhook : {};
  const webhook = defaults.webhook;
  if (typeof webhookSource.url === "string") {
    webhook.url = webhookSource.url.trim();
  }
  if (typeof webhookSource.method === "string") {
    const normalized = webhookSource.method.trim().toUpperCase();
    if (normalized) {
      webhook.method = normalized;
    }
  }
  if (webhookSource.headers && typeof webhookSource.headers === "object") {
    const entries = Object.entries(webhookSource.headers);
    const headers = {};
    for (const [key, value] of entries) {
      if (typeof key !== "string") {
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          headers[key.trim()] = trimmed;
        }
      } else if (typeof value === "number") {
        headers[key.trim()] = String(value);
      }
    }
    webhook.headers = headers;
  }
  const webhookTimeout = Number(webhookSource.timeout_sec);
  if (Number.isFinite(webhookTimeout)) {
    webhook.timeout_sec = Math.max(0, Math.min(300, webhookTimeout));
  }

  const emailSource = source.email && typeof source.email === "object" ? source.email : {};
  const email = defaults.email;
  for (const field of [
    "smtp_host",
    "username",
    "password",
    "from",
    "subject_template",
    "body_template",
  ]) {
    if (typeof emailSource[field] === "string") {
      email[field] = emailSource[field].trim();
    }
  }
  const smtpPort = Number(emailSource.smtp_port);
  if (Number.isFinite(smtpPort) && smtpPort > 0 && smtpPort <= 65535) {
    email.smtp_port = Math.round(smtpPort);
  }
  email.use_tls = parseBoolean(emailSource.use_tls);
  email.use_ssl = parseBoolean(emailSource.use_ssl);

  if (Array.isArray(emailSource.to)) {
    email.to = emailSource.to
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item);
  } else if (typeof emailSource.to === "string") {
    email.to = parseListInput(emailSource.to);
  }

  return defaults;
}

function canonicalNotificationsFromConfig(config) {
  const section =
    config && typeof config === "object" ? config.notifications : null;
  return canonicalNotificationsSettings(section);
}

function adaptiveDefaults() {
  return {
    enabled: false,
    min_rms: null,
    min_thresh: 0.01,
    max_rms: null,
    max_thresh: 1,
    margin: 1.2,
    update_interval_sec: 5.0,
    window_sec: 10.0,
    hysteresis_tolerance: 0.1,
    release_percentile: 0.5,
    voiced_hold_sec: 6.0,
  };
}

function canonicalAdaptiveSettings(settings) {
  const defaults = adaptiveDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  function parseOptionalRms(value, fallback) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string" && value.trim() === "") {
      return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    const rounded = Math.round(number);
    if (rounded <= 0) {
      return null;
    }
    return Math.min(32767, rounded);
  }

  function clampFloat(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  defaults.min_thresh = clampFloat(source.min_thresh, defaults.min_thresh, 0, 1);
  defaults.max_thresh = clampFloat(source.max_thresh, defaults.max_thresh, 0, 1);
  defaults.max_rms = parseOptionalRms(source.max_rms, defaults.max_rms);
  defaults.min_rms = parseOptionalRms(source.min_rms, defaults.min_rms);
  defaults.margin = clampFloat(source.margin, defaults.margin, 0.5, 10);
  defaults.update_interval_sec = clampFloat(
    source.update_interval_sec,
    defaults.update_interval_sec,
    0.5,
    120
  );
  defaults.window_sec = clampFloat(source.window_sec, defaults.window_sec, 1, 300);
  defaults.hysteresis_tolerance = clampFloat(
    source.hysteresis_tolerance,
    defaults.hysteresis_tolerance,
    0,
    1
  );
  defaults.release_percentile = clampFloat(
    source.release_percentile,
    defaults.release_percentile,
    0.05,
    1
  );
  defaults.voiced_hold_sec = clampFloat(
    source.voiced_hold_sec,
    defaults.voiced_hold_sec,
    0,
    300
  );

  if (defaults.max_thresh < defaults.min_thresh) {
    defaults.max_thresh = defaults.min_thresh;
  }

  return defaults;
}

function canonicalAdaptiveFromConfig(config) {
  const section = config && typeof config === "object" ? config.adaptive_rms : null;
  return canonicalAdaptiveSettings(section);
}

function ingestDefaults() {
  return {
    stable_checks: 2,
    stable_interval_sec: 1.0,
    allowed_ext: [".wav", ".opus", ".flac", ".mp3"],
    ignore_suffixes: [".part", ".partial", ".tmp", ".incomplete", ".opdownload", ".crdownload"],
  };
}

function normalizeExtensionList(values, fallback) {
  const base = Array.isArray(fallback) ? fallback.slice() : [];
  if (!values) {
    return base;
  }
  const items = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    let candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!candidate.startsWith(".")) {
      candidate = `.${candidate}`;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      items.push(candidate);
    }
  }
  return items.length > 0 ? items : base;
}

function normalizeSuffixList(values, fallback) {
  const base = Array.isArray(fallback) ? fallback.slice() : [];
  if (!values) {
    return base;
  }
  const items = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    const candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      items.push(candidate);
    }
  }
  return items.length > 0 ? items : base;
}

function canonicalIngestSettings(settings) {
  const defaults = ingestDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  const stableChecks = Number(source.stable_checks);
  if (Number.isFinite(stableChecks)) {
    defaults.stable_checks = Math.max(1, Math.min(20, Math.round(stableChecks)));
  }

  const stableInterval = Number(source.stable_interval_sec);
  if (Number.isFinite(stableInterval)) {
    defaults.stable_interval_sec = Math.max(0.1, Math.min(30, stableInterval));
  }

  defaults.allowed_ext = normalizeExtensionList(source.allowed_ext, defaults.allowed_ext);
  defaults.ignore_suffixes = normalizeSuffixList(
    source.ignore_suffixes,
    defaults.ignore_suffixes
  );

  return defaults;
}

function canonicalIngestFromConfig(config) {
  const section = config && typeof config === "object" ? config.ingest : null;
  return canonicalIngestSettings(section);
}

function loggingDefaults() {
  return { dev_mode: false };
}

function canonicalLoggingSettings(settings) {
  const defaults = loggingDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  defaults.dev_mode = parseBoolean(source.dev_mode);
  return defaults;
}

function canonicalLoggingFromConfig(config) {
  const section = config && typeof config === "object" ? config.logging : null;
  return canonicalLoggingSettings(section);
}

function streamingDefaults() {
  return { mode: "hls", webrtc_history_seconds: 8.0 };
}

function canonicalStreamingSettings(settings) {
  const defaults = streamingDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  if (typeof source.mode === "string") {
    const candidate = source.mode.trim().toLowerCase();
    if (STREAMING_MODES.has(candidate)) {
      defaults.mode = candidate;
    }
  }

  const history = Number(source.webrtc_history_seconds);
  if (Number.isFinite(history)) {
    defaults.webrtc_history_seconds = Math.max(1, Math.min(600, history));
  }

  return defaults;
}

function canonicalStreamingFromConfig(config) {
  const section = config && typeof config === "object" ? config.streaming : null;
  return canonicalStreamingSettings(section);
}

function dashboardDefaults() {
  return { api_base: "" };
}

function canonicalDashboardSettings(settings) {
  const defaults = dashboardDefaults();
  const source = settings && typeof settings === "object" ? settings : {};
  if (typeof source.api_base === "string") {
    defaults.api_base = source.api_base.trim();
  }
  return defaults;
}

function canonicalDashboardFromConfig(config) {
  const section = config && typeof config === "object" ? config.dashboard : null;
  return canonicalDashboardSettings(section);
}

function transcriptionDefaults() {
  return {
    enabled: false,
    engine: "vosk",
    types: ["Human"],
    vosk_model_path: "/apps/tricorder/models/vosk-small-en-us-0.15",
    target_sample_rate: 16000,
    include_words: true,
    max_alternatives: 0,
  };
}

function canonicalTranscriptionSettings(settings) {
  const defaults = transcriptionDefaults();
  const source = settings && typeof settings === "object" ? settings : {};

  defaults.enabled = parseBoolean(source.enabled);

  if (typeof source.engine === "string") {
    const candidate = source.engine.trim().toLowerCase();
    if (TRANSCRIPTION_ENGINES.has(candidate)) {
      defaults.engine = candidate;
    }
  }

  let rawTypes = [];
  if (Array.isArray(source.types)) {
    rawTypes = source.types;
  } else if (typeof source.types === "string") {
    rawTypes = parseListInput(source.types);
  }
  const normalizedTypes = [];
  for (const entry of rawTypes) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (!normalizedTypes.includes(trimmed)) {
      normalizedTypes.push(trimmed);
    }
  }
  if (normalizedTypes.length > 0) {
    defaults.types = normalizedTypes;
  }

  if (typeof source.vosk_model_path === "string") {
    const trimmed = source.vosk_model_path.trim();
    if (trimmed) {
      defaults.vosk_model_path = trimmed;
    }
  } else if (typeof source.model_path === "string") {
    const trimmed = source.model_path.trim();
    if (trimmed) {
      defaults.vosk_model_path = trimmed;
    }
  }

  const rate = Number(
    source.target_sample_rate !== undefined ? source.target_sample_rate : source.vosk_sample_rate
  );
  if (Number.isFinite(rate)) {
    const clamped = Math.max(8000, Math.min(96000, Math.round(rate)));
    defaults.target_sample_rate = clamped;
  }

  if (source.include_words !== undefined) {
    defaults.include_words = parseBoolean(source.include_words);
  }

  const alternatives = Number(source.max_alternatives);
  if (Number.isFinite(alternatives)) {
    defaults.max_alternatives = Math.max(0, Math.min(10, Math.round(alternatives)));
  }

  return defaults;
}

function canonicalTranscriptionFromConfig(config) {
  const section = config && typeof config === "object" ? config.transcription : null;
  return canonicalTranscriptionSettings(section);
}

export {
  AUDIO_CALIBRATION_DEFAULTS,
  AUDIO_FILTER_DEFAULTS,
  AUDIO_FILTER_ENUMS,
  AUDIO_FILTER_LIMITS,
  AUDIO_FRAME_LENGTHS,
  AUDIO_SAMPLE_RATES,
  STREAMING_MODES,
  TRANSCRIPTION_ENGINES,
  adaptiveDefaults,
  audioDefaults,
  canonicalAdaptiveFromConfig,
  canonicalAdaptiveSettings,
  canonicalAudioFromConfig,
  canonicalAudioSettings,
  canonicalDashboardFromConfig,
  canonicalDashboardSettings,
  canonicalIngestFromConfig,
  canonicalIngestSettings,
  canonicalLoggingFromConfig,
  canonicalLoggingSettings,
  canonicalNotificationsFromConfig,
  canonicalNotificationsSettings,
  canonicalPathsFromConfig,
  canonicalPathsSettings,
  canonicalSegmenterFromConfig,
  canonicalSegmenterSettings,
  canonicalStreamingFromConfig,
  canonicalStreamingSettings,
  canonicalTranscriptionFromConfig,
  canonicalTranscriptionSettings,
  dashboardDefaults,
  extractErrorMessage,
  ingestDefaults,
  isMotionTriggeredEvent,
  loggingDefaults,
  notificationsDefaults,
  normalizeExtensionList,
  normalizeSuffixList,
  parseBoolean,
  parseListInput,
  parseMotionFlag,
  pathsDefaults,
  resolveNextMotionState,
  segmenterDefaults,
  streamingDefaults,
  transcriptionDefaults,
};
