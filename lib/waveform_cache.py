"""Utilities to precompute waveform peaks for fast dashboard rendering."""

from __future__ import annotations

import argparse
import audioop
import contextlib
import json
import math
import os
import subprocess
import tempfile
from array import array
from pathlib import Path
from typing import Any, Iterable, Sequence
import wave

DEFAULT_BUCKET_COUNT = 2048
MAX_BUCKET_COUNT = 8192
PEAK_SCALE = 32767
DEFAULT_BACKFILL_EXTENSIONS: tuple[str, ...] = (".opus", ".ogg", ".flac", ".mp3")


def _clamp_int16(value: int) -> int:
    return max(-32768, min(32767, value))


def _ensure_bucket_count(total_frames: int, requested: int) -> int:
    if total_frames <= 0:
        return 0
    if requested <= 0:
        requested = DEFAULT_BUCKET_COUNT
    return max(1, min(int(requested), MAX_BUCKET_COUNT, total_frames))


def _write_payload(destination: Path, payload: dict[str, Any]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = destination.with_suffix(destination.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, destination)


def _normalize_extensions(exts: Iterable[str]) -> tuple[str, ...]:
    normalized: list[str] = []
    for ext in exts:
        if not ext:
            continue
        ext_lower = ext.lower()
        if not ext_lower.startswith("."):
            ext_lower = f".{ext_lower}"
        normalized.append(ext_lower)
    # Preserve order while removing duplicates
    seen: set[str] = set()
    result: list[str] = []
    for ext in normalized:
        if ext not in seen:
            seen.add(ext)
            result.append(ext)
    return tuple(result)


def _decode_audio_to_wav(source: Path) -> Path:
    tmp_file = tempfile.NamedTemporaryFile(prefix="waveform_", suffix=".wav", delete=False)
    tmp_file.close()
    tmp_path = Path(tmp_file.name)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-acodec",
        "pcm_s16le",
        str(tmp_path),
    ]
    try:
        subprocess.run(cmd, check=True)
    except (subprocess.SubprocessError, FileNotFoundError) as exc:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise RuntimeError(f"ffmpeg failed while decoding {source}") from exc
    return tmp_path


def ensure_waveform_sidecar(
    source_audio: os.PathLike[str] | str,
    waveform_destination: os.PathLike[str] | str,
    *,
    bucket_count: int = DEFAULT_BUCKET_COUNT,
) -> bool:
    """Ensure a waveform sidecar exists for the provided audio file.

    Returns True if a waveform was generated, False if it already existed.
    """

    source_path = Path(source_audio)
    waveform_path = Path(waveform_destination)

    try:
        existing = waveform_path.stat()
    except FileNotFoundError:
        needs_waveform = True
    except OSError:
        needs_waveform = True
    else:
        needs_waveform = existing.st_size <= 0

    if not needs_waveform:
        return False

    suffix = source_path.suffix.lower()
    if suffix == ".wav":
        generate_waveform(source_path, waveform_path, bucket_count=bucket_count)
        return True

    tmp_wav: Path | None = None
    try:
        tmp_wav = _decode_audio_to_wav(source_path)
        generate_waveform(tmp_wav, waveform_path, bucket_count=bucket_count)
    finally:
        if tmp_wav is not None:
            try:
                tmp_wav.unlink(missing_ok=True)
            except Exception:
                pass
    return True


def backfill_missing_waveforms(
    recordings_root: os.PathLike[str] | str,
    *,
    bucket_count: int = DEFAULT_BUCKET_COUNT,
    allowed_extensions: Sequence[str] | None = None,
    strict: bool = False,
) -> list[Path]:
    """Generate waveform sidecars for any recordings that are missing them."""

    root = Path(recordings_root)
    if not root.exists():
        return []

    base_exts: Sequence[str]
    if not allowed_extensions:
        base_exts = DEFAULT_BACKFILL_EXTENSIONS
    else:
        base_exts = allowed_extensions

    allowed = set(_normalize_extensions(base_exts))
    allowed.add(".wav")

    generated: list[Path] = []

    for audio_path in sorted(root.rglob("*")):
        if not audio_path.is_file():
            continue

        suffix = audio_path.suffix.lower()
        if allowed and suffix not in allowed:
            continue

        waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")

        try:
            needs_waveform = waveform_path.stat().st_size <= 0
        except FileNotFoundError:
            needs_waveform = True
        except OSError:
            needs_waveform = True

        if not needs_waveform:
            continue

        try:
            created = ensure_waveform_sidecar(
                audio_path,
                waveform_path,
                bucket_count=bucket_count,
            )
        except Exception as exc:  # noqa: BLE001 - log and continue unless strict
            print(f"[waveform] failed to backfill {audio_path}: {exc!r}", flush=True)
            if strict:
                raise
            continue

        if created:
            generated.append(waveform_path)

    return generated


