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

# Mirror of SILENT_BOOM_TIER_THRESHOLDS in api/_lib/silent-boom-score.ts.
# Calibrated against the historical 14,100-fire sample — see
# docs/tmp/silent-boom-feature-audit-2026-05-08.md.
TIER1_MIN_SCORE = 21
TIER2_MIN_SCORE = 8
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
    # H2 cadence helper — flag prints landing in the first 60s of
    # their 5-min bucket. SUM(first_min_size)/SUM(size) → cadence.
    df['first_min_size'] = np.where(
        df['executed_at'] < df['bucket'] + pd.Timedelta(minutes=1),
        df['size'],
        0,
    )

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
        # Phase D-1 H2 cadence — first-60s size share.
        first_min_size=('first_min_size', 'sum'),
    ).reset_index()
    agg['vwap'] = agg['vwap_num'] / agg['vwap_den']
    agg['first_min_share'] = np.where(
        agg['size'] > 0, agg['first_min_size'] / agg['size'], np.nan
    )
    # Bot-Eod parquet doesn't carry NBBO → spread_in_bucket stays
    # NaN here. The fulltape backfill (#171 spread feature) populates
    # it; this loader leaves the column absent so the downstream
    # fire-loop reads None.
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


def silent_boom_tod_from_minute_ct(minute_of_day: int) -> str:
    if minute_of_day < 10 * 60:
        return 'AM_open'
    if minute_of_day < 12 * 60:
        return 'MID'
    if minute_of_day < 13 * 60:
        return 'LUNCH'
    if minute_of_day < 15 * 60:
        return 'PM'
    return 'LATE'


# Mirror of computeSilentBoomScore in api/_lib/silent-boom-score.ts.
# Every bucket weight is justified in docs/tmp/silent-boom-feature-audit-2026-05-08.md.
# TOD weights + DOW×type bonus retuned 2026-05-17 against the 93-day,
# 63,846-alert peak dataset (docs/tmp/sb-93d-peak-revisit-2026-05-17.py).
# pre_trade_count heavy-activity bonus (≥501 trades) added 2026-05-17
# Phase A — spec: docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md
_TOD_WEIGHTS = {'AM_open': 6, 'MID': 3, 'LUNCH': 0, 'PM': -4, 'LATE': -5}

# (day-of-week, option_type) → points. dow uses Python's
# datetime.weekday() convention (Mon=0 … Sun=6).
_DOW_TYPE_BONUS = {
    (4, 'P'): 2,   # Friday × PUT  (+3.2pp lift, n=7,166)
    (4, 'C'): 1,   # Friday × CALL (+1.6pp lift, n=8,565)
    (0, 'P'): -2,  # Monday × PUT  (-3.8pp lift, n=5,011)
}

_PRE_TRADE_COUNT_HEAVY_THRESHOLD = 501
_PRE_TRADE_COUNT_HEAVY_BONUS = 4

# Phase B adj_cofire bonus — TRUE when another SB fire exists at the
# adjacent strike (±$1 default, ±$5 for cash-index roots) on the
# same (ticker, optionType, bucket_ct). Validated against the 93-day
# peak dataset: 1,911 cofire alerts (3.0%) hit 22.0% peak ≥50% vs
# 16.0% non-cofire (+5.8pp lift).
_ADJ_COFIRE_BONUS = 2

# Phase D-1 H2 first_min_share cadence — distributed (<25% in min1)
# +1, single-block (>75%) -3. Mid bands are 0.
_FIRST_MIN_SHARE_DISTRIBUTED_MAX = 0.25
_FIRST_MIN_SHARE_SINGLE_BLOCK_MIN = 0.75
_FIRST_MIN_SHARE_DISTRIBUTED_BONUS = 1
_FIRST_MIN_SHARE_SINGLE_BLOCK_PENALTY = -3

# Phase D-1 H5 spread_in_bucket — Q0 (<0.0181) tight spreads -3,
# Q3 (>=0.1122) wide spreads +2. Mid bands are 0.
_SPREAD_IN_BUCKET_Q0_MAX = 0.0181
_SPREAD_IN_BUCKET_Q3_MIN = 0.1122
_SPREAD_IN_BUCKET_TIGHT_PENALTY = -3
_SPREAD_IN_BUCKET_WIDE_BONUS = 2

