#!/usr/bin/env python3
import json
import multiprocessing as mp
import os
import signal
import subprocess
import sys
import time
from collections import deque
from queue import Empty
from typing import Any, Iterable, Optional, Tuple
from lib.segmenter import ENCODING_STATUS, TimelineRecorder, perform_startup_recovery
from lib.config import get_cfg
from lib.fault_handler import reset_usb
from lib.hls_mux import HLSTee
from lib.hls_controller import controller  # NEW
from lib.webrtc_buffer import WebRTCBufferWriter
from lib.audio_filter_chain import AudioFilterChain

cfg = get_cfg()


def _collect_legacy_extra_args(streaming_cfg: Any) -> list[str]:
    if not isinstance(streaming_cfg, dict):
        return []
    raw = streaming_cfg.get("extra_ffmpeg_args")
    if not raw:
        raw = streaming_cfg.get("hls_extra_ffmpeg_args")
    if isinstance(raw, (str, bytes)):
        return [str(raw)]
    if isinstance(raw, (list, tuple)):
        collected: list[str] = []
        for entry in raw:
            if isinstance(entry, (str, bytes)):
                collected.append(str(entry))
        return collected
    return []


STREAMING_CFG = cfg.get("streaming", {})
LEGACY_HLS_EXTRA_ARGS = _collect_legacy_extra_args(STREAMING_CFG)
FILTER_CHAIN_CFG = cfg.get("audio", {}).get("filter_chain")
FILTER_CHAIN = AudioFilterChain.from_config(FILTER_CHAIN_CFG)
AUDIO_FILTER_CHAIN_ENABLED = FILTER_CHAIN is not None
SAMPLE_RATE = int(cfg["audio"]["sample_rate"])
FRAME_MS = int(cfg["audio"]["frame_ms"])
FRAME_BYTES = int(SAMPLE_RATE * 2 * FRAME_MS / 1000)
CHUNK_BYTES = 4096
STATE_POLL_INTERVAL = 1.0
STREAM_MODE = str(STREAMING_CFG.get("mode", "hls")).strip().lower() or "hls"
if STREAM_MODE not in {"hls", "webrtc"}:
    STREAM_MODE = "hls"
WEBRTC_HISTORY_SECONDS = float(STREAMING_CFG.get("webrtc_history_seconds", 8.0))

AUDIO_DEV = os.environ.get("AUDIO_DEV", cfg["audio"]["device"])

MANUAL_RECORD_PATH = os.path.join(cfg["paths"]["tmp_dir"], "manual_record_state.json")
MANUAL_POLL_INTERVAL = 0.5

ARECORD_CMD = [
    "arecord",
    "-D", AUDIO_DEV,
    "-c", "1",
    "-f", "S16_LE",
    "-r", str(SAMPLE_RATE),
    "--buffer-size", "48000",
    "--period-size", "2400",
    "-t", "raw",
    "-"
]

stop_requested = False
split_requested = False
p = None


def _manual_record_snapshot(path: str) -> tuple[bool, float]:
    try:
        stat = os.stat(path)
    except FileNotFoundError:
        return False, 0.0
    except OSError:
        return False, 0.0
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return False, stat.st_mtime
    enabled = False
    if isinstance(data, dict):
        enabled = bool(data.get("enabled", False))
    elif isinstance(data, bool):
        enabled = bool(data)
    return enabled, stat.st_mtime


