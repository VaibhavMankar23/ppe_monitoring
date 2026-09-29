"""Many-camera behaviour: scheduler (priority + fairness + batch cap), batch padding, bounded thread pool,
focus mode, WebSocket video multiplexing and the camera-management / health endpoints."""

from __future__ import annotations

import io
import threading
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import load_config
from app.pipeline import InferenceEngine, Monitor, batch_buckets
from app.sources import Frame
from app.violations_db import ViolationStore
from helpers import FakeDetector, auth_settings, bearer, bootstrap_super_admin, create_admin, raw_config, write_config


def many(tmp_path, n=6, **inference):
    raw = raw_config(tmp_path, n)
    raw["inference"].update(inference)
    return load_config(write_config(tmp_path, raw))


def feed(worker, seq=1):
    """Pretend the grabber delivered a frame."""
    img = np.zeros((54, 96, 3), np.uint8)
    worker.grabber._latest = Frame(img, seq, time.monotonic())
    worker.running = True


# ------------------------------------------------------------------ scheduling
def test_buckets():
    assert batch_buckets(1) == [1] and batch_buckets(8) == [1, 2, 4, 8] and batch_buckets(6) == [1, 2, 4, 6]


def test_scheduler_caps_batch_prefers_high_priority_then_longest_waiting(tmp_path):
    raw = raw_config(tmp_path, 6)
    raw["inference"]["max_batch"] = 3
    raw["streams"][4]["priority"] = "high"
    cfg = load_config(write_config(tmp_path, raw))
    mon = Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    ws = list(mon.workers.values())
    for i, w in enumerate(ws):
        feed(w)
        w._last_take = 100.0 + i  # cam1 has waited longest
    eng = InferenceEngine("t", FakeDetector(), ws, 0.15, cfg.inference)
    picked = eng.schedule(time.monotonic() + 1000)
    assert [w.id for w in picked] == ["cam5", "cam1", "cam2"]  # high first, then fairness
    assert eng.contended == 1


