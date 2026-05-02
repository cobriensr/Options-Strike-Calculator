"""Phase 3 — backtest the preliminary scanner spec.

For each (date, chain):
  - Walk minute-by-minute computing rolling 10-min features
  - Fire scanner when ALL criteria met (vol/OI, IV, |delta|, ask%)
  - First trigger only (real-life ergonomics)
  - Entry price = next print after trigger; exit = max price thereafter
  - Label TP if exit/entry >= 5x, else FP

Output:
  - p3_triggers.csv — every trigger with TP/FP label and realized multiple
  - p3_summary.csv — precision/recall by ticker, by DTE bucket
  - Threshold sensitivity analysis at multiple trigger thresholds
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]

# Preliminary scanner spec (from Phase 2)
SPEC = {
    'vol_to_oi_min': 0.10,
    'iv_min': 0.35,
    'abs_delta_min': 0.13,
    'ask_pct_min': 0.52,
    'dte_max': 7,
}
WINDOW_MIN = 10
EXPLOSIVE_THRESHOLD = 5.0
MIN_PRINTS = 100
COLS = [
    'executed_at', 'underlying_symbol', 'option_chain_id', 'side',
    'option_type', 'expiry', 'strike', 'underlying_price', 'price', 'size',
    'open_interest', 'implied_volatility', 'delta', 'canceled',
]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def scan_chain(g: pd.DataFrame, oi: float, dte: int) -> dict | None:
    """Vectorized scan of a single chain's day. Returns first trigger or None."""
    if dte > SPEC['dte_max'] or oi <= 0:
        return None
    if len(g) < 5:
        return None

    g = g.sort_values('ts_ct').reset_index(drop=True)
    g = g.set_index('ts_ct', drop=False)

    # Per-row precompute
    is_ask = (g['side'] == 'ask').astype('int32')
    is_bid = (g['side'] == 'bid').astype('int32')

    # Rolling 10-min time-window (window is RIGHT-aligned, i.e. last 10 min)
    win = f'{WINDOW_MIN}min'
    ask_sum = is_ask.rolling(win).sum()
    bid_sum = is_bid.rolling(win).sum()
    ab_sum = ask_sum + bid_sum
    ask_pct_w = ask_sum / ab_sum.where(ab_sum > 0, 1)
    iv_mean_w = g['implied_volatility'].rolling(win).mean()
    delta_mean_w = g['delta'].rolling(win).mean()
    cnt_w = g['price'].rolling(win).count()

    # Cumulative volume / OI (running, not windowed)
    cum_vol = g['size'].cumsum()
    vol_to_oi = cum_vol / oi

    # Build trigger mask
    trigger = (
        (cnt_w >= 3)
        & (vol_to_oi >= SPEC['vol_to_oi_min'])
        & (iv_mean_w >= SPEC['iv_min'])
        & (delta_mean_w.abs() >= SPEC['abs_delta_min'])
        & (ask_pct_w >= SPEC['ask_pct_min'])
    )
    if not trigger.any():
        return None

    first_idx = trigger.idxmax()  # first True
    pos = g.index.get_loc(first_idx)
    if isinstance(pos, slice):
        pos = pos.start
    # Entry = next print
    entry_pos = min(pos + 1, len(g) - 1)
    entry_price = float(g['price'].iloc[entry_pos])
    entry_time = g['ts_ct'].iloc[entry_pos]
    future_max = float(g['price'].iloc[entry_pos:].max())
    return {
        'trigger_time_ct': pd.Timestamp(entry_time),
        'entry_price': entry_price,
        'future_max': future_max,
        'realized_multiple': future_max / max(entry_price, 0.01),
        'trigger_vol_to_oi': float(vol_to_oi.iloc[pos]),
        'trigger_iv': float(iv_mean_w.iloc[pos]),
        'trigger_delta': float(delta_mean_w.iloc[pos]),
        'trigger_ask_pct': float(ask_pct_w.iloc[pos]),
        'trigger_window_prints': int(cnt_w.iloc[pos]),
    }


