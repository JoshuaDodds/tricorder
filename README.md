# Tricorder

Tricorder is an embedded audio event recorder designed for 24/7 capture on a Raspberry Pi Zero 2 W. It listens to a mono ALSA input, segments interesting activity with WebRTC VAD, encodes events to Opus, and serves them through an on-device dashboard and HLS stream.

This project targets **single-purpose deployments** on low-power hardware. The runtime is pinned to Python&nbsp;3.10 via `requirements.txt` to ensure wheel availability for the Pi Zero 2&nbsp;W.

---

## Highlights

- Continuous audio capture with adaptive RMS tracking and configurable VAD aggressiveness.
- Event segmentation with pre/post roll, asynchronous encoding, and automatic waveform sidecars for fast preview rendering.
- Live HLS streaming that powers up only when listeners are present and tears down when idle.
- Web dashboard (aiohttp + Jinja) for monitoring recorder state, browsing recordings, previewing audio + waveform, deleting files, and inspecting configuration.
- Dropbox-style ingest path for external recordings that reuses the segmentation + encoding pipeline.
- Systemd-managed services and timers, including optional automatic updates driven by `tricorder_auto_update.sh`.
- Utilities for deployment (`install.sh`), cleanup (`clear_logs.sh`), and environment tuning (`room_tuner.py`).

---

## Why the name “Tricorder”?

The name is both a nod to the *Star Trek* tricorder (a portable device that continuously scans and records signals)  
and a literal description of this project’s **three core recording functions**:

1. **Audio-triggered recording with Voice Activity Detection (VAD) tagging** – capture events when the input exceeds a sound threshold and/or speech is detected.  
2. **Live Network Streaming** – HLS live streaming of audio from the device microphone to any web browser.   
3. **External file ingestion** – process/ingest external recordings, trimming away uninteresting parts automatically.

---

## Architecture

```mermaid
graph TD
    A[Microphone / ALSA device] -->|raw PCM| B[live_stream_daemon.py]
    B -->|frames| C["TimelineRecorder (segmenter.py)"]
    C -->|tmp WAV| D[encode_and_store.sh]
    D -->|Opus + waveform JSON| E["recordings dir (/apps/tricorder/recordings)"]

    B -->|frames| H["HLSTee (hls_mux.py)"]
    H -->|segments + playlist| I[tmp/hls]
    I -->|static files| J["web_streamer.py + webui"]
    J -->|HTTP (dashboard + APIs)| K[Browsers / clients]
    J -->|encoder control| H

    subgraph "Dropbox ingest"
        F["Incoming file (/apps/tricorder/dropbox)"] --> G[process_dropped_file.py]
        G --> C
    end

    subgraph "Background services"
        SM_voice_recorder[voice-recorder.service] --> B
        SM_web_streamer[web-streamer.service] --> J
        SM_dropbox[dropbox.path + dropbox.service] --> G
        SM_tmpfs[tmpfs-guard.timer + tmpfs-guard.service] --> E
        SM_updater[tricorder-auto-update.timer + service] --> D
    end
```

Waveform sidecars are produced via `lib.waveform_cache` during the encode step so the dashboard can render previews instantly. The same encoder pipeline is reused for live capture and for files dropped into the ingest directory.

---

## Systemd units and helpers

| Unit / Script | Purpose |
| --- | --- |
| `voice-recorder.service` | Runs `live_stream_daemon.py` for continuous capture and segmentation. |
| `web-streamer.service` | Hosts the aiohttp dashboard + HLS endpoints (`lib/web_streamer.py`). |
| `dropbox.path` / `dropbox.service` | Watches `/apps/tricorder/dropbox` and processes externally provided recordings. |
| `tmpfs-guard.timer` / `tmpfs-guard.service` | Enforces tmpfs usage/rotation to prevent storage exhaustion. |
| `tricorder-auto-update.timer` / `tricorder-auto-update.service` | Periodically run `bin/tricorder_auto_update.sh` to pull and install updates. |
| `bin/encode_and_store.sh` | Invoked by the segmenter to encode WAV captures to Opus and call `lib.waveform_cache`. |
| `bin/tmpfs_guard.sh` | Cleans tmpfs + recording directories when the guard timer fires. |
| `bin/tricorder_auto_update.sh` | Git-pulls the configured remote, runs `install.sh`, then restarts core services. |
| `room_tuner.py` | Interactive console utility to dial in RMS thresholds and VAD aggressiveness for new rooms. |
| `main.py` | Development launcher that stops the systemd recorder, runs the live daemon in the foreground, and serves the dashboard on port 8080. |

