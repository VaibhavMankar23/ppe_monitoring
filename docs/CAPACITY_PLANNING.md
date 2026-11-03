# Capacity planning: 30-45 cameras

How many cameras one server can check, what was measured, and how to size the plant server.
Numbers marked **measured** come from the development laptop on 28-29 Oct 2026; **estimate**
numbers still need confirming on the real server with the capacity planner.

## 1. What limits the number of cameras

Two costs grow with every camera:

1. **Detection:** one model pass per analysed frame (480 px), plus one extra pass per worker in
   view (the 320 px person crop that checks the helmet and vest up close, up to 6 per frame).
2. **Decoding:** H.264/H.265 frames depend on each other, so every frame the camera sends must be
   decoded, even the ones never analysed. A 1080p camera at 25 fps costs CPU whether detection
   runs at 2 fps or 25.

The app runs everything in one process: one capture thread per camera, one detection thread that
batches up to 8 cameras per model call, and a pool of worker threads for tracking, PPE rules and
saving. The model and the decoders run in C/C++ libraries that use every core.

## 2. Measured on the development laptop

Intel Core i5-1335U (10 cores / 12 threads), 15 GB RAM, no NVIDIA GPU, OpenVINO on the CPU.

| What | Result |
|---|---|
| Model, one full frame at 480 px (idle CPU) | ~40 ms (~36 ms per frame in batches of 4) |
| Model, one person crop at 320 px | ~30 ms |
| Full app, 6 cameras, nothing else running | 156 ms detector time per frame, 6.4 frames/s in total, **0.7 fps per camera**, detector 100% busy, CPU 71% |
| Full app, 3 cameras, main app also running (UAT run) | 1.1-1.2 fps per camera |
| Decoding 1080p H.265, convert + resize every frame (before 28 Oct) | 56 frames per CPU-second |
| Decoding, convert only frames that will be analysed (after 28 Oct) | 83 frames per CPU-second (about 33% less CPU) |

**Conclusion:** this laptop handles about 2 cameras at 2 fps with headroom, and saturates at
about 6 cameras. It is a development machine, not a plant server.

**Person detector (on by default since 29 Oct 2026):** finding workers with a COCO person model on
2x2 tiles adds about 3x to the detector time per frame on a CPU (measured 69 -> 286 ms on the i5
laptop). It is what makes far and bent-over workers visible at all, so plan with it on; on a GPU a
nano model on 4 tiles costs little. The capacity planner measures it automatically.

## 3. What 30 and 45 cameras need

Rule of thumb: frames per second needed = cameras x detection rate per camera, plus about 2 crops
per frame when two workers are in view on average.

| Detection rate | 30 cameras | 45 cameras | Fits on |
|---|---|---|---|
| 1 fps | 30 frames/s + ~60 crops | 45 frames/s + ~90 crops | one GPU (estimate) |
| **2 fps (recommended)** | 60 + ~120 | 90 + ~180 (~270 model passes/s) | one mid-range GPU (estimate) |
| 3 fps (default limit) | 90 + ~180 | 135 + ~270 (~400/s) | one mid-range GPU, little headroom (estimate) |
| 10 fps | 300 + ~600 | 450 + ~900 | one strong GPU with TensorRT (estimate) |
| 30 fps | not useful (see section 5) | ~4000/s | several GPUs and servers (the app cannot split cameras across servers yet) |

**Decoding 45 main streams** (1080p, 25 fps) = 1125 frames/s / 83 per core = **about 14 CPU cores**
just for video. With the cameras' **sub-stream** (about 720p or D1 at 10-15 fps) this drops by
roughly 5-10x, to 2-3 cores. Use sub-streams.

## 4. Recommended plant server (estimate)

| Part | Recommendation | Why |
|---|---|---|
| GPU | One NVIDIA card in the RTX 4070 / RTX A4000 / L4 class | ~270-400 model passes/s needed at 2-3 fps; the app uses CUDA automatically |
| CPU | 16+ cores | Decoding 45 streams, tracking and saving |
| RAM | 32 GB | 45 capture buffers, model, database |
| Disk | SSD, 200+ GB, encrypted | Evidence photos for the retention period |
| Cameras | Sub-stream, 10-15 fps | Decoding cost |
| Build | `TORCH_INDEX=cu124`, GPU section of `docker-compose.yml` enabled | See [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Runtime | TensorRT FP16 engine (built automatically on first start) and batches of 16 frames / 8 crops (automatic on NVIDIA) | About 2-3x PyTorch (estimate); no settings to change |

Before buying, borrow or rent one GPU machine and measure with the planner (section 6).

## 5. Why not 30 fps detection

- **Cost:** about 10x the GPU work of 3 fps, for 45 cameras several GPUs and multi-server support
  the app does not have. Your NVR records at 25 fps anyway.
- **Accuracy gets worse, not better:** the alert rules count *frames* (`alerts.min_violation_frames`,
  `compliance.smoothing_window`). At 3 fps a worker must be unsafe for about 1.5-2 s before an alert;
  at 30 fps the same rule fires after 0.2 s, so a helmet hidden for a moment behind a coil would
  alert. Higher rates also need these rules retuned.
- **What helps instead:** a higher rate only where people move fast (gates, entries), and smooth
  live video, if wanted, as a separate feature that streams the raw video with the last boxes drawn
  on top, at almost no detection cost.

How rates work today: there is one limit for all cameras, `inference.max_fps_per_stream`.
`priority: high` does **not** raise a camera's rate; it only serves that camera first when the
detector is busy. `priority: low` runs a camera at one third of the limit. So "5 fps at the gates,
under 2 fps elsewhere" is: limit 5, gates `high`, quiet cameras `low` (5 / 3 = 1.7 fps).

Decision (28 Oct 2026): default limit 3 fps per camera (`inference.max_fps_per_stream: 3`) and plan
capacity at 2 fps. Use the limit-5 recipe above only after the planner shows the headroom.

## 6. How to measure on the real server

1. **Capacity planner** (Setup > System health): measures the detector's real cost per frame on
   the running server, then shows how many cameras fit at 1, 2, 3 or 5 fps and whether 30 and 45
   fit, with 30% headroom. Decoding is not counted separately; watch Host CPU next to it.
2. **Add cameras in steps of 5**, watch System health for an hour at each step: every camera at
   2 fps or more, detector below 70% busy, latency under 2 s, no reconnects.
3. **Load test without the UI:**

   ```bash
   cd backend
   python scripts/load_test.py --counts 10 20 30 45 --seconds 60 --json load.json
   ```

   It repeats the configured cameras to reach each count and prints per-camera throughput,
   latency and engine load.
4. Record the result in UAT cases PERF-01 and PERF-02.

## 7. If one server is not enough

In order of cost:

1. Lower the rate of quiet cameras (`priority: low` = one third of the limit; `high` only means served first).
2. Turn off the person-crop pass on cameras where workers are close and large (`inference.person_refine`).
3. Check TensorRT is in use: the startup log says `model best_480_b32_fp16.engine on cuda:0` (on by default, `model.tensorrt`).
4. A second server with half the cameras. Today that means two separate installs with two
   dashboards; one shared dashboard over several detection servers is a feature to build only if
   step 2 of section 6 shows it is needed.
