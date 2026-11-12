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
# Run at the top of every iter_day_pages call. Without them the planner takes
# the timestamp index for the day's last page and runs into the 60 s timeout.
# The underscore in enable_incremental_sort matters: enable_incrementalsort is
# an unrecognized parameter.
NO_SORT_STATEMENTS = [
    'SET LOCAL enable_sort = off',
    'SET LOCAL enable_incremental_sort = off',
]
# A restore dry run asks, for the rows the table lacks, which ids other rows hold.
TAKEN_IDS_SQL = 'SELECT id FROM strike_exposures WHERE id = ANY(%s)'
# Text a database error carries that no log may show: the DETAIL line of a
# unique violation quotes the offending key.
DETAIL_MARKER = 'KEY-VALUE-IN-THE-DETAIL-LINE'


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
        self.rowcount = -1
        self._result: list[tuple] = []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def execute(self, sql, params: tuple | None = None) -> None:
        conn = self.conn
        if conn.closed:
            raise psycopg2.InterfaceError('cursor already closed')
        # A psycopg2.sql object is rendered; a plain string is used as it is.
        raw = sql if isinstance(sql, str) else sql.as_string(None)
        text = ' '.join(raw.split())
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
            conn.rows_at_begin = list(conn.rows)
            conn.local_settings = {}
        elif text == 'COMMIT':
            conn.in_txn = False
            written = conn.rows_at_begin
            conn.rows_at_begin = None
            conn.local_settings = {}  # SET LOCAL ends with the transaction
            try:
                conn.fail('commit')
            except Exception:
                if not conn.closed and written is not None:
                    conn.rows = written  # a COMMIT that fails on a live link rolled back
                raise  # on a dropped link the writes stand: committed, acknowledgement lost
        elif text == 'ROLLBACK':
            # A ROLLBACK that fails leaves a dead connection, not an open transaction.
            conn.in_txn = False
            conn.local_settings = {}
            if conn.rows_at_begin is not None:
                conn.rows = conn.rows_at_begin  # the transaction's writes are undone
                conn.rows_at_begin = None
            conn.fail('rollback')
        elif text.startswith('INSERT INTO strike_exposures'):
            conn.fail(f'insert{len(conn.inserts)}')
            self.rowcount = conn.apply_insert(params)
        elif text == 'LOCK TABLE strike_exposures IN SHARE ROW EXCLUSIVE MODE':
            conn.fail('lock')
        elif text == "SELECT pg_get_serial_sequence('strike_exposures', 'id')":
            conn.fail('seq_name')
            self._result = [(conn.sequence_name,)]
        elif text.startswith('SELECT last_value, is_called FROM '):
            conn.fail('seq_value')
            assert text == f'SELECT last_value, is_called FROM {conn.sequence_name}', text
            self._result = [(conn.sequence_value, conn.sequence_is_called)]
        elif text == 'SELECT setval(%s, GREATEST((SELECT max(id) FROM strike_exposures), %s))':
            conn.fail('setval')
            assert params[0] == conn.sequence_name
            conn.sequence_value = max(conn.max_id() or 0, params[1])
            conn.sequence_is_called = True  # setval(name, value) is_called defaults to true
            self._result = [(conn.sequence_value,)]
        elif text == 'SELECT count(*) FROM strike_exposures WHERE expiry IS NULL':
            conn.fail('null_expiry')
            self._result = [(conn.null_expiry,)]
        elif text == 'SELECT count(*) FROM strike_exposures WHERE date = %s':
            conn.fail('count')
            self._result = [(conn.count_for(params[0]),)]
        elif text == TAKEN_IDS_SQL:
            conn.fail('taken_ids')
            wanted = set(params[0])
            self._result = [(r[0],) for r in conn.rows if r[0] in wanted]
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
            # The planner flips to a timestamp-index scan on the day's last page
            # unless both sorts are off for the transaction (see iter_day_pages).
            assert conn.local_settings.get('enable_sort') == 'off', 'enable_sort is on'
            assert (
                conn.local_settings.get('enable_incremental_sort') == 'off'
            ), 'enable_incremental_sort is on'
            conn.fail(f'page{len(conn.page_queries)}')
            self._result = conn.serve_page(params, keyed='> (%s' in text)
        elif text.startswith('SET LOCAL '):
            name, _, value = text.removeprefix('SET LOCAL ').partition(' = ')
            assert name in (
                'statement_timeout',
                'enable_sort',
                'enable_incremental_sort',
            ), f'unrecognized configuration parameter: {name}'
            conn.local_settings[name] = value.strip("'")
            self._result = []
        else:
            raise AssertionError(f'unexpected: {text}')

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

    The restore side: an INSERT adds the rows whose unique key is not there yet
    (ON CONFLICT DO NOTHING) and raises UniqueViolation for a new key whose id
    is taken, `rowcount` says how many went in, and ROLLBACK undoes a
    transaction's inserts. The events 'insert1', 'insert2', ..., 'lock',
    'seq_name', 'seq_value', 'setval', 'taken_ids' (the restore dry run's id
    lookup) and 'commit' can fail. A COMMIT that fails on a live connection
    undoes the transaction's inserts; one that kills the connection leaves them
    in, the worst case for a caller (committed, acknowledgement lost).
    `sequence_name`, `sequence_value` and `sequence_is_called` are what
    pg_get_serial_sequence and the sequence say: with is_called false the next
    nextval returns last_value itself. The sequence starts far ahead of every
    id a test uses, so a restore test about something else does not also meet a
    sequence that is behind the file; the tests about that set it.
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
        sequence_name: str | None = 'public.strike_exposures_id_seq',
        sequence_value: int | None = 1_000_000,
        sequence_is_called: bool = True,
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
        self.sequence_name = sequence_name
        self.sequence_value = sequence_value
        self.sequence_is_called = sequence_is_called
        self.rows_at_begin: list[tuple] | None = None
        self.local_settings: dict[str, str] = {}  # SET LOCAL values, until the transaction ends

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

    @property
    def inserts(self) -> list[tuple[str, tuple]]:
        return [(t, p) for t, p in self.statements if t.startswith('INSERT INTO')]

    def apply_insert(self, params: tuple) -> int:
        """INSERT ... ON CONFLICT (unique key) DO NOTHING; return the rowcount."""
        width = len(sbk.COLUMNS)
        incoming = [tuple(params[i : i + width]) for i in range(0, len(params), width)]
        index = {name: sbk.COLUMNS.index(name) for name in ('id', 'date')}

        def unique_key(row: tuple) -> tuple:
            return (row[index['date']], *key_of(row))

        keys = {unique_key(r) for r in self.rows}
        ids = {r[index['id']] for r in self.rows}
        inserted = 0
        for row in incoming:
            if unique_key(row) in keys:
                continue  # the conflict target: skipped, not an error
            if row[index['id']] in ids:
                raise psycopg2.errors.UniqueViolation(
                    'duplicate key value violates unique constraint "strike_exposures_pkey"'
                    f'\nDETAIL:  Key (id)=({row[index["id"]]}) already exists. {DETAIL_MARKER}'
                )
            keys.add(unique_key(row))
            ids.add(row[index['id']])
            self.rows.append(row)
            inserted += 1
        self.rows.sort(key=key_of)
        return inserted

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
    assert texts[3:5] == NO_SORT_STATEMENTS
    assert texts[-1] == 'ROLLBACK'

    pages = conn.page_queries
    assert len(pages) == 3  # 2 + 2 + 1: the short page ends the day without a 4th query
    assert len(conn.statements) == 5 + len(pages) + 1
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


