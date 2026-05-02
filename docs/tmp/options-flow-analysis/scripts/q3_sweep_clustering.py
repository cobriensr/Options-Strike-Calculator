"""Q3: Sweep & cross-trade clustering at SPX-family strikes.

Looks at where {intermarket_sweep} and {cross_trade} prints concentrate.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import add_ct_time, filter_rth, is_zero_dte, load  # noqa: E402

OUT = Path(__file__).resolve().parents[1]


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'side', 'option_type',
            'expiry', 'strike', 'premium', 'underlying_price',
            'report_flags', 'canceled']
    raw = load(cols, tickers=['SPY', 'SPXW', 'QQQ'])
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    df = filter_rth(df)
    print(f'Rows: {len(df):,}')

    # Tag flag categories
    df['is_sweep'] = df['report_flags'].str.contains('sweep', na=False)
    df['is_cross'] = df['report_flags'].str.contains('cross', na=False)
    df['is_zero_dte'] = is_zero_dte(df)

    # Headline counts (vectorized — multiply mask × premium then groupby-sum)
    df['sweep_premium'] = df['premium'].where(df['is_sweep'], 0.0)
    df['cross_premium'] = df['premium'].where(df['is_cross'], 0.0)
    overall = df.groupby('underlying_symbol').agg(
        rows=('premium', 'size'),
        sweep_pct=('is_sweep', 'mean'),
        cross_pct=('is_cross', 'mean'),
        sweep_premium_M=('sweep_premium', lambda s: s.sum() / 1e6),
        cross_premium_M=('cross_premium', lambda s: s.sum() / 1e6),
    )
    print('\n=== Sweep / cross-trade share by ticker ===')
    print(overall)

    # Distance of sweep strikes from spot, per ticker, 0DTE only
    sweeps = df.loc[df['is_sweep'] & df['is_zero_dte']].copy()
    sweeps['strike_dist_pct'] = (
        (sweeps['strike'] - sweeps['underlying_price'])
        / sweeps['underlying_price'] * 100
    )

    fig, axes = plt.subplots(1, 3, figsize=(16, 5), constrained_layout=True)
    for ax, tk in zip(axes, ['SPY', 'SPXW', 'QQQ']):
        sub = sweeps.loc[sweeps['underlying_symbol'] == tk]
        if len(sub) == 0:
            ax.set_title(f'{tk} — no 0DTE sweeps')
            continue
        # Weight by premium so $ matter more than count
        ax.hist(
            sub['strike_dist_pct'],
            bins=60,
            range=(-3, 3),
            weights=sub['premium'] / 1e3,
            color='steelblue',
            edgecolor='black',
        )
        ax.axvline(0, color='red', linewidth=1)
        ax.set_xlabel('Strike distance from spot (%)')
        ax.set_ylabel('Sweep premium ($K)')
        ax.set_title(f'{tk} 0DTE sweeps — strike distribution\n({len(sub):,} sweeps, ${sub["premium"].sum()/1e6:.1f}M premium)')
        ax.grid(True, alpha=0.3)

    fig.savefig(OUT / 'plots' / 'q3_sweep_clustering.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    overall.to_csv(OUT / 'outputs' / 'q3_sweep_summary.csv')


if __name__ == '__main__':
    main()
