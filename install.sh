#!/usr/bin/env bash
set -euo pipefail

BASE="/apps/tricorder"
VENV="$BASE/venv"
SYSTEMD_DIR="/etc/systemd/system"
SITE=$VENV/lib/python3.12/site-packages

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
check_pkg() {
    local pkg="$1"
    local want="$2"
    local info=$(ls "$SITE" | grep -i "^${pkg}-.*\.dist-info$" | head -n1)
    if [ -z "$info" ]; then
        echo "[install] missing: $pkg ($want)"
        return 1
    fi
    local have=$(grep -m1 "^Version:" "$SITE/$info/METADATA" | awk '{print $2}')
    if [ "$have" != "$want" ]; then
        echo "[install] mismatch: $pkg (have $have, want $want)"
        return 1
    fi
    return 0
}

check_reqs() {
    local missing=0
    while read -r line; do
        [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
        pkg=$(echo "$line" | cut -d= -f1)
        ver=$(echo "$line" | cut -d= -f3)
        if ! check_pkg "$pkg" "$ver"; then
            missing=1
        fi
    done < requirements.txt
    return $missing
}

echo "[Tricorder] Checking Python deps..."
if check_reqs; then
    echo "[Tricorder] All requirements satisfied, skipping pip install."
else
    echo "[Tricorder] Installing/upgrading requirements..."
    "$VENV/bin/pip" install --no-cache-dir --upgrade -r requirements.txt
fi

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

# normalize line endings only in our source trees
if command -v dos2unix >/dev/null 2>&1; then
  for d in bin lib systemd; do
    if [[ -d "$BASE/$d" ]]; then
      find "$BASE/$d" -type f -exec dos2unix {} \; >/dev/null 2>&1
    fi
  done
fi

# dev-only helpers (optional)
if [[ "${DEV:-0}" == "1" ]]; then
  say "Installing dev helpers (main.py, __init__.py)"
  if [[ -f main.py ]]; then
    sudo cp -f main.py "$BASE/"
    sudo chmod 755 "$BASE/main.py"
  fi
  if [[ -f __init__.py ]]; then
    sudo cp -f __init__.py "$BASE/"
    sudo chmod 644 "$BASE/__init__.py"
  fi
fi

# reload + enable + restart
say "Enable, reload, and restart Systemd units"
sudo systemctl daemon-reload
# TODO: Re-enable before stable release -jdodds
#for unit in voice-recorder.service dropbox.path tmpfs-guard.timer; do
#    sudo systemctl enable --now "$unit" || true
#    sudo systemctl restart "$unit" || true
#done

say "Install complete"
