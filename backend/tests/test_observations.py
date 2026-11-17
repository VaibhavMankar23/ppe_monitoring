"""Pipeline -> analytics: every judged worker is counted once per camera session, alerts carry the session id."""

from __future__ import annotations

import time

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import load_config
from app.pipeline import StreamWorker
from app.ppe_logic import Detection
from app.sources import Frame
from app.violations_db import ObservationRow, ViolationFilter, ViolationRow, ViolationStore
from helpers import raw_config, write_config


def test_worker_counts_workers_and_tags_violations_with_session(tmp_path):
    raw = raw_config(tmp_path, n_streams=1)
    raw["streams"][0]["required_ppe"] = ["helmet"]
    raw["alerts"].update(min_violation_frames=2, min_violation_seconds=0, cooldown_seconds=30)
    cfg = load_config(write_config(tmp_path, raw))
    store = ViolationStore(":memory:")
    w = StreamWorker(cfg.streams[0], cfg, store)
    w.run_id = "cam1-test"

    img = np.zeros((360, 640, 3), dtype=np.uint8)
    person = Detection("person", 0.9, (100.0, 40.0, 180.0, 320.0))  # tall enough to be judged, no helmet
    for i in range(12):
        w._process(Frame(img, i + 1, time.monotonic()), [person], 5.0, 1)

    items = store.list(ViolationFilter())["items"]
    assert len(items) == 1 and items[0]["missing"] == ["helmet"]  # debounced + deduped: one alert
    with Session(store.engine) as s:
        run = s.execute(select(ViolationRow.run_id)).scalar()
    assert run == "cam1-test"

    w._flush_observations()
    with Session(store.engine) as s:
        rows = s.execute(select(ObservationRow.seen, ObservationRow.violating)).all()
    assert [tuple(r) for r in rows] == [(1, 1)]  # one worker, seen once, flagged once - not once per frame
    store.close()


def test_worker_reacquired_under_a_new_track_id_is_counted_once(tmp_path):
    """Lost behind an obstacle for longer than the tracker keeps an ID, then back at the same spot:
    the tracker gives a new ID, but compliance counts it as the same person (seen 1, flagged 1)."""
    raw = raw_config(tmp_path, n_streams=1)
    raw["streams"][0]["required_ppe"] = ["helmet"]
    raw["alerts"].update(min_violation_frames=2, min_violation_seconds=0, cooldown_seconds=30)
    cfg = load_config(write_config(tmp_path, raw))
    store = ViolationStore(":memory:")
    w = StreamWorker(cfg.streams[0], cfg, store)
    img = np.zeros((360, 640, 3), dtype=np.uint8)
    t0 = time.monotonic()
    a = Detection("person", 0.9, (100.0, 40.0, 180.0, 320.0))
    b = Detection("person", 0.9, (130.0, 40.0, 210.0, 320.0))  # same worker a little further on
    for i in range(6):
        w._process(Frame(img, i + 1, t0 + i), [a], 5.0, 1)
    first_id = w.people[0].track_id
    for i in range(3):  # hidden for 3 s: longer than tracking.max_lost_seconds (2 s), so the ID is dropped
        w._process(Frame(img, 7 + i, t0 + 6 + i), [], 5.0, 1)
    for i in range(6):
        w._process(Frame(img, 10 + i, t0 + 9 + i), [b], 5.0, 1)
    assert w.people[0].track_id != first_id  # the tracker did hand out a new ID
    w._flush_observations()
    with Session(store.engine) as s:
        rows = s.execute(select(ObservationRow.seen, ObservationRow.violating)).all()
    assert sum(r[0] for r in rows) == 1 and sum(r[1] for r in rows) == 1
    store.close()
