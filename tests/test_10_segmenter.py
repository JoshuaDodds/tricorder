# tests/test_10_segmenter.py
import builtins
import collections
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import pytest

from lib.segmenter import TimelineRecorder, FRAME_BYTES
from lib.motion_state import MOTION_STATE_FILENAME, store_motion_state
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


def test_manual_split_starts_new_event(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)

    def fake_strftime(fmt: str, *_args: object) -> str:
        if fmt == "%Y%m%d":
            return "20240102"
        if fmt == "%H-%M-%S":
            return "12-34-56"
        return "12-34-56"

    monkeypatch.setattr(segmenter.time, "strftime", fake_strftime)
    monkeypatch.setattr(segmenter.time, "time", lambda: 1_700_000_000.0)

    original_counters = segmenter.TimelineRecorder.event_counters
    segmenter.TimelineRecorder.event_counters = collections.defaultdict(int)

    captured_jobs: list[tuple[str, str, str, str | None, bool, str | None]] = []

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str,
        existing_opus_path: str | None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ):
        captured_jobs.append((tmp_wav_path, base_name, source, existing_opus_path, manual_recording, target_day))
        return len(captured_jobs)

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    rec = TimelineRecorder()

    try:
        for idx in range(3):
            rec.ingest(make_frame(4000), idx)

        assert rec.active
        first_base = rec.base_name
        assert first_base

        assert rec.request_manual_split() is True
        rec.ingest(make_frame(4000), 3)

        assert captured_jobs, "expected encode job for manual split"

        assert rec.active
        assert rec.base_name
        assert rec.base_name != first_base
        assert rec.base_name.endswith("_Both_2")
    finally:
        rec.flush(10)
        segmenter.TimelineRecorder.event_counters = original_counters


def test_autosplit_limit_rotates_event(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)

    limit_frames = 3
    limit_seconds = (limit_frames * segmenter.FRAME_MS) / 1000.0
    monkeypatch.setattr(segmenter, "_AUTOSPLIT_LIMIT_FRAMES", limit_frames)
    monkeypatch.setattr(segmenter, "_AUTOSPLIT_LIMIT_SECONDS", limit_seconds)

    original_counters = segmenter.TimelineRecorder.event_counters
    segmenter.TimelineRecorder.event_counters = collections.defaultdict(int)

    captured_jobs: list[tuple[str, str, str, str | None, bool, str | None]] = []

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str,
        existing_opus_path: str | None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ) -> int:
        captured_jobs.append(
            (
                tmp_wav_path,
                base_name,
                source,
                existing_opus_path,
                manual_recording,
                target_day,
            )
        )
        return len(captured_jobs)

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    rec = TimelineRecorder()

    try:
        for idx in range(8):
            rec.ingest(make_frame(4000), idx)

        assert captured_jobs, "expected autosplit to finalize an event"
    finally:
        rec.flush(8)
        segmenter.TimelineRecorder.event_counters = original_counters

    assert len(captured_jobs) >= 2
    base_names = {entry[1] for entry in captured_jobs}
    assert len(base_names) >= 2


def test_manual_split_no_active_event(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")

    rec = TimelineRecorder()
    try:
        assert rec.request_manual_split() is False
    finally:
        rec.flush(0)


def test_manual_record_toggle_updates_status_and_encode(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)

    manual_flags: list[bool] = []

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str,
        existing_opus_path: str | None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ):
        manual_flags.append(manual_recording)
        assert target_day is not None
        return len(manual_flags)

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    rec = TimelineRecorder()

    try:
        rec.set_manual_recording(True)
        cache = rec._status_cache or {}
        assert cache.get("manual_recording") is True

        rec.ingest(make_frame(4000), 0)
        assert rec.active is True

        rec.set_manual_recording(False)
        assert rec._manual_recording is False
        cache = rec._status_cache or {}
        assert cache.get("manual_recording") is False
        assert manual_flags == [True]
    finally:
        rec.flush(5)


