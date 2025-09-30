#!/usr/bin/env python3
import json
import math
import os
import re
import sys
import time
import collections
import subprocess
import wave
from dataclasses import dataclass
from datetime import datetime
import threading
import queue
import warnings
from collections.abc import Callable
from typing import Optional
import array
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    message="pkg_resources is deprecated as an API.*"
)
import webrtcvad    # noqa
from lib.config import get_cfg, resolve_event_tags
from lib.notifications import build_dispatcher

cfg = get_cfg()
EVENT_TAGS = resolve_event_tags(cfg)
NOTIFIER = build_dispatcher(cfg.get("notifications"))

# ANSI colors for booleans (can be disabled via NO_COLOR env)
ANSI_GREEN = "\033[32m"
ANSI_RED = "\033[31m"
ANSI_RESET = "\033[0m"
USE_COLOR = os.getenv("NO_COLOR") is None

# Debug output formatting defaults (prevents NameError when DEV mode is enabled)
BAR_SCALE = int(cfg["segmenter"].get("rms_bar_scale", 4000))  # scale for RMS bar visualization
BAR_WIDTH = int(cfg["segmenter"].get("rms_bar_width", 30))    # character width of the bar
RIGHT_TEXT_WIDTH = int(cfg["segmenter"].get("right_text_width", 54))  # fixed-width right block

def color_tf(val: bool) -> str:
    # Single-character stable width 'T'/'F' with color
    if not USE_COLOR:
        return "T" if val else "F"
    return f"{ANSI_GREEN}T{ANSI_RESET}" if val else f"{ANSI_RED}F{ANSI_RESET}"

SAMPLE_RATE = int(cfg["audio"]["sample_rate"])
SAMPLE_WIDTH = 2   # 16-bit
FRAME_MS = int(cfg["audio"]["frame_ms"])
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

INT16_MAX = 2 ** 15 - 1
INT16_MIN = -2 ** 15

SAFE_EVENT_TAG_PATTERN = re.compile(r"[^A-Za-z0-9_-]+")


def _sanitize_event_tag(tag: str) -> str:
    sanitized = SAFE_EVENT_TAG_PATTERN.sub("_", tag.strip()) if tag else ""
    sanitized = sanitized.strip("_-")
    return sanitized or "event"


@dataclass(frozen=True)
class RecorderIngestHint:
    timestamp: str
    event_counter: int | None = None


@dataclass(frozen=True)
class AdaptiveRmsObservation:
    """Snapshot emitted whenever the adaptive RMS controller evaluates."""

    timestamp: float
    updated: bool
    threshold_linear: int
    previous_threshold_linear: int
    candidate_threshold_linear: int
    p95_norm: float
    release_norm: float
    buffer_size: int
    rms_value: int
    voiced: bool


def pcm16_rms(buf: bytes) -> int:
    """Compute RMS amplitude for signed 16-bit little-endian PCM data."""
    if not buf:
        return 0
    if len(buf) % SAMPLE_WIDTH:
        raise ValueError("PCM16 buffer length must be a multiple of 2 bytes")

    samples = array.array('h')
    samples.frombytes(buf)
    if sys.byteorder != 'little':
        samples.byteswap()

    total = 0
    for sample in samples:
        total += sample * sample
    if not samples:
        return 0
    mean_square = total / len(samples)
    return int(math.sqrt(mean_square))


def pcm16_apply_gain(buf: bytes, gain: float) -> bytes:
    """Scale signed 16-bit PCM samples by gain with int16 clipping."""
    if not buf or gain == 1.0:
        return buf
    if len(buf) % SAMPLE_WIDTH:
        raise ValueError("PCM16 buffer length must be a multiple of 2 bytes")

    samples = array.array('h')
    samples.frombytes(buf)
    if sys.byteorder != 'little':
        samples.byteswap()

    for idx, sample in enumerate(samples):
        product = sample * gain
        scaled = math.floor(product)
        if scaled > INT16_MAX:
            scaled = INT16_MAX
        elif scaled < INT16_MIN:
            scaled = INT16_MIN
        samples[idx] = scaled

    if sys.byteorder != 'little':
        samples.byteswap()
    return samples.tobytes()

TMP_DIR = cfg["paths"]["tmp_dir"]
REC_DIR = cfg["paths"]["recordings_dir"]
ENCODER = cfg["paths"]["encoder_script"]

# PRE_PAD / POST_PAD
PRE_PAD = int(cfg["segmenter"]["pre_pad_ms"])
POST_PAD = int(cfg["segmenter"]["post_pad_ms"])
PRE_PAD_FRAMES = PRE_PAD // FRAME_MS
POST_PAD_FRAMES = POST_PAD // FRAME_MS

# thresholds
STATIC_RMS_THRESH = int(cfg["segmenter"]["rms_threshold"])
vad = webrtcvad.Vad(int(cfg["audio"]["vad_aggressiveness"]))

# DE-BOUNCE tunables
START_CONSECUTIVE = int(cfg["segmenter"]["start_consecutive"])
KEEP_CONSECUTIVE = int(cfg["segmenter"]["keep_consecutive"])

# window sizes
KEEP_WINDOW = int(cfg["segmenter"]["keep_window_frames"])

# Mic Digital Gain
GAIN = float(cfg["audio"]["gain"])

