"""Config safety: saves, "Reset to defaults" and backup restores can't silently remove cameras.

Regression for the live incident: every camera wipe in the audit log was a "Reset to defaults",
which replaced config.yaml (with the site's cameras) by the shipped defaults (no cameras)."""

from __future__ import annotations

import copy

import pytest
import yaml
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.violations_db import ViolationStore
from helpers import FakeDetector, auth_settings, bootstrap_super_admin, raw_config, write_config


@pytest.fixture()
def site(tmp_path):
    """A production config with two cameras; shipped defaults have none (like config.default.yaml)."""
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=2))
    defaults = raw_config(tmp_path, n_streams=0)
    defaults["alerts"]["cooldown_seconds"] = 30
    (tmp_path / "config.default.yaml").write_text(yaml.safe_dump(defaults, sort_keys=False), encoding="utf-8")
    cfg = load_config(path)
    mon = Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        c.headers["Authorization"] = f"Bearer {bootstrap_super_admin(c)}"
        c.path = path  # type: ignore[attr-defined]
        yield c


def cams(client) -> list[str]:
    return [s["id"] for s in client.get("/api/config").json()["config"]["streams"]]


def test_reset_to_defaults_keeps_the_cameras(site):
    doc = site.get("/api/config").json()
    raw = doc["config"]
    raw["alerts"]["cooldown_seconds"] = 99
    assert site.put("/api/config", json={"config": raw, "etag": doc["etag"]}).status_code == 200
    r = site.post("/api/config/reset")
    assert r.status_code == 200, r.text
    after = yaml.safe_load(site.path.read_text())
    assert [s["id"] for s in after["streams"]] == ["cam1", "cam2"]  # cameras untouched
    assert after["alerts"]["cooldown_seconds"] == 30  # everything else back to the defaults
    assert r.json()["reload"]["removed"] == []
    audit = site.get("/api/audit", params={"action": "config.reset"}).json()["items"][0]
    assert audit["detail"] == "cameras kept"


def test_full_reset_needs_the_camera_removal_confirmed(site):
    before = site.path.read_text()
    backups = len(site.get("/api/config/backups").json())
    r = site.post("/api/config/reset", json={"keep_cameras": False})
    assert r.status_code == 409 and r.json()["code"] == "confirm_camera_removal"
    assert [c["id"] for c in r.json()["cameras"]["removed"]] == ["cam1", "cam2"]
    assert site.path.read_text() == before and len(site.get("/api/config/backups").json()) == backups  # nothing written
    ok = site.post("/api/config/reset", json={"keep_cameras": False, "confirm_remove": ["cam1", "cam2"]})
    assert ok.status_code == 200 and cams(site) == []


def test_save_that_drops_a_camera_is_refused_until_confirmed(site):
    doc = site.get("/api/config").json()
    raw = copy.deepcopy(doc["config"])
    raw["streams"] = raw["streams"][:1]  # e.g. a stale form or a pasted YAML without cam2
    r = site.put("/api/config", json={"config": raw, "etag": doc["etag"]})
    assert r.status_code == 409 and r.json()["code"] == "confirm_camera_removal"
    assert "Camera 2" in r.json()["detail"] and cams(site) == ["cam1", "cam2"]
    # confirming a different camera doesn't count
    assert site.put("/api/config", json={"config": raw, "etag": doc["etag"], "confirm_remove": ["cam1"]}).status_code == 409
    ok = site.put("/api/config", json={"config": raw, "etag": doc["etag"], "confirm_remove": ["cam2"]})
    assert ok.status_code == 200 and cams(site) == ["cam1"] and ok.json()["reload"]["removed"] == ["cam2"]


def test_raw_yaml_save_is_guarded_too(site):
    doc = site.get("/api/config").json()
    text = yaml.safe_dump({**yaml.safe_load(doc["yaml"]), "streams": []})
    r = site.put("/api/config", json={"yaml": text, "etag": doc["etag"]})
    assert r.status_code == 409 and cams(site) == ["cam1", "cam2"]


def test_restoring_a_backup_without_the_cameras_is_guarded(site):
    doc = site.get("/api/config").json()
    raw = doc["config"]
    raw["streams"] = raw["streams"][:1]
    site.put("/api/config", json={"config": raw, "etag": doc["etag"], "confirm_remove": ["cam2"]})
    doc = site.get("/api/config").json()
    raw = doc["config"]
    raw["streams"].append({"id": "cam9", "name": "New gate", "source": {"type": "file", "uri": "x.mp4"},
                           "required_ppe": ["helmet"]})
    site.put("/api/config", json={"config": raw, "etag": doc["etag"]})  # adding needs no confirmation
    newest_backup = site.get("/api/config/backups").json()[0]["name"]  # the config before cam9 was added
    r = site.post("/api/config/restore", json={"name": newest_backup})
    assert r.status_code == 409 and [c["id"] for c in r.json()["cameras"]["removed"]] == ["cam9"]
    assert "cam9" in cams(site)
    ok = site.post("/api/config/restore", json={"name": newest_backup, "confirm_remove": ["cam9"]})
    assert ok.status_code == 200 and cams(site) == ["cam1"]


def test_validate_previews_the_camera_changes(site):
    raw = site.get("/api/config").json()["config"]
    raw["streams"][0]["source"]["uri"] = "other.mp4"
    raw["streams"][1]["enabled"] = False
    raw["streams"] = raw["streams"] + [{"id": "cam3", "name": "Dock", "source": {"type": "file", "uri": "d.mp4"},
                                        "required_ppe": ["helmet"]}]
    r = site.post("/api/config/validate", json={"config": raw}).json()
    assert r["valid"]
    ch = r["cameras"]
    assert ch["added"] == [{"id": "cam3", "name": "Dock"}] and ch["removed"] == []
    assert {c["id"]: c["fields"] for c in ch["changed"]} == {"cam1": ["source.uri"], "cam2": ["enabled"]}


def test_unrelated_saves_need_no_confirmation(site):
    doc = site.get("/api/config").json()
    raw = doc["config"]
    raw["model"]["default_confidence"] = 0.5
    raw["streams"][0]["name"] = "Gate A"
    assert site.put("/api/config", json={"config": raw, "etag": doc["etag"]}).status_code == 200


def test_schema_reports_what_the_model_can_check(site):
    caps = site.get("/api/config/schema").json()["capabilities"]
    assert caps["ppe_supported"] == ["helmet"]  # FakeDetector classes: person, helmet
    assert "vest" in caps["ppe_not_supported"] and "gloves" in caps["ppe_not_supported"]
    assert caps["phone"] == {"configured": False, "weights": "", "wanted_by_cameras": [], "loaded": False,
                             "load_failed": False}
