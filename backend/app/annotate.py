"""Frame annotation: per-person compliance boxes + PPE item boxes."""

from __future__ import annotations

import cv2
import numpy as np

from .ppe_logic import BEHAVIOR_ITEMS as _BEHAVIOR, ZONE_ITEMS, Detection, PersonCompliance

BEHAVIOR_ITEMS = _BEHAVIOR | ZONE_ITEMS  # captioned as-is (PHONE, RESTRICTED AREA), not as "NO <item>"

# BGR (OpenCV order). Match the UI palette (success #16A34A, danger #DC2626, warning #D97706),
# lifted slightly so they stay readable on dark video; every box also gets a dark outline.
GREEN = (74, 190, 34)
RED = (38, 38, 228)
AMBER = (6, 140, 235)
GREY = (190, 190, 190)
PURPLE = (219, 68, 147)  # behaviour detections (phone), distinct from PPE red/green
OUTLINE = (20, 20, 20)


def _box(img: np.ndarray, x1: int, y1: int, x2: int, y2: int, color: tuple[int, int, int], thick: int) -> None:
    """Colored rectangle on top of a slightly thicker dark one, so it reads on bright and dark video."""
    cv2.rectangle(img, (x1, y1), (x2, y2), OUTLINE, thick + 2)
    cv2.rectangle(img, (x1, y1), (x2, y2), color, thick)
STATUS_COLOR = {"compliant": GREEN, "non_compliant": RED, "unknown": AMBER}

SHORT = {"helmet": "helmet", "vest": "vest", "gloves": "gloves", "goggles": "goggles",
         "boots": "boots", "mask": "mask", "ear_protection": "ear"}
BEHAVIOR_SHORT = {"phone_use": "PHONE", "restricted_area": "RESTRICTED AREA"}


def violation_text(track_id: int, missing: list[str]) -> str:
    """Overlay caption for a non-compliant worker: 'NO helmet,vest' for PPE gaps, plus behaviour
    flags (e.g. PHONE) shown as-is rather than prefixed 'NO'."""
    ppe = [SHORT.get(m, m) for m in missing if m not in BEHAVIOR_ITEMS]
    beh = [BEHAVIOR_SHORT.get(m, m.upper()) for m in missing if m in BEHAVIOR_ITEMS]
    parts = []
    if ppe:
        parts.append("NO " + ",".join(ppe))
    parts.extend(beh)
    return f"#{track_id} " + " ".join(parts) if parts else f"#{track_id}"


def _label(img: np.ndarray, text: str, x: int, y: int, color: tuple[int, int, int], scale: float) -> None:
    font = cv2.FONT_HERSHEY_SIMPLEX
    th = max(1, round(scale * 2))
    (tw, tht), base = cv2.getTextSize(text, font, scale, th)
    y = max(tht + base + 2, y)
    x = min(max(0, x), max(0, img.shape[1] - tw - 6))
    cv2.rectangle(img, (x, y - tht - base - 4), (x + tw + 6, y), color, -1)
    cv2.putText(img, text, (x + 3, y - base - 1), font, scale, (255, 255, 255), th, cv2.LINE_AA)


def draw(img: np.ndarray, people: list[PersonCompliance], stray: list[Detection]) -> np.ndarray:
    """Draw in place and return img. `stray` = PPE detections not attached to any person."""
    h = img.shape[0]
    scale = max(0.4, min(0.8, h / 1100))
    thick = max(2, round(h / 360))

    for d in stray:
        x1, y1, x2, y2 = map(int, d.box)
        cv2.rectangle(img, (x1, y1), (x2, y2), GREY, 1)

    for p in people:
        if not p.monitored and p.status == "unknown":  # outside the monitored area: shown, not judged
            x1, y1, x2, y2 = map(int, p.box)
            cv2.rectangle(img, (x1, y1), (x2, y2), GREY, 1)
            continue
        color = STATUS_COLOR[p.status]
        for d in p.ppe:
            x1, y1, x2, y2 = map(int, d.box)
            c = PURPLE if d.cls == "phone" else RED if d.is_negative else GREEN
            _box(img, x1, y1, x2, y2, c, max(1, thick - 1))
            _label(img, d.cls.replace("_", "-"), x1, y1, c, scale * 0.75)

        x1, y1, x2, y2 = map(int, p.box)
        _box(img, x1, y1, x2, y2, color, thick)
        if p.status == "compliant":
            text = f"#{p.track_id} OK"
        elif p.status == "non_compliant":
            text = violation_text(p.track_id, p.missing)
        else:
            text = f"#{p.track_id} ?"
        _label(img, text, x1, y1, color, scale)
    return img


