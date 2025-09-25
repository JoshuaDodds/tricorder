"""WebRTC session management for low-latency audio streaming."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Dict, Optional

from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamTrack
import av

from .webrtc_buffer import WebRTCBufferConsumer


class PCMStreamTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(
        self,
        consumer: WebRTCBufferConsumer,
        *,
        sample_rate: int,
        frame_bytes: int,
    ) -> None:
        super().__init__()
        self._consumer = consumer
        self._sample_rate = int(sample_rate)
        self._frame_bytes = int(frame_bytes)
        self._silence = bytes(self._frame_bytes)

    async def recv(self) -> av.AudioFrame:
        loop = asyncio.get_running_loop()
        frame_bytes = await self._consumer.next_frame(loop, timeout=1.0)
        if frame_bytes is None:
            frame_bytes = self._silence

        samples = max(len(frame_bytes) // 2, 1)
        frame = av.AudioFrame(format="s16", layout="mono", samples=samples)
        frame.planes[0].update(frame_bytes)
        frame.sample_rate = self._sample_rate
        pts, time_base = await super().next_timestamp()
        frame.pts = pts
        frame.time_base = time_base
        return frame

    def stop(self) -> None:
        try:
            self._consumer.close()
        except Exception:
            pass
        super().stop()


class WebRTCSession:
    def __init__(self, pc: RTCPeerConnection, track: PCMStreamTrack) -> None:
        self.pc = pc
        self.track = track

    async def close(self) -> None:
        try:
            await self.pc.close()
        except Exception:
            pass
        self.track.stop()


class WebRTCManager:
    def __init__(
        self,
        *,
        buffer_dir: str,
        sample_rate: int,
        frame_ms: int,
        frame_bytes: int,
        history_seconds: float,
    ) -> None:
        self._buffer_dir = buffer_dir
        self._sample_rate = int(sample_rate)
        self._frame_ms = int(frame_ms)
        self._frame_bytes = int(frame_bytes)
        self._buffer_size = max(int(history_seconds * (1000.0 / self._frame_ms)), 2) * self._frame_bytes
        self._sessions: Dict[str, WebRTCSession] = {}
        self._lock = asyncio.Lock()
        self._log = logging.getLogger("webrtc_manager")

    def mark_started(self, session_id: Optional[str]) -> None:
        _ = session_id

    async def stop(self, session_id: Optional[str]) -> None:
        if not session_id:
            return
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            await session.close()

    def stats(self) -> dict[str, object]:
        active = len(self._sessions)
        return {
            "active_clients": active,
            "encoder_running": active > 0,
        }

    async def shutdown(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            await session.close()

    def _buffer_ready(self) -> bool:
        buffer_path = os.path.join(self._buffer_dir, "webrtc_buffer.raw")
        state_path = os.path.join(self._buffer_dir, "webrtc_state.json")
        return os.path.exists(buffer_path) and os.path.exists(state_path)

    async def create_answer(
        self,
        session_id: str,
        offer: RTCSessionDescription,
    ) -> Optional[RTCSessionDescription]:
        if not self._buffer_ready():
            return None

        try:
            consumer = WebRTCBufferConsumer(
                self._buffer_dir,
                frame_bytes=self._frame_bytes,
                buffer_size=self._buffer_size,
            )
        except FileNotFoundError:
            return None

        track = PCMStreamTrack(
            consumer,
            sample_rate=self._sample_rate,
            frame_bytes=self._frame_bytes,
        )

        pc = RTCPeerConnection()
        pc.addTrack(track)

        done = asyncio.get_running_loop().create_future()

        @pc.on("connectionstatechange")
        async def _on_state_change():
            state = pc.connectionState
            if state in {"closed", "failed", "disconnected"} and not done.done():
                done.set_result(None)
                await self.stop(session_id)

        @pc.on("icegatheringstatechange")
        def _on_ice():
            if pc.iceGatheringState == "complete" and not done.done():
                done.set_result(None)

        try:
            await pc.setRemoteDescription(offer)
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
        except Exception:
            consumer.close()
            await pc.close()
            return None

        if not done.done():
            try:
                await asyncio.wait_for(done, timeout=2.0)
            except asyncio.TimeoutError:
                pass

        async with self._lock:
            existing = self._sessions.pop(session_id, None)
            if existing:
                await existing.close()
            self._sessions[session_id] = WebRTCSession(pc, track)

        return pc.localDescription

