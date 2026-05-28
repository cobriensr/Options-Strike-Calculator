"""pytest setup.

Lives at the project root (not inside tests/) so it runs before any
test module — sys.path adjustments must happen before collection
imports any classifier module.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


# Make both `src/` and `_vendored_ml/` importable as top-level packages.
# Mirrors the pyproject.toml `pythonpath = ["src", "_vendored_ml"]`
# setting; duplicated here so editor configurations and pytest CLI
# invocations without our pyproject also work.
_REPO_ROOT = Path(__file__).resolve().parent
for _candidate in ("src", "_vendored_ml"):
    _path = _REPO_ROOT / _candidate
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))


# Env defaults for tests. Empty SENTRY_DSN = Sentry init is a no-op,
# which is what we want for unit tests. `os.environ.setdefault` means
# real env wins (developer can point tests at a real DSN if needed).
os.environ.setdefault("SENTRY_DSN", "")
os.environ.setdefault("LOG_LEVEL", "WARNING")
