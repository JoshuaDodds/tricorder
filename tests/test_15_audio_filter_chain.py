import math

import numpy as np

from lib.audio_filter_chain import AudioFilterChain


SAMPLE_RATE = 48000
FRAME_MS = 20
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
FRAME_BYTES = FRAME_SAMPLES * 2


def float_to_pcm(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples, -0.9999695, 0.9999695)
    return (clipped * 32767.0).astype("<i2").tobytes()


def pcm_to_float(frame: bytes) -> np.ndarray:
    return np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0


def test_chain_disabled_when_all_stages_off():
    chain = AudioFilterChain(
        {
            "enabled": True,
            "highpass": {"enabled": False},
            "notch": {"enabled": False},
            "spectral_gate": {"enabled": False},
        }
    )
    assert chain.enabled is False

    cfg = {
        "enabled": True,
        "highpass": {"enabled": False},
        "notch": {"enabled": False},
        "spectral_gate": {"enabled": False},
    }
    assert AudioFilterChain.from_config(cfg) is None


def test_highpass_attenuates_rumble():
    chain = AudioFilterChain(
        {
            "enabled": True,
            "highpass": {"enabled": True, "cutoff_hz": 70.0},
            "notch": {"enabled": False},
            "spectral_gate": {"enabled": False},
        }
    )

    t = np.arange(FRAME_SAMPLES * 10)
    rumble = 0.8 * np.sin(2 * math.pi * 20.0 * t / SAMPLE_RATE)

    input_frames = [float_to_pcm(rumble[i : i + FRAME_SAMPLES]) for i in range(0, len(rumble), FRAME_SAMPLES)]
    filtered_chunks = []
    for frame in input_frames:
        out = chain.process(SAMPLE_RATE, FRAME_BYTES, frame)
        filtered_chunks.append(pcm_to_float(out))

    filtered = np.concatenate(filtered_chunks)
    input_rms = np.sqrt(np.mean(rumble**2))
    filtered_rms = np.sqrt(np.mean(filtered**2))
    assert filtered_rms < input_rms * 0.35


def test_notch_suppresses_mains_hum():
    chain = AudioFilterChain(
        {
            "enabled": True,
            "highpass": {"enabled": False},
            "notch": {"enabled": True, "freq_hz": 60.0, "quality": 30.0},
            "spectral_gate": {"enabled": False},
        }
    )

    t = np.arange(FRAME_SAMPLES * 60)
    hum = 0.5 * np.sin(2 * math.pi * 60.0 * t / SAMPLE_RATE)
    tone = 0.2 * np.sin(2 * math.pi * 400.0 * t / SAMPLE_RATE)
    signal = hum + tone

    frames = [float_to_pcm(signal[i : i + FRAME_SAMPLES]) for i in range(0, len(signal), FRAME_SAMPLES)]
    filtered_chunks = []
    for frame in frames:
        out = chain.process(SAMPLE_RATE, FRAME_BYTES, frame)
        filtered_chunks.append(pcm_to_float(out))

    warmup_frames = 5
    filtered = np.concatenate(filtered_chunks[warmup_frames:])
    reference = signal[FRAME_SAMPLES * warmup_frames : FRAME_SAMPLES * warmup_frames + filtered.size]

    def spectrum_peak(samples: np.ndarray, target_hz: float) -> float:
        window = np.hanning(samples.size)
        spec = np.fft.rfft(samples * window)
        freqs = np.fft.rfftfreq(samples.size, d=1.0 / SAMPLE_RATE)
        idx = np.argmin(np.abs(freqs - target_hz))
        return np.abs(spec[idx])

    original_peak = spectrum_peak(reference, 60.0)
    filtered_peak = spectrum_peak(filtered, 60.0)
    assert filtered_peak < original_peak * 0.2

    tone_peak_original = spectrum_peak(reference, 400.0)
    tone_peak_filtered = spectrum_peak(filtered, 400.0)
    # Ensure the nearby tone survives.
    assert tone_peak_filtered > tone_peak_original * 0.6


def test_spectral_gate_reduces_stationary_noise():
    chain = AudioFilterChain(
        {
            "enabled": True,
            "highpass": {"enabled": False},
            "notch": {"enabled": False},
            "spectral_gate": {
                "enabled": True,
                "sensitivity": 3.0,
                "reduction_db": -40.0,
                "noise_update": 0.0,
                "noise_decay": 1.0,
            },
        }
    )

    rng = np.random.default_rng(seed=42)
    noise = 0.05 * rng.standard_normal(FRAME_SAMPLES * 8)
    frames = [float_to_pcm(noise[i : i + FRAME_SAMPLES]) for i in range(0, len(noise), FRAME_SAMPLES)]
    filtered_chunks = []
    for frame in frames:
        out = chain.process(SAMPLE_RATE, FRAME_BYTES, frame)
        filtered_chunks.append(pcm_to_float(out))

    filtered = np.concatenate(filtered_chunks[1:])
    noise_tail = noise[FRAME_SAMPLES : FRAME_SAMPLES + filtered.size]
    original_rms = np.sqrt(np.mean(noise_tail**2))
    filtered_rms = np.sqrt(np.mean(filtered**2))
    assert filtered_rms < original_rms * 0.5


def test_spectral_gate_preserves_transient_signal_after_warmup():
    chain = AudioFilterChain(
        {
            "enabled": True,
            "highpass": {"enabled": False},
            "notch": {"enabled": False},
            "spectral_gate": {
                "enabled": True,
                "sensitivity": 1.5,
                "reduction_db": -18.0,
                "noise_update": 0.1,
                "noise_decay": 0.95,
            },
        }
    )

    rng = np.random.default_rng(seed=123)
    # Prime the gate with representative background noise.
    warmup = 0.01 * rng.standard_normal(FRAME_SAMPLES * 40)
    warmup_frames = [
        float_to_pcm(warmup[i : i + FRAME_SAMPLES])
        for i in range(0, len(warmup), FRAME_SAMPLES)
    ]
    for frame in warmup_frames:
        chain.process(SAMPLE_RATE, FRAME_BYTES, frame)

    tone = 0.05 * np.sin(2 * np.pi * 500.0 * np.arange(FRAME_SAMPLES * 10) / SAMPLE_RATE)
    tone_frames = [
        float_to_pcm(tone[i : i + FRAME_SAMPLES])
        for i in range(0, len(tone), FRAME_SAMPLES)
    ]

    outputs = []
    for frame in tone_frames:
        out = chain.process(SAMPLE_RATE, FRAME_BYTES, frame)
        outputs.append(pcm_to_float(out))

    filtered = np.concatenate(outputs)
    original_rms = np.sqrt(np.mean(tone**2))
    filtered_rms = np.sqrt(np.mean(filtered**2))
    # The gate should not collapse the signal to the reduction floor once
    # it has a noise profile; keep at least 60% of the original RMS.
    assert filtered_rms > original_rms * 0.6
