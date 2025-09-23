from array import array
import json
import wave

import pytest

from lib.waveform_cache import backfill_missing_waveforms, generate_waveform


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


def test_backfill_missing_waveforms(tmp_path):
    recordings_root = tmp_path / "recordings"
    day_dir = recordings_root / "20240101"
    day_dir.mkdir(parents=True)

    samples = array("h", [0, 4000, -4000, 2000, -2000, 0, 3000, -3000])

    ready_wav = day_dir / "ready.wav"
    missing_wav = day_dir / "missing.wav"
    stale_wav = day_dir / "stale.wav"

    for target in (ready_wav, missing_wav, stale_wav):
        with wave.open(str(target), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(48000)
            handle.writeframes(samples.tobytes())

    ready_json = ready_wav.with_suffix(ready_wav.suffix + ".waveform.json")
    stale_json = stale_wav.with_suffix(stale_wav.suffix + ".waveform.json")
    missing_json = missing_wav.with_suffix(missing_wav.suffix + ".waveform.json")

    generate_waveform(ready_wav, ready_json, bucket_count=4)
    stale_json.write_text("", encoding="utf-8")

    generated = backfill_missing_waveforms(
        recordings_root,
        bucket_count=4,
        allowed_extensions=(".wav",),
        strict=True,
    )

    assert missing_json in generated
    assert stale_json in generated
    assert ready_json not in generated

    missing_payload = json.loads(missing_json.read_text())
    stale_payload = json.loads(stale_json.read_text())

    assert missing_payload["frame_count"] == len(samples)
    assert stale_payload["frame_count"] == len(samples)
