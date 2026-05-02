"""Phase 2 — extract pre-burst features for explosive chains and matched controls.

For each explosive chain identified in Phase 1:
  1. Find the BURST MINUTE — the minute with the largest volume
     in the 30-min window leading up to the peak price.
  2. Capture features in the [burst-30min, burst+1min] pre-burst window:
     - vol_to_oi_at_burst        (cumulative volume / OI at burst time)
     - ask_pct_pre_burst         (ask% in pre-burst window, count)
     - ask_pct_burst_minute      (ask% in the burst minute itself)
     - pay_up_factor             (burst_min_price / day_median_price)
     - vol_concentration         (% of day's vol in burst+adjacent 5 min)
     - iv_at_burst               (IV at last print before burst)
     - delta_at_burst            (delta at last print before burst)
     - cbmo_share_pre            (% of pre-burst PREMIUM from cbmo/m* SIP codes)
  3. For each explosive chain, sample 5 control chains:
     same ticker + same DTE±1 + |otm_pct - explosive_otm| < 1%, that did NOT explode.
  4. Compare feature distributions explosive vs control.

Output: outputs/p2_features.csv
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
PRE_WINDOWS_MIN = [10, 30, 60]  # capture features at all three windows
CONTROLS_PER_EXPLOSIVE = 5
BASELINE_PRICE_FLOOR = 0.05  # match Phase 1 noise filter
COLS = [
    'executed_at',
    'underlying_symbol',
    'option_chain_id',
    'side',
    'option_type',
    'expiry',
    'strike',
    'underlying_price',
    'price',
    'size',
    'premium',
    'volume',
    'open_interest',
    'implied_volatility',
    'delta',
    'upstream_condition_detail',
    'report_flags',
    'canceled',
]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def _window_features(window_df: pd.DataFrame, full_df: pd.DataFrame, prefix: str) -> dict:
    """Features within a specific pre-burst window."""
    if len(window_df) == 0:
        return {f'{prefix}_{k}': np.nan for k in [
            'print_count', 'ask_pct', 'sweep_share', 'inst_share',
            'mean_iv', 'mean_delta', 'vol_to_oi', 'pay_up',
        ]}
    ask = (window_df['side'] == 'ask').sum()
    bid = (window_df['side'] == 'bid').sum()
    inst_mask = window_df['upstream_condition_detail'].str.startswith(
        ('cbmo', 'mle', 'mla', 'mlf', 'mfs', 'mlc', 'mas'), na=False
    )
    pre_volume = window_df['size'].sum()
    oi = full_df['open_interest'].max()
    median_price = full_df['price'].median()
    return {
        f'{prefix}_print_count': len(window_df),
        f'{prefix}_ask_pct': ask / max(ask + bid, 1),
        f'{prefix}_sweep_share': window_df['report_flags'].str.contains('sweep', na=False).mean(),
        f'{prefix}_inst_share': inst_mask.mean(),
        f'{prefix}_mean_iv': window_df['implied_volatility'].mean(),
        f'{prefix}_mean_delta': window_df['delta'].mean(),
        f'{prefix}_vol_to_oi': pre_volume / max(oi, 1),
        f'{prefix}_pay_up': window_df['price'].mean() / max(median_price, 0.01),
    }


def _features_for_chain(chain_df: pd.DataFrame, peak_price: float) -> dict:
    """Compute pre-burst features at THREE window sizes for a single chain's day."""
    g = chain_df.sort_values('ts_ct').reset_index(drop=True)
    if len(g) < 5:
        return {}

    # Identify peak time
    peak_idx = (g['price'] >= peak_price * 0.999).idxmax()
    peak_time = g.loc[peak_idx, 'ts_ct']

    # Burst minute = highest-volume minute in 30-min pre-burst window (or peak min)
    pre30_start = peak_time - pd.Timedelta(minutes=30)
    pre30 = g.loc[(g['ts_ct'] >= pre30_start) & (g['ts_ct'] < peak_time)]
    if len(pre30) > 0:
        pre30_min = pre30.assign(minute=pre30['ts_ct'].dt.floor('1min'))
        vol_per_min = pre30_min.groupby('minute')['size'].sum()
        burst_minute = vol_per_min.idxmax() if len(vol_per_min) > 0 else peak_time.floor('1min')
    else:
        burst_minute = peak_time.floor('1min')
    g['minute'] = g['ts_ct'].dt.floor('1min')
    burst_min_df = g.loc[g['minute'] == burst_minute]

    # Compute features for all three window sizes
    out: dict = {
        'burst_minute_ct': burst_minute,
        'burst_avg_price': burst_min_df['price'].mean() if len(burst_min_df) > 0 else np.nan,
        'burst_minute_volume': burst_min_df['size'].sum(),
        'burst_minute_ask_pct': (
            (burst_min_df['side'] == 'ask').sum() / max(len(burst_min_df), 1)
        ),
    }
    for window_min in PRE_WINDOWS_MIN:
        win_start = peak_time - pd.Timedelta(minutes=window_min)
        win = g.loc[(g['ts_ct'] >= win_start) & (g['ts_ct'] < peak_time)]
        out.update(_window_features(win, g, f'pre{window_min}'))

    return out


