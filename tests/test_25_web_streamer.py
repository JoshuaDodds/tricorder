from __future__ import annotations

import asyncio

import pytest

import copy

import lib.web_streamer as web_streamer

pytest_plugins = ("aiohttp.pytest_plugin",)


@pytest.mark.asyncio
async def test_dashboard_page_structure(aiohttp_client):
    client = await aiohttp_client(web_streamer.build_app())

    response = await client.get("/")
    assert response.status == 200
    body = await response.text()
    assert "Tricorder Dashboard" in body
    assert 'id="recordings-table"' in body
    assert 'id="config-viewer"' in body
    assert 'href="/static/css/dashboard.css"' in body
    assert 'src="/static/js/dashboard.js"' in body
    assert 'data-tricorder-stream-mode="hls"' in body
    assert "data-tricorder-webrtc-ice-servers" in body


@pytest.mark.asyncio
async def test_hls_page_still_available(aiohttp_client):
    client = await aiohttp_client(web_streamer.build_app())

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
    client = await aiohttp_client(web_streamer.build_app())

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

    dashboard_js = await client.get("/static/js/dashboard.js")
    assert dashboard_js.status == 200
    dashboard_body = await dashboard_js.text()
    assert "const STREAM_MODE" in dashboard_body
    assert "const OFFER_ENDPOINT" in dashboard_body


@pytest.mark.asyncio
async def test_hls_playlist_waits_for_segments(monkeypatch, tmp_path, aiohttp_client):
    monkeypatch.setenv("TRICORDER_TMP", str(tmp_path))
    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    client = await aiohttp_client(web_streamer.build_app())

    playlist_path = tmp_path / "hls" / "live.m3u8"
    playlist_path.parent.mkdir(parents=True, exist_ok=True)

    async def _write_playlist():
        await asyncio.sleep(0.1)
        playlist_path.write_text(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000,\nseg00001.ts\n",
            encoding="utf-8",
        )

    writer = asyncio.create_task(_write_playlist())

    response = await client.get("/hls/live.m3u8")
    assert response.status == 200
    text = await response.text()
    assert "#EXTINF" in text
    assert response.headers.get("Cache-Control") == "no-store"

    await writer


@pytest.mark.asyncio
async def test_webrtc_mode_registers_webrtc_routes(monkeypatch, tmp_path, aiohttp_client):
    monkeypatch.setenv("TRICORDER_TMP", str(tmp_path))
    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)
    base_cfg = copy.deepcopy(config_module.get_cfg())
    base_cfg["streaming"] = {"mode": "webrtc", "webrtc_history_seconds": 2.0}
    monkeypatch.setattr(config_module, "_cfg_cache", base_cfg, raising=False)

    client = await aiohttp_client(web_streamer.build_app())

    dashboard_response = await client.get("/")
    assert dashboard_response.status == 200
    dashboard_body = await dashboard_response.text()
    assert "data-tricorder-webrtc-ice-servers" in dashboard_body
    assert "stun.cloudflare.com" in dashboard_body

    start_response = await client.get("/webrtc/start")
    assert start_response.status == 200

    stats_response = await client.get("/webrtc/stats")
    assert stats_response.status == 200
    stats_payload = await stats_response.json()
    assert "active_clients" in stats_payload
    assert "encoder_running" in stats_payload

    offer_response = await client.post(
        "/webrtc/offer",
        json={"sdp": "v=0", "type": "offer"},
    )
    assert offer_response.status == 503

    stop_response = await client.get("/webrtc/stop")
    assert stop_response.status == 200

    legacy_response = await client.get("/hls")
    assert legacy_response.status == 404


def test_normalize_webrtc_ice_servers_defaults():
    servers = web_streamer._normalize_webrtc_ice_servers(None)
    assert servers
    assert servers[0]["urls"] == ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]


def test_normalize_webrtc_ice_servers_custom_entries():
    payload = [
        " stun:stun.example.org:3478 ",
        {
            "urls": ["turn:turn.example.org:3478", ""],
            "username": " user ",
            "credential": " pass ",
        },
        {"urls": "stun:stun.backup.example.org"},
    ]
    servers = web_streamer._normalize_webrtc_ice_servers(payload)
    url_sets = {tuple(server.get("urls", [])) for server in servers}
    assert url_sets == {
        ("stun:stun.example.org:3478",),
        ("turn:turn.example.org:3478",),
        ("stun:stun.backup.example.org",),
    }
    auth_server = next(server for server in servers if server.get("username"))
    assert auth_server["username"] == "user"
    assert auth_server["credential"] == "pass"


def test_normalize_webrtc_ice_servers_disable():
    assert web_streamer._normalize_webrtc_ice_servers([]) == []


def test_parse_show_output_handles_blank_fields():
    payload = "\n".join(
        [
            "LoadState=loaded",
            "ActiveState=active",
            "SubState=running",
            "UnitFileState=enabled",
            "Description=Recorder",
            "CanStart=yes",
            "CanStop=yes",
            "CanReload=no",
            "CanRestart=yes",
            "TriggeredBy=",
        ]
    )

    parsed = web_streamer._parse_show_output(payload, web_streamer._SYSTEMCTL_PROPERTIES)

    assert parsed["LoadState"] == "loaded"
    assert parsed["ActiveState"] == "active"
    assert parsed["Description"] == "Recorder"
    assert parsed["CanStart"] == "yes"
    assert parsed["TriggeredBy"] == ""


def test_parse_show_output_handles_value_only_payload():
    payload = "\n".join(
        [
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
        ]
    )

    parsed = web_streamer._parse_show_output(payload, web_streamer._SYSTEMCTL_PROPERTIES)

    assert parsed["LoadState"] == "loaded"
    assert parsed["ActiveState"] == "active"
    assert parsed["Description"] == "Recorder"
    assert parsed["CanStart"] == "yes"
    assert parsed["TriggeredBy"] == ""
