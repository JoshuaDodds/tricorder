import asyncio
import os

import json
import subprocess
import textwrap
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


def _write_waveform_stub(
    target: Path,
    duration: float = 1.0,
    *,
    start_epoch: float | None = None,
    extra: dict | None = None,
) -> None:
    payload = {
        "version": 1,
        "channels": 1,
        "sample_rate": 48000,
        "frame_count": int(max(duration, 0) * 48000),
        "duration_seconds": duration,
        "peak_scale": 32767,
        "peaks": [0, 0],
        "rms_values": [0],
    }
    if start_epoch is not None:
        payload["start_epoch"] = float(start_epoch)
        payload["started_epoch"] = float(start_epoch)
        payload["started_at"] = datetime.fromtimestamp(
            float(start_epoch), tz=timezone.utc
        ).isoformat()
    if extra:
        payload.update(extra)
    target.write_text(json.dumps(payload), encoding="utf-8")


def _create_silent_wav(path: Path, duration: float = 2.0) -> None:
    frame_count = max(1, int(48000 * max(duration, 0)))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(b"\x00\x00" * frame_count)


def _run_dashboard_selection_script(
    script: str, *, elements: dict[str, object] | None = None
) -> dict:
    root = Path(__file__).resolve().parents[1]
    node_path = shutil.which("node")
    if node_path is None:
        pytest.skip("Node.js binary is required for dashboard selection script tests")
    indented_script = textwrap.indent(script, "        ")
    overrides = json.dumps(elements or {})
    template = """
        const path = require("path");
        const {{ loadDashboard }} = require(path.join(process.cwd(), "tests", "helpers", "dashboard_node_env.js"));
        const overrides = {overrides};
        if (overrides && Object.keys(overrides).length > 0) {{
          global.__DASHBOARD_ELEMENT_OVERRIDES = overrides;
        }}
        const sandbox = loadDashboard();
        delete global.__DASHBOARD_ELEMENT_OVERRIDES;
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;
        if (!state) {{
          throw new Error("Dashboard state is unavailable for tests");
        }}
        state.records = [];
        state.partialRecord = null;
        state.recordsFingerprint = "";
        state.selectionAnchor = "";
        state.selectionFocus = "";
        state.selections = new Set();
        state.sort = {{ key: "name", direction: "asc" }};
        state.total = 0;
        state.filteredSize = 0;
        const result = (() => {{
{script}
        }})();
        console.log(JSON.stringify(result));
    """
    node_code = textwrap.dedent(template).format(
        script=indented_script, overrides=overrides
    )
    completed = subprocess.run(
        [node_path, "-e", node_code],
        capture_output=True,
        text=True,
        check=True,
        cwd=root,
    )
    output = completed.stdout.strip()
    return json.loads(output or "null")


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


def test_recordings_include_motion_offsets(dashboard_env, monkeypatch):
    async def runner():
        day_dir = dashboard_env / "20240201"
        day_dir.mkdir()
        file_path = day_dir / "motion_example.opus"
        file_path.write_bytes(b"m")

        metadata = {
            "motion_trigger_offset_seconds": 0.5,
            "motion_release_offset_seconds": 1.25,
            "motion_started_epoch": 1_700_000_100.0,
            "motion_released_epoch": 1_700_000_101.5,
        }
        _write_waveform_stub(
            file_path.with_suffix(file_path.suffix + ".waveform.json"),
            duration=2.5,
            extra=metadata,
        )

        os.utime(file_path, (1_700_000_200, 1_700_000_200))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings?limit=5")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["total"] >= 1
            item = next(entry for entry in payload["items"] if entry["name"] == "motion_example")
            assert item["motion_trigger_offset_seconds"] == pytest.approx(0.5)
            assert item["motion_release_offset_seconds"] == pytest.approx(1.25)
            assert item["motion_started_epoch"] == pytest.approx(1_700_000_100.0)
            assert item["motion_released_epoch"] == pytest.approx(1_700_000_101.5)
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