def process_day(f: str, universe: pd.DataFrame) -> pd.DataFrame:
    """For one trade-day file: extract features for explosive chains + matched controls."""
    name = Path(f).name
    print(f'  {name}: loading...', flush=True)
    t = pq.read_table(f, columns=COLS)
    df = t.to_pandas()
    df['canceled'] = _coerce_canceled(df['canceled'])
    df = df.loc[~df['canceled']]
    for c in ['underlying_symbol', 'side', 'option_type', 'option_chain_id',
              'upstream_condition_detail', 'report_flags']:
        df[c] = df[c].astype(str)
    df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    df['date'] = df['ts_ct'].dt.date
    df['hour_min'] = df['ts_ct'].dt.hour * 60 + df['ts_ct'].dt.minute
    df = df.loc[(df['hour_min'] >= 510) & (df['hour_min'] < 900) & (df['price'] > 0)]
    if len(df) == 0:
        return pd.DataFrame()

    day = df['date'].iloc[0]
    day_universe = universe.loc[universe['date'] == pd.Timestamp(day)]
    if len(day_universe) == 0:
        return pd.DataFrame()

    # Get all chain IDs we need: explosive + 3 controls per explosive
    explosive_ids = day_universe['option_chain_id'].tolist()

    # Build candidate-control pool: chains with >=100 prints that did NOT explode
    print_counts = df.groupby('option_chain_id').size()
    candidate_pool = print_counts.loc[
        (print_counts >= 100) & (~print_counts.index.isin(explosive_ids))
    ].index.tolist()

    pool_meta = df.loc[df['option_chain_id'].isin(candidate_pool)].groupby(
        'option_chain_id'
    ).agg(
        underlying_symbol=('underlying_symbol', 'first'),
        option_type=('option_type', 'first'),
        strike=('strike', 'first'),
        expiry=('expiry', 'first'),
        spot_open=('underlying_price', 'first'),
    )
    pool_meta['dte'] = (pool_meta['expiry'] - day).apply(lambda x: x.days)
    pool_meta['otm_pct'] = (pool_meta['strike'] - pool_meta['spot_open']) / pool_meta['spot_open'] * 100
    pool_meta.loc[pool_meta['option_type'] == 'put', 'otm_pct'] = -pool_meta['otm_pct']

    # For each explosive chain: pick up to N controls matching ticker/dte/otm
    rng = np.random.default_rng(42)
    control_ids: list[str] = []
    for _, row in day_universe.iterrows():
        cands = pool_meta.loc[
            (pool_meta['underlying_symbol'] == row['underlying_symbol'])
            & (pool_meta['option_type'] == row['option_type'])
            & (np.abs(pool_meta['dte'] - row['dte']) <= 1)
            & (np.abs(pool_meta['otm_pct'] - row['otm_pct']) <= 1.5)
        ]
        if len(cands) == 0:
            continue
        picks = cands.sample(
            min(CONTROLS_PER_EXPLOSIVE, len(cands)),
            random_state=int(rng.integers(0, 1e9))
        )
        control_ids.extend(picks.index.tolist())

    all_ids = set(explosive_ids) | set(control_ids)
    df_subset = df.loc[df['option_chain_id'].isin(all_ids)].copy()
    print(f'  {name}: extracting features for {len(explosive_ids):,} explosive + {len(control_ids):,} controls', flush=True)

    # Iterate explosive then controls, compute features
    rows: list[dict] = []
    for ch_id, group in df_subset.groupby('option_chain_id'):
        is_explosive = ch_id in set(explosive_ids)
        if is_explosive:
            peak = day_universe.loc[
                day_universe['option_chain_id'] == ch_id, 'peak_price'
            ].iloc[0]
        else:
            peak = group['price'].max()
        feat = _features_for_chain(group, peak)
        if not feat:
            continue
        meta = day_universe.loc[
            day_universe['option_chain_id'] == ch_id
        ].iloc[0].to_dict() if is_explosive else {
            'date': pd.Timestamp(day),
            'option_chain_id': ch_id,
            'underlying_symbol': group['underlying_symbol'].iloc[0],
            'option_type': group['option_type'].iloc[0],
            'strike': group['strike'].iloc[0],
            'expiry': group['expiry'].iloc[0],
            'baseline_price': group['price'].iloc[:50].mean(),
            'peak_price': peak,
            'multiple': peak / max(group['price'].iloc[:50].mean(), 0.01),
            'dte': pool_meta.loc[ch_id, 'dte'] if ch_id in pool_meta.index else np.nan,
            'otm_pct': pool_meta.loc[ch_id, 'otm_pct'] if ch_id in pool_meta.index else np.nan,
        }
        feat.update(meta)
        feat['is_explosive'] = is_explosive
        rows.append(feat)
    return pd.DataFrame(rows)


