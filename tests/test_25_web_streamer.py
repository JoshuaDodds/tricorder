from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone, timedelta

import pytest

import copy
import ssl
import subprocess
from pathlib import Path
from types import SimpleNamespace

import lib.web_streamer as web_streamer
import lib.recycle_bin_utils as recycle_bin_utils
import lib.lets_encrypt as lets_encrypt

pytest_plugins = ("aiohttp.pytest_plugin",)


TEST_CERT_PEM = """-----BEGIN CERTIFICATE-----
MIIDDTCCAfWgAwIBAgIUCetl27jBsWzLcDiiax1l5UG7YmAwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjUxMDAyMTAxMTU2WhcNMjUx
MDAzMTAxMTU2WjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAK4Zgs0VnsxDRtnYT9eAFdDNAiYV2MZpQnsL9Eqo
UoznUeamSf1McLYGmqMeM2Yf99IAVewBeWBbuqQl4Y6wVPUi7G5OwN7aSK+OI5Uu
DseqM4dA/TgEskcDE6Gob7jgMfbQQg07YDIFK3nyc62gFuC+Qc78MDHqmYCI4czW
rQhbxEpAqSnLLkG6Kr1PDOP0GpS+q+aZysTMPc4wKN7hdClJdgkdsTFcJNPJbLqi
X2bMMiSZ9ZRvlELJKySCr+VX2reT5u8/qyEGNRvDCNElnikPCfDmAK5XmeLfriFF
Hq/N/4GsiRHc4jGZ8lOPtvKUSvaKXPw2uh1lQTiyyowRgQcCAwEAAaNTMFEwHQYD
VR0OBBYEFCCp4YpRmop+Id1rLRvL4CvUVFaoMB8GA1UdIwQYMBaAFCCp4YpRmop+
Id1rLRvL4CvUVFaoMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEB
AEcbhmet4FeyIK3b5GnYcI3apXoskLo8gIgBzzBI/BsFoE6KI5eRwJyFLkqqa3n0
rPyH4IoDcBLzomRrid3Nsycu17Br1kCQtVdhcWvUIXT+YNw3SzF3aSG0qorKJTFi
DWW8tNCwo/l4eNYDSjtC/C2NLLtXzXWgpUJoPLOlvRUFDTlwkdY2sbcvew8Tf+B8
Fuun8Va4RaPN/oEQ/geTZctmi/ZjGlrxnqAkgLKFVAFcqqaLMLScadQ5J1AyZOje
/s6KQXCeFowoi6qWBfOKR+z6b9XBzu3PL6t09UyphcivJfClZ8SuTdxBK0uUFu2p
y/DBb2/pfS2PDXTyIFwhtc8=
-----END CERTIFICATE-----
"""


TEST_KEY_PEM = """-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCuGYLNFZ7MQ0bZ
2E/XgBXQzQImFdjGaUJ7C/RKqFKM51Hmpkn9THC2BpqjHjNmH/fSAFXsAXlgW7qk
JeGOsFT1IuxuTsDe2kivjiOVLg7HqjOHQP04BLJHAxOhqG+44DH20EINO2AyBSt5
8nOtoBbgvkHO/DAx6pmAiOHM1q0IW8RKQKkpyy5Buiq9Twzj9BqUvqvmmcrEzD3O
MCje4XQpSXYJHbExXCTTyWy6ol9mzDIkmfWUb5RCySskgq/lV9q3k+bvP6shBjUb
wwjRJZ4pDwnw5gCuV5ni364hRR6vzf+BrIkR3OIxmfJTj7bylEr2ilz8NrodZUE4
ssqMEYEHAgMBAAECggEAHNEFKOvksluKXSFkKb++HKbqLaKdFE403kf+weK1czQQ
htRMV9wwpbhXHRuxFzzAWKaMkjk2PWBBdsz8VhFSppaGusVXQCuyLzigJB+Q+7Rs
vfzgTMbeOUnFlJLcFyYorvkOjcEfrXfUl+UtB3aBguaK3vc4BPMXQEKn2S9JSaIc
3N5QcWTf8w9yV6bzCskSu2aLm3rX4QxHtJcxOMLeFL83FGHQE2yFbIJI/Rwa9DP0
oj3fMZEobvoGz82j98mdfZ6uxjlrk14VS9fDLs+Z9mwg2E9hLS0cE/CUR1dh64fd
QSp5QjZ5m/abSUhTxvK93NN5dDqZgUn1tEtg0hm0gQKBgQDbjyM8agOfXD8wxm09
p3QOCfbmHHyXivlPHByNyHC62Gn3JT/la0RHotWdSLJKtqMeVDQVYHrKgL7ys+Yp
DmVajYF2ly2+3WDvEpS+ZLawnKNjCKL2oOybrZA8bP0gmAhspBYcTQksv/La5juz
8VxxLYiYGis3LCty09kGwwwugQKBgQDK/teuAoAyHWoj4yVJ80dckeyxybnP+qGm
WmfEe6V8NopT44bX1u3xQBxCuKcYum21tGuNl8mNljpGXitSx6oT5/Dk4e+jD/VC
+DkQP4ER3kNKMk0g6Fj37fPJ7Cx+E8PPC2zO55iPTtZ2YkfeQNHJHDlaH77jjRec
MOG3Gc17hwKBgQCPQK001dbXO1Dfehf8ii1mm4nESgHgvoQ74ZOfzo/+2QUKg/tU
rNA4DT5jCPOLW+7B8x6oc/Kp/aaYpFgfoYzvsDQwNCNczQRZ+D2knAG26fyQuSna
0NSQHoZlZpchlRCqEcV7YagC0pqZyG5b0bcHATaGR0y7Cs6udRq9FrX0AQKBgQCa
m4yzyM3Q3ZxopulQsIzqkW3gX085e5/A7txXxwDcYUHr8MBUBiwF8hlULAWAjQVg
PoEoP7JQN1o9HB4NF2uPa7mK6hY1cMMRdbMoj+WDMXC4wyUBalXQx5hFc67Te8RI
HmCKGdSVWat4URSBz4a4kNmRrdoav+x6lrRjW7CoYwKBgQCiMK5qox22o8bqOjVX
Ww/0QDnKHa/H60576XKSiR0K37h3M9fO6ufVM0vbfbnVjZuSP32IvbqTgjNIf1A7
QGkTnrHQiZ/OdOnwTRN97oyn3jLA90bzEDsckxvqDWag2cd66Jmo2/l7VGSYfX5s
aC7kjiyNhRRWDfsToon9z4F5WQ==
-----END PRIVATE KEY-----
"""


