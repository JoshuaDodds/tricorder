# RMS and Motion Padding Behavior

This note captures the current behavior (and limitations) of the recorder padding knobs so we can reference it in future tuning sessions.

## RMS pre-padding (`segmenter.pre_pad_ms`)

* Audio is ingested in fixed frames of `audio.frame_ms` (20 ms by default). The pre-buffer that is flushed when an event starts retains `PRE_PAD_FRAMES = pre_pad_ms // frame_ms` frames. Because the trigger frame is already inside that deque, the amount of audio that actually precedes the trigger is `(len(prebuf) - 1) * frame_ms`.
* With 20 ms frames this means the recorded pre-roll is always `frame_ms` shorter than the configured value. Example: `pre_pad_ms=2000` → `PRE_PAD_FRAMES=100`, and `(100-1)*20 ms = 1.98 s` of audio before the trigger. The remaining frame is the trigger frame itself. This explains why clips appear to start ~20 ms earlier than expected.
* The setting does not have a hard-coded maximum, but each frame is `FRAME_BYTES = sample_rate * sample_width * frame_ms / 1000` bytes (1920 B with the defaults). Raising `pre_pad_ms` increases RAM usage linearly. Extreme values can exhaust memory and stall the recorder, so keep the setting within a few seconds unless the platform has ample headroom.

## RMS post-padding (`segmenter.post_pad_ms`)

* The tail logic keeps a countdown (`post_count`) measured in frames. Every frame where the recent activity window (`keep_window_frames`, default 30) still contains at least `keep_consecutive` active frames resets `post_count` to `post_pad_ms // frame_ms`. When the activity drops below the threshold the countdown starts and the event finalizes when it reaches zero.
* Because the window contains the most recent frames, the countdown normally begins a handful of frames after the last loud frame. With the defaults that drift is up to `(keep_window_frames - keep_consecutive + 1) * frame_ms ≈ 120 ms`, so the observed tail is at most ~0.12 s shorter than the configured post padding.

## Motion release padding (`segmenter.motion_release_padding_minutes`)

* When a motion watcher reports that motion has cleared, the segmenter records the release timestamp but keeps the recorder “forced active” until `release_epoch + padding_seconds`. While forced, every frame is treated as active (`frame_active = True`), so RMS/VAD silence does **not** end the clip prematurely.
* Once the padding window elapses the recorder reverts to the standard post-pad countdown described above. This means the total time between the motion release timestamp and the end of the clip is roughly `padding_seconds + post_pad_ms/1000`. If the countdown seems shorter, check whether the deadline was allowed to elapse (for example because the motion watcher stopped updating or the padding was 0).
* The motion metadata (`motion_released_epoch`/`motion_release_offset_seconds`) is stamped with the instant the motion subsystem reported idle. The forced-active padding does not move that timestamp, so comparing it to the clip duration can make the extra padding look “missing” even though the audio contains it.
* The web UI currently caps this setting at 30 minutes (`lib/web_streamer.py`), and the runtime stores the derived seconds value when the segmenter starts. Changes require restarting the process to take effect.

