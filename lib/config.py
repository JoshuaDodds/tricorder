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
from typing import Any, Dict, Mapping

try:
    import yaml
except Exception:
    yaml = None  # pyyaml should be installed; if not, only defaults will be used.

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


class ConfigPersistenceError(Exception):
    """Raised when configuration changes cannot be persisted."""

def _load_yaml_if_exists(path: Path) -> Dict[str, Any]:
    global _warned_yaml_missing
    if not path.exists():
        return {}
    if not yaml:
        if not _warned_yaml_missing:
            _warned_yaml_missing = True
            print("[config] WARNING: PyYAML not available; using defaults only (no file parsing).", flush=True)
        return {}
    try:
        with path.open("r") as f:
            data = yaml.safe_load(f) or {}
            if isinstance(data, dict):
                return data
    except Exception:
        # Ignore parse errors and continue with other locations/defaults
        pass
    return {}


def _candidate_search_paths(project_root: Path, script_dir: Path) -> list[Path]:
    search: list[Path] = []
    env_cfg = os.getenv("TRICORDER_CONFIG")
    if env_cfg:
        try:
            search.append(Path(env_cfg).expanduser().resolve())
        except Exception:
            search.append(Path(env_cfg).expanduser())
    search.extend(
        [
            Path("/etc/tricorder/config.yaml"),
            Path("/apps/tricorder/config.yaml"),
            project_root / "config.yaml",
            script_dir / "config.yaml",
            Path.cwd() / "config.yaml",
        ]
    )
    seen: set[Path] = set()
    ordered: list[Path] = []
    for candidate in search:
        try:
            resolved = candidate.resolve()
        except Exception:
            resolved = candidate
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(resolved)
    return ordered


def _resolve_primary_path(search: list[Path], active: Path | None) -> Path:
    env_cfg = os.getenv("TRICORDER_CONFIG")
    if env_cfg:
        try:
            return Path(env_cfg).expanduser().resolve()
        except Exception:
            return Path(env_cfg).expanduser()

    try:
        etc_path = Path("/etc/tricorder/config.yaml").resolve()
    except Exception:
        etc_path = Path("/etc/tricorder/config.yaml")

    if active is not None:
        try:
            active_resolved = active.resolve()
        except Exception:
            active_resolved = active
        if active_resolved != etc_path:
            return active_resolved

    base_path = Path("/apps/tricorder/config.yaml")
    fallback: Path | None = None
    for candidate in search:
        try:
            resolved = candidate.resolve()
        except Exception:
            resolved = candidate
        if resolved == base_path:
            return resolved
        if str(resolved).startswith("/etc/"):
            continue
        if fallback is None:
            fallback = resolved
    if fallback is not None:
        return fallback
    return base_path

