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


def select_backend(cfg: ModelConfig) -> tuple[str, str, int]:
    """Pick (weights, device, imgsz). Order for `auto`: CUDA > OpenVINO iGPU > OpenVINO CPU > PyTorch CPU."""
    import torch

    req = cfg.device
    cuda = torch.cuda.is_available()
    if req.startswith("cuda") and not cuda:
        log.warning("CUDA requested but not available - falling back to auto")
        req = "auto"
    if req.startswith("cuda") or (req == "auto" and cuda):
        return cfg.weights, (req if req.startswith("cuda") else "cuda:0"), cfg.imgsz
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
    """Thread-safe wrapper around an Ultralytics YOLO model (PyTorch / OpenVINO)."""

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

        self._weights = weights
        self._model = YOLO(weights, task="detect")
        # One instance per extra input size (person-crop pass, alert evidence pass), so alternating
        # sizes never force a predictor re-initialise / accelerator recompile.
        self._sized: dict[int, YOLO] = {}
        self._lock = threading.Lock()
        names = dict(self._model.names)  # read once: on exported models each access rebuilds the backend
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

    def _warmup(self) -> None:
        t0 = time.perf_counter()
        self.predict([np.zeros((self.imgsz, self.imgsz, 3), dtype=np.uint8)], 0.5)
        log.info("warm-up done in %.0f ms", (time.perf_counter() - t0) * 1000)

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]:
        """Detect on full frames (imgsz=None) or on small crops (imgsz = crop inference size)."""
        if not frames:
            return []
        if imgsz is None:
            model = self._model
        else:
            model = self._sized.get(imgsz)
            if model is None:
                from ultralytics import YOLO

                model = self._sized[imgsz] = YOLO(self._weights, task="detect")
        # FP16 only matters on CUDA; newer Ultralytics warns on every call when `half` is passed.
        extra = {"half": True} if self.half else {}
        with self._lock:
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
        out: list[list[Detection]] = []
        for r in results:
            dets: list[Detection] = []
            if r.boxes is not None and len(r.boxes):
                xyxy = r.boxes.xyxy.cpu().numpy()
                confs = r.boxes.conf.cpu().numpy()
                clss = r.boxes.cls.cpu().numpy().astype(int)
                for b, c, k in zip(xyxy, confs, clss):
                    dets.append(Detection(self.class_table[int(k)], float(c), tuple(float(v) for v in b)))  # type: ignore[arg-type]
            out.append(dets)
        return out


class CompositeDetector:
    """Runs a primary detector (person + PPE) and a secondary detector (behaviour classes) and
    unions their detections.

    The secondary detector (a general-purpose model, e.g. COCO for "cell phone") only runs on the
    full-frame pass. Person-crop and alert-evidence passes (imgsz set) go to the primary alone:
    those passes exist to sharpen PPE/person boxes, and re-running a second model on every crop
    would roughly double inference cost for no benefit — phone association is done on the full frame.
    """

    def __init__(self, primary: Detector, secondary: Detector, keep: "set[str] | None" = None) -> None:
        self.primary = primary
        self.secondary = secondary
        self.keep = keep if keep is not None else {"phone"}  # secondary classes to merge in
        self.device = primary.device
        self.imgsz = primary.imgsz
        self.classes = sorted(set(primary.classes) | self.keep)
        self.info = {**getattr(primary, "info", {}), "phone_model": getattr(secondary, "info", {})}

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]:
        base = self.primary.predict(frames, conf, imgsz=imgsz)
        if imgsz is not None:  # crop / evidence pass: primary only (no behaviour detection)
            return base
        try:
            extra = self.secondary.predict(frames, conf)
        except Exception:  # a behaviour-model failure must never take down PPE detection
            log.exception("secondary (behaviour) detector failed; skipping this batch")
            return base
        for dets, ex in zip(base, extra):
            dets.extend(d for d in ex if d.cls in self.keep)
        return base


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
    """Default detector factory: the PPE detector alone, or a CompositeDetector adding a phone
    detector when `model.phone_weights` is set."""
    primary = YoloDetector(cfg)
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
