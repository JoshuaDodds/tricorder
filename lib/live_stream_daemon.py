#!/usr/bin/env python3
import os
import time
import subprocess
import sys
import signal
from segmenter import TimelineRecorder, SAMPLE_RATE

# 20 ms @ 16kHz mono 16-bit PCM
FRAME_MS = 20
FRAME_BYTES = int(SAMPLE_RATE * 2 * FRAME_MS / 1000)  # 640
CHUNK_BYTES = 4096  # read in bigger chunks; slice into frames

# Prefer a stable device selector (stick with plughw to get 16kHz)
AUDIO_DEV = os.environ.get("AUDIO_DEV", "plughw:CARD=Device,DEV=0")

ARECORD_CMD = [
    "arecord",
    "-D", AUDIO_DEV,
    "-c", "1",
    "-f", "S16_LE",
    "-r", str(SAMPLE_RATE),
    "--buffer-size", "192000",
    "--period-size", "9600",
    "-t", "raw",
    "-"  # stdout
]

stop_requested = False
p = None  # global handle to arecord process


def handle_signal(signum, frame):
    """Handle SIGINT/SIGTERM by stopping main loop and killing arecord."""
    global stop_requested, p
    print(f"[live] received signal {signum}, shutting down...", flush=True)
    stop_requested = True
    if p is not None and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass


# Register signal handlers
signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)


def spawn_arecord():
    env = os.environ.copy()
    return subprocess.Popen(
        ARECORD_CMD,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        bufsize=0,
        start_new_session=True,
        env=env
    )


def main():
    global p
    print(f"[live] starting with device={AUDIO_DEV}", flush=True)
    while not stop_requested:
        p = None
        try:
            try:
                p = spawn_arecord()
            except Exception as e:
                print(f"[live] failed to launch arecord: {e!r}", flush=True)
                time.sleep(5)
                continue

            rec = TimelineRecorder()
            buf = bytearray()
            frame_idx = 0
            last_stat = time.monotonic()

            assert p.stdout is not None
            stderr_fd = p.stderr.fileno() if p.stderr is not None else None

            os.set_blocking(p.stdout.fileno(), True)
            if stderr_fd is not None:
                try:
                    os.set_blocking(stderr_fd, False)
                except Exception:
                    pass

            while not stop_requested:
                chunk = p.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break
                buf.extend(chunk)

                while len(buf) >= FRAME_BYTES:
                    frame = bytes(buf[:FRAME_BYTES])
                    rec.ingest(frame, frame_idx)
                    del buf[:FRAME_BYTES]
                    frame_idx += 1

                now = time.monotonic()
                if now - last_stat >= 5:
                    print(f"[live] frames={frame_idx} buf={len(buf)}B", flush=True)
                    last_stat = now

                if stderr_fd is not None:
                    try:
                        while True:
                            data = os.read(stderr_fd, 4096)
                            if not data:
                                break
                    except BlockingIOError:
                        pass
                    except Exception:
                        pass

        except Exception as e:
            print(f"[live] loop error: {e!r}", flush=True)
        finally:
            try:
                if 'rec' in locals():
                    rec.flush(frame_idx)  # flush is now responsible for finalizing
            except Exception as e:
                print(f"[live] flush failed: {e!r}", flush=True)

            if p is not None:
                try:
                    if p.poll() is None:
                        p.terminate()
                        try:
                            p.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            p.kill()
                    if p.stdout:
                        p.stdout.close()
                    if p.stderr:
                        p.stderr.close()
                except Exception as e:
                    print(f"[live] cleanup error: {e!r}", flush=True)

            if not stop_requested:
                print("[live] arecord ended or device unavailable; retrying in 5s...", flush=True)
                time.sleep(5)

    print("[live] clean shutdown complete", flush=True)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    main()
