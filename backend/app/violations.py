"""Alert confirmation / de-duplication: decides *when* a non-compliant worker becomes a violation,
and which later observations belong to that same violation.

Storage of violations lives in `violations_db.py`."""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any, Callable

from .ppe_logic import PersonCompliance, iou

Box = tuple[float, float, float, float]


@dataclass
class Incident:
    """One violation event: a worker continuously (up to `gap` s) non-compliant.

    It becomes one stored record (`record_id`); later observations extend it instead of creating
    duplicates. `tracks` holds every track ID that was merged into it (ID switches, double captures).
    """

    key: int
    tracks: set[int]
    missing: set[str]
    box: Box
    start: float
    last_seen: float
    observations: int = 1
    record_id: int | None = None
    record_gone: bool = False  # the record was deleted while the event went on: stay quiet until it ends
    ended: bool = False
    member_boxes: dict[int, Box] = field(default_factory=dict)  # last box of every merged track


@dataclass
class Fire:
    """A newly confirmed incident. `best` is the payload of the best-scored frame of its confirmation
    window (see `AlertDebouncer.step(score=...)`); None when no scorer was given."""

    person: PersonCompliance
    incident: Incident
    best: Any = None
    since: float = 0.0  # when this worker's confirmation window began (first non-compliant frame)


@dataclass
class Step:
    fired: list[Fire] = field(default_factory=list)
    extended: list[Incident] = field(default_factory=list)  # incidents that got a new observation
    ended: list[Incident] = field(default_factory=list)  # incidents that just ended (no longer extendable)


def _contained(a: Box, b: Box) -> float:
    """Share of the smaller box that lies inside the other (1.0 = one box is fully inside the other)."""
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return iw * ih / smaller if smaller > 0 else 0.0


