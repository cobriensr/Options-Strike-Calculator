"""Configure pytest to find source modules in ml/src/ and cross-test
helpers in ml/tests/, to keep a test run from rewriting tracked files, and
to keep it off every real database.

The takeit suite (test_takeit_export.py) reuses the synthetic-frame
builder from test_takeit_train.py to avoid duplicating the ~30-line
fixture, so the tests dir needs to be importable as well.

The src modules write to ml/findings.json and ml/plots/ by default, so a
test that forgets to redirect those paths to tmp_path dirties the checkout
without failing. The session guard below catches that.

No test may connect to or write to a real database (owner rule, 2026-11-04;
spec: docs/superpowers/specs/tests-no-db-2026-11-04.md). The src modules
read DATABASE_URL from os.environ, from the repo-root .env FILE
(utils.load_env, which overrides os.environ) and from .env.local
(calibration), so unsetting env vars alone cannot keep a run off a database.
The block is therefore the connect call itself: this file replaces
psycopg2._connect (and asyncpg.connect / create_pool when asyncpg is
installed) before any test module is imported. psycopg2.connect,
`from psycopg2 import connect`, psycopg2.pool and SQLAlchemy's psycopg2
dialect all go through it. An attempt is recorded and raises a
BaseException, which the `except Exception` wrappers in utils do not
swallow. A caller that swallows it anyway (`except BaseException`, a bare
`except:`) is caught by the session-end check. Left open: constructing
psycopg2.extensions.connection(...) directly, which bypasses _connect.
ml/tests/test_no_database_guard.py proves each block.

Twin of scripts/conftest.py (the root scripts/test_*.py suite). Keep the
guard sections of the two files the same.
"""

import hashlib
import importlib
import subprocess
import sys
import warnings
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / "src"))
sys.path.insert(0, str(_HERE / "tests"))

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


# (module, attribute, label in the attempt log)
_CONNECT_POINTS = (
    ("psycopg2", "_connect", "psycopg2.connect"),
    ("asyncpg", "connect", "asyncpg.connect"),
    ("asyncpg", "create_pool", "asyncpg.create_pool"),
)


def _install_db_block() -> None:
    """Replace each driver's connect call with the blocking stub.

    Safe to call again: it only reassigns. A driver that is not installed
    has nothing to block.
    """
    for module_name, attribute, kind in _CONNECT_POINTS:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        setattr(module, attribute, _blocked(kind))


_install_db_block()


@pytest.fixture(autouse=True)
def _tests_have_no_database_env(monkeypatch):
    """Start every test without a database URL or a writable-store token."""
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
            "on purpose clears the db_block_attempts log itself.",
            pytrace=False,
        )


def _tracked_files() -> list[str] | None:
    """List the files git tracks under ml/, or None when git cannot.

    None covers git not installed, not a checkout, or an unsafe-directory
    refusal, so the guard skips instead of breaking the run.
    """
    try:
        listing = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=_HERE,
            capture_output=True,
            check=True,
            timeout=60,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return [name for name in listing.decode().split("\0") if name]


def _digest(path: Path) -> str | None:
    """Hash a file's bytes, so rewriting identical content is no change."""
    try:
        return hashlib.sha1(path.read_bytes(), usedforsecurity=False).hexdigest()
    except OSError:
        return None


@pytest.fixture(scope="session", autouse=True)
def _tests_leave_tracked_files_alone():
    """Fail the session if the run changed or deleted a tracked ml/ file.

    It compares each file before and after the run, so edits made before
    the run never trip it. Untracked and gitignored files are not checked.
    """
    tracked = _tracked_files()
    if tracked is None:
        warnings.warn(
            "tracked-file guard skipped: git could not list the ml/ files",
            stacklevel=1,
        )
        yield
        return
    before = {name: _digest(_HERE / name) for name in tracked}
    yield
    changed = [
        name for name, digest in before.items() if _digest(_HERE / name) != digest
    ]
    if changed:
        listed = "\n".join(f"  ml/{name}" for name in changed)
        pytest.fail(
            f"This test run changed tracked files:\n{listed}\n"
            "Point the path the code under test writes to (ML_ROOT, "
            "REPO_ROOT, PLOT_DIR, ...) at tmp_path with monkeypatch. If you "
            "edited these files during the run, rerun.",
            pytrace=False,
        )