# Noise reduction settings
USE_RNNOISE = bool(cfg["segmenter"]["use_rnnoise"])
USE_NOISEREDUCE = bool(cfg["segmenter"]["use_noisereduce"])
DENOISE_BEFORE_VAD = bool(cfg["segmenter"]["denoise_before_vad"])

# Filter chain instrumentation tunables
FILTER_CHAIN_METRICS_WINDOW = int(
    cfg["segmenter"].get("filter_chain_metrics_window", 50)
)
FILTER_CHAIN_AVG_BUDGET_MS = float(
    cfg["segmenter"].get("filter_chain_avg_budget_ms", max(1.0, FRAME_MS * 0.3))
)
FILTER_CHAIN_PEAK_BUDGET_MS = float(
    cfg["segmenter"].get("filter_chain_peak_budget_ms", max(1.0, FRAME_MS * 0.8))
)
FILTER_CHAIN_LOG_THROTTLE_SEC = float(
    cfg["segmenter"].get("filter_chain_log_throttle_sec", 30.0)
)

# buffered writes
FLUSH_THRESHOLD = int(cfg["segmenter"]["flush_threshold_bytes"])
MAX_QUEUE_FRAMES = int(cfg["segmenter"]["max_queue_frames"])

# Debug logging gate (DEV=1 or logging.dev_mode)
DEBUG_VERBOSE = (cfg["logging"]["dev_mode"])

try:
    if USE_RNNOISE:
        import rnnoise
    if USE_NOISEREDUCE:
        import noisereduce as nr
        import numpy as np
except ImportError:
    print("[segmenter] Noise reduction library missing, continuing without NR")
    USE_RNNOISE = False
    USE_NOISEREDUCE = False
    rnnoise = None  # ensure a symbol exists for type/checkers
    nr = None       # ensure a symbol exists for type/checkers
    np = None       # ensure a symbol exists for type/checkers


def is_voice(buf):
    return vad.is_speech(buf, SAMPLE_RATE)


def rms(buf):
    return pcm16_rms(buf)


# ---------- Async writer worker ----------
class _WriterWorker(threading.Thread):
    """
    Dedicated disk-writer thread.
    Protocol on self.q (audio_q):
      ('open', base_name, tmp_wav_path)
      b'<frame-bytes>' (raw mono 16-bit PCM @ 48k)
      ('close', base_name)
    When a file is closed, we push (tmp_wav_path, base_name) to done_q.
    """
    def __init__(self, audio_q: queue.Queue, done_q: queue.Queue, flush_threshold: int):
        super().__init__(daemon=True)
        self.q = audio_q
        self.done_q = done_q
        self.flush_threshold = flush_threshold
        self.wav = None
        self.base = None
        self.path = None
        self.buf = bytearray()
        self._running = True

    def _flush(self):
        if self.wav and self.buf:
            self.wav.writeframes(self.buf)
            self.buf.clear()

    def _close_file(self):
        if self.wav:
            try:
                self._flush()
                self.wav.close()
            except Exception as e:
                print(f"[writer] close error: {e!r}", flush=True)
            finally:
                try:
                    self.done_q.put_nowait((self.path, self.base))
                except Exception:
                    pass
                self.wav = None
                self.base = None
                self.path = None
                self.buf.clear()

    def run(self):
        while self._running:
            try:
                item = self.q.get(timeout=0.5)
            except queue.Empty:
                continue

            try:
                if item is None:
                    self._close_file()
                    self._running = False
                    break

                if isinstance(item, tuple):
                    tag = item[0]
                    if tag == 'open':
                        _, base, path = item
                        self._close_file()
                        self.base = base
                        self.path = path
                        os.makedirs(os.path.dirname(path), exist_ok=True)
                        self.wav = wave.open(path, "wb")
                        self.wav.setnchannels(1)
                        self.wav.setsampwidth(SAMPLE_WIDTH)
                        self.wav.setframerate(SAMPLE_RATE)
                        self.buf.clear()
                    elif tag == 'close':
                        _, base = item
                        if self.wav and base == self.base:
                            self._close_file()

                elif isinstance(item, (bytes, bytearray, memoryview)):
                    if not self.wav:
                        continue
                    self.buf.extend(item)
                    if len(self.buf) >= self.flush_threshold:
                        self._flush()
            finally:
                self.q.task_done()


# ---------- Async encoder worker ----------
ENCODE_QUEUE: queue.Queue = queue.Queue()
_ENCODE_WORKER = None
_ENCODE_LOCK = threading.Lock()
SHUTDOWN_ENCODE_START_TIMEOUT = 5.0


