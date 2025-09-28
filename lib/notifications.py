#!/usr/bin/env python3
"""Utility helpers for optional event notifications."""

import json
import queue
import smtplib
import socket
import ssl
import threading
import time
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from lib.config import event_type_aliases, get_cfg


def _as_int(value: Any, default: int | None = None) -> int | None:
    try:
        return int(value)
    except Exception:
        return default


def _as_list(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value if str(v).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


@dataclass
class NotificationFilters:
    min_trigger_rms: int | None = None
    allowed_types: tuple[str, ...] = ()
    alias_map: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_cfg(cls, cfg: dict[str, Any] | None) -> "NotificationFilters":
        cfg = cfg or {}
        min_trigger = _as_int(cfg.get("min_trigger_rms"))
        allowed_input = _as_list(cfg.get("allowed_event_types"))
        alias_map = event_type_aliases(get_cfg())

        normalised: list[str] = []
        for raw in allowed_input:
            token = raw.strip()
            if not token:
                continue
            mapped = alias_map.get(token.lower())
            normalised.append(mapped if mapped else token)

        deduped: list[str] = []
        seen: set[str] = set()
        for item in normalised:
            if item not in seen:
                deduped.append(item)
                seen.add(item)

        return cls(
            min_trigger_rms=min_trigger,
            allowed_types=tuple(deduped),
            alias_map=dict(alias_map),
        )

    def matches(self, event: dict[str, Any]) -> bool:
        trigger = _as_int(event.get("trigger_rms"))
        if self.min_trigger_rms is not None and (
            trigger is None or trigger < self.min_trigger_rms
        ):
            return False

        if self.allowed_types:
            raw_type = str(event.get("etype", ""))
            lookup = raw_type.strip().lower()
            mapped = self.alias_map.get(lookup, raw_type.strip())
            if mapped not in self.allowed_types:
                return False

        return True


class NotificationDispatcher:
    """Send notifications when an event completes."""

    def __init__(
        self,
        *,
        filters: NotificationFilters,
        webhook_cfg: dict[str, Any] | None,
        email_cfg: dict[str, Any] | None,
        run_async: bool = True,
        queue_size: int = 32,
    ) -> None:
        self.filters = filters
        self.webhook_cfg = webhook_cfg or {}
        self.email_cfg = email_cfg or {}
        self.hostname = socket.gethostname()
        self._run_async = run_async
        self._queue: queue.Queue[dict[str, Any]] | None = None
        self._worker: threading.Thread | None = None
        self._queue_size = max(1, int(queue_size or 32))

        self.webhook_url = str(self.webhook_cfg.get("url") or "").strip()
        self.webhook_method = (
            str(self.webhook_cfg.get("method", "POST")) or "POST"
        ).upper()
        self.webhook_headers = self._normalise_headers(self.webhook_cfg.get("headers"))
        self.webhook_timeout = float(self.webhook_cfg.get("timeout_sec", 5.0) or 5.0)

        self.email_recipients = _as_list(self.email_cfg.get("to"))
        self.email_sender = str(self.email_cfg.get("from") or "").strip()

        if self._run_async:
            self._queue = queue.Queue(maxsize=self._queue_size)
            self._worker = threading.Thread(
                target=self._dispatch_loop,
                name="notification-dispatcher",
                daemon=True,
            )
            self._worker.start()

    @staticmethod
    def _normalise_headers(headers: Any) -> dict[str, str]:
        if isinstance(headers, dict):
            return {
                str(key): str(value)
                for key, value in headers.items()
                if str(key).strip()
            }
        return {}

    def handle_event(self, event: dict[str, Any]) -> None:
        if not self.filters.matches(event):
            return

        payload = {
            "event": event,
            "host": self.hostname,
            "generated_at": time.time(),
        }

        if not self._run_async:
            self._dispatch_payload(payload)
            return

        assert self._queue is not None
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            print(
                "[notifications] WARN: dropping notification payload (queue full)",
                flush=True,
            )

    def _dispatch_loop(self) -> None:
        assert self._queue is not None
        while True:
            try:
                payload = self._queue.get()
            except Exception:
                continue

            if payload is None:
                self._queue.task_done()
                break

            try:
                self._dispatch_payload(payload)
            finally:
                self._queue.task_done()

    def _dispatch_payload(self, payload: dict[str, Any]) -> None:
        try:
            self._send_webhook(payload)
        except Exception as exc:
            print(
                f"[notifications] WARN: webhook dispatch raised unexpected error: {exc}",
                flush=True,
            )

        try:
            self._send_email(payload)
        except Exception as exc:
            print(
                f"[notifications] WARN: email dispatch raised unexpected error: {exc}",
                flush=True,
            )

    # --- webhook ---
    def _send_webhook(self, payload: dict[str, Any]) -> None:
        if not self.webhook_url:
            return

        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            self.webhook_url,
            data=body,
            method=self.webhook_method,
            headers={"Content-Type": "application/json", **self.webhook_headers},
        )

        try:
            with urlopen(request, timeout=self.webhook_timeout) as response:
                response.read()
        except URLError as exc:
            print(
                f"[notifications] WARN: webhook delivery failed: {exc}",
                flush=True,
            )

    # --- email ---
    def _send_email(self, payload: dict[str, Any]) -> None:
        if not (self.email_sender and self.email_recipients):
            return

        smtp_host = str(self.email_cfg.get("smtp_host") or "").strip()
        if not smtp_host:
            return

        smtp_port = _as_int(self.email_cfg.get("smtp_port"), 587) or 587
        use_ssl = bool(self.email_cfg.get("use_ssl", False))
        use_tls = bool(self.email_cfg.get("use_tls", True))
        username = str(self.email_cfg.get("username") or "").strip()
        password = self.email_cfg.get("password")
        timeout = float(self.email_cfg.get("timeout_sec", 10.0) or 10.0)

        event = payload.get("event", {})
        subject_template = (
            self.email_cfg.get("subject_template")
            or "Tricorder event: {etype} (RMS {trigger_rms})"
        )
        body_template = (
            self.email_cfg.get("body_template")
            or (
                "Event {base_name} completed.\n"
                "Type: {etype}\n"
                "Trigger RMS: {trigger_rms}\n"
                "Average RMS: {avg_rms}\n"
                "Duration: {duration_seconds}s\n"
                "Start: {started_at}\n"
                "Reason: {end_reason}\n"
            )
        )

        subject = subject_template.format_map(_SafeDict(event))
        body = body_template.format_map(_SafeDict(event))

        message = EmailMessage()
        message["From"] = self.email_sender
        message["To"] = ", ".join(self.email_recipients)
        message["Subject"] = subject
        message.set_content(body)

        try:
            if use_ssl:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(
                    smtp_host, smtp_port, timeout=timeout, context=context
                ) as smtp:
                    self._smtp_login_and_send(smtp, username, password, message)
            else:
                with smtplib.SMTP(smtp_host, smtp_port, timeout=timeout) as smtp:
                    if use_tls:
                        context = ssl.create_default_context()
                        smtp.starttls(context=context)
                    self._smtp_login_and_send(smtp, username, password, message)
        except Exception as exc:
            print(
                f"[notifications] WARN: email delivery failed: {exc}",
                flush=True,
            )

    @staticmethod
    def _smtp_login_and_send(
        smtp: smtplib.SMTP, username: str, password: Any, message: EmailMessage
    ) -> None:
        if username and password:
            smtp.login(username, password)
        smtp.send_message(message)


class _SafeDict(dict):
    """Gracefully handle missing keys when formatting templates."""

    def __missing__(self, key: str) -> str:
        return f"{{{key}}}"


def build_dispatcher(cfg: dict[str, Any] | None) -> NotificationDispatcher | None:
    if not isinstance(cfg, dict):
        return None

    if not bool(cfg.get("enabled")):
        return None

    filters = NotificationFilters.from_cfg(cfg)
    webhook_cfg = cfg.get("webhook")
    email_cfg = cfg.get("email")

    if not any((webhook_cfg, email_cfg)):
        return None

    return NotificationDispatcher(
        filters=filters,
        webhook_cfg=webhook_cfg,
        email_cfg=email_cfg,
    )

