"""Detector efficiency: crop padding only where it is needed, a retry limit on evidence re-checks, and the
per-pass timers that show where the detector's time goes."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import cv2
import numpy as np

from app.config import load_config
from app.detector import YoloDetector
from app.passtimer import PassTimer, passes
from app.pipeline import VERIFY_RETRY_SECONDS, InferenceEngine, StreamWorker
from app.ppe_logic import Detection, PersonCompliance
from app.sources import Frame
from app.violations import Incident
from app.violations_db import ViolationStore
from helpers import raw_config, write_config


def frame_with_worker() -> Frame:
    full = np.full((1080, 1920, 3), 70, np.uint8)
    full[377:641, 1203:1291] = 255
    return Frame(cv2.resize(full, (960, 540), interpolation=cv2.INTER_AREA), 1, time.monotonic(), full)


class SpyDetector:
    """Records how many images each call carries; finds one person in every image."""

    classes = ["person"]
    imgsz = 480

    def __init__(self, device: str) -> None:
        self.device = device
        self.calls: list[tuple[int, int | None]] = []

    def predict(self, frames, conf, imgsz=None):
        self.calls.append((len(frames), imgsz))
        return [[Detection("person", 0.9, (10.0, 10.0, 60.0, 120.0))] for _ in frames]


def make_engine(tmp_path, device: str):
    inference = {"person_refine": True, "refine_imgsz": 320, "refine_batch": 8}
    cfg = load_config(write_config(tmp_path, {**raw_config(tmp_path, 1), "inference": inference}))
    spy = SpyDetector(device)
    worker = StreamWorker(cfg.streams[0], cfg, ViolationStore(":memory:"), detector=lambda: spy)
    return InferenceEngine("t", spy, [], 0.15, cfg.inference), spy, worker


def refine_one_person(engine, worker):
    coarse = Detection("person", 0.9, (600.0, 190.0, 650.0, 330.0))
    return engine._refine([(worker, frame_with_worker())], [[coarse]], 0.3)


# ------------------------------------------------------------------ 1. no blank crops on NVIDIA
def test_nvidia_crop_pass_sends_only_the_real_crops(tmp_path):
    passes.reset()
    engine, spy, worker = make_engine(tmp_path, "cuda:0")
    assert engine.pad_batches is False
    refine_one_person(engine, worker)
    crop_calls = [n for n, size in spy.calls if size == 320]
    assert crop_calls == [1]  # before: [8], one real crop and seven blank ones
    names = {c["name"] for c in passes.snapshot()["counters"]}
    assert "crops" in names and "blank_padding_crops" not in names


def test_intel_gpu_still_pads_to_a_fixed_shape(tmp_path):
    passes.reset()
    engine, spy, worker = make_engine(tmp_path, "intel:gpu")
    assert engine.pad_batches is True
    refine_one_person(engine, worker)
    assert [n for n, size in spy.calls if size == 320] == [8]  # this plugin recompiles for every new shape
    blanks = next(c for c in passes.snapshot()["counters"] if c["name"] == "blank_padding_crops")
    assert blanks["total"] == 7


def test_many_crops_are_still_split_into_calls_of_the_batch_size(tmp_path):
    engine, spy, worker = make_engine(tmp_path, "cuda:0")
    persons = [Detection("person", 0.9, (100.0 + 120 * i, 190.0, 150.0 + 120 * i, 330.0)) for i in range(5)]
    engine.icfg.refine_max_persons = 5
    engine.refine_batch = 2
    engine._refine([(worker, frame_with_worker())], [persons], 0.3)
    assert [n for n, size in spy.calls if size == 320] == [2, 2, 1]


# ------------------------------------------------------------------ 3. evidence re-check retry limit
def make_incident() -> Incident:
    return Incident(key=1, tracks={3}, missing={"helmet"}, box=(0.0, 0.0, 1.0, 1.0), start=0.0, last_seen=0.0)


def test_unconfirmed_new_item_is_rechecked_at_most_every_few_seconds(tmp_path, monkeypatch):
    engine, spy, worker = make_engine(tmp_path, "cuda:0")
    checks = []

    def not_found(frame, p):
        checks.append(1)
        return (0.0, 0.0, 1.0, 1.0), False, [], []  # the sharp pass finds nobody there

    monkeypatch.setattr(worker, "evidence", not_found)
    inc = make_incident()
    p = PersonCompliance(3, (600.0, 190.0, 650.0, 330.0), 0.8, "non_compliant", {"helmet": "missing"})
    frame = frame_with_worker()
    passes.reset()
    for _ in range(6):  # the debouncer puts the item back on every frame of the event
        inc.missing = {"helmet"}
        worker._verify_new_items(inc, frozenset(), frame, [p])
        assert inc.missing == set()  # held back, never written unchecked
    assert len(checks) == 1  # before: 6, one model call per frame
    held = next(c for c in passes.snapshot()["counters"] if c["name"] == "evidence_recheck_held_back")
    assert held["total"] == 5
    worker._verify_at[inc.key] -= VERIFY_RETRY_SECONDS + 0.5  # time passes
    inc.missing = {"helmet"}
    worker._verify_new_items(inc, frozenset(), frame, [p])
    assert len(checks) == 2


def test_retry_bookkeeping_is_cleared_when_the_camera_stops(tmp_path):
    _, _, worker = make_engine(tmp_path, "cuda:0")
    worker._verify_at[1] = time.monotonic()
    worker._close_incidents()
    assert worker._verify_at == {}


# ------------------------------------------------------------------ 4. per-pass timers
def test_pass_summary_math():
    t = PassTimer(window=60.0)
    for i in range(10):  # ten 40 ms calls of 8 images in ten seconds
        t.record("ppe@480", 0.040, 8, role="full frames", now=100.0 + i)
    t.record("tiles@640", 0.060, 16, role="full frames", now=100.0)
    t.count("blank", 7, now=100.0)
    snap = t.snapshot(now=110.0)
    ppe = next(p for p in snap["passes"] if p["name"] == "ppe@480")
    assert ppe["calls_per_s"] == 1.0 and ppe["images_per_s"] == 8.0
    assert ppe["avg_ms_call"] == 40.0 and ppe["avg_ms_image"] == 5.0
    assert abs(sum(p["share"] for p in snap["passes"]) - 1.0) < 0.01
    assert snap["passes"][0]["name"] == "ppe@480"  # largest share first
    assert snap["counters"] == [{"name": "blank", "per_s": 0.7, "total": 7}]


def test_old_records_leave_the_window():
    t = PassTimer(window=60.0)
    t.record("old", 0.1, 1, now=0.0)
    t.record("new", 0.1, 1, now=100.0)
    assert [p["name"] for p in t.snapshot(now=101.0)["passes"]] == ["new"]
    assert t.snapshot(now=500.0)["passes"] == []


class FakeModel:
    def predict(self, frames, **kw):
        return [SimpleNamespace(boxes=None) for _ in frames]


def fake_yolo_detector() -> YoloDetector:
    d = YoloDetector.__new__(YoloDetector)
    d._model, d._sized = FakeModel(), {320: FakeModel()}
    d._weights, d._pt_weights, d.is_engine = "models/safesight/best_480_b32_fp16.engine", "best.pt", True
    d.imgsz, d.half, d.is_cuda, d.device, d.iou = 480, False, False, "cpu", 0.7
    d._keep, d.class_table, d._lock = [0], {0: "person"}, threading.Lock()
    return d


def test_every_model_call_is_recorded_under_its_model_and_size():
    passes.reset()
    d = fake_yolo_detector()
    img = np.zeros((480, 480, 3), np.uint8)
    d.predict([img, img], 0.3)  # full-frame pass
    d.predict([img], 0.3, imgsz=320)  # crop pass
    by_name = {p["name"]: p for p in passes.snapshot()["passes"]}
    assert by_name["best_480_b32_fp16@480"]["role"] == "full frames"
    assert by_name["best_480_b32_fp16@320"]["role"] == "crops or evidence"
    assert by_name["best_480_b32_fp16@480"]["images_per_s"] > 0
