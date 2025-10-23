from lib.live_stream_daemon import _parse_arecord_stderr


def test_parse_arecord_stderr_detects_xruns():
    state: dict[str, str] = {"buffer": ""}

    events = _parse_arecord_stderr(b"arecord: pcm_read: overrun!!!\n", state)
    assert events == ["overrun"]
    assert state["buffer"] == ""

    events = _parse_arecord_stderr(b"arecord: underrun!!!\n", state)
    assert events == ["underrun"]
    assert state["buffer"] == ""


def test_parse_arecord_stderr_handles_partial_lines_and_noise():
    state: dict[str, str] = {"buffer": ""}

    events = _parse_arecord_stderr(b"random status line\n", state)
    assert events == []
    assert state["buffer"] == ""

    events = _parse_arecord_stderr(b"misc data ", state)
    assert events == []
    assert state["buffer"] == "misc data "

    events = _parse_arecord_stderr(b"overrun!!!\n", state)
    assert events == ["overrun"]
    assert state["buffer"] == ""
