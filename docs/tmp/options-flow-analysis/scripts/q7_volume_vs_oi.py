"""Q7: Volume > Open Interest fresh-positioning detector.

For each ticker each day, find option_chain_ids where total daily traded
volume exceeds prior-day open interest. These are typically opening trades
(new positions, not closes).
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import add_ct_time, load  # noqa: E402

OUT = Path(__file__).resolve().parents[1]
TOP = ['SPY', 'SPXW', 'TSLA', 'QQQ', 'NVDA', 'PLTR', 'IWM', 'AMZN', 'META']


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'option_chain_id', 'expiry',
            'strike', 'option_type', 'side', 'premium', 'size',
            'open_interest', 'canceled']
    raw = load(cols, tickers=TOP)
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    print(f'Rows: {len(df):,}')

    # For each (date, chain_id): total volume (sum of size) and OI (max — OI is
    # static through the day, take max as a robustness check)
    agg = df.groupby(['trade_date', 'underlying_symbol', 'option_chain_id',
                      'expiry', 'strike', 'option_type']).agg(
        day_volume=('size', 'sum'),
        open_interest=('open_interest', 'max'),
        premium_M=('premium', lambda s: s.sum() / 1e6),
    ).reset_index()
    agg['vol_to_oi'] = agg['day_volume'] / agg['open_interest'].clip(lower=1)
    fresh = agg.loc[agg['day_volume'] > agg['open_interest']].copy()
    print(f'Chains with vol > OI: {len(fresh):,} / {len(agg):,} ({len(fresh)/len(agg)*100:.1f}%)')

    # Per-ticker summary
    summary = fresh.groupby('underlying_symbol').agg(
        chains_with_vol_gt_oi=('option_chain_id', 'nunique'),
        total_volume=('day_volume', 'sum'),
        total_premium_M=('premium_M', 'sum'),
        median_vol_to_oi=('vol_to_oi', 'median'),
    ).sort_values('total_premium_M', ascending=False)
    print('\n=== Fresh-positioning footprint by ticker ===')
    print(summary.round(2))

    # For SPXW, plot histogram of vol/OI ratio across all 0DTE strikes
    spxw_zero = fresh.loc[
        (fresh['underlying_symbol'] == 'SPXW')
        & (fresh['expiry'] == fresh['trade_date'])
    ]
    fig, axes = plt.subplots(1, 2, figsize=(14, 5), constrained_layout=True)
    axes[0].barh(summary.index, summary['total_premium_M'],
                 color='steelblue', edgecolor='black')
    axes[0].set_xlabel('Total premium ($M) on chains with day-vol > OI')
    axes[0].set_title('Fresh-positioning premium by ticker (15 days)')
    axes[0].grid(True, alpha=0.3, axis='x')
    if len(spxw_zero) > 0:
        axes[1].hist(spxw_zero['vol_to_oi'].clip(upper=10),
                     bins=50, color='steelblue', edgecolor='black')
        axes[1].set_xlabel('Day Volume / Prior OI (capped at 10x)')
        axes[1].set_ylabel('SPXW 0DTE chains')
        axes[1].set_title(f'SPXW 0DTE: vol/OI distribution\n({len(spxw_zero):,} chains)')
    axes[1].grid(True, alpha=0.3)

    fig.savefig(OUT / 'plots' / 'q7_volume_vs_oi.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    summary.to_csv(OUT / 'outputs' / 'q7_vol_oi_summary.csv')


if __name__ == '__main__':
    main()
