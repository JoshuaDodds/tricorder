#!/usr/bin/env python3
import json
import math
import os
import re
import sys
import time
import collections
import contextlib
import subprocess
import wave
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import threading
import queue
import warnings
from collections.abc import Callable
from pathlib import Path
from collections.abc import Callable, Iterable
from typing import Optional
import array
from lib.waveform_cache import DEFAULT_BUCKET_COUNT, MAX_BUCKET_COUNT, PEAK_SCALE
from lib.motion_state import MOTION_STATE_FILENAME, MotionStateWatcher
from lib import dashboard_events
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    message="pkg_resources is deprecated as an API.*"
)
import webrtcvad    # noqa
from lib.config import get_cfg, resolve_event_tags
from lib.notifications import build_dispatcher
from lib.segmenter_helpers.display import color_tf
from lib.segmenter_helpers.system import (
    normalized_load as _normalized_load,
    set_single_core_affinity as _set_single_core_affinity,
)
from lib.segmenter_helpers.tags import sanitize_event_tag as _sanitize_event_tag

cfg = get_cfg()
EVENT_TAGS = resolve_event_tags(cfg)
NOTIFIER = build_dispatcher(cfg.get("notifications"))

# Debug output formatting defaults (prevents NameError when DEV mode is enabled)
BAR_SCALE = int(cfg["segmenter"].get("rms_bar_scale", 4000))  # scale for RMS bar visualization
BAR_WIDTH = int(cfg["segmenter"].get("rms_bar_width", 30))    # character width of the bar
RIGHT_TEXT_WIDTH = int(cfg["segmenter"].get("right_text_width", 54))  # fixed-width right block

SAMPLE_RATE = int(cfg["audio"]["sample_rate"])
SAMPLE_WIDTH = 2   # 16-bit
FRAME_MS = int(cfg["audio"]["frame_ms"])
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000
FRAME_SAMPLES = FRAME_BYTES // SAMPLE_WIDTH

INT16_MAX = 2 ** 15 - 1
INT16_MIN = -2 ** 15

@dataclass(frozen=True)
class RecorderIngestHint:
    timestamp: str
    event_counter: int | None = None


@dataclass(frozen=True)
class AdaptiveRmsObservation:
    """Snapshot emitted whenever the adaptive RMS controller evaluates."""

    timestamp: float
    updated: bool
    threshold_linear: int
    previous_threshold_linear: int
    candidate_threshold_linear: int
    p95_norm: float
    release_norm: float
    buffer_size: int
    rms_value: int
    voiced: bool


@dataclass(frozen=True)
class StartupRecoveryReport:
    requeued: list[str]
    removed_artifacts: list[str]
    removed_wavs: list[str]


def pcm16_rms(buf: bytes) -> int:
    """Compute RMS amplitude for signed 16-bit little-endian PCM data."""
    if not buf:
        return 0
    if len(buf) % SAMPLE_WIDTH:
        raise ValueError("PCM16 buffer length must be a multiple of 2 bytes")

    samples = array.array('h')
    samples.frombytes(buf)
    if sys.byteorder != 'little':
        samples.byteswap()

    total = 0
    for sample in samples:
        total += sample * sample
    if not samples:
        return 0
    mean_square = total / len(samples)
    return int(math.sqrt(mean_square))


def pcm16_apply_gain(buf: bytes, gain: float) -> bytes:
    """Scale signed 16-bit PCM samples by gain with int16 clipping."""
    if not buf or gain == 1.0:
        return buf
    if len(buf) % SAMPLE_WIDTH:
        raise ValueError("PCM16 buffer length must be a multiple of 2 bytes")

    samples = array.array('h')
    samples.frombytes(buf)
    if sys.byteorder != 'little':
        samples.byteswap()

    for idx, sample in enumerate(samples):
        product = sample * gain
        scaled = math.floor(product)
        if scaled > INT16_MAX:
            scaled = INT16_MAX
        elif scaled < INT16_MIN:
            scaled = INT16_MIN
        samples[idx] = scaled

    if sys.byteorder != 'little':
        samples.byteswap()
    return samples.tobytes()


def _estimate_rms_from_file(path: str | os.PathLike[str]) -> int:
    wav_path = Path(path)
    try:
        with wave.open(os.fspath(wav_path), "rb") as wav_file:
            frames = wav_file.getnframes()
            if frames <= 0:
                return 0
            data = wav_file.readframes(frames)
    except (FileNotFoundError, OSError, wave.Error):
        return 0
    return pcm16_rms(data)


def _derive_final_base(path: str | os.PathLike[str], rms_value: int) -> str:
    wav_path = Path(path)
    base_name = wav_path.stem
    parts = base_name.split("_")
    event_ts = parts[0] if parts else time.strftime("%H-%M-%S", time.localtime())
    if len(parts) >= 3:
        event_label = parts[1]
        event_counter = parts[2]
    elif len(parts) == 2:
        event_label = parts[1]
        event_counter = "1"
    else:
        event_label = EVENT_TAGS["other"]
        event_counter = "1"
    if not isinstance(event_label, str) or not event_label:
        event_label = EVENT_TAGS["other"]
    safe_label = _sanitize_event_tag(event_label)
    try:
        counter_int = int(event_counter)
        event_counter = str(counter_int)
    except (TypeError, ValueError):
        event_counter = "1"
    try:
        rms_int = int(rms_value)
    except (TypeError, ValueError):
        rms_int = 0
    if rms_int < 0:
        rms_int = 0
    return f"{event_ts}_{safe_label}_RMS-{rms_int}_{event_counter}"


def perform_startup_recovery() -> StartupRecoveryReport:
    requeued: list[str] = []
    removed_artifacts: list[str] = []
    removed_wavs: list[str] = []

    tmp_dir = Path(TMP_DIR)
    rec_dir = Path(REC_DIR)
    final_extension = (
        STREAMING_EXTENSION
        if STREAMING_EXTENSION.startswith(".")
        else f".{STREAMING_EXTENSION}"
    )

    if not tmp_dir.exists():
        return StartupRecoveryReport(requeued, removed_artifacts, removed_wavs)

    for wav_path in sorted(tmp_dir.glob("*.wav")):
        if not wav_path.is_file():
            continue
        try:
            mtime = wav_path.stat().st_mtime
        except OSError:
            continue
        day_dir = rec_dir / time.strftime("%Y%m%d", time.localtime(mtime))
        rms_value = _estimate_rms_from_file(wav_path)
        final_base = _derive_final_base(wav_path, rms_value)
        final_path = day_dir / f"{final_base}{final_extension}"

        if final_path.exists():
            try:
                wav_path.unlink()
                removed_wavs.append(str(wav_path))
            except OSError:
                pass
            continue

        os.makedirs(day_dir, exist_ok=True)

        base_name = wav_path.stem
        partial_path = day_dir / f"{base_name}{STREAMING_PARTIAL_SUFFIX}"
        artifacts = [
            partial_path,
            partial_path.with_name(partial_path.name + ".waveform.json"),
        ]
        for artifact in artifacts:
            if artifact.exists():
                try:
                    artifact.unlink()
                except OSError:
                    pass
                else:
                    removed_artifacts.append(str(artifact))

        filtered_pattern = f".{final_base}.filtered*"
        if day_dir.exists():
            for filtered in day_dir.glob(filtered_pattern):
                if not filtered.is_file():
                    continue
                try:
                    filtered.unlink()
                except OSError:
                    pass
                else:
                    removed_artifacts.append(str(filtered))

        job_id = _enqueue_encode_job(
            str(wav_path),
            final_base,
            source="recovery",
            existing_opus_path=None,
            manual_recording=False,
            target_day=day_dir.name,
        )
        _schedule_recordings_refresh(
            job_id,
            final_path=str(final_path),
            base_name=final_base,
            day=day_dir.name if day_dir.name else None,
            manual=False,
            source="recovery",
        )
        requeued.append(final_base)

    return StartupRecoveryReport(requeued, removed_artifacts, removed_wavs)

TMP_DIR = cfg["paths"]["tmp_dir"]
REC_DIR = cfg["paths"]["recordings_dir"]
ENCODER = cfg["paths"]["encoder_script"]
RECORDINGS_EVENT_SPOOL_DIRNAME = "recordings_events"
_MIN_CLIP_RAW = cfg["segmenter"].get("min_clip_seconds", 0.0)
try:
    MIN_CLIP_SECONDS = max(0.0, float(_MIN_CLIP_RAW))
except (TypeError, ValueError):
    MIN_CLIP_SECONDS = 0.0

_MOTION_PADDING_MINUTES_RAW = cfg["segmenter"].get("motion_release_padding_minutes", 0.0)
try:
    MOTION_RELEASE_PADDING_SECONDS = max(
        0.0, float(_MOTION_PADDING_MINUTES_RAW) * 60.0
    )
except (TypeError, ValueError):
    MOTION_RELEASE_PADDING_SECONDS = 0.0

AUTO_RECORD_MOTION_OVERRIDE = bool(
    cfg["segmenter"].get("auto_record_motion_override", True)
)

RMS_TRIGGER_ENABLED = bool(cfg["segmenter"].get("enable_rms_trigger", True))
VAD_TRIGGER_ENABLED = bool(cfg["segmenter"].get("enable_vad_trigger", True))

STREAMING_ENCODE_ENABLED = bool(
    cfg["segmenter"].get("streaming_encode", False)
)
_STREAMING_FORMAT = str(
    cfg["segmenter"].get("streaming_encode_container", "opus")
).strip().lower()
if _STREAMING_FORMAT not in {"opus", "webm"}:
    _STREAMING_FORMAT = "opus"
STREAMING_CONTAINER_FORMAT = _STREAMING_FORMAT
STREAMING_EXTENSION = ".opus" if STREAMING_CONTAINER_FORMAT == "opus" else ".webm"
STREAMING_PARTIAL_SUFFIX = f".partial{STREAMING_EXTENSION}"

_PARALLEL_CFG = cfg["segmenter"].get("parallel_encode", {})
PARALLEL_ENCODE_ENABLED = bool(_PARALLEL_CFG.get("enabled", True))
PARALLEL_ENCODE_LOAD_THRESHOLD = float(
    _PARALLEL_CFG.get("load_avg_per_cpu", 0.75)
)
PARALLEL_ENCODE_CHECK_INTERVAL = max(
    0.0, float(_PARALLEL_CFG.get("cpu_check_interval_sec", 1.0))
)
PARALLEL_ENCODE_MIN_SECONDS = max(
    0.0, float(_PARALLEL_CFG.get("min_event_seconds", 1.0))
)
if PARALLEL_ENCODE_MIN_SECONDS <= 0.0:
    PARALLEL_ENCODE_MIN_FRAMES = 1
else:
    PARALLEL_ENCODE_MIN_FRAMES = max(
        1, int(round((PARALLEL_ENCODE_MIN_SECONDS * 1000.0) / FRAME_MS))
    )
PARALLEL_ENCODE_SUFFIX = f".parallel{STREAMING_EXTENSION}"
PARALLEL_PARTIAL_SUFFIX = f"{PARALLEL_ENCODE_SUFFIX}.partial"
PARALLEL_TMP_DIR = os.path.join(TMP_DIR, "parallel")
PARALLEL_OFFLINE_MAX_WORKERS = max(
    1, int(_PARALLEL_CFG.get("offline_max_workers", 2))
)
PARALLEL_OFFLINE_LOAD_THRESHOLD = float(
    _PARALLEL_CFG.get("offline_load_avg_per_cpu", PARALLEL_ENCODE_LOAD_THRESHOLD)
)
PARALLEL_OFFLINE_CHECK_INTERVAL = max(
    0.1, float(_PARALLEL_CFG.get("offline_cpu_check_interval_sec", 1.0))
)
LIVE_WAVEFORM_BUCKET_COUNT = max(
    1, int(_PARALLEL_CFG.get("live_waveform_buckets", DEFAULT_BUCKET_COUNT))
)
LIVE_WAVEFORM_UPDATE_INTERVAL = max(
    0.1, float(_PARALLEL_CFG.get("live_waveform_update_interval_sec", 1.0))
)

# PRE_PAD / POST_PAD
PRE_PAD = int(cfg["segmenter"]["pre_pad_ms"])
POST_PAD = int(cfg["segmenter"]["post_pad_ms"])
PRE_PAD_FRAMES = PRE_PAD // FRAME_MS
POST_PAD_FRAMES = POST_PAD // FRAME_MS

# thresholds
STATIC_RMS_THRESH = int(cfg["segmenter"]["rms_threshold"])
vad = webrtcvad.Vad(int(cfg["audio"]["vad_aggressiveness"]))

# DE-BOUNCE tunables
START_CONSECUTIVE = int(cfg["segmenter"]["start_consecutive"])
KEEP_CONSECUTIVE = int(cfg["segmenter"]["keep_consecutive"])

# window sizes
KEEP_WINDOW = int(cfg["segmenter"]["keep_window_frames"])

# Mic Digital Gain
GAIN = float(cfg["audio"]["gain"])

# Noise reduction settings
USE_RNNOISE = bool(cfg["segmenter"]["use_rnnoise"])
USE_NOISEREDUCE = bool(cfg["segmenter"]["use_noisereduce"])
DENOISE_BEFORE_VAD = bool(cfg["segmenter"]["denoise_before_vad"])

if (USE_RNNOISE or USE_NOISEREDUCE) and not DENOISE_BEFORE_VAD:
    print(
        "[segmenter] denoise filters requested but denoise_before_vad is false; "
        "disabling RNNoise/noisereduce toggles",
        flush=True,
    )
    USE_RNNOISE = False
    USE_NOISEREDUCE = False

# Filter chain instrumentation tunables
FILTER_CHAIN_METRICS_WINDOW = int(
    cfg["segmenter"].get("filter_chain_metrics_window", 50)
)
FILTER_CHAIN_AVG_BUDGET_MS = float(
    cfg["segmenter"].get("filter_chain_avg_budget_ms", max(1.0, FRAME_MS * 0.3))
)
FILTER_CHAIN_PEAK_BUDGET_MS = float(
    cfg["segmenter"].get("filter_chain_peak_budget_ms", max(1.0, FRAME_MS * 0.8))
)
FILTER_CHAIN_LOG_THROTTLE_SEC = float(
    cfg["segmenter"].get("filter_chain_log_throttle_sec", 30.0)
)

_AUTOSPLIT_RAW = cfg["segmenter"].get("autosplit_interval_minutes", 15.0)
_AUTOSPLIT_LIMIT_SECONDS: float | None
_AUTOSPLIT_LIMIT_FRAMES: int | None
try:
    if _AUTOSPLIT_RAW is None:
        raise TypeError("autosplit disabled")
    autosplit_minutes = float(_AUTOSPLIT_RAW)
except (TypeError, ValueError):
    autosplit_minutes = 15.0
    print(
        "[segmenter] WARN: invalid segmenter.autosplit_interval_minutes value; "
        "defaulting to 15 minutes",
        flush=True,
    )
if autosplit_minutes <= 0.0:
    _AUTOSPLIT_LIMIT_SECONDS = None
    _AUTOSPLIT_LIMIT_FRAMES = None
else:
    _AUTOSPLIT_LIMIT_SECONDS = autosplit_minutes * 60.0
    _AUTOSPLIT_LIMIT_FRAMES = max(
        1, int(round((_AUTOSPLIT_LIMIT_SECONDS * 1000.0) / FRAME_MS))
    )

# buffered writes
FLUSH_THRESHOLD = int(cfg["segmenter"]["flush_threshold_bytes"])
MAX_QUEUE_FRAMES = int(cfg["segmenter"]["max_queue_frames"])
MAX_PENDING_ENCODE_JOBS = max(
    1, int(cfg["segmenter"].get("max_pending_encodes", 8))
)


