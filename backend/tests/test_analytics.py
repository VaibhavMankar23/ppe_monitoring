"""Analytics SQL aggregations: totals, PPE breakdown (json_each), per camera, time buckets in the
viewer's time zone, heatmap cells, session-aware repeat offenders, compliance rate, migration."""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.analytics import Analytics, Scope
from app.api import create_app
from app.config import load_config
from app.pipeline import Monitor
from app.violations_db import ViolationFilter, ViolationStore
from helpers import FakeDetector, auth_settings, bearer, bootstrap_super_admin, raw_config, write_config

IST = 330  # minutes east of UTC
DAY, H, M = 86400, 3600, 60
# a Monday 00:00 in IST: day number D with (D + 3) % 7 == 0 (1970-01-01 was a Thursday)
_D = 20720
while (_D + 3) % 7:
    _D += 1
T0 = _D * DAY - IST * 60  # epoch seconds of Monday 00:00 IST


def at(day: int, hh: int, mm: int = 0) -> float:
    return T0 + day * DAY + hh * H + mm * M


@pytest.fixture()
def store():
    s = ViolationStore(":memory:")
    rows = [  # (camera, run, track, missing, time)
        ("cam1", "A", 1, ["helmet", "vest"], at(0, 9, 15)),
        ("cam1", "A", 1, ["helmet"], at(0, 9, 40)),
        ("cam2", "B", 1, ["vest"], at(0, 14, 5)),
        ("cam1", None, 1, ["helmet"], at(1, 9, 30)),  # legacy row recorded before sessions existed
        ("cam1", "C", 1, ["helmet"], at(2, 9, 10)),  # same track number, different camera session
        ("cam2", "B", 5, ["gloves"], at(2, 23, 59)),
        ("cam1", "A", 2, ["helmet"], at(-2, 12)),  # previous period
    ]
    for cam, run, tid, missing, ts in rows:
        s.add(cam, cam.upper(), tid, missing, b"i", b"t", ts=ts, run_id=run)
    s.add_observations("cam1", at(0, 9), seen=10, violating=1)
    s.add_observations("cam1", at(0, 9, 5), seen=0, violating=1)  # same 15-min bucket: upserted
    s.add_observations("cam2", at(0, 14), seen=5, violating=1)
    s.add_observations("cam1", at(2, 9), seen=4, violating=1)
    yield s
    s.close()


@pytest.fixture()
def an(store):
    return Analytics(store)


SC = Scope(start=at(0, 0), end=at(3, 0), tz=IST)
NAMES = {"cam1": "Gate", "cam2": "Dock", "cam3": "Yard"}


def test_summary(an):
    s = an.summary(SC, NAMES)
    assert s["total_violations"] == 6
    assert s["previous_total_violations"] == 1
    assert s["unacknowledged"] == 6
    assert s["flagged_tracks"] == 5  # cam1: A#1, legacy#1, C#1 ; cam2: B#1, B#5
    assert (s["workers_seen"], s["workers_flagged"]) == (19, 4)
    assert s["compliance_rate"] == round(15 / 19, 4)
    assert s["previous_compliance_rate"] is None  # no observation data before T0
    assert s["most_common_missing"] == {"item": "helmet", "count": 4, "share": round(4 / 6, 4)}
    assert s["most_flagged_camera"]["stream_id"] == "cam1" and s["most_flagged_camera"]["stream_name"] == "Gate"


def test_by_ppe_type_counts_each_missing_item(an):
    got = {r["item"]: r["count"] for r in an.by_ppe_type(SC)}
    assert got == {"helmet": 4, "vest": 2, "gloves": 1}