def _wait_for_encode_completion(job_ids: Iterable[int]) -> None:
    jobs = [job_id for job_id in job_ids if isinstance(job_id, int)]
    for job_id in jobs:
        while True:
            try:
                finished = ENCODING_STATUS.wait_for_finish(job_id, timeout=10.0)
            except KeyboardInterrupt:
                raise
            except Exception as exc:  # noqa: BLE001 - diagnostics only
                print(
                    f"[live] WARN: failed waiting for encode job {job_id}: {exc}",
                    flush=True,
                )
                break
            if finished:
                break
            print(
                f"[live] Waiting for encode job {job_id} to finish...",
                flush=True,
            )

    while True:
        snapshot = ENCODING_STATUS.snapshot()
        if not snapshot:
            break

        def _format(entry: dict[str, object], status: str) -> str:
            job_id = entry.get("id")
            base = entry.get("base_name") or ""
            prefix = f"{job_id}" if isinstance(job_id, int) else "?"
            base_str = f" {base}" if isinstance(base, str) and base else ""
            return f"{prefix}{base_str} ({status})"

        outstanding = [
            _format(entry, "active")
            for entry in snapshot.get("active", [])
            if isinstance(entry, dict)
        ]
        outstanding.extend(
            _format(entry, "pending")
            for entry in snapshot.get("pending", [])
            if isinstance(entry, dict)
        )

        if not outstanding:
            break

        print(
            "[live] Waiting for outstanding encode jobs: "
            + ", ".join(outstanding),
            flush=True,
        )

        try:
            finished = ENCODING_STATUS.wait_for_all(timeout=10.0)
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001 - diagnostics only
            print(
                f"[live] WARN: failed waiting for outstanding encode jobs: {exc}",
                flush=True,
            )
            break

        if finished:
            break

def handle_signal(signum, frame):  # noqa
    global stop_requested, p, split_requested
    if signum == signal.SIGUSR1:
        split_requested = True
        return
    print(f"[live] received signal {signum}, shutting down...", flush=True)
    stop_requested = True
    if p is not None and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass

signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGUSR1, handle_signal)

def spawn_arecord():
    env = os.environ.copy()
    return subprocess.Popen(
        ARECORD_CMD,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        bufsize=0,
        start_new_session=True,
        env=env
    )


def _filter_worker_main(
    cfg_block: Any,
    sample_rate: int,
    frame_bytes: int,
    input_queue: "mp.Queue[Tuple[int, bytes]]",
    output_queue: "mp.Queue[Tuple[int, bytes, Optional[str]]]",
) -> None:
    """Process PCM frames in a dedicated worker process."""
    chain = AudioFilterChain.from_config(cfg_block)
    while True:
        item = input_queue.get()
        if item is None:
            break
        seq, frame = item
        if chain is None:
            output_queue.put((seq, frame, None))
            continue
        try:
            processed = chain.process(sample_rate, frame_bytes, frame)
            output_queue.put((seq, processed, None))
        except Exception as exc:  # pragma: no cover - defensive safeguard
            output_queue.put((seq, frame, repr(exc)))


class FilterPipelineError(RuntimeError):
    """Raised when the filter worker becomes unavailable."""

    def __init__(
        self,
        message: str,
        fallback_frames: Optional[list[Tuple[bytes, Optional[str]]]] = None,
    ) -> None:
        super().__init__(message)
        self.fallback_frames = fallback_frames or []


