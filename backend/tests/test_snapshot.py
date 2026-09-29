"""Violation snapshots are cut from the clean full-resolution frame."""

from __future__ import annotations

import numpy as np
import pytest

from app.annotate import violation_snapshot


@pytest.mark.parametrize("box", [
    (900.0, 400.0, 980.0, 620.0),   # small worker mid-frame
    (0.0, 0.0, 60.0, 200.0),        # touching the top-left corner
    (1880.0, 900.0, 1920.0, 1080.0),  # touching the bottom-right corner
])
def test_snapshot_is_upscaled_crop_with_outline(box):
    full = np.full((1080, 1920, 3), 90, np.uint8)
    snap = violation_snapshot(full, box, track_id=7, missing=["helmet", "vest"])
    assert snap.ndim == 3 and snap.shape[0] >= 360  # small people are upscaled for readability
    assert snap.shape[0] < 1080 or snap.shape[1] < 1920  # it's a crop, not the whole frame
    red = (snap[:, :, 2] > 200) & (snap[:, :, 1] < 80)
    assert red.any()  # person outline / caption drawn


def test_snapshot_does_not_modify_the_source_frame():
    full = np.full((1080, 1920, 3), 90, np.uint8)
    violation_snapshot(full, (900.0, 400.0, 980.0, 620.0), 1, ["helmet"])
    assert (full == 90).all()