def test_by_camera_includes_idle_configured_cameras_and_compliance(an):
    rows = {r["stream_id"]: r for r in an.by_camera(SC, NAMES)}
    assert rows["cam1"]["violations"] == 4 and rows["cam1"]["flagged_tracks"] == 3
    assert rows["cam2"]["violations"] == 2 and rows["cam2"]["compliance_rate"] == 0.8
    assert rows["cam1"]["compliance_rate"] == round((14 - 3) / 14, 4)
    assert rows["cam3"] == {"stream_id": "cam3", "stream_name": "Yard", "violations": 0, "flagged_tracks": 0,
                            "last_violation": None, "unacknowledged": 0, "workers_seen": 0, "workers_flagged": 0,
                            "compliance_rate": None, "by_ppe": {}, "previous_violations": 0,
                            "previous_compliance_rate": None}
    # stacked bar: camera x missing item; previous period for the leaderboard trend arrow
    assert rows["cam1"]["by_ppe"] == {"helmet": 4, "vest": 1} and rows["cam2"]["by_ppe"] == {"vest": 1, "gloves": 1}
    assert rows["cam1"]["previous_violations"] == 1 and rows["cam2"]["previous_violations"] == 0
    assert [r["stream_id"] for r in an.by_camera(SC, NAMES)][0] == "cam1"  # most violations first


def test_timeseries_daily_in_viewer_time_zone_with_gaps_filled(an):
    ts = an.timeseries(SC, "day")
    assert ts["granularity"] == "day"
    assert [p["t"] for p in ts["points"]] == [at(0, 0), at(1, 0), at(2, 0)]  # local midnights
    assert [p["violations"] for p in ts["points"]] == [3, 1, 2]  # 23:59 IST stays on day 2
    assert [p["compliance_rate"] for p in ts["points"]] == [round(12 / 15, 4), None, 0.75]
    # in UTC the 23:59 IST violation is still day 2 but 00:00-05:30 IST shifts to the previous UTC day
    utc = an.timeseries(Scope(SC.start, SC.end, tz=0), "day")
    assert sum(p["violations"] for p in utc["points"]) == 6


def test_timeseries_hourly_for_short_ranges(an):
    ts = an.timeseries(Scope(at(0, 0), at(1, 0), tz=IST))
    assert ts["granularity"] == "hour" and len(ts["points"]) == 24
    assert ts["points"][9]["violations"] == 2 and ts["points"][14]["violations"] == 1


def test_heatmap_hour_of_day_by_day_of_week(an):
    hm = an.heatmap(SC)
    g = hm["grid"]
    assert hm["days"][0] == "Mon"
    assert g[0][9] == 2 and g[0][14] == 1  # Monday
    assert g[1][9] == 1  # Tuesday (legacy row)
    assert g[2][9] == 1 and g[2][23] == 1  # Wednesday
    assert sum(map(sum, g)) == 6 and hm["max"] == 2


def test_top_offenders_are_per_camera_session(an):
    top = an.top_offenders(SC, limit=10, names=NAMES)
    assert top[0]["stream_id"] == "cam1" and top[0]["run_id"] == "A" and top[0]["violations"] == 2
    assert top[0]["missing"] == ["helmet", "vest"] and top[0]["stream_name"] == "Gate"
    cam1_track1 = [t for t in top if t["stream_id"] == "cam1" and t["track_id"] == 1]
    assert len(cam1_track1) == 3  # sessions A, C and the legacy (unknown) one are not merged
    assert sum(not t["session_known"] for t in top) == 1


def test_camera_filter_applies_everywhere(an):
    sc = Scope(SC.start, SC.end, ("cam2",), IST)
    assert an.summary(sc)["total_violations"] == 2
    assert an.summary(sc)["workers_seen"] == 5
    assert {r["item"] for r in an.by_ppe_type(sc)} == {"vest", "gloves"}
    assert sum(map(sum, an.heatmap(sc)["grid"])) == 2
    assert [r["stream_id"] for r in an.by_camera(sc, NAMES)] == ["cam2"]


def test_acknowledged_counts(store, an):
    vid = store.list(ViolationFilter(), limit=1)["items"][0]["id"]
    assert store.acknowledge(vid, "operator")["acknowledged_by"] == "operator"
    assert store.acknowledge(vid, "someone-else")["acknowledged_by"] == "operator"  # first ack is kept
    assert an.summary(SC)["unacknowledged"] == 5