def test_motion_state_forced_recording(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME
    store_motion_state(motion_state_path, motion_active=True, timestamp=50.0)

    rec = TimelineRecorder()

    try:
        rec.ingest(make_frame(0), 0)
        assert rec.active is True
        assert rec._motion_forced_active is True

        status = rec._status_cache or {}
        event = status.get("event") or {}
        assert event.get("motion_active") is True
        assert event.get("motion_started_epoch") == 50.0
        motion_state = status.get("motion_state") or {}
        assert motion_state.get("motion_active") is True

        store_motion_state(motion_state_path, motion_active=False, timestamp=75.0)
        rec._motion_watcher.force_refresh()
        rec._refresh_motion_state()
        assert rec._motion_forced_active is False
        rec.ingest(make_frame(0), 1)

        assert rec.active is False
        cached = rec._status_cache or {}
        last_event = cached.get("last_event") or {}
        assert last_event.get("motion_active") is False
        assert last_event.get("motion_started_epoch") == 50.0
        cached_motion_state = cached.get("motion_state") or {}
        assert cached_motion_state.get("motion_active") is False
    finally:
        rec.flush(3)


def test_motion_padding_delays_release(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)
    monkeypatch.setattr(segmenter, "MOTION_RELEASE_PADDING_SECONDS", 120.0)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME
    store_motion_state(motion_state_path, motion_active=True, timestamp=100.0)

    clock = {"now": 100.0}

    def fake_time():
        return clock["now"]

    monkeypatch.setattr(segmenter.time, "time", fake_time)
    monkeypatch.setattr(segmenter.time, "monotonic", fake_time)

    rec = TimelineRecorder()

    try:
        rec.ingest(make_frame(0), 0)
        assert rec._motion_forced_active is True

        clock["now"] = 130.0
        store_motion_state(motion_state_path, motion_active=False, timestamp=130.0)
        rec._motion_watcher.force_refresh()
        rec._refresh_motion_state()
        assert rec._motion_forced_active is True
        deadline = getattr(rec, "_motion_release_deadline", None)
        assert deadline is not None
        assert deadline == pytest.approx(250.0, rel=0.001)
        status = rec._status_cache or {}
        motion_state = status.get("motion_state") or {}
        assert motion_state.get("motion_active") is False

        clock["now"] = 249.0
        rec._refresh_motion_state()
        assert rec._motion_forced_active is True
        remaining = rec._motion_status_extra().get("motion_padding_seconds_remaining")
        assert remaining is not None and remaining > 0
        status = rec._status_cache or {}
        motion_state = status.get("motion_state") or {}
        assert motion_state.get("motion_active") is False

        clock["now"] = 252.5
        rec._refresh_motion_state()
        assert rec._motion_forced_active is False
        assert getattr(rec, "_motion_release_deadline", None) is None
        assert rec._motion_status_extra().get("motion_padding_seconds_remaining") == 0.0
        status = rec._status_cache or {}
        motion_state = status.get("motion_state") or {}
        assert motion_state.get("motion_active") is False
    finally:
        rec.flush(3)


def test_manual_stop_clears_motion_when_release_seen(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)

    original_counters = segmenter.TimelineRecorder.event_counters
    segmenter.TimelineRecorder.event_counters = collections.defaultdict(int)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME

    rec = TimelineRecorder()

    try:
        rec.set_manual_recording(True)
        rec.ingest(make_frame(4000), 0)

        store_motion_state(motion_state_path, motion_active=True, timestamp=25.0)
        rec._motion_watcher.force_refresh()
        rec._refresh_motion_state()
        assert rec._motion_forced_active is True

        store_motion_state(motion_state_path, motion_active=False, timestamp=30.0)
        rec._motion_watcher.force_refresh()
        rec._refresh_motion_state()
        assert rec._motion_forced_active is False

        rec.set_manual_recording(False)
        rec.ingest(make_frame(0), 1)

        assert rec.active is False
        assert rec._motion_forced_active is False
    finally:
        rec.flush(5)
        segmenter.TimelineRecorder.event_counters = original_counters


def test_manual_stop_resumes_motion_when_still_active(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)

    original_counters = segmenter.TimelineRecorder.event_counters
    segmenter.TimelineRecorder.event_counters = collections.defaultdict(int)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME

    rec = TimelineRecorder()

    try:
        rec.set_manual_recording(True)
        rec.ingest(make_frame(4000), 0)

        store_motion_state(motion_state_path, motion_active=True, timestamp=45.0)
        rec._motion_watcher.force_refresh()
        rec._refresh_motion_state()
        assert rec._motion_forced_active is True

        rec.set_manual_recording(False)
        rec.ingest(make_frame(0), 1)

        assert rec.active is True
        assert rec._motion_forced_active is True
        assert rec._event_manual_recording is False
    finally:
        rec.flush(5)
        segmenter.TimelineRecorder.event_counters = original_counters


def test_request_manual_stop_finalizes_active_event(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)

    original_counters = segmenter.TimelineRecorder.event_counters
    segmenter.TimelineRecorder.event_counters = collections.defaultdict(int)

    rec = TimelineRecorder()

    try:
        rec.ingest(make_frame(4000), 0)

        assert rec.active is True
        assert rec.request_manual_stop() is True

        rec.ingest(make_frame(0), 1)

        assert rec.active is False
        assert rec.request_manual_stop() is False
    finally:
        rec.flush(5)
        segmenter.TimelineRecorder.event_counters = original_counters


def test_motion_payload_includes_offsets(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)

    rec = TimelineRecorder()

    try:
        rec.event_started_epoch = 100.0
        frame_span = max(1, int(round(2000 / segmenter.FRAME_MS)))
        rec.frames_written = frame_span
        rec._current_motion_event_start = 101.25
        rec._current_motion_event_end = 101.75
        rec._motion_event_segments = [{"start": 101.25, "end": 101.75}]

        payload = rec._current_motion_event_payload(duration_seconds=2.0)
        assert payload["motion_started_epoch"] == pytest.approx(101.25)
        assert payload["motion_released_epoch"] == pytest.approx(101.75)
        assert payload["motion_trigger_offset_seconds"] == pytest.approx(1.25)
        assert payload["motion_release_offset_seconds"] == pytest.approx(1.75)
        assert payload["motion_segments"] == [
            {"start": pytest.approx(1.25), "end": pytest.approx(1.75)}
        ]
    finally:
        rec.flush(0)


def test_auto_record_toggle_blocks_rms(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "AUTO_RECORD_MOTION_OVERRIDE", True)

    rec = TimelineRecorder()

    try:
        rec.set_auto_recording_enabled(False)
        cache = rec._status_cache or {}
        assert cache.get("auto_recording_enabled") is False

        rec.ingest(make_frame(4000), 0)
        assert rec.active is False

        rec.set_auto_recording_enabled(True)
        cache = rec._status_cache or {}
        assert cache.get("auto_recording_enabled") is True

        rec.ingest(make_frame(4000), 1)
        assert rec.active is True
    finally:
        rec.flush(0)


def test_auto_record_motion_override_allows_capture(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "AUTO_RECORD_MOTION_OVERRIDE", True)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME
    store_motion_state(motion_state_path, motion_active=True, timestamp=25.0)

    rec = TimelineRecorder()

    try:
        assert rec._motion_forced_active is True
        rec.set_auto_recording_enabled(False)
        rec.ingest(make_frame(4000), 0)
        assert rec.active is True
    finally:
        rec.flush(0)


def test_auto_record_motion_override_disabled_blocks_motion(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "AUTO_RECORD_MOTION_OVERRIDE", False)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME
    store_motion_state(motion_state_path, motion_active=True, timestamp=40.0)

    rec = TimelineRecorder()

    try:
        assert rec._motion_forced_active is True
        rec.set_auto_recording_enabled(False)
        rec.ingest(make_frame(4000), 0)
        assert rec.active is False
    finally:
        rec.flush(0)

def test_motion_override_event_uses_rms_after_motion_release(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "is_voice", lambda buf: any(buf))
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "KEEP_WINDOW", 1)
    monkeypatch.setattr(segmenter, "AUTO_RECORD_MOTION_OVERRIDE", True)
    monkeypatch.setattr(segmenter, "MOTION_RELEASE_PADDING_SECONDS", 0.0)

    motion_state_path = tmp_dir / MOTION_STATE_FILENAME
    store_motion_state(motion_state_path, motion_active=True, timestamp=50.0)

    rec = TimelineRecorder()

    try:
        rec.set_auto_recording_enabled(False)
        rec.ingest(make_frame(4000), 0)
        assert rec.active is True
        assert rec._motion_override_event_active is True

        store_motion_state(motion_state_path, motion_active=False, timestamp=55.0)
        rec._motion_watcher.force_refresh()
        rec._refresh_motion_state()
        assert rec._motion_forced_active is False
        rec.ingest(make_frame(4000), 1)
        assert rec.active is True
        assert rec._motion_override_event_active is True

        rec.ingest(make_frame(0), 2)
        rec.ingest(make_frame(0), 3)
        assert rec.active is False
        assert rec._motion_override_event_active is False

        rec.ingest(make_frame(4000), 4)
        assert rec.active is False
    finally:
        rec.flush(0)


