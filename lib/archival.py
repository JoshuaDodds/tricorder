#!/usr/bin/env python3
"""Archival upload helpers for Tricorder recordings."""
from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Iterable, Sequence

from lib.config import get_cfg


class _ArchivalPlugin:
    """Minimal protocol for archival backends."""

    def upload(self, path: Path) -> None:  # pragma: no cover - interface only
        raise NotImplementedError


@dataclass
class _NetworkShareUploader(_ArchivalPlugin):
    recordings_dir: Path
    target_dir: Path

    def upload(self, path: Path) -> None:
        if not path.exists():
            print(f"[archival] skip missing file: {path}", flush=True)
            return

        relative = _relative_to_recordings(path, self.recordings_dir)
        dest = self.target_dir / relative
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            print(f"[archival] failed to create directories for {dest}: {exc}", flush=True)
            return

        try:
            shutil.copy2(path, dest)
        except OSError as exc:
            print(f"[archival] copy failed for {path} -> {dest}: {exc}", flush=True)
            return

        print(f"[archival] copied {path} -> {dest}", flush=True)


@dataclass
class _RsyncUploader(_ArchivalPlugin):
    recordings_dir: Path
    destination: str
    options: Sequence[str]
    ssh_identity: str | None
    ssh_options: Sequence[str]

    def upload(self, path: Path) -> None:
        if not path.exists():
            print(f"[archival] skip missing file: {path}", flush=True)
            return

        relative = _relative_to_recordings(path, self.recordings_dir)
        remote_path = f"{self.destination.rstrip('/')}/{relative.as_posix()}"

        cmd = ["rsync", *self.options]
        ssh_cmd = ["ssh", "-oBatchMode=yes"]
        if self.ssh_identity:
            ssh_cmd.extend(["-i", self.ssh_identity])
        ssh_cmd.extend(self.ssh_options)
        remote_shell = shlex.join(ssh_cmd)
        cmd.extend(["-e", remote_shell, "--", str(path), remote_path])

        try:
            subprocess.run(cmd, check=True)
        except FileNotFoundError:
            print("[archival] rsync not available", flush=True)
            return
        except subprocess.CalledProcessError as exc:
            print(f"[archival] rsync failed ({exc.returncode}) for {path}", flush=True)
            if exc.stdout:
                print(exc.stdout, flush=True)
            if exc.stderr:
                print(exc.stderr, flush=True)
            return

        print(f"[archival] rsynced {path} -> {remote_path}", flush=True)


def _relative_to_recordings(path: Path, recordings_dir: Path) -> Path:
    try:
        return path.resolve().relative_to(recordings_dir.resolve())
    except ValueError:
        return Path(path.name)


def _load_plugin() -> _ArchivalPlugin | None:
    cfg = get_cfg()
    arch_cfg = cfg.get("archival") or {}
    if not arch_cfg.get("enabled"):
        return None

    recordings_dir = Path(cfg.get("paths", {}).get("recordings_dir", ".")).resolve()
    backend = str(arch_cfg.get("backend", "network_share")).strip().lower()

    if backend == "network_share":
        target = str(arch_cfg.get("network_share", {}).get("target_dir", "")).strip()
        if not target:
            print("[archival] network_share backend requires archival.network_share.target_dir", flush=True)
            return None
        return _NetworkShareUploader(recordings_dir=recordings_dir, target_dir=Path(target).resolve())

    if backend == "rsync":
        rsync_cfg = arch_cfg.get("rsync", {}) or {}
        destination = str(rsync_cfg.get("destination", "")).strip()
        if not destination:
            print("[archival] rsync backend requires archival.rsync.destination", flush=True)
            return None
        options = rsync_cfg.get("options")
        if not isinstance(options, Sequence) or isinstance(options, str):
            options = ["-az"]
        ssh_identity = rsync_cfg.get("ssh_identity")
        if ssh_identity:
            ssh_identity = str(ssh_identity).strip() or None
        ssh_options = rsync_cfg.get("ssh_options")
        if not isinstance(ssh_options, Sequence) or isinstance(ssh_options, str):
            ssh_options = []
        return _RsyncUploader(
            recordings_dir=recordings_dir,
            destination=destination,
            options=list(options) or ["-az"],
            ssh_identity=ssh_identity,
            ssh_options=list(ssh_options),
        )

    print(f"[archival] unknown backend: {backend}", flush=True)
    return None


def upload_paths(raw_paths: Iterable[str]) -> None:
    arch_cfg = (get_cfg().get("archival") or {}).copy()
    include_waveforms = bool(arch_cfg.get("include_waveform_sidecars", False))
    include_transcripts = bool(arch_cfg.get("include_transcript_sidecars", True))

    plugin = _load_plugin()
    if not plugin:
        return

    for raw_path in raw_paths:
        path = Path(raw_path)
        if not path.exists():
            print(f"[archival] skip missing file: {path}", flush=True)
            continue
        if path.suffix == ".json":
            if path.name.endswith(".waveform.json") and not include_waveforms:
                continue
            if path.name.endswith(".transcript.json") and not include_transcripts:
                continue
        plugin.upload(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload recordings to configured archival backends")
    parser.add_argument("paths", nargs="+", help="Recording files to upload")
    args = parser.parse_args()
    upload_paths(args.paths)


if __name__ == "__main__":
    main()
