"""Tests covering environment variable overrides for audio config."""

from __future__ import annotations

from pathlib import Path

from lib import config as config_module


def _reset_config_state(monkeypatch) -> None:
    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config_module, "_search_paths", [], raising=False)
    monkeypatch.setattr(config_module, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config_module, "_primary_config_path", None, raising=False)


def test_audio_env_overrides(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("audio:\n  device: hw:CARD=Device,DEV=0\n")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setenv("AUDIO_CHANNELS", "2")
    monkeypatch.setenv("AUDIO_USB_RESET_WORKAROUND", "false")

    _reset_config_state(monkeypatch)

    cfg = config_module.get_cfg()

    audio_cfg = cfg.get("audio", {})
    assert audio_cfg["channels"] == 2
    assert audio_cfg["usb_reset_workaround"] is False


def test_audio_env_channels_clamped(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("audio:\n  device: hw:CARD=Device,DEV=0\n")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setenv("AUDIO_CHANNELS", "99")

    _reset_config_state(monkeypatch)

    cfg = config_module.get_cfg()

    audio_cfg = cfg.get("audio", {})
    assert audio_cfg["channels"] == 2