class EncodingStatus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._pending: collections.deque[dict[str, object]] = collections.deque()
        self._active: dict[str, object] | None = None
        self._next_id = 1
        self._listeners: list[Callable[[dict[str, object] | None], None]] = []

    def register_listener(self, callback: Callable[[dict[str, object] | None], None]) -> None:
        with self._lock:
            self._listeners.append(callback)
        try:
            callback(self.snapshot())
        except Exception:
            pass

    def snapshot(self) -> dict[str, object] | None:
        with self._lock:
            active = dict(self._active) if self._active else None
            pending = [dict(entry) for entry in self._pending]
        pending_payload = [
            {
                "id": entry.get("id"),
                "base_name": entry.get("base_name", ""),
                "queued_at": entry.get("queued_at"),
                "source": entry.get("source"),
                "status": "pending",
            }
            for entry in pending
        ]
        active_payload = None
        if active:
            active_payload = {
                "id": active.get("id"),
                "base_name": active.get("base_name", ""),
                "queued_at": active.get("queued_at"),
                "started_at": active.get("started_at"),
                "source": active.get("source"),
                "status": "active",
            }
        if not pending_payload and not active_payload:
            return None
        return {"pending": pending_payload, "active": active_payload}

    def _notify(self) -> None:
        snapshot = self.snapshot()
        with self._lock:
            listeners = list(self._listeners)
        for callback in listeners:
            try:
                callback(snapshot)
            except Exception:
                pass

    def enqueue(self, base_name: str, *, source: str = "live") -> int:
        with self._cond:
            job_id = self._next_id
            self._next_id += 1
            self._pending.append(
                {
                    "id": job_id,
                    "base_name": base_name,
                    "queued_at": time.time(),
                    "source": source,
                }
            )
            self._cond.notify_all()
        self._notify()
        return job_id

    def mark_started(self, job_id: int, base_name: str) -> None:
        with self._cond:
            job = None
            for entry in list(self._pending):
                if entry.get("id") == job_id:
                    job = entry
                    self._pending.remove(entry)
                    break
            if job is None:
                job = {
                    "id": job_id,
                    "base_name": base_name,
                    "queued_at": time.time(),
                    "source": "unknown",
                }
            else:
                job["base_name"] = base_name
                if "source" not in job or not isinstance(job.get("source"), str):
                    job["source"] = "unknown"
            job["started_at"] = time.time()
            self._active = job
            self._cond.notify_all()
        self._notify()

    def mark_finished(self, job_id: int) -> None:
        with self._cond:
            if self._active and self._active.get("id") == job_id:
                self._active = None
            self._cond.notify_all()
        self._notify()

    def wait_for_start(self, job_id: int, timeout: float | None = None) -> bool:
        deadline: float | None = None
        if timeout is not None:
            deadline = time.monotonic() + timeout

        with self._cond:
            while True:
                if self._active and self._active.get("id") == job_id:
                    return True

                if not any(entry.get("id") == job_id for entry in self._pending):
                    return True

                if timeout is None:
                    self._cond.wait()
                    continue

                assert deadline is not None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)

    def wait_for_finish(self, job_id: int, timeout: float | None = None) -> bool:
        deadline: float | None = None
        if timeout is not None:
            deadline = time.monotonic() + timeout

        with self._cond:
            while True:
                active_match = self._active and self._active.get("id") == job_id
                pending_match = any(entry.get("id") == job_id for entry in self._pending)
                if not active_match and not pending_match:
                    return True

                if timeout is None:
                    self._cond.wait()
                    continue

                assert deadline is not None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)


ENCODING_STATUS = EncodingStatus()


class _EncoderWorker(threading.Thread):
    def __init__(self, job_queue: queue.Queue):
        super().__init__(daemon=True)
        self.q = job_queue

    def run(self):
        while True:
            item = self.q.get()
            try:
                if item is None:
                    return

                job_id: int | None
                wav_path: str
                base_name: str
                if isinstance(item, tuple) and len(item) == 3:
                    job_id, wav_path, base_name = item
                else:
                    job_id = None
                    wav_path, base_name = item
                if job_id is not None:
                    ENCODING_STATUS.mark_started(job_id, base_name)
                cmd = [ENCODER, wav_path, base_name]
                try:
                    subprocess.run(cmd, capture_output=True, text=True, check=True)
                except subprocess.CalledProcessError as exc:
                    print(f"[encoder] FAIL {exc.returncode}", flush=True)
                    if exc.stdout:
                        print(exc.stdout, flush=True)
                    if exc.stderr:
                        print(exc.stderr, flush=True)
                except Exception as exc:  # noqa: BLE001 - log and continue
                    print(f"[encoder] unexpected error: {exc!r}", flush=True)
                finally:
                    if job_id is not None:
                        ENCODING_STATUS.mark_finished(job_id)
            finally:
                self.q.task_done()


def _ensure_encoder_worker() -> None:
    global _ENCODE_WORKER
    with _ENCODE_LOCK:
        if _ENCODE_WORKER is None or not _ENCODE_WORKER.is_alive():
            _ENCODE_WORKER = _EncoderWorker(ENCODE_QUEUE)
            _ENCODE_WORKER.start()


def _enqueue_encode_job(
    tmp_wav_path: str,
    base_name: str,
    *,
    source: str = "live",
) -> int | None:
    if not tmp_wav_path or not base_name:
        return None
    _ensure_encoder_worker()
    job_id = ENCODING_STATUS.enqueue(base_name, source=source)
    try:
        ENCODE_QUEUE.put_nowait((job_id, tmp_wav_path, base_name))
    except queue.Full:
        ENCODE_QUEUE.put((job_id, tmp_wav_path, base_name))
    print(f"[segmenter] queued encode job for {base_name}", flush=True)
    return job_id


