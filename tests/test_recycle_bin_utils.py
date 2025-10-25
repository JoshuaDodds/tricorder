import json
from pathlib import Path

from lib import recycle_bin_utils


def test_move_short_recording_infers_raw_audio(tmp_path: Path) -> None:
    recordings_root = tmp_path / "recordings"
    recordings_root.mkdir(parents=True, exist_ok=True)

    day_dir = recordings_root / "20240101"
    day_dir.mkdir(parents=True, exist_ok=True)
    audio_path = day_dir / "clip.opus"
    audio_path.write_bytes(b"opus")

    waveform_path = audio_path.with_suffix(audio_path.suffix + ".waveform.json")
    waveform_path.write_text(json.dumps({"duration_seconds": 1.0}), encoding="utf-8")

    raw_dir = recordings_root / recycle_bin_utils.RAW_AUDIO_DIRNAME / "20240101"
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / "clip.wav"
    raw_path.write_bytes(b"raw")

    result = recycle_bin_utils.move_short_recording_to_recycle_bin(
        audio_path,
        recordings_root,
        waveform_path=waveform_path,
        reason="short_clip",
    )

    assert not audio_path.exists()
    assert not raw_path.exists()

    entry_raw_path = result.entry_dir / "clip.wav"
    assert entry_raw_path.exists()

    metadata_path = result.entry_dir / recycle_bin_utils.RECYCLE_METADATA_FILENAME
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected_rel = f"{recycle_bin_utils.RAW_AUDIO_DIRNAME}/20240101/clip.wav"
    assert metadata.get("raw_audio_path") == expected_rel
    assert metadata.get("raw_audio_name") == "clip.wav"

    assert result.raw_audio_destination is not None
    assert result.raw_audio_destination.name == "clip.wav"
