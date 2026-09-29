"""Users, refresh-token sessions and the audit log (SQLite via SQLAlchemy).

The tables live in the same database file as the violations (shared engine), so the one
persistent ``data`` volume holds everything.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, delete, func, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from .security import (
    ROLES, SEED_PASSWORD, SEED_USERNAME, TokenError, hash_password, hash_refresh_token, new_refresh_token,
    permissions_for,
)

log = logging.getLogger(__name__)

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
REFRESH_REUSE_GRACE = 30.0  # s: two tabs refreshing with the same cookie at once is not an attack


class AuthBase(DeclarativeBase):
    pass


class UserRow(AuthBase):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[float] = mapped_column(Float)
    last_login: Mapped[float | None] = mapped_column(Float, nullable=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # bumped on password / role / active changes: every access token carries it, so old tokens die at once
    token_version: Mapped[int] = mapped_column(Integer, default=1)
    password_changed_at: Mapped[float | None] = mapped_column(Float, nullable=True)


class RefreshTokenRow(AuthBase):
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[float] = mapped_column(Float)
    expires_at: Mapped[float] = mapped_column(Float)
    remember: Mapped[bool] = mapped_column(Boolean, default=False)
    revoked_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    replaced_by: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AuditRow(AuthBase):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[float] = mapped_column(Float, index=True)
    actor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor: Mapped[str] = mapped_column(String(64))  # username at the time (kept if the user is deleted)
    actor_role: Mapped[str] = mapped_column(String(16), default="")
    action: Mapped[str] = mapped_column(String(48), index=True)
    target_type: Mapped[str] = mapped_column(String(32), default="")
    target: Mapped[str] = mapped_column(String(128), default="")
    before: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    after: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    detail: Mapped[str] = mapped_column(Text, default="")
    ip: Mapped[str] = mapped_column(String(64), default="")


@dataclass
class User:
    id: int
    username: str
    role: str
    created_at: float
    last_login: float | None
    must_change_password: bool
    is_active: bool
    token_version: int
    password_changed_at: float | None = None
    password_hash: str = field(default="", repr=False)

    @property
    def permissions(self) -> frozenset[str]:
        return permissions_for(self.role)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "username": self.username, "role": self.role, "created_at": self.created_at,
            "last_login": self.last_login, "must_change_password": self.must_change_password,
            "is_active": self.is_active, "password_changed_at": self.password_changed_at,
        }


def _user(r: UserRow) -> User:
    return User(id=r.id, username=r.username, role=r.role, created_at=r.created_at, last_login=r.last_login,
                must_change_password=bool(r.must_change_password), is_active=bool(r.is_active),
                token_version=r.token_version, password_changed_at=r.password_changed_at,
                password_hash=r.password_hash)


class UserError(Exception):
    """A request that breaks a user-management rule (maps to HTTP 400/409)."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def normalize_username(name: str) -> str:
    return (name or "").strip().lower()


