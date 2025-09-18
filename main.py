#!/usr/bin/env python3
import subprocess
import sys
import threading
import time
import termios
import tty
import os

from lib import live_stream_daemon


def stop_service():
    print("[dev] Stopping voice-recorder.service ...")
    subprocess.run(["systemctl", "stop", "voice-recorder.service"], check=False)


def start_service():
    print("[dev] Starting voice-recorder.service ...")
    subprocess.run(["systemctl", "start", "voice-recorder.service"], check=False)


def restart_service():
    print("[dev] Restarting voice-recorder.service ...")
    subprocess.run(["systemctl", "restart", "voice-recorder.service"], check=False)


def monitor_keys():
    """Thread to monitor single keypresses (non-blocking)."""
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    tty.setcbreak(fd)
    try:
        while True:
            ch = os.read(fd, 1).decode(errors="ignore")
            if ch == "\x03":  # Ctrl+C
                print("\n[dev] Ctrl+C detected, stopping foreground run...")
                os._exit(0) # noqa
            elif ch == "\x1b":  # ESC sequence start
                seq = os.read(fd, 2).decode(errors="ignore")
                if seq == "[15":  # Some terminals send ESC[15~ for F5
                    restart_service()
                elif seq == "[17":  # ESC[17~ is F6 (optional fallback)
                    restart_service()
            elif ch.lower() == "r":  # Fallback: 'r' key to restart
                restart_service()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def main():
    stop_service()

    # Start key monitoring in a background thread
    t = threading.Thread(target=monitor_keys, daemon=True)
    t.start()

    print("[dev] Running live_stream_daemon in foreground (Ctrl+C to exit, F5 or 'r' to restart service)...")
    try:
        live_stream_daemon.main()
    except KeyboardInterrupt:
        print("\n[dev] Interrupted, shutting down...")
    finally:
        start_service()


if __name__ == "__main__":
    sys.exit(main())
