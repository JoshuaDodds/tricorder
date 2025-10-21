#!/usr/bin/env python3
"""Generate a synthetic recording, capture a dashboard screenshot, and refresh README."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import yaml
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from lib.waveform_cache import generate_waveform
from lib.web_streamer import start_web_streamer_in_thread


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


def _prepare_config(template: Path, destination: Path, recordings_dir: Path, tmp_dir: Path, dropbox_dir: Path) -> None:
    with template.open("r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle)
    cfg.setdefault("paths", {})
    cfg["paths"]["recordings_dir"] = str(recordings_dir)
    cfg["paths"]["tmp_dir"] = str(tmp_dir)
    cfg["paths"]["dropbox_dir"] = str(dropbox_dir)
    cfg["paths"]["ingest_work_dir"] = str(tmp_dir / "ingest")
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
    return opus_path


def _wait_for_healthz(url: str, *, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with contextlib.closing(urllib.request.urlopen(url, timeout=5.0)) as response:
                body = response.read().decode("utf-8", "ignore").strip()
                if body == "ok":
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1.0)
    raise RuntimeError(f"web_streamer did not become healthy within {timeout} seconds")


def _capture_screenshot(url: str, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1600, "height": 900})
            page.goto(url, wait_until="networkidle")
            page.wait_for_selector("table#recordings-table tbody tr", timeout=10_000)
            row = page.locator("table#recordings-table tbody tr").first
            row.click()
            page.wait_for_timeout(500)
            toggle = page.locator("#clipper-toggle")
            toggle.wait_for(state="visible", timeout=5_000)
            toggle.click()
            page.wait_for_selector("#clipper-section[data-active='true']", timeout=5_000)
            page.wait_for_timeout(500)
            page.screenshot(path=str(output), full_page=True)
        finally:
            browser.close()


def _refresh_readme(readme_path: Path, image_path: Path, captured_at: dt.datetime) -> None:
    content = readme_path.read_text(encoding="utf-8")
    relative = image_path.as_posix()
    snippet = (
        f"{PLACEHOLDER_START}\n"
        f"![Tricorder dashboard preview]({relative})\n"
        f"<sub>Captured {captured_at.replace(microsecond=0, tzinfo=dt.timezone.utc).isoformat()}</sub>\n"
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

    for path in (recordings_dir, tmp_dir, dropbox_dir):
        path.mkdir(parents=True, exist_ok=True)

    config_path = config_root / "ci-config.yaml"
    _prepare_config(repo_root / "config.yaml", config_path, recordings_dir, tmp_dir, dropbox_dir)

    os.environ.setdefault("TRICORDER_CONFIG", str(config_path))
    os.environ.setdefault("REC_DIR", str(recordings_dir))
    os.environ.setdefault("TMP_DIR", str(tmp_dir))
    os.environ.setdefault("DROPBOX_DIR", str(dropbox_dir))
    os.environ.setdefault("TRICORDER_TMP", str(tmp_dir))
    os.environ.setdefault("DEV", "1")

    _create_sample_recording(recordings_dir)

    streamer = start_web_streamer_in_thread(host=host, port=port, access_log=False, log_level="INFO")
    captured_at = dt.datetime.utcnow()
    try:
        _wait_for_healthz(f"http://{host}:{port}/healthz")
        _capture_screenshot(f"http://{host}:{port}/dashboard", output)
    except PlaywrightError as exc:  # pragma: no cover - surfaced to CI logs
        raise RuntimeError(f"Playwright failed to capture dashboard screenshot: {exc}") from exc
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
