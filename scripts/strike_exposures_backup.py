"""Read one session day of strike_exposures and write it as exact-typed Parquet.

strike_exposures (74M rows, insert-only) was never backed up, and about 96 % of
it exists nowhere else. The plan is one Parquet file per session day in the
private R2 bucket: docs/superpowers/specs/strike-exposures-backup-2026-11-11.md.

This part of the module reads and writes one day:

- `_read_snapshot` is the one way to read in a snapshot: a REPEATABLE READ,
  READ ONLY transaction on a connection that was idle, with the connection's
  autocommit put back afterwards. Later reads (the planning query, `verify`)
  use it too.
- `iter_day_pages` keyset-pages the day on the table's unique key.
- `write_day_parquet` reads the day in a snapshot, checks the rows written
  against the count taken from the same snapshot, and returns a `DayFile`
  (None for a day with no rows). Whatever goes wrong, no file is left behind.

The types are exact. NUMERIC columns keep the column's own precision and scale
as decimal128 (never float), timestamptz is timestamp[us, tz=UTC], and the
`id` column is kept so a restore can put the original rows back. Nullability
follows the table, so a NULL in a NOT NULL column fails the write.

A `BackupError` message carries the date and counts only, never a cell value.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from psycopg2.extensions import TRANSACTION_STATUS_IDLE
from psycopg2.extensions import connection as PgConnection
from psycopg2.extensions import cursor as PgCursor

# 12 to 14 MiB of JSON per page, 0.76 to 1.29 s on the unique-key keyset.
PAGE_ROWS = 20_000
# 2x the 30 s probe budget: a page must never get near it.
STATEMENT_TIMEOUT = '60s'

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
    """A day could not be exported. The message names the date and counts only."""


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
    """
    if conn.info.transaction_status != TRANSACTION_STATUS_IDLE:
        raise BackupError('the connection is already inside a transaction')
    previous = conn.autocommit
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            try:
                cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
                yield cur
            finally:
                cur.execute('ROLLBACK')
    finally:
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
    A database error propagates as it is; a ROLLBACK that fails on top of it
    keeps it as `__context__`.
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
