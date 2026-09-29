"""Pipeline + store: one stored violation per incident (extended, then ended), evidence images and
provenance metadata, evidence retention, and that ack / delete / CSV keep working."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import time

import cv2
import numpy as np

from app.config import load_config
from app.pipeline import StreamWorker
from app.ppe_logic import Detection
from app.sources import Frame
from app.violations_db import ViolationFilter, ViolationStore
from helpers import raw_config, write_config

T0 = time.monotonic()
PERSON = Detection("person", 0.9, (100.0, 40.0, 180.0, 320.0))  # tall enough to be judged
NO_HELMET = Detection("no_helmet", 0.82, (115.0, 35.0, 165.0, 90.0))


class Stub:
    device, imgsz = "stub", 480
    classes = ["helmet", "no_helmet", "person", "vest", "no_vest"]
    info = {"weights": "stub.pt", "sha256": "abc123", "classes": classes}

    def predict(self, frames, conf, imgsz=None):
        return [[] for _ in frames]


def make(tmp_path, **alerts) -> StreamWorker:
    raw = raw_config(tmp_path, n_streams=1)
    raw["streams"][0]["required_ppe"] = ["helmet"]
    raw["alerts"].update({"min_violation_frames": 2, "min_violation_seconds": 1.0, "event_gap_seconds": 3,
                          "cooldown_seconds": 30, "evidence_imgsz": 0, **alerts})
    cfg = load_config(write_config(tmp_path, raw))
    w = StreamWorker(cfg.streams[0], cfg, ViolationStore(":memory:"), detector=lambda: Stub())
    w.run_id = "cam1-test"
    return w


def feed(w: StreamWorker, t: float, dets) -> None:
    img = np.zeros((360, 640, 3), np.uint8)
    img[40:320, 100:180] = 200
    w._process(Frame(img, int(t * 100) + 1, T0 + t), dets, 5.0, 1)


def rows(w):
    return w.store.list(ViolationFilter())["items"]


def test_continuous_violation_is_one_record_extended_then_ended(tmp_path):
    w = make(tmp_path)
    for i in range(60):  # 30 s without a helmet at 2 fps
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    assert len(rows(w)) == 1 and rows(w)[0]["state"] == "ongoing"
    for i in range(60, 72):  # worker leaves: the event ends after the 3 s gap
        feed(w, i * 0.5, [])
    (v,) = rows(w)
    assert v["state"] == "ended"
    assert v["observations"] >= 55  # every confirmed frame counted on the one record
    assert 27 <= v["duration"] <= 30.5
    assert v["missing"] == ["helmet"]


def test_worker_leaving_and_returning_after_the_cooldown_is_a_second_record(tmp_path):
    w = make(tmp_path, cooldown_seconds=10)
    for i in range(10):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    for i in range(10, 50):  # gone for 20 s: the event ended, cooldown passed
        feed(w, i * 0.5, [])
    for i in range(50, 60):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    assert len(rows(w)) == 2


def test_deleting_an_ongoing_violation_does_not_recreate_it(tmp_path):
    w = make(tmp_path)
    for i in range(10):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    vid = rows(w)[0]["id"]
    assert w.store.delete(vid)  # a reviewer deletes it as a false positive while it's still going on
    for i in range(10, 80):  # the same worker stays in view (throttled writes find the row gone)
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    for i in range(80, 90):
        feed(w, i * 0.5, [])
    assert rows(w) == []


def test_stopping_the_camera_ends_ongoing_events(tmp_path):
    w = make(tmp_path)
    for i in range(10):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    w.running = True  # stop() only acts on a running worker
    w.stop()
    assert rows(w)[0]["state"] == "ended"


def test_evidence_images_and_provenance_metadata(tmp_path):
    w = make(tmp_path)
    for i in range(6):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    v = w.store.get(rows(w)[0]["id"], extra=("original", "crop"))
    image, original, crop = (base64.b64decode(v[k]) for k in ("image", "original", "crop"))
    assert image and original and crop and v["has_original"] and v["has_crop"]
    full = cv2.imdecode(np.frombuffer(original, np.uint8), cv2.IMREAD_COLOR)
    assert full.shape[:2] == (360, 640)  # the untouched full frame
    m = v["meta"]
    assert m["model"]["weights"] == "stub.pt" and m["model"]["sha256"] == "abc123"
    assert m["camera"]["id"] == "cam1" and m["camera"]["run_id"] == "cam1-test"
    assert m["detection"]["items"]["helmet"]["confidence"] == 0.82 and v["confidence"] == 0.82
    assert m["settings"]["min_violation_frames"] == 2 and m["settings"]["min_violation_seconds"] == 1.0
    assert len(m["settings"]["config_sha256"]) == 16
    lc = m["lifecycle"]
    assert lc["detected_at"] <= lc["evidence_frame_at"] <= lc["confirmed_at"] and v["timestamp"] == lc["detected_at"]
    # tamper evidence: the stored bytes match the hashes recorded when the evidence was made
    for k, b in (("image", image), ("original", original), ("crop", crop)):
        assert m["evidence"]["sha256"][k] == hashlib.sha256(b).hexdigest()


def test_evidence_is_never_rewritten_by_later_observations(tmp_path):
    w = make(tmp_path)
    for i in range(6):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    vid = rows(w)[0]["id"]
    first = w.store.get(vid, extra=("original", "crop"))
    for i in range(6, 60):
        feed(w, i * 0.5, [PERSON, NO_HELMET, Detection("no_vest", 0.7, (110.0, 120.0, 170.0, 220.0))])
    later = w.store.get(vid, extra=("original", "crop"))
    assert all(first[k] == later[k] for k in ("image", "original", "crop", "thumbnail", "meta", "timestamp"))


def test_best_frame_is_chosen_for_the_evidence(tmp_path):
    w = make(tmp_path, min_violation_frames=4, min_violation_seconds=0)
    confs = [0.36, 0.95, 0.4, 0.37]  # the clearest look at the worker is the second frame
    for i, c in enumerate(confs):
        feed(w, i * 0.5, [Detection("person", c, PERSON.box), NO_HELMET])
    v = w.store.get(rows(w)[0]["id"])
    assert v["meta"]["detection"]["person_confidence"] == 0.95
    lc = v["meta"]["lifecycle"]
    assert abs((lc["confirmed_at"] - lc["evidence_frame_at"]) - 1.0) < 0.05  # frame 1 of 0..3 (0.5 s apart)


def test_saving_the_original_frame_can_be_turned_off(tmp_path):
    w = make(tmp_path, save_original_frame=False)
    for i in range(6):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    v = w.store.get(rows(w)[0]["id"], extra=("original",))
    assert v["has_original"] is False and v["original"] == "" and v["meta"]["evidence"]["sha256"]["original"] is None


def test_ack_delete_and_csv_still_work_on_event_records(tmp_path):
    w = make(tmp_path)
    for i in range(20):
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    vid = rows(w)[0]["id"]
    assert w.store.acknowledge(vid, "alice")["acknowledged_by"] == "alice"
    for i in range(20, 40):  # extending the event keeps the acknowledgement
        feed(w, i * 0.5, [PERSON, NO_HELMET])
    for i in range(40, 50):
        feed(w, i * 0.5, [])
    v = rows(w)[0]
    assert v["acknowledged_by"] == "alice" and v["state"] == "ended"
    table = list(csv.reader(io.StringIO(w.store.export_csv(ViolationFilter()))))
    assert table[0][:9] == ["id", "timestamp_utc", "local_time", "camera_id", "camera_name", "track_id", "missing_ppe",
                            "acknowledged_at_utc", "acknowledged_by"]  # unchanged for existing consumers
    row = dict(zip(table[0], table[1]))
    assert row["acknowledged_by"] == "alice" and float(row["duration_s"]) > 15 and row["model"] == "stub.pt"
    assert w.store.delete(vid) and rows(w) == []


# ------------------------------------------------------------------ store: evidence retention, restart
def _add(store, ts, **kw):
    return store.add("cam1", "C1", 1, ["helmet"], b"IMG", b"TH", ts=ts, original=b"ORIG", crop=b"CROP", **kw)["id"]


def test_evidence_retention_keeps_records_and_thumbnails():
    s = ViolationStore(":memory:")
    now = 1_800_000_000.0
    old, recent = _add(s, now - 10 * 86400), _add(s, now - 3600)
    ongoing = _add(s, now - 10 * 86400, ongoing=True)  # an event still going on is never purged
    assert s.purge_evidence(7, now=now) == 1
    o = s.get(old, extra=("original", "crop"))
    assert o["image"] == "" and o["original"] == "" and o["crop"] == "" and o["evidence_purged_at"] == now
    assert o["thumbnail"] == base64.b64encode(b"TH").decode() and o["missing"] == ["helmet"]
    assert s.get(recent)["image"] and s.get(ongoing)["image"]
    assert s.purge_evidence(7, now=now) == 0  # idempotent
    assert s.purge_evidence(0, now=now) == 0  # 0 = keep images as long as the record
    assert s.list(ViolationFilter())["total"] == 3  # records are only removed by retention_days


def test_events_left_open_by_a_previous_run_are_closed_on_start(tmp_path):
    db = str(tmp_path / "v.db")
    s = ViolationStore(db)
    vid = _add(s, 1_800_000_000.0, ongoing=True)
    s.close()
    s = ViolationStore(db)
    assert s.get(vid)["state"] == "ended"
    s.close()


def test_extend_reports_a_deleted_record_and_notifies_updates():
    s = ViolationStore(":memory:")
    seen = []
    s.subscribe_updates(seen.append)
    vid = _add(s, 1_800_000_000.0, ongoing=True)
    assert s.extend(vid, last_seen=1_800_000_012.0, observations=9, missing=["helmet", "vest"])
    v = s.get(vid)
    assert v["duration"] == 12.0 and v["observations"] == 9 and v["missing"] == ["helmet", "vest"]
    assert seen[-1] == {"id": vid, "last_seen": 1_800_000_012.0, "observations": 9, "state": "ongoing",
                        "missing": ["helmet", "vest"]}
    s.delete(vid)
    assert s.extend(vid, last_seen=1_800_000_013.0, observations=10) is False