def generate_waveform(
    source: os.PathLike[str] | str,
    destination: os.PathLike[str] | str,
    bucket_count: int = DEFAULT_BUCKET_COUNT,
) -> dict[str, Any]:
    """Generate waveform peaks from a PCM WAV file and store them as JSON."""

    source_path = Path(source)
    dest_path = Path(destination)

    with contextlib.closing(wave.open(str(source_path), "rb")) as wav_file:
        channels = max(1, wav_file.getnchannels() or 1)
        sample_width = wav_file.getsampwidth() or 2
        sample_rate = wav_file.getframerate() or 0
        total_frames = wav_file.getnframes() or 0

        bucket_count = _ensure_bucket_count(total_frames, bucket_count)

        if total_frames <= 0 or sample_rate <= 0 or bucket_count <= 0:
            payload = {
                "version": 1,
                "channels": channels,
                "sample_rate": sample_rate,
                "frame_count": total_frames,
                "duration_seconds": 0.0,
                "peak_scale": PEAK_SCALE,
                "peaks": [],
                "rms_values": [],
            }
            _write_payload(dest_path, payload)
            return payload

        peaks = array("h", [0] * (bucket_count * 2))
        rms_values = array("H", [0] * bucket_count)
        frames_per_bucket = total_frames / float(bucket_count)
        chunk_frames = max(1, min(65536, int(math.ceil(frames_per_bucket * 8))))

        frames_consumed = 0
        bucket_index = 0
        bucket_min = 32767
        bucket_max = -32768
        bucket_square_sum = 0.0
        bucket_sample_count = 0
        next_threshold = int(math.ceil(frames_per_bucket))

        while frames_consumed < total_frames and bucket_index < bucket_count:
            frames_to_read = min(chunk_frames, total_frames - frames_consumed)
            raw = wav_file.readframes(frames_to_read)
            if not raw:
                break

            if sample_width != 2:
                raw = audioop.lin2lin(raw, sample_width, 2)

            samples = array("h")
            samples.frombytes(raw)
            frame_count = len(samples) // channels
            if frame_count == 0:
                break

            for frame_idx in range(frame_count):
                start = frame_idx * channels
                end = start + channels
                sample_sum = 0
                for sample in samples[start:end]:
                    sample_sum += sample
                value = int(round(sample_sum / channels))
                if value < bucket_min:
                    bucket_min = value
                if value > bucket_max:
                    bucket_max = value

                bucket_square_sum += float(value) * float(value)
                bucket_sample_count += 1

                frames_consumed += 1
                if frames_consumed >= total_frames or frames_consumed >= next_threshold:
                    if bucket_min > bucket_max:
                        bucket_min = 0
                        bucket_max = 0
                    peaks[bucket_index * 2] = _clamp_int16(bucket_min)
                    peaks[bucket_index * 2 + 1] = _clamp_int16(bucket_max)
                    if bucket_sample_count > 0:
                        rms = int(round(math.sqrt(bucket_square_sum / bucket_sample_count)))
                    else:
                        rms = 0
                    rms_values[bucket_index] = max(0, min(rms, PEAK_SCALE))
                    bucket_index += 1
                    if bucket_index >= bucket_count:
                        break
                    bucket_min = 32767
                    bucket_max = -32768
                    bucket_square_sum = 0.0
                    bucket_sample_count = 0
                    next_threshold = int(math.ceil((bucket_index + 1) * frames_per_bucket))

            if bucket_index >= bucket_count:
                break

        while bucket_index < bucket_count:
            peaks[bucket_index * 2] = 0
            peaks[bucket_index * 2 + 1] = 0
            rms_values[bucket_index] = 0
            bucket_index += 1

        duration = total_frames / float(sample_rate)
        payload = {
            "version": 1,
            "channels": channels,
            "sample_rate": sample_rate,
            "frame_count": total_frames,
            "duration_seconds": duration,
            "peak_scale": PEAK_SCALE,
            "peaks": peaks.tolist(),
            "rms_values": rms_values.tolist(),
        }

    _write_payload(dest_path, payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate waveform preview JSON from a WAV file.")
    parser.add_argument("source", help="Path to the source WAV file")
    parser.add_argument("destination", help="Output path for the waveform JSON")
    parser.add_argument(
        "--buckets",
        type=int,
        default=DEFAULT_BUCKET_COUNT,
        help="Number of waveform buckets to compute (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    try:
        generate_waveform(args.source, args.destination, bucket_count=args.buckets)
        try:
            from lib.config import get_cfg  # Lazy import to avoid config load for library use

            cfg = get_cfg()
            raw_dir = cfg.get("paths", {}).get("recordings_dir")
            recordings_dir = Path(raw_dir) if raw_dir else None
            allowed_ext = cfg.get("ingest", {}).get("allowed_ext")
        except Exception as exc:  # noqa: BLE001 - fall back if config unavailable
            print(f"[waveform] unable to load configuration for backfill: {exc!r}", flush=True)
        else:
            if recordings_dir:
                try:
                    backfilled = backfill_missing_waveforms(
                        recordings_dir,
                        bucket_count=args.buckets,
                        allowed_extensions=allowed_ext,
                    )
                except Exception as exc:  # noqa: BLE001 - log and continue
                    print(f"[waveform] backfill sweep failed: {exc!r}", flush=True)
                else:
                    if backfilled:
                        print(
                            f"[waveform] backfilled {len(backfilled)} recording(s)",
                            flush=True,
                        )
    except Exception as exc:  # pragma: no cover - surfaced to caller
        parser.error(str(exc))
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
