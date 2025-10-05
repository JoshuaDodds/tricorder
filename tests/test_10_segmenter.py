# tests/test_10_segmenter.py
import builtins
import json
import os
import re
import time
import wave
from datetime import datetime, timezone

import os
import pytest

import collections
import os
from datetime import datetime
from pathlib import Path
import wave

from lib.segmenter import TimelineRecorder, FRAME_BYTES
import lib.segmenter as segmenter


def make_frame(value: int = 1000):
    """Return a dummy audio frame of constant value."""
    return value.to_bytes(2, 'little', signed=True) * (FRAME_BYTES // 2)


def read_sample(buf: bytes, idx: int = 0) -> int:
    start = idx * 2
    return int.from_bytes(buf[start:start + 2], 'little', signed=True)


def _write_constant_wav(path: Path, sample: int, frames: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(segmenter.SAMPLE_WIDTH)
        wav_file.setframerate(segmenter.SAMPLE_RATE)
        sample_bytes = sample.to_bytes(2, "little", signed=True)
        wav_file.writeframes(sample_bytes * frames)


def test_event_trigger_and_flush(tmp_path, monkeypatch):
    # Monkeypatch encoder so we don’t depend on /apps/tricorder/bin
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")

    rec = TimelineRecorder()
    # Feed enough loud frames to trigger event
    for i in range(40):
        rec.ingest(make_frame(2000), i)
    rec.flush(100)

    # After flush, recorder resets state
    assert rec.base_name is None


def test_flush_does_not_block_on_encode(monkeypatch):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 5)

    rec = TimelineRecorder()
    for i in range(40):
        rec.ingest(make_frame(2000), i)

    def fail_join():  # pragma: no cover - defensive guard
        raise AssertionError("flush should not wait for encode queue")

    monkeypatch.setattr(segmenter.ENCODE_QUEUE, "join", fail_join)

    observed = {}

    def fake_wait(job_id: int, timeout: float | None) -> bool:
        observed["call"] = (job_id, timeout)
        return True

    monkeypatch.setattr(segmenter.ENCODING_STATUS, "wait_for_start", fake_wait)

    rec.flush(100)

    job_id, timeout = observed["call"]
    assert job_id > 0
    assert timeout == segmenter.SHUTDOWN_ENCODE_START_TIMEOUT


def test_parallel_encode_starts_when_cpu_available(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", True)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_MIN_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_CHECK_INTERVAL", 0.0)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_LOAD_THRESHOLD", 1.0)
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter.time, "strftime", lambda fmt, *args: "20240102")
    monkeypatch.setattr(segmenter.os, "getloadavg", lambda: (0.1, 0.1, 0.1))
    monkeypatch.setattr(segmenter.os, "cpu_count", lambda: 4)

    class _FakeDatetime:
        class _Stamp:
            @staticmethod
            def strftime(fmt: str) -> str:
                return "12-34-56"

        @classmethod
        def now(cls):
            return cls._Stamp()

        @classmethod
        def fromtimestamp(cls, ts: float):
            return cls._Stamp()

    monkeypatch.setattr(segmenter, "datetime", _FakeDatetime)

    captured_encoder: dict[str, object] = {}

    class FakeStreamingEncoder:
        def __init__(self, partial_path: str, *, container_format: str = "opus") -> None:
            self.partial_path = partial_path
            self.container_format = container_format
            self.started = False
            self.feed_chunks: list[bytes] = []
            captured_encoder["instance"] = self

        def start(self, command: list[str] | None = None) -> None:
            self.started = True

        def feed(self, chunk: bytes) -> bool:
            self.feed_chunks.append(bytes(chunk))
            return True

        def close(self, *, timeout: float | None = None) -> segmenter.StreamingEncoderResult:
            path = Path(self.partial_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"parallel-data")
            return segmenter.StreamingEncoderResult(
                partial_path=self.partial_path,
                success=True,
                returncode=0,
                error=None,
                stderr=None,
                bytes_sent=sum(len(chunk) for chunk in self.feed_chunks),
                dropped_chunks=0,
            )

    monkeypatch.setattr(segmenter, "StreamingOpusEncoder", FakeStreamingEncoder)

    captured_job: dict[str, object] = {}

    def fake_enqueue(tmp_wav_path: str, base_name: str, *, source: str, existing_opus_path: str | None):
        captured_job["base"] = base_name
        captured_job["existing"] = existing_opus_path
        captured_job["source"] = source
        return 42

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)
    monkeypatch.setattr(segmenter.TimelineRecorder, "event_counters", collections.defaultdict(int))

    rec = TimelineRecorder()
    for idx in range(4):
        rec.ingest(make_frame(2000), idx)

    rec.flush(10)

    encoder = captured_encoder.get("instance")
    assert encoder is not None and getattr(encoder, "started", False)

    existing_path = captured_job.get("existing")
    assert existing_path, "expected parallel output to be reused"
    assert Path(existing_path).exists()
    assert existing_path.endswith(segmenter.STREAMING_EXTENSION)
    assert Path(existing_path).parent == rec_dir / "20240102"
    waveform_path = Path(f"{existing_path}.waveform.json")
    assert waveform_path.exists()
    payload = json.loads(waveform_path.read_text(encoding="utf-8"))
    assert payload.get("frame_count", 0) > 0
    assert not Path(encoder.partial_path).exists()
    partial_waveform = Path(f"{encoder.partial_path}.waveform.json")
    assert not partial_waveform.exists()


