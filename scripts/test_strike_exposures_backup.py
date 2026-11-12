"""Tests for scripts/strike_exposures_backup.py, the strike_exposures backup.

Run:

    ml/.venv/Scripts/pytest scripts/test_strike_exposures_backup.py -q

The file covers the whole module, in this order:

- the day reader and Parquet writer (`_read_snapshot`, `iter_day_pages`,
  `write_day_parquet`): types, keyset paging, the count check, the cleanup;
- the R2 side (`upload_day`, `exported_days`, `read_state`, `write_state`);
- the planner (`plan_days`): which days are due and how they are counted;
- the CLI (`main`: `export` and `status`), run end to end on the fakes.

No test reaches a database or R2. The connection and cursor are fakes that
hold a list of rows and serve counts, planning reads and keyset pages from it,
reading the same parameters the module sends, so a query that forgets its key
or its LIMIT shows up as wrong data and not just as a wrong string. The fake
also enforces the rules the module relies on: a BEGIN needs autocommit on and
no open transaction, every `%s` needs a parameter, no statement or fetch runs
outside the snapshot, and a test that leaves the transaction open fails at
teardown. `fail_on` makes one statement raise, and a closed connection behaves
as psycopg2's does. `FakeS3` is a dict-backed R2 client with boto3's
signatures, and `Cli` runs `main` with the environment, `psycopg2.connect` and
`boto3.client` replaced.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import traceback
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import psycopg2
import psycopg2.errors
import pyarrow.parquet as pq
import pytest
from boto3.exceptions import S3UploadFailedError
from botocore.exceptions import ClientError
from psycopg2.extensions import (
    TRANSACTION_STATUS_IDLE,
    TRANSACTION_STATUS_INTRANS,
    TRANSACTION_STATUS_UNKNOWN,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))

import strike_exposures_backup as sbk  # noqa: E402

DAY = date(2026, 11, 2)
UTC = timezone.utc
KEY_NAMES = ('timestamp', 'ticker', 'strike', 'expiry')
GREEKS = (
    'call_gamma_oi',
    'put_gamma_oi',
    'call_gamma_ask',
    'call_gamma_bid',
    'put_gamma_ask',
    'put_gamma_bid',
    'call_charm_oi',
    'put_charm_oi',
    'call_charm_ask',
    'call_charm_bid',
    'put_charm_ask',
    'put_charm_bid',
    'call_delta_oi',
    'put_delta_oi',
    'call_vanna_oi',
    'put_vanna_oi',
)
PAGE_SQL_TAIL = 'ORDER BY date, "timestamp", ticker, strike, expiry LIMIT %s'


def make_row(**overrides) -> tuple:
    """One table row in COLUMNS order, with the values psycopg2 returns."""
    row = {
        'id': 1,
        'date': DAY,
        'timestamp': datetime(2026, 11, 2, 15, 0, tzinfo=UTC),
        'ticker': 'SPX',
        'expiry': date(2026, 11, 2),
        'strike': Decimal('5500.00'),
        'price': Decimal('5512.25'),
        **{name: Decimal('1.5000') for name in GREEKS},
        'created_at': datetime(2026, 11, 2, 22, 30, 54, 123456, tzinfo=UTC),
    }
    unknown = set(overrides) - set(row)
    assert not unknown, unknown
    row.update(overrides)
    return tuple(row[name] for name in sbk.COLUMNS)


def key_of(row: tuple) -> tuple:
    return tuple(row[sbk.COLUMNS.index(name)] for name in KEY_NAMES)


def plain_rows(n: int, ids: list[int] | None = None) -> list[tuple]:
    """n ordinary rows with distinct timestamps, in key order.

    The ids count down from 100 unless `ids` gives them. The timestamps carry
    microseconds, so a continuation key that rounds or truncates one re-reads
    the row before it.
    """
    start = datetime(2026, 11, 2, 15, 0, tzinfo=UTC)
    return [
        make_row(
            id=100 - i if ids is None else ids[i],
            timestamp=start + timedelta(minutes=i, microseconds=123457),
        )
        for i in range(n)
    ]


class FakeCursor:
    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn
        self._result: list[tuple] = []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def execute(self, sql: str, params: tuple | None = None) -> None:
        conn = self.conn
        if conn.closed:
            raise psycopg2.InterfaceError('cursor already closed')
        text = ' '.join(sql.split())
        assert text.count('%s') == len(params or ()), text
        conn.statements.append((text, params))
        assert (
            conn.in_txn or not conn.autocommit or text.startswith('BEGIN')
        ), f'statement outside the snapshot: {text}'
        if not conn.autocommit and not text.startswith('BEGIN'):
            conn.in_txn = True  # psycopg2 opens a transaction before a statement
        if text.startswith('BEGIN'):
            assert not conn.in_txn, 'BEGIN inside an open transaction'
            assert conn.autocommit is True, 'BEGIN with autocommit off'
            conn.in_txn = True
        elif text == 'ROLLBACK':
            # A ROLLBACK that fails leaves a dead connection, not an open transaction.
            conn.in_txn = False
            conn.fail('rollback')
        elif text == 'SELECT count(*) FROM strike_exposures WHERE expiry IS NULL':
            conn.fail('null_expiry')
            self._result = [(conn.null_expiry,)]
        elif text == 'SELECT count(*) FROM strike_exposures WHERE date = %s':
            conn.fail('count')
            self._result = [(conn.count_for(params[0]),)]
        elif text.startswith('WITH RECURSIVE'):
            conn.fail('days')
            self._result = [(day,) for day in conn.days()]
        elif text == 'SELECT max(id) FROM strike_exposures':
            conn.fail('max_id')
            self._result = [(conn.max_id(),)]
        elif text == 'SELECT date FROM strike_exposures WHERE id > %s GROUP BY date':
            conn.fail('delta')
            self._result = [(day,) for day in conn.days_after(params[0])]
        elif text.startswith('SELECT ') and 'LIMIT %s' in text:
            conn.fail(f'page{len(conn.page_queries)}')
            self._result = conn.serve_page(params, keyed='> (%s' in text)
        else:
            assert text.startswith('SET LOCAL statement_timeout'), f'unexpected: {text}'
            self._result = []

    def fetchone(self) -> tuple:
        assert self.conn.in_txn, 'fetch outside the snapshot'
        return self._result[0]

    def fetchall(self) -> list[tuple]:
        assert self.conn.in_txn, 'fetch outside the snapshot'
        return self._result


class FakeConnection:
    """A psycopg2 connection over a list of rows.

    The rows may span several days. A day's count is the number of its rows,
    unless `count` overrides it. `null_expiry` is what the NULL-expiry count
    says. `stuck` makes every page the first page again, as a keyset that
    never advances would, and gives up after 20 page queries so a missing
    guard fails instead of hanging. `fail_on` maps an event ('count', 'page1',
    'page2', ..., 'rollback', and the planning reads 'null_expiry', 'days',
    'max_id', 'delta') to the exception its statement raises. The event named
    by `closes_on` also kills the connection, as a dropped link does: `closed`
    becomes 2, and from then on a statement or an autocommit change raises
    InterfaceError, as psycopg2 does on a closed connection.
    """

    def __init__(
        self,
        rows: list[tuple],
        count: int | None = None,
        null_expiry: int = 0,
        stuck: bool = False,
        fail_on: dict[str, Exception] | None = None,
        closes_on: str | None = None,
        autocommit: bool = False,
    ) -> None:
        self.rows = sorted(rows, key=key_of)
        self.count = count
        self.null_expiry = null_expiry
        self.stuck = stuck
        self.fail_on = fail_on or {}
        self.closes_on = closes_on
        self.closed = 0
        self._autocommit = autocommit
        self.in_txn = False
        self.statements: list[tuple[str, tuple | None]] = []

    @property
    def autocommit(self) -> bool:
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value: bool) -> None:
        if self.closed:
            raise psycopg2.InterfaceError('connection already closed')
        self._autocommit = value

    def cursor(self) -> FakeCursor:
        if self.closed:
            raise psycopg2.InterfaceError('connection already closed')
        return FakeCursor(self)

    def close(self) -> None:
        self.closed = self.closed or 1

    def count_for(self, day: date) -> int:
        if self.count is not None:
            return self.count
        return sum(1 for r in self.rows if r[sbk.COLUMNS.index('date')] == day)

    def days(self) -> list[date]:
        return sorted({r[sbk.COLUMNS.index('date')] for r in self.rows})

    def max_id(self) -> int | None:
        return max((r[0] for r in self.rows), default=None)

    def days_after(self, last_id: int) -> list[date]:
        return sorted({r[sbk.COLUMNS.index('date')] for r in self.rows if r[0] > last_id})

    @property
    def info(self) -> SimpleNamespace:
        if self.closed:
            status = TRANSACTION_STATUS_UNKNOWN  # what psycopg2 reports once closed
        elif self.in_txn:
            status = TRANSACTION_STATUS_INTRANS
        else:
            status = TRANSACTION_STATUS_IDLE
        return SimpleNamespace(transaction_status=status)

    @property
    def page_queries(self) -> list[tuple[str, tuple]]:
        return [(t, p) for t, p in self.statements if 'LIMIT %s' in t]

    def fail(self, event: str) -> None:
        if event in self.fail_on:
            if event == self.closes_on:
                self.closed = 2
                self.in_txn = False  # a dead connection holds no transaction
            raise self.fail_on[event]

    def serve_page(self, params: tuple, keyed: bool) -> list[tuple]:
        assert len(self.page_queries) <= 20, 'paging did not stop'
        day, *after, limit = params
        if self.stuck:
            return self.rows[:limit]
        day_rows = [r for r in self.rows if r[sbk.COLUMNS.index('date')] == day]
        if keyed:
            day_rows = [r for r in day_rows if key_of(r) > tuple(after)]
        return day_rows[:limit]


@pytest.fixture
def make_conn():
    """Build fake connections; at teardown none may be left in a transaction."""
    made: list[FakeConnection] = []

    def make(rows: list[tuple], **kwargs) -> FakeConnection:
        conn = FakeConnection(rows, **kwargs)
        made.append(conn)
        return conn

    yield make
    for conn in made:
        assert not conn.in_txn, 'the test left the transaction open'


def assert_same_cell(got: object, want: object) -> None:
    """Same Python type and value; a Decimal must also keep its exponent."""
    assert type(got) is type(want)
    if isinstance(want, Decimal):
        assert got.as_tuple() == want.as_tuple()
    else:
        assert got == want


def test_schema_matches_table_ddl() -> None:
    # Pinned by hand against migration #8, #17 (created_at NOT NULL) and #191
    # (greeks widened to NUMERIC(30,4)).
    want = {
        'id': ('int32', False),
        'date': ('date32[day]', False),
        'timestamp': ('timestamp[us, tz=UTC]', False),
        'ticker': ('string', False),
        'expiry': ('date32[day]', True),
        'strike': ('decimal128(10, 2)', False),
        'price': ('decimal128(10, 2)', True),
        **{name: ('decimal128(30, 4)', True) for name in GREEKS},
        'created_at': ('timestamp[us, tz=UTC]', False),
    }
    got = {f.name: (str(f.type), f.nullable) for f in sbk.ARROW_SCHEMA}
    assert got == want
    assert list(want) == list(sbk.COLUMNS)
    assert len(sbk.COLUMNS) == 24


def test_round_trip_exact_values(make_conn, tmp_path: Path) -> None:
    rows = [
        # 01:30 EDT on the fall-back night, as a New York session returns it
        # (05:30Z), with every nullable column NULL and the all-expiry sentinel.
        make_row(
            id=1,
            timestamp=datetime(2026, 11, 1, 1, 30, tzinfo=timezone(timedelta(hours=-4))),
            expiry=date(1970, 1, 1),
            price=None,
            **{name: None for name in GREEKS},
        ),
        # The second 01:30 that night, on EST (06:30Z): a different instant.
        make_row(
            id=2,
            timestamp=datetime(2026, 11, 1, 1, 30, tzinfo=timezone(timedelta(hours=-5))),
            call_gamma_oi=Decimal('12345678901234567890123456.1234'),
            put_gamma_oi=Decimal('-0.0001'),
            call_charm_oi=Decimal('-12345678901234567890123456.1234'),
            put_charm_oi=Decimal('0.0000'),
        ),
        make_row(
            id=3,
            strike=Decimal('99999999.99'),
            price=Decimal('0.00'),
            created_at=datetime(2026, 11, 2, 22, 30, 54, 1, tzinfo=UTC),
        ),
        make_row(id=4, ticker='SPXW', put_delta_oi=None),
    ]
    conn = make_conn(rows)

    result = sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert result is not None
    want = sorted(rows, key=key_of)
    got = pq.read_table(result.path).to_pylist()
    assert len(got) == len(want)
    for got_row, want_row in zip(got, want):
        assert list(got_row) == list(sbk.COLUMNS)
        for name, value in zip(sbk.COLUMNS, want_row):
            assert_same_cell(got_row[name], value)
    assert pq.read_schema(result.path).equals(sbk.ARROW_SCHEMA)
    # One row group per page: 4 rows in pages of 2.
    assert pq.ParquetFile(result.path).metadata.num_row_groups == 2
    assert pq.ParquetFile(result.path).metadata.row_group(0).column(0).compression == 'ZSTD'


def test_count_mismatch_raises_and_leaves_no_file(make_conn, tmp_path: Path) -> None:
    conn = make_conn(plain_rows(2), count=3)

    with pytest.raises(sbk.BackupError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert str(raised.value) == '2026-11-02: row count mismatch (snapshot 3, wrote 2)'
    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_more_rows_than_the_count_raises_early(make_conn, tmp_path: Path) -> None:
    # Pages that keep coming after the snapshot count is passed stop the
    # export at the page that passes it, before the rest is read.
    conn = make_conn(plain_rows(6), count=3)

    with pytest.raises(sbk.BackupError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert str(raised.value) == '2026-11-02: row count mismatch (snapshot 3, wrote 4)'
    assert len(conn.page_queries) == 2
    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_paging_that_never_advances_is_stopped(make_conn, tmp_path: Path) -> None:
    conn = make_conn(plain_rows(2), count=3, stuck=True)

    with pytest.raises(sbk.BackupError):
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert list(tmp_path.iterdir()) == []


def test_zero_row_day_returns_none(make_conn, tmp_path: Path) -> None:
    conn = make_conn([])

    assert sbk.write_day_parquet(conn, DAY, tmp_path) is None

    assert list(tmp_path.iterdir()) == []
    assert conn.page_queries == []
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_unconvertible_cell_raises_without_the_value(make_conn, tmp_path: Path) -> None:
    secret = 'SECRET-CELL-VALUE'
    conn = make_conn([make_row(id=secret)])

    with pytest.raises(sbk.BackupError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path)

    shown = ''.join(traceback.format_exception(raised.value))
    assert secret not in str(raised.value)
    assert secret not in shown
    # Arrow's message, which quotes the cell, is not anywhere in the chain.
    assert raised.value.__context__ is None
    assert raised.value.__cause__ is None
    assert str(raised.value).startswith('2026-11-02:')
    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == 'ROLLBACK'


@pytest.mark.parametrize(
    'bad',
    [
        pytest.param({'id': 2**40}, id='id-overflows-int32'),
        pytest.param({'id': None}, id='null-in-not-null-column'),
        pytest.param({'put_vanna_oi': Decimal(10**26)}, id='decimal-too-wide'),
        pytest.param({'strike': 5500.0}, id='float-for-numeric'),
    ],
)
def test_cell_outside_the_schema_raises_backup_error(
    make_conn, tmp_path: Path, bad: dict
) -> None:
    conn = make_conn([make_row(**bad)])

    with pytest.raises(sbk.BackupError, match='did not fit the Parquet schema'):
        sbk.write_day_parquet(conn, DAY, tmp_path)

    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_keyset_sql(make_conn, tmp_path: Path) -> None:
    rows = plain_rows(5)
    conn = make_conn(rows)

    result = sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert result is not None and result.rows == 5
    assert conn.autocommit is False  # the caller's setting, put back
    texts = [text for text, _ in conn.statements]
    assert texts[0] == 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    assert texts[1] == "SET LOCAL statement_timeout = '60s'"
    assert texts[2] == 'SELECT count(*) FROM strike_exposures WHERE date = %s'
    assert conn.statements[2][1] == (DAY,)
    assert texts[-1] == 'ROLLBACK'

    pages = conn.page_queries
    assert len(pages) == 3  # 2 + 2 + 1: the short page ends the day without a 4th query
    assert len(conn.statements) == 3 + len(pages) + 1
    for text, _ in pages:
        assert text.endswith(PAGE_SQL_TAIL)
        assert 'OFFSET' not in text.upper()
    ordered = sorted(rows, key=key_of)
    first_text, first_params = pages[0]
    assert '> (' not in first_text
    assert first_params == (DAY, 2)
    key_clause = 'AND ("timestamp", ticker, strike, expiry) > (%s, %s, %s, %s)'
    for (text, params), previous_last in zip(pages[1:], (ordered[1], ordered[3])):
        assert key_clause in text
        assert params == (DAY, *key_of(previous_last), 2)


@pytest.mark.parametrize(
    'ids',
    [
        # In pages of 2 the extreme ids sit on opposite pages, in either order,
        # so a bound taken from the first or the last page alone is wrong.
        pytest.param([98, 99, 100], id='ascending'),
        pytest.param([100, 99, 98], id='descending'),
    ],
)
def test_dayfile_fields(make_conn, tmp_path: Path, ids: list[int]) -> None:
    conn = make_conn(plain_rows(3, ids=ids))

    result = sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert result is not None
    assert result.day == DAY
    assert result.path == tmp_path / '2026-11-02.parquet'
    assert result.rows == 3
    assert (result.min_id, result.max_id) == (98, 100)
    assert result.size == result.path.stat().st_size
    assert result.sha256 == hashlib.sha256(result.path.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    'error_type', [psycopg2.errors.QueryCanceled, psycopg2.OperationalError]
)
@pytest.mark.parametrize(
    ('event', 'pages_seen'), [('count', 0), ('page1', 1), ('page2', 2)]
)
def test_database_error_propagates_unwrapped_and_cleans_up(
    make_conn, tmp_path: Path, event: str, pages_seen: int, error_type: type
) -> None:
    error = error_type('injected')
    conn = make_conn(plain_rows(5), fail_on={event: error})

    with pytest.raises(error_type) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert raised.value is error
    assert conn.statements[-1][0] == 'ROLLBACK'
    assert len(conn.page_queries) == pages_seen
    assert list(tmp_path.iterdir()) == []
    assert conn.autocommit is False


@pytest.mark.parametrize('before', [False, True])
@pytest.mark.parametrize('fails', [False, True])
def test_autocommit_is_restored(
    make_conn, tmp_path: Path, before: bool, fails: bool
) -> None:
    error = psycopg2.OperationalError('injected')
    conn = make_conn(
        plain_rows(3), autocommit=before, fail_on={'page1': error} if fails else None
    )

    if fails:
        with pytest.raises(psycopg2.OperationalError):
            sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)
    else:
        assert sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2) is not None

    assert conn.autocommit is before


def test_connection_inside_a_transaction_is_refused(make_conn, tmp_path: Path) -> None:
    # A BEGIN inside an open transaction is only a server WARNING, so without
    # this check the export would read in the caller's transaction.
    conn = make_conn(plain_rows(2))
    conn.in_txn = True

    with pytest.raises(sbk.BackupError, match=r'already inside a transaction \(status 2\)'):
        sbk.write_day_parquet(conn, DAY, tmp_path)

    assert conn.statements == []
    assert conn.autocommit is False
    assert list(tmp_path.iterdir()) == []
    conn.in_txn = False  # the caller's own transaction, closed for the teardown check


def test_rollback_failure_after_a_complete_file_deletes_it(
    make_conn, tmp_path: Path
) -> None:
    error = psycopg2.OperationalError('connection lost')
    conn = make_conn(plain_rows(3), fail_on={'rollback': error})

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert raised.value is error
    assert len(conn.page_queries) == 2  # the whole day was read and written first
    assert list(tmp_path.iterdir()) == []
    assert conn.autocommit is False


def test_rollback_failure_keeps_the_original_error_in_context(
    make_conn, tmp_path: Path
) -> None:
    original = psycopg2.errors.QueryCanceled('statement timeout')
    rollback = psycopg2.OperationalError('connection lost')
    conn = make_conn(plain_rows(5), fail_on={'page2': original, 'rollback': rollback})

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert raised.value is rollback
    assert raised.value.__context__ is original
    assert list(tmp_path.iterdir()) == []
    assert conn.autocommit is False


@pytest.mark.parametrize('event', ['count', 'page1', 'page2'])
def test_dropped_connection_surfaces_the_original_error(
    make_conn, tmp_path: Path, event: str
) -> None:
    # Once the link is gone, psycopg2 raises InterfaceError for the ROLLBACK
    # and for the autocommit restore. Neither may replace the real error.
    error = psycopg2.OperationalError('server closed the connection unexpectedly')
    conn = make_conn(plain_rows(5), fail_on={event: error}, closes_on=event)

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert raised.value is error
    assert raised.value.__context__ is None
    assert 'ROLLBACK' not in [text for text, _ in conn.statements]
    assert list(tmp_path.iterdir()) == []


def test_digest_failure_deletes_the_file(
    make_conn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*_args, **_kwargs):
        raise OSError('disk')

    monkeypatch.setattr(sbk.hashlib, 'file_digest', broken)
    conn = make_conn(plain_rows(2))

    with pytest.raises(OSError, match='disk'):
        sbk.write_day_parquet(conn, DAY, tmp_path)

    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_stat_failure_deletes_the_file(
    make_conn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_stat = Path.stat

    def stat_fails_on_the_day_file(self: Path, *args, **kwargs):
        if self.name == '2026-11-02.parquet':
            raise OSError('disk')
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, 'stat', stat_fails_on_the_day_file)
    conn = make_conn(plain_rows(2))

    with pytest.raises(OSError, match='disk'):
        sbk.write_day_parquet(conn, DAY, tmp_path)

    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_a_closed_connection_is_refused_with_its_own_text(make_conn) -> None:
    # psycopg2 reports status 4 (UNKNOWN) once a connection is closed. That is
    # not "inside a transaction", and the message must not say it is.
    conn = make_conn(plain_rows(2))
    conn.closed = 2

    with pytest.raises(sbk.BackupError, match=r'^the connection is closed \(status 4\)$'):
        with sbk._read_snapshot(conn):
            pytest.fail('the block must not run')

    assert conn.statements == []


# ── Task 2: upload, plan, export and status ──────────────────────────────────

BUCKET = 'test-bucket'
D1, D2, D3 = date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4)
TODAY = date(2026, 11, 6)
DSN_SECRET = 'DB-PASSWORD-MARKER'
R2_SECRET = 'R2-SECRET-MARKER'
ENV = {
    'DATABASE_URL': f'postgresql://user:{DSN_SECRET}@ep-marker.example.invalid/db',
    'R2_ENDPOINT_URL': 'https://acct-marker.r2.example.invalid',
    'R2_ACCESS_KEY_ID': 'ACCESS-KEY-MARKER',
    'R2_SECRET_ACCESS_KEY': R2_SECRET,
    'R2_BUCKET_FULLTAPE': BUCKET,
}
STATE_KEY = 'backups/strike_exposures/_state.json'


def day_rows(day: date, ids: list[int]) -> list[tuple]:
    """One day's rows with the given ids, in key order."""
    start = datetime(day.year, day.month, day.day, 15, 0, tzinfo=UTC)
    return [
        make_row(
            id=row_id,
            date=day,
            expiry=day,
            timestamp=start + timedelta(minutes=n, microseconds=123457),
        )
        for n, row_id in enumerate(ids)
    ]