def _write_test_certificate(tmp_path: Path) -> tuple[Path, Path]:
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert_path.write_text(TEST_CERT_PEM, encoding="utf-8")
    key_path.write_text(TEST_KEY_PEM, encoding="utf-8")
    return cert_path, key_path


def test_loop_callback_guard_replaces_none_callbacks(caplog):
    loop = asyncio.new_event_loop()
    try:
        logger = logging.getLogger("web_streamer")
        with caplog.at_level(logging.WARNING, logger="web_streamer"):
            web_streamer._install_loop_callback_guard(loop, logger)
            loop.call_soon(None)

        assert "call_soon(None)" in caplog.text

        loop.call_soon(loop.stop)
        loop.run_forever()
    finally:
        loop.close()


def test_handle_run_guard_discards_none_callbacks(caplog):
    loop = asyncio.new_event_loop()
    try:
        logger = logging.getLogger("web_streamer")
        web_streamer._reset_asyncio_guard_counters_for_tests()
        web_streamer._install_loop_callback_guard(loop, logger)

        handle = loop.call_soon(lambda: None)
        handle._callback = None
        handle._args = ("sentinel",)

        with caplog.at_level(logging.WARNING, logger="asyncio"):
            handle._run()

        assert "Discarded asyncio handle with None callback" in caplog.text
    finally:
        loop.close()


def test_handle_run_guard_ignores_cancelled_handles(caplog):
    loop = asyncio.new_event_loop()
    try:
        logger = logging.getLogger("web_streamer")
        web_streamer._reset_asyncio_guard_counters_for_tests()
        web_streamer._install_loop_callback_guard(loop, logger)

        handle = loop.call_soon(lambda: None)
        handle.cancel()

        with caplog.at_level(logging.WARNING, logger="asyncio"):
            handle._run()

        assert "Discarded asyncio handle with None callback" not in caplog.text
    finally:
        loop.close()


def test_selector_transport_guard_handles_missing_protocol(caplog):
    loop = asyncio.new_event_loop()
    try:
        logger = logging.getLogger("web_streamer")
        web_streamer._install_loop_callback_guard(loop, logger)

        from asyncio import selector_events

        class DummySock:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        class DummyServer:
            def __init__(self):
                self.detached = False

            def _detach(self):
                self.detached = True

        dummy_sock = DummySock()
        dummy_server = DummyServer()
        transport = SimpleNamespace(
            _protocol_connected=True,
            _protocol=None,
            _sock=dummy_sock,
            _loop=loop,
            _server=dummy_server,
        )

        with caplog.at_level(logging.WARNING, logger="asyncio"):
            selector_events._SelectorTransport._call_connection_lost(transport, None)

        assert dummy_sock.closed is True
        assert dummy_server.detached is True
        assert transport._sock is None
        assert transport._server is None
        assert transport._protocol is None
        assert transport._loop is None
        assert transport._protocol_connected is False
        assert any(
            record.levelno == logging.WARNING
            and "Selector transport missing protocol" in record.getMessage()
            for record in caplog.records
        )
    finally:
        loop.close()


