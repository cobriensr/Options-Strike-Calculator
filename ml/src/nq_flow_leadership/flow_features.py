"""Phase 1 — minute-bucketed flow features for the 6-ticker predictor universe.

Reads ml/data/nq-flow-leadership/options_filtered_*.parquet, computes
six families of flow features per (minute, ticker, expiry_filter), applies
rolling-window aggregation at 1/5/15/30 min, and writes a wide table to
ml/data/nq-flow-leadership/features_minute.parquet.

Methodology:
  - Compute per-minute "primitives" (sums of premium, signed delta-weighted
    premium, etc.) using groupby aggregations.
  - Reindex to the full session minute grid per (date, ticker) so rolling
    windows align even when a thin ticker (NDX) has empty minutes.
  - Apply rolling SUM at 1/5/15/30 min on the primitives.
  - Derive ratio features (PWDD, aggression ratio, call/put imbalance)
    from rolling-summed numerators and denominators — NOT by averaging
    per-minute ratios, which would equal-weight low-volume minutes.
  - Reset rolling windows at session boundaries (per-day groupby).

Features computed:
  - pwdd          - premium-weighted signed-delta directional flow
  - otm_vega      - signed vega-weighted premium for |delta| < 0.30
  - aggr_ratio    - ask_premium / (ask_premium + bid_premium)
  - sweep_count   - count of intermarket_sweep prints
  - sweep_premium - premium of intermarket_sweep prints
  - call_put_imb  - (call_ask_prem - put_ask_prem) / (call_ask_prem + put_ask_prem)
                    (0dte-only by design)

Each feature computed for both 0dte and all-expiry subsets where applicable.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = Path(__file__).resolve().parents[3] / 'ml' / 'data' / 'nq-flow-leadership'
OUTPUT_PATH = DATA_DIR / 'features_minute.parquet'

ROLLING_WINDOWS = (1, 5, 15, 30)
PREDICTOR_TICKERS = ['QQQ', 'SPY', 'SPX', 'SPXW', 'NDX', 'NDXP']

# Session: 08:30 - 15:00 CT == 390 minutes
SESSION_MINUTES = 390


def load_one_day(path: Path) -> pd.DataFrame:
    """Load + augment one day's filtered options data with helper cols."""
    df = pq.read_table(str(path)).to_pandas()

    # Minute-floored timestamp (UTC), used as the join key with NQ bars.
    df['minute_ts'] = df['executed_at'].dt.floor('1min')
    # CT date for 0DTE detection.
    ts_ct = df['executed_at'].dt.tz_convert('America/Chicago')
    df['trade_date_ct'] = ts_ct.dt.date
    df['is_0dte'] = df['expiry'] == df['trade_date_ct']

    # Tape-side sign: ask=+1 (aggressive buying), bid=-1 (aggressive selling).
    # mid/no_side -> 0 (no aggression signal).
    df['side_sign'] = np.where(
        df['side'] == 'ask', 1.0,
        np.where(df['side'] == 'bid', -1.0, 0.0),
    )

    # Coerce numeric cols to float32 for memory; greeks can be NaN for some rows.
    for col in ('delta', 'vega', 'premium'):
        df[col] = df[col].astype('float32')

    # Sweep flag from report_flags (Postgres array literal '{intermarket_sweep,...}').
    df['is_sweep'] = df['report_flags'].fillna('').str.contains(
        'intermarket_sweep', regex=False
    )

    # OTM flag: |delta| < 0.30 (covers both calls and puts since delta is signed).
    df['is_otm'] = df['delta'].abs() < 0.30

    return df


