"""Q10: Commodity-vol vs SPX intraday correlation.

Per day, average IV per ticker over RTH for USO/GLD/SLV/IBIT/SPY/SPXW —
then check daily correlations.
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
TICKERS = ['SPY', 'SPXW', 'QQQ', 'IWM', 'USO', 'GLD', 'SLV', 'IBIT']


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'strike', 'underlying_price',
            'implied_volatility', 'size', 'canceled']
    raw = load(cols, tickers=TICKERS)
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    df = filter_rth(df)
    df = df.loc[df['implied_volatility'].between(0.05, 3.0)]
    df['moneyness'] = (df['strike'] - df['underlying_price']) / df['underlying_price']
    atm = df.loc[df['moneyness'].abs() < 0.02]
    print(f'Rows: {len(atm):,}')

    # Daily volume-weighted ATM IV per ticker
    daily = atm.groupby(['trade_date', 'underlying_symbol']).apply(
        lambda g: np.average(g['implied_volatility'], weights=g['size'])
    ).unstack('underlying_symbol')

    print('\n=== Daily VW-ATM IV (15 days) ===')
    print(daily.round(3))

    # Correlation matrix
    corr = daily.corr()
    print('\n=== IV correlation matrix ===')
    print(corr.round(2))

    fig, axes = plt.subplots(1, 2, figsize=(14, 5), constrained_layout=True)
    im = axes[0].imshow(corr.values, cmap='coolwarm', vmin=-1, vmax=1)
    axes[0].set_xticks(range(len(corr)))
    axes[0].set_yticks(range(len(corr)))
    axes[0].set_xticklabels(corr.columns, rotation=45, ha='right')
    axes[0].set_yticklabels(corr.columns)
    axes[0].set_title('ATM IV correlation across tickers (15 days)')
    for i in range(len(corr)):
        for j in range(len(corr)):
            axes[0].text(j, i, f'{corr.values[i, j]:.2f}',
                         ha='center', va='center',
                         color='white' if abs(corr.values[i, j]) > 0.5 else 'black',
                         fontsize=9)
    plt.colorbar(im, ax=axes[0])

    # Time series
    for col in daily.columns:
        axes[1].plot(daily.index, daily[col] * 100, marker='o', label=col)
    axes[1].set_ylabel('VW ATM IV (%)')
    axes[1].set_xlabel('Date')
    axes[1].set_title('Daily ATM IV by ticker')
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    axes[1].tick_params(axis='x', rotation=45)

    fig.savefig(OUT / 'plots' / 'q10_cross_asset.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    daily.to_csv(OUT / 'outputs' / 'q10_iv_daily.csv')
    corr.to_csv(OUT / 'outputs' / 'q10_iv_corr.csv')


if __name__ == '__main__':
    main()
