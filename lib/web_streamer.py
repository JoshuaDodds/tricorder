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
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


DEFAULT_RECORDINGS_LIMIT = 200
MAX_RECORDINGS_LIMIT = 1000

ARCHIVAL_BACKENDS = {"network_share", "rsync"}


def _archival_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "backend": "network_share",
        "network_share": {"target_dir": ""},
        "rsync": {
            "destination": "",
            "ssh_identity": "",
            "options": ["-az"],
            "ssh_options": [],
        },
        "include_waveform_sidecars": False,
    }


def _bool_from_any(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _string_from_any(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def _string_list_from_config(value: Any, *, default: list[str] | None = None) -> list[str]:
    if value is None:
        return list(default) if default is not None else []
    items: list[str] = []
    if isinstance(value, str):
        lines = value.splitlines()
        items = [line.strip() for line in lines if line.strip()]
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            if isinstance(item, str):
                stripped = item.strip()
                if stripped:
                    items.append(stripped)
    return items if items else (list(default) if default is not None else [])


def _string_list_from_payload(
    value: Any, field: str, errors: list[str]
) -> tuple[list[str], bool]:
    if value is None:
        return [], False
    if isinstance(value, str):
        items = [segment.strip() for segment in value.splitlines() if segment.strip()]
        return items, True
    if isinstance(value, (list, tuple)):
        items: list[str] = []
        for entry in value:
            if isinstance(entry, str):
                stripped = entry.strip()
                if stripped:
                    items.append(stripped)
            elif entry is None:
                continue
            else:
                errors.append(f"{field} entries must be strings")
                return [], True
        return items, True
    errors.append(f"{field} must be a list of strings or newline-delimited text")
    return [], True


def _normalize_archival_config(raw: Any) -> dict[str, Any]:
    result = _archival_defaults()
    if not isinstance(raw, dict):
        return result

    result["enabled"] = _bool_from_any(raw.get("enabled"))
    backend = _string_from_any(raw.get("backend"))
    if backend in ARCHIVAL_BACKENDS:
        result["backend"] = backend
    result["include_waveform_sidecars"] = _bool_from_any(
        raw.get("include_waveform_sidecars")
    )

    network_share = raw.get("network_share")
    if isinstance(network_share, dict):
        target = network_share.get("target_dir")
        if isinstance(target, str):
            result["network_share"]["target_dir"] = target.strip()

    rsync = raw.get("rsync")
    if isinstance(rsync, dict):
        destination = rsync.get("destination")
        if isinstance(destination, str):
            result["rsync"]["destination"] = destination.strip()
        identity = rsync.get("ssh_identity")
        if isinstance(identity, str):
            result["rsync"]["ssh_identity"] = identity.strip()
        options = _string_list_from_config(rsync.get("options"), default=["-az"])
        ssh_options = _string_list_from_config(rsync.get("ssh_options"), default=[])
        result["rsync"]["options"] = options
        result["rsync"]["ssh_options"] = ssh_options

    return result


def _normalize_archival_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _archival_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    normalized["enabled"] = _bool_from_any(payload.get("enabled"))
    normalized["include_waveform_sidecars"] = _bool_from_any(
        payload.get("include_waveform_sidecars")
    )

    backend = _string_from_any(payload.get("backend"))
    if backend in ARCHIVAL_BACKENDS:
        normalized["backend"] = backend
    else:
        errors.append("backend must be one of: network_share, rsync")

    network_share_raw = payload.get("network_share")
    if network_share_raw is None:
        normalized["network_share"]["target_dir"] = ""
    elif isinstance(network_share_raw, dict):
        target_value = network_share_raw.get("target_dir")
        if target_value is None:
            normalized["network_share"]["target_dir"] = ""
        elif isinstance(target_value, str):
            normalized["network_share"]["target_dir"] = target_value.strip()
        else:
            errors.append("network_share.target_dir must be a string")
    else:
        errors.append("network_share must be an object")

    rsync_raw = payload.get("rsync")
    if rsync_raw is None:
        normalized["rsync"] = {
            "destination": "",
            "ssh_identity": "",
            "options": ["-az"],
            "ssh_options": [],
        }
    elif isinstance(rsync_raw, dict):
        destination_value = rsync_raw.get("destination")
        if destination_value is None:
            normalized["rsync"]["destination"] = ""
        elif isinstance(destination_value, str):
            normalized["rsync"]["destination"] = destination_value.strip()
        else:
            errors.append("rsync.destination must be a string")

        identity_value = rsync_raw.get("ssh_identity")
        if identity_value is None:
            normalized["rsync"]["ssh_identity"] = ""
        elif isinstance(identity_value, str):
            normalized["rsync"]["ssh_identity"] = identity_value.strip()
        else:
            errors.append("rsync.ssh_identity must be a string")

        options_value, options_present = _string_list_from_payload(
            rsync_raw.get("options"), "rsync.options", errors
        )
        if options_present:
            normalized["rsync"]["options"] = options_value or []
        else:
            normalized["rsync"]["options"] = ["-az"]

        ssh_options_value, ssh_options_present = _string_list_from_payload(
            rsync_raw.get("ssh_options"), "rsync.ssh_options", errors
        )
        if ssh_options_present:
            normalized["rsync"]["ssh_options"] = ssh_options_value
        else:
            normalized["rsync"]["ssh_options"] = []
    else:
        errors.append("rsync must be an object")

    if normalized["enabled"] and normalized["backend"] == "network_share":
        target_dir = normalized["network_share"].get("target_dir", "")
        if not target_dir:
            errors.append("Provide a target directory for the network_share backend")

    if normalized["enabled"] and normalized["backend"] == "rsync":
        destination = normalized["rsync"].get("destination", "")
        if not destination:
            errors.append("Provide an rsync destination when the rsync backend is enabled")

    return normalized, errors


def _archival_response_payload(cfg: dict[str, Any]) -> dict[str, Any]:
    normalized = _normalize_archival_config(cfg.get("archival", {}))
    try:
        path = str(primary_config_path())
    except Exception:
        path = None
    return {"archival": normalized, "config_path": path}

from aiohttp import web
from aiohttp.web import AppKey

from lib.hls_controller import controller
from lib import webui, sd_card_health
from lib.config import (
    ConfigPersistenceError,
    get_cfg,
    primary_config_path,
    reload_cfg,
    update_archival_settings,
)
from lib.waveform_cache import generate_waveform


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

        start_epoch: float | None = None
        started_at_iso: str | None = None
        if day:
            time_component = path.stem.split("_", 1)[0]
            if time_component:
                try:
                    struct_time = time.strptime(
                        f"{day} {time_component}", "%Y%m%d %H-%M-%S"
                    )
                except ValueError:
                    pass
                else:
                    start_epoch = float(time.mktime(struct_time))
                    started_at_iso = datetime.fromtimestamp(
                        start_epoch, tz=timezone.utc
                    ).isoformat()

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
                "start_epoch": start_epoch,
                "started_at": started_at_iso,
            }
        )

    entries.sort(key=lambda item: item["modified"], reverse=True)
    days_sorted = sorted(day_set, reverse=True)
    exts_sorted = sorted(ext.lstrip(".") for ext in ext_set)
    return entries, days_sorted, exts_sorted, total_bytes


