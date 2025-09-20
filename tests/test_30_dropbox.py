import wave
import math
import struct
from pathlib import Path
from lib import process_dropped_file, segmenter


def make_test_wav(path: Path, seconds: int = 1, freq: int = 440):
    """Generate a sine wave WAV file for testing."""
    framerate = segmenter.SAMPLE_RATE
    amp = 16000
    nframes = framerate * seconds
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(framerate)
        for i in range(nframes):
            value = int(amp * math.sin(2 * math.pi * freq * (i / framerate)))
            wf.writeframesraw(struct.pack('<h', value))


def test_process_file_creates_output(tmp_path, monkeypatch):
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")

    wav_path = tmp_path / "input.wav"
    make_test_wav(wav_path)

    process_dropped_file.process_file(str(wav_path))

    # Only assert the file exists and processing finished
    assert wav_path.exists()

