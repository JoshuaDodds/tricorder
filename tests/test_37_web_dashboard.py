import asyncio
import os

import json
import time
from datetime import datetime, timezone
import io
import shutil
import wave
import zipfile
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from lib import web_streamer
import lib.config as config
import yaml


@pytest.fixture
def dashboard_env(tmp_path, monkeypatch):
    recordings_dir = tmp_path / "recordings"
    recordings_dir.mkdir()
    tmp_dir = tmp_path / "tmp"
    tmp_dir.mkdir()
    dropbox_dir = tmp_path / "dropbox"
    dropbox_dir.mkdir()

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))
    monkeypatch.setenv("DROPBOX_DIR", str(dropbox_dir))
    monkeypatch.setenv("TRICORDER_TMP", str(tmp_dir))

    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)
    yield recordings_dir
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)


async def _start_client(app: web.Application) -> tuple[TestClient, TestServer]:
    server = TestServer(app)
    client = TestClient(server)
    await client.start_server()
    return client, server


def _write_waveform_stub(target: Path, duration: float = 1.0) -> None:
    payload = {
        "version": 1,
        "channels": 1,
        "sample_rate": 48000,
        "frame_count": int(max(duration, 0) * 48000),
        "duration_seconds": duration,
        "peak_scale": 32767,
        "peaks": [0, 0],
    }
    target.write_text(json.dumps(payload), encoding="utf-8")


def _create_silent_wav(path: Path, duration: float = 2.0) -> None:
    frame_count = max(1, int(48000 * max(duration, 0)))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(b"\x00\x00" * frame_count)


