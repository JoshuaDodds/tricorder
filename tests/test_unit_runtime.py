from pathlib import Path

from lib.unit_runtime import prepare_runtime


def test_prepare_runtime_writes_env_and_dirs(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.yaml"
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "recordings"
    dropbox_dir = tmp_path / "dropbox"
    ingest_dir = tmp_path / "ingest"
    dropbox_link = tmp_path / "link" / "dropbox"

    cfg_path.write_text(
        f"""
audio:
  device: hw:Loopback,1,0
  channels: 2
paths:
  tmp_dir: "{tmp_dir}"
  recordings_dir: "{rec_dir}"
  dropbox_dir: "{dropbox_dir}"
  ingest_work_dir: "{ingest_dir}"
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("TRICORDER_CONFIG", str(cfg_path))

    env_file = tmp_path / "runtime.env"
    values = prepare_runtime(
        env_file,
        ensure_dirs=True,
        dropbox_link=dropbox_link,
    )

    assert env_file.read_text(encoding="utf-8").strip().count("\n") >= 4
    assert values["AUDIO_DEV"] == "hw:Loopback,1,0"
    assert values["DROPBOX_DIR"] == str(dropbox_dir)
    assert tmp_dir.is_dir()
    assert rec_dir.is_dir()
    assert dropbox_dir.is_dir()
    assert ingest_dir.is_dir()
    assert dropbox_link.is_symlink()
    assert dropbox_link.resolve() == dropbox_dir
