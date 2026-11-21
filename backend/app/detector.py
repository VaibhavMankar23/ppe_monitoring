"""Object detector abstraction + Ultralytics YOLO implementation.

The rest of the app only sees `Detector.predict(frames, conf) -> list[list[Detection]]`
with canonical class names, so any other backend (ONNX Runtime, TensorRT, a remote
service) can be dropped in by implementing the same protocol.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from pathlib import Path
from typing import Protocol

import numpy as np

from .config import ModelConfig
from .passtimer import passes
from .ppe_logic import Detection

log = logging.getLogger(__name__)

# Normalised raw name -> canonical name. Covers the common public PPE datasets
# (Roboflow Construction-PPE, SH17, hard-hat-workers, ...).
ALIASES: dict[str, str] = {
    "person": "person", "worker": "person", "human": "person", "people": "person",
    "helmet": "helmet", "hardhat": "helmet", "hard_hat": "helmet", "hard-hat": "helmet", "head_helmet": "helmet",
    "vest": "vest", "safety_vest": "vest", "safety-vest": "vest", "reflective_vest": "vest",
    "gloves": "gloves", "glove": "gloves",
    "goggles": "goggles", "glass": "goggles", "glasses": "goggles", "safety_glasses": "goggles",
    "boots": "boots", "boot": "boots", "safety_shoes": "boots", "shoes": "boots",
    "mask": "mask", "face_mask": "mask",
    "ear_protection": "ear_protection", "earmuffs": "ear_protection",
    "no_helmet": "no_helmet", "no_hardhat": "no_helmet", "no_hard_hat": "no_helmet", "head": "no_helmet",
    "no_vest": "no_vest", "no_safety_vest": "no_vest",
    "no_gloves": "no_gloves", "no_glove": "no_gloves",
    "no_goggles": "no_goggles", "no_glass": "no_goggles", "no_glasses": "no_goggles",
    "no_boots": "no_boots", "no_mask": "no_mask", "no_ear_protection": "no_ear_protection",
    # behaviour classes (from a general-purpose model, e.g. COCO "cell phone")
    "phone": "phone", "cell_phone": "phone", "cellphone": "phone", "mobile_phone": "phone",
    "mobilephone": "phone", "smartphone": "phone", "mobile": "phone",
}


def normalize_name(raw: str) -> str:
    return re.sub(r"[\s\-]+", "_", raw.strip().lower())


def build_class_table(model_names: dict[int, str], class_map: dict[str, str]) -> dict[int, str]:
    """model class id -> canonical name, for the classes we care about."""
    table: dict[int, str] = {}
    for idx, raw in model_names.items():
        canonical = class_map.get(raw) or ALIASES.get(normalize_name(raw))
        if canonical:
            table[idx] = canonical
    return table


class Detector(Protocol):
    device: str
    imgsz: int
    classes: list[str]

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]: ...


def _openvino_devices() -> list[str]:
    try:
        import openvino as ov

        return list(ov.Core().available_devices)
    except Exception:
        return []


def openvino_model_path(weights: str, imgsz: int, export_if_missing: bool = True) -> str | None:
    """Return (exporting once if needed) the OpenVINO IR dir cached next to the .pt weights."""
    w = Path(weights)
    if w.is_dir():  # already an exported model dir
        return str(w)
    target = w.with_name(f"{w.stem}_{imgsz}_openvino_model")
    if (target / f"{w.stem}.xml").exists() or any(target.glob("*.xml")):
        return str(target)
    if not export_if_missing:
        return None
    from ultralytics import YOLO

    log.info("exporting %s to OpenVINO (imgsz=%d, one-time)...", w.name, imgsz)
    try:
        out = Path(YOLO(str(w)).export(format="openvino", imgsz=imgsz, dynamic=True, half=False))
        if out.resolve() != target.resolve():
            if target.exists():
                import shutil

                shutil.rmtree(target)
            out.rename(target)
        return str(target)
    except Exception:
        log.exception("OpenVINO export failed - using PyTorch")
        return None


# TensorRT engines are built with dynamic shapes: batch 1..TRT_MAX_BATCH (inference.max_batch can reach
# 32) and square images 32..2*imgsz (Ultralytics' profile), which covers the person-crop pass and,
# at imgsz 480, the 640 px evidence pass. Larger requests fall back to the PyTorch weights.
TRT_MAX_BATCH = 32


def tensorrt_engine_path(weights: str, imgsz: int, half: bool, device: str, export_if_missing: bool = True) -> str | None:
    """Return (building once if needed) a TensorRT engine cached next to the .pt weights.

    An engine only runs on the GPU model and TensorRT version that built it: after changing either,
    delete the .engine file (or it fails to load and the detector falls back to PyTorch)."""
    w = Path(weights)
    if w.suffix == ".engine":
        return str(w)
    target = w.with_name(f"{w.stem}_{imgsz}_b{TRT_MAX_BATCH}_{'fp16' if half else 'fp32'}.engine")
    if target.exists():
        return str(target)
    if not export_if_missing:
        return None
    from ultralytics import YOLO

    gpu = int(device.split(":")[1]) if ":" in device else 0
    log.info("building TensorRT engine for %s (imgsz=%d, batch<=%d, %s) - one-time, takes several minutes...",
             w.name, imgsz, TRT_MAX_BATCH, "FP16" if half else "FP32")
    try:
        out = Path(YOLO(str(w)).export(format="engine", imgsz=imgsz, dynamic=True, batch=TRT_MAX_BATCH,
                                       half=half, device=gpu, simplify=True))
        out.replace(target)  # Ultralytics writes <stem>.engine; the cache name records the build settings
        return str(target)
    except Exception:
        log.exception("TensorRT export failed - using PyTorch on %s", device)
        return None


_auto_cuda: str | None = None


def pick_cuda_device(requested: str) -> str:
    """The CUDA device to use. "cuda:N" is taken as written. For "auto" / "cuda" on a machine with several
    GPUs, the one with the most free memory (another program may already hold most of GPU 0). The choice is
    made once per process, so the PPE model, the person model and later reloads all land on the same card."""
    global _auto_cuda
    if ":" in requested:
        return requested
    if _auto_cuda is None:
        import torch

        best = 0
        try:
            n = torch.cuda.device_count()
            if n > 1:
                free = [torch.cuda.mem_get_info(i)[0] for i in range(n)]
                best = max(range(n), key=lambda i: free[i])
                log.info("%d GPUs found, using cuda:%d (most free memory: %s)", n, best,
                         ", ".join(f"cuda:{i} {f / 2**20:.0f} MiB" for i, f in enumerate(free)))
        except Exception:  # cannot read memory: keep the first card
            log.exception("could not compare the GPUs' free memory - using cuda:0")
            best = 0
        _auto_cuda = f"cuda:{best}"
    return _auto_cuda


def select_backend(cfg: ModelConfig) -> tuple[str, str, int]:
    """Pick (weights, device, imgsz). Order for `auto`: CUDA (TensorRT, else PyTorch) > OpenVINO iGPU >
    OpenVINO CPU > PyTorch CPU."""
    import torch

    req = cfg.device
    cuda = torch.cuda.is_available()
    if req.startswith("cuda") and not cuda:
        log.warning("CUDA requested but not available - falling back to auto")
        req = "auto"
    if req.startswith("cuda") or (req == "auto" and cuda):
        device = pick_cuda_device(req)
        if cfg.tensorrt:
            path = tensorrt_engine_path(cfg.weights, cfg.imgsz, cfg.half, device)
            if path:
                return path, device, cfg.imgsz
        return cfg.weights, device, cfg.imgsz
    if req == "cpu":
        return cfg.weights, "cpu", cfg.cpu_imgsz

    # auto (no CUDA) or explicit intel:*
    ov_devs = _openvino_devices() if cfg.openvino else []
    if req.startswith("intel:") and not ov_devs:
        log.warning("%s requested but OpenVINO is unavailable - using PyTorch CPU", req)
    if ov_devs:
        want_gpu = req == "intel:gpu" or (req == "auto" and "GPU" in ov_devs)
        device = "intel:gpu" if want_gpu and "GPU" in ov_devs else "intel:cpu"
        imgsz = cfg.imgsz if device == "intel:gpu" else cfg.cpu_imgsz
        path = openvino_model_path(cfg.weights, imgsz)
        if path:
            return path, device, imgsz
    return cfg.weights, "cpu", cfg.cpu_imgsz


class YoloDetector:
    """Thread-safe wrapper around an Ultralytics YOLO model (PyTorch / OpenVINO / TensorRT)."""

    def __init__(self, cfg: ModelConfig) -> None:
        import torch
        from ultralytics import YOLO

        if not Path(cfg.weights).exists():
            raise FileNotFoundError(f"model weights not found: {cfg.weights} (set model.weights / PPE_MODEL_WEIGHTS)")
        weights, self.device, self.imgsz = select_backend(cfg)
        self.is_cuda = self.device.startswith("cuda")
        self.half = cfg.half and self.is_cuda
        self.iou = cfg.iou
        if self.device == "cpu" and cfg.cpu_threads > 0:
            torch.set_num_threads(cfg.cpu_threads)

        self._pt_weights = cfg.weights  # PyTorch fallback for sizes a TensorRT engine was not built for
        self._model = YOLO(weights, task="detect")
        try:
            names = dict(self._model.names)  # read once: on exported models each access rebuilds the backend
        except Exception:
            if not weights.endswith(".engine"):
                raise
            # built for another GPU / TensorRT version, or damaged: keep detecting, on PyTorch
            log.exception("TensorRT engine %s failed to load - delete it to rebuild; using PyTorch", Path(weights).name)
            weights = cfg.weights
            self._model = YOLO(weights, task="detect")
            names = dict(self._model.names)
        self._weights = weights
        self.is_engine = weights.endswith(".engine")
        # One instance per extra input size (person-crop pass, alert evidence pass), so alternating
        # sizes never force a predictor re-initialise / accelerator recompile.
        self._sized: dict[int, YOLO] = {}
        self._lock = threading.Lock()
        self.class_table = build_class_table(names, cfg.class_map)
        self.classes = sorted(set(self.class_table.values()))
        self._keep = list(self.class_table)
        ignored = sorted(set(names.values()) - {names[i] for i in self.class_table})
        # provenance stored with every violation: which weights (by content hash), run how
        self.info = {"weights": Path(cfg.weights).name, "sha256": _file_sha256(cfg.weights)[:16],
                     "runtime": Path(weights).name, "device": self.device, "imgsz": self.imgsz,
                     "classes": self.classes}
        log.info("model %s on %s imgsz=%d half=%s", Path(weights).name, self.device, self.imgsz, self.half)
        log.info("classes used: %s | ignored: %s", self.classes, ignored)
        if "person" not in self.classes:
            log.warning("model has no person/worker class - per-person compliance will be empty")
        self._warmup()

    def _use_cuda_device(self) -> None:
        """CUDA's "current device" is per thread and starts at GPU 0. On a multi-GPU server the engine lives on
        another GPU (cuda:1) while the inference worker thread still points at GPU 0, and TensorRT then fails with
        "Cuda Runtime Error Code 1" on every frame. Point this thread at the model's GPU before each call."""
        if not self.is_cuda or ":" not in self.device:
            return
        import torch

        try:
            idx = int(self.device.split(":")[1])
            if torch.cuda.is_available() and torch.cuda.current_device() != idx:
                torch.cuda.set_device(idx)
        except Exception:  # never let device bookkeeping stop a detection call
            log.debug("could not select %s for this thread", self.device, exc_info=True)

    def _warmup(self) -> None:
        t0 = time.perf_counter()
        self.predict([np.zeros((self.imgsz, self.imgsz, 3), dtype=np.uint8)], 0.5)
        log.info("warm-up done in %.0f ms", (time.perf_counter() - t0) * 1000)

    @staticmethod
    def _stack_boxes(results: list) -> "np.ndarray | None":
        """Every box of one model call as one [N, 6] array (x1, y1, x2, y2, confidence, class).

        Reading boxes image by image costs three device-to-host transfers per image, and each one waits for the GPU:
        a batch of cameras plus its person tiles and crops is well over a hundred. Stacking them first makes it one
        transfer per model call. The values are the same ones the old path read (xyxy, conf and cls are slices of the
        same tensor). None when the results are not tensors that can be stacked."""
        try:
            import torch

            live = [r.boxes.data for r in results if r.boxes is not None and len(r.boxes)]
            if not live:
                return np.empty((0, 6), np.float32)
            return torch.cat(live).cpu().numpy()
        except Exception:  # no torch, or boxes that do not carry a tensor: the caller reads them image by image
            return None

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]:
        """Detect on full frames (imgsz=None) or on small crops (imgsz = crop inference size)."""
        if not frames:
            return []
        if imgsz is None:
            model = self._model
        else:
            key, src = imgsz, self._weights
            if self.is_engine and imgsz > 2 * self.imgsz:  # outside the engine's shape range
                key, src = -imgsz, self._pt_weights
            model = self._sized.get(key)
            if model is None:
                from ultralytics import YOLO

                model = self._sized[key] = YOLO(src, task="detect")
        # FP16 only matters on CUDA; newer Ultralytics warns on every call when `half` is passed.
        extra = {"half": True} if self.half else {}
        with self._lock:
            t0 = time.perf_counter()
            self._use_cuda_device()
            results = model.predict(
                frames,
                conf=conf,
                iou=self.iou,
                imgsz=imgsz or self.imgsz,
                device=self.device,
                classes=self._keep,
                verbose=False,
                **extra,
            )
        stacked = self._stack_boxes(results)
        out: list[list[Detection]] = []
        at = 0
        for r in results:
            dets: list[Detection] = []
            if r.boxes is not None and len(r.boxes):
                if stacked is not None:
                    n = len(r.boxes)
                    rows = stacked[at:at + n]
                    at += n
                    xyxy, confs, clss = rows[:, :4], rows[:, 4], rows[:, 5].astype(int)
                else:  # results that do not carry one tensor per image (test doubles): the original per-image path
                    xyxy = r.boxes.xyxy.cpu().numpy()
                    confs = r.boxes.conf.cpu().numpy()
                    clss = r.boxes.cls.cpu().numpy().astype(int)
                for b, c, k in zip(xyxy, confs, clss):
                    dets.append(Detection(self.class_table[int(k)], float(c), tuple(float(v) for v in b)))  # type: ignore[arg-type]
            out.append(dets)
        # one record per model call: the pass is named after the weights and the input size, so the full-frame
        # pass, the crop / evidence pass and the tiled person model each show their own cost
        passes.record(f"{Path(self._weights).stem}@{imgsz or self.imgsz}", time.perf_counter() - t0, len(frames),
                      role="full frames" if imgsz is None else "crops or evidence")
        return out


