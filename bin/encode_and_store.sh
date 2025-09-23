#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[encode] PWD: $(pwd)"
echo "[encode] PATH: $PATH"
# shellcheck disable=SC2145
echo "[encode] Args: $@"
which ffmpeg || echo "[encode] ffmpeg not found"

# Default: denoise ON (override with DENOISE=0 to disable)
DENOISE="${DENOISE:-1}"

in_wav="$1"     # abs path in tmpfs
base="$2"       # e.g. 08-57-34_Both_1
VENV="/apps/tricorder/venv"
day="$(date +%Y%m%d)"
outdir="/apps/tricorder/recordings/$day"
mkdir -p "$outdir"

outfile="$outdir/${base}.opus"
waveform_file="${outfile}.waveform.json"

# Optional denoise filter chain
FILTERS=()
if [[ "$DENOISE" == "1" ]]; then
  FILTERS=(-af "highpass=f=80,afftdn")
  echo "[encode] Using high-pass (80Hz) + FFT-based denoise (afftdn)"
elif [[ "$DENOISE" == "rnnoise" ]]; then
  FILTERS=(-af "highpass=f=80,arnndn")
  echo "[encode] Using high-pass (80Hz) + RNNoise denoise (arnndn)"
else
  echo "[encode] No denoise filter applied"
fi

# Notes:
# - Force input interpretation: mono, s16le, 48k. This avoids any accidental
#   resample if the WAV header is off or if ALSA produced a surprise rate.
# - Use application=audio (general content), 20ms frames, VBR on, 48 kbps.
# - One thread to reduce CPU spikes on the Zero 2 W.
if ! nice -n 15 ionice -c3 ffmpeg -hide_banner -loglevel error -y -threads 1 \
  -i "$in_wav" \
  "${FILTERS[@]}" \
  -ac 1 -ar 48000 -sample_fmt s16 \
  -c:a libopus -b:a 48k -vbr on -application audio -frame_duration 20 \
  "$outfile"; then
    echo "[encode] ffmpeg failed for $in_wav" | systemd-cat -t tricorder
    "$VENV/bin/python" -m lib.fault_handler encode_failure "$in_wav" "$base"
    exit 1
fi

if ! "$VENV/bin/python" -m lib.waveform_cache "$in_wav" "$waveform_file"; then
  echo "[encode] waveform generation failed for $in_wav" | systemd-cat -t tricorder
  rm -f "$outfile"
  rm -f "$in_wav"
  exit 1
fi

echo "[encode] Wrote waveform $waveform_file"

rm -f "$in_wav"

echo "[encoder] Stored $outfile" | systemd-cat -t tricorder
echo "[encode] Done"