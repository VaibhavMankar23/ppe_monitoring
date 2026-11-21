# Changelog

All notable changes to the PPE Compliance Monitor. Dates are IST.

## [Unreleased] - 2026-10-29

Readiness work for the 30-45 camera plant roll-out: capacity, security, UI and acceptance testing.

### Detector efficiency (Nov 2026)
- **Changed:** the person-crop pass no longer fills its batch with blank images on NVIDIA GPUs and on the CPU. It
  did so everywhere, which was only needed on the Intel GPU, where every new shape recompiles. One worker in view
  meant 1 real crop and 7 blank ones; now only the real crops are sent. The Intel GPU keeps fixed shapes. Warm-up
  now runs every crop batch size where shapes are dynamic.
- **Changed:** when an ongoing violation gains a new missing item that the sharp check cannot confirm, the check is
  repeated at most every 3 seconds (`VERIFY_RETRY_SECONDS`). Before, it ran a 640 px model call on every frame
  for as long as the situation lasted. The item stays held back, as before, until a check confirms it.
- **Added:** "Where detector time goes" on System health: every model call of the last minute, by model and input
  size (full frames, person tiles, crops, evidence), with calls and images per second, time per call and per image,
  and each pass's share of the detector's time. It also counts person crops, blank crops and held-back
  re-checks, so the cost of every pass is measured and not estimated (`passtimer.py`).

### Camera order (Nov 2026)
- **Changed:** cameras are listed in natural order by name everywhere (Live wall and board, fleet board, Cameras
  and zones, System health, filters, search): numbers ascending (51, 54, 86, 100), then names with letters, and
  "Gate 2" before "Gate 10". Before, the order was the one they were added in. The order depends only on the name,
  never on status, so tiles still do not move when a camera goes down.

### Trust and deployment (Nov 2026)
- **Fixed:** System health showed 0 % host CPU and counted only the Python process. rtsps:// cameras are decoded by
  separate ffmpeg processes, so "This app" CPU and memory were about a third and a half of the real figures. One
  background sampler now measures the whole process tree every 2 s, so every browser sees the same steady numbers.
- **Added:** many cameras down at once now show one banner on Live and Command ("All 34 cameras are down") with the
  shared cause and what to do, instead of 34 identical tiles that each explain themselves on hover.
- **Added:** "This server" panel on System health: installation name, version, build (commit), address, whether the
  page is encrypted, what detection runs on (TensorRT, PyTorch, OpenVINO) and the memory, load and temperature of
  every GPU, with warnings for a full GPU, a PyTorch fallback and plain HTTP. The name and build are also in the
  sidebar footer. Set `PPE_SERVER_NAME` in `.env`; the update command in SETUP.md records the build.
- **Added:** "Forgot your password?" on the sign-in page says who can reset it and where.
- **Changed:** Live, Command and Act now never say "nobody unsafe" when no camera is delivering video.

### Add camera (Nov 2026)
- **Added:** adding a camera now shows what happened next. After Save the drawer stays open and says whether the
  camera connected (resolution and frame rate) or why not, with a "Fix the source" button.
- **Added:** a failed connection test asks before the camera is added ("Add anyway"); an untested camera is
  flagged next to the button. Saving is never blocked: a camera may be switched off for now.
- **Added:** plain-language causes and fixes for connection problems, in the test result, the camera editor and
  after adding. The "stored camera password can't be decrypted" case now names `PPE_SECRET_KEY`.
- **Added:** Duplicate (camera editor) and "Add another like this" (after adding) start a new camera with the same
  kind of source, user name, PPE rules and priority. The password is typed again on purpose: a saved password is
  only reused for the camera it was saved with.
- **Changed:** the source type is chosen from cards with a one-line description instead of a drop-down.
- **Not yet:** adding many cameras at once from a list of addresses.

### GPU servers (Nov 2026)
- **Fixed (high):** on a GPU server with too little free memory the app crashed at start and Docker restarted
  it in a loop (`OutOfMemory` while loading the TensorRT engines). It now logs a clear error and runs the same
  models with PyTorch, which needs much less GPU memory. Free the GPU and restart to get TensorRT back.
- **Added:** with several NVIDIA GPUs, `PPE_DEVICE=auto` (or `cuda`) now uses the one with the most free memory,
  chosen once so every model shares a card. `cuda:0` / `cuda:1` still pin a specific one.

