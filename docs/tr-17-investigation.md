# TR-17 investigation notes

## Clip editor overwrite workflow
- The dashboard sends `overwrite_existing` requests, but the server always renders a fresh clip. `_create_clip_sync()` writes a brand-new `.opus` file and waveform, only backing up the previous assets for undo via `_prepare_clip_backup()`.【F:lib/web_streamer.py†L1855-L2012】
- Renaming without re-encoding would need a separate branch that moves the existing clip and sidecar and updates in-memory metadata, which is not present today.

## Dropbox ingest backlog handling
- `scan_and_ingest()` re-processes any leftover work items in `/tmp/ingest` (`WORK_DIR`) through `_retry_stalled_work_files()`, then moves new stable files from the Dropbox folder into that workspace for ingestion.【F:lib/process_dropped_file.py†L178-L220】
- The ingest script does not inspect `/recordings` for partially encoded artifacts before deleting or re-queuing items, so mismatched durations are never detected automatically.

## Recording vs. encoding indicators
- The dashboard derives both the recording pill and encoding summary from the same `capture_status` payload. Any file entering the ingest queue increments `encoding.pending`, which toggles the encoding status UI.【F:lib/webui/static/js/dashboard.js†L1650-L1689】【F:lib/web_streamer.py†L2220-L2251】
- The recording indicator only switches to “active” when `capture_status.capturing` is true; ingest-only jobs leave it in the idle/disabled states.【F:lib/webui/static/js/dashboard.js†L1320-L1405】

## Segmenter shutdown status writes
- `TimelineRecorder.flush()` always persists a terminal snapshot (capturing `False`, `service_running` flag, and any last event metadata) to `segmenter_status.json` using an atomic `os.replace()` call. This happens during normal shutdown after stdin drains.【F:lib/segmenter.py†L1034-L1056】
- Every status update goes through `_update_capture_status()`, which writes to a temp file and renames it so readers never see a half-written JSON blob.【F:lib/segmenter.py†L608-L708】
