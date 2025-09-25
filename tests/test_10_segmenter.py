# tests/test_10_segmenter.py
from lib.segmenter import TimelineRecorder, FRAME_BYTES
import lib.segmenter as segmenter


def make_frame(value: int = 1000):
    """Return a dummy audio frame of constant value."""
    return value.to_bytes(2, 'little', signed=True) * (FRAME_BYTES // 2)


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


def test_notifier_receives_event(monkeypatch, tmp_path):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "_enqueue_encode_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(segmenter, "is_voice", lambda buf: True)

    tmp_root = tmp_path / "tricorder"
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_root / "tmp"))
    monkeypatch.setattr(segmenter, "REC_DIR", str(tmp_root / "rec"))

    class DummyNotifier:
        def __init__(self):
            self.events = []

        def handle_event(self, event):
            self.events.append(event)

    dummy = DummyNotifier()
    monkeypatch.setattr(segmenter, "NOTIFIER", dummy)

    rec = TimelineRecorder()
    for idx in range(segmenter.START_CONSECUTIVE + 10):
        rec.ingest(make_frame(2000), idx)
    rec.flush(200)

    assert dummy.events, "Notification should have been dispatched"
    event = dummy.events[0]
    assert event["etype"] in {"Human", "Both"}
    assert event["trigger_rms"] >= segmenter.STATIC_RMS_THRESH
    assert event.get("end_reason")
