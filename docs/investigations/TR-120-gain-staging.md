# TR-120 – Audio gain staging investigation

## Summary
- Live streaming audio now publishes the same gain-processed frames that `TimelineRecorder.ingest()` returns, so the web/HLS feed reflects the configured software multiplier just like stored recordings.
- Event recordings (WAV + partial Opus) pass through the configured `audio.gain` multiplier (default 2.5×) before they are written to disk or piped to `ffmpeg`, and those same frames are shared with the live stream publisher.
- The WAV→Opus encode path does not inject additional amplification; it only re-encodes the already gained PCM with optional denoise filters.

## Capture → live stream / WAV pipeline
1. `arecord` captures 16-bit mono PCM and feeds it into the live loop. 【F:lib/live_stream_daemon.py†L44-L70】【F:lib/live_stream_daemon.py†L182-L191】
2. Each frame passes through the optional `AudioFilterChain` before being provided to `TimelineRecorder.ingest()`. 【F:lib/live_stream_daemon.py†L442-L457】【F:lib/live_stream_daemon.py†L514-L553】
3. `TimelineRecorder.ingest()` applies the configured software gain (`audio.gain`, default 2.5) and returns the adjusted frame, which is now both queued for recording and published to the live stream. 【F:config.yaml†L17-L19】【F:lib/segmenter.py†L388-L394】【F:lib/segmenter.py†L2533-L2899】【F:lib/live_stream_daemon.py†L500-L537】
4. The gained frames are queued to the WAV writer and (when enabled) to the streaming/parallel Opus encoders and live waveform generator. 【F:lib/segmenter.py†L2723-L2812】

## WAV → Opus encoding pipeline
1. `encode_and_store.sh` receives the temporary WAV and runs `ffmpeg` with mono, 48 kHz, 16-bit input assumptions. Optional denoise filters may apply, but no gain/volume filter is configured. 【F:bin/encode_and_store.sh†L1-L112】【F:bin/encode_and_store.sh†L200-L257】
2. The script reuses the Opus produced by the streaming encoder when available; otherwise, it encodes the WAV using `libopus` without altering amplitude. 【F:bin/encode_and_store.sh†L200-L257】

## Findings
- The only deterministic gain stage in the capture→WAV path is the software multiplier (`audio.gain`), currently set to 2.5× by default, and it now applies uniformly to the live stream and stored recordings.
- Prior to the TR-120 fix, the live stream bypassed this multiplier, which made recordings ~8 dB hotter than the live feed (20·log10(2.5) ≈ +7.96 dB).
- No additional gain is applied during `ffmpeg` encoding; any perceived boost relative to the live stream originates from the pre-encode scaling.

## Potential next steps
- Monitor loudness parity in QA builds to confirm the live stream continues to mirror recording gain.
- Consider exposing independent gain controls if future requirements call for different live vs recorded loudness.
