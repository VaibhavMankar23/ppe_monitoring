"""FastAPI authentication / authorization dependencies.

Every protected route declares the permission it needs:

    @app.get("/api/violations", dependencies=[Depends(require("violations:view"))])

`require` authenticates the bearer access token (signature, expiry, the user still exists and
is active, and the token's version matches the user's current one), refuses accounts that
still have to change their password, and returns 403 with a readable message when the role
lacks the permission.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .security import ROLE_LABELS, AuthSettings, TokenError, decode_access_token, lowest_role_with
from .users_db import AuditStore, User, UserStore


class ApiError(HTTPException):
    """HTTPException with a machine-readable `code` next to the human `detail`."""

    def __init__(self, status: int, detail: str, code: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(status, detail, headers)
        self.code = code


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "code": exc.code}, headers=exc.headers)


@dataclass
class AuthContext:
    settings: AuthSettings
    users: UserStore
    audit: AuditStore


def ctx(request: Request) -> AuthContext:
    return request.app.state.auth


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _unauthorized(detail: str, code: str) -> ApiError:
    return ApiError(401, detail, code, headers={"WWW-Authenticate": "Bearer"})


def user_from_token(c: AuthContext, token: str) -> User:
    try:
        claims = decode_access_token(c.settings, token)
    except TokenError as e:
        raise _unauthorized(str(e), e.code) from e
    try:
        user = c.users.get(int(claims["sub"]))
    except (TypeError, ValueError):
        user = None
    if user is None or not user.is_active:
        raise _unauthorized("This account no longer exists or has been deactivated.", "account_inactive")
    if claims.get("ver") != user.token_version:
        raise _unauthorized("Your session was ended because your account changed. Please sign in again.", "session_revoked")
    return user


def _bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    scheme, _, token = h.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def authenticate(request: Request, *, allow_query_token: bool = False) -> User:
    token = _bearer(request)
    if token is None and allow_query_token:
        # <img src> (MJPEG) and WebSocket handshakes can't carry an Authorization header
        token = request.query_params.get("access_token") or None
    if token is None:
        raise _unauthorized("Sign in to continue.", "not_authenticated")
    user = user_from_token(ctx(request), token)
    request.state.user = user
    return user


def check_permission(user: User, permissions: tuple[str, ...]) -> None:
    if user.must_change_password:
        raise ApiError(403, "You must change your password before using the app.", "password_change_required")
    missing = [p for p in permissions if p not in user.permissions]
    if missing:
        raise ApiError(403, f"Your role ({ROLE_LABELS.get(user.role, user.role)}) is not allowed to do this: "
                            f"it requires the {lowest_role_with(missing[0])} role ({missing[0]}).", "forbidden")


def require(*permissions: str, allow_query_token: bool = False) -> Callable[[Request], User]:
    """Dependency factory: authenticated user that holds every listed permission."""

    def dep(request: Request) -> User:
        user = authenticate(request, allow_query_token=allow_query_token)
        check_permission(user, permissions)
        return user

    dep.__name__ = f"require_{'_'.join(p.replace(':', '_') for p in permissions) or 'auth'}"
    dep.required_permissions = permissions  # type: ignore[attr-defined]  # introspected by tests
    return dep


def require_role(*roles: str) -> Callable[[Request], User]:
    """Role-based variant for the rare route that is about the role itself rather than a permission."""

    def dep(request: Request) -> User:
        user = authenticate(request)
        if user.must_change_password:
            raise ApiError(403, "You must change your password before using the app.", "password_change_required")
        if user.role not in roles:
            need = " or ".join(ROLE_LABELS.get(r, r) for r in roles)
            raise ApiError(403, f"This requires the {need} role.", "forbidden")
        return user

    return dep


def current_user(request: Request) -> User:
    """Any signed-in user, including one who still has to change their password (for /me etc.)."""
    return authenticate(request)
