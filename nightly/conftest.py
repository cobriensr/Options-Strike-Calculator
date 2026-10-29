"""pytest setup.

Lives at the project root (not inside tests/) so it runs before any test
module is collected. Makes `src/` importable as top-level modules, matching
the production `PYTHONPATH=/app/src`, and gives every required env var a
default so `load_settings()` works unless a test removes one.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

# setdefault: a real environment wins, but a missing var never blows up collection.
os.environ.setdefault("UW_API_KEY", "test-key")
os.environ.setdefault("R2_ACCESS_KEY_ID", "test-access-key-id")
os.environ.setdefault("R2_SECRET_ACCESS_KEY", "test-secret-access-key")
os.environ.setdefault("R2_ENDPOINT_URL", "https://example.r2.cloudflarestorage.com")
os.environ.setdefault("R2_BUCKET_FULLTAPE", "test-bucket")
