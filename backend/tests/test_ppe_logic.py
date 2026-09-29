"""PPE association / compliance tests (person vs helmet/vest/... overlap cases)."""

from __future__ import annotations

import pytest

from app.ppe_logic import (
    ComplianceSmoother,
    Detection,
    TrackedPerson,
    associate,
    body_region,
    containment,
    evaluate_frame,
    evaluate_items,
    iou,
    overall_status,
)

# A standing person 100 px wide, 300 px tall. Head ~ y 100-175, torso ~ y 136-334, feet ~ y 310-400.
P = (100.0, 100.0, 200.0, 400.0)


def person(tid: int = 1, box=P, conf: float = 0.9) -> TrackedPerson:
    return TrackedPerson(tid, box, conf)


def det(cls: str, box, conf: float = 0.8) -> Detection:
    return Detection(cls, conf, box)


HELMET_ON_HEAD = det("helmet", (125, 90, 175, 130))
VEST_ON_TORSO = det("vest", (110, 170, 190, 300))


# ---------------------------------------------------------------- geometry
def test_iou_and_containment_basics():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == pytest.approx(1.0)
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert containment((2, 2, 4, 4), (0, 0, 10, 10)) == pytest.approx(1.0)
    assert containment((5, 5, 15, 15), (0, 0, 10, 10)) == pytest.approx(0.25)
    assert containment((0, 0, 0, 0), (0, 0, 10, 10)) == 0.0


def test_head_region_extends_above_person_box():
    x1, y1, x2, y2 = body_region(P, "helmet")
    assert y1 < P[1] and y2 < P[1] + 0.5 * (P[3] - P[1])
    assert x1 < P[0] and x2 > P[2]


# ---------------------------------------------------------------- association
def test_helmet_on_head_is_present():
    items = evaluate_items(P, [HELMET_ON_HEAD], ["helmet"])
    assert items == {"helmet": "present"}


def test_helmet_sticking_out_above_person_box_is_still_associated():
    helmet = det("helmet", (130, 70, 170, 110))  # mostly above the person box top
    (assigned,) = associate([person()], [helmet])
    assert assigned == [helmet]


def test_helmet_held_in_hand_or_on_ground_does_not_count():
    helmet_at_waist = det("helmet", (150, 260, 190, 300))
    helmet_on_ground = det("helmet", (120, 370, 160, 400))
    res = evaluate_frame([person()], [helmet_at_waist, helmet_on_ground], ["helmet"])
    assert res[0].items["helmet"] == "missing"
    assert res[0].status == "non_compliant"


def test_vest_on_torso_is_present_but_not_on_head():
    assert evaluate_frame([person()], [VEST_ON_TORSO], ["vest"])[0].items["vest"] == "present"
    vest_near_head = det("vest", (110, 60, 190, 120))
    assert evaluate_frame([person()], [vest_near_head], ["vest"])[0].items["vest"] == "missing"


def test_ppe_goes_to_the_right_person_when_boxes_overlap():
    a = person(1, (100, 100, 200, 400))
    b = person(2, (160, 110, 260, 410))  # overlaps A horizontally
    helmet_b = det("helmet", (185, 100, 235, 140))  # centred on B's head
    assigned = associate([a, b], [helmet_b])
    assert assigned[0] == [] and assigned[1] == [helmet_b]
    res = evaluate_frame([a, b], [helmet_b], ["helmet"])
    assert [r.status for r in res] == ["non_compliant", "compliant"]


def test_each_detection_is_assigned_to_at_most_one_person():
    a = person(1, (100, 100, 200, 400))
    b = person(2, (105, 100, 205, 400))  # near-duplicate person box
    helmet = det("helmet", (125, 90, 175, 130))
    assigned = associate([a, b], [helmet])
    assert sum(len(x) for x in assigned) == 1


def test_far_away_ppe_is_unassigned():
    stray = det("vest", (600, 600, 700, 700))
    assert associate([person()], [stray]) == [[]]


def test_small_ppe_box_partially_outside_region_below_threshold():
    # Helmet whose box is mostly at chest height -> containment in head region < threshold.
    helmet = det("helmet", (130, 170, 170, 250))
    assert associate([person()], [helmet], min_containment=0.35) == [[]]


def test_boots_at_feet_gloves_at_side():
    boots = det("boots", (110, 360, 190, 405))
    glove = det("gloves", (80, 250, 110, 290))  # hand hanging slightly outside the person box
    (res,) = evaluate_frame([person()], [boots, glove], ["boots", "gloves"])
    assert res.items == {"boots": "present", "gloves": "present"}


# ---------------------------------------------------------------- negatives / policy
def test_negative_class_marks_missing_even_in_negative_only_policy():
    no_helmet = det("no_helmet", (125, 95, 175, 140))
    items = evaluate_items(P, [no_helmet], ["helmet"], missing_policy="negative_only")
    assert items["helmet"] == "missing"


def test_negative_only_policy_without_evidence_is_unknown():
    items = evaluate_items(P, [], ["helmet", "vest"], missing_policy="negative_only")
    assert items == {"helmet": "unknown", "vest": "unknown"}
    assert overall_status(items) == "unknown"


def test_conflicting_positive_and_negative_higher_confidence_wins():
    pos = det("helmet", (125, 90, 175, 130), conf=0.4)
    neg = det("no_helmet", (125, 90, 175, 130), conf=0.7)
    assert evaluate_items(P, [pos, neg], ["helmet"])["helmet"] == "missing"
    pos_hi = det("helmet", (125, 90, 175, 130), conf=0.9)
    assert evaluate_items(P, [pos_hi, neg], ["helmet"])["helmet"] == "present"


