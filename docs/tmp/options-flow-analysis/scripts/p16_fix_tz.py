"""Phase 16 — fix UTC->CT timezone in p14 output.

p14 wrote trigger_time_ct / entry_time_ct as tz-naive UTC (numpy strips
the tz when .values is called). This rewrites the CSV with proper CT
timestamps so downstream phases can use the hour column directly.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def main():
    src = OUT / 'outputs' / 'p14_event_triggers.csv'
    df = pd.read_csv(src, parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} rows')
    print(f'Pre-fix sample trigger_time_ct: {df["trigger_time_ct"].iloc[0]}')
    for col in ['trigger_time_ct', 'entry_time_ct']:
        df[col] = df[col].dt.tz_localize('UTC').dt.tz_convert('America/Chicago')
    df['hour'] = df['trigger_time_ct'].dt.hour + df['trigger_time_ct'].dt.minute / 60
    print(f'Post-fix sample trigger_time_ct: {df["trigger_time_ct"].iloc[0]}')
    print(f'Hour distribution: min={df["hour"].min():.2f}, max={df["hour"].max():.2f}')
    df.to_csv(src, index=False)
    print(f'Saved → {src}')


if __name__ == '__main__':
    main()
