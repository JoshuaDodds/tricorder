# tests/test_10_segmenter.py
import importlib
import os
import queue

import lib.config as config
import lib.segmenter as segmenter
from lib.segmenter import FRAME_BYTES, TimelineRecorder


def make_frame(value: int = 1000):
    """Return a dummy audio frame of constant value."""
    return value.to_bytes(2, 'little', signed=True) * (FRAME_BYTES // 2)


def read_sample(buf: bytes, idx: int = 0) -> int:
    start = idx * 2
    return int.from_bytes(buf[start:start + 2], 'little', signed=True)


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
    for val in values:
        ctrl.observe(val, voiced=False)
        fake_time[0] += 0.05

    assert ctrl.threshold_linear > initial
    assert ctrl.last_p95 is not None
    assert ctrl.last_candidate is not None


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
    fake_time[0] += 0.05
    ctrl.observe(540, voiced=False)

    # Change < 50% => no update
    assert ctrl.threshold_linear == baseline


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
        fake_time[0] += 0.05

    raised = ctrl.threshold_linear
    assert raised > 300

    for _ in range(10):
        ctrl.observe(200, voiced=False)
        fake_time[0] += 0.05

    lowered = ctrl.threshold_linear
    assert lowered < raised

    expected_norm = max(
        ctrl.min_thresh_norm,
        (200 / segmenter.AdaptiveRmsController._NORM) * ctrl.margin,
    )
    expected_linear = int(round(expected_norm * segmenter.AdaptiveRmsController._NORM))
    assert lowered == expected_linear


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


def test_custom_event_tags_used_for_events(monkeypatch, tmp_path):
    monkeypatch.setenv("EVENT_TAG_HUMAN", "Speech")
    monkeypatch.setenv("EVENT_TAG_OTHER", "Noise")
    monkeypatch.setenv("EVENT_TAG_BOTH", "SpeechNoise")
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    importlib.reload(segmenter)

    captured: dict[str, str] = {}

    def fake_enqueue(tmp_wav_path: str, base_name: str) -> None:
        captured["base"] = base_name

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    def fake_status(self, capturing, *, event=None, last_event=None, reason=None, extra=None):
        if last_event:
            captured["last_event"] = last_event

    monkeypatch.setattr(segmenter.TimelineRecorder, "_update_capture_status", fake_status, raising=False)
    monkeypatch.setattr(segmenter.TimelineRecorder, "_q_send", lambda self, item: None, raising=False)

    try:
        recorder = segmenter.TimelineRecorder()
        recorder.active = True
        recorder.base_name = "20250101T000000"
        recorder.event_timestamp = "20250101-000000"
        recorder.event_counter = 1
        recorder.trigger_rms = 640
        recorder.frames_written = 50
        recorder.sum_rms = 32000
        recorder.saw_voiced = True
        recorder.saw_loud = False
        recorder.event_started_epoch = 0.0
        recorder.done_q = queue.Queue()
        recorder.done_q.put((str(tmp_path / "tmp.wav"), "tmp_base"))

        recorder._finalize_event(reason="test")

        assert captured["last_event"]["etype"] == "Speech"
        assert "Speech" in captured["base"]
    finally:
        monkeypatch.delenv("EVENT_TAG_HUMAN", raising=False)
        monkeypatch.delenv("EVENT_TAG_OTHER", raising=False)
        monkeypatch.delenv("EVENT_TAG_BOTH", raising=False)
        monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
        importlib.reload(segmenter)


def test_custom_event_tag_sanitized_for_file_names(monkeypatch, tmp_path):
    dirty_tag = "Speech/../High"
    monkeypatch.setenv("EVENT_TAG_BOTH", dirty_tag)
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    importlib.reload(segmenter)

    captured: dict[str, str] = {}

    def fake_enqueue(tmp_wav_path: str, base_name: str) -> None:
        captured["base"] = base_name

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)
    monkeypatch.setattr(segmenter.TimelineRecorder, "_update_capture_status", lambda *args, **kwargs: None, raising=False)
    monkeypatch.setattr(segmenter.TimelineRecorder, "_q_send", lambda self, item: None, raising=False)

    try:
        recorder = segmenter.TimelineRecorder()
        recorder.active = True
        recorder.base_name = "20250101T000000"
        recorder.event_timestamp = "20250101-000000"
        recorder.event_counter = 1
        recorder.trigger_rms = 640
        recorder.frames_written = 50
        recorder.sum_rms = 32000
        recorder.saw_voiced = True
        recorder.saw_loud = True
        recorder.event_started_epoch = 0.0
        recorder.done_q = queue.Queue()
        recorder.done_q.put((str(tmp_path / "tmp.wav"), "tmp_base"))

        recorder._finalize_event(reason="test sanitize")

        safe_tag = segmenter._sanitize_event_tag(dirty_tag)
        assert "base" in captured
        assert captured["base"].count(os.sep) == 0
        assert ".." not in captured["base"]
        assert safe_tag in captured["base"]
    finally:
        monkeypatch.delenv("EVENT_TAG_BOTH", raising=False)
        monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
        importlib.reload(segmenter)
