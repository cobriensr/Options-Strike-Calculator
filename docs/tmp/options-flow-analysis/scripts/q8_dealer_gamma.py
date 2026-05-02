"""Q8: Dealer-gamma reconstruction from the tape.

Approximation:
  signed_flow = +1 if customer bought (ask), -1 if customer sold (bid)
  Dealer gamma per print = -signed_flow * gamma * size * 100 * spot^2 / 1e6
  Aggregate per strike per day, find zero-gamma flip, compare across days.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import (  # noqa: E402
    add_ct_time, directional_only, filter_rth, is_zero_dte, load
)

OUT = Path(__file__).resolve().parents[1]


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'side', 'option_type',
            'expiry', 'strike', 'size', 'gamma', 'underlying_price',
            'canceled']
    raw = load(cols, tickers=['SPXW'])
    df = directional_only(add_ct_time(raw))
    df = df.loc[is_zero_dte(df)]
    df = filter_rth(df)
    print(f'SPXW 0DTE rows: {len(df):,}')

    # Sign: customer perspective. Ask = customer bought (+1)
    sign = np.where(df['side'] == 'ask', 1, -1)
    # Dealer gamma is opposite sign of customer position * gamma exposure
    df['dealer_gamma_M'] = (
        -sign * df['gamma'].astype(float)
        * df['size'].astype(float) * 100.0
        * df['underlying_price'].astype(float) ** 2 / 1e6
    )

    # Per (date, strike) aggregate
    agg = df.groupby(['trade_date', 'strike'])['dealer_gamma_M'].sum().reset_index()

    # For each day, find zero-gamma flip strike (cumulative sum from bottom)
    flips: list[dict] = []
    for date, sub in agg.groupby('trade_date'):
        sub = sub.sort_values('strike').reset_index(drop=True)
        sub['cum'] = sub['dealer_gamma_M'].cumsum()
        # Zero-gamma flip: where cum changes sign
        sign_change = np.sign(sub['cum']).diff().fillna(0)
        flip_idx = sign_change[sign_change != 0].index.tolist()
        flip_strike = sub.loc[flip_idx[0], 'strike'] if flip_idx else None
        spot = df.loc[df['trade_date'] == date, 'underlying_price'].mean()
        total = sub['dealer_gamma_M'].sum()
        flips.append({
            'date': str(date),
            'spot': spot,
            'flip_strike': flip_strike,
            'flip_distance_pts': (flip_strike - spot) if flip_strike else None,
            'total_dealer_gamma_M': total,
        })

    flip_df = pd.DataFrame(flips)
    print('\n=== Dealer-gamma reconstruction by day ===')
    print(flip_df.to_string(index=False))

    # Plot: latest day's strike profile + flip-distance series
    fig, axes = plt.subplots(1, 2, figsize=(14, 5), constrained_layout=True)
    latest = agg.loc[agg['trade_date'] == agg['trade_date'].max()].sort_values('strike')
    spot = df.loc[df['trade_date'] == latest['trade_date'].iloc[0],
                  'underlying_price'].mean()
    axes[0].bar(latest['strike'], latest['dealer_gamma_M'],
                width=5, color=np.where(latest['dealer_gamma_M'] > 0, 'green', 'red'),
                alpha=0.7, edgecolor='black', linewidth=0.3)
    axes[0].axvline(spot, color='black', linestyle='--', label=f'spot ~{spot:.0f}')
    axes[0].set_xlabel('Strike'); axes[0].set_ylabel('Dealer gamma ($M)')
    axes[0].set_title(f'SPXW dealer gamma by strike — {latest["trade_date"].iloc[0]}')
    axes[0].legend(); axes[0].grid(True, alpha=0.3)

    axes[1].plot(flip_df['date'], flip_df['total_dealer_gamma_M'],
                 marker='o', color='steelblue')
    axes[1].axhline(0, color='red', linestyle='--')
    axes[1].set_xlabel('Date'); axes[1].set_ylabel('Total dealer gamma ($M)')
    axes[1].set_title('Net dealer gamma — SPXW 0DTE per day\n(>0 = stabilizing, <0 = destabilizing)')
    axes[1].tick_params(axis='x', rotation=45); axes[1].grid(True, alpha=0.3)

    fig.savefig(OUT / 'plots' / 'q8_dealer_gamma.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    flip_df.to_csv(OUT / 'outputs' / 'q8_dealer_gamma.csv', index=False)


if __name__ == '__main__':
    main()