def test_motion_payload_tracks_multiple_segments(monkeypatch, tmp_path):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)

    rec = TimelineRecorder()

    try:
        rec.event_started_epoch = 100.0
        rec.frames_written = max(1, int(round(20000 / segmenter.FRAME_MS)))
        rec._motion_event_segments = [
            {"start": 105.0, "end": 110.0},
            {"start": 112.0, "end": 115.0},
        ]
        rec._current_motion_event_start = 105.0
        rec._current_motion_event_end = 115.0

        payload = rec._current_motion_event_payload(duration_seconds=20.0)
        assert payload["motion_trigger_offset_seconds"] == pytest.approx(5.0)
        assert payload["motion_release_offset_seconds"] == pytest.approx(15.0)
        assert payload["motion_segments"] == [
            {"start": pytest.approx(5.0), "end": pytest.approx(10.0)},
            {"start": pytest.approx(12.0), "end": pytest.approx(15.0)},
        ]
    finally:
        rec.flush(0)


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

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str,
        existing_opus_path: str | None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ):
        captured_job["base"] = base_name
        captured_job["existing"] = existing_opus_path
        captured_job["source"] = source
        captured_job["manual"] = manual_recording
        captured_job["target_day"] = target_day
        return 42

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)
    monkeypatch.setattr(segmenter.TimelineRecorder, "event_counters", collections.defaultdict(int))

    rec = TimelineRecorder()
    for idx in range(4):
        rec.ingest(make_frame(2000), idx)

    rec.writer_queue_drops = 3
    rec.streaming_queue_drops = 0

    rec.flush(10)

    encoder = captured_encoder.get("instance")
    assert encoder is not None and getattr(encoder, "started", False)

    existing_path = captured_job.get("existing")
    assert existing_path, "expected parallel output to be reused"
    assert Path(existing_path).exists()
    assert existing_path.endswith(segmenter.STREAMING_EXTENSION)
    assert Path(existing_path).parent == rec_dir / "20240102"
    assert captured_job.get("target_day") == "20240102"
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


