#!/usr/bin/env bash
set -euo pipefail

BASE="/apps/tricorder"
VENV="$BASE/venv"
SYSTEMD_DIR="/etc/systemd/system"

UNITS=(voice-recorder.service dropbox.service dropbox.path tmpfs-guard.service tmpfs-guard.timer)

say(){ echo "[Tricorder] $*"; }

# ---------- uninstall ----------
if [[ "${1:-}" == "--remove" ]]; then
  echo "[Tricorder] Uninstall requested"

  # Stop and disable services/paths/timers if they exist
  for unit in voice-recorder.service dropbox.service dropbox.path tmpfs-guard.service tmpfs-guard.timer; do
    echo "[Tricorder] Disabling and stopping $unit"
    systemctl disable --now "$unit" 2>/dev/null || true
    systemctl reset-failed "$unit" 2>/dev/null || true
    rm -f "/etc/systemd/system/$unit"
  done

  # Reset failed states so systemctl doesn’t keep them around
  systemctl reset-failed

  # Only remove if base is correct
  BASE="/apps/tricorder"
  if [[ -d "$BASE" && "$BASE" == "/apps/tricorder" ]]; then
    rm -rf "$BASE"
    echo "[Tricorder] Removed $BASE"
  else
    echo "[Tricorder] Skip install location removal: \"$BASE\" does not exist."
  fi

  echo "[Tricorder] Uninstall complete"
  exit 0
fi


# ---------- install / update ----------
say "Install/Update into $BASE"

# system packages (only if missing)
PKGS=(ffmpeg alsa-utils python3-venv python3-pip)
MISSING=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
if ((${#MISSING[@]})); then
  say "Installing packages: ${MISSING[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${MISSING[@]}"
else
  say "All required packages already installed"
fi

# venv
if [[ ! -d "$VENV" ]]; then
  say "Creating venv"
  python3 -m venv "$VENV"
fi

say "Installing Python deps"
"$VENV/bin/python" -m pip install --quiet --upgrade pip setuptools wheel
"$VENV/bin/pip" install --quiet -r requirements.txt

# create app tree
sudo mkdir -p "$BASE"/{bin,lib,recordings,dropbox,systemd,tmp}
sudo chown -R "$USER":"$USER" "$BASE"

# copy project files (idempotent overwrite)
say "Installing project files"

# bin (always overwrite, executable)
sudo cp -f bin/* "$BASE/bin/"
sudo chmod 755 "$BASE"/bin/*

# lib (always overwrite, executable)
sudo cp -f lib/* "$BASE/lib/"
sudo chmod 755 "$BASE"/lib/*

# systemd units (always overwrite, read-only)
sudo cp -f systemd/*.service "$SYSTEMD_DIR/"
sudo chmod 644 "$SYSTEMD_DIR"/*.service

if command -v dos2unix >/dev/null 2>&1; then
    find "$BASE" -type f -exec dos2unix {} \; >/dev/null 2>&1
fi

# reload + enable + restart
sudo systemctl daemon-reload
# TODO: Re-enable before stable release -jdodds
#for unit in voice-recorder.service dropbox.path tmpfs-guard.timer; do
#    sudo systemctl enable --now "$unit" || true
#    sudo systemctl restart "$unit" || true
#done



say "Install complete"
