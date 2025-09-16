#!/usr/bin/env python3
import os, sys, time, collections, subprocess, wave
import webrtcvad, audioop

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

VOICE_RATIO = 0.2
RMS_THRESH = 300
vad = webrtcvad.Vad(2)

# Mic Digital Gain
# Typical safe range: 0.5 → 4.0
# 0.5 = halves the volume (attenuation)
# 1.0 = no change
# 2.0 = doubles amplitude (≈ +6 dB)
# 4.0 = quadruples amplitude (≈ +12 dB)
GAIN = 2.0  # <-- software gain multiplier (1.0 = no boost)

# Noise reduction settings
USE_RNNOISE = False
USE_NOISEREDUCE = False
DENOISE_BEFORE_VAD = False

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
    def __init__(self):
        self.frames = []
        self.events = []
        self.active = False
        self.post_count = 0
        self.prebuf = collections.deque(maxlen=PRE_PAD_FRAMES)
        self.start_index = None
        self.last_log = time.monotonic()

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

    def ingest(self, buf, idx):
        buf = self._apply_gain(buf)

        if DENOISE_BEFORE_VAD:
            buf = self._denoise(buf)

        rms_val = rms(buf)
        voiced = is_voice(buf)
        loud = rms_val > RMS_THRESH
        active = voiced and loud

        # periodic debug logging
        now = time.monotonic()
        if now - self.last_log >= 5:
            print(f"[segmenter] frame={idx} rms={rms_val} voiced={voiced} active={active}", flush=True)
            self.last_log = now

        self.frames.append(buf)
        self.prebuf.append(buf)

        if active:
            if not self.active:
                self.start_index = max(0, idx - len(self.prebuf))
                self.active = True
                print(f"[segmenter] Event started at frame {self.start_index}", flush=True)
            self.post_count = POST_PAD_FRAMES
        elif self.active:
            # Speech just dropped this frame
            reason = []
            if not voiced:
                reason.append("VAD=off")
            if rms_val <= RMS_THRESH:
                reason.append(f"RMS={rms_val} <= {RMS_THRESH}")
            if reason:
                print(f"[segmenter] Speech dropped at frame {idx} ({', '.join(reason)})", flush=True)

            self.post_count -= 1
            if self.post_count <= 0:
                end_index = idx
                etype = "HumanVoice" if voiced else "Other"
                self.events.append((self.start_index, end_index, etype))
                self.active = False
                self.start_index = None
                print(
                    f"[segmenter] Event ended at frame {end_index} "
                    f"(reason: no active speech for {POST_PAD}ms)",
                    flush=True
                )
                self.write_output()
                self.frames.clear()
                self.events.clear()

    def flush(self, idx):
        if self.active:
            end_index = idx
            etype = "HumanVoice"
            self.events.append((self.start_index, end_index, etype))
            self.active = False
            self.start_index = None
            min_frames = int(0.5 * 1000 / FRAME_MS)
            if (end_index - self.events[-1][0]) >= min_frames:
                print(f"[segmenter] Flushing active event ending at {end_index} (reason: shutdown)", flush=True)
                self.write_output()
                self.frames.clear()
                self.events.clear()
            else:
                print("[segmenter] Skipping tiny flush event (<0.5s) (reason: shutdown)", flush=True)
                self.events.clear()

    def write_output(self):
        if not self.events:
            print("[segmenter] No events detected")
            return

        os.makedirs(TMP_DIR, exist_ok=True)
        day = time.strftime("%Y%m%d")
        outdir = os.path.join(REC_DIR, day)
        os.makedirs(outdir, exist_ok=True)

        ts = time.strftime("%Y%m%d_%H%M%S")
        tmp_wav = os.path.join(TMP_DIR, f"timeline_{ts}.wav")
        log_txt = os.path.join(outdir, f"timeline_{ts}.log")
        out_opus = os.path.join(outdir, f"timeline_{ts}.opus")

        with wave.open(tmp_wav, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(SAMPLE_WIDTH)
            wf.setframerate(SAMPLE_RATE)
            for start, end, _ in self.events:
                segment = b''.join(self.frames[start:end])
                if not DENOISE_BEFORE_VAD:
                    segment = self._denoise(segment)
                wf.writeframes(segment)

        with open(log_txt, "w") as lf:
            for start, end, etype in self.events:
                t0 = start * FRAME_MS / 1000.0
                t1 = end * FRAME_MS / 1000.0
                lf.write(f"{t0:.2f}–{t1:.2f} : {etype}\n")

        cmd = [ENCODER, tmp_wav, "Timeline"]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print("[encoder] SUCCESS")
            print(res.stdout, res.stderr)
        except subprocess.CalledProcessError as e:
            print("[encoder] FAIL", e.returncode)
            print(e.stdout, e.stderr)


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
    rec.write_output()


if __name__ == "__main__":
    main()
