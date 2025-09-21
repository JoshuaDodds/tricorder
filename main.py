#!/usr/bin/env python3
"""
Development launcher for Tricorder.

- Stops voice-recorder.service on startup if running
- Runs live_stream_daemon in foreground
- Starts web_streamer thread hooked to ffmpeg stdout
- Ctrl-C exits cleanly
- Ctrl-R restarts the foreground daemon
"""

import os
import signal
import subprocess
import sys
import termios
import tty
import threading

from lib import live_stream_daemon
from lib.web_streamer import start_web_streamer_in_thread

SERVICE = "voice-recorder.service"


def stop_service():
    subprocess.run(["systemctl", "is-active", "--quiet", SERVICE])
    if sys.exc_info()[0] is None:  # the last command succeeded
        print(f"[dev] Stopping {SERVICE} ...")
        subprocess.run(["systemctl", "stop", SERVICE], check=False)


class KeyWatcher(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.fd = sys.stdin.fileno()
        self.old_settings = termios.tcgetattr(self.fd)
        tty.setcbreak(self.fd)
        self.restart_requested = False

    def run(self):
        try:
            while True:
                ch = os.read(self.fd, 1)
                if not ch:
                    continue
                if ch == b"\x03":  # Ctrl-C
                    os.kill(os.getpid(), signal.SIGINT)
                elif ch == b"\x12":  # Ctrl-R
                    self.restart_requested = True
                    os.kill(os.getpid(), signal.SIGTERM)
        finally:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old_settings)


def run_once():
    try:
        live_stream_daemon.main()
    except KeyboardInterrupt:
        pass


def main():
    stop_service()
    print("[dev] Running live_stream_daemon (Ctrl-C to exit, Ctrl-R to restart)")

    # Start ffmpeg encoder once, get its stdout
    live_stream_daemon.ffmpeg_proc = live_stream_daemon.spawn_ffmpeg_encoder()
    web_streamer = start_web_streamer_in_thread(
        ffmpeg_stdout=live_stream_daemon.ffmpeg_proc.stdout,
        host="0.0.0.0",
        port=8080,
        chunk_bytes=4096,
        access_log=False,
        log_level="INFO",
    )

    while True:
        watcher = KeyWatcher()
        watcher.start()
        try:
            run_once()
        finally:
            # IMPORTANT: stop the web streamer FIRST to avoid race/TTY side effects
            print("[dev] Stopping web_streamer ...")
            web_streamer.stop()
            # Always restore terminal mode after services are down
            termios.tcsetattr(watcher.fd, termios.TCSADRAIN, watcher.old_settings)

        if watcher.restart_requested:
            print("[dev] Restart requested via Ctrl-R")
            # restart ffmpeg encoder
            live_stream_daemon.ffmpeg_proc = live_stream_daemon.spawn_ffmpeg_encoder()
            web_streamer = start_web_streamer_in_thread(
                ffmpeg_stdout=live_stream_daemon.ffmpeg_proc.stdout,
                host="0.0.0.0",
                port=8080,
                chunk_bytes=4096,
                access_log=False,
                log_level="INFO",
            )
            continue
        else:
            print("[dev] Exiting dev mode")
            break


if __name__ == "__main__":
    sys.exit(main())
