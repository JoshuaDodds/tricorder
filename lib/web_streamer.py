#!/usr/bin/env python3
"""
aiohttp-based HTTP streamer for live Opus/Ogg audio.

- Shares a single ffmpeg process (spawned by live_stream_daemon).
- Reads from ffmpeg_proc.stdout and fans out to all connected clients.
- Each client gets the Opus/Ogg headers immediately, so Safari/iOS can play.

Endpoints:
  GET /          -> Minimal test page with <audio> tag.
  GET /stream.ogg -> Live audio stream (Content-Type: audio/ogg).
  GET /healthz   -> JSON status.
"""

import asyncio
import logging
import threading
import time
from aiohttp import web

# Global broadcaster state
_clients = set()
_shutdown_event = None

async def broadcaster_loop(ffmpeg_stdout, chunk_bytes=4096):
    log = logging.getLogger("web_streamer")
    while not _shutdown_event.is_set():
        try:
            data = ffmpeg_stdout.read(chunk_bytes)
            if not data:
                await asyncio.sleep(0.01)
                continue
            # Push to all connected clients
            dead = []
            for q in _clients:
                try:
                    q.put_nowait(data)
                except asyncio.QueueFull:
                    dead.append(q)
            for q in dead:
                _clients.discard(q)
        except Exception as e:
            log.warning("broadcaster error: %r", e)
            await asyncio.sleep(0.05)


async def stream_handler(request):
    log = logging.getLogger("web_streamer")
    peer = request.transport.get_extra_info("peername")

    q = asyncio.Queue(maxsize=100)
    _clients.add(q)
    log.info("Client connected: %s", peer)

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

    try:
        while not _shutdown_event.is_set():
            try:
                data = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            await resp.write(data)
    except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        _clients.discard(q)
        try:
            await resp.write_eof()
        except Exception:
            pass
        log.info("Client disconnected: %s", peer)

    return resp


def build_app(ffmpeg_stdout, chunk_bytes: int):
    app = web.Application()
    global _shutdown_event
    _shutdown_event = asyncio.Event()

    async def index(_):
        return web.Response(
            text="""<!doctype html>
<html><body>
<h1>Tricorder Live Stream</h1>
<audio controls autoplay>
  <source src="/stream.ogg" type="audio/ogg">
</audio>
</body></html>""",
            content_type="text/html",
        )

    async def healthz(_):
        return web.json_response({
            "clients": len(_clients),
        })

    app.router.add_get("/", index)
    app.router.add_get("/stream.ogg", stream_handler)
    app.router.add_get("/healthz", healthz)

    app.on_startup.append(lambda app: asyncio.create_task(broadcaster_loop(ffmpeg_stdout, chunk_bytes)))
    return app


class WebStreamerHandle:
    def __init__(self, thread, loop, runner, app):
        self.thread = thread
        self.loop = loop
        self.runner = runner
        self.app = app

    def stop(self, timeout: float = 5.0):
        log = logging.getLogger("web_streamer")
        log.info("Stopping web_streamer ...")
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(_shutdown_event.set)
            async def _cleanup():
                try:
                    await self.runner.cleanup()
                except Exception as e:
                    log.warning("runner cleanup error: %r", e)
            fut = asyncio.run_coroutine_threadsafe(_cleanup(), self.loop)
            try:
                fut.result(timeout=timeout)
            except Exception:
                pass
            self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=timeout)
        log.info("web_streamer stopped")


def start_web_streamer_in_thread(ffmpeg_stdout, host="0.0.0.0", port=8080,
                                 chunk_bytes=4096, access_log=False, log_level="INFO"):
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
        app = build_app(ffmpeg_stdout, chunk_bytes)
        runner = web.AppRunner(app, access_log=access_log)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, host, port)
        loop.run_until_complete(site.start())
        runner_box["runner"] = runner
        app_box["app"] = app
        log.info("web_streamer started on %s:%s", host, port)
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
