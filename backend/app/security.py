"""Passwords (bcrypt), JWT access tokens, opaque refresh tokens and the role -> permission matrix.

Pure helpers with no FastAPI / DB dependency, so they are easy to unit-test.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import bcrypt
import jwt

log = logging.getLogger(__name__)

Role = Literal["admin", "super_admin"]
ROLES: tuple[Role, ...] = ("admin", "super_admin")
ROLE_LABELS: dict[str, str] = {"admin": "Admin", "super_admin": "Super Admin"}

# ------------------------------------------------------------------ permissions
# One place that decides who may do what. The backend enforces it on every route
# (see auth.require); /api/auth/me sends the caller's list so the UI can hide what
# they can't use - hiding is cosmetic, the server is the gate.
PERMISSIONS: dict[str, str] = {
    "monitor:view": "View the dashboard, live video and stream status",
    "streams:control": "Start / stop cameras and adjust the live confidence slider",
    "violations:view": "View violations and their snapshots",
    "violations:ack": "Acknowledge violations",
    "violations:export": "Export violations to CSV",
    "violations:delete": "Delete violations",
    "analytics:view": "View the analytics page",
    "config:view": "View the configuration",
    "config:cameras": "Edit per-camera settings (name, source, enabled, required PPE, confidence)",
    "config:system": "Edit system settings (model, device, tracker, compliance, alerts/retention, performance, "
                     "add/remove cameras, raw YAML, reset, restore backups)",
    "users:manage": "Create, edit, deactivate and delete users; reset passwords",
    "audit:view": "View the audit log",
}

_ADMIN = {
    "monitor:view", "streams:control", "violations:view", "violations:ack", "violations:export",
    "analytics:view", "config:view", "config:cameras",
}
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": frozenset(_ADMIN),
    "super_admin": frozenset(PERMISSIONS),
}


def permissions_for(role: str) -> frozenset[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def lowest_role_with(permission: str) -> str:
    for r in ROLES:  # ordered least -> most privileged
        if permission in ROLE_PERMISSIONS[r]:
            return ROLE_LABELS[r]
    return "nobody"


# ------------------------------------------------------------------ passwords
BCRYPT_ROUNDS = 12
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_BYTES = 72  # bcrypt ignores (bcrypt>=5: rejects) anything past 72 bytes
SEED_USERNAME = "admin"
SEED_PASSWORD = "mahindra123"  # documented bootstrap credential; forced to change on first login


def hash_password(password: str, rounds: int | None = None) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds or BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:MAX_PASSWORD_BYTES], password_hash.encode("ascii"))
    except ValueError:  # malformed hash
        return False


# Verified against when the username doesn't exist, so response time doesn't reveal valid usernames.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def burn_password_check(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


def password_problems(password: str, *, username: str = "") -> list[str]:
    """Policy for new passwords. Returns human-readable problems (empty = acceptable)."""
    out = []
    if len(password) < MIN_PASSWORD_LENGTH:
        out.append(f"must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        out.append(f"must be at most {MAX_PASSWORD_BYTES} bytes")
    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        out.append("must contain at least one letter and one digit")
    if username and password.lower() == username.lower():
        out.append("must not be the same as the username")
    if password == SEED_PASSWORD:
        out.append("must not be the default seed password")
    return out


# ------------------------------------------------------------------ settings
@dataclass
class AuthSettings:
    secret: str
    access_ttl: int = 15 * 60  # s
    refresh_ttl_session: int = 12 * 3600  # s, "remember me" off (browser-session cookie)
    refresh_ttl_remember: int = 30 * 86400  # s, "remember me" on (persistent cookie)
    cookie_secure: bool | None = None  # None = follow the request scheme (https -> Secure)
    algorithm: str = "HS256"
    issuer: str = "ppe-monitor"
    ephemeral_secret: bool = field(default=False, repr=False)

    @classmethod
    def from_env(cls) -> "AuthSettings":
        secret = os.environ.get("PPE_JWT_SECRET", "").strip()
        ephemeral = False
        if not secret:
            secret = secrets.token_urlsafe(48)
            ephemeral = True
            log.warning("PPE_JWT_SECRET is not set: using a random per-process secret. Everyone is signed out "
                        "whenever the server restarts. Set PPE_JWT_SECRET in backend/.env (or the compose .env).")
        elif len(secret) < 32:
            log.warning("PPE_JWT_SECRET is shorter than 32 characters; use a long random value in production.")
        cookie = os.environ.get("PPE_COOKIE_SECURE", "auto").strip().lower()
        return cls(
            secret=secret,
            access_ttl=int(os.environ.get("PPE_ACCESS_TOKEN_MINUTES", "15")) * 60,
            refresh_ttl_session=int(os.environ.get("PPE_REFRESH_SESSION_HOURS", "12")) * 3600,
            refresh_ttl_remember=int(os.environ.get("PPE_REFRESH_REMEMBER_DAYS", "30")) * 86400,
            cookie_secure=None if cookie == "auto" else cookie in ("1", "true", "yes"),
            ephemeral_secret=ephemeral,
        )


# ------------------------------------------------------------------ tokens
class TokenError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code  # token_expired | invalid_token


def create_access_token(settings: AuthSettings, *, user_id: int, username: str, role: str, token_version: int,
                        now: float | None = None) -> tuple[str, int]:
    """Returns (jwt, expires_at epoch seconds)."""
    iat = int(now if now is not None else time.time())
    exp = iat + settings.access_ttl
    claims: dict[str, Any] = {
        "sub": str(user_id), "usr": username, "role": role, "ver": token_version,
        "typ": "access", "iat": iat, "exp": exp, "iss": settings.issuer, "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, settings.secret, algorithm=settings.algorithm), exp


def decode_access_token(settings: AuthSettings, token: str) -> dict[str, Any]:
    try:
        claims = jwt.decode(token, settings.secret, algorithms=[settings.algorithm], issuer=settings.issuer,
                            options={"require": ["sub", "exp", "iat", "typ", "ver"]})
    except jwt.ExpiredSignatureError as e:
        raise TokenError("token_expired", "Your session has expired. Please sign in again.") from e
    except jwt.PyJWTError as e:
        raise TokenError("invalid_token", "Invalid authentication token.") from e
    if claims.get("typ") != "access":
        raise TokenError("invalid_token", "Invalid authentication token.")
    return claims


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    """Refresh tokens are stored hashed: a leaked DB file doesn't hand out sessions."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
