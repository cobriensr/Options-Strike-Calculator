"""Phase 17 — apples-to-apples: apply v3-style filters to v4 trigger set.

v4 is unfiltered (all chains, all DTEs ≤7, full session). v3 was a curated
subset (34 tickers, dte=0, AM/lunch window, ask% ≥ 0.52, first-fire-only).

This script applies the v3 filters EXCEPT the time window and EXCEPT the
first-fire restriction, so we can answer:

   "If we keep the v3 quality criteria but allow multiple fires per chain
    and don't drop afternoon entries, how does the win rate compare?"

Definitions (no silent metric drift):
  * v4_v3style = v4 fires where dte=0 AND ticker in V3 list AND
    trigger_ask_pct ≥ 0.52 (matches v3 SPEC ask% threshold)
  * "win" = future_max_to_eod / entry_price >= 1.5  (a 50% gain peak)
  * "big_win" = >= 2.0× (double)
  * "huge_win" = >= 5.0× (5x explosive)
  * Comparing to v3 numbers from p3_triggers.csv

Splits:
  - by alert_seq (1, 2, 3, 4+)
  - by tod (AM_open=8:30-9:30, MID=9:30-11:30, LUNCH=11:30-12:30, PM=12:30-15:00)
  - cross-tab alert_seq × tod for the most useful rule
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1]
V3 = ['USAR', 'WMT', 'STX', 'SOUN', 'RIVN', 'TSM', 'SNDK', 'XOM', 'WDC', 'SQQQ',
      'NDXP', 'USO', 'TNA', 'RDDT', 'SMCI', 'TSLL', 'SNOW', 'TEAM', 'RKLB', 'SOFI',
      'RUTW', 'TSLA', 'SOXS', 'WULF', 'SLV', 'SMH', 'UBER', 'MSTR', 'TQQQ', 'RIOT',
      'SOXL', 'UNH', 'QQQ', 'RBLX']


def tod_bucket(h: float) -> str:
    if h < 9.5:
        return 'AM_open'
    if h < 11.5:
        return 'MID'
    if h < 12.5:
        return 'LUNCH'
    return 'PM'


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v4 fires')

    # Apply v3-style filters (except time-window, except first-fire)
    sub = df.loc[
        (df['dte'] == 0)
        & (df['underlying_symbol'].isin(V3))
        & (df['trigger_ask_pct'] >= 0.52)
    ].copy()
    sub['hour'] = sub['trigger_time_ct'].dt.hour + sub['trigger_time_ct'].dt.minute / 60
    sub['tod'] = sub['hour'].apply(tod_bucket)
    sub['win_15'] = (sub['realized_multiple_eod'] >= 1.5).astype(int)
    sub['win_2x'] = (sub['realized_multiple_eod'] >= 2.0).astype(int)
    sub['win_5x'] = (sub['realized_multiple_eod'] >= 5.0).astype(int)
    sub['win_30_2x'] = (sub['realized_multiple_30'] >= 2.0).astype(int)
    sub['seq_bucket'] = sub['alert_seq'].clip(upper=4)

    print(f'After v3-style filter: {len(sub):,} fires across '
          f'{sub.groupby(["date", "option_chain_id"]).ngroups:,} chain-days')

    # Compare to v3 raw — load p3 and apply same outcome metric
    p3 = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct'])
    p3v3 = p3.loc[(p3['dte'] == 0) & p3['underlying_symbol'].isin(V3) &
                  (p3['trigger_ask_pct'] >= 0.52)].copy()
    p3v3['win_15'] = (p3v3['realized_multiple'] >= 1.5).astype(int)
    p3v3['win_2x'] = (p3v3['realized_multiple'] >= 2.0).astype(int)
    p3v3['win_5x'] = (p3v3['realized_multiple'] >= 5.0).astype(int)
    print(f'\nv3 (first-fire-only, same filter): {len(p3v3):,} fires')
    print(f'  win 1.5×%: {p3v3["win_15"].mean()*100:5.1f}%')
    print(f'  win 2×%:   {p3v3["win_2x"].mean()*100:5.1f}%')
    print(f'  win 5×%:   {p3v3["win_5x"].mean()*100:5.1f}%')

    # ============================================================
    # Overall v4 (v3-style) vs v3
    # ============================================================
    print('\n' + '=' * 80)
    print('=== HEAD-TO-HEAD: v3 (1-fire/chain) vs v4_v3style (all fires) ===')
    print('=' * 80)
    print(f'{"":<24s} {"n":>7s} {"win 1.5×%":>11s} {"win 2×%":>10s} {"win 5×%":>10s}')
    print(f'{"v3 first-fire":<24s} {len(p3v3):>7d} {p3v3["win_15"].mean()*100:>10.1f}% '
          f'{p3v3["win_2x"].mean()*100:>9.1f}% {p3v3["win_5x"].mean()*100:>9.1f}%')
    print(f'{"v4 all fires (v3-flt)":<24s} {len(sub):>7d} {sub["win_15"].mean()*100:>10.1f}% '
          f'{sub["win_2x"].mean()*100:>9.1f}% {sub["win_5x"].mean()*100:>9.1f}%')
    fire1 = sub.loc[sub['alert_seq'] == 1]
    print(f'{"  (v4 fire #1 only)":<24s} {len(fire1):>7d} {fire1["win_15"].mean()*100:>10.1f}% '
          f'{fire1["win_2x"].mean()*100:>9.1f}% {fire1["win_5x"].mean()*100:>9.1f}%')

    # ============================================================
    # By alert_seq within v3-style filtered set
    # ============================================================
    print('\n' + '=' * 80)
    print('=== alert_seq × win rate (within v3-style filtered set) ===')
    print('=' * 80)
    print(f'{"alert_seq":<10s} {"n":>6s} {"win 1.5×%":>11s} {"win 2×%":>10s} '
          f'{"win 5×%":>10s} {"30min 2×%":>11s}')
    for s, g in sub.groupby('seq_bucket'):
        label = f'≥{int(s)}' if s == 4 else str(int(s))
        print(f'{label:<10s} {len(g):>6d} {g["win_15"].mean()*100:>10.1f}% '
              f'{g["win_2x"].mean()*100:>9.1f}% {g["win_5x"].mean()*100:>9.1f}% '
              f'{g["win_30_2x"].mean()*100:>10.1f}%')

    # ============================================================
    # By tod (the previously hidden afternoon!)
    # ============================================================
    print('\n' + '=' * 80)
    print('=== TOD × win rate (this is what the AM/lunch filter was hiding) ===')
    print('=' * 80)
    print(f'{"tod":<12s} {"n":>6s} {"win 1.5×%":>11s} {"win 2×%":>10s} '
          f'{"win 5×%":>10s} {"30min 2×%":>11s}')
    for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
        g = sub.loc[sub['tod'] == tod]
        if len(g) < 30:
            continue
        print(f'{tod:<12s} {len(g):>6d} {g["win_15"].mean()*100:>10.1f}% '
              f'{g["win_2x"].mean()*100:>9.1f}% {g["win_5x"].mean()*100:>9.1f}% '
              f'{g["win_30_2x"].mean()*100:>10.1f}%')

    # ============================================================
    # alert_seq × tod cross-tab (find the actionable rule)
    # ============================================================
    print('\n' + '=' * 80)
    print('=== alert_seq × tod cross-tab (subsets ≥ 30) ===')
    print('=' * 80)
    print(f'{"alert_seq":<10s} {"tod":<10s} {"n":>6s} {"win 1.5×%":>11s} '
          f'{"win 2×%":>10s} {"win 5×%":>10s} {"30min 2×%":>11s}')
    for s in [1, 2, 3, 4]:
        for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
            g = sub.loc[(sub['seq_bucket'] == s) & (sub['tod'] == tod)]
            if len(g) < 30:
                continue
            label = f'≥{s}' if s == 4 else str(s)
            print(f'{label:<10s} {tod:<10s} {len(g):>6d} '
                  f'{g["win_15"].mean()*100:>10.1f}% '
                  f'{g["win_2x"].mean()*100:>9.1f}% {g["win_5x"].mean()*100:>9.1f}% '
                  f'{g["win_30_2x"].mean()*100:>10.1f}%')

    sub.to_csv(OUT / 'outputs' / 'p17_v4_v3style.csv', index=False)
    print(f'\nSaved → outputs/p17_v4_v3style.csv (v3-filtered v4 with seq+tod)')


if __name__ == '__main__':
    main()
