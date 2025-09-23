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
import contextlib
import functools
import json
import logging
import os
import shutil
import subprocess
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from aiohttp import web
from aiohttp.web import AppKey

from lib.hls_controller import controller
from lib import webui
from lib.config import get_cfg


@functools.lru_cache(maxsize=1024)
def _probe_duration_cached(path_str: str, mtime_ns: int, size_bytes: int) -> float | None:
    _ = size_bytes  # participates in cache key to invalidate when file size changes
    path = Path(path_str)
    suffix = path.suffix.lower()

    if suffix == ".wav":
        try:
            with contextlib.closing(wave.open(path_str, "rb")) as wav_file:
                frames = wav_file.getnframes()
                rate = wav_file.getframerate() or 0
                if frames > 0 and rate > 0:
                    return frames / float(rate)
        except FileNotFoundError:
            return None
        except (OSError, wave.Error):
            pass

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path_str,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except (subprocess.SubprocessError, FileNotFoundError, PermissionError):
        return None

    duration_text = (result.stdout or "").strip()
    try:
        duration = float(duration_text)
    except (TypeError, ValueError):
        return None

    if duration <= 0:
        return None

    return duration


def _probe_duration(path: Path, stat: os.stat_result) -> float | None:
    mtime_ns = getattr(stat, "st_mtime_ns", None)
    if mtime_ns is None:
        mtime_ns = int(stat.st_mtime * 1_000_000_000)
    size_bytes = int(getattr(stat, "st_size", 0) or 0)
    return _probe_duration_cached(str(path), int(mtime_ns), size_bytes)


