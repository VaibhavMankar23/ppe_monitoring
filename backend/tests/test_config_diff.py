"""Field-level config diff (audit before/after) and the Admin per-camera edit policy."""

from __future__ import annotations

import copy

from app.config_diff import MISSING, admin_denied_changes, diff, split_diff

BASE = {
    "model": {"weights": "w.pt", "device": "auto"},
    "alerts": {"retention_days": 30},
    "streams": [
        {"id": "cam1", "name": "Gate", "source": {"type": "file", "uri": "a.mp4"}, "required_ppe": ["helmet"]},
        {"id": "cam2", "name": "Dock", "source": {"type": "rtsp", "uri": "rtsp://x"}, "enabled": True},
    ],
}


def edited(fn):
    c = copy.deepcopy(BASE)
    fn(c)
    return c


def test_diff_keys_streams_by_id():
    after = edited(lambda c: (c["streams"][1]["source"].__setitem__("uri", "rtsp://y"), c["streams"][0].__setitem__("confidence", 0.4)))
    d = diff(BASE, after)
    assert d == {"streams.cam1.confidence": {"before": MISSING, "after": 0.4},
                 "streams.cam2.source.uri": {"before": "rtsp://x", "after": "rtsp://y"}}
    before, aft = split_diff(d)
    assert before["streams.cam2.source.uri"] == "rtsp://x" and aft["streams.cam1.confidence"] == 0.4
    assert diff(BASE, copy.deepcopy(BASE)) == {}


def test_admin_may_edit_camera_fields():
    after = edited(lambda c: (c["streams"][0].update(name="Main gate", required_ppe=["helmet", "vest"], enabled=False,
                                                     confidence=0.5),
                              c["streams"][1]["source"].update(type="file", uri="b.mp4", fps=20)))
    assert admin_denied_changes(BASE, after) == []


def test_admin_may_not_touch_system_settings_or_camera_list():
    assert admin_denied_changes(BASE, edited(lambda c: c["model"].__setitem__("device", "cpu"))) == ["model.device"]
    assert admin_denied_changes(BASE, edited(lambda c: c["alerts"].__setitem__("retention_days", 1))) == ["alerts.retention_days"]
    assert admin_denied_changes(BASE, edited(lambda c: c.__setitem__("inference", {"frame_skip": 2}))) == ["inference.frame_skip"]
    assert admin_denied_changes(BASE, edited(lambda c: c["streams"].pop()))
    assert admin_denied_changes(BASE, edited(lambda c: c["streams"].reverse()))
    assert admin_denied_changes(BASE, edited(lambda c: c["streams"].append({"id": "cam3", "name": "x", "source": {"uri": "c"}})))
