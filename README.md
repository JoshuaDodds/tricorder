# Tricorder

Tricorder is an embedded audio event recorder designed to run continuously on a Raspberry Pi Zero 2 W.  
It listens to audio input, segments interesting activity using WebRTC VAD, encodes detected events to Opus,  
and stores them locally. Also supports dropping externally recorded events into this projects processing pipeline
for processing. 

This project is designed for **single-purpose deployment** on a dedicated device.

Note: This project is pinned to Python ≥3.10 with requirements.txt to ensure consistent builds on Raspberry Pi Zero 2W 
(armhf/arm64 wheels).

---

## Features

- Continuous low-power audio monitoring on RPi Zero 2 W
- WebRTC-based voice activity detection at 48 kHz / 20 ms frames
- Efficient encoding with `ffmpeg` (Opus @ ~48 kbps, mono)
- Event-based segmentation with pre/post roll context
- Systemd-managed services for recording, encoding, storage, and syncing
- Automatic tmpfs space guard and log rotation

---

## Why the name “Tricorder”?

The name is both a nod to the *Star Trek* tricorder (a portable device that continuously scans and records signals)  
and a literal description of this project’s **three core recording functions**:

1. **Audio-triggered recording** – capture events only when the input exceeds a sound threshold.  
2. **Voice Activity Detection (VAD)** – segment speech and other meaningful sounds from noise.  
3. **External file ingestion** – process/ingest external recordings, trimming away uninteresting parts automatically.

---

# Tricorder Architecture

```mermaid
graph TD
    A[Microphone / Audio Device] -->|raw PCM| B[live_stream_daemon.py]
    B -->|frames| C[segmenter.py]
    C -->|tmp wav| D[encode_and_store.sh]
    D -->|opus files| E["recordings dir (/apps/tricorder/recordings)"]

    subgraph Dropbox Ingestion
        F["Incoming File (/apps/tricorder/dropbox)"] --> G[process_dropped_file.py]
        G --> C
    end

    subgraph System Management
        H[voice-recorder.service] --> B
        I[dropbox.path + dropbox.service] --> G
        J[tmpfs-guard.timer + tmpfs-guard.service] --> E
    end
```

---

## Project Structure

```text
Folders
-------
tricorder/
  bin/                # Shell utilities
  lib/                # Core Python modules
  systemd/            # Systemd unit files
  
Layout
------
tricorder/
├── README.md
├── requirements.txt
├── install.sh
├── clear_logs.sh
├── main.py
├── __init__.py
├── .gitignore
├── .gitattributes
│
├── bin/
│ ├── encode_and_store.sh
│ └── tmpfs_guard.sh
│
├── lib/
│ ├── __init__.py
│ ├── fault_handler.py
│ ├── live_stream_daemon.py
│ ├── process_dropped_file.py
│ └── segmenter.py
│
└── systemd/
├── voice-recorder.service
├── dropbox.service
├── dropbox.path
├── tmpfs-guard.service
└── tmpfs-guard.timer

```
---

## Installation

1. Flash Ubuntu 24.04 LTS onto an SD card. Boot and connect to network.
2. Copy/Clone this repo onto the Pi. (not the install directory)
3. Run the installer:
   ```bash
   ./install.sh
   ```
   This will install dependencies, set up a Python venv, and register systemd services. It willl also nable and start services
   
---

## Configuration

- **Audio device**: Default ALSA device can be overridden via env var or specified in segmenter.py and the voice-recorder unit file:
  ```bash
  export AUDIO_DEV=hw:1,0
  ```
- **Recording parameters** (defaults are tuned for Pi Zero 2 W):
  - Sample rate: 48000 Hz, mono
  - Frame size: 20 ms (960 samples)
  - Opus bitrate: 48 kbps
- **Directories**:
  - `/apps/tricorder/recordings` → stores encoded `.opus` files
  - `/apps/tricorder/dropbox` → watched for incoming files
  - `/apps/tricorder/tmp` → transient scratch space

---

## Services

- `voice-recorder.service` → runs the recorder daemon and segments audio into events
- `dropbox.path` + `dropbox.service` → monitor Dropbox folder and ingest files from it
- `tmpfs-guard.timer` + `tmpfs-guard.service` → ensure tmpfs doesn’t fill beyond threshold
- `clear_logs.sh` → legacy; prefer journald size limits (utility script not a service)

---

## Usage

- Logs can be monitored with:
  ```bash
  journalctl -u voice-recorder.service -f
  ```
- Recordings will appear under `/apps/tricorder/recordings`.
- To test the pipeline, a self-test service/script will be added (see TODO).

---

## TODO (next improvements)

- [ ] Make `/apps/tricorder` paths configurable via environment variables (e.g., `REC_DIR`, `TMP_DIR`).
- [x] Harden `dropbox.service` ingestion loop to avoid race with partial files.
- [ ] Gate debug logging behind environment variable to reduce journald volume.
- [ ] Document audio device configuration (`arecord -l`) and how to override `AUDIO_DEV`.
- [ ] Add self-test script/service to record, encode, and verify an event end-to-end.

---

## Contributing

This project is optimized for embedded deployment. Keep changes minimal, efficient, and mindful of Pi Zero 2 W constraints (CPU, RAM, storage).
