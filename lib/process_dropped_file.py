#!/usr/bin/env python3
import os, sys, subprocess
from segmenter import TimelineRecorder, SAMPLE_RATE, FRAME_BYTES


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
    rec.write_output()
    print(f"[dropbox] Finished processing {path}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: process_dropped_file.py <audiofile>", file=sys.stderr)
        sys.exit(2)

    target = sys.argv[1]
    process_file(target)

    # cleanup original file after successful processing
    try:
        os.remove(target)
        print(f"[dropbox] Deleted original {target}", flush=True)
    except FileNotFoundError:
        print(f"[dropbox] Skipped deletion (not found): {target}", flush=True)
