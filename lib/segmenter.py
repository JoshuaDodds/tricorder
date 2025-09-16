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
POST_PAD = 2000
PRE_PAD_FRAMES = PRE_PAD // FRAME_MS
POST_PAD_FRAMES = POST_PAD // FRAME_MS

VOICE_RATIO = 0.2
RMS_THRESH = 500  # adjust if needed last: 1200
vad = webrtcvad.Vad(2)


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

    def ingest(self, buf, idx):
        voiced = is_voice(buf)
        loud = rms(buf) > RMS_THRESH
        active = voiced and (rms(buf) > RMS_THRESH)

        self.frames.append(buf)
        self.prebuf.append(buf)

        if active:
            if not self.active:
                # new event starts
                self.start_index = max(0, idx - len(self.prebuf))
                self.active = True
            self.post_count = POST_PAD_FRAMES
        elif self.active:
            self.post_count -= 1
            if self.post_count <= 0:
                # finalize event
                end_index = idx
                etype = "HumanVoice" if voiced else "Other"
                self.events.append((self.start_index, end_index, etype))
                self.active = False
                self.start_index = None

    def flush(self, idx):
        if self.active:
            end_index = idx
            etype = "HumanVoice"
            self.events.append((self.start_index, end_index, etype))
            self.active = False
            self.start_index = None

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
                for f in self.frames[start:end]:
                    wf.writeframes(f)

        # write sidecar log
        with open(log_txt, "w") as lf:
            for start, end, etype in self.events:
                t0 = start * FRAME_MS / 1000.0
                t1 = end * FRAME_MS / 1000.0
                lf.write(f"{t0:.2f}–{t1:.2f} : {etype}\n")

        # encode + cleanup
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