def test_live_waveform_updates_status(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", True)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_MIN_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_CHECK_INTERVAL", 0.0)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_LOAD_THRESHOLD", 1.0)
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "LIVE_WAVEFORM_UPDATE_INTERVAL", 0.0)
    monkeypatch.setattr(segmenter, "LIVE_WAVEFORM_BUCKET_COUNT", 4)
    monkeypatch.setattr(segmenter.time, "strftime", lambda fmt, *args: "20240108")
    monkeypatch.setattr(segmenter.os, "getloadavg", lambda: (0.1, 0.1, 0.1))
    monkeypatch.setattr(segmenter.os, "cpu_count", lambda: 4)

    monkeypatch.setattr(segmenter.TimelineRecorder, "event_counters", collections.defaultdict(int))

    class _FakeDatetime:
        class _Stamp:
            @staticmethod
            def strftime(fmt: str) -> str:
                return "12-34-56"

        @classmethod
        def now(cls):
            return cls._Stamp()

        @classmethod
        def fromtimestamp(cls, ts: float):
            return cls._Stamp()

    monkeypatch.setattr(segmenter, "datetime", _FakeDatetime)

    class DummyEncoder:
        def __init__(self, partial_path: str, *, container_format: str = "opus") -> None:
            self.partial_path = partial_path
            self.container_format = container_format
            self.started = False
            self.feed_chunks: list[bytes] = []

        def start(self, command: list[str] | None = None) -> None:
            self.started = True

        def feed(self, chunk: bytes) -> bool:
            self.feed_chunks.append(bytes(chunk))
            return True

        def close(self, *, timeout: float | None = None):
            Path(self.partial_path).parent.mkdir(parents=True, exist_ok=True)
            Path(self.partial_path).write_bytes(b"parallel")
            return segmenter.StreamingEncoderResult(
                partial_path=self.partial_path,
                success=True,
                returncode=0,
                error=None,
                stderr=None,
                bytes_sent=sum(len(chunk) for chunk in self.feed_chunks),
                dropped_chunks=0,
            )

    monkeypatch.setattr(segmenter, "StreamingOpusEncoder", DummyEncoder)

    rec = TimelineRecorder()
    for idx in range(6):
        rec.ingest(make_frame(2000), idx)

    assert rec._live_waveform_path is not None
    waveform_file = Path(rec._live_waveform_path)
    assert waveform_file.exists()
    payload = json.loads(waveform_file.read_text(encoding="utf-8"))
    assert payload["peaks"], "expected waveform peaks"

    status_path = Path(segmenter.TMP_DIR) / "segmenter_status.json"
    status = json.loads(status_path.read_text(encoding="utf-8"))
    event_status = status.get("event", {})
    assert event_status.get("partial_waveform_path", "").endswith(".waveform.json")

    rec.flush(10)