class CompositeDetector:
    """Runs a primary detector (person + PPE) and a secondary detector and unions their detections:
    a general-purpose model for behaviour classes ("cell phone"), or a dedicated person detector.

    The secondary detector only runs on the full-frame pass. Person-crop and alert-evidence passes
    (imgsz set) go to the primary alone: those passes exist to judge PPE on one worker, and re-running
    a second model on every crop would roughly double inference cost for no benefit.
    Classes in `dedupe` (person, for a person detector) are found by both models: overlapping boxes
    of the same worker are merged so the tracker never sees one worker twice.
    """

    CACHE_MAX_AGE = 3.0  # s: a reused secondary result is never older than this, whatever tile_every says

    def __init__(self, primary: Detector, secondary: Detector, keep: "set[str] | None" = None,
                 role: str = "phone", dedupe: "set[str] | None" = None, tile_every: int = 1) -> None:
        self.primary = primary
        self.secondary = secondary
        self.keep = keep if keep is not None else {"phone"}  # secondary classes to merge in
        self.dedupe = dedupe or set()
        self.device = primary.device
        self.imgsz = primary.imgsz
        self.classes = sorted(set(primary.classes) | self.keep)
        self.info = {**getattr(primary, "info", {}), f"{role}_model": getattr(secondary, "info", {})}
        # only the person model may be skipped on some frames; the behaviour (phone) model runs on every one
        self.caches_secondary = role == "person"
        self.tile_every = max(1, tile_every)
        self._cache: dict[str, tuple[float, int, list[Detection]]] = {}  # camera -> (when, frames reused, secondary result)

    def _run_secondary(self, frames: list[np.ndarray], conf: float) -> "list[list[Detection]] | None":
        try:
            return self.secondary.predict(frames, conf)
        except Exception:  # a behaviour-model failure must never take down PPE detection
            log.exception("secondary (behaviour) detector failed; skipping this batch")
            return None

    def _merge(self, base: list[list[Detection]], extra: list[list[Detection]]) -> list[list[Detection]]:
        for dets, ex in zip(base, extra):
            dets.extend(d for d in ex if d.cls in self.keep)
            if self.dedupe:
                from .ppe_logic import dedupe

                kept = [d for d in dets if d.cls not in self.dedupe]
                dets[:] = kept + dedupe([d for d in dets if d.cls in self.dedupe], 0.5)
        return base

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]:
        base = self.primary.predict(frames, conf, imgsz=imgsz)
        if imgsz is not None:  # crop / evidence pass: primary only (no behaviour detection)
            return base
        extra = self._run_secondary(frames, conf)
        return base if extra is None else self._merge(base, extra)

    def predict_keyed(self, frames: list[np.ndarray], conf: float, keys: "list[str | None]") -> list[list[Detection]]:
        """The full-frame pass for the cameras named in `keys` (None = no camera, never cached). Same result as
        predict(); with tile_every > 1 the person model runs on every Nth frame of a camera and the frames in
        between reuse its last result."""
        if not self.caches_secondary:  # the phone model: runs every frame; the person composite inside may cache
            inner = getattr(self.primary, "predict_keyed", None)
            base = inner(frames, conf, keys) if inner is not None else self.primary.predict(frames, conf)
            extra = self._run_secondary(frames, conf)
            return base if extra is None else self._merge(base, extra)
        base = self.primary.predict(frames, conf)
        if self.tile_every <= 1:
            extra = self._run_secondary(frames, conf)
            return base if extra is None else self._merge(base, extra)
        now = time.monotonic()
        extra: list[list[Detection]] = [[] for _ in frames]
        todo: list[int] = []
        for i, k in enumerate(keys):
            hit = self._cache.get(k) if k is not None else None
            if hit is not None and hit[1] < self.tile_every - 1 and now - hit[0] < self.CACHE_MAX_AGE:
                extra[i] = hit[2]
                self._cache[k] = (hit[0], hit[1] + 1, hit[2])
            else:
                todo.append(i)
        if todo:
            ran = self._run_secondary([frames[i] for i in todo], conf) or [[] for _ in todo]
            for i, ex in zip(todo, ran):
                ex = [d for d in ex if d.cls in self.keep]
                extra[i] = ex
                if keys[i] is not None:
                    self._cache[keys[i]] = (now, 0, ex)
        for k in [k for k, v in self._cache.items() if now - v[0] > self.CACHE_MAX_AGE]:
            del self._cache[k]  # cameras that stopped
        return self._merge(base, extra)


