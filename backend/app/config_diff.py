"""Field-level diff of two raw config mappings, and the Admin (per-camera) edit policy.

Streams are keyed by their id rather than list position, so reordering or removing one
camera doesn't show up as "every later camera changed":

    streams.cam2.source.uri: "a.mp4" -> "b.mp4"
"""

from __future__ import annotations

import json
import re
from typing import Any

MISSING = "<unset>"

# What an Admin may change: these keys of an *existing* camera, nothing else.
ADMIN_STREAM_KEYS = ("name", "enabled", "required_ppe", "confidence", "priority", "source")
_ADMIN_PATH = re.compile(r"^streams\.[^.]+\.(" + "|".join(ADMIN_STREAM_KEYS) + r")(\..+)?$")


def flatten(cfg: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(cfg, dict):
        for k, v in cfg.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            if k == "streams" and not prefix and isinstance(v, list):
                for i, s in enumerate(v):
                    sid = s.get("id") if isinstance(s, dict) else None
                    out.update(flatten(s, f"streams.{sid if sid not in (None, '') else f'#{i}'}"))
                if not v:
                    out["streams"] = []
            elif isinstance(v, dict) and v:
                out.update(flatten(v, key))
            else:
                out[key] = v
    else:
        out[prefix or "config"] = cfg
    return out


def diff(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """{path: {"before": x, "after": y}} for every leaf that differs (MISSING when absent)."""
    a, b = flatten(before or {}), flatten(after or {})
    out: dict[str, dict[str, Any]] = {}
    for k in sorted(set(a) | set(b)):
        va, vb = a.get(k, MISSING), b.get(k, MISSING)
        if json.dumps(va, sort_keys=True, default=str) != json.dumps(vb, sort_keys=True, default=str):
            out[k] = {"before": va, "after": vb}
    return out


def _stream_ids(cfg: dict[str, Any] | None) -> list[str]:
    return [s.get("id") for s in (cfg or {}).get("streams") or [] if isinstance(s, dict)]


def admin_denied_changes(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Paths an Admin is not allowed to change in this edit (empty = allowed)."""
    denied: list[str] = []
    if _stream_ids(before) != _stream_ids(after):
        denied.append("streams (adding, removing or reordering cameras)")
    for path in diff(before, after):
        if not _ADMIN_PATH.match(path) and path != "streams":
            denied.append(path)
    return denied


def _redact(path: str, value: Any) -> Any:
    if path.endswith(".password"):
        return MISSING if value == MISSING else "(set)" if value else ""
    return value


def split_diff(changes: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Audit-log shape: ({path: before}, {path: after}); secrets appear only as "(set)"
    (a changed password therefore shows "(set)" -> "(set)": it changed, without saying to what)."""
    return ({k: _redact(k, v["before"]) for k, v in changes.items()},
            {k: _redact(k, v["after"]) for k, v in changes.items()})


def camera_changes(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, list[dict[str, Any]]]:
    """Per-camera summary of a config change, for the save confirmation and the removal guard:
    {"removed": [{id, name}], "added": [{id, name}], "changed": [{id, name, fields: ["source.uri", ...]}]}."""
    def by_id(cfg: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        return {s["id"]: s for s in (cfg or {}).get("streams") or [] if isinstance(s, dict) and s.get("id")}

    b, a = by_id(before), by_id(after)
    changes = diff({"streams": list(b.values())}, {"streams": list(a.values())})
    changed: dict[str, list[str]] = {}
    for path in changes:
        parts = path.split(".", 2)
        if len(parts) == 3 and parts[1] in b and parts[1] in a:
            changed.setdefault(parts[1], []).append(parts[2])
    name = lambda s: s.get("name") or s["id"]  # noqa: E731
    return {
        "removed": [{"id": i, "name": name(s)} for i, s in b.items() if i not in a],
        "added": [{"id": i, "name": name(s)} for i, s in a.items() if i not in b],
        "changed": [{"id": i, "name": name(a[i]), "fields": sorted(f)} for i, f in changed.items()],
    }
