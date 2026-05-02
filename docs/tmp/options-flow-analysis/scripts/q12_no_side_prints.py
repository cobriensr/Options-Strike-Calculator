"""Q12: no_side print analysis (streaming).

Per-file pass to count side distribution + per-exchange / per-SIP-code
breakdown of no_side prints. Never holds the full dataset in RAM.
"""
from __future__ import annotations

import glob
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['side', 'premium', 'exchange', 'upstream_condition_detail', 'canceled']


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def main() -> None:
    side_counts: dict[str, int] = defaultdict(int)
    side_premium: dict[str, float] = defaultdict(float)
    no_side_by_exchange: dict[str, int] = defaultdict(int)
    no_side_by_code: dict[str, int] = defaultdict(int)
    total_rows = 0

    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled']]
        for c in ['side', 'exchange', 'upstream_condition_detail']:
            df[c] = df[c].astype(str)

        # Side distribution
        for s, count in df['side'].value_counts().items():
            side_counts[s] += int(count)
        for s, prem in df.groupby('side')['premium'].sum().items():
            side_premium[s] += float(prem)

        # no_side breakdown
        no_side = df.loc[df['side'] == 'no_side']
        for ex, count in no_side['exchange'].value_counts().items():
            no_side_by_exchange[ex] += int(count)
        for code, count in no_side['upstream_condition_detail'].value_counts().items():
            no_side_by_code[code] += int(count)

        total_rows += len(df)
        print(f'  {Path(f).name}: +{len(df):,} rows (total {total_rows:,})')

    # Side share table
    side_df = pd.DataFrame({
        'pct_prints': pd.Series(side_counts) / sum(side_counts.values()) * 100,
        'premium_B': pd.Series(side_premium) / 1e9,
    }).sort_values('premium_B', ascending=False)
    print('\n=== Side classification ===')
    print(side_df.round(3))
    print(f"\nno_side share: {side_counts['no_side']/sum(side_counts.values())*100:.2f}%")

    by_ex = pd.Series(no_side_by_exchange).sort_values(ascending=False).head(10)
    by_code = pd.Series(no_side_by_code).sort_values(ascending=False).head(10)
    print('\n=== Top exchanges for no_side ===')
    print(by_ex)
    print('\n=== Top SIP codes for no_side ===')
    print(by_code)

    fig, axes = plt.subplots(1, 2, figsize=(14, 5), constrained_layout=True)
    axes[0].barh(by_ex.index[::-1], by_ex.values[::-1],
                 color='steelblue', edgecolor='black')
    axes[0].set_title(f'no_side prints by exchange (top 10)\n{side_counts["no_side"]:,} total')
    axes[0].set_xlabel('Count')
    axes[1].barh(by_code.index[::-1], by_code.values[::-1],
                 color='darkorange', edgecolor='black')
    axes[1].set_title('no_side prints by SIP code (top 10)')
    axes[1].set_xlabel('Count')

    fig.savefig(OUT / 'plots' / 'q12_no_side.png', dpi=150,
                bbox_inches='tight', facecolor='white')
    side_df.to_csv(OUT / 'outputs' / 'q12_side_share.csv')


if __name__ == '__main__':
    main()
