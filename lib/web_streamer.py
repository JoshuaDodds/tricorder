#!/usr/bin/env python3
"""
Lightweight WAV live streamer over HTTP for desktop/mobile (iOS Safari compatible).

Design goals:
- Zero transcoding (pass-through PCM from a growing WAV).
- No file locks; read-only tailing with small per-client buffers.
- Async, low-overhead HTTP server (aiohttp) with chunked transfer.
- Sends an "infinite" WAV header per-connection so browsers begin playback immediately.
- Multiple clients supported; each holds its own file descriptor.

Endpoints:
  GET /                -> Minimal test page with <audio> tag.
  GET /stream.wav      -> Live WAV stream (starts at current EOF by default).
                          Query params:
                            from_start=1   start streaming from the WAV's data chunk start
                            prebuffer_ms=0 amount of historical audio to include before EOF (if >0)
"""

import argparse
import asyncio
import os
import struct
import sys
import time
from typing import Tuple

from aiohttp import web

# ---------- WAV parsing / header utilities ----------

RIFF = b"RIFF"
WAVE = b"WAVE"
FMT_ = b"fmt "
DATA = b"data"

class WavFormatError(Exception):
    pass

def _read_exact(f, n: int) -> bytes:
    """Blocking exact read of n bytes; returns fewer only at EOF."""
    chunks = []
    remaining = n
    while remaining > 0:
        b = f.read(remaining)
        if not b:
            break
        chunks.append(b)
        remaining -= len(b)
    return b"".join(chunks)

def wait_for_min_size(path: str, size: int, timeout: float = 10.0, poll: float = 0.02) -> None:
    """Wait until file reaches at least `size` bytes or until timeout."""
    start = time.time()
    while True:
        try:
            st = os.stat(path)
            if st.st_size >= size:
                return
        except FileNotFoundError:
            pass
        if (time.time() - start) > timeout:
            raise TimeoutError(f"Timed out waiting for {path} to reach {size} bytes")
        time.sleep(poll)

def parse_wav_header(f) -> Tuple[int, int, int, int, int]:
    """
    Parse WAV header, returning:
      (data_offset, data_size (may be unreliable for growing file),
       num_channels, sample_rate, bits_per_sample)

    Robust to extra chunks between 'fmt ' and 'data'.
    """
    f.seek(0, os.SEEK_SET)
    header = _read_exact(f, 12)
    if len(header) < 12 or header[0:4] != RIFF or header[8:12] != WAVE:
        raise WavFormatError("Not a RIFF/WAVE file or incomplete header")

    # Iterate chunks until we find 'fmt ' and 'data'
    fmt_found = False
    data_offset = None
    data_size = None
    num_channels = sample_rate = bits_per_sample = None

    while True:
        chunk_hdr = _read_exact(f, 8)
        if len(chunk_hdr) < 8:
            # Incomplete chunk header -> producer hasn't written yet
            raise WavFormatError("Incomplete chunk header; file still being written")
        chunk_id, chunk_size = chunk_hdr[0:4], struct.unpack("<I", chunk_hdr[4:8])[0]

        if chunk_id == FMT_:
            fmt_data = _read_exact(f, chunk_size)
            if len(fmt_data) < chunk_size:
                raise WavFormatError("Incomplete fmt chunk")
            # Parse PCM fmt (at least 16 bytes)
            if len(fmt_data) < 16:
                raise WavFormatError("fmt chunk too small")
            audio_format, num_channels, sample_rate, byte_rate, block_align, bits_per_sample = struct.unpack(
                "<HHIIHH", fmt_data[:16]
            )
            if audio_format not in (0x0001, 0x0003):  # PCM (int) or IEEE float
                # We stream as WAV container regardless; most browsers expect PCM.
                # If it's not PCM, some clients may fail; we don't transcode.
                pass
            fmt_found = True
        elif chunk_id == DATA:
            data_offset = f.tell()
            data_size = chunk_size
            # Do not seek over data; leave f at start of data
            break
        else:
            # Skip unknown chunk
            f.seek(chunk_size, os.SEEK_CUR)

    if not fmt_found or data_offset is None:
        raise WavFormatError("Missing fmt or data chunk")

    return data_offset, data_size, num_channels, sample_rate, bits_per_sample