def compute_primitives(df: pd.DataFrame, expiry_filter: str) -> pd.DataFrame:
    """Group by (minute_ts, underlying_symbol) and emit primitive aggregates.

    expiry_filter: '0dte' or 'all'
    """
    if expiry_filter == '0dte':
        sub = df[df['is_0dte']].copy()
    elif expiry_filter == 'all':
        sub = df
    else:
        raise ValueError(f'unknown expiry_filter: {expiry_filter}')

    if sub.empty:
        return pd.DataFrame()

    # Helper masks (reuse-once via local variables for readability).
    is_call = sub['option_type'] == 'call'
    is_put = sub['option_type'] == 'put'
    is_ask = sub['side'] == 'ask'
    is_bid = sub['side'] == 'bid'
    otm = sub['is_otm']
    prem = sub['premium'].fillna(0)
    delta = sub['delta'].fillna(0)
    side_sign = sub['side_sign']

    # Bull/bear sweep direction:
    #   bull  = call hitting ask (calls bought)  OR  put hitting bid (puts sold)
    #   bear  = put  hitting ask (puts  bought)  OR  call hitting bid (calls sold)
    is_bull_sweep = sub['is_sweep'] & ((is_call & is_ask) | (is_put & is_bid))
    is_bear_sweep = sub['is_sweep'] & ((is_put & is_ask) | (is_call & is_bid))

    sub = sub.assign(
        signed_delta_premium=side_sign * delta * prem,
        signed_otm_vega_premium=(
            side_sign * sub['vega'].fillna(0) * prem * otm.astype('float32')
        ),
        signed_otm_delta_premium=side_sign * delta * prem * otm.astype('float32'),
        ask_premium=np.where(is_ask, prem, 0.0),
        bid_premium=np.where(is_bid, prem, 0.0),
        sweep_premium=np.where(sub['is_sweep'], prem, 0.0),
        # Side x type quadrants (the four UW Market Tide ingredients)
        call_ask_premium=np.where(is_call & is_ask, prem, 0.0),
        call_bid_premium=np.where(is_call & is_bid, prem, 0.0),
        put_ask_premium=np.where(is_put & is_ask, prem, 0.0),
        put_bid_premium=np.where(is_put & is_bid, prem, 0.0),
        # OTM-only versions (UW's "OTM Tide" view)
        call_ask_premium_otm=np.where(is_call & is_ask & otm, prem, 0.0),
        call_bid_premium_otm=np.where(is_call & is_bid & otm, prem, 0.0),
        put_ask_premium_otm=np.where(is_put & is_ask & otm, prem, 0.0),
        put_bid_premium_otm=np.where(is_put & is_bid & otm, prem, 0.0),
        # Directional sweep primitives
        is_bull_sweep=is_bull_sweep,
        is_bear_sweep=is_bear_sweep,
        bull_sweep_premium=np.where(is_bull_sweep, prem, 0.0),
        bear_sweep_premium=np.where(is_bear_sweep, prem, 0.0),
    )

    grouped = sub.groupby(['minute_ts', 'underlying_symbol'], observed=True).agg(
        total_premium=('premium', 'sum'),
        total_trade_count=('premium', 'count'),
        signed_delta_premium=('signed_delta_premium', 'sum'),
        signed_otm_vega_premium=('signed_otm_vega_premium', 'sum'),
        signed_otm_delta_premium=('signed_otm_delta_premium', 'sum'),
        ask_premium=('ask_premium', 'sum'),
        bid_premium=('bid_premium', 'sum'),
        sweep_count=('is_sweep', 'sum'),
        sweep_premium=('sweep_premium', 'sum'),
        bull_sweep_count=('is_bull_sweep', 'sum'),
        bear_sweep_count=('is_bear_sweep', 'sum'),
        bull_sweep_premium=('bull_sweep_premium', 'sum'),
        bear_sweep_premium=('bear_sweep_premium', 'sum'),
        call_ask_premium=('call_ask_premium', 'sum'),
        call_bid_premium=('call_bid_premium', 'sum'),
        put_ask_premium=('put_ask_premium', 'sum'),
        put_bid_premium=('put_bid_premium', 'sum'),
        call_ask_premium_otm=('call_ask_premium_otm', 'sum'),
        call_bid_premium_otm=('call_bid_premium_otm', 'sum'),
        put_ask_premium_otm=('put_ask_premium_otm', 'sum'),
        put_bid_premium_otm=('put_bid_premium_otm', 'sum'),
    )

    return grouped.reset_index()


def reindex_to_full_grid(prims: pd.DataFrame, day_minute_grid: pd.DatetimeIndex) -> pd.DataFrame:
    """Reindex primitives to the full minute grid per ticker, filling missing with 0."""
    out_frames = []
    for ticker in PREDICTOR_TICKERS:
        sub = prims[prims['underlying_symbol'] == ticker].set_index('minute_ts')
        sub = sub.drop(columns='underlying_symbol')
        sub = sub.reindex(day_minute_grid).fillna(0)
        sub['underlying_symbol'] = ticker
        sub.index.name = 'minute_ts'
        out_frames.append(sub.reset_index())
    return pd.concat(out_frames, ignore_index=True)