def test_selector_transport_guard_invokes_protocol_callback():
    loop = asyncio.new_event_loop()
    try:
        logger = logging.getLogger("web_streamer")
        web_streamer._install_loop_callback_guard(loop, logger)

        from asyncio import selector_events

        class DummyProtocol:
            def __init__(self):
                self.lost_exc = None

            def connection_lost(self, exc):
                self.lost_exc = exc

        class DummySock:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        class DummyServer:
            def __init__(self):
                self.detached = False

            def _detach(self):
                self.detached = True

        protocol = DummyProtocol()
        dummy_sock = DummySock()
        dummy_server = DummyServer()
        transport = SimpleNamespace(
            _protocol_connected=True,
            _protocol=protocol,
            _sock=dummy_sock,
            _loop=loop,
            _server=dummy_server,
        )

        selector_events._SelectorTransport._call_connection_lost(transport, "boom")

        assert protocol.lost_exc == "boom"
        assert dummy_sock.closed is True
        assert dummy_server.detached is True
        assert transport._sock is None
        assert transport._server is None
        assert transport._protocol is None
        assert transport._loop is None
    finally:
        loop.close()


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
async def test_integrations_motion_endpoint(monkeypatch, tmp_path, aiohttp_client):
    monkeypatch.setenv("TRICORDER_TMP", str(tmp_path))
    client = await aiohttp_client(web_streamer.build_app())

    baseline = await client.get("/api/integrations")
    assert baseline.status == 200
    baseline_payload = await baseline.json()
    assert baseline_payload["motion_active"] is False

    activated = await client.get("/api/integrations?motion=true")
    assert activated.status == 200
    activated_payload = await activated.json()
    assert activated_payload["motion_active"] is True
    assert isinstance(activated_payload.get("motion_active_since"), (int, float))

    snapshot = await client.get("/api/integrations")
    snapshot_payload = await snapshot.json()
    assert snapshot_payload["motion_active"] is True
    assert snapshot_payload.get("events")

    deactivated = await client.get("/api/integrations?motion=false")
    deactivated_payload = await deactivated.json()
    assert deactivated_payload["motion_active"] is False
    assert deactivated_payload.get("motion_active_since") is None

    recordings = await client.get("/api/recordings")
    recordings_payload = await recordings.json()
    assert "motion_state" in recordings_payload
    assert recordings_payload["motion_state"]["motion_active"] is False


@pytest.mark.asyncio
async def test_recordings_saved_collection_lists_saved_entries(
    monkeypatch, tmp_path, aiohttp_client
):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    saved_day_dir = (
        recordings_dir
        / web_streamer.SAVED_RECORDINGS_DIRNAME
        / datetime.now(timezone.utc).strftime("%Y%m%d")
    )
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    saved_day_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = saved_day_dir / "saved.opus"
    audio_path.write_bytes(b"saved audio")
    waveform_path = audio_path.with_suffix(".opus.waveform.json")
    waveform_path.write_text(json.dumps({"duration_seconds": 1.5}), encoding="utf-8")

    client = await aiohttp_client(web_streamer.build_app())

    saved_response = await client.get("/api/recordings?collection=saved")
    assert saved_response.status == 200
    payload = await saved_response.json()
    assert payload["collection"] == "saved"
    assert payload["available_days"] == [saved_day_dir.name]
    assert payload["available_extensions"] == ["opus"]
    expected_storage = audio_path.stat().st_size + waveform_path.stat().st_size
    assert payload["recordings_total_bytes"] == expected_storage

    items = payload.get("items", [])
    assert len(items) == 1
    entry = items[0]
    expected_path = f"{web_streamer.SAVED_RECORDINGS_DIRNAME}/{saved_day_dir.name}/saved.opus"
    assert entry["path"] == expected_path
    assert entry["collection"] == "saved"
    assert entry["waveform_path"].endswith("saved.opus.waveform.json")

    recent_response = await client.get("/api/recordings")
    assert recent_response.status == 200
    recent_payload = await recent_response.json()
    assert recent_payload.get("collection") == "recent"
    assert recent_payload.get("items") == []
    assert recent_payload.get("recordings_total_bytes") == expected_storage


