# Security

How the PPE Compliance Monitor protects accounts, camera credentials and worker photos, what the
October 2026 review found and fixed, and the checklist to complete before go-live.

## 1. What needs protecting

| Asset | Why it matters | Where it lives |
|---|---|---|
| Worker photos (evidence, crops, full frames) | Personal data of identifiable employees | `violations.db` (SQLite) |
| Accounts and sessions | A Super Admin controls cameras, users and data | `users` / `refresh_tokens` tables; JWT signed with `PPE_JWT_SECRET` |
| Camera / NVR passwords | Often shared across the plant's camera network | `config.yaml`, encrypted (`enc:...`) |
| Alarm credentials | SMTP password, webhook URL | `config.yaml` or `PPE_SMTP_PASSWORD` |
| The server itself | Sits on the plant network next to OT systems | Docker container |

## 2. Controls in place

**Sign-in and sessions**
- Passwords hashed with bcrypt (cost 12). Policy: 8+ characters, a letter and a digit, not the
  username, not the old public bootstrap password.
- No published default password. The first Super Admin gets `PPE_INITIAL_ADMIN_PASSWORD` or a
  random one-time password printed once in the server log, and must change it at first sign-in.
- Lockout per (IP, username) after 5 failures, doubling on every further lockout up to 1 hour, plus
  a per-account limit of 20 failures from any IPs within 5 minutes.
- Access token (15 min) kept in browser memory only. Refresh token is opaque, stored hashed,
  rotated on use, in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`; reuse revokes
  every session of that user.
- Unknown user and wrong password return the same message (no user enumeration).

**Authorisation**
- Two roles. Admin: monitor, review, CSV export, per-camera settings. Super Admin: everything,
  including users, audit trail, system settings and the photo dataset export.
- Every API route and the WebSocket check a permission; a test walks the whole route table.
- Admins never receive the SMTP password or webhook URL, and cannot export worker photos in bulk.

**Data**
- Camera passwords encrypted at rest (Fernet); shown as `********`; re-sent only to the same
  camera address they were saved for.
- Every sign-in, failed sign-in, user change, config change (with before/after), review, export
  and deletion is in the audit trail with user, time and IP.
- Incidents and their photos are deleted after `alerts.retention_days` (default 30);
  `alerts.evidence_retention_days` can drop photos earlier while keeping the record.
- CSV exports neutralise cells that Excel would run as formulas.

**Web and server**
- Content-Security-Policy (only the app's own scripts, plus one inline script allowed by hash),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`.
- No cross-origin API access by default (`server.cors_origins: []`).
- Static files are served only from the built UI folder.
- Camera addresses must use `rtsp(s)://` or `http(s)://`; recordings and image folders must be
  inside the videos folder; camera fields can only reference `${PPE_VIDEOS_DIR}`, never other
  environment variables.
- Docker image runs as an unprivileged user and never contains `.env` or database files.
- Ultralytics releases 8.3.41, 8.3.42, 8.3.45 and 8.3.46 (Dec 2024 supply-chain attack) are excluded.

## 3. Review of October 2026

An independent code review found the issues below; all code-level issues are fixed and covered by
tests in `backend/tests/test_security.py` and `test_config.py`.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Critical | Encoded `../` in a URL let anyone, without signing in, download any file the server could read (database, `.env`) | The UI route resolves the path and serves only files inside the build folder |
| 2 | Critical | An Admin could make a camera address expand `${PPE_JWT_SECRET}` and read it back, then forge a Super Admin session | Camera fields expand only `${PPE_VIDEOS_DIR}` |
| 3 | High | A masked camera password could be sent to any host an Admin chose | Stored password reused only for the same scheme, host and port |
| 4 | High | The connection test could fetch internal URLs, `file:` / `concat:` sources and any server folder | Scheme allow-list; files confined to the videos folder |
| 5 | High | No HTTPS, container ran as root, `.env` could be copied into the image | Non-root image, `.dockerignore` for secrets; HTTPS via `deploy/` (to deploy) |
| 6 | Medium | Public default password: the first person to reach the sign-in page owned the system | One-time or operator-chosen initial password |
| 7 | Medium | Weak brute-force protection | Escalating and per-account lockout |
| 8 | Medium | Admins could read the SMTP password and webhook URL | Masked for Admins; preserved on their saves |
| 9 | Medium | Admins could bulk-export up to 2000 worker photos | New Super Admin-only permission `violations:export_images` |
| 11 | Low | No browser security headers | Added (see section 2) |
| 12 | Low | Any website could call the API from a browser | CORS closed by default |
| 13 | Low | CSV formula injection | Cells escaped |
| 15 | Low | Compromised Ultralytics versions allowed by the version range | Excluded |

Not changed in code (decisions or deployment work): retention period for photos (EHS / legal
decision), "keep me signed in" length (30 days), upload size limit (8 GB, Super Admin only),
exact version pinning with hashes (recommended for release builds).

### Known limitations
- **rtsps cameras and `ps`.** The system `ffmpeg` / `ffprobe` that decode `rtsps://` cameras receive the camera URL,
  password included, on their command line, which other local accounts can read. Run the app in its container
  (as the compose files do) and keep shell access to the server limited. RTSP/HTTP cameras decoded by OpenCV are not affected.
- **Interactive API docs** (`/docs`) are off unless `PPE_API_DOCS=1` is set.

## 4. Go-live checklist

- [ ] Served over HTTPS only: `docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml up -d`
      with the plant certificate in `deploy/certs/` (see [`DEPLOYMENT.md`](DEPLOYMENT.md)).
- [ ] `PPE_JWT_SECRET` set to a new random value (48+ characters). Rotate it if any image was ever
      built while `backend/.env` existed.
- [ ] `PPE_SECRET_KEY` set to its own random value **before** cameras are added. Without it camera
      passwords are encrypted with `PPE_JWT_SECRET`, and rotating that secret makes them unreadable.
- [ ] `PPE_COOKIE_SECURE=true` (set by the HTTPS override).
- [ ] First sign-in done by the owner; `PPE_INITIAL_ADMIN_PASSWORD` removed from `.env` afterwards.
- [ ] Server firewall: only 443 (and 80 for the redirect) open to the plant network; SSH limited to IT.
- [ ] Camera accounts on the NVR are view-only.
- [ ] Retention agreed with EHS / legal and set in Settings.
- [ ] Database volume (`./data`) on an encrypted disk; backups encrypted and access-controlled.
- [ ] Old local database backups that hold worker photos deleted
      (e.g. `backend/data/violations.backup-before-wipe-*.db`).
- [ ] Ultralytics licence resolved (AGPL-3.0: Enterprise licence or legal sign-off).
- [ ] UAT security cases SEC-01 to SEC-06 passed on the production server.

## 5. Reporting a security problem

Do not open a public ticket. Tell the product owner and plant IT directly, with the steps to
reproduce. Rotate `PPE_JWT_SECRET` (signs everyone out) if a session or the secret may be exposed.
