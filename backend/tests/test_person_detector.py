"""Tiled person detection: tile geometry, mapping back to the frame, seam duplicates, merging with the
PPE model's own person boxes."""

from __future__ import annotations

import numpy as np

from app.detector import CompositeDetector, TiledPersonDetector, tile_boxes
from app.ppe_logic import Detection


class Fake:
    """Returns scripted detections per tile, in tile coordinates; records the tile sizes it saw."""

    device, imgsz, classes = "cpu", 640, ["person", "helmet"]

    def __init__(self, per_tile):
        self.per_tile = per_tile  # callable(tile index) -> list[Detection]
        self.seen: list[tuple[int, int]] = []

    def predict(self, frames, conf, imgsz=None):
        out = []
        for f in frames:
            out.append(self.per_tile(len(self.seen)))
            self.seen.append(f.shape[:2])
        return out


def test_tiles_cover_the_frame_with_overlap():
    t = tile_boxes(960, 540, 2)
    assert len(t) == 4 and t[0][:2] == (0, 0) and t[-1][2:] == (960, 540)
    assert t[0][2] > t[1][0]  # neighbours overlap
    assert tile_boxes(960, 540, 1) == [(0, 0, 960, 540)]


def test_boxes_are_mapped_back_to_frame_coordinates_and_non_persons_dropped():
    frame = np.zeros((540, 960, 3), np.uint8)
    t = tile_boxes(960, 540, 2)
    fake = Fake(lambda i: [Detection("person", 0.8, (100, 50, 140, 150)), Detection("helmet", 0.9, (1, 1, 5, 5))] if i == 3 else [])
    out = TiledPersonDetector(fake, 2).predict([frame], 0.3)[0]
    x, y = t[3][:2]
    assert [d.cls for d in out] == ["person"] and out[0].box == (100 + x, 50 + y, 140 + x, 150 + y)


def test_a_worker_on_a_seam_is_counted_once_but_two_close_workers_stay_two():
    frame = np.zeros((540, 960, 3), np.uint8)
    t = tile_boxes(960, 540, 2)
    x_seam = t[0][2]  # right edge of the top-left tile
    def per_tile(i):
        if i == 0:  # cut at the seam in tile 0 ...
            return [Detection("person", 0.7, (x_seam - 30, 100, x_seam, 220))]
        if i == 1:  # ... and whole in tile 1
            ox = t[1][0]
            return [Detection("person", 0.8, (x_seam - 30 - ox, 100, x_seam + 20 - ox, 220)),
                    Detection("person", 0.8, (x_seam + 25 - ox, 105, x_seam + 70 - ox, 225))]  # a second worker beside
        return []
    out = TiledPersonDetector(Fake(per_tile), 2).predict([frame], 0.3)[0]
    assert len(out) == 2


def test_person_boxes_from_both_models_are_merged():
    class Primary:
        device, imgsz, classes = "cpu", 480, ["person", "helmet"]

        def predict(self, frames, conf, imgsz=None):
            return [[Detection("person", 0.6, (100, 100, 150, 250)), Detection("helmet", 0.9, (110, 90, 140, 115))]]

    class People:
        device, imgsz, classes = "cpu", 640, ["person"]

        def predict(self, frames, conf, imgsz=None):
            return [[Detection("person", 0.9, (102, 98, 152, 252)), Detection("person", 0.7, (400, 100, 440, 200))]]

    det = CompositeDetector(Primary(), People(), keep={"person"}, role="person", dedupe={"person"})
    out = det.predict([np.zeros((540, 960, 3), np.uint8)], 0.3)[0]
    persons = sorted(d.box for d in out if d.cls == "person")
    assert persons == [(102, 98, 152, 252), (400, 100, 440, 200)]  # same worker merged, the new one added
    assert any(d.cls == "helmet" for d in out)
    assert det.predict([np.zeros((540, 960, 3), np.uint8)], 0.3, imgsz=320)[0][0].cls == "person"  # crop pass: PPE model only