### UI standard v4 (Nov 2026)
- **Changed:** every page now follows one standard layout: a left menu grouped by job (Operate: Command, Live,
  Review; Analyse: Insights; Configure: Cameras & zones, Detection, System health, People, Audit trail) and a
  slim top bar with search (Ctrl K), live status, notifications, sound, theme and account. Below 1024 px the
  menu is a drawer.
- **Changed:** light theme by default, following the operating system until someone picks a theme (the choice
  is remembered). Full dark theme kept. Text meets WCAG AA contrast in both.
- **Changed:** Mahindra red is used for identity only (logo, active menu item). Interaction and data use one
  blue, primary buttons are ink, and alarms use a separate crimson. Status is always shown with a word or icon,
  never by colour alone.
- **Changed:** IBM Plex Sans / Plex Mono, tighter corners (8 px controls, 10 px cards), no glow or gradients,
  a status edge on the Command summary, and a brand sign-in page that follows the theme.
- **Changed:** the Command page follows the approved prototype: a status summary with an "Act now" list
  (live picture with boxes, who is flagged and what is missing, "Open camera"), four key-figure cards with
  a pill, a small graphic and one line of context, a camera fleet with Unsafe / Not delivering filters and a
  legend, a compliance trend that marks days below target in red, what is being missed, a latest-events table
  with a Review button on each row, and the hour-by-weekday heatmap. Every figure is live data.
- **Changed:** Add camera: the source type is now a set of option cards with a one-line description each (IP camera
  RTSP first), Test connection says why it is unavailable and stacks on phones, the video list no longer shows the
  server's full folder path, and upload limits read in GB.
- **Added:** "Page not found" for unknown addresses; the Cameras page no longer scrolls sideways on phones.
- **Unchanged:** every feature, permission, shortcut and API call. The Setup tab strip is replaced by the menu.

### End-to-end QA round (Nov 2026)
- **Fixed (high):** a model path that could not be loaded was written to `config.yaml` and then failed
  with a bare 500, so the next restart would not boot. The new model is now loaded before anything
  changes; on failure the save is refused (422) and the old file and settings stay.
- **Fixed (high):** values the loader rejects (`server.port: 70000`) were accepted while an environment
  variable (`PPE_PORT`...) overrode that key. The value written in the file is checked too.
- **Fixed (high):** a camera could be saved with a file path anywhere on the server. File and
  image-folder cameras must be inside the videos folder, as for Test connection (existing cameras are
  not affected).
- **Fixed:** "Reset to defaults" returned a 500 when `config.yaml` lives outside `backend/`
  (`PPE_CONFIG`); it falls back to the defaults shipped with the app.
- **Fixed:** uploads accepted empty and non-video files; they are now refused and nothing is kept.
- **Fixed:** saving now refuses misspelt (unknown) settings, an enabled webhook or email alarm that
  cannot work, a camera with no PPE and no other check, blank camera names and two cameras with the
  same name. Settings already in an existing file are left alone so it still loads.
- **Fixed:** an access token kept working for up to 15 minutes after signing out.
- **Fixed:** `/docs` and `/openapi.json` were open without signing in. They are now off; set
  `PPE_API_DOCS=1` for development.
- **Fixed:** a camera that refuses the connection at once was reported as "cannot connect within 10s".
- **Fixed:** the Cameras page scrolled sideways on phones and tablets; an unknown address now shows
  "Page not found" instead of another page; usernames must be 3-32 characters (as the message says).
- **Changed (rtsps cameras):** ffmpeg now sends at most 8 frames/s through the pipe instead of every
  frame, cutting the per-camera conversion and copy cost by about two thirds on a 25 fps camera.
- **Known limitation:** for `rtsps://` cameras the camera URL, including its password, is an argument of
  the `ffmpeg` / `ffprobe` processes, so other users on the same machine could read it with `ps`.
  Inside the Docker container only the app can. Do not give other people shell access to the server.

