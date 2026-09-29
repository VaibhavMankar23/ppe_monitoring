"""Routes: /api/auth/* (login, refresh, logout, me, change-password), /api/users/*, /api/audit.

Token transport
---------------
* access token (JWT, 15 min): returned in the JSON body; the SPA keeps it in memory only.
* refresh token (opaque, rotated on every use, stored hashed): set as an httpOnly,
  SameSite=Strict cookie scoped to /api/auth, so page scripts can never read it. A page
  reload restores the session by calling /api/auth/refresh.
  Non-browser clients (curl, scripts) send ``"token_transport": "body"`` on login and get the
  refresh token in the JSON instead, then pass it back as ``{"refresh_token": ...}``.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import ApiError, AuthContext, client_ip, ctx, current_user, require
from .security import (
    PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, ROLES, TokenError, burn_password_check, create_access_token,
    password_problems, verify_password,
)
from .users_db import User, UserError

log = logging.getLogger(__name__)

REFRESH_COOKIE = "ppe_refresh"
COOKIE_PATH = "/api/auth"

# brute-force throttle: per (client IP, username)
MAX_FAILURES = 5
FAILURE_WINDOW = 300.0
LOCKOUT_SECONDS = 60.0


class LoginThrottle:
    def __init__(self) -> None:
        self._fails: dict[tuple[str, str], list[float]] = {}
        self._locked: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    def retry_after(self, key: tuple[str, str], now: float) -> float:
        with self._lock:
            until = self._locked.get(key, 0.0)
            return max(0.0, until - now)

    def fail(self, key: tuple[str, str], now: float) -> None:
        with self._lock:
            xs = [t for t in self._fails.get(key, []) if now - t < FAILURE_WINDOW] + [now]
            self._fails[key] = xs
            if len(xs) >= MAX_FAILURES:
                self._locked[key] = now + LOCKOUT_SECONDS
                self._fails[key] = []
            if len(self._fails) > 10_000:  # bound memory under a spray attack
                self._fails.clear()

    def success(self, key: tuple[str, str]) -> None:
        with self._lock:
            self._fails.pop(key, None)
            self._locked.pop(key, None)


# ------------------------------------------------------------------ bodies
class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    remember: bool = False
    token_transport: Literal["cookie", "body"] = "cookie"


class RefreshBody(BaseModel):
    refresh_token: str | None = Field(default=None, max_length=256)


class ChangePasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class CreateUserBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    role: Literal["admin", "super_admin"] = "admin"
    must_change_password: bool = True


class UpdateUserBody(BaseModel):
    role: Literal["admin", "super_admin"] | None = None
    is_active: bool | None = None


class ResetPasswordBody(BaseModel):
    new_password: str = Field(min_length=1, max_length=256)
    must_change_password: bool = True


# ------------------------------------------------------------------ helpers
def me_payload(u: User) -> dict[str, Any]:
    return {**u.public(), "role_label": ROLE_LABELS.get(u.role, u.role), "permissions": sorted(u.permissions)}


def _policy_or_400(password: str, username: str) -> None:
    problems = password_problems(password, username=username)
    if problems:
        raise ApiError(400, "Password " + "; ".join(problems) + ".", "weak_password")


def _user_error(e: UserError) -> ApiError:
    return ApiError(e.status, str(e), "user_error")


def _secure(c: AuthContext, request: Request) -> bool:
    return c.settings.cookie_secure if c.settings.cookie_secure is not None else request.url.scheme == "https"


def _set_refresh_cookie(c: AuthContext, request: Request, response: Response, token: str, expires_at: float,
                        remember: bool) -> None:
    response.set_cookie(
        REFRESH_COOKIE, token,
        max_age=int(expires_at - time.time()) if remember else None,  # no max-age = gone when the browser closes
        path=COOKIE_PATH, httponly=True, samesite="strict", secure=_secure(c, request),
    )


def _clear_refresh_cookie(c: AuthContext, request: Request, response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH, httponly=True, samesite="strict", secure=_secure(c, request))


def _token_response(c: AuthContext, u: User) -> dict[str, Any]:
    token, exp = create_access_token(c.settings, user_id=u.id, username=u.username, role=u.role,
                                     token_version=u.token_version)
    return {"access_token": token, "token_type": "bearer", "expires_in": c.settings.access_ttl, "expires_at": exp,
            "user": me_payload(u)}


def build_router() -> APIRouter:
    r = APIRouter()
    throttle = LoginThrottle()

    # ============================================================ auth
    @r.post("/api/auth/login")
    def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
        c = ctx(request)
        name = body.username.strip().lower()
        key = (client_ip(request), name)
        now = time.time()
        wait = throttle.retry_after(key, now)
        if wait > 0:
            raise ApiError(429, f"Too many failed sign-in attempts. Try again in {int(wait) + 1} s.", "too_many_attempts",
                           headers={"Retry-After": str(int(wait) + 1)})
        u = c.users.get_by_username(name)
        if u is None:
            burn_password_check(body.password)
            ok = False
        else:
            ok = verify_password(body.password, u.password_hash)
        if not ok or u is None:
            throttle.fail(key, now)
            c.audit.record("auth.login_failed", actor_name=name[:64], target_type="user", target=name[:64],
                           ip=client_ip(request))
            log.info("failed sign-in for '%s' from %s", name[:64], client_ip(request))
            raise ApiError(401, "Incorrect username or password.", "invalid_credentials")
        if not u.is_active:
            raise ApiError(403, "This account has been deactivated. Contact a Super Admin.", "account_inactive")
        throttle.success(key)
        c.users.record_login(u.id, now)
        u = c.users.get(u.id) or u
        ttl = c.settings.refresh_ttl_remember if body.remember else c.settings.refresh_ttl_session
        refresh, rexp = c.users.issue_refresh(u.id, remember=body.remember, ttl=ttl)
        out = _token_response(c, u)
        if body.token_transport == "body":
            out.update(refresh_token=refresh, refresh_expires_at=rexp)
        else:
            _set_refresh_cookie(c, request, response, refresh, rexp, body.remember)
        c.audit.record("auth.login", actor=u, target_type="user", target=u.username, ip=client_ip(request),
                       detail="remember me" if body.remember else "")
        log.info("user '%s' signed in (%s)", u.username, u.role)
        return out

    @r.post("/api/auth/refresh", response_model=None)
    def refresh(request: Request, response: Response, body: RefreshBody | None = None) -> dict[str, Any] | JSONResponse:
        c = ctx(request)
        from_body = bool(body and body.refresh_token)
        token = body.refresh_token if from_body and body else request.cookies.get(REFRESH_COOKIE)
        if not token:
            raise ApiError(401, "Sign in to continue.", "not_authenticated")
        try:
            u, new, exp, remember = c.users.rotate_refresh(token, ttl_session=c.settings.refresh_ttl_session,
                                                           ttl_remember=c.settings.refresh_ttl_remember)
        except TokenError as e:
            # returned rather than raised, so the cookie deletion reaches the browser
            err = JSONResponse(status_code=401, content={"detail": str(e), "code": "invalid_refresh"})
            if not from_body:
                _clear_refresh_cookie(c, request, err)
            return err
        out = _token_response(c, u)
        if new is not None:  # None = concurrent refresh from another tab (browser already has the newer cookie)
            if from_body:
                out.update(refresh_token=new, refresh_expires_at=exp)
            else:
                _set_refresh_cookie(c, request, response, new, exp, remember)
        return out

    @r.post("/api/auth/logout")
    def logout(request: Request, response: Response, body: RefreshBody | None = None) -> dict[str, bool]:
        c = ctx(request)
        token = (body.refresh_token if body and body.refresh_token else None) or request.cookies.get(REFRESH_COOKIE)
        uid = c.users.revoke_refresh(token) if token else None
        _clear_refresh_cookie(c, request, response)
        if uid is not None:
            u = c.users.get(uid)
            c.audit.record("auth.logout", actor=u, actor_name=None if u else "unknown", target_type="user",
                           target=u.username if u else str(uid), ip=client_ip(request))
        return {"ok": True}

    @r.get("/api/auth/me")
    def me(user: User = Depends(current_user)) -> dict[str, Any]:
        return me_payload(user)

    @r.post("/api/auth/change-password")
    def change_password(body: ChangePasswordBody, request: Request, response: Response,
                        user: User = Depends(current_user)) -> dict[str, Any]:
        c = ctx(request)
        if not verify_password(body.current_password, user.password_hash):
            raise ApiError(400, "Current password is incorrect.", "invalid_current_password")
        if body.new_password == body.current_password:
            raise ApiError(400, "The new password must be different from the current one.", "weak_password")
        _policy_or_400(body.new_password, user.username)
        remember = False
        old = request.cookies.get(REFRESH_COOKIE)
        if old:
            remember = c.users.session_remember(old) or False
        u = c.users.set_password(user.id, body.new_password, must_change_password=False)  # ends every session
        ttl = c.settings.refresh_ttl_remember if remember else c.settings.refresh_ttl_session
        refresh_tok, rexp = c.users.issue_refresh(u.id, remember=remember, ttl=ttl)  # ...then keeps this one
        _set_refresh_cookie(c, request, response, refresh_tok, rexp, remember)
        c.audit.record("auth.password_change", actor=u, target_type="user", target=u.username, ip=client_ip(request),
                       detail="first sign-in (forced)" if user.must_change_password else "")
        log.info("user '%s' changed their password", u.username)
        return _token_response(c, u)

    # ============================================================ users (Super Admin)
    manage = require("users:manage")

    @r.get("/api/users")
    def list_users(request: Request, _: User = Depends(manage)) -> list[dict[str, Any]]:
        c = ctx(request)
        return [{**u.public(), "role_label": ROLE_LABELS.get(u.role, u.role),
                 "active_sessions": c.users.active_sessions(u.id)} for u in c.users.list()]

    @r.get("/api/users/roles")
    def roles(_: User = Depends(manage)) -> dict[str, Any]:
        return {
            "roles": [{"id": ro, "label": ROLE_LABELS[ro], "permissions": sorted(ROLE_PERMISSIONS[ro])} for ro in ROLES],
            "permissions": [{"id": p, "description": d} for p, d in PERMISSIONS.items()],
        }

    @r.post("/api/users", status_code=201)
    def create_user(body: CreateUserBody, request: Request, actor: User = Depends(manage)) -> dict[str, Any]:
        c = ctx(request)
        _policy_or_400(body.password, body.username.strip().lower())
        try:
            u = c.users.create(body.username, body.password, body.role, must_change_password=body.must_change_password)
        except UserError as e:
            raise _user_error(e) from e
        c.audit.record("user.create", actor=actor, target_type="user", target=u.username, ip=client_ip(request),
                       after={"role": u.role, "must_change_password": u.must_change_password})
        return u.public()

    @r.patch("/api/users/{user_id}")
    def update_user(user_id: int, body: UpdateUserBody, request: Request, actor: User = Depends(manage)) -> dict[str, Any]:
        c = ctx(request)
        try:
            before, after = c.users.update(user_id, role=body.role, is_active=body.is_active, acting_user_id=actor.id)
        except UserError as e:
            raise _user_error(e) from e
        b = {k: getattr(before, k) for k in ("role", "is_active") if getattr(before, k) != getattr(after, k)}
        a = {k: getattr(after, k) for k in b}
        if b:
            action = "user.deactivate" if b.get("is_active") is True else "user.activate" if "is_active" in b and len(b) == 1 else "user.update"
            c.audit.record(action, actor=actor, target_type="user", target=after.username, before=b, after=a,
                           ip=client_ip(request))
        return after.public()

    @r.post("/api/users/{user_id}/reset-password")
    def reset_password(user_id: int, body: ResetPasswordBody, request: Request, actor: User = Depends(manage)) -> dict[str, Any]:
        c = ctx(request)
        target = c.users.get(user_id)
        if target is None:
            raise ApiError(404, "user not found", "user_error")
        _policy_or_400(body.new_password, target.username)
        u = c.users.set_password(user_id, body.new_password, must_change_password=body.must_change_password)
        c.audit.record("user.reset_password", actor=actor, target_type="user", target=u.username, ip=client_ip(request),
                       detail="must change at next sign-in" if body.must_change_password else "")
        return u.public()

    @r.delete("/api/users/{user_id}")
    def delete_user(user_id: int, request: Request, actor: User = Depends(manage)) -> dict[str, bool]:
        c = ctx(request)
        try:
            u = c.users.delete(user_id, acting_user_id=actor.id)
        except UserError as e:
            raise _user_error(e) from e
        c.audit.record("user.delete", actor=actor, target_type="user", target=u.username, ip=client_ip(request),
                       before={"role": u.role, "is_active": u.is_active})
        return {"ok": True}

    # ============================================================ audit log (Super Admin)
    @r.get("/api/audit")
    def audit_log(request: Request, _: User = Depends(require("audit:view")),
                  action: str | None = None, actor: str | None = None,
                  start: float | None = None, end: float | None = None,
                  before_id: int | None = None, limit: int = Query(50, ge=1, le=200)) -> dict[str, Any]:
        return ctx(request).audit.list(action=action, actor=actor, start=start, end=end, before_id=before_id, limit=limit)

    @r.get("/api/audit/actions")
    def audit_actions(request: Request, _: User = Depends(require("audit:view"))) -> list[str]:
        return ctx(request).audit.actions()

    return r
