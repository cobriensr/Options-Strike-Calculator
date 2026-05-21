#!/usr/bin/env python3
"""Diagnose the H1 vs H2 walk-forward failure for the down-wick signal.

Reads the v4 (event, node, control) CSV and answers:

  1. Is H1's +9.81 pt Q1+Q2 edge driven by a few big winners (outliers)
     or a broad uplift across most events?
  2. What does the per-event ret_30m distribution look like in each half?
  3. Are H1 winners clustered on a few specific dates?
  4. What was the SPX day-over-day change distribution in each half?

If H1's edge is concentrated in <10% of events on a few specific days,
that's a sample artifact — move on. If it's a broad shift (median +3 pts,
mean +9), it's a regime effect worth investigating with VIX segmentation.

Output: docs/tmp/forensic-multi-day/diagnose_walkforward_findings.md
"""

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path('docs/tmp/forensic-multi-day')
CSV_PATH = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'diagnose_walkforward_findings.md'


def percentiles(s, pcts=(5, 10, 25, 50, 75, 90, 95)):
    return {f'p{p}': float(np.percentile(s.dropna(), p)) for p in pcts}


def per_event_summary(label, sub):
    valid = sub[['ret_30m', 'control_ret_30m']].dropna()
    if len(valid) == 0:
        return None
    diff = valid['ret_30m'] - valid['control_ret_30m']
    return {
        'label': label,
        'n': len(valid),
        'event_mean': valid['ret_30m'].mean(),
        'event_median': valid['ret_30m'].median(),
        'control_mean': valid['control_ret_30m'].mean(),
        'control_median': valid['control_ret_30m'].median(),
        'diff_mean': diff.mean(),
        'diff_median': diff.median(),
        'pct_positive': (diff > 0).mean(),
        'event_pcts': percentiles(valid['ret_30m']),
        'diff_pcts': percentiles(diff),
    }


def main():
    df = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    df['event_date'] = df['event_ts'].dt.date

    down = df[df['direction'] == 'down'].copy()
    down['abs_gex'] = down['node_gex'].abs()
    down['gex_q'] = pd.qcut(down['abs_gex'], q=4,
                            labels=['Q1', 'Q2', 'Q3', 'Q4'],
                            duplicates='drop')
    pocket = down[down['gex_q'].isin(['Q1', 'Q2'])].copy()

    # Equal-n event split (same as walkforward script)
    sorted_pocket = pocket.sort_values('event_ts').reset_index(drop=True)
    split_idx = len(sorted_pocket) // 2
    split_date = sorted_pocket.iloc[split_idx]['event_date']
    h1 = sorted_pocket.iloc[:split_idx].copy()
    h2 = sorted_pocket.iloc[split_idx:].copy()

    lines = []
    lines.append('# Walk-Forward Failure Diagnosis — Down-Wick Q1+Q2 Pocket\n\n')
    lines.append(f'Split at event #{split_idx} (date ≈ {split_date}). '
                 f'H1 n={len(h1)}, H2 n={len(h2)}.\n\n')

    # Per-half summary
    lines.append('## Per-half summary\n\n')
    for label, sub in (('H1', h1), ('H2', h2)):
        s = per_event_summary(label, sub)
        lines.append(f'### {label} (n={s["n"]})\n\n')
        lines.append(f'- **Mean event ret_30m:** {s["event_mean"]:+.2f} pts\n')
        lines.append(f'- **Median event ret_30m:** '
                     f'{s["event_median"]:+.2f} pts\n')
        lines.append(f'- Mean control: {s["control_mean"]:+.2f} pts, '
                     f'median: {s["control_median"]:+.2f}\n')
        lines.append(f'- **Mean (event − control):** '
                     f'{s["diff_mean"]:+.2f} pts\n')
        lines.append(f'- **Median (event − control):** '
                     f'{s["diff_median"]:+.2f} pts\n')
        lines.append(f'- % of events where event > control: '
                     f'{s["pct_positive"]:.1%}\n')
        lines.append('- Event ret_30m percentiles:\n')
        for p, v in s['event_pcts'].items():
            lines.append(f'  - {p}: {v:+.2f}\n')
        lines.append('- (Event − control) percentiles:\n')
        for p, v in s['diff_pcts'].items():
            lines.append(f'  - {p}: {v:+.2f}\n')
        lines.append('\n')

    # Top-10 events per half
    lines.append('## Top-10 events per half (by event ret_30m)\n\n')
    for label, sub in (('H1', h1), ('H2', h2)):
        top10 = (sub.dropna(subset=['ret_30m'])
                    .sort_values('ret_30m', ascending=False)
                    .head(10)[['event_ts', 'node_strike', 'node_gex',
                               'bar_range', 'ret_30m', 'control_ret_30m']])
        lines.append(f'### {label} Top-10\n\n')
        lines.append('```\n' + top10.to_string(index=False) + '\n```\n\n')

    # Daily aggregation: how concentrated is the edge?
    lines.append('## Daily concentration\n\n')
    lines.append('For each half, how many distinct dates had ≥1 event, '
                 'and what % of total event-mean comes from the top 5 dates?\n\n')
    for label, sub in (('H1', h1), ('H2', h2)):
        sub_v = sub.dropna(subset=['ret_30m'])
        date_means = sub_v.groupby('event_date')['ret_30m'].mean()
        date_counts = sub_v.groupby('event_date')['ret_30m'].count()
        date_sums = sub_v.groupby('event_date')['ret_30m'].sum()
        n_dates = len(date_means)
        total_sum = date_sums.sum()
        top5_sum = date_sums.nlargest(5).sum()
        lines.append(f'### {label}\n')
        lines.append(f'- Distinct dates: {n_dates}\n')
        lines.append(f'- Median events per date: '
                     f'{date_counts.median():.0f}\n')
        lines.append(f'- Top-5 dates contributed '
                     f'{top5_sum/total_sum:.1%} of total ret_30m sum\n')
        lines.append(f'- Top-5 dates by mean ret_30m:\n')
        for d, m in date_means.nlargest(5).items():
            cnt = int(date_counts.loc[d])
            lines.append(f'  - {d}: mean={m:+.2f} (n={cnt})\n')
        lines.append('\n')

    MD_PATH.write_text(''.join(lines))

    # Print compact stdout summary
    print('=' * 70)
    print('Walk-Forward Failure Diagnosis')
    print('=' * 70)
    for label, sub in (('H1', h1), ('H2', h2)):
        s = per_event_summary(label, sub)
        print(f'\n{label} (n={s["n"]}):')
        print(f'  Mean event   ret_30m: {s["event_mean"]:+.2f}')
        print(f'  Median event ret_30m: {s["event_median"]:+.2f}')
        print(f'  Mean (event-ctrl):    {s["diff_mean"]:+.2f}')
        print(f'  Median (event-ctrl):  {s["diff_median"]:+.2f}')
        print(f'  % event > control:    {s["pct_positive"]:.1%}')
        print(f'  Event p10/p50/p90:    '
              f'{s["event_pcts"]["p10"]:+.1f} / '
              f'{s["event_pcts"]["p50"]:+.1f} / '
              f'{s["event_pcts"]["p90"]:+.1f}')

    print(f'\nFull diagnosis → {MD_PATH}')


if __name__ == '__main__':
    main()
