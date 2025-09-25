import asyncio
import io
import json
import os
import time
import zipfile
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from lib import web_streamer
import lib.config as config


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
    yield recordings_dir
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)


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


def test_recordings_listing_filters(dashboard_env):
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

            resp = await client.get("/api/recordings?day=20240101&limit=10")
            data = await resp.json()
            assert all(item["day"] == "20240101" for item in data["items"])

            resp = await client.get("/api/recordings?search=beta")
            search = await resp.json()
            assert [item["name"] for item in search["items"]] == ["beta"]
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
        metadata_path = dashboard_env / ".recordings_metadata.json"
        metadata_path.write_text(
            json.dumps({"20240103/delete-me.opus": {"tags": ["keep"]}}),
            encoding="utf-8",
        )

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/recordings/delete", json={"items": ["20240103/delete-me.opus"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == ["20240103/delete-me.opus"]
            assert not target.exists()
            assert not waveform.exists()
            assert not metadata_path.exists()

            resp = await client.post("/api/recordings/delete", json={"items": ["../outside"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == []
            assert payload["errors"]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_archive_downloads_selected(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240104"
        day_dir.mkdir()

        for name in ("alpha.opus", "beta.opus"):
            path = day_dir / name
            path.write_bytes(b"data")
            _write_waveform_stub(path.with_suffix(path.suffix + ".waveform.json"))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/recordings/archive",
                json={
                    "items": ["20240104/alpha.opus", "20240104/beta.opus"],
                    "archive_name": "session-backup.zip",
                },
            )
            assert resp.status == 200
            assert resp.headers.get("Content-Type") == "application/zip"
            disposition = resp.headers.get("Content-Disposition", "")
            assert "session-backup.zip" in disposition
            payload = await resp.read()
            archive = zipfile.ZipFile(io.BytesIO(payload))
            assert sorted(archive.namelist()) == [
                "20240104/alpha.opus",
                "20240104/beta.opus",
            ]
            archive.close()

            error_resp = await client.post(
                "/api/recordings/archive", json={"items": ["missing-file.opus"]}
            )
            assert error_resp.status == 400
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())


def test_recordings_update_allows_rename_and_tags(dashboard_env):
    async def runner():
        day_dir = dashboard_env / "20240106"
        day_dir.mkdir()

        original = day_dir / "alpha.opus"
        original.write_bytes(b"data")
        _write_waveform_stub(original.with_suffix(original.suffix + ".waveform.json"))

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post(
                "/api/recordings/update",
                json={
                    "items": [
                        {
                            "path": "20240106/alpha.opus",
                            "new_name": "renamed",
                            "tags": ["night", "alarm"],
                        }
                    ]
                },
            )
            assert resp.status == 200
            payload = await resp.json()
            assert not payload["errors"]
            assert payload["updated"][0]["renamed"] is True
            assert payload["updated"][0]["tags_updated"] is True

            renamed = day_dir / "renamed.opus"
            assert renamed.exists()
            assert not original.exists()
            assert renamed.with_suffix(renamed.suffix + ".waveform.json").exists()

            metadata_path = dashboard_env / ".recordings_metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            assert metadata["20240106/renamed.opus"]["tags"] == ["night", "alarm"]

            listing_resp = await client.get("/api/recordings")
            listing = await listing_resp.json()
            item = listing["items"][0]
            assert item["path"] == "20240106/renamed.opus"
            assert item["tags"] == ["night", "alarm"]

            # Clearing tags should drop metadata file entirely.
            clear_resp = await client.post(
                "/api/recordings/update",
                json={"items": [{"path": "20240106/renamed.opus", "tags": []}]},
            )
            assert clear_resp.status == 200
            clear_payload = await clear_resp.json()
            assert not clear_payload["errors"]
            assert clear_payload["updated"][0]["tags_updated"] is True
            assert not metadata_path.exists()

            invalid_resp = await client.post(
                "/api/recordings/update",
                json={"items": [{"path": "20240106/renamed.opus", "new_name": "bad/name"}]},
            )
            invalid_payload = await invalid_resp.json()
            assert invalid_resp.status == 200
            assert invalid_payload["errors"]
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
