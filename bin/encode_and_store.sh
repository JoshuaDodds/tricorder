#!/usr/bin/env bash
set -euo pipefail

set -x
echo "[encode] PWD: $(pwd)"
echo "[encode] PATH: $PATH"
echo "[encode] Args: $@"
which ffmpeg || echo "[encode] ffmpeg not found"


in_wav="$1"     # abs path in tmpfs
type="$2"       # HumanVoice | Other
ts="$(date +%Y%m%d_%H%M%S_%3N)"
day="$(date +%Y%m%d)"
outdir="/apps/tricorder/recordings/$day"
mkdir -p "$outdir"

outfile="$outdir/${type}_${ts}.opus"

nice -n 10 ionice -c3 ffmpeg -hide_banner -loglevel error -y \
  -i "$in_wav" -c:a libopus -b:a 32k -vbr on -application voip \
  "$outfile"

rm -f "$in_wav"

# Log to journal
echo "[encoder] Stored $outfile" | systemd-cat -t tricorder

echo "[encode] Done"