class FilterPipeline:
    """Offload AudioFilterChain processing to a helper process."""

    def __init__(
        self,
        cfg_block: Any,
        sample_rate: int,
        frame_bytes: int,
        max_pending: int = 4,
    ) -> None:
        self._cfg_block = cfg_block
        self._sample_rate = sample_rate
        self._frame_bytes = frame_bytes
        self._max_pending = max_pending
        self._input: "mp.Queue[Tuple[int, bytes]]" = mp.Queue(maxsize=max_pending * 2)
        self._output: "mp.Queue[Tuple[int, bytes, Optional[str]]]" = mp.Queue(
            maxsize=max_pending * 2
        )
        self._pending = deque()
        self._reorder: dict[int, Tuple[bytes, Optional[str]]] = {}
        self._inflight: dict[int, bytes] = {}
        self._next_seq = 0
        self._process = mp.Process(
            target=_filter_worker_main,
            args=(cfg_block, sample_rate, frame_bytes, self._input, self._output),
            daemon=True,
        )
        self._process.start()
        self._failed = False
        self._fail_reason = ""
        self._stall_timeout = 2.0
        self._last_progress = time.monotonic()

    def push(self, frame: bytes) -> list[Tuple[bytes, Optional[str]]]:
        drained: list[Tuple[bytes, Optional[str]]] = []
        if self._failed:
            raise FilterPipelineError(self._fail_reason, [(frame, self._fail_reason)])
        while len(self._pending) >= self._max_pending:
            drained_chunk = self._drain(block=True, limit=1)
            if drained_chunk:
                drained.extend(drained_chunk)
                continue
            self._ensure_worker_alive()
            if self._pending and self._is_stalled():
                raise self._fail_with_pending("filter worker stalled (no output)")
        seq = self._next_seq
        self._next_seq += 1
        if not self._pending:
            # Reset the stall watchdog when new work arrives after an idle period.
            # Otherwise long gaps between frames (e.g., while arecord is restarting)
            # would immediately trip the timeout even though the worker is healthy.
            self._last_progress = time.monotonic()
        self._inflight[seq] = frame
        try:
            self._input.put((seq, frame))
        except Exception as exc:
            raise self._fail_with_pending(
                f"failed to enqueue frame for filter worker: {exc!r}"
            ) from exc
        self._pending.append(seq)
        drained.extend(self._drain(block=False, limit=None))
        return drained

    def pop_ready(self) -> list[Tuple[bytes, Optional[str]]]:
        if self._failed:
            raise FilterPipelineError(self._fail_reason)
        results = self._drain(block=False, limit=None)
        if not results and self._pending:
            self._ensure_worker_alive()
            if self._is_stalled():
                raise self._fail_with_pending("filter worker stalled (no output)")
        return results

    def drain_all(self) -> list[Tuple[bytes, Optional[str]]]:
        if self._failed:
            raise FilterPipelineError(self._fail_reason)
        results = self._drain(block=False, limit=None)
        while self._pending:
            chunk = self._drain(block=True, limit=None)
            if chunk:
                results.extend(chunk)
                continue
            self._ensure_worker_alive()
            if self._pending and self._is_stalled():
                raise self._fail_with_pending("filter worker stalled (no output)")
        return results

    def close(self) -> None:
        try:
            self._input.put(None, timeout=0.5)
        except Exception as exc:
            print(
                f"[live/filter] failed to signal worker shutdown: {exc!r}",
                flush=True,
            )
        try:
            self._process.join(timeout=1.5)
        except Exception as exc:
            print(
                f"[live/filter] failed waiting for filter worker to exit: {exc!r}",
                flush=True,
            )
        if self._process.is_alive():  # pragma: no cover - defensive cleanup
            self._process.terminate()
        while not self._output.empty():  # drain any stragglers to avoid resource leak
            try:
                self._output.get_nowait()
            except Empty:  # pragma: no cover - should not occur
                break

    def _drain(
        self,
        block: bool,
        limit: Optional[int],
    ) -> list[Tuple[bytes, Optional[str]]]:
        results: list[Tuple[bytes, Optional[str]]] = []
        while self._pending and (limit is None or len(results) < limit):
            try:
                seq, payload, error_text = self._output.get(
                    block=block,
                    timeout=1 if block else 0,
                )
            except Empty:
                break
            expected = self._pending[0]
            if seq != expected:
                self._reorder[seq] = (payload, error_text)
                continue
            self._pending.popleft()
            self._inflight.pop(seq, None)
            results.append((payload, error_text))
            self._last_progress = time.monotonic()
            block = False
            while self._pending and self._pending[0] in self._reorder:
                seq_key = self._pending.popleft()
                payload2, error_text2 = self._reorder.pop(seq_key)
                self._inflight.pop(seq_key, None)
                results.append((payload2, error_text2))
                self._last_progress = time.monotonic()
                if limit is not None and len(results) >= limit:
                    break
        return results

    def _ensure_worker_alive(self) -> None:
        if self._process.is_alive():
            return
        exitcode = self._process.exitcode
        if exitcode is None:
            reason = "filter worker exited unexpectedly"
        else:
            reason = f"filter worker exited with code {exitcode}"
        raise self._fail_with_pending(reason)

    def _is_stalled(self) -> bool:
        return (time.monotonic() - self._last_progress) > self._stall_timeout

    def _fail_with_pending(self, reason: str) -> FilterPipelineError:
        fallback: list[Tuple[bytes, Optional[str]]] = []
        while self._pending:
            seq = self._pending.popleft()
            frame = self._inflight.pop(seq, b"")
            fallback.append((frame, reason))
        self._reorder.clear()
        self._failed = True
        self._fail_reason = reason
        return FilterPipelineError(reason, fallback)

