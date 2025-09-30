#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[tricorder-auto-update] $*"
}

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

DEV_MODE=0
if [[ "${DEV:-0}" == "1" ]]; then
  DEV_MODE=1
fi
if [[ "${TRICORDER_DEV_MODE:-0}" == "1" ]]; then
  DEV_MODE=1
fi
if [[ -f "$INSTALL_BASE/.dev-mode" ]]; then
  DEV_MODE=1
fi

if (( DEV_MODE == 1 )); then
  log "Dev mode enabled via environment or .dev-mode; skipping auto-update."
  exit 0
fi

if [[ -z "$REMOTE" ]]; then
  log "TRICORDER_UPDATE_REMOTE not configured; skipping."
  exit 0
fi

mkdir -p "$UPDATE_DIR"

INSTALL_FAILURE_SENTINEL="$UPDATE_DIR/.last_install_failed"

UPDATED=0

log "Production mode: checking $BRANCH on $REMOTE for updates."
if [[ ! -d "$SRC_DIR/.git" ]]; then
  log "No existing checkout found; cloning $REMOTE into $SRC_DIR."
  rm -rf "$SRC_DIR"
  git clone --branch "$BRANCH" "$REMOTE" "$SRC_DIR"
  git -C "$SRC_DIR" remote set-url origin "$REMOTE"
  UPDATED=1
else
  git -C "$SRC_DIR" remote set-url origin "$REMOTE"
  if ! git -C "$SRC_DIR" fetch origin "$BRANCH" --prune >/dev/null 2>&1; then
    log "Production mode: git fetch for origin/$BRANCH failed; skipping update."
  else
    REMOTE_HEAD=$(git -C "$SRC_DIR" rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
    if [[ -z "$REMOTE_HEAD" ]]; then
      log "Production mode: remote branch origin/$BRANCH not found; skipping update."
    else
      LOCAL_HEAD=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo "")
      if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
        log "Production mode: new commits detected; updating checkout."
        git -C "$SRC_DIR" checkout -B "$BRANCH" "$REMOTE_HEAD" >/dev/null 2>&1 || \
          git -C "$SRC_DIR" checkout "$BRANCH"
        git -C "$SRC_DIR" reset --hard "$REMOTE_HEAD"
        UPDATED=1
      fi
    fi
  fi
fi

if (( UPDATED == 0 )); then
  if [[ -f "$INSTALL_FAILURE_SENTINEL" ]]; then
    log "Previous install failure detected; retrying even without new commits."
  else
    log "Repository already up to date."
    exit 0
  fi
fi

git -C "$SRC_DIR" reset --hard HEAD
git -C "$SRC_DIR" clean -fdx

INSTALL_PATH="$SRC_DIR/$INSTALL_SCRIPT_REL"
if [[ ! -x "$INSTALL_PATH" ]]; then
  log "Install script $INSTALL_PATH missing or not executable."
  exit 1
fi

log "Running installer: $INSTALL_PATH"
date -Is >"$INSTALL_FAILURE_SENTINEL"
DEV="$DEV_MODE" BASE="$INSTALL_BASE" bash "$INSTALL_PATH"

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

rm -f "$INSTALL_FAILURE_SENTINEL"

log "Auto-update complete."
