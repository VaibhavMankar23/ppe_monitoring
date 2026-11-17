# Setup and Deployment Guide

Every step needed to install the PPE Compliance Monitor on a plant server, put it live and keep it
running. Follow the sections in order. Background reading:
[`docs/CAPACITY_PLANNING.md`](docs/CAPACITY_PLANNING.md) (sizing),
[`docs/SECURITY.md`](docs/SECURITY.md) (security checklist),
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (deployment details and troubleshooting).

---

## 1. Prerequisites

### Hardware

| Deployment | Server |
|---|---|
| **Production (30-45 cameras)** | Linux server, one NVIDIA GPU (RTX 4070 / RTX A4000 / L4 class), 16+ CPU cores, 32 GB RAM, 200 GB+ encrypted SSD |
| Pilot (1-5 cameras) | Any modern Intel PC/laptop (runs on CPU with OpenVINO), 8+ cores, 16 GB RAM |

Size the production server with [`docs/CAPACITY_PLANNING.md`](docs/CAPACITY_PLANNING.md).
Use camera **sub-streams**: decoding 45 full-HD main streams alone needs about 14 CPU cores; sub-streams cut that 5-10x.

### Software

| Item | Version | Check |
|---|---|---|
| OS | Ubuntu 22.04 / 24.04 LTS | `lsb_release -a` |
| Docker Engine | 24+ | `docker --version` |
| Docker Compose | **v2.24 or newer** | `docker compose version` |
| NVIDIA driver (GPU only) | 550+ | `nvidia-smi` |
| NVIDIA Container Toolkit (GPU only) | latest | see step 3.3 |
| Git (optional) | any | `git --version` |

The server needs internet access **during the build** (Docker images, Python and npm packages).
At run time it needs only the plant network.

### Network and access

| Item | Detail |
|---|---|
| Server address | Fixed IP and a DNS name users will type, e.g. `ppe.plant.local` |
| Firewall | Users → server: TCP 443 (and 80, redirected to 443). Server → NVR/cameras: TCP 554 (RTSP) |
| Cameras | RTSP **sub-stream** URL of each camera, and a **view-only** NVR account |
| TLS certificate | Plant/company certificate for the DNS name (`cert.pem` + `key.pem`), or use Caddy's internal CA |

### Information to collect before you start

