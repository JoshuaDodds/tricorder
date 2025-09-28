#!/usr/bin/env python3
import os
import subprocess
import sys
import time
import wave
from contextlib import contextmanager
from pathlib import Path

from lib.segmenter import (
    ENCODING_STATUS,
    FRAME_BYTES,
    SAMPLE_RATE,
    SAMPLE_WIDTH,
    TimelineRecorder,
)
from lib.config import get_cfg

cfg = get_cfg()

STABLE_CHECKS = int(cfg["ingest"]["stable_checks"])
STABLE_INTERVAL_SEC = float(cfg["ingest"]["stable_interval_sec"])
DROPBOX_DIR = Path(cfg["paths"]["dropbox_dir"])
WORK_DIR = Path(cfg["paths"]["ingest_work_dir"])
ALLOWED_EXT = set(x.lower() for x in cfg["ingest"]["allowed_ext"])
IGNORE_SUFFIXES = set(cfg["ingest"]["ignore_suffixes"])


def _should_lower_priority() -> bool:
    try:
        snapshot = ENCODING_STATUS.snapshot()
    except Exception:
        return False
    if not snapshot:
        return False
    active = snapshot.get("active")
    return bool(active)


def _set_single_core_affinity() -> None:
    try:
        if hasattr(os, "sched_getaffinity"):
            try:
                available = os.sched_getaffinity(0)
            except OSError:
                available = None
        else:
            available = None
        target_cpu = 0
        if available:
            try:
                target_cpu = min(int(cpu) for cpu in available)
            except (TypeError, ValueError):
                target_cpu = 0
        if hasattr(os, "sched_setaffinity"):
            os.sched_setaffinity(0, {int(target_cpu)})
    except (AttributeError, OSError, ValueError):
        pass


def _ffmpeg_preexec(lower_priority: bool):
    def _apply():
        if lower_priority:
            try:
                os.nice(5)
            except OSError:
                pass
        _set_single_core_affinity()

    return _apply


@contextmanager
def _pcm_source(path: Path):
    lower_priority = _should_lower_priority()
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-i",
        str(path),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
    ]
    try:
        if lower_priority:
            print("[dropbox] Detected active encoder; lowering ffmpeg priority", flush=True)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            preexec_fn=_ffmpeg_preexec(lower_priority),
        )
    except FileNotFoundError:
        if path.suffix.lower() != ".wav":
            raise
        with wave.open(str(path), "rb") as wav_file:
            if (
                wav_file.getnchannels() != 1
                or wav_file.getsampwidth() != SAMPLE_WIDTH
                or wav_file.getframerate() != SAMPLE_RATE
            ):
                raise RuntimeError(
                    "ffmpeg not found and WAV fallback requires 16-bit mono "
                    f"audio at {SAMPLE_RATE} Hz ({path})"
                )

            frames_per_chunk = FRAME_BYTES // SAMPLE_WIDTH

            def wav_iter():
                while True:
                    data = wav_file.readframes(frames_per_chunk)
                    if not data:
                        break
                    yield data

            yield wav_iter()
            return
    else:
        try:
            stdout = proc.stdout
            if stdout is None:
                raise RuntimeError("ffmpeg stdout pipe unavailable")

            def proc_iter():
                while True:
                    data = stdout.read(FRAME_BYTES)
                    if not data:
                        break
                    yield data

            yield proc_iter()
        finally:
            if proc.stdout:
                proc.stdout.close()
            proc.wait()

def _is_candidate(p: Path) -> bool:
    if not p.is_file():
        return False
    name = p.name
    if name.startswith("."):
        return False
    low = name.lower()
    if any(low.endswith(suf) for suf in IGNORE_SUFFIXES):
        return False
    if p.suffix.lower() not in ALLOWED_EXT:
        return False
    return True

def _is_stable(p: Path) -> bool:
    try:
        prev = p.stat().st_size
    except FileNotFoundError:
        return False
    for _ in range(STABLE_CHECKS):
        time.sleep(STABLE_INTERVAL_SEC)
        try:
            cur = p.stat().st_size
        except FileNotFoundError:
            return False
        if cur != prev:
            return False
        prev = cur
    return True

def _prepare_work_area() -> None:
    WORK_DIR.mkdir(parents=True, exist_ok=True)


def _handle_work_file(work_file: Path) -> None:
    try:
        process_file(str(work_file))
    except Exception as e:
        print(f"[ingest] processing failed for {work_file}: {e}", flush=True)
    else:
        try:
            if work_file.exists():
                work_file.unlink()
        except Exception as e:
            print(f"[ingest] cleanup failed for {work_file}: {e}", flush=True)


def _retry_stalled_work_files() -> None:
    if not WORK_DIR.exists():
        return
    for work_file in sorted(WORK_DIR.iterdir()):
        if not _is_candidate(work_file):
            continue
        print(f"[ingest] retrying stalled work item {work_file}", flush=True)
        _handle_work_file(work_file)


def _move_to_work(p: Path) -> Path:
    dest = WORK_DIR / p.name
    if dest.exists():
        dest = WORK_DIR / f"{p.stem}.{int(time.time())}{p.suffix}"
    os.replace(p, dest)  # atomic rename within the same filesystem
    return dest

def scan_and_ingest() -> None:
    _prepare_work_area()
    _retry_stalled_work_files()
    if not DROPBOX_DIR.exists():
        print(f"[ingest] DROPBOX_DIR does not exist: {DROPBOX_DIR}", flush=True)
        return
    for p in sorted(DROPBOX_DIR.iterdir()):
        if not _is_candidate(p):
            continue
        if not _is_stable(p):
            # Skip unstable/partial files; the next run will pick them up
            continue
        try:
            work_file = _move_to_work(p)
        except FileNotFoundError:
            # Source disappeared during the move; likely still being written. Skip.
            continue
        except OSError as e:
            print(f"[ingest] move failed for {p}: {e}", flush=True)
            continue

        _handle_work_file(work_file)

def process_file(path):
    path_obj = Path(path)
    print(f"[dropbox] Processing {path_obj}", flush=True)

    rec = TimelineRecorder()
    idx = 0

    with _pcm_source(path_obj) as stream:
        for buf in stream:
            if not buf:
                break
            if len(buf) != FRAME_BYTES:
                continue
            rec.ingest(buf, idx)
            idx += 1

    # Ensure finalization of last segment(s)
    rec.flush(idx)
    print(f"[dropbox] Finished processing {path_obj}", flush=True)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Ingest dropped audio files safely or process a single file.")
    parser.add_argument("--scan", action="store_true", help="Scan DROPBOX_DIR for stable files and ingest them safely")
    parser.add_argument("file", nargs="?", help="Single audio file to process (legacy mode)")
    args = parser.parse_args()

    if args.scan:
        scan_and_ingest()
        sys.exit(0)

    if not args.file:
        print("usage: process_dropped_file.py <audiofile>  or  process_dropped_file.py --scan", file=sys.stderr)
        sys.exit(2)

    target = args.file
    process_file(target)

    # clean up the original file after successful processing (legacy single-file mode)
    try:
        os.remove(target)
        print(f"[dropbox] Deleted original {target}", flush=True)
    except FileNotFoundError:
        print(f"[dropbox] Skipped deletion (not found): {target}", flush=True)