def test_adaptive_threshold_updates(monkeypatch):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)

    ctrl = segmenter.AdaptiveRmsController(
        frame_ms=20,
        initial_linear_threshold=300,
        cfg_section={
            "enabled": True,
            "min_thresh": 0.001,
            "margin": 1.1,
            "update_interval_sec": 0.05,
            "window_sec": 0.1,
            "hysteresis_tolerance": 0.0,
        },
        debug=False,
    )

    initial = ctrl.threshold_linear
    values = [800, 900, 1000, 1100, 1200]
    observations = []
    for val in values:
        ctrl.observe(val, voiced=False)
        observations.append(ctrl.pop_observation())
        fake_time[0] += 0.05

    assert ctrl.threshold_linear > initial
    assert ctrl.last_p95 is not None
    assert ctrl.last_candidate is not None
    applied = [obs for obs in observations if obs]
    assert applied, "expected at least one adaptive observation"
    assert any(obs.updated for obs in applied)


def test_adaptive_threshold_hysteresis(monkeypatch):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)

    ctrl = segmenter.AdaptiveRmsController(
        frame_ms=20,
        initial_linear_threshold=500,
        cfg_section={
            "enabled": True,
            "min_thresh": 0.0,
            "margin": 1.0,
            "update_interval_sec": 0.05,
            "window_sec": 0.1,
            "hysteresis_tolerance": 0.5,
        },
        debug=False,
    )

    baseline = ctrl.threshold_linear
    ctrl.observe(520, voiced=False)
    first_obs = ctrl.pop_observation()
    fake_time[0] += 0.05
    ctrl.observe(540, voiced=False)
    second_obs = ctrl.pop_observation()

    # Change < 50% => no update
    assert ctrl.threshold_linear == baseline
    if first_obs:
        assert not first_obs.updated
    if second_obs:
        assert not second_obs.updated


def test_streaming_drop_forces_offline_encode(tmp_path, monkeypatch):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    rec_dir = tmp_path / "rec"
    tmp_dir = tmp_path / "tmp"
    rec_dir.mkdir()
    tmp_dir.mkdir()
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", True)
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 5)
    monkeypatch.setattr(segmenter.TimelineRecorder, "event_counters", collections.defaultdict(int))

    encoder_instances: list[object] = []

    class FakeEncoder:
        def __init__(self, partial_path: str, *, container_format: str = "opus") -> None:
            self.partial_path = partial_path
            self.container_format = container_format
            self._drops = 0
            self._bytes = 0
            self._feeds = 0
            encoder_instances.append(self)

        def start(self) -> None:
            Path(self.partial_path).parent.mkdir(parents=True, exist_ok=True)
            Path(self.partial_path).write_bytes(b"")

        def feed(self, chunk: bytes) -> bool:
            self._feeds += 1
            if self._feeds >= 2:
                self._drops += 1
                return False
            with open(self.partial_path, "ab") as handle:
                handle.write(chunk)
            self._bytes += len(chunk)
            return True

        def close(self, *, timeout: float | None = None):
            return segmenter.StreamingEncoderResult(
                partial_path=self.partial_path,
                success=True,
                returncode=0,
                error=None,
                stderr=None,
                bytes_sent=self._bytes,
                dropped_chunks=self._drops,
            )

    monkeypatch.setattr(segmenter, "StreamingOpusEncoder", FakeEncoder)

    captured: dict[str, object | None] = {}

    def fake_enqueue(tmp_wav_path: str, base_name: str, *, source: str = "live", existing_opus_path: str | None = None):
        captured["tmp_wav_path"] = tmp_wav_path
        captured["base_name"] = base_name
        captured["existing_opus_path"] = existing_opus_path
        return 123

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    rec = TimelineRecorder()
    for i in range(8):
        rec.ingest(make_frame(2000), i)
    rec.flush(20)

    assert encoder_instances, "expected streaming encoder to be initialised"
    encoder = encoder_instances[0]
    partial_path = Path(encoder.partial_path)
    assert not partial_path.exists(), "partial stream should be discarded when drops occur"
    assert getattr(encoder, "_drops", 0) > 0

    assert "existing_opus_path" in captured
    assert captured.get("existing_opus_path") is None, "fallback encode should not reuse streaming output"


