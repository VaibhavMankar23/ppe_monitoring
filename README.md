# PPE Compliance Monitor

A real-time dashboard for checking PPE compliance on any number of cameras (video files, RTSP and
HTTP IP cameras, webcams; added from the UI). Everything is behind a sign-in
with two roles (**Admin**, **Super Admin**, see [Authentication and roles](#authentication-and-roles)).
The web app has these pages:

- **Live** (`#/live`). The camera wall: every camera as the detector sees it, with who is in
  violation right now, a live feed of the latest violations, and a per-camera detail view (video,
  zones, the workers in view and why each is flagged, start/stop, boxes, confidence).
- **Review queue** (`#/review`). Every violation with its evidence. A reviewer marks each one
  **Valid** or **False alarm** (with a reason); verdicts feed the alert-precision figure and the
  retraining dataset export. Keyboard-driven (J/K, V, F).
- **Analytics** (`#/analytics`). Compliance rate against target, trend, violations by camera and
  type, hour × weekday heatmap, alert precision and false-alarm reasons, repeat tracks. CSV / print.
- **Cameras & zones** (`#/cameras`). Add and edit cameras, and draw **zones** on the image: where
  PPE is checked, where it is ignored, and which areas are restricted.
- **Settings** (`#/settings`). Model, performance, tracking, compliance rules, alerts and retention,
  alarms, raw YAML, backups. Changes are **applied without restarting the server**.
- **System health** (`#/system`). Whether the detector keeps up, and whether each camera delivers.
- **Users** and **Audit log** (Super Admin only).

Old links (`#/dashboard`, `#/violations`, `#/config`, `#/add-camera`) redirect to the new pages.

```
backend/   FastAPI + Ultralytics YOLO + OpenCV + SQLAlchemy  (app/, config.yaml, config.default.yaml, tests/, scripts/)
frontend/  React + Vite + Tailwind + Recharts (light theme; routes #/live #/review #/analytics #/cameras #/settings #/system #/users #/audit)
videos/    your camera clips / NVR exports (see videos/README.md)
models/    PPE weights (default: models/safesight/best.pt)
```

## Quickstart

**Windows, as set up on this machine**

```powershell
D:\ppe_pretrained\start.bat          # then open http://localhost:8000
```

**Docker**

```bash
cp .env.example .env                 # then set PPE_JWT_SECRET (compose refuses to start without it)
docker compose up --build            # open http://localhost:8000
```

The first start copies `backend/config.default.yaml` to `./config/config.yaml`. Config edits and
their backups live in `./config`, and the violations database in `./data`. Both are host folders,
so they survive container rebuilds.

**Local from scratch (Python 3.11 + Node 20+)**

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu && .venv/Scripts/pip install -r requirements.txt
cd ../frontend && npm install && npm run build   # builds the UI into frontend/dist
cd ../backend && .venv/Scripts/python run.py     # serves API + UI on http://localhost:8000
```

### First sign-in

> ⚠️ **Default account: change this in production.** On the very first start (empty `users`
> table) the server creates **`admin` / `mahindra123`** with the **Super Admin** role and logs a
> `SECURITY:` warning. That password is public (it's in this README). The first sign-in is forced
> onto a "Set a new password" screen that can't be skipped, and the server refuses every other API
> call until the password is changed. The seed never runs again once any user exists. Do the first
> sign-in yourself right after installing, before the app is reachable by anyone else.

Set **`PPE_JWT_SECRET`** (a long random string: `python -c "import secrets; print(secrets.token_urlsafe(48))"`)
in `backend/.env` (local run) or `.env` (docker compose). Without it, the server signs tokens with
a random per-process secret and warns; everyone is signed out on each restart.

For UI development with live reload, run `npm run dev` in `frontend/` (port 5173; it proxies `/api`
and `/ws` to :8000).

`backend/config.yaml` starts with **no cameras**: sign in as a Super Admin and use **Add camera** (on the
Dashboard, or Config → Streams) to add RTSP / HTTP IP cameras, upload a recording, or pick a file already
in `videos/`. Raw NVR exports such as `NVR_ch20_main_*.cpv` (H.265 behind a small `ADIT` header) play
directly; they carry no frame rate, so set **Playback FPS** to the recorder's rate (20 for these). A
recording loops like a live camera.

## Pages

### Live (`#/live`)

A status strip (in violation now, workers in view, cameras live, violations today), the camera
grid (filter: all / in violation / problems; three tile sizes) and the latest violations, updated
live. All tiles share one WebSocket and only tiles on screen receive video. A tile shows the
camera's status, how many workers are in violation, and its detection rate and delay. Click it for
the detail view: large video with the zones drawn over it, a table of the workers in view (status,
each check, the zone they stand in), throughput figures, the controls (start/stop, boxes,
confidence) and that camera's latest violations.

### Zones (`#/cameras` → a camera → Zones)

A zone is a polygon drawn on the camera image (stored as fractions of the frame in
`streams[].zones`). The point that decides is the bottom-centre of the person box (the feet), so
zones are drawn on the floor.

| Type | Effect |
|---|---|
| `monitor` | With at least one monitor zone, PPE is judged only for workers standing inside one. |
| `ignore` | Workers standing inside are never judged (walkways, offices seen through a window). Wins over `monitor`. |
| `restricted` | Standing inside is itself a violation, `restricted_area`, whatever PPE is worn. |

A worker outside the monitored area is still tracked and shown (thin grey box) but is "not
judged": no violation, and not counted in the compliance rate. No zones = the whole frame is
monitored, as before. Logic: `ppe_logic.apply_zones` / `mask_unmonitored`; tests: `tests/test_zones.py`.

### Review queue (`#/review`)

Every violation is stored in SQLite (`alerts.db_path`, default `backend/data/violations.db`) with: id,
timestamp, camera, track ID, missing-PPE list, evidence images, a thumbnail and provenance metadata.

**How a violation is created** (`backend/app/violations.py`):

1. **Confirmation.** A worker must be non-compliant on `alerts.min_violation_frames` consecutive
   processed frames *and* for at least `alerts.min_violation_seconds` (default 1 s). A compliant or
   undeterminable frame resets this, so one unreliable frame never becomes a violation.
2. **One violation per event.** While the worker stays non-compliant, the stored violation is
   *extended* (last seen, duration, observation count, newly missing items), not duplicated. The
   event ends after `alerts.event_gap_seconds` (default 10 s) without the violation. A new violation
   for the same worker needs the event to have ended **and** `alerts.cooldown_seconds` since it began.
   Tracker ID switches, double captures and a "group" box around workers standing together join
   the same event.
3. **Evidence from the best frame** of the confirmation window (confident, large, fully in frame,
   clearly detected violation), not simply the frame that confirmed it. One event = one set of
   evidence, written once and never rewritten:
   - **Evidence image:** outlined full-resolution crop under a header with camera, local time,
     track, person confidence and each violation's detection confidence ("not seen" = required PPE
     absent under the strict policy);
   - **Person crop:** the clean full-resolution crop; **Original frame:** the clean full frame
     (`alerts.save_original_frame`);
   - **Metadata:** model (weights file + SHA-256, runtime, device, image size), the rules and
     thresholds in force, a config hash, full-res box, per-item confidences, lifecycle times
     (detected → confirmed → evidence frame), and SHA-256 of each stored image.

Lifecycle shown in the viewer: **Detected → Confirmed → Ongoing / Ended → Acknowledged**.

- **List and detail.** Rows are grouped by local day, newest first, with keyset pagination (no
  duplicates while new alerts arrive). Filters: review state (unreviewed / valid / false alarm /
  all), camera, violation type, date range. The detail pane shows the evidence (Evidence / Person
  crop / Original frame), per-item confidence, the lifecycle and "How this was detected".
- **Verdicts.** `POST /api/violations/{id}/review` with `{verdict: "valid" | "false_alarm" | null,
  reason, note}`. A false alarm needs a reason (PPE was worn, not a person, wrong person, not
  required here, duplicate, poor image, other): each reason points at a different fix. Reviewing
  also acknowledges the violation. Every verdict is in the audit log.
- **Alert precision** = valid / reviewed, shown in Analytics with the false-alarm reasons. It
  measures how many raised alerts were real; it says nothing about violations the system missed.
- **Export dataset** (`GET /api/violations/dataset`) downloads a YOLO-layout zip of the clean
  original frames with a `person` pre-label each and a `manifest.csv` carrying the verdicts, to
  correct in an annotation tool and retrain on. "Not a person" false alarms become hard negatives.
- **Live:** new violations appear as they are confirmed; ongoing events are marked *Ongoing*.
- **Export CSV** exports the current filter (now with the review columns).
- **Retention:** records older than `alerts.retention_days` (default 30; 0 = keep forever) are
  deleted at startup, hourly, and after every config save. `alerts.evidence_retention_days`
  (default 0 = keep with the record) removes only the images of older, ended violations; the
  record, metadata and thumbnail stay. Both are logged.

Snapshots are cut from the **clean full-resolution frame**, with one outline and one caption, so
the worker stays visible as evidence. They aren't taken from the downscaled, label-covered live
overlay.

### Settings (`#/settings`) and Cameras (`#/cameras`)

Cameras (source, rules, zones) are edited on the Cameras page; everything else on Settings. Both
save the same `config.yaml` through the same validated, backed-up, hot-reloaded path:


- **Form view** in sections:
  - **General:** server, compliance rules.
  - **Model:** weights, device, default confidence, NMS IoU, image size, OpenVINO.
  - **Tracker.**
  - **Streams:** per camera: name, source type + path / RTSP URL / webcam index, playback FPS,
    enabled, required-PPE multi-select, confidence override. Cameras can be added and removed.
  - **Violations:** confirmation (frames + seconds), event gap, new-violation cooldown, snapshot
    quality, keep original frame, retention days, evidence image retention.
  - **Performance:** frame skip, downscale width, max FPS, JPEG quality, close-up pass.
- **Raw YAML view** has syntax highlighting and line numbers. It's validated as you type, and
  errors point at their line. Comments are kept when you save from this view.
- **Buttons:** Save, Discard changes, Reset to defaults (`config.default.yaml`), Restore from
  backup. **Cameras are protected:** Reset to defaults resets every *setting* and keeps the cameras
  (a full factory reset is an explicit extra option); any save, reset or restore that would remove
  a camera is refused by the server until the user confirms the named cameras, and the UI shows
  the camera changes (removed / source or enabled changed) before saving.
- **Model capabilities:** PPE items the loaded model can't detect are shown struck through as
  "not checked" (Streams, Add camera, dashboard tiles, camera detail). "Detect phone use" warns
  when no phone model is configured — the phone model is a separate, additional detector. An *Unsaved changes* badge shows when you have edits, and leaving the page with unsaved
  edits asks for confirmation. Results appear as toasts.
- **Validation:** pydantic, with field-level errors (for example
  `streams.1.source.uri: String should have at least 1 character`). Invalid input is never written.
- **Every save** first copies the current file to `config.backup.<YYYYMMDD-HHMMSS-ffffff>.yaml`
  (the newest 10 are kept). It then writes a temp file, fsyncs it, and atomically renames it over
  `config.yaml`, so a crash can't leave a half-written file.
- **Hot reload** (`Monitor.apply_config`):
  - Only streams whose own settings changed are restarted, along with any global setting baked into
    workers (tracker, compliance, alert rules, downscale / FPS / JPEG / frame skip).
  - Model and engine changes rebuild the inference engine while cameras keep running.
  - Added cameras start, and removed ones stop.
  - `server.*` and `alerts.db_path` need a process restart; the response says so.
  - The save toast lists what was restarted, e.g. *"Applied live: restarted cam3."*
- **Concurrency:** saves carry an `etag`, and a stale one returns 409 instead of overwriting
  someone else's change.

## Authentication and roles

**Flow.** `POST /api/auth/login` checks the bcrypt hash (cost 12; unknown usernames take the same
time) and returns a **15-minute access token** (JWT, HS256, signed with `PPE_JWT_SECRET`). The
**refresh token** is opaque, stored only as a SHA-256 hash, and set as an **httpOnly,
SameSite=Strict cookie scoped to `/api/auth`**. It is never in the JSON (unless a script asks with
`"token_transport": "body"`), so page scripts can't read it.

- The SPA keeps the access token **in memory only**, never in localStorage. A page reload calls
  `/api/auth/refresh`, and the cookie restores the session. "Remember me" makes the cookie
  persistent for 30 days; without it the cookie ends with the browser session, and the server
  also ends an idle session after 12 hours.
- Every API call sends `Authorization: Bearer …`. The token is renewed a minute before it
  expires. A 401 triggers one refresh and a retry; if that fails, the user sees a "Signed out"
  toast and lands on the login page, then goes back to the page they were on.
- Refresh tokens rotate on every use. Re-using an old one (after a 30-second grace for two tabs)
  is treated as theft and revokes all of that user's sessions. Logout revokes the session.
- Changing / resetting a password, changing a role and deactivating all bump the user's
  `token_version`. Existing access tokens stop working immediately, and open WebSocket
  connections are closed within about 5 seconds.
- `<img>` MJPEG streams and the WebSocket can't send headers, so they take `?access_token=`,
  checked when the connection opens. That's the only place a query token is accepted.
- 5 failed sign-ins for the same user and IP within 5 minutes → 60-second lockout (429).
- Password policy: 8+ characters, a letter and a digit, not the username, not the seed password,
  at most 72 bytes (bcrypt's limit).

**Roles.** Enforced by a `require("permission")` dependency on **every** route (a test walks the
route table and fails if any `/api` route answers without a token). The UI hides what a role
can't use, but only for convenience.

| Permission | Admin | Super Admin |
|---|:-:|:-:|
| View dashboard, live video, violations, analytics | ✓ | ✓ |
| Start / stop cameras, live confidence slider | ✓ | ✓ |
| Edit per-camera settings: name, source, enabled, required PPE, confidence | ✓ | ✓ |
| Acknowledge violations, export CSV | ✓ | ✓ |
| Edit system settings: model / device, tracker, compliance, alerts & **retention**, performance, add / remove cameras, raw YAML, reset, restore backups | – | ✓ |
| Delete violations | – | ✓ |
| Manage users: create, change role, deactivate, reset password, delete | – | ✓ |
| View the audit log | – | ✓ |

Denials are `403 {"detail": "Your role (Admin) … requires the Super Admin role (users:manage).",
"code": "forbidden"}`. For config saves by an Admin, the server diffs the submitted config
against the file and names every field outside the per-camera set. You can't demote,
deactivate or delete yourself, or remove the last active Super Admin.

**Audit log** (`audit_log` table): sign-ins (including failed ones), sign-outs, password changes,
every user-management action, config saves / resets / restores **with a per-field before/after
diff** (e.g. `streams.cam2.source.uri: a.mp4 → b.mp4`), violation acknowledgements, deletions and
exports, camera start / stop. It never stores passwords.

**Storage.** `users`, `refresh_tokens`, `audit_log` and `observations` live in the same SQLite
file as `violations` (`alerts.db_path`, `./data` volume in docker). Existing databases are
migrated in place on start (new columns `run_id`, `ack_at`, `ack_by`).

## Adding cameras (file, RTSP, HTTP) without code

*Config → Streams → **Add camera*** (Super Admin): pick *IP camera (RTSP)*, *IP camera (HTTP)*,
*Upload a video file*, *Video already on the server*, *USB webcam* or *Folder of images*. Enter the
URL / file and the credentials, then press **Test connection**: the server opens the source and shows
the first frame (or the exact error). **Add camera** saves it and starts it without touching the
other cameras. Admins can edit and test an existing camera's source, credentials and priority.

| type | uri | notes |
|---|---|---|
| `rtsp` | `rtsp://host:554/path` | FFmpeg over TCP; `timeout` s to open / between frames |
| `http` | MJPEG stream, JPEG snapshot URL, or HLS / MP4 | auto-detected; Basic and Digest auth; snapshot polled at `fps` |
| `file` | path or `${PPE_VIDEOS_DIR:-../videos}/x.mp4` | looped, paced to `fps` (set it for raw NVR exports) |
| `webcam` | `0`, `1`, … | camera on the server |
| `images` | folder | stills in name order |
| `onvif` | — | placeholder: use the camera's RTSP URL |

Credentials go in `source.username` / `source.password`. The password is **encrypted at rest**
(`enc:…`, key `PPE_SECRET_KEY`, else derived from `PPE_JWT_SECRET`) and the API only ever returns
`********`. A password written in the URI is moved into the fields and encrypted on save. Test
without hardware: `scripts/camera_emulator.py` serves a file as an HTTP MJPEG camera (see
docs/PROJECT_WALKTHROUGH.md §15 for RTSP).

## Many cameras

- One grabber thread per camera (blocking I/O), **one** batched inference engine, and a bounded
  post-processing pool (`inference.post_workers`). The latest frame only, everywhere: overload means
  fewer detections per camera, never lag.
- `inference.max_batch` cameras per model call; the scheduler serves `priority: high` cameras
  first, then whoever waited longest. `priority: low` also runs at a third of the rate.
- **Focus mode** (`inference.focus_pause_others`, off by default): while a camera is open full
  screen, the others keep their video but skip detection.
- The **System health** page shows when you're near capacity. Load-test numbers for this machine
  are below under "Performance".

## Analytics

All figures are SQL aggregations (`GROUP BY`, `COUNT(DISTINCT)`, `json_each`) in
`backend/app/analytics.py`, so only aggregated rows leave the database. Every endpoint takes
`start`, `end` (epoch seconds, end exclusive, default = last 7 days), repeatable `camera=` and
`ppe=` (omit = all) and `tz` (the viewer's UTC offset in minutes, for day / hour-of-day buckets).
`timeseries` also takes `granularity=hour|day|week|auto`. Chart rationale: walkthrough §17.

- **Compliance rate** = workers who raised no alert ÷ workers evaluated. Violations alone can't
  give a denominator, so the pipeline now counts each tracked worker once per camera session
  (the first time their status is determinable) and whether they raised an alert, in 15-minute
  buckets (`observations` table). The counts start when this version first runs; older periods
  show "—" for compliance, but every other chart covers them. It's an approximation: an
  occlusion ID switch counts a worker twice.
- **Repeat offenders** are grouped by (camera, camera session, track ID). **Track IDs are not
  identities**: they restart whenever a camera starts, and one person can get several IDs.
  Violations stored before sessions were tracked show "session unknown", and may merge runs.
- Export: **CSV** (every section of the current view in one file, built from the aggregated
  data) and **PDF** via the browser's print dialog ("Save as PDF"; a print stylesheet hides the
  navigation).

## API

All routes except `/api/health` and `login` / `refresh` / `logout` need `Authorization: Bearer <access token>`.
The permission each one needs is in `backend/app/api.py` / `auth_routes.py` / `analytics.py`.

| Method + path | Purpose |
|---|---|
| `POST /api/auth/login` | `{username, password, remember?}` → `{access_token, expires_at, user}` + refresh cookie |
| `POST /api/auth/refresh` | refresh cookie (or `{refresh_token}`) → new access token; rotates the refresh token |
| `POST /api/auth/logout` | revoke the session, clear the cookie |
| `GET /api/auth/me` | current user + `permissions` |
| `POST /api/auth/change-password` | `{current_password, new_password}`; ends every other session |
| `GET /api/users` · `POST /api/users` · `PATCH /api/users/{id}` · `DELETE /api/users/{id}` | user management (Super Admin) |
| `POST /api/users/{id}/reset-password` · `GET /api/users/roles` | temporary password (forces a change by default) · role matrix |
| `GET /api/audit?action&actor&start&end&before_id&limit` · `/api/audit/actions` | audit log (Super Admin); `action=config.` matches the whole group |
| `GET /api/analytics/summary` | KPIs: totals vs the previous period, open, compliance, top PPE item and camera, live cameras |
| `GET /api/analytics/timeseries?granularity=auto\|hour\|day` | per bucket: violations, workers evaluated / flagged, compliance (gaps filled) |
| `GET /api/analytics/by-camera` · `/by-ppe-type` · `/heatmap` · `/top-offenders?limit` | breakdowns; heatmap = 7×24 grid, Monday first |
| `POST /api/violations/{id}/ack` | acknowledge (idempotent, first one kept) |
| `GET /api/health` · `/api/status` · `/api/streams` · `/api/streams/{id}` | status snapshots |
| `POST /api/streams/{id}/start` · `/stop` | start / stop a camera |
| `PATCH /api/streams/{id}/settings` | `{"confidence": 0.5, "show_boxes": false}` (live, not persisted) |
| `GET /api/streams/{id}/mjpeg` · `/frame.jpg` | live annotated video / latest frame |
| `GET /api/config` | `{config, yaml, etag, path}`: the raw file (placeholders unexpanded) |
| `GET /api/config/schema` | pydantic JSON schema + PPE items, devices, source types |
| `POST /api/config/validate` | `{config}` or `{yaml}` → `{valid, errors:[{loc, msg, line?}], cameras:{removed, added, changed}}` |
| `PUT /api/config` | `{config \| yaml, etag, confirm_remove?}` → validate, back up, atomic save, hot reload → `{reload:{restarted, started, stopped, added, removed, engine_reloaded, requires_server_restart}}`; 422 with field errors; 409 on a stale etag; 409 `confirm_camera_removal` (+ camera diff) when cameras would be removed and aren't listed in `confirm_remove` |
| `POST /api/config/reset` | `{keep_cameras: true (default), confirm_remove?}`: reset settings to `config.default.yaml` (with backup + hot reload); cameras are kept unless `keep_cameras: false` + confirmed |
| `GET /api/config/backups` · `POST /api/config/restore {name, confirm_remove?}` | list / restore backups (same camera-removal guard) |
| `GET /api/violations?start&end&camera&ppe&acknowledged&before_id&limit` | page of violations, newest first: `{items, total, next_before_id}`; thumbnails as base64. `start`/`end` are epoch seconds (end exclusive) |
| `GET /api/violations/{id}?include=original,crop` | one violation with the evidence `image`, `meta`, and on request the original frame / person crop (base64 JPEG) |
| `DELETE /api/violations/{id}` | delete one (Super Admin) |
| `GET /api/violations/export?…filters` | CSV download |
| `GET /api/violations/stats` | `{today, session_total}` |
| `WS /ws?access_token=` | `hello` / `stats` (4×/s, includes `violations_today`), `violation` (with thumbnail) and `violation_update` (an ongoing event extended / ended) |

Interactive docs: http://localhost:8000/docs

## Architecture

```
  FrameGrabber thread (per cam)          InferenceEngine thread               StreamWorker thread (per cam)
  ─ open / reconnect w/ backoff  ──►  ─ batch newest frame of every    ──►  ─ ByteTrack-style person tracking
  ─ pace files, loop seamlessly        "ready" stream (1 model call)        ─ PPE ↔ person association + smoothing
  ─ keep ONLY the latest frame       ─ close-up pass on person crops        ─ alert debounce → ViolationStore (SQLite)
                                                                            ─ annotate + JPEG encode (latest only)
  FastAPI: REST + MJPEG + WebSocket;  ConfigStore (validate/backup/atomic write) → Monitor.apply_config (hot reload)
```

At every stage there's at most one pending item per camera, so the display never lags: frames the
machine can't keep up with are skipped. Detector, tracker, sources, PPE logic and storage are
separate modules; `Detector` is a protocol, so tests use a fake one.

### Per-person PPE association (`backend/app/ppe_logic.py`)

1. Each PPE box (positive or `no_*`) is scored against every person by the **fraction of the PPE
   box inside that person's body region** for the item:

   | Item | Region |
   |---|---|
   | helmet | head: top 30%, extended above |
   | goggles / mask / ear protection | face |
   | vest | torso: 12%–78% |
   | gloves | hands: extended 30% to each side |
   | boots | feet: bottom 30% |

2. **Person-crop refinement:** each person is re-detected on a full-resolution crop (320×320,
   fixed batch shape), and the crop's PPE detections replace the full-frame ones for that person.
3. The best-scoring person above `min_containment` gets the item. Each detection goes to at most
   one person.
4. Each required item is *present*, *missing* (the `no_*` class wins, or nothing was seen under the
   `strict` policy) or *unknown* (body part out of frame, or the person is too small).
5. A 6-frame majority vote per track removes flicker.

## Model

`models/safesight/best.pt` (deployed since 24 Sep 2026) is YOLO11s with 10 classes: `Hardhat`, `Mask`,
`Safety Vest`, their `NO-*` classes, `Person`, and `Safety Cone` / `Machinery` / `Vehicle` (ignored).
So it judges **helmet, mask and vest only**. Boots, gloves, goggles and ear protection can still be
selected as required PPE, but they are not checked: the dashboard and camera detail show them as
struck-through "not checked" chips (and the server logs a warning), until a model with those classes
is configured. With no CUDA GPU it's exported once to OpenVINO and run on the Intel iGPU / CPU. To swap models, set `model.weights` (in the form or YAML) and map class names
in `model.class_map`. The fine-tuning steps are in `docs/PROJECT_WALKTHROUGH.md`.

**Known limitation on this footage:** blue hardhats seen from above and behind are sometimes
missed, which produces false "NO helmet" records. The new clean snapshots make these easy to spot
and delete. Fine-tuning on a few hundred frames from these cameras is the fix.

## Phone-use detection

Besides missing PPE, the system can flag a **worker using a phone**. The `safesight` PPE model has
no phone class, so this uses a second, general-purpose detector (COCO, e.g. `models/coco/yolov8n.pt`,
which has a `cell phone` class) that runs alongside the PPE model on the full frame only. A detected
phone is attributed to the worker in whose hands/face zone it falls, smoothed over the majority-vote
window like PPE, and stored as a `phone_use` violation (a 📱 chip in the UI, purple box on the video).

Turn it on with two settings:

- `model.phone_weights: ../models/coco/yolov8n.pt` (or `${PPE_PHONE_WEIGHTS}`). Blank = off. The
  second model is only loaded, and only costs inference, when at least one camera opts in.
- `streams[].detect_phone: true` per camera (Config → Streams → **Detect phone use**).

The crop/refine and alert-evidence passes run the PPE model only, so phone detection adds roughly
one extra full-frame pass per processed frame — budget for it in the camera count (see Performance).

## Alarms (webhook / email)

Every stored violation can trigger an **outbound alarm**, rate-limited per camera (on top of the
per-worker alert dedupe) so a busy scene can't flood the target. Configure under `alarm:` (Config →
**Alarm**, Super Admin):

- **Webhook** — HTTP `POST` of a JSON payload (`event`, camera, `track_id`, `violations`, timestamp)
  to `alarm.webhook.url`. Wire it to a hooter/relay gateway, a Teams/Slack incoming webhook, a PLC, …
- **Email** — SMTP to `alarm.email.recipients`, with the violation snapshot attached.
- `alarm.cooldown_seconds` — minimum gap between alarms for one camera.

Keep secrets out of `config.yaml` with env expansion, e.g. `password: ${PPE_SMTP_PASSWORD}` and set
the variable in `.env`. Both channels are off by default; delivery runs on a background pool, so a
slow or failing endpoint never stalls the video pipeline.

## Configuration keys

`backend/config.yaml` (or `$PPE_CONFIG`). Relative paths resolve against the file's folder, and
strings may use `${VAR:-default}`. These environment variables override keys after loading:
`PPE_HOST`, `PPE_PORT`, `PPE_DEVICE`, `PPE_IMGSZ`, `PPE_CPU_IMGSZ`, `PPE_DB_PATH`.

- `server`: `host`, `port`, `static_dir`, `cors_origins`
- `model`: `weights`, **`phone_weights`** (optional 2nd detector for phone use; "" = off), `device`, `openvino`, `imgsz`, `cpu_imgsz`, `half`, `default_confidence`, **`iou`** (NMS), `cpu_threads`, `class_map`
- `inference`: `mode`, `max_fps_per_stream`, **`frame_skip`**, `process_width` (downscale), `jpeg_quality`, `person_refine`, `refine_imgsz`, `refine_max_persons`, `refine_batch`, `refine_min_height`
- `tracking`: `low_thresh`, `match_iou`, `max_lost_seconds`, **`min_hits`**
- `compliance`: `missing_policy`, `min_containment`, `smoothing_window`, `min_person_height`
- `inference` (scaling): `max_batch`, `post_workers`, `focus_pause_others`, `paused_preview_fps`
- `alerts`: `min_violation_frames`, **`min_violation_seconds`**, **`event_gap_seconds`**, `cooldown_seconds` (new violation for the same worker), **`save_original_frame`**, **`evidence_retention_days`**, **`snapshot_quality`**, **`retention_days`**, **`db_path`**, `evidence_imgsz` (alert-time re-detection for exact snapshot boxes; 0 = off), `require_confident_box`, `drop_unconfirmed`
- `analytics`: `compliance_target` (default 0.95)
- `alarm`: `cooldown_seconds` (per-camera), `webhook {enabled, url, timeout}`, `email {enabled, smtp_host, smtp_port, username, password, use_tls, sender, recipients, attach_snapshot}`
- `streams[]`: `id`, `name`, `source {type, uri, username, password, timeout, fps, loop, reconnect_delay, max_reconnect_delay}`, `required_ppe`, **`detect_phone`**, `enabled`, `confidence`, `priority`

The old keys `snapshot_dir`, `max_log_entries` and `tracking.high_thresh` were removed; if an old
file still has them, they're ignored.

## Performance (this laptop: i5-1135G7, Iris Xe, no NVIDIA GPU)

**Many cameras (load test, `scripts/load_test.py`, 1080p H.265 20 fps NVR footage, full pipeline):**

| Cameras | Detection fps / camera | Latency p50 | CPU |
|---|---|---|---|
| 4 | 5.8 | 125 ms | 98 % |
| 6 | 1.8 | 266 ms | 100 % |
| 8 | 1.4 | 406 ms | 100 % |
| 10 | 0.65 | 1.1 s | 100 % |
| 12 | 0.15 | 3.3 s | 100 % |

The limit is **CPU video decoding** (this CPU decodes ~185 frames/s of 1080p H.265 in total), not the
model. Recommended here: 4 full-resolution cameras, 6–8 acceptable; for more, use the cameras'
sub-streams (e.g. 640×360 H.264: 9× fewer pixels to decode) or bigger hardware. Details and tuning:
docs/PROJECT_WALKTHROUGH.md §16.4.

**Original 4-camera measurements:**

| Setup | FPS per tile (4 tiles) | Latency |
|---|---|---|
| Pipeline only (`scripts/headless_check.py`) | 5.5 | 130–150 ms |
| Full server with the new SQLite store, no browser open, CPU at 100% from other apps | 5.0 | 138–176 ms |
| Same, with the dashboard rendered in a browser on the same laptop | ~3 | 800+ ms |

On a dedicated machine (or with viewers on other PCs) expect the first rows. The Config page's
Performance section trades accuracy for speed: frame skip, downscale width, close-up pass on or off.

## Tests

```bash
cd backend && ..\backend_venv311\Scripts\python.exe -m pytest -q   # 236 tests
python scripts/headless_check.py --seconds 30                     # full pipeline, in-memory DB; --persist to use the real DB
python scripts/load_test.py --counts 4 8 12                       # N-camera throughput / latency / engine load
```

| File | Covers |
|---|---|
| `test_ppe_logic.py` | association geometry, policies, smoothing, crop merge |
| `test_tracker_and_alerts.py` | tracker IDs, debounce / cooldown / subset / ID hand-off |
| `test_config.py` | env expansion, paths, class mapping |
| `test_config_store.py` | field-level validation errors, YAML syntax and line mapping, backups (keep 10), atomic write surviving a crash, etag conflict, reset, restore, path traversal |
| `test_hot_reload.py` | only the changed stream restarts; add / remove / disable; model change reloads the engine only; global settings; live default confidence; server changes reported |
| `test_incidents.py` | temporal confirmation (single-frame false detection, continuous, appearing/disappearing, several people), one violation per event, ID switches / double and group boxes, best evidence frame |
| `test_violation_events.py` | pipeline: one record extended then ended, deletion while ongoing, camera stop, evidence images + provenance + hashes, evidence never rewritten, best frame, ack / delete / CSV, evidence retention, restart |
| `test_config_safety.py` | reset keeps cameras, factory reset / form / raw YAML / backup restore can't remove cameras unconfirmed, camera diff preview, capability report |
| `test_violations_db.py` | newest-first ordering, keyset pagination (stable under inserts), filters (camera / PPE / date), base64, delete, CSV, retention cleanup, today count |
| `test_api.py` | config GET / schema / validate / PUT (422, 409, hot reload, backup) and violations list / filters / detail / delete / export, 404 for unknown `/api` paths |
| `test_snapshot.py` | full-resolution evidence snapshot, edge boxes, source frame untouched |
| `test_auth.py` | seed user (once, idempotent, warning logged), login errors look identical, throttling, forced password change blocks everything else, token version revocation, refresh rotation / reuse detection / logout / remember me, expired and forged tokens, **every `/api` route rejects anonymous calls**, WebSocket + MJPEG token rules, Admin denied on every Super Admin endpoint, Admin config limited to camera fields, audit before/after, user-management guard rails, open WebSocket closed on revocation |
| `test_analytics.py` | summary / previous period, `json_each` PPE counts, per-camera incl. idle cameras, day buckets in the viewer's time zone, hourly buckets, heatmap cells, session-aware offenders, camera filter, acknowledgements, HTTP params + range validation, in-place migration of an old database |
| `test_config_diff.py` | per-field diff keyed by camera id, Admin edit policy |
| `test_observations.py` | the pipeline counts each worker once and tags violations with the camera session |
| `test_box_alignment.py` | synthetic frame with a known worker: snapshot outline, alert-time evidence re-detection, stored snapshot, live crop-pass box, phantom alerts, confident-box wait (fails by 27–41 px without the fix) |
| `test_sources.py` | source registry, encrypted credentials (never stored / returned in plain text), HTTP MJPEG / snapshot / Basic auth against a real local HTTP server, connection test, grabber drops / reconnects / offline |
| `test_scaling.py` | scheduler priority + fairness + batch cap, low-priority rate, one frame in flight, GPU batch padding, bounded thread pool, focus mode + lease expiry, upload / list / test endpoints, health, WebSocket video multiplexing, Admin camera password never returned |

## Operational notes

- **Graceful shutdown:** Ctrl+C runs the FastAPI lifespan shutdown. Engines stop, threads are
  joined, and the DB is closed.
- **Reconnects:** RTSP/HTTP retry with backoff (2 s → 30 s); credentials are masked in logs.
  When a config reload restarts a camera, its MJPEG connection closes and the browser reconnects
  automatically.
- **Security:** sign-in is required everywhere (see above). Still: change the seed password at
  once, set `PPE_JWT_SECRET`, and serve over HTTPS (a TLS reverse proxy; set
  `PPE_COOKIE_SECURE=true` behind it) outside a trusted LAN. `/api/health` stays public for the
  docker health check and reveals only the device and camera count.
