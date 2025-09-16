#!/usr/bin/env python3
import os
import time
import subprocess
import sys
from segmenter import TimelineRecorder  # uses your current timeline aggregator

# 20 ms frame @ 16kHz mono 16-bit PCM
BSIZE = 640

# Export when we've been idle this long after a segment closes
IDLE_EXPORT_SECONDS = 3.0
FRAME_MS = 20
IDLE_EXPORT_FRAMES = int(IDLE_EXPORT_SECONDS * 1000 / FRAME_MS)

AUDIO_DEV = "plughw:CARD=Device,DEV=0"

def run_once():
    rec = TimelineRecorder()
    last_active_frame = None
    frame_idx = 0

    cmd = [
        "arecord",
        "-D", AUDIO_DEV,
        "-f", "S16_LE",
        "-c1",
        "-r", "16000",
        "-q",
        "-"  # write raw PCM to stdout
    ]
    print(f"[live] Launching: {' '.join(cmd)}", flush=True)

    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=0) as proc:
        buffer = b""
        while True:
            data = proc.stdout.read(4096)  # read in larger blocks
            if not data:
                break
            buffer += data
            while len(buffer) >= BSIZE:
                frame = buffer[:BSIZE]
                buffer = buffer[BSIZE:]
                rec.ingest(frame, "live")

                # track activity
                if getattr(rec, "active", False):
                    last_active_frame = frame_idx

                # idle export check
                if last_active_frame is not None and not getattr(rec, "active", False):
                    idle_frames = frame_idx - last_active_frame
                    if idle_frames >= IDLE_EXPORT_FRAMES and rec.events:
                        print(f"[live] Idle {idle_frames} frames → exporting timeline", flush=True)
                        rec.write_output()
                        rec = TimelineRecorder()
                        last_active_frame = None

                frame_idx += 1

    # Process ended (device unplug or stop). Flush any trailing event and export if there’s content.
    try:
        rec.flush("live")
    except TypeError:
        # older version of TimelineRecorder.flush expects an idx; you already updated it
        rec.flush()
    if rec.events:
        print("[live] arecord ended → exporting trailing timeline", flush=True)
        rec.write_output()

def main():
    print("[live] Starting voice recorder daemon", flush=True)
    while True:
        try:
            run_once()
        except FileNotFoundError:
            print("[live] ERROR: 'arecord' not found. Install alsa-utils.", flush=True)
            time.sleep(10)
        except Exception as e:
            print(f"[live] arecord failed: {e}", flush=True)
            time.sleep(5)
        # Small delay before retrying the device (in case of unplug)
        print("[live] No audio device or stream ended. Retrying in 5s...", flush=True)
        time.sleep(5)

if __name__ == "__main__":
    # Unbuffer stdout just in case
    try:
        import sys
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    main()
