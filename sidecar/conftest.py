"""Configure pytest to find source modules in sidecar/src/ and to keep every
test off a real database.

No test may connect to or write to a real database (owner rule, 2026-11-04;
spec: docs/superpowers/specs/tests-no-db-2026-11-04.md). This file installs
session-wide mocks for two external packages, psycopg2 and sentry_sdk. Both
are in requirements.txt, so the mocks don't exist for a missing install:
they keep tests from ever needing a live database driver, database or Sentry
client. Every other mock (db, logger_setup, config, sentry_setup) is managed
per-test-file so each file's assertions match its own fixture setup.

The psycopg2 mock is installed unconditionally, replacing a real psycopg2
that a plugin or an earlier conftest may have imported. Its connect() and
ThreadedConnectionPool(...) do not return a MagicMock that a test could mistake
for a connection: each records the attempt and raises a BaseException, which
an `except Exception` in the code under test does not swallow. A caller that
swallows it anyway (`except BaseException`, a bare `except:`) is caught by
the session-end check. Tests that exercise db.py patch
psycopg2.pool.ThreadedConnectionPool themselves, which replaces the stub.

DATABASE_URL is forced to a fake value here, so config.Settings() (which
validates at import) never sees a real one, and the other database and
writable-store env names are removed before every test.

Twin of the guard in uw-stream/conftest.py, ml/conftest.py and
scripts/conftest.py. sidecar/tests/test_no_database_guard.py proves each
block.
"""

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add sidecar/src/ to Python path so test imports resolve correctly
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

# ---------------------------------------------------------------------------
# No-database guard
# ---------------------------------------------------------------------------

# A throwaway test fixture, never a credential.
FAKE_DATABASE_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"

# Every name a database client or a writable remote store reads, other than
# DATABASE_URL (forced to the fake above). Tests that need a value set their
# own fake with monkeypatch.setenv.
BLOCKED_ENV_NAMES = (
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_PRISMA_URL",
    "NEON_DATABASE_URL",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "BLOB_READ_WRITE_TOKEN",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
)

_BLOCK_MESSAGE = "tests must not connect to a database"

# Forced, not setdefault: a real exported URL must never reach a test.
os.environ["DATABASE_URL"] = FAKE_DATABASE_URL
for _name in BLOCKED_ENV_NAMES:
    os.environ.pop(_name, None)

# Every attempt the stubs saw, in order. Module state is fine here: the list
# lives for one test process and never grows past the attempts of one run.
_attempts: list[str] = []


class DatabaseAccessBlocked(BaseException):
    """A test reached for a real database.

    A BaseException on purpose: the code under test wraps its connects in
    `except Exception`, which a plain Exception subclass would let swallow
    the block and report a green run.
    """


def _blocked(kind: str):
    def stub(*args, **kwargs):
        # The DSN is not recorded or echoed: it may be a real secret.
        _attempts.append(kind)
        raise DatabaseAccessBlocked(f"{kind}: {_BLOCK_MESSAGE}")

    return stub


@pytest.fixture(autouse=True)
def _tests_have_no_database_env(monkeypatch):
    """Start every test with the fake URL and no writable-store token."""
    monkeypatch.setenv("DATABASE_URL", FAKE_DATABASE_URL)
    for name in BLOCKED_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def db_block_attempts() -> list[str]:
    """The guard's attempt log. A self-test that provokes one clears it."""
    return _attempts


@pytest.fixture(scope="session", autouse=True)
def _tests_never_reach_a_database():
    """Fail the session if any test attempted a database connection.

    The stub raises in the test that tried, but a caller may swallow that;
    the log still has it.
    """
    yield
    if _attempts:
        listed = "\n".join(f"  {kind}" for kind in _attempts)
        pytest.fail(
            f"{_BLOCK_MESSAGE}; this run tried {len(_attempts)} time(s):\n"
            f"{listed}\n"
            "Mock the connection at the module boundary (patch "
            "psycopg2.pool.ThreadedConnectionPool, or the loader that calls "
            "it). A self-test that provokes an attempt on purpose clears the "
            "db_block_attempts log itself.",
            pytrace=False,
        )


# ---------------------------------------------------------------------------
# Minimal external-package mocks
# ---------------------------------------------------------------------------
#
# Installed or not, each is mocked unconditionally, replacing whatever a
# plugin or an earlier import put in sys.modules. Nothing in the sidecar
# imports either before this conftest loads, so the tests always get the
# mock and never the real package.
#
# Packages like `db`, `logger_setup`, `config`, and `sentry_setup` are
# all sidecar source modules that exist on disk and can be imported
# directly from sidecar/src/. Test files that want to mock those should
# install their own mocks per-file.

# psycopg2 — used by sidecar/src/db.py.
mock_psycopg2 = MagicMock()
mock_psycopg2.connect = _blocked("psycopg2.connect")
mock_psycopg2_pool = MagicMock()
# Provide a real exception class for `except psycopg2.pool.PoolError`
mock_psycopg2_pool.PoolError = type("PoolError", (Exception,), {})
# Rule: any stub attribute a test monkeypatches must be a real object,
# not an auto-created MagicMock child. pytest 9.2's monkeypatch reads the
# old value from the target's __dict__, where a MagicMock child never
# lives, so its undo deleted ThreadedConnectionPool and the next test's
# getattr raised AttributeError.
mock_psycopg2_pool.ThreadedConnectionPool = type(
    "ThreadedConnectionPool",
    (),
    {"__init__": _blocked("psycopg2.pool.ThreadedConnectionPool")},
)
mock_psycopg2.pool = mock_psycopg2_pool
sys.modules["psycopg2"] = mock_psycopg2
sys.modules["psycopg2.pool"] = mock_psycopg2_pool

# sentry_sdk — optional, used by sidecar/src/sentry_setup.py lazy path.
if "sentry_sdk" not in sys.modules:
    sys.modules["sentry_sdk"] = MagicMock()
