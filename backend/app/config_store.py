"""Read / validate / atomically save config.yaml, with timestamped backups.

Every save:
  1. validates the new document (YAML syntax + pydantic) and returns field-level errors;
  2. copies the current file to ``config.backup.<timestamp>.yaml`` (newest ``keep`` are kept);
  3. writes the new text to a temp file in the same directory, fsyncs it, then
     ``os.replace``-s it over config.yaml - an atomic rename, so a crash mid-write can
     never leave a half-written config behind.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from .config import AppConfig, parse_config
from .secret_box import MASK, SecretError, encrypt, is_encrypted, split_uri_credentials

log = logging.getLogger(__name__)

BACKUP_RE = re.compile(r"^config\.backup\.(\d{8}-\d{6}-\d{6})\.yaml$")
HEADER = (
    "# PPE compliance monitor configuration - saved from the Config page.\n"
    "# Relative paths resolve against this file's directory; strings may use ${VAR:-default}.\n"
    "# (Comments are only preserved when saving from the Raw YAML view.)\n\n"
)


@dataclass
class FieldError:
    loc: str  # dotted path, e.g. "streams.1.source.uri" ("yaml" for syntax errors)
    msg: str
    line: int | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"loc": self.loc, "msg": self.msg}
        if self.line is not None:
            d["line"] = self.line
        return d


class ConfigInvalid(Exception):
    def __init__(self, errors: list[FieldError]) -> None:
        super().__init__("; ".join(f"{e.loc}: {e.msg}" for e in errors))
        self.errors = errors


class ConfigConflict(Exception):
    """The file changed on disk since the client loaded it."""


def etag_of(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _line_of(text: str, loc: str) -> int | None:
    """1-based line of the YAML node at a dotted path like 'streams.1.source.uri' (best effort)."""
    try:
        node = yaml.compose(text)
    except yaml.YAMLError:
        return None
    line = None
    for part in loc.split("."):
        if isinstance(node, yaml.MappingNode):
            nxt = next(((k, v) for k, v in node.value if getattr(k, "value", None) == part), None)
            if nxt is None:
                break
            line, node = nxt[0].start_mark.line + 1, nxt[1]
        elif isinstance(node, yaml.SequenceNode) and part.isdigit() and int(part) < len(node.value):
            node = node.value[int(part)]
            line = node.start_mark.line + 1
        else:
            break
    return line


def secure_sources(raw: dict[str, Any], current: dict[str, Any] | None) -> dict[str, Any]:
    """Camera credentials never reach the file in plain text.

    * ``rtsp://user:pass@host`` in a URI is moved into ``source.username`` / ``source.password``;
    * a plain password is encrypted (``enc:...``);
    * ``MASK`` (what the UI shows for a stored password) means "unchanged": the stored value is kept.
    Returns a new mapping; `raw` is not modified.
    """
    import copy

    out = copy.deepcopy(raw)
    stored = {s.get("id"): (s.get("source") or {}) for s in (current or {}).get("streams") or [] if isinstance(s, dict)}
    for s in out.get("streams") or []:
        src = s.get("source") if isinstance(s, dict) else None
        if not isinstance(src, dict):
            continue
        uri = src.get("uri")
        if isinstance(uri, str) and "@" in uri and "://" in uri:
            base, user, pw = split_uri_credentials(uri)
            if user is not None:
                src["uri"] = base
                src.setdefault("username", user)
                if pw is not None and not src.get("password"):
                    src["password"] = pw
        pw = src.get("password")
        if pw == MASK:
            old = stored.get(s.get("id"), {}).get("password")
            if old:
                src["password"] = old
            else:
                src.pop("password", None)
        elif isinstance(pw, str) and pw and not is_encrypted(pw):
            try:
                src["password"] = encrypt(pw)
            except SecretError as e:
                raise ConfigInvalid([FieldError(f"streams.{s.get('id')}.source.password", str(e))]) from e
    return out


def mask_sources(raw: dict[str, Any]) -> dict[str, Any]:
    """Copy for the UI: stored passwords replaced by MASK."""
    import copy

    out = copy.deepcopy(raw)
    for s in out.get("streams") or []:
        src = s.get("source") if isinstance(s, dict) else None
        if isinstance(src, dict) and src.get("password"):
            src["password"] = MASK
    return out


def _pydantic_errors(e: ValidationError) -> list[FieldError]:
    out = []
    for err in e.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "config"
        msg = err["msg"].removeprefix("Value error, ")
        out.append(FieldError(loc, msg))
    return out


class ConfigStore:
    def __init__(self, path: str | os.PathLike[str], default_path: str | os.PathLike[str] | None = None, keep: int = 10) -> None:
        self.path = Path(path).resolve()
        self.default_path = Path(default_path).resolve() if default_path else self.path.with_name("config.default.yaml")
        self.keep = keep
        self._lock = threading.Lock()

    # ------------------------------------------------------------ read
    def read_text(self) -> str:
        return self.path.read_text(encoding="utf-8")

    def read(self) -> dict[str, Any]:
        """For the UI: passwords masked in the form view (the YAML text only ever holds ciphertext)."""
        text = self.read_text()
        return {"config": mask_sources(yaml.safe_load(text) or {}), "yaml": text, "etag": etag_of(text), "path": str(self.path)}

    def read_raw(self) -> dict[str, Any]:
        try:
            return yaml.safe_load(self.read_text()) or {}
        except (OSError, yaml.YAMLError):
            return {}

    # ------------------------------------------------------------ validate
    def parse_yaml(self, text: str) -> dict[str, Any]:
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as e:
            mark = getattr(e, "problem_mark", None)
            line = mark.line + 1 if mark is not None else None
            problem = getattr(e, "problem", None) or str(e)
            raise ConfigInvalid([FieldError("yaml", f"YAML syntax error: {problem}", line)]) from e
        if not isinstance(data, dict):
            raise ConfigInvalid([FieldError("yaml", "top level must be a mapping (key: value)")])
        return data

    def validate(self, raw: dict[str, Any]) -> AppConfig:
        try:
            return parse_config(raw, self.path.parent)
        except ValidationError as e:
            raise ConfigInvalid(_pydantic_errors(e)) from e

    def validate_any(self, *, config: dict[str, Any] | None = None, yaml_text: str | None = None) -> tuple[dict[str, Any], str, AppConfig]:
        """Validate a form object or raw YAML; returns (raw dict, text to write, parsed config)."""
        if yaml_text is not None:
            parsed = self.parse_yaml(yaml_text)
            raw = secure_sources(parsed, self.read_raw())
            if raw != parsed:  # a credential had to be encrypted / moved: re-serialise (comments are lost)
                yaml_text = HEADER + yaml.safe_dump(raw, sort_keys=False, allow_unicode=True, default_flow_style=False, width=120)
            text = yaml_text if yaml_text.endswith("\n") else yaml_text + "\n"
            try:
                return raw, text, self.validate(raw)
            except ConfigInvalid as e:  # point the raw editor at the offending lines
                for err in e.errors:
                    err.line = err.line or _line_of(yaml_text, err.loc)
                raise
        elif config is not None:
            raw = secure_sources(config, self.read_raw())
            text = HEADER + yaml.safe_dump(raw, sort_keys=False, allow_unicode=True, default_flow_style=False, width=120)
        else:
            raise ConfigInvalid([FieldError("config", "send either 'config' or 'yaml'")])
        return raw, text, self.validate(raw)

    # ------------------------------------------------------------ write
    def save(self, *, config: dict[str, Any] | None = None, yaml_text: str | None = None, etag: str | None = None) -> AppConfig:
        _, text, parsed = self.validate_any(config=config, yaml_text=yaml_text)
        with self._lock:
            if etag and self.path.exists() and etag_of(self.read_text()) != etag:
                raise ConfigConflict("config.yaml was changed by someone else - reload and try again")
            self._backup()
            self._atomic_write(text)
        log.info("config saved to %s", self.path)
        return parsed

    def reset_plan(self, keep_cameras: bool = True) -> dict[str, Any] | str:
        """What "Reset to defaults" would write. Cameras are site configuration, not a "setting": by
        default they are kept (the shipped defaults have none) and only everything else is reset.
        Returns the config mapping, or the defaults' YAML text (comments kept) when cameras go too."""
        text = self.default_path.read_text(encoding="utf-8")
        if not keep_cameras:
            return text
        raw = self.parse_yaml(text)
        raw["streams"] = self.read_raw().get("streams") or []
        return raw

    def reset(self, keep_cameras: bool = True) -> AppConfig:
        plan = self.reset_plan(keep_cameras)
        return self.save(yaml_text=plan) if isinstance(plan, str) else self.save(config=plan)

    def backup_text(self, name: str) -> str:
        if not BACKUP_RE.match(name):  # also blocks path traversal
            raise ConfigInvalid([FieldError("name", "not a backup file name")])
        src = self.path.parent / name
        if not src.is_file():
            raise FileNotFoundError(name)
        return src.read_text(encoding="utf-8")

    def restore(self, name: str) -> AppConfig:
        return self.save(yaml_text=self.backup_text(name))

    def backups(self) -> list[dict[str, Any]]:
        out = []
        for p in self.path.parent.iterdir():
            m = BACKUP_RE.match(p.name)
            if m:
                st = p.stat()
                out.append({"name": p.name, "created": st.st_mtime, "size": st.st_size})
        return sorted(out, key=lambda b: b["name"], reverse=True)

    def _backup(self) -> None:
        if not self.path.exists():
            return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        dst = self.path.parent / f"config.backup.{stamp}.yaml"
        dst.write_bytes(self.path.read_bytes())
        for old in self.backups()[self.keep:]:
            try:
                (self.path.parent / old["name"]).unlink()
            except OSError:
                log.warning("could not delete old backup %s", old["name"])

    def _atomic_write(self, text: str) -> None:
        fd, tmp = tempfile.mkstemp(prefix=".config.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)  # atomic on POSIX and Windows (same volume)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
