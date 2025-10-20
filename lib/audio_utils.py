"""Audio helper utilities."""
from __future__ import annotations

import audioop

from typing import Final


def select_channel(
    data: bytes | bytearray | memoryview,
    channels: int,
    sample_width: int,
    channel_index: int = 0,
) -> bytes:
    """Extract a single channel from interleaved PCM audio."""
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


def downmix_to_mono(
    data: bytes | bytearray | memoryview,
    channels: int,
    sample_width: int,
) -> bytes:
    """Combine multi-channel PCM data into a single mono stream.

    ``audioop.tomono`` is used for the common stereo case to keep the
    implementation efficient. A generic arithmetic fallback is provided for
    other channel counts or when ``audioop`` raises an exception.
    """

    if sample_width <= 0:
        raise ValueError("sample_width must be positive")

    if channels <= 1:
        usable = len(data) - (len(data) % sample_width)
        return bytes(data[:usable]) if usable else b""

    frame_stride: Final[int] = channels * sample_width
    usable = len(data) - (len(data) % frame_stride)
    if usable <= 0:
        return b""

    chunk = memoryview(data)[:usable]

    if channels == 2:
        try:
            return audioop.tomono(bytes(chunk), sample_width, 0.5, 0.5)
        except (audioop.error, ValueError):
            pass

    frames = usable // frame_stride
    result = bytearray(frames * sample_width)
    min_val = -(1 << (8 * sample_width - 1))
    max_val = (1 << (8 * sample_width - 1)) - 1

    for frame_idx in range(frames):
        start = frame_idx * frame_stride
        acc = 0
        for channel in range(channels):
            sample_start = start + channel * sample_width
            sample_end = sample_start + sample_width
            sample = int.from_bytes(
                chunk[sample_start:sample_end], "little", signed=True
            )
            acc += sample
        averaged = round(acc / channels)
        averaged = max(min_val, min(max_val, averaged))
        out_start = frame_idx * sample_width
        result[out_start : out_start + sample_width] = averaged.to_bytes(
            sample_width, "little", signed=True
        )

    return bytes(result)
