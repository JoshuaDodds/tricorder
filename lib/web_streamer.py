#!/usr/bin/env python3
"""
aiohttp web server for Tricorder's live stream and management dashboard.

Behavior:
- First client arrival on the live stream starts the encoder (via
  controller.ensure_started()).
- Last live-stream client leaving schedules encoder stop after a cooldown
  (default 10s).
- Dashboard lists locally stored recordings with playback, download, and
  deletion controls.

Endpoints:
  GET /                    -> Dashboard HTML
  GET /dashboard           -> Same as /
  GET /api/recordings      -> JSON listing of recordings with filters
  POST /api/recordings/delete -> Delete one or more recordings
  GET /recordings/<path>   -> Serve/download a stored recording
  GET /api/config          -> JSON configuration snapshot
  GET /hls                 -> Legacy HLS HTML page with live stats
  GET /hls/live.m3u8       -> Ensures encoder started; returns playlist (or bootstrap)
  GET /hls/start           -> Increments client count (starts encoder if needed)
  GET /hls/stop            -> Decrements client count (may stop encoder after cooldown)
  GET /hls/stats           -> JSON {active_clients, encoder_running, ...}
  Static /hls/*            -> HLS artifacts directory (segments + playlist)
  GET /healthz             -> "ok"
"""

import argparse
import asyncio
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from aiohttp import web
from aiohttp.web import AppKey

from lib.hls_controller import controller
from lib import webui
from lib.config import get_cfg


SHUTDOWN_EVENT_KEY: AppKey[asyncio.Event] = web.AppKey("shutdown_event", asyncio.Event)
RECORDINGS_ROOT_KEY: AppKey[Path] = web.AppKey("recordings_root", Path)
ALLOWED_EXT_KEY: AppKey[tuple[str, ...]] = web.AppKey("recordings_allowed_ext", tuple)


