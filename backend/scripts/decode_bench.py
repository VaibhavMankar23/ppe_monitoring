"""How many cameras can this machine *decode*? Runs only the capture threads (no model) for N cameras
and reports the achieved capture rate and CPU. Decoding is often the real limit on CPU-only boxes.

    python scripts/decode_bench.py --counts 4 8 12 --seconds 15 [--threads 1]
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--counts", type=int, nargs="+", default=[4, 8, 12])
    ap.add_argument("--seconds", type=float, default=15)
    ap.add_argument("--threads", type=int, default=0, help="FFmpeg decoder threads per camera (0 = FFmpeg default)")
    args = ap.parse_args()
    if args.threads:
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;tcp|threads;{args.threads}"
    import psutil

    from app.config import load_config
    from app.sources import FrameGrabber

    cfg = load_config()
    srcs = [s.source for s in cfg.streams]
    for n in args.counts:
        gs = [FrameGrabber(f"d{i}", srcs[i % len(srcs)], cfg.inference.process_width) for i in range(n)]
        for g in gs:
            g.start()
        time.sleep(5)
        psutil.cpu_percent(None)
        c0 = [g.frames_captured for g in gs]
        time.sleep(args.seconds)
        cpu = psutil.cpu_percent(None)
        rates = [(g.frames_captured - c) / args.seconds for g, c in zip(gs, c0)]
        for g in gs:
            g.stop()
        print(f"{n:2d} cameras: capture {sum(rates) / n:5.1f} fps/camera (source 20, min {min(rates):.1f}) | CPU {cpu:.0f}%"
              f"{' | threads=' + str(args.threads) if args.threads else ''}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
