from __future__ import annotations

import copy
import os
from pathlib import Path

import pytest

from lib.config import get_cfg
from lib.web_streamer import build_app

pytest_plugins = ("aiohttp.pytest_plugin",)


def _make_config(tmp_path: Path) -> tuple[dict, Path]:
    base_cfg = copy.deepcopy(get_cfg())
    paths = base_cfg.setdefault("paths", {})
    tmp_dir = tmp_path / "tmp"
    recordings_dir = tmp_path / "recordings"
    dropbox_dir = tmp_path / "dropbox"
    work_dir = tmp_path / "work"
    for directory in (tmp_dir, recordings_dir, dropbox_dir, work_dir):
        directory.mkdir(parents=True, exist_ok=True)
    paths["tmp_dir"] = str(tmp_dir)
    paths["recordings_dir"] = str(recordings_dir)
    paths["dropbox_dir"] = str(dropbox_dir)
    paths["ingest_work_dir"] = str(work_dir)
    return base_cfg, recordings_dir


@pytest.mark.asyncio
async def test_web_streamer_index_page_structure(tmp_path, aiohttp_client):
    cfg, _ = _make_config(tmp_path)
    client = await aiohttp_client(build_app(cfg))

    response = await client.get("/")
    assert response.status == 200
    body = await response.text()
    assert "Tricorder HLS Stream" in body
    assert "HLS Audio Stream" in body
    assert 'id="player"' in body
    assert 'id="clients"' in body
    assert 'id="enc"' in body
    assert 'id="recordings-section"' in body
    assert 'id="recording-player"' in body
    assert 'id="config-view"' in body
    assert 'href="/static/css/main.css"' in body
    assert 'src="/static/js/hls.js"' in body


@pytest.mark.asyncio
async def test_web_streamer_static_assets_available(tmp_path, aiohttp_client):
    cfg, _ = _make_config(tmp_path)
    client = await aiohttp_client(build_app(cfg))

    css_response = await client.get("/static/css/main.css")
    assert css_response.status == 200
    css_body = await css_response.text()
    assert ".layout" in css_body
    assert "#recordings-table" in css_body

    js_response = await client.get("/static/js/hls.js")
    assert js_response.status == 200
    js_body = await js_response.text()
    assert "const RECORDINGS_ENDPOINT" in js_body
    assert "setupRecordings" in js_body


@pytest.mark.asyncio
async def test_recordings_api_lists_and_filters(tmp_path, aiohttp_client):
    cfg, recordings_dir = _make_config(tmp_path)
    day_one = recordings_dir / "20240101"
    day_two = recordings_dir / "20240102"
    day_one.mkdir(parents=True, exist_ok=True)
    day_two.mkdir(parents=True, exist_ok=True)

    first = day_one / "08-00-00_Both_RMS-120_1.opus"
    second = day_two / "09-30-10_Human_RMS-300_2.opus"
    third = day_two / "11-00-00_Other_RMS-050_3.opus"

    first.write_bytes(b"a" * 10)
    second.write_bytes(b"b" * 20)
    third.write_bytes(b"c" * 30)

    base_ts = 1_700_000_000
    os.utime(first, (base_ts, base_ts))
    os.utime(second, (base_ts + 60, base_ts + 60))
    os.utime(third, (base_ts + 120, base_ts + 120))

    client = await aiohttp_client(build_app(cfg))

    response = await client.get("/api/recordings")
    assert response.status == 200
    payload = await response.json()
    assert payload["count"] == 3
    assert payload["days"] == ["20240102", "20240101"]
    ids = [item["id"] for item in payload["items"]]
    assert ids[0] == "20240102/11-00-00_Other_RMS-050_3.opus"
    assert payload["items"][0]["type"] == "Other"
    assert payload["items"][0]["size_bytes"] == 30

    response = await client.get("/api/recordings", params={"type": "Human"})
    assert response.status == 200
    humans = await response.json()
    assert humans["count"] == 1
    assert humans["items"][0]["id"].endswith("Human_RMS-300_2.opus")

    response = await client.get("/api/recordings", params={"day": "20240101"})
    assert response.status == 200
    day_payload = await response.json()
    assert day_payload["count"] == 1
    assert day_payload["items"][0]["id"].startswith("20240101/")

    response = await client.get("/api/recordings", params={"q": "rms-050"})
    assert response.status == 200
    search_payload = await response.json()
    assert search_payload["count"] == 1
    assert search_payload["items"][0]["id"].endswith("RMS-050_3.opus")

    response = await client.get("/api/recordings", params={"limit": "1"})
    assert response.status == 200
    limited = await response.json()
    assert limited["count"] == 1
    assert limited["has_more"] is True

    response = await client.get("/api/recordings", params={"day": "invalid"})
    assert response.status == 400


@pytest.mark.asyncio
async def test_recordings_delete_endpoint(tmp_path, aiohttp_client):
    cfg, recordings_dir = _make_config(tmp_path)
    day = recordings_dir / "20240201"
    day.mkdir(parents=True, exist_ok=True)
    target = day / "10-00-00_Both_RMS-200_1.opus"
    target.write_bytes(b"x" * 5)

    client = await aiohttp_client(build_app(cfg))

    response = await client.post(
        "/api/recordings/delete",
        json={"items": ["20240201/10-00-00_Both_RMS-200_1.opus"]},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["deleted"] == ["20240201/10-00-00_Both_RMS-200_1.opus"]
    assert payload["failed"] == []
    assert not target.exists()
    assert not day.exists()  # empty directory removed

    response = await client.post(
        "/api/recordings/delete",
        json={"items": ["20240201/missing.opus"]},
    )
    assert response.status == 404
    error_payload = await response.json()
    assert error_payload["deleted"] == []
    assert error_payload["failed"]


@pytest.mark.asyncio
async def test_config_endpoint_returns_merged_config(tmp_path, aiohttp_client):
    cfg, recordings_dir = _make_config(tmp_path)
    client = await aiohttp_client(build_app(cfg))

    response = await client.get("/api/config")
    assert response.status == 200
    payload = await response.json()
    assert payload["config"]["paths"]["recordings_dir"] == str(recordings_dir)
    assert "recordings_dir" in payload["text"]
