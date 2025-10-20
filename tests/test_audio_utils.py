import struct

import pytest

from lib.audio_utils import downmix_to_mono


def _pcm16(values):
    return struct.pack("<" + "h" * len(values), *values)


def test_downmix_to_mono_stereo_average():
    left = [1000, -1000, 500]
    right = [3000, -3000, -500]
    stereo = b"".join(
        struct.pack("<hh", l, r) for l, r in zip(left, right, strict=True)
    )
    mixed = downmix_to_mono(stereo, channels=2, sample_width=2)
    expected = _pcm16([2000, -2000, 0])
    assert mixed == expected


def test_downmix_to_mono_trims_partial_frames():
    stereo = _pcm16([100, 200, 300, 400]) + b"\x01"
    mixed = downmix_to_mono(stereo, channels=2, sample_width=2)
    assert mixed == _pcm16([150, 350])


def test_downmix_to_mono_invalid_width():
    with pytest.raises(ValueError):
        downmix_to_mono(b"", channels=2, sample_width=0)


def test_downmix_to_mono_multichannel_fallback_rounds_correctly():
    # Force the arithmetic fallback by using three channels.
    frames = []
    # Frame 1 averages cleanly to 1000.
    frames.extend([1000, 1000, 1000])
    # Frame 2 demonstrates fractional rounding: (1000 + 1000 + 1001) / 3.
    frames.extend([1000, 1000, 1001])
    # Frame 3 mixes positive and negative values.
    frames.extend([-2000, -1000, 1000])

    interleaved = struct.pack("<" + "h" * len(frames), *frames)
    mixed = downmix_to_mono(interleaved, channels=3, sample_width=2)

    expected = _pcm16([1000, 1000, -667])
    assert mixed == expected
