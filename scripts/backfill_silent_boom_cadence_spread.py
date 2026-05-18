#!/usr/bin/env python
"""One-shot backfill of silent_boom_alerts.first_min_share +
spread_in_bucket for the 64k existing alerts.

Reads the Eod-Full-Tape parquet day-by-day and recomputes both
features from the raw tick stream at each alert's bucket_ct. Updates
silent_boom_alerts in place.

After this lands, the per-fire detector path (migration #171,
detect-silent-boom.ts) carries cadence + spread forward on every new
alert, and the ML training set has both features fully populated
across the 93-day history.

Idempotent — only touches rows where first_min_share IS NULL OR
spread_in_bucket IS NULL. Re-runs are safe.

Run:
    ml/.venv/bin/python scripts/backfill_silent_boom_cadence_spread.py
    ml/.venv/bin/python scripts/backfill_silent_boom_cadence_spread.py \
        --date 2026-05-15
    ml/.venv/bin/python scripts/backfill_silent_boom_cadence_spread.py \
        --dry-run
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
FULLTAPE_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'


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


def list_fulltape_dates() -> list[str]:
    """Return sorted YYYY-MM-DD list of available fulltape days."""
    out: list[str] = []
    for p in FULLTAPE_DIR.glob('*-fulltape.parquet'):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-fulltape\.parquet', p.name)
        if m:
            out.append(m.group(1))
    return sorted(out)


def fetch_alerts_needing_backfill(
    conn: psycopg2.extensions.connection, date_str: str,
) -> list[tuple]:
    """Return alerts on `date_str` whose first_min_share OR
    spread_in_bucket is NULL. Each row: (id, option_chain_id,
    bucket_ct)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, option_chain_id, bucket_ct
              FROM silent_boom_alerts
             WHERE date = %s::date
               AND (first_min_share IS NULL OR spread_in_bucket IS NULL)
             ORDER BY id
            """,
            (date_str,),
        )
        return cur.fetchall()


def compute_features_from_parquet(
    date_str: str, alerts: list[tuple],
) -> dict[int, tuple[float | None, float | None]]:
    """Return {alert_id: (first_min_share, spread_in_bucket)} for
    every alert on `date_str`. Reads the day's fulltape parquet once
    and computes both features in a single pass."""
    if not alerts:
        return {}
    path = FULLTAPE_DIR / f'{date_str}-fulltape.parquet'
    if not path.exists():
        print(f'  [{date_str}] WARN parquet missing — skipping {len(alerts)} alerts',
              file=sys.stderr)
        return {}

    # Pre-filter — read only rows on the chains we care about.
    chain_ids = list({a[1] for a in alerts})
    df = pd.read_parquet(
        path,
        columns=[
            'executed_at', 'option_chain_id', 'price', 'size',
            'canceled', 'nbbo_bid', 'nbbo_ask',
        ],
        filters=[('option_chain_id', 'in', chain_ids)],
    )
    if df.empty:
        return {}
    # Drop canceled prints. canceled is bool in the parquet.
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(
            ['f', 'false', '0', '']
        )]
    # Cast price/size out of Decimal so numpy works.
    df['price'] = pd.to_numeric(df['price'], errors='coerce')
    df['size'] = pd.to_numeric(df['size'], errors='coerce')
    df = df.dropna(subset=['price', 'size'])
    df = df[df['price'] > 0]
    if df.empty:
        return {}
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')

    # Build a lookup: for each alert (chain, bucket_ct), aggregate
    # the prints inside its 5-min bucket. The bucket starts at
    # date_bin(5min, executed_at, 2000-01-01), which floor('5min')
    # gives us.
    df['bucket'] = df['executed_at'].dt.floor('5min')

    # H2 cadence: prints in the first 60s of the bucket.
    df['first_min_size'] = np.where(
        df['executed_at'] < df['bucket'] + pd.Timedelta(minutes=1),
        df['size'],
        0,
    )

    # H5 spread: size-weighted relative NBBO spread.
    nbbo_bid = pd.to_numeric(df['nbbo_bid'], errors='coerce')
    nbbo_ask = pd.to_numeric(df['nbbo_ask'], errors='coerce')
    mid = (nbbo_bid + nbbo_ask) / 2
    rel_spread = np.where(
        (nbbo_bid > 0) & (nbbo_ask > 0) & (mid > 0),
        (nbbo_ask - nbbo_bid) / mid,
        np.nan,
    )
    df['spread_numerator'] = rel_spread * df['size']
    df['spread_denom'] = np.where(np.isnan(rel_spread), 0, df['size'])

    agg = df.groupby(['option_chain_id', 'bucket'], sort=False).agg(
        size_sum=('size', 'sum'),
        first_min_size_sum=('first_min_size', 'sum'),
        spread_num_sum=('spread_numerator', 'sum'),
        spread_den_sum=('spread_denom', 'sum'),
    ).reset_index()

    # Build lookup keyed by (chain, bucket_ts) for fast per-alert
    # join. Use ISO strings as keys to dodge tz-comparison surprises.
    feat_by_key: dict[tuple[str, str], tuple[float | None, float | None]] = {}
    for _, row in agg.iterrows():
        size_sum = float(row['size_sum'])
        if size_sum <= 0:
            continue
        fms = float(row['first_min_size_sum'] / size_sum)
        if row['spread_den_sum'] > 0:
            sib: float | None = float(
                row['spread_num_sum'] / row['spread_den_sum']
            )
        else:
            sib = None
        key = (row['option_chain_id'], row['bucket'].isoformat())
        feat_by_key[key] = (fms, sib)

    out: dict[int, tuple[float | None, float | None]] = {}
    for alert_id, chain_id, bucket_ct in alerts:
        # bucket_ct from Postgres comes in as a timezone-aware
        # datetime. Floor it to 5min UTC and match the parquet's
        # floored bucket.
        if bucket_ct.tzinfo is None:
            bucket_ct = bucket_ct.replace(tzinfo=timezone.utc)
        bucket = pd.Timestamp(bucket_ct).floor('5min')
        if bucket.tz is None:
            bucket = bucket.tz_localize('UTC')
        else:
            bucket = bucket.tz_convert('UTC')
        feats = feat_by_key.get((chain_id, bucket.isoformat()))
        if feats is None:
            out[alert_id] = (None, None)
        else:
            out[alert_id] = feats
    return out


def apply_updates(
    conn: psycopg2.extensions.connection,
    feats: dict[int, tuple[float | None, float | None]],
    dry_run: bool,
) -> int:
    """UPDATE first_min_share + spread_in_bucket on each alert id.
    Returns count of rows actually updated. Skips rows where both
    feats are None."""
    rows = [
        (alert_id, fms, sib)
        for alert_id, (fms, sib) in feats.items()
        if fms is not None or sib is not None
    ]
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            UPDATE silent_boom_alerts AS s
               SET first_min_share = v.fms::numeric,
                   spread_in_bucket = v.sib::numeric
              FROM (VALUES %s) AS v(id, fms, sib)
             WHERE s.id = v.id
            """,
            rows,
            template='(%s, %s, %s)',
            page_size=10000,
        )
        conn.commit()
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date', help='YYYY-MM-DD; single-day mode'
    )
    parser.add_argument(
        '--from-date', help='YYYY-MM-DD inclusive lower bound'
    )
    parser.add_argument(
        '--to-date', help='YYYY-MM-DD inclusive upper bound'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Compute updates but do not commit.',
    )
    args = parser.parse_args()
    if args.date and (args.from_date or args.to_date):
        parser.error(
            '--date is mutually exclusive with --from-date / --to-date'
        )

    load_env()
    db_url = (
        os.environ.get('DATABASE_URL_UNPOOLED')
        or os.environ['DATABASE_URL']
    )
    conn = psycopg2.connect(db_url)

    if args.date:
        dates = [args.date]
    else:
        all_dates = list_fulltape_dates()
        dates = [
            d for d in all_dates
            if (not args.from_date or d >= args.from_date)
            and (not args.to_date or d <= args.to_date)
        ]
    print(
        f'[sb-cadence-spread-backfill] {len(dates)} days; '
        f'dry_run={args.dry_run}'
    )

    grand_updated = 0
    grand_alerts = 0
    t0 = time.time()
    try:
        for date_str in dates:
            td = time.time()
            alerts = fetch_alerts_needing_backfill(conn, date_str)
            if not alerts:
                continue
            grand_alerts += len(alerts)
            feats = compute_features_from_parquet(date_str, alerts)
            updated = apply_updates(conn, feats, args.dry_run)
            grand_updated += updated
            print(
                f'  [{date_str}] alerts={len(alerts):>4,} '
                f'updated={updated:>4,} in {time.time() - td:.1f}s'
            )
    finally:
        conn.close()

    print(
        f'[sb-cadence-spread-backfill] DONE — '
        f'alerts_seen={grand_alerts:,} updated={grand_updated:,} '
        f'dry_run={args.dry_run} elapsed={time.time() - t0:.1f}s'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
