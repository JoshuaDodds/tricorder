"""Utilities for idle-noise analysis and filter suggestions."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Sequence

import numpy as np


@dataclass(frozen=True)
class HumPeak:
    """Represents a dominant hum component discovered during FFT analysis."""

    frequency_hz: float
    magnitude_dbfs: float
    bandwidth_hz: float
    q: float


def _pcm_to_float32(pcm: bytes) -> np.ndarray:
    if not pcm:
        return np.array([], dtype=np.float32)
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    return samples / 32768.0


def analyze_idle_noise(
    pcm: bytes,
    sample_rate_hz: int,
    *,
    top_n: int = 3,
    min_freq_hz: float = 30.0,
    max_freq_hz: float | None = None,
) -> List[HumPeak]:
    """Return the strongest narrow-band components in the supplied PCM buffer."""

    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")
    if max_freq_hz is None:
        max_freq_hz = sample_rate_hz / 2.0
    window = _pcm_to_float32(pcm)
    if window.size == 0:
        return []

    window = window - np.mean(window)
    hann = np.hanning(window.size)
    spectrum = np.fft.rfft(window * hann)
    magnitudes = np.abs(spectrum)
    # Convert to dBFS, guard against zeros.
    magnitudes_db = 20.0 * np.log10(np.maximum(magnitudes, 1e-12))

    freqs = np.fft.rfftfreq(window.size, 1.0 / sample_rate_hz)
    min_idx = int(np.searchsorted(freqs, max(min_freq_hz, 0.0), side="left"))
    max_idx = int(np.searchsorted(freqs, max_freq_hz, side="right"))
    min_idx = max(min_idx, 1)
    max_idx = min(max_idx, len(freqs))
    if min_idx >= max_idx:
        return []

    peaks: list[HumPeak] = []
    for idx in range(min_idx, max_idx - 1):
        if idx <= 0 or idx >= len(magnitudes_db) - 1:
            continue
        left = magnitudes_db[idx - 1]
        mid = magnitudes_db[idx]
        right = magnitudes_db[idx + 1]
        if mid <= left or mid < right:
            continue
        freq = freqs[idx]
        mag = mid
        half_power = mid - 3.0

        left_idx = idx
        while left_idx > min_idx and magnitudes_db[left_idx] > half_power:
            left_idx -= 1
        right_idx = idx
        while right_idx < max_idx - 1 and magnitudes_db[right_idx] > half_power:
            right_idx += 1

        bandwidth = max(freqs[right_idx] - freqs[left_idx], 1e-6)
        q = freq / bandwidth if bandwidth > 0 else float("inf")
        peaks.append(HumPeak(freq, mag, bandwidth, q))

    peaks.sort(key=lambda peak: peak.magnitude_dbfs, reverse=True)
    return peaks[:top_n]


def recommend_notch_filters(
    peaks: Sequence[HumPeak],
    *,
    max_filters: int = 3,
    min_q: float = 2.0,
    max_q: float = 50.0,
    attenuation_db: float = -18.0,
) -> list[dict[str, float | str]]:
    """Return notch filter suggestions compatible with audio.filter_chain."""

    filters: list[dict[str, float | str]] = []
    for peak in peaks[:max_filters]:
        if peak.frequency_hz <= 0:
            continue
        bounded_q = max(min_q, min(max_q, peak.q))
        filters.append(
            {
                "type": "notch",
                "frequency": round(peak.frequency_hz, 2),
                "q": round(bounded_q, 2),
                "gain_db": attenuation_db,
            }
        )
    return filters


def summarize_peaks(peaks: Iterable[HumPeak]) -> str:
    parts: list[str] = []
    for peak in peaks:
        parts.append(
            f"{peak.frequency_hz:.1f} Hz (Q≈{peak.q:.1f}, bandwidth {peak.bandwidth_hz:.1f} Hz, {peak.magnitude_dbfs:.1f} dBFS)"
        )
    if not parts:
        return "no dominant hum components found"
    return ", ".join(parts)