def _deep_merge(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out

def _apply_env_overrides(cfg: Dict[str, Any]) -> None:
    # DEV mode
    if os.getenv("DEV") == "1":
        cfg.setdefault("logging", {})["dev_mode"] = True
    # Audio device and sample rate/gain
    if "AUDIO_DEV" in os.environ:
        cfg.setdefault("audio", {})["device"] = os.environ["AUDIO_DEV"]
    if "GAIN" in os.environ:
        try:
            cfg.setdefault("audio", {})["gain"] = float(os.environ["GAIN"])
        except ValueError:
            pass
    # Paths
    if "REC_DIR" in os.environ:
        cfg.setdefault("paths", {})["recordings_dir"] = os.environ["REC_DIR"]
    if "TMP_DIR" in os.environ:
        cfg.setdefault("paths", {})["tmp_dir"] = os.environ["TMP_DIR"]
    if "DROPBOX_DIR" in os.environ:
        cfg.setdefault("paths", {})["dropbox_dir"] = os.environ["DROPBOX_DIR"]
    if "VOSK_MODEL_PATH" in os.environ:
        value = os.environ["VOSK_MODEL_PATH"].strip()
        if value:
            cfg.setdefault("transcription", {})["vosk_model_path"] = value
    # Ingest tuning
    env_map = {
        "INGEST_STABLE_CHECKS": ("ingest", "stable_checks", int),
        "INGEST_STABLE_INTERVAL_SEC": ("ingest", "stable_interval_sec", float),
        "INGEST_ALLOWED_EXT": ("ingest", "allowed_ext", lambda s: [x.strip().lower() for x in s.split(",") if x.strip()]),
    }
    for env_key, (section, key, cast) in env_map.items():
        if env_key in os.environ:
            try:
                cfg.setdefault(section, {})[key] = cast(os.environ[env_key])
            except Exception:
                pass

    def _parse_bool(value: str) -> bool:
        return value.strip().lower() in {"1", "true", "yes", "on"}

    transcription_env = {
        "TRANSCRIPTION_ENABLED": ("enabled", _parse_bool),
        "TRANSCRIPTION_ENGINE": ("engine", str),
        "TRANSCRIPTION_TYPES": (
            "types",
            lambda s: [token.strip() for token in s.split(",") if token.strip()],
        ),
        "TRANSCRIPTION_TARGET_RATE": ("target_sample_rate", int),
        "TRANSCRIPTION_INCLUDE_WORDS": ("include_words", _parse_bool),
        "TRANSCRIPTION_MAX_ALTERNATIVES": ("max_alternatives", int),
    }

    for env_key, (key, caster) in transcription_env.items():
        if env_key in os.environ:
            try:
                cfg.setdefault("transcription", {})[key] = caster(os.environ[env_key])
            except Exception:
                pass

    tag_env = {
        "EVENT_TAG_HUMAN": "human",
        "EVENT_TAG_OTHER": "other",
        "EVENT_TAG_BOTH": "both",
    }
    for env_key, tag_key in tag_env.items():
        if env_key in os.environ:
            value = os.environ[env_key].strip()
            if value:
                segmenter = cfg.setdefault("segmenter", {})
                tags = segmenter.setdefault("event_tags", {})
                tags[tag_key] = value

    adaptive_env = {
        "ADAPTIVE_RMS_ENABLED": ("enabled", _parse_bool),
        "ADAPTIVE_RMS_MIN_THRESH": ("min_thresh", float),
        "ADAPTIVE_RMS_MARGIN": ("margin", float),
        "ADAPTIVE_RMS_UPDATE_INTERVAL_SEC": ("update_interval_sec", float),
        "ADAPTIVE_RMS_WINDOW_SEC": ("window_sec", float),
        "ADAPTIVE_RMS_HYSTERESIS_TOLERANCE": ("hysteresis_tolerance", float),
        "ADAPTIVE_RMS_RELEASE_PERCENTILE": ("release_percentile", float),
    }
    for env_key, (key, caster) in adaptive_env.items():
        if env_key in os.environ:
            try:
                cfg.setdefault("adaptive_rms", {})[key] = caster(os.environ[env_key])
            except Exception:
                pass

    def _service_label_from_unit(unit: str) -> str:
        base = unit.split(".", 1)[0]
        tokens = [segment for segment in base.replace("_", "-").split("-") if segment]
        if not tokens:
            return unit
        return " ".join(token.capitalize() for token in tokens)

    if "DASHBOARD_SERVICES" in os.environ:
        raw = os.environ["DASHBOARD_SERVICES"]
        entries = []
        for chunk in raw.split(";"):
            piece = chunk.strip()
            if not piece:
                continue
            parts = [p.strip() for p in piece.split("|", 2)]
            unit = parts[0]
            if not unit:
                continue
            label = parts[1] if len(parts) > 1 and parts[1] else _service_label_from_unit(unit)
            description = parts[2] if len(parts) > 2 and parts[2] else ""
            entry: Dict[str, Any] = {"unit": unit}
            if label:
                entry["label"] = label
            if description:
                entry["description"] = description
            entries.append(entry)
        if entries:
            cfg.setdefault("dashboard", {})["services"] = entries

    if "DASHBOARD_WEB_SERVICE" in os.environ:
        value = os.environ["DASHBOARD_WEB_SERVICE"].strip()
        if value:
            cfg.setdefault("dashboard", {})["web_service"] = value


def resolve_event_tags(cfg: Mapping[str, Any]) -> Dict[str, str]:
    segmenter_section = cfg.get("segmenter") if isinstance(cfg, Mapping) else None
    raw_tags = {}
    if isinstance(segmenter_section, Mapping):
        maybe_tags = segmenter_section.get("event_tags")
        if isinstance(maybe_tags, Mapping):
            raw_tags = maybe_tags

    resolved: Dict[str, str] = {}
    for key, default in EVENT_TAG_DEFAULTS.items():
        value: str | None = None
        if raw_tags:
            for alias in {key, key.lower(), key.upper(), key.capitalize(), default}:
                candidate = raw_tags.get(alias)
                if isinstance(candidate, str) and candidate.strip():
                    value = candidate.strip()
                    break
        resolved[key] = value or default
    return resolved


def event_type_aliases(cfg: Mapping[str, Any]) -> Dict[str, str]:
    tags = resolve_event_tags(cfg)
    aliases: Dict[str, str] = {}
    for key, label in tags.items():
        aliases[key.lower()] = label
        aliases[label.lower()] = label
    for key, default in EVENT_TAG_DEFAULTS.items():
        aliases.setdefault(default.lower(), tags[key])
    return aliases


def get_cfg() -> Dict[str, Any]:
    global _cfg_cache, _search_paths, _active_config_path, _primary_config_path
    if _cfg_cache is not None:
        return _cfg_cache

    cfg = copy.deepcopy(_DEFAULTS)

    # Derive project root relative to this file (lib/ -> project root)
    try:
        this_dir = Path(__file__).resolve().parent
        project_root = this_dir.parent  # <root>/lib -> <root>
    except Exception:
        project_root = Path.cwd()

    # Derive script directory (useful for tools run as ./tool.py)
    try:
        script_dir = Path(sys.argv[0]).resolve().parent
    except Exception:
        script_dir = Path.cwd()

    search = _candidate_search_paths(project_root, script_dir)
    _search_paths = list(search)

    active: Path | None = None
    for candidate in search:
        if active is None:
            try:
                if candidate.exists():
                    active = candidate
            except OSError:
                pass

    for candidate in reversed(search):
        cfg = _deep_merge(cfg, _load_yaml_if_exists(candidate))

    _active_config_path = active
    _primary_config_path = _resolve_primary_path(search, active)

    _apply_env_overrides(cfg)
    _cfg_cache = cfg
    return cfg


def reload_cfg() -> Dict[str, Any]:
    global _cfg_cache
    _cfg_cache = None
    return get_cfg()


def primary_config_path() -> Path:
    global _primary_config_path
    if _primary_config_path is None:
        get_cfg()
    assert _primary_config_path is not None
    return _primary_config_path


def active_config_path() -> Path | None:
    global _active_config_path
    if _active_config_path is None:
        get_cfg()
    return _active_config_path


def search_paths() -> list[Path]:
    global _search_paths
    if not _search_paths:
        get_cfg()
    return list(_search_paths)


def _load_raw_yaml(path: Path) -> Dict[str, Any]:
    if not yaml:
        raise ConfigPersistenceError("PyYAML is required to update configuration files")
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = yaml.safe_load(handle) or {}
            if isinstance(payload, dict):
                return payload
    except Exception as exc:
        raise ConfigPersistenceError(f"Unable to read configuration: {exc}") from exc
    return {}


def _dump_yaml(path: Path, payload: Dict[str, Any]) -> None:
    if not yaml:
        raise ConfigPersistenceError("PyYAML is required to update configuration files")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise ConfigPersistenceError(f"Unable to create configuration directory: {exc}") from exc
    try:
        with path.open("w", encoding="utf-8") as handle:
            yaml.safe_dump(
                payload,
                handle,
                default_flow_style=False,
                sort_keys=False,
                allow_unicode=True,
            )
    except Exception as exc:
        raise ConfigPersistenceError(f"Unable to write configuration: {exc}") from exc


def _persist_settings_section(
    section: str, settings: Dict[str, Any], *, merge: bool = True
) -> Dict[str, Any]:
    if not isinstance(settings, dict):
        raise ConfigPersistenceError(f"{section} settings payload must be a mapping")

    primary_path = primary_config_path()
    current = _load_raw_yaml(primary_path)
    updated = copy.deepcopy(current)

    if merge:
        base: Dict[str, Any] = {}
        existing = updated.get(section)
        if isinstance(existing, dict):
            base = copy.deepcopy(existing)
        for key, value in settings.items():
            base[key] = copy.deepcopy(value)
        updated[section] = base
    else:
        updated[section] = copy.deepcopy(settings)

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
