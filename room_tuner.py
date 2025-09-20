#!/usr/bin/env python3
"""
room_tuner.py

A console tool to help tune RMS_THRESH for a new room.

Features:
- Live capture from arecord (mono, 16-bit, 48kHz) in 20 ms frames.
- Logs per-interval RMS stats and VAD activity to the console.
- Rolling noise floor estimation from unvoiced frames (95th percentile).
- Suggested RMS_THRESH = noise_floor_p95 * margin (configurable).
- Optional CSV logging of interval stats.
- Adjustable VAD aggressiveness, gain, and reporting interval.

Usage:
  chmod +x ./room_tuner.py
  ./room_tuner.py
  ./room_tuner.py --device "hw:CARD=Device,DEV=0" --aggr 2 --interval 1.0 --csv room_tune.csv

Press Ctrl+C to stop.
"""
import argparse
import os
import signal
import subprocess
import sys
import time
import statistics
from collections import deque
import audioop
import webrtcvad

SAMPLE_RATE = 48000
SAMPLE_WIDTH = 2
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

DEFAULT_AUDIO_DEV = os.environ.get("AUDIO_DEV", "hw:CARD=Device,DEV=0")

def spawn_arecord(audio_dev: str):
    cmd = [
        "arecord",
        "-D", audio_dev,
        "-c", "1",
        "-f", "S16_LE",
        "-r", str(SAMPLE_RATE),
        "--buffer-size", "48000",
        "--period-size", "2400",
        "-t", "raw",
        "-"
    ]
    env = os.environ.copy()
    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        bufsize=0,
        start_new_session=True,
        env=env
    )

def percentile_p95(values):
    if not values:
        return 0.0
    vals = sorted(values)
    k = max(0, min(len(vals) - 1, int(round(0.95 * (len(vals) - 1)))))
    return float(vals[k])

