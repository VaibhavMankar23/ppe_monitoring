"""Source layer: type registry, credentials at rest, HTTP MJPEG / snapshot cameras (real local HTTP server),
connection test, grabber health counters and offline state."""

from __future__ import annotations

import http.server
import threading
import time

import cv2
import numpy as np
import pytest
import yaml

from app import secret_box
from app.config import SourceConfig
from app.config_store import ConfigStore, mask_sources, secure_sources
from app.secret_box import MASK, decrypt, encrypt, split_uri_credentials, with_uri_credentials
from app.sources import SOURCE_TYPES, FrameGrabber, HTTPStreamSource, SourceError, StreamSource, make_source, probe
from helpers import raw_config, write_config


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("PPE_SECRET_KEY", "unit-test-key")


def jpeg(color: int, w: int = 64, h: int = 48) -> bytes:
    return cv2.imencode(".jpg", np.full((h, w, 3), color, np.uint8))[1].tobytes()


class _Cam(http.server.BaseHTTPRequestHandler):
    """Fake IP camera: /mjpeg (multipart push), /snap.jpg (snapshot), /private (Basic auth), /missing."""

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):  # noqa: N802
        if self.path == "/private" and self.headers.get("Authorization") != "Basic dXNlcjpwQHNz":  # user:p@ss
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="cam"')
            self.end_headers()
            return
        if self.path in ("/mjpeg", "/private"):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            try:
                for i in range(40):
                    body = jpeg(40 + i * 5)
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(body) + body + b"\r\n")
                    self.wfile.flush()
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
        elif self.path == "/snap.jpg":
            body = jpeg(200)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


@pytest.fixture(scope="module")
def cam_url():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Cam)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


# ------------------------------------------------------------------ registry
def test_every_config_type_has_a_source_class():
    from typing import get_args

    types = set(get_args(SourceConfig.model_fields["type"].annotation))
    assert types == set(SOURCE_TYPES)
    for t, cls in SOURCE_TYPES.items():
        assert issubclass(cls, StreamSource) and cls.kind == t


def test_onvif_placeholder_explains_what_to_do():
    with pytest.raises(SourceError, match="RTSP URL"):
        make_source(SourceConfig(type="onvif", uri="http://10.0.0.5")).open()


# ------------------------------------------------------------------ credentials
def test_encrypt_roundtrip_and_uri_helpers():
    token = encrypt("s3cret")
    assert token.startswith("enc:") and "s3cret" not in token and decrypt(token) == "s3cret"
    assert split_uri_credentials("rtsp://admin:p%40ss@10.0.0.9:554/ch1") == ("rtsp://10.0.0.9:554/ch1", "admin", "p@ss")
    assert with_uri_credentials("rtsp://10.0.0.9/ch1", "ad min", "p@ss:1") == "rtsp://ad%20min:p%40ss%3A1@10.0.0.9/ch1"
    assert secret_box.mask_uri("rtsp://a:b@h/x") == "rtsp://***@h/x"


def test_wrong_key_is_a_readable_error(monkeypatch):
    token = encrypt("x")
    monkeypatch.setenv("PPE_SECRET_KEY", "another-key")
    with pytest.raises(secret_box.SecretError, match="secret key"):
        decrypt(token)


def test_config_never_stores_or_returns_plaintext(tmp_path):
    raw = raw_config(tmp_path, 2)
    raw["streams"][0]["source"] = {"type": "rtsp", "uri": "rtsp://admin:Hunter2x@10.1.1.5:554/main"}
    store = ConfigStore(write_config(tmp_path, {**raw_config(tmp_path, 2)}))
    store.save(config=raw)
    text = store.read_text()
    assert "Hunter2x" not in text and "admin:" not in text
    src = yaml.safe_load(text)["streams"][0]["source"]
    assert src["uri"] == "rtsp://10.1.1.5:554/main" and src["username"] == "admin" and decrypt(src["password"]) == "Hunter2x"
    shown = store.read()["config"]["streams"][0]["source"]
    assert shown["password"] == MASK  # the UI only ever sees the mask
    # saving the form back unchanged (MASK) keeps the stored secret
    store.save(config=store.read()["config"])
    assert decrypt(yaml.safe_load(store.read_text())["streams"][0]["source"]["password"]) == "Hunter2x"
    # raw YAML with a plain password gets encrypted too
    store.save(yaml_text=store.read_text().replace(src["password"], "NewPass9"))
    assert "NewPass9" not in store.read_text()
    assert decrypt(yaml.safe_load(store.read_text())["streams"][0]["source"]["password"]) == "NewPass9"