def build_app() -> web.Application:
    log = logging.getLogger("web_streamer")
    app = web.Application()
    app[SHUTDOWN_EVENT_KEY] = asyncio.Event()

    tmp_root = os.environ.get("TRICORDER_TMP", "/apps/tricorder/tmp")
    hls_dir = os.path.join(tmp_root, "hls")
    os.makedirs(hls_dir, exist_ok=True)

    cfg = get_cfg()
    recordings_root = Path(cfg["paths"]["recordings_dir"])
    try:
        recordings_root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # pragma: no cover - permissions issues should not crash server
        log.warning("Unable to ensure recordings directory exists: %s", exc)
    app[RECORDINGS_ROOT_KEY] = recordings_root

    allowed_ext_cfg: Iterable[str] = cfg.get("ingest", {}).get("allowed_ext", [".opus"])
    allowed_ext = tuple(
        ext if ext.startswith(".") else f".{ext}"
        for ext in (s.lower() for s in allowed_ext_cfg)
    ) or (".opus",)
    app[ALLOWED_EXT_KEY] = allowed_ext

    try:
        recordings_root_resolved = recordings_root.resolve()
    except FileNotFoundError:
        recordings_root_resolved = recordings_root

    template_defaults = {
        "page_title": "Tricorder HLS Stream",
        "heading": "HLS Audio Stream",
    }

    async def dashboard(_: web.Request) -> web.Response:
        html = webui.render_template(
            "dashboard.html",
            page_title="Tricorder Dashboard",
        )
        return web.Response(text=html, content_type="text/html")

    async def hls_index(_: web.Request) -> web.Response:
        html = webui.render_template("hls_index.html", **template_defaults)
        return web.Response(text=html, content_type="text/html")

    def _scan_recordings() -> tuple[list[dict[str, object]], list[str], list[str]]:
        entries: list[dict[str, object]] = []
        day_set: set[str] = set()
        ext_set: set[str] = set()
        if not recordings_root.exists():
            return entries, [], []

        for path in recordings_root.rglob("*"):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if allowed_ext and suffix not in allowed_ext:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue

            try:
                rel = path.relative_to(recordings_root)
            except ValueError:
                continue

            rel_posix = rel.as_posix()
            day = rel.parts[0] if len(rel.parts) > 1 else ""
            if day:
                day_set.add(day)
            if suffix:
                ext_set.add(suffix)

            entries.append(
                {
                    "name": path.stem,
                    "path": rel_posix,
                    "day": day,
                    "extension": suffix.lstrip("."),
                    "size_bytes": stat.st_size,
                    "modified": stat.st_mtime,
                    "modified_iso": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                }
            )

        entries.sort(key=lambda item: item["modified"], reverse=True)
        days_sorted = sorted(day_set, reverse=True)
        exts_sorted = sorted(ext.lstrip(".") for ext in ext_set)
        return entries, days_sorted, exts_sorted

    def _filter_recordings(entries: list[dict[str, object]], request: web.Request) -> dict[str, object]:
        query = request.rel_url.query

        search = query.get("search", "").strip().lower()

        def _collect(key: str) -> set[str]:
            collected: set[str] = set()
            for raw in query.getall(key, []):
                for token in raw.split(","):
                    token = token.strip()
                    if token:
                        collected.add(token)
            return collected

        day_filter = _collect("day")
        ext_filter = {token.lower().lstrip(".") for token in _collect("ext")}

        try:
            limit = int(query.get("limit", "200"))
        except ValueError:
            limit = 200
        limit = max(1, min(1000, limit))

        try:
            offset = int(query.get("offset", "0"))
        except ValueError:
            offset = 0
        offset = max(0, offset)

        filtered: list[dict[str, object]] = []
        total_size = 0
        for item in entries:
            name = str(item.get("name", ""))
            path = str(item.get("path", ""))
            day = str(item.get("day", ""))
            ext = str(item.get("extension", ""))

            if search and search not in name.lower() and search not in path.lower():
                continue
            if day_filter and day not in day_filter:
                continue
            if ext_filter and ext.lower() not in ext_filter:
                continue

            filtered.append(item)
            try:
                total_size += int(item.get("size_bytes", 0))
            except (TypeError, ValueError):
                pass

        total = len(filtered)
        window = filtered[offset : offset + limit]

        payload_items = [
            {
                "name": str(entry.get("name", "")),
                "path": str(entry.get("path", "")),
                "day": str(entry.get("day", "")),
                "extension": str(entry.get("extension", "")),
                "size_bytes": int(entry.get("size_bytes", 0) or 0),
                "modified": float(entry.get("modified", 0.0) or 0.0),
                "modified_iso": str(entry.get("modified_iso", "")),
            }
            for entry in window
        ]

        return {
            "items": payload_items,
            "total": total,
            "total_size_bytes": total_size,
            "offset": offset,
            "limit": limit,
        }

    async def recordings_api(request: web.Request) -> web.Response:
        entries, available_days, available_exts = _scan_recordings()
        payload = _filter_recordings(entries, request)
        payload["available_days"] = available_days
        payload["available_extensions"] = available_exts
        return web.json_response(payload)

    async def recordings_delete(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        items = data.get("items")
        if not isinstance(items, list):
            raise web.HTTPBadRequest(reason="'items' must be a list")

        deleted: list[str] = []
        errors: list[dict[str, str]] = []
        root_resolved = recordings_root_resolved

        for raw in items:
            if not isinstance(raw, str) or not raw.strip():
                errors.append({"item": str(raw), "error": "invalid path"})
                continue

            rel = raw.strip().strip("/")
            candidate = recordings_root / rel
            try:
                resolved = candidate.resolve()
            except FileNotFoundError:
                errors.append({"item": rel, "error": "not found"})
                continue
            except Exception as exc:  # pragma: no cover - unexpected resolution errors
                errors.append({"item": rel, "error": str(exc)})
                continue

            try:
                resolved.relative_to(root_resolved)
            except ValueError:
                errors.append({"item": rel, "error": "outside recordings directory"})
                continue

            if not resolved.is_file():
                errors.append({"item": rel, "error": "not a file"})
                continue

            try:
                resolved.unlink()
                deleted.append(rel.replace(os.sep, "/"))
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                continue

            parent = resolved.parent
            while parent != recordings_root and parent != parent.parent:
                try:
                    next(parent.iterdir())
                except StopIteration:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
                    continue
                except Exception:
                    break
                break

        return web.json_response({"deleted": deleted, "errors": errors})

    async def recordings_file(request: web.Request) -> web.StreamResponse:
        rel = request.match_info.get("path", "").strip("/")
        if not rel:
            raise web.HTTPNotFound()

        candidate = recordings_root / rel
        try:
            resolved = candidate.resolve()
        except FileNotFoundError:
            raise web.HTTPNotFound() from None

        try:
            resolved.relative_to(recordings_root_resolved)
        except ValueError:
            raise web.HTTPNotFound()

        if not resolved.is_file():
            raise web.HTTPNotFound()

        response = web.FileResponse(resolved)
        disposition = "attachment" if request.rel_url.query.get("download") == "1" else "inline"
        response.headers["Content-Disposition"] = f'{disposition}; filename="{resolved.name}"'
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    async def config_snapshot(_: web.Request) -> web.Response:
        return web.json_response(cfg)

    # --- Control/Stats API ---
    async def hls_start(request: web.Request) -> web.Response:
        session_id = request.rel_url.query.get("session")
        n = controller.client_connected(session_id=session_id)
        return web.json_response({"ok": True, "active_clients": n})

    async def hls_stop(request: web.Request) -> web.Response:
        session_id = request.rel_url.query.get("session")
        n = controller.client_disconnected(session_id=session_id)
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

    async def healthz(_: web.Request) -> web.Response:
        return web.Response(text="ok\n")

    # Routes
    app.router.add_get("/", dashboard)
    app.router.add_get("/dashboard", dashboard)
    app.router.add_get("/hls", hls_index)

    app.router.add_get("/api/recordings", recordings_api)
    app.router.add_post("/api/recordings/delete", recordings_delete)
    app.router.add_post("/api/recordings/remove", recordings_delete)
    app.router.add_get("/recordings/{path:.*}", recordings_file)
    app.router.add_get("/api/config", config_snapshot)

    # Control + stats
    app.router.add_get("/hls/start", hls_start)
    app.router.add_post("/hls/start", hls_start)
    app.router.add_get("/hls/stop", hls_stop)
    app.router.add_post("/hls/stop", hls_stop)
    app.router.add_get("/hls/stats", hls_stats)

    # Playlist handler BEFORE static, so we can ensure start on direct access
    app.router.add_get("/hls/live.m3u8", hls_playlist)

    # Static segments/playlist directory (segments like seg00001.ts)
    app.router.add_static("/hls/", hls_dir, show_index=True)
    app.router.add_static("/static/", webui.static_directory(), show_index=False)

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
            self.loop.call_soon_threadsafe(self.app[SHUTDOWN_EVENT_KEY].set)

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