def test_adaptive_min_floor_defaults_to_static_threshold(monkeypatch):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)

    static_threshold = 360
    ctrl = segmenter.AdaptiveRmsController(
        frame_ms=20,
        initial_linear_threshold=static_threshold,
        cfg_section={
            "enabled": True,
            "min_thresh": 0.0,
            "margin": 1.0,
            "update_interval_sec": 0.1,
            "window_sec": 0.1,
            "hysteresis_tolerance": 0.0,
        },
        debug=False,
    )

    expected_norm = static_threshold / segmenter.AdaptiveRmsController._NORM
    assert math.isclose(ctrl.min_thresh_norm, expected_norm, rel_tol=1e-6)


def test_adaptive_min_rms_floor_holds(monkeypatch):
    fake_time = [0.0]

    def monotonic():
        return fake_time[0]

    monkeypatch.setattr(segmenter.time, "monotonic", monotonic)

    ctrl = segmenter.AdaptiveRmsController(
        frame_ms=20,
        initial_linear_threshold=800,
        cfg_section={
            "enabled": True,
            "min_rms": 400,
            "margin": 1.0,
            "update_interval_sec": 0.05,
            "window_sec": 0.1,
            "hysteresis_tolerance": 0.0,
        },
        debug=False,
    )

    for _ in range(8):
        ctrl.observe(200, voiced=False)
        ctrl.pop_observation()
        fake_time[0] += 0.05

    assert ctrl.threshold_linear >= 400


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

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str = "live",
        existing_opus_path: str | None = None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ):
        captured["tmp_wav_path"] = tmp_wav_path
        captured["base_name"] = base_name
        captured["existing_opus_path"] = existing_opus_path
        captured["manual_recording"] = manual_recording
        captured["target_day"] = target_day
        return 123

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    rec = TimelineRecorder()
    for i in range(8):
        rec.ingest(make_frame(2000), i)
    expected_day = rec.event_day
    assert expected_day is not None
    rec.flush(20)

    assert encoder_instances, "expected streaming encoder to be initialised"
    encoder = encoder_instances[0]
    partial_path = Path(encoder.partial_path)
    assert not partial_path.exists(), "partial stream should be discarded when drops occur"
    assert getattr(encoder, "_drops", 0) > 0

    assert "existing_opus_path" in captured
    assert captured.get("existing_opus_path") is None, "fallback encode should not reuse streaming output"
    assert captured.get("target_day") == expected_day


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

    calls: list[tuple[str, str, str, str | None, bool, str | None]] = []

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str = "live",
        existing_opus_path: str | None = None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ):
        calls.append((tmp_wav_path, base_name, source, existing_opus_path, manual_recording, target_day))
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
    tmp_arg, base_arg, source_arg, existing_arg, manual_flag, target_day = calls[0]
    assert tmp_arg == str(wav_path)
    assert base_arg == expected_final_base
    assert source_arg == "recovery"
    assert manual_flag is False
    expected_extension = segmenter.STREAMING_EXTENSION
    if not expected_extension.startswith("."):
        expected_extension = f".{expected_extension}"
    expected_opus = day_dir / f"{expected_final_base}{expected_extension}"
    assert target_day == day_dir.name
    assert existing_arg == str(expected_opus)

    assert report.requeued == [expected_final_base]
    assert not partial_path.exists()
    assert not partial_waveform.exists()
    assert not filtered_path.exists()
    assert wav_path.exists()
    assert str(partial_path) not in report.removed_artifacts
    assert str(partial_waveform) not in report.removed_artifacts
    assert report.removed_wavs == []


