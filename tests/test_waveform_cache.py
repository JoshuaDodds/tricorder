from array import array
import json
import wave

import pytest

from lib.waveform_cache import generate_waveform


def test_generate_waveform_produces_peaks(tmp_path):
    wav_path = tmp_path / "sample.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        samples = array("h", [0, 2000, -2000, 1000, -1000, 0, 1500, -1500])
        handle.writeframes(samples.tobytes())

    dest = tmp_path / "sample.waveform.json"
    payload = generate_waveform(wav_path, dest, bucket_count=4)

    assert dest.exists()
    data = json.loads(dest.read_text())

    assert data["version"] == 1
    assert data["frame_count"] == len(samples)
    assert data["peak_scale"] == 32767
    assert len(data["peaks"]) == 8
    assert all(isinstance(value, int) for value in data["peaks"])
    assert payload["duration_seconds"] == pytest.approx(data["duration_seconds"], rel=1e-6)
    assert max(data["peaks"]) <= data["peak_scale"]
    assert min(data["peaks"]) >= -data["peak_scale"]
