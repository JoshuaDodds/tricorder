#!/usr/bin/env python3
import os
import time
import subprocess
import sys
from segmenter import TimelineRecorder, SAMPLE_RATE

# 20 ms @ 16kHz mono 16-bit PCM
FRAME_MS = 20
FRAME_BYTES = int(SAMPLE_RATE * 2 * FRAME_MS / 1000)  # 640
CHUNK_BYTES = 4096  # read in bigger chunks; slice into frames

# Export closed segments at most this often when we're idle
IDLE_EXPORT_SECONDS = 3.0
IDLE_EXPORT_FRAMES = int(IDLE_EXPORT_SECONDS * 1000 / FRAME_MS)

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
    print(f"[live] starting with device={AUDIO_DEV}", flush=True)
    while True:
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
            last_export_idx = 0
            last_stat = time.monotonic()

            assert p.stdout is not None
            stderr_fd = p.stderr.fileno() if p.stderr is not None else None

            # block on stdout
            os.set_blocking(p.stdout.fileno(), True)
            # non-blocking stderr if possible
            if stderr_fd is not None:
                try:
                    os.set_blocking(stderr_fd, False)
                except Exception:
                    pass

            while True:
                chunk = p.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break
                buf.extend(chunk)

                while len(buf) >= FRAME_BYTES:
                    # FIX: copy slice instead of memoryview to avoid BufferError
                    frame = bytes(buf[:FRAME_BYTES])
                    rec.ingest(frame, frame_idx)
                    del buf[:FRAME_BYTES]
                    frame_idx += 1

                    if (frame_idx - last_export_idx) >= IDLE_EXPORT_FRAMES:
                        rec.write_output()
                        last_export_idx = frame_idx

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
            # Final flush before exit/restart
            try:
                if 'rec' in locals():
                    rec.flush(frame_idx)
                    rec.write_output()
            except Exception as e:
                print(f"[live] flush/write_output failed: {e!r}", flush=True)

            # Ensure arecord is cleaned up
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

            print("[live] arecord ended or device unavailable; retrying in 5s...", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    main()
