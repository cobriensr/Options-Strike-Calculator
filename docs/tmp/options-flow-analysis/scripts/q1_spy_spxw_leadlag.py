"""Q1: Does aggressive SPY 0DTE flow lead SPXW direction?

Method:
  - 0DTE only (expiry == trade date), canceled == False, side in {ask, bid}
  - Per-trade signed-dollar-delta:
      call+ask = +1, call+bid = -1, put+ask = -1, put+bid = +1
      flow_$ = sign * delta * premium
  - Aggregate per (ticker, minute), then compute lag-lead
    cross-correlation of SPY net-flow vs SPXW net-flow.
"""
from __future__ import annotations

import glob
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT_DIR = Path(
    '/Users/charlesobrien/Documents/Workspace/strike-calculator/'
    'docs/tmp/options-flow-analysis'
)
TICKERS = ['SPY', 'SPXW']
COLS = [
    'executed_at',
    'underlying_symbol',
    'side',
    'option_type',
    'expiry',
    'premium',
    'delta',
    'canceled',
]


def _coerce_canceled(s: pd.Series) -> pd.Series:
    """Some files store canceled as bool, some as 'f'/'t' strings."""
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def load_filtered(tickers: list[str] = TICKERS) -> pd.DataFrame:
    """Per-file read+filter with type normalization (schema drifts on May 1)."""
    files = sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet'))
    parts: list[pd.DataFrame] = []
    for f in files:
        t = pq.read_table(
            f, columns=COLS, filters=[('underlying_symbol', 'in', tickers)]
        )
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        # Normalize to plain str / float for downstream ops
        for c in ['underlying_symbol', 'side', 'option_type']:
            df[c] = df[c].astype(str)
        parts.append(df)
    return pd.concat(parts, ignore_index=True)


