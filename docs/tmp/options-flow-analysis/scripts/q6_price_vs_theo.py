"""Q6: price-vs-theo mispricing per underlying.

Which symbols systematically clear above theo (panic buying) vs below
(forced selling)? Premium-weighted mean of (price - theo) / theo.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import add_ct_time, filter_rth, load  # noqa: E402

OUT = Path(__file__).resolve().parents[1]
TOP_TICKERS = ['SPY', 'SPXW', 'TSLA', 'QQQ', 'NVDA', 'PLTR', 'MSFT', 'IWM',
               'AMZN', 'META', 'AMD', 'AAPL', 'INTC', 'USO', 'NFLX', 'MU',
               'SLV', 'GOOGL', 'XSP', 'IBIT', 'GLD']


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'side', 'option_type',
            'price', 'theo', 'premium', 'canceled']
    raw = load(cols, tickers=TOP_TICKERS)
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    df = filter_rth(df)
    df = df.loc[(df['theo'] > 0.05) & (df['price'] > 0)]
    df['edge_pct'] = (df['price'] - df['theo']) / df['theo']
    # Trim extreme outliers (10%)
    df = df.loc[df['edge_pct'].abs() < 0.10]
    print(f'Rows: {len(df):,}')

    # Vectorized weighted mean: (edge × premium).sum() / premium.sum()
    df['edge_x_prem'] = df['edge_pct'] * df['premium']
    df['above_theo'] = (df['price'] > df['theo']).astype(int)
    grp = df.groupby('underlying_symbol')
    summary = pd.DataFrame({
        'prints': grp.size(),
        'premium_M': grp['premium'].sum() / 1e6,
        'mean_edge_pct': grp['edge_x_prem'].sum() / grp['premium'].sum() * 100,
        'median_edge_pct': grp['edge_pct'].median() * 100,
        'pct_above_theo': grp['above_theo'].mean() * 100,
    }).sort_values('mean_edge_pct', ascending=False)
    print('\n=== Mean (price - theo)/theo, premium-weighted, in % ===')
    print(summary.round(3))

    fig, ax = plt.subplots(figsize=(10, 8), constrained_layout=True)
    colors = ['darkred' if v > 0 else 'darkgreen' for v in summary['mean_edge_pct']]
    ax.barh(summary.index, summary['mean_edge_pct'], color=colors, edgecolor='black')
    ax.axvline(0, color='black', linewidth=0.5)
    ax.set_xlabel('Premium-weighted mean (price - theo) / theo  (%)')
    ax.set_title('Mispricing per underlying — RED = chased above theo, GREEN = bought below theo\n(15 days, RTH, top 21 underlyings)')
    ax.grid(True, alpha=0.3, axis='x')
    fig.savefig(OUT / 'plots' / 'q6_price_vs_theo.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    summary.to_csv(OUT / 'outputs' / 'q6_price_vs_theo.csv')


if __name__ == '__main__':
    main()