@dataclass
class StartupRecoveryReport:
    """Summary of recovery actions performed during startup."""

    requeued: list[str]
    removed_wavs: list[str]
    removed_artifacts: list[str]

    def any_actions(self) -> bool:
        return bool(self.requeued or self.removed_wavs or self.removed_artifacts)


def _log_recovery(message: str) -> None:
    print(f"[recovery] {message}", flush=True)


def _estimate_rms_from_file(path: Path) -> int:
    total = 0
    count = 0
    chunk_frames = max(1, FRAME_BYTES // SAMPLE_WIDTH)
    try:
        with wave.open(str(path), "rb") as wav_file:
            while True:
                chunk = wav_file.readframes(chunk_frames)
                if not chunk:
                    break
                samples = array.array("h")
                samples.frombytes(chunk)
                if sys.byteorder != "little":
                    samples.byteswap()
                count += len(samples)
                for sample in samples:
                    total += sample * sample
    except (OSError, wave.Error):
        return 0
    if count <= 0:
        return 0
    mean_square = total / count
    return int(math.sqrt(mean_square))


def _derive_final_base(wav_path: Path, rms_value: int) -> str:
    base = wav_path.stem
    parts = base.split("_")
    if len(parts) >= 3:
        event_ts = parts[0]
        event_count = parts[-1]
        event_label = "_".join(parts[1:-1])
    elif len(parts) == 2:
        event_ts, event_count = parts
        event_label = "event"
    else:
        event_ts = parts[0] if parts else datetime.now().strftime("%H-%M-%S")
        event_count = "1"
        event_label = "event"
    if not event_count.isdigit():
        event_count = "1"
    safe_label = _sanitize_event_tag(event_label or "event") or "event"
    rms_component = max(0, int(rms_value))
    return f"{event_ts}_{safe_label}_RMS-{rms_component}_{event_count}"


def _collect_streaming_artifacts(
    day_dir: Path,
    original_base: str,
    final_bases: Iterable[str],
) -> list[Path]:
    artifacts: list[Path] = []
    if day_dir.exists():
        partial_name = f"{original_base}{STREAMING_PARTIAL_SUFFIX}" if STREAMING_PARTIAL_SUFFIX else ""
        if partial_name:
            partial_path = day_dir / partial_name
            artifacts.append(partial_path)
            artifacts.append(partial_path.with_name(partial_path.name + ".waveform.json"))
            artifacts.append(partial_path.with_name(partial_path.name + ".transcript.json"))
        for base in set(final_bases):
            artifacts.extend(day_dir.glob(f".{base}.filtered*"))
    return [p for p in artifacts if p.exists()]


def _parse_event_identity(stem: str) -> tuple[str | None, str | None]:
    parts = stem.split("_")
    if not parts:
        return None, None
    event_ts = parts[0] or None
    event_count = parts[-1] if len(parts) > 1 and parts[-1].isdigit() else None
    return event_ts, event_count


def _find_existing_final_bases(
    recordings_dir: Path,
    preferred_day_dir: Path,
    event_ts: str | None,
    event_count: str | None,
    final_extension: str,
) -> list[str]:
    if not event_ts:
        return []

    if not final_extension.startswith("."):
        final_extension = f".{final_extension}"

    count_pattern = re.escape(event_count) if event_count else r"\d+"
    pattern = re.compile(
        rf"^{re.escape(event_ts)}_.+_RMS-\d+_{count_pattern}{re.escape(final_extension)}$"
    )

    matches: list[str] = []
    search_dirs: list[Path] = []
    if preferred_day_dir.exists():
        search_dirs.append(preferred_day_dir)
    if recordings_dir.exists():
        for candidate_day in recordings_dir.iterdir():
            if not candidate_day.is_dir():
                continue
            if candidate_day in search_dirs:
                continue
            search_dirs.append(candidate_day)

    for day_dir in search_dirs:
        for candidate in day_dir.iterdir():
            if not candidate.is_file():
                continue
            if candidate.suffix != final_extension:
                continue
            if pattern.match(candidate.name):
                matches.append(candidate.stem)
    return matches


def _remove_file(path: Path, report: StartupRecoveryReport, *, category: str) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:
        print(f"[recovery] WARN: failed to remove {category} {path}: {exc!r}", flush=True)
        return
    if category == "wav":
        report.removed_wavs.append(str(path))
    else:
        report.removed_artifacts.append(str(path))
    _log_recovery(f"Removed {category} {path}")


def _cleanup_orphan_partials(
    recordings_dir: Path,
    handled_stems: set[str],
    active_final_bases: set[str],
    report: StartupRecoveryReport,
) -> None:
    if not recordings_dir.exists():
        return
    partial_suffix = STREAMING_PARTIAL_SUFFIX
    for day_dir in recordings_dir.iterdir():
        if not day_dir.is_dir():
            continue
        if partial_suffix:
            for partial in day_dir.glob(f"*{partial_suffix}"):
                base_name = partial.name[: -len(partial_suffix)]
                if base_name in handled_stems:
                    continue
                _remove_file(partial, report, category="artifact")
                for extra in (".waveform.json", ".transcript.json"):
                    aux = partial.with_name(partial.name + extra)
                    _remove_file(aux, report, category="artifact")
        for leftover in day_dir.glob(".*.filtered*"):
            leftover_base = leftover.name[1:].split(".filtered", 1)[0]
            if leftover_base and leftover_base in active_final_bases:
                continue
            _remove_file(leftover, report, category="artifact")


def perform_startup_recovery() -> StartupRecoveryReport:
    """Scan for incomplete recordings and re-queue encode jobs after a crash."""

    report = StartupRecoveryReport(requeued=[], removed_wavs=[], removed_artifacts=[])
    tmp_root = Path(TMP_DIR)
    rec_root = Path(REC_DIR)
    if not tmp_root.exists():
        return report

    final_extension = STREAMING_EXTENSION if STREAMING_EXTENSION.startswith(".") else f".{STREAMING_EXTENSION}"
    handled_stems: set[str] = set()
    active_final_bases: set[str] = set()

    for wav_path in sorted(tmp_root.glob("*.wav")):
        if not wav_path.is_file():
            continue
        handled_stems.add(wav_path.stem)
        try:
            stat = wav_path.stat()
        except OSError as exc:
            print(f"[recovery] WARN: failed to stat {wav_path}: {exc!r}", flush=True)
            continue

        if stat.st_size <= 0:
            _remove_file(wav_path, report, category="wav")
            continue

        day_dir = rec_root / datetime.fromtimestamp(stat.st_mtime).strftime("%Y%m%d")

        event_ts, event_count = _parse_event_identity(wav_path.stem)
        existing_final_bases = _find_existing_final_bases(
            rec_root,
            day_dir,
            event_ts,
            event_count,
            final_extension,
        )

        artifact_bases: list[str] = list(existing_final_bases)
        final_base: str | None = None
        existing_opus_path: str | None = None
        final_opus_path: Path | None = None
        if not existing_final_bases:
            rms_value = _estimate_rms_from_file(wav_path)
            final_base = _derive_final_base(wav_path, rms_value)
            artifact_bases.append(final_base)
            final_opus_path = day_dir / f"{final_base}{final_extension}"

            partial_candidate: Path | None = None
            if STREAMING_PARTIAL_SUFFIX:
                candidate = day_dir / f"{wav_path.stem}{STREAMING_PARTIAL_SUFFIX}"
                if candidate.exists():
                    partial_candidate = candidate

            if final_opus_path.exists():
                existing_opus_path = str(final_opus_path)
            elif partial_candidate is not None:
                try:
                    os.replace(partial_candidate, final_opus_path)
                except Exception as exc:
                    print(
                        (
                            "[recovery] WARN: failed to promote streaming partial "
                            f"{partial_candidate} -> {final_opus_path}: {exc!r}"
                        ),
                        flush=True,
                    )
                    partial_candidate = None
                else:
                    existing_opus_path = str(final_opus_path)
                    _log_recovery(
                        f"Promoted streaming partial {partial_candidate.name} to {final_opus_path.name}"
                    )

            if partial_candidate is not None and existing_opus_path:
                for suffix in (".waveform.json", ".transcript.json"):
                    partial_sidecar = partial_candidate.with_name(partial_candidate.name + suffix)
                    if not partial_sidecar.exists():
                        continue
                    destination = final_opus_path.with_suffix(final_opus_path.suffix + suffix)
                    try:
                        os.replace(partial_sidecar, destination)
                    except Exception as exc:
                        print(
                            (
                                "[recovery] WARN: failed to promote streaming sidecar "
                                f"{partial_sidecar} -> {destination}: {exc!r}"
                            ),
                            flush=True,
                        )
                        continue
                    _log_recovery(
                        f"Promoted streaming sidecar {partial_sidecar.name} to {destination.name}"
                    )

        for artifact in _collect_streaming_artifacts(day_dir, wav_path.stem, artifact_bases):
            _remove_file(artifact, report, category="artifact")

        if existing_final_bases:
            _remove_file(wav_path, report, category="wav")
            continue

        day_dir.mkdir(parents=True, exist_ok=True)
        try:
            assert final_base is not None
            job_id = _enqueue_encode_job(
                str(wav_path),
                final_base,
                source="recovery",
                existing_opus_path=existing_opus_path,
                manual_recording=False,
                target_day=day_dir.name,
            )
        except Exception as exc:  # noqa: BLE001 - log and keep file for manual follow-up
            print(
                f"[recovery] WARN: failed to enqueue encode job for {final_base}: {exc!r}",
                flush=True,
            )
            continue
        _schedule_recordings_refresh(
            job_id,
            final_path=str(final_opus_path) if final_opus_path else None,
            base_name=final_base,
            day=day_dir.name if day_dir.name else None,
            manual=False,
            source="recovery",
        )
        report.requeued.append(final_base)
        active_final_bases.add(final_base)
        _log_recovery(f"Requeued encode for {final_base}")

    _cleanup_orphan_partials(rec_root, handled_stems, active_final_bases, report)
    return report

# Debug logging gate (DEV=1 or logging.dev_mode)
DEBUG_VERBOSE = (cfg["logging"]["dev_mode"])

try:
    if USE_RNNOISE:
        import rnnoise
    if USE_NOISEREDUCE:
        import noisereduce as nr
        import numpy as np
except ImportError:
    print("[segmenter] Noise reduction library missing, continuing without NR")
    USE_RNNOISE = False
    USE_NOISEREDUCE = False
    rnnoise = None  # ensure a symbol exists for type/checkers
    nr = None       # ensure a symbol exists for type/checkers
    np = None       # ensure a symbol exists for type/checkers


def is_voice(buf):
    return vad.is_speech(buf, SAMPLE_RATE)


def rms(buf):
    return pcm16_rms(buf)


# ---------- Async writer worker ----------
class _WriterWorker(threading.Thread):
    """
    Dedicated disk-writer thread.
    Protocol on self.q (audio_q):
      ('open', base_name, tmp_wav_path)
      b'<frame-bytes>' (raw mono 16-bit PCM @ 48k)
      ('close', base_name)
    When a file is closed, we push (tmp_wav_path, base_name) to done_q.
    """
    def __init__(self, audio_q: queue.Queue, done_q: queue.Queue, flush_threshold: int):
        super().__init__(daemon=True)
        self.q = audio_q
        self.done_q = done_q
        self.flush_threshold = flush_threshold
        self.wav = None
        self.base = None
        self.path = None
        self.buf = bytearray()
        self._running = True

    def _flush(self):
        if self.wav and self.buf:
            self.wav.writeframes(self.buf)
            self.buf.clear()

    def _close_file(self):
        if self.wav:
            try:
                self._flush()
                self.wav.close()
            except Exception as e:
                print(f"[writer] close error: {e!r}", flush=True)
            finally:
                try:
                    self.done_q.put_nowait((self.path, self.base))
                except Exception:
                    pass
                self.wav = None
                self.base = None
                self.path = None
                self.buf.clear()

    def run(self):
        while self._running:
            try:
                item = self.q.get(timeout=0.5)
            except queue.Empty:
                continue

            try:
                if item is None:
                    self._close_file()
                    self._running = False
                    break

                if isinstance(item, tuple):
                    tag = item[0]
                    if tag == 'open':
                        _, base, path = item
                        self._close_file()
                        self.base = base
                        self.path = path
                        os.makedirs(os.path.dirname(path), exist_ok=True)
                        self.wav = wave.open(path, "wb")
                        self.wav.setnchannels(1)
                        self.wav.setsampwidth(SAMPLE_WIDTH)
                        self.wav.setframerate(SAMPLE_RATE)
                        self.buf.clear()
                    elif tag == 'close':
                        _, base = item
                        if self.wav and base == self.base:
                            self._close_file()

                elif isinstance(item, (bytes, bytearray, memoryview)):
                    if not self.wav:
                        continue
                    self.buf.extend(item)
                    if len(self.buf) >= self.flush_threshold:
                        self._flush()
            finally:
                self.q.task_done()


# ---------- Streaming Opus encoder helper ----------


@dataclass
class StreamingEncoderResult:
    partial_path: str | None
    success: bool
    returncode: int | None
    error: Exception | None
    stderr: str | None
    bytes_sent: int
    dropped_chunks: int


class StreamingOpusEncoder:
    def __init__(self, partial_path: str, *, container_format: str = "opus") -> None:
        if not partial_path:
            raise ValueError("partial_path is required for StreamingOpusEncoder")
        self.partial_path = partial_path
        self.container_format = container_format if container_format in {"opus", "webm"} else "opus"
        self._process: subprocess.Popen | None = None
        self._queue: queue.Queue[bytes | None] = queue.Queue(maxsize=MAX_QUEUE_FRAMES)
        self._thread: threading.Thread | None = None
        self._bytes_sent = 0
        self._dropped = 0
        self._error: Exception | None = None
        self._stderr: bytes | None = None
        self._returncode: int | None = None
        self._closed = threading.Event()

    def _build_command(self) -> list[str]:
        base_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-c:a",
            "libopus",
            "-b:a",
            "48k",
            "-vbr",
            "on",
            "-application",
            "audio",
            "-frame_duration",
            "20",
            "-f",
            self.container_format,
            self.partial_path,
        ]
        return base_cmd

    def start(self, command: list[str] | None = None) -> None:
        if self._process is not None:
            raise RuntimeError("StreamingOpusEncoder already started")
        os.makedirs(os.path.dirname(self.partial_path), exist_ok=True)
        try:
            if os.path.exists(self.partial_path):
                os.unlink(self.partial_path)
        except OSError:
            pass
        if command is None:
            command = self._build_command()
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except Exception as exc:  # noqa: BLE001 - surface failure upstream
            self._error = exc
            raise

        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        proc = self._process
        if proc is None:
            self._closed.set()
            return
        try:
            stdin = proc.stdin
            if stdin is None:
                raise RuntimeError("encoder stdin unavailable")
            while True:
                try:
                    chunk = self._queue.get(timeout=0.5)
                except queue.Empty:
                    if proc.poll() is not None:
                        break
                    continue

                if chunk is None:
                    self._queue.task_done()
                    break

                try:
                    stdin.write(chunk)
                    if hasattr(stdin, "flush"):
                        stdin.flush()
                    self._bytes_sent += len(chunk)
                except Exception as exc:  # noqa: BLE001 - propagate failure
                    self._error = exc
                    break
                finally:
                    self._queue.task_done()
        finally:
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:
                pass
            try:
                self._stderr = proc.stderr.read() if proc.stderr else None
            except Exception:
                self._stderr = None
            self._returncode = proc.wait()
            self._closed.set()

    def feed(self, chunk: bytes) -> bool:
        if not chunk or self._process is None:
            return False
        try:
            self._queue.put_nowait(bytes(chunk))
            return True
        except queue.Full:
            self._dropped += 1
            return False

    def close(self, *, timeout: float | None = None) -> StreamingEncoderResult:
        if self._process is None:
            return StreamingEncoderResult(
                partial_path=self.partial_path,
                success=False,
                returncode=None,
                error=self._error,
                stderr=None,
                bytes_sent=self._bytes_sent,
                dropped_chunks=self._dropped,
            )

        try:
            self._queue.put_nowait(None)
        except queue.Full:
            worker_alive = self._thread is not None and self._thread.is_alive()
            if worker_alive:
                try:
                    # Avoid hanging forever if the worker stopped draining.
                    block_timeout = timeout if timeout is not None else 1.0
                    self._queue.put(None, timeout=block_timeout)
                except queue.Full:
                    worker_alive = False
            if not worker_alive:
                drained = 0
                while True:
                    try:
                        self._queue.get_nowait()
                    except queue.Empty:
                        break
                    else:
                        self._queue.task_done()
                        drained += 1
                if drained:
                    self._dropped += drained
                try:
                    self._queue.put_nowait(None)
                except queue.Full:
                    pass

        if self._thread is not None:
            self._thread.join(timeout)

        if self._process and self._process.poll() is None:
            try:
                self._process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._returncode = self._process.wait()

        success = self._error is None and (self._returncode or 0) == 0
        stderr_text = None
        if self._stderr:
            try:
                stderr_text = self._stderr.decode("utf-8", errors="ignore")
            except Exception:
                stderr_text = None

        return StreamingEncoderResult(
            partial_path=self.partial_path,
            success=success,
            returncode=self._returncode,
            error=self._error,
            stderr=stderr_text,
            bytes_sent=self._bytes_sent,
            dropped_chunks=self._dropped,
        )


