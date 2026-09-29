from __future__ import annotations

from app.ppe_logic import Detection, PersonCompliance
from app.tracker import ByteTracker
from app.violations import AlertDebouncer


def pdet(x: float, y: float = 100, conf: float = 0.9) -> Detection:
    return Detection("person", conf, (x, y, x + 60, y + 180))


def test_tracker_keeps_ids_for_moving_people():
    tr = ByteTracker(min_hits=1)
    ids = None
    for i in range(10):
        out = tr.update([pdet(100 + 8 * i), pdet(400 - 8 * i)], now=i * 0.1)
        cur = sorted((round(t.box[0]), t.track_id) for t in out)
        if ids is None:
            ids = [tid for _, tid in cur]
        # left-most person keeps the first id while they approach each other
        assert [tid for _, tid in cur] == ids


def test_tracker_recovers_low_confidence_detection_second_stage():
    tr = ByteTracker(high_thresh=0.5, low_thresh=0.1, min_hits=1)
    tr.update([pdet(100)], now=0.0)
    out = tr.update([pdet(104, conf=0.2)], now=0.1)  # occluded -> low confidence
    assert [t.track_id for t in out] == [1]


def test_tracker_low_conf_alone_does_not_create_tracks():
    tr = ByteTracker(high_thresh=0.5, low_thresh=0.1, min_hits=1)
    assert tr.update([pdet(100, conf=0.3)], now=0.0) == []


def test_tracker_reidentifies_after_short_gap_and_drops_after_long():
    tr = ByteTracker(max_lost_seconds=1.0, min_hits=1)
    tr.update([pdet(100)], now=0.0)
    tr.update([], now=0.5)
    assert [t.track_id for t in tr.update([pdet(102)], now=0.8)] == [1]
    tr.update([], now=1.0)
    assert [t.track_id for t in tr.update([pdet(102)], now=3.0)] == [2]


def test_tracker_min_hits_confirms_on_second_frame():
    tr = ByteTracker(min_hits=2)
    tr.update([pdet(100)], now=0.0)  # first frame is auto-confirmed
    assert len(tr.update([pdet(100), pdet(500)], now=0.1)) == 1  # new person unconfirmed
    assert len(tr.update([pdet(100), pdet(500)], now=0.2)) == 2


def pc(tid: int, missing: list[str]) -> PersonCompliance:
    items = {"helmet": "present", "vest": "present"} | {m: "missing" for m in missing}
    return PersonCompliance(tid, (0, 0, 10, 10), 0.9, "non_compliant" if missing else "compliant", items)  # type: ignore[arg-type]


def test_debouncer_requires_consecutive_frames():
    d = AlertDebouncer(min_frames=3, cooldown=30)
    assert d.update([pc(1, ["helmet"])], 0.0) == []
    assert d.update([pc(1, ["helmet"])], 0.1) == []
    assert len(d.update([pc(1, ["helmet"])], 0.2)) == 1


def test_debouncer_streak_resets_when_compliant():
    d = AlertDebouncer(min_frames=2, cooldown=30)
    d.update([pc(1, ["helmet"])], 0.0)
    d.update([pc(1, [])], 0.1)
    assert d.update([pc(1, ["helmet"])], 0.2) == []


def test_debouncer_dedupes_same_worker_within_cooldown():
    d = AlertDebouncer(min_frames=1, cooldown=30)
    assert len(d.update([pc(1, ["helmet", "vest"])], 0.0)) == 1
    for t in range(1, 20):
        assert d.update([pc(1, ["helmet", "vest"])], float(t)) == []
    # subset (vest put on) does not re-alert
    assert d.update([pc(1, ["helmet"])], 21.0) == []
    # a newly missing item joins the same violation event instead of raising a second one
    step = d.step([pc(1, ["helmet", "gloves"])], 22.0)
    assert step.fired == [] and step.extended[0].missing == {"helmet", "vest", "gloves"}
    # still continuously non-compliant after the cooldown: the same event goes on (no duplicate)
    for t in range(23, 40):
        assert d.update([pc(1, ["helmet", "vest"])], float(t)) == []


def test_debouncer_independent_per_worker():
    d = AlertDebouncer(min_frames=1, cooldown=30)
    # two different workers standing apart both alert
    out = d.update([pcb(1, ["helmet"], (0, 0, 60, 180)), pcb(2, ["helmet"], (400, 0, 460, 180))], 0.0)
    assert len(out) == 2


def pcb(tid: int, missing: list[str], box) -> PersonCompliance:
    p = pc(tid, missing)
    p.box = box
    return p


def test_debouncer_id_switch_at_same_spot_inherits_alert():
    d = AlertDebouncer(min_frames=1, cooldown=30, handoff_seconds=4)
    assert len(d.update([pcb(1, ["helmet"], (100, 100, 160, 280))], 0.0)) == 1
    # worker occluded, tracker re-acquires them as #2 a few px away -> no duplicate alert
    assert d.update([pcb(2, ["helmet"], (110, 102, 170, 282))], 2.0) == []
    # a newly missing item on the re-acquired worker is added to the same violation event
    step = d.step([pcb(2, ["helmet", "vest"], (112, 102, 172, 282))], 2.5)
    assert step.fired == [] and step.extended[0].missing == {"helmet", "vest"} and step.extended[0].tracks == {1, 2}


def test_debouncer_alerts_elsewhere_and_after_cooldown():
    d = AlertDebouncer(min_frames=1, cooldown=30, handoff_seconds=4)
    assert len(d.update([pcb(1, ["helmet"], (100, 100, 160, 280))], 0.0)) == 1
    # a different place alerts independently
    assert len(d.update([pcb(2, ["helmet"], (600, 100, 660, 280))], 1.0)) == 1
    # churned/new track id at the SAME spot within the cooldown is a duplicate, not a fresh alert
    assert d.update([pcb(3, ["helmet"], (100, 100, 160, 280))], 9.0) == []
    # once the cooldown has passed, the spot can raise a new violation again
    assert len(d.update([pcb(4, ["helmet"], (100, 100, 160, 280))], 40.0)) == 1


def test_debouncer_no_handoff_while_old_track_still_visible():
    d = AlertDebouncer(min_frames=1, cooldown=30)
    d.update([pcb(1, ["helmet"], (100, 100, 160, 280))], 0.0)
    out = d.update([pcb(1, ["helmet"], (100, 100, 160, 280)), pcb(2, ["helmet"], (120, 100, 180, 280))], 0.5)
    assert [p.track_id for p in out] == [2]  # two real people standing together


def test_debouncer_dedupes_double_captured_worker():
    # the detector captures one worker as two heavily-overlapping boxes (two track ids):
    # only one violation should fire, not two.
    d = AlertDebouncer(min_frames=1, cooldown=30)
    a, b = (100, 100, 160, 280), (104, 102, 164, 282)  # ~0.86 IoU -> the same physical worker
    assert len(d.update([pcb(1, ["helmet"], a), pcb(2, ["helmet"], b)], 0.0)) == 1
    # and neither ghost track re-alerts while both persist through the cooldown
    assert d.update([pcb(1, ["helmet"], a), pcb(2, ["helmet"], b)], 1.0) == []
