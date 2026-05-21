#!/usr/bin/env python3
"""Test the BUY-SIDE inverse of the gamma-node rejection thesis.

If wicks THROUGH a +γ node continue rather than revert, the trade is
to BUY momentum, not sell premium:

  - Up-wick through +γ ceiling → buy calls (long call): profit if
    price continues UP.
  - Down-wick through +γ floor → buy puts (long put): profit if
    price continues DOWN.

This is the sign-flip of the v3/v4 analysis. We re-aggregate the v4
CSV without re-running the pipeline.

For each event:
  - long_trade_ret = (end_close - event_close)  for up-wick (long call)
  - long_trade_ret = (event_close - end_close)  for down-wick (long put)

These are EXACTLY the negation of v4's direction-adjusted returns.

Tests:
  1. Headline: event mean long-trade vs control mean (same direction
     sign).
  2. Walk-forward H1 vs H2.
  3. Dose-response by GEX quartile.

Output: docs/tmp/forensic-multi-day/buyside_findings_2026-05-20.md
"""

from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

OUT = Path('docs/tmp/forensic-multi-day')
CSV_PATH = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'buyside_findings_2026-05-20.md'


def report(label, sub, ev_col='long_trade_30m', ct_col='control_long_30m'):
    paired = sub[[ev_col, ct_col]].dropna()
    n = len(paired)
    if n < 5:
        return {'label': label, 'n': n, 'event': np.nan, 'control': np.nan,
                'delta': np.nan, 't': np.nan, 'p': np.nan}
    ev = paired[ev_col].mean()
    ct = paired[ct_col].mean()
    diffs = paired[ev_col] - paired[ct_col]
    t, p = stats.ttest_1samp(diffs, 0)
    return {'label': label, 'n': n, 'event': ev, 'control': ct,
            'delta': ev - ct, 't': t, 'p': p}


def fmt_row(r):
    if np.isnan(r['delta']):
        return f"| {r['label']} | {r['n']} | n/a | n/a | n/a | n/a | n/a |"
    return (f"| {r['label']} | {r['n']} | {r['event']:+.2f} "
            f"| {r['control']:+.2f} | {r['delta']:+.2f} "
            f"| {r['t']:+.2f} | {r['p']:.4f} |")


def main():
    df = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    df['event_date'] = df['event_ts'].dt.date

    # Sign-flip: v4 direction-adjusted ret is mean-reversion centric.
    # Long-call/long-put trade profit = -1 * mean-reversion = +1 *
    # continuation. So long_trade_ret = -ret in v4 conventions.
    for h in (15, 30, 60):
        df[f'long_trade_{h}m'] = -df[f'ret_{h}m']
        df[f'control_long_{h}m'] = -df[f'control_ret_{h}m']

    df['abs_gex'] = df['node_gex'].abs()

    lines = []
    lines.append('# Buy-Side Inverse Hypothesis — Gamma-Node Pierce\n\n')
    lines.append('If wicks through +γ nodes continue rather than revert, '
                 'the trade is to BUY momentum (long call up / long put '
                 'down) instead of sell premium. Direction-adjusted ret in '
                 'v4 was mean-reversion-positive; here we flip the sign so '
                 'positive = continuation = long-trade profit.\n\n')

    print('=' * 76)
    print('Buy-Side Inverse Hypothesis')
    print('=' * 76)

    for direction in ('up', 'down'):
        trade_name = 'long call' if direction == 'up' else 'long put'
        sub_all = df[df['direction'] == direction].copy()
        sub_all['gex_q'] = pd.qcut(sub_all['abs_gex'], q=4,
                                   labels=['Q1', 'Q2', 'Q3', 'Q4'],
                                   duplicates='drop')

        lines.append(f'## {direction.upper()}-wick → {trade_name}\n\n')

        # Headline at each horizon
        lines.append('### Headline by horizon\n\n')
        lines.append('| Horizon | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print(f'\n--- {direction.upper()}-wick → {trade_name} ---')
        print(f'{"Horizon":<10}{"n":>5}{"Event":>10}{"Control":>10}'
              f'{"Δ":>10}{"p":>10}')
        for h in (15, 30, 60):
            r = report(f'+{h}m', sub_all,
                       ev_col=f'long_trade_{h}m',
                       ct_col=f'control_long_{h}m')
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'+{h}m'.ljust(10) +
                      f'{r["n"]:>5}{r["event"]:>+10.2f}'
                      f'{r["control"]:>+10.2f}{r["delta"]:>+10.2f}'
                      f'{r["p"]:>10.4f}')
        lines.append('\n')

        # Walk-forward at +30m
        sorted_sub = sub_all.sort_values('event_ts').reset_index(drop=True)
        split_idx = len(sorted_sub) // 2
        h1 = sorted_sub.iloc[:split_idx]
        h2 = sorted_sub.iloc[split_idx:]
        lines.append('### Walk-forward at +30m\n\n')
        lines.append('| Half | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print(f'\n  Walk-forward +30m:')
        for label, half in (('H1', h1), ('H2', h2), ('FULL', sub_all)):
            r = report(label, half)
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'    {label:<6} n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f} p={r["p"]:.4f}')
        lines.append('\n')

        # Dose-response by GEX quartile at +30m
        lines.append('### Dose-response by |node_gex| quartile at +30m\n\n')
        lines.append('| GEX Q | n | Event | Control | Δ | t | p '
                     '| median |gex| |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|---:|\n')
        print('\n  By |GEX| quartile +30m:')
        for q in ['Q1', 'Q2', 'Q3', 'Q4']:
            sub_q = sub_all[sub_all['gex_q'] == q]
            if sub_q.empty:
                continue
            r = report(q, sub_q)
            med = sub_q['abs_gex'].median()
            line = fmt_row(r).rstrip('|\n') + f' | {med:.1f} |\n'
            lines.append(line)
            if not np.isnan(r['delta']):
                print(f'    {q:<6} n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f} p={r["p"]:.4f} '
                      f'(median |gex|={med:.0f})')
        lines.append('\n')

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
