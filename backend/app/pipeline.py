"""Stream workers, the batched inference engine and the top-level Monitor.

Data flow per camera:

    FrameGrabber thread (1 per camera, blocking I/O) --(latest frame only)-->
    InferenceEngine thread (scheduler: priority + waiting time, per-camera FPS caps; batches up to
    `max_batch` ready cameras into one model call) --> shared post-processing pool (bounded, N threads;
    at most one job in flight per camera: tracking, PPE association, alerts, annotation, JPEG encode)
    --> latest JPEG + metadata

Isolation: the engine only takes a camera that has a *new* frame and whose previous frame has been
post-processed, so a slow, stalled or crashed camera simply drops out of the batch without delaying
the others. Every stage keeps only the newest item: load can never turn into queue growth / lag.
Thread count for N cameras: N grabbers + 1 engine + the pool (default 2-8), instead of 2N + 1.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable

import cv2
import numpy as np

from .annotate import draw, evidence_image, person_crop, violation_snapshot
from .config import AppConfig, InferenceConfig, ModelConfig, StreamConfig
from .detector import Detector, build_detector
from .ppe_logic import (
    BEHAVIOR_CLASS, Box, ComplianceSmoother, Detection, PersonCompliance, PPE_ITEMS, crop_region, detectable_items, evaluate_frame, match_person, unchecked,
    merge_refined, refine_person_box,
)
from .sources import Frame, FrameGrabber
from .tracker import ByteTracker
from .violations import AlertDebouncer, Fire, Incident, Step
from .violations_db import OBS_BUCKET, ViolationStore

log = logging.getLogger(__name__)

STALL_SECONDS = 5.0
PRIORITY_RANK = {"high": 0, "normal": 1, "low": 2}
PRIORITY_FPS = {"high": 1.0, "normal": 1.0, "low": 1 / 3}  # x inference.max_fps_per_stream


def default_post_workers() -> int:
    return max(2, min(8, (os.cpu_count() or 4) // 2))


def batch_buckets(max_batch: int) -> list[int]:
    """Batch sizes an accelerator is compiled for: 1, 2, 4, ... and max_batch itself."""
    out, n = [], 1
    while n < max_batch:
        out.append(n)
        n *= 2
    return out + [max_batch]


THUMB_HEIGHT = 240
OBS_FLUSH_SECONDS = 60.0  # how often worker counters (compliance-rate denominator) are written
EVENT_WRITE_SECONDS = 2.0  # how often an ongoing violation event is written back (duration / observations)


def letterbox_square(img: np.ndarray, size: int) -> tuple[np.ndarray, float]:
    """Resize to fit a size x size square (top-left aligned, grey padding). Returns (square, scale)."""
    h, w = img.shape[:2]
    k = size / max(h, w)
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    out = np.full((size, size, 3), 114, dtype=np.uint8)
    out[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR if k > 1 else cv2.INTER_AREA)
    return out, k


class StreamWorker:
    def __init__(self, cfg: StreamConfig, app_cfg: AppConfig, store: ViolationStore,
                 detector: Callable[[], Detector | None] | None = None, pool: ThreadPoolExecutor | None = None,
                 paused: Callable[[], bool] | None = None) -> None:
        self.cfg = cfg
        self.id = cfg.id
        self.app_cfg = app_cfg
        self.store = store
        self._detector = detector or (lambda: None)  # for the alert-time evidence re-detection
        self._pool = pool  # shared post-processing pool (a private 1-thread one is made if None)
        self._own_pool: ThreadPoolExecutor | None = None
        self._paused = paused or (lambda: False)  # focus mode: detection paused, video keeps going
        self.priority = cfg.priority
        self.required = list(cfg.required_ppe)
        self.behaviors = ["phone_use"] if cfg.detect_phone else []  # behavioural checks for this camera
        self._detectable: set[str] | None = None  # PPE items this model can actually judge (set once ready)
        self._live_behaviors: list[str] = self.behaviors  # behaviours the loaded model can actually see
        self.confidence = cfg.confidence if cfg.confidence is not None else app_cfg.model.default_confidence
        self.show_boxes = True
        self.running = False

        t = app_cfg.tracking
        self.grabber = FrameGrabber(cfg.id, cfg.source, app_cfg.inference.process_width,
                                    decode_threads=app_cfg.inference.decode_threads)
        self.tracker = ByteTracker(low_thresh=t.low_thresh, match_iou=t.match_iou,
                                   max_lost_seconds=t.max_lost_seconds, min_hits=t.min_hits)
        self.smoother = ComplianceSmoother(app_cfg.compliance.smoothing_window)
        a = app_cfg.alerts
        self.debouncer = AlertDebouncer(a.min_violation_frames, a.cooldown_seconds,
                                        min_seconds=a.min_violation_seconds, gap=a.event_gap_seconds)
        # stored-event bookkeeping: incident key -> (last DB write, missing set written)
        self._inc_written: dict[int, tuple[float, frozenset[str]]] = {}
        # identifies the exact settings a violation was produced with (secrets never leave the hash)
        self._cfg_sha = hashlib.sha256(json.dumps(app_cfg.model_dump(mode="json"), sort_keys=True, default=str)
                                       .encode()).hexdigest()[:16]
        self.last_violation_at: float | None = None  # wall clock
        self._min_interval = 1.0 / max(0.05, app_cfg.inference.max_fps_per_stream * PRIORITY_FPS[cfg.priority])
        self._preview_interval = 1.0 / app_cfg.inference.paused_preview_fps
        self._last_preview = 0.0
        self._frame_skip = app_cfg.inference.frame_skip
        self._encode = [cv2.IMWRITE_JPEG_QUALITY, app_cfg.inference.jpeg_quality]
        self._snap_quality = app_cfg.alerts.snapshot_quality

        # one frame in flight at most: set by take(), cleared when its post-processing job ends
        self._busy = False
        self._idle = threading.Event()
        self._idle.set()
        self._last_seq = 0
        self._last_take = 0.0

        # outputs
        self._out_lock = threading.Lock()
        self._jpeg: bytes | None = None
        self.out_seq = 0
        self._last_output = 0.0
        self._proc_times: deque[float] = deque(maxlen=60)
        self.frames_processed = 0
        self.dropped_alerts = 0  # phantom detections rejected by the evidence pass
        self.error = ""
        self._error_t = 0.0
        self._meta: dict[str, Any] = {}
        self.people: list[PersonCompliance] = []

        # camera session + observation counters (see ViolationStore.add_observations)
        self.run_id = ""
        self._counted: set[int] = set()  # track IDs already counted as "seen" this session
        self._flagged: set[int] = set()  # track IDs already counted as "violating"
        self._obs: dict[int, list[int]] = {}  # bucket -> [seen, violating], not yet written
        self._obs_flushed = time.monotonic()

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.running:
            return
        self.running = True
        self.run_id = f"{self.id}-{int(time.time() * 1000):x}"  # track IDs restart at #1 in every session
        self._counted, self._flagged, self._obs = set(), set(), {}
        self.grabber.start()
        log.info("[%s] started", self.id)

    def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        self._idle.wait(3.0)  # let an in-flight frame finish (it sees running=False and bails out early)
        self._flush_observations()
        self.grabber.stop()
        self.tracker.reset()
        self._close_incidents()
        self.debouncer.reset()
        self.smoother = ComplianceSmoother(self.app_cfg.compliance.smoothing_window)  # IDs restart at #1
        self._busy = False
        self._proc_times.clear()
        self.people = []
        log.info("[%s] stopped", self.id)

    # ------------------------------------------------------------ engine interface
    @property
    def paused(self) -> bool:
        return self.running and self._paused()

    def _new_frame(self) -> Frame | None:
        f = self.grabber.latest()
        return f if f is not None and f.seq > self._last_seq + self._frame_skip else None

    def ready(self, now: float) -> bool:
        """Due for detection: running, not paused, nothing in flight, FPS cap respected, new frame."""
        if not self.running or self._busy or self.paused:
            return False
        if now - self._last_take < self._min_interval:
            return False
        return self._new_frame() is not None

    def preview_due(self, now: float) -> bool:
        """Detection paused (focus mode): still refresh the video, at a low rate, without inference."""
        return (self.paused and not self._busy and now - self._last_preview >= self._preview_interval
                and self._new_frame() is not None)

    def take(self) -> Frame | None:
        f = self.grabber.latest()
        if f is None:
            return None
        self._last_seq = f.seq
        self._last_take = time.monotonic()
        self.grabber.mark_taken(f.seq)
        self._busy = True
        self._idle.clear()
        return f

    def release(self) -> None:
        """The taken frame won't be submitted (inference failed)."""
        self._busy = False
        self._idle.set()

    def _executor(self) -> ThreadPoolExecutor:
        if self._pool is not None:
            return self._pool
        if self._own_pool is None:
            self._own_pool = ThreadPoolExecutor(1, thread_name_prefix=f"post-{self.id}")
        return self._own_pool

    def submit(self, frame: Frame, dets: list[Detection], infer_ms: float, batch: int) -> None:
        if not self.running:  # stopped while this frame was being inferred
            self.release()
            return
        self._executor().submit(self._job, frame, dets, infer_ms, batch)

    def submit_preview(self, now: float) -> None:
        f = self.take()
        if f is None:
            self.release()
            return
        self._last_preview = now
        self._executor().submit(self._preview_job, f)

    def set_error(self, msg: str) -> None:
        self.error, self._error_t = msg, time.monotonic()

    # ------------------------------------------------------------ post-processing
    def _job(self, frame: Frame, dets: list[Detection], infer_ms: float, batch: int) -> None:
        try:
            if self.running:
                self._process(frame, dets, infer_ms, batch)
        except Exception as e:  # isolate: log and keep going
            log.exception("[%s] post-processing failed", self.id)
            self.set_error(f"processing error: {e}")
        finally:
            self.release()

    def _preview_job(self, frame: Frame) -> None:
        try:
            img = frame.image.copy()
            cv2.putText(img, "detection paused (focus mode)", (12, img.shape[0] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                        (255, 255, 255), 2, cv2.LINE_AA)
            ok, buf = cv2.imencode(".jpg", img, self._encode)
            if ok:
                with self._out_lock:
                    self._jpeg = buf.tobytes()
                    self.out_seq += 1
            self._last_output = time.monotonic()
            self.people = []
            self._meta = {**self._meta, "people": []}
        finally:
            self.release()

    def _process(self, frame: Frame, dets: list[Detection], infer_ms: float, batch: int) -> None:
        conf = self.confidence
        cc = self.app_cfg.compliance
        h, w = frame.image.shape[:2]

        persons = [d for d in dets if d.cls == "person"]
        ppe = [d for d in dets if d.cls != "person" and d.conf >= conf]
        tracked = self.tracker.update(persons, frame.ts, high_thresh=conf)
        if self._detectable is None:  # learn what the loaded model can judge, once it's ready
            det = self._detector()
            if det is not None:
                self._detectable = detectable_items(det.classes)
                blind = [i for i in self.required if i not in self._detectable]
                if blind:
                    log.warning("[%s] required PPE the model cannot detect (not enforced): %s "
                                "- remove these from the camera's required PPE, or use a model that detects them.",
                                self.id, ", ".join(blind))
                self._live_behaviors = [b for b in self.behaviors if BEHAVIOR_CLASS[b] in det.classes]
                if len(self._live_behaviors) < len(self.behaviors):
                    log.warning("[%s] phone-use detection is on but no phone model is loaded (not enforced) "
                                "- set model.phone_weights, e.g. ../models/coco/yolov8n.pt", self.id)
        people = evaluate_frame(
            tracked, ppe, self.required,
            behaviors=self._live_behaviors,
            missing_policy=cc.missing_policy,
            min_containment=cc.min_containment,
            min_person_height=cc.min_person_height,
            frame_size=(w, h),
            detectable=self._detectable,
        )
        self.smoother.apply(people)
        live = self.tracker.live_ids()
        self.smoother.prune(live)
        for p in people:  # every worker whose compliance could be judged counts once per session
            if p.status != "unknown" and p.track_id not in self._counted:
                self._counted.add(p.track_id)
                self._count_obs(seen=1)

        attached = {id(d) for p in people for d in p.ppe}
        stray = [d for d in ppe if id(d) not in attached]
        annotated = draw(frame.image.copy(), people, stray)
        shown = annotated if self.show_boxes else frame.image

        confident = (lambda p: p.conf >= conf) if self.app_cfg.alerts.require_confident_box else None
        step = self.debouncer.step(people, frame.ts, confident,
                                   score=lambda p: self._evidence_candidate(frame, p, conf))
        for f in step.fired:  # evidence from the best frame of the confirmation window
            best_frame, best_p, score = f.best if f.best is not None else (frame, f.person, None)
            self._record_violation(best_frame, best_p, f, score)
        self._sync_incidents(step)

        ok, buf = cv2.imencode(".jpg", shown, self._encode)
        now = time.monotonic()
        if ok:
            with self._out_lock:
                self._jpeg = buf.tobytes()
                self.out_seq += 1
        self._last_output = now
        self._proc_times.append(now)
        self.frames_processed += 1
        self.people = people
        if now - self._obs_flushed >= OBS_FLUSH_SECONDS:
            self._counted &= live  # IDs are never reused within a session, so gone tracks can be forgotten
            self._flagged &= live
            self._flush_observations()

        counts = Counter(d.cls for d in dets if d.conf >= conf)
        self._meta = {
            "infer_ms": round(infer_ms, 1),
            "batch": batch,
            "latency_ms": round((now - frame.ts) * 1000, 1),
            "frame_size": [w, h],
            "class_counts": dict(counts),
            "people": [
                {
                    "id": p.track_id,
                    "box": [round(p.box[0] / w, 4), round(p.box[1] / h, 4), round(p.box[2] / w, 4), round(p.box[3] / h, 4)],
                    "conf": round(p.conf, 2),
                    "status": p.status,
                    "items": p.items,
                    "missing": p.missing,
                }
                for p in people
            ],
        }

    def evidence_box(self, frame: Frame, p: PersonCompliance) -> tuple[Box, bool | None]:
        """Full-res box of the offending worker for the snapshot, re-detected on *this* frame.

        Returns (box, confirmed): confirmed is True when the re-detection found this worker, False
        when it found nobody there, None when no re-detection ran.

        The tracked box comes from a small full-frame pass (a distant worker is ~35 px tall there);
        re-detecting on a full-resolution crop of the same frame gives an evidence-grade box. Falls
        back to the tracked box when no detector is available or nothing overlaps it enough.
        """
        full = frame.full_res
        k = full.shape[1] / frame.image.shape[1]  # process-res -> full-res
        box = (p.box[0] * k, p.box[1] * k, p.box[2] * k, p.box[3] * k)
        size = self.app_cfg.alerts.evidence_imgsz
        det = self._detector()
        if not size or det is None:
            return box, None
        # generous crop: the coarse box can be ~10 % off in any direction
        x1, y1, x2, y2 = crop_region(box, full.shape[1], full.shape[0], pad_x=0.35, pad_top=0.25, pad_bottom=0.2)
        if x2 - x1 < 16 or y2 - y1 < 16:
            return box, None
        square, s = letterbox_square(full[y1:y2, x1:x2], size)
        try:
            dets = det.predict([square], min(self.confidence, 0.35), imgsz=size)[0]
        except Exception:  # evidence refinement must never lose the alert
            log.exception("[%s] evidence re-detection failed; using the tracked box", self.id)
            return box, None
        persons = [Detection("person", d.conf, (d.box[0] / s + x1, d.box[1] / s + y1, d.box[2] / s + x1, d.box[3] / s + y1))
                   for d in dets if d.cls == "person"]
        hit = match_person(Detection("person", p.conf, box), persons, min_iou=0.3)
        return (box, False) if hit is None else (hit.box, True)

    @staticmethod
    def _item_confidence(p: PersonCompliance, missing: list[str]) -> dict[str, float | None]:
        """Per violation: confidence of the detection that shows it (`no_helmet`, `phone`, ...);
        None = required PPE simply not seen on the worker (strict policy), which has no detection."""
        out: dict[str, float | None] = {}
        for m in missing:
            cls = BEHAVIOR_CLASS.get(m) or f"no_{m}"
            confs = [d.conf for d in p.ppe if d.cls == cls]
            out[m] = round(max(confs), 3) if confs else None
        return out

    def _evidence_candidate(self, frame: Frame, p: PersonCompliance, conf: float) -> tuple[float, Any]:
        """How good this frame is as evidence for `p`: a confident, large, fully-in-frame worker with
        clearly detected violations scores best. Returns (score, (frame, person, score))."""
        h, w = frame.image.shape[:2]
        x1, y1, x2, y2 = p.box
        size = min(1.0, (y2 - y1) / (0.4 * h))  # bigger = more visible; saturates at 40 % of the frame height
        m = 0.01 * w
        inside = 1.0 if x1 > m and y1 > m and x2 < w - m and y2 < h - m else 0.6  # cut off at the frame edge
        seen = [c for c in self._item_confidence(p, p.missing).values() if c is not None]
        item = sum(seen) / len(seen) if seen else 0.5
        sharp = 1.0 if p.conf >= conf else 0.5  # tracker-coasting boxes are sloppy
        score = round(p.conf * (0.5 + 0.5 * item) * (0.3 + 0.7 * size) * inside * sharp, 4)
        return score, (frame, p, score)

    def _wall(self, mono: float) -> float:
        """Wall-clock time of a time.monotonic() stamp."""
        return time.time() - (time.monotonic() - mono)

    def _record_violation(self, frame: Frame, p: PersonCompliance, fire: Fire | None = None,
                          score: float | None = None) -> None:
        full = frame.full_res
        box, confirmed = self.evidence_box(frame, p)
        if confirmed is False and self.app_cfg.alerts.drop_unconfirmed:
            log.info("[%s] alert for track #%d dropped: no person at full resolution (phantom detection)",
                     self.id, p.track_id)
            self.dropped_alerts += 1
            return
        missing = sorted(fire.incident.missing) if fire else list(p.missing)
        off = time.time() - time.monotonic()  # one clock offset: the three stamps stay in order
        frame_wall = frame.ts + off
        detected_wall = fire.since + off if fire else frame_wall
        confirmed_wall = fire.incident.start + off if fire else frame_wall
        item_conf = self._item_confidence(p, missing)
        when = datetime.fromtimestamp(frame_wall).strftime("%d %b %Y %H:%M:%S")
        q = [cv2.IMWRITE_JPEG_QUALITY, self._snap_quality]
        ok, img = cv2.imencode(".jpg", evidence_image(full, box, p.track_id, missing, camera=self.cfg.name, when=when,
                                                      person_conf=p.conf, item_conf=item_conf), q)
        snap = violation_snapshot(full, box, p.track_id, missing)
        th = snap if snap.shape[0] <= THUMB_HEIGHT else cv2.resize(
            snap, (max(1, round(snap.shape[1] * THUMB_HEIGHT / snap.shape[0])), THUMB_HEIGHT), interpolation=cv2.INTER_AREA)
        ok2, thumb = cv2.imencode(".jpg", th, [cv2.IMWRITE_JPEG_QUALITY, 75])
        ok3, crop = cv2.imencode(".jpg", person_crop(full, box), q)
        original = cv2.imencode(".jpg", full, q)[1].tobytes() if self.app_cfg.alerts.save_original_frame else b""
        image_b, thumb_b, crop_b = (img.tobytes() if ok else b""), (thumb.tobytes() if ok2 else b""), (crop.tobytes() if ok3 else b"")
        seen = [c for c in item_conf.values() if c is not None]
        det = self._detector()
        a, cc = self.app_cfg.alerts, self.app_cfg.compliance
        sha = lambda b: hashlib.sha256(b).hexdigest() if b else None  # noqa: E731
        meta = {
            "version": 1,
            "camera": {"id": self.id, "name": self.cfg.name, "source_type": self.cfg.source.type, "run_id": self.run_id},
            "lifecycle": {"detected_at": detected_wall, "confirmed_at": confirmed_wall, "evidence_frame_at": frame_wall},
            "detection": {
                "track_id": p.track_id,
                "box": [round(v, 1) for v in box],  # full-resolution pixels
                "frame_size": [int(full.shape[1]), int(full.shape[0])],
                "box_verified_at_full_res": confirmed,
                "person_confidence": round(p.conf, 3),
                "items": {m: {"confidence": c, "evidence": "detected" if c is not None else "not seen (strict policy)"}
                          for m, c in item_conf.items()},
                "evidence_frame_score": score,
            },
            "model": getattr(det, "info", None),
            "settings": {
                "confidence_threshold": self.confidence, "required_ppe": self.required, "behaviors": self._live_behaviors,
                "not_checked": self.unenforced(), "missing_policy": cc.missing_policy,
                "min_containment": cc.min_containment, "min_person_height": cc.min_person_height,
                "smoothing_window": cc.smoothing_window, "min_violation_frames": a.min_violation_frames,
                "min_violation_seconds": a.min_violation_seconds, "event_gap_seconds": a.event_gap_seconds,
                "cooldown_seconds": a.cooldown_seconds, "evidence_imgsz": a.evidence_imgsz,
                "config_sha256": self._cfg_sha,
            },
            "evidence": {"rendered_at": datetime.now(timezone.utc).isoformat(),
                         "sha256": {"image": sha(image_b), "original": sha(original), "crop": sha(crop_b)}},
        }
        try:
            d = self.store.add(self.id, self.cfg.name, p.track_id, missing, image_b, thumb_b, ts=detected_wall,
                               run_id=self.run_id, confidence=round(sum(seen) / len(seen), 3) if seen else round(p.conf, 3),
                               meta=meta, original=original, crop=crop_b, ongoing=fire is not None)
        except Exception:  # a DB hiccup must not stop the video
            log.exception("[%s] could not store violation", self.id)
            if fire is not None:
                self.debouncer.discard(fire.incident)  # let a later frame try again
            return
        self.last_violation_at = time.time()
        if fire is not None:
            fire.incident.record_id = d["id"]
            self._inc_written[fire.incident.key] = (time.monotonic(), frozenset(missing))
        if p.track_id not in self._flagged:
            self._flagged.add(p.track_id)
            self._count_obs(violating=1)

    def _sync_incidents(self, step: Step) -> None:
        """Extend the stored violation of each ongoing incident (throttled), and close ended ones."""
        now = time.monotonic()
        for inc in step.extended + step.ended:
            if inc.record_id is None or inc.record_gone:
                continue
            last, written = self._inc_written.get(inc.key, (0.0, frozenset()))
            missing = frozenset(inc.missing)
            if not inc.ended and missing == written and now - last < EVENT_WRITE_SECONDS:
                continue
            self._write_incident(inc, missing != written)
        for inc in step.ended:
            self._inc_written.pop(inc.key, None)

    def _write_incident(self, inc: Incident, missing_changed: bool, ended: bool | None = None) -> None:
        try:
            ok = self.store.extend(inc.record_id, last_seen=self._wall(inc.last_seen), observations=inc.observations,
                                   missing=sorted(inc.missing) if missing_changed else None,
                                   ended=inc.ended if ended is None else ended)
        except Exception:
            log.exception("[%s] could not update violation #%s", self.id, inc.record_id)
            return
        if not ok:  # deleted while ongoing: keep the event quiet (no re-record) until it ends
            inc.record_gone = True
            return
        self._inc_written[inc.key] = (time.monotonic(), frozenset(inc.missing))

    def _close_incidents(self) -> None:
        """Camera stopping: ongoing events end now."""
        for inc in self.debouncer.active():
            if inc.record_id is not None and not inc.record_gone:
                last = self._inc_written.get(inc.key, (0.0, frozenset()))[1]
                self._write_incident(inc, frozenset(inc.missing) != last, ended=True)
        self._inc_written.clear()

    def _count_obs(self, seen: int = 0, violating: int = 0) -> None:
        c = self._obs.setdefault(int(time.time() // OBS_BUCKET) * OBS_BUCKET, [0, 0])
        c[0] += seen
        c[1] += violating

    def _flush_observations(self) -> None:
        self._obs_flushed = time.monotonic()
        pending, self._obs = self._obs, {}
        for bucket, (seen, violating) in pending.items():
            try:
                self.store.add_observations(self.id, bucket, seen, violating)
            except Exception:  # analytics counters must never stop the video
                log.exception("[%s] could not store observation counters", self.id)

    # ------------------------------------------------------------ outputs
    def jpeg(self) -> tuple[int, bytes | None]:
        with self._out_lock:
            return self.out_seq, self._jpeg

    @property
    def fps(self) -> float:
        t = self._proc_times
        if len(t) < 2 or time.monotonic() - t[-1] > 2.0:
            return 0.0
        return (len(t) - 1) / (t[-1] - t[0])

    @property
    def status(self) -> str:
        if not self.running:
            return "stopped"
        now = time.monotonic()
        if self.error and now - self._error_t < 5.0:
            return "error"
        gs = self.grabber.state
        # "stalled" = frames arrive but results stopped. On a saturated machine a camera legitimately
        # gets a result only every few seconds, so the limit scales with its own recent interval.
        t = self._proc_times
        interval = (t[-1] - t[0]) / (len(t) - 1) if len(t) >= 2 else 0.0
        if gs == "live" and self._last_output and now - self._last_output > max(STALL_SECONDS, 4 * interval):
            return "stalled"
        return gs

    def unenforced(self) -> list[str]:
        """Configured checks the loaded model(s) can't perform: required PPE with no class for it, and
        behaviours (phone use) without a model for them. Shown in the UI so nobody relies on them."""
        det = self._detector()
        return [] if det is None else unchecked(det.classes, self.required, self.behaviors)

    def snapshot(self) -> dict[str, Any]:
        people = self._meta.get("people", []) if self.running else []
        g = self.grabber
        return {
            "id": self.id,
            "name": self.cfg.name,
            "source_type": self.cfg.source.type,
            "status": self.status,
            "message": self.error if self.status == "error" else g.message,
            "running": self.running,
            "fps": round(self.fps, 1),
            "capture_fps": round(g.capture_fps, 1),
            "source_fps": round(g.native_fps, 1),
            "infer_ms": self._meta.get("infer_ms", 0.0),
            "batch": self._meta.get("batch", 0),
            "latency_ms": self._meta.get("latency_ms", 0.0),
            "frame_size": self._meta.get("frame_size"),
            "frames_processed": self.frames_processed,
            "confidence": self.confidence,
            "show_boxes": self.show_boxes,
            "required_ppe": self.required,
            "unenforced": self.unenforced(),
            "workers": len(people),
            "compliant": sum(p["status"] == "compliant" for p in people),
            "violations": sum(p["status"] == "non_compliant" for p in people),
            "unknown": sum(p["status"] == "unknown" for p in people),
            "people": people,
            "class_counts": self._meta.get("class_counts", {}) if self.running else {},
            "alerts_total": self.store.session_per_stream.get(self.id, 0),
            "frame_seq": self.out_seq,
            "enabled": self.cfg.enabled,
            "priority": self.priority,
            "paused": self.paused,
            "health": {**g.health(), "alerts_dropped": self.dropped_alerts},
            # operator view: when did this camera last deliver a frame / a detection result / a violation
            "connected": self.running and g.state == "live",
            "last_frame_at": self._wall(g._last_live) if g._last_live else None,
            "last_detection_at": self._wall(self._last_output) if self._last_output else None,
            "last_violation_at": self.last_violation_at,
        }


class InferenceEngine:
    """Batches the newest frame of every ready stream into one detector call.

    With `person_refine`, a second batched call runs on full-resolution crops of every
    detected person, and those crop detections replace the full-frame PPE detections for
    that person (see `ppe_logic.merge_refined`).
    """

    def __init__(self, name: str, detector: Detector, workers: list[StreamWorker], low_thresh: float,
                 icfg: InferenceConfig, min_person_height: int = 0, evidence_imgsz: int = 0) -> None:
        self.name = name
        self.detector = detector
        self.workers = workers  # replaced (not mutated) on hot reload; read once per loop
        self.low_thresh = low_thresh
        self.icfg = icfg
        # people shorter than this are judged "unknown" anyway, so they're not worth a crop
        self.refine_min_height = max(icfg.refine_min_height, min_person_height)
        self.evidence_imgsz = evidence_imgsz
        self.max_batch = max(1, icfg.max_batch)
        # Accelerators that compile per input shape (OpenVINO GPU) get batches padded to a few fixed
        # sizes; elsewhere padding would only waste compute.
        self.pad_batches = str(getattr(detector, "device", "")).startswith("intel:gpu")
        self.buckets = batch_buckets(self.max_batch)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"infer-{name}", daemon=True)
        # load / capacity stats (last STATS_WINDOW seconds)
        self._calls: deque[tuple[float, float, int]] = deque()  # (end time, busy seconds, frames)
        self.contended = 0  # loops where more cameras were ready than fit in one batch

    STATS_WINDOW = 10.0

    def stats(self) -> dict[str, Any]:
        now = time.monotonic()
        while self._calls and now - self._calls[0][0] > self.STATS_WINDOW:
            self._calls.popleft()
        calls = list(self._calls)
        busy = sum(c[1] for c in calls)
        frames = sum(c[2] for c in calls)
        span = min(self.STATS_WINDOW, max(1e-6, now - calls[0][0] + calls[0][1])) if calls else self.STATS_WINDOW
        return {
            "name": self.name, "device": getattr(self.detector, "device", ""),
            "utilization": round(min(1.0, busy / self.STATS_WINDOW), 3),  # share of wall time spent in inference
            "calls_per_s": round(len(calls) / span, 2) if calls else 0.0,
            "frames_per_s": round(frames / span, 2) if calls else 0.0,
            "avg_batch": round(frames / len(calls), 2) if calls else 0.0,
            "avg_call_ms": round(busy / len(calls) * 1000, 1) if calls else 0.0,
            "max_batch": self.max_batch, "padded_batches": self.pad_batches, "cameras": len(self.workers),
            "contended_loops": self.contended,
        }

    def _pad(self, images: list[np.ndarray]) -> list[np.ndarray]:
        if not self.pad_batches:
            return images
        n = next(b for b in self.buckets if b >= len(images))
        return images + [np.zeros_like(images[0])] * (n - len(images))

    def warmup(self, frame_size: tuple[int, int] = (960, 540)) -> None:
        """Run every input shape once so accelerators compile them before the first live frame."""
        t0 = time.perf_counter()
        w, h = frame_size
        img = np.zeros((h, w, 3), dtype=np.uint8)
        sizes = self.buckets if self.pad_batches else range(1, min(self.max_batch, max(1, len(self.workers))) + 1)
        for n in sizes:
            self.detector.predict([img] * n, 0.5)
        if self.icfg.person_refine:
            s = self.icfg.refine_imgsz
            self.detector.predict([np.zeros((s, s, 3), dtype=np.uint8)] * max(1, self.icfg.refine_batch), 0.5, imgsz=s)
        if self.evidence_imgsz:  # compiled now rather than on the first alert
            s = self.evidence_imgsz
            self.detector.predict([np.zeros((s, s, 3), dtype=np.uint8)], 0.5, imgsz=s)
        log.info("[%s] engine warm-up (batch sizes %s%s) %.0f ms", self.name, list(sizes),
                 " + crop pass" if self.icfg.person_refine else "", (time.perf_counter() - t0) * 1000)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(5.0)

    def schedule(self, now: float) -> list[StreamWorker]:
        """Cameras for the next model call: high priority first, then whoever has waited longest."""
        ready = [w for w in self.workers if w.ready(now)]
        if len(ready) > self.max_batch:
            self.contended += 1
        ready.sort(key=lambda w: (PRIORITY_RANK.get(w.priority, 1), w._last_take))
        return ready[: self.max_batch]

    def _run(self) -> None:
        while not self._stop.is_set():
            now = time.monotonic()
            for w in self.workers:  # focus mode: paused cameras still get their video refreshed
                if w.preview_due(now):
                    w.submit_preview(now)
            batch = self.schedule(now)
            if not batch:
                self._stop.wait(0.003)
                continue
            frames = [(w, w.take()) for w in batch]
            for w, f in frames:
                if f is None:
                    w.release()
            frames = [(w, f) for w, f in frames if f is not None]
            if not frames:
                continue
            conf = min([self.low_thresh] + [w.confidence for w, _ in frames])
            t0 = time.perf_counter()
            try:
                results = self.detector.predict(self._pad([f.image for _, f in frames]), conf)[: len(frames)]
                if self.icfg.person_refine:
                    results = self._refine(frames, results, conf)
            except Exception as e:
                log.exception("[%s] inference failed", self.name)
                for w, _ in frames:
                    w.set_error(f"inference error: {e}")
                    w.release()
                self._stop.wait(0.5)
                continue
            busy = time.perf_counter() - t0
            self._calls.append((time.monotonic(), busy, len(frames)))
            for (w, f), dets in zip(frames, results):
                w.submit(f, dets, busy * 1000, len(frames))

    def _refine(self, frames: list[tuple[StreamWorker, Frame]], results: list[list[Detection]], conf: float) -> list[list[Detection]]:
        ic = self.icfg
        crops, owners = [], []  # owners: (frame index, x offset, y offset, scale full->process)
        refined: list[list[Box]] = [[] for _ in frames]
        for i, ((w, f), dets) in enumerate(zip(frames, results)):
            full = f.full_res
            scale = full.shape[1] / f.image.shape[1]
            persons = sorted(
                (d for d in dets if d.cls == "person" and d.conf >= w.confidence and d.box[3] - d.box[1] >= self.refine_min_height),
                key=lambda d: -d.conf,
            )[: ic.refine_max_persons]
            for p in persons:
                fb = (p.box[0] * scale, p.box[1] * scale, p.box[2] * scale, p.box[3] * scale)
                x1, y1, x2, y2 = crop_region(fb, full.shape[1], full.shape[0])
                if x2 - x1 < 8 or y2 - y1 < 8:
                    continue
                square, k = letterbox_square(full[y1:y2, x1:x2], ic.refine_imgsz)
                crops.append(square)
                owners.append((i, x1, y1, scale, k, p))
        if not crops:
            return results

        # Fixed input shape (N x S x S, N = refine_batch): accelerators like the OpenVINO GPU
        # plugin recompile for every new shape, which would stall the pipeline for ~1 s each time.
        t0 = time.perf_counter()
        n = max(1, ic.refine_batch)
        pad = (-len(crops)) % n
        blank = np.full_like(crops[0], 114)
        batch = crops + [blank] * pad
        crop_dets: list[list[Detection]] = []
        for j in range(0, len(batch), n):
            crop_dets += self.detector.predict(batch[j : j + n], conf, imgsz=ic.refine_imgsz)
        log.debug("[%s] refine: %d crops in %.0f ms", self.name, len(crops), (time.perf_counter() - t0) * 1000)
        mapped: list[list[Detection]] = [[] for _ in frames]
        better: dict[int, Detection] = {}  # id(coarse person) -> person box re-detected on its crop
        for (i, ox, oy, s, k, person), dets in zip(owners, crop_dets):
            crop_persons = []
            for d in dets:
                b = d.box  # square-crop px -> crop px (/k) -> full frame (+offset) -> process res (/s)
                m = Detection(d.cls, d.conf, (
                    (b[0] / k + ox) / s, (b[1] / k + oy) / s, (b[2] / k + ox) / s, (b[3] / k + oy) / s))
                (crop_persons if d.cls == "person" else mapped[i]).append(m)
            fine = refine_person_box(person, crop_persons)
            better[id(person)] = fine
            refined[i].append(fine.box)
        out = []
        for i, dets in enumerate(results):
            persons = [better.get(id(d), d) for d in dets if d.cls == "person"]
            ppe = [d for d in dets if d.cls != "person"]
            out.append(persons + (merge_refined(ppe, refined[i], mapped[i]) if refined[i] else ppe))
        return out


class Monitor:
    """Owns the detector(s), all stream workers and inference engines; applies config hot reloads."""

    def __init__(self, cfg: AppConfig, store: ViolationStore | None = None,
                 detector_factory: Callable[[ModelConfig], Detector] = build_detector) -> None:
        self.cfg = cfg
        self.store = store or ViolationStore(cfg.alerts.db_path)
        self.detector_factory = detector_factory
        self.post_workers = cfg.inference.post_workers or default_post_workers()
        self.pool = ThreadPoolExecutor(self.post_workers, thread_name_prefix="post")
        self._focus: tuple[str, float] | None = None  # (stream id, lease expiry, monotonic)
        self.engines: list[InferenceEngine] = []
        self.workers: dict[str, StreamWorker] = {s.id: self._new_worker(s, cfg) for s in cfg.streams}
        self.device = ""
        self.imgsz = 0
        self.model_classes: list[str] = []
        self._lock = threading.RLock()
        self._started_at = time.time()

    def _new_worker(self, s: StreamConfig, cfg: AppConfig) -> StreamWorker:
        return StreamWorker(s, cfg, self.store, detector=lambda: self.engines[0].detector if self.engines else None,
                            pool=self.pool, paused=lambda sid=s.id: self._is_paused(sid))

    # ------------------------------------------------------------ focus mode
    FOCUS_LEASE = 20.0  # s; the viewer renews it while the full-screen view stays open

    def set_focus(self, stream_id: str | None) -> dict[str, Any]:
        """A viewer opened (or closed, None) the full-screen view of one camera."""
        if stream_id is not None and stream_id not in self.workers:
            raise KeyError(stream_id)
        self._focus = (stream_id, time.monotonic() + self.FOCUS_LEASE) if stream_id else None
        return self.focus_state()

    def capabilities(self) -> dict[str, Any]:
        """What the loaded model(s) can actually check - the one source for "Supported" / "Not checked"
        in the UI. The phone model is a separate, additional detector: it's only loaded while at least
        one camera has detect_phone on, so `phone.loaded` is False when no camera asks for it."""
        det = self.engines[0].detector if self.engines else None
        classes = set(det.classes) if det is not None else None
        supported = sorted(detectable_items(classes)) if classes is not None else None
        m = self.cfg.model
        wanted = any(s.detect_phone for s in self.cfg.streams)
        loaded = classes is not None and "phone" in classes
        return {
            "model": getattr(det, "info", None),
            "ppe_supported": supported,
            "ppe_not_supported": sorted(set(PPE_ITEMS) - set(supported)) if supported is not None else None,
            "phone": {
                "configured": bool(m.phone_weights),
                "weights": os.path.basename(m.phone_weights) if m.phone_weights else "",
                "wanted_by_cameras": [s.id for s in self.cfg.streams if s.detect_phone],
                "loaded": loaded,
                # set, wanted, but not running: the file is missing / unreadable / has no phone class (see the log)
                "load_failed": bool(m.phone_weights) and wanted and classes is not None and not loaded,
            },
        }

    def focus_state(self) -> dict[str, Any]:
        f = self._focus
        active = f is not None and f[1] > time.monotonic()
        return {"enabled": self.cfg.inference.focus_pause_others, "stream_id": f[0] if active and f else None,
                "paused": sorted(w.id for w in self.workers.values() if w.paused)}

    def _is_paused(self, stream_id: str) -> bool:
        if not self.cfg.inference.focus_pause_others:
            return False
        f = self._focus
        return f is not None and f[1] > time.monotonic() and f[0] != stream_id

    # ------------------------------------------------------------ lifecycle
    @staticmethod
    def _detector_cfg(cfg: AppConfig) -> ModelConfig:
        """Model config for the engine's detector: drop the phone model when no camera uses it, so
        the second detector is only loaded (and only costs inference) when phone detection is active."""
        m = cfg.model
        if m.phone_weights and not any(s.detect_phone for s in cfg.streams):
            m = m.model_copy(update={"phone_weights": ""})
        return m

    def _build_engines(self, cfg: AppConfig, workers: list[StreamWorker]) -> list[InferenceEngine]:
        low, ic, mph, ev = cfg.tracking.low_thresh, cfg.inference, cfg.compliance.min_person_height, cfg.alerts.evidence_imgsz
        mcfg = self._detector_cfg(cfg)
        if ic.mode == "per_stream":
            engines = [InferenceEngine(w.id, self.detector_factory(mcfg), [w], low, ic, mph, ev) for w in workers]
        else:
            engines = [InferenceEngine("batched", self.detector_factory(mcfg), workers, low, ic, mph, ev)]
        pw = ic.process_width
        for e in engines:
            e.warmup((pw, round(pw * 9 / 16)))
        return engines

    def _adopt_engines(self, engines: list[InferenceEngine]) -> None:
        if engines:
            d = engines[0].detector
            self.device, self.imgsz, self.model_classes = d.device, d.imgsz, list(d.classes)
        self.engines = engines
        for e in engines:
            e.start()

    def start(self) -> None:
        with self._lock:
            self._adopt_engines(self._build_engines(self.cfg, list(self.workers.values())))
            for w in self.workers.values():
                if w.cfg.enabled:
                    w.start()

    def stop(self) -> None:
        with self._lock:
            for e in self.engines:
                e.stop()
            for w in self.workers.values():
                w.stop()
            self.pool.shutdown(wait=True, cancel_futures=True)
        log.info("monitor stopped")

    # ------------------------------------------------------------ hot reload
    @staticmethod
    def _worker_globals(c: AppConfig) -> tuple[Any, ...]:
        """Global settings that are baked into a StreamWorker when it is created."""
        return (
            c.tracking, c.compliance,
            (c.alerts.min_violation_frames, c.alerts.cooldown_seconds, c.alerts.snapshot_quality),
            (c.inference.process_width, c.inference.max_fps_per_stream, c.inference.jpeg_quality, c.inference.frame_skip,
             c.inference.decode_threads),
        )

    def apply_config(self, new: AppConfig) -> dict[str, Any]:
        """Apply a new config without restarting the process.

        * streams whose own settings (or a global setting baked into workers) changed are
          restarted; unchanged streams keep running untouched;
        * added streams are created (and started if enabled), removed ones are stopped;
        * model / engine settings rebuild the inference engine(s) while streams keep running;
        * server settings and the DB path need a process restart - they are reported, not applied.
        """
        with self._lock:
            old = self.cfg
            result: dict[str, Any] = {"restarted": [], "started": [], "stopped": [], "added": [], "removed": [],
                                      "engine_reloaded": False, "requires_server_restart": []}
            for key in ("host", "port", "static_dir", "cors_origins"):
                if getattr(old.server, key) != getattr(new.server, key):
                    result["requires_server_restart"].append(f"server.{key}")
            if old.inference.post_workers != new.inference.post_workers:
                result["requires_server_restart"].append("inference.post_workers")
            if old.alerts.db_path != new.alerts.db_path:
                result["requires_server_restart"].append("alerts.db_path")
            new.server = old.server  # the running server keeps its settings until restarted
            new.alerts.db_path = old.alerts.db_path

            globals_changed = self._worker_globals(old) != self._worker_globals(new)
            phone_flip = any(s.detect_phone for s in old.streams) != any(s.detect_phone for s in new.streams)
            engine_changed = (old.model != new.model or old.inference != new.inference
                              or old.alerts.evidence_imgsz != new.alerts.evidence_imgsz
                              or old.tracking.low_thresh != new.tracking.low_thresh
                              or old.compliance.min_person_height != new.compliance.min_person_height
                              or phone_flip)  # first/last camera to want phone: (un)load the 2nd model

            old_streams = {s.id: s for s in old.streams}
            new_workers: dict[str, StreamWorker] = {}
            to_start: list[StreamWorker] = []
            for s in new.streams:
                w = self.workers.get(s.id)
                if w is None:
                    w = self._new_worker(s, new)
                    result["added"].append(s.id)
                    if s.enabled:
                        to_start.append(w)
                elif old_streams[s.id] != s or globals_changed:
                    was_running = w.running
                    w.stop()
                    w = self._new_worker(s, new)
                    if s.enabled and (was_running or not old_streams[s.id].enabled):
                        to_start.append(w)
                        result["restarted" if was_running else "started"].append(s.id)
                    elif was_running:
                        result["stopped"].append(s.id)
                else:
                    w.app_cfg = new
                    if s.confidence is None and old.model.default_confidence != new.model.default_confidence:
                        w.confidence = new.model.default_confidence
                new_workers[s.id] = w
            for sid, w in self.workers.items():
                if sid not in new_workers:
                    w.stop()
                    result["removed"].append(sid)

            self.workers = new_workers
            self.cfg = new
            workers = list(new_workers.values())
            structural = bool(result["added"] or result["removed"] or result["restarted"] or result["started"])
            if engine_changed or (new.inference.mode == "per_stream" and structural):
                engines = self._build_engines(new, workers)  # build + warm up first: minimal gap
                for e in self.engines:
                    e.stop()
                self._adopt_engines(engines)
                result["engine_reloaded"] = True
            else:
                for e in self.engines:
                    e.workers = workers
            for w in to_start:
                w.start()
            log.info("config applied: %s", {k: v for k, v in result.items() if v})
            return result

    # ------------------------------------------------------------ queries
    def get(self, stream_id: str) -> StreamWorker | None:
        return self.workers.get(stream_id)

    def snapshot(self) -> dict[str, Any]:
        return {
            "device": self.device,
            "imgsz": self.imgsz,
            "mode": self.cfg.inference.mode,
            "model_classes": self.model_classes,
            "violations_today": self.store.count_today(),
            "alerts_session": self.store.session_total,
            "focus": self.focus_state(),
            "streams": [w.snapshot() for w in list(self.workers.values())],
        }

    def health(self) -> dict[str, Any]:
        """Capacity view for the admin: per-camera throughput / drops / reconnects, engine load, host load."""
        try:
            import psutil

            # one Process object for the app's lifetime: cpu_percent() measures since the previous call,
            # so a fresh object would always report 0.0
            proc = self.__dict__.setdefault("_psutil_proc", psutil.Process())
            host = {
                "cpu_percent": psutil.cpu_percent(interval=None),  # since the previous call (all cores)
                "process_cpu_percent": round(proc.cpu_percent(interval=None) / (psutil.cpu_count() or 1), 1),
                "memory_percent": psutil.virtual_memory().percent,
                "process_rss_mb": round(proc.memory_info().rss / 2**20),
                "threads": proc.num_threads(),
                "cpu_count": psutil.cpu_count(),
            }
        except Exception:  # psutil missing / restricted: the rest is still useful
            host = {"threads": threading.active_count()}
        engines = [e.stats() for e in self.engines]
        cams = []
        for w in list(self.workers.values()):
            s = w.snapshot()
            cams.append({k: s[k] for k in ("id", "name", "source_type", "status", "message", "running", "enabled",
                                           "priority", "paused", "fps", "capture_fps", "source_fps", "infer_ms",
                                           "latency_ms", "frames_processed", "workers", "connected", "last_frame_at",
                                           "last_detection_at", "last_violation_at")} | s["health"])
        util = max((e["utilization"] for e in engines), default=0.0)
        return {
            "uptime_s": round(time.time() - self._started_at),
            "device": self.device, "mode": self.cfg.inference.mode, "post_workers": self.post_workers,
            "engines": engines, "host": host, "cameras": cams, "focus": self.focus_state(),
            "capacity": {
                "engine_utilization": util,
                # rough: the engine is the bottleneck; near 100 % busy means cameras start waiting
                "state": "saturated" if util >= 0.9 else "busy" if util >= 0.7 else "ok",
            },
        }
