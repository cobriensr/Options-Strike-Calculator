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
- `main` is the CLI: `export` and `status`.

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

Exit codes: 0 ok, 1 a day (or the plan) failed, 2 bad config or arguments.
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
    status = conn.info.transaction_status
    if status == TRANSACTION_STATUS_UNKNOWN:  # what psycopg2 reports once closed
        raise BackupError(f'the connection is closed (status {status})')
    if status != TRANSACTION_STATUS_IDLE:
        raise BackupError(
            f'the connection is already inside a transaction (status {status})'
        )
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


def iter_day_pages(
    cur: PgCursor, day: date, page_rows: int = PAGE_ROWS
) -> Iterator[list[tuple]]:
    """Yield one day's rows in unique-key order, `page_rows` at a time.

    Each page after the first starts after the last key of the page before it
    (keyset paging on the unique index). Never OFFSET, which re-reads every
    skipped row: 117 s at offset 20M. A page shorter than `page_rows` is the
    last one.
    """
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
_DELTA_SCOPE = 'delta'


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
        if verify_counts:
            scope = 'every day: --verify-counts'
        elif last_id is None:
            scope = 'every day: no stored high-water mark'
        elif high_water_id - last_id > DELTA_MAX_IDS:
            scope = f'every day: ids moved more than {DELTA_MAX_IDS} since the stored mark'
        else:
            scope = _DELTA_SCOPE
        gained: set[date] = set()
        if scope == _DELTA_SCOPE:
            cur.execute(_DELTA_SQL, (last_id,))
            gained = {row[0] for row in cur.fetchall()}
        for day in db_days:
            counted = scope != _DELTA_SCOPE or day in gained
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
    print(f'counting: {plan.scope}')
    print(f'database days: {len(plan.db_days)}{span}')
    print(f'exported days: {len(plan.object_days)}')
    print(_dates_line('missing', plan.missing))
    print(_dates_line('stale', plan.stale))
    print(f'high-water id: {plan.high_water_id}')
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
        return _export(args, conn, s3, bucket, today)
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
