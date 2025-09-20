# tests/test_fault_handler.py
import json
from lib import fault_handler


def test_write_corrupted_placeholder(tmp_path):
    out = fault_handler._write_corrupted_placeholder(
        "testfile", reason="decode-failed", extra={"probe": "bad", "size_bytes": 123}
    )
    assert out.exists()
    data = json.loads(out.read_text())
    assert data["status"] == "corrupted"
    assert data["reason"] == "decode-failed"


def test_safe_requeue_to_dropbox(tmp_path, monkeypatch):
    wav_path = tmp_path / "foo.wav"
    wav_path.write_bytes(b"dummy")
    monkeypatch.setattr(fault_handler, "DROPBOX_DIR", tmp_path)
    target = fault_handler._safe_requeue_to_dropbox(wav_path, "foo")
    assert target.exists()
    assert target.name.endswith("-RETRY.wav")
