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
import logging
import math
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, MutableMapping, MutableSequence, Sequence

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
        "min_clip_seconds": 0.0,
        "motion_release_padding_minutes": 0.0,
        "auto_record_motion_override": True,
        "event_tags": EVENT_TAG_DEFAULTS.copy(),
    },
    "adaptive_rms": {
        "enabled": False,
        "min_thresh": 0.01,
        "max_rms": None,
        "max_thresh": 1.0,
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
    "web_server": {
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
    def _parse_bool(value: str) -> bool:
        return value.strip().lower() in {"1", "true", "yes", "on"}

    # DEV mode
    if os.getenv("DEV") == "1":
        cfg.setdefault("logging", {})["dev_mode"] = True
    # Audio device and sample rate/gain
    if "AUDIO_DEV" in os.environ:
        env_device = os.environ["AUDIO_DEV"].strip()
        if env_device:
            audio_section = cfg.setdefault("audio", {})
            current_device = audio_section.get("device")
            default_device = _DEFAULTS.get("audio", {}).get("device")
            if current_device in (None, ""):
                audio_section["device"] = env_device
            elif env_device == current_device:
                audio_section["device"] = env_device
            elif default_device is not None and current_device == default_device:
                audio_section["device"] = env_device
    if "GAIN" in os.environ:
        try:
            cfg.setdefault("audio", {})["gain"] = float(os.environ["GAIN"])
        except ValueError:
            pass
    if "AUDIO_CHANNELS" in os.environ:
        try:
            channels = int(os.environ["AUDIO_CHANNELS"])
        except ValueError:
            pass
        else:
            cfg.setdefault("audio", {})["channels"] = max(1, min(2, channels))
    if "AUDIO_USB_RESET_WORKAROUND" in os.environ:
        cfg.setdefault("audio", {})["usb_reset_workaround"] = _parse_bool(
            os.environ["AUDIO_USB_RESET_WORKAROUND"]
        )
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
        "ADAPTIVE_RMS_MAX_RMS": ("max_rms", int),
        "ADAPTIVE_RMS_MAX_THRESH": ("max_thresh", float),
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


CommentHints = tuple[list[str], str | None]


def _find_comment_marker(segment: str) -> int | None:
    in_single = False
    in_double = False
    index = 0
    while index < len(segment):
        char = segment[index]
        if char == "#" and not in_single and not in_double:
            return index
        if in_double:
            if char == "\\":
                index += 2
                continue
            if char == '"':
                in_double = False
        elif in_single:
            if char == "'":
                if index + 1 < len(segment) and segment[index + 1] == "'":
                    index += 2
                    continue
                in_single = False
        else:
            if char == '"':
                in_double = True
            elif char == "'":
                in_single = True
        index += 1
    return None


def _extract_comment_hints(text: str) -> Dict[str, CommentHints]:
    hints: Dict[str, CommentHints] = {}
    if not text.strip():
        return hints

    stack: list[tuple[int, str]] = []
    pending_comments: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            pending_comments.append(stripped)
            continue

        indent = len(line) - len(line.lstrip(" "))

        while stack and stack[-1][0] >= indent:
            stack.pop()

        if stripped.startswith("- "):
            pending_comments = []
            continue

        key, sep, remainder = stripped.partition(":")
        if not sep:
            pending_comments = []
            continue

        key = key.strip()
        remainder = remainder.lstrip()
        path = ".".join(entry[1] for entry in stack + [(indent, key)])

        inline_comment: str | None = None
        comment_index = _find_comment_marker(remainder)
        if comment_index is not None:
            comment_text = remainder[comment_index + 1 :].strip()
            if comment_text:
                inline_comment = f"# {comment_text}"

        prefix_comments = list(pending_comments)
        if prefix_comments or inline_comment:
            hints[path] = (prefix_comments, inline_comment)

        pending_comments = []

        if remainder == "":
            stack.append((indent, key))

    return hints


def _apply_comment_hints(text: str, comment_hints: Mapping[str, CommentHints]) -> str:
    if not text or not comment_hints:
        return text

    lines = text.splitlines()
    stack: list[tuple[int, str]] = []
    rendered: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            rendered.append(line)
            continue

        indent = len(line) - len(line.lstrip(" "))

        while stack and stack[-1][0] >= indent:
            stack.pop()

        if stripped.startswith("#"):
            rendered.append(line)
            continue

        if stripped.startswith("- "):
            rendered.append(line)
            continue

        key, sep, remainder = stripped.partition(":")
        if not sep:
            rendered.append(line)
            continue

        key = key.strip()
        path = ".".join(entry[1] for entry in stack + [(indent, key)])

        hint = comment_hints.get(path)
        if hint:
            prefix_comments, inline_comment = hint
            if prefix_comments:
                indent_spaces = " " * indent
                for comment_line in prefix_comments:
                    rendered.append(f"{indent_spaces}{comment_line}")
            if inline_comment:
                prefix, sep, remainder_full = line.partition(":")
                if sep:
                    comment_index = _find_comment_marker(remainder_full)
                    if comment_index is not None:
                        remainder_full = remainder_full[:comment_index]
                    remainder_full = remainder_full.rstrip()
                    base = f"{prefix}{sep}{remainder_full}".rstrip()
                    line = f"{base}  {inline_comment}"

        rendered.append(line)

        if not (content := remainder.strip()) or content.startswith("|") or content.startswith(">"):
            stack.append((indent, key))

    ending = "\n" if text.endswith("\n") else ""
    return "\n".join(rendered) + ending


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


def _convert_to_round_trip(value: Any) -> Any:
    if CommentedMap is not None:
        if isinstance(value, CommentedMap) or isinstance(value, CommentedSeq):
            return value
        if isinstance(value, Mapping) and not isinstance(value, (str, bytes)):
            converted = CommentedMap()
            for key, sub_value in value.items():
                converted[key] = _convert_to_round_trip(sub_value)
            return converted
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            converted_seq = CommentedSeq()
            for item in value:
                converted_seq.append(_convert_to_round_trip(item))
            return converted_seq
    return copy.deepcopy(value)


def _ensure_mapping(container: MutableMapping[str, Any], key: str) -> MutableMapping[str, Any]:
    existing = container.get(key)
    if isinstance(existing, MutableMapping):
        return existing
    if isinstance(existing, Mapping):
        converted = _convert_to_round_trip(existing)
        if isinstance(converted, MutableMapping):
            container[key] = converted
            return converted
    new_map = _convert_to_round_trip({})
    assert isinstance(new_map, MutableMapping)
    container[key] = new_map
    return new_map


def _replace_mapping(
    target: MutableMapping[str, Any],
    updates: Mapping[str, Any],
    *,
    prune: bool,
) -> None:
    if prune:
        for existing_key in list(target.keys()):
            if existing_key not in updates:
                try:
                    del target[existing_key]
                except KeyError:
                    continue
    for key, value in updates.items():
        if isinstance(value, Mapping) and not isinstance(value, (str, bytes)):
            nested: MutableMapping[str, Any]
            existing = target.get(key)
            if isinstance(existing, MutableMapping):
                nested = existing
            else:
                converted = _convert_to_round_trip(value)
                if isinstance(converted, MutableMapping):
                    target[key] = converted
                    nested = converted
                    continue
                nested = _empty_mapping()
                target[key] = nested
            _replace_mapping(nested, value, prune=prune)
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            target[key] = _convert_to_round_trip(value)
        else:
            target[key] = copy.deepcopy(value)


def _load_yaml_for_update(path: Path) -> MutableMapping[str, Any]:
    if _ROUND_TRIP_YAML is not None:
        if path.exists():
            try:
                with path.open("r", encoding="utf-8") as handle:
                    data = _ROUND_TRIP_YAML.load(handle)  # type: ignore[arg-type]
            except Exception as exc:
                raise ConfigPersistenceError(f"Unable to read configuration: {exc}") from exc
            if isinstance(data, MutableMapping):
                return data
        return _empty_mapping()
    return {}


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


def _dump_yaml(path: Path, payload: MutableMapping[str, Any] | Dict[str, Any]) -> None:
    if _ROUND_TRIP_YAML is None and not yaml:
        raise ConfigPersistenceError("PyYAML is required to update configuration files")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise ConfigPersistenceError(f"Unable to create configuration directory: {exc}") from exc
    try:
        with path.open("w", encoding="utf-8") as handle:
            if _ROUND_TRIP_YAML is not None:
                _ROUND_TRIP_YAML.dump(payload, handle)  # type: ignore[arg-type]
            else:
                yaml.safe_dump(  # type: ignore[union-attr]
                    payload,
                    handle,
                    default_flow_style=False,
                    sort_keys=False,
                    allow_unicode=True,
                )
    except Exception as exc:
        raise ConfigPersistenceError(f"Unable to write configuration: {exc}") from exc


_ConfigMigration = Callable[[MutableMapping[str, Any]], bool]


def _migration_info(logger: logging.Logger | None, message: str) -> None:
    if logger is not None:
        logger.info(message)
    else:
        print(f"[config] {message}", flush=True)


def _migration_warning(logger: logging.Logger | None, message: str) -> None:
    if logger is not None:
        logger.warning(message)
    else:
        print(f"[config] WARNING: {message}", flush=True)


def _normalize_string_list(container: MutableMapping[str, Any], key: str) -> bool:
    if key not in container:
        container[key] = _convert_to_round_trip([])
        return True

    value = container.get(key)

    if isinstance(value, str):
        normalized = [chunk.strip() for chunk in value.split(",") if chunk.strip()]
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        normalized = [str(item).strip() for item in value if str(item).strip()]
    elif value is None:
        normalized = []
    else:
        text = str(value).strip()
        normalized = [text] if text else []

    current: list[str]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        current = [str(item).strip() for item in value if str(item).strip()]
    elif isinstance(value, str):
        current = [chunk.strip() for chunk in value.split(",") if chunk.strip()]
    elif value is None:
        current = []
    else:
        text = str(value).strip()
        current = [text] if text else []

    if current == normalized and isinstance(value, MutableSequence):
        return False

    container[key] = _convert_to_round_trip(normalized)
    return True


_MISSING = object()


def _parse_int_like(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(text, 10)
        except ValueError:
            try:
                float_candidate = float(text)
            except ValueError:
                return None
            if not math.isfinite(float_candidate) or not float_candidate.is_integer():
                return None
            return int(float_candidate)
    return None


def _parse_float_like(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        candidate = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            candidate = float(text)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(candidate):
        return None
    return candidate


def _normalize_int_field(
    container: MutableMapping[str, Any],
    key: str,
    *,
    min_value: int | None = None,
    max_value: int | None = None,
) -> bool:
    if not isinstance(container, MutableMapping):
        return False
    value = container.get(key, _MISSING)
    if value is _MISSING:
        return False
    candidate = _parse_int_like(value)
    if candidate is None:
        return False
    if min_value is not None and candidate < min_value:
        candidate = min_value
    if max_value is not None and candidate > max_value:
        candidate = max_value
    if candidate != value:
        container[key] = candidate
        return True
    return False


def _normalize_float_field(
    container: MutableMapping[str, Any],
    key: str,
    *,
    min_value: float | None = None,
    max_value: float | None = None,
) -> bool:
    if not isinstance(container, MutableMapping):
        return False
    value = container.get(key, _MISSING)
    if value is _MISSING:
        return False
    candidate = _parse_float_like(value)
    if candidate is None:
        return False
    if min_value is not None and candidate < min_value:
        candidate = min_value
    if max_value is not None and candidate > max_value:
        candidate = max_value
    if candidate != value:
        container[key] = candidate
        return True
    return False


def _normalize_bool_field(container: MutableMapping[str, Any], key: str) -> bool:
    if not isinstance(container, MutableMapping):
        return False
    value = container.get(key, _MISSING)
    if value is _MISSING or isinstance(value, bool):
        return False
    candidate: bool | None
    candidate = None
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return False
        if normalized in {"true", "yes", "1", "on"}:
            candidate = True
        elif normalized in {"false", "no", "0", "off"}:
            candidate = False
        else:
            return False
    elif isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return False
        candidate = bool(value)
    else:
        return False
    if candidate is None:
        return False
    container[key] = candidate
    return True




_STRING_LIST_PATHS: set[tuple[str, ...]] = {
    ("archival", "rsync", "ssh_options"),
    ("notifications", "allowed_event_types"),
    ("web_server", "lets_encrypt", "domains"),
}

_OPTIONAL_INT_PATHS: set[tuple[str, ...]] = {
    ("adaptive_rms", "max_rms"),
    ("notifications", "min_trigger_rms"),
}


def _default_is_string_list(default: Sequence[Any]) -> bool:
    if not default:
        return False
    return all(isinstance(item, str) for item in default)


def _normalize_optional_int_field(
    container: MutableMapping[str, Any],
    key: str,
    *,
    path: tuple[str, ...],
) -> bool:
    _ = path
    if not isinstance(container, MutableMapping):
        return False
    value = container.get(key, _MISSING)
    if value is _MISSING:
        return False
    if value is None:
        return False
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            if container[key] is not None:
                container[key] = None
                return True
            return False
        if stripped != value:
            container[key] = stripped
    return _normalize_int_field(container, key)


def _sequence_template(default: Sequence[Any]) -> Mapping[str, Any] | None:
    template: dict[str, Any] = {}
    for item in default:
        if isinstance(item, Mapping):
            for child_key, child_value in item.items():
                if child_key not in template:
                    template[child_key] = child_value
    if template:
        return template
    return None


def _normalize_sequence_entry(
    container: MutableMapping[str, Any],
    key: str,
    default: Sequence[Any],
    path: tuple[str, ...],
) -> bool:
    if path in _STRING_LIST_PATHS or _default_is_string_list(default):
        return _normalize_string_list(container, key)

    value = container.get(key, _MISSING)
    if value is _MISSING:
        return False

    changed = False
    if isinstance(value, str):
        if path in _STRING_LIST_PATHS:
            return _normalize_string_list(container, key)
        return False

    sequence_value = value
    if not isinstance(sequence_value, MutableSequence):
        if isinstance(sequence_value, Sequence):
            converted = _convert_to_round_trip(sequence_value)
            if isinstance(converted, MutableSequence):
                container[key] = converted
                sequence_value = converted
                changed = True
            else:
                return changed
        else:
            return changed

    template = _sequence_template(default)
    if template is None:
        return changed

    for index, item in enumerate(list(sequence_value)):
        if isinstance(item, MutableMapping):
            if _normalize_against_defaults(item, template, path + (str(index),)):
                changed = True
        elif isinstance(item, Mapping):
            converted_item = _convert_to_round_trip(item)
            if isinstance(converted_item, MutableMapping):
                sequence_value[index] = converted_item
                changed = True
                if _normalize_against_defaults(converted_item, template, path + (str(index),)):
                    changed = True
    return changed


def _normalize_entry(
    container: MutableMapping[str, Any],
    key: str,
    default: Any,
    path: tuple[str, ...],
) -> bool:
    if not isinstance(container, MutableMapping):
        return False
    if key not in container:
        return False

    if isinstance(default, bool):
        return _normalize_bool_field(container, key)
    if isinstance(default, int) and not isinstance(default, bool):
        return _normalize_int_field(container, key)
    if isinstance(default, float):
        return _normalize_float_field(container, key)
    if default is None:
        if path in _OPTIONAL_INT_PATHS:
            return _normalize_optional_int_field(container, key, path=path)
        return False
    if isinstance(default, Mapping):
        value = container.get(key)
        changed = False
        if isinstance(value, MutableMapping):
            if _normalize_against_defaults(value, default, path):
                changed = True
        elif isinstance(value, Mapping):
            converted = _convert_to_round_trip(value)
            if isinstance(converted, MutableMapping):
                container[key] = converted
                changed = True
                if _normalize_against_defaults(converted, default, path):
                    changed = True
        return changed
    if isinstance(default, Sequence) and not isinstance(default, (str, bytes)):
        return _normalize_sequence_entry(container, key, default, path)
    return False


def _normalize_against_defaults(
    target: MutableMapping[str, Any],
    defaults: Mapping[str, Any],
    path: tuple[str, ...],
) -> bool:
    if not isinstance(target, MutableMapping):
        return False

    changed = False
    for child_key, child_default in defaults.items():
        if child_key not in target:
            continue
        if _normalize_entry(target, child_key, child_default, path + (child_key,)):
            changed = True
    return changed


def _normalize_config_value_types(cfg: MutableMapping[str, Any]) -> bool:
    if not isinstance(cfg, MutableMapping):
        return False

    defaults: Dict[str, Any] = {}
    defaults.update(_DEFAULTS)
    for section, section_defaults in _SECTION_FALLBACKS.items():
        defaults.setdefault(section, section_defaults)

    return _normalize_against_defaults(cfg, defaults, tuple())



def _migrate_config_value_types(cfg: MutableMapping[str, Any]) -> bool:
    return _normalize_config_value_types(cfg)

def _migrate_archival_rsync_lists(cfg: MutableMapping[str, Any]) -> bool:
    archival = cfg.get("archival")
    if not isinstance(archival, MutableMapping):
        return False

    rsync = archival.get("rsync")
    if not isinstance(rsync, MutableMapping):
        return False

    changed = False
    changed |= _normalize_string_list(rsync, "options")
    changed |= _normalize_string_list(rsync, "ssh_options")
    return changed


_SECTION_FALLBACKS: Dict[str, Any] = {
    "streaming": {
        "mode": "hls",
        "webrtc_history_seconds": 8.0,
        "webrtc_ice_servers": [
            {
                "urls": [
                    "stun:stun.cloudflare.com:3478",
                    "stun:stun.l.google.com:19302",
                ]
            }
        ],
    },
    "dashboard": {
        "api_base": "",
        "services": [
            {
                "unit": "voice-recorder.service",
                "label": "Recorder",
                "description": "Segments microphone input into individual events.",
            },
            {
                "unit": "web-streamer.service",
                "label": "Web UI",
                "description": "Serves the dashboard and live stream.",
            },
            {
                "unit": "dropbox.service",
                "label": "Dropbox ingest",
                "description": "Monitors dropbox_dir for externally provided audio files.",
            },
            {
                "unit": "tricorder-auto-update.service",
                "label": "Auto updater",
                "description": "Applies updates staged by the project updater.",
            },
            {
                "unit": "tmpfs-guard.service",
                "label": "Tmpfs guard",
                "description": "Ensures tmpfs usage stays within configured limits.",
            },
        ],
        "web_service": "web-streamer.service",
    },
    "web_server": {
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
    },
}


def _clone_config_value(value: Any) -> Any:
    return copy.deepcopy(value)


def _template_section_default(section: str) -> Any:
    template = _load_comment_template()
    if template is not None:
        candidate = template.get(section)
        if candidate is not None:
            return _clone_config_value(candidate)
    fallback = _SECTION_FALLBACKS.get(section)
    if fallback is None:
        return {}
    return _clone_config_value(fallback)


def _seed_new_config_sections(
    cfg: MutableMapping[str, Any], *, had_comments: bool
) -> bool:
    changed = False
    added_section = False
    for section in ("streaming", "dashboard", "web_server"):
        existing = cfg.get(section)
        if isinstance(existing, MutableMapping):
            continue
        if isinstance(existing, Mapping):
            converted = _convert_to_round_trip(existing)
            if isinstance(converted, MutableMapping):
                cfg[section] = converted
                changed = True
                continue
        if existing is not None and section in cfg:
            # Respect non-mapping overrides (e.g., explicit null/false).
            continue
        cfg[section] = _template_section_default(section)
        changed = True
        added_section = True

    if added_section and not had_comments:
        template_doc = _template_with_values(cfg)
        if isinstance(template_doc, MutableMapping):
            try:
                cfg.clear()
            except Exception:
                pass
            else:
                for key, value in template_doc.items():
                    cfg[key] = _clone_config_value(value)
                changed = True
    return changed


def _migrate_segmenter_numeric_types(cfg: MutableMapping[str, Any]) -> bool:
    segmenter = cfg.get("segmenter")
    changed = False

    target: MutableMapping[str, Any] | None
    if isinstance(segmenter, MutableMapping):
        target = segmenter
    elif isinstance(segmenter, Mapping):
        converted = _convert_to_round_trip(segmenter)
        if isinstance(converted, MutableMapping):
            cfg["segmenter"] = converted
            target = converted
            changed = True
        else:
            target = None
    else:
        target = None

    if target is None:
        return changed

    int_fields: dict[str, tuple[int, int]] = {
        "pre_pad_ms": (0, 60_000),
        "post_pad_ms": (0, 120_000),
        "rms_threshold": (0, 10_000),
        "keep_window_frames": (1, 2_000),
        "start_consecutive": (1, 2_000),
        "keep_consecutive": (1, 2_000),
        "flush_threshold_bytes": (4_096, 4 * 1024 * 1024),
        "max_queue_frames": (16, 4_096),
        "filter_chain_metrics_window": (1, 10_000),
        "max_pending_encodes": (0, 1_000),
    }
    for key, bounds in int_fields.items():
        if _normalize_int_field(target, key, min_value=bounds[0], max_value=bounds[1]):
            changed = True

    float_fields: dict[str, tuple[float, float]] = {
        "motion_release_padding_minutes": (0.0, 30.0),
        "min_clip_seconds": (0.0, 600.0),
        "autosplit_interval_minutes": (0.0, 24 * 60.0),
        "filter_chain_avg_budget_ms": (0.0, 100.0),
        "filter_chain_peak_budget_ms": (0.0, 250.0),
        "filter_chain_log_throttle_sec": (0.0, 600.0),
    }
    for key, bounds in float_fields.items():
        if _normalize_float_field(target, key, min_value=bounds[0], max_value=bounds[1]):
            changed = True

    for key in (
        "use_rnnoise",
        "use_noisereduce",
        "denoise_before_vad",
        "auto_record_motion_override",
        "streaming_encode",
    ):
        if _normalize_bool_field(target, key):
            changed = True

    parallel = target.get("parallel_encode")
    parallel_map: MutableMapping[str, Any] | None
    if isinstance(parallel, MutableMapping):
        parallel_map = parallel
    elif isinstance(parallel, Mapping):
        converted_parallel = _convert_to_round_trip(parallel)
        if isinstance(converted_parallel, MutableMapping):
            target["parallel_encode"] = converted_parallel
            parallel_map = converted_parallel
            changed = True
        else:
            parallel_map = None
    else:
        parallel_map = None

    if parallel_map is not None:
        if _normalize_bool_field(parallel_map, "enabled"):
            changed = True

        parallel_float_fields: dict[str, tuple[float, float]] = {
            "load_avg_per_cpu": (0.0, 10.0),
            "min_event_seconds": (0.0, 3_600.0),
            "cpu_check_interval_sec": (0.0, 3_600.0),
            "offline_load_avg_per_cpu": (0.0, 10.0),
            "offline_cpu_check_interval_sec": (0.0, 3_600.0),
            "live_waveform_update_interval_sec": (0.05, 60.0),
        }
        for key, bounds in parallel_float_fields.items():
            if _normalize_float_field(parallel_map, key, min_value=bounds[0], max_value=bounds[1]):
                changed = True

        parallel_int_fields: dict[str, tuple[int, int]] = {
            "offline_max_workers": (0, 32),
            "live_waveform_buckets": (1, 16_384),
        }
        for key, bounds in parallel_int_fields.items():
            if _normalize_int_field(parallel_map, key, min_value=bounds[0], max_value=bounds[1]):
                changed = True

    return changed


_CONFIG_MIGRATIONS: tuple[tuple[str, _ConfigMigration], ...] = (
    ("20241018_normalize_config_value_types", _migrate_config_value_types),
    ("20241014_normalize_segmenter_numeric_types", _migrate_segmenter_numeric_types),
    ("20241005_normalize_archival_rsync_lists", _migrate_archival_rsync_lists),
)


def apply_config_migrations(*, logger: logging.Logger | None = None) -> bool:
    try:
        this_dir = Path(__file__).resolve().parent
        project_root = this_dir.parent
    except Exception:
        project_root = Path.cwd()

    try:
        script_dir = Path(sys.argv[0]).resolve().parent
    except Exception:
        script_dir = Path.cwd()

    search = _candidate_search_paths(project_root, script_dir)
    active: Path | None = None
    for candidate in search:
        try:
            if candidate.exists():
                active = candidate
                break
        except OSError:
            continue

    primary = _resolve_primary_path(search, active)
    if not primary.exists():
        return False

    try:
        document = _load_yaml_for_update(primary)
    except ConfigPersistenceError as exc:
        _migration_warning(logger, f"Unable to read configuration for migrations: {exc}")
        return False

    if not document:
        # Empty configuration means nothing to migrate; avoid creating files with defaults.
        return False

    had_comments = _file_has_comments(primary)

    changed = False
    try:
        if _seed_new_config_sections(document, had_comments=had_comments):
            changed = True
            _migration_info(
                logger,
                "Applied config migration 20241012_seed_dashboard_and_streaming_sections",
            )
    except Exception as exc:  # pragma: no cover - defensive logging
        _migration_warning(
            logger,
            f"Migration 20241012_seed_dashboard_and_streaming_sections failed: {exc}",
        )

    for name, migration in _CONFIG_MIGRATIONS:
        try:
            if migration(document):
                changed = True
                _migration_info(logger, f"Applied config migration {name}")
        except Exception as exc:  # pragma: no cover - defensive logging
            _migration_warning(logger, f"Migration {name} failed: {exc}")

    if not changed:
        return False

    try:
        _dump_yaml(primary, document)
    except ConfigPersistenceError as exc:
        _migration_warning(logger, f"Unable to persist configuration after migrations: {exc}")
        return False

    reload_cfg()
    return True


def _persist_settings_section(
    section: str, settings: Dict[str, Any], *, merge: bool = True
) -> Dict[str, Any]:
    if not isinstance(settings, dict):
        raise ConfigPersistenceError(f"{section} settings payload must be a mapping")

    primary_path = primary_config_path()
    current = _load_raw_yaml(primary_path)

    comment_hints: Dict[str, CommentHints] = {}
    if _ROUND_TRIP_YAML is None:
        existing_text = ""
        try:
            existing_text = primary_path.read_text(encoding="utf-8")
        except OSError as exc:
            print(
                f"Warning: unable to read configuration for comment hints: {exc}",
                flush=True,
            )
            existing_text = ""
        existing_comments = _extract_comment_hints(existing_text)
        template_comments: Dict[str, CommentHints] = {}
        if CONFIG_TEMPLATE_YAML:
            template_comments = _extract_comment_hints(CONFIG_TEMPLATE_YAML)
        comment_hints = {
            key: (list(prefix), inline)
            for key, (prefix, inline) in template_comments.items()
        }
        for key, (prefix, inline) in existing_comments.items():
            base_prefix, base_inline = comment_hints.get(key, ([], None))
            merged_prefix = prefix if prefix else base_prefix
            merged_inline = inline if inline is not None else base_inline
            comment_hints[key] = (list(merged_prefix), merged_inline)

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

    if comment_hints:
        try:
            rendered = primary_path.read_text(encoding="utf-8")
        except OSError as exc:
            print(
                f"Warning: unable to read configuration for comment hint application: {exc}",
                flush=True,
            )
            rendered = ""
        if rendered:
            rewritten = _apply_comment_hints(rendered, comment_hints)
            if rewritten != rendered:
                try:
                    primary_path.write_text(rewritten, encoding="utf-8")
                except OSError as exc:
                    print(
                        f"Warning: unable to write configuration with comment hints: {exc}",
                        flush=True,
                    )

    return reload_cfg().get(section, {})


def update_archival_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("archival", settings, merge=False)


def update_audio_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("audio", settings, merge=True)


def update_paths_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("paths", settings, merge=True)


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


def update_web_server_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("web_server", settings, merge=True)


def update_notifications_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    return _persist_settings_section("notifications", settings, merge=True)
