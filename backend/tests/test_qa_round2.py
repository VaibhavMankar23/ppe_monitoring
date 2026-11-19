"""Regression tests for the second QA round (B4, B6, B8-B14, B17)."""

from __future__ import annotations

import copy
import io

import cv2
import numpy as np
import pytest
import yaml
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import SourceConfig, load_config
from app.config_store import ConfigInvalid, ConfigStore
from app.pipeline import Monitor
from app.sources import SourceError, make_source
from app.violations_db import ViolationStore
from helpers import FakeDetector, auth_settings, bootstrap_super_admin, raw_config, write_config


@pytest.fixture()
def site(tmp_path, monkeypatch):
    monkeypatch.setenv("PPE_VIDEOS_DIR", str(tmp_path / "videos"))
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=1))
    cfg = load_config(path)
    mon = Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        c.token = bootstrap_super_admin(c)  # type: ignore[attr-defined]
        c.headers["Authorization"] = f"Bearer {c.token}"
        c.path = path  # type: ignore[attr-defined]
        yield c


def _put(c, mutate):
    d = c.get("/api/config").json()
    raw = copy.deepcopy(d["config"])
    mutate(raw)
    return c.put("/api/config", json={"config": raw, "etag": d["etag"]})


def _errs(r):
    assert r.status_code == 422, r.text
    return {e["loc"]: e["msg"] for e in r.json()["errors"]}


# ---- B4
def test_reset_plan_falls_back_to_the_shipped_defaults(tmp_path):
    (tmp_path / "config.yaml").write_text("model: {weights: w.pt}\n")  # no config.default.yaml beside it
    plan = ConfigStore(tmp_path / "config.yaml").reset_plan(keep_cameras=False)
    assert "inference:" in plan


def test_reset_with_unreadable_defaults_is_a_clear_error(tmp_path):
    (tmp_path / "config.yaml").write_text("model: {weights: w.pt}\n")
    store = ConfigStore(tmp_path / "config.yaml", default_path=tmp_path / "nope.yaml")
    with pytest.raises(ConfigInvalid):
        store.reset_plan()


# ---- B8 / B10 / B14
def test_unknown_new_setting_is_refused_but_old_ones_survive(site):
    errs = _errs(_put(site, lambda r: r.setdefault("tracking", {}).__setitem__("bogus", 1)))
    assert "tracking.bogus" in errs
    site.path.write_text(site.path.read_text() + "legacy_key: 1\n")  # already in the file: not "new"
    assert _put(site, lambda r: r["alerts"].__setitem__("cooldown_seconds", 31)).status_code == 200


def test_alarm_settings_must_be_usable(site):
    errs = _errs(_put(site, lambda r: r.setdefault("alarm", {}).update(webhook={"enabled": True, "url": "file:///etc/passwd"})))
    assert "alarm.webhook.url" in errs
    errs = _errs(_put(site, lambda r: r.setdefault("alarm", {}).update(email={"enabled": True})))
    assert "alarm.email.smtp_host" in errs and "alarm.email.recipients" in errs


def test_camera_needs_a_name_and_a_check_and_a_unique_name(site):
    assert "streams.0.name" in _errs(_put(site, lambda r: r["streams"][0].__setitem__("name", "   ")))
    assert "streams.0.required_ppe" in _errs(_put(site, lambda r: r["streams"][0].__setitem__("required_ppe", [])))
    # a restricted-area zone is a check of its own
    ok = _put(site, lambda r: r["streams"][0].update(required_ppe=[], zones=[
        {"name": "z", "type": "restricted", "points": [[0, 0], [1, 0], [1, 1]]}]))
    assert ok.status_code == 200, ok.text

    def twin(r):
        r["streams"].append({"id": "b", "name": "CAMERA 1", "source": {"type": "file", "uri": "videos/b.mp4"}})
    assert "streams.1.name" in _errs(_put(site, twin))


# ---- B9
def _mp4_bytes(tmp_path) -> bytes:
    p = tmp_path / "t.mp4"
    w = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"mp4v"), 5, (64, 48))
    for i in range(10):
        w.write(np.full((48, 64, 3), i * 20, np.uint8))
    w.release()
    return p.read_bytes()


def test_upload_rejects_empty_and_non_video_files(site, tmp_path):
    def up(name, data):
        return site.post("/api/sources/upload", files={"file": (name, io.BytesIO(data), "video/mp4")})
    assert up("e.mp4", b"").json()["code"] == "empty_file"
    assert up("t.mp4", b"this is text, not a video").json()["code"] == "unreadable_video"
    assert not any((tmp_path / "videos").glob("*.mp4"))  # nothing left behind
    assert up("ok.mp4", _mp4_bytes(tmp_path)).status_code == 201


# ---- B11 / B12 / B17
def test_access_token_stops_working_after_logout(site):
    assert site.get("/api/auth/me").status_code == 200
    assert site.post("/api/auth/logout").status_code == 200
    r = site.get("/api/auth/me")
    assert r.status_code == 401 and r.json()["code"] == "session_revoked"


def test_api_docs_are_off_by_default(site):
    assert site.get("/docs").status_code in (404, 401) and site.get("/openapi.json").status_code in (404, 401)


def test_username_length_matches_the_documented_rule(site):
    r = site.post("/api/users", json={"username": "ab", "password": "Passw0rd!x", "role": "admin"})
    assert r.status_code == 422


# ---- B13
def test_fast_connection_failure_is_not_reported_as_a_timeout():
    src = make_source(SourceConfig(type="rtsp", uri="rtsp://127.0.0.1:1/x", timeout=20))
    with pytest.raises(SourceError) as e:
        src.open()
    assert "refused or not found" in str(e.value) and "within 20s" not in str(e.value)


# ---- B6
def test_rtsps_limits_the_frame_rate_inside_ffmpeg(tmp_path, monkeypatch):
    from test_sources import _fake_ffmpeg  # noqa: PLC0415

    _fake_ffmpeg(tmp_path, monkeypatch)  # the fake ffprobe reports 10 fps
    src = make_source(SourceConfig(type="rtsp", uri="rtsps://10.0.0.9/x", timeout=5))
    src.open()
    src.read()
    src.close()
    assert "-vf fps=8" in (tmp_path / "ffmpeg.args").read_text()


def test_reset_works_when_the_default_file_disappears_after_startup(tmp_path):
    (tmp_path / "config.yaml").write_text("model: {weights: w.pt}\n")
    (tmp_path / "config.default.yaml").write_text("model: {weights: w.pt}\n")
    store = ConfigStore(tmp_path / "config.yaml")
    (tmp_path / "config.default.yaml").unlink()
    assert "inference:" in store.reset_plan(keep_cameras=False)
