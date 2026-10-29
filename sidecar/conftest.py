"""Configure pytest to find source modules in sidecar/src/.

Also installs minimal session-wide mocks for two external packages,
psycopg2 and sentry_sdk, whenever they aren't already in sys.modules.
Both are in requirements.txt, so the mocks don't exist for a missing
install: they keep tests from ever needing a live database driver,
database or Sentry client. Every other mock (db, logger_setup,
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
# Installed or not, each is mocked whenever it isn't already in
# sys.modules. Nothing imports either before this conftest loads, so in
# practice the tests always get the mock and never the real package.
#
# Packages like `db`, `logger_setup`, `config`, and `sentry_setup` are
# all sidecar source modules that exist on disk and can be imported
# directly from sidecar/src/. Test files that want to mock those should
# install their own mocks per-file.

# psycopg2 — used by sidecar/src/db.py.
if "psycopg2" not in sys.modules:
    mock_psycopg2 = MagicMock()
    mock_psycopg2_pool = MagicMock()
    # Provide a real exception class for `except psycopg2.pool.PoolError`
    mock_psycopg2_pool.PoolError = type("PoolError", (Exception,), {})
    # Rule: any stub attribute a test monkeypatches must be a real object,
    # not an auto-created MagicMock child. pytest 9.2's monkeypatch reads the
    # old value from the target's __dict__, where a MagicMock child never
    # lives, so its undo deleted ThreadedConnectionPool and the next test's
    # getattr raised AttributeError.
    mock_psycopg2_pool.ThreadedConnectionPool = type("ThreadedConnectionPool", (), {})
    mock_psycopg2.pool = mock_psycopg2_pool
    sys.modules["psycopg2"] = mock_psycopg2
    sys.modules["psycopg2.pool"] = mock_psycopg2_pool

# sentry_sdk — optional, used by sidecar/src/sentry_setup.py lazy path.
if "sentry_sdk" not in sys.modules:
    sys.modules["sentry_sdk"] = MagicMock()
