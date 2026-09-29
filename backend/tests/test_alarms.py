"""Outbound alarm dispatch: per-camera rate limiting, channel selection and payload."""

from __future__ import annotations

from app.alarms import AlarmDispatcher, build_payload
from app.config import AlarmConfig, EmailAlarmConfig, WebhookAlarmConfig

VIOLATION = {
    "id": 7, "timestamp": 1_700_000_000.0, "iso": "2023-11-14T22:13:20Z",
    "stream_id": "cam1", "stream_name": "Gate 1", "track_id": 3, "missing": ["helmet", "phone_use"],
}


def _dispatcher(cfg: AlarmConfig):
    """Sync dispatcher whose webhook/email calls are recorded instead of sent."""
    d = AlarmDispatcher(lambda: cfg, sync=True)
    d.sent_webhooks = []
    d.sent_emails = []
    d._post_webhook = lambda wcfg, payload: d.sent_webhooks.append(payload)  # type: ignore[method-assign]
    d._send_email = lambda ecfg, v: d.sent_emails.append(v)  # type: ignore[method-assign]
    return d


def test_build_payload_shape():
    p = build_payload(VIOLATION)
    assert p["event"] == "ppe_violation"
    assert p["camera_id"] == "cam1" and p["camera_name"] == "Gate 1"
    assert p["track_id"] == 3 and p["violations"] == ["helmet", "phone_use"]
    assert p["id"] == 7


def test_disabled_does_nothing():
    d = _dispatcher(AlarmConfig())  # nothing enabled
    d.on_violation(VIOLATION)
    assert d.sent_webhooks == [] and d.sent_emails == []


def test_webhook_fires_once_within_cooldown():
    cfg = AlarmConfig(cooldown_seconds=1000, webhook=WebhookAlarmConfig(enabled=True, url="http://hooter"))
    d = _dispatcher(cfg)
    d.on_violation(VIOLATION)
    d.on_violation(VIOLATION)  # same camera, within cooldown -> suppressed
    assert len(d.sent_webhooks) == 1


def test_cooldown_is_per_camera():
    cfg = AlarmConfig(cooldown_seconds=1000, webhook=WebhookAlarmConfig(enabled=True, url="http://hooter"))
    d = _dispatcher(cfg)
    d.on_violation(VIOLATION)
    d.on_violation({**VIOLATION, "stream_id": "cam2"})  # different camera -> allowed
    assert len(d.sent_webhooks) == 2


def test_no_cooldown_always_fires():
    cfg = AlarmConfig(cooldown_seconds=0, webhook=WebhookAlarmConfig(enabled=True, url="http://hooter"))
    d = _dispatcher(cfg)
    d.on_violation(VIOLATION)
    d.on_violation(VIOLATION)
    assert len(d.sent_webhooks) == 2


def test_email_channel_selected():
    cfg = AlarmConfig(email=EmailAlarmConfig(enabled=True, smtp_host="smtp.x", recipients=["ehs@x"]))
    d = _dispatcher(cfg)
    d.on_violation(VIOLATION)
    assert len(d.sent_emails) == 1 and d.sent_webhooks == []


def test_both_channels():
    cfg = AlarmConfig(
        webhook=WebhookAlarmConfig(enabled=True, url="http://hooter"),
        email=EmailAlarmConfig(enabled=True, smtp_host="smtp.x", recipients=["ehs@x"]),
    )
    d = _dispatcher(cfg)
    d.on_violation(VIOLATION)
    assert len(d.sent_webhooks) == 1 and len(d.sent_emails) == 1


def test_a_channel_failure_is_isolated():
    """A webhook that raises must not stop the email (and must not propagate)."""
    cfg = AlarmConfig(
        cooldown_seconds=0,
        webhook=WebhookAlarmConfig(enabled=True, url="http://hooter"),
        email=EmailAlarmConfig(enabled=True, smtp_host="smtp.x", recipients=["ehs@x"]),
    )
    d = _dispatcher(cfg)

    def boom(wcfg, payload):
        raise RuntimeError("endpoint down")

    d._post_webhook = boom  # type: ignore[method-assign]
    d.on_violation(VIOLATION)  # must not raise
    assert len(d.sent_emails) == 1
