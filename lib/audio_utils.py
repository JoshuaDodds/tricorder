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
    """
    Combine multichannel PCM data into a single mono stream.

    For stereo, performs a short-term power-weighted mix:
      mono = (wL * L + wR * R) / (wL + wR)
    where w = RMS² of a 20 ms window, to avoid phase/comb filtering.

    Falls back to arithmetic average for >2 channels.
    """

    if sample_width <= 0:
        raise ValueError("sample_width must be positive")
    if channels <= 1:
        usable = len(data) - (len(data) % sample_width)
        return bytes(data[:usable]) if usable else b""

    frame_stride = channels * sample_width
    usable = len(data) - (len(data) % frame_stride)
    if usable <= 0:
        return b""

    chunk = memoryview(data)[:usable]

    # --- Stereo power-weighted mix ---
    if channels == 2:
        # Split interleaved stereo into L,R
        left = audioop.tomono(bytes(chunk), sample_width, 1, 0)
        right = audioop.tomono(bytes(chunk), sample_width, 0, 1)

        # Compute RMS power of a small slice (20 ms default)
        frame_bytes = int((48000 * 0.02) * sample_width)  # 20 ms at 48 kHz
        l_rms = audioop.rms(left[:frame_bytes], sample_width)
        r_rms = audioop.rms(right[:frame_bytes], sample_width)
        wL, wR = l_rms ** 2, r_rms ** 2
        if wL + wR == 0:
            wL = wR = 1.0

        # Normalize weights and mix
        gainL = wL / (wL + wR)
        gainR = wR / (wL + wR)

        try:
            return audioop.add(
                audioop.mul(left, sample_width, gainL),
                audioop.mul(right, sample_width, gainR),
                sample_width,
            )
        except (audioop.error, ValueError):
            pass

    # --- Generic fallback average ---
    frames = usable // frame_stride
    result = bytearray(frames * sample_width)
    min_val = -(1 << (8 * sample_width - 1))
    max_val = (1 << (8 * sample_width - 1)) - 1

    for frame_idx in range(frames):
        start = frame_idx * frame_stride
        acc = 0
        for ch in range(channels):
            s0 = start + ch * sample_width
            s1 = s0 + sample_width
            val = int.from_bytes(chunk[s0:s1], "little", signed=True)
            acc += val
        averaged = max(min_val, min(max_val, round(acc / channels)))
        out = averaged.to_bytes(sample_width, "little", signed=True)
        result[frame_idx * sample_width : (frame_idx + 1) * sample_width] = out

    return bytes(result)
