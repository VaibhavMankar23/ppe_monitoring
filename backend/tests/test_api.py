"""HTTP API: config endpoints (validate/save/hot-reload/backups) and violations endpoints."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.violations_db import ViolationStore
from helpers import FakeDetector, auth_settings, bootstrap_super_admin, raw_config, write_config


@pytest.fixture()
def client(tmp_path):
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=2))
    cfg = load_config(path)
    store = ViolationStore(":memory:")
    for i in range(12):
        store.add("cam1" if i % 2 else "cam2", "Camera", i, ["helmet"] if i % 3 else ["vest"], b"IMG", b"TH",
                  ts=1_790_000_000 + i)
    mon = Monitor(cfg, store=store, detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        c.mon = mon  # type: ignore[attr-defined]
        c.headers["Authorization"] = f"Bearer {bootstrap_super_admin(c)}"  # these tests run as super_admin
        yield c


def test_get_config_and_schema(client):
    r = client.get("/api/config").json()
    assert r["config"]["streams"][0]["id"] == "cam1" and r["etag"]
    s = client.get("/api/config/schema").json()
    assert "helmet" in s["ppe_items"] and "properties" in s["schema"]


def test_put_invalid_returns_field_errors_and_does_not_write(client):
    before = client.get("/api/config").json()
    bad = before["config"]
    bad["streams"][0]["source"]["uri"] = ""
    r = client.put("/api/config", json={"config": bad})
    assert r.status_code == 422
    assert any(e["loc"] == "streams.0.source.uri" for e in r.json()["errors"])
    assert client.get("/api/config").json()["etag"] == before["etag"]


def test_put_valid_saves_backs_up_and_hot_reloads(client):
    cur = client.get("/api/config").json()
    raw = cur["config"]
    raw["streams"][1]["required_ppe"] = ["helmet", "boots"]
    r = client.put("/api/config", json={"config": raw, "etag": cur["etag"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reload"]["restarted"] == ["cam2"]
    assert len(client.get("/api/config/backups").json()) == 1
    assert client.get("/api/streams/cam2").json()["required_ppe"] == ["helmet", "boots"]


def test_put_with_stale_etag_conflicts(client):
    raw = client.get("/api/config").json()["config"]
    assert client.put("/api/config", json={"config": raw, "etag": "0000"}).status_code == 409


def test_validate_endpoint_yaml(client):
    r = client.post("/api/config/validate", json={"yaml": "streams: [\n"}).json()
    assert not r["valid"] and r["errors"][0]["loc"] == "yaml"


def test_violations_list_filters_pagination(client):
    p1 = client.get("/api/violations", params={"limit": 5}).json()
    assert p1["total"] == 12 and len(p1["items"]) == 5 and p1["next_before_id"]
    p2 = client.get("/api/violations", params={"limit": 5, "before_id": p1["next_before_id"]}).json()
    assert not {v["id"] for v in p1["items"]} & {v["id"] for v in p2["items"]}
    cam = client.get("/api/violations", params={"camera": "cam1"}).json()
    assert cam["total"] == 6
    vest = client.get("/api/violations", params={"ppe": "vest"}).json()
    assert vest["total"] == 4
    rng = client.get("/api/violations", params={"start": 1_790_000_010, "end": 1_790_000_100}).json()
    assert rng["total"] == 2
    assert client.get("/api/violations", params={"ppe": "jetpack"}).status_code == 422


def test_violation_detail_delete_export(client):
    vid = client.get("/api/violations", params={"limit": 1}).json()["items"][0]["id"]
    full = client.get(f"/api/violations/{vid}").json()
    assert base64.b64decode(full["image"]) == b"IMG"
    assert client.delete(f"/api/violations/{vid}").status_code == 200
    assert client.get(f"/api/violations/{vid}").status_code == 404
    csv = client.get("/api/violations/export", params={"camera": "cam2"})
    assert csv.headers["content-type"].startswith("text/csv")
    assert "attachment" in csv.headers["content-disposition"]
    assert len(csv.text.strip().splitlines()) == 1 + 6  # header + 6 cam2 rows (the deleted newest row was cam1)


def test_phone_use_violation_end_to_end(client):
    """A phone_use violation must be listable, filterable, viewable and exportable via the API,
    exactly like a PPE violation (Violations page flow)."""
    store = client.mon.store  # type: ignore[attr-defined]
    store.add("cam1", "Camera", 101, ["phone_use"], b"PIMG", b"PTH", ts=1_790_000_500)
    store.add("cam2", "Camera", 102, ["helmet", "phone_use"], b"PIMG2", b"PTH2", ts=1_790_000_501)

    # appears in the unfiltered list, with phone_use in `missing` (renders the 📱 chip on the page)
    all_items = client.get("/api/violations", params={"limit": 200}).json()["items"]
    phone_items = [v for v in all_items if "phone_use" in v["missing"]]
    assert len(phone_items) == 2

    # the Violations page "Phone use" filter -> GET ?ppe=phone_use must NOT 422 and must select both
    resp = client.get("/api/violations", params={"ppe": "phone_use"})
    assert resp.status_code == 200, resp.text
    filtered = resp.json()
    assert filtered["total"] == 2
    assert all("phone_use" in v["missing"] for v in filtered["items"])

    # detail view carries phone_use and its snapshot
    vid = filtered["items"][0]["id"]
    detail = client.get(f"/api/violations/{vid}").json()
    assert "phone_use" in detail["missing"]
    assert base64.b64decode(detail["image"]) in (b"PIMG", b"PIMG2")

    # CSV export honours the phone filter
    csv = client.get("/api/violations/export", params={"ppe": "phone_use"})
    assert csv.status_code == 200
    assert "phone_use" in csv.text
    assert len(csv.text.strip().splitlines()) == 1 + 2  # header + 2 phone rows

    # a genuinely unknown type is still rejected
    assert client.get("/api/violations", params={"ppe": "jetpack"}).status_code == 422


def test_unknown_api_path_is_404_not_html(client):
    assert client.get("/api/nope").status_code == 404


def test_access_tokens_are_redacted_in_server_logs():
    import logging

    from app.api import RedactTokens

    rec = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, '%s - "WebSocket %s" [accepted]',
                            ("1.2.3.4:5", "/ws?access_token=eyJ.abc.def&x=1"), None)
    assert RedactTokens().filter(rec)
    assert rec.getMessage() == '1.2.3.4:5 - "WebSocket /ws?access_token=***&x=1" [accepted]'
