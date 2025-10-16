"""System-level helpers for the segmenter process."""

from __future__ import annotations

import os
from typing import Iterable


def set_single_core_affinity() -> None:
    """Pin the current process to the lowest-numbered available CPU."""

    try:
        available: Iterable[int] | None
        if hasattr(os, "sched_getaffinity"):
            try:
                available = os.sched_getaffinity(0)
            except OSError:
                available = None
        else:
            available = None

        target_cpu = 0
        if available:
            try:
                target_cpu = min(int(cpu) for cpu in available)
            except (TypeError, ValueError):
                target_cpu = 0

        if hasattr(os, "sched_setaffinity"):
            os.sched_setaffinity(0, {int(target_cpu)})
        if hasattr(os, "nice"):
            try:
                os.nice(5)
            except OSError:
                pass
    except (AttributeError, OSError, ValueError):
        pass


def normalized_load() -> float | None:
    """Return the 1m load average normalized by CPU count."""

    try:
        load1, _, _ = os.getloadavg()
    except (AttributeError, OSError):
        return None
    cpus = os.cpu_count() or 1
    if cpus <= 0:
        cpus = 1
    return load1 / float(cpus)


__all__ = ["normalized_load", "set_single_core_affinity"]
