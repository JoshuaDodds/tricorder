import pytest

from lib.audio_utils import mix_channels_to_mono, select_channel


def test_select_channel_extracts_left_channel():
    # Two frames of stereo S16_LE PCM: L0=1, R0=2, L1=3, R1=4
    samples = (1, 2, 3, 4)
    stereo_bytes = b"".join(int.to_bytes(x, 2, "little", signed=True) for x in samples)

    left = select_channel(stereo_bytes, channels=2, sample_width=2, channel_index=0)
    right = select_channel(stereo_bytes, channels=2, sample_width=2, channel_index=1)

    expected_left = b"".join(int.to_bytes(x, 2, "little", signed=True) for x in (1, 3))
    expected_right = b"".join(int.to_bytes(x, 2, "little", signed=True) for x in (2, 4))

    assert left == expected_left
    assert right == expected_right


def test_select_channel_handles_mono_data():
    mono_samples = b"\x01\x00\x02\x00\x03\x00"
    result = select_channel(mono_samples, channels=1, sample_width=2)
    assert result == mono_samples


def test_select_channel_rejects_invalid_sample_width():
    with pytest.raises(ValueError):
        select_channel(b"", channels=2, sample_width=0)


def test_mix_channels_to_mono_preserves_information():
    # Two frames of stereo S16_LE PCM: L0=1000, R0=-1000, L1=2000, R1=6000
    samples = (1000, -1000, 2000, 6000)
    stereo_bytes = b"".join(int.to_bytes(x, 2, "little", signed=True) for x in samples)

    mixed = mix_channels_to_mono(stereo_bytes, channels=2, sample_width=2)

    expected = b"".join(
        int.to_bytes(x, 2, "little", signed=True) for x in (0, 4000)
    )
    assert mixed == expected


def test_mix_channels_to_mono_supports_multiple_channels():
    frames = (
        30000,
        30000,
        -30000,
        -32000,
        -32000,
        -32000,
    )
    interleaved = b"".join(int.to_bytes(x, 2, "little", signed=True) for x in frames)

    mixed = mix_channels_to_mono(interleaved, channels=3, sample_width=2)

    expected = b"".join(
        int.to_bytes(x, 2, "little", signed=True) for x in (10000, -32000)
    )
    assert mixed == expected
