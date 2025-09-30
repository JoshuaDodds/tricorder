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
import copy
import functools
import json
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import wave
import zipfile
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
    "highpass": {
        "cutoff_hz": (20.0, 2000.0),
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

AUDIO_FILTER_DEFAULTS: dict[str, dict[str, Any]] = {
    "highpass": {"enabled": False, "cutoff_hz": 90.0},
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
        "frame_ms": 20,
        "gain": 2.5,
        "vad_aggressiveness": 3,
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
        "rms_threshold": 300,
        "keep_window_frames": 30,
        "start_consecutive": 25,
        "keep_consecutive": 25,
        "use_rnnoise": False,
        "use_noisereduce": False,
        "denoise_before_vad": False,
        "flush_threshold_bytes": 128 * 1024,
        "max_queue_frames": 512,
    }


def _adaptive_rms_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "min_thresh": 0.01,
        "margin": 1.2,
        "update_interval_sec": 5.0,
        "window_sec": 10.0,
        "hysteresis_tolerance": 0.1,
        "release_percentile": 0.5,
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

        frame = raw.get("frame_ms")
        if isinstance(frame, (int, float)) and not isinstance(frame, bool):
            result["frame_ms"] = int(frame)

        gain = raw.get("gain")
        if isinstance(gain, (int, float)) and not isinstance(gain, bool):
            result["gain"] = float(gain)

        vad = raw.get("vad_aggressiveness")
        if isinstance(vad, (int, float)) and not isinstance(vad, bool):
            result["vad_aggressiveness"] = int(vad)

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

        for key in ("use_rnnoise", "use_noisereduce", "denoise_before_vad"):
            value = raw.get(key)
            if isinstance(value, bool):
                result[key] = value
    return result


def _canonical_adaptive_rms_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    result = _adaptive_rms_defaults()
    raw = cfg.get("adaptive_rms", {})
    if isinstance(raw, dict):
        enabled = raw.get("enabled")
        if isinstance(enabled, bool):
            result["enabled"] = enabled

        for key in (
            "min_thresh",
            "margin",
            "update_interval_sec",
            "window_sec",
            "hysteresis_tolerance",
            "release_percentile",
        ):
            value = raw.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                result[key] = float(value)
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
    }

    for field, bounds in int_fields.items():
        min_value, max_value = bounds
        candidate = _coerce_int(payload.get(field), field, errors, min_value=min_value, max_value=max_value)
        if candidate is not None:
            normalized[field] = candidate

    for field in ("use_rnnoise", "use_noisereduce", "denoise_before_vad"):
        normalized[field] = _bool_from_any(payload.get(field))

    return normalized, errors


