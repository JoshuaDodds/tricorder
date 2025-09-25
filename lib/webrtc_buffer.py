"""Shared-memory style ring buffer for PCM frames consumed by WebRTC."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from typing import Optional


BUFFER_FILENAME = "webrtc_buffer.raw"
STATE_FILENAME = "webrtc_state.json"


class WebRTCBufferWriter:
    """Persist PCM frames in a circular buffer for low-latency streaming."""

    def __init__(
        self,
        root_dir: str,
        *,
        sample_rate: int,
        frame_ms: int,
        frame_bytes: int,
        history_seconds: float = 8.0,
    ) -> None:
        self.root_dir = root_dir
        os.makedirs(self.root_dir, exist_ok=True)

        self.sample_rate = int(sample_rate)
        self.frame_ms = int(frame_ms)
        self.frame_bytes = int(frame_bytes)
        self.history_seconds = max(float(history_seconds), 1.0)

        if self.frame_bytes <= 0:
            raise ValueError("frame_bytes must be > 0")

        approx_frames = int(self.history_seconds * (1000.0 / self.frame_ms))
        buffer_frames = max(approx_frames, 2)
        self.buffer_size = buffer_frames * self.frame_bytes

        self.buffer_path = os.path.join(self.root_dir, BUFFER_FILENAME)
        self.state_path = os.path.join(self.root_dir, STATE_FILENAME)

        flags = os.O_RDWR | os.O_CREAT
        try:
            self.fd = os.open(self.buffer_path, flags, 0o644)
        except OSError as exc:  # pragma: no cover - unlikely on tmpfs but defensive
            raise RuntimeError(f"failed to open WebRTC buffer: {exc}") from exc

        try:
            os.ftruncate(self.fd, self.buffer_size)
        except OSError as exc:  # pragma: no cover - disk issues should be surfaced
            os.close(self.fd)
            raise RuntimeError(f"failed to size WebRTC buffer: {exc}") from exc

        self._lock = threading.Lock()
        self._write_offset = 0
        self._sequence = 0
        self._write_state(initial=True)

    def close(self) -> None:
        with self._lock:
            try:
                os.close(self.fd)
            except OSError:
                pass

    def feed(self, frame: bytes) -> None:
        if not frame:
            return
        data = memoryview(frame)
        with self._lock:
            if len(data) >= self.buffer_size:
                data = data[-self.buffer_size :]

            offset = self._write_offset
            remaining = len(data)
            view = data
            while remaining > 0:
                chunk = min(remaining, self.buffer_size - offset)
                try:
                    os.pwrite(self.fd, view[:chunk], offset)
                except AttributeError:  # pragma: no cover - older Python
                    os.lseek(self.fd, offset, os.SEEK_SET)
                    os.write(self.fd, view[:chunk])
                except OSError as exc:  # pragma: no cover - disk issues
                    raise RuntimeError(f"failed to write WebRTC buffer: {exc}") from exc
                offset = (offset + chunk) % self.buffer_size
                view = view[chunk:]
                remaining -= chunk

            self._write_offset = offset
            self._sequence += 1
            self._write_state()

    def _write_state(self, *, initial: bool = False) -> None:
        payload = {
            "sample_rate": self.sample_rate,
            "frame_ms": self.frame_ms,
            "frame_bytes": self.frame_bytes,
            "buffer_size": self.buffer_size,
            "write_offset": self._write_offset,
            "sequence": self._sequence,
            "updated_at": time.time(),
        }
        tmp_path = f"{self.state_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        os.replace(tmp_path, self.state_path)


class WebRTCBufferConsumer:
    """Read PCM frames from the circular buffer written by WebRTCBufferWriter."""

    def __init__(
        self,
        root_dir: str,
        *,
        frame_bytes: int,
        buffer_size: int,
    ) -> None:
        self.root_dir = root_dir
        self.frame_bytes = frame_bytes
        self.buffer_size = buffer_size
        self.buffer_path = os.path.join(self.root_dir, BUFFER_FILENAME)
        self.state_path = os.path.join(self.root_dir, STATE_FILENAME)

        if not os.path.exists(self.buffer_path):
            raise FileNotFoundError(self.buffer_path)

        try:
            self.fd = os.open(self.buffer_path, os.O_RDONLY)
        except OSError as exc:  # pragma: no cover - defensive
            raise RuntimeError(f"failed to open WebRTC buffer for read: {exc}") from exc

        self._capacity_frames = max(self.buffer_size // self.frame_bytes, 1)
        self._last_sequence = 0

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass

    def _read_state(self) -> Optional[dict[str, int]]:
        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return None
        except json.JSONDecodeError:
            return None

        try:
            sequence = int(data.get("sequence", 0))
            write_offset = int(data.get("write_offset", 0))
        except (TypeError, ValueError):
            return None

        return {"sequence": max(sequence, 0), "write_offset": write_offset % self.buffer_size}

    def _read_bytes(self, offset: int) -> bytes:
        buf = bytearray(self.frame_bytes)
        chunk = min(self.frame_bytes, self.buffer_size - offset)
        view = memoryview(buf)
        try:
            read = os.pread(self.fd, chunk, offset)
        except AttributeError:  # pragma: no cover
            os.lseek(self.fd, offset, os.SEEK_SET)
            read = os.read(self.fd, chunk)
        view[: len(read)] = read
        if chunk < self.frame_bytes:
            try:
                tail = os.pread(self.fd, self.frame_bytes - chunk, 0)
            except AttributeError:  # pragma: no cover
                os.lseek(self.fd, 0, os.SEEK_SET)
                tail = os.read(self.fd, self.frame_bytes - chunk)
            view[chunk : chunk + len(tail)] = tail
        return bytes(buf)

    async def next_frame(self, loop, *, poll_interval: float = 0.02, timeout: float = 1.0) -> Optional[bytes]:
        deadline = loop.time() + timeout
        while True:
            state = self._read_state()
            if state is None:
                if loop.time() >= deadline:
                    return None
                await asyncio_sleep(poll_interval)
                continue

            sequence = state["sequence"]
            if sequence <= 0:
                if loop.time() >= deadline:
                    return None
                await asyncio_sleep(poll_interval)
                continue

            if self._last_sequence == 0:
                self._last_sequence = sequence
                if loop.time() >= deadline:
                    return None
                await asyncio_sleep(poll_interval)
                continue

            frames_available = sequence - self._last_sequence
            if frames_available <= 0:
                if loop.time() >= deadline:
                    return None
                await asyncio_sleep(poll_interval)
                continue

            if frames_available > self._capacity_frames:
                self._last_sequence = sequence - self._capacity_frames
                frames_available = self._capacity_frames

            offset = (state["write_offset"] - frames_available * self.frame_bytes) % self.buffer_size
            frame = self._read_bytes(offset)
            self._last_sequence += 1
            return frame


async def asyncio_sleep(delay: float) -> None:
    await asyncio.sleep(delay)

