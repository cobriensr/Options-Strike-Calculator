"""Configure pytest to find source modules in sidecar/src/.

Also installs minimal session-wide mocks for external packages that
may NOT be in the local test venv (psycopg2, sentry_sdk). This lets
source modules import at all. Every other mock (db, logger_setup,
config, sentry_setup) is managed per-test-file so each file's
assertions match its own fixture setup.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

# Add sidecar/src/ to Python path so test imports resolve correctly
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))


# ---------------------------------------------------------------------------
# Minimal external-package mocks
# ---------------------------------------------------------------------------
#
# Only for packages NOT installed in the local venv. These are the
# packages whose absence would cause `import foo` to fail at module
# parse time, which would then make every test file fail to even load.
#
# Packages like `db`, `logger_setup`, `config`, and `sentry_setup` are
# all sidecar source modules that exist on disk and can be imported
# directly from sidecar/src/. Test files that want to mock those should
# install their own mocks per-file.

# psycopg2 — used by sidecar/src/db.py. Not in venv.
if "psycopg2" not in sys.modules:
    mock_psycopg2 = MagicMock()
    mock_psycopg2_pool = MagicMock()
    # Provide a real exception class for `except psycopg2.pool.PoolError`
    mock_psycopg2_pool.PoolError = type("PoolError", (Exception,), {})
    mock_psycopg2.pool = mock_psycopg2_pool
    sys.modules["psycopg2"] = mock_psycopg2
    sys.modules["psycopg2.pool"] = mock_psycopg2_pool

# sentry_sdk — optional, used by sidecar/src/sentry_setup.py lazy path.
if "sentry_sdk" not in sys.modules:
    sys.modules["sentry_sdk"] = MagicMock()
