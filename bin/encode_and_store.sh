#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[encode] PWD: $(pwd)"
echo "[encode] PATH: $PATH"
echo "[encode] Args: $@"
which ffmpeg || echo "[encode] ffmpeg not found"

in_wav="$1"     # abs path in tmpfs
base="$2"       # e.g. 08-57-34_Both_1
day="$(date +%Y%m%d)"
outdir="/apps/tricorder/recordings/$day"
mkdir -p "$outdir"

outfile="$outdir/${base}.opus"

nice -n 15 ionice -c3 ffmpeg -hide_banner -loglevel error -y -threads 1\
  -i "$in_wav" -c:a libopus -b:a 48k -vbr on -application voip \
  "$outfile"

rm -f "$in_wav"

echo "[encoder] Stored $outfile" | systemd-cat -t tricorder
echo "[encode] Done"
