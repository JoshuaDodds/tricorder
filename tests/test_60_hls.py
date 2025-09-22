from __future__ import annotations

import queue
import shutil

from lib.hls_controller import _HLSController
from lib.hls_mux import HLSTee


def test_hlstee_restart_clears_stop_event(monkeypatch, tmp_path):
    """start() should clear the stop flag so a restarted encoder actually runs."""
    start_flags = queue.Queue()

    def fake_run(self):
        start_flags.put(self._stop.is_set())
        # Wait until stop() sets the flag so the thread can exit.
        self._stop.wait(timeout=1.0)

    monkeypatch.setattr(shutil, "which", lambda _: "/usr/bin/ffmpeg")
    monkeypatch.setattr(HLSTee, "_run", fake_run, raising=False)

    tee = HLSTee(out_dir=str(tmp_path), sample_rate=48000)

    tee.start()
    first_run_flag = start_flags.get(timeout=1.0)
    assert first_run_flag is False
    tee.stop()

    tee.start()
    second_run_flag = start_flags.get(timeout=1.0)
    assert second_run_flag is False
    tee.stop()


class DummyHLSTee:
    def __init__(self):
        self.started = 0
        self.stopped = 0
        self._t = None

    def start(self):
        self.started += 1
        self._t = object()

    def stop(self):
        self.stopped += 1
        self._t = None


def test_hls_controller_client_lifecycle(monkeypatch):
    controller = _HLSController()
    tee = DummyHLSTee()
    controller.attach(tee)
    controller.set_cooldown(0.0)

    assert controller.client_connected() == 1
    assert tee.started == 1
    assert controller.active_clients == 1
    assert controller.status()["encoder_running"] is True

    controller.client_connected()
    assert tee.started == 1
    assert controller.active_clients == 2

    scheduled: list[float] = []

    def fake_schedule(seconds: float) -> None:
        scheduled.append(seconds)
        tee.stop()

    monkeypatch.setattr(controller, "_schedule_stop_after", fake_schedule)

    assert controller.client_disconnected() == 1
    assert tee.stopped == 0

    assert controller.client_disconnected() == 0
    assert scheduled == [0.0]
    assert tee.stopped == 1
    assert controller.status()["encoder_running"] is False

    controller.ensure_started()
    assert tee.started == 2
    controller.stop_now()


def test_hls_controller_deduplicates_sessions():
    controller = _HLSController()
    tee = DummyHLSTee()
    controller.attach(tee)
    controller.set_cooldown(0.0)

    assert controller.client_connected(session_id="abc") == 1
    assert tee.started == 1
    assert controller.client_connected(session_id="abc") == 1
    assert controller.active_clients == 1

    assert controller.client_connected(session_id="def") == 2
    assert controller.active_clients == 2

    assert controller.client_disconnected(session_id="zzz") == 2
    assert controller.active_clients == 2

    assert controller.client_disconnected(session_id="abc") == 1
    assert controller.client_disconnected(session_id="def") == 0