def _write_constant_wav(path: Path, sample: int, frames: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(segmenter.SAMPLE_WIDTH)
        wav_file.setframerate(segmenter.SAMPLE_RATE)
        sample_bytes = sample.to_bytes(2, "little", signed=True)
        wav_file.writeframes(sample_bytes * frames)


def test_startup_recovery_requeues_and_cleans(tmp_path, monkeypatch):
    rec_dir = tmp_path / "rec"
    tmp_dir = tmp_path / "tmp"
    rec_dir.mkdir()
    tmp_dir.mkdir()

    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))

    calls: list[tuple[str, str, str, str | None]] = []

    def fake_enqueue(tmp_wav_path: str, base_name: str, *, source: str = "live", existing_opus_path: str | None = None):
        calls.append((tmp_wav_path, base_name, source, existing_opus_path))
        return len(calls)

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    wav_path = tmp_dir / "12-00-00_Both_1.wav"
    _write_constant_wav(wav_path, sample=1000, frames=segmenter.SAMPLE_RATE // 10)
    ts = datetime(2025, 1, 1, 12, 0, 0).timestamp()
    os.utime(wav_path, (ts, ts))

    day_dir = rec_dir / "20250101"
    day_dir.mkdir()
    partial_path = day_dir / "12-00-00_Both_1.partial.opus"
    partial_path.write_bytes(b"partial")
    partial_waveform = partial_path.with_name(partial_path.name + ".waveform.json")
    partial_waveform.write_text("{}", encoding="utf-8")

    rms_value = segmenter._estimate_rms_from_file(wav_path)
    expected_final_base = segmenter._derive_final_base(wav_path, rms_value)
    filtered_path = day_dir / f".{expected_final_base}.filtered.12345.opus"
    filtered_path.write_bytes(b"tmp")

    report = segmenter.perform_startup_recovery()

    assert calls, "expected encode job to be requeued"
    tmp_arg, base_arg, source_arg, existing_arg = calls[0]
    assert tmp_arg == str(wav_path)
    assert base_arg == expected_final_base
    assert source_arg == "recovery"
    assert existing_arg is None

    assert report.requeued == [expected_final_base]
    assert not partial_path.exists()
    assert not partial_waveform.exists()
    assert not filtered_path.exists()
    assert wav_path.exists()
    assert any(str(partial_path) == entry for entry in report.removed_artifacts)
    assert report.removed_wavs == []


def test_startup_recovery_skips_when_final_exists(tmp_path, monkeypatch):
    rec_dir = tmp_path / "rec"
    tmp_dir = tmp_path / "tmp"
    rec_dir.mkdir()
    tmp_dir.mkdir()

    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))

    calls: list[tuple[str, str, str, str | None]] = []

    def fake_enqueue(tmp_wav_path: str, base_name: str, *, source: str = "live", existing_opus_path: str | None = None):
        calls.append((tmp_wav_path, base_name, source, existing_opus_path))
        return len(calls)

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    wav_path = tmp_dir / "13-00-00_Both_2.wav"
    _write_constant_wav(wav_path, sample=500, frames=segmenter.SAMPLE_RATE // 10)
    ts = datetime(2025, 1, 2, 13, 0, 0).timestamp()
    os.utime(wav_path, (ts, ts))

    day_dir = rec_dir / "20250102"
    day_dir.mkdir()
    rms_value = segmenter._estimate_rms_from_file(wav_path)
    expected_final_base = segmenter._derive_final_base(wav_path, rms_value)
    final_extension = segmenter.STREAMING_EXTENSION if segmenter.STREAMING_EXTENSION.startswith(".") else f".{segmenter.STREAMING_EXTENSION}"
    final_path = day_dir / f"{expected_final_base}{final_extension}"
    final_path.write_bytes(b"final")

    report = segmenter.perform_startup_recovery()

    assert not calls, "final recording already exists so no encode job expected"
    assert not wav_path.exists()
    assert str(wav_path) in report.removed_wavs


def test_event_base_name_uses_prepad(monkeypatch, tmp_path):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "NOTIFIER", None)
    rec_dir = tmp_path / "rec"
    tmp_dir = tmp_path / "tmp"
    rec_dir.mkdir()
    tmp_dir.mkdir()
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 75, raising=False)
    monkeypatch.setattr(segmenter.TimelineRecorder, "event_counters", collections.defaultdict(int))
    monkeypatch.setattr(segmenter, "_enqueue_encode_job", lambda *args, **kwargs: None)

    fake_now = datetime(2024, 1, 2, 0, 0, 1, 200000, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(segmenter.time, "time", lambda: fake_now)

    rec = TimelineRecorder()

    for i in range(74):
        rec.ingest(make_frame(0), i)

    rec.ingest(make_frame(2000), 74)

    prebuf_seconds = (75 - 1) * (segmenter.FRAME_MS / 1000.0)
    expected_epoch = fake_now - prebuf_seconds
    expected_time = datetime.fromtimestamp(expected_epoch).strftime("%H-%M-%S")
    expected_day = time.strftime("%Y%m%d", time.localtime(expected_epoch))

    assert rec.base_name.startswith(expected_time)
    assert rec.event_timestamp == expected_time
    assert rec.event_started_epoch == pytest.approx(expected_epoch)
    assert rec.event_day == expected_day

    rec.flush(200)


def test_adaptive_threshold_recovery(monkeypatch):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)

    ctrl = segmenter.AdaptiveRmsController(
        frame_ms=20,
        initial_linear_threshold=300,
        cfg_section={
            "enabled": True,
            "min_thresh": 0.001,
            "margin": 1.1,
            "update_interval_sec": 0.05,
            "window_sec": 0.2,
            "hysteresis_tolerance": 0.0,
            "release_percentile": 0.5,
        },
        debug=False,
    )

    for _ in range(10):
        ctrl.observe(1200, voiced=False)
        ctrl.pop_observation()
        fake_time[0] += 0.05

    raised = ctrl.threshold_linear
    assert raised > 300

    lowering_observations = []
    for _ in range(10):
        ctrl.observe(200, voiced=False)
        lowering_observations.append(ctrl.pop_observation())
        fake_time[0] += 0.05

    lowered = ctrl.threshold_linear
    assert lowered < raised

    expected_norm = min(
        ctrl.max_thresh_norm,
        max(
            ctrl.min_thresh_norm,
            (200 / segmenter.AdaptiveRmsController._NORM) * ctrl.margin,
        ),
    )
    expected_linear = int(round(expected_norm * segmenter.AdaptiveRmsController._NORM))
    assert lowered == expected_linear
    assert any(obs and obs.updated for obs in lowering_observations)


