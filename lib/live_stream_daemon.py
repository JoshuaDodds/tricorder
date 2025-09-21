#!/usr/bin/env python3
import os
import time
import subprocess
import sys
import signal
from lib.segmenter import TimelineRecorder
from lib.config import get_cfg
from lib.fault_handler import reset_usb
from lib.web_stream_tap import WebStreamTee

cfg = get_cfg()
SAMPLE_RATE = int(cfg["audio"]["sample_rate"])
FRAME_MS = int(cfg["audio"]["frame_ms"])
FRAME_BYTES = int(SAMPLE_RATE * 2 * FRAME_MS / 1000)
CHUNK_BYTES = 4096


# ENV AUDIO_DEV overrides config
AUDIO_DEV = os.environ.get("AUDIO_DEV", cfg["audio"]["device"])

ARECORD_CMD = [
    "arecord",
    "-D", AUDIO_DEV,
    "-c", "1",
    "-f", "S16_LE",
    "-r", str(SAMPLE_RATE),
    "--buffer-size", "48000",
    "--period-size", "2400",
    "-t", "raw",
    "-"
]

stop_requested = False
p = None

def handle_signal(signum, frame):  # noqa
    global stop_requested, p
    print(f"[live] received signal {signum}, shutting down...", flush=True)
    stop_requested = True
    if p is not None and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass


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
    global p, stop_requested
    stop_requested = False  # reset on each new run
    print(f"[live] starting with device={AUDIO_DEV}", flush=True)

    tap = WebStreamTee(
        path=os.path.join(cfg["paths"]["tmp_dir"], "web_stream.wav"),
        sample_rate=SAMPLE_RATE,
        channels=1,
        bits_per_sample=16,
        history_seconds=60,
    )
    tap.start()

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
            last_frame_time = time.monotonic()

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
                    tap.feed(frame)  # new: continuous tee for web streamer
                    rec.ingest(frame, frame_idx)
                    del buf[:FRAME_BYTES]
                    frame_idx += 1
                    last_frame_time = time.monotonic()

                now = time.monotonic()
                if now - last_frame_time > 10:
                    print("[live] stall detected (>10s no frames), restarting arecord", flush=True)
                    break

                if stderr_fd is not None:
                    try:
                        while True:
                            data = os.read(stderr_fd, 4096)
                            if not data:
                                break
                        # drop arecord stderr
                    except BlockingIOError:
                        pass
                    except Exception:
                        pass

        except Exception as e:
            print(f"[live] loop error: {e!r}", flush=True)
        finally:
            try:
                if 'rec' in locals():
                    tap.stop() # stop tapping frames for the web streamer
                    rec.flush(frame_idx) # noqa
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
                reset_usb()
                time.sleep(5)

    print("[live] clean shutdown complete", flush=True)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    main()