def three_days() -> list[tuple]:
    """D1 has 2 rows, D2 has 3 and D3 has 1; ids 1 to 6."""
    return day_rows(D1, [1, 2]) + day_rows(D2, [3, 4, 5]) + day_rows(D3, [6])


def key(day: date) -> str:
    return f'backups/strike_exposures/{day.isoformat()}.parquet'


class FakePaginator:
    def __init__(self, s3: FakeS3) -> None:
        self.s3 = s3

    def paginate(self, Bucket: str, Prefix: str = ''):
        assert Bucket == BUCKET
        self.s3.calls.append(('list', Prefix))
        if self.s3.list_error is not None:
            raise self.s3.list_error
        keys = sorted(k for k in self.s3.objects if k.startswith(Prefix))
        if not keys:
            yield {'KeyCount': 0}  # boto3 gives a page without 'Contents'
        size = self.s3.page_size
        for start in range(0, len(keys), size):
            yield {
                'Contents': [
                    {'Key': k, 'Size': len(self.s3.objects[k]['Body'])}
                    for k in keys[start : start + size]
                ]
            }


class FakeS3:
    """A dict-backed stand-in for the boto3 S3 client calls the module makes.

    Signatures follow boto3 1.43. `upload_errors` makes upload_file raise for a
    key, `lost` makes an upload that returns fine never show up, `short_by`
    makes head_object report that many bytes fewer, `meta_override` replaces
    the metadata head_object reports, and `delete_error` makes delete_object
    raise. `page_size` is small so list pagination is exercised.
    """

    def __init__(self, page_size: int = 2) -> None:
        self.objects: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.upload_errors: dict[str, Exception] = {}
        self.lost: set[str] = set()
        self.short_by: dict[str, int] = {}
        self.meta_override: dict[str, dict[str, str]] = {}
        self.delete_error: Exception | None = None
        self.put_error: Exception | None = None
        self.list_error: Exception | None = None
        self.page_size = page_size
        self.transfer_configs: list[object] = []
        self.extra_args: dict[str, dict] = {}
        self.files_seen: list[list[str]] = []

    def put_day(self, day: date, rows: int, **metadata: str) -> None:
        """An object as a past run left it: current format, `rows` rows."""
        self.objects[key(day)] = {
            'Body': b'old',
            'Metadata': {'rows': str(rows), 'format': sbk.FORMAT_VERSION, **metadata},
        }

    def keys(self, kind: str) -> list[str]:
        return [k for c, k in self.calls if c == kind]

    def state(self) -> dict | None:
        if STATE_KEY not in self.objects:
            return None
        return json.loads(self.objects[STATE_KEY]['Body'])

    def upload_file(self, Filename, Bucket, Key, ExtraArgs=None, Callback=None, Config=None):
        assert Bucket == BUCKET
        self.calls.append(('upload', Key))
        self.transfer_configs.append(Config)
        self.extra_args[Key] = ExtraArgs or {}
        self.files_seen.append(sorted(p.name for p in Path(Filename).parent.iterdir()))
        if Key in self.upload_errors:
            raise self.upload_errors[Key]
        if Key not in self.lost:
            self.objects[Key] = {
                'Body': Path(Filename).read_bytes(),
                'Metadata': dict((ExtraArgs or {}).get('Metadata', {})),
            }

    def head_object(self, Bucket, Key):
        assert Bucket == BUCKET
        self.calls.append(('head', Key))
        if Key not in self.objects:
            raise ClientError(
                {'Error': {'Code': '404', 'Message': 'Not Found'}}, 'HeadObject'
            )
        obj = self.objects[Key]
        return {
            'ContentLength': len(obj['Body']) - self.short_by.get(Key, 0),
            'Metadata': dict(self.meta_override.get(Key, obj['Metadata'])),
        }

    def get_object(self, Bucket, Key):
        assert Bucket == BUCKET
        self.calls.append(('get', Key))
        if Key not in self.objects:
            raise ClientError(
                {'Error': {'Code': 'NoSuchKey', 'Message': 'missing'}}, 'GetObject'
            )
        return {'Body': io.BytesIO(self.objects[Key]['Body'])}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        assert Bucket == BUCKET
        self.calls.append(('put', Key))
        if self.put_error is not None:
            raise self.put_error
        self.objects[Key] = {'Body': Body, 'Metadata': {}}

    def delete_object(self, Bucket, Key):
        assert Bucket == BUCKET
        self.calls.append(('delete', Key))
        if self.delete_error is not None:
            raise self.delete_error
        self.objects.pop(Key, None)

    def get_paginator(self, name: str) -> FakePaginator:
        assert name == 'list_objects_v2'
        return FakePaginator(self)


