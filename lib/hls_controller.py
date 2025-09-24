#!/usr/bin/env python3
"""
HLS controller (on-demand encoder orchestration).

Why this file exists:
- We don't want ffmpeg (HLSTee) running 24/7.
- The web server increments/decrements an active client counter.
- When the first client arrives, we start HLSTee; when the last leaves,
  we stop it after a short cooldown to prevent flapping.

Usage:
- live_stream_daemon: create HLSTee, then controller.attach(tee). Do NOT start it.
- web_streamer: call controller.client_connected()/client_disconnected()
               and controller.ensure_started() before serving the playlist.
"""

from __future__ import annotations
import json
import os
import threading
import time
from typing import Optional

try:
    # For type hints only; avoid import errors if HLSTee isn't ready at import time.
    from lib.hls_mux import HLSTee  # noqa: F401
except Exception:  # pragma: no cover
    HLSTee = object  # type: ignore


class _HLSController:
    def __init__(self):
        self._lock = threading.Lock()
        self._tee: Optional["HLSTee"] = None
        self._clients = 0
        self._sessions: set[str] = set()
        self._cooldown = 10.0  # seconds after last client to stop
        self._stop_timer: Optional[threading.Timer] = None
        self._last_change = time.time()
        self._state_path: Optional[str] = None
        self._persist_enabled = True

    # --- Wire HLSTee instance from the daemon ---
    def attach(self, tee: Optional["HLSTee"]) -> None:
        with self._lock:
            self._tee = tee

    # --- Client accounting ---
    def client_connected(self, session_id: str | None = None) -> int:
        with self._lock:
            added = True
            if session_id is not None:
                if session_id in self._sessions:
                    added = False
                else:
                    self._sessions.add(session_id)
            if added:
                self._clients += 1
            self._last_change = time.time()
            # Cancel any pending stop when a client arrives
            if self._stop_timer:
                self._stop_timer.cancel()
                self._stop_timer = None
            clients = self._clients
        # Start encoder outside lock
        self.ensure_started()
        self._persist_state()
        return clients

    def client_disconnected(self, session_id: str | None = None) -> int:
        with self._lock:
            removed = session_id is None
            if session_id is not None:
                if session_id in self._sessions:
                    self._sessions.remove(session_id)
                    removed = True
                else:
                    return self._clients
            if removed and self._clients > 0:
                self._clients -= 1
            self._last_change = time.time()
            clients = self._clients
            schedule = (clients == 0 and self._stop_timer is None)
            cooldown = self._cooldown
        if schedule:
            self._schedule_stop_after(cooldown)
        self._persist_state()
        return clients

    @property
    def active_clients(self) -> int:
        with self._lock:
            return self._clients

    def set_cooldown(self, seconds: float) -> None:
        with self._lock:
            self._cooldown = max(0.0, float(seconds))

    # --- Encoder control ---
    def ensure_started(self) -> None:
        with self._lock:
            tee = self._tee
        if tee is not None and getattr(tee, "_t", None) is None:
            try:
                tee.start()
            except Exception:
                # HLSTee logs details; avoid raising in web path.
                pass

    def stop_now(self) -> None:
        with self._lock:
            t = self._stop_timer
            self._stop_timer = None
            tee = self._tee
        if t:
            try:
                t.cancel()
            except Exception:
                pass
        if tee is not None:
            try:
                tee.stop()
            except Exception:
                pass

    def _schedule_stop_after(self, seconds: float) -> None:
        def _cb():
            with self._lock:
                self._stop_timer = None
                idle = (self._clients == 0)
                tee = self._tee
            if idle and tee is not None:
                try:
                    tee.stop()
                except Exception:
                    pass

        timer = threading.Timer(seconds, _cb)
        timer.daemon = True
        with self._lock:
            self._stop_timer = timer
        timer.start()

    # --- Status for UI ---
    def status(self) -> dict:
        with self._lock:
            tee = self._tee
            running = (tee is not None and getattr(tee, "_t", None) is not None)
            return {
                "active_clients": self._clients,
                "encoder_running": running,
                "cooldown_sec": self._cooldown,
                "last_change_epoch": self._last_change,
            }

    # --- State persistence for cross-process coordination ---
    def set_state_path(self, path: Optional[str], persist: bool = True) -> None:
        with self._lock:
            self._state_path = path or None
            self._persist_enabled = bool(persist)
            state_path = self._state_path
        if state_path:
            directory = os.path.dirname(state_path)
            if directory:
                try:
                    os.makedirs(directory, exist_ok=True)
                except Exception:
                    pass

    def refresh_from_state(self) -> int:
        state = self._load_state()
        if state is None:
            with self._lock:
                return self._clients

        raw_sessions = state.get("sessions")
        sessions: set[str] = set()
        if isinstance(raw_sessions, list):
            for entry in raw_sessions:
                if isinstance(entry, str):
                    if entry:
                        sessions.add(entry)
                elif isinstance(entry, (int, float)):
                    sessions.add(str(entry))

        clients_value = state.get("clients")
        try:
            clients = int(clients_value)
        except (TypeError, ValueError):
            clients = 0
        clients = max(clients, len(sessions))

        last_change = state.get("last_change_epoch") or state.get("timestamp")
        try:
            last_change_epoch = float(last_change)
        except (TypeError, ValueError):
            last_change_epoch = time.time()

        with self._lock:
            prev_clients = self._clients
            stop_timer = self._stop_timer
            cooldown = self._cooldown
            tee = self._tee
            self._sessions = sessions
            self._clients = clients
            self._last_change = last_change_epoch
            need_cancel = clients > 0 and stop_timer is not None
            need_schedule = clients == 0 and prev_clients > 0
            if need_cancel:
                self._stop_timer = None

        if need_cancel and stop_timer is not None:
            try:
                stop_timer.cancel()
            except Exception:
                pass

        if clients > 0 and tee is not None and getattr(tee, "_t", None) is None:
            try:
                tee.start()
            except Exception:
                pass
        elif clients == 0 and prev_clients > 0:
            self._schedule_stop_after(cooldown)

        return clients

    def _persist_state(self) -> None:
        with self._lock:
            if not self._persist_enabled:
                return
            path = self._state_path
            sessions = sorted(self._sessions)
            clients = self._clients
            last_change = self._last_change
            tee = self._tee
        if not path:
            return
        data = {
            "sessions": sessions,
            "clients": clients,
            "last_change_epoch": last_change,
            "timestamp": time.time(),
            "encoder_running": bool(tee is not None and getattr(tee, "_t", None) is not None),
        }
        tmp_path = f"{path}.tmp"
        try:
            directory = os.path.dirname(path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(data, handle)
            os.replace(tmp_path, path)
        except Exception:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    def _load_state(self) -> Optional[dict]:
        with self._lock:
            path = self._state_path
        if not path:
            return None
        try:
            with open(path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(state, dict):
            return None
        return state


# Module-level singleton
controller = _HLSController()
