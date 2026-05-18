"""Enrich silent_boom_alerts realized_* columns from Eod-Full-Tape-parquet.

Sister script to scripts/enrich_silent_boom_outcomes.py (which reads
the Bot-Eod-parquet archive — 25 days only). This one reads the
93-day Eod-Full-Tape-parquet archive so the 48,390 backfilled
silent_boom_alerts inserted by backfill_silent_boom_from_fulltape.py
can get realized outcomes computed.

Mirrors the SB detector full-tape backfill pattern: imports the
existing enrichment module + overrides only the parquet read path
+ runs the same UPDATE pipeline. Detect logic, score adjustment,
realized-outcome computation, and INSERT-side semantics are
unchanged.

Idempotent via the existing `enriched_at IS NULL` gate (or
`realized_trail30_10_pct IS NULL` under --backfill-mode).

Usage:
    ml/.venv/bin/python scripts/enrich_silent_boom_outcomes_fulltape.py \\
        --backfill-mode

    ml/.venv/bin/python scripts/enrich_silent_boom_outcomes_fulltape.py \\
        --backfill-mode --date 2026-01-15
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

# Reuse the existing enrichment's helpers, scoring, and UPDATE
# pipeline. The only thing we override is the parquet read path.
import enrich_silent_boom_outcomes as enrich_sb

FULLTAPE_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'


def list_fulltape_dates(
    from_date: str | None, to_date: str | None
) -> list[str]:
    dates: list[str] = []
    for p in sorted(FULLTAPE_DIR.glob('*-fulltape.parquet')):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-fulltape\.parquet', p.name)
        if not m:
            continue
        d = m.group(1)
        if from_date and d < from_date:
            continue
        if to_date and d > to_date:
            continue
        dates.append(d)
    return dates


def load_chain_tape_fulltape(
    parquet_path: Path, chain_ids: list[str]
) -> pd.DataFrame:
    """Load price stream from full-tape parquet for a set of chains.

    Mirrors enrich_sb.load_chain_tape but adjusts for full-tape's
    Decimal-backed price column (Postgres NUMERIC export) — we cast
    via pd.to_numeric so the downstream pandas math (sort, fillna,
    .iloc indexing) works as the existing enrichment expects.
    """
    df = pd.read_parquet(
        parquet_path,
        columns=['executed_at', 'option_chain_id', 'price', 'canceled'],
        filters=(
            [('option_chain_id', 'in', chain_ids)] if chain_ids else None
        ),
    )
    if df.empty:
        return df
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[
            df['canceled'].astype(str).str.lower().isin(
                ['f', 'false', '0', '']
            )
        ]
    # Full-tape NUMERIC → object dtype; coerce to float for downstream.
    df['price'] = pd.to_numeric(df['price'], errors='coerce')
    df = df.dropna(subset=['price'])
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    return df.sort_values(
        ['option_chain_id', 'executed_at'], kind='stable'
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date', help='YYYY-MM-DD single-day mode'
    )
    parser.add_argument(
        '--from-date', help='YYYY-MM-DD inclusive lower bound'
    )
    parser.add_argument(
        '--to-date', help='YYYY-MM-DD inclusive upper bound'
    )
    parser.add_argument(
        '--backfill-mode',
        action='store_true',
        help=(
            'Pick up rows with realized_trail30_10_pct IS NULL '
            '(instead of enriched_at IS NULL). Use for one-shot '
            'historical fills after a backfill INSERT.'
        ),
    )
    args = parser.parse_args()
    if args.date and (args.from_date or args.to_date):
        parser.error(
            '--date is mutually exclusive with --from-date / --to-date'
        )

    enrich_sb.load_env()
    db_url = (
        os.environ.get('DATABASE_URL_UNPOOLED')
        or os.environ['DATABASE_URL']
    )
    conn = psycopg2.connect(db_url)

    dates = (
        [args.date]
        if args.date
        else list_fulltape_dates(args.from_date, args.to_date)
    )
    print(f'[sb-enrich-fulltape] {len(dates)} parquet days; '
          f'backfill_mode={args.backfill_mode}')

    grand_updated = 0
    t0 = time.time()
    try:
        for date_str in dates:
            td = time.time()
            alerts = enrich_sb.fetch_unenriched(
                conn, date_str, args.backfill_mode
            )
            if not alerts:
                continue
            path = FULLTAPE_DIR / f'{date_str}-fulltape.parquet'
            if not path.exists():
                print(
                    f'  [{date_str}] WARN parquet missing — skipping '
                    f'{len(alerts)} alerts',
                    file=sys.stderr,
                )
                continue
            chain_ids = list({a['chain'] for a in alerts})
            tape = load_chain_tape_fulltape(path, chain_ids)
            chain_index = dict(
                iter(tape.groupby('option_chain_id', sort=False))
            )
            updates: list[tuple] = []
            skipped_chain_missing = 0
            skipped_no_outcome = 0
            for a in alerts:
                chain_df = chain_index.get(a['chain'])
                if chain_df is None:
                    skipped_chain_missing += 1
                    continue
                res = enrich_sb.compute_outcomes(
                    chain_df, a['bucket_ct'], a['entry_price']
                )
                if res is None:
                    skipped_no_outcome += 1
                    continue
                peak, mtp, r30, r60, r120, eod, trail30 = res
                updates.append(
                    (a['id'], peak, mtp, r30, r60, r120, eod, trail30)
                )
            enrich_sb.update_outcomes(conn, updates)
            grand_updated += len(updates)
            print(
                f'  [{date_str}] alerts={len(alerts):>4,} '
                f'updated={len(updates):>4,} '
                f'skipped_chain={skipped_chain_missing} '
                f'skipped_no_outcome={skipped_no_outcome} '
                f'in {time.time() - td:.1f}s'
            )
    finally:
        conn.close()
    print(
        f'[sb-enrich-fulltape] DONE — '
        f'total updated={grand_updated:,} '
        f'elapsed={time.time() - t0:.1f}s'
    )


if __name__ == '__main__':
    main()