def test_http_endpoints(tmp_path, store):
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=2))
    cfg = load_config(path)
    mon = Monitor(cfg, store=store, detector_factory=FakeDetector)
    with TestClient(create_app(cfg, mon, config_path=path, auth_settings=auth_settings())) as c:
        h = bearer(bootstrap_super_admin(c))
        q = {"start": SC.start, "end": SC.end, "tz": IST}
        s = c.get("/api/analytics/summary", headers=h, params=q).json()
        assert s["total_violations"] == 6 and s["cameras"]["configured"] == 2
        assert c.get("/api/analytics/summary", headers=h, params={**q, "camera": ["cam1", "cam2"]}).json()["total_violations"] == 6
        assert c.get("/api/analytics/summary", headers=h, params={**q, "camera": "cam1"}).json()["total_violations"] == 4
        for ep in ("timeseries", "by-camera", "by-ppe-type", "heatmap", "top-offenders"):
            assert c.get(f"/api/analytics/{ep}", headers=h, params=q).status_code == 200, ep
        bad = c.get("/api/analytics/summary", headers=h, params={"start": SC.end, "end": SC.start})
        assert bad.status_code == 422 and bad.json()["code"] == "invalid_range"


def test_migration_adds_columns_to_an_existing_database(tmp_path):
    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE violations (id INTEGER PRIMARY KEY, ts FLOAT, stream_id VARCHAR(64), stream_name VARCHAR(128),"
                " track_id INTEGER, missing TEXT, image BLOB, thumb BLOB)")
    con.execute("INSERT INTO violations VALUES (1, 1790000000, 'cam1', 'C1', 3, '[\"helmet\"]', x'00', x'00')")
    con.commit()
    con.close()
    s = ViolationStore(str(db))

    item = s.list(ViolationFilter())["items"][0]
    assert item["track_id"] == 3 and item["acknowledged_at"] is None
    assert s.acknowledge(1, "me")["acknowledged_by"] == "me"
    s.close()
    ViolationStore(str(db)).close()  # second start: nothing to migrate, no error


def test_ppe_filter_applies_to_every_aggregation(an):
    sc = Scope(SC.start, SC.end, (), IST, ("vest",))
    assert an.summary(sc)["total_violations"] == 2  # rows missing a vest (one also misses a helmet)
    assert [r["item"] for r in an.by_ppe_type(sc)] == ["vest"]
    assert sum(p["violations"] for p in an.timeseries(sc, "day")["points"]) == 2
    assert sum(map(sum, an.heatmap(sc)["grid"])) == 2
    rows = {r["stream_id"]: r for r in an.by_camera(sc)}
    assert rows["cam1"]["by_ppe"] == {"vest": 1} and rows["cam1"]["violations"] == 1
    both = Scope(SC.start, SC.end, (), IST, ("vest", "gloves"))
    assert an.summary(both)["total_violations"] == 3


def test_weekly_buckets_start_on_monday_local(an):
    ts = an.timeseries(Scope(at(-14, 0), at(7, 0), tz=IST), "week")
    assert ts["granularity"] == "week" and [p["t"] for p in ts["points"]] == [at(-14, 0), at(-7, 0), at(0, 0)]
    assert [p["violations"] for p in ts["points"]] == [0, 1, 6]  # at(-2) falls in the previous week


def test_summary_per_day_averages(an):
    s = an.summary(SC)
    assert s["range"]["days"] == 3 and s["avg_violations_per_day"] == 2.0 and s["avg_workers_per_day"] == round(19 / 3, 1)


def test_unknown_ppe_filter_is_rejected(tmp_path, store):
    path = write_config(tmp_path, raw_config(tmp_path, n_streams=1))
    cfg = load_config(path)
    with TestClient(create_app(cfg, Monitor(cfg, store=store, detector_factory=FakeDetector), config_path=path,
                               auth_settings=auth_settings())) as c:
        h = bearer(bootstrap_super_admin(c))
        r = c.get("/api/analytics/summary", headers=h, params={"ppe": ["jetpack"]})
        assert r.status_code == 422 and r.json()["code"] == "invalid_ppe"
        ok = c.get("/api/analytics/summary", headers=h, params={"ppe": ["vest"], "start": SC.start, "end": SC.end, "tz": IST}).json()
        assert ok["total_violations"] == 2 and ok["compliance_target"] == 0.95
