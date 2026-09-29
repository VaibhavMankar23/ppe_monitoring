"""Box alignment regression tests: boxes must land on the worker's pixels, in the live overlay and in
the stored evidence snapshot.

A synthetic frame holds one bright rectangle (the "worker") at known full-resolution coordinates and
`BlobDetector` finds bright rectangles in whatever image it is given, so every coordinate transform
(process-res <-> full-res, crop offset, square letterbox, snapshot upscale) is checked against a
known answer. History: the tracked box comes from a coarse full-frame pass and is often a low-confidence
"coasting" box; snapshots showed it visibly offset from the worker (docs/PROJECT_WALKTHROUGH.md §14).
"""

from __future__ import annotations

import base64
import time

import cv2
import numpy as np
import pytest

from app.annotate import RED, violation_snapshot
from app.config import load_config
from app.pipeline import InferenceEngine, StreamWorker
from app.ppe_logic import Detection, PersonCompliance, match_person, refine_person_box
from app.sources import Frame
from app.violations import AlertDebouncer
from app.violations_db import ViolationFilter, ViolationStore
from helpers import raw_config, write_config

FULL_W, FULL_H = 1920, 1080
PROC_W, PROC_H = 960, 540
WORKER = (1203.0, 377.0, 1291.0, 641.0)  # ground truth, full-res pixels


class BlobDetector:
    """Returns one "person" box around the bright (>200) pixels of each image; nothing if none."""

    device, imgsz, classes = "blob", 480, ["person"]

    def predict(self, frames, conf, imgsz=None):
        out = []
        for img in frames:
            ys, xs = np.where(img.min(axis=2) > 200)
            out.append([Detection("person", 0.9, (float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)))]
                       if len(xs) else [])
        return out


def synthetic_frame(worker=WORKER) -> Frame:
    full = np.full((FULL_H, FULL_W, 3), 70, np.uint8)
    x1, y1, x2, y2 = map(int, worker)
    full[y1:y2, x1:x2] = 255
    small = cv2.resize(full, (PROC_W, PROC_H), interpolation=cv2.INTER_AREA)
    return Frame(small, 1, time.monotonic(), full)


def red_box(img: np.ndarray) -> tuple[int, int, int, int]:
    """Outer bounds of the red outline drawn by annotate._box (caption strip excluded)."""
    body = img[: int(img.shape[0] * 0.9)]
    m = np.all(np.abs(body.astype(int) - np.array(RED)) < 45, axis=2)
    ys, xs = np.where(m)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def white_box(img: np.ndarray) -> tuple[int, int, int, int]:
    body = img[: int(img.shape[0] * 0.9)]
    ys, xs = np.where(body.min(axis=2) > 200)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def strip_header(img: np.ndarray) -> np.ndarray:
    """The stored evidence image = info header band (dark, text on it) + the outlined crop: drop the band.
    The synthetic scene's grey background (70) never occurs in the header, so the crop starts at the
    first row showing it."""
    grey = np.all(np.abs(img.astype(int) - 70) <= 8, axis=2).mean(axis=1)
    return img[int(np.argmax(grey >= 0.3)):]


def assert_hugs(outline, worker, tol):
    """The drawn rectangle's centre line lies on the worker's edges within `tol` px."""
    for o, w in zip(outline, worker):
        assert abs(o - w) <= tol, (outline, worker)


# ------------------------------------------------------------------ the snapshot crop itself
@pytest.mark.parametrize("worker", [WORKER, (0.0, 0.0, 90.0, 260.0), (1800.0, 800.0, 1920.0, 1080.0), (600.0, 500.0, 640.0, 590.0)])
def test_snapshot_outline_sits_exactly_on_the_given_box(worker):
    frame = synthetic_frame(worker)
    snap = violation_snapshot(frame.full_res, worker, 5, ["helmet"])
    thick = max(2, round(snap.shape[0] / 180))
    # the worker's pixels (white) must be bounded by the outline, the outline hugging them
    assert_hugs(red_box(snap), white_box(snap), tol=thick + 3)


# ------------------------------------------------------------------ alert-time evidence re-detection
def make_worker(tmp_path, detector, **alerts) -> StreamWorker:
    raw = raw_config(tmp_path, n_streams=1)
    raw["alerts"].update(alerts)
    cfg = load_config(write_config(tmp_path, raw))
    return StreamWorker(cfg.streams[0], cfg, ViolationStore(":memory:"), detector=lambda: detector)


