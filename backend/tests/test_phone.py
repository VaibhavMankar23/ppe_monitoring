"""Phone-usage (behavioural) detection: association, evaluation, smoothing and refine-merge."""

from __future__ import annotations

import time

import numpy as np

from app.annotate import violation_text
from app.config import load_config
from app.pipeline import StreamWorker
from app.ppe_logic import (
    BEHAVIOR_ITEMS, ComplianceSmoother, Detection, TrackedPerson,
    behavior_status, evaluate_frame, merge_refined,
)
from app.sources import Frame
from app.violations_db import ViolationFilter, ViolationStore
from helpers import raw_config, write_config

PERSON = TrackedPerson(track_id=1, box=(100, 100, 200, 300), conf=0.9)  # 100x200 px
PHONE_IN_HAND = Detection("phone", 0.8, (150, 150, 170, 185))  # inside the hands/face zone
PHONE_FAR = Detection("phone", 0.8, (600, 600, 620, 640))      # nowhere near the worker


def _one(people):
    assert len(people) == 1
    return people[0]


def test_phone_in_zone_is_a_violation():
    p = _one(evaluate_frame([PERSON], [PHONE_IN_HAND], ["helmet"], behaviors=["phone_use"],
                            missing_policy="negative_only"))
    assert p.items["phone_use"] == "missing"
    assert "phone_use" in p.missing
    assert p.status == "non_compliant"
    assert PHONE_IN_HAND in p.ppe  # associated to this worker


def test_no_phone_is_compliant():
    p = _one(evaluate_frame([PERSON], [], ["helmet"], behaviors=["phone_use"],
                            detectable={"helmet"}, missing_policy="negative_only"))
    # helmet unknown (negative_only, none seen) but phone_use present -> not a violation
    assert p.items["phone_use"] == "present"
    assert "phone_use" not in p.missing


def test_distant_phone_not_attributed():
    p = _one(evaluate_frame([PERSON], [PHONE_FAR], ["helmet"], behaviors=["phone_use"],
                            missing_policy="negative_only"))
    assert p.items["phone_use"] == "present"


def test_behaviors_off_ignores_phone():
    """A camera without detect_phone must never grow a phone_use item, even if a phone is present."""
    p = _one(evaluate_frame([PERSON], [PHONE_IN_HAND], ["helmet"], missing_policy="negative_only"))
    assert "phone_use" not in p.items


def test_small_person_phone_unknown():
    tiny = TrackedPerson(track_id=2, box=(100, 100, 120, 140), conf=0.9)  # 40 px tall
    phone = Detection("phone", 0.8, (105, 110, 115, 125))
    p = _one(evaluate_frame([tiny], [phone], ["helmet"], behaviors=["phone_use"], min_person_height=60))
    assert p.items["phone_use"] == "unknown"


def test_behavior_status_helper():
    assert behavior_status([PHONE_IN_HAND], "phone_use") == "missing"
    assert behavior_status([], "phone_use") == "present"


def test_phone_use_smoothing():
    """Majority vote over the window keeps a one-frame flicker from raising a phone violation."""
    sm = ComplianceSmoother(window=5)
    seq = ["present", "present", "missing", "present", "present"]  # one stray frame
    last = "present"
    for s in seq:
        last = sm.update(1, {"phone_use": s})["phone_use"]
    assert last == "present"  # 1 missing vs 4 present -> stays OK


def test_merge_refined_keeps_phone_inside_refined_person():
    """The crop refine pass (PPE only) must not delete a phone detection over a refined worker."""
    refined = [(100.0, 100.0, 200.0, 300.0)]
    first_pass = [Detection("helmet", 0.7, (120, 90, 160, 130)), PHONE_IN_HAND]
    crop_ppe = [Detection("helmet", 0.9, (122, 92, 158, 128))]  # sharper helmet from the crop
    out = merge_refined(first_pass, refined, crop_ppe)
    assert any(d.cls == "phone" for d in out)          # phone survived
    assert sum(d.cls == "helmet" for d in out) == 1    # helmet replaced, not duplicated


def test_violation_text_separates_ppe_and_behavior():
    assert violation_text(3, ["helmet", "phone_use"]) == "#3 NO helmet PHONE"
    assert violation_text(4, ["phone_use"]) == "#4 PHONE"
    assert violation_text(5, ["vest"]) == "#5 NO vest"


