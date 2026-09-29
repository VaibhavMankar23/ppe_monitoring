"""Video source layer.

Every camera type implements the same small `StreamSource` interface::

    open() -> None        connect / open the file (raises SourceError with a readable message)
    read() -> ndarray     next BGR frame; None = end of stream / connection dropped
    close() -> None
    recorded              True for files / image folders: paced to real time and looped
    fps                   native frame rate (0 = unknown)

Implementations: `FileStreamSource` (local video, looped), `RTSPStreamSource` (rtsp:// through
OpenCV's FFmpeg backend over TCP, with open/read timeouts), `HTTPStreamSource` (IP cameras over
HTTP: MJPEG multipart push, single-JPEG snapshot polling, or anything FFmpeg can play, e.g. HLS),
`WebcamStreamSource`, `ImageFolderStreamSource`, and an `ONVIFStreamSource` placeholder. New types
register themselves in `SOURCE_TYPES`; nothing downstream knows which kind a camera is.

`FrameGrabber` runs one capture thread per camera (reads block on I/O, so a thread each is the
right tool) and keeps only the *latest* frame: stale frames are overwritten, never queued, so a
slow consumer can never build up lag. Failures reconnect with exponential backoff; a camera that
stays down is reported as "offline" instead of freezing on its last frame.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, ClassVar, Literal

import cv2
import numpy as np

from .config import SourceConfig
from .secret_box import SecretError, decrypt, mask_uri, split_uri_credentials, with_uri_credentials

log = logging.getLogger(__name__)

SourceState = Literal["stopped", "connecting", "live", "reconnecting", "offline", "no_source"]
OFFLINE_AFTER = 30.0  # s without frames (while retrying) before "reconnecting" becomes "offline"

# FFmpeg options for every capture: TCP for RTSP (UDP drops packets over Wi-Fi / VPN), and the decoder
# thread count (see inference.decode_threads). OpenCV reads this variable each time a capture opens.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")


def set_decode_threads(n: int) -> None:
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp" + (f"|threads;{n}" if n > 0 else "")


@dataclass
class Frame:
    image: np.ndarray  # processing / display resolution (<= process_width)
    seq: int
    ts: float  # time.monotonic() when captured
    full: np.ndarray | None = None  # original resolution (for person-crop refinement); None = same as image

    @property
    def full_res(self) -> np.ndarray:
        return self.image if self.full is None else self.full


class SourceError(Exception):
    """Opening / reading a source failed; the message is shown to the user as-is."""


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXTS = {".mp4", ".avi", ".mkv", ".mov", ".m4v", ".ts", ".mpg", ".mpeg", ".wmv", ".cpv", ".h264", ".h265", ".264", ".265"}


# ====================================================================== interface
class StreamSource:
    """Base class; subclasses implement open / read / close for one kind of camera."""

    kind: ClassVar[str] = ""
    recorded: ClassVar[bool] = False  # recorded media: paced to real time + looped

    def __init__(self, cfg: SourceConfig, max_width: int = 0) -> None:
        self.cfg = cfg
        self.max_width = max_width
        self.fps = 0.0

    def open(self) -> None:
        raise NotImplementedError

    def read(self) -> np.ndarray | None:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def available(self) -> bool:
        """False = nothing to connect to yet (missing file); polled without counting as a failure."""
        return True

    def describe(self) -> str:
        """Location for logs / UI, never with credentials."""
        return mask_uri(self.cfg.uri)

    # credentials, decrypted only here, at open time
    def _credentials(self) -> tuple[str, str]:
        base, u, p = split_uri_credentials(self.cfg.uri)
        try:
            password = decrypt(self.cfg.password) if self.cfg.password else (p or "")
        except SecretError as e:
            raise SourceError(str(e)) from e
        return (self.cfg.username or u or ""), password


class _OpenCVSource(StreamSource):
    """Anything cv2.VideoCapture can play."""

    def __init__(self, cfg: SourceConfig, max_width: int = 0) -> None:
        super().__init__(cfg, max_width)
        self._cap: cv2.VideoCapture | None = None

    def _capture(self) -> cv2.VideoCapture:
        raise NotImplementedError

    def open(self) -> None:
        cap = self._capture()
        if not cap.isOpened():
            cap.release()
            raise SourceError(self._open_error())
        fps = self.cfg.fps or cap.get(cv2.CAP_PROP_FPS)
        self.fps = fps if 0.1 <= fps <= 120 else 0.0
        self._cap = cap

    def _open_error(self) -> str:
        return f"cannot open {self.describe()}"

    def read(self) -> np.ndarray | None:
        if self._cap is None:
            return None
        ok, img = self._cap.read()
        return img if ok and img is not None else None

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None


class FileStreamSource(_OpenCVSource):
    kind, recorded = "file", True

    def available(self) -> bool:
        return os.path.isfile(self.cfg.uri)

    def describe(self) -> str:
        return os.path.basename(self.cfg.uri)

    def _capture(self) -> cv2.VideoCapture:
        return cv2.VideoCapture(self.cfg.uri)

    def _open_error(self) -> str:
        return f"cannot decode {self.describe()} (unsupported codec or damaged file)"


class _NetworkCapture(_OpenCVSource):
    def _url(self) -> str:
        user, pw = self._credentials()
        return with_uri_credentials(split_uri_credentials(self.cfg.uri)[0], user, pw)

    def _capture(self) -> cv2.VideoCapture:
        ms = int(self.cfg.timeout * 1000)
        cap = cv2.VideoCapture(self._url(), cv2.CAP_FFMPEG,
                               [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, ms, cv2.CAP_PROP_READ_TIMEOUT_MSEC, ms])
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _open_error(self) -> str:
        return (f"cannot connect to {self.describe()} within {self.cfg.timeout:.0f}s "
                "(check the address, port, path and credentials, and that the camera allows this client)")


class RTSPStreamSource(_NetworkCapture):
    kind = "rtsp"


class HTTPStreamSource(StreamSource):
    """HTTP IP camera. Sniffs the response type once, then:

    * ``multipart/x-mixed-replace`` (MJPEG push): parses JPEGs out of the stream itself (robust to
      the many slightly-off MJPEG implementations cameras ship, and supports Basic/Digest auth);
    * ``image/jpeg`` (snapshot URL): polls it at ``source.fps`` (default 5/s);
    * anything else (HLS, MP4 over HTTP, ...): hands the URL to FFmpeg.
    """

    kind = "http"

    def __init__(self, cfg: SourceConfig, max_width: int = 0) -> None:
        super().__init__(cfg, max_width)
        self._mode = ""
        self._resp: Any = None
        self._iter: Any = None
        self._buf = b""
        self._session: Any = None
        self._ffmpeg: _NetworkCapture | None = None
        self._next_poll = 0.0

    def _auth(self) -> Any:
        user, pw = self._credentials()
        return (user, pw) if user else None

    def open(self) -> None:
        import requests
        from requests.auth import HTTPDigestAuth

        url = split_uri_credentials(self.cfg.uri)[0]
        self._session = requests.Session()
        auth = self._auth()
        try:
            r = self._session.get(url, stream=True, timeout=self.cfg.timeout, auth=auth)
            if r.status_code == 401 and auth:  # many cameras only speak Digest
                r.close()
                self._session.auth = HTTPDigestAuth(*auth)
                r = self._session.get(url, stream=True, timeout=self.cfg.timeout)
            elif auth:
                self._session.auth = auth
        except requests.RequestException as e:
            raise SourceError(f"cannot connect to {self.describe()}: {type(e).__name__}") from e
        if r.status_code in (401, 403):
            r.close()
            raise SourceError(f"{self.describe()} refused the credentials (HTTP {r.status_code})")
        if r.status_code >= 400:
            r.close()
            raise SourceError(f"{self.describe()} answered HTTP {r.status_code}")
        ctype = r.headers.get("Content-Type", "").lower()
        if "multipart" in ctype:
            self._mode, self._resp, self._iter, self._buf = "mjpeg", r, r.iter_content(chunk_size=16384), b""
            self.fps = self.cfg.fps or 0.0
        elif ctype.startswith("image/"):
            r.close()
            self._mode, self.fps = "snapshot", self.cfg.fps or 5.0
        else:
            r.close()
            self._mode = "ffmpeg"
            self._ffmpeg = _NetworkCapture(self.cfg, self.max_width)
            self._ffmpeg.open()
            self.fps = self._ffmpeg.fps

    def read(self) -> np.ndarray | None:
        if self._mode == "mjpeg":
            return self._read_mjpeg()
        if self._mode == "snapshot":
            return self._read_snapshot()
        return self._ffmpeg.read() if self._ffmpeg else None

    def _read_mjpeg(self) -> np.ndarray | None:
        try:
            while True:
                start = self._buf.find(b"\xff\xd8")
                end = self._buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if start >= 0 and end >= 0:
                    jpg, self._buf = self._buf[start:end + 2], self._buf[end + 2:]
                    img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
                    if img is not None:
                        return img
                    continue
                if len(self._buf) > 8_000_000:  # garbage without JPEG markers: resync
                    self._buf = b""
                self._buf += next(self._iter)
        except Exception:  # StopIteration / connection reset / read timeout -> reconnect
            return None

    def _read_snapshot(self) -> np.ndarray | None:
        wait = self._next_poll - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._next_poll = time.monotonic() + 1.0 / max(0.2, self.fps)
        try:
            r = self._session.get(split_uri_credentials(self.cfg.uri)[0], timeout=self.cfg.timeout)
            if r.status_code != 200:
                return None
            return cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            return None

    def close(self) -> None:
        for c in (self._resp, self._session):
            try:
                if c is not None:
                    c.close()
            except Exception:
                pass
        if self._ffmpeg:
            self._ffmpeg.close()
        self._resp = self._session = self._iter = self._ffmpeg = None


class WebcamStreamSource(_OpenCVSource):
    kind = "webcam"

    def _capture(self) -> cv2.VideoCapture:
        try:
            index = int(self.cfg.uri)
        except ValueError as e:
            raise SourceError("webcam source: uri must be the camera index (0, 1, ...)") from e
        cap = cv2.VideoCapture(index)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def describe(self) -> str:
        return f"webcam {self.cfg.uri}"


class ImageFolderStreamSource(StreamSource):
    """Plays a folder of stills in name order (small folders are decoded once, downscaled, and looped)."""

    kind, recorded = "images", True
    MAX_CACHED = 600

    def __init__(self, cfg: SourceConfig, max_width: int = 0) -> None:
        super().__init__(cfg, max_width)
        self._files: list[str] = []
        self._cache: dict[int, np.ndarray] = {}
        self._i = 0

    def available(self) -> bool:
        return os.path.isdir(self.cfg.uri)

    def describe(self) -> str:
        return os.path.basename(self.cfg.uri.rstrip("/\\")) + "/"

    def open(self) -> None:
        folder = self.cfg.uri
        self._files = sorted(os.path.join(folder, f) for f in os.listdir(folder)
                             if os.path.splitext(f)[1].lower() in IMAGE_EXTS) if os.path.isdir(folder) else []
        if not self._files:
            raise SourceError(f"no images in {self.describe()}")
        self.fps, self._i = self.cfg.fps or 5.0, 0

    def read(self) -> np.ndarray | None:
        while self._i < len(self._files):  # a clip "ends" after the last image; the grabber loops it
            i = self._i
            self._i += 1
            img = self._cache.get(i)
            if img is None:
                img = cv2.imread(self._files[i])
                if img is None:
                    continue
                h, w = img.shape[:2]
                if self.max_width and w > self.max_width:
                    img = cv2.resize(img, (self.max_width, round(h * self.max_width / w)), interpolation=cv2.INTER_AREA)
                if len(self._files) <= self.MAX_CACHED:
                    self._cache[i] = img
            return img
        return None

    def close(self) -> None:
        self._i = 0  # keep the decoded cache for the next loop


class ONVIFStreamSource(StreamSource):
    """Placeholder: ONVIF discovery / PTZ is not implemented. Every ONVIF camera also exposes an RTSP
    URL (see its web UI or ONVIF Device Manager); add it as type "rtsp"."""

    kind = "onvif"

    def open(self) -> None:
        raise SourceError("ONVIF discovery isn't supported yet. Use the camera's RTSP URL with type 'rtsp' "
                          "(find it in the camera's web page or with ONVIF Device Manager).")

    def read(self) -> np.ndarray | None:
        return None


SOURCE_TYPES: dict[str, type[StreamSource]] = {
    c.kind: c for c in (FileStreamSource, RTSPStreamSource, HTTPStreamSource, WebcamStreamSource,
                        ImageFolderStreamSource, ONVIFStreamSource)
}


def make_source(cfg: SourceConfig, max_width: int = 0) -> StreamSource:
    try:
        return SOURCE_TYPES[cfg.type](cfg, max_width)
    except KeyError as e:
        raise SourceError(f"unknown source type {cfg.type!r}; valid: {', '.join(SOURCE_TYPES)}") from e


# ====================================================================== connection test
def probe(cfg: SourceConfig, max_width: int = 960, timeout: float | None = None) -> dict[str, Any]:
    """Open a source, read one frame and close it: the "Test connection" button. Never raises."""
    t0 = time.perf_counter()
    result: dict[str, Any] = {"ok": False, "source": mask_uri(cfg.uri), "type": cfg.type}
    box: dict[str, Any] = {}

    def run() -> None:
        src = make_source(cfg, max_width)
        try:
            if not src.available():
                raise SourceError(f"not found on the server: {src.describe()}")
            src.open()
            box["open_ms"] = (time.perf_counter() - t0) * 1000
            img = None
            deadline = time.monotonic() + (timeout or cfg.timeout)
            while img is None and time.monotonic() < deadline:  # first frames of a stream can be empty
                img = src.read()
            if img is None:
                raise SourceError("connected, but no video frame arrived")
            box["img"], box["fps"] = img, src.fps
        except SourceError as e:
            box["error"] = str(e)
        except Exception as e:  # surfaced verbatim: this is a diagnostic tool
            box["error"] = f"{type(e).__name__}: {e}"
        finally:
            src.close()

    th = threading.Thread(target=run, daemon=True, name="probe")
    th.start()
    th.join((timeout or cfg.timeout) * 2 + 2)
    if th.is_alive():
        result["message"] = f"timed out after {(timeout or cfg.timeout) * 2 + 2:.0f}s"
        return result
    if "error" in box:
        result["message"] = box["error"]
        return result
    img = box["img"]
    h, w = img.shape[:2]
    thumb = cv2.resize(img, (320, max(1, round(h * 320 / w))), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", thumb, [cv2.IMWRITE_JPEG_QUALITY, 80])
    import base64

    result.update(ok=True, width=w, height=h, fps=round(box.get("fps") or 0.0, 2),
                  open_ms=round(box.get("open_ms", 0.0)), total_ms=round((time.perf_counter() - t0) * 1000),
                  thumbnail=base64.b64encode(jpg.tobytes()).decode("ascii") if ok else "",
                  message=f"{w}x{h}" + (f" @ {box['fps']:.1f} fps" if box.get("fps") else ""))
    return result


# ====================================================================== capture thread
class FrameGrabber:
    def __init__(self, stream_id: str, cfg: SourceConfig, max_width: int = 960,
                 source_factory: Callable[[SourceConfig, int], StreamSource] = make_source, decode_threads: int = 1) -> None:
        self.stream_id = stream_id
        self.decode_threads = decode_threads
        self.cfg = cfg
        self.max_width = max_width
        self.source_factory = source_factory
        self.state: SourceState = "stopped"
        self.message = ""
        self.native_fps = 0.0
        self.frame_size: tuple[int, int] | None = None
        self.capture_fps = 0.0
        # health counters
        self.frames_captured = 0
        self.frames_dropped = 0  # overwritten before the pipeline took them (stale; by design, never queued)
        self.reconnects = 0
        self.last_error = ""
        self._last_live = 0.0
        self._latest: Frame | None = None
        self._taken_seq = 0
        self._seq = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=f"grab-{self.stream_id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)
        self._thread = None
        with self._lock:
            self._latest = None
        self.state = "stopped"
        self.capture_fps = 0.0

    def latest(self) -> Frame | None:
        with self._lock:
            return self._latest

    def mark_taken(self, seq: int) -> None:
        self._taken_seq = max(self._taken_seq, seq)

    # ------------------------------------------------------------ capture loop
    def _failing(self, msg: str, delay: float) -> None:
        self.last_error = msg
        down_for = time.monotonic() - (self._last_live or self._started)
        self.state = "offline" if down_for > OFFLINE_AFTER else "reconnecting"
        self.message = f"{msg} (retry in {delay:.0f}s)"

    def _run(self) -> None:
        delay = self.cfg.reconnect_delay
        opened_before = False
        rewinding = False
        self._started = time.monotonic()
        src = self.source_factory(self.cfg, self.max_width)  # one object, re-opened on loop / reconnect
        while not self._stop.is_set():
            if not src.available():
                self.state, self.message = "no_source", f"not found: {src.describe()}"
                self._stop.wait(self.cfg.reconnect_delay)  # keep polling so a dropped-in file is picked up
                continue
            if not rewinding and self.state not in ("reconnecting", "offline"):
                self.state, self.message = ("reconnecting" if opened_before else "connecting"), ""
            try:
                set_decode_threads(self.decode_threads)
                src.open()
            except SourceError as e:
                src.close()
                self._failing(str(e), delay)
                log.warning("[%s] %s; retry in %.0fs", self.stream_id, e, delay)
                self._stop.wait(delay)
                delay = min(delay * 2, self.cfg.max_reconnect_delay)
                continue
            except Exception as e:  # never let one camera kill the process
                src.close()
                self._failing(f"{type(e).__name__}: {e}", delay)
                log.exception("[%s] unexpected error opening %s", self.stream_id, src.describe())
                self._stop.wait(delay)
                delay = min(delay * 2, self.cfg.max_reconnect_delay)
                continue

            delay = self.cfg.reconnect_delay
            if opened_before and not rewinding:
                self.reconnects += 1
            opened_before = True
            self.native_fps = src.fps or (25.0 if src.recorded else 0.0)
            if not rewinding:
                log.info("[%s] opened %s (%s fps)", self.stream_id, src.describe(),
                         f"{self.native_fps:.1f}" if self.native_fps else "unknown")
            rewinding = False
            try:
                frames = self._read_loop(src)
            except Exception:
                log.exception("[%s] capture loop crashed; reconnecting", self.stream_id)
                frames = 0
            finally:
                src.close()
            if self._stop.is_set():
                break
            if src.recorded and self.cfg.loop and frames > 0:
                # End of a recorded clip: reopen at once to loop. Reopening (instead of seeking to
                # frame 0) also works for raw NVR streams (.cpv/.h265) that have no seek index.
                rewinding = True
                continue
            log.warning("[%s] stream ended or dropped - reconnecting", self.stream_id)
            self._failing("stream dropped", self.cfg.reconnect_delay)
            self._stop.wait(self.cfg.reconnect_delay)

    def _read_loop(self, src: StreamSource) -> int:
        """Read until the source ends or fails; returns the number of frames delivered."""
        pace = src.recorded
        period = 1.0 / (self.native_fps or 25.0)
        next_t = time.monotonic()
        fps_count, fps_t0 = 0, time.monotonic()
        frames = 0
        while not self._stop.is_set():
            img = src.read()
            if img is None:
                return frames
            frames += 1
            small = self._resize(img)
            now = time.monotonic()
            with self._lock:
                if self._latest is not None and self._latest.seq > self._taken_seq:
                    self.frames_dropped += 1
                self._seq += 1
                self._latest = Frame(small, self._seq, now, None if small is img else img)
            self.frames_captured += 1
            self._last_live = now
            self.state, self.frame_size, self.message = "live", (small.shape[1], small.shape[0]), ""

            fps_count += 1
            if now - fps_t0 >= 1.0:
                self.capture_fps = fps_count / (now - fps_t0)
                fps_count, fps_t0 = 0, now

            if pace:  # pace playback to real time; if we fell behind, skip ahead instead of lagging
                next_t += period
                sleep = next_t - time.monotonic()
                if sleep > 0:
                    self._stop.wait(sleep)
                elif sleep < -0.5:
                    next_t = time.monotonic()
        return frames

    def _resize(self, img: np.ndarray) -> np.ndarray:
        h, w = img.shape[:2]
        if self.max_width and w > self.max_width:
            img = cv2.resize(img, (self.max_width, round(h * self.max_width / w)), interpolation=cv2.INTER_AREA)
        return img

    def health(self) -> dict[str, Any]:
        cap = max(1, self.frames_captured)
        return {"captured": self.frames_captured, "dropped": self.frames_dropped,
                "drop_rate": round(self.frames_dropped / cap, 3), "reconnects": self.reconnects,
                "last_error": self.last_error}
