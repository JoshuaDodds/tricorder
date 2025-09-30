#!/usr/bin/env python3
"""
Unified configuration loader for Tricorder.

Load order (first found wins):
  1) TRICORDER_CONFIG (env, absolute or relative to CWD)
  2) /etc/tricorder/config.yaml
  3) /apps/tricorder/config.yaml
  4) <project_root>/config.yaml (derived from this file's location)
  5) <script_dir>/config.yaml (directory of the running script)
  6) ./config.yaml (current working directory)

Environment variables override file values when present.
"""
from __future__ import annotations
import copy
import os
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Sequence

try:
    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap, CommentedSeq
except Exception:
    YAML = None  # type: ignore[assignment]
    CommentedMap = None  # type: ignore[assignment]
    CommentedSeq = None  # type: ignore[assignment]

try:
    from .config_template import CONFIG_TEMPLATE_YAML
except Exception:
    CONFIG_TEMPLATE_YAML = None  # type: ignore[assignment]

try:
    import yaml
except Exception:
    yaml = None  # pyyaml should be installed; if not, only defaults will be used.

if YAML:
    _ROUND_TRIP_YAML = YAML(typ="rt")
    _ROUND_TRIP_YAML.indent(mapping=2, sequence=4, offset=2)
    _ROUND_TRIP_YAML.default_flow_style = False
    _ROUND_TRIP_YAML.allow_unicode = True
    try:
        _ROUND_TRIP_YAML.preserve_quotes = True  # type: ignore[attr-defined]
    except AttributeError:
        pass
else:  # pragma: no cover - exercised when ruamel.yaml is not available.
    _ROUND_TRIP_YAML = None

EVENT_TAG_DEFAULTS: Dict[str, str] = {
    "human": "Human",
    "other": "Other",
    "both": "Both",
}

_DEFAULTS: Dict[str, Any] = {
    "audio": {
        "device": "hw:CARD=Device,DEV=0",
        "sample_rate": 48000,
        "frame_ms": 20,
        "gain": 2.5,
        "vad_aggressiveness": 3,
        "filter_chain": {
            "highpass": {"enabled": False, "cutoff_hz": 90.0},
            "notch": {"enabled": False, "freq_hz": 60.0, "quality": 30.0},
            "spectral_gate": {
                "enabled": False,
                "sensitivity": 1.5,
                "reduction_db": -18.0,
                "noise_update": 0.1,
                "noise_decay": 0.95,
            },
        },
        "calibration": {
            "auto_noise_profile": False,
            "auto_gain": False,
        },
    },
    "paths": {
        "tmp_dir": "/apps/tricorder/tmp",
        "recordings_dir": "/apps/tricorder/recordings",
        "dropbox_dir": "/apps/tricorder/dropbox",
        "ingest_work_dir": "/apps/tricorder/tmp/ingest",
        "encoder_script": "/apps/tricorder/bin/encode_and_store.sh",
    },
    "archival": {
        "enabled": False,
        "backend": "network_share",
        "network_share": {"target_dir": ""},
        "rsync": {
            "destination": "",
            "options": ["-az"],
            "ssh_identity": "",
            "ssh_options": [],
        },
        "include_waveform_sidecars": False,
        "include_transcript_sidecars": True,
    },
    "segmenter": {
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
        "event_tags": EVENT_TAG_DEFAULTS.copy(),
    },
    "adaptive_rms": {
        "enabled": False,
        "min_thresh": 0.01,
        "margin": 1.2,
        "update_interval_sec": 5.0,
        "window_sec": 10.0,
        "hysteresis_tolerance": 0.1,
        "release_percentile": 0.5,
    },
    "ingest": {
        "stable_checks": 2,
        "stable_interval_sec": 1.0,
        "allowed_ext": [".wav", ".opus", ".flac", ".mp3"],
        "ignore_suffixes": [".part", ".partial", ".tmp", ".incomplete", ".opdownload", ".crdownload"],
    },
    "transcription": {
        "enabled": False,
        "engine": "vosk",
        "types": ["Human"],
        "vosk_model_path": "/apps/tricorder/models/vosk-small-en-us-0.15",
        "target_sample_rate": 16000,
        "include_words": True,
        "max_alternatives": 0,
    },
    "logging": {
        "dev_mode": False  # if True or ENV DEV=1, enable verbose debug
    },
    "dashboard": {
        "services": [
            {"unit": "voice-recorder.service", "label": "Recorder"},
            {"unit": "web-streamer.service", "label": "Web UI"},
            {"unit": "dropbox.service", "label": "Dropbox ingest"},
            {"unit": "tricorder-auto-update.service", "label": "Auto updater"},
            {"unit": "tmpfs-guard.service", "label": "Tmpfs guard"},
        ],
        "web_service": "web-streamer.service",
    },
    "notifications": {
        "enabled": False,
        "allowed_event_types": [],
        "min_trigger_rms": None,
        "webhook": {},
        "email": {},
    },
}