def tile_boxes(w: int, h: int, grid: int, overlap: float = 0.2) -> list[tuple[int, int, int, int]]:
    """`grid` x `grid` tiles covering a w x h frame, neighbours overlapping by `overlap` of a tile, so
    a worker cut by one tile's edge is whole in the next."""
    if grid <= 1:
        return [(0, 0, w, h)]
    tw, th = round(w / (grid - (grid - 1) * overlap)), round(h / (grid - (grid - 1) * overlap))
    xs = [round(i * (w - tw) / (grid - 1)) for i in range(grid)]
    ys = [round(j * (h - th) / (grid - 1)) for j in range(grid)]
    return [(x, y, x + tw, y + th) for y in ys for x in xs]


class TiledPersonDetector:
    """A general-purpose person detector run on overlapping tiles of the frame.

    The PPE model finds people poorly on wide, top-down plant cameras (measured on two recordings:
    1 of ~20 workers at 480 px); a COCO-trained detector on 2x2 tiles found ~20 of ~20. Tiling makes a
    40 px worker ~70 px for the model. Only `person` boxes come back; PPE is judged afterwards on each
    worker's full-resolution crop (inference.person_refine).
    """

    MAX_CALL = 16  # tiles per model call (TensorRT engines are built for batches up to 32)

    def __init__(self, detector: Detector, grid: int = 2) -> None:
        self.detector = detector
        self.grid = grid
        self.device = detector.device
        self.imgsz = detector.imgsz
        self.classes = ["person"]
        self.info = {**getattr(detector, "info", {}), "tiles": f"{grid}x{grid}"}

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]:
        tiles, owners = [], []
        for i, f in enumerate(frames):
            h, w = f.shape[:2]
            for x1, y1, x2, y2 in tile_boxes(w, h, self.grid):
                tiles.append(f[y1:y2, x1:x2])
                owners.append((i, x1, y1, x2, y2, w, h))
        found: list[list[Detection]] = []
        for j in range(0, len(tiles), self.MAX_CALL):
            found += self.detector.predict(tiles[j : j + self.MAX_CALL], conf, imgsz=imgsz)
        whole: list[list[Detection]] = [[] for _ in frames]
        cut: list[list[Detection]] = [[] for _ in frames]
        for (i, ox, oy, tx2, ty2, w, h), dets in zip(owners, found):
            for d in dets:
                if d.cls != "person":
                    continue
                b = (d.box[0] + ox, d.box[1] + oy, d.box[2] + ox, d.box[3] + oy)
                # touching an inner tile edge: probably cut, and whole in the neighbouring tile
                on_seam = (ox > 0 and b[0] <= ox + 2) or (oy > 0 and b[1] <= oy + 2) or \
                          (tx2 < w and b[2] >= tx2 - 2) or (ty2 < h and b[3] >= ty2 - 2)
                (cut if on_seam else whole)[i].append(Detection("person", d.conf, b))
        from .ppe_logic import containment, dedupe

        out = []
        for ws, cs in zip(whole, cut):
            ws = dedupe(ws, 0.5)
            # a cut box mostly inside a whole one is the same worker; a cut box alone is kept (a worker
            # bigger than the overlap, or standing on the seam in both tiles)
            out.append(ws + [c for c in dedupe(cs, 0.5) if not any(containment(c.box, k.box) >= 0.6 for k in ws)])
        return [dedupe(o, 0.5) for o in out]


