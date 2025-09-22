#!/usr/bin/env python3
"""
aiohttp web server for serving the HLS audio stream (on-demand encoder).

Behavior:
- First client arrival starts the encoder (via controller.ensure_started()).
- Last client leaving schedules encoder stop after a cooldown (default 10s).
- UI shows live active client count and encoder state.

Endpoints:
  GET /                 -> HTML page with HLS <audio>, recordings view, config viewer
  GET /hls              -> Same HTML as /
  GET /hls/live.m3u8    -> Ensures encoder started; returns playlist (or bootstrap)
  GET /hls/start        -> Increments client count (starts encoder if needed)
  GET /hls/stop         -> Decrements client count (may stop encoder after cooldown)
  GET /hls/stats        -> JSON {active_clients, encoder_running, ...}
  GET /api/recordings   -> JSON listing of on-disk recordings
  POST /api/recordings/delete -> Remove recordings from disk
  GET /api/config       -> JSON view of the merged configuration
  Static /hls/*         -> HLS artifacts directory (segments + playlist)
  Static /recordings/*  -> Served recordings for playback/download
  GET /healthz          -> "ok"
"""

import argparse
import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from aiohttp import web

from lib.config import get_cfg
from lib.hls_controller import controller
from lib import webui
from lib.webui.recordings import list_available_days, list_recordings


DEFAULT_RECORDING_LIMIT = 100


def build_app(config: dict[str, Any] | None = None) -> web.Application:
    log = logging.getLogger("web_streamer")
    app = web.Application()
    app["shutdown_event"] = asyncio.Event()

    cfg = config if config is not None else get_cfg()
    path_cfg = cfg.get("paths", {})

    tmp_root = os.environ.get("TRICORDER_TMP") or path_cfg.get("tmp_dir", "/apps/tricorder/tmp")
    hls_dir = os.path.join(tmp_root, "hls")
    os.makedirs(hls_dir, exist_ok=True)

    recordings_root = Path(path_cfg.get("recordings_dir", "/apps/tricorder/recordings")).expanduser()
    recordings_root.mkdir(parents=True, exist_ok=True)
    app["config"] = cfg
    app["recordings_root"] = recordings_root

    template_defaults = {
        "page_title": "Tricorder HLS Stream",
        "heading": "HLS Audio Stream",
        "recordings_heading": "Recent Recordings",
        "config_heading": "Configuration",
    }

    async def index(_: web.Request) -> web.Response:
        html = webui.render_template("hls_index.html", **template_defaults)
        return web.Response(text=html, content_type="text/html")

    # --- Control/Stats API ---
    async def hls_start(_: web.Request) -> web.Response:
        n = controller.client_connected()
        return web.json_response({"ok": True, "active_clients": n})

    async def hls_stop(_: web.Request) -> web.Response:
        n = controller.client_disconnected()
        return web.json_response({"ok": True, "active_clients": n})

    async def hls_stats(_: web.Request) -> web.Response:
        return web.json_response(controller.status())

    # Playlist handler ensures encoder has been started on direct hits
    async def hls_playlist(_: web.Request) -> web.StreamResponse:
        controller.ensure_started()
        path = os.path.join(hls_dir, "live.m3u8")
        if not os.path.exists(path):
            # Bootstrap playlist so players poll while ffmpeg warms up
            text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n"
            return web.Response(text=text, content_type="application/vnd.apple.mpegurl",
                                headers={"Cache-Control": "no-store"})
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})

    async def recordings_index(request: web.Request) -> web.Response:
        query = request.rel_url.query
        limit_param = query.get("limit")
        try:
            limit = int(limit_param) if limit_param else DEFAULT_RECORDING_LIMIT
        except (TypeError, ValueError):
            return web.json_response({"error": "limit must be an integer"}, status=400)
        limit = max(1, min(limit, 500))

        day = query.get("day")
        if day:
            day = day.strip()
            if day.lower() == "all":
                day = None

        category = query.get("type")
        if category:
            category = category.strip()
            if category.lower() == "all":
                category = None

        search = query.get("q")
        if search:
            search = search.strip()
            if not search:
                search = None

        try:
            items, has_more = list_recordings(
                recordings_root,
                limit=limit,
                day=day,
                category=category,
                search=search,
            )
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        days = list_available_days(recordings_root)
        payload = {
            "items": items,
            "has_more": has_more,
            "count": len(items),
            "limit": limit,
            "days": days,
            "filters": {
                "day": day,
                "type": category,
                "q": search,
            },
        }
        return web.json_response(payload)

    async def recordings_delete(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON payload"}, status=400)

        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list) or not items:
            return web.json_response({"error": "items must be a non-empty list"}, status=400)

        root_resolved = recordings_root.resolve()
        deleted: list[str] = []
        failed: list[dict[str, str]] = []

        for raw in items:
            if not isinstance(raw, str):
                failed.append({"id": str(raw), "error": "invalid identifier"})
                continue
            rel = raw.strip().lstrip("/")
            if not rel:
                failed.append({"id": raw, "error": "empty identifier"})
                continue
            target = (recordings_root / rel).resolve(strict=False)
            if root_resolved not in target.parents and target != root_resolved:
                failed.append({"id": rel, "error": "out of bounds"})
                continue
            try:
                if not target.is_file():
                    failed.append({"id": rel, "error": "not found"})
                    continue
                target.unlink()
                deleted.append(rel)
            except FileNotFoundError:
                failed.append({"id": rel, "error": "not found"})
                continue
            except OSError as exc:  # pragma: no cover - unlikely but handled defensively
                failed.append({"id": rel, "error": str(exc)})
                continue

            parent = target.parent
            if parent != root_resolved:
                try:
                    parent.rmdir()
                except OSError:
                    pass

        status_code = 200 if deleted or not failed else 404
        return web.json_response({
            "deleted": deleted,
            "deleted_count": len(deleted),
            "failed": failed,
        }, status=status_code)

    async def config_view(_: web.Request) -> web.Response:
        try:
            config_json = json.dumps(cfg, indent=2, sort_keys=True)
        except TypeError:
            config_json = json.dumps(cfg, indent=2)
        return web.json_response({"config": cfg, "text": config_json})

    async def healthz(_: web.Request) -> web.Response:
        return web.Response(text="ok\n")

    # Routes
    app.router.add_get("/", index)
    app.router.add_get("/hls", index)

    # Control + stats
    app.router.add_get("/hls/start", hls_start)
    app.router.add_get("/hls/stop", hls_stop)
    app.router.add_get("/hls/stats", hls_stats)

    # Playlist handler BEFORE static, so we can ensure start on direct access
    app.router.add_get("/hls/live.m3u8", hls_playlist)

    # Recordings and configuration APIs
    app.router.add_get("/api/recordings", recordings_index)
    app.router.add_post("/api/recordings/delete", recordings_delete)
    app.router.add_get("/api/config", config_view)

    # Static segments/playlist directory (segments like seg00001.ts)
    app.router.add_static("/hls/", hls_dir, show_index=True)
    app.router.add_static("/static/", webui.static_directory(), show_index=False)
    app.router.add_static("/recordings/", os.fspath(recordings_root), show_index=False)

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
        log.info("web_streamer started on %s:%s (HLS on-demand)", host, port)
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
    parser = argparse.ArgumentParser(description="HLS HTTP streamer (on-demand).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080).")
    parser.add_argument("--access-log", action="store_true", help="Enable aiohttp access logs.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level (default: INFO).")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    logging.getLogger("web_streamer").info("Starting HLS server (on-demand) on %s:%s", args.host, args.port)

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
