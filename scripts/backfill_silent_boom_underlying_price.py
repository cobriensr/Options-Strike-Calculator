#!/usr/bin/env python
"""Backfill underlying_price_at_spike on silent_boom_alerts.

Migration #152 added the column; rows inserted before the detector
update have NULL. This script reads each affected date's fulltape
parquet, computes the volume-weighted underlying spot for each alert's
5-min spike bucket, and UPDATEs the row.

Idempotent: gates on underlying_price_at_spike IS NULL so re-runs
are safe.

Usage:
    ml/.venv/bin/python scripts/backfill_silent_boom_underlying_price.py \
        [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'
BUCKET_MIN = 5


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def fetch_unbackfilled_dates(conn) -> list[str]:
    """Return sorted unique dates (YYYY-MM-DD) with at least one NULL
    underlying_price_at_spike row."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT DISTINCT date::text AS d
        FROM silent_boom_alerts
        WHERE underlying_price_at_spike IS NULL
        ORDER BY d ASC
        """
    )
    return [row[0] for row in cur.fetchall()]


def fetch_alerts_for_date(conn, target_date: str) -> list[tuple]:
    """Return [(id, option_chain_id, bucket_ct_utc), ...] for all rows
    on `target_date` lacking the underlying snapshot."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, bucket_ct
        FROM silent_boom_alerts
        WHERE date = %s::date
          AND underlying_price_at_spike IS NULL
        ORDER BY bucket_ct ASC
        """,
        (target_date,),
    )
    return cur.fetchall()


def compute_underlying_prices(
    parquet_path: Path,
    alerts: list[tuple],
) -> list[tuple]:
    """For each alert, compute volume-weighted underlying spot over its
    5-min bucket. Returns [(id, price | None), ...]."""
    chains = {a[1] for a in alerts}
    df = pd.read_parquet(
        parquet_path,
        columns=[
            'executed_at', 'option_chain_id', 'underlying_price',
            'size', 'canceled', 'price',
        ],
        filters=[('option_chain_id', 'in', list(chains))],
    )
    if df.empty:
        return [(a[0], None) for a in alerts]
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[
            df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])
        ]
    df = df[df['price'] > 0]
    # Coerce decimal128 → float64 (older fulltape parquets).
    for col in ('underlying_price', 'size'):
        df[col] = pd.to_numeric(df[col], errors='coerce').astype('float64')
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')

    out: list[tuple] = []
    for fire_id, chain, bucket_ct in alerts:
        bucket_start = (
            bucket_ct
            if isinstance(bucket_ct, datetime)
            else datetime.fromisoformat(str(bucket_ct))
        )
        if bucket_start.tzinfo is None:
            bucket_start = bucket_start.replace(tzinfo=df['executed_at'].dt.tz)
        bucket_end = bucket_start + timedelta(minutes=BUCKET_MIN)
        mask = (
            (df['option_chain_id'] == chain)
            & (df['executed_at'] >= bucket_start)
            & (df['executed_at'] < bucket_end)
            & df['underlying_price'].notna()
        )
        sub = df.loc[mask, ['underlying_price', 'size']]
        total_size = float(sub['size'].sum())
        if total_size <= 0:
            out.append((fire_id, None))
            continue
        vwap = float((sub['underlying_price'] * sub['size']).sum()) / total_size
        out.append((fire_id, vwap if vwap > 0 else None))
    return out


def update_batch(conn, rows: list[tuple]) -> int:
    """Bulk UPDATE silent_boom_alerts.underlying_price_at_spike."""
    if not rows:
        return 0
    cur = conn.cursor()
    execute_values(
        cur,
        """
        UPDATE silent_boom_alerts AS s
        SET underlying_price_at_spike = v.price::numeric
        FROM (VALUES %s) AS v(id, price)
        WHERE s.id = v.id
          AND s.underlying_price_at_spike IS NULL
        """,
        [(r[0], r[1]) for r in rows if r[1] is not None],
        template='(%s, %s)',
        page_size=500,
    )
    conn.commit()
    return sum(1 for r in rows if r[1] is not None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-date', help='YYYY-MM-DD inclusive')
    parser.add_argument('--to-date', help='YYYY-MM-DD inclusive')
    args = parser.parse_args()

    load_env()
    db_url = (
        os.environ.get('DATABASE_URL_UNPOOLED')
        or os.environ['DATABASE_URL']
    )
    conn = psycopg2.connect(db_url)

    all_dates = fetch_unbackfilled_dates(conn)
    if args.from_date:
        all_dates = [d for d in all_dates if d >= args.from_date]
    if args.to_date:
        all_dates = [d for d in all_dates if d <= args.to_date]
    print(f'[backfill] dates pending: {len(all_dates)}')

    grand_updated = 0
    grand_alerts = 0
    grand_missing_parquet = 0
    t0 = time.time()
    for d in all_dates:
        path = PARQUET_DIR / f'{d}-fulltape.parquet'
        if not path.exists():
            print(f'  [{d}] no parquet — skipping')
            grand_missing_parquet += 1
            continue
        td = time.time()
        alerts = fetch_alerts_for_date(conn, d)
        if not alerts:
            print(f'  [{d}] 0 alerts pending')
            continue
        results = compute_underlying_prices(path, alerts)
        updated = update_batch(conn, results)
        grand_alerts += len(alerts)
        grand_updated += updated
        nulled = sum(1 for _, p in results if p is None)
        print(
            f'  [{d}] alerts={len(alerts):4d} '
            f'updated={updated:4d} null={nulled:4d} '
            f'({time.time() - td:.1f}s)'
        )

    print(
        f'\n[backfill] DONE dates={len(all_dates):,} '
        f'alerts={grand_alerts:,} updated={grand_updated:,} '
        f'missing_parquet={grand_missing_parquet} '
        f'in {time.time() - t0:.1f}s'
    )


if __name__ == '__main__':
    main()
