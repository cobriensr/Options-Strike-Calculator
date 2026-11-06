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
psycopg2._connect (and psycopg 3's connect, Connection.connect and
AsyncConnection.connect, and asyncpg.connect / create_pool, when those are
installed) before any test module is imported. psycopg2.connect,
`from psycopg2 import connect`, psycopg2.pool and SQLAlchemy's psycopg2
dialect all go through it. An attempt is recorded and raises a
BaseException, which the `except Exception` wrappers in utils do not
swallow. A caller that swallows it anyway (`except BaseException`, a bare
`except:`) is caught by the session-end check. Left open: constructing
psycopg2.extensions.connection(...) directly, which bypasses _connect.
The production stores follow the same design: botocore.client.BaseClient.
_make_api_call, where every boto3 call to R2 or S3 ends, is replaced by a stub
with its own message ("tests must not reach a production store"), reads
included, when botocore imports. DuckDB httpfs and s3fs reach R2 on credentials
alone, so those are closed at the source: utils.load_env is wrapped to drop the
store credentials it reads from the repo-root .env FILE.
ml/tests/test_no_database_guard.py proves each block.

Twin of scripts/conftest.py (the root scripts/test_*.py suite). The guard
section, from the "No-database guard" rule line to the "End" one, must stay
identical in the two files; scripts/test_guard_twins.py fails if it drifts.
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
_DATABASE_ENV_NAMES = (
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_PRISMA_URL",
    "NEON_DATABASE_URL",
)
_STORE_ENV_NAMES = (
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
BLOCKED_ENV_NAMES = _DATABASE_ENV_NAMES + _STORE_ENV_NAMES

_BLOCK_MESSAGE = "tests must not connect to a database"
_STORE_BLOCK_MESSAGE = "tests must not reach a production store"

# Every attempt the stubs saw, in order. Module state is fine here: the list
# lives for one test process and never grows past the attempts of one run.
_attempts: list[str] = []


class DatabaseAccessBlocked(BaseException):
    """A test reached for a real database or a production store.

    A BaseException on purpose: the code under test wraps its connects in
    `except Exception`, which a plain Exception subclass would let swallow
    the block and report a green run.
    """


def _blocked(kind: str, message: str = _BLOCK_MESSAGE):
    def stub(*args, **kwargs):
        # The DSN is not recorded or echoed: it may be a real secret.
        _attempts.append(kind)
        raise DatabaseAccessBlocked(f"{kind}: {message}")

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

# The production stores, blocked where a call leaves the process. R2 and
# S3 are reached through boto3, whose every operation (reads included, a
# read reaches production as surely as a write) ends in
# BaseClient._make_api_call. Presigning signs locally and is untouched.
_STORE_POINTS = (
    ("botocore.client", "BaseClient._make_api_call", "botocore.make_api_call"),
)

_STORE_KINDS = frozenset(kind for _, _, kind in _STORE_POINTS)


def _install_db_block() -> None:
    """Replace each driver's connect call, and each store's call, with a stub.

    A driver that is not installed has nothing to block.
    """
    for points, message in (
        (_CONNECT_POINTS, _BLOCK_MESSAGE),
        (_STORE_POINTS, _STORE_BLOCK_MESSAGE),
    ):
        for module_name, path, kind in points:
            try:
                owner = importlib.import_module(module_name)
            except ImportError:
                continue
            *parents, attribute = path.split(".")
            for parent in parents:
                owner = getattr(owner, parent)
            setattr(owner, attribute, _blocked(kind, message))


_install_db_block()

# Env-file loaders. utils.load_env merges the repo-root .env FILE over
# os.environ, so the fixture below, which clears os.environ only, does not
# keep the store credentials in that file out of a test. DuckDB's httpfs and
# pandas via s3fs reach R2 without botocore and need only credentials to do
# it, so those credentials are closed at the source: the loader drops the
# store names. The database names stay in what it returns. The connect call is
# their block, and a loader that returned no URL would end get_connection in
# sys.exit before the attempt is recorded. A suite whose tree has no such
# module has nothing to wrap.
_ENV_FILE_LOADERS = (("utils", "load_env"),)


def _without_store_names(loader):
    def load_without_store_names(*args, **kwargs):
        env = loader(*args, **kwargs)
        return {k: v for k, v in env.items() if k not in _STORE_ENV_NAMES}

    load_without_store_names._without_store_names = True
    return load_without_store_names


def _install_env_file_strip() -> None:
    """Wrap each env-file loader to drop the store names. Idempotent."""
    for module_name, function in _ENV_FILE_LOADERS:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        loader = getattr(module, function, None)
        if loader is not None and not hasattr(loader, "_without_store_names"):
            setattr(module, function, _without_store_names(loader))


_install_env_file_strip()


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
    """Fail the session if any test attempted a database or store call.

    The stub raises in the test that tried, but a caller may swallow that;
    the log still has it. The block itself is installed once, at import
    (above); the self-tests prove it is in place.
    """
    yield
    if _attempts:
        listed = "\n".join(f"  {kind}" for kind in _attempts)
        rules = "; ".join(
            dict.fromkeys(
                _STORE_BLOCK_MESSAGE if kind in _STORE_KINDS else _BLOCK_MESSAGE
                for kind in _attempts
            )
        )
        pytest.fail(
            f"{rules}; this run tried {len(_attempts)} time(s):\n"
            f"{listed}\n"
            "Mock the connection at the module boundary (patch psycopg2.connect, "
            "the boto3 client, or the loader that calls them). A self-test that "
            "provokes an attempt on purpose calls db_block_attempts.discard() "
            "itself.",
            pytrace=False,
        )


# ── End no-database guard ────────────────────────────────────────────────────


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
