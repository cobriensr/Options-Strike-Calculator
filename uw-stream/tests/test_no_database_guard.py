"""Self-tests for the no-database guard in uw-stream/conftest.py.

The conftest replaces asyncpg's connect and create_pool with stubs that
record the attempt and raise a BaseException, refuses non-loopback socket
connects the same way, forces DATABASE_URL and the two KV vars to fakes, and
removes the other database and writable-store env names. Each block is proven
here: the in-process tests provoke an attempt directly, and the subprocess
tests run a probe suite under a copy of the real conftest, because the forced
env and the session-end check cannot be observed from inside the session they
guard.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import textwrap
from pathlib import Path
from unittest.mock import AsyncMock

import asyncpg
import asyncpg.connection
import asyncpg.pool
import pytest

import db
from conftest import BLOCKED_ENV_NAMES, FAKE_ENV, DatabaseAccessBlocked

DSN = "postgresql://user:hunter2@invalid.invalid/db"
MESSAGE = "tests must not connect to a database"


@pytest.fixture(autouse=True)
def _reset_pool_singleton():
    saved = db._pool
    db._pool = None
    yield
    db._pool = saved


@pytest.mark.parametrize(
    ("target", "kind"),
    [
        (asyncpg.create_pool, "asyncpg.create_pool"),
        (asyncpg.connect, "asyncpg.connect"),
        (asyncpg.pool.create_pool, "asyncpg.pool.create_pool"),
        (asyncpg.connection.connect, "asyncpg.connection.connect"),
    ],
)
def test_asyncpg_entry_points_are_blocked_and_recorded(target, kind, db_block_attempts):
    # The call itself raises, before anything is awaited.
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        target(DSN)
    assert db_block_attempts == [kind]
    db_block_attempts.clear()


async def test_init_pool_cannot_reach_a_database(db_block_attempts):
    # The production path: src/db.py's init_pool with the fake settings.
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        await db.init_pool()
    assert db_block_attempts == ["asyncpg.create_pool"]
    assert db._pool is None
    db_block_attempts.clear()


async def test_a_test_that_patches_create_pool_replaces_the_stub(monkeypatch):
    # tests/test_db.py patches create_pool this way.
    fake_pool = object()
    monkeypatch.setattr(asyncpg, "create_pool", AsyncMock(return_value=fake_pool))
    assert await db.init_pool() is fake_pool


def test_blocked_error_is_not_an_exception():
    # Library code wraps connects in `except Exception`; a plain Exception
    # subclass would be swallowed and the suite would go green.
    assert not issubclass(DatabaseAccessBlocked, Exception)


def test_message_does_not_echo_the_dsn(db_block_attempts):
    with pytest.raises(DatabaseAccessBlocked) as caught:
        asyncpg.create_pool(DSN)
    db_block_attempts.clear()
    assert "hunter2" not in str(caught.value)


# ── Socket guard ─────────────────────────────────────────────────────────────


def test_a_non_loopback_connect_is_blocked_and_recorded(db_block_attempts):
    # 192.0.2.1 is TEST-NET-1: the guard raises before any packet is sent.
    sock = socket.socket()
    try:
        with pytest.raises(DatabaseAccessBlocked, match="network connection"):
            sock.connect(("192.0.2.1", 5432))
        with pytest.raises(DatabaseAccessBlocked, match="network connection"):
            sock.connect_ex(("192.0.2.1", 5432))
    finally:
        sock.close()
    assert db_block_attempts == [
        "socket.connect 192.0.2.1",
        "socket.connect 192.0.2.1",
    ]
    db_block_attempts.clear()


def test_a_loopback_connect_still_works(db_block_attempts):
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    client = socket.socket()
    try:
        client.connect(server.getsockname())
    finally:
        client.close()
        server.close()
    assert db_block_attempts == []


# ── Forced env ───────────────────────────────────────────────────────────────


def test_the_fake_env_is_in_place():
    for name, value in FAKE_ENV.items():
        assert os.environ[name] == value
    for name in BLOCKED_ENV_NAMES:
        assert name not in os.environ


# ── Subprocess probes ────────────────────────────────────────────────────────


def _run_probe(tmp_path: Path, probe_source: str):
    """Run a probe suite under a copy of the real conftest in an empty dir."""
    shutil.copy(Path(__file__).resolve().parent.parent / "conftest.py", tmp_path)
    (tmp_path / "test_probe.py").write_text(textwrap.dedent(probe_source))
    env = dict(os.environ)
    env.update(dict.fromkeys(BLOCKED_ENV_NAMES, "set-by-the-parent-run"))
    env.update(
        {
            "DATABASE_URL": "postgresql://real:secret@invalid.invalid/prod",
            "KV_REST_API_URL": "https://real.upstash.io",
            "KV_REST_API_TOKEN": "real-token",
        }
    )
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            "--rootdir",
            str(tmp_path),
            str(tmp_path),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_env_is_forced_to_the_fakes_and_scrubbed(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import os
        from conftest import BLOCKED_ENV_NAMES, FAKE_ENV

        # What a source module read at import (collection) time would see,
        # before any fixture has run: config.Settings() validates then.
        AT_IMPORT = {n: os.environ.get(n) for n in FAKE_ENV}
        LEAKED_AT_IMPORT = [n for n in BLOCKED_ENV_NAMES if n in os.environ]

        def test_import_time_sees_only_the_fakes():
            assert AT_IMPORT == FAKE_ENV
            assert LEAKED_AT_IMPORT == []

        def test_a_sets_values_and_never_cleans_up():
            os.environ["DATABASE_URL"] = "postgresql://real:secret@invalid.invalid/p"
            os.environ["BLOB_READ_WRITE_TOKEN"] = "leaked"

        def test_b_does_not_see_what_test_a_left():
            assert os.environ["DATABASE_URL"] == FAKE_ENV["DATABASE_URL"]
            assert "BLOB_READ_WRITE_TOKEN" not in os.environ
        """,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_swallowed_attempt_fails_the_session(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import asyncpg

        def test_swallows_the_block():
            try:
                asyncpg.create_pool("postgresql://x@invalid.invalid/db")
            except BaseException:
                pass
        """,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert "asyncpg.create_pool" in output
    assert MESSAGE in output


def test_swallowed_socket_attempt_fails_the_session(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import socket

        def test_swallows_the_block():
            sock = socket.socket()
            try:
                sock.connect(("192.0.2.1", 5432))
            except BaseException:
                pass
            finally:
                sock.close()
        """,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert "socket.connect 192.0.2.1" in output
