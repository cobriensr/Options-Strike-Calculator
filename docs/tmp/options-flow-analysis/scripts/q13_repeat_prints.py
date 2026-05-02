"""Q13: Repeat-print 'footprint' / position-build detection.

For SPXW 0DTE, find option_chain_ids hit 50+ times on the same side
(ask or bid) within a sliding 60-second window — proxy for someone
sweeping a level / building a position.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import (  # noqa: E402
    add_ct_time, directional_only, filter_rth, is_zero_dte, load
)

OUT = Path(__file__).resolve().parents[1]


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'option_chain_id', 'side',
            'option_type', 'strike', 'expiry', 'premium', 'size',
            'underlying_price', 'canceled']
    raw = load(cols, tickers=['SPXW'])
    df = directional_only(add_ct_time(raw))
    df = df.loc[is_zero_dte(df)]
    df = filter_rth(df)
    print(f'SPXW 0DTE rows: {len(df):,}')

    # 60-second buckets
    df['min60'] = df['executed_at_ct'].dt.floor('1min')
    grouped = df.groupby(
        ['trade_date', 'min60', 'option_chain_id', 'side']
    ).agg(
        prints=('premium', 'size'),
        size=('size', 'sum'),
        premium=('premium', 'sum'),
        strike=('strike', 'first'),
        opt_type=('option_type', 'first'),
        spot=('underlying_price', 'mean'),
    ).reset_index()

    footprints = grouped.loc[grouped['prints'] >= 50].copy()
    footprints['moneyness_pts'] = footprints['strike'] - footprints['spot']
    print(f'\nFootprint events (>=50 prints in 1 min on same side): {len(footprints):,}')

    if len(footprints) > 0:
        print('\n=== Top 15 footprints by premium ===')
        cols_show = ['trade_date', 'min60', 'opt_type', 'strike', 'side',
                     'prints', 'size', 'premium', 'moneyness_pts']
        print(footprints.sort_values('premium', ascending=False).head(15)[cols_show].to_string(index=False))

    summary = footprints.groupby(['trade_date', 'side']).agg(
        events=('option_chain_id', 'size'),
        total_premium_M=('premium', lambda s: s.sum() / 1e6),
    ).reset_index()
    print('\n=== Footprint events per day ===')
    print(summary.to_string(index=False))

    fig, axes = plt.subplots(1, 2, figsize=(14, 5), constrained_layout=True)
    if len(footprints) > 0:
        # Histogram of footprint strikes relative to spot
        for s, color in [('ask', 'darkgreen'), ('bid', 'darkred')]:
            sub = footprints.loc[footprints['side'] == s]
            axes[0].hist(sub['moneyness_pts'].clip(-50, 50),
                         bins=30, alpha=0.6, label=f'{s} ({len(sub)} events)',
                         color=color, edgecolor='black')
        axes[0].axvline(0, color='black', linewidth=0.5)
        axes[0].set_xlabel('Strike − spot (SPX points)')
        axes[0].set_ylabel('Footprint events')
        axes[0].set_title('SPXW footprints: distance from spot, by side')
        axes[0].legend()
        axes[0].grid(True, alpha=0.3)

        # Per-day count
        pivot = summary.pivot(index='trade_date', columns='side', values='events').fillna(0)
        if 'ask' in pivot.columns:
            axes[1].bar(pivot.index.astype(str), pivot.get('ask', 0), label='ask',
                        color='darkgreen', alpha=0.7)
        if 'bid' in pivot.columns:
            axes[1].bar(pivot.index.astype(str), -pivot.get('bid', 0), label='bid',
                        color='darkred', alpha=0.7)
        axes[1].axhline(0, color='black')
        axes[1].set_ylabel('Footprint events (ask above 0, bid below)')
        axes[1].set_title('SPXW footprint events per day')
        axes[1].legend()
        axes[1].tick_params(axis='x', rotation=45)
        axes[1].grid(True, alpha=0.3)

    fig.savefig(OUT / 'plots' / 'q13_footprints.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    footprints.to_csv(OUT / 'outputs' / 'q13_footprints.csv', index=False)


if __name__ == '__main__':
    main()
