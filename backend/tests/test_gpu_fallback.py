"""A GPU without enough free memory for the TensorRT engines must not stop the server from starting."""

from __future__ import annotations

import pytest

from app.config import load_config
from app.pipeline import Monitor
from app.violations_db import ViolationStore
from helpers import FakeDetector, raw_config, write_config


def _monitor(tmp_path, factory):
    cfg = load_config(write_config(tmp_path, raw_config(tmp_path, n_streams=1)))
    assert cfg.model.tensorrt is True
    return cfg, Monitor(cfg, store=ViolationStore(":memory:"), detector_factory=factory)


def test_out_of_memory_falls_back_to_pytorch(tmp_path):
    seen = []

    def factory(mcfg):
        seen.append(mcfg.tensorrt)
        if mcfg.tensorrt:
            raise RuntimeError("[TRT] Error Code 2: OutOfMemory (Requested size was 1371340800 bytes.)")
        return FakeDetector(mcfg)

    cfg, mon = _monitor(tmp_path, factory)
    mon.start()
    try:
        assert seen == [True, False]  # tried TensorRT, then PyTorch
        assert mon.cfg.model.tensorrt is False and mon.engines
    finally:
        mon.stop()


def test_other_errors_still_stop_startup(tmp_path):
    def factory(mcfg):
        raise FileNotFoundError("model weights not found: /models/x.pt")

    _, mon = _monitor(tmp_path, factory)
    with pytest.raises(FileNotFoundError):
        mon.start()


def test_healthy_gpu_keeps_tensorrt(tmp_path):
    cfg, mon = _monitor(tmp_path, lambda m: FakeDetector(m))
    mon.start()
    try:
        assert mon.cfg.model.tensorrt is True
    finally:
        mon.stop()