class LiveWaveformWriter:
    """Incrementally publishes waveform JSON for in-progress recordings."""

    def __init__(
        self,
        destination: str,
        *,
        bucket_count: int = LIVE_WAVEFORM_BUCKET_COUNT,
        update_interval: float = LIVE_WAVEFORM_UPDATE_INTERVAL,
        start_epoch: float | None = None,
        trigger_rms: int | None = None,
    ) -> None:
        if not destination:
            raise ValueError("destination is required for LiveWaveformWriter")
        self.destination = destination
        self.bucket_count = max(1, min(bucket_count, MAX_BUCKET_COUNT))
        self.update_interval = max(0.1, float(update_interval))
        self._frames: list[tuple[int, int, float, int]] = []
        self._total_frames = 0
        self._total_samples = 0
        self._last_write = 0.0
        self._lock = threading.Lock()
        self._start_epoch = self._resolve_start_epoch(start_epoch)
        self._trigger_rms = self._sanitize_trigger_rms(trigger_rms)

    @staticmethod
    def _resolve_start_epoch(candidate: float | None) -> float:
        if candidate is None:
            return time.time()
        try:
            value = float(candidate)
        except (TypeError, ValueError):
            return time.time()
        if not math.isfinite(value) or value <= 0.0:
            return time.time()
        return value

    @staticmethod
    def _sanitize_trigger_rms(candidate: int | None) -> int | None:
        if candidate is None:
            return None
        try:
            value = int(candidate)
        except (TypeError, ValueError):
            return None
        if value < 0:
            return 0
        return value

    def add_frame(self, buf: bytes) -> None:
        if not buf:
            return
        samples = array.array("h")
        samples.frombytes(buf)
        if sys.byteorder != "little":
            samples.byteswap()
        if not samples:
            return
        frame_min = min(samples)
        frame_max = max(samples)
        square_sum = 0.0
        for sample in samples:
            square_sum += float(sample) * float(sample)
        sample_count = len(samples)
        with self._lock:
            self._frames.append((frame_min, frame_max, square_sum, sample_count))
            self._total_frames += 1
            self._total_samples += sample_count
            now = time.monotonic()
            if now - self._last_write >= self.update_interval:
                self._write_locked(now)

    def finalize(self) -> None:
        with self._lock:
            self._write_locked(time.monotonic())

    def clear(self) -> None:
        with self._lock:
            self._frames.clear()
            self._total_frames = 0
            self._total_samples = 0
            self._last_write = 0.0

    def _write_locked(self, timestamp: float) -> None:
        if self._total_frames <= 0 or self._total_samples <= 0:
            return
        payload = self._build_payload_locked(timestamp)
        dest_dir = os.path.dirname(self.destination)
        try:
            os.makedirs(dest_dir, exist_ok=True)
        except OSError:
            pass
        tmp_path = f"{self.destination}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
            os.replace(tmp_path, self.destination)
            self._last_write = timestamp
        except Exception:
            with contextlib.suppress(Exception):
                os.unlink(tmp_path)

    def _build_payload_locked(self, timestamp: float) -> dict[str, object]:
        frame_count = self._total_frames
        if frame_count <= 0:
            return {
                "version": 1,
                "channels": 1,
                "sample_rate": SAMPLE_RATE,
                "frame_count": 0,
                "duration_seconds": 0.0,
                "peak_scale": PEAK_SCALE,
                "peaks": [],
                "rms_values": [],
                "updated_epoch": time.time(),
                "start_epoch": self._start_epoch,
                "trigger_rms": self._trigger_rms,
            }

        bucket_count = max(1, min(self.bucket_count, frame_count))
        frames_per_bucket = frame_count / float(bucket_count)
        peaks = [0] * (bucket_count * 2)
        rms_values = [0] * bucket_count

        bucket_min = 32767
        bucket_max = -32768
        bucket_sq = 0.0
        bucket_samples = 0
        bucket_index = 0
        consumed_frames = 0.0
        next_threshold = frames_per_bucket

        for frame_min, frame_max, square_sum, sample_count in self._frames:
            if bucket_index >= bucket_count:
                break
            if frame_min < bucket_min:
                bucket_min = frame_min
            if frame_max > bucket_max:
                bucket_max = frame_max
            bucket_sq += square_sum
            bucket_samples += sample_count
            consumed_frames += 1.0

            if consumed_frames >= next_threshold or bucket_index == bucket_count - 1:
                peaks[bucket_index * 2] = max(-32768, min(32767, bucket_min))
                peaks[bucket_index * 2 + 1] = max(-32768, min(32767, bucket_max))
                if bucket_samples > 0:
                    rms_val = int(round(math.sqrt(bucket_sq / bucket_samples)))
                else:
                    rms_val = 0
                rms_values[bucket_index] = max(0, min(PEAK_SCALE, rms_val))
                bucket_index += 1
                bucket_min = 32767
                bucket_max = -32768
                bucket_sq = 0.0
                bucket_samples = 0
                next_threshold = frames_per_bucket * (bucket_index + 1)

        duration_seconds = frame_count * (FRAME_MS / 1000.0)
        payload = {
            "version": 1,
            "channels": 1,
            "sample_rate": SAMPLE_RATE,
            "frame_count": frame_count,
            "sample_count": self._total_samples,
            "duration_seconds": duration_seconds,
            "peak_scale": PEAK_SCALE,
            "peaks": peaks,
            "rms_values": rms_values,
            "start_epoch": self._start_epoch,
            "updated_epoch": time.time(),
            "trigger_rms": self._trigger_rms,
        }
        return payload

# ---------- Async encoder worker ----------
ENCODE_QUEUE: queue.Queue = queue.Queue(maxsize=MAX_PENDING_ENCODE_JOBS)
_DEFERRED_ENCODE_JOBS: collections.deque[tuple[object, ...]] = collections.deque()
_DEFERRED_LOCK = threading.Lock()
_DEFERRED_EVENT = threading.Event()
_ENCODE_WORKERS: list['_EncoderWorker'] = []
_ENCODE_DISPATCHER: threading.Thread | None = None
_ENCODE_LOCK = threading.Lock()
SHUTDOWN_ENCODE_START_TIMEOUT = 5.0


def _encode_dispatcher_main() -> None:
    while True:
        _DEFERRED_EVENT.wait()
        while True:
            with _DEFERRED_LOCK:
                if not _DEFERRED_ENCODE_JOBS:
                    _DEFERRED_EVENT.clear()
                    break
                payload = _DEFERRED_ENCODE_JOBS.popleft()
            job_id = None
            if isinstance(payload, tuple) and payload:
                candidate = payload[0]
                if isinstance(candidate, int):
                    job_id = candidate
            while True:
                try:
                    ENCODE_QUEUE.put(payload, timeout=1.0)
                except queue.Full:
                    if not _DEFERRED_EVENT.wait(timeout=0.5):
                        continue
                else:
                    if job_id is not None:
                        ENCODING_STATUS.update_pending_state(job_id, "queued")
                    break


def _defer_encode_payload(payload: tuple[object, ...]) -> None:
    with _DEFERRED_LOCK:
        _DEFERRED_ENCODE_JOBS.append(payload)
    _DEFERRED_EVENT.set()


def _try_submit_encode_payload(payload: tuple[object, ...]) -> bool:
    if MAX_PENDING_ENCODE_JOBS <= 0:
        ENCODE_QUEUE.put(payload)
        return True
    try:
        ENCODE_QUEUE.put_nowait(payload)
        return True
    except queue.Full:
        return False


def _append_recordings_event(event_type: str, payload: dict[str, object]) -> None:
    try:
        base_dir = Path(TMP_DIR)
    except Exception:
        return

    spool_dir = base_dir / RECORDINGS_EVENT_SPOOL_DIRNAME
    try:
        spool_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return

    timestamp = time.time()
    identifier = f"{timestamp:.6f}-{uuid.uuid4().hex}"
    final_path = spool_dir / f"{identifier}.json"
    tmp_path = spool_dir / f".{identifier}.tmp"
    record = {"type": event_type, "payload": payload, "timestamp": timestamp}

    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(record, handle)
            handle.write("\n")
        os.replace(tmp_path, final_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def _publish_recordings_event(payload: dict[str, object]) -> None:
    event_type = "recordings_changed"
    event_id: str | None = None
    try:
        event_id = dashboard_events.publish(event_type, payload)
    except Exception:
        event_id = None

    if event_id:
        return

    _append_recordings_event(event_type, payload)


class EncodingStatus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._pending: collections.deque[dict[str, object]] = collections.deque()
        self._active: dict[int, dict[str, object]] = {}
        self._next_id = 1
        self._listeners: list[Callable[[dict[str, object] | None], None]] = []
        self._completion_callbacks: dict[int, list[Callable[[], None]]] = {}

    def register_listener(self, callback: Callable[[dict[str, object] | None], None]) -> None:
        with self._lock:
            self._listeners.append(callback)
        try:
            callback(self.snapshot())
        except Exception:
            pass

    def snapshot(self) -> dict[str, object] | None:
        with self._lock:
            active_items = [dict(entry) for entry in self._active.values()]
            pending = [dict(entry) for entry in self._pending]
        pending_payload = [
            {
                "id": entry.get("id"),
                "base_name": entry.get("base_name", ""),
                "queued_at": entry.get("queued_at"),
                "source": entry.get("source"),
                "status": "pending",
                "queue_state": entry.get("queue_state", "queued"),
            }
            for entry in pending
        ]
        active_payload = [
            {
                "id": entry.get("id"),
                "base_name": entry.get("base_name", ""),
                "queued_at": entry.get("queued_at"),
                "started_at": entry.get("started_at"),
                "source": entry.get("source"),
                "status": "active",
                "queue_state": "active",
            }
            for entry in sorted(
                active_items,
                key=lambda item: (
                    item.get("started_at")
                    or item.get("queued_at")
                    or item.get("id")
                    or 0
                ),
            )
        ]
        if not pending_payload and not active_payload:
            return None
        return {"pending": pending_payload, "active": active_payload}

    def _notify(self) -> None:
        snapshot = self.snapshot()
        with self._lock:
            listeners = list(self._listeners)
        for callback in listeners:
            try:
                callback(snapshot)
            except Exception:
                pass

    def enqueue(
        self,
        base_name: str,
        *,
        source: str = "live",
        queue_state: str = "queued",
    ) -> int:
        with self._cond:
            job_id = self._next_id
            self._next_id += 1
            self._pending.append(
                {
                    "id": job_id,
                    "base_name": base_name,
                    "queued_at": time.time(),
                    "source": source,
                    "queue_state": queue_state,
                }
            )
            self._cond.notify_all()
        self._notify()
        return job_id

    def update_pending_state(self, job_id: int, state: str) -> None:
        updated = False
        with self._cond:
            for entry in self._pending:
                if entry.get("id") == job_id:
                    entry["queue_state"] = state
                    updated = True
                    self._cond.notify_all()
                    break
        if updated:
            self._notify()

    def register_completion_callback(self, job_id: int, callback: Callable[[], None]) -> None:
        if not callable(callback):
            return
        call_immediately = False
        with self._cond:
            active = job_id in self._active
            pending = any(entry.get("id") == job_id for entry in self._pending)
            if not active and not pending:
                call_immediately = True
            else:
                callbacks = self._completion_callbacks.setdefault(job_id, [])
                callbacks.append(callback)
        if call_immediately:
            try:
                callback()
            except Exception:
                pass

    def mark_started(self, job_id: int, base_name: str) -> None:
        with self._cond:
            job = None
            for entry in list(self._pending):
                if entry.get("id") == job_id:
                    job = entry
                    self._pending.remove(entry)
                    break
            if job is None:
                job = {
                    "id": job_id,
                    "base_name": base_name,
                    "queued_at": time.time(),
                    "source": "unknown",
                }
            else:
                job["base_name"] = base_name
                if "source" not in job or not isinstance(job.get("source"), str):
                    job["source"] = "unknown"
            job["queue_state"] = "active"
            job["started_at"] = time.time()
            self._active[job_id] = job
            self._cond.notify_all()
        self._notify()

    def mark_finished(self, job_id: int) -> None:
        callbacks: list[Callable[[], None]] | None = None
        with self._cond:
            self._active.pop(job_id, None)
            if job_id in self._completion_callbacks:
                callbacks = self._completion_callbacks.pop(job_id, None)
            self._cond.notify_all()
        self._notify()
        if callbacks:
            for callback in list(callbacks):
                try:
                    callback()
                except Exception:
                    pass

    def wait_for_start(self, job_id: int, timeout: float | None = None) -> bool:
        deadline: float | None = None
        if timeout is not None:
            deadline = time.monotonic() + timeout

        with self._cond:
            while True:
                if job_id in self._active:
                    return True

                if not any(entry.get("id") == job_id for entry in self._pending):
                    return True

                if timeout is None:
                    self._cond.wait()
                    continue

                assert deadline is not None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)

    def wait_for_finish(self, job_id: int, timeout: float | None = None) -> bool:
        deadline: float | None = None
        if timeout is not None:
            deadline = time.monotonic() + timeout

        with self._cond:
            while True:
                active_match = job_id in self._active
                pending_match = any(entry.get("id") == job_id for entry in self._pending)
                if not active_match and not pending_match:
                    return True

                if timeout is None:
                    self._cond.wait()
                    continue

                assert deadline is not None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)

    def wait_for_all(self, timeout: float | None = None) -> bool:
        """Wait until all pending and active jobs have finished."""

        deadline: float | None = None
        if timeout is not None:
            deadline = time.monotonic() + timeout

        with self._cond:
            while True:
                if not self._active and not self._pending:
                    return True

                if timeout is None:
                    self._cond.wait()
                    continue

                assert deadline is not None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)


ENCODING_STATUS = EncodingStatus()