class AlertDebouncer:
    """Temporal confirmation + incident de-duplication.

    * confirmation: a track must be non-compliant for `min_frames` consecutive processed frames
      AND for at least `min_seconds`; any compliant / undeterminable frame resets it;
    * best evidence: while a track's confirmation window runs, the best-scored frame is kept, so
      the violation is recorded from that frame rather than from whichever frame confirmed it;
    * incidents: a confirmed worker opens one incident. Later confirmed frames of the same worker
      extend it (duration, observation count, newly missing items) instead of creating a new
      violation. An incident ends after `gap` s without the violation; a new violation for the
      same worker needs the incident to have ended AND `cooldown` s to have passed since it began;
    * track-ID changes: a new track at the spot where an incident's worker was last seen (tracker
      re-acquired them after an occlusion), or a second box heavily overlapping it (one worker
      captured twice), joins that incident instead of raising its own. "Heavily overlapping" also
      covers a box mostly inside the other one: the detector often alternates between one box around
      two workers standing together and a box per worker, each getting its own track ID.
    """

    def __init__(self, min_frames: int = 4, cooldown: float = 30.0, handoff_seconds: float = 4.0,
                 dedup_iou: float = 0.7, min_seconds: float = 0.0, gap: float | None = None,
                 dedup_contain: float = 0.8) -> None:
        self.min_frames = max(1, min_frames)
        self.min_seconds = max(0.0, min_seconds)
        self.cooldown = cooldown
        self.handoff_seconds = handoff_seconds
        self.dedup_iou = dedup_iou
        self.dedup_contain = dedup_contain
        # how long an incident survives without the violation being seen (default: the ID hand-off window)
        self.gap = handoff_seconds if gap is None else max(0.0, gap)
        self._streak: dict[int, int] = {}
        self._streak_t0: dict[int, float] = {}
        self._best: dict[int, tuple[float, Any]] = {}
        self._track_seen: dict[int, float] = {}
        self._incidents: list[Incident] = []
        self._by_track: dict[int, Incident] = {}
        self._keys = itertools.count(1)

    # ------------------------------------------------------------ matching
    def _match(self, p: PersonCompliance, now: float, visible: set[int]) -> Incident | None:
        """The incident this confirmed worker belongs to, if any (same track, or same worker by place)."""
        inc = self._by_track.get(p.track_id)
        if inc is not None and self._joinable(inc, now):
            return inc
        cx, cy = (p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2
        h = max(1.0, p.box[3] - p.box[1])
        for inc in reversed(self._incidents):
            if not self._joinable(inc, now):
                continue
            if any(iou(p.box, b) >= self.dedup_iou or _contained(p.box, b) >= self.dedup_contain
                   for b in (inc.member_boxes or {0: inc.box}).values()):
                return inc  # the same worker(s) captured twice / as a group box
            others_visible = bool((inc.tracks - {p.track_id}) & visible)
            if others_visible or now - inc.last_seen > max(self.handoff_seconds, self.gap):
                continue  # its worker is still in view (two real people), or it's too old for a hand-off
            ox, oy = (inc.box[0] + inc.box[2]) / 2, (inc.box[1] + inc.box[3]) / 2
            if ((cx - ox) ** 2 + (cy - oy) ** 2) ** 0.5 < 0.75 * h:  # re-acquired under a new ID
                return inc
        return None

    def _joinable(self, inc: Incident, now: float) -> bool:
        """Still ongoing, or ended but within the cooldown of its start (a quick recurrence is the same event)."""
        return now - inc.last_seen <= self.gap or now - inc.start < self.cooldown

    # ------------------------------------------------------------ main
    def step(self, people: list[PersonCompliance], now: float,
             can_fire: Callable[[PersonCompliance], bool] | None = None,
             score: Callable[[PersonCompliance], tuple[float, Any] | None] | None = None) -> Step:
        """Feed one processed frame.

        `can_fire(p)` False = this frame is not good enough evidence: confirmation waits for a
        later frame (the streak keeps counting). `score(p)` rates this frame as evidence for `p`
        and returns (score, payload); the best payload of the confirmation window comes back in
        `Fire.best`."""
        out = Step()
        visible = {p.track_id for p in people}
        for p in people:
            tid = p.track_id
            self._track_seen[tid] = now
            if p.status != "non_compliant":
                self._reset_track(tid)
                continue
            n = self._streak.get(tid, 0) + 1
            self._streak[tid] = n
            self._streak_t0.setdefault(tid, now)
            if score is not None:
                s = score(p)
                if s is not None and (tid not in self._best or s[0] > self._best[tid][0]):
                    self._best[tid] = s
            if n < self.min_frames or now - self._streak_t0[tid] < self.min_seconds:
                continue  # not confirmed yet
            if can_fire is not None and not can_fire(p):
                continue
            inc = self._match(p, now, visible)
            if inc is not None:  # the same event: extend it, never a second record
                inc.tracks.add(tid)
                inc.member_boxes[tid] = p.box
                self._by_track[tid] = inc
                inc.missing |= set(p.missing)
                inc.box, inc.last_seen, inc.ended = p.box, now, False
                inc.observations += 1
                if inc not in out.extended:
                    out.extended.append(inc)
                continue
            inc = Incident(next(self._keys), {tid}, set(p.missing), p.box, now, now, member_boxes={tid: p.box})
            self._incidents.append(inc)
            self._by_track[tid] = inc
            best = self._best.pop(tid, (0.0, None))[1]
            out.fired.append(Fire(p, inc, best, self._streak_t0.get(tid, now)))
        # incidents end after `gap` s without the violation; forget them once they can't be joined any more
        keep: list[Incident] = []
        for inc in self._incidents:
            if not inc.ended and now - inc.last_seen > self.gap:
                inc.ended = True
                out.ended.append(inc)
            if self._joinable(inc, now) or not inc.ended:
                keep.append(inc)
            else:
                for t in inc.tracks:
                    if self._by_track.get(t) is inc:
                        del self._by_track[t]
        self._incidents = keep
        # tracks gone for longer than an incident gap: their half-counted streaks are void
        for tid in [t for t, ts in self._track_seen.items() if now - ts > max(self.gap, self.handoff_seconds)]:
            self._reset_track(tid)
            del self._track_seen[tid]
        return out

    def update(self, people: list[PersonCompliance], now: float,
               can_fire: Callable[[PersonCompliance], bool] | None = None) -> list[PersonCompliance]:
        """Workers whose violation was newly confirmed in this frame (one per incident)."""
        return [f.person for f in self.step(people, now, can_fire).fired]

    def _reset_track(self, tid: int) -> None:
        self._streak.pop(tid, None)
        self._streak_t0.pop(tid, None)
        self._best.pop(tid, None)

    def discard(self, inc: Incident) -> None:
        """Forget an incident whose violation could not be stored, so a later frame can try again."""
        if inc in self._incidents:
            self._incidents.remove(inc)
        for t in inc.tracks:
            if self._by_track.get(t) is inc:
                del self._by_track[t]

    def active(self) -> list[Incident]:
        return [i for i in self._incidents if not i.ended]

    def reset(self) -> None:
        self._streak.clear()
        self._streak_t0.clear()
        self._best.clear()
        self._track_seen.clear()
        self._incidents.clear()
        self._by_track.clear()
