import pytest

from lib import config as config_module


def _reset_config_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config_module, "_search_paths", [], raising=False)
    monkeypatch.setattr(config_module, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config_module, "_primary_config_path", None, raising=False)


def test_env_device_respects_config_override(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("audio:\n  device: plughw:CARD=seeed2micvoicec,DEV=0\n", encoding="utf-8")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setenv("AUDIO_DEV", "hw:CARD=Device,DEV=0")
    _reset_config_state(monkeypatch)

    cfg = config_module.get_cfg()

    assert cfg["audio"]["device"] == "plughw:CARD=seeed2micvoicec,DEV=0"


def test_env_device_still_overrides_when_config_uses_default(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("audio:\n  sample_rate: 16000\n", encoding="utf-8")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setenv("AUDIO_DEV", "hw:CARD=Loopback,DEV=1")
    _reset_config_state(monkeypatch)

    cfg = config_module.get_cfg()

    assert cfg["audio"]["device"] == "hw:CARD=Loopback,DEV=1"