class Cli:
    """Runs sbk.main with the env, the database and the R2 client faked."""

    def __init__(self, monkeypatch, capsys, work: Path) -> None:
        self.monkeypatch = monkeypatch
        self.capsys = capsys
        self.work = work
        self.connects: list[tuple] = []
        self.clients: list[tuple] = []
        for name, value in ENV.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setattr(sbk, 'load_env_file', lambda path: None)
        monkeypatch.setattr(sbk, '_today_et', lambda: TODAY)
        monkeypatch.setattr(tempfile, 'tempdir', str(work))

    def run(self, conn, s3, *argv: str) -> tuple[int, str]:
        def connect(*args, **kwargs):
            self.connects.append((args, kwargs))
            if isinstance(conn, Exception):
                raise conn
            return conn

        def client(*args, **kwargs):
            self.clients.append((args, kwargs))
            if isinstance(s3, Exception):
                raise s3
            return s3

        self.monkeypatch.setattr(sbk.psycopg2, 'connect', connect)
        self.monkeypatch.setattr(sbk.boto3, 'client', client)
        connects_before = len(self.connects)
        code = sbk.main(list(argv))
        out = self.capsys.readouterr()
        if not isinstance(conn, Exception) and len(self.connects) > connects_before:
            assert not conn.in_txn, 'main left a transaction open'
            assert conn.closed, 'main left the connection open'
        assert list(self.work.iterdir()) == [], 'main left day files behind'
        return code, out.out + out.err