### Live camera testing fixes
- **Fixed (high, issue #29):** different workers were merged into one long violation event, so
  violations were missed. An event now matches new workers only against boxes of its workers seen
  within `alerts.event_gap_seconds`, not every box it ever had.
- **Fixed (high, issue #30):** enabling the phone model needed a restart before phone use was
  actually checked. Cameras now re-learn what the model can detect whenever it is reloaded.
- **Fixed:** `requests` (HTTP cameras, webhook alarms) is now listed in `backend/requirements.txt`
  instead of arriving only as a dependency of `ultralytics`.
- **Fixed:** a password typed into the camera URL (`rtsp://user:pass@host/...`) was ignored while the
  form held a stored password, so a link that worked in a terminal failed in the app. Credentials in
  the URL now replace the stored ones, for Test connection and on save.
- **Added:** `docker-compose.gpu.yml` gives the container the NVIDIA GPU (add it to `COMPOSE_FILE`
  in `.env`), instead of uncommenting a block in `docker-compose.yml`.

### Security
- **Fixed (critical):** an encoded `../` in a URL let anyone download server files without
  signing in. The UI route now serves only files inside the built UI folder.
- **Fixed (critical):** camera fields could expand server environment variables (such as the
  session secret) and echo them back. Camera fields now expand only `${PPE_VIDEOS_DIR}`.
- **Fixed:** a masked camera password is re-sent only to the same camera address (scheme, host,
  port); a changed address requires the password again.
- **Fixed:** camera addresses must be `rtsp(s)://` or `http(s)://`; recordings and image folders
  must be inside the videos folder.
- **Changed:** no published default password. The first Super Admin gets
  `PPE_INITIAL_ADMIN_PASSWORD` or a random one-time password printed once in the log.
- **Changed:** sign-in lockout doubles on each repeat (up to 1 hour) and is also counted per
  account across all IPs.
- **Changed:** Admins no longer see the SMTP password or webhook URL; the photo dataset export is
  Super Admin only (new permission `violations:export_images`).
- **Added:** Content-Security-Policy and other security headers; CORS closed by default;
  CSV exports escape formula cells.
- **Added:** `PPE_TRUSTED_PROXIES` so the real client IP is used behind a reverse proxy.
- **Changed (Docker):** the container runs as an unprivileged user (`PPE_UID` / `PPE_GID`);
  `.env` and database files are never copied into the image.
- **Changed:** Ultralytics 8.3.41, 8.3.42, 8.3.45 and 8.3.46 (compromised releases) excluded.

### Capacity and detection
- **Added:** capacity planner on System health: detector cost per frame, cameras that fit at
  1/2/3/5 fps, and whether 30 and 45 cameras fit.
- **Changed:** video capture converts and resizes only frames that will be analysed (about 33%
  less decoding CPU per camera).
- **Changed:** default detection limit lowered from 15 to 3 fps per camera (`config.default.yaml`).

### Detection accuracy
- **Fixed (no violations on a busy server):** tracking and confirmation assumed a decent frame rate.
  With 6 cameras and the person detector on the i5 laptop a camera got a frame only every few
  seconds: the tracker forgot every worker after a fixed 2 s and matched only by box overlap, so
  each worker got a new ID every frame (Gate No. 2: 256 IDs in 150 s), and "6 frames in a row"
  could never be reached (0 violations in 150 s). Now the tracker keeps a worker for at least 3
  frames at the camera's actual rate and also matches by distance in body heights (walking workers
  no longer overlap their old box), and confirmation / smoothing use about 3 s of frames (2-6
  frames). Measured after the fix on the same cameras: 56 violations in 3 minutes, on every camera.
- **Fixed (duplicate violation, #1165 / #1167):** a walking worker lost by the tracker and picked up
  again under another ID 2 s and ~1 body height further on became a second violation, because an
  event only accepted a new ID within a fixed 0.75 body heights. The distance now grows with the
  time since the worker was last seen (0.75 + 0.5 per second, at most 2 heights).
- **Added (biggest gain):** dedicated person detector (`model.person_weights`, default the COCO
  `models/coco/yolov8n.pt`) on 2x2 overlapping tiles (`model.person_tiles`), merged with the PPE
  model's own person boxes; PPE is then judged on each worker's full-resolution crop. On wide plant
  cameras the PPE model alone found almost nobody: Sixth Floor 0.16 workers in view on average (none in
  84 of 100 samples), T-F 0 (none in 100 of 100); with the person detector 4.1 and 3.6, with every
  sample finding someone. Checked by eye: the new boxes are real workers (a few thin far-away boxes may
  be posts; they are too small to judge, so they never alert). Cost: detection ~4x on a CPU
  (69 -> 286 ms/frame on the i5 laptop), cheap on a GPU. Settings > Detection can turn it off.
- **Fixed:** recordings with a corrupt frame (common in NVR H.265 exports) restarted at that frame, so
  the demo camera Gate No. 2 replayed its first 55 s forever and showed the same people again and
  again. Up to 50 unreadable frames in a row are now skipped; files decode to the end.
- **Added:** claim verification (`alerts.verify_claims`, on): the existing sharp full-resolution evidence
  pass now also re-checks every claimed missing item on that worker (not a neighbour). Items it
  clearly shows worn are dropped; an alert with nothing left is not raised (System health: "Alerts
  disproved"). Items added later in an ongoing event get the same check before they are written.
- **Added:** minimum worker size per item (`compliance.item_min_height`): mask 90 px, goggles and ear
  protection 110, gloves 100 (at process width). Smaller workers get "unknown" for those items, never
  "missing".
- Measured on 6 minutes of three recordings (claims checked by eye): "no helmet" claims 80% correct
  (10 claims, 2 workers in white hard hats) before, 92% (12 claims, 1 wrong) after; hard-hat wearers
  wrongly flagged 2 of 3 before, 1 of 4 after. The remaining error is a hand covering the hard hat.
  Known model limit: a white shirt can score as a hi-vis vest (~0.33), so "no vest" on white shirts
  flickers; fine-tuning on plant footage is the fix.

### Compliance figures
- **Fixed:** "workers seen" and "workers flagged" counted tracking IDs, so a worker re-acquired under a
  new ID after an occlusion was counted again. Measured on 57 s of Gate No. 2: 123 IDs (8 fps) /
  31 IDs (1 fps) for roughly 20-26 people checked by eye. They now count people
  (`violations.PresenceCounter`): a new ID is the same person when it overlaps someone in view, or
  appears near where someone left view at most 6 s earlier (radius grows with the time lost, at most
  2 body heights). Same clip: 26 (8 fps), 22 (2 fps), 14 (1 fps; people crossing between samples
  are never seen). Compliance % is therefore lower and closer to reality than before this change;
  figures stored before it stay as they were.

### Unnecessary work removed
- **Changed:** camera pictures for viewers are drawn (boxes) and JPEG-encoded only when someone watches,
  at the size asked, once per frame and size (cached), and off the server's event loop. Before, every
  camera drew and encoded every analysed frame even with nobody on the Live page.
- **Changed:** Live wall tiles ask for a picture that fits the layout (3x3: 640 px, 4x4: 480 px, times the
  screen's pixel ratio; 2x2, the camera window and full screen: full size). Measured on the 3x3 wall:
  ~132 KB -> ~62 KB per frame (about 53% less). At 45 cameras on a 16-tile page this is the difference
  between ~50 and ~15 Mbit/s per viewer.
- Checked per section over 30 s: video flows only on Live and stops when you leave; every page's
  timers end when you leave it; app-wide only the Review count (every 30 s) and the live status feed.

### NVIDIA GPU
- **Added:** TensorRT on NVIDIA GPUs (`model.tensorrt`, on by default): the model is built once into an
  FP16 engine with dynamic batch (1-32) and image sizes, cached next to the weights, about 2-3x
  PyTorch (estimate). Falls back to PyTorch if the build fails, the engine does not load (other GPU
  or TensorRT version), or a pass needs a larger image than the engine supports.
- **Added:** automatic batch sizes per device: `inference.max_batch` and `refine_batch` default to 0 =
  auto (NVIDIA 16 frames / 8 crops, Intel GPU 8 / 4, CPU 8 / 2). Explicit values still win.
- **Changed (Docker):** GPU builds (`TORCH_INDEX=cu*`) install TensorRT, ONNX and onnxruntime-gpu.
- Not yet run on a real NVIDIA GPU: covered by 13 unit tests with a simulated GPU; confirm on the
  plant server (see `docs/DEPLOYMENT.md`).

### UI
- **Changed:** Command no longer streams live video; an "Act now" list shows each unsafe camera,
  how many workers, what PPE is missing and where, and opens the camera on Live.
- **Changed:** Review evidence image about 35% larger; Valid / False alarm buttons stay visible.
- **Changed (adding a camera):** "Add camera" is one short page with only what is needed: name, video
  source (type; address with optional username / password, or a video file / upload; Test connection)
  and required PPE (only items the loaded model can detect; helmet and vest preselected). Camera ID
  (from the name), enabled, confidence, priority, phone use, timeouts, playback rate, loop and zones
  keep their defaults and are set later when editing the camera, which still shows every setting.
- **Changed (opening a camera):** a camera now opens in a centred window (was a side panel) that
  shows only the camera: name, live status, Full screen and Close, no technical details (on request).
  Camera settings (on / off, confidence, required PPE, zones) are in Setup > Cameras & zones; detection
  figures in Setup > System health; the per-camera "boxes" switch was removed (boxes stay on). **Full screen** (button, double-click on the
  video, or F) uses the browser's full-screen mode so the camera fills the monitor, with its name,
  status and an "Exit full screen" button overlaid; an in-app full window is used where the browser
  refuses. Esc leaves full screen first, then closes the window. Tested in Chrome: centred (equal
  gaps), full screen 1366x768 of 1366x768, F toggles, Esc closes and the page scrolls again.
- **Removed:** the Live events list on the Live page (on request); the video wall uses the full
  width. New violations still appear in Review, the bell menu and Command's Latest events, and
  still chime.
- **Changed (camera order):** cameras are shown in their configured order everywhere (Command fleet
  and Act now, Live wall and board, compliance per camera, System health, Insights per camera)
  instead of unsafe / down first or worst first. Re-sorting by status moved video tiles and list rows every time a camera changed state;
  colour now marks the cameras needing attention. Order set in Setup > Cameras & zones.
- **Fixed (page could stop scrolling):** every dialog / drawer saved the page's scroll setting on open
  and put it back on close. With two open (e.g. a confirmation over a side panel) and closed or left
  in the other order, the last one put back "locked" and the whole app stopped scrolling until a
  reload. Scrolling is now locked exactly while any overlay is open, and always given back when you
  change page. Tested: two overlays open, page left, page scrolls normally.
- **Added (Review: full-screen review):** "Full screen" button, a click on the evidence, or Z. The
  evidence fills the screen (Evidence / Person crop / Original frame, actual-size zoom with panning,
  download); verdict and details beside it; "3 of 29" with Previous / Next. J / K (or arrows) move
  without leaving it, V / F judge, Esc closes the reason picker first and then the view. Only the
  top-most view reacts to keys, so a verdict is never recorded twice (tested: one key press, one
  verdict).
- **Fixed (Command page moved up and down):** the top section grew and shrank with the number of
  unsafe cameras (1-5 rows), so every camera turning unsafe or safe pushed the whole page. It now
  has a fixed height on desktop: "Act now" is a compact list (count, camera, missing PPE) that
  scrolls inside its own box, and an all-clear state fills the same space. Measured over 90 s of
  live data: 14 list changes, page position unchanged (0 px).
- **Fixed:** the top bar overflowed on 1366 px laptops ("Setup" cut off). The camera count in the
  status badge and the sound prompt's text show in full only on wide screens (tooltips otherwise).
- **Added:** sound on new incidents: a short two-tone chime (at most one per 10 s), on by default,
  with an on/off button in the top bar remembered per browser. While the tab is in the background
  its title flashes "(N) Unsafe worker" until someone looks at it.
- **Fixed:** the chime could stay silent with no sign why. Browsers block sound until the page has
  been clicked, and a dashboard opened by bookmark or at PC start-up never is. The top bar now shows
  "Click to turn on sound" while sound is blocked; one press enables it and plays a test chime. A
  chime raised while blocked plays once sound is allowed (at most one, never a backlog).
- **Changed:** "Compliance today" says "Calculating…" (workers in view) or "No workers checked yet"
  instead of "-" during the first minute; header badge reads "N unsafe now · 6/6 cameras live";
  the Insights page is titled Insights (was Reports).

### Tests and documentation
- **Fixed:** 9 backend tests that failed because their fixed-date data aged past the 30-day
  retention. 307 tests pass (11 security, 13 GPU, 8 people-counting, 16 accuracy, decoding and low-frame-rate tests, 1 camera-order test, 1 on-demand encoding test).
- **Resolved:** DEF-001 ('Compliance today' showing '-').
- **Added:** UAT pack (76 cases), automated UAT suite, first run report (52 of 52 passed). Kept
  internal: not part of the client release.
- **Added:** `docs/DEPLOYMENT.md`, `docs/SECURITY.md`, `docs/CAPACITY_PLANNING.md`,
  `docs/UAT_TEST_PLAN.md`, HTTPS deployment files in `deploy/`.

### Configuration changes to apply on existing installs
- Docker: `sudo chown -R 1000:1000 config data videos models` once (the container is no longer root).
- Set `PPE_SECRET_KEY` before adding cameras, and keep it (see `.env.example`).
- Set `PPE_CPUS` on the plant server (compose default is 4).
- The local test camera Gate No. 2 now requires only helmet, vest and mask.

## 2026-10-27
- Redesigned frontend (Command, Live, Review, Insights, Setup), zones and review workflow.

## Initial release
- PPE monitoring system: backend, frontend, models, docs.
