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

    RESTORE_CARD="${ALSA_RESTORE_CARD:-}" 
    if [[ -z "$RESTORE_CARD" ]]; then
        RESTORE_CARD=$(awk '/^state\./ { sub(/^state\./, "", $1); gsub(/[{}]/, "", $1); print $1; exit }' "$STATE_FILE" || true)
    fi

    if [[ -n "${RESTORE_CARD:-}" ]]; then
        echo "[restore-alsa] Applying snapshot to card '$RESTORE_CARD'"
        /usr/sbin/alsactl --file "$STATE_FILE" restore "$RESTORE_CARD"
    else
        echo "[restore-alsa] Applying snapshot with autodetected card"
        /usr/sbin/alsactl --file "$STATE_FILE" restore
    fi
else
    echo "[restore-alsa] Warning: $STATE_FILE not found; skipping restore"
fi