def test_recordings_listing_filters(dashboard_env, monkeypatch):
    async def runner():
        day_a = dashboard_env / "20240101"
        day_b = dashboard_env / "20240102"
        day_a.mkdir()
        day_b.mkdir()

        file_a = day_a / "alpha.opus"
        file_b = day_a / "beta.opus"
        file_c = day_b / "gamma.opus"

        file_a.write_bytes(b"a")
        file_b.write_bytes(b"b")
        file_c.write_bytes(b"c")

        for item in (file_a, file_b, file_c):
            _write_waveform_stub(item.with_suffix(item.suffix + ".waveform.json"))

        os.utime(file_a, (1_700_000_000, 1_700_000_000))
        os.utime(file_b, (1_700_010_000, 1_700_010_000))
        os.utime(file_c, (1_700_020_000, 1_700_020_000))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings?limit=10")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["total"] == 3
            names = [item["name"] for item in payload["items"]]
            assert names == ["gamma", "beta", "alpha"]
            assert all(item.get("waveform_path") for item in payload["items"])
            assert "20240101" in payload["available_days"]
            assert "20240102" in payload["available_days"]
            assert payload.get("time_range") == ""

            resp = await client.get("/api/recordings?day=20240101&limit=10")
            data = await resp.json()
            assert all(item["day"] == "20240101" for item in data["items"])

            resp = await client.get("/api/recordings?search=beta")
            search = await resp.json()
            assert [item["name"] for item in search["items"]] == ["beta"]

            monkeypatch.setattr(web_streamer.time, "time", lambda: 1_700_030_000)
            resp = await client.get("/api/recordings?time_range=1h&limit=10")
            recent = await resp.json()
            assert recent.get("time_range") == "1h"
            assert recent["total"] == 0
            assert recent["items"] == []
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_search_matches_transcripts(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240103"
        day_dir.mkdir()

        file_path = day_dir / "speech.opus"
        file_path.write_bytes(b"sample")
        _write_waveform_stub(file_path.with_suffix(file_path.suffix + ".waveform.json"))
        os.utime(file_path, (1_700_030_000, 1_700_030_000))

        transcript_payload = {
            "version": 1,
            "engine": "vosk",
            "text": "Zebra crossing alert",
            "event_type": "Human",
        }
        transcript_path = file_path.with_suffix(file_path.suffix + ".transcript.json")
        transcript_path.write_text(json.dumps(transcript_payload), encoding="utf-8")
        os.utime(transcript_path, (1_700_030_000, 1_700_030_000))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings?search=zebra")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["total"] == 1
            item = payload["items"][0]
            assert item["name"] == "speech"
            assert item["has_transcript"] is True
            assert item["transcript_event_type"] == "Human"
            assert item["transcript_excerpt"].lower().startswith("zebra")
            assert item["transcript_path"].endswith(".transcript.json")
            expected_updated = 1_700_030_000
            assert item["transcript_updated"] == pytest.approx(expected_updated, rel=0, abs=1e-6)
            expected_iso = datetime.fromtimestamp(expected_updated, tz=timezone.utc).isoformat()
            assert item["transcript_updated_iso"] == expected_iso

            miss = await client.get("/api/recordings?search=walrus")
            assert miss.status == 200
            miss_payload = await miss.json()
            assert miss_payload["total"] == 0
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_archival_settings_round_trip(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
archival:
  enabled: false
  backend: network_share
  network_share:
    target_dir: "/mnt/archive/tricorder"
""".strip()
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/config/archival")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["archival"]["backend"] == "network_share"
            assert (
                payload["archival"]["network_share"]["target_dir"]
                == "/mnt/archive/tricorder"
            )
            assert payload["config_path"] == str(config_path)
            assert payload["archival"]["include_transcript_sidecars"] is True

            update_payload = {
                "enabled": True,
                "backend": "rsync",
                "include_waveform_sidecars": True,
                "include_transcript_sidecars": False,
                "network_share": {"target_dir": "/mnt/archive/tricorder"},
                "rsync": {
                    "destination": "user@example.com:/srv/tricorder/archive",
                    "ssh_identity": "/home/pi/.ssh/id_ed25519",
                    "options": ["-az", "--delete"],
                    "ssh_options": ["-oStrictHostKeyChecking=yes"],
                },
            }

            resp = await client.post("/api/config/archival", json=update_payload)
            assert resp.status == 200
            updated = await resp.json()
            assert updated["archival"]["backend"] == "rsync"
            assert updated["archival"]["enabled"] is True
            assert (
                updated["archival"]["rsync"]["destination"]
                == "user@example.com:/srv/tricorder/archive"
            )
            assert updated["archival"]["include_waveform_sidecars"] is True
            assert updated["archival"]["include_transcript_sidecars"] is False

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert persisted["archival"]["backend"] == "rsync"
            assert (
                persisted["archival"]["rsync"]["destination"]
                == "user@example.com:/srv/tricorder/archive"
            )
            assert persisted["archival"]["include_waveform_sidecars"] is True
            assert (
                persisted["archival"].get("include_transcript_sidecars") is False
            )
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_archival_settings_validation_error(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("archival:\n  enabled: false\n", encoding="utf-8")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {
                "enabled": True,
                "backend": "rsync",
                "rsync": {"destination": ""},
            }
            resp = await client.post("/api/config/archival", json=payload)
            assert resp.status == 400
            error_payload = await resp.json()
            assert "destination" in error_payload.get("error", "")
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_audio_settings_round_trip(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
audio:
  device: "hw:1,0"
  sample_rate: 32000
  frame_ms: 20
  gain: 2.0
  vad_aggressiveness: 2
  filter_chain:
    highpass:
      enabled: true
      cutoff_hz: 110.0
    notch:
      enabled: true
      freq_hz: 120.0
      quality: 35.0
    spectral_gate:
      enabled: false
      sensitivity: 1.7
      reduction_db: -20.0
      noise_update: 0.2
      noise_decay: 0.9
  calibration:
    auto_noise_profile: true
    auto_gain: false
""".strip()
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        systemctl_calls: list[list[str]] = []

        async def fake_systemctl(args):
            systemctl_calls.append(list(args))
            if args and args[0] == "is-active":
                return 0, "active\n", ""
            return 0, "", ""

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/config/audio")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["audio"]["device"] == "hw:1,0"
            assert payload["audio"]["sample_rate"] == 32000
            assert payload["audio"]["filter_chain"]["highpass"]["enabled"] is True
            assert (
                payload["audio"]["filter_chain"]["highpass"]["cutoff_hz"]
                == pytest.approx(110.0)
            )
            assert payload["audio"]["calibration"]["auto_noise_profile"] is True

            update_payload = {
                "device": "hw:CARD=Device,DEV=0",
                "sample_rate": 48000,
                "frame_ms": 10,
                "gain": 1.5,
                "vad_aggressiveness": 3,
                "filter_chain": {
                    "highpass": {"enabled": True, "cutoff_hz": 140.0},
                    "notch": {"enabled": False, "freq_hz": 180.0, "quality": 28.0},
                    "spectral_gate": {
                        "enabled": True,
                        "sensitivity": 1.3,
                        "reduction_db": -24.0,
                        "noise_update": 0.05,
                        "noise_decay": 0.92,
                    },
                },
                "calibration": {"auto_noise_profile": False, "auto_gain": True},
            }

            resp = await client.post("/api/config/audio", json=update_payload)
            assert resp.status == 200
            updated = await resp.json()
            assert updated["audio"]["frame_ms"] == 10
            assert updated["audio"]["gain"] == pytest.approx(1.5)
            assert updated["audio"]["device"] == "hw:CARD=Device,DEV=0"
            assert updated["audio"]["filter_chain"]["notch"]["enabled"] is False
            assert (
                updated["audio"]["filter_chain"]["notch"]["freq_hz"]
                == pytest.approx(180.0)
            )
            assert updated["audio"]["filter_chain"]["spectral_gate"]["enabled"] is True
            assert (
                updated["audio"]["filter_chain"]["spectral_gate"]["reduction_db"]
                == pytest.approx(-24.0)
            )
            assert updated["audio"]["calibration"]["auto_noise_profile"] is False
            assert updated["audio"]["calibration"]["auto_gain"] is True

            assert systemctl_calls == [
                ["is-active", "voice-recorder.service"],
                ["restart", "voice-recorder.service"],
            ]

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert persisted["audio"]["gain"] == 1.5
            assert persisted["audio"]["frame_ms"] == 10
            assert persisted["audio"]["filter_chain"]["highpass"]["enabled"] is True
            assert (
                persisted["audio"]["filter_chain"]["highpass"]["cutoff_hz"]
                == pytest.approx(140.0)
            )
            assert persisted["audio"]["filter_chain"]["notch"]["enabled"] is False
            assert persisted["audio"]["filter_chain"]["spectral_gate"]["enabled"] is True
            assert (
                persisted["audio"]["filter_chain"]["spectral_gate"]["sensitivity"]
                == pytest.approx(1.3)
            )
            assert persisted["audio"]["calibration"]["auto_noise_profile"] is False
            assert persisted["audio"]["calibration"]["auto_gain"] is True
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_audio_settings_preserve_filter_stage_list(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        (
            "audio:\n"
            "  device: hw:1,0\n"
            "  filter_chain:\n"
            "    - type: notch\n"
            "      frequency: 120.0\n"
            "      q: 14.5\n"
            "      gain_db: -12.0\n"
            "    - type: notch\n"
            "      frequency: 240.0\n"
            "      q: 16.0\n"
            "      gain_db: -18.0\n"
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        systemctl_calls: list[list[str]] = []

        async def fake_systemctl(args):
            systemctl_calls.append(list(args))
            if args and args[0] == "is-active":
                return 0, "active\n", ""
            return 0, "", ""

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/config/audio")
            assert resp.status == 200
            payload = await resp.json()
            filters = payload["audio"]["filter_chain"].get("filters")
            assert isinstance(filters, list)
            assert len(filters) == 2
            assert filters[0]["frequency"] == pytest.approx(120.0)
            assert filters[1]["frequency"] == pytest.approx(240.0)

            update_payload = {
                "device": "hw:1,0",
                "sample_rate": 48000,
                "frame_ms": 20,
                "gain": 3.0,
                "vad_aggressiveness": 2,
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
            }

            resp = await client.post("/api/config/audio", json=update_payload)
            assert resp.status == 200
            updated = await resp.json()
            updated_filters = updated["audio"]["filter_chain"].get("filters")
            assert isinstance(updated_filters, list)
            assert len(updated_filters) == 2
            assert updated_filters[0]["frequency"] == pytest.approx(120.0)
            assert updated_filters[1]["frequency"] == pytest.approx(240.0)

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert isinstance(persisted["audio"]["filter_chain"], dict)
            persisted_filters = persisted["audio"]["filter_chain"].get("filters")
            assert isinstance(persisted_filters, list)
            assert len(persisted_filters) == 2
            assert persisted_filters[0]["frequency"] == pytest.approx(120.0)
            assert persisted_filters[1]["frequency"] == pytest.approx(240.0)

            assert systemctl_calls == [
                ["is-active", "voice-recorder.service"],
                ["restart", "voice-recorder.service"],
            ]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_audio_settings_skip_restart_when_inactive(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "audio:\n  device: hw:1,0\n  sample_rate: 32000\n  frame_ms: 30\n  gain: 1.0\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        systemctl_calls: list[list[str]] = []

        async def fake_systemctl(args):
            systemctl_calls.append(list(args))
            if args and args[0] == "is-active":
                return 3, "inactive\n", ""
            pytest.fail(f"unexpected systemctl call: {args}")

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/config/audio",
                json={
                    "device": "hw:CARD=Device,DEV=0",
                    "sample_rate": 48000,
                    "frame_ms": 10,
                    "gain": 1.5,
                    "vad_aggressiveness": 3,
                },
            )
            assert resp.status == 200
            payload = await resp.json()
            assert payload["audio"]["gain"] == pytest.approx(1.5)
            assert payload["audio"]["device"] == "hw:CARD=Device,DEV=0"

            assert systemctl_calls == [["is-active", "voice-recorder.service"]]

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert persisted["audio"]["gain"] == 1.5
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_streaming_settings_restart_services(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("streaming:\n  mode: hls\n", encoding="utf-8")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        systemctl_calls: list[list[str]] = []

        async def fake_systemctl(args):
            systemctl_calls.append(list(args))
            if args and args[0] == "is-active":
                return 0, "active\n", ""
            return 0, "", ""

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {"mode": "webrtc", "webrtc_history_seconds": 12.0}
            resp = await client.post("/api/config/streaming", json=payload)
            assert resp.status == 200
            data = await resp.json()
            assert data["streaming"]["mode"] == "webrtc"
            assert data["streaming"]["webrtc_history_seconds"] == pytest.approx(12.0)

            assert systemctl_calls == [
                ["is-active", "voice-recorder.service"],
                ["restart", "voice-recorder.service"],
                ["is-active", "web-streamer.service"],
                ["restart", "web-streamer.service"],
            ]

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert persisted["streaming"]["mode"] == "webrtc"
            assert persisted["streaming"]["webrtc_history_seconds"] == 12.0
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_audio_settings_validation_error(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("audio:\n  device: hw:1,0\n", encoding="utf-8")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {
                "device": "",
                "sample_rate": 12345,
                "frame_ms": 15,
                "gain": -1,
                "vad_aggressiveness": 7,
                "filter_chain": {
                    "highpass": {"enabled": True, "cutoff_hz": 5},
                },
            }
            resp = await client.post("/api/config/audio", json=payload)
            assert resp.status == 400
            data = await resp.json()
            assert data["error"]
            assert any(
                "filter_chain.highpass.cutoff_hz" in err for err in data.get("errors", [])
            )
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_transcription_settings_roundtrip(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
transcription:
  enabled: false
  engine: vosk
  types:
    - Human
  vosk_model_path: /models/vosk/en-us
  target_sample_rate: 16000
  include_words: true
  max_alternatives: 0
""".strip()
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        systemctl_calls: list[list[str]] = []

        async def fake_systemctl(args):
            systemctl_calls.append(list(args))
            if args and args[0] == "is-active":
                return 0, "active\n", ""
            return 0, "", ""

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/config/transcription")
            assert resp.status == 200
            payload = await resp.json()
            section = payload["transcription"]
            assert section["engine"] == "vosk"
            assert section["vosk_model_path"] == "/models/vosk/en-us"
            assert section["types"] == ["Human"]

            update_payload = {
                "enabled": True,
                "engine": "vosk",
                "types": ["Human", "Both"],
                "vosk_model_path": "/models/vosk/custom",
                "target_sample_rate": 22050,
                "include_words": False,
                "max_alternatives": 2,
            }

            resp = await client.post("/api/config/transcription", json=update_payload)
            assert resp.status == 200
            updated = await resp.json()
            section = updated["transcription"]
            assert section["enabled"] is True
            assert section["types"] == ["Human", "Both"]
            assert section["target_sample_rate"] == 22050
            assert section["include_words"] is False
            assert section["max_alternatives"] == 2

            assert systemctl_calls == [
                ["is-active", "voice-recorder.service"],
                ["restart", "voice-recorder.service"],
            ]

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert persisted["transcription"]["enabled"] is True
            assert persisted["transcription"]["vosk_model_path"] == "/models/vosk/custom"
            assert persisted["transcription"]["types"] == ["Human", "Both"]
            assert persisted["transcription"]["max_alternatives"] == 2
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_transcription_settings_require_model_path(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("transcription:\n  enabled: false\n", encoding="utf-8")

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)

    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {
                "enabled": True,
                "engine": "vosk",
                "vosk_model_path": " ",
            }
            resp = await client.post("/api/config/transcription", json=payload)
            assert resp.status == 400
            data = await resp.json()
            assert "error" in data
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_clip_endpoint_creates_trimmed_file(dashboard_env):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")

    async def runner():
        day_dir = dashboard_env / "20240105"
        day_dir.mkdir()

        source = day_dir / "sample.wav"
        _create_silent_wav(source, duration=2.0)
        _write_waveform_stub(source.with_suffix(source.suffix + ".waveform.json"), duration=2.0)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {
                "source_path": "20240105/sample.wav",
                "start_seconds": 0.25,
                "end_seconds": 1.5,
                "clip_name": "trimmed take",
                "source_start_epoch": 1_700_000_000.0,
            }
            resp = await client.post("/api/recordings/clip", json=payload)
            assert resp.status == 200
            data = await resp.json()
            assert data["path"].startswith("20240105/")
            clip_file = dashboard_env / data["path"]
            assert clip_file.exists()
            assert clip_file.suffix == ".opus"
            clip_waveform = clip_file.with_suffix(clip_file.suffix + ".waveform.json")
            assert clip_waveform.exists()
            assert clip_file.stat().st_size > 0
            expected_start = payload["source_start_epoch"] + payload["start_seconds"]
            assert clip_file.stat().st_mtime == pytest.approx(expected_start, abs=0.5)
            waveform_payload = json.loads(clip_waveform.read_text())
            assert waveform_payload.get("duration_seconds")
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_clip_overwrite_and_undo(dashboard_env):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")

    async def runner():
        day_dir = dashboard_env / "20240107"
        day_dir.mkdir()

        source = day_dir / "long.wav"
        _create_silent_wav(source, duration=3.0)
        _write_waveform_stub(source.with_suffix(source.suffix + ".waveform.json"), duration=3.0)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            initial_payload = {
                "source_path": "20240107/long.wav",
                "start_seconds": 0.0,
                "end_seconds": 2.5,
                "clip_name": "long-clip",
            }
            resp = await client.post("/api/recordings/clip", json=initial_payload)
            assert resp.status == 200
            data = await resp.json()
            clip_rel_path = data["path"]
            clip_file = dashboard_env / clip_rel_path
            clip_waveform = clip_file.with_suffix(clip_file.suffix + ".waveform.json")
            assert clip_file.exists()
            original_waveform = json.loads(clip_waveform.read_text())
            original_duration = original_waveform.get("duration_seconds")
            assert isinstance(original_duration, (int, float))
            assert not data.get("undo_token")
            clip_name = data.get("name")
            assert isinstance(clip_name, str) and clip_name

            update_payload = {
                "source_path": clip_rel_path,
                "start_seconds": 0.5,
                "end_seconds": 1.25,
                "clip_name": clip_name,
            }
            resp_update = await client.post("/api/recordings/clip", json=update_payload)
            assert resp_update.status == 200
            data_update = await resp_update.json()
            assert data_update["path"] == clip_rel_path
            undo_token = data_update.get("undo_token")
            assert isinstance(undo_token, str) and undo_token

            updated_waveform = json.loads(clip_waveform.read_text())
            updated_duration = updated_waveform.get("duration_seconds")
            assert isinstance(updated_duration, (int, float))
            assert updated_duration < original_duration - 0.1

            resp_undo = await client.post("/api/recordings/clip/undo", json={"token": undo_token})
            assert resp_undo.status == 200
            data_undo = await resp_undo.json()
            assert data_undo["path"] == clip_rel_path

            restored_waveform = json.loads(clip_waveform.read_text())
            restored_duration = restored_waveform.get("duration_seconds")
            assert isinstance(restored_duration, (int, float))
            assert restored_duration == pytest.approx(original_duration, rel=0.01)

            resp_undo_again = await client.post("/api/recordings/clip/undo", json={"token": undo_token})
            assert resp_undo_again.status == 404
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_clip_rejects_conflicting_name_without_overwrite(dashboard_env):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")

    async def runner():
        day_dir = dashboard_env / "20240108"
        day_dir.mkdir()

        source = day_dir / "source.wav"
        _create_silent_wav(source, duration=2.5)
        _write_waveform_stub(source.with_suffix(source.suffix + ".waveform.json"), duration=2.5)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            initial_payload = {
                "source_path": "20240108/source.wav",
                "start_seconds": 0.0,
                "end_seconds": 1.0,
                "clip_name": "conflict-test",
            }
            resp = await client.post("/api/recordings/clip", json=initial_payload)
            assert resp.status == 200
            data = await resp.json()
            clip_rel_path = data["path"]
            clip_file = dashboard_env / clip_rel_path
            assert clip_file.exists()
            original_stat = clip_file.stat()

            conflict_payload = {
                "source_path": "20240108/source.wav",
                "start_seconds": 1.0,
                "end_seconds": 2.0,
                "clip_name": "conflict-test",
                "allow_overwrite": False,
            }
            resp_conflict = await client.post("/api/recordings/clip", json=conflict_payload)
            assert resp_conflict.status == 400

            # Ensure the existing clip was not replaced
            after_stat = clip_file.stat()
            assert after_stat.st_mtime == original_stat.st_mtime
            assert after_stat.st_size == original_stat.st_size
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_clip_rename_without_reencoding(dashboard_env):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")

    async def runner():
        day_dir = dashboard_env / "20240109"
        day_dir.mkdir()

        original_clip = day_dir / "existing.opus"
        original_clip.write_bytes(b"original-clip-data")
        _write_waveform_stub(
            original_clip.with_suffix(original_clip.suffix + ".waveform.json"), duration=1.0
        )
        os.utime(original_clip, (1_700_100_000, 1_700_100_000))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {
                "source_path": f"{day_dir.name}/{original_clip.name}",
                "start_seconds": 0.0,
                "end_seconds": 1.0,
                "clip_name": "renamed-clip",
                "overwrite_existing": f"{day_dir.name}/{original_clip.name}",
            }
            resp = await client.post("/api/recordings/clip", json=payload)
            assert resp.status == 200
            data = await resp.json()
            assert data["path"] == f"{day_dir.name}/renamed-clip.opus"
            assert data.get("undo_token") is None
            assert data.get("duration_seconds") == pytest.approx(1.0, rel=0.01)

            renamed_path = day_dir / "renamed-clip.opus"
            assert renamed_path.exists()
            assert renamed_path.read_bytes() == b"original-clip-data"
            assert not original_clip.exists()

            renamed_waveform = renamed_path.with_suffix(renamed_path.suffix + ".waveform.json")
            assert renamed_waveform.exists()
            assert json.loads(renamed_waveform.read_text()).get("duration_seconds") == pytest.approx(
                1.0, rel=0.01
            )
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_clip_endpoint_validates_range(dashboard_env):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")

    async def runner():
        day_dir = dashboard_env / "20240106"
        day_dir.mkdir()

        source = day_dir / "invalid.wav"
        _create_silent_wav(source, duration=1.0)
        _write_waveform_stub(source.with_suffix(source.suffix + ".waveform.json"), duration=1.0)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            payload = {
                "source_path": "20240106/invalid.wav",
                "start_seconds": 0.5,
                "end_seconds": 0.25,
            }
            resp = await client.post("/api/recordings/clip", json=payload)
            assert resp.status == 400
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_dashboard_enables_cors_for_remote_requests(monkeypatch, dashboard_env, tmp_path):
    async def runner():
        config_path = tmp_path / "remote_dashboard.yaml"
        config_path.write_text("dashboard:\n  api_base: 'https://recorder.example'\n", encoding="utf-8")
        monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
        monkeypatch.setattr(config, "_cfg_cache", None, raising=False)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            origin = "https://dashboard.example"
            options_resp = await client.options(
                "/api/recordings",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "GET",
                },
            )
            assert options_resp.status == 204
            assert options_resp.headers.get("Access-Control-Allow-Origin") == "*"
            allow_methods = options_resp.headers.get("Access-Control-Allow-Methods", "")
            assert "GET" in allow_methods and "POST" in allow_methods
            allow_headers = options_resp.headers.get("Access-Control-Allow-Headers", "")
            assert "Content-Type" in allow_headers

            get_resp = await client.get("/api/recordings", headers={"Origin": origin})
            assert get_resp.status == 200
            assert get_resp.headers.get("Access-Control-Allow-Origin") == "*"
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_pagination(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240110"
        day_dir.mkdir()

        base_epoch = 1_700_100_000
        for idx in range(12):
            file = day_dir / f"{idx:02d}.opus"
            file.write_bytes(b"data")
            _write_waveform_stub(file.with_suffix(file.suffix + ".waveform.json"))
            os.utime(file, (base_epoch + idx, base_epoch + idx))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["limit"] == web_streamer.DEFAULT_RECORDINGS_LIMIT
            assert payload["offset"] == 0
            assert payload["total"] == 12

            first_resp = await client.get("/api/recordings?limit=5")
            first_page = await first_resp.json()
            assert first_page["limit"] == 5
            assert first_page["offset"] == 0
            assert [item["name"] for item in first_page["items"]] == [
                "11",
                "10",
                "09",
                "08",
                "07",
            ]

            second_resp = await client.get("/api/recordings?limit=5&offset=5")
            second_page = await second_resp.json()
            assert second_page["offset"] == 5
            assert [item["name"] for item in second_page["items"]] == [
                "06",
                "05",
                "04",
                "03",
                "02",
            ]

            third_resp = await client.get("/api/recordings?limit=5&offset=10")
            third_page = await third_resp.json()
            assert third_page["offset"] == 10
            assert [item["name"] for item in third_page["items"]] == ["01", "00"]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recording_start_epoch_in_payload(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240105"
        day_dir.mkdir()

        recording = day_dir / "12-34-56_Both_1.opus"
        recording.write_bytes(b"d")
        waveform = recording.with_suffix(recording.suffix + ".waveform.json")
        _write_waveform_stub(waveform, duration=3.5)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings?limit=5")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["items"], "Expected at least one recording"
            match = next((item for item in payload["items"] if item["name"] == "12-34-56_Both_1"), None)
            assert match is not None
            expected = time.mktime(time.strptime("20240105 12-34-56", "%Y%m%d %H-%M-%S"))
            assert match["start_epoch"] == pytest.approx(expected, rel=0, abs=1e-6)
            assert isinstance(match["started_at"], str)
            assert match["started_at"].startswith("2024-01-05T")
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_delete_recording(dashboard_env):
    async def runner():
        target_dir = dashboard_env / "20240103"
        target_dir.mkdir()
        target = target_dir / "delete-me.opus"
        target.write_bytes(b"data")
        waveform = target.with_suffix(target.suffix + ".waveform.json")
        _write_waveform_stub(waveform)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/recordings/delete", json={"items": ["20240103/delete-me.opus"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == ["20240103/delete-me.opus"]
            assert not target.exists()
            assert not waveform.exists()

            resp = await client.post("/api/recordings/delete", json={"items": ["../outside"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == []
            assert payload["errors"]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_services_listing_reports_status(monkeypatch, dashboard_env):
    async def runner():
        show_map = {
            "voice-recorder.service": (
                "loaded",
                "active",
                "running",
                "enabled",
                "Recorder",
                "yes",
                "yes",
                "no",
                "yes",
                "",
            ),
            "web-streamer.service": (
                "loaded",
                "active",
                "running",
                "enabled",
                "Web UI",
                "yes",
                "yes",
                "no",
                "yes",
                "",
            ),
        }

        async def fake_systemctl(args):
            if args and args[0] == "show" and len(args) >= 2:
                unit = args[1]
                values = show_map.get(
                    unit,
                    (
                        "not-found",
                        "",
                        "",
                        "",
                        "",
                        "no",
                        "no",
                        "no",
                        "no",
                        "",
                    ),
                )
                payload = "\n".join(
                    f"{key}={value}"
                    for key, value in zip(web_streamer._SYSTEMCTL_PROPERTIES, values)
                )
                return 0, f"{payload}\n", ""
            return 0, "", ""

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/services")
            assert resp.status == 200
            payload = await resp.json()
            services = payload.get("services", [])
            assert isinstance(services, list) and services, "Expected services in payload"
            recorder = next((item for item in services if item["unit"] == "voice-recorder.service"), None)
            assert recorder is not None
            assert recorder["status_text"].startswith("Active")
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_service_action_auto_restart(monkeypatch, dashboard_env):
    async def runner():
        show_map = {
            "web-streamer.service": (
                "loaded",
                "active",
                "running",
                "enabled",
                "Web UI",
                "yes",
                "yes",
                "no",
                "yes",
                "",
            )
        }

        async def fake_systemctl(args):
            if args and args[0] == "show" and len(args) >= 2:
                unit = args[1]
                values = show_map.get(
                    unit,
                    (
                        "loaded",
                        "inactive",
                        "dead",
                        "disabled",
                        "",
                        "yes",
                        "yes",
                        "no",
                        "yes",
                        "",
                    ),
                )
                payload = "\n".join(
                    f"{key}={value}"
                    for key, value in zip(web_streamer._SYSTEMCTL_PROPERTIES, values)
                )
                return 0, f"{payload}\n", ""
            return 0, "", ""

        scheduled: list[tuple[str, list[str], float]] = []

        def fake_enqueue(unit: str, actions, delay: float = 0.5) -> None:
            scheduled.append((unit, list(actions), delay))

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)
        monkeypatch.setattr(web_streamer, "_enqueue_service_actions", fake_enqueue)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/services/web-streamer.service/action",
                json={"action": "stop"},
            )
            assert resp.status == 200
            payload = await resp.json()
            assert payload["requested_action"] == "stop"
            assert payload["executed_action"] == "restart"
            assert payload["ok"] is True
            assert payload.get("auto_restart") is True
            assert payload.get("scheduled_actions") == ["restart"]
            assert scheduled and scheduled[0][0] == "web-streamer.service"
            assert scheduled[0][1] == ["restart"]
            assert scheduled[0][2] == pytest.approx(0.5, rel=0, abs=1e-6)
            status = payload.get("status", {})
            assert status.get("unit") == "web-streamer.service"
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_service_action_recorder_restart_keeps_dashboard(monkeypatch, dashboard_env):
    async def runner():
        show_map = {
            "voice-recorder.service": (
                "loaded",
                "active",
                "running",
                "enabled",
                "Recorder",
                "yes",
                "yes",
                "no",
                "yes",
                "",
            ),
            "web-streamer.service": (
                "loaded",
                "inactive",
                "dead",
                "enabled",
                "Web UI",
                "yes",
                "yes",
                "no",
                "yes",
                "",
            ),
        }

        systemctl_calls: list[list[str]] = []
        scheduled: list[tuple[str, list[str], float]] = []

        async def fake_systemctl(args):
            systemctl_calls.append(list(args))
            if args and args[0] == "show" and len(args) >= 2:
                unit = args[1]
                values = show_map.get(unit)
                if values is None:
                    values = (
                        "loaded",
                        "inactive",
                        "dead",
                        "disabled",
                        "",
                        "yes",
                        "yes",
                        "no",
                        "yes",
                        "",
                    )
                payload = "\n".join(
                    f"{key}={value}"
                    for key, value in zip(web_streamer._SYSTEMCTL_PROPERTIES, values)
                )
                return 0, f"{payload}\n", ""
            return 0, "", ""

        def fake_enqueue(unit: str, actions, delay: float = 0.5) -> None:
            scheduled.append((unit, list(actions), delay))

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)
        monkeypatch.setattr(web_streamer, "_enqueue_service_actions", fake_enqueue)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/services/voice-recorder.service/action",
                json={"action": "restart"},
            )
            assert resp.status == 200
            payload = await resp.json()
            assert payload["requested_action"] == "restart"
            assert payload["executed_action"] == "restart"
            assert payload.get("ok") is True

            assert [
                call for call in systemctl_calls if call[:2] == ["restart", "voice-recorder.service"]
            ]

            kick_calls = [
                item for item in scheduled if item[0] == "web-streamer.service" and item[1] == ["start"]
            ]
            assert kick_calls, "Expected dashboard web service to be started"
            assert kick_calls[0][2] == pytest.approx(1.0, rel=0, abs=1e-6)
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_rename_endpoint(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240104"
        day_dir.mkdir()

        original = day_dir / "alpha.opus"
        original.write_bytes(b"alpha")
        _write_waveform_stub(original.with_suffix(original.suffix + ".waveform.json"))
        transcript_original = original.with_suffix(original.suffix + ".transcript.json")
        transcript_original.write_text(json.dumps({"text": "alpha"}), encoding="utf-8")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/recordings/rename",
                json={"item": f"{day_dir.name}/{original.name}", "name": "beta"},
            )
            assert resp.status == 200
            payload = await resp.json()
            assert payload["old_path"].endswith("alpha.opus")
            assert payload["new_path"].endswith("beta.opus")
            renamed_path = day_dir / "beta.opus"
            assert renamed_path.exists()
            assert not original.exists()

            new_waveform = renamed_path.with_suffix(renamed_path.suffix + ".waveform.json")
            new_transcript = renamed_path.with_suffix(renamed_path.suffix + ".transcript.json")
            assert new_waveform.exists()
            assert new_transcript.exists()
            assert not transcript_original.exists()

            conflict_target = day_dir / "gamma.opus"
            conflict_target.write_bytes(b"gamma")
            conflict_resp = await client.post(
                "/api/recordings/rename",
                json={
                    "item": f"{day_dir.name}/{renamed_path.name}",
                    "name": conflict_target.stem,
                },
            )
            assert conflict_resp.status == 409
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_bulk_download_includes_sidecars(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240105"
        day_dir.mkdir()

        first = day_dir / "alpha.opus"
        second = day_dir / "beta.opus"
        for path in (first, second):
            path.write_bytes(path.stem.encode("utf-8"))
            _write_waveform_stub(path.with_suffix(path.suffix + ".waveform.json"))
            transcript = path.with_suffix(path.suffix + ".transcript.json")
            transcript.write_text(json.dumps({"text": path.stem}), encoding="utf-8")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/recordings/bulk-download",
                json={
                    "items": [
                        f"{day_dir.name}/{first.name}",
                        f"{day_dir.name}/{second.name}",
                    ]
                },
            )
            assert resp.status == 200
            assert resp.headers.get("Content-Type") == "application/zip"
            archive_bytes = await resp.read()
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                names = sorted(archive.namelist())
                assert names == sorted(
                    [
                        f"{day_dir.name}/{first.name}",
                        f"{day_dir.name}/{first.name}.waveform.json",
                        f"{day_dir.name}/{first.name}.transcript.json",
                        f"{day_dir.name}/{second.name}",
                        f"{day_dir.name}/{second.name}.waveform.json",
                        f"{day_dir.name}/{second.name}.transcript.json",
                    ]
                )

            error_resp = await client.post(
                "/api/recordings/bulk-download",
                json={"items": ["missing.opus"]},
            )
            assert error_resp.status == 400
            error_payload = await error_resp.json()
            assert isinstance(error_payload.get("errors"), list)
            assert error_payload["errors"]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_sd_card_recovery_static_doc_served(dashboard_env):
    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/static/docs/sd-card-recovery.html")
            assert resp.status == 200
            payload = await resp.text()
            assert "Clone and Replace the Recorder SD Card" in payload
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())
