#!/usr/bin/env python3
import json
import math
import os
import sys
import time
import collections
import subprocess
import wave
from datetime import datetime
import threading
import queue
import warnings
import array
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    message="pkg_resources is deprecated as an API.*"
)
import webrtcvad    # noqa
from lib.config import get_cfg
from lib.notifications import build_dispatcher

cfg = get_cfg()
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

                wav_path, base_name = item
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
                self.q.task_done()


def _ensure_encoder_worker() -> None:
    global _ENCODE_WORKER
    with _ENCODE_LOCK:
        if _ENCODE_WORKER is None or not _ENCODE_WORKER.is_alive():
            _ENCODE_WORKER = _EncoderWorker(ENCODE_QUEUE)
            _ENCODE_WORKER.start()


def _enqueue_encode_job(tmp_wav_path: str, base_name: str) -> None:
    if not tmp_wav_path or not base_name:
        return
    _ensure_encoder_worker()
    try:
        ENCODE_QUEUE.put_nowait((tmp_wav_path, base_name))
    except queue.Full:
        ENCODE_QUEUE.put((tmp_wav_path, base_name))
    print(f"[segmenter] queued encode job for {base_name}", flush=True)


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
        initial_norm = max(0.0, min(initial_linear_threshold / self._NORM, 1.0))
        if self.enabled:
            initial_norm = max(self.min_thresh_norm, initial_norm)
        self._current_norm = initial_norm
        self.debug = True  # todo: set to DEBUG_VERBOSE when done testing

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

    def observe(self, rms_value: int, voiced: bool) -> bool:
        if not self.enabled:
            return False

        norm = max(0.0, min(rms_value / self._NORM, 1.0))
        if not voiced:
            self._buffer.append(norm)

        now = time.monotonic()
        if (now - self._last_update) < self.update_interval:
            return False

        if not self._buffer:
            return False

        self._last_update = now
        ordered = sorted(self._buffer)
        idx = max(0, int(math.ceil(0.95 * len(ordered)) - 1))
        p95 = ordered[idx]
        candidate_raise = min(1.0, max(self.min_thresh_norm, p95 * self.margin))
        rel_idx = max(0, int(math.ceil(self.release_percentile * len(ordered)) - 1))
        release_val = ordered[rel_idx]
        candidate_release = min(1.0, max(self.min_thresh_norm, release_val * self.margin))
        if (candidate_raise > self._current_norm) and (candidate_release > self._current_norm):
            candidate = candidate_raise
        else:
            candidate = min(self._current_norm, candidate_release)
        self._last_p95 = p95
        self._last_candidate = candidate
        self._last_release = release_val

        if self._current_norm <= 0.0:
            should_update = True
        else:
            delta = abs(candidate - self._current_norm)
            should_update = (delta / self._current_norm) >= self.hysteresis_tolerance

        if should_update:
            previous = self._current_norm
            self._current_norm = candidate
            if self.debug:
                details = (
                    f"(p95={p95:.4f}, margin={self.margin:.2f}, "
                    f"release_pctl={self.release_percentile:.2f}, "
                    f"release={release_val:.4f})"
                )
                print(
                    "[segmenter] adaptive RMS threshold updated: "
                    f"prev={int(round(previous * self._NORM))} "
                    f"new={self.threshold_linear} "
                    f"{details}",
                    flush=True,
                )
            return True

        return False


class TimelineRecorder:
    event_counters = collections.defaultdict(int)

    def __init__(self):
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

        self.status_path = os.path.join(TMP_DIR, "segmenter_status.json")
        self._status_cache: dict[str, object] | None = None
        self.event_started_epoch: float | None = None
        self._update_capture_status(False, reason="idle")

    def _update_capture_status(
        self,
        capturing: bool,
        *,
        event: dict | None = None,
        last_event: dict | None = None,
        reason: str | None = None,
    ) -> None:
        payload: dict[str, object] = {
            "capturing": bool(capturing),
            "updated_at": time.time(),
            "adaptive_rms_threshold": int(self._adaptive.threshold_linear),
        }
        if capturing and event:
            payload["event"] = event
        if not capturing and last_event:
            payload["last_event"] = last_event
        if reason:
            payload["last_stop_reason"] = reason

        compare_keys = (
            "capturing",
            "event",
            "last_event",
            "last_stop_reason",
            "adaptive_rms_threshold",
        )
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

    def _emit_threshold_update(self) -> None:
        cached = self._status_cache or {}
        capturing = bool(cached.get("capturing", self.active))
        event = cached.get("event") if capturing else None
        last_event = None if capturing else cached.get("last_event")
        reason = cached.get("last_stop_reason")
        self._update_capture_status(capturing, event=event, last_event=last_event, reason=reason)

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

    def _q_send(self, item):
        try:
            self.audio_q.put_nowait(item)
        except queue.Full:
            self.queue_drops += 1

    def ingest(self, buf: bytes, idx: int):
        buf = self._apply_gain(buf)
        proc_for_analysis = self._denoise(buf) if DENOISE_BEFORE_VAD else buf

        rms_val = rms(proc_for_analysis)
        voiced = is_voice(proc_for_analysis)
        current_threshold = self._adaptive.threshold_linear
        loud = rms_val > current_threshold
        frame_active = loud  # primary trigger

        # collect rolling window for debug stats
        self._dbg_rms.append(rms_val)
        self._dbg_voiced.append(bool(voiced))

        threshold_updated = self._adaptive.observe(rms_val, bool(voiced))
        if threshold_updated:
            self._emit_threshold_update()

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
                start_time = datetime.now().strftime("%H-%M-%S")
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

    def _finalize_event(self, reason: str):
        if self.frames_written <= 0 or not self.base_name:
            self._reset_event_state()
            return

        etype = "Both" if (self.saw_voiced and self.saw_loud) else ("Human" if self.saw_voiced else "Other")
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
            f"[segmenter] Event ended ({reason}). type={etype}, avg_rms={avg_rms:.1f}, frames={self.frames_written}"
            + (f", q_drops={self.queue_drops}" if self.queue_drops else ""),
            flush=True
        )

        if tmp_wav_path and base:
            day = time.strftime("%Y%m%d")
            os.makedirs(os.path.join(REC_DIR, day), exist_ok=True)
            event_ts = self.event_timestamp or base.split("_", 1)[0]
            event_count = str(self.event_counter) if self.event_counter is not None else base.rsplit("_", 1)[-1]
            final_base = f"{event_ts}_{etype}_RMS-{trigger_rms}_{event_count}"
            _enqueue_encode_job(tmp_wav_path, final_base)

            last_event_status = {
                "base_name": final_base,
                "started_at": self.event_timestamp,
                "started_epoch": self.event_started_epoch,
                "ended_epoch": ended_epoch,
                "duration_seconds": duration_seconds,
                "avg_rms": avg_rms,
                "trigger_rms": trigger_rms,
                "etype": etype,
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
                "etype": etype,
            }

        last_event_status["end_reason"] = reason
        self._update_capture_status(False, last_event=last_event_status, reason=reason)
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

    def flush(self, idx: int):
        if self.active:
            print(f"[segmenter] Flushing active event at frame {idx} (reason: shutdown)", flush=True)
            self._finalize_event(reason="shutdown")
        try:
            self.audio_q.put_nowait(None)
        except Exception:
            pass

        try:
            ENCODE_QUEUE.join()
        except Exception:
            pass

        last_event = None
        if isinstance(self._status_cache, dict):
            cached_last = self._status_cache.get("last_event")
            if isinstance(cached_last, dict):
                last_event = cached_last
        self._update_capture_status(False, last_event=last_event, reason="shutdown")


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
