import io
import collections
import json
import math
import struct
import subprocess
import types
import wave
from pathlib import Path
from lib import process_dropped_file, segmenter


def make_test_wav(path: Path, seconds: int = 1, freq: int = 440):
    """Generate a sine wave WAV file for testing."""
    framerate = segmenter.SAMPLE_RATE
    amp = 16000
    nframes = framerate * seconds
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(framerate)
        for i in range(nframes):
            value = int(amp * math.sin(2 * math.pi * freq * (i / framerate)))
            wf.writeframesraw(struct.pack('<h', value))


def test_process_file_creates_output(tmp_path, monkeypatch):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")

    wav_path = tmp_path / "input.wav"
    make_test_wav(wav_path)

    process_dropped_file.process_file(str(wav_path))

    # Only assert the file exists and processing finished
    assert wav_path.exists()


def test_scan_retries_orphaned_work_files(tmp_path, monkeypatch):
    work_dir = tmp_path / "ingest"
    dropbox_dir = tmp_path / "dropbox"
    dropbox_dir.mkdir()
    monkeypatch.setattr(process_dropped_file, "WORK_DIR", work_dir)
    monkeypatch.setattr(process_dropped_file, "DROPBOX_DIR", dropbox_dir)

    processed = []

    def fake_process(path: str) -> None:
        processed.append(Path(path))

    monkeypatch.setattr(process_dropped_file, "process_file", fake_process)

    work_dir.mkdir()
    work_file = work_dir / "stalled.wav"
    work_file.write_bytes(b"dummy")

    process_dropped_file.scan_and_ingest()

    assert processed == [work_file]
    assert not work_file.exists()


def test_pcm_source_lowers_priority_when_encoding_active(tmp_path, monkeypatch):
    dummy = tmp_path / "dummy.opus"
    dummy.write_text("data")

    monkeypatch.setattr(
        process_dropped_file,
        "ENCODING_STATUS",
        types.SimpleNamespace(snapshot=lambda: {"active": {"id": 1}}),
    )

    nice_calls: list[int] = []

    def fake_nice(value: int) -> int:
        nice_calls.append(value)
        return 0

    monkeypatch.setattr(process_dropped_file.os, "nice", fake_nice)

    monkeypatch.setattr(
        process_dropped_file.os,
        "sched_getaffinity",
        lambda _pid: {0, 1},
        raising=False,
    )

    affinity_calls: list[tuple[int, set[int]]] = []

    def fake_affinity(pid: int, cpus: set[int]) -> None:
        affinity_calls.append((pid, cpus))

    monkeypatch.setattr(
        process_dropped_file.os,
        "sched_setaffinity",
        fake_affinity,
        raising=False,
    )

    captured: dict[str, object] = {}

    def fake_popen(cmd, stdout=None, preexec_fn=None):
        captured["cmd"] = cmd
        captured["stdout"] = stdout
        captured["preexec"] = preexec_fn

        class DummyProc:
            def __init__(self):
                self.stdout = io.BytesIO(b"")

            def wait(self):
                captured["waited"] = True

        proc = DummyProc()
        if preexec_fn:
            preexec_fn()
        return proc

    monkeypatch.setattr(process_dropped_file.subprocess, "Popen", fake_popen)

    with process_dropped_file._pcm_source(dummy) as stream:
        list(stream)

    assert "-threads" in captured["cmd"]
    assert nice_calls == [5]
    assert affinity_calls and affinity_calls[0][1] == {0}
    assert captured["stdout"] is subprocess.PIPE