`updater.env-example` documents the environment file expected by the auto-update service (`/etc/tricorder/update.env`). Update this file whenever new updater tunables are introduced.

---

## Web dashboard

`lib/web_streamer.py` + `lib/webui` expose a dashboard at `/` with the following capabilities:

- Live recorder status and listener counts with encoder start/stop controls.
- Recording browser with search, day filtering, pagination, and bulk deletion.
- Audio preview player with waveform visualization, trigger/release markers, and timeline scrubbing.
- Config viewer that renders the merged runtime configuration (post-environment overrides).
- JSON APIs (`/api/recordings`, `/api/config`, `/api/recordings/delete`, `/hls/stats`, etc.) consumed by the dashboard and available for automation.
- Legacy HLS status page at `/hls` retained for compatibility with earlier deployments.

Waveform JSON is loaded on demand and cached client-side. Missing or stale sidecars are regenerated via `lib.waveform_cache` (see `tests/test_waveform_cache.py`).

### Running locally

```bash
python -m lib.web_streamer --host 0.0.0.0 --port 8080
```

Visit `http://<device>:8080/` for the dashboard or `http://<device>:8080/hls` for the legacy HLS page. During development `python main.py` launches the live recorder and dashboard together, automatically stopping the systemd service while dev mode is active.

---

## Live HLS streaming

The live stream relies on `lib.hls_mux.HLSTee` to buffer recent audio frames and generate HLS segments only when listeners are connected:

- `/hls/start` increments the listener count and starts the encoder if idle.
- `/hls/live.m3u8` blocks until the first segment exists and is served with `Cache-Control: no-store`.
- `/hls/stop` decrements the listener count and schedules encoder shutdown after a cooldown.
- `/hls/stats` exposes the current listener count and encoder status for dashboards or monitoring.

HLS artifacts live under `<tmp_dir>/hls` (defaults to `/apps/tricorder/tmp/hls`). `ffmpeg` runs with `-hls_flags delete_segments` so disk usage stays bounded.

---

## Project layout

```
tricorder/
├── bin/
│   ├── encode_and_store.sh
│   ├── tmpfs_guard.sh
│   └── tricorder_auto_update.sh
├── ci/Dockerfile
├── config.yaml                # Default configuration shipped with the repo
├── install.sh
├── clear_logs.sh
├── lib/
│   ├── config.py              # Config loader with YAML + env overrides
│   ├── fault_handler.py
│   ├── hls_controller.py
│   ├── hls_mux.py
│   ├── live_stream_daemon.py
│   ├── process_dropped_file.py
│   ├── segmenter.py           # TimelineRecorder + encoder pipeline
│   ├── waveform_cache.py
│   ├── web_streamer.py        # aiohttp app + dashboard APIs
│   └── webui/                 # Templates + static assets for the dashboard
├── main.py
├── room_tuner.py
├── systemd/
│   ├── dropbox.path
│   ├── dropbox.service
│   ├── tmpfs-guard.service
│   ├── tmpfs-guard.timer
│   ├── tricorder-auto-update.service
│   ├── tricorder-auto-update.timer
│   ├── voice-recorder.service
│   └── web-streamer.service
├── tests/
│   ├── test_00_install.py
│   ├── test_10_segmenter.py
│   ├── test_20__fault_handler.py
│   ├── test_25_web_streamer.py
│   ├── test_30_dropbox.py
│   ├── test_40_end_to_end.py
│   ├── test_50_uninstall.py
│   ├── test_60_hls.py
│   ├── test_waveform_cache.py
│   └── test_web_dashboard.py
├── requirements.txt
├── requirements-dev.txt
├── updater.env-example
└── README.md
```

---

## Installation and upgrade