class UserStore:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        AuthBase.metadata.create_all(engine)
        self._lock = threading.Lock()

    # ------------------------------------------------------------ users: read
    def count(self) -> int:
        with Session(self.engine) as s:
            return s.scalar(select(func.count(UserRow.id))) or 0

    def get(self, user_id: int) -> User | None:
        with Session(self.engine) as s:
            r = s.get(UserRow, user_id)
            return _user(r) if r else None

    def get_by_username(self, username: str) -> User | None:
        with Session(self.engine) as s:
            r = s.scalar(select(UserRow).where(UserRow.username == normalize_username(username)))
            return _user(r) if r else None

    def list(self) -> list[User]:
        with Session(self.engine) as s:
            return [_user(r) for r in s.scalars(select(UserRow).order_by(UserRow.username))]

    def _active_super_admins(self, s: Session) -> int:
        return s.scalar(select(func.count(UserRow.id)).where(UserRow.role == "super_admin", UserRow.is_active.is_(True))) or 0

    # ------------------------------------------------------------ users: write
    def create(self, username: str, password: str, role: str, *, must_change_password: bool = True) -> User:
        name = normalize_username(username)
        if not USERNAME_RE.match(name):
            raise UserError("username must be 3-32 characters: letters, digits, '.', '_' or '-' (starting with a letter or digit)")
        if role not in ROLES:
            raise UserError(f"role must be one of {', '.join(ROLES)}")
        now = time.time()
        with self._lock, Session(self.engine, expire_on_commit=False) as s:
            if s.scalar(select(UserRow.id).where(UserRow.username == name)) is not None:
                raise UserError(f"username '{name}' is already taken", 409)
            row = UserRow(username=name, password_hash=hash_password(password), role=role, created_at=now,
                          must_change_password=must_change_password, is_active=True, token_version=1)
            s.add(row)
            s.commit()
            return _user(row)

    def update(self, user_id: int, *, role: str | None = None, is_active: bool | None = None,
               acting_user_id: int | None = None) -> tuple[User, User]:
        """Change role and/or active flag. Returns (before, after). Guards against locking everyone out."""
        if role is not None and role not in ROLES:
            raise UserError(f"role must be one of {', '.join(ROLES)}")
        with self._lock, Session(self.engine, expire_on_commit=False) as s:
            r = s.get(UserRow, user_id)
            if r is None:
                raise UserError("user not found", 404)
            before = _user(r)
            if acting_user_id == user_id and ((role is not None and role != r.role) or is_active is False):
                raise UserError("you cannot change your own role or deactivate your own account")
            demotes = (role is not None and role != "super_admin") or is_active is False
            if r.role == "super_admin" and r.is_active and demotes and self._active_super_admins(s) <= 1:
                raise UserError("this is the last active Super Admin; promote someone else first")
            changed = False
            if role is not None and role != r.role:
                r.role, changed = role, True
            if is_active is not None and is_active != r.is_active:
                r.is_active, changed = is_active, True
            if changed:
                r.token_version += 1  # role / access changes apply to live sessions immediately
                if r.is_active is False:
                    self._revoke_all(s, user_id)
            s.commit()
            return before, _user(r)

    def set_password(self, user_id: int, new_password: str, *, must_change_password: bool) -> User:
        with self._lock, Session(self.engine, expire_on_commit=False) as s:
            r = s.get(UserRow, user_id)
            if r is None:
                raise UserError("user not found", 404)
            r.password_hash = hash_password(new_password)
            r.must_change_password = must_change_password
            r.password_changed_at = time.time()
            r.token_version += 1
            self._revoke_all(s, user_id)
            s.commit()
            return _user(r)

    def delete(self, user_id: int, *, acting_user_id: int | None = None) -> User:
        if acting_user_id == user_id:
            raise UserError("you cannot delete your own account")
        with self._lock, Session(self.engine) as s:
            r = s.get(UserRow, user_id)
            if r is None:
                raise UserError("user not found", 404)
            if r.role == "super_admin" and r.is_active and self._active_super_admins(s) <= 1:
                raise UserError("this is the last active Super Admin; promote someone else first")
            u = _user(r)
            s.execute(delete(RefreshTokenRow).where(RefreshTokenRow.user_id == user_id))
            s.delete(r)
            s.commit()
            return u

    def record_login(self, user_id: int, ts: float | None = None) -> None:
        with self._lock, Session(self.engine) as s:
            s.execute(update(UserRow).where(UserRow.id == user_id).values(last_login=ts or time.time()))
            s.commit()

    def seed_default(self) -> bool:
        """Create the bootstrap super_admin if (and only if) there are no users at all. Idempotent."""
        if self.count() > 0:
            return False
        try:
            self.create(SEED_USERNAME, SEED_PASSWORD, "super_admin", must_change_password=True)
        except UserError:  # another process seeded it between count() and create()
            return False
        log.warning("SECURITY: no users existed, so the default account '%s' (role super_admin) was created with "
                    "the documented seed password. It must be changed at first sign-in - rotate it now, "
                    "especially on any networked deployment.", SEED_USERNAME)
        return True

    # ------------------------------------------------------------ refresh tokens (sessions)
    def issue_refresh(self, user_id: int, *, remember: bool, ttl: float, now: float | None = None) -> tuple[str, float]:
        now = now if now is not None else time.time()
        token = new_refresh_token()
        with self._lock, Session(self.engine) as s:
            s.add(RefreshTokenRow(user_id=user_id, token_hash=hash_refresh_token(token), created_at=now,
                                  expires_at=now + ttl, remember=remember))
            # housekeeping: expired / long-revoked rows are useless
            s.execute(delete(RefreshTokenRow).where(RefreshTokenRow.expires_at < now - 86400))
            s.commit()
        return token, now + ttl

    def rotate_refresh(self, token: str, *, ttl_session: float, ttl_remember: float,
                       now: float | None = None) -> tuple[User, str | None, float, bool]:
        """Swap a refresh token for a new one. Returns (user, new token or None, expires_at, remember).

        A token that was already rotated is accepted (without issuing another one) for a few seconds -
        that's two tabs refreshing at once. Re-use after that means the token leaked: every session
        of that user is revoked.
        """
        now = now if now is not None else time.time()
        h = hash_refresh_token(token)
        with self._lock, Session(self.engine, expire_on_commit=False) as s:
            row = s.scalar(select(RefreshTokenRow).where(RefreshTokenRow.token_hash == h))
            if row is None or row.expires_at <= now:
                raise TokenError("invalid_refresh", "Your session has expired. Please sign in again.")
            u = s.get(UserRow, row.user_id)
            if u is None or not u.is_active:
                raise TokenError("invalid_refresh", "This account is no longer active.")
            if row.revoked_at is not None:
                if row.replaced_by is not None and now - row.revoked_at <= REFRESH_REUSE_GRACE:
                    return _user(u), None, row.expires_at, bool(row.remember)
                log.warning("refresh token re-use for user '%s': revoking all of their sessions", u.username)
                self._revoke_all(s, u.id)
                s.commit()
                raise TokenError("invalid_refresh", "Your session is no longer valid. Please sign in again.")
            ttl = ttl_remember if row.remember else ttl_session
            new = new_refresh_token()
            nrow = RefreshTokenRow(user_id=u.id, token_hash=hash_refresh_token(new), created_at=now,
                                   expires_at=now + ttl, remember=row.remember)
            s.add(nrow)
            s.flush()
            row.revoked_at, row.replaced_by = now, nrow.id
            s.commit()
            return _user(u), new, now + ttl, bool(row.remember)

    def revoke_refresh(self, token: str) -> int | None:
        """Revoke one session. Returns its user id (None if unknown)."""
        with self._lock, Session(self.engine) as s:
            row = s.scalar(select(RefreshTokenRow).where(RefreshTokenRow.token_hash == hash_refresh_token(token)))
            if row is None:
                return None
            if row.revoked_at is None:
                row.revoked_at = time.time()
            s.commit()
            return row.user_id

    def session_remember(self, token: str) -> bool | None:
        """The "remember me" flag of a live session (None if the token is unknown)."""
        with Session(self.engine) as s:
            return s.scalar(select(RefreshTokenRow.remember).where(RefreshTokenRow.token_hash == hash_refresh_token(token)))

    def _revoke_all(self, s: Session, user_id: int) -> None:
        s.execute(update(RefreshTokenRow).where(RefreshTokenRow.user_id == user_id, RefreshTokenRow.revoked_at.is_(None))
                  .values(revoked_at=time.time()))

    def active_sessions(self, user_id: int, now: float | None = None) -> int:
        now = now if now is not None else time.time()
        with Session(self.engine) as s:
            return s.scalar(select(func.count(RefreshTokenRow.id)).where(
                RefreshTokenRow.user_id == user_id, RefreshTokenRow.revoked_at.is_(None),
                RefreshTokenRow.expires_at > now)) or 0


