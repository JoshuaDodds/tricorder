import math
import struct
from lib import segmenter


def test_end_to_end_pipeline(tmp_path, monkeypatch):
    # Monkeypatch encoder to avoid calling /apps/tricorder/bin
    monkeypatch.setattr(segmenter, "ENCODER", "/bin/true")

    # Generate synthetic audio (sine wave) and feed to segmenter
    frames = []
    for i in range(2000):
        val = int(2000 * math.sin(2 * math.pi * 440 * i / segmenter.SAMPLE_RATE))
        frames.append(struct.pack('<h', val))
    audio_bytes = b"".join(frames)

    rec = segmenter.TimelineRecorder()
    for idx in range(200):
        rec.ingest(audio_bytes[:segmenter.FRAME_BYTES], idx)
    rec.flush(200)

    # Assert that after flush the recorder resets cleanly
    assert rec.base_name is None
