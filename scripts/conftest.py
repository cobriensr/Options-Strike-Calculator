"""Keep the root scripts/test_*.py suite off every real database.

No test may connect to or write to a real database (owner rule, 2026-11-04;
spec: docs/superpowers/specs/tests-no-db-2026-11-04.md). The scripts these
tests import carry hand-rolled .env.local loaders and real psycopg2.connect
calls, so unsetting env vars alone cannot keep a run off a database. The
block is the connect call itself: this file replaces psycopg2._connect (and
psycopg 3's connect, Connection.connect and AsyncConnection.connect, and
asyncpg.connect / create_pool, when those are installed) before any test
module is imported. psycopg2.connect, `from psycopg2 import connect`,
psycopg2.pool and SQLAlchemy's psycopg2 dialect all go through it. An
attempt is recorded and raises a BaseException, which an `except Exception`
does not swallow. A caller that swallows it anyway (`except BaseException`,
a bare `except:`) is caught by the session-end check. Left open:
constructing psycopg2.extensions.connection(...) directly, which bypasses
_connect.

Run the suite the way the test docstrings say, from the repo root:

    ml/.venv/Scripts/pytest scripts/test_pipeline_retry.py -q

scripts/test_no_database_guard.py proves each block.

Twin of ml/conftest.py (the ml suite). The guard section, from the
"No-database guard" rule line to the "End" one, must stay identical in the two
files; scripts/test_guard_twins.py fails if it drifts. They are not shared
through an import because the two suites run from different roots and ml/ must
work without scripts/.
"""

import importlib

import pytest

# ── No-database guard ────────────────────────────────────────────────────────

# Every name a database client or a writable remote store reads. Tests that
# need a value set their own fake after the fixture below has run.
BLOCKED_ENV_NAMES = (
    "DATABASE_URL",
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


# (module, attribute path inside it, label in the attempt log). psycopg 3 is
# what SQLAlchemy 2.1 picks for a bare postgresql:// URL; it is not a
# dependency, so its entries only apply where it is importable.
_CONNECT_POINTS = (
    ("psycopg2", "_connect", "psycopg2.connect"),
    ("psycopg", "connect", "psycopg.connect"),
    ("psycopg", "Connection.connect", "psycopg.Connection.connect"),
    ("psycopg", "AsyncConnection.connect", "psycopg.AsyncConnection.connect"),
    ("asyncpg", "connect", "asyncpg.connect"),
    ("asyncpg", "create_pool", "asyncpg.create_pool"),
)


def _install_db_block() -> None:
    """Replace each driver's connect call with the blocking stub.

    Safe to call again: it only reassigns. A driver that is not installed
    has nothing to block.
    """
    for module_name, path, kind in _CONNECT_POINTS:
        try:
            owner = importlib.import_module(module_name)
        except ImportError:
            continue
        *parents, attribute = path.split(".")
        for parent in parents:
            owner = getattr(owner, parent)
        setattr(owner, attribute, _blocked(kind))


_install_db_block()


@pytest.fixture(autouse=True)
def _tests_have_no_database_env(monkeypatch):
    """Start every test without a database URL or a writable-store token."""
    for name in BLOCKED_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


class _AttemptsSinceTestStart:
    """The attempts one test made, for a self-test that provokes them.

    Entries logged before the test started belong to some other test that
    swallowed the block. They stay in the log, so the session-end check still
    names that offender; wiping the whole log would hide it.
    """

    def __init__(self) -> None:
        self._start = len(_attempts)

    @property
    def new(self) -> list[str]:
        return _attempts[self._start :]

    def discard(self) -> None:
        """Drop the entries this test added, and nothing earlier."""
        del _attempts[self._start :]


@pytest.fixture
def db_block_attempts() -> _AttemptsSinceTestStart:
    """The attempts this test makes. A self-test that provokes one discards it."""
    return _AttemptsSinceTestStart()


@pytest.fixture(scope="session", autouse=True)
def _tests_never_reach_a_database():
    """Fail the session if any test attempted a database connection.

    The stub raises in the test that tried, but a caller may swallow that;
    the log still has it. Re-installs the block at session start in case
    something replaced it between import and the first test.
    """
    _install_db_block()
    yield
    if _attempts:
        listed = "\n".join(f"  {kind}" for kind in _attempts)
        pytest.fail(
            f"{_BLOCK_MESSAGE}; this run tried {len(_attempts)} time(s):\n"
            f"{listed}\n"
            "Mock the connection at the module boundary (patch psycopg2.connect, "
            "or the loader that calls it). A self-test that provokes an attempt "
            "on purpose calls db_block_attempts.discard() itself.",
            pytrace=False,
        )


# ── End no-database guard ────────────────────────────────────────────────────
