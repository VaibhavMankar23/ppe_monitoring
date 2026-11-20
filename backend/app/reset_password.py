"""Operator recovery: set a new password for an existing user WITHOUT deleting any users or data.

    docker compose exec ppe-monitor python -m app.reset_password                  # resets "admin", asks for the password
    docker compose exec ppe-monitor python -m app.reset_password --user asha      # another user
    docker compose exec ppe-monitor python -m app.reset_password --generate       # print a random one-time password

The password policy applies. The user must change it at the next sign-in, every open session is signed out,
the account is re-activated and unlocked, and the action is written to the audit trail (actor "cli").
Whoever can run this has shell access to the server and the database file, so it needs no extra login.
"""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
import sys

from .security import password_problems
from .users_db import AuditStore, UserError, UserStore, normalize_username
from .violations_db import ViolationStore


def reset_password(db_path: str, username: str, password: str, *, must_change: bool = True) -> str:
    """Returns the normalized username. Raises UserError (unknown user, policy problems)."""
    username = normalize_username(username)
    store = ViolationStore(db_path)
    users, audit = UserStore(store.engine), AuditStore(store.engine)
    user = users.get_by_username(username)
    if user is None:
        raise UserError(f"no user named '{username}'. Existing users: {', '.join(u.username for u in users.list()) or 'none'}", 404)
    problems = password_problems(password, username=user.username)
    if problems:
        raise UserError("password " + "; ".join(problems))
    if not user.is_active:
        users.update(user.id, is_active=True)
    users.set_password(user.id, password, must_change_password=must_change)
    audit.record("user.password_reset", actor_name="cli", target_type="user", target=user.username,
                 detail="reset from the server command line (app.reset_password)")
    return user.username


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Reset a user's password without losing any data")
    p.add_argument("--user", default="admin", help="username (default: admin)")
    p.add_argument("--password", help="new password (omit to be asked; avoid: it stays in shell history)")
    p.add_argument("--generate", action="store_true", help="generate a random one-time password and print it")
    p.add_argument("--db", default=os.environ.get("PPE_DB_PATH", "data/violations.db"), help="database file")
    p.add_argument("--keep", action="store_true", help="do not force a password change at next sign-in")
    a = p.parse_args(argv)

    if a.generate:
        password = secrets.token_urlsafe(12) + "1a"
    elif a.password:
        password = a.password
    else:
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Repeat it: "):
            print("The two entries differ.", file=sys.stderr)
            return 1
    try:
        name = reset_password(a.db, a.user, password, must_change=not a.keep)
    except UserError as e:
        print(f"Not changed: {e}", file=sys.stderr)
        return 1
    print(f"Password for '{name}' reset. All of their sessions were signed out.")
    if a.generate:
        print(f"One-time password: {password}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
