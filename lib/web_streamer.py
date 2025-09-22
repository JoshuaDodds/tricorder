#!/usr/bin/env python3
"""
aiohttp web server for serving the HLS audio stream.

Overview:
- Audio is captured by live_stream_daemon and fed into HLSTee (ffmpeg).
- HLSTee writes HLS playlist (.m3u8) + segments (.ts) into tmp/hls/.
- This server only serves those HLS artifacts over HTTP.

Endpoints:
  GET /         -> Minimal page with <audio> tag (HLS)
  GET /hls      -> Same, alternate route
  GET /hls/*    -> Static playlist/segments
  GET /healthz  -> Health check
"""

import argparse
import asyncio
import logging
import os
import threading
import time

from aiohttp import web


def build_app() -> web.Application:
    log = logging.getLogger("web_streamer")
    app = web.Application()
    app["shutdown_event"] = asyncio.Event()

    tmp_root = os.environ.get("TRICORDER_TMP", "/apps/tricorder/tmp")
    hls_dir = os.path.join(tmp_root, "hls")

    async def index(_: web.Request) -> web.Response:
        return web.Response(
            text="""<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tricorder HLS Stream</title></head>
<body>
  <h1>HLS Audio Stream</h1>
  <audio id="player" controls autoplay></audio>
  <script>
  (function() {
    var url = '/hls/live.m3u8';
    var audio = document.getElementById('player');
    function nativeHlsOk() {
      return audio.canPlayType('application/vnd.apple.mpegurl') || audio.canPlayType('application/x-mpegURL');
    }
    if (nativeHlsOk()) {
      audio.src = url;
    } else {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
      s.onload = function() {
        if (window.Hls && window.Hls.isSupported()) {
          var hls = new Hls({ lowLatencyMode: true });
          hls.loadSource(url);
          hls.attachMedia(audio);
        } else {
          audio.src = url;
        }
      };
      document.body.appendChild(s);
    }
  })();
  </script>
  <p><a href="/healthz">healthz</a></p>
</body>
</html>""",
            content_type="text/html",
        )

    async def healthz(_: web.Request) -> web.Response:
        return web.Response(text="ok\n")

    # Routes
    app.router.add_get("/", index)
    app.router.add_get("/hls", index)
    app.router.add_static("/hls/", hls_dir, show_index=True)
    app.router.add_get("/healthz", healthz)

    return app


class WebStreamerHandle:
    """Handle returned by start_web_streamer_in_thread(). Call stop() to cleanly shut down."""
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
    host: str = "0.0.0.0",
    port: int = 8080,
    access_log: bool = False,
    log_level: str = "INFO",
) -> WebStreamerHandle:
    """Launch the aiohttp server in a dedicated thread with its own event loop."""
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
        app = build_app()
        runner = web.AppRunner(app, access_log=access_log)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, host, port)
        loop.run_until_complete(site.start())
        runner_box["runner"] = runner
        app_box["app"] = app
        log.info("web_streamer started on %s:%s (HLS only)", host, port)
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
    parser = argparse.ArgumentParser(description="HLS-only HTTP streamer (asyncio, aiohttp).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080).")
    parser.add_argument("--access-log", action="store_true", help="Enable aiohttp access logs.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level (default: INFO).")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    logging.getLogger("web_streamer").info("Starting HLS-only server on %s:%s", args.host, args.port)

    handle = start_web_streamer_in_thread(
        host=args.host,
        port=args.port,
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
