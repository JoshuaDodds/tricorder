"""Audio helper utilities."""
from __future__ import annotations

from typing import Final


def mix_channels_to_mono(
    data: bytes | bytearray | memoryview,
    channels: int,
    sample_width: int,
) -> bytes:
    """Mix interleaved PCM data down to a single mono channel.

    Args:
        data: Raw PCM samples in little-endian format.
        channels: Number of interleaved channels present in ``data``.
        sample_width: Bytes per sample (e.g. ``2`` for ``S16_LE``).

    Returns:
        ``bytes`` containing mono PCM samples averaged across the input
        channels. Any partial frame at the end of ``data`` is discarded to
        ensure alignment.
    """
    if sample_width <= 0:
        raise ValueError("sample_width must be positive")

    if channels <= 1:
        usable = len(data) - (len(data) % sample_width)
        return bytes(data[:usable]) if usable else b""

    frame_stride: Final[int] = channels * sample_width
    if frame_stride <= 0:
        return b""

    total_frames = len(data) // frame_stride
    if total_frames <= 0:
        return b""

    view = memoryview(data)
    result = bytearray(total_frames * sample_width)

    # Bounds for signed PCM samples of the requested width.
    sample_bits = sample_width * 8
    max_val = (1 << (sample_bits - 1)) - 1
    min_val = -(1 << (sample_bits - 1))

    for frame_idx in range(total_frames):
        start = frame_idx * frame_stride
        mixed = 0
        for channel_idx in range(channels):
            offset = start + channel_idx * sample_width
            sample = int.from_bytes(
                view[offset : offset + sample_width], "little", signed=True
            )
            mixed += sample

        abs_mixed = abs(mixed)
        quotient, remainder = divmod(abs_mixed, channels)
        if remainder * 2 >= channels:
            quotient += 1
        mixed = quotient if mixed >= 0 else -quotient

        if mixed > max_val:
            mixed = max_val
        elif mixed < min_val:
            mixed = min_val

        out_start = frame_idx * sample_width
        result[out_start : out_start + sample_width] = mixed.to_bytes(
            sample_width, "little", signed=True
        )

    return bytes(result)


def select_channel(
    data: bytes | bytearray | memoryview,
    channels: int,
    sample_width: int,
    channel_index: int = 0,
) -> bytes:
    """Extract a single channel from interleaved PCM audio.

    Args:
        data: Raw PCM samples in little-endian format.
        channels: Number of interleaved channels present in ``data``.
        sample_width: Bytes per sample (e.g. ``2`` for ``S16_LE``).
        channel_index: Zero-based channel to extract; values outside the
            available range are clamped to the closest valid index.

    Returns:
        ``bytes`` containing PCM samples for the requested channel. Any partial
        frame at the end of ``data`` is discarded to ensure alignment.
    """
    if sample_width <= 0:
        raise ValueError("sample_width must be positive")

    if channels <= 1:
        # Trim trailing partial samples to keep callers from accidentally feeding
        # misaligned frames further down the pipeline.
        usable = len(data) - (len(data) % sample_width)
        return bytes(data[:usable]) if usable else b""

    frame_stride: Final[int] = channels * sample_width
    if frame_stride <= 0:
        return b""

    total_frames = len(data) // frame_stride
    if total_frames <= 0:
        return b""

    clamped_index = max(0, min(channel_index, channels - 1))
    offset = clamped_index * sample_width

    view = memoryview(data)
    result = bytearray(total_frames * sample_width)
    for frame_idx in range(total_frames):
        start = frame_idx * frame_stride + offset
        end = start + sample_width
        out_start = frame_idx * sample_width
        result[out_start:out_start + sample_width] = view[start:end]
    return bytes(result)