def process_day(f: str) -> pd.DataFrame:
    name = Path(f).name
    print(f'  {name}: loading...', flush=True)
    t = pq.read_table(f, columns=COLS)
    df = t.to_pandas()
    df['canceled'] = _coerce_canceled(df['canceled'])
    df = df.loc[~df['canceled'] & (df['price'] > 0)]
    for c in ['underlying_symbol', 'side', 'option_type', 'option_chain_id']:
        df[c] = df[c].astype(str)
    df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    df['date'] = df['ts_ct'].dt.date
    df['hour_min'] = df['ts_ct'].dt.hour * 60 + df['ts_ct'].dt.minute
    df = df.loc[(df['hour_min'] >= 510) & (df['hour_min'] < 900)]
    if len(df) == 0:
        return pd.DataFrame()

    # Filter to chains with enough prints
    cnt = df.groupby('option_chain_id').size()
    keep = cnt.loc[cnt >= MIN_PRINTS].index
    df = df.loc[df['option_chain_id'].isin(keep)]
    if len(df) == 0:
        return pd.DataFrame()

    day = df['date'].iloc[0]
    print(f'  {name}: scanning {df["option_chain_id"].nunique():,} chains', flush=True)

    rows = []
    for chain_id, g in df.groupby('option_chain_id'):
        oi = g['open_interest'].max()
        expiry = g['expiry'].iloc[0]
        dte = (expiry - day).days
        result = scan_chain(g, oi, dte)
        if result is None:
            continue
        meta = {
            'date': pd.Timestamp(day),
            'option_chain_id': chain_id,
            'underlying_symbol': g['underlying_symbol'].iloc[0],
            'option_type': g['option_type'].iloc[0],
            'strike': g['strike'].iloc[0],
            'expiry': expiry,
            'dte': dte,
            'open_interest': oi,
            'spot_at_trigger': g['underlying_price'].iloc[0],
        }
        meta.update(result)
        meta['is_tp'] = meta['realized_multiple'] >= EXPLOSIVE_THRESHOLD
        rows.append(meta)
    print(f'  {name}: {len(rows):,} triggers ({sum(r["is_tp"] for r in rows)} TPs)', flush=True)
    return pd.DataFrame(rows)


def main() -> None:
    print(f'Spec: {SPEC}')
    print(f'Window: {WINDOW_MIN} min, Explosive threshold: {EXPLOSIVE_THRESHOLD}x')

    all_triggers = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        all_triggers.append(process_day(f))

    triggers = pd.concat(all_triggers, ignore_index=True)
    out_csv = OUT / 'outputs' / 'p3_triggers.csv'
    triggers.to_csv(out_csv, index=False)
    print(f'\nSaved → {out_csv}  ({len(triggers):,} triggers)')

    # Headline metrics
    n_total = len(triggers)
    n_tp = int(triggers['is_tp'].sum())
    n_fp = n_total - n_tp
    precision = n_tp / max(n_total, 1)
    print(f'\n=== HEADLINE ===')
    print(f'Total triggers: {n_total:,}')
    print(f'True positives (>=5x): {n_tp:,}  ({precision*100:.1f}%)')
    print(f'False positives:        {n_fp:,}  ({(1-precision)*100:.1f}%)')
    print(f'Median realized multiple (all triggers): {triggers["realized_multiple"].median():.2f}x')
    print(f'Median realized multiple (TPs only):     {triggers.loc[triggers["is_tp"], "realized_multiple"].median():.2f}x')
    print(f'Mean realized multiple (TPs only):       {triggers.loc[triggers["is_tp"], "realized_multiple"].mean():.2f}x')

    # Precision sensitivity at different thresholds
    print(f'\n=== Precision at various explosive thresholds ===')
    for t in [2, 3, 5, 7.5, 10, 15, 20, 50, 100]:
        n_winners = (triggers['realized_multiple'] >= t).sum()
        prec = n_winners / max(n_total, 1)
        print(f'  >={t:>4}x : {n_winners:>5,} triggers ({prec*100:.1f}% precision)')

    # By DTE
    triggers['dte_bucket'] = pd.cut(
        triggers['dte'], bins=[-1, 0, 7], labels=['0DTE', '1-7d']
    )
    print(f'\n=== By DTE bucket ===')
    by_dte = triggers.groupby('dte_bucket', observed=True).agg(
        triggers=('is_tp', 'size'),
        tps=('is_tp', 'sum'),
        precision=('is_tp', 'mean'),
        median_mult=('realized_multiple', 'median'),
    )
    by_dte['precision'] = (by_dte['precision'] * 100).round(1)
    print(by_dte)

    # By ticker (top 15)
    print(f'\n=== By ticker (top 15 by trigger count) ===')
    by_tk = triggers.groupby('underlying_symbol').agg(
        triggers=('is_tp', 'size'),
        tps=('is_tp', 'sum'),
        precision=('is_tp', 'mean'),
        median_mult=('realized_multiple', 'median'),
    ).sort_values('triggers', ascending=False).head(15)
    by_tk['precision'] = (by_tk['precision'] * 100).round(1)
    print(by_tk)

    # Top 25 best trades
    print(f'\n=== Top 25 trades by realized multiple ===')
    top = triggers.nlargest(25, 'realized_multiple')
    cols_show = ['date', 'underlying_symbol', 'option_type', 'strike', 'dte',
                 'entry_price', 'future_max', 'realized_multiple',
                 'trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
                 'trigger_ask_pct', 'trigger_time_ct']
    print(top[cols_show].to_string(index=False))


if __name__ == '__main__':
    main()