@pytest.mark.asyncio
async def test_recordings_listing_falls_back_to_raw_when_metadata_missing(
    monkeypatch, tmp_path, aiohttp_client
):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    day_dir = recordings_dir / "20251008"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    day_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = day_dir / "sample.opus"
    audio_path.write_bytes(b"opus")
    waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
    waveform_path.write_text(json.dumps({"duration_seconds": 1.0}), encoding="utf-8")

    raw_dir = recordings_dir / web_streamer.RAW_AUDIO_DIRNAME / day_dir.name
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / "sample.wav"
    raw_path.write_bytes(b"raw")

    client = await aiohttp_client(web_streamer.build_app())

    response = await client.get("/api/recordings")
    assert response.status == 200
    payload = await response.json()
    items = payload.get("items", [])
    assert len(items) == 1
    entry = items[0]
    expected_raw = f"{web_streamer.RAW_AUDIO_DIRNAME}/{day_dir.name}/{raw_path.name}"
    assert entry.get("raw_audio_path") == expected_raw
    assert entry.get("path") == f"{day_dir.name}/{audio_path.name}"


def test_saved_recordings_fallback_raw_path_ignores_prefix(tmp_path):
    recordings_dir = tmp_path / "recordings"
    saved_dir = recordings_dir / web_streamer.SAVED_RECORDINGS_DIRNAME
    day_dir = saved_dir / "20251008"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    day_dir.mkdir(parents=True, exist_ok=True)

    audio_path = day_dir / "sample.opus"
    audio_path.write_bytes(b"opus")
    waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
    waveform_path.write_text(json.dumps({"duration_seconds": 1.0}), encoding="utf-8")

    raw_root = recordings_dir / web_streamer.RAW_AUDIO_DIRNAME
    raw_day = raw_root / day_dir.name
    raw_day.mkdir(parents=True, exist_ok=True)
    raw_audio = raw_day / "sample.wav"
    raw_audio.write_bytes(b"raw")

    saved_raw_link = saved_dir / web_streamer.RAW_AUDIO_DIRNAME
    saved_raw_link.symlink_to(raw_root, target_is_directory=True)

    entries, days, exts, total = web_streamer._scan_recordings_worker(
        saved_dir,
        (".opus",),
        path_prefix=(web_streamer.SAVED_RECORDINGS_DIRNAME,),
        collection_label="saved",
    )

    assert total == audio_path.stat().st_size
    assert days == [day_dir.name]
    assert exts == ["opus"]
    assert len(entries) == 1

    entry = entries[0]
    expected_rel = f"{web_streamer.RAW_AUDIO_DIRNAME}/{day_dir.name}/{raw_audio.name}"
    assert entry["raw_audio_path"] == expected_rel
    assert entry["path"] == (
        f"{web_streamer.SAVED_RECORDINGS_DIRNAME}/{day_dir.name}/{audio_path.name}"
    )
    assert entry["waveform_path"] == (
        f"{web_streamer.SAVED_RECORDINGS_DIRNAME}/{day_dir.name}/{waveform_path.name}"
    )


@pytest.mark.asyncio
async def test_recordings_save_and_unsave_moves_files(
    monkeypatch, tmp_path, aiohttp_client
):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    day_dir = recordings_dir / "20250101"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    day_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = day_dir / "clip.opus"
    audio_path.write_bytes(b"clip audio")
    waveform_path = audio_path.with_suffix(".opus.waveform.json")
    waveform_path.write_text(json.dumps({"duration_seconds": 2.0}), encoding="utf-8")
    transcript_path = audio_path.with_suffix(".opus.transcript.json")
    transcript_path.write_text(json.dumps({"text": "hello"}), encoding="utf-8")

    client = await aiohttp_client(web_streamer.build_app())

    save_response = await client.post(
        "/api/recordings/save",
        json={"items": ["20250101/clip.opus"]},
    )
    assert save_response.status == 200
    save_payload = await save_response.json()
    expected_saved_path = f"{web_streamer.SAVED_RECORDINGS_DIRNAME}/20250101/clip.opus"
    assert save_payload["saved"] == [expected_saved_path]
    assert save_payload["errors"] == []

    saved_audio = recordings_dir / expected_saved_path
    saved_waveform = saved_audio.with_suffix(".opus.waveform.json")
    saved_transcript = saved_audio.with_suffix(".opus.transcript.json")
    assert saved_audio.exists()
    assert saved_waveform.exists()
    assert saved_transcript.exists()
    assert not audio_path.exists()
    assert not waveform_path.exists()
    assert not transcript_path.exists()

    unsave_response = await client.post(
        "/api/recordings/unsave",
        json={"items": [expected_saved_path]},
    )
    assert unsave_response.status == 200
    unsave_payload = await unsave_response.json()
    assert unsave_payload["unsaved"] == ["20250101/clip.opus"]
    assert unsave_payload["errors"] == []

    assert audio_path.exists()
    assert waveform_path.exists()
    assert transcript_path.exists()
    assert not saved_audio.exists()
    assert not saved_waveform.exists()
    assert not saved_transcript.exists()


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


