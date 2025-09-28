# tests/test_10_segmenter.py
from lib.segmenter import TimelineRecorder, FRAME_BYTES
import lib.segmenter as segmenter


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