def signed_flow(df: pd.DataFrame) -> pd.DataFrame:
    """Build signed dollar-delta flow column."""
    # Filter: 0DTE + non-canceled + directional side only
    trade_date = df['executed_at'].dt.tz_convert('UTC').dt.date
    df = df.loc[
        (df['expiry'] == trade_date)
        & (~df['canceled'].astype(bool))
        & (df['side'].isin(['ask', 'bid']))
    ].copy()

    # Sign convention:
    #   bullish flow = +1 (call+ask, put+bid)
    #   bearish flow = -1 (call+bid, put+ask)
    is_call = df['option_type'] == 'call'
    is_ask = df['side'] == 'ask'
    sign = np.where(is_call == is_ask, 1.0, -1.0)
    df['flow_dollars'] = sign * df['delta'].astype(float) * df['premium'].astype(float)

    # Convert tz-aware UTC → America/Chicago (CT) for trader-relative time
    df['executed_at_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    df['trade_date'] = df['executed_at_ct'].dt.date
    df['minute'] = df['executed_at_ct'].dt.floor('1min')
    return df


def to_minute_panel(df: pd.DataFrame) -> pd.DataFrame:
    """Pivot to minute index x ticker columns of net flow."""
    grouped = (
        df.groupby(['minute', 'underlying_symbol'], observed=True)['flow_dollars']
        .sum()
        .unstack('underlying_symbol')
        .fillna(0.0)
    )
    return grouped


def lead_lag_corr(panel: pd.DataFrame, max_lag: int = 10) -> pd.DataFrame:
    """For each day, restrict to RTH and compute cross-corr(SPY_t, SPXW_{t+k})."""
    rows: list[dict[str, float | int]] = []

    panel = panel.copy()
    panel['date'] = panel.index.date
    for date, day_df in panel.groupby('date'):
        spy = day_df['SPY']
        spxw = day_df['SPXW']
        # Restrict to regular session (8:30–15:00 CT)
        mask = (day_df.index.time >= pd.Timestamp('08:30').time()) & (
            day_df.index.time <= pd.Timestamp('15:00').time()
        )
        spy = spy[mask]
        spxw = spxw[mask]
        if len(spy) < 60 or spy.std() == 0 or spxw.std() == 0:
            continue
        for k in range(-max_lag, max_lag + 1):
            shifted = spxw.shift(-k)
            valid = shifted.notna() & spy.notna()
            if valid.sum() < 60:
                continue
            r = np.corrcoef(spy[valid], shifted[valid])[0, 1]
            rows.append({'date': str(date), 'lag_min': k, 'corr': float(r)})
    return pd.DataFrame(rows)


def main() -> None:
    print('Loading SPY+SPXW prints from 15 trade-day parquet files…')
    raw = load_filtered()
    print(f'  raw rows (SPY+SPXW): {len(raw):,}')
    print(f'  memory:              {raw.memory_usage(deep=True).sum() / 1e6:.1f} MB')

    print('\nFiltering to 0DTE directional flow…')
    flows = signed_flow(raw)
    print(f'  0DTE directional rows: {len(flows):,}')
    print(flows.groupby('underlying_symbol', observed=True).size())

    print('\nBuilding per-minute net-flow panel…')
    panel = to_minute_panel(flows)
    print(f'  panel shape: {panel.shape}')
    print(panel.head())

    print('\nComputing lag-lead cross-correlations (per day)…')
    cc = lead_lag_corr(panel)
    print(f'  rows: {len(cc):,}  days: {cc["date"].nunique()}')

    # Average correlation across days at each lag
    avg = cc.groupby('lag_min')['corr'].agg(['mean', 'std', 'count']).reset_index()
    avg['se'] = avg['std'] / np.sqrt(avg['count'])
    avg['t_stat'] = avg['mean'] / avg['se']
    print('\n=== Mean cross-correlation by lag (positive lag = SPY leads) ===')
    print(avg.to_string(index=False, float_format='%.4f'))

    # ---- Plot ----
    fig, (ax1, ax2) = plt.subplots(
        1, 2, figsize=(14, 5), constrained_layout=True
    )

    # 1) Lag-lead curve with confidence band
    ax1.axhline(0, color='gray', linewidth=0.5)
    ax1.axvline(0, color='gray', linewidth=0.5, linestyle='--')
    ax1.errorbar(
        avg['lag_min'],
        avg['mean'],
        yerr=avg['se'],
        marker='o',
        capsize=3,
        color='steelblue',
    )
    ax1.set_xlabel('Lag (minutes) — positive = SPY leads SPXW')
    ax1.set_ylabel('Mean Pearson correlation (across 15 days)')
    ax1.set_title('SPY net-Δ$ flow vs SPXW net-Δ$ flow\n(1-min buckets, 0DTE only, RTH 08:30–15:00 CT)')
    ax1.grid(True, alpha=0.3)

    # 2) Per-day curves overlaid (sanity check — does pattern hold every day?)
    for date, sub in cc.groupby('date'):
        ax2.plot(
            sub['lag_min'], sub['corr'], alpha=0.35, linewidth=1, label=date
        )
    ax2.axhline(0, color='black', linewidth=0.5)
    ax2.axvline(0, color='black', linewidth=0.5, linestyle='--')
    ax2.set_xlabel('Lag (minutes)')
    ax2.set_ylabel('Pearson correlation (per day)')
    ax2.set_title('Per-day curves (15 trading days overlaid)')
    ax2.grid(True, alpha=0.3)

    out_png = OUT_DIR / 'plots' / 'q1_spy_spxw_leadlag.png'
    fig.savefig(out_png, dpi=150, bbox_inches='tight', facecolor='white')
    print(f'\nSaved plot → {out_png}')

    # ---- Save table ----
    out_csv = OUT_DIR / 'outputs' / 'q1_leadlag_avg.csv'
    avg.to_csv(out_csv, index=False)
    print(f'Saved table → {out_csv}')


if __name__ == '__main__':
    main()