def apply_rolling_and_derive(
    prims: pd.DataFrame, expiry_label: str
) -> pd.DataFrame:
    """Apply rolling sums per (ticker) and derive ratio features.

    Returns wide DataFrame with one row per minute_ts and columns per
    (ticker, feature, window, expiry_label).
    """
    primitive_cols = [
        'total_premium', 'total_trade_count',
        'signed_delta_premium', 'signed_otm_vega_premium', 'signed_otm_delta_premium',
        'ask_premium', 'bid_premium',
        'sweep_count', 'sweep_premium',
        'bull_sweep_count', 'bear_sweep_count',
        'bull_sweep_premium', 'bear_sweep_premium',
        'call_ask_premium', 'call_bid_premium', 'put_ask_premium', 'put_bid_premium',
        'call_ask_premium_otm', 'call_bid_premium_otm',
        'put_ask_premium_otm', 'put_bid_premium_otm',
    ]

    output: dict[str, pd.Series] = {}
    minute_index: pd.DatetimeIndex | None = None

    for ticker in PREDICTOR_TICKERS:
        sub = prims[prims['underlying_symbol'] == ticker].sort_values('minute_ts').reset_index(drop=True)
        if minute_index is None:
            minute_index = pd.DatetimeIndex(sub['minute_ts'])

        for win in ROLLING_WINDOWS:
            # Rolling sums of primitives.
            rolled = sub[primitive_cols].rolling(window=win, min_periods=1).sum()

            # Derive features from rolled primitives.
            total = rolled['total_premium'].replace(0, np.nan)
            total_count = rolled['total_trade_count'].replace(0, np.nan)
            ask_plus_bid = (rolled['ask_premium'] + rolled['bid_premium']).replace(0, np.nan)
            call_plus_put = (rolled['call_ask_premium'] + rolled['put_ask_premium']).replace(0, np.nan)
            sweep_total_count = (rolled['bull_sweep_count'] + rolled['bear_sweep_count']).replace(0, np.nan)
            sweep_total_prem = (rolled['bull_sweep_premium'] + rolled['bear_sweep_premium']).replace(0, np.nan)
            otm_premium_total = (
                rolled['call_ask_premium_otm'] + rolled['call_bid_premium_otm']
                + rolled['put_ask_premium_otm'] + rolled['put_bid_premium_otm']
            ).replace(0, np.nan)

            features = {
                # ------- Original directional / aggression features
                'pwdd':                rolled['signed_delta_premium'] / total,
                'otm_vega':            rolled['signed_otm_vega_premium'] / total,
                'otm_dir_delta':       rolled['signed_otm_delta_premium'] / total,
                'aggr_ratio':          rolled['ask_premium'] / ask_plus_bid,
                # ------- Sweep features (undirected; kept for back-compat)
                'sweep_count':         rolled['sweep_count'],
                'sweep_premium':       rolled['sweep_premium'],
                'sweep_intensity':     rolled['sweep_count'] / total_count,
                'sweep_intensity_prem': rolled['sweep_premium'] / total,
                # ------- Directional sweep decomposition (the new feature class)
                # bull = call-ask + put-bid sweeps (aggressive bullish flow)
                # bear = put-ask + call-bid sweeps (aggressive bearish flow)
                'bull_sweep_intensity':      rolled['bull_sweep_count'] / total_count,
                'bear_sweep_intensity':      rolled['bear_sweep_count'] / total_count,
                'bull_sweep_intensity_prem': rolled['bull_sweep_premium'] / total,
                'bear_sweep_intensity_prem': rolled['bear_sweep_premium'] / total,
                # Imbalance: +1 = pure bull sweeps, -1 = pure bear sweeps, 0 = balanced
                'sweep_dir_imbalance':       (rolled['bull_sweep_count'] - rolled['bear_sweep_count']) / sweep_total_count,
                'sweep_dir_imbalance_prem':  (rolled['bull_sweep_premium'] - rolled['bear_sweep_premium']) / sweep_total_prem,
                # ------- UW Market Tide-style features
                # NCP: net call premium = (calls bought) - (calls sold), normalized by total premium
                # NPP: net put  premium = (puts  bought) - (puts  sold), normalized by total premium
                # net_dir = bullish flow minus bearish flow (the canonical "tide" direction)
                'ncp':                 (rolled['call_ask_premium'] - rolled['call_bid_premium']) / total,
                'npp':                 (rolled['put_ask_premium']  - rolled['put_bid_premium'])  / total,
                'net_dir_premium':     (
                    (rolled['call_ask_premium'] + rolled['put_bid_premium'])
                    - (rolled['call_bid_premium'] + rolled['put_ask_premium'])
                ) / total,
                # OTM versions (UW's "OTM Tide" view — speculative/lottery-ticket flow)
                'ncp_otm':             (rolled['call_ask_premium_otm'] - rolled['call_bid_premium_otm']) / otm_premium_total,
                'npp_otm':             (rolled['put_ask_premium_otm']  - rolled['put_bid_premium_otm'])  / otm_premium_total,
                'net_dir_premium_otm': (
                    (rolled['call_ask_premium_otm'] + rolled['put_bid_premium_otm'])
                    - (rolled['call_bid_premium_otm'] + rolled['put_ask_premium_otm'])
                ) / otm_premium_total,
                # ------- Original
                'call_put_imb':        (rolled['call_ask_premium'] - rolled['put_ask_premium']) / call_plus_put,
            }
            # call_put_imb is meaningful only for 0dte; skip for 'all'.
            if expiry_label == 'all':
                features.pop('call_put_imb')

            for feat_name, series in features.items():
                col = f'{ticker}_{feat_name}_{win}m_{expiry_label}'
                output[col] = series.values

    # Build the wide DataFrame.
    out_df = pd.DataFrame(output, index=minute_index)
    out_df.index.name = 'minute_ts'
    return out_df.reset_index()


