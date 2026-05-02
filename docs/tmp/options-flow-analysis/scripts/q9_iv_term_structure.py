"""Q9: SPXW intraday IV term structure dynamics.

For each minute, compute the volume-weighted ATM-ish IV by DTE bucket,
then look at the term structure (0DTE vs 1-7d vs 8-30d).
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


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'expiry', 'strike',
            'underlying_price', 'implied_volatility', 'size', 'canceled']
    raw = load(cols, tickers=['SPXW', 'SPX'])
    df = add_ct_time(raw)
    df = df.loc[~df['canceled']]
    df = filter_rth(df)
    df = df.loc[df['implied_volatility'].between(0.05, 2.0)]

    # ATM-ish: |moneyness| < 1%
    df['moneyness'] = (df['strike'] - df['underlying_price']) / df['underlying_price']
    atm = df.loc[df['moneyness'].abs() < 0.01].copy()
    atm['dte'] = (atm['expiry'] - atm['executed_at_ct'].dt.date).apply(
        lambda x: x.days
    )
    atm['dte_bucket'] = pd.cut(
        atm['dte'], bins=[-1, 0, 7, 30, 90, 365],
        labels=['0DTE', '1-7d', '8-30d', '31-90d', '91d+']
    )
    print(f'ATM rows: {len(atm):,}')

    # Hour-of-session × DTE bucket
    atm['hour'] = atm['executed_at_ct'].dt.hour + atm['executed_at_ct'].dt.minute / 60
    grp = atm.groupby([pd.cut(atm['hour'], bins=np.arange(8.5, 15.1, 0.5)),
                       'dte_bucket'])
    summary = grp.apply(
        lambda g: np.average(g['implied_volatility'], weights=g['size'])
        if g['size'].sum() > 0 else np.nan
    ).unstack('dte_bucket')

    print('\n=== Volume-weighted ATM IV by hour × DTE ===')
    print(summary.round(3))

    # Plot
    fig, ax = plt.subplots(figsize=(12, 6), constrained_layout=True)
    for col in summary.columns:
        if summary[col].notna().any():
            x = np.arange(len(summary))
            ax.plot(x, summary[col].values * 100, marker='o', label=str(col))
    ax.set_xticks(np.arange(len(summary)))
    ax.set_xticklabels([str(i) for i in summary.index], rotation=45, ha='right')
    ax.set_xlabel('Hour bucket (CT, 30-min)')
    ax.set_ylabel('Volume-weighted ATM IV (%)')
    ax.set_title('SPX/SPXW ATM IV term-structure intraday (15-day avg)')
    ax.legend(title='DTE')
    ax.grid(True, alpha=0.3)

    fig.savefig(OUT / 'plots' / 'q9_iv_term_structure.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    summary.to_csv(OUT / 'outputs' / 'q9_iv_term.csv')


if __name__ == '__main__':
    main()
