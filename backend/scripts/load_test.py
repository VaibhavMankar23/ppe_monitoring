"""Load test: run the full pipeline with N cameras and report per-camera throughput, latency and engine load.

    python scripts/load_test.py --counts 4 6 8 10 12 --seconds 45 [--extra rtsp://... http://...]
    python scripts/load_test.py --counts 12 --set inference.max_batch=4      # tuning runs

Cameras are the `streams` of backend/config.yaml, repeated to reach N (so each file is decoded by
several cameras at once, exactly like N real cameras), plus any --extra network URLs (rtsp:// / http://)
mixed in first. Violations go to an in-memory database. Prints a table and writes JSON (--json).
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import statistics
import sys
import time
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import default_config_path, parse_config  # noqa: E402
from app.pipeline import Monitor  # noqa: E402
from app.violations_db import ViolationStore  # noqa: E402


def build(raw: dict, n: int, extra: list[str], overrides: list[str]) -> dict:
    cfg = copy.deepcopy(raw)
    base = [s for s in cfg["streams"]]
    streams = []
    for i, url in enumerate(extra):
        kind = "rtsp" if url.startswith("rtsp") else "http"
        streams.append({"id": f"net{i + 1}", "name": f"{kind.upper()} {i + 1}", "required_ppe": ["helmet", "vest"],
                        "source": {"type": kind, "uri": url, "timeout": 10}})
    i = 0
    while len(streams) < n:
        s = copy.deepcopy(base[i % len(base)])
        s["id"], s["name"], s["enabled"] = f"lt{i + 1}", f"Load {i + 1}", True
        streams.append(s)
        i += 1
    cfg["streams"] = streams[:n]
    for o in overrides:
        key, val = o.split("=", 1)
        node = cfg
        *path, last = key.split(".")
        for p in path:
            node = node.setdefault(p, {})
        node[last] = yaml.safe_load(val)
    return cfg


def run(raw: dict, cfg_dir: Path, n: int, seconds: float, warmup: float, extra: list[str], overrides: list[str]) -> dict:
    cfg = parse_config(build(raw, n, extra, overrides), cfg_dir)
    mon = Monitor(cfg, store=ViolationStore(":memory:"))
    t0 = time.monotonic()
    mon.start()
    startup = time.monotonic() - t0
    time.sleep(warmup)
    mon.health()  # prime psutil's CPU counters
    base = {w.id: (w.frames_processed, w.grabber.frames_captured, w.grabber.frames_dropped) for w in mon.workers.values()}
    samples, util, cpu, lat = [], [], [], []
    t1 = time.monotonic()
    while time.monotonic() - t1 < seconds:
        time.sleep(2.0)
        h = mon.health()
        samples.append(h)
        util.append(h["capacity"]["engine_utilization"])
        cpu.append(h["host"].get("cpu_percent", 0.0))
        lat += [c["latency_ms"] for c in h["cameras"] if c["latency_ms"]]
    span = time.monotonic() - t1
    per_cam = []
    for w in mon.workers.values():
        p0, c0, d0 = base[w.id]
        per_cam.append({"id": w.id, "type": w.cfg.source.type, "status": w.status,
                        "fps": (w.frames_processed - p0) / span,
                        "capture_fps": (w.grabber.frames_captured - c0) / span,
                        "dropped": w.grabber.frames_dropped - d0, "reconnects": w.grabber.reconnects})
    eng = samples[-1]["engines"][0] if samples and samples[-1]["engines"] else {}
    mon.stop()
    fps = [c["fps"] for c in per_cam]
    live = [c for c in per_cam if c["capture_fps"] > 0]
    return {
        "cameras": n, "startup_s": round(startup, 1), "overrides": overrides,
        "fps_mean": round(statistics.mean(fps), 2), "fps_min": round(min(fps), 2), "fps_total": round(sum(fps), 1),
        "latency_p50_ms": round(statistics.median(lat)) if lat else None,
        "latency_p95_ms": round(sorted(lat)[int(len(lat) * 0.95) - 1]) if lat else None,
        "engine_util": round(statistics.mean(util), 3), "avg_batch": eng.get("avg_batch"), "avg_call_ms": eng.get("avg_call_ms"),
        "cpu_percent": round(statistics.mean(cpu), 1),
        "drop_rate": round(sum(c["dropped"] for c in live) / max(1, sum(c["capture_fps"] * span for c in live)), 3),
        "not_live": [c["id"] for c in per_cam if c["status"] != "live"],
        "per_camera": per_cam,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--counts", type=int, nargs="+", default=[4, 8, 12])
    ap.add_argument("--seconds", type=float, default=45)
    ap.add_argument("--warmup", type=float, default=15)
    ap.add_argument("--extra", nargs="*", default=[], help="network camera URLs mixed in (rtsp:// or http://)")
    ap.add_argument("--files", nargs="*", default=[], help="use these video files as the cameras instead of config.yaml's")
    ap.add_argument("--fps", type=float, default=0, help="playback fps for --files (0 = the file's own)")
    ap.add_argument("--set", dest="overrides", action="append", default=[], help="config override, e.g. inference.max_batch=4")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    path = Path(args.config).resolve() if args.config else default_config_path()
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if args.files:
        raw["streams"] = [{"id": f"f{i}", "name": Path(f).name, "required_ppe": ["helmet", "vest"],
                           "source": {"type": "file", "uri": str(Path(f).resolve()), "fps": args.fps}}
                          for i, f in enumerate(args.files)]
    results = []
    for n in args.counts:
        print(f"--- {n} cameras {' '.join(args.overrides)} ...", flush=True)
        r = run(raw, path.parent, n, args.seconds, args.warmup, args.extra, args.overrides)
        results.append(r)
        print(f"  detection fps/camera mean {r['fps_mean']:.2f} (min {r['fps_min']:.2f}, total {r['fps_total']}) | "
              f"latency p50 {r['latency_p50_ms']} ms p95 {r['latency_p95_ms']} ms | engine {r['engine_util']:.0%} busy, "
              f"batch {r['avg_batch']}, {r['avg_call_ms']} ms/call | CPU {r['cpu_percent']}% | not live: {r['not_live'] or '-'}",
              flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