def _service_label_from_unit(unit: str) -> str:
    base = unit.split(".", 1)[0]
    tokens = [segment for segment in base.replace("_", "-").split("-") if segment]
    if not tokens:
        return unit
    return " ".join(token.capitalize() for token in tokens)


def _friendly_unit_label(unit: str) -> str:
    base_label = _service_label_from_unit(unit)
    if unit.endswith(".path"):
        return f"{base_label} Path"
    if unit.endswith(".timer"):
        return f"{base_label} Timer"
    return base_label


def _derive_status_category(status: dict[str, Any]) -> str:
    if not status.get("available", False):
        return "error"
    active_state = str(status.get("active_state", "")).lower()
    sub_state = str(status.get("sub_state", "")).lower()
    if active_state == "active" and sub_state in {"waiting", "listening"}:
        return "waiting"
    if status.get("is_active"):
        return "active"
    if active_state in {"activating", "reloading"}:
        return "active"
    return "inactive"


def _normalize_dashboard_services(cfg: dict[str, Any]) -> tuple[list[dict[str, str]], set[str]]:
    dashboard_cfg = cfg.get("dashboard", {}) if isinstance(cfg, dict) else {}
    raw_services = dashboard_cfg.get("services", [])
    services: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in raw_services:
        unit = ""
        label = ""
        description = ""
        if isinstance(raw, str):
            unit = raw.strip()
        elif isinstance(raw, dict):
            unit_candidate = raw.get("unit") or raw.get("name") or raw.get("service")
            if isinstance(unit_candidate, str):
                unit = unit_candidate.strip()
            label_candidate = raw.get("label") or raw.get("display") or raw.get("title")
            if isinstance(label_candidate, str):
                label = label_candidate.strip()
            desc_candidate = raw.get("description") or raw.get("summary")
            if isinstance(desc_candidate, str):
                description = desc_candidate.strip()
        if not unit or unit in seen:
            continue
        if not label:
            label = _service_label_from_unit(unit)
        services.append({
            "unit": unit,
            "label": label,
            "description": description,
        })
        seen.add(unit)

    web_service = ""
    raw_web_service = dashboard_cfg.get("web_service")
    if isinstance(raw_web_service, str):
        web_service = raw_web_service.strip()

    auto_restart = {web_service} if web_service else set()
    return services, auto_restart