class AdaptiveRmsController:
    _NORM = 32768.0

    def __init__(
        self,
        *,
        frame_ms: int,
        initial_linear_threshold: int,
        cfg_section: dict[str, object] | None,
        debug: bool = True, # noqa: for future implementation
    ) -> None:
        section = cfg_section or {}
        self.enabled = bool(section.get("enabled", False))
        self.min_thresh_norm = min(1.0, max(0.0, float(section.get("min_thresh", 0.01))))
        self.margin = max(0.0, float(section.get("margin", 1.2)))
        self.update_interval = max(0.1, float(section.get("update_interval_sec", 5.0)))
        self.hysteresis_tolerance = max(0.0, float(section.get("hysteresis_tolerance", 0.1)))
        self.release_percentile = min(1.0, max(0.01, float(section.get("release_percentile", 0.5))))
        window_sec = max(0.1, float(section.get("window_sec", 10.0)))
        window_frames = max(1, int(round((window_sec * 1000.0) / frame_ms)))
        self._buffer: collections.deque[float] = collections.deque(maxlen=window_frames)
        self._last_update = time.monotonic()
        self._last_p95: float | None = None
        self._last_candidate: float | None = None
        self._last_release: float | None = None
        self._last_observation: AdaptiveRmsObservation | None = None
        initial_norm = max(0.0, min(initial_linear_threshold / self._NORM, 1.0))
        if self.enabled:
            initial_norm = max(self.min_thresh_norm, initial_norm)
        self._current_norm = initial_norm
        self.debug = bool(debug)

    @property
    def threshold_linear(self) -> int:
        if not self.enabled:
            return int(self._current_norm * self._NORM)
        return int(round(self._current_norm * self._NORM))

    @property
    def threshold_norm(self) -> float:
        return self._current_norm

    @property
    def last_p95(self) -> float | None:
        return self._last_p95

    @property
    def last_candidate(self) -> float | None:
        return self._last_candidate

    @property
    def last_release(self) -> float | None:
        return self._last_release

    def pop_observation(self) -> AdaptiveRmsObservation | None:
        observation, self._last_observation = self._last_observation, None
        return observation

    def observe(self, rms_value: int, voiced: bool) -> bool:
        if not self.enabled:
            self._last_observation = None
            return False

        norm = max(0.0, min(rms_value / self._NORM, 1.0))
        if not voiced:
            self._buffer.append(norm)

        now = time.monotonic()
        if (now - self._last_update) < self.update_interval:
            self._last_observation = None
            return False

        if not self._buffer:
            self._last_observation = None
            return False

        self._last_update = now
        ordered = sorted(self._buffer)
        idx = max(0, int(math.ceil(0.95 * len(ordered)) - 1))
        p95 = ordered[idx]
        candidate_raise = min(1.0, max(self.min_thresh_norm, p95 * self.margin))
        rel_idx = max(0, int(math.ceil(self.release_percentile * len(ordered)) - 1))
        release_val = ordered[rel_idx]
        candidate_release = min(1.0, max(self.min_thresh_norm, release_val * self.margin))
        if (
            # Require both gates to move upward before raising the threshold.
            # This avoids ping-ponging when the long-tail release sample still
            # recommends holding steady.
            candidate_raise > self._current_norm
            and candidate_release > self._current_norm
        ):
            candidate = candidate_raise
        elif candidate_release < self._current_norm:
            candidate = candidate_release
        else:
            candidate = self._current_norm
        self._last_p95 = p95
        self._last_candidate = candidate
        self._last_release = release_val

        previous_norm = self._current_norm
        if self._current_norm <= 0.0:
            should_update = True
        else:
            delta = abs(candidate - self._current_norm)
            should_update = (delta / self._current_norm) >= self.hysteresis_tolerance

        if should_update:
            self._current_norm = candidate
        final_threshold = int(round(self._current_norm * self._NORM))
        previous_threshold = int(round(previous_norm * self._NORM))
        candidate_threshold = int(round(candidate * self._NORM))
        self._last_observation = AdaptiveRmsObservation(
            timestamp=time.time(),
            updated=bool(should_update),
            threshold_linear=final_threshold,
            previous_threshold_linear=previous_threshold,
            candidate_threshold_linear=candidate_threshold,
            p95_norm=p95,
            release_norm=release_val,
            buffer_size=len(self._buffer),
            rms_value=int(rms_value),
            voiced=bool(voiced),
        )
        return should_update