_cfg_cache: Dict[str, Any] | None = None
_warned_yaml_missing = False
_search_paths: list[Path] = []
_active_config_path: Path | None = None
_primary_config_path: Path | None = None
_template_cache: MutableMapping[str, Any] | None = None


class ConfigPersistenceError(Exception):
    """Raised when configuration changes cannot be persisted."""


# (file continues unchanged until conflicts)
# ...

def _empty_mapping() -> MutableMapping[str, Any]:
    if CommentedMap is not None:
        return CommentedMap()
    return {}


def _file_has_comments(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return False
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#"):
            return True
        idx = line.find("#")
        if idx > 0 and line[idx - 1].isspace():
            return True
    return False


def _load_comment_template() -> MutableMapping[str, Any] | None:
    global _template_cache
    if _ROUND_TRIP_YAML is None:
        return None
    if _template_cache is None:
        candidates: list[Path] = []
        template_env = os.getenv("TRICORDER_CONFIG_TEMPLATE")
        if template_env:
            try:
                candidates.append(Path(template_env).expanduser())
            except Exception:
                candidates.append(Path(template_env))
        candidates.extend(
            [
                Path("/etc/tricorder/config.template.yaml"),
                Path("/apps/tricorder/config.template.yaml"),
            ]
        )
        project_root = Path(__file__).resolve().parents[1]
        candidates.extend(
            [
                project_root / "config.template.yaml",
                project_root / "docs" / "config-template.yaml",
            ]
        )

        for candidate in candidates:
            try:
                if candidate.exists():
                    with candidate.open("r", encoding="utf-8") as handle:
                        loaded = _ROUND_TRIP_YAML.load(handle)  # type: ignore[arg-type]
                    if isinstance(loaded, MutableMapping):
                        _template_cache = _convert_to_round_trip(loaded)
                        break
            except Exception:
                continue

        if _template_cache is None and CONFIG_TEMPLATE_YAML:
            try:
                loaded = _ROUND_TRIP_YAML.load(CONFIG_TEMPLATE_YAML)
                if isinstance(loaded, MutableMapping):
                    _template_cache = _convert_to_round_trip(loaded)
            except Exception:
                _template_cache = None

    if _template_cache is None:
        return None
    return _convert_to_round_trip(_template_cache)


def _template_with_values(values: Mapping[str, Any]) -> MutableMapping[str, Any] | None:
    template = _load_comment_template()
    if template is None:
        return None
    if isinstance(values, Mapping):
        _replace_mapping(template, values, prune=False)
    return template


# (file continues unchanged until the last conflict area)
# ...

def _persist_settings_section(
    section: str, settings: Dict[str, Any], *, merge: bool = True
) -> Dict[str, Any]:
    if not isinstance(settings, dict):
        raise ConfigPersistenceError(f"{section} settings payload must be a mapping")

    primary_path = primary_config_path()
    current = _load_raw_yaml(primary_path)

    updated: MutableMapping[str, Any] | Any

    if _ROUND_TRIP_YAML is not None:
        template_candidate: MutableMapping[str, Any] | None = None
        if not _file_has_comments(primary_path):
            template_candidate = _template_with_values(current)
        if template_candidate is not None:
            updated = template_candidate
        else:
            updated = _load_yaml_for_update(primary_path)
            if isinstance(updated, dict) and not isinstance(updated, MutableMapping):
                updated = _convert_to_round_trip(updated)
    else:
        updated = _convert_to_round_trip(current)
        if not isinstance(updated, MutableMapping):
            updated = _convert_to_round_trip({})

    if not isinstance(updated, MutableMapping):
        raise ConfigPersistenceError("Configuration root must be a mapping")

    target = _ensure_mapping(updated, section)
    if not isinstance(target, MutableMapping):
        raise ConfigPersistenceError(f"Configuration section {section!r} is not a mapping")

    if merge:
        _replace_mapping(target, settings, prune=False)
    else:
        _replace_mapping(target, settings, prune=True)

    _dump_yaml(primary_path, updated)
    return reload_cfg().get(section, {})


def update_archival_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("archival", settings, merge=False)


def update_audio_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("audio", settings, merge=True)


def update_segmenter_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("segmenter", settings, merge=True)


def update_adaptive_rms_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("adaptive_rms", settings, merge=True)


def update_ingest_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("ingest", settings, merge=True)


def update_transcription_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("transcription", settings, merge=True)


def update_logging_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("logging", settings, merge=True)


def update_streaming_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("streaming", settings, merge=True)


def update_dashboard_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("dashboard", settings, merge=True)
