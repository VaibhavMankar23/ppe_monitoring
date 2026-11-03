"""Regression tests for the Oct 2026 security review: file read through the SPA route, env-var leaks
through camera addresses, stored camera passwords sent to other hosts, and probes outside videos/."""

from __future__ import annotations

import anyio
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.secret_box import MASK
from app.violations_db import ViolationStore
from helpers import FakeDetector, auth_settings, bearer, bootstrap_super_admin, create_admin, raw_config, write_config


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PPE_VIDEOS_DIR", str(tmp_path / "videos"))
    (tmp_path / "videos").mkdir()
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>")
    (tmp_path / "secret.txt").write_text("do-not-serve")
    raw = raw_config(tmp_path, n_streams=1)
    raw["server"] = {"static_dir": str(dist)}
    path = write_config(tmp_path, raw)
    cfg = load_config(path)
    app = create_app(cfg, Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=FakeDetector),
                     config_path=path, auth_settings=auth_settings())
    with TestClient(app) as c:
        sup = bootstrap_super_admin(c)
        c.tokens = {"super": sup, "admin": create_admin(c, sup)}  # type: ignore[attr-defined]
        c.asgi = app  # type: ignore[attr-defined]
        yield c


def _raw_get(client, path: str) -> tuple[int, bytes]:
    """GET with an already-decoded path, the way uvicorn hands %2e%2e%2f to the app."""
    out: dict = {}
    sent_request = []

    async def recv():
        if not sent_request:
            sent_request.append(True)
            return {"type": "http.request", "body": b"", "more_body": False}
        while not out.get("done"):  # file responses listen for the disconnect until the body is sent
            await anyio.sleep(0.01)
        return {"type": "http.disconnect"}

    async def send(m):
        if m["type"] == "http.response.start":
            out["status"] = m["status"]
        elif m["type"] == "http.response.body":
            out["body"] = out.get("body", b"") + m.get("body", b"")
            out["done"] = not m.get("more_body", False)

    scope = {"type": "http", "method": "GET", "path": path, "raw_path": path.encode(), "query_string": b"",
             "headers": [], "scheme": "http", "server": ("x", 80), "client": ("1.2.3.4", 1), "root_path": "",
             "http_version": "1.1"}

    async def call():
        await client.asgi(scope, recv, send)

    client.portal.call(call)  # on the client's own event loop (asyncio.run here would deadlock)
    return out["status"], out.get("body", b"")


def test_spa_route_never_serves_files_outside_the_build(env):
    status, body = _raw_get(env, "/../secret.txt")
    assert b"do-not-serve" not in body
    assert body == b"<html>app</html>"  # unknown paths fall back to the app
    assert _raw_get(env, "/../../../../../../etc/passwd")[1] == b"<html>app</html>"


def test_connection_test_does_not_expand_secret_env_vars(env, monkeypatch):
    monkeypatch.setenv("PPE_JWT_SECRET", "top-secret-value")
    r = env.post("/api/sources/test", headers=bearer(env.tokens["admin"]),
                 json={"source": {"type": "http", "uri": "http://127.0.0.1:9/${PPE_JWT_SECRET}", "timeout": 1}})
    assert "top-secret-value" not in r.text


def test_connection_test_rejects_non_camera_protocols_and_outside_paths(env, tmp_path):
    h = bearer(env.tokens["admin"])
    r = env.post("/api/sources/test", headers=h, json={"source": {"type": "rtsp", "uri": "file:///etc/passwd"}})
    assert r.status_code == 422
    r = env.post("/api/sources/test", headers=h, json={"source": {"type": "images", "uri": str(tmp_path)}})
    assert r.status_code == 422 and "videos" in r.text


