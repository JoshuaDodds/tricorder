from pathlib import Path

import os
import time

from lib import sd_card_health


def test_load_state_defaults(tmp_path):
    state_path = tmp_path / "sd_state.json"
    state = sd_card_health.load_state(state_path)
    assert state["cid"] == ""
    assert state["warning_active"] is False
    assert state["last_event"] is None


def test_register_failure_sets_warning(tmp_path):
    state_path = tmp_path / "sd_state.json"
    state, changed = sd_card_health.register_failure(
        "mmcblk0: I/O error",
        pattern="io_error",
        state_path=state_path,
    )
    assert changed is True
    assert state["warning_active"] is True
    assert state["last_event"]["pattern"] == "io_error"
    assert isinstance(state["first_detected_at"], str)

    state_again, changed_again = sd_card_health.register_failure(
        "mmcblk0: I/O error",
        pattern="io_error",
        state_path=state_path,
    )
    assert state_again["warning_active"] is True
    assert state_again["last_event"]["timestamp"]


def test_sync_cid_transitions(tmp_path):
    state_path = tmp_path / "sd_state.json"

    result_missing = sd_card_health.sync_cid(None, state_path)
    assert result_missing.status == "missing"

    result_init = sd_card_health.sync_cid("abcd", state_path)
    assert result_init.status == "initialised"
    assert result_init.state["cid"] == "abcd"

    result_same = sd_card_health.sync_cid("abcd", state_path)
    assert result_same.status == "unchanged"

    state_after_warning, _ = sd_card_health.register_failure(
        "crc error",
        pattern="crc_error",
        state_path=state_path,
    )
    assert state_after_warning["warning_active"] is True

    result_replaced = sd_card_health.sync_cid("efgh", state_path)
    assert result_replaced.status == "replaced"
    assert result_replaced.state["cid"] == "efgh"
    assert result_replaced.state["warning_active"] is False


def test_state_summary_structure(tmp_path):
    state_path = tmp_path / "sd_state.json"
    sd_card_health.register_failure(
        "read-only filesystem remount",
        pattern="readonly_remount",
        state_path=state_path,
    )
    summary = sd_card_health.state_summary(sd_card_health.load_state(state_path))
    assert summary["warning_active"] is True
    assert summary["last_event"]["pattern"] == "readonly_remount"
    assert summary["has_baseline"] is False


def test_load_state_uses_volatile_fallback(tmp_path, monkeypatch):
    primary = tmp_path / "persist.json"
    volatile_dir = tmp_path / "volatile"
    volatile_dir.mkdir()
    volatile = volatile_dir / "sd_card_health.json"

    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_DIR", volatile_dir)
    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_PATH", volatile)

    sd_card_health.register_failure(
        "mmcblk0: io error",
        pattern="io_error",
        state_path=volatile,
    )

    state = sd_card_health.load_state(state_path=primary)
    assert state["warning_active"] is True
    assert state["last_event"]["pattern"] == "io_error"


def test_load_state_prefers_newer_volatile_state(tmp_path, monkeypatch):
    primary = tmp_path / "persist.json"
    volatile_dir = tmp_path / "volatile"
    volatile_dir.mkdir()
    volatile = volatile_dir / "sd_card_health.json"

    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_DIR", volatile_dir)
    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_PATH", volatile)

    sd_card_health.register_failure(
        "mmcblk0: io error", pattern="io_error", state_path=primary
    )
    os.utime(primary, (time.time() - 60, time.time() - 60))

    sd_card_health.register_failure(
        "mmcblk0: crc error", pattern="crc_error", state_path=volatile
    )

    state = sd_card_health.load_state(state_path=primary, fallback_path=volatile)
    assert state["last_event"]["pattern"] == "crc_error"


def test_load_state_prefers_flagged_volatile_state(tmp_path, monkeypatch):
    primary = tmp_path / "persist.json"
    volatile_dir = tmp_path / "volatile"
    volatile_dir.mkdir()
    volatile = volatile_dir / "sd_card_health.json"

    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_DIR", volatile_dir)
    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_PATH", volatile)

    sd_card_health.register_failure(
        "mmcblk0: io error", pattern="io_error", state_path=primary
    )

    sd_card_health.register_failure(
        "mmcblk0: crc error", pattern="crc_error", state_path=volatile
    )
    os.utime(volatile, (time.time() - 120, time.time() - 120))

    state = sd_card_health.load_state(state_path=primary, fallback_path=volatile)
    assert state["last_event"]["pattern"] == "crc_error"
