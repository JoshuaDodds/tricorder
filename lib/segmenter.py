#!/usr/bin/env python3
import os, sys, time, collections, subprocess, wave
import webrtcvad, audioop
from datetime import datetime

# ---------- NEW: threading + queue for async disk I/O ----------
import threading, queue

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2   # 16-bit
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

TMP_DIR = "/apps/tricorder/tmp"
REC_DIR = "/apps/tricorder/recordings"
ENCODER = "/apps/tricorder/bin/encode_and_store.sh"

# PRE_PAD: amount of audio (ms) saved *before* event trigger,
#          ensures leading context isn’t lost (like the first spoken word).
# POST_PAD: how long (ms) to keep recording after activity stops,
#           prevents chopping during short pauses or gaps in sound.
PRE_PAD = 2000
POST_PAD = 5 * 60000
PRE_PAD_FRAMES = PRE_PAD // FRAME_MS
POST_PAD_FRAMES = POST_PAD // FRAME_MS

# thresholds
RMS_THRESH = 500    # was 450
vad = webrtcvad.Vad(3)

# DE-BOUNCE tunables
START_CONSECUTIVE = 10   # ~200ms - number of consecutive active frames (voiced or loud) to start an event
KEEP_CONSECUTIVE  = 5    # in the recent window, at least this many frames must be active to reset POST_PAD
# END_CONSECUTIVE = 10    # UNUSED (was an extra end-debounce; POST_PAD handles end behavior)

# window sizes
KEEP_WINDOW = 10         # frames (~200ms) sliding window for keep-alive

# Mic Digital Gain
# Typical safe range: 0.5 → 4.0
# 0.5 = halves the volume (attenuation)
# 1.0 = no change
# 2.0 = doubles amplitude (≈ +6 dB)
# 4.0 = quadruples amplitude (≈ +12 dB)
GAIN = 2.0  # <-- software gain multiplier (1.0 = no boost)

# Noise reduction settings
USE_RNNOISE = False         # do not use
USE_NOISEREDUCE = False     # needs tested... may interfere with VAD
DENOISE_BEFORE_VAD = False  # Will interfere with VAD!

# buffered writes
FLUSH_THRESHOLD = 128 * 1024  # 128 KB chunks before flushing to disk (~4s audio at 16k/mono/16-bit)

# ---------- NEW: queue sizing to avoid OOM + backpressure ----------
# Each frame is 640 bytes. 512 frames ≈ 327 KB queued max.
MAX_QUEUE_FRAMES = 512


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


def is_voice(buf):
    return vad.is_speech(buf, SAMPLE_RATE)


def rms(buf):
    return audioop.rms(buf, SAMPLE_WIDTH)


