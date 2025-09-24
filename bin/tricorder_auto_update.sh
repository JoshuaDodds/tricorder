#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[tricorder-auto-update] $*"
}

if [[ "${DEV:-0}" == "1" ]]; then
  log "DEV=1 set; skipping auto-update."
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  log "git command not found; aborting."
  exit 1
fi

export GIT_TERMINAL_PROMPT=0

REMOTE="${TRICORDER_UPDATE_REMOTE:-}"
BRANCH="${TRICORDER_UPDATE_BRANCH:-main}"
UPDATE_DIR="${TRICORDER_UPDATE_DIR:-/apps/tricorder/repo}"
SRC_DIR="$UPDATE_DIR/src"
INSTALL_SCRIPT_REL="${TRICORDER_INSTALL_SCRIPT:-install.sh}"
INSTALL_BASE="${TRICORDER_INSTALL_BASE:-/apps/tricorder}"
SERVICES="${TRICORDER_UPDATE_SERVICES:-voice-recorder.service web-streamer.service dropbox.service}"

if [[ -z "$REMOTE" ]]; then
  log "TRICORDER_UPDATE_REMOTE not configured; skipping."
  exit 0
fi

mkdir -p "$UPDATE_DIR"

UPDATED=0

if [[ ! -d "$SRC_DIR/.git" ]]; then
  log "No existing checkout; cloning $REMOTE ($BRANCH) into $SRC_DIR."
  rm -rf "$SRC_DIR"
  git clone --branch "$BRANCH" "$REMOTE" "$SRC_DIR"
  UPDATED=1
else
  log "Fetching latest changes for $BRANCH from $REMOTE."
  git -C "$SRC_DIR" remote set-url origin "$REMOTE"
  git -C "$SRC_DIR" fetch --prune origin "$BRANCH"
  LOCAL_HEAD=$(git -C "$SRC_DIR" rev-parse HEAD)
  REMOTE_HEAD=$(git -C "$SRC_DIR" rev-parse origin/"$BRANCH")
  if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
    UPDATED=1
  fi
fi

if (( UPDATED == 0 )); then
  log "Repository already up to date."
  exit 0
fi

log "Resetting checkout to origin/$BRANCH."
git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
git -C "$SRC_DIR" clean -fdx

INSTALL_PATH="$SRC_DIR/$INSTALL_SCRIPT_REL"
if [[ ! -x "$INSTALL_PATH" ]]; then
  log "Install script $INSTALL_PATH missing or not executable."
  exit 1
fi

log "Running installer: $INSTALL_PATH"
DEV=0 BASE="$INSTALL_BASE" bash "$INSTALL_PATH"

for unit in $SERVICES; do
  if systemctl list-unit-files "$unit" >/dev/null 2>&1; then
    if ! systemctl restart "$unit"; then
      log "Restart failed for $unit; attempting start."
      systemctl start "$unit" || log "Unable to start $unit."
    fi
  else
    log "Unit $unit not installed; skipping restart."
  fi
done

if systemctl list-unit-files dropbox.path >/dev/null 2>&1; then
  systemctl start dropbox.path >/dev/null 2>&1 || true
fi

log "Auto-update complete."