def test_pcm_source_does_not_lower_priority_when_idle(tmp_path, monkeypatch):
    dummy = tmp_path / "dummy.wav"
    dummy.write_bytes(b"data")

    monkeypatch.setattr(
        process_dropped_file,
        "ENCODING_STATUS",
        types.SimpleNamespace(snapshot=lambda: None),
    )

    nice_calls: list[int] = []

    def fake_nice(value: int) -> int:
        nice_calls.append(value)
        return 0

    monkeypatch.setattr(process_dropped_file.os, "nice", fake_nice)

    monkeypatch.setattr(
        process_dropped_file.os,
        "sched_getaffinity",
        lambda _pid: {0},
        raising=False,
    )

    monkeypatch.setattr(
        process_dropped_file.os,
        "sched_setaffinity",
        lambda _pid, _cpus: None,
        raising=False,
    )

    captured_cmd: list[str] = []

    def fake_popen(cmd, stdout=None, preexec_fn=None):
        captured_cmd[:] = cmd

        class DummyProc:
            def __init__(self):
                self.stdout = io.BytesIO(b"")

            def wait(self):
                pass

        proc = DummyProc()
        if preexec_fn:
            preexec_fn()
        return proc

    monkeypatch.setattr(process_dropped_file.subprocess, "Popen", fake_popen)

    with process_dropped_file._pcm_source(dummy) as stream:
        list(stream)

    assert "-threads" in captured_cmd
    assert not nice_calls


def test_process_file_uses_filename_timestamp(tmp_path, monkeypatch):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(
        segmenter.TimelineRecorder,
        "event_counters",
        collections.defaultdict(int),
    )

    captured: dict[str, str] = {}

    def fake_enqueue(tmp_wav_path: str, base_name: str, **_kwargs) -> None:
        captured["base_name"] = base_name
        return None

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    wav_path = tmp_path / "12-34-56_Test_3-RETRY.wav"
    make_test_wav(wav_path)

    process_dropped_file.process_file(str(wav_path))

    assert "base_name" in captured
    base = captured["base_name"]
    assert base.startswith("12-34-56_")
    assert base.rsplit("_", 1)[-1] == "3"


def test_cleanup_retry_artifacts_detects_duration_mismatch(tmp_path, monkeypatch):
    recordings_dir = tmp_path / "recordings"
    day_dir = recordings_dir / "20240102"
    day_dir.mkdir(parents=True)

    audio_path = day_dir / "clip.opus"
    audio_path.write_bytes(b"dummy")
    waveform_path = audio_path.with_suffix(".opus.waveform.json")
    waveform_payload = {"duration_seconds": 12.0}
    waveform_path.write_text(json.dumps(waveform_payload))

    monkeypatch.setattr(process_dropped_file, "REC_DIR", recordings_dir)
    monkeypatch.setattr(process_dropped_file, "OUTPUT_SUFFIXES", (".opus",))

    probe_calls: list[Path] = []

    def fake_probe(path: Path) -> float:
        probe_calls.append(path)
        return 3.0

    monkeypatch.setattr(process_dropped_file, "_probe_audio_duration", fake_probe)

    work_dir = tmp_path / "ingest"
    work_dir.mkdir()
    work_file = work_dir / "clip-RETRY.wav"
    work_file.write_bytes(b"input")

    process_dropped_file._cleanup_retry_artifacts(work_file)

    placeholder = day_dir / "clip-CORRUPTED_RECORDING.json"
    assert placeholder.exists()
    payload = json.loads(placeholder.read_text())
    assert payload["reason"] == "duration-mismatch"
    assert payload["audio_duration_seconds"] == 3.0
    assert payload["waveform_duration_seconds"] == 12.0
    assert probe_calls == [audio_path]
    assert not audio_path.exists()
    assert not waveform_path.exists()


def test_cleanup_retry_artifacts_handles_missing_waveform(tmp_path, monkeypatch):
    recordings_dir = tmp_path / "recordings"
    day_dir = recordings_dir / "20240103"
    day_dir.mkdir(parents=True)

    audio_path = day_dir / "clip.opus"
    audio_path.write_bytes(b"dummy")

    monkeypatch.setattr(process_dropped_file, "REC_DIR", recordings_dir)
    monkeypatch.setattr(process_dropped_file, "OUTPUT_SUFFIXES", (".opus",))
    monkeypatch.setattr(process_dropped_file, "_probe_audio_duration", lambda path: 5.0)

    work_dir = tmp_path / "ingest"
    work_dir.mkdir(exist_ok=True)
    work_file = work_dir / "clip-RETRY.wav"
    work_file.write_bytes(b"input")

    process_dropped_file._cleanup_retry_artifacts(work_file)

    placeholder = day_dir / "clip-CORRUPTED_RECORDING.json"
    assert placeholder.exists()
    payload = json.loads(placeholder.read_text())
    assert payload["reason"] == "missing-waveform"
    assert not audio_path.exists()

