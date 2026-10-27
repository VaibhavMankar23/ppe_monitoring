"""Camera zones: monitored area, ignore zones and restricted-area violations (app.ppe_logic)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import StreamConfig, ZoneConfig
from app.ppe_logic import (
    ComplianceSmoother, Detection, PersonCompliance, TrackedPerson, Zone, apply_zones, evaluate_frame, foot_point,
    mask_unmonitored, point_in_polygon,
)
from app.violations import AlertDebouncer

FRAME = (1000, 500)
LEFT = ((0.0, 0.0), (0.5, 0.0), (0.5, 1.0), (0.0, 1.0))  # left half of the frame
RIGHT = ((0.5, 0.0), (1.0, 0.0), (1.0, 1.0), (0.5, 1.0))


def person(tid: int, cx: float, missing: tuple[str, ...] = ("helmet",)) -> PersonCompliance:
    """A 60x200 px worker standing with their feet at x = cx, y = 400."""
    items = {"helmet": "present", "vest": "present"} | {m: "missing" for m in missing}
    return PersonCompliance(tid, (cx - 30, 200.0, cx + 30, 400.0), 0.9, "non_compliant" if missing else "compliant", items)  # type: ignore[arg-type]


def test_point_in_polygon_handles_concave_shapes():
    l_shape = [(0, 0), (1, 0), (1, 0.4), (0.4, 0.4), (0.4, 1), (0, 1)]
    assert point_in_polygon((0.2, 0.8), l_shape) and point_in_polygon((0.8, 0.2), l_shape)
    assert not point_in_polygon((0.8, 0.8), l_shape)  # the notch
    assert not point_in_polygon((1.2, 0.2), l_shape)


def test_foot_point_is_bottom_centre_and_clamped_to_the_frame():
    assert foot_point((100, 100, 300, 400), FRAME) == (0.2, 0.8)
    assert foot_point((100, 100, 300, 600), FRAME)[1] == 1.0  # box running past the bottom edge


def test_no_zones_changes_nothing():
    p = person(1, 250)
    apply_zones([p], [], FRAME)
    assert p.status == "non_compliant" and p.monitored and p.zone is None and "restricted_area" not in p.items


def test_monitor_zone_judges_only_workers_standing_inside():
    inside, outside = person(1, 250), person(2, 750)
    apply_zones([inside, outside], [Zone("Press line", "monitor", LEFT)], FRAME)
    assert inside.status == "non_compliant" and inside.zone == "Press line" and inside.monitored
    assert outside.status == "unknown" and not outside.monitored and outside.missing == []


def test_ignore_zone_wins_over_a_monitor_zone_it_overlaps():
    p = person(1, 250)
    apply_zones([p], [Zone("Floor", "monitor", LEFT), Zone("Walkway", "ignore", LEFT)], FRAME)
    assert p.status == "unknown" and not p.monitored and p.zone == "Walkway"


def test_the_feet_decide_not_the_head():
    # the box straddles the border: feet (bottom-centre) at x=0.52 -> right half
    p = PersonCompliance(1, (480.0, 100.0, 560.0, 400.0), 0.9, "non_compliant", {"helmet": "missing"})
    apply_zones([p], [Zone("Left", "monitor", LEFT)], FRAME)
    assert not p.monitored


def test_restricted_zone_is_a_violation_even_for_a_fully_equipped_worker():
    ok_inside, ok_outside = person(1, 750, missing=()), person(2, 250, missing=())
    apply_zones([ok_inside, ok_outside], [Zone("Coil yard", "restricted", RIGHT)], FRAME)
    assert ok_inside.status == "non_compliant" and ok_inside.missing == ["restricted_area"]
    assert ok_outside.status == "compliant" and ok_outside.items["restricted_area"] == "present"


def test_restricted_zone_outside_the_monitored_area_still_fires_but_ppe_is_not_judged():
    p = person(1, 750, missing=("helmet", "vest"))
    apply_zones([p], [Zone("Line", "monitor", LEFT), Zone("Yard", "restricted", RIGHT)], FRAME)
    assert p.missing == ["restricted_area"] and p.items["helmet"] == "unknown"


def test_leaving_the_monitored_area_stops_the_violation_immediately_despite_smoothing():
    zones = [Zone("Line", "monitor", LEFT)]
    sm = ComplianceSmoother(window=6)
    status = []
    for i in range(10):
        p = person(1, 250 if i < 6 else 750)  # 6 frames inside without a helmet, then walks out
        apply_zones([p], zones, FRAME)
        sm.apply([p])
        mask_unmonitored([p])
        status.append(p.status)
    assert status[:6] == ["non_compliant"] * 6
    assert status[6:] == ["unknown"] * 4  # not held "missing" by the 6-frame majority vote


def test_walkway_pedestrians_never_raise_a_violation_end_to_end():
    """Full per-frame chain as the pipeline runs it: evaluate -> zones -> smooth -> mask -> debounce."""
    zones = [Zone("Walkway", "ignore", RIGHT)]
    sm, deb = ComplianceSmoother(4), AlertDebouncer(min_frames=3, min_seconds=0.5, cooldown=30)
    fired = []
    for i in range(30):
        tracked = [TrackedPerson(1, (220, 200, 280, 400), 0.9), TrackedPerson(2, (720, 200, 780, 400), 0.9)]
        ppe = [Detection("vest", 0.8, (225, 240, 275, 330)), Detection("vest", 0.8, (725, 240, 775, 330))]  # no helmets
        people = evaluate_frame(tracked, ppe, ["helmet", "vest"], frame_size=FRAME)
        apply_zones(people, zones, FRAME)
        sm.apply(people)
        mask_unmonitored(people)
        fired += [p.track_id for p in deb.update(people, i * 0.2)]
    assert fired == [1]  # the worker on the floor; never the pedestrian on the walkway


# ------------------------------------------------------------------ config
def _stream(zones):
    return {"id": "c1", "name": "C1", "source": {"type": "file", "uri": "a.mp4"}, "zones": zones}


def test_zone_config_validation():
    ok = StreamConfig.model_validate(_stream([{"name": "A", "type": "restricted", "points": [[0, 0], [1, 0], [1, 1]]}]))
    assert ok.zones[0].points[2] == (1.0, 1.0)
    with pytest.raises(ValidationError):  # a polygon needs 3 points
        ZoneConfig(name="A", points=[(0, 0), (1, 1)])
    with pytest.raises(ValidationError):  # fractions of the frame, not pixels
        ZoneConfig(name="A", points=[(0, 0), (640, 0), (640, 480)])
    with pytest.raises(ValidationError):
        ZoneConfig(name="A", type="nope", points=[(0, 0), (1, 0), (1, 1)])  # type: ignore[arg-type]
    with pytest.raises(ValidationError):  # duplicate names within a camera
        StreamConfig.model_validate(_stream([{"name": "A", "points": [[0, 0], [1, 0], [1, 1]]},
                                             {"name": "a", "points": [[0, 0], [1, 0], [1, 1]]}]))
