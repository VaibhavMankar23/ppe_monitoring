"""Encryption of camera credentials at rest (config.yaml) with Fernet (AES-128-CBC + HMAC-SHA256).

Stored form: ``password: enc:gAAAAA...``. Plaintext passwords only exist in memory while a source
is being opened; the API never returns them (``MASK`` stands in for "unchanged").

Key: ``PPE_SECRET_KEY`` (any string; hashed to a Fernet key) or, if unset, derived from
``PPE_JWT_SECRET``. Set PPE_SECRET_KEY explicitly if you ever rotate the JWT secret, otherwise
stored camera passwords can no longer be decrypted and must be re-entered.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import re

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger(__name__)

PREFIX = "enc:"
MASK = "********"  # what the UI sees / sends back for "keep the stored password"


class SecretError(Exception):
    pass


def _fernet() -> Fernet:
    raw = os.environ.get("PPE_SECRET_KEY") or os.environ.get("PPE_JWT_SECRET") or ""
    if not raw:
        raise SecretError("set PPE_SECRET_KEY (or PPE_JWT_SECRET) to store camera passwords")
    key = base64.urlsafe_b64encode(hashlib.sha256(b"ppe-camera-credentials\0" + raw.encode()).digest())
    return Fernet(key)


def is_encrypted(value: str | None) -> bool:
    return bool(value) and str(value).startswith(PREFIX)


def encrypt(plain: str) -> str:
    if not plain or is_encrypted(plain):
        return plain
    return PREFIX + _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(value: str | None) -> str:
    """Plaintext of a stored secret ("" for none). Plain (legacy) values pass through unchanged."""
    if not value:
        return ""
    if not is_encrypted(value):
        return value
    try:
        return _fernet().decrypt(value[len(PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as e:
        raise SecretError("stored camera password can't be decrypted (was the secret key changed?)") from e


_URI_CREDS = re.compile(r"^(?P<scheme>[a-zA-Z][a-zA-Z0-9+.-]*://)(?P<user>[^:@/]*)(?::(?P<pw>[^@/]*))?@(?P<rest>.+)$")


def split_uri_credentials(uri: str) -> tuple[str, str | None, str | None]:
    """rtsp://user:pass@host/x -> ("rtsp://host/x", "user", "pass"); URIs without credentials unchanged."""
    m = _URI_CREDS.match(uri or "")
    if not m:
        return uri, None, None
    from urllib.parse import unquote

    return m["scheme"] + m["rest"], unquote(m["user"]) or None, unquote(m["pw"]) if m["pw"] is not None else None


def with_uri_credentials(uri: str, username: str, password: str) -> str:
    """Insert (URL-quoted) credentials into a network URI: used only at open time, never stored."""
    if not username:
        return uri
    from urllib.parse import quote

    base, _, _ = split_uri_credentials(uri)
    scheme, sep, rest = base.partition("://")
    if not sep:
        return uri
    auth = quote(username, safe="") + (":" + quote(password, safe="") if password else "")
    return f"{scheme}://{auth}@{rest}"


def mask_uri(uri: str) -> str:
    base, user, _ = split_uri_credentials(uri)
    if user is None:
        return uri
    scheme, _, rest = base.partition("://")
    return f"{scheme}://***@{rest}"
