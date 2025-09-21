#!/usr/bin/env python3
"""
Lightweight HTTP streamer for iOS-friendly playback.

Overview:
- live_stream_daemon tees raw PCM into ffmpeg which encodes Opus-in-Ogg:
    $BASE/tmp/web_stream.ogg
- This module streams that growing Ogg file to browsers.

Key features:
- No transcoding here; just file tailing.
- Async, low-overhead server (aiohttp) with chunked transfer.
- Multiple clients; each uses its own FD.
- Runnable standalone or via start_web_streamer_in_thread() with clean stop().

Endpoints:
  GET /               -> Minimal test page with <audio> tag (Opus/Ogg).
  GET /stream.ogg     -> Live Ogg stream of the rolling file.
  GET /healthz        -> JSON with info about the current active file
"""
import argparse
import asyncio
import glob
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Optional

from aiohttp import web

@dataclass
class ActiveFile:
    path: str
    inode: Optional[int]

class SourceResolver:
    def __init__(self, pattern: str, min_bytes: int = 1):
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

async def stream_file_response(
    request: web.Request,
    source: SourceResolver,
    chunk_bytes: int,
    poll_sleep: float = 0.02,
) -> web.StreamResponse:
    app = request.app
    shutdown_event: asyncio.Event = app["shutdown_event"]
    peer = request.transport.get_extra_info("peername")
    log = logging.getLogger("web_streamer")
    log.info("Client connect %s", peer)

    resp = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "audio/ogg",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
        },
    )
    await resp.prepare(request)

    f = None
    active: Optional[ActiveFile] = None

    try:
        # Resolve with short wait loop to let ffmpeg create the file
        deadline = time.time() + 10
        while active is None and time.time() < deadline and not shutdown_event.is_set():
            active = source.pick_latest()
            if not active:
                await asyncio.sleep(0.25)

        if not active:
            await resp.write_eof()
            return resp

        try:
            f = open(active.path, "rb", buffering=0)
        except FileNotFoundError:
            await resp.write_eof()
            return resp

        log.info("Streaming Ogg from %s (inode=%s) to %s", active.path, active.inode, peer)

        # Always start from the beginning so clients receive BOS pages/headers.
        f.seek(0, os.SEEK_SET)

        while not resp.task.done() and not shutdown_event.is_set():
            try:
                st = os.stat(active.path)
                if active.inode is not None and st.st_ino != active.inode:
                    # File replaced (rotation) -> reopen and start from beginning
                    try:
                        f.close()
                    except Exception:
                        pass
                    f = open(active.path, "rb", buffering=0)
                    f.seek(0, os.SEEK_SET)
                    active = ActiveFile(path=active.path, inode=st.st_ino)
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

def build_app(pattern: str, chunk_bytes: int) -> web.Application:
    source = SourceResolver(pattern)
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
<title>Tricorder Live Stream</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 1rem; }
.hint { color: #555; font-size: 0.9rem; }
audio { width: 100%; margin-top: 1rem; }
</style>
</head>
<body>
  <h1>Tricorder Live Stream</h1>
  <div class="hint">Tap Play on iPhone (autoplay with sound is blocked by Safari).</div>
  <audio controls preload="none">
    <source src="/stream.ogg" type="audio/ogg">
  </audio>
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
        log.info("New stream request from %s", request.transport.get_extra_info("peername"))
        return await stream_file_response(
            request=request,
            source=source,
            chunk_bytes=chunk_bytes,
        )

    app.router.add_get("/", index)
    app.router.add_get("/stream.ogg", stream)
    app.router.add_get("/healthz", healthz)
    return app

class WebStreamerHandle:
    def __init__(self, thread: threading.Thread, loop: asyncio.AbstractEventLoop, runner: web.AppRunner, app: web.Application):
        self.thread = thread
        self.loop = loop
        self.runner = runner
        self.app = app

    def stop(self, timeout: float = 5.0):
        log = logging.getLogger("web_streamer")
        log.info("Stopping web_streamer ...")
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.app["shutdown_event"].set)
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
    pattern: str = "/apps/tricorder/tmp/web_stream.ogg",
    host: str = "0.0.0.0",
    port: int = 8080,
    chunk_bytes: int = 8192,
    access_log: bool = False,
    log_level: str = "INFO",
) -> WebStreamerHandle:
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
            try:
                loop.run_until_complete(runner.cleanup())
            except Exception:
                pass

    t = threading.Thread(target=_run, name="web_streamer", daemon=True)
    t.start()

    while "runner" not in runner_box or "app" not in app_box:
        time.sleep(0.05)

    return WebStreamerHandle(t, loop, runner_box["runner"], app_box["app"])

def cli_main():
    parser = argparse.ArgumentParser(description="Live Ogg/Opus HTTP streamer (asyncio, low-overhead).")
    parser.add_argument("--pattern", default="/apps/tricorder/tmp/web_stream.ogg",
                        help="Path or glob for Ogg file (default: /apps/tricorder/tmp/web_stream.ogg).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080).")
    parser.add_argument("--chunk-bytes", type=int, default=8192, help="Per-write chunk size (default: 8192).")
    parser.add_argument("--access-log", action="store_true", help="Enable aiohttp access logs.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level (default: INFO).")
    args = parser.parse_args()

    dir_glob_root = os.path.dirname(args.pattern.rstrip("*"))
    if dir_glob_root and not os.path.isdir(dir_glob_root):
        print(f"ERROR: Directory does not exist for pattern: {args.pattern}", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    logging.getLogger("web_streamer").info("Starting server on %s:%s pattern=%s", args.host, args.port, args.pattern)

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
