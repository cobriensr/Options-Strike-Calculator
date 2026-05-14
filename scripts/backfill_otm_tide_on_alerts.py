#!/usr/bin/env python
"""Backfill mkt_tide_diff / mkt_tide_otm_diff via point-in-time flow_data lookups.

Targets two tables that pre-date the recent detector fixes:

- silent_boom_alerts.mkt_tide_otm_diff (column added in migration #149,
  100% NULL on existing rows).
- lottery_finder_fires.mkt_tide_diff (only ~30% populated — contiguous
  date range had a detector that wasn't writing the field).
- lottery_finder_fires.mkt_tide_otm_diff (0% populated — detector read
  the vestigial otm_ncp / otm_npp columns; bug fixed but not retroactive).

For each row, look up the latest flow_data row of source=market_tide
(or market_tide_otm) whose timestamp <= anchor_time and is within a
30-minute window. If found, write ncp - npp. Otherwise leave NULL.

Idempotent: only updates rows where the target column IS NULL.

Spec: docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md

Usage:
    ml/.venv/bin/python scripts/backfill_otm_tide_on_alerts.py
    ml/.venv/bin/python scripts/backfill_otm_tide_on_alerts.py --dry-run
    ml/.venv/bin/python scripts/backfill_otm_tide_on_alerts.py --table silent_boom_alerts --field mkt_tide_otm_diff
    ml/.venv/bin/python scripts/backfill_otm_tide_on_alerts.py --date 2026-05-13 --limit 100
"""

from __future__ import annotations

import argparse
import bisect
import os
import pathlib
import re
import sys
from datetime import datetime, timedelta

import psycopg2
from psycopg2.extras import execute_values

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'

WINDOW = timedelta(minutes=30)
PROGRESS_EVERY = 5000

# (table, field) → (anchor_time column, flow_data source)
JOBS: dict[tuple[str, str], tuple[str, str]] = {
    ('silent_boom_alerts', 'mkt_tide_otm_diff'): ('bucket_ct', 'market_tide_otm'),
    ('lottery_finder_fires', 'mkt_tide_diff'): ('trigger_time_ct', 'market_tide'),
    ('lottery_finder_fires', 'mkt_tide_otm_diff'): (
        'trigger_time_ct',
        'market_tide_otm',
    ),
}

VALID_TABLES = ('silent_boom_alerts', 'lottery_finder_fires', 'both')
VALID_FIELDS = ('mkt_tide_diff', 'mkt_tide_otm_diff', 'both')


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def load_flow_series(
    conn: psycopg2.extensions.connection,
    source: str,
) -> tuple[list[datetime], list[float]]:
    """Return parallel arrays (timestamps_sorted_asc, diffs).

    Both market_tide and market_tide_otm carry the data in the regular
    ncp / npp columns; otm_ncp / otm_npp are vestigial and NULL for this
    source. ~5k rows for either source — trivially fits in memory.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT timestamp, ncp, npp
            FROM flow_data
            WHERE source = %s
              AND ncp IS NOT NULL
              AND npp IS NOT NULL
            ORDER BY timestamp ASC
            """,
            (source,),
        )
        rows = cur.fetchall()
    timestamps = [r[0] for r in rows]
    diffs = [float(r[1]) - float(r[2]) for r in rows]
    return timestamps, diffs


def lookup_diff(
    timestamps: list[datetime],
    diffs: list[float],
    anchor: datetime,
) -> float | None:
    """Latest tick at or before anchor, within 30-min window.

    bisect_right gives the insertion point after duplicates of anchor.
    timestamps[idx-1] is the latest entry whose ts <= anchor.
    """
    if not timestamps:
        return None
    idx = bisect.bisect_right(timestamps, anchor)
    if idx == 0:
        return None
    ts = timestamps[idx - 1]
    if anchor - ts > WINDOW:
        return None
    return diffs[idx - 1]


