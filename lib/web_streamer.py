#!/usr/bin/env python3
"""
aiohttp web server for Tricorder's live stream and management dashboard.

Behavior:
- First client arrival on the live stream starts the encoder (via
  controller.ensure_started()).
- Last live-stream client leaving schedules encoder stop after a cooldown
  (default 10s).
- Dashboard lists locally stored recordings with playback, download, and
  recycle bin controls.

Endpoints:
  GET /                    -> Dashboard HTML
  GET /dashboard           -> Same as /
  GET /api/recordings      -> JSON listing of recordings with filters
  POST /api/recordings/delete -> Move one or more recordings to the recycle bin
  GET /recordings/<path>   -> Serve/download a stored recording
  GET /api/recycle-bin     -> List recycle bin entries
  POST /api/recycle-bin/restore -> Restore deleted recordings
  GET /recycle-bin/<id>    -> Preview a recycled recording
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
import copy
import errno
import functools
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import types
import wave
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Collection, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo


from .web_streamer_helpers.event_bridges import (
    CaptureStatusEventBridge,
    RecordingsEventBridge,
)


DEFAULT_RECORDINGS_LIMIT = 200
# aiohttp falls back to asyncio's default executor for blocking work. Cap it to a
# small fixed size so the dashboard thread footprint stays tiny on single-user
# systems (default would otherwise scale with CPU count and spawn up to 32
# threads).
# WEB_STREAMER_EXECUTOR_MAX_WORKERS = max(2, min(4, (os.cpu_count() or 1)))
WEB_STREAMER_EXECUTOR_MAX_WORKERS = 1  # hardcoded to 1 for this project to save RAM
CLIP_EXECUTOR_MAX_WORKERS = 1  # serialize long-running clip jobs off the main executor
MAX_RECORDINGS_LIMIT = 1000
RECORDINGS_TIME_RANGE_SECONDS = {
    "1h": 60 * 60,
    "2h": 2 * 60 * 60,
    "4h": 4 * 60 * 60,
    "8h": 8 * 60 * 60,
    "12h": 12 * 60 * 60,
    "1d": 24 * 60 * 60,
}

ARCHIVAL_BACKENDS = {"network_share", "rsync"}

WEB_SERVER_MODES = {"http", "https"}
WEB_SERVER_TLS_PROVIDERS = {"letsencrypt", "manual"}
LETS_ENCRYPT_RENEWAL_INTERVAL_SECONDS = 12 * 60 * 60

CAPTURE_STATUS_STALE_AFTER_SECONDS = 10.0
CAPTURE_STATUS_EVENT_POLL_SECONDS = 0.5
RECORDINGS_EVENT_POLL_SECONDS = 0.5

EVENT_STREAM_HEARTBEAT_SECONDS = 20.0
EVENT_STREAM_RETRY_MILLIS = 5000
EVENT_HISTORY_LIMIT = 256

DEFAULT_WEBRTC_ICE_SERVERS: list[dict[str, object]] = [
    {"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]},
]

VOICE_RECORDER_SERVICE_UNIT = "voice-recorder.service"


def _quiet_noisy_dependencies(ice_level: int = logging.WARNING) -> None:
    """Tone down overly chatty third-party loggers."""

    for name in ("aioice", "aioice.ice", "aioice.stun"):
        logging.getLogger(name).setLevel(ice_level)


RECYCLE_BIN_DIRNAME = ".recycle_bin"
RAW_AUDIO_DIRNAME = ".original_wav"
RAW_AUDIO_SUFFIXES: tuple[str, ...] = (".wav",)
SAVED_RECORDINGS_DIRNAME = "Saved"
RECORDINGS_EVENT_SPOOL_DIRNAME = "recordings_events"
RECYCLE_METADATA_FILENAME = "metadata.json"
RECYCLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
STREAMING_OPEN_TIMEOUT_SECONDS = 5.0
STREAMING_POLL_INTERVAL_SECONDS = 0.25

DEFAULT_VOSK_MODEL_ROOT = Path("/apps/tricorder/models")


def _transcription_model_search_roots() -> list[Path]:
    roots: list[Path] = []
    seen: set[Path] = set()

    def add(candidate: Path | str | None) -> None:
        if not candidate:
            return
        try:
            path = Path(candidate).expanduser()
        except (TypeError, ValueError):
            return
        try:
            resolved = path.resolve()
        except (OSError, RuntimeError):
            resolved = path
        if resolved in seen:
            return
        seen.add(resolved)
        roots.append(resolved)

    cfg = get_cfg()
    transcription_cfg: Mapping[str, Any] | None = None
    try:
        raw_cfg = cfg.get("transcription")
        if isinstance(raw_cfg, Mapping):
            transcription_cfg = raw_cfg
    except Exception:
        transcription_cfg = None

    if transcription_cfg:
        model_path = (
            transcription_cfg.get("vosk_model_path")
            or transcription_cfg.get("model_path")
        )
        if isinstance(model_path, str) and model_path.strip():
            model_dir = Path(model_path.strip()).expanduser()
            add(model_dir)
            add(model_dir.parent)

    env_model = os.environ.get("VOSK_MODEL_PATH")
    if env_model:
        env_dir = Path(env_model).expanduser()
        add(env_dir)
        add(env_dir.parent)

    add(DEFAULT_VOSK_MODEL_ROOT)
    add(DEFAULT_VOSK_MODEL_ROOT.parent)

    return roots


def _looks_like_vosk_model(path: Path) -> bool:
    if not path.is_dir():
        return False
    if (path / "conf").is_dir():
        return True
    if (path / "model.conf").is_file():
        return True

    sentinel_hits = 0
    directory_sentinels = ("am", "graph", "rescore", "ivector")
    file_sentinels = ("final.mdl", "Gr.fst", "HCLr.fst", "mfcc.conf")

    for name in directory_sentinels:
        child = path / name
        try:
            exists = child.is_dir()
        except OSError:
            exists = False
        if exists:
            sentinel_hits += 1

    for name in file_sentinels:
        child = path / name
        try:
            exists = child.is_file()
        except OSError:
            exists = False
        if exists:
            sentinel_hits += 1

    return sentinel_hits >= 2


def _extract_vosk_metadata(model_dir: Path) -> dict[str, str]:
    metadata: dict[str, str] = {}
    meta_path = model_dir / "meta.json"
    if meta_path.is_file():
        try:
            payload = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, Mapping):
            for key in ("title", "name", "model_name"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    metadata["title"] = value.strip()
                    break
            lang_value = (
                payload.get("lang")
                or payload.get("language")
                or payload.get("locale")
            )
            if isinstance(lang_value, str) and lang_value.strip():
                metadata["language"] = lang_value.strip()

    conf_path = model_dir / "conf" / "model.conf"
    if "title" not in metadata and conf_path.is_file():
        try:
            lines = conf_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            lines = []
        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().lower()
            value = value.strip()
            if not value:
                continue
            if key in {"model_name", "model", "name"} and "title" not in metadata:
                metadata["title"] = value
            elif key in {"lang", "language"} and "language" not in metadata:
                metadata["language"] = value
    return metadata


def _discover_transcription_models() -> dict[str, Any]:
    roots = _transcription_model_search_roots()
    models: list[dict[str, Any]] = []
    errors: list[str] = []
    searched: list[str] = []
    seen_models: set[Path] = set()

    for root in roots:
        try:
            exists = root.exists()
        except OSError:
            exists = False
        if not exists or not root.is_dir():
            continue
        try:
            entries = list(root.iterdir())
        except OSError as exc:
            errors.append(f"Unable to read {root}: {exc}")
            continue
        searched.append(str(root))
        for entry in entries:
            try:
                is_dir = entry.is_dir()
            except OSError:
                continue
            if not is_dir:
                continue
            if not _looks_like_vosk_model(entry):
                continue
            try:
                resolved = entry.resolve()
            except (OSError, RuntimeError):
                resolved = entry
            if resolved in seen_models:
                continue
            seen_models.add(resolved)
            meta = _extract_vosk_metadata(entry)
            label = meta.get("title") or entry.name
            language = meta.get("language", "")
            if language and language.lower() not in label.lower():
                label = f"{label} ({language})"
            models.append(
                {
                    "name": entry.name,
                    "path": str(resolved),
                    "label": label,
                    "language": language or None,
                }
            )

    models.sort(key=lambda item: (item.get("label") or item.get("name") or "").lower())

    configured_path = ""
    configured_exists = False
    try:
        cfg = get_cfg()
        transcription_cfg = cfg.get("transcription")
    except Exception:
        transcription_cfg = None

    if isinstance(transcription_cfg, Mapping):
        raw_path = transcription_cfg.get("vosk_model_path") or transcription_cfg.get("model_path")
        if isinstance(raw_path, str) and raw_path.strip():
            normalized = Path(raw_path.strip()).expanduser()
            configured_path = str(normalized)
            try:
                configured_exists = normalized.exists()
            except OSError:
                configured_exists = False

    return {
        "models": models,
        "searched": searched,
        "configured_path": configured_path,
        "configured_exists": configured_exists,
        "errors": errors,
    }


def _noop_callback(*_args, **_kwargs) -> None:
    """Fallback callable used when defensive guards replace invalid callbacks."""


_HANDLE_RUN_GUARD_INSTALLED = False
_SELECTOR_TRANSPORT_GUARD_INSTALLED = False
_NONE_HANDLE_LOG_REPORTED = False


def _install_loop_callback_guard(
    loop: asyncio.AbstractEventLoop, log: logging.Logger
) -> None:
    """Prevent asyncio from executing ``None`` callbacks by swapping in a no-op."""

    if getattr(loop, "_tricorder_none_callback_guard", False):  # pragma: no cover - guard
        return

    _install_handle_run_guard()
    _install_selector_transport_guard(log)

    def _wrap(method_name: str) -> None:
        original = getattr(loop, method_name, None)
        if original is None:
            return

        reported = False

        def safe(self, callback, *args, **kwargs):
            nonlocal reported
            if callback is None:
                log_kwargs = {"stack_info": not reported}
                if not reported:
                    log.warning(
                        "Ignored %s(None) scheduling attempt; replacing with no-op.",
                        method_name,
                        **log_kwargs,
                    )
                    reported = True
                else:
                    log.debug(
                        "Ignored %s(None) scheduling attempt; replacing with no-op.",
                        method_name,
                    )
                callback = _noop_callback
            return original(callback, *args, **kwargs)

        setattr(loop, method_name, types.MethodType(safe, loop))

    _wrap("call_soon")
    _wrap("call_soon_threadsafe")
    loop._tricorder_none_callback_guard = True  # type: ignore[attr-defined]


def _install_handle_run_guard() -> None:
    global _HANDLE_RUN_GUARD_INSTALLED
    if _HANDLE_RUN_GUARD_INSTALLED:  # pragma: no cover - defensive guard
        return

    handle_run = getattr(asyncio.Handle, "_run", None)
    if handle_run is None:  # pragma: no cover - older asyncio fallbacks
        return

    asyncio_log = logging.getLogger("asyncio")

    @functools.wraps(handle_run)
    def safe_run(self: asyncio.Handle) -> None:  # type: ignore[name-defined]
        global _NONE_HANDLE_LOG_REPORTED
        if self._callback is None:
            if getattr(self, "_cancelled", False):
                return
            if not _NONE_HANDLE_LOG_REPORTED:
                asyncio_log.warning(
                    "Discarded asyncio handle with None callback; args=%r. "
                    "Guard replaced it with a no-op callback.",
                    self._args,
                )
                if asyncio_log.isEnabledFor(logging.DEBUG):
                    asyncio_log.debug(
                        "Discarded asyncio handle with None callback; args=%r",
                        self._args,
                        stack_info=True,
                    )
                _NONE_HANDLE_LOG_REPORTED = True
            else:
                asyncio_log.debug(
                    "Discarded asyncio handle with None callback; args=%r",
                    self._args,
                )
            self._callback = _noop_callback
            self._args = ()
        return handle_run(self)

    setattr(asyncio.Handle, "_run", safe_run)
    _HANDLE_RUN_GUARD_INSTALLED = True


def _reset_asyncio_guard_counters_for_tests() -> None:
    """Reset guard state so pytest cases can assert initial logging behavior."""

    global _NONE_HANDLE_LOG_REPORTED
    _NONE_HANDLE_LOG_REPORTED = False


def _install_selector_transport_guard(log: logging.Logger) -> None:
    """Harden asyncio's transport cleanup against missing protocol/socket objects."""

    global _SELECTOR_TRANSPORT_GUARD_INSTALLED
    if _SELECTOR_TRANSPORT_GUARD_INSTALLED:  # pragma: no cover - defensive guard
        return

    try:
        from asyncio import selector_events
    except Exception:  # pragma: no cover - platform guard
        return

    original = getattr(selector_events._SelectorTransport, "_call_connection_lost", None)
    if original is None:  # pragma: no cover - platform guard
        return

    asyncio_log = logging.getLogger("asyncio")

    @functools.wraps(original)
    def safe_call_connection_lost(self, exc):
        protocol_connected = getattr(self, "_protocol_connected", False)
        protocol = getattr(self, "_protocol", None)
        sock = getattr(self, "_sock", None)

        def _cleanup():
            current_sock = getattr(self, "_sock", None)
            if current_sock is not None:
                try:
                    current_sock.close()
                except Exception:
                    asyncio_log.debug(
                        "Error closing socket during guarded connection_lost cleanup.",
                        exc_info=True,
                    )
            try:
                self._sock = None
            except Exception:
                pass
            try:
                self._protocol = None
            except Exception:
                pass
            try:
                self._loop = None
            except Exception:
                pass
            server = getattr(self, "_server", None)
            if server is not None:
                try:
                    server._detach()
                except Exception:
                    asyncio_log.debug(
                        "Error detaching server during guarded connection_lost cleanup.",
                        exc_info=True,
                    )
                try:
                    self._server = None
                except Exception:
                    pass
            try:
                self._protocol_connected = False
            except Exception:
                pass

        if sock is None or (protocol_connected and protocol is None):
            missing = "protocol" if protocol is None else "socket"
            message = (
                "Selector transport missing %s during connection_lost; continuing cleanup defensively."
                % missing
            )
            asyncio_log.warning(message)
            log.warning(message)
            if protocol_connected and protocol is not None:
                try:
                    protocol.connection_lost(exc)
                except Exception:
                    asyncio_log.exception(
                        "Error calling connection_lost on %r during guarded cleanup.",
                        protocol,
                    )
            _cleanup()
            return

        try:
            original(self, exc)
        except AttributeError:
            asyncio_log.error(
                "Selector transport raised AttributeError during connection_lost; continuing cleanup defensively.",
                exc_info=True,
            )
            log.error(
                "Selector transport raised AttributeError during connection_lost; cleanup handled defensively."
            )
            _cleanup()

    selector_events._SelectorTransport._call_connection_lost = safe_call_connection_lost
    _SELECTOR_TRANSPORT_GUARD_INSTALLED = True


def _normalize_webrtc_ice_servers(raw: object) -> list[dict[str, object]]:
    """Normalize ICE server definitions into the WebRTC configuration format."""

    def _clone_defaults() -> list[dict[str, object]]:
        return [
            {
                key: (
                    list(value)
                    if isinstance(value, Sequence) and not isinstance(value, (str, bytes))
                    else value
                )
                for key, value in entry.items()
            }
            for entry in DEFAULT_WEBRTC_ICE_SERVERS
        ]

    def _normalize_urls(value: object) -> list[str]:
        urls: list[str] = []
        if isinstance(value, str):
            candidate = value.strip()
            if candidate:
                urls.append(candidate)
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            for item in value:
                if isinstance(item, str):
                    candidate = item.strip()
                    if candidate:
                        urls.append(candidate)
        return urls

    if raw is None:
        return _clone_defaults()

    entries: list[dict[str, object]] = []

    if isinstance(raw, str):
        parts = [part.strip() for part in raw.split(",") if part.strip()]
        for part in parts:
            urls = _normalize_urls(part)
            if urls:
                entries.append({"urls": urls})
        return entries if entries else _clone_defaults()

    if isinstance(raw, Mapping):
        urls = _normalize_urls(raw.get("urls"))
        if not urls:
            return _clone_defaults()
        server: dict[str, object] = {"urls": urls}
        username = raw.get("username")
        if isinstance(username, str):
            username = username.strip()
            if username:
                server["username"] = username
        credential = raw.get("credential")
        if isinstance(credential, str):
            credential = credential.strip()
            if credential:
                server["credential"] = credential
        return [server]

    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
        items = list(raw)
        if not items:
            return []
        for item in items:
            if isinstance(item, str):
                urls = _normalize_urls(item)
                if urls:
                    entries.append({"urls": urls})
                continue
            if isinstance(item, dict):
                urls = _normalize_urls(item.get("urls"))
                if not urls:
                    continue
                server: dict[str, object] = {"urls": urls}
                username = item.get("username")
                if isinstance(username, str):
                    username = username.strip()
                    if username:
                        server["username"] = username
                credential = item.get("credential")
                if isinstance(credential, str):
                    credential = credential.strip()
                    if credential:
                        server["credential"] = credential
                entries.append(server)
        return entries if entries else _clone_defaults()

    return _clone_defaults()


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
        "include_transcript_sidecars": True,
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
    waveform_value = raw.get("include_waveform_sidecars")
    if waveform_value is not None:
        result["include_waveform_sidecars"] = _bool_from_any(waveform_value)
    transcript_value = raw.get("include_transcript_sidecars")
    if transcript_value is not None:
        result["include_transcript_sidecars"] = _bool_from_any(transcript_value)

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
    waveform_payload = payload.get("include_waveform_sidecars")
    if waveform_payload is not None:
        normalized["include_waveform_sidecars"] = _bool_from_any(waveform_payload)
    transcript_payload = payload.get("include_transcript_sidecars")
    if transcript_payload is not None:
        normalized["include_transcript_sidecars"] = _bool_from_any(
            transcript_payload
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


_AUDIO_SAMPLE_RATES = {16000, 32000, 48000}
_AUDIO_FRAME_LENGTHS = {10, 20, 30}
_STREAMING_MODES = {"hls", "webrtc"}
_TRANSCRIPTION_ENGINES = {"vosk"}
AUDIO_FILTER_STAGE_SPECS: dict[str, dict[str, tuple[float | None, float | None]]] = {
    "denoise": {
        "noise_floor_db": (-80.0, 0.0),
    },
    "highpass": {
        "cutoff_hz": (20.0, 2000.0),
    },
    "lowpass": {
        "cutoff_hz": (1000.0, 20000.0),
    },
    "notch": {
        "freq_hz": (20.0, 20000.0),
        "quality": (0.1, 100.0),
    },
    "spectral_gate": {
        "sensitivity": (0.1, 4.0),
        "reduction_db": (-60.0, 0.0),
        "noise_update": (0.0, 1.0),
        "noise_decay": (0.0, 1.0),
    },
}

AUDIO_FILTER_STAGE_ENUMS: dict[str, dict[str, set[str]]] = {
    "denoise": {"type": {"afftdn"}},
}

AUDIO_FILTER_DEFAULTS: dict[str, dict[str, Any]] = {
    "denoise": {
        "enabled": False,
        "type": "afftdn",
        "noise_floor_db": -30.0,
    },
    "highpass": {"enabled": False, "cutoff_hz": 90.0},
    "lowpass": {"enabled": False, "cutoff_hz": 10000.0},
    "notch": {"enabled": False, "freq_hz": 60.0, "quality": 30.0},
    "spectral_gate": {
        "enabled": False,
        "sensitivity": 1.5,
        "reduction_db": -18.0,
        "noise_update": 0.1,
        "noise_decay": 0.95,
    },
}


def _audio_defaults() -> dict[str, Any]:
    return {
        "device": "",
        "sample_rate": 48000,
        "channels": 1,
        "frame_ms": 20,
        "gain": 1.0,
        "vad_aggressiveness": 3,
        "usb_reset_workaround": True,
        "filter_chain": copy.deepcopy(AUDIO_FILTER_DEFAULTS),
        "calibration": {
            "auto_noise_profile": False,
            "auto_gain": False,
        },
    }


def _copy_filter_stage_sequence(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    copied: list[dict[str, Any]] = []
    for entry in value:
        if isinstance(entry, dict):
            copied.append({key: copy.deepcopy(val) for key, val in entry.items()})
    return copied


def _segmenter_defaults() -> dict[str, Any]:
    return {
        "pre_pad_ms": 2000,
        "post_pad_ms": 3000,
        "motion_release_padding_minutes": 0.0,
        "rms_threshold": 300,
        "keep_window_frames": 30,
        "start_consecutive": 25,
        "keep_consecutive": 25,
        "use_rnnoise": False,
        "use_noisereduce": False,
        "denoise_before_vad": False,
        "flush_threshold_bytes": 128 * 1024,
        "max_queue_frames": 512,
        "min_clip_seconds": 0.0,
        "autosplit_interval_minutes": 15.0,
        "auto_record_motion_override": True,
        "enable_rms_trigger": True,
        "enable_vad_trigger": True,
        "filter_chain_avg_budget_ms": 6.0,
        "filter_chain_peak_budget_ms": 15.0,
        "filter_chain_metrics_window": 50,
        "filter_chain_log_throttle_sec": 30.0,
        "streaming_encode": False,
        "streaming_encode_container": "opus",
        "parallel_encode": {
            "enabled": True,
            "load_avg_per_cpu": 0.75,
            "min_event_seconds": 1.0,
            "cpu_check_interval_sec": 1.0,
            "offline_max_workers": 2,
            "offline_load_avg_per_cpu": 0.75,
            "offline_cpu_check_interval_sec": 1.0,
            "live_waveform_buckets": 1024,
            "live_waveform_update_interval_sec": 1.0,
        },
        "max_pending_encodes": 8,
        "event_tags": {
            "human": "Human",
            "other": "Other",
            "both": "Both",
        },
    }


def _paths_defaults() -> dict[str, Any]:
    return {
        "tmp_dir": "/apps/tricorder/tmp",
        "recordings_dir": "/apps/tricorder/recordings",
        "dropbox_dir": "/apps/tricorder/dropbox",
        "ingest_work_dir": "/apps/tricorder/tmp/ingest",
        "encoder_script": "/apps/tricorder/bin/encode_and_store.sh",
    }


def _notifications_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "allowed_event_types": [],
        "min_trigger_rms": None,
        "webhook": {
            "url": "",
            "method": "POST",
            "headers": {},
            "timeout_sec": 5.0,
        },
        "email": {
            "smtp_host": "",
            "smtp_port": 587,
            "use_tls": True,
            "use_ssl": False,
            "username": "",
            "password": "",
            "from": "",
            "to": [],
            "subject_template": "Tricorder event: {etype} (RMS {trigger_rms})",
            "body_template": (
                "Event {base_name} completed on {host}.\n"
                "Type: {etype}\n"
                "Trigger RMS: {trigger_rms}\n"
                "Average RMS: {avg_rms}\n"
                "Duration: {duration_seconds}s\n"
                "Start: {started_at}\n"
                "Reason: {end_reason}"
            ),
        },
    }


def _adaptive_rms_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "min_rms": None,
        "min_thresh": 0.01,
        "max_rms": None,
        "max_thresh": 1.0,
        "margin": 1.2,
        "update_interval_sec": 5.0,
        "window_sec": 10.0,
        "hysteresis_tolerance": 0.1,
        "release_percentile": 0.5,
        "voiced_hold_sec": 6.0,
    }


def _ingest_defaults() -> dict[str, Any]:
    return {
        "stable_checks": 2,
        "stable_interval_sec": 1.0,
        "allowed_ext": [".wav", ".opus", ".flac", ".mp3"],
        "ignore_suffixes": [
            ".part",
            ".partial",
            ".tmp",
            ".incomplete",
            ".opdownload",
            ".crdownload",
        ],
    }


def _logging_defaults() -> dict[str, Any]:
    return {"dev_mode": False}


def _streaming_defaults() -> dict[str, Any]:
    return {"mode": "hls", "webrtc_history_seconds": 8.0}


def _dashboard_defaults() -> dict[str, Any]:
    return {"api_base": ""}


def _web_server_defaults() -> dict[str, Any]:
    return {
        "mode": "http",
        "listen_host": "0.0.0.0",
        "listen_port": 8080,
        "tls_provider": "letsencrypt",
        "certificate_path": "",
        "private_key_path": "",
        "lets_encrypt": {
            "enabled": False,
            "email": "",
            "domains": [],
            "cache_dir": "/apps/tricorder/letsencrypt",
            "staging": False,
            "certbot_path": "certbot",
            "http_port": 80,
            "renew_before_days": 30,
        },
    }


def _transcription_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "engine": "vosk",
        "types": ["Human"],
        "vosk_model_path": "/apps/tricorder/models/vosk-small-en-us-0.15",
        "target_sample_rate": 16000,
        "include_words": True,
        "max_alternatives": 0,
    }


def _canonical_audio_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _audio_defaults()
    raw = cfg.get("audio", {})
    if isinstance(raw, dict):
        device = raw.get("device")
        if isinstance(device, str):
            result["device"] = device.strip()

        sr = raw.get("sample_rate")
        if isinstance(sr, (int, float)) and not isinstance(sr, bool):
            result["sample_rate"] = int(sr)

        channels = raw.get("channels")
        if isinstance(channels, (int, float)) and not isinstance(channels, bool):
            candidate = int(channels)
            if candidate in (1, 2):
                result["channels"] = candidate

        frame = raw.get("frame_ms")
        if isinstance(frame, (int, float)) and not isinstance(frame, bool):
            result["frame_ms"] = int(frame)

        gain = raw.get("gain")
        if isinstance(gain, (int, float)) and not isinstance(gain, bool):
            result["gain"] = float(gain)

        vad = raw.get("vad_aggressiveness")
        if isinstance(vad, (int, float)) and not isinstance(vad, bool):
            result["vad_aggressiveness"] = int(vad)

        if "usb_reset_workaround" in raw:
            result["usb_reset_workaround"] = _bool_from_any(raw.get("usb_reset_workaround"))

        filters = raw.get("filter_chain")
        if isinstance(filters, dict):
            stages = result.get("filter_chain")
            if not isinstance(stages, dict):
                stages = {}
            else:
                stages = copy.deepcopy(stages)
            for key, field_specs in AUDIO_FILTER_STAGE_SPECS.items():
                target = stages.get(key)
                if not isinstance(target, dict):
                    defaults = AUDIO_FILTER_DEFAULTS.get(key)
                    target = copy.deepcopy(defaults) if isinstance(defaults, dict) else {}
                    stages[key] = target
                payload = filters.get(key)
                if not isinstance(payload, dict):
                    continue
                if "enabled" in payload:
                    target["enabled"] = _bool_from_any(payload.get("enabled"))
                for field_name, (min_value, max_value) in field_specs.items():
                    if field_name not in payload:
                        continue
                    value = payload.get(field_name)
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        numeric = float(value)
                    else:
                        try:
                            numeric = float(value)
                        except (TypeError, ValueError):
                            continue
                    if min_value is not None and numeric < min_value:
                        numeric = float(min_value)
                    if max_value is not None and numeric > max_value:
                        numeric = float(max_value)
                    target[field_name] = numeric
                enum_specs = AUDIO_FILTER_STAGE_ENUMS.get(key, {})
                for enum_name, allowed_values in enum_specs.items():
                    if enum_name not in payload:
                        continue
                    raw_value = payload.get(enum_name)
                    if not isinstance(raw_value, str):
                        continue
                    normalized = raw_value.strip().lower()
                    if normalized in allowed_values:
                        target[enum_name] = normalized
            extra_filters = filters.get("filters")
            if isinstance(extra_filters, Sequence) and not isinstance(extra_filters, (str, bytes)):
                copied = _copy_filter_stage_sequence(extra_filters)
                if copied:
                    stages["filters"] = copied
                else:
                    stages.pop("filters", None)
            result["filter_chain"] = stages
        elif isinstance(filters, Sequence) and not isinstance(filters, (str, bytes)):
            stages = result.get("filter_chain")
            if not isinstance(stages, dict):
                stages = {}
            else:
                stages = copy.deepcopy(stages)
            copied = _copy_filter_stage_sequence(filters)
            if copied:
                stages["filters"] = copied
            else:
                stages.pop("filters", None)
            result["filter_chain"] = stages

        calibration = raw.get("calibration")
        if isinstance(calibration, dict):
            target = result.get("calibration")
            if not isinstance(target, dict):
                target = {}
                result["calibration"] = target
            if "auto_noise_profile" in calibration:
                target["auto_noise_profile"] = _bool_from_any(calibration.get("auto_noise_profile"))
            if "auto_gain" in calibration:
                target["auto_gain"] = _bool_from_any(calibration.get("auto_gain"))
    return result


