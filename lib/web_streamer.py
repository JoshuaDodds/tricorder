#!/usr/bin/env python3
"""
Lightweight WAV live streamer over HTTP for desktop/mobile (iOS Safari compatible).

Key features:
- Zero transcoding (pass-through PCM from a growing WAV).
- No file locks; per-client read-only tailing with tiny buffers.
- Async, low-overhead HTTP server (aiohttp) with chunked transfer.
- Sends an "infinite" WAV header per-connection so browsers start playback immediately.
- Multiple clients supported; each holds its own file descriptor.
- Supports rotating WAV inputs via a glob pattern (e.g., /apps/tricorder/tmp/*.wav).
- Client controls: ?from_start=1 and ?prebuffer_ms=NNN (up to 60s).
- Detects truncation and inode changes (log rotation), auto-recovers.
- Periodic rescan to switch to the latest WAV mid-stream when it appears.
- Runnable standalone (CLI) or embedded via start_web_streamer_in_thread() with clean stop().

Endpoints:
  GET /                 -> Minimal test page with <audio> tag.
  GET /stream.wav       -> Live WAV stream (starts at tail by default).
                           Query params:
                             from_start=1    start at data chunk start
                             prebuffer_ms=0  include up to N ms history before live tail (clamped)
  GET /healthz          -> JSON with currently selected file (best effort)
"""

import argparse
import asyncio
import glob
import logging
import os
import struct
import threading
import time
from dataclasses import dataclass
from typing import Optional, Tuple

from aiohttp import web

# ---------- WAV parsing / header utilities ----------

RIFF = b"RIFF"
WAVE = b"WAVE"
FMT_ = b"fmt "
DATA = b"data"

class WavFormatError(Exception):
    pass

def _read_exact(f, n: int) -> bytes:
    """Blocking exact read; returns fewer only at EOF (writer not ready)."""
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

    fmt_found = False
    data_offset = None
    data_size = None
    num_channels = sample_rate = bits_per_sample = None

    while True:
        chunk_hdr = _read_exact(f, 8)
        if len(chunk_hdr) < 8:
            raise WavFormatError("Incomplete chunk header; file still being written")
        chunk_id, chunk_size = chunk_hdr[0:4], struct.unpack("<I", chunk_hdr[4:8])[0]

        if chunk_id == FMT_:
            fmt_data = _read_exact(f, chunk_size)
            if len(fmt_data) < 16:
                raise WavFormatError("fmt chunk too small")
            audio_format, num_channels, sample_rate, byte_rate, block_align, bits_per_sample = struct.unpack(
                "<HHIIHH", fmt_data[:16]
            )
            # We do not transcode; if not PCM (1) or IEEE float (3), some clients may fail.
            fmt_found = True
        elif chunk_id == DATA:
            data_offset = f.tell()
            data_size = chunk_size
            break
        else:
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
    riff_size = 0xFFFFFFFF
    data_size = 0xFFFFFFFF

    return b"".join([
        b"RIFF",
        struct.pack("<I", riff_size),
        b"WAVE",
        b"fmt ",
        struct.pack("<I", 16),
        struct.pack("<HHIIHH",
                    1,  # PCM
                    num_channels,
                    sample_rate,
                    byte_rate,
                    block_align,
                    bits_per_sample),
        b"data",
        struct.pack("<I", data_size),
    ])

# ---------- WAV source resolver (glob) ----------

@dataclass
class ActiveFile:
    path: str
    inode: Optional[int]

class WavSourceResolver:
    """
    Resolves the active WAV file from a glob pattern (e.g., /apps/tricorder/tmp/*.wav).
    Picks the most recently modified file that is at least header-sized.
    """

    def __init__(self, pattern: str, min_bytes: int = 44):
        self.pattern = pattern
        self.min_bytes = min_bytes

    def pick_latest(self) -> Optional[ActiveFile]:
        candidates = [p for p in glob.glob(self.pattern) if os.path.isfile(p)]
        if not candidates:
            return None
        candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for p in candidates:
            try:
                st = os.stat(p)
                if st.st_size >= self.min_bytes:
                    return ActiveFile(path=p, inode=st.st_ino)
            except FileNotFoundError:
                continue
        return None

# ---------- Streaming logic ----------