def _scan_recordings_worker(
    recordings_root: Path, allowed_ext: tuple[str, ...]
) -> tuple[list[dict[str, object]], list[str], list[str], int]:
    entries: list[dict[str, object]] = []
    day_set: set[str] = set()
    ext_set: set[str] = set()
    total_bytes = 0
    if not recordings_root.exists():
        return entries, [], [], 0

    for path in recordings_root.rglob("*"):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        if allowed_ext and suffix not in allowed_ext:
            continue
        waveform_path = path.with_suffix(path.suffix + ".waveform.json")
        try:
            waveform_stat = waveform_path.stat()
        except FileNotFoundError:
            continue
        except OSError:
            continue

        if waveform_stat.st_size <= 0:
            continue

        try:
            rel = path.relative_to(recordings_root)
            waveform_rel = waveform_path.relative_to(recordings_root)
        except ValueError:
            continue

        try:
            stat = path.stat()
        except OSError:
            continue

        waveform_meta: dict[str, object] | None = None
        try:
            with waveform_path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
                if isinstance(payload, dict):
                    waveform_meta = payload
        except (OSError, json.JSONDecodeError):
            continue

        raw_duration = None
        if waveform_meta is not None:
            raw_duration = waveform_meta.get("duration_seconds")
        duration = None
        if isinstance(raw_duration, (int, float)) and raw_duration > 0:
            duration = float(raw_duration)
        else:
            duration = _probe_duration(path, stat)

        rel_posix = rel.as_posix()
        day = rel.parts[0] if len(rel.parts) > 1 else ""
        if day:
            day_set.add(day)
        if suffix:
            ext_set.add(suffix)

        size_bytes = stat.st_size
        total_bytes += size_bytes
        entries.append(
            {
                "name": path.stem,
                "path": rel_posix,
                "day": day,
                "extension": suffix.lstrip("."),
                "size_bytes": size_bytes,
                "modified": stat.st_mtime,
                "modified_iso": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "duration": duration,
                "waveform_path": waveform_rel.as_posix(),
            }
        )

    entries.sort(key=lambda item: item["modified"], reverse=True)
    days_sorted = sorted(day_set, reverse=True)
    exts_sorted = sorted(ext.lstrip(".") for ext in ext_set)
    return entries, days_sorted, exts_sorted, total_bytes


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

    playlist_ready_timeout = 5.0
    playlist_poll_interval = 0.1

    def _playlist_has_segments(path: str) -> bool:
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    if line.lstrip().startswith("#EXTINF"):
                        return True
        except FileNotFoundError:
            return False
        except OSError:
            return False
        return False

    async def dashboard(_: web.Request) -> web.Response:
        html = webui.render_template(
            "dashboard.html",
            page_title="Tricorder Dashboard",
        )
        return web.Response(text=html, content_type="text/html")

    async def hls_index(_: web.Request) -> web.Response:
        html = webui.render_template("hls_index.html", **template_defaults)
        return web.Response(text=html, content_type="text/html")

    def _scan_recordings_sync() -> tuple[list[dict[str, object]], list[str], list[str], int]:
        return _scan_recordings_worker(recordings_root, allowed_ext)

    async def _scan_recordings() -> tuple[list[dict[str, object]], list[str], list[str], int]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _scan_recordings_sync)

    capture_status_path = os.path.join(cfg["paths"].get("tmp_dir", tmp_root), "segmenter_status.json")

    def _read_capture_status() -> dict[str, object]:
        try:
            with open(capture_status_path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            return {"capturing": False, "updated_at": None}
        except json.JSONDecodeError:
            return {"capturing": False, "updated_at": None, "error": "invalid"}
        except OSError:
            return {"capturing": False, "updated_at": None}

        status: dict[str, object] = {"capturing": bool(raw.get("capturing", False))}
        updated_at = raw.get("updated_at")
        if isinstance(updated_at, (int, float)):
            status["updated_at"] = float(updated_at)
        else:
            status["updated_at"] = None

        event_payload = raw.get("event")
        if isinstance(event_payload, dict):
            event: dict[str, object] = {}
            base_name = event_payload.get("base_name")
            if isinstance(base_name, str) and base_name:
                event["base_name"] = base_name
            started_at = event_payload.get("started_at")
            if isinstance(started_at, str) and started_at:
                event["started_at"] = started_at
            started_epoch = event_payload.get("started_epoch")
            if isinstance(started_epoch, (int, float)):
                event["started_epoch"] = float(started_epoch)
            trigger_rms = event_payload.get("trigger_rms")
            if isinstance(trigger_rms, (int, float)):
                event["trigger_rms"] = float(trigger_rms)
            if event:
                status["event"] = event

        last_payload = raw.get("last_event")
        if isinstance(last_payload, dict):
            last_event: dict[str, object] = {}
            base_name = last_payload.get("base_name")
            if isinstance(base_name, str) and base_name:
                last_event["base_name"] = base_name
            started_at = last_payload.get("started_at")
            if isinstance(started_at, str) and started_at:
                last_event["started_at"] = started_at
            started_epoch = last_payload.get("started_epoch")
            if isinstance(started_epoch, (int, float)):
                last_event["started_epoch"] = float(started_epoch)
            ended_epoch = last_payload.get("ended_epoch")
            if isinstance(ended_epoch, (int, float)):
                last_event["ended_epoch"] = float(ended_epoch)
            duration_seconds = last_payload.get("duration_seconds")
            if isinstance(duration_seconds, (int, float)):
                last_event["duration_seconds"] = float(duration_seconds)
            avg_rms = last_payload.get("avg_rms")
            if isinstance(avg_rms, (int, float)):
                last_event["avg_rms"] = float(avg_rms)
            trigger_rms = last_payload.get("trigger_rms")
            if isinstance(trigger_rms, (int, float)):
                last_event["trigger_rms"] = float(trigger_rms)
            etype = last_payload.get("etype")
            if isinstance(etype, str) and etype:
                last_event["etype"] = etype
            if last_event:
                status["last_event"] = last_event

        reason = raw.get("last_stop_reason")
        if isinstance(reason, str) and reason:
            status["last_stop_reason"] = reason

        return status

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
            limit = int(query.get("limit", "500"))
        except ValueError:
            limit = 500
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
                "duration_seconds": (
                    float(entry.get("duration"))
                    if isinstance(entry.get("duration"), (int, float))
                    else None
                ),
                "waveform_path": (
                    str(entry.get("waveform_path"))
                    if entry.get("waveform_path")
                    else ""
                ),
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
        entries, available_days, available_exts, total_bytes = await _scan_recordings()
        payload = _filter_recordings(entries, request)
        payload["available_days"] = available_days
        payload["available_extensions"] = available_exts
        payload["recordings_total_bytes"] = total_bytes
        try:
            usage = shutil.disk_usage(recordings_root)
        except (FileNotFoundError, PermissionError, OSError):
            usage = None
        if usage is not None:
            payload["storage_total_bytes"] = int(usage.total)
            payload["storage_used_bytes"] = int(usage.used)
            payload["storage_free_bytes"] = int(usage.free)
        payload["capture_status"] = _read_capture_status()
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
                waveform_sidecar = resolved.with_suffix(resolved.suffix + ".waveform.json")
                try:
                    waveform_sidecar.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
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

        ready = _playlist_has_segments(path)
        if not ready:
            deadline = time.monotonic() + playlist_ready_timeout
            while time.monotonic() < deadline:
                await asyncio.sleep(playlist_poll_interval)
                if _playlist_has_segments(path):
                    ready = True
                    break

        if ready:
            return web.FileResponse(path, headers={"Cache-Control": "no-store"})

        # Bootstrap playlist so players poll while ffmpeg warms up.
        text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n"
        return web.Response(
            text=text,
            content_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

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
