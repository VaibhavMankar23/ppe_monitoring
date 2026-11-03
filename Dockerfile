# ---------- stage 1: build the React dashboard ----------
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- stage 2: Python backend (serves API + built dashboard) ----------
FROM python:3.11-slim AS backend

# cpu (default) or e.g. cu124 for an NVIDIA CUDA build of torch
ARG TORCH_INDEX=cpu
# the app runs as this unprivileged user; match the owner of the host folders mounted at /app/*
ARG APP_UID=1000
ARG APP_GID=1000

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PPE_STATIC_DIR=/app/frontend/dist \
    PPE_MODEL_WEIGHTS=/app/models/safesight/best.pt \
    PPE_VIDEOS_DIR=/app/videos \
    PPE_CONFIG=/app/config/config.yaml \
    PPE_DB_PATH=/app/data/violations.db \
    YOLO_CONFIG_DIR=/tmp/ultralytics

# libGL/glib for OpenCV, ffmpeg libs for RTSP/HTTP decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/${TORCH_INDEX} \
 && pip install -r requirements.txt
# NVIDIA builds (TORCH_INDEX=cu*): what the one-time TensorRT engine build needs. Installed here because
# the container runs as a non-root user and cannot pip-install at runtime.
RUN case "${TORCH_INDEX}" in cu*) pip install "tensorrt-cu12>=10,!=10.2.0,<11" "onnx>=1.12,<2" "onnxslim>=0.1.82" onnxruntime-gpu ;; esac

COPY backend/ ./
COPY --from=frontend /frontend/dist /app/frontend/dist

# not root: a compromise of the web app must not own the container. Host folders mounted at
# /app/config, /app/data, /app/videos and /app/models must be writable by APP_UID:APP_GID.
RUN groupadd -g ${APP_GID} ppe && useradd -u ${APP_UID} -g ${APP_GID} -M -d /app -s /usr/sbin/nologin ppe \
 && mkdir -p /app/config /app/data /app/videos /app/models /tmp/ultralytics \
 && chown -R ppe:ppe /app/config /app/data /app/videos /app/models /tmp/ultralytics
USER ppe

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s CMD curl -fs http://localhost:8000/api/health || exit 1
# First start: seed the persistent config volume from the shipped defaults.
# config.default.yaml (used by "Reset to defaults") is refreshed on every start so it matches this image.
CMD ["sh", "-c", "mkdir -p /app/config /app/data && ([ -f /app/config/config.yaml ] || cp /app/backend/config.default.yaml /app/config/config.yaml) && cp /app/backend/config.default.yaml /app/config/config.default.yaml && exec python run.py"]
