"""Auth flow, seed user, sessions, and role enforcement on every protected endpoint."""

from __future__ import annotations

import copy

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.security import SEED_PASSWORD, SEED_USERNAME, TokenError
from app.users_db import UserStore
from app.violations_db import ViolationStore
from helpers import (
    ADMIN_PASSWORD, SUPER_PASSWORD, FakeDetector, auth_settings, bearer, bootstrap_super_admin, create_admin, login,
    raw_config, write_config,
)

PUBLIC = {"/api/health", "/api/auth/login", "/api/auth/refresh", "/api/auth/logout"}


@pytest.fixture()
def env(tmp_path):
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=2))
    cfg = load_config(path)
    store = ViolationStore(":memory:")
    for i in range(4):
        store.add("cam1", "Camera 1", i, ["helmet"], b"IMG", b"TH", ts=1_790_000_000 + i)
    mon = Monitor(cfg, store=store, detector_factory=FakeDetector)
    app = create_app(cfg, mon, config_path=path, auth_settings=auth_settings())
    with TestClient(app) as c:
        c.store = store  # type: ignore[attr-defined]
        yield c


@pytest.fixture()
def tokens(env):
    sup = bootstrap_super_admin(env)
    adm = create_admin(env, sup)
    return {"super": sup, "admin": adm}


# ------------------------------------------------------------------ seed user
def test_seed_user_created_once_with_forced_password_change(env, caplog):
    users = env.app.state.auth.users
    assert users.count() == 1
    u = users.get_by_username(SEED_USERNAME)
    assert u.role == "super_admin" and u.must_change_password and u.password_hash != SEED_PASSWORD
    # idempotent: a second startup on the same database doesn't reseed or reset anything
    assert users.seed_default() is False
    assert users.count() == 1
    # ...and neither does it once the admin has been renamed away / other users exist
    other = UserStore(env.store.engine)
    assert other.seed_default() is False


def test_seed_logs_a_warning(tmp_path, caplog):
    store = ViolationStore(":memory:")
    with caplog.at_level("WARNING"):
        assert UserStore(store.engine).seed_default() is True
    assert any("default account" in r.message and "rotate" in r.message for r in caplog.records)
    with caplog.at_level("WARNING"):
        caplog.clear()
        assert UserStore(store.engine).seed_default() is False
    assert not any("default account" in r.message for r in caplog.records)


# ------------------------------------------------------------------ login flow
def test_login_wrong_password_and_unknown_user_look_identical(env):
    a = env.post("/api/auth/login", json={"username": SEED_USERNAME, "password": "nope"})
    b = env.post("/api/auth/login", json={"username": "ghost", "password": "nope"})
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json() == {"detail": "Incorrect username or password.", "code": "invalid_credentials"}


def test_login_is_throttled_after_repeated_failures(env):
    for _ in range(5):
        assert env.post("/api/auth/login", json={"username": "admin", "password": "bad"}).status_code == 401
    r = env.post("/api/auth/login", json={"username": "admin", "password": SEED_PASSWORD})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_forced_password_change_blocks_everything_else(env):
    t = login(env, SEED_USERNAME, SEED_PASSWORD)
    h = bearer(t["access_token"])
    assert t["user"]["must_change_password"] and "users:manage" in t["user"]["permissions"]
    assert env.get("/api/auth/me", headers=h).status_code == 200  # the UI needs to know who you are
    r = env.get("/api/status", headers=h)
    assert r.status_code == 403 and r.json()["code"] == "password_change_required"
    assert env.get("/api/users", headers=h).status_code == 403
    # weak / default passwords are refused
    for bad in ("short1", SEED_PASSWORD, "allletters", "admin"):
        r = env.post("/api/auth/change-password", headers=h, json={"current_password": SEED_PASSWORD, "new_password": bad})
        assert r.status_code == 400, bad
    r = env.post("/api/auth/change-password", headers=h, json={"current_password": "wrong", "new_password": SUPER_PASSWORD})
    assert r.status_code == 400 and r.json()["code"] == "invalid_current_password"
    r = env.post("/api/auth/change-password", headers=h, json={"current_password": SEED_PASSWORD, "new_password": SUPER_PASSWORD})
    assert r.status_code == 200 and r.json()["user"]["must_change_password"] is False
    new = bearer(r.json()["access_token"])
    assert env.get("/api/status", headers=new).status_code == 200
    # the pre-change token is dead (token version bumped), and the old password no longer works
    assert env.get("/api/auth/me", headers=h).json()["code"] == "session_revoked"
    assert env.post("/api/auth/login", json={"username": "admin", "password": SEED_PASSWORD}).status_code == 401
    assert login(env, "admin", SUPER_PASSWORD)["user"]["must_change_password"] is False


