import sys
from pathlib import Path

from lib.segmenter import StreamingOpusEncoder


def test_streaming_encoder_writes_chunks(tmp_path: Path):
    partial_path = tmp_path / "stream.partial.opus"
    encoder = StreamingOpusEncoder(str(partial_path))
    command = [
        sys.executable,
        "-c",
        (
            "import pathlib, sys; "
            "dest = pathlib.Path(sys.argv[1]); "
            "data = sys.stdin.buffer.read(); "
            "dest.write_bytes(data)"
        ),
        str(partial_path),
    ]
    encoder.start(command=command)

    assert encoder.feed(b"abc") is True
    assert encoder.feed(b"123") is True

    result = encoder.close(timeout=2.0)
    assert result.success
    assert result.partial_path == str(partial_path)
    assert result.bytes_sent == 6
    assert result.dropped_chunks == 0
    assert partial_path.exists()
    with open(partial_path, "rb") as handle:
        assert handle.read() == b"abc123"

