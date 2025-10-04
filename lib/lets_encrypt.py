"""Helpers for maintaining Let's Encrypt certificates."""

from __future__ import annotations

import datetime as _dt
import logging
import os
import shutil
import ssl
import subprocess
import threading
from pathlib import Path
from typing import Iterable, Sequence


class LetsEncryptError(Exception):
    """Raised when Let's Encrypt certificate management fails."""


class LetsEncryptManager:
    """Issue and renew Let's Encrypt certificates using the ``certbot`` CLI."""

    def __init__(
        self,
        *,
        domains: Sequence[str],
        email: str,
        cache_dir: Path | str,
        certbot_path: str = "certbot",
        staging: bool = False,
        http_port: int = 80,
        renew_before_days: int = 30,
        logger: logging.Logger | None = None,
    ) -> None:
        if not domains:
            raise LetsEncryptError("At least one domain is required for Let's Encrypt")

        cleaned_domains = _unique_nonempty(domains)
        if not cleaned_domains:
            raise LetsEncryptError("At least one non-empty domain is required for Let's Encrypt")

        self._domains: tuple[str, ...] = tuple(cleaned_domains)
        self._email = email.strip()
        self._cache_root = Path(cache_dir).expanduser().resolve()
        self._config_dir = self._cache_root / "config"
        self._work_dir = self._cache_root / "work"
        self._logs_dir = self._cache_root / "log"
        self._certbot_path = certbot_path.strip() or "certbot"
        self._staging = bool(staging)
        self._http_port = int(http_port)
        if not (1 <= self._http_port <= 65535):
            raise LetsEncryptError("http_port must be between 1 and 65535")
        self._renew_before = max(1, int(renew_before_days))
        self._logger = logger or logging.getLogger("web_streamer")
        self._lock = threading.Lock()

        for directory in (self._config_dir, self._work_dir, self._logs_dir):
            directory.mkdir(parents=True, exist_ok=True)

    @property
    def primary_domain(self) -> str:
        return self._domains[0]

    def certificate_paths(self) -> tuple[Path, Path]:
        live_dir = self._config_dir / "live" / self.primary_domain
        return live_dir / "fullchain.pem", live_dir / "privkey.pem"

    def ensure_certificate(self) -> tuple[Path, Path]:
        """Ensure a valid certificate exists, requesting/renewing when needed."""

        with self._lock:
            cert_path, key_path = self.certificate_paths()
            if not self._should_request(cert_path, key_path):
                return cert_path, key_path

            self._logger.info(
                "Requesting/renewing Let's Encrypt certificate for %s", ", ".join(self._domains)
            )
            self._run_certbot()

            if not cert_path.exists() or not key_path.exists():
                raise LetsEncryptError(
                    "certbot completed without producing expected certificate files"
                )
            return cert_path, key_path

    def _should_request(self, cert_path: Path, key_path: Path) -> bool:
        if not cert_path.exists() or not key_path.exists():
            return True
        expires = self._certificate_expiration(cert_path)
        if expires is None:
            return True
        now = _dt.datetime.now(tz=_dt.timezone.utc)
        renew_deadline = now + _dt.timedelta(days=self._renew_before)
        return expires <= renew_deadline

    def _certificate_expiration(self, cert_path: Path) -> _dt.datetime | None:
        try:
            info = ssl._ssl._test_decode_cert(str(cert_path))  # type: ignore[attr-defined]
        except Exception as exc:  # pragma: no cover - defensive parsing
            self._logger.warning("Unable to inspect certificate %s: %s", cert_path, exc)
            return None
        not_after = info.get("notAfter")
        if not not_after:
            return None
        try:
            expires = _dt.datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z")
        except ValueError:
            return None
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=_dt.timezone.utc)
        else:
            expires = expires.astimezone(_dt.timezone.utc)
        return expires

    def _resolve_certbot(self) -> str:
        candidate = self._certbot_path
        if os.path.sep in candidate or candidate.startswith("."):
            resolved = Path(candidate)
            if resolved.is_file():
                return str(resolved)
        resolved_path = shutil.which(candidate)
        if not resolved_path:
            raise LetsEncryptError(f"certbot executable {candidate!r} not found")
        return resolved_path

    def _run_certbot(self) -> None:
        executable = self._resolve_certbot()
        cmd: list[str] = [
            executable,
            "certonly",
            "--non-interactive",
            "--agree-tos",
            "--keep-until-expiring",
            "--preferred-challenges",
            "http",
            "--standalone",
            "--http-01-port",
            str(self._http_port),
            "--config-dir",
            str(self._config_dir),
            "--work-dir",
            str(self._work_dir),
            "--logs-dir",
            str(self._logs_dir),
        ]
        if self._staging:
            cmd.append("--staging")
        if self._email:
            cmd.extend(["--email", self._email])
        else:
            cmd.append("--register-unsafely-without-email")
        for domain in self._domains:
            cmd.extend(["-d", domain])

        result = subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode != 0:
            stdout = (result.stdout or "").strip()
            stderr = (result.stderr or "").strip()
            combined = "; ".join(part for part in (stderr, stdout) if part)
            raise LetsEncryptError(
                f"certbot exited with status {result.returncode}: {combined or 'unknown error'}"
            )


def _unique_nonempty(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        stripped = value.strip()
        if not stripped or stripped in seen:
            continue
        seen.add(stripped)
        result.append(stripped)
    return result