class TimelineRecorder:
    event_counters = collections.defaultdict(int)

    def __init__(
        self,
        ingest_hint: Optional[RecorderIngestHint] = None,
        *,
        status_mode: str = "live",
        recording_source: str = "live",
    ):
        self.prebuf = collections.deque(maxlen=PRE_PAD_FRAMES)
        self.active = False
        self.post_count = 0

        self.recent_active = collections.deque(maxlen=KEEP_WINDOW)
        self.consec_active = 0
        self.consec_inactive = 0

        self.last_log = time.monotonic()

        # Rolling debug stats (approx. last 1s worth of frames)
        self._dbg_win = max(1, 1000 // FRAME_MS)
        self._dbg_rms = collections.deque(maxlen=self._dbg_win)
        self._dbg_voiced = collections.deque(maxlen=self._dbg_win)

        self.audio_q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE_FRAMES)
        self.done_q: queue.Queue = queue.Queue(maxsize=2)
        self.writer = _WriterWorker(self.audio_q, self.done_q, FLUSH_THRESHOLD)
        self.writer.start()

        self._adaptive = AdaptiveRmsController(
            frame_ms=FRAME_MS,
            initial_linear_threshold=STATIC_RMS_THRESH,
            cfg_section=cfg.get("adaptive_rms"),
            debug=DEBUG_VERBOSE,
        )

        self.base_name: str | None = None
        self.tmp_wav_path: str | None = None
        self.event_timestamp: str | None = None
        self.event_counter: int | None = None
        self.trigger_rms: int | None = None
        self.queue_drops = 0

        self.frames_written = 0
        self.sum_rms = 0
        self.saw_voiced = False
        self.saw_loud = False

        self._ingest_hint: Optional[RecorderIngestHint] = ingest_hint
        self._ingest_hint_used = False
        self._encode_jobs: list[int] = []

        self.status_path = os.path.join(TMP_DIR, "segmenter_status.json")
        self._status_cache: dict[str, object] | None = None
        self._status_lock = threading.Lock()
        self._encoding_status: dict[str, object] | None = None
        normalized_mode = status_mode.strip().lower() if isinstance(status_mode, str) else "live"
        if normalized_mode not in {"live", "ingest"}:
            raise ValueError("status_mode must be 'live' or 'ingest'")
        self._status_mode = normalized_mode
        normalized_source = (
            recording_source.strip().lower()
            if isinstance(recording_source, str)
            else "live"
        )
        self._recording_source = normalized_source or "live"
        if self._status_mode == "ingest":
            self._load_status_cache_from_disk()
        ENCODING_STATUS.register_listener(self._handle_encoding_status_change)
        self.event_started_epoch: float | None = None
        self._metrics_interval = 0.5
        self._last_metrics_update = 0.0
        self._last_metrics_value: int | None = None
        self._last_metrics_threshold: int | None = None
        self._filter_chain_samples: collections.deque[float] = collections.deque(
            maxlen=max(1, FILTER_CHAIN_METRICS_WINDOW)
        )
        self._filter_avg_ms: float = 0.0
        self._filter_peak_ms: float = 0.0
        self._filter_last_log_ts: float = 0.0
        if self._status_mode == "live":
            self._update_capture_status(
                False,
                reason="idle",
                extra={
                    "service_running": True,
                    "current_rms": 0,
                    "event_duration_seconds": None,
                    "event_size_bytes": None,
                },
            )

    def _load_status_cache_from_disk(self) -> None:
        if not self.status_path:
            return
        try:
            with open(self.status_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return
        if isinstance(data, dict):
            self._status_cache = data

    def _update_capture_status(
        self,
        capturing: bool,
        *,
        event: dict | None = None,
        last_event: dict | None = None,
        reason: str | None = None,
        extra: dict[str, object] | None = None,
    ) -> None:
        with self._status_lock:
            if self._status_mode == "ingest" and self._status_cache is None:
                self._load_status_cache_from_disk()
            payload: dict[str, object] = {}
            if isinstance(self._status_cache, dict):
                payload.update(self._status_cache)

            effective_capturing = bool(capturing)
            if self._status_mode == "ingest":
                effective_capturing = bool(payload.get("capturing", False))

            payload["capturing"] = effective_capturing
            payload["updated_at"] = time.time()
            if self._status_mode == "live":
                payload["adaptive_rms_threshold"] = int(self._adaptive.threshold_linear)
            elif "adaptive_rms_threshold" not in payload:
                payload["adaptive_rms_threshold"] = int(self._adaptive.threshold_linear)
            payload["adaptive_rms_enabled"] = bool(self._adaptive.enabled)

            if self._status_mode == "live":
                if effective_capturing and event:
                    payload["event"] = event
                    payload.pop("last_event", None)
                if not effective_capturing and last_event:
                    payload["last_event"] = last_event
                if not effective_capturing and "event" in payload:
                    payload.pop("event", None)
                if reason:
                    payload["last_stop_reason"] = reason
            if self._encoding_status:
                payload["encoding"] = self._encoding_status
            else:
                payload.pop("encoding", None)

            compare_keys = (
                "capturing",
                "event",
                "last_event",
                "last_stop_reason",
                "adaptive_rms_threshold",
                "current_rms",
                "adaptive_rms_enabled",
                "service_running",
                "event_duration_seconds",
                "event_size_bytes",
                "encoding",
            )
            if extra and self._status_mode == "live":
                for key, value in extra.items():
                    if value is None:
                        payload.pop(key, None)
                    else:
                        payload[key] = value
            if self._status_cache is not None:
                previous = {key: self._status_cache.get(key) for key in compare_keys}
                current = {key: payload.get(key) for key in compare_keys}
                if previous == current:
                    self._status_cache = payload
                    return

            self._status_cache = payload
            tmp_path = f"{self.status_path}.tmp"
            try:
                os.makedirs(os.path.dirname(self.status_path), exist_ok=True)
                with open(tmp_path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle)
                    handle.write("\n")
                os.replace(tmp_path, self.status_path)
            except Exception as exc:  # pragma: no cover - diagnostics only in DEV builds
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
                if DEBUG_VERBOSE:
                    print(f"[segmenter] WARN: failed to write capture status: {exc!r}", flush=True)

    def _handle_encoding_status_change(self, snapshot: dict[str, object] | None) -> None:
        with self._status_lock:
            self._encoding_status = snapshot if snapshot else None
            cache_ready = self._status_cache is not None
        if cache_ready:
            self._refresh_capture_status()

    def _refresh_capture_status(self) -> None:
        capturing, event, last_event, reason = self._status_snapshot()
        self._update_capture_status(
            capturing,
            event=event,
            last_event=last_event,
            reason=reason,
        )

    def _status_snapshot(self) -> tuple[bool, dict | None, dict | None, str | None]:
        with self._status_lock:
            capturing = self.active
            event: dict | None = None
            last_event: dict | None = None
            reason: str | None = None
            if isinstance(self._status_cache, dict):
                capturing = bool(self._status_cache.get("capturing", capturing))
                cached_event = self._status_cache.get("event")
                if isinstance(cached_event, dict):
                    event = cached_event
                cached_last = self._status_cache.get("last_event")
                if isinstance(cached_last, dict):
                    last_event = cached_last
                cached_reason = self._status_cache.get("last_stop_reason")
                if isinstance(cached_reason, str) and cached_reason:
                    reason = cached_reason
        if capturing:
            last_event = None
        else:
            event = None
        return capturing, event, last_event, reason

    def _current_event_size(self) -> int | None:
        path = self.tmp_wav_path
        if not path:
            return None
        try:
            return os.path.getsize(path)
        except OSError:
            return None

    def _maybe_update_live_metrics(self, rms_value: int) -> None:
        if self._status_mode != "live":
            return
        now = time.monotonic()
        whole = int(rms_value)
        threshold = int(self._adaptive.threshold_linear)
        if (
            now - self._last_metrics_update < self._metrics_interval
            and self._last_metrics_value == whole
            and self._last_metrics_threshold == threshold
        ):
            return

        self._last_metrics_update = now
        self._last_metrics_value = whole
        self._last_metrics_threshold = threshold

        capturing, event, last_event, reason = self._status_snapshot()
        self._update_capture_status(
            capturing,
            event=event,
            last_event=last_event,
            reason=reason,
            extra={
                "current_rms": whole,
                "service_running": True,
                "event_duration_seconds": (
                    self.frames_written * (FRAME_MS / 1000.0)
                    if capturing
                    else None
                ),
                "event_size_bytes": self._current_event_size() if capturing else None,
                "filter_chain_avg_ms": round(self._filter_avg_ms, 3),
                "filter_chain_peak_ms": round(self._filter_peak_ms, 3),
                "filter_chain_avg_budget_ms": FILTER_CHAIN_AVG_BUDGET_MS,
                "filter_chain_peak_budget_ms": FILTER_CHAIN_PEAK_BUDGET_MS,
            },
        )

    def _emit_threshold_update(self) -> None:
        if self._status_mode != "live":
            return
        cached = self._status_cache or {}
        capturing = bool(cached.get("capturing", self.active))
        event = cached.get("event") if capturing else None
        last_event = None if capturing else cached.get("last_event")
        reason = cached.get("last_stop_reason")
        self._update_capture_status(capturing, event=event, last_event=last_event, reason=reason)

    def _log_adaptive_rms_observation(self, observation: AdaptiveRmsObservation) -> None:

        if not observation.updated:
            return

        if observation.threshold_linear == observation.previous_threshold_linear:
            return

        margin = self._adaptive.margin
        release_pct = self._adaptive.release_percentile
        print(
            "[segmenter] adaptive RMS threshold updated: "
            f"prev={observation.previous_threshold_linear} "
            f"new={observation.threshold_linear} "
            f"(p95={observation.p95_norm:.4f}, margin={margin:.2f}, "
            f"release_pctl={release_pct:.2f}, release={observation.release_norm:.4f})",
            flush=True,
        )

    @staticmethod
    def _apply_gain(buf: bytes) -> bytes:
        return pcm16_apply_gain(buf, GAIN)

    @staticmethod
    def _denoise(samples: bytes) -> bytes:
        if USE_RNNOISE:
            denoiser = rnnoise.RNNoise() # noqa: for future expansion
            frame_size = FRAME_BYTES
            out = bytearray()
            for i in range(0, len(samples), frame_size):
                chunk = samples[i:i+frame_size]
                if len(chunk) == frame_size:
                    out.extend(denoiser.filter(chunk))
            return bytes(out)
        elif USE_NOISEREDUCE:
            arr = np.frombuffer(samples, dtype=np.int16)
            arr_denoised = nr.reduce_noise(y=arr, sr=SAMPLE_RATE)  # noqa: for future expansion
            return arr_denoised.astype(np.int16).tobytes()
        return samples

    def _record_filter_metrics(self, duration_ms: float) -> None:
        if duration_ms < 0:
            return
        samples = self._filter_chain_samples
        samples.append(duration_ms)
        if samples:
            self._filter_avg_ms = sum(samples) / len(samples)
            self._filter_peak_ms = max(samples)
        else:
            self._filter_avg_ms = 0.0
            self._filter_peak_ms = 0.0

        now = time.monotonic()
        over_avg_budget = self._filter_avg_ms > FILTER_CHAIN_AVG_BUDGET_MS
        over_peak_budget = self._filter_peak_ms > FILTER_CHAIN_PEAK_BUDGET_MS
        if (over_avg_budget or over_peak_budget) and (
            now - self._filter_last_log_ts >= FILTER_CHAIN_LOG_THROTTLE_SEC
        ):
            payload = {
                "component": "segmenter",
                "event": "filter_chain_budget_exceeded",
                "avg_ms": round(self._filter_avg_ms, 3),
                "peak_ms": round(self._filter_peak_ms, 3),
                "avg_budget_ms": FILTER_CHAIN_AVG_BUDGET_MS,
                "peak_budget_ms": FILTER_CHAIN_PEAK_BUDGET_MS,
                "window_size": len(samples),
            }
            print(json.dumps(payload), flush=True)
            self._filter_last_log_ts = now

    def _q_send(self, item):
        try:
            self.audio_q.put_nowait(item)
        except queue.Full:
            self.queue_drops += 1

    def ingest(self, buf: bytes, idx: int):
        start = time.perf_counter()
        buf = self._apply_gain(buf)
        if DENOISE_BEFORE_VAD:
            proc_for_analysis = self._denoise(buf)
        else:
            proc_for_analysis = buf
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        self._record_filter_metrics(elapsed_ms)

        rms_val = rms(proc_for_analysis)
        voiced = is_voice(proc_for_analysis)
        current_threshold = self._adaptive.threshold_linear
        loud = rms_val > current_threshold
        frame_active = loud  # primary trigger

        # collect rolling window for debug stats
        self._dbg_rms.append(rms_val)
        self._dbg_voiced.append(bool(voiced))

        self._adaptive.observe(rms_val, bool(voiced))
        observation = self._adaptive.pop_observation()
        if observation:
            self._log_adaptive_rms_observation(observation)
            self._emit_threshold_update()

        self._maybe_update_live_metrics(rms_val)

        # once per-second debug (only if DEV enabled)
        now = time.monotonic()
        if DEBUG_VERBOSE and (now - self.last_log >= 1.0):
            # Inline, narrow VU bar; numeric fields fixed width to prevent jitter
            def _bar(val: int, scale: int = BAR_SCALE, width: int = BAR_WIDTH) -> str:
                lvl = min(width, int((val / float(scale)) * width)) if scale > 0 else 0
                return "#" * lvl + "-" * (width - lvl)

            win_len = max(1, len(self._dbg_rms))
            win_avg = int(sum(self._dbg_rms) / win_len) if win_len else 0
            win_peak = max(self._dbg_rms) if win_len else 0
            voiced_ratio = (sum(1 for v in self._dbg_voiced if v) / win_len) if win_len else 0.0

            # Left block: keep widths stable
            left_block = (
                f"[segmenter] frame={idx:6d} rms={rms_val:4d} "
                f"voiced={color_tf(voiced)} loud={color_tf(loud)} "
                f"active={color_tf(frame_active)} capturing={color_tf(self.active)}  |  "
            )

            # Right text block with fixed width, including a percent that can reach 100.0
            # Use 6.1f so '100.0%' fits without pushing columns
            right_text = (
                f"RMS cur={rms_val:4d} avg={win_avg:4d} peak={win_peak:4d} thr={current_threshold:4d}  "
                f"VAD voiced={voiced_ratio * 100:6.1f}%  |  "
            )
            right_block = right_text.ljust(RIGHT_TEXT_WIDTH)

            print(f"{left_block}{right_block}{_bar(rms_val)}", flush=True)
            self.last_log = now

        if frame_active:
            self.consec_active += 1
            self.consec_inactive = 0
        else:
            self.consec_inactive += 1
            self.consec_active = 0
        self.recent_active.append(frame_active)

        self.prebuf.append(buf)

        if not self.active:
            if self.consec_active >= START_CONSECUTIVE:
                hint_timestamp: str | None = None
                hint_counter: int | None = None
                if self._ingest_hint and not self._ingest_hint_used:
                    hint_timestamp = self._ingest_hint.timestamp
                    hint_counter = self._ingest_hint.event_counter
                    self._ingest_hint_used = True

                if hint_timestamp:
                    start_time = hint_timestamp
                else:
                    start_time = datetime.now().strftime("%H-%M-%S")

                if hint_counter is not None and hint_timestamp:
                    existing = TimelineRecorder.event_counters[start_time]
                    if hint_counter > existing:
                        count = hint_counter
                    else:
                        count = existing + 1
                    TimelineRecorder.event_counters[start_time] = count
                else:
                    TimelineRecorder.event_counters[start_time] += 1
                    count = TimelineRecorder.event_counters[start_time]

                self.event_timestamp = start_time
                self.event_counter = count
                self.trigger_rms = int(rms_val)
                self.base_name = f"{start_time}_Both_{count}"
                self.tmp_wav_path = os.path.join(TMP_DIR, f"{self.base_name}.wav")

                self._q_send(('open', self.base_name, self.tmp_wav_path))

                if self.prebuf:
                    for f in self.prebuf:
                        self._q_send(bytes(f))
                        self.frames_written += 1
                        self.sum_rms += rms(f)
                self.prebuf.clear()

                self.active = True
                self.event_started_epoch = time.time()
                self.post_count = POST_PAD_FRAMES
                self.saw_voiced = voiced
                self.saw_loud = loud
                print(
                    f"[segmenter] Event started at frame ~{max(0, idx - PRE_PAD_FRAMES)} "
                    f"(trigger={'RMS' if loud else 'VAD'}>{current_threshold} (rms={rms_val}))",
                    flush=True
                )
                event_status = {
                    "base_name": self.base_name,
                    "started_at": self.event_timestamp,
                    "started_epoch": self.event_started_epoch,
                    "trigger_rms": self.trigger_rms,
                }
                if self._status_mode == "live":
                    self._update_capture_status(True, event=event_status)
            return

        self._q_send(bytes(buf))
        self.frames_written += 1
        self.sum_rms += rms(proc_for_analysis)
        self.saw_voiced = voiced or self.saw_voiced
        self.saw_loud = loud or self.saw_loud

        if sum(self.recent_active) >= KEEP_CONSECUTIVE:
            self.post_count = POST_PAD_FRAMES
        else:
            self.post_count -= 1

        if self.post_count <= 0:
            self._finalize_event(reason=f"no active input for {POST_PAD}ms")

    def _finalize_event(self, reason: str, wait_for_encode_start: bool = False):
        if self.frames_written <= 0 or not self.base_name:
            self._reset_event_state()
            return

        if self.saw_voiced and self.saw_loud:
            etype_label = EVENT_TAGS["both"]
        elif self.saw_voiced:
            etype_label = EVENT_TAGS["human"]
        else:
            etype_label = EVENT_TAGS["other"]
        avg_rms = (self.sum_rms / self.frames_written) if self.frames_written else 0.0
        trigger_rms = int(self.trigger_rms) if self.trigger_rms is not None else 0

        ended_epoch = time.time()
        duration_seconds = self.frames_written * (FRAME_MS / 1000.0)

        self._q_send(('close', self.base_name))

        tmp_wav_path, base = None, None
        try:
            tmp_wav_path, base = self.done_q.get(timeout=5.0)
        except queue.Empty:
            print("[segmenter] WARN: writer did not close file within 5s", flush=True)

        print(
            f"[segmenter] Event ended ({reason}). type={etype_label}, avg_rms={avg_rms:.1f}, frames={self.frames_written}"
            + (f", q_drops={self.queue_drops}" if self.queue_drops else ""),
            flush=True
        )

        job_id: int | None = None
        if tmp_wav_path and base:
            day = time.strftime("%Y%m%d")
            os.makedirs(os.path.join(REC_DIR, day), exist_ok=True)
            event_ts = self.event_timestamp or base.split("_", 1)[0]
            event_count = str(self.event_counter) if self.event_counter is not None else base.rsplit("_", 1)[-1]
            safe_etype = _sanitize_event_tag(etype_label)
            final_base = f"{event_ts}_{safe_etype}_RMS-{trigger_rms}_{event_count}"
            job_id = _enqueue_encode_job(
                tmp_wav_path,
                final_base,
                source=self._recording_source,
            )
            if job_id is not None:
                self._encode_jobs.append(job_id)
            if job_id is not None and wait_for_encode_start:
                started = ENCODING_STATUS.wait_for_start(job_id, SHUTDOWN_ENCODE_START_TIMEOUT)
                if not started:
                    print(
                        (
                            "[segmenter] WARN: encode worker did not start within "
                            f"{SHUTDOWN_ENCODE_START_TIMEOUT:.1f}s (job {job_id})"
                        ),
                        flush=True,
                    )

            last_event_status = {
                "base_name": final_base,
                "started_at": self.event_timestamp,
                "started_epoch": self.event_started_epoch,
                "ended_epoch": ended_epoch,
                "duration_seconds": duration_seconds,
                "avg_rms": avg_rms,
                "trigger_rms": trigger_rms,
                "etype": etype_label,
            }
        else:
            last_event_status = {
                "base_name": self.base_name or "",
                "started_at": self.event_timestamp,
                "started_epoch": self.event_started_epoch,
                "ended_epoch": ended_epoch,
                "duration_seconds": duration_seconds,
                "avg_rms": avg_rms,
                "trigger_rms": trigger_rms,
                "etype": etype_label,
            }

        last_event_status["end_reason"] = reason
        if self._status_mode == "live":
            self._update_capture_status(
                False,
                last_event=last_event_status,
                reason=reason,
                extra={"event_duration_seconds": None, "event_size_bytes": None},
            )
        if NOTIFIER:
            try:
                NOTIFIER.handle_event(last_event_status)
            except Exception as exc:
                print(
                    f"[segmenter] WARN: notification dispatch failed: {exc!r}",
                    flush=True,
                )
        self._reset_event_state()

    def _reset_event_state(self):
        self.active = False
        self.post_count = 0
        self.recent_active.clear()
        self.consec_active = 0
        self.consec_inactive = 0
        self.frames_written = 0
        self.sum_rms = 0
        self.saw_voiced = False
        self.saw_loud = False
        self.base_name = None
        self.tmp_wav_path = None
        self.queue_drops = 0
        self.event_timestamp = None
        self.event_counter = None
        self.trigger_rms = None
        self.event_started_epoch = None
        self._ingest_hint = None
        self._ingest_hint_used = True

    def flush(self, idx: int):
        if self.active:
            print(f"[segmenter] Flushing active event at frame {idx} (reason: shutdown)", flush=True)
            self._finalize_event(reason="shutdown", wait_for_encode_start=True)
        try:
            self.audio_q.put_nowait(None)
        except Exception:
            pass

        last_event = None
        if isinstance(self._status_cache, dict):
            cached_last = self._status_cache.get("last_event")
            if isinstance(cached_last, dict):
                last_event = cached_last
        if self._status_mode == "live":
            self._update_capture_status(
                False,
                last_event=last_event,
                reason="shutdown",
                extra={
                    "service_running": False,
                    "current_rms": 0,
                    "event_duration_seconds": None,
                    "event_size_bytes": None,
                },
            )

    def encode_job_ids(self) -> tuple[int, ...]:
        return tuple(self._encode_jobs)


def main():
    rec = TimelineRecorder()
    idx = 0
    while True:
        buf = sys.stdin.buffer.read(FRAME_BYTES)
        if not buf or len(buf) < FRAME_BYTES:
            break
        rec.ingest(buf, idx)
        idx += 1
    rec.flush(idx)


if __name__ == "__main__":
    main()