def _adaptive_payload_with(**overrides):
    payload = {
        "enabled": True,
        "min_thresh": 0.02,
        "max_thresh": 0.9,
        "margin": 1.3,
        "update_interval_sec": 5.0,
        "window_sec": 10.0,
        "hysteresis_tolerance": 0.1,
        "release_percentile": 0.5,
        "voiced_hold_sec": 6.0,
        "max_rms": None,
    }
    payload.update(overrides)
    return payload


def test_normalize_adaptive_rms_payload_voiced_hold():
    normalized, errors = web_streamer._normalize_adaptive_rms_payload(
        _adaptive_payload_with(voiced_hold_sec="2.75")
    )

    assert not errors
    assert normalized["voiced_hold_sec"] == pytest.approx(2.75)


def test_normalize_adaptive_rms_payload_voiced_hold_bounds():
    normalized, errors = web_streamer._normalize_adaptive_rms_payload(
        _adaptive_payload_with(voiced_hold_sec=-1)
    )

    assert any("voiced_hold_sec" in message for message in errors)
    assert normalized["voiced_hold_sec"] == web_streamer._adaptive_rms_defaults()["voiced_hold_sec"]


def test_normalize_adaptive_rms_payload_allows_missing_min_thresh():
    payload = _adaptive_payload_with()
    payload.pop("min_thresh")

    normalized, errors = web_streamer._normalize_adaptive_rms_payload(payload)

    assert not errors
    assert normalized["min_thresh"] == web_streamer._adaptive_rms_defaults()["min_thresh"]


def test_normalize_adaptive_rms_payload_allows_blank_min_thresh():
    normalized, errors = web_streamer._normalize_adaptive_rms_payload(
        _adaptive_payload_with(min_thresh="   ")
    )

    assert not errors
    assert normalized["min_thresh"] == web_streamer._adaptive_rms_defaults()["min_thresh"]


def test_resolve_web_server_runtime_http_defaults():
    cfg = {"web_server": {"mode": "http", "listen_host": "127.0.0.1", "listen_port": 9090}}
    host, port, ssl_ctx, manager = web_streamer._resolve_web_server_runtime(cfg)

    assert host == "127.0.0.1"
    assert port == 9090
    assert ssl_ctx is None
    assert manager is None


def test_resolve_web_server_runtime_manual(tmp_path):
    cert_path, key_path = _write_test_certificate(tmp_path)
    cfg = {
        "web_server": {
            "mode": "https",
            "listen_host": "0.0.0.0",
            "listen_port": 443,
            "tls_provider": "manual",
            "certificate_path": str(cert_path),
            "private_key_path": str(key_path),
        }
    }

    host, port, ssl_ctx, manager = web_streamer._resolve_web_server_runtime(cfg)

    assert host == "0.0.0.0"
    assert port == 443
    assert isinstance(ssl_ctx, ssl.SSLContext)
    assert manager is None


def test_resolve_web_server_runtime_letsencrypt(tmp_path):
    cert_path, key_path = _write_test_certificate(tmp_path)
    captured: dict[str, object] = {}

    class StubManager:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        def ensure_certificate(self):
            captured["called"] = True
            return cert_path, key_path

    cfg = {
        "web_server": {
            "mode": "https",
            "listen_host": "0.0.0.0",
            "listen_port": 443,
            "tls_provider": "letsencrypt",
            "lets_encrypt": {
                "domains": ["recorder.example.com"],
                "email": "ops@example.com",
                "cache_dir": str(tmp_path / "cache"),
                "staging": True,
                "certbot_path": "/usr/bin/certbot",
                "http_port": 8080,
                "renew_before_days": 10,
            },
        }
    }

    host, port, ssl_ctx, manager = web_streamer._resolve_web_server_runtime(
        cfg, manager_factory=StubManager
    )

    assert host == "0.0.0.0"
    assert port == 443
    assert isinstance(ssl_ctx, ssl.SSLContext)
    assert isinstance(manager, StubManager)
    assert captured.get("called") is True
    kwargs = captured.get("kwargs")
    assert isinstance(kwargs, dict)
    assert kwargs["domains"] == ["recorder.example.com"]


def test_resolve_web_server_runtime_requires_domains():
    cfg = {"web_server": {"mode": "https", "tls_provider": "letsencrypt", "lets_encrypt": {"domains": []}}}

    with pytest.raises(RuntimeError):
        web_streamer._resolve_web_server_runtime(cfg)


def test_resolve_web_server_runtime_requires_manual_paths():
    cfg = {"web_server": {"mode": "https", "tls_provider": "manual"}}

    with pytest.raises(RuntimeError):
        web_streamer._resolve_web_server_runtime(cfg)