SHUTDOWN_EVENT_KEY: AppKey[asyncio.Event] = web.AppKey("shutdown_event", asyncio.Event)
RECORDINGS_ROOT_KEY: AppKey[Path] = web.AppKey("recordings_root", Path)
ALLOWED_EXT_KEY: AppKey[tuple[str, ...]] = web.AppKey("recordings_allowed_ext", tuple)
SERVICE_ENTRIES_KEY: AppKey[list[dict[str, str]]] = web.AppKey("dashboard_services", list)
AUTO_RESTART_KEY: AppKey[set[str]] = web.AppKey("dashboard_auto_restart", set)

_SYSTEMCTL_PROPERTIES = [
    "LoadState",
    "ActiveState",
    "SubState",
    "UnitFileState",
    "Description",
    "CanStart",
    "CanStop",
    "CanReload",
    "CanRestart",
    "TriggeredBy",
]


async def _run_systemctl(args: Sequence[str]) -> tuple[int, str, str]:
    cmd = ["systemctl", "--no-ask-password", *args]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return 127, "", "systemctl not found"
    except Exception as exc:  # pragma: no cover - unexpected spawn failure
        return 1, "", str(exc)

    stdout_raw, stderr_raw = await proc.communicate()
    stdout = stdout_raw.decode("utf-8", errors="replace")
    stderr = stderr_raw.decode("utf-8", errors="replace")
    return proc.returncode, stdout, stderr


def _parse_show_output(payload: str, properties: Sequence[str]) -> dict[str, str]:
    """Parse `systemctl show` output for a known set of properties.

    Newer systemd releases support ``--value`` which yields newline-delimited
    values that align with the requested properties. Older builds (and some
    downstream patches) always emit ``KEY=VALUE`` pairs regardless of
    ``--value``. We accept both forms to keep deployments on Raspberry Pi OS
    stable even if the local systemd version diverges from the test fixture.
    """

    result: dict[str, str] = {prop: "" for prop in properties}

    lines = payload.splitlines()

    saw_key_value = False
    for line in lines:
        if "=" not in line:
            continue
        saw_key_value = True
        key, value = line.split("=", 1)
        key = key.strip()
        if key in result:
            result[key] = value.strip()

    # Fallback to positional parsing only when systemctl omits property names
    # entirely (older builds ignore ``--property=...`` and emit bare values).
    if not saw_key_value:
        values = [line.strip() for line in lines if line.strip()]
        for idx, key in enumerate(properties):
            if idx < len(values):
                result[key] = values[idx]

    return result


def _summarize_state(load_state: str, active_state: str, sub_state: str) -> str:
    def _format(token: str) -> str:
        token = token.strip()
        if not token:
            return ""
        token = token.replace("-", " ")
        return token[:1].upper() + token[1:]

    if load_state and load_state not in {"loaded", "stub"}:
        return _format(load_state)
    if active_state:
        formatted_active = _format(active_state)
        formatted_sub = _format(sub_state)
        if formatted_sub and formatted_sub.lower() != formatted_active.lower():
            return f"{formatted_active} ({formatted_sub})"
        return formatted_active
    return "Unknown"


