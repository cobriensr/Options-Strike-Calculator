#!/usr/bin/env python
"""Backfill silent_boom_alerts.multi_leg_share from EOD parquets.

For every row where multi_leg_share IS NULL, look up the 5-min spike
bucket in the day's per-trade parquet and compute the multi-leg share
of bucket size — sum of size whose `upstream_condition_detail` is one
of mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct (OPRA-standard multi-leg
sale conditions, same set used by api/cron/detect-silent-boom.ts).

Two parquet roots tried in order — full-tape has richer columns but
Bot-Eod is a smaller per-day file that loads faster when both are
present. Rows whose bucket date has no parquet stay NULL.

Spec: docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md

Usage:
    ml/.venv/bin/python scripts/backfill_silent_boom_multileg.py
    ml/.venv/bin/python scripts/backfill_silent_boom_multileg.py --date 2026-05-08
    ml/.venv/bin/python scripts/backfill_silent_boom_multileg.py --dry-run
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta

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


def load_trade_codes_for_day(
    path: pathlib.Path,
    chains: set[str],
) -> pd.DataFrame:
    """Load only the chains that have silent_boom rows on this date.

    Filtering early — before any groupby — collapses 10M+ rows to ~5K
    on a typical day (50 distinct chains × ~100 trades each). Without
    this, the full-tape groupby materializes ~50k chain groups and
    hangs for minutes."""
    df = pd.read_parquet(
        path,
        columns=[
            'option_chain_id', 'executed_at', 'size',
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
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.assign(
        is_multi_leg=df['upstream_condition_detail'].isin(MULTI_LEG_CODES),
    )
    return df[['option_chain_id', 'executed_at', 'size', 'is_multi_leg']]


def compute_shares(
    rows: list[tuple[int, str, datetime]],
    trades: pd.DataFrame,
) -> list[tuple[int, float]]:
    """Return [(alert_id, multi_leg_share)] for every row whose chain
    + bucket window matched at least one trade. Rows with no matching
    trades are omitted (caller leaves them NULL)."""
    if trades.empty:
        return []
    by_chain: dict[str, pd.DataFrame] = dict(
        iter(trades.groupby('option_chain_id', sort=False)),
    )
    out: list[tuple[int, float]] = []
    bucket_ms = timedelta(minutes=5)
    for alert_id, chain, bucket_ct in rows:
        sub = by_chain.get(chain)
        if sub is None:
            continue
        end = bucket_ct + bucket_ms
        mask = (sub['executed_at'] >= bucket_ct) & (sub['executed_at'] < end)
        bucket_trades = sub.loc[mask, ['size', 'is_multi_leg']]
        if bucket_trades.empty:
            continue
        total = int(bucket_trades['size'].sum())
        if total <= 0:
            continue
        ml = int(bucket_trades.loc[bucket_trades['is_multi_leg'], 'size'].sum())
        out.append((alert_id, ml / total))
    return out


def fetch_unenriched(
    conn: psycopg2.extensions.connection,
    only_date: str | None,
) -> list[tuple[int, str, datetime, str]]:
    """[(id, option_chain_id, bucket_ct, date_str)] for every row with
    multi_leg_share IS NULL."""
    with conn.cursor() as cur:
        where = 'multi_leg_share IS NULL'
        params: list[object] = []
        if only_date:
            where += ' AND date = %s::date'
            params.append(only_date)
        cur.execute(
            f"""
            SELECT id, option_chain_id, bucket_ct,
                   to_char(date, 'YYYY-MM-DD') AS date_str
            FROM silent_boom_alerts
            WHERE {where}
            ORDER BY date, bucket_ct
            """,
            params,
        )
        return cur.fetchall()


def update_shares(
    conn: psycopg2.extensions.connection,
    rows: list[tuple[int, float]],
) -> int:
    """Batched UPDATE via VALUES join. Returns count of rows updated."""
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            UPDATE silent_boom_alerts AS s
            SET multi_leg_share = v.share::numeric
            FROM (VALUES %s) AS v(id, share)
            WHERE s.id = v.id
            """,
            rows,
            template='(%s, %s)',
            page_size=500,
        )
        conn.commit()
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date',
        type=str,
        default=None,
        help='Restrict to one trading day (YYYY-MM-DD).',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print stats per day; do not UPDATE.',
    )
    args = parser.parse_args()
    load_env()

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        unenriched = fetch_unenriched(conn, args.date)
        print(f'[backfill-multileg] {len(unenriched):,} rows with NULL share')
        if not unenriched:
            return 0

        by_date: dict[str, list[tuple[int, str, datetime]]] = defaultdict(list)
        for alert_id, chain, bucket_ct, date_str in unenriched:
            by_date[date_str].append((alert_id, chain, bucket_ct))

        total_updated = 0
        missing_days: list[str] = []
        for date_str in sorted(by_date):
            rows = by_date[date_str]
            chains = {chain for _, chain, _ in rows}
            path = parquet_path_for_date(date_str)
            if path is None:
                missing_days.append(date_str)
                print(
                    f'  [{date_str}] no parquet — leaving {len(rows)} NULL',
                    flush=True,
                )
                continue
            try:
                trades = load_trade_codes_for_day(path, chains)
            except (OSError, ValueError, KeyError) as e:
                print(
                    f'  [{date_str}] parquet read failed ({e}) — skipping',
                    flush=True,
                )
                continue
            shares = compute_shares(rows, trades)
            pct = (len(shares) / len(rows) * 100) if rows else 0
            print(
                f'  [{date_str}] {len(rows):>5} rows, '
                f'{len(shares):>5} matched ({pct:>5.1f}%) '
                f'via {path.parent.name}',
                flush=True,
            )
            if args.dry_run:
                continue
            n = update_shares(conn, shares)
            total_updated += n

        if args.dry_run:
            print('[backfill-multileg] dry-run — no UPDATEs issued')
        else:
            print(f'[backfill-multileg] updated {total_updated:,} rows')
            if missing_days:
                print(
                    f'[backfill-multileg] {len(missing_days)} days had no '
                    f'parquet (rows stay NULL): {", ".join(missing_days[:5])}'
                    + (f' … +{len(missing_days) - 5}' if len(missing_days) > 5 else ''),
                )
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
