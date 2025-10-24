#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[encode] PWD: $(pwd)"
echo "[encode] PATH: $PATH"
# shellcheck disable=SC2145
echo "[encode] Args: $@"
which ffmpeg || echo "[encode] ffmpeg not found"

# Default: denoise OFF; UI will toggle on when requested (set DENOISE=1 to enable manually)
DENOISE="${DENOISE:-0}"
MIN_CLIP_SECONDS="${ENCODER_MIN_CLIP_SECONDS:-0}"
FFPROBE_WARNED=0
LAST_CLIP_DURATION=""

in_wav="$1"     # abs path in tmpfs
base="$2"       # e.g. 08-57-34_Both_1
existing_opus="${3:-}"
preserve_source="$in_wav"
if [[ -n "${RAW_CAPTURE_PATH:-}" && -f "$RAW_CAPTURE_PATH" ]]; then
  preserve_source="$RAW_CAPTURE_PATH"
fi
ORIGINAL_AUDIO_DIRNAME=".original_wav"
ORIGINAL_REL_PATH=""
VENV="/apps/tricorder/venv"
PYTHON_BIN="${ENCODER_PYTHON:-}";
if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "$VENV/bin/python" ]]; then
    PYTHON_BIN="$VENV/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python)"
  else
    PYTHON_BIN=""
  fi
fi

run_python_module() {
  local module="$1"
  shift
  if [[ -z "$PYTHON_BIN" ]]; then
    log_journal "[encode] python interpreter not available for $module"
    return 1
  fi
  "$PYTHON_BIN" -m "$module" "$@"
}

log_journal() {
  local message="$1"
  if ! systemd-cat -t tricorder <<<"$message"; then
    printf '%s\n' "$message" >&2
  fi
}