def test_stored_camera_password_is_only_reused_for_the_same_camera(env, monkeypatch):
    monkeypatch.setenv("PPE_SECRET_KEY", "unit-test-key")  # don't depend on a local backend/.env
    sup = bearer(env.tokens["super"])
    doc = env.get("/api/config", headers=sup).json()
    cfg = doc["config"]
    cfg["streams"][0]["source"] = {"type": "rtsp", "uri": "rtsp://10.0.0.5/live", "username": "cam", "password": "s3cret"}
    assert env.put("/api/config", headers=sup, json={"config": cfg, "etag": doc["etag"]}).status_code == 200

    adm = bearer(env.tokens["admin"])
    # connection test: the masked password may not travel to another host
    r = env.post("/api/sources/test", headers=adm, json={"stream_id": "cam1",
                 "source": {"type": "http", "uri": "http://10.9.9.9:8080/", "password": MASK, "timeout": 1}})
    assert r.status_code == 422 and r.json().get("code", r.json().get("error")) is not None
    assert "password" in r.text.lower()
    # saving: same rule
    doc = env.get("/api/config", headers=adm).json()
    cfg = doc["config"]
    assert cfg["streams"][0]["source"]["password"] == MASK
    cfg["streams"][0]["source"]["uri"] = "rtsp://10.9.9.9/live"
    r = env.put("/api/config", headers=adm, json={"config": cfg, "etag": doc["etag"]})
    assert r.status_code == 422 and "password" in r.text.lower()
    # same camera, different path: the stored password is kept
    cfg["streams"][0]["source"]["uri"] = "rtsp://10.0.0.5/sub"
    assert env.put("/api/config", headers=adm, json={"config": cfg, "etag": doc["etag"]}).status_code == 200


def test_first_account_never_gets_the_public_password(tmp_path, monkeypatch, caplog):
    from app.security import SEED_PASSWORD, SEED_USERNAME, verify_password
    from app.users_db import UserStore

    monkeypatch.delenv("PPE_INITIAL_ADMIN_PASSWORD", raising=False)
    users = UserStore(ViolationStore(":memory:").engine)
    with caplog.at_level("WARNING"):
        assert users.seed_default()
    u = users.get_by_username(SEED_USERNAME)
    assert not verify_password(SEED_PASSWORD, u.password_hash) and u.must_change_password
    assert any("one-time password" in r.getMessage() for r in caplog.records)


def test_csv_export_neutralises_spreadsheet_formulas():
    store = ViolationStore(":memory:")
    store.add("cam1", "=HYPERLINK(\"http://evil\",\"x\")", 1, ["helmet"], b"I", b"T", ts=1_790_000_000)
    from app.violations_db import ViolationFilter

    import csv
    import io

    rows = list(csv.reader(io.StringIO(store.export_csv(ViolationFilter()))))
    name = rows[1][rows[0].index("camera_name")]
    assert name.startswith("'=HYPERLINK(")  # shown as text in Excel, never evaluated


def test_responses_carry_security_headers(env):
    r = env.get("/api/health")
    assert r.headers["X-Content-Type-Options"] == "nosniff" and r.headers["X-Frame-Options"] == "DENY"
    csp = r.headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp


def test_admin_never_sees_alarm_credentials_and_can_still_save_cameras(env):
    sup = bearer(env.tokens["super"])
    doc = env.get("/api/config", headers=sup).json()
    cfg = doc["config"]
    cfg.setdefault("alarm", {})["email"] = {"password": "smtp-pass-123"}
    cfg["alarm"]["webhook"] = {"url": "https://hooks.example/T0K3N"}
    assert env.put("/api/config", headers=sup, json={"config": cfg, "etag": doc["etag"]}).status_code == 200

    adm = bearer(env.tokens["admin"])
    doc = env.get("/api/config", headers=adm).json()
    assert "smtp-pass-123" not in str(doc) and "T0K3N" not in str(doc)
    cfg = doc["config"]
    cfg["streams"][0]["name"] = "Gate"
    assert env.put("/api/config", headers=adm, json={"config": cfg, "etag": doc["etag"]}).status_code == 200
    full = env.get("/api/config", headers=sup).json()["config"]
    assert full["alarm"]["email"]["password"] == "smtp-pass-123" and full["alarm"]["webhook"]["url"] == "https://hooks.example/T0K3N"


def test_admin_cannot_export_the_photo_dataset(env):
    assert env.get("/api/violations/dataset", headers=bearer(env.tokens["admin"])).status_code == 403
