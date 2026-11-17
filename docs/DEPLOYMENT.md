# Deployment: plant server

Step-by-step installation of the PPE Compliance Monitor on the plant server (NVIDIA GPU, Docker,
HTTPS), plus first sign-in, backups, upgrades and troubleshooting. Sizing is in
[`CAPACITY_PLANNING.md`](CAPACITY_PLANNING.md); the security checklist is in [`SECURITY.md`](SECURITY.md).

## 1. What you need

| Item | Detail |
|---|---|
| Server | Linux (Ubuntu 22.04/24.04 LTS), NVIDIA GPU, 16+ cores, 32 GB RAM, SSD (see capacity guide) |
| Software | Docker Engine + Compose v2.24 or newer, NVIDIA driver, NVIDIA Container Toolkit |
| Network | A fixed IP and a DNS name (e.g. `ppe.plant.local`); access to the NVR / cameras on RTSP (554) |
| Certificate | Plant / company TLS certificate for that name (`cert.pem` + `key.pem`), or use Caddy's internal CA |
| Cameras | RTSP **sub-stream** address of each camera, and a view-only NVR account |
| Model | `models/safesight/best.pt` (copied with the repo's `models/` folder) |

## 2. Install

```bash
# 1. code and model
git clone <repo-url> /opt/ppe && cd /opt/ppe          # or copy the project folder
ls models/safesight/best.pt

# 2. settings
cp .env.example .env
python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # run twice: PPE_JWT_SECRET and PPE_SECRET_KEY
```

Set in `.env`:

```ini
PPE_JWT_SECRET=<first value printed above>      # signs sign-in sessions
PPE_SECRET_KEY=<second value>                    # encrypts camera passwords; keep it forever, back it up
PPE_CPUS=14                   # CPU cores the container may use (compose default is only 4): decoding needs them
PPE_DOMAIN=ppe.plant.local
TZ=Asia/Kolkata
TORCH_INDEX=cu124             # NVIDIA build of PyTorch
PPE_INITIAL_ADMIN_PASSWORD=<a strong temporary password, removed after first sign-in>
PPE_UID=1000                  # the user that owns the folders below
PPE_GID=1000
```

```bash
# 3. folders the container writes to, owned by PPE_UID:PPE_GID (the container is not root)
mkdir -p config data videos deploy/certs
sudo chown -R 1000:1000 config data videos models

# 4. certificate (skip to use Caddy's internal CA, see deploy/Caddyfile)
cp /path/to/cert.pem /path/to/key.pem deploy/certs/
#    then in deploy/Caddyfile: comment "tls internal", uncomment "tls /certs/cert.pem /certs/key.pem"
```

**Enable the GPU:** in `docker-compose.yml`, uncomment the `deploy: resources: reservations:
devices: - driver: nvidia ...` block at the end of the service. Check the toolkit first:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

**Start, with HTTPS in front:**

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml up -d --build
docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml logs -f ppe-monitor
```

**First start on the GPU takes several minutes:** the app builds a TensorRT engine once
(log: `building TensorRT engine ...`), cached as `models/safesight/best_480_b32_fp16.engine`. Later
starts take seconds. When it is ready the log shows `model best_480_b32_fp16.engine on cuda:0`; if
the build failed it shows `model best.pt on cuda:0` (PyTorch, slower but working). On a machine
without an NVIDIA GPU: `intel:cpu`.

An engine only works on the GPU model and TensorRT version that built it. After replacing the GPU
or upgrading the image, delete `models/safesight/*.engine` so it is rebuilt (otherwise the app logs
the load error and falls back to PyTorch).
Port 8000 is not published; users reach `https://ppe.plant.local`, and `http://` redirects.

Tip: put both file names in `.env` as `COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.https.yml`
so every `docker compose ...` command uses them.

## 3. First sign-in

1. Open `https://ppe.plant.local` and sign in as **admin** with `PPE_INITIAL_ADMIN_PASSWORD`.
   Without that variable, the one-time password is in the log:
   `docker compose logs ppe-monitor | grep SECURITY`.
2. Set a new password (forced).
3. Remove `PPE_INITIAL_ADMIN_PASSWORD` from `.env` (it is used only while no users exist).
4. Setup > People: create named accounts (Super Admin for IT, Admin for supervisors and reviewers).
   Avoid shared accounts: the audit trail records people by account.

## 4. Add cameras

1. Setup > Cameras & zones > **Add camera** > RTSP. Use the **sub-stream** address, e.g.
   `rtsp://<nvr-ip>:554/Streaming/Channels/102` (Hikvision style; check the NVR manual), the
   view-only username and password. **Test connection**, then save.
2. Required PPE: only items the model detects (helmet, vest, mask with the current model). Others
   show as "not checked".
3. Draw zones where PPE applies, is ignored, or the area is restricted.
4. Add cameras in steps of 5 and watch **Setup > System health** and the **capacity planner**
   (see the capacity guide) before adding the next 5.

## 5. Backups

What to back up: `data/violations.db` (users, incidents, audit trail), `config/` (settings and
camera list with encrypted passwords), and `.env` (`PPE_SECRET_KEY` is needed to decrypt the camera
passwords; without it every camera password must be typed in again). Backups contain worker photos and secrets: store them encrypted with
restricted access.

```bash
# consistent copy while running (SQLite online backup)
docker compose exec ppe-monitor python -c "import sqlite3; s=sqlite3.connect('/app/data/violations.db'); d=sqlite3.connect('/app/data/backup.db'); s.backup(d); d.close()"
mv data/backup.db /secure/backups/ppe-$(date +%F).db
tar czf /secure/backups/ppe-config-$(date +%F).tgz config .env
```

Restore: stop the stack, put the files back in `data/` and `config/`, start again.

## 6. Upgrade and rollback

```bash
cd /opt/ppe
# backup first (section 5)
git pull                       # or copy the new release
docker compose up -d --build   # with the HTTPS override (COMPOSE_FILE in .env)
```

The database is migrated automatically on start. Rollback: check out the previous release,
rebuild, and restore the backup if the new version changed the database.

## 7. Day-to-day

| Task | Where |
|---|---|
| Is every camera delivering? | Setup > System health |
| Reset a user's password | Setup > People > user > Reset password |
| Change retention, alarms, detection settings | Setup > Detection (applied without restart) |
| Who did what | Setup > Audit trail |
| Restart | `docker compose restart ppe-monitor` |

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Container exits with `Permission denied` on `/app/config` or `/app/data` | Folders not owned by `PPE_UID`: `sudo chown -R 1000:1000 config data videos models` |
| Log says `model best.pt on cuda:0` (not `.engine`) | TensorRT engine build failed: check the log above it; the image must be built with `TORCH_INDEX=cu124` (installs TensorRT). Detection works, 2-3x slower |
| Log says `TensorRT engine ... failed to load` | Engine built for another GPU or TensorRT version: delete `models/safesight/*.engine` and restart |
| Log says `intel:cpu` on the GPU server | GPU block not enabled in `docker-compose.yml`, image built without `TORCH_INDEX=cu124`, or NVIDIA Container Toolkit missing |
| Browser warns about the certificate | Using `tls internal`: install Caddy's root CA on the PCs, or use the plant certificate |
| Everyone signed out after a restart | `PPE_JWT_SECRET` not set or changed |
| Cameras fail with a decryption / password error after changing secrets | `PPE_SECRET_KEY` was not set, so camera passwords were encrypted with `PPE_JWT_SECRET`; put the old secret back, or re-enter the camera passwords |
| Detection slow although the GPU is idle, CPU at 400% | Container capped by `PPE_CPUS` (default 4): raise it in `.env` |
| Sign-in lockouts hit everyone at once | Proxy IP seen instead of users': run with the HTTPS override (sets `PPE_TRUSTED_PROXIES`) |
| Camera "Reconnecting" | Address, port 554 firewall, credentials, or NVR stream limit; use **Test connection** for the exact error |
| System health says "Saturated" | More cameras than the server can check: see the capacity guide, section 7 |
| Camera password must be re-entered | The camera address changed: by design, a saved password is only reused for the same camera |

## 9. Local development (no Docker)

```bash
conda activate ppe                                   # Python 3.11 env with backend/requirements.txt
cd frontend && npm install && npm run build          # UI into frontend/dist
cd ../backend && python run.py                       # http://localhost:8000
pytest -q                                            # 307 tests
```