def test_phone_use_is_a_registered_behavior():
    assert "phone_use" in BEHAVIOR_ITEMS


def test_pipeline_stores_phone_use_violation(tmp_path):
    """Detection('phone') on a worker -> a stored violation whose `missing` is ['phone_use']."""
    raw = raw_config(tmp_path, n_streams=1)
    raw["streams"][0].update(required_ppe=[], detect_phone=True)  # isolate the phone check
    raw["alerts"].update(min_violation_frames=2, min_violation_seconds=0, cooldown_seconds=30, drop_unconfirmed=False)
    cfg = load_config(write_config(tmp_path, raw))
    assert cfg.streams[0].detect_phone is True

    store = ViolationStore(":memory:")
    w = StreamWorker(cfg.streams[0], cfg, store)
    w.run_id = "cam1-test"
    assert w.behaviors == ["phone_use"]  # detect_phone -> behaviour wired into the worker

    img = np.zeros((360, 640, 3), dtype=np.uint8)
    person = Detection("person", 0.9, (100.0, 40.0, 180.0, 320.0))
    phone = Detection("phone", 0.8, (130.0, 150.0, 150.0, 180.0))  # in the worker's hands/face zone
    for i in range(10):
        w._process(Frame(img, i + 1, time.monotonic()), [person, phone], 5.0, 1)

    items = store.list(ViolationFilter())["items"]
    assert len(items) == 1
    assert items[0]["missing"] == ["phone_use"]
    # and the ppe-filter path the Violations page uses selects it
    assert store.list(ViolationFilter(ppe="phone_use"))["total"] == 1
    store.close()


class _Stub:
    """A model-free detector returning a fixed per-frame result (like helpers.FakeDetector)."""

    device, imgsz = "fake", 480

    def __init__(self, classes, result):
        self.classes = classes
        self._result = result

    def predict(self, frames, conf, imgsz=None):
        return [list(self._result) for _ in frames]


def test_composite_merges_phone_and_filters_secondary():
    from app.detector import CompositeDetector

    primary = _Stub(["person", "helmet"], [Detection("person", 0.9, (0, 0, 10, 30)),
                                           Detection("helmet", 0.8, (0, 0, 10, 5))])
    # secondary (COCO) also detects persons; only "phone" should be merged in, not the duplicate person
    secondary = _Stub(["person", "phone"], [Detection("phone", 0.7, (2, 2, 6, 6)),
                                            Detection("person", 0.6, (0, 0, 10, 30))])
    comp = CompositeDetector(primary, secondary)
    assert "phone" in comp.classes

    full = comp.predict([None], 0.3)[0]
    classes = [d.cls for d in full]
    assert classes.count("phone") == 1
    assert classes.count("person") == 1  # secondary's person filtered out

    # crop / evidence pass (imgsz set): primary only, no second-model run
    crop = comp.predict([None], 0.3, imgsz=320)[0]
    assert all(d.cls != "phone" for d in crop)


def test_checks_the_model_cannot_do_are_reported_and_not_evaluated(tmp_path):
    """detect_phone without a phone model, and required PPE without a class: listed as `unenforced`,
    and workers carry no phone_use item (the UI must not suggest phone use is being checked)."""
    raw = raw_config(tmp_path, n_streams=1)
    raw["streams"][0].update(required_ppe=["helmet", "gloves"], detect_phone=True)
    cfg = load_config(write_config(tmp_path, raw))
    ppe_only = _Stub(["person", "helmet", "no_helmet"], [])
    store = ViolationStore(":memory:")
    w = StreamWorker(cfg.streams[0], cfg, store, detector=lambda: ppe_only)
    assert w.unenforced() == ["gloves", "phone_use"]
    person = Detection("person", 0.9, (100.0, 40.0, 180.0, 320.0))
    for i in range(4):
        w._process(Frame(np.zeros((360, 640, 3), np.uint8), i + 1, time.monotonic()), [person], 5.0, 1)
    people = w._meta.get("people", [])
    assert people and all("phone_use" not in p["items"] for p in people)
    assert w.snapshot()["unenforced"] == ["gloves", "phone_use"]
    with_phone = _Stub(["person", "helmet", "no_helmet", "gloves", "phone"], [])
    assert StreamWorker(cfg.streams[0], cfg, store, detector=lambda: with_phone).unenforced() == []
    store.close()