def _canonical_segmenter_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _segmenter_defaults()
    raw = cfg.get("segmenter", {})
    if isinstance(raw, dict):
        for key in (
            "pre_pad_ms",
            "post_pad_ms",
            "rms_threshold",
            "keep_window_frames",
            "start_consecutive",
            "keep_consecutive",
            "flush_threshold_bytes",
            "max_queue_frames",
        ):
            value = raw.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                result[key] = int(value)

        min_clip = raw.get("min_clip_seconds")
        if isinstance(min_clip, (int, float)) and not isinstance(min_clip, bool):
            candidate = float(min_clip)
            if math.isfinite(candidate):
                candidate = max(0.0, min(600.0, candidate))
                result["min_clip_seconds"] = candidate

        padding_minutes = raw.get("motion_release_padding_minutes")
        if isinstance(padding_minutes, (int, float)) and not isinstance(padding_minutes, bool):
            candidate = float(padding_minutes)
            if math.isfinite(candidate):
                candidate = max(0.0, min(30.0, candidate))
                result["motion_release_padding_minutes"] = candidate

        autosplit = raw.get("autosplit_interval_minutes")
        if isinstance(autosplit, (int, float)) and not isinstance(autosplit, bool):
            candidate = float(autosplit)
            if math.isfinite(candidate):
                candidate = max(0.0, min(24 * 60.0, candidate))
                result["autosplit_interval_minutes"] = candidate

        for key in ("use_rnnoise", "use_noisereduce", "denoise_before_vad"):
            value = raw.get(key)
            if isinstance(value, bool):
                result[key] = value

        motion_override = raw.get("auto_record_motion_override")
        if isinstance(motion_override, bool):
            result["auto_record_motion_override"] = motion_override

        rms_trigger = raw.get("enable_rms_trigger")
        if isinstance(rms_trigger, bool):
            result["enable_rms_trigger"] = rms_trigger

        vad_trigger = raw.get("enable_vad_trigger")
        if isinstance(vad_trigger, bool):
            result["enable_vad_trigger"] = vad_trigger

        for float_key, bounds in (
            ("filter_chain_avg_budget_ms", (0.0, 100.0)),
            ("filter_chain_peak_budget_ms", (0.0, 250.0)),
            ("filter_chain_log_throttle_sec", (0.0, 600.0)),
        ):
            value = raw.get(float_key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                candidate = float(value)
                if math.isfinite(candidate):
                    minimum, maximum = bounds
                    result[float_key] = max(minimum, min(maximum, candidate))

        metrics_window = raw.get("filter_chain_metrics_window")
        if isinstance(metrics_window, (int, float)) and not isinstance(metrics_window, bool):
            candidate = int(metrics_window)
            result["filter_chain_metrics_window"] = max(1, min(10_000, candidate))

        streaming_encode = raw.get("streaming_encode")
        if isinstance(streaming_encode, bool):
            result["streaming_encode"] = streaming_encode

        container = raw.get("streaming_encode_container")
        if isinstance(container, str):
            normalized = container.strip().lower()
            if normalized in {"opus", "webm"}:
                result["streaming_encode_container"] = normalized

        max_pending = raw.get("max_pending_encodes")
        if isinstance(max_pending, (int, float)) and not isinstance(max_pending, bool):
            candidate = int(max_pending)
            result["max_pending_encodes"] = max(0, min(1000, candidate))

        parallel = raw.get("parallel_encode")
        target_parallel = result.get("parallel_encode")
        if not isinstance(target_parallel, dict):
            target_parallel = {}
            result["parallel_encode"] = target_parallel
        if isinstance(parallel, dict):
            enabled = parallel.get("enabled")
            if isinstance(enabled, bool):
                target_parallel["enabled"] = enabled

            for float_key, bounds in (
                ("load_avg_per_cpu", (0.0, 10.0)),
                ("min_event_seconds", (0.0, 3600.0)),
                ("cpu_check_interval_sec", (0.0, 3600.0)),
                ("offline_load_avg_per_cpu", (0.0, 10.0)),
                ("offline_cpu_check_interval_sec", (0.0, 3600.0)),
                ("live_waveform_update_interval_sec", (0.05, 60.0)),
            ):
                value = parallel.get(float_key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    candidate = float(value)
                    if math.isfinite(candidate):
                        minimum, maximum = bounds
                        target_parallel[float_key] = max(minimum, min(maximum, candidate))

            for int_key, bounds in (
                ("offline_max_workers", (0, 32)),
                ("live_waveform_buckets", (1, 16384)),
            ):
                value = parallel.get(int_key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    candidate = int(value)
                    minimum, maximum = bounds
                    target_parallel[int_key] = max(minimum, min(maximum, candidate))

        event_tags = raw.get("event_tags")
        target_tags = result.get("event_tags")
        if not isinstance(target_tags, dict):
            target_tags = {}
            result["event_tags"] = target_tags
        if isinstance(event_tags, dict):
            for key, value in event_tags.items():
                if isinstance(key, str) and isinstance(value, str):
                    trimmed_key = key.strip()
                    if trimmed_key:
                        target_tags[trimmed_key] = value.strip()
    return result


def _canonical_paths_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _paths_defaults()
    raw = cfg.get("paths", {})
    if isinstance(raw, dict):
        for key in ("tmp_dir", "recordings_dir", "dropbox_dir", "ingest_work_dir", "encoder_script"):
            value = raw.get(key)
            if isinstance(value, str):
                trimmed = value.strip()
                result[key] = trimmed
    return result


def _canonical_notifications_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _notifications_defaults()
    raw = cfg.get("notifications", {})
    if not isinstance(raw, dict):
        return result

    enabled = raw.get("enabled")
    if isinstance(enabled, bool):
        result["enabled"] = enabled

    allowed_types = _string_list_from_config(raw.get("allowed_event_types"), default=[])
    result["allowed_event_types"] = allowed_types

    min_trigger = raw.get("min_trigger_rms")
    if isinstance(min_trigger, (int, float)) and not isinstance(min_trigger, bool):
        candidate = int(min_trigger)
        result["min_trigger_rms"] = candidate if candidate > 0 else 0
    elif min_trigger is None:
        result["min_trigger_rms"] = None

    webhook = raw.get("webhook")
    target_webhook = result.get("webhook", {})
    if isinstance(webhook, dict):
        url = webhook.get("url")
        if isinstance(url, str):
            target_webhook["url"] = url.strip()

        method = webhook.get("method")
        if isinstance(method, str):
            candidate = method.strip().upper()
            if candidate:
                target_webhook["method"] = candidate

        headers = webhook.get("headers")
        if isinstance(headers, dict):
            normalized_headers: dict[str, str] = {}
            for key, value in headers.items():
                if not isinstance(key, str):
                    continue
                if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                    normalized_headers[key.strip()] = str(value).strip()
            target_webhook["headers"] = {k: v for k, v in normalized_headers.items() if k}
        elif headers is None:
            target_webhook["headers"] = {}

        timeout = webhook.get("timeout_sec")
        if isinstance(timeout, (int, float)) and not isinstance(timeout, bool):
            candidate = float(timeout)
            if math.isfinite(candidate):
                target_webhook["timeout_sec"] = max(0.0, min(300.0, candidate))

    email = raw.get("email")
    target_email = result.get("email", {})
    if isinstance(email, dict):
        for key in ("smtp_host", "username", "password", "from", "subject_template", "body_template"):
            value = email.get(key)
            if isinstance(value, str):
                target_email[key] = value.strip()

        smtp_port = email.get("smtp_port")
        if isinstance(smtp_port, (int, float)) and not isinstance(smtp_port, bool):
            candidate = int(smtp_port)
            if 0 < candidate <= 65535:
                target_email["smtp_port"] = candidate

        for bool_key in ("use_tls", "use_ssl"):
            value = email.get(bool_key)
            if isinstance(value, bool):
                target_email[bool_key] = value

        recipients = _string_list_from_config(email.get("to"), default=[])
        target_email["to"] = recipients

    return result


def _canonical_adaptive_rms_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _adaptive_rms_defaults()
    raw = cfg.get("adaptive_rms", {})
    if isinstance(raw, dict):
        enabled = raw.get("enabled")
        if isinstance(enabled, bool):
            result["enabled"] = enabled

        min_rms = raw.get("min_rms")
        if isinstance(min_rms, (int, float)) and not isinstance(min_rms, bool):
            if math.isfinite(float(min_rms)):
                candidate = int(round(float(min_rms)))
                result["min_rms"] = candidate if candidate > 0 else None
        elif min_rms is None:
            result["min_rms"] = None

        max_rms = raw.get("max_rms")
        if isinstance(max_rms, (int, float)) and not isinstance(max_rms, bool):
            if math.isfinite(float(max_rms)):
                candidate = int(round(float(max_rms)))
                result["max_rms"] = candidate if candidate > 0 else None
        elif max_rms is None:
            result["max_rms"] = None

        for key in (
            "min_thresh",
            "max_thresh",
            "margin",
            "update_interval_sec",
            "window_sec",
            "hysteresis_tolerance",
            "release_percentile",
            "voiced_hold_sec",
        ):
            value = raw.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                result[key] = float(value)
        if result["max_thresh"] < result["min_thresh"]:
            result["max_thresh"] = result["min_thresh"]
    return result


def _canonical_ingest_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _ingest_defaults()
    raw = cfg.get("ingest", {})
    if isinstance(raw, dict):
        checks = raw.get("stable_checks")
        if isinstance(checks, (int, float)) and not isinstance(checks, bool):
            result["stable_checks"] = int(checks)

        interval = raw.get("stable_interval_sec")
        if isinstance(interval, (int, float)) and not isinstance(interval, bool):
            result["stable_interval_sec"] = float(interval)

        allowed = raw.get("allowed_ext")
        if isinstance(allowed, (list, tuple)):
            items: list[str] = []
            seen: set[str] = set()
            for entry in allowed:
                if not isinstance(entry, str):
                    continue
                normalized = entry.strip().lower()
                if not normalized:
                    continue
                if not normalized.startswith("."):
                    normalized = f".{normalized}"
                if normalized not in seen:
                    seen.add(normalized)
                    items.append(normalized)
            if items:
                result["allowed_ext"] = items

        ignore = raw.get("ignore_suffixes")
        if isinstance(ignore, (list, tuple)):
            items = []
            seen: set[str] = set()
            for entry in ignore:
                if not isinstance(entry, str):
                    continue
                normalized = entry.strip().lower()
                if not normalized:
                    continue
                if normalized not in seen:
                    seen.add(normalized)
                    items.append(normalized)
            if items:
                result["ignore_suffixes"] = items
    return result


def _canonical_logging_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _logging_defaults()
    raw = cfg.get("logging", {})
    if isinstance(raw, dict):
        dev_mode = raw.get("dev_mode")
        if isinstance(dev_mode, bool):
            result["dev_mode"] = dev_mode
    return result


def _canonical_streaming_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _streaming_defaults()
    raw = cfg.get("streaming", {})
    if isinstance(raw, dict):
        mode = raw.get("mode")
        if isinstance(mode, str):
            normalized = mode.strip().lower()
            if normalized in _STREAMING_MODES:
                result["mode"] = normalized

        history = raw.get("webrtc_history_seconds")
        if isinstance(history, (int, float)) and not isinstance(history, bool):
            result["webrtc_history_seconds"] = float(history)
    return result


def _canonical_dashboard_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _dashboard_defaults()
    raw = cfg.get("dashboard", {})
    if isinstance(raw, dict):
        api_base = raw.get("api_base")
        if isinstance(api_base, str):
            result["api_base"] = api_base.strip()
    return result


def _canonical_web_server_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _web_server_defaults()
    raw = cfg.get("web_server", {})
    if not isinstance(raw, dict):
        return result

    mode = raw.get("mode")
    if isinstance(mode, str):
        candidate = mode.strip().lower()
        if candidate in WEB_SERVER_MODES:
            result["mode"] = candidate

    host = raw.get("listen_host") or raw.get("host")
    if isinstance(host, str):
        stripped = host.strip()
        if stripped:
            result["listen_host"] = stripped

    port = raw.get("listen_port") or raw.get("port")
    if isinstance(port, (int, float)) and not isinstance(port, bool):
        candidate = int(port)
        if 1 <= candidate <= 65535:
            result["listen_port"] = candidate

    provider = raw.get("tls_provider") or raw.get("provider")
    if isinstance(provider, str):
        candidate = provider.strip().lower()
        if candidate in WEB_SERVER_TLS_PROVIDERS:
            result["tls_provider"] = candidate

    cert_path = raw.get("certificate_path") or raw.get("cert_path")
    if isinstance(cert_path, str):
        result["certificate_path"] = cert_path.strip()

    key_path = raw.get("private_key_path") or raw.get("key_path")
    if isinstance(key_path, str):
        result["private_key_path"] = key_path.strip()

    lets_encrypt = raw.get("lets_encrypt") or raw.get("letsencrypt")
    if isinstance(lets_encrypt, dict):
        enabled = lets_encrypt.get("enabled")
        if isinstance(enabled, bool):
            result["lets_encrypt"]["enabled"] = enabled
        elif enabled is not None:
            result["lets_encrypt"]["enabled"] = _bool_from_any(enabled)

        email = lets_encrypt.get("email")
        if isinstance(email, str):
            result["lets_encrypt"]["email"] = email.strip()

        domains = _string_list_from_config(
            lets_encrypt.get("domains"), default=result["lets_encrypt"]["domains"]
        )
        if domains:
            result["lets_encrypt"]["domains"] = domains

        cache_dir = lets_encrypt.get("cache_dir")
        if isinstance(cache_dir, str):
            result["lets_encrypt"]["cache_dir"] = cache_dir.strip()

        staging = lets_encrypt.get("staging")
        if isinstance(staging, bool):
            result["lets_encrypt"]["staging"] = staging
        elif staging is not None:
            result["lets_encrypt"]["staging"] = _bool_from_any(staging)

        certbot_path = lets_encrypt.get("certbot_path") or lets_encrypt.get("certbot")
        if isinstance(certbot_path, str):
            result["lets_encrypt"]["certbot_path"] = certbot_path.strip()

        http_port = lets_encrypt.get("http_port") or lets_encrypt.get("port")
        if isinstance(http_port, (int, float)) and not isinstance(http_port, bool):
            candidate = int(http_port)
            if 1 <= candidate <= 65535:
                result["lets_encrypt"]["http_port"] = candidate

        renew_before = (
            lets_encrypt.get("renew_before_days")
            or lets_encrypt.get("renew_days")
        )
        if isinstance(renew_before, (int, float)) and not isinstance(renew_before, bool):
            result["lets_encrypt"]["renew_before_days"] = max(1, int(renew_before))

    return result


def _canonical_transcription_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _transcription_defaults()
    raw = cfg.get("transcription", {})
    if not isinstance(raw, dict):
        return result

    enabled = raw.get("enabled")
    if isinstance(enabled, bool):
        result["enabled"] = enabled
    elif enabled is not None:
        result["enabled"] = _bool_from_any(enabled)

    engine = raw.get("engine")
    if isinstance(engine, str):
        normalized_engine = engine.strip().lower()
        if normalized_engine in _TRANSCRIPTION_ENGINES:
            result["engine"] = normalized_engine

    types = _string_list_from_config(raw.get("types"), default=result["types"])
    if types:
        result["types"] = types

    model_path = raw.get("vosk_model_path") or raw.get("model_path")
    if isinstance(model_path, str):
        stripped = model_path.strip()
        if stripped:
            result["vosk_model_path"] = stripped

    target_rate = raw.get("target_sample_rate") or raw.get("vosk_sample_rate")
    if isinstance(target_rate, (int, float)) and not isinstance(target_rate, bool):
        result["target_sample_rate"] = int(target_rate)

    include_words = raw.get("include_words")
    if isinstance(include_words, bool):
        result["include_words"] = include_words
    elif include_words is not None:
        result["include_words"] = _bool_from_any(include_words)

    max_alternatives = raw.get("max_alternatives")
    if isinstance(max_alternatives, (int, float)) and not isinstance(max_alternatives, bool):
        result["max_alternatives"] = max(0, int(max_alternatives))

    return result


def _config_section_payload(
    section: str, cfg: dict[str, Any], canonical_fn
) -> dict[str, Any]:
    normalized = canonical_fn(cfg)
    try:
        path = str(primary_config_path())
    except Exception:
        path = None
    return {section: normalized, "config_path": path}


def _coerce_int(
    value: Any,
    field: str,
    errors: list[str],
    *,
    min_value: int | None = None,
    max_value: int | None = None,
    allowed: set[int] | None = None,
) -> int | None:
    if isinstance(value, bool):
        errors.append(f"{field} must be a number")
        return None
    candidate: int | None = None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            errors.append(f"{field} must be a finite number")
            return None
        candidate = int(round(value))
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            errors.append(f"{field} is required")
            return None
        try:
            candidate = int(text, 10)
        except ValueError:
            errors.append(f"{field} must be an integer")
            return None
    else:
        errors.append(f"{field} must be an integer")
        return None

    if allowed is not None and candidate not in allowed:
        allowed_values = ", ".join(str(item) for item in sorted(allowed))
        errors.append(f"{field} must be one of: {allowed_values}")
        return None

    if min_value is not None and candidate < min_value:
        errors.append(f"{field} must be at least {min_value}")
        return None

    if max_value is not None and candidate > max_value:
        errors.append(f"{field} must be at most {max_value}")
        return None

    return candidate


def _coerce_float(
    value: Any,
    field: str,
    errors: list[str],
    *,
    min_value: float | None = None,
    max_value: float | None = None,
) -> float | None:
    if isinstance(value, bool):
        errors.append(f"{field} must be a number")
        return None
    candidate: float | None = None
    if isinstance(value, (int, float)):
        candidate = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            errors.append(f"{field} is required")
            return None
        try:
            candidate = float(text)
        except ValueError:
            errors.append(f"{field} must be a number")
            return None
    else:
        errors.append(f"{field} must be a number")
        return None

    if not math.isfinite(candidate):
        errors.append(f"{field} must be finite")
        return None

    if min_value is not None and candidate < min_value:
        errors.append(f"{field} must be at least {min_value}")
        return None

    if max_value is not None and candidate > max_value:
        errors.append(f"{field} must be at most {max_value}")
        return None

    return candidate


def _normalize_extension_list(
    value: Any, field: str, errors: list[str]
) -> tuple[list[str], bool]:
    items, provided = _string_list_from_payload(value, field, errors)
    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        candidate = item.lower()
        if not candidate.startswith("."):
            candidate = f".{candidate}"
        if candidate not in seen:
            seen.add(candidate)
            normalized.append(candidate)
    return normalized, provided


def _normalize_suffix_list(
    value: Any, field: str, errors: list[str]
) -> tuple[list[str], bool]:
    items, provided = _string_list_from_payload(value, field, errors)
    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        candidate = item.lower()
        if candidate and candidate not in seen:
            seen.add(candidate)
            normalized.append(candidate)
    return normalized, provided


def _normalize_audio_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _audio_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    existing_filters: list[dict[str, Any]] = []
    existing_stage_configs: dict[str, dict[str, Any]] = {}
    try:
        cfg_snapshot = get_cfg()
        current_audio = cfg_snapshot.get("audio", {}) if isinstance(cfg_snapshot, dict) else {}
        current_filters = current_audio.get("filter_chain") if isinstance(current_audio, dict) else None
        if isinstance(current_filters, dict):
            existing_filters = _copy_filter_stage_sequence(current_filters.get("filters"))
            for stage_key in AUDIO_FILTER_STAGE_SPECS:
                stage_cfg = current_filters.get(stage_key)
                if isinstance(stage_cfg, dict):
                    existing_stage_configs[stage_key] = {
                        key: copy.deepcopy(val) for key, val in stage_cfg.items()
                    }
        elif isinstance(current_filters, Sequence) and not isinstance(current_filters, (str, bytes)):
            existing_filters = _copy_filter_stage_sequence(current_filters)
    except Exception:
        existing_filters = []

    device = payload.get("device")
    if isinstance(device, str) and device.strip():
        normalized["device"] = device.strip()
    else:
        errors.append("device must be a non-empty string")

    sample_rate = _coerce_int(
        payload.get("sample_rate"),
        "sample_rate",
        errors,
        allowed=_AUDIO_SAMPLE_RATES,
    )
    if sample_rate is not None:
        normalized["sample_rate"] = sample_rate

    raw_channels = payload.get("channels")
    if raw_channels is not None:
        channels = _coerce_int(
            raw_channels,
            "channels",
            errors,
            allowed={1, 2},
        )
        if channels is not None:
            normalized["channels"] = channels

    frame_ms = _coerce_int(
        payload.get("frame_ms"),
        "frame_ms",
        errors,
        allowed=_AUDIO_FRAME_LENGTHS,
    )
    if frame_ms is not None:
        normalized["frame_ms"] = frame_ms

    gain = _coerce_float(payload.get("gain"), "gain", errors, min_value=0.1, max_value=16.0)
    if gain is not None:
        normalized["gain"] = gain

    vad = _coerce_int(
        payload.get("vad_aggressiveness"),
        "vad_aggressiveness",
        errors,
        min_value=0,
        max_value=3,
    )
    if vad is not None:
        normalized["vad_aggressiveness"] = vad

    if "usb_reset_workaround" in payload:
        normalized["usb_reset_workaround"] = _bool_from_any(payload.get("usb_reset_workaround"))

    filters_payload = payload.get("filter_chain")
    stages = normalized.get("filter_chain")
    if isinstance(stages, dict) and existing_stage_configs:
        for stage_key, stage_cfg in existing_stage_configs.items():
            defaults = stages.get(stage_key)
            if isinstance(defaults, dict):
                merged = {key: copy.deepcopy(val) for key, val in defaults.items()}
                merged.update(stage_cfg)
                stages[stage_key] = merged
            else:
                stages[stage_key] = {
                    key: copy.deepcopy(val) for key, val in stage_cfg.items()
                }
    if isinstance(filters_payload, dict) or filters_payload is None:
        if filters_payload is None:
            filters_payload = {}
        stages = normalized.get("filter_chain")
        if not isinstance(stages, dict):
            stages = {}
            normalized["filter_chain"] = stages
        for stage_key, field_specs in AUDIO_FILTER_STAGE_SPECS.items():
            stage_payload = filters_payload.get(stage_key)
            if stage_payload is None:
                continue
            if not isinstance(stage_payload, dict):
                errors.append(f"filter_chain.{stage_key} must be an object")
                continue
            target = stages.get(stage_key)
            if not isinstance(target, dict):
                defaults = AUDIO_FILTER_DEFAULTS.get(stage_key)
                target = copy.deepcopy(defaults) if isinstance(defaults, dict) else {}
                stages[stage_key] = target
            if "enabled" in stage_payload:
                target["enabled"] = _bool_from_any(stage_payload.get("enabled"))
            for field_name, (min_value, max_value) in field_specs.items():
                if field_name not in stage_payload:
                    continue
                candidate = _coerce_float(
                    stage_payload.get(field_name),
                    f"filter_chain.{stage_key}.{field_name}",
                    errors,
                    min_value=min_value,
                    max_value=max_value,
                )
                if candidate is not None:
                    target[field_name] = candidate
            enum_specs = AUDIO_FILTER_STAGE_ENUMS.get(stage_key, {})
            for enum_name, allowed_values in enum_specs.items():
                if enum_name not in stage_payload:
                    continue
                raw_value = stage_payload.get(enum_name)
                if not isinstance(raw_value, str):
                    errors.append(
                        f"filter_chain.{stage_key}.{enum_name} must be one of: {', '.join(sorted(allowed_values))}"
                    )
                    continue
                normalized_value = raw_value.strip().lower()
                if normalized_value not in allowed_values:
                    errors.append(
                        f"filter_chain.{stage_key}.{enum_name} must be one of: {', '.join(sorted(allowed_values))}"
                    )
                    continue
                target[enum_name] = normalized_value
        filters_list = filters_payload.get("filters") if isinstance(filters_payload, dict) else None
        if isinstance(filters_list, Sequence) and not isinstance(filters_list, (str, bytes)):
            stages["filters"] = _copy_filter_stage_sequence(filters_list)
        elif "filters" in filters_payload:
            # filters key present but not a proper sequence
            errors.append("filter_chain.filters must be an array of objects")
        elif existing_filters:
            stages["filters"] = _copy_filter_stage_sequence(existing_filters)
    elif isinstance(filters_payload, Sequence) and not isinstance(filters_payload, (str, bytes)):
        stages = normalized.get("filter_chain")
        if not isinstance(stages, dict):
            stages = {}
            normalized["filter_chain"] = stages
        stages["filters"] = _copy_filter_stage_sequence(filters_payload)
    else:
        errors.append("filter_chain must be an object or array")

    calibration_payload = payload.get("calibration")
    if calibration_payload is None:
        calibration_payload = {}
    if isinstance(calibration_payload, dict):
        target = normalized.get("calibration")
        if not isinstance(target, dict):
            target = {}
            normalized["calibration"] = target
        if "auto_noise_profile" in calibration_payload:
            target["auto_noise_profile"] = _bool_from_any(
                calibration_payload.get("auto_noise_profile")
            )
        if "auto_gain" in calibration_payload:
            target["auto_gain"] = _bool_from_any(calibration_payload.get("auto_gain"))
    else:
        errors.append("calibration must be an object")

    return normalized, errors


def _normalize_segmenter_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _segmenter_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    int_fields = {
        "pre_pad_ms": (0, 60000),
        "post_pad_ms": (0, 120000),
        "rms_threshold": (0, 10000),
        "keep_window_frames": (1, 2000),
        "start_consecutive": (1, 2000),
        "keep_consecutive": (1, 2000),
        "flush_threshold_bytes": (4096, 4 * 1024 * 1024),
        "max_queue_frames": (16, 4096),
        "filter_chain_metrics_window": (1, 10_000),
        "max_pending_encodes": (0, 1000),
    }

    for field, bounds in int_fields.items():
        min_value, max_value = bounds
        candidate = _coerce_int(payload.get(field), field, errors, min_value=min_value, max_value=max_value)
        if candidate is not None:
            normalized[field] = candidate

    min_clip = _coerce_float(
        payload.get("min_clip_seconds"),
        "min_clip_seconds",
        errors,
        min_value=0.0,
        max_value=600.0,
    )
    if min_clip is not None:
        normalized["min_clip_seconds"] = min_clip

    motion_padding = _coerce_float(
        payload.get("motion_release_padding_minutes"),
        "motion_release_padding_minutes",
        errors,
        min_value=0.0,
        max_value=30.0,
    )
    if motion_padding is not None:
        normalized["motion_release_padding_minutes"] = motion_padding

    autosplit = _coerce_float(
        payload.get("autosplit_interval_minutes"),
        "autosplit_interval_minutes",
        errors,
        min_value=0.0,
        max_value=24 * 60.0,
    )
    if autosplit is not None:
        normalized["autosplit_interval_minutes"] = autosplit

    for field in ("use_rnnoise", "use_noisereduce", "denoise_before_vad"):
        normalized[field] = _bool_from_any(payload.get(field))

    motion_override = payload.get("auto_record_motion_override")
    if motion_override is not None:
        normalized["auto_record_motion_override"] = _bool_from_any(motion_override)

    if "enable_rms_trigger" in payload:
        normalized["enable_rms_trigger"] = _bool_from_any(
            payload.get("enable_rms_trigger")
        )

    if "enable_vad_trigger" in payload:
        normalized["enable_vad_trigger"] = _bool_from_any(
            payload.get("enable_vad_trigger")
        )

    float_fields = {
        "filter_chain_avg_budget_ms": (0.0, 100.0),
        "filter_chain_peak_budget_ms": (0.0, 250.0),
        "filter_chain_log_throttle_sec": (0.0, 600.0),
    }
    for field, bounds in float_fields.items():
        candidate = _coerce_float(payload.get(field), field, errors, min_value=bounds[0], max_value=bounds[1])
        if candidate is not None:
            normalized[field] = candidate

    streaming_encode = payload.get("streaming_encode")
    if streaming_encode is not None:
        normalized["streaming_encode"] = _bool_from_any(streaming_encode)

    container = payload.get("streaming_encode_container")
    if container is not None:
        if isinstance(container, str) and container.strip().lower() in {"opus", "webm"}:
            normalized["streaming_encode_container"] = container.strip().lower()
        else:
            errors.append("streaming_encode_container must be one of: opus, webm")

    parallel_payload = payload.get("parallel_encode")
    if parallel_payload is not None:
        if isinstance(parallel_payload, dict):
            normalized_parallel = normalized.get("parallel_encode")
            if not isinstance(normalized_parallel, dict):
                normalized_parallel = {}
                normalized["parallel_encode"] = normalized_parallel

            normalized_parallel["enabled"] = _bool_from_any(parallel_payload.get("enabled"))

            parallel_float_fields = {
                "load_avg_per_cpu": (0.0, 10.0),
                "min_event_seconds": (0.0, 3600.0),
                "cpu_check_interval_sec": (0.0, 3600.0),
                "offline_load_avg_per_cpu": (0.0, 10.0),
                "offline_cpu_check_interval_sec": (0.0, 3600.0),
                "live_waveform_update_interval_sec": (0.05, 60.0),
            }
            for field, bounds in parallel_float_fields.items():
                candidate = _coerce_float(
                    parallel_payload.get(field),
                    f"parallel_encode.{field}",
                    errors,
                    min_value=bounds[0],
                    max_value=bounds[1],
                )
                if candidate is not None:
                    normalized_parallel[field] = candidate

            parallel_int_fields = {
                "offline_max_workers": (0, 32),
                "live_waveform_buckets": (1, 16384),
            }
            for field, bounds in parallel_int_fields.items():
                candidate = _coerce_int(
                    parallel_payload.get(field),
                    f"parallel_encode.{field}",
                    errors,
                    min_value=bounds[0],
                    max_value=bounds[1],
                )
                if candidate is not None:
                    normalized_parallel[field] = candidate
        else:
            errors.append("parallel_encode must be an object")

    event_tags_payload = payload.get("event_tags")
    if event_tags_payload is not None:
        if isinstance(event_tags_payload, dict):
            normalized_tags: dict[str, str] = {}
            for key, value in event_tags_payload.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    errors.append("event_tags entries must map strings to strings")
                    normalized_tags = {}
                    break
                trimmed_key = key.strip()
                if not trimmed_key:
                    errors.append("event_tags keys must not be empty")
                    normalized_tags = {}
                    break
                normalized_tags[trimmed_key] = value.strip()
            if normalized_tags:
                normalized["event_tags"] = normalized_tags
        else:
            errors.append("event_tags must be an object")

    return normalized, errors


def _normalize_paths_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []

    if not isinstance(payload, dict):
        return _paths_defaults(), ["Request body must be a JSON object"]

    normalized: dict[str, Any] = {}

    for key in ("tmp_dir", "recordings_dir", "dropbox_dir", "ingest_work_dir", "encoder_script"):
        if key not in payload:
            continue
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            normalized[key] = value.strip()
        else:
            errors.append(f"{key} must be a string")

    return normalized, errors


def _normalize_notifications_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _notifications_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    normalized["enabled"] = _bool_from_any(payload.get("enabled"))

    allowed = payload.get("allowed_event_types")
    if allowed is None:
        normalized["allowed_event_types"] = []
    else:
        allowed_list = _string_list_from_config(allowed, default=None)
        if allowed_list is None:
            errors.append("allowed_event_types must be an array or newline-delimited string")
        else:
            normalized["allowed_event_types"] = allowed_list

    raw_min_trigger = payload.get("min_trigger_rms")
    if raw_min_trigger is None or (isinstance(raw_min_trigger, str) and not raw_min_trigger.strip()):
        normalized["min_trigger_rms"] = None
    else:
        min_trigger = _coerce_int(
            raw_min_trigger,
            "min_trigger_rms",
            errors,
            min_value=0,
            max_value=32767,
        )
        if min_trigger is not None:
            normalized["min_trigger_rms"] = min_trigger

    webhook_payload = payload.get("webhook")
    if webhook_payload is None:
        webhook_payload = {}
    if isinstance(webhook_payload, dict):
        target = normalized.get("webhook", {})
        url = webhook_payload.get("url")
        if url is not None:
            if isinstance(url, str):
                target["url"] = url.strip()
            else:
                errors.append("webhook.url must be a string")

        method = webhook_payload.get("method")
        if method is not None:
            if isinstance(method, str) and method.strip():
                target["method"] = method.strip().upper()
            else:
                errors.append("webhook.method must be a non-empty string")

        headers_payload = webhook_payload.get("headers")
        if headers_payload is None:
            target["headers"] = {}
        elif isinstance(headers_payload, dict):
            normalized_headers: dict[str, str] = {}
            for key, value in headers_payload.items():
                if not isinstance(key, str):
                    errors.append("webhook.headers keys must be strings")
                    normalized_headers = {}
                    break
                if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                    normalized_headers[key.strip()] = str(value).strip()
                else:
                    errors.append("webhook.headers values must be strings or numbers")
                    normalized_headers = {}
                    break
            target["headers"] = {k: v for k, v in normalized_headers.items() if k}
        else:
            errors.append("webhook.headers must be an object")

        timeout = webhook_payload.get("timeout_sec")
        if timeout is not None:
            timeout_value = _coerce_float(timeout, "webhook.timeout_sec", errors, min_value=0.0, max_value=300.0)
            if timeout_value is not None:
                target["timeout_sec"] = timeout_value
    else:
        errors.append("webhook must be an object")

    email_payload = payload.get("email")
    if email_payload is None:
        email_payload = {}
    if isinstance(email_payload, dict):
        target_email = normalized.get("email", {})
        for field in ("smtp_host", "username", "password", "from", "subject_template", "body_template"):
            value = email_payload.get(field)
            if value is None:
                continue
            if isinstance(value, str):
                target_email[field] = value.strip()
            else:
                errors.append(f"email.{field} must be a string")

        smtp_port = email_payload.get("smtp_port")
        if smtp_port is not None:
            port_value = _coerce_int(smtp_port, "email.smtp_port", errors, min_value=1, max_value=65535)
            if port_value is not None:
                target_email["smtp_port"] = port_value

        for field in ("use_tls", "use_ssl"):
            value = email_payload.get(field)
            if value is not None:
                if isinstance(value, bool):
                    target_email[field] = value
                else:
                    errors.append(f"email.{field} must be a boolean")

        recipients = email_payload.get("to")
        if recipients is None:
            target_email["to"] = []
        else:
            parsed = _string_list_from_config(recipients, default=None)
            if parsed is None:
                errors.append("email.to must be an array or newline-delimited string")
            else:
                target_email["to"] = parsed
    else:
        errors.append("email must be an object")

    return normalized, errors


def _normalize_adaptive_rms_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _adaptive_rms_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    normalized["enabled"] = _bool_from_any(payload.get("enabled"))

    raw_min_rms = payload.get("min_rms")
    if raw_min_rms is None:
        normalized["min_rms"] = None
    elif isinstance(raw_min_rms, str) and not raw_min_rms.strip():
        normalized["min_rms"] = None
    else:
        min_rms_value = _coerce_int(
            raw_min_rms,
            "min_rms",
            errors,
            min_value=0,
            max_value=32767,
        )
        if min_rms_value is not None:
            normalized["min_rms"] = min_rms_value or None

    raw_min_thresh = payload.get("min_thresh")
    if raw_min_thresh is None:
        pass
    elif isinstance(raw_min_thresh, str) and not raw_min_thresh.strip():
        # Treat an empty string as "use the default" instead of raising a validation error.
        normalized["min_thresh"] = _adaptive_rms_defaults()["min_thresh"]
    else:
        min_thresh = _coerce_float(
            raw_min_thresh, "min_thresh", errors, min_value=0.0, max_value=1.0
        )
        if min_thresh is not None:
            normalized["min_thresh"] = min_thresh

    raw_max_rms = payload.get("max_rms")
    if raw_max_rms is None:
        normalized["max_rms"] = None
    elif isinstance(raw_max_rms, str) and not raw_max_rms.strip():
        normalized["max_rms"] = None
    else:
        max_rms_value = _coerce_int(
            raw_max_rms,
            "max_rms",
            errors,
            min_value=0,
            max_value=32767,
        )
        if max_rms_value is not None:
            normalized["max_rms"] = max_rms_value or None

    max_thresh = _coerce_float(
        payload.get("max_thresh"), "max_thresh", errors, min_value=0.0, max_value=1.0
    )
    if max_thresh is not None:
        normalized["max_thresh"] = max_thresh

    margin = _coerce_float(payload.get("margin"), "margin", errors, min_value=0.5, max_value=10.0)
    if margin is not None:
        normalized["margin"] = margin

    update_interval = _coerce_float(
        payload.get("update_interval_sec"),
        "update_interval_sec",
        errors,
        min_value=0.5,
        max_value=120.0,
    )
    if update_interval is not None:
        normalized["update_interval_sec"] = update_interval

    window_sec = _coerce_float(
        payload.get("window_sec"), "window_sec", errors, min_value=1.0, max_value=300.0
    )
    if window_sec is not None:
        normalized["window_sec"] = window_sec

    hysteresis = _coerce_float(
        payload.get("hysteresis_tolerance"),
        "hysteresis_tolerance",
        errors,
        min_value=0.0,
        max_value=1.0,
    )
    if hysteresis is not None:
        normalized["hysteresis_tolerance"] = hysteresis

    percentile = _coerce_float(
        payload.get("release_percentile"),
        "release_percentile",
        errors,
        min_value=0.05,
        max_value=1.0,
    )
    if percentile is not None:
        normalized["release_percentile"] = percentile

    voiced_hold = _coerce_float(
        payload.get("voiced_hold_sec"),
        "voiced_hold_sec",
        errors,
        min_value=0.0,
        max_value=600.0,
    )
    if voiced_hold is not None:
        normalized["voiced_hold_sec"] = voiced_hold

    if normalized["max_thresh"] < normalized["min_thresh"]:
        errors.append("max_thresh must be greater than or equal to min_thresh")

    return normalized, errors


def _normalize_ingest_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _ingest_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    checks = _coerce_int(payload.get("stable_checks"), "stable_checks", errors, min_value=1, max_value=20)
    if checks is not None:
        normalized["stable_checks"] = checks

    interval = _coerce_float(
        payload.get("stable_interval_sec"), "stable_interval_sec", errors, min_value=0.1, max_value=30.0
    )
    if interval is not None:
        normalized["stable_interval_sec"] = interval

    allowed, provided_allowed = _normalize_extension_list(payload.get("allowed_ext"), "allowed_ext", errors)
    if provided_allowed:
        normalized["allowed_ext"] = allowed

    ignore, provided_ignore = _normalize_suffix_list(payload.get("ignore_suffixes"), "ignore_suffixes", errors)
    if provided_ignore:
        normalized["ignore_suffixes"] = ignore

    if not normalized["allowed_ext"]:
        errors.append("allowed_ext must include at least one extension")

    return normalized, errors


def _normalize_transcription_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _transcription_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    normalized["enabled"] = _bool_from_any(payload.get("enabled"))

    engine_value = payload.get("engine")
    if engine_value is None:
        pass
    elif isinstance(engine_value, str):
        candidate = engine_value.strip().lower()
        if candidate in _TRANSCRIPTION_ENGINES:
            normalized["engine"] = candidate
        elif candidate:
            errors.append("engine must be one of: vosk")
    else:
        errors.append("engine must be a string")

    types_value, provided_types = _string_list_from_payload(payload.get("types"), "types", errors)
    if provided_types:
        if types_value:
            normalized["types"] = types_value
        else:
            errors.append("types must include at least one entry")

    model_key = payload.get("vosk_model_path") or payload.get("model_path")
    if model_key is None:
        pass
    elif isinstance(model_key, str):
        stripped = model_key.strip()
        if stripped:
            normalized["vosk_model_path"] = stripped
        else:
            errors.append("vosk_model_path must be a non-empty string")
    else:
        errors.append("vosk_model_path must be a string")

    target_rate = _coerce_int(
        payload.get("target_sample_rate"),
        "target_sample_rate",
        errors,
        min_value=8000,
        max_value=96000,
    )
    if target_rate is not None:
        normalized["target_sample_rate"] = target_rate

    include_words_value = payload.get("include_words")
    if include_words_value is not None:
        normalized["include_words"] = _bool_from_any(include_words_value)

    max_alternatives = _coerce_int(
        payload.get("max_alternatives"),
        "max_alternatives",
        errors,
        min_value=0,
        max_value=10,
    )
    if max_alternatives is not None:
        normalized["max_alternatives"] = max_alternatives

    if normalized["enabled"] and not normalized["vosk_model_path"]:
        errors.append("vosk_model_path must be a non-empty string when transcription is enabled")

    return normalized, errors


def _normalize_logging_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _logging_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    normalized["dev_mode"] = _bool_from_any(payload.get("dev_mode"))
    return normalized, errors


def _normalize_streaming_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _streaming_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    mode_raw = payload.get("mode")
    if isinstance(mode_raw, str):
        candidate = mode_raw.strip().lower()
        if candidate in _STREAMING_MODES:
            normalized["mode"] = candidate
        else:
            errors.append("mode must be one of: hls, webrtc")
    else:
        errors.append("mode must be a string")

    history = _coerce_float(
        payload.get("webrtc_history_seconds"),
        "webrtc_history_seconds",
        errors,
        min_value=1.0,
        max_value=600.0,
    )
    if history is not None:
        normalized["webrtc_history_seconds"] = history

    return normalized, errors


def _normalize_dashboard_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _dashboard_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    api_base = payload.get("api_base")
    if api_base is None:
        normalized["api_base"] = ""
    elif isinstance(api_base, str):
        normalized["api_base"] = api_base.strip()
    else:
        errors.append("api_base must be a string")

    return normalized, errors


def _normalize_web_server_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    try:
        cfg_snapshot = get_cfg()
    except Exception:  # pragma: no cover - defensive fallback
        cfg_snapshot = {}
    normalized = copy.deepcopy(_canonical_web_server_settings(cfg_snapshot))
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    mode_raw = payload.get("mode")
    if isinstance(mode_raw, str):
        candidate = mode_raw.strip().lower()
        if candidate in WEB_SERVER_MODES:
            normalized["mode"] = candidate
        else:
            errors.append("mode must be one of: http, https")
    else:
        errors.append("mode must be a string")

    host_raw = payload.get("listen_host") or payload.get("host")
    if host_raw is None:
        pass
    elif isinstance(host_raw, str):
        normalized["listen_host"] = host_raw.strip() or "0.0.0.0"
    else:
        errors.append("listen_host must be a string")

    port = _coerce_int(
        payload.get("listen_port") or payload.get("port"),
        "listen_port",
        errors,
        min_value=1,
        max_value=65535,
    )
    if port is not None:
        normalized["listen_port"] = port

    provider_raw = payload.get("tls_provider") or payload.get("provider")
    if provider_raw is None:
        pass
    elif isinstance(provider_raw, str):
        candidate = provider_raw.strip().lower()
        if candidate in WEB_SERVER_TLS_PROVIDERS:
            normalized["tls_provider"] = candidate
        else:
            errors.append("tls_provider must be one of: letsencrypt, manual")
    else:
        errors.append("tls_provider must be a string")

    cert_path = payload.get("certificate_path")
    if cert_path is None:
        pass
    elif isinstance(cert_path, str):
        normalized["certificate_path"] = cert_path.strip()
    else:
        errors.append("certificate_path must be a string")

    key_path = payload.get("private_key_path")
    if key_path is None:
        pass
    elif isinstance(key_path, str):
        normalized["private_key_path"] = key_path.strip()
    else:
        errors.append("private_key_path must be a string")

    lets_encrypt_raw = payload.get("lets_encrypt") or payload.get("letsencrypt")
    lets_payload: Mapping[str, Any]
    if lets_encrypt_raw is None:
        lets_payload = {}
    elif isinstance(lets_encrypt_raw, Mapping):
        lets_payload = lets_encrypt_raw
    else:
        errors.append("lets_encrypt must be an object")
        lets_payload = {}

    if lets_payload:
        enabled_value = lets_payload.get("enabled")
        if enabled_value is not None:
            normalized["lets_encrypt"]["enabled"] = _bool_from_any(enabled_value)

        email_value = lets_payload.get("email")
        if email_value is None:
            pass
        elif isinstance(email_value, str):
            normalized["lets_encrypt"]["email"] = email_value.strip()
        else:
            errors.append("lets_encrypt.email must be a string")

        domains_value, provided_domains = _string_list_from_payload(
            lets_payload.get("domains"),
            "lets_encrypt.domains",
            errors,
        )
        if provided_domains:
            normalized["lets_encrypt"]["domains"] = domains_value

        cache_dir_value = lets_payload.get("cache_dir")
        if cache_dir_value is None:
            pass
        elif isinstance(cache_dir_value, str):
            normalized["lets_encrypt"]["cache_dir"] = cache_dir_value.strip()
        else:
            errors.append("lets_encrypt.cache_dir must be a string")

        staging_value = lets_payload.get("staging")
        if staging_value is not None:
            normalized["lets_encrypt"]["staging"] = _bool_from_any(staging_value)

        certbot_value = lets_payload.get("certbot_path") or lets_payload.get("certbot")
        if certbot_value is None:
            pass
        elif isinstance(certbot_value, str):
            normalized["lets_encrypt"]["certbot_path"] = certbot_value.strip()
        else:
            errors.append("lets_encrypt.certbot_path must be a string")

        http_port_value = _coerce_int(
            lets_payload.get("http_port") or lets_payload.get("port"),
            "lets_encrypt.http_port",
            errors,
            min_value=1,
            max_value=65535,
        )
        if http_port_value is not None:
            normalized["lets_encrypt"]["http_port"] = http_port_value

        renew_value = _coerce_int(
            lets_payload.get("renew_before_days") or lets_payload.get("renew_days"),
            "lets_encrypt.renew_before_days",
            errors,
            min_value=1,
            max_value=365,
        )
        if renew_value is not None:
            normalized["lets_encrypt"]["renew_before_days"] = renew_value

    if normalized["mode"] == "https":
        provider = normalized["tls_provider"]
        if provider == "manual":
            if not normalized["certificate_path"] or not normalized["private_key_path"]:
                errors.append(
                    "certificate_path and private_key_path are required when tls_provider is manual"
                )
        else:
            normalized["lets_encrypt"]["enabled"] = True
            if not normalized["lets_encrypt"]["domains"]:
                errors.append("lets_encrypt.domains must include at least one entry")
    else:
        normalized["lets_encrypt"]["enabled"] = False

    return normalized, errors


async def _restart_units(units: Iterable[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for unit in units:
        unit_text = str(unit or "").strip()
        if not unit_text or unit_text in seen:
            continue
        seen.add(unit_text)
        status_code, status_stdout, status_stderr = await _run_systemctl(
            ["is-active", unit_text]
        )
        status_stdout_text = status_stdout.strip()
        status_stderr_text = status_stderr.strip()
        if status_code != 0:
            skip_reason = status_stderr_text or status_stdout_text
            if not skip_reason:
                skip_reason = "Service inactive; restart skipped."
            results.append(
                {
                    "unit": f"{unit_text} (inactive, restart skipped)",
                    "ok": True,
                    "stdout": status_stdout_text,
                    "stderr": status_stderr_text,
                    "message": skip_reason,
                    "returncode": 0,
                }
            )
            continue
        code, stdout, stderr = await _run_systemctl(["restart", unit_text])
        stdout_text = stdout.strip()
        stderr_text = stderr.strip()
        message = stderr_text or stdout_text
        results.append(
            {
                "unit": unit_text,
                "ok": code == 0,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "message": message,
                "returncode": code,
            }
        )
    return results

from aiohttp import web, web_fileresponse
from aiohttp.web import AppKey

# aiohttp's sendfile() path sometimes times out on slow or lossy networks when
# downloading large recordings. Force the chunked fallback, which cooperates
# better with flow control and avoids surfacing TimeoutError to clients.
web_fileresponse.NOSENDFILE = True

from lib.hls_controller import controller
from lib import dashboard_events, sd_card_health, webui
from lib.config import (
    ConfigPersistenceError,
    apply_config_migrations,
    get_cfg,
    primary_config_path,
    reload_cfg,
    update_adaptive_rms_settings,
    update_archival_settings,
    update_audio_settings,
    update_paths_settings,
    update_dashboard_settings,
    update_ingest_settings,
    update_logging_settings,
    update_notifications_settings,
    update_segmenter_settings,
    update_streaming_settings,
    update_transcription_settings,
    update_web_server_settings,
)
from lib.lets_encrypt import LetsEncryptError, LetsEncryptManager
from lib.motion_state import (
    MOTION_STATE_FILENAME,
    load_motion_state,
    store_motion_state,
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


def _path_is_partial(path: Path) -> bool:
    """Return True when the file carries the `.partial` sentinel suffix."""

    try:
        suffixes = path.suffixes
    except AttributeError:
        return False
    return any(suffix.lower() == ".partial" for suffix in suffixes)


def _resolve_start_metadata(
    relative_path: Path | str | None,
    file_path: Path | None,
    stat_result: os.stat_result | None,
    waveform_meta: dict[str, object] | None,
) -> tuple[float | None, str]:
    """Derive start timestamps from available metadata."""

    start_epoch_value: float | None = None
    started_at_value = ""

    def _assign_start_from_epoch(raw_epoch: object) -> bool:
        nonlocal start_epoch_value, started_at_value
        if not isinstance(raw_epoch, (int, float)):
            return False
        epoch = float(raw_epoch)
        if not math.isfinite(epoch):
            return False
        start_epoch_value = epoch
        try:
            started_at_value = datetime.fromtimestamp(
                epoch, tz=timezone.utc
            ).isoformat()
        except (OverflowError, OSError, ValueError):
            started_at_value = ""
        return True

    def _assign_start_from_iso(raw_value: object) -> bool:
        nonlocal start_epoch_value, started_at_value
        if not isinstance(raw_value, str):
            return False
        candidate = raw_value.strip()
        if not candidate:
            return False
        try:
            if candidate.endswith("Z"):
                candidate = f"{candidate[:-1]}+00:00"
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            return False
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed_utc = parsed.astimezone(timezone.utc)
        start_epoch_value = parsed_utc.timestamp()
        started_at_value = parsed_utc.isoformat()
        return True

    if waveform_meta:
        if not _assign_start_from_epoch(waveform_meta.get("start_epoch")):
            _assign_start_from_epoch(waveform_meta.get("started_epoch"))
        if start_epoch_value is None:
            _assign_start_from_iso(waveform_meta.get("started_at"))

    if start_epoch_value is None:
        if isinstance(relative_path, str):
            rel_parts = Path(relative_path).parts
        elif isinstance(relative_path, Path):
            rel_parts = relative_path.parts
        else:
            rel_parts = ()

        day_component = rel_parts[0] if rel_parts else ""
        time_component = ""
        if len(rel_parts) > 1:
            time_component = Path(rel_parts[1]).stem.split("_", 1)[0]
        elif isinstance(file_path, Path):
            time_component = file_path.stem.split("_", 1)[0]

        if day_component and time_component:
            try:
                struct_time = time.strptime(
                    f"{day_component} {time_component}", "%Y%m%d %H-%M-%S"
                )
            except ValueError:
                struct_time = None
            if struct_time is not None:
                _assign_start_from_epoch(time.mktime(struct_time))

    if start_epoch_value is None and stat_result is not None:
        _assign_start_from_epoch(getattr(stat_result, "st_mtime", None))

    if not started_at_value and start_epoch_value is not None:
        try:
            started_at_value = datetime.fromtimestamp(
                start_epoch_value, tz=timezone.utc
            ).isoformat()
        except (OverflowError, OSError, ValueError):
            started_at_value = ""

    return start_epoch_value, started_at_value


def _scan_recordings_worker(
    recordings_root: Path,
    allowed_ext: tuple[str, ...],
    *,
    skip_top_level: Sequence[str] | None = None,
    path_prefix: Sequence[str] | None = None,
    collection_label: str = "recent",
) -> tuple[list[dict[str, object]], list[str], list[str], int]:
    log = logging.getLogger("web_streamer")

    def _float_or_none(value: object) -> float | None:
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return float(value)
        return None

    skip_set = {
        str(name).strip()
        for name in (skip_top_level or [])
        if isinstance(name, str) and str(name).strip()
    }
    prefix_parts = tuple(
        str(component).strip().strip("/\\")
        for component in (path_prefix or [])
        if isinstance(component, str) and str(component).strip().strip("/\\")
    )

    def _with_prefix(relative_path: Path) -> Path:
        if prefix_parts:
            return Path(*prefix_parts, *relative_path.parts)
        return relative_path

    def _iter_candidate_files() -> Iterable[Path]:
        def _on_error(error: OSError) -> None:
            location = getattr(error, "filename", None) or recordings_root
            log.warning(
                "recordings scan: unable to access %s (%s)",
                location,
                error,
            )

        for dirpath, dirnames, filenames in os.walk(
            recordings_root, onerror=_on_error
        ):
            dir_path = Path(dirpath)
            if RECYCLE_BIN_DIRNAME in dir_path.parts:
                continue
            if RAW_AUDIO_DIRNAME in dir_path.parts:
                continue

            try:
                rel_dir = dir_path.relative_to(recordings_root)
            except ValueError:
                rel_dir = None

            if rel_dir and rel_dir.parts and rel_dir.parts[0] in skip_set:
                dirnames[:] = []
                continue

            exclude_names = {RECYCLE_BIN_DIRNAME, RAW_AUDIO_DIRNAME}

            if dir_path == recordings_root:
                dirnames[:] = [
                    name
                    for name in dirnames
                    if name not in exclude_names and name not in skip_set
                ]
            else:
                dirnames[:] = [
                    name for name in dirnames if name not in exclude_names
                ]

            for filename in filenames:
                yield dir_path / filename

    def _index_raw_audio_files() -> dict[tuple[str, str], Path]:
        index: dict[tuple[str, str], Path] = {}
        raw_root = recordings_root / RAW_AUDIO_DIRNAME
        try:
            day_entries = list(raw_root.iterdir())
        except FileNotFoundError:
            return index
        except OSError as error:
            log.warning(
                "recordings scan: unable to enumerate raw audio root %s (%s)",
                raw_root,
                error,
            )
            return index

        for day_entry in day_entries:
            if not day_entry.is_dir():
                continue
            day_name = day_entry.name
            try:
                candidates = list(day_entry.iterdir())
            except OSError as error:
                log.warning(
                    "recordings scan: unable to index raw audio in %s (%s)",
                    day_entry,
                    error,
                )
                continue
            for candidate in candidates:
                try:
                    if not candidate.is_file():
                        continue
                except OSError:
                    continue
                if candidate.suffix.lower() not in RAW_AUDIO_SUFFIXES:
                    continue
                stem = candidate.stem
                if not stem:
                    continue
                rel_candidate = Path(RAW_AUDIO_DIRNAME, day_name, candidate.name)
                index[(day_name, stem)] = rel_candidate
        return index

    entries: list[dict[str, object]] = []
    day_set: set[str] = set()
    ext_set: set[str] = set()
    total_bytes = 0
    if not recordings_root.exists():
        return entries, [], [], 0

    raw_audio_index = _index_raw_audio_files()

    for path in _iter_candidate_files():
        try:
            if not path.is_file():
                continue
        except OSError as error:
            log.warning(
                "recordings scan: unable to stat candidate %s (%s)",
                path,
                error,
            )
            continue
        if _path_is_partial(path):
            continue
        suffix = path.suffix.lower()
        if allowed_ext and suffix not in allowed_ext:
            continue
        waveform_path = path.with_suffix(path.suffix + ".waveform.json")
        transcript_path = path.with_suffix(path.suffix + ".transcript.json")
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

        if rel.parts and rel.parts[0] in skip_set:
            continue

        rel_with_prefix = _with_prefix(rel)
        waveform_with_prefix = _with_prefix(waveform_rel)

        transcript_path_rel = ""
        transcript_text = ""
        transcript_event_type = ""
        transcript_updated: float | None = None
        transcript_updated_iso = ""
        try:
            transcript_stat = transcript_path.stat()
        except FileNotFoundError:
            transcript_stat = None
        except OSError:
            transcript_stat = None
        if transcript_stat and transcript_stat.st_size > 0:
            try:
                transcript_local = transcript_path.relative_to(recordings_root)
                transcript_path_rel = _with_prefix(transcript_local).as_posix()
            except ValueError:
                transcript_path_rel = ""
            try:
                with transcript_path.open("r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                    if isinstance(payload, dict):
                        raw_text = payload.get("text")
                        if isinstance(raw_text, str):
                            transcript_text = raw_text.strip()
                        raw_type = payload.get("event_type")
                        if isinstance(raw_type, str):
                            transcript_event_type = raw_type.strip()
            except (OSError, json.JSONDecodeError):
                transcript_path_rel = ""
                transcript_text = ""
                transcript_event_type = ""
            else:
                transcript_updated = float(transcript_stat.st_mtime)
                transcript_updated_iso = datetime.fromtimestamp(
                    transcript_stat.st_mtime, tz=timezone.utc
                ).isoformat()

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

        raw_audio_rel = ""
        if waveform_meta is not None:
            raw_candidate = waveform_meta.get("raw_audio_path")
            if isinstance(raw_candidate, str):
                raw_audio_rel = raw_candidate.strip()
                if raw_audio_rel and not _is_safe_relative_path(raw_audio_rel):
                    raw_audio_rel = ""

        day_component = ""
        if len(rel.parts) > 1:
            first_part = rel.parts[0]
            if (
                first_part == SAVED_RECORDINGS_DIRNAME
                and len(rel.parts) > 2
                and rel.parts[1]
            ):
                day_component = rel.parts[1]
            else:
                day_component = first_part

        if (
            not raw_audio_rel
            and day_component
            and len(day_component) == 8
            and day_component.isdigit()
        ):
            fallback = raw_audio_index.get((day_component, path.stem))
            if fallback is not None:
                raw_audio_rel = fallback.as_posix()

        trigger_offset = _float_or_none(
            waveform_meta.get("trigger_offset_seconds") if waveform_meta else None
        )
        release_offset = _float_or_none(
            waveform_meta.get("release_offset_seconds") if waveform_meta else None
        )
        motion_trigger_offset = _float_or_none(
            waveform_meta.get("motion_trigger_offset_seconds") if waveform_meta else None
        )
        motion_release_offset = _float_or_none(
            waveform_meta.get("motion_release_offset_seconds") if waveform_meta else None
        )
        motion_started_epoch = _float_or_none(
            waveform_meta.get("motion_started_epoch") if waveform_meta else None
        )
        motion_released_epoch = _float_or_none(
            waveform_meta.get("motion_released_epoch") if waveform_meta else None
        )

        manual_event_flag = False
        detected_rms_flag = False
        detected_vad_flag = False
        trigger_source_list: list[str] = []
        end_reason_value = ""
        if waveform_meta is not None:
            manual_event_flag = bool(waveform_meta.get("manual_event"))
            detected_rms_flag = bool(waveform_meta.get("detected_rms"))
            detected_vad_flag = bool(
                waveform_meta.get("detected_vad")
                or waveform_meta.get("detected_bad")
            )
            raw_end_reason = waveform_meta.get("end_reason")
            if isinstance(raw_end_reason, str):
                end_reason_value = raw_end_reason.strip()
            raw_triggers = waveform_meta.get("trigger_sources")
            if isinstance(raw_triggers, list):
                seen_triggers: set[str] = set()
                for entry in raw_triggers:
                    if isinstance(entry, str):
                        normalized = entry.strip().lower()
                        if normalized == "bad":
                            normalized = "vad"
                        if normalized and normalized not in seen_triggers:
                            seen_triggers.add(normalized)
                            trigger_source_list.append(normalized)

        rel_posix = rel_with_prefix.as_posix()
        day = rel.parts[0] if len(rel.parts) > 1 else ""

        start_epoch, started_at_iso = _resolve_start_metadata(
            rel, path, stat, waveform_meta
        )

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
                "waveform_path": waveform_with_prefix.as_posix(),
                "start_epoch": start_epoch,
                "started_epoch": start_epoch,
                "started_at": started_at_iso,
                "raw_audio_path": raw_audio_rel,
                "has_transcript": bool(transcript_path_rel),
                "transcript_path": transcript_path_rel,
                "transcript_text": transcript_text,
                "transcript_event_type": transcript_event_type,
                "transcript_updated": transcript_updated,
                "transcript_updated_iso": transcript_updated_iso,
                "trigger_offset_seconds": trigger_offset,
                "release_offset_seconds": release_offset,
                "motion_trigger_offset_seconds": motion_trigger_offset,
                "motion_release_offset_seconds": motion_release_offset,
                "motion_started_epoch": motion_started_epoch,
                "motion_released_epoch": motion_released_epoch,
                "motion_segments": _normalize_motion_segments(
                    waveform_meta.get("motion_segments") if waveform_meta else None
                ),
                "manual_event": manual_event_flag,
                "trigger_sources": trigger_source_list,
                "detected_rms": detected_rms_flag,
                "detected_vad": detected_vad_flag,
                "end_reason": end_reason_value,
                "collection": collection_label,
            }
        )

    entries.sort(key=lambda item: item["modified"], reverse=True)
    days_sorted = sorted(day_set, reverse=True)
    exts_sorted = sorted(ext.lstrip(".") for ext in ext_set)
    return entries, days_sorted, exts_sorted, total_bytes


def _is_safe_relative_path(value: str) -> bool:
    if not value:
        return False
    if value.startswith(("/", "\\")):
        return False
    try:
        parts = Path(value).parts
    except Exception:
        return False
    return ".." not in parts


def _normalize_motion_segments(
    value: object,
) -> list[dict[str, float | None]]:
    if not isinstance(value, list):
        return []
    segments: list[dict[str, float | None]] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        start_raw = entry.get("start")
        if not isinstance(start_raw, (int, float)) or not math.isfinite(float(start_raw)):
            continue
        start_value = max(0.0, float(start_raw))
        end_value = None
        end_raw = entry.get("end")
        if isinstance(end_raw, (int, float)) and math.isfinite(float(end_raw)):
            end_value = max(start_value, float(end_raw))
        segments.append({"start": start_value, "end": end_value})
    return segments


def _normalize_trigger_sources(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for entry in value:
        if not isinstance(entry, str):
            continue
        token = entry.strip().lower()
        if token == "bad":
            token = "vad"
        if not token or token in seen:
            continue
        seen.add(token)
        normalized.append(token)
    return normalized


def _generate_recycle_entry_id(now: datetime | None = None) -> str:
    timestamp = datetime.now(timezone.utc) if now is None else now
    suffix = secrets.token_hex(4)
    return f"{timestamp.strftime('%Y%m%dT%H%M%S')}-{suffix}"


def _read_recycle_entry(entry_dir: Path) -> dict[str, object] | None:
    if not entry_dir.is_dir():
        return None
    metadata_path = entry_dir / RECYCLE_METADATA_FILENAME
    try:
        with metadata_path.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(metadata, dict):
        return None

    entry_id = metadata.get("id")
    if not isinstance(entry_id, str) or not entry_id or not RECYCLE_ID_PATTERN.match(entry_id):
        return None

    stored_name = metadata.get("stored_name")
    if not isinstance(stored_name, str) or not stored_name:
        return None

    audio_path = entry_dir / stored_name
    if not audio_path.is_file():
        return None

    original_path = metadata.get("original_path")
    if isinstance(original_path, str) and original_path:
        original_rel = original_path
    else:
        original_rel = stored_name

    day_component = ""
    if original_rel:
        day_candidate = str(original_rel).split("/", 1)[0]
        if day_candidate and day_candidate.isdigit() and len(day_candidate) == 8:
            day_component = day_candidate

    deleted_iso = metadata.get("deleted_at")
    if not isinstance(deleted_iso, str):
        deleted_iso = ""

    deleted_epoch_raw = metadata.get("deleted_at_epoch")
    deleted_epoch: float | None
    if isinstance(deleted_epoch_raw, (int, float)):
        deleted_epoch = float(deleted_epoch_raw)
    else:
        deleted_epoch = None

    try:
        size_bytes = int(metadata.get("size_bytes", audio_path.stat().st_size))
    except OSError:
        size_bytes = int(metadata.get("size_bytes") or 0)

    duration_raw = metadata.get("duration_seconds")
    duration = float(duration_raw) if isinstance(duration_raw, (int, float)) else None

    motion_trigger_raw = metadata.get("motion_trigger_offset_seconds")
    if isinstance(motion_trigger_raw, (int, float)) and math.isfinite(
        float(motion_trigger_raw)
    ):
        motion_trigger_offset = float(motion_trigger_raw)
    else:
        motion_trigger_offset = None

    motion_release_raw = metadata.get("motion_release_offset_seconds")
    if isinstance(motion_release_raw, (int, float)) and math.isfinite(
        float(motion_release_raw)
    ):
        motion_release_offset = float(motion_release_raw)
    else:
        motion_release_offset = None

    motion_started_raw = metadata.get("motion_started_epoch")
    if isinstance(motion_started_raw, (int, float)) and math.isfinite(
        float(motion_started_raw)
    ):
        motion_started_epoch = float(motion_started_raw)
    else:
        motion_started_epoch = None

    motion_released_raw = metadata.get("motion_released_epoch")
    if isinstance(motion_released_raw, (int, float)) and math.isfinite(
        float(motion_released_raw)
    ):
        motion_released_epoch = float(motion_released_raw)
    else:
        motion_released_epoch = None

    motion_segments = _normalize_motion_segments(metadata.get("motion_segments"))

    waveform_name = metadata.get("waveform_name")
    if not isinstance(waveform_name, str):
        waveform_name = ""

    transcript_name = metadata.get("transcript_name")
    if not isinstance(transcript_name, str):
        transcript_name = ""

    start_epoch_raw = metadata.get("start_epoch")
    if not isinstance(start_epoch_raw, (int, float)):
        start_epoch_raw = metadata.get("started_epoch")
    if isinstance(start_epoch_raw, (int, float)) and math.isfinite(float(start_epoch_raw)):
        start_epoch = float(start_epoch_raw)
    else:
        start_epoch = None

    started_at = metadata.get("started_at")
    if isinstance(started_at, str):
        started_at_value = started_at
    else:
        started_at_value = ""

    if not started_at_value and start_epoch is not None:
        try:
            started_at_value = datetime.fromtimestamp(
                start_epoch, tz=timezone.utc
            ).isoformat()
        except (OverflowError, OSError, ValueError):
            started_at_value = ""

    raw_audio_name_raw = metadata.get("raw_audio_name")
    if isinstance(raw_audio_name_raw, str):
        raw_audio_name = raw_audio_name_raw.strip()
    else:
        raw_audio_name = ""
    if raw_audio_name and Path(raw_audio_name).name != raw_audio_name:
        raw_audio_name = ""

    raw_audio_path_raw = metadata.get("raw_audio_path")
    if isinstance(raw_audio_path_raw, str):
        raw_audio_path = raw_audio_path_raw.strip()
    else:
        raw_audio_path = ""
    if raw_audio_path and not _is_safe_relative_path(raw_audio_path):
        raw_audio_path = ""

    raw_audio_bin_path: Path | None = None
    if raw_audio_name:
        try:
            entry_dir_resolved = entry_dir.resolve()
            candidate = (entry_dir / raw_audio_name).resolve()
        except (OSError, RuntimeError):
            pass
        else:
            try:
                candidate.relative_to(entry_dir_resolved)
            except ValueError:
                pass
            else:
                if candidate.is_file():
                    raw_audio_bin_path = candidate

    reason_raw = metadata.get("reason")
    if isinstance(reason_raw, str):
        reason_value = reason_raw.strip()
    else:
        reason_value = ""

    return {
        "id": entry_id,
        "dir": entry_dir,
        "metadata_path": metadata_path,
        "metadata": metadata,
        "audio_path": audio_path,
        "stored_name": stored_name,
        "waveform_name": waveform_name,
        "transcript_name": transcript_name,
        "original_path": original_rel,
        "day": day_component,
        "deleted_at": deleted_iso,
        "deleted_at_epoch": deleted_epoch,
        "size_bytes": size_bytes,
        "duration": duration,
        "start_epoch": start_epoch,
        "started_epoch": start_epoch,
        "started_at": started_at_value,
        "raw_audio_name": raw_audio_name,
        "raw_audio_path": raw_audio_path,
        "raw_audio_bin_path": raw_audio_bin_path,
        "raw_audio_available": raw_audio_bin_path is not None,
        "reason": reason_value,
        "motion_trigger_offset_seconds": motion_trigger_offset,
        "motion_release_offset_seconds": motion_release_offset,
        "motion_started_epoch": motion_started_epoch,
        "motion_released_epoch": motion_released_epoch,
        "motion_segments": motion_segments,
    }


def _calculate_directory_usage(
    root: Path,
    *,
    skip_top_level: Collection[str] | None = None,
) -> int:
    total = 0

    log = logging.getLogger("web_streamer")

    try:
        if not root.exists():
            return 0
    except OSError as error:
        log.warning("storage usage: unable to access %s (%s)", root, error)
        return 0

    try:
        with os.scandir(root):
            pass
    except FileNotFoundError:
        return 0
    except NotADirectoryError as error:
        log.warning("storage usage: %s is not a directory (%s)", root, error)
        return 0
    except OSError as error:
        errno_value = getattr(error, "errno", None)
        if errno_value == errno.ENOENT:
            return 0
        log.warning("storage usage: unable to access %s (%s)", root, error)
        return 0

    skip = {
        str(name).strip()
        for name in (skip_top_level or [])
        if isinstance(name, str) and str(name).strip()
    }

    def _on_error(error: OSError) -> None:
        location = Path(getattr(error, "filename", None) or root)
        errno_value = getattr(error, "errno", None)
        if isinstance(error, FileNotFoundError) or errno_value in {errno.ENOENT, errno.ENOTDIR}:
            log.debug("storage usage: %s disappeared before it could be scanned (%s)", location, error)
            return
        log.warning("storage usage: unable to access %s (%s)", location, error)

    for dirpath, dirnames, filenames in os.walk(root, onerror=_on_error):
        dir_path = Path(dirpath)
        try:
            rel_parts = dir_path.relative_to(root).parts
        except ValueError:
            rel_parts = ()

        if rel_parts and rel_parts[0] in skip:
            dirnames[:] = []
            continue

        dirnames[:] = [name for name in dirnames if name not in skip]

        for filename in filenames:
            candidate = dir_path / filename
            try:
                total += max(int(candidate.stat().st_size), 0)
            except FileNotFoundError as error:
                log.debug(
                    "storage usage: %s disappeared before stat (%s)",
                    candidate,
                    error,
                )
                continue
            except OSError as error:
                errno_value = getattr(error, "errno", None)
                if errno_value == errno.ENOENT:
                    log.debug(
                        "storage usage: %s disappeared before stat (%s)",
                        candidate,
                        error,
                    )
                    continue
                log.warning(
                    "storage usage: unable to stat %s (%s)",
                    candidate,
                    error,
                )
                continue

    return max(total, 0)


def _calculate_recycle_bin_usage(recycle_root: Path) -> int:
    return _calculate_directory_usage(recycle_root)

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
SAVED_RECORDINGS_ROOT_KEY: AppKey[Path] = web.AppKey("saved_recordings_root", Path)
RECYCLE_BIN_ROOT_KEY: AppKey[Path] = web.AppKey("recycle_bin_root", Path)
ALLOWED_EXT_KEY: AppKey[tuple[str, ...]] = web.AppKey("recordings_allowed_ext", tuple)
SERVICE_ENTRIES_KEY: AppKey[list[dict[str, str]]] = web.AppKey("dashboard_services", list)
AUTO_RESTART_KEY: AppKey[set[str]] = web.AppKey("dashboard_auto_restart", set)
AUTO_RESTART_STATE_KEY: AppKey[dict[str, float]] = web.AppKey(
    "dashboard_auto_restart_state", dict
)
STREAM_MODE_KEY: AppKey[str] = web.AppKey("stream_mode", str)
WEBRTC_MANAGER_KEY: AppKey[Any] = web.AppKey("webrtc_manager", object)
LETS_ENCRYPT_MANAGER_KEY: AppKey[Any] = web.AppKey("lets_encrypt_manager", object)
EVENT_BUS_KEY: AppKey[dashboard_events.DashboardEventBus] = web.AppKey(
    "dashboard_event_bus", dashboard_events.DashboardEventBus
)
CAPTURE_STATUS_BRIDGE_KEY: AppKey[CaptureStatusEventBridge] = web.AppKey(
    "capture_status_event_bridge", CaptureStatusEventBridge
)
RECORDINGS_EVENT_BRIDGE_KEY: AppKey[RecordingsEventBridge] = web.AppKey(
    "recordings_event_bridge", RecordingsEventBridge
)
SSL_CONTEXT_KEY: AppKey[ssl.SSLContext] = web.AppKey("ssl_context", ssl.SSLContext)
LETS_ENCRYPT_TASK_KEY: AppKey[asyncio.Task | None] = web.AppKey(
    "lets_encrypt_task", asyncio.Task
)
CLIP_EXECUTOR_KEY: AppKey[ThreadPoolExecutor] = web.AppKey(
    "clip_executor",
    ThreadPoolExecutor,
)

_TIMEZONE_ABBREVIATION_OFFSETS: dict[str, int] = {
    "UTC": 0,
    "UT": 0,
    "GMT": 0,
    "Z": 0,
    "CET": 3600,
    "CEST": 2 * 3600,
    "BST": 3600,
    "WET": 0,
    "WEST": 3600,
    "EET": 2 * 3600,
    "EEST": 3 * 3600,
    "MSK": 3 * 3600,
    "SAMT": 4 * 3600,
    "IST": 5 * 3600 + 1800,
    "CST": -6 * 3600,
    "CDT": -5 * 3600,
    "EST": -5 * 3600,
    "EDT": -4 * 3600,
    "PST": -8 * 3600,
    "PDT": -7 * 3600,
    "MST": -7 * 3600,
    "MDT": -6 * 3600,
    "AKST": -9 * 3600,
    "AKDT": -8 * 3600,
    "HST": -10 * 3600,
    "KST": 9 * 3600,
    "JST": 9 * 3600,
    "AEST": 10 * 3600,
    "AEDT": 11 * 3600,
    "ACST": 9 * 3600 + 1800,
    "ACDT": 10 * 3600 + 1800,
    "AWST": 8 * 3600,
    "NZST": 12 * 3600,
    "NZDT": 13 * 3600,
}

_TZ_OFFSET_PATTERN = re.compile(r"^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$")


def _resolve_timezone_token(token: str) -> timezone | None:
    token = (token or "").strip()
    if not token:
        return None

    upper = token.upper()
    if upper in {"UTC", "UT", "GMT", "Z"}:
        return timezone.utc

    try:
        return ZoneInfo(token)
    except Exception:
        pass

    offset_seconds: int | None = None
    match = _TZ_OFFSET_PATTERN.match(token)
    if match:
        sign, hours_str, minutes_str = match.groups()
        hours = int(hours_str)
        minutes = int(minutes_str) if minutes_str else 0
        offset_seconds = hours * 3600 + minutes * 60
        if sign == "-":
            offset_seconds = -offset_seconds
    elif upper in _TIMEZONE_ABBREVIATION_OFFSETS:
        offset_seconds = _TIMEZONE_ABBREVIATION_OFFSETS[upper]
    else:
        try:
            if token in time.tzname:
                if time.daylight and token == time.tzname[1]:
                    offset_seconds = -time.altzone
                else:
                    offset_seconds = -time.timezone
        except Exception:
            offset_seconds = None

    if offset_seconds is None:
        return None

    return timezone(timedelta(seconds=offset_seconds))


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
    "ActiveEnterTimestamp",
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


def _parse_systemd_timestamp(raw: str | None) -> float | None:
    value = str(raw or "").strip()
    if not value or value.lower() in {"n/a", "0"}:
        return None

    parts = value.split()
    candidates = [value]
    if len(parts) > 1:
        candidates.append(" ".join(parts[1:]))
    tz_token = parts[-1] if len(parts) > 1 else ""

    formats = (
        "%a %Y-%m-%d %H:%M:%S %z",
        "%a %Y-%m-%d %H:%M:%S %Z",
        "%Y-%m-%d %H:%M:%S %z",
        "%Y-%m-%d %H:%M:%S %Z",
    )

    for candidate in candidates:
        for fmt in formats:
            try:
                parsed = datetime.strptime(candidate, fmt)
            except ValueError:
                continue

            tzinfo = parsed.tzinfo
            if tzinfo is None:
                tzinfo = _resolve_timezone_token(tz_token) or timezone.utc
                parsed = parsed.replace(tzinfo=tzinfo)

            try:
                return parsed.timestamp()
            except (OverflowError, OSError):  # pragma: no cover - platform dependent
                return None

    # Fallback: attempt to parse without any timezone data and assume UTC.
    fallback_candidates: list[str] = []
    if tz_token:
        without_tz = " ".join(parts[:-1])
        if without_tz:
            fallback_candidates.append(without_tz)
        if len(parts) > 2:
            fallback_candidates.append(" ".join(parts[1:-1]))
    else:
        fallback_candidates.extend(candidates)

    fallback_formats = ("%a %Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S")
    for candidate in fallback_candidates:
        if not candidate:
            continue
        for fmt in fallback_formats:
            try:
                parsed = datetime.strptime(candidate, fmt)
            except ValueError:
                continue
            tzinfo = _resolve_timezone_token(tz_token) or timezone.utc
            return parsed.replace(tzinfo=tzinfo).timestamp()

    return None


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
            "active_enter_timestamp": "",
            "active_enter_epoch": None,
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
    active_enter_epoch = _parse_systemd_timestamp(data.get("ActiveEnterTimestamp"))
    if active_enter_epoch is not None:
        active_enter_timestamp = datetime.fromtimestamp(
            active_enter_epoch, tz=timezone.utc
        ).isoformat()
    else:
        active_enter_timestamp = ""
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
        "active_enter_timestamp": active_enter_timestamp,
        "active_enter_epoch": active_enter_epoch,
    }


AUTO_RESTART_THROTTLE_SECONDS = 10.0
_AUTO_RESTART_STATE: dict[str, float] = {}


def _ensure_auto_restart(
    unit: str,
    *,
    state: dict[str, float] | None = None,
    delay: float = 0.5,
) -> bool:
    mapping = state if state is not None else _AUTO_RESTART_STATE
    now = time.monotonic()
    last_attempt = mapping.get(unit)
    if last_attempt is not None and now - last_attempt < AUTO_RESTART_THROTTLE_SECONDS:
        return True
    mapping[unit] = now
    _enqueue_service_actions(unit, ["start"], delay=delay)
    return True


async def _collect_service_state(
    entry: dict[str, str],
    auto_restart_units: set[str],
    *,
    auto_restart_state: dict[str, float] | None = None,
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

    auto_restart_pending = False
    unit_name = entry["unit"]
    if (
        unit_name in auto_restart_units
        and status.get("available", False)
        and not status.get("is_active", False)
    ):
        auto_restart_pending = _ensure_auto_restart(
            unit_name, state=auto_restart_state, delay=0.5
        )

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
            "auto_restart_pending": auto_restart_pending,
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


def _kick_auto_restart_units(
    auto_restart_units: Iterable[str], *, skip: Iterable[str] = (), delay: float = 1.0
) -> None:
    skip_set = {str(item or "").strip() for item in skip}
    if not auto_restart_units:
        return

    for candidate in auto_restart_units:
        unit = str(candidate or "").strip()
        if not unit or unit in skip_set:
            continue
        _enqueue_service_actions(unit, ["start"], delay=delay)


def build_app(lets_encrypt_manager: LetsEncryptManager | None = None) -> web.Application:
    log = logging.getLogger("web_streamer")
    apply_config_migrations(logger=log)
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
    clip_executor = ThreadPoolExecutor(
        max_workers=CLIP_EXECUTOR_MAX_WORKERS,
        thread_name_prefix="web_streamer_clip",
    )
    app[CLIP_EXECUTOR_KEY] = clip_executor
    app[SHUTDOWN_EVENT_KEY] = asyncio.Event()
    if lets_encrypt_manager is not None:
        app[LETS_ENCRYPT_MANAGER_KEY] = lets_encrypt_manager

    try:
        initial_loop = asyncio.get_running_loop()
    except RuntimeError:
        initial_loop = None

    event_bus = dashboard_events.DashboardEventBus(
        loop=initial_loop,
        history_limit=EVENT_HISTORY_LIMIT,
    )
    dashboard_events.install_event_bus(event_bus)
    app[EVENT_BUS_KEY] = event_bus

    def _publish_dashboard_event(event_type: str, payload: dict[str, Any]) -> None:
        try:
            dashboard_events.publish(event_type, payload)
        except Exception:  # pragma: no cover - defensive logging
            logging.getLogger("web_streamer").debug(
                "Failed to publish dashboard event %s", event_type, exc_info=True
            )

    def _emit_config_updated(section: str) -> None:
        if not section:
            return
        _publish_dashboard_event(
            "config_updated",
            {"section": section, "updated_at": time.time()},
        )

    def _emit_recordings_changed(reason: str, **extra: Any) -> None:
        if not reason:
            return
        payload: dict[str, Any] = {"reason": reason, "updated_at": time.time()}
        if extra:
            payload.update(extra)
        _publish_dashboard_event("recordings_changed", payload)

    async def _init_event_bus(_: web.Application) -> None:
        event_bus.set_loop(asyncio.get_running_loop())

    async def _cleanup_event_bus(_: web.Application) -> None:
        dashboard_events.uninstall_event_bus(event_bus)

    app.on_startup.append(_init_event_bus)

    async def _start_health_broadcaster(_: web.Application) -> None:
        await health_broadcaster.start()

    async def _stop_health_broadcaster(_: web.Application) -> None:
        await health_broadcaster.stop()

    app.on_startup.append(_start_health_broadcaster)


    default_tmp = cfg.get("paths", {}).get("tmp_dir", "/apps/tricorder/tmp")
    tmp_root = os.environ.get("TRICORDER_TMP", default_tmp)

    try:
        os.makedirs(tmp_root, exist_ok=True)
    except OSError:
        pass

    streaming_cfg = cfg.get("streaming", {})
    stream_mode_raw = str(streaming_cfg.get("mode", "hls")).strip().lower()
    stream_mode = stream_mode_raw if stream_mode_raw in {"hls", "webrtc"} else "hls"
    webrtc_ice_servers: list[dict[str, object]] = []
    if stream_mode == "webrtc":
        webrtc_ice_servers = _normalize_webrtc_ice_servers(
            streaming_cfg.get("webrtc_ice_servers")
        )
    app[STREAM_MODE_KEY] = stream_mode

    hls_dir: str | None = None
    webrtc_manager: Any = None

    if stream_mode == "hls":
        hls_dir = os.path.join(tmp_root, "hls")
        os.makedirs(hls_dir, exist_ok=True)
        controller.set_state_path(os.path.join(hls_dir, "controller_state.json"), persist=True)
        controller.refresh_from_state()
    else:
        from lib.webrtc_stream import WebRTCManager

        webrtc_dir = os.path.join(tmp_root, "webrtc")
        os.makedirs(webrtc_dir, exist_ok=True)
        audio_cfg = cfg.get("audio", {})
        sample_rate = int(audio_cfg.get("sample_rate", 48000))
        frame_ms = int(audio_cfg.get("frame_ms", 20))
        frame_bytes = int(sample_rate * 2 * frame_ms / 1000)
        history_seconds = float(streaming_cfg.get("webrtc_history_seconds", 8.0))
        webrtc_manager = WebRTCManager(
            buffer_dir=webrtc_dir,
            sample_rate=sample_rate,
            frame_ms=frame_ms,
            frame_bytes=frame_bytes,
            history_seconds=history_seconds,
            ice_servers=webrtc_ice_servers,
        )
    app[WEBRTC_MANAGER_KEY] = webrtc_manager
    recordings_root = Path(cfg["paths"]["recordings_dir"])
    try:
        recordings_root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # pragma: no cover - permissions issues should not crash server
        log.warning("Unable to ensure recordings directory exists: %s", exc)
    app[RECORDINGS_ROOT_KEY] = recordings_root

    saved_recordings_root = recordings_root / SAVED_RECORDINGS_DIRNAME
    try:
        saved_recordings_root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # pragma: no cover - permissions issues should not crash server
        log.warning("Unable to ensure saved recordings directory exists: %s", exc)
    app[SAVED_RECORDINGS_ROOT_KEY] = saved_recordings_root

    recycle_bin_root = recordings_root / RECYCLE_BIN_DIRNAME
    app[RECYCLE_BIN_ROOT_KEY] = recycle_bin_root

    allowed_ext_cfg: Iterable[str] = cfg.get("ingest", {}).get("allowed_ext", [".opus"])
    allowed_ext = tuple(
        ext if ext.startswith(".") else f".{ext}"
        for ext in (s.lower() for s in allowed_ext_cfg)
    ) or (".opus",)
    app[ALLOWED_EXT_KEY] = allowed_ext

    service_entries, auto_restart_units = _normalize_dashboard_services(cfg)
    app[SERVICE_ENTRIES_KEY] = service_entries
    app[AUTO_RESTART_KEY] = auto_restart_units
    app[AUTO_RESTART_STATE_KEY] = {}

    try:
        recordings_root_resolved = recordings_root.resolve()
    except FileNotFoundError:
        recordings_root_resolved = recordings_root

    try:
        saved_recordings_root_resolved = saved_recordings_root.resolve()
    except FileNotFoundError:
        saved_recordings_root_resolved = saved_recordings_root

    clip_safe_pattern = re.compile(r"[^A-Za-z0-9._-]+")
    MIN_CLIP_DURATION_SECONDS = 0.05

    class ClipError(Exception):
        """Raised when an audio clip cannot be produced."""

    class ClipUndoError(Exception):
        """Raised when an undo request for a clip cannot be completed."""

        def __init__(self, message: str, *, status: int = 400):
            super().__init__(message)
            self.status = status

    clip_undo_root = Path(tmp_root) / "clip_undo"
    clip_undo_token_pattern = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
    CLIP_UNDO_MAX_AGE_SECONDS = 24 * 60 * 60

    def _cleanup_clip_undo_storage(now: float | None = None) -> None:
        if not clip_undo_root.exists():
            return
        current = time.time() if now is None else float(now)
        try:
            entries = list(clip_undo_root.iterdir())
        except OSError:
            return
        for entry in entries:
            if not entry.is_dir():
                continue
            meta_path = entry / "meta.json"
            try:
                with meta_path.open("r", encoding="utf-8") as handle:
                    metadata = json.load(handle)
                created_at = metadata.get("created_at")
                if not isinstance(created_at, (int, float)):
                    raise ValueError("missing created_at")
                if current - float(created_at) <= CLIP_UNDO_MAX_AGE_SECONDS:
                    continue
            except Exception:
                pass
            shutil.rmtree(entry, ignore_errors=True)

    def _collect_clip_undo_tokens() -> dict[str, str]:
        _cleanup_clip_undo_storage()
        if not clip_undo_root.exists():
            return {}

        tokens: dict[str, tuple[float, str]] = {}
        try:
            entries = list(clip_undo_root.iterdir())
        except OSError:
            return {}

        for entry in entries:
            if not entry.is_dir():
                continue

            token = entry.name
            if not clip_undo_token_pattern.match(token):
                continue

            meta_path = entry / "meta.json"
            try:
                with meta_path.open("r", encoding="utf-8") as handle:
                    metadata = json.load(handle)
            except (OSError, json.JSONDecodeError):
                continue

            rel_path = metadata.get("path")
            created_at = metadata.get("created_at")
            if not isinstance(rel_path, str) or not rel_path:
                continue
            if not _is_safe_relative_path(rel_path):
                continue

            created = float(created_at) if isinstance(created_at, (int, float)) else 0.0
            previous = tokens.get(rel_path)
            if previous is None or created >= previous[0]:
                tokens[rel_path] = (created, token)

        return {path: token for path, (_, token) in tokens.items()}

    def _allows_opus_stream_copy(source: Path) -> bool:
        if source.suffix.lower() == ".opus":
            return True

        probe_cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(source),
        ]

        try:
            result = subprocess.run(
                probe_cmd,
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            return False
        except subprocess.SubprocessError:
            return False

        codec_name = (result.stdout or "").strip().lower()
        return codec_name == "opus"

    def _prepare_clip_backup(
        final_path: Path, final_waveform: Path, rel_path: Path
    ) -> str:
        try:
            clip_undo_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ClipError("unable to prepare undo storage") from exc

        attempts = 0
        while attempts < 8:
            attempts += 1
            token = secrets.token_urlsafe(24)
            backup_dir = clip_undo_root / token
            try:
                backup_dir.mkdir(mode=0o700)
            except FileExistsError:
                continue
            except OSError as exc:
                raise ClipError("unable to prepare undo storage") from exc
            try:
                audio_backup = backup_dir / final_path.name
                shutil.copy2(final_path, audio_backup)
                waveform_filename = None
                if final_waveform.exists():
                    waveform_backup = backup_dir / final_waveform.name
                    shutil.copy2(final_waveform, waveform_backup)
                    waveform_filename = final_waveform.name
                metadata = {
                    "path": rel_path.as_posix(),
                    "filename": final_path.name,
                    "waveform_filename": waveform_filename,
                    "created_at": time.time(),
                }
                with (backup_dir / "meta.json").open("w", encoding="utf-8") as handle:
                    json.dump(metadata, handle)
            except Exception as exc:
                shutil.rmtree(backup_dir, ignore_errors=True)
                raise ClipError("unable to prepare undo storage") from exc
            else:
                return token
        raise ClipError("unable to prepare undo storage")

    def _restore_clip_backup(token: str) -> dict[str, object]:
        token = token.strip()
        if not clip_undo_token_pattern.match(token):
            raise ClipUndoError("Invalid undo token.")

        backup_dir = clip_undo_root / token
        if not backup_dir.is_dir():
            raise ClipUndoError("Undo history expired.", status=404)

        meta_path = backup_dir / "meta.json"
        try:
            with meta_path.open("r", encoding="utf-8") as handle:
                metadata = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            shutil.rmtree(backup_dir, ignore_errors=True)
            raise ClipUndoError("Undo history unavailable.", status=404) from exc

        rel_text = metadata.get("path")
        filename = metadata.get("filename")
        waveform_filename = metadata.get("waveform_filename")
        if not isinstance(rel_text, str) or not rel_text:
            shutil.rmtree(backup_dir, ignore_errors=True)
            raise ClipUndoError("Undo metadata invalid.", status=404)
        if not isinstance(filename, str) or not filename:
            shutil.rmtree(backup_dir, ignore_errors=True)
            raise ClipUndoError("Undo metadata invalid.", status=404)

        rel_path = Path(rel_text)
        target_path = recordings_root / rel_path
        try:
            resolved_target = target_path.resolve()
        except FileNotFoundError:
            resolved_target = target_path

        try:
            resolved_target.relative_to(recordings_root_resolved)
        except ValueError as exc:
            shutil.rmtree(backup_dir, ignore_errors=True)
            raise ClipUndoError("Undo target is invalid.", status=404) from exc

        audio_backup = backup_dir / filename
        if not audio_backup.is_file():
            shutil.rmtree(backup_dir, ignore_errors=True)
            raise ClipUndoError("Undo history unavailable.", status=404)

        waveform_backup: Path | None = None
        if isinstance(waveform_filename, str) and waveform_filename:
            candidate = backup_dir / waveform_filename
            if candidate.is_file():
                waveform_backup = candidate

        temp_audio_path: Path | None = None
        temp_waveform_path: Path | None = None
        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            temp_audio_fd, temp_audio_name = tempfile.mkstemp(
                dir=resolved_target.parent,
                prefix=f".undo-{resolved_target.stem}-",
                suffix=resolved_target.suffix or ".tmp",
            )
            os.close(temp_audio_fd)
            temp_audio_path = Path(temp_audio_name)
            shutil.copy2(audio_backup, temp_audio_path)
            os.replace(temp_audio_path, resolved_target)
            temp_audio_path = None

            target_waveform = resolved_target.with_suffix(
                resolved_target.suffix + ".waveform.json"
            )
            if waveform_backup is not None:
                temp_wave_fd, temp_wave_name = tempfile.mkstemp(
                    dir=target_waveform.parent,
                    prefix=f".undo-{target_waveform.stem}-",
                    suffix=target_waveform.suffix or ".tmp",
                )
                os.close(temp_wave_fd)
                temp_waveform_path = Path(temp_wave_name)
                shutil.copy2(waveform_backup, temp_waveform_path)
                os.replace(temp_waveform_path, target_waveform)
                temp_waveform_path = None
            else:
                try:
                    target_waveform.unlink()
                except FileNotFoundError:
                    pass
        except Exception as exc:
            raise ClipUndoError("Unable to restore clip from history.") from exc
        else:
            shutil.rmtree(backup_dir, ignore_errors=True)
        finally:
            if temp_audio_path is not None:
                try:
                    temp_audio_path.unlink()
                except FileNotFoundError:
                    pass
            if temp_waveform_path is not None:
                try:
                    temp_waveform_path.unlink()
                except FileNotFoundError:
                    pass

        try:
            rel_verified = resolved_target.relative_to(recordings_root_resolved)
        except ValueError:
            rel_verified = resolved_target.relative_to(recordings_root)

        rel_posix = rel_verified.as_posix()
        day = rel_verified.parts[0] if rel_verified.parts else ""

        try:
            stat = resolved_target.stat()
        except OSError as exc:
            raise ClipUndoError("Restored clip is unavailable.") from exc

        waveform_meta: dict[str, object] | None = None
        try:
            with resolved_target.with_suffix(
                resolved_target.suffix + ".waveform.json"
            ).open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
                if isinstance(payload, dict):
                    waveform_meta = payload
        except FileNotFoundError:
            waveform_meta = None
        except (OSError, json.JSONDecodeError):
            waveform_meta = None

        duration = None
        if waveform_meta is not None:
            raw_duration = waveform_meta.get("duration_seconds")
            if isinstance(raw_duration, (int, float)) and raw_duration > 0:
                duration = float(raw_duration)
        if duration is None:
            duration = _probe_duration(resolved_target, stat)
        clip_start_epoch = None
        if waveform_meta is not None:
            start_value = waveform_meta.get("start_epoch")
            if isinstance(start_value, (int, float)) and start_value > 0:
                clip_start_epoch = float(start_value)
            elif isinstance(waveform_meta.get("started_epoch"), (int, float)):
                clip_start_epoch = float(waveform_meta["started_epoch"])
        if clip_start_epoch is None and hasattr(stat, "st_mtime"):
            clip_start_epoch = float(stat.st_mtime)

        payload: dict[str, object] = {
            "path": rel_posix,
            "name": resolved_target.stem,
            "duration_seconds": duration,
            "day": day,
        }
        if clip_start_epoch and clip_start_epoch > 0:
            payload["start_epoch"] = clip_start_epoch

        _cleanup_clip_undo_storage()

        return payload

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

    def _to_bool(value: object, default: bool = True) -> bool:
        if isinstance(value, bool):
            return value
        if value is None:
            return default
        if isinstance(value, str):
            text = value.strip().lower()
            if not text:
                return default
            if text in {"0", "false", "no", "off"}:
                return False
            if text in {"1", "true", "yes", "on"}:
                return True
            return default
        if isinstance(value, (int, float)):
            return value != 0
        return bool(value)

    def _create_clip_sync(
        source_rel_path: str,
        start_seconds: float,
        end_seconds: float,
        clip_name: str | None,
        source_start_epoch: float | None,
        allow_overwrite: bool = True,
        overwrite_existing_rel: str | None = None,
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

        final_path = target_dir / f"{base_name}.opus"
        final_waveform = final_path.with_suffix(final_path.suffix + ".waveform.json")
        final_path_partial = final_path.with_suffix(final_path.suffix + ".partial")
        final_waveform_partial = final_waveform.with_suffix(
            final_waveform.suffix + ".partial"
        )

        if final_path.exists() and not allow_overwrite:
            raise ClipError("clip already exists")

        overwrite_source: Path | None = None
        overwrite_stat: os.stat_result | None = None
        overwrite_waveform_meta: dict[str, object] | None = None
        overwrite_duration: float | None = None

        if isinstance(overwrite_existing_rel, str) and overwrite_existing_rel.strip():
            overwrite_candidate = recordings_root / overwrite_existing_rel.strip().strip("/")
            try:
                overwrite_resolved = overwrite_candidate.resolve()
            except FileNotFoundError:
                overwrite_resolved = None
            except Exception:
                overwrite_resolved = None
            if overwrite_resolved is not None:
                try:
                    overwrite_resolved.relative_to(recordings_root_resolved)
                except ValueError:
                    overwrite_resolved = None
            if overwrite_resolved is not None and overwrite_resolved.is_file():
                overwrite_source = overwrite_resolved
                try:
                    overwrite_stat = overwrite_resolved.stat()
                except OSError:
                    overwrite_stat = None
                waveform_candidate = overwrite_resolved.with_suffix(
                    overwrite_resolved.suffix + ".waveform.json"
                )
                try:
                    with waveform_candidate.open("r", encoding="utf-8") as handle:
                        payload = json.load(handle)
                        if isinstance(payload, dict):
                            overwrite_waveform_meta = payload
                except (OSError, json.JSONDecodeError):
                    overwrite_waveform_meta = None
                if overwrite_waveform_meta is not None:
                    raw_duration = overwrite_waveform_meta.get("duration_seconds")
                    if isinstance(raw_duration, (int, float)) and raw_duration > 0:
                        overwrite_duration = float(raw_duration)
                if overwrite_duration is None and overwrite_stat is not None:
                    overwrite_duration = _probe_duration(overwrite_resolved, overwrite_stat)

        rename_allowed = False
        if (
            overwrite_source is not None
            and overwrite_source == resolved
            and overwrite_source.suffix.lower() == ".opus"
            and final_path.suffix.lower() == ".opus"
            and not final_path.exists()
            and overwrite_duration is not None
        ):
            range_tolerance = max(0.05, float(overwrite_duration) * 0.01)
            start_near_zero = abs(float(start_seconds)) <= range_tolerance
            matches_duration = abs(duration - float(overwrite_duration)) <= range_tolerance
            if start_near_zero and matches_duration:
                rename_allowed = True

        if rename_allowed:
            try:
                final_path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise ClipError("unable to create destination directory") from exc

            source_waveform = overwrite_source.with_suffix(
                overwrite_source.suffix + ".waveform.json"
            )
            final_transcript = final_path.with_suffix(final_path.suffix + ".transcript.json")
            source_transcript = overwrite_source.with_suffix(
                overwrite_source.suffix + ".transcript.json"
            )

            try:
                os.replace(overwrite_source, final_path)
            except Exception as exc:
                raise ClipError("unable to move existing clip") from exc

            try:
                if source_waveform.exists():
                    os.replace(source_waveform, final_waveform)
            except Exception as exc:
                try:
                    os.replace(final_path, overwrite_source)
                except Exception:
                    pass
                raise ClipError("unable to move existing clip") from exc

            if source_transcript.exists():
                try:
                    os.replace(source_transcript, final_transcript)
                except Exception:
                    pass

            try:
                rel_path = final_path.relative_to(recordings_root_resolved)
            except ValueError:
                rel_path = final_path.relative_to(recordings_root)

            clip_start_epoch = None
            if overwrite_waveform_meta is not None:
                raw_start = overwrite_waveform_meta.get("start_epoch")
                if isinstance(raw_start, (int, float)) and raw_start > 0:
                    clip_start_epoch = float(raw_start)
                else:
                    raw_started = overwrite_waveform_meta.get("started_epoch")
                    if isinstance(raw_started, (int, float)) and raw_started > 0:
                        clip_start_epoch = float(raw_started)
            if clip_start_epoch is None:
                stat_source = overwrite_stat
                if stat_source is None:
                    try:
                        stat_source = final_path.stat()
                    except OSError:
                        stat_source = None
                if stat_source is not None and hasattr(stat_source, "st_mtime"):
                    clip_start_epoch = float(stat_source.st_mtime)

            rel_posix = rel_path.as_posix()
            day = rel_path.parts[0] if rel_path.parts else ""

            payload: dict[str, object] = {
                "path": rel_posix,
                "name": final_path.stem,
                "duration_seconds": float(overwrite_duration),
                "day": day,
            }
            if clip_start_epoch and clip_start_epoch > 0:
                payload["start_epoch"] = clip_start_epoch

            _cleanup_clip_undo_storage()
            return payload

        try:
            rel_path = final_path.relative_to(recordings_root_resolved)
        except ValueError:
            rel_path = final_path.relative_to(recordings_root)

        undo_token: str | None = None

        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ClipError("unable to create destination directory") from exc

        for stale_candidate in (final_path_partial, final_waveform_partial):
            try:
                if stale_candidate.exists():
                    if stale_candidate.is_file():
                        stale_candidate.unlink()
                    elif stale_candidate.is_dir():
                        shutil.rmtree(stale_candidate, ignore_errors=True)
            except OSError:
                pass

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

            # First decode the window to PCM for waveform generation. When the
            # source is already Opus we can stream copy the payload to avoid an
            # expensive re-encode. Other codecs must be re-encoded to keep the
            # `.opus` destination valid.
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

            stream_copy_allowed = _allows_opus_stream_copy(resolved)

            encode_cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
            ]

            if stream_copy_allowed:
                encode_cmd.extend(
                    [
                        "-ss",
                        start_offset,
                        "-i",
                        str(resolved),
                        "-t",
                        encode_duration,
                        "-c:a",
                        "copy",
                        "-avoid_negative_ts",
                        "make_zero",
                    ]
                )
            else:
                encode_cmd.extend(
                    [
                        "-i",
                        str(tmp_wav),
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
                    ]
                )

            encode_cmd.append(str(tmp_opus))

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

            if final_path.exists():
                undo_token = _prepare_clip_backup(final_path, final_waveform, rel_path)

            try:
                shutil.move(str(tmp_opus), str(final_path_partial))
                shutil.move(str(tmp_waveform), str(final_waveform_partial))
            except Exception as exc:
                raise ClipError("unable to store generated clip") from exc

            try:
                os.replace(final_path_partial, final_path)
            except Exception as exc:
                try:
                    if final_path_partial.exists():
                        final_path_partial.unlink()
                except OSError:
                    pass
                raise ClipError("unable to store generated clip") from exc

            try:
                os.replace(final_waveform_partial, final_waveform)
            except FileNotFoundError:
                pass
            except Exception as exc:
                try:
                    os.replace(final_path, final_path_partial)
                except Exception:
                    pass
                for cleanup_candidate in (final_path_partial, final_waveform_partial):
                    try:
                        if cleanup_candidate.exists():
                            cleanup_candidate.unlink()
                    except OSError:
                        pass
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
        if undo_token:
            payload["undo_token"] = undo_token

        _cleanup_clip_undo_storage()
        return payload

    if stream_mode == "hls":
        template_defaults = {
            "page_title": "Tricorder HLS Stream",
            "heading": "HLS Audio Stream",
        }
        playlist_ready_timeout = 5.0
        playlist_poll_interval = 0.1
    else:
        template_defaults = {
            "page_title": "Tricorder WebRTC Stream",
            "heading": "WebRTC Audio Stream",
        }
        playlist_ready_timeout = 0.0
        playlist_poll_interval = 0.0

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
            stream_mode=stream_mode,
            webrtc_ice_servers=webrtc_ice_servers,
        )
        return web.Response(text=html, content_type="text/html")

    async def hls_index(_: web.Request) -> web.Response:
        if stream_mode != "hls":
            raise web.HTTPNotFound()
        html = webui.render_template("hls_index.html", **template_defaults)
        return web.Response(text=html, content_type="text/html")

    def _scan_recordings_sync() -> tuple[list[dict[str, object]], list[str], list[str], int]:
        return _scan_recordings_worker(
            recordings_root,
            allowed_ext,
            skip_top_level=(SAVED_RECORDINGS_DIRNAME,),
            collection_label="recent",
        )

    def _scan_saved_recordings_sync() -> tuple[
        list[dict[str, object]], list[str], list[str], int
    ]:
        return _scan_recordings_worker(
            saved_recordings_root,
            allowed_ext,
            path_prefix=(SAVED_RECORDINGS_DIRNAME,),
            collection_label="saved",
        )

    async def _scan_recordings() -> tuple[list[dict[str, object]], list[str], list[str], int]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _scan_recordings_sync)

    async def _scan_saved_recordings() -> tuple[
        list[dict[str, object]], list[str], list[str], int
    ]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _scan_saved_recordings_sync)

    capture_status_path = os.path.join(
        cfg["paths"].get("tmp_dir", tmp_root), "segmenter_status.json"
    )
    manual_record_state_path = os.path.join(
        cfg["paths"].get("tmp_dir", tmp_root), "manual_record_state.json"
    )
    auto_record_state_path = os.path.join(
        cfg["paths"].get("tmp_dir", tmp_root), "auto_record_state.json"
    )
    manual_stop_request_path = os.path.join(
        cfg["paths"].get("tmp_dir", tmp_root), "manual_stop_request.json"
    )
    motion_state_path = os.path.join(
        cfg["paths"].get("tmp_dir", tmp_root), MOTION_STATE_FILENAME
    )
    auto_motion_override_default = bool(
        cfg.get("segmenter", {}).get("auto_record_motion_override", True)
    )

    def _normalize_partial_path(raw: object) -> tuple[str | None, str | None]:
        if not isinstance(raw, str) or not raw.strip():
            return None, None
        candidate = Path(raw.strip())
        try:
            resolved = candidate.resolve(strict=False)
        except (OSError, RuntimeError):
            resolved = candidate

        rel_candidate: Path | None = None
        base = recordings_root_resolved or recordings_root
        try:
            rel_candidate = resolved.relative_to(base)
        except ValueError:
            try:
                rel_candidate = candidate.relative_to(base)
            except ValueError:
                rel_candidate = None

        rel_path = rel_candidate.as_posix() if rel_candidate is not None else None
        return str(resolved), rel_path

    def _parse_motion_flag(raw: object) -> bool | None:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return bool(raw)
        if isinstance(raw, str):
            normalized = raw.strip().lower()
            if not normalized:
                return None
            if normalized in {"1", "true", "yes", "on", "running"}:
                return True
            if normalized in {"0", "false", "no", "off", "stopped"}:
                return False
        return None

    def _read_manual_record_flag() -> bool:
        try:
            with open(manual_record_state_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            return False
        except (json.JSONDecodeError, OSError):
            return False
        if isinstance(payload, dict):
            return bool(payload.get("enabled", False))
        if isinstance(payload, bool):
            return bool(payload)
        return False

    def _read_auto_record_flag() -> bool:
        try:
            with open(auto_record_state_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            return True
        except (json.JSONDecodeError, OSError):
            return True
        if isinstance(payload, dict):
            return bool(payload.get("enabled", True))
        if isinstance(payload, bool):
            return bool(payload)
        return True

    def _float_or_none(value: object) -> float | None:
        if isinstance(value, (int, float)) and math.isfinite(value):
            return float(value)
        if isinstance(value, str):
            try:
                parsed = float(value.strip())
            except (TypeError, ValueError):
                return None
            if math.isfinite(parsed):
                return parsed
        return None

    def _int_or_none(value: object) -> int | None:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)) and math.isfinite(value):
            return int(value)
        if isinstance(value, str):
            try:
                parsed = int(float(value.strip()))
            except (TypeError, ValueError):
                return None
            return parsed
        return None

    def _build_recording_progress(status: dict[str, object]) -> dict[str, object] | None:
        capturing = bool(status.get("capturing", False))
        if not capturing:
            return None

        event_payload = status.get("event")
        if not isinstance(event_payload, dict):
            return None

        if not bool(event_payload.get("in_progress", False)):
            return None

        rel_candidates: list[str] = []
        event_rel = event_payload.get("partial_recording_rel_path")
        if isinstance(event_rel, str) and event_rel.strip():
            rel_candidates.append(event_rel.strip())
        status_rel = status.get("partial_recording_rel_path")
        if isinstance(status_rel, str) and status_rel.strip():
            rel_candidates.append(status_rel.strip())

        rel_path = next((item for item in rel_candidates if item), "")
        if not rel_path:
            return None

        waveform_rel_candidates: list[str] = []
        event_waveform_rel = event_payload.get("partial_waveform_rel_path")
        if isinstance(event_waveform_rel, str) and event_waveform_rel.strip():
            waveform_rel_candidates.append(event_waveform_rel.strip())
        status_waveform_rel = status.get("partial_waveform_rel_path")
        if isinstance(status_waveform_rel, str) and status_waveform_rel.strip():
            waveform_rel_candidates.append(status_waveform_rel.strip())
        waveform_rel_path = next((item for item in waveform_rel_candidates if item), "")

        waveform_path_candidates: list[str] = []
        event_waveform_path = event_payload.get("partial_waveform_path")
        if isinstance(event_waveform_path, str) and event_waveform_path.strip():
            waveform_path_candidates.append(event_waveform_path.strip())
        status_waveform_path = status.get("partial_waveform_path")
        if isinstance(status_waveform_path, str) and status_waveform_path.strip():
            waveform_path_candidates.append(status_waveform_path.strip())
        waveform_path = next((item for item in waveform_path_candidates if item), "")

        base_name_raw = event_payload.get("base_name")
        base_name = base_name_raw.strip() if isinstance(base_name_raw, str) else ""
        if not base_name:
            base_name = "Current recording"

        streaming_format_raw = event_payload.get("streaming_container_format")
        if not isinstance(streaming_format_raw, str) or not streaming_format_raw.strip():
            streaming_format_raw = status.get("streaming_container_format")
        streaming_format = (
            streaming_format_raw.strip().lower()
            if isinstance(streaming_format_raw, str)
            else "opus"
        )
        extension = "webm" if streaming_format == "webm" else "opus"

        duration_seconds_value = _float_or_none(status.get("event_duration_seconds"))
        if duration_seconds_value is not None:
            duration_seconds_value = max(0.0, duration_seconds_value)

        size_bytes_value = _int_or_none(status.get("event_size_bytes"))
        if size_bytes_value is not None:
            size_bytes_value = max(0, size_bytes_value)
        else:
            size_bytes_value = 0

        started_epoch = _float_or_none(event_payload.get("started_epoch"))
        start_epoch = _float_or_none(event_payload.get("start_epoch"))
        if start_epoch is None and started_epoch is not None:
            start_epoch = started_epoch

        started_at_raw = event_payload.get("started_at")
        started_at = started_at_raw.strip() if isinstance(started_at_raw, str) else ""

        updated_at_value = _float_or_none(status.get("updated_at"))
        modified_epoch = start_epoch
        if modified_epoch is None:
            modified_epoch = updated_at_value
        if modified_epoch is None:
            modified_epoch = time.time()

        day = rel_path.split("/", 1)[0] if "/" in rel_path else ""

        trigger_offset = _float_or_none(event_payload.get("trigger_offset_seconds"))
        release_offset = _float_or_none(event_payload.get("release_offset_seconds"))
        motion_trigger_offset = _float_or_none(
            event_payload.get("motion_trigger_offset_seconds")
        )
        motion_release_offset = _float_or_none(
            event_payload.get("motion_release_offset_seconds")
        )
        motion_started_epoch = _float_or_none(event_payload.get("motion_started_epoch"))
        motion_released_epoch = _float_or_none(event_payload.get("motion_released_epoch"))

        progress: dict[str, object] = {
            "name": base_name,
            "path": rel_path,
            "stream_path": rel_path,
            "day": day,
            "collection": "recent",
            "extension": extension,
            "size_bytes": size_bytes_value,
            "modified": float(modified_epoch),
            "modified_iso": datetime.fromtimestamp(
                modified_epoch, tz=timezone.utc
            ).isoformat(),
            "duration_seconds": duration_seconds_value,
            "start_epoch": start_epoch,
            "started_epoch": started_epoch,
            "started_at": started_at,
            "waveform_path": waveform_rel_path or waveform_path,
            "has_transcript": False,
            "transcript_path": "",
            "transcript_event_type": "",
            "transcript_updated": None,
            "transcript_updated_iso": "",
            "trigger_offset_seconds": trigger_offset,
            "release_offset_seconds": release_offset,
            "motion_trigger_offset_seconds": motion_trigger_offset,
            "motion_release_offset_seconds": motion_release_offset,
            "motion_started_epoch": motion_started_epoch,
            "motion_released_epoch": motion_released_epoch,
            "isPartial": True,
            "inProgress": True,
        }

        trigger_candidates: list[str] = []
        raw_event_triggers = event_payload.get("trigger_sources") if isinstance(event_payload, dict) else None
        if isinstance(raw_event_triggers, list):
            trigger_candidates.extend(raw_event_triggers)
        raw_status_triggers = status.get("trigger_sources") if isinstance(status, dict) else None
        if isinstance(raw_status_triggers, list):
            trigger_candidates.extend(raw_status_triggers)
        progress["trigger_sources"] = _normalize_trigger_sources(trigger_candidates)

        return progress

    def _read_capture_status() -> dict[str, object]:
        try:
            with open(capture_status_path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            return {
                "capturing": False,
                "updated_at": None,
                "manual_recording": _read_manual_record_flag(),
                "auto_recording_enabled": _read_auto_record_flag(),
                "auto_record_motion_override": auto_motion_override_default,
            }
        except json.JSONDecodeError:
            return {
                "capturing": False,
                "updated_at": None,
                "error": "invalid",
                "manual_recording": _read_manual_record_flag(),
                "auto_recording_enabled": _read_auto_record_flag(),
                "auto_record_motion_override": auto_motion_override_default,
            }
        except OSError:
            return {
                "capturing": False,
                "updated_at": None,
                "manual_recording": _read_manual_record_flag(),
                "auto_recording_enabled": _read_auto_record_flag(),
                "auto_record_motion_override": auto_motion_override_default,
            }

        status: dict[str, object] = {
            "capturing": bool(raw.get("capturing", False)),
            "service_running": False,
        }
        manual_flag = raw.get("manual_recording")
        if isinstance(manual_flag, bool):
            status["manual_recording"] = manual_flag
        else:
            status["manual_recording"] = _read_manual_record_flag()
        auto_flag = raw.get("auto_recording_enabled")
        if isinstance(auto_flag, bool):
            status["auto_recording_enabled"] = auto_flag
        else:
            status["auto_recording_enabled"] = _read_auto_record_flag()
        motion_override_flag = raw.get("auto_record_motion_override")
        if isinstance(motion_override_flag, bool):
            status["auto_record_motion_override"] = motion_override_flag
        else:
            status["auto_record_motion_override"] = auto_motion_override_default
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
            partial_path = event_payload.get("partial_recording_path")
            if isinstance(partial_path, str) and partial_path:
                normalized_path, rel_path = _normalize_partial_path(partial_path)
                if normalized_path:
                    event["partial_recording_path"] = normalized_path
                if rel_path:
                    event["partial_recording_rel_path"] = rel_path
            waveform_path = event_payload.get("partial_waveform_path")
            if isinstance(waveform_path, str) and waveform_path:
                normalized_waveform, rel_waveform = _normalize_partial_path(waveform_path)
                if normalized_waveform:
                    event["partial_waveform_path"] = normalized_waveform
                if rel_waveform:
                    event["partial_waveform_rel_path"] = rel_waveform
            in_progress = event_payload.get("in_progress")
            if isinstance(in_progress, bool):
                event["in_progress"] = in_progress
            streaming_format = event_payload.get("streaming_container_format")
            if isinstance(streaming_format, str) and streaming_format:
                event["streaming_container_format"] = streaming_format
            motion_active = _parse_motion_flag(event_payload.get("motion_active"))
            if motion_active is not None:
                event["motion_active"] = motion_active
            motion_started = event_payload.get("motion_started_epoch")
            if isinstance(motion_started, (int, float)):
                event["motion_started_epoch"] = float(motion_started)
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
            recording_path = last_payload.get("recording_path")
            if isinstance(recording_path, str) and recording_path:
                last_event["recording_path"] = recording_path
            last_in_progress = last_payload.get("in_progress")
            if isinstance(last_in_progress, bool):
                last_event["in_progress"] = last_in_progress
            last_streaming_format = last_payload.get("streaming_container_format")
            if isinstance(last_streaming_format, str) and last_streaming_format:
                last_event["streaming_container_format"] = last_streaming_format
            motion_active = _parse_motion_flag(last_payload.get("motion_active"))
            if motion_active is not None:
                last_event["motion_active"] = motion_active
            motion_started = last_payload.get("motion_started_epoch")
            if isinstance(motion_started, (int, float)):
                last_event["motion_started_epoch"] = float(motion_started)
            if last_event:
                status["last_event"] = last_event

        reason = raw.get("last_stop_reason")
        if isinstance(reason, str) and reason:
            status["last_stop_reason"] = reason

        current_rms = raw.get("current_rms")
        if isinstance(current_rms, (int, float)) and math.isfinite(current_rms):
            status["current_rms"] = int(current_rms)

        service_running_raw = raw.get("service_running")
        if isinstance(service_running_raw, bool):
            status["service_running"] = service_running_raw
        elif isinstance(service_running_raw, (int, float)):
            status["service_running"] = bool(service_running_raw)
        elif isinstance(service_running_raw, str):
            normalized = service_running_raw.strip().lower()
            if normalized in {"1", "true", "yes", "on", "running"}:
                status["service_running"] = True
            elif normalized in {"0", "false", "no", "off", "stopped"}:
                status["service_running"] = False

        motion_active_raw = raw.get("motion_active")
        parsed_motion = _parse_motion_flag(motion_active_raw)
        if parsed_motion is not None:
            status["motion_active"] = parsed_motion
        motion_since = raw.get("motion_active_since")
        if isinstance(motion_since, (int, float)):
            status["motion_active_since"] = float(motion_since)
        motion_sequence = raw.get("motion_sequence")
        if isinstance(motion_sequence, (int, float)):
            status["motion_sequence"] = int(motion_sequence)

        adaptive_threshold = raw.get("adaptive_rms_threshold")
        if isinstance(adaptive_threshold, (int, float)) and math.isfinite(adaptive_threshold):
            status["adaptive_rms_threshold"] = int(adaptive_threshold)

        adaptive_enabled_raw = raw.get("adaptive_rms_enabled")
        if isinstance(adaptive_enabled_raw, bool):
            status["adaptive_rms_enabled"] = adaptive_enabled_raw
        elif isinstance(adaptive_enabled_raw, (int, float)):
            status["adaptive_rms_enabled"] = bool(adaptive_enabled_raw)
        elif isinstance(adaptive_enabled_raw, str):
            normalized = adaptive_enabled_raw.strip().lower()
            if normalized in {"1", "true", "yes", "on", "enabled"}:
                status["adaptive_rms_enabled"] = True
            elif normalized in {"0", "false", "no", "off", "disabled"}:
                status["adaptive_rms_enabled"] = False

        duration_seconds = raw.get("event_duration_seconds")
        if isinstance(duration_seconds, (int, float)) and math.isfinite(duration_seconds):
            status["event_duration_seconds"] = max(0.0, float(duration_seconds))

        event_size_bytes = raw.get("event_size_bytes")
        if isinstance(event_size_bytes, (int, float)) and math.isfinite(event_size_bytes):
            status["event_size_bytes"] = max(0, int(event_size_bytes))

        partial_recording_path = raw.get("partial_recording_path")
        if isinstance(partial_recording_path, str) and partial_recording_path:
            normalized_path, rel_path = _normalize_partial_path(partial_recording_path)
            if normalized_path:
                status["partial_recording_path"] = normalized_path
            if rel_path:
                status["partial_recording_rel_path"] = rel_path

        partial_waveform_path = raw.get("partial_waveform_path")
        if isinstance(partial_waveform_path, str) and partial_waveform_path:
            normalized_waveform, rel_waveform = _normalize_partial_path(partial_waveform_path)
            if normalized_waveform:
                status["partial_waveform_path"] = normalized_waveform
            if rel_waveform:
                status["partial_waveform_rel_path"] = rel_waveform

        streaming_format = raw.get("streaming_container_format")
        if isinstance(streaming_format, str) and streaming_format:
            status["streaming_container_format"] = streaming_format

        progress_record = _build_recording_progress(status)
        if progress_record is not None:
            status["recording_progress"] = progress_record
        else:
            status.pop("recording_progress", None)

        avg_ms = raw.get("filter_chain_avg_ms")
        if isinstance(avg_ms, (int, float)) and math.isfinite(avg_ms):
            status["filter_chain_avg_ms"] = float(avg_ms)

        peak_ms = raw.get("filter_chain_peak_ms")
        if isinstance(peak_ms, (int, float)) and math.isfinite(peak_ms):
            status["filter_chain_peak_ms"] = float(peak_ms)

        avg_budget = raw.get("filter_chain_avg_budget_ms")
        if isinstance(avg_budget, (int, float)) and math.isfinite(avg_budget):
            status["filter_chain_avg_budget_ms"] = float(avg_budget)

        peak_budget = raw.get("filter_chain_peak_budget_ms")
        if isinstance(peak_budget, (int, float)) and math.isfinite(peak_budget):
            status["filter_chain_peak_budget_ms"] = float(peak_budget)

        encoding_raw = raw.get("encoding")
        if isinstance(encoding_raw, dict):
            encoding: dict[str, object] = {}

            pending_entries: list[dict[str, object]] = []
            pending_raw = encoding_raw.get("pending")
            if isinstance(pending_raw, list):
                for item in pending_raw:
                    if not isinstance(item, dict):
                        continue
                    entry: dict[str, object] = {}
                    base_name = item.get("base_name")
                    if isinstance(base_name, str) and base_name:
                        entry["base_name"] = base_name
                    source = item.get("source")
                    if isinstance(source, str) and source:
                        entry["source"] = source
                    job_id = item.get("id")
                    if isinstance(job_id, (int, float)) and math.isfinite(job_id):
                        entry["id"] = int(job_id)
                    queued_at = item.get("queued_at")
                    if isinstance(queued_at, (int, float)) and math.isfinite(queued_at):
                        entry["queued_at"] = float(queued_at)
                    status_value = item.get("status")
                    if isinstance(status_value, str) and status_value:
                        entry["status"] = status_value
                    if entry:
                        pending_entries.append(entry)
            encoding["pending"] = pending_entries

            active_entries: list[dict[str, object]] = []
            active_raw = encoding_raw.get("active")
            raw_candidates: list[dict[str, object]] = []
            if isinstance(active_raw, list):
                raw_candidates = [item for item in active_raw if isinstance(item, dict)]
            elif isinstance(active_raw, dict):
                raw_candidates = [active_raw]
            for item in raw_candidates:
                active_entry: dict[str, object] = {}
                base_name = item.get("base_name")
                if isinstance(base_name, str) and base_name:
                    active_entry["base_name"] = base_name
                source = item.get("source")
                if isinstance(source, str) and source:
                    active_entry["source"] = source
                job_id = item.get("id")
                if isinstance(job_id, (int, float)) and math.isfinite(job_id):
                    active_entry["id"] = int(job_id)
                queued_at = item.get("queued_at")
                if isinstance(queued_at, (int, float)) and math.isfinite(queued_at):
                    active_entry["queued_at"] = float(queued_at)
                started_at = item.get("started_at")
                if isinstance(started_at, (int, float)) and math.isfinite(started_at):
                    active_entry["started_at"] = float(started_at)
                duration_value = item.get("duration_seconds")
                if isinstance(duration_value, (int, float)) and math.isfinite(duration_value):
                    active_entry["duration_seconds"] = max(0.0, float(duration_value))
                status_value = item.get("status")
                if isinstance(status_value, str) and status_value:
                    active_entry["status"] = status_value
                if active_entry:
                    active_entries.append(active_entry)
            if active_entries:
                encoding["active"] = active_entries

            if encoding.get("pending") or encoding.get("active"):
                status["encoding"] = encoding

        now = time.time()
        updated_at_value = status.get("updated_at")
        stale = True
        if isinstance(updated_at_value, (int, float)) and math.isfinite(updated_at_value):
            age = now - updated_at_value
            if math.isfinite(age) and 0 <= age <= CAPTURE_STATUS_STALE_AFTER_SECONDS:
                stale = False
        else:
            status["updated_at"] = None

        service_running = bool(status.get("service_running", False))

        if stale or not service_running:
            status["capturing"] = False
            status.pop("event", None)
            status.pop("event_duration_seconds", None)
            status.pop("event_size_bytes", None)
            status.pop("encoding", None)
            status.pop("recording_progress", None)
            status["service_running"] = False
            if not status.get("last_stop_reason"):
                status["last_stop_reason"] = (
                    "status stale" if stale else "service offline"
                )
        else:
            status["service_running"] = True

        return status

    capture_status_bridge = CaptureStatusEventBridge(
        read_status=_read_capture_status,
        bus=event_bus,
        poll_interval=CAPTURE_STATUS_EVENT_POLL_SECONDS,
        logger=log,
    )
    app[CAPTURE_STATUS_BRIDGE_KEY] = capture_status_bridge

    async def _start_capture_status_bridge(_: web.Application) -> None:
        await capture_status_bridge.start()

    async def _stop_capture_status_bridge(_: web.Application) -> None:
        await capture_status_bridge.stop()

    recordings_event_spool = Path(cfg["paths"].get("tmp_dir", tmp_root)) / RECORDINGS_EVENT_SPOOL_DIRNAME
    recordings_event_bridge = RecordingsEventBridge(
        spool_dir=recordings_event_spool,
        bus=event_bus,
        poll_interval=RECORDINGS_EVENT_POLL_SECONDS,
        logger=log,
    )
    app[RECORDINGS_EVENT_BRIDGE_KEY] = recordings_event_bridge

    async def _start_recordings_event_bridge(_: web.Application) -> None:
        await recordings_event_bridge.start()

    async def _stop_recordings_event_bridge(_: web.Application) -> None:
        await recordings_event_bridge.stop()

    async def _shutdown_clip_executor(_: web.Application) -> None:
        clip_executor.shutdown(wait=False, cancel_futures=True)

    app.on_startup.append(_start_capture_status_bridge)
    app.on_startup.append(_start_recordings_event_bridge)
    app.on_cleanup.append(_stop_capture_status_bridge)
    app.on_cleanup.append(_stop_recordings_event_bridge)
    app.on_cleanup.append(_stop_health_broadcaster)
    app.on_cleanup.append(_cleanup_event_bus)
    app.on_cleanup.append(_shutdown_clip_executor)

    def _motion_state_snapshot(*, include_events: bool = True) -> dict[str, object]:
        state = load_motion_state(motion_state_path)
        payload = state.to_payload(include_events=include_events)
        payload.setdefault("motion_active", state.active)
        if "motion_active_since" not in payload:
            payload["motion_active_since"] = None
        if include_events:
            payload.setdefault("events", [])
        return payload

    def _filter_recordings(entries: list[dict[str, object]], request: web.Request) -> dict[str, object]:
        query = request.rel_url.query

        search = query.get("search", "").strip().lower()

        raw_time_range = query.get("time_range", "").strip().lower()
        time_range_value = ""
        cutoff_epoch: float | None = None
        if raw_time_range in RECORDINGS_TIME_RANGE_SECONDS:
            time_range_value = raw_time_range
            cutoff_epoch = time.time() - RECORDINGS_TIME_RANGE_SECONDS[raw_time_range]

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

        def _excerpt(text: str, limit: int = 240) -> str:
            normalized = " ".join(text.split())
            if not normalized:
                return ""
            if len(normalized) <= limit:
                return normalized
            truncated = normalized[:limit]
            if " " in truncated:
                truncated = truncated.rsplit(" ", 1)[0]
            return truncated + "…"

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
            transcript_text = ""
            raw_transcript_text = item.get("transcript_text")
            if isinstance(raw_transcript_text, str):
                transcript_text = raw_transcript_text

            haystacks = [name.lower(), path.lower()]
            if transcript_text:
                haystacks.append(transcript_text.lower())

            if search and all(search not in candidate for candidate in haystacks):
                continue
            if day_filter and day not in day_filter:
                continue
            if ext_filter and ext.lower() not in ext_filter:
                continue
            if cutoff_epoch is not None:
                record_epoch: float | None = None
                start_epoch = item.get("start_epoch")
                if isinstance(start_epoch, (int, float)) and math.isfinite(start_epoch):
                    record_epoch = float(start_epoch)
                else:
                    modified_value = item.get("modified")
                    if isinstance(modified_value, (int, float)) and math.isfinite(modified_value):
                        record_epoch = float(modified_value)
                if record_epoch is not None and record_epoch < cutoff_epoch:
                    continue

            filtered.append(item)
            try:
                total_size += int(item.get("size_bytes", 0))
            except (TypeError, ValueError):
                pass

        total = len(filtered)
        window = filtered[offset : offset + limit]

        undo_tokens = _collect_clip_undo_tokens() if window else {}

        payload_items = [
            {
                "name": str(entry.get("name", "")),
                "path": str(entry.get("path", "")),
                "day": str(entry.get("day", "")),
                "collection": str(entry.get("collection", "")),
                "extension": str(entry.get("extension", "")),
                "size_bytes": int(entry.get("size_bytes", 0) or 0),
                "modified": float(entry.get("modified", 0.0) or 0.0),
                "modified_iso": str(entry.get("modified_iso", "")),
                "duration_seconds": (
                    float(entry.get("duration"))
                    if isinstance(entry.get("duration"), (int, float))
                    else None
                ),
                "trigger_offset_seconds": (
                    float(entry.get("trigger_offset_seconds"))
                    if isinstance(entry.get("trigger_offset_seconds"), (int, float))
                    else None
                ),
                "release_offset_seconds": (
                    float(entry.get("release_offset_seconds"))
                    if isinstance(entry.get("release_offset_seconds"), (int, float))
                    else None
                ),
                "motion_trigger_offset_seconds": (
                    float(entry.get("motion_trigger_offset_seconds"))
                    if isinstance(entry.get("motion_trigger_offset_seconds"), (int, float))
                    else None
                ),
                "motion_release_offset_seconds": (
                    float(entry.get("motion_release_offset_seconds"))
                    if isinstance(entry.get("motion_release_offset_seconds"), (int, float))
                    else None
                ),
                "motion_started_epoch": (
                    float(entry.get("motion_started_epoch"))
                    if isinstance(entry.get("motion_started_epoch"), (int, float))
                    else None
                ),
                "motion_released_epoch": (
                    float(entry.get("motion_released_epoch"))
                    if isinstance(entry.get("motion_released_epoch"), (int, float))
                    else None
                ),
                "motion_segments": _normalize_motion_segments(
                    entry.get("motion_segments")
                ),
                "waveform_path": (
                    str(entry.get("waveform_path"))
                    if entry.get("waveform_path")
                    else ""
                ),
                "undo_token": (
                    undo_tokens.get(str(entry.get("path", "")))
                    if undo_tokens
                    else None
                ),
                "start_epoch": (
                    float(entry.get("start_epoch", 0.0))
                    if isinstance(entry.get("start_epoch"), (int, float))
                    else None
                ),
                "started_epoch": (
                    float(entry.get("started_epoch", 0.0))
                    if isinstance(entry.get("started_epoch"), (int, float))
                    else None
                ),
                "started_at": (
                    str(entry.get("started_at"))
                    if isinstance(entry.get("started_at"), str)
                    else ""
                ),
                "has_transcript": bool(entry.get("has_transcript")),
                "transcript_path": (
                    str(entry.get("transcript_path"))
                    if entry.get("transcript_path")
                    else ""
                ),
                "transcript_event_type": (
                    str(entry.get("transcript_event_type"))
                    if entry.get("transcript_event_type")
                    else ""
                ),
                "transcript_updated": (
                    float(entry.get("transcript_updated", 0.0))
                    if isinstance(entry.get("transcript_updated"), (int, float))
                    else None
                ),
                "transcript_updated_iso": (
                    str(entry.get("transcript_updated_iso"))
                    if isinstance(entry.get("transcript_updated_iso"), str)
                    else ""
                ),
                "transcript_excerpt": _excerpt(str(entry.get("transcript_text", ""))),
                "raw_audio_path": (
                    str(entry.get("raw_audio_path"))
                    if entry.get("raw_audio_path")
                    else ""
                ),
                "manual_event": bool(entry.get("manual_event")),
                "detected_rms": bool(entry.get("detected_rms")),
                "detected_vad": bool(
                    entry.get("detected_vad")
                    or entry.get("detected_bad")
                ),
                "end_reason": (
                    str(entry.get("end_reason")).strip()
                    if isinstance(entry.get("end_reason"), str)
                    else ""
                ),
                "trigger_sources": (
                    _normalize_trigger_sources(entry.get("trigger_sources"))
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
            "time_range": time_range_value,
        }

    async def recordings_api(request: web.Request) -> web.Response:
        raw_collection = request.rel_url.query.get("collection", "").strip().lower()
        if raw_collection == "saved":
            entries, available_days, available_exts, total_bytes = await _scan_saved_recordings()
            collection = "saved"
        else:
            entries, available_days, available_exts, total_bytes = await _scan_recordings()
            collection = "recent"
        payload = _filter_recordings(entries, request)
        payload["collection"] = collection
        payload["available_days"] = available_days
        payload["available_extensions"] = available_exts
        log = logging.getLogger("web_streamer")
        loop = asyncio.get_running_loop()
        recordings_usage_task = loop.run_in_executor(
            None,
            functools.partial(
                _calculate_directory_usage,
                recordings_root,
                skip_top_level=(RECYCLE_BIN_DIRNAME,),
            ),
        )
        try:
            usage = shutil.disk_usage(recordings_root)
        except (FileNotFoundError, PermissionError, OSError):
            usage = None
        if usage is not None:
            payload["storage_total_bytes"] = int(usage.total)
            payload["storage_used_bytes"] = int(usage.used)
            payload["storage_free_bytes"] = int(usage.free)
        recycle_root = request.app.get(
            RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME
        )
        recycle_usage_task = loop.run_in_executor(
            None,
            functools.partial(_calculate_recycle_bin_usage, recycle_root),
        )
        try:
            payload["recordings_total_bytes"] = int(await recordings_usage_task)
        except Exception as exc:  # pragma: no cover - defensive logging
            log.warning(
                "recordings_api: unable to calculate recordings usage: %s",
                exc,
            )
            payload["recordings_total_bytes"] = int(total_bytes)
        try:
            payload["recycle_bin_total_bytes"] = int(await recycle_usage_task)
        except Exception as exc:  # pragma: no cover - defensive logging
            log.warning(
                "recordings_api: unable to calculate recycle bin usage: %s",
                exc,
            )
            payload["recycle_bin_total_bytes"] = 0
        payload["capture_status"] = _read_capture_status()
        payload["motion_state"] = _motion_state_snapshot()
        return web.json_response(payload)

    async def integrations_api(request: web.Request) -> web.Response:
        raw_motion = request.rel_url.query.get("motion")
        if raw_motion is None:
            payload = _motion_state_snapshot()
            payload["ok"] = True
            return web.json_response(payload)

        parsed = _parse_motion_flag(raw_motion)
        if parsed is None:
            raise web.HTTPBadRequest(reason="Invalid 'motion' parameter; expected true/false")

        state = store_motion_state(motion_state_path, motion_active=parsed)
        payload = state.to_payload(include_events=True)
        payload.setdefault("motion_active", state.active)
        if "motion_active_since" not in payload:
            payload["motion_active_since"] = None
        payload.setdefault("events", [])
        payload["ok"] = True
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
        recycle_root = request.app.get(RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME)
        recycle_root_resolved: Path | None = None
        try:
            recycle_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            log.warning("Unable to ensure recycle bin directory exists: %s", exc)
            recycle_root_ready = False
        else:
            recycle_root_ready = True
            try:
                recycle_root_resolved = recycle_root.resolve()
            except OSError as exc:
                log.warning("Unable to resolve recycle bin directory: %s", exc)
                recycle_root_ready = False

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

            if _path_is_partial(resolved):
                errors.append({"item": rel, "error": "recording in progress"})
                continue

            if recycle_root_resolved is not None and resolved.is_relative_to(recycle_root_resolved):
                errors.append({"item": rel, "error": "already in recycle bin"})
                continue

            if not recycle_root_ready:
                errors.append({"item": rel, "error": "recycle bin unavailable"})
                continue

            rel_posix = rel.replace(os.sep, "/")

            try:
                stat_result = resolved.stat()
            except OSError as exc:
                errors.append({"item": rel, "error": str(exc)})
                continue

            waveform_sidecar = resolved.with_suffix(resolved.suffix + ".waveform.json")
            transcript_sidecar = resolved.with_suffix(resolved.suffix + ".transcript.json")
            waveform_meta: dict[str, object] | None = None
            if waveform_sidecar.is_file():
                try:
                    with waveform_sidecar.open("r", encoding="utf-8") as handle:
                        payload = json.load(handle)
                    if isinstance(payload, dict):
                        waveform_meta = payload
                except (OSError, json.JSONDecodeError):
                    waveform_meta = None

            raw_audio_rel = ""
            raw_audio_source: Path | None = None
            if waveform_meta is not None:
                raw_candidate = waveform_meta.get("raw_audio_path")
                if isinstance(raw_candidate, str):
                    candidate_str = raw_candidate.strip()
                    if candidate_str and _is_safe_relative_path(candidate_str):
                        candidate_path = recordings_root / candidate_str
                        try:
                            candidate_path.relative_to(recordings_root_resolved)
                        except Exception:
                            raw_audio_source = None
                        else:
                            raw_audio_rel = candidate_str
                            raw_audio_source = candidate_path

            now = datetime.now(timezone.utc)
            entry_dir: Path | None = None
            entry_id = ""
            attempts = 0
            while attempts < 6:
                attempts += 1
                candidate_id = _generate_recycle_entry_id(now if attempts == 1 else None)
                candidate_dir = recycle_root / candidate_id
                try:
                    candidate_dir.mkdir(parents=True, exist_ok=False)
                except FileExistsError:
                    continue
                except OSError as exc:
                    errors.append({"item": rel, "error": f"unable to prepare recycle bin: {exc}"})
                    candidate_dir = None
                    break
                entry_dir = candidate_dir
                entry_id = candidate_id
                break

            if entry_dir is None or not entry_id:
                continue

            moved_pairs: list[tuple[Path, Path]] = []
            metadata_path = entry_dir / RECYCLE_METADATA_FILENAME
            audio_destination = entry_dir / resolved.name
            waveform_name = ""
            transcript_name = ""
            raw_audio_name = ""
            duration_value: float | None = None

            motion_trigger_offset: float | None = None
            motion_release_offset: float | None = None
            motion_started_epoch: float | None = None
            motion_released_epoch: float | None = None
            motion_segments: list[dict[str, float | None]] = []

            if waveform_meta is not None:
                raw_duration = waveform_meta.get("duration_seconds")
                if isinstance(raw_duration, (int, float)):
                    duration_value = float(raw_duration)

                raw_motion_trigger = waveform_meta.get("motion_trigger_offset_seconds")
                if isinstance(raw_motion_trigger, (int, float)) and math.isfinite(
                    float(raw_motion_trigger)
                ):
                    motion_trigger_offset = float(raw_motion_trigger)

                raw_motion_release = waveform_meta.get("motion_release_offset_seconds")
                if isinstance(raw_motion_release, (int, float)) and math.isfinite(
                    float(raw_motion_release)
                ):
                    motion_release_offset = float(raw_motion_release)

                raw_motion_started = waveform_meta.get("motion_started_epoch")
                if isinstance(raw_motion_started, (int, float)) and math.isfinite(
                    float(raw_motion_started)
                ):
                    motion_started_epoch = float(raw_motion_started)

                raw_motion_released = waveform_meta.get("motion_released_epoch")
                if isinstance(raw_motion_released, (int, float)) and math.isfinite(
                    float(raw_motion_released)
                ):
                    motion_released_epoch = float(raw_motion_released)

                motion_segments = _normalize_motion_segments(
                    waveform_meta.get("motion_segments")
                )

            start_epoch_value, started_at_value = _resolve_start_metadata(
                rel_posix, resolved, stat_result, waveform_meta
            )

            try:
                shutil.move(str(resolved), str(audio_destination))
                moved_pairs.append((audio_destination, resolved))

                if waveform_sidecar.is_file():
                    waveform_name = waveform_sidecar.name
                    waveform_destination = entry_dir / waveform_name
                    shutil.move(str(waveform_sidecar), str(waveform_destination))
                    moved_pairs.append((waveform_destination, waveform_sidecar))
                if transcript_sidecar.is_file():
                    transcript_name = transcript_sidecar.name
                    transcript_destination = entry_dir / transcript_name
                    shutil.move(str(transcript_sidecar), str(transcript_destination))
                    moved_pairs.append((transcript_destination, transcript_sidecar))

                if raw_audio_source and raw_audio_source.exists():
                    raw_audio_name = raw_audio_source.name
                    raw_destination = entry_dir / raw_audio_name
                    shutil.move(str(raw_audio_source), str(raw_destination))
                    moved_pairs.append((raw_destination, raw_audio_source))

                metadata = {
                    "id": entry_id,
                    "stored_name": resolved.name,
                    "original_name": resolved.name,
                    "original_path": rel_posix,
                    "raw_audio_path": raw_audio_rel,
                    "raw_audio_name": raw_audio_name,
                    "deleted_at": now.isoformat(),
                    "deleted_at_epoch": now.timestamp(),
                    "size_bytes": int(getattr(stat_result, "st_size", 0)),
                    "duration_seconds": duration_value,
                    "waveform_name": waveform_name,
                    "transcript_name": transcript_name,
                    "start_epoch": start_epoch_value,
                    "started_epoch": start_epoch_value,
                    "started_at": started_at_value,
                    "reason": "manual",
                    "motion_trigger_offset_seconds": motion_trigger_offset,
                    "motion_release_offset_seconds": motion_release_offset,
                    "motion_started_epoch": motion_started_epoch,
                    "motion_released_epoch": motion_released_epoch,
                    "motion_segments": motion_segments,
                }
                with metadata_path.open("w", encoding="utf-8") as handle:
                    json.dump(metadata, handle)

                deleted.append(rel_posix)
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                for dest, original in reversed(moved_pairs):
                    try:
                        if dest.exists():
                            original.parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(dest), str(original))
                    except Exception:
                        pass
                try:
                    if metadata_path.exists():
                        metadata_path.unlink()
                except Exception:
                    pass
                try:
                    shutil.rmtree(entry_dir, ignore_errors=True)
                except Exception:
                    pass
                continue

            if raw_audio_name and raw_audio_source:
                raw_root = recordings_root / RAW_AUDIO_DIRNAME
                raw_parent = raw_audio_source.parent
                while (
                    raw_parent != raw_root
                    and raw_parent != recordings_root
                    and raw_parent != raw_parent.parent
                ):
                    try:
                        next(raw_parent.iterdir())
                    except StopIteration:
                        try:
                            raw_parent.rmdir()
                        except OSError:
                            break
                        raw_parent = raw_parent.parent
                        continue
                    except Exception:
                        break
                    break

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

        if deleted:
            _emit_recordings_changed(
                "deleted",
                paths=deleted,
                count=len(deleted),
            )
        return web.json_response({"deleted": deleted, "errors": errors})

    async def recordings_save(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        items = data.get("items")
        if not isinstance(items, list):
            raise web.HTTPBadRequest(reason="'items' must be a list")

        saved: list[str] = []
        errors: list[dict[str, str]] = []

        for raw in items:
            if not isinstance(raw, str) or not raw.strip():
                errors.append({"item": str(raw), "error": "invalid path"})
                continue

            rel = raw.strip().strip("/")
            if not _is_safe_relative_path(rel):
                errors.append({"item": rel, "error": "invalid path"})
                continue

            rel_path = Path(rel)
            if rel_path.parts and rel_path.parts[0] == SAVED_RECORDINGS_DIRNAME:
                errors.append({"item": rel, "error": "already saved"})
                continue

            source = recordings_root / rel_path
            try:
                resolved = source.resolve()
            except FileNotFoundError:
                errors.append({"item": rel, "error": "not found"})
                continue
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                continue

            try:
                resolved.relative_to(recordings_root_resolved)
            except ValueError:
                errors.append({"item": rel, "error": "outside recordings directory"})
                continue

            if resolved.is_relative_to(saved_recordings_root_resolved):
                errors.append({"item": rel, "error": "already saved"})
                continue

            if not resolved.is_file():
                errors.append({"item": rel, "error": "not a file"})
                continue

            if _path_is_partial(resolved):
                errors.append({"item": rel, "error": "recording in progress"})
                continue

            target = saved_recordings_root / rel_path
            try:
                target_resolved = target.resolve()
            except FileNotFoundError:
                target_resolved = target

            try:
                target_resolved.relative_to(saved_recordings_root_resolved)
            except ValueError:
                errors.append({"item": rel, "error": "target outside saved directory"})
                continue

            if target.exists():
                errors.append({"item": rel, "error": "already exists in saved"})
                continue

            waveform_source = resolved.with_suffix(resolved.suffix + ".waveform.json")
            transcript_source = resolved.with_suffix(resolved.suffix + ".transcript.json")
            moved_pairs: list[tuple[Path, Path]] = []
            source_parent = resolved.parent

            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(resolved), str(target))
                moved_pairs.append((target, resolved))

                if waveform_source.is_file():
                    waveform_target = target.with_suffix(target.suffix + ".waveform.json")
                    waveform_target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(waveform_source), str(waveform_target))
                    moved_pairs.append((waveform_target, waveform_source))

                if transcript_source.is_file():
                    transcript_target = target.with_suffix(target.suffix + ".transcript.json")
                    transcript_target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(transcript_source), str(transcript_target))
                    moved_pairs.append((transcript_target, transcript_source))

                try:
                    rel_saved = target.resolve().relative_to(recordings_root_resolved).as_posix()
                except Exception:
                    rel_saved = target.relative_to(recordings_root).as_posix()
                saved.append(rel_saved)
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                for dest, original in reversed(moved_pairs):
                    try:
                        if dest.exists():
                            original.parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(dest), str(original))
                    except Exception:
                        pass
                try:
                    if target.exists():
                        target.unlink()
                except Exception:
                    pass
                continue

            parent = source_parent
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

        if saved:
            _emit_recordings_changed(
                "saved",
                paths=saved,
                count=len(saved),
            )
        return web.json_response({"saved": saved, "errors": errors})

    async def recordings_unsave(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        items = data.get("items")
        if not isinstance(items, list):
            raise web.HTTPBadRequest(reason="'items' must be a list")

        unsaved: list[str] = []
        errors: list[dict[str, str]] = []

        for raw in items:
            if not isinstance(raw, str) or not raw.strip():
                errors.append({"item": str(raw), "error": "invalid path"})
                continue

            rel = raw.strip().strip("/")
            if not _is_safe_relative_path(rel):
                errors.append({"item": rel, "error": "invalid path"})
                continue

            rel_path = Path(rel)
            if not rel_path.parts or rel_path.parts[0] != SAVED_RECORDINGS_DIRNAME:
                errors.append({"item": rel, "error": "not in saved"})
                continue

            remainder_parts = rel_path.parts[1:]
            if not remainder_parts:
                errors.append({"item": rel, "error": "not in saved"})
                continue

            remainder = Path(*remainder_parts)
            source = saved_recordings_root / remainder
            try:
                resolved = source.resolve()
            except FileNotFoundError:
                errors.append({"item": rel, "error": "not found"})
                continue
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                continue

            try:
                resolved.relative_to(saved_recordings_root_resolved)
            except ValueError:
                errors.append({"item": rel, "error": "not in saved"})
                continue

            if not resolved.is_file():
                errors.append({"item": rel, "error": "not a file"})
                continue

            target = recordings_root / remainder
            try:
                target_resolved = target.resolve()
            except FileNotFoundError:
                target_resolved = target

            try:
                target_resolved.relative_to(recordings_root_resolved)
            except ValueError:
                errors.append({"item": rel, "error": "target outside recordings directory"})
                continue

            if target.exists():
                errors.append({"item": rel, "error": "destination exists"})
                continue

            waveform_source = resolved.with_suffix(resolved.suffix + ".waveform.json")
            transcript_source = resolved.with_suffix(resolved.suffix + ".transcript.json")
            moved_pairs: list[tuple[Path, Path]] = []
            source_parent = resolved.parent

            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(resolved), str(target))
                moved_pairs.append((target, resolved))

                if waveform_source.is_file():
                    waveform_target = target.with_suffix(target.suffix + ".waveform.json")
                    waveform_target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(waveform_source), str(waveform_target))
                    moved_pairs.append((waveform_target, waveform_source))

                if transcript_source.is_file():
                    transcript_target = target.with_suffix(target.suffix + ".transcript.json")
                    transcript_target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(transcript_source), str(transcript_target))
                    moved_pairs.append((transcript_target, transcript_source))

                try:
                    rel_unsaved = target.resolve().relative_to(recordings_root_resolved).as_posix()
                except Exception:
                    rel_unsaved = target.relative_to(recordings_root).as_posix()
                unsaved.append(rel_unsaved)
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                for dest, original in reversed(moved_pairs):
                    try:
                        if dest.exists():
                            original.parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(dest), str(original))
                    except Exception:
                        pass
                try:
                    if target.exists():
                        target.unlink()
                except Exception:
                    pass
                continue

            parent = source_parent
            while parent != saved_recordings_root and parent != parent.parent:
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

        if unsaved:
            _emit_recordings_changed(
                "unsaved",
                paths=unsaved,
                count=len(unsaved),
            )
        return web.json_response({"unsaved": unsaved, "errors": errors})

    async def recycle_bin_list(request: web.Request) -> web.Response:
        recycle_root = request.app.get(RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME)
        entries: list[dict[str, object]] = []
        if recycle_root.exists():
            try:
                candidates = list(recycle_root.iterdir())
            except OSError:
                candidates = []
            for entry_dir in candidates:
                data = _read_recycle_entry(entry_dir)
                if not data:
                    continue

                entry_id = str(data.get("id", ""))
                original_rel = str(data.get("original_path", ""))
                stored_name = str(data.get("stored_name", ""))
                name = Path(stored_name).stem if stored_name else stored_name
                extension = Path(stored_name).suffix.lstrip(".") if stored_name else ""

                restorable = False
                if original_rel and _is_safe_relative_path(original_rel):
                    candidate = recordings_root / original_rel
                    try:
                        resolved_target = candidate.resolve(strict=False)
                    except FileNotFoundError:
                        resolved_target = candidate
                    try:
                        resolved_target.relative_to(recordings_root_resolved)
                    except ValueError:
                        restorable = False
                    else:
                        restorable = not candidate.exists()

                deleted_epoch = data.get("deleted_at_epoch")
                if isinstance(deleted_epoch, (int, float)):
                    deleted_epoch_value = float(deleted_epoch)
                else:
                    deleted_epoch_value = None

                start_epoch_raw = data.get("start_epoch")
                if isinstance(start_epoch_raw, (int, float)):
                    start_epoch_value = float(start_epoch_raw)
                else:
                    start_epoch_value = None

                started_at_raw = data.get("started_at")
                started_at_value = (
                    str(started_at_raw)
                    if isinstance(started_at_raw, str)
                    else ""
                )

                size_value = data.get("size_bytes", 0)
                try:
                    size_int = int(size_value)
                except (TypeError, ValueError):
                    size_int = 0
                else:
                    if size_int < 0:
                        size_int = 0
                reason_value = ""
                raw_reason = data.get("reason")
                if isinstance(raw_reason, str):
                    reason_value = raw_reason.strip()

                raw_audio_available = bool(data.get("raw_audio_bin_path"))
                raw_audio_name = str(data.get("raw_audio_name") or "")
                entries.append(
                    {
                        "id": entry_id,
                        "name": name,
                        "extension": extension,
                        "original_path": original_rel,
                        "day": str(data.get("day", "")),
                        "deleted_at": str(data.get("deleted_at", "")),
                        "deleted_at_epoch": deleted_epoch_value,
                        "start_epoch": start_epoch_value,
                        "started_epoch": start_epoch_value,
                        "started_at": started_at_value,
                        "size_bytes": size_int,
                        "duration_seconds": (
                            float(data.get("duration"))
                            if isinstance(data.get("duration"), (int, float))
                            else None
                        ),
                        "motion_trigger_offset_seconds": (
                            float(data.get("motion_trigger_offset_seconds"))
                            if isinstance(data.get("motion_trigger_offset_seconds"), (int, float))
                            else None
                        ),
                        "motion_release_offset_seconds": (
                            float(data.get("motion_release_offset_seconds"))
                            if isinstance(data.get("motion_release_offset_seconds"), (int, float))
                            else None
                        ),
                        "motion_started_epoch": (
                            float(data.get("motion_started_epoch"))
                            if isinstance(data.get("motion_started_epoch"), (int, float))
                            else None
                        ),
                        "motion_released_epoch": (
                            float(data.get("motion_released_epoch"))
                            if isinstance(data.get("motion_released_epoch"), (int, float))
                            else None
                        ),
                        "motion_segments": _normalize_motion_segments(
                            data.get("motion_segments")
                        ),
                        "restorable": restorable,
                        "waveform_available": bool(data.get("waveform_name")),
                        "raw_audio_available": raw_audio_available,
                        "raw_audio_name": raw_audio_name,
                        "reason": reason_value,
                    }
                )

        entries.sort(
            key=lambda item: (
                float(item["deleted_at_epoch"]) if item.get("deleted_at_epoch") else 0.0
            ),
            reverse=True,
        )
        return web.json_response({"items": entries, "total": len(entries)})

    async def recycle_bin_restore(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        items = data.get("items")
        if not isinstance(items, list):
            raise web.HTTPBadRequest(reason="'items' must be a list")

        recycle_root = request.app.get(RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME)
        restored: list[str] = []
        errors: list[dict[str, str]] = []

        if not recycle_root.exists():
            recycle_root_exists = False
        else:
            recycle_root_exists = True

        for raw in items:
            if not isinstance(raw, str) or not raw.strip():
                errors.append({"item": str(raw), "error": "invalid entry id"})
                continue

            entry_id = raw.strip()
            if not RECYCLE_ID_PATTERN.match(entry_id):
                errors.append({"item": entry_id, "error": "invalid entry id"})
                continue

            if not recycle_root_exists:
                errors.append({"item": entry_id, "error": "recycle bin is empty"})
                continue

            entry_dir = recycle_root / entry_id
            data = _read_recycle_entry(entry_dir)
            if not data:
                errors.append({"item": entry_id, "error": "entry not found"})
                continue

            original_rel = str(data.get("original_path", ""))
            if not original_rel or not _is_safe_relative_path(original_rel):
                errors.append({"item": entry_id, "error": "entry path is invalid"})
                continue

            target_path = recordings_root / original_rel
            try:
                resolved_target = target_path.resolve(strict=False)
            except FileNotFoundError:
                resolved_target = target_path

            try:
                resolved_target.relative_to(recordings_root_resolved)
            except ValueError:
                errors.append({"item": entry_id, "error": "target outside recordings directory"})
                continue

            if target_path.exists():
                errors.append({"item": entry_id, "error": "a file already exists at target"})
                continue

            audio_path = data.get("audio_path")
            if not isinstance(audio_path, Path) or not audio_path.exists():
                errors.append({"item": entry_id, "error": "audio file missing"})
                continue

            try:
                target_path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                errors.append({"item": entry_id, "error": f"unable to prepare destination: {exc}"})
                continue

            completed_moves: list[tuple[Path, Path]] = []
            try:
                shutil.move(str(audio_path), str(target_path))
            except Exception as exc:
                errors.append({"item": entry_id, "error": f"unable to restore audio: {exc}"})
                continue
            else:
                completed_moves.append((target_path, audio_path))

            sidecar_errors: list[str] = []
            restore_failed = False

            waveform_name = data.get("waveform_name")
            if isinstance(waveform_name, str) and waveform_name:
                source = data["dir"] / waveform_name
                destination = target_path.with_suffix(target_path.suffix + ".waveform.json")
                if source.exists():
                    try:
                        shutil.move(str(source), str(destination))
                    except Exception as exc:
                        sidecar_errors.append(f"waveform: {exc}")
                    else:
                        completed_moves.append((destination, source))

            transcript_name = data.get("transcript_name")
            if isinstance(transcript_name, str) and transcript_name:
                source = data["dir"] / transcript_name
                destination = target_path.with_suffix(target_path.suffix + ".transcript.json")
                if source.exists():
                    try:
                        shutil.move(str(source), str(destination))
                    except Exception as exc:
                        sidecar_errors.append(f"transcript: {exc}")
                    else:
                        completed_moves.append((destination, source))

            raw_audio_name_raw = data.get("raw_audio_name")
            raw_audio_name = raw_audio_name_raw.strip() if isinstance(raw_audio_name_raw, str) else ""
            if raw_audio_name and Path(raw_audio_name).name != raw_audio_name:
                sidecar_errors.append("raw audio: invalid filename")
                restore_failed = True

            raw_source: Path | None = None
            raw_destination: Path | None = None
            raw_source_exists = False
            if raw_audio_name:
                raw_source = data["dir"] / raw_audio_name
                raw_source_exists = raw_source.exists()

                raw_audio_rel_raw = data.get("raw_audio_path")
                raw_audio_rel = (
                    raw_audio_rel_raw.strip()
                    if isinstance(raw_audio_rel_raw, str)
                    else ""
                )
                if raw_audio_rel and _is_safe_relative_path(raw_audio_rel):
                    raw_destination = recordings_root / raw_audio_rel
                else:
                    try:
                        target_rel_parts = target_path.relative_to(recordings_root).parts
                    except ValueError:
                        target_rel_parts = ()
                    day_component = ""
                    if target_rel_parts:
                        if (
                            target_rel_parts[0] == SAVED_RECORDINGS_DIRNAME
                            and len(target_rel_parts) > 1
                        ):
                            candidate_day = target_rel_parts[1]
                        else:
                            candidate_day = target_rel_parts[0]
                        if len(candidate_day) == 8 and candidate_day.isdigit():
                            day_component = candidate_day
                    if day_component:
                        raw_destination = (
                            recordings_root
                            / RAW_AUDIO_DIRNAME
                            / day_component
                            / raw_audio_name
                        )

                if raw_source_exists:
                    if raw_destination is None:
                        sidecar_errors.append("raw audio: missing destination path")
                        restore_failed = True
                    else:
                        try:
                            raw_destination.parent.mkdir(parents=True, exist_ok=True)
                        except OSError as exc:
                            sidecar_errors.append(
                                f"raw audio: unable to prepare destination: {exc}"
                            )
                            restore_failed = True
                        else:
                            try:
                                shutil.move(str(raw_source), str(raw_destination))
                            except Exception as exc:
                                sidecar_errors.append(f"raw audio: {exc}")
                                restore_failed = True
                            else:
                                completed_moves.append((raw_destination, raw_source))
                else:
                    sidecar_errors.append("raw audio: source file missing")

            if restore_failed:
                for message in sidecar_errors:
                    errors.append({"item": entry_id, "error": message})
                for destination, source in reversed(completed_moves):
                    try:
                        if destination.exists():
                            source.parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(destination), str(source))
                    except Exception:
                        pass
                continue

            try:
                metadata_path = data.get("metadata_path")
                if isinstance(metadata_path, Path) and metadata_path.exists():
                    metadata_path.unlink()
            except Exception:
                pass

            try:
                shutil.rmtree(data["dir"], ignore_errors=True)
            except Exception:
                pass

            restored.append(original_rel)
            for message in sidecar_errors:
                errors.append({"item": entry_id, "error": message})

        if restored:
            _emit_recordings_changed(
                "restored",
                paths=restored,
                count=len(restored),
            )
        return web.json_response({"restored": restored, "errors": errors})

    async def recycle_bin_purge(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        recycle_root = request.app.get(RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME)
        errors: list[dict[str, str]] = []
        items_value = data.get("items")
        requested_ids: set[str] = set()

        if items_value is not None:
            if not isinstance(items_value, list):
                raise web.HTTPBadRequest(reason="'items' must be a list")
            for raw in items_value:
                if not isinstance(raw, str) or not raw.strip():
                    errors.append({"item": str(raw), "error": "invalid entry id"})
                    continue
                entry_id = raw.strip()
                if not RECYCLE_ID_PATTERN.match(entry_id):
                    errors.append({"item": entry_id, "error": "invalid entry id"})
                    continue
                requested_ids.add(entry_id)

        delete_all = bool(data.get("delete_all"))

        older_than_seconds_raw = data.get("older_than_seconds")
        age_cutoff: float | None = None
        older_than_seconds: float | None = None
        if older_than_seconds_raw is not None:
            try:
                older_than_seconds = float(older_than_seconds_raw)
            except (TypeError, ValueError):
                errors.append({"item": "older_than_seconds", "error": "invalid age"})
            else:
                if older_than_seconds < 0:
                    errors.append({"item": "older_than_seconds", "error": "age must be non-negative"})
                else:
                    age_cutoff = time.time() - older_than_seconds

        if items_value is None and not delete_all and age_cutoff is None:
            raise web.HTTPBadRequest(reason="No purge criteria provided")

        entries_by_id: dict[str, dict[str, object]] = {}
        orphan_entries: dict[str, dict[str, object]] = {}
        if recycle_root.exists():
            try:
                candidates = list(recycle_root.iterdir())
            except OSError:
                candidates = []
            for entry_dir in candidates:
                data = _read_recycle_entry(entry_dir)
                if data:
                    entry_id = str(data.get("id", ""))
                    if entry_id:
                        entries_by_id[entry_id] = data
                    continue

                entry_name = entry_dir.name
                if not entry_name:
                    continue

                metadata_path = entry_dir / RECYCLE_METADATA_FILENAME
                deleted_epoch: float | None = None
                try:
                    deleted_epoch = entry_dir.stat().st_mtime
                except OSError:
                    deleted_epoch = None

                orphan_entries[entry_name] = {
                    "id": entry_name,
                    "dir": entry_dir,
                    "metadata_path": metadata_path if metadata_path.exists() else None,
                    "deleted_at_epoch": deleted_epoch,
                }

        targets: dict[str, dict[str, object]] = {}

        if delete_all:
            targets.update(entries_by_id)
            for entry_id, entry_data in orphan_entries.items():
                targets.setdefault(entry_id, entry_data)

        if age_cutoff is not None:
            for entry_id, entry_data in entries_by_id.items():
                deleted_epoch = entry_data.get("deleted_at_epoch")
                if isinstance(deleted_epoch, (int, float)) and deleted_epoch <= age_cutoff:
                    targets.setdefault(entry_id, entry_data)
            for entry_id, entry_data in orphan_entries.items():
                deleted_epoch = entry_data.get("deleted_at_epoch")
                if isinstance(deleted_epoch, (int, float)) and deleted_epoch <= age_cutoff:
                    targets.setdefault(entry_id, entry_data)

        for entry_id in sorted(requested_ids):
            entry_data = entries_by_id.get(entry_id)
            if not entry_data:
                entry_data = orphan_entries.get(entry_id)
            if not entry_data:
                errors.append({"item": entry_id, "error": "entry not found"})
                continue
            targets.setdefault(entry_id, entry_data)

        purged: list[str] = []
        for entry_id in sorted(targets):
            entry_data = targets[entry_id]
            entry_dir = entry_data.get("dir")
            if not isinstance(entry_dir, Path):
                errors.append({"item": entry_id, "error": "entry directory unavailable"})
                continue
            try:
                shutil.rmtree(entry_dir)
            except FileNotFoundError:
                purged.append(entry_id)
            except Exception as exc:
                errors.append({"item": entry_id, "error": f"unable to purge entry: {exc}"})
                continue
            else:
                purged.append(entry_id)

        if recycle_root.exists():
            try:
                next(recycle_root.iterdir())
            except StopIteration:
                try:
                    recycle_root.rmdir()
                except OSError:
                    pass
            except OSError:
                pass

        if purged:
            extra: dict[str, object] = {
                "entries": purged,
                "count": len(purged),
            }
            if delete_all:
                extra["delete_all"] = True
            if older_than_seconds is not None:
                extra["older_than_seconds"] = older_than_seconds
            if requested_ids:
                extra["entry_ids"] = sorted(requested_ids)
            _emit_recordings_changed("recycle_purged", **extra)

        return web.json_response({"purged": purged, "errors": errors})

    async def recycle_bin_file(request: web.Request) -> web.StreamResponse:
        entry_id = request.match_info.get("entry_id", "").strip()
        if not entry_id or not RECYCLE_ID_PATTERN.match(entry_id):
            raise web.HTTPNotFound()

        recycle_root = request.app.get(RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME)
        entry_dir = recycle_root / entry_id
        data = _read_recycle_entry(entry_dir)
        if not data:
            raise web.HTTPNotFound()

        audio_path = data.get("audio_path")
        if not isinstance(audio_path, Path) or not audio_path.is_file():
            raise web.HTTPNotFound()

        serve_raw = request.rel_url.query.get("raw") == "1"
        download_flag = request.rel_url.query.get("download") == "1"

        target_path = audio_path
        if serve_raw:
            raw_candidate = data.get("raw_audio_bin_path")
            if isinstance(raw_candidate, Path) and raw_candidate.is_file():
                target_path = raw_candidate
            else:
                raise web.HTTPNotFound()

        response = web.FileResponse(target_path)
        disposition = "attachment" if download_flag else "inline"
        response.headers["Content-Disposition"] = f'{disposition}; filename="{target_path.name}"'
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    async def recycle_bin_waveform(request: web.Request) -> web.Response:
        entry_id = request.match_info.get("entry_id", "").strip()
        if not entry_id or not RECYCLE_ID_PATTERN.match(entry_id):
            raise web.HTTPNotFound()

        recycle_root = request.app.get(RECYCLE_BIN_ROOT_KEY, recordings_root / RECYCLE_BIN_DIRNAME)
        entry_dir = recycle_root / entry_id
        data = _read_recycle_entry(entry_dir)
        if not data:
            raise web.HTTPNotFound()

        waveform_name = data.get("waveform_name")
        if not isinstance(waveform_name, str) or not waveform_name:
            raise web.HTTPNotFound()

        waveform_path = entry_dir / waveform_name
        try:
            with waveform_path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError as exc:
            raise web.HTTPNotFound() from exc
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Unable to read recycle bin waveform %s: %s", waveform_path, exc)
            raise web.HTTPNotFound() from exc

        response = web.json_response(payload)
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    async def recordings_rename(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        raw_item = data.get("item")
        if not isinstance(raw_item, str) or not raw_item.strip():
            raise web.HTTPBadRequest(reason="'item' must be a non-empty string")

        raw_name = data.get("name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise web.HTTPBadRequest(reason="'name' must be a non-empty string")

        rel_item = raw_item.strip().strip("/")
        candidate = recordings_root / rel_item
        try:
            source_resolved = candidate.resolve()
        except FileNotFoundError as exc:
            raise web.HTTPNotFound(reason="recording not found") from exc
        except Exception as exc:
            raise web.HTTPBadRequest(reason=str(exc)) from exc

        try:
            source_resolved.relative_to(recordings_root_resolved)
        except ValueError as exc:
            raise web.HTTPBadRequest(reason="outside recordings directory") from exc

        if not source_resolved.is_file():
            raise web.HTTPNotFound(reason="recording not found")

        if _path_is_partial(source_resolved):
            raise web.HTTPConflict(reason="recording in progress")

        new_name = raw_name.strip()
        if new_name in {".", ".."}:
            raise web.HTTPBadRequest(reason="name is invalid")
        if any(sep in new_name for sep in ("/", "\\", os.sep)):
            raise web.HTTPBadRequest(reason="name cannot contain path separators")
        name_component = Path(new_name).name
        if name_component != new_name:
            raise web.HTTPBadRequest(reason="name cannot contain path separators")

        if clip_safe_pattern.sub("_", name_component) != name_component:
            raise web.HTTPBadRequest(reason="name contains unsupported characters")

        extension_override = None
        extension_value = data.get("extension")
        if isinstance(extension_value, str):
            stripped = extension_value.strip()
            if stripped:
                extension_override = stripped if stripped.startswith(".") else f".{stripped}"

        candidate_path = Path(name_component)
        name_has_suffix = bool(candidate_path.suffix)
        base_stem = candidate_path.stem if name_has_suffix else candidate_path.name

        suffix = extension_override
        if suffix is None:
            suffix = candidate_path.suffix if name_has_suffix else source_resolved.suffix
        if suffix and not suffix.startswith("."):
            suffix = f".{suffix}"
        suffix = suffix or ""

        if name_has_suffix and extension_override is None:
            target_filename = candidate_path.name
        else:
            target_filename = f"{base_stem}{suffix}"

        target_path = source_resolved.with_name(target_filename)
        try:
            target_resolved = target_path.resolve()
        except FileNotFoundError:
            target_resolved = target_path
        except Exception as exc:
            raise web.HTTPBadRequest(reason=str(exc)) from exc

        try:
            target_resolved.relative_to(recordings_root_resolved)
        except ValueError as exc:
            raise web.HTTPBadRequest(reason="name resolves outside recordings directory") from exc

        old_rel = source_resolved.relative_to(recordings_root_resolved).as_posix()
        new_rel = target_resolved.relative_to(recordings_root_resolved).as_posix()

        name_payload = Path(target_filename).stem
        extension_payload = target_resolved.suffix.lstrip(".")

        if target_resolved == source_resolved:
            return web.json_response(
                {
                    "old_path": old_rel,
                    "new_path": new_rel,
                    "name": name_payload,
                    "extension": extension_payload,
                    "path": new_rel,
                }
            )

        if target_resolved.exists():
            raise web.HTTPConflict(reason="target already exists")

        try:
            os.replace(source_resolved, target_resolved)
        except FileNotFoundError as exc:
            raise web.HTTPNotFound(reason="recording not found") from exc
        except FileExistsError:
            raise web.HTTPConflict(reason="target already exists")
        except Exception as exc:  # pragma: no cover - unexpected filesystem errors
            raise web.HTTPBadRequest(reason=str(exc)) from exc

        waveform_src = source_resolved.with_suffix(source_resolved.suffix + ".waveform.json")
        waveform_dest = target_resolved.with_suffix(target_resolved.suffix + ".waveform.json")
        if waveform_src.exists():
            try:
                os.replace(waveform_src, waveform_dest)
            except Exception:
                pass

        transcript_src = source_resolved.with_suffix(source_resolved.suffix + ".transcript.json")
        transcript_dest = target_resolved.with_suffix(target_resolved.suffix + ".transcript.json")
        if transcript_src.exists():
            try:
                os.replace(transcript_src, transcript_dest)
            except Exception:
                pass

        _emit_recordings_changed(
            "renamed",
            old_path=old_rel,
            new_path=new_rel,
            name=name_payload,
            extension=extension_payload,
        )
        return web.json_response(
            {
                "old_path": old_rel,
                "new_path": new_rel,
                "name": name_payload,
                "extension": extension_payload,
                "path": new_rel,
            }
        )

    async def recordings_bulk_download(request: web.Request) -> web.StreamResponse:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        items = data.get("items")
        if not isinstance(items, list) or not items:
            raise web.HTTPBadRequest(reason="'items' must be a non-empty list")

        errors: list[dict[str, str]] = []
        selected: dict[str, Path] = {}
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
            except Exception as exc:
                errors.append({"item": rel, "error": str(exc)})
                continue

            try:
                resolved.relative_to(recordings_root_resolved)
            except ValueError:
                errors.append({"item": rel, "error": "outside recordings directory"})
                continue

            if not resolved.is_file():
                errors.append({"item": rel, "error": "not a file"})
                continue

            key = rel.replace(os.sep, "/")
            if key not in selected:
                selected[key] = resolved

        if errors:
            return web.json_response({"errors": errors}, status=400)

        if not selected:
            return web.json_response(
                {"errors": [{"item": "", "error": "no valid recordings"}]}, status=400
            )

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        archive_name = f"tricorder-recordings-{timestamp}.zip"

        tmp_dir = Path(tmp_root)
        try:
            tmp_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            tmp_dir = Path(tempfile.gettempdir())

        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".zip", dir=tmp_dir)
        archive_path = Path(temp_file.name)
        temp_file.close()

        try:
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for rel, resolved in selected.items():
                    arcname = Path(rel).as_posix()
                    try:
                        archive.write(resolved, arcname=arcname)
                    except FileNotFoundError:
                        continue
                    for suffix in (".waveform.json", ".transcript.json"):
                        sidecar = resolved.with_suffix(resolved.suffix + suffix)
                        if sidecar.is_file():
                            try:
                                archive.write(sidecar, arcname=f"{arcname}{suffix}")
                            except FileNotFoundError:
                                pass

            response = web.StreamResponse(
                status=200,
                headers={
                    "Content-Type": "application/zip",
                    "Content-Disposition": f'attachment; filename="{archive_name}"',
                },
            )
            await response.prepare(request)
            with archive_path.open("rb") as handle:
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    await response.write(chunk)
            await response.write_eof()
            return response
        except Exception as exc:
            raise web.HTTPInternalServerError(reason=str(exc)) from exc
        finally:
            try:
                archive_path.unlink()
            except Exception:
                pass

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
        overwrite_value = data.get("overwrite_existing")
        overwrite_existing = (
            str(overwrite_value)
            if isinstance(overwrite_value, str) and overwrite_value.strip()
            else None
        )

        loop = asyncio.get_running_loop()
        clip_executor = request.app.get(CLIP_EXECUTOR_KEY)
        executor = clip_executor if isinstance(clip_executor, ThreadPoolExecutor) else None
        try:
            allow_overwrite = _to_bool(data.get("allow_overwrite"), True)
            payload = await loop.run_in_executor(
                executor,
                functools.partial(
                    _create_clip_sync,
                    source_path,
                    start_value,
                    end_value,
                    clip_name,
                    source_start_epoch,
                    allow_overwrite,
                    overwrite_existing,
                ),
            )
        except ClipError as exc:
            raise web.HTTPBadRequest(reason=str(exc)) from exc
        except Exception as exc:  # pragma: no cover - unexpected failures
            log.exception("Unexpected error while creating clip for %s", source_path)
            raise web.HTTPInternalServerError(reason="unable to create clip") from exc

        clip_path = payload.get("path")
        if isinstance(clip_path, str) and clip_path:
            _emit_recordings_changed("clipped", paths=[clip_path])
        else:
            _emit_recordings_changed("clipped")

        return web.json_response(payload)

    async def recordings_clip_undo(request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(reason=f"Invalid JSON: {exc}") from exc

        token_value = data.get("token")
        if not isinstance(token_value, str) or not token_value.strip():
            raise web.HTTPBadRequest(reason="token must be a string")

        loop = asyncio.get_running_loop()
        try:
            payload = await loop.run_in_executor(
                None, functools.partial(_restore_clip_backup, token_value)
            )
        except ClipUndoError as exc:
            if exc.status == 404:
                raise web.HTTPNotFound(reason=str(exc)) from exc
            raise web.HTTPBadRequest(reason=str(exc)) from exc
        except Exception as exc:  # pragma: no cover - unexpected failures
            log.exception("Unexpected error while restoring clip for token %s", token_value)
            raise web.HTTPInternalServerError(reason="unable to restore clip") from exc

        clip_path = payload.get("path")
        if isinstance(clip_path, str) and clip_path:
            _emit_recordings_changed("clip_restored", paths=[clip_path])
        else:
            _emit_recordings_changed("clip_restored")

        return web.json_response(payload)

    async def _stream_partial_file(
        request: web.Request, resolved: Path
    ) -> web.StreamResponse:
        loop = asyncio.get_running_loop()
        deadline = time.monotonic() + STREAMING_OPEN_TIMEOUT_SECONDS
        handle: io.BufferedReader | None = None

        while handle is None:
            try:
                handle = resolved.open("rb", buffering=0)
            except FileNotFoundError as exc:
                if time.monotonic() >= deadline:
                    raise web.HTTPNotFound() from exc
                await asyncio.sleep(0.1)
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise web.HTTPServiceUnavailable(text=str(exc)) from exc
                await asyncio.sleep(0.1)

        suffixes = resolved.suffixes
        container = suffixes[-1].lower() if suffixes else ""
        if container == ".webm":
            content_type = "audio/webm"
        else:
            content_type = "audio/ogg"

        response = web.StreamResponse(status=200)
        response.headers["Content-Type"] = content_type
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["Content-Disposition"] = (
            f'inline; filename="{resolved.name}"'
        )
        await response.prepare(request)

        try:
            while True:
                chunk = await loop.run_in_executor(None, handle.read, 32768)
                if chunk:
                    try:
                        await response.write(chunk)
                    except (
                        ConnectionResetError,
                        ConnectionAbortedError,
                        BrokenPipeError,
                        ConnectionError,
                    ):
                        break
                    continue

                if not resolved.exists():
                    break
                await asyncio.sleep(STREAMING_POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        finally:
            with contextlib.suppress(Exception):
                handle.close()
            with contextlib.suppress(Exception):
                await response.write_eof()

        return response

    async def _serve_partial_json(
        request: web.Request, resolved: Path
    ) -> web.StreamResponse:
        loop = asyncio.get_running_loop()
        try:
            data = await loop.run_in_executor(None, resolved.read_bytes)
        except FileNotFoundError as exc:
            raise web.HTTPNotFound() from exc
        except OSError as exc:
            raise web.HTTPServiceUnavailable(text=str(exc)) from exc

        response = web.Response(body=data)
        response.content_type = "application/json"
        response.charset = "utf-8"
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["Content-Disposition"] = (
            f'inline; filename="{resolved.name}"'
        )
        return response

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

        if _path_is_partial(resolved):
            if resolved.suffix.lower() == ".json":
                return await _serve_partial_json(request, resolved)
            return await _stream_partial_file(request, resolved)

        if not resolved.is_file():
            raise web.HTTPNotFound()

        response = web.FileResponse(resolved)
        disposition = "attachment" if request.rel_url.query.get("download") == "1" else "inline"
        response.headers["Content-Disposition"] = f'{disposition}; filename="{resolved.name}"'
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    async def config_snapshot(_: web.Request) -> web.Response:
        refreshed = reload_cfg()
        payload = dict(refreshed)
        try:
            payload["config_path"] = str(primary_config_path())
        except Exception:
            payload["config_path"] = None
        return web.json_response(payload)

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
        _emit_config_updated("archival")
        return web.json_response(payload)

    recorder_unit = VOICE_RECORDER_SERVICE_UNIT
    web_streamer_unit = "web-streamer.service"
    section_restart_units: dict[str, Sequence[str]] = {
        "audio": [recorder_unit],
        "segmenter": [recorder_unit],
        "adaptive_rms": [recorder_unit],
        "ingest": ["dropbox.path", "dropbox.service"],
        "transcription": [recorder_unit],
        "logging": [recorder_unit],
        "streaming": [recorder_unit, web_streamer_unit],
        "dashboard": [web_streamer_unit],
        "web_server": [web_streamer_unit],
        "paths": [recorder_unit, "dropbox.path", "dropbox.service", web_streamer_unit],
        "notifications": [recorder_unit],
    }

    async def _settings_get(
        section: str, canonical_fn
    ) -> web.Response:
        refreshed = reload_cfg()
        payload = _config_section_payload(section, refreshed, canonical_fn)
        return web.json_response(payload)

    async def _settings_update(
        request: web.Request,
        *,
        section: str,
        section_label: str,
        normalize,
        update_func,
        canonical_fn,
    ) -> web.Response:
        log = logging.getLogger("web_streamer")
        try:
            data = await request.json()
        except Exception as exc:
            message = f"Invalid JSON payload: {exc}"
            return web.json_response({"error": message}, status=400)

        normalized, errors = normalize(data)
        if errors:
            message = errors[0]
            return web.json_response({"error": message, "errors": errors}, status=400)

        try:
            update_func(normalized)
        except ConfigPersistenceError as exc:
            log.warning("Unable to persist %s settings: %s", section, exc)
            return web.json_response(
                {"error": f"Unable to save {section_label} settings: {exc}"},
                status=500,
            )
        except Exception as exc:  # pragma: no cover - defensive logging
            log.exception("Unexpected %s settings failure: %s", section, exc)
            return web.json_response(
                {"error": f"Unexpected error while saving {section_label} settings"},
                status=500,
            )

        cfg_snapshot = get_cfg()
        payload = _config_section_payload(section, cfg_snapshot, canonical_fn)
        restart_units = section_restart_units.get(section, [])
        payload["restart_results"] = await _restart_units(restart_units)
        _emit_config_updated(section)
        return web.json_response(payload)

    async def config_audio_get(request: web.Request) -> web.Response:
        return await _settings_get("audio", _canonical_audio_settings)

    async def config_audio_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="audio",
            section_label="audio",
            normalize=_normalize_audio_payload,
            update_func=update_audio_settings,
            canonical_fn=_canonical_audio_settings,
        )

    async def config_paths_get(request: web.Request) -> web.Response:
        return await _settings_get("paths", _canonical_paths_settings)

    async def config_paths_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="paths",
            section_label="paths",
            normalize=_normalize_paths_payload,
            update_func=update_paths_settings,
            canonical_fn=_canonical_paths_settings,
        )

    async def config_segmenter_get(request: web.Request) -> web.Response:
        return await _settings_get("segmenter", _canonical_segmenter_settings)

    async def config_segmenter_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="segmenter",
            section_label="segmenter",
            normalize=_normalize_segmenter_payload,
            update_func=update_segmenter_settings,
            canonical_fn=_canonical_segmenter_settings,
        )

    async def config_adaptive_rms_get(request: web.Request) -> web.Response:
        return await _settings_get("adaptive_rms", _canonical_adaptive_rms_settings)

    async def config_adaptive_rms_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="adaptive_rms",
            section_label="adaptive RMS",
            normalize=_normalize_adaptive_rms_payload,
            update_func=update_adaptive_rms_settings,
            canonical_fn=_canonical_adaptive_rms_settings,
        )

    async def config_ingest_get(request: web.Request) -> web.Response:
        return await _settings_get("ingest", _canonical_ingest_settings)

    async def config_ingest_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="ingest",
            section_label="ingest",
            normalize=_normalize_ingest_payload,
            update_func=update_ingest_settings,
            canonical_fn=_canonical_ingest_settings,
        )

    async def config_transcription_get(request: web.Request) -> web.Response:
        return await _settings_get("transcription", _canonical_transcription_settings)

    async def config_transcription_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="transcription",
            section_label="transcription",
            normalize=_normalize_transcription_payload,
            update_func=update_transcription_settings,
            canonical_fn=_canonical_transcription_settings,
        )

    async def transcription_models_get(request: web.Request) -> web.Response:
        payload = _discover_transcription_models()
        return web.json_response(payload)

    async def config_logging_get(request: web.Request) -> web.Response:
        return await _settings_get("logging", _canonical_logging_settings)

    async def config_logging_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="logging",
            section_label="logging",
            normalize=_normalize_logging_payload,
            update_func=update_logging_settings,
            canonical_fn=_canonical_logging_settings,
        )

    async def config_notifications_get(request: web.Request) -> web.Response:
        return await _settings_get("notifications", _canonical_notifications_settings)

    async def config_notifications_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="notifications",
            section_label="notifications",
            normalize=_normalize_notifications_payload,
            update_func=update_notifications_settings,
            canonical_fn=_canonical_notifications_settings,
        )

    async def config_streaming_get(request: web.Request) -> web.Response:
        return await _settings_get("streaming", _canonical_streaming_settings)

    async def config_streaming_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="streaming",
            section_label="streaming",
            normalize=_normalize_streaming_payload,
            update_func=update_streaming_settings,
            canonical_fn=_canonical_streaming_settings,
        )

    async def config_dashboard_get(request: web.Request) -> web.Response:
        return await _settings_get("dashboard", _canonical_dashboard_settings)

    async def config_dashboard_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="dashboard",
            section_label="dashboard",
            normalize=_normalize_dashboard_payload,
            update_func=update_dashboard_settings,
            canonical_fn=_canonical_dashboard_settings,
        )

    async def config_web_server_get(request: web.Request) -> web.Response:
        return await _settings_get("web_server", _canonical_web_server_settings)

    async def config_web_server_update(request: web.Request) -> web.Response:
        return await _settings_update(
            request,
            section="web_server",
            section_label="web server",
            normalize=_normalize_web_server_payload,
            update_func=update_web_server_settings,
            canonical_fn=_canonical_web_server_settings,
        )

    SYSTEM_HEALTH_EVENT_INTERVAL_SECONDS = 3.0
    SYSTEM_HEALTH_EVENT_MAX_STALE_SECONDS = 30.0

    cpu_last_sample: tuple[int, int] | None = None
    cpu_last_percent: float | None = None
    cpu_core_count = max(os.cpu_count() or 1, 1)

    def _read_cpu_sample() -> tuple[int, int] | None:
        try:
            with open("/proc/stat", "r", encoding="utf-8") as handle:
                line = handle.readline()
        except OSError:
            return None

        parts = line.split()
        if not parts or parts[0] != "cpu":
            return None

        try:
            values = [int(part) for part in parts[1:8]]
        except ValueError:
            return None

        if not values:
            return None

        idle = values[3] if len(values) >= 4 else 0
        iowait = values[4] if len(values) >= 5 else 0
        total = sum(values)
        return total, idle + iowait

    def _read_memory_stats() -> dict[str, float | int | None] | None:
        total_kib: int | None = None
        available_kib: int | None = None
        free_kib: int | None = None

        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("MemTotal:"):
                        parts = line.split()
                        if len(parts) >= 2:
                            total_kib = int(parts[1])
                    elif line.startswith("MemAvailable:"):
                        parts = line.split()
                        if len(parts) >= 2:
                            available_kib = int(parts[1])
                    elif line.startswith("MemFree:") and free_kib is None:
                        parts = line.split()
                        if len(parts) >= 2:
                            free_kib = int(parts[1])

                    if total_kib is not None and available_kib is not None:
                        break
        except (OSError, ValueError):
            return None

        if total_kib is None or total_kib <= 0:
            return None

        if available_kib is None:
            available_kib = free_kib

        total_bytes = total_kib * 1024
        available_bytes = available_kib * 1024 if available_kib is not None else None
        used_bytes = None
        percent = None

        if available_bytes is not None:
            used_bytes = max(total_bytes - available_bytes, 0)
            if total_bytes > 0:
                percent = (used_bytes / total_bytes) * 100.0

        return {
            "total_bytes": total_bytes,
            "available_bytes": available_bytes,
            "used_bytes": used_bytes,
            "percent": percent,
        }

    def _read_device_temperature() -> dict[str, float | str | None] | None:
        def _iter_zone_paths() -> list[Path]:
            seen: set[Path] = set()
            zones: list[Path] = []
            for base in (Path("/sys/class/thermal"), Path("/sys/devices/virtual/thermal")):
                if not base.exists():
                    continue
                for temp_path in sorted(base.glob("thermal_zone*/temp")):
                    if temp_path in seen:
                        continue
                    seen.add(temp_path)
                    zones.append(temp_path)
            return zones

        best: dict[str, float | str | None] | None = None
        fallback: dict[str, float | str | None] | None = None

        for temp_path in _iter_zone_paths():
            label: str | None = None
            type_path = temp_path.with_name("type")
            try:
                raw_label = type_path.read_text(encoding="utf-8").strip()
            except OSError:
                raw_label = ""
            if raw_label:
                label = raw_label

            try:
                raw_value = temp_path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if not raw_value:
                continue

            try:
                numeric_value = float(raw_value)
            except ValueError:
                continue

            if numeric_value > 1000.0:
                celsius = numeric_value / 1000.0
            else:
                celsius = numeric_value

            if not math.isfinite(celsius):
                continue

            fahrenheit = (celsius * 9.0 / 5.0) + 32.0
            sensor_name = label or temp_path.parent.name
            reading: dict[str, float | str | None] = {
                "celsius": celsius,
                "fahrenheit": fahrenheit,
                "sensor": sensor_name,
            }

            normalized_label = (label or "").lower()
            if normalized_label:
                if "cpu" in normalized_label or "soc" in normalized_label:
                    best = reading
                    break
            if fallback is None:
                fallback = reading

        return best or fallback

    def _collect_system_health_snapshot() -> dict[str, Any]:
        nonlocal cpu_last_sample, cpu_last_percent

        state = sd_card_health.load_state()
        payload: dict[str, Any] = {
            "generated_at": time.time(),
            "sd_card": sd_card_health.state_summary(state),
        }

        cpu_percent: float | None = None
        cpu_load_1m: float | None = None
        cpu_sample = _read_cpu_sample()

        if cpu_sample is not None:
            total, idle_all = cpu_sample
            if cpu_last_sample is not None:
                last_total, last_idle = cpu_last_sample
                total_delta = total - last_total
                idle_delta = idle_all - last_idle
                busy_delta = total_delta - idle_delta
                if total_delta > 0:
                    cpu_percent = max(0.0, min(100.0, (busy_delta / total_delta) * 100.0))

            cpu_last_sample = cpu_sample
            if cpu_percent is not None:
                cpu_last_percent = cpu_percent

        try:
            load_1m, _load_5m, _load_15m = os.getloadavg()
            cpu_load_1m = float(load_1m)
        except (AttributeError, OSError):
            cpu_load_1m = None

        if cpu_percent is None:
            if cpu_last_percent is not None:
                cpu_percent = cpu_last_percent
            elif cpu_load_1m is not None and cpu_core_count > 0:
                cpu_percent = max(0.0, min(100.0, (cpu_load_1m / cpu_core_count) * 100.0))

        memory_stats = _read_memory_stats()
        memory_percent = None
        memory_total = None
        memory_available = None
        memory_used = None

        if memory_stats is not None:
            memory_percent = memory_stats.get("percent")
            memory_total = memory_stats.get("total_bytes")
            memory_available = memory_stats.get("available_bytes")
            memory_used = memory_stats.get("used_bytes")

        temperature_stats = _read_device_temperature()
        if temperature_stats is None:
            temperature_payload: dict[str, Any] = {
                "celsius": None,
                "fahrenheit": None,
                "sensor": None,
            }
        else:
            temperature_payload = {
                "celsius": temperature_stats.get("celsius"),
                "fahrenheit": temperature_stats.get("fahrenheit"),
                "sensor": temperature_stats.get("sensor"),
            }

        payload["resources"] = {
            "cpu": {
                "percent": cpu_percent,
                "load_1m": cpu_load_1m,
                "cores": cpu_core_count,
            },
            "memory": {
                "percent": memory_percent,
                "total_bytes": memory_total,
                "available_bytes": memory_available,
                "used_bytes": memory_used,
            },
            "temperature": temperature_payload,
        }

        return payload

    def _system_health_fingerprint(snapshot: dict[str, Any]) -> tuple[Any, ...]:
        resources = snapshot.get("resources") or {}
        cpu = resources.get("cpu") or {}
        memory = resources.get("memory") or {}
        temperature = resources.get("temperature") or {}
        sd_state = snapshot.get("sd_card") or {}
        last_event = ""
        sd_last_event = sd_state.get("last_event")
        if isinstance(sd_last_event, dict):
            last_event = str(sd_last_event.get("timestamp") or sd_last_event.get("message") or "")

        def _round_percent(value: Any) -> float | None:
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                return None
            return round(numeric, 1)

        def _round_temperature(value: Any) -> float | None:
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                return None
            return round(numeric, 1)

        return (
            _round_percent(cpu.get("percent")),
            _round_percent(memory.get("percent")),
            _round_temperature(temperature.get("celsius")),
            bool(sd_state.get("warning_active")),
            last_event,
        )

    class _SystemHealthBroadcaster:
        def __init__(self, interval_seconds: float = SYSTEM_HEALTH_EVENT_INTERVAL_SECONDS) -> None:
            self._interval = max(0.5, float(interval_seconds))
            self._task: asyncio.Task | None = None
            self._last_fingerprint: tuple[Any, ...] | None = None
            self._last_emit: float = 0.0

        async def start(self) -> None:
            if self._task is not None:
                return
            loop = asyncio.get_running_loop()
            self._task = loop.create_task(self._run())

        async def stop(self) -> None:
            task = self._task
            if task is None:
                return
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            self._task = None

        def note_snapshot(self, snapshot: dict[str, Any]) -> None:
            fingerprint = _system_health_fingerprint(snapshot)
            self._last_fingerprint = fingerprint
            generated_at = snapshot.get("generated_at")
            try:
                self._last_emit = max(self._last_emit, float(generated_at))
            except (TypeError, ValueError):
                self._last_emit = time.time()

        async def _run(self) -> None:
            try:
                while True:
                    await asyncio.sleep(self._interval)
                    snapshot = await asyncio.to_thread(_collect_system_health_snapshot)
                    if not isinstance(snapshot, dict):
                        continue
                    self._maybe_emit(snapshot)
            except asyncio.CancelledError:  # pragma: no cover - shutdown path
                raise

        def _maybe_emit(self, snapshot: dict[str, Any]) -> None:
            fingerprint = _system_health_fingerprint(snapshot)
            now = snapshot.get("generated_at")
            try:
                timestamp = float(now)
            except (TypeError, ValueError):
                timestamp = time.time()

            should_emit = fingerprint != self._last_fingerprint
            if not should_emit and (timestamp - self._last_emit) >= SYSTEM_HEALTH_EVENT_MAX_STALE_SECONDS:
                should_emit = True

            if not should_emit:
                return

            self._last_fingerprint = fingerprint
            self._last_emit = timestamp
            _publish_dashboard_event(
                "system_health_updated",
                {"updated_at": timestamp},
            )

    health_broadcaster = _SystemHealthBroadcaster()
    app["system_health_broadcaster"] = health_broadcaster

    async def system_health(_: web.Request) -> web.Response:
        payload = _collect_system_health_snapshot()
        health_broadcaster.note_snapshot(payload)
        return web.json_response(payload, headers={"Cache-Control": "no-store"})

    async def dashboard_events_stream(request: web.Request) -> web.StreamResponse:
        bus = request.app.get(EVENT_BUS_KEY)
        if bus is None:
            raise web.HTTPServiceUnavailable(reason="event stream unavailable")

        last_event_id = request.headers.get("Last-Event-ID") or request.query.get(
            "last_event_id", ""
        )
        queue = await bus.subscribe(last_event_id=last_event_id)

        response = web.StreamResponse(
            status=200,
            headers={
                "Cache-Control": "no-store",
                "Content-Type": "text/event-stream",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)

        logger = logging.getLogger("web_streamer")
        heartbeat_deadline = time.monotonic() + EVENT_STREAM_HEARTBEAT_SECONDS
        heartbeat_chunk = b"event: heartbeat\ndata: {}\n\n"

        try:
            await response.write(f"retry: {EVENT_STREAM_RETRY_MILLIS}\n\n".encode("utf-8"))
            while True:
                remaining = heartbeat_deadline - time.monotonic()
                if remaining <= 0:
                    try:
                        await response.write(heartbeat_chunk)
                    except ConnectionResetError:
                        break
                    heartbeat_deadline = time.monotonic() + EVENT_STREAM_HEARTBEAT_SECONDS
                    continue

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    try:
                        await response.write(heartbeat_chunk)
                    except ConnectionResetError:
                        break
                    heartbeat_deadline = time.monotonic() + EVENT_STREAM_HEARTBEAT_SECONDS
                    continue
                except asyncio.CancelledError:
                    raise

                if event is None:
                    heartbeat_deadline = time.monotonic() + EVENT_STREAM_HEARTBEAT_SECONDS
                    continue

                payload = event.get("payload")
                try:
                    data_text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
                except (TypeError, ValueError) as exc:
                    logger.warning(
                        "Failed to serialize dashboard event %s: %s",
                        event.get("type"),
                        exc,
                    )
                    heartbeat_deadline = time.monotonic() + EVENT_STREAM_HEARTBEAT_SECONDS
                    continue

                buffer_parts = [f"id: {event['id']}\n", f"event: {event['type']}\n"]
                lines = data_text.splitlines() or [""]
                buffer_parts.extend(f"data: {line}\n" for line in lines)
                buffer_parts.append("\n")

                try:
                    await response.write("".join(buffer_parts).encode("utf-8"))
                except ConnectionResetError:
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # pragma: no cover - transport quirks
                    logger.debug("dashboard SSE write failed: %s", exc)
                    break

                heartbeat_deadline = time.monotonic() + EVENT_STREAM_HEARTBEAT_SECONDS
        finally:
            bus.unsubscribe(queue)
            with contextlib.suppress(Exception):
                await response.write_eof()

        return response

    async def services_list(request: web.Request) -> web.Response:
        entries = request.app.get(SERVICE_ENTRIES_KEY, [])
        auto_restart = request.app.get(AUTO_RESTART_KEY, set())
        if not entries:
            return web.json_response({"services": [], "updated_at": time.time()})
        state = request.app.get(AUTO_RESTART_STATE_KEY)
        results = await asyncio.gather(
            *(
                _collect_service_state(
                    entry,
                    auto_restart,
                    auto_restart_state=state,
                )
                for entry in entries
            )
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

        if executed_action in {"stop", "restart"}:
            _kick_auto_restart_units(auto_restart, skip={unit})

        state = request.app.get(AUTO_RESTART_STATE_KEY)
        status = await _collect_service_state(
            entry_map[unit],
            auto_restart,
            auto_restart_state=state,
        )
        response["status"] = status
        return web.json_response(response)

    async def capture_split(_: web.Request) -> web.Response:
        code, stdout_text, stderr_text = await _run_systemctl(
            ["kill", "--signal=USR1", VOICE_RECORDER_SERVICE_UNIT]
        )
        if code != 0:
            message = stderr_text.strip() or stdout_text.strip() or f"systemctl exited with {code}"
            return web.json_response({"ok": False, "error": message}, status=502)
        return web.json_response({"ok": True})

    async def capture_auto_record(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

        raw_enabled = payload.get("enabled") if isinstance(payload, dict) else None
        enabled: bool | None
        if isinstance(raw_enabled, bool):
            enabled = raw_enabled
        elif isinstance(raw_enabled, (int, float)):
            enabled = bool(raw_enabled)
        elif isinstance(raw_enabled, str):
            normalized = raw_enabled.strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                enabled = True
            elif normalized in {"0", "false", "no", "off"}:
                enabled = False
            else:
                enabled = None
        else:
            enabled = None

        if enabled is None:
            return web.json_response(
                {"ok": False, "error": "Payload must include boolean 'enabled'"},
                status=400,
            )

        try:
            os.makedirs(os.path.dirname(auto_record_state_path), exist_ok=True)
            with open(auto_record_state_path, "w", encoding="utf-8") as handle:
                json.dump({"enabled": bool(enabled), "updated_at": time.time()}, handle)
                handle.write("\n")
        except OSError as exc:
            return web.json_response(
                {
                    "ok": False,
                    "error": f"Failed to update auto record state: {exc}",
                },
                status=500,
            )

        return web.json_response({"ok": True, "enabled": bool(enabled)})

    async def capture_manual_record(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

        raw_enabled = payload.get("enabled") if isinstance(payload, dict) else None
        enabled: bool | None
        if isinstance(raw_enabled, bool):
            enabled = raw_enabled
        elif isinstance(raw_enabled, (int, float)):
            enabled = bool(raw_enabled)
        elif isinstance(raw_enabled, str):
            normalized = raw_enabled.strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                enabled = True
            elif normalized in {"0", "false", "no", "off"}:
                enabled = False
            else:
                enabled = None
        else:
            enabled = None

        if enabled is None:
            return web.json_response(
                {"ok": False, "error": "Payload must include boolean 'enabled'"},
                status=400,
            )

        try:
            os.makedirs(os.path.dirname(manual_record_state_path), exist_ok=True)
            with open(manual_record_state_path, "w", encoding="utf-8") as handle:
                json.dump({"enabled": bool(enabled), "updated_at": time.time()}, handle)
                handle.write("\n")
        except OSError as exc:
            return web.json_response(
                {
                    "ok": False,
                    "error": f"Failed to update manual record state: {exc}",
                },
                status=500,
            )

        return web.json_response({"ok": True, "enabled": bool(enabled)})

    async def capture_stop(_: web.Request) -> web.Response:
        try:
            os.makedirs(os.path.dirname(manual_stop_request_path), exist_ok=True)
            with open(manual_stop_request_path, "w", encoding="utf-8") as handle:
                json.dump({"requested": True, "updated_at": time.time()}, handle)
                handle.write("\n")
        except OSError as exc:
            return web.json_response(
                {"ok": False, "error": f"Failed to request capture stop: {exc}"},
                status=500,
            )

        return web.json_response({"ok": True})

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
        if stream_mode != "hls" or hls_dir is None:
            raise web.HTTPNotFound()

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

    if stream_mode == "webrtc":
        from lib.webrtc_stream import RTCSessionDescription
        import uuid

        assert webrtc_manager is not None

        async def webrtc_start(request: web.Request) -> web.Response:
            session_id = request.rel_url.query.get("session")
            webrtc_manager.mark_started(session_id)
            return web.json_response({"ok": True})

        async def webrtc_stop(request: web.Request) -> web.Response:
            session_id = request.rel_url.query.get("session")
            await webrtc_manager.stop(session_id)
            return web.json_response({"ok": True})

        async def webrtc_stats(_: web.Request) -> web.Response:
            return web.json_response(webrtc_manager.stats())

        async def webrtc_offer(request: web.Request) -> web.Response:
            session_id = request.rel_url.query.get("session")
            if not session_id:
                session_id = str(uuid.uuid4())

            try:
                payload = await request.json()
            except json.JSONDecodeError:
                return web.json_response({"error": "invalid json"}, status=400)

            sdp = payload.get("sdp")
            offer_type = payload.get("type")
            if not isinstance(sdp, str) or not isinstance(offer_type, str):
                return web.json_response({"error": "invalid offer"}, status=400)

            offer = RTCSessionDescription(sdp=sdp, type=offer_type)
            answer = await webrtc_manager.create_answer(session_id, offer)
            if answer is None:
                return web.json_response({"error": "stream unavailable"}, status=503)
            return web.json_response({"sdp": answer.sdp, "type": answer.type})
    else:

        async def webrtc_start(_: web.Request) -> web.Response:  # type: ignore[return-type]
            raise web.HTTPNotFound()

        async def webrtc_stop(_: web.Request) -> web.Response:  # type: ignore[return-type]
            raise web.HTTPNotFound()

        async def webrtc_stats(_: web.Request) -> web.Response:  # type: ignore[return-type]
            raise web.HTTPNotFound()

        async def webrtc_offer(_: web.Request) -> web.Response:  # type: ignore[return-type]
            raise web.HTTPNotFound()

    async def healthz(_: web.Request) -> web.Response:
        return web.Response(text="ok\n")

    # Routes
    app.router.add_get("/", dashboard)
    app.router.add_get("/dashboard", dashboard)
    app.router.add_get("/hls", hls_index)

    app.router.add_get("/api/recordings", recordings_api)
    app.router.add_post("/api/recordings/delete", recordings_delete)
    app.router.add_post("/api/recordings/remove", recordings_delete)
    app.router.add_post("/api/recordings/save", recordings_save)
    app.router.add_post("/api/recordings/unsave", recordings_unsave)
    app.router.add_post("/api/recordings/rename", recordings_rename)
    app.router.add_post("/api/recordings/bulk-download", recordings_bulk_download)
    app.router.add_post("/api/recordings/clip", recordings_clip)
    app.router.add_post("/api/recordings/clip/undo", recordings_clip_undo)
    app.router.add_get("/recordings/{path:.*}", recordings_file)
    app.router.add_get("/api/recycle-bin", recycle_bin_list)
    app.router.add_post("/api/recycle-bin/restore", recycle_bin_restore)
    app.router.add_post("/api/recycle-bin/purge", recycle_bin_purge)
    app.router.add_get("/api/recycle-bin/{entry_id}/waveform", recycle_bin_waveform)
    app.router.add_get("/recycle-bin/{entry_id}", recycle_bin_file)
    app.router.add_get("/api/config", config_snapshot)
    app.router.add_get("/api/config/archival", config_archival_get)
    app.router.add_post("/api/config/archival", config_archival_update)
    app.router.add_get("/api/config/audio", config_audio_get)
    app.router.add_post("/api/config/audio", config_audio_update)
    app.router.add_get("/api/config/paths", config_paths_get)
    app.router.add_post("/api/config/paths", config_paths_update)
    app.router.add_get("/api/config/segmenter", config_segmenter_get)
    app.router.add_post("/api/config/segmenter", config_segmenter_update)
    app.router.add_get("/api/config/adaptive-rms", config_adaptive_rms_get)
    app.router.add_post("/api/config/adaptive-rms", config_adaptive_rms_update)
    app.router.add_get("/api/config/ingest", config_ingest_get)
    app.router.add_post("/api/config/ingest", config_ingest_update)
    app.router.add_get("/api/config/transcription", config_transcription_get)
    app.router.add_post("/api/config/transcription", config_transcription_update)
    app.router.add_get("/api/transcription/models", transcription_models_get)
    app.router.add_get("/api/config/logging", config_logging_get)
    app.router.add_post("/api/config/logging", config_logging_update)
    app.router.add_get("/api/config/notifications", config_notifications_get)
    app.router.add_post("/api/config/notifications", config_notifications_update)
    app.router.add_get("/api/config/streaming", config_streaming_get)
    app.router.add_post("/api/config/streaming", config_streaming_update)
    app.router.add_get("/api/config/dashboard", config_dashboard_get)
    app.router.add_post("/api/config/dashboard", config_dashboard_update)
    app.router.add_get("/api/config/web-server", config_web_server_get)
    app.router.add_post("/api/config/web-server", config_web_server_update)
    app.router.add_get("/api/system-health", system_health)
    app.router.add_get("/api/events", dashboard_events_stream)
    app.router.add_get("/api/services", services_list)
    app.router.add_get("/api/integrations", integrations_api)
    app.router.add_post("/api/services/{unit}/action", service_action)
    app.router.add_post("/api/capture/split", capture_split)
    app.router.add_post("/api/capture/auto-record", capture_auto_record)
    app.router.add_post("/api/capture/manual-record", capture_manual_record)
    app.router.add_post("/api/capture/stop", capture_stop)

    if stream_mode == "hls":
        app.router.add_get("/hls/start", hls_start)
        app.router.add_post("/hls/start", hls_start)
        app.router.add_get("/hls/stop", hls_stop)
        app.router.add_post("/hls/stop", hls_stop)
        app.router.add_get("/hls/stats", hls_stats)
        app.router.add_get("/hls/live.m3u8", hls_playlist)
        if hls_dir is not None:
            app.router.add_static("/hls/", hls_dir, show_index=True)
    else:
        app.router.add_get("/webrtc/start", webrtc_start)
        app.router.add_post("/webrtc/start", webrtc_start)
        app.router.add_get("/webrtc/stop", webrtc_stop)
        app.router.add_post("/webrtc/stop", webrtc_stop)
        app.router.add_get("/webrtc/stats", webrtc_stats)
        app.router.add_post("/webrtc/offer", webrtc_offer)
    app.router.add_static("/static/", webui.static_directory(), show_index=False)

    if lets_encrypt_manager is not None:
        async def _start_lets_encrypt(_: web.Application) -> None:
            async def _maintain() -> None:
                while True:
                    await asyncio.sleep(LETS_ENCRYPT_RENEWAL_INTERVAL_SECONDS)
                    try:
                        cert_path, key_path = await asyncio.to_thread(
                            lets_encrypt_manager.ensure_certificate
                        )
                        ssl_context = app.get(SSL_CONTEXT_KEY)
                        if ssl_context is not None:
                            try:
                                ssl_context.load_cert_chain(
                                    certfile=str(cert_path),
                                    keyfile=str(key_path),
                                )
                                log.info(
                                    "Reloaded HTTPS certificate from %s", cert_path
                                )
                            except Exception as exc:
                                log.warning(
                                    "Unable to reload HTTPS certificate %s: %s",
                                    cert_path,
                                    exc,
                                )
                    except LetsEncryptError as exc:
                        log.warning("Let's Encrypt renewal failed: %s", exc)
                    except Exception as exc:  # pragma: no cover - defensive logging
                        log.warning("Unexpected Let's Encrypt error: %s", exc)

            task = asyncio.create_task(_maintain())
            app[LETS_ENCRYPT_TASK_KEY] = task

        async def _stop_lets_encrypt(_: web.Application) -> None:
            task = app.get(LETS_ENCRYPT_TASK_KEY)
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

        app.on_startup.append(_start_lets_encrypt)
        app.on_cleanup.append(_stop_lets_encrypt)

    if webrtc_manager is not None:
        async def _cleanup_webrtc(_: web.Application) -> None:
            await webrtc_manager.shutdown()

        app.on_cleanup.append(_cleanup_webrtc)

    app.router.add_get("/healthz", healthz)
    return app


def _resolve_web_server_runtime(
    cfg: dict[str, Any],
    *,
    manager_factory: Callable[..., LetsEncryptManager] = LetsEncryptManager,
    logger: logging.Logger | None = None,
) -> tuple[str, int, ssl.SSLContext | None, LetsEncryptManager | None]:
    log = logger or logging.getLogger("web_streamer")
    settings = _canonical_web_server_settings(cfg)

    host = settings.get("listen_host") or "0.0.0.0"
    try:
        port = int(settings.get("listen_port") or (443 if settings["mode"] == "https" else 8080))
    except Exception:
        port = 443 if settings.get("mode") == "https" else 8080

    ssl_context: ssl.SSLContext | None = None
    manager: LetsEncryptManager | None = None

    if settings.get("mode") == "https":
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            ssl_context.options |= ssl.OP_NO_TLSv1 | ssl.OP_NO_TLSv1_1  # type: ignore[attr-defined]
        except AttributeError:
            pass

        provider = settings.get("tls_provider", "letsencrypt").strip().lower()
        if provider == "manual":
            cert_path = settings.get("certificate_path", "").strip()
            key_path = settings.get("private_key_path", "").strip()
            if not cert_path or not key_path:
                raise RuntimeError(
                    "Manual TLS requires certificate_path and private_key_path to be set"
                )
            try:
                ssl_context.load_cert_chain(certfile=cert_path, keyfile=key_path)
            except Exception as exc:
                raise RuntimeError(f"Unable to load manual TLS certificate: {exc}") from exc
        else:
            le_cfg = settings.get("lets_encrypt", {})
            domains = [
                str(domain).strip()
                for domain in le_cfg.get("domains", [])
                if isinstance(domain, str) and str(domain).strip()
            ]
            if not domains:
                raise RuntimeError("Let's Encrypt requires at least one domain")
            email = le_cfg.get("email", "")
            cache_dir = le_cfg.get("cache_dir") or "/apps/tricorder/letsencrypt"
            staging = bool(le_cfg.get("staging"))
            certbot_path = le_cfg.get("certbot_path") or "certbot"
            try:
                http_port = int(le_cfg.get("http_port") or 80)
            except Exception:
                http_port = 80
            try:
                renew_before = int(le_cfg.get("renew_before_days") or 30)
            except Exception:
                renew_before = 30
            try:
                manager = manager_factory(
                    domains=domains,
                    email=email,
                    cache_dir=cache_dir,
                    certbot_path=certbot_path,
                    staging=staging,
                    http_port=http_port,
                    renew_before_days=renew_before,
                    logger=log,
                )
            except LetsEncryptError as exc:
                raise RuntimeError(f"Unable to initialize Let's Encrypt manager: {exc}") from exc

            try:
                cert_path, key_path = manager.ensure_certificate()
            except LetsEncryptError as exc:
                raise RuntimeError(f"Unable to provision Let's Encrypt certificate: {exc}") from exc

            try:
                ssl_context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
            except Exception as exc:
                raise RuntimeError(f"Unable to load Let's Encrypt certificate: {exc}") from exc

    return host, port, ssl_context, manager


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
    *,
    access_log: bool = False,
    log_level: str = "INFO",
    ssl_context: ssl.SSLContext | None = None,
    lets_encrypt_manager: LetsEncryptManager | None = None,
) -> WebStreamerHandle:
    """Launch the aiohttp server in a dedicated thread with its own event loop."""
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    _quiet_noisy_dependencies()
    log = logging.getLogger("web_streamer")

    loop = asyncio.new_event_loop()
    executor = ThreadPoolExecutor(
        max_workers=WEB_STREAMER_EXECUTOR_MAX_WORKERS,
        thread_name_prefix="web_streamer_io",
    )
    runner_box = {}
    app_box = {}

    def _run():
        asyncio.set_event_loop(loop)
        loop.set_default_executor(executor)
        log.debug(
            "Configured web_streamer default executor with %s workers",
            WEB_STREAMER_EXECUTOR_MAX_WORKERS,
        )
        _install_loop_callback_guard(loop, log)
        app = build_app(lets_encrypt_manager=lets_encrypt_manager)
        if ssl_context is not None:
            app[SSL_CONTEXT_KEY] = ssl_context
        runner = web.AppRunner(app, access_log=access_log)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, host, port, ssl_context=ssl_context)
        loop.run_until_complete(site.start())
        runner_box["runner"] = runner
        app_box["app"] = app
        mode = app.get(STREAM_MODE_KEY, "hls")
        log.info("web_streamer started on %s:%s (stream mode: %s)", host, port, mode)
        try:
            loop.run_forever()
        finally:
            try:
                loop.run_until_complete(runner.cleanup())
            except Exception:
                pass
            executor.shutdown(wait=True, cancel_futures=True)

    t = threading.Thread(target=_run, name="web_streamer", daemon=True)
    t.start()

    while "runner" not in runner_box or "app" not in app_box:
        time.sleep(0.05)

    return WebStreamerHandle(t, loop, runner_box["runner"], app_box["app"])


def cli_main():
    parser = argparse.ArgumentParser(description="HLS HTTP streamer (on-demand).")
    parser.add_argument("--host", help="Override bind host (defaults to config).")
    parser.add_argument(
        "--port",
        type=int,
        help="Override bind port (defaults to config).",
    )
    parser.add_argument("--access-log", action="store_true", help="Enable aiohttp access logs.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level (default: INFO).")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    _quiet_noisy_dependencies()
    log = logging.getLogger("web_streamer")

    apply_config_migrations(logger=log)
    cfg = reload_cfg()
    try:
        host_cfg, port_cfg, ssl_ctx, le_manager = _resolve_web_server_runtime(cfg, logger=log)
    except RuntimeError as exc:
        log.error("Unable to start web_streamer: %s", exc)
        return 1

    bind_host = args.host if args.host else host_cfg
    bind_port = args.port if args.port else port_cfg
    mode_label = "HTTPS" if ssl_ctx is not None else "HTTP"
    log.info(
        "Starting web_streamer on %s:%s (%s, access_log=%s)",
        bind_host,
        bind_port,
        mode_label,
        "on" if args.access_log else "off",
    )

    handle = start_web_streamer_in_thread(
        host=bind_host,
        port=bind_port,
        access_log=args.access_log,
        log_level=args.log_level,
        ssl_context=ssl_ctx,
        lets_encrypt_manager=le_manager,
    )
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        handle.stop()
        return 0


if __name__ == "__main__":
    raise SystemExit(cli_main())
