"""SQLite violation store: filters, keyset pagination, base64, delete, CSV, retention."""

from __future__ import annotations

import base64
import time

import pytest

from app.violations_db import ViolationFilter, ViolationStore

DAY = 86400.0
NOW = 1_790_000_000.0  # fixed "now" for deterministic tests


@pytest.fixture()
def store():
    s = ViolationStore(":memory:")
    # 30 rows: 3 cameras x 10, one row per hour going back, alternating missing sets
    for i in range(30):
        cam = f"cam{i % 3 + 1}"
        missing = ["helmet"] if i % 2 else ["helmet", "vest"]
        s.add(cam, cam.upper(), track_id=i, missing=missing, image=b"FULL%d" % i, thumb=b"T%d" % i, ts=NOW - i * 3600)
    yield s
    s.close()


def ids(page):
    return [v["id"] for v in page["items"]]


def test_newest_first_and_thumbnail_is_base64(store):
    page = store.list(ViolationFilter(), limit=5)
    assert page["total"] == 30 and len(page["items"]) == 5
    ts = [v["timestamp"] for v in page["items"]]
    assert ts == sorted(ts, reverse=True)
    assert base64.b64decode(page["items"][0]["thumbnail"]) == b"T0"
    assert "image" not in page["items"][0]  # list stays light


def test_keyset_pagination_covers_everything_once(store):
    seen, cursor = [], None
    while True:
        page = store.list(ViolationFilter(), limit=7, before_id=cursor)
        seen += ids(page)
        cursor = page["next_before_id"]
        if cursor is None:
            break
    assert len(seen) == 30 and len(set(seen)) == 30


def test_pagination_stable_when_new_rows_arrive(store):
    first = store.list(ViolationFilter(), limit=10)
    store.add("cam1", "CAM1", 99, ["vest"], b"x", b"y", ts=NOW + 10)  # arrives while scrolling
    second = store.list(ViolationFilter(), limit=10, before_id=first["next_before_id"])
    assert not set(ids(first)) & set(ids(second))


def test_filters_camera_ppe_and_date_range(store):
    assert store.list(ViolationFilter(stream_id="cam2"))["total"] == 10
    assert store.list(ViolationFilter(ppe="vest"))["total"] == 15
    assert store.list(ViolationFilter(ppe="helmet"))["total"] == 30
    # last 5 hours: rows 0..4 (ts > NOW-5h), end exclusive
    rng = store.list(ViolationFilter(start=NOW - 4 * 3600, end=NOW + 1))
    assert rng["total"] == 5
    both = store.list(ViolationFilter(stream_id="cam1", ppe="vest", start=NOW - DAY, end=NOW + 1))
    assert all(v["stream_id"] == "cam1" and "vest" in v["missing"] for v in both["items"])


def test_get_returns_full_image_base64_and_delete(store):
    vid = store.list(ViolationFilter(), limit=1)["items"][0]["id"]
    full = store.get(vid)
    assert base64.b64decode(full["image"]) == b"FULL0"
    assert full["iso"].endswith("Z")
    assert store.delete(vid) and store.get(vid) is None
    assert not store.delete(vid)


def test_csv_export_respects_filters(store):
    text = store.export_csv(ViolationFilter(stream_id="cam3"))
    lines = text.strip().splitlines()
    assert lines[0].startswith("id,timestamp_utc,local_time,camera_id")
    assert len(lines) == 1 + 10 and all(",cam3," in ln for ln in lines[1:])


def test_retention_cleanup(store):
    # rows are 0..29 hours old; keep 1 day -> rows older than 24h (ages 25..29h) are deleted
    deleted = store.cleanup(retention_days=1, now=NOW)
    assert deleted == 5
    assert store.list(ViolationFilter())["total"] == 25
    assert store.cleanup(retention_days=0, now=NOW + 999 * DAY) == 0  # 0 = keep forever


def test_subscribers_and_today_count(store):
    got = []
    store.subscribe(got.append)
    before = store.count_today()
    store.add("cam1", "CAM1", 7, ["helmet"], b"a", b"b", ts=time.time())
    assert got and got[0]["track_id"] == 7 and "thumbnail" in got[0]
    assert store.count_today() == before + 1
    assert store.session_per_stream["cam1"] >= 1


def test_ids_are_never_reused_after_deleting_the_newest(store):
    rows = store.list(ViolationFilter(), limit=200)["items"]
    highest = max(v["id"] for v in rows)
    for v in rows:
        store.delete(v["id"])
    assert store.add("cam1", "CAM1", 1, ["helmet"], b"F", b"T")["id"] == highest + 1


def test_legacy_table_is_migrated_to_autoincrement(tmp_path):
    import sqlite3

    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    # a database created before AUTOINCREMENT: ids 1..3 in use, #7 deleted but still named in the audit log
    con.executescript("""
        CREATE TABLE violations (id INTEGER NOT NULL, ts FLOAT NOT NULL, stream_id VARCHAR(64) NOT NULL,
            stream_name VARCHAR(128) NOT NULL, track_id INTEGER NOT NULL, missing TEXT NOT NULL,
            image BLOB NOT NULL, thumb BLOB NOT NULL, PRIMARY KEY (id));
        CREATE INDEX ix_violations_ts ON violations (ts);
        CREATE TABLE audit_log (id INTEGER PRIMARY KEY, target_type VARCHAR(32), target VARCHAR(128));
        INSERT INTO audit_log (target_type, target) VALUES ('violation', '7'), ('violations', '12 row(s)');
    """)
    for i in (1, 2, 3):
        con.execute("INSERT INTO violations VALUES (?, ?, 'cam1', 'CAM1', ?, '[\"helmet\"]', x'00', x'00')", (i, NOW + i, i))
    con.commit()
    con.close()

    s = ViolationStore(str(db))
    try:
        page = s.list(ViolationFilter(), limit=10)
        assert [v["id"] for v in page["items"]] == [3, 2, 1]  # rows and their columns survive the rebuild
        assert s.add("cam1", "CAM1", 9, ["vest"], b"F", b"T")["id"] == 8  # continues after the audit's #7
    finally:
        s.close()
    s = ViolationStore(str(db))  # reopening doesn't rebuild again
    try:
        assert s.add("cam1", "CAM1", 10, ["vest"], b"F", b"T")["id"] == 9
    finally:
        s.close()
