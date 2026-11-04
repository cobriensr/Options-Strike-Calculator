"""Self-tests for the no-database guard in sidecar/conftest.py.

The conftest installs a psycopg2 mock whose connect() and
ThreadedConnectionPool(...) record the attempt and raise a BaseException,
forces DATABASE_URL to a fake, and removes the other database and
writable-store env names. Each block is proven here: the in-process tests
provoke an attempt directly, and the subprocess tests run a probe suite under
a copy of the real conftest, because the forced env, the unconditional mock
and the session-end check cannot be observed from inside the session they
guard.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from unittest.mock import MagicMock

import psycopg2
import psycopg2.pool
import pytest

from conftest import BLOCKED_ENV_NAMES, FAKE_DATABASE_URL, DatabaseAccessBlocked

DSN = "postgresql://user:hunter2@invalid.invalid/db"
MESSAGE = "tests must not connect to a database"


def test_psycopg2_is_the_mock_not_the_driver():
    assert isinstance(psycopg2, MagicMock)
    assert isinstance(psycopg2.pool, MagicMock)


def test_connect_is_blocked_and_recorded(db_block_attempts):
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        psycopg2.connect(DSN)
    assert db_block_attempts == ["psycopg2.connect"]
    db_block_attempts.clear()


def test_pool_construction_is_blocked_and_recorded(db_block_attempts):
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        psycopg2.pool.ThreadedConnectionPool(1, 2, DSN)
    assert db_block_attempts == ["psycopg2.pool.ThreadedConnectionPool"]
    db_block_attempts.clear()


def test_a_test_that_patches_the_pool_replaces_the_stub(monkeypatch):
    # tests/test_db.py patches ThreadedConnectionPool this way.
    factory = MagicMock()
    monkeypatch.setattr(psycopg2.pool, "ThreadedConnectionPool", factory)
    assert psycopg2.pool.ThreadedConnectionPool(1, 2, DSN) is factory.return_value


def test_blocked_error_is_not_an_exception():
    # Library code wraps connects in `except Exception`; a plain Exception
    # subclass would be swallowed and the suite would go green.
    assert not issubclass(DatabaseAccessBlocked, Exception)


def test_message_does_not_echo_the_dsn(db_block_attempts):
    with pytest.raises(DatabaseAccessBlocked) as caught:
        psycopg2.connect(DSN)
    db_block_attempts.clear()
    assert "hunter2" not in str(caught.value)


def test_the_fake_url_is_in_place():
    assert os.environ["DATABASE_URL"] == FAKE_DATABASE_URL


# ── Subprocess probes ────────────────────────────────────────────────────────


def _run_probe(tmp_path: Path, probe_source: str, extra_files=None, extra_args=()):
    """Run a probe suite under a copy of the real conftest in an empty dir."""
    shutil.copy(Path(__file__).resolve().parent.parent / "conftest.py", tmp_path)
    (tmp_path / "test_probe.py").write_text(textwrap.dedent(probe_source))
    for rel, source in (extra_files or {}).items():
        (tmp_path / rel).write_text(textwrap.dedent(source))
    env = dict(os.environ)
    env.update(dict.fromkeys(BLOCKED_ENV_NAMES, "set-by-the-parent-run"))
    env["DATABASE_URL"] = "postgresql://real:secret@invalid.invalid/prod"
    env["PYTHONPATH"] = str(tmp_path)
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            *extra_args,
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


def test_env_is_forced_to_the_fake_and_scrubbed(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import os
        from conftest import BLOCKED_ENV_NAMES, FAKE_DATABASE_URL

        # What a source module read at import (collection) time would see,
        # before any fixture has run: config.Settings() validates then.
        URL_AT_IMPORT = os.environ.get("DATABASE_URL")
        LEAKED_AT_IMPORT = [n for n in BLOCKED_ENV_NAMES if n in os.environ]

        def test_import_time_sees_only_the_fake():
            assert URL_AT_IMPORT == FAKE_DATABASE_URL
            assert LEAKED_AT_IMPORT == []

        def test_database_url_is_the_fake():
            assert os.environ["DATABASE_URL"] == FAKE_DATABASE_URL

        def test_every_other_blocked_name_is_gone():
            leaked = [n for n in BLOCKED_ENV_NAMES if n in os.environ]
            assert leaked == []

        def test_a_sets_values_and_never_cleans_up():
            os.environ["DATABASE_URL"] = "postgresql://real:secret@invalid.invalid/p"
            os.environ["BLOB_READ_WRITE_TOKEN"] = "leaked"

        def test_b_does_not_see_what_test_a_left():
            assert os.environ["DATABASE_URL"] == FAKE_DATABASE_URL
            assert "BLOB_READ_WRITE_TOKEN" not in os.environ
        """,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_mock_replaces_a_driver_imported_first(tmp_path):
    # A plugin that imports the real psycopg2 before the conftest loads used
    # to make the conftest skip its mock; the mock is now unconditional.
    result = _run_probe(
        tmp_path,
        """
        import sys
        from unittest.mock import MagicMock

        def test_the_mock_won():
            assert isinstance(sys.modules["psycopg2"], MagicMock)
            assert isinstance(sys.modules["psycopg2.pool"], MagicMock)
        """,
        extra_files={
            "preload_psycopg2.py": """
                try:
                    import psycopg2  # the real driver, imported first
                    import psycopg2.pool  # noqa: F401
                except ImportError:
                    pass
            """
        },
        extra_args=("-p", "preload_psycopg2"),
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_swallowed_attempt_fails_the_session(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import psycopg2

        def test_swallows_the_block():
            try:
                psycopg2.connect("postgresql://x@invalid.invalid/db")
            except BaseException:
                pass
        """,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert "psycopg2.connect" in output
    assert MESSAGE in output
