"""Shared helpers for building ffmpeg command lines."""

from __future__ import annotations

DEFAULT_THREAD_QUEUE_SIZE = 8192
DEFAULT_SAMPLE_FORMAT = "s16le"


def pcm_pipe_input_args(
    sample_rate: int,
    channels: int,
    *,
    queue_size: int = DEFAULT_THREAD_QUEUE_SIZE,
    sample_format: str = DEFAULT_SAMPLE_FORMAT,
) -> list[str]:
    """Return input arguments for piping PCM frames into ffmpeg.

    ffmpeg treats options appearing before ``-i`` as applying to that input. We
    centralise construction of the PCM pipe arguments so callers always place
    ``-thread_queue_size`` ahead of the input they target.
    """

    return [
        "-f",
        sample_format,
        "-ar",
        str(sample_rate),
        "-ac",
        str(channels),
        "-thread_queue_size",
        str(queue_size),
        "-i",
        "pipe:0",
    ]
