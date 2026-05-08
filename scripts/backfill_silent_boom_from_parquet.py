#!/usr/bin/env python
"""Backfill silent_boom_alerts from local EOD parquets.

Replays the silent-boom detector across all `*-trades.parquet` files
in `~/Desktop/Bot-Eod-parquet/`, INSERTing alerts with ON CONFLICT
DO NOTHING for idempotency. Mirrors `backfill_lottery_fires_for_ticker.py`.

The detector parameters MUST match `api/_lib/silent-boom.ts`
(SILENT_BOOM_SPEC_V1) — they are duplicated here for the same reason
the lottery detector port is duplicated: TS is the runtime
source-of-truth for the cron, this is the offline backfill path.

Usage:
    ml/.venv/bin/python scripts/backfill_silent_boom_from_parquet.py
    ml/.venv/bin/python scripts/backfill_silent_boom_from_parquet.py --date 2026-05-07
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

# Mirror of SILENT_BOOM_SPEC_V1 in api/_lib/silent-boom.ts.
BASELINE_BUCKETS = 4
BASELINE_MEDIAN_MAX = 500
MIN_SPIKE_VOL = 1_000
SPIKE_MULTIPLIER = 5.0
ASK_PCT_MIN = 0.7
VOL_OI_MIN = 0.25
COOLDOWN_BUCKETS = 12
MIN_OI = 100
BUCKET_MS = 5 * 60 * 1000
# Cooldown is wall-clock minutes — MUST match the TS detector's
# `tsMs - lastFireMs < cooldownMs` gate. An index-based gate (12
# rows in a sparse-bucket dataframe) silently diverges from the
# live cron for low-volume chains.
COOLDOWN_MS = COOLDOWN_BUCKETS * BUCKET_MS


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


def load_buckets_for_date(date_str: str) -> pd.DataFrame:
    """Per-(chain, 5min-bucket) aggregates for the day."""
    path = PARQUET_DIR / f'{date_str}-trades.parquet'
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_parquet(
        path,
        columns=[
            'executed_at', 'underlying_symbol', 'option_chain_id',
            'option_type', 'strike', 'expiry', 'price', 'size', 'side',
            'open_interest', 'canceled',
        ],
    )
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')

    df['bucket'] = df['executed_at'].dt.floor('5min')
    df['ask_size'] = np.where(df['side'] == 'ask', df['size'], 0)
    df['bid_size'] = np.where(df['side'] == 'bid', df['size'], 0)
    df['notional'] = df['size'] * df['price']

    agg = df.groupby(['option_chain_id', 'bucket'], sort=True).agg(
        ticker=('underlying_symbol', 'first'),
        option_type=('option_type', 'first'),
        strike=('strike', 'first'),
        expiry=('expiry', 'first'),
        size=('size', 'sum'),
        ask_size=('ask_size', 'sum'),
        bid_size=('bid_size', 'sum'),
        max_oi=('open_interest', 'max'),
        last_price=('price', 'last'),
        vwap_num=('notional', 'sum'),
        vwap_den=('size', 'sum'),
    ).reset_index()
    agg['vwap'] = agg['vwap_num'] / agg['vwap_den']
    return agg


def detect_for_chain(chain_df: pd.DataFrame) -> list[dict]:
    """Walk forward through one chain's 5-min buckets, fire on the
    silent-boom pattern. Returns list of fire dicts.

    Cooldown is **wall-clock time-based** to match the TS detector:
    `tsMs - lastFireMs < COOLDOWN_MS`. An index-based gate would
    silently diverge for sparse chains (gaps between traded buckets
    can span hours)."""
    if len(chain_df) < BASELINE_BUCKETS + 1:
        return []
    chain_df = chain_df.sort_values('bucket').reset_index(drop=True)
    sizes = chain_df['size'].to_numpy()
    ask = chain_df['ask_size'].to_numpy()
    bid = chain_df['bid_size'].to_numpy()
    oi = chain_df['max_oi'].to_numpy()
    vwap = chain_df['vwap'].to_numpy()
    last_price = chain_df['last_price'].to_numpy()
    buckets = chain_df['bucket'].to_numpy()
    # Bucket timestamps as int64 epoch-ms — use the same semantics as
    # the TS detector so the cooldown comparison is identical. Buckets
    # may be tz-aware (UTC); pandas refuses to astype tz-aware →
    # naive datetime64, so convert to UTC then drop the tz first.
    bucket_series = pd.Series(buckets)
    if bucket_series.dt.tz is not None:
        bucket_series = bucket_series.dt.tz_convert('UTC').dt.tz_localize(None)
    bucket_ms = bucket_series.astype('datetime64[ms]').astype('int64').to_numpy()

    fires: list[dict] = []
    last_fire_ms: int | None = None
    for i in range(BASELINE_BUCKETS, len(chain_df)):
        ts_ms = int(bucket_ms[i])
        if last_fire_ms is not None and ts_ms - last_fire_ms < COOLDOWN_MS:
            continue
        baseline = float(np.median(sizes[i - BASELINE_BUCKETS:i]))
        if baseline > BASELINE_MEDIAN_MAX:
            continue
        cur_vol = float(sizes[i])
        if cur_vol < MIN_SPIKE_VOL:
            continue
        if cur_vol < SPIKE_MULTIPLIER * max(baseline, 100):
            continue
        ab = float(ask[i] + bid[i])
        if ab == 0:
            continue
        ask_pct = float(ask[i]) / ab
        if ask_pct < ASK_PCT_MIN:
            continue
        cur_oi = float(oi[i])
        if cur_oi < MIN_OI:
            continue
        vol_oi = cur_vol / cur_oi
        if vol_oi < VOL_OI_MIN:
            continue
        entry = float(vwap[i]) if not np.isnan(vwap[i]) else float(last_price[i])
        if entry <= 0:
            continue
        fires.append({
            'bucket': pd.Timestamp(buckets[i]),
            'spike_volume': int(cur_vol),
            'baseline_volume': baseline,
            'spike_ratio': cur_vol / max(baseline, 1),
            'ask_pct': ask_pct,
            'vol_oi': vol_oi,
            'entry_price': entry,
            'open_interest': int(cur_oi),
        })
        last_fire_ms = ts_ms
    return fires


def days_between(from_ymd: str, to_ymd: str) -> int:
    a = datetime.fromisoformat(f'{from_ymd}T00:00:00+00:00')
    b = datetime.fromisoformat(f'{to_ymd}T00:00:00+00:00')
    return (b - a).days


def insert_fires(conn, rows: list[tuple]) -> int:
    if not rows:
        return 0
    cur = conn.cursor()
    inserted = execute_values(
        cur,
        """
        INSERT INTO silent_boom_alerts (
          date, bucket_ct, option_chain_id, underlying_symbol,
          option_type, strike, expiry, dte,
          spike_volume, baseline_volume, spike_ratio,
          ask_pct, vol_oi, entry_price, open_interest
        )
        VALUES %s
        ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
        RETURNING id
        """,
        rows,
        template=(
            '(%s::date, %s::timestamptz, %s, %s, %s, %s::numeric, '
            '%s::date, %s, %s, %s::numeric, %s::numeric, %s::numeric, '
            '%s::numeric, %s::numeric, %s)'
        ),
        page_size=500,
        fetch=True,
    )
    conn.commit()
    return len(inserted) if inserted else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', help='YYYY-MM-DD; single-day mode')
    parser.add_argument('--from-date', help='YYYY-MM-DD inclusive')
    parser.add_argument('--to-date', help='YYYY-MM-DD inclusive')
    args = parser.parse_args()

    if args.date and (args.from_date or args.to_date):
        parser.error(
            '--date is mutually exclusive with --from-date / --to-date'
        )

    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)

    if args.date:
        dates = [args.date]
    else:
        dates = list_parquet_dates(args.from_date, args.to_date)
    print(f'[backfill-silent-boom] {len(dates)} parquet days')

    grand_inserted = 0
    grand_fires = 0
    t0 = time.time()
    for date_str in dates:
        td = time.time()
        bucketed = load_buckets_for_date(date_str)
        if bucketed.empty:
            print(f'  [{date_str}] empty parquet — skipping')
            continue
        rows_to_insert: list[tuple] = []
        fires_today = 0
        for chain_id, sub in bucketed.groupby('option_chain_id', sort=False):
            if sub['max_oi'].max() < MIN_OI:
                continue
            fires = detect_for_chain(sub)
            if not fires:
                continue
            ticker = sub['ticker'].iloc[0]
            opt_type_raw = sub['option_type'].iloc[0]
            if opt_type_raw in ('call', 'C'):
                opt_type = 'C'
            elif opt_type_raw in ('put', 'P'):
                opt_type = 'P'
            else:
                # Parquet encoding drift: silently dropping every
                # alert on this chain would be a pipeline-killing
                # foot-gun. Surface the first occurrence so the next
                # operator can decide whether to extend the mapping.
                print(
                    f'  [{date_str}] {chain_id}: unknown option_type='
                    f'{opt_type_raw!r} — chain skipped'
                )
                continue
            strike = float(sub['strike'].iloc[0])
            exp_raw = sub['expiry'].iloc[0]
            exp_str = (
                exp_raw.isoformat()[:10]
                if hasattr(exp_raw, 'isoformat')
                else str(exp_raw)[:10]
            )
            dte = days_between(date_str, exp_str)
            for f in fires:
                rows_to_insert.append((
                    date_str,
                    f['bucket'].isoformat(),
                    chain_id, ticker,
                    opt_type, strike, exp_str, dte,
                    f['spike_volume'], f['baseline_volume'], f['spike_ratio'],
                    f['ask_pct'], f['vol_oi'], f['entry_price'],
                    f['open_interest'],
                ))
                fires_today += 1
        inserted = insert_fires(conn, rows_to_insert)
        grand_fires += fires_today
        grand_inserted += inserted
        print(f'  [{date_str}] fires={fires_today:>4,} inserted={inserted:>4,} '
              f'in {time.time() - td:.1f}s')
    print(f'\n[backfill-silent-boom] DONE days={len(dates)} fires_seen={grand_fires:,} '
          f'inserted={grand_inserted:,} in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
