"""Outbound alarms for stored violations: webhook (HTTP POST) and/or email (SMTP).

A single :class:`ViolationStore` subscriber (see ``api.create_app``) that turns every stored
violation into a real-world alarm — a hooter/relay behind a webhook gateway, a Teams/Slack channel,
an EHS mailbox. Delivery runs on a small background pool so a slow endpoint never stalls the video
pipeline (the store calls subscribers from the worker threads). Alarms are rate-limited per camera
on top of the violation dedupe that already happens upstream, so a busy scene can't flood the
webhook or inbox even when distinct workers keep offending.

Config is read live from a getter (``lambda: monitor.cfg.alarm``) so a hot config reload takes
effect without re-wiring. Secrets belong in environment variables referenced from the YAML, e.g.
``password: ${PPE_SMTP_PASSWORD}`` — config env-expansion keeps them out of the file on disk.
"""

from __future__ import annotations

import logging
import smtplib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage
from typing import Any, Callable

from .config import AlarmConfig, EmailAlarmConfig, WebhookAlarmConfig

log = logging.getLogger(__name__)


def build_payload(v: dict[str, Any]) -> dict[str, Any]:
    """JSON body for the webhook, from a stored-violation dict (see ``violations_db.row_to_dict``)."""
    return {
        "event": "ppe_violation",
        "id": v.get("id"),
        "timestamp": v.get("timestamp"),
        "iso": v.get("iso"),
        "camera_id": v.get("stream_id"),
        "camera_name": v.get("stream_name"),
        "track_id": v.get("track_id"),
        "violations": v.get("missing", []),
    }


class AlarmDispatcher:
    """Fan a stored violation out to the configured alarm channels, rate-limited per camera."""

    def __init__(
        self,
        cfg_getter: Callable[[], AlarmConfig],
        image_getter: Callable[[int], bytes] | None = None,
        *,
        sync: bool = False,
    ) -> None:
        self._cfg = cfg_getter
        self._image = image_getter  # (violation id) -> full JPEG bytes, for the email attachment
        self._sync = sync  # tests deliver inline instead of on the pool
        self._pool = ThreadPoolExecutor(2, thread_name_prefix="alarm")
        self._lock = threading.Lock()
        self._last_fired: dict[str, float] = {}  # camera id -> last alarm time (monotonic)

    # ------------------------------------------------------------ rate limiting
    def _due(self, camera_id: str, cooldown: float, now: float) -> bool:
        """True (and records the time) when this camera may raise an alarm now."""
        with self._lock:
            last = self._last_fired.get(camera_id, -1e9)
            if now - last < cooldown:
                return False
            self._last_fired[camera_id] = now
            return True

    # ------------------------------------------------------------ entry point
    def on_violation(self, v: dict[str, Any]) -> None:
        """Store subscriber. Runs on a worker thread; must never raise or block for long."""
        cfg = self._cfg()
        if not cfg.any_enabled:
            return
        camera = str(v.get("stream_id", ""))
        if not self._due(camera, cfg.cooldown_seconds, time.monotonic()):
            log.debug("alarm suppressed (cooldown) for camera %s", camera)
            return
        if self._sync:
            self._deliver(cfg, v)
        else:
            self._pool.submit(self._deliver, cfg, v)

    def _deliver(self, cfg: AlarmConfig, v: dict[str, Any]) -> None:
        if cfg.webhook.enabled and cfg.webhook.url:
            try:
                self._post_webhook(cfg.webhook, build_payload(v))
            except Exception:
                log.exception("alarm webhook failed")
        if cfg.email.enabled and cfg.email.recipients:
            try:
                self._send_email(cfg.email, v)
            except Exception:
                log.exception("alarm email failed")

    # ------------------------------------------------------------ channels (patchable in tests)
    def _post_webhook(self, cfg: WebhookAlarmConfig, payload: dict[str, Any]) -> None:
        import requests

        r = requests.post(cfg.url, json=payload, timeout=cfg.timeout)
        r.raise_for_status()
        log.info("alarm webhook sent for violation #%s -> %s", payload.get("id"), cfg.url)

    def _send_email(self, cfg: EmailAlarmConfig, v: dict[str, Any]) -> None:
        msg = EmailMessage()
        cam = v.get("stream_name") or v.get("stream_id") or "camera"
        items = ", ".join(v.get("missing", [])) or "violation"
        msg["Subject"] = f"PPE alarm: {items} on {cam}"
        msg["From"] = cfg.sender or cfg.username
        msg["To"] = ", ".join(cfg.recipients)
        msg.set_content(
            f"Safety violation detected.\n\n"
            f"Camera:    {cam}\n"
            f"Worker:    track #{v.get('track_id')}\n"
            f"Violation: {items}\n"
            f"Time:      {v.get('iso')}\n"
        )
        if cfg.attach_snapshot and self._image is not None and v.get("id") is not None:
            try:
                data = self._image(int(v["id"]))
                if data:
                    msg.add_attachment(data, maintype="image", subtype="jpeg",
                                       filename=f"violation_{v['id']}.jpg")
            except Exception:
                log.exception("could not attach snapshot to alarm email")
        with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=15) as s:
            if cfg.use_tls:
                s.starttls()
            if cfg.username:
                s.login(cfg.username, cfg.password)
            s.send_message(msg)
        log.info("alarm email sent for violation #%s -> %s", v.get("id"), ", ".join(cfg.recipients))

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
