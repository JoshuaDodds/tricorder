"""Audio filter chain utilities for live stream denoising.

This module applies optional high-pass, notch, and spectral gate filters to
16-bit PCM frames. Filter instances keep per-(sample_rate, frame_bytes) state
so that FFT-domain transfer functions and noise profiles persist across frames
processed by the live stream loop. The implementation intentionally avoids
heavy dependencies.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional, Sequence, Tuple
import math

import numpy as np


@dataclass
class HighpassState:
    alpha: float
    powers: np.ndarray
    weights: np.ndarray
    prev_input: float = 0.0
    prev_output: float = 0.0


@dataclass
class NotchStageState:
    powers: np.ndarray
    g: np.ndarray
    c_vec: np.ndarray
    d_gain: float
    state_vec: np.ndarray


@dataclass
class FilterState:
    sample_rate: int
    frame_bytes: int
    frame_samples: int
    highpass_state: Optional[HighpassState]
    notch_stages: list[NotchStageState]
    noise_estimate: Optional[np.ndarray] = None


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

        highpass_cfg = raw_cfg.get("highpass", {})
        self.highpass_enabled = bool(highpass_cfg.get("enabled", True))
        self.highpass_cutoff_hz = float(highpass_cfg.get("cutoff_hz", 80.0))

        notch_cfg = raw_cfg.get("notch", {})
        self.notch_enabled = bool(notch_cfg.get("enabled", True))
        self.notch_freq_hz = float(notch_cfg.get("freq_hz", 60.0))
        self.notch_q = float(notch_cfg.get("quality", 30.0))
        self._notch_filters: list[Tuple[float, float]] = []
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

        self._states: Dict[Tuple[int, int], FilterState] = {}

        # If all individual stages are disabled, treat the chain as disabled to
        # avoid unnecessary numpy conversions on every frame. This preserves the
        # intent of configs that omit explicit filters while keeping the
        # top-level "enabled" flag as an override when at least one stage is
        # active.
        if self.enabled and not (
            self.highpass_enabled or self.notch_enabled or self.spectral_gate_enabled
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

        if self.highpass_enabled and state.highpass_state is not None:
            pcm = self._apply_highpass(pcm, state.highpass_state)

        if self.notch_enabled and state.notch_stages:
            pcm = self._apply_notch(pcm, state)

        if self.spectral_gate_enabled:
            pcm = self._apply_gate(pcm, state)

        pcm = np.clip(np.rint(pcm), -32768, 32767).astype("<i2")
        return pcm.tobytes()

    def _init_state(self, sample_rate: int, frame_bytes: int) -> FilterState:
        frame_samples = frame_bytes // 2
        if frame_samples <= 0:
            raise ValueError("frame_bytes must correspond to at least one sample")

        highpass_state: Optional[HighpassState] = None
        if self.highpass_enabled and self.highpass_cutoff_hz > 0:
            rc = 1.0 / (2.0 * math.pi * self.highpass_cutoff_hz)
            dt = 1.0 / float(sample_rate)
            alpha = rc / (rc + dt)
            powers = np.power(alpha, np.arange(frame_samples, dtype=np.float64))
            weights = np.zeros(frame_samples, dtype=np.float64)
            if frame_samples > 0:
                weights[0] = alpha
                if frame_samples > 1:
                    with np.errstate(divide="ignore", invalid="ignore"):
                        weights[1:] = alpha / powers[1:]
                    weights[1:][~np.isfinite(weights[1:])] = 0.0
            highpass_state = HighpassState(
                alpha=float(alpha),
                powers=powers,
                weights=weights,
            )

        notch_stages: list[NotchStageState] = []
        if self.notch_enabled and self._notch_filters:
            for freq, quality in self._notch_filters:
                b0, b1, b2, a1, a2 = self._compute_notch_coeffs(
                    sample_rate, freq, quality
                )
                A = np.array([[-a1, -a2], [1.0, 0.0]], dtype=np.float64)
                powers = np.empty((frame_samples + 1, 2, 2), dtype=np.float64)
                powers[0] = np.eye(2, dtype=np.float64)
                for idx in range(1, frame_samples + 1):
                    powers[idx] = powers[idx - 1] @ A
                b_vec = np.array([1.0, 0.0], dtype=np.float64)
                g = np.einsum("nij,j->ni", powers[:-1], b_vec)
                c_vec = np.array(
                    [b1 - b0 * a1, b2 - b0 * a2],
                    dtype=np.float64,
                )
                notch_stages.append(
                    NotchStageState(
                        powers=powers,
                        g=g,
                        c_vec=c_vec,
                        d_gain=float(b0),
                        state_vec=np.zeros(2, dtype=np.float64),
                    )
                )

        return FilterState(
            sample_rate=sample_rate,
            frame_bytes=frame_bytes,
            frame_samples=frame_samples,
            highpass_state=highpass_state,
            notch_stages=notch_stages,
        )

    def _apply_highpass(self, data: np.ndarray, state: HighpassState) -> np.ndarray:
        if data.size == 0:
            return data
        alpha = state.alpha
        if alpha == 0.0:
            state.prev_input = float(data[-1])
            state.prev_output = 0.0
            return np.zeros_like(data)

        data64 = data.astype(np.float64, copy=False)
        dx = np.empty_like(data64)
        dx[0] = data64[0] - state.prev_input
        if data64.size > 1:
            np.subtract(data64[1:], data64[:-1], out=dx[1:])
        increments = state.weights[: data64.size] * dx
        z = np.cumsum(increments, dtype=np.float64)
        z += alpha * state.prev_output
        y = state.powers[: data64.size] * z
        state.prev_input = float(data64[-1])
        state.prev_output = float(y[-1])
        return y.astype(data.dtype, copy=False)

    def _apply_notch(self, data: np.ndarray, state: FilterState) -> np.ndarray:
        if not state.notch_stages:
            return data
        output = data.astype(np.float64, copy=False)
        for stage in state.notch_stages:
            output = self._run_notch_stage(output, stage)
        return output.astype(data.dtype, copy=False)

    def _run_notch_stage(
        self, data: np.ndarray, stage: NotchStageState
    ) -> np.ndarray:
        N = data.size
        if N == 0:
            return data
        powers = stage.powers
        g = stage.g
        base = np.einsum("nij,j->ni", powers[:N], stage.state_vec)
        if N > 1:
            conv0 = np.convolve(data, g[:N, 0], mode="full")
            conv1 = np.convolve(data, g[:N, 1], mode="full")
            base[1:, 0] += conv0[: N - 1]
            base[1:, 1] += conv1[: N - 1]
        else:
            conv0 = np.convolve(data, g[:N, 0], mode="full")
            conv1 = np.convolve(data, g[:N, 1], mode="full")
        stage_output = stage.d_gain * data + np.einsum("ni,i->n", base, stage.c_vec)
        next_state = powers[N] @ stage.state_vec
        next_state[0] += conv0[N - 1]
        next_state[1] += conv1[N - 1]
        stage.state_vec = next_state
        return stage_output

    def _compute_notch_coeffs(
        self, sample_rate: int, frequency_hz: float, quality: float
    ) -> Tuple[float, float, float, float, float]:
        freq = max(1.0, min(float(frequency_hz), sample_rate / 2 - 1.0))
        q = max(0.1, float(quality))
        omega = 2.0 * math.pi * (freq / sample_rate)
        cos_omega = math.cos(omega)
        alpha = math.sin(omega) / (2.0 * q)

        b0 = 1.0
        b1 = -2.0 * cos_omega
        b2 = 1.0
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_omega
        a2 = 1.0 - alpha

        b0 /= a0
        b1 /= a0
        b2 /= a0
        a1 /= a0
        a2 /= a0
        return (b0, b1, b2, a1, a2)
    def _apply_gate(self, data: np.ndarray, state: FilterState) -> np.ndarray:
        spectrum = np.fft.rfft(data)
        mags = np.abs(spectrum)

        if state.noise_estimate is None or state.noise_estimate.shape != mags.shape:
            state.noise_estimate = mags.astype(np.float32, copy=True)
        else:
            decay = float(np.clip(self.gate_decay, 0.0, 1.0))
            update = float(np.clip(self.gate_update, 0.0, 1.0))
            higher = mags > state.noise_estimate
            if np.any(higher):
                state.noise_estimate[higher] = (
                    (1.0 - update) * state.noise_estimate[higher]
                    + update * mags[higher]
                )
            if np.any(~higher):
                state.noise_estimate[~higher] = (
                    decay * state.noise_estimate[~higher]
                    + (1.0 - decay) * mags[~higher]
                )

        noise = np.maximum(state.noise_estimate, 1e-6)
        threshold = noise * self.gate_sensitivity
        gain_floor = 10 ** (self.gate_reduction_db / 20.0)
        gains = np.where(mags >= threshold, 1.0, gain_floor)
        spectrum *= gains

        restored = np.fft.irfft(spectrum, n=data.size)
        return restored.astype(data.dtype, copy=False)
