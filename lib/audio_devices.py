"""Enumerate ALSA capture devices for configuration UIs."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from typing import Iterable, List


_DEVICE_LINE = re.compile(
    r"card\s+(?P<card_index>\d+):\s*"
    r"(?P<card_name>[^\[]+)\[(?P<card_id>[^\]]+)\],\s*"
    r"device\s+(?P<device_index>\d+):\s*"
    r"(?P<device_name>[^\[]+)\[(?P<device_id>[^\]]+)\]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CaptureDevice:
    identifier: str
    label: str
    card_index: int
    device_index: int
    card_id: str
    device_id: str


def _run_listing(command: Iterable[str]) -> str:
    try:
        result = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except FileNotFoundError:
        return ""
    except subprocess.SubprocessError:
        return ""

    output = (result.stdout or "").strip()
    if not output:
        output = (result.stderr or "").strip()
    return output


def _parse_listing(output: str) -> List[CaptureDevice]:
    devices: List[CaptureDevice] = []
    if not output:
        return devices

    for line in output.splitlines():
        match = _DEVICE_LINE.search(line)
        if not match:
            continue
        try:
            card_index = int(match.group("card_index"))
            device_index = int(match.group("device_index"))
        except (TypeError, ValueError):
            continue
        card_id = match.group("card_id").strip()
        device_id = match.group("device_id").strip()
        identifier = f"hw:CARD={card_id},DEV={device_index}"

        card_name = match.group("card_name").strip()
        device_name = match.group("device_name").strip()
        if not card_name:
            card_name = card_id
        if not device_name:
            device_name = device_id
        label = (
            f"{card_name} ({card_id}), device {device_index}: {device_name} ({device_id})"
        )
        devices.append(
            CaptureDevice(
                identifier=identifier,
                label=label,
                card_index=card_index,
                device_index=device_index,
                card_id=card_id,
                device_id=device_id,
            )
        )
    return devices


def discover_capture_devices() -> List[CaptureDevice]:
    """Return ALSA capture devices parsed from `arecord -l` or `aplay -l`."""

    seen_ids: set[str] = set()
    discovered: List[CaptureDevice] = []
    for command in ("arecord -l", "aplay -l"):
        output = _run_listing(command.split())
        if not output:
            continue
        for device in _parse_listing(output):
            if device.identifier in seen_ids:
                continue
            seen_ids.add(device.identifier)
            discovered.append(device)
    discovered.sort(key=lambda d: (d.card_index, d.device_index))
    return discovered


__all__ = ["CaptureDevice", "discover_capture_devices"]