def test_recordings_capture_status_stale_clears_activity(dashboard_env, monkeypatch):
    async def runner():
        now = 1_700_040_000.0
        monkeypatch.setattr(web_streamer.time, "time", lambda: now)
        status_path = Path(os.environ["TMP_DIR"]) / "segmenter_status.json"
        stale_age = web_streamer.CAPTURE_STATUS_STALE_AFTER_SECONDS + 5.0
        status_payload = {
            "capturing": True,
            "service_running": True,
            "updated_at": now - stale_age,
            "event": {"base_name": "alpha"},
            "encoding": {
                "pending": [{"base_name": "queued", "source": "ingest"}],
                "active": [
                    {
                        "base_name": "active",
                        "source": "live",
                        "duration_seconds": 12.0,
                    }
                ],
            },
        }
        status_path.write_text(json.dumps(status_payload), encoding="utf-8")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings")
            assert resp.status == 200
            payload = await resp.json()
            capture_status = payload.get("capture_status", {})
            assert capture_status.get("capturing") is False
            assert capture_status.get("service_running") is False
            assert capture_status.get("event") is None
            assert "encoding" not in capture_status
            assert "recording_progress" not in capture_status
            assert capture_status.get("last_stop_reason") == "status stale"
            assert capture_status.get("manual_recording") is False
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_capture_status_offline_defaults_reason(dashboard_env, monkeypatch):
    async def runner():
        now = 1_700_050_000.0
        monkeypatch.setattr(web_streamer.time, "time", lambda: now)
        status_path = Path(os.environ["TMP_DIR"]) / "segmenter_status.json"

        offline_payload = {
            "capturing": True,
            "service_running": False,
            "updated_at": now,
            "event": {"base_name": "beta"},
            "encoding": {"pending": [{"base_name": "queued"}]},
        }
        status_path.write_text(json.dumps(offline_payload), encoding="utf-8")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings")
            assert resp.status == 200
            payload = await resp.json()
            first_status = payload.get("capture_status", {})
            assert first_status.get("capturing") is False
            assert first_status.get("service_running") is False
            assert first_status.get("event") is None
            assert "encoding" not in first_status
            assert "recording_progress" not in first_status
            assert first_status.get("last_stop_reason") == "service offline"
            assert first_status.get("manual_recording") is False

            offline_payload["last_stop_reason"] = "shutdown"
            status_path.write_text(json.dumps(offline_payload), encoding="utf-8")

            resp_again = await client.get("/api/recordings")
            assert resp_again.status == 200
            payload_again = await resp_again.json()
            second_status = payload_again.get("capture_status", {})
            assert second_status.get("capturing") is False
            assert second_status.get("service_running") is False
            assert second_status.get("event") is None
            assert "encoding" not in second_status
            assert "recording_progress" not in second_status
            assert second_status.get("last_stop_reason") == "shutdown"
            assert second_status.get("manual_recording") is False
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_capture_status_partial_rel_path(dashboard_env, monkeypatch):
    async def runner():
        now = 1_700_060_000.0
        monkeypatch.setattr(web_streamer.time, "time", lambda: now)
        status_path = Path(os.environ["TMP_DIR"]) / "segmenter_status.json"

        day_dir = dashboard_env / "20240105"
        day_dir.mkdir()
        partial_path = day_dir / "alpha.partial.opus"
        partial_path.write_bytes(b"header")
        waveform_path = day_dir / "alpha.partial.opus.waveform.json"
        waveform_path.write_text("{}", encoding="utf-8")

        payload = {
            "capturing": True,
            "service_running": True,
            "updated_at": now,
            "event_size_bytes": 5120,
            "event_duration_seconds": 4.0,
            "partial_recording_path": str(partial_path),
            "partial_waveform_path": str(waveform_path),
            "streaming_container_format": "opus",
            "event": {
                "base_name": "alpha",
                "in_progress": True,
                "started_epoch": now - 2,
                "started_at": "12-00-00",
                "partial_recording_path": str(partial_path),
                "partial_waveform_path": str(waveform_path),
                "streaming_container_format": "opus",
            },
        }
        status_path.write_text(json.dumps(payload), encoding="utf-8")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/recordings")
            assert resp.status == 200
            data = await resp.json()
            capture_status = data.get("capture_status", {})
            rel_path = capture_status.get("partial_recording_rel_path")
            assert rel_path == "20240105/alpha.partial.opus"
            waveform_rel = capture_status.get("partial_waveform_rel_path")
            assert waveform_rel == "20240105/alpha.partial.opus.waveform.json"
            event = capture_status.get("event", {})
            assert event.get("partial_recording_rel_path") == rel_path
            assert event.get("partial_recording_path", "").endswith("alpha.partial.opus")
            assert event.get("partial_waveform_rel_path") == waveform_rel
            progress = capture_status.get("recording_progress", {})
            assert progress.get("path") == rel_path
            assert progress.get("size_bytes") == 5120
            assert progress.get("duration_seconds") == pytest.approx(4.0, rel=0, abs=1e-6)
            assert progress.get("extension") == "opus"
            assert progress.get("name") == "alpha"
            assert progress.get("isPartial") is True
            assert progress.get("inProgress") is True
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_streams_partial_until_finalized(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240106"
        day_dir.mkdir()
        partial_path = day_dir / "beta.partial.opus"
        final_path = day_dir / "beta.opus"
        partial_path.write_bytes(b"HEAD")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        async def append_and_finalize():
            await asyncio.sleep(0.05)
            with partial_path.open("ab") as handle:
                handle.write(b"BODY1")
                handle.flush()
            await asyncio.sleep(0.05)
            with partial_path.open("ab") as handle:
                handle.write(b"BODY2")
                handle.flush()
            await asyncio.sleep(0.05)
            os.replace(partial_path, final_path)

        try:
            rel = partial_path.relative_to(dashboard_env).as_posix()
            resp = await client.get(f"/recordings/{rel}")
            append_task = asyncio.create_task(append_and_finalize())
            body = await resp.read()
            await append_task
            assert body == b"HEADBODY1BODY2"
            assert resp.headers.get("Content-Type") == "audio/ogg"
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_returns_partial_waveform_snapshot(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240107"
        day_dir.mkdir()
        waveform_path = day_dir / "gamma.partial.opus.waveform.json"
        payload = {
            "version": 1,
            "channels": 1,
            "sample_rate": 48000,
            "frame_count": 48000,
            "duration_seconds": 1.0,
            "peak_scale": 32767,
            "peaks": [1, -1],
            "rms_values": [1],
        }
        waveform_path.write_text(json.dumps(payload), encoding="utf-8")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            rel = waveform_path.relative_to(dashboard_env).as_posix()
            resp = await client.get(f"/recordings/{rel}")
            assert resp.status == 200
            content_type = resp.headers.get("Content-Type")
            assert content_type is not None
            assert content_type.startswith("application/json")
            assert resp.headers.get("Cache-Control") == "no-store"
            body = await resp.text()
            data = json.loads(body)
            assert data.get("peaks") == payload["peaks"]
            assert data.get("duration_seconds") == pytest.approx(payload["duration_seconds"])
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


def test_web_server_settings_round_trip(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
web_server:
  mode: http
  listen_host: 0.0.0.0
  listen_port: 8080
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
            resp = await client.get("/api/config/web-server")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["web_server"]["mode"] == "http"
            assert payload["web_server"]["listen_port"] == 8080
            assert payload["web_server"]["tls_provider"] == "letsencrypt"
            assert payload["config_path"] == str(config_path)

            update_payload = {
                "mode": "https",
                "listen_host": "0.0.0.0",
                "listen_port": 443,
                "tls_provider": "manual",
                "certificate_path": "/etc/tricorder/cert.pem",
                "private_key_path": "/etc/tricorder/key.pem",
            }

            resp = await client.post("/api/config/web-server", json=update_payload)
            assert resp.status == 200
            updated = await resp.json()
            assert updated["web_server"]["mode"] == "https"
            assert updated["web_server"]["listen_port"] == 443
            assert updated["web_server"]["tls_provider"] == "manual"
            assert updated["web_server"]["lets_encrypt"]["enabled"] is False
            assert updated["config_path"] == str(config_path)

            persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            assert persisted["web_server"]["mode"] == "https"
            assert persisted["web_server"]["listen_port"] == 443
            assert persisted["web_server"]["tls_provider"] == "manual"
            assert (
                persisted["web_server"]["certificate_path"] == "/etc/tricorder/cert.pem"
            )
            assert (
                persisted["web_server"]["private_key_path"] == "/etc/tricorder/key.pem"
            )
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_web_server_settings_validation_requires_domains(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("web_server:\n  mode: http\n", encoding="utf-8")

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
                "mode": "https",
                "tls_provider": "letsencrypt",
                "lets_encrypt": {"domains": []},
            }
            resp = await client.post("/api/config/web-server", json=payload)
            assert resp.status == 400
            error_payload = await resp.json()
            errors = error_payload.get("errors", [])
            assert any("domains" in str(item) for item in errors)
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_web_server_settings_validation_manual_paths(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("web_server:\n  mode: https\n", encoding="utf-8")

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
                "mode": "https",
                "tls_provider": "manual",
                "certificate_path": "",
                "private_key_path": "",
            }
            resp = await client.post("/api/config/web-server", json=payload)
            assert resp.status == 400
            error_payload = await resp.json()
            errors = error_payload.get("errors", [])
            assert any("certificate_path" in str(item) for item in errors)
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
    denoise:
      enabled: false
      type: afftdn
      noise_floor_db: -30.0
    highpass:
      enabled: true
      cutoff_hz: 110.0
    lowpass:
      enabled: false
      cutoff_hz: 9500.0
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
            assert payload["audio"]["filter_chain"]["denoise"]["enabled"] is False
            assert payload["audio"]["filter_chain"]["denoise"]["type"] == "afftdn"
            assert payload["audio"]["filter_chain"]["highpass"]["enabled"] is True
            assert (
                payload["audio"]["filter_chain"]["highpass"]["cutoff_hz"]
                == pytest.approx(110.0)
            )
            assert payload["audio"]["filter_chain"]["lowpass"]["enabled"] is False
            assert (
                payload["audio"]["filter_chain"]["lowpass"]["cutoff_hz"]
                == pytest.approx(9500.0)
            )
            assert payload["audio"]["calibration"]["auto_noise_profile"] is True

            update_payload = {
                "device": "hw:CARD=Device,DEV=0",
                "sample_rate": 48000,
                "frame_ms": 10,
                "gain": 1.5,
                "vad_aggressiveness": 3,
                "filter_chain": {
                    "denoise": {
                        "enabled": True,
                        "type": "afftdn",
                        "noise_floor_db": -25.0,
                    },
                    "highpass": {"enabled": True, "cutoff_hz": 140.0},
                    "lowpass": {"enabled": True, "cutoff_hz": 10800.0},
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
            assert updated["audio"]["filter_chain"]["denoise"]["enabled"] is True
            assert (
                updated["audio"]["filter_chain"]["denoise"]["noise_floor_db"]
                == pytest.approx(-25.0)
            )
            assert updated["audio"]["filter_chain"]["notch"]["enabled"] is False
            assert (
                updated["audio"]["filter_chain"]["notch"]["freq_hz"]
                == pytest.approx(180.0)
            )
            assert updated["audio"]["filter_chain"]["lowpass"]["enabled"] is True
            assert (
                updated["audio"]["filter_chain"]["lowpass"]["cutoff_hz"]
                == pytest.approx(10800.0)
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
            assert persisted["audio"]["filter_chain"]["denoise"]["enabled"] is True
            assert (
                persisted["audio"]["filter_chain"]["denoise"]["noise_floor_db"]
                == pytest.approx(-25.0)
            )
            assert persisted["audio"]["filter_chain"]["highpass"]["enabled"] is True
            assert (
                persisted["audio"]["filter_chain"]["highpass"]["cutoff_hz"]
                == pytest.approx(140.0)
            )
            assert persisted["audio"]["filter_chain"]["lowpass"]["enabled"] is True
            assert (
                persisted["audio"]["filter_chain"]["lowpass"]["cutoff_hz"]
                == pytest.approx(10800.0)
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


def test_system_health_reports_resources(dashboard_env):
    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.get("/api/system-health")
            assert resp.status == 200
            assert resp.headers.get("Cache-Control") == "no-store"
            payload = await resp.json()

            resources = payload.get("resources")
            assert isinstance(resources, dict)

            cpu = resources.get("cpu")
            memory = resources.get("memory")
            temperature = resources.get("temperature")
            assert isinstance(cpu, dict)
            assert isinstance(memory, dict)
            assert isinstance(temperature, dict)

            assert "percent" in cpu
            assert "load_1m" in cpu
            assert "cores" in cpu

            cpu_percent = cpu.get("percent")
            if cpu_percent is not None:
                assert isinstance(cpu_percent, (int, float))
                assert 0 <= cpu_percent <= 100

            load_1m = cpu.get("load_1m")
            if load_1m is not None:
                assert isinstance(load_1m, (int, float))
                assert load_1m >= 0

            cores = cpu.get("cores")
            assert isinstance(cores, (int, float))
            assert cores >= 1

            total_bytes = memory.get("total_bytes")
            assert isinstance(total_bytes, (int, float))
            assert total_bytes > 0

            used_bytes = memory.get("used_bytes")
            if used_bytes is not None:
                assert isinstance(used_bytes, (int, float))
                assert used_bytes >= 0

            available_bytes = memory.get("available_bytes")
            if available_bytes is not None:
                assert isinstance(available_bytes, (int, float))
                assert available_bytes >= 0

            memory_percent = memory.get("percent")
            if memory_percent is not None:
                assert isinstance(memory_percent, (int, float))
                assert 0 <= memory_percent <= 100

            assert "celsius" in temperature
            assert "fahrenheit" in temperature
            temp_c = temperature.get("celsius")
            if temp_c is not None:
                assert isinstance(temp_c, (int, float))
                assert -100 <= temp_c <= 200
            temp_f = temperature.get("fahrenheit")
            if temp_f is not None:
                assert isinstance(temp_f, (int, float))
                assert -148 <= temp_f <= 392
            sensor_name = temperature.get("sensor")
            if sensor_name is not None:
                assert isinstance(sensor_name, str)
                assert sensor_name.strip() == sensor_name
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


def test_audio_settings_preserve_inline_comments(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        (
            "audio:\n"
            "  device: hw:1,0  # usb device mapping\n"
            "  sample_rate: 48000\n"
            "  frame_ms: 20\n"
            "  gain: 2.0  # front-end gain guidance\n"
            "  vad_aggressiveness: 2\n"
            "  filter_chain:\n"
            "    highpass:\n"
            "      enabled: false  # high-pass toggle\n"
            "      cutoff_hz: 90.0  # high-pass cutoff\n"
            "    spectral_gate:\n"
            "      enabled: false  # spectral gate toggle\n"
            "      sensitivity: 1.5\n"
            "      reduction_db: -18.0  # gate reduction depth\n"
            "      noise_update: 0.10  # gate update speed\n"
            "      noise_decay: 0.95  # gate release smoothing\n"
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
            update_payload = {
                "device": "hw:CARD=Device,DEV=0",
                "sample_rate": 48000,
                "frame_ms": 20,
                "gain": 3.0,
                "vad_aggressiveness": 3,
                "filter_chain": {
                    "highpass": {"enabled": True, "cutoff_hz": 110.0},
                    "spectral_gate": {
                        "enabled": True,
                        "sensitivity": 1.4,
                        "reduction_db": -20.0,
                        "noise_update": 0.15,
                        "noise_decay": 0.92,
                    },
                },
            }

            resp = await client.post("/api/config/audio", json=update_payload)
            assert resp.status == 200

            persisted_text = config_path.read_text(encoding="utf-8")
            assert "# front-end gain guidance" in persisted_text
            assert "# high-pass toggle" in persisted_text
            assert "# high-pass cutoff" in persisted_text
            assert "# gate reduction depth" in persisted_text
            assert "# gate update speed" in persisted_text
            assert "# gate release smoothing" in persisted_text

            lines = persisted_text.splitlines()
            gain_line = next(line for line in lines if "gain:" in line and "front-end" in line)
            assert "3.0" in gain_line or "3" in gain_line
            cutoff_line = next(line for line in lines if "cutoff_hz" in line and "high-pass cutoff" in line)
            assert "110" in cutoff_line
            reduction_line = next(line for line in lines if "reduction_db" in line and "gate reduction depth" in line)
            assert "-20" in reduction_line

            assert systemctl_calls == [
                ["is-active", "voice-recorder.service"],
                ["restart", "voice-recorder.service"],
            ]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_audio_settings_rehydrate_comments_when_missing(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        (
            "audio:\n"
            "  device: hw:1,0\n"
            "  gain: 1.8\n"
            "  vad_aggressiveness: 1\n"
            "  filter_chain:\n"
            "    highpass:\n"
            "      enabled: false\n"
            "      cutoff_hz: 80.0\n"
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("TRICORDER_CONFIG", str(config_path))
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    monkeypatch.setattr(config, "_primary_config_path", None, raising=False)
    monkeypatch.setattr(config, "_active_config_path", None, raising=False)
    monkeypatch.setattr(config, "_search_paths", [], raising=False)
    monkeypatch.setattr(config, "_template_cache", None, raising=False)

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
            update_payload = {
                "device": "hw:CARD=Device,DEV=0",
                "sample_rate": 48000,
                "frame_ms": 20,
                "gain": 2.6,
                "vad_aggressiveness": 2,
                "filter_chain": {
                    "highpass": {"enabled": True, "cutoff_hz": 115.0},
                },
            }

            resp = await client.post("/api/config/audio", json=update_payload)
            assert resp.status == 200

            persisted_text = config_path.read_text(encoding="utf-8")
            assert "# ALSA device identifier" in persisted_text
            assert "# Unified live/recording filter chain" in persisted_text
            assert "gain:" in persisted_text

            persisted = yaml.safe_load(persisted_text)
            assert persisted["audio"]["gain"] == pytest.approx(2.6)
            assert persisted["audio"]["device"] == "hw:CARD=Device,DEV=0"
            assert persisted["audio"]["filter_chain"]["highpass"]["enabled"] is True
            assert persisted["audio"]["filter_chain"]["highpass"]["cutoff_hz"] == pytest.approx(115.0)

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


def test_transcription_model_discovery(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    models_dir = tmp_path / "models"
    models_dir.mkdir()

    en_model = models_dir / "vosk-small-en"
    (en_model / "conf").mkdir(parents=True)
    (en_model / "conf" / "model.conf").write_text(
        "model_name = English Small\nlang = en-US\n",
        encoding="utf-8",
    )
    (en_model / "meta.json").write_text(
        json.dumps({"title": "English Small", "lang": "en"}),
        encoding="utf-8",
    )

    es_model = models_dir / "vosk-small-es"
    (es_model / "conf").mkdir(parents=True)
    (es_model / "conf" / "model.conf").write_text(
        "model_name = Español\nlang = es\n",
        encoding="utf-8",
    )

    legacy_model = models_dir / "vosk-model-small-tr-0.3"
    (legacy_model / "ivector").mkdir(parents=True)
    (legacy_model / "final.mdl").write_bytes(b"")
    (legacy_model / "Gr.fst").write_bytes(b"")

    stray_dir = models_dir / "notes"
    stray_dir.mkdir()

    config_path.write_text(
        f"transcription:\n  vosk_model_path: {en_model}\n",
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
            resp = await client.get("/api/transcription/models")
            assert resp.status == 200
            payload = await resp.json()
            assert isinstance(payload, dict)
            models = payload.get("models")
            assert isinstance(models, list)
            paths = {entry.get("path") for entry in models if isinstance(entry, dict)}
            assert str(en_model) in paths
            assert str(es_model) in paths
            assert str(legacy_model) in paths
            assert str(stray_dir) not in paths
            searched = payload.get("searched")
            assert isinstance(searched, list)
            assert str(models_dir) in searched
            assert payload.get("configured_path") == str(en_model)
            assert payload.get("configured_exists") is True
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
            assert match["started_epoch"] == pytest.approx(expected, rel=0, abs=1e-6)
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
        start_epoch = datetime(2024, 1, 3, 5, 6, 7, tzinfo=timezone.utc).timestamp()
        os.utime(target, (start_epoch, start_epoch))
        waveform = target.with_suffix(target.suffix + ".waveform.json")
        _write_waveform_stub(waveform, start_epoch=start_epoch)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/recordings/delete", json={"items": ["20240103/delete-me.opus"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == ["20240103/delete-me.opus"]
            assert not target.exists()
            assert not waveform.exists()

            recycle_root = dashboard_env / ".recycle_bin"
            assert recycle_root.is_dir()
            entries = list(recycle_root.iterdir())
            assert len(entries) == 1

            # Create a conflicting file to ensure restorable flag flips
            target_dir.mkdir(exist_ok=True)
            target.write_bytes(b"shadow")

            resp = await client.get("/api/recycle-bin")
            assert resp.status == 200
            listing = await resp.json()
            assert listing["total"] == 1
            item = listing["items"][0]
            assert item["original_path"] == "20240103/delete-me.opus"
            assert item["restorable"] is False

            target.unlink()

            resp = await client.get("/api/recycle-bin")
            assert resp.status == 200
            listing = await resp.json()
            assert listing["total"] == 1
            item = listing["items"][0]
            entry_id = item["id"]
            assert item["restorable"] is True
            assert item["size_bytes"] == len(b"data")
            assert item["start_epoch"] == pytest.approx(start_epoch)
            assert item["started_epoch"] == pytest.approx(start_epoch)
            assert item["started_at"].startswith("2024-01-03T05:06:07")
            assert item["start_epoch"] != item["deleted_at_epoch"]

            resp = await client.get(f"/recycle-bin/{entry_id}")
            assert resp.status == 200
            preview_data = await resp.read()
            assert preview_data == b"data"

            resp = await client.post("/api/recycle-bin/restore", json={"items": [entry_id]})
            assert resp.status == 200
            restore_payload = await resp.json()
            assert restore_payload["restored"] == ["20240103/delete-me.opus"]
            assert target.exists()
            assert target.read_bytes() == b"data"

            resp = await client.get("/api/recycle-bin")
            assert resp.status == 200
            assert await resp.json() == {"items": [], "total": 0}

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
                "Tue 2024-05-14 12:34:56 UTC",
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
                "Tue 2024-05-14 11:22:33 UTC",
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
            expected_epoch = datetime(2024, 5, 14, 12, 34, 56, tzinfo=timezone.utc).timestamp()
            assert recorder.get("active_enter_epoch") == pytest.approx(expected_epoch)
            assert recorder.get("active_enter_timestamp", "").startswith("2024-05-14T12:34:56")
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_services_endpoint_parses_dst_timezone_epoch(monkeypatch, dashboard_env):
    async def runner():
        show_map = {
            "voice-recorder.service": (
                "loaded",
                "active",
                "running",
                "enabled",
                "Voice Recorder",
                "yes",
                "yes",
                "yes",
                "no",
                "",
                "Wed 2025-10-08 16:33:00 CEST",
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
                        "no",
                        "no",
                        "no",
                        "no",
                        "",
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
            expected_epoch = datetime(2025, 10, 8, 14, 33, tzinfo=timezone.utc).timestamp()
            assert recorder.get("active_enter_epoch") == pytest.approx(expected_epoch)
            assert recorder.get("active_enter_timestamp", "").startswith("2025-10-08T14:33:00")
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
                "Tue 2024-05-14 11:22:33 UTC",
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
                "Tue 2024-05-14 12:34:56 UTC",
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
                "Tue 2024-05-14 11:22:33 UTC",
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


def test_capture_split_endpoint(monkeypatch, dashboard_env):
    async def runner():
        calls: list[list[str]] = []

        async def fake_systemctl(args):
            calls.append(list(args))
            return 0, "", ""

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/capture/split")
            assert resp.status == 200
            payload = await resp.json()
            assert payload.get("ok") is True
            assert ["kill", "--signal=USR1", "voice-recorder.service"] in calls
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_capture_split_failure(monkeypatch, dashboard_env):
    async def runner():
        async def fake_systemctl(_args):
            return 1, "", "boom"

        monkeypatch.setattr(web_streamer, "_run_systemctl", fake_systemctl)

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/capture/split")
            assert resp.status == 502
            payload = await resp.json()
            assert payload.get("ok") is False
            assert payload.get("error") == "boom"
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_capture_manual_record_endpoint(dashboard_env):
    async def runner():
        manual_state_path = Path(os.environ["TMP_DIR"]) / "manual_record_state.json"
        if manual_state_path.exists():
            manual_state_path.unlink()

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/capture/manual-record", json={"enabled": True})
            assert resp.status == 200
            payload = await resp.json()
            assert payload.get("ok") is True
            assert payload.get("enabled") is True
            data = json.loads(manual_state_path.read_text(encoding="utf-8"))
            assert data.get("enabled") is True

            resp = await client.post("/api/capture/manual-record", json={"enabled": False})
            assert resp.status == 200
            payload = await resp.json()
            assert payload.get("enabled") is False
            data = json.loads(manual_state_path.read_text(encoding="utf-8"))
            assert data.get("enabled") is False
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_capture_manual_record_invalid_payload(dashboard_env):
    async def runner():
        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/capture/manual-record", json={"enabled": "maybe"})
            assert resp.status == 400
            payload = await resp.json()
            assert payload.get("ok") is False
            resp_invalid = await client.post(
                "/api/capture/manual-record", data=b"not-json", headers={"Content-Type": "application/json"}
            )
            assert resp_invalid.status == 400
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


def test_recording_indicator_motion_badge_tracks_live_flag():
    script = textwrap.dedent(
        """
        const indicator = sandbox.window.document.__getMockElement("recording-indicator");
        const motionBadge = sandbox.window.document.__getMockElement("recording-indicator-motion");
        motionBadge.hidden = true;
        sandbox.setRecordingIndicatorStatus({
          capturing: true,
          motion_active: true,
          event: { motion_trigger_offset_seconds: 0.25 }
        });
        const shownDuringMotion = motionBadge.hidden === false;
        sandbox.setRecordingIndicatorStatus({
          capturing: true,
          motion_active: false,
          event: {
            motion_trigger_offset_seconds: 0.25,
            motion_release_offset_seconds: 0.75
          }
        });
        const hiddenAfterRelease = motionBadge.hidden === true;
        sandbox.setRecordingIndicatorStatus({
          capturing: true,
          motion_active: true,
          event: {
            motion_trigger_offset_seconds: 0.25,
            motion_release_offset_seconds: 0.75
          }
        });
        const shownAfterReturn = motionBadge.hidden === false;
        return {
          shownDuringMotion,
          hiddenAfterRelease,
          shownAfterReturn,
          state: indicator.dataset.state,
        };
        """
    )
    result = _run_dashboard_selection_script(
        script,
        elements={
            "recording-indicator": True,
            "recording-indicator-text": True,
            "recording-indicator-motion": True,
        },
    )
    assert result["shownDuringMotion"] is True
    assert result["hiddenAfterRelease"] is True
    assert result["shownAfterReturn"] is True
    assert result["state"] == "active"


def test_recording_indicator_motion_uses_snapshot_flag_immediately():
    script = textwrap.dedent(
        """
        const indicator = sandbox.window.document.__getMockElement("recording-indicator");
        const motionBadge = sandbox.window.document.__getMockElement("recording-indicator-motion");
        motionBadge.hidden = true;
        sandbox.setRecordingIndicatorStatus(
          {
            capturing: true,
            event: {
              motion_trigger_offset_seconds: 0.5,
              motion_release_offset_seconds: 2.0,
            }
          },
          { motion_active: true }
        );
        const shownWithSnapshot = motionBadge.hidden === false;
        sandbox.setRecordingIndicatorStatus(
          {
            capturing: true,
            event: {
              motion_trigger_offset_seconds: 0.5,
              motion_release_offset_seconds: 2.0,
            }
          },
          { motion_active: false }
        );
        const hiddenAfterSnapshot = motionBadge.hidden === true;
        return {
          shownWithSnapshot,
          hiddenAfterSnapshot,
          state: indicator.dataset.state,
        };
        """
    )
    result = _run_dashboard_selection_script(
        script,
        elements={
            "recording-indicator": True,
            "recording-indicator-text": True,
            "recording-indicator-motion": True,
        },
    )
    assert result["shownWithSnapshot"] is True
    assert result["hiddenAfterSnapshot"] is True
    assert result["state"] == "active"


def test_indicator_uses_cached_motion_when_snapshot_missing():
    script = textwrap.dedent(
        """
        const indicator = sandbox.window.document.__getMockElement("recording-indicator");
        const motionBadge = sandbox.window.document.__getMockElement("recording-indicator-motion");
        motionBadge.hidden = true;
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;
        const cachedState = { motion_active: false, sequence: 7 };
        state.motionState = cachedState;
        sandbox.setRecordingIndicatorStatus(
          { capturing: true, motion_state: cachedState },
          cachedState
        );
        const hiddenWithSnapshot = motionBadge.hidden === true;
        const preservedState = sandbox.resolveNextMotionState(null, state.motionState, true);
        state.motionState = preservedState;
        sandbox.setRecordingIndicatorStatus(
          { capturing: true, event: { motion_trigger_offset_seconds: 0.25 } },
          state.motionState
        );
        const hiddenAfterFallback = motionBadge.hidden === true;
        const storedMotion = state.motionState && state.motionState.motion_active;
        return {
          hiddenWithSnapshot,
          hiddenAfterFallback,
          storedMotion,
          indicatorState: indicator.dataset.state,
        };
        """
    )
    result = _run_dashboard_selection_script(
        script,
        elements={
            "recording-indicator": True,
            "recording-indicator-text": True,
            "recording-indicator-motion": True,
        },
    )
    assert result["hiddenWithSnapshot"] is True
    assert result["hiddenAfterFallback"] is True
    assert result["storedMotion"] is False
    assert result["indicatorState"] == "active"


def test_capture_status_merges_motion_padding_updates_without_sequence_bump():
    script = textwrap.dedent(
        """
        sandbox.__setEventStreamConnectedForTests(true);
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;
        sandbox.requestRecordingsRefresh = () => {};
        sandbox.renderRecords = () => {};
        sandbox.updateSelectionUI = () => {};
        sandbox.applyNowPlayingHighlight = () => {};
        sandbox.syncPlayerPlacement = () => {};
        sandbox.setRecordingIndicatorStatus = () => {};
        sandbox.updateRmsIndicator = () => {};
        sandbox.updateRecordingMeta = () => {};
        sandbox.updateEncodingStatus = () => {};
        sandbox.updateSplitEventButton = () => {};
        sandbox.updateManualRecordButton = () => {};
        state.motionState = {
          sequence: 27,
          motion_active: true,
          motion_padding_seconds_remaining: 14,
          motion_padding_deadline_epoch: 1_690_000_000,
        };
        const previous = state.motionState;
        sandbox.applyCaptureStatusPush({
          capturing: true,
          motion_active: true,
          motion_sequence: 27,
          motion_padding_seconds_remaining: 9,
          motion_padding_deadline_epoch: 1_690_000_030,
        });
        const updated = state.motionState;
        const response = {
          reusedReference: updated === previous,
          paddingRemaining: updated.motion_padding_seconds_remaining,
          paddingDeadline: updated.motion_padding_deadline_epoch,
        };
        sandbox.__setEventStreamConnectedForTests(false);
        return response;
        """
    )
    result = _run_dashboard_selection_script(
        script,
        elements={
            "recording-indicator": True,
            "recording-indicator-text": True,
            "recording-indicator-motion": True,
        },
    )
    assert result["reusedReference"] is False
    assert result["paddingRemaining"] == 9
    assert result["paddingDeadline"] == 1_690_000_030


def test_resolve_next_motion_state_sequence_handling():
    script = textwrap.dedent(
        """
        const live = { motion_active: true, sequence: 5 };
        const stale = { motion_active: false, sequence: 4 };
        const fresher = { motion_active: false, sequence: 6 };
        const keepConnected = sandbox.resolveNextMotionState(stale, live, true);
        const adoptConnected = sandbox.resolveNextMotionState(fresher, live, true);
        const adoptDisconnected = sandbox.resolveNextMotionState(stale, live, false);
        const keepMissing = sandbox.resolveNextMotionState(null, live, true);
        const clearDisconnected = sandbox.resolveNextMotionState(null, live, false);
        return {
          keepConnectedMotion: keepConnected.motion_active,
          keepConnectedSameReference: keepConnected === live,
          adoptConnectedMotion: adoptConnected.motion_active,
          adoptConnectedSequence: adoptConnected.sequence,
          adoptDisconnectedMotion: adoptDisconnected.motion_active,
          clearDisconnected: clearDisconnected === null,
          keepMissingReference: keepMissing === live,
        };
        """
    )
    result = _run_dashboard_selection_script(script)
    assert result["keepConnectedMotion"] is True
    assert result["keepConnectedSameReference"] is True
    assert result["adoptConnectedMotion"] is False
    assert result["adoptConnectedSequence"] == 6
    assert result["adoptDisconnectedMotion"] is False
    assert result["clearDisconnected"] is True
    assert result["keepMissingReference"] is True


def test_motion_indicator_ignores_stale_recordings_snapshot():
    script = textwrap.dedent(
        """
        const indicator = sandbox.window.document.__getMockElement("recording-indicator");
        const motionBadge = sandbox.window.document.__getMockElement("recording-indicator-motion");
        motionBadge.hidden = true;
        const liveState = { motion_active: true, sequence: 5 };
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;
        state.motionState = liveState;
        sandbox.setRecordingIndicatorStatus({ capturing: true, motion_active: true }, liveState);
        const nextState = sandbox.resolveNextMotionState(
          { motion_active: false, sequence: 4 },
          state.motionState,
          true
        );
        state.motionState = nextState;
        sandbox.setRecordingIndicatorStatus(
          { capturing: true, motion_active: false },
          state.motionState
        );
        return {
          motionBadgeHidden: motionBadge.hidden,
          indicatorState: indicator.dataset.state,
          liveMotion: state.motionState.motion_active,
        };
        """
    )
    result = _run_dashboard_selection_script(
        script,
        elements={
            "recording-indicator": True,
            "recording-indicator-text": True,
            "recording-indicator-motion": True,
        },
    )
    assert result["motionBadgeHidden"] is False
    assert result["indicatorState"] == "active"
    assert result["liveMotion"] is True


def test_motion_trigger_detection_persists_for_recordings():
    script = textwrap.dedent(
        """
        const releaseOnly = sandbox.isMotionTriggeredEvent({
          motion_release_offset_seconds: 1.25,
          motion_active: false
        });
        const startedEpoch = sandbox.isMotionTriggeredEvent({
          motion_started_epoch: 1700000000,
          motion_active: false
        });
        const none = sandbox.isMotionTriggeredEvent({ motion_active: false });
        return { releaseOnly, startedEpoch, none };
        """
    )
    result = _run_dashboard_selection_script(script)
    assert result["releaseOnly"] is True
    assert result["startedEpoch"] is True
    assert result["none"] is False


def test_shift_click_selects_range_between_non_adjacent_records():
    script = textwrap.dedent(
        """
        const records = [
          { path: "20240101/alpha.opus", name: "Alpha", day: "20240101", modified: 1, duration_seconds: 10, size_bytes: 100 },
          { path: "20240101/bravo.opus", name: "Bravo", day: "20240101", modified: 2, duration_seconds: 11, size_bytes: 110 },
          { path: "20240101/charlie.opus", name: "Charlie", day: "20240101", modified: 3, duration_seconds: 12, size_bytes: 120 },
          { path: "20240101/delta.opus", name: "Delta", day: "20240101", modified: 4, duration_seconds: 13, size_bytes: 130 },
          { path: "20240101/echo.opus", name: "Echo", day: "20240101", modified: 5, duration_seconds: 14, size_bytes: 140 },
        ];
        state.records = records;
        state.total = records.length;
        state.filteredSize = records.length;
        const target = "20240101/charlie.opus";
        state.selections = new Set(["20240101/alpha.opus", "20240101/echo.opus"]);
        state.selectionAnchor = "";
        state.selectionFocus = "";
        const anchor = sandbox.resolveSelectionAnchor(target);
        const changed = sandbox.applySelectionRange(anchor, target, true);
        return {
          anchor,
          changed,
          selections: Array.from(state.selections.values()).sort(),
        };
        """
    )
    result = _run_dashboard_selection_script(script)
    assert result["anchor"] == "20240101/alpha.opus"
    assert result["changed"] is True
    assert "20240101/bravo.opus" in result["selections"]
    assert "20240101/charlie.opus" in result["selections"]
    assert "20240101/delta.opus" not in result["selections"]
    assert "20240101/echo.opus" in result["selections"]


def test_shift_click_uses_existing_anchor_when_available():
    script = textwrap.dedent(
        """
        const records = [
          { path: "20240101/alpha.opus", name: "Alpha", day: "20240101", modified: 1, duration_seconds: 10, size_bytes: 100 },
          { path: "20240101/bravo.opus", name: "Bravo", day: "20240101", modified: 2, duration_seconds: 11, size_bytes: 110 },
          { path: "20240101/charlie.opus", name: "Charlie", day: "20240101", modified: 3, duration_seconds: 12, size_bytes: 120 },
          { path: "20240101/delta.opus", name: "Delta", day: "20240101", modified: 4, duration_seconds: 13, size_bytes: 130 },
          { path: "20240101/echo.opus", name: "Echo", day: "20240101", modified: 5, duration_seconds: 14, size_bytes: 140 },
        ];
        state.records = records;
        state.total = records.length;
        state.filteredSize = records.length;
        const target = "20240101/echo.opus";
        state.selections = new Set(["20240101/bravo.opus"]);
        state.selectionAnchor = "20240101/bravo.opus";
        state.selectionFocus = "20240101/bravo.opus";
        const anchor = sandbox.resolveSelectionAnchor(target);
        const changed = sandbox.applySelectionRange(anchor, target, true);
        return {
          anchor,
          changed,
          selections: Array.from(state.selections.values()).sort(),
        };
        """
    )
    result = _run_dashboard_selection_script(script)
    assert result["anchor"] == "20240101/bravo.opus"
    assert result["changed"] is True
    assert result["selections"].count("20240101/bravo.opus") == 1
    assert "20240101/charlie.opus" in result["selections"]
    assert "20240101/delta.opus" in result["selections"]
    assert "20240101/echo.opus" in result["selections"]
    assert "20240101/alpha.opus" not in result["selections"]


def test_playback_source_defaults_to_processed_when_raw_available():
    script = textwrap.dedent(
        """
        const group = sandbox.window.document.__getMockElement("playback-source-group");
        sandbox.window.document.__getMockElement("playback-source-processed");
        const raw = sandbox.window.document.__getMockElement("playback-source-raw");
        const active = sandbox.window.document.__getMockElement("playback-source-active");
        const hint = sandbox.window.document.__getMockElement("playback-source-hint");
        const player = sandbox.window.document.__getMockElement("preview-player");
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;

        player.currentTime = 0;
        player.paused = true;
        player.ended = false;
        player._listeners = {};
        player.addEventListener = (event, handler) => {
          player._listeners[event] = handler;
        };
        player.removeEventListener = (event) => {
          delete player._listeners[event];
        };
        player.play = () => {
          player.paused = false;
          return Promise.resolve();
        };
        player.pause = () => {
          player.paused = true;
        };
        player.load = () => {};

        state.current = {
          path: "20240101/foo.opus",
          raw_audio_path: "raw/20240101/foo.wav",
        };
        sandbox.updatePlaybackSourceForRecord(state.current, { preserveMode: false });

        return {
          state: sandbox.getPlaybackSourceState(),
          groupHidden: group.hidden === true,
          groupSource: group.dataset.source,
          rawDisabled: raw.disabled === true,
          hintHidden: hint.hidden === true,
          activeLabel: active.textContent,
          rawAvailableFlag: group.dataset.rawAvailable,
        };
        """
    )

    result = _run_dashboard_selection_script(
        script,
        elements={
            "preview-player": True,
            "player-meta": True,
            "player-meta-text": True,
            "player-meta-actions": True,
            "player-download": True,
            "player-rename": True,
            "player-delete": True,
            "player-transport": True,
            "playback-source-group": True,
            "playback-source-processed": True,
            "playback-source-raw": True,
            "playback-source-active": True,
            "playback-source-hint": True,
        },
    )

    assert result["state"]["mode"] == "processed"
    assert result["state"]["hasRaw"] is True
    assert result["groupHidden"] is False
    assert result["groupSource"] == "processed"
    assert result["rawAvailableFlag"] == "true"
    assert result["rawDisabled"] is False
    assert result["hintHidden"] is True
    assert result["activeLabel"] == "Processed (Opus)"


def test_playback_source_reverts_when_raw_unavailable():
    script = textwrap.dedent(
        """
        const group = sandbox.window.document.__getMockElement("playback-source-group");
        const raw = sandbox.window.document.__getMockElement("playback-source-raw");
        const hint = sandbox.window.document.__getMockElement("playback-source-hint");
        const player = sandbox.window.document.__getMockElement("preview-player");
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;

        player.currentTime = 1.25;
        player.paused = false;
        player.ended = false;
        player._listeners = {};
        player.addEventListener = (event, handler) => {
          player._listeners[event] = handler;
        };
        player.removeEventListener = (event) => {
          delete player._listeners[event];
        };
        player.play = () => {
          player.paused = false;
          return Promise.resolve();
        };
        player.pause = () => {
          player.paused = true;
        };
        player.load = () => {};

        state.current = {
          path: "20240101/bar.opus",
          raw_audio_path: "raw/20240101/bar.wav",
        };
        sandbox.updatePlaybackSourceForRecord(state.current, { preserveMode: false });
        sandbox.setPlaybackSource("raw", { userInitiated: true });
        if (player._listeners.loadedmetadata) {
          player._listeners.loadedmetadata();
        }

        const afterRaw = sandbox.getPlaybackSourceState();

        state.current = {
          path: "20240101/bar.opus",
          raw_audio_path: "",
        };
        const updateInfo = sandbox.updatePlaybackSourceForRecord(state.current, { preserveMode: true });

        return {
          afterRaw,
          afterRemoval: {
            state: sandbox.getPlaybackSourceState(),
            rawDisabled: raw.disabled === true,
            hintHidden: hint.hidden === true,
            groupSource: group.dataset.source,
            rawAvailableFlag: group.dataset.rawAvailable,
          },
          updateInfo,
        };
        """
    )

    result = _run_dashboard_selection_script(
        script,
        elements={
            "preview-player": True,
            "player-meta": True,
            "player-meta-text": True,
            "player-meta-actions": True,
            "player-download": True,
            "player-rename": True,
            "player-delete": True,
            "player-transport": True,
            "playback-source-group": True,
            "playback-source-processed": True,
            "playback-source-raw": True,
            "playback-source-active": True,
            "playback-source-hint": True,
        },
    )

    assert result["afterRaw"]["mode"] == "raw"
    assert result["afterRemoval"]["state"]["mode"] == "processed"
    assert result["afterRemoval"]["state"]["hasRaw"] is False
    assert result["afterRemoval"]["rawDisabled"] is True
    assert result["afterRemoval"]["hintHidden"] is False
    assert result["afterRemoval"]["groupSource"] == "processed"
    assert result["afterRemoval"]["rawAvailableFlag"] == "false"
    assert result["updateInfo"]["previousMode"] == "raw"
    assert result["updateInfo"]["nextMode"] == "processed"


def test_playback_source_poll_preserves_pending_seek():
    script = textwrap.dedent(
        """
        const player = sandbox.window.document.__getMockElement("preview-player");
        const state = sandbox.window.TRICORDER_DASHBOARD_STATE;

        player.currentTime = 1.25;
        player.paused = false;
        player.ended = false;
        player._listeners = {};
        player.addEventListener = (event, handler) => {
          player._listeners[event] = handler;
        };
        player.removeEventListener = (event) => {
          delete player._listeners[event];
        };
        player.play = () => {
          player.paused = false;
          return Promise.resolve();
        };
        player.pause = () => {
          player.paused = true;
        };
        player.load = () => {};

        state.current = {
          path: "20240101/foo.opus",
          raw_audio_path: "raw/20240101/foo.wav",
        };
        sandbox.updatePlaybackSourceForRecord(state.current, { preserveMode: false });
        sandbox.setPlaybackSource("raw", { userInitiated: true });

        sandbox.updatePlaybackSourceForRecord(state.current, { preserveMode: true });

        if (player._listeners.loadedmetadata) {
          player.currentTime = 0;
          player.paused = true;
          player._listeners.loadedmetadata();
        }

        return {
          currentTime: player.currentTime,
          paused: player.paused,
        };
        """
    )

    result = _run_dashboard_selection_script(
        script,
        elements={
            "preview-player": True,
            "player-meta": True,
            "player-meta-text": True,
            "player-meta-actions": True,
            "player-download": True,
            "player-rename": True,
            "player-delete": True,
            "player-transport": True,
            "playback-source-group": True,
            "playback-source-processed": True,
            "playback-source-raw": True,
            "playback-source-active": True,
            "playback-source-hint": True,
        },
    )

    assert result["currentTime"] == pytest.approx(1.25, rel=1e-6)
    assert result["paused"] is False


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
