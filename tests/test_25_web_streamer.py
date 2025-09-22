from __future__ import annotations

import pytest

from lib.web_streamer import build_app

pytest_plugins = ("aiohttp.pytest_plugin",)


@pytest.mark.asyncio
async def test_dashboard_page_structure(aiohttp_client):
    client = await aiohttp_client(build_app())

    response = await client.get("/")
    assert response.status == 200
    body = await response.text()
    assert "Tricorder Dashboard" in body
    assert 'id="recordings-table"' in body
    assert 'id="config-viewer"' in body
    assert 'href="/static/css/dashboard.css"' in body
    assert 'src="/static/js/dashboard.js"' in body


@pytest.mark.asyncio
async def test_hls_page_still_available(aiohttp_client):
    client = await aiohttp_client(build_app())

    response = await client.get("/hls")
    assert response.status == 200
    body = await response.text()
    assert "Tricorder HLS Stream" in body
    assert "HLS Audio Stream" in body
    assert 'id="player"' in body
    assert 'id="clients"' in body
    assert 'id="enc"' in body
    assert 'href="/static/css/main.css"' in body
    assert 'src="/static/js/hls.js"' in body


@pytest.mark.asyncio
async def test_web_streamer_static_assets_available(aiohttp_client):
    client = await aiohttp_client(build_app())

    css_response = await client.get("/static/css/main.css")
    assert css_response.status == 200
    css_body = await css_response.text()
    assert ".badge" in css_body

    js_response = await client.get("/static/js/hls.js")
    assert js_response.status == 200
    js_body = await js_response.text()
    assert "const START_ENDPOINT" in js_body
    assert "const SESSION_STORAGE_KEY" in js_body
    assert "withSession" in js_body
