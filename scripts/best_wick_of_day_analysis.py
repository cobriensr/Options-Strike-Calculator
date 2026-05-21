#!/usr/bin/env python3
"""Test the 'best wick of day' framing.

User showed 3 May days (May 12 V, May 19 mountain, May 20 uptrend) as
examples of the setup he wants. None were Mondays — two Tuesdays and a
Wednesday. Our v4 detector fired 0-20 times per day but missed the
actual major inflections OR fired during the move toward them (false
signals).

Hypothesis: the +16 pt mean-reversion edge only applies to the wick
that marks the DAY'S ACTUAL EXTREME, not every wick that pierces a +γ
node. Most events are noise; one event per day is the real signal.

Method:
  1. For each trading day, find the bar with the SESSION LOW (down-wick
     candidate) and SESSION HIGH (up-wick candidate).
  2. Match each session extreme to its closest v4 event (if any).
  3. Compute forward returns from the session extreme.
  4. Compare 'session-extreme-matched' events to all other v4 events.
  5. Walk-forward.

If this works, the detector spec changes from 'fire on every qualifying
wick' to 'wait for the day's apparent extreme, then trade'. That's
harder to do in real-time (you don't know it's the extreme until after)
but workable with a delay confirmation.
"""

import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

load_dotenv('.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']
OUT = Path('docs/tmp/forensic-multi-day')
V4_CSV = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'best_wick_of_day_findings.md'

EXTREME_TOLERANCE_PTS = 1.0  # bar's low/high must be within Xpts of day's