def test_person_cut_off_at_frame_bottom_boots_unknown_not_missing():
    cut = (100.0, 300.0, 200.0, 480.0)  # frame is 640x480, person box ends at the bottom edge
    items = evaluate_items(cut, [], ["boots", "helmet"], frame_size=(640, 480))
    assert items == {"boots": "unknown", "helmet": "missing"}
    # same person fully inside a taller frame -> boots are visible and missing
    assert evaluate_items(cut, [], ["boots"], frame_size=(640, 720))["boots"] == "missing"


def test_person_cut_off_at_frame_top_head_items_unknown():
    cut = (100.0, 0.0, 200.0, 250.0)
    items = evaluate_items(cut, [], ["helmet", "vest"], frame_size=(640, 480))
    assert items == {"helmet": "unknown", "vest": "missing"}


def test_too_small_person_is_not_judged():
    tiny = person(1, (10, 10, 20, 40))
    res = evaluate_frame([tiny], [], ["helmet"], min_person_height=60)
    assert res[0].status == "unknown"


def test_only_required_items_are_evaluated():
    res = evaluate_frame([person()], [HELMET_ON_HEAD], ["helmet"])
    assert res[0].status == "compliant"
    assert set(res[0].items) == {"helmet"}
    res2 = evaluate_frame([person()], [HELMET_ON_HEAD], ["helmet", "vest", "gloves"])
    assert res2[0].missing == ["vest", "gloves"]


def test_full_compliance_multiple_people():
    a, b = person(1, (100, 100, 200, 400)), person(2, (400, 100, 500, 400))
    ppe = [
        HELMET_ON_HEAD, VEST_ON_TORSO,
        det("helmet", (425, 90, 475, 130)),  # b has a helmet but no vest
    ]
    res = evaluate_frame([a, b], ppe, ["helmet", "vest"])
    assert res[0].status == "compliant"
    assert res[1].status == "non_compliant" and res[1].missing == ["vest"]


# ---------------------------------------------------------------- smoothing
def test_smoother_suppresses_single_frame_flicker():
    s = ComplianceSmoother(window=5)
    for _ in range(4):
        s.update(1, {"helmet": "present"})
    assert s.update(1, {"helmet": "missing"}) == {"helmet": "present"}


def test_smoother_switches_after_majority():
    s = ComplianceSmoother(window=4)
    s.update(1, {"helmet": "present"})
    for _ in range(3):
        out = s.update(1, {"helmet": "missing"})
    assert out == {"helmet": "missing"}


def test_smoother_prunes_dead_tracks():
    s = ComplianceSmoother(window=3)
    s.update(1, {"helmet": "missing"})
    s.prune(alive=set())
    assert s.update(1, {"helmet": "present"}) == {"helmet": "present"}


# ---------------------------------------------------------------- person-crop refinement
from app.ppe_logic import crop_region, dedupe, merge_refined  # noqa: E402


def test_crop_region_pads_and_clips_to_frame():
    x1, y1, x2, y2 = crop_region((10, 5, 110, 305), 1920, 1080)
    assert x1 == 0 and y1 == 0  # clipped at the left/top edge
    assert x2 == 135 and y2 == 320  # 25 % side padding, 5 % below
    assert crop_region((1800, 900, 1900, 1080), 1920, 1080)[2:] == (1920, 1080)


def test_dedupe_keeps_best_per_class_only():
    a = det("helmet", (0, 0, 10, 10), 0.9)
    b = det("helmet", (1, 1, 11, 11), 0.6)  # duplicate of a
    c = det("no_helmet", (0, 0, 10, 10), 0.5)  # different class, same place -> kept
    assert dedupe([b, a, c]) == [a, c]


def test_merge_refined_crop_pass_replaces_first_pass_for_refined_person():
    refined_person = (100, 100, 200, 400)
    first = [
        det("no_helmet", (130, 95, 170, 130), 0.4),  # low-res guess on the refined person
        det("vest", (510, 200, 590, 300), 0.8),      # belongs to someone not refined -> kept
    ]
    crop = [det("helmet", (128, 92, 172, 128), 0.85), det("helmet", (129, 93, 171, 129), 0.7)]
    out = merge_refined(first, [refined_person], crop)
    assert sorted(d.cls for d in out) == ["helmet", "vest"]
    res = evaluate_frame([person()], out, ["helmet"])
    assert res[0].status == "compliant"


def test_undetectable_required_item_is_not_flagged_missing():
    # the model has no class for gloves/boots -> they must not be counted "missing" for everyone
    items = evaluate_items(P, [HELMET_ON_HEAD], ["helmet", "gloves", "boots"], detectable={"helmet", "vest"})
    assert items["helmet"] == "present"
    assert "gloves" not in items and "boots" not in items  # uncheckable -> skipped, never a violation


def test_worker_compliant_when_all_detectable_ppe_present():
    # helmet + vest present; gloves is required but undetectable -> the worker is still compliant
    (res,) = evaluate_frame([person()], [HELMET_ON_HEAD, VEST_ON_TORSO], ["helmet", "vest", "gloves"],
                            detectable={"helmet", "vest"})
    assert res.status == "compliant"


def test_all_required_items_undetectable_is_unknown_not_compliant():
    # a camera whose every required item is undetectable can't be judged -> unknown, not a false pass
    (res,) = evaluate_frame([person()], [], ["gloves", "boots"], detectable={"helmet"})
    assert res.status == "unknown"