@pytest.mark.asyncio
async def test_web_server_update_triggers_streamer_restart(monkeypatch, aiohttp_client):
    base_cfg = copy.deepcopy(web_streamer.get_cfg())
    base_cfg.setdefault("web_server", web_streamer._web_server_defaults())

    def fake_get_cfg():
        return copy.deepcopy(base_cfg)

    monkeypatch.setattr(web_streamer, "get_cfg", fake_get_cfg, raising=False)
    monkeypatch.setattr(web_streamer, "reload_cfg", fake_get_cfg, raising=False)

    recorded: dict[str, object] = {}

    def fake_update(settings):
        recorded["settings"] = copy.deepcopy(settings)
        base_cfg.setdefault("web_server", {}).update(settings)
        return base_cfg["web_server"]

    monkeypatch.setattr(web_streamer, "update_web_server_settings", fake_update)

    async def fake_restart(units):
        recorded["restart_units"] = list(units)
        return [
            {
                "unit": unit,
                "ok": True,
                "stdout": "",
                "stderr": "",
                "message": "",
                "returncode": 0,
            }
            for unit in units
        ]

    monkeypatch.setattr(web_streamer, "_restart_units", fake_restart)

    client = await aiohttp_client(web_streamer.build_app())

    response = await client.post(
        "/api/config/web-server",
        json={
            "mode": "https",
            "listen_host": "0.0.0.0",
            "listen_port": 9443,
            "tls_provider": "letsencrypt",
            "lets_encrypt": {
                "enabled": True,
                "email": "ops@example.com",
                "domains": ["recorder.local"],
                "http_port": 8080,
                "renew_before_days": 15,
            },
        },
    )

    payload = await response.json()
    assert response.status == 200, payload
    assert recorded.get("restart_units") == ["web-streamer.service"]
    restart_units = [entry.get("unit") for entry in payload.get("restart_results", [])]
    assert "web-streamer.service" in restart_units


@pytest.mark.asyncio
async def test_lets_encrypt_renewal_reloads_ssl_context(monkeypatch, tmp_path):
    cert_path = tmp_path / "fullchain.pem"
    key_path = tmp_path / "privkey.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")

    loop = asyncio.get_running_loop()
    reload_event = asyncio.Event()
    load_calls: list[tuple[str, str]] = []

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)

    def fake_load_cert_chain(*, certfile: str, keyfile: str) -> None:
        load_calls.append((certfile, keyfile))
        loop.call_soon_threadsafe(reload_event.set)

    monkeypatch.setattr(ssl_context, "load_cert_chain", fake_load_cert_chain)

    class DummyManager:
        def __init__(self) -> None:
            self.calls = 0

        def ensure_certificate(self) -> tuple[Path, Path]:
            self.calls += 1
            return cert_path, key_path

    manager = DummyManager()
    app = web_streamer.build_app(lets_encrypt_manager=manager)
    app[web_streamer.SSL_CONTEXT_KEY] = ssl_context

    monkeypatch.setattr(web_streamer, "LETS_ENCRYPT_RENEWAL_INTERVAL_SECONDS", 0.01)

    await app.on_startup[-1](app)
    try:
        await asyncio.wait_for(reload_event.wait(), timeout=1.0)
    finally:
        for cleanup_cb in app.on_cleanup:
            await cleanup_cb(app)

    assert manager.calls >= 1
    assert load_calls
    certfile, keyfile = load_calls[-1]
    assert certfile == str(cert_path)
    assert keyfile == str(key_path)


def test_lets_encrypt_manager_requests_certificate(tmp_path, monkeypatch):
    manager = lets_encrypt.LetsEncryptManager(
        domains=["recorder.example.com"],
        email="ops@example.com",
        cache_dir=tmp_path / "le",
        staging=True,
        http_port=8080,
        renew_before_days=15,
        certbot_path="certbot",
    )

    monkeypatch.setattr(manager, "_resolve_certbot", lambda: "/usr/bin/certbot")

    run_calls: list[list[str]] = []

    def fake_run(cmd, *, check, stdout, stderr, text):
        run_calls.append(cmd)
        cert_dest, key_dest = manager.certificate_paths()
        cert_dest.parent.mkdir(parents=True, exist_ok=True)
        cert_dest.write_text(TEST_CERT_PEM, encoding="utf-8")
        key_dest.write_text(TEST_KEY_PEM, encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    future_expiration = datetime.now(timezone.utc) + timedelta(days=90)
    monkeypatch.setattr(manager, "_certificate_expiration", lambda path: future_expiration)

    cert_path, key_path = manager.ensure_certificate()
    assert cert_path.exists()
    assert key_path.exists()
    assert len(run_calls) == 1

    run_calls.clear()
    cert_path_2, key_path_2 = manager.ensure_certificate()
    assert not run_calls
    assert cert_path_2 == cert_path
    assert key_path_2 == key_path


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
            "ActiveEnterTimestamp=",
        ]
    )

    parsed = web_streamer._parse_show_output(payload, web_streamer._SYSTEMCTL_PROPERTIES)

    assert parsed["LoadState"] == "loaded"
    assert parsed["ActiveState"] == "active"
    assert parsed["Description"] == "Recorder"
    assert parsed["CanStart"] == "yes"
    assert parsed["TriggeredBy"] == ""


