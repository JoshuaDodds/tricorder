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
import json
import os
import signal
import statistics
import subprocess
import sys
import time
from collections import deque
from typing import Any, Sequence

import audioop
import webrtcvad

from copy import deepcopy

from lib.config import (
    ConfigPersistenceError,
    get_cfg,
    update_audio_settings,
)
from lib.fault_handler import reset_usb   # 🔧 added
from lib.noise_analyzer import (
    analyze_idle_noise,
    recommend_notch_filters,
    summarize_peaks,
)

cfg = get_cfg()
SAMPLE_RATE = int(cfg["audio"]["sample_rate"])
SAMPLE_WIDTH = 2
FRAME_MS = int(cfg["audio"]["frame_ms"])
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

DEFAULT_AUDIO_DEV = os.environ.get("AUDIO_DEV", cfg["audio"]["device"])


def _clone_filter_chain(existing: Any) -> dict[str, Any]:
    if isinstance(existing, dict):
        return deepcopy(existing)
    if isinstance(existing, Sequence) and not isinstance(existing, (str, bytes)):
        cloned = [deepcopy(entry) for entry in existing if isinstance(entry, dict)]
        return {"filters": cloned}
    return {}


def _filter_slot_capacity(chain_cfg: dict[str, Any]) -> int:
    filters = chain_cfg.get("filters")
    extra_filters = 0
    if isinstance(filters, Sequence) and not isinstance(filters, (str, bytes)):
        extra_filters = sum(1 for entry in filters if isinstance(entry, dict))

    notch_stage = chain_cfg.get("notch")
    base_slots = 1 if isinstance(notch_stage, dict) else 0

    total_slots = base_slots + extra_filters
    if total_slots <= 0:
        return 1
    return total_slots


def _apply_notch_filters(
    existing: Any,
    recommendations: Sequence[dict[str, Any]],
    keep_count: int,
) -> dict[str, Any]:
    chain_cfg = _clone_filter_chain(existing)
    limit = max(0, keep_count)
    trimmed = [
        deepcopy(entry)
        for entry in list(recommendations)[:limit]
        if isinstance(entry, dict)
    ]

    if not trimmed:
        chain_cfg.pop("filters", None)
        notch_stage = chain_cfg.get("notch")
        if isinstance(notch_stage, dict):
            notch_stage["enabled"] = False
        return chain_cfg

    primary = trimmed[0]
    notch_stage = chain_cfg.setdefault("notch", {})
    notch_stage["enabled"] = True

    freq = primary.get("frequency")
    if freq is None:
        freq = primary.get("freq_hz")
    if freq is not None:
        try:
            notch_stage["freq_hz"] = float(freq)
        except (TypeError, ValueError):
            pass

    quality = primary.get("q")
    if quality is None:
        quality = primary.get("quality")
    if quality is not None:
        try:
            notch_stage["quality"] = float(quality)
        except (TypeError, ValueError):
            pass

    extras = [deepcopy(entry) for entry in trimmed[1:]]
    if extras:
        chain_cfg["filters"] = extras
    else:
        chain_cfg.pop("filters", None)

    return chain_cfg


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


def _drain_fd(fd: int | None) -> None:
    if fd is None:
        return
    while True:
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
        except BlockingIOError:
            break
        except Exception:
            break


