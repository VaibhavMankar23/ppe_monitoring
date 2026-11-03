from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import load_config
from app.detector import build_class_table

CFG = """
model:
  weights: ${TEST_WEIGHTS:-models/w.pt}
streams:
  - id: cam1
    name: Camera 1
    source: { type: file, uri: "${PPE_VIDEOS_DIR:-vids}/cam1.mp4" }
    required_ppe: [helmet, vest]
  - id: cam2
    name: Camera 2
    source: { type: rtsp, uri: "rtsp://10.0.0.2/stream" }
    required_ppe: [helmet]
"""


def write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "config.yaml"
    p.write_text(text, encoding="utf-8")
    return p


def test_paths_resolved_relative_to_config_and_env_expanded(tmp_path, monkeypatch):
    monkeypatch.delenv("TEST_WEIGHTS", raising=False)
    cams = tmp_path / "elsewhere" / "cams"  # absolute on every OS
    monkeypatch.setenv("PPE_VIDEOS_DIR", str(cams))
    cfg = load_config(write(tmp_path, CFG))
    assert Path(cfg.model.weights) == (tmp_path / "models" / "w.pt").resolve()
    assert Path(cfg.streams[0].source.uri) == (cams / "cam1.mp4").resolve()
    assert cfg.streams[1].source.uri == "rtsp://10.0.0.2/stream"  # non-file URIs untouched
    assert cfg.streams[0].required_ppe == ["helmet", "vest"]


def test_unknown_ppe_item_rejected(tmp_path):
    with pytest.raises(ValidationError):
        load_config(write(tmp_path, CFG.replace("[helmet]", "[helmet, jetpack]")))


def test_repo_configs_are_valid_and_start_without_cameras():
    for name in ("config.yaml", "config.default.yaml"):
        path = Path(__file__).resolve().parent.parent / name
        if not path.exists():  # config.yaml is not shipped in the Docker image
            continue
        cfg = load_config(path)
        if name == "config.default.yaml":  # the shipped default; config.yaml is this machine's runtime config
            assert cfg.streams == []  # cameras are added from the UI


def test_class_table_uses_map_then_aliases():
    names = {0: "Hard_hat", 1: "NO-Safety Vest", 2: "Worker", 3: "Fire_Extinguisher", 4: "Glass"}
    table = build_class_table(names, {"Glass": "goggles"})
    assert table == {0: "helmet", 1: "no_vest", 2: "person", 4: "goggles"}


def test_camera_fields_never_expand_secret_env_vars(tmp_path, monkeypatch):
    # Admins edit cameras and camera addresses are echoed back: ${PPE_JWT_SECRET} must stay literal
    monkeypatch.setenv("PPE_JWT_SECRET", "top-secret-value")
    text = CFG.replace("rtsp://10.0.0.2/stream", "rtsp://10.0.0.2/${PPE_JWT_SECRET}")
    cfg = load_config(write(tmp_path, text))
    assert cfg.streams[1].source.uri == "rtsp://10.0.0.2/${PPE_JWT_SECRET}"


def test_network_cameras_only_accept_camera_protocols(tmp_path):
    for bad in ("file:///etc/passwd", "concat:/etc/passwd", "ftp://10.0.0.2/x"):
        with pytest.raises(ValidationError):
            load_config(write(tmp_path, CFG.replace("rtsp://10.0.0.2/stream", bad)))
