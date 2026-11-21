# Detector cost review (21 Nov 2026)

A review of eight reported efficiency issues in the detection pipeline. Each one was checked against the code.
This page records the verdict, what was changed, and what is deliberately left alone until it is measured.

## Result

| # | Reported issue | Verdict | Action |
|---|---|---|---|
| 1 | Persons detected twice (PPE model plus tiled COCO model) | Real, by design. The cost is the tile model, not the PPE model's person class | Not changed. Measure first (below) |
| 2 | PPE model runs on the frame and again on person crops | Real, by design. The crop pass cut false "no helmet" alerts | Blank padding removed (see 6) |
| 3 | Person verification again at 640 px for evidence | Partly real. Once per violation, but it could repeat every frame | **Fixed**: retry limit |
| 4 | Several overlapping clean-up steps (NMS, dedupe, merge) | Real, negligible. 76 microseconds for 20 boxes | No change |
| 5 | Repeated image encoding | Not supported. Live JPEGs are cached per frame and width; evidence is encoded once per violation | No change |
| 6 | Extra GPU work from several passes | Real. The largest avoidable part was blank crops | **Fixed**: no padding outside the Intel GPU. Timers added |
| 7 | Higher latency to the violation decision | Mostly not. The decision waits for confirmation (6 frames, about 2 s at 3 fps); inference adds tens of milliseconds | No code change. A setting, see below |
| 8 | Inference repeated on detections that are already reliable | Confirmed: no reuse in the per-frame path | Partly fixed (re-check limit). Rest needs measurement |

## What was changed

- **No blank crops on NVIDIA and CPU** (`InferenceEngine._refine`). Crops were always padded to a multiple of
  `refine_batch` (8), so one worker meant one real crop and seven blank ones. Padding now happens only where the
  accelerator recompiles for each new shape (`intel:gpu`), the same rule the full-frame pass already used.
- **Evidence re-check limit** (`StreamWorker._verify_new_items`). When an ongoing violation gains a new missing item
  that the sharp check cannot confirm, the check repeats at most every 3 s (`VERIFY_RETRY_SECONDS`). It used to run a
  640 px model call on every frame.
- **Per-pass timers** (`passtimer.py`, System health, "Where detector time goes"). Every model call is recorded by
  model and input size. Before this, only the total was reported, so none of the costs in this review were measured.

## What was not changed, and why

**The tile person model (issues 1, 6, 8).** It is the most expensive single pass, about 35 GFLOPs per frame against about
12 for the PPE model (estimates from published Ultralytics figures, not measured here). It is also what makes
detection work on these cameras: the code records that the PPE model found about 1 of 20 workers, and the tiled model
about 20 of 20. Removing or thinning it without measurement would trade cost for missed workers.

**Reuse of reliable detections (issue 8).** Crop refinement runs in the engine thread, before tracking, so it has no
per-person history to skip on. Skipping compliant, steadily tracked workers would also reduce how fast a new
violation is noticed. It needs a design, and numbers to justify it.

**Confirmation delay (issue 7).** `alerts.min_violation_frames: 6` is about 2 s at 3 fps. Lowering it shortens the
decision time and raises false alarms. That is a plant decision, not a code defect.

## How to decide the rest

1. Deploy, open System health and read **Where detector time goes** for a normal shift. Note the share of each pass.
2. If the tile pass (`yolov8n_...@640`) is the largest share, try these settings one at a time on a few cameras
   and compare worker counts and alerts against a recording: `model.person_tiles: 1`, then `model.person_imgsz: 480`.
   Both are existing settings, no code change.
3. For the crop pass: `inference.refine_max_persons` (default 6) and `inference.person_refine`.
4. Only if one pass dominates and its settings do not help, design per-track reuse for that pass.
