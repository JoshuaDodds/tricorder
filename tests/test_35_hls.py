from __future__ import annotations

import json
import logging
import queue
import shutil
import time

from lib.ffmpeg_io import DEFAULT_THREAD_QUEUE_SIZE
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


def test_hlstee_stop_cleans_outputs(tmp_path):
    tee = HLSTee(out_dir=str(tmp_path), sample_rate=48000)

    playlist = tmp_path / "live.m3u8"
    segment = tmp_path / "seg00001.ts"
    playlist.write_text("#EXTM3U", encoding="utf-8")
    segment.write_bytes(b"dummy")

    tee.stop()

    assert not playlist.exists()
    assert not segment.exists()


def test_hlstee_ignores_legacy_extra_args(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="hls_mux")
    tee = HLSTee(
        out_dir=str(tmp_path),
        sample_rate=48000,
        legacy_extra_ffmpeg_args=["--legacy-flag"],
    )
    cmd = tee._build_ffmpeg_command()

    assert "--legacy-flag" not in cmd
    assert any("deprecated" in record.message for record in caplog.records)


def test_hlstee_thread_queue_size_precedes_input(tmp_path):
    tee = HLSTee(out_dir=str(tmp_path), sample_rate=48000)

    cmd = tee._build_ffmpeg_command()

    queue_idx = cmd.index("-thread_queue_size")
    input_idx = cmd.index("-i")

    assert queue_idx < input_idx
    assert cmd[queue_idx + 1] == str(DEFAULT_THREAD_QUEUE_SIZE)
    assert cmd[input_idx + 1] == "pipe:0"


def test_hlstee_warns_on_filter_args_when_chain_enabled(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="hls_mux")
    caplog.clear()

    HLSTee(
        out_dir=str(tmp_path),
        sample_rate=48000,
        legacy_extra_ffmpeg_args=["-af", "highpass=f=80"],
        filter_chain_enabled=True,
    )

    assert any("audio.filter_chain" in record.message for record in caplog.records)


def test_live_stream_filter_chain_flag_respects_disabled_stages(monkeypatch):
    import copy
    import importlib

    from lib import config as config_module
    import lib.live_stream_daemon as live_stream_daemon

    original_cfg = copy.deepcopy(config_module.get_cfg())
    disabled_cfg = copy.deepcopy(original_cfg)
    disabled_cfg["audio"]["filter_chain"] = {
        "enabled": True,
        "highpass": {"enabled": False},
        "notch": {"enabled": False},
        "spectral_gate": {"enabled": False},
        "filters": [],
    }

    monkeypatch.setattr(config_module, "_cfg_cache", disabled_cfg, raising=False)
    module = importlib.reload(live_stream_daemon)

    assert module.FILTER_CHAIN is None
    assert module.AUDIO_FILTER_CHAIN_ENABLED is False

    monkeypatch.setattr(config_module, "_cfg_cache", original_cfg, raising=False)
    importlib.reload(live_stream_daemon)


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


def test_hls_controller_state_persistence(monkeypatch, tmp_path):
    state_path = tmp_path / "controller_state.json"

    writer = _HLSController()
    writer.set_state_path(str(state_path), persist=True)
    writer.set_cooldown(0.0)
    writer.attach(DummyHLSTee())

    assert writer.client_connected(session_id="one") == 1
    assert writer.client_connected(session_id="two") == 2

    with state_path.open("r", encoding="utf-8") as handle:
        saved = json.load(handle)
    assert saved["clients"] == 2
    assert set(saved["sessions"]) == {"one", "two"}

    reader = _HLSController()
    reader.attach(DummyHLSTee())
    reader.set_cooldown(0.5)
    reader.set_state_path(str(state_path), persist=False)

    assert reader.refresh_from_state() == 2
    assert reader.active_clients == 2
    assert reader.status()["encoder_running"] is True

    stops: list[float] = []

    def fake_schedule(seconds: float) -> None:
        stops.append(seconds)

    monkeypatch.setattr(reader, "_schedule_stop_after", fake_schedule)

    assert writer.client_disconnected(session_id="one") == 1
    assert writer.client_disconnected(session_id="two") == 0

    assert reader.refresh_from_state() == 0
    assert stops == [0.5]


def test_hls_controller_shared_encoder_running_state(tmp_path):
    state_path = tmp_path / "controller_state.json"

    server = _HLSController()
    server.set_state_path(str(state_path), persist=True)
    server.set_cooldown(0.0)

    assert server.client_connected(session_id="cli") == 1

    daemon = _HLSController()
    tee = DummyHLSTee()
    daemon.attach(tee)
    daemon.set_state_path(str(state_path), persist=True)
    daemon.set_cooldown(0.0)

    assert daemon.refresh_from_state() == 1
    assert tee.started == 1
    assert daemon.status()["encoder_running"] is True

    server.refresh_from_state()
    assert server.status()["encoder_running"] is True

    assert server.client_disconnected(session_id="cli") == 0

    daemon.refresh_from_state()
    daemon.stop_now()

    server.refresh_from_state()

    deadline = time.monotonic() + 0.25
    final_status = server.status()
    while final_status["encoder_running"] is True and time.monotonic() < deadline:
        time.sleep(0.01)
        server.refresh_from_state()
        final_status = server.status()

    assert final_status["encoder_running"] is False