# ---------- NEW: Async writer worker ----------
class _WriterWorker(threading.Thread):
    """
    Dedicated disk-writer thread.
    Protocol on self.q (audio_q):
      ('open', base_name, tmp_wav_path)
      b'<frame-bytes>'  (raw mono 16-bit PCM @ 16k)
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
                # Return to main thread for encoding
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
                    # shutdown signal
                    self._close_file()
                    self._running = False
                    break

                if isinstance(item, tuple):
                    tag = item[0]
                    if tag == 'open':
                        _, base, path = item
                        # Close any previous file just in case
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
                        # Only close if it's the same file we opened
                        if self.wav and base == self.base:
                            self._close_file()
                    else:
                        # unknown control message, ignore
                        pass

                elif isinstance(item, (bytes, bytearray, memoryview)):
                    if not self.wav:
                        # No open file; drop silently
                        continue
                    self.buf.extend(item)
                    if len(self.buf) >= self.flush_threshold:
                        self._flush()
                else:
                    # unknown item, ignore
                    pass
            finally:
                self.q.task_done()


class TimelineRecorder:
    # timestamp (“HH-MM-SS”) → counter
    event_counters = collections.defaultdict(int)

    def __init__(self):
        # NOTE: we no longer keep the whole event in RAM; we stream frames to a wav file as we go.
        self.prebuf = collections.deque(maxlen=PRE_PAD_FRAMES)
        self.active = False
        self.post_count = 0

        # debounce trackers
        self.recent_active = collections.deque(maxlen=KEEP_WINDOW)
        self.consec_active = 0
        self.consec_inactive = 0

        # logging throttle
        self.last_log = time.monotonic()

        # ---------- NEW: async writer wiring ----------
        self.audio_q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE_FRAMES)
        self.done_q: queue.Queue = queue.Queue(maxsize=2)
        self.writer = _WriterWorker(self.audio_q, self.done_q, FLUSH_THRESHOLD)
        self.writer.start()

        # streaming state
        self.base_name: str | None = None
        self.tmp_wav_path: str | None = None
        self.queue_drops = 0  # frames dropped because queue was full

        # stats across current event (for classification + avg RMS)
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
            # noisereduce expects NumPy arrays
            arr = np.frombuffer(samples, dtype=np.int16)
            arr_denoised = nr.reduce_noise(y=arr, sr=SAMPLE_RATE)
            return arr_denoised.astype(np.int16).tobytes()
        return samples

    # ---------- NEW: small helper to try non-blocking sends ----------
    def _q_send(self, item):
        try:
            self.audio_q.put_nowait(item)
        except queue.Full:
            self.queue_drops += 1
            # keep silent to avoid log flood; we surface aggregate on finalize

    # ---------- ingest / segmentation ----------
    def ingest(self, buf: bytes, idx: int):
        # apply gain
        buf = self._apply_gain(buf)
        # optional denoise before analysis (note: may hurt VAD; disabled by default)
        proc_for_analysis = self._denoise(buf) if DENOISE_BEFORE_VAD else buf

        # per-frame analysis
        rms_val = rms(proc_for_analysis)
        voiced = is_voice(proc_for_analysis)
        loud = rms_val > RMS_THRESH
        frame_active = loud  # can be 'voiced or loud' if you find either condition = "interesting"

        # periodic debug
        now = time.monotonic()
        if now - self.last_log >= 5:
            print(f"[segmenter] frame={idx} rms={rms_val} voiced={voiced} loud={loud} active={frame_active}", flush=True)
            self.last_log = now

        # maintain debounce counters
        if frame_active:
            self.consec_active += 1
            self.consec_inactive = 0
        else:
            self.consec_inactive += 1
            self.consec_active = 0
        self.recent_active.append(frame_active)

        # always capture pre-pad rolling buffer while idle
        self.prebuf.append(buf)

        if not self.active:
            # start only if sustained activity
            if self.consec_active >= START_CONSECUTIVE:
                # filename skeleton (we keep "Both" as a neutral hint; basename is fixed at start time)
                start_time = datetime.now().strftime("%H-%M-%S")
                TimelineRecorder.event_counters[start_time] += 1
                count = TimelineRecorder.event_counters[start_time]
                self.base_name = f"{start_time}_Both_{count}"
                self.tmp_wav_path = os.path.join(TMP_DIR, f"{self.base_name}.wav")

                # open file in writer
                self._q_send(('open', self.base_name, self.tmp_wav_path))

                # dump pre-pad into the event file
                if self.prebuf:
                    for f in self.prebuf:
                        # We keep writer as light as possible: no denoise in writer.
                        self._q_send(bytes(f))
                        # update stats for classification
                        self.frames_written += 1
                        # avg RMS uses analysis-path RMS (proc_for_analysis for current frame only; prebuf used raw)
                        self.sum_rms += rms(f)
                self.prebuf.clear()

                # mark active + initialize counters from this frame
                self.active = True
                self.post_count = POST_PAD_FRAMES
                self.saw_voiced = voiced
                self.saw_loud = loud

                trigger = []
                if loud:
                    trigger.append(f"RMS>{RMS_THRESH} (rms={rms_val})")
                if voiced:
                    trigger.append("VAD=1")
                trigger_info = " & ".join(trigger) if trigger else "unknown"

                print(
                    f"[segmenter] Event started at frame ~{max(0, idx - PRE_PAD_FRAMES)} "
                    f"(trigger={trigger_info})",
                    flush=True
                )
            return  # idle until event opens

        # active event: enqueue current frame
        self._q_send(bytes(buf))
        self.frames_written += 1
        self.sum_rms += rms(proc_for_analysis)
        self.saw_voiced = voiced or self.saw_voiced
        self.saw_loud = loud or self.saw_loud

        # keep-alive vs closing countdown
        if sum(self.recent_active) >= KEEP_CONSECUTIVE:
            self.post_count = POST_PAD_FRAMES
        else:
            self.post_count -= 1

        if self.post_count <= 0:
            self._finalize_event(reason=f"no active input for {POST_PAD}ms")

    def _finalize_event(self, reason: str):
        if self.frames_written <= 0 or not self.base_name:
            # nothing meaningful recorded; just reset state
            print("[segmenter] No frames recorded; skipping event finalize", flush=True)
            self._reset_event_state()
            return

        etype = "Both" if (self.saw_voiced and self.saw_loud) else ("Human" if self.saw_voiced else "Other")
        avg_rms = (self.sum_rms / self.frames_written) if self.frames_written else 0.0

        # tell writer to close current file
        self._q_send(('close', self.base_name))

        # wait briefly for writer to flush & return the path for encoding
        tmp_wav_path, base = None, None
        try:
            tmp_wav_path, base = self.done_q.get(timeout=5.0)
        except queue.Empty:
            print("[segmenter] WARN: writer did not close file within 5s; skipping encode this round", flush=True)

        print(
            f"[segmenter] Event ended ({reason}). type={etype}, avg_rms={avg_rms:.1f}, frames={self.frames_written}"
            + (f", q_drops={self.queue_drops}" if self.queue_drops else ""),
            flush=True
        )

        if tmp_wav_path and base:
            # Ensure date dir exists (encode script handles it too, but safe)
            day = time.strftime("%Y%m%d")
            os.makedirs(os.path.join(REC_DIR, day), exist_ok=True)

            # encode + cleanup (preserve base name)
            cmd = [ENCODER, tmp_wav_path, base]
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, check=True)
                print("[encoder] SUCCESS")
                print(res.stdout, res.stderr)
            except subprocess.CalledProcessError as e:
                print("[encoder] FAIL", e.returncode)
                print(e.stdout, e.stderr)

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
        # On shutdown, if an event is open, finalize it.
        if self.active:
            print(f"[segmenter] Flushing active event at frame {idx} (reason: shutdown)", flush=True)
            self._finalize_event(reason="shutdown")
        # Stop writer thread
        try:
            self.audio_q.put_nowait(None)  # shutdown signal
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