def fetch_pending(
    conn: psycopg2.extensions.connection,
    table: str,
    field: str,
    anchor_col: str,
    only_date: str | None,
    limit: int | None,
) -> list[tuple[int, datetime]]:
    """Return [(id, anchor_time)] for rows where the field IS NULL."""
    where_parts = [f'{field} IS NULL', f'{anchor_col} IS NOT NULL']
    params: list[object] = []
    if only_date:
        where_parts.append('date = %s::date')
        params.append(only_date)
    where_sql = ' AND '.join(where_parts)
    limit_sql = ''
    if limit is not None:
        limit_sql = ' LIMIT %s'
        params.append(limit)
    sql = (
        f'SELECT id, {anchor_col} FROM {table} '
        f'WHERE {where_sql} ORDER BY {anchor_col} ASC{limit_sql}'
    )
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def apply_updates(
    conn: psycopg2.extensions.connection,
    table: str,
    field: str,
    rows: list[tuple[int, float]],
) -> None:
    """Batched UPDATE via VALUES join, 500 rows/query (psycopg2 page_size)."""
    if not rows:
        return
    sql = (
        f'UPDATE {table} AS t '
        f'SET {field} = v.val::numeric '
        f'FROM (VALUES %s) AS v(id, val) '
        f'WHERE t.id = v.id AND t.{field} IS NULL'
    )
    with conn.cursor() as cur:
        execute_values(cur, sql, rows, template='(%s, %s)', page_size=500)
        conn.commit()


def process_job(
    conn: psycopg2.extensions.connection,
    table: str,
    field: str,
    only_date: str | None,
    limit: int | None,
    dry_run: bool,
) -> None:
    anchor_col, source = JOBS[(table, field)]
    print(
        f'[backfill] {table}.{field} ← flow_data(source={source}) '
        f'via {anchor_col}',
        flush=True,
    )
    timestamps, diffs = load_flow_series(conn, source)
    print(
        f'  loaded {len(timestamps):,} flow_data ticks for source={source}',
        flush=True,
    )
    if not timestamps:
        print('  no flow_data ticks — skipping job', flush=True)
        return

    pending = fetch_pending(
        conn, table, field, anchor_col, only_date, limit,
    )
    print(f'  {len(pending):,} rows pending (NULL on {field})', flush=True)
    if not pending:
        return

    batch: list[tuple[int, float]] = []
    processed = 0
    updated = 0
    no_window = 0
    for row_id, anchor in pending:
        processed += 1
        val = lookup_diff(timestamps, diffs, anchor)
        if val is None:
            no_window += 1
        else:
            batch.append((row_id, val))
            if len(batch) >= 500 and not dry_run:
                apply_updates(conn, table, field, batch)
                updated += len(batch)
                batch = []
        if processed % PROGRESS_EVERY == 0:
            print(
                f'  [backfill] {table} {field}: processed={processed} '
                f'updated={updated + len(batch)} no_window={no_window}',
                flush=True,
            )

    if batch:
        if dry_run:
            updated += len(batch)
        else:
            apply_updates(conn, table, field, batch)
            updated += len(batch)
        batch = []

    print(
        f'  [backfill] {table} {field} final: scanned={processed} '
        f'updated={updated} no_window={no_window} '
        f'(dry_run={dry_run})',
        flush=True,
    )


def resolve_jobs(
    table_arg: str, field_arg: str,
) -> list[tuple[str, str]]:
    tables: list[str]
    fields: list[str]
    if table_arg == 'both':
        tables = ['silent_boom_alerts', 'lottery_finder_fires']
    else:
        tables = [table_arg]
    if field_arg == 'both':
        fields = ['mkt_tide_diff', 'mkt_tide_otm_diff']
    else:
        fields = [field_arg]
    out: list[tuple[str, str]] = []
    for t in tables:
        for f in fields:
            if (t, f) in JOBS:
                out.append((t, f))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--table',
        choices=VALID_TABLES,
        default='both',
        help='Restrict to one table (default: both).',
    )
    parser.add_argument(
        '--field',
        choices=VALID_FIELDS,
        default='both',
        help='Restrict to one field (default: both applicable).',
    )
    parser.add_argument(
        '--date',
        type=str,
        default=None,
        help='Restrict to one trading day (YYYY-MM-DD).',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Count what would be updated; do not UPDATE.',
    )
    parser.add_argument(
        '--limit',
        type=int,
        default=None,
        help='Only process first N pending rows per job (smoke test).',
    )
    args = parser.parse_args()
    load_env()

    jobs = resolve_jobs(args.table, args.field)
    if not jobs:
        sys.exit(
            f'No valid (table, field) jobs for table={args.table} '
            f'field={args.field}'
        )

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        for table, field in jobs:
            process_job(
                conn, table, field,
                only_date=args.date,
                limit=args.limit,
                dry_run=args.dry_run,
            )
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
