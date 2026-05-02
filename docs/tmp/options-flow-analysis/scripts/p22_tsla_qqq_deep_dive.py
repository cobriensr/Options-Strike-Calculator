"""Phase 22 — TSLA + QQQ deep-dive.

These two tickers together are 47% of v3-style v4 fires (7,361 of 15,790)
but have the worst base win rates (TSLA 22.7%, QQQ 7.5%). They'd dominate
the live alert pane with mostly noise unless we find specific conditions
under which they're actually tradeable.

For each of TSLA and QQQ, slice on:
  1. flow_quad × TOD
  2. RE-LOAD × TOD
  3. Entry-price bucket (cheap vs expensive)
  4. Strike-vs-spot moneyness (OTM/ATM/ITM)
  5. Burst size quintile (is the alert backed by real volume?)
  6. Per-date concentration (are wins clumped on specific dates?)

Definitions (no silent metric drift):
  * "Win" = realized_multiple_eod ≥ 2.0
  * "Big win" = realized_multiple_eod ≥ 5.0
  * RE-LOAD = entry_drop_pct_vs_prev ≤ -30 AND burst_ratio_vs_prev ≥ 2
  * Moneyness: OTM = strike > spot+1% (calls) or strike < spot-1% (puts);
    ATM = within ±1%; ITM = beyond
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


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
    df['win'] = (df['realized_multiple_eod'] >= 2.0).astype(int)
    df['big_win'] = (df['realized_multiple_eod'] >= 5.0).astype(int)

    # flow_quad (compute here — not in p17 output)
    def side(p):
        if p >= 0.60:
            return 'ask'
        if p <= 0.40:
            return 'bid'
        return 'mixed'
    df['dominant_side'] = df['trigger_ask_pct'].apply(side)
    df['flow_quad'] = df['option_type'] + '_' + df['dominant_side']

    # Moneyness
    df['spot'] = df['spot_at_first']
    df['strike_pct_of_spot'] = (df['strike'] / df['spot'] - 1) * 100
    def moneyness(row):
        pct = row['strike_pct_of_spot']
        if row['option_type'] == 'call':
            if pct > 1: return 'OTM'
            if pct < -1: return 'ITM'
            return 'ATM'
        # put
        if pct < -1: return 'OTM'
        if pct > 1: return 'ITM'
        return 'ATM'
    df['moneyness'] = df.apply(moneyness, axis=1)

    # Entry-price buckets
    def price_bucket(p):
        if p < 0.5: return 'cheap_<0.5'
        if p < 2: return 'low_0.5-2'
        if p < 10: return 'mid_2-10'
        if p < 50: return 'high_10-50'
        return 'very_high_50+'
    df['price_bucket'] = df['entry_price'].apply(price_bucket)

    for ticker in ['TSLA', 'QQQ']:
        sub = df.loc[df['underlying_symbol'] == ticker].copy()
        print('\n' + '#' * 90)
        print(f'### {ticker} DEEP DIVE — n={len(sub):,}, base win {sub["win"].mean()*100:.1f}%, '
              f'base big {sub["big_win"].mean()*100:.1f}% ###')
        print('#' * 90)

        # ============================================================
        # Slice 1: flow_quad × TOD
        # ============================================================
        print(f'\n--- {ticker}: flow_quad × TOD (subsets ≥ 30) ---')
        print(f'{"flow_quad":<14s} {"tod":<10s} {"n":>5s} {"win 2×%":>9s} '
              f'{"big%":>7s} {"med mult":>10s} {"med EoD%":>10s}')
        for q in sorted(sub['flow_quad'].unique()):
            for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
                g = sub.loc[(sub['flow_quad'] == q) & (sub['tod'] == tod)]
                if len(g) < 30:
                    continue
                eod = ((g['eod_price'] - g['entry_price']) / g['entry_price'] * 100).median()
                print(f'{q:<14s} {tod:<10s} {len(g):>5d} '
                      f'{g["win"].mean()*100:>8.1f}% {g["big_win"].mean()*100:>6.1f}% '
                      f'{g["realized_multiple_eod"].median():>10.2f} {eod:>+9.1f}%')

        # ============================================================
        # Slice 2: RE-LOAD × TOD
        # ============================================================
        print(f'\n--- {ticker}: RE-LOAD × TOD (RE-LOAD subsets often small) ---')
        print(f'{"RE-LOAD":<10s} {"tod":<10s} {"n":>5s} {"win 2×%":>9s} '
              f'{"big%":>7s} {"med mult":>10s}')
        for tag in [True, False]:
            for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
                g = sub.loc[(sub['reload'] == tag) & (sub['tod'] == tod)]
                if len(g) < 5:
                    continue
                tag_label = 'YES' if tag else 'no'
                print(f'{tag_label:<10s} {tod:<10s} {len(g):>5d} '
                      f'{g["win"].mean()*100:>8.1f}% {g["big_win"].mean()*100:>6.1f}% '
                      f'{g["realized_multiple_eod"].median():>10.2f}')

        # ============================================================
        # Slice 3: entry-price bucket
        # ============================================================
        print(f'\n--- {ticker}: entry-price bucket ---')
        print(f'{"bucket":<18s} {"n":>5s} {"win 2×%":>9s} {"big%":>7s} {"med mult":>10s}')
        for bk in ['cheap_<0.5', 'low_0.5-2', 'mid_2-10', 'high_10-50', 'very_high_50+']:
            g = sub.loc[sub['price_bucket'] == bk]
            if len(g) < 20:
                continue
            print(f'{bk:<18s} {len(g):>5d} {g["win"].mean()*100:>8.1f}% '
                  f'{g["big_win"].mean()*100:>6.1f}% {g["realized_multiple_eod"].median():>10.2f}')

        # ============================================================
        # Slice 4: moneyness × option_type
        # ============================================================
        print(f'\n--- {ticker}: moneyness × option_type ---')
        print(f'{"opt":<6s} {"moneyness":<10s} {"n":>5s} {"win 2×%":>9s} '
              f'{"big%":>7s} {"med mult":>10s} {"med strike%":>13s}')
        for opt in ['call', 'put']:
            for mny in ['OTM', 'ATM', 'ITM']:
                g = sub.loc[(sub['option_type'] == opt) & (sub['moneyness'] == mny)]
                if len(g) < 20:
                    continue
                print(f'{opt:<6s} {mny:<10s} {len(g):>5d} '
                      f'{g["win"].mean()*100:>8.1f}% {g["big_win"].mean()*100:>6.1f}% '
                      f'{g["realized_multiple_eod"].median():>10.2f} '
                      f'{g["strike_pct_of_spot"].median():>+12.2f}%')

        # ============================================================
        # Slice 5: burst-size quintile (bigger burst → better signal?)
        # ============================================================
        print(f'\n--- {ticker}: burst-size quintile (trigger_window_size) ---')
        sub['_q'] = pd.qcut(sub['trigger_window_size'].rank(method='first'), 5,
                            labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        print(f'{"quintile":<10s} {"n":>5s} {"med size":>10s} {"win 2×%":>9s} '
              f'{"big%":>7s} {"med mult":>10s}')
        for qb, g in sub.groupby('_q', observed=True):
            print(f'{qb:<10s} {len(g):>5d} {g["trigger_window_size"].median():>10.0f} '
                  f'{g["win"].mean()*100:>8.1f}% {g["big_win"].mean()*100:>6.1f}% '
                  f'{g["realized_multiple_eod"].median():>10.2f}')

        # ============================================================
        # Slice 6: date concentration
        # ============================================================
        print(f'\n--- {ticker}: per-date win rate (sorted by win count) ---')
        per_day = sub.groupby('date').agg(
            n=('win', 'size'),
            wins=('win', 'sum'),
            bigs=('big_win', 'sum'),
            win_pct=('win', lambda x: round(x.mean() * 100, 1)),
            best_call=('realized_multiple_eod', 'max'),
        ).sort_values('wins', ascending=False)
        print(per_day.to_string())

        # ============================================================
        # Slice 7: cheap-OTM-call combo (the explosive lottery profile)
        # ============================================================
        print(f'\n--- {ticker}: cheap-OTM-call AND-rule combos ---')
        rules = {
            'all calls': sub['option_type'] == 'call',
            'OTM calls': (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM'),
            'OTM calls + entry < $1':
                (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM')
                & (sub['entry_price'] < 1),
            'OTM calls + entry < $0.50':
                (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM')
                & (sub['entry_price'] < 0.50),
            'OTM calls + entry < $1 + AM_open':
                (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM')
                & (sub['entry_price'] < 1) & (sub['tod'] == 'AM_open'),
            'OTM calls + RE-LOAD':
                (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM')
                & sub['reload'],
            'OTM calls + burst Q5':
                (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM')
                & (sub['_q'] == 'Q5'),
            'cheap OTM call AM + burst Q5':
                (sub['option_type'] == 'call') & (sub['moneyness'] == 'OTM')
                & (sub['entry_price'] < 1) & (sub['tod'] == 'AM_open')
                & (sub['_q'] == 'Q5'),
        }
        print(f'{"rule":<55s} {"n":>5s} {"win 2×%":>9s} {"big%":>7s} {"med mult":>10s}')
        for name, mask in rules.items():
            g = sub.loc[mask.fillna(False)]
            if len(g) < 5:
                print(f'{name:<55s} {len(g):>5d}   (skip — <5)')
                continue
            print(f'{name:<55s} {len(g):>5d} '
                  f'{g["win"].mean()*100:>8.1f}% {g["big_win"].mean()*100:>6.1f}% '
                  f'{g["realized_multiple_eod"].median():>10.2f}')

        sub.drop(columns=['_q'], errors='ignore').to_csv(
            OUT / 'outputs' / f'p22_{ticker.lower()}_features.csv', index=False)


if __name__ == '__main__':
    main()
