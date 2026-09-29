"""Per-person PPE association and compliance evaluation.

Pure-Python, dependency free, deterministic: this is the unit-tested core.

Each PPE detection is assigned to at most one person. The assignment score is the
fraction of the PPE box that falls inside the *body region* where that item is
expected (head for helmet/goggles/mask, torso for vest, hands zone for gloves, feet
for boots). Regions are expressed as fractions of the person box and may extend
slightly beyond it (a helmet often sticks out above the person box).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Literal

Box = tuple[float, float, float, float]  # x1, y1, x2, y2 (pixels)
ItemStatus = Literal["present", "missing", "unknown"]
PersonStatus = Literal["compliant", "non_compliant", "unknown"]

PPE_ITEMS: frozenset[str] = frozenset(
    {"helmet", "vest", "gloves", "goggles", "boots", "mask", "ear_protection"}
)
# Behavioural items: unlike PPE (violation = item *missing*), these are violations when the
# thing *is present* near a worker. `phone_use` fires on a phone detected in a worker's hands/
# face zone. The detection class that raises each one is in BEHAVIOR_CLASS.
BEHAVIOR_ITEMS: frozenset[str] = frozenset({"phone_use"})
BEHAVIOR_CLASS: dict[str, str] = {"phone_use": "phone"}  # behaviour item -> detection class
NEGATIVE_PREFIX = "no_"

# item -> (x1, y1, x2, y2) as fractions of the person box.
# PPE items map to the body part where they belong; behaviour classes (e.g. "phone") map to the
# zone the object must fall in to count as "used by" that worker (hands + face, extended sideways).
BODY_REGIONS: dict[str, tuple[float, float, float, float]] = {
    "helmet": (-0.10, -0.15, 1.10, 0.30),
    "goggles": (-0.05, -0.05, 1.05, 0.32),
    "mask": (-0.05, -0.05, 1.05, 0.35),
    "ear_protection": (-0.10, -0.10, 1.10, 0.32),
    "vest": (-0.05, 0.12, 1.05, 0.78),
    "gloves": (-0.30, 0.20, 1.30, 1.00),
    "boots": (-0.10, 0.70, 1.10, 1.08),
    "phone": (-0.35, -0.10, 1.35, 0.85),
}


@dataclass(frozen=True)
class Detection:
    cls: str  # canonical class: person, helmet, no_helmet, ...
    conf: float
    box: Box

    @property
    def item(self) -> str:
        """PPE item this detection speaks about (helmet for both helmet and no_helmet)."""
        return self.cls[len(NEGATIVE_PREFIX):] if self.is_negative else self.cls

    @property
    def is_negative(self) -> bool:
        return self.cls.startswith(NEGATIVE_PREFIX)


@dataclass
class TrackedPerson:
    track_id: int
    box: Box
    conf: float


@dataclass
class PersonCompliance:
    track_id: int
    box: Box
    conf: float
    status: PersonStatus
    items: dict[str, ItemStatus]
    ppe: list[Detection] = field(default_factory=list)

    @property
    def missing(self) -> list[str]:
        return [k for k, v in self.items.items() if v == "missing"]


# ---------------------------------------------------------------- geometry

def area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def intersection(a: Box, b: Box) -> float:
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def iou(a: Box, b: Box) -> float:
    inter = intersection(a, b)
    union = area(a) + area(b) - inter
    return inter / union if union > 0 else 0.0


def containment(inner: Box, outer: Box) -> float:
    """Fraction of `inner` that lies inside `outer`."""
    a = area(inner)
    return intersection(inner, outer) / a if a > 0 else 0.0


def body_region(person: Box, item: str) -> Box:
    fx1, fy1, fx2, fy2 = BODY_REGIONS[item]
    x1, y1, x2, y2 = person
    w, h = x2 - x1, y2 - y1
    return (x1 + fx1 * w, y1 + fy1 * h, x1 + fx2 * w, y1 + fy2 * h)


def _center(b: Box) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


# ---------------------------------------------------------------- association

def associate(
    persons: list[TrackedPerson],
    ppe: list[Detection],
    min_containment: float = 0.35,
) -> list[list[Detection]]:
    """Assign each PPE detection to the best-matching person (or none).

    Returns a list parallel to `persons` holding the detections assigned to each.
    """
    assigned: list[list[Detection]] = [[] for _ in persons]
    for det in ppe:
        if det.item not in BODY_REGIONS:
            continue
        best_idx, best_key = -1, (min_containment, float("-inf"))
        cx, cy = _center(det.box)
        for idx, p in enumerate(persons):
            region = body_region(p.box, det.item)
            score = containment(det.box, region)
            if score < min_containment:
                continue
            rx, ry = _center(region)
            # Prefer higher containment; break near-ties by distance to the region centre
            # (normalised by person height) so overlapping workers don't steal each other's PPE.
            ph = max(1.0, p.box[3] - p.box[1])
            dist = ((cx - rx) ** 2 + (cy - ry) ** 2) ** 0.5 / ph
            key = (round(score, 2), -dist)
            if key > best_key:
                best_idx, best_key = idx, key
        if best_idx >= 0:
            assigned[best_idx].append(det)
    return assigned


def region_visible(person: Box, item: str, frame_size: tuple[int, int] | None, edge_margin: float = 2.0) -> bool:
    """False when the body part for `item` is (probably) outside the frame.

    A person box touching the bottom frame edge is assumed cut off, so feet items can't be
    judged; likewise head items when the box touches the top edge.
    """
    if frame_size is None:
        return True
    w, h = frame_size
    fx1, fy1, fx2, fy2 = BODY_REGIONS[item]
    if fy1 >= 0.5 and person[3] >= h - edge_margin:
        return False
    if fy2 <= 0.5 and person[1] <= edge_margin:
        return False
    return containment(body_region(person, item), (0, 0, w, h)) >= 0.5


def detectable_items(classes: "list[str] | frozenset[str] | set[str]") -> set[str]:
    """PPE items the loaded model can actually judge, from its class names.

    A model that has no class for an item (e.g. `gloves`, with neither `gloves` nor `no_gloves`)
    can never see it, so that item must not be counted as "missing" for everyone. `helmet` counts
    as detectable if the model has either `helmet` or `no_helmet`.
    """
    items: set[str] = set()
    for c in classes:
        item = c[len(NEGATIVE_PREFIX):] if c.startswith(NEGATIVE_PREFIX) else c
        if item in PPE_ITEMS:
            items.add(item)
    return items


def unchecked(classes: "list[str] | frozenset[str] | set[str]", required: list[str], behaviors: list[str]) -> list[str]:
    """Configured checks a model with these classes can't perform: required PPE it has no class for,
    and behaviours (phone use) without their detection class (no phone model loaded)."""
    ok = detectable_items(classes)
    return [i for i in required if i not in ok] + [b for b in behaviors if BEHAVIOR_CLASS[b] not in classes]


def evaluate_items(
    person: Box,
    detections: list[Detection],
    required: list[str],
    missing_policy: Literal["strict", "negative_only"] = "strict",
    frame_size: tuple[int, int] | None = None,
    detectable: set[str] | None = None,
) -> dict[str, ItemStatus]:
    """Decide present / missing / unknown for every required item of one person.

    `detectable` (when given) is the set of items the model can actually detect; a required item
    outside it is skipped entirely — the model has no class for it, so it can't be "missing"."""
    result: dict[str, ItemStatus] = {}
    for item in required:
        if detectable is not None and item not in detectable:
            continue  # model can't detect this item at all -> uncheckable, never a violation
        pos = max((d.conf for d in detections if d.item == item and not d.is_negative), default=0.0)
        neg = max((d.conf for d in detections if d.item == item and d.is_negative), default=0.0)
        if pos > 0 and pos >= neg:
            result[item] = "present"
        elif neg > 0:
            result[item] = "missing"
        elif missing_policy == "strict" and region_visible(person, item, frame_size):
            result[item] = "missing"
        else:
            result[item] = "unknown"  # body part out of frame, or policy only trusts negative classes
    return result