def test_secure_and_mask_are_pure():
    raw = {"streams": [{"id": "c", "source": {"type": "http", "uri": "http://h/x", "password": "pw"}}]}
    out = secure_sources(raw, None)
    assert raw["streams"][0]["source"]["password"] == "pw" and out["streams"][0]["source"]["password"].startswith("enc:")
    assert mask_sources(out)["streams"][0]["source"]["password"] == MASK


# ------------------------------------------------------------------ HTTP cameras
def read_n(src: StreamSource, n: int) -> list[np.ndarray]:
    src.open()
    try:
        return [f for f in (src.read() for _ in range(n)) if f is not None]
    finally:
        src.close()


def test_http_mjpeg_push(cam_url):
    frames = read_n(HTTPStreamSource(SourceConfig(type="http", uri=cam_url + "/mjpeg")), 5)
    assert len(frames) == 5 and frames[0].shape == (48, 64, 3)
    assert frames[4].mean() > frames[0].mean()  # consecutive frames, in order


def test_http_snapshot_polling(cam_url):
    src = HTTPStreamSource(SourceConfig(type="http", uri=cam_url + "/snap.jpg", fps=20))
    frames = read_n(src, 3)
    assert len(frames) == 3 and src._mode == "snapshot"


def test_http_basic_auth_with_encrypted_password(cam_url):
    ok = SourceConfig(type="http", uri=cam_url + "/private", username="user", password=encrypt("p@ss"))
    assert len(read_n(HTTPStreamSource(ok), 2)) == 2
    bad = SourceConfig(type="http", uri=cam_url + "/private", username="user", password=encrypt("nope"))
    with pytest.raises(SourceError, match="refused the credentials"):
        HTTPStreamSource(bad).open()


def test_probe_reports_frame_size_and_thumbnail(cam_url, tmp_path):
    r = probe(SourceConfig(type="http", uri=cam_url + "/mjpeg"), timeout=5)
    assert r["ok"] and (r["width"], r["height"]) == (64, 48) and r["thumbnail"]
    r = probe(SourceConfig(type="http", uri=cam_url + "/missing"), timeout=5)
    assert not r["ok"] and "404" in r["message"]
    r = probe(SourceConfig(type="file", uri=str(tmp_path / "nope.mp4")), timeout=2)
    assert not r["ok"] and "not found" in r["message"]
    r = probe(SourceConfig(type="rtsp", uri="rtsp://127.0.0.1:9/none", timeout=1), timeout=1)
    assert not r["ok"] and r["message"]


def test_probe_file(tmp_path):
    path = tmp_path / "clip.avi"
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (80, 60))
    for i in range(10):
        vw.write(np.full((60, 80, 3), i * 20, np.uint8))
    vw.release()
    r = probe(SourceConfig(type="file", uri=str(path)), timeout=5)
    assert r["ok"] and (r["width"], r["height"]) == (80, 60) and r["fps"] == 10


# ------------------------------------------------------------------ grabber: drops, reconnects, offline
class _Scripted(StreamSource):
    """A camera that delivers `n` frames per connection, then drops; fails to open when `down`."""

    kind = "scripted"
    down = False

    def __init__(self, cfg, max_width=0, n=30):
        super().__init__(cfg, max_width)
        self.n, self.i = n, 0

    def open(self):
        if _Scripted.down:
            raise SourceError("camera unreachable")
        self.i, self.fps = 0, 100.0

    def read(self):
        self.i += 1
        time.sleep(0.002)
        return np.full((40, 60, 3), self.i % 255, np.uint8) if self.i <= self.n else None


def test_grabber_counts_drops_and_reconnects_then_goes_offline(monkeypatch):
    import app.sources as S

    monkeypatch.setattr(S, "OFFLINE_AFTER", 0.3)
    cfg = SourceConfig(type="rtsp", uri="rtsp://x/y", reconnect_delay=0.05, max_reconnect_delay=0.1)
    g = FrameGrabber("t", cfg, 960, source_factory=lambda c, w: _Scripted(c, w))
    _Scripted.down = False
    g.start()
    time.sleep(0.4)
    assert g.frames_captured > 30 and g.reconnects >= 1  # dropped after 30 frames and came back
    assert g.frames_dropped > 0  # nobody took frames: every overwritten one counts as dropped
    g.mark_taken(g.latest().seq)
    _Scripted.down = True
    deadline = time.time() + 3
    while g.state != "offline" and time.time() < deadline:
        time.sleep(0.05)
    assert g.state == "offline" and "unreachable" in g.last_error
    g.stop()
    assert g.state == "stopped"
