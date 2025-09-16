#!/usr/bin/env bash

set -euo pipefail

BASE="/apps/tricorder/recordings"
usage=$(df --output=pcent "$BASE" | tail -1 | tr -dc '0-9' || echo 0)
[ "${usage:-0}" -lt 80 ] && exit 0
find "$BASE" -type f -name '*.opus' -printf '%T@ %p\0' | sort -z -n | \
  awk -vRS='\0' '{print $2}' | while read -r f; do
    rm -f -- "$f"
    usage=$(df --output=pcent "$BASE" | tail -1 | tr -dc '0-9' || echo 0)
    [ "$usage" -lt 80 ] && break
  done