clip_too_short() {
  local path="$1"
  LAST_CLIP_DURATION=""
  if [[ -z "$path" || ! -f "$path" ]]; then
    return 1
  fi
  if ! awk -v min="$MIN_CLIP_SECONDS" 'BEGIN { exit !(min > 0) }'; then
    return 1
  fi
  if ! command -v ffprobe >/dev/null 2>&1; then
    if [[ "$FFPROBE_WARNED" -eq 0 ]]; then
      log_journal "[encode] ffprobe unavailable; cannot enforce min clip seconds"
      FFPROBE_WARNED=1
    fi
    return 1
  fi
  local duration
  duration=$(ffprobe -hide_banner -loglevel error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$path" 2>/dev/null | head -n 1 || true)
  if [[ -z "$duration" ]]; then
    return 1
  fi
  LAST_CLIP_DURATION="$duration"
  if awk -v dur="$duration" -v min="$MIN_CLIP_SECONDS" 'BEGIN { exit !(min > 0 && dur > 0 && dur < min) }'; then
    return 0
  fi
  return 1
}

discard_short_clip() {
  local target="$1"
  local duration="$LAST_CLIP_DURATION"
  local formatted_duration="$duration"
  local formatted_threshold="$MIN_CLIP_SECONDS"
  if [[ -n "$duration" ]]; then
    formatted_duration=$(printf '%.3f' "$duration" 2>/dev/null || echo "$duration")
  fi
  if [[ -n "$MIN_CLIP_SECONDS" ]]; then
    formatted_threshold=$(printf '%.3f' "$MIN_CLIP_SECONDS" 2>/dev/null || echo "$MIN_CLIP_SECONDS")
  fi
  log_journal "[encode] Clip duration ${formatted_duration}s below minimum ${formatted_threshold}s; moving $target to recycle bin"

  if [[ -n "$target" && -f "$target" ]]; then
    local recycle_args=(
      lib.recycle_bin_utils
      move-short
      --recordings-root
      "$recordings_root"
      --audio
      "$target"
      --reason
      "short_clip"
    )

    if [[ -n "$waveform_file" && -f "$waveform_file" ]]; then
      recycle_args+=(--waveform "$waveform_file")
    fi
    if [[ -n "$transcript_file" && -f "$transcript_file" ]]; then
      recycle_args+=(--transcript "$transcript_file")
    fi
    if [[ -n "$duration" ]]; then
      recycle_args+=(--duration "$duration")
    fi

    local recycle_entry=""
    if recycle_entry=$(run_python_module "${recycle_args[@]}"); then
      if [[ -n "$recycle_entry" ]]; then
        log_journal "[encode] Short recording moved to recycle bin entry ${recycle_entry}"
      else
        log_journal "[encode] Short recording moved to recycle bin"
      fi
    else
      log_journal "[encode] WARN: recycle bin move failed for $target; deleting artifacts"
      rm -f "$target"
      rm -f "$waveform_file" "$transcript_file"
    fi
  else
    rm -f "$target"
    rm -f "$waveform_file" "$transcript_file"
  fi

  rm -f "$in_wav"
  log_journal "[encode] Short recording handling complete for $target"
  exit 0
}
target_day="${ENCODER_TARGET_DAY:-}"
if [[ -n "$target_day" && "$target_day" =~ ^[0-9]{8}$ ]]; then
  day="$target_day"
else
  day="$(date +%Y%m%d)"
fi
recordings_root="${ENCODER_RECORDINGS_DIR:-/apps/tricorder/recordings}"
recordings_root="${recordings_root%/}"
outdir="${recordings_root}/${day}"
mkdir -p "$outdir"

preserve_original_wav() {
  local source="$1"
  local day_component="$2"
  local base_name="$3"
  ORIGINAL_REL_PATH=""

  if [[ -z "$source" || ! -f "$source" ]]; then
    return 1
  fi

  if [[ -z "$day_component" ]]; then
    day_component="$(date +%Y%m%d)"
  fi

  local dest_dir="${recordings_root}/${ORIGINAL_AUDIO_DIRNAME}/${day_component}"
  if ! mkdir -p "$dest_dir"; then
    log_journal "[encode] WARN: unable to prepare original WAV directory $dest_dir"
    return 1
  fi

  local candidate="${dest_dir}/${base_name}.wav"
  if [[ -e "$candidate" ]]; then
    local suffix=1
    while [[ -e "$candidate" && $suffix -lt 100 ]]; do
      candidate="${dest_dir}/${base_name}.${suffix}.wav"
      suffix=$((suffix + 1))
    done
    if [[ -e "$candidate" ]]; then
      candidate="${dest_dir}/${base_name}.$(date +%s).wav"
    fi
  fi

  if mv -f "$source" "$candidate"; then
    ORIGINAL_REL_PATH="${ORIGINAL_AUDIO_DIRNAME}/${day_component}/$(basename "$candidate")"
    log_journal "[encode] Preserved original WAV at ${candidate}"
    return 0
  fi

  log_journal "[encode] WARN: failed to preserve original WAV $source"
  return 1
}

annotate_original_wav() {
  local waveform_path="$1"
  local relative_path="$2"
  if [[ -z "$waveform_path" || -z "$relative_path" ]]; then
    return
  fi
  if ! run_python_module lib.recording_metadata set_original_path "$waveform_path" "$relative_path"; then
    log_journal "[encode] WARN: unable to update waveform metadata with original path"
  fi
}

if [[ -n "$existing_opus" ]]; then
  outfile="$existing_opus"
else
  container_format="${STREAMING_CONTAINER_FORMAT:-opus}"
  container_format="${container_format,,}"
  case "$container_format" in
    webm)
      default_extension=".webm"
      ;;
    *)
      default_extension=".opus"
      ;;
  esac
  if [[ -n "${STREAMING_EXTENSION:-}" ]]; then
    ext="${STREAMING_EXTENSION}"
    if [[ "${ext}" != .* ]]; then
      ext=".${ext}"
    fi
    default_extension="$ext"
  fi
  outfile="$outdir/${base}${default_extension}"
fi
mkdir -p "$(dirname "$outfile")"
waveform_file="${outfile}.waveform.json"
reuse_waveform=0
if [[ -f "$waveform_file" ]]; then
  reuse_waveform=1
