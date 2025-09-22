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
        self._cooldown = 10.0  # seconds after last client to stop
        self._stop_timer: Optional[threading.Timer] = None
        self._last_change = time.time()

    # --- Wire HLSTee instance from the daemon ---
    def attach(self, tee: Optional["HLSTee"]) -> None:
        with self._lock:
            self._tee = tee

    # --- Client accounting ---
    def client_connected(self) -> int:
        with self._lock:
            self._clients += 1
            self._last_change = time.time()
            # Cancel any pending stop when a client arrives
            if self._stop_timer:
                self._stop_timer.cancel()
                self._stop_timer = None
        # Start encoder outside lock
        self.ensure_started()
        return self.active_clients

    def client_disconnected(self) -> int:
        with self._lock:
            if self._clients > 0:
                self._clients -= 1
            self._last_change = time.time()
            clients = self._clients
            schedule = (clients == 0 and self._stop_timer is None)
            cooldown = self._cooldown
        if schedule:
            self._schedule_stop_after(cooldown)
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


# Module-level singleton
controller = _HLSController()
