"""Busy servers: a camera may get a frame only every 2-3 s. Tracking and confirmation must still work."""

from __future__ import annotations

import time

import numpy as np

from app.config import load_config
from app.pipeline import StreamWorker
from app.ppe_logic import Detection
from app.sources import Frame
from app.tracker import ByteTracker
from app.violations_db import ViolationFilter, ViolationStore
from helpers import raw_config, write_config

H = 200.0
STEP = 2.5  # seconds between frames (0.4 fps)


def walker(i: int) -> Detection:
    """A worker walking right at ~0.6 body heights per second: no overlap between frames 2.5 s apart."""
    x = 50.0 + i * 0.6 * H * STEP
    return Detection("person", 0.9, (x, 100.0, x + 0.35 * H, 100.0 + H))


def test_walking_worker_keeps_one_id_at_0_4_fps():
    tr = ByteTracker(max_lost_seconds=2.0, min_hits=2)
    per_frame = [[t.track_id for t in tr.update([walker(i)], i * STEP)] for i in range(5)]
    assert all(len(f) == 1 for f in per_frame)  # tracked (and shown) on every frame ...
    assert len({f[0] for f in per_frame}) == 1  # ... under one ID


def test_two_workers_crossing_paths_keep_their_own_ids():
    tr = ByteTracker(max_lost_seconds=2.0, min_hits=1)
    a0 = Detection("person", 0.9, (100, 100, 170, 300))
    b0 = Detection("person", 0.9, (600, 100, 670, 300))
    first = {round(t.box[0]): t.track_id for t in tr.update([a0, b0], 0.0)}
    a1 = Detection("person", 0.9, (200, 100, 270, 300))  # each moved 100 px towards the other
    b1 = Detection("person", 0.9, (500, 100, 570, 300))
    second = {round(t.box[0]): t.track_id for t in tr.update([a1, b1], STEP)}
    assert second[200] == first[100] and second[500] == first[600]


def test_violation_is_confirmed_on_a_slow_camera(tmp_path):
    raw = raw_config(tmp_path, n_streams=1)
    raw["streams"][0]["required_ppe"] = ["helmet"]
    raw["alerts"].update(min_violation_frames=6, min_violation_seconds=1, cooldown_seconds=30)
    raw["alerts"]["evidence_imgsz"] = 0
    cfg = load_config(write_config(tmp_path, raw))
    store = ViolationStore(":memory:")
    w = StreamWorker(cfg.streams[0], cfg, store)
    img = np.zeros((600, 1400, 3), dtype=np.uint8)
    t0 = time.monotonic()
    for i in range(5):  # in view for 10 s, one frame every 2.5 s, no helmet
        w._process(Frame(img, i + 1, t0 + i * STEP), [walker(i)], 5.0, 1)
    items = store.list(ViolationFilter())["items"]
    assert len(items) == 1 and items[0]["missing"] == ["helmet"]
    store.close()


def test_worker_re_tracked_on_a_slow_camera_stays_one_violation():
    """Case from the plant (violations #1165 / #1167): the tracker lost a walking worker and picked
    him up under another ID 2 s later, a body height further on. One worker, one event."""
    from app.ppe_logic import PersonCompliance
    from app.violations import AlertDebouncer

    deb = AlertDebouncer(min_frames=2, cooldown=30.0)
    def p(tid, x):
        return PersonCompliance(tid, (x, 100.0, x + 70.0, 300.0), 0.9, "non_compliant", {"helmet": "missing"}, [])
    fired = []
    for i, x in enumerate((100, 160, 220)):  # track 217 walks right, confirmed
        fired += deb.step([p(217, x)], i * STEP).fired
    for i, x in enumerate((420, 480, 540)):  # lost; 2.5 s later track 215 is him again, ~1 height further
        fired += deb.step([p(215, x)], (3 + i) * STEP).fired
    assert len(fired) == 1


def test_two_workers_one_after_the_other_far_apart_stay_two():
    from app.ppe_logic import PersonCompliance
    from app.violations import AlertDebouncer

    deb = AlertDebouncer(min_frames=2, cooldown=30.0)
    def p(tid, x):
        return PersonCompliance(tid, (x, 100.0, x + 70.0, 300.0), 0.9, "non_compliant", {"helmet": "missing"}, [])
    fired = []
    for i in range(3):
        fired += deb.step([p(1, 100)], i * STEP).fired
    for i in range(3):  # someone else appears 4 body heights away
        fired += deb.step([p(2, 900)], (3 + i) * STEP).fired
    assert len(fired) == 2
