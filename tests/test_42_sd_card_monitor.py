from pathlib import Path

from lib import sd_card_health
from lib.sd_card_monitor import SdCardMonitor


def test_monitor_falls_back_to_volatile_on_persist_error(tmp_path, monkeypatch):
    primary = tmp_path / "persist.json"
    volatile = tmp_path / "volatile.json"
    cid_path = tmp_path / "cid"
    cid_path.write_text("abcd\n", encoding="utf-8")

    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_DIR", volatile.parent)
    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_PATH", volatile)

    monitor = SdCardMonitor(
        poll_interval=5,
        state_path=primary,
        cid_path=cid_path,
        volatile_state_path=volatile,
    )

    original_store = sd_card_health._store_state

    def flaky_store(state, state_path=None):
        target = Path(state_path) if state_path else sd_card_health.STATE_PATH
        if target == primary:
            raise OSError("read-only")
        return original_store(state, state_path)

    monkeypatch.setattr(sd_card_health, "_store_state", flaky_store)

    line = "kernel: mmcblk0: io error"
    changed = monitor._process_line(line)
    assert changed is True
    assert volatile.exists()

    fallback_state = sd_card_health.load_state(
        state_path=primary,
        fallback_path=volatile,
    )
    assert fallback_state["warning_active"] is True
    assert fallback_state["last_event"]["pattern"] == "io_error"

    monkeypatch.setattr(sd_card_health, "_store_state", original_store)

    second_line = "kernel: mmcblk0: io error recovered"
    changed_second = monitor._process_line(second_line)
    assert changed_second is True
    assert not volatile.exists()

    persisted_state = sd_card_health.load_state(
        state_path=primary,
        fallback_path=volatile,
    )
    assert persisted_state["warning_active"] is True
    assert persisted_state["last_event"]["message"].endswith("recovered")


def test_sync_cid_uses_volatile_on_persist_error(tmp_path, monkeypatch):
    primary = tmp_path / "persist.json"
    volatile = tmp_path / "volatile.json"
    cid_path = tmp_path / "cid"
    cid_path.write_text("abcd\n", encoding="utf-8")

    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_DIR", volatile.parent)
    monkeypatch.setattr(sd_card_health, "VOLATILE_STATE_PATH", volatile)

    monitor = SdCardMonitor(
        poll_interval=5,
        state_path=primary,
        cid_path=cid_path,
        volatile_state_path=volatile,
    )

    original_store = sd_card_health._store_state

    def flaky_store(state, state_path=None):
        target = Path(state_path) if state_path else sd_card_health.STATE_PATH
        if target == primary:
            raise OSError("read-only")
        return original_store(state, state_path)

    monkeypatch.setattr(sd_card_health, "_store_state", flaky_store)

    monitor._sync_cid()
    assert volatile.exists()

    cached_state = sd_card_health.load_state(
        state_path=primary,
        fallback_path=volatile,
    )
    assert cached_state["cid"] == "abcd"

    monkeypatch.setattr(sd_card_health, "_store_state", original_store)

    monitor._sync_cid()
    assert not volatile.exists()

    persisted_state = sd_card_health.load_state(
        state_path=primary,
        fallback_path=volatile,
    )
    assert persisted_state["cid"] == "abcd"