@pytest.mark.asyncio
async def test_recordings_delete_moves_raw_audio_to_recycle_bin(
    monkeypatch, tmp_path, aiohttp_client
):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = recordings_dir / "sample.opus"
    audio_path.write_bytes(b"audio")

    raw_rel = f"{web_streamer.RAW_AUDIO_DIRNAME}/20240101/sample.wav"
    raw_path = recordings_dir / raw_rel
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(b"raw")

    waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
    waveform_path.write_text(
        json.dumps(
            {
                "raw_audio_path": raw_rel,
                "duration_seconds": 1.0,
            }
        ),
        encoding="utf-8",
    )

    client = await aiohttp_client(web_streamer.build_app())

    delete_response = await client.post(
        "/api/recordings/delete",
        json={"items": ["sample.opus"]},
    )
    assert delete_response.status == 200
    delete_payload = await delete_response.json()
    assert delete_payload["deleted"] == ["sample.opus"]

    recycle_root = recordings_dir / web_streamer.RECYCLE_BIN_DIRNAME
    entries = list(recycle_root.iterdir())
    assert len(entries) == 1
    entry_dir = entries[0]
    metadata_path = entry_dir / web_streamer.RECYCLE_METADATA_FILENAME
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata.get("raw_audio_path") == raw_rel
    assert metadata.get("raw_audio_name") == raw_path.name

    assert not raw_path.exists()
    entry_raw_path = entry_dir / raw_path.name
    assert entry_raw_path.exists()

    purge_response = await client.post(
        "/api/recycle-bin/purge",
        json={"items": [entry_dir.name]},
    )
    assert purge_response.status == 200
    purge_payload = await purge_response.json()
    assert purge_payload["purged"] == [entry_dir.name]
    assert purge_payload["errors"] == []
    assert not entry_dir.exists()
    assert not raw_path.exists()


@pytest.mark.asyncio
async def test_recycle_bin_restore_reinstates_raw_audio(
    monkeypatch, tmp_path, aiohttp_client
):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = recordings_dir / "sample.opus"
    audio_path.write_bytes(b"audio")

    raw_rel = f"{web_streamer.RAW_AUDIO_DIRNAME}/20240101/sample.wav"
    raw_path = recordings_dir / raw_rel
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(b"raw")

    waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
    waveform_path.write_text(
        json.dumps(
            {
                "raw_audio_path": raw_rel,
                "duration_seconds": 1.0,
            }
        ),
        encoding="utf-8",
    )

    client = await aiohttp_client(web_streamer.build_app())

    delete_response = await client.post(
        "/api/recordings/delete",
        json={"items": ["sample.opus"]},
    )
    assert delete_response.status == 200

    recycle_root = recordings_dir / web_streamer.RECYCLE_BIN_DIRNAME
    entries = list(recycle_root.iterdir())
    assert len(entries) == 1
    entry_dir = entries[0]

    assert not raw_path.exists()
    entry_raw_path = entry_dir / raw_path.name
    assert entry_raw_path.exists()

    restore_response = await client.post(
        "/api/recycle-bin/restore",
        json={"items": [entry_dir.name]},
    )
    assert restore_response.status == 200
    restore_payload = await restore_response.json()
    assert restore_payload["restored"] == ["sample.opus"]
    assert restore_payload["errors"] == []

    assert audio_path.exists()
    assert waveform_path.exists()
    assert raw_path.exists()
    assert not entry_dir.exists()


@pytest.mark.asyncio
async def test_recycle_bin_list_includes_duration_and_reason(
    monkeypatch, tmp_path, aiohttp_client
):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    manual_path = recordings_dir / "manual.opus"
    manual_path.write_bytes(b"manual")
    manual_waveform = manual_path.with_suffix(manual_path.suffix + ".waveform.json")
    manual_waveform.write_text(
        json.dumps({"duration_seconds": 2.5}),
        encoding="utf-8",
    )

    client = await aiohttp_client(web_streamer.build_app())

    delete_response = await client.post(
        "/api/recordings/delete",
        json={"items": ["manual.opus"]},
    )
    assert delete_response.status == 200

    auto_path = recordings_dir / "auto.opus"
    auto_path.write_bytes(b"auto")
    recycle_bin_utils.move_short_recording_to_recycle_bin(
        auto_path,
        recordings_dir,
        duration=1.25,
    )

    list_response = await client.get("/api/recycle-bin")
    assert list_response.status == 200
    payload = await list_response.json()
    items = payload.get("items")
    assert isinstance(items, list)

    reasons = {str(entry.get("reason")): entry for entry in items}
    assert "manual" in reasons
    assert "short_clip" in reasons

    assert pytest.approx(reasons["manual"].get("duration_seconds"), rel=1e-3) == 2.5
    assert pytest.approx(reasons["short_clip"].get("duration_seconds"), rel=1e-3) == 1.25