def test_no_plaintext_password_in_db_or_audit(env, tokens):
    import json

    rows = env.app.state.auth.audit.list(limit=200)["items"]
    blob = json.dumps(rows) + "".join(u.password_hash for u in env.app.state.auth.users.list())
    assert SUPER_PASSWORD not in blob and ADMIN_PASSWORD not in blob and SEED_PASSWORD not in blob


# ------------------------------------------------------------------ sessions
def test_refresh_cookie_rotation_logout_and_remember_me(env, tokens):
    r = env.post("/api/auth/login", json={"username": "operator", "password": ADMIN_PASSWORD})
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie.replace("Strict", "strict") and "Path=/api/auth" in cookie
    assert "Max-Age" not in cookie  # no "remember me": browser-session cookie
    assert "refresh_token" not in r.json()  # never exposed to page scripts in cookie mode
    first = env.cookies.get("ppe_refresh")

    r = env.post("/api/auth/refresh")
    assert r.status_code == 200 and r.json()["access_token"]
    assert env.cookies.get("ppe_refresh") != first  # rotated

    assert env.post("/api/auth/logout").status_code == 200
    env.cookies.clear()
    assert env.post("/api/auth/refresh").status_code == 401

    r = env.post("/api/auth/login", json={"username": "operator", "password": ADMIN_PASSWORD, "remember": True})
    assert "Max-Age" in r.headers["set-cookie"]


def test_body_transport_for_scripts(env, tokens):
    t = login(env, "operator", ADMIN_PASSWORD, token_transport="body")
    env.cookies.clear()
    r = env.post("/api/auth/refresh", json={"refresh_token": t["refresh_token"]})
    assert r.status_code == 200 and r.json()["refresh_token"] != t["refresh_token"]


def test_refresh_token_reuse_revokes_all_sessions(env, tokens):
    users = env.app.state.auth.users
    u = users.get_by_username("operator")
    tok, _ = users.issue_refresh(u.id, remember=False, ttl=3600, now=1000.0)
    other, _ = users.issue_refresh(u.id, remember=False, ttl=3600, now=1000.0)
    _, new, _, _ = users.rotate_refresh(tok, ttl_session=3600, ttl_remember=3600, now=1001.0)
    # a second tab using the just-rotated token a moment later is fine (no new token issued)
    assert users.rotate_refresh(tok, ttl_session=3600, ttl_remember=3600, now=1005.0)[1] is None
    # much later it's a replay: everything of this user is revoked, including unrelated sessions
    with pytest.raises(TokenError):
        users.rotate_refresh(tok, ttl_session=3600, ttl_remember=3600, now=1100.0)
    for t in (new, other):
        with pytest.raises(TokenError):
            users.rotate_refresh(t, ttl_session=3600, ttl_remember=3600, now=1101.0)


def test_expired_and_tampered_tokens(env, tokens):
    from app.security import AuthSettings, create_access_token

    u = env.app.state.auth.users.get_by_username("operator")
    old, _ = create_access_token(auth_settings(), user_id=u.id, username=u.username, role=u.role,
                                 token_version=u.token_version, now=1_000_000)
    r = env.get("/api/status", headers=bearer(old))
    assert r.status_code == 401 and r.json()["code"] == "token_expired"
    forged, _ = create_access_token(AuthSettings(secret="x" * 40), user_id=u.id, username=u.username, role="super_admin",
                                    token_version=u.token_version)
    assert env.get("/api/status", headers=bearer(forged)).json()["code"] == "invalid_token"


# ------------------------------------------------------------------ route guard: nothing is left open
def test_every_api_route_requires_authentication(env):
    missing = []
    for route in env.app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/api/") or route.path in PUBLIC:
            continue
        path = route.path.replace("{stream_id}", "cam1").replace("{vid}", "1").replace("{user_id}", "1")
        for method in route.methods - {"HEAD", "OPTIONS"}:
            r = env.request(method, path, json={})
            if r.status_code != 401:
                missing.append(f"{method} {route.path} -> {r.status_code}")
    assert not missing, missing


