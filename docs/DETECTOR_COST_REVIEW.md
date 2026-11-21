# Detector cost review (21 Nov 2026)

A review of eight reported efficiency issues in the detection pipeline. Each one was checked against the code.
This page records the verdict for each one, what was changed, and the two options that trade accuracy for speed and are
off until someone turns them on.

## Result

| # | Reported issue | Verdict | Action |
|---|---|---|---|
| 1 | Persons detected twice (PPE model plus tiled COCO model) | Real, by design. The cost is the tile model, not the PPE model's person class | **Option added**: `model.person_tile_every` (off by default) |
| 2 | PPE model runs on the frame and again on person crops | Real, by design. The crop pass cut false "no helmet" alerts | Blank padding removed (see 6) |
| 3 | Person verification again at 640 px for evidence | Partly real. Once per violation, but it could repeat every frame | **Fixed**: retry limit |
| 4 | Several overlapping clean-up steps (NMS, dedupe, merge) | Real, negligible. 76 microseconds for 20 boxes | No change |
| 5 | Repeated image encoding | Not supported. Live JPEGs are cached per frame and width; evidence is encoded once per violation | No change |
| 6 | Extra GPU work from several passes | Real. The largest avoidable part was blank crops | **Fixed**: no padding outside the Intel GPU. Timers added |
| 7 | Higher latency to the violation decision | Mostly not. The decision waits for confirmation (6 frames, about 2 s at 3 fps); inference adds tens of milliseconds | **Measured now**: System health splits it into waiting and evidence time. The wait is a setting |
| 8 | Inference repeated on detections that are already reliable | Confirmed: no reuse in the per-frame path | **Option added**: `inference.refine_every` (off by default), plus the re-check limit |

## What was changed (always on)

- **No blank crops on NVIDIA and CPU** (`InferenceEngine._refine`). Crops were always padded to a multiple of
  `refine_batch` (8), so one worker meant one real crop and seven blank ones. Padding now happens only where the
  accelerator recompiles for each new shape (`intel:gpu`), the same rule the full-frame pass already used.
- **Evidence re-check limit** (`StreamWorker._verify_new_items`). When an ongoing violation gains a new missing item
  that the sharp check cannot confirm, the check repeats at most every 3 s (`VERIFY_RETRY_SECONDS`). It used to run a
  640 px model call on every frame.
- **Per-pass timers** (`passtimer.py`, System health, "Where detector time goes"). Every model call is recorded by
  model and input size. Before this, only the total was reported, so none of the costs in this review were measured.

## The two options that trade accuracy for speed

Both are off by default (value 1), so the pipeline behaves as before until someone turns them on.

- `model.person_tile_every: N`. The tiled person model (about 35 GFLOPs per frame, the largest single pass) runs on
  every Nth frame of each camera. In between, its last result is reused, at most 3 s old. Cost: person boxes up to
  N-1 frames out of date on the frames in between. The PPE model still runs on every frame.
- `inference.refine_every: N`. Each worker gets the sharp crop pass on every Nth frame. In between, the last crop result
  is moved with the worker, as long as it is in the same place (IoU at least 0.6) and at most 3 s old. Cost: helmet
  and vest boxes up to N-1 frames old, so a change in equipment is seen up to N-1 frames later.

## How to decide whether to turn them on

1. Deploy, open System health and read **Where detector time goes** for a normal shift. Note the share of each pass.
2. Turn one option on for the plant with N = 2 and compare, on the same recording, the workers found and the alerts
   raised against N = 1. The "crop results reused" counter and the pass shares show what was saved.
3. Keep it only if worker counts and alerts match. Otherwise set it back to 1.
4. The existing settings still apply: `model.person_tiles: 1` and `model.person_imgsz: 480` for a cheaper tile pass,
   `inference.refine_max_persons` and `inference.person_refine` for the crop pass.

The decision delay is mostly `alerts.min_violation_frames`. System health now shows the measured wait and the
evidence time per violation, so the effect of changing it can be seen.