def test_every_iter_day_pages_call_turns_the_sorts_off_before_its_first_page(make_conn) -> None:
    # On 2026-10-02 (3.5M rows) the planner switched pages after the first to
    # a timestamp-index scan with an incremental sort, and the day's last page
    # then walked every later timestamp in the table until the timeout. With
    # both sorts off it keeps the unique index.
    conn = make_conn(plain_rows(5))

    with sbk._read_snapshot(conn) as cur:
        assert len(list(sbk.iter_day_pages(cur, DAY, 2))) == 3
        assert len(list(sbk.iter_day_pages(cur, DAY, 2))) == 3

    texts = [text for text, _ in conn.statements]
    assert texts[2:4] == NO_SORT_STATEMENTS
    assert all(t.startswith('SELECT') for t in texts[4:7])
    assert texts[7:9] == NO_SORT_STATEMENTS  # again for the second call
    assert all(t.startswith('SELECT') for t in texts[9:12])
    assert texts[12] == 'ROLLBACK'


def test_verify_and_a_restore_dry_run_read_their_pages_with_the_sorts_off(
    make_conn, tmp_path: Path
) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)

    for read in (
        lambda conn: sbk.verify_day(conn, s3, BUCKET, D1),
        lambda conn: sbk.restore_day(conn, s3, BUCKET, D1, apply=False),
    ):
        conn = make_conn(rows)
        read(conn)
        texts = [text for text, _ in conn.statements]
        assert texts[2:4] == NO_SORT_STATEMENTS
        assert texts[4].startswith('SELECT')


def test_the_planning_reads_leave_the_planner_alone(make_conn) -> None:
    conn = make_conn(three_days())
    s3 = FakeS3()
    sbk.write_state(s3, BUCKET, 3)

    sbk.plan_days(conn, s3, BUCKET, TODAY)

    assert not any('enable_' in text for text, _ in conn.statements)


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
        obj = self.objects[Key]
        return {'Body': io.BytesIO(obj['Body']), 'Metadata': dict(obj['Metadata'])}

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


# ── Task 3: verify and restore ───────────────────────────────────────────────

SEQUENCE = 'audit."Id Seq"'  # not the table's real sequence name: it must be looked up


def grouped_rows(day: date = D1, first_id: int = 1) -> list[tuple]:
    """18 rows: 3 timestamps, each with 3 tickers and 2 strikes, so a timestamp
    holds 6 rows and a small page boundary falls inside one."""
    start = datetime(day.year, day.month, day.day, 15, 0, tzinfo=UTC)
    rows = []
    row_id = first_id
    for minute in range(3):
        for ticker in ('NDX', 'SPX', 'SPXW'):
            for strike in ('5500.00', '5505.00'):
                rows.append(
                    make_row(
                        id=row_id,
                        date=day,
                        expiry=day,
                        ticker=ticker,
                        strike=Decimal(strike),
                        timestamp=start + timedelta(minutes=minute, microseconds=123457),
                    )
                )
                row_id += 1
    return rows


def back_up(s3: FakeS3, rows: list[tuple], tmp_path: Path, day: date = D1) -> sbk.DayFile:
    """Export `rows` the way the tool does and upload them, to a fake R2."""
    out_dir = tmp_path / 'export'
    out_dir.mkdir(exist_ok=True)
    result = sbk.write_day_parquet(FakeConnection(rows), day, out_dir)
    assert result is not None
    sbk.upload_day(s3, BUCKET, result)
    return result


def changed(row: tuple, **overrides) -> tuple:
    """`row` with some columns replaced."""
    values = dict(zip(sbk.COLUMNS, row))
    values.update(overrides)
    return tuple(values[name] for name in sbk.COLUMNS)


def test_verify_identical_day_ok(make_conn, tmp_path: Path) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows)

    result = sbk.verify_day(conn, s3, BUCKET, D1, page_rows=4)

    assert result == sbk.VerifyResult(D1, 18, 18, 0, 0, 0)
    assert result.ok
    assert len(conn.page_queries) == 5  # 4 + 4 + 4 + 4 + 2: pages cut a timestamp's rows
    assert conn.statements[0][0] == 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_verify_counts_each_difference(make_conn, tmp_path: Path) -> None:
    rows = grouped_rows()
    missing_from_file = rows[2]
    extra_in_file = make_row(
        id=500, date=D1, expiry=D1, ticker='ZZZ', timestamp=rows[8][2]
    )  # in the second timestamp's group
    in_file = [r for r in rows if r != missing_from_file]
    in_file[10] = changed(in_file[10], call_gamma_oi=Decimal('9.9999'))
    s3 = FakeS3()
    back_up(s3, in_file + [extra_in_file], tmp_path)

    result = sbk.verify_day(make_conn(rows), s3, BUCKET, D1, page_rows=4)

    assert (result.only_in_db, result.only_in_file, result.value_diffs) == (1, 1, 1)
    # The two sides hold 18 rows each, and the day is still not ok.
    assert (result.db_rows, result.file_rows) == (18, 18)
    assert not result.ok


@pytest.mark.parametrize(
    ('column', 'value'),
    [
        pytest.param('id', 999, id='id'),
        pytest.param('price', None, id='null-price'),
        pytest.param('created_at', datetime(2026, 11, 2, 22, 31, tzinfo=UTC), id='created-at'),
        pytest.param('put_vanna_oi', Decimal('-0.0001'), id='greek'),
    ],
)
def test_verify_sees_a_change_in_any_column(
    make_conn, tmp_path: Path, column: str, value
) -> None:
    rows = grouped_rows()
    in_file = list(rows)
    in_file[7] = changed(in_file[7], **{column: value})
    s3 = FakeS3()
    back_up(s3, in_file, tmp_path)

    result = sbk.verify_day(make_conn(rows), s3, BUCKET, D1)

    assert (result.only_in_db, result.only_in_file, result.value_diffs) == (0, 0, 1)
    # Both sides hold 18 rows and every row is paired: a changed value alone
    # must make the day not ok.
    assert (result.db_rows, result.file_rows) == (18, 18)
    assert not result.ok


@pytest.mark.parametrize(
    ('db_rows', 'file_rows', 'only_in_db', 'only_in_file', 'value_diffs', 'ok'),
    [
        pytest.param(5, 5, 0, 0, 0, True, id='nothing-differs'),
        pytest.param(0, 0, 0, 0, 0, True, id='an-empty-day-on-both-sides'),
        pytest.param(5, 4, 0, 0, 0, False, id='fewer-rows-in-the-file'),
        pytest.param(4, 5, 0, 0, 0, False, id='fewer-rows-in-the-database'),
        pytest.param(5, 5, 1, 0, 0, False, id='a-row-only-in-the-database'),
        pytest.param(5, 5, 0, 1, 0, False, id='a-row-only-in-the-file'),
        pytest.param(5, 5, 0, 0, 1, False, id='a-changed-value'),
    ],
)
def test_a_verify_result_is_ok_only_when_every_count_agrees(
    db_rows: int, file_rows: int, only_in_db: int, only_in_file: int, value_diffs: int, ok: bool
) -> None:
    # Each count alone must be able to fail the day: `verify` exits 0 on `ok`.
    result = sbk.VerifyResult(D1, db_rows, file_rows, only_in_db, only_in_file, value_diffs)

    assert result.ok is ok


