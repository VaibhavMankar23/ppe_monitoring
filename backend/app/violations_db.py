"""Persistent violation store (SQLite via SQLAlchemy).

One row per alert: timestamp, camera, track ID, missing PPE, the full JPEG snapshot and a
small JPEG thumbnail (both as BLOBs, so a single file holds everything and deletes stay
consistent). The API layer returns images as base64.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from sqlalchemy import (
    Float, Integer, LargeBinary, String, Text, and_, create_engine, delete, event, func, inspect, or_, select, text, update,
)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class ViolationRow(Base):
    __tablename__ = "violations"
    # AUTOINCREMENT: an id is never handed out twice, even after the newest rows are deleted
    # (plain INTEGER PRIMARY KEY reuses max(id)+1, so audit entries / open viewers would point at a new record)
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[float] = mapped_column(Float, index=True)  # unix epoch seconds (UTC)
    stream_id: Mapped[str] = mapped_column(String(64), index=True)
    stream_name: Mapped[str] = mapped_column(String(128))
    track_id: Mapped[int] = mapped_column(Integer)
    missing: Mapped[str] = mapped_column(Text)  # JSON list, sorted: ["helmet","vest"]
    image: Mapped[bytes] = mapped_column(LargeBinary)  # full JPEG
    thumb: Mapped[bytes] = mapped_column(LargeBinary)  # small JPEG
    # camera session the track ID belongs to (IDs restart at #1 whenever a camera (re)starts);
    # NULL on rows recorded before sessions were tracked
    run_id: Mapped[str | None] = mapped_column(String(48), nullable=True, default=None)
    ack_at: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    ack_by: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    # --- the violation as an event (NULL on rows recorded before events were tracked)
    end_ts: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)  # last time it was observed
    observations: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)  # confirmed frames
    state: Mapped[str | None] = mapped_column(String(16), nullable=True, default=None)  # ongoing | ended
    # --- evidence + provenance
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    meta: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)  # JSON: model, settings, boxes, hashes
    original: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, default=None)  # clean full frame
    crop: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, default=None)  # clean full-res person crop
    evidence_purged_at: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    # --- human review: was the system right? (NULL = not reviewed yet)
    review: Mapped[str | None] = mapped_column(String(16), nullable=True, default=None)  # valid | false_alarm
    review_reason: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)  # see REVIEW_REASONS
    review_note: Mapped[str | None] = mapped_column(String(280), nullable=True, default=None)
    review_by: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    review_at: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)


REVIEW_VERDICTS = ("valid", "false_alarm")
# why a violation was a false alarm: each one points at a different fix (model, rules, camera)
REVIEW_REASONS: dict[str, str] = {
    "ppe_worn": "PPE was worn (model missed it)",
    "not_a_person": "Not a person",
    "wrong_person": "PPE assigned to the wrong person",
    "not_required_here": "PPE not required in this area",
    "duplicate": "Duplicate of another violation",
    "poor_image": "Image too unclear to judge",
    "other": "Other",
}

DATASET_README = """PPE monitor - review dataset export

images/        clean full-resolution frames, one per exported violation
labels/        YOLO pre-labels (class 0 = person): the worker the violation was raised for.
               Empty file = a reviewer marked the detection as "not a person" (hard negative).
manifest.csv   per image: what the system flagged, and the reviewer's verdict and reason.
data.yaml      Ultralytics dataset stub.

These are PRE-LABELS, not ground truth. Before training:
  1. open the set in an annotation tool (CVAT, Label Studio, Roboflow) and add the PPE boxes
     and any other people in the frame;
  2. use manifest.csv to find what to fix: review_reason=ppe_worn means the model missed PPE
     that was worn - label that PPE; not_a_person means the box was wrong - keep the image
     as a negative;
  3. split train/val by camera and by day, not randomly: frames from one recording are
     near-duplicates and a random split overstates accuracy.