@pytest.fixture
def cli(monkeypatch, capsys, tmp_path):
    work = tmp_path / 'work'
    work.mkdir()
    return Cli(monkeypatch, capsys, work)


def day_file(tmp_path: Path, day: date = D1, ids: list[int] | None = None) -> sbk.DayFile:
    conn = FakeConnection(day_rows(day, ids or [1, 2]))
    result = sbk.write_day_parquet(conn, day, tmp_path)
    assert result is not None
    return result


def test_object_key() -> None:
    assert sbk.object_key(D1) == 'backups/strike_exposures/2026-11-02.parquet'


def test_upload_day_stores_metadata_and_verifies(tmp_path: Path) -> None:
    f = day_file(tmp_path)
    s3 = FakeS3()

    sbk.upload_day(s3, BUCKET, f)

    meta = s3.objects[key(D1)]['Metadata']
    assert set(meta) == {'rows', 'min-id', 'max-id', 'sha256', 'exported-at', 'format'}
    assert (meta['rows'], meta['min-id'], meta['max-id']) == ('2', '1', '2')
    assert meta['sha256'] == f.sha256
    assert meta['format'] == '1'
    assert datetime.fromisoformat(meta['exported-at']).utcoffset() == timedelta(0)
    assert all(value.isascii() for value in meta.values())
    assert s3.objects[key(D1)]['Body'] == f.path.read_bytes()
    # One thread: a client shared across upload threads once skipped TLS checks.
    # The rest is nightly's R2Store transfer setup, which is known to work on R2.
    transfer = s3.transfer_configs[0]
    assert transfer.use_threads is False
    assert transfer.preferred_transfer_client == 'classic'
    assert transfer.multipart_threshold == 64 * 2**20
    assert s3.keys('head') == [key(D1)]
    assert s3.keys('delete') == []