class _EncoderWorker(threading.Thread):
    def __init__(self, job_queue: queue.Queue):
        super().__init__(daemon=True)
        self.q = job_queue

    def _wait_for_cpu(self) -> None:
        if PARALLEL_OFFLINE_LOAD_THRESHOLD <= 0.0:
            return
        while True:
            normalized = _normalized_load()
            if normalized is None or normalized <= PARALLEL_OFFLINE_LOAD_THRESHOLD:
                return
            time.sleep(PARALLEL_OFFLINE_CHECK_INTERVAL)

    def run(self):
        while True:
            item = self.q.get()
            try:
                if item is None:
                    return

                job_id: int | None
                wav_path: str
                base_name: str
                existing_opus: str | None = None
                manual_recording = False
                target_day: str | None = None
                if isinstance(item, tuple) and len(item) >= 6:
                    job_id, wav_path, base_name, existing_opus, manual_flag, target_day = item[:6]
                    manual_recording = bool(manual_flag)
                    target_day = str(target_day) if target_day else None
                elif isinstance(item, tuple) and len(item) >= 5:
                    job_id, wav_path, base_name, existing_opus, manual_flag = item[:5]
                    manual_recording = bool(manual_flag)
                elif isinstance(item, tuple) and len(item) == 4:
                    job_id, wav_path, base_name, existing_opus = item
                elif isinstance(item, tuple) and len(item) == 3:
                    job_id, wav_path, base_name = item
                else:
                    job_id = None
                    if isinstance(item, tuple):
                        wav_path = item[0]
                        base_name = item[1]
                        if len(item) >= 3:
                            existing_opus = item[2]
                        if len(item) >= 4:
                            manual_recording = bool(item[3])
                        if len(item) >= 5:
                            candidate_day = item[4]
                            target_day = str(candidate_day) if candidate_day else None
                    else:
                        wav_path, base_name = item  # type: ignore[assignment]
                if job_id is not None:
                    ENCODING_STATUS.mark_started(job_id, base_name)
                self._wait_for_cpu()
                cmd = [ENCODER, wav_path, base_name]
                if existing_opus:
                    cmd.append(existing_opus)
                env = os.environ.copy()
                if manual_recording:
                    env["DENOISE"] = "0"
                env.setdefault("STREAMING_CONTAINER_FORMAT", STREAMING_CONTAINER_FORMAT)
                env.setdefault("STREAMING_EXTENSION", STREAMING_EXTENSION)
                env.setdefault("ENCODER_MIN_CLIP_SECONDS", str(MIN_CLIP_SECONDS))
                if target_day:
                    day_component = target_day.strip()
                    if len(day_component) == 8 and day_component.isdigit():
                        env["ENCODER_TARGET_DAY"] = day_component
                preexec: Callable[[], None] | None = None
                if os.name == "posix":
                    preexec = _set_single_core_affinity
                try:
                    subprocess.run(
                        cmd,
                        capture_output=True,
                        text=True,
                        check=True,
                        env=env,
                        preexec_fn=preexec,
                    )
                except subprocess.CalledProcessError as exc:
                    print(f"[encoder] FAIL {exc.returncode}", flush=True)
                    if exc.stdout:
                        print(exc.stdout, flush=True)
                    if exc.stderr:
                        print(exc.stderr, flush=True)
                except Exception as exc:  # noqa: BLE001 - log and continue
                    print(f"[encoder] unexpected error: {exc!r}", flush=True)
                finally:
                    if job_id is not None:
                        ENCODING_STATUS.mark_finished(job_id)
            finally:
                self.q.task_done()


def _ensure_encoder_worker() -> None:
    global _ENCODE_WORKERS, _ENCODE_DISPATCHER
    with _ENCODE_LOCK:
        alive = []
        for worker in _ENCODE_WORKERS:
            if worker.is_alive():
                alive.append(worker)
        _ENCODE_WORKERS = alive
        needed = max(0, PARALLEL_OFFLINE_MAX_WORKERS - len(_ENCODE_WORKERS))
        for _ in range(needed):
            worker = _EncoderWorker(ENCODE_QUEUE)
            worker.start()
            _ENCODE_WORKERS.append(worker)
        if _ENCODE_DISPATCHER is None or not _ENCODE_DISPATCHER.is_alive():
            dispatcher = threading.Thread(
                target=_encode_dispatcher_main,
                name="encode-dispatcher",
                daemon=True,
            )
            dispatcher.start()
            _ENCODE_DISPATCHER = dispatcher


def _enqueue_encode_job(
    tmp_wav_path: str,
    base_name: str,
    *,
    source: str = "live",
    existing_opus_path: str | None = None,
    manual_recording: bool = False,
    target_day: str | None = None,
) -> int | None:
    if not tmp_wav_path or not base_name:
        return None
    _ensure_encoder_worker()
    job_id = ENCODING_STATUS.enqueue(base_name, source=source, queue_state="queued")
    day_component: str | None = None
    if target_day:
        candidate = target_day.strip()
        if len(candidate) == 8 and candidate.isdigit():
            day_component = candidate

    payload = (
        job_id,
        tmp_wav_path,
        base_name,
        existing_opus_path,
        bool(manual_recording),
    )
    if day_component:
        payload += (day_component,)
    if _try_submit_encode_payload(payload):
        print(f"[segmenter] queued encode job for {base_name}", flush=True)
        return job_id

    ENCODING_STATUS.update_pending_state(job_id, "deferred")
    _defer_encode_payload(payload)
    with _DEFERRED_LOCK:
        deferred_count = len(_DEFERRED_ENCODE_JOBS)
    pending_count = ENCODE_QUEUE.qsize()
    print(
        f"[segmenter] encode queue full; deferred job for {base_name} "
        f"(pending={pending_count}, deferred={deferred_count})",
        flush=True,
    )
    return job_id


def _relative_recordings_path(path: str | os.PathLike[str]) -> str | None:
    try:
        recordings_root = Path(REC_DIR)
    except Exception:
        return None

    candidate = Path(path)
    try:
        resolved = recordings_root.resolve()
    except Exception:
        resolved = recordings_root

    try:
        return candidate.resolve().relative_to(resolved).as_posix()
    except Exception:
        try:
            return candidate.relative_to(recordings_root).as_posix()
        except Exception:
            return None


def _schedule_recordings_refresh(
    job_id: int | None,
    *,
    final_path: str | None,
    base_name: str,
    day: str | None,
    manual: bool,
    source: str | None,
) -> None:
    if job_id is None:
        return

    def _publish_refresh() -> None:
        payload: dict[str, object] = {
            "reason": "encode_completed",
            "base_name": base_name,
            "manual": bool(manual),
            "updated_at": time.time(),
        }
        if day:
            payload["day"] = day
        if source:
            payload["source"] = source

        if final_path:
            path_obj = Path(final_path)
            rel_path = _relative_recordings_path(path_obj)
            exists = path_obj.exists()
            if rel_path and exists:
                payload["paths"] = [rel_path]
            if not exists:
                payload["missing"] = True

        _publish_recordings_event(payload)

    ENCODING_STATUS.register_completion_callback(job_id, _publish_refresh)


class AdaptiveRmsController:
    _NORM = 32768.0

    def __init__(
        self,
        *,
        frame_ms: int,
        initial_linear_threshold: int,
        cfg_section: dict[str, object] | None,
        debug: bool = True, # noqa: for future implementation
    ) -> None:
        section = cfg_section or {}
        self.enabled = bool(section.get("enabled", False))

        min_candidates: list[float] = []
        static_norm = max(0.0, min(initial_linear_threshold / self._NORM, 1.0))
        min_candidates.append(static_norm)

        raw_min_thresh = section.get("min_thresh")
        try:
            if isinstance(raw_min_thresh, (int, float)) and not isinstance(raw_min_thresh, bool):
                min_candidates.append(max(0.0, min(float(raw_min_thresh), 1.0)))
        except (TypeError, ValueError):
            pass

        raw_min_rms = section.get("min_rms")
        if isinstance(raw_min_rms, (int, float)) and not isinstance(raw_min_rms, bool):
            if math.isfinite(float(raw_min_rms)):
                candidate = int(round(float(raw_min_rms)))
                if candidate > 0:
                    min_candidates.append(min(1.0, candidate / self._NORM))

        self.min_thresh_norm = min(1.0, max(min_candidates) if min_candidates else 0.0)
        try:
            raw_max = float(section.get("max_thresh", 1.0))
        except (TypeError, ValueError):
            raw_max = 1.0
        self.max_thresh_norm = min(1.0, max(self.min_thresh_norm, raw_max))
        self._max_threshold_linear: int | None = None
        max_rms_raw = section.get("max_rms")
        if isinstance(max_rms_raw, (int, float)) and not isinstance(max_rms_raw, bool):
            if math.isfinite(float(max_rms_raw)):
                candidate = int(round(float(max_rms_raw)))
                if candidate > 0:
                    self._max_threshold_linear = candidate
                    linear_norm = min(1.0, candidate / self._NORM)
                    self.max_thresh_norm = min(
                        self.max_thresh_norm,
                        max(self.min_thresh_norm, linear_norm),
                    )
        self.margin = max(0.0, float(section.get("margin", 1.2)))
        self.update_interval = max(0.1, float(section.get("update_interval_sec", 5.0)))
        default_voiced_hold = max(self.update_interval, 6.0)
        try:
            raw_hold = float(section.get("voiced_hold_sec", default_voiced_hold))
        except (TypeError, ValueError):
            raw_hold = default_voiced_hold
        self.voiced_hold_sec = max(0.0, raw_hold)
        self.hysteresis_tolerance = max(0.0, float(section.get("hysteresis_tolerance", 0.1)))
        self.release_percentile = min(1.0, max(0.01, float(section.get("release_percentile", 0.5))))
        window_sec = max(0.1, float(section.get("window_sec", 10.0)))
        window_frames = max(1, int(round((window_sec * 1000.0) / frame_ms)))
        self._buffer: collections.deque[float] = collections.deque(maxlen=window_frames)
        self._last_update = time.monotonic()
        self._last_buffer_extend = self._last_update
        self._voiced_fallback_active = False
        self._voiced_fallback_logged = False
        self._last_p95: float | None = None
        self._last_candidate: float | None = None
        self._last_release: float | None = None
        self._last_observation: AdaptiveRmsObservation | None = None
        initial_norm = max(0.0, min(initial_linear_threshold / self._NORM, 1.0))
        if self.enabled:
            initial_norm = min(self.max_thresh_norm, initial_norm)
            initial_norm = max(self.min_thresh_norm, initial_norm)
        self._current_norm = initial_norm
        self.debug = bool(debug)

    @property
    def threshold_linear(self) -> int:
        if not self.enabled:
            return int(self._current_norm * self._NORM)
        value = int(round(self._current_norm * self._NORM))
        if self._max_threshold_linear is not None:
            return min(value, self._max_threshold_linear)
        return value

    @property
    def max_threshold_linear(self) -> int | None:
        if self._max_threshold_linear is not None:
            return self._max_threshold_linear
        if self.max_thresh_norm >= 1.0:
            return None
        return int(round(self.max_thresh_norm * self._NORM))

    @property
    def threshold_norm(self) -> float:
        return self._current_norm

    @property
    def last_p95(self) -> float | None:
        return self._last_p95

    @property
    def last_candidate(self) -> float | None:
        return self._last_candidate

    @property
    def last_release(self) -> float | None:
        return self._last_release

    def pop_observation(self) -> AdaptiveRmsObservation | None:
        observation, self._last_observation = self._last_observation, None
        return observation

    def observe(self, rms_value: int, voiced: bool, *, capturing: bool = False) -> bool:
        if not self.enabled:
            self._last_observation = None
            return False

        norm = max(0.0, min(rms_value / self._NORM, 1.0))
        now = time.monotonic()

        if not capturing:
            self._voiced_fallback_active = False
            self._voiced_fallback_logged = False

        if not voiced:
            self._buffer.append(norm)
            self._last_buffer_extend = now
            self._voiced_fallback_active = False
            self._voiced_fallback_logged = False
        elif capturing:
            allow_fallback = False
            if self.voiced_hold_sec == 0.0:
                allow_fallback = True
            elif (now - self._last_buffer_extend) >= self.voiced_hold_sec:
                allow_fallback = True
            elif self._voiced_fallback_active:
                allow_fallback = True

            if allow_fallback:
                if not self._voiced_fallback_active:
                    self._voiced_fallback_active = True
                    if self.voiced_hold_sec > 0.0 and not self._voiced_fallback_logged:
                        gap = max(0.0, now - self._last_buffer_extend)
                        print(
                            "[segmenter] adaptive RMS enabling voiced fallback after "
                            f"{gap:.1f}s without background samples",
                            flush=True,
                        )
                        self._voiced_fallback_logged = True
                self._buffer.append(norm)
                self._last_buffer_extend = now

        if (now - self._last_update) < self.update_interval:
            self._last_observation = None
            return False

        if not self._buffer:
            self._last_observation = None
            return False

        self._last_update = now
        ordered = sorted(self._buffer)
        idx = max(0, int(math.ceil(0.95 * len(ordered)) - 1))
        p95 = ordered[idx]
        candidate_raise = min(self.max_thresh_norm, max(self.min_thresh_norm, p95 * self.margin))
        rel_idx = max(0, int(math.ceil(self.release_percentile * len(ordered)) - 1))
        release_val = ordered[rel_idx]
        candidate_release = min(
            self.max_thresh_norm,
            max(self.min_thresh_norm, release_val * self.margin),
        )
        if (
            # Require both gates to move upward before raising the threshold.
            # This avoids ping-ponging when the long-tail release sample still
            # recommends holding steady.
            candidate_raise > self._current_norm
            and candidate_release > self._current_norm
        ):
            candidate = candidate_raise
        elif candidate_release < self._current_norm:
            candidate = candidate_release
        else:
            candidate = self._current_norm
        self._last_p95 = p95
        self._last_candidate = candidate
        self._last_release = release_val

        previous_norm = self._current_norm
        if self._current_norm <= 0.0:
            should_update = True
        else:
            delta = abs(candidate - self._current_norm)
            should_update = (delta / self._current_norm) >= self.hysteresis_tolerance

        if should_update:
            self._current_norm = min(candidate, self.max_thresh_norm)
        final_threshold = int(round(self._current_norm * self._NORM))
        previous_threshold = int(round(previous_norm * self._NORM))
        candidate_threshold = int(round(candidate * self._NORM))
        if self._max_threshold_linear is not None:
            final_threshold = min(final_threshold, self._max_threshold_linear)
            previous_threshold = min(previous_threshold, self._max_threshold_linear)
            candidate_threshold = min(candidate_threshold, self._max_threshold_linear)
        self._last_observation = AdaptiveRmsObservation(
            timestamp=time.time(),
            updated=bool(should_update),
            threshold_linear=final_threshold,
            previous_threshold_linear=previous_threshold,
            candidate_threshold_linear=candidate_threshold,
            p95_norm=p95,
            release_norm=release_val,
            buffer_size=len(self._buffer),
            rms_value=int(rms_value),
            voiced=bool(voiced),
        )
        return should_update


