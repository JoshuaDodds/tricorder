#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path

from lib.segmenter import (
    ENCODING_STATUS,
    FRAME_BYTES,
    RecorderIngestHint,
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
REC_DIR = Path(cfg["paths"]["recordings_dir"])
ALLOWED_EXT = set(x.lower() for x in cfg["ingest"]["allowed_ext"])
IGNORE_SUFFIXES = set(cfg["ingest"]["ignore_suffixes"])
RETRY_SUFFIX = "-RETRY"
OUTPUT_SUFFIXES = (".opus",)

TIMESTAMP_TOKEN_RE = re.compile(r"^\d{2}-\d{2}-\d{2}$")
COUNTER_TOKEN_RE = re.compile(r"^\d+$")


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
        try:
            _cleanup_retry_artifacts(work_file)
        except Exception as exc:  # noqa: BLE001 - log and continue
            print(f"[ingest] retry cleanup failed for {work_file}: {exc}", flush=True)
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


def _iter_existing_recordings(base_name: str):
    if not base_name or not REC_DIR.exists():
        return
    try:
        day_dirs = sorted(p for p in REC_DIR.iterdir() if p.is_dir())
    except FileNotFoundError:
        return
    for day_dir in day_dirs:
        for suffix in OUTPUT_SUFFIXES:
            candidate = day_dir / f"{base_name}{suffix}"
            if candidate.exists():
                yield candidate


def _read_waveform_duration(waveform_path: Path) -> float | None:
    try:
        with waveform_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    raw = payload.get("duration_seconds") if isinstance(payload, dict) else None
    if isinstance(raw, (int, float)) and raw > 0:
        return float(raw)
    return None


def _probe_audio_duration(path: Path) -> float | None:
    if not path.exists():
        return None
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=5.0)
    except (OSError, subprocess.SubprocessError):
        return None
    duration_text = (result.stdout or "").strip()
    if not duration_text:
        return None
    try:
        duration = float(duration_text)
    except ValueError:
        return None
    if duration <= 0:
        return None
    return duration


def _duration_mismatch(expected: float, actual: float) -> bool:
    diff = abs(expected - actual)
    tolerance = max(0.5, expected * 0.1, actual * 0.1)
    return diff > tolerance


def _write_placeholder(day_dir: Path, base_name: str, reason: str, extra: dict | None = None) -> Path:
    day_dir.mkdir(parents=True, exist_ok=True)
    target = day_dir / f"{base_name}-CORRUPTED_RECORDING.json"
    payload = {
        "status": "corrupted",
        "base_name": base_name,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reason": reason,
        "detected_by": "ingest-retry-scan",
    }
    if extra:
        payload.update(extra)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp, target)
    return target


def _quarantine_recording(
    audio_path: Path,
    *,
    reason: str,
    waveform_duration: float | None,
    audio_duration: float | None,
) -> None:
    base_name = audio_path.stem
    day_dir = audio_path.parent
    extras: dict[str, object] = {
        "action": "removed-before-retry",
    }
    if waveform_duration is not None:
        extras["waveform_duration_seconds"] = waveform_duration
    if audio_duration is not None:
        extras["audio_duration_seconds"] = audio_duration
    if waveform_duration is not None and audio_duration is not None:
        extras["duration_diff_seconds"] = waveform_duration - audio_duration

    related = [audio_path]
    waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
    transcript_path = audio_path.with_suffix(audio_path.suffix + ".transcript.json")
    related.append(waveform_path)
    related.append(transcript_path)

    for candidate in related:
        try:
            candidate.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001 - log and continue
            print(f"[ingest] failed to remove {candidate}: {exc}", flush=True)

    placeholder = _write_placeholder(day_dir, base_name, reason, extras)
    print(
        (
            f"[ingest] quarantined {audio_path} (reason={reason}, "
            f"waveform={waveform_duration}, audio={audio_duration}) -> {placeholder.name}"
        ),
        flush=True,
    )


def _cleanup_retry_artifacts(work_file: Path) -> None:
    stem = work_file.stem
    if not stem.endswith(RETRY_SUFFIX):
        return
    base_name = stem[: -len(RETRY_SUFFIX)]
    if not base_name:
        return
    for audio_path in _iter_existing_recordings(base_name):
        waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
        waveform_duration = _read_waveform_duration(waveform_path)
        if waveform_duration is None:
            _quarantine_recording(
                audio_path,
                reason="missing-waveform",
                waveform_duration=None,
                audio_duration=None,
            )
            continue
        audio_duration = _probe_audio_duration(audio_path)
        if audio_duration is None:
            continue
        if _duration_mismatch(waveform_duration, audio_duration):
            _quarantine_recording(
                audio_path,
                reason="duration-mismatch",
                waveform_duration=waveform_duration,
                audio_duration=audio_duration,
            )


def _move_to_work(p: Path) -> Path:
    dest = WORK_DIR / p.name
    if dest.exists():
        dest = WORK_DIR / f"{p.stem}.{int(time.time())}{p.suffix}"
    os.replace(p, dest)  # atomic rename within the same filesystem
    return dest


def _extract_ingest_hint(path: Path) -> RecorderIngestHint | None:
    base = path.stem
    if not base:
        return None

    normalized = base
    lower = normalized.lower()
    retry_suffix = RETRY_SUFFIX.lower()
    if lower.endswith(retry_suffix):
        normalized = normalized[: -len(RETRY_SUFFIX)]

    tokens = [token for token in normalized.split("_") if token]
    timestamp = next((tok for tok in tokens if TIMESTAMP_TOKEN_RE.fullmatch(tok)), None)
    if not timestamp:
        return None

    counter: int | None = None
    for token in reversed(tokens):
        if COUNTER_TOKEN_RE.fullmatch(token):
            counter = int(token)
            break

    return RecorderIngestHint(timestamp=timestamp, event_counter=counter)

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

    ingest_hint = _extract_ingest_hint(path_obj)
    rec = TimelineRecorder(ingest_hint=ingest_hint)
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