def make_infinite_wav_header(num_channels: int, sample_rate: int, bits_per_sample: int) -> bytes:
    """
    Construct a WAV header indicating a very large (effectively infinite) data size.
    Many browsers/players accept 0xFFFFFFFF. We set both RIFF size and data size to 0xFFFFFFFF.
    """
    block_align = (num_channels * bits_per_sample) // 8
    byte_rate = sample_rate * block_align
    riff_size = 0xFFFFFFFF  # placeholder large size
    data_size = 0xFFFFFFFF  # placeholder large size

    # RIFF header (12 bytes)
    header = [
        b"RIFF",
        struct.pack("<I", riff_size),
        b"WAVE",
        # fmt chunk
        b"fmt ",
        struct.pack("<I", 16),  # PCM fmt chunk size
        struct.pack("<HHIIHH",
                    1,  # PCM
                    num_channels,
                    sample_rate,
                    byte_rate,
                    block_align,
                    bits_per_sample),
        # data chunk header with large size
        b"data",
        struct.pack("<I", data_size),
    ]
    return b"".join(header)

# ---------- Streaming logic ----------

async def stream_wav_response(
    request: web.Request,
    wav_path: str,
    chunk_bytes: int,
    tail_from_start: bool,
    prebuffer_ms: int,
    poll_sleep: float = 0.02,
) -> web.StreamResponse:
    """
    Per-connection handler: emits a WAV header and then tails bytes as the file grows.

    Strategy:
    - Open a fresh read-only FD (no locks).
    - Parse header to discover format and data offset.
    - Send our own "infinite" header (so client starts playing).
    - Position read pointer:
        * from_start=True  -> at data_offset.
        * else             -> near EOF minus prebuffer window (if available), clamped >= data_offset.
    - Loop: read up to chunk_bytes; if none available, sleep briefly and retry.
    - If file truncates (size shrinks), seek back to data_offset and continue.
    """
    # Minimal headers for streaming
    resp = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
            # NOTE: aiohttp will set Transfer-Encoding: chunked automatically for StreamResponse
        },
    )
    await resp.prepare(request)

    # Open file per-connection
    try:
        f = open(wav_path, "rb", buffering=0)
    except FileNotFoundError:
        await resp.write_eof()
        return resp

    try:
        # Wait until we at least have a RIFF+fmt+data headers
        # We wait for 44 bytes minimum, but then also parse for robust data_offset.
        try:
            wait_for_min_size(wav_path, 44, timeout=10.0)
        except TimeoutError:
            # Send empty then close
            await resp.write_eof()
            return resp

        # Parse header; retry a few times if writer hasn't finished chunks
        max_hdr_attempts = 30
        for _ in range(max_hdr_attempts):
            try:
                data_offset, data_size, ch, sr, bps = parse_wav_header(f)
                break
            except WavFormatError:
                await asyncio.sleep(0.05)
                f.seek(0, os.SEEK_SET)
        else:
            await resp.write_eof()
            return resp

        # Emit "infinite" header for client compatibility
        header = make_infinite_wav_header(ch, sr, bps)
        await resp.write(header)
        await resp.drain()

        # Determine starting read position
        # Compute prebuffer bytes if requested
        bytes_per_ms = max(1, (sr * ch * (bps // 8)) // 1000)
        prebuffer_bytes = prebuffer_ms * bytes_per_ms if prebuffer_ms > 0 else 0

        # Current file size
        try:
            st = os.stat(wav_path)
            current_size = st.st_size
        except FileNotFoundError:
            current_size = data_offset

        if tail_from_start:
            read_pos = data_offset
        else:
            # Start at max(data_offset, EOF - prebuffer)
            read_pos = max(data_offset, current_size - prebuffer_bytes)

        f.seek(read_pos, os.SEEK_SET)

        # Track inode to detect log rotation / replacement
        try:
            current_inode = os.stat(wav_path).st_ino
        except FileNotFoundError:
            current_inode = None

        # Streaming loop
        while not resp.task.done():
            try:
                # Detect replacement or truncation
                try:
                    st = os.stat(wav_path)
                    if current_inode is not None and st.st_ino != current_inode:
                        # File replaced; reopen and re-parse
                        f.close()
                        f = open(wav_path, "rb", buffering=0)
                        data_offset, data_size, ch, sr, bps = parse_wav_header(f)
                        f.seek(data_offset, os.SEEK_SET)
                        current_inode = st.st_ino
                        read_pos = data_offset
                    elif st.st_size < f.tell():
                        # Truncated; seek to data start
                        f.seek(data_offset, os.SEEK_SET)
                except FileNotFoundError:
                    await asyncio.sleep(poll_sleep)
                    continue

                data = f.read(chunk_bytes)
                if data:
                    await resp.write(data)
                    # Let the loop flush occasionally; aiohttp handles backpressure
                else:
                    await asyncio.sleep(poll_sleep)
            except (ConnectionResetError, asyncio.CancelledError, BrokenPipeError):
                break

    finally:
        try:
            f.close()
        except Exception:
            pass
        try:
            await resp.write_eof()
        except Exception:
            pass

    return resp

# ---------- HTTP server setup ----------

def build_app(wav_path: str, chunk_bytes: int):
    app = web.Application()

    async def index(request: web.Request) -> web.Response:
        # Minimal test page; iOS will require a tap to start audio.
        host = request.host
        return web.Response(
            text=f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>WAV Live Stream</title>
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 1rem; }}
    .hint {{ color: #555; font-size: 0.9rem; }}
    audio {{ width: 100%; margin-top: 1rem; }}
  </style>
</head>
<body>
  <h1>WAV Live Stream</h1>
  <div class="hint">Tap Play on iPhone (autoplay with sound is blocked by Safari).</div>
  <audio controls preload="none">
    <source src="/stream.wav" type="audio/wav">
    Your browser does not support the audio element.
  </audio>
  <p class="hint">Advanced: <code>/stream.wav?from_start=1</code> or <code>/stream.wav?prebuffer_ms=2000</code></p>
</body>
</html>""",
            content_type="text/html",
        )

    async def stream(request: web.Request) -> web.StreamResponse:
        qs = request.rel_url.query
        from_start = qs.get("from_start", "0") in ("1", "true", "yes")
        try:
            prebuffer_ms = int(qs.get("prebuffer_ms", "0"))
            prebuffer_ms = max(0, min(prebuffer_ms, 60_000))
        except ValueError:
            prebuffer_ms = 0

        return await stream_wav_response(
            request=request,
            wav_path=wav_path,
            chunk_bytes=chunk_bytes,
            tail_from_start=from_start,
            prebuffer_ms=prebuffer_ms,
        )

    app.router.add_get("/", index)
    app.router.add_get("/stream.wav", stream)
    return app

# ---------- Main ----------

def main():
    parser = argparse.ArgumentParser(description="Live WAV HTTP streamer (asyncio, low-overhead).")
    parser.add_argument("--wav", default="/tmp/audio.wav", help="Path to the growing WAV file.")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080).")
    parser.add_argument("--chunk-bytes", type=int, default=8192, help="Per-write chunk size (default: 8192).")
    parser.add_argument("--access-log", action="store_true", help="Enable aiohttp access logs.")
    args = parser.parse_args()

    # Small sanity checks; avoid tight loops if path is obviously wrong.
    if not os.path.isdir(os.path.dirname(os.path.abspath(args.wav))):
        print(f"ERROR: Directory does not exist for WAV: {args.wav}", file=sys.stderr)
        sys.exit(2)

    # Configure aiohttp app
    app = build_app(args.wav, args.chunk_bytes)

    # Access log toggle
    web.run_app(
        app,
        host=args.host,
        port=args.port,
        access_log=args.access_log,
        print=None,  # keep quiet
    )

if __name__ == "__main__":
    main()
