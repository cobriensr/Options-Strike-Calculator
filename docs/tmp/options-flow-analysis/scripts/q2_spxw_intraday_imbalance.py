"""Q2: SPXW 0DTE intraday call/put net-premium imbalance curve."""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from _loader import (  # noqa: E402
    add_ct_time,
    directional_only,
    filter_rth,
    is_zero_dte,
    load,
)

OUT = Path(__file__).resolve().parents[1]


def main() -> None:
    cols = ['executed_at', 'underlying_symbol', 'side', 'option_type',
            'expiry', 'premium', 'canceled']
    raw = load(cols, tickers=['SPXW'])
    df = directional_only(add_ct_time(raw))
    df = df.loc[is_zero_dte(df)]
    df = filter_rth(df)
    print(f'SPXW 0DTE directional rows: {len(df):,}')

    # Signed premium: call+ask=+, call+bid=-, put+ask=-, put+bid=+
    is_call = df['option_type'] == 'call'
    is_ask = df['side'] == 'ask'
    sign = np.where(is_call == is_ask, 1.0, -1.0)
    df['signed_premium'] = sign * df['premium']

    # Time-of-day in minutes since 08:30 CT (so all days line up)
    t = df['executed_at_ct']
    df['min_into_session'] = (
        (t.dt.hour - 8) * 60 + t.dt.minute - 30
    ).astype(int)
    df = df.loc[(df['min_into_session'] >= 0) & (df['min_into_session'] <= 390)]

    # Cumulative net premium by minute, per day
    by_day = df.groupby(['trade_date', 'min_into_session'])['signed_premium'].sum()
    by_day = by_day.unstack('trade_date').fillna(0).cumsum()

    # Average across days
    avg_curve = by_day.mean(axis=1)

    # Plot
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15, 5), constrained_layout=True)

    # Per-day overlay
    for col in by_day.columns:
        ax1.plot(by_day.index, by_day[col] / 1e6, alpha=0.4, linewidth=1)
    ax1.plot(avg_curve.index, avg_curve.values / 1e6, color='black',
             linewidth=2.5, label='15-day mean')
    ax1.axhline(0, color='gray', linewidth=0.5)
    # Phase markers (per user trading schedule)
    phases = [(0, 'open 08:30'), (30, 'pre-trade 09:00'),
              (90, 'lull 10:00'), (240, 'PM session 12:30'),
              (390, 'close 15:00')]
    for x, lab in phases:
        ax1.axvline(x, color='red', linestyle=':', alpha=0.5)
        ax1.text(x + 2, ax1.get_ylim()[1] * 0.9, lab, fontsize=8,
                 color='red', alpha=0.7)
    ax1.set_xlabel('Minutes into session (08:30 CT = 0)')
    ax1.set_ylabel('Cumulative net signed premium ($M)')
    ax1.set_title('SPXW 0DTE: cumulative net directional premium\n(per-day curves + 15-day mean)')
    ax1.grid(True, alpha=0.3)
    ax1.legend()

    # End-of-day distribution (where does the tape land?)
    eod = by_day.iloc[-1].values / 1e6
    ax2.hist(eod, bins=10, color='steelblue', edgecolor='black')
    ax2.axvline(0, color='red', linewidth=1)
    ax2.set_xlabel('End-of-day cumulative net premium ($M)')
    ax2.set_ylabel('Days')
    ax2.set_title(f'EoD net premium distribution (15 days)\nmean={eod.mean():+.1f}M, median={np.median(eod):+.1f}M')
    ax2.grid(True, alpha=0.3)

    fig.savefig(OUT / 'plots' / 'q2_spxw_intraday_imbalance.png', dpi=150,
                bbox_inches='tight', facecolor='white')

    summary = pd.DataFrame({
        'min_into_session': avg_curve.index,
        'avg_cum_net_premium_M': avg_curve.values / 1e6,
    })
    summary.to_csv(OUT / 'outputs' / 'q2_imbalance_curve.csv', index=False)
    print(f'Mean EoD net: {eod.mean():+.2f}M | median: {np.median(eod):+.2f}M')
    print(f'Days net-bullish: {(eod > 0).sum()}/{len(eod)}')


if __name__ == '__main__':
    main()