# ------------------------------------------------------------------ audit log
def _dump(v: Any) -> str | None:
    return None if v is None else json.dumps(v, default=str, ensure_ascii=False)


def _audit_dict(r: AuditRow) -> dict[str, Any]:
    return {
        "id": r.id, "timestamp": r.ts, "actor_id": r.actor_id, "actor": r.actor, "actor_role": r.actor_role,
        "action": r.action, "target_type": r.target_type, "target": r.target,
        "before": json.loads(r.before) if r.before else None,
        "after": json.loads(r.after) if r.after else None,
        "detail": r.detail, "ip": r.ip,
    }


class AuditStore:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        AuthBase.metadata.create_all(engine)
        self._lock = threading.Lock()

    def record(self, action: str, *, actor: User | None = None, actor_name: str | None = None,
               target_type: str = "", target: str = "", before: Any = None, after: Any = None,
               detail: str = "", ip: str = "") -> None:
        """Never raises: a failing audit write is logged, the action itself has already happened."""
        try:
            row = AuditRow(ts=time.time(), actor_id=actor.id if actor else None,
                           actor=actor.username if actor else (actor_name or "anonymous"),
                           actor_role=actor.role if actor else "", action=action, target_type=target_type,
                           target=str(target)[:128], before=_dump(before), after=_dump(after),
                           detail=detail[:2000], ip=ip[:64])
            with self._lock, Session(self.engine) as s:
                s.add(row)
                s.commit()
        except Exception:
            log.exception("could not write audit entry %s", action)

    def list(self, *, action: str | None = None, actor: str | None = None, start: float | None = None,
             end: float | None = None, before_id: int | None = None, limit: int = 50) -> dict[str, Any]:
        limit = max(1, min(limit, 200))

        def where(stmt):  # noqa: ANN001, ANN202
            if action:  # "config." = the whole group, "config.update" = exactly that action
                stmt = stmt.where(AuditRow.action.like(f"{action}%") if action.endswith(".") else AuditRow.action == action)
            if actor:
                stmt = stmt.where(AuditRow.actor == normalize_username(actor))
            if start is not None:
                stmt = stmt.where(AuditRow.ts >= start)
            if end is not None:
                stmt = stmt.where(AuditRow.ts < end)
            return stmt

        with Session(self.engine) as s:
            total = s.scalar(where(select(func.count(AuditRow.id)))) or 0
            stmt = where(select(AuditRow))
            if before_id is not None:
                stmt = stmt.where(AuditRow.id < before_id)
            rows = list(s.scalars(stmt.order_by(AuditRow.id.desc()).limit(limit + 1)))
            items = [_audit_dict(r) for r in rows[:limit]]
        return {"items": items, "total": total, "next_before_id": items[-1]["id"] if len(rows) > limit else None}

    def actions(self) -> list[str]:
        with Session(self.engine) as s:
            return sorted(s.scalars(select(AuditRow.action).distinct()))