@pytest.mark.parametrize(
    ('s3_setup', 'message'),
    [
        pytest.param(lambda s3: s3.short_by.update({key(D1): 1}), 'R2 holds', id='size'),
        pytest.param(
            lambda s3: s3.meta_override.update({key(D1): {'rows': '3'}}),
            'rows metadata',
            id='rows',
        ),
        pytest.param(lambda s3: s3.lost.add(key(D1)), 'could not verify', id='missing'),
    ],
)
def test_upload_verifies_size_and_rows(tmp_path: Path, s3_setup, message: str) -> None:
    f = day_file(tmp_path)
    s3 = FakeS3()
    s3_setup(s3)

    with pytest.raises(sbk.BackupError, match=message):
        sbk.upload_day(s3, BUCKET, f)

    # An object that failed its check must not count as exported.
    assert s3.keys('delete') == [key(D1)]
    assert key(D1) not in s3.objects


def test_upload_that_cannot_be_deleted_says_the_object_may_remain(tmp_path: Path) -> None:
    f = day_file(tmp_path)
    s3 = FakeS3()
    s3.short_by[key(D1)] = 1
    s3.delete_error = ClientError({'Error': {'Code': 'AccessDenied'}}, 'DeleteObject')

    with pytest.raises(sbk.BackupError, match='may remain') as raised:
        sbk.upload_day(s3, BUCKET, f)

    assert isinstance(raised.value.__cause__, sbk.BackupError)
    # The operator needs the key, and the instruction, to clean up by hand.
    assert key(D1) in str(raised.value)
    assert 'delete it by hand' in str(raised.value)


def test_upload_error_propagates_and_deletes_nothing(tmp_path: Path) -> None:
    f = day_file(tmp_path)
    s3 = FakeS3()
    error = ClientError({'Error': {'Code': 'SlowDown'}}, 'PutObject')
    s3.upload_errors[key(D1)] = error

    with pytest.raises(ClientError) as raised:
        sbk.upload_day(s3, BUCKET, f)

    assert raised.value is error
    assert s3.keys('head') == [] and s3.keys('delete') == []


def test_exported_days_lists_every_page_and_skips_non_day_keys() -> None:
    s3 = FakeS3(page_size=2)
    for n, day in enumerate([D1, D2, D3, date(2026, 11, 5), date(2026, 11, 9)]):
        s3.put_day(day, n + 1)
    s3.objects[STATE_KEY] = {'Body': b'{}', 'Metadata': {}}
    s3.objects['backups/strike_exposures/notes.txt'] = {'Body': b'', 'Metadata': {}}
    s3.objects['backups/other/2026-11-02.parquet'] = {'Body': b'', 'Metadata': {}}
    # Names that start or end like a day's file but are not one.
    for stray in (
        'backups/strike_exposures/2026-11-02.parquet.bak',
        'backups/strike_exposures/sub/2026-11-02.parquet',
        'backups/strike_exposures/2026-11-02.parquet/part',
    ):
        s3.objects[stray] = {'Body': b'', 'Metadata': {'rows': '9'}}
    s3.objects['backups/strike_exposures/2026-13-45.parquet'] = {
        'Body': b'',
        'Metadata': {'rows': '9'},
    }

    found = sbk.exported_days(s3, BUCKET)

    assert {day: meta['rows'] for day, meta in found.items()} == {
        D1: '1',
        D2: '2',
        D3: '3',
        date(2026, 11, 5): '4',
        date(2026, 11, 9): '5',
    }
    assert s3.keys('list') == ['backups/strike_exposures/']
    assert STATE_KEY not in s3.keys('head')


def test_exported_days_of_an_empty_prefix() -> None:
    assert sbk.exported_days(FakeS3(), BUCKET) == {}


def test_state_round_trip_and_missing() -> None:
    s3 = FakeS3()
    assert sbk.read_state(s3, BUCKET) is None

    sbk.write_state(s3, BUCKET, 94_224_463)

    assert sbk.read_state(s3, BUCKET) == 94_224_463
    stored = s3.state()
    assert stored is not None and set(stored) == {'high_water_id', 'updated_at'}
    assert datetime.fromisoformat(stored['updated_at']).utcoffset() == timedelta(0)


@pytest.mark.parametrize(
    'body',
    [b'not json', b'[]', b'{}', b'{"high_water_id": "7"}', b'{"high_water_id": true}', b'{"high_water_id": -1}'],
)
def test_malformed_state_raises(body: bytes) -> None:
    s3 = FakeS3()
    s3.objects[STATE_KEY] = {'Body': body, 'Metadata': {}}

    with pytest.raises(sbk.BackupError, match='state object is malformed'):
        sbk.read_state(s3, BUCKET)


def test_state_read_error_other_than_missing_propagates() -> None:
    s3 = FakeS3()
    error = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')

    def denied(**_kwargs):
        raise error

    s3.get_object = denied  # type: ignore[method-assign]

    with pytest.raises(ClientError) as raised:
        sbk.read_state(s3, BUCKET)

    assert raised.value is error