def capture_idle_audio(proc, seconds: float, stderr_fd: int | None) -> bytes:
    if seconds <= 0:
        return b""
    target_bytes = int(seconds * SAMPLE_RATE * SAMPLE_WIDTH)
    captured = bytearray()
    deadline = time.monotonic() + max(seconds * 1.5, 1.0)
    while len(captured) < target_bytes:
        remaining = target_bytes - len(captured)
        chunk = proc.stdout.read(min(4096, remaining))
        if chunk:
            captured.extend(chunk)
        else:
            time.sleep(0.05)
        _drain_fd(stderr_fd)
        if time.monotonic() >= deadline:
            break
    return bytes(captured)


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
    parser.add_argument("--aggr", type=int, default=int(cfg["audio"]["vad_aggressiveness"]), choices=[0,1,2,3], help="VAD aggressiveness (0..3, higher = more aggressive)")
    parser.add_argument("--interval", type=float, default=1.0, help="Report interval seconds")
    parser.add_argument("--gain", type=float, default=float(os.environ.get("GAIN", cfg["audio"]["gain"])), help="Software gain multiplier")
    parser.add_argument("--margin", type=float, default=1.2, help="Multiplier on noise-floor p95 to suggest RMS_THRESH")
    parser.add_argument("--noise-window", type=int, default=60, help="Seconds of unvoiced frames to keep for noise-floor estimation")
    parser.add_argument("--duration", type=int, default=0, help="Optional run duration seconds (0 = indefinite)")
    parser.add_argument("--csv", default="", help="Optional CSV file to write per-interval stats")
    parser.add_argument("--analyze-noise", action="store_true", help="Capture idle audio and summarize hum components before monitoring")
    parser.add_argument("--analyze-duration", type=float, default=10.0, help="Seconds of idle audio to capture when analyzing noise")
    parser.add_argument("--analyze-top", type=int, default=3, help="Number of dominant hum peaks to report")
    parser.add_argument("--auto-filter", choices=["print", "update"], nargs="?", const="print", help="Recommend or persist audio.filter_chain notch filters (implies --analyze-noise)")
    parser.add_argument("--max-filters", type=int, default=None, help="Maximum notch filters to include when recommending updates (defaults to the current configuration capacity)")
    parser.add_argument("--dry-run", action="store_true", help="With --auto-filter update, show changes without writing config")
    args = parser.parse_args()

    print_banner(args)

    if args.auto_filter and not args.analyze_noise:
        args.analyze_noise = True

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

    # Start arecord (with USB reset retry)
    try:
        proc = spawn_arecord(args.device)
    except Exception as e:
        print(f"[room_tuner] failed to start arecord: {e!r}", file=sys.stderr, flush=True)
        print("[room_tuner] attempting USB reset...", flush=True)
        reset_usb()
        time.sleep(2)
        try:
            proc = spawn_arecord(args.device)
        except Exception as e2:
            print(f"[room_tuner] retry failed: {e2!r}", file=sys.stderr, flush=True)
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

    if args.analyze_noise:
        capture_seconds = max(args.analyze_duration, FRAME_MS / 1000.0)
        print(f"[room_tuner] Capturing {capture_seconds:.1f}s of idle audio for hum analysis...", flush=True)
        analysis_pcm = capture_idle_audio(proc, capture_seconds, stderr_fd)
        if analysis_pcm:
            buf.extend(analysis_pcm)
            peaks = analyze_idle_noise(
                analysis_pcm,
                SAMPLE_RATE,
                top_n=max(1, args.analyze_top),
                min_freq_hz=30.0,
                max_freq_hz=SAMPLE_RATE / 2.0,
            )
            summary = summarize_peaks(peaks)
            actual_sec = len(analysis_pcm) / (SAMPLE_RATE * SAMPLE_WIDTH)
            print(
                f"[room_tuner] Idle analysis ({actual_sec:.2f}s captured): {summary}",
                flush=True,
            )
            if args.auto_filter:
                existing_chain = cfg.get("audio", {}).get("filter_chain")
                cloned_chain = _clone_filter_chain(existing_chain)
                configured_slots = _filter_slot_capacity(cloned_chain)
                analyze_slots = max(1, args.analyze_top)

                if args.max_filters is not None:
                    requested_slots = max(1, int(args.max_filters))
                    if requested_slots > configured_slots:
                        slot_label = "slot" if requested_slots == 1 else "slots"
                        print(
                            f"[room_tuner] Expanding notch filter recommendations to {requested_slots} {slot_label}; extra slots will be written to audio.filter_chain.filters.",
                            flush=True,
                        )
                    limit = min(analyze_slots, requested_slots)
                else:
                    limit = min(analyze_slots, configured_slots)
                    if analyze_slots > configured_slots:
                        slot_label = "slot" if configured_slots == 1 else "slots"
                        print(
                            f"[room_tuner] Limiting notch filter recommendations to {configured_slots} {slot_label} based on current configuration. Use --max-filters to override.",
                            flush=True,
                        )

                filters = recommend_notch_filters(peaks, max_filters=max(1, limit))
                if not filters:
                    print("[room_tuner] No notch filters recommended.", flush=True)
                else:
                    updated_chain = _apply_notch_filters(existing_chain, filters, keep_count=max(1, limit))
                    payload = {"filter_chain": updated_chain}
                    print("[room_tuner] Recommended audio.filter_chain:", flush=True)
                    print(json.dumps(payload, indent=2), flush=True)
                    if args.auto_filter == "update":
                        if args.dry_run:
                            print("[room_tuner] Dry-run: configuration not modified.", flush=True)
                        else:
                            try:
                                update_audio_settings(payload)
                                print("[room_tuner] Updated configuration with recommended filters.", flush=True)
                            except ConfigPersistenceError as exc:
                                print(
                                    f"[room_tuner] Failed to update configuration: {exc}",
                                    file=sys.stderr,
                                    flush=True,
                                )
        else:
            print("[room_tuner] Unable to capture idle audio for analysis.", flush=True)

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
            print("[room_tuner] arecord ended or device unavailable; attempting USB reset", flush=True)
            reset_usb()
            time.sleep(2)
            try:
                proc = spawn_arecord(args.device)
                buf.clear()
                continue
            except Exception as e:
                print(f"[room_tuner] failed to restart arecord after USB reset: {e!r}", file=sys.stderr, flush=True)
                break
        buf.extend(chunk)

        # Drain arecord stderr (ignore content)
        _drain_fd(stderr_fd)

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

            # ASCII bar for quick glance
            def bar(val, scale=4000, width=20):
                lvl = min(width, int((val / float(scale)) * width)) if scale > 0 else 0
                return "#" * lvl + "-" * (width - lvl)

            print(
                f"[{ts}] RMS cur={current_rms:4d} avg={avg_rms:4d} peak={peak_rms:4d}  "
                f"VAD voiced={voiced_ratio*100:5.1f}%  "
                f"noise_p95={noise_p95:4d}  suggest_RMS_THRESH={suggested_thresh:4d}  |  {bar(current_rms)}",
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
