"""Serve a local video file as a network IP camera, to test RTSP / HTTP sources without hardware.

    # HTTP camera: MJPEG push at /video, single JPEG at /snapshot.jpg (optional Basic auth)
    python scripts/camera_emulator.py http ../videos/cam1.mp4 --port 8081 [--user u --password p] [--fps 10]

    # RTSP camera: ffmpeg re-publishes the file (codec copied, looped) as rtsp://127.0.0.1:8554/cam
    python scripts/camera_emulator.py rtsp ../videos/cam1.mp4 --port 8554
    #   needs an ffmpeg binary: on PATH, or `pip install imageio-ffmpeg` (used automatically)

Then add a camera with type http, uri http://127.0.0.1:8081/video (or rtsp, rtsp://127.0.0.1:8554/cam).
"""

from __future__ import annotations

import argparse
import base64
import http.server
import shutil
import subprocess
import sys
import threading
import time

import cv2


def ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found: put it on PATH or `pip install imageio-ffmpeg`")


class Player:
    """Decodes the file in a loop at `fps`, keeping only the latest JPEG."""

    def __init__(self, path: str, fps: float, width: int) -> None:
        self.path, self.fps, self.width = path, fps, width
        self.jpeg: bytes = b""
        self.seq = 0
        self.cond = threading.Condition()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        while True:
            cap = cv2.VideoCapture(self.path)
            src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            step = max(1, round(src_fps / self.fps)) if 0 < src_fps < 121 else 1
            i, t = 0, time.monotonic()
            while True:
                ok, img = cap.read()
                if not ok:
                    break
                i += 1
                if i % step:
                    continue
                h, w = img.shape[:2]
                if self.width and w > self.width:
                    img = cv2.resize(img, (self.width, round(h * self.width / w)), interpolation=cv2.INTER_AREA)
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                with self.cond:
                    self.jpeg, self.seq = buf.tobytes(), self.seq + 1
                    self.cond.notify_all()
                t += 1 / self.fps
                time.sleep(max(0.0, t - time.monotonic()))
            cap.release()


def serve_http(args: argparse.Namespace) -> None:
    player = Player(args.file, args.fps, args.width)
    expected = "Basic " + base64.b64encode(f"{args.user}:{args.password}".encode()).decode() if args.user else None

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):  # noqa: ANN002
            pass

        def _authorised(self) -> bool:
            if expected is None or self.headers.get("Authorization") == expected:
                return True
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="camera"')
            self.end_headers()
            return False

        def do_GET(self) -> None:  # noqa: N802
            if not self._authorised():
                return
            if self.path.startswith("/snapshot"):
                body = player.jpeg
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if not self.path.startswith("/video"):
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            last = -1
            try:
                while True:
                    with player.cond:
                        player.cond.wait_for(lambda: player.seq != last, timeout=5)
                        last, body = player.seq, player.jpeg
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(body) + body + b"\r\n")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    srv = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"HTTP camera: http://{args.host}:{args.port}/video (MJPEG) and /snapshot.jpg"
          + (" [Basic auth]" if expected else ""), flush=True)
    srv.serve_forever()


def serve_rtsp(args: argparse.Namespace) -> None:
    """ffmpeg in RTSP listen mode serves one client at a time; it's restarted when that client leaves."""
    url = f"rtsp://{args.host}:{args.port}/{args.path}"
    print(f"RTSP camera: {url}", flush=True)
    while True:
        cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", args.file,
               "-an", "-c:v", "copy", "-f", "rtsp", "-rtsp_flags", "listen", url]
        if args.transcode:
            cmd[cmd.index("copy")] = "libx264"
            cmd[cmd.index("-f"):cmd.index("-f")] = ["-preset", "veryfast", "-tune", "zerolatency", "-g", "20"]
        subprocess.run(cmd, check=False)
        time.sleep(0.5)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", choices=["http", "rtsp"])
    ap.add_argument("file")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--path", default="cam", help="RTSP path")
    ap.add_argument("--fps", type=float, default=10.0, help="HTTP: frames per second served")
    ap.add_argument("--width", type=int, default=1280, help="HTTP: downscale to this width (0 = native)")
    ap.add_argument("--user", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--transcode", action="store_true", help="RTSP: re-encode to H.264 instead of copying")
    args = ap.parse_args()
    args.port = args.port or (8081 if args.kind == "http" else 8554)
    serve_http(args) if args.kind == "http" else serve_rtsp(args)


if __name__ == "__main__":
    main()