_SHA_CACHE: dict[tuple[str, float, int], str] = {}


def _file_sha256(path: str) -> str:
    """SHA-256 of a weights file (cached per path / mtime / size): identifies the exact model."""
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return ""
    key = (str(p.resolve()), st.st_mtime, st.st_size)
    if key not in _SHA_CACHE:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        _SHA_CACHE[key] = h.hexdigest()
    return _SHA_CACHE[key]


def build_detector(cfg: ModelConfig) -> Detector:
    """Default detector factory: the PPE detector, plus a tiled person detector when
    `model.person_weights` is set, plus a phone detector when `model.phone_weights` is set."""
    primary: Detector = YoloDetector(cfg)
    if cfg.person_weights:
        pcfg = cfg.model_copy(update={"weights": cfg.person_weights, "class_map": {},
                                      "imgsz": cfg.person_imgsz, "cpu_imgsz": cfg.person_imgsz})
        try:
            people = YoloDetector(pcfg)
            if "person" not in people.classes:
                raise ValueError("no person class")
            primary = CompositeDetector(primary, TiledPersonDetector(people, cfg.person_tiles), keep={"person"},
                                        role="person", dedupe={"person"}, tile_every=cfg.person_tile_every)
            log.info("person detection via %s on %dx%d tiles%s", Path(cfg.person_weights).name, cfg.person_tiles, cfg.person_tiles,
                     f", every {cfg.person_tile_every} frames per camera" if cfg.person_tile_every > 1 else "")
        except Exception:
            log.exception("could not load person model %s - using the PPE model's person class only", cfg.person_weights)
    if not cfg.phone_weights:
        return primary
    # the behaviour model is a general-purpose detector; its class_map is irrelevant (ALIASES map
    # "cell phone" -> "phone"), and only "phone" detections are merged in.
    sec_cfg = cfg.model_copy(update={"weights": cfg.phone_weights, "class_map": {}})
    try:
        secondary = YoloDetector(sec_cfg)
    except Exception:
        log.exception("could not load phone model %s - phone detection disabled", cfg.phone_weights)
        return primary
    if "phone" not in secondary.classes:
        log.warning("phone model %s has no phone/cell-phone class - phone detection disabled", cfg.phone_weights)
        return primary
    log.info("phone detection enabled via %s", Path(cfg.phone_weights).name)
    return CompositeDetector(primary, secondary)
