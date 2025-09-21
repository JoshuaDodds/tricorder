#!/usr/bin/env python3
"""
web_stream_tap.py
-----------------
Continuous tee that writes raw PCM frames into a rolling WAV file for web streaming.

- Writes an "infinite" WAV header once, then appends frames.
- Maintains a ring on disk: when max_bytes is exceeded, truncate back to header offset.
- Threaded writer; feed() is non-blocking (drops oldest if queue full).
- Intended to be used from live_stream_daemon, alongside TimelineRecorder.

File path: /apps/tricorder/tmp/web_stream.wav
"""

import os
import struct
import threading
import queue
import logging

INFINITE = 0xFFFFFFFF

class WebStreamTee:
    def __init__(self, path: str, sample_rate: int, channels: int, bits_per_sample: int,
                 history_seconds: int = 60, chunk_bytes: int = 8192,
                 log_level=logging.INFO):
        self.path = path
        self.sr = sample_rate
        self.ch = channels
        self.bps = bits_per_sample
        self.block_align = (channels * bits_per_sample) // 8
        self.bytes_per_sec = self.sr * self.block_align
        self.max_bytes = max(self.block_align, history_seconds * self.bytes_per_sec)
        self.chunk_bytes = chunk_bytes
        self.q = queue.Queue(maxsize=max(4, (self.bytes_per_sec // self.chunk_bytes) // 4))  # ~250ms buffer
        self.log = logging.getLogger("web_stream_tap")
        self.log.setLevel(log_level)

        self._t = None
        self._stop = threading.Event()
        self._f = None
        self._data_offset = 44  # WAV header length we write
        self._bytes_since_data = 0

        os.makedirs(os.path.dirname(self.path), exist_ok=True)

    def _write_infinite_header(self, f):
        byte_rate = self.bytes_per_sec
        header = [
            b"RIFF", struct.pack("<I", INFINITE), b"WAVE",
            b"fmt ", struct.pack("<I", 16),
            struct.pack("<HHIIHH", 1, self.ch, self.sr, byte_rate, self.block_align, self.bps),
            b"data", struct.pack("<I", INFINITE),
        ]
        f.write(b"".join(header))

    def start(self):
        if self._t is not None:
            return
        self._f = open(self.path, "wb", buffering=0)
        self._write_infinite_header(self._f)
        self._t = threading.Thread(target=self._run, name="web_stream_tap", daemon=True)
        self._t.start()
        self.log.info("web_stream_tap started path=%s sr=%d ch=%d bps=%d max_bytes=%d",
                      self.path, self.sr, self.ch, self.bps, self.max_bytes)

    def stop(self):
        self._stop.set()
        if self._t:
            self._t.join(timeout=2)
        try:
            if self._f:
                self._f.flush()
                self._f.close()
        except Exception:
            pass
        self._t = None
        self._f = None
        self.log.info("web_stream_tap stopped")

    def feed(self, pcm_bytes: bytes):
        """Non-blocking; drops oldest if full."""
        if self._t is None:
            return
        try:
            self.q.put_nowait(pcm_bytes)
        except queue.Full:
            try:
                _ = self.q.get_nowait()  # drop oldest
            except Exception:
                pass
            try:
                self.q.put_nowait(pcm_bytes)
            except Exception:
                pass

    def _run(self):
        while not self._stop.is_set():
            try:
                chunk = self.q.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                self._f.write(chunk)
                self._bytes_since_data += len(chunk)
                if self._bytes_since_data >= self.max_bytes:
                    # ring: truncate back to after header
                    self._f.flush()
                    os.ftruncate(self._f.fileno(), self._data_offset)
                    self._f.seek(self._data_offset, os.SEEK_SET)
                    self._bytes_since_data = 0
            except Exception as e:
                self.log.warning("write error: %r", e)
