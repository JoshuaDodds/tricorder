"""Async helpers that bridge filesystem updates into dashboard SSE events."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:  # pragma: no cover - imports for type checkers
    import dashboard_events


class CaptureStatusEventBridge:
    """Bridge capture status file updates into dashboard SSE events."""

    def __init__(
        self,
        *,
        read_status: Callable[[], dict[str, object]],
        bus: "dashboard_events.DashboardEventBus",
        poll_interval: float,
        logger: logging.Logger | None = None,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        self._read_status = read_status
        self._bus = bus
        self._poll_interval = float(poll_interval)
        self._logger = logger or logging.getLogger("web_streamer")
        self._task: asyncio.Task | None = None
        self._last_signature: str | None = None

    async def start(self) -> None:
        self._prime_from_history()
        await self._poll_once()
        if self._task is not None:
            return
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._run())

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _run(self) -> None:
        assert self._task is not None
        try:
            while True:
                try:
                    await asyncio.sleep(self._poll_interval)
                    await self._poll_once()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # pragma: no cover - defensive logging
                    self._logger.debug(
                        "capture status bridge poll failed: %s", exc, exc_info=False
                    )
        except asyncio.CancelledError:
            raise
        finally:
            self._task = None

    async def _poll_once(self) -> None:
        payload = await asyncio.to_thread(self._read_status)
        signature = self._signature(payload)
        if signature is None or signature == self._last_signature:
            return
        self._last_signature = signature
        try:
            self._bus.publish("capture_status", payload)
        except Exception as exc:  # pragma: no cover - publish errors are unexpected
            self._logger.warning("failed to publish capture status event: %s", exc)

    def _prime_from_history(self) -> None:
        history = self._bus.history_snapshot()
        for event in reversed(history):
            if event.get("type") != "capture_status":
                continue
            signature = self._signature(event.get("payload"))
            if signature is not None:
                self._last_signature = signature
            break

    @staticmethod
    def _signature(payload: Any) -> str | None:
        if payload is None:
            return None
        try:
            return json.dumps(payload, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return None


class RecordingsEventBridge:
    """Replay recordings_changed events spooled by external processes."""

    def __init__(
        self,
        *,
        spool_dir: Path,
        bus: "dashboard_events.DashboardEventBus",
        poll_interval: float,
        logger: logging.Logger | None = None,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        self._spool_dir = spool_dir
        self._bus = bus
        self._poll_interval = float(poll_interval)
        self._logger = logger or logging.getLogger("web_streamer")
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        await self._drain_once()
        if self._task is not None:
            return
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._run())

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _run(self) -> None:
        assert self._task is not None
        try:
            while True:
                try:
                    await asyncio.sleep(self._poll_interval)
                    await self._drain_once()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # pragma: no cover - defensive logging
                    self._logger.debug(
                        "recordings event bridge poll failed: %s", exc, exc_info=False
                    )
        except asyncio.CancelledError:
            raise
        finally:
            self._task = None

    async def _drain_once(self) -> None:
        events = await asyncio.to_thread(self._collect_events)
        if not events:
            return
        for event_type, payload in events:
            if event_type != "recordings_changed" or not isinstance(payload, dict):
                continue
            try:
                self._bus.publish(event_type, payload)
            except Exception as exc:  # pragma: no cover - unexpected publish failure
                self._logger.debug(
                    "recordings event bridge publish failed: %s", exc, exc_info=False
                )

    def _collect_events(self) -> list[tuple[str, dict[str, object]]]:
        try:
            self._spool_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return []

        events: list[tuple[str, dict[str, object]]] = []
        candidates = sorted(self._spool_dir.glob("*.json"))
        for candidate in candidates:
            try:
                with open(candidate, "r", encoding="utf-8") as handle:
                    record = json.load(handle)
            except (OSError, json.JSONDecodeError):
                try:
                    candidate.unlink()
                except OSError:
                    pass
                continue

            event_type = record.get("type") if isinstance(record, dict) else None
            payload = record.get("payload") if isinstance(record, dict) else None
            if isinstance(event_type, str) and isinstance(payload, dict):
                events.append((event_type, payload))

            try:
                candidate.unlink()
            except OSError:
                pass

        return events


__all__ = ["CaptureStatusEventBridge", "RecordingsEventBridge"]
