#!/usr/bin/env python3
import os
import time
import subprocess
import sys
import signal
from lib.segmenter import TimelineRecorder
from lib.config import get_cfg
from lib.fault_handler import reset_usb

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
ffmpeg_proc = None


def handle_signal(signum, frame):  # noqa
    """Handle SIGINT/SIGTERM for graceful shutdown."""
    global stop_requested, p, ffmpeg_proc
    print(f"[live] received signal {signum}, shutting down...", flush=True)
    stop_requested = True

    # Stop arecord
    if p is not None and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass

    # Stop ffmpeg sidecar
    if ffmpeg_proc is not None and ffmpeg_proc.poll() is None:
        try:
            if ffmpeg_proc.stdin:
                ffmpeg_proc.stdin.close()
        except Exception:
            pass
        try:
            ffmpeg_proc.terminate()
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
        env=env,
    )


def spawn_ffmpeg_opus(out_path: str):
    """
    Sidecar encoder: raw S16LE mono 48k PCM -> Opus-in-Ogg rolling file.
    Keeps CPU low (libopus @ 32 kbps). If the process dies, we restart it.
    """
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",

        # Input: raw PCM from stdin
        "-f", "s16le",
        "-ar", str(SAMPLE_RATE),
        "-ac", "1",
        "-i", "pipe:0",

        # Encoder
        "-c:a", "libopus",
        "-b:a", "32k",

        # Ogg container, tuned for streaming
        "-f", "ogg",
        "-flush_packets", "1",   # flush each packet
        "-fflags", "+genpts",    # generate pts
        "-max_delay", "0",       # no muxer buffering
        "-rtbufsize", "0",       # no internal buffering

        out_path,
    ]
    env = os.environ.copy()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    print(f"[live] starting ffmpeg encoder -> {out_path}", flush=True)
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        bufsize=0,
        start_new_session=True,
        env=env,
    )


def supervise_ffmpeg(ogg_path: str):
    """Ensure ffmpeg sidecar is running; restart if it died."""
    global ffmpeg_proc
    if ffmpeg_proc is None or ffmpeg_proc.poll() is not None:
        if ffmpeg_proc is not None:
            code = ffmpeg_proc.returncode
            print(f"[live] ffmpeg encoder exited (code={code})", flush=True)
            try:
                if ffmpeg_proc.stderr:
                    errout = ffmpeg_proc.stderr.read().decode(errors="ignore").strip()
                    if errout:
                        print(f"[ffmpeg] {errout}", flush=True)
            except Exception:
                pass
        ffmpeg_proc = spawn_ffmpeg_opus(ogg_path)
        time.sleep(0.2)  # small delay to let ffmpeg settle


def main():
    global p, stop_requested, ffmpeg_proc
    stop_requested = False  # reset on each new run
    print(f"[live] starting with device={AUDIO_DEV}", flush=True)

    ogg_path = os.path.join(cfg["paths"]["tmp_dir"], "web_stream.ogg")
    supervise_ffmpeg(ogg_path)

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
                # Keep ffmpeg supervised
                supervise_ffmpeg(ogg_path)

                chunk = p.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break
                buf.extend(chunk)

                while len(buf) >= FRAME_BYTES:
                    frame = bytes(buf[:FRAME_BYTES])

                    # Tee frame to ffmpeg (best-effort)
                    try:
                        if ffmpeg_proc and ffmpeg_proc.poll() is None and ffmpeg_proc.stdin:
                            ffmpeg_proc.stdin.write(frame)
                    except Exception as e:
                        print(f"[live] ffmpeg write error: {e!r}", flush=True)

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
                        # discard arecord stderr
                    except BlockingIOError:
                        pass
                    except Exception:
                        pass

        except Exception as e:
            print(f"[live] loop error: {e!r}", flush=True)
        finally:
            try:
                if 'rec' in locals():
                    rec.flush(frame_idx)  # noqa
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

    # Cleanup ffmpeg at end
    try:
        if ffmpeg_proc and ffmpeg_proc.poll() is None:
            if ffmpeg_proc.stdin:
                ffmpeg_proc.stdin.close()
            ffmpeg_proc.terminate()
            print("[live] ffmpeg encoder terminated", flush=True)
    except Exception:
        pass

    print("[live] clean shutdown complete", flush=True)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    main()
