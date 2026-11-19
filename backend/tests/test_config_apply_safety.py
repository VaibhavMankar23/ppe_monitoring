"""A saved config must never leave the system in a state that cannot start or cannot be applied.

B1: an unloadable model must be refused with config.yaml untouched (it used to be written first, then 500).
B2: a value the loader rejects (port 70000) must be refused even while an env var overrides that key.
B3: file cameras saved through the config must live in the videos folder, like "Test connection"."""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.violations_db import ViolationStore
from helpers import FakeDetector, auth_settings, bootstrap_super_admin, raw_config, write_config


def _factory(cfg):
    if str(cfg.weights).endswith("bad.pt"):
        raise TypeError("model is not a supported model format")
    return FakeDetector(cfg)


@pytest.fixture()
def site(tmp_path, monkeypatch):
    videos = tmp_path / "videos"
    videos.mkdir()
    monkeypatch.setenv("PPE_VIDEOS_DIR", str(videos))
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=1))
    (tmp_path / "bad.pt").write_bytes(b"")
    cfg = load_config(path)
    mon = Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=_factory)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        c.headers["Authorization"] = f"Bearer {bootstrap_super_admin(c)}"
        c.path = path  # type: ignore[attr-defined]
        c.mon = mon  # type: ignore[attr-defined]
        yield c


def _doc(c):
    d = c.get("/api/config").json()
    return copy.deepcopy(d["config"]), d["etag"]


def test_unloadable_model_is_refused_and_not_saved(site):
    before = site.path.read_text()
    raw, etag = _doc(site)
    raw["model"]["weights"] = "bad.pt"
    r = site.put("/api/config", json={"config": raw, "etag": etag})
    assert r.status_code == 422 and r.json()["code"] == "apply_failed", r.text
    assert site.path.read_text() == before  # rolled back
    assert site.mon.cfg.model.weights.endswith("w.pt")  # still running with the old model
    raw, etag = _doc(site)  # and the file is still editable
    raw["alerts"]["cooldown_seconds"] = 45
    assert site.put("/api/config", json={"config": raw, "etag": etag}).status_code == 200


def test_bad_port_refused_even_when_env_overrides_it(site, monkeypatch):
    monkeypatch.setenv("PPE_PORT", "8011")
    raw, etag = _doc(site)
    raw["server"] = {"port": 70000}
    r = site.put("/api/config", json={"config": raw, "etag": etag})
    assert r.status_code == 422, r.text
    assert any(e["loc"] == "server.port" for e in r.json()["errors"])
    assert "70000" not in site.path.read_text()


def test_file_camera_outside_videos_folder_is_refused(site, tmp_path):
    raw, etag = _doc(site)
    raw["streams"].append({"id": "x", "name": "X", "source": {"type": "file", "uri": "/etc/hostname"}})
    r = site.put("/api/config", json={"config": raw, "etag": etag})
    assert r.status_code == 422 and r.json()["errors"][0]["loc"] == "streams.1.source.uri", r.text
    raw["streams"][1]["source"]["uri"] = "videos/../../../etc/hostname"
    assert site.put("/api/config", json={"config": raw, "etag": etag}).status_code == 422
    assert site.post("/api/config/validate", json={"config": raw}).json()["valid"] is False
    raw["streams"][1]["source"]["uri"] = str(tmp_path / "videos" / "ok.mp4")
    assert site.put("/api/config", json={"config": raw, "etag": etag}).status_code == 200


def test_existing_cameras_outside_videos_keep_saving(site):
    """Cameras already configured with a path elsewhere are not broken by unrelated saves."""
    raw, etag = _doc(site)  # cam1 -> missing_1.mp4 (next to config.yaml, not in videos/)
    raw["alerts"]["cooldown_seconds"] = 33
    assert site.put("/api/config", json={"config": raw, "etag": etag}).status_code == 200
