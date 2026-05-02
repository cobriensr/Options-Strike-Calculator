"""Phase 24 — extend analysis beyond V3 to validate SPY/IWM/MU + the
major large-cap tickers V3 was missing.

V3 ticker list excluded SPY, IWM, MU, META, AMD, NVDA, INTC, MSFT, AMZN,
PLTR, AVGO, GOOGL, COIN, MSTR, HOOD, MRVL, ORCL — all heavily-traded
optionable names. p14 has them in raw; we just filtered them out earlier.

This script:
  1. Applies v3-style filters (DTE=0, ask% ≥ 0.52) to the extended set
  2. Per-ticker base stats (win, big_win, RE-LOAD lift)
  3. High-burst put analysis (Q5 vs baseline, EoD + 30-min metrics)
  4. Sanity check SPY 721P, IWM 279P, MU 542.5C (from user screenshot)

Definitions (no silent metric drift):
  * win_30 = realized_multiple_30 ≥ 2.0 (DOUBLE within 30 min)
  * big_30 = realized_multiple_30 ≥ 5.0
  * win_eod = realized_multiple_eod ≥ 2.0 (peak any time to EoD)
  * big_eod = realized_multiple_eod ≥ 5.0
  * RE-LOAD = entry_drop_pct_vs_prev ≤ -30 AND burst_ratio_vs_prev ≥ 2

Note on SPY 0DTE: SPY now has SPXW-style daily expiries. SPXW is a
separate symbol with index settlement, which we keep separate.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1]

EXTENDED_TARGETS = [
    'SPY', 'IWM', 'MU',
    'META', 'AMD', 'NVDA', 'INTC', 'MSFT', 'AMZN',
    'PLTR', 'AVGO', 'GOOGL', 'GOOG', 'COIN', 'MSTR',
    'HOOD', 'MRVL', 'ORCL', 'AAPL',
]


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v4 fires (all tickers)')

    sub = df.loc[
        df['underlying_symbol'].isin(EXTENDED_TARGETS)
        & (df['dte'] == 0)
        & (df['trigger_ask_pct'] >= 0.52)
    ].copy()
    print(f'After v3-style filters on extended targets: {len(sub):,}')
    print(f'\nFires by ticker:')
    print(sub['underlying_symbol'].value_counts().to_string())

    # Compute prev-fire features for RE-LOAD
    sub = sub.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)
    grp = sub.groupby(['date', 'option_chain_id'])
    sub['prev_window_size'] = grp['trigger_window_size'].shift(1)
    sub['prev_entry_price'] = grp['entry_price'].shift(1)
    sub['burst_ratio_vs_prev'] = sub['trigger_window_size'] / sub['prev_window_size']
    sub['entry_drop_pct_vs_prev'] = (
        (sub['entry_price'] - sub['prev_entry_price']) / sub['prev_entry_price'] * 100
    )
    sub['reload'] = ((sub['burst_ratio_vs_prev'] >= 2)
                    & (sub['entry_drop_pct_vs_prev'] <= -30)).fillna(False)

    sub['hour'] = sub['trigger_time_ct'].dt.hour + sub['trigger_time_ct'].dt.minute / 60
    sub['tod'] = sub['hour'].apply(lambda h:
        'AM_open' if h < 9.5 else 'MID' if h < 11.5 else 'LUNCH' if h < 12.5 else 'PM')
    sub['win_30'] = (sub['realized_multiple_30'] >= 2.0).astype(int)
    sub['big_30'] = (sub['realized_multiple_30'] >= 5.0).astype(int)
    sub['win_eod'] = (sub['realized_multiple_eod'] >= 2.0).astype(int)
    sub['big_eod'] = (sub['realized_multiple_eod'] >= 5.0).astype(int)

    # ============================================================
    # Per-ticker overall stats (calls + puts together)
    # ============================================================
    print('\n' + '=' * 105)
    print('=== PER-TICKER OVERALL (extended set, v3-style filtered) — sorted by win_eod ===')
    print('=' * 105)
    print(f'{"ticker":<8s} {"n":>5s} {"win_eod%":>9s} {"big_eod%":>9s} '
          f'{"win_30%":>9s} {"big_30%":>9s} {"med_eod_mult":>12s} {"reload_n":>9s} '
          f'{"reload_win_eod%":>16s}')
    rows = []
    for sym, g in sub.groupby('underlying_symbol'):
        if len(g) < 30:
            continue
        rl = g.loc[g['reload']]
        rows.append({
            'ticker': sym,
            'n': len(g),
            'win_eod_pct': g['win_eod'].mean() * 100,
            'big_eod_pct': g['big_eod'].mean() * 100,
            'win_30_pct': g['win_30'].mean() * 100,
            'big_30_pct': g['big_30'].mean() * 100,
            'med_eod_mult': g['realized_multiple_eod'].median(),
            'reload_n': len(rl),
            'reload_win_eod_pct': (rl['win_eod'].mean() * 100) if len(rl) > 0 else 0,
        })
    rdf = pd.DataFrame(rows).sort_values('win_eod_pct', ascending=False)
    for _, r in rdf.iterrows():
        print(f'{r["ticker"]:<8s} {int(r["n"]):>5d} {r["win_eod_pct"]:>8.1f}% '
              f'{r["big_eod_pct"]:>8.1f}% {r["win_30_pct"]:>8.1f}% '
              f'{r["big_30_pct"]:>8.1f}% {r["med_eod_mult"]:>11.2f}x '
              f'{int(r["reload_n"]):>9d} {r["reload_win_eod_pct"]:>15.1f}%')

    # ============================================================
    # Per-ticker calls vs puts
    # ============================================================
    print('\n' + '=' * 105)
    print('=== PER-TICKER × CALL/PUT split ===')
    print('=' * 105)
    print(f'{"ticker":<8s} {"opt":<5s} {"n":>5s} {"win_eod%":>9s} {"big_eod%":>9s} '
          f'{"win_30%":>9s} {"big_30%":>9s} {"med_eod":>10s} {"med_strike%_of_spot":>20s}')
    for sym, g in sub.groupby('underlying_symbol'):
        if len(g) < 30:
            continue
        for opt in ['call', 'put']:
            sg = g.loc[g['option_type'] == opt]
            if len(sg) < 15:
                continue
            spct = ((sg['strike'] / sg['spot_at_first']) - 1) * 100
            print(f'{sym:<8s} {opt:<5s} {len(sg):>5d} {sg["win_eod"].mean()*100:>8.1f}% '
                  f'{sg["big_eod"].mean()*100:>8.1f}% {sg["win_30"].mean()*100:>8.1f}% '
                  f'{sg["big_30"].mean()*100:>8.1f}% {sg["realized_multiple_eod"].median():>9.2f}x '
                  f'{spct.median():>+19.2f}%')

    # ============================================================
    # High-burst PUT analysis per ticker
    # ============================================================
    print('\n' + '=' * 105)
    print('=== HIGH-BURST PUT ANALYSIS (Q5 burst quintile per ticker) ===')
    print('=' * 105)
    for sym in EXTENDED_TARGETS:
        puts = sub.loc[(sub['underlying_symbol'] == sym) & (sub['option_type'] == 'put')].copy()
        if len(puts) < 30:
            continue
        try:
            puts['_qb'] = pd.qcut(puts['trigger_window_size'].rank(method='first'), 5,
                                   labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            continue
        print(f'\n--- {sym} PUTS (n={len(puts)}) ---')
        print(f'{"q":<4s} {"n":>4s} {"med size":>10s} {"win_30%":>9s} {"big_30%":>9s} '
              f'{"win_eod%":>10s} {"big_eod%":>10s} {"med_eod_mult":>12s}')
        for qb, g in puts.groupby('_qb', observed=True):
            print(f'{qb:<4s} {len(g):>4d} {g["trigger_window_size"].median():>10.0f} '
                  f'{g["win_30"].mean()*100:>8.1f}% {g["big_30"].mean()*100:>8.1f}% '
                  f'{g["win_eod"].mean()*100:>9.1f}% {g["big_eod"].mean()*100:>9.1f}% '
                  f'{g["realized_multiple_eod"].median():>11.2f}x')

        # Q5 × TOD breakdown for puts
        top = puts.loc[puts['_qb'] == 'Q5']
        print(f'  Q5 × TOD:')
        for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
            g = top.loc[top['tod'] == tod]
            if len(g) < 5:
                continue
            print(f'    {tod:<10s} n={len(g):>3d} '
                  f'win_30={g["win_30"].mean()*100:5.1f}% '
                  f'big_30={g["big_30"].mean()*100:5.1f}% '
                  f'win_eod={g["win_eod"].mean()*100:5.1f}% '
                  f'med_eod={g["realized_multiple_eod"].median():.2f}x')

    # ============================================================
    # SANITY CHECK: SPY 721P, IWM 279P, MU 542.5C from user screenshot
    # ============================================================
    print('\n' + '=' * 105)
    print('=== SANITY CHECK: user screenshot tickers (5/1) ===')
    print('=' * 105)
    targets = [
        ('SPY', 721.0, 'put'),
        ('SPY', 723.0, 'call'),
        ('IWM', 279.0, 'put'),
        ('MU', 542.5, 'call'),
    ]
    for sym, strike, opt in targets:
        rows = sub.loc[
            (sub['underlying_symbol'] == sym)
            & (sub['date'].dt.strftime('%Y-%m-%d') == '2026-05-01')
            & (sub['strike'] == strike)
            & (sub['option_type'] == opt)
        ].sort_values('trigger_time_ct')
        print(f'\n--- {sym} {strike}{opt[0].upper()} 5/1 (n={len(rows)} fires) ---')
        if len(rows) == 0:
            print('  (no fires — check filter or strike rounding)')
            continue
        cols = ['alert_seq', 'trigger_time_ct', 'entry_price',
                'trigger_window_size', 'trigger_vol_to_oi_window',
                'trigger_ask_pct', 'realized_multiple_30',
                'realized_multiple_eod', 'minutes_to_peak_eod']
        print(rows[cols].to_string(index=False))


if __name__ == '__main__':
    main()
