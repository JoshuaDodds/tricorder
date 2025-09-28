import json
import sys
import types
import wave
from pathlib import Path

import pytest

import lib.config as config


def _write_silence_wav(path: Path, *, seconds: float = 0.5, sample_rate: int = 48000) -> None:
    frame_count = int(seconds * sample_rate)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * frame_count)


def test_transcription_disabled_returns_false(tmp_path, monkeypatch):
    wav_path = tmp_path / "input.wav"
    _write_silence_wav(wav_path)

    monkeypatch.setenv("TRANSCRIPTION_ENABLED", "0")
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)

    from lib import transcription

    output_path = tmp_path / "out.json"
    wrote = transcription.transcribe_audio(wav_path, output_path, base_name="12-00-00_Human_1")
    assert wrote is False
    assert not output_path.exists()


def test_transcription_with_stub_vosk(tmp_path, monkeypatch):
    model_dir = tmp_path / "vosk"
    model_dir.mkdir()

    wav_path = tmp_path / "event.wav"
    _write_silence_wav(wav_path, seconds=0.2)

    class _DummyModel:
        def __init__(self, path: str) -> None:
            self.path = path

    class _DummyRecognizer:
        def __init__(self, model: _DummyModel, rate: float) -> None:
            self.model = model
            self.rate = rate
            self.words = False
            self.max_alt = 0
            self._chunks: list[bytes] = []

        def SetWords(self, enabled: bool) -> None:
            self.words = enabled

        def SetMaxAlternatives(self, count: int) -> None:
            self.max_alt = count

        def AcceptWaveform(self, data: bytes) -> bool:
            self._chunks.append(bytes(data))
            return False

        def FinalResult(self) -> str:
            payload = {
                "text": "hello zebra",
                "result": [
                    {"word": "hello", "start": 0.0, "end": 0.5, "conf": 0.9},
                    {"word": "zebra", "start": 0.5, "end": 1.0, "conf": 0.8},
                ],
                "alternatives": [
                    {"text": "hello zebra", "confidence": 0.99},
                ],
            }
            return json.dumps(payload)

    dummy_module = types.ModuleType("vosk_stub")
    dummy_module.Model = _DummyModel
    dummy_module.KaldiRecognizer = _DummyRecognizer
    dummy_module.SetLogLevel = lambda level: None

    monkeypatch.setitem(sys.modules, "vosk", dummy_module)
    monkeypatch.setenv("TRANSCRIPTION_ENABLED", "1")
    monkeypatch.setenv("TRANSCRIPTION_TYPES", "Human")
    monkeypatch.setenv("TRANSCRIPTION_TARGET_RATE", "16000")
    monkeypatch.setenv("TRANSCRIPTION_INCLUDE_WORDS", "1")
    monkeypatch.setenv("TRANSCRIPTION_MAX_ALTERNATIVES", "2")
    monkeypatch.setenv("VOSK_MODEL_PATH", str(model_dir))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)

    from lib import transcription

    cfg = config.get_cfg()
    assert cfg.get("transcription", {}).get("enabled") is True

    output_path = tmp_path / "transcript.json"
    wrote = transcription.transcribe_audio(
        wav_path,
        output_path,
        base_name="12-34-56_Human_RMS-100_1",
    )

    assert wrote is True
    data = json.loads(output_path.read_text(encoding="utf-8"))
    assert data["text"] == "hello zebra"
    assert data["engine"] == "vosk"
    assert data["event_type"] == "Human"
    assert data["base_name"] == "12-34-56_Human_RMS-100_1"
    assert data.get("words") and len(data["words"]) == 2
    assert any(entry.get("word") == "zebra" for entry in data["words"])
    assert data.get("alternatives") and data["alternatives"][0]["text"] == "hello zebra"
    assert Path(data["model_path"]).resolve() == model_dir.resolve()


def test_transcription_honours_canonical_event_alias(monkeypatch, tmp_path):
    model_dir = tmp_path / "vosk"
    model_dir.mkdir()

    wav_path = tmp_path / "event.wav"
    _write_silence_wav(wav_path, seconds=0.1)

    monkeypatch.setenv("EVENT_TAG_HUMAN", "Speech")
    monkeypatch.setenv("TRANSCRIPTION_ENABLED", "1")
    monkeypatch.setenv("TRANSCRIPTION_TYPES", "Human")
    monkeypatch.setenv("VOSK_MODEL_PATH", str(model_dir))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)

    from lib import transcription

    monkeypatch.setattr(
        transcription,
        "_transcribe_with_vosk",
        lambda *args, **kwargs: ("example", {"duration_seconds": 0.5}),
    )

    output_path = tmp_path / "alias.json"
    wrote = transcription.transcribe_audio(
        wav_path,
        output_path,
        base_name="12-34-56_Speech_RMS-100_1",
    )

    assert wrote is True
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["event_type"] == "Speech"

    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    config.reload_cfg()