def test_startup_recovery_skips_when_final_exists(tmp_path, monkeypatch):
    rec_dir = tmp_path / "rec"
    tmp_dir = tmp_path / "tmp"
    rec_dir.mkdir()
    tmp_dir.mkdir()

    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))

    calls: list[tuple[str, str, str, str | None, bool, str | None]] = []

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str = "live",
        existing_opus_path: str | None = None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ):
        calls.append((tmp_wav_path, base_name, source, existing_opus_path, manual_recording, target_day))
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


def test_encode_completion_emits_recordings_changed(monkeypatch, tmp_path):
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir()
    day_dir = rec_dir / "20240102"
    day_dir.mkdir()

    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "ENCODING_STATUS", segmenter.EncodingStatus())

    events: list[tuple[str, dict[str, object]]] = []

    def fake_publish(event_type, payload):
        events.append((event_type, payload))

    monkeypatch.setattr(segmenter.dashboard_events, "publish", fake_publish)

    job_id = segmenter.ENCODING_STATUS.enqueue("20240102_Both_RMS-321_1", source="live")
    final_path = day_dir / "20240102_Both_RMS-321_1.opus"

    segmenter._schedule_recordings_refresh(
        job_id,
        final_path=str(final_path),
        base_name="20240102_Both_RMS-321_1",
        day="20240102",
        manual=False,
        source="live",
    )

    assert events == []

    final_path.write_bytes(b"opus")

    segmenter.ENCODING_STATUS.mark_finished(job_id)

    assert any(
        event_type == "recordings_changed"
        and payload.get("reason") == "encode_completed"
        and payload.get("paths") == ["20240102/20240102_Both_RMS-321_1.opus"]
        for event_type, payload in events
    )