async def _fetch_service_status(unit: str) -> dict[str, Any]:
    code, stdout, stderr = await _run_systemctl([
        "show",
        unit,
        f"--property={','.join(_SYSTEMCTL_PROPERTIES)}",
    ])
    if code != 0:
        error = stderr.strip() or stdout.strip() or f"systemctl exited with {code}"
        return {
            "available": False,
            "error": error,
            "load_state": "",
            "active_state": "",
            "sub_state": "",
            "unit_file_state": "",
            "system_description": "",
            "can_start": False,
            "can_stop": False,
            "can_reload": False,
            "can_restart": False,
            "status_text": f"Unavailable ({error})",
            "is_active": False,
            "triggered_by": [],
        }

    data = _parse_show_output(stdout, _SYSTEMCTL_PROPERTIES)
    load_state = data.get("LoadState", "")
    active_state = data.get("ActiveState", "")
    sub_state = data.get("SubState", "")
    unit_file_state = data.get("UnitFileState", "")
    summary = _summarize_state(load_state, active_state, sub_state)
    can_start = data.get("CanStart", "no").lower() == "yes"
    can_stop = data.get("CanStop", "no").lower() == "yes"
    can_reload = data.get("CanReload", "no").lower() == "yes"
    can_restart = data.get("CanRestart", "no").lower() == "yes"
    triggered_raw = data.get("TriggeredBy", "")
    triggered = [token.strip() for token in triggered_raw.split() if token.strip()]
    return {
        "available": True,
        "error": "",
        "load_state": load_state,
        "active_state": active_state,
        "sub_state": sub_state,
        "unit_file_state": unit_file_state,
        "system_description": data.get("Description", ""),
        "can_start": can_start,
        "can_stop": can_stop,
        "can_reload": can_reload,
        "can_restart": can_restart,
        "status_text": summary,
        "is_active": active_state.lower() in {"active", "reloading", "activating"},
        "triggered_by": triggered,
    }


async def _collect_service_state(
    entry: dict[str, str], auto_restart_units: set[str]
) -> dict[str, Any]:
    status = await _fetch_service_status(entry["unit"])
    triggered_units = [unit for unit in status.pop("triggered_by", []) if unit]
    related_units: list[dict[str, Any]] = []
    if triggered_units:
        fetched = await asyncio.gather(
            *(_fetch_service_status(unit) for unit in triggered_units),
            return_exceptions=True,
        )
        for unit, payload in zip(triggered_units, fetched):
            if isinstance(payload, Exception):
                related = {
                    "available": False,
                    "error": str(payload),
                    "load_state": "",
                    "active_state": "",
                    "sub_state": "",
                    "unit_file_state": "",
                    "system_description": "",
                    "can_start": False,
                    "can_stop": False,
                    "can_reload": False,
                    "can_restart": False,
                    "status_text": "Unavailable",
                    "is_active": False,
                }
            else:
                related = dict(payload)
            related.pop("triggered_by", None)
            related.update(
                {
                    "unit": unit,
                    "label": _friendly_unit_label(unit),
                    "relation": "triggered-by",
                }
            )
            related["status_state"] = _derive_status_category(related)
            related_units.append(related)

    status_state = _derive_status_category(status)
    waiting_related = [
        rel
        for rel in related_units
        if rel.get("relation") == "triggered-by"
        and rel.get("status_state") in {"active", "waiting"}
    ]
    if status_state == "inactive" and waiting_related:
        watchers_label = ", ".join(rel.get("unit", "") for rel in waiting_related if rel.get("unit"))
        if watchers_label:
            status["status_text"] = f"Waiting ({watchers_label})"
        status_state = "waiting"

    status.update(
        {
            "unit": entry["unit"],
            "label": entry.get("label", entry["unit"]),
            "description": entry.get("description", ""),
            "auto_restart": entry["unit"] in auto_restart_units,
            "status_state": status_state,
            "related_units": related_units,
        }
    )
    return status