@pytest.mark.asyncio
async def test_recycle_bin_purge_removes_requested_entries(monkeypatch, tmp_path, aiohttp_client):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = recordings_dir / "sample.opus"
    audio_path.write_bytes(b"audio")

    client = await aiohttp_client(web_streamer.build_app())

    delete_response = await client.post(
        "/api/recordings/delete",
        json={"items": ["sample.opus"]},
    )
    assert delete_response.status == 200
    delete_payload = await delete_response.json()
    assert delete_payload["deleted"] == ["sample.opus"]

    recycle_root = recordings_dir / web_streamer.RECYCLE_BIN_DIRNAME
    entries = list(recycle_root.iterdir())
    assert len(entries) == 1
    entry_id = entries[0].name

    purge_response = await client.post(
        "/api/recycle-bin/purge",
        json={"items": [entry_id]},
    )
    assert purge_response.status == 200
    purge_payload = await purge_response.json()
    assert purge_payload["purged"] == [entry_id]
    assert purge_payload["errors"] == []
    assert not any(recycle_root.iterdir()) if recycle_root.exists() else True


@pytest.mark.asyncio
async def test_recycle_bin_purge_handles_missing_metadata(monkeypatch, tmp_path, aiohttp_client):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    audio_path = recordings_dir / "sample.opus"
    audio_path.write_bytes(b"audio")

    client = await aiohttp_client(web_streamer.build_app())

    delete_response = await client.post(
        "/api/recordings/delete",
        json={"items": ["sample.opus"]},
    )
    assert delete_response.status == 200

    recycle_root = recordings_dir / web_streamer.RECYCLE_BIN_DIRNAME
    entries = list(recycle_root.iterdir())
    assert len(entries) == 1
    entry_dir = entries[0]
    metadata_path = entry_dir / web_streamer.RECYCLE_METADATA_FILENAME
    if metadata_path.exists():
        metadata_path.unlink()

    purge_response = await client.post(
        "/api/recycle-bin/purge",
        json={"delete_all": True},
    )
    assert purge_response.status == 200
    purge_payload = await purge_response.json()
    assert purge_payload["errors"] == []
    assert purge_payload["purged"] == [entry_dir.name]
    assert recycle_root.exists() is False or not any(recycle_root.iterdir())


@pytest.mark.asyncio
async def test_recycle_bin_purge_supports_age_filters(monkeypatch, tmp_path, aiohttp_client):
    recordings_dir = tmp_path / "recordings"
    tmp_dir = tmp_path / "tmp"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("REC_DIR", str(recordings_dir))
    monkeypatch.setenv("TMP_DIR", str(tmp_dir))

    from lib import config as config_module

    monkeypatch.setattr(config_module, "_cfg_cache", None, raising=False)

    first_path = recordings_dir / "first.opus"
    first_path.write_bytes(b"first")
    second_path = recordings_dir / "second.opus"
    second_path.write_bytes(b"second")

    client = await aiohttp_client(web_streamer.build_app())

    delete_response = await client.post(
        "/api/recordings/delete",
        json={"items": ["first.opus", "second.opus"]},
    )
    assert delete_response.status == 200

    recycle_root = recordings_dir / web_streamer.RECYCLE_BIN_DIRNAME
    entry_dirs = {entry.name: entry for entry in recycle_root.iterdir()}
    assert len(entry_dirs) == 2

    old_epoch = time.time() - 3600
    old_iso = datetime.fromtimestamp(old_epoch, tz=timezone.utc).isoformat()

    old_entry_id = ""
    new_entry_id = ""
    for entry_id, entry_dir in entry_dirs.items():
        metadata_path = entry_dir / web_streamer.RECYCLE_METADATA_FILENAME
        with metadata_path.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
        if metadata.get("stored_name") == "first.opus":
            metadata["deleted_at_epoch"] = old_epoch
            metadata["deleted_at"] = old_iso
            old_entry_id = entry_id
        else:
            new_entry_id = entry_id
        with metadata_path.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle)

    purge_response = await client.post(
        "/api/recycle-bin/purge",
        json={"older_than_seconds": 10},
    )
    assert purge_response.status == 200
    purge_payload = await purge_response.json()
    assert purge_payload["errors"] == []
    assert purge_payload["purged"] == [old_entry_id]
    assert (recycle_root / old_entry_id).exists() is False
    assert (recycle_root / new_entry_id).exists()


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