def test_enqueue_encode_job_defers_when_queue_full(monkeypatch):
    queue_obj = queue.Queue(maxsize=1)
    queue_obj.put(("occupied",))
    monkeypatch.setattr(segmenter, "ENCODE_QUEUE", queue_obj, raising=False)
    monkeypatch.setattr(segmenter, "_ensure_encoder_worker", lambda: None)
    monkeypatch.setattr(segmenter, "_ENCODE_WORKERS", [], raising=False)
    monkeypatch.setattr(segmenter, "_ENCODE_DISPATCHER", None, raising=False)
    monkeypatch.setattr(segmenter, "_DEFERRED_LOCK", threading.Lock(), raising=False)
    deferred = collections.deque()
    event = threading.Event()
    monkeypatch.setattr(segmenter, "_DEFERRED_ENCODE_JOBS", deferred, raising=False)
    monkeypatch.setattr(segmenter, "_DEFERRED_EVENT", event, raising=False)

    statuses = segmenter.EncodingStatus()
    monkeypatch.setattr(segmenter, "ENCODING_STATUS", statuses, raising=False)

    job_id = segmenter._enqueue_encode_job("/tmp/path.wav", "20240102_Both_RMS-321_1")

    assert job_id is not None
    assert len(deferred) == 1
    snapshot = statuses.snapshot()
    assert snapshot is not None
    pending = snapshot.get("pending", [])
    assert pending and pending[0]["queue_state"] == "deferred"


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


