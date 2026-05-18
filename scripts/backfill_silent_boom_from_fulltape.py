"""Backfill silent_boom_alerts from the Eod-Full-Tape-parquet archive.

Sister script to `backfill_silent_boom_from_parquet.py` (which reads
the Bot-Eod-parquet archive — only covers 25 days, 2026-04-13 →
2026-05-15). This one reads from Eod-Full-Tape-parquet (93 days,
2026-01-02 → 2026-05-15) so the SB detector can replay the 68 days
that predate the live cron.

Differences from the Bot-Eod backfill:
  - Full-tape parquet lacks a `side` column. Per memory
    feedback_uw_fulltape_vols_cumulative, the ask_vol/bid_vol/mid_vol
    columns are CUMULATIVE rollups, NOT per-trade values, so we
    can't derive side from them. Instead derive from the `tags`
    array (UW tags each trade with `ask_side` / `bid_side` based on
    its NBBO position at execution).
  - File naming: `<date>-fulltape.parquet` vs `<date>-trades.parquet`.
  - Detect logic, score computation, macro lookups, and INSERT
    pipeline are imported from the Bot-Eod script unchanged — only
    the parquet read path is overridden.

Idempotent via the same `(option_chain_id, bucket_ct)` unique index
the production cron uses. Re-runs are safe.

Usage:
    ml/.venv/bin/python scripts/backfill_silent_boom_from_fulltape.py \\
        --from-date 2026-01-02 --to-date 2026-04-10
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

# Import the Bot-Eod backfill — reuse the detector + scoring + macro
# lookups + INSERT pipeline. We override PARQUET_DIR + the filename
# pattern + load_buckets_for_date and otherwise reuse main()'s loop
# semantics by reimplementing it inline (the existing main() reads
# the PARQUET_DIR module attribute, so monkey-patching works for
# load_buckets_for_date but not for list_parquet_dates).
import backfill_silent_boom_from_parquet as sb_backfill

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


def load_buckets_for_date_fulltape(date_str: str) -> pd.DataFrame:
    """Per-(chain, 5min-bucket) aggregates from a full-tape parquet.

    Mirrors the Bot-Eod loader's output shape but derives `side` from
    the `tags` array (UW tags each trade with 'ask_side' or
    'bid_side' based on NBBO position at execution).
    """
    path = FULLTAPE_DIR / f'{date_str}-fulltape.parquet'
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_parquet(
        path,
        columns=[
            'executed_at', 'underlying_symbol', 'option_chain_id',
            'option_type', 'strike', 'expiry', 'price', 'size',
            'open_interest', 'canceled', 'tags',
            # H5 spread (Phase D-1, migration #171).
            'nbbo_bid', 'nbbo_ask',
        ],
    )
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[
            df['canceled'].astype(str).str.lower().isin(
                ['f', 'false', '0', '']
            )
        ]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')

    # Full-tape parquet stores price/size/strike as Decimal-backed
    # object dtype (Postgres NUMERIC export). Cast to float so the
    # downstream numpy math (np.isnan, vwap division) works.
    for col in ('price', 'size', 'strike', 'open_interest'):
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df = df.dropna(subset=['price', 'size'])

    # Derive `side` from the tags array literal. UW tags include
    # 'ask_side' or 'bid_side' (mutually exclusive); anything else
    # → 'mid' (no NBBO-side classification).
    tags_str = df['tags'].astype(str)
    df['side'] = np.where(
        tags_str.str.contains('ask_side', regex=False),
        'ask',
        np.where(
            tags_str.str.contains('bid_side', regex=False),
            'bid',
            'mid',
        ),
    )

    df['bucket'] = df['executed_at'].dt.floor('5min')
    df['ask_size'] = np.where(df['side'] == 'ask', df['size'], 0)
    df['bid_size'] = np.where(df['side'] == 'bid', df['size'], 0)
    df['notional'] = df['size'] * df['price']
    # H2 cadence helper — flag prints landing in the first 60s of
    # their 5-min bucket. SUM(first_min_size)/SUM(size) → cadence.
    df['first_min_size'] = np.where(
        df['executed_at'] < df['bucket'] + pd.Timedelta(minutes=1),
        df['size'],
        0,
    )
    # H5 in-bucket spread helper — size-weighted relative spread per
    # trade. Full-tape parquet carries nbbo_bid / nbbo_ask. Cast to
    # float (Decimal arithmetic with numpy is brittle).
    if 'nbbo_bid' in df.columns and 'nbbo_ask' in df.columns:
        nbbo_bid = pd.to_numeric(df['nbbo_bid'], errors='coerce')
        nbbo_ask = pd.to_numeric(df['nbbo_ask'], errors='coerce')
        mid = (nbbo_bid + nbbo_ask) / 2
        df['rel_spread'] = np.where(
            (nbbo_bid > 0) & (nbbo_ask > 0) & (mid > 0),
            (nbbo_ask - nbbo_bid) / mid,
            np.nan,
        )
        df['spread_numerator'] = df['rel_spread'] * df['size']
        df['spread_denom'] = np.where(df['rel_spread'].notna(), df['size'], 0)
    else:
        df['spread_numerator'] = np.nan
        df['spread_denom'] = 0

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
        # Per-bucket trade count for the pre_trade_count feature
        # (migration #169). Summed across prior buckets at fire time.
        n_trades=('price', 'count'),
        # Phase D-1 H2 cadence — first-60s size share numerator.
        first_min_size=('first_min_size', 'sum'),
        # Phase D-1 H5 spread — size-weighted relative spread.
        spread_numerator_sum=('spread_numerator', 'sum'),
        spread_denom_sum=('spread_denom', 'sum'),
    ).reset_index()
    agg['vwap'] = agg['vwap_num'] / agg['vwap_den']
    agg['first_min_share'] = np.where(
        agg['size'] > 0, agg['first_min_size'] / agg['size'], np.nan
    )
    agg['spread_in_bucket'] = np.where(
        agg['spread_denom_sum'] > 0,
        agg['spread_numerator_sum'] / agg['spread_denom_sum'],
        np.nan,
    )
    return agg


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', help='YYYY-MM-DD single-day mode')
    parser.add_argument('--from-date', help='YYYY-MM-DD inclusive')
    parser.add_argument('--to-date', help='YYYY-MM-DD inclusive')
    args = parser.parse_args()
    if args.date and (args.from_date or args.to_date):
        parser.error(
            '--date is mutually exclusive with --from-date / --to-date'
        )

    sb_backfill.load_env()
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
    print(f'[sb-fulltape-backfill] {len(dates)} parquet days')

    grand_inserted = 0
    grand_fires = 0
    t0 = time.time()
    for date_str in dates:
        td = time.time()
        bucketed = load_buckets_for_date_fulltape(date_str)
        if bucketed.empty:
            print(f'  [{date_str}] empty parquet — skipping')
            continue
        tide_df = sb_backfill.fetch_market_tide_for_day(conn, date_str)
        zero_dte_df = sb_backfill.fetch_zero_dte_flow_for_day(conn, date_str)
        spx_gamma_df = sb_backfill.fetch_spx_gamma_for_day(conn, date_str)
        if not tide_df.empty:
            tide_df = tide_df.sort_values('timestamp').reset_index(drop=True)
        if not zero_dte_df.empty:
            zero_dte_df = zero_dte_df.sort_values(
                'timestamp'
            ).reset_index(drop=True)
        if not spx_gamma_df.empty:
            spx_gamma_df = spx_gamma_df.sort_values(
                'timestamp'
            ).reset_index(drop=True)

        def _lookup_latest(
            df: pd.DataFrame, col: str, bucket_ts: pd.Timestamp
        ) -> float | None:
            if df.empty:
                return None
            mask = df['timestamp'] <= bucket_ts
            if not mask.any():
                return None
            tick_idx = mask[mask].index[-1]
            tick_ts = df.loc[tick_idx, 'timestamp']
            if (bucket_ts - tick_ts).total_seconds() > 30 * 60:
                return None
            return float(df.loc[tick_idx, col])

        # Phase B: split detection from scoring so the cofire keyset
        # can see ALL fires on the day before any one fire is scored.
        rows_to_insert: list[tuple] = []
        fires_today = 0
        detected: list[dict] = []
        for chain_id, sub in bucketed.groupby('option_chain_id', sort=False):
            if sub['max_oi'].max() < sb_backfill.MIN_OI:
                continue
            fires = sb_backfill.detect_for_chain(sub)
            if not fires:
                continue
            ticker = sub['ticker'].iloc[0]
            opt_type_raw = sub['option_type'].iloc[0]
            if opt_type_raw in ('call', 'C'):
                opt_type = 'C'
            elif opt_type_raw in ('put', 'P'):
                opt_type = 'P'
            else:
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
            dte = sb_backfill.days_between(date_str, exp_str)
            for f in fires:
                detected.append({
                    'chain_id': chain_id,
                    'sub': sub,
                    'ticker': ticker,
                    'opt_type': opt_type,
                    'strike': strike,
                    'exp_str': exp_str,
                    'dte': dte,
                    'f': f,
                })

        # Build cofire keyset from ALL detected fires on this day.
        cofire_keyset: set[str] = set()
        for d in detected:
            bucket_ts_iso = d['f']['bucket'].isoformat()
            cofire_keyset.add(
                f"{d['ticker']}|{d['opt_type']}|{bucket_ts_iso}|"
                f"{d['strike']}"
            )

        for d in detected:
            chain_id = d['chain_id']
            sub = d['sub']
            ticker = d['ticker']
            opt_type = d['opt_type']
            strike = d['strike']
            exp_str = d['exp_str']
            dte = d['dte']
            f = d['f']
            bucket_ts = f['bucket']
            tide_diff = _lookup_latest(tide_df, 'diff', bucket_ts)
            zero_dte_diff = _lookup_latest(
                zero_dte_df, 'diff', bucket_ts
            )
            spx_gamma = _lookup_latest(
                spx_gamma_df, 'gamma_oi', bucket_ts
            )
            # CT minute-of-day for the tod gate (the parquet's
            # executed_at is UTC; bucket is also UTC; CT = UTC-5
            # CDT / UTC-6 CST; the Apr/May window straddles CDT).
            # We re-use the Bot-Eod helper to derive tod.
            ct_ts = bucket_ts.tz_convert('America/Chicago')
            minute_of_day = ct_ts.hour * 60 + ct_ts.minute
            tod = sb_backfill.silent_boom_tod_from_minute_ct(
                minute_of_day
            )
            # Pre-trade-count: sum prior buckets' n_trades on this
            # chain. Same approximation as the Bot-Eod backfill —
            # options day-trade in regular session only, so "all
            # prior buckets" ≈ "since session open" for the SB
            # universe.
            pre_trade_count = int(
                sub.loc[sub['bucket'] < bucket_ts, 'n_trades'].sum()
            )
            # Adjacent-strike co-fire (Phase B).
            cofire_step = sb_backfill._adj_cofire_strike_step(ticker)
            bucket_ts_iso = bucket_ts.isoformat()
            adj_cofire = (
                f"{ticker}|{opt_type}|{bucket_ts_iso}|{strike + cofire_step}"
                in cofire_keyset
                or
                f"{ticker}|{opt_type}|{bucket_ts_iso}|{strike - cofire_step}"
                in cofire_keyset
            )
            # Phase D-1 — H2 cadence + H5 spread from the agg.
            bucket_row = sub.loc[sub['bucket'] == bucket_ts]
            if len(bucket_row) > 0:
                fms_val = bucket_row['first_min_share'].iloc[0]
                first_min_share = (
                    float(fms_val) if pd.notna(fms_val) else None
                )
                sib_val = bucket_row['spread_in_bucket'].iloc[0]
                spread_in_bucket = (
                    float(sib_val) if pd.notna(sib_val) else None
                )
            else:
                first_min_share = None
                spread_in_bucket = None
            score = sb_backfill.compute_silent_boom_score(
                dte=dte,
                baseline_volume=f['baseline_volume'],
                spike_ratio=f['spike_ratio'],
                entry_price=f['entry_price'],
                ask_pct=f['ask_pct'],
                tod=tod,
                option_type=opt_type,
                trading_day=date_str,
                pre_trade_count=pre_trade_count,
                adj_cofire=adj_cofire,
                first_min_share=first_min_share,
                spread_in_bucket=spread_in_bucket,
            )
            tier = sb_backfill.silent_boom_tier(score)
            rows_to_insert.append((
                date_str,
                bucket_ts.to_pydatetime(),
                chain_id,
                ticker,
                opt_type,
                strike,
                exp_str,
                dte,
                int(f['spike_volume']),
                float(f['baseline_volume']),
                float(f['spike_ratio']),
                float(f['ask_pct']),
                float(f['vol_oi']),
                float(f['entry_price']),
                int(f['open_interest']),
                int(score),
                tier,
                tide_diff,
                zero_dte_diff,
                spx_gamma,
                pre_trade_count,
                adj_cofire,
                first_min_share,
                spread_in_bucket,
            ))
            fires_today += 1

        inserted = (
            sb_backfill.insert_fires(conn, rows_to_insert)
            if rows_to_insert
            else 0
        )
        grand_inserted += inserted
        grand_fires += fires_today
        print(
            f'  [{date_str}]  fires={fires_today:>5}  '
            f'inserted={inserted:>5}  elapsed={time.time() - td:.1f}s'
        )

    conn.close()
    print(
        f'[sb-fulltape-backfill] DONE — '
        f'total fires={grand_fires:,} inserted={grand_inserted:,} '
        f'elapsed={time.time() - t0:.1f}s'
    )


if __name__ == '__main__':
    main()