def test_adaptive_threshold_ceiling(monkeypatch):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)

    ctrl = segmenter.AdaptiveRmsController(
        frame_ms=20,
        initial_linear_threshold=300,
        cfg_section={
            "enabled": True,
            "min_thresh": 0.001,
            "max_rms": 500,
            "margin": 1.2,
            "update_interval_sec": 0.05,
            "window_sec": 0.2,
            "hysteresis_tolerance": 0.0,
            "release_percentile": 0.5,
        },
        debug=False,
    )

    ceiling_linear = ctrl.max_threshold_linear
    assert ceiling_linear == 500

    for _ in range(12):
        ctrl.observe(2500, voiced=False)
        ctrl.pop_observation()
        fake_time[0] += 0.05

    assert ctrl.threshold_linear == ceiling_linear

    for _ in range(12):
        ctrl.observe(200, voiced=False)
        ctrl.pop_observation()
        fake_time[0] += 0.05

    assert ctrl.threshold_linear < ceiling_linear


def test_adaptive_rms_logs_and_status_update(monkeypatch, tmp_path):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    def wall():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)
    monkeypatch.setattr(segmenter.time, "time", wall)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "enabled", True)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "update_interval_sec", 0.05)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "window_sec", 0.1)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "hysteresis_tolerance", 0.0)
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_path))
    monkeypatch.setattr(segmenter, "is_voice", lambda *_: False)

    logs: list[tuple[object, bool]] = []

    def fake_print(message, flush=False):
        logs.append((message, flush))

    monkeypatch.setattr(builtins, "print", fake_print)

    status_calls: list[dict] = []
    original_update = segmenter.TimelineRecorder._update_capture_status

    def tracking_update(self, capturing, *, event=None, last_event=None, reason=None, extra=None):
        status_calls.append({
            "extra": extra,
            "threshold": self._adaptive.threshold_linear,
        })
        return original_update(self, capturing, event=event, last_event=last_event, reason=reason, extra=extra)

    monkeypatch.setattr(segmenter.TimelineRecorder, "_update_capture_status", tracking_update)

    rec = TimelineRecorder()
    status_calls.clear()

    frame = make_frame(400)
    for idx in range(6):
        rec.ingest(frame, idx)
        fake_time[0] += 0.05

    rec.audio_q.put(None)
    rec.writer.join(timeout=1)

    pattern = re.compile(
        r"\[segmenter\] adaptive RMS threshold updated: prev=(\d+) new=(\d+) "
        r"\(p95=([0-9.]+), margin=([0-9.]+), release_pctl=([0-9.]+), release=([0-9.]+)\)"
    )
    observation_logs = [
        entry[0]
        for entry in logs
        if isinstance(entry[0], str)
        and entry[0].startswith("[segmenter] adaptive RMS threshold updated:")
    ]
    assert observation_logs, "expected adaptive RMS threshold update logs"
    matches = [pattern.match(line) for line in observation_logs]
    assert all(matches), "adaptive RMS log entries should match expected format"
    threshold_calls = [call for call in status_calls if call["extra"] is None]
    assert threshold_calls, "expected capture status updates for threshold observations"
    unique_thresholds: list[int] = []
    for call in threshold_calls:
        threshold = int(call["threshold"])
        if not unique_thresholds or unique_thresholds[-1] != threshold:
            unique_thresholds.append(threshold)
    assert len(unique_thresholds) == len(observation_logs)


