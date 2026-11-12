#!/usr/bin/env python
"""Back up strike_exposures to Parquet files in R2, one per session day.

strike_exposures (74M rows, insert-only) was never backed up, and about 96 % of
it exists nowhere else. The plan is one Parquet file per session day in the
private R2 bucket, at backups/strike_exposures/<date>.parquet:
docs/superpowers/specs/strike-exposures-backup-2026-11-11.md.

Reading one day:

- `_read_snapshot` is the one way to read in a snapshot: a REPEATABLE READ,
  READ ONLY transaction on a connection that was idle, with the connection's
  autocommit put back afterwards. Every read of the table goes through it.
- `iter_day_pages` keyset-pages the day on the table's unique key.
- `write_day_parquet` reads the day in a snapshot, checks the rows written
  against the count taken from the same snapshot, and returns a `DayFile`
  (None for a day with no rows). Whatever goes wrong, no file is left behind.

Putting it in R2 and deciding which days are due:

- `upload_day` uploads a file with its metadata and checks the object back
  (size and rows). An object that fails the check is deleted, so a key that
  exists means a day that verified.
- `plan_days` decides which days need a file: those with no object, those
  whose object it cannot trust (an old format, or no usable `rows`), those
  that gained rows since the last run (an id high-water mark kept in
  `_state.json`), and, with `verify_counts` (or no mark, or too many ids since
  it), any whose row count differs from the object's.
Checking and restoring a day:

- `verify_day` compares a day in the database with its file in R2, row by row
  on the unique key, and counts the rows only in one side and the rows whose
  values differ.
- `restore_day` puts a day's file back into the table. It is a dry run unless
  `apply` is true. It inserts with ON CONFLICT on the unique key DO NOTHING in
  batches, keeps the original ids, and then moves the id sequence past them.
- `main` is the CLI: `export`, `status`, `verify` and `restore`.

The types are exact. NUMERIC columns keep the column's own precision and scale
as decimal128 (never float), timestamptz is timestamp[us, tz=UTC], and the
`id` column is kept so a restore can put the original rows back. Nullability
follows the table, so a NULL in a NOT NULL column fails the write.

A `BackupError` message is fixed text plus a date, counts or a status code,
never a cell value. A failed day is logged by date and error class.

Usage (needs DATABASE_URL and the R2_* variables, from .env.local or the
environment; run outside 13:00 to 23:00 UTC, the day's rollup lands at 22:30):

    ml/.venv/Scripts/python scripts/strike_exposures_backup.py export
    ml/.venv/Scripts/python scripts/strike_exposures_backup.py export --dry-run \\
        --date 2026-11-10
    ml/.venv/Scripts/python scripts/strike_exposures_backup.py status
    ml/.venv/Scripts/python scripts/strike_exposures_backup.py verify --date 2026-11-10
    ml/.venv/Scripts/python scripts/strike_exposures_backup.py restore --date 2026-11-10

`restore` only reports what it would insert until it is given `--apply`, and
running it with `--apply` against production needs the owner's go-ahead.

Exit codes: 0 ok, 1 a day (or the plan) failed or did not verify, 2 bad config
or arguments.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3
import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq
from boto3.exceptions import Boto3Error
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from psycopg2 import sql
from psycopg2.extensions import TRANSACTION_STATUS_IDLE, TRANSACTION_STATUS_UNKNOWN
from psycopg2.extensions import connection as PgConnection
from psycopg2.extensions import cursor as PgCursor

from _cli_paths import format_dates, load_env_file
from _pipeline_retry import connect_with_retry

# 12 to 14 MiB of JSON per page, 0.76 to 1.29 s on the unique-key keyset.
PAGE_ROWS = 20_000
# 2x the 30 s probe budget: a page must never get near it.
STATEMENT_TIMEOUT = '60s'
PREFIX = 'backups/strike_exposures/'
# {"high_water_id": int, "updated_at": iso}: the largest id the last complete run saw.
STATE_KEY = PREFIX + '_state.json'
# Raise it when the column list or the types change.
FORMAT_VERSION = '1'
# The id delta query costs about 5.6 s per 1M ids, because date is not in the
# pkey and every row needs a heap fetch. A normal night is 0.5M to 2.8M ids; about
# 10M (two missed weeks) passes the 60 s statement timeout, and then planning
# would fail every night. Past this many ids since the stored mark the delta is
# skipped and every day is counted instead, which is about 45 to 60 s over many
# statements of at most about 1.3 s each.
DELTA_MAX_IDS = 5_000_000
# Rows per INSERT in a restore (the repo's batch rule, R5).
RESTORE_BATCH = 500

_DAY_KEY = re.compile(re.escape(PREFIX) + r'(\d{4}-\d{2}-\d{2})\.parquet$')
# One thread, as nightly's R2Store: a client shared across upload threads once
# sent requests without TLS verification. Multipart from 64 MiB; a Friday is
# about 215 MB.
_TRANSFER = TransferConfig(
    multipart_threshold=64 * 2**20, use_threads=False, preferred_transfer_client='classic'
)
_REQUIRED_ENV = (
    'DATABASE_URL',
    'R2_ENDPOINT_URL',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_FULLTAPE',
)

_TIMESTAMPTZ = pa.timestamp('us', tz='UTC')
_PRICE = pa.decimal128(10, 2)
_GREEK = pa.decimal128(30, 4)

# Migration #8 made the table; #17 made created_at NOT NULL; #191 widened the
# greek columns from NUMERIC(20,4) to NUMERIC(30,4).
ARROW_SCHEMA = pa.schema(
    [
        pa.field('id', pa.int32(), nullable=False),
        pa.field('date', pa.date32(), nullable=False),
        pa.field('timestamp', _TIMESTAMPTZ, nullable=False),
        pa.field('ticker', pa.string(), nullable=False),
        pa.field('expiry', pa.date32()),
        pa.field('strike', _PRICE, nullable=False),
        pa.field('price', _PRICE),
        *(
            pa.field(name, _GREEK)
            for name in (
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
        ),
        pa.field('created_at', _TIMESTAMPTZ, nullable=False),
    ]
)
COLUMNS: tuple[str, ...] = tuple(ARROW_SCHEMA.names)

_ID = COLUMNS.index('id')
# The unique key (date, "timestamp", ticker, strike, expiry) without date, as
# positions in a row.
_KEY = tuple(COLUMNS.index(c) for c in ('timestamp', 'ticker', 'strike', 'expiry'))

_COUNT_SQL = 'SELECT count(*) FROM strike_exposures WHERE date = %s'
_PAGE_SQL = (
    'SELECT ' + ', '.join(f'"{c}"' for c in COLUMNS) + ' FROM strike_exposures'
    ' WHERE date = %s'
)
_NO_SORT_SQL = ('SET LOCAL enable_sort = off', 'SET LOCAL enable_incremental_sort = off')
_AFTER_KEY_SQL = ' AND ("timestamp", ticker, strike, expiry) > (%s, %s, %s, %s)'
# Always ORDER BY the key: a LIMIT without it flips to a Seq Scan on a Friday
# (2.8M of 74M rows) and times out.
_ORDER_SQL = ' ORDER BY date, "timestamp", ticker, strike, expiry LIMIT %s'


class BackupError(Exception):
    """A backup step failed. The message is fixed text plus a date, counts or a
    status code, and never a cell value."""


# What a day (or the plan) can fail with. A programming error is not in here: it
# should crash the run, not become one more failed day.
_RUN_FAILURES = (
    BackupError,
    psycopg2.Error,
    BotoCoreError,
    ClientError,
    Boto3Error,
    OSError,
)


@dataclass(frozen=True)
class DayFile:
    day: date
    path: Path
    rows: int
    min_id: int
    max_id: int
    size: int
    sha256: str


def _require_idle(conn: PgConnection) -> None:
    """Raise BackupError unless the connection is open and in no transaction.

    A BEGIN inside an open transaction is only a server WARNING, so the work
    would silently run in the caller's transaction.
    """
    status = conn.info.transaction_status
    if status == TRANSACTION_STATUS_UNKNOWN:  # what psycopg2 reports once closed
        raise BackupError(f'the connection is closed (status {status})')
    if status != TRANSACTION_STATUS_IDLE:
        raise BackupError(
            f'the connection is already inside a transaction (status {status})'
        )


@contextmanager
def _read_snapshot(conn: PgConnection) -> Iterator[PgCursor]:
    """Yield a cursor inside one REPEATABLE READ, READ ONLY transaction.

    Every statement in the block sees the same snapshot, and rows committed
    meanwhile are invisible to it. The transaction always ends in a ROLLBACK,
    and `conn.autocommit` is put back as it was, on success and on failure.

    The BEGIN is ours, so autocommit is on while it runs (with it off, psycopg2
    would open a transaction at the session's isolation level first). And the
    connection must be idle: a BEGIN inside an open transaction is only a
    server WARNING, and the read would silently run in the caller's
    transaction, outside the snapshot.

    A connection that dropped mid-read (`conn.closed` is set) cannot ROLLBACK
    or take an autocommit change: psycopg2 raises InterfaceError for both,
    which would replace the OperationalError that explains the failure. So
    neither is tried, and the original error propagates.

    One thread per connection: this changes the connection's autocommit.
    """
    _require_idle(conn)
    previous = conn.autocommit
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            try:
                cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
                yield cur
            finally:
                if not conn.closed:
                    cur.execute('ROLLBACK')
    finally:
        if not conn.closed:
            conn.autocommit = previous


@contextmanager
def _write_transaction(conn: PgConnection) -> Iterator[PgCursor]:
    """Yield a cursor inside one read-write transaction.

    The block ends in COMMIT, or in ROLLBACK if it raises, so a restore of a
    day is all or nothing. The rest is as in `_read_snapshot`: an idle
    connection is required, autocommit is on for the BEGIN and put back, the
    statements run under the same timeout (which also bounds a wait for a
    lock), and a connection that dropped is not sent a ROLLBACK, so the
    original error reaches the caller.
    """
    _require_idle(conn)
    previous = conn.autocommit
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute('BEGIN')
            try:
                cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
                yield cur
            except BaseException:
                if not conn.closed:
                    cur.execute('ROLLBACK')
                raise
            cur.execute('COMMIT')
    finally:
        if not conn.closed:
            conn.autocommit = previous


def iter_day_pages(
    cur: PgCursor, day: date, page_rows: int = PAGE_ROWS
) -> Iterator[list[tuple]]:
    """Yield one day's rows in unique-key order, `page_rows` at a time.

    Each page after the first starts after the last key of the page before it
    (keyset paging on the unique index). Never OFFSET, which re-reads every
    skipped row: 117 s at offset 20M. A page shorter than `page_rows` is the
    last one.

    It turns both sorts off for the transaction before the first page, every
    time it is called. It must run inside a transaction (`_read_snapshot`), where
    SET LOCAL lasts until the end.
    """
    # Planner trap, found on 2026-10-02 (3,518,489 rows, the largest day). For
    # the pages after the first, WHERE date = D AND ("timestamp", ticker,
    # strike, expiry) > (...) ORDER BY ... LIMIT 20000 left the unique-index
    # scan for `Index Scan using idx_strike_exp_timestamp` + `Incremental Sort`,
    # with the date and the row comparison as a Filter. LIMIT costing on that
    # filtered timestamp scan makes it look cheap, but on the day's last page
    # (fewer than 20,000 rows left) the scan runs on through every later
    # timestamp in the table and hits the 60 s timeout. With both sorts off the
    # planner keeps `Index Scan using
    # strike_exposures_date_timestamp_ticker_strike_expiry_key` with both
    # conditions in the Index Cond: 2.1 ms for 5,000 rows (EXPLAIN ANALYZE, a
    # key 5,000 rows from the end). The underscore in enable_incremental_sort
    # matters: enable_incrementalsort is an unrecognized parameter.
    for statement in _NO_SORT_SQL:
        cur.execute(statement)
    after: tuple = ()
    while True:
        sql = _PAGE_SQL + (_AFTER_KEY_SQL if after else '') + _ORDER_SQL
        cur.execute(sql, (day, *after, page_rows))
        rows = cur.fetchall()
        if not rows:
            return
        yield rows
        if len(rows) < page_rows:
            return
        after = tuple(rows[-1][i] for i in _KEY)


def _count_error(day: date, expected: int, written: int) -> BackupError:
    return BackupError(
        f'{day.isoformat()}: row count mismatch '
        f'(snapshot {expected}, wrote {written})'
    )


def _write_page(writer: pq.ParquetWriter, rows: list[tuple], day: date) -> None:
    try:
        arrays = [
            pa.array(values, type=field.type)
            for values, field in zip(zip(*rows), ARROW_SCHEMA)
        ]
        writer.write_table(pa.Table.from_arrays(arrays, schema=ARROW_SCHEMA))
    except (pa.ArrowException, ArithmeticError):
        pass
    else:
        return
    # Raised here and not in the handler: Arrow's message can quote the
    # offending cell, and inside the handler it would ride along as the
    # exception's __context__ into any log or Sentry event.
    raise BackupError(f'{day.isoformat()}: a page did not fit the Parquet schema')


def _stream_to_parquet(
    cur: PgCursor, day: date, path: Path, expected: int, page_rows: int
) -> tuple[int, int, int]:
    """Write the day to `path`; return (rows, min_id, max_id).

    Raises when the rows do not add up to `expected`. The file it leaves on a
    failure is `write_day_parquet`'s to delete.
    """
    written = 0
    min_id: int | None = None
    max_id: int | None = None
    with pq.ParquetWriter(path, ARROW_SCHEMA, compression='zstd') as writer:
        for rows in iter_day_pages(cur, day, page_rows):
            _write_page(writer, rows, day)
            written += len(rows)
            if written > expected:
                # Stops a keyset that never advances from filling the disk.
                raise _count_error(day, expected, written)
            ids = [row[_ID] for row in rows]
            min_id = min(ids) if min_id is None else min(min_id, *ids)
            max_id = max(ids) if max_id is None else max(max_id, *ids)
    if written != expected:
        raise _count_error(day, expected, written)
    return written, min_id, max_id


def write_day_parquet(
    conn: PgConnection, day: date, out_dir: Path, page_rows: int = PAGE_ROWS
) -> DayFile | None:
    """Export one session day to `out_dir/<day>.parquet`.

    The day is read in one snapshot (`_read_snapshot`), so the count and every
    page come from the same moment and rows inserted while the export runs are
    invisible to it. Returns None for a day with no rows and writes no file for
    it. The connection must be idle, and its autocommit is left as it was.

    Any failure, including a ROLLBACK that fails after the file is complete,
    deletes the file: a file is only ever returned from a day that added up.
    A database error propagates as it is. On a connection the error dropped,
    nothing more is sent (see `_read_snapshot`), so it is the error the caller
    sees. A ROLLBACK that fails on a live connection keeps it as `__context__`.
    """
    path = out_dir / f'{day.isoformat()}.parquet'
    try:
        with _read_snapshot(conn) as cur:
            cur.execute(_COUNT_SQL, (day,))
            expected = cur.fetchone()[0]
            if expected == 0:
                return None
            rows, min_id, max_id = _stream_to_parquet(
                cur, day, path, expected, page_rows
            )
        with path.open('rb') as f:
            sha256 = hashlib.file_digest(f, 'sha256').hexdigest()
        size = path.stat().st_size
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return DayFile(
        day=day,
        path=path,
        rows=rows,
        min_id=min_id,
        max_id=max_id,
        size=size,
        sha256=sha256,
    )


def object_key(day: date) -> str:
    return f'{PREFIX}{day.isoformat()}.parquet'


def upload_day(s3, bucket: str, f: DayFile) -> None:
    """Upload a day's file with its metadata, then check R2 holds the same.

    The check reads the object back with `head_object`: `ContentLength` must
    equal the local size and the metadata `rows` must equal the file's rows.
    An object that fails the check is deleted (best effort), so a key that
    exists means a day that verified; if it cannot be deleted the error says
    so. That also drops a previous good file for the day, but one that is
    being replaced was already missing rows. An upload that itself fails
    raises as boto3 raised it and leaves the old object alone, because an
    upload is all or nothing.
    """
    key = object_key(f.day)
    metadata = {
        'rows': str(f.rows),
        'min-id': str(f.min_id),
        'max-id': str(f.max_id),
        'sha256': f.sha256,
        'exported-at': datetime.now(UTC).isoformat(timespec='seconds'),
        'format': FORMAT_VERSION,
    }
    s3.upload_file(
        str(f.path),
        bucket,
        key,
        ExtraArgs={
            'Metadata': metadata,
            'ContentType': 'application/vnd.apache.parquet',
        },
        Config=_TRANSFER,
    )
    day = f.day.isoformat()
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
        remote = head['ContentLength']
        if remote != f.size:
            raise BackupError(f'{day}: R2 holds {remote} bytes, uploaded {f.size}')
        if head.get('Metadata', {}).get('rows') != str(f.rows):
            raise BackupError(f"{day}: the R2 object's rows metadata does not match {f.rows}")
    except Exception as exc:
        try:
            s3.delete_object(Bucket=bucket, Key=key)
        except Exception:
            raise BackupError(
                f'{day}: could not verify the upload and could not delete {key}; '
                'the object may remain, delete it by hand'
            ) from exc
        if isinstance(exc, BackupError):
            raise
        raise BackupError(
            f'{day}: could not verify the upload ({type(exc).__name__})'
        ) from exc


def exported_days(s3, bucket: str) -> dict[date, dict[str, str]]:
    """Every day with an object under PREFIX, mapped to its user metadata.

    Costs one list request per 1,000 keys plus one `head_object` per day: list
    results carry no metadata. `_state.json` and any other key that is not a
    day's file is skipped. A request error propagates, so a day is never
    reported exported or missing by mistake.
    """
    found: dict[date, dict[str, str]] = {}
    pages = s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=PREFIX)
    for page in pages:
        for obj in page.get('Contents', []):
            match = _DAY_KEY.fullmatch(obj['Key'])
            if match is None:
                continue
            try:
                day = date.fromisoformat(match.group(1))
            except ValueError:  # 2026-13-45.parquet is not a day
                continue
            head = s3.head_object(Bucket=bucket, Key=obj['Key'])
            found[day] = dict(head.get('Metadata', {}))
    return found


def read_state(s3, bucket: str) -> int | None:
    """The id high-water mark of the last complete run, or None if there is none."""
    try:
        body = s3.get_object(Bucket=bucket, Key=STATE_KEY)['Body'].read()
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') in ('NoSuchKey', '404'):
            return None
        raise
    try:
        high_water = json.loads(body)['high_water_id']
    except (ValueError, KeyError, TypeError):
        raise BackupError('the state object is malformed') from None
    if type(high_water) is not int or high_water < 0:  # not a bool, not negative
        raise BackupError('the state object is malformed')
    return high_water


def write_state(s3, bucket: str, high_water_id: int) -> None:
    body = json.dumps(
        {
            'high_water_id': high_water_id,
            'updated_at': datetime.now(UTC).isoformat(timespec='seconds'),
        }
    )
    s3.put_object(
        Bucket=bucket, Key=STATE_KEY, Body=body.encode(), ContentType='application/json'
    )


# The planning reads. A loose index scan lists the days (one index probe per
# day); SELECT DISTINCT date would read all 74M index entries.
_NULL_EXPIRY_SQL = 'SELECT count(*) FROM strike_exposures WHERE expiry IS NULL'
_DAYS_SQL = (
    'WITH RECURSIVE d AS ('
    '(SELECT date FROM strike_exposures ORDER BY date ASC LIMIT 1) '
    'UNION ALL '
    'SELECT (SELECT date FROM strike_exposures WHERE date > d.date '
    'ORDER BY date ASC LIMIT 1) FROM d WHERE d.date IS NOT NULL'
    ') SELECT date FROM d WHERE date IS NOT NULL ORDER BY date'
)
_MAX_ID_SQL = 'SELECT max(id) FROM strike_exposures'
_DELTA_SQL = 'SELECT date FROM strike_exposures WHERE id > %s GROUP BY date'


@dataclass(frozen=True)
class Plan:
    """What `plan_days` found. `due` is `missing` plus `stale`, oldest first.

    `db_days` are the table's days before today; `object_days` are every day
    with an object; `high_water_id` is `max(id)` in the planning snapshot;
    `scope` says which days had their rows counted and why.
    """

    due: list[date]
    high_water_id: int
    missing: list[date]
    stale: list[date]
    db_days: list[date]
    object_days: list[date]
    scope: str


def _object_rows(metadata: dict[str, str]) -> int | None:
    """The row count an object says it holds, or None if it does not say."""
    text = metadata.get('rows', '')
    return int(text) if text.isascii() and text.isdecimal() else None


def plan_days(
    conn: PgConnection,
    s3,
    bucket: str,
    today_et: date,
    verify_counts: bool = False,
) -> Plan:
    """Decide which days need a file. Only days before `today_et` are planned.

    A day is due when it has no object (missing), or when its object cannot be
    trusted or its row count differs from the object's `rows` metadata (stale).
    An object cannot be trusted when its `format` is not FORMAT_VERSION or its
    `rows` is missing or not a count: it was written by something else, or by
    another version of this module. That is decided without a count.

    The count is taken for the days that gained rows since the last complete
    run (ids above the stored high-water mark) and, for every day that has a
    trusted object, with `verify_counts`, with no stored mark, or when more
    than DELTA_MAX_IDS ids have been used since the mark (the delta query would
    run too long). The mark misses one thing: a row with a lower id that
    commits after the planning snapshot. `verify_counts` catches it.

    The database is read once, in one snapshot, with every result fetched
    inside it. The table must have no NULL expiry: the keyset paging and the
    restore's conflict key both assume none.
    """
    exported = exported_days(s3, bucket)
    last_id = read_state(s3, bucket)
    untrusted = {
        day
        for day, metadata in exported.items()
        if metadata.get('format') != FORMAT_VERSION or _object_rows(metadata) is None
    }
    counts: dict[date, int] = {}
    with _read_snapshot(conn) as cur:
        cur.execute(_NULL_EXPIRY_SQL)
        null_expiry = cur.fetchone()[0]
        if null_expiry:
            raise BackupError(
                f'{null_expiry} row(s) have a NULL expiry; the keyset paging '
                'and the restore assume none'
            )
        cur.execute(_DAYS_SQL)
        db_days = [row[0] for row in cur.fetchall() if row[0] < today_et]
        cur.execute(_MAX_ID_SQL)
        high_water_id = cur.fetchone()[0] or 0
        # `scope` is the label that is printed; `use_delta` is what decides.
        use_delta = False
        if verify_counts:
            scope = 'every day: --verify-counts'
        elif last_id is None:
            scope = 'every day: no stored high-water mark'
        elif high_water_id < last_id:
            # After a point-in-time restore or a sequence reset the mark can be
            # ahead of every id: the delta would find nothing and call it fine.
            scope = 'every day: the stored mark is above max(id)'
        elif high_water_id - last_id > DELTA_MAX_IDS:
            scope = f'every day: ids moved more than {DELTA_MAX_IDS} since the stored mark'
        else:
            scope = 'delta'
            use_delta = True
        gained: set[date] = set()
        if use_delta:
            cur.execute(_DELTA_SQL, (last_id,))
            gained = {row[0] for row in cur.fetchall()}
        for day in db_days:
            counted = not use_delta or day in gained
            if day in exported and day not in untrusted and counted:
                cur.execute(_COUNT_SQL, (day,))
                counts[day] = cur.fetchone()[0]
    missing = [day for day in db_days if day not in exported]
    stale = [
        day
        for day in db_days
        if day in untrusted
        or (day in counts and _object_rows(exported[day]) != counts[day])
    ]
    return Plan(
        due=sorted(missing + stale),
        high_water_id=high_water_id,
        missing=missing,
        stale=stale,
        db_days=db_days,
        object_days=sorted(exported),
        scope=scope,
    )


@dataclass(frozen=True)
class VerifyResult:
    """How a day in the database compares with its file in R2."""

    day: date
    db_rows: int
    file_rows: int
    only_in_db: int
    only_in_file: int
    value_diffs: int

    @property
    def ok(self) -> bool:
        return (
            self.db_rows == self.file_rows
            and self.only_in_db == 0
            and self.only_in_file == 0
            and self.value_diffs == 0
        )


_TIMESTAMP = COLUMNS.index('timestamp')
# What tells two rows of one timestamp apart. The date is the same for the day.
_KEY_IN_TIMESTAMP = tuple(COLUMNS.index(c) for c in ('ticker', 'strike', 'expiry'))


def _row_groups(pages: Iterator[list[tuple]]) -> Iterator[tuple[datetime, list[tuple]]]:
    """Yield (timestamp, rows) for each run of rows that share a timestamp.

    The rows must come in timestamp order, as both the database (ORDER BY the
    unique key) and the files written from it do; otherwise the merge in
    `_compare_days` would pair the wrong groups.
    """
    previous = None
    group: list[tuple] = []
    for page in pages:
        for row in page:
            stamp = row[_TIMESTAMP]
            if group and stamp != previous:
                if stamp < previous:
                    raise BackupError('the rows are not in timestamp order')
                yield previous, group
                group = []
            group.append(row)
            previous = stamp
    if group:
        yield previous, group


@dataclass
class _Counts:
    db_rows: int = 0
    file_rows: int = 0
    only_in_db: int = 0
    only_in_file: int = 0
    value_diffs: int = 0


def _compare_days(
    db_pages: Iterator[list[tuple]], file_pages: Iterator[list[tuple]]
) -> _Counts:
    """Compare a day's rows from the database with the same day from its file.

    The two are merged on the timestamp, which both sort the same way. Inside
    one timestamp rows are matched by (ticker, strike, expiry) through a dict
    and not by order: Postgres sorts tickers by its collation and Python by code
    point, and the two can disagree. One timestamp holds a few thousand rows at
    most, so the dicts stay small however long the day is.
    """
    counts = _Counts()
    db_groups, file_groups = _row_groups(db_pages), _row_groups(file_pages)
    db, file = next(db_groups, None), next(file_groups, None)
    while db is not None or file is not None:
        if file is None or (db is not None and db[0] < file[0]):
            counts.db_rows += len(db[1])
            counts.only_in_db += len(db[1])
            db = next(db_groups, None)
        elif db is None or file[0] < db[0]:
            counts.file_rows += len(file[1])
            counts.only_in_file += len(file[1])
            file = next(file_groups, None)
        else:
            counts.db_rows += len(db[1])
            counts.file_rows += len(file[1])
            db_by_key = _by_key(db[1])
            file_by_key = _by_key(file[1])
            counts.only_in_db += len(db_by_key.keys() - file_by_key.keys())
            counts.only_in_file += len(file_by_key.keys() - db_by_key.keys())
            counts.value_diffs += sum(
                1 for k in db_by_key.keys() & file_by_key.keys() if db_by_key[k] != file_by_key[k]
            )
            db, file = next(db_groups, None), next(file_groups, None)
    return counts


def _by_key(rows: list[tuple]) -> dict[tuple, tuple]:
    by_key = {tuple(row[i] for i in _KEY_IN_TIMESTAMP): row for row in rows}
    if len(by_key) != len(rows):
        raise BackupError('a timestamp repeats a key')
    return by_key


def _file_pages(parquet: pq.ParquetFile, batch_rows: int) -> Iterator[list[tuple]]:
    """A day file's rows as tuples in COLUMNS order, `batch_rows` at a time."""
    for batch in parquet.iter_batches(batch_size=batch_rows):
        yield list(zip(*(column.to_pylist() for column in batch.columns)))


@contextmanager
def _downloaded_day(s3, bucket: str, day: date) -> Iterator[pq.ParquetFile]:
    """Download a day's object to a temporary file and yield it as a ParquetFile.

    The object has to match what `upload_day` recorded about it: its sha256, its
    schema (the table's) and its row count. A file that does not is refused
    before anything is read from or written to the database. The temporary
    directory is gone when the block ends.
    """
    day_text = day.isoformat()
    key = object_key(day)
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') not in ('NoSuchKey', '404'):
            raise
        missing = True
    else:
        missing = False
    if missing:
        raise BackupError(f'{day_text}: no object in R2')
    metadata = response.get('Metadata', {})
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f'{day_text}.parquet'
        digest = hashlib.sha256()
        body = response['Body']
        with path.open('wb') as out:
            while chunk := body.read(1 << 20):
                out.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != metadata.get('sha256'):
            raise BackupError(f'{day_text}: the file does not match its sha256 metadata')
        try:
            parquet = pq.ParquetFile(path)
        except pa.ArrowException:
            parquet = None
        if parquet is None:  # raised here: Arrow's text must not ride along as context
            raise BackupError(f'{day_text}: the file is not a readable Parquet file')
        try:
            if not parquet.schema_arrow.equals(ARROW_SCHEMA):
                raise BackupError(f"{day_text}: the file's schema is not the table's")
            if str(parquet.metadata.num_rows) != metadata.get('rows'):
                raise BackupError(f'{day_text}: the file does not hold the rows its metadata says')
            yield parquet
        finally:
            parquet.close()


def verify_day(
    conn: PgConnection, s3, bucket: str, day: date, page_rows: int = PAGE_ROWS
) -> VerifyResult:
    """Compare a day in the database with its file in R2.

    The file is downloaded and checked first, then the day is read from the
    database in one snapshot and merged against it. A day is `ok` when both
    sides hold the same rows with the same values, ids and created_at included.
    """
    with _downloaded_day(s3, bucket, day) as parquet:
        with _read_snapshot(conn) as cur:
            counts = _compare_days(
                iter_day_pages(cur, day, page_rows), _file_pages(parquet, page_rows)
            )
    return VerifyResult(
        day=day,
        db_rows=counts.db_rows,
        file_rows=counts.file_rows,
        only_in_db=counts.only_in_db,
        only_in_file=counts.only_in_file,
        value_diffs=counts.value_diffs,
    )


_INSERT_HEAD = (
    'INSERT INTO strike_exposures (' + ', '.join(f'"{c}"' for c in COLUMNS) + ') VALUES '
)
_ROW_PLACEHOLDERS = '(' + ', '.join(['%s'] * len(COLUMNS)) + ')'
# Only the unique key is the conflict target. A restored row whose id is held by
# a different row then raises on the primary key instead of being skipped.
_INSERT_TAIL = ' ON CONFLICT (date, "timestamp", ticker, strike, expiry) DO NOTHING'
_LOCK_SQL = 'LOCK TABLE strike_exposures IN SHARE ROW EXCLUSIVE MODE'
_SEQUENCE_NAME_SQL = "SELECT pg_get_serial_sequence('strike_exposures', 'id')"
_SETVAL_SQL = 'SELECT setval(%s, GREATEST((SELECT max(id) FROM strike_exposures), %s))'


def _insert_batch(cur: PgCursor, rows: list[tuple], day: date, number: int) -> int:
    """Insert one batch and return how many rows went in."""
    values = ', '.join([_ROW_PLACEHOLDERS] * len(rows))
    params = [value for row in rows for value in row]
    try:
        cur.execute(_INSERT_HEAD + values + _INSERT_TAIL, params)
    except (psycopg2.IntegrityError, psycopg2.DataError) as exc:
        # The server's text quotes the offending key or value, so only the
        # class is kept, and it is raised below, outside the handler.
        rejected = type(exc).__name__
    else:
        return cur.rowcount
    raise BackupError(f'{day.isoformat()}: batch {number} was rejected by the table ({rejected})')


def _insert_day(conn: PgConnection, parquet: pq.ParquetFile, day: date) -> int:
    """Insert a day's file in one transaction; return how many rows went in."""
    inserted = 0
    with _write_transaction(conn) as cur:
        for number, rows in enumerate(_file_pages(parquet, RESTORE_BATCH), start=1):
            inserted += _insert_batch(cur, rows, day, number)
    return inserted


def _move_id_sequence(conn: PgConnection) -> None:
    """Move the id sequence past every id in the table, in one short transaction.

    The table is locked in SHARE ROW EXCLUSIVE mode first, which keeps live
    writers (and so `nextval`) out until the `setval` commits; without it an
    id handed out between the read and the `setval` could be handed out again.
    GREATEST keeps the sequence from moving backwards. In production it is
    ahead of max(id), because rolled-back inserts use ids up.
    """
    with _write_transaction(conn) as cur:
        cur.execute(_LOCK_SQL)
        cur.execute(_SEQUENCE_NAME_SQL)
        name = cur.fetchone()[0]
        if name is None:
            raise BackupError('strike_exposures.id has no sequence')
        # `name` comes from the catalog, already quoted for use as an identifier.
        # last_value is read from the sequence itself: pg_sequences shows NULL to
        # a role without the privilege, and GREATEST ignores NULL.
        cur.execute(sql.SQL('SELECT last_value FROM {}').format(sql.SQL(name)))
        last_value = cur.fetchone()[0]
        if last_value is None:
            raise BackupError('the id sequence has no last_value')
        cur.execute(_SETVAL_SQL, (name, last_value))


def restore_day(
    conn: PgConnection,
    s3,
    bucket: str,
    day: date,
    apply: bool,
    page_rows: int = PAGE_ROWS,
) -> int:
    """Put a day's file back into the table; return the rows (to be) inserted.

    Without `apply` nothing is written: it reads the day and counts the file's
    rows whose unique key the table does not have. With `apply` it inserts the
    file in batches of RESTORE_BATCH inside one transaction, with the original
    ids and created_at, so a rejected batch (an id held by a different row)
    undoes the whole day. A row whose key is already there is left alone, so
    restoring a day twice inserts nothing the second time.

    If rows went in, the id sequence is then moved past them. That is a second
    transaction: when it fails the rows stay, and the error says so and how
    many, because the sequence has to be moved by hand before the writers
    insert again.
    """
    with _downloaded_day(s3, bucket, day) as parquet:
        if not apply:
            with _read_snapshot(conn) as cur:
                counts = _compare_days(
                    iter_day_pages(cur, day, page_rows), _file_pages(parquet, page_rows)
                )
            return counts.only_in_file
        inserted = _insert_day(conn, parquet, day)
    if inserted:
        try:
            _move_id_sequence(conn)
        except (BackupError, psycopg2.Error) as exc:
            cause = exc
        else:
            return inserted
        raise BackupError(
            f'{day.isoformat()}: {inserted} row(s) restored, but the id sequence was not moved; '
            'move it by hand before the writers run'
        ) from cause
    return inserted


def _today_et() -> date:
    return datetime.now(ZoneInfo('America/New_York')).date()


def _log_failure(label: str, exc: BaseException) -> None:
    """One line on stderr: the date (or step) and the error class. A BackupError
    adds its message, which is fixed text by contract; any other error's text
    can hold a host, a path or a key, so it is never printed."""
    detail = f' ({exc})' if isinstance(exc, BackupError) else ''
    print(f'FAILED {label}: {type(exc).__name__}{detail}', file=sys.stderr, flush=True)


def _dates_line(label: str, days: list[date]) -> str:
    shown = f' ({format_dates([d.isoformat() for d in days])})' if days else ''
    return f'{label}: {len(days)}{shown}'


def _export(args: argparse.Namespace, conn, s3, bucket: str, today: date) -> int:
    try:
        plan = plan_days(conn, s3, bucket, today, verify_counts=args.verify_counts)
    except _RUN_FAILURES as exc:
        _log_failure('planning', exc)
        return 1
    days = [args.date] if args.date is not None else plan.due[: args.limit_days]
    # The stored mark covers the whole table, so only a run that did everything
    # that was due may move it.
    partial = args.date is not None or len(days) < len(plan.due)
    print(f'counting: {plan.scope}', flush=True)
    print(
        f'{len(plan.due)} day(s) due; exporting {len(days)}'
        + (' (partial run)' if partial else ''),
        flush=True,
    )
    failed: list[date] = []
    with tempfile.TemporaryDirectory() as tmp:
        for day in days:
            started = time.monotonic()
            result = None
            try:
                result = write_day_parquet(conn, day, Path(tmp))
                if result is None:
                    print(f'{day.isoformat()}: no rows, skipped', flush=True)
                    continue
                if not args.dry_run:
                    upload_day(s3, bucket, result)
                print(
                    f'{day.isoformat()}: {result.rows} rows, {result.size} bytes, '
                    f'{time.monotonic() - started:.1f}s'
                    + (' (dry run, not uploaded)' if args.dry_run else ''),
                    flush=True,
                )
            except _RUN_FAILURES as exc:
                failed.append(day)
                _log_failure(day.isoformat(), exc)
                if conn.closed:
                    # Every later day would fail the same way; a re-run resumes.
                    print('connection lost; stopping the run', file=sys.stderr, flush=True)
                    break
            finally:
                if result is not None:
                    result.path.unlink(missing_ok=True)
    if failed:
        print(f'{len(failed)} day(s) failed; the state was not advanced', file=sys.stderr)
        return 1
    if args.dry_run or partial:
        print('state not advanced', flush=True)
        return 0
    try:
        write_state(s3, bucket, plan.high_water_id)
    except _RUN_FAILURES as exc:
        _log_failure('state', exc)
        return 1
    print(f'done; high-water id {plan.high_water_id}', flush=True)
    return 0


def _status(conn, s3, bucket: str, today: date) -> int:
    """Print the database and R2 days side by side. It checks every day's count."""
    try:
        plan = plan_days(conn, s3, bucket, today, verify_counts=True)
    except _RUN_FAILURES as exc:
        _log_failure('status', exc)
        return 1
    span = (
        f' ({plan.db_days[0].isoformat()} to {plan.db_days[-1].isoformat()})'
        if plan.db_days
        else ''
    )
    # Not plan.scope: that says "--verify-counts", a flag status was never given.
    print('counting: every day (status)')
    print(f'database days: {len(plan.db_days)}{span}')
    print(f'exported days: {len(plan.object_days)}')
    print(_dates_line('missing', plan.missing))
    print(_dates_line('stale', plan.stale))
    print(f'high-water id: {plan.high_water_id}')
    return 0


def _verify(args: argparse.Namespace, conn, s3, bucket: str) -> int:
    """Verify each --date; exit 0 only if every day is ok."""
    problems = 0
    for day in dict.fromkeys(args.date):  # in the order given, each once
        try:
            result = verify_day(conn, s3, bucket, day)
        except _RUN_FAILURES as exc:
            problems += 1
            _log_failure(day.isoformat(), exc)
            if conn.closed:
                print('connection lost; stopping the run', file=sys.stderr, flush=True)
                break
            continue
        if result.ok:
            print(f'{day.isoformat()}: ok, {result.db_rows} rows', flush=True)
            continue
        problems += 1
        print(
            f'{day.isoformat()}: MISMATCH db rows {result.db_rows}, file rows '
            f'{result.file_rows}, only in db {result.only_in_db}, only in file '
            f'{result.only_in_file}, changed {result.value_diffs}',
            flush=True,
        )
    return 1 if problems else 0


def _restore(args: argparse.Namespace, conn, s3, bucket: str) -> int:
    day = args.date.isoformat()
    try:
        rows = restore_day(conn, s3, bucket, args.date, apply=args.apply)
    except _RUN_FAILURES as exc:
        _log_failure(day, exc)
        return 1
    if args.apply:
        print(f'{day}: inserted {rows} rows', flush=True)
    else:
        print(f'{day}: would insert {rows} rows (a dry run; add --apply to write)', flush=True)
    return 0


def _positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError('must be at least 1')
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Back up strike_exposures to R2.')
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export', help='write the days that are due to R2')
    export.add_argument(
        '--date', type=date.fromisoformat, help='export only this day, due or not'
    )
    export.add_argument(
        '--limit-days', type=_positive_int, help='export at most this many due days'
    )
    export.add_argument(
        '--verify-counts',
        action='store_true',
        help="compare every day's row count with its object (minutes on prod)",
    )
    export.add_argument(
        '--dry-run',
        action='store_true',
        help='read and write the files locally, upload nothing, keep no state',
    )
    commands.add_parser(
        'status', help="list database and R2 days, checking every day's count"
    )
    verify = commands.add_parser(
        'verify', help='compare days in the database with their files in R2'
    )
    verify.add_argument(
        '--date',
        type=date.fromisoformat,
        action='append',
        required=True,
        help='a day to verify; repeat for more',
    )
    restore = commands.add_parser(
        'restore', help='put a day back from its file in R2 (a dry run unless --apply)'
    )
    restore.add_argument('--date', type=date.fromisoformat, required=True)
    restore.add_argument(
        '--apply',
        action='store_true',
        help='write the rows; needs the owner go-ahead on production',
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    load_env_file(Path(__file__).resolve().parent.parent / '.env.local')
    absent = [name for name in _REQUIRED_ENV if not os.environ.get(name, '').strip()]
    if absent:
        print(f'missing environment variable(s): {", ".join(absent)}', file=sys.stderr)
        return 2
    today = _today_et()
    if args.command == 'export' and args.date is not None and args.date >= today:
        print(f'--date must be before today ({today.isoformat()})', file=sys.stderr)
        return 2
    bucket = os.environ['R2_BUCKET_FULLTAPE']
    try:
        s3 = boto3.client(
            's3',
            endpoint_url=os.environ['R2_ENDPOINT_URL'],
            aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
            aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
            region_name='auto',
            verify=True,
            config=Config(
                signature_version='s3v4', retries={'mode': 'standard', 'max_attempts': 5}
            ),
        )
    except (ValueError, BotoCoreError) as exc:
        # botocore's text is "Invalid endpoint: <url>", and the URL holds the
        # Cloudflare account id: log the class only. It is a config error.
        _log_failure('R2 client', exc)
        return 2
    try:
        conn = connect_with_retry(
            os.environ['DATABASE_URL'],
            error_detail=False,
            connect_timeout=30,
            application_name='strike-exposures-backup',
        )
    except psycopg2.Error as exc:
        _log_failure('database connection', exc)
        return 1
    try:
        if args.command == 'status':
            return _status(conn, s3, bucket, today)
        if args.command == 'verify':
            return _verify(args, conn, s3, bucket)
        if args.command == 'restore':
            return _restore(args, conn, s3, bucket)
        return _export(args, conn, s3, bucket, today)
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
