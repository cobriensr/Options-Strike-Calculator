"""Q6 fast — streaming per-file accumulator to avoid concat overhead."""
from __future__ import annotations

import glob
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
TOP_TICKERS = ['SPY', 'SPXW', 'TSLA', 'QQQ', 'NVDA', 'PLTR', 'MSFT', 'IWM',
               'AMZN', 'META', 'AMD', 'AAPL', 'INTC', 'USO', 'NFLX', 'MU',
               'SLV', 'GOOGL', 'XSP', 'IBIT', 'GLD']
COLS = ['underlying_symbol', 'price', 'theo', 'premium', 'canceled']


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def main() -> None:
    # accum per ticker:
    # - sum_edge_x_prem: Σ (edge_pct × premium)
    # - sum_prem: Σ premium
    # - sum_above: count where price > theo
    # - count
    accum = defaultdict(lambda: {'sum_e_p': 0.0, 'sum_p': 0.0,
                                  'above': 0, 'count': 0,
                                  'edge_samples': []})
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df['underlying_symbol'] = df['underlying_symbol'].astype(str)
        df = df.loc[
            (~df['canceled'])
            & (df['underlying_symbol'].isin(TOP_TICKERS))
            & (df['theo'] > 0.05)
            & (df['price'] > 0)
        ]
        df['edge_pct'] = (df['price'] - df['theo']) / df['theo']
        df = df.loc[df['edge_pct'].abs() < 0.10]

        for tk, grp in df.groupby('underlying_symbol'):
            a = accum[tk]
            a['sum_e_p'] += float((grp['edge_pct'] * grp['premium']).sum())
            a['sum_p'] += float(grp['premium'].sum())
            a['above'] += int((grp['price'] > grp['theo']).sum())
            a['count'] += len(grp)
            # Sample for median (max 50K per ticker is enough)
            if len(a['edge_samples']) < 50000:
                a['edge_samples'].extend(grp['edge_pct'].sample(
                    min(2000, len(grp))).tolist())
        print(f'  {Path(f).name}: processed')

    rows = []
    for tk, a in accum.items():
        if a['count'] == 0:
            continue
        rows.append({
            'underlying_symbol': tk,
            'prints': a['count'],
            'premium_M': a['sum_p'] / 1e6,
            'mean_edge_pct': a['sum_e_p'] / a['sum_p'] * 100 if a['sum_p'] > 0 else 0,
            'median_edge_pct': float(np.median(a['edge_samples'])) * 100,
            'pct_above_theo': a['above'] / a['count'] * 100,
        })
    summary = pd.DataFrame(rows).sort_values('mean_edge_pct', ascending=False)
    print('\n=== Mean (price - theo)/theo, premium-weighted, in % ===')
    print(summary.set_index('underlying_symbol').round(3))

    fig, ax = plt.subplots(figsize=(10, 8), constrained_layout=True)
    summary_idx = summary.set_index('underlying_symbol')
    colors = ['darkred' if v > 0 else 'darkgreen' for v in summary_idx['mean_edge_pct']]
    ax.barh(summary_idx.index, summary_idx['mean_edge_pct'], color=colors,
            edgecolor='black')
    ax.axvline(0, color='black', linewidth=0.5)
    ax.set_xlabel('Premium-weighted mean (price - theo) / theo  (%)')
    ax.set_title('Mispricing per underlying — RED = chased above theo, GREEN = bought below theo\n(15 days, top 21 underlyings)')
    ax.grid(True, alpha=0.3, axis='x')
    fig.savefig(OUT / 'plots' / 'q6_price_vs_theo.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    summary.to_csv(OUT / 'outputs' / 'q6_price_vs_theo.csv', index=False)


if __name__ == '__main__':
    main()
