"""pytest setup.

Lives at the project root (not inside tests/) so it runs before any
test module — including before pytest collection imports `src.config`,
which would otherwise fail on missing required env vars.

It also keeps every test off a real database and the network (owner rule,
2026-11-04; spec: docs/superpowers/specs/tests-no-db-2026-11-04.md):

- DATABASE_URL, KV_REST_API_URL and KV_REST_API_TOKEN are forced to fakes
  (config validates them at import), and the other database and
  writable-store env names are removed, before collection and before every
  test.
- asyncpg's connect and create_pool are replaced for the whole session with
  stubs that record the attempt and raise a BaseException, which an
  `except Exception` in the code under test does not swallow. The only
  connection in uw-stream is `asyncpg.create_pool` in src/db.py. Tests that
  need a pool patch it themselves (`patch("db.asyncpg.create_pool", ...)`),
  which replaces the stub for that test.
- A connect to a non-loopback address is recorded and raises too, in the
  manner of nightly/conftest.py, so a path that bypasses those two names
  (asyncpg's connect_utils, a websocket, aiohttp) fails as well.
- A session-end fixture fails the run if any attempt was recorded, which
  catches a caller that swallowed the raise (`except BaseException`, a bare
  `except:`).

Twin of the guard in sidecar/conftest.py, ml/conftest.py and
scripts/conftest.py. tests/test_no_database_guard.py proves each block.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
from pathlib import Path

import asyncpg
import asyncpg.connection
import asyncpg.pool
import pytest

# Make `src/` importable as top-level packages so production imports
# (`from config import settings`, `from handlers.flow_alerts import …`)
# work in tests without a wrapper. Mirrors the pyproject.toml
# `pythonpath = ["src"]` setting; we duplicate it here so editor
# configurations and pytest CLI calls without our pyproject also work.
_REPO_ROOT = Path(__file__).resolve().parent
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

# ---------------------------------------------------------------------------
# No-database guard
# ---------------------------------------------------------------------------

# Throwaway test fixtures, never credentials.
FAKE_ENV = {
    "DATABASE_URL": "postgresql://test:" + "fakefixture" + "@localhost/test",
    # WS_LEASE_ENABLED defaults True and then requires both KV vars (see
    # config.Settings._validate_ws_lease), so the module-level
    # `settings = Settings()` singleton would fail collection without these.
    "KV_REST_API_URL": "https://test.upstash.io",
    "KV_REST_API_TOKEN": "test-token",
}

# Every other name a database client or a writable remote store reads. Tests
# that need a value set their own fake with monkeypatch.setenv.
BLOCKED_ENV_NAMES = (
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_PRISMA_URL",
    "NEON_DATABASE_URL",
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
_NETWORK_MESSAGE = "tests must not open a network connection"

# Forced, not setdefault: a real exported credential must never reach a test.
os.environ.update(FAKE_ENV)
for _name in BLOCKED_ENV_NAMES:
    os.environ.pop(_name, None)

# Env defaults used by every test that imports `config`. Overriding via
# `os.environ.setdefault` means real env wins (developer can point
# tests at a local .env if they want), but missing vars don't blow up
# collection. None of these names reaches a database or a writable store.
os.environ.setdefault("UW_API_KEY", "test-key")
os.environ.setdefault("LOG_LEVEL", "WARNING")

# Every attempt the stubs saw, in order. Module state is fine here: the list
# lives for one test process and never grows past the attempts of one run.
_attempts: list[str] = []


class DatabaseAccessBlocked(BaseException):
    """A test reached for a real database or a non-loopback address.

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
    (asyncpg, "connect", "asyncpg.connect"),
    (asyncpg, "create_pool", "asyncpg.create_pool"),
    (asyncpg.connection, "connect", "asyncpg.connection.connect"),
    (asyncpg.pool, "create_pool", "asyncpg.pool.create_pool"),
)


def _install_db_block() -> None:
    """Replace each asyncpg connect call with the blocking stub.

    Safe to call again: it only reassigns.
    """
    for module, attribute, kind in _CONNECT_POINTS:
        setattr(module, attribute, _blocked(kind))


_install_db_block()


def _is_loopback(address: object) -> bool:
    if not isinstance(address, tuple) or not address:
        return True  # AF_UNIX paths and the like
    host = address[0]
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def _tests_have_no_database_env_or_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every test with the fake env, no writable-store token and a
    socket layer that refuses non-loopback connects."""
    for name, value in FAKE_ENV.items():
        monkeypatch.setenv(name, value)
    for name in BLOCKED_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)

    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def _guard(real):
        def wrapper(self, address):
            if not _is_loopback(address):
                _attempts.append(f"socket.connect {address[0]}")
                raise DatabaseAccessBlocked(f"socket.connect {address[0]}: {_NETWORK_MESSAGE}")
            return real(self, address)

        return wrapper

    monkeypatch.setattr(socket.socket, "connect", _guard(real_connect))
    monkeypatch.setattr(socket.socket, "connect_ex", _guard(real_connect_ex))


@pytest.fixture
def db_block_attempts() -> list[str]:
    """The guard's attempt log. A self-test that provokes one clears it."""
    return _attempts


@pytest.fixture(scope="session", autouse=True)
def _tests_never_reach_a_database():
    """Fail the session if any test attempted a database or network connect.

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
            "Mock the connection at the module boundary (patch "
            "db.asyncpg.create_pool, or the handler that calls it). A "
            "self-test that provokes an attempt on purpose clears the "
            "db_block_attempts log itself.",
            pytrace=False,
        )
