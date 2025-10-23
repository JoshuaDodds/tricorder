#!/usr/bin/env bash
set -euo pipefail

# Restore ALSA state from project baseline
# Safe reapply for ReSpeaker 2-Mic Pi HAT v2

STATE_FILE="${STATE_FILE:-/apps/tricorder/asound.state}"
DEFAULT_FILE="${DEFAULT_STATE_FILE:-/apps/tricorder/asound.state.default}"

if [[ ! -f "$STATE_FILE" && -f "$DEFAULT_FILE" ]]; then
    echo "[restore-alsa] No state file at $STATE_FILE; seeding from default"
    cp "$DEFAULT_FILE" "$STATE_FILE"
fi

if [[ -f "$STATE_FILE" ]]; then
    echo "[restore-alsa] Restoring ALSA state from $STATE_FILE"
    /usr/sbin/alsactl --file "$STATE_FILE" restore 0
else
    echo "[restore-alsa] Warning: $STATE_FILE not found; skipping restore"
fi
