from __future__ import annotations

import shlex
from pathlib import Path
from types import SimpleNamespace

import lib.archival as archival


def test_upload_disabled_noop(tmp_path, monkeypatch):
    config = {
        "paths": {"recordings_dir": str(tmp_path)},
        "archival": {"enabled": False},
    }
    monkeypatch.setattr(archival, "get_cfg", lambda: config)

    copied: list[tuple[Path, Path]] = []

    def fake_copy(src: Path, dst: Path) -> None:
        copied.append((Path(src), Path(dst)))

    monkeypatch.setattr(archival.shutil, "copy2", fake_copy)

    archival.upload_paths([str(tmp_path / "missing.opus")])
    assert copied == []
    monkeypatch.undo()


def test_network_share_upload_and_waveform_gate(tmp_path, monkeypatch):
    recordings_dir = tmp_path / "recordings"
    archive_dir = tmp_path / "archive"
    day_dir = recordings_dir / "20240101"
    day_dir.mkdir(parents=True)

    opus = day_dir / "foo.opus"
    opus.write_bytes(b"opus")
    waveform = Path(f"{opus}.waveform.json")
    waveform.write_text("{}", encoding="utf-8")

    config = {
        "paths": {"recordings_dir": str(recordings_dir)},
        "archival": {
            "enabled": True,
            "backend": "network_share",
            "network_share": {"target_dir": str(archive_dir)},
            "include_waveform_sidecars": False,
        },
    }

    monkeypatch.setattr(archival, "get_cfg", lambda: config)
    archival.upload_paths([str(opus), str(waveform)])

    copied_audio = archive_dir / "20240101" / "foo.opus"
    assert copied_audio.exists()
    assert not (archive_dir / "20240101" / "foo.opus.waveform.json").exists()

    config["archival"]["include_waveform_sidecars"] = True
    monkeypatch.setattr(archival, "get_cfg", lambda: config)
    archival.upload_paths([str(waveform)])
    assert (archive_dir / "20240101" / "foo.opus.waveform.json").exists()
    monkeypatch.undo()


def test_rsync_invocation(monkeypatch, tmp_path):
    recordings_dir = tmp_path / "recordings"
    recordings_dir.mkdir()
    sample = recordings_dir / "clip.opus"
    sample.write_bytes(b"data")

    captured: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return SimpleNamespace(stdout="", stderr="")

    monkeypatch.setattr(archival.subprocess, "run", fake_run)

    config = {
        "paths": {"recordings_dir": str(recordings_dir)},
        "archival": {
            "enabled": True,
            "backend": "rsync",
            "rsync": {
                "destination": "user@host:/srv/archive",
                "options": ["-az", "--bwlimit=2000"],
                "ssh_identity": "/home/pi/.ssh/id_ed25519",
                "ssh_options": ["-oStrictHostKeyChecking=yes"],
            },
        },
    }

    monkeypatch.setattr(archival, "get_cfg", lambda: config)
    archival.upload_paths([str(sample)])

    assert "cmd" in captured
    expected_shell = shlex.join(
        [
            "ssh",
            "-oBatchMode=yes",
            "-i",
            "/home/pi/.ssh/id_ed25519",
            "-oStrictHostKeyChecking=yes",
        ]
    )
    expected_cmd = [
        "rsync",
        "-az",
        "--bwlimit=2000",
        "-e",
        expected_shell,
        "--",
        str(sample),
        "user@host:/srv/archive/clip.opus",
    ]
    assert captured["cmd"] == expected_cmd
    assert captured["kwargs"].get("check") is True
    monkeypatch.undo()