- [ ] List of cameras: name, location, RTSP URL, required PPE (helmet / vest / mask)
- [ ] Plant time zone (e.g. `Asia/Kolkata`)
- [ ] Names and emails of the people who need accounts (Super Admin = IT, Admin = EHS/supervisors)
- [ ] Alert recipients (email / webhook), if alarms are needed
- [ ] Retention period for violation evidence (default 30 days; check the plant's privacy policy)

---

## 2. Get the code and model

```bash
sudo mkdir -p /opt/ppe && sudo chown $USER /opt/ppe
git clone <repo-url> /opt/ppe          # or copy the release folder / unzip the release archive
cd /opt/ppe
```

Check that the model weights are present (they are mounted into the container, not built into it):

```bash
ls -lh models/safesight/best.pt        # PPE model (YOLO11s, ~18 MB)
ls -lh models/coco/yolov8n.pt          # person detector (~6 MB)
```

---

## 3. Configure

### 3.1 Create `.env`

```bash
cp .env.example .env
python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # run twice: one value per secret
```

Edit `.env` and set:

```ini
# --- required ---
PPE_JWT_SECRET=<first random value>         # signs sign-in sessions
PPE_SECRET_KEY=<second random value>        # encrypts camera passwords - never change it, back it up
PPE_INITIAL_ADMIN_PASSWORD=<strong temporary password>   # removed after first sign-in (step 6)
TZ=Asia/Kolkata                             # plant time zone

# --- server ---
PPE_DOMAIN=ppe.plant.local                  # the name users type
PPE_CPUS=14                                 # CPU cores for the container (default 4 is too low for many cameras)
PPE_UID=1000                                # owner of the data folders (see 3.2): `id -u`
PPE_GID=1000                                #                                    `id -g`

# --- GPU server only ---
TORCH_INDEX=cu124                           # NVIDIA build of PyTorch + TensorRT

# --- so every `docker compose` command uses HTTPS (recommended) ---
COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.https.yml
```

> `.env` holds secrets. Restrict it: `chmod 600 .env`. Never commit or e-mail it.

### 3.2 Create the data folders

The container runs as a non-root user, so the folders it writes to must be owned by
`PPE_UID:PPE_GID`:

```bash
mkdir -p config data videos deploy/certs
sudo chown -R 1000:1000 config data videos models      # use your PPE_UID:PPE_GID
```

| Folder | Holds | Persistent |
|---|---|---|
| `config/` | `config.yaml` (settings, camera list, encrypted camera passwords) + automatic backups | yes |
| `data/` | `violations.db`: violations, evidence references, users, audit log | yes |
| `videos/` | uploaded recordings (optional) | yes |
| `models/` | model weights + engine cache built on first start | yes |

### 3.3 Enable the NVIDIA GPU (GPU server only)

1. Install the NVIDIA Container Toolkit
   ([guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)),
   then check it:

   ```bash
   docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
   ```

2. In `docker-compose.yml`, uncomment the block at the end of the service:

   ```yaml
       deploy:
         resources:
           reservations:
             devices:
               - driver: nvidia
                 count: all
                 capabilities: [gpu]
   ```

**Intel CPU/iGPU pilot instead:** leave the NVIDIA block commented and `TORCH_INDEX` unset. For the
Intel iGPU, uncomment the `devices: - /dev/dri:/dev/dri` block.

### 3.4 HTTPS certificate

Pick one:

- **Plant/company certificate (recommended):**

  ```bash
  cp /path/to/cert.pem /path/to/key.pem deploy/certs/
  chmod 600 deploy/certs/key.pem
  ```

  In `deploy/Caddyfile`, comment `tls internal` and uncomment `tls /certs/cert.pem /certs/key.pem`.

- **Caddy internal CA:** leave `deploy/Caddyfile` as it is. Browsers warn until Caddy's root
  certificate is installed on the users' PCs.

### 3.5 DNS

Ask IT to point `ppe.plant.local` (your `PPE_DOMAIN`) to the server's IP, or add it to the users'
hosts files for a pilot.

---

## 4. Build and start

```bash
cd /opt/ppe
docker compose up -d --build          # uses COMPOSE_FILE from .env (app + HTTPS proxy)
docker compose logs -f ppe-monitor    # Ctrl+C to stop following
```

The first build takes 10-20 minutes (it downloads PyTorch and builds the dashboard).

**First start on the GPU** also takes several minutes: the app builds a TensorRT engine once
(log: `building TensorRT engine ...`) and caches it in `models/safesight/`. Later starts take
seconds.

Without `COMPOSE_FILE` in `.env`, name both files on every command:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml up -d --build
```

---

## 5. Verify the installation

```bash
docker compose ps                                     # ppe-monitor "healthy", caddy "running"
docker compose exec ppe-monitor curl -fs http://localhost:8000/api/health && echo OK
docker compose logs ppe-monitor | grep -i "model"     # which model/device was loaded
```

| Log line | Meaning |
|---|---|
| `model best_480_b32_fp16.engine on cuda:0` | GPU with TensorRT: correct for production |
| `model best.pt on cuda:0` | GPU without TensorRT (engine build failed): works, 2-3x slower. See section 11 |
| `... intel:cpu` / `intel:gpu` | OpenVINO on Intel: fine for a pilot, **wrong on the GPU server** (see section 11) |

Open `https://ppe.plant.local` from a user PC. `http://` must redirect to `https://`. Port 8000 must
**not** be reachable from the LAN.

---

## 6. First sign-in and user accounts

1. Open `https://ppe.plant.local` and sign in as **`admin`** with `PPE_INITIAL_ADMIN_PASSWORD`.
   If you did not set it, a one-time password is printed once in the log:
   `docker compose logs ppe-monitor | grep SECURITY`.
2. Set a new strong password (forced on first sign-in).
3. **Remove `PPE_INITIAL_ADMIN_PASSWORD` from `.env`**, then `docker compose up -d`.
4. **Setup > People**: create one named account per person.
   - **Super Admin**: IT (users, cameras, settings, audit log).
   - **Admin**: EHS officers and supervisors (live view, review queue, analytics).
   Do not share accounts: the audit log records actions per account.

---

## 7. Add cameras

1. **Setup > Cameras & zones > Add camera > RTSP.**
   - URL: the camera's **sub-stream**, e.g. `rtsp://<nvr-ip>:554/Streaming/Channels/102`
     (Hikvision style; the path differs by NVR brand).
   - Username/password: the view-only NVR account (stored encrypted).
   - Click **Test connection**, then **Save**.
2. **Required PPE**: tick only what the model detects: **helmet, vest, mask**. Other items
   (gloves, goggles, boots, ear protection) are not detected by the current model.
3. **Zones**: draw where PPE is checked, where it is ignored (offices, walkways outside the
   shop floor) and which areas are restricted.
4. Add cameras **5 at a time**. After each batch, check **Setup > System health** (every camera
   "delivering", detector not "Saturated") before adding the next.

---

## 8. Detection, alerts and retention settings

**Setup > Detection.** Changes apply without a restart.

| Setting | Recommendation |
|---|---|
| Confidence | Start at the default (0.35). Raise it if there are too many false alarms |
| Retention | Match the plant's privacy policy (default 30 days) |
| Alarms | Configure e-mail / webhook recipients, then send a test alarm |
| Time zone | Comes from `TZ` in `.env`: check "violations today" matches the plant clock |

---

## 9. Go-live checklist

- [ ] `PPE_JWT_SECRET` and `PPE_SECRET_KEY` set, `.env` is `chmod 600`, both secrets backed up securely
- [ ] `PPE_INITIAL_ADMIN_PASSWORD` removed from `.env`
- [ ] Access only over HTTPS; port 8000 not reachable from the LAN
- [ ] Log line shows the TensorRT engine on `cuda:0` (GPU server)
- [ ] All cameras "delivering" in System health; detector not "Saturated"
- [ ] Zones drawn for every camera; required PPE matches the plant rule for that area
- [ ] Named user accounts created; default/shared accounts removed
- [ ] Alarm recipients receive a test alarm
- [ ] Backup job scheduled and one restore tested (section 10)
- [ ] EHS team trained on the **Review queue** (Valid / False alarm), since reviewed alerts measure accuracy
- [ ] Ultralytics licence resolved (AGPL-3.0: Enterprise licence or legal sign-off)
- [ ] UAT signed off ([`docs/UAT_TEST_PLAN.md`](docs/UAT_TEST_PLAN.md))
- [ ] Workers informed about camera-based PPE monitoring, as plant policy requires

---

## 10. Backups and restore

Back up these three things:

| What | Why |
|---|---|
| `data/violations.db` | users, violations, review verdicts, audit log |
| `config/` | settings and camera list (with encrypted passwords) |
| `.env` | `PPE_SECRET_KEY` is needed to decrypt camera passwords |

Daily backup (can be added to `cron`):

```bash
cd /opt/ppe
docker compose exec -T ppe-monitor python -c "import sqlite3; s=sqlite3.connect('/app/data/violations.db'); d=sqlite3.connect('/app/data/backup.db'); s.backup(d); d.close()"
mv data/backup.db /secure/backups/ppe-$(date +%F).db
tar czf /secure/backups/ppe-config-$(date +%F).tgz config .env
```

Backups contain **worker photos and secrets**: store them encrypted with restricted access.

**Restore:** `docker compose down`, copy the files back into `data/`, `config/` and `.env`, then
`docker compose up -d`.

---

## 11. Upgrade and rollback

```bash
cd /opt/ppe
# 1. back up first (section 10)
git pull                         # or copy the new release over the folder (keep config/ data/ videos/ .env)
docker compose up -d --build
docker compose logs -f ppe-monitor
```

The database is migrated automatically on start. Read [`CHANGELOG.md`](CHANGELOG.md) for settings to
change when upgrading.

**After changing the GPU, the driver or the image version**, delete the cached engine so it is
rebuilt: `rm models/safesight/*.engine && docker compose restart ppe-monitor`.

**Rollback:** check out the previous release, `docker compose up -d --build`, and restore the
backup if the new version changed the database.

**Replacing the model:** copy the new weights to `models/safesight/best.pt` (keep the old file),
delete `models/safesight/*.engine` and `models/safesight/*_openvino_model/`, then restart.

---

## 12. Day-to-day operations

| Task | How |
|---|---|
| Are all cameras working? | Setup > System health |
| Review alerts | Review queue: **V** = valid, **F** = false alarm |
| Reset a password | Setup > People > user > Reset password |
| Who changed what | Setup > Audit trail |
| Restart | `docker compose restart ppe-monitor` |
| Stop / start everything | `docker compose down` / `docker compose up -d` |
| Logs | `docker compose logs --tail 200 ppe-monitor` |
| Disk usage | `du -sh data config videos` |

---

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `set PPE_JWT_SECRET in .env` on `docker compose up` | `.env` missing or `PPE_JWT_SECRET` empty (step 3.1) |
| `env_file ... required` error | Docker Compose older than v2.24: upgrade it |
| Container restarts with `Permission denied` on `/app/config` or `/app/data` | Folders not owned by `PPE_UID:PPE_GID`: `sudo chown -R 1000:1000 config data videos models`. If you changed `PPE_UID`/`PPE_GID` after the first build, rebuild: `docker compose up -d --build` |
| Log says `intel:cpu` on the GPU server | NVIDIA block not uncommented, image not built with `TORCH_INDEX=cu124`, or Container Toolkit missing (3.3). Rebuild with `docker compose up -d --build` |
| Log says `model best.pt on cuda:0` (no `.engine`) | TensorRT build failed: read the log lines above. Works, 2-3x slower |
| `TensorRT engine ... failed to load` | Engine built for another GPU/TensorRT: `rm models/safesight/*.engine`, restart |
| Browser certificate warning | Using `tls internal`: install Caddy's root CA on the PCs or use the plant certificate (3.4) |
| Everyone signed out after a restart | `PPE_JWT_SECRET` missing or changed |
| Camera password error after changing secrets | `PPE_SECRET_KEY` changed or was never set: restore the old value, or re-enter camera passwords |
| Camera stuck on "Reconnecting" | Wrong URL/credentials, port 554 blocked, or NVR stream limit reached. **Test connection** shows the exact error |
| System health says "Saturated" | Too many cameras for the server: lower FPS per camera or add capacity (capacity guide, section 7) |
| Slow detection, GPU idle, CPU at 400% | Container limited by `PPE_CPUS`: raise it in `.env`, `docker compose up -d` |
| Everyone locked out at once after failed sign-ins | Running without the HTTPS override, so all users share the proxy IP: use `COMPOSE_FILE` (3.1) |

---

## 14. Local development (no Docker)

Python 3.11 and Node 20+:

```bash
# backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
echo "PPE_JWT_SECRET=$(python -c 'import secrets; print(secrets.token_urlsafe(48))')" > .env

# frontend
cd ../frontend && npm ci && npm run build      # dashboard into frontend/dist

# run
cd ../backend && python run.py                 # http://localhost:8000
pytest -q                                      # backend tests
```

For UI work with live reload, run `npm run dev` in `frontend/` (port 5173; it proxies `/api` and
`/ws` to port 8000).
