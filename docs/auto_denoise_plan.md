# Auto-Denoise Feature Implementation Plan (TR-243)

## 1. Background and Goals
- **Objective:** Allow operators to denoise any selection in the clip editor timeline by pressing a single "Auto-Denoise" button.
- **Context:** The dashboard already exposes a waveform clipper (`lib/webui/static/js/dashboard/modules/clipperController.js`) that talks to the backend clip API (`lib/web_streamer.py` → `/api/recordings/clip`). We will layer denoising on top of this flow without blocking the UI.
- **Constraints:**
  - Must run on Raspberry Pi-class hardware; heavy ML models must be optional or accelerated.
  - UI must remain responsive; long-running jobs should use background executors similar to `CLIP_EXECUTOR` in `lib/web_streamer.py`.
  - Ocenaudio is proprietary (per TechRadar); we must rely on permissively licensed code.

## 2. High-Level Workflow
1. **Selection Capture:** Reuse the existing clipper state (start/end seconds, overwrite flag) to define the audio segment.
2. **User Action:** Add an `Auto-Denoise` button to the transport panel (`lib/webui/templates/dashboard.html` + `lib/webui/static/js/dashboard.js`).
3. **Request Dispatch:** The button triggers a new dashboard controller method that posts to `/api/recordings/denoise` with the recording path, segment bounds, and denoiser parameters.
4. **Backend Processing:**
   - The web backend enqueues the job on a dedicated `denoise_executor` (mirrors `CLIP_EXECUTOR`).
   - The executor invokes a Python denoiser module (new `lib/denoise/auto_denoiser.py`) to process PCM chunks and stream progress updates.
5. **Progress + Completion:**
   - Dashboard subscribes to Server-Sent Events (existing `/api/events` stream) for status updates or polls a new `/api/recordings/denoise/status` endpoint.
   - When the job finishes, the backend swaps the segment, regenerates waveforms, and emits a `recordings_changed` event.
6. **Undo Support:**
   - Backend saves the original segment (similar to `_prepare_clip_backup` for clips) so `/api/recordings/denoise/undo` can restore it.
7. **Optional Preview:**
   - If feasible, return a temporary preview clip (e.g., WAV in `/tmp`) so the UI can play it before committing.

