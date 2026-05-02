"""Phase 25 — relaxed DTE filter for non-0DTE stock options.

p24 showed that the v3 "DTE=0" filter wipes out single-stock flow because
stocks like MU/META/AMD/NVDA/AMZN don't have daily expiries. Their flow
lives at DTE 1-7. This script:

  1. Relaxes DTE filter from 0 to ≤ 3 for the extended target set
  2. Adds a moneyness gate (|strike_pct_of_spot| ≤ 10%) to drop
     deep-OTM lottery tickets that pollute small-sample stats
  3. Same other filters: ask% ≥ 0.52
  4. Per-ticker base stats, calls vs puts, Q5-burst put analysis
  5. Sanity check the user's IWM 279P / MU 542.5C examples

Definitions (no silent metric drift):
  * Filter is now "DTE ≤ 3" (was "DTE = 0" in v3-style for SPY/QQQ)
  * Moneyness gate: |strike/spot − 1| ≤ 0.10 (10% in-the-money or out)
  * win_30 = realized_multiple_30 ≥ 2.0
  * win_eod = realized_multiple_eod ≥ 2.0
  * Per-contract math throughout
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

    # Pre-filter: target tickers + ask% threshold
    sub = df.loc[
        df['underlying_symbol'].isin(EXTENDED_TARGETS)
        & (df['trigger_ask_pct'] >= 0.52)
    ].copy()

    # Moneyness
    sub['strike_pct_of_spot'] = (sub['strike'] / sub['spot_at_first'] - 1) * 100
    sub['in_play_moneyness'] = sub['strike_pct_of_spot'].abs() <= 10

    # DTE breakdown to see what we're working with
    print('\nFires by ticker × DTE bucket (ask% ≥ 0.52, no moneyness filter yet):')
    sub['dte_bucket'] = sub['dte'].apply(
        lambda d: '0' if d == 0 else '1-3' if d <= 3 else '4-7' if d <= 7 else '8+'
    )
    pivot = sub.pivot_table(index='underlying_symbol', columns='dte_bucket',
                            values='entry_price', aggfunc='count', fill_value=0)
    pivot = pivot.reindex(EXTENDED_TARGETS).dropna(how='all')
    print(pivot.to_string())

    # Apply DTE ≤ 3 + moneyness ≤ 10%
    flt = sub.loc[(sub['dte'] <= 3) & sub['in_play_moneyness']].copy()
    flt = flt.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)
    print(f'\nAfter DTE ≤ 3 + |moneyness| ≤ 10%: {len(flt):,} fires')

    # Compute prev-fire features for RE-LOAD
    grp = flt.groupby(['date', 'option_chain_id'])
    flt['prev_window_size'] = grp['trigger_window_size'].shift(1)
    flt['prev_entry_price'] = grp['entry_price'].shift(1)
    flt['burst_ratio_vs_prev'] = flt['trigger_window_size'] / flt['prev_window_size']
    flt['entry_drop_pct_vs_prev'] = (
        (flt['entry_price'] - flt['prev_entry_price']) / flt['prev_entry_price'] * 100
    )
    flt['reload'] = ((flt['burst_ratio_vs_prev'] >= 2)
                    & (flt['entry_drop_pct_vs_prev'] <= -30)).fillna(False)
    flt['hour'] = flt['trigger_time_ct'].dt.hour + flt['trigger_time_ct'].dt.minute / 60
    flt['tod'] = flt['hour'].apply(lambda h:
        'AM_open' if h < 9.5 else 'MID' if h < 11.5 else 'LUNCH' if h < 12.5 else 'PM')
    flt['win_30'] = (flt['realized_multiple_30'] >= 2.0).astype(int)
    flt['big_30'] = (flt['realized_multiple_30'] >= 5.0).astype(int)
    flt['win_eod'] = (flt['realized_multiple_eod'] >= 2.0).astype(int)
    flt['big_eod'] = (flt['realized_multiple_eod'] >= 5.0).astype(int)

    # ============================================================
    # Per-ticker overall (only ≥ 30 fires)
    # ============================================================
    print('\n' + '=' * 105)
    print('=== PER-TICKER OVERALL (DTE ≤ 3, |moneyness| ≤ 10%) ===')
    print('=' * 105)
    print(f'{"ticker":<8s} {"n":>5s} {"win_eod%":>9s} {"big_eod%":>9s} '
          f'{"win_30%":>9s} {"big_30%":>9s} {"med_eod_mult":>12s} '
          f'{"reload_n":>9s} {"reload_win_eod%":>16s}')
    rows = []
    for sym, g in flt.groupby('underlying_symbol'):
        if len(g) < 30:
            continue
        rl = g.loc[g['reload']]
        rows.append({
            'ticker': sym,
            'n': len(g),
            'win_eod_pct': round(g['win_eod'].mean() * 100, 1),
            'big_eod_pct': round(g['big_eod'].mean() * 100, 1),
            'win_30_pct': round(g['win_30'].mean() * 100, 1),
            'big_30_pct': round(g['big_30'].mean() * 100, 1),
            'med_eod_mult': round(g['realized_multiple_eod'].median(), 2),
            'reload_n': len(rl),
            'reload_win_eod_pct': round(rl['win_eod'].mean() * 100, 1) if len(rl) > 0 else None,
        })
    rdf = pd.DataFrame(rows).sort_values('win_eod_pct', ascending=False)
    for _, r in rdf.iterrows():
        rl_w = f'{r["reload_win_eod_pct"]:>15.1f}%' if r['reload_win_eod_pct'] is not None else '              -'
        print(f'{r["ticker"]:<8s} {int(r["n"]):>5d} {r["win_eod_pct"]:>8.1f}% '
              f'{r["big_eod_pct"]:>8.1f}% {r["win_30_pct"]:>8.1f}% '
              f'{r["big_30_pct"]:>8.1f}% {r["med_eod_mult"]:>11.2f}x '
              f'{int(r["reload_n"]):>9d} {rl_w}')

    # ============================================================
    # Per-ticker × call/put
    # ============================================================
    print('\n' + '=' * 105)
    print('=== PER-TICKER × call/put ===')
    print('=' * 105)
    print(f'{"ticker":<8s} {"opt":<5s} {"n":>5s} {"win_eod%":>9s} {"big_eod%":>9s} '
          f'{"win_30%":>9s} {"big_30%":>9s} {"med_eod":>10s}')
    for sym in EXTENDED_TARGETS:
        g_t = flt.loc[flt['underlying_symbol'] == sym]
        if len(g_t) < 30:
            continue
        for opt in ['call', 'put']:
            sg = g_t.loc[g_t['option_type'] == opt]
            if len(sg) < 15:
                continue
            print(f'{sym:<8s} {opt:<5s} {len(sg):>5d} {sg["win_eod"].mean()*100:>8.1f}% '
                  f'{sg["big_eod"].mean()*100:>8.1f}% {sg["win_30"].mean()*100:>8.1f}% '
                  f'{sg["big_30"].mean()*100:>8.1f}% {sg["realized_multiple_eod"].median():>9.2f}x')

    # ============================================================
    # Q5-burst put analysis
    # ============================================================
    print('\n' + '=' * 105)
    print('=== HIGH-BURST PUT ANALYSIS (Q5 quintile per ticker) ===')
    print('=' * 105)
    for sym in EXTENDED_TARGETS:
        puts = flt.loc[(flt['underlying_symbol'] == sym) & (flt['option_type'] == 'put')].copy()
        if len(puts) < 30:
            continue
        try:
            puts['_qb'] = pd.qcut(puts['trigger_window_size'].rank(method='first'), 5,
                                   labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            continue
        print(f'\n--- {sym} PUTS (n={len(puts)}) ---')
        print(f'{"q":<4s} {"n":>4s} {"med size":>10s} {"win_30%":>9s} {"big_30%":>9s} '
              f'{"win_eod%":>10s} {"big_eod%":>10s} {"med_eod":>10s}')
        for qb, g in puts.groupby('_qb', observed=True):
            print(f'{qb:<4s} {len(g):>4d} {g["trigger_window_size"].median():>10.0f} '
                  f'{g["win_30"].mean()*100:>8.1f}% {g["big_30"].mean()*100:>8.1f}% '
                  f'{g["win_eod"].mean()*100:>9.1f}% {g["big_eod"].mean()*100:>9.1f}% '
                  f'{g["realized_multiple_eod"].median():>9.2f}x')

        # Q5 × TOD
        top = puts.loc[puts['_qb'] == 'Q5']
        if len(top) > 0:
            print('  Q5 × TOD:')
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
    # Q5-burst CALL analysis (same structure for completeness)
    # ============================================================
    print('\n' + '=' * 105)
    print('=== HIGH-BURST CALL ANALYSIS (Q5 quintile per ticker) ===')
    print('=' * 105)
    for sym in EXTENDED_TARGETS:
        calls = flt.loc[(flt['underlying_symbol'] == sym) & (flt['option_type'] == 'call')].copy()
        if len(calls) < 30:
            continue
        try:
            calls['_qb'] = pd.qcut(calls['trigger_window_size'].rank(method='first'), 5,
                                   labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            continue
        print(f'\n--- {sym} CALLS (n={len(calls)}) ---')
        print(f'{"q":<4s} {"n":>4s} {"med size":>10s} {"win_30%":>9s} {"big_30%":>9s} '
              f'{"win_eod%":>10s} {"big_eod%":>10s} {"med_eod":>10s}')
        for qb, g in calls.groupby('_qb', observed=True):
            print(f'{qb:<4s} {len(g):>4d} {g["trigger_window_size"].median():>10.0f} '
                  f'{g["win_30"].mean()*100:>8.1f}% {g["big_30"].mean()*100:>8.1f}% '
                  f'{g["win_eod"].mean()*100:>9.1f}% {g["big_eod"].mean()*100:>9.1f}% '
                  f'{g["realized_multiple_eod"].median():>9.2f}x')

    # ============================================================
    # SANITY CHECK — user screenshot examples (5/1)
    # ============================================================
    print('\n' + '=' * 105)
    print('=== SANITY CHECK: user screenshot examples (5/1) ===')
    print('=' * 105)
    targets = [
        ('SPY', 721.0, 'put'),
        ('SPY', 723.0, 'call'),
        ('IWM', 279.0, 'put'),
        ('MU',  542.5, 'call'),
        ('MU',  540.0, 'call'),  # in case of rounding
    ]
    for sym, strike, opt in targets:
        rows = flt.loc[
            (flt['underlying_symbol'] == sym)
            & (flt['date'].dt.strftime('%Y-%m-%d') == '2026-05-01')
            & (flt['strike'] == strike)
            & (flt['option_type'] == opt)
        ].sort_values('trigger_time_ct')
        # Also try the raw v4 set in case our filter dropped it
        raw = df.loc[
            (df['underlying_symbol'] == sym)
            & (df['date'].dt.strftime('%Y-%m-%d') == '2026-05-01')
            & (df['strike'] == strike)
            & (df['option_type'] == opt)
        ].sort_values('trigger_time_ct')
        print(f'\n--- {sym} {strike}{opt[0].upper()} 5/1 — '
              f'filtered n={len(rows)}, raw v4 n={len(raw)} ---')
        if len(raw) == 0:
            print('  (NOT in raw v4 — chain may be too thin or no qualifying fires)')
            continue
        cols = ['alert_seq', 'trigger_time_ct', 'dte', 'entry_price',
                'trigger_window_size', 'trigger_vol_to_oi_window',
                'trigger_ask_pct', 'realized_multiple_30',
                'realized_multiple_eod', 'minutes_to_peak_eod']
        target = rows if len(rows) > 0 else raw
        print(target[cols].head(20).to_string(index=False))


if __name__ == '__main__':
    main()
