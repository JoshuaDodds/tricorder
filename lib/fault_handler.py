#!/usr/bin/env python3
import os
import sys
import json
import time
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Tuple

BASE = Path("/apps/tricorder")
TMP_DIR = BASE / "tmp"
REC_DIR = BASE / "recordings"
DROPBOX_DIR = BASE / "dropbox"

JOURNAL_TAG = "tricorder"  # shows as the syslog tag in journald

def _log(msg: str):
    """Log to journald if available; otherwise print to stdout."""
    try:
        subprocess.run(
            ["systemd-cat", "-t", JOURNAL_TAG],
            input=msg.encode("utf-8"),
            check=False,
        )
    except FileNotFoundError:
        # Fallback if systemd-cat is unavailable (e.g., during local dev)
        print(f"[{JOURNAL_TAG}] {msg}", flush=True)


# ---------- USB Reset Handling ----------

def reset_usb() -> bool:
    """
    Reset the DWC2 USB controller (Raspberry Pi Zero).
    Returns True if both unbind/bind commands executed without raising.
    """
    ctrl = "3f980000.usb"  # DWC2 controller on Pi Zero
    try:
        _log("[fault] attempting USB controller reset (dwc2)")
        # Unbind
        subprocess.run(
            ["sh", "-c", f"echo -n '{ctrl}' > /sys/bus/platform/drivers/dwc2/unbind"],
            check=True,
        )
        time.sleep(1)
        # Bind
        subprocess.run(
            ["sh", "-c", f"echo -n '{ctrl}' > /sys/bus/platform/drivers/dwc2/bind"],
            check=True,
        )
        _log("[fault] USB reset complete")
        return True
    except Exception as e:
        _log(f"[fault] USB reset failed: {e!r}")
        return False


# ---------- Encode Failure Handling ----------

def _ffmpeg_probe_decodable(wav_path: Path) -> Tuple[bool, str]:
    """
    Use ffmpeg to probe whether the WAV decodes cleanly.
    Returns (is_decodable, stderr_text).
    """
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-v", "error",
                "-i", str(wav_path),
                "-f", "null",
                "-"  # write decoded output to null sink
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        # ffmpeg returns 0 when decode succeeded
        return proc.returncode == 0, (proc.stderr or "").strip()
    except FileNotFoundError:
        return False, "ffmpeg not found"
    except Exception as e:
        return False, f"probe error: {e!r}"


def _day_dir(base_dir: Path) -> Path:
    return base_dir / time.strftime("%Y%m%d")


def _write_corrupted_placeholder(base_name: str, reason: str, extra: dict | None = None) -> Path:
    """
    Write a JSON placeholder to recordings to indicate a corrupted/unusable event.
    Filename: <base_name>-CORRUPTED_RECORDING.json in the day directory.
    """
    day_dir = _day_dir(REC_DIR)
    day_dir.mkdir(parents=True, exist_ok=True)
    out = day_dir / f"{base_name}-CORRUPTED_RECORDING.json"

    payload = {
        "status": "corrupted",
        "base_name": base_name,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reason": reason,
    }
    if extra:
        payload.update(extra)

    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"[fault] wrote corrupted placeholder: {out.name} (reason: {reason})")
    return out


def _safe_requeue_to_dropbox(wav_path: Path, base_name: str) -> Path:
    """
    Move a valid WAV into /dropbox for re-processing by the ingestion pipeline.
    To avoid retry loops, append '-RETRY' once; if already present, we consider it final.
    """
    DROPBOX_DIR.mkdir(parents=True, exist_ok=True)

    if base_name.endswith("-RETRY"):
        # Already retried once; don't requeue again.
        raise RuntimeError("already retried once")

    target_name = f"{base_name}-RETRY.wav"
    target_path = DROPBOX_DIR / target_name

    # Use atomic move when possible
    wav_path.replace(target_path)
    _log(f"[fault] requeued WAV to dropbox: {target_path.name}")
    return target_path


def handle_encode_failure(in_wav: str, base_name: str) -> int:
    """
    Main entrypoint for encode failure handling.
    - If WAV decodes: move to /dropbox as '<base>-RETRY.wav' (one-time).
    - If WAV corrupt or already retried: write JSON placeholder, remove WAV.
    Returns shell-friendly exit code (0 success path / 1 handled-but-bad / 2 unexpected).
    """
    wav_path = Path(in_wav)

    if not wav_path.exists():
        _log(f"[fault] encode_failure: missing WAV ({in_wav}); nothing to do")
        return 1

    is_ok, probe_msg = _ffmpeg_probe_decodable(wav_path)

    if is_ok and not base_name.endswith("-RETRY"):
        try:
            _safe_requeue_to_dropbox(wav_path, base_name)
            # NOTE: do NOT write placeholder; the requeue path will regenerate an .opus
            return 0
        except Exception as e:
            # If requeue fails for any reason, fall through to marking corrupted
            probe_msg = f"requeue failed: {e!r}"

    # Corrupted or already retried → mark as corrupted and remove WAV
    try:
        size = wav_path.stat().st_size
    except Exception:
        size = None

    _write_corrupted_placeholder(
        base_name,
        reason="decode-failed" if is_ok is False else "retry-exhausted",
        extra={"probe": probe_msg, "size_bytes": size},
    )

    try:
        wav_path.unlink(missing_ok=True)
    except Exception as e:
        _log(f"[fault] failed to remove tmp WAV ({wav_path}): {e!r}")

    return 1


# ---------- CLI ----------

def _usage() -> int:
    sys.stderr.write(
        "usage:\n"
        "  fault_handler.py usb_reset\n"
        "  fault_handler.py encode_failure <in_wav> <base_name>\n"
    )
    return 2


def main(argv: list[str]) -> int:
    if not argv:
        return _usage()

    cmd = argv[0]
    if cmd == "usb_reset":
        ok = reset_usb()
        return 0 if ok else 1

    if cmd == "encode_failure":
        if len(argv) != 3:
            return _usage()
        in_wav, base = argv[1], argv[2]
        return handle_encode_failure(in_wav, base)

    return _usage()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
