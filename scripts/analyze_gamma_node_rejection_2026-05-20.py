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
OUTPUT_SUFFIX = '_v3-controls'  # appended to CSV/MD filenames; '' for v1
CONTROL_SEED = 42  # reproducible random control selection


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


# === Control bars ===

def build_controls(candles, event_ts_set, range_threshold, rng_seed=CONTROL_SEED):
    """Map each event_ts → a random non-event in-band same-day bar.

    Controls are bars from the SAME trading day that meet the same range
    floor (>= p75) and time-of-day cutoff but were NOT classified as
    events (i.e., didn't pierce a +γ node with a close-back). One control
    per unique event_ts; multi-node-pierce rows from the same event share
    a control. Deterministic via rng_seed.
    """
    in_band = candles[candles['range'] >= range_threshold].copy()
    ct = in_band['timestamp'].dt.tz_convert('America/Chicago')
    minutes = ct.dt.hour * 60 + ct.dt.minute
    in_band = in_band[(minutes < LATEST_EVENT_CT_MINUTES)
                      & (~in_band['timestamp'].isin(event_ts_set))].copy()
    in_band['ct_date'] = in_band['timestamp'].dt.tz_convert(
        'America/Chicago').dt.date

    rng = np.random.default_rng(rng_seed)
    mapping = {}
    for ev_ts in event_ts_set:
        ev_date = ev_ts.tz_convert('America/Chicago').date()
        pool = in_band[in_band['ct_date'] == ev_date]
        if pool.empty:
            continue
        idx = int(rng.integers(0, len(pool)))
        mapping[ev_ts] = pool.iloc[idx]
    return mapping