def test_verify_a_whole_timestamp_missing_on_either_side(make_conn, tmp_path: Path) -> None:
    rows = grouped_rows()
    first_minute = rows[:6]
    last_minute = rows[12:]
    short_file, full_file = FakeS3(), FakeS3()
    back_up(short_file, [r for r in rows if r not in first_minute], tmp_path)
    back_up(full_file, rows, tmp_path)

    only_in_db = sbk.verify_day(make_conn(rows), short_file, BUCKET, D1, page_rows=5)
    only_in_file = sbk.verify_day(
        make_conn([r for r in rows if r not in last_minute]), full_file, BUCKET, D1, page_rows=5
    )

    # Each side's rows are counted in a group the other side lacks, too.
    assert only_in_db == sbk.VerifyResult(D1, 18, 12, 6, 0, 0)
    assert only_in_file == sbk.VerifyResult(D1, 12, 18, 0, 6, 0)
    assert not only_in_db.ok and not only_in_file.ok


def multi_expiry_rows() -> list[tuple]:
    """5 rows in 2 timestamps; the first holds SPXW 5500 at three expiries.

    The expiries are the sentinel 1970-01-01, the day itself and the next day,
    the way SPX carries one strike at several expiries at once. Two rows of the
    first timestamp differ in nothing but their expiry.
    """
    t0 = datetime(2026, 11, 2, 15, 0, tzinfo=UTC)
    t1 = datetime(2026, 11, 2, 15, 1, tzinfo=UTC)
    sentinel, same_day, next_day = date(1970, 1, 1), DAY, date(2026, 11, 3)
    return [
        make_row(id=1, timestamp=t0, ticker='SPXW', expiry=sentinel),
        make_row(id=2, timestamp=t0, ticker='SPXW', expiry=same_day),
        make_row(id=3, timestamp=t0, ticker='SPXW', expiry=next_day),
        make_row(id=4, timestamp=t0, ticker='SPXW', strike=Decimal('5505.00'), expiry=same_day),
        make_row(id=5, timestamp=t1, ticker='SPXW', expiry=same_day),
    ]


def test_verify_pairs_rows_that_differ_only_in_their_expiry(make_conn, tmp_path: Path) -> None:
    rows = multi_expiry_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)

    # Pages of 2 cut the three-expiry group across pages.
    same = sbk.verify_day(make_conn(rows), s3, BUCKET, D1, page_rows=2)

    assert same == sbk.VerifyResult(D1, 5, 5, 0, 0, 0)
    # A change in the sentinel's row is that row's value diff, nothing else.
    in_file = [changed(rows[0], call_gamma_oi=Decimal('9.9999')), *rows[1:]]
    other = FakeS3()
    back_up(other, in_file, tmp_path)

    different = sbk.verify_day(make_conn(rows), other, BUCKET, D1, page_rows=2)

    assert different == sbk.VerifyResult(D1, 5, 5, 0, 0, 1)


def test_verify_counts_an_expiry_the_other_side_lacks(make_conn, tmp_path: Path) -> None:
    rows = multi_expiry_rows()
    # The file has the next-day expiry as the day after that: a different row,
    # not a changed value of the same one.
    in_file = [*rows[:2], changed(rows[2], expiry=date(2026, 11, 4)), *rows[3:]]
    s3 = FakeS3()
    back_up(s3, in_file, tmp_path)

    result = sbk.verify_day(make_conn(rows), s3, BUCKET, D1)

    assert result == sbk.VerifyResult(D1, 5, 5, 1, 1, 0)


def test_restore_dry_run_counts_the_expiry_the_table_lacks(make_conn, tmp_path: Path) -> None:
    rows = multi_expiry_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn([r for r in rows if r != rows[1]])

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False, page_rows=2)

    assert result == sbk.RestoreResult(rows=1, id_clashes=0)


def test_verify_an_empty_database_day(make_conn, tmp_path: Path) -> None:
    s3 = FakeS3()
    back_up(s3, grouped_rows(), tmp_path)

    result = sbk.verify_day(make_conn([]), s3, BUCKET, D1)

    assert (result.db_rows, result.file_rows, result.only_in_file) == (0, 18, 18)


def test_compare_does_not_depend_on_how_tickers_sort_within_a_timestamp() -> None:
    # Postgres orders tickers by its collation and Python by code point. Within
    # one timestamp the two sides may disagree, so rows are matched by key.
    rows = grouped_rows()
    db_pages = [rows[:6], rows[6:12], rows[12:]]
    file_pages = [list(reversed(rows[:6])), rows[6:9] + rows[11:8:-1], rows[12:]]

    counts = sbk._compare_days(iter(db_pages), iter(file_pages))

    assert (counts.db_rows, counts.file_rows) == (18, 18)
    assert (counts.only_in_db, counts.only_in_file, counts.value_diffs) == (0, 0, 0)


def test_compare_refuses_rows_that_are_not_in_timestamp_order() -> None:
    rows = grouped_rows()
    shuffled = rows[6:12] + rows[:6]  # the second minute before the first

    with pytest.raises(sbk.BackupError, match='not in timestamp order'):
        sbk._compare_days(iter([rows]), iter([shuffled]))


def test_compare_refuses_a_repeated_key() -> None:
    rows = grouped_rows()

    with pytest.raises(sbk.BackupError, match='repeats a key'):
        sbk._compare_days(iter([rows]), iter([rows[:3] + rows[:1] + rows[3:]]))


def test_verify_without_an_object_says_so(make_conn) -> None:
    conn = make_conn(grouped_rows())

    with pytest.raises(sbk.BackupError, match='2026-11-02: no object in R2') as raised:
        sbk.verify_day(conn, FakeS3(), BUCKET, D1)

    assert raised.value.__context__ is None
    assert conn.statements == []


def test_an_access_error_is_not_reported_as_a_missing_object(make_conn) -> None:
    s3 = FakeS3()
    error = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')

    def denied(**_kwargs):
        raise error

    s3.get_object = denied  # type: ignore[method-assign]

    with pytest.raises(ClientError) as raised:
        sbk.verify_day(make_conn(grouped_rows()), s3, BUCKET, D1)

    assert raised.value is error


def _tamper_sha(s3: FakeS3, f: sbk.DayFile) -> None:
    s3.objects[key(D1)]['Metadata']['sha256'] = '0' * 64


def _tamper_missing_sha(s3: FakeS3, f: sbk.DayFile) -> None:
    del s3.objects[key(D1)]['Metadata']['sha256']


def _tamper_body(s3: FakeS3, f: sbk.DayFile) -> None:
    s3.objects[key(D1)]['Body'] = s3.objects[key(D1)]['Body'][:-1] + b'x'


def _tamper_rows(s3: FakeS3, f: sbk.DayFile) -> None:
    s3.objects[key(D1)]['Metadata']['rows'] = '19'


def _replace_with(body: bytes, rows: str) -> object:
    def replace(s3: FakeS3, f: sbk.DayFile) -> None:
        s3.objects[key(D1)]['Body'] = body
        s3.objects[key(D1)]['Metadata'].update(
            sha256=hashlib.sha256(body).hexdigest(), rows=rows
        )

    return replace


def _other_schema_file() -> bytes:
    import pyarrow as pa

    table = pa.table({'id': pa.array([1, 2], pa.int32())})
    sink = io.BytesIO()
    pq.write_table(table, sink)
    return sink.getvalue()


