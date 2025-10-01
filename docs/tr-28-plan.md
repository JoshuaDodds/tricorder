# TR-28 Streaming Opus Encoding Plan

## Current pipeline baseline
- `TimelineRecorder` writes each detected event to a temporary WAV in tmpfs via `_WriterWorker`, then enqueues a post-event job for the encoder queue only after the recorder closes the file.【F:lib/segmenter.py†L272-L295】【F:lib/segmenter.py†L1178-L1206】
- The encode worker runs `bin/encode_and_store.sh` to convert the WAV to Opus with a single-threaded `ffmpeg` invocation, then generates waveform, transcription, and archival artefacts before deleting the source WAV.【F:bin/encode_and_store.sh†L1-L73】
- Recordings listed in the dashboard come exclusively from fully materialised files with finished waveform sidecars, so in-progress captures never surface in the UI aside from the transient “Current Recording” banner.【F:lib/web_streamer.py†L1435-L1506】【F:lib/webui/static/js/dashboard.js†L1740-L1838】

## Feasibility on target hardware
- The existing encode script already proves libopus is viable on the Pi Zero 2 W when throttled to one thread; real-time encoding simply overlaps this work with capture instead of running afterward.【F:bin/encode_and_store.sh†L36-L47】
- `ffmpeg` can emit streaming-friendly Ogg/Opus by writing directly to the target file while data arrives over stdin. Every 2 kB page carries headers that make partially written files playable in most browsers, so long as the process is not abruptly terminated.
- Simultaneously writing the WAV (for waveform/transcription) and an Opus stream increases IO by ~2× but both files live in tmpfs until post-processing. The recorder already buffers per-frame data in memory, so duplicating writes via an additional queue should stay within RAM/disk budgets.
- Open questions for validation on-device:
  1. Measure CPU headroom when encoding and waveform/transcription run concurrently; confirm scheduler latency stays <20 ms.
  2. Confirm browsers can play a growing `.opus` written by `ffmpeg` without explicit end-of-stream markers.
  3. Verify tmpfs has enough space for the simultaneous WAV + partial Ogg (roughly 2× raw audio) during longest expected events.

## Proposed architecture changes
1. **Introduce a streaming encoder helper**
   - Add a `StreamingOpusEncoder` helper that starts an `ffmpeg` process (`-f s16le -ac 1 -ar 48000 -c:a libopus -f opus`) with stdin fed from a thread-safe queue and stdout directed straight to the recordings directory using a `.partial.opus` suffix.
   - Feed the pre-roll frames to this helper immediately after event start, then pipe live frames as they arrive. Mirror the writer’s lifecycle: open on start, feed bytes, close stdin on finalize, wait for process exit.
   - Surface current byte count by stat-ing the partial file so the dashboard can display a live size estimate in `segmenter_status.json`.

2. **Keep the existing WAV + offline pipeline for sidecars**
   - Continue writing the WAV so waveform/transcription modules operate unchanged. When the streaming encoder finishes, reuse the existing encode script for waveform+transcript only (skip Opus encode) or refactor those steps into a Python helper that ingests the still-available WAV.
   - If the streaming encoder fails, fall back to the current enqueue-once-finished flow to avoid data loss.

3. **Update recorder status and lifecycle**
   - Extend `_update_capture_status` to include the partial recording path, byte count, and an `in_progress` flag. While the stream is active, publish `event_size_bytes` from the live Opus file.【F:lib/segmenter.py†L1072-L1159】
   - When encoding completes, atomically rename `<name>.partial.opus` to `<name>.opus`, trigger waveform+transcript generation if not already run, and enqueue archival as today.
   - Ensure `_reset_event_state` tears down both the writer and streaming encoder even on errors, and that shutdown waits for stdin close to prevent corrupt containers.【F:lib/segmenter.py†L1240-L1260】

4. **Expose in-progress recordings to the dashboard**
   - Enhance `/api/status` to surface the active event (path, duration, size) so the UI can render it in the recordings list with a red badge until `in_progress` clears.【F:lib/web_streamer.py†L2798-L3185】
   - Teach the UI to insert/update a placeholder row representing the partial file, pointing the audio player at `/recordings/<day>/<file>.partial.opus`. Highlight it in red while `in_progress=true`, then swap to the final `.opus` entry once rename completes.【F:lib/webui/static/js/dashboard.js†L5710-L5713】【F:lib/webui/static/js/dashboard.js†L1740-L1985】
   - Adjust download/cleanup handlers to treat `.partial.opus` as read-only (no delete) until finalised, and hide it from ingestion/backfill jobs by extending ignore lists.【F:lib/web_streamer.py†L1435-L1506】

5. **Add configurability and fallbacks**
   - Provide a config flag (e.g., `segmenter.streaming_encode`) defaulting to disabled until validated in field deployments. When disabled, retain the current post-event encode queue.
   - Allow switching the streaming container to WebM/Opus (`-f webm`) if Ogg playback proves unreliable on certain clients; share the same helper infrastructure.

6. **Testing and validation plan**
   - Unit-test the `StreamingOpusEncoder` with fake ffmpeg (e.g., `cat`) to ensure lifecycle management (start, feed, close, error) works deterministically.
   - Extend integration tests to simulate a running event, verifying the status endpoint emits the in-progress metadata and the dashboard logic renders/removes the placeholder item.
   - On hardware, capture long events to confirm no underruns, and verify playback of the partial file via the dashboard during recording.
   - Stress-test error paths by killing `ffmpeg` mid-stream and ensuring the system falls back to the offline encode queue without leaking tmpfs files.

## Open risks and mitigations
- **CPU spikes**: Real-time libopus plus waveform/transcription might saturate the CPU. Gate streaming encode behind a config flag and add runtime telemetry to disable it automatically if the encoder misses deadlines.
- **Container corruption**: If power loss occurs mid-write, partial Ogg may be unreadable. Maintain the WAV until archival completes so clips can be regenerated offline, and add a boot-time cleaner that removes stale `.partial.opus` files after verification.
- **UI consistency**: The dashboard currently assumes every listed file has a waveform. Provide a fallback renderer for in-progress items that hides waveform/clip actions until the final artefacts exist, preventing JS errors.

## Next steps
1. Prototype the streaming helper with `ffmpeg` on the device, validating CPU usage and playback of a growing file.
2. Add the helper and status plumbing under a feature flag, keeping the existing encode queue as fallback.
3. Update UI and API surfaces to visualise in-progress events, then iterate on UX (red indicator) with stakeholders.
4. Once stable, enable by default and remove the redundant post-event Opus encode to reclaim the extra CPU window.
