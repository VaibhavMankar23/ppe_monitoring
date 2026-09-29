"""Monitor.apply_config: only changed streams restart; engine reloads on model changes."""

from __future__ import annotations

import copy

import pytest

from app.config import parse_config
from app.pipeline import Monitor
from app.violations_db import ViolationStore
from helpers import FakeDetector, raw_config


@pytest.fixture()
def env(tmp_path):
    raw = raw_config(tmp_path, n_streams=3)
    mon = Monitor(parse_config(raw, tmp_path), store=ViolationStore(":memory:"), detector_factory=FakeDetector)
    mon.start()
    yield mon, raw, tmp_path
    mon.stop()


def apply(mon, raw, tmp_path):
    return mon.apply_config(parse_config(raw, tmp_path))


def test_only_the_changed_stream_restarts(env):
    mon, raw, tmp = env
    before = dict(mon.workers)
    new = copy.deepcopy(raw)
    new["streams"][1]["required_ppe"] = ["helmet"]
    r = apply(mon, new, tmp)
    assert r["restarted"] == ["cam2"]
    assert not r["engine_reloaded"]
    assert mon.workers["cam1"] is before["cam1"] and mon.workers["cam3"] is before["cam3"]
    assert mon.workers["cam2"] is not before["cam2"]
    assert mon.workers["cam2"].running and mon.workers["cam2"].required == ["helmet"]
    assert not before["cam2"].running  # old worker stopped
    assert mon.engines[0].workers == list(mon.workers.values())


def test_add_remove_and_disable_streams(env):
    mon, raw, tmp = env
    new = copy.deepcopy(raw)
    new["streams"].pop(0)  # remove cam1
    new["streams"][0]["enabled"] = False  # cam2 disabled
    new["streams"].append({"id": "cam9", "name": "Dock", "source": {"type": "rtsp", "uri": "rtsp://127.0.0.1:1/x"}})
    old_cam1 = mon.workers["cam1"]
    r = apply(mon, new, tmp)
    assert r["removed"] == ["cam1"] and not old_cam1.running
    assert r["stopped"] == ["cam2"] and not mon.workers["cam2"].running
    assert r["added"] == ["cam9"] and mon.workers["cam9"].running
    assert list(mon.workers) == ["cam2", "cam3", "cam9"]


def test_model_change_reloads_engine_without_restarting_streams(env):
    mon, raw, tmp = env
    workers, engine = dict(mon.workers), mon.engines[0]
    new = copy.deepcopy(raw)
    new["model"]["iou"] = 0.5
    r = apply(mon, new, tmp)
    assert r["engine_reloaded"] and r["restarted"] == []
    assert mon.engines[0] is not engine and mon.engines[0].detector.cfg.iou == 0.5
    assert all(mon.workers[k] is workers[k] for k in workers)


def test_global_worker_setting_restarts_running_streams(env):
    mon, raw, tmp = env
    new = copy.deepcopy(raw)
    new.setdefault("alerts", {})["cooldown_seconds"] = 5
    r = apply(mon, new, tmp)
    assert sorted(r["restarted"]) == ["cam1", "cam2", "cam3"]


def test_default_confidence_applies_live(env):
    mon, raw, tmp = env
    w = mon.workers["cam1"]
    new = copy.deepcopy(raw)
    new["model"]["default_confidence"] = 0.6
    r = apply(mon, new, tmp)
    assert mon.workers["cam1"] is w and w.confidence == 0.6
    assert r["engine_reloaded"]  # model section changed


def test_server_changes_are_reported_not_applied(env):
    mon, raw, tmp = env
    new = copy.deepcopy(raw)
    new["server"] = {"port": 9001}
    r = apply(mon, new, tmp)
    assert r["requires_server_restart"] == ["server.port"]
    assert mon.cfg.server.port == 8000
