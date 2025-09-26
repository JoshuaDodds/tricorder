#!/usr/bin/env python3
"""SD card health monitor service.

This module is intended to run under systemd. It periodically scans the system
journal for kernel/storage errors and persists a warning flag through
``lib.sd_card_health``. The warning remains active until the SD card's CID
changes, indicating the card has been replaced.
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import threading
import time
import re
from pathlib import Path
from typing import Iterable, List

from lib import sd_card_health


class SdCardMonitor:
    """Background monitor that inspects system logs for SD card faults."""

    JOURNAL_BASE = [
        "journalctl",
        "--system",
        "--no-pager",
        "--output=cat",
        "--quiet",
        "--priority=3",
    ]

    PATTERNS: List[tuple[str, re.Pattern[str]]] = [
        ("io_error", re.compile(r"\bio error\b", re.IGNORECASE)),
        ("crc_error", re.compile(r"\bcrc\b.*\berror\b", re.IGNORECASE)),
        (
            "readonly_remount",
            re.compile(r"\b(remount|mounting).*read-?only\b|\bread-?only\b.*remount", re.IGNORECASE),
        ),
    ]

    def __init__(
        self,
        poll_interval: float = 30.0,
        since_slack: float = 2.0,
        state_path: Path | None = None,
        cid_path: Path | None = None,
        volatile_state_path: Path | None = None,
    ) -> None:
        self.poll_interval = max(5.0, float(poll_interval))
        self.since_slack = max(0.0, float(since_slack))
        self.state_path = Path(state_path) if state_path else sd_card_health.STATE_PATH
        self.cid_path = Path(cid_path) if cid_path else sd_card_health.CID_PATH
        self.volatile_state_path = (
            Path(volatile_state_path)
            if volatile_state_path
            else sd_card_health.VOLATILE_STATE_PATH
        )
        self.stop_event = threading.Event()
        self._last_checked: float | None = None
        self._journal_available = True
        self._cid_missing_logged = False
        self._volatile_active = False

    def _log(self, message: str) -> None:
        print(f"[sd-card-monitor] {message}", flush=True)

    def _read_cid(self) -> str | None:
        try:
            text = self.cid_path.read_text(encoding="utf-8", errors="ignore")
        except FileNotFoundError:
            self._log(f"CID path missing: {self.cid_path}")
            return None
        except OSError as exc:
            self._log(f"Failed to read CID: {exc}")
            return None
        cid = text.strip()
        return cid or None

    def _clear_volatile_state(self) -> None:
        if not self.volatile_state_path:
            self._volatile_active = False
            return
        if self.volatile_state_path == self.state_path:
            self._volatile_active = False
            return
        try:
            self.volatile_state_path.unlink()
        except FileNotFoundError:
            self._volatile_active = False
            return
        except OSError as exc:
            self._log(f"Unable to remove volatile SD card state: {exc}")
        else:
            self._log("Cleared volatile SD card warning cache")
        finally:
            self._volatile_active = False

    def _migrate_volatile_state(self) -> None:
        if not self._volatile_active:
            return
        if not self.volatile_state_path or self.volatile_state_path == self.state_path:
            self._volatile_active = False
            return
        if not self.volatile_state_path.exists():
            self._volatile_active = False
            return

        state = sd_card_health.load_state(
            state_path=self.volatile_state_path,
            fallback_path=self.volatile_state_path,
        )
        try:
            sd_card_health.write_state(state, self.state_path)
        except OSError as exc:
            self._log(f"Failed to migrate volatile SD card state: {exc}")
            return
        self._clear_volatile_state()

    def _sync_cid(self) -> None:
        cid = self._read_cid()
        try:
            result = sd_card_health.sync_cid(cid, self.state_path)
        except OSError as exc:
            self._log(
                "Failed to persist SD card CID baseline: "
                f"{exc}; using volatile cache"
            )
            try:
                result = sd_card_health.sync_cid(cid, self.volatile_state_path)
            except OSError as fallback_exc:
                self._log(
                    "Unable to persist SD card CID baseline in volatile cache: "
                    f"{fallback_exc}"
                )
                self._volatile_active = True
                return
            self._volatile_active = True
        else:
            if self._volatile_active:
                self._migrate_volatile_state()
        if result.status == "missing":
            if not self._cid_missing_logged:
                self._log("Unable to read SD card CID; monitoring continues")
                self._cid_missing_logged = True
        elif result.status == "initialised":
            self._cid_missing_logged = False
            self._log("Stored SD card CID baseline")
        elif result.status == "replaced":
            self._cid_missing_logged = False
            self._log("Detected SD card replacement; warning state cleared")
            if self._volatile_active:
                self._clear_volatile_state()
        else:
            self._cid_missing_logged = False
            self._log("CID baseline verified")

    def _execute_journal(self, since: float | str | None) -> Iterable[str]:
        if not self._journal_available:
            return []

        args = list(self.JOURNAL_BASE)
        if since == "boot":
            args.extend(["--since", "boot"])
        elif isinstance(since, (int, float)):
            threshold = max(0.0, since - self.since_slack)
            args.extend(["--since", f"@{threshold:.0f}"])
        else:
            args.extend(["--since", "now"])

        try:
            proc = subprocess.run(
                args,
                capture_output=True,
                text=True,
                check=False,
                timeout=25,
            )
        except FileNotFoundError:
            self._journal_available = False
            self._log("journalctl not found; SD card monitoring disabled")
            return []
        except subprocess.SubprocessError as exc:
            self._log(f"journalctl invocation failed: {exc}")
            return []

        if proc.returncode not in (0, 1):
            stderr = (proc.stderr or "").strip()
            self._log(f"journalctl returned {proc.returncode}: {stderr}")
            return []

        return (line for line in (proc.stdout or "").splitlines() if line.strip())

    def _scan_logs(self, initial: bool = False) -> None:
        if initial or self._last_checked is None:
            since: float | str | None = "boot"
        else:
            since = self._last_checked

        lines = self._execute_journal(since)
        matched = False
        for line in lines:
            if self._process_line(line):
                matched = True

        now = time.time()
        self._last_checked = now
        if matched:
            self._log("Warning flag asserted from log scan")

    def _process_line(self, line: str) -> bool:
        for pattern_name, regex in self.PATTERNS:
            if regex.search(line):
                try:
                    _, changed = sd_card_health.register_failure(
                        message=line,
                        pattern=pattern_name,
                        state_path=self.state_path,
                    )
                except OSError as exc:
                    self._log(
                        "Failed to persist SD card warning: "
                        f"{exc}; using volatile cache"
                    )
                    try:
                        _, changed = sd_card_health.register_failure(
                            message=line,
                            pattern=pattern_name,
                            state_path=self.volatile_state_path,
                        )
                    except OSError as volatile_exc:
                        self._log(
                            "Unable to persist SD card warning in volatile cache: "
                            f"{volatile_exc}"
                        )
                        self._volatile_active = True
                        return False
                    self._volatile_active = True
                    if changed:
                        self._log(
                            "Recorded SD card warning "
                            f"({pattern_name}) via volatile cache"
                        )
                    return changed
                else:
                    if self._volatile_active:
                        self._clear_volatile_state()
                    if changed:
                        self._log(f"Recorded SD card warning ({pattern_name})")
                    return changed
        return False

    def _handle_signal(self, signum: int, _: object) -> None:
        self._log(f"Received signal {signum}; shutting down")
        self.stop_event.set()

    def run(self) -> int:
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, self._handle_signal)
            except Exception:
                # Signal registration can fail in non-main threads/tests.
                pass

        self._log("Starting SD card monitor")
        self._sync_cid()
        self._scan_logs(initial=True)

        while not self.stop_event.wait(self.poll_interval):
            self._sync_cid()
            self._scan_logs()

        self._log("Monitor exiting")
        return 0


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SD card health monitor")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=30.0,
        help="Polling interval in seconds (default: 30)",
    )
    parser.add_argument(
        "--state-path",
        type=Path,
        default=sd_card_health.STATE_PATH,
        help="Override path to sd_card_health.json",
    )
    parser.add_argument(
        "--cid-path",
        type=Path,
        default=sd_card_health.CID_PATH,
        help="Override CID sysfs path",
    )
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    monitor = SdCardMonitor(
        poll_interval=args.poll_interval,
        state_path=args.state_path,
        cid_path=args.cid_path,
    )
    return monitor.run()


if __name__ == "__main__":  # pragma: no cover - manual execution path
    raise SystemExit(main())
