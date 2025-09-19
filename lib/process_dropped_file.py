#!/usr/bin/env python3
import os, sys, subprocess, time
from pathlib import Path
from lib.segmenter import TimelineRecorder, SAMPLE_RATE, FRAME_BYTES

# Safe-ingestion configuration (tunable via env)
STABLE_CHECKS = int(os.getenv("INGEST_STABLE_CHECKS", "2"))
STABLE_INTERVAL_SEC = float(os.getenv("INGEST_STABLE_INTERVAL_SEC", "1.0"))
DROPBOX_DIR = Path(os.getenv("DROPBOX_DIR", "/apps/tricorder/dropbox"))
WORK_DIR = Path(os.getenv("INGEST_WORK_DIR", "/apps/tricorder/tmp/ingest"))
ALLOWED_EXT = set(ext.strip().lower() for ext in os.getenv(
    "INGEST_ALLOWED_EXT",
    ".wav,.opus,.flac,.mp3"
).split(","))  # extensions including leading dot
IGNORE_SUFFIXES = {".part", ".partial", ".tmp", ".incomplete", ".opdownload", ".crdownload"}

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

def _move_to_work(p: Path) -> Path:
    dest = WORK_DIR / p.name
    if dest.exists():
        dest = WORK_DIR / f"{p.stem}.{int(time.time())}{p.suffix}"
    os.replace(p, dest)  # atomic rename within the same filesystem
    return dest

def scan_and_ingest() -> None:
    _prepare_work_area()
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

        try:
            process_file(str(work_file))
        except Exception as e:
            print(f"[ingest] processing failed for {work_file}: {e}", flush=True)
            # Leave the file in WORK_DIR for later inspection/retry
        else:
            try:
                if work_file.exists():
                    work_file.unlink()
            except Exception as e:
                print(f"[ingest] cleanup failed for {work_file}: {e}", flush=True)

def process_file(path):
    print(f"[dropbox] Processing {path}", flush=True)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", path, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)

    rec = TimelineRecorder()
    idx = 0
    try:
        while True:
            buf = p.stdout.read(FRAME_BYTES)
            if not buf:
                break
            if len(buf) != FRAME_BYTES:
                continue
            rec.ingest(buf, idx)
            idx += 1
    finally:
        if p.stdout:
            p.stdout.close()
        p.wait()

    # Ensure finalization of last segment(s)
    rec.flush(idx)
    print(f"[dropbox] Finished processing {path}", flush=True)

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
