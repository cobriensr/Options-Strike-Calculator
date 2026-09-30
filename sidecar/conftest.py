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
    mock_sentry_sdk = MagicMock()

    # `@sentry_sdk.monitor(monitor_slug=...)` is a no-op decorator when no
    # DSN is configured (the real SDK behavior). Model it as an identity
    # decorator so functions it wraps (e.g. theta_fetcher.run_nightly) stay
    # callable and coverable instead of being swallowed by a MagicMock.
    def _identity_decorator(*_args, **_kwargs):
        def _wrap(func):
            return func

        return _wrap

    mock_sentry_sdk.monitor = _identity_decorator
    sys.modules["sentry_sdk"] = mock_sentry_sdk
