#!/usr/bin/env python3
"""Generate a synthetic recording, capture a dashboard screenshot, and refresh README."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path


def _log(message: str) -> None:
    timestamp = dt.datetime.utcnow().replace(microsecond=0, tzinfo=dt.timezone.utc)
    print(f"[snapshot] {timestamp.isoformat()} {message}", flush=True)

import yaml
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from lib.waveform_cache import generate_waveform
from lib.web_streamer import start_web_streamer_in_thread


def _write_debug_artifact(debug_dir: Path, name: str, content: str | bytes) -> Path:
    debug_dir.mkdir(parents=True, exist_ok=True)
    path = debug_dir / name
    mode = "wb" if isinstance(content, (bytes, bytearray)) else "w"
    with path.open(mode, encoding=None if mode == "wb" else "utf-8") as handle:
        handle.write(content)
    return path


PLACEHOLDER_START = "<!-- DASHBOARD_SCREENSHOT_START -->"
PLACEHOLDER_END = "<!-- DASHBOARD_SCREENSHOT_END -->"
DEFAULT_IMAGE_NAME = "staging-dashboard.png"


def _write_sine_wave(wav_path: Path, duration_seconds: float = 10.0, *, sample_rate: int = 48_000,
                     frequency_hz: float = 880.0, amplitude: float = 0.3) -> None:
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    total_frames = int(duration_seconds * sample_rate)
    with wave.open(str(wav_path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        for index in range(total_frames):
            theta = 2.0 * math.pi * frequency_hz * (index / sample_rate)
            value = int(max(-1.0, min(1.0, amplitude * math.sin(theta))) * 32767)
            handle.writeframesraw(value.to_bytes(2, byteorder="little", signed=True))
        handle.writeframes(b"")


def _transcode_to_opus(wav_path: Path, opus_path: Path) -> None:
    opus_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(wav_path),
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        str(opus_path),
    ]
    subprocess.run(cmd, check=True)


def _build_waveform(wav_path: Path, opus_path: Path, *, started_epoch: float) -> Path:
    waveform_path = opus_path.with_suffix(opus_path.suffix + ".waveform.json")
    payload = generate_waveform(wav_path, waveform_path)
    duration = float(payload.get("duration_seconds", 0.0))
    started_iso = dt.datetime.fromtimestamp(started_epoch, tz=dt.timezone.utc).isoformat()
    day_component = opus_path.parent.name
    base_name = opus_path.stem
    payload.update(
        {
            "start_epoch": started_epoch,
            "started_epoch": started_epoch,
            "started_at": started_iso,
            "trigger_offset_seconds": 0.5,
            "release_offset_seconds": duration,
            "motion_trigger_offset_seconds": 0.0,
            "motion_release_offset_seconds": duration,
            "motion_started_epoch": started_epoch,
            "motion_released_epoch": started_epoch + duration,
            "manual_event": False,
            "detected_rms": True,
            "detected_vad": True,
            "trigger_sources": ["vad"],
            "end_reason": "auto-stop",
            "raw_audio_path": f".original_wav/{day_component}/{base_name}.wav",
        }
    )
    waveform_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return waveform_path


def _prepare_config(
    template: Path,
    destination: Path,
    recordings_dir: Path,
    tmp_dir: Path,
    dropbox_dir: Path,
    *,
    dashboard_base_url: str,
    stream_mode: str = "webrtc",
) -> None:
    with template.open("r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle)
    cfg.setdefault("paths", {})
    cfg["paths"]["recordings_dir"] = str(recordings_dir)
    cfg["paths"]["tmp_dir"] = str(tmp_dir)
    cfg["paths"]["dropbox_dir"] = str(dropbox_dir)
    cfg["paths"]["ingest_work_dir"] = str(tmp_dir / "ingest")
    streaming_cfg = cfg.setdefault("streaming", {})
    streaming_cfg["mode"] = stream_mode
    dashboard_cfg = cfg.setdefault("dashboard", {})
    dashboard_cfg["api_base"] = dashboard_base_url
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(cfg, handle, sort_keys=False)


def _create_sample_recording(recordings_dir: Path) -> Path:
    now = dt.datetime.utcnow()
    day = now.strftime("%Y%m%d")
    timestamp = now.strftime("%H-%M-%S")
    base_name = f"{timestamp}_staging-dashboard"
    opus_path = recordings_dir / day / f"{base_name}.opus"
    wav_path = recordings_dir / ".original_wav" / day / f"{base_name}.wav"
    _write_sine_wave(wav_path)
    _transcode_to_opus(wav_path, opus_path)
    _build_waveform(wav_path, opus_path, started_epoch=now.timestamp() - 1.0)
    _log(f"seeded sample recording at {opus_path.relative_to(recordings_dir.parent)}")
    return opus_path


def _wait_for_healthz(url: str, *, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    _log(f"waiting for web_streamer health at {url}")
    while time.monotonic() < deadline:
        try:
            with contextlib.closing(urllib.request.urlopen(url, timeout=5.0)) as response:
                body = response.read().decode("utf-8", "ignore").strip()
                if body == "ok":
                    _log("web_streamer reported healthy")
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1.0)
    raise RuntimeError(f"web_streamer did not become healthy within {timeout} seconds")


def _wait_for_recordings_payload(url: str, *, timeout: float = 60.0, debug_dir: Path | None = None) -> dict:
    """Poll the recordings API until it returns at least one item."""

    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            with contextlib.closing(urllib.request.urlopen(url, timeout=5.0)) as response:
                payload = json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:  # pragma: no cover - network and JSON edge cases
            last_error = exc
            payload = None
        else:
            items = payload.get("items") if isinstance(payload, dict) else None
            if isinstance(items, list) and items:
                _log(f"recordings API returned {len(items)} items on attempt {attempt}")
                if debug_dir is not None:
                    try:
                        _write_debug_artifact(debug_dir, "recordings_payload.json", json.dumps(payload, indent=2))
                    except Exception as exc:  # pragma: no cover - best effort diagnostics
                        _log(f"failed to write recordings payload debug artifact: {exc}")
                return payload
            else:
                keys = sorted(payload.keys()) if isinstance(payload, dict) else type(payload).__name__
                _log(f"recordings API response missing items; keys={keys} (attempt {attempt})")
        time.sleep(1.0)

    error_detail = f" (last error: {last_error})" if last_error is not None else ""
    raise RuntimeError(
        "recordings API did not return any items within"
        f" {timeout:.0f} seconds{error_detail}"
    )


def _wait_for_recording_row(page, *, total_timeout_ms: int = 30_000, debug_dir: Path | None = None):
    """Wait until at least one recording row is rendered on the dashboard."""

    deadline = time.monotonic() + (total_timeout_ms / 1000.0)
    attempts = 0
    while time.monotonic() < deadline:
        remaining_ms = int(max((deadline - time.monotonic()) * 1000, 500))
        try:
            page.wait_for_function(
                "() => document.querySelectorAll('table#recordings-table tbody tr').length > 0",
                timeout=remaining_ms,
            )
            return page.locator("table#recordings-table tbody tr").first
        except PlaywrightTimeoutError:
            attempts += 1
            if debug_dir is not None:
                try:
                    html = page.content()
                except PlaywrightError as exc:  # pragma: no cover - best effort diagnostics
                    _log(f"failed to read page content during attempt {attempts}: {exc}")
                else:
                    _write_debug_artifact(debug_dir, f"dashboard_dom_attempt_{attempts}.html", html)
            _log(f"recordings table not visible after attempt {attempts}; reloading page")
            # Refresh once to give the client a chance to recover from slow API calls.
            page.reload(wait_until="networkidle")
    raise PlaywrightTimeoutError(
        f"recordings table did not populate within {total_timeout_ms / 1000:.0f} seconds after {attempts + 1} attempts"
    )


def _capture_screenshot(url: str, output: Path, *, debug_dir: Path | None = None) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1600, "height": 900})
            page.on("console", lambda msg: _log(f"browser console[{msg.type}] {msg.text}"))

            def _maybe_log_response(response):  # pragma: no cover - network inspection hook
                try:
                    url_lower = response.url.lower()
                except AttributeError:
                    return
                if "/api/recordings" in url_lower:
                    _log(f"browser saw response {response.status} for {response.url}")

            page.on("response", _maybe_log_response)
            page.goto(url, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=5_000)
            except PlaywrightTimeoutError:
                _log("dashboard did not reach network idle; continuing after DOM content load")
            row = _wait_for_recording_row(page, total_timeout_ms=45_000, debug_dir=debug_dir)
            row.click()
            page.wait_for_timeout(500)
            toggle = page.locator("#clipper-toggle")
            toggle.wait_for(state="visible", timeout=5_000)
            toggle.click()
            page.wait_for_selector("#clipper-section[data-active='true']", timeout=5_000)
            page.wait_for_timeout(500)
            page.screenshot(path=str(output), full_page=True)
            _log(f"captured dashboard screenshot to {output}")
        except PlaywrightError as exc:
            if debug_dir is not None:
                try:
                    page.screenshot(path=str(debug_dir / "dashboard_failure.png"), full_page=True)
                except Exception as capture_exc:  # pragma: no cover - best effort diagnostics
                    _log(f"failed to capture fallback screenshot: {capture_exc}")
            raise
        finally:
            browser.close()


def _refresh_readme(readme_path: Path, image_path: Path, captured_at: dt.datetime) -> None:
    content = readme_path.read_text(encoding="utf-8")
    relative = image_path.as_posix()
    snippet = (
        f"{PLACEHOLDER_START}\n"
        f"> Generate a fresh dashboard preview by running `python ci/staging_dashboard_snapshot.py --output {relative} --readme {readme_path.name}`.\n"
        f"> The image is built and saved to `docs/images/staging-dashboard.png` for each pre-release built on the staging branch.\n"
        f"<sub>Last updated {captured_at.replace(microsecond=0, tzinfo=dt.timezone.utc).isoformat()}</sub>\n"
        f"{PLACEHOLDER_END}"
    )
    if PLACEHOLDER_START in content and PLACEHOLDER_END in content:
        start_index = content.index(PLACEHOLDER_START)
        end_index = content.index(PLACEHOLDER_END) + len(PLACEHOLDER_END)
        updated = content[:start_index] + snippet + content[end_index:]
    else:
        heading_end = content.find("\n---")
        if heading_end == -1:
            heading_end = len(content)
        updated = content[:heading_end] + f"\n\n{snippet}\n" + content[heading_end:]
    readme_path.write_text(updated, encoding="utf-8")


def run(output: Path, readme_path: Path, *, host: str = "127.0.0.1", port: int = 8080) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    work_root = repo_root / ".ci_env"
    config_root = work_root / "config"
    recordings_dir = work_root / "recordings"
    tmp_dir = work_root / "tmp"
    dropbox_dir = work_root / "dropbox"
    debug_dir = work_root / "debug"

    for path in (recordings_dir, tmp_dir, dropbox_dir):
        path.mkdir(parents=True, exist_ok=True)

    if debug_dir.exists():
        shutil.rmtree(debug_dir)
    debug_dir.mkdir(parents=True, exist_ok=True)
    _log(f"debug artifacts will be written to {debug_dir}")

    config_path = config_root / "ci-config.yaml"
    dashboard_base_url = f"http://{host}:{port}"
    _prepare_config(
        repo_root / "config.yaml",
        config_path,
        recordings_dir,
        tmp_dir,
        dropbox_dir,
        dashboard_base_url=dashboard_base_url,
    )
    _log(f"prepared config at {config_path}")

    os.environ.setdefault("TRICORDER_CONFIG", str(config_path))
    os.environ.setdefault("REC_DIR", str(recordings_dir))
    os.environ.setdefault("TMP_DIR", str(tmp_dir))
    os.environ.setdefault("DROPBOX_DIR", str(dropbox_dir))
    os.environ.setdefault("TRICORDER_TMP", str(tmp_dir))
    os.environ.setdefault("DEV", "1")

    sample = _create_sample_recording(recordings_dir)
    opus_files = sorted(p.relative_to(recordings_dir) for p in recordings_dir.rglob("*.opus"))
    _log(f"found {len(opus_files)} opus files after seeding")
    try:
        inventory = {
            "sample": sample.relative_to(recordings_dir.parent).as_posix(),
            "opus_files": [p.as_posix() for p in opus_files],
        }
        _write_debug_artifact(debug_dir, "recordings_inventory.json", json.dumps(inventory, indent=2))
    except Exception as exc:  # pragma: no cover - diagnostics only
        _log(f"failed to write recordings inventory: {exc}")

    streamer = start_web_streamer_in_thread(host=host, port=port, access_log=False, log_level="INFO")
    captured_at = dt.datetime.utcnow()
    try:
        _wait_for_healthz(f"http://{host}:{port}/healthz")
        _wait_for_recordings_payload(f"http://{host}:{port}/api/recordings?limit=1", debug_dir=debug_dir)
        _capture_screenshot(f"http://{host}:{port}/dashboard", output, debug_dir=debug_dir)
    except PlaywrightError as exc:  # pragma: no cover - surfaced to CI logs
        debug_hint = f"; debug artifacts under {debug_dir}" if debug_dir.exists() else ""
        raise RuntimeError(
            f"Playwright failed to capture dashboard screenshot: {exc}{debug_hint}"
        ) from exc
    finally:
        streamer.stop()

    relative_image = output.relative_to(repo_root)
    _refresh_readme(readme_path, relative_image, captured_at)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("docs/images") / DEFAULT_IMAGE_NAME,
                        help="Destination path for the screenshot (default: docs/images/staging-dashboard.png)")
    parser.add_argument("--readme", type=Path, default=Path("README.md"), help="README file to update")
    args = parser.parse_args(argv)
    try:
        run(args.output.resolve(), args.readme.resolve())
    except Exception as exc:  # pragma: no cover - surfaced in CI
        print(f"[snapshot] failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
