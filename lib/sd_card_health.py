"""Utility helpers for reporting SD card health status on the dashboard."""

from __future__ import annotations

import json
import os
from typing import Any, Dict

_DEFAULT_STATE_PATH = "/apps/tricorder/tmp/sd_card_health.json"


def _state_path() -> str:
    override = os.environ.get("TRICORDER_SD_HEALTH_STATE")
    if override:
        return override
    tmp_root = os.environ.get("TRICORDER_TMP")
    if tmp_root:
        return os.path.join(tmp_root, "sd_card_health.json")
    return _DEFAULT_STATE_PATH


def load_state(path: str | None = None) -> Dict[str, Any]:
    """Load the cached SD card health information from disk.

    The health monitor writes a JSON document with various telemetry fields.
    When the file is missing or unreadable we return an empty mapping so
    callers can gracefully fall back to defaults.
    """

    state_path = path or _state_path()
    try:
        with open(state_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def state_summary(state: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize raw state into a compact structure for API consumers."""

    summary: Dict[str, Any] = {
        "status": "unknown",
        "last_checked": None,
        "lifetime_hours": None,
        "warnings": [],
    }

    if not isinstance(state, dict):
        return summary

    status = state.get("status")
    if isinstance(status, str) and status:
        summary["status"] = status

    last_checked = state.get("last_checked") or state.get("updated_at")
    if isinstance(last_checked, (int, float, str)):
        summary["last_checked"] = last_checked

    lifetime_hours = state.get("lifetime_hours")
    if isinstance(lifetime_hours, (int, float)):
        summary["lifetime_hours"] = float(lifetime_hours)

    warnings = state.get("warnings") or state.get("errors")
    if isinstance(warnings, list):
        summary["warnings"] = [str(item) for item in warnings if item is not None]

    return summary


__all__ = ["load_state", "state_summary"]
