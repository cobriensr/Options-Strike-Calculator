"""Q4: Time-of-day aggression decay.

For top tickers, compute %-of-trades-on-the-ask by 5-min bucket through the
session. Maps to the user's 5-phase intraday schedule.
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
TICKERS = ['SPY', 'SPXW', 'QQQ', 'TSLA', 'NVDA', 'IWM']


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'side', 'option_type',
            'premium', 'canceled']
    raw = load(cols, tickers=TICKERS)
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    df = filter_rth(df)
    print(f'Rows: {len(df):,}')

    # 5-min bucket = minutes since 08:30 floored to 5
    t = df['executed_at_ct']
    df['bucket'] = ((t.dt.hour - 8) * 60 + t.dt.minute - 30) // 5 * 5
    df = df.loc[(df['bucket'] >= 0) & (df['bucket'] <= 390)]

    # Vectorize: tag rows as ask / bid, multiply premium by mask, then groupby-sum
    df['is_ask'] = (df['side'] == 'ask').astype(int)
    df['is_bid'] = (df['side'] == 'bid').astype(int)
    df['ask_premium'] = df['premium'].where(df['side'] == 'ask', 0.0)
    df['bid_premium'] = df['premium'].where(df['side'] == 'bid', 0.0)
    summary = df.groupby(['underlying_symbol', 'bucket']).agg(
        ask_count=('is_ask', 'sum'),
        bid_count=('is_bid', 'sum'),
        ask_premium=('ask_premium', 'sum'),
        bid_premium=('bid_premium', 'sum'),
    ).reset_index()
    summary['ask_pct_count'] = summary['ask_count'] / (summary['ask_count'] + summary['bid_count'])
    summary['ask_pct_premium'] = summary['ask_premium'] / (summary['ask_premium'] + summary['bid_premium'])

    # Plot
    fig, axes = plt.subplots(2, 3, figsize=(16, 8), constrained_layout=True,
                             sharex=True, sharey=True)
    for ax, tk in zip(axes.flat, TICKERS):
        sub = summary.loc[summary['underlying_symbol'] == tk]
        ax.plot(sub['bucket'], sub['ask_pct_count'] * 100, color='steelblue',
                label='ask% (trades)', linewidth=1.5)
        ax.plot(sub['bucket'], sub['ask_pct_premium'] * 100, color='darkorange',
                label='ask% ($)', linewidth=1.5)
        ax.axhline(50, color='gray', linestyle='--', linewidth=0.5)
        for x in [30, 90, 240]:
            ax.axvline(x, color='red', alpha=0.2)
        ax.set_title(f'{tk}')
        ax.set_xlabel('Min into session')
        ax.set_ylabel('Ask %')
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8, loc='upper right')
    fig.suptitle('Aggression by time-of-day (08:30–15:00 CT, 5-min buckets, 15 days)',
                 fontsize=14, fontweight='bold')
    fig.savefig(OUT / 'plots' / 'q4_aggression_decay.png', dpi=150,
                bbox_inches='tight', facecolor='white')

    summary.to_csv(OUT / 'outputs' / 'q4_aggression_decay.csv', index=False)
    print('\nMean ask% (premium-weighted) by ticker:')
    print(summary.groupby('underlying_symbol')['ask_pct_premium'].mean().round(3))


if __name__ == '__main__':
    main()
