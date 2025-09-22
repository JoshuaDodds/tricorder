import asyncio
import os

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


def test_delete_recording(dashboard_env):
    async def runner():
        target_dir = dashboard_env / "20240103"
        target_dir.mkdir()
        target = target_dir / "delete-me.opus"
        target.write_bytes(b"data")

        app = web_streamer.build_app()
        client, server = await _start_client(app)

        try:
            resp = await client.post("/api/recordings/delete", json={"items": ["20240103/delete-me.opus"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == ["20240103/delete-me.opus"]
            assert not target.exists()

            resp = await client.post("/api/recordings/delete", json={"items": ["../outside"]})
            assert resp.status == 200
            payload = await resp.json()
            assert payload["deleted"] == []
            assert payload["errors"]
        finally:
            await client.close()
            await server.close()

    asyncio.run(runner())