def _normalize_adaptive_rms_payload(payload: Any) -> tuple[dict[str, Any], list[str]]:
    normalized = _adaptive_rms_defaults()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return normalized, ["Request body must be a JSON object"]

    normalized["enabled"] = _bool_from_any(payload.get("enabled"))

    min_thresh = _coerce_float(
        payload.get("min_thresh"), "min_thresh", errors, min_value=0.0, max_value=1.0
    )
    if min_thresh is not None:
        normalized["min_thresh"] = min_thresh

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
from lib import webui, sd_card_health
from lib.config import (
    ConfigPersistenceError,
    get_cfg,
    primary_config_path,
    reload_cfg,
    update_adaptive_rms_settings,
    update_archival_settings,
    update_audio_settings,
    update_dashboard_settings,
    update_ingest_settings,
    update_logging_settings,
    update_segmenter_settings,
    update_streaming_settings,
    update_transcription_settings,
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
                transcript_path_rel = transcript_path.relative_to(recordings_root).as_posix()
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
                "has_transcript": bool(transcript_path_rel),
                "transcript_path": transcript_path_rel,
                "transcript_text": transcript_text,
                "transcript_event_type": transcript_event_type,
                "transcript_updated": transcript_updated,
                "transcript_updated_iso": transcript_updated_iso,
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
STREAM_MODE_KEY: AppKey[str] = web.AppKey("stream_mode", str)
WEBRTC_MANAGER_KEY: AppKey[Any] = web.AppKey("webrtc_manager", object)

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

    streaming_cfg = cfg.get("streaming", {})
    stream_mode_raw = str(streaming_cfg.get("mode", "hls")).strip().lower()
    stream_mode = stream_mode_raw if stream_mode_raw in {"hls", "webrtc"} else "hls"
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
        )
    app[WEBRTC_MANAGER_KEY] = webrtc_manager
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

            if final_path.exists():
                undo_token = _prepare_clip_backup(final_path, final_waveform, rel_path)

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
        )
        return web.Response(text=html, content_type="text/html")

    async def hls_index(_: web.Request) -> web.Response:
        if stream_mode != "hls":
            raise web.HTTPNotFound()
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

        status: dict[str, object] = {
            "capturing": bool(raw.get("capturing", False)),
            "service_running": False,
        }
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

            active_raw = encoding_raw.get("active")
            if isinstance(active_raw, dict):
                active_entry: dict[str, object] = {}
                base_name = active_raw.get("base_name")
                if isinstance(base_name, str) and base_name:
                    active_entry["base_name"] = base_name
                source = active_raw.get("source")
                if isinstance(source, str) and source:
                    active_entry["source"] = source
                job_id = active_raw.get("id")
                if isinstance(job_id, (int, float)) and math.isfinite(job_id):
                    active_entry["id"] = int(job_id)
                queued_at = active_raw.get("queued_at")
                if isinstance(queued_at, (int, float)) and math.isfinite(queued_at):
                    active_entry["queued_at"] = float(queued_at)
                started_at = active_raw.get("started_at")
                if isinstance(started_at, (int, float)) and math.isfinite(started_at):
                    active_entry["started_at"] = float(started_at)
                duration_value = active_raw.get("duration_seconds")
                if isinstance(duration_value, (int, float)) and math.isfinite(duration_value):
                    active_entry["duration_seconds"] = max(0.0, float(duration_value))
                status_value = active_raw.get("status")
                if isinstance(status_value, str) and status_value:
                    active_entry["status"] = status_value
                if active_entry:
                    encoding["active"] = active_entry

            if encoding.get("pending") or encoding.get("active"):
                status["encoding"] = encoding

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
                transcript_sidecar = resolved.with_suffix(resolved.suffix + ".transcript.json")
                try:
                    transcript_sidecar.unlink()
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

        new_name = raw_name.strip()
        if new_name in {".", ".."}:
            raise web.HTTPBadRequest(reason="name is invalid")
        if any(sep in new_name for sep in ("/", "\\", os.sep)):
            raise web.HTTPBadRequest(reason="name cannot contain path separators")
        name_component = Path(new_name).name
        if name_component != new_name:
            raise web.HTTPBadRequest(reason="name cannot contain path separators")

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
        try:
            allow_overwrite = _to_bool(data.get("allow_overwrite"), True)
            payload = await loop.run_in_executor(
                None,
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
        return web.json_response(payload)

    section_restart_units: dict[str, Sequence[str]] = {
        "audio": ["voice-recorder.service"],
        "segmenter": ["voice-recorder.service"],
        "adaptive_rms": ["voice-recorder.service"],
        "ingest": ["dropbox.path", "dropbox.service"],
        "transcription": ["voice-recorder.service"],
        "logging": ["voice-recorder.service"],
        "streaming": ["voice-recorder.service", "web-streamer.service"],
        "dashboard": ["web-streamer.service"],
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

    async def system_health(_: web.Request) -> web.Response:
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
    app.router.add_post("/api/recordings/rename", recordings_rename)
    app.router.add_post("/api/recordings/bulk-download", recordings_bulk_download)
    app.router.add_post("/api/recordings/clip", recordings_clip)
    app.router.add_post("/api/recordings/clip/undo", recordings_clip_undo)
    app.router.add_get("/recordings/{path:.*}", recordings_file)
    app.router.add_get("/api/config", config_snapshot)
    app.router.add_get("/api/config/archival", config_archival_get)
    app.router.add_post("/api/config/archival", config_archival_update)
    app.router.add_get("/api/config/audio", config_audio_get)
    app.router.add_post("/api/config/audio", config_audio_update)
    app.router.add_get("/api/config/segmenter", config_segmenter_get)
    app.router.add_post("/api/config/segmenter", config_segmenter_update)
    app.router.add_get("/api/config/adaptive-rms", config_adaptive_rms_get)
    app.router.add_post("/api/config/adaptive-rms", config_adaptive_rms_update)
    app.router.add_get("/api/config/ingest", config_ingest_get)
    app.router.add_post("/api/config/ingest", config_ingest_update)
    app.router.add_get("/api/config/transcription", config_transcription_get)
    app.router.add_post("/api/config/transcription", config_transcription_update)
    app.router.add_get("/api/config/logging", config_logging_get)
    app.router.add_post("/api/config/logging", config_logging_update)
    app.router.add_get("/api/config/streaming", config_streaming_get)
    app.router.add_post("/api/config/streaming", config_streaming_update)
    app.router.add_get("/api/config/dashboard", config_dashboard_get)
    app.router.add_post("/api/config/dashboard", config_dashboard_update)
    app.router.add_get("/api/system-health", system_health)
    app.router.add_get("/api/services", services_list)
    app.router.add_post("/api/services/{unit}/action", service_action)

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

    if webrtc_manager is not None:
        async def _cleanup_webrtc(_: web.Application) -> None:
            await webrtc_manager.shutdown()

        app.on_cleanup.append(_cleanup_webrtc)

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
        mode = app.get(STREAM_MODE_KEY, "hls")
        log.info("web_streamer started on %s:%s (stream mode: %s)", host, port, mode)
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
