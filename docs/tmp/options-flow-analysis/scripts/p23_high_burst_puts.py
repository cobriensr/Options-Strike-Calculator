"""Phase 23 — high-burst puts on TSLA, QQQ, TSLL (and friends).

User feedback: "Don't drop all TSLA puts. The gamma-velocity panel shows
good TSLA put alerts (e.g. 5/1 TSLA 392.5P at vel 9.3×, 395P at vel 8.0×)
that work. Same for QQQ/SPY high-velocity puts before breakdowns."

Earlier put analysis used EoD as the success metric. EoD is wrong for
puts that work as 30-min breakdowns then bounce. Switching to:

   PRIMARY METRIC = realized_multiple_30
   (peak within 30 min of entry — captures scalp profile)

Test:
  1. TSLA puts by trigger_window_size quintile — do top-burst puts work?
  2. TSLA puts by trigger_vol_to_oi_window quintile (velocity proxy) —
     does the explosive-velocity filter pull out winners?
  3. Same for QQQ, TSLL, SOXS, SQQQ (the bearish leveraged ETFs in V3)
  4. Cross-tab: TOD × burst-quintile for puts on these tickers
  5. Sanity check: pull TSLA 5/1 392.5P and 395P from raw triggers and
     show their burst features so we can compare to the discriminator

Definitions (no silent metric drift):
  * win_30 = realized_multiple_30 >= 2.0 (DOUBLE within 30 min of entry)
  * big_30 = realized_multiple_30 >= 5.0 (5x within 30 min — explosive)
  * Default outcome window: 30 minutes (matches the actual scalp horizon)
  * EoD numbers shown for context only — known to be brutal for puts
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]
TARGETS = ['TSLA', 'QQQ', 'TSLL', 'SOXS', 'SQQQ']  # TSLA + leveraged ETFs


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p17_v4_v3style.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    df = df.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)
    grp = df.groupby(['date', 'option_chain_id'])
    df['prev_window_size'] = grp['trigger_window_size'].shift(1)
    df['prev_entry_price'] = grp['entry_price'].shift(1)
    df['burst_ratio_vs_prev'] = df['trigger_window_size'] / df['prev_window_size']
    df['entry_drop_pct_vs_prev'] = (
        (df['entry_price'] - df['prev_entry_price']) / df['prev_entry_price'] * 100
    )
    df['reload'] = ((df['burst_ratio_vs_prev'] >= 2)
                    & (df['entry_drop_pct_vs_prev'] <= -30)).fillna(False)

    # PRIMARY metrics — 30-min, not EoD
    df['win_30_2x'] = (df['realized_multiple_30'] >= 2.0).astype(int)
    df['big_30_5x'] = (df['realized_multiple_30'] >= 5.0).astype(int)
    df['win_eod_2x'] = (df['realized_multiple_eod'] >= 2.0).astype(int)

    # Subset to TARGETS + puts only
    puts = df.loc[df['underlying_symbol'].isin(TARGETS) & (df['option_type'] == 'put')].copy()
    print(f'PUT fires across {TARGETS}: {len(puts):,}')
    print(puts['underlying_symbol'].value_counts().to_string())

    # ============================================================
    # Per ticker: baseline vs high-burst vs RE-LOAD on PUTS
    # ============================================================
    for ticker in TARGETS:
        sub = puts.loc[puts['underlying_symbol'] == ticker].copy()
        if len(sub) < 30:
            print(f'\n{ticker}: only {len(sub)} put fires — skipping')
            continue
        print('\n' + '=' * 90)
        print(f'### {ticker} PUTS — n={len(sub):,} ###')
        print('=' * 90)

        # Baseline
        print(f'\nBaseline puts:')
        print(f'  win_30_2x: {sub["win_30_2x"].mean()*100:5.1f}%')
        print(f'  big_30_5x: {sub["big_30_5x"].mean()*100:5.1f}%')
        print(f'  win_eod_2x (for context): {sub["win_eod_2x"].mean()*100:5.1f}%')
        print(f'  median 30-min mult: {sub["realized_multiple_30"].median():.2f}')

        # By burst-size quintile
        try:
            sub['_qb'] = pd.qcut(sub['trigger_window_size'].rank(method='first'), 5,
                                 labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            continue
        print(f'\nBy trigger_window_size quintile (5-min burst contracts):')
        print(f'{"q":<4s} {"n":>4s} {"med size":>10s} {"win_30%":>9s} {"big_30%":>9s} '
              f'{"med 30 mult":>12s} {"win_eod%":>10s}')
        for qb, g in sub.groupby('_qb', observed=True):
            print(f'{qb:<4s} {len(g):>4d} {g["trigger_window_size"].median():>10.0f} '
                  f'{g["win_30_2x"].mean()*100:>8.1f}% {g["big_30_5x"].mean()*100:>8.1f}% '
                  f'{g["realized_multiple_30"].median():>12.2f} '
                  f'{g["win_eod_2x"].mean()*100:>9.1f}%')

        # By vol/OI window quintile (the velocity proxy)
        try:
            sub['_qv'] = pd.qcut(sub['trigger_vol_to_oi_window'].rank(method='first'), 5,
                                 labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            sub['_qv'] = 'NA'
        print(f'\nBy trigger_vol_to_oi_window quintile (velocity proxy):')
        print(f'{"q":<4s} {"n":>4s} {"med vel":>10s} {"win_30%":>9s} {"big_30%":>9s} '
              f'{"med 30 mult":>12s}')
        for qv, g in sub.groupby('_qv', observed=True):
            print(f'{qv:<4s} {len(g):>4d} {g["trigger_vol_to_oi_window"].median():>10.3f} '
                  f'{g["win_30_2x"].mean()*100:>8.1f}% {g["big_30_5x"].mean()*100:>8.1f}% '
                  f'{g["realized_multiple_30"].median():>12.2f}')

        # By TOD × top burst quintile
        print(f'\nTop burst quintile (Q5) × TOD:')
        top = sub.loc[sub['_qb'] == 'Q5']
        print(f'{"tod":<10s} {"n":>4s} {"win_30%":>9s} {"big_30%":>9s} {"med 30 mult":>12s}')
        for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
            g = top.loc[top['tod'] == tod]
            if len(g) < 5:
                continue
            print(f'{tod:<10s} {len(g):>4d} '
                  f'{g["win_30_2x"].mean()*100:>8.1f}% {g["big_30_5x"].mean()*100:>8.1f}% '
                  f'{g["realized_multiple_30"].median():>12.2f}')

        # RE-LOAD
        rl = sub.loc[sub['reload']]
        if len(rl) >= 5:
            print(f'\nRE-LOAD puts (n={len(rl)}):')
            print(f'  win_30_2x: {rl["win_30_2x"].mean()*100:5.1f}%')
            print(f'  big_30_5x: {rl["big_30_5x"].mean()*100:5.1f}%')
            print(f'  med 30-min mult: {rl["realized_multiple_30"].median():.2f}')

        # Top of stack: burst Q5 + RE-LOAD or Q5 + AM_open
        for label, mask in [
            ('Q5 burst + AM_open', (sub['_qb'] == 'Q5') & (sub['tod'] == 'AM_open')),
            ('Q5 burst + RE-LOAD', (sub['_qb'] == 'Q5') & sub['reload']),
            ('Q5 vol/OI + AM_open',
                (sub.get('_qv', pd.Series(dtype=str)) == 'Q5') & (sub['tod'] == 'AM_open')),
        ]:
            g = sub.loc[mask.fillna(False)]
            if len(g) < 5:
                continue
            print(f'\n{label} (n={len(g)}):')
            print(f'  win_30_2x: {g["win_30_2x"].mean()*100:5.1f}%')
            print(f'  big_30_5x: {g["big_30_5x"].mean()*100:5.1f}%')
            print(f'  med 30-min mult: {g["realized_multiple_30"].median():.2f}')

    # ============================================================
    # SANITY CHECK: TSLA 5/1 392.5P and 395P specifically
    # ============================================================
    print('\n' + '=' * 90)
    print('=== SANITY CHECK: TSLA 5/1 392.5P and 395P (from user screenshot) ===')
    print('=' * 90)
    tsla_puts_5_1 = df.loc[
        (df['underlying_symbol'] == 'TSLA')
        & (df['date'].dt.strftime('%Y-%m-%d') == '2026-05-01')
        & (df['option_type'] == 'put')
        & (df['strike'].isin([392.5, 395.0]))
    ].sort_values(['strike', 'trigger_time_ct'])
    if len(tsla_puts_5_1) > 0:
        cols = ['strike', 'trigger_time_ct', 'alert_seq', 'entry_price',
                'trigger_window_size', 'trigger_vol_to_oi_window',
                'trigger_ask_pct', 'realized_multiple_30',
                'realized_multiple_eod', 'minutes_to_peak_eod']
        print(tsla_puts_5_1[cols].to_string(index=False))
    else:
        print('Not in v3-filtered set (likely failed dte=0 or ask% filter)')


if __name__ == '__main__':
    main()