# Cash-index roots that trade on $5 strike steps (rest = $1).
_INDEX_COFIRE_ROOTS = frozenset(
    {'SPXW', 'SPX', 'NDXP', 'NDX', 'RUTW', 'RUT'}
)


def _adj_cofire_strike_step(ticker: str) -> float:
    return 5.0 if ticker in _INDEX_COFIRE_ROOTS else 1.0


def _dow_type_bonus(trading_day: str, option_type: str) -> int:
    """Day-of-week × option_type bonus. trading_day = 'YYYY-MM-DD'."""
    dow = datetime.fromisoformat(f'{trading_day}T00:00:00+00:00').weekday()
    return _DOW_TYPE_BONUS.get((dow, option_type), 0)


def compute_silent_boom_score(
    *,
    dte: int,
    baseline_volume: float,
    spike_ratio: float,
    entry_price: float,
    ask_pct: float,
    tod: str,
    option_type: str,
    trading_day: str,
    pre_trade_count: int = 0,
    adj_cofire: bool = False,
    first_min_share: float | None = None,
    spread_in_bucket: float | None = None,
) -> int:
    s = 0
    # DTE
    if   dte == 0:    s += 10
    elif dte <= 3:    s += 4
    elif dte <= 7:    s += 0
    elif dte <= 30:   s += -3
    else:             s += -8
    # Baseline volume
    if   baseline_volume <= 50:  s += -1
    elif baseline_volume <= 200: s += 3
    elif baseline_volume <= 500: s += 5
    # Spike ratio
    if   spike_ratio <= 10:  s += 5
    elif spike_ratio <= 25:  s += 3
    elif spike_ratio <= 50:  s += 1
    elif spike_ratio <= 100: s += 0
    else:                    s += -3
    # Entry price
    if   entry_price <= 0.5: s += 5
    elif entry_price <= 1.0: s += 0
    elif entry_price <= 5.0: s += -2
    else:                    s += -5
    # TOD
    s += _TOD_WEIGHTS[tod]
    # Ask% — saturation cliff at ask_pct = 1.0 forces tier3 (spec:
    # docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md).
    # Penalty escalated -30 → -32 in Phase B then -32 → -36 in
    # Phase D-1 (2026-05-17) to preserve the tier3 invariant against
    # the cumulative bonuses (max +44 with cadence + spread).
    if   ask_pct < 0.85: s += 2
    elif ask_pct < 0.95: s += 1
    elif ask_pct < 1.0:  s += -1
    else:                s += -36
    # Call bonus
    if option_type == 'C':
        s += 1
    # DOW × option_type bonus
    s += _dow_type_bonus(trading_day, option_type)
    # Pre-trade-count heavy-activity bonus (≥501 trades pre-spike).
    if pre_trade_count >= _PRE_TRADE_COUNT_HEAVY_THRESHOLD:
        s += _PRE_TRADE_COUNT_HEAVY_BONUS
    # Adjacent-strike co-fire bonus (Phase B).
    if adj_cofire:
        s += _ADJ_COFIRE_BONUS
    # Phase D-1 H2 cadence bonus/penalty.
    if first_min_share is not None:
        if first_min_share < _FIRST_MIN_SHARE_DISTRIBUTED_MAX:
            s += _FIRST_MIN_SHARE_DISTRIBUTED_BONUS
        elif first_min_share > _FIRST_MIN_SHARE_SINGLE_BLOCK_MIN:
            s += _FIRST_MIN_SHARE_SINGLE_BLOCK_PENALTY
    # Phase D-1 H5 in-bucket spread bonus/penalty.
    if spread_in_bucket is not None:
        if spread_in_bucket < _SPREAD_IN_BUCKET_Q0_MAX:
            s += _SPREAD_IN_BUCKET_TIGHT_PENALTY
        elif spread_in_bucket >= _SPREAD_IN_BUCKET_Q3_MIN:
            s += _SPREAD_IN_BUCKET_WIDE_BONUS
    return s


def silent_boom_tier(score: int) -> str:
    if score >= TIER1_MIN_SCORE:
        return 'tier1'
    if score >= TIER2_MIN_SCORE:
        return 'tier2'
    return 'tier3'


