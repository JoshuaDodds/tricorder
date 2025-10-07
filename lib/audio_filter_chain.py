"""Audio filter chain utilities for live stream denoising.

This module applies optional high-pass, notch, and spectral gate filters to
16-bit PCM frames. Filter instances keep per-(sample_rate, frame_bytes) state
so that biquad histories persist across frames processed by the live stream
loop. The implementation intentionally avoids heavy dependencies.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple
import cmath
import math

import numpy as np


@dataclass
class HighPassState:
    prev_input: float = 0.0
    prev_output: float = 0.0


@dataclass
class LowPassState:
    prev_output: float = 0.0


@dataclass
class NotchState:
    prev_input: complex = 0.0 + 0.0j
    prev_stage1: complex = 0.0 + 0.0j
    prev_stage3: complex = 0.0 + 0.0j
    prev_stage4: complex = 0.0 + 0.0j


@dataclass
class FilterState:
    sample_rate: int
    frame_bytes: int
    highpass_state: HighPassState
    lowpass_state: LowPassState
    notch_states: List[NotchState]
    notch_coeffs: List[Optional["_NotchFilterParams"]]
    noise_estimate: Optional[np.ndarray] = None
    noise_history: Optional[np.ndarray] = None
    noise_history_pos: int = 0
    noise_history_filled: int = 0
    gate_startup_frames: int = 0


@dataclass
class _NotchFilterParams:
    sample_rate: int
    zero: complex
    pole1: complex
    pole2: complex
    scale: float


class AudioFilterChain:
    """Apply a sequence of lightweight filters to PCM frames."""

    def __init__(self, cfg: Optional[Any] = None):
        raw_cfg: Dict[str, Any]
        filters_payload: Sequence[Any] | None = None
        if isinstance(cfg, dict):
            raw_cfg = cfg
            payload = raw_cfg.get("filters")
            if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes)):
                filters_payload = list(payload)
        elif isinstance(cfg, Sequence) and not isinstance(cfg, (bytes, str)):
            filters_payload = list(cfg)
            raw_cfg = {"filters": filters_payload}
        else:
            raw_cfg = {}

        self.enabled = bool(raw_cfg.get("enabled", True))

        denoise_cfg = raw_cfg.get("denoise", {})
        denoise_type = str(denoise_cfg.get("type", "afftdn")).strip().lower()
        if denoise_type not in {"afftdn"}:
            denoise_type = "afftdn"
            denoise_enabled = False
        else:
            denoise_enabled = bool(denoise_cfg.get("enabled", False))
        self.denoise_type = denoise_type
        self.denoise_noise_floor_db = float(denoise_cfg.get("noise_floor_db", -30.0))
        self.denoise_enabled = denoise_enabled

        lowpass_cfg = raw_cfg.get("lowpass", {})
        self.lowpass_enabled = bool(lowpass_cfg.get("enabled", False))
        self.lowpass_cutoff_hz = float(lowpass_cfg.get("cutoff_hz", 10000.0))

        highpass_cfg = raw_cfg.get("highpass", {})
        self.highpass_enabled = bool(highpass_cfg.get("enabled", True))
        self.highpass_cutoff_hz = float(highpass_cfg.get("cutoff_hz", 80.0))

        notch_cfg = raw_cfg.get("notch", {})
        self.notch_enabled = bool(notch_cfg.get("enabled", True))
        self.notch_freq_hz = float(notch_cfg.get("freq_hz", 60.0))
        self.notch_q = float(notch_cfg.get("quality", 30.0))
        self._notch_filters: List[Tuple[float, float]] = []
        if self.notch_enabled:
            self._append_notch_filter(self.notch_freq_hz, self.notch_q)

        filters_payload = raw_cfg.get("filters", filters_payload)
        if isinstance(filters_payload, Sequence) and not isinstance(filters_payload, (str, bytes)):
            for entry in list(filters_payload):
                parsed = self._parse_notch_entry(entry)
                if parsed is not None:
                    self._append_notch_filter(*parsed)

        if self._notch_filters:
            self.notch_freq_hz, self.notch_q = self._notch_filters[0]
            self.notch_enabled = True
        else:
            self.notch_enabled = False

        gate_cfg = raw_cfg.get("spectral_gate", {})
        self.spectral_gate_enabled = bool(gate_cfg.get("enabled", False))
        self.gate_sensitivity = float(gate_cfg.get("sensitivity", 1.5))
        self.gate_reduction_db = float(gate_cfg.get("reduction_db", -18.0))
        self.gate_update = float(gate_cfg.get("noise_update", 0.1))
        self.gate_decay = float(gate_cfg.get("noise_decay", 0.95))
        # Internal spectral gate heuristics: maintain ~0.8s of history and use a
        # short (~40ms) warmup so the percentile estimate reflects the ambient
        # noise floor rather than the very first frame.
        self._gate_history_seconds = 0.8
        self._gate_startup_seconds = 0.04
        self._gate_noise_percentile = 70.0

        self._states: Dict[Tuple[int, int], FilterState] = {}

        # If all individual stages are disabled, treat the chain as disabled to
        # avoid unnecessary numpy conversions on every frame. This preserves the
        # intent of configs that omit explicit filters while keeping the
        # top-level "enabled" flag as an override when at least one stage is
        # active.
        if self.enabled and not (
            self.denoise_enabled
            or self.highpass_enabled
            or self.lowpass_enabled
            or self.notch_enabled
            or self.spectral_gate_enabled
        ):
            self.enabled = False

    def _append_notch_filter(self, frequency_hz: float, q: float) -> None:
        try:
            freq = float(frequency_hz)
            quality = float(q)
        except (TypeError, ValueError):
            return
        if freq <= 0 or quality <= 0:
            return
        candidate = (freq, quality)
        for existing in self._notch_filters:
            if abs(existing[0] - freq) < 1e-6 and abs(existing[1] - quality) < 1e-6:
                return
        self._notch_filters.append(candidate)

    def _parse_notch_entry(self, entry: Any) -> Optional[Tuple[float, float]]:
        if not isinstance(entry, dict):
            return None
        entry_type = entry.get("type")
        if entry_type is not None and str(entry_type).lower() not in {"notch"}:
            return None
        enabled = entry.get("enabled", True)
        if isinstance(enabled, str):
            enabled = enabled.strip().lower() in {"1", "true", "yes", "on"}
        elif isinstance(enabled, (int, float)) and not isinstance(enabled, bool):
            enabled = bool(enabled)
        if not enabled:
            return None
        freq = entry.get("frequency")
        if freq is None:
            freq = entry.get("freq_hz")
        if freq is None:
            freq = entry.get("frequency_hz")
        q = entry.get("q")
        if q is None:
            q = entry.get("quality")
        if freq is None or q is None:
            return None
        try:
            freq_val = float(freq)
            q_val = float(q)
        except (TypeError, ValueError):
            return None
        if freq_val <= 0 or q_val <= 0:
            return None
        return (freq_val, q_val)

    @classmethod
    def from_config(cls, cfg_block: Optional[Any]) -> Optional["AudioFilterChain"]:
        if not cfg_block:
            return None
        if isinstance(cfg_block, Sequence) and not isinstance(cfg_block, (str, bytes)):
            cfg_block = {"enabled": True, "filters": list(cfg_block)}
        if not isinstance(cfg_block, dict):
            return None
        enabled = cfg_block.get("enabled", True)
        if isinstance(enabled, str):
            enabled = enabled.lower() in {"1", "true", "yes", "on"}
        if not enabled:
            return None
        chain = cls(cfg_block)
        if not chain.enabled:
            return None
        return chain

    def process(self, sample_rate: int, frame_bytes: int, frame: bytes) -> bytes:
        if not self.enabled:
            return frame
        if len(frame) != frame_bytes:
            raise ValueError("Frame length does not match configured frame_bytes")

        state = self._states.get((sample_rate, frame_bytes))
        if state is None:
            state = self._init_state(sample_rate, frame_bytes)
            self._states[(sample_rate, frame_bytes)] = state

        pcm = np.frombuffer(frame, dtype="<i2").astype(np.float32)

        if self.denoise_enabled:
            pcm = self._apply_denoise(pcm)

        if self.highpass_enabled:
            pcm = self._apply_highpass(pcm, state.highpass_state, sample_rate)

        if self.lowpass_enabled:
            pcm = self._apply_lowpass(pcm, state.lowpass_state, sample_rate)

        if self.notch_enabled:
            pcm = self._apply_notch(pcm, state, sample_rate)

        if self.spectral_gate_enabled:
            pcm = self._apply_gate(pcm, state)

        pcm = np.clip(np.rint(pcm), -32768, 32767).astype("<i2")
        return pcm.tobytes()

    def _init_state(self, sample_rate: int, frame_bytes: int) -> FilterState:
        notch_count = len(self._notch_filters) if self.notch_enabled else 0
        gate_history = None
        gate_startup_frames = 0
        if self.spectral_gate_enabled:
            frame_samples = max(1, frame_bytes // 2)
            frames_per_second = max(1, int(round(sample_rate / frame_samples)))
            history_len = max(
                4,
                min(200, int(round(self._gate_history_seconds * frames_per_second))),
            )
            freq_bins = frame_samples // 2 + 1
            gate_history = np.zeros((history_len, freq_bins), dtype=np.float32)
            gate_startup_frames = max(
                1,
                min(history_len, int(round(self._gate_startup_seconds * frames_per_second))),
            )
        state = FilterState(
            sample_rate=sample_rate,
            frame_bytes=frame_bytes,
            highpass_state=HighPassState(),
            lowpass_state=LowPassState(),
            notch_states=[NotchState() for _ in range(notch_count)],
            notch_coeffs=[None for _ in range(notch_count)],
            noise_history=gate_history,
            gate_startup_frames=gate_startup_frames,
        )

        return state

    def _apply_highpass(
        self, data: np.ndarray, state: HighPassState, sample_rate: int
    ) -> np.ndarray:
        if self.highpass_cutoff_hz <= 0:
            return data
        rc = 1.0 / (2.0 * math.pi * self.highpass_cutoff_hz)
        dt = 1.0 / float(sample_rate)
        alpha = rc / (rc + dt)
        if not data.size:
            return data
        deltas = np.empty_like(data)
        deltas[0] = data[0] - state.prev_input
        if data.size > 1:
            deltas[1:] = np.diff(data)
        drive = alpha * deltas
        result = self._solve_first_order_recursive(alpha, drive, state.prev_output)
        state.prev_input = float(data[-1])
        state.prev_output = float(result[-1])
        return result

    def _apply_lowpass(
        self, data: np.ndarray, state: LowPassState, sample_rate: int
    ) -> np.ndarray:
        if self.lowpass_cutoff_hz <= 0:
            return data
        rc = 1.0 / (2.0 * math.pi * self.lowpass_cutoff_hz)
        dt = 1.0 / float(sample_rate)
        alpha = dt / (rc + dt)
        coeff = 1.0 - alpha
        if not data.size:
            return data
        drive = (alpha * data).astype(data.dtype, copy=False)
        result = self._solve_first_order_recursive(coeff, drive, state.prev_output)
        if result.size:
            state.prev_output = float(result[-1])
        return result

    def _apply_denoise(self, data: np.ndarray) -> np.ndarray:
        if self.denoise_type != "afftdn" or not data.size:
            return data
        normalized = data.astype(np.float32, copy=False) / 32768.0
        spectrum = np.fft.rfft(normalized)
        mags = np.abs(spectrum)
        safe_mags = np.maximum(mags, 1e-8)
        mags_db = 20.0 * np.log10(safe_mags)
        target_db = np.minimum(mags_db, self.denoise_noise_floor_db)
        gains_db = target_db - mags_db
        gains = 10.0 ** (gains_db / 20.0)
        spectrum *= gains
        restored = np.fft.irfft(spectrum, n=normalized.size)
        restored *= 32768.0
        return restored.astype(data.dtype, copy=False)

    @staticmethod
    def _solve_first_order_recursive(
        coeff: complex, drive: np.ndarray, prev: complex
    ) -> np.ndarray:
        """Solve y[n] = coeff * y[n-1] + drive[n] without breaking continuity.

        The implementation keeps the numerically stable recurrence that powered
        the original scalar loop, ensuring coefficients with small magnitude do
        not overflow while still producing an ndarray output for downstream
        vectorized stages.
        """
        if not drive.size:
            return drive
        coeff_val = coeff
        if abs(coeff_val) < 1e-12:
            return drive.astype(drive.dtype, copy=True)
        work_complex = np.iscomplexobj(drive) or abs(coeff_val.imag) > 1e-18
        work_dtype = np.complex128 if work_complex else np.float64
        drive_arr = drive.astype(work_dtype, copy=False)
        prev_val = work_dtype(prev)
        coeff_scalar = coeff_val if work_complex else coeff_val.real
        coeff_arr = work_dtype(coeff_scalar)
        result = np.empty_like(drive_arr)
        acc = coeff_arr * prev_val + drive_arr[0]
        result[0] = acc
        for idx in range(1, drive_arr.size):
            acc = coeff_arr * acc + drive_arr[idx]
            result[idx] = acc
        return result.astype(drive.dtype, copy=False)

    def _compute_notch_coeffs(
        self, sample_rate: int, frequency_hz: float, quality: float
    ) -> _NotchFilterParams:
        freq = max(1.0, min(float(frequency_hz), sample_rate / 2 - 1.0))
        q = max(0.1, float(quality))
        omega = 2.0 * math.pi * (freq / sample_rate)
        cos_omega = math.cos(omega)
        sin_omega = math.sin(omega)
        alpha = sin_omega / (2.0 * q)
        denom = 1.0 + alpha
        # Denominator coefficients follow the RBJ cookbook biquad after normalizing by (1 + alpha).
        a1 = -2.0 * cos_omega / denom
        a2 = (1.0 - alpha) / denom
        zero = cos_omega + 1j * sin_omega
        discriminant = complex(a1 * a1 - 4.0 * a2)
        sqrt_disc = cmath.sqrt(discriminant)
        pole1 = (-a1 + sqrt_disc) / 2.0
        pole2 = (-a1 - sqrt_disc) / 2.0
        scale = 1.0 / denom
        return _NotchFilterParams(
            sample_rate=sample_rate,
            zero=zero,
            pole1=pole1,
            pole2=pole2,
            scale=scale,
        )

    def _apply_notch(self, data: np.ndarray, state: FilterState, sample_rate: int) -> np.ndarray:
        if not self._notch_filters:
            return data
        if len(state.notch_states) != len(self._notch_filters):
            state.notch_states = [NotchState() for _ in self._notch_filters]
            state.notch_coeffs = [None for _ in self._notch_filters]
        result = data
        for idx, (freq, quality) in enumerate(self._notch_filters):
            coeffs = state.notch_coeffs[idx]
            if coeffs is None or coeffs.sample_rate != sample_rate:
                coeffs = self._compute_notch_coeffs(sample_rate, freq, quality)
                state.notch_coeffs[idx] = coeffs
            result = self._apply_notch_stage(result, state.notch_states[idx], coeffs)
        return result

    def _apply_notch_stage(
        self, data: np.ndarray, notch_state: NotchState, params: _NotchFilterParams
    ) -> np.ndarray:
        if not data.size:
            return data
        complex_data = data.astype(np.complex64, copy=False)
        shifted = np.empty_like(complex_data)
        shifted[0] = notch_state.prev_input
        if complex_data.size > 1:
            shifted[1:] = complex_data[:-1]
        stage1 = complex_data - params.zero * shifted
        notch_state.prev_input = complex_data[-1]

        shifted_stage1 = np.empty_like(stage1)
        shifted_stage1[0] = notch_state.prev_stage1
        if stage1.size > 1:
            shifted_stage1[1:] = stage1[:-1]
        stage2 = stage1 - np.conjugate(params.zero) * shifted_stage1
        notch_state.prev_stage1 = stage1[-1]

        stage3 = self._solve_first_order_recursive(
            params.pole1, stage2, notch_state.prev_stage3
        )
        notch_state.prev_stage3 = stage3[-1]
        stage4 = self._solve_first_order_recursive(
            params.pole2, stage3, notch_state.prev_stage4
        )
        notch_state.prev_stage4 = stage4[-1]
        final = (params.scale * stage4).real.astype(data.dtype, copy=False)
        return final

    def _apply_gate(self, data: np.ndarray, state: FilterState) -> np.ndarray:
        spectrum = np.fft.rfft(data)
        mags = np.abs(spectrum).astype(np.float32, copy=False)

        history = state.noise_history
        if history is None or history.shape[1] != mags.size:
            frame_samples = max(1, state.frame_bytes // 2)
            frames_per_second = max(1, int(round(state.sample_rate / frame_samples)))
            history_len = max(
                4,
                min(200, int(round(self._gate_history_seconds * frames_per_second))),
            )
            history = np.zeros((history_len, mags.size), dtype=np.float32)
            state.noise_history = history
            state.noise_history_pos = 0
            state.noise_history_filled = 0
            state.gate_startup_frames = max(
                1,
                min(history_len, int(round(self._gate_startup_seconds * frames_per_second))),
            )

        history[state.noise_history_pos] = mags
        state.noise_history_pos = (state.noise_history_pos + 1) % history.shape[0]
        if state.noise_history_filled < history.shape[0]:
            state.noise_history_filled += 1

        if state.noise_history_filled < max(1, state.gate_startup_frames):
            return data

        if state.noise_history_filled < history.shape[0]:
            samples = history[: state.noise_history_filled]
        else:
            samples = history

        noise = np.percentile(samples, self._gate_noise_percentile, axis=0).astype(
            np.float32,
            copy=False,
        )
        state.noise_estimate = noise

        noise = np.maximum(noise, 1e-6)
        threshold = noise * self.gate_sensitivity
        gain_floor = 10 ** (self.gate_reduction_db / 20.0)
        gains = np.where(mags >= threshold, 1.0, gain_floor)
        spectrum *= gains

        restored = np.fft.irfft(spectrum, n=data.size)
        return restored.astype(data.dtype, copy=False)
