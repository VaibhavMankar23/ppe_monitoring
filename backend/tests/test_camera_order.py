"""Cameras are always listed in the configured order (the UI no longer re-sorts by status), also after
a settings change that reorders or adds cameras."""

from __future__ import annotations

from app.config import load_config, parse_config
from app.pipeline import Monitor
from app.violations_db import ViolationStore
from helpers import FakeDetector, raw_config, write_config


def ids(mon):
    return [s["id"] for s in mon.snapshot()["streams"]]


def test_snapshot_keeps_the_configured_order(tmp_path):
    raw = raw_config(tmp_path, n_streams=3)
    raw["streams"] = [raw["streams"][2], raw["streams"][0], raw["streams"][1]]  # cam3, cam1, cam2
    path = write_config(tmp_path, raw)
    mon = Monitor(load_config(path), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    assert ids(mon) == ["cam3", "cam1", "cam2"]
    raw2 = raw_config(tmp_path, n_streams=4)
    raw2["streams"] = [raw2["streams"][i] for i in (1, 3, 0, 2)]  # reordered, and cam4 added in the middle
    mon.apply_config(parse_config(raw2, tmp_path))
    assert ids(mon) == ["cam2", "cam4", "cam1", "cam3"]
    mon.stop()
