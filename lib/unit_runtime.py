"""Helpers used by systemd units to sync configuration-derived runtime state."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict

from .config import get_cfg


def _escape_env_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _write_env_file(env_path: Path, values: Dict[str, str]) -> None:
    env_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = env_path.with_suffix(env_path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        for key, raw_value in values.items():
            if not raw_value:
                continue
            handle.write(f'{key}="{_escape_env_value(raw_value)}"\n')
    tmp_path.replace(env_path)


def _ensure_dirs(paths: Dict[str, str]) -> None:
    for raw_path in paths.values():
        if not raw_path:
            continue
        try:
            Path(raw_path).mkdir(parents=True, exist_ok=True)
        except Exception as exc:  # noqa: BLE001 - diagnostics only
            print(
                f"[unit-runtime] WARN: failed to ensure directory {raw_path}: {exc}",
                file=sys.stderr,
            )


def _ensure_dropbox_link(link_path: Path, dropbox_dir: Path) -> None:
    if not link_path:
        return
    if not dropbox_dir:
        return
    try:
        dropbox_dir = dropbox_dir.resolve()
    except FileNotFoundError:
        dropbox_dir = dropbox_dir

    if dropbox_dir == link_path:
        return

    try:
        if link_path.exists() or link_path.is_symlink():
            try:
                if link_path.resolve(strict=False) == dropbox_dir:
                    return
            except FileNotFoundError:
                pass
            if link_path.is_symlink():
                link_path.unlink()
            else:
                # Avoid clobbering unexpected directories; leave as-is.
                print(
                    f"[unit-runtime] WARN: {link_path} exists and is not a symlink;"
                    " skipping link update",
                    file=sys.stderr,
                )
                return
        link_path.parent.mkdir(parents=True, exist_ok=True)
        link_path.symlink_to(dropbox_dir)
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        print(
            f"[unit-runtime] WARN: failed to create dropbox link {link_path} ->"
            f" {dropbox_dir}: {exc}",
            file=sys.stderr,
        )


def prepare_runtime(
    env_file: Path,
    *,
    ensure_dirs: bool = False,
    dropbox_link: Path | None = None,
) -> Dict[str, str]:
    cfg = get_cfg()
    audio_cfg = cfg.get("audio", {})
    paths_cfg = cfg.get("paths", {})

    env_values: Dict[str, str] = {}

    device = str(audio_cfg.get("device", ""))
    if device:
        env_values["AUDIO_DEV"] = device

    channels = audio_cfg.get("channels")
    if isinstance(channels, int) and channels > 0:
        env_values["AUDIO_CHANNELS"] = str(channels)

    tmp_dir = str(paths_cfg.get("tmp_dir", ""))
    if tmp_dir:
        env_values["TMP_DIR"] = tmp_dir
        env_values["TRICORDER_TMP"] = tmp_dir

    recordings_dir = str(paths_cfg.get("recordings_dir", ""))
    if recordings_dir:
        env_values["REC_DIR"] = recordings_dir

    dropbox_dir = str(paths_cfg.get("dropbox_dir", ""))
    if dropbox_dir:
        env_values["DROPBOX_DIR"] = dropbox_dir

    ingest_dir = str(paths_cfg.get("ingest_work_dir", ""))
    if ingest_dir:
        env_values["INGEST_WORK_DIR"] = ingest_dir

    encoder_script = str(paths_cfg.get("encoder_script", ""))
    if encoder_script:
        env_values["ENCODER_SCRIPT"] = encoder_script

    _write_env_file(env_file, env_values)

    if ensure_dirs:
        _ensure_dirs(
            {
                "tmp_dir": tmp_dir,
                "recordings_dir": recordings_dir,
                "dropbox_dir": dropbox_dir,
                "ingest_work_dir": ingest_dir,
            }
        )

    if dropbox_link and dropbox_dir:
        _ensure_dropbox_link(Path(dropbox_link), Path(dropbox_dir))

    return env_values


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--ensure-dirs", action="store_true")
    parser.add_argument("--dropbox-link", type=Path, default=None)
    args = parser.parse_args(argv)

    prepare_runtime(
        args.env_file,
        ensure_dirs=args.ensure_dirs,
        dropbox_link=args.dropbox_link,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
