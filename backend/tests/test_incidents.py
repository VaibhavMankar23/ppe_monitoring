"""Temporal confirmation, one violation per incident, track-ID changes and best-frame evidence
(app.violations.AlertDebouncer)."""

from __future__ import annotations

from app.ppe_logic import PersonCompliance
from app.violations import AlertDebouncer

HERE = (100.0, 100.0, 160.0, 280.0)
THERE = (600.0, 100.0, 660.0, 280.0)


def worker(tid: int, missing: list[str], box=HERE, conf: float = 0.9) -> PersonCompliance:
    items = {"helmet": "present", "vest": "present"} | {m: "missing" for m in missing}
    return PersonCompliance(tid, box, conf, "non_compliant" if missing else "compliant", items)  # type: ignore[arg-type]


def run(d: AlertDebouncer, frames):
    """frames: [(t, [people])] -> list of (t, fired track ids)."""
    out = []
    for t, people in frames:
        fired = d.update(people, t)
        if fired:
            out.append((t, [p.track_id for p in fired]))
    return out


# ------------------------------------------------------------------ temporal confirmation
def test_single_frame_false_detection_never_becomes_a_violation():
    d = AlertDebouncer(min_frames=3, min_seconds=1.0, cooldown=30)
    frames = [(i * 0.25, [worker(1, ["helmet"] if i == 4 else [])]) for i in range(40)]
    assert run(d, frames) == []


def test_continuous_violation_is_confirmed_once_after_frames_and_duration():
    d = AlertDebouncer(min_frames=3, min_seconds=1.0, cooldown=30)
    fired = run(d, [(i * 0.25, [worker(1, ["helmet"])]) for i in range(40)])
    # 3 frames are reached at t=0.5, but it must also have lasted 1 s: confirmed at t=1.0, exactly once
    assert fired == [(1.0, [1])]


def test_frame_count_alone_is_not_enough_and_duration_alone_is_not_enough():
    frames_fast = [(i * 0.01, [worker(1, ["helmet"])]) for i in range(6)]  # 6 frames in 0.05 s
    assert run(AlertDebouncer(min_frames=3, min_seconds=1.0), frames_fast) == []
    frames_slow = [(0.0, [worker(1, ["helmet"])]), (5.0, [worker(1, ["helmet"])])]  # long, but 2 frames
    assert run(AlertDebouncer(min_frames=3, min_seconds=1.0), frames_slow) == []


def test_violation_appearing_and_disappearing_resets_confirmation():
    d = AlertDebouncer(min_frames=3, min_seconds=1.0, cooldown=30)
    frames = []
    t = 0.0
    for _ in range(10):  # 0.75 s non-compliant, then compliant again: never 1 s in a row
        for _ in range(3):
            frames.append((t, [worker(1, ["helmet"])]))
            t += 0.25
        frames.append((t, [worker(1, [])]))
        t += 0.25
    assert run(d, frames) == []
    # once it stays, it is confirmed after the full window again (counted from the restart)
    rest = [(t + i * 0.25, [worker(1, ["helmet"])]) for i in range(8)]
    assert run(d, rest) == [(t + 1.0, [1])]


def test_multiple_people_in_the_same_frame_are_confirmed_independently():
    d = AlertDebouncer(min_frames=3, min_seconds=1.0, cooldown=30)
    frames = []
    for i in range(12):
        t = i * 0.25
        steady = worker(1, ["helmet"], HERE)
        flicker = worker(2, ["vest"] if i % 2 else [], THERE)  # never two frames in a row
        frames.append((t, [steady, flicker]))
    assert run(d, frames) == [(1.0, [1])]
    d2 = AlertDebouncer(min_frames=3, min_seconds=1.0, cooldown=30)
    both = [(i * 0.25, [worker(1, ["helmet"], HERE), worker(2, ["vest"], THERE)]) for i in range(8)]
    assert run(d2, both) == [(1.0, [1, 2])]


