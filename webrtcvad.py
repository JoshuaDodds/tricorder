"""Lightweight compatibility shim for the upstream ``webrtcvad`` module."""

from __future__ import annotations

from typing import Optional

try:  # Python 3.10+
    from importlib import metadata as importlib_metadata
except ImportError:  # pragma: no cover - fallback for older interpreters
    import importlib_metadata  # type: ignore  # pragma: no cover

try:
    _version: Optional[str] = importlib_metadata.version("webrtcvad")
except Exception:  # pragma: no cover - metadata lookup failure
    _version = None

try:
    import _webrtcvad  # type: ignore[attr-defined]
except ModuleNotFoundError as exc:  # pragma: no cover - install-time issue
    raise ModuleNotFoundError(
        "webrtcvad C extension (_webrtcvad) is not installed. "
        "Install the upstream 'webrtcvad' wheel before importing this shim."
    ) from exc

if _version is None:  # pragma: no cover - best-effort metadata fallback
    try:
        import pkg_resources  # type: ignore
    except Exception:
        _version = "unknown"
    else:
        try:
            _version = pkg_resources.get_distribution("webrtcvad").version
        except Exception:
            _version = "unknown"

__author__ = "John Wiseman jjwiseman@gmail.com"
__copyright__ = "Copyright (C) 2016 John Wiseman"
__license__ = "MIT"
__version__ = _version or "unknown"

__all__ = ["Vad", "valid_rate_and_frame_length"]


class Vad:
    """Wrapper around the compiled Voice Activity Detection bindings."""

    def __init__(self, mode: Optional[int] = None) -> None:
        self._vad = _webrtcvad.create()
        _webrtcvad.init(self._vad)
        if mode is not None:
            self.set_mode(mode)

    def set_mode(self, mode: int) -> None:
        _webrtcvad.set_mode(self._vad, mode)

    def is_speech(self, buf: bytes, sample_rate: int, length: Optional[int] = None) -> bool:
        length = length or int(len(buf) / 2)
        if length * 2 > len(buf):
            raise IndexError(
                "buffer has %s frames, but length argument was %s"
                % (int(len(buf) / 2.0), length)
            )
        return _webrtcvad.process(self._vad, sample_rate, buf, length)


def valid_rate_and_frame_length(rate: int, frame_length: int) -> bool:
    return _webrtcvad.valid_rate_and_frame_length(rate, frame_length)