BAD_FILES = [
    pytest.param(_tamper_sha, 'sha256', id='sha256-differs'),
    pytest.param(_tamper_missing_sha, 'sha256', id='sha256-missing'),
    pytest.param(_tamper_body, 'sha256', id='body-differs'),
    pytest.param(_tamper_rows, 'rows', id='rows-metadata-differs'),
    pytest.param(_replace_with(b'not parquet', '1'), 'not a readable Parquet', id='not-parquet'),
    pytest.param(_replace_with(_other_schema_file(), '2'), 'schema', id='other-schema'),
]


@pytest.mark.parametrize(('tamper', 'message'), BAD_FILES)
def test_verify_refuses_a_file_that_does_not_match_its_object(
    make_conn, tmp_path: Path, tamper, message: str
) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    f = back_up(s3, rows, tmp_path)
    tamper(s3, f)
    conn = make_conn(rows)

    with pytest.raises(sbk.BackupError, match=message) as raised:
        sbk.verify_day(conn, s3, BUCKET, D1)

    assert raised.value.__context__ is None  # no Arrow text in the chain
    assert conn.statements == []  # the file is checked before the database is read


def test_verify_database_error_propagates_after_a_rollback(make_conn, tmp_path: Path) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.errors.QueryCanceled('injected')
    conn = make_conn(rows, fail_on={'page2': error})

    with pytest.raises(psycopg2.errors.QueryCanceled) as raised:
        sbk.verify_day(conn, s3, BUCKET, D1, page_rows=4)

    assert raised.value is error
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_restore_dry_run_writes_nothing(make_conn, tmp_path: Path) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    in_db = rows[:5] + rows[7:]  # two rows are missing from the database
    conn = make_conn(in_db)

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False, page_rows=4)

    assert result == sbk.RestoreResult(rows=2, id_clashes=0)
    texts = [text for text, _ in conn.statements]
    assert texts[0] == 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    assert texts[-1] == 'ROLLBACK'
    assert not any(t.startswith(('INSERT', 'LOCK', 'COMMIT')) or 'setval' in t for t in texts)
    assert conn.rows == sorted(in_db, key=key_of)
    # The two missing rows sit inside timestamps that are otherwise present.
    asked = [params[0] for text, params in conn.statements if text == TAKEN_IDS_SQL]
    assert asked == [[rows[5][0], rows[6][0]]]


