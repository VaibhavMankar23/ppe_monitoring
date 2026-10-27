"""FastAPI app: REST control, config editing, violations history, MJPEG video, WebSocket feed.

Every /api route except /api/health and the sign-in endpoints requires a signed-in user with
the route's permission (see security.ROLE_PERMISSIONS); tests/test_auth.py walks the route
table to keep it that way.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import yaml
from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analytics, auth_routes, sources_routes
from .alarms import AlarmDispatcher
from .auth import ApiError, AuthContext, api_error_handler, check_permission, client_ip, require, user_from_token
from .config import AppConfig, default_config_path, load_config
from .config_diff import ADMIN_STREAM_KEYS, admin_denied_changes, camera_changes, diff, split_diff
from .config_store import ConfigConflict, ConfigInvalid, ConfigStore
from .pipeline import Monitor, StreamWorker
from .ppe_logic import BEHAVIOR_ITEMS, PPE_ITEMS, VIOLATION_ITEMS, ZONE_ITEMS
from .security import AuthSettings, decode_access_token
from .users_db import AuditStore, User, UserStore
from .violations_db import REVIEW_REASONS, REVIEW_VERDICTS, ViolationFilter

log = logging.getLogger(__name__)

STATS_INTERVAL = 0.25  # s between metadata pushes
RETENTION_INTERVAL = 3600.0  # s between retention sweeps


class StreamSettings(BaseModel):
    confidence: float | None = Field(default=None, ge=0.05, le=0.95)
    show_boxes: bool | None = None


class ReviewBody(BaseModel):
    verdict: str | None = None  # valid | false_alarm | null (clear the review)
    reason: str | None = None  # required for false_alarm: a key of REVIEW_REASONS
    note: str = Field("", max_length=280)


class ConfigPayload(BaseModel):
    config: dict[str, Any] | None = None  # form view: the raw (un-expanded) config mapping
    yaml: str | None = None  # raw YAML view: the full file text
    etag: str | None = None  # optimistic concurrency: the etag returned by GET /api/config
    # ids of the cameras this save removes, as confirmed by the user (see _removal_guard)
    confirm_remove: list[str] | None = None


class RestorePayload(BaseModel):
    name: str
    confirm_remove: list[str] | None = None


class ResetPayload(BaseModel):
    keep_cameras: bool = True  # reset every setting but keep the cameras (default)
    confirm_remove: list[str] | None = None


_TOKEN_IN_URL = re.compile(r"(access_token=)[^&\s\"']+")


class RedactTokens(logging.Filter):
    """Mask `?access_token=` (WebSocket / MJPEG URLs) in uvicorn's log lines: a valid token must not sit in logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args and any(isinstance(a, str) and "access_token=" in a for a in record.args):
            record.args = tuple(_TOKEN_IN_URL.sub(r"\1***", a) if isinstance(a, str) else a for a in record.args)
        elif isinstance(record.msg, str) and "access_token=" in record.msg:
            record.msg = _TOKEN_IN_URL.sub(r"\1***", record.msg)
        return True


