#!/usr/bin/env bash
set -euo pipefail

# Colors
RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RESET="\033[0m"

UNITS=(
  voice-recorder.service
  web-streamer.service
  # dropbox.service
  dropbox.path
  # tmpfs-guard.service
  tmpfs-guard.timer
  # tricorder-auto-update.service
  tricorder-auto-update.timer
)

humanize() {
  # humanize seconds -> "1h23m", "12m", "45s"
  local s=$1
  (( s<0 )) && s=$(( -s ))
  local h=$(( s/3600 ))
  local m=$(( (s%3600)/60 ))
  local sec=$(( s%60 ))
  local out=""
  (( h>0 )) && out+="${h}h"
  (( m>0 )) && out+="${m}m"
  if (( h==0 && m==0 )); then out+="${sec}s"; fi
  echo "$out"
}

echo "[Tricorder] Unit status:"
for unit in "${UNITS[@]}"; do
  # If the unit file doesn't exist, just say so
  if ! systemctl list-unit-files --no-legend "$unit" >/dev/null 2>&1; then
    printf "\n%-30s : not installed\n" "$unit"
    continue
  fi

  # Base facts
  state=$(systemctl is-active "$unit" 2>/dev/null || echo "unknown")
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || echo "disabled")

  # Colors for base state
  case "$state" in
    active)   state_col="${GREEN}$state${RESET}" ;;
    inactive) state_col="${RED}$state${RESET}" ;;
    failed)   state_col="${RED}$state${RESET}" ;;
    *)        state_col="${YELLOW}$state${RESET}" ;;
  esac

  # Detect trigger relationships reliably (NO grep/pipes that fail):
  # This prints space-separated triggering units, or empty string.
  triggered_by=$(systemctl show -p TriggeredBy --value "$unit" 2>/dev/null || echo "")
  result=$(systemctl show -p Result --value "$unit" 2>/dev/null || echo "")
  [[ -z "$result" ]] && result="unknown"

  # If this is an inactive unit that is triggered by something (timer/path)
  # we report it as "waiting" and show last + next details.
  if [[ "$state" == "inactive" && -n "$triggered_by" ]]; then
    last_run=$(systemctl show -p ActiveExitTimestamp --value "$unit" 2>/dev/null || echo "")
    next_fragments=()

    # Iterate over each trigger (there can be multiple)
    for trig in $triggered_by; do
      if [[ "$trig" == *.timer ]]; then
        nr=$(systemctl show -p NextElapseUSecRealtime --value "$trig" 2>/dev/null || echo "")
        if [[ -n "$nr" ]]; then
          # Try to compute time left until next run
          now_ts=$(date +%s)
          nr_ts=$(date -d "$nr" +%s 2>/dev/null || echo "")
          if [[ -n "$nr_ts" ]]; then
            left=$(( nr_ts - now_ts ))
            if (( left > 0 )); then
              next_fragments+=("$nr (in $(humanize "$left"))")
            else
              next_fragments+=("$nr")
            fi
          else
            next_fragments+=("$nr")
          fi
        fi
      elif [[ "$trig" == *.path ]]; then
        next_fragments+=("on path event")
      fi
    done

    next_info=""
    if (( ${#next_fragments[@]} > 0 )); then
      # join with "; "
      next_info=$(printf "%s; " "${next_fragments[@]}")
      next_info=${next_info%; }
    fi

    pretty="waiting (triggered by ${triggered_by// /, }"
    [[ -n "$last_run" ]] && pretty+=", last=$last_run"
    [[ -n "$next_info" ]] && pretty+=", next=$next_info"
    pretty+=")"

    state_col="${YELLOW}${pretty}${RESET}"
  fi

  printf "\n%-30s : %-60b (%s)\n" "$unit" "$state_col" "$enabled"

  # Show last 3 log lines
  journalctl -u "$unit" -n 3 --no-pager 2>/dev/null | sed 's/^/    /'
done