"""

# columns added after the first release: (name, SQL type) - added in place by ViolationStore._migrate
_ADDED_COLUMNS = (("run_id", "VARCHAR(48)"), ("ack_at", "FLOAT"), ("ack_by", "VARCHAR(64)"),
                  ("end_ts", "FLOAT"), ("observations", "INTEGER"), ("state", "VARCHAR(16)"),
                  ("confidence", "FLOAT"), ("meta", "TEXT"), ("original", "BLOB"), ("crop", "BLOB"),
                  ("evidence_purged_at", "FLOAT"), ("review", "VARCHAR(16)"), ("review_reason", "VARCHAR(32)"),
                  ("review_note", "VARCHAR(280)"), ("review_by", "VARCHAR(64)"), ("review_at", "FLOAT"))

# columns of the list view (no images except the thumbnail)
_LIST_COLS = ("id", "ts", "stream_id", "stream_name", "track_id", "missing", "thumb", "ack_at", "ack_by",
              "end_ts", "observations", "state", "confidence", "evidence_purged_at",
              "review", "review_reason", "review_note", "review_by", "review_at")

OBS_BUCKET = 900  # s: observation counters are kept per camera per 15 minutes (aligns with every UTC offset)


class ObservationRow(Base):
    """How many tracked workers each camera evaluated, and how many of them raised an alert.

    The denominator of the compliance rate: violations alone can't say how many people were compliant.
    Each tracked worker is counted once per camera session, in the bucket where it was first evaluated.
    """

    __tablename__ = "observations"

    bucket: Mapped[float] = mapped_column(Float, primary_key=True)  # epoch seconds, multiple of OBS_BUCKET
    stream_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    seen: Mapped[int] = mapped_column(Integer, default=0)  # workers with a determinable status
    violating: Mapped[int] = mapped_column(Integer, default=0)  # of those, workers that raised >= 1 alert


@dataclass
class ViolationFilter:
    start: float | None = None  # epoch seconds, inclusive
    end: float | None = None  # epoch seconds, exclusive
    stream_id: str | None = None
    ppe: str | None = None  # one PPE item that must be in `missing`
    acknowledged: bool | None = None  # None = both
    review: str | None = None  # valid | false_alarm | unreviewed; None = all


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii") if data else ""


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def row_to_dict(r: ViolationRow, *, image: bool = False, extra: tuple[str, ...] = ()) -> dict[str, Any]:
    """API shape. `image` adds the annotated evidence image and the metadata; `extra` may add
    "original" (clean full frame) and/or "crop" (clean person crop) - large, so only on request."""
    end = r.end_ts if r.end_ts is not None else r.ts
    d: dict[str, Any] = {
        "id": r.id,
        "timestamp": r.ts,
        "iso": _iso(r.ts),
        "stream_id": r.stream_id,
        "stream_name": r.stream_name,
        "track_id": r.track_id,
        "missing": json.loads(r.missing),
        "thumbnail": _b64(r.thumb),
        "acknowledged_at": r.ack_at,
        "acknowledged_by": r.ack_by,
        # lifecycle: confirmed at `timestamp` -> ongoing / ended at `last_seen` -> acknowledged
        "state": r.state or "ended",
        "last_seen": end,
        "duration": round(max(0.0, end - r.ts), 1),
        "observations": r.observations or 1,
        "confidence": r.confidence,
        "evidence_purged_at": r.evidence_purged_at,
        "review": ({"verdict": r.review, "reason": r.review_reason, "note": r.review_note or "",
                    "by": r.review_by, "at": r.review_at} if r.review else None),
    }
    if image:
        d["image"] = _b64(r.image)
        d["meta"] = json.loads(r.meta) if r.meta else None
        d["has_original"] = bool(r.original)
        d["has_crop"] = bool(r.crop)
    if "original" in extra:
        d["original"] = _b64(r.original or b"")
    if "crop" in extra:
        d["crop"] = _b64(r.crop or b"")
    return d


class ViolationStore:
    """Thread-safe store. Writes are serialized with a lock (SQLite allows one writer)."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        url = "sqlite://" if db_path == ":memory:" else f"sqlite:///{Path(db_path).as_posix()}"
        kw: dict[str, Any] = {"connect_args": {"check_same_thread": False}}
        if db_path == ":memory:":
            from sqlalchemy.pool import StaticPool

            kw["poolclass"] = StaticPool
        self.engine: Engine = create_engine(url, **kw)

        @event.listens_for(self.engine, "connect")
        def _pragmas(dbapi_conn, _):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            if db_path != ":memory:":
                cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

        Base.metadata.create_all(self.engine)
        self._migrate()
        self._write_lock = threading.Lock()
        self._update_subscribers: list[Callable[[dict[str, Any]], None]] = []
        with self.engine.begin() as conn:  # events a previous run left open can't be extended any more
            conn.execute(update(ViolationRow).where(ViolationRow.state == "ongoing").values(state="ended"))
        self._subscribers: list[Callable[[dict[str, Any]], None]] = []
        # counters since server start (per camera), for the tiles' "alerts" figure
        self.session_total = 0
        self.session_per_stream: dict[str, int] = {}
        self._today: tuple[str, int] | None = None  # (local date, count) cache
        log.info("violation store: %s", db_path)

    def _migrate(self) -> None:
        """Add columns introduced after a database was created (SQLite ALTER TABLE ADD COLUMN)."""
        have = {c["name"] for c in inspect(self.engine).get_columns("violations")}
        with self.engine.begin() as conn:
            for name, sqltype in _ADDED_COLUMNS:
                if name not in have:
                    conn.execute(text(f"ALTER TABLE violations ADD COLUMN {name} {sqltype}"))
                    log.info("violations table: added column %s", name)
            self._ensure_autoincrement(conn)
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_violations_stream_ts ON violations (stream_id, ts)"))

    @staticmethod
    def _ensure_autoincrement(conn: Any) -> None:
        """Rebuild a table created without AUTOINCREMENT (one-off copy, same transaction), and seed its
        sequence with the highest id ever used - including ids only the audit log still remembers."""
        ddl = conn.execute(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='violations'")).scalar() or ""
        if "AUTOINCREMENT" in ddl.upper():
            return
        cols = ", ".join(c.name for c in ViolationRow.__table__.columns)
        for (name,) in conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='violations' AND sql IS NOT NULL")).all():
            conn.execute(text(f'DROP INDEX "{name}"'))
        conn.execute(text("ALTER TABLE violations RENAME TO violations_old"))
        ViolationRow.__table__.create(conn)
        conn.execute(text(f"INSERT INTO violations ({cols}) SELECT {cols} FROM violations_old"))
        conn.execute(text("DROP TABLE violations_old"))
        high = conn.execute(text("SELECT COALESCE(MAX(id), 0) FROM violations")).scalar() or 0
        if conn.execute(text("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'")).first():
            high = max(high, conn.execute(text(
                "SELECT COALESCE(MAX(CAST(target AS INTEGER)), 0) FROM audit_log "
                "WHERE target_type = 'violation' AND target GLOB '[0-9]*'")).scalar() or 0)
        conn.execute(text("DELETE FROM sqlite_sequence WHERE name='violations'"))
        conn.execute(text("INSERT INTO sqlite_sequence (name, seq) VALUES ('violations', :seq)"), {"seq": high})
        log.info("violations table: rebuilt with AUTOINCREMENT (ids continue after #%d)", high)

    # ------------------------------------------------------------ write
    def subscribe(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._subscribers.append(cb)

    def subscribe_updates(self, cb: Callable[[dict[str, Any]], None]) -> None:
        """`cb(summary)` whenever a stored violation event is extended or ends."""
        self._update_subscribers.append(cb)

    def add(self, stream_id: str, stream_name: str, track_id: int, missing: list[str],
            image: bytes, thumb: bytes, ts: float | None = None, run_id: str | None = None, *,
            confidence: float | None = None, meta: dict[str, Any] | None = None,
            original: bytes | None = None, crop: bytes | None = None, ongoing: bool = False) -> dict[str, Any]:
        t = ts if ts is not None else time.time()
        row = ViolationRow(ts=t, stream_id=stream_id, stream_name=stream_name,
                           track_id=track_id, missing=json.dumps(sorted(missing)), image=image, thumb=thumb,
                           run_id=run_id, end_ts=t, observations=1, state="ongoing" if ongoing else "ended",
                           confidence=confidence, meta=json.dumps(meta, default=str) if meta is not None else None,
                           original=original or None, crop=crop or None)
        with self._write_lock, Session(self.engine, expire_on_commit=False) as s:
            s.add(row)
            s.commit()
        self.session_total += 1
        self.session_per_stream[stream_id] = self.session_per_stream.get(stream_id, 0) + 1
        self._today = None
        d = row_to_dict(row)
        log.info("VIOLATION #%d %s track #%d missing %s", row.id, stream_id, track_id, ",".join(d["missing"]))
        for cb in self._subscribers:
            try:
                cb(d)
            except Exception:
                log.exception("violation subscriber failed")
        return d

    def extend(self, vid: int, *, last_seen: float, observations: int, missing: list[str] | None = None,
               ended: bool = False) -> bool:
        """Record more of an ongoing violation event (it's still the same violation, not a new one).
        Only event fields change - the evidence captured at confirmation is never touched.
        Returns False when the violation no longer exists (deleted meanwhile)."""
        values: dict[str, Any] = {"end_ts": last_seen, "observations": observations, "state": "ended" if ended else "ongoing"}
        if missing is not None:
            values["missing"] = json.dumps(sorted(missing))
        with self._write_lock, Session(self.engine) as s:
            n = s.execute(update(ViolationRow).where(ViolationRow.id == vid).values(**values)).rowcount
            s.commit()
        if not n:
            return False
        summary = {"id": vid, "last_seen": last_seen, "observations": observations, "state": values["state"]}
        if missing is not None:
            summary["missing"] = sorted(missing)
        for cb in self._update_subscribers:
            try:
                cb(summary)
            except Exception:
                log.exception("violation update subscriber failed")
        return True

    def acknowledge(self, vid: int, username: str, ts: float | None = None) -> dict[str, Any] | None:
        """Mark a violation as seen / handled. Idempotent: the first acknowledgement is kept."""
        with self._write_lock, Session(self.engine) as s:
            n = s.execute(update(ViolationRow).where(ViolationRow.id == vid, ViolationRow.ack_at.is_(None))
                          .values(ack_at=ts or time.time(), ack_by=username)).rowcount
            s.commit()
            if not n and s.scalar(select(ViolationRow.id).where(ViolationRow.id == vid)) is None:
                return None
        return self.get(vid, image=False)

    def set_review(self, vid: int, verdict: str | None, username: str, reason: str | None = None,
                   note: str = "", ts: float | None = None) -> dict[str, Any] | None:
        """Record a reviewer's verdict (None clears it). A reviewed violation counts as handled, so
        it is acknowledged too if nobody did that yet. Returns None when the violation doesn't exist."""
        t = ts or time.time()
        values: dict[str, Any] = {
            "review": verdict, "review_reason": reason if verdict == "false_alarm" else None,
            "review_note": (note or "").strip()[:280] or None if verdict else None,
            "review_by": username if verdict else None, "review_at": t if verdict else None,
        }
        with self._write_lock, Session(self.engine) as s:
            n = s.execute(update(ViolationRow).where(ViolationRow.id == vid).values(**values)).rowcount
            if n and verdict:
                s.execute(update(ViolationRow).where(ViolationRow.id == vid, ViolationRow.ack_at.is_(None))
                          .values(ack_at=t, ack_by=username))
            s.commit()
        return self.get(vid, image=False) if n else None

    def add_observations(self, stream_id: str, bucket: float, seen: int, violating: int) -> None:
        """Add to a camera's worker counters for one bucket (upsert)."""
        if not seen and not violating:
            return
        b = float(int(bucket // OBS_BUCKET) * OBS_BUCKET)
        stmt = sqlite_insert(ObservationRow).values(bucket=b, stream_id=stream_id, seen=seen, violating=violating)
        stmt = stmt.on_conflict_do_update(
            index_elements=[ObservationRow.bucket, ObservationRow.stream_id],
            set_={"seen": ObservationRow.seen + seen, "violating": ObservationRow.violating + violating},
        )
        with self._write_lock, self.engine.begin() as conn:
            conn.execute(stmt)

    def delete(self, vid: int) -> bool:
        with self._write_lock, Session(self.engine) as s:
            n = s.execute(delete(ViolationRow).where(ViolationRow.id == vid)).rowcount
            s.commit()
        self._today = None
        return bool(n)

    def cleanup(self, retention_days: int, now: float | None = None) -> int:
        """Delete rows older than `retention_days` (0 = keep forever). Returns rows deleted."""
        if retention_days <= 0:
            return 0
        cutoff = (now if now is not None else time.time()) - retention_days * 86400
        with self._write_lock, Session(self.engine) as s:
            n = s.execute(delete(ViolationRow).where(ViolationRow.ts < cutoff)).rowcount
            s.execute(delete(ObservationRow).where(ObservationRow.bucket < cutoff))
            s.commit()
        if n:
            self._today = None
            log.info("retention: deleted %d violation(s) older than %d day(s)", n, retention_days)
        return n or 0

    def purge_evidence(self, days: int, now: float | None = None) -> int:
        """Evidence retention: drop the images (evidence, original frame, person crop) of violations
        whose event ended more than `days` ago; the record, its metadata and its thumbnail stay.
        Ongoing events are never touched. 0 = keep images as long as the record. Returns rows purged."""
        if days <= 0:
            return 0
        t = now if now is not None else time.time()
        cutoff = t - days * 86400
        with self._write_lock, Session(self.engine) as s:
            n = s.execute(update(ViolationRow).where(
                ViolationRow.evidence_purged_at.is_(None),
                func.coalesce(ViolationRow.end_ts, ViolationRow.ts) < cutoff,
                or_(ViolationRow.state.is_(None), ViolationRow.state != "ongoing"),
            ).values(image=b"", original=None, crop=None, evidence_purged_at=t)).rowcount
            s.commit()
        if n:
            log.info("evidence retention: removed the images of %d violation(s) older than %d day(s) "
                     "(records and thumbnails kept)", n, days)
        return n or 0

    # ------------------------------------------------------------ read
    @staticmethod
    def _where(stmt, f: ViolationFilter):  # noqa: ANN001, ANN205
        if f.start is not None:
            stmt = stmt.where(ViolationRow.ts >= f.start)
        if f.end is not None:
            stmt = stmt.where(ViolationRow.ts < f.end)
        if f.stream_id:
            stmt = stmt.where(ViolationRow.stream_id == f.stream_id)
        if f.ppe:
            stmt = stmt.where(ViolationRow.missing.like(f'%"{f.ppe}"%'))
        if f.acknowledged is True:
            stmt = stmt.where(ViolationRow.ack_at.is_not(None))
        elif f.acknowledged is False:
            stmt = stmt.where(ViolationRow.ack_at.is_(None))
        if f.review == "unreviewed":
            stmt = stmt.where(ViolationRow.review.is_(None))
        elif f.review:
            stmt = stmt.where(ViolationRow.review == f.review)
        return stmt

    def list(self, f: ViolationFilter, limit: int = 50, before_id: int | None = None) -> dict[str, Any]:
        """Newest first by timestamp. Keyset pagination: pass the returned `next_before_id` to get the
        next page (stable even while new rows arrive, unlike offsets)."""
        limit = max(1, min(limit, 200))
        cols = tuple(getattr(ViolationRow, c) for c in _LIST_COLS)
        with Session(self.engine) as s:
            total = s.scalar(self._where(select(func.count(ViolationRow.id)), f)) or 0
            stmt = self._where(select(*cols), f)
            if before_id is not None:
                # keyset on (ts, id): resolve the cursor row's timestamp, then take strictly older rows
                cts = s.scalar(select(ViolationRow.ts).where(ViolationRow.id == before_id))
                if cts is None:
                    stmt = stmt.where(ViolationRow.id < before_id)
                else:
                    stmt = stmt.where(or_(ViolationRow.ts < cts, and_(ViolationRow.ts == cts, ViolationRow.id < before_id)))
            rows = s.execute(stmt.order_by(ViolationRow.ts.desc(), ViolationRow.id.desc()).limit(limit + 1)).all()
        items = [row_to_dict(ViolationRow(image=b"", **dict(zip(_LIST_COLS, r)))) for r in rows[:limit]]
        next_id = items[-1]["id"] if len(rows) > limit else None
        return {"items": items, "total": total, "next_before_id": next_id}

    def get(self, vid: int, image: bool = True, extra: tuple[str, ...] = ()) -> dict[str, Any] | None:
        with Session(self.engine) as s:
            r = s.get(ViolationRow, vid)
            return row_to_dict(r, image=image, extra=extra) if r else None

    def iter_rows(self, f: ViolationFilter) -> Iterator[tuple[Any, ...]]:
        """(id, ts, stream_id, stream_name, track_id, missing list, ack_at, ack_by,
        end_ts, observations, confidence, meta, review, review_reason, review_by), newest first."""
        stmt = self._where(select(ViolationRow.id, ViolationRow.ts, ViolationRow.stream_id, ViolationRow.stream_name,
                                  ViolationRow.track_id, ViolationRow.missing, ViolationRow.ack_at,
                                  ViolationRow.ack_by, ViolationRow.end_ts, ViolationRow.observations,
                                  ViolationRow.confidence, ViolationRow.meta, ViolationRow.review,
                                  ViolationRow.review_reason, ViolationRow.review_by),
                           f).order_by(ViolationRow.ts.desc(), ViolationRow.id.desc())
        with Session(self.engine) as s:
            for r in s.execute(stmt):
                yield (r[0], r[1], r[2], r[3], r[4], json.loads(r[5]), r[6], r[7], r[8], r[9], r[10],
                       json.loads(r[11]) if r[11] else None, r[12], r[13], r[14])

    def export_csv(self, f: ViolationFilter) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        # the first nine columns are unchanged from earlier versions; event / provenance columns follow
        w.writerow(["id", "timestamp_utc", "local_time", "camera_id", "camera_name", "track_id", "missing_ppe",
                    "acknowledged_at_utc", "acknowledged_by", "last_seen_utc", "duration_s", "observations",
                    "confidence", "model", "review", "review_reason", "reviewed_by"])
        for vid, ts, sid, name, tid, missing, ack_at, ack_by, end_ts, obs, conf, meta, rev, rev_reason, rev_by in self.iter_rows(f):
            local = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
            end = end_ts if end_ts is not None else ts
            model = ((meta or {}).get("model") or {}).get("weights", "")
            w.writerow([vid, _iso(ts), local, sid, name, tid, ";".join(missing), _iso(ack_at) if ack_at else "",
                        ack_by or "", _iso(end), round(max(0.0, end - ts), 1), obs or 1,
                        "" if conf is None else round(conf, 3), model, rev or "", rev_reason or "", rev_by or ""])
        return buf.getvalue()

    def export_dataset(self, f: ViolationFilter, out: Any, limit: int = 500) -> int:
        """Write a training-data zip of the newest `limit` matching violations that still have their
        clean original frame. Layout (Ultralytics YOLO): images/, labels/, data.yaml, manifest.csv.

        The label files are *pre-labels*, not ground truth: one `person` box per image (the worker the
        violation was raised for), or an empty file when a reviewer said it was not a person - a hard
        negative. PPE boxes must be added in an annotation tool; manifest.csv carries the reviewer's
        verdict for every image so the annotator knows what the model got wrong. Returns images written."""
        import zipfile

        stmt = self._where(select(ViolationRow.id, ViolationRow.ts, ViolationRow.stream_id, ViolationRow.missing,
                                  ViolationRow.confidence, ViolationRow.meta, ViolationRow.review,
                                  ViolationRow.review_reason, ViolationRow.review_note), f) \
            .where(ViolationRow.original.is_not(None)).order_by(ViolationRow.ts.desc(), ViolationRow.id.desc()) \
            .limit(max(1, min(limit, 2000)))
        man = io.StringIO()
        mw = csv.writer(man)
        mw.writerow(["image", "violation_id", "timestamp_utc", "camera_id", "flagged_as_missing", "confidence",
                     "review", "review_reason", "review_note", "person_box_xyxy_px", "frame_w", "frame_h"])
        n = 0
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z, Session(self.engine) as s:  # JPEGs don't compress
            rows = s.execute(stmt).all()
            for vid, ts, sid, missing, conf, meta, rev, reason, note in rows:
                img = s.scalar(select(ViolationRow.original).where(ViolationRow.id == vid))
                if not img:
                    continue
                det = (json.loads(meta) if meta else {}).get("detection") or {}
                box, size = det.get("box"), det.get("frame_size")
                name = f"v{vid:07d}"
                label = ""
                if box and size and reason != "not_a_person":
                    w, h = size
                    cx, cy = (box[0] + box[2]) / 2 / w, (box[1] + box[3]) / 2 / h
                    bw, bh = (box[2] - box[0]) / w, (box[3] - box[1]) / h
                    label = f"0 {min(1, max(0, cx)):.6f} {min(1, max(0, cy)):.6f} {min(1, bw):.6f} {min(1, bh):.6f}\n"
                z.writestr(f"images/{name}.jpg", img)
                z.writestr(f"labels/{name}.txt", label)
                mw.writerow([f"images/{name}.jpg", vid, _iso(ts), sid, ";".join(json.loads(missing)),
                             "" if conf is None else round(conf, 3), rev or "", reason or "", note or "",
                             " ".join(str(v) for v in box) if box else "", *(size or ["", ""])])
                n += 1
            z.writestr("manifest.csv", man.getvalue())
            z.writestr("data.yaml", "# Pre-labels exported from the PPE monitor. Add your PPE classes after `person`.\n"
                                    "path: .\ntrain: images\nval: images\nnames:\n  0: person\n")
            z.writestr("README.txt", DATASET_README)
        return n

    def count_today(self) -> int:
        """Violations since local midnight (cached; invalidated on add/delete/cleanup)."""
        today = datetime.now().strftime("%Y-%m-%d")
        if self._today and self._today[0] == today:
            return self._today[1]
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        with Session(self.engine) as s:
            n = s.scalar(select(func.count(ViolationRow.id)).where(ViolationRow.ts >= midnight)) or 0
        self._today = (today, n)
        return n

    def close(self) -> None:
        self.engine.dispose()
