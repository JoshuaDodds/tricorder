#!/usr/bin/env python3
"""
Development launcher for Tricorder.

- Stops voice-recorder.service on startup if running
- Runs live_stream_daemon in foreground
- Starts web_streamer hooked to ffmpeg stdout (after ffmpeg is ready)
- Ctrl-C exits cleanly
- Ctrl-R restarts cleanly
"""

import os
import subprocess
import sys
import termios
import tty
import threading
import time

from lib import live_stream_daemon
from lib.web_streamer import start_web_streamer_in_thread

SERVICE = "voice-recorder.service"


def stop_service():
    subprocess.run(["systemctl", "is-active", "--quiet", SERVICE])
    if sys.exc_info()[0] is None:
        print(f"[dev] Stopping {SERVICE} ...")
        subprocess.run(["systemctl", "stop", SERVICE], check=False)


class KeyWatcher(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.fd = sys.stdin.fileno()
        self.old_settings = termios.tcgetattr(self.fd)
        tty.setcbreak(self.fd)
        self.restart_requested = False
        self.stop_requested = False

    def run(self):
        try:
            while True:
                ch = os.read(self.fd, 1)
                if not ch:
                    continue
                if ch == b"\x03":  # Ctrl-C
                    self.stop_requested = True
                    break
                elif ch == b"\x12":  # Ctrl-R
                    self.restart_requested = True
                    break
        finally:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old_settings)


def wait_for_ffmpeg_stdout(timeout=5.0, poll=0.1):
    """Wait until live_stream_daemon.ffmpeg_proc is spawned and stdout available."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        stdout = live_stream_daemon.get_ffmpeg_stdout()
        if stdout is not None:
            return stdout
        time.sleep(poll)
    return None


def run_once():
    try:
        live_stream_daemon.main()
    except KeyboardInterrupt:
        pass


def main():
    stop_service()
    print("[dev] Running live_stream_daemon (Ctrl-C to exit, Ctrl-R to restart)")

    while True:
        watcher = KeyWatcher()
        watcher.start()
        try:
            # Launch the live stream daemon (spawns ffmpeg inside)
            run_once()

            # Wait for ffmpeg stdout to become available
            stdout = wait_for_ffmpeg_stdout()
            if not stdout:
                print("[dev] ERROR: ffmpeg stdout not available, cannot start web_streamer")
                return 1

            # Start web streamer once ffmpeg is ready
            web_streamer = start_web_streamer_in_thread(
                ffmpeg_stdout=stdout,
                host="0.0.0.0",
                port=8080,
                chunk_bytes=4096,
                access_log=False,
                log_level="INFO",
            )

            # Block here until watcher signals stop or restart
            while not (watcher.stop_requested or watcher.restart_requested):
                time.sleep(0.2)

        finally:
            print("[dev] Stopping web_streamer ...")
            try:
                web_streamer.stop()
            except Exception:
                pass
            # Tell daemon to exit
            live_stream_daemon.request_stop()
            termios.tcsetattr(watcher.fd, termios.TCSADRAIN, watcher.old_settings)

        if watcher.restart_requested:
            print("[dev] Restart requested via Ctrl-R")
            continue
        else:
            print("[dev] Exiting dev mode")
            break


if __name__ == "__main__":
    sys.exit(main())
