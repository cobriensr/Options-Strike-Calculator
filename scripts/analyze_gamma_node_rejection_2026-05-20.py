#!/usr/bin/env python3
"""
Gamma-Node Rejection Historical Study (2026-05-20)
====================================================

Hypothesis: When SPX prints a 1-min candle with range in the p75-p99 band
AND that bar's high (low) pierces a positive-gamma strike from the most
recent Periscope snapshot but the close finishes back on the prior side,
forward returns over 15/30/60 min mean-revert toward the pierced strike.

Inputs:
  - index_candles_1m  (symbol='SPX', market_time='r')
  - periscope_snapshots (panel='gamma', 0DTE expiry)

Outputs:
  - docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20.csv
  - docs/tmp/forensic-multi-day/gamma_node_rejection_findings_2026-05-20.md

Methodology notes:
  - Point-in-time: only periscope snapshots strictly BEFORE event_ts (no leakage).
  - Direction-adjusted returns: positive = mean-reverted (price moved back away
    from the wicked node).
  - Dose-response: one row per (event_bar, node_pierced) so multi-node piercings
    contribute separately, exposing the "size of node pierced" effect.
  - Forward windows truncated at 15:00 CT (session close); events restricted to
    bars before 14:00 CT so a full 60-min forward window always fits.
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
OUT.mkdir(parents=True, exist_ok=True)

# === Configuration ===
PERCENTILE_LO = 75  # range floor (drop noise)
PERCENTILE_HI = 100  # 100 = no ceiling (include all large bars)
LOOKBACK_PERISCOPE_MIN = 10
HORIZONS_MIN = [15, 30, 60]
TOUCHED_AGAIN_HORIZON_MIN = 30
LATEST_EVENT_CT_MINUTES = 14 * 60  # before 14:00 CT
OUTPUT_SUFFIX = '_no-ceiling'  # appended to CSV/MD filenames; '' for v1


# === DB helpers ===

def query_df(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def load_candles(conn):
    """1-min SPX candles covering periscope's available date range."""
    q = """
        SELECT timestamp, open, high, low, close, date
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND market_time = 'r'
          AND date >= (
              SELECT (MIN(captured_at) AT TIME ZONE 'UTC')::date
              FROM periscope_snapshots
          )
        ORDER BY timestamp
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for col in ('open', 'high', 'low', 'close'):
        df[col] = df[col].astype(float)
    df['range'] = df['high'] - df['low']
    return df


def load_periscope(conn):
    """Gamma-panel periscope snapshots — strike, value, captured_at, expiry."""
    q = """
        SELECT captured_at, expiry, strike, value
        FROM periscope_snapshots
        WHERE panel = 'gamma'
        ORDER BY captured_at, strike
    """
    df = query_df(conn, q)
    df['captured_at'] = pd.to_datetime(df['captured_at'], utc=True)
    df['value'] = df['value'].astype(float)
    df['strike'] = df['strike'].astype(int)
    return df


# === Event detection ===

def detect_events(candles):
    """Pick bars with range in [p75, p99] AND CT minute < 14:00."""
    lo = float(np.percentile(candles['range'], PERCENTILE_LO))
    hi = float(np.percentile(candles['range'], PERCENTILE_HI))
    in_band = (candles['range'] >= lo) & (candles['range'] <= hi)
    ct = candles['timestamp'].dt.tz_convert('America/Chicago')
    minutes = ct.dt.hour * 60 + ct.dt.minute
    early_enough = minutes < LATEST_EVENT_CT_MINUTES
    events = candles[in_band & early_enough].copy()
    events['ct'] = ct[in_band & early_enough]
    return events, lo, hi


# === Periscope match ===

def latest_snapshot_strikes(periscope, ts):
    """Return strikes from the latest snapshot in (ts - 10m, ts] with expiry = ts CT date."""
    earliest = ts - pd.Timedelta(minutes=LOOKBACK_PERISCOPE_MIN)
    window = periscope[(periscope['captured_at'] <= ts)
                       & (periscope['captured_at'] > earliest)]
    if window.empty:
        return None
    latest_cap = window['captured_at'].max()
    event_date = ts.tz_convert('America/Chicago').date()
    snap = window[(window['captured_at'] == latest_cap)
                  & (window['expiry'] == event_date)]
    return snap if not snap.empty else None


# === Pierce detection ===

def pierced_nodes_up(bar, snap):
    pos = snap[snap['value'] > 0]
    return pos[(pos['strike'] > bar['open'])
               & (bar['high'] > pos['strike'])
               & (bar['close'] <= pos['strike'])]


def pierced_nodes_down(bar, snap):
    pos = snap[snap['value'] > 0]
    return pos[(pos['strike'] < bar['open'])
               & (bar['low'] < pos['strike'])
               & (bar['close'] >= pos['strike'])]


# === Forward metrics ===

def forward_metrics(candles, event_ts, event_close, node_strike, direction):
    """Direction-adjusted forward returns + touched-again-within-30m flag."""
    out = {}
    for h in HORIZONS_MIN:
        target_ts = event_ts + pd.Timedelta(minutes=h)
        fwd = candles[(candles['timestamp'] > event_ts)
                      & (candles['timestamp'] <= target_ts)]
        if fwd.empty:
            out[f'ret_{h}m'] = np.nan
            continue
        end_close = fwd.iloc[-1]['close']
        out[f'ret_{h}m'] = (event_close - end_close) if direction == 'up' \
            else (end_close - event_close)

    target_ts = event_ts + pd.Timedelta(minutes=TOUCHED_AGAIN_HORIZON_MIN)
    fwd = candles[(candles['timestamp'] > event_ts)
                  & (candles['timestamp'] <= target_ts)]
    if fwd.empty:
        out['touched_again_30m'] = np.nan
    elif direction == 'up':
        out['touched_again_30m'] = int((fwd['high'] >= node_strike).any())
    else:
        out['touched_again_30m'] = int((fwd['low'] <= node_strike).any())
    return out


# === Findings writer ===

def write_findings(df, lo, hi, candle_count, peri_snap_count, peri_dates):
    md_path = OUT / f'gamma_node_rejection_findings_2026-05-20{OUTPUT_SUFFIX}.md'
    lines = []
    lines.append('# Gamma-Node Rejection Historical Study (2026-05-20)\n')
    lines.append('## Setup\n')
    if PERCENTILE_HI >= 100:
        lines.append(f'- Bar range filter: range >= p{PERCENTILE_LO} '
                     f'({lo:.2f}pts), no upper ceiling '
                     f'(max observed: {hi:.2f}pts)\n')
    else:
        lines.append(f'- Bar range filter: p{PERCENTILE_LO} = {lo:.2f}pts, '
                     f'p{PERCENTILE_HI} = {hi:.2f}pts\n')
    lines.append(f'- 1-min candles loaded: {candle_count:,}\n')
    lines.append(f'- Periscope snapshots loaded: {peri_snap_count:,} unique\n')
    lines.append(f'- Periscope date coverage: {peri_dates[0]} → {peri_dates[1]} '
                 f'({(peri_dates[1] - peri_dates[0]).days + 1} cal days)\n')
    lines.append(f'- Total (event, node_pierced) rows: {len(df):,}\n')
    lines.append('- Direction-adjusted returns: positive = mean-reverted '
                 '(price moved AWAY from wicked node, back toward open).\n\n')

    if df.empty:
        lines.append('## No (event, node) rows produced.\n')
        lines.append('Likely cause: periscope coverage too thin OR no bars in '
                     'p75-p99 band pierced a +gamma node within the lookback.\n')
        md_path.write_text(''.join(lines))
        return

    # Headline by direction
    lines.append('## Headline by direction\n\n')
    for d in ('up', 'down'):
        sub = df[df['direction'] == d]
        if sub.empty:
            lines.append(f'### {d}-wick: n=0\n\n')
            continue
        valid = sub['ret_30m'].dropna()
        t_stat, p_val = (stats.ttest_1samp(valid, 0)
                         if len(valid) > 5 else (np.nan, np.nan))
        lines.append(f'### {d}-wick: n={len(sub)}\n')
        lines.append(f'- Mean +15m return: {sub["ret_15m"].mean():+.2f} pts\n')
        lines.append(f'- Mean +30m return: {sub["ret_30m"].mean():+.2f} pts\n')
        lines.append(f'- Mean +60m return: {sub["ret_60m"].mean():+.2f} pts\n')
        lines.append('- Touched-again-within-30m rate: '
                     f'{sub["touched_again_30m"].mean():.1%}\n')
        if not np.isnan(p_val):
            lines.append(f'- t-test on +30m return vs 0: '
                         f't={t_stat:+.2f}, p={p_val:.4f}\n')
        lines.append('\n')

    # Dose-response: node GEX magnitude
    lines.append('## Dose-response: node GEX magnitude\n\n')
    lines.append('Quartile of |node_gex| within direction. Higher quartile = '
                 'bigger gamma wall.\n\n')
    df = df.copy()
    df['abs_gex'] = df['node_gex'].abs()
    for d in ('up', 'down'):
        sub = df[df['direction'] == d].copy()
        if len(sub) < 8:
            lines.append(f'### {d}-wick: too few rows (n={len(sub)}) '
                         'for quartile binning\n\n')
            continue
        try:
            sub['gex_q'] = pd.qcut(sub['abs_gex'], q=4,
                                   labels=['Q1', 'Q2', 'Q3', 'Q4'],
                                   duplicates='drop')
        except ValueError:
            lines.append(f'### {d}-wick: GEX values too uniform for quartile '
                         'binning\n\n')
            continue
        agg = sub.groupby('gex_q', observed=True).agg(
            n=('event_ts', 'count'),
            mean_ret_15m=('ret_15m', 'mean'),
            mean_ret_30m=('ret_30m', 'mean'),
            mean_ret_60m=('ret_60m', 'mean'),
            touched_30m=('touched_again_30m', 'mean'),
            median_abs_gex=('abs_gex', 'median'),
        ).round(3)
        lines.append(f'### {d}-wick\n')
        lines.append('```\n' + agg.to_string() + '\n```\n\n')

    # Dose-response: pierce depth
    lines.append('## Dose-response: pierce depth\n\n')
    lines.append('How far past the node the wick reached. Quartile within '
                 'direction.\n\n')
    for d in ('up', 'down'):
        sub = df[df['direction'] == d].copy()
        if len(sub) < 8:
            lines.append(f'### {d}-wick: too few rows (n={len(sub)})\n\n')
            continue
        try:
            sub['depth_q'] = pd.qcut(sub['pierce_depth'], q=4,
                                     labels=['Q1', 'Q2', 'Q3', 'Q4'],
                                     duplicates='drop')
        except ValueError:
            lines.append(f'### {d}-wick: depths too uniform for quartile '
                         'binning\n\n')
            continue
        agg = sub.groupby('depth_q', observed=True).agg(
            n=('event_ts', 'count'),
            mean_ret_15m=('ret_15m', 'mean'),
            mean_ret_30m=('ret_30m', 'mean'),
            touched_30m=('touched_again_30m', 'mean'),
            median_depth_pts=('pierce_depth', 'median'),
        ).round(3)
        lines.append(f'### {d}-wick\n')
        lines.append('```\n' + agg.to_string() + '\n```\n\n')

    # Bar-range distribution for reference
    lines.append('## Bar-range distribution (reference)\n\n')
    lines.append('1-min SPX RTH bar range, in points:\n\n')
    pct_table = pd.Series({
        'p50': float(np.percentile(df['bar_range'], 50)),
        'p75': float(np.percentile(df['bar_range'], 75)),
        'p90': float(np.percentile(df['bar_range'], 90)),
        'p95': float(np.percentile(df['bar_range'], 95)),
        'p99': float(np.percentile(df['bar_range'], 99)),
        'max': float(df['bar_range'].max()),
    }).round(2)
    lines.append('```\n' + pct_table.to_string() + '\n```\n\n')
    lines.append('_Note: distribution is over the **event sample** (in-band '
                 'bars only), not the full candle universe._\n')

    md_path.write_text(''.join(lines))
    print(f'Wrote findings → {md_path}')


# === Main ===

def main():
    conn = psycopg2.connect(DB_URL)
    try:
        print('Loading 1-min SPX candles...')
        candles = load_candles(conn)
        print(f'  {len(candles):,} bars from {candles["date"].min()} '
              f'to {candles["date"].max()}')

        print('Loading periscope snapshots...')
        periscope = load_periscope(conn)
        unique_snaps = periscope['captured_at'].nunique()
        peri_dates = (periscope['captured_at'].min().date(),
                      periscope['captured_at'].max().date())
        print(f'  {len(periscope):,} strike rows, '
              f'{unique_snaps:,} unique snapshots, '
              f'dates {peri_dates[0]} → {peri_dates[1]}')

        events, lo, hi = detect_events(candles)
        print(f'Event detection: p{PERCENTILE_LO}={lo:.2f}pts, '
              f'p{PERCENTILE_HI}={hi:.2f}pts → {len(events):,} candidate bars')
    finally:
        conn.close()

    rows = []
    matched = 0
    for _, bar in events.iterrows():
        snap = latest_snapshot_strikes(periscope, bar['timestamp'])
        if snap is None:
            continue
        matched += 1
        for direction, finder in (('up', pierced_nodes_up),
                                  ('down', pierced_nodes_down)):
            pierced = finder(bar, snap)
            for _, node in pierced.iterrows():
                metrics = forward_metrics(candles, bar['timestamp'],
                                          bar['close'], node['strike'],
                                          direction)
                rows.append({
                    'event_ts': bar['timestamp'],
                    'direction': direction,
                    'bar_range': bar['range'],
                    'bar_open': bar['open'],
                    'bar_high': bar['high'],
                    'bar_low': bar['low'],
                    'bar_close': bar['close'],
                    'node_strike': int(node['strike']),
                    'node_gex': float(node['value']),
                    'pierce_depth': (bar['high'] - node['strike'])
                    if direction == 'up'
                    else (node['strike'] - bar['low']),
                    **metrics,
                })

    print(f'Event bars with a matched periscope snapshot: {matched:,}')
    df = pd.DataFrame(rows)
    print(f'(event, node) rows: {len(df):,}')

    csv_path = OUT / f'gamma_node_rejection_2026-05-20{OUTPUT_SUFFIX}.csv'
    df.to_csv(csv_path, index=False)
    print(f'Wrote CSV → {csv_path}')

    write_findings(df, lo, hi, len(candles), unique_snaps, peri_dates)


if __name__ == '__main__':
    main()