def _fetch_flow_diff_for_day(conn, date_str: str, source: str) -> pd.DataFrame:
    """Pull every flow_data tick for one source on the trading day plus
    a 30-min pre-buffer. Returns columns [timestamp, diff] sorted
    ascending."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT timestamp, ncp, npp
        FROM flow_data
        WHERE source = %s
          AND timestamp >= (%s::date - INTERVAL '30 minutes')::timestamptz
          AND timestamp < (%s::date + INTERVAL '1 day')::timestamptz
        ORDER BY timestamp ASC
        """,
        (source, date_str, date_str),
    )
    rows = cur.fetchall()
    if not rows:
        return pd.DataFrame(columns=['timestamp', 'diff'])
    df = pd.DataFrame(rows, columns=['timestamp', 'ncp', 'npp'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    df['diff'] = df['ncp'].astype(float) - df['npp'].astype(float)
    return df[['timestamp', 'diff']]


def fetch_market_tide_for_day(conn, date_str: str) -> pd.DataFrame:
    """Pull every market_tide tick for the trading day plus a 30-min
    pre-buffer. Returned sorted ascending."""
    return _fetch_flow_diff_for_day(conn, date_str, 'market_tide')


def fetch_zero_dte_flow_for_day(conn, date_str: str) -> pd.DataFrame:
    """Pull every zero_dte_greek_flow tick for the trading day plus
    a 30-min pre-buffer. Same shape as fetch_market_tide_for_day."""
    return _fetch_flow_diff_for_day(conn, date_str, 'zero_dte_greek_flow')


def fetch_spx_gamma_for_day(conn, date_str: str) -> pd.DataFrame:
    """Pull every SPX spot_exposures tick for the trading day plus a
    30-min pre-buffer. Returns columns [timestamp, gamma_oi] sorted
    ascending."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT timestamp, gamma_oi
        FROM spot_exposures
        WHERE ticker = 'SPX'
          AND timestamp >= (%s::date - INTERVAL '30 minutes')::timestamptz
          AND timestamp < (%s::date + INTERVAL '1 day')::timestamptz
        ORDER BY timestamp ASC
        """,
        (date_str, date_str),
    )
    rows = cur.fetchall()
    if not rows:
        return pd.DataFrame(columns=['timestamp', 'gamma_oi'])
    df = pd.DataFrame(rows, columns=['timestamp', 'gamma_oi'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    df['gamma_oi'] = df['gamma_oi'].astype(float)
    return df


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
          ask_pct, vol_oi, entry_price, open_interest,
          score, score_tier,
          mkt_tide_diff, zero_dte_diff, spx_spot_gamma_oi,
          pre_trade_count, adj_cofire,
          first_min_share, spread_in_bucket
        )
        VALUES %s
        ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
        RETURNING id
        """,
        rows,
        template=(
            '(%s::date, %s::timestamptz, %s, %s, %s, %s::numeric, '
            '%s::date, %s, %s, %s::numeric, %s::numeric, %s::numeric, '
            '%s::numeric, %s::numeric, %s, %s::smallint, %s, '
            '%s, %s, %s, %s, %s, %s::numeric, %s::numeric)'
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
        # Pull macro snapshots for the day once. Each fire's
        # mkt_tide_diff / zero_dte_diff / spx_spot_gamma_oi is the
        # latest tick at or before bucket_ct, capped to a 30-min
        # staleness window — same semantics as the cron's lookupAt()
        # and the lottery cron's macro snapshot.
        tide_df = fetch_market_tide_for_day(conn, date_str)
        zero_dte_df = fetch_zero_dte_flow_for_day(conn, date_str)
        spx_gamma_df = fetch_spx_gamma_for_day(conn, date_str)
        if not tide_df.empty:
            tide_df = tide_df.sort_values('timestamp').reset_index(drop=True)
        if not zero_dte_df.empty:
            zero_dte_df = zero_dte_df.sort_values('timestamp').reset_index(drop=True)
        if not spx_gamma_df.empty:
            spx_gamma_df = spx_gamma_df.sort_values('timestamp').reset_index(drop=True)

        def _lookup_latest(
            df: pd.DataFrame, col: str, bucket_ts: pd.Timestamp
        ) -> float | None:
            """Latest df[col] whose timestamp ≤ bucket_ts within 30 min."""
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

        def lookup_tide_diff(bucket_ts: pd.Timestamp) -> float | None:
            return _lookup_latest(tide_df, 'diff', bucket_ts)

        def lookup_zero_dte_diff(bucket_ts: pd.Timestamp) -> float | None:
            return _lookup_latest(zero_dte_df, 'diff', bucket_ts)

        def lookup_spx_gamma(bucket_ts: pd.Timestamp) -> float | None:
            return _lookup_latest(spx_gamma_df, 'gamma_oi', bucket_ts)

        # Phase B: split detection from scoring so the cofire keyset
        # can see ALL fires on the day before any one fire is scored.
        rows_to_insert: list[tuple] = []
        fires_today = 0
        # Pre-pass: detect fires per chain, collect into a flat list.
        detected: list[dict] = []
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

        # Build the cofire keyset from ALL detected fires on this day.
        # Key matches the live cron's `${ticker}|${opt_type}|${ts}|${strike}`
        # shape. The parquet backfill processes one day at a time, so
        # "all detected on this day" === "all cofire candidates".
        cofire_keyset: set[str] = set()
        for d in detected:
            bucket_ts_iso = d['f']['bucket'].isoformat()
            cofire_keyset.add(
                f"{d['ticker']}|{d['opt_type']}|{bucket_ts_iso}|"
                f"{d['strike']}"
            )

        # Main pass: score + collect each fire.
        for d in detected:
            chain_id = d['chain_id']
            sub = d['sub']
            ticker = d['ticker']
            opt_type = d['opt_type']
            strike = d['strike']
            exp_str = d['exp_str']
            dte = d['dte']
            f = d['f']
            bucket_ts: pd.Timestamp = f['bucket']
            if bucket_ts.tz is None:
                bucket_ts = bucket_ts.tz_localize('UTC')
            bucket_ct = bucket_ts.tz_convert('America/Chicago')
            ct_min_of_day = bucket_ct.hour * 60 + bucket_ct.minute
            tod = silent_boom_tod_from_minute_ct(ct_min_of_day)
            # Pre-trade-count: sum n_trades across this chain's
            # buckets *before* the spike's bucket. The cron uses a
            # session-open boundary; in the parquet path we use
            # "all prior buckets" since options day-trade in
            # regular session only — overnight/extended-hours
            # ticks for SB universe chains are rare enough that
            # the few extras land far below the 501-trade
            # threshold and don't change scoring.
            pre_trade_count = int(
                sub.loc[sub['bucket'] < bucket_ts, 'n_trades'].sum()
            )
            # Adjacent-strike co-fire (Phase B). Step = $5 for index
            # roots, $1 otherwise. Same lookup logic as the cron's
            # cofire keyset.
            cofire_step = _adj_cofire_strike_step(ticker)
            bucket_ts_iso = f['bucket'].isoformat()
            adj_cofire = (
                f"{ticker}|{opt_type}|{bucket_ts_iso}|{strike + cofire_step}"
                in cofire_keyset
                or
                f"{ticker}|{opt_type}|{bucket_ts_iso}|{strike - cofire_step}"
                in cofire_keyset
            )
            # Phase D-1 — H2 cadence (from the agg) + H5 spread (Bot-
            # Eod parquet doesn't carry NBBO so always None here; the
            # fulltape backfill populates spread).
            bucket_row = sub.loc[sub['bucket'] == bucket_ts]
            if len(bucket_row) > 0 and 'first_min_share' in bucket_row.columns:
                fms_val = bucket_row['first_min_share'].iloc[0]
                first_min_share = (
                    float(fms_val) if pd.notna(fms_val) else None
                )
            else:
                first_min_share = None
            spread_in_bucket = None
            score = compute_silent_boom_score(
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
            tier = silent_boom_tier(score)
            tide_diff = lookup_tide_diff(bucket_ts)
            zero_dte_diff = lookup_zero_dte_diff(bucket_ts)
            spx_spot_gamma = lookup_spx_gamma(bucket_ts)
            rows_to_insert.append((
                date_str,
                f['bucket'].isoformat(),
                chain_id, ticker,
                opt_type, strike, exp_str, dte,
                f['spike_volume'], f['baseline_volume'], f['spike_ratio'],
                f['ask_pct'], f['vol_oi'], f['entry_price'],
                f['open_interest'],
                score, tier,
                tide_diff, zero_dte_diff, spx_spot_gamma,
                pre_trade_count, adj_cofire,
                first_min_share, spread_in_bucket,
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
