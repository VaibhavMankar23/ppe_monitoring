import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import security  # noqa: E402

security.BCRYPT_ROUNDS = 4  # fast hashes in tests (production uses 12)
