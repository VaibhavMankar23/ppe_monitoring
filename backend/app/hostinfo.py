"""What the server knows about itself, for the System health page and the footer.

* **Load of the whole application.** rtsps:// cameras are decoded by separate ffmpeg processes, so the Python
  process alone is a fraction of the real CPU and memory use. The sampler adds up the process and all of its
  children.
* **Sampled by one background thread** every few seconds. ``cpu_percent`` measures "since the previous call";
  when each page request made that call, overlapping requests produced 0 % and noise. Readers only copy the
  latest sample, so any number of browsers sees the same, steady figure.
* **Identity** (name, version, build) so a person can tell which deployment they are looking at.
* **GPUs** from ``nvidia-smi`` (memory and load of every card). It is not asked through PyTorch: that would open
  a CUDA context, and take GPU memory, on cards the application is not using.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
from typing import Any

log = logging.getLogger(__name__)

APP_VERSION = "1.0"
SAMPLE_EVERY = 2.0  # s
GPU_EVERY = 6.0  # s


def server_info() -> dict[str, Any]:
    """Who this is. PPE_SERVER_NAME is set in .env (a container's own host name is a random id)."""
    return {
        "name": os.environ.get("PPE_SERVER_NAME", "").strip() or socket.gethostname(),
        "version": APP_VERSION,
        "build": os.environ.get("PPE_GIT_COMMIT", "").strip() or None,
    }


def parse_nvidia_smi(text: str) -> list[dict[str, Any]]:
    """Rows of ``nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu
    --format=csv,noheader,nounits``. Values the driver does not report ([N/A]) become None."""
    def num(v: str) -> int | None:
        try:
            return int(float(v))
        except ValueError:
            return None

    out = []
    for line in text.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6 or num(parts[0]) is None:
            continue
        out.append({"index": num(parts[0]), "name": parts[1], "memory_used_mb": num(parts[2]),
                    "memory_total_mb": num(parts[3]), "utilization_percent": num(parts[4]), "temperature_c": num(parts[5])})
    return out


def read_gpus() -> list[dict[str, Any]]:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL)
        return parse_nvidia_smi(r.stdout) if r.returncode == 0 else []
    except (OSError, subprocess.SubprocessError):
        return []  # no NVIDIA driver / tool in this container: the page simply has no GPU section


class HostSampler:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._start_lock = threading.Lock()
        self._host: dict[str, Any] = {}
        self._gpus: list[dict[str, Any]] = []
        self._procs: dict[int, Any] = {}  # kept between samples: a fresh Process always reports 0.0 CPU
        self._thread: threading.Thread | None = None
        self._last_gpu = 0.0

    # ------------------------------------------------------------------ sampling
    def sample(self) -> None:
        """One measurement of the machine and of the application's whole process tree."""
        try:
            import psutil

            cores = psutil.cpu_count() or 1
            root = psutil.Process()
            tree = [root, *root.children(recursive=True)]
            live: dict[int, Any] = {}
            for p in tree:
                known = self._procs.get(p.pid)
                live[p.pid] = known if known is not None and known == p else p
            self._procs = live
            cpu = rss = 0.0
            for p in live.values():
                try:
                    cpu += p.cpu_percent(interval=None)
                    rss += p.memory_info().rss
                except psutil.Error:
                    continue  # exited since the listing
            host = {
                "cpu_percent": psutil.cpu_percent(interval=None),
                "process_cpu_percent": round(min(100.0, cpu / cores), 1),
                "memory_percent": psutil.virtual_memory().percent,
                "process_rss_mb": round(rss / 2**20),
                "process_count": len(live),
                "threads": root.num_threads(),
                "cpu_count": cores,
            }
        except Exception:  # psutil missing / restricted: the rest of the page is still useful
            host = {"threads": threading.active_count()}
        with self._lock:
            self._host = host

    def _sample_gpus(self) -> None:
        gpus = read_gpus()
        with self._lock:
            self._gpus = gpus

    def _run(self) -> None:
        while True:
            try:
                self.sample()
                if time.monotonic() - self._last_gpu >= GPU_EVERY:
                    self._last_gpu = time.monotonic()
                    self._sample_gpus()
            except Exception:
                log.exception("host sampling failed")
            time.sleep(SAMPLE_EVERY)

    def _ensure_started(self) -> None:
        if self._thread is not None:
            return
        with self._start_lock:  # not self._lock: sample() takes that one
            if self._thread is None:
                self.sample()  # primes the CPU counters and gives the first reader something real
                thread = threading.Thread(target=self._run, name="host-sampler", daemon=True)
                thread.start()
                self._thread = thread

    # ------------------------------------------------------------------ readers
    def host(self) -> dict[str, Any]:
        self._ensure_started()
        with self._lock:
            return dict(self._host) if self._host else {"threads": threading.active_count()}

    def gpus(self) -> list[dict[str, Any]]:
        self._ensure_started()
        with self._lock:
            return [dict(g) for g in self._gpus]


sampler = HostSampler()
