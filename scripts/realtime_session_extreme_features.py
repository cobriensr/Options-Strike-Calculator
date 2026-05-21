#!/usr/bin/env python3
"""Find real-time features that distinguish session-extreme wicks from noise.

The session-extreme finding (n=11, Δ=+24, p=0.0004) is statistically
strong but operationally tricky: you can't know it's THE session low
until after. We need real-time features computable AT THE WICK that
predict 'this is likely the session extreme.'

For each v4 down-wick, compute features available at event_ts:
  - pierce_depth (how far bar.low pierced the node)
  - bar_range
  - |node_gex|
  - minutes_into_session (8:30 CT = 0)
  - dist_below_open (event_close - day_open, points; negative = below)
  - is_new_running_session_low (is bar.low the lowest of the session?)
  - bars_since_prior_running_low (consecutive bars in active downtrend)
  - pre_event_drift_15m (sum of ret over prior 15 1-min bars)

Compare distributions for SESSION-EXTREME (n=11) vs OTHER (n=284) and
report which features differ most. Then test combined filter edge.
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
MD_PATH = OUT / 'realtime_features_findings.md'

EXTREME_TOL_PTS = 1.0


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


def main():
    print('Loading v4 + candles...')
    v4_df = pd.read_csv(V4_CSV, parse_dates=['event_ts'])
    v4_df['event_date'] = v4_df['event_ts'].dt.date
    conn = psycopg2.connect(DB_URL)
    try:
        candles = load_candles(conn)
    finally:
        conn.close()

    # Per-day session low + open
    by_day = candles.groupby('date').agg(
        day_open=('open', 'first'),
        day_low=('low', 'min'),
        day_high=('high', 'max'),
    )
    low_ts = candles.loc[candles.groupby('date')['low'].idxmin()][
        ['date', 'timestamp']].rename(columns={'timestamp': 'day_low_ts'})
    by_day = by_day.merge(low_ts, on='date')

    v4_df = v4_df.merge(by_day, left_on='event_date', right_on='date',
                         how='left')
    v4_df['is_session_low'] = (
        (v4_df['direction'] == 'down')
        & ((v4_df['bar_low'] - v4_df['day_low']).abs() <= EXTREME_TOL_PTS)
    )

    # Filter to down-wicks for this analysis
    down = v4_df[v4_df['direction'] == 'down'].copy()
    print(f'  Down-wicks: {len(down):,}')
    print(f'  Session-low matches: {int(down["is_session_low"].sum())}')

    # Compute real-time features per event
    candles_indexed = candles.set_index('timestamp').sort_index()

    def features_for(row):
        ts = row['event_ts']
        day = row['event_date']
        day_open = row['day_open']
        # Session-day candles up to (and including) event bar
        day_candles = candles[(candles['date'] == day)
                              & (candles['timestamp'] <= ts)]
        if day_candles.empty:
            return pd.Series({
                'minutes_into_session': np.nan,
                'dist_below_open': np.nan,
                'is_new_running_low': np.nan,
                'bars_since_running_low': np.nan,
                'pre_event_drift_15m': np.nan,
                'prior_running_low': np.nan,
            })
        ct_ts = ts.tz_convert('America/Chicago')
        minutes_in = ct_ts.hour * 60 + ct_ts.minute - (8 * 60 + 30)
        dist_below_open = float(row['bar_close']) - float(day_open)

        # Running low up to and including event bar
        running_low = day_candles['low'].astype(float).min()
        is_new_running_low = float(row['bar_low']) <= running_low + 0.01

        # Bars since prior running low (consecutive bars where current low
        # has been lower than the prior running low)
        lows = day_candles['low'].astype(float).values
        # Walk back from current bar: how many bars have we been at or
        # near the running low?
        bars_at_low = 0
        for i in range(len(lows) - 1, -1, -1):
            if lows[i] <= running_low + 1.0:
                bars_at_low += 1
            else:
                break

        # Pre-event drift: sum of (close - open) for last 15 bars before event
        prior = day_candles.iloc[:-1].tail(15)
        if not prior.empty:
            drift = float((prior['close'] - prior['open']).sum())
        else:
            drift = np.nan

        # Prior running low (excluding current bar): the lowest low BEFORE the
        # event bar
        prior_lows = day_candles.iloc[:-1]['low']
        prior_running_low = (float(prior_lows.astype(float).min())
                             if not prior_lows.empty else np.nan)

        return pd.Series({
            'minutes_into_session': float(minutes_in),
            'dist_below_open': dist_below_open,
            'is_new_running_low': float(is_new_running_low),
            'bars_since_running_low': float(bars_at_low),
            'pre_event_drift_15m': drift,
            'prior_running_low': prior_running_low,
        })

    print('  Computing real-time features per down-wick event...')
    feat = down.apply(features_for, axis=1)
    down = pd.concat([down.reset_index(drop=True),
                       feat.reset_index(drop=True)], axis=1)
    # `new_low_breakout_pts`: how far below prior running low the event bar
    # closed (positive = made new low, larger = bigger breakout)
    down['new_low_breakout_pts'] = (down['prior_running_low']
                                    - down['bar_low'].astype(float))

    # Compare features: session-extreme vs other
    lines = []
    lines.append('# Real-Time Features for Session-Extreme Detection\n\n')
    lines.append(f'Down-wick events: {len(down)}. Session-extreme (bar.low '
                 f'within ±{EXTREME_TOL_PTS}pt of day low): '
                 f'{int(down["is_session_low"].sum())}.\n\n')

    feature_cols = [
        'pierce_depth', 'bar_range', 'minutes_into_session',
        'dist_below_open', 'is_new_running_low',
        'bars_since_running_low', 'pre_event_drift_15m',
        'new_low_breakout_pts',
    ]
    down['abs_gex'] = down['node_gex'].abs()
    feature_cols.append('abs_gex')

    lines.append('## Feature comparison: SESSION-EXTREME vs OTHER\n\n')
    lines.append('| Feature | Extreme median | Other median | Extreme mean '
                 '| Other mean | Welch p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|\n')
    print('\n=== Feature distributions: session-extreme vs other ===')
    print(f'{"Feature":<26}{"Ext med":>10}{"Oth med":>10}{"Ext mean":>10}'
          f'{"Oth mean":>10}{"p":>10}')
    print('-' * 76)
    ext = down[down['is_session_low']]
    oth = down[~down['is_session_low']]
    for c in feature_cols:
        ev = ext[c].dropna()
        ov = oth[c].dropna()
        if len(ev) < 3 or len(ov) < 3:
            continue
        try:
            t, p = stats.ttest_ind(ev, ov, equal_var=False)
        except Exception:
            t, p = np.nan, np.nan
        row = (f'| {c} | {ev.median():.2f} | {ov.median():.2f} '
               f'| {ev.mean():.2f} | {ov.mean():.2f} | {p:.4f} |')
        lines.append(row + '\n')
        print(f'{c:<26}{ev.median():>10.2f}{ov.median():>10.2f}'
              f'{ev.mean():>10.2f}{ov.mean():>10.2f}{p:>10.4f}')
    lines.append('\n')

    # Try simple real-time filters and measure their edge
    lines.append('## Simple real-time filters: edge at +30m\n\n')
    lines.append('| Filter | n | Event | Control | Δ | t | p '
                 '| % of all down |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|\n')
    print('\n=== Simple real-time filters ===')

    filters = [
        ('All down-wicks', down),
        ('is_new_running_low', down[down['is_new_running_low'] == 1]),
        ('new_low + breakout >= 0.5pt',
         down[(down['is_new_running_low'] == 1)
              & (down['new_low_breakout_pts'] >= 0.5)]),
        ('new_low + breakout >= 1pt',
         down[(down['is_new_running_low'] == 1)
              & (down['new_low_breakout_pts'] >= 1.0)]),
        ('new_low + minutes >= 60 (after 9:30 CT)',
         down[(down['is_new_running_low'] == 1)
              & (down['minutes_into_session'] >= 60)]),
        ('new_low + dist_below_open <= -10',
         down[(down['is_new_running_low'] == 1)
              & (down['dist_below_open'] <= -10)]),
        ('new_low + pre_drift < -3',
         down[(down['is_new_running_low'] == 1)
              & (down['pre_event_drift_15m'] < -3)]),
        ('SESSION-EXTREME (look-ahead — for reference)',
         down[down['is_session_low']]),
    ]

    for label, sub in filters:
        r = report_paired(label, sub, 'ret_30m', 'control_ret_30m')
        pct = len(sub) / len(down) * 100 if len(down) > 0 else 0
        row = (f'| {label} | {r["n"]} | {r["event"]:+.2f} '
               f'| {r["control"]:+.2f} | {r["delta"]:+.2f} '
               f'| {r["t"]:+.2f} | {r["p"]:.4f} | {pct:.1f}% |')
        lines.append(row + '\n')
        if not np.isnan(r['delta']):
            print(f'  {label:<48} n={r["n"]:3d} '
                  f'Δ={r["delta"]:+.2f} p={r["p"]:.4f} '
                  f'({pct:.1f}% of down)')
    lines.append('\n')

    # Walk-forward the best real-time filter
    best = down[(down['is_new_running_low'] == 1)
                & (down['new_low_breakout_pts'] >= 0.5)
                & (down['minutes_into_session'] >= 60)]
    best_sorted = best.sort_values('event_ts').reset_index(drop=True)
    if len(best_sorted) >= 10:
        split = len(best_sorted) // 2
        h1 = best_sorted.iloc[:split]
        h2 = best_sorted.iloc[split:]
        lines.append('## Walk-forward: new_low + breakout≥0.5pt + after 9:30 CT\n\n')
        lines.append('| Half | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print('\n=== Walk-forward best real-time filter ===')
        for label, half in (('H1', h1), ('H2', h2), ('FULL', best_sorted)):
            r = report_paired(label, half, 'ret_30m', 'control_ret_30m')
            if np.isnan(r['delta']):
                row = (f'| {label} | {r["n"]} | n/a | n/a | n/a | n/a '
                       '| n/a |')
            else:
                row = (f'| {label} | {r["n"]} | {r["event"]:+.2f} '
                       f'| {r["control"]:+.2f} | {r["delta"]:+.2f} '
                       f'| {r["t"]:+.2f} | {r["p"]:.4f} |')
            lines.append(row + '\n')
            if not np.isnan(r['delta']):
                print(f'  {label:<6} n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
        lines.append('\n')

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
