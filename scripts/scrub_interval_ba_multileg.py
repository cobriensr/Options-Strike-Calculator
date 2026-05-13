#!/usr/bin/env python
"""Scrub multi-leg-dominated rows from interval_ba_alerts using EOD parquets.

For every row in interval_ba_alerts, replay the new multi-leg gate that
ships in uw-stream/src/handlers/interval_ba.py: load the matching 5-min
bucket from the day's per-trade parquet, sum ML premium (sale conditions
mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct), and DELETE the alert when
ML premium / total premium >= --threshold (default 0.5).

Why this exists: interval_ba_alerts was backfilled Jan 2 → May 11 2026
under the old (pre-ML-gate) handler, so 18K rows include spread-leg-
dominated buckets. ws_option_trades only has 7-day retention so the
recent fires were scrubbed by scrub-ml-alerts-probe/delete.mjs against
Neon; this script handles the older rows by going back to the source
parquets.

Mirrors scripts/backfill_silent_boom_multileg.py closely — same parquet
roots, same MULTI_LEG_CODES, same load+groupby pattern. Differences:

  - target table: interval_ba_alerts (vs silent_boom_alerts)
  - bucket field: bucket_start TIMESTAMPTZ (UTC) (vs bucket_ct)
  - bucket window: bucket_start .. bucket_end (already in DB) (vs +5min)
  - action: DELETE (vs UPDATE multi_leg_share)
  - premium aggregation: price * size * 100 (not just size) — interval-ba
    is a premium-ratio metric, so we filter on premium share to match
    the handler's gate exactly.

Usage:
    ml/.venv/bin/python scripts/scrub_interval_ba_multileg.py --dry-run
    ml/.venv/bin/python scripts/scrub_interval_ba_multileg.py --date 2026-04-15
    ml/.venv/bin/python scripts/scrub_interval_ba_multileg.py --threshold 0.5
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
from collections import defaultdict
from datetime import datetime
from decimal import Decimal

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
BOT_EOD_DIR = pathlib.Path.home() / 'Desktop' / 'Bot-Eod-parquet'
FULL_TAPE_DIR = pathlib.Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'

MULTI_LEG_CODES = frozenset(
    ('mlat', 'mlet', 'mlft', 'mfto', 'masl', 'mesl', 'mfsl', 'mlct'),
)


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


def parquet_path_for_date(date_str: str) -> pathlib.Path | None:
    """Bot-Eod first (smaller, faster), then full-tape fallback."""
    candidates = [
        BOT_EOD_DIR / f'{date_str}-trades.parquet',
        FULL_TAPE_DIR / f'{date_str}-fulltape.parquet',
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def load_trades_for_day(
    path: pathlib.Path,
    chains: set[str],
) -> pd.DataFrame:
    """Load only the chains that have interval_ba_alerts rows on this date.

    Filtering early — before any groupby — collapses 10M+ rows to ~1K
    on a typical day (~30 distinct chains × ~30 trades each).
    Returns columns: option_chain_id, executed_at (UTC), premium, is_multi_leg.
    """
    df = pd.read_parquet(
        path,
        columns=[
            'option_chain_id', 'executed_at', 'price', 'size',
            'upstream_condition_detail', 'canceled',
        ],
    )
    df = df[df['option_chain_id'].isin(chains)]
    if df.empty:
        return df
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(
            ('f', 'false', '0', ''),
        )]
    # Reject non-positive trade fields (mirrors the handler).
    df = df[(df['price'] > 0) & (df['size'] > 0)]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.assign(
        premium=(df['price'].astype(float) * df['size'].astype(int) * 100.0),
        is_multi_leg=df['upstream_condition_detail'].isin(MULTI_LEG_CODES),
    )
    return df[['option_chain_id', 'executed_at', 'premium', 'is_multi_leg']]


def compute_ml_share(
    rows: list[tuple[int, str, datetime, datetime]],
    trades: pd.DataFrame,
) -> list[tuple[int, float]]:
    """Return [(alert_id, ml_share)] for every row whose chain + bucket
    window matched at least one trade. Rows with no matching trades are
    omitted (caller treats them as unverifiable — leaves them alone).
    """
    if trades.empty:
        return []
    by_chain: dict[str, pd.DataFrame] = dict(
        iter(trades.groupby('option_chain_id', sort=False)),
    )
    out: list[tuple[int, float]] = []
    for alert_id, chain, bucket_start, bucket_end in rows:
        sub = by_chain.get(chain)
        if sub is None:
            continue
        mask = (
            (sub['executed_at'] >= bucket_start)
            & (sub['executed_at'] < bucket_end)
        )
        bucket_trades = sub.loc[mask, ['premium', 'is_multi_leg']]
        if bucket_trades.empty:
            continue
        total = float(bucket_trades['premium'].sum())
        if total <= 0:
            continue
        ml = float(
            bucket_trades.loc[bucket_trades['is_multi_leg'], 'premium'].sum(),
        )
        out.append((alert_id, ml / total))
    return out


def fetch_alerts(
    conn: psycopg2.extensions.connection,
    only_date: str | None,
) -> list[tuple[int, str, datetime, datetime, str]]:
    """[(id, option_chain, bucket_start, bucket_end, date_str)]."""
    with conn.cursor() as cur:
        where = 'TRUE'
        params: list[object] = []
        if only_date:
            where = "bucket_start::date = %s::date"
            params.append(only_date)
        cur.execute(
            f"""
            SELECT id, option_chain, bucket_start, bucket_end,
                   to_char(bucket_start, 'YYYY-MM-DD') AS date_str
            FROM interval_ba_alerts
            WHERE {where}
            ORDER BY bucket_start, id
            """,
            params,
        )
        return cur.fetchall()


def delete_alerts(
    conn: psycopg2.extensions.connection,
    ids: list[int],
) -> int:
    """Batched DELETE. Returns count of rows removed.

    Commits per 500-id chunk (not at the end) so progress survives a
    Neon SSL drop mid-run — the 2026-05-13 first attempt lost the full
    9.5K delete batch to ``SSL connection has been closed unexpectedly``
    because the prior implementation only committed once at the end.
    """
    if not ids:
        return 0
    deleted = 0
    # 500-id chunks keep statement size, lock duration, and commit
    # interval bounded. cursor() inside the loop so a connection-level
    # exception during one chunk doesn't poison the rest.
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM interval_ba_alerts WHERE id = ANY(%s::bigint[])',
                (chunk,),
            )
            deleted += cur.rowcount
        conn.commit()
        if (i // 500) % 4 == 3:  # every ~2K rows
            print(
                f'  [scrub-multileg] committed {deleted:,} of {len(ids):,}',
                flush=True,
            )
    return deleted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date',
        type=str,
        default=None,
        help='Restrict to one trading day (YYYY-MM-DD).',
    )
    parser.add_argument(
        '--threshold',
        type=float,
        default=0.5,
        help='ML premium share >= threshold → delete. Default 0.5 (matches handler).',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print stats per day; do not DELETE.',
    )
    args = parser.parse_args()
    if not 0.0 < args.threshold <= 1.0:
        sys.exit('--threshold must be in (0.0, 1.0]')
    load_env()

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        alerts = fetch_alerts(conn, args.date)
        print(f'[scrub-multileg] {len(alerts):,} alerts to grade')
        if not alerts:
            return 0

        by_date: dict[str, list[tuple[int, str, datetime, datetime]]] = defaultdict(list)
        for alert_id, chain, bstart, bend, date_str in alerts:
            by_date[date_str].append((alert_id, chain, bstart, bend))

        all_delete_ids: list[int] = []
        missing_days: list[str] = []
        graded = 0
        flagged = 0
        for date_str in sorted(by_date):
            rows = by_date[date_str]
            chains = {chain for _, chain, _, _ in rows}
            path = parquet_path_for_date(date_str)
            if path is None:
                missing_days.append(date_str)
                print(
                    f'  [{date_str}] no parquet — {len(rows)} rows unverifiable',
                    flush=True,
                )
                continue
            try:
                trades = load_trades_for_day(path, chains)
            except (OSError, ValueError, KeyError) as e:
                print(
                    f'  [{date_str}] parquet read failed ({e}) — skipping',
                    flush=True,
                )
                continue
            shares = compute_ml_share(rows, trades)
            day_flagged = [aid for aid, s in shares if s >= args.threshold]
            graded += len(shares)
            flagged += len(day_flagged)
            print(
                f'  [{date_str}] {len(rows):>5} rows, '
                f'{len(shares):>5} graded, '
                f'{len(day_flagged):>4} flagged ML>={args.threshold:.0%}',
                flush=True,
            )
            all_delete_ids.extend(day_flagged)

        print(
            f'\n[scrub-multileg] total graded: {graded:,} '
            f'| flagged for delete: {flagged:,} '
            f'| missing parquet days: {len(missing_days)}',
        )
        if args.dry_run:
            print('[scrub-multileg] dry-run — no DELETEs issued')
            return 0
        if not all_delete_ids:
            print('[scrub-multileg] nothing to delete')
            return 0
        deleted = delete_alerts(conn, all_delete_ids)
        print(f'[scrub-multileg] deleted {deleted:,} rows')
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
