"""Formatting helpers for the segmenter CLI logging."""

from __future__ import annotations

import os

ANSI_GREEN = "\033[32m"
ANSI_RED = "\033[31m"
ANSI_RESET = "\033[0m"
USE_COLOR_DEFAULT = os.getenv("NO_COLOR") is None


def color_tf(val: bool, *, use_color: bool | None = None) -> str:
    """Return a single-character boolean indicator with optional ANSI color."""
    enabled = USE_COLOR_DEFAULT if use_color is None else use_color
    if not enabled:
        return "T" if val else "F"
    return f"{ANSI_GREEN}T{ANSI_RESET}" if val else f"{ANSI_RED}F{ANSI_RESET}"


__all__ = [
    "ANSI_GREEN",
    "ANSI_RED",
    "ANSI_RESET",
    "USE_COLOR_DEFAULT",
    "color_tf",
]
