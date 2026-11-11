"""Tests for scripts/strike_exposures_backup.py (day reader and Parquet writer).

Run:

    ml/.venv/Scripts/pytest scripts/test_strike_exposures_backup.py -q

No test reaches a database. The connection and cursor are fakes that hold a
list of rows and serve count and keyset pages from it, reading the same
parameters the module sends, so a page query that forgets its key or its LIMIT
shows up as wrong data and not just as a wrong string. The fake also enforces
the transaction rules the module relies on: a BEGIN needs autocommit on and no
open transaction, every `%s` needs a parameter, and a test that leaves the
transaction open fails at teardown. `fail_on` makes one statement raise.
"""

from __future__ import annotations

import hashlib
import sys
import traceback
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import psycopg2
import psycopg2.errors
import pyarrow.parquet as pq
import pytest
from psycopg2.extensions import TRANSACTION_STATUS_IDLE, TRANSACTION_STATUS_INTRANS

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


def plain_rows(n: int) -> list[tuple]:
    """n ordinary rows with distinct timestamps and ids that do not follow key order.

    The timestamps carry microseconds, so a continuation key that rounds or
    truncates one re-reads the row before it.
    """
    start = datetime(2026, 11, 2, 15, 0, tzinfo=UTC)
    return [
        make_row(
            id=100 - i,
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
        text = ' '.join(sql.split())
        assert text.count('%s') == len(params or ()), text
        conn.statements.append((text, params))
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
        elif text.startswith('SELECT count(*)'):
            conn.fail('count')
            self._result = [(conn.count,)]
        elif text.startswith('SELECT ') and 'LIMIT %s' in text:
            conn.fail(f'page{len(conn.page_queries)}')
            self._result = conn.serve_page(params, keyed='> (%s' in text)
        else:
            self._result = []

    def fetchone(self) -> tuple:
        return self._result[0]

    def fetchall(self) -> list[tuple]:
        return self._result


class FakeConnection:
    """A psycopg2 connection over a list of rows.

    `count` is what the snapshot count query says; it defaults to the number
    of rows. `stuck` makes every page the first page again, as a keyset that
    never advances would, and gives up after 10 page queries so a missing
    guard fails instead of hanging. `fail_on` maps an event ('count', 'page1',
    'page2', ..., 'rollback') to the exception its statement raises.
    """

    def __init__(
        self,
        rows: list[tuple],
        count: int | None = None,
        stuck: bool = False,
        fail_on: dict[str, Exception] | None = None,
        autocommit: bool = False,
    ) -> None:
        self.rows = sorted(rows, key=key_of)
        self.count = len(rows) if count is None else count
        self.stuck = stuck
        self.fail_on = fail_on or {}
        self.autocommit = autocommit
        self.in_txn = False
        self.statements: list[tuple[str, tuple | None]] = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    @property
    def info(self) -> SimpleNamespace:
        status = TRANSACTION_STATUS_INTRANS if self.in_txn else TRANSACTION_STATUS_IDLE
        return SimpleNamespace(transaction_status=status)

    @property
    def page_queries(self) -> list[tuple[str, tuple]]:
        return [(t, p) for t, p in self.statements if 'LIMIT %s' in t]

    def fail(self, event: str) -> None:
        if event in self.fail_on:
            raise self.fail_on[event]

    def serve_page(self, params: tuple, keyed: bool) -> list[tuple]:
        assert len(self.page_queries) <= 10, 'paging did not stop'
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


def test_dayfile_fields(make_conn, tmp_path: Path) -> None:
    # Ids 100, 99, 98 in key order, in pages of 2: the max is on the first page
    # and the min on the second, so both bounds must span pages.
    conn = make_conn(plain_rows(3))

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

    with pytest.raises(sbk.BackupError, match='already inside a transaction'):
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
