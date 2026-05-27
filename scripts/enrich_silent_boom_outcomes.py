#!/usr/bin/env python
"""Enrich silent_boom_alerts with peak/realized exits from parquet.

For each unenriched alert (enriched_at IS NULL), reads the post-spike
tick stream from the day's parquet and computes:
  - peak_ceiling_pct        (max post-bucket return %, look-ahead reference)
  - minutes_to_peak         (offset of the peak tick from the bucket start)
  - realized_30m_pct        (return at +30m from bucket start)
  - realized_60m_pct        (return at +60m)
  - realized_120m_pct       (return at +120m)
  - realized_eod_pct        (return at last tick of the day)
  - realized_trail30_10_pct (peak-trail exit: activate at +30%, trail 10pp)

Mirrors the lottery_finder enrichment pattern. Read-only on parquet,
writes to silent_boom_alerts. Idempotent: standard mode only touches
rows with enriched_at IS NULL.

`--backfill-mode` gates the SELECT on `realized_trail30_10_pct IS NULL`
instead of `enriched_at IS NULL`, so rows enriched BEFORE migration #150
landed (which have enriched_at populated but trail NULL) get picked up
without resetting enriched_at on the table. Use this once after the
column is added, then revert to the default flow.

Usage:
    ml/.venv/bin/python scripts/enrich_silent_boom_outcomes.py
    ml/.venv/bin/python scripts/enrich_silent_boom_outcomes.py --date 2026-05-07
    ml/.venv/bin/python scripts/enrich_silent_boom_outcomes.py --backfill-mode
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

# Import the trail-30/10 exit policy from the shared ml/src module so this
# script stays in sync with the lottery enrichment that uses the same fn.
sys.path.insert(0, str(ROOT / 'ml' / 'src'))
from lottery_exit_policies import realized_trail_act30_trail10  # noqa: E402

# Forward-return horizons in minutes — match the columns we store.
HORIZONS_MIN = [30, 60, 120]


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


def list_parquet_dates(from_date: str | None, to_date: str | None) -> list[str]:
    out: list[str] = []
    for p in sorted(PARQUET_DIR.glob('*-trades.parquet')):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-trades\.parquet', p.name)
        if not m:
            continue
        d = m.group(1)
        if from_date and d < from_date:
            continue
        if to_date and d > to_date:
            continue
        out.append(d)
    return out


def load_chain_tape(parquet_path: Path, chain_ids: list[str]) -> pd.DataFrame:
    """Load post-canceled price stream for a set of chains."""
    df = pd.read_parquet(
        parquet_path,
        columns=['executed_at', 'option_chain_id', 'price', 'canceled'],
        filters=[('option_chain_id', 'in', chain_ids)] if chain_ids else None,
    )
    if df.empty:
        return df
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    return df.sort_values(['option_chain_id', 'executed_at'], kind='stable')


def fetch_unenriched(conn, target_date: str, backfill_mode: bool = False):
    """Return alerts that still need enrichment for `target_date`.

    Standard mode: rows with enriched_at IS NULL (nightly flow).
    Backfill mode: rows with realized_trail30_10_pct IS NULL (one-shot
    pickup after migration #150 lands — rows previously enriched get
    re-touched and the UPDATE re-writes all 7 outcome columns; peak /
    mtp / r30 / r60 / r120 / eod recompute identically from parquet so
    the only material change is a fresh enriched_at = NOW() timestamp.
    """
    cur = conn.cursor()
    where_clause = (
        'realized_trail30_10_pct IS NULL'
        if backfill_mode
        else 'enriched_at IS NULL'
    )
    cur.execute(
        f"""
        SELECT id, option_chain_id, bucket_ct, entry_price
        FROM silent_boom_alerts
        WHERE date = %s AND {where_clause}
        ORDER BY bucket_ct ASC
        """,
        (target_date,),
    )
    rows = cur.fetchall()
    return [
        {
            'id': r[0],
            'chain': r[1],
            'bucket_ct': pd.Timestamp(r[2]),
            'entry_price': float(r[3]),
        }
        for r in rows
    ]


def update_outcomes(conn, updates: list[tuple]) -> None:
    if not updates:
        return
    cur = conn.cursor()
    execute_values(
        cur,
        """
        UPDATE silent_boom_alerts AS a
        SET peak_ceiling_pct        = v.peak,
            minutes_to_peak         = v.mtp,
            realized_30m_pct        = v.r30,
            realized_60m_pct        = v.r60,
            realized_120m_pct       = v.r120,
            realized_eod_pct        = v.eod,
            realized_trail30_10_pct = v.trail30,
            enriched_at             = NOW()
        FROM (VALUES %s) AS v(id, peak, mtp, r30, r60, r120, eod, trail30)
        WHERE a.id = v.id
        """,
        updates,
        template='(%s::bigint, %s, %s, %s, %s, %s, %s, %s)',
        page_size=500,
    )
    conn.commit()


def compute_outcomes(
    chain_df: pd.DataFrame, bucket_ct: pd.Timestamp, entry_price: float
) -> tuple[
    float, float, float | None, float | None, float | None, float, float
] | None:
    if entry_price <= 0 or chain_df.empty:
        return None
    bucket_ts = bucket_ct
    if bucket_ts.tz is None:
        bucket_ts = bucket_ts.tz_localize('UTC')
    post = chain_df[chain_df['executed_at'] >= bucket_ts]
    if post.empty:
        return None
    prices = post['price'].astype(float).to_numpy()
    minutes = (
        (post['executed_at'] - bucket_ts).dt.total_seconds() / 60.0
    ).to_numpy()

    # Peak (look-ahead reference) + minutes-to-peak.
    peak_idx = int(np.argmax(prices))
    peak_pct = float((prices[peak_idx] - entry_price) / entry_price * 100.0)
    mtp = float(minutes[peak_idx])

    # Forward fixed-horizon returns — last price at or before the
    # horizon's offset. Returns None when no tick falls inside the
    # horizon so the column stays NULL in the DB; coding "no data"
    # as 0% would silently inflate win rates for sparse chains.
    def at_horizon(h_min: float) -> float | None:
        mask = minutes <= h_min
        if not mask.any():
            return None
        last_idx = int(np.nonzero(mask)[0][-1])
        return float((prices[last_idx] - entry_price) / entry_price * 100.0)

    r30 = at_horizon(30.0)
    r60 = at_horizon(60.0)
    r120 = at_horizon(120.0)
    eod = float((prices[-1] - entry_price) / entry_price * 100.0)
    # Trail-30/10: activate trailing stop at +30%, exit on 10pp giveback
    # from running peak. Bounded between (-100%, peak_pct]; equals EoD
    # return when peak never crossed +30%. Shared with lottery enrichment.
    trail30 = float(
        realized_trail_act30_trail10(prices.tolist(), entry_price)
    )
    return peak_pct, mtp, r30, r60, r120, eod, trail30


def list_unenriched_dates(conn, backfill_mode: bool) -> list[str]:
    """Distinct YYYY-MM-DD dates with at least one pending alert.

    Standard mode gates on enriched_at IS NULL (the live nightly flow).
    Backfill mode gates on realized_trail30_10_pct IS NULL — matches the
    --backfill-mode semantics of fetch_unenriched.
    """
    where_clause = (
        'realized_trail30_10_pct IS NULL' if backfill_mode else 'enriched_at IS NULL'
    )
    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT DISTINCT date::text
        FROM silent_boom_alerts
        WHERE {where_clause}
        ORDER BY date ASC
        """
    )
    return [r[0] for r in cur.fetchall()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', help='YYYY-MM-DD; single-day mode')
    parser.add_argument('--from-date')
    parser.add_argument('--to-date')
    parser.add_argument(
        '--backfill-mode',
        action='store_true',
        help=(
            'Gate the row fetch on realized_trail30_10_pct IS NULL instead '
            'of enriched_at IS NULL. Use once after migration #150 to '
            'fill the new column on previously-enriched rows without '
            'resetting enriched_at on the table.'
        ),
    )
    parser.add_argument(
        '--all-unenriched',
        action='store_true',
        help=(
            'Enumerate dates from silent_boom_alerts WHERE enriched_at IS NULL '
            '(or realized_trail30_10_pct IS NULL with --backfill-mode) and '
            'process only those. Overrides --date / --from-date / --to-date. '
            "Used by `make enrich` so post-nightly manual backfills don't get "
            'stranded with enriched_at NULL.'
        ),
    )
    args = parser.parse_args()

    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    try:
        if args.all_unenriched:
            dates = list_unenriched_dates(conn, args.backfill_mode)
        else:
            dates = (
                [args.date]
                if args.date
                else list_parquet_dates(args.from_date, args.to_date)
            )
        mode_label = 'backfill' if args.backfill_mode else 'standard'
        scope = 'all-unenriched' if args.all_unenriched else 'parquet-list'
        print(
            f'[enrich-silent-boom] {len(dates)} dates '
            f'(mode={mode_label}, scope={scope})'
        )

        grand_updated = 0
        t0 = time.time()
        for date_str in dates:
            td = time.time()
            alerts = fetch_unenriched(conn, date_str, args.backfill_mode)
            if not alerts:
                print(f'  [{date_str}] no unenriched alerts')
                continue
            path = PARQUET_DIR / f'{date_str}-trades.parquet'
            if not path.exists():
                # Loud — pipeline operator needs to know a parquet went missing.
                # Distinguish from the chain-not-in-parquet skip below.
                print(
                    f'  [{date_str}] WARN parquet missing — skipping '
                    f'{len(alerts)} alerts',
                    file=sys.stderr,
                )
                continue
            chain_ids = list({a['chain'] for a in alerts})
            tape = load_chain_tape(path, chain_ids)
            chain_index = dict(iter(tape.groupby('option_chain_id', sort=False)))
            updates: list[tuple] = []
            skipped_chain_missing = 0
            skipped_no_outcome = 0
            for a in alerts:
                chain_df = chain_index.get(a['chain'])
                if chain_df is None:
                    skipped_chain_missing += 1
                    continue
                res = compute_outcomes(chain_df, a['bucket_ct'], a['entry_price'])
                if res is None:
                    skipped_no_outcome += 1
                    continue
                peak, mtp, r30, r60, r120, eod, trail30 = res
                updates.append(
                    (a['id'], peak, mtp, r30, r60, r120, eod, trail30)
                )
            update_outcomes(conn, updates)
            grand_updated += len(updates)
            print(
                f'  [{date_str}] alerts={len(alerts):>4,} '
                f'updated={len(updates):>4,} '
                f'skipped_chain={skipped_chain_missing} '
                f'skipped_no_outcome={skipped_no_outcome} '
                f'in {time.time() - td:.1f}s'
            )

        print(f'\n[enrich-silent-boom] DONE updated={grand_updated:,} '
              f'in {time.time() - t0:.1f}s')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
