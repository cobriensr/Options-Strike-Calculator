"""Phase 18 — what discriminates a winning LATE fire from a dud late fire?

Hypothesis from the user (SNDK fire #4 at 14:48 CT):
  A late fire is a winner when it has:
    (a) cheap entry price relative to the chain's earlier fires
    (b) burst volume bigger than the prior fire on the same chain
    (c) a quiet period before it (large minutes_since_prev_fire)
    (d) high ask% (one-sided, fresh accumulation)

Test: among fires with alert_seq >= 2, compare features of WINNERS
(realized_multiple_eod >= 2) vs DUDS (< 2). Quintile sweep on each
candidate feature; specifically test the burst-vs-prev-burst ratio.

Definitions (no silent metric drift):
  * "Late fire" = alert_seq >= 2 on the same (date, chain)
  * "Winner" = realized_multiple_eod >= 2.0
  * "Big winner" = realized_multiple_eod >= 5.0
  * burst_ratio_vs_prev = trigger_window_size / previous fire's trigger_window_size
  * entry_drop_pct_vs_prev = (entry_price - prev_entry_price) / prev_entry_price * 100
    (negative = entry got cheaper since last fire — the SNDK pattern)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v4 fires')
    df = df.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)

    # Compute prev-fire features per chain
    grp = df.groupby(['date', 'option_chain_id'])
    df['prev_window_size'] = grp['trigger_window_size'].shift(1)
    df['prev_entry_price'] = grp['entry_price'].shift(1)
    df['prev_ask_pct'] = grp['trigger_ask_pct'].shift(1)
    df['burst_ratio_vs_prev'] = df['trigger_window_size'] / df['prev_window_size']
    df['entry_drop_pct_vs_prev'] = (
        (df['entry_price'] - df['prev_entry_price']) / df['prev_entry_price'] * 100
    )
    df['win'] = (df['realized_multiple_eod'] >= 2.0).astype(int)
    df['big_win'] = (df['realized_multiple_eod'] >= 5.0).astype(int)

    # Subset to late fires (seq >= 2)
    late = df.loc[df['alert_seq'] >= 2].copy()
    print(f'Late fires (alert_seq ≥ 2): {len(late):,}')
    print(f'  winners (≥2× EoD):    {late["win"].sum():,} ({late["win"].mean()*100:.1f}%)')
    print(f'  big winners (≥5×):    {late["big_win"].sum():,} ({late["big_win"].mean()*100:.1f}%)')

    # ============================================================
    # Feature comparison: WINNERS vs DUDS among late fires
    # ============================================================
    print('\n' + '=' * 90)
    print('=== Feature medians: late fire WINNERS vs DUDS ===')
    print('=' * 90)
    feat_cols = [
        'entry_price', 'trigger_window_size', 'prev_window_size',
        'burst_ratio_vs_prev', 'entry_drop_pct_vs_prev',
        'minutes_since_prev_fire', 'trigger_ask_pct',
        'trigger_vol_to_oi_window', 'trigger_vol_to_oi_cum',
        'trigger_iv', 'trigger_delta', 'open_interest', 'alert_seq',
    ]
    win = late.loc[late['win'] == 1]
    dud = late.loc[late['win'] == 0]
    print(f'WIN n={len(win):,}, DUD n={len(dud):,}')
    print(f'\n{"feature":<28s} {"WIN median":>14s} {"DUD median":>14s} {"WIN-DUD ratio":>16s}')
    for c in feat_cols:
        if c not in late.columns:
            continue
        w = win[c].median()
        d = dud[c].median()
        ratio = (w / d) if (d not in (0, np.nan) and not pd.isna(d) and d != 0) else np.nan
        print(f'{c:<28s} {w:>14.4f} {d:>14.4f} {ratio:>16.2f}')

    # ============================================================
    # Univariate quintile sweeps
    # ============================================================
    print('\n' + '=' * 90)
    print('=== Univariate quintile sweeps (within late fires only) ===')
    print('=' * 90)
    for c in ['burst_ratio_vs_prev', 'entry_drop_pct_vs_prev',
              'minutes_since_prev_fire', 'entry_price',
              'trigger_vol_to_oi_window', 'trigger_ask_pct',
              'trigger_delta']:
        if c not in late.columns:
            continue
        s = late.dropna(subset=[c]).copy()
        if len(s) < 100:
            continue
        try:
            s['_q'] = pd.qcut(s[c].rank(method='first'), 5,
                              labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            continue
        agg = s.groupby('_q', observed=True).agg(
            n=(c, 'size'),
            median_thresh=(c, 'median'),
            win_pct=('win', lambda x: x.mean() * 100),
            big_win_pct=('big_win', lambda x: x.mean() * 100),
            med_mult=('realized_multiple_eod', 'median'),
        ).round(3)
        print(f'\n{c}:')
        print(agg.to_string())

    # ============================================================
    # AND-rule combinations testing user hypothesis
    # ============================================================
    print('\n' + '=' * 90)
    print('=== AND-rule: user hypothesis (cheap + bigger burst + quiet period) ===')
    print('=' * 90)
    print(f'\nBaseline late-fire win rate: {late["win"].mean()*100:.1f}% (n={len(late):,})')
    print()

    rules = {
        'burst_ratio >= 2 (new burst > 2× prior)':
            late['burst_ratio_vs_prev'] >= 2,
        'entry dropped ≥30% vs prev fire':
            late['entry_drop_pct_vs_prev'] <= -30,
        'minutes_since_prev >= 30 (quiet period)':
            late['minutes_since_prev_fire'] >= 30,
        'entry < $1':
            late['entry_price'] < 1,
        'ask% >= 0.60':
            late['trigger_ask_pct'] >= 0.60,
        'window vol/OI >= 0.5 (huge burst rel. OI)':
            late['trigger_vol_to_oi_window'] >= 0.5,
    }

    print(f'{"rule":<55s} {"n":>7s} {"win%":>7s} {"big%":>7s} {"med mult":>10s}')
    for name, mask in rules.items():
        g = late.loc[mask.fillna(False)]
        if len(g) == 0:
            continue
        print(f'{name:<55s} {len(g):>7d} {g["win"].mean()*100:>6.1f}% '
              f'{g["big_win"].mean()*100:>6.1f}% {g["realized_multiple_eod"].median():>10.2f}')

    print('\n--- AND combos of the above (only show those with ≥30 trades) ---')
    combos = [
        ('burst_ratio≥2 AND quiet≥30min',
         (late['burst_ratio_vs_prev'] >= 2) & (late['minutes_since_prev_fire'] >= 30)),
        ('entry_drop≤-30 AND quiet≥30',
         (late['entry_drop_pct_vs_prev'] <= -30) & (late['minutes_since_prev_fire'] >= 30)),
        ('burst≥2 AND entry_drop≤-30',
         (late['burst_ratio_vs_prev'] >= 2) & (late['entry_drop_pct_vs_prev'] <= -30)),
        ('burst≥2 AND ask≥0.60',
         (late['burst_ratio_vs_prev'] >= 2) & (late['trigger_ask_pct'] >= 0.60)),
        ('burst≥2 AND window_vol/OI≥0.5',
         (late['burst_ratio_vs_prev'] >= 2) & (late['trigger_vol_to_oi_window'] >= 0.5)),
        ('SNDK#4 profile: burst≥2 AND quiet≥30 AND ask≥0.60 AND entry<$5',
         (late['burst_ratio_vs_prev'] >= 2) & (late['minutes_since_prev_fire'] >= 30)
         & (late['trigger_ask_pct'] >= 0.60) & (late['entry_price'] < 5)),
        ('Tighter SNDK profile: burst≥3 AND quiet≥30 AND ask≥0.60 AND entry<$2',
         (late['burst_ratio_vs_prev'] >= 3) & (late['minutes_since_prev_fire'] >= 30)
         & (late['trigger_ask_pct'] >= 0.60) & (late['entry_price'] < 2)),
    ]
    print(f'{"combo":<70s} {"n":>6s} {"win%":>7s} {"big%":>7s} {"med mult":>10s}')
    for name, mask in combos:
        g = late.loc[mask.fillna(False)]
        if len(g) < 30:
            print(f'{name:<70s} {len(g):>6d}   (skip — <30)')
            continue
        print(f'{name:<70s} {len(g):>6d} {g["win"].mean()*100:>6.1f}% '
              f'{g["big_win"].mean()*100:>6.1f}% {g["realized_multiple_eod"].median():>10.2f}')

    # ============================================================
    # Verify SNDK fire #4 falls in the "winning" rule region
    # ============================================================
    print('\n' + '=' * 90)
    print('=== SNDK 1175C 5/1 fire #4 sanity check (the 14:48 CT $1.30→$14.25 trade) ===')
    print('=' * 90)
    sndk4 = late.loc[(late['underlying_symbol'] == 'SNDK')
                       & (late['date'].astype(str) == '2026-05-01')
                       & (late['strike'] == 1175)
                       & (late['option_type'] == 'call')
                       & (late['alert_seq'] == 4)]
    if len(sndk4):
        cols = ['alert_seq', 'entry_price', 'realized_multiple_eod',
                'burst_ratio_vs_prev', 'entry_drop_pct_vs_prev',
                'minutes_since_prev_fire', 'trigger_ask_pct',
                'trigger_vol_to_oi_window', 'trigger_window_size',
                'prev_window_size']
        print(sndk4[cols].to_string(index=False))

    df.to_csv(OUT / 'outputs' / 'p18_late_fire_features.csv', index=False)
    print(f'\nSaved → outputs/p18_late_fire_features.csv')


if __name__ == '__main__':
    main()
