"""Utility helpers for recording recycle bin operations."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

RECYCLE_BIN_DIRNAME = ".recycle_bin"
RECYCLE_METADATA_FILENAME = "metadata.json"


@dataclass(frozen=True)
class RecycleMoveResult:
    """Summary of a recycle bin move operation."""

    entry_id: str
    entry_dir: Path
    audio_destination: Path
    waveform_destination: Path | None
    transcript_destination: Path | None
    raw_audio_destination: Path | None


def _is_safe_relative_path(value: str) -> bool:
    if not value:
        return False
    if value.startswith(("/", "\\")):
        return False
    try:
        parts = Path(value).parts
    except Exception:
        return False
    return ".." not in parts


def _generate_entry_id(now: datetime | None = None) -> str:
    timestamp = datetime.now(timezone.utc) if now is None else now
    suffix = secrets.token_hex(4)
    return f"{timestamp.strftime('%Y%m%dT%H%M%S')}-{suffix}"


def _resolve_waveform_metadata(path: Path) -> dict[str, object] | None:
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _extract_float(value: object) -> float | None:
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except (TypeError, ValueError):
            return None
    return None


def move_short_recording_to_recycle_bin(
    audio_path: str | os.PathLike[str],
    recordings_root: str | os.PathLike[str],
    *,
    waveform_path: str | os.PathLike[str] | None = None,
    transcript_path: str | os.PathLike[str] | None = None,
    duration: float | None = None,
    reason: str = "short_clip",
) -> RecycleMoveResult:
    """Move a short recording into the recycle bin with metadata."""

    recordings_root_path = Path(recordings_root).expanduser()
    try:
        recordings_root_resolved = recordings_root_path.resolve(strict=False)
    except OSError as exc:  # pragma: no cover - unexpected path resolution errors
        raise RuntimeError(f"unable to resolve recordings root: {exc}") from exc

    audio_source = Path(audio_path)
    if not audio_source.is_file():
        raise FileNotFoundError(f"audio path not found: {audio_source}")

    try:
        audio_resolved = audio_source.resolve()
    except OSError as exc:  # pragma: no cover - uncommon but handled defensively
        raise RuntimeError(f"unable to resolve audio path: {exc}") from exc

    try:
        relative_audio = audio_resolved.relative_to(recordings_root_resolved)
    except ValueError as exc:
        raise RuntimeError("audio path must reside within recordings root") from exc

    recordings_root_path.mkdir(parents=True, exist_ok=True)
    recycle_root = recordings_root_path / RECYCLE_BIN_DIRNAME
    _ensure_directory(recycle_root)

    waveform_source = Path(waveform_path) if waveform_path else audio_resolved.with_suffix(
        audio_resolved.suffix + ".waveform.json"
    )
    transcript_source = (
        Path(transcript_path)
        if transcript_path
        else audio_resolved.with_suffix(audio_resolved.suffix + ".transcript.json")
    )

    waveform_meta = _resolve_waveform_metadata(waveform_source)
    duration_value = duration
    if duration_value is None and waveform_meta is not None:
        duration_value = _extract_float(waveform_meta.get("duration_seconds"))

    raw_audio_rel = ""
    raw_audio_source: Path | None = None
    if waveform_meta is not None:
        raw_candidate = waveform_meta.get("raw_audio_path")
        if isinstance(raw_candidate, str):
            candidate_str = raw_candidate.strip()
            if candidate_str and _is_safe_relative_path(candidate_str):
                candidate_path = recordings_root_path / candidate_str
                try:
                    candidate_resolved = candidate_path.resolve()
                    candidate_resolved.relative_to(recordings_root_resolved)
                except Exception:
                    raw_audio_source = None
                else:
                    if candidate_resolved.is_file():
                        raw_audio_source = candidate_resolved
                        raw_audio_rel = candidate_resolved.relative_to(
                            recordings_root_resolved
                        ).as_posix()

    start_epoch_value: float | None = None
    started_at_value = ""
    if waveform_meta is not None:
        start_epoch_value = _extract_float(
            waveform_meta.get("start_epoch", waveform_meta.get("started_epoch"))
        )
        started_at_raw = waveform_meta.get("started_at")
        if isinstance(started_at_raw, str):
            started_at_value = started_at_raw

    try:
        stat_result = audio_resolved.stat()
    except OSError as exc:  # pragma: no cover - propagated for caller handling
        raise RuntimeError(f"unable to stat audio file: {exc}") from exc

    now = datetime.now(timezone.utc)
    entry_id = ""
    entry_dir: Path | None = None
    for _ in range(6):
        candidate_id = _generate_entry_id(now if not entry_id else None)
        candidate_dir = recycle_root / candidate_id
        try:
            candidate_dir.mkdir(parents=False, exist_ok=False)
        except FileExistsError:
            continue
        except OSError as exc:
            raise RuntimeError(f"unable to prepare recycle bin entry: {exc}") from exc
        entry_id = candidate_id
        entry_dir = candidate_dir
        break

    if not entry_id or entry_dir is None:  # pragma: no cover - defensive
        raise RuntimeError("unable to allocate recycle bin entry")

    metadata_path = entry_dir / RECYCLE_METADATA_FILENAME
    audio_destination = entry_dir / audio_resolved.name
    waveform_destination: Path | None = None
    transcript_destination: Path | None = None
    raw_audio_destination: Path | None = None
    moved_pairs: list[tuple[Path, Path]] = []

    try:
        shutil.move(str(audio_resolved), str(audio_destination))
        moved_pairs.append((audio_destination, audio_resolved))

        if waveform_source.is_file():
            waveform_destination = entry_dir / waveform_source.name
            shutil.move(str(waveform_source), str(waveform_destination))
            moved_pairs.append((waveform_destination, waveform_source))

        if transcript_source.is_file():
            transcript_destination = entry_dir / transcript_source.name
            shutil.move(str(transcript_source), str(transcript_destination))
            moved_pairs.append((transcript_destination, transcript_source))

        if raw_audio_source is not None and raw_audio_source.is_file():
            raw_audio_destination = entry_dir / raw_audio_source.name
            shutil.move(str(raw_audio_source), str(raw_audio_destination))
            moved_pairs.append((raw_audio_destination, raw_audio_source))

        metadata = {
            "id": entry_id,
            "stored_name": audio_destination.name,
            "original_name": audio_destination.name,
            "original_path": relative_audio.as_posix(),
            "raw_audio_path": raw_audio_rel,
            "raw_audio_name": raw_audio_destination.name if raw_audio_destination else "",
            "deleted_at": now.isoformat(),
            "deleted_at_epoch": now.timestamp(),
            "size_bytes": int(getattr(stat_result, "st_size", 0)),
            "duration_seconds": duration_value,
            "waveform_name": waveform_destination.name if waveform_destination else "",
            "transcript_name": transcript_destination.name if transcript_destination else "",
            "start_epoch": start_epoch_value,
            "started_epoch": start_epoch_value,
            "started_at": started_at_value,
            "reason": reason,
        }
        with metadata_path.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle)
    except Exception as exc:
        for destination, source in reversed(moved_pairs):
            try:
                if destination.exists():
                    source.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(destination), str(source))
            except Exception:
                pass
        try:
            if metadata_path.exists():
                metadata_path.unlink()
        except Exception:
            pass
        try:
            if entry_dir.exists():
                shutil.rmtree(entry_dir, ignore_errors=True)
        except Exception:
            pass
        raise RuntimeError(f"unable to move recording to recycle bin: {exc}") from exc

    return RecycleMoveResult(
        entry_id=entry_id,
        entry_dir=entry_dir,
        audio_destination=audio_destination,
        waveform_destination=waveform_destination,
        transcript_destination=transcript_destination,
        raw_audio_destination=raw_audio_destination,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Recycle bin helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    move_parser = subparsers.add_parser(
        "move-short",
        help="Move a short recording into the recycle bin",
    )
    move_parser.add_argument("--recordings-root", required=True)
    move_parser.add_argument("--audio", required=True)
    move_parser.add_argument("--waveform")
    move_parser.add_argument("--transcript")
    move_parser.add_argument("--duration")
    move_parser.add_argument("--reason", default="short_clip")
    return parser


def _parse_duration(raw: str | None) -> float | None:
    if raw is None or not raw:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def main(argv: Iterable[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "move-short":
        duration_value = _parse_duration(getattr(args, "duration", None))
        result = move_short_recording_to_recycle_bin(
            args.audio,
            args.recordings_root,
            waveform_path=getattr(args, "waveform", None) or None,
            transcript_path=getattr(args, "transcript", None) or None,
            duration=duration_value,
            reason=getattr(args, "reason", "short_clip"),
        )
        print(result.entry_id)
        return 0

    parser.error("no command specified")
    return 1


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
