"""PresenceCounter: compliance counts people, not tracking IDs."""

from __future__ import annotations

from app.violations import PresenceCounter

H = 200.0  # person height in px


def box(x, y=100.0, h=H):
    return (x, y, x + h * 0.4, y + h)


def test_new_id_where_a_worker_was_just_lost_is_the_same_person():
    pc = PresenceCounter()
    assert pc.step([(1, box(100), True)], 0.0) == 1
    assert pc.step([], 1.0) == 0  # out of view
    assert pc.step([(2, box(160), True)], 2.0) == 0  # new ID 0.3 heights away, 2 s later
    assert pc.person(1) == pc.person(2)


def test_two_people_in_view_together_are_two_people_even_when_close():
    pc = PresenceCounter()
    assert pc.step([(1, box(100), True), (2, box(190), True)], 0.0) == 2


def test_a_second_box_on_a_visible_worker_is_not_another_person():
    pc = PresenceCounter()
    pc.step([(1, box(100), True)], 0.0)
    assert pc.step([(1, box(100), True), (7, box(104), True)], 0.5) == 0  # overlaps the visible worker


def test_someone_appearing_far_away_is_a_new_person():
    pc = PresenceCounter()
    pc.step([(1, box(100), True)], 0.0)
    pc.step([], 1.0)
    assert pc.step([(2, box(900), True)], 1.5) == 1  # ~4 heights away


def test_the_matching_radius_grows_with_time_lost():
    pc = PresenceCounter()
    pc.step([(1, box(100), True)], 0.0)
    pc.step([], 0.1)
    assert pc.step([(2, box(100 + 1.2 * H), True)], 0.2) == 1  # 1.2 heights after 0.2 s: a different person
    pc2 = PresenceCounter()
    pc2.step([(1, box(100), True)], 0.0)
    pc2.step([], 0.5)
    assert pc2.step([(2, box(100 + 1.2 * H), True)], 1.5) == 0  # after 1.5 s a walker covers that


def test_after_the_window_the_same_spot_is_a_new_person():
    pc = PresenceCounter(window=6.0)
    pc.step([(1, box(100), True)], 0.0)
    pc.step([], 3.0)
    pc.step([], 7.0)  # forgotten
    assert pc.step([(2, box(100), True)], 8.0) == 1


def test_counted_once_judged_not_while_too_small():
    pc = PresenceCounter()
    assert pc.step([(1, box(100), False)], 0.0) == 0  # too far away to judge yet
    assert pc.step([(1, box(100), True)], 1.0) == 1
    assert pc.step([(1, box(100), True)], 2.0) == 0