## 3. Denoising Technology Evaluation
| Option | Description | License | Pros | Cons | Est. Runtime (30 s mono @ 48 kHz) |
| --- | --- | --- | --- | --- | --- |
| [`noisereduce`](https://github.com/timsainb/noisereduce) | Spectral gating w/ optional noise profile | BSD-3-Clause | Lightweight, pure Python, good baseline | Needs noise profile for best results, CPU only | ~3–5 s on Pi 4 (benchmark pending) |
| [`rnnoise`](https://github.com/xiph/rnnoise) via [`rnnoise-python`](https://github.com/GregorR/rnnoise-python) | RNN-based denoiser trained on voice | BSD | Real-time capable, good for speech | Requires native build, mono only | <1 s per 30 s clip |
| [`deepfilternet`](https://github.com/Rikorose/DeepFilterNet) | Deep learning denoiser | MIT | High quality, handles non-stationary noise | Heavy deps (PyTorch), may be too slow for Pi | 10–20 s with CPU (needs profiling) |
| [`spleeter`](https://github.com/deezer/spleeter) (2 stems) | Source separation to isolate voice | MIT | Separates voice/music | High memory, TensorFlow dependency | >30 s |

**Recommendation:**
- Ship `noisereduce` as default baseline (fast, pure Python).
- Offer `rnnoise` as optional accelerated path behind feature flag.
- Document how to swap algorithms (module exposes strategy registry).

### Prototype Script Tasks
1. Benchmark `noisereduce` and `rnnoise` using representative clips stored in `tests/data/`.
2. Implement CLI: `python -m lib.denoise.auto_denoiser --input demo.wav --output cleaned.wav [--noise-profile noise.wav]`.
3. Capture metrics (runtime, CPU %, memory) and store results in `docs/auto_denoise_benchmarks.md`.

## 4. API and Module Design
### 4.1 Python Module (`lib/denoise/auto_denoiser.py`)
- `class AutoDenoiser` with `process(buffer: np.ndarray, sample_rate: int, strategy: str, strength: float) -> AutoDenoiseResult`.
- Strategy registry mapping (`"noisereduce"`, `"rnnoise"`, etc.) to callable implementations.
- Streaming support: generator `iter_process(chunks)` yields progress percentages for long clips.
- Result object includes `pcm_bytes`, `peak_level`, `noise_profile_used`, `diagnostics`.

### 4.2 Backend Integration (`lib/web_streamer.py`)
- Register new aiohttp routes:
  - `POST /api/recordings/denoise`
  - `POST /api/recordings/denoise/undo`
  - `GET /api/recordings/denoise/status/{job_id}` (optional)
- Add `DENOISE_EXECUTOR_KEY` and `denoise_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="web_streamer_denoise")` inside `create_app`.
- Job payload: `{ "recording": str, "start_seconds": float, "end_seconds": float | null, "strategy": "noisereduce", "strength": 0.6 }`.
- Use existing waveform regeneration helpers after writing the processed PCM back to disk (via temporary `.wav` + `ffmpeg` encode to OPUS if needed).
- Persist undo buffers in a sibling directory to `clip_undo` (e.g., `denoise_undo`).
- Emit `recordings_changed("denoised", paths=[recording_path])` when finished.

### 4.3 Dashboard (`lib/webui/static/js/dashboard.js` + `clipperController.js`)
- Extend state machine with `denoiseBusy`, `denoiseJobId`, `denoiseUndoToken`.
- Inject button markup into `clipper-section` (transport panel) with accessible label + tooltip.
- Controller sends fetch request and listens for progress events (existing SSE channel already handles JSON payloads – add new event type `denoise_progress`).
- On completion, show toast (`commonUtils.showToast`) and refresh waveform via existing reload hooks.
- Add undo button state when `denoiseUndoToken` present; clicking posts to `/api/recordings/denoise/undo`.

## 5. Threading and Performance Considerations
- Reuse chunked reading (16-bit PCM) to limit memory footprint for long clips.
- Ensure executor max workers = 1 to avoid starving capture pipeline; optionally allow configuration in `config.yaml` under new section `denoise:`.
- Support cancellation by storing `Future` handle keyed by `job_id`; dashboard can call `DELETE /api/recordings/denoise/{job_id}` to abort.
- For stereo files, process channels independently or convert to mono before denoising + reapply stereo image.

## 6. Undo / Redo Strategy
- Mirror `_prepare_clip_backup` to stash original segment (WAV + waveform JSON) before overwriting.
- Store metadata (sample rate, channels, bit depth) to ensure accurate restore.
- Integrate with dashboard undo queue: map recording path → undo token so `clipperController.handleUndo` can branch when a denoise token is active.

## 7. Testing Plan
- **Unit Tests:**
  - Add `tests/test_denoiser.py` covering algorithm selection, PCM round-trip, and failure handling.
  - Mock executor path to ensure `/api/recordings/denoise` enqueues jobs and returns 202 with job id.
- **Integration Tests:**
  - Extend `tests/test_37_web_dashboard.py` to assert button rendering and progress UI toggles.
  - Add new API tests for undo flow and SSE progress messages.
- **Performance Tests:**
  - Scripted benchmarks using `pytest -k denoise` to validate runtime < 2× clip duration on Pi 4.

## 8. Deployment & Packaging
- Update `requirements.txt` and `requirements-dev.txt` with chosen libraries.
- Document optional dependencies in `README.md` + `config.yaml` (new `denoise.strategy` and `denoise.enabled`).
- Provide `install.sh` guard to install native libs (`libav`, `rnnoise`) when optional features enabled.
- For packaged builds, include Python wheel or instructions for cross-compiling `rnnoise`.

## 9. Rollout & Monitoring
- Hide feature behind `config["dashboard"]["enable_auto_denoise"]` until stable.
- Log telemetry in `web_streamer.py` (duration, strategy, success/failure) for observability.
- Add health check endpoint `/healthz?denoise=1` to confirm executor idle status (optional).

## 10. Handoff Checklist
1. Finalize algorithm choice + thresholds (TR-243 owner).
2. Implement Python module + unit tests.
3. Wire backend API routes + executor management.
4. Update dashboard UI and progress UX.
5. Author documentation updates (README, config comments, troubleshooting).
6. Run `export DEV=1; pytest -q` and manual smoke test (denoise small + large clip, undo, preview if implemented).
7. Provide performance report + deployment notes.

## 11. Open Questions for Follow-Up
- Do we allow the user to capture a custom noise profile, or always run blind denoising?
- Should intensity/strength be exposed as a slider or stay fixed?
- How do we handle multi-channel (surround) sources—downmix + replicate or process per channel?
- What is the acceptable maximum job duration before we prompt the user to background the task?
- Do we retain a history of denoise passes per clip for multi-step undo?

## 12. Suggested Timeline
| Week | Deliverable |
| --- | --- |
| 1 | Algorithm spike + benchmark report, choose default strategy |
| 2 | Backend module + API skeleton landed behind feature flag |
| 3 | Dashboard integration, progress UX, undo wiring |
| 4 | Documentation, manual QA, rollout toggle enabled |

---
**Next Steps:** Proceed with algorithm prototyping (`lib/denoise/auto_denoiser.py`) and coordinate with design for button placement + copy.
