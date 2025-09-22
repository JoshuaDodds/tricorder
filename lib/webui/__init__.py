from __future__ import annotations

import os
from functools import lru_cache
from importlib import resources
from typing import Any

from jinja2 import Environment, PackageLoader, select_autoescape

__all__ = [
    "render_template",
    "static_directory",
    "static_url",
]


def static_url(path: str) -> str:
    """Return the URL for a static asset served by the web UI."""
    cleaned = path.lstrip("/")
    return f"/static/{cleaned}" if cleaned else "/static"


@lru_cache(maxsize=1)
def _environment() -> Environment:
    env = Environment(
        loader=PackageLoader("lib.webui", "templates"),
        autoescape=select_autoescape(["html", "xml"]),
    )
    env.globals["static_url"] = static_url
    return env


def render_template(name: str, **context: Any) -> str:
    template = _environment().get_template(name)
    return template.render(**context)


def static_directory() -> str:
    directory = resources.files("lib.webui").joinpath("static")
    return os.fspath(directory)
