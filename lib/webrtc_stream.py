"""WebRTC session management for low-latency audio streaming."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
import os
from fractions import Fraction
from typing import Dict, Optional, TYPE_CHECKING

from . import aioice_patches  # noqa: F401

try:
    from aiortc import (
        RTCConfiguration as _RTCConfiguration,
        RTCPeerConnection as _RTCPeerConnection,
        RTCIceServer as _RTCIceServer,
        RTCSessionDescription as _RTCSessionDescription,
    )
    from aiortc import rtp as _rtp
    from aiortc.codecs import get_encoder as _get_encoder
    from aiortc.mediastreams import MediaStreamTrack as _MediaStreamTrack
    from aiortc.rtcrtpsender import RTCEncodedFrame as _RTCEncodedFrame
    from aiortc.rtcrtpsender import RTCRtpSender as _RTCRtpSender
    import av as _av
except (ModuleNotFoundError, ImportError) as exc:  # pragma: no cover - exercised in environments without aiortc
    _AIORTC_IMPORT_ERROR: Exception | None = exc
    _RTCConfiguration = None
    _RTCPeerConnection = None
    _RTCIceServer = None
    _RTCSessionDescription = None
    _MediaStreamTrack = None
    _av = None
else:  # pragma: no cover - import paths tested in integration environments
    _AIORTC_IMPORT_ERROR = None

from .webrtc_buffer import WebRTCBufferConsumer

if TYPE_CHECKING:  # pragma: no cover - type checking only
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCIceServer, RTCSessionDescription
else:
    RTCPeerConnection = _RTCPeerConnection  # type: ignore[assignment]
    RTCSessionDescription = _RTCSessionDescription  # type: ignore[assignment]
    RTCConfiguration = _RTCConfiguration  # type: ignore[assignment]
    RTCIceServer = _RTCIceServer  # type: ignore[assignment]


class _UnavailableSessionDescription:
    def __init__(self, *, sdp: str, type: str) -> None:
        self.sdp = sdp
        self.type = type


if RTCSessionDescription is None:  # pragma: no cover - dependency missing path
    RTCSessionDescription = _UnavailableSessionDescription  # type: ignore[assignment]


if _AIORTC_IMPORT_ERROR is None:
    MediaStreamTrack = _MediaStreamTrack  # type: ignore[assignment]
    av = _av  # type: ignore[assignment]

    _ENCODE_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rtc-encoder")

    class _PatchedRTCRtpSender(_RTCRtpSender):  # type: ignore[misc]
        async def _next_encoded_frame(self, codec):  # type: ignore[override]
            data = await getattr(self, "_RTCRtpSender__track").recv()

            if not self._enabled:
                return None

            audio_level = None
            encoder = getattr(self, "_RTCRtpSender__encoder", None)
            if encoder is None:
                encoder = _get_encoder(codec)
                setattr(self, "_RTCRtpSender__encoder", encoder)

            if isinstance(data, av.frame.Frame):  # type: ignore[attr-defined]
                if isinstance(data, av.AudioFrame):  # type: ignore[attr-defined]
                    audio_level = _rtp.compute_audio_level_dbov(data)

                force_keyframe = getattr(self, "_RTCRtpSender__force_keyframe", False)
                setattr(self, "_RTCRtpSender__force_keyframe", False)
                loop = getattr(self, "_RTCRtpSender__loop")
                payloads, timestamp = await loop.run_in_executor(
                    _ENCODE_EXECUTOR, encoder.encode, data, force_keyframe
                )
            else:
                payloads, timestamp = encoder.pack(data)

            if not payloads:
                return None

            return _RTCEncodedFrame(payloads, timestamp, audio_level)

    _RTCRtpSender._next_encoded_frame = _PatchedRTCRtpSender._next_encoded_frame  # type: ignore[attr-defined]

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
            self._timestamp = 0
            self._time_base = Fraction(1, self._sample_rate)

        async def recv(self) -> av.AudioFrame:
            loop = asyncio.get_running_loop()
            frame_bytes = await self._consumer.next_frame(loop, timeout=1.0)
            if frame_bytes is None:
                frame_bytes = self._silence

            samples = max(len(frame_bytes) // 2, 1)
            frame = av.AudioFrame(format="s16", layout="mono", samples=samples)
            frame.planes[0].update(frame_bytes)
            frame.sample_rate = self._sample_rate
            super_obj = super()
            next_timestamp = getattr(super_obj, "next_timestamp", None)
            if next_timestamp is None:
                frame.pts = self._timestamp
                frame.time_base = self._time_base
                self._timestamp += samples
            else:
                pts, time_base = await next_timestamp()
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
            ice_servers: Optional[list[dict[str, object]]] = None,
        ) -> None:
            self._buffer_dir = buffer_dir
            self._sample_rate = int(sample_rate)
            self._frame_ms = int(frame_ms)
            self._frame_bytes = int(frame_bytes)
            self._buffer_size = max(int(history_seconds * (1000.0 / self._frame_ms)), 2) * self._frame_bytes
            self._log = logging.getLogger("webrtc_manager")
            self._ice_servers = list(ice_servers or [])
            self._configuration = self._build_configuration()
            self._sessions: Dict[str, WebRTCSession] = {}
            self._lock = asyncio.Lock()

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

            pc = RTCPeerConnection(configuration=self._configuration)
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

        def _build_configuration(self) -> Optional[RTCConfiguration]:
            if not self._ice_servers:
                return None

            ice_servers: list[RTCIceServer] = []
            for entry in self._ice_servers:
                if isinstance(entry, RTCIceServer):
                    ice_servers.append(entry)
                    continue
                if not isinstance(entry, dict):
                    self._log.warning("Ignoring invalid ICE server entry: %r", entry)
                    continue
                try:
                    ice_servers.append(RTCIceServer(**entry))
                except (TypeError, ValueError) as exc:
                    self._log.warning("Failed to parse ICE server config %r: %s", entry, exc)

            if not ice_servers:
                return None

            return RTCConfiguration(iceServers=ice_servers)

else:
    class WebRTCManager:
        def __init__(
            self,
            *,
            buffer_dir: str,
            sample_rate: int,
            frame_ms: int,
            frame_bytes: int,
            history_seconds: float,
            ice_servers: Optional[list[dict[str, object]]] = None,
        ) -> None:
            self._buffer_dir = buffer_dir
            self._sample_rate = int(sample_rate)
            self._frame_ms = int(frame_ms)
            self._frame_bytes = int(frame_bytes)
            self._buffer_size = max(int(history_seconds * (1000.0 / self._frame_ms)), 2) * self._frame_bytes
            self._log = logging.getLogger("webrtc_manager")
            self._error_text = str(_AIORTC_IMPORT_ERROR or "aiortc not installed")
            self._log.warning("WebRTC support unavailable: %s", self._error_text)

        def mark_started(self, session_id: Optional[str]) -> None:
            _ = session_id

        async def stop(self, session_id: Optional[str]) -> None:
            _ = session_id

        def stats(self) -> dict[str, object]:
            return {
                "active_clients": 0,
                "encoder_running": False,
                "dependencies_ready": False,
                "reason": self._error_text,
            }

        async def shutdown(self) -> None:
            return None

        async def create_answer(
            self,
            session_id: str,
            offer: RTCSessionDescription,
        ) -> Optional[RTCSessionDescription]:
            _ = (session_id, offer)
            return None

