"""Q5: Slippage distribution per exchange for SPXW.

Measures (price - nbbo_mid) / spread — the "edge index". 0 = at mid,
+1 = at offer, -1 = at bid. Compares routing venues.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import add_ct_time, filter_rth, is_zero_dte, load  # noqa: E402

OUT = Path(__file__).resolve().parents[1]


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'side', 'option_type',
            'expiry', 'price', 'nbbo_bid', 'nbbo_ask', 'exchange',
            'premium', 'canceled']
    raw = load(cols, tickers=['SPXW'])
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    df = df.loc[is_zero_dte(df)]
    df = filter_rth(df)
    df = df.loc[(df['nbbo_ask'] > df['nbbo_bid']) & (df['nbbo_bid'] > 0)]
    print(f'Rows: {len(df):,}')

    df['mid'] = (df['nbbo_bid'] + df['nbbo_ask']) / 2
    df['spread'] = df['nbbo_ask'] - df['nbbo_bid']
    df['edge_index'] = (df['price'] - df['mid']) / (df['spread'] / 2)
    df = df.loc[df['edge_index'].abs() <= 2]  # drop trades-through

    summary = df.groupby('exchange').agg(
        prints=('edge_index', 'size'),
        premium_M=('premium', lambda s: s.sum() / 1e6),
        mean_edge_idx=('edge_index', 'mean'),
        median_edge_idx=('edge_index', 'median'),
        avg_spread=('spread', 'mean'),
    ).sort_values('premium_M', ascending=False)
    print('\n=== SPXW slippage by exchange (0DTE) ===')
    print(summary.round(3))

    # Plot top-8 exchanges
    top = summary.head(8).index.tolist()
    sub = df.loc[df['exchange'].isin(top)]

    fig, axes = plt.subplots(1, 2, figsize=(15, 5), constrained_layout=True)
    # Boxplot of edge index by exchange
    box_data = [sub.loc[sub['exchange'] == ex, 'edge_index'].values for ex in top]
    axes[0].boxplot(box_data, labels=top, showfliers=False)
    axes[0].axhline(0, color='red', linestyle='--', alpha=0.5)
    axes[0].set_ylabel('Edge index ((price - mid) / half-spread)')
    axes[0].set_title('SPXW 0DTE edge index by exchange\n(positive = paid up vs mid)')
    axes[0].grid(True, alpha=0.3)
    axes[0].tick_params(axis='x', rotation=45)

    # Bar of mean edge index
    axes[1].barh(summary.head(15).index,
                 summary.head(15)['mean_edge_idx'],
                 color='steelblue', edgecolor='black')
    axes[1].axvline(0, color='red', linewidth=1)
    axes[1].set_xlabel('Mean edge index')
    axes[1].set_title('Mean edge index by exchange (top 15 by premium)')
    axes[1].grid(True, alpha=0.3, axis='x')

    fig.savefig(OUT / 'plots' / 'q5_slippage_exchange.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    summary.to_csv(OUT / 'outputs' / 'q5_slippage_exchange.csv')


if __name__ == '__main__':
    main()
