# PPE Compliance Monitor: Project Walkthrough

> A teaching guide to everything in this repository. It assumes you know basic programming
> and are new to computer vision (CV) and AI. Every technical term is defined the first time it
> appears, and the [Glossary](#9-glossary) repeats all of them.
>
> Code references use `file → function()`. Line numbers (`file:line`) are given only for files
> that didn't change in the latest update (`sources.py`, `tracker.py`, `ppe_logic.py`); other files
> are referenced by function name.
>
> **Latest update (2026-09-21):** the app now has three pages (Dashboard, **Violations**, **Config**)
> and a white professional theme. The in-memory violation log side panel was **removed**. Violations
> are stored in **SQLite** and browsed on their own page, and `config.yaml` can be **edited from the
> UI with validation, backups and hot reload**. Sections 2.8, 2.13, 3.6, 3.8, 3.9, 4, 7, 8 and 11 were
> rewritten for it, and [Section 12](#12-update-config-page-violations-page-database) explains the new
> parts in depth. 84 unit tests pass.
>
> **Update (2026-09-22): sign-in, roles, audit log, analytics.** Every page and API route now
> requires a signed-in user with one of two roles (Admin, Super Admin). There's a Users page, an
> audit log and an Analytics page. [Section 13](#13-update-sign-in-roles-audit-log-analytics)
> explains all of it. **The default account is `admin` / `mahindra123` and must be changed at
> first sign-in. Change it before anyone else can reach the app.** 129 unit tests pass.
>
> **Update (2026-09-22, later): evidence boxes, any camera, many cameras, analytics v2.** Snapshot boxes
> now come from an alert-time full-resolution re-detection ([§14](#14-fix-bounding-boxes-that-didnt-hug-the-worker-on-snapshots)
> has the measured root cause). Cameras of any kind are added from the UI with a connection test and
> encrypted credentials ([§15](#15-update-any-camera-added-from-the-ui-file-rtsp-http)). The pipeline,
> dashboard and a System health page scale to 12+ cameras, with load-test numbers
> ([§16](#16-update-scaling-to-1012-cameras)). Analytics was rebuilt so each chart answers one question
> ([§17](#17-update-the-analytics-page-chart-by-chart)). 168 unit tests pass.

---

## Table of contents

1. [Big picture](#1-big-picture)
2. [Everything you see in the UI](#2-everything-you-see-in-the-ui)
3. [Backend, file by file](#3-backend-file-by-file)
4. [Frontend, file by file](#4-frontend-file-by-file)
5. [The AI part, simplified](#5-the-ai-part-simplified)
6. [Performance](#6-performance)
7. [Run, test, deploy](#7-run-test-deploy)
8. [How to modify it](#8-how-to-modify-it)
9. [Glossary](#9-glossary)
10. [Quiz](#10-quiz)
11. [Issues found](#11-issues-found)
12. [Update: Config page, Violations page, database](#12-update-config-page-violations-page-database)
13. [Update: sign-in, roles, audit log, analytics](#13-update-sign-in-roles-audit-log-analytics)
14. [Fix: bounding boxes that didn't hug the worker on snapshots](#14-fix-bounding-boxes-that-didnt-hug-the-worker-on-snapshots)
15. [Update: any camera, added from the UI (file, RTSP, HTTP)](#15-update-any-camera-added-from-the-ui-file-rtsp-http)
16. [Update: scaling to 10-12+ cameras](#16-update-scaling-to-1012-cameras)
17. [Update: the Analytics page, chart by chart](#17-update-the-analytics-page-chart-by-chart)

---

## 1. Big picture

### 1.1 What the app does, in 5 lines

1. It plays **4 camera recordings** (your NVR `.cpv` files) as if they were live cameras, in a 2×2 grid in the browser.
2. On every frame it runs an **AI object detector** (YOLO) that finds people and safety gear (helmet, vest, gloves, …) and also the *absence* of gear ("no-helmet").
3. It **matches each piece of gear to a person**: a helmet counts only if it is on that person's head, a vest only if it is on their torso.
4. It **follows each person over time** (gives them an ID like `#7`), so it knows "this is the same worker as a second ago".
5. When a worker is missing required gear for long enough, it **raises one alert** with a photo snapshot in the side panel. It doesn't raise one alert per frame.

### 1.2 Architecture diagram

```mermaid
flowchart LR
    subgraph Disk["videos/ (disk)"]
        V1["NVR_...cpv<br/>(raw H.265, 1920x1080, 20 fps)"]
    end

    subgraph Backend["Python backend (one process)"]
        direction LR
        G["FrameGrabber thread<br/>sources.py<br/>(one per camera)"]
        E["InferenceEngine thread<br/>pipeline.py<br/>(one, shared)"]
        D["YoloDetector<br/>detector.py<br/>(OpenVINO on Intel iGPU)"]
        W["StreamWorker thread<br/>pipeline.py → _process()<br/>(one per camera)"]
        T["ByteTracker<br/>tracker.py"]
        P["PPE logic<br/>ppe_logic.py"]
        A["AlertDebouncer (violations.py)<br/>+ ViolationStore → SQLite (violations_db.py)"]
        R["draw()<br/>annotate.py"]
        API["FastAPI<br/>api.py"]
    end

    subgraph Browser["React UI (frontend/)"]
        UM["state/monitor.tsx<br/>(MonitorProvider: WebSocket)"]
        VV["VideoView.tsx<br/>&lt;img&gt; MJPEG"]
        UI["Dashboard · Violations · Config pages"]
    end

    V1 -->|"cv2.VideoCapture.read()"| G
    G -->|"latest Frame only"| E
    E -->|"batch of frames"| D
    D -->|"Detection list"| E
    E -->|"1-slot mailbox"| W
    W --> T --> P --> R
    P --> A
    R -->|"JPEG bytes"| API
    W -->|"metadata dict"| API
    A -->|"violation event"| API
    API -->|"MJPEG over HTTP<br/>/api/streams/{id}/mjpeg"| VV
    API -->|"WebSocket /ws<br/>stats 4x/s + violations"| UM
    UM --> UI
    VV --> UI
    UI -->|"REST: /api/config, /api/violations"| API
    API -->|"ConfigStore: validate, backup, atomic write<br/>→ Monitor.apply_config (hot reload)"| W
```

**Why this shape?**

- Reading video and running AI run at *different speeds*. The video runs at 20 frames per second, while the AI manages maybe 5 per second on this laptop. Separate threads with "keep only the newest frame" hand-offs let the slow part skip frames instead of falling behind.
- **One shared AI engine** means one model loaded in memory. It can also process frames from several cameras in one call ("batching"), which is cheaper than four separate calls.
- **Video goes over MJPEG and numbers go over WebSocket.** These are two channels, each good at its job (details in [§3.9](#39-apipy-the-web-server)).

*Thread*: an independent line of execution inside one program. Threads run "at the same time" and share memory.

### 1.3 Life of one frame: from the video file to pixels on screen

Follow one frame, say frame 1,234 of `NVR_ch20_main_20260915110010_...cpv` on **Camera 1**.

```mermaid
sequenceDiagram
    autonumber
    participant F as .cpv file
    participant G as FrameGrabber (grab-cam1 thread)
    participant E as InferenceEngine (infer-batched thread)
    participant Y as YoloDetector (OpenVINO iGPU)
    participant S as StreamWorker (post-cam1 thread)
    participant H as FastAPI (event loop)
    participant B as Browser

    F->>G: cap.read() decodes H.265 → 1920x1080 image
    G->>G: _resize() → 960x540, store Frame(seq=1234) in _latest (overwrites 1233)
    E->>G: ready()? take() → Frame 1234
    E->>Y: predict([frame], conf) at 480 px
    Y-->>E: persons + PPE boxes
    E->>Y: _refine(): predict(person crops) at 320 px
    Y-->>E: PPE boxes on crops → mapped back
    E->>S: submit() into 1-slot mailbox
    S->>S: tracker.update → evaluate_frame → smoother.apply
    S->>S: draw() boxes, debouncer.update (maybe alert), cv2.imencode JPEG
    H->>S: jpeg() sees new out_seq
    H-->>B: MJPEG part (multipart HTTP)
    H-->>B: WebSocket "stats" (every 250 ms)
    B->>B: <img> shows JPEG; React re-renders counters
```

Step by step, with the exact code:

| # | What happens | Where |
|---|---|---|
| 1 | The grab thread opens the file with OpenCV. | `sources.py → FrameGrabber._run()` calls `open_capture()` (`sources.py:97`), which calls `cv2.VideoCapture(cfg.uri)` |
| 2 | One frame is decoded (H.265 → a 1920×1080 array of pixels). | `sources.py:211` `ok, img = cap.read()` |
| 3 | The frame is shrunk to 960 px wide for speed. The original is kept too. | `sources.py:215` `small = self._resize(img)` |
| 4 | It becomes the camera's "latest frame", **overwriting** the previous one. | `sources.py:217-219` `self._latest = Frame(small, self._seq, now, None if small is img else img)` |
| 5 | The grab thread sleeps so playback runs at real speed (20 fps → 50 ms per frame). | `sources.py:227-233` |
| 6 | The inference thread asks each camera "do you have a new frame and are you free?" | `pipeline.py` `batch = [w for w in self.workers if w.ready(now)]` → `StreamWorker.ready()` (`pipeline.py`) |
| 7 | It takes the newest frame from every ready camera. | `pipeline.py` → `StreamWorker.take()` (`pipeline.py`) |
| 8 | **Pass 1**: YOLO runs on the whole frames (all ready cameras in one batch). | `pipeline.py` → `YoloDetector.predict()` (`detector.py`) |
| 9 | **Pass 2 (refine)**: every detected person is cropped from the *full-resolution* frame and YOLO runs again on the crops. | `pipeline.py` → `InferenceEngine._refine()` (`pipeline.py`) |
| 10 | The results go into that camera's 1-slot mailbox. | `pipeline.py` → `StreamWorker.submit()` (`pipeline.py`) |
| 11 | The camera's post-processing thread wakes up. | `StreamWorker._post_loop()` (`pipeline.py`) → `_process()` (`pipeline.py`) |
| 12 | The tracker assigns stable IDs to people. | `pipeline.py` → `ByteTracker.update()` (`tracker.py:96`) |
| 13 | Gear is matched to people and each person is judged. | `pipeline.py` → `evaluate_frame()` (`ppe_logic.py:193`) |
| 14 | The verdicts are smoothed over the last 6 frames to stop flicker. | `pipeline.py` → `ComplianceSmoother.apply()` (`ppe_logic.py:275`) |
| 15 | Boxes and labels are drawn on a copy of the frame. | `pipeline.py` → `draw()` (`annotate.py`) |
| 16 | The debouncer decides whether this is a *new* alert; if so, a snapshot is saved to the log. | `pipeline.py` → `AlertDebouncer.update()` (`violations.py`) → `ViolationLog.add()` (`violations.py`) |
| 17 | The frame is compressed to JPEG and stored as the camera's "latest output". | `pipeline.py` |
| 18 | The numbers (FPS, counts, people) are stored in `_meta`. | `pipeline.py` |
| 19 | The MJPEG endpoint notices the new JPEG and sends it to the browser. | `api.py` (`mjpeg() → gen()`) |
| 20 | Every 250 ms, the WebSocket sends all cameras' numbers. | `api.py` (`stats_loop`) → `Monitor.snapshot()` (`pipeline.py`) |
| 21 | The browser's `<img>` paints the JPEG, and React updates the counters. | `components/camera/VideoView.tsx`; `state/monitor.tsx` (`ws.onmessage` → `setStreams`) → components re-render |

Typical total time from step 2 to step 17 on this laptop is **~130–150 ms** ("latency", see [§6](#6-performance)).

---

## 2. Everything you see in the UI

The app shell is `frontend/src/App.tsx` (sidebar + current page). The dashboard is `pages/DashboardPage.tsx`, and the Violations and Config pages are covered in §2.8 and §12. Here is every dashboard element and where its data comes from.

**How data reaches the screen (applies to almost everything below):**
The backend's `StreamWorker.snapshot()` (`pipeline.py`) builds one dictionary per camera, and `Monitor.snapshot()` (`pipeline.py`) wraps all four. `stats_loop` in `api.py` sends that dictionary over the WebSocket **every 0.25 s** (`STATS_INTERVAL`, `api.py`). In the browser, `state/monitor.tsx` (`ws.onmessage`) stores it in React state, and every component reading it re-renders. So unless stated otherwise, **numbers update 4 times per second**.

### 2.1 The 2×2 grid and each tile

| | |
|---|---|
| What | Four boxes ("tiles"), one per camera |
| Drawn by | `pages/DashboardPage.tsx`: a CSS grid `md:grid-cols-2` that renders one `<CameraTile>` per stream |
| Data | `streams` array from the WebSocket (`useMonitor`) |
| Backend source | `config.yaml → streams:` (`config.yaml`) creates one `StreamWorker` each (`pipeline.py`) |
| Why a grid of independent tiles | Each tile is its own component with its own video connection. One camera failing only changes that tile's state. |

On narrow screens (below Tailwind's `md` breakpoint, 768 px) the grid becomes one column.

A tile gets a **red glowing border** when any worker in it is non-compliant right now (`components/camera/CameraTile.tsx`: `alarm = s.running && s.violations > 0`).

### 2.2 Camera title and live/status badge

| | |
|---|---|
| Title | `s.name` from config (`"Camera 1"`) → `components/camera/CameraTile.tsx` |
| Badge | `<StatusBadge status={s.status}>` (`components/ui/`) |
| Backend source | `StreamWorker.status` property (`pipeline.py`) |

The badge shows one of 7 states:

| Badge | Meaning | Set by |
|---|---|---|
| **LIVE** (green, pulsing) | Frames are arriving | `sources.py:220` after each successful read |
| **CONNECTING** | Opening the source for the first time | `sources.py:167` |
| **RECONNECTING** | The source failed; retrying with growing waits (2 s, 4 s, … up to 30 s) | `sources.py:171-174`, `199-201` |
| **NO SIGNAL** | The video file doesn't exist; re-checked every 2 s | `sources.py:161-164` |
| **STALLED** | Frames arrive, but no processed output for 5 s | `pipeline.py` (`STALL_SECONDS = 5.0`, line 35) |
| **ERROR** | Processing or inference threw an exception in the last 5 s | `pipeline.py`, set by `set_error()` |
| **STOPPED** | You pressed Stop | `pipeline.py` |

The colors come from the `STATUS` table in `components/ui/`.

### 2.3 FPS and inference latency numbers (top-right of each tile)

`components/camera/CameraTile.tsx` shows `FPS 5.2` and `inf 104ms`.

*FPS (frames per second)*: how many frames were fully processed per second.
*Inference latency*: how long the AI model took for the batch that contained this frame.

**How FPS is measured** (`pipeline.py`):

```python
@property
def fps(self) -> float:
    t = self._proc_times                                    # deque of the last 60 finish-times
    if len(t) < 2 or time.monotonic() - t[-1] > 2.0:        # nothing finished for 2 s → show 0
        return 0.0
    return (len(t) - 1) / (t[-1] - t[0])                    # N-1 intervals / time span
```

- Line 1: `_proc_times` gets a timestamp appended every time `_process()` finishes a frame (`pipeline.py`). It holds at most 60 (`deque(maxlen=60)`).
- Line 2: if the last frame finished more than 2 s ago, report 0 (a frozen camera shouldn't show an old FPS).
- Line 3: 60 timestamps have 59 gaps; divide by the time between first and last. At 5 fps this averages over ~12 s, so it is smooth but reacts slowly.

This is the **processed** FPS, which is lower than the video's own 20 FPS on purpose. Frames the AI can't keep up with are skipped (see [§3.10](#310-threading-and-async-design)).

**How inference latency is measured** (`pipeline.py`): a stopwatch (`time.perf_counter()`) around `detector.predict(...)` **plus** `_refine(...)`. Several cameras are processed in one batch, so all cameras in that batch show the **same** number. The detail view says "batch of N".

### 2.4 Worker count and violation count (tile counters)

`components/camera/CameraTile.tsx` shows three counters. Their backend source is `pipeline.py`:

```python
"workers": len(people),
"compliant": sum(p["status"] == "compliant" for p in people),
"violations": sum(p["status"] == "non_compliant" for p in people),
```

- `people` = the people in the **most recently processed frame** (after tracking and smoothing).
- A person appears only once the tracker has seen them in **2 consecutive processed frames** (`min_hits=2`, `tracker.py:77`). This filters one-frame false detections.
- **Workers** = everyone tracked. **Compliant** = all required items present. **Violations** = at least one required item missing.
- People whose status is **unknown** (too small/far, or body part out of frame) count in *Workers* but in neither of the other two. They're drawn in amber with a `?`.

"Violations" on the tile is **right now**, not a history. The history is the violation log.

### 2.5 Bounding boxes and labels on the video

*Bounding box*: a rectangle `(x1, y1, x2, y2)` around a detected object.

The boxes are **burned into the video image on the server** by OpenCV in `annotate.py → draw()` (`annotate.py`). The browser just shows a picture; it doesn't draw boxes itself.

| What you see | Meaning | Code |
|---|---|---|
| **Thick green box**, label `#7 OK` | Person #7 has every required item | `annotate.py`, color `GREEN` (line 11) |
| **Thick red box**, label `#7 NO helmet,vest` | Person #7 is missing the listed items | `annotate.py`, `RED` (line 12) |
| **Thick amber box**, label `#7 ?` | Can't judge (too small, or body part outside the frame) | `annotate.py`, `AMBER` (line 13) |
| **Thin green box** with a small label like `helmet`, `vest`, `boots` | A piece of gear detected and attached to that person | `annotate.py` (`c = RED if d.is_negative else GREEN`) |
| **Thin red box**, label `no-vest`, `no-gloves` | The model positively saw the *absence* of gear (a "negative class") | same lines |
| **Thin grey box**, no label | Gear that wasn't attached to anyone (e.g. a helmet on a shelf) | `annotate.py` |

Colors are written as **BGR** (blue, green, red), not RGB, because OpenCV uses that order. `RED = (40, 40, 230)` means blue=40, green=40, red=230.

**Confidence score:** the model gives every box a confidence (0–1). It's used for filtering (see the slider, [§2.10](#210-confidence-threshold-slider)), but **isn't printed on the labels**. See Issues Found #8.

### 2.6 Per-person compliance status and the missing list

Where it's decided: `ppe_logic.py → evaluate_items()` (line 161) and `overall_status()` (line 184), then smoothed by `ComplianceSmoother` (line 253).

Where you see it:

- On the video, in the label text (`#12 NO helmet,vest`).
- In the **detail view** "Workers in view" panel (`components/camera/DetailView.tsx`). Each worker gets a colored dot, **COMPLIANT / NON-COMPLIANT / UNCERTAIN**, and one chip per required item: ✓ present (green), ✗ missing (red), ? unknown (grey). Chip colors: `components/ui/ Chip()`.

The data comes from `people[].items` in the WebSocket message (`pipeline.py`).

The full logic, with numbers, is in [§3.4](#34-ppe_logicpy-matching-gear-to-people).

### 2.7 Tracking IDs on people (`#7`)

*Track ID*: a number the tracker gives each person so the program knows it's the same person in the next frame.

- Created in `tracker.py:122`: `_Track(next(self._ids), ...)`, where `self._ids = itertools.count(1)` (line 85) is a counter 1, 2, 3, ….
- **Per camera.** Camera 1 and Camera 2 each have their own #1.
- **Reset to 1 when you press Stop** (`pipeline.py` → `tracker.reset()`).
- If a person is hidden for more than 2 s (`max_lost_seconds`), they get a new ID when they reappear.

**Why IDs matter:** without them, a worker without a helmet standing in view for 30 s at 5 fps would produce 150 alerts. With IDs we can say "person #7 was already reported".

### 2.8 Violations page (replaces the old side-panel log)

The live side panel is gone. Every alert is now **stored permanently** and browsed on the
**Violations** page (`#/violations`, `pages/ViolationsPage.tsx`).

| On screen | Source |
|---|---|
| Sticky day headers "Today", "Yesterday", "21 Sep 2026" | `lib/format.ts → dayKey()` / `dayLabel()` group items by the **browser's local date** |
| Card: thumbnail, time, camera · `#track`, red missing-PPE chips | one row of `GET /api/violations` (thumbnail is base64 JPEG) |
| Filters: From / To dates, Camera, Missing PPE, Clear | converted to epoch bounds by `dateRangeToEpoch()` and sent as `start`, `end`, `camera`, `ppe` |
| Infinite scroll | an `IntersectionObserver` "sentinel" asks for the next page with `before_id` (keyset pagination) |
| New cards appearing on top with a red flash | the `violation` WebSocket event, if it matches the current filters |
| Popup viewer | `components/violations/ViolationModal.tsx`: fetches `GET /api/violations/{id}` (full-size base64), ‹ › arrows and ← → keys, Esc, Download, Delete |
| Export CSV (top bar) | `GET /api/violations/export?` with the same filters |

**Life of an alert now:**

```mermaid
flowchart LR
    A["StreamWorker._process()"] --> B["AlertDebouncer.update()<br/>violations.py"]
    B -->|"new alert"| C["StreamWorker._record_violation()<br/>clean full-res snapshot + thumbnail"]
    C --> D["ViolationStore.add()<br/>violations_db.py → SQLite row"]
    D --> E["subscriber on_violation()<br/>api.py"]
    E --> F["WebSocket message<br/>type: violation (+ thumbnail)"]
    F --> G["MonitorProvider → onViolation listeners"]
    G --> H["Violations page: prepend card"]
    G --> I["Top bar: violations today + 1"]
    G --> J["Detail view: latest violations"]
```

The **dedupe rules are unchanged**: 6 consecutive bad frames, a 30 s cooldown per worker and
missing-set, the subset rule, and the ID-switch hand-off. All are now editable on the Config page
(Violations section). The **snapshot** is cut from the clean full-resolution frame by
`annotate.py → violation_snapshot()`. It draws one outline and a caption, so the worker isn't
hidden under the live overlay's labels.

### 2.9 Start/Stop buttons

`components/camera/StreamControls.tsx` shows ■ when running and ▶ when stopped.

What happens on **Stop**:

1. The browser sends `POST /api/streams/cam1/stop` (`api.ts`).
2. `api.py` runs `StreamWorker.stop()` in a helper thread (`asyncio.to_thread`) so the web server doesn't freeze while threads shut down.
3. `StreamWorker.stop()` (`pipeline.py`) sets `running = False`, which makes `ready()` return False so the engine skips this camera. It then wakes and joins the post-processing thread, stops the grab thread (`FrameGrabber.stop()`, which releases the video file), and resets the tracker (IDs start at 1 again) and the debouncer.
4. The REST response (the new snapshot) is merged into React state straight away by `patchStream` (`state/monitor.tsx`), so the button flips without waiting for the next WebSocket tick.
5. `VideoView` sees `running=false`, sets the `<img>` src to a blank GIF (closing the MJPEG connection), and shows "Stream stopped".

**Start** reverses this: `StreamWorker.start()` (`pipeline.py`) starts the grab thread and the post thread. For a file, playback starts from the beginning again.

### 2.10 Confidence threshold slider

*Confidence*: the model's own estimate (0 to 1) that a box is correct. 0.35 means "35% sure".

`components/camera/StreamControls.tsx`, range 0.05–0.95, default 0.35 (`model.default_confidence`, `config.yaml`).

**What happens when you move it:**

1. The number next to the slider updates immediately (local React state).
2. After you stop dragging for **150 ms** (debounce, `components/camera/StreamControls.tsx`), it sends `PATCH /api/streams/cam1/settings {"confidence": 0.5}`.
3. `api.py` validates the value (must be 0.05–0.95, checked by `StreamSettings` at `api.py`, otherwise HTTP 422) and sets `worker.confidence = 0.5`.
4. From the **next processed frame**:
   - **Gear boxes** below 0.5 are ignored: `pipeline.py` `ppe = [d for d in dets if d.cls != "person" and d.conf >= conf]`.
   - **People**: the tracker's first stage only *starts* tracks for people ≥ 0.5 (`pipeline.py` passes `high_thresh=conf`). Weaker detections (down to 0.15) can still *continue* an existing track (tracker stage 2).
   - The crop pass only refines people ≥ 0.5 (`pipeline.py`).
   - The "Detections" histogram only counts boxes ≥ 0.5 (`pipeline.py`).
5. The model itself always runs with threshold `min(0.15, all cameras' sliders)` (`pipeline.py`). So the slider **filters results but doesn't make the AI faster**.

**Higher** means fewer false boxes but more missed gear, so more "missing" verdicts. **Lower** means the opposite.

### 2.11 Toggle boxes on/off

The box icon button (`components/camera/StreamControls.tsx`) sends `PATCH …/settings {"show_boxes": false}`.

In `_process()`:

```python
annotated = draw(frame.image.copy(), people, stray)       # pipeline.py – always drawn
shown = annotated if self.show_boxes else frame.image     # pipeline.py – choose what to stream
```

- Line 1: the boxes are **always** drawn, because violation snapshots need them.
- Line 2: only the *streamed* picture changes. Detection, tracking and alerts keep running.

### 2.12 Fullscreen expanded view

Click a tile's video (or its ⤢ button) and `DashboardPage` sets `expanded = "cam1"`, then renders `<DetailView>` in a large modal. Press **Esc** (`components/camera/DetailView.tsx`) or ✕ to close.

While expanded, the **grid tile stops its own video** and shows "Open in detail view" (`components/camera/CameraTile.tsx`). Browsers allow only about 6 simultaneous connections per server, and each MJPEG video holds one open. This keeps the total at 4.

The detail view shows:

| Widget | Meaning | Source |
|---|---|---|
| Header: name, badge, `file · 960×540` | source type and processing resolution | `components/camera/DetailView.tsx`; `frame_size` from `pipeline.py` |
| Controls | same `StreamControls` as the tile, full labels | line 38 |
| **Processed FPS** (green if ≥ 5, amber otherwise) | see §2.3 | line 50 |
| **Capture FPS** + "source 20" | how fast frames are *read* vs. the file's native rate | line 51; `FrameGrabber.capture_fps` counted every 1 s (`sources.py:222-225`), `native_fps` from config `fps: 20` |
| **Inference** + "batch of N" | model time for the batch; N = cameras in that batch | line 52 |
| **Latency** "capture → annotated" | time from frame read to JPEG ready: `now - frame.ts` (`pipeline.py`). Excludes network and browser time. | line 53 |
| Workers / Compliant / Violating | §2.4 | lines 54-56 |
| **Alerts** + "N frames" | alerts from this camera since the server started, and frames processed | line 57; `vlog.per_stream`, `frames_processed` |
| Required PPE chips | from config | lines 62-68 |
| Workers in view | per-person item status (§2.6), non-compliant sorted first | lines 70-96, sort at line 26 |
| Detections (current frame) | a bar per class in the last frame (person, helmet, no_vest, …). Negatives are red, person is blue, gear is green. | lines 98-113; `class_counts` from `pipeline.py` |
| Recent alerts | up to 12 snapshots for this camera | lines 115-125 |

### 2.13 Other things on screen

| Element | What / where |
|---|---|
| **Sidebar** (`components/layout/Sidebar.tsx`) | logo; Dashboard / Violations / Config links (active item highlighted in blue with a left bar); a red badge on Violations with today's count; the model device at the bottom. At tablet width it collapses to a 64 px icon rail. |
| **Top bar** (`components/layout/Topbar.tsx`) | page title + subtitle; **system status** badge ("System online · 4/4 live", or red "Backend offline, reconnecting"); **"N violations today"** badge linking to the Violations page; a live **clock** |
| Dashboard subtitle | "N workers in view · M currently non-compliant" (sum over running cameras) |
| Required-PPE chips on each tile | the camera's `required_ppe` (`PpeChip` in `components/ui/Badge.tsx`) |
| Video overlay text | "No signal", "Connecting…", "Stream stopped", "Waiting for frames…" (`VideoView`) |
| Toasts (bottom right) | results of actions: saved, restarted cameras, errors (`components/ui/Toast.tsx`) |

The old header KPIs (workers / compliant / compliance % / alerts) and the violation log panel were
removed from the dashboard, as the update requested.

## 3. Backend, file by file

Folder `backend/`:

```
backend/
├── run.py                 entry point: starts the web server
├── config.yaml            all settings
├── requirements.txt       Python packages
├── app/
│   ├── config.py          loads + validates config.yaml
│   ├── sources.py         video input (files, RTSP, webcam, image folders)
│   ├── detector.py        the AI model wrapper
│   ├── tracker.py         gives people stable IDs
│   ├── ppe_logic.py       matches gear to people, decides compliance
│   ├── violations.py      alert rules + alert log
│   ├── annotate.py        draws boxes on frames
│   ├── pipeline.py        wires everything together with threads
│   └── api.py             web server: REST, MJPEG, WebSocket
├── scripts/headless_check.py   run the pipeline without the web server, print FPS
└── tests/                 42 unit tests
```

How the files depend on each other (an arrow means "imports"):

```mermaid
flowchart TD
    run[run.py] --> api[api.py]
    run --> config[config.py]
    api --> pipeline[pipeline.py]
    api --> config
    pipeline --> sources[sources.py]
    pipeline --> detector[detector.py]
    pipeline --> tracker[tracker.py]
    pipeline --> ppe[ppe_logic.py]
    pipeline --> violations[violations.py]
    pipeline --> annotate[annotate.py]
    sources --> config
    detector --> config
    detector --> ppe
    tracker --> ppe
    violations --> ppe
    annotate --> ppe
    config --> ppe
```

`ppe_logic.py` sits at the bottom with **no** dependencies at all (not even NumPy). That's deliberate: the most important rules are pure functions that are easy to test.

### 3.1 `run.py`: entry point

```python
cfg = load_config(args.config)       # run.py – read + validate config.yaml
app = create_app(cfg)                # run.py – build the FastAPI app (api.py)
uvicorn.run(app, host=cfg.server.host, port=cfg.server.port, ...)   # run.py – serve HTTP
```

- `--config other.yaml` uses another config file; `--log-level DEBUG` gives more detail.
- *uvicorn*: the program that actually listens on port 8000 and passes requests to FastAPI.
- Ctrl+C makes uvicorn run FastAPI's shutdown code (`api.py`), which stops every thread cleanly.

`start.bat` (repo root) just runs `run.py` with the right Python.

### 3.2 `sources.py`: the video source layer

**Purpose:** turn "a video file / camera address" into "the newest frame, always available", without ever building up a backlog.

**Key pieces:**

| Name | Line | Job |
|---|---|---|
| `Frame` | 29 | a data record: `image` (960 px), `seq` (a counter), `ts` (capture time), `full` (original resolution) |
| `open_capture()` | 97 | picks how to open a source from `type:` |
| `FrameGrabber` | 117 | owns one background thread per camera |
| `FrameGrabber._run()` | 156 | open → read → reconnect loop |
| `FrameGrabber._read_loop()` | 203 | reads frames, stores the latest, paces playback |
| `ImageFolderCapture` | 44 | pretends a folder of photos is a video (used for testing) |

**Inputs:** a `SourceConfig` (`type`, `uri`, `fps`, …). **Outputs:** `FrameGrabber.latest()` returns the newest `Frame`, plus `state`, `capture_fps` and `native_fps` for the UI.

**How "keep only the latest" works** (`sources.py:217-219`):

```python
with self._lock:                  # a lock: only one thread may touch _latest at a time
    self._seq += 1                # every frame gets the next number
    self._latest = Frame(small, self._seq, now, None if small is img else img)   # OVERWRITE
```

There is no queue. If nobody picked up frame 1233 before 1234 arrived, 1233 is simply gone. That's why the display never lags: the AI always works on the newest picture.

**How looping works** (`sources.py:191-198`). Your `.cpv` files are raw H.265 streams with no index, so we can't "seek to frame 0". Instead, when `cap.read()` fails after delivering frames, the file is closed and **reopened immediately**:

```python
if _is_recorded(self.cfg) and self.cfg.loop and frames > 0:
    rewinding = True    # remember not to show "reconnecting" in the UI
    continue            # back to the top of the while-loop → open_capture() again
```

We measured this: the loop is seamless, with no gap in frame numbers.

**Pacing** (`sources.py:227-233`). A file can be read much faster than real time, so after each frame the thread waits until `next_t` (the frame's scheduled time, 50 ms apart at 20 fps). If it falls behind by more than 0.5 s it resets the schedule, so it skips ahead instead of lagging. Live cameras (RTSP) aren't paced: they deliver in real time already, and we drain them as fast as possible so the newest frame is always fresh.

**Reconnect with backoff** (`sources.py:169-175`). If opening fails, wait `delay` seconds, then double it (2 → 4 → 8 … max 30 s). This avoids hammering a dead camera.

**Swapping in RTSP or a webcam** is config-only (`open_capture()`, lines 100-108):

```yaml
source: { type: rtsp,   uri: "rtsp://user:pass@10.0.0.12:554/stream1" }   # IP camera
source: { type: webcam, uri: "0" }                                        # first USB camera
```

- `rtsp`/`http` are opened through FFmpeg, using TCP transport (more reliable than UDP over Wi-Fi), with a 1-frame buffer.
- Passwords are hidden in logs by `_safe_uri()` (`sources.py:242`).

**About your `.cpv` files.** They start with a 1 KB `ADIT` header, followed by raw H.265 data with small `CPAV` headers between frames. OpenCV's FFmpeg recognises the H.265 inside and skips the junk, which is why you may see harmless `[hevc @ …]` lines in the log. The file doesn't record its frame rate, so we counted it: 71,994 frames in 1 hour = **20.00 fps**. That's why `config.yaml` sets `fps: 20`; FFmpeg would otherwise guess 25 and play 25% too fast.

### 3.3 `detector.py`: the AI model wrapper

**Purpose:** load the YOLO model on the best available hardware and turn its raw output into simple `Detection(cls, conf, box)` records with **our** class names.

| Name | Line | Job |
|---|---|---|
| `ALIASES` | 26 | a table of the many names datasets use (`Hard_hat`, `hardhat`, `NO-Hardhat`) → our canonical names (`helmet`, `no_helmet`) |
| `build_class_table()` | 47 | model class number → canonical name (config `class_map` first, then `ALIASES`) |
| `Detector` (Protocol) | 57 | the "shape" any detector must have: a `predict()` method. Swap in another AI library by writing a class with the same method. |
| `select_backend()` | 101 | chooses the hardware |
| `openvino_model_path()` | 74 | converts the model to OpenVINO format once and caches it |
| `YoloDetector` | 129 | the real implementation |
| `YoloDetector.predict()` | 165 | run the model on a list of images |

**Model used:** `models/safesight/best.pt`. It's a YOLOv8-small model fine-tuned by its author on ~13,000 construction-site images for 60 epochs (training rounds); mAP50 ≈ 0.76, per `models/safesight/README.md`. It came from Hugging Face and was already in your `models/` folder along with 6 others.

**Why this model?** Of the 7 checkpoints in `models/`, it's the only one with all 7 PPE items **and** a "no-X" class for each:

| Raw class (model) | Our name | Used? |
|---|---|---|
| Worker | person | ✓ |
| Hard_hat / No-Helmet | helmet / no_helmet | ✓ |
| Vest / No-Vest | vest / no_vest | ✓ |
| Glove / No-Glove | gloves / no_gloves | ✓ |
| Glass / No-Glass | goggles / no_goggles | ✓ |
| Boots / No-Boots | boots / no_boots | ✓ |
| Mask / No-Mask | mask / no_mask | ✓ |
| Ear-Protection / No-Ear-Protection | ear_protection / … | ✓ |
| Circular_Saw, Fire_Extinguisher, Fire_prevention_Net, Welding_Equipment | – | ignored (not in `class_map`, so filtered out: `classes=self._keep`, `detector.py`) |

**GPU/CPU handling** (`select_backend()`, lines 101-126). The order of preference for `device: auto`:

1. **NVIDIA GPU (CUDA)** if PyTorch sees one, using `model.imgsz`.
2. Otherwise **OpenVINO on an Intel integrated GPU**. This laptop has an Iris Xe, so this is what runs.
3. Otherwise **OpenVINO on the CPU**, at the smaller `cpu_imgsz`.
4. Otherwise **plain PyTorch on the CPU**.

*OpenVINO*: Intel's toolkit that runs AI models fast on Intel CPUs and integrated GPUs. The `.pt` file is converted once into `models/safesight/best_480_openvino_model/` (`openvino_model_path()`), and later runs reuse it. We measured OpenVINO iGPU at **~33 images/s** vs PyTorch CPU **~12 images/s** at 640 px, roughly 3× faster.

**Batching.** `predict()` takes a **list** of images and runs them in one model call. The engine passes the newest frame of every ready camera together. This is cheaper than separate calls because fixed per-call costs are shared.

**Thread safety.** `self._lock` (line 148) makes sure only one thread uses the model at a time.

**Two model instances** (`_model` and `_crop_model`, lines 144-147) use the same weights. One handles full frames (480 px) and the other person crops (320 px), so neither has to reconfigure for a different image size on every call.

### 3.4 `ppe_logic.py`: matching gear to people

**Purpose:** given people boxes and gear boxes, decide for each person which required items are present, missing or unknown. It's pure Python, easy to test, and has 25 of the 42 tests.

**Data types** (lines 39-73): `Detection` (one model box), `TrackedPerson` (a person with an ID), `PersonCompliance` (the verdict for one person).

**Geometry helpers** (lines 78-106):

| Function | Formula | Plain words |
|---|---|---|
| `area(b)` | width × height | size of a box |
| `intersection(a, b)` | area of the overlapping rectangle | how much two boxes overlap |
| `iou(a, b)` | overlap ÷ (area A + area B − overlap) | *IoU (Intersection over Union)*: 1 = identical boxes, 0 = no overlap |
| `containment(inner, outer)` | overlap ÷ area(inner) | "what fraction of the small box is inside the big one" |
| `body_region(person, item)` | see below | where on a person an item should be |

**Why containment and not IoU?** A helmet is tiny compared to a person. Even a perfectly placed helmet has a very low IoU with the person box (say 0.03). Containment asks the right question: "is this helmet *inside* the head area?"

**Body regions** (`BODY_REGIONS`, lines 28-36) are given as fractions of the person box. `(x1, y1, x2, y2)` with 0 = left/top edge and 1 = right/bottom edge:

| Item | Region | Why |
|---|---|---|
| helmet | (-0.10, **-0.15**, 1.10, **0.30**) | top 30% of the body, extended **above** the box (helmets stick out) and 10% to the sides |
| goggles | (-0.05, -0.05, 1.05, 0.32) | face |
| mask | (-0.05, -0.05, 1.05, 0.35) | face |
| ear_protection | (-0.10, -0.10, 1.10, 0.32) | sides of the head |
| vest | (-0.05, **0.12**, 1.05, **0.78**) | torso |
| gloves | (**-0.30**, 0.20, **1.30**, 1.00) | hands swing outside the body box |
| boots | (-0.10, **0.70**, 1.10, **1.08**) | feet, a bit below the box |

#### Worked numeric example

A worker stands at **person box = (100, 100, 200, 400)**, so width `w = 100` and height `h = 300`.

**Step 1: compute the helmet region** with `body_region()` (line 98):

```
x1 = 100 + (-0.10)(100) =  90
y1 = 100 + (-0.15)(300) =  55
x2 = 100 + ( 1.10)(100) = 210
y2 = 100 + ( 0.30)(300) = 190
helmet region = (90, 55, 210, 190)
```

**Step 2: a helmet is detected at (125, 90, 175, 130).**

- area = 50 × 40 = 2000
- overlap with the region = the whole helmet (it's entirely inside) = 2000
- **containment = 2000 / 2000 = 1.0** ≥ 0.35 (`min_containment`), so it's **assigned** to this person.

**Step 3: a second "helmet" at (130, 170, 170, 250)**, held at chest height.

- area = 40 × 80 = 3200
- overlap rows: from y=170 to y=190 (the region ends at 190) = 20 rows × 40 wide = 800
- **containment = 800 / 3200 = 0.25 < 0.35**, so it's **rejected**. A helmet held in your hand doesn't count.

(This exact case is the test `test_small_ppe_box_partially_outside_region_below_threshold`.)

**Step 4: the vest region** = (100 − 5, 100 + 36, 100 + 105, 100 + 234) = **(95, 136, 205, 334)**. A vest at (110, 170, 190, 300) is fully inside, so containment is 1.0 and it's assigned.

**Step 5: two people overlap.** Person A = (100, 100, 200, 400) and person B = (160, 110, 260, 410). A helmet sits at (185, 100, 235, 140), area 50 × 40 = 2000.

- A's head region is (90, 55, 210, 190). Only the helmet's x-range 185→210 is inside, so the overlap is 25 × 40 = 1000 and **containment = 0.5**.
- B's head region is (160 − 10, 110 − 45, 160 + 110, 110 + 90) = (150, 65, 270, 200). The helmet is fully inside, so **containment = 1.0**.

Both pass the 0.35 threshold, but B scores higher, so **B gets the helmet** and A is non-compliant. When two scores are equal (rounded to 2 decimals), the tie is broken by the distance from the helmet's centre to each region's centre, divided by person height (`associate()`, lines 131-138). (This is `test_ppe_goes_to_the_right_person_when_boxes_overlap`.)

Each detection goes to **at most one** person (line 139-140), so one helmet can't make two people compliant.

**Deciding each item** (`evaluate_items()`, lines 161-181):

```python
pos = max(conf of "helmet" boxes for this person, default 0)
neg = max(conf of "no_helmet" boxes for this person, default 0)
if pos > 0 and pos >= neg:  "present"      # saw a helmet, and it's at least as confident as any no_helmet
elif neg > 0:                "missing"      # model explicitly saw a bare head
elif policy == "strict" and region_visible(...): "missing"   # saw nothing at all, and the head IS in frame
else:                        "unknown"      # head outside frame (or policy negative_only)
```

- **strict** policy (the default): "no helmet detected" means missing. It's safer, but gives false alarms when the helmet is simply not seen.
- **negative_only** policy: only an explicit `no_helmet` detection counts as missing. It gives fewer false alarms but misses more real violations.
- `region_visible()` (line 144): if the person box touches the bottom edge of the frame, their feet are probably cut off, so **boots** become "unknown" rather than missing. The same applies to head items at the top edge.

**Person status** (`overall_status()`, line 184): any missing → **non_compliant**; else any unknown → **unknown**; else **compliant**.

People shorter than `min_person_height` (60 px at 960-wide processing) get all items "unknown" (lines 206-207). They're too far away to judge fairly.

**Crop refinement helpers** (lines 214-248):

- `crop_region()` pads a person box (25% each side, 15% on top, 5% below) before cropping.
- `dedupe()` removes duplicate boxes (this is a tiny NMS; see §5).
- `merge_refined()`: for people who were re-examined on a close-up crop, the **crop's** gear detections replace the full-frame ones, because close-ups are more reliable.

**Smoothing** (`ComplianceSmoother`, lines 253-284) keeps the last 6 verdicts per person per item and takes a **majority vote**; ties go to "present". Example window: present, present, present, present, **missing** gives present (4 vs 1). So one bad frame doesn't flip a worker to red.

### 3.5 `tracker.py`: giving people stable IDs

*Multi-object tracking*: linking detections across frames so each real person keeps one ID.

**Why we need it:** alerts are per worker (§2.7), smoothing is per worker (§3.4), and the UI lists workers by ID.

**Which algorithm:** a **ByteTrack-style** tracker written from scratch in 134 lines. The popular ones are ByteTrack and BoT-SORT; Ultralytics includes both, but their internal Python interface changes between library versions. So `ByteTracker` reimplements ByteTrack's core idea without that dependency.

- *ByteTrack*: a tracking method whose key trick is to use even **low-confidence** detections to continue existing tracks.
- *BoT-SORT*: a similar tracker that adds camera-motion compensation and appearance features. We don't use it.

**How `ByteTracker.update()` works** (`tracker.py:96-133`), each processed frame:

1. **Split** person detections into high confidence (≥ the slider value) and low (0.15 up to the slider value). Lines 98-101.
2. **Forget** tracks not seen for more than 2 s (line 104).
3. **Predict** where each track should be now, assuming it keeps moving at the same speed (`_Track.predict()`, line 36). The speed is a smoothed average (*EMA*, an exponential moving average; line 47).
4. **Stage 1:** match predicted boxes to *high*-confidence detections by IoU, using the **Hungarian algorithm** (`scipy.optimize.linear_sum_assignment`, line 60). *Hungarian algorithm*: finds the best one-to-one pairing between two lists given a cost table; here cost = 1 − IoU. A pair counts only if IoU ≥ 0.25.
5. **Stage 2:** tracks still unmatched are matched to *low*-confidence detections (lines 113-118). This is the ByteTrack trick: a half-hidden worker gets a weak detection, and instead of dropping them we keep their track alive.
6. **New tracks** are created only from unmatched *high*-confidence detections (lines 121-126). Weak detections never create people.
7. **Output** only tracks seen at least 2 times (`min_hits`, line 132), which filters one-frame ghosts. Exception: on the very first frame, everyone is confirmed immediately (line 123-124).

**Example:** track #3 was at (400, 200, 450, 330), moving right at 50 px/s. 0.2 s later, the prediction is shifted 10 px: (410, 200, 460, 330). The new detection (412, 201, 462, 331) overlaps it by 48 × 129 = 6,192 px². Each box is 6,500 px², so IoU = 6192 / (6500 + 6500 − 6192) ≈ **0.91** ≥ 0.25. It's matched and #3 continues.

### 3.6 `violations.py` + `violations_db.py`: alert rules and violation storage

**`violations.py`** now contains only `AlertDebouncer`, which decides *whether* to alert (rules in
§2.8). There's one per camera.

**`violations_db.py`** is the persistent store (SQLAlchemy 2 + SQLite):

| Name | Job |
|---|---|
| `ViolationRow` | the table: `id`, `ts` (epoch, indexed), `stream_id` (indexed), `stream_name`, `track_id`, `missing` (JSON list), `image` (full JPEG BLOB), `thumb` (JPEG BLOB) |
| `ViolationStore.add()` | inserts a row, updates the per-session counters, notifies subscribers (the WebSocket) |
| `ViolationStore.list()` | filters + **keyset pagination** ordered by `(ts, id)` newest first; returns `{items, total, next_before_id}` with base64 thumbnails |
| `get()` / `delete()` | one row with the full base64 image / delete one row |
| `export_csv()` | CSV text for the current filters |
| `cleanup(retention_days)` | deletes rows older than the retention window |
| `count_today()` | cached count since local midnight (for the top bar) |

*Keyset pagination* means asking for "rows older than this one" instead of "rows 50–100". New rows
arriving at the top can't shift the pages and cause duplicates. *BLOB* means binary data stored
inside the database. Both images live in the database, so one file holds everything and deleting
a row can never leave orphan image files. SQLite runs in WAL mode, and writes are serialized with a
lock because SQLite allows one writer at a time.

### 3.7 `annotate.py`: drawing

- `draw()` (line 31): boxes and labels for people, gear and stray gear (see §2.5). Label size scales with frame height (line 34-35).
- `_label()` (line 21): a filled rectangle with white text, kept inside the frame.
- `crop_person()` (line 61): the snapshot for an alert, with 30% padding and upscaled to at least 220 px tall.

### 3.8 `config.py` + `config.yaml` + `.env`

`config.py` defines the config's shape with **pydantic** models. Every number has limits (for
example `port` 1–65535, `iou` 0.1–0.95, `imgsz` a multiple of 32), and choices are fixed lists
(`device`, `source.type`, `missing_policy`). A bad value is rejected with a precise field path such
as `streams.1.source.uri`.

`parse_config(raw, base_dir)` is the single entry point used by both startup and the Config page:

1. It expands `${VAR:-default}` in strings.
2. It applies env overrides: `PPE_HOST`, `PPE_PORT`, `PPE_DEVICE`, `PPE_IMGSZ`, `PPE_CPU_IMGSZ`, `PPE_DB_PATH`.
3. It validates.
4. It resolves relative paths against the config file's folder.

Numeric keys are plain values in the YAML (no `${…}`), so the form can edit them as numbers.

| Section | Keys (new in **bold**) |
|---|---|
| `server` | `host`, `port`, `static_dir`, `cors_origins` (restart needed to change) |
| `model` | `weights`, `device`, `openvino`, `imgsz`, `cpu_imgsz`, `half`, `default_confidence`, **`iou`** (NMS), `cpu_threads`, `class_map` |
| `inference` | `mode`, `max_fps_per_stream`, **`frame_skip`**, `process_width` (downscale), `jpeg_quality`, `person_refine`, `refine_imgsz`, `refine_max_persons`, `refine_batch`, `refine_min_height` |
| `tracking` | `low_thresh`, `match_iou`, `max_lost_seconds`, **`min_hits`** (`high_thresh` removed: the slider sets it) |
| `compliance` | `missing_policy`, `min_containment`, `smoothing_window`, `min_person_height` |
| `alerts` | `min_violation_frames`, `cooldown_seconds` (dedupe window), **`snapshot_quality`**, **`retention_days`**, **`db_path`** (`snapshot_dir`, `max_log_entries` removed) |
| `streams[]` | `id` (letters/digits/-/_), `name`, `source {type, uri, fps, loop, reconnect_delay, max_reconnect_delay}`, `required_ppe`, `enabled`, `confidence` |

`config.default.yaml` next to `config.yaml` holds the factory defaults used by *Reset to defaults*.
Backups (`config.backup.<timestamp>.yaml`) are written next to `config.yaml`; see §12.

### 3.9 `api.py`: the web server

*REST*: URLs + HTTP verbs (GET = read, POST = do, PUT = replace, PATCH = change, DELETE = remove).
*WebSocket*: a connection that stays open so the server can push messages.
*MJPEG*: video as a never-ending HTTP response of JPEG pictures, shown by a plain `<img>`.

`create_app(cfg, monitor, config_path)` builds the app. At startup its `lifespan` does the following:

1. Starts the `Monitor`.
2. Subscribes `on_violation` to the store, so new violations reach the WebSocket.
3. Starts `stats_loop` (every 250 ms) and `retention_loop` (every hour).

At shutdown it stops them, closes WebSockets, stops the monitor and closes the DB.

| Method + path | Handler | What it does |
|---|---|---|
| `GET /api/health`, `/api/status`, `/api/streams`, `/api/streams/{id}` | `health`, `status`, `streams`, `stream` | status snapshots |
| `POST /api/streams/{id}/start` · `/stop` | `start`, `stop` | start / stop one camera |
| `PATCH /api/streams/{id}/settings` | `settings` | live `confidence` / `show_boxes` (not saved to config) |
| `GET /api/streams/{id}/mjpeg` · `/frame.jpg` | `mjpeg`, `frame` | video. The MJPEG loop ends when the camera is restarted by a reload, and the browser reconnects to the new one. |
| `GET /api/config` | `get_config` | `{config, yaml, etag, path}`: the raw file, placeholders not expanded |
| `GET /api/config/schema` | `config_schema` | pydantic JSON schema + PPE items, devices, source types |
| `POST /api/config/validate` | `validate_config` | `{config}` or `{yaml}` → `{valid, errors:[{loc,msg,line?}]}` |
| `PUT /api/config` | `put_config` | validate → backup → atomic write → hot reload → `{ok, reload, config, yaml, etag}`; **422** with field errors, **409** if the etag is stale |
| `POST /api/config/reset` | `reset_config` | writes `config.default.yaml` (with backup + reload) |
| `GET /api/config/backups` · `POST /api/config/restore` | `config_backups`, `restore_config` | list / restore a backup by name |
| `GET /api/violations` | `list_violations` | `start`, `end` (epoch s), `camera`, `ppe`, `before_id`, `limit` ≤ 200 → `{items, total, next_before_id}` |
| `GET /api/violations/export` | `export_violations` | CSV attachment for the same filters |
| `GET /api/violations/stats` | `violation_stats` | `{today, session_total}` |
| `GET /api/violations/{id}` | `get_violation` | one record with full-size `image` (base64 JPEG) |
| `DELETE /api/violations/{id}` | `delete_violation` | delete one record |
| `WS /ws` | `ws` | `hello` and `stats` (snapshot incl. `violations_today`), `violation` events |

Example `PUT /api/config` response (trimmed):

```json
{ "ok": true,
  "reload": { "restarted": ["cam3"], "started": [], "stopped": [], "added": [], "removed": [],
              "engine_reloaded": false, "requires_server_restart": [] },
  "etag": "3f1c9a0b2d4e5f60", "config": { "...": "..." }, "yaml": "..." }
```

Example validation error (HTTP 422):

```json
{ "detail": "invalid configuration",
  "errors": [ { "loc": "model.iou", "msg": "Input should be less than or equal to 0.95", "line": 19 } ] }
```

Example `GET /api/violations?camera=cam4&limit=1`:

```json
{ "items": [ { "id": 409, "timestamp": 1790008011.4, "iso": "2026-09-21T10:46:51Z",
               "stream_id": "cam4", "stream_name": "Camera 4", "track_id": 45,
               "missing": ["goggles", "helmet", "vest"], "thumbnail": "/9j/4AAQSkZJRg…" } ],
  "total": 59, "next_before_id": 409 }
```

The SPA catch-all now returns **404 for unknown `/api/…` paths** instead of the dashboard HTML.

### 3.10 Threading and async design

For 4 cameras, the program runs:

| Thread | Count | Code | Job |
|---|---|---|---|
| `grab-camN` | 4 | `FrameGrabber._run` | read and decode video |
| `infer-batched` | 1 | `InferenceEngine._run` | run the AI |
| `post-camN` | 4 | `StreamWorker._post_loop` | track, judge, draw, encode, alert |
| event loop | 1 | uvicorn/FastAPI | HTTP, MJPEG, WebSocket |

*async / event loop*: one thread that juggles many network connections by switching between them whenever one is waiting, like a waiter serving many tables. Used for web traffic because most time is spent waiting on the network.

**Why a grab thread per camera?** `cap.read()` *blocks*: it waits until a frame is decoded, and for a network camera that can take seconds. If all cameras shared one reader, one frozen camera would freeze all of them.

**Why a post-processing thread per camera?** Tracking, drawing and JPEG encoding happen per camera. Running them in parallel with the next AI batch keeps the model busy. OpenCV and OpenVINO release Python's *GIL* while they work, so threads do run truly in parallel for those parts. *GIL (Global Interpreter Lock)*: a Python rule that only one thread runs Python code at a time; C libraries can release it.

**How stale frames are dropped.** Every hand-off holds **one** item and newer items replace older ones:

1. `FrameGrabber._latest` is overwritten each frame (§3.2).
2. `StreamWorker.ready()` (`pipeline.py`) only lets the engine take a camera's frame if (a) that camera isn't still processing the previous one (`_busy`, `_slot`), (b) the frame is **new** (`f.seq > self._last_seq`), and (c) at least 1/15 s has passed.
3. The mailbox `_slot` holds a single result (`submit()`, line 135).
4. The MJPEG loop only sends the latest JPEG (`seq != last`).

So if the AI manages 5 fps and the camera delivers 20 fps, 3 out of 4 frames are never analysed. They're shown on neither the video nor the counters, but the display stays **live**.

**How a crash in one tile is isolated:**

| Failure | Caught at | Effect |
|---|---|---|
| Video file missing | `sources.py:161` | that tile shows NO SIGNAL; others unaffected |
| Camera disconnects / decode error | `sources.py:186-188` (`try/except`) | that tile RECONNECTING; others unaffected |
| Bug in tracking/drawing for one frame | `pipeline.py` | that tile shows ERROR for 5 s, then continues |
| Model error | `pipeline.py` | every camera **in that batch** shows ERROR, then retries after 0.5 s (see Issues #6; `mode: per_stream` isolates fully) |
| Slow camera | `ready()` returns False | it just isn't included in the batch; the others don't wait for it |
| Broken browser connection | `api.py` | that client is dropped |

---

## 4. Frontend, file by file

Folder `frontend/` is a **React** app built with **Vite** and styled with **Tailwind**.

- *React*: a JavaScript library where you describe the UI as components (functions returning HTML-like JSX), and it re-draws them when data changes.
- *Vite*: a dev server + bundler. `npm run dev` gives live reload; `npm run build` produces optimised files in `dist/`.
- *Tailwind*: CSS written as small class names directly in the markup (`bg-slate-900 rounded-xl`).
- *TypeScript*: JavaScript with type checking (`.ts`/`.tsx` files).

### 4.1 Files

| Path | Purpose |
|---|---|
| `src/main.tsx` | mounts `<ToastProvider><MonitorProvider><App/>` |
| `src/App.tsx` | layout: fixed `Sidebar` + the page for the current route |
| `src/lib/router.ts` | tiny hash router (`#/dashboard`, `#/violations`, `#/config`) + a navigation guard for unsaved config edits |
| `src/lib/api.ts` | typed REST client (`api.streams`, `api.config`, `api.violations`), `ApiError` with field errors |
| `src/lib/format.ts` | PPE labels, times, day grouping, date-range → epoch |
| `src/lib/configForm.ts` | `getIn` / `setIn` by dotted path, `fieldMeta()` reads limits/defaults from the JSON schema |
| `src/state/monitor.tsx` | `MonitorProvider`: the single WebSocket; `streams`, `info` (incl. `violations_today`), `onViolation()` subscriptions |
| `src/components/ui/` | reusable kit: `Button`, `IconButton`, `Card`, `Badge`, `StatusBadge`, `PpeChip`, `Modal`, `ConfirmModal`, `Input`, `Select`, `Field`, `Toggle`, `Toast`, `EmptyState`, `Skeleton`, `Icon` |
| `src/components/layout/` | `Sidebar`, `Topbar`, `PageBody` (max-width container, 24px padding) |
| `src/components/camera/` | `CameraTile`, `VideoView`, `StreamControls`, `DetailView` |
| `src/components/violations/ViolationModal.tsx` | full-size viewer |
| `src/components/config/` | `fields.tsx` (bound form fields), `StreamsSection`, `YamlEditor`, `BackupsModal` |
| `src/pages/` | `DashboardPage`, `ViolationsPage`, `ConfigPage` |

Removed: `components/ViolationFeed.tsx`, the old `useMonitor.ts` hook with its violations state,
the old `components/ui.tsx`, and the `hello.violations` WebSocket payload.

### 4.2 Component tree

```mermaid
flowchart TD
    main["main.tsx"] --> TP["ToastProvider"] --> MP["MonitorProvider (WebSocket)"] --> App
    App --> SB["Sidebar"]
    App --> D["DashboardPage"]
    App --> V["ViolationsPage"]
    App --> C["ConfigPage"]
    D --> TB1["Topbar"]
    D --> CT["CameraTile ×4"] --> VV["VideoView"] & SC["StreamControls"]
    D --> DV["DetailView (Modal)"]
    V --> TB2["Topbar (+ Export CSV)"]
    V --> FL["Filters: Field / Input / Select"]
    V --> CARDS["day groups → cards"]
    V --> VM["ViolationModal"]
    C --> TB3["Topbar (+ Saved / Unsaved badge)"]
    C --> FORM["form sections: fields.tsx + StreamsSection"]
    C --> YE["YamlEditor"]
    C --> BM["BackupsModal / ConfirmModal"]
```

### 4.3 State management and data flow

- **Live data:** `MonitorProvider` (`state/monitor.tsx`) keeps one WebSocket for the whole app.
  `stats` messages replace `streams` and `info` 4 times a second. A `violation` message is
  handed to every function registered with `onViolation()` (the Violations page, the detail view)
  and bumps `violations_today` straight away. A late `onclose` from an old socket is detached so
  it can't mark the app offline (the StrictMode bug fixed earlier).
- **Page data:** each page keeps its own local state. The Violations page keeps
  items / cursor / filters / openId, and tracks the open modal **by id**, so live inserts at the
  top don't shift which record you're viewing. The Config page keeps the loaded document, the
  draft, the YAML draft and field errors.
- **Optimistic update:** after Start/Stop/Boxes/slider, the REST response is merged immediately
  with `patchStream()`.

### 4.4 How video frames are displayed

`components/camera/VideoView.tsx` uses a plain `<img>` whose `src` is the MJPEG URL: the browser handles the multipart stream by itself.

```ts
useEffect(() => {
  const img = imgRef.current;
  if (!img || !active) return;               // don't connect until the stream is running and has frames
  setLoaded(false);
  img.src = mjpegUrl(stream.id, nonce);      // open the MJPEG connection
  return () => {
    img.src = BLANK;                          // on unmount/stop: swap to a 1-pixel GIF = close the connection
  };
}, [active, stream.id, nonce]);
```

- `active` = running and at least one processed frame exists (`frame_seq > 0`).
- The **cleanup** (the `return () => …` part) runs when the tile is hidden or the stream stops. **Removing** an `<img>` doesn't close an MJPEG connection in Chrome/Edge; **changing its `src`** does. Without this, leaked connections filled the browser's 6-per-server limit and the tiles went black. That bug was found and fixed during testing.
- `onError` retries after 1.5 s by bumping `nonce`, which changes the URL.

**Overlays:** the boxes are **not** drawn by the browser; they're already in the JPEG (§2.5). The only browser overlays are the gradient header with name/badge/FPS (`components/camera/CameraTile.tsx`) and the placeholder texts (`components/camera/VideoView.tsx`).

### 4.5 Styling

A white professional theme. The design tokens are defined once in `src/index.css` inside
Tailwind v4's `@theme`, which turns each token into utility classes like `bg-surface`,
`border-border`, `text-muted` and `bg-primary`:

| Token | Value | Used for |
|---|---|---|
| `bg` | #F8FAFC | page background |
| `surface` | #FFFFFF | cards, sidebar, top bar |
| `border` | #E2E8F0 | 1px card borders, dividers |
| `text` / `muted` | #0F172A / #64748B | body text / secondary text |
| `primary` | #2563EB | buttons, active nav, focus rings, toggles |
| `success` / `danger` / `warning` | #16A34A / #DC2626 / #D97706 | states. For small text, darker AA variants are used: `success-text` #15803D and `warning-text` #B45309. |

Cards use a 12px radius, a 1px border and a subtle two-layer shadow. The font is Inter (JetBrains
Mono for numbers and code). Every interactive element has a visible `:focus-visible` ring, and
motion is disabled under `prefers-reduced-motion`. The layout is a fixed 240px sidebar, which
becomes a 64px icon rail below 1024px, with a sticky 64px top bar and content in a 1440px
max-width container with 24px padding. Video areas stay dark (`--color-video`) because video is
video. The **boxes drawn on the video** use the same green/red/amber, lifted slightly for dark
footage, with a 1px dark outline so they stay visible on bright floors too
(`annotate.py → _box()`).

## 5. The AI part, simplified

### 5.1 What YOLO is

*YOLO ("You Only Look Once")*: a family of neural networks that find objects in an image in **one pass**.

In plain words:

1. The image is shrunk and padded to a square, e.g. 480×480 (*letterboxing*: padding with grey bars to keep the proportions).
2. A *neural network* processes it. That's a big stack of simple math layers whose numbers (*weights*) were learned from thousands of labelled example images. Early layers detect edges, later ones parts (a helmet's curve), and the last ones whole objects.
3. The output is a grid of guesses. Every cell says "I think there's a **helmet** here, box = (x1, y1, x2, y2), **confidence 0.83**".
4. Many overlapping guesses for the same object are merged by **NMS** (below).
5. We get a list of boxes, each with a class and a confidence.

*Training*: showing the network labelled images and nudging its weights to reduce mistakes. *Fine-tuning*: training further, starting from an existing model, on your own specialised images. We didn't train anything; we use SafeSight's fine-tuned weights.

### 5.2 The weights we use

`models/safesight/best.pt`, 22 MB:

- **Architecture:** YOLOv8s ("small"), trained with Ultralytics (`models/safesight/args.yaml`: `model: yolov8s.pt`, `epochs: 60`, `imgsz: 640`).
- **Data:** ~13,000 images merged from several Roboflow datasets and a GitHub dataset.
- **Quality (author's numbers):** mAP50 ≈ 0.76, precision ≈ 0.81, recall ≈ 0.72.
- **Origin:** a public Hugging Face model repo (the "SafeSight" project, Apache-2.0 licence), already downloaded into `models/safesight/`.
- **Our derived copies:** `best_480_openvino_model/` and `best_640_openvino_model/`, automatic OpenVINO conversions.

### 5.3 Key terms

| Term | Meaning | Where it appears |
|---|---|---|
| **Confidence** | model's 0–1 certainty for one box | the slider; `Detection.conf` |
| **IoU** | overlap ÷ union of two boxes (0–1) | tracker matching (`tracker.py:59`), `dedupe()` |
| **NMS (Non-Maximum Suppression)** | when several boxes of the same class overlap heavily (high IoU), keep only the most confident | inside Ultralytics; our `ppe_logic.dedupe()` does the same for merged crop results |
| **FPS** | frames per second | tile counters |
| **Precision** | of the boxes the model drew, how many were right | model README |
| **Recall** | of the real objects, how many the model found | model README |
| **mAP50** | a single accuracy score averaged over classes, counting a box correct if IoU ≥ 0.5 | model README |
| **Inference** | running a trained model on new data (vs. training it) | `infer_ms` |

### 5.4 Why detections miss or flicker, and what we do about it

**Causes:**

- **Small objects.** On your wide-angle CCTV, a head is ~10 pixels tall once shrunk for the model. Models struggle below ~15–20 px.
- **Angle.** The training images are mostly eye-level construction photos, while your camera looks down from high up. Blue hardhats seen from behind and above were sometimes missed.
- **Occlusion.** Workers walk behind steel coils and railings.
- **Motion blur and compression.** The H.265 at ~1.1 Mbit/s smears small details.
- **Borderline confidence.** A helmet scoring 0.36 in one frame and 0.34 in the next flips around the 0.35 threshold.

**What the code does about it:**

| Problem | Fix | Code |
|---|---|---|
| Tiny heads | **Person-crop refinement**: re-detect on a full-resolution close-up of each person at 320 px, so the head becomes ~5× bigger. On your footage this cut 60-s alerts from 31 to 17, mostly false "no helmet". | `InferenceEngine._refine()` `pipeline.py` |
| Frame-to-frame flicker of a verdict | Majority vote over 6 frames | `ComplianceSmoother` |
| Person briefly lost | ByteTrack second stage uses weak detections; tracks survive 2 s unseen | `tracker.py:113-118`, `max_lost_seconds` |
| One-frame ghost people | tracks must be seen twice | `min_hits=2` |
| Alert spam from flicker | 6 consecutive bad frames needed; 30 s cooldown; ID-switch hand-off | `AlertDebouncer` |
| Too-far people judged unfairly | marked "unknown", never alerted | `min_person_height` |
| Body part out of frame | item marked "unknown" | `region_visible()` |

### 5.5 Limitations of the current model

1. **Viewpoint mismatch:** trained on eye-level photos; your cameras are high and wide.
2. **Goggles, gloves, masks and ear protection** are too small to see reliably at CCTV distance. Requiring them (Camera 2: gloves, Camera 4: goggles) will create many alerts, so treat those as placeholders.
3. **Ear-protection is under-represented** in training (model README). Boots, No-Ear-Protection and No-Glove are often missed.
4. **"No vest" vs dark T-shirt:** correct for hi-vis policies, but the model can't know your site's rules.
5. **No re-identification:** someone who leaves and comes back later gets a new ID. *Re-identification*: recognising the same person by appearance.
6. **The fix for all of these** is **fine-tuning on a few hundred labelled frames from your own cameras** (steps in `README.md → Fine-tuning`).

---

## 6. Performance

### 6.1 Measured numbers

Hardware: laptop with an Intel i5-1135G7 (4 cores / 8 threads), Intel Iris Xe integrated GPU, no NVIDIA GPU.

**Model-only benchmarks** (4 frames per call):

| Backend | Input size | Images / second |
|---|---|---|
| PyTorch CPU | 640 | 11.6 |
| PyTorch CPU | 480 | 25.6 |
| OpenVINO CPU | 480 | 28.5 |
| **OpenVINO iGPU** | 640 | 33 |
| **OpenVINO iGPU** | 480 | 63 |

**Full pipeline on your 4 NVR files** (4 × 1080p H.265, 20 fps, shipped config: 480 px + crop pass):

| Situation | FPS per tile (all 4 at once) | Inference / batch | Latency |
|---|---|---|---|
| Pipeline only (`scripts/headless_check.py`, 45 s) | **5.5** | 100–120 ms | 130–150 ms |
| Web server, while another heavy app was running on the laptop | 3.6 | 220–300 ms | 250–340 ms |
| Web server + dashboard open in a browser on the same laptop | ~2 | 170–340 ms | 200–370 ms |

Earlier synthetic test (image folders fed at 25 fps, **no** crop pass, 640 px): **7.5 fps per tile**.

### 6.2 What we did to reach these numbers

| Technique | Effect | Code |
|---|---|---|
| **OpenVINO on the iGPU** instead of PyTorch CPU | ~3× model speed | `detector.py → select_backend()` |
| **Frame skipping** (latest-frame-only hand-offs) | display never lags; AI works on the newest frame | §3.10 |
| **Downscaling** 1920 → 960 px before everything | 4× fewer pixels to draw, encode and stream | `FrameGrabber._resize()` |
| **Smaller model input** 480 for the full frame; detail comes from crops | ~2× faster main pass | `config.yaml: imgsz: 480` |
| **Batching** cameras into one model call | shared per-call overhead | `InferenceEngine._run()` |
| **Fixed crop shapes** (320×320, batches of exactly 2) | the iGPU never recompiles; this removed 1-second freezes | `pipeline.py` |
| **Warm-up** of every input shape at startup | no slow first frames | `InferenceEngine.warmup()` |
| **Reading `model.names` once** | the OpenVINO backend was being rebuilt 17 times at startup | `detector.py` |

### 6.3 Where the bottleneck is

On this laptop, **everything shares one 4-core CPU and one small iGPU**:

- decoding 4 × 1080p H.265 at 20 fps (80 frames/s, ~0.5 core),
- resizing, drawing and JPEG encoding,
- the AI model (iGPU plus CPU pre/post-processing),
- the browser decoding four MJPEG streams, if opened on the same PC,
- any other program. During testing, an unrelated `D:\new_utility` uvicorn app used a lot of CPU.

### 6.4 How to improve

| Option | Expected gain | Effort |
|---|---|---|
| Run on a dedicated PC, and view the dashboard from another PC | back to the first row (5.5 fps) or better | none |
| NVIDIA GPU (`device: auto` picks CUDA automatically) | 15+ fps per tile | hardware |
| Use the NVR's **sub-stream** (lower resolution) for decoding | much less decode CPU | config |
| Set `refine_min_height` = `min_person_height` (60) | skip crops that will be judged "unknown" anyway | 1 line (Issues #4) |
| Lower `jpeg_quality` / `process_width` | less encode + browser work | config |
| INT8 quantisation of the OpenVINO model (Intel's NNCF tool) | ~1.5–2× model speed, small accuracy loss | medium |
| Turn off `person_refine` and set `imgsz: 640` | 7.5 fps, but more missed helmets | config |
| Hardware video decoding (`cv2.CAP_PROP_HW_ACCELERATION`) | less CPU | small code change |

---

## 7. Run, test, deploy

### 7.1 Run locally (Windows, as set up now)

```powershell
D:\ppe_pretrained\start.bat
```

`start.bat` runs `backend_venv311\Scripts\python.exe run.py` from `backend\`. Wait for `ready: http://0.0.0.0:8000`, then open **http://localhost:8000**. Ctrl+C stops it.

What happens at startup:

1. `load_config()` reads the config.
2. `YoloDetector` loads (or exports, the first time) the OpenVINO model, which takes ~3 s.
3. `InferenceEngine.warmup()` runs each input shape once (~1.5 s).
4. The 4 cameras start.
5. uvicorn serves the API **and** the built dashboard from `frontend/dist`.

**Frontend development** (live reload while editing React code):

```powershell
cd D:\ppe_pretrained\frontend
npm install          # once: downloads packages into node_modules/
npm run dev          # dev server on http://localhost:5173, proxies /api and /ws to :8000
npm run build        # type-check + produce frontend/dist (what :8000 serves)
```

**Fresh machine** (per `README.md`):

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python run.py
```

### 7.2 Docker

```bash
docker compose up --build
```

- Stage 1 builds the React app; stage 2 is `python:3.11-slim` with the backend and built UI.
- **Persistent volumes** (host folders):
  - `./config` holds `config.yaml` and its `config.backup.*.yaml` files. It's seeded from
    `backend/config.default.yaml` on first start by the container's start command.
  - `./data` holds `violations.db`.
  - `./videos` (read-only) and `./models` are mounted too.
- The env vars `PPE_CONFIG=/app/config/config.yaml` and `PPE_DB_PATH=/app/data/violations.db`
  point the app at those volumes.
- The local DB and backups are in `.dockerignore`, so they're never baked into the image.

⚠️ Docker still **hasn't been tested** here, because Docker isn't installed on this machine.

### 7.3 Tests

```powershell
cd D:\ppe_pretrained\backend
..\backend_venv311\Scripts\python.exe -m pytest -q        # 84 passed
..\backend_venv311\Scripts\python.exe scripts\headless_check.py --seconds 30   # in-memory DB unless --persist
```

| File | Tests | Checks |
|---|---|---|
| `test_ppe_logic.py` | 25 | association geometry, policies, cut-off persons, smoothing, crop merge |
| `test_tracker_and_alerts.py` | 12 | tracker IDs, debounce, cooldown, subset rule, ID hand-off |
| `test_config.py` | 4 | env expansion, relative paths, invalid PPE item, class mapping |
| `test_config_store.py` | 17 | 8 field-level error cases; invalid save leaves file + backups untouched; YAML syntax error line; YAML validation errors mapped to lines; 13 saves keep exactly 10 backups; **simulated crash before rename leaves the old file intact and no temp file**; etag conflict; reset; restore; path traversal |
| `test_hot_reload.py` | 6 | **only the changed stream restarts** (others are the same objects); add / remove / disable; model change reloads the engine only; global setting restarts all; live default confidence; server change reported, not applied |
| `test_violations_db.py` | 8 | newest-first, base64 thumbnail, keyset pages cover everything once and stay stable under inserts, camera / PPE / date filters, full base64 image, delete, CSV, **retention cleanup**, today count, subscribers |
| `test_api.py` | 8 | config GET/schema, 422 field errors without writing, PUT → backup + hot reload, 409 stale etag, YAML validate, violations filters / pagination / detail / delete / export, `/api/nope` → 404 |
| `test_snapshot.py` | 4 | full-resolution snapshot (incl. frame-edge boxes), source frame untouched |

The tests use a `FakeDetector` (`tests/helpers.py`), so they never load a model and run in about 10 s.

### 7.4 Common errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `[Errno 10048] ... only one usage of each socket address` | Something already uses port 8000 (often a previous run) | `Stop-Process -Id (Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess -Force` |
| Tile shows **NO SIGNAL / not found: …** | Video path in `config.yaml` is wrong or the file is missing | fix `streams[].source.uri`; the app picks the file up within 2 s |
| `model weights not found` | wrong `model.weights` | fix the path or `PPE_MODEL_WEIGHTS` |
| Startup error `unknown PPE item(s)` | typo in `required_ppe` | use one of: helmet, vest, gloves, goggles, boots, mask, ear_protection |
| Many `[hevc @ …]` log lines | FFmpeg skipping the NVR's private headers in `.cpv` | harmless |
| Flood of `'half' is deprecated` warnings | an old version of `detector.py` | fixed; restart the app |
| UI says **Backend offline** | backend not running, or the dev server's proxy points to the wrong port | start `start.bat`; check `VITE_BACKEND_URL` |
| Very low FPS | two copies of the app running, or other heavy programs | run one copy; close other apps; view from another PC |
| Playback too fast/slow | wrong `fps:` for raw streams | `.cpv` = 20 |
| `npm run build` fails with a TypeScript error | type mistake in `.tsx` | read the file/line in the error |
| OpenVINO export error at startup | OpenVINO missing/broken | the app falls back to PyTorch CPU automatically (slower) |
| Tiles black but the status says LIVE | too many open video connections (old browser tabs) | close extra tabs of the dashboard |

---

## 8. How to modify it

### 8.1 Add a 5th camera

On the **Config** page, open the Streams section and click **Add camera**. Fill in the name,
source type and path/URL, choose the required PPE, then **Save**. The toast says "added cam5", and
it starts without a server restart. The dashboard grid is `md:grid-cols-2` in
`pages/DashboardPage.tsx`, so a 5th tile starts a third row; use `xl:grid-cols-3` there if you
prefer three columns. Browsers allow ~6 open MJPEG connections per server, so plan for at most 6
tiles on one page.

### 8.2 Change required PPE for a camera

On the Config page, go to Streams, click the PPE chips for that camera, and **Save**. Only that
camera restarts. By hand, edit `required_ppe:` in `config.yaml`; a manual edit is picked up at the
next server start, or immediately if you paste it into the Raw YAML view and save.

### 8.3 Swap in a different model

1. Put the `.pt` file in `models/…` and set `model.weights` (`config.yaml`).
2. Check its class names: the startup log prints `classes used: … | ignored: …`. If a name isn't recognised, add it to `model.class_map` (`config.yaml`) or `ALIASES` (`detector.py`).
3. It must have a person/worker class, otherwise the log warns and compliance stays empty.
4. OpenVINO will auto-export the new weights. If you replace weights **with the same file name**, delete the old `*_openvino_model` folders first, or the old conversion is reused.

### 8.4 Use an RTSP camera or webcam

Change only the `source:` of that stream in `config.yaml`:

```yaml
source: { type: rtsp,   uri: "rtsp://user:pass@192.168.1.64:554/Streaming/Channels/102" }
source: { type: webcam, uri: "0" }
```

- Remove `fps:` for live sources, since they are not paced.
- Tip: many NVRs offer a lower-resolution **sub-stream** (often channel …02), which is lighter to decode.

### 8.5 Change violation alert rules

On the Config page, the **Violations** section has the dedupe window (`cooldown_seconds`),
debounce (`min_violation_frames`), snapshot quality and retention days. The **General** section
has the missing-PPE policy, min containment and min person height. The ID hand-off window (4 s)
is in code: `AlertDebouncer(handoff_seconds=…)` in `violations.py`.

### 8.6 Change box colors

- **Video boxes:** `GREEN` / `RED` / `AMBER` / `OUTLINE` at the top of `annotate.py`, in **BGR**
  order.
- **UI colors:** the tokens in `src/index.css` (`@theme`), which every component uses. Badge tones
  are in `components/ui/Badge.tsx`.
- Rebuild the UI (`npm run build`) and restart the server.

## 9. Glossary

| Term | One-line definition |
|---|---|
| Annotated frame | a video frame with boxes and labels drawn on it |
| async / event loop | one thread juggling many network connections by switching while each waits |
| Backoff (exponential) | waiting longer after each failed retry (2 s, 4 s, 8 s …) |
| Batch / batching | processing several images in one model call to share overhead |
| BGR | OpenCV's color order: blue, green, red |
| BoT-SORT | a multi-object tracker similar to ByteTrack, with camera-motion and appearance cues (not used) |
| Bounding box | rectangle (x1, y1, x2, y2) around an object |
| ByteTrack | tracker that also uses low-confidence detections to keep existing tracks alive |
| Canonical class | our standard name for a class (e.g. `helmet`), whatever the model calls it |
| Confidence | model's 0–1 certainty for a detection |
| Containment | fraction of box A that lies inside box B |
| CORS | browser rule controlling which websites may call an API |
| CUDA | NVIDIA's GPU computing platform |
| Debounce | wait until a condition holds for a while before acting |
| Dedupe | remove duplicates |
| EMA | exponential moving average: new = a·latest + (1−a)·old |
| Epoch | one full pass over the training data |
| FastAPI | Python web framework used for the API |
| Fine-tuning | continuing to train a model on specialised data |
| FPS | frames per second |
| GIL | Python's lock letting only one thread run Python code at a time |
| H.265 / HEVC | a video compression standard (your NVR files) |
| Hook (React) | a `use…` function holding state/effects for components |
| Hungarian algorithm | optimal one-to-one matching given a cost table |
| iGPU | integrated GPU built into the CPU chip (Iris Xe here) |
| Inference | running a trained model on new data |
| IoU | intersection ÷ union of two boxes |
| JPEG | compressed image format |
| Latency | time delay; here, capture → annotated JPEG |
| Letterbox | resize keeping proportions and pad with grey bars to a fixed shape |
| mAP50 | mean average precision at IoU 0.5, a standard detection accuracy score |
| MJPEG | video as a continuous stream of JPEG pictures over HTTP |
| Negative class | a class meaning "absence of X", e.g. `no_helmet` |
| Neural network | layered math function whose weights are learned from examples |
| NMS | non-maximum suppression: keep the best of heavily overlapping boxes |
| NVR | network video recorder, the box that records CCTV cameras |
| OpenCV | computer-vision library used to read video, draw and encode JPEG |
| OpenVINO | Intel toolkit for fast inference on Intel CPUs/GPUs |
| Optimistic update | updating the UI before the server confirms |
| PPE | personal protective equipment |
| Precision / Recall | share of detections that are right / share of real objects found |
| Props | inputs passed to a React component |
| Protocol (Python) | a description of required methods, so different classes can be swapped |
| pydantic | library that validates data types and values |
| React | UI library built from components that re-render on data change |
| Re-identification | recognising the same person again by appearance |
| REST | URL + HTTP-verb style API |
| Ring buffer | fixed-size list where new items push out the oldest |
| RTSP | protocol used by IP cameras to stream video |
| Snapshot | a saved photo of a violation |
| Stale frame | an old frame superseded by a newer one |
| StrictMode | React dev mode that mounts components twice to expose bugs |
| Tailwind | CSS written as utility class names |
| Thread | an independent line of execution in a program |
| Track / track ID | one person followed over time / its number |
| TypeScript | JavaScript with types |
| uvicorn | the server program that runs the FastAPI app |
| Vite | frontend dev server and build tool |
| WebSocket | a persistent two-way connection for pushed messages |
| Weights | the learned numbers inside a neural network (the `.pt` file) |
| YOLO | "You Only Look Once", a fast single-pass object detector |

---

## 10. Quiz

1. A worker is holding their helmet in their hand at waist height. Which function decides that it doesn't count, and why?
2. Your camera delivers 20 fps but the tile says 5.2 FPS. Where did the other ~15 frames go, and why is that good?
3. You move the confidence slider from 0.35 to 0.70. Name two things that change in the backend and one thing that does **not** change.
4. Why does the tracker only create new people from high-confidence detections, but still use low-confidence ones?
5. Worker #7 was alerted for `{helmet, vest}`. Ten seconds later they're still missing only the helmet. Is there a new alert? Which line decides?
6. Why do we use *containment* instead of *IoU* to decide if a helmet belongs to a person?
7. What problem does `InferenceEngine._refine()` solve, and why are crops always sent as 320×320 in fixed-size batches?
8. Why does `VideoView` set `img.src = BLANK` instead of just removing the image when a tile is closed?
9. Where do the green/red boxes get drawn: in the browser or on the server? Name the function.
10. You want Camera 3 to be an IP camera at `rtsp://10.0.0.5/live`. Which file and which key do you change, and what else must you remove?

### Answers

1. `associate()` in `ppe_logic.py` (with `body_region()` and `containment()`). The helmet box lies mostly outside the **head region** (the top 30% of the person, extended upward), so its containment is below `min_containment` (0.35). It isn't assigned, and under the `strict` policy the helmet is "missing".
2. They were **skipped**. `FrameGrabber` overwrites `_latest`, and `StreamWorker.ready()` only hands over a *new* frame when the previous one is finished. Skipping keeps the display live (no growing delay) instead of analysing old frames.
3. Changes: gear boxes below 0.70 are ignored in `_process()` (`pipeline.py`); the tracker's first-stage threshold becomes 0.70 (`high_thresh=conf`); the crop pass only refines people ≥ 0.70; the detection histogram counts only ≥ 0.70. Unchanged: the model's own run threshold stays ≤ 0.15 (`pipeline.py`), so the AI does the same work.
4. Weak detections are often false, so they mustn't invent people. But a real, tracked person who becomes half-hidden produces a weak detection, and using it keeps their ID alive (ByteTrack's idea, `tracker.py:113-118`).
5. No. `{helmet} ⊆ {helmet, vest}` and it's within the 30 s cooldown; `violations.py` (`if any(missing <= s for s, _ in history)`).
6. A helmet is tiny compared to a person, so IoU between them is always small even when perfectly placed. Containment asks "what fraction of the helmet is inside the head area", which is the right question.
7. On wide CCTV, heads are ~10 px in the downscaled frame, so helmets are missed. `_refine()` re-detects on full-resolution crops where the head is ~5× bigger. Fixed shapes stop the OpenVINO GPU plugin from recompiling for every new input shape, which previously froze the pipeline for ~1 s.
8. Chrome/Edge keep an MJPEG connection open even after its `<img>` is removed. Browsers allow ~6 connections per server, so leaked ones blocked new videos and snapshots. Changing `src` actually closes the connection.
9. On the server, in `annotate.py → draw()`, called from `StreamWorker._process()`. The browser just shows the JPEG.
10. `backend/config.yaml`, the `source:` of `cam3`: set `type: rtsp` and `uri: "rtsp://10.0.0.5/live"`, and remove `fps: 20` (live sources aren't paced).

---

## 11. Issues found

Found while re-reading the whole codebase for this document. Severity: 🔴 real bug, 🟠 weak spot / inconsistency, 🟢 dead code / nit.

**Status after the 2026-09-21 update:**
- **Fixed:** #2 (smoother reset on Stop), #3 (`high_thresh` removed), #4 (crops skip people too small to judge), #7 (`submit()` ignores stopped cameras), #9 (WebSocket sends are concurrent), #10 (unknown `/api` paths → 404), #16 (retention cleanup).
- **No longer applies:** #1 and #5 (the violation log and the header KPIs were removed), #8's unused `people[].box` (still sent; the detail view could use it), #11's `.env.example`, and #18's feed badge.
- **Still open:** #6, #12 (partly), #13, #14, #15, #17 and #19.

| # | Sev. | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 1 | 🟠 | **"Clear log" doesn't reset the counters.** The header "Alerts" KPI and each camera's `alerts_total` keep counting after you clear the log, while the side-panel badge goes to 0. | `violations.py` (`clear()` only empties `_items`); `api.py` | also reset `total`, `per_stream`, `per_item` in `ViolationLog.clear()`, or label the KPI "since start" |
| 2 | 🔴 | **Smoothing history survives Stop/Start.** `stop()` resets the tracker (IDs restart at 1) but not the smoother. The first new "#1" inherits the old #1's last 6 votes, because `prune()` runs *after* `apply()`. It can show a wrong status for about a second. | `pipeline.py`, `176-177` | in `StreamWorker.stop()` add `self.smoother = ComplianceSmoother(self.app_cfg.compliance.smoothing_window)` |
| 3 | 🟠 | **`tracking.high_thresh` is never used.** `_process()` always passes `high_thresh=conf` (the slider), so the config value has no effect. | `pipeline.py`, `config.yaml` | remove the key, or use `max(conf, high_thresh)` |
| 4 | 🟠 | **Wasted crop inference.** People from 24 px (`refine_min_height`) are cropped, but anyone under 60 px (`min_person_height`) is then judged "unknown" anyway. | `pipeline.py` vs `ppe_logic.py:206` | use `max(refine_min_height, min_person_height)` in `_refine()` |
| 5 | 🟠 | **Compliance % counts "unknown" workers as non-compliant.** Far-away people lower the header percentage. | `App.tsx` | `compliant / (compliant + violating)` |
| 6 | 🟠 | **Batched mode: a model error fails every camera in that batch.** | `pipeline.py` | on error, retry each frame individually; or use `mode: per_stream` |
| 7 | 🟠 | **Stop/Start race:** the engine may `submit()` a result to a camera just after `stop()` cleared its mailbox; after Start, one stale frame is processed. | `pipeline.py` vs `336-337` | in `submit()`, ignore the item when `not self.running` |
| 8 | 🟢 | **Confidence isn't shown on labels,** and `people[].box` is sent to the browser every 250 ms but never used. | `annotate.py`; `pipeline.py`; `types.ts` | add `f"{p.conf:.2f}"` to labels, or drop `box` from the payload |
| 9 | 🟠 | **One slow WebSocket client delays stats for everyone:** messages are sent one client at a time with a 2 s timeout each. | `api.py` | `asyncio.gather(...)` or a per-client send queue |
| 10 | 🟢 | Unknown `GET /api/...` URLs return the dashboard HTML instead of a 404 (the catch-all SPA route). | `api.py` | return 404 when `path.startswith("api/")` |
| 11 | 🟢 | `.env.example` says `PPE_IMGSZ=640` but `config.yaml` now defaults to 480; the `half` config key is deprecated upstream; `cpu_threads` doesn't affect OpenVINO. | `.env.example:9`, `config.yaml` | update the comments |
| 12 | 🟢 | **Dead code:** `ImageFolderCapture.set()` (the grabber no longer seeks); `StreamWorker.people` (written, never read); `Tracker` Protocol (unused); `openvino_model_path(export_if_missing=False)` branch; `/api/streams/{id}/frame.jpg` (not used by the UI; still handy for debugging). | `sources.py:88`, `pipeline.py`, `tracker.py:21`, `detector.py`, `api.py` | remove, or keep with a comment |
| 13 | 🟠 | **A blocking RTSP read can outlive `stop()`.** The join waits only 3 s; the daemon thread may keep reading, and a fast Start creates a second grab thread for the same camera. | `sources.py:141-145` | set FFmpeg open/read timeouts (`CAP_PROP_OPEN_TIMEOUT_MSEC`, `CAP_PROP_READ_TIMEOUT_MSEC`) |
| 14 | 🟠 | **Placeholder PPE rules:** Camera 2 requires gloves and Camera 4 goggles, which are rarely visible at CCTV distance. Under the strict policy these produce many alerts. | `config.yaml` | set your site's real rules; consider `negative_only` for small items |
| 15 | ✅ | ~~**No authentication; CORS `*`.**~~ **Fixed 2026-09-22:** sign-in + roles on every route (§13). CORS stays `*`; that's safe here because the bearer token is never sent automatically, and the refresh cookie is SameSite=Strict. | `config.yaml`, `api.py` | change the seed password; serve over HTTPS outside a trusted LAN |
| 16 | 🟢 | Snapshots accumulate on disk forever. | `violations.py` | a daily cleanup (keep N days) |
| 17 | 🟠 | **Docker is untested.** `env_file: required: false` needs Docker Compose ≥ 2.24, and the image lacks Intel GPU drivers, so it would use OpenVINO on the CPU. | `docker-compose.yml`, `Dockerfile` | test on a Docker host; add the Intel compute runtime if the iGPU is needed |
| 18 | 🟢 | Cosmetic: `const PLACEHOLDER:Partial<...>` is missing a space; the feed's red badge counts all alerts, not the filtered camera's. | `components/camera/VideoView.tsx`, `ViolationFeed.tsx` | format; show `items.length` |
| 19 | 🟢 | Tile FPS is averaged over the last 60 frames (~12 s at 5 fps), so it reacts slowly to changes. | `pipeline.py` | use a 2–3 s time window instead of a fixed count |

---

## 12. Update: Config page, Violations page, database

### 12.1 Config page: what happens when you press Save

```mermaid
sequenceDiagram
    autonumber
    participant UI as ConfigPage (browser)
    participant API as api.py put_config
    participant CS as ConfigStore (config_store.py)
    participant FS as disk
    participant M as Monitor.apply_config (pipeline.py)
    UI->>API: PUT /api/config {config | yaml, etag}
    API->>CS: save()
    CS->>CS: validate_any(): YAML syntax → pydantic (parse_config)
    alt invalid
        CS-->>API: ConfigInvalid [ {loc, msg, line} ]
        API-->>UI: 422 → fields turn red, banner lists problems
    else etag differs from file on disk
        CS-->>API: ConfigConflict → 409
    else valid
        CS->>FS: copy config.yaml → config.backup.<timestamp>.yaml (keep newest 10)
        CS->>FS: write temp file, fsync, os.replace() over config.yaml
        API->>M: apply_config(new AppConfig)
        M-->>API: {restarted, started, stopped, added, removed, engine_reloaded, requires_server_restart}
        API->>API: retention cleanup with the (maybe new) retention_days
        API-->>UI: 200 → toast "Applied live: restarted cam3"
    end
```

**Why atomic?** The new text is written to a *temporary* file in the same folder, forced to disk
(`fsync`), and then swapped in with `os.replace()`. A rename is atomic: other programs see either
the whole old file or the whole new one, never half of each. The test
`test_atomic_write_never_corrupts_on_crash` simulates a crash right before the rename and checks
that the original file is intact and no temp file is left behind (`ConfigStore._atomic_write()`).

**Why an etag?** `GET /api/config` returns a short hash of the file text. If someone else saves
first, your save's etag no longer matches and you get a 409 instead of silently overwriting their
change.

**Form view vs Raw YAML view.** The form edits the raw document (with `${VAR}` placeholders kept
as text). Saving from the form rewrites the file with `yaml.safe_dump`, which drops comments, so the
header says so. Saving from the Raw YAML view writes your text **exactly**, comments included.
Switching views converts with `js-yaml`, and a YAML syntax error blocks the switch with a toast.
Both views are validated as you type (500 ms debounce, `POST /api/config/validate`). In the YAML
view, errors are mapped to line numbers by `config_store.py → _line_of()` and marked in red in the
editor.

**Form fields read the schema.** `GET /api/config/schema` returns the pydantic JSON schema.
`lib/configForm.ts → fieldMeta()` resolves a dotted path through `$ref` / `anyOf` / arrays to get
the field's `minimum`, `maximum`, `default` and `multipleOf`. These become the `<input min max step>`
attributes and the "min … · max … · default …" hints, so the form and the backend limits can't
drift apart.

### 12.2 Hot reload: who restarts?

`Monitor.apply_config()` compares the running config with the new one:

| What changed | What happens | Why |
|---|---|---|
| One stream's own settings (name, source, required PPE, enabled, confidence override) | **only that stream** is stopped and recreated | a `StreamWorker` bakes its settings in when created |
| `tracking`, `compliance`, alert rules, `process_width`, `max_fps_per_stream`, `jpeg_quality`, `frame_skip` | every stream restarts | these are copied into every worker |
| `model.*`, other `inference.*`, `tracking.low_thresh`, `min_person_height` | the **inference engine** is rebuilt (new model, warm-up) first, then swapped in; streams keep running | the model sits in the engine, not in the workers |
| `model.default_confidence` only | also applied live to cameras without their own override | slider start value |
| A stream added / removed | created (and started if enabled) / stopped | |
| `enabled: false` | that stream is stopped | |
| `server.*`, `alerts.db_path` | **not applied**; reported in `requires_server_restart`, and the UI shows a warning toast | a running web server can't move its own port |

We measured this on the running app. Renaming Camera 3 from the UI restarted **only cam3**: its
frame counter reset to 5, while cam1, cam2 and cam4 carried on from 155 to 177. The toast read
"Configuration saved · Applied live: restarted cam3."

A restarted camera's MJPEG response ends (`api.py → mjpeg()` notices the worker object changed).
The browser's `<img>` then gets an error, and `VideoView` reconnects 1.5 s later, to the new worker.

### 12.3 The violations database

```
violations
├── id           INTEGER PRIMARY KEY AUTOINCREMENT
├── ts           REAL     (unix epoch seconds, UTC)      INDEX
├── stream_id    VARCHAR(64)                            INDEX
├── stream_name  VARCHAR(128)
├── track_id     INTEGER
├── missing      TEXT     JSON list, e.g. ["helmet","vest"]
├── image        BLOB     full snapshot JPEG (quality = alerts.snapshot_quality)
└── thumb        BLOB     240px-tall JPEG thumbnail
```

- **Where:** `alerts.db_path`, by default `backend/data/violations.db` (in Docker, `./data/violations.db`).
- **Base64:** the API returns images as base64 strings. The browser shows them as
  `data:image/jpeg;base64,…`, and **Download** saves that data URI as a `.jpg`.
- **Filters:** `start` ≤ ts < `end` (epoch seconds; the page converts your local dates), camera =
  `stream_id`, and the PPE filter matches `missing LIKE '%"vest"%'`.
- **Pagination:** ordered by `(ts, id)` newest first. The next page is everything strictly older
  than the last row you have (`before_id`), so it stays correct while new violations keep arriving.
- **Retention:** `ViolationStore.cleanup(retention_days)` runs at startup, every hour
  (`retention_loop`) and after each config save. `retention_days: 0` keeps records forever.
- **Counts:** `count_today()` (since local midnight) is cached and refreshed on every add, delete
  or cleanup. It feeds the top bar and the sidebar badge.
- **Old data:** earlier versions saved JPEGs to `backend/snapshots/`. That folder is no longer
  written to, and its files weren't imported.

### 12.4 Snapshots: why they look different now

Before, the snapshot was cropped from the **annotated 960 px** frame. For a small worker the crop
was upscaled, so the burned-in labels covered most of the picture.
`annotate.py → violation_snapshot()` now crops from the **original 1920 px frame**, draws a single
red outline (with a dark edge) and one caption ("#45 NO helmet, vest, goggles"), and upscales to at
least 360 px tall. The result is readable evidence. It also makes model mistakes easy to spot: on
this footage, some workers in **blue hardhats seen from above** are still recorded as "NO helmet".
Delete those from the viewer, and see §5.5 on fine-tuning.

### 12.5 New quiz questions

11. Why does the Violations page paginate with `before_id` instead of `?page=3`?
12. You change `alerts.cooldown_seconds` on the Config page. Which cameras restart, and why?
13. The server crashes halfway through saving `config.yaml`. What does the file contain afterwards?
14. Where does the "N violations today" number come from, and when does it change?

**Answers:**

11. New violations are inserted at the top all the time. With page numbers, every insert shifts
    the pages and you'd see duplicates. "Everything older than row X" is stable.
12. All of them. The cooldown is copied into every camera's `AlertDebouncer` when the worker is
    created, so each worker must be recreated (`Monitor._worker_globals()`).
13. The complete old version. The new text went to a temp file, and only a finished, fsynced
    file is renamed over `config.yaml` (`ConfigStore._atomic_write()`).
14. `ViolationStore.count_today()` (rows since local midnight). It's included in every
    WebSocket `stats` message (4×/s) and bumped instantly by each `violation` event in
    `MonitorProvider`.

---

## 13. Update: sign-in, roles, audit log, analytics

### 13.1 New files

| File | What it does |
|---|---|
| `backend/app/security.py` | bcrypt hashing, password policy, JWT create / verify, the **role → permission matrix** (`ROLE_PERMISSIONS`), `AuthSettings` read from the environment |
| `backend/app/users_db.py` | SQLAlchemy tables `users`, `refresh_tokens`, `audit_log`; `UserStore` (users, sessions, the seed), `AuditStore` |
| `backend/app/auth.py` | FastAPI dependencies: `require("permission")`, `require_role(...)`, `current_user`; `ApiError` (403/401 with a `code`) |
| `backend/app/auth_routes.py` | `/api/auth/*`, `/api/users/*`, `/api/audit` |
| `backend/app/config_diff.py` | per-field config diff (for the audit log) and the Admin edit policy |
| `backend/app/analytics.py` | the six `/api/analytics/*` endpoints, all SQL aggregation |
| `frontend/src/lib/auth.ts` | the in-memory token, single-flight refresh, session-expired events |
| `frontend/src/state/auth.tsx` | `AuthProvider` / `useAuth()`: `user`, `can(permission)`, `login`, `logout` |
| `frontend/src/pages/LoginPage.tsx`, `ChangePasswordPage.tsx`, `UsersPage.tsx`, `AuditPage.tsx`, `AnalyticsPage.tsx` | the new screens |
| `frontend/src/components/analytics/charts.tsx` | small SVG charts (columns, line, bars, heatmap) with tooltips |

### 13.2 What happens when you sign in

1. The browser posts username + password to `/api/auth/login`. The server looks the user up,
   then runs `bcrypt.checkpw`. bcrypt is deliberately slow (about 0.25 s at cost 12), which is
   what makes stolen hashes hard to crack. If the username doesn't exist, it still checks
   against a dummy hash, so an attacker can't tell "no such user" from "wrong password" by timing.
2. It answers with an **access token**, a *JWT* (JSON Web Token): a small signed JSON document
   `{sub: user id, role, ver, exp}`. The signature uses `PPE_JWT_SECRET`, so nobody can forge or
   edit one without the secret. It expires after 15 minutes.
3. It also sets a **refresh token** as a cookie with the `httpOnly` flag. JavaScript on the page
   can't read httpOnly cookies, so even an XSS bug couldn't steal it. The cookie is only sent to
   `/api/auth/*` (`Path`), and never from other sites (`SameSite=Strict`).
4. The React app keeps the access token in a plain variable (`lib/auth.ts`), **not in
   localStorage**. localStorage is readable by any script on the page and survives forever;
   memory disappears when the tab closes. The price: after a reload the variable is empty, so
   the app immediately calls `/api/auth/refresh`, and the cookie gets it a new access token.
   That's the "Restoring your session…" moment.
5. Every API request adds `Authorization: Bearer <token>` (`lib/api.ts → request()`). If the
   server says 401, the app refreshes once and retries. If even that fails, `expire()` shows a
   "Signed out" toast and goes to the login page. It never fails silently.

**Why two tokens?** The access token is checked on every request without a database lookup of
sessions, and it's short-lived, so a leaked one is useful for only minutes. The refresh token is
long-lived but stored server-side (as a SHA-256 hash), so it can be revoked (logout), and it
**rotates**: every refresh hands out a new one and retires the old. If a retired one shows up
again later, someone copied it, so all of that user's sessions are revoked.

**Instant revocation.** Each user has a `token_version` number, and each access token carries
the version it was issued with (`ver`). A password change, reset, role change or deactivation
increments it, so `auth.user_from_token()` rejects every older token on the next request. The
WebSocket re-checks its token every 5 seconds (`Hub.close_revoked()`) and closes with code 4401.

**Video and WebSocket.** An `<img src=".../mjpeg">` and `new WebSocket(...)` can't add headers,
so these two take the token as `?access_token=...`. It is checked when the connection opens.
Normal API routes refuse query tokens.

### 13.3 The seed account and the forced password change

`create_app()` calls `UserStore.seed_default()`. If the `users` table is **empty**, it creates
`admin` / `mahindra123` (Super Admin, `must_change_password = true`) and logs a `SECURITY:`
warning. If any user exists it does nothing, so restarting never resets a password.

While `must_change_password` is true, `check_permission()` answers every route with 403
`password_change_required`. Only `/api/auth/me`, `change-password`, `refresh` and `logout`
work. In the browser, `App.tsx` shows `ForcedPasswordChange` instead of the app, whatever the
URL, with only "Change password" or "Sign out" as options. A Super Admin resetting someone's
password sets the same flag by default.

### 13.4 Roles

A **permission** is one capability (`config:system`, `users:manage`, …); a **role** is a set of
permissions (`security.ROLE_PERMISSIONS`). Routes declare the permission they need:

```python
@app.delete("/api/violations/{vid}")
def delete_violation(vid: int, user: User = Depends(require("violations:delete"))): ...
```

`/api/auth/me` returns the user's permission list; the sidebar and buttons use `can("...")` from
`useAuth()` to hide what the role can't use. **Hiding is only cosmetic.** The server checks
every call, and `tests/test_auth.py → test_every_api_route_requires_authentication` walks every
route to make sure none was forgotten.

The Config page is the subtle case. Admins may change a camera's name, source, enabled flag,
required PPE and confidence, but nothing else. The browser sends the whole config, so the server
compares it with the file field by field (`config_diff.admin_denied_changes()`). Any other
difference, or a camera added / removed / reordered, gets a 403 that names the fields. In the UI
those fields are disabled, and the sections are marked "Super Admin only".

### 13.5 The audit log

`AuditStore.record()` writes one row per action: time, who (username and role at that moment,
so the entry survives deleting the user), action, target, before/after JSON, IP. For config saves
the before/after is the **diff**, not the whole file: `{"alerts.retention_days": 30} →
{"alerts.retention_days": 7}`. Cameras are keyed by id, so removing camera 2 doesn't look like
"cameras 3 and 4 changed". Writing an audit row never raises: the action already happened,
and a logging failure must not turn it into an error.

### 13.6 Analytics: how the numbers are computed

Everything is one SQL query per chart, grouped in the database:

- **By day / by hour in *your* time zone.** Rows store UTC seconds. The browser sends `tz`
  (minutes east of UTC, +330 for India). Local day number = `floor((ts + tz·60) / 86400)`; the
  server fills missing days with zeros, so the chart doesn't draw a line across a gap.
- **Day of week** without date functions: 1 Jan 1970 was a Thursday, so
  `(day_number + 3) % 7` gives 0 = Monday … 6 = Sunday.
- **Missing-PPE counts** use SQLite's `json_each`, which turns the stored `["helmet","vest"]`
  into two rows, then `GROUP BY` item. A violation missing two items counts for both, so
  the bars can add up to more than the total.
- **Compliance rate** needs to know how many workers were seen, not just how many violated.
  The pipeline now counts that (`StreamWorker._count_obs()`): each track ID is counted once per
  camera session when its status is first determinable, and once more as "flagged" when it
  raises its first alert. Counts are written every 60 s into 15-minute buckets (`observations`
  table; 15 minutes lines up with every real UTC offset, including +5:30 and +5:45). Rate =
  (seen − flagged) / seen. Periods before this version have no counts, so they show "—".
- **Repeat offenders** group by camera + **camera session** (`run_id`, new column, set each time
  a camera starts) + track ID, because track IDs restart at #1 on every start. Without the
  session, "track #3" from Monday and from Tuesday would be merged into one fake person. Even
  so, a track ID is not a person: someone who walks out and back in gets a new ID. The page
  says this next to the table.

### 13.7 New quiz questions

15. Why is the access token kept in a JavaScript variable instead of localStorage, and what does
    the app do after a page reload to get it back?
16. An Admin edits `config.yaml` by hand in the browser's dev tools and sends `model.device: cpu`.
    What happens?
17. A Super Admin deactivates a user whose dashboard is open. What does that user see, and when?
18. Why does the heatmap need the browser's time zone?

**Answers:**

15. localStorage is readable by any script on the page and persists on disk, so an XSS bug
    could steal a long-lived credential. Memory is gone with the tab. After a reload the app
    calls `/api/auth/refresh`; the httpOnly cookie (which scripts can't read) is sent
    automatically and returns a new access token.
16. `PUT /api/config` diffs the submission against the file, finds `model.device` outside the
    per-camera fields, and returns 403 naming it. Nothing is written.
17. Their token version is bumped, so the next API call gets 401, the refresh fails too (the
    sessions were revoked), and the app shows "Signed out" and the login page. The WebSocket
    is closed within about 5 seconds even if they click nothing.
18. "Monday 09:00" only exists in a time zone. The database stores UTC; the same violation is
    03:30 UTC and 09:00 in India. The server shifts by the offset before bucketing.

---

## 14. Fix: bounding boxes that didn't hug the worker on snapshots

### 14.1 What was seen

On the Violations page some evidence snapshots showed the red box shifted from the worker, too big,
or (rarely) around machinery or two people at once. The live tiles looked better, but had the same
problem at a smaller scale.

### 14.2 How the cause was found (and what it was *not*)

Every usual suspect was measured on the real NVR footage, not guessed:

| Suspect | Test | Result |
|---|---|---|
| Inference-size → frame scaling | detector run on a real 1920×1080 frame, boxes drawn back on it, iGPU vs CPU, single vs batched | boxes identical and tight: **not the cause** |
| Letterbox padding not removed | signed per-edge error of 178 stored snapshots vs a high-res re-detection | mean bias 0.5 % of person height (none): **not the cause** |
| Frame race (box from frame N drawn on frame N+k) | at every alert, compared the full-res frame with the frame the model saw | pixel-identical (diff 0.0): **not the cause** |
| Crop offset in the snapshot | synthetic frame with a known "worker", then `violation_snapshot` | outline exactly on the known box: **not the cause** |
| Client-side redraw at a different size | code review | boxes are burned into the JPEG on the server: **n/a** |
| xyxy vs xywh | code review + the synthetic tests | xyxy everywhere: **not the cause** |

**Root cause.** The evidence box was simply whatever box the tracker held on the alert frame, and
that box is low quality for two reasons:

1. **A third of alerts (34 %) fired on a *coasting* box.** ByteTrack keeps a track alive with
   low-confidence detections (0.15 to the confidence threshold). Those boxes are often sloppy:
   partial bodies, two people merged into one box, or a "person" on a machine. Their median IoU
   against a careful re-detection was 0.73 (worst 0.18).
2. **Every box comes from a coarse pass.** The full frame is analysed at 480 px, so a distant worker
   is only ~35 px tall to the model. The box is accurate to roughly ±4–8 % of the person's height.
   The snapshot then zooms in 1.5–2×, which magnifies the error.

### 14.3 The fix (`pipeline.StreamWorker.evidence_box`, `AlertDebouncer.update(can_fire=…)`)

1. **Wait for a confident box.** An alert only fires on a frame where the worker's box comes from a
   confident detection (`alerts.require_confident_box`). The non-compliant streak keeps counting, so
   this delays an alert by a frame or two, never loses it.
2. **Re-detect the worker for the evidence.** At the moment of an alert (a rare event), the worker
   is re-detected at 640 px on a full-resolution crop of **the same frame** (`alerts.evidence_imgsz`).
   The re-detection that overlaps the tracked box best becomes the evidence box. There's no extra
   cost per frame, and no time lag.
3. **Drop phantom alerts.** If that high-resolution look finds no person at all, the "worker" was a
   false detection and the alert is not saved (`alerts.drop_unconfirmed`, counted as
   `alerts_dropped` on the System health page).
4. **Live overlay.** The person-crop pass (which already ran for PPE) now also replaces each
   worker's coarse box with the box re-detected on its crop (`ppe_logic.refine_person_box`).

Measured on real footage: median IoU of the drawn box vs a high-res re-detection **0.78 → 0.84**,
edge scatter **±5–8 % → ±1.5–5 %** of person height, boxes shifted sideways >3 % **18 % → 4 %**.
(The reference is the same model at high resolution, not hand-labelled truth. Contact sheets of
before/after snapshots were also checked by eye.)

**Regression tests** (`tests/test_box_alignment.py`): a synthetic 1920×1080 frame with a white
"worker" at known pixels plus a detector that finds bright rectangles, so every transform is checked
against a known answer. Process-res → full-res, crop offset, square letterbox and the snapshot
upscale are all covered; the stored snapshot's red outline must hug the worker within the stroke
width. With the fix switched off, the same test is off by 27–41 px.

---

## 15. Update: any camera, added from the UI (file, RTSP, HTTP)

### 15.1 The source interface (`backend/app/sources.py`)

```
 config.yaml / Config UI ──► SourceConfig {type, uri, username, password (encrypted), timeout, fps, priority}
                                  │  make_source(cfg)  →  SOURCE_TYPES registry
   ┌────────────────┬──────────────────┬────────────────────┬──────────────────┬─────────────────┐
 FileStreamSource  RTSPStreamSource   HTTPStreamSource    WebcamStreamSource ImageFolderStream  ONVIFStreamSource
 (loop, paced)     (FFmpeg, TCP,      (MJPEG push parser / (index)            Source             (placeholder: use
                    open/read timeout)  snapshot polling /                                         the RTSP URL)
                                        FFmpeg for HLS/MP4)
   └──────────── common interface: open() · read() · close() · available() · fps · recorded ─────────────┘
                                  │
                        FrameGrabber (1 thread per camera): latest-frame slot, drop counter,
                        reconnect with backoff → connecting · live · reconnecting · offline · no signal
```

Everything after the grabber (scheduler, model, tracking, alerts, analytics) doesn't know or care
which kind of camera it is.

- **RTSP** goes through OpenCV's FFmpeg backend over TCP, with open and read timeouts, so a dead
  camera fails in `timeout` seconds instead of hanging.
- **HTTP** sniffs the response once. `multipart/x-mixed-replace` is MJPEG push, parsed by our own
  JPEG-marker reader (robust to quirky cameras, Basic *and* Digest auth). `image/jpeg` is a
  snapshot URL, polled at `source.fps`. Anything else (HLS, MP4) goes to FFmpeg.
- **Credentials** never sit in the file or the UI in plain text. A password is stored as
  `enc:…` (Fernet; key from `PPE_SECRET_KEY`, else derived from `PPE_JWT_SECRET`). The API
  returns `********` in its place. `rtsp://user:pass@host` in a URI is moved into the
  username/password fields on save. The audit log shows a changed password only as
  `(set) → (set)`.
- **Offline** is shown after 30 s without frames; the tile shows "Offline" instead of freezing on
  the last frame. Reconnects are counted per camera.

### 15.2 How to add a camera (no code changes)

**From the UI** (Super Admin; *Config → Streams → Add camera*):

1. Pick the kind: *IP camera (RTSP)*, *IP camera (HTTP)*, *Upload a video file*, *Video already
   on the server*, *USB webcam* or *Folder of images*.
2. Fill in the name, URL (or pick / upload the file), and username + password for network cameras.
   Choose the required PPE and a priority.
3. Press **Test connection**. The server itself opens the source and shows the first frame, its
   resolution and fps, or the exact error (refused credentials, wrong path, timeout, unsupported
   codec).
4. Press **Add camera**. It's saved at once, backed up, audited, and the new camera starts; the
   others keep running.

Admins can change an existing camera's source, credentials, priority, enabled flag, required PPE and
confidence (and test it), but can't add or remove cameras.

**From config.yaml:**

```yaml
streams:
  - id: gate2                       # letters, digits, - and _ ; fixed once saved
    name: Gate 2
    source: { type: rtsp, uri: "rtsp://192.168.1.64:554/Streaming/Channels/101", username: viewer, password: "type it plain; it is encrypted on the next save from the UI" }
    required_ppe: [helmet, vest]
    priority: normal                # high | normal | low
  - id: dock
    name: Loading dock
    source: { type: http, uri: "http://192.168.1.70/video.mjpg", username: viewer, password: "..." }
  - id: yard-rec
    name: Yard (recording)
    source: { type: file, uri: "${PPE_VIDEOS_DIR:-../videos}/yard.mp4", fps: 20 }
```

**Testing without cameras.** `python scripts/camera_emulator.py http ../videos/x.cpv --port 8081
--user viewer --password p` serves a file as a real MJPEG IP camera. For RTSP, run an RTSP server
(e.g. MediaMTX) and publish a file into it with `ffmpeg -re -stream_loop -1 -i x.cpv -c copy -f rtsp
rtsp://127.0.0.1:8554/cam`. Both paths were verified end to end with the NVR footage: RTSP 1920×1080
at 20 fps with encrypted credentials (22 fps sustained read), and HTTP MJPEG with Basic auth. Wrong
passwords and paths give a readable error. The public RTSP test streams tried (rtspstream.com,
wowza demo and others) were unreachable from this network.

---

## 16. Update: scaling to 10–12+ cameras

### 16.1 What changed in the pipeline

| Before (4 cameras) | Now |
|---|---|
| 2 threads per camera (grabber + post-processing) | grabber thread per camera (blocking I/O) + **one bounded post-processing pool** (`inference.post_workers`, default half the cores, 2–8). At most one frame in flight per camera, so ordering is kept |
| every ready camera in one model call | at most `inference.max_batch` cameras per call; **scheduler** serves *high* priority first, then whoever waited longest (no camera starves) |
| a batch size was compiled for every camera count | batches padded to 1/2/4/8 on the OpenVINO GPU (a new shape costs ~1 s to compile); no padding on CPU/CUDA |
| same rate for every camera | `priority: low` = a third of the detection rate |
| one MJPEG HTTP connection per tile | video for all tiles over the **one WebSocket**, only for tiles on screen, never queued. Browsers allow ~6 HTTP/1.1 connections per host, so MJPEG tiles stopped at 6 |
| — | **Focus mode** (`inference.focus_pause_others`, off by default): while someone watches a camera full screen, the others keep their video (at `paused_preview_fps`) but skip detection. A lease that the page renews every 10 s means a closed tab can't leave cameras paused |
| — | **System health** page: detection / capture fps, dropped (stale) frames, reconnects, latency per camera; engine busy %, frames/s, batch size; host CPU / memory; a capacity verdict (ok / busy / saturated) |

Stale frames are still dropped, never queued, at every stage: a slow machine means fewer detections
per camera, never growing lag.

### 16.2 Dashboard for many cameras

The grid is 4 / 9 / 12 / 16 per page (2×2, 3×3, 4×3, 4×4) with pages, a search box, and status
filters (*Live*, *Problems*, *Violating now*) with counts. At 12+ per page, tiles switch to a compact
layout (video, name, status, workers / violations / fps); the controls are one click away in the
detail view.

### 16.3 Load test

See the numbers in §16.4 below. Method: `scripts/load_test.py` runs the full
pipeline (decode, detection with the person close-up pass, tracking, alerts, JPEG encode) for N
cameras made from the 4 NVR files (1080p H.265 at 20 fps; each file decoded by several cameras at
once, like N real cameras) plus live RTSP/HTTP cameras in the mixed run.

### 16.4 Load test results

Machine: i5-1135G7 (4 cores / 8 threads) + Iris Xe iGPU (OpenVINO), 2026-09-22. The app on :8000
was stopped for these runs; background load (browser, editor, RTSP test server) ~22 % CPU. Cameras =
the 4 NVR files (1920×1080 H.265, 20 fps), each decoded by several cameras at once; full pipeline
including the person close-up pass; 45 s measured after a 20 s warm-up.

| Cameras | Detection fps / camera | Total detections / s | Latency p50 / p95 | Model call | Engine busy | CPU |
|---|---|---|---|---|---|---|
| 4 | **5.8** | 23.2 | 125 / 204 ms | 130 ms (batch 2) | 100 % | 98 % |
| 6 | 1.8 | 10.7 | 266 / 531 ms | 226 ms (batch 3) | 99 % | 100 % |
| 8 | 1.4 | 10.9 | 406 / 891 ms | 261 ms (batch 4) | 99 % | 100 % |
| 10 | 0.65 | 6.5 | 1.1 / 2.0 s | 925 ms (batch 5) | 98 % | 100 % |
| 12 | 0.15 | 1.9 | 3.3 / 4.8 s | 5.2 s (batch 6) | 94 % | 100 % |

**Where it degrades, and why.** Past 4 cameras the *model calls themselves* slow down (130 ms → 5 s),
although the model didn't change: the CPU is saturated by **video decoding**. A decode-only benchmark
(`scripts/decode_bench.py`, no model at all) shows the whole CPU decodes about **185 frames/s of 1080p
H.265**. Four 20 fps cameras need 80/s (≈ 45 % of the CPU); twelve need 240/s, more than the CPU can
decode even with nothing else running (12 cameras reached only 9.6 of 20 fps each, decode alone).
Findings from tuning:

- **One decoder thread per camera** (`inference.decode_threads: 1`, now the default): decode-only
  throughput at 12 cameras went from 9.6 to 14.2 fps per camera (+48 %), because FFmpeg's default
  gives every camera all cores, and 12 cameras oversubscribe them.
- **iGPU hardware decode** (OpenCV/FFmpeg D3D11) was tried and is *slower* here (117 vs 185 frames/s
  at 12 streams, CPU still 100 %): copying frames back from the GPU costs more than it saves. Not used.
- Batching works as designed (batch grows 2 → 6), and no camera was starved (min ≈ mean per camera),
  but batching can't help when the CPU is the limit.

**Recommended on this laptop:** **4 full-resolution (1080p H.265, 20 fps) cameras** for real-time
detection (~6 detections/s each); **6–8** are still usable for compliance (1.4–1.8 detections/s each:
an alert needs ~4–5 s of a worker in view) with 0.3–0.9 s latency; **10+ are not recommended** on this
hardware with full streams. To go beyond that, reduce decode cost, which is the lever that matters:

1. use each camera's **sub-stream** (e.g. 640×360 or 704×576 H.264 at 10–15 fps; every NVR / IP camera
   has one): 9× fewer pixels to decode per camera (not measured here, see below). The evidence snapshot then has sub-stream resolution;
2. lower the camera's own frame rate to 10–12 fps (detection runs at a few fps anyway);
3. a machine with more cores, or an NVIDIA GPU (NVDEC decode + CUDA inference) for 16+ cameras.

(A sub-stream sweep was started, but the app on :8000 was restarted during it and took ~58 % of the
CPU, so those numbers were discarded rather than published. Re-run with the app stopped:
`python scripts/load_test.py --files <substream clips> --counts 4 8 12 16`.)

---

## 17. Update: the Analytics page, chart by chart

Every chart is labelled with the question it answers, and one filter row (dates, cameras, PPE types)
drives all of them. Every chart has a hover tooltip and a **Table** view with the exact numbers;
CSV / PDF export the current view.

| Question | Chart | Why this form |
|---|---|---|
| How are we doing right now? | KPI cards: total violations (vs previous period), compliance % (vs target), active cameras, avg detections / day | single numbers read faster than any chart |
| Are we improving or worsening? | line, daily / weekly (hourly for ≤ 2 days) | change over time = position along a line; weekly smooths day-of-week noise |
| Which camera has the worst problem, and with what? | horizontal bars stacked by missing item | length compares cameras; the segments answer "with what" in the same glance |
| What's the #1 gap? | donut + ranked list | part-to-whole of a handful of items; the list carries exact % (direct labels) |
| When do violations spike? | hour × weekday heatmap (sequential blue) | two time dimensions at once; shift changes show as dark columns |
| Who needs coaching? | top-5 horizontal bars by track ID | a ranking; **with the caveat that a track ID is not a person** (restarts per camera session; no re-identification) |
| Are we hitting our safety target? | compliance % line with the target line (`analytics.compliance_target`, default 95 %) | the gap to the line is the answer |
| Rank cameras for review | sortable table: violations, trend ▲▼ vs previous period, compliance, Δ, open items, main gap | a triage list: sort by what you care about |
| What fraction is failing? | detected → compliant → non-compliant bars | proportions of one whole, with counts |

Colours: a single series is blue. PPE items keep one fixed colour each (vest is always orange), so
colour follows the item, not its rank. The 7-colour order passed the palette validator (colour-blind
and normal-vision separation on white). Three colours are below 3:1 contrast on white, which is why
legends, tooltips and table views are always there. Status colours (green / red) appear only with a
text label.

Data notes. The PPE filter narrows the violation charts; compliance, worker counts and the funnel are
per worker (not per item), so they stay unfiltered, and the page says so. Compliance exists only for
periods the pipeline recorded worker counts (added 2026-09-22); earlier periods show "—".
