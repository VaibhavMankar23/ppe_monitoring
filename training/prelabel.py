"""Pre-label images with the deployed PPE model so annotators correct boxes instead of drawing them.

    python training/prelabel.py datasets/plant_ppe/eval [--conf 0.25] [--overwrite]

Writes YOLO txt files to <set>/labels/ using the model's own class ids (see <set>/data.yaml), plus
classes.txt for labelling tools. Like the live pipeline, the PPE model runs on the full frame and
on 2x2 overlapping tiles (small, far-away workers), and the COCO person model adds Person boxes on
the tiles; boxes are merged per class. Only the classes the monitor uses are kept.

Pre-labels are a starting point, not ground truth: every image must be checked by a person,
especially for missed workers, before it is used to measure accuracy.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch
from torchvision.ops import nms
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
KEEP = {0, 1, 2, 3, 4, 5, 7}  # Hardhat Mask NO-Hardhat NO-Mask NO-Safety-Vest Person Safety-Vest
PERSON = 5
COCO_PERSON = 0


def tiles(w: int, h: int, n: int = 2, overlap: float = 0.2) -> list[tuple[int, int, int, int]]:
    tw, th = int(w / (n - (n - 1) * overlap)), int(h / (n - (n - 1) * overlap))
    xs = np.linspace(0, w - tw, n).astype(int)
    ys = np.linspace(0, h - th, n).astype(int)
    return [(x, y, x + tw, y + th) for y in ys for x in xs]


def run(model: YOLO, img: np.ndarray, imgsz: int, conf: float, classes: list[int] | None,
        regions: list[tuple[int, int, int, int]]) -> list[tuple[int, float, np.ndarray]]:
    crops = [img[y0:y1, x0:x1] for x0, y0, x1, y1 in regions]
    out = []
    for (x0, y0, _, _), r in zip(regions, model.predict(crops, imgsz=imgsz, conf=conf, classes=classes,
                                                        verbose=False)):
        b = r.boxes
        for c, s, xyxy in zip(b.cls.tolist(), b.conf.tolist(), b.xyxy.cpu().numpy()):
            out.append((int(c), s, xyxy + [x0, y0, x0, y0]))
    return out


def merge(dets: list[tuple[int, float, np.ndarray]], iou: float = 0.5) -> list[tuple[int, float, np.ndarray]]:
    kept = []
    for c in {d[0] for d in dets}:
        ds = [d for d in dets if d[0] == c]
        boxes = torch.tensor(np.array([d[2] for d in ds]), dtype=torch.float32)
        scores = torch.tensor([d[1] for d in ds])
        kept += [ds[i] for i in nms(boxes, scores, iou).tolist()]
    return kept


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("set", help="dataset folder with images/")
    ap.add_argument("--weights", default=str(ROOT / "models/safesight/best.pt"))
    ap.add_argument("--person-weights", default=str(ROOT / "models/coco/yolov8n.pt"))
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=640, help="PPE model input size per pass")
    ap.add_argument("--overwrite", action="store_true", help="replace existing label files")
    a = ap.parse_args()

    ds = Path(a.set)
    imgs = sorted(p for p in (ds / "images").iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    lab = ds / "labels"
    lab.mkdir(exist_ok=True)
    ppe, coco = YOLO(a.weights), YOLO(a.person_weights)
    names = ppe.names
    (lab / "classes.txt").write_text("\n".join(names[i] for i in range(len(names))) + "\n")

    counts = {names[c]: 0 for c in sorted(KEEP)}
    done = skipped = 0
    for n, p in enumerate(imgs, 1):
        txt = lab / f"{p.stem}.txt"
        if txt.exists() and not a.overwrite:
            skipped += 1  # never clobber an annotator's corrections
            continue
        img = cv2.imread(str(p))
        h, w = img.shape[:2]
        full, tl = [(0, 0, w, h)], tiles(w, h)
        dets = run(ppe, img, a.imgsz, a.conf, sorted(KEEP), full + tl)
        dets += [(PERSON, s, b) for _, s, b in run(coco, img, 640, max(a.conf, 0.3), [COCO_PERSON], tl)]
        lines = []
        for c, s, (x0, y0, x1, y1) in merge(dets):
            x0, x1 = np.clip([x0, x1], 0, w)
            y0, y1 = np.clip([y0, y1], 0, h)
            if x1 - x0 < 4 or y1 - y0 < 4:
                continue
            lines.append(f"{c} {(x0 + x1) / 2 / w:.6f} {(y0 + y1) / 2 / h:.6f} {(x1 - x0) / w:.6f} {(y1 - y0) / h:.6f}")
            counts[names[c]] += 1
        txt.write_text("\n".join(lines) + ("\n" if lines else ""))
        done += 1
        if n % 50 == 0:
            print(f"{n}/{len(imgs)}", flush=True)
    print(json.dumps({"images": len(imgs), "labelled": done, "skipped_existing": skipped, "boxes": counts}))


if __name__ == "__main__":
    main()
