"""Phase 1 — find every option chain that went 5x+ from morning baseline.

For each (date, chain):
  baseline = avg fill price during first 30 min of session (08:30-09:00 CT)
  peak     = max price reached after baseline window
  multiple = peak / baseline

Output: CSV of every chain with multiple >= 5x, sorted by multiple.
"""
from __future__ import annotations

import glob
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
THRESHOLD = 5.0  # multiple
MIN_PRINTS = 100  # liquidity filter — skip noise chains
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
    'canceled',
]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def process_file(f: str) -> pd.DataFrame:
    """Process one trade-day file, return per-chain metrics for explosive chains."""
    name = Path(f).name
    print(f'  {name}: loading...', flush=True)
    t = pq.read_table(f, columns=COLS)
    df = t.to_pandas()
    df['canceled'] = _coerce_canceled(df['canceled'])
    df = df.loc[~df['canceled']]
    for c in ['underlying_symbol', 'side', 'option_type', 'option_chain_id']:
        df[c] = df[c].astype(str)

    # CT timestamps + RTH filter
    df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    df['date'] = df['ts_ct'].dt.date
    df['hour_min'] = df['ts_ct'].dt.hour * 60 + df['ts_ct'].dt.minute
    df = df.loc[(df['hour_min'] >= 510) & (df['hour_min'] < 900)]  # 08:30 - 14:59 CT
    if len(df) == 0:
        return pd.DataFrame()
    df = df.loc[df['price'] > 0]

    print(f'  {name}: {len(df):,} rows after RTH filter; computing per-chain metrics...', flush=True)

    # Per-chain print count filter
    print_counts = df.groupby('option_chain_id').size()
    keep = print_counts.loc[print_counts >= MIN_PRINTS].index
    df = df.loc[df['option_chain_id'].isin(keep)].copy()
    print(f'  {name}: {df["option_chain_id"].nunique():,} chains pass MIN_PRINTS={MIN_PRINTS}', flush=True)

    # TRADE-RELEVANT MULTIPLE:
    #   For each chain, sort by time, then compute:
    #     running_min[t] = min(price up to and including t)
    #     future_max[t]  = max(price from t onwards)
    #     trade_mult[t]  = future_max[t] / running_min[t]
    #   Chain multiple = max(trade_mult) — the best buy/sell you could have caught.
    df = df.sort_values('ts_ct').reset_index(drop=True)
    gp = df.groupby('option_chain_id', sort=False)['price']
    df['running_min'] = gp.cummin()
    # future_max via reverse cummax
    df_rev = df.iloc[::-1].copy()
    df_rev['future_max'] = df_rev.groupby('option_chain_id', sort=False)['price'].cummax()
    df['future_max'] = df_rev['future_max'].iloc[::-1].values
    df['trade_mult'] = df['future_max'] / df['running_min'].clip(lower=0.01)

    # Per-chain best trade multiple + the timestamp where running_min hit
    chain_mult = df.groupby('option_chain_id')['trade_mult'].max().rename('multiple')
    # baseline_price = price at the running-min entry point that yields max multiple
    best_idx = df.groupby('option_chain_id')['trade_mult'].idxmax()
    entry_meta = df.loc[best_idx, [
        'option_chain_id', 'ts_ct', 'price', 'future_max', 'running_min'
    ]].set_index('option_chain_id')
    entry_meta.columns = ['entry_time_ct', 'price_at_entry', 'peak_after_entry', 'baseline_price']
    baseline_full = entry_meta['baseline_price'].reindex(keep).dropna()

    # Peak = max price across the day
    peak = df.groupby('option_chain_id')['price'].max().rename('peak_price')

    # Time of peak (informational)
    peak_idx = df.groupby('option_chain_id')['price'].idxmax()
    peak_meta = df.loc[peak_idx, [
        'option_chain_id', 'ts_ct', 'underlying_price', 'side',
    ]].set_index('option_chain_id')
    peak_meta.columns = ['peak_time_ct', 'spot_at_peak', 'side_at_peak']
    # Add the entry-time meta from the best-trade calc
    peak_meta = peak_meta.join(entry_meta[['entry_time_ct', 'price_at_entry']])

    # Vectorize ask/bid counts as int columns; eliminates the slow agg lambdas
    df['is_ask'] = (df['side'] == 'ask').astype('int32')
    df['is_bid'] = (df['side'] == 'bid').astype('int32')
    chain_meta = df.groupby('option_chain_id').agg(
        underlying_symbol=('underlying_symbol', 'first'),
        option_type=('option_type', 'first'),
        strike=('strike', 'first'),
        expiry=('expiry', 'first'),
        prints=('price', 'size'),
        total_premium=('premium', 'sum'),
        total_volume=('size', 'sum'),
        open_interest=('open_interest', 'max'),
        spot_open=('underlying_price', 'first'),
        spot_close=('underlying_price', 'last'),
        ask_count=('is_ask', 'sum'),
        bid_count=('is_bid', 'sum'),
    )

    out = chain_meta.join(baseline_full).join(peak).join(peak_meta).join(chain_mult)
    out['date'] = pd.Timestamp(df['date'].iloc[0])
    out['ask_pct'] = out['ask_count'] / (out['ask_count'] + out['bid_count']).clip(lower=1)
    out['vol_to_oi'] = out['total_volume'] / out['open_interest'].clip(lower=1)
    out['dte'] = (out['expiry'] - out['date'].dt.date.iloc[0]).apply(lambda x: x.days)
    out['otm_pct'] = (out['strike'] - out['spot_open']) / out['spot_open'] * 100
    # For puts, OTM is negative direction
    out.loc[out['option_type'] == 'put', 'otm_pct'] = -out['otm_pct']

    explosive = out.loc[out['multiple'] >= THRESHOLD].reset_index()
    print(f'  {name}: {len(explosive):,} explosive chains (>={THRESHOLD}x)', flush=True)
    return explosive


def main() -> None:
    all_explosive = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        all_explosive.append(process_file(f))

    universe = pd.concat(all_explosive, ignore_index=True)
    universe = universe.sort_values('multiple', ascending=False)

    out_csv = OUT / 'outputs' / 'p1_explosive_movers.csv'
    universe.to_csv(out_csv, index=False)
    print(f'\n=== Explosive movers universe: {len(universe):,} chain-days ===')
    print(f'Saved → {out_csv}')

    # Summary stats
    print('\n=== By ticker (top 20) ===')
    by_tk = universe.groupby('underlying_symbol').agg(
        explosive_chains=('multiple', 'size'),
        max_multiple=('multiple', 'max'),
        median_multiple=('multiple', 'median'),
        total_premium_M=('total_premium', lambda s: s.sum() / 1e6),
    ).sort_values('explosive_chains', ascending=False).head(20)
    print(by_tk.round(2))

    print('\n=== Top 25 individual chain-days by trade multiple ===')
    cols_show = ['date', 'underlying_symbol', 'option_type', 'strike', 'dte',
                 'otm_pct', 'baseline_price', 'peak_price', 'multiple',
                 'prints', 'total_volume', 'open_interest', 'vol_to_oi',
                 'ask_pct', 'entry_time_ct', 'peak_time_ct']
    print(universe.head(25)[cols_show].to_string(index=False))


if __name__ == '__main__':
    main()
