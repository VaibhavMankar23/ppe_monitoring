"""Start the PPE monitor API server.

    python run.py                      # uses backend/config.yaml (or $PPE_CONFIG)
    python run.py --config other.yaml
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from app.api import create_app
from app.config import default_config_path, load_config


DEFAULT_CONFIG = Path(__file__).resolve().parent / "config.default.yaml"


def seed_config(cfg_path: Path) -> None:
    """First run: config.yaml is not shipped (it holds the plant's cameras), so start it from the defaults.
    An empty file counts as missing. The Docker image does the same in its start command."""
    if cfg_path.is_file() and cfg_path.read_text(encoding="utf-8").strip():
        return
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(DEFAULT_CONFIG, cfg_path)
    logging.getLogger("run").warning("no settings in %s: created it from %s", cfg_path, DEFAULT_CONFIG.name)


def add_file_logging() -> None:
    """Keep the logs on disk (PPE_LOG_DIR, a mounted volume in Docker) so they survive container recreation.
    Rotates at 10 MB, 10 files. Includes the one-time "SECURITY:" admin password line. Off when PPE_LOG_DIR is empty."""
    log_dir = os.environ.get("PPE_LOG_DIR", "").strip()
    if not log_dir:
        return
    try:
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        h = RotatingFileHandler(Path(log_dir) / "ppe-monitor.log", maxBytes=10_000_000, backupCount=10, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
        logging.getLogger().addHandler(h)
    except OSError as e:  # e.g. folder not writable: keep running with console logs only
        logging.getLogger("run").warning("cannot write logs to %s (%s): console only", log_dir, e)


def main() -> None:
    parser = argparse.ArgumentParser(description="PPE compliance monitor")
    parser.add_argument("--config", default=None, help="path to config.yaml (default: $PPE_CONFIG or backend/config.yaml)")
    parser.add_argument("--log-level", default=os.environ.get("PPE_LOG_LEVEL", "INFO"))
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    add_file_logging()
    cfg_path = Path(args.config).resolve() if args.config else default_config_path()
    seed_config(cfg_path)
    cfg = load_config(cfg_path)
    app = create_app(cfg, config_path=cfg_path)
    # uvicorn handles SIGINT/SIGTERM and runs the lifespan shutdown -> threads are joined cleanly.
    # Behind a TLS reverse proxy the client address comes from X-Forwarded-For, but only from proxies
    # listed here: otherwise sign-in lockouts and the audit trail would see every user as the proxy.
    trusted = os.environ.get("PPE_TRUSTED_PROXIES", "127.0.0.1")
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port, log_level=args.log_level.lower(), access_log=False,
                proxy_headers=True, forwarded_allow_ips=trusted)


if __name__ == "__main__":
    main()
