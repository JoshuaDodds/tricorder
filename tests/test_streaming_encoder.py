import sys
from pathlib import Path

from lib.ffmpeg_io import DEFAULT_THREAD_QUEUE_SIZE
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


def test_streaming_encoder_replaces_stale_file(tmp_path: Path):
    partial_path = tmp_path / "stream.partial.opus"
    partial_path.write_bytes(b"stale")
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
    encoder.feed(b"fresh")
    result = encoder.close(timeout=2.0)
    assert result.success
    assert partial_path.read_bytes() == b"fresh"


def test_streaming_encoder_thread_queue_size_precedes_input(tmp_path: Path):
    encoder = StreamingOpusEncoder(str(tmp_path / "stream.partial.opus"))

    cmd = encoder._build_command()

    queue_idx = cmd.index("-thread_queue_size")
    input_idx = cmd.index("-i")

    assert queue_idx < input_idx
    assert cmd[queue_idx + 1] == str(DEFAULT_THREAD_QUEUE_SIZE)
    assert cmd[input_idx + 1] == "pipe:0"