def test_plan_missing_and_gained_days(make_conn) -> None:
    # D2 gained a row (id 5) after the high-water mark, D3 has no object, and
    # today's rows (7, 8) are never planned.
    conn = make_conn(three_days()[:-1] + day_rows(D3, [6]) + day_rows(TODAY, [7, 8]))
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 2)
    sbk.write_state(s3, BUCKET, 4)

    plan = sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert plan.due == [D2, D3]
    assert plan.missing == [D3]
    assert plan.stale == [D2]
    assert plan.high_water_id == 8
    assert plan.db_days == [D1, D2, D3]
    assert plan.object_days == [D1, D2]
    counted = [p for t, p in conn.statements if t.startswith('SELECT count(*)') and p]
    assert counted == [(D2,)]  # one count per delta day that has an object
    assert conn.autocommit is False


def test_plan_verify_counts_finds_out_of_order_rows(make_conn) -> None:
    # Nothing is past the high-water mark, but D2's object holds 2 of its 3 rows.
    conn = make_conn(three_days()[:5])
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 2)
    sbk.write_state(s3, BUCKET, 5)

    assert sbk.plan_days(conn, s3, BUCKET, TODAY).due == []
    plan = sbk.plan_days(conn, s3, BUCKET, TODAY, verify_counts=True)

    assert plan.due == [D2]
    assert plan.stale == [D2]
    assert plan.high_water_id == 5


def test_plan_without_state_checks_every_day(make_conn) -> None:
    conn = make_conn(three_days())
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 2)

    plan = sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert plan.due == [D2, D3]
    counted = [p for t, p in conn.statements if t.startswith('SELECT count(*)') and p]
    assert counted == [(D1,), (D2,)]
    assert not any('id > %s' in t for t, _ in conn.statements)


def test_plan_ignores_objects_for_days_the_table_no_longer_has(make_conn) -> None:
    conn = make_conn(day_rows(D1, [1, 2]))
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(date(2025, 1, 6), 4)

    plan = sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert plan.due == []
    assert plan.object_days == [date(2025, 1, 6), D1]


@pytest.mark.parametrize(
    ('field', 'value'),
    [
        pytest.param('format', None, id='format-missing'),
        pytest.param('format', '0', id='format-is-old'),
        pytest.param('rows', None, id='rows-missing'),
        pytest.param('rows', '', id='rows-empty'),
        pytest.param('rows', 'three', id='rows-not-a-number'),
        pytest.param('rows', '-3', id='rows-negative'),
        pytest.param('rows', ' 3', id='rows-padded'),
        pytest.param('rows', '٣', id='rows-not-ascii'),
    ],
)
def test_plan_distrusts_an_object_it_cannot_read(make_conn, field: str, value) -> None:
    # D2's object is current but for one field. Nothing is past the high-water
    # mark, so no count is taken: the object has to give itself away.
    conn = make_conn(three_days())
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 3)
    s3.put_day(D3, 1)
    metadata = s3.objects[key(D2)]['Metadata']
    if value is None:
        del metadata[field]
    else:
        metadata[field] = value
    sbk.write_state(s3, BUCKET, 6)

    plan = sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert plan.due == [D2] and plan.stale == [D2] and plan.missing == []
    assert not any(t.startswith('SELECT count(*)') and p for t, p in conn.statements)

    # Counting every day does not spend a count on it either: the object has
    # already given itself away.
    every_day = make_conn(three_days())
    plan = sbk.plan_days(every_day, s3, BUCKET, TODAY, verify_counts=True)

    assert plan.due == [D2]
    counted = [p for t, p in every_day.statements if t.startswith('SELECT count(*)') and p]
    assert counted == [(D1,), (D3,)]


def test_plan_says_how_it_counted(make_conn) -> None:
    conn = make_conn(three_days())
    s3 = FakeS3()

    assert sbk.plan_days(conn, s3, BUCKET, TODAY).scope == (
        'every day: no stored high-water mark'
    )
    sbk.write_state(s3, BUCKET, 6)
    assert sbk.plan_days(conn, s3, BUCKET, TODAY).scope == 'delta'
    assert any('id > %s' in t for t, _ in conn.statements)

    # Asked to count every day, it never runs the delta query, though a stored
    # mark is there for it.
    every_day = make_conn(three_days())
    plan = sbk.plan_days(every_day, s3, BUCKET, TODAY, verify_counts=True)

    assert plan.scope == 'every day: --verify-counts'
    assert not any('id > %s' in t for t, _ in every_day.statements)


def test_plan_counts_every_day_when_the_stored_mark_is_above_max_id(make_conn) -> None:
    # After a point-in-time restore or a sequence reset the mark can be ahead of
    # every id in the table. The delta would find nothing and say all is well.
    conn = make_conn(three_days())
    s3 = FakeS3()
    s3.put_day(D1, 1)  # stale, with no rows past any mark
    s3.put_day(D2, 3)
    s3.put_day(D3, 1)
    sbk.write_state(s3, BUCKET, 1000)

    plan = sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert plan.scope == 'every day: the stored mark is above max(id)'
    assert not any('id > %s' in t for t, _ in conn.statements)
    assert plan.due == [D1]
    assert plan.high_water_id == 6


def test_a_stored_mark_equal_to_max_id_uses_the_delta(make_conn) -> None:
    conn = make_conn(three_days())
    s3 = FakeS3()
    sbk.write_state(s3, BUCKET, 6)

    assert sbk.plan_days(conn, s3, BUCKET, TODAY).scope == 'delta'


def test_delta_limit_is_five_million_ids() -> None:
    # Measured on prod: about 5.6 s per 1M ids (date is not in the pkey, so each
    # id costs a heap fetch), and about 10M ids passes the 60 s timeout.
    assert sbk.DELTA_MAX_IDS == 5_000_000


@pytest.mark.parametrize(
    ('top_id', 'uses_delta'),
    [
        pytest.param(5_000_002, True, id='at-the-limit'),
        pytest.param(5_000_003, False, id='one-over'),
    ],
)
def test_plan_counts_every_day_when_the_delta_is_too_wide(
    make_conn, top_id: int, uses_delta: bool
) -> None:
    # The stored mark is 2, so the ids since then span top_id - 2. D1 is stale
    # but has no new rows: only counting every day can find it.
    conn = make_conn(day_rows(D1, [1, 2]) + day_rows(D2, [3, top_id]))
    s3 = FakeS3()
    s3.put_day(D1, 1)
    s3.put_day(D2, 2)
    sbk.write_state(s3, BUCKET, 2)

    plan = sbk.plan_days(conn, s3, BUCKET, TODAY)

    counted = [p[0] for t, p in conn.statements if t.startswith('SELECT count(*)') and p]
    assert any('id > %s' in t for t, _ in conn.statements) is uses_delta
    assert counted == ([D2] if uses_delta else [D1, D2])
    assert plan.due == ([] if uses_delta else [D1])
    assert plan.scope == (
        'delta' if uses_delta else 'every day: ids moved more than 5000000 since the stored mark'
    )


def test_plan_of_an_empty_table(make_conn) -> None:
    plan = sbk.plan_days(make_conn([]), FakeS3(), BUCKET, TODAY)

    assert plan.due == [] and plan.high_water_id == 0 and plan.db_days == []


