import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import security  # noqa: E402

security.BCRYPT_ROUNDS = 4  # fast hashes in tests (production uses 12)

# tests sign in with the known legacy seed password; production gets a random one-time password
import os  # noqa: E402

os.environ.setdefault("PPE_INITIAL_ADMIN_PASSWORD", security.SEED_PASSWORD)
