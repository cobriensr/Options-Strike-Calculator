#!/usr/bin/env python3
"""Walk-forward validation of the down-wick gamma-node rejection signal.

Reads the v4 (event, node, control, IV) CSV from
docs/tmp/forensic-multi-day/, splits events into two date-halves by
event count (equal-n splits, not equal-time), and recomputes:

  1. Down-wick headline (event mean +30m, control mean, Δ, p).
  2. Down-wick × GEX quartile (Q1+Q2 is where v3 said the edge lives).
  3. Combined Q1+Q2 "pocket" cell — the actual trade signal.

Output: docs/tmp/forensic-multi-day/walkforward_findings_2026-05-20.md
plus stdout summary.

Pass criterion (subjective, for go/no-go on detector build):
- The combined Q1+Q2 Δ must be positive AND p < 0.10 in BOTH halves.
- If only one half clears, the signal is unstable; pause and investigate
  before shipping.
"""

from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

OUT = Path('docs/tmp/forensic-multi-day')
CSV_PATH = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'walkforward_findings_2026-05-20.md'


def report(label, sub):
    """Compute paired event-vs-control stats at +30m."""
    paired = sub[['ret_30m', 'control_ret_30m']].dropna()
    n = len(paired)
    if n < 5:
        return {'label': label, 'n': n, 'event': np.nan, 'control': np.nan,
                'delta': np.nan, 't': np.nan, 'p': np.nan}
    ev = paired['ret_30m'].mean()
    ct = paired['control_ret_30m'].mean()
    delta = ev - ct
    diffs = paired['ret_30m'] - paired['control_ret_30m']
    t, p = stats.ttest_1samp(diffs, 0)
    return {'label': label, 'n': n, 'event': ev, 'control': ct,
            'delta': delta, 't': t, 'p': p}


def fmt_row(r):
    if np.isnan(r['delta']):
        return f"| {r['label']} | {r['n']} | n/a | n/a | n/a | n/a | n/a |"
    return (f"| {r['label']} | {r['n']} | {r['event']:+.2f} "
            f"| {r['control']:+.2f} | {r['delta']:+.2f} "
            f"| {r['t']:+.2f} | {r['p']:.4f} |")