def print_banner(args):
    print("== Tricorder Room Tuner ==", flush=True)
    print(f"Device: {args.device}, VAD aggr: {args.aggr}, interval: {args.interval}s, "
          f"gain: {args.gain}x, margin: {args.margin}x, noise window: {args.noise_window}s", flush=True)
    if args.csv:
        print(f"CSV log: {args.csv}", flush=True)
    print("Suggested RMS_THRESH is updated each interval from unvoiced noise floor (95th pct * margin).", flush=True)
    print("Press Ctrl+C to stop.\n", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Live RMS/VAD monitor to help choose RMS_THRESH.")
    parser.add_argument("--device", default=DEFAULT_AUDIO_DEV, help="ALSA device (e.g., hw:CARD=Device,DEV=0)")
    parser.add_argument("--aggr", type=int, default=3, choices=[0,1,2,3], help="VAD aggressiveness (0..3, higher = more aggressive)")
    parser.add_argument("--interval", type=float, default=1.0, help="Report interval seconds")
    parser.add_argument("--gain", type=float, default=float(os.environ.get("GAIN", 1.0)), help="Software gain multiplier")
    parser.add_argument("--margin", type=float, default=1.2, help="Multiplier on noise-floor p95 to suggest RMS_THRESH")
    parser.add_argument("--noise-window", type=int, default=60, help="Seconds of unvoiced frames to keep for noise-floor estimation")
    parser.add_argument("--duration", type=int, default=0, help="Optional run duration seconds (0 = indefinite)")
    parser.add_argument("--csv", default="", help="Optional CSV file to write per-interval stats")
    args = parser.parse_args()

    print_banner(args)

    # Prepare VAD
    vad = webrtcvad.Vad(args.aggr)

    # CSV setup
    csv_file = None
    if args.csv:
        csv_file = open(args.csv, "a", buffering=1)
        if csv_file.tell() == 0:
            csv_file.write("ts,current_rms,avg_rms,peak_rms,voiced_frames,total_frames,voiced_ratio,noise_p95,suggested_thresh\n")

    # State
    stop = False
    def on_signal(signum, frame):  # noqa
        nonlocal stop
        stop = True
        print("\n[room_tuner] received signal, shutting down...", flush=True)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, on_signal)

    try:
        proc = spawn_arecord(args.device)
    except Exception as e:
        print(f"[room_tuner] failed to start arecord: {e!r}", file=sys.stderr, flush=True)
        return 2

    assert proc.stdout is not None
    stderr_fd = proc.stderr.fileno() if proc.stderr is not None else None
    os.set_blocking(proc.stdout.fileno(), True)
    if stderr_fd is not None:
        try:
            os.set_blocking(stderr_fd, False)
        except Exception:
            pass

    buf = bytearray()
    last_report = time.monotonic()
    start_time = time.monotonic()

    # Interval accumulators
    interval_rms_vals = []
    interval_voiced = 0
    interval_frames = 0
    interval_peak = 0

    # Rolling unvoiced RMS history
    noise_history = deque()  # stores tuples (timestamp, rms)
    max_noise_samples = int(args.noise_window * (1.0 / (FRAME_MS / 1000.0)))  # approx frames per noise_window

    def apply_gain(pcm: bytes) -> bytes:
        if args.gain == 1.0:
            return pcm
        return audioop.mul(pcm, SAMPLE_WIDTH, args.gain)

    while not stop:
        # Read raw bytes
        chunk = proc.stdout.read(4096)
        if not chunk:
            # arecord ended or device issue
            break
        buf.extend(chunk)

        # Drain arecord stderr (ignore content)
        if stderr_fd is not None:
            try:
                while True:
                    err = os.read(stderr_fd, 4096)
                    if not err:
                        break
            except BlockingIOError:
                pass
            except Exception:
                pass

        # Process frames
        while len(buf) >= FRAME_BYTES:
            pcm_frame = bytes(buf[:FRAME_BYTES])
            del buf[:FRAME_BYTES]

            pcm_frame = apply_gain(pcm_frame)
            val_rms = audioop.rms(pcm_frame, SAMPLE_WIDTH)
            try:
                voiced = vad.is_speech(pcm_frame, SAMPLE_RATE)
            except Exception:
                voiced = False  # be defensive if VAD dislikes input

            interval_rms_vals.append(val_rms)
            interval_frames += 1
            if voiced:
                interval_voiced += 1
            if val_rms > interval_peak:
                interval_peak = val_rms

            # Collect noise history only from unvoiced frames to estimate noise floor
            if not voiced:
                noise_history.append((time.monotonic(), val_rms))
                if len(noise_history) > max_noise_samples:
                    noise_history.popleft()

        # Report on interval
        now = time.monotonic()
        if now - last_report >= args.interval:
            last_report = now
            ts = time.strftime("%H:%M:%S")
            current_rms = interval_rms_vals[-1] if interval_rms_vals else 0
            avg_rms = int(statistics.mean(interval_rms_vals)) if interval_rms_vals else 0
            peak_rms = interval_peak
            voiced_ratio = (interval_voiced / interval_frames) if interval_frames else 0.0

            # Compute noise floor p95 over noise_window seconds
            noise_vals = [r for (_, r) in noise_history]
            noise_p95 = int(percentile_p95(noise_vals)) if noise_vals else 0
            suggested_thresh = int(noise_p95 * args.margin)

            # ASCII bar for quick glance (scaled)
            def bar(val, scale=4000, width=40):
                lvl = min(width, int((val / float(scale)) * width)) if scale > 0 else 0
                return "#" * lvl + "-" * (width - lvl)

            print(
                f"[{ts}] RMS cur={current_rms:4d} avg={avg_rms:4d} peak={peak_rms:4d}  "
                f"VAD voiced={voiced_ratio*100:5.1f}%  "
                f"noise_p95={noise_p95:4d}  suggest_RMS_THRESH={suggested_thresh:4d}\n"
                f"      {bar(current_rms)}",
                flush=True
            )

            if csv_file:
                csv_file.write(f"{int(time.time())},{current_rms},{avg_rms},{peak_rms},"
                               f"{interval_voiced},{interval_frames},{voiced_ratio:.3f},"
                               f"{noise_p95},{suggested_thresh}\n")

            # reset interval accumulators
            interval_rms_vals.clear()
            interval_voiced = 0
            interval_frames = 0
            interval_peak = 0

        # Duration stop
        if args.duration and (time.monotonic() - start_time) >= args.duration:
            stop = True

    # Cleanup
    try:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        if proc and proc.stdout:
            proc.stdout.close()
        if proc and proc.stderr:
            proc.stderr.close()
    except Exception:
        pass

    if csv_file:
        csv_file.close()

    return 0

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    sys.exit(main())
