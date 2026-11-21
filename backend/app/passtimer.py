"""Where the detector's time goes.

Every model call is recorded under a name that says which model and input size ran, for example
``best_480_b32_fp16@480`` (the PPE model on full frames), ``best_480_b32_fp16@320`` (the same model on
person crops or the sharp evidence pass) and ``yolov8n_640_b32_fp16@640`` (the tiled person model). A summary
over the last minute shows how many calls and images per second each pass handles, the time per call, and each
pass's share of the total detector time. The System health page reads it, so the cost of every pass is measured
instead of estimated.

Also counts plain events, for example blank images added to fill a batch, and evidence re-checks that were
held back by the retry limit.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any

WINDOW_S = 60.0


class PassTimer:
    def __init__(self, window: float = WINDOW_S) -> None:
        self._window = window
        self._lock = threading.Lock()
        self._calls: dict[str, deque[tuple[float, float, int]]] = {}  # name -> (when, seconds, images)
        self._roles: dict[str, str] = {}
        self._events: dict[str, deque[tuple[float, int]]] = {}  # name -> (when, count)

    def record(self, name: str, seconds: float, images: int, role: str = "", now: float | None = None) -> None:
        t = time.monotonic() if now is None else now
        with self._lock:
            self._calls.setdefault(name, deque()).append((t, seconds, images))
            if role:
                self._roles[name] = role

    def count(self, name: str, n: int = 1, now: float | None = None) -> None:
        t = time.monotonic() if now is None else now
        with self._lock:
            self._events.setdefault(name, deque()).append((t, n))

    def reset(self) -> None:
        with self._lock:
            self._calls.clear()
            self._events.clear()

    def snapshot(self, now: float | None = None) -> dict[str, Any]:
        t = time.monotonic() if now is None else now
        cutoff = t - self._window
        with self._lock:
            for q in (*self._calls.values(), *self._events.values()):
                while q and q[0][0] < cutoff:
                    q.popleft()
            calls = {k: list(v) for k, v in self._calls.items() if v}
            events = {k: list(v) for k, v in self._events.items() if v}
            roles = dict(self._roles)
        total_busy = sum(s for rows in calls.values() for _, s, _ in rows) or 1e-9
        passes = []
        for name, rows in calls.items():
            span = max(1.0, min(self._window, t - rows[0][0]))
            busy = sum(s for _, s, _ in rows)
            images = sum(i for _, _, i in rows)
            passes.append({
                "name": name, "role": roles.get(name, ""),
                "calls_per_s": round(len(rows) / span, 2), "images_per_s": round(images / span, 1),
                "avg_ms_call": round(busy / len(rows) * 1000, 1),
                "avg_ms_image": round(busy / max(1, images) * 1000, 2),
                "share": round(busy / total_busy, 3),
            })
        passes.sort(key=lambda p: -p["share"])
        counters = []
        for name, rows in events.items():
            span = max(1.0, min(self._window, t - rows[0][0]))
            total = sum(n for _, n in rows)
            counters.append({"name": name, "per_s": round(total / span, 2), "total": total})
        counters.sort(key=lambda c: c["name"])
        return {"window_s": self._window, "passes": passes, "counters": counters}


passes = PassTimer()
