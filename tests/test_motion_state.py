from lib.motion_state import (
    MOTION_STATE_FILENAME,
    MotionStateWatcher,
    load_motion_state,
    store_motion_state,
)


def test_motion_state_persistence(tmp_path):
    state_path = tmp_path / MOTION_STATE_FILENAME

    initial = load_motion_state(state_path)
    assert initial.active is False
    assert initial.events == []

    activated = store_motion_state(state_path, motion_active=True, timestamp=100.0)
    assert activated.active is True
    assert activated.active_since == 100.0
    assert activated.events and activated.events[-1]["motion_active"] is True

    reloaded = load_motion_state(state_path)
    assert reloaded.active is True
    assert reloaded.active_since == 100.0
    assert len(reloaded.events) == 1

    # Same state should not append duplicate events but should retain active_since
    same_state = store_motion_state(state_path, motion_active=True, timestamp=150.0)
    assert same_state.active_since == 100.0
    assert len(same_state.events) == 1

    deactivated = store_motion_state(state_path, motion_active=False, timestamp=200.0)
    assert deactivated.active is False
    assert deactivated.active_since is None
    assert len(deactivated.events) == 2
    assert deactivated.events[-1]["motion_active"] is False


def test_motion_state_watcher_detects_changes(tmp_path):
    state_path = tmp_path / MOTION_STATE_FILENAME
    watcher = MotionStateWatcher(state_path, poll_interval=0.0)

    assert watcher.state.active is False

    store_motion_state(state_path, motion_active=True, timestamp=10.0)
    updated = watcher.force_refresh()
    assert updated.active is True
    assert updated.active_since == 10.0

    store_motion_state(state_path, motion_active=False, timestamp=20.0)
    updated = watcher.force_refresh()
    assert updated.active is False
    assert updated.active_since is None
