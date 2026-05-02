"""Q11: upstream_condition_detail SIP-code profiling (streaming).

Iterates per file, accumulates small per-code counters — never holds the
full 133M-row dataset in memory.
"""
from __future__ import annotations

import glob
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['side', 'premium', 'upstream_condition_detail', 'canceled']


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def main() -> None:
    accum: dict[tuple[str, str], dict[str, float]] = {}
    total_rows = 0
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled']]
        df['upstream_condition_detail'] = df['upstream_condition_detail'].astype(str)
        df['side'] = df['side'].astype(str)

        grp = df.groupby(['upstream_condition_detail', 'side']).agg(
            prints=('premium', 'size'),
            premium=('premium', 'sum'),
        ).reset_index()
        for _, row in grp.iterrows():
            key = (row['upstream_condition_detail'], row['side'])
            v = accum.setdefault(key, {'prints': 0, 'premium': 0.0})
            v['prints'] += int(row['prints'])
            v['premium'] += float(row['premium'])
        total_rows += len(df)
        print(f'  {Path(f).name}: +{len(df):,} rows (total {total_rows:,})')

    # Build summary
    rows = [{
        'upstream_condition_detail': k[0],
        'side': k[1],
        'prints': v['prints'],
        'premium_M': v['premium'] / 1e6,
    } for k, v in accum.items()]
    df = pd.DataFrame(rows)
    summary = df.groupby('upstream_condition_detail').agg(
        prints=('prints', 'sum'),
        premium_M=('premium_M', 'sum'),
    ).sort_values('premium_M', ascending=False)
    summary['print_share_pct'] = summary['prints'] / summary['prints'].sum() * 100
    summary['premium_share_pct'] = summary['premium_M'] / summary['premium_M'].sum() * 100

    # Side breakdown per code
    side_pivot = df.pivot_table(
        index='upstream_condition_detail', columns='side', values='prints',
        aggfunc='sum', fill_value=0
    )
    side_pivot_pct = side_pivot.div(side_pivot.sum(axis=1), axis=0) * 100
    summary = summary.join(side_pivot_pct.add_suffix('_pct'))

    print('\n=== SIP code distribution ===')
    print(summary.round(2))

    fig, ax = plt.subplots(figsize=(11, 6), constrained_layout=True)
    top = summary.head(10).copy()
    x = range(len(top))
    width = 0.35
    ax.bar([i - width/2 for i in x], top['print_share_pct'], width,
           label='% of prints', color='steelblue')
    ax.bar([i + width/2 for i in x], top['premium_share_pct'], width,
           label='% of premium', color='darkorange')
    ax.set_xticks(x)
    ax.set_xticklabels(top.index, rotation=45, ha='right')
    ax.set_ylabel('Share (%)')
    ax.set_title('SIP condition code distribution — top 10\n(15 days, all symbols)')
    ax.legend()
    ax.grid(True, alpha=0.3, axis='y')
    fig.savefig(OUT / 'plots' / 'q11_sip_codes.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    summary.to_csv(OUT / 'outputs' / 'q11_sip_codes.csv')


if __name__ == '__main__':
    main()
