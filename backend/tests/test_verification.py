"""Accuracy rules from the Oct 2026 review: claims re-checked on the sharp evidence pass, items judged
only on workers large enough to show them, and disproved items never re-added during the event."""

from __future__ import annotations

from app.ppe_logic import Detection, disproved_items, evaluate_items
from app.ppe_logic import PersonCompliance
from app.violations import AlertDebouncer

ME = (100.0, 100.0, 200.0, 400.0)  # a worker 300 px tall
NEIGHBOUR = (205.0, 100.0, 305.0, 400.0)
HEAD = (125.0, 70.0, 175.0, 120.0)  # helmet on ME's head
NEIGHBOUR_HEAD = (230.0, 70.0, 280.0, 120.0)


def test_a_clear_helmet_on_the_sharp_pass_disproves_no_helmet():
    ppe = [Detection("helmet", 0.82, HEAD), Detection("no_helmet", 0.10, HEAD)]
    assert disproved_items(ME, [NEIGHBOUR], ppe, ["helmet", "vest"], 0.35) == {"helmet"}


def test_a_neighbours_helmet_does_not_clear_this_worker():
    ppe = [Detection("helmet", 0.9, NEIGHBOUR_HEAD)]
    assert disproved_items(ME, [NEIGHBOUR], ppe, ["helmet"], 0.35) == set()


def test_weak_or_outvoted_positives_do_not_clear():
    assert disproved_items(ME, [], [Detection("helmet", 0.30, HEAD)], ["helmet"], 0.35) == set()  # below threshold
    assert disproved_items(ME, [], [Detection("helmet", 0.5, HEAD), Detection("no_helmet", 0.7, HEAD)], ["helmet"], 0.35) == set()


def test_behaviours_and_zones_are_never_disproved_by_ppe():
    assert disproved_items(ME, [], [Detection("helmet", 0.9, HEAD)], ["phone_use", "restricted_area"], 0.35) == set()


def test_face_items_are_unknown_on_small_workers_not_missing():
    small = (100.0, 100.0, 130.0, 170.0)  # 70 px tall
    gate = {"mask": 90}
    items = evaluate_items(small, [], ["helmet", "mask"], "strict", None, None, gate)
    assert items == {"helmet": "missing", "mask": "unknown"}
    items = evaluate_items(small, [Detection("no_mask", 0.8, (105, 110, 125, 125))], ["mask"], "strict", None, None, gate)
    assert items == {"mask": "unknown"}  # a "no mask" guess on a few pixels of face is not trusted either
    big = (100.0, 100.0, 160.0, 300.0)
    assert evaluate_items(big, [], ["mask"], "strict", None, None, gate) == {"mask": "missing"}


def test_cleared_items_are_not_re_added_later_in_the_event():
    deb = AlertDebouncer(min_frames=1)
    p = PersonCompliance(1, ME, 0.9, "non_compliant", {"vest": "missing"}, [])
    inc = deb.step([p], 0.0).fired[0].incident
    inc.cleared.add("helmet")  # the evidence pass showed a helmet
    q = PersonCompliance(1, ME, 0.9, "non_compliant", {"helmet": "missing", "vest": "missing"}, [])
    deb.step([q], 1.0)
    assert inc.missing == {"vest"}