def _enqueue_service_actions(
    unit: str,
    actions: Sequence[str],
    delay: float = 0.5,
) -> None:
    if not actions:
        return

    loop = asyncio.get_running_loop()
    log = logging.getLogger("web_streamer")

    async def _runner() -> None:
        try:
            if delay > 0:
                await asyncio.sleep(delay)
            for action in actions:
                code, stdout, stderr = await _run_systemctl([action, unit])
                if code != 0:
                    log.warning(
                        "systemctl %s %s failed (%s): %s %s",
                        action,
                        unit,
                        code,
                        stdout.strip(),
                        stderr.strip(),
                    )
        except asyncio.CancelledError:  # pragma: no cover - only triggered during shutdown
            raise
        except Exception as exc:  # pragma: no cover - defensive logging
            log.warning("Scheduled service action %s on %s failed: %s", actions, unit, exc)

    loop.create_task(_runner())


def build_app() -> web.Application:
    log = logging.getLogger("web_streamer")
    cfg = get_cfg()
    dashboard_cfg = cfg.get("dashboard", {})
    api_base_raw = dashboard_cfg.get("api_base", "")
    dashboard_api_base = api_base_raw.strip() if isinstance(api_base_raw, str) else ""
    cors_enabled = bool(dashboard_api_base)

    middlewares: list[Any] = []

    if cors_enabled:

        @web.middleware
        async def _cors_middleware(request: web.Request, handler):
            if request.method == "OPTIONS":
                response = web.Response(status=204)
            else:
                response = await handler(request)

            if request.headers.get("Origin"):
                response.headers.setdefault("Access-Control-Allow-Origin", "*")
                response.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
                response.headers.setdefault("Access-Control-Allow-Headers", "Content-Type")
                response.headers.setdefault("Access-Control-Max-Age", "86400")

            return response

        middlewares.append(_cors_middleware)

    app = web.Application(middlewares=middlewares)
    app[SHUTDOWN_EVENT_KEY] = asyncio.Event()

    default_tmp = cfg.get("paths", {}).get("tmp_dir", "/apps/tricorder/tmp")
    tmp_root = os.environ.get("TRICORDER_TMP", default_tmp)

    try:
        os.makedirs(tmp_root, exist_ok=True)
    except OSError:
        pass

    hls_dir = os.path.join(tmp_root, "hls")
    os.makedirs(hls_dir, exist_ok=True)
    controller.set_state_path(os.path.join(hls_dir, "controller_state.json"), persist=True)
    controller.refresh_from_state()
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

    service_entries, auto_restart_units = _normalize_dashboard_services(cfg)
    app[SERVICE_ENTRIES_KEY] = service_entries
    app[AUTO_RESTART_KEY] = auto_restart_units

    try:
        recordings_root_resolved = recordings_root.resolve()
    except FileNotFoundError:
        recordings_root_resolved = recordings_root

    clip_safe_pattern = re.compile(r"[^A-Za-z0-9._-]+")
    MIN_CLIP_DURATION_SECONDS = 0.05

    class ClipError(Exception):
        """Raised when an audio clip cannot be produced."""

    def _format_timecode_slug(seconds: float) -> str:
        total_ms = max(0, int(round(seconds * 1000)))
        hours, remainder = divmod(total_ms, 3_600_000)
        minutes, remainder = divmod(remainder, 60_000)
        secs, millis = divmod(remainder, 1000)
        if hours > 0:
            return f"{hours:02d}{minutes:02d}{secs:02d}{millis:03d}"
        return f"{minutes:02d}{secs:02d}{millis:03d}"

    def _sanitize_clip_name(raw: str | None, fallback: str) -> str:
        candidate = (raw or "").strip()
        candidate = clip_safe_pattern.sub("_", candidate)
        candidate = candidate.strip("._-")
        if not candidate:
            candidate = clip_safe_pattern.sub("_", fallback.strip())
            candidate = candidate.strip("._-")
        if not candidate:
            candidate = "clip"
        if len(candidate) > 120:
            candidate = candidate[:120].rstrip("._-")
        if not candidate:
            candidate = "clip"
        return candidate

    def _default_clip_name(source: Path, start_seconds: float, end_seconds: float) -> str:
        base = source.stem or "clip"
        start_slug = _format_timecode_slug(start_seconds)
        end_slug = _format_timecode_slug(end_seconds)
        return f"{base}_{start_slug}-{end_slug}"

    def _to_float(value: object) -> float | None:
        if isinstance(value, (int, float)):
            if math.isfinite(float(value)):
                return float(value)
            return None
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                parsed = float(text)
            except ValueError:
                return None
            if math.isfinite(parsed):
                return parsed
        return None

    def _create_clip_sync(
        source_rel_path: str,
        start_seconds: float,
        end_seconds: float,
        clip_name: str | None,
        source_start_epoch: float | None,
    ) -> dict[str, object]:
        if not source_rel_path:
            raise ClipError("source path is required")

        rel = source_rel_path.strip().strip("/")
        if not rel:
            raise ClipError("source path is required")

        candidate = recordings_root / rel
        try:
            resolved = candidate.resolve()
        except FileNotFoundError as exc:
            raise ClipError("source recording not found") from exc

        try:
            resolved.relative_to(recordings_root_resolved)
        except ValueError as exc:
            raise ClipError("invalid source path") from exc

        if not resolved.is_file():
            raise ClipError("source recording not found")

        duration = float(end_seconds) - float(start_seconds)
        if not math.isfinite(duration) or duration <= MIN_CLIP_DURATION_SECONDS:
            raise ClipError("clip range is too short")

        if float(start_seconds) < 0:
            raise ClipError("start time must be non-negative")

        try:
            source_stat = resolved.stat()
        except OSError as exc:
            raise ClipError("unable to stat source recording") from exc

        if source_stat.st_size <= 0:
            raise ClipError("source recording is empty")

        target_dir = resolved.parent
        default_name = _default_clip_name(resolved, float(start_seconds), float(end_seconds))
        base_name = _sanitize_clip_name(clip_name, default_name)

        attempt = 1
        final_path = target_dir / f"{base_name}.opus"
        while final_path.exists():
            attempt += 1
            if attempt > 9999:
                raise ClipError("unable to allocate unique filename")
            final_path = target_dir / f"{base_name}_{attempt:02d}.opus"

        final_waveform = final_path.with_suffix(final_path.suffix + ".waveform.json")

        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ClipError("unable to create destination directory") from exc

        try:
            tmp_dir = tempfile.TemporaryDirectory(prefix="clip_", dir=tmp_root)
        except Exception as exc:  # pragma: no cover - tempdir failures are unexpected
            raise ClipError("unable to allocate temporary workspace") from exc

        with tmp_dir as tmp_name:
            tmp_root_path = Path(tmp_name)
            tmp_wav = tmp_root_path / "clip.wav"
            tmp_opus = tmp_root_path / "clip.opus"
            tmp_waveform = tmp_root_path / "clip.waveform.json"

            encode_duration = f"{duration:.6f}".rstrip("0").rstrip(".")
            start_offset = f"{float(start_seconds):.6f}".rstrip("0").rstrip(".")

            decode_cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                start_offset,
                "-i",
                str(resolved),
                "-t",
                encode_duration,
                "-ac",
                "1",
                "-ar",
                "48000",
                "-sample_fmt",
                "s16",
                str(tmp_wav),
            ]

            try:
                subprocess.run(decode_cmd, check=True)
            except FileNotFoundError as exc:
                raise ClipError("ffmpeg is not available") from exc
            except subprocess.SubprocessError as exc:
                raise ClipError("ffmpeg failed while decoding source") from exc

            encode_cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(tmp_wav),
                "-ac",
                "1",
                "-ar",
                "48000",
                "-sample_fmt",
                "s16",
                "-c:a",
                "libopus",
                "-b:a",
                "48k",
                "-vbr",
                "on",
                "-application",
                "audio",
                "-frame_duration",
                "20",
                "-threads",
                "1",
                str(tmp_opus),
            ]

            try:
                subprocess.run(encode_cmd, check=True)
            except FileNotFoundError as exc:
                raise ClipError("ffmpeg is not available") from exc
            except subprocess.SubprocessError as exc:
                raise ClipError("ffmpeg failed while encoding clip") from exc

            try:
                generate_waveform(tmp_wav, tmp_waveform)
            except Exception as exc:
                raise ClipError("waveform generation failed") from exc

            try:
                shutil.move(str(tmp_opus), str(final_path))
                shutil.move(str(tmp_waveform), str(final_waveform))
            except Exception as exc:
                raise ClipError("unable to store generated clip") from exc

        clip_start_epoch = None
        if isinstance(source_start_epoch, (int, float)) and source_start_epoch > 0:
            clip_start_epoch = float(source_start_epoch) + float(start_seconds)
        if not clip_start_epoch and hasattr(source_stat, "st_mtime"):
            base_mtime = getattr(source_stat, "st_mtime", time.time())
            clip_start_epoch = float(base_mtime) + float(start_seconds)

        if clip_start_epoch and clip_start_epoch > 0:
            try:
                os.utime(final_path, (clip_start_epoch, clip_start_epoch))
            except OSError:
                pass

        try:
            rel_path = final_path.relative_to(recordings_root_resolved)
        except ValueError:
            try:
                rel_path = final_path.relative_to(recordings_root)
            except ValueError as exc:  # pragma: no cover - should not happen
                raise ClipError("unexpected destination path") from exc

        rel_posix = rel_path.as_posix()
        day = rel_path.parts[0] if rel_path.parts else ""

        payload: dict[str, object] = {
            "path": rel_posix,
            "name": final_path.stem,
            "duration_seconds": duration,
            "day": day,
        }
        if clip_start_epoch and clip_start_epoch > 0:
            payload["start_epoch"] = clip_start_epoch
        return payload

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
            api_base=dashboard_api_base,
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
            limit = int(query.get("limit", str(DEFAULT_RECORDINGS_LIMIT)))
        except ValueError:
            limit = DEFAULT_RECORDINGS_LIMIT
        limit = max(1, min(MAX_RECORDINGS_LIMIT, limit))

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
                "start_epoch": (
                    float(entry.get("start_epoch", 0.0))
                    if isinstance(entry.get("start_epoch"), (int, float))
                    else None
                ),
                "started_at": (
                    str(entry.get("started_at"))
                    if isinstance(entry.get("started_at"), str)
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

    async def recordings_clip(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        source_path = data.get("source_path")
        if not isinstance(source_path, str) or not source_path.strip():
            raise web.HTTPBadRequest(reason="source_path must be a string")

        start_value = _to_float(data.get("start_seconds"))
        end_value = _to_float(data.get("end_seconds"))

        if start_value is None or end_value is None:
            raise web.HTTPBadRequest(reason="start_seconds and end_seconds must be numbers")
        if end_value <= start_value:
            raise web.HTTPBadRequest(reason="end_seconds must be greater than start_seconds")

        name_value = data.get("clip_name")
        clip_name = str(name_value) if isinstance(name_value, str) else None

        source_start_epoch = _to_float(data.get("source_start_epoch"))

        loop = asyncio.get_running_loop()
        try:
            payload = await loop.run_in_executor(
                None,
                functools.partial(
                    _create_clip_sync,
                    source_path,
                    start_value,
                    end_value,
                    clip_name,
                    source_start_epoch,
                ),
            )
        except ClipError as exc:
            raise web.HTTPBadRequest(reason=str(exc)) from exc
        except Exception as exc:  # pragma: no cover - unexpected failures
            log.exception("Unexpected error while creating clip for %s", source_path)
            raise web.HTTPInternalServerError(reason="unable to create clip") from exc

        return web.json_response(payload)

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
        refreshed = reload_cfg()
        return web.json_response(refreshed)

    async def config_archival_get(_: web.Request) -> web.Response:
        refreshed = reload_cfg()
        payload = _archival_response_payload(refreshed)
        return web.json_response(payload)

    async def config_archival_update(request: web.Request) -> web.Response:
        log = logging.getLogger("web_streamer")
        try:
            data = await request.json()
        except Exception as exc:
            message = f"Invalid JSON payload: {exc}"
            return web.json_response({"error": message}, status=400)

        normalized, errors = _normalize_archival_payload(data)
        if errors:
            message = errors[0]
            return web.json_response({"error": message, "errors": errors}, status=400)

        try:
            update_archival_settings(normalized)
        except ConfigPersistenceError as exc:
            log.warning("Unable to persist archival settings: %s", exc)
            return web.json_response(
                {"error": f"Unable to save archival settings: {exc}"},
                status=500,
            )
        except Exception as exc:  # pragma: no cover - defensive logging
            log.exception("Unexpected archival settings failure: %s", exc)
            return web.json_response(
                {"error": "Unexpected error while saving archival settings"},
                status=500,
            )

        refreshed = reload_cfg()
        payload = _archival_response_payload(refreshed)
        return web.json_response(payload)

    async def system_health(_: web.Request) -> web.Response:
        state = sd_card_health.load_state()
        payload = {
            "generated_at": time.time(),
            "sd_card": sd_card_health.state_summary(state),
        }
        return web.json_response(payload)

    async def services_list(request: web.Request) -> web.Response:
        entries = request.app.get(SERVICE_ENTRIES_KEY, [])
        auto_restart = request.app.get(AUTO_RESTART_KEY, set())
        if not entries:
            return web.json_response({"services": [], "updated_at": time.time()})
        results = await asyncio.gather(
            *(_collect_service_state(entry, auto_restart) for entry in entries)
        )
        return web.json_response({"services": results, "updated_at": time.time()})

    async def service_action(request: web.Request) -> web.Response:
        entries = request.app.get(SERVICE_ENTRIES_KEY, [])
        auto_restart = request.app.get(AUTO_RESTART_KEY, set())
        entry_map = {item["unit"]: item for item in entries}

        unit = request.match_info.get("unit", "")
        if unit not in entry_map:
            raise web.HTTPNotFound(reason="Unknown service")

        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        action = str(data.get("action", "")).strip().lower()
        if action not in {"start", "stop", "reload", "restart"}:
            raise web.HTTPBadRequest(reason="Unsupported action")

        response: dict[str, Any] = {
            "unit": unit,
            "requested_action": action,
        }

        executed_action = action
        stdout_text = ""
        stderr_text = ""

        if unit in auto_restart and action in {"stop", "reload"}:
            scheduled_actions = ["reload", "restart"] if action == "reload" else ["restart"]
            _enqueue_service_actions(unit, scheduled_actions, delay=0.5)
            executed_action = "restart"
            response.update(
                {
                    "auto_restart": True,
                    "executed_action": executed_action,
                    "scheduled_actions": scheduled_actions,
                    "message": "Scheduled restart to keep dashboard reachable.",
                    "ok": True,
                }
            )
        else:
            code, stdout_text, stderr_text = await _run_systemctl([action, unit])
            fallback_triggered = False
            if action == "reload" and code != 0:
                fallback_triggered = True
                fallback_code, fallback_stdout, fallback_stderr = await _run_systemctl(
                    ["restart", unit]
                )
                executed_action = "restart"
                response["fallback_action"] = "restart"
                if fallback_code == 0:
                    code = fallback_code
                    stdout_text = fallback_stdout
                    stderr_text = fallback_stderr
                else:
                    stderr_primary = stderr_text.strip()
                    stderr_secondary = fallback_stderr.strip()
                    stderr_text = (
                        f"{stderr_primary}\n{stderr_secondary}"
                        if stderr_primary and stderr_secondary
                        else stderr_secondary or stderr_primary
                    )
                    stdout_text = stdout_text or fallback_stdout
                    code = fallback_code

            ok = code == 0
            message = stderr_text.strip() or stdout_text.strip()
            response.update(
                {
                    "auto_restart": unit in auto_restart,
                    "executed_action": executed_action,
                    "stdout": stdout_text.strip(),
                    "stderr": stderr_text.strip(),
                    "ok": ok,
                }
            )
            if fallback_triggered and not message:
                response["message"] = "Reload unsupported; restarted instead."
            elif message:
                response["message"] = message

        status = await _collect_service_state(entry_map[unit], auto_restart)
        response["status"] = status
        return web.json_response(response)

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
    app.router.add_post("/api/recordings/clip", recordings_clip)
    app.router.add_get("/recordings/{path:.*}", recordings_file)
    app.router.add_get("/api/config", config_snapshot)
    app.router.add_get("/api/config/archival", config_archival_get)
    app.router.add_post("/api/config/archival", config_archival_update)
    app.router.add_get("/api/system-health", system_health)
    app.router.add_get("/api/services", services_list)
    app.router.add_post("/api/services/{unit}/action", service_action)

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
