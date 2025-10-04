#!/usr/bin/env python3
"""
Development launcher for Tricorder.

- Stops voice-recorder.service on startup if running
- Runs live_stream_daemon in foreground
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


def _start_dev_web_streamer() -> "WebStreamerHandle":
    """Start the dashboard web streamer with the dev launcher defaults."""

    return start_web_streamer_in_thread(
        host="0.0.0.0",
        port=8080,
        access_log=False,
        log_level="INFO",
    )


def main():
    stop_service()
    print("[dev] Running live_stream_daemon (Ctrl-C to exit, Ctrl-R to restart)")

    web_streamer = _start_dev_web_streamer()

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
            web_streamer = _start_dev_web_streamer()
            continue
        else:
            print("[dev] Exiting dev mode")
            break


if __name__ == "__main__":
    sys.exit(main())