def test_plan_reads_in_one_snapshot(make_conn) -> None:
    conn = make_conn(three_days())
    s3 = FakeS3()
    sbk.write_state(s3, BUCKET, 3)

    sbk.plan_days(conn, s3, BUCKET, TODAY)

    texts = [text for text, _ in conn.statements]
    assert texts[0] == 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    assert texts[-1] == 'ROLLBACK'
    assert sum(t.startswith('BEGIN') for t in texts) == 1
    assert texts[2] == 'SELECT count(*) FROM strike_exposures WHERE expiry IS NULL'
    assert conn.autocommit is False


def test_plan_refuses_a_table_with_null_expiry(make_conn) -> None:
    conn = make_conn(three_days(), null_expiry=2)

    with pytest.raises(sbk.BackupError, match='2 row.* NULL expiry'):
        sbk.plan_days(conn, FakeS3(), BUCKET, TODAY)

    assert [text for text, _ in conn.statements][-2:] == [
        'SELECT count(*) FROM strike_exposures WHERE expiry IS NULL',
        'ROLLBACK',
    ]


@pytest.mark.parametrize('event', ['null_expiry', 'days', 'max_id', 'delta', 'count'])
def test_plan_database_error_propagates_after_a_rollback(make_conn, event: str) -> None:
    error = psycopg2.OperationalError('injected')
    conn = make_conn(three_days(), fail_on={event: error})
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 2)
    sbk.write_state(s3, BUCKET, 2)

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert raised.value is error
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_export_resumes(cli) -> None:
    # D1 is already in R2 with its 2 rows; D2 and D3 are not.
    s3 = FakeS3()
    s3.put_day(D1, 2)
    first = FakeConnection(three_days())

    code, out = cli.run(first, s3, 'export')

    assert code == 0
    assert s3.keys('upload') == [key(D2), key(D3)]
    assert s3.state()['high_water_id'] == 6
    assert '2026-11-03: 3 rows' in out and '2026-11-04: 1 rows' in out
    assert 'counting: every day: no stored high-water mark' in out
    for secret in (DSN_SECRET, R2_SECRET, 'ACCESS-KEY-MARKER'):
        assert secret not in out

    second = FakeConnection(three_days())
    code, out = cli.run(second, s3, 'export')

    assert code == 0
    assert 'counting: delta' in out
    assert s3.keys('upload') == [key(D2), key(D3)]  # nothing new
    assert not any('SELECT "id"' in t for t, _ in second.statements)


def test_export_failure_exit_1_no_state(cli) -> None:
    s3 = FakeS3()
    s3.upload_errors[key(D2)] = S3UploadFailedError(
        f'Failed to upload /tmp/x to {BUCKET}/{key(D2)}: SlowDown'
    )

    code, out = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 1
    assert s3.keys('upload') == [key(D1), key(D2), key(D3)]  # D3 ran after D2 failed
    assert sorted(k for k in s3.objects if k.endswith('.parquet')) == [key(D1), key(D3)]
    assert s3.state() is None
    assert '2026-11-03' in out and 'S3UploadFailedError' in out
    assert BUCKET not in out  # the class name only, not the error text
    # Each day's file is gone before the next day's upload, the failed one too.
    assert s3.files_seen == [
        ['2026-11-02.parquet'],
        ['2026-11-03.parquet'],
        ['2026-11-04.parquet'],
    ]

    s3.upload_errors.clear()
    code, _ = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 0
    assert s3.keys('upload')[3:] == [key(D2)]  # the next run redoes only D2
    assert s3.state() is not None


def test_truncated_upload_exits_1_and_the_next_run_redoes_the_day(cli) -> None:
    s3 = FakeS3()
    s3.short_by[key(D2)] = 1

    code, out = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 1
    assert key(D2) not in s3.objects  # deleted, so it does not count as exported
    assert s3.state() is None
    assert '2026-11-03' in out

    s3.short_by.clear()
    code, _ = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 0
    assert s3.keys('upload')[3:] == [key(D2)]
    assert s3.state() is not None


def test_database_error_on_a_live_connection_fails_the_day_and_goes_on(cli) -> None:
    s3 = FakeS3()
    conn = FakeConnection(
        three_days(), fail_on={'page2': psycopg2.errors.QueryCanceled('injected')}
    )

    code, out = cli.run(conn, s3, 'export')

    assert code == 1
    assert s3.keys('upload') == [key(D1), key(D3)]
    assert s3.state() is None
    assert '2026-11-03' in out and 'QueryCanceled' in out


def test_an_os_error_on_one_day_fails_that_day_and_goes_on(cli, monkeypatch) -> None:
    real_stat = Path.stat

    def stat_fails_on_d2(self: Path, *args, **kwargs):
        if self.name == '2026-11-03.parquet':
            raise OSError('disk')
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, 'stat', stat_fails_on_d2)
    s3 = FakeS3()

    code, out = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 1
    assert s3.keys('upload') == [key(D1), key(D3)]
    assert s3.state() is None
    assert 'FAILED 2026-11-03: OSError' in out
    assert 'disk' not in out  # the class name only


def test_dropped_connection_stops_the_run(cli) -> None:
    s3 = FakeS3()
    error = psycopg2.OperationalError('server closed the connection unexpectedly')
    conn = FakeConnection(three_days(), fail_on={'page2': error}, closes_on='page2')

    code, out = cli.run(conn, s3, 'export')

    assert code == 1
    assert s3.keys('upload') == [key(D1)]
    assert len(conn.page_queries) == 2
    assert s3.state() is None
    assert 'connection lost' in out
    assert '2026-11-03' in out
    assert '2026-11-04' not in out  # D3 was never tried, so it is not a failure too

    code, _ = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 0  # a re-run resumes with D2 and D3
    assert s3.keys('upload') == [key(D1), key(D2), key(D3)]


def test_planning_failure_exits_1(cli) -> None:
    s3 = FakeS3()
    conn = FakeConnection(three_days(), fail_on={'days': psycopg2.OperationalError('x')})

    code, out = cli.run(conn, s3, 'export')

    assert code == 1
    assert s3.keys('upload') == [] and s3.state() is None
    assert 'planning' in out and 'OperationalError' in out


def test_state_write_failure_exits_1(cli) -> None:
    s3 = FakeS3()
    s3.put_error = ClientError({'Error': {'Code': 'AccessDenied'}}, 'PutObject')

    code, out = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 1
    assert s3.keys('upload') == [key(D1), key(D2), key(D3)]
    assert 'FAILED state: ClientError' in out
    assert s3.state() is None


def test_r2_listing_failure_fails_the_plan(cli) -> None:
    s3 = FakeS3()
    s3.list_error = ClientError({'Error': {'Code': 'AccessDenied'}}, 'ListObjectsV2')

    code, out = cli.run(FakeConnection(three_days()), s3, 'export')

    assert code == 1
    assert 'FAILED planning: ClientError' in out
    assert s3.keys('upload') == [] and s3.keys('put') == []