def overall_status(items: dict[str, ItemStatus]) -> PersonStatus:
    values = items.values()
    if any(v == "missing" for v in values):
        return "non_compliant"
    if any(v == "unknown" for v in values):
        return "unknown"
    return "compliant"


def behavior_status(detections: list[Detection], item: str) -> ItemStatus:
    """Status of a behavioural item for one worker (present = OK / no offence, missing = offence).

    Behaviour items invert PPE logic: the offence is a detection being *there*. `phone_use` is
    "missing" (an offence) when a phone falls in the worker's hands/face zone, "present" otherwise.
    Reusing the present/missing vocabulary keeps smoothing, status and alerting identical to PPE."""
    cls = BEHAVIOR_CLASS[item]
    return "missing" if any(d.cls == cls for d in detections) else "present"


def evaluate_frame(
    persons: list[TrackedPerson],
    ppe: list[Detection],
    required: list[str],
    *,
    behaviors: list[str] | None = None,
    missing_policy: Literal["strict", "negative_only"] = "strict",
    min_containment: float = 0.35,
    min_person_height: float = 0.0,
    frame_size: tuple[int, int] | None = None,
    detectable: set[str] | None = None,
) -> list[PersonCompliance]:
    """Associate PPE (and any behaviour classes) to persons and evaluate compliance for one frame.

    `required` are PPE items; `behaviors` are behavioural items (e.g. "phone_use") monitored for
    this camera. `detectable` limits PPE judgement to items the model can detect (see
    `evaluate_items`); behaviours are judged directly from the associated detections."""
    behaviors = behaviors or []
    out: list[PersonCompliance] = []
    for p, dets in zip(persons, associate(persons, ppe, min_containment)):
        too_small = p.box[3] - p.box[1] < min_person_height
        if too_small:
            items: dict[str, ItemStatus] = {i: "unknown" for i in required}
        else:
            items = evaluate_items(p.box, dets, required, missing_policy, frame_size, detectable)
            if not items and required:
                # every required item is undetectable by this model -> we can't judge this worker
                items = {i: "unknown" for i in required}
        for b in behaviors:
            items[b] = "unknown" if too_small else behavior_status(dets, b)
        out.append(PersonCompliance(p.track_id, p.box, p.conf, overall_status(items), items, dets))
    return out


