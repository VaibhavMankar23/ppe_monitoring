# E2E Production Testing — Issue Log

Test pass: 25–26 Sep 2026 (host clock jumped ~18 h mid-test — machine suspended; times below are IST unless noted).
Target: Docker image `ppe-monitor:latest` on the Linux host (live container `ppe_monitoring-ppe-monitor-1`, http://localhost:8000).
Authenticated testing ran on an isolated QA container built from the **same image** (see "Environment").

Severity: Critical / High / Medium / Low. Status: **Fixed** (retested) / Open / Not verifiable.

## Issues

| # | Issue | Screen/module | Steps to reproduce | Expected | Actual | Sev. | Root cause | Fix / status |
|---|---|---|---|---|---|---|---|---|
| 1 | Violation IDs are reused after deletions | Violations / DB | Delete the newest violations (live: bulk delete 25 Sep 19:22:33 UTC), wait for new ones | New violations get never-used IDs | Live log: `VIOLATION #154` … then `VIOLATION #1`. Audit rows "violation.delete 1..18" (and up to #12091) now name *different* records than today's #1..; ack/open-by-id can hit another record | Medium | `violations.id INTEGER PRIMARY KEY` without `AUTOINCREMENT` → SQLite reuses max(id)+1 | **Fixed**: table declared `sqlite_autoincrement`; existing DBs rebuilt once at startup in one transaction, sequence seeded from max(id, highest id in audit log). Dry run on a backup of the live DB: 2 s, next id #12092, integrity ok. QA retest: deleted #189–191, next id 192. 2 new tests |
| 2 | Valid access tokens written to container logs | Security / logging | `docker logs ppe_monitoring-ppe-monitor-1` | Tokens masked | Every WS connect logs `/ws?access_token=eyJ…` (usable for 15 min) | Medium | Uvicorn logs the full WS URL; WS can only authenticate via query | **Fixed**: `RedactTokens` filter on `uvicorn.error`/`uvicorn.access`. Retest: `access_token=***`, 0 raw tokens in QA logs. Unit test added |
| 3 | README describes a different model than the one deployed | Docs / Model | Compare README "Model" with startup log `classes used:` | Docs match | README: YOLOv8s with all 7 PPE items. Deployed `best.pt`: YOLO11s, only helmet / mask / vest (+NO-*) | Medium | Model swapped 24 Sep, docs not updated | **Fixed** (README Model section). The capability gap itself → #8 / report |
| 4 | Backend test fails: repo `backend/config.yaml` contains a dev camera | Tests / packaging | `pytest tests/test_config.py` | Repo config has no cameras | `gate-no-2` present (copied into the image; unused in Docker) | Low | Local dev config left in repo | **Open** — it's your local-run config; not changed without your OK |
| 5 | Stale upload test | Tests | `pytest tests/test_scaling.py::test_upload_list_and_test_a_file_camera` | Test matches behaviour | Expects 409 on re-upload; code intentionally reuses identical file / renames a different one | Low | Behaviour changed, test not | **Fixed** (test updated; 13/13) |
| 6 | "Violations today" badge and CSV `local_time` use UTC, not plant time | Sidebar badge / WS stats / CSV | Docker (container TZ = UTC, users IST): compare badge with Violations "Today" | Same day boundary everywhere | QA: server "today" **42** vs **135** since IST midnight. Badge counts from 05:30 IST; CSV `local_time` is UTC | Medium | `count_today()` / CSV use server local time; container had no `TZ` | **Fixed**: compose passes `TZ` (default UTC), `.env` sets `TZ=Asia/Kolkata`, documented in `.env.example`. Retest: 189 = 189; CSV local time IST |
| 7 | "Reset to defaults" in Docker restores an outdated default | Config / Docker | Upgrade image → Config → Reset to defaults | Shipped defaults of the running image | Entrypoint seeds `config/config.default.yaml` only once; host copy (24 Sep) lacks `phone_weights` and `alarm:`. **Seen live 26 Sep 19:22 IST**: a save left `config.yaml` identical to the stale default | Low | Seed-once in Dockerfile `CMD` | **Fixed**: default copied on every start. Retest: QA default md5 = shipped default |
| 8 | Configured checks the model can't do are silently not enforced | Dashboard / Camera detail | Live: gate-1/3 require 7 items, gate-4 boots+gloves; phone use on for all 5; no phone model | Operator can see which checks are inactive | All chips shown as active; only a server log line (and none for phone). Workers also showed a neutral "📱 Phone Use" chip as if checked | High | Model lacks 4 PPE classes; no phone model; state never reached API/UI | **Fixed**: streams API adds `unenforced`; phone use isn't evaluated without a phone model (plus log warning); tiles/detail show those chips struck-through with a "Not checked by the current model…" note. Retest OK (screenshots); list updates live when a phone model is added. Test added |
| 9 | System health "this app 0% of N cores" always | System health | Open System health | Real process CPU | Always 0.0 | Low | New `psutil.Process()` each call → `cpu_percent()` has no baseline | **Fixed** (one Process reused). Retest: 51–64 % |
| 10 | Cameras tile says "2/3 · all live" when a camera is stopped | Dashboard summary | Stop/disable one camera | Subtitle reflects it | "all live" whenever no camera is in an error state | Low | Wording only checked `problems` | **Fixed**: "N not live". Retest: "3/4 · 1 not live" |
| 11 | Add camera → Upload a video file fails with bare "500 Internal Server Error" in Docker | Add camera | Docker deployment → Add camera → Upload → pick a file | File uploads, camera can be added | 500; server log `Read-only file system` (and cleanup raised again, masking it) | High | `docker-compose.yml` mounted `./videos` `:ro`; handler didn't handle `OSError` | **Fixed**: mount now writable; handler returns a clear message (`storage_error`, 507 when disk full). Retest: ro → readable message; rw → upload 201, test connection OK, camera added and live |
| 12 | Dashboard keeps "System online" with frozen numbers when the backend hangs | All pages (top bar / live tiles) | Backend hung or network path silently dropped (`docker pause`) | "Backend offline, reconnecting" within seconds | Stayed "System online · 3/4 live" with frozen counts/video indefinitely | Medium | WS client only reacted to `close`, which a hung peer never sends | **Fixed**: watchdog — no stats for 8 s (server sends 4/s) → offline + reconnect. Retest: offline shown after 8.6 s, back online 0.5 s after resume |
| 13 | Status filter truncated: "Open and acknowle…" | Violations filters | 1440 px wide | Full label | Truncated | Low | Label longer than column | **Open** (cosmetic; left as is) |
| 14 | Analytics header overflows at phone width | Analytics | 390 px wide | No horizontal scroll | 40 px overflow; title squeezed out, clock clipped | Low | Three buttons + clock don't fit | **Open** (cosmetic; control-room use is desktop) |
| 15 | Uploaded videos / config files are root-owned on the host | Docker ops | Upload via UI; `ls -l videos config` | Files manageable by the host user | `root:root` (config.yaml is `600 root`) | Low | Container runs as root | **Open** — needs a non-root `USER` + volume ownership change; not done without your OK |
| 16 | Phone-use detection could not be shown to work on this footage | Phone use | QA: `model.phone_weights: ../models/coco/yolov8n.pt`, 3 cameras × 3 min; then yolov8n on 60 stored full-res worker crops | Phones in hand detected | Model loads, hot-reload OK, **0 phone detections** (frames and crops ~246×528 px) | Medium | Phones are a few pixels at this camera distance; stock COCO nano model; phone model runs on full frame only | **Open / not verifiable** — needs footage with visible phones and likely a stronger or fine-tuned model |
| 17 | Detection FPS ~1.2–1.4 per camera under load; tracker IDs fragment | Pipeline / capacity | QA (3–4 cams) running alongside live (5 cams) on the same i5 CPU | ≥ ~5 fps per camera (README) | 1.2–1.4 fps; "Saturated"; track IDs in the thousands within an hour → the same person re-flagged under new IDs (e.g. 1,644 "workers seen" in ~1 h on 3 cameras) | Medium (capacity) | CPU saturated (live alone ~790 % CPU); README recommends ≤ 4 full-res cameras on this laptop | **Open** — environment/capacity; not measured on live alone (no credentials). Use sub-streams, fewer cameras, or bigger hardware |

## Not verifiable in this environment

| Area | Why | What was done instead |
|---|---|---|
| Authenticated flows on the live instance (:8000) | Only accounts are your users (`admin`, `vaibhav`); creating a test account in the live DB was blocked (correctly) | Isolated QA container from the same image on :8001 (fresh DB, copy of live config, same videos/models read-only). Live: unauthenticated checks, logs, read-only DB queries, online backup copy for the migration dry run |
| Real RTSP/HTTP cameras / NVR | None reachable from this host | NVR `.cpv` exports as file cameras; unreachable RTSP URL for error states; HTTP/MJPEG covered by the backend suite (local server) |
| Windows-only setup (`start.bat`, `backend_venv311`, Intel iGPU) | Linux host; venvs are Windows builds | Tested the Docker/Linux path (OpenVINO on CPU) |
| Phone-use accuracy | See #16 | Load / hot-reload / UI state verified |
| Email/webhook alarms | No SMTP/webhook target | Not tested beyond the existing unit tests (`test_alarms.py` passes) |
| Print-to-PDF (Analytics) | Headless browser can't drive the print dialog | Not tested |

## Test log (what was tested, result)

1. **Environment**: live container healthy; OpenVINO CPU; ~790 % CPU on 12 cores with 5 cameras.
2. **Build**: `tsc -b && vite build` clean (before and after fixes). No source newer than the image.
3. **Backend suite** (in a container from the image): 192/194 before → **197/198 after** (only #4 left).
4. **Auth**: anonymous 401 everywhere; identical errors for unknown user / wrong password; seed login forces password change and blocks every other API; password policy (length, letter+digit, not username, not same); refresh cookie HttpOnly / SameSite=Strict / Path=/api/auth; rotation + 30 s grace; reset revokes old tokens (401 `session_revoked`); 5 failures → 429 lockout (correct password refused during lockout); reload keeps session; logout ends it; login returns to the requested page. **Pass.**
5. **RBAC**: every `/api` route walked as anonymous and Admin — matches the README matrix. Admin UI hides Users/Audit/Add camera, direct URLs show "You don't have access", no select/delete, config limited to camera fields (server names the forbidden field). **Pass.**
6. **Dashboard / live streams**: annotated live video on all tiles; site-safety summary; stop/start, boxes toggle, confidence slider applied server-side; unreachable RTSP → "Reconnecting" with exact error and "1 need attention". Issues #8, #10, #12.
7. **Worker / PPE detection**: snapshots are clean full-resolution crops with correct outline; spot-checked detections were plausible (no helmet/vest/mask). Only helmet/mask/vest judgeable (#3/#8).
8. **Camera detail**: large video, per-worker items, detection counts, latest violations, telemetry link. **Pass** (+#8 note).
9. **Violations**: keyset pagination (no dupes, stable under inserts); filters camera / type / status / date and combinations; from>to error; empty state; viewer ←/→ keeps position by id during live inserts; ack in place (idempotent); Esc; multi-select + bulk delete with confirm; CSV export honours filters. Issues #1, #6, #13.
10. **Analytics**: summary / by-camera / by-PPE / timeseries (hour/day/week) / heatmap / offenders all agree with the raw list; range validation (end ≤ start, > 400 days, bad tz → 422); tz sign convention correct. **Pass.**
11. **System health**: per-camera FPS/drops/latency, saturation banner. Issue #9, #17.
12. **Configuration**: form + raw YAML; field-level and line-numbered errors; 422 never writes; 409 on stale etag; backups; hot reload only restarts what changed; unsaved-changes guard; credentials in URI moved to encrypted fields, masked for Admin. Issue #7.
13. **Add camera**: server file (with playback FPS) → live; upload → #11; test connection OK/error paths.
14. **Users / Audit**: create (temp password shown once), deactivate, delete, own-account guard; audit records sign-ins (incl. failed), forced change, user actions, config diffs, ack, export, deletes. **Pass.**
15. **Loading / empty / error / offline**: skeletons, empty states, API error states, backend stopped vs hung (#12), recovery after backend returns. **Pass after fix.**
16. **Responsive**: 390 px — Dashboard/Violations fit; Analytics overflows (#14).
17. **Retest of all fixes** on image `ppe-monitor:qa` built from the fixed source — all pass (see each row).

## Files changed

- `backend/app/violations_db.py` — AUTOINCREMENT + one-off migration (#1)
- `backend/app/api.py` — token redaction in logs (#2)
- `backend/app/sources_routes.py` — upload storage errors (#11)
- `backend/app/pipeline.py` — `unenforced` in stream snapshot, skip unseeable behaviours (#8); process CPU (#9)
- `frontend/src/state/monitor.tsx` — stale-connection watchdog (#12)
- `frontend/src/components/ui/Badge.tsx`, `components/camera/CameraTile.tsx`, `components/camera/DetailView.tsx`, `types.ts` — "not checked" chips (#8)
- `frontend/src/components/dashboard/SafetySummary.tsx` — cameras wording (#10)
- `docker-compose.yml` — writable videos, `TZ` (#6, #11); `Dockerfile` — refresh defaults (#7); `.env.example`, `.env` (`TZ=Asia/Kolkata`) (#6)
- `README.md` — Model section (#3)
- Tests: `test_violations_db.py` (+2), `test_api.py` (+1), `test_phone.py` (+1), `test_scaling.py` (updated)

**None of this is live yet.** The running container is unchanged; deploy with `docker compose up -d --build`. On first start the violations table is migrated (seconds; ids continue after the highest id ever used — #12091 in the dry run on a backup taken during this test).

---

# Improvement pass 2 — 26 Sep 2026 (violation events, evidence, config safety)

Verified with: backend suite **235 passed** ×3 runs (+44 new tests; the only failure is #4, the dev camera in the local `backend/config.yaml`), `tsc -b && vite build` clean, and E2E on image `ppe-monitor:qa` built from this source (real NVR footage, 3 cameras, the previous QA database → in-place migration). The live container was not touched.

| # | Item | Root cause (found by inspection / testing) | Fix | Test performed | Result |
|---|---|---|---|---|---|
| 18 | **Duplicate violations** (task 1, High) | Dedupe was "one alert per track + missing-set per `cooldown` s, counted from the alert": a worker who stays non-compliant was re-recorded every 30 s (testing: track #1355 at 01:06:52 and 01:07:24); tracker ID churn at ~1.4 fps and a detector that alternates between one box around two workers and one box each started new records | `AlertDebouncer` is now incident-based: a confirmed worker opens one **event**; later confirmed frames *extend* the stored violation (last seen, duration, observations, newly missing items) — never a second record. The event ends after `event_gap_seconds` (10) without the violation; a new record for that worker needs the event to have ended **and** `cooldown_seconds` since it began. ID switches (hand-off by position), double captures (IoU ≥ 0.7) and group boxes (one box ≥ 80 % inside a member's box) join the event. Deleting an ongoing violation doesn't make it re-appear. Stopping a camera closes its events; events left open by a restart are closed at start-up | `test_incidents.py` (18), `test_violation_events.py` (continuous → 1 record extended then ended; leave & return after cooldown → 2; delete while ongoing; camera stop). Real footage 4 min × 3 cameras, before vs after | **Fixed.** Unit/pipeline tests pass. Footage: events now last 3–162 s with up to 209 observations each (was: a new record every ≥ 30 s). The two men standing together on gate-1 went from **7 records in 4 min to 1 event** (+ see #27) |
| 19 | **Config save removed cameras** (task 10, High) | Live audit log: **all 7 camera wipes since 22 Sep were `config.reset`** ("Reset to defaults"), incl. 26 Sep 19:22 IST. Reset replaced the *whole* file with the shipped defaults (`streams: []`), and its dialog never mentioned cameras. Before pass 1 the defaults file was also stale (#7). No server-side protection against any write dropping cameras | Reset now resets **settings and keeps cameras** (factory reset incl. cameras is an explicit extra checkbox). Server guard on every write (form save, raw YAML, reset, backup restore): if cameras would be removed and they aren't named in `confirm_remove`, it returns 409 `confirm_camera_removal` with the camera diff and writes nothing. `/api/config/validate` returns the camera diff; the UI shows removed / source- or enabled-changed cameras before saving. Audit detail says "cameras kept" / "cameras removed". Dev `backend/config.yaml` no longer ships in the Docker image | `test_config_safety.py` (8): reset keeps cameras; factory reset / form / raw YAML / restore refused unconfirmed (file and backups untouched), wrong camera confirmed = still refused; diff preview. Browser: settings reset keeps 4 cameras; factory reset → 2nd dialog naming the 4 cameras → cancel keeps them; form removal → diff dialog → cancel keeps / confirm removes only that camera | **Fixed** |
| 20 | **Evidence images** (task 2, High) | One annotated crop from whichever frame confirmed the alert; no original frame, no confidence / camera / time on the image | Best frame of the confirmation window is kept (score: person confidence × violation-detection confidence × size × fully-in-frame × confident box) and used for the evidence. Per violation: **evidence image** (outlined full-res crop + header: camera, local time, track, person %, each violation %, "not seen" for strict-policy absences), **clean person crop**, **original full frame** (`save_original_frame`). One incident = one evidence set, written once; later observations only update event fields; SHA-256 of each image stored in the metadata | `test_violation_events.py`: images present, original is the untouched frame, hashes match stored bytes, evidence unchanged after 50 more observations, best-confidence frame chosen; `test_box_alignment` still hugs the worker. Browser: viewer tabs Evidence / Person crop / Original frame | **Fixed** |
| 21 | **Temporal confirmation** (task 3, High) | Existing: `min_violation_frames` consecutive frames only — duration depended on FPS (6 frames = 0.4 s at 15 fps) | Also `min_violation_seconds` (default 1 s); both must hold. Compliant / undeterminable frame resets; tracks gone longer than the gap are forgotten | `test_incidents.py`: single-frame false detection, continuous (confirmed at exactly 1.0 s once), frames-only / duration-only not enough, appearing & disappearing resets, several people (steady one confirmed, flickering one not) | **Fixed** |
| 22 | **Model capabilities in camera config** (task 4, Medium) | Chips in Config → Streams and Add camera implied every item was detected; logic lived only in the pipeline | One backend function (`ppe_logic.unchecked`) feeds both the per-camera `unenforced` list and a new `capabilities` report in `/api/config/schema`; Streams and Add camera strike through unsupported chips, with a "not checked" note and a section banner naming what the model checks | `test_schema_reports_what_the_model_can_check`; browser: Streams banner "checks Helmet, Mask, Vest…", Boots/Ear protection/Gloves/Goggles struck through, per-camera "Not checked on this camera" | **Fixed** |
| 23 | **Phone detection config** (task 5, Medium) | Guidance existed only as a hint (Streams) and in Add camera (inline, added by the team); a `${PPE_PHONE_WEIGHTS:-}` placeholder that expands to nothing looked "set" | Kept per-camera toggle + global model. Shared `phoneProblem()` used by Streams and Add camera; Model section warns which cameras have the toggle on without a model ("the toggle alone is not enough") and says it's an additional detector; load failure reported from the server | Browser: gate-5 with toggle on + placeholder model → warning in Streams and Model sections; typing a model path (unsaved) clears it, clearing brings it back | **Fixed** (after one retest: first version missed the placeholder case) |
| 24 | **Violation lifecycle** (task 6, Medium) | Only open / acknowledged; no notion of detected vs confirmed or of an ongoing event | Kept `ack_at/ack_by` unchanged; added event `state` (ongoing / ended) and `last_seen`. Viewer shows **Detected → Confirmed → Ongoing / Ended (duration, observations) → Acknowledged**; cards show *Ongoing* and duration, updated live over the WebSocket (`violation_update`). Delete dialog explains deleting an ongoing event | `test_ack_delete_and_csv_still_work_on_event_records` (ack survives extension; delete; CSV). Browser: viewer updated live (last seen 20:58:21 → 20:58:33, 22 → 26 observations while open) | **Fixed** |
| 25 | **Evidence / audit metadata** (task 7, Medium) | Only id, time, camera, track, missing | `meta` JSON on the existing table: camera + session, lifecycle times, full-res box, verified-at-full-res, person and per-item confidence, best-frame score, **model** (weights, SHA-256, runtime, device, imgsz, phone model), rules in force (thresholds, confirmation, gap, cooldown, policy, not-checked items), **config SHA-256**, image hashes. CSV keeps its 9 columns first and adds last_seen, duration, observations, confidence, model. Delete audit already stores what was deleted | `test_evidence_images_and_provenance_metadata`; viewer "How this was detected" | **Fixed** |
| 26 | **Camera status / monitoring** (task 9, Low) | Last-frame / last-detection times existed internally only | Stream + health APIs expose `connected`, `last_frame_at`, `last_detection_at`, `last_violation_at`; System health shows Last frame / Last detection / Last violation (red / amber when stale) next to the existing status and reconnects | Browser: columns populated ("0 s ago", "1 min ago") | **Fixed** |
| — | **Evidence retention** (task 8, Low) | Images live in the same row as the record (BLOBs); only whole-record retention existed | `evidence_retention_days` (0 = keep with record): removes images of *ended* violations older than N days, keeps record, metadata and thumbnail, never touches ongoing events; runs with the hourly retention and after config saves; logged; viewer says when images were removed | `test_evidence_retention_keeps_records_and_thumbnails` | **Done** |
| 27 | Remaining duplicates on real footage | A worker who walks **away from a group** while the group's event continues, or a pair boxed two different ways at the same moment, gets a second record: position/overlap can't tell people apart | Not changed: needs appearance re-identification (extra model per person = CPU work, out of scope here); widening the overlap rules further would merge genuinely different people | Footage contact sheet (gate-1, 4 min): pair now 1–3 records instead of 7; other records are different people | **Open** (Medium) |
| 28 | Burned-in text is ASCII only | OpenCV Hershey fonts | Separators use "\|"; a non-ASCII camera name would show "?" on the evidence image (UI text unaffected) | — | **Open** (Low) |

Deployment note: none of this is live. `docker compose up -d --build` → on first start the violations table gets 8 new nullable columns (seconds; old rows show as "Ended", no metadata).

---

# Pre-deployment review + test-environment E2E — 26 Sep 2026, 21:35–22:00

**Important:** production (`ppe_monitoring-ppe-monitor-1`) was **rebuilt and recreated at 21:36:10 from the current source** (i.e. with this pass's code) — not by this session (which only built `ppe-monitor:candidate`). The DB migration already ran there. The previous production image (20:32) is kept as `ppe-monitor:rollback-2032`.

## Pre-deployment review

| Check | Result |
|---|---|
| Backend diff vs the 20:32 image | All hunks intentional. **Unintended change found and fixed:** scripted edits had converted 5 files from CRLF to LF (`detector.py`, `violations.py`, `ppe_logic.py`, `config_store.py`, `tests/test_tracker_and_alerts.py`); CRLF restored, diff back to real changes only |
| Files changed after 20:30 by anyone else | None (all modifications since then are this session's) |
| `AddCameraPage.tsx` (team edit 20:11) | Team's `detectPhone` toggle and `detect_phone: true` in the saved camera intact; only their inline warning now uses the shared `phoneProblem()` (also catches the `${PPE_PHONE_WEIGHTS:-}` placeholder their check missed); their "model set" text kept verbatim |
| Migration on a copy of the 25 Sep backup (7,255 violations, pre-AUTOINCREMENT) | Row fingerprint (ids, times, cameras, tracks, missing, image + thumbnail bytes, acks) identical before/after; audit (4,879) and users identical; integrity ok; ~1.1 s; ids continue after #12091 |
| Old vs new code output | First 9 CSV columns byte-identical, list fields identical, ack #2061 preserved, full image identical |
| Rollback | 20:32 image opens the migrated DB, lists/exports identically, writes new rows; new code reads them |
| Config safety | Removal guard on save / raw YAML / reset / restore; reset without body keeps cameras (old clients) |

## Test-environment E2E (image `ppe-monitor:candidate`, container `ppe-qa` :8001, 4 cameras on NVR footage)

| Area | Result |
|---|---|
| Login / Admin access | Pass — Admin: no Users/Audit/Add camera, direct URL denied, no select/delete; Admin can edit a camera (200) but not remove one even with `confirm_remove` (403) |
| Add / Edit camera | Pass — added from server file with Boots + phone; rename saves with no dialog; source change shows "Changed: source.fps, source.uri" confirmation |
| Phone toggle / missing-model warning | Pass — shown on Add camera, Streams and Model section before a model exists; cleared once the model is configured (`capabilities.phone.loaded: true`, OpenVINO export ok) |
| PPE "Not checked" | Pass — Boots note on Add camera; `unenforced` lists boots/ear/gloves/goggles for gate-1 |
| Violation creation | Pass — records created on all cameras, no drops / errors |
| Temporal confirmation | Pass — 137 records: detected→confirmed 1.85–6.57 s (median 4.0 s), none under 1 s |
| Duplicate prevention | **FAIL (#29, over-merging)** — see below |
| Evidence / Original / Person crop | Pass — all three served; bytes match stored SHA-256 |
| Lifecycle | Pass, with **defect #31** (last-seen before confirmed right after creation) |
| Audit metadata | Pass — model + SHA, phone model, per-item confidence ("not seen" vs detected), settings, config hash; ack audited |
| Config save / reset / restore safety | Pass — dropping 2 cameras, unconfirmed factory reset and restoring the oldest backup all 409 with the camera list; cameras unchanged |
| System health | Pass — connected, last frame (0 s), last detection (<1 s), last violation |
| Evidence retention | Pass — 2 synthetic 3-day-old ended records purged (thumbnail + record kept), old *ongoing* one and recent ones untouched, logged |
| CSV export (UI download) | Pass — 349 rows, 14 columns, legacy rows export with neutral new columns |
| Phone-width (390 px) | Pass — no horizontal overflow on Dashboard, Violations, viewer, Config, Add camera, System |
| Phone detection | **FAIL (#30 regression + #32 model limitation)** — see below |

## New issues

| # | Issue | Severity | Root cause | Evidence | Status |
|---|---|---|---|---|---|
| 29 | **Different workers merged into one long event (missed violations)** | **High** | `Incident.member_boxes` keeps the box of every track ever merged, never expired; a new worker whose box lies inside a departed track's old group box joins the event, which never ends while anyone non-compliant stays in the area | gate-1: one event 550 s / 592 observations and no new gate-1 records for 9 min on busy footage; reproduced with the real `AlertDebouncer`: worker B 70 px away 10 min later merged into worker A's event via track 1's stale group box | **Open** — fix: keep only member boxes seen within `gap` s (not changed, per instruction). **Live in production** |
| 30 | **Phone use never evaluated after enabling the phone model without a camera restart** | **High** | `StreamWorker._live_behaviors` (pass 1) is learned once on the first frame with `_detectable`; a hot-loaded phone model is never picked up. UI meanwhile says phone use is checked | 716 samples after enabling: no worker had a `phone_use` status; after a container restart: 515 judgements | **Open** — workaround: restart the cameras/server after setting the phone model; fix: re-learn when the engine's detector changes. **Live in production** |
| 31 | "Last seen" earlier than "Confirmed" for ~2 s after a violation is created | Low | `store.add()` sets `end_ts` to the detected time; corrected by the first event write | Viewer: Confirmed 21:42:29, last seen 21:42:24 | **Open** |
| 32 | **Phone detection does not detect phones on this footage** | High (feature unusable) | COCO `yolov8n` can't resolve phones at this camera distance (~10–20 px) | Live 5 min after restart: 796 samples, **0** phone detections, 0 phone violations. Offline on 40 full-res frames with workers: **0** phones at conf ≥ 0.15 on the pipeline input (960 px @480), full-res frame @1280 and full-res person crops @640, while 323–398 persons were found; crops #370/#371 (hand to ear) and #382 (looking at hands) plausibly show phone use | **Open** — needs closer cameras / sub-regions, or a fine-tuned phone model; not a pipeline bug |

---

# Mobile suitability check — 27 Sep 2026

Method: headless Chrome at 360×740, 390×844 and 768×1024 on every page (Dashboard, Violations, Analytics, System health, Config, Add camera, Users, Audit, Login) and the main dialogs (camera detail, violation viewer, create user); measured page overflow and elements past the screen edge, and reviewed screenshots. Test environment only (`ppe-qa`, local build); not deployed.

**Verdict before fixes: not suitable on phones** (fine on tablets). After fixes: all 34 page/dialog checks at 360 and 390 px have no horizontal overflow, and screenshots read correctly; desktop (1440 px) unchanged.

| # | Issue (phone width) | Cause | Fix | Result |
|---|---|---|---|---|
| 33 | Page title missing on every page ("S…", "Co…" or nothing) | Header squeezes title + action buttons + clock into one 64 px row | Header wraps into title row + actions row on phones and isn't sticky there; clock hidden below tablet width (`Topbar.tsx`) | Titles + subtitles visible |
| 34 | Analytics: page 70 px wider than the screen | Same header row (3 buttons + clock) | As #33 (was #14) | 0 px overflow |
| 35 | Dashboard summary tiles truncated ("VIOLATI", "act…", "all l…") | Three columns in ~230 px | One compact row per tile on phones (`SafetySummary.tsx`) | Readable |
| 36 | Violations filters cramped ("All", "Op"); status label cut (was #13) | Two columns + "Clear filters" `col-span-2` forcing an implicit 2nd column | One column on phones, span only from `sm` (`ViolationsPage.tsx`) | Full labels |
| 37 | Violation card: time label wrapped into the "Ongoing" badge | Label could wrap; badge in the same corner | Label no-wrap, badge moved above it | No overlap |
| 38 | Card checkboxes 24 px (hard to tap) | — | 32 px touch target on phones | Easier to tap |
| 39 | Config: sticky toolbar covered ~⅓ of a phone screen | Sticky at every width | Sticky from tablet width up (`ConfigPage.tsx`) | Scrolls away on phones |
| 40 | Users: table crushed, role dropdown an empty sliver | Table squeezed to the screen; `w-36` overridden by the shared `w-full` | Tables get a minimum width and scroll inside their card (Users, Audit, System health); role select `min-w-36` | Role readable (144 px), columns readable |
| 41 | Add camera: source cards clipped at the right | Unbreakable example URLs widened the grid | `min-w-0` + `overflow-wrap:anywhere` (`AddCameraPage.tsx`) | Cards fit |
| — | Page padding 24 px beside a 64 px icon rail | — | 12 px on phones (`PageBody.tsx`), Violations day headers follow | More room |

Known limitation: the icon rail stays 64 px on phones (no bottom bar); wide tables (Users, Audit, System health) scroll sideways inside their card.
