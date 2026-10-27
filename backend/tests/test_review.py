"""Review verdicts (valid / false alarm), the precision figure built on them, and the dataset export."""

from __future__ import annotations

import csv
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.analytics import Analytics, Scope
from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.violations_db import ViolationFilter, ViolationStore
from helpers import FakeDetector, auth_settings, bootstrap_super_admin, raw_config, write_config

T0 = 1_790_000_000.0
META = {"detection": {"box": [480, 270, 960, 810], "frame_size": [1920, 1080]}}


@pytest.fixture()
def store():
    s = ViolationStore(":memory:")
    for i in range(10):
        s.add("cam1" if i < 6 else "cam2", "Camera", i, ["helmet"], b"IMG", b"TH", ts=T0 + i,
              meta=META, original=b"FRAME%d" % i if i != 9 else None)
    yield s
    s.close()


@pytest.fixture()
def client(tmp_path, store):
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=2))
    cfg = load_config(path)
    mon = Monitor(cfg, store=store, detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        c.headers["Authorization"] = f"Bearer {bootstrap_super_admin(c)}"
        yield c


def test_review_is_stored_acknowledges_and_can_be_cleared(store):
    v = store.set_review(1, "false_alarm", "asha", "ppe_worn", "  helmet clearly on  ", ts=T0 + 100)
    assert v["review"] == {"verdict": "false_alarm", "reason": "ppe_worn", "note": "helmet clearly on", "by": "asha", "at": T0 + 100}
    assert v["acknowledged_by"] == "asha" and v["acknowledged_at"] == T0 + 100  # reviewed = handled
    v = store.set_review(1, "valid", "ravi", "ppe_worn")  # a reason only belongs to a false alarm
    assert v["review"]["verdict"] == "valid" and v["review"]["reason"] is None
    assert v["acknowledged_by"] == "asha"  # the first acknowledgement is kept
    assert store.set_review(1, None, "ravi")["review"] is None
    assert store.set_review(999, "valid", "ravi") is None


def test_filter_by_review_state(store):
    store.set_review(1, "valid", "a")
    store.set_review(2, "false_alarm", "a", "duplicate")
    n = lambda r: store.list(ViolationFilter(review=r))["total"]  # noqa: E731
    assert (n("valid"), n("false_alarm"), n("unreviewed"), n(None)) == (1, 1, 8, 10)


def test_precision_counts_only_reviewed_violations(store):
    an, sc = Analytics(store), Scope(T0 - 10, T0 + 100)
    assert an.review_quality(sc)["precision"] is None  # nothing reviewed: no figure, not 100 %
    for vid in (1, 2, 3):
        store.set_review(vid, "valid", "a")
    store.set_review(7, "false_alarm", "a", "not_required_here")
    q = an.review_quality(sc)
    assert (q["reviewed"], q["valid"], q["false_alarms"], q["unreviewed"], q["precision"]) == (4, 3, 1, 6, 0.75)
    assert q["reasons"] == [{"reason": "not_required_here", "label": "PPE not required in this area", "count": 1}]
    assert {c["stream_id"]: c["precision"] for c in q["by_camera"]} == {"cam1": 1.0, "cam2": 0.0}
    assert an.summary(sc)["review"]["precision"] == 0.75


def test_review_api_validates_and_audits(client):
    assert client.post("/api/violations/1/review", json={"verdict": "maybe"}).status_code == 422
    assert client.post("/api/violations/1/review", json={"verdict": "false_alarm"}).status_code == 422  # needs a reason
    assert client.post("/api/violations/999/review", json={"verdict": "valid"}).status_code == 404
    r = client.post("/api/violations/1/review", json={"verdict": "false_alarm", "reason": "not_a_person"})
    assert r.status_code == 200 and r.json()["review"]["reason"] == "not_a_person"
    assert [v["id"] for v in client.get("/api/violations?review=false_alarm").json()["items"]] == [1]
    assert client.get("/api/violations?review=bogus").status_code == 422
    assert client.get("/api/audit?action=violation.review").json()["total"] == 1
    assert any(x["id"] == "ppe_worn" for x in client.get("/api/config/schema").json()["review_reasons"])
    assert "review" in client.get("/api/violations/export").text.splitlines()[0]


def test_dataset_export_is_a_yolo_layout_zip_with_prelabels(client):
    client.post("/api/violations/1/review", json={"verdict": "false_alarm", "reason": "not_a_person"})
    client.post("/api/violations/2/review", json={"verdict": "false_alarm", "reason": "ppe_worn"})
    client.post("/api/violations/10/review", json={"verdict": "false_alarm", "reason": "ppe_worn"})  # no original frame
    r = client.get("/api/violations/dataset?review=false_alarm")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip" and r.headers["x-image-count"] == "2"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert {"images/v0000001.jpg", "labels/v0000001.txt", "images/v0000002.jpg", "labels/v0000002.txt",
            "manifest.csv", "data.yaml", "README.txt"} == set(z.namelist())
    assert z.read("images/v0000002.jpg") == b"FRAME1"
    assert z.read("labels/v0000001.txt") == b""  # not a person -> hard negative, no box
    cls, cx, cy, w, h = z.read("labels/v0000002.txt").decode().split()
    assert (cls, float(cx), float(cy), float(w), float(h)) == ("0", 0.375, 0.5, 0.25, 0.5)
    rows = list(csv.DictReader(io.StringIO(z.read("manifest.csv").decode())))
    assert [(x["violation_id"], x["review_reason"]) for x in rows] == [("2", "ppe_worn"), ("1", "not_a_person")]
    assert client.get("/api/violations/dataset?review=valid").status_code == 404  # nothing to export
    assert client.get("/api/audit?action=violations.export_dataset").json()["total"] == 1
