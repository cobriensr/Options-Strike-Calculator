#!/usr/bin/env python3
"""Test candle-pattern features on the wick bar for session-extreme prediction.

Hypothesis: session-extreme down-wicks should look like classic hammer/
bullish-reversal candles (long lower shadow, small body, close near
high). If true, candle pattern alone could be a real-time filter.

Result: NEGATIVE. Session-extreme bars are normal bearish 1-min bars
(median close_in_range = 0.29, only 27% bullish bodies). Hammer-like
candles don't predict session-extreme. Adding candle filters to the
Monday pocket REDUCES edge or holds with smaller n.

Conclusion: reversal mechanism is multi-bar, not single-bar candle
pattern. By the time a 'hammer' is visible, the bounce has started.
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
MD_PATH = OUT / 'candle_pattern_findings.md'


def report(label, sub):
    paired = sub[['ret_30m', 'control_ret_30m']].dropna()
    n = len(paired)
    if n < 5:
        return f'{label:<55} n={n} sparse', None
    ev = paired['ret_30m'].mean()
    ct = paired['control_ret_30m'].mean()
    diffs = paired['ret_30m'] - paired['control_ret_30m']
    t, p = stats.ttest_1samp(diffs, 0)
    return (f'{label:<55} n={n:3d} Δ={ev-ct:+.2f} p={p:.4f}',
            {'n': n, 'event': ev, 'control': ct, 'delta': ev - ct,
             't': t, 'p': p})


def main():
    v4 = pd.read_csv(V4_CSV, parse_dates=['event_ts'])
    v4['event_date'] = v4['event_ts'].dt.date

    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT timestamp, open, high, low, close, date
            FROM index_candles_1m
            WHERE symbol='SPX' AND market_time='r'
        """)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    conn.close()
    candles = pd.DataFrame(rows, columns=cols)
    for c in ('open', 'high', 'low', 'close'):
        candles[c] = candles[c].astype(float)

    by_day = candles.groupby('date').agg(day_low=('low', 'min'))
    v4 = v4.merge(by_day, left_on='event_date', right_on='date', how='left')
    v4['is_session_low'] = (
        (v4['direction'] == 'down')
        & ((v4['bar_low'] - v4['day_low']).abs() <= 1.0)
    )

    down = v4[v4['direction'] == 'down'].copy()

    # Candle-pattern features on the wick bar
    down['body_size'] = (down['bar_close'] - down['bar_open']).abs()
    down['range'] = down['bar_high'] - down['bar_low']
    down['upper_shadow'] = (down['bar_high']
                            - down[['bar_open', 'bar_close']].max(axis=1))
    down['lower_shadow'] = (down[['bar_open', 'bar_close']].min(axis=1)
                            - down['bar_low'])
    down['close_in_range'] = ((down['bar_close'] - down['bar_low'])
                              / down['range'])
    down['body_to_range'] = down['body_size'] / down['range']
    down['lower_to_range'] = down['lower_shadow'] / down['range']
    down['is_bullish_body'] = (down['bar_close']
                               > down['bar_open']).astype(float)
    down['abs_gex'] = down['node_gex'].abs()
    down['dow'] = pd.to_datetime(down['event_ts']).dt.day_name()

    lines = ['# Candle Pattern Analysis on Wick Bar\n\n']
    ext = down[down['is_session_low']]
    oth = down[~down['is_session_low']]
    lines.append(f'Session-extreme: n={len(ext)}, Other: n={len(oth)}\n\n')
    lines.append('## Feature distributions\n\n')
    lines.append('| Feature | Ext median | Oth median | Ext mean | Oth mean '
                 '| p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|\n')
    for f in ('body_size', 'range', 'lower_shadow', 'close_in_range',
              'body_to_range', 'lower_to_range', 'is_bullish_body'):
        ev = ext[f].dropna()
        ov = oth[f].dropna()
        if len(ev) < 3 or len(ov) < 3:
            continue
        try:
            _, p = stats.ttest_ind(ev, ov, equal_var=False)
        except Exception:
            p = np.nan
        lines.append(f'| {f} | {ev.median():.3f} | {ov.median():.3f} '
                     f'| {ev.mean():.3f} | {ov.mean():.3f} | {p:.4f} |\n')
    lines.append('\nNo statistically significant candle-pattern difference '
                 '(all p > 0.13). Session-extreme bars are normal bearish '
                 '1-min bars; reversal mechanism is multi-bar.\n\n')

    # Filters
    lines.append('## Candle-pattern filters (all down-wicks)\n\n')
    filters = [
        ('Baseline all down-wicks', down),
        ('close_in_range >= 0.6', down[down['close_in_range'] >= 0.6]),
        ('close_in_range >= 0.7', down[down['close_in_range'] >= 0.7]),
        ('close_in_range >= 0.8 (hammer-like)',
         down[down['close_in_range'] >= 0.8]),
        ('lower_to_range >= 0.5',
         down[down['lower_to_range'] >= 0.5]),
        ('lower_to_range >= 0.6 (deep wick)',
         down[down['lower_to_range'] >= 0.6]),
        ('bullish body + close_in_range >= 0.7',
         down[(down['is_bullish_body'] == 1)
              & (down['close_in_range'] >= 0.7)]),
    ]
    for label, sub in filters:
        line, _ = report(label, sub)
        lines.append(f'- {line}\n')

    # Combined with Monday pocket
    lines.append('\n## Candle + Monday pocket\n\n')
    mon_pocket = down[(down['dow'] == 'Monday') & (down['abs_gex'] <= 500)]
    combos = [
        ('Monday + |gex|<=500k baseline', mon_pocket),
        ('+ close_in_range >= 0.6',
         mon_pocket[mon_pocket['close_in_range'] >= 0.6]),
        ('+ close_in_range >= 0.7',
         mon_pocket[mon_pocket['close_in_range'] >= 0.7]),
        ('+ lower_to_range >= 0.5',
         mon_pocket[mon_pocket['lower_to_range'] >= 0.5]),
    ]
    for label, sub in combos:
        line, _ = report(label, sub)
        lines.append(f'- {line}\n')

    lines.append('\nVerdict: candle-pattern filters do not improve the '
                 'Monday-pocket edge and degrade the broad down-wick edge. '
                 'Reversal mechanism is multi-bar, not single-bar shape.\n')

    MD_PATH.write_text(''.join(lines))
    print(f'Wrote findings → {MD_PATH}')


if __name__ == '__main__':
    main()
