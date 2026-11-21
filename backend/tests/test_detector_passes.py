"""Detector efficiency: crop padding only where it is needed, a retry limit on evidence re-checks, and the
per-pass timers that show where the detector's time goes."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import cv2
import numpy as np

from app.config import load_config
from app.detector import CompositeDetector, YoloDetector
from app.passtimer import PassTimer, TimedLock, passes
from app.pipeline import VERIFY_RETRY_SECONDS, InferenceEngine, Monitor, StreamWorker
from app.ppe_logic import Detection, PersonCompliance
from app.sources import Frame
from app.violations import Fire, Incident
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


def make_engine(tmp_path, device: str, detector=None, **inference_extra):
    inference = {"person_refine": True, "refine_imgsz": 320, "refine_batch": 8, **inference_extra}
    cfg = load_config(write_config(tmp_path, {**raw_config(tmp_path, 1), "inference": inference}))
    spy = detector or SpyDetector(device)
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


# ------------------------------------------------------------------ model.person_tile_every: skip the tile pass on some frames
class Fixed:
    """A detector that returns one fixed detection per image and counts the images it was given."""

    imgsz, classes, device = 480, ["person", "helmet"], "cpu"

    def __init__(self, cls: str, box=(10.0, 10.0, 60.0, 120.0)) -> None:
        self.cls, self.box, self.calls = cls, box, []

    def predict(self, frames, conf, imgsz=None):
        self.calls.append(len(frames))
        return [[Detection(self.cls, 0.9, self.box)] for _ in frames]


def person_composite(every: int):
    primary, tiles = Fixed("helmet"), Fixed("person")
    return CompositeDetector(primary, tiles, keep={"person"}, role="person", dedupe={"person"}, tile_every=every), primary, tiles


IMG = np.zeros((48, 64, 3), np.uint8)


def test_every_frame_by_default_is_the_same_as_predict():
    comp, _, tiles = person_composite(1)
    plain = comp.predict([IMG], 0.3)
    keyed = comp.predict_keyed([IMG], 0.3, ["a"])
    assert [d.cls for d in keyed[0]] == [d.cls for d in plain[0]] == ["helmet", "person"]
    assert tiles.calls == [1, 1]


def test_tile_model_runs_on_every_nth_frame_of_a_camera_and_results_are_reused():
    comp, primary, tiles = person_composite(3)
    for _ in range(6):
        out = comp.predict_keyed([IMG], 0.3, ["a"])
        assert sorted(d.cls for d in out[0]) == ["helmet", "person"]  # the person is there on every frame
    assert primary.calls == [1] * 6  # the PPE model sees every frame
    assert tiles.calls == [1, 1]  # the tile model ran on frames 1 and 4 only


def test_each_camera_has_its_own_tile_schedule():
    comp, _, tiles = person_composite(2)
    for _ in range(4):
        comp.predict_keyed([IMG, IMG], 0.3, ["a", "b"])
    assert tiles.calls == [2, 2]  # both cameras on frames 1 and 3, none on 2 and 4
    comp.predict_keyed([IMG], 0.3, ["c"])  # a new camera runs at once
    assert tiles.calls == [2, 2, 1]


def test_a_frame_without_a_camera_key_is_never_cached():
    comp, _, tiles = person_composite(3)
    for _ in range(3):
        comp.predict_keyed([IMG], 0.3, [None])
    assert tiles.calls == [1, 1, 1]


def test_a_reused_tile_result_expires(monkeypatch):
    import app.detector as D

    comp, _, tiles = person_composite(10)
    t = [100.0]
    monkeypatch.setattr(D.time, "monotonic", lambda: t[0])
    comp.predict_keyed([IMG], 0.3, ["a"])
    t[0] += 1.0
    comp.predict_keyed([IMG], 0.3, ["a"])
    assert tiles.calls == [1]  # reused
    t[0] += CompositeDetector.CACHE_MAX_AGE + 0.1
    comp.predict_keyed([IMG], 0.3, ["a"])
    assert tiles.calls == [1, 1]  # too old, whatever tile_every says


def test_phone_model_still_runs_every_frame_and_the_person_model_still_skips():
    inner, primary, tiles = person_composite(3)
    phone = Fixed("phone")
    outer = CompositeDetector(inner, phone)  # role "phone"
    for _ in range(3):
        outer.predict_keyed([IMG], 0.3, ["a"])
    assert phone.calls == [1, 1, 1] and tiles.calls == [1]


# ------------------------------------------------------------------ inference.refine_every: reuse the crop result
class BlobDetector:
    """Returns one person box around the bright pixels of each image (the synthetic worker)."""

    device, imgsz, classes = "cuda:0", 480, ["person"]

    def __init__(self) -> None:
        self.crop_calls = 0

    def predict(self, frames, conf, imgsz=None):
        if imgsz is not None:
            self.crop_calls += 1
        out = []
        for img in frames:
            ys, xs = np.where(img.min(axis=2) > 200)
            out.append([Detection("person", 0.9, (float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)))]
                       if len(xs) else [])
        return out


def person_box(out):
    return next(d for d in out if d.cls == "person").box


def test_refine_every_reuses_the_crop_result_and_moves_it_with_the_worker(tmp_path):
    passes.reset()
    blob = BlobDetector()
    engine, _, worker = make_engine(tmp_path, "cuda:0", detector=blob, refine_every=2)
    frame = frame_with_worker()
    box = (601.5, 188.0, 646.0, 320.0)  # process-res box around the worker, a little off
    moved = (box[0] + 3, box[1] + 2, box[2] + 3, box[3] + 2)
    first = person_box(engine._refine([(worker, frame)], [[Detection("person", 0.9, box)]], 0.3)[0])
    assert blob.crop_calls == 1
    second = person_box(engine._refine([(worker, frame)], [[Detection("person", 0.9, moved)]], 0.3)[0])
    assert blob.crop_calls == 1  # no new crop pass
    assert all(abs(b - (a + d)) < 1e-6 for a, b, d in zip(first, second, (3, 2, 3, 2)))  # the last result, moved
    engine._refine([(worker, frame)], [[Detection("person", 0.9, moved)]], 0.3)
    assert blob.crop_calls == 2  # every 2nd frame is sharp again
    assert next(c for c in passes.snapshot()["counters"] if c["name"] == "crops_reused")["total"] == 1


def test_default_refine_every_is_a_crop_pass_on_every_frame(tmp_path):
    blob = BlobDetector()
    engine, _, worker = make_engine(tmp_path, "cuda:0", detector=blob)
    for _ in range(3):
        engine._refine([(worker, frame_with_worker())], [[Detection("person", 0.9, (601.5, 188.0, 646.0, 320.0))]], 0.3)
    assert blob.crop_calls == 3 and worker._refine_cache == []


def test_a_different_worker_is_not_given_anyone_elses_crop_result(tmp_path):
    blob = BlobDetector()
    engine, _, worker = make_engine(tmp_path, "cuda:0", detector=blob, refine_every=3)
    frame = frame_with_worker()
    engine._refine([(worker, frame)], [[Detection("person", 0.9, (601.5, 188.0, 646.0, 320.0))]], 0.3)
    engine._refine([(worker, frame)], [[Detection("person", 0.9, (100.0, 190.0, 150.0, 330.0))]], 0.3)  # far away
    assert blob.crop_calls == 2


def test_cache_is_cleared_when_nobody_is_in_view(tmp_path):
    blob = BlobDetector()
    engine, _, worker = make_engine(tmp_path, "cuda:0", detector=blob, refine_every=3)
    frame = frame_with_worker()
    engine._refine([(worker, frame)], [[Detection("person", 0.9, (601.5, 188.0, 646.0, 320.0))]], 0.3)
    assert len(worker._refine_cache) == 1
    engine._refine([(worker, frame)], [[]], 0.3)
    assert worker._refine_cache == []


# ------------------------------------------------------------------ violation timings
def test_timing_samples_are_summarised():
    t = PassTimer(window=60.0)
    for v in (1.0, 2.0, 3.0):
        t.sample("confirmation_wait_s", v, now=100.0)
    t.sample("old", 9.0, now=0.0)
    snap = t.snapshot(now=110.0)
    assert snap["timings"] == [{"name": "confirmation_wait_s", "n": 3, "avg": 2.0, "max": 3.0}]


def test_a_stored_violation_records_how_long_it_waited_and_how_long_the_evidence_took(tmp_path):
    passes.reset()
    _, _, worker = make_engine(tmp_path, "cuda:0", detector=BlobDetector())
    # the evidence pass needs a detector on the worker: use the same blob detector
    worker._detector = lambda: BlobDetector()
    inc = Incident(key=1, tracks={3}, missing={"helmet"}, box=(0.0, 0.0, 1.0, 1.0), start=10.0, last_seen=10.0)
    p = PersonCompliance(3, (601.5, 188.0, 646.0, 320.0), 0.8, "non_compliant", {"helmet": "missing"})
    worker._record_violation(frame_with_worker(), p, Fire(p, inc, None, 8.5))
    by_name = {t["name"]: t for t in passes.snapshot()["timings"]}
    assert by_name["confirmation_wait_s"]["avg"] == 1.5 and by_name["confirmation_wait_s"]["n"] == 1
    assert by_name["evidence_build_s"]["n"] == 1 and by_name["evidence_build_s"]["avg"] >= 0


# ------------------------------------------------------------------ stall diagnostics
def test_timed_lock_records_only_slow_waits_and_holds():
    passes.reset()
    lock = TimedLock("t", min_s=0.03)
    with lock:
        pass
    assert passes.snapshot()["timings"] == []  # fast use leaves no trace

    def hold():
        with lock:
            time.sleep(0.12)

    th = threading.Thread(target=hold)
    th.start()
    time.sleep(0.03)
    with lock:  # has to wait for the other thread
        pass
    th.join()
    by = {t["name"]: t for t in passes.snapshot()["timings"]}
    assert by["t_wait_s"]["max"] >= 0.05 and by["t_held_s"]["max"] >= 0.1


def fake_monitor(statuses, engines=True):
    import queue

    workers = {str(i): SimpleNamespace(running=True, status=s, _busy=(s == "stalled")) for i, s in enumerate(statuses)}
    eng = [SimpleNamespace(name="batched", last_loop=time.monotonic() - 1.0, last_call_ms=40.0, contended=3,
                           stats=lambda: {"utilization": 0.5})] if engines else []
    return SimpleNamespace(workers=workers, engines=eng, pool=SimpleNamespace(_work_queue=queue.Queue()), post_workers=6)


def test_no_stall_report_while_cameras_are_fine_or_only_a_few_stall():
    assert Monitor.stall_report(fake_monitor(["live"] * 6)) is None
    assert Monitor.stall_report(fake_monitor(["live"] * 5 + ["stalled"])) is None  # one camera: not a shared problem
    assert Monitor.stall_report(fake_monitor(["stalled", "stalled"])) is None  # too few cameras to say


def test_stall_report_names_the_shared_parts_when_half_the_cameras_stall():
    r = Monitor.stall_report(fake_monitor(["stalled"] * 3 + ["live"] * 3))
    assert r["stalled"] == 3 and r["running"] == 6 and r["post_workers"] == 6 and r["post_queue"] == 0
    assert r["engines"][0]["last_call_ms"] == 40 and 0.5 < r["engines"][0]["last_loop_s_ago"] < 3
    assert r["cameras_with_a_frame_in_flight"] == 3
    assert {"slow_database_locks", "host", "gpus"} <= set(r)


def test_watchdog_logs_once_when_a_stall_starts_and_once_when_it_ends(monkeypatch, caplog):
    import logging

    import app.pipeline as P

    monkeypatch.setattr(P, "STALL_CHECK_SECONDS", 0.01)
    report = {"stalled": 4, "running": 6}
    states = iter([None, report, report, report, None, None])
    fake = SimpleNamespace(_wd_stop=threading.Event())

    def next_report():
        try:
            return next(states)
        except StopIteration:
            fake._wd_stop.set()
            return None

    fake.stall_report = next_report
    passes.reset()
    with caplog.at_level(logging.WARNING, logger="app.pipeline"):
        Monitor._watch(fake)
    msgs = [r.getMessage() for r in caplog.records]
    assert sum(m.startswith("STALL:") for m in msgs) == 1  # three bad checks in a row: one line
    assert sum(m.startswith("STALL over") for m in msgs) == 1
    assert next(c for c in passes.snapshot()["counters"] if c["name"] == "stall_episodes")["total"] == 1


# ------------------------------------------------------------------ results are read with one transfer per model call
class CountingBoxes:
    """What Ultralytics hands back for one image: one [N, 6] tensor, with xyxy / conf / cls as views of it.
    `reads` counts how often the per-image views are touched (each is a device-to-host transfer on a GPU)."""

    def __init__(self, rows, has_data=True):
        import torch

        self._t = torch.tensor(rows, dtype=torch.float32).reshape(-1, 6)
        self.reads = 0
        self._has_data = has_data

    def __len__(self):
        return len(self._t)

    @property
    def data(self):
        if not self._has_data:
            raise AttributeError("data")
        return self._t

    def _view(self, sl):
        self.reads += 1
        return self._t[:, sl]

    xyxy = property(lambda s: s._view(slice(0, 4)))
    conf = property(lambda s: s._view(4))
    cls = property(lambda s: s._view(5))


class StubModel:
    def __init__(self, per_image):
        self.per_image = per_image

    def predict(self, frames, **kw):
        return [SimpleNamespace(boxes=b) for b in self.per_image]


def run_detector(boxes):
    d = fake_yolo_detector()
    d._model = StubModel(boxes)
    d.class_table = {0: "person", 1: "helmet", 2: "no_helmet"}
    d._keep = [0, 1, 2]
    img = np.zeros((48, 64, 3), np.uint8)
    return d.predict([img] * len(boxes), 0.3)


ROWS = [
    [[10.5, 20.25, 110.0, 220.5, 0.91, 0], [40.0, 30.0, 70.0, 60.0, 0.78, 2]],
    [],
    [[5.0, 6.0, 7.0, 8.0, 0.35, 1]],
    [[1.0, 2.0, 3.0, 4.0, 0.5, 0], [2.0, 3.0, 4.0, 5.0, 0.6, 1], [3.0, 4.0, 5.0, 6.0, 0.7, 2]],
]


def test_stacked_reading_gives_exactly_the_same_detections_as_the_per_image_path():
    fast = run_detector([CountingBoxes(r) for r in ROWS])
    slow = run_detector([CountingBoxes(r, has_data=False) for r in ROWS])  # no tensor to stack: the old path
    assert fast == slow
    assert [len(x) for x in fast] == [2, 0, 1, 3]
    first = fast[0][0]
    assert first.cls == "person" and first.conf == np.float32(0.91) and first.box == (10.5, 20.25, 110.0, 220.5)


def test_stacked_reading_does_not_touch_the_per_image_views():
    boxes = [CountingBoxes(r) for r in ROWS]
    run_detector(boxes)
    assert sum(b.reads for b in boxes) == 0  # before: 3 reads for every image that had boxes
    slow = [CountingBoxes(r, has_data=False) for r in ROWS]
    run_detector(slow)
    assert sum(b.reads for b in slow) == 3 * 3  # three images had boxes, three reads each


def test_a_call_without_any_boxes_still_returns_one_empty_list_per_image():
    assert run_detector([CountingBoxes([]), CountingBoxes([])]) == [[], []]
