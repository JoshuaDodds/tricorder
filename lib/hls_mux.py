#!/usr/bin/env python3
"""
HLSTee: feeds raw PCM into an ffmpeg HLS encoder.

- Accepts PCM frames (S16_LE) via feed()
- Runs ffmpeg in background to produce HLS playlist + .ts segments
- Directory is self-pruning via -hls_flags delete_segments

Intended to be run in parallel with WebStreamTee + TimelineRecorder.
"""

import os
import threading
import queue
import subprocess
import logging
import shutil
from typing import Optional, List


class HLSTee:
    def __init__(
        self,
        out_dir: str,
        sample_rate: int,
        channels: int = 1,
        bits_per_sample: int = 16,
        segment_time: float = 2.0,
        history_seconds: int = 60,
        bitrate: str = "64k",
        log_level: int = logging.INFO,
        extra_ffmpeg_args: Optional[List[str]] = None,
    ):
        assert bits_per_sample == 16, "S16_LE expected"
        self.out_dir = out_dir
        self.sr = sample_rate
        self.ch = channels
        self.bps = bits_per_sample
        self.seg_time = float(segment_time)
        self.hist = int(history_seconds)
        self.bitrate = bitrate
        self.extra = extra_ffmpeg_args or []

        self._log = logging.getLogger("hls_mux")
        self._log.setLevel(log_level)

        self._q: "queue.Queue[bytes]" = queue.Queue(maxsize=64)
        self._t: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._proc: Optional[subprocess.Popen] = None

        os.makedirs(self.out_dir, exist_ok=True)

    def start(self):
        if self._t is not None:
            return
        if not shutil.which("ffmpeg"):
            self._log.error("ffmpeg not found in PATH")
            return
        # Ensure the stop event from any prior run doesn't immediately halt the
        # new thread. `stop()` leaves `_stop` set; clear it before spawning
        # another worker so `_run()` can proceed normally.
        self._stop.clear()
        # clean stale files
        for fn in os.listdir(self.out_dir):
            if fn.endswith((".m3u8", ".ts")):
                try:
                    os.remove(os.path.join(self.out_dir, fn))
                except Exception:
                    pass
        self._t = threading.Thread(target=self._run, name="hls_mux", daemon=True)
        self._t.start()
        self._log.info("HLSTee started at %s", self.out_dir)

    # Replace only the stop() method — everything else stays as-is.

    # Replace only the stop() method — everything else stays as-is.

    def stop(self):
        """
        Request the background thread to stop, then shut down ffmpeg robustly.
        - Close stdin to signal EOF.
        - SIGTERM with timeout; if still alive, SIGKILL with explicit error logging.
        - Always log the final return code or any exceptions for diagnostics.
        """
        self._stop.set()
        if self._t:
            self._t.join(timeout=2.0)
        self._t = None

        # Work on a local ref in case _run() respawns while we're stopping.
        proc = self._proc
        self._proc = None

        if not proc:
            self._log.info("HLSTee stopped (no ffmpeg process)")
            return

        # Best-effort: close ffmpeg stdin so it can exit cleanly.
        try:
            if proc.stdin:
                try:
                    proc.stdin.flush()
                except Exception as e:
                    self._log.debug("ffmpeg stdin flush error: %r", e)
                try:
                    proc.stdin.close()
                except Exception as e:
                    self._log.debug("ffmpeg stdin close error: %r", e)
        except Exception as e:
            self._log.debug("ffmpeg stdin handling error: %r", e)

        rc = proc.poll()
        if rc is None:
            # Try graceful terminate first.
            try:
                proc.terminate()
                try:
                    rc = proc.wait(timeout=1.5)
                    self._log.info("ffmpeg terminated with rc=%s", rc)
                except subprocess.TimeoutExpired:
                    self._log.warning("ffmpeg did not exit after SIGTERM; sending SIGKILL")
                    try:
                        proc.kill()
                    except Exception as e:
                        # Explicitly log kill() failure — do not swallow this.
                        self._log.exception("ffmpeg kill() raised; process may remain: %r", e)
                    else:
                        try:
                            rc = proc.wait(timeout=1.0)
                            self._log.info("ffmpeg killed; rc=%s", rc)
                        except subprocess.TimeoutExpired:
                            # Extremely rare: kernel hasn't reaped yet or proc is unkillable (D state)
                            self._log.error("ffmpeg still not reaped after SIGKILL; zombie risk")
            except Exception as e:
                self._log.exception("Error during ffmpeg termination: %r", e)
        else:
            self._log.info("ffmpeg already exited rc=%s", rc)

        self._log.info("HLSTee stopped")

    def feed(self, pcm_bytes: bytes):
        if self._t is None:
            return
        try:
            self._q.put_nowait(pcm_bytes)
        except queue.Full:
            try:
                _ = self._q.get_nowait()
            except Exception:
                pass
            try:
                self._q.put_nowait(pcm_bytes)
            except Exception:
                pass

    def _spawn_ffmpeg(self) -> subprocess.Popen:
        target_duration = max(1.0, self.seg_time)
        list_size = max(1, int(self.hist / target_duration))

        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-f", "s16le",
            "-ar", str(self.sr),
            "-ac", str(self.ch),
            "-i", "pipe:0",
            "-c:a", "aac",
            "-b:a", self.bitrate,
            "-profile:a", "aac_low",
            "-vn",
            "-f", "hls",
            "-hls_time", str(target_duration),
            "-hls_list_size", str(list_size),
            "-hls_flags", "delete_segments+append_list+omit_endlist",
            "-hls_segment_type", "mpegts",
            "-hls_segment_filename", os.path.join(self.out_dir, "seg%05d.ts"),
            os.path.join(self.out_dir, "live.m3u8"),
        ]
        if self.extra:
            cmd.extend(self.extra)

        self._log.info("Launching ffmpeg: %s", " ".join(cmd))
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=True,
        )
        return proc

    def _run(self):
        self._proc = self._spawn_ffmpeg()
        pin = self._proc.stdin
        assert pin is not None

        try:
            while not self._stop.is_set():
                try:
                    chunk = self._q.get(timeout=0.05)
                except queue.Empty:
                    if self._proc.poll() is not None:
                        self._log.warning("ffmpeg exited (%s); respawning", self._proc.returncode)
                        self._proc = self._spawn_ffmpeg()
                        pin = self._proc.stdin
                    continue

                try:
                    pin.write(chunk)
                except (BrokenPipeError, OSError):
                    self._log.warning("ffmpeg pipe broken; respawning")
                    try:
                        self._proc.kill()
                    except Exception as e:
                        self._log.exception("Error killing ffmpeg after pipe break: %r", e)
                    self._proc = self._spawn_ffmpeg()
                    pin = self._proc.stdin
        finally:
            # Cleanup stdin if possible
            try:
                if pin:
                    pin.close()
            except Exception:
                pass

