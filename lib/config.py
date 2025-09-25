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
import os
import sys
from pathlib import Path
from typing import Any, Dict

try:
    import yaml
except Exception:
    yaml = None  # pyyaml should be installed; if not, only defaults will be used.

_DEFAULTS: Dict[str, Any] = {
    "audio": {
        "device": "hw:CARD=Device,DEV=0",
        "sample_rate": 48000,
        "frame_ms": 20,
        "gain": 2.5,
        "vad_aggressiveness": 3,
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
}

_cfg_cache: Dict[str, Any] | None = None
_warned_yaml_missing = False

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

def get_cfg() -> Dict[str, Any]:
    global _cfg_cache
    if _cfg_cache is not None:
        return _cfg_cache

    cfg = dict(_DEFAULTS)

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

    # Build search list in priority order
    search: list[Path] = []
    env_cfg = os.getenv("TRICORDER_CONFIG")
    if env_cfg:
        search.append(Path(env_cfg).expanduser().resolve())
    search.extend([
        Path("/etc/tricorder/config.yaml"),
        Path("/apps/tricorder/config.yaml"),
        project_root / "config.yaml",
        script_dir / "config.yaml",
        Path.cwd() / "config.yaml",
    ])

    for p in search:
        cfg = _deep_merge(cfg, _load_yaml_if_exists(p))

    _apply_env_overrides(cfg)
    _cfg_cache = cfg
    return cfg
