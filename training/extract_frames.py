"""Extract a varied set of training frames from the NVR recordings.

    python training/extract_frames.py <video> [--out datasets/plant_ppe/images] [--keep 260]

One candidate is taken every --every seconds. Each candidate gets a motion score (how much it
differs from the previous candidate), then --keep frames are selected per video: mostly the
busiest moments (people moving), spaced at least --gap seconds apart, plus a share of quiet
frames so the model also sees the empty scene. Frames are saved at full resolution.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", default="datasets/plant_ppe/images")
    ap.add_argument("--keep", type=int, default=260)
    ap.add_argument("--every", type=float, default=2.0, help="seconds between candidates")
    ap.add_argument("--gap", type=float, default=6.0, help="min seconds between kept frames")
    ap.add_argument("--quiet-share", type=float, default=0.15)
    ap.add_argument("--fps", type=float, default=0, help="override when the container has no frame rate")
    ap.add_argument("--max-frames", type=int, default=0, help="stop early (smoke test)")
    a = ap.parse_args()

    src = Path(a.video)
    out = Path(a.out)
    tmp = out.parent / "_candidates" / src.stem
    out.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise SystemExit(f"cannot open {src}")
    fps = a.fps or cap.get(cv2.CAP_PROP_FPS) or 25.0
    if not 1 <= fps <= 120:  # raw NVR exports often report nonsense
        fps = 25.0
    step = max(1, round(fps * a.every))
    cands: list[tuple[int, float]] = []  # (frame index, motion score)
    prev = None
    i = 0
    t0 = time.time()
    misses = 0
    while True:
        if not cap.grab():
            # raw NVR exports have the odd undecodable frame: only a long run of failures is the end
            misses += 1
            if misses > 100:
                break
            continue
        misses = 0
        if i % step == 0:
            ok, frame = cap.retrieve()
            if ok and frame is not None:
                small = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2GRAY).astype(np.int16)
                score = 0.0 if prev is None else float(np.mean(np.abs(small - prev) > 18))
                prev = small
                cv2.imwrite(str(tmp / f"{i:07d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
                cands.append((i, score))
        i += 1
        if a.max_frames and i >= a.max_frames:
            break
    cap.release()
    took = time.time() - t0

    # busiest first, enforcing a time gap so near-duplicates don't crowd the set
    gap = a.gap * fps
    n_quiet = int(a.keep * a.quiet_share)
    chosen: list[int] = []
    for idx, _ in sorted(cands, key=lambda c: -c[1]):
        if len(chosen) >= a.keep - n_quiet:
            break
        if all(abs(idx - c) >= gap for c in chosen):
            chosen.append(idx)
    rest = [idx for idx, _ in cands if all(abs(idx - c) >= gap for c in chosen)]
    random.Random(0).shuffle(rest)
    for idx in rest:
        if len(chosen) >= a.keep:
            break
        if all(abs(idx - c) >= gap for c in chosen):
            chosen.append(idx)

    keep = set(chosen)
    for idx, _ in cands:
        f = tmp / f"{idx:07d}.jpg"
        if idx in keep:
            f.rename(out / f"{src.stem}__f{idx:07d}.jpg")
        else:
            f.unlink()
    tmp.rmdir()
    print(json.dumps({"video": src.name, "fps": fps, "frames_read": i, "candidates": len(cands), "kept": len(keep),
                      "seconds": round(took), "decode_fps": round(i / max(took, 1e-6))}))


if __name__ == "__main__":
    main()