# ------------------------------------------------------------------ one violation per incident
def test_repeated_detections_extend_one_incident_instead_of_duplicating():
    d = AlertDebouncer(min_frames=2, min_seconds=0, cooldown=30, gap=10)
    fired, extended = [], 0
    for i in range(300):  # a worker without a helmet for 5 minutes at 1 fps
        step = d.step([worker(1, ["helmet"])], float(i))
        fired += step.fired
        extended += len(step.extended)
    assert len(fired) == 1
    inc = fired[0].incident
    assert extended == 298 and inc.observations == 299 and inc.last_seen == 299.0 and not inc.ended


def test_new_violation_only_after_the_incident_ended_and_the_cooldown_passed():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30, gap=5)
    assert len(d.update([worker(1, ["helmet"])], 0.0)) == 1
    for t in range(1, 10):
        d.update([worker(1, [])], float(t))  # helmet on: the incident ends after 5 s
    # recurring within the cooldown (t < 30 after the start) is still that same event
    step = d.step([worker(1, ["helmet"])], 12.0)
    assert step.fired == [] and step.extended and step.extended[0].observations == 2
    for t in range(13, 40):
        d.update([worker(1, [])], float(t))
    # ended, and more than the cooldown since it began: a genuinely new violation
    assert len(d.update([worker(1, ["helmet"])], 40.0)) == 1


def test_incident_end_is_reported_once():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30, gap=3)
    inc = d.step([worker(1, ["helmet"])], 0.0).fired[0].incident
    ends = [s for s in (d.step([], float(t)) for t in range(1, 10)) if s.ended]
    assert len(ends) == 1 and ends[0].ended == [inc] and inc.ended


def test_tracking_id_change_joins_the_same_incident():
    d = AlertDebouncer(min_frames=2, min_seconds=0, cooldown=30, handoff_seconds=4, gap=10)
    assert run(d, [(0.0, [worker(1, ["helmet"])]), (0.5, [worker(1, ["helmet"])])]) == [(0.5, [1])]
    # occlusion: the tracker loses #1 and re-acquires the worker as #7 a few px away; even once #7 is
    # confirmed on its own, it's the same violation
    near = (104.0, 101.0, 164.0, 281.0)
    steps = [d.step([worker(7, ["helmet"], near)], t) for t in (2.0, 2.5, 3.0)]
    assert all(s.fired == [] for s in steps)
    inc = steps[-1].extended[0]
    assert inc.tracks == {1, 7} and inc.observations == 3


def test_several_id_switches_in_a_row_still_one_violation():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30, handoff_seconds=4, gap=10)
    fired = 0
    for k in range(20):  # unstable tracking: a fresh ID every 2 s at the same spot for 40 s
        fired += len(d.update([worker(100 + k, ["helmet"], (100.0 + k, 100.0, 160.0 + k, 280.0))], k * 2.0))
    assert fired == 1


def test_id_change_elsewhere_or_long_after_is_a_new_violation():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30, handoff_seconds=4, gap=5)
    assert len(d.update([worker(1, ["helmet"])], 0.0)) == 1
    assert len(d.update([worker(2, ["helmet"], THERE)], 1.0)) == 1  # a different worker elsewhere
    # same spot, but the first worker's incident ended long ago and the cooldown passed
    assert len(d.update([worker(3, ["helmet"])], 60.0)) == 1


def test_recurrence_at_the_same_spot_under_a_new_id_within_the_cooldown_is_the_same_violation():
    # low detection rate: the worker is lost between checks and comes back under a fresh ID each time
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=120, handoff_seconds=4, gap=10)
    assert len(d.update([worker(1, ["helmet"])], 0.0)) == 1
    near = (130.0, 100.0, 190.0, 280.0)  # same spot, but not overlapping enough to count as one box (IoU 0.33)
    for k, t in enumerate((25.0, 50.0, 80.0, 110.0)):  # long after the hand-off window, within the cooldown
        step = d.step([worker(10 + k, ["helmet"], near)], t)
        assert step.fired == [] and step.extended and step.extended[0].tracks >= {1, 10 + k}
    # once the cooldown since the start has passed, the spot raises a new violation again
    assert len(d.update([worker(20, ["helmet"], near)], 130.0)) == 1