def main() -> None:
    universe_csv = OUT / 'outputs' / 'p1_explosive_movers.csv'
    universe = pd.read_csv(universe_csv, parse_dates=['date'])
    # Apply the same baseline-noise filter as Phase 1
    universe = universe.loc[universe['baseline_price'] >= BASELINE_PRICE_FLOOR]
    print(f'Loaded universe: {len(universe):,} explosive chain-days (baseline >= ${BASELINE_PRICE_FLOOR})')
    print(f'Pre-burst windows: {PRE_WINDOWS_MIN} min')
    print(f'Controls per explosive: {CONTROLS_PER_EXPLOSIVE}')

    all_features: list[pd.DataFrame] = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        all_features.append(process_day(f, universe))

    feats = pd.concat(all_features, ignore_index=True)
    out_csv = OUT / 'outputs' / 'p2_features.csv'
    feats.to_csv(out_csv, index=False)
    print(f'\nSaved features → {out_csv}  ({len(feats):,} rows)')

    # Comparison across all 3 windows: explosive vs control (median values)
    print('\n=== Feature comparison: explosive vs control (median values, by window) ===')
    base_features = ['ask_pct', 'sweep_share', 'inst_share', 'mean_iv',
                     'mean_delta', 'vol_to_oi', 'pay_up']
    rows = []
    for feat in base_features:
        for w in PRE_WINDOWS_MIN:
            col = f'pre{w}_{feat}'
            if col not in feats.columns:
                continue
            exp_med = feats.loc[feats['is_explosive'], col].median()
            ctl_med = feats.loc[~feats['is_explosive'], col].median()
            ratio = exp_med / ctl_med if ctl_med and ctl_med > 0 else np.nan
            rows.append({
                'feature': feat,
                'window_min': w,
                'explosive_median': exp_med,
                'control_median': ctl_med,
                'ratio_e_to_c': ratio,
            })
    cmp_df = pd.DataFrame(rows)
    print(cmp_df.round(3).to_string(index=False))
    cmp_df.to_csv(OUT / 'outputs' / 'p2_comparison.csv', index=False)

    # Burst-minute specific (single value, not windowed)
    print('\n=== Burst-minute specific stats ===')
    burst_cols = ['burst_minute_volume', 'burst_minute_ask_pct']
    print(feats.groupby('is_explosive')[burst_cols].median().T.round(3))


if __name__ == '__main__':
    main()