def query_df(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def report_paired(label, sub, ev_col, ct_col):
    paired = sub[[ev_col, ct_col]].dropna()
    n = len(paired)
    if n < 5:
        return {'label': label, 'n': n, 'event': np.nan,
                'control': np.nan, 'delta': np.nan, 't': np.nan, 'p': np.nan}
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


def load_candles(conn):
    q = """
        SELECT timestamp, open, high, low, close, date
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND market_time = 'r'
        ORDER BY timestamp
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    return df


def find_session_extremes(candles):
    """For each trading day, find the time of session low and session high."""
    by_day = candles.groupby('date').agg(
        day_low=('low', 'min'),
        day_high=('high', 'max'),
    )

    # Map: for each day, the timestamp of the low and high bar
    low_idx = candles.loc[candles.groupby('date')['low'].idxmin()]
    high_idx = candles.loc[candles.groupby('date')['high'].idxmax()]
    low_idx = low_idx[['date', 'timestamp', 'low', 'close']].rename(
        columns={'timestamp': 'low_ts', 'low': 'day_low_px',
                 'close': 'low_bar_close'})
    high_idx = high_idx[['date', 'timestamp', 'high', 'close']].rename(
        columns={'timestamp': 'high_ts', 'high': 'day_high_px',
                 'close': 'high_bar_close'})
    extremes = low_idx.merge(high_idx, on='date')
    return extremes


def main():
    print('Loading v4 + candles + finding session extremes...')
    v4_df = pd.read_csv(V4_CSV, parse_dates=['event_ts', 'control_ts'])
    v4_df['event_date'] = v4_df['event_ts'].dt.date

    conn = psycopg2.connect(DB_URL)
    try:
        candles = load_candles(conn)
    finally:
        conn.close()

    extremes = find_session_extremes(candles)
    extremes['low_ts'] = pd.to_datetime(extremes['low_ts'], utc=True)
    extremes['high_ts'] = pd.to_datetime(extremes['high_ts'], utc=True)

    # Tag each v4 event: is it AT (within tolerance) the day's session
    # extreme matching its direction?
    # - For down-wick events: is bar.low within Xpts of day_low?
    # - For up-wick events: is bar.high within Xpts of day_high?
    v4_df = v4_df.merge(extremes, left_on='event_date', right_on='date',
                         how='left')
    v4_df['is_session_low'] = (
        (v4_df['direction'] == 'down')
        & ((v4_df['bar_low'] - v4_df['day_low_px']).abs()
           <= EXTREME_TOLERANCE_PTS)
    )
    v4_df['is_session_high'] = (
        (v4_df['direction'] == 'up')
        & ((v4_df['bar_high'] - v4_df['day_high_px']).abs()
           <= EXTREME_TOLERANCE_PTS)
    )
    v4_df['is_session_extreme'] = (
        v4_df['is_session_low'] | v4_df['is_session_high'])

    n_total = len(v4_df)
    n_extreme = int(v4_df['is_session_extreme'].sum())
    print(f'  Total v4 events: {n_total:,}')
    print(f'  Events AT session extreme (±{EXTREME_TOLERANCE_PTS}pt): '
          f'{n_extreme:,} ({n_extreme/n_total:.1%})')
    print(f'  Session-low events (down-wick at day low): '
          f'{int(v4_df["is_session_low"].sum())}')
    print(f'  Session-high events (up-wick at day high): '
          f'{int(v4_df["is_session_high"].sum())}')

    lines = []
    lines.append('# Best-Wick-of-Day Analysis\n\n')
    lines.append(f'Hypothesis: the +16pt mean-reversion edge only applies '
                 f'to v4 events whose bar low/high marks the DAY\'S actual '
                 f'session extreme (within ±{EXTREME_TOLERANCE_PTS}pt). All '
                 f'other events are noise.\n\n')
    lines.append(f'- Total v4 events: {n_total}\n')
    lines.append(f'- Session-extreme-matched events: {n_extreme} '
                 f'({n_extreme/n_total:.1%})\n')
    lines.append(f'- Session-low (down-wick at day low): '
                 f'{int(v4_df["is_session_low"].sum())}\n')
    lines.append(f'- Session-high (up-wick at day high): '
                 f'{int(v4_df["is_session_high"].sum())}\n\n')

    # Compare session-extreme events vs all other events
    for direction, label, is_col in (
        ('down', 'Down-wick at session LOW', 'is_session_low'),
        ('up', 'Up-wick at session HIGH', 'is_session_high'),
    ):
        sub_dir = v4_df[v4_df['direction'] == direction].copy()
        extreme = sub_dir[sub_dir[is_col]]
        non_extreme = sub_dir[~sub_dir[is_col]]
        lines.append(f'## {label} vs. other {direction}-wicks\n\n')
        lines.append('| Cohort | n | Event +30m | Control +30m | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        r1 = report_paired('SESSION-EXTREME', extreme,
                           'ret_30m', 'control_ret_30m')
        r2 = report_paired('OTHER', non_extreme,
                           'ret_30m', 'control_ret_30m')
        lines.append(fmt_row(r1) + '\n')
        lines.append(fmt_row(r2) + '\n')
        lines.append('\n')
        print(f'\n  {label}:')
        if not np.isnan(r1['delta']):
            print(f'    SESSION-EXTREME n={r1["n"]:3d}  '
                  f'Δ={r1["delta"]:+.2f}  p={r1["p"]:.4f}')
        if not np.isnan(r2['delta']):
            print(f'    OTHER           n={r2["n"]:3d}  '
                  f'Δ={r2["delta"]:+.2f}  p={r2["p"]:.4f}')

        # Walk-forward on session-extreme cohort
        if not extreme.empty:
            extreme_sorted = extreme.sort_values('event_ts').reset_index(drop=True)
            split = len(extreme_sorted) // 2
            h1 = extreme_sorted.iloc[:split]
            h2 = extreme_sorted.iloc[split:]
            lines.append(f'### Walk-forward: session-extreme {direction}-wick\n\n')
            lines.append('| Half | n | Event | Control | Δ | t | p |\n')
            lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
            print(f'    Walk-forward:')
            for label2, half in (('H1', h1), ('H2', h2), ('FULL', extreme_sorted)):
                r = report_paired(label2, half, 'ret_30m', 'control_ret_30m')
                lines.append(fmt_row(r) + '\n')
                if not np.isnan(r['delta']):
                    print(f'      {label2:<6} n={r["n"]:3d}  '
                          f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
            lines.append('\n')

    # DOW breakdown of session-extreme events
    extreme_all = v4_df[v4_df['is_session_extreme']].copy()
    if not extreme_all.empty:
        extreme_all['dow'] = pd.to_datetime(extreme_all['event_ts']).dt.day_name()
        lines.append('## DOW distribution of session-extreme events\n\n')
        lines.append('| DOW | n down | n up | mean ret_30m | n total |\n')
        lines.append('|---|---:|---:|---:|---:|\n')
        print(f'\n  DOW breakdown of session-extreme events:')
        for d in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'):
            sub_d = extreme_all[extreme_all['dow'] == d]
            n_down = int(sub_d['is_session_low'].sum())
            n_up = int(sub_d['is_session_high'].sum())
            mean_ret = sub_d['ret_30m'].mean()
            lines.append(f'| {d} | {n_down} | {n_up} | '
                         f'{mean_ret:+.2f} | {len(sub_d)} |\n')
            print(f'    {d:<10} down={n_down:2d}  up={n_up:2d}  '
                  f'mean_ret={mean_ret:+.2f}  total={len(sub_d)}')
        lines.append('\n')

        # Test session-extreme event edge BY DOW
        lines.append('## Session-extreme down-wick edge by DOW (+30m)\n\n')
        lines.append('| DOW | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print(f'\n  Session-low down-wick edge by DOW:')
        for d in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'):
            sub = extreme_all[(extreme_all['dow'] == d)
                              & extreme_all['is_session_low']]
            r = report_paired(d, sub, 'ret_30m', 'control_ret_30m')
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'    {d:<10} n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