def main():
    global p, stop_requested, split_requested
    stop_requested = False
    split_requested = False
    print(f"[live] starting with device={AUDIO_DEV}", flush=True)
    print(f"[live] streaming mode={STREAM_MODE}", flush=True)

    manual_record_enabled, manual_record_mtime = _manual_record_snapshot(MANUAL_RECORD_PATH)

    try:
        recovery_report = perform_startup_recovery()
        if recovery_report.any_actions():
            cleaned_count = len(recovery_report.removed_wavs) + len(recovery_report.removed_artifacts)
            print(
                "[live] startup recovery queued"
                f" {len(recovery_report.requeued)} encode job(s) and removed {cleaned_count} stale file(s)",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        print(f"[live] WARN: startup recovery failed: {exc!r}", flush=True)

    publish_frame = None
    hls = None
    webrtc_writer = None

    if STREAM_MODE == "hls":
        # Construct HLS encoder but do NOT start it; the web server starts/stops on demand.
        hls_dir = os.path.join(cfg["paths"]["tmp_dir"], "hls")
        os.makedirs(hls_dir, exist_ok=True)
        hls = HLSTee(
            out_dir=hls_dir,
            sample_rate=SAMPLE_RATE,
            channels=1,
            bits_per_sample=16,
            segment_time=2.0,
            history_seconds=60,
            bitrate="64k",
            legacy_extra_ffmpeg_args=LEGACY_HLS_EXTRA_ARGS,
            filter_chain_enabled=AUDIO_FILTER_CHAIN_ENABLED,
        )
        state_path = os.path.join(hls_dir, "controller_state.json")
        controller.set_state_path(state_path, persist=True)
        controller.attach(hls)
        controller.refresh_from_state()

        def publish_frame(frame: bytes) -> None:
            hls.feed(frame)

    else:
        webrtc_dir = os.path.join(cfg["paths"]["tmp_dir"], "webrtc")
        os.makedirs(webrtc_dir, exist_ok=True)
        webrtc_writer = WebRTCBufferWriter(
            webrtc_dir,
            sample_rate=SAMPLE_RATE,
            frame_ms=FRAME_MS,
            frame_bytes=FRAME_BYTES,
            history_seconds=WEBRTC_HISTORY_SECONDS,
        )

        def publish_frame(frame: bytes) -> None:
            webrtc_writer.feed(frame)

    filter_pipeline: Optional[FilterPipeline] = None
    filter_pipeline_launch_error_logged = False

    def ensure_filter_pipeline() -> None:
        nonlocal filter_pipeline, filter_pipeline_launch_error_logged
        if FILTER_CHAIN is None or filter_pipeline is not None:
            return
        try:
            filter_pipeline = FilterPipeline(
                FILTER_CHAIN_CFG,
                SAMPLE_RATE,
                FRAME_BYTES,
            )
            filter_pipeline_launch_error_logged = False
        except Exception as exc:
            if not filter_pipeline_launch_error_logged:
                print(
                    f"[live] failed to launch filter worker: {exc!r} (using in-process filters)",
                    flush=True,
                )
                filter_pipeline_launch_error_logged = True
            filter_pipeline = None

    ensure_filter_pipeline()

    while not stop_requested:
        ensure_filter_pipeline()
        p = None
        try:
            try:
                p = spawn_arecord()
            except Exception as e:
                print(f"[live] failed to launch arecord: {e!r}", flush=True)
                time.sleep(5)
                continue

            manual_record_enabled, manual_record_mtime = _manual_record_snapshot(
                MANUAL_RECORD_PATH
            )
            rec = TimelineRecorder()
            if manual_record_enabled:
                try:
                    rec.set_manual_recording(True)
                except Exception as exc:
                    print(
                        f"[live] WARN: failed to enable manual recording mode: {exc!r}",
                        flush=True,
                    )
            buf = bytearray()
            frame_idx = 0
            last_frame_time = time.monotonic()
            next_state_poll = 0.0
            filter_chain_error_logged = False
            next_manual_poll = 0.0

            def flush_processed(frames: list[Tuple[bytes, Optional[str]]]) -> None:
                nonlocal frame_idx, last_frame_time, filter_chain_error_logged
                for processed_frame, error_text in frames:
                    if error_text:
                        if not filter_chain_error_logged:
                            print(
                                f"[live] filter worker error: {error_text} (falling back to raw frames)",
                                flush=True,
                            )
                            filter_chain_error_logged = True
                    elif filter_chain_error_logged:
                        filter_chain_error_logged = False
                    stream_frame = rec.ingest(processed_frame, frame_idx)
                    if isinstance(stream_frame, memoryview):
                        stream_payload = stream_frame.tobytes()
                    elif isinstance(stream_frame, bytearray):
                        stream_payload = bytes(stream_frame)
                    elif isinstance(stream_frame, bytes):
                        stream_payload = stream_frame
                    else:
                        stream_payload = processed_frame
                    publish_frame(stream_payload)
                    frame_idx += 1
                    last_frame_time = time.monotonic()

            def process_with_filter_chain(raw_frame: bytes) -> None:
                nonlocal filter_chain_error_logged
                processed = raw_frame
                if FILTER_CHAIN is not None:
                    try:
                        processed = FILTER_CHAIN.process(
                            SAMPLE_RATE, FRAME_BYTES, raw_frame
                        )
                        if filter_chain_error_logged:
                            filter_chain_error_logged = False
                    except Exception as exc:
                        if not filter_chain_error_logged:
                            print(
                                f"[live] filter chain error: {exc!r} (falling back to raw frames)",
                                flush=True,
                            )
                            filter_chain_error_logged = True
                        processed = raw_frame
                flush_processed([(processed, None)])

            assert p.stdout is not None
            stderr_fd = p.stderr.fileno() if p.stderr is not None else None
            os.set_blocking(p.stdout.fileno(), True)
            if stderr_fd is not None:
                try:
                    os.set_blocking(stderr_fd, False)
                except Exception:
                    pass

            while not stop_requested:
                if split_requested:
                    if rec.request_manual_split():
                        print("[live] manual split signal received", flush=True)
                        split_requested = False
                    else:
                        print("[live] manual split requested but no active event", flush=True)
                        split_requested = False

                now = time.monotonic()
                if now >= next_manual_poll:
                    next_manual_poll = now + MANUAL_POLL_INTERVAL
                    enabled, mtime = _manual_record_snapshot(MANUAL_RECORD_PATH)
                    if mtime != manual_record_mtime or enabled != manual_record_enabled:
                        manual_record_enabled = enabled
                        manual_record_mtime = mtime
                        try:
                            rec.set_manual_recording(manual_record_enabled)
                        except Exception as exc:
                            print(
                                f"[live] WARN: failed to update manual recording mode: {exc!r}",
                                flush=True,
                            )

                if STREAM_MODE == "hls" and now >= next_state_poll:
                    controller.refresh_from_state()
                    next_state_poll = now + STATE_POLL_INTERVAL
                chunk = p.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break
                buf.extend(chunk)

                while len(buf) >= FRAME_BYTES:
                    frame = bytes(buf[:FRAME_BYTES])
                    del buf[:FRAME_BYTES]
                    if filter_pipeline is not None:
                        try:
                            drained = filter_pipeline.push(frame)
                        except FilterPipelineError as exc:
                            if exc.fallback_frames:
                                flush_processed(exc.fallback_frames)
                            print(
                                f"[live] filter worker failure: {exc} (using in-process filters)",
                                flush=True,
                            )
                            try:
                                filter_pipeline.close()
                            except Exception as close_exc:
                                print(
                                    f"[live] filter pipeline close error: {close_exc!r}",
                                    flush=True,
                                )
                            filter_pipeline = None
                            filter_pipeline_launch_error_logged = False
                            ensure_filter_pipeline()
                            process_with_filter_chain(frame)
                            continue
                        if drained:
                            flush_processed(drained)
                        continue
                    process_with_filter_chain(frame)

                if filter_pipeline is not None:
                    try:
                        drained = filter_pipeline.pop_ready()
                    except FilterPipelineError as exc:
                        if exc.fallback_frames:
                            flush_processed(exc.fallback_frames)
                        print(
                            f"[live] filter worker failure: {exc} (using in-process filters)",
                            flush=True,
                        )
                        try:
                            filter_pipeline.close()
                        except Exception as close_exc:
                            print(
                                f"[live] filter pipeline close error: {close_exc!r}",
                                flush=True,
                            )
                        filter_pipeline = None
                        filter_pipeline_launch_error_logged = False
                        ensure_filter_pipeline()
                        drained = []
                    if drained:
                        flush_processed(drained)

                if filter_pipeline is None:
                    ensure_filter_pipeline()

                now = time.monotonic()
                if now - last_frame_time > 10:
                    print("[live] stall detected (>10s no frames), restarting arecord", flush=True)
                    break

                if stderr_fd is not None:
                    try:
                        while True:
                            data = os.read(stderr_fd, 4096)
                            if not data:
                                break
                    except BlockingIOError:
                        pass
                    except Exception:
                        pass

            if filter_pipeline is not None:
                try:
                    drained = filter_pipeline.drain_all()
                except FilterPipelineError as exc:
                    if exc.fallback_frames:
                        flush_processed(exc.fallback_frames)
                    print(
                        f"[live] filter worker failure during drain: {exc} (using in-process filters)",
                        flush=True,
                    )
                    try:
                        filter_pipeline.close()
                    except Exception as close_exc:
                        print(
                            f"[live] filter pipeline close error: {close_exc!r}",
                            flush=True,
                        )
                    filter_pipeline = None
                    filter_pipeline_launch_error_logged = False
                    drained = []
                if drained:
                    flush_processed(drained)

        except Exception as e:
            print(f"[live] loop error: {e!r}", flush=True)
        finally:
            try:
                if STREAM_MODE == "hls":
                    controller.refresh_from_state()
                    if 'rec' in locals():
                        # Ensure encoder is stopped when daemon exits/restarts.
                        controller.stop_now()
                if filter_pipeline is not None and 'flush_processed' in locals():
                    try:
                        drained = filter_pipeline.drain_all()
                    except FilterPipelineError as exc:
                        if exc.fallback_frames:
                            flush_processed(exc.fallback_frames)
                        print(
                            f"[live] filter worker failure during shutdown: {exc} (using in-process filters)",
                            flush=True,
                        )
                        try:
                            filter_pipeline.close()
                        except Exception as close_exc:
                            print(
                                f"[live] filter pipeline close error: {close_exc!r}",
                                flush=True,
                            )
                        filter_pipeline = None
                        filter_pipeline_launch_error_logged = False
                        drained = []
                    if drained:
                        flush_processed(drained)
                if 'rec' in locals():
                    rec.flush(frame_idx)
                    if stop_requested:
                        _wait_for_encode_completion(rec.encode_job_ids())
            except Exception as e:
                print(f"[live] flush failed: {e!r}", flush=True)

            if p is not None:
                try:
                    if p.poll() is None:
                        p.terminate()
                        try:
                            p.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            p.kill()
                    if p.stdout:
                        p.stdout.close()
                    if p.stderr:
                        p.stderr.close()
                except Exception as e:
                    print(f"[live] cleanup error: {e!r}", flush=True)

            if not stop_requested:
                print("[live] arecord ended or device unavailable; retrying in 3s...", flush=True)
                if reset_usb():
                    print("[live] USB device reset successful", flush=True)
                time.sleep(3)

    if webrtc_writer is not None:
        webrtc_writer.close()
    if filter_pipeline is not None:
        filter_pipeline.close()
    print("[live] clean shutdown complete", flush=True)

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    main()