# ---------------------------------------------------------------- person-crop refinement

def crop_region(person: Box, frame_w: int, frame_h: int, pad_x: float = 0.25, pad_top: float = 0.15, pad_bottom: float = 0.05) -> tuple[int, int, int, int]:
    """Integer crop around a person, padded so helmets/gloves that stick out are included."""
    x1, y1, x2, y2 = person
    w, h = x2 - x1, y2 - y1
    return (
        max(0, int(x1 - pad_x * w)),
        max(0, int(y1 - pad_top * h)),
        min(frame_w, int(x2 + pad_x * w)),
        min(frame_h, int(y2 + pad_bottom * h)),
    )


def dedupe(dets: list[Detection], iou_thr: float = 0.5) -> list[Detection]:
    """Per-class NMS: drop a detection overlapping a higher-confidence one of the same class."""
    kept: list[Detection] = []
    for d in sorted(dets, key=lambda d: -d.conf):
        if all(k.cls != d.cls or iou(k.box, d.box) < iou_thr for k in kept):
            kept.append(d)
    return kept


def match_person(coarse: Detection, crop_persons: list[Detection], min_iou: float = 0.4) -> Detection | None:
    """The crop detection that is the same worker as `coarse` (best IoU >= min_iou), or None."""
    best = max(crop_persons, key=lambda d: iou(d.box, coarse.box), default=None)
    return best if best is not None and iou(best.box, coarse.box) >= min_iou else None


def refine_person_box(coarse: Detection, crop_persons: list[Detection], min_iou: float = 0.4) -> Detection:
    """Replace a full-frame person box with the same person re-detected on its full-resolution crop.

    The full-frame pass sees a distant worker at a few dozen pixels, so its box is only accurate to
    roughly +/-5 % of the person's height - visible as a loose / shifted box once the evidence
    snapshot zooms in. The crop pass sees the same worker 4-6x larger. The crop detection that
    overlaps the coarse box best is taken (a crop can contain a neighbour too); if none overlaps
    enough, the coarse box is kept.
    """
    best = match_person(coarse, crop_persons, min_iou)
    return coarse if best is None else Detection(coarse.cls, max(coarse.conf, best.conf), best.box)


def merge_refined(first_pass: list[Detection], refined_persons: list[Box], crop_ppe: list[Detection]) -> list[Detection]:
    """Combine full-frame PPE detections with the (more reliable) person-crop ones.

    For people that were refined, the crop pass is authoritative: first-pass *PPE* boxes whose
    centre lies inside a refined person's box are replaced by the crop detections. Behaviour
    classes (e.g. phone) are only produced by the full-frame pass, so they are always kept.
    """
    def inside_refined(d: Detection) -> bool:
        cx, cy = _center(d.box)
        return any(p[0] <= cx <= p[2] and p[1] <= cy <= p[3] for p in refined_persons)

    kept = [d for d in first_pass if d.item not in PPE_ITEMS or not inside_refined(d)]
    return kept + dedupe(crop_ppe)


# ---------------------------------------------------------------- temporal smoothing

class ComplianceSmoother:
    """Per-track majority vote over the last N observations to stop status flicker."""

    def __init__(self, window: int = 6) -> None:
        self.window = max(1, window)
        self._hist: dict[int, dict[str, deque[ItemStatus]]] = {}

    def update(self, track_id: int, items: dict[str, ItemStatus]) -> dict[str, ItemStatus]:
        hist = self._hist.setdefault(track_id, {})
        smoothed: dict[str, ItemStatus] = {}
        for item, status in items.items():
            q = hist.setdefault(item, deque(maxlen=self.window))
            q.append(status)
            present, missing = q.count("present"), q.count("missing")
            if present == 0 and missing == 0:
                smoothed[item] = "unknown"
            elif missing > present:
                smoothed[item] = "missing"
            else:
                smoothed[item] = "present"
        return smoothed

    def apply(self, people: list[PersonCompliance]) -> list[PersonCompliance]:
        for p in people:
            p.items = self.update(p.track_id, p.items)
            p.status = overall_status(p.items)
        return people

    def prune(self, alive: set[int]) -> None:
        for tid in list(self._hist):
            if tid not in alive:
                del self._hist[tid]