def test_websocket_requires_token(env, tokens):
    with pytest.raises(WebSocketDisconnect) as e:
        with env.websocket_connect("/ws") as ws:
            ws.receive_text()
    assert e.value.code == 4401
    with env.websocket_connect(f"/ws?access_token={tokens['admin']}") as ws:
        assert '"hello"' in ws.receive_text()


def test_mjpeg_frame_accepts_query_token_only_there(env, tokens):
    assert env.get("/api/streams/cam1/frame.jpg").status_code == 401
    assert env.get(f"/api/streams/cam1/frame.jpg?access_token={tokens['admin']}").status_code == 404  # authed; no frame yet
    assert env.get(f"/api/status?access_token={tokens['admin']}").status_code == 401  # not accepted on normal routes


# ------------------------------------------------------------------ role enforcement
ADMIN_FORBIDDEN = [
    ("GET", "/api/users", None),
    ("POST", "/api/users", {"username": "x1x", "password": "Passw0rd!", "role": "admin"}),
    ("PATCH", "/api/users/1", {"role": "admin"}),
    ("POST", "/api/users/1/reset-password", {"new_password": "Passw0rd!"}),
    ("DELETE", "/api/users/1", None),
    ("GET", "/api/users/roles", None),
    ("GET", "/api/audit", None),
    ("GET", "/api/audit/actions", None),
    ("POST", "/api/config/reset", None),
    ("GET", "/api/config/backups", None),
    ("POST", "/api/config/restore", {"name": "config.backup.20260101-000000-000000.yaml"}),
    ("DELETE", "/api/violations/1", None),
]


@pytest.mark.parametrize("method,path,body", ADMIN_FORBIDDEN)
def test_admin_is_denied_super_admin_endpoints(env, tokens, method, path, body):
    r = env.request(method, path, headers=bearer(tokens["admin"]), json=body)
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "forbidden" and "Super Admin" in r.json()["detail"]


def test_admin_allowed_operations(env, tokens):
    h = bearer(tokens["admin"])
    for path in ("/api/status", "/api/streams", "/api/violations", "/api/config", "/api/config/schema",
                 "/api/analytics/summary", "/api/auth/me"):
        assert env.get(path, headers=h).status_code == 200, path
    vid = env.get("/api/violations", headers=h).json()["items"][0]["id"]
    r = env.post(f"/api/violations/{vid}/ack", headers=h)
    assert r.status_code == 200 and r.json()["acknowledged_by"] == "operator"
    assert env.get("/api/violations/export", headers=h).status_code == 200
    assert env.post("/api/streams/cam1/stop", headers=h).status_code == 200
    me = env.get("/api/auth/me", headers=h).json()
    assert me["role"] == "admin" and "config:system" not in me["permissions"] and "config:cameras" in me["permissions"]


def test_admin_config_edits_limited_to_camera_fields(env, tokens):
    h = bearer(tokens["admin"])
    doc = env.get("/api/config", headers=h).json()
    ok = doc["config"]
    ok["streams"][0]["required_ppe"] = ["helmet"]
    ok["streams"][0]["confidence"] = 0.5
    ok["streams"][1]["enabled"] = False
    r = env.put("/api/config", headers=h, json={"config": ok, "etag": doc["etag"]})
    assert r.status_code == 200, r.text

    doc = env.get("/api/config", headers=h).json()
    for mutate in (lambda c: c["model"].__setitem__("device", "intel:gpu"),
                   lambda c: c.setdefault("inference", {}).__setitem__("frame_skip", 3),
                   lambda c: c["alerts"].__setitem__("retention_days", 1),
                   lambda c: c.setdefault("tracking", {}).__setitem__("min_hits", 5),
                   lambda c: c["streams"].pop(),
                   lambda c: c["streams"].append({**c["streams"][0], "id": "cam9"})):
        bad = copy.deepcopy(doc["config"])
        mutate(bad)
        r = env.put("/api/config", headers=h, json={"config": bad, "etag": doc["etag"]})
        assert r.status_code == 403 and r.json()["code"] == "forbidden", r.text
    r = env.put("/api/config", headers=h, json={"yaml": doc["yaml"], "etag": doc["etag"]})
    assert r.status_code == 403  # raw YAML is Super Admin only
    assert env.get("/api/config", headers=h).json()["etag"] == doc["etag"]  # nothing was written


