#!/bin/bash
# Restore ALSA state from project baseline
# Safe reapply for ReSpeaker 2-Mic Pi HAT v2

STATE_FILE="/apps/tricorder/asound.state"

if [ -f "$STATE_FILE" ]; then
    echo "Restoring ALSA state from $STATE_FILE"
    /usr/sbin/alsactl --file "$STATE_FILE" restore 0
else
    echo "Warning: $STATE_FILE not found; skipping restore"
fi