def main():
    df = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    df['event_date'] = df['event_ts'].dt.date

    down = df[df['direction'] == 'down'].copy()
    down['abs_gex'] = down['node_gex'].abs()
    down['gex_q'] = pd.qcut(down['abs_gex'], q=4,
                            labels=['Q1', 'Q2', 'Q3', 'Q4'],
                            duplicates='drop')

    # Equal-n split by event order (not equal-time): rank events by date,
    # split at the median rank. Within a date the order is arbitrary but
    # we don't care since each event is independent.
    down_sorted = down.sort_values('event_ts').reset_index(drop=True)
    midpoint = len(down_sorted) // 2
    split_idx = midpoint
    split_date = down_sorted.iloc[split_idx]['event_date']
    h1 = down_sorted.iloc[:split_idx].copy()
    h2 = down_sorted.iloc[split_idx:].copy()

    print(f'Total down-wick events: {len(down):,}')
    print(f'Date range: {down["event_date"].min()} → '
          f'{down["event_date"].max()}')
    print(f'Split at event #{split_idx} (date ~ {split_date})')
    print(f'  H1: {h1["event_date"].min()} → {h1["event_date"].max()} '
          f'(n={len(h1)})')
    print(f'  H2: {h2["event_date"].min()} → {h2["event_date"].max()} '
          f'(n={len(h2)})')

    rows_md = ['# Walk-Forward Validation — Gamma-Node Rejection Down-Wick\n']
    rows_md.append('## Split design\n')
    rows_md.append(f'- Equal-n split on event order. Total down-wick rows: '
                   f'{len(down)}\n')
    rows_md.append(f'- H1: {h1["event_date"].min()} → '
                   f'{h1["event_date"].max()} (n={len(h1)})\n')
    rows_md.append(f'- H2: {h2["event_date"].min()} → '
                   f'{h2["event_date"].max()} (n={len(h2)})\n')
    rows_md.append('- Pass criterion: combined Q1+Q2 pocket must have '
                   'positive Δ AND p<0.10 in BOTH halves.\n\n')

    sections = [
        ('Headline (all down-wick)', None),
        ('Q1 (small walls, smallest |gex|)', 'Q1'),
        ('Q2', 'Q2'),
        ('Q3', 'Q3'),
        ('Q4 (huge walls)', 'Q4'),
        ('Pocket: Q1+Q2 combined', 'Q1+Q2'),
    ]

    print('\n=== Walk-Forward Results ===')
    print(f"{'Cell':<32} {'H1 Δ/p':>14} {'H2 Δ/p':>14} {'FULL Δ/p':>14}")
    print('-' * 80)

    for label, q_filter in sections:
        if q_filter is None:
            sub_h1, sub_h2, sub_full = h1, h2, down
        elif q_filter == 'Q1+Q2':
            sub_h1 = h1[h1['gex_q'].isin(['Q1', 'Q2'])]
            sub_h2 = h2[h2['gex_q'].isin(['Q1', 'Q2'])]
            sub_full = down[down['gex_q'].isin(['Q1', 'Q2'])]
        else:
            sub_h1 = h1[h1['gex_q'] == q_filter]
            sub_h2 = h2[h2['gex_q'] == q_filter]
            sub_full = down[down['gex_q'] == q_filter]

        r_h1 = report('H1', sub_h1)
        r_h2 = report('H2', sub_h2)
        r_full = report('FULL', sub_full)

        def cell(r):
            if np.isnan(r['delta']):
                return f"n={r['n']} sparse"
            return f"{r['delta']:+.2f}/p={r['p']:.3f} (n={r['n']})"

        print(f'{label:<32} {cell(r_h1):>14} {cell(r_h2):>14} {cell(r_full):>14}')

        # Markdown section
        rows_md.append(f'## {label}\n\n')
        rows_md.append('| Half | n | Event +30m | Control +30m | Δ | t | p |\n')
        rows_md.append('|---|---:|---:|---:|---:|---:|---:|\n')
        rows_md.append(fmt_row(r_h1) + '\n')
        rows_md.append(fmt_row(r_h2) + '\n')
        rows_md.append(fmt_row(r_full) + '\n\n')

    # Pass/fail verdict
    pocket_h1 = report('H1',
                       h1[h1['gex_q'].isin(['Q1', 'Q2'])])
    pocket_h2 = report('H2',
                       h2[h2['gex_q'].isin(['Q1', 'Q2'])])
    h1_pass = (not np.isnan(pocket_h1['delta'])
               and pocket_h1['delta'] > 0
               and pocket_h1['p'] < 0.10)
    h2_pass = (not np.isnan(pocket_h2['delta'])
               and pocket_h2['delta'] > 0
               and pocket_h2['p'] < 0.10)
    verdict = 'PASS' if (h1_pass and h2_pass) else 'FAIL'
    rows_md.append(f'## Verdict: **{verdict}**\n\n')
    rows_md.append(f'- H1 Q1+Q2 pocket: Δ={pocket_h1["delta"]:+.2f} '
                   f'p={pocket_h1["p"]:.4f} → '
                   f'{"PASS" if h1_pass else "FAIL"}\n')
    rows_md.append(f'- H2 Q1+Q2 pocket: Δ={pocket_h2["delta"]:+.2f} '
                   f'p={pocket_h2["p"]:.4f} → '
                   f'{"PASS" if h2_pass else "FAIL"}\n')
    rows_md.append('\nCriterion: positive Δ AND p<0.10 in BOTH halves.\n')

    MD_PATH.write_text(''.join(rows_md))
    print(f'\nVerdict: {verdict}')
    print(f'Wrote findings → {MD_PATH}')


if __name__ == '__main__':
    main()