async def stream_wav_response(
    request: web.Request,
    source: WavSourceResolver,
    chunk_bytes: int,
    tail_from_start: bool,
    prebuffer_ms: int,
    poll_sleep: float = 0.02,
    rescan_secs: float = 1.0,
) -> web.StreamResponse:
    """
    Per-connection handler: emits a WAV header and then tails bytes as the file grows.
    Supports file rotation: periodically rescans the glob and switches to the newest ready file.
    """
    app = request.app
    shutdown_event: asyncio.Event = app["shutdown_event"]  # set by start/stop
    peer = request.transport.get_extra_info("peername")
    log = logging.getLogger("web_streamer")
    log.info("Client connect %s qs=%s", peer, dict(request.rel_url.query))

    resp = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
        },
    )
    await resp.prepare(request)

    f = None
    active: Optional[ActiveFile] = None
    last_rescan = 0.0

    try:
        # Initial resolve with a short wait window for early clients
        deadline = time.time() + 10
        while active is None and time.time() < deadline and not shutdown_event.is_set():
            active = source.pick_latest()
            if not active:
                await asyncio.sleep(0.25)

        if not active:
            await resp.write_eof()
            return resp

        # Open file
        try:
            f = open(active.path, "rb", buffering=0)
        except FileNotFoundError:
            await resp.write_eof()
            return resp

        log.info("Streaming from %s (inode=%s) to %s", active.path, active.inode, peer)

        # Ensure header present
        try:
            wait_for_min_size(active.path, 44, timeout=10.0)
        except TimeoutError:
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

        # Emit "infinite" header
        header = make_infinite_wav_header(ch, sr, bps)
        await resp.write(header)
        await resp.drain()

        # Start position
        bytes_per_ms = max(1, (sr * ch * (bps // 8)) // 1000)
        prebuffer_bytes = prebuffer_ms * bytes_per_ms if prebuffer_ms > 0 else 0

        try:
            st = os.stat(active.path)
            current_size = st.st_size
        except FileNotFoundError:
            current_size = data_offset

        if tail_from_start:
            read_pos = data_offset
        else:
            read_pos = max(data_offset, current_size - prebuffer_bytes)

        f.seek(read_pos, os.SEEK_SET)

        # Streaming loop
        while not resp.task.done() and not shutdown_event.is_set():
            # Periodic rescan for rotation/switch
            now = time.time()
            if (now - last_rescan) >= rescan_secs:
                last_rescan = now
                latest = source.pick_latest()
                if latest and active and latest.path != active.path:
                    try:
                        st = os.stat(latest.path)
                        if st.st_size >= 44:
                            log.info("Switching source: %s -> %s", active.path, latest.path)
                            try:
                                f.close()
                            except Exception:
                                pass
                            f = open(latest.path, "rb", buffering=0)
                            try:
                                _ = parse_wav_header(f)
                            except WavFormatError:
                                # Header not ready; revert to previous handle
                                f.close()
                                f = open(active.path, "rb", buffering=0)
                                f.seek(read_pos, os.SEEK_SET)
                            else:
                                # On switch, restart streaming at new data start (no resend of header)
                                data_offset, _, ch, sr, bps = parse_wav_header(f)
                                f.seek(data_offset, os.SEEK_SET)
                                read_pos = data_offset
                                active = latest
                    except FileNotFoundError:
                        pass

            # Detect truncation/replacement of active file
            try:
                st = os.stat(active.path)
                if active.inode is not None and st.st_ino != active.inode:
                    log.info("Detected inode change for %s; reopening", active.path)
                    try:
                        f.close()
                    except Exception:
                        pass
                    f = open(active.path, "rb", buffering=0)
                    data_offset, _, ch, sr, bps = parse_wav_header(f)
                    f.seek(data_offset, os.SEEK_SET)
                    active = ActiveFile(path=active.path, inode=st.st_ino)
                    read_pos = data_offset
                elif st.st_size < f.tell():
                    # Truncated
                    log.info("Detected truncation for %s; seeking to data_offset", active.path)
                    f.seek(data_offset, os.SEEK_SET)
            except FileNotFoundError:
                await asyncio.sleep(poll_sleep)
                continue

            data = f.read(chunk_bytes)
            if data:
                await resp.write(data)
            else:
                await asyncio.sleep(poll_sleep)

    except (ConnectionResetError, asyncio.CancelledError, BrokenPipeError):
        pass
    except Exception as e:
        logging.getLogger("web_streamer").exception("Unhandled stream error: %r", e)
    finally:
        try:
            if f:
                f.close()
        except Exception:
            pass
        try:
            await resp.write_eof()
        except Exception:
            pass
        logging.getLogger("web_streamer").info("Client disconnect %s", peer)

    return resp

# ---------- HTTP server setup ----------

def build_app(pattern: str, chunk_bytes: int) -> web.Application:
    source = WavSourceResolver(pattern)
    log = logging.getLogger("web_streamer")
    app = web.Application()
    app["shutdown_event"] = asyncio.Event()
    app["pattern"] = pattern
    app["chunk_bytes"] = chunk_bytes
    app["source"] = source

    async def index(_: web.Request) -> web.Response:
        return web.Response(
            text="""<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>WAV Live Stream</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 1rem; }
.hint { color: #555; font-size: 0.9rem; }
audio { width: 100%; margin-top: 1rem; }
</style>
</head>
<body>
  <h1>WAV Live Stream</h1>
  <div class="hint">Tap Play on iPhone (autoplay with sound is blocked by Safari).</div>
  <audio controls preload="none">
    <source src="/stream.wav" type="audio/wav">
  </audio>
  <p class="hint">Advanced: <code>/stream.wav?from_start=1</code> or <code>/stream.wav?prebuffer_ms=2000</code></p>
</body>
</html>""",
            content_type="text/html",
        )

    async def healthz(_: web.Request) -> web.Response:
        af = source.pick_latest()
        body = {
            "pattern": pattern,
            "active_path": af.path if af else None,
            "active_inode": af.inode if af else None,
        }
        return web.json_response(body)

    async def stream(request: web.Request) -> web.StreamResponse:
        qs = request.rel_url.query
        from_start = qs.get("from_start", "0").lower() in ("1", "true", "yes", "y")
        try:
            prebuffer_ms = int(qs.get("prebuffer_ms", "0"))
            prebuffer_ms = max(0, min(prebuffer_ms, 60_000))
        except ValueError:
            prebuffer_ms = 0

        log.info(
            "New stream request from %s params from_start=%s prebuffer_ms=%s",
            request.transport.get_extra_info("peername"),
            from_start,
            prebuffer_ms,
        )
        return await stream_wav_response(
            request=request,
            source=source,
            chunk_bytes=chunk_bytes,
            tail_from_start=from_start,
            prebuffer_ms=prebuffer_ms,
        )

    app.router.add_get("/", index)
    app.router.add_get("/stream.wav", stream)
    app.router.add_get("/healthz", healthz)
    return app

# ---------- Threaded runner with clean stop ----------

class WebStreamerHandle:
    """
    Handle returned by start_web_streamer_in_thread(). Call stop() to cleanly shut down.
    """
    def __init__(self, thread: threading.Thread, loop: asyncio.AbstractEventLoop, runner: web.AppRunner, app: web.Application):
        self.thread = thread
        self.loop = loop
        self.runner = runner
        self.app = app

    def stop(self, timeout: float = 5.0):
        log = logging.getLogger("web_streamer")
        log.info("Stopping web_streamer ...")
        if self.loop.is_running():
            # Signal handlers to exit their loops
            self.loop.call_soon_threadsafe(self.app["shutdown_event"].set)
            # Cleanup runner, then stop loop
            async def _cleanup():
                try:
                    await self.runner.cleanup()
                except Exception as e:
                    log.warning("Error during aiohttp runner cleanup: %r", e)
            fut = asyncio.run_coroutine_threadsafe(_cleanup(), self.loop)
            try:
                fut.result(timeout=timeout)
            except Exception as e:
                log.warning("Error awaiting cleanup: %r", e)
            self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=timeout)
        log.info("web_streamer stopped")

def start_web_streamer_in_thread(
    pattern: str = "/apps/tricorder/tmp/*.wav",
    host: str = "0.0.0.0",
    port: int = 8080,
    chunk_bytes: int = 8192,
    access_log: bool = False,
    log_level: str = "INFO",
) -> WebStreamerHandle:
    """
    Launch the aiohttp server in a dedicated thread with its own event loop.
    Returns a WebStreamerHandle with stop().
    """
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    log = logging.getLogger("web_streamer")

    loop = asyncio.new_event_loop()
    runner_box = {}
    app_box = {}

    def _run():
        asyncio.set_event_loop(loop)
        app = build_app(pattern, chunk_bytes)
        runner = web.AppRunner(app, access_log=access_log)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, host, port)
        loop.run_until_complete(site.start())
        runner_box["runner"] = runner
        app_box["app"] = app
        log.info("web_streamer started on %s:%s pattern=%s", host, port, pattern)
        try:
            loop.run_forever()
        finally:
            # Ensure we cleanup if stop() didn't already do it
            try:
                loop.run_until_complete(runner.cleanup())
            except Exception:
                pass

    t = threading.Thread(target=_run, name="web_streamer", daemon=True)
    t.start()

    # Wait until runner/app are ready
    while "runner" not in runner_box or "app" not in app_box:
        time.sleep(0.05)

    return WebStreamerHandle(t, loop, runner_box["runner"], app_box["app"])

# ---------- CLI Main ----------

def cli_main():
    parser = argparse.ArgumentParser(description="Live WAV HTTP streamer (asyncio, low-overhead).")
    parser.add_argument("--pattern", default="/apps/tricorder/tmp/*.wav",
                        help="Glob for WAV files (default: /apps/tricorder/tmp/*.wav).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080).")
    parser.add_argument("--chunk-bytes", type=int, default=8192, help="Per-write chunk size (default: 8192).")
    parser.add_argument("--access-log", action="store_true", help="Enable aiohttp access logs.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level (default: INFO).")
    args = parser.parse_args()

    # Directory sanity check to avoid tight loops if path is wrong
    dir_glob_root = os.path.dirname(args.pattern.rstrip("*"))
    if dir_glob_root and not os.path.isdir(dir_glob_root):
        print(f"ERROR: Directory does not exist for pattern: {args.pattern}", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    logging.getLogger("web_streamer").info("Starting server on %s:%s pattern=%s", args.host, args.port, args.pattern)

    # Run using the same threaded mechanism, but block in main thread
    handle = start_web_streamer_in_thread(
        pattern=args.pattern,
        host=args.host,
        port=args.port,
        chunk_bytes=args.chunk_bytes,
        access_log=args.access_log,
        log_level=args.log_level,
    )
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        handle.stop()
        return 0

if __name__ == "__main__":
    raise SystemExit(cli_main())
