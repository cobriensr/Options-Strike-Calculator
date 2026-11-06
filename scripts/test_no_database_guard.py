"""Self-tests for the no-database guard in scripts/conftest.py.

The guard replaces psycopg2._connect (and psycopg 3's connect, Connection.connect
and AsyncConnection.connect, and asyncpg.connect / create_pool, when those are
installed) with a stub that records the attempt and raises a
BaseException. Each block is proven here: the in-process tests provoke an
attempt directly, and the subprocess tests run a probe suite under a copy of
the real conftest, because the env scrub and the session-end check cannot be
observed from inside the session they guard.

Twin of ml/tests/test_no_database_guard.py (same guard, ml suite). Run:

    ml/.venv/Scripts/pytest scripts/test_no_database_guard.py -q
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import psycopg2
import psycopg2.pool
import pytest
from conftest import BLOCKED_ENV_NAMES, DatabaseAccessBlocked, _STORE_ENV_NAMES
from sqlalchemy import create_engine

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _pipeline_retry import connect_with_retry  # noqa: E402

DSN = 'postgresql://x@invalid.invalid/db'
MESSAGE = 'tests must not connect to a database'


def test_psycopg2_connect_is_blocked_and_recorded(db_block_attempts):
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        psycopg2.connect(DSN)
    assert db_block_attempts.new == ['psycopg2.connect']
    db_block_attempts.discard()


def test_blocked_error_is_not_an_exception():
    # Library code wraps connects in `except Exception`; a plain Exception
    # subclass would be swallowed and the suite would go green.
    assert not issubclass(DatabaseAccessBlocked, Exception)


def test_message_does_not_echo_the_dsn(db_block_attempts):
    secret_dsn = 'postgresql://user:hunter2@invalid.invalid/db'
    with pytest.raises(DatabaseAccessBlocked) as caught:
        psycopg2.connect(secret_dsn)
    db_block_attempts.discard()
    assert 'hunter2' not in str(caught.value)


def _pool_connect():
    psycopg2.pool.ThreadedConnectionPool(1, 2, DSN)


def _engine_connect():
    create_engine('postgresql+psycopg2://x@invalid.invalid/db').connect()


@pytest.mark.parametrize('attempt', [_pool_connect, _engine_connect])
def test_pool_and_sqlalchemy_paths_are_blocked(attempt, db_block_attempts):
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        attempt()
    assert db_block_attempts.new == ['psycopg2.connect']
    db_block_attempts.discard()


def test_a_bare_postgresql_url_cannot_reach_a_database(db_block_attempts):
    # SQLAlchemy 2.1 resolves a bare postgresql:// URL to psycopg 3, which is
    # not installed here: the engine fails with ModuleNotFoundError. SQLAlchemy
    # 2.0 resolves it to psycopg2, which hits the block. A venv that has
    # psycopg 3 hits its block. Whichever driver wins, no connection is made.
    try:
        create_engine('postgresql://x@invalid.invalid/db').connect()
    except ModuleNotFoundError:
        assert db_block_attempts.new == []
    except DatabaseAccessBlocked:
        assert len(db_block_attempts.new) == 1
        db_block_attempts.discard()
    else:  # pragma: no cover - would mean a real connection succeeded
        pytest.fail('a bare postgresql:// URL connected to invalid.invalid')


def test_the_scripts_retry_helper_does_not_swallow_it(db_block_attempts):
    # connect_with_retry retries only transient psycopg2 errors, so the block
    # must come straight through on the first attempt, with no sleep.
    sleeps: list[float] = []
    with pytest.raises(DatabaseAccessBlocked, match=MESSAGE):
        connect_with_retry(DSN, sleep=sleeps.append)
    assert sleeps == []
    assert db_block_attempts.new == ['psycopg2.connect']
    db_block_attempts.discard()


def test_env_names_cover_the_database_and_writable_stores():
    for name in (
        'DATABASE_URL',
        'DATABASE_URL_UNPOOLED',
        'POSTGRES_URL',
        'NEON_DATABASE_URL',
        'KV_REST_API_TOKEN',
        'UPSTASH_REDIS_REST_URL',
        'BLOB_READ_WRITE_TOKEN',
        'R2_SECRET_ACCESS_KEY',
    ):
        assert name in BLOCKED_ENV_NAMES


# ── Subprocess probes ────────────────────────────────────────────────────────


def _run_probe(tmp_path: Path, probe_source: str, extra_files=None):
    """Run a probe suite under a copy of the real conftest in an empty dir."""
    shutil.copy(Path(__file__).resolve().parent / 'conftest.py', tmp_path)
    (tmp_path / 'test_probe.py').write_text(textwrap.dedent(probe_source))
    for rel, source in (extra_files or {}).items():
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(source))
    env = dict(os.environ)
    env.update({name: 'set-by-the-parent-run' for name in BLOCKED_ENV_NAMES})
    return subprocess.run(
        [
            sys.executable,
            '-m',
            'pytest',
            '-p',
            'no:cacheprovider',
            '--rootdir',
            str(tmp_path),
            str(tmp_path),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_env_is_scrubbed_before_each_test(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import os
        from conftest import BLOCKED_ENV_NAMES

        def test_every_blocked_name_is_gone():
            leaked = [n for n in BLOCKED_ENV_NAMES if n in os.environ]
            assert leaked == []
        """,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_swallowed_attempt_fails_the_session(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import psycopg2

        def test_swallows_the_block():
            try:
                psycopg2.connect('postgresql://x@invalid.invalid/db')
            except BaseException:
                pass
        """,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert 'psycopg2.connect' in output
    assert MESSAGE in output


def test_asyncpg_connect_and_create_pool_are_blocked(tmp_path):
    # asyncpg is not installed in the scripts venv, so the probe brings a
    # stand-in whose functions would "really" connect; the guard must replace
    # both.
    result = _run_probe(
        tmp_path,
        """
        import asyncpg
        import pytest

        def test_both_entry_points_are_blocked(db_block_attempts):
            with pytest.raises(BaseException, match='tests must not connect'):
                asyncpg.connect('postgresql://x@invalid.invalid/db')
            with pytest.raises(BaseException, match='tests must not connect'):
                asyncpg.create_pool('postgresql://x@invalid.invalid/db')
            assert db_block_attempts.new == ['asyncpg.connect', 'asyncpg.create_pool']
            db_block_attempts.discard()
        """,
        extra_files={
            'asyncpg/__init__.py': """
                def connect(*args, **kwargs):
                    raise AssertionError('real asyncpg.connect was reached')

                def create_pool(*args, **kwargs):
                    raise AssertionError('real asyncpg.create_pool was reached')
            """
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_psycopg3_connect_points_are_blocked(tmp_path):
    # psycopg 3 is not installed in the scripts venv, so the probe brings a
    # stand-in with the real module's shape: a Connection class, an
    # AsyncConnection class, and a module-level `connect` bound to
    # Connection.connect.
    result = _run_probe(
        tmp_path,
        """
        import psycopg
        import pytest

        def test_every_entry_point_is_blocked(db_block_attempts):
            for call in (
                lambda: psycopg.connect('postgresql://x@invalid.invalid/db'),
                lambda: psycopg.Connection.connect('postgresql://x@invalid.invalid/db'),
                lambda: psycopg.AsyncConnection.connect('postgresql://x@invalid.invalid/db'),
            ):
                with pytest.raises(BaseException, match='tests must not connect'):
                    call()
            assert db_block_attempts.new == [
                'psycopg.connect',
                'psycopg.Connection.connect',
                'psycopg.AsyncConnection.connect',
            ]
            db_block_attempts.discard()
        """,
        extra_files={
            'psycopg/__init__.py': """
                class Connection:
                    @classmethod
                    def connect(cls, *args, **kwargs):
                        raise AssertionError('real psycopg connect was reached')

                class AsyncConnection:
                    @classmethod
                    async def connect(cls, *args, **kwargs):
                        raise AssertionError('real psycopg async connect was reached')

                connect = Connection.connect
            """
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_discarding_in_a_self_test_does_not_hide_an_earlier_offender(tmp_path):
    # test_a swallows the block; test_b is a well-behaved self-test that
    # discards its own attempt. Wiping the whole log (the old `.clear()`)
    # would erase test_a's entry and turn the session green.
    result = _run_probe(
        tmp_path,
        """
        import psycopg2
        import pytest
        from conftest import DatabaseAccessBlocked

        def test_a_swallows_the_block():
            try:
                psycopg2.connect('postgresql://x@invalid.invalid/db')
            except BaseException:
                pass

        def test_b_self_test_discards_its_own_attempt(db_block_attempts):
            with pytest.raises(DatabaseAccessBlocked):
                psycopg2.connect('postgresql://x@invalid.invalid/db')
            assert db_block_attempts.new == ['psycopg2.connect']
            db_block_attempts.discard()
        """,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert 'tried 1 time(s)' in output


# ── Production stores: boto3 / botocore (R2 and S3) ──────────────────────────

STORE_MESSAGE = 'tests must not reach a production store'


def _s3_client():
    boto3 = pytest.importorskip('boto3')
    return boto3.client(
        's3',
        region_name='auto',
        endpoint_url='https://example.invalid',
        aws_access_key_id='AKIA-test',
        aws_secret_access_key='hunter2-secret',
    )


@pytest.mark.parametrize(
    'call',
    [
        lambda c: c.head_object(Bucket='b', Key='k'),
        lambda c: c.get_object(Bucket='b', Key='k'),
        lambda c: c.put_object(Bucket='b', Key='k', Body=b'x'),
        lambda c: c.list_objects_v2(Bucket='b'),
        lambda c: c.delete_object(Bucket='b', Key='k'),
    ],
    ids=['head', 'get', 'put', 'list', 'delete'],
)
def test_boto3_calls_are_blocked_and_recorded(call, db_block_attempts):
    # Reads reach production as surely as writes, so both are blocked.
    client = _s3_client()
    with pytest.raises(DatabaseAccessBlocked, match=STORE_MESSAGE):
        call(client)
    assert db_block_attempts.new == ['botocore.make_api_call']
    db_block_attempts.discard()


def test_store_message_does_not_echo_the_credentials(db_block_attempts):
    client = _s3_client()
    with pytest.raises(DatabaseAccessBlocked) as caught:
        client.head_object(Bucket='b', Key='k')
    db_block_attempts.discard()
    assert 'hunter2' not in str(caught.value)
    assert 'AKIA-test' not in str(caught.value)


def test_presigning_signs_locally_and_is_not_blocked(db_block_attempts):
    url = _s3_client().generate_presigned_url(
        'get_object', Params={'Bucket': 'b', 'Key': 'k'}
    )
    assert url.startswith('https://example.invalid/')
    assert db_block_attempts.new == []


def test_botocore_stand_in_is_blocked_where_botocore_is_a_package_of_its_own(
    tmp_path,
):
    # The probe brings a stand-in whose _make_api_call would "really" call out;
    # the guard must replace it, even in a venv without boto3.
    result = _run_probe(
        tmp_path,
        """
        import pytest
        from botocore.client import BaseClient

        def test_make_api_call_is_blocked(db_block_attempts):
            with pytest.raises(BaseException, match='tests must not reach'):
                BaseClient()._make_api_call('HeadObject', {})
            assert db_block_attempts.new == ['botocore.make_api_call']
            db_block_attempts.discard()
        """,
        extra_files={
            'botocore/__init__.py': '',
            'botocore/client.py': """
                class BaseClient:
                    def _make_api_call(self, operation_name, api_params):
                        raise AssertionError('real _make_api_call was reached')
            """,
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_swallowed_store_call_fails_the_session_and_names_both_rules(tmp_path):
    result = _run_probe(
        tmp_path,
        """
        import psycopg2
        from botocore.client import BaseClient

        def test_swallows_a_store_call():
            try:
                BaseClient()._make_api_call('PutObject', {})
            except BaseException:
                pass

        def test_swallows_a_database_call():
            try:
                psycopg2.connect('postgresql://x@invalid.invalid/db')
            except BaseException:
                pass
        """,
        extra_files={
            'botocore/__init__.py': '',
            'botocore/client.py': """
                class BaseClient:
                    def _make_api_call(self, operation_name, api_params):
                        raise AssertionError('real _make_api_call was reached')
            """,
        },
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert 'botocore.make_api_call' in output
    assert STORE_MESSAGE in output
    assert MESSAGE in output
    assert 'tried 2 time(s)' in output


def test_the_env_file_loader_is_wrapped_once_where_the_module_exists(tmp_path):
    # No `utils` is importable when scripts/conftest.py loads (ml/src joins
    # sys.path only later, from online_ticker_update), so the wrapper does
    # nothing in this suite itself; the ml twin proves it against the real
    # one. The probe brings a stand-in `utils` whose load_env returns every
    # store name next to a harmless one and a database URL, the way ml's does
    # when the repo-root .env holds them.
    stand_in = f"""
        def load_env():
            env = {{name: 'fake' for name in {list(_STORE_ENV_NAMES)!r}}}
            env['HARMLESS'] = 'kept'
            env['DATABASE_URL'] = 'postgresql://x@invalid.invalid/db'
            return env
    """
    result = _run_probe(
        tmp_path,
        """
        import utils
        from conftest import _install_env_file_strip

        def test_store_names_are_dropped_and_the_rest_kept():
            assert sorted(utils.load_env()) == ['DATABASE_URL', 'HARMLESS']

        def test_installing_again_does_not_wrap_twice():
            before = utils.load_env
            _install_env_file_strip()
            assert utils.load_env is before
        """,
        extra_files={'utils.py': stand_in},
    )
    assert result.returncode == 0, result.stdout + result.stderr
