from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Sequence

__all__ = [
    "AUDIO_EXTENSIONS",
    "RecordingEntry",
    "list_available_days",
    "list_recordings",
]

AUDIO_EXTENSIONS: set[str] = {
    ".opus",
    ".ogg",
    ".oga",
    ".mp3",
    ".wav",
    ".flac",
    ".m4a",
}

_DAY_PATTERN = re.compile(r"^\d{8}$")
_NAME_PATTERN = re.compile(
    r"^(?P<time>\d{2}-\d{2}-\d{2})(?:_(?P<category>[A-Za-z0-9-]+))?(?:_(?P<rest>.*))?$"
)
_KNOWN_TYPES = {"both", "human", "other"}


@dataclass(slots=True)
class RecordingEntry:
    """Representation of a single recording on disk."""

    id: str
    name: str
    day: str
    day_label: str
    time: str
    type: str
    type_key: str
    details: str
    size_bytes: int
    size_label: str
    modified: float
    modified_iso: str
    url: str
    download_name: str

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "day": self.day,
            "day_label": self.day_label,
            "time": self.time,
            "type": self.type,
            "type_key": self.type_key,
            "details": self.details,
            "size_bytes": self.size_bytes,
            "size_label": self.size_label,
            "modified": self.modified,
            "modified_iso": self.modified_iso,
            "url": self.url,
            "download_name": self.download_name,
            "title": f"{self.day_label} {self.time} ({self.type})",
        }


def list_available_days(root: Path) -> list[str]:
    try:
        entries = list(root.iterdir())
    except FileNotFoundError:
        return []
    days: list[str] = []
    for entry in entries:
        if entry.is_dir() and _DAY_PATTERN.match(entry.name):
            days.append(entry.name)
    days.sort(reverse=True)
    return days


def list_recordings(
    root: Path,
    *,
    limit: int = 100,
    day: str | None = None,
    category: str | None = None,
    search: str | None = None,
) -> tuple[list[dict[str, object]], bool]:
    if limit <= 0:
        raise ValueError("limit must be positive")
    limit = min(limit, 500)

    search_value = search.lower().strip() if search else None
    day_filter: Sequence[str]
    if day:
        if not _DAY_PATTERN.match(day):
            raise ValueError("day must be in YYYYMMDD format")
        day_filter = (day,) if (root / day).exists() else ()
    else:
        day_filter = list_available_days(root)

    category_key: str | None = None
    if category:
        category_key = category.lower()
        if not re.fullmatch(r"[a-z0-9-]+", category_key):
            raise ValueError("invalid category filter")

    collected: list[dict[str, object]] = []
    fetch_cap = limit + 1

    for day_name in day_filter:
        day_path = root / day_name
        try:
            candidates = list(day_path.iterdir())
        except FileNotFoundError:
            continue
        file_rows: list[tuple[Path, float, int]] = []
        for candidate in candidates:
            if not candidate.is_file():
                continue
            suffix = candidate.suffix.lower()
            if suffix not in AUDIO_EXTENSIONS:
                continue
            try:
                st = candidate.stat()
            except FileNotFoundError:
                continue
            file_rows.append((candidate, st.st_mtime, st.st_size))
        file_rows.sort(key=lambda item: item[1], reverse=True)
        for file_path, mtime, size in file_rows:
            entry = _build_entry(day_name, file_path, mtime, size)
            if category_key and entry["type_key"] != category_key:
                continue
            if search_value and search_value not in entry["search_blob"]:
                continue
            collected.append(entry)
            if len(collected) >= fetch_cap:
                break
        if len(collected) >= fetch_cap:
            break

    has_more = len(collected) > limit
    if has_more:
        collected = collected[:limit]
    for entry in collected:
        entry.pop("search_blob", None)
    return collected, has_more


def _build_entry(day: str, file_path: Path, modified: float, size_bytes: int) -> dict[str, object]:
    name = file_path.name
    stem = file_path.stem
    match = _NAME_PATTERN.match(stem)
    if match:
        time_token = match.group("time") or ""
        category = match.group("category") or "Unknown"
        remainder = match.group("rest") or ""
    else:
        time_token = ""
        category = "Unknown"
        remainder = ""

    time_label = time_token.replace("-", ":") if time_token else ""
    type_label = category.replace("-", " ")
    type_key = category.lower()
    if type_key in _KNOWN_TYPES:
        type_label = type_key.capitalize()
    details = remainder.replace("_", " ") if remainder else ""
    day_label = f"{day[:4]}-{day[4:6]}-{day[6:]}" if len(day) == 8 else day

    size_label = _format_size(size_bytes)
    modified_iso = datetime.fromtimestamp(modified).isoformat(timespec="seconds")

    rel_path = f"{day}/{name}" if day else name
    search_components = [
        rel_path.lower(),
        type_key,
        type_label.lower(),
        day_label.lower(),
        time_label.lower(),
        details.lower(),
    ]
    payload = RecordingEntry(
        id=rel_path,
        name=name,
        day=day,
        day_label=day_label,
        time=time_label,
        type=type_label,
        type_key=type_key,
        details=details,
        size_bytes=size_bytes,
        size_label=size_label,
        modified=modified,
        modified_iso=modified_iso,
        url=f"/recordings/{rel_path}",
        download_name=name,
    ).to_dict()
    payload["search_blob"] = " ".join(search_components)
    return payload


def _format_size(size: int) -> str:
    if size <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(size)
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} TB"
