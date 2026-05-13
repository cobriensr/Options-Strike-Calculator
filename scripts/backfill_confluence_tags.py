#!/usr/bin/env python
"""Backfill confluence_tickers on historical interval_ba_alerts rows.

Phase 7 of docs/superpowers/specs/interval-ba-confluence-2026-05-13.md.

The live handler tags every NEW fire asymmetrically: the row written
FIRST has confluence_tickers=[] (no partners yet recorded); the later
row enumerates the earlier one. This script re-tags the entire table
symmetrically — both halves of a confluence pair end up with each
other in their confluence_tickers list.

Implementation: one SQL pass with a self-join window on
``|a.fired_at - b.fired_at| <= --window-sec``. The join is grouped by
``a.id`` and aggregates DISTINCT b.ticker (excluding self) into a
sorted TEXT[]. COALESCE to ``ARRAY[]::TEXT[]`` so solo fires land as
the empty array instead of NULL — the API contract is "always [], not
NULL" (see api/interval-ba-feed.ts:170 ?? [] coalesce).

Idempotency:
  - Default: skip rows where confluence_tickers IS NOT NULL (incremental
    re-run only touches new rows). Each fresh run only writes the rows
    that haven't been backfilled yet.
  - --force: re-tag ALL rows. Use when the window changes or when a
    partial backfill needs full re-computation.

Live-table safety: this script writes during regular market hours
would race the uw-stream handler's INSERTs. The UPDATE itself is
row-level safe (the rows it updates are pre-existing IDs), but a fire
that ARRIVES between this script's SELECT and UPDATE could land with
an empty confluence_tickers that ought to have referenced an
older-still row. Practical mitigation: run AFTER market close (15:00
CT or later) so the handler is idle.

Usage:
    python3 scripts/backfill_confluence_tags.py --dry-run
    python3 scripts/backfill_confluence_tags.py            # default
    python3 scripts/backfill_confluence_tags.py --force    # re-tag all
    python3 scripts/backfill_confluence_tags.py --window-sec 90
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys

import psycopg2

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'

# Default window matches uw-stream/src/handlers/interval_ba.py
# _CONFLUENCE_WINDOW_SEC. Calibrated by the 2026-05-12 confluence-vs-
# solo analysis (docs/tmp/interval-ba-confluence-vs-solo-...).
DEFAULT_WINDOW_SEC = 90


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


def fetch_summary(cur) -> dict[str, int]:
    """Pre/post count buckets so the user sees what changed."""
    cur.execute(
        """
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE confluence_tickers IS NULL)        AS null_rows,
          COUNT(*) FILTER (WHERE confluence_tickers = ARRAY[]::TEXT[]) AS solo_rows,
          COUNT(*) FILTER (WHERE array_length(confluence_tickers, 1) > 0) AS partnered_rows
        FROM interval_ba_alerts
        """,
    )
    row = cur.fetchone()
    if row is None:
        return {'total': 0, 'null_rows': 0, 'solo_rows': 0, 'partnered_rows': 0}
    return {
        'total': int(row[0]),
        'null_rows': int(row[1]),
        'solo_rows': int(row[2]),
        'partnered_rows': int(row[3]),
    }


def backfill(
    cur,
    *,
    window_sec: int,
    force: bool,
    dry_run: bool,
) -> int:
    """Run the symmetric confluence-tag UPDATE.

    Returns the number of rows updated. With ``dry_run=True`` runs a
    SELECT that mimics the UPDATE's row set but doesn't mutate.
    """
    # The CTE builds (id, sorted-partner-array) for every row in scope.
    # FILTER (WHERE b.id IS NOT NULL) keeps solo rows in the result
    # with empty arrays — the COALESCE on the outer side then yields
    # ARRAY[]::TEXT[] for them.
    where_clause = '' if force else 'WHERE a.confluence_tickers IS NULL'
    sql = f"""
    WITH partners AS (
      SELECT
        a.id,
        COALESCE(
          array_agg(DISTINCT b.ticker ORDER BY b.ticker)
            FILTER (WHERE b.id IS NOT NULL),
          ARRAY[]::TEXT[]
        ) AS partner_tickers
      FROM interval_ba_alerts a
      LEFT JOIN interval_ba_alerts b
        ON  b.id != a.id
        AND b.ticker != a.ticker
        AND b.option_type = a.option_type
        AND b.fired_at BETWEEN
              a.fired_at - make_interval(secs => %s)
          AND a.fired_at + make_interval(secs => %s)
      {where_clause}
      GROUP BY a.id
    )
    UPDATE interval_ba_alerts t
    SET confluence_tickers = p.partner_tickers
    FROM partners p
    WHERE t.id = p.id
      AND (t.confluence_tickers IS DISTINCT FROM p.partner_tickers)
    """
    params = (window_sec, window_sec)
    if dry_run:
        # In dry-run mode we don't run the UPDATE. Estimate how many
        # rows WOULD change by running the SELECT side of the CTE and
        # comparing against current confluence_tickers.
        cur.execute(
            f"""
            WITH partners AS (
              SELECT
                a.id,
                a.confluence_tickers AS current_value,
                COALESCE(
                  array_agg(DISTINCT b.ticker ORDER BY b.ticker)
                    FILTER (WHERE b.id IS NOT NULL),
                  ARRAY[]::TEXT[]
                ) AS partner_tickers
              FROM interval_ba_alerts a
              LEFT JOIN interval_ba_alerts b
                ON  b.id != a.id
                AND b.ticker != a.ticker
                AND b.option_type = a.option_type
                AND b.fired_at BETWEEN
                      a.fired_at - make_interval(secs => %s)
                  AND a.fired_at + make_interval(secs => %s)
              {where_clause}
              GROUP BY a.id, a.confluence_tickers
            )
            SELECT COUNT(*)
            FROM partners
            WHERE current_value IS DISTINCT FROM partner_tickers
            """,
            params,
        )
        row = cur.fetchone()
        return int(row[0]) if row is not None else 0
    cur.execute(sql, params)
    return cur.rowcount


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--window-sec',
        type=int,
        default=DEFAULT_WINDOW_SEC,
        help='Symmetric confluence window in seconds (default: %(default)s).',
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='Re-tag every row, not just rows with NULL confluence_tickers.',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Count rows that WOULD change; do not write.',
    )
    args = parser.parse_args()

    load_env()
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        with conn.cursor() as cur:
            before = fetch_summary(cur)
            print('Before:')
            print(f'  total              : {before["total"]:>7,}')
            print(f'  NULL               : {before["null_rows"]:>7,}')
            print(f'  empty (solo)       : {before["solo_rows"]:>7,}')
            print(f'  populated (partner): {before["partnered_rows"]:>7,}')

            changed = backfill(
                cur,
                window_sec=args.window_sec,
                force=args.force,
                dry_run=args.dry_run,
            )

            if args.dry_run:
                print(
                    f'\nDRY RUN: {changed:,} rows WOULD change '
                    f'(window={args.window_sec}s, force={args.force}).',
                )
                conn.rollback()
                return 0

            conn.commit()
            print(
                f'\nUpdated {changed:,} rows '
                f'(window={args.window_sec}s, force={args.force}).',
            )

            after = fetch_summary(cur)
            print('After:')
            print(f'  total              : {after["total"]:>7,}')
            print(f'  NULL               : {after["null_rows"]:>7,}')
            print(f'  empty (solo)       : {after["solo_rows"]:>7,}')
            print(f'  populated (partner): {after["partnered_rows"]:>7,}')

            # Sanity-check post-state. NULL rows should be 0 after a
            # default run (force=False also populates NULLs); a non-zero
            # count signals the UPDATE didn't reach the rows we expected
            # and the operator should investigate before re-running.
            if after['null_rows'] != 0:
                print(
                    f'\nWARNING: {after["null_rows"]:,} rows still have '
                    'NULL confluence_tickers after the run.',
                    file=sys.stderr,
                )
                return 1
    except psycopg2.Error as exc:
        conn.rollback()
        print(f'\nDB error: {exc}', file=sys.stderr)
        return 2
    finally:
        conn.close()

    return 0


if __name__ == '__main__':
    sys.exit(main())