def test_recurrence_at_the_same_spot_with_different_ppe_is_a_new_violation():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=120, handoff_seconds=4, gap=10)
    assert len(d.update([worker(1, ["helmet"])], 0.0)) == 1
    near = (130.0, 100.0, 190.0, 280.0)
    assert len(d.update([worker(2, ["vest"], near)], 40.0)) == 1  # nothing in common with the earlier incident


def test_two_real_people_side_by_side_are_two_violations():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30)
    a, b = (100.0, 100.0, 160.0, 280.0), (130.0, 100.0, 190.0, 280.0)  # IoU 0.33: not a double capture
    assert len(d.update([worker(1, ["helmet"], a), worker(2, ["helmet"], b)], 0.0)) == 2


def test_discarded_incident_can_be_recorded_again():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30)
    f = d.step([worker(1, ["helmet"])], 0.0).fired[0]
    d.discard(f.incident)  # e.g. the database write failed
    assert len(d.update([worker(1, ["helmet"])], 0.5)) == 1


# ------------------------------------------------------------------ best evidence frame
def test_best_frame_of_the_confirmation_window_is_used():
    d = AlertDebouncer(min_frames=4, min_seconds=0, cooldown=30)
    scores = [0.3, 0.9, 0.5, 0.4]  # the second frame is the clearest
    fired = []
    for i, sc in enumerate(scores):
        fired += d.step([worker(1, ["helmet"])], i * 0.25, score=lambda p, sc=sc, i=i: (sc, f"frame{i}")).fired
    assert len(fired) == 1 and fired[0].best == "frame1" and fired[0].since == 0.0


def test_best_frame_restarts_with_the_confirmation_window():
    d = AlertDebouncer(min_frames=2, min_seconds=0, cooldown=30)
    d.step([worker(1, ["helmet"])], 0.0, score=lambda p: (0.99, "stale"))
    d.step([worker(1, [])], 0.25)  # compliant: window (and its best frame) reset
    fired = []
    for i, sc in enumerate([0.2, 0.4]):
        fired += d.step([worker(1, ["helmet"])], 0.5 + i * 0.25, score=lambda p, sc=sc, i=i: (sc, f"f{i}")).fired
    assert fired[0].best == "f1"


def test_evidence_waits_for_a_confident_frame_but_keeps_counting():
    d = AlertDebouncer(min_frames=2, min_seconds=0, cooldown=30)
    ok = lambda p: p.conf >= 0.5  # noqa: E731
    assert d.update([worker(1, ["helmet"], conf=0.2)], 0.0, ok) == []
    assert d.update([worker(1, ["helmet"], conf=0.2)], 0.25, ok) == []
    assert len(d.update([worker(1, ["helmet"], conf=0.8)], 0.5, ok)) == 1


def test_group_box_and_single_boxes_of_the_same_workers_are_one_violation():
    """Real footage: two men standing together are detected alternately as one box around both and as
    one box each, and every variant gets a new track ID. That's the same people, not new violations."""
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30, gap=10)
    pair, left, right = (100.0, 100.0, 220.0, 280.0), (100.0, 102.0, 158.0, 280.0), (162.0, 100.0, 220.0, 280.0)
    fired = 0
    for k in range(60):  # 60 s at 1 fps, the detections flip every few seconds
        boxes = [pair] if (k // 3) % 2 == 0 else [left, right]
        fired += len(d.update([worker(10 * k + i, ["helmet"], b) for i, b in enumerate(boxes)], float(k)))
    assert fired == 1  # the single boxes lie inside the group box: one event, never one per track ID


def test_a_worker_walking_past_behind_is_not_merged_when_boxes_only_touch():
    d = AlertDebouncer(min_frames=1, min_seconds=0, cooldown=30)
    a, b = (100.0, 100.0, 160.0, 280.0), (140.0, 100.0, 200.0, 280.0)  # a third of either box overlaps
    assert len(d.update([worker(1, ["helmet"], a), worker(2, ["helmet"], b)], 0.0)) == 2