def sloppy(worker=WORKER, dx=9.0, dy=10.0, grow=1.15) -> tuple[float, float, float, float]:
    """A coarse, low-quality process-res box: shifted and too big, like a stage-2 tracker box
    (IoU ~0.6 with the truth; the worst stage-2 box measured on the NVR footage was 0.44)."""
    x1, y1, x2, y2 = (v / 2 for v in worker)
    cx, cy, w, h = (x1 + x2) / 2 + dx, (y1 + y2) / 2 + dy, (x2 - x1) * grow, (y2 - y1) * grow
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def person(box, conf=0.8) -> PersonCompliance:
    return PersonCompliance(3, box, conf, "non_compliant", {"helmet": "missing"})


def test_evidence_box_is_redetected_on_the_same_full_res_frame(tmp_path):
    w = make_worker(tmp_path, BlobDetector())
    box, confirmed = w.evidence_box(synthetic_frame(), person(sloppy()))
    assert confirmed is True
    assert_hugs(box, WORKER, tol=2)  # 640-px crop pass: ~1-2 px quantisation at full res


def test_stored_snapshot_outline_hugs_the_worker(tmp_path):
    w = make_worker(tmp_path, BlobDetector())
    w._record_violation(synthetic_frame(), person(sloppy()))
    item = w.store.list(ViolationFilter())["items"][0]
    img = cv2.imdecode(np.frombuffer(base64.b64decode(w.store.get(item["id"])["image"]), np.uint8), cv2.IMREAD_COLOR)
    img = strip_header(img)
    thick = max(2, round(img.shape[0] / 180))
    assert_hugs(red_box(img), white_box(img), tol=thick + 4)  # before the fix: off by ~25-40 px here


def test_without_evidence_pass_the_tracked_box_is_used_unchanged(tmp_path):
    w = make_worker(tmp_path, BlobDetector(), evidence_imgsz=0)
    coarse = sloppy()
    box, confirmed = w.evidence_box(synthetic_frame(), person(coarse))
    assert confirmed is None and box == tuple(v * 2 for v in coarse)


def test_phantom_person_is_dropped_or_kept_by_setting(tmp_path):
    empty = synthetic_frame((0.0, 0.0, 0.0, 0.0))  # no worker pixels at all
    empty.full[:] = 70
    w = make_worker(tmp_path, BlobDetector())
    w._record_violation(empty, person((400.0, 200.0, 440.0, 300.0)))
    assert w.store.list(ViolationFilter())["total"] == 0 and w.dropped_alerts == 1
    keep = make_worker(tmp_path, BlobDetector(), drop_unconfirmed=False)
    keep._record_violation(empty, person((400.0, 200.0, 440.0, 300.0)))
    assert keep.store.list(ViolationFilter())["total"] == 1


def test_alert_waits_for_a_confident_box():
    deb = AlertDebouncer(min_frames=2, cooldown=30)
    confident = lambda p: p.conf >= 0.35  # noqa: E731
    low, high = person(sloppy(), conf=0.2), person(sloppy(), conf=0.8)
    assert deb.update([low], 0.0, confident) == []
    assert deb.update([low], 0.2, confident) == []  # streak reached, but the box is coasting: wait
    assert deb.update([high], 0.4, confident) == [high]  # first confident frame fires
    assert deb.update([high], 0.6, confident) == []  # and only once


# ------------------------------------------------------------------ live overlay: crop-pass person box
def test_live_person_box_comes_from_the_full_res_crop(tmp_path):
    cfg = load_config(write_config(tmp_path, {**raw_config(tmp_path, 1), "inference": {"person_refine": True, "refine_imgsz": 320}}))
    engine = InferenceEngine("t", BlobDetector(), [], 0.15, cfg.inference)
    w = make_worker(tmp_path, BlobDetector())
    frame = synthetic_frame()
    coarse = Detection("person", 0.9, sloppy())
    out = engine._refine([(w, frame)], [[coarse]], 0.3)[0]
    p = next(d for d in out if d.cls == "person")
    assert_hugs(tuple(v * 2 for v in p.box), WORKER, tol=4)  # 320-px crop: ~3 px at full res


def test_refine_helpers():
    coarse = Detection("person", 0.3, (100.0, 100.0, 200.0, 400.0))
    good = Detection("person", 0.9, (104.0, 96.0, 196.0, 402.0))
    neighbour = Detection("person", 0.95, (300.0, 100.0, 400.0, 400.0))
    assert match_person(coarse, [neighbour, good]) is good  # overlap wins, not confidence
    assert refine_person_box(coarse, [good]).box == good.box
    assert refine_person_box(coarse, [neighbour]) is coarse  # no overlap: keep the coarse box
    assert match_person(coarse, []) is None