def control_returns(candles, ctrl_ts, ctrl_close, direction):
    """Forward returns for a control bar, signed by the paired event's direction."""
    out = {}
    for h in HORIZONS_MIN:
        target_ts = ctrl_ts + pd.Timedelta(minutes=h)
        fwd = candles[(candles['timestamp'] > ctrl_ts)
                      & (candles['timestamp'] <= target_ts)]
        if fwd.empty:
            out[f'control_ret_{h}m'] = np.nan
            continue
        end_close = fwd.iloc[-1]['close']
        out[f'control_ret_{h}m'] = (ctrl_close - end_close) if direction == 'up' \
            else (end_close - ctrl_close)
    return out


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

    # Headline by direction (with control comparison)
    lines.append('## Headline by direction — event vs matched control\n\n')
    lines.append('Control = random non-event in-band bar from same day, same '
                 'time-of-day window, signed by the event\'s direction. Δ = '
                 'event − control mean. Paired t-test on (event − control) '
                 'per row; Mann-Whitney unpaired on distributions.\n\n')
    for d in ('up', 'down'):
        sub = df[df['direction'] == d].copy()
        if sub.empty:
            lines.append(f'### {d}-wick: n=0\n\n')
            continue
        lines.append(f'### {d}-wick: n={len(sub)}\n\n')
        lines.append('| Horizon | Event mean | Control mean | Δ (event-ctrl) '
                     '| paired t / p | MW p |\n')
        lines.append('|---------|-----------:|-------------:|-------------:'
                     '|:--------------|:------|\n')
        for h in HORIZONS_MIN:
            ev_col = f'ret_{h}m'
            ct_col = f'control_ret_{h}m'
            paired = sub[[ev_col, ct_col]].dropna()
            if len(paired) < 5:
                lines.append(f'| +{h}m | n/a | n/a | n/a | n/a | n/a |\n')
                continue
            ev_mean = paired[ev_col].mean()
            ct_mean = paired[ct_col].mean()
            delta = ev_mean - ct_mean
            diffs = paired[ev_col] - paired[ct_col]
            t_stat, p_paired = stats.ttest_1samp(diffs, 0)
            try:
                _, p_mw = stats.mannwhitneyu(
                    paired[ev_col], paired[ct_col], alternative='two-sided')
            except ValueError:
                p_mw = np.nan
            lines.append(
                f'| +{h}m | {ev_mean:+.2f} | {ct_mean:+.2f} | '
                f'{delta:+.2f} | t={t_stat:+.2f}, p={p_paired:.4f} '
                f'| {p_mw:.4f} |\n'
            )
        lines.append(f'\n- Touched-again-within-30m rate: '
                     f'{sub["touched_again_30m"].mean():.1%}\n\n')

    # Dose-response: node GEX magnitude (with control delta — best pocket finder)
    lines.append('## Dose-response: node GEX magnitude (drift-adjusted)\n\n')
    lines.append('Quartile of |node_gex| within direction. `Δ30m` = event '
                 'mean − control mean at +30m. Larger positive Δ for down-wick '
                 'or larger negative Δ for up-wick = stronger signal **vs '
                 'drift**.\n\n')
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
        sub['delta_30m'] = sub['ret_30m'] - sub['control_ret_30m']
        agg = sub.groupby('gex_q', observed=True).agg(
            n=('event_ts', 'count'),
            ev_30m=('ret_30m', 'mean'),
            ctrl_30m=('control_ret_30m', 'mean'),
            delta_30m=('delta_30m', 'mean'),
            touched_30m=('touched_again_30m', 'mean'),
            median_abs_gex=('abs_gex', 'median'),
        ).round(3)
        # Per-quartile paired t-test on delta
        p_vals = []
        for q in agg.index:
            diffs = sub.loc[sub['gex_q'] == q, 'delta_30m'].dropna()
            if len(diffs) < 5:
                p_vals.append(np.nan)
            else:
                _, p = stats.ttest_1samp(diffs, 0)
                p_vals.append(p)
        agg['p_paired'] = [f'{p:.4f}' if not np.isnan(p) else 'n/a'
                           for p in p_vals]
        lines.append(f'### {d}-wick\n')
        lines.append('```\n' + agg.to_string() + '\n```\n\n')

    # Dose-response: pierce depth (drift-adjusted)
    lines.append('## Dose-response: pierce depth (drift-adjusted)\n\n')
    lines.append('How far past the node the wick reached. Quartile within '
                 'direction. `Δ30m` = event − control at +30m.\n\n')
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
        sub['delta_30m'] = sub['ret_30m'] - sub['control_ret_30m']
        agg = sub.groupby('depth_q', observed=True).agg(
            n=('event_ts', 'count'),
            ev_30m=('ret_30m', 'mean'),
            ctrl_30m=('control_ret_30m', 'mean'),
            delta_30m=('delta_30m', 'mean'),
            touched_30m=('touched_again_30m', 'mean'),
            median_depth_pts=('pierce_depth', 'median'),
        ).round(3)
        p_vals = []
        for q in agg.index:
            diffs = sub.loc[sub['depth_q'] == q, 'delta_30m'].dropna()
            if len(diffs) < 5:
                p_vals.append(np.nan)
            else:
                _, p = stats.ttest_1samp(diffs, 0)
                p_vals.append(p)
        agg['p_paired'] = [f'{p:.4f}' if not np.isnan(p) else 'n/a'
                           for p in p_vals]
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

    # First pass: collect event_ts so we can build controls excluding them.
    event_ts_set = set()
    event_rows_pending = []
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
                event_ts_set.add(bar['timestamp'])
                event_rows_pending.append((bar, direction, node))

    print(f'Event bars with a matched periscope snapshot: {matched:,}')
    print(f'Building controls for {len(event_ts_set):,} unique event timestamps...')
    controls = build_controls(candles, event_ts_set, lo)
    print(f'Controls matched: {len(controls):,} / {len(event_ts_set):,} '
          f'unique event_ts ({len(controls) / max(1, len(event_ts_set)):.1%})')

    rows = []
    for bar, direction, node in event_rows_pending:
        metrics = forward_metrics(candles, bar['timestamp'], bar['close'],
                                  node['strike'], direction)
        ctrl = controls.get(bar['timestamp'])
        if ctrl is not None:
            ctrl_metrics = control_returns(candles, ctrl['timestamp'],
                                           ctrl['close'], direction)
        else:
            ctrl_metrics = {f'control_ret_{h}m': np.nan for h in HORIZONS_MIN}
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
            'control_ts': ctrl['timestamp'] if ctrl is not None else pd.NaT,
            **metrics,
            **ctrl_metrics,
        })

    df = pd.DataFrame(rows)
    print(f'(event, node) rows: {len(df):,}')

    csv_path = OUT / f'gamma_node_rejection_2026-05-20{OUTPUT_SUFFIX}.csv'
    df.to_csv(csv_path, index=False)
    print(f'Wrote CSV → {csv_path}')

    write_findings(df, lo, hi, len(candles), unique_snaps, peri_dates)


if __name__ == '__main__':
    main()
