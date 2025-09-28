#!/usr/bin/env python3
"""Speech-to-text helpers for generating transcript sidecars."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import time
import wave
from array import array
from pathlib import Path
from typing import Any, Sequence

import audioop  # noqa: F401  (imported for side-effects + rate conversion)

from lib.config import get_cfg


class TranscriptionError(Exception):
    """Raised when transcription should be treated as a failure."""


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}
    return False


def _write_json_atomic(destination: Path, payload: dict[str, Any]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = destination.with_suffix(destination.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, destination)


def _extract_event_type(base_name: str | None) -> str:
    if not base_name:
        return ""
    tokens = base_name.split("_")
    if len(tokens) >= 2:
        return tokens[1]
    return ""


def _load_vosk_model(model_path: Path):  # pragma: no cover - exercised via stub
    from vosk import Model, SetLogLevel  # type: ignore[import-not-found]

    SetLogLevel(-1)
    return Model(str(model_path))


def _convert_to_mono(data: bytes, channels: int, sample_width: int) -> bytes:
    if channels <= 1:
        return data
    if channels == 2:
        return audioop.tomono(data, sample_width, 0.5, 0.5)

    if sample_width != 2:
        raise TranscriptionError("Only 16-bit PCM is supported for multi-channel input")

    samples = array("h")
    samples.frombytes(data)
    frame_count = len(samples) // channels
    if frame_count <= 0:
        return b""
    mono = array("h")
    mono.extend(0 for _ in range(frame_count))
    for idx in range(frame_count):
        total = 0
        base = idx * channels
        for ch in range(channels):
            total += samples[base + ch]
        mono[idx] = int(total / channels)
    return mono.tobytes()


def _transcribe_with_vosk(
    source: Path,
    *,
    model_path: Path,
    target_sample_rate: int,
    include_words: bool,
    max_alternatives: int,
) -> tuple[str, dict[str, Any]]:
    try:
        model = _load_vosk_model(model_path)
    except Exception as exc:  # pragma: no cover - depends on installed vosk
        raise TranscriptionError(f"Failed to load Vosk model: {exc}") from exc

    target_sample_rate = max(8000, int(target_sample_rate) if target_sample_rate else 16000)

    from vosk import KaldiRecognizer  # type: ignore[import-not-found]

    recognizer = KaldiRecognizer(model, float(target_sample_rate))
    if include_words:
        try:
            recognizer.SetWords(True)
        except Exception:
            pass
    if max_alternatives > 0:
        try:
            recognizer.SetMaxAlternatives(int(max_alternatives))
        except Exception:
            pass

    with contextlib.closing(wave.open(str(source), "rb")) as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        input_rate = wav_file.getframerate()
        total_frames = wav_file.getnframes()

        if sample_width <= 0:
            raise TranscriptionError("Invalid WAV sample width")
        if input_rate <= 0:
            raise TranscriptionError("Invalid WAV sample rate")

        rate_state: Any = None
        while True:
            chunk = wav_file.readframes(4000)
            if not chunk:
                break

            if sample_width != 2:
                chunk = audioop.lin2lin(chunk, sample_width, 2)
                effective_width = 2
            else:
                effective_width = sample_width

            if channels != 1:
                chunk = _convert_to_mono(chunk, channels, effective_width)

            if input_rate != target_sample_rate:
                chunk, rate_state = audioop.ratecv(
                    chunk,
                    effective_width,
                    1,
                    input_rate,
                    target_sample_rate,
                    rate_state,
                )

            if chunk:
                recognizer.AcceptWaveform(chunk)

        if input_rate != target_sample_rate:
            flush, _ = audioop.ratecv(
                b"",
                2,
                1,
                input_rate,
                target_sample_rate,
                rate_state,
            )
            if flush:
                recognizer.AcceptWaveform(flush)

    try:
        result = json.loads(recognizer.FinalResult())
    except json.JSONDecodeError as exc:
        raise TranscriptionError("Recognizer returned invalid JSON") from exc

    text = str(result.get("text", "")).strip()
    metadata: dict[str, Any] = {}
    if include_words:
        words = []
        for item in result.get("result", []):
            if not isinstance(item, dict):
                continue
            word = str(item.get("word", "")).strip()
            if not word:
                continue
            entry: dict[str, Any] = {
                "word": word,
            }
            if isinstance(item.get("start"), (int, float)):
                entry["start"] = float(item["start"])
            if isinstance(item.get("end"), (int, float)):
                entry["end"] = float(item["end"])
            if isinstance(item.get("conf"), (int, float)):
                entry["confidence"] = float(item["conf"])
            words.append(entry)
        if words:
            metadata["words"] = words

    if max_alternatives > 0:
        alts: list[dict[str, Any]] = []
        for alt in result.get("alternatives", []):
            if not isinstance(alt, dict):
                continue
            alt_text = str(alt.get("text", "")).strip()
            if not alt_text:
                continue
            alt_entry: dict[str, Any] = {"text": alt_text}
            if isinstance(alt.get("confidence"), (int, float)):
                alt_entry["confidence"] = float(alt["confidence"])
            alts.append(alt_entry)
        if alts:
            metadata["alternatives"] = alts

    duration = 0.0
    if input_rate > 0 and total_frames > 0:
        duration = total_frames / float(input_rate)

    metadata["input_sample_rate"] = int(input_rate)
    metadata["target_sample_rate"] = int(target_sample_rate)
    metadata["duration_seconds"] = float(duration)

    return text, metadata


def transcribe_audio(
    source_audio: os.PathLike[str] | str,
    destination: os.PathLike[str] | str,
    *,
    base_name: str | None = None,
    event_type: str | None = None,
) -> bool:
    cfg = get_cfg()
    section = cfg.get("transcription") if isinstance(cfg, dict) else None
    if not isinstance(section, dict):
        return False

    if not _bool(section.get("enabled")):
        return False

    allowed_types: set[str] = set()
    raw_types = section.get("types")
    if isinstance(raw_types, (list, tuple, set)):
        for token in raw_types:
            if isinstance(token, str) and token.strip():
                allowed_types.add(token.strip().lower())
    elif isinstance(raw_types, str) and raw_types.strip():
        allowed_types.add(raw_types.strip().lower())

    if event_type is None:
        event_type = _extract_event_type(base_name)
    event_type = (event_type or "").strip()

    if allowed_types and event_type.lower() not in allowed_types:
        return False

    engine = str(section.get("engine", "vosk")).strip().lower()
    if engine not in {"vosk"}:
        raise TranscriptionError(f"Unsupported transcription engine: {engine}")

    source_path = Path(source_audio)
    dest_path = Path(destination)

    if not source_path.exists():
        raise TranscriptionError(f"Source audio not found: {source_path}")

    model_key = section.get("vosk_model_path") or section.get("model_path")
    if not isinstance(model_key, str) or not model_key.strip():
        raise TranscriptionError("transcription.vosk_model_path is not configured")
    model_path = Path(model_key.strip())
    if not model_path.exists():
        raise TranscriptionError(f"Configured Vosk model not found: {model_path}")

    target_rate = section.get("target_sample_rate") or section.get("vosk_sample_rate")
    try:
        target_rate_int = int(target_rate) if target_rate else 16000
    except Exception:
        target_rate_int = 16000
    include_words = _bool(section.get("include_words", True))
    try:
        max_alternatives = int(section.get("max_alternatives", 0) or 0)
    except Exception:
        max_alternatives = 0

    text, metadata = _transcribe_with_vosk(
        source_path,
        model_path=model_path,
        target_sample_rate=target_rate_int,
        include_words=include_words,
        max_alternatives=max_alternatives,
    )

    payload: dict[str, Any] = {
        "version": 1,
        "engine": engine,
        "model_path": str(model_path.resolve()),
        "base_name": base_name or "",
        "event_type": event_type,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "text": text,
    }
    payload.update(metadata)

    _write_json_atomic(dest_path, payload)
    return True


def _parse_cli_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate transcript sidecars")
    parser.add_argument("source", help="Path to the source WAV file")
    parser.add_argument("destination", help="Destination transcript JSON path")
    parser.add_argument(
        "base_name",
        nargs="?",
        default="",
        help="Base filename (used to derive event type)",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_cli_args(argv)
    try:
        transcribe_audio(args.source, args.destination, base_name=args.base_name)
    except TranscriptionError as exc:
        print(f"[transcription] ERROR: {exc}", flush=True)
        return 1
    except Exception as exc:  # pragma: no cover - unexpected failure
        print(f"[transcription] ERROR: unexpected failure: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
