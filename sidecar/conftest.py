"""Configure pytest to find source modules in sidecar/src/.

Also installs minimal session-wide mocks for external packages that
are NOT in the local test venv (databento, psycopg2). This lets
source modules import at all. Every other mock (db, logger_setup,
config, sentry_setup, symbol_manager) is managed per-test-file so
each file's assertions match its own fixture setup.
"""

import sys
from pathlib import Path
from types import SimpleNamespace
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
# Packages like `db`, `logger_setup`, `config`, `sentry_setup`, and
# `symbol_manager` are all sidecar source modules that exist on disk
# and can be imported directly from sidecar/src/. Test files that
# want to mock those should install their own mocks per-file.

# databento SDK — used by sidecar/src/databento_client.py. Not in venv.
if "databento" not in sys.modules:
    mock_databento = MagicMock()
    mock_databento.ReconnectPolicy = SimpleNamespace(RECONNECT="reconnect")
    mock_databento.Side = SimpleNamespace(ASK="A_sentinel", BID="B_sentinel")
    mock_databento.Live = MagicMock()
    sys.modules["databento"] = mock_databento

# psycopg2 — used by sidecar/src/db.py. Not in venv.
if "psycopg2" not in sys.modules:
    mock_psycopg2 = MagicMock()
    mock_psycopg2_pool = MagicMock()
    mock_psycopg2_extras = MagicMock()
    # Provide a real exception class for `except psycopg2.pool.PoolError`
    mock_psycopg2_pool.PoolError = type("PoolError", (Exception,), {})
    mock_psycopg2.pool = mock_psycopg2_pool
    mock_psycopg2.extras = mock_psycopg2_extras
    sys.modules["psycopg2"] = mock_psycopg2
    sys.modules["psycopg2.pool"] = mock_psycopg2_pool
    sys.modules["psycopg2.extras"] = mock_psycopg2_extras

# sentry_sdk — optional, used by sidecar/src/sentry_setup.py lazy path.
if "sentry_sdk" not in sys.modules:
    sys.modules["sentry_sdk"] = MagicMock()