fi
transcript_file="${outfile}.transcript.json"

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
if [[ -n "$existing_opus" && -f "$existing_opus" ]]; then
  if clip_too_short "$existing_opus"; then
    discard_short_clip "$existing_opus"
  fi
  if [[ "${#FILTERS[@]}" -gt 0 ]]; then
    log_journal "[encode] Streaming encoder provided $existing_opus; applying filters"
    temp_outdir="$(dirname "$existing_opus")"
    temp_filename="$(basename "$existing_opus")"
    temp_ext="${temp_filename##*.}"
    if [[ "$temp_ext" == "$temp_filename" ]]; then
      temp_ext=""
      temp_stem="$temp_filename"
    else
      temp_ext=".${temp_ext}"
      temp_stem="${temp_filename%.*}"
    fi
    temp_outfile="${temp_outdir}/.${temp_stem}.filtered.$$${temp_ext}"
    if ! nice -n 15 ionice -c3 ffmpeg -hide_banner -loglevel error -y -threads 1 \
      -thread_queue_size 8192 \
      -i "$existing_opus" \
      "${FILTERS[@]}" \
      -ac 1 -ar 48000 -sample_fmt s16 \
      -c:a libopus -b:a 48k -vbr on -application audio -frame_duration 20 \
      "$temp_outfile"; then
        log_journal "[encode] ffmpeg failed for $existing_opus"
        rm -f "$temp_outfile"
        run_python_module lib.fault_handler encode_failure "$existing_opus" "$base"
        exit 1
    fi
    mv -f "$temp_outfile" "$existing_opus"
  else
    log_journal "[encode] Streaming encoder provided $existing_opus; no filters requested"
    if [[ "$reuse_waveform" -ne 1 ]]; then
      if ! run_python_module lib.waveform_cache "$in_wav" "$waveform_file"; then
        log_journal "[encode] waveform generation failed for $in_wav"
        rm -f "$in_wav"
        exit 1
      fi
      echo "[encode] Wrote waveform $waveform_file"
    else
      echo "[encode] Reused waveform $waveform_file"
    fi
    if ! run_python_module lib.transcription "$in_wav" "$transcript_file" "$base"; then
      log_journal "[encode] transcription failed for $base"
    fi
    if ! preserve_original_wav "$preserve_source" "$day" "$base"; then
      rm -f "$preserve_source"
    fi
    rm -f "$in_wav"
    annotate_original_wav "$waveform_file" "$ORIGINAL_REL_PATH"
    if ! run_python_module lib.archival "$outfile" "$waveform_file" "$transcript_file"; then
      log_journal "[encode] archival upload failed for $outfile"
    fi
    log_journal "[encoder] Stored $outfile"
    echo "[encode] Done"
    exit 0
  fi
else
  if ! nice -n 15 ionice -c3 ffmpeg -hide_banner -loglevel error -y -threads 1 \
    -thread_queue_size 8192 \
    -i "$in_wav" \
    "${FILTERS[@]}" \
    -ac 1 -ar 48000 -sample_fmt s16 \
    -c:a libopus -b:a 48k -vbr on -application audio -frame_duration 20 \
    "$outfile"; then
      log_journal "[encode] ffmpeg failed for $in_wav"
      run_python_module lib.fault_handler encode_failure "$in_wav" "$base"
      exit 1
  fi
  if clip_too_short "$outfile"; then
    discard_short_clip "$outfile"
  fi
fi

if [[ "$reuse_waveform" -eq 1 ]]; then
  echo "[encode] Reused waveform $waveform_file"
else
  if ! run_python_module lib.waveform_cache "$in_wav" "$waveform_file"; then
    log_journal "[encode] waveform generation failed for $in_wav"
    rm -f "$outfile"
    rm -f "$in_wav"
    exit 1
  fi
  echo "[encode] Wrote waveform $waveform_file"
fi

if ! run_python_module lib.transcription "$in_wav" "$transcript_file" "$base"; then
  log_journal "[encode] transcription failed for $base"
fi

if ! preserve_original_wav "$preserve_source" "$day" "$base"; then
  rm -f "$preserve_source"
fi
rm -f "$in_wav"

annotate_original_wav "$waveform_file" "$ORIGINAL_REL_PATH"

if ! run_python_module lib.archival "$outfile" "$waveform_file" "$transcript_file"; then
  log_journal "[encode] archival upload failed for $outfile"
fi

log_journal "[encoder] Stored $outfile"
echo "[encode] Done"
