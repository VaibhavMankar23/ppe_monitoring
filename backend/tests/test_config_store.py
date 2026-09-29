"""Config validation (field-level errors), atomic save, backups, reset and restore."""

from __future__ import annotations

import copy
import os

import pytest
import yaml

from app.config_store import ConfigConflict, ConfigInvalid, ConfigStore, etag_of
from helpers import raw_config, write_config


@pytest.fixture()
def store(tmp_path):
    return ConfigStore(write_config(tmp_path, raw_config(tmp_path)))


def errors_of(store: ConfigStore, **kw) -> dict[str, str]:
    with pytest.raises(ConfigInvalid) as ei:
        store.save(**kw)
    return {e.loc: e.msg for e in ei.value.errors}


def test_valid_save_round_trips(store, tmp_path):
    raw = store.read()["config"]
    raw["streams"][0]["name"] = "Gate A"
    cfg = store.save(config=raw)
    assert cfg.streams[0].name == "Gate A"
    assert yaml.safe_load(store.read_text())["streams"][0]["name"] == "Gate A"


@pytest.mark.parametrize("mutate, loc", [
    (lambda r: r["server"].__setitem__("port", 70000), "server.port"),
    (lambda r: r["model"].__setitem__("default_confidence", 1.5), "model.default_confidence"),
    (lambda r: r["model"].__setitem__("device", "tpu"), "model.device"),
    (lambda r: r["streams"][1].__setitem__("required_ppe", ["helmet", "jetpack"]), "streams.1.required_ppe"),
    (lambda r: r["streams"][0]["source"].__setitem__("type", "ftp"), "streams.0.source.type"),
    (lambda r: r["streams"][1].__setitem__("id", "cam1"), "streams"),
    (lambda r: r["streams"][0].__setitem__("id", "bad id!"), "streams.0.id"),
    (lambda r: r["alerts"].__setitem__("retention_days", -1), "alerts.retention_days"),
])
def test_field_level_errors(store, mutate, loc):
    raw = store.read()["config"]
    raw.setdefault("server", {})
    mutate(raw)
    errs = errors_of(store, config=raw)
    assert loc in errs, errs


def test_invalid_save_leaves_file_and_backups_untouched(store, tmp_path):
    before = store.read_text()
    raw = store.read()["config"]
    raw["model"]["iou"] = 5
    errors_of(store, config=raw)
    assert store.read_text() == before
    assert store.backups() == []


def test_yaml_syntax_error_reports_line(store):
    errs = None
    with pytest.raises(ConfigInvalid) as ei:
        store.save(yaml_text="model:\n  weights: w.pt\n  device: [cpu\nstreams: []\n")
    errs = ei.value.errors
    assert errs[0].loc == "yaml" and errs[0].line is not None


def test_every_save_backs_up_and_keeps_last_10(store, tmp_path):
    raw = store.read()["config"]
    for i in range(13):
        raw["streams"][0]["name"] = f"Camera v{i}"
        store.save(config=copy.deepcopy(raw))
    backups = store.backups()
    assert len(backups) == 10
    assert all(b["name"].startswith("config.backup.") and b["name"].endswith(".yaml") for b in backups)
    # newest backup holds the state *before* the last save
    newest = yaml.safe_load((tmp_path / backups[0]["name"]).read_text())
    assert newest["streams"][0]["name"] == "Camera v11"


def test_atomic_write_never_corrupts_on_crash(store, tmp_path, monkeypatch):
    before = store.read_text()

    def boom(src, dst):  # simulate a crash right before the rename
        raise OSError("disk yanked")

    monkeypatch.setattr(os, "replace", boom)
    raw = store.read()["config"]
    raw["streams"][0]["name"] = "never written"
    with pytest.raises(OSError):
        store.save(config=raw)
    assert store.read_text() == before  # original intact
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".config.")]  # temp file cleaned up


def test_etag_conflict(store):
    raw = store.read()["config"]
    stale = etag_of("something else")
    with pytest.raises(ConfigConflict):
        store.save(config=raw, etag=stale)
    store.save(config=raw, etag=store.read()["etag"])  # fresh etag works


def test_reset_restores_defaults_and_restore_backup(store, tmp_path):
    raw = store.read()["config"]
    raw["streams"][0]["name"] = "Changed"
    store.save(config=raw)
    store.reset(keep_cameras=False)  # the full factory reset (cameras too)
    assert yaml.safe_load(store.read_text())["streams"][0]["name"] == "Camera 1"
    # the backup taken just before reset contains "Changed"
    name = store.backups()[0]["name"]
    store.restore(name)
    assert yaml.safe_load(store.read_text())["streams"][0]["name"] == "Changed"


def test_restore_rejects_path_traversal(store):
    with pytest.raises(ConfigInvalid):
        store.restore("../../etc/passwd")


def test_yaml_validation_errors_point_at_lines(store):
    text = store.read_text().replace("device: cpu", "device: tpu")
    with pytest.raises(ConfigInvalid) as ei:
        store.save(yaml_text=text)
    err = next(e for e in ei.value.errors if e.loc == "model.device")
    assert err.line == next(i for i, ln in enumerate(text.splitlines(), 1) if "device: tpu" in ln)
