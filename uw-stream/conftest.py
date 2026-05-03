"""pytest setup.

Lives at the project root (not inside tests/) so it runs before any
test module — including before pytest collection imports `src.config`,
which would otherwise fail on missing required env vars.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


# Make `src/` importable as top-level packages so production imports
# (`from config import settings`, `from handlers.flow_alerts import …`)
# work in tests without a wrapper. Mirrors the pyproject.toml
# `pythonpath = ["src"]` setting; we duplicate it here so editor
# configurations and pytest CLI calls without our pyproject also work.
_REPO_ROOT = Path(__file__).resolve().parent
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


# Env defaults used by every test that imports `config`. Overriding via
# `os.environ.setdefault` means real env wins (developer can point
# tests at a local .env if they want), but missing vars don't blow up
# collection.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("UW_API_KEY", "test-key")
os.environ.setdefault("LOG_LEVEL", "WARNING")
