"""Utilities to precompute waveform peaks for fast dashboard rendering."""

from __future__ import annotations

import argparse
import audioop
import contextlib
import json
import math
import os
from array import array
from pathlib import Path
from typing import Any
import wave

DEFAULT_BUCKET_COUNT = 2048
MAX_BUCKET_COUNT = 8192
PEAK_SCALE = 32767


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
            }
            _write_payload(dest_path, payload)
            return payload

        peaks = array("h", [0] * (bucket_count * 2))
        frames_per_bucket = total_frames / float(bucket_count)
        chunk_frames = max(1, min(65536, int(math.ceil(frames_per_bucket * 8))))

        frames_consumed = 0
        bucket_index = 0
        bucket_min = 32767
        bucket_max = -32768
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

                frames_consumed += 1
                if frames_consumed >= total_frames or frames_consumed >= next_threshold:
                    if bucket_min > bucket_max:
                        bucket_min = 0
                        bucket_max = 0
                    peaks[bucket_index * 2] = _clamp_int16(bucket_min)
                    peaks[bucket_index * 2 + 1] = _clamp_int16(bucket_max)
                    bucket_index += 1
                    if bucket_index >= bucket_count:
                        break
                    bucket_min = 32767
                    bucket_max = -32768
                    next_threshold = int(math.ceil((bucket_index + 1) * frames_per_bucket))

            if bucket_index >= bucket_count:
                break

        while bucket_index < bucket_count:
            peaks[bucket_index * 2] = 0
            peaks[bucket_index * 2 + 1] = 0
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
    except Exception as exc:  # pragma: no cover - surfaced to caller
        parser.error(str(exc))
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