def test_super_admin_can_do_system_things_and_it_is_audited(env, tokens):
    h = bearer(tokens["super"])
    doc = env.get("/api/config", headers=h).json()
    cfg = doc["config"]
    cfg["alerts"]["retention_days"] = 7
    cfg["streams"][0]["name"] = "Gate"
    assert env.put("/api/config", headers=h, json={"config": cfg, "etag": doc["etag"]}).status_code == 200
    vid = env.get("/api/violations", headers=h).json()["items"][0]["id"]
    assert env.delete(f"/api/violations/{vid}", headers=h).status_code == 200

    log = env.get("/api/audit", headers=h).json()["items"]
    upd = next(e for e in log if e["action"] == "config.update")
    assert upd["actor"] == "admin" and upd["before"] == {"alerts.retention_days": 30, "streams.cam1.name": "Camera 1"}
    assert upd["after"] == {"alerts.retention_days": 7, "streams.cam1.name": "Gate"}
    actions = [e["action"] for e in log]
    for a in ("violation.delete", "user.create", "auth.password_change", "auth.login", "user.seed"):
        assert a in actions, a
    assert env.get("/api/audit", headers=h, params={"action": "violation."}).json()["total"] == 1
    assert env.get("/api/audit", headers=h, params={"action": "auth.login"}).json()["total"] == sum(a == "auth.login" for a in actions)


def test_user_management_rules(env, tokens):
    h = bearer(tokens["super"])
    users = {u["username"]: u for u in env.get("/api/users", headers=h).json()}
    me, op = users["admin"], users["operator"]
    # can't lock yourself out
    assert env.patch(f"/api/users/{me['id']}", headers=h, json={"role": "admin"}).status_code == 400
    assert env.patch(f"/api/users/{me['id']}", headers=h, json={"is_active": False}).status_code == 400
    assert env.delete(f"/api/users/{me['id']}", headers=h).status_code == 400
    # duplicate username
    assert env.post("/api/users", headers=h, json={"username": "Operator", "password": "Passw0rd!x"}).status_code == 409
    # deactivation ends the user's sessions immediately
    oh = bearer(tokens["admin"])
    assert env.patch(f"/api/users/{op['id']}", headers=h, json={"is_active": False}).status_code == 200
    assert env.get("/api/status", headers=oh).status_code == 401
    assert env.post("/api/auth/login", json={"username": "operator", "password": ADMIN_PASSWORD}).status_code == 403
    # reactivate + reset password -> must change at next sign-in
    env.patch(f"/api/users/{op['id']}", headers=h, json={"is_active": True})
    assert env.post(f"/api/users/{op['id']}/reset-password", headers=h, json={"new_password": "Fresh1234"}).status_code == 200
    assert login(env, "operator", "Fresh1234")["user"]["must_change_password"] is True
    # promotion takes effect on the next request (old token revoked by the version bump)
    t = login(env, "operator", "Fresh1234")["access_token"]
    env.patch(f"/api/users/{op['id']}", headers=h, json={"role": "super_admin"})
    assert env.get("/api/auth/me", headers=bearer(t)).status_code == 401
    # now there are two super admins, the first one can be demoted by the other...
    assert env.delete(f"/api/users/{op['id']}", headers=h).status_code == 200


def test_open_websocket_is_closed_when_the_session_is_revoked(env, tokens):
    import time

    h = bearer(tokens["super"])
    op = next(u for u in env.get("/api/users", headers=h).json() if u["username"] == "operator")
    with env.websocket_connect(f"/ws?access_token={tokens['admin']}") as ws:
        assert '"hello"' in ws.receive_text()
        assert env.post(f"/api/users/{op['id']}/reset-password", headers=h, json={"new_password": "Fresh1234"}).status_code == 200
        deadline = time.time() + 8
        with pytest.raises(WebSocketDisconnect) as e:
            while time.time() < deadline:
                ws.receive_text()  # stats messages keep coming until the revalidation closes the socket
        assert e.value.code == 4401
