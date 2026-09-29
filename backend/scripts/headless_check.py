"""Run the full pipeline without the web server and report per-stream performance.

    python scripts/headless_check.py --seconds 30 [--config path] [--save-dir out/]

Prints FPS / inference latency / people / violations per stream every few seconds and
a summary at the end; optionally writes the last annotated frame of each stream.
"""

from __future__ import annotations

import argparse
import logging
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import load_config  # noqa: E402
from app.pipeline import Monitor  # noqa: E402
from app.violations_db import ViolationFilter, ViolationStore  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--warmup", type=float, default=5.0, help="seconds excluded from the averages")
    ap.add_argument("--save-dir", default=None)
    ap.add_argument("--persist", action="store_true", help="store violations in the configured DB (default: in-memory)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")

    cfg = load_config(args.config)
    # in-memory DB by default so test runs don't pollute the real violation history
    mon = Monitor(cfg, store=ViolationStore(cfg.alerts.db_path if args.persist else ":memory:"))
    mon.start()
    samples: dict[str, list[tuple[float, float, float]]] = {w: [] for w in mon.workers}
    t0 = time.monotonic()
    try:
        while (el := time.monotonic() - t0) < args.seconds:
            time.sleep(2.0)
            snap = mon.snapshot()
            line = []
            for s in snap["streams"]:
                if el > args.warmup and s["fps"] > 0:
                    samples[s["id"]].append((s["fps"], s["infer_ms"], s["latency_ms"]))
                line.append(f"{s['id']}[{s['status']}] {s['fps']:4.1f}fps inf={s['infer_ms']:5.0f}ms(b{s['batch']}) "
                            f"lat={s['latency_ms']:5.0f}ms ppl={s['workers']} bad={s['violations']}")
            print(f"t={el:5.1f}s | " + " | ".join(line), flush=True)
    finally:
        if args.save_dir:
            out = Path(args.save_dir)
            out.mkdir(parents=True, exist_ok=True)
            for sid, w in mon.workers.items():
                _, jpg = w.jpeg()
                if jpg:
                    (out / f"{sid}.jpg").write_bytes(jpg)
            import base64
            for item in mon.store.list(ViolationFilter(), limit=20)["items"]:
                full = mon.store.get(item["id"]) or {}
                (out / f"violation_{item['id']}_{item['stream_id']}.jpg").write_bytes(base64.b64decode(full.get("image", "")))
        snap = mon.snapshot()
        mon.stop()

    print("\n==== SUMMARY  device=%s imgsz=%s mode=%s ====" % (snap["device"], snap["imgsz"], snap["mode"]))
    for sid, rows in samples.items():
        s = next(x for x in snap["streams"] if x["id"] == sid)
        if rows:
            fps = statistics.mean(r[0] for r in rows)
            inf = statistics.mean(r[1] for r in rows)
            lat = statistics.mean(r[2] for r in rows)
            print(f"{sid}: avg {fps:.1f} fps | infer {inf:.0f} ms/batch | e2e latency {lat:.0f} ms | "
                  f"frames {s['frames_processed']} | alerts {s['alerts_total']}")
        else:
            print(f"{sid}: no frames processed (status={s['status']} {s['message']})")
    print(f"total alerts this run: {snap['alerts_session']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
