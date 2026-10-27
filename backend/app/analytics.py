"""Analytics: SQL aggregations over the violations and observations tables.

Every figure is computed in SQLite (GROUP BY / COUNT / json_each) and only the aggregated
rows reach Python, so response size depends on the number of buckets, not on how many
violations are stored.

Time handling: rows store UTC epoch seconds. "Day", "hour of day" and "day of week" are in
the *viewer's* local time, given as ``tz`` = minutes east of UTC (the browser's
``-new Date().getTimezoneOffset()``). A fixed offset is exact for zones without DST (e.g. IST).

Compliance rate = (workers evaluated - workers that raised an alert) / workers evaluated,
from the per-camera observation counters written by the pipeline. It is only available for
periods the pipeline ran with those counters (older violations have no denominator).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import Integer, cast, distinct, exists, func, literal, select, true
from sqlalchemy.orm import Session

from .auth import ApiError, require
from .ppe_logic import VIOLATION_ITEMS
from .violations_db import REVIEW_REASONS, ObservationRow, ViolationRow, ViolationStore

DAY = 86400
HOUR = 3600
MAX_RANGE_DAYS = 400
MAX_BUCKETS = 2000
WEEK = 7 * DAY
Granularity = Literal["auto", "hour", "day", "week"]


@dataclass(frozen=True)
class Scope:
    start: float  # inclusive, epoch s
    end: float  # exclusive
    cameras: tuple[str, ...] = ()  # empty = all
    tz: int = 0  # minutes east of UTC
    ppe: tuple[str, ...] = ()  # only violations missing at least one of these items; empty = all

    @property
    def offset(self) -> int:
        return self.tz * 60

    def previous(self) -> "Scope":
        span = self.end - self.start
        return Scope(self.start - span, self.start, self.cameras, self.tz, self.ppe)


def _v_where(stmt, sc: Scope):  # noqa: ANN001, ANN202
    stmt = stmt.where(ViolationRow.ts >= sc.start, ViolationRow.ts < sc.end)
    if sc.cameras:
        stmt = stmt.where(ViolationRow.stream_id.in_(sc.cameras))
    if sc.ppe:
        item = func.json_each(ViolationRow.missing).table_valued("value").alias("f")
        stmt = stmt.where(exists(select(literal(1)).select_from(item).where(item.c.value.in_(sc.ppe))))
    return stmt


def _o_where(stmt, sc: Scope):  # noqa: ANN001, ANN202
    stmt = stmt.where(ObservationRow.bucket >= sc.start, ObservationRow.bucket < sc.end)
    if sc.cameras:
        stmt = stmt.where(ObservationRow.stream_id.in_(sc.cameras))
    return stmt


def _rate(seen: int, violating: int) -> float | None:
    return round((seen - violating) / seen, 4) if seen > 0 else None


def _local_index(col, sc: Scope, size: int):  # noqa: ANN001, ANN202
    """Local-time bucket number of an epoch column: floor((ts + offset) / size)."""
    return cast((col + sc.offset) / size, Integer)


def _offender_key():  # noqa: ANN202
    """A track is only unique within one camera session (IDs restart at #1 on every start)."""
    return ViolationRow.stream_id + literal("|") + func.coalesce(ViolationRow.run_id, "") + literal("|") + \
        cast(ViolationRow.track_id, ViolationRow.stream_id.type)


class Analytics:
    def __init__(self, store: ViolationStore) -> None:
        self.engine = store.engine

    # ------------------------------------------------------------ building blocks
    def _counts(self, s: Session, sc: Scope) -> tuple[int, int, int]:
        """(violations, unacknowledged, distinct flagged tracks)."""
        row = s.execute(_v_where(select(
            func.count(ViolationRow.id),
            func.sum(cast(ViolationRow.ack_at.is_(None), Integer)),
            func.count(distinct(_offender_key())),
        ), sc)).one()
        return int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)

    def _obs(self, s: Session, sc: Scope) -> tuple[int, int]:
        row = s.execute(_o_where(select(func.sum(ObservationRow.seen), func.sum(ObservationRow.violating)), sc)).one()
        return int(row[0] or 0), int(row[1] or 0)

    # ------------------------------------------------------------ endpoints
    def by_ppe_type(self, sc: Scope) -> list[dict[str, Any]]:
        item = func.json_each(ViolationRow.missing).table_valued("value")
        with Session(self.engine) as s:
            total = s.scalar(_v_where(select(func.count(ViolationRow.id)), sc)) or 0
            stmt = _v_where(select(item.c.value, func.count()).select_from(ViolationRow).join(item, true()), sc)
            if sc.ppe:
                stmt = stmt.where(item.c.value.in_(sc.ppe))
            rows = s.execute(stmt.group_by(item.c.value).order_by(func.count().desc(), item.c.value)).all()
        return [{"item": r[0], "count": int(r[1]), "share": round(r[1] / total, 4) if total else 0.0} for r in rows]

    def by_camera(self, sc: Scope, names: dict[str, str] | None = None) -> list[dict[str, Any]]:
        names = names or {}
        with Session(self.engine) as s:
            rows = s.execute(_v_where(select(
                ViolationRow.stream_id, func.max(ViolationRow.stream_name), func.count(ViolationRow.id),
                func.count(distinct(_offender_key())), func.max(ViolationRow.ts),
                func.sum(cast(ViolationRow.ack_at.is_(None), Integer)),
            ), sc).group_by(ViolationRow.stream_id)).all()
            obs = dict((r[0], (int(r[1] or 0), int(r[2] or 0))) for r in s.execute(_o_where(select(
                ObservationRow.stream_id, func.sum(ObservationRow.seen), func.sum(ObservationRow.violating),
            ), sc).group_by(ObservationRow.stream_id)))
            prev = sc.previous()
            prev_v = dict(s.execute(_v_where(select(ViolationRow.stream_id, func.count(ViolationRow.id)), prev)
                                    .group_by(ViolationRow.stream_id)).all())
            prev_o = {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in s.execute(_o_where(select(
                ObservationRow.stream_id, func.sum(ObservationRow.seen), func.sum(ObservationRow.violating)), prev)
                .group_by(ObservationRow.stream_id))}
            item = func.json_each(ViolationRow.missing).table_valued("value")
            stack = _v_where(select(ViolationRow.stream_id, item.c.value, func.count()).select_from(ViolationRow)
                             .join(item, true()), sc)
            if sc.ppe:
                stack = stack.where(item.c.value.in_(sc.ppe))
            by_item: dict[str, dict[str, int]] = {}
            for sid, it, n in s.execute(stack.group_by(ViolationRow.stream_id, item.c.value)):
                by_item.setdefault(sid, {})[it] = int(n)
        out: dict[str, dict[str, Any]] = {}
        for sid, name, n, tracks, last, unacked in rows:
            out[sid] = {"stream_id": sid, "stream_name": names.get(sid, name), "violations": int(n),
                        "flagged_tracks": int(tracks), "last_violation": last, "unacknowledged": int(unacked or 0)}
        # configured cameras with no violations still belong in a comparison
        for sid, name in names.items():
            if (not sc.cameras or sid in sc.cameras) and sid not in out:
                out[sid] = {"stream_id": sid, "stream_name": name, "violations": 0, "flagged_tracks": 0,
                            "last_violation": None, "unacknowledged": 0}
        for sid, d in out.items():
            seen, bad = obs.get(sid, (0, 0))
            pseen, pbad = prev_o.get(sid, (0, 0))
            d.update(workers_seen=seen, workers_flagged=bad, compliance_rate=_rate(seen, bad),
                     by_ppe=by_item.get(sid, {}), previous_violations=int(prev_v.get(sid, 0)),
                     previous_compliance_rate=_rate(pseen, pbad))
        return sorted(out.values(), key=lambda d: (-d["violations"], d["stream_id"]))

    def timeseries(self, sc: Scope, granularity: Granularity = "auto") -> dict[str, Any]:
        span = sc.end - sc.start
        g = granularity if granularity != "auto" else ("hour" if span <= 2 * DAY else "day")
        if g == "week":
            return self._weekly(sc)
        size = HOUR if g == "hour" else DAY
        if span / size > MAX_BUCKETS:
            g, size = "day", DAY
        vi = _local_index(ViolationRow.ts, sc, size)
        oi = _local_index(ObservationRow.bucket, sc, size)
        with Session(self.engine) as s:
            v = dict(s.execute(_v_where(select(vi, func.count(ViolationRow.id)), sc).group_by(vi)).all())
            o = {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in s.execute(_o_where(select(
                oi, func.sum(ObservationRow.seen), func.sum(ObservationRow.violating)), sc).group_by(oi))}
        first = int((sc.start + sc.offset) // size)
        last = int((sc.end - 1e-6 + sc.offset) // size)
        points = []
        for i in range(first, last + 1):  # gaps filled with zeros so charts don't interpolate over them
            seen, bad = o.get(i, (0, 0))
            points.append({"t": i * size - sc.offset, "violations": int(v.get(i, 0)), "workers_seen": seen,
                           "workers_flagged": bad, "compliance_rate": _rate(seen, bad)})
        return {"granularity": g, "bucket_seconds": size, "tz": sc.tz, "points": points}

    def _weekly(self, sc: Scope) -> dict[str, Any]:
        """ISO weeks (Monday 00:00 local): day number + 3 is a multiple of 7 on Mondays (1970-01-01 = Thursday)."""
        vw = cast((cast((ViolationRow.ts + sc.offset) / DAY, Integer) + 3) / 7, Integer)
        ow = cast((cast((ObservationRow.bucket + sc.offset) / DAY, Integer) + 3) / 7, Integer)
        with Session(self.engine) as s:
            v = dict(s.execute(_v_where(select(vw, func.count(ViolationRow.id)), sc).group_by(vw)).all())
            o = {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in s.execute(_o_where(select(
                ow, func.sum(ObservationRow.seen), func.sum(ObservationRow.violating)), sc).group_by(ow))}
        week = lambda t: (int((t + sc.offset) // DAY) + 3) // 7  # noqa: E731
        points = []
        for w in range(week(sc.start), week(sc.end - 1e-6) + 1):
            seen, bad = o.get(w, (0, 0))
            points.append({"t": (w * 7 - 3) * DAY - sc.offset, "violations": int(v.get(w, 0)), "workers_seen": seen,
                           "workers_flagged": bad, "compliance_rate": _rate(seen, bad)})
        return {"granularity": "week", "bucket_seconds": WEEK, "tz": sc.tz, "points": points}

    def heatmap(self, sc: Scope) -> dict[str, Any]:
        local = ViolationRow.ts + sc.offset
        # 1970-01-01 was a Thursday -> (days + 3) % 7 gives 0 = Monday ... 6 = Sunday
        dow = (cast(local / DAY, Integer) + 3) % 7
        hour = cast((local % DAY) / HOUR, Integer)
        with Session(self.engine) as s:
            rows = s.execute(_v_where(select(dow, hour, func.count(ViolationRow.id)), sc).group_by(dow, hour)).all()
        grid = [[0] * 24 for _ in range(7)]
        for d, h, n in rows:
            grid[int(d)][int(h)] = int(n)
        return {"days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], "grid": grid,
                "max": max((max(r) for r in grid), default=0), "tz": sc.tz}

    def top_offenders(self, sc: Scope, limit: int = 10, names: dict[str, str] | None = None) -> list[dict[str, Any]]:
        names = names or {}
        n = func.count(ViolationRow.id)
        with Session(self.engine) as s:
            rows = s.execute(_v_where(select(
                ViolationRow.stream_id, func.max(ViolationRow.stream_name), ViolationRow.run_id, ViolationRow.track_id,
                n, func.min(ViolationRow.ts), func.max(ViolationRow.ts),
                func.group_concat(distinct(ViolationRow.missing)),
            ), sc).group_by(ViolationRow.stream_id, ViolationRow.run_id, ViolationRow.track_id)
                .order_by(n.desc(), func.max(ViolationRow.ts).desc()).limit(limit)).all()
        out = []
        for sid, name, run, tid, cnt, first, last, missing_sets in rows:
            items: set[str] = set()
            # group_concat joins the distinct JSON lists with "," -> wrap in [] to parse as a list of lists
            for lst in json.loads(f"[{missing_sets}]") if missing_sets else []:
                items.update(lst)
            out.append({"stream_id": sid, "stream_name": names.get(sid, name), "track_id": int(tid),
                        "run_id": run, "session_known": run is not None, "violations": int(cnt),
                        "first_seen": first, "last_seen": last, "missing": sorted(items)})
        return out

    def review_quality(self, sc: Scope) -> dict[str, Any]:
        """How often reviewers agreed with the system. precision = valid / reviewed: the share of
        reviewed violations that were real. It says nothing about violations the system missed."""
        with Session(self.engine) as s:
            total = s.scalar(_v_where(select(func.count(ViolationRow.id)), sc)) or 0
            verdicts = dict(s.execute(_v_where(select(ViolationRow.review, func.count(ViolationRow.id)), sc)
                                      .where(ViolationRow.review.is_not(None)).group_by(ViolationRow.review)).all())
            reasons = s.execute(_v_where(select(ViolationRow.review_reason, func.count(ViolationRow.id)), sc)
                                .where(ViolationRow.review == "false_alarm").group_by(ViolationRow.review_reason)
                                .order_by(func.count(ViolationRow.id).desc())).all()
            cams = s.execute(_v_where(select(
                ViolationRow.stream_id, func.max(ViolationRow.stream_name),
                func.sum(cast(ViolationRow.review == "valid", Integer)),
                func.sum(cast(ViolationRow.review == "false_alarm", Integer))), sc)
                .where(ViolationRow.review.is_not(None)).group_by(ViolationRow.stream_id)).all()
        valid, false = int(verdicts.get("valid", 0)), int(verdicts.get("false_alarm", 0))
        reviewed = valid + false
        return {
            "total": int(total), "reviewed": reviewed, "valid": valid, "false_alarms": false,
            "unreviewed": int(total) - reviewed,
            "precision": round(valid / reviewed, 4) if reviewed else None,
            "reasons": [{"reason": r or "other", "label": REVIEW_REASONS.get(r or "other", r or "Other"), "count": int(n)}
                        for r, n in reasons],
            "by_camera": [{"stream_id": sid, "stream_name": name, "valid": int(v or 0), "false_alarms": int(f or 0),
                           "precision": round((v or 0) / ((v or 0) + (f or 0)), 4) if (v or 0) + (f or 0) else None}
                          for sid, name, v, f in cams],
        }

    def summary(self, sc: Scope, names: dict[str, str] | None = None) -> dict[str, Any]:
        with Session(self.engine) as s:
            total, unacked, tracks = self._counts(s, sc)
            prev_total, _, _ = self._counts(s, sc.previous())
            seen, bad = self._obs(s, sc)
            pseen, pbad = self._obs(s, sc.previous())
            since = s.scalar(select(func.min(ObservationRow.bucket)))
        ppe = self.by_ppe_type(sc)
        cams = [c for c in self.by_camera(sc, names) if c["violations"] > 0]
        days = max(1e-9, (sc.end - sc.start) / DAY)
        return {
            "range": {"start": sc.start, "end": sc.end, "tz": sc.tz, "cameras": list(sc.cameras), "ppe": list(sc.ppe),
                      "days": round(days, 2)},
            "avg_violations_per_day": round(total / days, 1),
            "avg_workers_per_day": round(seen / days, 1),
            "total_violations": total,
            "previous_total_violations": prev_total,
            "unacknowledged": unacked,
            "flagged_tracks": tracks,
            "workers_seen": seen,
            "workers_flagged": bad,
            "compliance_rate": _rate(seen, bad),
            "previous_compliance_rate": _rate(pseen, pbad),
            "compliance_data_since": since,
            "most_common_missing": ppe[0] if ppe else None,
            "most_flagged_camera": cams[0] if cams else None,
            "review": self.review_quality(sc),
        }


# ------------------------------------------------------------------ HTTP
def _scope(start: float | None, end: float | None, camera: list[str] | None, tz: int, ppe: list[str] | None = None) -> Scope:
    now = time.time()
    end = end if end is not None else now
    start = start if start is not None else end - 7 * DAY
    if end <= start:
        raise ApiError(422, "'end' must be after 'start'.", "invalid_range")
    if end - start > MAX_RANGE_DAYS * DAY:
        raise ApiError(422, f"The date range can be at most {MAX_RANGE_DAYS} days.", "invalid_range")
    cams = tuple(sorted({c for c in (camera or []) if c}))
    items = tuple(sorted({p for p in (ppe or []) if p}))
    unknown = [p for p in items if p not in VIOLATION_ITEMS]
    if unknown:
        raise ApiError(422, f"unknown PPE item(s): {', '.join(unknown)}", "invalid_ppe")
    return Scope(float(start), float(end), cams, tz, items)


def build_router() -> APIRouter:
    r = APIRouter(prefix="/api/analytics", dependencies=[Depends(require("analytics:view"))])

    def params(start: float | None = Query(None, description="epoch seconds, inclusive (default: end - 7 days)"),
               end: float | None = Query(None, description="epoch seconds, exclusive (default: now)"),
               camera: list[str] | None = Query(None, description="repeat for several cameras; omit for all"),
               tz: int = Query(0, ge=-840, le=840, description="viewer's UTC offset in minutes (east positive)"),
               ppe: list[str] | None = Query(None, description="only violations missing one of these items; repeat")) -> Scope:
        return _scope(start, end, camera, tz, ppe)

    def an(request: Request) -> Analytics:
        return Analytics(request.app.state.monitor.store)

    def names(request: Request) -> dict[str, str]:
        return {s.id: s.name for s in request.app.state.monitor.cfg.streams}

    @r.get("/summary")
    def summary(request: Request, sc: Scope = Depends(params)) -> dict[str, Any]:
        out = an(request).summary(sc, names(request))
        workers = list(request.app.state.monitor.workers.values())
        out["compliance_target"] = request.app.state.monitor.cfg.analytics.compliance_target
        out["cameras"] = {
            "configured": len(workers),
            "enabled": sum(w.cfg.enabled for w in workers),
            "running": sum(w.running for w in workers),
            "live": sum(w.status == "live" for w in workers),
        }
        return out

    @r.get("/timeseries")
    def timeseries(request: Request, sc: Scope = Depends(params), granularity: Granularity = "auto") -> dict[str, Any]:
        return an(request).timeseries(sc, granularity)

    @r.get("/by-camera")
    def by_camera(request: Request, sc: Scope = Depends(params)) -> list[dict[str, Any]]:
        return an(request).by_camera(sc, names(request))

    @r.get("/by-ppe-type")
    def by_ppe(request: Request, sc: Scope = Depends(params)) -> list[dict[str, Any]]:
        return an(request).by_ppe_type(sc)

    @r.get("/heatmap")
    def heatmap(request: Request, sc: Scope = Depends(params)) -> dict[str, Any]:
        return an(request).heatmap(sc)

    @r.get("/top-offenders")
    def top_offenders(request: Request, sc: Scope = Depends(params), limit: int = Query(10, ge=1, le=100)) -> list[dict[str, Any]]:
        return an(request).top_offenders(sc, limit, names(request))

    @r.get("/review-quality")
    def review_quality(request: Request, sc: Scope = Depends(params)) -> dict[str, Any]:
        return an(request).review_quality(sc)

    return r
