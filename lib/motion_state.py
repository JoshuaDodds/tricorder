"""Persistent motion state tracking for external motion integrations."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

MOTION_STATE_FILENAME = "motion_state.json"
_HISTORY_LIMIT_DEFAULT = 256
_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


@dataclass(slots=True)
class MotionState:
    """Represents the persisted motion state."""

    active: bool
    updated_at: float
    sequence: int
    active_since: float | None
    events: list[dict[str, Any]]

    def to_payload(self, *, include_events: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "motion_active": bool(self.active),
            "updated_at": float(self.updated_at),
            "sequence": int(self.sequence),
        }
        if self.active and self.active_since is not None:
            payload["motion_active_since"] = float(self.active_since)
        elif "motion_active_since" in payload:
            payload.pop("motion_active_since", None)
        if include_events:
            payload["events"] = [
                {
                    "timestamp": float(event["timestamp"]),
                    "motion_active": bool(event["motion_active"]),
                    "sequence": int(event.get("sequence", self.sequence)),
                }
                for event in _normalize_events(self.events)
            ]
        return payload


def _normalize_events(raw: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        ts = item.get("timestamp")
        state = item.get("motion_active")
        if not isinstance(ts, (int, float)):
            continue
        active = _coerce_bool(state)
        if active is None:
            continue
        sequence = item.get("sequence")
        if isinstance(sequence, (int, float)):
            seq_val = int(sequence)
        else:
            seq_val = len(normalized) + 1
        normalized.append(
            {
                "timestamp": float(ts),
                "motion_active": bool(active),
                "sequence": seq_val,
            }
        )
    return normalized


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized in _TRUE_VALUES:
            return True
        if normalized in _FALSE_VALUES:
            return False
    return None


def load_motion_state(path: str | os.PathLike[str]) -> MotionState:
    candidate = Path(path)
    try:
        with candidate.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return MotionState(False, 0.0, 0, None, [])
    if not isinstance(data, dict):
        return MotionState(False, 0.0, 0, None, [])

    active = bool(data.get("motion_active") or data.get("active", False))
    updated_raw = data.get("updated_at")
    if isinstance(updated_raw, (int, float)):
        updated_at = float(updated_raw)
    else:
        updated_at = 0.0
    sequence_raw = data.get("sequence")
    sequence = int(sequence_raw) if isinstance(sequence_raw, (int, float)) else 0
    since_raw = data.get("motion_active_since", data.get("active_since"))
    active_since = float(since_raw) if isinstance(since_raw, (int, float)) else None
    events_raw = data.get("events")
    events = _normalize_events(events_raw if isinstance(events_raw, list) else [])
    return MotionState(active, updated_at, sequence, active_since, events)


def store_motion_state(
    path: str | os.PathLike[str],
    *,
    motion_active: bool,
    timestamp: float | None = None,
    history_limit: int = _HISTORY_LIMIT_DEFAULT,
) -> MotionState:
    timestamp = float(time.time() if timestamp is None else timestamp)
    current = load_motion_state(path)
    sequence = current.sequence
    active_since = current.active_since if current.active else None
    events = list(current.events)

    if motion_active != current.active:
        sequence += 1
        if motion_active:
            active_since = timestamp
        else:
            active_since = None
        events.append(
            {
                "timestamp": timestamp,
                "motion_active": motion_active,
                "sequence": sequence,
            }
        )
    elif motion_active and active_since is None:
        active_since = timestamp

    if history_limit > 0 and len(events) > history_limit:
        events = events[-history_limit:]

    state = MotionState(motion_active, timestamp, sequence, active_since, events)
    payload = state.to_payload(include_events=True)
    payload["active"] = payload.get("motion_active", motion_active)
    payload.setdefault("motion_active", motion_active)

    target = Path(path)
    tmp_path = target.with_suffix(target.suffix + ".tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    os.replace(tmp_path, target)
    return state


class MotionStateWatcher:
    """Lightweight poller that reloads motion state on change."""

    def __init__(self, path: str | os.PathLike[str], *, poll_interval: float = 0.25):
        self._path = Path(path)
        self._poll_interval = max(0.01, float(poll_interval))
        self._last_check = 0.0
        self._last_mtime: float | None = None
        self._state = load_motion_state(self._path)
        try:
            self._last_mtime = self._path.stat().st_mtime
        except OSError:
            self._last_mtime = None
        self._last_sequence = self._state.sequence
        self._last_active = self._state.active

    @property
    def state(self) -> MotionState:
        return self._state

    def poll(self) -> MotionState | None:
        now = time.monotonic()
        if now - self._last_check < self._poll_interval:
            return None
        self._last_check = now
        try:
            mtime = self._path.stat().st_mtime
        except OSError:
            mtime = None
        if mtime == self._last_mtime:
            return None
        self._last_mtime = mtime
        next_state = load_motion_state(self._path)
        changed = (
            next_state.sequence != self._last_sequence
            or next_state.active != self._last_active
            or (
                next_state.active
                and next_state.active_since != self._state.active_since
            )
        )
        self._state = next_state
        if changed:
            self._last_sequence = next_state.sequence
            self._last_active = next_state.active
            return next_state
        return None

    def force_refresh(self) -> MotionState:
        """Reload state immediately, bypassing interval throttling."""
        self._state = load_motion_state(self._path)
        try:
            self._last_mtime = self._path.stat().st_mtime
        except OSError:
            self._last_mtime = None
        self._last_sequence = self._state.sequence
        self._last_active = self._state.active
        self._last_check = time.monotonic()
        return self._state
