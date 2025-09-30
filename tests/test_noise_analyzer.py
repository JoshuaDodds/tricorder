import math

import numpy as np
import pytest

from lib.noise_analyzer import analyze_idle_noise, recommend_notch_filters, summarize_peaks

SAMPLE_RATE = 48000


def synth_pcm(frequencies, duration=2.0, sample_rate=SAMPLE_RATE, amplitudes=None):
    t = np.arange(int(duration * sample_rate)) / sample_rate
    signal = np.zeros_like(t)
    if amplitudes is None:
        amplitudes = [1.0] * len(frequencies)
    for freq, amp in zip(frequencies, amplitudes):
        signal += amp * np.sin(2 * math.pi * freq * t)
    peak = np.max(np.abs(signal))
    if peak == 0:
        return np.zeros_like(t, dtype=np.int16).tobytes()
    normalized = signal / (peak * 1.05)
    pcm = (normalized * 32767).astype(np.int16)
    return pcm.tobytes()


def test_analyze_idle_noise_identifies_single_hum():
    pcm = synth_pcm([60.0])
    peaks = analyze_idle_noise(pcm, SAMPLE_RATE, top_n=1, min_freq_hz=30.0, max_freq_hz=200.0)
    assert len(peaks) == 1
    assert abs(peaks[0].frequency_hz - 60.0) < 1.0
    assert peaks[0].q > 5.0


def test_analyze_idle_noise_returns_multiple_peaks_sorted():
    pcm = synth_pcm([120.0, 60.0], amplitudes=[0.6, 1.0])
    peaks = analyze_idle_noise(pcm, SAMPLE_RATE, top_n=2, min_freq_hz=30.0, max_freq_hz=300.0)
    assert len(peaks) == 2
    # Stronger 60 Hz tone should appear first
    assert abs(peaks[0].frequency_hz - 60.0) < 1.0
    assert abs(peaks[1].frequency_hz - 120.0) < 1.0


def test_recommend_notch_filters_uses_peak_metadata():
    pcm = synth_pcm([180.0])
    peaks = analyze_idle_noise(pcm, SAMPLE_RATE, top_n=1, min_freq_hz=50.0, max_freq_hz=400.0)
    filters = recommend_notch_filters(peaks, max_filters=1)
    assert len(filters) == 1
    entry = filters[0]
    assert entry["type"] == "notch"
    assert entry["frequency"] == pytest.approx(180.0, rel=0.01)
    assert 2.0 <= entry["q"] <= 50.0
    assert entry["gain_db"] == -18.0


def test_summarize_peaks_formats_description():
    pcm = synth_pcm([90.0])
    peaks = analyze_idle_noise(pcm, SAMPLE_RATE, top_n=1, min_freq_hz=50.0, max_freq_hz=200.0)
    summary = summarize_peaks(peaks)
    assert "90.0 Hz" in summary
    assert "Q≈" in summary


