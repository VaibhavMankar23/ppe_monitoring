"""Start the PPE monitor API server.

    python run.py                      # uses backend/config.yaml (or $PPE_CONFIG)
    python run.py --config other.yaml
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

import uvicorn

from app.api import create_app
from app.config import default_config_path, load_config


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
    cfg_path = Path(args.config).resolve() if args.config else default_config_path()
    cfg = load_config(cfg_path)
    app = create_app(cfg, config_path=cfg_path)
    # uvicorn handles SIGINT/SIGTERM and runs the lifespan shutdown -> threads are joined cleanly.
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port, log_level=args.log_level.lower(), access_log=False)


if __name__ == "__main__":
    main()