def install_log_redaction() -> None:
    for name in ("uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        if not any(isinstance(f, RedactTokens) for f in lg.filters):
            lg.addFilter(RedactTokens())


WS_TOKEN_EXPIRED = 4401  # close code: the handshake's access token expired / is invalid - refresh, reconnect
WS_FORBIDDEN = 4403
REVALIDATE_TICKS = 20  # stats ticks (x STATS_INTERVAL = 5 s) between WebSocket session re-checks


class Hub:
    """Fan-out of JSON messages to all connected WebSocket clients (sent concurrently).

    Each client is remembered with the token it connected with. Connections are closed when
    that token expires, and (checked every few seconds) as soon as the session is revoked -
    password change / reset, role change, deactivation - so nobody keeps watching after that.
    """

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.expires: dict[WebSocket, float] = {}
        self.tokens: dict[WebSocket, str] = {}
        self.locks: dict[WebSocket, asyncio.Lock] = {}  # one sender at a time per socket (text + video)

    def forget(self, ws: WebSocket) -> None:
        self.clients.discard(ws)
        self.expires.pop(ws, None)
        self.tokens.pop(ws, None)
        self.locks.pop(ws, None)

    async def send(self, ws: WebSocket, data: str | bytes, timeout: float = 2.0) -> None:
        lock = self.locks.setdefault(ws, asyncio.Lock())
        async with lock:
            if isinstance(data, bytes):
                await asyncio.wait_for(ws.send_bytes(data), timeout)
            else:
                await asyncio.wait_for(ws.send_text(data), timeout)

    async def _close(self, ws: WebSocket, reason: str) -> None:
        self.forget(ws)
        try:
            await ws.close(code=WS_TOKEN_EXPIRED, reason=reason)
        except Exception:
            pass

    async def close_expired(self, now: float) -> None:
        for ws in [w for w, exp in self.expires.items() if exp <= now]:
            await self._close(ws, "token expired")

    async def close_revoked(self, still_valid: Callable[[str], bool]) -> None:
        for ws, token in list(self.tokens.items()):
            if not still_valid(token):
                await self._close(ws, "session revoked")

    async def send_all(self, msg: dict[str, Any]) -> None:
        if not self.clients:
            return
        data = json.dumps(msg)
        clients = list(self.clients)
        results = await asyncio.gather(*(self.send(ws, data) for ws in clients), return_exceptions=True)
        for ws, r in zip(clients, results):
            if isinstance(r, Exception):
                self.forget(ws)


def _invalid(e: ConfigInvalid) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": "invalid configuration", "errors": [x.to_dict() for x in e.errors]})


def create_app(cfg: AppConfig | None = None, monitor: Monitor | None = None, config_path: str | Path | None = None,
               auth_settings: AuthSettings | None = None) -> FastAPI:
    cfg_path = Path(config_path).resolve() if config_path else default_config_path()
    cfg = cfg or load_config(cfg_path)
    monitor = monitor or Monitor(cfg)
    store = monitor.store
    cfg_store = ConfigStore(cfg_path)
    hub = Hub()

    import base64 as _b64mod

    def _alarm_image(vid: int) -> bytes:
        d = store.get(vid, image=True)
        return _b64mod.b64decode(d.get("image", "") or "") if d else b""

    # reads alarm settings live from the monitor, so a hot config reload takes effect immediately
    alarms = AlarmDispatcher(lambda: monitor.cfg.alarm, image_getter=_alarm_image)

    # users / sessions / audit share the violations database (one persistent volume)
    users = UserStore(store.engine)
    audit = AuditStore(store.engine)
    auth = AuthContext(auth_settings or AuthSettings.from_env(), users, audit)
    if users.seed_default():
        audit.record("user.seed", actor_name="system", target_type="user", target="admin",
                     after={"role": "super_admin", "must_change_password": True},
                     detail="default account created on first start")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        install_log_redaction()  # here: uvicorn has configured its loggers by now
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(monitor.start)

        def on_violation(v: dict[str, Any]) -> None:  # called from worker threads
            asyncio.run_coroutine_threadsafe(hub.send_all({"type": "violation", "violation": v}), loop)

        store.subscribe(on_violation)

        def on_violation_update(u: dict[str, Any]) -> None:  # an ongoing violation event was extended / ended
            asyncio.run_coroutine_threadsafe(hub.send_all({"type": "violation_update", "violation": u}), loop)

        store.subscribe_updates(on_violation_update)
        store.subscribe(alarms.on_violation)  # webhook / email alarms (rate-limited per camera)

        def session_valid(token: str) -> bool:
            try:
                user_from_token(auth, token)
                return True
            except ApiError:
                return False

        async def stats_loop() -> None:
            tick = 0
            while True:
                tick += 1
                try:
                    await hub.close_expired(time.time())
                    if tick % REVALIDATE_TICKS == 0:
                        await hub.close_revoked(session_valid)
                    await hub.send_all({"type": "stats", **monitor.snapshot()})
                except Exception:
                    log.exception("stats push failed")
                await asyncio.sleep(STATS_INTERVAL)

        async def retention_loop() -> None:
            while True:
                try:
                    await asyncio.to_thread(_retention, monitor.cfg)
                except Exception:
                    log.exception("retention cleanup failed")
                await asyncio.sleep(RETENTION_INTERVAL)

        tasks = [asyncio.create_task(stats_loop()), asyncio.create_task(retention_loop())]
        log.info("ready: http://%s:%d", cfg.server.host, cfg.server.port)
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            for ws in list(hub.clients):
                await ws.close()
            await asyncio.to_thread(monitor.stop)
            alarms.close()
            store.close()

    app = FastAPI(title="PPE Compliance Monitor", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=cfg.server.cors_origins, allow_methods=["*"], allow_headers=["*"])
    app.add_exception_handler(ApiError, api_error_handler)  # type: ignore[arg-type]
    app.state.monitor = monitor
    app.state.config_store = cfg_store
    app.state.auth = auth
    app.include_router(auth_routes.build_router())
    app.include_router(analytics.build_router())
    app.include_router(sources_routes.build_router())

    view = [Depends(require("monitor:view"))]
    control = require("streams:control")

    def worker(stream_id: str) -> StreamWorker:
        w = monitor.get(stream_id)
        if w is None:
            raise HTTPException(404, f"unknown stream {stream_id}")
        return w

    # ------------------------------------------------------------ status / streams
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "device": monitor.device, "streams": len(monitor.workers)}

    @app.get("/api/status", dependencies=view)
    def status() -> dict[str, Any]:
        return monitor.snapshot()

    @app.get("/api/streams", dependencies=view)
    def streams() -> list[dict[str, Any]]:
        return [w.snapshot() for w in list(monitor.workers.values())]

    @app.get("/api/streams/{stream_id}", dependencies=view)
    def stream(stream_id: str) -> dict[str, Any]:
        return worker(stream_id).snapshot()

    @app.post("/api/streams/{stream_id}/start")
    async def start(stream_id: str, request: Request, user: User = Depends(control)) -> dict[str, Any]:
        w = worker(stream_id)
        await asyncio.to_thread(w.start)
        audit.record("stream.start", actor=user, target_type="camera", target=stream_id, ip=client_ip(request))
        return w.snapshot()

    @app.post("/api/streams/{stream_id}/stop")
    async def stop(stream_id: str, request: Request, user: User = Depends(control)) -> dict[str, Any]:
        w = worker(stream_id)
        await asyncio.to_thread(w.stop)
        audit.record("stream.stop", actor=user, target_type="camera", target=stream_id, ip=client_ip(request))
        return w.snapshot()

    @app.patch("/api/streams/{stream_id}/settings", dependencies=[Depends(control)])
    def settings(stream_id: str, body: StreamSettings) -> dict[str, Any]:
        w = worker(stream_id)
        if body.confidence is not None:
            w.confidence = body.confidence
        if body.show_boxes is not None:
            w.show_boxes = body.show_boxes
        return w.snapshot()

    media = [Depends(require("monitor:view", allow_query_token=True))]  # <img src> can't send headers

    @app.get("/api/streams/{stream_id}/frame.jpg", dependencies=media)
    def frame(stream_id: str) -> Response:
        _, jpg = worker(stream_id).jpeg()
        if jpg is None:
            raise HTTPException(404, "no frame yet")
        return Response(jpg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/api/streams/{stream_id}/mjpeg", dependencies=media)
    async def mjpeg(stream_id: str, request: Request) -> StreamingResponse:
        w = worker(stream_id)

        async def gen() -> AsyncIterator[bytes]:
            last = -1
            while not await request.is_disconnected():
                live = monitor.get(stream_id)
                if live is not w:  # the stream was restarted by a config reload
                    return
                seq, jpg = w.jpeg()
                if jpg is not None and seq != last:
                    last = seq
                    yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                           + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                else:
                    await asyncio.sleep(0.02)

        return StreamingResponse(
            gen(),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------ config
    # Admins may edit the per-camera fields of existing cameras (config_diff.ADMIN_STREAM_KEYS) from the
    # form view; everything else - and the raw YAML view, reset and restore - needs config:system.
    cfg_view = [Depends(require("config:view"))]
    cfg_system = require("config:system")

    @app.get("/api/config", dependencies=cfg_view)
    def get_config() -> dict[str, Any]:
        return cfg_store.read()

    @app.get("/api/config/schema", dependencies=cfg_view)
    def config_schema() -> dict[str, Any]:
        return {
            "schema": AppConfig.model_json_schema(),
            "ppe_items": sorted(PPE_ITEMS),
            "behaviors": sorted(BEHAVIOR_ITEMS),
            "zone_items": sorted(ZONE_ITEMS),
            "zone_types": ["monitor", "ignore", "restricted"],
            "review_reasons": [{"id": k, "label": v} for k, v in REVIEW_REASONS.items()],
            "devices": ["auto", "cpu", "cuda", "cuda:0", "cuda:1", "intel:gpu", "intel:cpu"],
            "source_types": ["file", "rtsp", "webcam", "http", "images"],
            "restart_required": ["server.host", "server.port", "server.static_dir", "server.cors_origins", "alerts.db_path"],
            "admin_stream_keys": list(ADMIN_STREAM_KEYS),
            "capabilities": monitor.capabilities(),
        }

    @app.post("/api/config/validate", dependencies=cfg_view)
    def validate_config(body: ConfigPayload) -> dict[str, Any]:
        try:
            raw, _, _ = cfg_store.validate_any(config=body.config, yaml_text=body.yaml)
        except ConfigInvalid as e:
            return {"valid": False, "errors": [x.to_dict() for x in e.errors]}
        # what saving this would do to the cameras: the UI confirms removals / source changes first
        return {"valid": True, "errors": [], "cameras": camera_changes(_current_raw(), raw)}

    def _current_raw() -> dict[str, Any]:
        return cfg_store.read_raw()

    def _retention(c: AppConfig) -> None:
        store.cleanup(c.alerts.retention_days)
        store.purge_evidence(c.alerts.evidence_retention_days)

    def _removal_guard(before_raw: dict[str, Any], after_raw: dict[str, Any],
                       confirmed: list[str] | None) -> JSONResponse | None:
        """A write that removes cameras must name them in `confirm_remove` (the UI asks the user first).
        Stops a stale form, a pasted YAML, an old backup or "Reset to defaults" from silently deleting
        the site's cameras. 409 + the camera diff otherwise."""
        changes = camera_changes(before_raw, after_raw)
        missing = sorted(c["id"] for c in changes["removed"] if c["id"] not in set(confirmed or []))
        if not missing:
            return None
        names = ", ".join(c["name"] for c in changes["removed"])
        n = len(changes["removed"])
        return JSONResponse(status_code=409, content={
            "detail": f"This would remove {n} camera{'s' if n != 1 else ''}: {names}. Confirm the removal to continue.",
            "code": "confirm_camera_removal", "cameras": changes})

    async def _apply(new_cfg: AppConfig, request: Request, user: User, action: str, before_raw: dict[str, Any],
                     detail: str = "") -> dict[str, Any]:
        reload = await asyncio.to_thread(monitor.apply_config, new_cfg)
        await asyncio.to_thread(_retention, new_cfg)
        doc = cfg_store.read()
        before, after = split_diff(diff(before_raw, cfg_store.read_raw()))  # unmasked: real changes only
        audit.record(action, actor=user, target_type="config", target=f"{len(before)} field(s)",
                     before=before, after=after, detail=detail, ip=client_ip(request))
        return {"ok": True, "reload": reload, **doc}

    @app.put("/api/config", response_model=None)
    async def put_config(body: ConfigPayload, request: Request,
                         user: User = Depends(require("config:cameras"))) -> dict[str, Any] | JSONResponse:
        before_raw = _current_raw()
        if "config:system" not in user.permissions:
            if body.yaml is not None:
                raise ApiError(403, "Editing the raw YAML requires the Super Admin role. Use the form view to change "
                                    "camera settings.", "forbidden")
            denied = admin_denied_changes(before_raw, body.config or {})
            if denied:
                shown = ", ".join(denied[:8]) + (f" and {len(denied) - 8} more" if len(denied) > 8 else "")
                raise ApiError(403, "Your role (Admin) can only change per-camera settings (name, source, enabled, "
                                    f"required PPE, confidence). Not allowed: {shown}.", "forbidden")
        try:
            planned, _, _ = cfg_store.validate_any(config=body.config, yaml_text=body.yaml)
        except ConfigInvalid as e:
            return _invalid(e)
        blocked = _removal_guard(before_raw, planned, body.confirm_remove)
        if blocked is not None:
            return blocked
        try:
            new_cfg = await asyncio.to_thread(cfg_store.save, config=body.config, yaml_text=body.yaml, etag=body.etag)
        except ConfigInvalid as e:
            return _invalid(e)
        except ConfigConflict as e:
            raise HTTPException(409, str(e)) from e
        return await _apply(new_cfg, request, user, "config.update", before_raw,
                            "raw YAML" if body.yaml is not None else "form")

    @app.post("/api/config/reset", response_model=None)
    async def reset_config(request: Request, body: ResetPayload | None = None,
                           user: User = Depends(cfg_system)) -> dict[str, Any] | JSONResponse:
        body = body or ResetPayload()
        before_raw = _current_raw()
        try:
            plan = cfg_store.reset_plan(body.keep_cameras)
            planned = cfg_store.parse_yaml(plan) if isinstance(plan, str) else plan
            blocked = _removal_guard(before_raw, planned, body.confirm_remove)
            if blocked is not None:
                return blocked
            new_cfg = await asyncio.to_thread(cfg_store.reset, body.keep_cameras)
        except ConfigInvalid as e:
            return _invalid(e)
        return await _apply(new_cfg, request, user, "config.reset", before_raw,
                            "cameras kept" if body.keep_cameras else "cameras removed")

    @app.get("/api/config/backups", dependencies=[Depends(cfg_system)])
    def config_backups() -> list[dict[str, Any]]:
        return cfg_store.backups()

    @app.post("/api/config/restore", response_model=None)
    async def restore_config(body: RestorePayload, request: Request,
                             user: User = Depends(cfg_system)) -> dict[str, Any] | JSONResponse:
        before_raw = _current_raw()
        try:
            blocked = _removal_guard(before_raw, cfg_store.parse_yaml(cfg_store.backup_text(body.name)), body.confirm_remove)
            if blocked is not None:
                return blocked
            new_cfg = await asyncio.to_thread(cfg_store.restore, body.name)
        except FileNotFoundError as e:
            raise HTTPException(404, f"backup not found: {body.name}") from e
        except ConfigInvalid as e:
            return _invalid(e)
        return await _apply(new_cfg, request, user, "config.restore", before_raw, body.name)

    # ------------------------------------------------------------ violations
    def _filter(start: float | None, end: float | None, camera: str | None, ppe: str | None,
                acknowledged: bool | None = None, review: str | None = None) -> ViolationFilter:
        # `ppe` selects one violation type: a PPE item (helmet, vest, …), a behaviour (phone_use) or restricted_area.
        if ppe and ppe not in VIOLATION_ITEMS:
            raise HTTPException(422, f"unknown violation type {ppe!r}")
        if review and review not in (*REVIEW_VERDICTS, "unreviewed"):
            raise HTTPException(422, f"unknown review filter {review!r}")
        return ViolationFilter(start=start, end=end, stream_id=camera or None, ppe=ppe or None,
                               acknowledged=acknowledged, review=review or None)

    v_view = [Depends(require("violations:view"))]

    @app.get("/api/violations", dependencies=v_view)
    def list_violations(
        start: float | None = Query(None, description="epoch seconds, inclusive"),
        end: float | None = Query(None, description="epoch seconds, exclusive"),
        camera: str | None = None,
        ppe: str | None = None,
        acknowledged: bool | None = Query(None, description="true = only acknowledged, false = only open"),
        review: str | None = Query(None, description="valid | false_alarm | unreviewed"),
        before_id: int | None = Query(None, description="cursor: next_before_id from the previous page"),
        limit: int = Query(50, ge=1, le=200),
    ) -> dict[str, Any]:
        return store.list(_filter(start, end, camera, ppe, acknowledged, review), limit=limit, before_id=before_id)

    @app.get("/api/violations/export")
    def export_violations(request: Request, start: float | None = None, end: float | None = None,
                          camera: str | None = None, ppe: str | None = None, acknowledged: bool | None = None,
                          review: str | None = None,
                          user: User = Depends(require("violations:view", "violations:export"))) -> Response:
        f = _filter(start, end, camera, ppe, acknowledged, review)
        csv_text = store.export_csv(f)
        name = f"violations-{datetime.now():%Y%m%d-%H%M%S}.csv"
        rows = max(0, len(csv_text.splitlines()) - 1)
        audit.record("violations.export", actor=user, target_type="violations", target=f"{rows} row(s)",
                     after={k: v for k, v in vars(f).items() if v is not None}, ip=client_ip(request))
        return Response(csv_text, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/violations/dataset")
    def export_dataset(request: Request, start: float | None = None, end: float | None = None,
                       camera: str | None = None, ppe: str | None = None, review: str | None = None,
                       limit: int = Query(500, ge=1, le=2000),
                       user: User = Depends(require("violations:view", "violations:export"))) -> Response:
        """Reviewed violations as a YOLO-layout zip (clean frames + person pre-labels + verdicts) for retraining."""
        import tempfile

        f = _filter(start, end, camera, ppe, None, review)
        tmp = tempfile.SpooledTemporaryFile(max_size=64 << 20)
        n = store.export_dataset(f, tmp, limit)
        if not n:
            tmp.close()
            raise HTTPException(404, "No violations with a stored original frame match this filter.")
        size = tmp.tell()
        tmp.seek(0)
        audit.record("violations.export_dataset", actor=user, target_type="violations", target=f"{n} image(s)",
                     after={k: v for k, v in vars(f).items() if v is not None}, ip=client_ip(request))

        def chunks():  # noqa: ANN202
            try:
                while data := tmp.read(1 << 20):
                    yield data
            finally:
                tmp.close()

        name = f"ppe-review-dataset-{datetime.now():%Y%m%d-%H%M%S}.zip"
        return StreamingResponse(chunks(), media_type="application/zip", headers={
            "Content-Disposition": f'attachment; filename="{name}"', "Content-Length": str(size), "X-Image-Count": str(n)})

    @app.get("/api/violations/stats", dependencies=view)
    def violation_stats() -> dict[str, Any]:
        return {"today": store.count_today(), "session_total": store.session_total}

    @app.get("/api/violations/{vid}", dependencies=v_view)
    def get_violation(vid: int, include: str = Query("", description="comma-separated: original, crop")) -> dict[str, Any]:
        extra = tuple(x for x in (i.strip() for i in include.split(",")) if x in ("original", "crop"))
        v = store.get(vid, extra=extra)
        if v is None:
            raise HTTPException(404, "violation not found")
        return v

    @app.post("/api/violations/{vid}/ack")
    def acknowledge_violation(vid: int, request: Request, user: User = Depends(require("violations:ack"))) -> dict[str, Any]:
        already = store.get(vid, image=False)
        if already is None:
            raise HTTPException(404, "violation not found")
        v = store.acknowledge(vid, user.username) or already
        if already["acknowledged_at"] is None:
            audit.record("violation.acknowledge", actor=user, target_type="violation", target=str(vid),
                         ip=client_ip(request))
        return v

    @app.post("/api/violations/{vid}/review")
    def review_violation(vid: int, body: ReviewBody, request: Request,
                         user: User = Depends(require("violations:ack"))) -> dict[str, Any]:
        if body.verdict is not None and body.verdict not in REVIEW_VERDICTS:
            raise HTTPException(422, f"verdict must be one of {', '.join(REVIEW_VERDICTS)} or null")
        reason = body.reason if body.verdict == "false_alarm" else None
        if body.verdict == "false_alarm" and reason not in REVIEW_REASONS:
            raise HTTPException(422, f"a false alarm needs a reason: {', '.join(REVIEW_REASONS)}")
        before = store.get(vid, image=False)
        if before is None:
            raise HTTPException(404, "violation not found")
        v = store.set_review(vid, body.verdict, user.username, reason, body.note)
        if v is None:
            raise HTTPException(404, "violation not found")
        audit.record("violation.review", actor=user, target_type="violation", target=str(vid), ip=client_ip(request),
                     before={"review": before["review"]}, after={"review": v["review"]})
        return v

    @app.delete("/api/violations/{vid}")
    def delete_violation(vid: int, request: Request, user: User = Depends(require("violations:delete"))) -> dict[str, bool]:
        v = store.get(vid, image=False)
        if v is None or not store.delete(vid):
            raise HTTPException(404, "violation not found")
        audit.record("violation.delete", actor=user, target_type="violation", target=str(vid), ip=client_ip(request),
                     before={"camera": v["stream_id"], "track_id": v["track_id"], "missing": v["missing"], "time": v["iso"]})
        return {"ok": True}

    # ------------------------------------------------------------ WebSocket
    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        # browsers can't set headers on a WebSocket handshake: the access token comes as ?access_token=
        token = websocket.query_params.get("access_token") or ""
        await websocket.accept()
        try:
            if not token:
                raise ApiError(401, "Sign in to continue.", "not_authenticated")
            user = user_from_token(auth, token)
            check_permission(user, ("monitor:view",))
            exp = float(decode_access_token(auth.settings, token)["exp"])
        except ApiError as e:
            await websocket.close(code=WS_TOKEN_EXPIRED if e.status_code == 401 else WS_FORBIDDEN, reason=e.code)
            return
        await hub.send(websocket, json.dumps({"type": "hello", **monitor.snapshot()}))
        hub.clients.add(websocket)
        hub.expires[websocket] = exp
        hub.tokens[websocket] = token
        subs: dict[str, float] = {}  # stream id -> max fps this client wants (only tiles on screen)
        video = asyncio.create_task(_video_sender(websocket, subs))
        try:
            while True:
                try:
                    msg = json.loads(await websocket.receive_text())
                except (ValueError, TypeError):
                    continue
                if isinstance(msg, dict) and msg.get("type") == "subscribe" and isinstance(msg.get("streams"), dict):
                    subs.clear()
                    for sid, fps in list(msg["streams"].items())[:64]:
                        try:
                            subs[str(sid)] = min(30.0, max(0.5, float(fps)))
                        except (TypeError, ValueError):
                            continue
        except WebSocketDisconnect:
            pass
        finally:
            video.cancel()
            hub.forget(websocket)

    async def _video_sender(websocket: WebSocket, subs: dict[str, float]) -> None:
        """Push each subscribed camera's newest JPEG as a binary message, at most `fps` per camera.

        One socket carries every tile, so the browser's ~6-connections-per-host HTTP/1.1 limit (which
        caps MJPEG <img> tiles at 6) no longer applies. Frames are never queued: a slow client just
        gets fewer of them. Wire format: [0x01][len(id)][id utf-8][seq uint32 BE][JPEG bytes].
        """
        last: dict[str, int] = {}
        due: dict[str, float] = {}
        try:
            while True:
                now = time.monotonic()
                sent = False
                for sid, fps in list(subs.items()):
                    if due.get(sid, 0.0) > now:
                        continue
                    w = monitor.get(sid)
                    if w is None:
                        continue
                    seq, jpg = w.jpeg()
                    if jpg is None or seq == last.get(sid):
                        continue
                    ident = sid.encode()[:255]
                    try:
                        await hub.send(websocket, b"\x01" + bytes([len(ident)]) + ident
                                       + (seq & 0xFFFFFFFF).to_bytes(4, "big") + jpg, 3.0)
                    except asyncio.TimeoutError:  # slow client: skip this frame, try again later
                        pass
                    last[sid], due[sid], sent = seq, now + 1.0 / fps, True
                await asyncio.sleep(0.005 if sent else 0.02)
        except asyncio.CancelledError:
            raise
        except Exception:  # socket gone / too slow: the receive loop notices and cleans up
            return

    # ------------------------------------------------------------ built frontend (docker / prod)
    static = Path(cfg.server.static_dir)
    if static.is_dir() and (static / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            if path.startswith("api/"):
                raise HTTPException(404, "not found")
            f = static / path
            return FileResponse(f if path and f.is_file() else static / "index.html")

    return app
