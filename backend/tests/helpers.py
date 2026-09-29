"""Shared test fixtures: a model-free detector and a minimal config."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import yaml

from app.config import ModelConfig
from app.ppe_logic import Detection


class FakeDetector:
    """Stands in for YoloDetector so tests never load a model."""

    device = "fake"
    imgsz = 480
    classes = ["person", "helmet"]

    def __init__(self, cfg: ModelConfig | None = None) -> None:
        self.cfg = cfg

    def predict(self, frames: list[np.ndarray], conf: float, imgsz: int | None = None) -> list[list[Detection]]:
        return [[] for _ in frames]


def raw_config(tmp: Path, n_streams: int = 2) -> dict[str, Any]:
    """A valid raw config; weights point at a real (empty) file, sources at missing files."""
    (tmp / "w.pt").write_bytes(b"")
    return {
        "model": {"weights": "w.pt", "device": "cpu"},
        "inference": {"person_refine": False},
        "alerts": {"db_path": ":memory:", "retention_days": 30},
        "streams": [
            {"id": f"cam{i}", "name": f"Camera {i}",
             "source": {"type": "file", "uri": f"missing_{i}.mp4", "reconnect_delay": 0.2},
             "required_ppe": ["helmet", "vest"]}
            for i in range(1, n_streams + 1)
        ],
    }


def write_config(tmp: Path, raw: dict[str, Any]) -> Path:
    p = tmp / "config.yaml"
    p.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    (tmp / "config.default.yaml").write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return p


# ------------------------------------------------------------------ auth helpers
TEST_SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
SUPER_PASSWORD = "Sup3rSecret!"
ADMIN_PASSWORD = "Adm1nSecret!"


def auth_settings():
    from app.security import AuthSettings

    return AuthSettings(secret=TEST_SECRET)


def login(client, username: str, password: str, **extra: Any) -> dict[str, Any]:
    r = client.post("/api/auth/login", json={"username": username, "password": password, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def bootstrap_super_admin(client) -> str:
    """Seeded admin -> forced password change -> returns a usable super_admin access token."""
    from app.security import SEED_PASSWORD, SEED_USERNAME

    first = login(client, SEED_USERNAME, SEED_PASSWORD)
    assert first["user"]["must_change_password"] is True
    r = client.post("/api/auth/change-password", headers=bearer(first["access_token"]),
                    json={"current_password": SEED_PASSWORD, "new_password": SUPER_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def create_admin(client, super_token: str, username: str = "operator") -> str:
    """Creates an Admin-role user (no forced change) and returns their access token."""
    r = client.post("/api/users", headers=bearer(super_token),
                    json={"username": username, "password": ADMIN_PASSWORD, "role": "admin", "must_change_password": False})
    assert r.status_code == 201, r.text
    return login(client, username, ADMIN_PASSWORD)["access_token"]
