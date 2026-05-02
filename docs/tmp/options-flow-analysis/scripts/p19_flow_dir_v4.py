"""Phase 19 — flow direction × TOD × RE-LOAD on v4 trigger set.

Re-runs the p11 flow-direction analysis on the v4 set (15,790 v3-style
filtered fires, full session), broken down by:
  - flow_quad: option_type × dominant_side (from trigger_ask_pct)
  - tod: AM_open / MID / LUNCH / PM
  - RE-LOAD tag: entry_drop ≤ -30% AND burst_ratio ≥ 2 (p18 finding)

Methodology vs p11:
  * p11 used burst-minute ask% (1-min before trigger). v4 doesn't carry
    that, so v19 uses trigger_ask_pct (5-min rolling) as the side proxy.
    Thresholds adjusted to match: ask ≥ 0.60 (vs p11's 0.60 volume-weighted),
    ≤ 0.40 = bid, in between = mixed.
  * "win" = realized_multiple_eod ≥ 2.0 (consistent with p17/p18)
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

    # v3-style filter
    sub = df.loc[
        (df['dte'] == 0)
        & (df['underlying_symbol'].isin(V3))
        & (df['trigger_ask_pct'] >= 0.52)
    ].copy()
    sub = sub.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)

    # Add prev-fire features for RE-LOAD
    grp = sub.groupby(['date', 'option_chain_id'])
    sub['prev_window_size'] = grp['trigger_window_size'].shift(1)
    sub['prev_entry_price'] = grp['entry_price'].shift(1)
    sub['burst_ratio_vs_prev'] = sub['trigger_window_size'] / sub['prev_window_size']
    sub['entry_drop_pct_vs_prev'] = (
        (sub['entry_price'] - sub['prev_entry_price']) / sub['prev_entry_price'] * 100
    )

    # RE-LOAD tag
    sub['reload'] = (
        (sub['burst_ratio_vs_prev'] >= 2)
        & (sub['entry_drop_pct_vs_prev'] <= -30)
    ).fillna(False)

    # TOD
    sub['hour'] = sub['trigger_time_ct'].dt.hour + sub['trigger_time_ct'].dt.minute / 60
    sub['tod'] = sub['hour'].apply(tod_bucket)

    # Side classification (matched to p11 flow_quad scheme)
    def side(p):
        if p >= 0.60:
            return 'ask'
        if p <= 0.40:
            return 'bid'
        return 'mixed'
    sub['dominant_side'] = sub['trigger_ask_pct'].apply(side)
    sub['flow_quad'] = sub['option_type'] + '_' + sub['dominant_side']

    sub['win'] = (sub['realized_multiple_eod'] >= 2.0).astype(int)
    sub['big_win'] = (sub['realized_multiple_eod'] >= 5.0).astype(int)
    sub['win_30'] = (sub['realized_multiple_30'] >= 2.0).astype(int)

    print(f'After v3-style filter: {len(sub):,} fires')
    print(f'  RE-LOAD tagged:     {sub["reload"].sum():,} ({sub["reload"].mean()*100:.1f}%)')
    print(f'  flow_quad split:')
    print(sub['flow_quad'].value_counts().to_string())
    print(f'  tod split:')
    print(sub['tod'].value_counts().to_string())

    # ============================================================
    # Flow quad × TOD
    # ============================================================
    print('\n' + '=' * 95)
    print('=== flow_quad × TOD (subsets ≥ 30) ===')
    print('=' * 95)
    print(f'{"flow_quad":<14s} {"tod":<10s} {"n":>5s} {"win 2×%":>9s} '
          f'{"big%":>7s} {"30m 2×%":>9s} {"med peak":>10s} {"med EoD%":>10s}')
    for q in sorted(sub['flow_quad'].unique()):
        for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
            g = sub.loc[(sub['flow_quad'] == q) & (sub['tod'] == tod)]
            if len(g) < 30:
                continue
            print(f'{q:<14s} {tod:<10s} {len(g):>5d} '
                  f'{g["win"].mean()*100:>8.1f}% '
                  f'{g["big_win"].mean()*100:>6.1f}% '
                  f'{g["win_30"].mean()*100:>8.1f}% '
                  f'{g["realized_multiple_eod"].median():>10.2f} '
                  f'{((g["eod_price"]-g["entry_price"])/g["entry_price"]*100).median():>+9.1f}%')

    # ============================================================
    # RE-LOAD vs no RE-LOAD (overall + by TOD)
    # ============================================================
    print('\n' + '=' * 95)
    print('=== RE-LOAD vs non-RE-LOAD (within v3-style v4) ===')
    print('=' * 95)
    print(f'{"":<28s} {"n":>6s} {"win 2×%":>9s} {"big%":>7s} {"30m 2×%":>9s} {"med mult":>10s}')
    for tag, g in [
        ('all v3-style v4', sub),
        ('  RE-LOAD',       sub.loc[sub['reload']]),
        ('  not RE-LOAD',   sub.loc[~sub['reload']]),
        ('  fire #1 only',  sub.loc[sub['alert_seq'] == 1]),
        ('  late (seq≥2) only', sub.loc[sub['alert_seq'] >= 2]),
        ('  late + RE-LOAD',  sub.loc[(sub['alert_seq'] >= 2) & sub['reload']]),
        ('  late, no RE-LOAD', sub.loc[(sub['alert_seq'] >= 2) & ~sub['reload']]),
    ]:
        if len(g) == 0:
            continue
        print(f'{tag:<28s} {len(g):>6d} '
              f'{g["win"].mean()*100:>8.1f}% '
              f'{g["big_win"].mean()*100:>6.1f}% '
              f'{g["win_30"].mean()*100:>8.1f}% '
              f'{g["realized_multiple_eod"].median():>10.2f}')

    print('\n--- RE-LOAD × TOD breakdown ---')
    print(f'{"reload":<10s} {"tod":<10s} {"n":>5s} {"win 2×%":>9s} '
          f'{"big%":>7s} {"30m 2×%":>9s} {"med mult":>10s}')
    for tag in [True, False]:
        for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
            g = sub.loc[(sub['reload'] == tag) & (sub['tod'] == tod)]
            if len(g) < 30:
                continue
            print(f'{"YES" if tag else "no":<10s} {tod:<10s} {len(g):>5d} '
                  f'{g["win"].mean()*100:>8.1f}% '
                  f'{g["big_win"].mean()*100:>6.1f}% '
                  f'{g["win_30"].mean()*100:>8.1f}% '
                  f'{g["realized_multiple_eod"].median():>10.2f}')

    # ============================================================
    # RE-LOAD × flow_quad (the gold-mine query)
    # ============================================================
    print('\n' + '=' * 95)
    print('=== RE-LOAD × flow_quad (which side+RE-LOAD combo is the lottery profile?) ===')
    print('=' * 95)
    print(f'{"flow_quad":<14s} {"reload":<10s} {"n":>5s} {"win 2×%":>9s} '
          f'{"big%":>7s} {"med mult":>10s}')
    for q in sorted(sub['flow_quad'].unique()):
        for tag in [True, False]:
            g = sub.loc[(sub['flow_quad'] == q) & (sub['reload'] == tag)]
            if len(g) < 20:
                continue
            print(f'{q:<14s} {"YES" if tag else "no":<10s} {len(g):>5d} '
                  f'{g["win"].mean()*100:>8.1f}% '
                  f'{g["big_win"].mean()*100:>6.1f}% '
                  f'{g["realized_multiple_eod"].median():>10.2f}')

    sub.to_csv(OUT / 'outputs' / 'p19_v4_flowdir_reload.csv', index=False)
    print(f'\nSaved → outputs/p19_v4_flowdir_reload.csv')


if __name__ == '__main__':
    main()