class TimelineRecorder:
    event_counters = collections.defaultdict(int)

    def __init__(
        self,
        ingest_hint: Optional[RecorderIngestHint] = None,
        *,
        status_mode: str = "live",
        recording_source: str = "live",
    ):
        self.prebuf = collections.deque(maxlen=PRE_PAD_FRAMES)
        self.active = False
        self.post_count = 0

        self.recent_active = collections.deque(maxlen=KEEP_WINDOW)
        self.consec_active = 0
        self.consec_inactive = 0

        self.last_log = time.monotonic()

        # Rolling debug stats (approx. last 1s worth of frames)
        self._dbg_win = max(1, 1000 // FRAME_MS)
        self._dbg_rms = collections.deque(maxlen=self._dbg_win)
        self._dbg_voiced = collections.deque(maxlen=self._dbg_win)

        self.audio_q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE_FRAMES)
        self.done_q: queue.Queue = queue.Queue(maxsize=2)
        self.writer = _WriterWorker(self.audio_q, self.done_q, FLUSH_THRESHOLD)
        self.writer.start()

        self._streaming_enabled = STREAMING_ENCODE_ENABLED
        self._streaming_encoder: StreamingOpusEncoder | None = None
        self._streaming_day_dir: str | None = None

        self._parallel_encode_allowed = bool(
            PARALLEL_ENCODE_ENABLED and not self._streaming_enabled
        )
        self._parallel_encoder: StreamingOpusEncoder | None = None
        self._parallel_partial_path: str | None = None
        self._parallel_encoder_started_at: float | None = None
        self._parallel_encoder_drops: int = 0
        self._parallel_last_check: float = 0.0
        self._parallel_day_dir: str | None = None

        self._autosplit_limit_seconds = _AUTOSPLIT_LIMIT_SECONDS
        self._autosplit_limit_frames = _AUTOSPLIT_LIMIT_FRAMES

        self._live_waveform: LiveWaveformWriter | None = None
        self._live_waveform_path: str | None = None
        self._live_waveform_rel_path: str | None = None

        self._adaptive = AdaptiveRmsController(
            frame_ms=FRAME_MS,
            initial_linear_threshold=STATIC_RMS_THRESH,
            cfg_section=cfg.get("adaptive_rms"),
            debug=DEBUG_VERBOSE,
        )

        self.base_name: str | None = None
        self.tmp_wav_path: str | None = None
        self.event_timestamp: str | None = None
        self.event_counter: int | None = None
        self.trigger_rms: int | None = None
        self.writer_queue_drops = 0
        self.streaming_queue_drops = 0

        self.frames_written = 0
        self.sum_rms = 0
        self.saw_voiced = False
        self.saw_loud = False

        self._ingest_hint: Optional[RecorderIngestHint] = ingest_hint
        self._ingest_hint_used = False
        self._encode_jobs: list[int] = []
        self._manual_split_requested = False
        self._manual_stop_requested = False
        self._manual_recording = False
        self._event_manual_recording = False
        self._manual_motion_released = False
        self._rms_trigger_enabled = bool(RMS_TRIGGER_ENABLED)
        self._vad_trigger_enabled = bool(VAD_TRIGGER_ENABLED)
        self._auto_recording_enabled = True
        self._motion_override_enabled = bool(AUTO_RECORD_MOTION_OVERRIDE)
        self._motion_override_event_active = False

        self.status_path = os.path.join(TMP_DIR, "segmenter_status.json")
        self._status_cache: dict[str, object] | None = None
        self._status_lock = threading.Lock()
        self._encoding_status: dict[str, object] | None = None
        normalized_mode = status_mode.strip().lower() if isinstance(status_mode, str) else "live"
        if normalized_mode not in {"live", "ingest"}:
            raise ValueError("status_mode must be 'live' or 'ingest'")
        self._status_mode = normalized_mode
        normalized_source = (
            recording_source.strip().lower()
            if isinstance(recording_source, str)
            else "live"
        )
        self._recording_source = normalized_source or "live"
        if self._status_mode == "ingest":
            self._load_status_cache_from_disk()
        ENCODING_STATUS.register_listener(self._handle_encoding_status_change)
        self.event_started_epoch: float | None = None
        self.event_day: str | None = None
        self._metrics_interval = 0.5
        self._last_metrics_update = 0.0
        self._last_metrics_value: int | None = None
        self._last_metrics_threshold: int | None = None
        self._filter_chain_samples: collections.deque[float] = collections.deque(
            maxlen=max(1, FILTER_CHAIN_METRICS_WINDOW)
        )
        self._filter_avg_ms: float = 0.0
        self._filter_peak_ms: float = 0.0
        self._filter_last_log_ts: float = 0.0
        self._motion_state_path = os.path.join(TMP_DIR, MOTION_STATE_FILENAME)
        self._motion_watcher = MotionStateWatcher(self._motion_state_path)
        motion_state = self._motion_watcher.state
        self._motion_forced_active = bool(motion_state.active)
        self._motion_active_since: float | None = (
            motion_state.active_since if motion_state.active else None
        )
        self._motion_pending_start = bool(self._motion_forced_active)
        self._motion_sequence = motion_state.sequence
        self._current_motion_event_start: float | None = (
            motion_state.active_since if motion_state.active else None
        )
        self._current_motion_event_end: float | None = None
        self._motion_event_segments: list[dict[str, float | None]] = []
        if self._current_motion_event_start is not None:
            try:
                initial_start = float(self._current_motion_event_start)
            except (TypeError, ValueError):
                initial_start = None
            if initial_start is not None:
                self._motion_event_segments.append(
                    {"start": initial_start, "end": None}
                )
        self._motion_release_padding_seconds = float(MOTION_RELEASE_PADDING_SECONDS)
        self._motion_release_deadline: float | None = None
        self._motion_padding_started_at: float | None = None
        if self._motion_pending_start and START_CONSECUTIVE > 0:
            self.consec_active = max(self.consec_active, START_CONSECUTIVE - 1)
            self.consec_inactive = 0
        if self._status_mode == "live":
            self._update_capture_status(
                False,
                reason="idle",
                extra={
                    "service_running": True,
                    "current_rms": 0,
                    "event_duration_seconds": None,
                    "event_size_bytes": None,
                    "partial_recording_path": None,
                    "streaming_container_format": None,
                    "manual_recording": False,
                    "auto_recording_enabled": bool(self._auto_recording_enabled),
                    "auto_record_motion_override": bool(self._motion_override_enabled),
                    **self._motion_status_extra(),
                },
            )

    def _load_status_cache_from_disk(self) -> None:
        if not self.status_path:
            return
        try:
            with open(self.status_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return
        if isinstance(data, dict):
            self._status_cache = data

    def _update_capture_status(
        self,
        capturing: bool,
        *,
        event: dict | None = None,
        last_event: dict | None = None,
        reason: str | None = None,
        extra: dict[str, object] | None = None,
    ) -> None:
        with self._status_lock:
            if self._status_mode == "ingest" and self._status_cache is None:
                self._load_status_cache_from_disk()
            payload: dict[str, object] = {}
            if isinstance(self._status_cache, dict):
                payload.update(self._status_cache)

            effective_capturing = bool(capturing)
            if self._status_mode == "ingest":
                effective_capturing = bool(payload.get("capturing", False))

            payload["capturing"] = effective_capturing
            payload["updated_at"] = time.time()
            if self._status_mode == "live":
                payload["adaptive_rms_threshold"] = int(self._adaptive.threshold_linear)
            elif "adaptive_rms_threshold" not in payload:
                payload["adaptive_rms_threshold"] = int(self._adaptive.threshold_linear)
            payload["adaptive_rms_enabled"] = bool(self._adaptive.enabled)
            payload["manual_recording"] = bool(getattr(self, "_manual_recording", False))
            payload["auto_recording_enabled"] = bool(
                getattr(self, "_auto_recording_enabled", True)
            )
            payload["auto_record_motion_override"] = bool(
                getattr(self, "_motion_override_enabled", False)
            )
            autosplit_seconds = getattr(self, "_autosplit_limit_seconds", None)
            if autosplit_seconds and autosplit_seconds > 0:
                payload["autosplit_config_seconds"] = float(autosplit_seconds)
            else:
                payload.pop("autosplit_config_seconds", None)

            if self._status_mode == "live":
                if effective_capturing and event:
                    payload["event"] = event
                    payload.pop("last_event", None)
                if not effective_capturing and last_event:
                    payload["last_event"] = last_event
                if not effective_capturing and "event" in payload:
                    payload.pop("event", None)
                if reason:
                    payload["last_stop_reason"] = reason
            if self._encoding_status:
                payload["encoding"] = self._encoding_status
            else:
                payload.pop("encoding", None)

            compare_keys = (
                "capturing",
                "event",
                "last_event",
                "last_stop_reason",
                "adaptive_rms_threshold",
                "current_rms",
                "adaptive_rms_enabled",
                "service_running",
                "event_duration_seconds",
                "event_size_bytes",
                "partial_recording_path",
                "streaming_container_format",
                "partial_waveform_path",
                "partial_waveform_rel_path",
                "encoding",
                "manual_recording",
                "auto_recording_enabled",
                "auto_record_motion_override",
                "autosplit_config_seconds",
            )
            if extra and self._status_mode == "live":
                for key, value in extra.items():
                    if value is None:
                        payload.pop(key, None)
                    else:
                        payload[key] = value
            if self._status_cache is not None:
                previous = {key: self._status_cache.get(key) for key in compare_keys}
                current = {key: payload.get(key) for key in compare_keys}
                if previous == current:
                    self._status_cache = payload
                    return

            self._status_cache = payload
            tmp_path = f"{self.status_path}.tmp"
            try:
                os.makedirs(os.path.dirname(self.status_path), exist_ok=True)
                with open(tmp_path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle)
                    handle.write("\n")
                os.replace(tmp_path, self.status_path)
                dashboard_events.publish("capture_status", payload)
            except Exception as exc:  # pragma: no cover - diagnostics only in DEV builds
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
                if DEBUG_VERBOSE:
                    print(f"[segmenter] WARN: failed to write capture status: {exc!r}", flush=True)

    def _handle_encoding_status_change(self, snapshot: dict[str, object] | None) -> None:
        with self._status_lock:
            self._encoding_status = snapshot if snapshot else None
            cache_ready = self._status_cache is not None
        if cache_ready:
            self._refresh_capture_status()

    def _refresh_capture_status(self) -> None:
        capturing, event, last_event, reason = self._status_snapshot()
        self._update_capture_status(
            capturing,
            event=event,
            last_event=last_event,
            reason=reason,
        )

    def _motion_status_extra(self) -> dict[str, object]:
        watcher = getattr(self, '_motion_watcher', None)
        motion_state = watcher.state if watcher is not None else None
        sequence = motion_state.sequence if motion_state is not None else 0
        payload: dict[str, object] = {
            "motion_active": bool(getattr(self, '_motion_forced_active', False)),
            "motion_sequence": int(sequence),
        }
        if motion_state is not None:
            snapshot = motion_state.to_payload(include_events=False)
            snapshot.setdefault("motion_active", motion_state.active)
            if "motion_active_since" not in snapshot:
                snapshot["motion_active_since"] = None
            payload["motion_state"] = snapshot
        since = getattr(self, '_motion_active_since', None)
        if payload["motion_active"] and since is not None:
            payload["motion_active_since"] = float(since)
        else:
            payload["motion_active_since"] = None
        padding_seconds = float(getattr(self, "_motion_release_padding_seconds", 0.0))
        payload["motion_padding_config_seconds"] = padding_seconds
        deadline = getattr(self, "_motion_release_deadline", None)
        if deadline is not None:
            remaining = float(deadline - time.time())
            payload["motion_padding_seconds_remaining"] = max(0.0, remaining)
            try:
                payload["motion_padding_deadline_epoch"] = float(deadline)
            except (TypeError, ValueError):
                payload.pop("motion_padding_deadline_epoch", None)
            started = getattr(self, "_motion_padding_started_at", None)
            if started is not None:
                try:
                    payload["motion_padding_started_epoch"] = float(started)
                except (TypeError, ValueError):
                    payload.pop("motion_padding_started_epoch", None)
        else:
            payload["motion_padding_seconds_remaining"] = 0.0
            payload.pop("motion_padding_deadline_epoch", None)
            payload.pop("motion_padding_started_epoch", None)
        return payload

    def _reset_motion_segments(self) -> None:
        self._motion_event_segments = []

    def _record_motion_segment_start(self, start_epoch: float | None) -> None:
        try:
            start_value = float(start_epoch)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return
        segments = getattr(self, "_motion_event_segments", None)
        if segments is None:
            segments = []
            self._motion_event_segments = segments
        if segments and segments[-1].get("end") is None:
            current_start = segments[-1].get("start")
            if not isinstance(current_start, (int, float)) or start_value < float(current_start):
                segments[-1]["start"] = start_value
        else:
            segments.append({"start": start_value, "end": None})
        if self._current_motion_event_start is None:
            self._current_motion_event_start = start_value
        else:
            try:
                current = float(self._current_motion_event_start)
            except (TypeError, ValueError):
                self._current_motion_event_start = start_value
            else:
                if start_value < current:
                    self._current_motion_event_start = start_value

    def _record_motion_segment_end(self, end_epoch: float | None) -> None:
        try:
            end_value = float(end_epoch)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return
        segments = getattr(self, "_motion_event_segments", None)
        if not segments:
            self._motion_event_segments = [{"start": None, "end": end_value}]
        else:
            current = segments[-1]
            start_value = current.get("start")
            if isinstance(start_value, (int, float)) and end_value < float(start_value):
                end_value = float(start_value)
            current["end"] = end_value
        self._current_motion_event_end = end_value

    def _motion_segments_offsets(
        self,
        *,
        duration_seconds: float | None = None,
    ) -> list[dict[str, float | None]]:
        start_epoch = self.event_started_epoch
        segments = getattr(self, "_motion_event_segments", None)
        if start_epoch is None or not segments:
            return []
        if duration_seconds is None and self.frames_written > 0:
            duration_seconds = self.frames_written * (FRAME_MS / 1000.0)
        duration = (
            float(duration_seconds)
            if isinstance(duration_seconds, (int, float)) and duration_seconds > 0
            else None
        )
        offsets: list[dict[str, float | None]] = []
        for entry in segments:
            raw_start = entry.get("start")
            if raw_start is None:
                continue
            try:
                start_offset = max(0.0, float(raw_start) - float(start_epoch))
            except (TypeError, ValueError):
                continue
            if duration is not None:
                start_offset = min(start_offset, duration)
            end_offset: float | None = None
            raw_end = entry.get("end")
            if raw_end is not None:
                try:
                    end_offset = max(0.0, float(raw_end) - float(start_epoch))
                except (TypeError, ValueError):
                    end_offset = None
                else:
                    if duration is not None:
                        end_offset = min(end_offset, duration)
                    if end_offset < start_offset:
                        end_offset = start_offset
            offsets.append({"start": start_offset, "end": end_offset})
        return offsets

    def _motion_offset_values(
        self,
        *,
        duration_seconds: float | None = None,
    ) -> dict[str, float | None]:
        offsets = self._motion_segments_offsets(
            duration_seconds=duration_seconds
        )
        if not offsets:
            return {
                "motion_trigger_offset_seconds": None,
                "motion_release_offset_seconds": None,
            }

        trigger_offset = offsets[0].get("start")
        release_offset: float | None = None
        for entry in reversed(offsets):
            candidate = entry.get("end")
            if isinstance(candidate, (int, float)):
                release_offset = float(candidate)
                break
        if release_offset is None and offsets:
            last = offsets[-1]
            last_start = last.get("start")
            if isinstance(last_start, (int, float)):
                release_offset = float(last_start)

        return {
            "motion_trigger_offset_seconds": trigger_offset,
            "motion_release_offset_seconds": release_offset,
        }

    def _current_motion_event_payload(
        self,
        *,
        for_last_event: bool = False,
        duration_seconds: float | None = None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {}
        start_epoch = getattr(self, '_current_motion_event_start', None)
        if start_epoch is not None:
            payload["motion_started_epoch"] = float(start_epoch)
        end_epoch = getattr(self, '_current_motion_event_end', None)
        if end_epoch is not None:
            payload["motion_released_epoch"] = float(end_epoch)
        offsets = self._motion_offset_values(duration_seconds=duration_seconds)
        payload["motion_trigger_offset_seconds"] = offsets["motion_trigger_offset_seconds"]
        payload["motion_release_offset_seconds"] = offsets["motion_release_offset_seconds"]
        segments = self._motion_segments_offsets(duration_seconds=duration_seconds)
        if segments:
            payload["motion_segments"] = segments
        watcher = getattr(self, '_motion_watcher', None)
        motion_state = watcher.state if watcher is not None else None
        if motion_state is not None:
            payload["motion_sequence"] = int(motion_state.sequence)
        padding_seconds = float(getattr(self, "_motion_release_padding_seconds", 0.0))
        payload["motion_padding_config_seconds"] = padding_seconds
        deadline = getattr(self, "_motion_release_deadline", None)
        if deadline is not None:
            remaining = float(deadline - time.time())
            payload["motion_padding_seconds_remaining"] = max(0.0, remaining)
            try:
                payload["motion_padding_deadline_epoch"] = float(deadline)
            except (TypeError, ValueError):
                payload.pop("motion_padding_deadline_epoch", None)
            started = getattr(self, "_motion_padding_started_at", None)
            if started is not None:
                try:
                    payload["motion_padding_started_epoch"] = float(started)
                except (TypeError, ValueError):
                    payload.pop("motion_padding_started_epoch", None)
        else:
            payload["motion_padding_seconds_remaining"] = 0.0
            payload.pop("motion_padding_deadline_epoch", None)
            payload.pop("motion_padding_started_epoch", None)
        if for_last_event or getattr(self, '_motion_forced_active', False):
            payload["motion_active"] = bool(getattr(self, '_motion_forced_active', False))
        return payload

    def _augment_motion_fields(self, event: dict | None, *, for_last: bool = False) -> dict | None:
        payload = self._current_motion_event_payload(for_last_event=for_last)
        if not payload:
            return event
        if event is None:
            return payload
        updated = dict(event)
        updated.update(payload)
        return updated

    def _publish_motion_status(self) -> None:
        if self._status_mode != "live":
            return
        capturing, event, last_event, reason = self._status_snapshot()
        event = self._augment_motion_fields(event, for_last=False)
        last_event = self._augment_motion_fields(last_event, for_last=True)
        self._update_capture_status(
            capturing,
            event=event,
            last_event=last_event,
            reason=reason,
            extra=self._motion_status_extra(),
        )

    def _refresh_motion_state(self) -> None:
        watcher = getattr(self, '_motion_watcher', None)
        if watcher is None:
            return
        padding_seconds = float(getattr(self, "_motion_release_padding_seconds", 0.0))
        now = time.time()
        deadline = getattr(self, "_motion_release_deadline", None)
        updated = watcher.poll()
        state = watcher.state
        previous_forced = getattr(self, '_motion_forced_active', False)
        if updated is None:
            if (
                state.sequence == self._motion_sequence
                and state.active == self._motion_forced_active
                and deadline is None
            ):
                return
            updated = state
        self._motion_sequence = updated.sequence
        hold_active = False
        effective_active = bool(updated.active)
        if updated.active:
            start_epoch = updated.active_since or updated.updated_at
            self._motion_forced_active = True
            self._motion_active_since = start_epoch
            self._motion_release_deadline = None
            self._motion_padding_started_at = None
            self._record_motion_segment_start(start_epoch)
            self._current_motion_event_end = None
            if not self.active:
                self._motion_pending_start = True
                if START_CONSECUTIVE > 0:
                    self.consec_active = max(self.consec_active, START_CONSECUTIVE - 1)
                    self.consec_inactive = 0
            if getattr(self, "_manual_recording", False):
                self._manual_motion_released = False
        else:
            release_epoch = updated.updated_at if updated.updated_at else now
            try:
                release_epoch = float(release_epoch)
            except (TypeError, ValueError):
                release_epoch = now
            if padding_seconds > 0.0:
                deadline = getattr(self, "_motion_release_deadline", None)
                if deadline is None:
                    deadline = release_epoch + padding_seconds
                    self._motion_release_deadline = deadline
                    self._motion_padding_started_at = release_epoch
                if deadline is not None and now < deadline:
                    hold_active = True
                    effective_active = True
                else:
                    self._motion_release_deadline = None
                    self._motion_padding_started_at = None
            else:
                self._motion_release_deadline = None
                self._motion_padding_started_at = None

            if hold_active:
                self._motion_forced_active = True
                if self._motion_active_since is None:
                    self._motion_active_since = updated.active_since or updated.updated_at
                if self._current_motion_event_start is None:
                    self._record_motion_segment_start(updated.active_since or updated.updated_at)
                if self.active and self._current_motion_event_start is not None:
                    self._record_motion_segment_end(release_epoch)
                elif not self.active:
                    self._current_motion_event_start = None
                    self._current_motion_event_end = None
                    self._reset_motion_segments()
            else:
                self._motion_forced_active = False
                self._motion_active_since = None
                self._motion_pending_start = False
                if self.active and self._current_motion_event_start is not None:
                    self._record_motion_segment_end(release_epoch)
                else:
                    self._current_motion_event_start = None
                    self._current_motion_event_end = None
                    self._reset_motion_segments()
                if previous_forced:
                    try:
                        self.recent_active.clear()
                    except AttributeError:
                        pass
                    self.consec_active = 0
                    self.consec_inactive = 0
                if getattr(self, "_manual_recording", False):
                    self._manual_motion_released = True
        if effective_active and self.active and self._current_motion_event_start is None:
            self._record_motion_segment_start(updated.active_since or updated.updated_at)
        self._publish_motion_status()

    def set_manual_recording(self, enabled: bool) -> None:
        next_state = bool(enabled)
        if next_state == getattr(self, "_manual_recording", False):
            return
        self._manual_recording = next_state
        if next_state:
            if self.active:
                self._event_manual_recording = True
            self._manual_motion_released = False
            self._refresh_capture_status()
            return
        watcher = getattr(self, "_motion_watcher", None)
        manual_release_seen = bool(getattr(self, "_manual_motion_released", False))
        motion_active = bool(getattr(self, "_motion_forced_active", False))
        if watcher is not None:
            try:
                watcher.force_refresh()
            except Exception:
                pass
            self._refresh_motion_state()
            motion_active = bool(getattr(self, "_motion_forced_active", False))
        if self.active:
            self._finalize_event(reason="manual recording stopped")
        else:
            self._refresh_capture_status()
        self._manual_motion_released = False
        if not motion_active or manual_release_seen:
            previously_active = bool(getattr(self, "_motion_forced_active", False))
            previous_pending = bool(getattr(self, "_motion_pending_start", False))
            had_start = getattr(self, "_current_motion_event_start", None) is not None
            had_end = getattr(self, "_current_motion_event_end", None) is not None
            self._motion_forced_active = False
            self._motion_active_since = None
            self._motion_pending_start = False
            self._current_motion_event_start = None
            self._current_motion_event_end = None
            self._motion_release_deadline = None
            self._motion_padding_started_at = None
            self._reset_motion_segments()
            if previously_active or previous_pending or had_start or had_end:
                self._publish_motion_status()

    def set_auto_recording_enabled(self, enabled: bool) -> None:
        next_state = bool(enabled)
        if next_state == getattr(self, "_auto_recording_enabled", True):
            return
        self._auto_recording_enabled = next_state
        if not next_state:
            if (
                self.active
                and not self._manual_recording
                and not (
                    self._motion_forced_active and self._motion_override_enabled
                )
            ):
                self._finalize_event(reason="auto recording disabled")
            else:
                self._refresh_capture_status()
            return
        self._refresh_capture_status()

    def _status_snapshot(self) -> tuple[bool, dict | None, dict | None, str | None]:
        with self._status_lock:
            capturing = self.active
            event: dict | None = None
            last_event: dict | None = None
            reason: str | None = None
            if isinstance(self._status_cache, dict):
                capturing = bool(self._status_cache.get("capturing", capturing))
                cached_event = self._status_cache.get("event")
                if isinstance(cached_event, dict):
                    event = cached_event
                cached_last = self._status_cache.get("last_event")
                if isinstance(cached_last, dict):
                    last_event = cached_last
                cached_reason = self._status_cache.get("last_stop_reason")
                if isinstance(cached_reason, str) and cached_reason:
                    reason = cached_reason
        if capturing:
            last_event = None
        else:
            event = None
        return capturing, event, last_event, reason

    def _current_event_size(self) -> int | None:
        path = None
        if self._streaming_encoder:
            path = self._streaming_encoder.partial_path
        if not path:
            path = self.tmp_wav_path
        if not path:
            return None
        try:
            return os.path.getsize(path)
        except OSError:
            return None

    def _relative_recordings_path(self, path: str | None) -> str | None:
        if not path:
            return None
        try:
            rel = os.path.relpath(path, REC_DIR)
        except ValueError:
            return None
        if rel.startswith(".."):
            return None
        return rel.replace(os.sep, "/")

    def _current_partial_path(self, capturing: bool) -> str | None:
        if not capturing:
            return None
        if self._parallel_partial_path:
            return self._parallel_partial_path
        if self._streaming_encoder:
            return self._streaming_encoder.partial_path
        return None

    def _current_partial_format(self, capturing: bool) -> str | None:
        if not capturing:
            return None
        if self._parallel_partial_path:
            return STREAMING_CONTAINER_FORMAT
        if self._streaming_encoder:
            return STREAMING_CONTAINER_FORMAT
        return None

    def _current_partial_waveform(self, capturing: bool) -> str | None:
        if not capturing:
            return None
        return self._live_waveform_path

    def _current_partial_waveform_rel(self, capturing: bool) -> str | None:
        if not capturing:
            return None
        return self._live_waveform_rel_path

    def _maybe_update_live_metrics(self, rms_value: int) -> None:
        if self._status_mode != "live":
            return
        now = time.monotonic()
        whole = int(rms_value)
        threshold = int(self._adaptive.threshold_linear)
        if (
            now - self._last_metrics_update < self._metrics_interval
            and self._last_metrics_value == whole
            and self._last_metrics_threshold == threshold
        ):
            return

        self._last_metrics_update = now
        self._last_metrics_value = whole
        self._last_metrics_threshold = threshold

        capturing, event, last_event, reason = self._status_snapshot()
        self._update_capture_status(
            capturing,
            event=event,
            last_event=last_event,
            reason=reason,
            extra={
                "current_rms": whole,
                "service_running": True,
                "event_duration_seconds": (
                    self.frames_written * (FRAME_MS / 1000.0)
                    if capturing
                    else None
                ),
                "event_size_bytes": self._current_event_size() if capturing else None,
                "partial_recording_path": self._current_partial_path(capturing),
                "streaming_container_format": self._current_partial_format(capturing),
                "partial_waveform_path": self._current_partial_waveform(capturing),
                "partial_waveform_rel_path": self._current_partial_waveform_rel(capturing),
                "filter_chain_avg_ms": round(self._filter_avg_ms, 3),
                "filter_chain_peak_ms": round(self._filter_peak_ms, 3),
                "filter_chain_avg_budget_ms": FILTER_CHAIN_AVG_BUDGET_MS,
                "filter_chain_peak_budget_ms": FILTER_CHAIN_PEAK_BUDGET_MS,
                "filter_chain_peak_budget_ms": FILTER_CHAIN_PEAK_BUDGET_MS,
                **self._motion_status_extra(),
            },
        )

    def _emit_threshold_update(self) -> None:
        if self._status_mode != "live":
            return
        cached = self._status_cache or {}
        capturing = bool(cached.get("capturing", self.active))
        event = cached.get("event") if capturing else None
        last_event = None if capturing else cached.get("last_event")
        reason = cached.get("last_stop_reason")
        self._update_capture_status(capturing, event=event, last_event=last_event, reason=reason)

    def _log_adaptive_rms_observation(self, observation: AdaptiveRmsObservation) -> None:

        if not observation.updated:
            return

        if observation.threshold_linear == observation.previous_threshold_linear:
            return

        margin = self._adaptive.margin
        release_pct = self._adaptive.release_percentile
        print(
            "[segmenter] adaptive RMS threshold updated: "
            f"prev={observation.previous_threshold_linear} "
            f"new={observation.threshold_linear} "
            f"(p95={observation.p95_norm:.4f}, margin={margin:.2f}, "
            f"release_pctl={release_pct:.2f}, release={observation.release_norm:.4f})",
            flush=True,
        )

    @staticmethod
    def _apply_gain(buf: bytes) -> bytes:
        return pcm16_apply_gain(buf, GAIN)

    @staticmethod
    def _denoise(samples: bytes) -> bytes:
        if USE_RNNOISE:
            denoiser = rnnoise.RNNoise() # noqa: for future expansion
            frame_size = FRAME_BYTES
            out = bytearray()
            for i in range(0, len(samples), frame_size):
                chunk = samples[i:i+frame_size]
                if len(chunk) == frame_size:
                    out.extend(denoiser.filter(chunk))
            return bytes(out)
        elif USE_NOISEREDUCE:
            arr = np.frombuffer(samples, dtype=np.int16)
            arr_denoised = nr.reduce_noise(y=arr, sr=SAMPLE_RATE)  # noqa: for future expansion
            return arr_denoised.astype(np.int16).tobytes()
        return samples

    def _record_filter_metrics(self, duration_ms: float) -> None:
        if duration_ms < 0:
            return
        samples = self._filter_chain_samples
        samples.append(duration_ms)
        if samples:
            self._filter_avg_ms = sum(samples) / len(samples)
            self._filter_peak_ms = max(samples)
        else:
            self._filter_avg_ms = 0.0
            self._filter_peak_ms = 0.0

        now = time.monotonic()
        over_avg_budget = self._filter_avg_ms > FILTER_CHAIN_AVG_BUDGET_MS
        over_peak_budget = self._filter_peak_ms > FILTER_CHAIN_PEAK_BUDGET_MS
        if (over_avg_budget or over_peak_budget) and (
            now - self._filter_last_log_ts >= FILTER_CHAIN_LOG_THROTTLE_SEC
        ):
            payload = {
                "component": "segmenter",
                "event": "filter_chain_budget_exceeded",
                "avg_ms": round(self._filter_avg_ms, 3),
                "peak_ms": round(self._filter_peak_ms, 3),
                "avg_budget_ms": FILTER_CHAIN_AVG_BUDGET_MS,
                "peak_budget_ms": FILTER_CHAIN_PEAK_BUDGET_MS,
                "window_size": len(samples),
            }
            print(json.dumps(payload), flush=True)
            self._filter_last_log_ts = now

    def _parallel_cpu_ready(self) -> bool:
        if PARALLEL_ENCODE_LOAD_THRESHOLD <= 0.0:
            return True
        normalized = _normalized_load()
        if normalized is None:
            return True
        return normalized <= PARALLEL_ENCODE_LOAD_THRESHOLD

    def _maybe_start_parallel_encode(self, *, force: bool = False) -> None:
        if not self._parallel_encode_allowed:
            return
        if self._parallel_encoder is not None:
            return
        if not self.base_name or not self.tmp_wav_path:
            return
        if self.frames_written < PARALLEL_ENCODE_MIN_FRAMES:
            return
        now = time.monotonic()
        if not force and (now - self._parallel_last_check) < PARALLEL_ENCODE_CHECK_INTERVAL:
            return
        self._parallel_last_check = now
        if not self._parallel_cpu_ready():
            return
        target_dir = self._parallel_day_dir or PARALLEL_TMP_DIR
        suffix = STREAMING_PARTIAL_SUFFIX if self._parallel_day_dir else PARALLEL_PARTIAL_SUFFIX
        partial_path = os.path.join(target_dir, f"{self.base_name}{suffix}")
        try:
            os.makedirs(os.path.dirname(partial_path), exist_ok=True)
        except OSError:
            pass
        encoder = StreamingOpusEncoder(
            partial_path,
            container_format=STREAMING_CONTAINER_FORMAT,
        )
        try:
            encoder.start()
        except Exception as exc:
            print(
                f"[segmenter] WARN: failed to start parallel encoder: {exc!r}",
                flush=True,
            )
            return
        self._parallel_encoder = encoder
        self._parallel_partial_path = partial_path
        self._parallel_encoder_started_at = time.time()
        self._parallel_encoder_drops = 0
        print(
            f"[segmenter] Parallel encode started for {self.base_name}",
            flush=True,
        )

    def _q_send(self, item):
        try:
            self.audio_q.put_nowait(item)
        except queue.Full:
            self.writer_queue_drops += 1

    def ingest(self, buf: bytes, idx: int) -> bytes:
        force_restart = False
        if (
            self._autosplit_limit_frames is not None
            and self.active
            and self.frames_written >= self._autosplit_limit_frames
        ):
            limit_seconds = float(self._autosplit_limit_seconds or 0.0)
            if limit_seconds > 0.0:
                minutes = limit_seconds / 60.0
                if minutes >= 10.0:
                    human = f"{minutes:.0f}m"
                elif minutes >= 1.0:
                    human = f"{minutes:.1f}m"
                else:
                    human = f"{limit_seconds:.0f}s"
                reason = f"autosplit after {human}"
            else:
                human = "limit reached"
                reason = "autosplit limit reached"
            current_name = self.base_name or "<pending>"
            print(
                f"[segmenter] Autosplitting {current_name} ({reason})",
                flush=True,
            )
            self._finalize_event(reason=reason)
            self.prebuf.clear()
            force_restart = True

        if self._manual_split_requested:
            if self.active:
                print("[segmenter] Manual split requested; finalizing current event", flush=True)
                self._manual_split_requested = False
                self._finalize_event(reason="manual split")
                self.prebuf.clear()
                force_restart = True
            else:
                self._manual_split_requested = False

        if self._manual_stop_requested:
            if self.active:
                print("[segmenter] Manual stop requested; finalizing current event", flush=True)
                self._manual_stop_requested = False
                self._finalize_event(reason="manual stop")
                self.prebuf.clear()
                force_restart = False
            else:
                self._manual_stop_requested = False

        self._refresh_motion_state()

        start = time.perf_counter()
        buf = self._apply_gain(buf)
        if DENOISE_BEFORE_VAD:
            proc_for_analysis = self._denoise(buf)
        else:
            proc_for_analysis = buf
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        self._record_filter_metrics(elapsed_ms)

        rms_val = rms(proc_for_analysis)
        voiced = (
            is_voice(proc_for_analysis) if self._vad_trigger_enabled else False
        )
        current_threshold = self._adaptive.threshold_linear
        loud = (
            rms_val > current_threshold if self._rms_trigger_enabled else False
        )
        frame_active = loud
        vad_triggered = False
        if (
            self._vad_trigger_enabled
            and voiced
            and not frame_active
            and not self._rms_trigger_enabled
        ):
            frame_active = True
            vad_triggered = True
        if self._manual_recording:
            frame_active = True
        else:
            if self._motion_forced_active:
                if self._auto_recording_enabled or self._motion_override_enabled:
                    frame_active = True
                else:
                    frame_active = False
            elif not self._auto_recording_enabled:
                if self._motion_override_event_active:
                    frame_active = bool(loud or voiced)
                else:
                    frame_active = False
        if force_restart:
            frame_active = True
            self.consec_active = max(0, START_CONSECUTIVE - 1)
            self.consec_inactive = 0
        capturing_now = self.active or frame_active

        # collect rolling window for debug stats
        self._dbg_rms.append(rms_val)
        self._dbg_voiced.append(bool(voiced))

        self._adaptive.observe(rms_val, bool(voiced), capturing=capturing_now)
        observation = self._adaptive.pop_observation()
        if observation:
            threshold_changed = (
                observation.updated
                and observation.threshold_linear != observation.previous_threshold_linear
            )
            self._log_adaptive_rms_observation(observation)
            if threshold_changed:
                self._emit_threshold_update()

        self._maybe_update_live_metrics(rms_val)

        # once per-second debug (only if DEV enabled)
        now = time.monotonic()
        if DEBUG_VERBOSE and (now - self.last_log >= 1.0):
            # Inline, narrow VU bar; numeric fields fixed width to prevent jitter
            def _bar(val: int, scale: int = BAR_SCALE, width: int = BAR_WIDTH) -> str:
                lvl = min(width, int((val / float(scale)) * width)) if scale > 0 else 0
                return "#" * lvl + "-" * (width - lvl)

            win_len = max(1, len(self._dbg_rms))
            win_avg = int(sum(self._dbg_rms) / win_len) if win_len else 0
            win_peak = max(self._dbg_rms) if win_len else 0
            voiced_ratio = (sum(1 for v in self._dbg_voiced if v) / win_len) if win_len else 0.0

            # Left block: keep widths stable
            left_block = (
                f"[segmenter] frame={idx:6d} rms={rms_val:4d} "
                f"voiced={color_tf(voiced)} loud={color_tf(loud)} "
                f"active={color_tf(frame_active)} capturing={color_tf(self.active)}  |  "
            )

            # Right text block with fixed width, including a percent that can reach 100.0
            # Use 6.1f so '100.0%' fits without pushing columns
            right_text = (
                f"RMS cur={rms_val:4d} avg={win_avg:4d} peak={win_peak:4d} thr={current_threshold:4d}  "
                f"VAD voiced={voiced_ratio * 100:6.1f}%  |  "
            )
            right_block = right_text.ljust(RIGHT_TEXT_WIDTH)

            print(f"{left_block}{right_block}{_bar(rms_val)}", flush=True)
            self.last_log = now

        if frame_active:
            self.consec_active += 1
            self.consec_inactive = 0
        else:
            self.consec_inactive += 1
            self.consec_active = 0
        self.recent_active.append(frame_active)

        self.prebuf.append(buf)

        if not self.active:
            if self.consec_active >= START_CONSECUTIVE:
                hint_timestamp: str | None = None
                hint_counter: int | None = None
                if self._ingest_hint and not self._ingest_hint_used:
                    hint_timestamp = self._ingest_hint.timestamp
                    hint_counter = self._ingest_hint.event_counter
                    self._ingest_hint_used = True

                prebuf_frames = len(self.prebuf)
                prebuf_seconds = max(prebuf_frames - 1, 0) * (FRAME_MS / 1000.0)
                trigger_epoch = time.time()

                if hint_timestamp:
                    start_time = hint_timestamp
                    start_epoch = trigger_epoch
                else:
                    start_epoch = max(0.0, trigger_epoch - prebuf_seconds)
                    start_time = datetime.fromtimestamp(start_epoch).strftime("%H-%M-%S")

                if hint_counter is not None and hint_timestamp:
                    existing = TimelineRecorder.event_counters[start_time]
                    if hint_counter > existing:
                        count = hint_counter
                    else:
                        count = existing + 1
                    TimelineRecorder.event_counters[start_time] = count
                else:
                    TimelineRecorder.event_counters[start_time] += 1
                    count = TimelineRecorder.event_counters[start_time]

                self.event_timestamp = start_time
                self.event_counter = count
                self.trigger_rms = int(rms_val)
                self.base_name = f"{start_time}_Both_{count}"
                self.tmp_wav_path = os.path.join(TMP_DIR, f"{self.base_name}.wav")
                self.event_started_epoch = start_epoch
                self.event_day = time.strftime("%Y%m%d", time.localtime(start_epoch))

                day_stamp = time.strftime("%Y%m%d")
                self._parallel_day_dir = os.path.join(REC_DIR, day_stamp)
                try:
                    os.makedirs(self._parallel_day_dir, exist_ok=True)
                except OSError:
                    pass

                self._q_send(('open', self.base_name, self.tmp_wav_path))

                if self._streaming_enabled:
                    try:
                        day = self.event_day or time.strftime("%Y%m%d")
                        day_dir = os.path.join(REC_DIR, day)
                        os.makedirs(day_dir, exist_ok=True)
                        partial_path = os.path.join(
                            day_dir,
                            f"{self.base_name}{STREAMING_PARTIAL_SUFFIX}",
                        )
                        self._streaming_day_dir = day_dir
                        self._streaming_encoder = StreamingOpusEncoder(
                            partial_path,
                            container_format=STREAMING_CONTAINER_FORMAT,
                        )
                        self._streaming_encoder.start()
                    except Exception as exc:
                        print(
                            f"[segmenter] WARN: failed to start streaming encoder: {exc!r}",
                            flush=True,
                        )
                        self._streaming_encoder = None
                        self._streaming_day_dir = None

                waveform_partial_path = os.path.join(
                    self._parallel_day_dir,
                    f"{self.base_name}{STREAMING_PARTIAL_SUFFIX}.waveform.json",
                )
                self._live_waveform_path = waveform_partial_path
                self._live_waveform_rel_path = self._relative_recordings_path(
                    waveform_partial_path
                )
                try:
                    self._live_waveform = LiveWaveformWriter(
                        waveform_partial_path,
                        bucket_count=LIVE_WAVEFORM_BUCKET_COUNT,
                        update_interval=LIVE_WAVEFORM_UPDATE_INTERVAL,
                        start_epoch=self.event_started_epoch,
                        trigger_rms=self.trigger_rms,
                    )
                except Exception:
                    self._live_waveform = None
                    self._live_waveform_path = None
                    self._live_waveform_rel_path = None

                prebuf_bytes: list[bytes] = []
                if self.prebuf:
                    for f in self.prebuf:
                        frame_bytes = bytes(f)
                        prebuf_bytes.append(frame_bytes)
                        self._q_send(frame_bytes)
                        if self._streaming_encoder and not self._streaming_encoder.feed(frame_bytes):
                            self.streaming_queue_drops += 1
                        if self._parallel_encoder and not self._parallel_encoder.feed(frame_bytes):
                            self._parallel_encoder_drops += 1
                        if self._live_waveform:
                            try:
                                self._live_waveform.add_frame(frame_bytes)
                            except Exception:
                                pass
                        self.frames_written += 1
                        self.sum_rms += rms(f)
                self.prebuf.clear()

                self.active = True
                self._event_manual_recording = self._manual_recording
                self._motion_override_event_active = bool(
                    self._motion_override_enabled
                    and not self._auto_recording_enabled
                    and (
                        self._motion_forced_active
                        or getattr(self, "_motion_pending_start", False)
                    )
                )
                self._motion_pending_start = False
                self._current_motion_event_end = None
                if self._motion_forced_active and self._current_motion_event_start is None:
                    self._record_motion_segment_start(
                        self._motion_active_since or time.time()
                    )
                self.post_count = POST_PAD_FRAMES
                self.saw_voiced = voiced
                self.saw_loud = loud
                parallel_was_missing = self._parallel_encoder is None
                self._maybe_start_parallel_encode(force=True)
                if parallel_was_missing and self._parallel_encoder and prebuf_bytes:
                    for frame_bytes in prebuf_bytes:
                        if not self._parallel_encoder.feed(frame_bytes):
                            self._parallel_encoder_drops += 1
                trigger_components: list[str] = []
                if loud:
                    trigger_components.append("RMS")
                elif self._vad_trigger_enabled and (vad_triggered or voiced):
                    trigger_components.append("VAD")
                if self._motion_forced_active:
                    trigger_components.append("motion")
                if self._manual_recording:
                    trigger_components.append("manual")
                if not trigger_components:
                    trigger_components.append("unknown")
                trigger_label = "+".join(trigger_components)
                print(
                    f"[segmenter] Event started at frame ~{max(0, idx - PRE_PAD_FRAMES)} "
                    f"(trigger={trigger_label} rms={rms_val} threshold={current_threshold})",
                    flush=True,
                )
                event_status = {
                    "base_name": self.base_name,
                    "started_at": self.event_timestamp,
                    "started_epoch": self.event_started_epoch,
                    "trigger_rms": self.trigger_rms,
                }
                duration_hint = self.frames_written * (FRAME_MS / 1000.0)
                event_status.update(
                    self._current_motion_event_payload(
                        duration_seconds=duration_hint
                    )
                )
                if self._status_mode == "live":
                    if self._streaming_encoder or self._parallel_encoder:
                        event_status = dict(event_status)
                        event_status["in_progress"] = True
                        if self._streaming_encoder:
                            event_status["partial_recording_path"] = (
                                self._streaming_encoder.partial_path
                            )
                            event_status["streaming_container_format"] = (
                                STREAMING_CONTAINER_FORMAT
                            )
                        elif self._parallel_encoder and self._parallel_partial_path:
                            event_status["partial_recording_path"] = (
                                self._parallel_partial_path
                            )
                            event_status["streaming_container_format"] = "opus"
                        if self._live_waveform_path:
                            event_status["partial_waveform_path"] = self._live_waveform_path
                        if self._live_waveform_rel_path:
                            event_status["partial_waveform_rel_path"] = (
                                self._live_waveform_rel_path
                            )
                    self._update_capture_status(True, event=event_status)
            return buf

        self._q_send(bytes(buf))
        if self._streaming_encoder and not self._streaming_encoder.feed(bytes(buf)):
            self.streaming_queue_drops += 1
        if self._parallel_encoder and not self._parallel_encoder.feed(bytes(buf)):
            self._parallel_encoder_drops += 1
        if self._live_waveform:
            try:
                self._live_waveform.add_frame(bytes(buf))
            except Exception:
                pass
        self.frames_written += 1
        self.sum_rms += rms(proc_for_analysis)
        self.saw_voiced = voiced or self.saw_voiced
        self.saw_loud = loud or self.saw_loud

        self._maybe_start_parallel_encode()

        if sum(self.recent_active) >= KEEP_CONSECUTIVE:
            self.post_count = POST_PAD_FRAMES
        else:
            self.post_count -= 1

        if self.post_count <= 0:
            self._finalize_event(reason=f"no active input for {POST_PAD}ms")

        return buf

    def request_manual_split(self) -> bool:
        if not self.active:
            self._manual_split_requested = False
            return False
        self._manual_split_requested = True
        return True

    def request_manual_stop(self) -> bool:
        if not self.active:
            self._manual_stop_requested = False
            return False
        self._manual_stop_requested = True
        return True

    def _finalize_event(self, reason: str, wait_for_encode_start: bool = False):
        if self.frames_written <= 0 or not self.base_name:
            self._reset_event_state()
            return

        streaming_result: StreamingEncoderResult | None = None
        parallel_result: StreamingEncoderResult | None = None
        partial_stream_path: str | None = None
        parallel_partial_path: str | None = None
        final_stream_path: str | None = None
        persisted_waveform: tuple[str, str | None] | None = None
        streaming_drop_detected = False
        parallel_drop_detected = False
        manual_event = bool(self._event_manual_recording)
        day_dir = self._streaming_day_dir
        final_base: str = self.base_name or ""
        if self._streaming_encoder:
            try:
                streaming_result = self._streaming_encoder.close(timeout=5.0)
            except Exception as exc:
                print(
                    f"[segmenter] WARN: streaming encoder close failed: {exc!r}",
                    flush=True,
                )
                streaming_result = StreamingEncoderResult(
                    partial_path=self._streaming_encoder.partial_path,
                    success=False,
                    returncode=None,
                    error=exc,
                    stderr=None,
                    bytes_sent=0,
                    dropped_chunks=0,
                )
            finally:
                self._streaming_encoder = None
        if streaming_result:
            partial_stream_path = streaming_result.partial_path
            streaming_drop_detected = bool(streaming_result.dropped_chunks)

        if self.streaming_queue_drops:
            streaming_drop_detected = True

        if streaming_drop_detected:
            drop_details = []
            if streaming_result:
                drop_details.append(
                    f"encoder={streaming_result.dropped_chunks}"
                )
            if self.streaming_queue_drops:
                drop_details.append(f"queue={self.streaming_queue_drops}")
            if self.writer_queue_drops:
                drop_details.append(f"writer={self.writer_queue_drops}")
            details = ", ".join(drop_details) if drop_details else "unknown"
            print(
                f"[segmenter] WARN: streaming encoder dropped chunks ({details}); falling back to offline encode",
                flush=True,
            )

        if self._parallel_encoder:
            try:
                parallel_result = self._parallel_encoder.close(timeout=5.0)
            except Exception as exc:
                print(
                    f"[segmenter] WARN: parallel encoder close failed: {exc!r}",
                    flush=True,
                )
                parallel_result = StreamingEncoderResult(
                    partial_path=self._parallel_partial_path,
                    success=False,
                    returncode=None,
                    error=exc,
                    stderr=None,
                    bytes_sent=0,
                    dropped_chunks=self._parallel_encoder_drops,
                )
            finally:
                self._parallel_encoder = None
        if parallel_result:
            parallel_partial_path = parallel_result.partial_path
            if parallel_result.dropped_chunks or self._parallel_encoder_drops:
                parallel_drop_detected = True

        if parallel_drop_detected and parallel_result:
            detail = parallel_result.dropped_chunks or self._parallel_encoder_drops
            print(
                f"[segmenter] WARN: parallel encoder dropped chunks ({detail}); will fall back to offline encode",
                flush=True,
            )

        if self.saw_voiced and self.saw_loud:
            etype_label = EVENT_TAGS["both"]
        elif self.saw_voiced:
            etype_label = EVENT_TAGS["human"]
        else:
            etype_label = EVENT_TAGS["other"]
        avg_rms = (self.sum_rms / self.frames_written) if self.frames_written else 0.0
        trigger_rms = int(self.trigger_rms) if self.trigger_rms is not None else 0

        ended_epoch = time.time()
        duration_seconds = self.frames_written * (FRAME_MS / 1000.0)

        self._q_send(('close', self.base_name))

        tmp_wav_path, base = None, None
        try:
            tmp_wav_path, base = self.done_q.get(timeout=5.0)
        except queue.Empty:
            print("[segmenter] WARN: writer did not close file within 5s", flush=True)

        total_queue_drops = self.writer_queue_drops + self.streaming_queue_drops
        print(
            f"[segmenter] Event ended ({reason}). type={etype_label}, avg_rms={avg_rms:.1f}, frames={self.frames_written}"
            + (f", q_drops={total_queue_drops}" if total_queue_drops else ""),
            flush=True
        )

        job_id: int | None = None
        if tmp_wav_path and base:
            day = self.event_day or time.strftime("%Y%m%d")
            os.makedirs(os.path.join(REC_DIR, day), exist_ok=True)
            event_ts = self.event_timestamp or base.split("_", 1)[0]
            event_count = str(self.event_counter) if self.event_counter is not None else base.rsplit("_", 1)[-1]
            safe_etype = _sanitize_event_tag(etype_label)
            final_base = f"{event_ts}_{safe_etype}_RMS-{trigger_rms}_{event_count}"
            reuse_mode: str | None = None
            target_day_dir = day_dir or os.path.join(REC_DIR, day)
            os.makedirs(target_day_dir, exist_ok=True)
            final_opus_path = os.path.join(target_day_dir, f"{final_base}{STREAMING_EXTENSION}")
            final_waveform_path = f"{final_opus_path}.waveform.json"
            persisted_waveform = self._persist_live_waveform(final_waveform_path)
            if (
                streaming_result
                and streaming_result.success
                and not streaming_drop_detected
                and partial_stream_path
                and os.path.exists(partial_stream_path)
            ):
                try:
                    os.replace(partial_stream_path, final_opus_path)
                    reuse_mode = "streaming"
                    final_stream_path = final_opus_path
                    print(
                        f"[segmenter] Streaming encode finalized at {final_opus_path}",
                        flush=True,
                    )
                except Exception as exc:
                    print(
                        f"[segmenter] WARN: failed to finalize streaming output: {exc!r}",
                        flush=True,
                    )
            elif streaming_result and not streaming_result.success and streaming_result.stderr:
                print(
                    f"[segmenter] WARN: streaming encoder stderr: {streaming_result.stderr.strip()}",
                    flush=True,
                )

            if (
                reuse_mode is None
                and parallel_result
                and parallel_result.success
                and not parallel_drop_detected
                and parallel_partial_path
                and os.path.exists(parallel_partial_path)
            ):
                try:
                    os.replace(parallel_partial_path, final_opus_path)
                    reuse_mode = "parallel"
                    final_stream_path = final_opus_path
                    print(
                        f"[segmenter] Parallel encode finalized at {final_opus_path}",
                        flush=True,
                    )
                except Exception as exc:
                    print(
                        f"[segmenter] WARN: failed to finalize parallel output: {exc!r}",
                        flush=True,
                    )
            elif (
                parallel_result
                and not parallel_result.success
                and parallel_result.stderr
            ):
                print(
                    f"[segmenter] WARN: parallel encoder stderr: {parallel_result.stderr.strip()}",
                    flush=True,
                )

            if reuse_mode != "streaming" and partial_stream_path and os.path.exists(partial_stream_path):
                try:
                    os.unlink(partial_stream_path)
                except OSError:
                    pass
            if reuse_mode != "parallel" and parallel_partial_path and os.path.exists(parallel_partial_path):
                try:
                    os.unlink(parallel_partial_path)
                except OSError:
                    pass

            job_id = _enqueue_encode_job(
                tmp_wav_path,
                final_base,
                source=self._recording_source,
                existing_opus_path=final_stream_path if reuse_mode else None,
                manual_recording=manual_event,
                target_day=day,
            )
            _schedule_recordings_refresh(
                job_id,
                final_path=final_opus_path,
                base_name=final_base,
                day=day,
                manual=manual_event,
                source=self._recording_source,
            )
            if job_id is not None:
                self._encode_jobs.append(job_id)
            if job_id is not None and wait_for_encode_start:
                started = ENCODING_STATUS.wait_for_start(job_id, SHUTDOWN_ENCODE_START_TIMEOUT)
                if not started:
                    print(
                        (
                            "[segmenter] WARN: encode worker did not start within "
                            f"{SHUTDOWN_ENCODE_START_TIMEOUT:.1f}s (job {job_id})"
                        ),
                        flush=True,
                    )
            if reuse_mode is None:
                print(
                    f"[segmenter] Offline encode scheduled for {final_base}",
                    flush=True,
                )
        self._streaming_day_dir = None

        if tmp_wav_path and base:
            last_event_status = {
                "base_name": final_base,
                "started_at": self.event_timestamp,
                "started_epoch": self.event_started_epoch,
                "ended_epoch": ended_epoch,
                "duration_seconds": duration_seconds,
                "avg_rms": avg_rms,
                "trigger_rms": trigger_rms,
                "etype": etype_label,
            }
            last_event_status.update(
                self._current_motion_event_payload(
                    for_last_event=True,
                    duration_seconds=duration_seconds,
                )
            )
        else:
            last_event_status = {
                "base_name": self.base_name or "",
                "started_at": self.event_timestamp,
                "started_epoch": self.event_started_epoch,
                "ended_epoch": ended_epoch,
                "duration_seconds": duration_seconds,
                "avg_rms": avg_rms,
                "trigger_rms": trigger_rms,
                "etype": etype_label,
            }
            last_event_status.update(
                self._current_motion_event_payload(
                    for_last_event=True,
                    duration_seconds=duration_seconds,
                )
            )

        last_event_status["end_reason"] = reason
        last_event_status["in_progress"] = False
        last_event_status["manual"] = manual_event
        if final_stream_path:
            last_event_status["recording_path"] = final_stream_path
            last_event_status["streaming_container_format"] = STREAMING_CONTAINER_FORMAT
        waveform_path: str | None = None
        waveform_rel: str | None = None
        if persisted_waveform:
            waveform_path, waveform_rel = persisted_waveform
            last_event_status["waveform_path"] = waveform_path
            if waveform_rel:
                last_event_status["waveform_rel_path"] = waveform_rel

        trigger_sources: set[str] = set()
        if manual_event:
            trigger_sources.add("manual")
        normalized_reason = (reason or "").strip().lower()
        if normalized_reason and "split" in normalized_reason:
            trigger_sources.add("split")
        motion_fields = (
            "motion_trigger_offset_seconds",
            "motion_release_offset_seconds",
            "motion_started_epoch",
            "motion_released_epoch",
        )
        motion_detected = any(
            last_event_status.get(field) is not None for field in motion_fields
        )
        if not motion_detected:
            segments = last_event_status.get("motion_segments")
            if isinstance(segments, list) and segments:
                motion_detected = True
        if motion_detected:
            trigger_sources.add("motion")
        if self.saw_loud:
            trigger_sources.add("rms")
        if self.saw_voiced:
            trigger_sources.add("vad")
        if trigger_sources:
            last_event_status["trigger_sources"] = sorted(trigger_sources)

        metadata_payload = {
            "motion_started_epoch": last_event_status.get("motion_started_epoch"),
            "motion_released_epoch": last_event_status.get("motion_released_epoch"),
            "motion_trigger_offset_seconds": last_event_status.get(
                "motion_trigger_offset_seconds"
            ),
            "motion_release_offset_seconds": last_event_status.get(
                "motion_release_offset_seconds"
            ),
            "motion_segments": last_event_status.get("motion_segments"),
            "manual_event": manual_event,
            "trigger_sources": sorted(trigger_sources),
            "detected_rms": bool(self.saw_loud),
            "detected_vad": bool(self.saw_voiced),
            "end_reason": reason,
        }
        if waveform_path:
            self._annotate_waveform_metadata(waveform_path, metadata_payload)
        if self._status_mode == "live":
            self._update_capture_status(
                False,
                last_event=last_event_status,
                reason=reason,
                extra={
                    "event_duration_seconds": None,
                    "event_size_bytes": None,
                    "partial_recording_path": None,
                    "streaming_container_format": None,
                    "partial_waveform_path": None,
                    "partial_waveform_rel_path": None,
                },
            )
        if NOTIFIER:
            try:
                NOTIFIER.handle_event(last_event_status)
            except Exception as exc:
                print(
                    f"[segmenter] WARN: notification dispatch failed: {exc!r}",
                    flush=True,
                )
        _publish_recordings_event(
            {
                "reason": "finalized",
                "base_name": final_base,
                "path": last_event_status.get("recording_path"),
                "manual": manual_event,
                "day": self.event_day,
                "updated_at": time.time(),
                "trigger_sources": sorted(trigger_sources),
            }
        )
        self._cleanup_live_waveform()
        self._reset_event_state()

    def _persist_live_waveform(
        self, final_destination: str | None
    ) -> tuple[str, str | None] | None:
        if not final_destination:
            return None
        writer = self._live_waveform
        if writer:
            try:
                writer.finalize()
            except Exception:
                pass
        source = self._live_waveform_path
        if not source or not os.path.exists(source):
            return None
        try:
            os.makedirs(os.path.dirname(final_destination), exist_ok=True)
        except OSError:
            pass
        try:
            os.replace(source, final_destination)
        except Exception as exc:
            print(
                (
                    "[segmenter] WARN: failed to persist live waveform "
                    f"{source} -> {final_destination}: {exc!r}"
                ),
                flush=True,
            )
            return None
        rel_path = self._relative_recordings_path(final_destination)
        print(
            f"[segmenter] Live waveform finalized at {final_destination}",
            flush=True,
        )
        self._live_waveform = None
        self._live_waveform_path = None
        self._live_waveform_rel_path = None
        return final_destination, rel_path

    def _annotate_waveform_metadata(
        self,
        destination: str | None,
        metadata: dict[str, object],
    ) -> None:
        if not destination:
            return
        if not metadata:
            return
        try:
            with open(destination, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if not isinstance(payload, dict):
                payload = {}
        except (OSError, json.JSONDecodeError):
            payload = {}

        updated = False
        for key, value in metadata.items():
            if key is None:
                continue
            payload[key] = value
            updated = True

        if not updated:
            return

        tmp_path = f"{destination}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
            os.replace(tmp_path, destination)
        except OSError:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)

    def _cleanup_live_waveform(self) -> None:
        writer = self._live_waveform
        if writer:
            try:
                writer.finalize()
            except Exception:
                pass
        path = self._live_waveform_path
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass
        self._live_waveform = None
        self._live_waveform_path = None
        self._live_waveform_rel_path = None
        self._parallel_day_dir = None

    def _reset_event_state(self):
        if self._streaming_encoder:
            result: StreamingEncoderResult | None = None
            try:
                result = self._streaming_encoder.close(timeout=1.0)
            except Exception:
                result = StreamingEncoderResult(
                    partial_path=self._streaming_encoder.partial_path,
                    success=False,
                    returncode=None,
                    error=None,
                    stderr=None,
                    bytes_sent=0,
                    dropped_chunks=0,
                )
            if result and result.partial_path and os.path.exists(result.partial_path):
                try:
                    os.unlink(result.partial_path)
                except OSError:
                    pass
        self._streaming_encoder = None
        self._streaming_day_dir = None
        if self._parallel_encoder:
            result: StreamingEncoderResult | None = None
            try:
                result = self._parallel_encoder.close(timeout=1.0)
            except Exception:
                result = StreamingEncoderResult(
                    partial_path=self._parallel_partial_path,
                    success=False,
                    returncode=None,
                    error=None,
                    stderr=None,
                    bytes_sent=0,
                    dropped_chunks=self._parallel_encoder_drops,
                )
            if result and result.partial_path and os.path.exists(result.partial_path):
                try:
                    os.unlink(result.partial_path)
                except OSError:
                    pass
        if self._parallel_partial_path and os.path.exists(self._parallel_partial_path):
            try:
                os.unlink(self._parallel_partial_path)
            except OSError:
                pass
        self._parallel_encoder = None
        self._parallel_partial_path = None
        self._parallel_encoder_drops = 0
        self._parallel_encoder_started_at = None
        self._parallel_last_check = 0.0
        self.active = False
        self.post_count = 0
        self.recent_active.clear()
        self.consec_active = 0
        self.consec_inactive = 0
        self.frames_written = 0
        self.sum_rms = 0
        self.saw_voiced = False
        self.saw_loud = False
        self.base_name = None
        self.tmp_wav_path = None
        self.writer_queue_drops = 0
        self.streaming_queue_drops = 0
        self.event_timestamp = None
        self.event_counter = None
        self.trigger_rms = None
        self.event_started_epoch = None
        self.event_day = None
        self._ingest_hint = None
        self._ingest_hint_used = True
        self._manual_split_requested = False
        self._manual_stop_requested = False
        self._event_manual_recording = False
        self._manual_motion_released = False
        self._motion_override_event_active = False
        self._current_motion_event_start = None
        self._current_motion_event_end = None
        self._reset_motion_segments()
        self._cleanup_live_waveform()

    def flush(self, idx: int):
        if self.active:
            print(f"[segmenter] Flushing active event at frame {idx} (reason: shutdown)", flush=True)
            self._finalize_event(reason="shutdown", wait_for_encode_start=True)
        try:
            self.audio_q.put_nowait(None)
        except Exception:
            pass

        last_event = None
        if isinstance(self._status_cache, dict):
            cached_last = self._status_cache.get("last_event")
            if isinstance(cached_last, dict):
                last_event = cached_last
        if self._status_mode == "live":
            self._update_capture_status(
                False,
                last_event=last_event,
                reason="shutdown",
                extra={
                    "service_running": False,
                    "current_rms": 0,
                    "event_duration_seconds": None,
                    "event_size_bytes": None,
                    "partial_recording_path": None,
                    "streaming_container_format": None,
                },
            )

    def encode_job_ids(self) -> tuple[int, ...]:
        return tuple(self._encode_jobs)


def main():
    rec = TimelineRecorder()
    idx = 0
    while True:
        buf = sys.stdin.buffer.read(FRAME_BYTES)
        if not buf or len(buf) < FRAME_BYTES:
            break
        rec.ingest(buf, idx)
        idx += 1
    rec.flush(idx)


if __name__ == "__main__":
    main()
