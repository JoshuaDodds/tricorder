import pytest

from room_tuner import _apply_notch_filters, _clone_filter_chain, _filter_slot_capacity


def test_clone_filter_chain_from_sequence():
    original = [
        {"type": "notch", "frequency": 60.0, "q": 20.0},
        {"type": "notch", "frequency": 120.0, "q": 25.0},
    ]
    cloned = _clone_filter_chain(original)
    assert isinstance(cloned, dict)
    assert cloned["filters"] == original
    # ensure original list not reused
    assert cloned["filters"] is not original


def test_filter_slot_capacity_counts_filters():
    chain = {"filters": [{"type": "notch"}, {"type": "notch"}, "ignored"]}
    assert _filter_slot_capacity(chain) == 2


def test_apply_notch_filters_updates_stage_and_extras():
    existing = {
        "notch": {"enabled": False, "freq_hz": 60.0, "quality": 30.0},
        "filters": [{"type": "notch", "frequency": 70.0, "q": 15.0}],
    }
    recommendations = [
        {"type": "notch", "frequency": 59.9, "q": 22.5, "gain_db": -18.0},
        {"type": "notch", "frequency": 119.8, "q": 18.0, "gain_db": -18.0},
    ]
    updated = _apply_notch_filters(existing, recommendations, keep_count=2)

    assert updated is not existing
    assert updated["notch"]["enabled"] is True
    assert pytest.approx(updated["notch"]["freq_hz"], rel=0, abs=1e-6) == recommendations[0]["frequency"]
    assert pytest.approx(updated["notch"]["quality"], rel=0, abs=1e-6) == recommendations[0]["q"]
    assert updated["filters"] == [recommendations[1]]
    # original dict remains unchanged
    assert existing["notch"]["enabled"] is False
    assert existing["filters"][0]["frequency"] == 70.0


def test_apply_notch_filters_single_entry_clears_filters():
    existing = {"notch": {"enabled": False, "freq_hz": 60.0, "quality": 30.0}}
    recommendation = [{"type": "notch", "frequency": 61.25, "q": 17.5}]
    updated = _apply_notch_filters(existing, recommendation, keep_count=1)

    assert "filters" not in updated
    assert updated["notch"]["enabled"] is True
    assert pytest.approx(updated["notch"]["freq_hz"], rel=0, abs=1e-6) == recommendation[0]["frequency"]
    assert pytest.approx(updated["notch"]["quality"], rel=0, abs=1e-6) == recommendation[0]["q"]
    # original dict remains unchanged
    assert existing["notch"]["enabled"] is False