def process_day(path: Path) -> pd.DataFrame:
    """Process one day end-to-end: load -> primitives -> rolling -> wide features."""
    df = load_one_day(path)
    if df.empty:
        return pd.DataFrame()

    # Build the full RTH minute grid for this day in UTC (from the data itself).
    day_min = df['minute_ts'].min()
    day_max = df['minute_ts'].max()
    day_grid = pd.date_range(start=day_min, end=day_max, freq='1min', tz='UTC')

    # Compute features for both expiry filters.
    pieces = []
    for expiry_label in ('0dte', 'all'):
        prims = compute_primitives(df, expiry_label)
        if prims.empty:
            continue
        prims_full = reindex_to_full_grid(prims, day_grid)
        wide = apply_rolling_and_derive(prims_full, expiry_label)
        pieces.append(wide)

    # Merge the two expiry-label wide frames on minute_ts.
    if not pieces:
        return pd.DataFrame()
    merged = pieces[0]
    for piece in pieces[1:]:
        merged = merged.merge(piece, on='minute_ts', how='outer')
    return merged.sort_values('minute_ts').reset_index(drop=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--limit', type=int, default=None, help='Process only N days (timing probe)')
    args = p.parse_args()

    files = sorted(DATA_DIR.glob('options_filtered_*.parquet'))
    if args.limit:
        files = files[: args.limit]

    if not files:
        print(f'ERROR: no filtered parquet in {DATA_DIR}', file=sys.stderr)
        return 1

    all_features = []
    t_start = time.time()
    for path in files:
        date_part = path.stem.replace('options_filtered_', '')
        t0 = time.time()
        feats = process_day(path)
        t1 = time.time()
        all_features.append(feats)
        print(f'{date_part}: {len(feats):>4} minute rows, {len(feats.columns):>4} cols, {t1 - t0:.1f}s')

    final = pd.concat(all_features, ignore_index=True).sort_values('minute_ts').reset_index(drop=True)

    # Write only if not in --limit (probe) mode.
    if args.limit is None:
        final.to_parquet(OUTPUT_PATH, compression='zstd')
        print(f'\nWrote {OUTPUT_PATH} ({len(final):,} rows, {len(final.columns):,} cols) in {time.time() - t_start:.1f}s')
    else:
        print(f'\n[probe mode] {len(final):,} rows, {len(final.columns):,} cols in {time.time() - t_start:.1f}s')
        # Show a preview of cols + non-null sanity
        sample_cols = [c for c in final.columns if c != 'minute_ts'][:6]
        print('\nSample cols + non-null counts:')
        for c in sample_cols:
            nn = final[c].notna().sum()
            print(f'  {c}: {nn}/{len(final)} non-null, range=[{final[c].min():.3g}, {final[c].max():.3g}]')

    return 0


if __name__ == '__main__':
    sys.exit(main())