def test_restore_dry_run_counts_ids_that_other_rows_hold(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, list(range(1, 1202)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    # Unrelated rows (another day, other tickers) hold ids 700 and 1150, which the
    # file would insert. The file's first row is already in the table with its
    # own id: it is not one of the rows to insert, so it is not a clash.
    conn = make_conn(
        [
            make_row(id=700, date=D2, expiry=D2, ticker='OTHER'),
            make_row(id=1150, date=D2, expiry=D2, ticker='ANOTHER'),
            rows[0],
        ]
    )

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert result == sbk.RestoreResult(rows=1200, id_clashes=2)
    # Asked in batches of 500 ids, inside the snapshot, and only for the 1,200
    # rows to insert.
    asked = [params[0] for text, params in conn.statements if text == TAKEN_IDS_SQL]
    assert [len(ids) for ids in asked] == [500, 500, 200]
    assert asked[0][0] == 2 and asked[-1][-1] == 1201
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_restore_dry_run_with_nothing_to_insert_asks_about_no_ids(
    make_conn, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows)

    assert sbk.restore_day(conn, s3, BUCKET, D1, apply=False) == sbk.RestoreResult(0, 0)
    assert not any(text == TAKEN_IDS_SQL for text, _ in conn.statements)


def test_restore_dry_run_reads_the_id_sequence_and_changes_nothing(
    make_conn, tmp_path: Path
) -> None:
    # If --apply could not read the sequence it could not move it, so the dry
    # run proves it can, in the same read-only snapshot.
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows[:1], sequence_name=SEQUENCE, sequence_value=3)

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert result == sbk.RestoreResult(rows=2, id_clashes=0)
    texts = [text for text, _ in conn.statements]
    assert texts[-3:] == [
        "SELECT pg_get_serial_sequence('strike_exposures', 'id')",
        f'SELECT last_value, is_called FROM {SEQUENCE}',
        'ROLLBACK',
    ]
    assert sum(t.startswith('BEGIN') for t in texts) == 1  # one snapshot
    assert not any(t.startswith(('LOCK', 'INSERT', 'COMMIT')) or 'setval' in t for t in texts)
    assert conn.sequence_value == 3 and conn.rows == sorted(rows[:1], key=key_of)


@pytest.mark.parametrize(
    ('in_db', 'start', 'to_insert', 'behind'),
    [
        # After a restore whose COMMIT dropped, the rows are in and the sequence
        # (reset, or restored from a backup) is behind: the dry run must say so.
        pytest.param(7, 3, 0, True, id='behind-with-nothing-to-insert'),
        pytest.param(1, 3, 6, True, id='behind-with-rows-to-insert'),
        pytest.param(7, 5000, 0, False, id='ahead-with-nothing-to-insert'),
        pytest.param(1, 5000, 6, False, id='ahead-with-rows-to-insert'),
    ],
)
def test_restore_dry_run_reports_a_sequence_that_is_behind_the_file(
    make_conn, tmp_path: Path, in_db: int, start: int, to_insert: int, behind: bool
) -> None:
    rows = day_rows(D1, list(range(1, 8)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows[:in_db], sequence_name=SEQUENCE, sequence_value=start)

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert result == sbk.RestoreResult(
        rows=to_insert, id_clashes=0, sequence_behind=behind
    )
    texts = [text for text, _ in conn.statements]
    assert not any(t.startswith(('LOCK', 'INSERT', 'COMMIT')) or 'setval' in t for t in texts)
    assert conn.sequence_value == start  # reported, not moved


@pytest.mark.parametrize(
    ('start', 'is_called', 'behind'),
    [
        # The apply's rule, with the file's largest id (900) in the middle of
        # the file: the next id is last_value + 1 once called, else last_value.
        pytest.param(899, True, True, id='called-one-behind-the-files-max-id'),
        pytest.param(900, True, False, id='called-at-the-files-max-id'),
        pytest.param(901, True, False, id='called-past-it'),
        pytest.param(899, False, True, id='not-called-one-behind'),
        pytest.param(900, False, True, id='not-called-at-the-files-max-id'),
        pytest.param(901, False, False, id='not-called-one-past-it'),
    ],
)
def test_restore_dry_run_applies_the_same_is_called_rule_as_the_apply(
    make_conn, tmp_path: Path, start: int, is_called: bool, behind: bool
) -> None:
    rows = plain_rows(3, ids=[5, 900, 70])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(
        rows, sequence_name=SEQUENCE, sequence_value=start, sequence_is_called=is_called
    )

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert result == sbk.RestoreResult(rows=0, id_clashes=0, sequence_behind=behind)
    assert conn.sequence_value == start and conn.sequence_is_called is is_called


def test_restore_dry_run_takes_the_largest_id_from_the_whole_file(
    make_conn, tmp_path: Path
) -> None:
    # The table holds the row with the largest id (900); the rows it lacks have
    # smaller ids. The sequence is behind the file, not behind the missing rows.
    rows = plain_rows(3, ids=[5, 900, 70])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows[1:2], sequence_name=SEQUENCE, sequence_value=899)

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert result == sbk.RestoreResult(rows=2, id_clashes=0, sequence_behind=True)


@pytest.mark.parametrize(
    ('conn_kwargs', 'reason'),
    [
        pytest.param(
            {'fail_on': {'seq_value': psycopg2.errors.InsufficientPrivilege('denied: ' + DETAIL_MARKER)}},
            'permission denied',
            id='no-privilege',
        ),
        pytest.param({'sequence_value': None}, 'the id sequence has no last_value', id='null-value'),
        pytest.param({'sequence_name': None}, 'strike_exposures.id has no sequence', id='no-sequence'),
    ],
)
def test_restore_dry_run_fails_when_the_id_sequence_cannot_be_read(
    make_conn, tmp_path: Path, conn_kwargs: dict, reason: str
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows[:1], **{'sequence_name': SEQUENCE, **conn_kwargs})

    with pytest.raises(sbk.BackupError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert str(raised.value) == f'2026-11-02: the id sequence cannot be read ({reason})'
    assert raised.value.__context__ is None and DETAIL_MARKER not in str(raised.value)
    assert conn.statements[-1][0] == 'ROLLBACK' and not conn.in_txn
    assert conn.rows == sorted(rows[:1], key=key_of)  # a dry run wrote nothing


def test_restore_dry_run_sequence_read_errors_other_than_a_privilege_propagate(
    make_conn, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.errors.QueryCanceled('canceling statement')
    conn = make_conn(rows[:1], sequence_name=SEQUENCE, fail_on={'seq_value': error})

    with pytest.raises(psycopg2.errors.QueryCanceled) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert raised.value is error
    assert conn.statements[-1][0] == 'ROLLBACK' and not conn.in_txn


def test_restore_dry_run_clash_query_error_propagates_unwrapped(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.errors.QueryCanceled('canceling statement due to statement timeout')
    conn = make_conn([], fail_on={'taken_ids': error})

    with pytest.raises(psycopg2.errors.QueryCanceled) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=False)

    assert raised.value is error
    assert conn.statements[-1][0] == 'ROLLBACK'
    assert not conn.in_txn
    assert conn.rows == []


def test_restore_apply_batches_on_conflict_do_nothing(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, list(range(1, 1202)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn([])

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert result == sbk.RestoreResult(rows=1201, id_clashes=0)
    assert [len(params) // len(sbk.COLUMNS) for _, params in conn.inserts] == [500, 500, 201]
    for text, _ in conn.inserts:
        assert text.startswith('INSERT INTO strike_exposures ("id", "date", "timestamp", ')
        assert text.endswith(' ON CONFLICT (date, "timestamp", ticker, strike, expiry) DO NOTHING')
        assert 'UPDATE' not in text and 'DELETE' not in text
    # The rows came back exactly, ids and created_at included.
    assert conn.rows == sorted(rows, key=key_of)
    assert not conn.in_txn


def test_restore_apply_already_present_inserts_zero(make_conn, tmp_path: Path) -> None:
    # Everything is in already and the sequence is far past the file's ids: the
    # sequence is read (a re-run has to know) but not locked or set.
    rows = day_rows(D1, list(range(1, 602)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(rows, sequence_name=SEQUENCE, sequence_value=5000)

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert result == sbk.RestoreResult(rows=0, id_clashes=0)
    assert len(conn.inserts) == 2  # 500 + 101, both skipped by the conflict clause
    texts = [text for text, _ in conn.statements]
    assert texts[-5:] == [
        'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY',
        "SET LOCAL statement_timeout = '60s'",
        "SELECT pg_get_serial_sequence('strike_exposures', 'id')",
        f'SELECT last_value, is_called FROM {SEQUENCE}',
        'ROLLBACK',
    ]
    assert not any(t.startswith('LOCK') or 'setval' in t for t in texts)
    assert conn.sequence_value == 5000


def test_a_rerun_after_a_failed_sequence_step_moves_the_sequence(
    make_conn, tmp_path: Path
) -> None:
    rows = day_rows(D1, list(range(1, 8)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    failing = psycopg2.OperationalError('injected')
    conn = make_conn([], sequence_name=SEQUENCE, sequence_value=3, fail_on={'setval': failing})
    with pytest.raises(sbk.BackupError, match='restored, but the id sequence was not moved'):
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)
    assert len(conn.rows) == 7 and conn.sequence_value == 3
    conn.fail_on = {}
    first_run = len(conn.statements)

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    # Nothing to insert this time, and the sequence still moves.
    assert result == sbk.RestoreResult(rows=0, id_clashes=0)
    assert conn.sequence_value == 7
    texts = [text for text, _ in conn.statements[first_run:]]
    assert 'LOCK TABLE strike_exposures IN SHARE ROW EXCLUSIVE MODE' in texts
    assert texts[-1] == 'COMMIT' and 'SELECT setval' in texts[-2]


@pytest.mark.parametrize(
    ('start', 'is_called', 'moves'),
    [
        # is_called true: last_value is the id last handed out, so the next one
        # is last_value + 1, and 899 means the next nextval returns 900.
        pytest.param(899, True, True, id='called-one-behind-the-files-max-id'),
        pytest.param(900, True, False, id='called-at-the-files-max-id'),
        pytest.param(901, True, False, id='called-past-it'),
        # is_called false (after setval(s, n, false) or a RESTART): last_value is
        # the id the next nextval returns, so 900 would hand out 900 again.
        pytest.param(899, False, True, id='not-called-one-behind'),
        pytest.param(900, False, True, id='not-called-at-the-files-max-id'),
        pytest.param(901, False, False, id='not-called-one-past-it'),
    ],
)
def test_a_rerun_moves_the_sequence_only_when_the_next_id_is_not_past_the_files_max_id(
    make_conn, tmp_path: Path, start: int, is_called: bool, moves: bool
) -> None:
    # The largest id (900) is in the middle of the file, in neither the first
    # nor the last row.
    rows = plain_rows(3, ids=[5, 900, 70])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn(
        rows, sequence_name=SEQUENCE, sequence_value=start, sequence_is_called=is_called
    )

    result = sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert result.rows == 0
    texts = [text for text, _ in conn.statements]
    assert any(t.startswith('LOCK') for t in texts) is moves
    assert any('setval' in t for t in texts) is moves
    assert conn.sequence_value == (900 if moves else start)
    assert conn.sequence_is_called is (True if moves else is_called)


def test_a_failed_sequence_read_on_a_rerun_says_so(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    denied = psycopg2.errors.InsufficientPrivilege('permission denied')
    conn = make_conn(rows, sequence_name=SEQUENCE, fail_on={'seq_value': denied})

    with pytest.raises(sbk.BackupError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert str(raised.value) == (
        '2026-11-02: 0 row(s) restored, but the id sequence was not moved; '
        'move it by hand before the writers run'
    )
    assert conn.statements[-1][0] == 'ROLLBACK' and not conn.in_txn


@pytest.mark.parametrize(
    ('start', 'moved_to'),
    [
        pytest.param(3, 7, id='behind-the-restored-ids'),
        pytest.param(5000, 5000, id='already-ahead'),
    ],
)
def test_restore_apply_locks_then_moves_the_sequence(
    make_conn, tmp_path: Path, start: int, moved_to: int
) -> None:
    rows = day_rows(D1, list(range(1, 8)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn([], sequence_name=SEQUENCE, sequence_value=start)

    assert sbk.restore_day(conn, s3, BUCKET, D1, apply=True).rows == 7

    texts = [text for text, _ in conn.statements]
    assert texts[-7:] == [
        'BEGIN',
        "SET LOCAL statement_timeout = '60s'",
        'LOCK TABLE strike_exposures IN SHARE ROW EXCLUSIVE MODE',
        "SELECT pg_get_serial_sequence('strike_exposures', 'id')",
        f'SELECT last_value, is_called FROM {SEQUENCE}',
        'SELECT setval(%s, GREATEST((SELECT max(id) FROM strike_exposures), %s))',
        'COMMIT',
    ]
    # The insert transaction is over before the sequence one starts.
    assert texts[-9:-7] == [conn.inserts[-1][0], 'COMMIT']
    assert conn.statements[-2][1] == (SEQUENCE, start)
    assert conn.sequence_value == moved_to
    assert 'strike_exposures_id_seq' not in ' '.join(texts)  # looked up, not spelled out
    assert not conn.in_txn and conn.autocommit is False


SEQUENCE_STEP_FAILURES = [
    pytest.param(
        {'sequence_name': None},
        sbk.BackupError,
        'strike_exposures.id has no sequence',
        id='no-sequence',
    ),
    pytest.param(
        {'sequence_value': None},
        sbk.BackupError,
        'the id sequence has no last_value',
        id='last-value-is-null',
    ),
    pytest.param(
        {'fail_on': {'seq_value': psycopg2.errors.InsufficientPrivilege('permission denied')}},
        psycopg2.errors.InsufficientPrivilege,
        'permission denied',
        id='no-privilege-to-read-it',
    ),
    pytest.param(
        {'fail_on': {'lock': psycopg2.errors.QueryCanceled('canceling statement')}},
        psycopg2.errors.QueryCanceled,
        'canceling statement',
        id='lock-times-out',
    ),
    pytest.param(
        {'fail_on': {'setval': psycopg2.OperationalError('injected')}},
        psycopg2.OperationalError,
        'injected',
        id='setval-fails',
    ),
]


@pytest.mark.parametrize(('conn_kwargs', 'cause_type', 'cause_text'), SEQUENCE_STEP_FAILURES)
def test_restore_apply_fails_when_the_sequence_cannot_be_moved(
    make_conn, tmp_path: Path, conn_kwargs: dict, cause_type: type, cause_text: str
) -> None:
    rows = day_rows(D1, list(range(1, 8)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn([], **{'sequence_name': SEQUENCE, 'sequence_value': 3, **conn_kwargs})

    with pytest.raises(sbk.BackupError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert str(raised.value) == (
        '2026-11-02: 7 row(s) restored, but the id sequence was not moved; '
        'move it by hand before the writers run'
    )
    # The step's own error stays attached as the cause, for whoever debugs it.
    assert type(raised.value.__cause__) is cause_type
    assert str(raised.value.__cause__) == cause_text
    assert conn.statements[-1][0] == 'ROLLBACK'
    assert not conn.in_txn
    assert conn.sequence_value in (3, None)  # never moved
    assert len(conn.rows) == 7  # the rows were committed before


def test_the_cli_shows_nothing_of_a_failed_sequence_steps_own_error(cli, tmp_path: Path) -> None:
    # The cause carries the server's text, which can quote a value. The CLI
    # prints the BackupError's fixed text and never walks the chain.
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    cause = psycopg2.OperationalError(f'could not extend the sequence: {DETAIL_MARKER}')
    conn = FakeConnection([], sequence_name=SEQUENCE, fail_on={'setval': cause})

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02', '--apply')

    assert code == 1
    assert (
        'FAILED 2026-11-02: BackupError (2026-11-02: 3 row(s) restored, but the id sequence '
        'was not moved; move it by hand before the writers run)'
    ) in out
    assert DETAIL_MARKER not in out and 'OperationalError' not in out
    assert 'connection lost' not in out  # the link is fine; only the sequence step failed


def test_restore_apply_id_collision_raises(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, list(range(1, 1202)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    # An unrelated row (another day, another ticker) already holds id 700, which
    # is in the second batch of 500.
    squatter = make_row(id=700, date=D2, expiry=D2, ticker='OTHER')
    conn = make_conn([squatter], sequence_name=SEQUENCE)

    with pytest.raises(sbk.BackupError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert str(raised.value) == '2026-11-02: batch 2 was rejected by the table (UniqueViolation)'
    # No value from the database's own message, and nothing chained.
    assert DETAIL_MARKER not in str(raised.value)
    assert DETAIL_MARKER not in ''.join(traceback.format_exception(raised.value))
    assert raised.value.__context__ is None
    # The first batch was inserted and then rolled back with the rest.
    assert len(conn.inserts) == 2
    assert conn.rows == [squatter]
    assert conn.statements[-1][0] == 'ROLLBACK'
    texts = [text for text, _ in conn.statements]
    assert not any(t.startswith('LOCK') or 'setval' in t for t in texts)


@pytest.mark.parametrize(
    'error_type',
    [
        psycopg2.errors.NotNullViolation,  # an IntegrityError
        psycopg2.errors.NumericValueOutOfRange,  # a DataError
    ],
)
def test_restore_apply_scrubs_any_rejection_by_the_table(
    make_conn, tmp_path: Path, error_type: type
) -> None:
    rows = day_rows(D1, list(range(1, 8)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = error_type(f'rejected: {DETAIL_MARKER}')
    conn = make_conn([], fail_on={'insert1': error})

    with pytest.raises(sbk.BackupError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert str(raised.value) == (
        f'2026-11-02: batch 1 was rejected by the table ({error_type.__name__})'
    )
    assert DETAIL_MARKER not in ''.join(traceback.format_exception(raised.value))
    assert raised.value.__context__ is None
    assert conn.statements[-1][0] == 'ROLLBACK'


def test_restore_apply_other_database_error_propagates(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, list(range(1, 8)))
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.OperationalError('server closed the connection')
    conn = make_conn([], fail_on={'insert1': error})

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert raised.value is error
    assert conn.statements[-1][0] == 'ROLLBACK'
    assert conn.rows == []


@pytest.mark.parametrize('apply', [False, True])
@pytest.mark.parametrize(('tamper', 'message'), BAD_FILES)
def test_restore_refuses_a_file_that_does_not_match_its_object(
    make_conn, tmp_path: Path, tamper, message: str, apply: bool
) -> None:
    rows = day_rows(D1, [1, 2])
    s3 = FakeS3()
    f = back_up(s3, rows, tmp_path)
    tamper(s3, f)
    conn = make_conn([])

    with pytest.raises(sbk.BackupError, match=message):
        sbk.restore_day(conn, s3, BUCKET, D1, apply=apply)

    assert conn.statements == []


def test_restore_refuses_a_connection_inside_a_transaction(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = make_conn([])
    conn.in_txn = True

    with pytest.raises(sbk.BackupError, match=r'already inside a transaction \(status 2\)'):
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert conn.statements == []
    conn.in_txn = False  # the caller's transaction, closed for the teardown check


def test_a_write_transaction_is_rolled_back_when_its_block_raises(make_conn) -> None:
    conn = make_conn([])

    with pytest.raises(KeyError):
        with sbk._write_transaction(conn):
            raise KeyError('boom')

    assert [text for text, _ in conn.statements] == [
        'BEGIN',
        "SET LOCAL statement_timeout = '60s'",
        'ROLLBACK',
    ]
    assert conn.autocommit is False


def test_a_dropped_connection_in_a_write_transaction_keeps_its_error(make_conn, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.OperationalError('server closed the connection unexpectedly')
    conn = make_conn([], fail_on={'insert1': error}, closes_on='insert1')

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert raised.value is error
    assert 'ROLLBACK' not in [text for text, _ in conn.statements]


def test_a_connection_that_drops_at_commit_keeps_its_error_and_stops_the_restore(
    make_conn, tmp_path: Path
) -> None:
    # Whether the COMMIT reached the server is unknown, so nothing else is sent:
    # no ROLLBACK, and no sequence step on top of rows that may not be there.
    rows = day_rows(D1, [1, 2])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.OperationalError('server closed the connection unexpectedly')
    conn = make_conn([], sequence_name=SEQUENCE, fail_on={'commit': error}, closes_on='commit')

    with pytest.raises(psycopg2.OperationalError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert raised.value is error
    texts = [text for text, _ in conn.statements]
    assert texts[-1] == 'COMMIT'
    assert 'ROLLBACK' not in texts
    assert not any(t.startswith('LOCK') or 'setval' in t for t in texts)
    assert conn.closed


def test_a_commit_that_fails_on_a_live_connection_propagates_and_restores_autocommit(
    make_conn, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.errors.QueryCanceled('canceling statement due to statement timeout')
    conn = make_conn([], sequence_name=SEQUENCE, fail_on={'commit': error})

    with pytest.raises(psycopg2.errors.QueryCanceled) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=True)

    assert raised.value is error
    assert conn.autocommit is False and not conn.in_txn
    texts = [text for text, _ in conn.statements]
    assert not any(t.startswith('LOCK') or 'setval' in t for t in texts)
    assert conn.rows == []  # the failed COMMIT left nothing behind


def put_file(s3: FakeS3, rows: list[tuple], day: date = D1) -> None:
    """Store `rows` as the day's object exactly as given, rows of other days too,
    with a sha256 and a row count that match the bytes."""
    sink = io.BytesIO()
    with pq.ParquetWriter(sink, sbk.ARROW_SCHEMA, compression='zstd') as writer:
        sbk._write_page(writer, rows, day)
    body = sink.getvalue()
    s3.objects[key(day)] = {
        'Body': body,
        'Metadata': {
            'rows': str(len(rows)),
            'sha256': hashlib.sha256(body).hexdigest(),
            'format': sbk.FORMAT_VERSION,
        },
    }


@pytest.mark.parametrize('apply', [False, True])
def test_restore_refuses_a_file_with_rows_of_another_day(
    make_conn, apply: bool
) -> None:
    # The sha256 and the row count only say this is the file that was uploaded.
    # The stray rows are in the middle, so neither the first nor the last row
    # gives them away.
    rows = day_rows(D1, [1, 2, 3, 4, 5])
    stray = [changed(rows[1], date=D2), changed(rows[2], date=D2)]
    s3 = FakeS3()
    put_file(s3, [rows[0], *stray, *rows[3:]])
    conn = make_conn([], sequence_name=SEQUENCE)

    with pytest.raises(sbk.BackupError) as raised:
        sbk.restore_day(conn, s3, BUCKET, D1, apply=apply)

    assert str(raised.value) == '2026-11-02: 2 row(s) in the file belong to another day'
    assert raised.value.__context__ is None
    # Refused before the database is touched: no BEGIN, and so no INSERT.
    assert conn.statements == []
    assert conn.inserts == [] and conn.rows == []


def test_restore_takes_a_file_whose_rows_all_belong_to_its_day(make_conn) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    put_file(s3, rows)
    conn = make_conn([], sequence_name=SEQUENCE)

    assert sbk.restore_day(conn, s3, BUCKET, D1, apply=True).rows == 3


def test_verify_command_ok(cli, tmp_path: Path) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)

    code, out = cli.run(FakeConnection(rows), s3, 'verify', '--date', '2026-11-02')

    assert code == 0
    assert '2026-11-02: ok, 18 rows' in out
    for secret in (DSN_SECRET, R2_SECRET, 'ACCESS-KEY-MARKER'):
        assert secret not in out


def test_verify_command_mismatch_exits_1(cli, tmp_path: Path) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows[1:], tmp_path)

    code, out = cli.run(FakeConnection(rows), s3, 'verify', '--date', '2026-11-02')

    assert code == 1
    assert '2026-11-02: MISMATCH' in out
    assert 'db rows 18' in out and 'file rows 17' in out
    assert 'only in db 1' in out and 'only in file 0' in out and 'changed 0' in out


def test_verify_command_goes_on_after_a_failed_day(cli, tmp_path: Path) -> None:
    d1_rows, d3_rows = grouped_rows(D1, 1), grouped_rows(D3, 101)
    s3 = FakeS3()
    back_up(s3, d1_rows, tmp_path, D1)
    back_up(s3, d3_rows, tmp_path, D3)  # D2 has no object
    conn = FakeConnection(d1_rows + grouped_rows(D2, 51) + d3_rows)

    code, out = cli.run(
        conn, s3, 'verify', '--date', '2026-11-02', '--date', '2026-11-03', '--date', '2026-11-04'
    )

    assert code == 1
    assert '2026-11-02: ok' in out and '2026-11-04: ok' in out
    assert 'FAILED 2026-11-03: BackupError (2026-11-03: no object in R2)' in out


def test_verify_command_stops_when_the_connection_drops(cli, tmp_path: Path) -> None:
    d1_rows, d2_rows = grouped_rows(D1, 1), grouped_rows(D2, 51)
    s3 = FakeS3()
    back_up(s3, d1_rows, tmp_path, D1)
    back_up(s3, d2_rows, tmp_path, D2)
    back_up(s3, grouped_rows(D3, 101), tmp_path, D3)
    error = psycopg2.OperationalError('server closed the connection unexpectedly')
    conn = FakeConnection(
        d1_rows + d2_rows + grouped_rows(D3, 101), fail_on={'page2': error}, closes_on='page2'
    )

    code, out = cli.run(
        conn, s3, 'verify', '--date', '2026-11-02', '--date', '2026-11-03', '--date', '2026-11-04'
    )

    assert code == 1
    assert '2026-11-02: ok' in out and 'connection lost' in out
    assert '2026-11-04' not in out  # never tried


def test_verify_command_checks_a_repeated_date_once(cli, tmp_path: Path) -> None:
    rows = grouped_rows()
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection(rows)

    code, out = cli.run(
        conn, s3, 'verify', '--date', '2026-11-02', '--date', '2026-11-02'
    )

    assert code == 0
    assert out.count('2026-11-02: ok') == 1
    assert len(conn.page_queries) == 1


def test_verify_command_needs_a_date(cli) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.run(FakeConnection([]), FakeS3(), 'verify')

    assert raised.value.code == 2


def test_restore_command_dry_run_is_the_default(cli, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection(rows[:1])

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 0
    assert '2026-11-02: would insert 2 rows (a dry run; add --apply to write)' in out
    assert conn.inserts == [] and len(conn.rows) == 1


def test_restore_command_dry_run_exits_1_when_ids_are_taken(cli, tmp_path: Path) -> None:
    # A dry run that finds taken ids must not report the day as restorable. It
    # names the count and nothing about the rows: no id, no ticker.
    rows = day_rows(D1, [1, 2, 424242])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    squatter = make_row(id=424242, date=D2, expiry=D2, ticker='OTHER')
    conn = FakeConnection([squatter])

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 1
    assert '2026-11-02: would insert 3 rows, but 1 id(s) already taken; --apply would fail' in out
    assert '424242' not in out and 'OTHER' not in out
    assert conn.inserts == []


SEQUENCE_BEHIND_LINE = (
    "2026-11-02: the id sequence is behind the file's ids; --apply will move it"
)


@pytest.mark.parametrize(
    ('in_db', 'would_insert'),
    [
        pytest.param(3, 'would insert 0 rows', id='nothing-to-insert'),
        pytest.param(1, 'would insert 2 rows', id='rows-to-insert'),
    ],
)
def test_restore_command_dry_run_says_when_the_sequence_is_behind(
    cli, tmp_path: Path, in_db: int, would_insert: str
) -> None:
    # The rows may all be in already (a restore whose COMMIT dropped after it
    # committed). A dry run that only said "would insert 0 rows" would leave the
    # sequence behind and live inserts failing on the primary key.
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection(rows[:in_db], sequence_name=SEQUENCE, sequence_value=1)

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 0
    assert f'2026-11-02: {would_insert} (a dry run; add --apply to write)' in out
    assert SEQUENCE_BEHIND_LINE in out
    assert out.count('behind') == 1
    assert conn.inserts == [] and conn.sequence_value == 1


def test_restore_command_dry_run_says_nothing_of_a_sequence_that_is_ahead(
    cli, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection(rows[:1], sequence_name=SEQUENCE, sequence_value=3)  # next id is 4

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 0
    assert 'would insert 2 rows' in out
    assert 'behind' not in out


def test_restore_command_dry_run_with_taken_ids_does_not_promise_the_sequence_move(
    cli, tmp_path: Path
) -> None:
    # --apply would fail on the primary key and roll back, so it would not move
    # the sequence either: the taken-ids line is the whole story.
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    squatter = make_row(id=2, date=D2, expiry=D2, ticker='OTHER')
    conn = FakeConnection([squatter], sequence_name=SEQUENCE, sequence_value=1)

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 1
    assert '1 id(s) already taken; --apply would fail' in out
    assert 'will move it' not in out


def test_restore_command_apply_says_nothing_about_a_sequence_it_moves(
    cli, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection([], sequence_name=SEQUENCE, sequence_value=1)

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02', '--apply')

    assert code == 0
    assert '2026-11-02: inserted 3 rows' in out
    assert 'behind' not in out and conn.sequence_value == 3


def test_restore_command_dry_run_clash_query_failure_exits_1_with_the_class_only(
    cli, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2, 424242])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.errors.QueryCanceled(f'canceled while checking id 424242 {DETAIL_MARKER}')
    conn = FakeConnection([], fail_on={'taken_ids': error})

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 1
    assert 'FAILED 2026-11-02: QueryCanceled' in out
    assert '424242' not in out and DETAIL_MARKER not in out
    assert conn.inserts == []


def test_restore_command_dry_run_exits_1_when_the_id_sequence_cannot_be_read(
    cli, tmp_path: Path
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    denied = psycopg2.errors.InsufficientPrivilege('permission denied for sequence')
    conn = FakeConnection(rows[:1], sequence_name=SEQUENCE, fail_on={'seq_value': denied})

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02')

    assert code == 1
    assert 'FAILED 2026-11-02: BackupError' in out
    assert 'the id sequence cannot be read (permission denied)' in out
    assert 'would insert' not in out and conn.inserts == []


def test_restore_command_apply(cli, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection(rows[:1], sequence_name=SEQUENCE)

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02', '--apply')

    assert code == 0
    assert '2026-11-02: inserted 2 rows' in out
    assert conn.rows == sorted(rows, key=key_of)
    for secret in (DSN_SECRET, R2_SECRET, 'ACCESS-KEY-MARKER'):
        assert secret not in out


LOST_DURING_APPLY = (
    'connection lost during --apply; whether the rows were committed is unknown. '
    'Run restore without --apply to see what is left; re-running --apply is safe'
)


def test_restore_command_apply_that_loses_the_connection_says_the_outcome_is_unknown(
    cli, tmp_path: Path
) -> None:
    # A drop at COMMIT may or may not have committed the day. The failure line
    # alone ("OperationalError") would not tell the owner that.
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    error = psycopg2.OperationalError(f'server closed the connection {DETAIL_MARKER}')
    conn = FakeConnection([], sequence_name=SEQUENCE, fail_on={'commit': error}, closes_on='commit')

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02', '--apply')

    assert code == 1
    assert 'FAILED 2026-11-02: OperationalError\n' in out
    assert LOST_DURING_APPLY in out
    assert DETAIL_MARKER not in out


@pytest.mark.parametrize(
    ('argv', 'conn_kwargs', 'failure'),
    [
        pytest.param(
            ['--apply'],
            {'fail_on': {'commit': psycopg2.errors.QueryCanceled('canceling statement')}},
            'FAILED 2026-11-02: QueryCanceled\n',
            id='a-failed-commit-on-a-live-connection',
        ),
        pytest.param(
            [],
            {
                'fail_on': {'page1': psycopg2.OperationalError('server closed the connection')},
                'closes_on': 'page1',
            },
            'FAILED 2026-11-02: OperationalError\n',
            id='a-dry-run-writes-nothing-so-nothing-is-unknown',
        ),
        pytest.param(
            ['--apply'],
            {
                'fail_on': {'setval': psycopg2.OperationalError('server closed the connection')},
                'closes_on': 'setval',
            },
            'FAILED 2026-11-02: BackupError (2026-11-02: 3 row(s) restored, but the id sequence '
            'was not moved; move it by hand before the writers run)\n',
            id='a-drop-after-the-rows-committed-already-says-what-happened',
        ),
    ],
)
def test_restore_command_does_not_claim_an_unknown_outcome_when_it_knows_better(
    cli, tmp_path: Path, argv: list[str], conn_kwargs: dict, failure: str
) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    conn = FakeConnection([], sequence_name=SEQUENCE, **conn_kwargs)

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02', *argv)

    assert code == 1
    assert failure in out
    assert 'unknown' not in out


def test_restore_command_refuses_a_file_with_rows_of_another_day(cli) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    put_file(s3, [rows[0], changed(rows[1], date=D2), rows[2]])
    conn = FakeConnection([], sequence_name=SEQUENCE)

    code, out = cli.run(conn, s3, 'restore', '--date', '2026-11-02', '--apply')

    assert code == 1
    assert (
        'FAILED 2026-11-02: BackupError (2026-11-02: 1 row(s) in the file belong to another day)'
    ) in out
    assert conn.statements == []


def test_restore_command_failure_exits_1(cli, tmp_path: Path) -> None:
    rows = day_rows(D1, [1, 2, 3])
    s3 = FakeS3()
    back_up(s3, rows, tmp_path)
    squatter = make_row(id=2, date=D2, expiry=D2, ticker='OTHER')

    code, out = cli.run(FakeConnection([squatter]), s3, 'restore', '--date', '2026-11-02', '--apply')

    assert code == 1
    assert 'FAILED 2026-11-02: BackupError' in out
    assert DETAIL_MARKER not in out


def test_restore_command_needs_a_date(cli) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.run(FakeConnection([]), FakeS3(), 'restore', '--apply')

    assert raised.value.code == 2
