#!/usr/bin/env python3
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
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    message="pkg_resources is deprecated as an API.*"
)
import webrtcvad    # noqa
import audioop      # noqa
from lib.config import get_cfg

# ANSI colors for booleans (can be disabled via NO_COLOR env)
ANSI_GREEN = "\033[32m"
ANSI_RED = "\033[31m"
ANSI_RESET = "\033[0m"
USE_COLOR = os.getenv("NO_COLOR") is None

def color_tf(val: bool) -> str:
    # Single-character stable width 'T'/'F' with color
    if not USE_COLOR:
        return "T" if val else "F"
    return f"{ANSI_GREEN}T{ANSI_RESET}" if val else f"{ANSI_RED}F{ANSI_RESET}"

cfg = get_cfg()

SAMPLE_RATE = int(cfg["audio"]["sample_rate"])
SAMPLE_WIDTH = 2   # 16-bit
FRAME_MS = int(cfg["audio"]["frame_ms"])
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

TMP_DIR = cfg["paths"]["tmp_dir"]
REC_DIR = cfg["paths"]["recordings_dir"]
ENCODER = cfg["paths"]["encoder_script"]

# PRE_PAD / POST_PAD
PRE_PAD = int(cfg["segmenter"]["pre_pad_ms"])
POST_PAD = int(cfg["segmenter"]["post_pad_ms"])
PRE_PAD_FRAMES = PRE_PAD // FRAME_MS
POST_PAD_FRAMES = POST_PAD // FRAME_MS

# thresholds
RMS_THRESH = int(cfg["segmenter"]["rms_threshold"])
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
DEBUG_VERBOSE = (os.getenv("DEV") == "1") or bool(cfg["logging"]["dev_mode"])

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
    return audioop.rms(buf, SAMPLE_WIDTH)


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

        self.base_name: str | None = None
        self.tmp_wav_path: str | None = None
        self.queue_drops = 0

        self.frames_written = 0
        self.sum_rms = 0
        self.saw_voiced = False
        self.saw_loud = False

    @staticmethod
    def _apply_gain(buf: bytes) -> bytes:
        if GAIN == 1.0:
            return buf
        return audioop.mul(buf, SAMPLE_WIDTH, GAIN)

    @staticmethod
    def _denoise(samples: bytes) -> bytes:
        if USE_RNNOISE:
            denoiser = rnnoise.RNNoise()
            frame_size = FRAME_BYTES
            out = bytearray()
            for i in range(0, len(samples), frame_size):
                chunk = samples[i:i+frame_size]
                if len(chunk) == frame_size:
                    out.extend(denoiser.filter(chunk))
            return bytes(out)
        elif USE_NOISEREDUCE:
            arr = np.frombuffer(samples, dtype=np.int16)
            arr_denoised = nr.reduce_noise(y=arr, sr=SAMPLE_RATE)
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
        loud = rms_val > RMS_THRESH
        frame_active = loud  # primary trigger

        # collect rolling window for debug stats
        self._dbg_rms.append(rms_val)
        self._dbg_voiced.append(bool(voiced))

        # once per-second debug (only if DEV enabled)
        now = time.monotonic()
        if DEBUG_VERBOSE and (now - self.last_log >= 1.0):
            # Inline, narrow VU bar; numeric fields fixed width to prevent jitter
            def _bar(val: int, scale: int = 4000, width: int = 20) -> str:
                lvl = min(width, int((val / float(scale)) * width)) if scale > 0 else 0
                return "#" * lvl + "-" * (width - lvl)

            win_len = max(1, len(self._dbg_rms))
            win_avg = int(sum(self._dbg_rms) / win_len) if win_len else 0
            win_peak = max(self._dbg_rms) if win_len else 0
            voiced_ratio = (sum(1 for v in self._dbg_voiced if v) / win_len) if win_len else 0.0

            print(
                # Left block: fixed widths and colored booleans (single-char)
                f"[segmenter] frame={idx:6d} rms={rms_val:4d} "
                f"voiced={color_tf(voiced)} loud={color_tf(loud)} "
                f"active={color_tf(frame_active)} capturing={color_tf(self.active)}  |  "
                # Right block: stable-width RMS/VAD summary and fixed-width VU bar
                f"RMS cur={rms_val:4d} avg={win_avg:4d} peak={win_peak:4d}  "
                f"VAD voiced={voiced_ratio*100:5.1f}%  |  {_bar(rms_val)}",
                flush=True
            )
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
                self.post_count = POST_PAD_FRAMES
                self.saw_voiced = voiced
                self.saw_loud = loud
                print(
                    f"[segmenter] Event started at frame ~{max(0, idx - PRE_PAD_FRAMES)} "
                    f"(trigger={'RMS' if loud else 'VAD'}>{RMS_THRESH} (rms={rms_val}))",
                    flush=True
                )
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
            cmd = [ENCODER, tmp_wav_path, base]
            try:
                subprocess.run(cmd, capture_output=True, text=True, check=True)
            except subprocess.CalledProcessError as e:
                print(f"[encoder] FAIL {e.returncode}", flush=True)

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

    def flush(self, idx: int):
        if self.active:
            print(f"[segmenter] Flushing active event at frame {idx} (reason: shutdown)", flush=True)
            self._finalize_event(reason="shutdown")
        try:
            self.audio_q.put_nowait(None)
        except Exception:
            pass


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
