"""NVIDIA GPU path without a GPU: automatic batch sizes per device, TensorRT engine build / cache /
fallback, and the detector's PyTorch fallback (engine that fails to load, sizes beyond the engine)."""

from __future__ import annotations

from pathlib import Path

import pytest

import app.detector as D
from app.config import InferenceConfig, ModelConfig
from app.pipeline import effective_batches


# ------------------------------------------------------------------ automatic batch sizes
@pytest.mark.parametrize("device, expected", [
    ("cuda:0", (16, 8)), ("cuda:1", (16, 8)), ("intel:gpu", (8, 4)), ("intel:cpu", (8, 2)), ("cpu", (8, 2)), ("", (8, 2)),
])
def test_auto_batches_follow_the_device(device, expected):
    assert effective_batches(InferenceConfig(), device) == expected


def test_configured_batches_win_over_auto():
    assert effective_batches(InferenceConfig(max_batch=4, refine_batch=3), "cuda:0") == (4, 3)
    assert effective_batches(InferenceConfig(max_batch=4), "cuda:0") == (4, 8)  # only the 0 one is automatic


# ------------------------------------------------------------------ TensorRT engine build and cache
class FakeYOLO:
    """Stands in for ultralytics.YOLO: records exports and loads, never touches a GPU."""

    exports: list[dict] = []
    loaded: list[str] = []
    fail_export = False
    broken_engines = False

    def __init__(self, src, task=None):
        self.src = str(src)
        FakeYOLO.loaded.append(self.src)

    def export(self, **kw):
        if FakeYOLO.fail_export:
            raise RuntimeError("TensorRT not installed")
        FakeYOLO.exports.append(kw)
        out = Path(self.src).with_suffix(".engine")
        out.write_bytes(b"engine")
        return str(out)

    @property
    def names(self):
        if self.src.endswith(".engine") and FakeYOLO.broken_engines:
            raise RuntimeError("engine built for another GPU")
        return {0: "Person", 1: "Hardhat", 2: "NO-Hardhat"}

    def predict(self, frames, **kw):
        return [type("R", (), {"boxes": None})() for _ in frames]


@pytest.fixture()
def fake_yolo(monkeypatch, tmp_path):
    import ultralytics

    FakeYOLO.exports, FakeYOLO.loaded, FakeYOLO.fail_export, FakeYOLO.broken_engines = [], [], False, False
    monkeypatch.setattr(ultralytics, "YOLO", FakeYOLO)
    w = tmp_path / "best.pt"
    w.write_bytes(b"weights")
    return w


def test_engine_is_built_once_with_dynamic_shapes_and_cached(fake_yolo):
    path = D.tensorrt_engine_path(str(fake_yolo), 480, True, "cuda:1")
    assert Path(path).name == f"best_480_b{D.TRT_MAX_BATCH}_fp16.engine" and Path(path).exists()
    kw = FakeYOLO.exports[0]
    assert kw["format"] == "engine" and kw["dynamic"] and kw["batch"] == D.TRT_MAX_BATCH and kw["half"] and kw["device"] == 1
    assert D.tensorrt_engine_path(str(fake_yolo), 480, True, "cuda:1") == path
    assert len(FakeYOLO.exports) == 1  # second start reuses the cached engine


def test_failed_engine_build_falls_back_to_pytorch(fake_yolo):
    FakeYOLO.fail_export = True
    assert D.tensorrt_engine_path(str(fake_yolo), 480, True, "cuda:0") is None


def _cuda(monkeypatch, available=True):
    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: available)


def test_select_backend_uses_tensorrt_on_nvidia(fake_yolo, monkeypatch):
    _cuda(monkeypatch)
    weights, device, imgsz = D.select_backend(ModelConfig(weights=str(fake_yolo), imgsz=480))
    assert weights.endswith(".engine") and device == "cuda:0" and imgsz == 480


def test_select_backend_pytorch_when_tensorrt_off_or_failing(fake_yolo, monkeypatch):
    _cuda(monkeypatch)
    assert D.select_backend(ModelConfig(weights=str(fake_yolo), tensorrt=False))[0] == str(fake_yolo)
    FakeYOLO.fail_export = True
    assert D.select_backend(ModelConfig(weights=str(fake_yolo)))[0] == str(fake_yolo)


# ------------------------------------------------------------------ detector fallbacks
def test_engine_that_fails_to_load_falls_back_to_pytorch(fake_yolo, monkeypatch):
    _cuda(monkeypatch)
    FakeYOLO.broken_engines = True
    det = D.YoloDetector(ModelConfig(weights=str(fake_yolo), imgsz=480))
    assert det.device == "cuda:0" and not det.is_engine and det.info["runtime"] == "best.pt"


def test_sizes_beyond_the_engine_use_pytorch(fake_yolo, monkeypatch):
    _cuda(monkeypatch)
    det = D.YoloDetector(ModelConfig(weights=str(fake_yolo), imgsz=480))
    assert det.is_engine
    frame = [__import__("numpy").zeros((64, 64, 3), dtype="uint8")]
    det.predict(frame, 0.5, imgsz=640)  # evidence pass: within 2 x 480
    det.predict(frame, 0.5, imgsz=1280)  # beyond the engine's range
    assert FakeYOLO.loaded[-2].endswith(".engine") and FakeYOLO.loaded[-1] == str(fake_yolo)
