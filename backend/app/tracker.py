"""Lightweight ByteTrack-style multi-object tracker for person boxes.

Implements the ByteTrack two-stage association (high-confidence detections first,
then low-confidence ones against still-unmatched tracks) with a constant-velocity
motion model and Hungarian matching on IoU. Kept self-contained so it does not
depend on Ultralytics' internal tracker API, which changes between releases.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from scipy.optimize import linear_sum_assignment

from .ppe_logic import Box, Detection, TrackedPerson, iou


class Tracker(Protocol):
    def update(self, detections: list[Detection], now: float, high_thresh: float | None = None) -> list[TrackedPerson]: ...
    def reset(self) -> None: ...


@dataclass
class _Track:
    track_id: int
    box: Box
    conf: float
    last_seen: float
    vx: float = 0.0  # centre velocity, px / second
    vy: float = 0.0
    hits: int = 1

    def predict(self, now: float) -> Box:
        dt = max(0.0, now - self.last_seen)
        dx, dy = self.vx * dt, self.vy * dt
        x1, y1, x2, y2 = self.box
        return (x1 + dx, y1 + dy, x2 + dx, y2 + dy)

    def update(self, det: Detection, now: float) -> None:
        dt = now - self.last_seen
        if dt > 1e-3:
            ocx, ocy = (self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2
            ncx, ncy = (det.box[0] + det.box[2]) / 2, (det.box[1] + det.box[3]) / 2
            a = 0.5  # EMA on velocity
            self.vx = a * (ncx - ocx) / dt + (1 - a) * self.vx
            self.vy = a * (ncy - ocy) / dt + (1 - a) * self.vy
        self.box, self.conf, self.last_seen = det.box, det.conf, now
        self.hits += 1


def _match(tracks: list[_Track], dets: list[Detection], now: float, thresh: float) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    """Hungarian matching on IoU. Returns (matches, unmatched_track_idx, unmatched_det_idx)."""
    if not tracks or not dets:
        return [], list(range(len(tracks))), list(range(len(dets)))
    preds = [t.predict(now) for t in tracks]
    cost = np.array([[1.0 - iou(p, d.box) for d in dets] for p in preds], dtype=np.float32)
    rows, cols = linear_sum_assignment(cost)
    matches, mt, md = [], set(), set()
    for r, c in zip(rows, cols):
        if 1.0 - cost[r, c] >= thresh:
            matches.append((r, c))
            mt.add(r)
            md.add(c)
    return matches, [i for i in range(len(tracks)) if i not in mt], [j for j in range(len(dets)) if j not in md]


def _match_distance(tracks: list[_Track], dets: list[Detection], now: float) -> list[tuple[int, int]]:
    """Low frame rates: match by distance from each track's predicted position, in body heights.

    A worker walking ~0.7 body heights a second has left their old box entirely when frames are
    seconds apart, so IoU finds nothing. Allowed distance grows with the time since the track was
    seen (capped at 2 heights) and the two boxes must be of similar size."""
    if not tracks or not dets:
        return []
    big = 1e6
    cost = np.full((len(tracks), len(dets)), big, dtype=np.float32)
    for i, t in enumerate(tracks):
        p = t.predict(now)
        ph = max(1.0, p[3] - p[1])
        reach = ph * min(2.0, 0.5 + 0.7 * max(0.0, now - t.last_seen))
        for j, d in enumerate(dets):
            dh = max(1.0, d.box[3] - d.box[1])
            if not 0.6 <= dh / ph <= 1.67:
                continue
            dist = (((p[0] + p[2]) - (d.box[0] + d.box[2])) ** 2 + ((p[1] + p[3]) - (d.box[1] + d.box[3])) ** 2) ** 0.5 / 2
            if dist <= reach:
                cost[i, j] = dist / ph
    rows, cols = linear_sum_assignment(cost)
    return [(r, c) for r, c in zip(rows, cols) if cost[r, c] < big]


class ByteTracker:
    def __init__(
        self,
        high_thresh: float = 0.45,
        low_thresh: float = 0.15,
        match_iou: float = 0.25,
        max_lost_seconds: float = 2.0,
        min_hits: int = 2,
    ) -> None:
        self.high_thresh = high_thresh
        self.low_thresh = low_thresh
        self.match_iou = match_iou
        self.max_lost_seconds = max_lost_seconds
        self.min_hits = min_hits
        self._tracks: list[_Track] = []
        self._ids = itertools.count(1)
        self._first_frame = True
        self._last_update: float | None = None
        self._interval = 0.0  # typical seconds between updates (EMA): this camera's detection rate

    def reset(self) -> None:
        self._tracks.clear()
        self._ids = itertools.count(1)
        self._first_frame = True

    def live_ids(self) -> set[int]:
        return {t.track_id for t in self._tracks}

    def update(self, detections: list[Detection], now: float, high_thresh: float | None = None) -> list[TrackedPerson]:
        """`high_thresh` overrides the first-stage threshold (e.g. the per-tile confidence slider)."""
        hi = self.high_thresh if high_thresh is None else high_thresh
        lo = min(self.low_thresh, hi)
        high = [d for d in detections if d.conf >= hi]
        low = [d for d in detections if lo <= d.conf < hi]

        if self._last_update is not None and now > self._last_update:
            dt = now - self._last_update
            self._interval = dt if self._interval == 0.0 else 0.8 * self._interval + 0.2 * dt
        self._last_update = now
        # Drop tracks lost for too long before matching so they can't be revived. "Too long" is at
        # least 3 frames at this camera's rate: at 0.5 fps a fixed 2 s dropped every worker between
        # two frames, so each got a new ID every frame and no violation could ever be confirmed.
        lost = max(self.max_lost_seconds, 3.0 * self._interval)
        self._tracks = [t for t in self._tracks if now - t.last_seen <= lost]

        # Stage 1: every live track vs high-confidence detections.
        m1, um_tracks, um_high = _match(self._tracks, high, now, self.match_iou)
        matched: list[_Track] = []
        for ti, di in m1:
            self._tracks[ti].update(high[di], now)
            matched.append(self._tracks[ti])

        # Stage 2: remaining tracks vs low-confidence detections (recovers occluded people).
        rest = [self._tracks[i] for i in um_tracks]
        m2, um_rest, _ = _match(rest, low, now, max(0.1, self.match_iou - 0.05))
        for ti, di in m2:
            rest[ti].update(low[di], now)
            matched.append(rest[ti])

        # Stage 3: tracks still unmatched vs remaining confident detections, by distance (low fps).
        still = [rest[i] for i in um_rest]
        cand = [high[i] for i in um_high]
        used: set[int] = set()
        for ti, dj in _match_distance(still, cand, now):
            still[ti].update(cand[dj], now)
            matched.append(still[ti])
            used.add(um_high[dj])
        um_high = [i for i in um_high if i not in used]

        # New tracks from unmatched high-confidence detections.
        for di in um_high:
            t = _Track(next(self._ids), high[di].box, high[di].conf, now)
            if self._first_frame:
                t.hits = self.min_hits
            self._tracks.append(t)
            matched.append(t)
        self._first_frame = False

        return [
            TrackedPerson(t.track_id, t.box, t.conf)
            for t in matched
            if t.hits >= self.min_hits
        ]