def test_encode_job_uses_event_day_when_crossing_midnight(tmp_path, monkeypatch):
    tmp_dir = tmp_path / "tmp"
    rec_dir = tmp_path / "rec"
    tmp_dir.mkdir()
    rec_dir.mkdir()

    monkeypatch.setattr(segmenter, "TMP_DIR", str(tmp_dir))
    monkeypatch.setattr(segmenter, "REC_DIR", str(rec_dir))
    monkeypatch.setattr(segmenter, "PARALLEL_TMP_DIR", os.path.join(str(tmp_dir), "parallel"))
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "STREAMING_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "PARALLEL_ENCODE_ENABLED", False)
    monkeypatch.setattr(segmenter, "START_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "KEEP_CONSECUTIVE", 1)
    monkeypatch.setattr(segmenter, "POST_PAD_FRAMES", 1)
    monkeypatch.setattr(segmenter, "PRE_PAD_FRAMES", 1)

    real_strftime = segmenter.time.strftime
    overrides = ["20241009", "20241010", "20241010"]

    def fake_strftime(fmt: str, *args):
        if fmt == "%Y%m%d" and overrides:
            return overrides.pop(0)
        return real_strftime(fmt, *args)

    monkeypatch.setattr(segmenter.time, "strftime", fake_strftime)

    captured: dict[str, str | None] = {}

    def fake_enqueue(
        tmp_wav_path: str,
        base_name: str,
        *,
        source: str = "live",
        existing_opus_path: str | None = None,
        manual_recording: bool = False,
        target_day: str | None = None,
    ) -> int | None:
        captured["target_day"] = target_day
        return 7

    monkeypatch.setattr(segmenter, "_enqueue_encode_job", fake_enqueue)

    rec = TimelineRecorder()
    rec.ingest(make_frame(4000), 0)
    rec.flush(10)

    assert captured.get("target_day") == "20241009"


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


def test_live_waveform_writer_preserves_start_and_trigger(tmp_path):
    destination = tmp_path / "waveform.json"
    writer = segmenter.LiveWaveformWriter(
        str(destination),
        bucket_count=8,
        update_interval=0.0,
        start_epoch=123.456,
        trigger_rms=789,
    )
    writer.add_frame(make_frame(1000))
    writer.finalize()

    with destination.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    assert payload["start_epoch"] == pytest.approx(123.456, rel=0, abs=1e-6)
    assert payload["trigger_rms"] == 789


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


def test_encoder_worker_pins_affinity(monkeypatch):
    calls: dict[str, object] = {}

    def fake_run(cmd, *, capture_output, text, check, env, preexec_fn):  # noqa: D401 - signature matches subprocess
        calls["cmd"] = cmd
        calls["preexec_fn"] = preexec_fn
        calls["env"] = env
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(segmenter.subprocess, "run", fake_run)
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")
    monkeypatch.setattr(segmenter, "MIN_CLIP_SECONDS", 1.75)

    job_queue: queue.Queue = queue.Queue()
    worker = segmenter._EncoderWorker(job_queue)
    worker.start()
    job_queue.put((123, "/tmp/sample.wav", "sample", None))
    job_queue.put(None)
    worker.join(timeout=2.0)

    assert not worker.is_alive(), "worker should exit after sentinel"
    assert calls["cmd"][0] == "/bin/true"
    assert calls["preexec_fn"] is segmenter._set_single_core_affinity
    assert calls["env"].get("ENCODER_MIN_CLIP_SECONDS") == "1.75"


def test_encode_script_fast_path_skips_ffmpeg(tmp_path):
    repo_root = Path(__file__).resolve().parents[1]
    script_path = repo_root / "bin" / "encode_and_store.sh"

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()

    ffmpeg_stub = stub_bin / "ffmpeg"
    ffmpeg_stub.write_text("#!/usr/bin/env bash\nexit 42\n", encoding="utf-8")
    ffmpeg_stub.chmod(0o755)

    systemd_stub = stub_bin / "systemd-cat"
    systemd_stub.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    systemd_stub.chmod(0o755)

    recordings_dir = tmp_path / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    existing_opus = recordings_dir / "stream.opus"
    existing_opus.write_bytes(b"opus")
    waveform = existing_opus.with_suffix(existing_opus.suffix + ".waveform.json")
    waveform.write_text("{}", encoding="utf-8")
    transcript = existing_opus.with_suffix(existing_opus.suffix + ".transcript.json")
    transcript.write_text("{}", encoding="utf-8")
    wav_path = tmp_path / "capture.wav"
    wav_path.write_bytes(b"wavdata")

    env = os.environ.copy()
    env["PATH"] = f"{stub_bin}:{env['PATH']}"
    env["PYTHONPATH"] = str(repo_root)
    env["ENCODER_PYTHON"] = sys.executable
    env["DENOISE"] = "0"
    env["STREAMING_CONTAINER_FORMAT"] = "opus"
    env["STREAMING_EXTENSION"] = ".opus"
    env["ENCODER_RECORDINGS_DIR"] = str(recordings_dir)

    result = subprocess.run(
        [str(script_path), str(wav_path), "sample", str(existing_opus)],
        env=env,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert not wav_path.exists(), "temporary WAV should be removed"
    assert existing_opus.exists(), "existing clip should remain when threshold is disabled"

    day = time.strftime("%Y%m%d", time.localtime())
    raw_dir = tmp_path / "recordings" / ".original_wav" / day
    raw_files = list(raw_dir.glob("sample*.wav"))
    assert len(raw_files) == 1, "original WAV should be preserved"

    metadata = json.loads(waveform.read_text(encoding="utf-8"))
    expected_rel = f".original_wav/{day}/{raw_files[0].name}"
    assert metadata.get("raw_audio_path") == expected_rel


def test_encode_script_discards_short_new_clips(tmp_path):
    repo_root = Path(__file__).resolve().parents[1]
    script_path = repo_root / "bin" / "encode_and_store.sh"

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()

    ffmpeg_stub = stub_bin / "ffmpeg"
    ffmpeg_stub.write_text(
        "#!/usr/bin/env bash\nout=\"${@: -1}\"\nmkdir -p \"$(dirname \"$out\")\"\nprintf 'fake' > \"$out\"\nexit 0\n",
        encoding="utf-8",
    )
    ffmpeg_stub.chmod(0o755)

    ffprobe_stub = stub_bin / "ffprobe"
    ffprobe_stub.write_text("#!/usr/bin/env bash\necho 0.5\nexit 0\n", encoding="utf-8")
    ffprobe_stub.chmod(0o755)

    systemd_stub = stub_bin / "systemd-cat"
    systemd_stub.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    systemd_stub.chmod(0o755)

    wav_path = tmp_path / "capture.wav"
    wav_path.write_bytes(b"wavdata")

    env = os.environ.copy()
    env["PATH"] = f"{stub_bin}:{env['PATH']}"
    env["PYTHONPATH"] = str(repo_root)
    env["ENCODER_PYTHON"] = sys.executable
    env["DENOISE"] = "0"
    env["STREAMING_CONTAINER_FORMAT"] = "opus"
    env["STREAMING_EXTENSION"] = ".opus"
    env["ENCODER_RECORDINGS_DIR"] = str(tmp_path / "recordings")
    env["ENCODER_MIN_CLIP_SECONDS"] = "1.0"

    result = subprocess.run(
        [str(script_path), str(wav_path), "sample"],
        env=env,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert not wav_path.exists(), "temporary WAV should be removed"
    recordings_dir = tmp_path / "recordings"
    recycle_root = recordings_dir / ".recycle_bin"
    assert recycle_root.is_dir(), "recycle bin directory should be created"
    entries = list(recycle_root.iterdir())
    assert len(entries) == 1, "short clip should produce a recycle bin entry"
    entry_dir = entries[0]
    stored_files = list(entry_dir.iterdir())
    assert any(file.name.endswith(".opus") for file in stored_files), "audio should be moved into recycle bin"
    metadata_path = entry_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    day = time.strftime("%Y%m%d", time.localtime())
    assert metadata.get("original_path") == f"{day}/sample.opus"
    assert metadata.get("duration_seconds") == pytest.approx(0.5, rel=1e-6)
    assert metadata.get("reason") == "short_clip"
    assert metadata.get("waveform_name") in ("", None)
    assert metadata.get("transcript_name") in ("", None)
    remaining_opus = list((recordings_dir / day).glob("*.opus")) if (recordings_dir / day).exists() else []
    assert not remaining_opus, "no short clips should remain in the recordings directory"
    raw_dir = recordings_dir / ".original_wav"
    assert not raw_dir.exists(), "original WAVs should not be preserved for discarded clips"


def test_encode_script_skips_filters_for_short_streaming_clip(tmp_path):
    repo_root = Path(__file__).resolve().parents[1]
    script_path = repo_root / "bin" / "encode_and_store.sh"

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()

    ffmpeg_stub = stub_bin / "ffmpeg"
    ffmpeg_stub.write_text("#!/usr/bin/env bash\necho 'ffmpeg should not run' >&2\nexit 99\n", encoding="utf-8")
    ffmpeg_stub.chmod(0o755)

    ffprobe_stub = stub_bin / "ffprobe"
    ffprobe_stub.write_text("#!/usr/bin/env bash\necho 0.6\nexit 0\n", encoding="utf-8")
    ffprobe_stub.chmod(0o755)

    systemd_stub = stub_bin / "systemd-cat"
    systemd_stub.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    systemd_stub.chmod(0o755)

    recordings_dir = tmp_path / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    existing_opus = recordings_dir / "stream.opus"
    existing_opus.write_bytes(b"opus")
    waveform = existing_opus.with_suffix(existing_opus.suffix + ".waveform.json")
    waveform.write_text("{}", encoding="utf-8")
    transcript = existing_opus.with_suffix(existing_opus.suffix + ".transcript.json")
    transcript.write_text("{}", encoding="utf-8")
    wav_path = tmp_path / "capture.wav"
    wav_path.write_bytes(b"wavdata")

    env = os.environ.copy()
    env["PATH"] = f"{stub_bin}:{env['PATH']}"
    env["PYTHONPATH"] = str(repo_root)
    env["ENCODER_PYTHON"] = sys.executable
    env["DENOISE"] = "1"
    env["STREAMING_CONTAINER_FORMAT"] = "opus"
    env["STREAMING_EXTENSION"] = ".opus"
    env["ENCODER_RECORDINGS_DIR"] = str(recordings_dir)
    env["ENCODER_MIN_CLIP_SECONDS"] = "1.0"

    result = subprocess.run(
        [str(script_path), str(wav_path), "sample", str(existing_opus)],
        env=env,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert not wav_path.exists(), "temporary WAV should be removed"
    assert not existing_opus.exists(), "short streaming clips should be moved from the recordings directory"
    assert not waveform.exists(), "waveform sidecar should be moved for short clips"
    assert not transcript.exists(), "transcript sidecar should be moved for short clips"
    recycle_root = recordings_dir / ".recycle_bin"
    assert recycle_root.is_dir(), "recycle bin should exist after moving a short clip"
    entries = list(recycle_root.iterdir())
    assert len(entries) == 1, "short streaming clip should create a recycle bin entry"
    entry_dir = entries[0]
    metadata_path = entry_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata.get("duration_seconds") == pytest.approx(0.6, rel=1e-6)
    assert metadata.get("original_path") == "stream.opus"
    raw_dir = recordings_dir / ".original_wav"
    if raw_dir.exists():
        assert not any(raw_dir.rglob("*.wav")), "no original WAV should remain for discarded streaming clips"

