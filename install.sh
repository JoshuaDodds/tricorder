#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

INSTALL_OWNER="${USER:-}"
if [[ -z "$INSTALL_OWNER" ]] && command -v id >/dev/null 2>&1; then
  INSTALL_OWNER=$(id -un 2>/dev/null || true)
fi

# Allow override for test mode
BASE="${BASE:-/apps/tricorder}"
VENV="$BASE/venv"
SYSTEMD_DIR="/etc/systemd/system"
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
SITE=$VENV/lib/python$PY_VER/site-packages
DEV_SENTINEL="$BASE/.dev-mode"

UNITS=(voice-recorder.service web-streamer.service sd-card-monitor.service dropbox.service dropbox.path tmpfs-guard.service tmpfs-guard.timer tricorder-auto-update.service tricorder-auto-update.timer tricorder.target)

say(){ echo "[Tricorder] $*"; }

# ---------- uninstall ----------
if [[ "${1:-}" == "--remove" ]]; then
  echo "[Tricorder] Uninstall requested"

  if [[ "${DEV:-0}" == "1" ]]; then
    say "DEV=1: skipping systemctl and rm -rf $BASE"
    exit 0
  fi

  for unit in "${UNITS[@]}"; do
    echo "[Tricorder] Disabling and stopping $unit"
    systemctl disable --now "$unit" 2>/dev/null || true
    systemctl reset-failed "$unit" 2>/dev/null || true
    rm -f "$SYSTEMD_DIR/$unit"
  done

  systemctl reset-failed

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

if [[ "${DEV:-0}" != "1" ]]; then
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
else
  say "DEV=1: skipping apt-get installation"
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
    # shellcheck disable=SC2155
    local info=$(ls "$SITE" | grep -i "^${pkg}-.*\\.dist-info$" | head -n1 || true)
    if [ -z "$info" ]; then
        echo "[install] missing: $pkg ($want)"
        return 1
    fi
    # shellcheck disable=SC2155
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
mkdir -p "$BASE"/{bin,lib,recordings,dropbox,systemd,tmp,repo}
if [[ -n "$INSTALL_OWNER" ]]; then
  chown -R "$INSTALL_OWNER":"$INSTALL_OWNER" "$BASE" 2>/dev/null || true
fi

# copy project files (idempotent overwrite)
say "Installing project files"

cp -f bin/* "$BASE/bin/" 2>/dev/null || true
chmod 755 "$BASE"/bin/* 2>/dev/null || true

cp -rf lib/* "$BASE/lib/" 2>/dev/null || true
chmod 755 "$BASE"/lib/* 2>/dev/null || true

# shellcheck disable=SC2035
cp -f *.py "$BASE" 2>/dev/null || true
chmod 755 "$BASE"/*.py 2>/dev/null || true

# Copy YAML configs but skip if already present
for f in *.yaml; do
    target="$BASE/$f"
    if [ -f "$target" ]; then
        echo "Keeping existing $target"
    else
        cp "$f" "$BASE/"
    fi
done

for unit in systemd/*; do
  [ -f "$unit" ] || continue
  fname=$(basename "$unit")
  cp -f "$unit" "$SYSTEMD_DIR/$fname" 2>/dev/null || true
  chmod 644 "$SYSTEMD_DIR/$fname" 2>/dev/null || true
done

if command -v dos2unix >/dev/null 2>&1; then
  for d in bin lib systemd; do
    if [[ -d "$BASE/$d" ]]; then
      find "$BASE/$d" -type f -exec dos2unix {} \; >/dev/null 2>&1
    fi
  done
fi

if [[ "${DEV:-0}" == "1" ]]; then
  say "Installing dev helpers (main.py, __init__.py)"
  if [[ -f main.py ]]; then
    cp -f main.py room_tuner.py "$BASE/" 2>/dev/null || true
    chmod 755 "$BASE/main.py" 2>/dev/null || true
  fi
  if [[ -f __init__.py ]]; then
    cp -f __init__.py "$BASE/" 2>/dev/null || true
    chmod 644 "$BASE/__init__.py" 2>/dev/null || true
  fi
fi

if [[ "${DEV:-0}" != "1" ]]; then
  rm -f "$DEV_SENTINEL"
  say "Enable, reload, and restart Systemd units"
  sudo systemctl daemon-reload
  for unit in voice-recorder.service web-streamer.service sd-card-monitor.service dropbox.service tmpfs-guard.service tricorder-auto-update.service; do
      sudo systemctl enable "$unit" || true
  done
  for timer in tmpfs-guard.timer tricorder-auto-update.timer; do
      sudo systemctl enable "$timer" || true
  done

  sudo systemctl enable dropbox.path || true
  sudo systemctl enable tricorder.target || true
  sudo systemctl restart tricorder.target || true

else
  say "DEV=1: marking install as dev mode"
  touch "$DEV_SENTINEL"
  say "DEV=1: skipping systemctl enable/start"
fi

say "Reloading systemd and restarting active services..."
sudo systemctl daemon-reload || true
sudo systemctl restart web-streamer.service || true

restart_if_active() {
  local unit="$1"
  if systemctl is-active --quiet "$unit"; then
    sudo systemctl restart "$unit" || true
  fi
}

restart_if_active voice-recorder.service
restart_if_active dropbox.service
restart_if_active dropbox.path

say "Install complete"