def test_low_priority_runs_at_a_third_of_the_rate(tmp_path):
    raw = raw_config(tmp_path, 2)
    raw["inference"]["max_fps_per_stream"] = 9
    raw["streams"][1]["priority"] = "low"
    mon = Monitor(load_config(write_config(tmp_path, raw)), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    normal, low = mon.workers["cam1"], mon.workers["cam2"]
    assert low._min_interval == pytest.approx(3 * normal._min_interval)


def test_one_frame_in_flight_per_camera(tmp_path):
    mon = Monitor(many(tmp_path, 1), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    w = mon.workers["cam1"]
    feed(w, 1)
    now = time.monotonic() + 100
    assert w.ready(now)
    w.take()
    feed(w, 2)
    assert not w.ready(now + 100)  # previous frame still being processed
    w.release()
    assert w.ready(now + 100)


def test_batches_are_padded_only_on_shape_compiling_accelerators(tmp_path):
    cfg = many(tmp_path, 1, max_batch=8)
    seen = []

    class Gpu(FakeDetector):
        device = "intel:gpu"

        def predict(self, frames, conf, imgsz=None):
            seen.append(len(frames))
            return [[] for _ in frames]

    eng = InferenceEngine("t", Gpu(), [], 0.15, cfg.inference)
    assert len(eng._pad([np.zeros((4, 4, 3), np.uint8)] * 3)) == 4
    assert len(eng._pad([np.zeros((4, 4, 3), np.uint8)] * 5)) == 8
    eng.warmup((96, 54))
    assert seen[:4] == [1, 2, 4, 8]  # only the bucket shapes are compiled
    cpu = InferenceEngine("t", FakeDetector(), [], 0.15, cfg.inference)
    assert len(cpu._pad([np.zeros((4, 4, 3), np.uint8)] * 3)) == 3


def test_post_processing_uses_a_bounded_shared_pool(tmp_path):
    before = threading.active_count()
    mon = Monitor(many(tmp_path, 12, post_workers=3), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    assert mon.pool._max_workers == 3 and all(w._pool is mon.pool for w in mon.workers.values())
    mon.start()
    time.sleep(0.3)
    # 12 grabbers + 1 engine + <= 3 pool threads (the old design used 2 threads per camera = 24 + 1)
    assert threading.active_count() - before <= 12 + 1 + 3
    mon.stop()


# ------------------------------------------------------------------ focus mode
def test_focus_pauses_detection_elsewhere_only_when_enabled(tmp_path):
    mon = Monitor(many(tmp_path, 3, focus_pause_others=True), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    for w in mon.workers.values():
        feed(w)
    now = time.monotonic() + 100
    mon.set_focus("cam2")
    assert [w.id for w in mon.workers.values() if w.ready(now)] == ["cam2"]
    assert mon.workers["cam1"].preview_due(now)  # video of paused cameras still refreshes
    assert mon.focus_state()["paused"] == ["cam1", "cam3"]
    mon.set_focus(None)
    assert all(w.ready(now) for w in mon.workers.values())
    off = Monitor(many(tmp_path, 3, focus_pause_others=False), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    off.set_focus("cam2")
    assert off.focus_state()["paused"] == []  # default: every camera stays fully live


def test_focus_lease_expires(tmp_path, monkeypatch):
    mon = Monitor(many(tmp_path, 2, focus_pause_others=True), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    monkeypatch.setattr(Monitor, "FOCUS_LEASE", 0.05)
    mon.set_focus("cam1")
    for w in mon.workers.values():
        w.running = True
    assert mon.workers["cam2"].paused
    time.sleep(0.1)
    assert not mon.workers["cam2"].paused  # a closed tab can't leave detection paused


# ------------------------------------------------------------------ HTTP / WebSocket
@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PPE_VIDEOS_DIR", str(tmp_path / "videos"))
    monkeypatch.setenv("PPE_SECRET_KEY", "k")
    path = write_config(tmp_path, raw_config(tmp_path, 3))
    cfg = load_config(path)
    mon = Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        sup = bootstrap_super_admin(c)
        c.tokens = {"super": sup, "admin": create_admin(c, sup)}  # type: ignore[attr-defined]
        c.mon = mon  # type: ignore[attr-defined]
        yield c


def clip_bytes(tmp_path) -> bytes:
    p = tmp_path / "c.avi"
    vw = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"MJPG"), 10, (80, 60))
    for i in range(5):
        vw.write(np.full((60, 80, 3), 50 + i, np.uint8))
    vw.release()
    return p.read_bytes()


def test_upload_list_and_test_a_file_camera(client, tmp_path):
    sup, adm = bearer(client.tokens["super"]), bearer(client.tokens["admin"])
    data = clip_bytes(tmp_path)
    assert client.post("/api/sources/upload", headers=adm, files={"file": ("gate.avi", io.BytesIO(data))}).status_code == 403
    r = client.post("/api/sources/upload", headers=sup, files={"file": ("gate cam.avi", io.BytesIO(data))})
    assert r.status_code == 201 and r.json()["name"] == "gate_cam.avi"
    # the same file again is reused; a different file with the same name is stored next to it
    again = client.post("/api/sources/upload", headers=sup, files={"file": ("gate cam.avi", io.BytesIO(data))})
    assert again.status_code == 201 and again.json()["name"] == "gate_cam.avi" and again.json()["reused"]
    other = client.post("/api/sources/upload", headers=sup, files={"file": ("gate cam.avi", io.BytesIO(data + b"x"))})
    assert other.status_code == 201 and other.json()["name"] == "gate_cam_2.avi"
    assert client.post("/api/sources/upload", headers=sup, files={"file": ("x.exe", io.BytesIO(b"MZ"))}).status_code == 415
    files = client.get("/api/sources/files", headers=adm).json()
    assert sorted(f["name"] for f in files["files"]) == ["gate_cam.avi", "gate_cam_2.avi"]
    uri = next(f["uri"] for f in files["files"] if f["name"] == "gate_cam.avi")
    t = client.post("/api/sources/test", headers=adm, json={"source": {"type": "file", "uri": uri}}).json()
    assert t["ok"] and t["width"] == 80 and t["thumbnail"]
    bad = client.post("/api/sources/test", headers=adm, json={"source": {"type": "rtsp", "uri": "rtsp://127.0.0.1:9/x", "timeout": 1}}).json()
    assert not bad["ok"] and bad["message"]


def test_health_and_focus_endpoints(client):
    h = bearer(client.tokens["admin"])
    body = client.get("/api/system/health", headers=h).json()
    assert {"engines", "host", "cameras", "capacity"} <= set(body)
    assert {"dropped", "reconnects", "drop_rate", "fps", "priority"} <= set(body["cameras"][0])
    assert client.post("/api/focus", headers=h, json={"stream_id": "cam2"}).json()["stream_id"] == "cam2"
    assert client.post("/api/focus", headers=h, json={"stream_id": "nope"}).status_code == 404


def test_websocket_multiplexes_video_for_subscribed_cameras_only(client):
    mon = client.mon
    for sid in ("cam1", "cam2"):
        w = mon.workers[sid]
        w._jpeg, w.out_seq = cv2.imencode(".jpg", np.zeros((8, 8, 3), np.uint8))[1].tobytes(), 1
    with client.websocket_connect(f"/ws?access_token={client.tokens['admin']}") as ws:
        assert '"hello"' in ws.receive_text()
        ws.send_json({"type": "subscribe", "streams": {"cam2": 10}})
        got = None
        for _ in range(50):
            msg = ws.receive()
            if msg.get("bytes"):
                got = msg["bytes"]
                break
        assert got is not None and got[0] == 1
        n = got[1]
        assert got[2:2 + n] == b"cam2" and got[2 + n + 4:][:2] == b"\xff\xd8"  # id, seq, then the JPEG


def test_admin_can_change_a_camera_password_and_it_is_never_returned(client):
    h = bearer(client.tokens["admin"])
    doc = client.get("/api/config", headers=h).json()
    cfg = doc["config"]
    cfg["streams"][0]["source"] = {"type": "rtsp", "uri": "rtsp://10.0.0.8/ch1", "username": "viewer", "password": "Cam3raPass"}
    assert client.put("/api/config", headers=h, json={"config": cfg, "etag": doc["etag"]}).status_code == 200
    after = client.get("/api/config", headers=h).json()
    assert "Cam3raPass" not in after["yaml"] and after["config"]["streams"][0]["source"]["password"] == "********"
    log = client.get("/api/audit", headers=bearer(client.tokens["super"]), params={"action": "config.update"}).json()["items"][0]
    assert log["after"]["streams.cam1.source.password"] == "(set)"  # the audit log never holds the secret


def test_app_runs_with_no_cameras_yet(tmp_path):
    """Fresh install: no cameras configured; they are added later from the UI."""
    raw = raw_config(tmp_path, 1)
    raw["streams"] = []
    path = write_config(tmp_path, raw)
    cfg = load_config(path)
    mon = Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        h = bearer(bootstrap_super_admin(c))
        assert c.get("/api/status", headers=h).json()["streams"] == []
        assert c.get("/api/analytics/summary", headers=h).status_code == 200
        doc = c.get("/api/config", headers=h).json()
        new = {**doc["config"], "streams": [{"id": "gate", "name": "Gate", "source": {"type": "rtsp", "uri": "rtsp://127.0.0.1:9/x", "timeout": 1}}]}
        r = c.put("/api/config", headers=h, json={"config": new, "etag": doc["etag"]})
        assert r.status_code == 200 and r.json()["reload"]["added"] == ["gate"]