@pytest.mark.parametrize(
    'argv',
    [
        pytest.param(['export', '--limit-days', '0'], id='limit-is-zero'),
        pytest.param(['export', '--limit-days', 'many'], id='limit-is-not-a-number'),
        pytest.param(['export', '--date', 'yesterday'], id='date-is-not-a-date'),
        pytest.param([], id='no-command'),
        pytest.param(['frobnicate'], id='unknown-command'),
    ],
)
def test_bad_arguments_exit_2_before_touching_anything(cli, argv: list[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.run(FakeConnection(three_days()), FakeS3(), *argv)

    assert raised.value.code == 2
    assert cli.connects == [] and cli.clients == []


def test_dry_run_uploads_nothing_and_writes_no_state(cli) -> None:
    s3 = FakeS3()

    code, out = cli.run(FakeConnection(three_days()), s3, 'export', '--dry-run')

    assert code == 0
    assert s3.keys('upload') == [] and s3.keys('put') == [] and s3.state() is None
    assert out.count('dry run') >= 3 and '2026-11-02: 2 rows' in out


def test_date_forces_one_day_and_keeps_the_state(cli) -> None:
    s3 = FakeS3()
    s3.put_day(D2, 3)  # already exported and current: --date exports it anyway

    code, _ = cli.run(FakeConnection(three_days()), s3, 'export', '--date', '2026-11-03')

    assert code == 0
    assert s3.keys('upload') == [key(D2)]
    assert s3.state() is None  # a one-day run says nothing about the other days


def test_date_run_keeps_the_state_even_when_that_day_is_all_that_was_due(cli) -> None:
    # D1 and D2 are current in R2, so D3 is the only due day and --date D3
    # does everything that was due. It must still not move the mark: the flag
    # means "just this day", and a run that was told so proves nothing else.
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 3)

    code, out = cli.run(FakeConnection(three_days()), s3, 'export', '--date', '2026-11-04')

    assert code == 0
    assert s3.keys('upload') == [key(D3)]
    assert '1 day(s) due; exporting 1' in out
    assert s3.state() is None


def test_limit_days_is_a_partial_run(cli) -> None:
    s3 = FakeS3()

    code, out = cli.run(FakeConnection(three_days()), s3, 'export', '--limit-days', '2')

    assert code == 0
    assert s3.keys('upload') == [key(D1), key(D2)]
    assert s3.state() is None
    assert 'partial' in out

    code, _ = cli.run(FakeConnection(three_days()), s3, 'export', '--limit-days', '5')

    assert code == 0
    assert s3.keys('upload')[2:] == [key(D3)]
    assert s3.state() is not None  # the limit covered everything that was due


def test_verify_counts_flag_reaches_the_plan(cli) -> None:
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 2)  # D2 holds 3 rows now
    s3.put_day(D3, 1)
    sbk.write_state(s3, BUCKET, 6)

    quiet, _ = cli.run(FakeConnection(three_days()), s3, 'export')
    assert quiet == 0 and s3.keys('upload') == []

    code, _ = cli.run(FakeConnection(three_days()), s3, 'export', '--verify-counts')

    assert code == 0
    assert s3.keys('upload') == [key(D2)]


def test_a_day_with_no_rows_is_skipped(cli) -> None:
    s3 = FakeS3()

    code, out = cli.run(FakeConnection(three_days()), s3, 'export', '--date', '2026-11-05')

    assert code == 0
    assert s3.keys('upload') == []
    assert 'no rows' in out


def test_date_not_before_today_is_refused(cli) -> None:
    code, out = cli.run(FakeConnection(three_days()), FakeS3(), 'export', '--date', '2026-11-06')

    assert code == 2
    assert 'before today' in out
    assert cli.connects == []


def test_missing_env_exits_2_naming_only_the_variable(cli, monkeypatch) -> None:
    monkeypatch.delenv('R2_BUCKET_FULLTAPE')

    code, out = cli.run(FakeConnection(three_days()), FakeS3(), 'export')

    assert code == 2
    assert 'R2_BUCKET_FULLTAPE' in out
    assert DSN_SECRET not in out and R2_SECRET not in out
    assert cli.connects == [] and cli.clients == []


def test_a_bad_r2_endpoint_exits_2_without_showing_it(cli) -> None:
    # botocore raises ValueError('Invalid endpoint: <url>'), and the URL holds
    # the account id.
    error = ValueError(f'Invalid endpoint: {ENV["R2_ENDPOINT_URL"]}')

    code, out = cli.run(FakeConnection(three_days()), error, 'export')

    assert code == 2
    assert 'FAILED R2 client: ValueError' in out
    assert 'acct-marker' not in out
    assert cli.connects == []  # nothing else was opened


def test_main_builds_its_clients_from_the_environment(cli) -> None:
    cli.run(FakeConnection([]), FakeS3(), 'status')

    (dsn,), connect_kwargs = cli.connects[0]
    assert dsn == ENV['DATABASE_URL']
    assert connect_kwargs['application_name'] == 'strike-exposures-backup'
    assert cli.clients[0][0] == ('s3',)
    client_kwargs = cli.clients[0][1]
    assert client_kwargs['endpoint_url'] == ENV['R2_ENDPOINT_URL']
    assert client_kwargs['aws_access_key_id'] == ENV['R2_ACCESS_KEY_ID']
    assert client_kwargs['aws_secret_access_key'] == R2_SECRET
    assert client_kwargs['region_name'] == 'auto'
    assert client_kwargs['verify'] is True
    # Nightly's R2Store settings, which are known to work against R2.
    config = client_kwargs['config']
    assert config.signature_version == 's3v4'
    assert config.retries == {'mode': 'standard', 'max_attempts': 5}


def test_database_connect_failure_hides_the_dsn(cli) -> None:
    error = psycopg2.ProgrammingError(f'could not connect to {ENV["DATABASE_URL"]}')

    code, out = cli.run(error, FakeS3(), 'export')

    assert code == 1
    assert 'ProgrammingError' in out
    assert DSN_SECRET not in out and 'ep-marker' not in out


def test_status_output(cli) -> None:
    rows = three_days() + day_rows(TODAY, [7, 8])
    s3 = FakeS3()
    s3.put_day(D1, 2)
    s3.put_day(D2, 2)  # D2 holds 3 rows
    s3.put_day(date(2026, 11, 9), 1)  # a future day in R2 is not a database day
    sbk.write_state(s3, BUCKET, 8)  # nothing is past the mark: only a full count sees D2

    conn = FakeConnection(rows)

    code, out = cli.run(conn, s3, 'status')

    assert code == 0
    assert 'database days: 3 (2026-11-02 to 2026-11-04)' in out
    assert 'exported days: 3' in out
    assert 'missing: 1 (2026-11-04)' in out
    assert 'stale: 1 (2026-11-03)' in out
    assert 'high-water id: 8' in out
    # The user passed no flag: status says what it does, in its own words.
    assert 'counting: every day (status)' in out
    assert '--verify-counts' not in out
    assert not any('id > %s' in t for t, _ in conn.statements)  # never the delta
    for secret in (DSN_SECRET, R2_SECRET, 'ACCESS-KEY-MARKER', 'ep-marker'):
        assert secret not in out
    assert s3.keys('upload') == []
    assert s3.keys('put') == [STATE_KEY]  # only the setup's; status wrote nothing
    assert s3.state()['high_water_id'] == 8


def test_status_failure_exits_1(cli) -> None:
    conn = FakeConnection(three_days(), fail_on={'days': psycopg2.OperationalError('x')})

    code, out = cli.run(conn, FakeS3(), 'status')

    assert code == 1
    assert 'FAILED status: OperationalError' in out


def test_status_of_a_complete_backup(cli) -> None:
    s3 = FakeS3()
    for day, rows in ((D1, 2), (D2, 3), (D3, 1)):
        s3.put_day(day, rows)

    code, out = cli.run(FakeConnection(three_days()), s3, 'status')

    assert code == 0
    assert 'missing: 0\n' in out and 'stale: 0\n' in out
