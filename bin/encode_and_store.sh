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

# Notes:
# - Force input interpretation: mono, s16le, 48k. This avoids any accidental
#   resample if the WAV header is off or if ALSA produced a surprise rate.
# - Use application=audio (general content), 20ms frames, VBR on, 48 kbps.
#   This is far less artifact-prone on steady noises than 'voip' at 32 kbps.
# - One thread to reduce CPU spikes on the Zero 2 W.
nice -n 15 ionice -c3 ffmpeg -hide_banner -loglevel error -y -threads 1 \
  -ac 1 -ar 48000 -sample_fmt s16 \
  -i "$in_wav" \
  -c:a libopus -b:a 48k -vbr on -application audio -frame_duration 20 \
  "$outfile"

rm -f "$in_wav"

echo "[encoder] Stored $outfile" | systemd-cat -t tricorder
echo "[encode] Done"
