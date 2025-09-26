#!/usr/bin/env python3
"""Persistent SD card health state helpers.

This module centralises state management for the SD card warning feature. It is
used by the long-running monitor daemon and the web UI to read and persist the
"SD card failure" flag. The state is intentionally stored in a small JSON file
under ``/apps/tricorder/state`` so it survives reboots and service restarts.

The helpers here avoid any concurrency primitives; writers atomically replace
the state file to keep updates crash-safe. Callers should rely on
``sync_cid`` to capture the current CID baseline and ``register_failure`` to
record new fault events.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any, Dict, Tuple

__all__ = [
    "CID_PATH",
    "STATE_PATH",
    "VOLATILE_STATE_PATH",
    "load_state",
    "register_failure",
    "reset_state",
    "state_summary",
    "sync_cid",
    "write_state",
]


BASE_DIR = Path("/apps/tricorder")
STATE_DIR = BASE_DIR / "state"
STATE_PATH = STATE_DIR / "sd_card_health.json"
VOLATILE_STATE_DIR = Path("/run/tricorder")
VOLATILE_STATE_PATH = VOLATILE_STATE_DIR / "sd_card_health.json"
CID_PATH = Path("/sys/block/mmcblk0/device/cid")

_DEFAULT_STATE: Dict[str, Any] = {
    "cid": "",
    "warning_active": False,
    "first_detected_at": None,
    "first_detected_ts": None,
    "last_event": None,
    "updated_at": None,
}

_MAX_MESSAGE_LENGTH = 512


@dataclass
class SyncResult:
    """Return structure for :func:`sync_cid` operations."""

    state: Dict[str, Any]
    status: str


def _ensure_directory(path: Path) -> None:
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)


def _read_candidate(path: Path | None) -> tuple[Dict[str, Any], bool, float | None] | None:
    if not path:
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None
    except OSError:
        return None

    volatile_marker = False
    if isinstance(raw, dict):
        volatile_marker = bool(raw.get("_volatile_active"))
    state = _normalise_state(raw if isinstance(raw, dict) else None)

    try:
        metadata = path.stat()
    except OSError:
        mtime = None
    else:
        mtime = metadata.st_mtime

    return state, volatile_marker, mtime


def _isoformat(ts: float | None = None) -> str:
    value = ts if ts is not None else datetime.now(timezone.utc).timestamp()
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat(timespec="seconds")


def _truncate_message(message: str) -> str:
    cleaned = message.strip()
    if len(cleaned) <= _MAX_MESSAGE_LENGTH:
        return cleaned
    return cleaned[: _MAX_MESSAGE_LENGTH - 1].rstrip() + "…"


def _normalise_state(raw: Dict[str, Any] | None) -> Dict[str, Any]:
    state: Dict[str, Any] = dict(_DEFAULT_STATE)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if key in state:
                state[key] = value

    if not isinstance(state.get("cid"), str):
        state["cid"] = ""
    state["warning_active"] = bool(state.get("warning_active"))

    first_detected = state.get("first_detected_at")
    if isinstance(first_detected, str) and first_detected:
        state["first_detected_at"] = first_detected
    else:
        state["first_detected_at"] = None

    first_detected_ts = state.get("first_detected_ts")
    if isinstance(first_detected_ts, (int, float)):
        state["first_detected_ts"] = float(first_detected_ts)
    else:
        state["first_detected_ts"] = None

    last_event = state.get("last_event")
    if isinstance(last_event, dict):
        event: Dict[str, Any] = {}
        timestamp = last_event.get("timestamp")
        if isinstance(timestamp, str) and timestamp:
            event["timestamp"] = timestamp
        message = last_event.get("message")
        if isinstance(message, str) and message:
            event["message"] = _truncate_message(message)
        pattern = last_event.get("pattern")
        if isinstance(pattern, str) and pattern:
            event["pattern"] = pattern
        state["last_event"] = event if event else None
    else:
        state["last_event"] = None

    updated_at = state.get("updated_at")
    if isinstance(updated_at, str) and updated_at:
        state["updated_at"] = updated_at
    else:
        state["updated_at"] = None

    return state


def load_state(
    state_path: Path | None = None,
    *,
    fallback_path: Path | None = None,
) -> Dict[str, Any]:
    """Load the persisted SD card health state.

    When the main state file cannot be read (for example, the SD card flips to
    read-only), the loader falls back to the volatile state file living on the
    RAM-backed ``/run`` filesystem. Callers can override the fallback via
    ``fallback_path`` when working with temporary directories in tests.
    """

    primary = Path(state_path) if state_path else STATE_PATH
    fallback = Path(fallback_path) if fallback_path else VOLATILE_STATE_PATH

    primary_result = _read_candidate(primary)
    fallback_result = None
    if fallback and fallback != primary:
        fallback_result = _read_candidate(fallback)

    if fallback_result and not primary_result:
        return fallback_result[0]

    if primary_result and fallback_result:
        _, fallback_marker, fallback_mtime = fallback_result
        _, _, primary_mtime = primary_result

        prefer_fallback = False
        if fallback_marker:
            prefer_fallback = True
        elif fallback_mtime is not None and primary_mtime is not None:
            prefer_fallback = fallback_mtime > primary_mtime
        elif fallback_mtime is not None and primary_mtime is None:
            prefer_fallback = True

        if prefer_fallback:
            return fallback_result[0]

    if primary_result:
        return primary_result[0]

    if fallback_result:
        return fallback_result[0]

    return dict(_DEFAULT_STATE)


def _store_state(state: Dict[str, Any], state_path: Path | None = None) -> None:
    target = Path(state_path) if state_path else STATE_PATH
    payload = dict(state)
    if target == VOLATILE_STATE_PATH or target.parent == VOLATILE_STATE_DIR:
        payload["_volatile_active"] = True
    else:
        payload.pop("_volatile_active", None)

    _ensure_directory(target)
    tmp_path = target.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp_path, target)

    if target != VOLATILE_STATE_PATH and target.parent != VOLATILE_STATE_DIR:
        try:
            VOLATILE_STATE_PATH.unlink(missing_ok=True)
        except OSError:
            pass


def reset_state(new_cid: str, state_path: Path | None = None) -> Dict[str, Any]:
    """Return a cleared state for a freshly detected SD card."""

    now = datetime.now(timezone.utc).timestamp()
    state = dict(_DEFAULT_STATE)
    state["cid"] = new_cid
    state["updated_at"] = _isoformat(now)
    _store_state(state, state_path)
    return state


def sync_cid(current_cid: str | None, state_path: Path | None = None) -> SyncResult:
    """Ensure the persisted state matches the current CID.

    Returns ``SyncResult`` where ``status`` is one of:

    - ``"missing"`` – CID unreadable (no state change).
    - ``"initialised"`` – baseline persisted for the first time.
    - ``"replaced"`` – CID changed, warning cleared.
    - ``"unchanged"`` – CID matches the persisted baseline.
    """

    state = load_state(state_path)
    cid = (current_cid or "").strip()
    if not cid:
        return SyncResult(state=state, status="missing")

    stored_cid = state.get("cid") or ""
    if not stored_cid:
        state["cid"] = cid
        now = datetime.now(timezone.utc).timestamp()
        state["updated_at"] = _isoformat(now)
        _store_state(state, state_path)
        return SyncResult(state=state, status="initialised")

    if stored_cid != cid:
        state = reset_state(cid, state_path)
        return SyncResult(state=state, status="replaced")

    return SyncResult(state=state, status="unchanged")


def register_failure(
    message: str,
    pattern: str,
    state_path: Path | None = None,
) -> Tuple[Dict[str, Any], bool]:
    """Record a failure event and set the persistent warning flag.

    Returns a tuple ``(state, changed)`` where ``changed`` signals whether the
    on-disk representation was updated.
    """

    state = load_state(state_path)
    now_ts = datetime.now(timezone.utc).timestamp()
    now_iso = _isoformat(now_ts)
    truncated = _truncate_message(message)

    changed = False
    if not state.get("warning_active"):
        state["warning_active"] = True
        state["first_detected_at"] = now_iso
        state["first_detected_ts"] = now_ts
        changed = True
    elif not state.get("first_detected_at"):
        state["first_detected_at"] = now_iso
        state["first_detected_ts"] = now_ts
        changed = True

    new_event = {
        "timestamp": now_iso,
        "message": truncated,
        "pattern": pattern,
    }

    if state.get("last_event") != new_event:
        changed = True
    state["last_event"] = new_event
    state["updated_at"] = now_iso

    _store_state(state, state_path)
    return state, changed


def state_summary(state: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Prepare a state payload safe for JSON responses."""

    normalised = _normalise_state(state)
    summary: Dict[str, Any] = {
        "cid": normalised.get("cid", ""),
        "warning_active": bool(normalised.get("warning_active")),
        "first_detected_at": normalised.get("first_detected_at"),
        "first_detected_ts": normalised.get("first_detected_ts"),
        "updated_at": normalised.get("updated_at"),
        "has_baseline": bool(normalised.get("cid")),
    }

    last_event = normalised.get("last_event")
    if isinstance(last_event, dict) and last_event:
        summary["last_event"] = {
            "timestamp": last_event.get("timestamp"),
            "message": last_event.get("message"),
            "pattern": last_event.get("pattern"),
        }
    else:
        summary["last_event"] = None

    return summary


def write_state(state: Dict[str, Any], state_path: Path | None = None) -> None:
    """Persist a precomputed state mapping atomically."""

    normalised = _normalise_state(state)
    _store_state(normalised, state_path)
