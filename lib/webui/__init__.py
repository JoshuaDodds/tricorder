from __future__ import annotations

import os
import re
from functools import lru_cache
from importlib import resources
from typing import Any

try:  # pragma: no cover - exercised in environments with Jinja2 installed
    from jinja2 import Environment, PackageLoader, select_autoescape
except ModuleNotFoundError:  # pragma: no cover - fallback path used when Jinja2 absent
    Environment = None  # type: ignore[assignment]
    PackageLoader = None  # type: ignore[assignment]
    select_autoescape = None  # type: ignore[assignment]
    _HAS_JINJA = False
else:
    _HAS_JINJA = True

__all__ = [
    "render_template",
    "static_directory",
    "static_url",
]

_STATIC_CALL_RE = re.compile(r"{{\s*static_url\(\s*['\"]([^'\"]+)['\"]\s*\)\s*}}")
_SIMPLE_VAR_RE = re.compile(r"{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}")


def static_url(path: str) -> str:
    """Return the URL for a static asset served by the web UI."""
    cleaned = path.lstrip("/")
    return f"/static/{cleaned}" if cleaned else "/static"


@lru_cache(maxsize=1)
def _environment() -> Any:
    if not _HAS_JINJA:
        raise RuntimeError("Jinja2 is required to render templates in this environment")
    env = Environment(
        loader=PackageLoader("lib.webui", "templates"),
        autoescape=select_autoescape(["html", "xml"]),
    )
    env.globals["static_url"] = static_url
    return env


def render_template(name: str, **context: Any) -> str:
    if _HAS_JINJA:
        template = _environment().get_template(name)
        return template.render(**context)
    return _render_template_without_jinja(name, context)


def static_directory() -> str:
    directory = resources.files("lib.webui").joinpath("static")
    return os.fspath(directory)


def _render_template_without_jinja(name: str, context: dict[str, Any]) -> str:
    template_path = resources.files("lib.webui").joinpath("templates", name)
    try:
        text = template_path.read_text()
    except FileNotFoundError as exc:  # pragma: no cover - template missing is unexpected
        raise FileNotFoundError(f"Template not found: {name}") from exc

    def _replace_static(match: re.Match[str]) -> str:
        asset = match.group(1)
        return static_url(asset)

    def _replace_var(match: re.Match[str]) -> str:
        key = match.group(1)
        value = context.get(key, "")
        return str(value)

    text = _STATIC_CALL_RE.sub(_replace_static, text)
    text = _SIMPLE_VAR_RE.sub(_replace_var, text)
    return text