def violation_snapshot(full: np.ndarray, box: tuple[float, float, float, float], track_id: int, missing: list[str],
                       pad: float = 0.35, min_h: int = 360) -> np.ndarray:
    """Evidence image for a violation, cut from the *clean full-resolution* frame.

    Only the offending person is outlined and one caption is drawn at the snapshot's own
    scale, so the worker stays visible instead of being covered by the live overlay's labels.
    `box` is in full-frame pixel coordinates.
    """
    crop = crop_person(full, box, pad=pad, min_h=min_h).copy()
    H, W = full.shape[:2]
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    pad_px = pad * max(w, h * 0.6)
    ox, oy = max(0, int(x1 - pad_px)), max(0, int(y1 - pad * h))
    ex, ey = min(W, int(x2 + pad_px)), min(H, int(y2 + pad * h))
    if ex - ox < 8 or ey - oy < 8:
        return crop
    k = crop.shape[0] / (ey - oy)  # upscale factor applied by crop_person
    bx1, by1, bx2, by2 = (int((x1 - ox) * k), int((y1 - oy) * k), int((x2 - ox) * k), int((y2 - oy) * k))
    thick = max(2, round(crop.shape[0] / 180))
    _box(crop, bx1, by1, bx2, by2, RED, thick)
    text = violation_text(track_id, missing)
    scale = max(0.45, min(0.9, crop.shape[1] / 520))
    _label(crop, text, 0, crop.shape[0], RED, scale)  # caption along the bottom edge
    return crop


def crop_person(img: np.ndarray, box: tuple[float, float, float, float], pad: float = 0.3, min_h: int = 220) -> np.ndarray:
    """Crop a person with some context; small crops are upscaled so the snapshot is readable."""
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    pad_px = pad * max(w, h * 0.6)
    H, W = img.shape[:2]
    X1, Y1 = max(0, int(x1 - pad_px)), max(0, int(y1 - pad * h))
    X2, Y2 = min(W, int(x2 + pad_px)), min(H, int(y2 + pad * h))
    if X2 - X1 < 8 or Y2 - Y1 < 8:
        return img
    crop = img[Y1:Y2, X1:X2]
    if crop.shape[0] < min_h:
        f = min_h / crop.shape[0]
        crop = cv2.resize(crop, (round(crop.shape[1] * f), min_h), interpolation=cv2.INTER_CUBIC)
    return crop


def person_crop(full: np.ndarray, box: tuple[float, float, float, float], pad: float = 0.35) -> np.ndarray:
    """Clean (unannotated) full-resolution crop of one worker with some context - never upscaled."""
    return crop_person(full, box, pad=pad, min_h=0).copy()


def _fit_lines(text: str, width: int, scale: float, font: int, th: int) -> list[str]:
    """Word-wrap `text` (split on ' | ') so each line fits `width` px at `scale`."""
    parts, lines, cur = text.split(" | "), [], ""
    for part in parts:
        cand = f"{cur} | {part}" if cur else part
        if cur and cv2.getTextSize(cand, font, scale, th)[0][0] > width:
            lines.append(cur)
            cur = part
        else:
            cur = cand
    lines.append(cur)
    return lines


def evidence_image(full: np.ndarray, box: tuple[float, float, float, float], track_id: int, missing: list[str], *,
                   camera: str, when: str, person_conf: float | None = None,
                   item_conf: dict[str, float | None] | None = None) -> np.ndarray:
    """The primary evidence image of a violation: the outlined full-resolution crop of the worker
    (`violation_snapshot`) under an information header - camera, local time, track, and each violation
    with the confidence it was detected with ("not seen" = required PPE that was simply absent under
    the strict policy, which has no detection confidence of its own)."""
    snap = violation_snapshot(full, box, track_id, missing)
    w = snap.shape[1]
    font, scale = cv2.FONT_HERSHEY_SIMPLEX, max(0.42, min(0.6, w / 700))
    th = 1
    items = []
    for m in missing:
        name = BEHAVIOR_SHORT.get(m, m.upper()) if m in BEHAVIOR_ITEMS else "NO " + SHORT.get(m, m)
        c = (item_conf or {}).get(m)
        items.append(f"{name} {round(c * 100)}%" if c is not None else f"{name} (not seen)")
    head = f"{camera} | {when} | track #{track_id}" + (f" | person {round(person_conf * 100)}%" if person_conf is not None else "")
    head_lines = _fit_lines(head, w - 12, scale, font, th)
    item_lines = _fit_lines(" | ".join(items), w - 12, scale, font, th)
    (_, lh), base = cv2.getTextSize("Ag", font, scale, th)
    step = lh + base + 6
    band = np.full((step * (len(head_lines) + len(item_lines)) + 8, w, 3), 24, np.uint8)
    for i, (line, color) in enumerate([(ln, (255, 255, 255)) for ln in head_lines] + [(ln, (120, 120, 255)) for ln in item_lines]):
        cv2.putText(band, line, (6, 6 + lh + i * step), font, scale, color, th, cv2.LINE_AA)
    return np.vstack([band, snap])
