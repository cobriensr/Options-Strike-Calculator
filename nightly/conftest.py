"""pytest setup.

Lives at the project root (not inside tests/) so it runs before any test
module is collected. Makes `src/` importable as top-level modules, matching
the production `PYTHONPATH=/app/src`, and puts the repo's `scripts/` after it
for the shared modules the image copies in (`_pipeline_retry`, `_tape_reader`).
Gives every required env var a default so `load_settings()` works unless a test
removes one.

No test may connect to a database (owner rule, 2026-11-04; spec:
docs/superpowers/specs/tests-no-db-2026-11-04.md). psycopg2._connect, where
every psycopg2.connect ends, is replaced with a stub that records the attempt and
raises a BaseException, which an `except Exception` does not swallow. A caller that
swallows it anyway is caught by the session-end check. Tests of code that connects
patch the connect call at the module boundary.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent
_SRC = _ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
# After src/ and the installed packages, so a name in scripts/ never shadows either.
_SCRIPTS = _ROOT.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.append(str(_SCRIPTS))

# Forced, not setdefault: a real exported credential must never reach a test.
os.environ["UW_API_KEY"] = "test-key"
os.environ["R2_ACCESS_KEY_ID"] = "test-access-key-id"
os.environ["R2_SECRET_ACCESS_KEY"] = "test-secret-access-key"
os.environ["R2_ENDPOINT_URL"] = "https://example.r2.cloudflarestorage.com"
os.environ["R2_BUCKET_FULLTAPE"] = "test-bucket"
os.environ["DATABASE_URL"] = "postgresql://test:test@localhost/test"

# Every attempt the stub saw. Module state is fine here: it lives for one test process
# and never grows past the attempts of one run.
_attempts: list[str] = []


class DatabaseAccessBlocked(BaseException):
    """A test reached for a real database.

    A BaseException on purpose: the code under test may wrap its connect in
    `except Exception`, which a plain Exception subclass would let swallow the block
    and report a green run.
    """


def _blocked_connect(*args: object, **kwargs: object) -> None:
    # The DSN is not recorded or echoed: it may be a real secret.
    _attempts.append("psycopg2.connect")
    raise DatabaseAccessBlocked("psycopg2.connect: tests must not connect to a database")


try:
    import psycopg2
except ImportError:  # not installed, so there is nothing to block
    pass
else:
    psycopg2._connect = _blocked_connect


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
def _no_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly on any non-loopback connection: tests use respx and moto only."""
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def _guard(real):
        def wrapper(self, address):
            if not _is_loopback(address):
                raise RuntimeError("test attempted a real network connection")
            return real(self, address)

        return wrapper

    monkeypatch.setattr(socket.socket, "connect", _guard(real_connect))
    monkeypatch.setattr(socket.socket, "connect_ex", _guard(real_connect_ex))


@pytest.fixture
def db_block_attempts() -> list[str]:
    """The attempt log. A self-test that provokes a block on purpose deletes its own entries."""
    return _attempts


@pytest.fixture(scope="session", autouse=True)
def _tests_never_reach_a_database():
    """Fail the session if any test attempted a database connect.

    The stub raises in the test that tried, but a caller may swallow that; the log
    still has it.
    """
    yield
    if _attempts:
        pytest.fail(
            f"tests must not connect to a database; this run tried {len(_attempts)} time(s). "
            "Patch the connect call at the module boundary.",
            pytrace=False,
        )
