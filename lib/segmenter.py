#!/usr/bin/env python3
import os, sys, time, collections, subprocess, wave
import webrtcvad, audioop
from datetime import datetime

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2   # 16-bit
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

TMP_DIR = "/apps/tricorder/tmp"
REC_DIR = "/apps/tricorder/recordings"
ENCODER = "/apps/tricorder/bin/encode_and_store.sh"

# padding in ms
PRE_PAD = 2000
POST_PAD = 15000
PRE_PAD_FRAMES = PRE_PAD // FRAME_MS
POST_PAD_FRAMES = POST_PAD // FRAME_MS

# thresholds
RMS_THRESH = 380
vad = webrtcvad.Vad(2)

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

        # streaming state
        self.wav_handle: wave.Wave_write | None = None
        self.tmp_wav_path: str | None = None
        self.base_name: str | None = None
        self._io_buffer = bytearray()  # buffered write accumulator

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

    # ---------- streaming helpers ----------
    def _open_event_file(self, etype_hint: str):
        """
        Create base name and open tmp wav. We use an etype hint only for name stability;
        final classification is computed from stats at close time and only affects logs (name is already fixed).
        """
        os.makedirs(TMP_DIR, exist_ok=True)
        start_time = datetime.now().strftime("%H-%M-%S")
        TimelineRecorder.event_counters[start_time] += 1
        count = TimelineRecorder.event_counters[start_time]
        self.base_name = f"{start_time}_{etype_hint}_{count}"

        self.tmp_wav_path = os.path.join(TMP_DIR, f"{self.base_name}.wav")
        self.wav_handle = wave.open(self.tmp_wav_path, "wb")
        self.wav_handle.setnchannels(1)
        self.wav_handle.setsampwidth(SAMPLE_WIDTH)
        self.wav_handle.setframerate(SAMPLE_RATE)
        self._io_buffer.clear()

    def _buffered_write(self, frame: bytes):
        """Append a frame to the in-memory buffer and flush to disk in 128 KB chunks."""
        self._io_buffer.extend(frame)
        if len(self._io_buffer) >= FLUSH_THRESHOLD:
            # one big write is much cheaper than many tiny writes
            self.wav_handle.writeframes(self._io_buffer)
            self._io_buffer.clear()

    def _flush_close_event_file(self) -> tuple[str, str] | None:
        """Flush any remaining buffer, close WAV, move to encoder. Returns (tmp_wav_path, base_name)."""
        if not self.wav_handle:
            return None
        if self._io_buffer:
            self.wav_handle.writeframes(self._io_buffer)
            self._io_buffer.clear()
        self.wav_handle.close()
        path, base = self.tmp_wav_path, self.base_name
        self.wav_handle = None
        self.tmp_wav_path = None
        self.base_name = None
        return (path, base)

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
        frame_active = voiced or loud  # either condition = "interesting"

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
                # decide a provisional name ("Both" is neutral); final type isn't needed for filename correctness,
                # but we keep "Both" to align with previous naming scheme.
                self._open_event_file(etype_hint="Both")
                # dump pre-pad into the event file
                if self.prebuf:
                    # if we denoise before VAD, the frames in prebuf were not denoised; write as-is or denoise on write
                    for f in self.prebuf:
                        f2 = f if DENOISE_BEFORE_VAD else self._denoise(f)
                        self._buffered_write(f2)
                        # update stats for classification
                        self.frames_written += 1
                        self.sum_rms += rms(f2 if DENOISE_BEFORE_VAD else proc_for_analysis)  # conservative
                self.prebuf.clear()

                # include current frame (already appended to prebuf), but since we dumped prebuf including the current
                # frame, do not double-write it here. Just initialize runtime state.
                self.active = True
                self.post_count = POST_PAD_FRAMES
                self.saw_voiced = voiced or self.saw_voiced
                self.saw_loud = loud or self.saw_loud
                # NOTE: frames_written/sum_rms already updated via prebuf loop
                print(f"[segmenter] Event started at frame ~{max(0, idx - PRE_PAD_FRAMES)}", flush=True)
            # else still idle, do nothing further
            return

        # if we are here and active, write THIS frame (it wasn't part of prebuf anymore)
        f_out = buf if DENOISE_BEFORE_VAD else self._denoise(buf)
        self._buffered_write(f_out)
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
        # compute classification and avg RMS from stats (no need to re-scan audio)
        if self.frames_written <= 0:
            # nothing meaningful recorded; just reset state
            print("[segmenter] No frames recorded; skipping event finalize", flush=True)
            self._reset_event_state()
            return

        etype = "Both" if (self.saw_voiced and self.saw_loud) else ("Human" if self.saw_voiced else "Other")
        avg_rms = (self.sum_rms / self.frames_written) if self.frames_written else 0.0

        # We opened the file with a neutral hint. The file basename is already fixed (start time).
        # We will pass the "base name" to the encoder so the final OPUS keeps the same basename.
        out = self._flush_close_event_file()
        if not out:
            print("[segmenter] WARN: finalize called but no wav handle/path", flush=True)
            self._reset_event_state()
            return
        tmp_wav_path, base = out

        print(f"[segmenter] Event ended ({reason}). type={etype}, avg_rms={avg_rms:.1f}, frames={self.frames_written}", flush=True)

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
        self._io_buffer.clear()
        self.frames_written = 0
        self.sum_rms = 0
        self.saw_voiced = False
        self.saw_loud = False

    def flush(self, idx: int):
        # On shutdown, if an event is open, just finalize it.
        if self.active:
            print(f"[segmenter] Flushing active event at frame {idx} (reason: shutdown)", flush=True)
            self._finalize_event(reason="shutdown")

    # NOTE: write_output() no longer used; streaming happens during ingest.


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