def test_adaptive_rms_updates_with_voiced_frames_during_capture(monkeypatch, tmp_path):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    def wall():
        return fake_time[0]

    def perf_counter():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)
    monkeypatch.setattr(segmenter.time, "time", wall)
    monkeypatch.setattr(segmenter.time, "perf_counter", perf_counter)

    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))

    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "enabled", True)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "update_interval_sec", 0.05)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "window_sec", 0.1)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "hysteresis_tolerance", 0.0)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "margin", 1.05)
    monkeypatch.setitem(segmenter.cfg["adaptive_rms"], "voiced_hold_sec", 0.1)

    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 2)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 4)
    monkeypatch.setattr(segmenter, "POST_PAD", 40, raising=False)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 2, raising=False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_MIN_FRAMES", 0, raising=False)
    monkeypatch.setattr(segmenter, "_enqueue_encode_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(segmenter, "_normalized_load", lambda: 0.0)

    class DummyWaveform:
        def __init__(self, *_, **__):
            pass

        def add_frame(self, *_):
            pass

        def close(self):  # pragma: no cover - exercised indirectly
            pass

    monkeypatch.setattr(segmenter, "LiveWaveformWriter", DummyWaveform)
    monkeypatch.setattr(segmenter, "is_voice", lambda *_: True)

    rec = TimelineRecorder()
    initial_threshold = rec._adaptive.threshold_linear

    frame = make_frame(1200)
    for idx in range(25):
        rec.ingest(frame, idx)
        fake_time[0] += 0.02

    assert rec._adaptive.threshold_linear > initial_threshold
    assert rec.active is False

    rec.audio_q.put(None)
    rec.writer.join(timeout=1)

def test_rms_matches_constant_signal():
    buf = make_frame(1200)
    assert segmenter.rms(buf) == 1200


def test_apply_gain_scales_and_clips(monkeypatch):
    buf = (32000).to_bytes(2, 'little', signed=True) * 2
    monkeypatch.setattr(segmenter, "GAIN", 0.5)
    half = segmenter.TimelineRecorder._apply_gain(buf)
    assert read_sample(half) == 16000

    sample = (3).to_bytes(2, 'little', signed=True)
    scaled_down = segmenter.TimelineRecorder._apply_gain(sample)
    assert read_sample(scaled_down) == 1

    monkeypatch.setattr(segmenter, "GAIN", 2.0)
    doubled = segmenter.TimelineRecorder._apply_gain(buf)
    assert read_sample(doubled) == segmenter.INT16_MAX
    assert read_sample(doubled, 1) == segmenter.INT16_MAX

    neg_buf = (-32000).to_bytes(2, 'little', signed=True)
    monkeypatch.setattr(segmenter, "GAIN", 2.0)
    clipped_neg = segmenter.TimelineRecorder._apply_gain(neg_buf)
    assert read_sample(clipped_neg) == segmenter.INT16_MIN

    monkeypatch.setattr(segmenter, "GAIN", 0.5)
    neg_sample = (-3).to_bytes(2, 'little', signed=True)
    scaled_neg = segmenter.TimelineRecorder._apply_gain(neg_sample)
    assert read_sample(scaled_neg) == -2


def test_filter_chain_metrics_emit_structured_logs(monkeypatch, tmp_path):
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_path))
    monkeypatch.setattr(segmenter, "FILTER_CHAIN_AVG_BUDGET_MS", 0.5)
    monkeypatch.setattr(segmenter, "FILTER_CHAIN_PEAK_BUDGET_MS", 1.0)
    monkeypatch.setattr(segmenter, "FILTER_CHAIN_LOG_THROTTLE_SEC", 0.0)
    monkeypatch.setattr(segmenter, "DEBUG_VERBOSE", False)

    fake_perf = [0.0]

    def perf_counter():
        current = fake_perf[0]
        fake_perf[0] += 0.005
        return current

    fake_monotonic = [0.0]

    def monotonic():
        return fake_monotonic[0]

    logs: list[str] = []

    def fake_print(*args, **kwargs):  # pragma: no cover - trivial passthrough
        if not args:
            logs.append("")
        elif len(args) == 1:
            logs.append(str(args[0]))
        else:
            logs.append(" ".join(str(arg) for arg in args))

    captured_extras: list[dict | None] = []

    def fake_update(self, capturing, *, event=None, last_event=None, reason=None, extra=None):
        captured_extras.append(extra)
        self._status_cache = {"capturing": capturing}

    monkeypatch.setattr(segmenter.time, "perf_counter", perf_counter)
    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)
    monkeypatch.setattr("builtins.print", fake_print)
    monkeypatch.setattr(segmenter.TimelineRecorder, "_update_capture_status", fake_update, raising=False)

    recorder = TimelineRecorder()

    fake_monotonic[0] = 10.0
    recorder.ingest(make_frame(2000), 0)
    fake_monotonic[0] = 11.0
    recorder.ingest(make_frame(2000), 1)

    assert recorder._filter_avg_ms >= 5.0
    assert recorder._filter_peak_ms >= recorder._filter_avg_ms

    structured_logs = [entry for entry in logs if entry.startswith("{")]
    assert structured_logs, "filter chain overages should emit structured logs"
    payload = json.loads(structured_logs[-1])
    assert payload["event"] == "filter_chain_budget_exceeded"
    assert payload["avg_ms"] >= 5.0
    assert payload["avg_budget_ms"] == pytest.approx(segmenter.FILTER_CHAIN_AVG_BUDGET_MS)
    assert payload["peak_budget_ms"] == pytest.approx(segmenter.FILTER_CHAIN_PEAK_BUDGET_MS)

    extras_with_metrics = [entry for entry in captured_extras if entry and "filter_chain_avg_ms" in entry]
    assert extras_with_metrics, "capture status updates should include filter metrics"
    latest = extras_with_metrics[-1]
    assert latest["filter_chain_avg_ms"] >= 5.0
    assert latest["filter_chain_avg_budget_ms"] == pytest.approx(segmenter.FILTER_CHAIN_AVG_BUDGET_MS)
    assert latest["filter_chain_peak_budget_ms"] == pytest.approx(segmenter.FILTER_CHAIN_PEAK_BUDGET_MS)