1. Flash a current Raspberry Pi OS (Bookworm) or Ubuntu Server image onto an SD card for a Raspberry Pi Zero&nbsp;2&nbsp;W. Boot, connect to the network, and clone this repository to a temporary working directory.
2. Run the installer from the repo checkout:
   ```bash
   ./install.sh
   ```
   - Installs apt dependencies (`ffmpeg`, `alsa-utils`, `python3-venv`, `python3-pip`).
   - Creates a Python virtualenv under `/apps/tricorder/venv` and installs `requirements.txt`.
   - Copies project files into `/apps/tricorder`, preserving existing YAML configs.
   - Installs/updates systemd units, enables services (`voice-recorder`, `web-streamer`, `dropbox`) and timers (`tmpfs-guard`, `tricorder-auto-update`).
3. Optional flags:
   - `DEV=1 ./install.sh` skips apt + systemd actions and also copies `main.py` and `room_tuner.py` for development setups.
   - `BASE=/custom/path ./install.sh` installs into an alternate root (used by tests and CI).

### Auto-update service

Copy `updater.env-example` to `/etc/tricorder/update.env` (or another path referenced by the systemd unit) and set:

- `TRICORDER_UPDATE_REMOTE` – Git URL to pull updates from.
- `TRICORDER_UPDATE_BRANCH` – Branch to track (default `main`).
- `TRICORDER_UPDATE_DIR` – Working directory for the updater checkout (default `/apps/tricorder/repo`).
- `TRICORDER_INSTALL_BASE` / `TRICORDER_INSTALL_SCRIPT` – Override install location or script if needed.
- `TRICORDER_UPDATE_SERVICES` – Space-separated units to restart after an update.
- `DEV=1` – Disable the updater without removing the timer.

The timer is configured for short intervals in tests; adjust to a longer cadence in production.

---

## Configuration

Configuration is merged from multiple sources (first match wins):

1. `TRICORDER_CONFIG` environment variable pointing to a YAML file.
2. `/etc/tricorder/config.yaml`
3. `/apps/tricorder/config.yaml`
4. `<project_root>/config.yaml`
5. `<script_dir>/config.yaml` (directory of the invoking script)
6. `./config.yaml`

Environment variables override YAML values. Common overrides include:

- `DEV=1` — enable verbose logging.
- `AUDIO_DEV`, `GAIN` — audio input and software gain.
- `REC_DIR`, `TMP_DIR`, `DROPBOX_DIR` — paths for recordings, tmpfs, and dropbox.
- `INGEST_STABLE_CHECKS`, `INGEST_STABLE_INTERVAL_SEC`, `INGEST_ALLOWED_EXT` — ingest tunables.
- `ADAPTIVE_RMS_*` — detailed control of the adaptive RMS tracker.

Key configuration sections (see `config.yaml` for defaults and documentation):

- `audio` – device, sample rate, frame size, gain, VAD aggressiveness.
- `paths` – tmpfs, recordings, dropbox, ingest work directory, encoder script path.
- `segmenter` – pre/post pads, RMS threshold, debounce windows, optional denoise toggles.
- `adaptive_rms` – background noise follower for automatically raising/lowering thresholds.
- `ingest` – file stability checks, extension filters, ignore suffixes.
- `logging` – developer-mode verbosity toggle.

---

## Tuning and utilities

- `room_tuner.py` streams audio from the configured device, reports RMS + VAD stats, and suggests `segmenter.rms_threshold` based on ambient noise (see docstring for usage examples). `reset_usb()` integration allows recovery from flaky USB sound cards during testing.
- `clear_logs.sh` rotates `journalctl` and wipes recordings/tmpfs directories; useful before running end-to-end tests.

---

## Testing

This repository uses `pytest`. Run the full suite before committing changes:

```bash
pytest -q
```

Notable test modules:

- `tests/test_00_install.py` / `tests/test_50_uninstall.py` – installer and cleanup coverage.
- `tests/test_10_segmenter.py` / `tests/test_20__fault_handler.py` – segmentation pipeline + USB fault handling.
- `tests/test_25_web_streamer.py` / `tests/test_web_dashboard.py` – dashboard routes, assets, APIs, waveform rendering.
- `tests/test_30_dropbox.py` – dropbox ingestion pipeline.
- `tests/test_40_end_to_end.py` – WAV → event encoding → Opus artifact validation.
- `tests/test_60_hls.py` – HLS controller lifecycle and playlist availability.
- `tests/test_waveform_cache.py` – waveform generation/backfill behavior.

Tests write to `/apps/tricorder/recordings` and temporary paths under `/tmp`. Ensure these paths are writable (CI uses environment overrides to redirect paths when necessary).
