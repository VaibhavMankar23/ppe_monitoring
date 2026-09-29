"""Routes for adding cameras and watching capacity.

    POST /api/sources/test     try a source (file / rtsp / http / webcam / images) before saving it
    GET  /api/sources/files    video files already on the server (for "use a file on the server")
    POST /api/sources/upload   upload a video file into the videos folder (Super Admin)
    POST /api/focus            focus mode lease: {"stream_id": "cam3"} or {"stream_id": null}
    GET  /api/system/health    per-camera FPS / drops / reconnects, engine load, host CPU / memory
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, ValidationError

from .auth import ApiError, client_ip, ctx, require
from .config import SourceConfig, expand_env
from .secret_box import MASK
from .sources import IMAGE_EXTS, VIDEO_EXTS, probe
from .users_db import User

log = logging.getLogger(__name__)

MAX_UPLOAD_MB = int(os.environ.get("PPE_MAX_UPLOAD_MB", "8192"))
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class TestBody(BaseModel):
    source: dict[str, Any]
    stream_id: str | None = None  # to reuse the stored (encrypted) password when the UI sends MASK


class FocusBody(BaseModel):
    stream_id: str | None = None


def videos_dir(request: Request) -> Path:
    env = os.environ.get("PPE_VIDEOS_DIR")
    if env:
        return Path(env).resolve()
    return (request.app.state.config_store.path.parent / ".." / "videos").resolve()


def _uri_for(name: str) -> str:
    """Config value for a file in the videos folder, in the same style as the shipped config."""
    return "${PPE_VIDEOS_DIR:-../videos}/" + name


def _resolve_source(request: Request, raw: dict[str, Any], stream_id: str | None) -> SourceConfig:
    raw = dict(raw)
    if raw.get("password") == MASK:
        stored = next((s.get("source", {}) for s in request.app.state.config_store.read_raw().get("streams", [])
                       if isinstance(s, dict) and s.get("id") == stream_id), {})
        raw["password"] = stored.get("password", "")
    try:
        src = SourceConfig.model_validate(expand_env(raw))
    except ValidationError as e:
        raise ApiError(422, "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()), "invalid_source") from e
    if src.type in ("file", "images") and not os.path.isabs(src.uri):
        src.uri = str((request.app.state.config_store.path.parent / src.uri).resolve())
    return src


def build_router() -> APIRouter:
    r = APIRouter()

    @r.post("/api/sources/test")
    async def test_source(body: TestBody, request: Request, user: User = Depends(require("config:cameras"))) -> dict[str, Any]:
        src = _resolve_source(request, body.source, body.stream_id)
        width = request.app.state.monitor.cfg.inference.process_width
        result = await asyncio.to_thread(probe, src, width)
        log.info("connection test by %s: %s %s -> %s", user.username, src.type, result["source"],
                 "ok" if result["ok"] else result.get("message"))
        return result

    @r.get("/api/sources/files")
    def list_files(request: Request, _: User = Depends(require("config:cameras"))) -> dict[str, Any]:
        root = videos_dir(request)
        files: list[dict[str, Any]] = []
        folders: list[dict[str, Any]] = []
        if root.is_dir():
            for p in sorted(root.iterdir()):
                if p.is_file() and p.suffix.lower() in VIDEO_EXTS:
                    st = p.stat()
                    files.append({"name": p.name, "size": st.st_size, "modified": st.st_mtime, "uri": _uri_for(p.name)})
                elif p.is_dir() and any(c.suffix.lower() in IMAGE_EXTS for c in p.iterdir() if c.is_file()):
                    folders.append({"name": p.name + "/", "uri": _uri_for(p.name), "type": "images"})
        return {"dir": str(root), "files": files, "image_folders": folders,
                "extensions": sorted(VIDEO_EXTS), "max_upload_mb": MAX_UPLOAD_MB}

    @r.post("/api/sources/upload", status_code=201)
    async def upload(request: Request, file: UploadFile = File(...), overwrite: bool = Query(False),
                     user: User = Depends(require("config:system"))) -> dict[str, Any]:
        name = _SAFE_NAME.sub("_", Path(file.filename or "").name).strip("._")
        ext = Path(name).suffix.lower()
        if not name or ext not in VIDEO_EXTS:
            raise ApiError(415, f"Not a supported video file. Allowed: {', '.join(sorted(VIDEO_EXTS))}", "bad_file_type")
        root = videos_dir(request)
        root.mkdir(parents=True, exist_ok=True)
        dest = root / name
        if dest.exists() and not overwrite:
            # same file already on the server (e.g. a clip from videos/): reuse it instead of refusing
            if file.size is None or file.size == dest.stat().st_size:
                log.info("upload by %s: %s already on the server, reusing it", user.username, name)
                return {"name": name, "size": dest.stat().st_size, "uri": _uri_for(name), "reused": True}
            # different file with the same name: store it next to the old one as name_2.ext, name_3.ext, ...
            stem, n = dest.stem, 2
            while (root / f"{stem}_{n}{ext}").exists():
                n += 1
            name = f"{stem}_{n}{ext}"
            dest = root / name
        tmp = dest.with_name(f".{name}.{int(time.time())}.part")
        size, limit = 0, MAX_UPLOAD_MB * 2**20
        try:
            with open(tmp, "wb") as f:
                while chunk := await file.read(4 * 2**20):
                    size += len(chunk)
                    if size > limit:
                        raise ApiError(413, f"File is larger than {MAX_UPLOAD_MB} MB.", "too_large")
                    f.write(chunk)
            os.replace(tmp, dest)
        except OSError as e:  # read-only mount, permissions, disk full: say so instead of a bare 500
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            log.warning("upload by %s failed: cannot write %s: %s", user.username, root, e)
            raise ApiError(507 if e.errno == errno.ENOSPC else 500,
                           f"The server couldn't save the file in its videos folder ({e.strerror or e}). "
                           "Check that the folder is writable (in Docker: not mounted read-only) and has free space.",
                           "storage_error") from e
        except BaseException:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            raise
        ctx(request).audit.record("source.upload", actor=user, target_type="file", target=name,
                                  after={"size": size}, ip=client_ip(request))
        log.info("video uploaded by %s: %s (%.1f MB)", user.username, name, size / 2**20)
        return {"name": name, "size": size, "uri": _uri_for(name)}

    @r.post("/api/focus")
    def focus(body: FocusBody, request: Request, _: User = Depends(require("monitor:view"))) -> dict[str, Any]:
        try:
            return request.app.state.monitor.set_focus(body.stream_id)
        except KeyError as e:
            raise HTTPException(404, f"unknown stream {body.stream_id}") from e

    @r.get("/api/system/health")
    def health(request: Request, _: User = Depends(require("monitor:view"))) -> dict[str, Any]:
        return request.app.state.monitor.health()

    return r
