"""Utilities for handling recording event tags."""

from __future__ import annotations

import re

SAFE_EVENT_TAG_PATTERN = re.compile(r"[^A-Za-z0-9_-]+")


def sanitize_event_tag(tag: str) -> str:
    """Normalize event tags to a filesystem-safe token."""
    sanitized = SAFE_EVENT_TAG_PATTERN.sub("_", tag.strip()) if tag else ""
    sanitized = sanitized.strip("_-")
    return sanitized or "event"


__all__ = ["SAFE_EVENT_TAG_PATTERN", "sanitize_event_tag"]
