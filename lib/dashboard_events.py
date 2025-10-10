"""Server-Sent Events publisher for dashboard live updates."""

from __future__ import annotations

import asyncio
import copy
import threading
import time
from collections import deque
from typing import Any, Deque, Set


class DashboardEventBus:
    """In-process publisher that fan-outs dashboard events to SSE clients."""

    def __init__(
        self,
        *,
        loop: asyncio.AbstractEventLoop | None = None,
        max_queue_size: int = 128,
        history_limit: int = 256,
    ) -> None:
        if max_queue_size <= 0:
            raise ValueError("max_queue_size must be positive")
        if history_limit <= 0:
            raise ValueError("history_limit must be positive")
        self._loop: asyncio.AbstractEventLoop | None = loop
        self._max_queue_size = max_queue_size
        self._history: Deque[dict[str, Any]] = deque(maxlen=history_limit)
        self._subscribers: Set[asyncio.Queue] = set()
        self._seq = 0
        self._lock = threading.Lock()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._loop = loop

    async def subscribe(self, *, last_event_id: str | None = None) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._max_queue_size)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            self.set_loop(loop)

        with self._lock:
            self._subscribers.add(queue)
            history = list(self._history)

        threshold = _parse_event_id(last_event_id)
        if threshold is not None:
            backlog = [event for event in history if event["seq"] > threshold]
        else:
            backlog = history

        for event in backlog:
            self._enqueue_nowait(queue, event)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.discard(queue)

    def publish(self, event_type: str, payload: Any) -> str:
        if not event_type or not isinstance(event_type, str):
            raise ValueError("event_type must be a non-empty string")
        timestamp = time.time()
        with self._lock:
            self._seq += 1
            seq = self._seq
            event_payload = copy.deepcopy(payload) if isinstance(payload, (dict, list)) else payload
            event = {
                "id": str(seq),
                "seq": seq,
                "type": event_type,
                "timestamp": timestamp,
                "payload": event_payload,
            }
            self._history.append(event)
            loop = self._loop
            subscribers = list(self._subscribers)

        if not subscribers:
            return event["id"]

        if loop is None:
            # No loop registered yet; deliver synchronously on best-effort basis.
            for queue in subscribers:
                self._enqueue_nowait(queue, event)
            return event["id"]

        def _deliver() -> None:
            for queue in subscribers:
                self._enqueue_nowait(queue, event)

        loop.call_soon_threadsafe(_deliver)
        return event["id"]

    def _enqueue_nowait(self, queue: asyncio.Queue, event: dict[str, Any]) -> None:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer; drop newest event for this subscriber.
                pass

    def history_snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._history)


_event_bus: DashboardEventBus | None = None
_event_bus_lock = threading.Lock()


def install_event_bus(bus: DashboardEventBus) -> None:
    with _event_bus_lock:
        global _event_bus
        _event_bus = bus


def get_event_bus() -> DashboardEventBus | None:
    with _event_bus_lock:
        return _event_bus


def publish(event_type: str, payload: Any) -> str | None:
    bus = get_event_bus()
    if bus is None:
        return None
    return bus.publish(event_type, payload)


def uninstall_event_bus(bus: DashboardEventBus) -> None:
    with _event_bus_lock:
        global _event_bus
        if _event_bus is bus:
            _event_bus = None


def reset_for_tests() -> None:
    with _event_bus_lock:
        global _event_bus
        _event_bus = None


def _parse_event_id(candidate: str | None) -> int | None:
    if not candidate:
        return None
    try:
        return int(candidate)
    except (TypeError, ValueError):
        return None

