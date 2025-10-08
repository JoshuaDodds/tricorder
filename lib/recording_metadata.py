"""Utilities for mutating stored recording metadata sidecars."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Iterable


def _write_payload_atomic(path: Path, payload: dict[str, object]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    os.replace(tmp_path, path)


def set_original_path(waveform_path: str | os.PathLike[str], original_rel: str) -> bool:
    """Record the preserved WAV path inside a waveform sidecar."""

    rel_value = (original_rel or "").strip()
    if not rel_value:
        return False

    destination = Path(waveform_path)
    try:
        with destination.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        payload = {}

    if not isinstance(payload, dict):
        payload = {}

    if payload.get("raw_audio_path") == rel_value:
        return True

    payload["raw_audio_path"] = rel_value
    _write_payload_atomic(destination, payload)
    return True


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Recording metadata utilities")
    subparsers = parser.add_subparsers(dest="command", required=True)

    set_original = subparsers.add_parser(
        "set_original_path", help="Annotate waveform JSON with the preserved WAV location"
    )
    set_original.add_argument("waveform", help="Path to the waveform JSON file")
    set_original.add_argument("original_rel", help="Recorder-relative path to the preserved WAV")
    return parser


def _dispatch(args: argparse.Namespace) -> int:
    if args.command == "set_original_path":
        updated = set_original_path(args.waveform, args.original_rel)
        return 0 if updated else 1
    return 1


def main(argv: Iterable[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    return _dispatch(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
